#!/usr/bin/env node
/**
 * Acceptance tests for account_check (F2) plus Python/Node parity.
 *
 * Cases:
 *  - classic valid IBAN (GB82 WEST 1234 5698 7654 32) passes mod-97
 *  - tampered check digits fail
 *  - wrong length fails
 *  - valid AE IBAN (check digits computed at runtime) passes
 *  - BIC country vs IBAN country mismatch is reported
 *  - account country vs claimed country mismatch is reported (RF-ACC-002 feed)
 *  - masked output: full account never appears in results
 *  - Python and Node outputs are identical for every case
 *
 * Usage:
 *   node tests/account_check_cases.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { analyse, computeCheckDigits } from '../scripts/account_check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', 'scripts');

const PY_CANDIDATES = [
  'C:/Users/JOEY/.agent-reach-venv/Scripts/python.exe',
  'python',
  'python3',
  'py -3',
];

function findPython() {
  for (const candidate of PY_CANDIDATES) {
    try {
      const cmd = candidate.split(' ')[0];
      const args = candidate.split(' ').slice(1);
      execFileSync(cmd, [...args, '--version'], { stdio: 'pipe', timeout: 10000 });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function runPython(python, args) {
  const cmd = python.split(' ')[0];
  const rest = python.split(' ').slice(1);
  const out = spawnSync(cmd, [...rest, join(SCRIPTS, 'account_check.py'), ...args], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (out.error || !out.stdout) throw new Error(`account_check.py failed: ${out.error}`);
  return JSON.parse(out.stdout);
}

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`✓ ${label}`);
  } else {
    failures += 1;
    console.log(`✗ ${label} ${detail}`);
  }
}

// Runtime-constructed valid AE IBAN: BBAN 19 chars -> total length 23.
const aeBban = '0331234567890123456';
const aeCheck = computeCheckDigits('AE', aeBban);
const aeIban = `AE${aeCheck}${aeBban}`;

const cases = [
  {
    label: 'classic valid GB IBAN',
    args: { iban: 'GB82 WEST 1234 5698 7654 32', bic: 'EBILGB2L', country: 'GB' },
    assert: (r) => r.iban.valid === true && r.iban.check_digits_ok === true && r.iban.country === 'GB',
  },
  {
    label: 'tampered check digits fail',
    args: { iban: 'GB81 WEST 1234 5698 7654 32', bic: null, country: null },
    assert: (r) => r.iban.check_digits_ok === false && r.iban.valid === false,
  },
  {
    label: 'wrong length fails',
    args: { iban: 'GB82 WEST 1234 5698 7654 3', bic: null, country: null },
    assert: (r) => r.iban.length_ok === false && r.iban.valid === false,
  },
  {
    label: 'runtime-built valid AE IBAN passes',
    args: { iban: aeIban, bic: 'EBILAEAD', country: 'AE' },
    assert: (r) => r.iban.valid === true && r.iban.length_ok === true,
  },
  {
    label: 'BIC country vs IBAN country mismatch reported',
    args: { iban: 'GB82 WEST 1234 5698 7654 32', bic: 'EBILAEAD', country: 'GB' },
    assert: (r) => r.mismatches.some((m) => m.startsWith('bic_vs_iban')),
  },
  {
    label: 'account vs claimed country mismatch reported (RF-ACC-002 feed)',
    args: { iban: aeIban, bic: 'EBILAEAD', country: 'NG' },
    assert: (r) => r.account_country === 'AE' && r.mismatches.some((m) => m.startsWith('account_vs_claimed')),
  },
];

function main() {
  const python = findPython();

  for (const c of cases) {
    const result = analyse(c.args.iban, c.args.bic, c.args.country);
    check(c.label, c.assert(result), JSON.stringify({ valid: result.iban.valid, mismatches: result.mismatches }));
    if (result.iban.masked) {
      const full = c.args.iban.replace(/[\s-]/g, '');
      check(`${c.label}: masked output hides full number`, !JSON.stringify(result).includes(full));
    }
    if (python) {
      const cliArgs = [];
      if (c.args.iban) cliArgs.push('--iban', c.args.iban);
      if (c.args.bic) cliArgs.push('--bic', c.args.bic);
      if (c.args.country) cliArgs.push('--country', c.args.country);
      const py = runPython(python, cliArgs);
      const same = JSON.stringify(py) === JSON.stringify({ ...result, status: 'ok' });
      check(`${c.label}: python/node parity`, same);
    }
  }

  if (!python) console.log('○ python parity skipped (no interpreter)');

  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\naccount_check acceptance (F2) passed');
}

main();
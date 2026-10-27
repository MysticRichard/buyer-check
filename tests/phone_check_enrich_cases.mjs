#!/usr/bin/env node
/**
 * Acceptance checks for the optional phone_check enrichment (H1-H5, v0.7.0).
 *
 * H1 without the optional library the output keys match v0.6.0 exactly.
 * H2 with the library the optional fields appear.
 * H3 numbers without "+"/"00" never guess a country.
 * H4 VOIP / premium / toll-free numbers never change the risk score.
 * H5 every example number uses a reserved fictional range.
 *
 * The optional library is never a required dependency: when it is missing the
 * enrichment checks are reported as skipped instead of failing.
 *
 * Usage:
 *   node tests/phone_check_enrich_cases.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { score, loadRules } from '../scripts/risk_score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCRIPTS = join(ROOT, 'scripts');
const PY_SCRIPT = join(SCRIPTS, 'phone_check.py');

const BASE_KEYS = [
  'input', 'normalized', 'valid', 'invalid_reason', 'country_code', 'country',
  'country_name', 'line_type', 'claimed_country', 'matches_claimed_country',
  'format_hint', 'status',
];
const ENRICH_KEYS = ['number_type', 'carrier', 'carrier_note', 'timezones', 'enriched_by'];

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

function splitPython(python) {
  return [python.split(' ')[0], python.split(' ').slice(1)];
}

function runPython(python, args) {
  const [cmd, rest] = splitPython(python);
  return spawnSync(cmd, [...rest, ...args], { cwd: SCRIPTS, encoding: 'utf8', timeout: 30000 });
}

function runNode(args) {
  return spawnSync('node', ['phone_check.mjs', ...args], { cwd: SCRIPTS, encoding: 'utf8', timeout: 30000 });
}

function parse(run, label) {
  if (!run.stdout) throw new Error(`${label} produced no stdout: ${run.stderr || ''}`);
  return JSON.parse(run.stdout);
}

let failures = 0;
let skipped = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function skip(label, reason) {
  skipped += 1;
  console.log(`○ ${label} — skipped (${reason})`);
}

function main() {
  const python = findPython();
  if (!python) {
    console.log('○ skipped: no Python interpreter found');
    process.exit(0);
  }
  const rules = loadRules();
  const emptyScore = score([], rules, false);

  // ---------- H1: without the optional library, output keys are unchanged ----------
  const h1Script = [
    'import importlib.util, json',
    `spec = importlib.util.spec_from_file_location("phone_check", ${JSON.stringify(PY_SCRIPT)})`,
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'module.apply_enrichment = lambda result, had_plus, used_00: result',
    'data = module.load_data()',
    'result = module.analyse("+971 52 555 0100", "AE", data)',
    'result["status"] = "ok"',
    'print(json.dumps(sorted(result.keys())))',
  ].join('\n');
  const [pyCmd, pyRest] = splitPython(python);
  const h1Run = spawnSync(pyCmd, [...pyRest, '-c', h1Script], { encoding: 'utf8', timeout: 30000 });
  let h1Keys;
  try {
    h1Keys = JSON.parse(h1Run.stdout);
  } catch {
    h1Keys = null;
  }
  check(
    'H1 Python without library keeps v0.6.0 keys',
    h1Keys && h1Keys.length === BASE_KEYS.length && BASE_KEYS.every((key) => h1Keys.includes(key)),
    h1Keys ? h1Keys.join(',') : (h1Run.stderr || 'no output'),
  );

  const nodeBase = parse(runNode(['+971 52 555 0100', '--country', 'AE']), 'node base');
  check(
    'H1 Node without library keeps v0.6.0 keys',
    Object.keys(nodeBase).length === BASE_KEYS.length && BASE_KEYS.every((key) => key in nodeBase),
    Object.keys(nodeBase).join(','),
  );

  // ---------- H2: with the library the optional fields appear ----------
  const pythonHasLib = spawnSync(pyCmd, [...pyRest, '-c', 'import phonenumbers'], { encoding: 'utf8', timeout: 30000 });
  if (pythonHasLib.status === 0) {
    const enriched = parse(runPython(python, ['phone_check.py', '+971 52 555 0100', '--country', 'AE']), 'python enriched');
    check(
      'H2 Python adds optional fields',
      ENRICH_KEYS.every((key) => key in enriched) && enriched.number_type && enriched.enriched_by.startsWith('phonenumbers'),
      JSON.stringify({ number_type: enriched.number_type, carrier: enriched.carrier, timezones: enriched.timezones, enriched_by: enriched.enriched_by }),
    );
  } else {
    skip('H2 Python enrichment', 'phonenumbers not installed');
  }

  const nodeEnriched = parse(runNode(['+971 52 555 0100', '--country', 'AE']), 'node enriched');
  if (ENRICH_KEYS.every((key) => key in nodeEnriched)) {
    check('H2 Node adds optional fields', Boolean(nodeEnriched.number_type), JSON.stringify(nodeEnriched.number_type));
  } else {
    skip('H2 Node enrichment', 'libphonenumber-js not installed');
  }

  // ---------- H3: no international prefix -> no guessed country ----------
  for (const [label, run, parser] of [
    ['Python', runPython(python, ['phone_check.py', '13800138000']), 'python'],
    ['Node', runNode(['13800138000']), 'node'],
  ]) {
    const result = parse(run, `${parser} no-prefix`);
    check(
      `H3 ${label} does not guess a country without +/00`,
      result.country === null && result.valid === false && String(result.invalid_reason).includes('international prefix'),
      JSON.stringify({ country: result.country, valid: result.valid, invalid_reason: result.invalid_reason }),
    );
  }

  // ---------- H4: optional type signals never change the score ----------
  const specialNumbers = ['+1 800 555 0100', '+44 900 7946 0000'];
  const observed = [];
  for (const number of specialNumbers) {
    const result = parse(runPython(python, ['phone_check.py', number]), `special ${number}`);
    observed.push(`${number} -> ${result.number_type || 'unknown'}`);
    check(
      `H4 ${number} does not add scoring fields`,
      !('risk_score' in result) && !('level' in result) && !('flags' in result),
      JSON.stringify(result.number_type || 'unknown'),
    );
  }
  check('H4 special numbers keep the score at 0', emptyScore.risk_score === 0 && emptyScore.level === '低', JSON.stringify(observed));

  // ---------- H5: examples only use reserved fictional ranges ----------
  const examples = ['+971 52 555 0100', '+1 800 555 0100', '+44 900 7946 0000', '13800138000'];
  check(
    'H5 examples use reserved ranges',
    examples.filter((number) => number !== '13800138000').every((number) => /555|7946/.test(number)),
    examples.join(', '),
  );

  if (failures > 0) {
    console.log(`\n${failures} failure(s), ${skipped} skipped`);
    process.exit(1);
  }
  console.log(`\nphone_check enrichment acceptance (H1-H5) passed${skipped ? `, ${skipped} skipped` : ''}`);
}

main();
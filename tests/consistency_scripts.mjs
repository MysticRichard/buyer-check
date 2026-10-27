#!/usr/bin/env node
/**
 * Cross-language consistency test for the three global scripts (E3).
 *
 * Runs phone_check, email_header_check and sanctions_check through both the
 * Python and the Node implementation on a shared set of inputs and requires
 * identical JSON output (key-by-key). sanctions_check is exercised with a
 * synthetic list planted in .cache/sanctions/ plus the no-cache path.
 *
 * Usage:
 *   node tests/consistency_scripts.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCRIPTS = join(ROOT, 'scripts');
const CACHE = join(ROOT, '.cache', 'sanctions');

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

function runScript(python, base, args) {
  // Non-zero exit codes are expected for "unavailable" results; parse stdout
  // regardless of exit status so both languages can be compared.
  const nodeRun = spawnSync('node', [`${base}.mjs`, ...args], { cwd: SCRIPTS, encoding: 'utf8', timeout: 30000 });
  const cmd = python.split(' ')[0];
  const rest = python.split(' ').slice(1);
  const pyRun = spawnSync(cmd, [...rest, `${base}.py`, ...args], { cwd: SCRIPTS, encoding: 'utf8', timeout: 30000 });
  for (const run of [pyRun, nodeRun]) {
    if (run.error || !run.stdout) {
      throw new Error(`${base} failed to run: ${run.error || 'no stdout'}`);
    }
  }
  if (pyRun.status !== nodeRun.status) {
    failures += 1;
    console.log(`✗ ${base} ${args.join(' ')}: exit codes differ python=${pyRun.status} node=${nodeRun.status}`);
  }
  return [JSON.parse(pyRun.stdout), JSON.parse(nodeRun.stdout)];
}

let failures = 0;

function compare(label, py, js, onlyKeys = null) {
  const keys = new Set([...Object.keys(py), ...Object.keys(js)]);
  for (const key of keys) {
    if (onlyKeys && !onlyKeys.includes(key)) continue;
    if (JSON.stringify(py[key]) !== JSON.stringify(js[key])) {
      failures += 1;
      console.log(`✗ ${label} key=${key}: python=${JSON.stringify(py[key])} node=${JSON.stringify(js[key])}`);
    }
  }
}

// ---------- phone_check ----------
const phoneCases = [
  ['+971 52 555 0100', ['--country', 'AE']],
  ['008618812345678', []],
  ['+218 91 555 0100', ['--country', 'LY']],
  ['+1 (415) 555-2671', ['--country', 'US']],
  ['+44 20 7946 0958', ['--country', 'GB']],
  ['+971 52 555 0100', ['--country', 'NG']],
  ['+999 555 1234', []],
  ['not-a-phone', []],
];

// ---------- email_header_check ----------
const headerA = [
  'From: "Sales" <sales@acme-trading.example>',
  'Reply-To: payments@fast-remit.example',
  'Return-Path: <bounce@mailer.example>',
  'Received: from mail.acme-trading.example (203.0.113.25) by mx.local.example with ESMTP; Fri, 23 Oct 2026 10:15:00 +0400',
  'Received: from mx.local.example (198.51.100.7) by store.local; Fri, 23 Oct 2026 10:16:00 -0000',
  'Authentication-Results: mx.local.example; spf=fail (sender IP is 203.0.113.25) smtp.mailfrom=fast-remit.example; dkim=none; dmarc=fail',
  'Subject: Order',
].join('\n');

const headerB = [
  'From: Maria Chen <maria.chen@pacificretailgroup.example>',
  'Reply-To: maria.chen@pacificretailgroup.example',
  'Received: from mail.pacificretailgroup.example (192.0.2.10) by mx.example.com; Fri, 23 Oct 2026 09:00:00 -0500',
  'Authentication-Results: mx.example.com; spf=pass smtp.mailfrom=pacificretailgroup.example; dkim=pass; dmarc=pass',
].join('\n');

// ---------- sanctions_check (synthetic list) ----------
const syntheticCsv = [
  '1,individual,"KHALIL, AHMED"',
  '2,individual,"DELGADO, MARCUS"',
  '3,entity,"GLOBAL STAR TRADING CO"',
  '4,individual,"DOE, JOHN"',
].join('\n');

function main() {
  const python = findPython();
  if (!python) {
    console.log('○ skipped: no Python interpreter found');
    process.exit(0);
  }

  // Only the base fields are compared: optional enrichment (phonenumbers vs
// libphonenumber-js) can differ by library and data version by design.
const PHONE_BASE_KEYS = [
  'status', 'input', 'normalized', 'valid', 'invalid_reason', 'country_code',
  'country', 'country_name', 'line_type', 'claimed_country',
  'matches_claimed_country', 'format_hint',
];

let checked = 0;
  for (const [number, extra] of phoneCases) {
    const [py, js] = runScript(python, 'phone_check', [number, ...extra]);
    compare(`phone_check ${number}`, py, js, PHONE_BASE_KEYS);
    checked += 1;
  }
  console.log(`✓ phone_check: ${checked}/${phoneCases.length} cases identical`);

  // ---------- ip_check ----------
  const ipCases = [
    ['', ['--claimed-country', 'AE']],
    ['203.0.113.7', ['--claimed-country', 'AE']],
    ['10.0.0.1', ['--claimed-country', 'AE']],
    ['not-an-ip', []],
    ['203.0.113.7', ['--claimed-country', 'AE', '--rdap-json', join(ROOT, 'tests', 'fixtures', 'ip-rdap-sample.json')]],
  ];
  let ipChecked = 0;
  for (const [ip, extra] of ipCases) {
    const [py, js] = runScript(python, 'ip_check', ['--ip', ip, ...extra]);
    compare(`ip_check "${ip}"`, py, js);
    ipChecked += 1;
  }
  console.log(`✓ ip_check: ${ipChecked}/${ipCases.length} cases identical`);

  const headerAPath = join(ROOT, '.tmp_header_a.txt');
  const headerBPath = join(ROOT, '.tmp_header_b.txt');
  writeFileSync(headerAPath, headerA, 'utf8');
  writeFileSync(headerBPath, headerB, 'utf8');
  for (const file of [headerAPath, headerBPath]) {
    const [py, js] = runScript(python, 'email_header_check', ['--file', file]);
    compare(`email_header_check ${file}`, py, js);
  }
  console.log('✓ email_header_check: 2/2 cases identical');

  // No-cache path first
  rmSync(CACHE, { recursive: true, force: true });
  const [pyNoCache, jsNoCache] = runScript(python, 'sanctions_check', ['GLOBAL STAR TRADING CO']);
  compare('sanctions_check no-cache', pyNoCache, jsNoCache);
  if (pyNoCache.status !== 'unavailable') {
    failures += 1;
    console.log('✗ sanctions_check no-cache expected status unavailable');
  }

  // Synthetic cache
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(join(CACHE, 'ofac_sdn.csv'), syntheticCsv, 'utf8');
  for (const name of ['GLOBAL STAR TRADING CO', 'Marcus Delgado', 'Nordic Machinery AS']) {
    const [py, js] = runScript(python, 'sanctions_check', [name]);
    compare(`sanctions_check "${name}"`, py, js);
  }
  console.log('✓ sanctions_check: no-cache + 3 synthetic matches identical');

  rmSync(join(ROOT, '.tmp_header_a.txt'), { force: true });
  rmSync(join(ROOT, '.tmp_header_b.txt'), { force: true });
  rmSync(CACHE, { recursive: true, force: true });


  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nscript consistency checks passed');
}

main();
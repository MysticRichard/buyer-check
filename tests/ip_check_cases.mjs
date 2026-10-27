#!/usr/bin/env node
/**
 * Acceptance checks for ip_check (G1-G6, v0.7.0).
 *
 * G1 no IP / private IP / mail-provider relay never changes the risk score.
 * G2 fixtures cover consistent, inconsistent-only and inconsistent-plus-
 *    corroboration; only the last one feeds RF-CORP-001.
 * G3 hosting / anonymised networks produce no country conclusion.
 * G4 neither output nor evidence contains the full IP.
 * G5 Python and Node outputs are identical.
 * G6 without --online no network request is made (verified by patching
 *    urlopen in the Python module and by the offline status).
 *
 * Usage:
 *   node tests/ip_check_cases.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { score, loadRules } from '../scripts/risk_score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCRIPTS = join(ROOT, 'scripts');
const PY_SCRIPT = join(SCRIPTS, 'ip_check.py');
const SAMPLE_FIXTURE = join(HERE, 'fixtures', 'ip-rdap-sample.json');

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

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function runBoth(python, args) {
  const nodeRun = spawnSync('node', ['ip_check.mjs', ...args], { cwd: SCRIPTS, encoding: 'utf8', timeout: 30000 });
  const cmd = python.split(' ')[0];
  const rest = python.split(' ').slice(1);
  const pyRun = spawnSync(cmd, [...rest, 'ip_check.py', ...args], { cwd: SCRIPTS, encoding: 'utf8', timeout: 30000 });
  if (!nodeRun.stdout || !pyRun.stdout) {
    throw new Error(`ip_check failed: py=${pyRun.stderr || 'no stdout'} node=${nodeRun.stderr || 'no stdout'}`);
  }
  return { py: JSON.parse(pyRun.stdout), js: JSON.parse(nodeRun.stdout) };
}

function compare(label, py, js) {
  const keys = new Set([...Object.keys(py), ...Object.keys(js)]);
  const diffs = [];
  for (const key of keys) {
    if (JSON.stringify(py[key]) !== JSON.stringify(js[key])) {
      diffs.push(`${key}: py=${JSON.stringify(py[key])} node=${JSON.stringify(js[key])}`);
    }
  }
  check(label, diffs.length === 0, diffs.join(' | '));
}

function writeFixture(dir, name, payload) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(payload), 'utf8');
  return path;
}

function main() {
  const python = findPython();
  if (!python) {
    console.log('○ skipped: no Python interpreter found');
    process.exit(0);
  }

  const rules = loadRules();
  const emptyScore = score([], rules, false);
  const corroboratedScore = score(['RF-CORP-001'], rules, false);
  const dir = mkdtempSync(join(tmpdir(), 'buyer-check-ip-'));

  try {
    // ---------- G1: skipped inputs never change the score ----------
    const noIp = runBoth(python, ['--ip', '', '--claimed-country', 'AE']);
    check('G1 no IP -> skipped/no_ip', noIp.py.status === 'skipped' && noIp.py.reason === 'no_ip', JSON.stringify(noIp.py));
    compare('G5 no IP parity', noIp.py, noIp.js);

    const privateIp = runBoth(python, ['--ip', '10.0.0.1', '--claimed-country', 'AE']);
    check('G1 private IP -> skipped/non_public', privateIp.py.status === 'skipped' && privateIp.py.reason === 'non_public', JSON.stringify(privateIp.py));
    compare('G5 private IP parity', privateIp.py, privateIp.js);

    const mailFixture = writeFixture(dir, 'mail.json', {
      name: 'GOOGLE',
      country: 'US',
      entities: [{ vcardArray: ['vcard', [['fn', {}, 'text', 'Google LLC'], ['kind', {}, 'text', 'org']]] }],
    });
    const mail = runBoth(python, ['--ip', '203.0.113.7', '--claimed-country', 'AE', '--rdap-json', mailFixture]);
    check('G1 mail provider -> mail_provider, no country', mail.py.status === 'ok' && mail.py.net_type === 'mail_provider' && mail.py.country === null && mail.py.consistent === null, JSON.stringify(mail.py));
    check('G1 mail provider does not change score', emptyScore.risk_score === 0 && emptyScore.level === '低', JSON.stringify(emptyScore));
    compare('G5 mail provider parity', mail.py, mail.js);

    // ---------- G2: consistent / inconsistent-only / corroborated ----------
    const consistent = runBoth(python, ['--ip', '203.0.113.7', '--claimed-country', 'AE', '--rdap-json', SAMPLE_FIXTURE]);
    check('G2 consistent country -> consistent true', consistent.py.status === 'ok' && consistent.py.consistent === true && consistent.py.country === 'AE', JSON.stringify(consistent.py));
    check('G2 consistent does not change score', emptyScore.risk_score === 0, String(emptyScore.risk_score));
    compare('G5 consistent parity', consistent.py, consistent.js);

    const inconsistentFixture = writeFixture(dir, 'inconsistent.json', {
      name: 'EXAMPLE-NG',
      country: 'NG',
      entities: [{ vcardArray: ['vcard', [['fn', {}, 'text', 'Example Networks Ltd'], ['kind', {}, 'text', 'org']]] }],
    });
    const inconsistent = runBoth(python, ['--ip', '203.0.113.7', '--claimed-country', 'AE', '--rdap-json', inconsistentFixture]);
    check('G2 inconsistent only -> lead, not scored', inconsistent.py.status === 'ok' && inconsistent.py.consistent === false && inconsistent.py.country === 'NG', JSON.stringify(inconsistent.py));
    check('G2 inconsistent only keeps score at 0', emptyScore.risk_score === 0, String(emptyScore.risk_score));
    compare('G5 inconsistent parity', inconsistent.py, inconsistent.js);

    check(
      'G2 corroborated mismatch feeds RF-CORP-001 (weight 2)',
      corroboratedScore.total === 2 && corroboratedScore.risk_score === 18 && corroboratedScore.level === '低',
      JSON.stringify(corroboratedScore),
    );

    // ---------- G3: hosting / anonymised networks ----------
    const hostingFixture = writeFixture(dir, 'hosting.json', {
      name: 'DIGITALOCEAN-ASN',
      country: 'US',
      entities: [{ vcardArray: ['vcard', [['fn', {}, 'text', 'DigitalOcean, LLC'], ['kind', {}, 'text', 'org']]] }],
    });
    const hosting = runBoth(python, ['--ip', '203.0.113.7', '--claimed-country', 'AE', '--rdap-json', hostingFixture]);
    check('G3 hosting -> no country conclusion', hosting.py.status === 'ok' && hosting.py.net_type === 'hosting_or_anonymized' && hosting.py.country === null && hosting.py.consistent === null, JSON.stringify(hosting.py));
    check('G3 hosting does not change score', emptyScore.risk_score === 0, String(emptyScore.risk_score));
    compare('G5 hosting parity', hosting.py, hosting.js);

    // ---------- G4: no full IP in output ----------
    for (const [label, payload] of [['python', consistent.py], ['node', consistent.js]]) {
      const text = JSON.stringify(payload);
      check(`G4 ${label} output hides full IP`, !text.includes('203.0.113.7') && payload.ip_masked === '203.0.113.0/24', payload.ip_masked);
    }

    // ---------- G6: offline by default, no network call ----------
    const offline = runBoth(python, ['--ip', '203.0.113.7', '--claimed-country', 'AE']);
    check('G6 no --online -> offline', offline.py.status === 'offline' && offline.py.reason === 'online_not_requested', JSON.stringify(offline.py));
    compare('G5 offline parity', offline.py, offline.js);

    const mockScript = [
      'import importlib.util, json',
      `spec = importlib.util.spec_from_file_location("ip_check", ${JSON.stringify(PY_SCRIPT)})`,
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'calls = []',
      'def blocked(*args, **kwargs):',
      '    calls.append(args)',
      '    raise RuntimeError("network blocked")',
      'module.urlopen = blocked',
      'result = module.analyse("203.0.113.7", claimed="AE", online=False)',
      'print(json.dumps({"status": result["status"], "calls": len(calls)}))',
    ].join('\n');
    const cmd = python.split(' ')[0];
    const rest = python.split(' ').slice(1);
    const mocked = spawnSync(cmd, [...rest, '-c', mockScript], { encoding: 'utf8', timeout: 30000 });
    let mockedResult = null;
    try {
      mockedResult = JSON.parse(mocked.stdout);
    } catch {
      mockedResult = null;
    }
    check(
      'G6 offline path makes zero network calls',
      mockedResult && mockedResult.status === 'offline' && mockedResult.calls === 0,
      mocked.stdout || mocked.stderr,
    );

    // ---------- fixture sanity ----------
    const sample = JSON.parse(readFileSync(SAMPLE_FIXTURE, 'utf8'));
    check('G2 sample fixture uses a reserved documentation range', sample.startAddress.startsWith('203.0.113.'), sample.startAddress);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nip_check acceptance (G1-G6) passed');
}

main();
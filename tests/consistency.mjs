#!/usr/bin/env node
/**
 * Cross-language consistency test for the risk scoring engine (V5 + V6).
 *
 * V5: enumerates every red-flag combination (2^13) and asserts the score bands
 *     stay aligned with the level: low 0-29, medium 30-59, high 60-100, and a
 *     weight-5 flag always scores >= 70.
 * V6: runs a representative set of combinations through both the Node and the
 *     Python implementation and requires identical output.
 *
 * Usage:
 *   node tests/consistency.mjs
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { score, loadRules } from '../scripts/risk_score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_SCRIPT = join(HERE, '..', 'scripts', 'risk_score.py');

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
      // try next candidate
    }
  }
  return null;
}

function runPython(candidate, args) {
  const cmd = candidate.split(' ')[0];
  const rest = candidate.split(' ').slice(1);
  const out = execFileSync(cmd, [...rest, PY_SCRIPT, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30000,
  });
  return JSON.parse(out);
}

let failures = 0;

function fail(message) {
  failures += 1;
  console.log(`✗ ${message}`);
}

// ---------- V5: enumerate all combinations, assert band invariants ----------
const rules = loadRules();
const flagIds = rules.flags.map((flag) => flag.id);
const weightById = new Map(rules.flags.map((flag) => [flag.id, flag.weight]));

let combos = 0;
const maxCombo = 1 << flagIds.length;
for (let mask = 0; mask < maxCombo; mask += 1) {
  const ids = [];
  let total = 0;
  let hasWeight5 = false;
  for (let i = 0; i < flagIds.length; i += 1) {
    if (mask & (1 << i)) {
      ids.push(flagIds[i]);
      total += weightById.get(flagIds[i]);
      if (weightById.get(flagIds[i]) === 5) hasWeight5 = true;
    }
  }
  const result = score(ids, rules, false, 8, 3);
  combos += 1;
  const { level, risk_score: value } = result;
  if (level === '低' && !(value >= 0 && value <= 29)) fail(`V5 low band: T=${total} score=${value}`);
  if (level === '中' && !(value >= 30 && value <= 59)) fail(`V5 medium band: T=${total} score=${value}`);
  if (level === '高' && !(value >= 60 && value <= 100)) fail(`V5 high band: T=${total} score=${value}`);
  if (hasWeight5 && value < 70) fail(`V5 weight-5 floor: T=${total} score=${value}`);
}
console.log(`✓ V5 band invariants hold for all ${combos} flag combinations`);

// ---------- V6: Python vs Node consistency on representative cases ----------
const python = findPython();
if (!python) {
  console.log('○ V6 skipped: no Python interpreter found (Node-only environment)');
} else {
  const cases = [
    { flags: [], covered: 3, anchors: 0 },
    { flags: ['RF-BEH-003'], covered: 3, anchors: 0 },
    { flags: ['RF-MAIL-002', 'RF-BEH-002'], covered: 7, anchors: 2 },
    { flags: ['RF-BEH-001'], covered: 5, anchors: 1 },
    { flags: ['RF-PAY-001'], covered: 6, anchors: 1 },
    { flags: ['RF-DOM-002', 'RF-MAIL-001', 'RF-BEH-001'], covered: 7, anchors: 1 },
    { flags: ['RF-ACC-001', 'RF-DOM-002'], covered: 7, anchors: 2 },
    { flags: ['RF-PAY-001', 'RF-PAY-002', 'RF-DOM-001', 'RF-NEG-001'], covered: 8, anchors: 3 },
    { flags: [], covered: 3, anchors: 0, unverifiable: true },
    { flags: ['RF-BEH-003'], covered: 3, anchors: 0, unverifiable: true },
    { flags: ['RF-PAY-001'], covered: 3, anchors: 0, unverifiable: true },
  ];

  let checked = 0;
  for (const c of cases) {
    const args = ['--flags', ...(c.flags.length ? c.flags : [''])];
    if (c.covered !== undefined) args.push('--covered', String(c.covered));
    if (c.anchors !== undefined) args.push('--anchors', String(c.anchors));
    if (c.unverifiable) args.push('--unverifiable');

    const py = runPython(python, args);
    const js = score(c.flags, rules, Boolean(c.unverifiable), c.covered ?? null, c.anchors ?? null);

    for (const key of ['total', 'risk_score', 'level', 'confidence', 'high_weight_hit']) {
      if (JSON.stringify(py[key]) !== JSON.stringify(js[key])) {
        fail(`V6 mismatch [${c.flags.join(',') || 'none'}] ${key}: python=${JSON.stringify(py[key])} node=${JSON.stringify(js[key])}`);
      }
    }
    checked += 1;
  }
  console.log(`✓ V6 Python and Node outputs identical on ${checked}/${cases.length} representative cases (${python})`);
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nconsistency checks passed');
process.exit(0);
#!/usr/bin/env node
/**
 * Acceptance-case runner for buyer-check.
 *
 * Executes the offline acceptance cases in tests/cases/ against the Node
 * implementations in scripts/ and reports pass/fail. Cases that need live
 * network access are marked type "manual" and are reported as skipped.
 *
 * Usage:
 *   node tests/run_cases.mjs
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { score as riskScore, maskSensitive, loadRules } from '../scripts/risk_score.mjs';
import { analyse as domainAnalyse, loadBrands, loadBrandData, coreLabel } from '../scripts/domain_similarity.mjs';
import { analyse as whoisAnalyse } from '../scripts/whois_lookup.mjs';

let renderCard = null;
let ladderCombinations = null;
let containsFullPhone = null;
let tradeTerms = null;
let registrableDomain = null;
try {
  const module = await import('../scripts/render_card.mjs');
  renderCard = module.renderCard;
  ladderCombinations = module.ladderCombinations;
  containsFullPhone = module.containsFullPhone;
  tradeTerms = module.tradeTerms;
  registrableDomain = module.registrableDomain;
} catch {
  // The lean submission bundle ships only render_card.py.
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CASES_DIR = join(HERE, 'cases');
const CASES_FILE = join(HERE, 'cases.json');
const FIXTURES_DIR = join(HERE, 'fixtures');

const PY_CANDIDATES = [
  'C:/Users/JOEY/.agent-reach-venv/Scripts/python.exe',
  'python',
  'python3',
  'py -3',
];

function findPython() {
  for (const candidate of PY_CANDIDATES) {
    const [cmd, ...rest] = candidate.split(' ');
    const result = spawnSync(cmd, [...rest, '--version'], { encoding: 'utf8', timeout: 10000 });
    if (result.status === 0) return candidate;
  }
  return null;
}

function loadCase(file) {
  return JSON.parse(readFileSync(join(CASES_DIR, file), 'utf8'));
}

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function setByPath(target, path, value) {
  const parts = path.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== 'object') {
      cursor[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cursor = cursor[key];
  }
  const last = /^\d+$/.test(parts[parts.length - 1]) ? Number(parts[parts.length - 1]) : parts[parts.length - 1];
  cursor[last] = value;
}

function runPythonRender(python, args) {
  const [cmd, ...rest] = python.split(' ');
  const result = spawnSync(cmd, [...rest, join(ROOT, 'scripts', 'render_card.py'), ...args], { encoding: 'utf8', timeout: 30000 });
  if (!result.stdout) throw new Error(result.stderr || 'no output');
  return JSON.parse(result.stdout);
}

function pyRenderEvidence(python, evidence) {
  if (!python) throw new Error('python not found');
  const dir = mkdtempSync(join(tmpdir(), 'buyer-check-card-'));
  const file = join(dir, 'evidence.json');
  writeFileSync(file, JSON.stringify(evidence), 'utf8');
  return runPythonRender(python, [file, '--json']);
}

// The repository keeps one file per case (tests/cases/A*.json). The lean
// submission bundle ships the merged tests/cases.json instead, so both layouts
// are supported by the same runner.
function loadAllCases() {
  if (existsSync(CASES_FILE)) {
    return JSON.parse(readFileSync(CASES_FILE, 'utf8'));
  }
  return readdirSync(CASES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => loadCase(name));
}

function runProcess(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, options);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeout || 60000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout, stderr: String(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

const runners = {
  score(testCase) {
    const rules = loadRules();
    const input = testCase.input || {};
    const useCoverage = input.covered !== undefined && input.anchors !== undefined;
    const result = riskScore(
      input.flags || [],
      rules,
      Boolean(input.unverifiable),
      useCoverage ? input.covered : null,
      useCoverage ? input.anchors : null,
    );
    const expect = testCase.expect;
    const checks = [];
    if (expect.level !== undefined) checks.push(result.level === expect.level);
    if (expect.total !== undefined) checks.push(result.total === expect.total);
    if (expect.risk_score !== undefined) checks.push(result.risk_score === expect.risk_score);
    if (expect.confidence !== undefined) checks.push(result.confidence === expect.confidence);
    return {
      ok: checks.every(Boolean),
      actual: { level: result.level, total: result.total, risk_score: result.risk_score, confidence: result.confidence },
    };
  },

  layers(testCase) {
    const rules = loadRules();
    const input = testCase.input || {};
    const result = riskScore(
      input.flags || [],
      rules,
      false,
      input.covered,
      input.anchors,
      input.company_level,
      input.link_strength,
      input.person_level,
    );
    const expect = testCase.expect || {};
    const checks = [];
    if (expect.level !== undefined) checks.push(result.level === expect.level);
    if (expect.total !== undefined) checks.push(result.total === expect.total);
    if (expect.risk_score !== undefined) checks.push(result.risk_score === expect.risk_score);
    if (expect.confidence !== undefined) checks.push(result.confidence === expect.confidence);
    if (expect.company_flag !== undefined) checks.push(result.company_flag === expect.company_flag);
    return {
      ok: checks.every(Boolean),
      actual: {
        level: result.level,
        total: result.total,
        risk_score: result.risk_score,
        confidence: result.confidence,
        company_flag: result.company_flag,
        layers: result.layers,
      },
    };
  },

  domain(testCase) {
    const brands = loadBrands();
    const result = domainAnalyse(testCase.input.domain, brands, testCase.input.threshold ?? 0.5);
    const expect = testCase.expect;
    const checks = [result.is_lookalike === expect.is_lookalike];
    if (expect.best_type) checks.push(result.best_match?.type === expect.best_type);
    if (expect.best_brand) checks.push(result.best_match?.brand === expect.best_brand);
    return {
      ok: checks.every(Boolean),
      actual: { is_lookalike: result.is_lookalike, best_match: result.best_match },
    };
  },

  domain_batch(testCase) {
    const { brands, riskWords } = loadBrandData();
    const threshold = testCase.input.threshold ?? 0.5;
    const results = (testCase.input.cases || []).map((entry) => {
      const result = domainAnalyse(entry.domain, brands, threshold, riskWords);
      const checks = [result.is_lookalike === entry.is_lookalike];
      if (entry.type) checks.push(result.best_match?.type === entry.type);
      if (entry.brand) checks.push(result.best_match?.brand === entry.brand);
      return { domain: entry.domain, ok: checks.every(Boolean), result };
    });
    return { ok: results.every((item) => item.ok), actual: results };
  },

  invariance(testCase) {
    // Skipped dimensions (skipped-login / not-covered) must never change the
    // risk score or the level — they only reduce coverage (D8/D10).
    const rules = loadRules();
    const input = testCase.input || {};
    const runA = riskScore(input.flags || [], rules, false, input.covered_a, input.anchors);
    const runB = riskScore(input.flags || [], rules, false, input.covered_b, input.anchors);
    const expect = testCase.expect || {};
    const checks = [];
    if (expect.risk_score_equal) checks.push(runA.risk_score === runB.risk_score);
    if (expect.level_equal) checks.push(runA.level === runB.level);
    return {
      ok: checks.every(Boolean),
      actual: {
        a: { risk_score: runA.risk_score, level: runA.level, coverage: runA.coverage },
        b: { risk_score: runB.risk_score, level: runB.level, coverage: runB.coverage },
      },
    };
  },

  async whois_fixture(testCase) {
    const fixture = testCase.input.fixture_data
      ? JSON.parse(JSON.stringify(testCase.input.fixture_data))
      : JSON.parse(readFileSync(join(FIXTURES_DIR, testCase.input.fixture), 'utf8'));
    const daysAgo = testCase.input.days_ago ?? 20;
    const stamp = new Date(Date.now() - daysAgo * 86400000).toISOString();
    for (const event of fixture.events || []) {
      if (event.eventAction === 'registration') event.eventDate = stamp;
    }
    const dir = mkdtempSync(join(tmpdir(), 'buyer-check-'));
    const tmp = join(dir, 'rdap.json');
    writeFileSync(tmp, JSON.stringify(fixture));
    const result = await whoisAnalyse(testCase.input.domain, { rdapJson: tmp });
    return {
      ok: result.is_new_domain === testCase.expect.is_new_domain,
      actual: { is_new_domain: result.is_new_domain, age_days: result.age_days },
    };
  },

  mask(testCase) {
    const result = maskSensitive(testCase.input.text);
    return { ok: result === testCase.expect.masked, actual: { masked: result } };
  },

  deterministic(testCase) {
    const rules = loadRules();
    const runs = [0, 1, 2].map(() => riskScore(testCase.input.flags, rules, false));
    const levels = new Set(runs.map((item) => `${item.level}:${item.total}`));
    return { ok: levels.size === 1, actual: { signatures: [...levels] } };
  },

  report_structure(testCase) {
    const text = readFileSync(join(ROOT, testCase.input.file), 'utf8');
    const hasSource = /来源：\s*https?:\/\//.test(text);
    const hasTimestamp = /检索时间：\s*\d{4}-\d{2}-\d{2}/.test(text);
    const hasDisclaimer = text.includes('不构成法律意见');
    return { ok: hasSource && hasTimestamp && hasDisclaimer, actual: { hasSource, hasTimestamp, hasDisclaimer } };
  },

  identity(testCase) {
    const input = testCase.input || {};
    const python = findPython();
    if (!python) return { skipped: true, actual: 'python not found' };
    const dir = mkdtempSync(join(tmpdir(), 'buyer-check-id-'));
    const htmlPath = join(dir, 'site.html');
    writeFileSync(htmlPath, input.html || '');
    const png = Buffer.from(input.image_base64 || '', 'base64');
    const a = join(dir, 'a.png');
    const b = join(dir, 'b.png');
    writeFileSync(a, png);
    writeFileSync(b, png);
    const pyScript = join(ROOT, 'scripts', 'identity_check.py');
    const jsScript = join(ROOT, 'scripts', 'identity_check.mjs');
    const [pyCmd, ...pyRest] = python.split(' ');
    const run = (cmd, args) => {
      const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000 });
      if (!result.stdout) throw new Error(result.stderr || 'no output');
      return JSON.parse(result.stdout);
    };
    const pySite = run(pyCmd, [...pyRest, pyScript, 'site', '--domain', input.domain, '--html-file', htmlPath]);
    const pyBack = run(pyCmd, [...pyRest, pyScript, 'backlink', '--domain', input.domain, '--text', input.backlink_text || '']);
    const pyImg = run(pyCmd, [...pyRest, pyScript, 'image', a, b]);
    let pyMap = null;
    if (input.map) {
      const mapPath = join(dir, 'map.json');
      writeFileSync(mapPath, JSON.stringify(input.map.fixture || {}));
      pyMap = run(pyCmd, [...pyRest, pyScript, 'map', '--company', input.map.company, '--phone', input.map.phone, '--fixture-json', mapPath]);
    }
    const expect = testCase.expect || {};
    const checks = [
      (pySite.company_candidates || []).includes(expect.company),
      pySite.description === expect.description,
      (pySite.social_links || []).length === expect.social_count,
      (pySite.emails || []).includes(expect.email),
      (pySite.phones || []).includes(expect.phone),
      pyBack.mutual === expect.mutual,
      pyImg.result === expect.image_result,
    ];
    if (pyMap) {
      checks.push(
        pyMap.match?.name_match === expect.map_name_match,
        pyMap.match?.phone_match === expect.map_phone_match,
        pyMap.source === expect.map_source,
      );
    }
    let parity = true;
    if (existsSync(jsScript)) {
      const jsSite = run('node', [jsScript, 'site', '--domain', input.domain, '--html-file', htmlPath]);
      const jsBack = run('node', [jsScript, 'backlink', '--domain', input.domain, '--text', input.backlink_text || '']);
      const jsImg = run('node', [jsScript, 'image', a, b]);
      parity = isDeepStrictEqual(pySite, jsSite) && isDeepStrictEqual(pyBack, jsBack) && isDeepStrictEqual(pyImg, jsImg);
      if (input.map) {
        const mapPath = join(dir, 'map.json');
        const jsMap = run('node', [jsScript, 'map', '--company', input.map.company, '--phone', input.map.phone, '--fixture-json', mapPath]);
        parity = parity && isDeepStrictEqual(pyMap, jsMap);
      }
    }
    checks.push(parity);
    return {
      ok: checks.every(Boolean),
      actual: {
        company: pySite.company_candidates,
        description: pySite.description,
        social: (pySite.social_links || []).length,
        mutual: pyBack.mutual,
        image: pyImg.result,
        map: pyMap ? pyMap.match : null,
        parity,
      },
    };
  },

  async sanctions_update(testCase) {
    const python = findPython();
    const scenario = testCase.input.scenario;
    const validRows = [];
    const badTypeRows = [];
    const oldFormatRows = [];
    for (let i = 1; i <= 15000; i += 1) {
      const name = `SYNTHETIC ENTITY ${String(i).padStart(5, '0')}`;
      validRows.push(`${i},"${name}",entity,"TEST-PROGRAM",-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-`);
      badTypeRows.push(`${i},"${name}","WRONG-TYPE","TEST-PROGRAM",-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-`);
      oldFormatRows.push(`${i},entity,"${name}"`);
    }
    const validCsv = `${validRows.join('\n')}\n`;
    const badTypeCsv = `${badTypeRows.join('\n')}\n`;
    const oldFormatCsv = `${oldFormatRows.join('\n')}\n`;
    const invalidCsv = 'not,a,csv\n1,2,3\n';
    const hits = [];
    const server = createServer((req, res) => {
      hits.push(req.url);
      if (req.url === '/good' || req.url === '/third') {
        res.writeHead(200, { 'content-type': 'text/csv', 'last-modified': 'Mon, 09 Nov 2026 19:36:11 GMT' });
        res.end(validCsv);
      } else if (req.url === '/bad-types') {
        res.writeHead(200, { 'content-type': 'text/csv' });
        res.end(badTypeCsv);
      } else if (req.url === '/old-format') {
        res.writeHead(200, { 'content-type': 'text/csv' });
        res.end(oldFormatCsv);
      } else if (req.url === '/invalid' || req.url === '/bad') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(invalidCsv);
      } else if (req.url === '/fail' || req.url === '/fail2') {
        res.writeHead(500);
        res.end('error');
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const paths = scenario === 'chain' ? ['/invalid', '/good', '/third'] : scenario === 'invalid' ? ['/bad'] : scenario === 'bad-types' ? ['/bad-types'] : scenario === 'old-format' ? ['/old-format'] : ['/fail', '/fail2'];
    const oldCache = ['invalid', 'bad-types', 'old-format'].includes(scenario) ? 'OLD-CACHE-BYTES' : null;
    const [pyCmd, ...pyRest] = (python || '').split(' ');
    const impls = [];
    const updateScript = join(ROOT, 'scripts', 'update_sanctions.py');
    const hasUpdateScript = existsSync(updateScript);
    if (python) impls.push({ name: 'python', cmd: pyCmd, rest: pyRest, script: hasUpdateScript ? updateScript : join(ROOT, 'scripts', 'sanctions_check.py'), prefix: hasUpdateScript ? [] : ['--self-update'] });
    const updateNodeScript = join(ROOT, 'scripts', 'update_sanctions.mjs');
    if (existsSync(updateNodeScript)) impls.push({ name: 'node', cmd: 'node', rest: [], script: updateNodeScript, prefix: [] });
    const outcomes = [];
    for (const impl of impls) {
      hits.length = 0;
      const dir = mkdtempSync(join(tmpdir(), 'buyer-check-sanctions-'));
      if (oldCache) writeFileSync(join(dir, 'ofac_sdn.csv'), oldCache, 'utf8');
      const args = [impl.script, ...(impl.prefix || []), '--urls', paths.map((item) => base + item).join(','), '--cache-dir', dir];
      const run = await runProcess(impl.cmd, [...impl.rest, ...args], {
        cwd: ROOT,
        env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
      });
      if (!run.stdout) throw new Error(run.stderr || `${impl.name} no output`);
      const result = JSON.parse(run.stdout);
      const item = (result.results && result.results[0]) || {};
      const cachePath = join(dir, 'ofac_sdn.csv');
      outcomes.push({
        impl: impl.name,
        status: result.status,
        reason: item.reason || null,
        source_path: item.source_url ? item.source_url.replace(base, '') : null,
        hits: [...hits],
        cache: oldCache && existsSync(cachePath) ? readFileSync(cachePath, 'utf8') : null,
        exit: run.status,
        attempt_statuses: (item.attempts || []).map((attempt) => attempt.status),
      });
    }
    await new Promise((resolve) => server.close(resolve));
    const checks = outcomes.map((outcome) => {
      if (scenario === 'chain') {
        return outcome.status === 'ok' && outcome.source_path === '/good' && isDeepStrictEqual(outcome.hits, ['/invalid', '/good']) && outcome.exit === 0;
      }
      if (scenario === 'invalid' || scenario === 'bad-types' || scenario === 'old-format') {
        return outcome.status === 'unavailable' && outcome.reason === 'invalid-content' && outcome.cache === oldCache && outcome.exit === 1;
      }
      return outcome.status === 'unavailable' && outcome.reason === 'all-urls-failed' && outcome.exit === 1;
    });
    const parity = outcomes.length === 1 || (outcomes.length === 2
      && outcomes[0].status === outcomes[1].status
      && outcomes[0].reason === outcomes[1].reason
      && outcomes[0].source_path === outcomes[1].source_path);
    return { ok: checks.every(Boolean) && parity, actual: outcomes };
  },

  sanctions(testCase) {
    const python = findPython();
    if (!python) return { skipped: true, actual: 'python not found' };
    const dir = mkdtempSync(join(tmpdir(), 'buyer-check-sanctions-'));
    const empty = join(dir, 'empty');
    const cache = join(dir, 'cache');
    const down = join(dir, 'down');
    const fail = join(dir, 'fail');
    for (const path of [empty, cache, down, fail]) mkdirSync(path, { recursive: true });
    const csv = testCase.input?.csv || '';
    writeFileSync(join(cache, 'ofac_sdn.csv'), csv, 'utf8');
    const [cmd, ...rest] = python.split(' ');
    const script = join(ROOT, 'scripts', 'sanctions_check.py');
    const run = (args) => {
      const result = spawnSync(cmd, [...rest, ...args], { encoding: 'utf8', timeout: 30000 });
      if (!result.stdout) throw new Error(result.stderr || 'no output');
      return JSON.parse(result.stdout);
    };
    const noCache = run([script, 'GLOBAL STAR TRADING CO', '--no-update', '--cache-dir', empty]);
    const clear = run([script, 'NOBODY', '--no-update', '--cache-dir', cache]);
    const hit = run([script, 'GLOBAL STAR TRADING CO', '--no-update', '--cache-dir', cache]);
    const successScript = [
      'import sys, json, os',
      `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})`,
      'import sanctions_check',
      'def fake(cache_dir, timeout=60.0):',
      '    os.makedirs(cache_dir, exist_ok=True)',
      '    with open(os.path.join(cache_dir, "ofac_sdn.csv"), "w", encoding="utf-8") as handle:',
      `        handle.write(${JSON.stringify(csv)})`,
      "    return {'status': 'ok'}",
      'sanctions_check.download_ofac = fake',
      `result = sanctions_check.analyse('GLOBAL STAR TRADING CO', cache_dir=${JSON.stringify(down)}, no_update=False)`,
      `print(json.dumps({'status': result.get('status'), 'match_count': result.get('match_count'), 'exists': os.path.exists(os.path.join(${JSON.stringify(down)}, 'ofac_sdn.csv'))}))`,
    ].join('\n');
    const failScript = [
      'import sys, json, os',
      `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})`,
      'import sanctions_check',
      'def fake(cache_dir, timeout=60.0):',
      "    return {'status': 'unavailable'}",
      'sanctions_check.download_ofac = fake',
      `result = sanctions_check.analyse('GLOBAL STAR TRADING CO', cache_dir=${JSON.stringify(fail)}, no_update=False)`,
      "print(json.dumps({'status': result.get('status'), 'error': result.get('error')}))",
    ].join('\n');
    const success = run(['-c', successScript]);
    const failed = run(['-c', failScript]);
    const checks = [
      noCache.status === 'unavailable' && noCache.error === 'no-network',
      clear.status === 'ok' && clear.match_count === 0,
      hit.status === 'ok' && hit.match_count > 0 && hit.requires_manual_review === true,
      success.status === 'ok' && success.match_count > 0 && success.exists === true,
      failed.status === 'unavailable' && failed.error === 'download-failed',
    ];
    return { ok: checks.every(Boolean), actual: { noCache, clear, hit, success, failed } };
  },

  score_bar(testCase) {
    const scores = testCase.input?.scores || [];
    const node = scores.map((score) => {
      const filled = Math.floor(score / 10 + 0.5);
      return { score, filled, bar: `${'■'.repeat(filled)}${'□'.repeat(10 - filled)}` };
    });
    const python = findPython();
    let pyFilled = null;
    if (python) {
      const [cmd, ...rest] = python.split(' ');
      const script = `import math, json\nprint(json.dumps([math.floor(x / 10 + 0.5) for x in ${JSON.stringify(scores)}]))`;
      const result = spawnSync(cmd, [...rest, '-c', script], { encoding: 'utf8', timeout: 30000 });
      if (result.stdout) pyFilled = JSON.parse(result.stdout);
    }
    const expected = testCase.expect?.filled || [];
    const checks = [
      node.every((item, index) => item.filled === expected[index]),
      pyFilled !== null && pyFilled.every((value, index) => value === expected[index]),
      pyFilled !== null && pyFilled.every((value, index) => value === node[index].filled),
    ];
    return { ok: checks.every(Boolean), actual: { node, python: pyFilled } };
  },

  render_card(testCase) {
    const evidence = testCase.input.fixture_data ? cloneJson(testCase.input.fixture_data) : loadFixture(testCase.input.fixture);
    if (testCase.input.mutate_intake) {
      evidence.intake = evidence.intake && typeof evidence.intake === 'object' ? evidence.intake : {};
      Object.assign(evidence.intake, cloneJson(testCase.input.mutate_intake));
    }
    if (testCase.input.mutate_layers) {
      evidence.layers = evidence.layers && typeof evidence.layers === 'object' ? evidence.layers : {};
      for (const [key, value] of Object.entries(cloneJson(testCase.input.mutate_layers))) {
        evidence.layers[key] = { ...(evidence.layers[key] || {}), ...value };
      }
    }
    if (testCase.input.mutate_customs_profile !== undefined) evidence.customs_profile = cloneJson(testCase.input.mutate_customs_profile);
    if (testCase.input.mutate_as_of !== undefined) evidence.as_of = testCase.input.mutate_as_of;
    const result = renderCard ? renderCard(evidence, loadRules()) : pyRenderEvidence(findPython(), evidence);
    const expect = testCase.expect || {};
    const checks = [];
    if (expect.status !== undefined) checks.push(result.status === expect.status);
    if (expect.error_codes !== undefined) {
      const codes = (result.errors || []).map((error) => error.code).sort();
      checks.push(isDeepStrictEqual(codes, [...expect.error_codes].sort()));
    }
    if (expect.level !== undefined) checks.push(result.level === expect.level);
    if (expect.risk_score !== undefined) checks.push(result.risk_score === expect.risk_score);
    if (expect.credit !== undefined) checks.push(result.credit?.score === expect.credit);
    if (expect.credit_tier !== undefined) checks.push(result.credit?.tier === expect.credit_tier);
    if (expect.actual_risk_score !== undefined) checks.push(result.actual?.risk_score === expect.actual_risk_score);
    if (expect.actual_level !== undefined) checks.push(result.actual?.level === expect.actual_level);
    if (result.card) {
      if (expect.card !== undefined) {
        checks.push(result.card === expect.card);
      } else if (expect.card_file) {
        const expected = readFileSync(join(FIXTURES_DIR, expect.card_file), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
        checks.push(result.card === expected);
      }
      for (const needle of expect.card_includes || []) checks.push(result.card.includes(needle));
      for (const needle of expect.card_excludes || []) checks.push(!result.card.includes(needle));
    } else if (expect.card_file || (expect.card_includes || []).length > 0) {
      checks.push(false);
    }
    if (expect.line_count_max !== undefined) checks.push(result.line_count <= expect.line_count_max);
    if (expect.first_screen_max !== undefined) checks.push(result.first_screen_lines <= expect.first_screen_max);
    if (expect.evidence_missing !== undefined) checks.push(result.evidence_missing === expect.evidence_missing);
    if (expect.verdict_warning !== undefined) checks.push((result.verdict_warning ?? null) === expect.verdict_warning);
    if (expect.derived_flags !== undefined) checks.push(isDeepStrictEqual(result.derived_flags, expect.derived_flags));
    const computed = result.computed || {};
    if (expect.lead_class !== undefined) checks.push(computed.lead_class === expect.lead_class);
    if (expect.lead_class_label !== undefined) checks.push(computed.lead_class_label === expect.lead_class_label);
    if (expect.lead_class_basis !== undefined) checks.push(isDeepStrictEqual(computed.lead_class_basis, expect.lead_class_basis));
    if (expect.lead_signals_ignored !== undefined) checks.push(computed.lead_signals_ignored === expect.lead_signals_ignored);
    if (expect.lead_class_source !== undefined) checks.push(computed.lead_class_source === expect.lead_class_source);

    if (expect.follow_up_grade !== undefined) checks.push(computed.follow_up_grade === expect.follow_up_grade);
    if (expect.follow_up_advice !== undefined) checks.push(computed.follow_up_advice === expect.follow_up_advice);
    if (expect.follow_up_grade_basis !== undefined) checks.push(isDeepStrictEqual(computed.follow_up_grade_basis, expect.follow_up_grade_basis));
    if (expect.follow_up_grade_ignored !== undefined) checks.push(computed.follow_up_grade_ignored === expect.follow_up_grade_ignored);
    if (expect.hub_exception !== undefined) checks.push(isDeepStrictEqual(computed.hub_exception ?? null, expect.hub_exception));
    if (expect.customs_profile !== undefined) checks.push(isDeepStrictEqual(result.customs_profile ?? null, expect.customs_profile));
    if (expect.site_activity !== undefined) checks.push(isDeepStrictEqual(result.site_activity ?? null, expect.site_activity));
    if (expect.person_role !== undefined) checks.push(isDeepStrictEqual(result.person_role ?? null, expect.person_role));
    if (expect.customs_hint !== undefined) checks.push((result.customs_profile?.follow_up_hint ?? null) === expect.customs_hint);
    if (expect.main_hs !== undefined) checks.push(isDeepStrictEqual(result.customs_profile?.main_hs, expect.main_hs));
    if (expect.main_hs_ignored !== undefined) checks.push(result.customs_profile?.main_hs_ignored === expect.main_hs_ignored);
    if (expect.site_hint_includes !== undefined) checks.push((result.site_activity?.hints || []).some((hint) => hint.includes(expect.site_hint_includes)));
    if (expect.person_hint_includes !== undefined) checks.push((result.person_role?.hints || []).some((hint) => hint.includes(expect.person_hint_includes)));
    if (expect.declaration_count !== undefined) {
      const hits = (String(result.card || '').match(/仅基于公开信息的风险信号筛查，不构成对客户的定性。/g) || []).length;
      checks.push(hits === expect.declaration_count);
    }
    if (testCase.input.compare_fixture || testCase.input.compare_fixture_data) {
      const baseEvidence = testCase.input.compare_fixture_data ? cloneJson(testCase.input.compare_fixture_data) : loadFixture(testCase.input.compare_fixture);
      const base = renderCard ? renderCard(baseEvidence, loadRules()) : pyRenderEvidence(findPython(), baseEvidence);
      checks.push(isDeepStrictEqual(result.actions, base.actions));
      checks.push(result.risk_score === base.risk_score && result.level === base.level && result.credit?.score === base.credit?.score);
    }
    return {
      ok: checks.every(Boolean),
      actual: {
        status: result.status,
        level: result.level,
        risk_score: result.risk_score,
        credit: result.credit,
        line_count: result.line_count,
        first_screen_lines: result.first_screen_lines,
        errors: result.errors,
        mismatch: result.actual,
      },
    };
  },

  dedup(testCase) {
    const python = findPython();
    const dir = mkdtempSync(join(tmpdir(), 'buyer-check-dedup-'));
    const paths = (testCase.input.packs || []).map((pack, index) => {
      const path = join(dir, `p${index + 1}.json`);
      writeFileSync(path, JSON.stringify(pack), 'utf8');
      return path;
    });
    const [cmd, ...rest] = (python || '').split(' ');
    const py = python ? spawnSync(cmd, [...rest, join(ROOT, 'scripts', 'render_card.py'), '--dedup', ...paths], { encoding: 'utf8', timeout: 30000 }) : null;
    const jsScript = join(ROOT, 'scripts', 'render_card.mjs');
    const hasNode = existsSync(jsScript);
    const jsRun = hasNode ? spawnSync('node', [jsScript, '--dedup', ...paths], { encoding: 'utf8', timeout: 30000 }) : null;
    const pyText = py ? String(py.stdout || '') : '';
    const jsText = jsRun ? String(jsRun.stdout || '') : '';
    const checks = [Boolean(py)];
    if (py) checks.push(py.status === 0);
    if (jsRun) checks.push(jsRun.status === 0);
    if (py && jsRun && jsText) checks.push(pyText === jsText);
    for (const needle of testCase.input.contains || []) checks.push(pyText.includes(needle));
    for (const needle of testCase.input.excludes || []) checks.push(!pyText.includes(needle));
    return { ok: checks.every(Boolean), actual: { py: pyText.trim(), js: jsText.trim() } };
  },

  eval_self(testCase) {
    const script = join(ROOT, 'tests', 'eval', 'score_eval.mjs');
    if (!existsSync(script)) return { skipped: true, actual: 'eval scorer not in lean bundle' };
    const run = spawnSync('node', [script, '--self'], { encoding: 'utf8', timeout: 60000 });
    return {
      ok: run.status === 0,
      actual: run.stdout ? run.stdout.trim().split('\n').slice(-3) : run.stderr,
    };
  },

  fetch_guard(testCase) {
    const python = findPython();
    const cases = testCase.input.cases || [];
    const pyScript = [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})`,
      'from identity_check import fetch_guard_reason',
      `cases = json.loads(${JSON.stringify(JSON.stringify(cases))})`,
      'print(json.dumps([fetch_guard_reason(item["status"], item.get("location", ""), item.get("content_type", ""), item.get("size", 0), item.get("redirects", 0), item.get("previous_url", "")) for item in cases]))',
    ].join('\n');
    const nodeScript = [
      `import { fetchGuardReason } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts', 'identity_check.mjs')).href)};`,
      `const cases = ${JSON.stringify(cases)};`,
      'console.log(JSON.stringify(cases.map((item) => fetchGuardReason(item.status, item.location || "", item.content_type || "", item.size || 0, item.redirects || 0, item.previous_url || ""))));',
    ].join('\n');
    const [cmd, ...rest] = (python || '').split(' ');
    const py = python ? spawnSync(cmd, [...rest, '-c', pyScript], { encoding: 'utf8', timeout: 30000 }) : null;
    const hasNode = existsSync(join(ROOT, 'scripts', 'identity_check.mjs'));
    const nodeRun = hasNode ? spawnSync('node', ['--input-type=module', '-e', nodeScript], { encoding: 'utf8', timeout: 30000 }) : null;
    const pyOut = py && py.stdout ? JSON.parse(py.stdout) : null;
    const jsOut = nodeRun && nodeRun.stdout ? JSON.parse(nodeRun.stdout) : null;
    const checks = [Boolean(pyOut)];
    if (jsOut) checks.push(Boolean(jsOut));
    cases.forEach((item, index) => {
      if (pyOut) checks.push(pyOut[index] === item.expect);
      if (jsOut) checks.push(jsOut[index] === item.expect);
      if (pyOut && jsOut) checks.push(pyOut[index] === jsOut[index]);
    });
    return { ok: checks.every(Boolean), actual: { py: pyOut, js: jsOut } };
  },

  contact_links(testCase) {
    const python = findPython();
    if (!python) return { skipped: true, actual: 'python not found' };
    const pyScript = [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})`,
      'import identity_check',
      `html = ${JSON.stringify(testCase.input.html)}`,
      `base = ${JSON.stringify(testCase.input.base || '')}`,
      'out = identity_check.parse_html(html, base)',
      'print(json.dumps({"contact_links": out["contact_links"], "team_links": out["team_links"]}, ensure_ascii=False))',
    ].join('\n');
    const [cmd, ...rest] = python.split(' ');
    const run = spawnSync(cmd, [...rest, '-c', pyScript], { encoding: 'utf8', timeout: 30000 });
    const out = run.stdout ? JSON.parse(run.stdout) : null;
    const checks = [Boolean(out)];
    for (const needle of testCase.input.contains || []) checks.push(Boolean(out && out.contact_links.includes(needle)));
    for (const needle of testCase.input.excludes || []) checks.push(Boolean(out && !out.contact_links.includes(needle)));
    return { ok: checks.every(Boolean), actual: out };
  },

  url_safety(testCase) {
    const python = findPython();
    const cases = testCase.input.cases || [];
    const pyScript = [
      'import sys, json, socket',
      `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})`,
      'from identity_check import validate_url, UnsafeUrl',
      `cases = ${JSON.stringify(cases)}`,
      'out = []',
      'for item in cases:',
      '    ips = item.get("ips")',
      '    resolver = (lambda *args: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0)) for ip in ips]) if ips else None',
      '    try:',
      '        validate_url(item["url"], resolver)',
      '        out.append("ok")',
      '    except UnsafeUrl as exc:',
      '        out.append(exc.reason)',
      '    except Exception as exc:',
      '        out.append("error:" + type(exc).__name__)',
      'print(json.dumps(out))',
    ].join('\n');
    const nodeScript = [
      `import { validateUrl, UnsafeUrl } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts', 'identity_check.mjs')).href)};`,
      `const cases = ${JSON.stringify(cases)};`,
      'const out = [];',
      'for (const item of cases) {',
      '  let reason = "ok";',
      '  try {',
      '    const resolver = item.ips ? (async () => item.ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))) : null;',
      '    await validateUrl(item.url, resolver);',
      '  } catch (error) {',
      '    reason = error instanceof UnsafeUrl ? error.reason : `error:${error}`;',
      '  }',
      '  out.push(reason);',
      '}',
      'console.log(JSON.stringify(out));',
    ].join('\n');
    const py = python ? (() => {
      const [cmd, ...rest] = python.split(' ');
      const run = spawnSync(cmd, [...rest, '-c', pyScript], { encoding: 'utf8', timeout: 30000 });
      return run.stdout ? JSON.parse(run.stdout) : null;
    })() : null;
    const nodeRun = existsSync(join(ROOT, 'scripts', 'identity_check.mjs'))
      ? spawnSync('node', ['--input-type=module', '-e', nodeScript], { encoding: 'utf8', timeout: 30000 })
      : null;
    const js = nodeRun && nodeRun.stdout ? JSON.parse(nodeRun.stdout) : null;
    const checks = [Boolean(py)];
    if (js) checks.push(Boolean(js));
    cases.forEach((item, index) => {
      if (py) checks.push(py[index] === item.expect);
      if (js) checks.push(js[index] === item.expect);
      if (py && js) checks.push(py[index] === js[index]);
    });
    return { ok: checks.every(Boolean), actual: { py, js } };
  },

  domain_suffix(testCase) {
    const cases = (testCase.input.cases || []).map((entry) => ({ host: entry.host, expect: entry.expect }));
    for (const suffix of testCase.input.suffixes || []) {
      cases.push({ host: `acme.${suffix}`, expect: `acme.${suffix}` });
      cases.push({ host: `www.acme.${suffix}`, expect: `acme.${suffix}` });
    }
    const python = findPython();
    if (!python) return { skipped: true, actual: 'python not found' };
    const hosts = cases.map((item) => item.host);
    const pyScript = [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})`,
      'import render_card, domain_similarity',
      `hosts = ${JSON.stringify(hosts)}`,
      'out = []',
      'for host in hosts:',
      '    reg = render_card.registrable_domain(host)',
      '    core = domain_similarity.core_label(host)',
      '    out.append({"registrable": reg, "core": ".".join([part for part in core if part])})',
      'print(json.dumps(out))',
    ].join('\n');
    const [cmd, ...rest] = python.split(' ');
    const run = spawnSync(cmd, [...rest, '-c', pyScript], { encoding: 'utf8', timeout: 30000 });
    const py = run.stdout ? JSON.parse(run.stdout) : null;
    const js = cases.map(({ host }) => {
      const core = coreLabel(host);
      const coreJoined = core.filter(Boolean).join('.');
      return { registrable: registrableDomain ? registrableDomain(host) : coreJoined, core: coreJoined };
    });
    const checks = [Boolean(py)];
    cases.forEach((item, index) => {
      if (py) {
        checks.push(py[index].registrable === item.expect);
        checks.push(py[index].core === item.expect);
      }
      checks.push(js[index].registrable === item.expect);
      checks.push(js[index].core === item.expect);
      if (py) {
        checks.push(py[index].registrable === js[index].registrable);
        checks.push(py[index].core === js[index].core);
      }
    });
    return {
      ok: checks.every(Boolean),
      actual: cases.map((item, index) => ({ host: item.host, expect: item.expect, py: py ? py[index] : null, js: js[index] })),
    };
  },

  lead_matrix(testCase) {
    const rules = loadRules();
    const python = findPython();
    const baseEvidence = testCase.input.fixture_data ? cloneJson(testCase.input.fixture_data) : loadFixture(testCase.input.fixture);
    const render = (evidence) => (renderCard ? renderCard(evidence, rules) : pyRenderEvidence(python, evidence));
    const base = render(cloneJson(baseEvidence));
    const outcomes = (testCase.input.cases || []).map((entry) => {
      const evidence = cloneJson(baseEvidence);
      evidence.intake = evidence.intake && typeof evidence.intake === 'object' ? evidence.intake : {};
      if (entry.intake) Object.assign(evidence.intake, cloneJson(entry.intake));
      if (entry.signals !== undefined) evidence.intake.lead_signals = cloneJson(entry.signals);
      if (entry.form_meta !== undefined) evidence.intake.form_meta = cloneJson(entry.form_meta);
      if (entry.attachments !== undefined) evidence.intake.attachments = cloneJson(entry.attachments);
      if (entry.lead_class_input !== undefined) evidence.intake.lead_class = entry.lead_class_input;
      if (entry.identity !== undefined) evidence.identity = cloneJson(entry.identity);
      if (entry.flags !== undefined) evidence.flags = cloneJson(entry.flags);
      if (entry.anchors !== undefined) evidence.anchors = cloneJson(entry.anchors);
      if (entry.layers !== undefined) evidence.layers = cloneJson(entry.layers);
      if (entry.confidence !== undefined) evidence.confidence = entry.confidence;
      if (entry.country !== undefined) evidence.subject = { ...(evidence.subject || {}), country: entry.country };
      if (entry.follow_up_grade_input !== undefined) evidence.follow_up_grade = entry.follow_up_grade_input;
      if (entry.quick_check !== undefined) evidence.quick_check = entry.quick_check;
      const result = render(evidence);
      const computed = result.computed || {};
      const card = String(result.card || '');
      const checks = [result.status === 'ok'];
      if (entry.expect_class !== undefined) checks.push(computed.lead_class === entry.expect_class);
      if (entry.expect_label !== undefined) checks.push(computed.lead_class_label === entry.expect_label);
      if (entry.expect_follow_up_grade !== undefined) checks.push(computed.follow_up_grade === entry.expect_follow_up_grade);
      if (entry.expect_follow_up_basis !== undefined) checks.push(isDeepStrictEqual(computed.follow_up_grade_basis, entry.expect_follow_up_basis));
      if (entry.expect_follow_up_advice !== undefined) checks.push(computed.follow_up_advice === entry.expect_follow_up_advice);
      if (entry.expect_follow_up_ignored !== undefined) checks.push(computed.follow_up_grade_ignored === entry.expect_follow_up_ignored);
      if (entry.expect_hub_exception !== undefined) checks.push(isDeepStrictEqual(computed.hub_exception ?? null, entry.expect_hub_exception));
      if (entry.expect_risk_score !== undefined) checks.push(result.risk_score === entry.expect_risk_score);
      if (entry.expect_confidence !== undefined) checks.push(result.confidence === entry.expect_confidence);
      if (entry.expect_level !== undefined) checks.push(result.level === entry.expect_level);
      if (entry.expect_card_includes_follow_up) checks.push(card.includes(` · 跟进：${entry.expect_card_includes_follow_up}`));
      if (entry.expect_card_excludes_follow_up_suffix === true) checks.push(!/ · 跟进：[ABCD]/.test(card));
      if (entry.expect_ignored !== undefined) checks.push(computed.lead_signals_ignored === entry.expect_ignored);
      if (entry.expect_status !== undefined) checks.push(result.status === entry.expect_status);
      if (entry.expect_anomalies !== undefined) checks.push(isDeepStrictEqual(result.form_meta_anomalies, entry.expect_anomalies));
      if (entry.expect_channel !== undefined) checks.push(result.channel === entry.expect_channel);
      if (entry.expect_channel_ignored !== undefined) checks.push(result.channel_ignored === entry.expect_channel_ignored);
      if (entry.expect_identity_status !== undefined) checks.push((result.identity || {}).status === entry.expect_identity_status);
      if (entry.expect_ship_to_null === true) checks.push(result.ship_to === null || result.ship_to === undefined);
      if (entry.expect_ship_to !== undefined) {
        const ship = result.ship_to || null;
        for (const [key, value] of Object.entries(entry.expect_ship_to)) {
          checks.push(isDeepStrictEqual(ship ? ship[key] : null, value));
        }
      }
      if (entry.expect_trade_background !== undefined) {
        const trade = result.trade_background || {};
        for (const [key, value] of Object.entries(entry.expect_trade_background)) {
          checks.push(isDeepStrictEqual(trade[key] === undefined ? null : trade[key], value));
        }
      }
      if (entry.expect_card_equal_base) checks.push(card === String(base.card || ''));
      if (entry.expect_form_meta !== undefined) {
        const masked = result.form_meta?.submit_ip_masked;
        if (entry.expect_form_meta.submit_ip_masked !== undefined) checks.push(masked === entry.expect_form_meta.submit_ip_masked);
      }
      if (entry.expect_conclusion !== undefined) checks.push(card.includes(`**结论：${entry.expect_conclusion}`));
      for (const needle of entry.expect_card_includes || []) checks.push(card.includes(needle));
      for (const needle of entry.expect_card_excludes || []) checks.push(!card.includes(needle));
      if (entry.line_count_max !== undefined) checks.push(result.line_count <= entry.line_count_max);
      if (entry.first_screen_max !== undefined) checks.push(result.first_screen_lines <= entry.first_screen_max);
      if (testCase.input.invariance) {
        checks.push(result.risk_score === base.risk_score && result.level === base.level && result.confidence === base.confidence);
      }
      for (const word of testCase.input.forbidden_words || []) checks.push(!card.includes(word));
      return {
        name: entry.name,
        ok: checks.every(Boolean),
        lead_class: computed.lead_class,
        ignored: computed.lead_signals_ignored,
        line_count: result.line_count,
      };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  render_card_parity(testCase) {
    const python = findPython();
    if (!python) return { skipped: true, actual: 'python not found' };
    if (!renderCard) return { skipped: true, actual: 'node renderer not in bundle' };
    const evidence = testCase.input.fixture_data ? cloneJson(testCase.input.fixture_data) : loadFixture(testCase.input.fixture);
    evidence.intake = evidence.intake && typeof evidence.intake === 'object' ? evidence.intake : {};
    if (testCase.input.mutate_intake) Object.assign(evidence.intake, cloneJson(testCase.input.mutate_intake));
    if (testCase.input.mutate_identity) evidence.identity = cloneJson(testCase.input.mutate_identity);
    if (testCase.input.mutate_flags) evidence.flags = cloneJson(testCase.input.mutate_flags);
    if (testCase.input.mutate_anchors) evidence.anchors = cloneJson(testCase.input.mutate_anchors);
    if (testCase.input.mutate_layers) evidence.layers = cloneJson(testCase.input.mutate_layers);
    if (testCase.input.mutate_customs_profile !== undefined) evidence.customs_profile = cloneJson(testCase.input.mutate_customs_profile);
    const py = pyRenderEvidence(python, evidence);
    const js = renderCard(cloneJson(evidence), loadRules());
    const checks = [
      py.status === js.status,
      (py.computed?.lead_class ?? null) === (js.computed?.lead_class ?? null),
      py.computed?.lead_class_label === js.computed?.lead_class_label,
      py.computed?.lead_signals_ignored === js.computed?.lead_signals_ignored,
      isDeepStrictEqual(py.computed?.lead_class_basis, js.computed?.lead_class_basis),
      py.computed?.identity_status === js.computed?.identity_status,
      py.computed?.follow_up_grade === js.computed?.follow_up_grade,
      isDeepStrictEqual(py.computed?.follow_up_grade_basis, js.computed?.follow_up_grade_basis),
      isDeepStrictEqual(py.computed?.hub_exception ?? null, js.computed?.hub_exception ?? null),
      isDeepStrictEqual(py.customs_profile ?? null, js.customs_profile ?? null),
      isDeepStrictEqual(py.site_activity ?? null, js.site_activity ?? null),
      isDeepStrictEqual(py.person_role ?? null, js.person_role ?? null),
      isDeepStrictEqual(py.trade_background, js.trade_background),
      py.card === js.card,
    ];
    return {
      ok: checks.every(Boolean),
      actual: { py: py.computed, js: js.computed, card_equal: py.card === js.card },
    };
  },

  mask_ip(testCase) {
    const python = findPython();
    const jsScript = join(ROOT, 'scripts', 'render_card.mjs');
    const outcomes = (testCase.input.cases || []).map((entry) => {
      const py = python ? runPythonRender(python, ['--mask-ip', entry.ip]) : null;
      let js = null;
      if (existsSync(jsScript)) {
        const run = spawnSync('node', [jsScript, '--mask-ip', entry.ip], { encoding: 'utf8', timeout: 30000 });
        if (run.stdout) js = JSON.parse(run.stdout);
      }
      const checks = [Boolean(py)];
      if (py && entry.masked !== undefined) checks.push(py.masked === entry.masked);
      if (py && entry.status !== undefined) checks.push(py.status === entry.status);
      if (py && js) checks.push(py.masked === js.masked && py.status === js.status);
      return { ip: entry.ip, ok: checks.every(Boolean), py: py?.masked, js: js?.masked };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  privacy_ip(testCase) {
    const script = join(ROOT, 'scripts', 'privacy_scan.mjs');
    if (!existsSync(script)) return { skipped: true, actual: 'privacy_scan not shipped in lean bundle' };
    const dir = mkdtempSync(join(tmpdir(), 'buyer-check-privacy-ip-'));
    const bad = join(dir, 'bad.txt');
    const good = join(dir, 'good.txt');
    const publicIp = ['8', '8', '8', '8'].join('.');
    writeFileSync(bad, `upstream server ${publicIp} answered\n`, 'utf8');
    writeFileSync(good, 'examples 203.0.113.0/24 and 203.0.113.7 and 2001:db8::/32 and 2001:db8::1\n', 'utf8');
    const badRun = spawnSync('node', [script, bad], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    const goodRun = spawnSync('node', [script, good], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    const checks = [badRun.status === 1, goodRun.status === 0];
    return {
      ok: checks.every(Boolean),
      actual: {
        bad_exit: badRun.status,
        good_exit: goodRun.status,
        bad_out: String(badRun.stdout || '').trim(),
        good_out: String(goodRun.stdout || '').trim(),
      },
    };
  },

  guide(testCase) {
    const python = findPython();
    const jsScript = join(ROOT, 'scripts', 'render_card.mjs');
    const outcomes = [];
    for (const entry of testCase.input.cases || []) {
      const lang = entry.lang || 'zh';
      let pyOut = '';
      if (python) {
        const [cmd, ...rest] = python.split(' ');
        const run = spawnSync(cmd, [...rest, join(ROOT, 'scripts', 'render_card.py'), '--guide', entry.mode, '--lang', lang], { encoding: 'utf8', timeout: 30000 });
        pyOut = String(run.stdout || '');
      }
      let jsOut = '';
      if (existsSync(jsScript)) {
        const run = spawnSync('node', [jsScript, '--guide', entry.mode, '--lang', lang], { encoding: 'utf8', timeout: 30000 });
        jsOut = String(run.stdout || '');
      }
      const nonempty = pyOut.split('\n').filter((line) => line.trim()).length;
      const checks = [Boolean(pyOut), nonempty > 0];
      if (entry.max_nonempty !== undefined) checks.push(nonempty <= entry.max_nonempty);
      for (const needle of entry.includes || []) checks.push(pyOut.includes(needle));
      if (entry.min_examples !== undefined) {
        const count = (pyOut.match(/示例：|^Example: |^\d+\. /gm) || []).length;
        checks.push(count >= entry.min_examples);
      }
      for (const word of entry.forbidden || []) checks.push(!pyOut.includes(word));
      for (const needle of entry.needles || []) checks.push(pyOut.includes(needle));
      if (pyOut && jsOut) checks.push(pyOut === jsOut);
      outcomes.push({ mode: entry.mode, lang, ok: checks.every(Boolean), nonempty, bytes: Buffer.byteLength(pyOut) });
    }
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  guide_examples(testCase) {
    const python = findPython();
    if (!python) return { skipped: true, actual: 'python not found' };
    const [cmd, ...rest] = python.split(' ');
    const guideRun = spawnSync(cmd, [...rest, join(ROOT, 'scripts', 'render_card.py'), '--guide', 'full', '--lang', 'zh'], { encoding: 'utf8', timeout: 30000 });
    const guideText = String(guideRun.stdout || '');
    const phones = [...guideText.matchAll(/\+\d[\d\s]{5,}\d/g)].map((match) => match[0].trim());
    const phoneResults = phones.slice(0, 2).map((phone) => {
      const run = spawnSync(cmd, [...rest, join(ROOT, 'scripts', 'phone_check.py'), phone], { encoding: 'utf8', timeout: 30000 });
      const parsed = run.stdout ? JSON.parse(run.stdout) : null;
      return { phone, country: parsed?.country, valid: parsed?.valid };
    });
    const ibanMatch = guideText.match(/GB\d{2}[A-Z0-9\s]{10,30}/);
    const iban = ibanMatch ? ibanMatch[0].trim() : '';
    const accountRun = iban
      ? spawnSync(cmd, [...rest, join(ROOT, 'scripts', 'account_check.py'), '--iban', iban, '--country', 'GB'], { encoding: 'utf8', timeout: 30000 })
      : null;
    const account = accountRun?.stdout ? JSON.parse(accountRun.stdout) : null;
    const domains = [...guideText.matchAll(/\b[a-z0-9][a-z0-9.-]*\.(?:example|com|net|org|io|cn)\b/gi)].map((match) => match[0]);
    const badDomains = domains.filter((domain) => !domain.endsWith('.example'));
    const checks = [
      phones.length >= 1,
      phoneResults.every((item) => item.valid === true && item.country === 'GB'),
      Boolean(iban),
      Boolean(account && account.iban?.valid === true && account.iban?.check_digits_ok === true),
      badDomains.length === 0,
    ];
    return {
      ok: checks.every(Boolean),
      actual: { phones: phoneResults, iban: account?.iban?.masked || null, domains, badDomains },
    };
  },

  skill_guide(testCase) {
    const text = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
    const match = text.match(/^description:\s*(.+)$/m);
    const description = match ? match[1] : '';
    const needles = testCase.input.needles || [];
    const checks = [
      description.length > 0 && description.length <= 1024,
      description.includes('使用指南'),
      description.includes('guide'),
      text.includes('使用指南'),
      text.includes('空输入'),
      text.includes('不连环追问'),
      text.includes('原样'),
    ];
    for (const needle of needles) checks.push(text.includes(needle));
    return {
      ok: checks.every(Boolean),
      actual: { description_length: description.length, missing: needles.filter((needle) => !text.includes(needle)) },
    };
  },

  video_script(testCase) {
    const rules = loadRules();
    const python = findPython();
    const outcomes = (testCase.input.cases || []).map((entry) => {
      const evidence = entry.fixture_data ? cloneJson(entry.fixture_data) : loadFixture(entry.fixture);
      evidence.intake = evidence.intake && typeof evidence.intake === 'object' ? evidence.intake : {};
      if (entry.inquiry_type !== undefined) evidence.intake.inquiry_type = entry.inquiry_type;
      const result = renderCard ? renderCard(evidence, rules) : pyRenderEvidence(python, evidence);
      const script = result.video_script;
      const checks = [];
      if (entry.expect === false) checks.push(!script);
      if (entry.expect === true) {
        checks.push(Boolean(script));
        if (script) {
          checks.push(script.en === testCase.input.en && script.zh === testCase.input.zh);
          for (const word of entry.forbidden || []) checks.push(!script.en.includes(word) && !script.zh.includes(word));
        }
      }
      return { name: entry.name, ok: checks.every(Boolean), video_script: Boolean(script) };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  sanctions_uk(testCase) {
    const python = findPython();
    const dir = mkdtempSync(join(tmpdir(), 'buyer-check-uk-sanctions-'));
    writeFileSync(join(dir, 'uk_sanctions_list.csv'), testCase.input.fixture_text || readFileSync(join(ROOT, 'tests', 'fixtures', testCase.input.fixture), 'utf8'), 'utf8');
    writeFileSync(join(dir, 'ofac_sdn.csv'), '1,"NOBODY",-0-,"TEST",-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-\n', 'utf8');
    if (testCase.input.old_csv) writeFileSync(join(dir, 'uk_ofsi.csv'), testCase.input.old_csv, 'utf8');
    const [pyCmd, ...pyRest] = (python || '').split(' ');
    const run = (cmd, rest, script, query) => {
      const result = spawnSync(cmd, [...rest, script, query, '--no-update', '--cache-dir', dir], { encoding: 'utf8', timeout: 30000 });
      return result.stdout ? JSON.parse(result.stdout) : null;
    };
    const jsScript = join(ROOT, 'scripts', 'sanctions_check.mjs');
    const outcomes = (testCase.input.queries || []).map((entry) => {
      const py = python ? run(pyCmd, pyRest, join(ROOT, 'scripts', 'sanctions_check.py'), entry.query) : null;
      const js = existsSync(jsScript) ? run('node', [], jsScript, entry.query) : null;
      const checks = [Boolean(py), py ? py.status === 'ok' : false];
      if (py) {
        checks.push(py.match_count === (entry.min_match_count === undefined ? entry.match_count : py.match_count));
        if (entry.min_match_count !== undefined) checks.push(py.match_count >= entry.min_match_count);
        checks.push((py.lists_checked || []).some((item) => item.list === 'UK Sanctions List'));
        checks.push(!(py.lists_not_configured || []).includes('UK Sanctions List'));
        if (entry.match_type) checks.push((py.possible_matches || []).some((item) => item.match_type === entry.match_type));
        if (entry.matched_on) checks.push((py.possible_matches || []).some((item) => item.matched_on === entry.matched_on && (!entry.alias_of || item.alias_of === entry.alias_of)));
      }
      if (py && js) checks.push(isDeepStrictEqual(py, js));
      return { query: entry.query, ok: checks.every(Boolean), py: py ? { match_count: py.match_count, possible_matches: py.possible_matches } : null };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  uk_validate(testCase) {
    if (!existsSync(join(ROOT, 'scripts', 'update_sanctions.py'))) {
      return { skipped: true, actual: 'update_sanctions not shipped in lean bundle' };
    }
    const python = findPython();
    const cases = testCase.input.cases || [];
    const pyScript = [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})`,
      'import update_sanctions',
      `cases = ${JSON.stringify(cases)}`,
      'out = []',
      'for value in cases:',
      '    ok, detail = update_sanctions.validate_uk(value.encode("utf-8"))',
      '    out.append({"ok": ok, "detail": detail})',
      'print(json.dumps(out))',
    ].join('\n');
    const nodeScript = [
      `import { validateUk } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts', 'update_sanctions.mjs')).href)};`,
      `const cases = ${JSON.stringify(cases)};`,
      'console.log(JSON.stringify(cases.map((value) => validateUk(Buffer.from(value, "utf8")))));',
    ].join('\n');
    const [cmd, ...rest] = (python || '').split(' ');
    const py = python ? spawnSync(cmd, [...rest, '-c', pyScript], { encoding: 'utf8', timeout: 30000 }) : null;
    const nodeRun = existsSync(join(ROOT, 'scripts', 'update_sanctions.mjs'))
      ? spawnSync('node', ['--input-type=module', '-e', nodeScript], { encoding: 'utf8', timeout: 30000 })
      : null;
    const pyOut = py && py.stdout ? JSON.parse(py.stdout) : null;
    const jsOut = nodeRun && nodeRun.stdout ? JSON.parse(nodeRun.stdout) : null;
    const checks = [Boolean(pyOut)];
    if (jsOut) checks.push(Boolean(jsOut));
    cases.forEach((value, index) => {
      if (pyOut) checks.push(pyOut[index].ok === false);
      if (jsOut) checks.push(jsOut[index].ok === false);
      if (pyOut && jsOut) checks.push(pyOut[index].ok === jsOut[index].ok);
    });
    return { ok: checks.every(Boolean), actual: { py: pyOut, js: jsOut } };
  },

  sanctions_sources(testCase) {
    const python = findPython();
    const dir = mkdtempSync(join(tmpdir(), 'buyer-check-sanctions-sources-'));
    writeFileSync(join(dir, 'ofac_sdn.csv'), testCase.input.csv || '', 'utf8');
    const [pyCmd, ...pyRest] = (python || '').split(' ');
    const run = (cmd, rest, script, query) => {
      const result = spawnSync(cmd, [...rest, script, '--no-update', '--cache-dir', dir, '--', query], { encoding: 'utf8', timeout: 30000 });
      return result.stdout ? JSON.parse(result.stdout) : null;
    };
    const jsScript = join(ROOT, 'scripts', 'sanctions_check.mjs');
    const outcomes = (testCase.input.queries || []).map((entry) => {
      const py = python ? run(pyCmd, pyRest, join(ROOT, 'scripts', 'sanctions_check.py'), entry.query) : null;
      const js = existsSync(jsScript) ? run('node', [], jsScript, entry.query) : null;
      const checks = [Boolean(py)];
      if (py) {
        checks.push(py.status === 'ok');
        checks.push((py.lists_not_configured || []).includes('EU Consolidated'));
        checks.push((py.lists_not_configured || []).includes('UN Security Council'));
        checks.push(!(py.lists_not_configured || []).includes('UK Sanctions List'));
        checks.push((py.sources || []).find((item) => item.list === 'OFAC SDN')?.status === 'configured');
        checks.push(py.match_count === entry.match_count);
        checks.push(py.requires_manual_review === true);
      }
      if (py && js) checks.push(isDeepStrictEqual(py, js));
      return { query: entry.query, ok: checks.every(Boolean), match_count: py?.match_count, not_configured: py?.lists_not_configured };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  render_card_boundary(testCase) {
    const rules = loadRules();
    const outcomes = (testCase.input.cases || []).map((entry) => {
      const evidence = cloneJson(entry.evidence);
      const result = renderCard ? renderCard(evidence, rules) : pyRenderEvidence(findPython(), evidence);
      const expect = entry.expect || {};
      const checks = [result.status === 'ok'];
      if (expect.credit !== undefined) checks.push(result.credit?.score === expect.credit);
      if (expect.credit_tier !== undefined) checks.push(result.credit?.tier === expect.credit_tier);
      for (const [key, expected] of Object.entries(expect.dimensions || {})) {
        const dim = (result.dimensions || []).find((item) => item.key === key);
        checks.push(Boolean(dim) && dim.status === expected.status && dim.symbol === expected.symbol && dim.bar === expected.bar);
      }
      return { name: entry.name, ok: checks.every(Boolean), credit: result.credit, dims: result.dimensions };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  render_card_validation(testCase) {
    const rules = loadRules();
    const base = testCase.input.fixture_data ? cloneJson(testCase.input.fixture_data) : loadFixture(testCase.input.fixture);
    const outcomes = (testCase.input.cases || []).map((entry) => {
      const evidence = cloneJson(base);
      for (const mutation of entry.mutate || []) setByPath(evidence.display, mutation.path, cloneJson(mutation.value));
      const result = renderCard ? renderCard(evidence, rules) : pyRenderEvidence(findPython(), evidence);
      const codes = (result.errors || []).map((error) => error.code);
      return {
        name: entry.name,
        ok: result.status === 'invalid-display' && codes.includes(entry.expect_code),
        status: result.status,
        codes,
      };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  render_card_ladder(testCase) {
    const python = findPython();
    const combos = ladderCombinations ? ladderCombinations() : (python ? runPythonRender(python, ['--ladder']).combos : []);
    const expect = testCase.expect || {};
    const checks = [combos.length === expect.combos];
    let violations = 0;
    for (const combo of combos) {
      const [reply, sample, custom, payment] = combo.actions;
      const input = combo.input;
      const statuses = combo.actions.map((action) => action.status);
      if (statuses.some((status) => !['✅', '⚠️', '⛔'].includes(status))) violations += 1;
      if (input.level === '高') {
        if (!(reply.status === '⚠️' && sample.status === '⛔' && custom.status === '⛔' && payment.status === '⛔')) violations += 1;
      }
      if (input.pay_flag && payment.status !== '⛔') violations += 1;
      if (input.level === '低' && input.credit_tier === '高' && !input.company_low && !input.pay_flag && input.compliance_checked && input.open_questions.length === 0) {
        if (!(sample.status === '✅' && custom.status === '✅')) violations += 1;
      }
      if (input.level === '低' && input.credit_tier === '高' && !input.company_low && !input.pay_flag && input.compliance_checked && input.open_questions.length > 0) {
        if (custom.status !== '⚠️') violations += 1;
      }
      if (input.company_low && (custom.status !== '⛔' || sample.status === '✅')) violations += 1;
      if (input.level === '需人工核实' && (custom.status !== '⛔' || sample.status !== '⚠️')) violations += 1;
      if (input.stage === 'pre-order' && input.account_verified && !input.pay_flag && input.level !== '高') {
        if (payment.status !== '✅') violations += 1;
      }
      if (input.stage === 'inquiry' && payment.status === '✅') violations += 1;

      if (testCase.input.mode === 'conclusion') {
        const expected = input.level === '高'
          ? '先不要投入：不寄样、不垫付、不付款。'
          : sample.status === '✅' && custom.status === '✅'
            ? '可以正常推进，收款前先做订单前复核。'
            : sample.status === '✅' && custom.status === '⚠️'
              ? '可以报价、寄样；定制或大额备货前，先'
              : sample.status === '⚠️'
                ? '可以先报价；投入前先'
                : '信息还不足：先报标准价，不要投入。最值钱的补充：';
        const matches = sample.status === '✅' && custom.status === '⚠️' || sample.status === '⚠️'
          ? combo.conclusion.startsWith(expected)
          : combo.conclusion === expected;
        if (!matches) violations += 1;
      }
    }
    checks.push(violations === 0);


    if (python) {
      const py = runPythonRender(python, ['--ladder']);
      checks.push(isDeepStrictEqual(py.combos, combos));
    } else {
      checks.push(false);
    }
    return { ok: checks.every(Boolean), actual: { combos: combos.length, violations, python: Boolean(python) } };
  },

  render_card_lines(testCase) {
    const rules = loadRules();
    const entries = testCase.input.fixtures_data || (testCase.input.fixtures || []).map((name) => ({ name }));
    const outcomes = entries.map((entry) => {
      const evidence = entry.data ? cloneJson(entry.data) : loadFixture(entry.name);
      const result = renderCard ? renderCard(evidence, rules) : pyRenderEvidence(findPython(), evidence);
      return {
        fixture: entry.name,
        ok: result.status === 'ok' && result.line_count <= testCase.expect.max_lines && result.first_screen_lines <= testCase.expect.max_first_screen,
        line_count: result.line_count,
        first_screen_lines: result.first_screen_lines,
      };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  phone_variants(testCase) {
    if (!existsSync(join(ROOT, 'scripts', 'phone_check.mjs'))) {
      return { skipped: true, actual: 'node phone_check not shipped' };
    }
    const python = findPython();
    if (!python) return { skipped: true, actual: 'python not found' };
    const [pyCmd, ...pyRest] = python.split(' ');
    const outcomes = (testCase.input.cases || []).map((entry) => {
      const args = [entry.number];
      if (entry.country) args.push('--country', entry.country);
      const pyRun = spawnSync(pyCmd, [...pyRest, join(ROOT, 'scripts', 'phone_check.py'), ...args], { encoding: 'utf8', timeout: 30000 });
      const jsRun = spawnSync('node', [join(ROOT, 'scripts', 'phone_check.mjs'), ...args], { encoding: 'utf8', timeout: 30000 });
      let py = null;
      let js = null;
      try { py = JSON.parse(pyRun.stdout); } catch { py = null; }
      try { js = JSON.parse(jsRun.stdout); } catch { js = null; }
      const expect = entry.expect || {};
      const variants = Array.isArray(py?.search_variants) ? py.search_variants : [];
      const stripOptional = (value) => {
        if (!value || typeof value !== 'object') return value;
        const copy = { ...value };
        for (const key of ['number_type', 'carrier', 'carrier_note', 'timezones', 'enriched_by']) delete copy[key];
        return copy;
      };
      const checks = [Boolean(py && py.status === 'ok'), isDeepStrictEqual(stripOptional(py), stripOptional(js))];
      for (const needle of expect.variants_include || []) checks.push(variants.includes(needle));
      if (expect.variants_count_max !== undefined) checks.push(variants.length <= expect.variants_count_max);
      if (expect.variants_unique) checks.push(new Set(variants).size === variants.length);
      if (expect.variants_empty) checks.push(variants.length === 0);
      if (expect.all_variants_min_length !== undefined) checks.push(variants.every((item) => item.length >= expect.all_variants_min_length));
      if (expect.landline_hint !== undefined) checks.push((py?.landline_hint ?? null) === expect.landline_hint);
      if (expect.legacy_keys) checks.push(expect.legacy_keys.every((key) => key in (py || {})));
      return { name: entry.name, ok: checks.every(Boolean), variants, py, js };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  phone_privacy(testCase) {
    const rules = loadRules();
    const python = findPython();
    const evidence = testCase.input.fixture_data ? cloneJson(testCase.input.fixture_data) : loadFixture(testCase.input.fixture);
    evidence.intake = evidence.intake && typeof evidence.intake === 'object' ? evidence.intake : {};
    const variants = testCase.input.variants || [];
    evidence.intake.phone = testCase.input.number || evidence.intake.phone;
    const result = renderCard ? renderCard(evidence, rules) : pyRenderEvidence(python, evidence);
    const card = String(result.card || '');
    const digits = String(testCase.input.number || '').replace(/\D/g, '');
    const checks = [result.status === 'ok', digits.length >= 7 && !card.includes(digits)];
    for (const variant of variants) checks.push(!card.includes(variant));
    const docs = ['SKILL.md', 'card_template.md', 'data-sources/global.md']
      .filter((file) => existsSync(join(ROOT, file)))
      .map((file) => readFileSync(join(ROOT, file), 'utf8'))
      .join('\n');
    checks.push(docs.includes('search_variants'));
    checks.push(docs.includes('不进卡片'));
    return { ok: checks.every(Boolean), actual: { status: result.status, digits, card_sample: card.slice(0, 200) } };
  },

  messenger_table(testCase) {
    const file = testCase.input.file || 'data-sources/global.md';
    if (!existsSync(join(ROOT, file))) return { skipped: true, actual: `${file} not shipped in lean bundle` };
    const text = readFileSync(join(ROOT, file), 'utf8');
    const names = testCase.input.names || ['Viber', 'Telegram', 'Zalo', 'Line', 'KakaoTalk', '微信'];
    const marker = text.indexOf('即时通讯地区表');
    const section = marker >= 0 ? text.slice(marker) : text;
    const rows = [];
    for (const line of section.split(/\r?\n/)) {
      if (!line.trim().startsWith('|')) {
        if (rows.length > 0) break;
        continue;
      }
      if (names.some((name) => line.includes(name))) rows.push(line);
    }
    const bad = rows.filter((line) => !line.includes('待核实') && !line.includes('依据'));
    return { ok: rows.length >= names.length && bad.length === 0, actual: { rows: rows.length, bad } };
  },

  sanctions_csv(testCase) {
    if (!existsSync(join(ROOT, 'scripts', 'sanctions_check.mjs'))) {
      return { skipped: true, actual: 'node sanctions script not shipped' };
    }
    const python = findPython();
    if (!python) return { skipped: true, actual: 'python not found' };
    const [pyCmd, ...pyRest] = python.split(' ');
    const dir = mkdtempSync(join(tmpdir(), 'buyer-check-csv-'));
    const file = join(dir, 'list.csv');
    writeFileSync(file, testCase.input.csv || '', 'utf8');
    const mode = testCase.input.mode || 'uk';
    const nameColumn = testCase.input.name_column ?? 0;
    const pyCode = [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})`,
      'import sanctions_check',
      `path = ${JSON.stringify(file)}`,
      `rows = sanctions_check.load_uk_entries(path) if ${JSON.stringify(mode)} == 'uk' else sanctions_check.load_entries(path, ${nameColumn})`,
      "print(json.dumps({'count': len(rows), 'names': [row.get('name') or row.get('raw') for row in rows]}, ensure_ascii=False))",
    ].join('\n');
    const pyRun = spawnSync(pyCmd, [...pyRest, '-c', pyCode], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    const jsCode = [
      `import { loadUkEntries, loadEntries } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts', 'sanctions_check.mjs')).href)};`,
      `const rows = ${JSON.stringify(mode)} === 'uk' ? loadUkEntries(${JSON.stringify(file)}) : loadEntries(${JSON.stringify(file)}, ${nameColumn});`,
      "console.log(JSON.stringify({ count: rows.length, names: rows.map((row) => row.name ?? row.raw) }));",
    ].join('\n');
    const jsRun = spawnSync('node', ['--input-type=module', '-e', jsCode], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    let py = null;
    let js = null;
    try { py = JSON.parse(pyRun.stdout); } catch { py = null; }
    try { js = JSON.parse(jsRun.stdout); } catch { js = null; }
    const expect = testCase.expect || {};
    const checks = [Boolean(py), Boolean(js), isDeepStrictEqual(py, js)];
    if (expect.count !== undefined) checks.push(py?.count === expect.count);
    if (expect.names !== undefined) checks.push(isDeepStrictEqual(py?.names, expect.names));
    return { ok: checks.every(Boolean), actual: { py, js } };
  },

  sanctions_deterministic(testCase) {
    const python = findPython();
    if (!python) return { skipped: true, actual: 'python not found' };
    const [pyCmd, ...pyRest] = python.split(' ');
    const dir = mkdtempSync(join(tmpdir(), 'buyer-check-sanctions-deterministic-'));
    const withIndex = join(dir, 'with-index');
    const withoutIndex = join(dir, 'without-index');
    mkdirSync(withIndex, { recursive: true });
    mkdirSync(withoutIndex, { recursive: true });
    for (const path of [withIndex, withoutIndex]) writeFileSync(join(path, 'ofac_sdn.csv'), testCase.input.csv || '', 'utf8');
    writeFileSync(join(withIndex, 'ofac_sdn.idx'), '', 'utf8');
    const script = join(ROOT, 'scripts', 'sanctions_check.py');
    const run = (cache, name) => {
      const result = spawnSync(pyCmd, [...pyRest, script, name, '--no-update', '--cache-dir', cache], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      try { return JSON.parse(result.stdout); } catch { return null; }
    };
    const fields = ['status', 'match_count', 'requires_manual_review'];
    const pick = (value) => Object.fromEntries(fields.map((key) => [key, value?.[key] ?? null]));
    const a = pick(run(withoutIndex, testCase.input.name || 'GLOBAL STAR TRADING CO'));
    const b = pick(run(withIndex, testCase.input.name || 'GLOBAL STAR TRADING CO'));
    const checks = [a.status === 'ok', isDeepStrictEqual(a, b), a.match_count === (testCase.expect?.match_count ?? a.match_count)];
    return { ok: checks.every(Boolean), actual: { withoutIndex: a, withIndex: b } };
  },

  sources_table(testCase) {
    const file = testCase.input.file || 'data-sources/global.md';
    if (!existsSync(join(ROOT, file))) return { skipped: true, actual: `${file} not shipped in lean bundle` };
    const text = readFileSync(join(ROOT, file), 'utf8');
    const marker = text.indexOf('第十五节');
    const section = marker >= 0 ? text.slice(marker) : text;
    const lines = section.split(/\r?\n/).filter((line) => line.trim().startsWith('|'));
    const headerIndex = lines.findIndex((line) => line.includes('terms_checked') && line.includes('verified_at'));
    const header = headerIndex >= 0 ? lines[headerIndex] : '';
    const dataRows = headerIndex >= 0 ? lines.slice(headerIndex + 1).filter((line) => !/^\|\s*-/.test(line.trim())) : [];
    const bad = dataRows.filter((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      return cells.length < 8 || !cells[5] || !cells[6];
    });
    return {
      ok: Boolean(header) && dataRows.length >= 6 && bad.length === 0,
      actual: { header, data_rows: dataRows.length, bad },
    };
  },

  check_sources_offline(testCase) {
    if (!existsSync(join(ROOT, 'scripts', 'check_sources.mjs'))) {
      return { skipped: true, actual: 'check_sources not shipped in lean bundle' };
    }
    const dir = mkdtempSync(join(tmpdir(), 'buyer-check-sources-'));
    const config = join(dir, 'sources.json');
    writeFileSync(config, JSON.stringify({ sources: [] }), 'utf8');
    const run = spawnSync('node', [join(ROOT, 'scripts', 'check_sources.mjs'), '--config', config], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    let result = null;
    try { result = JSON.parse(run.stdout); } catch { result = null; }
    const checks = [run.status === 0, result !== null, result?.status === 'ok'];
    return { ok: checks.every(Boolean), actual: { exit: run.status, result } };
  },

  safe_fetch(testCase) {
    const python = findPython();
    const outcomes = (testCase.input.cases || []).map((entry) => {
      let run;
      if (entry.runtime === 'python') {
        if (!python) return { name: entry.name, ok: false, result: null, error: 'python not found' };
        const [cmd, ...rest] = python.split(' ');
        run = spawnSync(cmd, [...rest, '-c', entry.code], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
      } else {
        if (!existsSync(join(ROOT, 'scripts', 'identity_check.mjs'))) {
          return { name: entry.name, ok: true, skipped: true, result: null, error: 'node identity_check not shipped' };
        }
        run = spawnSync('node', ['--input-type=module', '-e', entry.code], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
      }
      let result = null;
      try { result = JSON.parse(run.stdout); } catch { result = null; }
      const expect = entry.expect || {};
      const checks = [result !== null];
      if (expect.status !== undefined) checks.push(result?.status === expect.status);
      if (expect.reason !== undefined) checks.push(result?.reason === expect.reason);
      if (expect.calls !== undefined) checks.push(result?.calls === expect.calls);
      if (expect.bytes_lt_total) checks.push(result?.bytes_read < expect.bytes_lt_total);
      if (expect.expect_ok) checks.push(result?.status === 'ok');
      return { name: entry.name, ok: checks.every(Boolean), result, stderr: String(run.stderr || '').slice(-300) };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  false_positive(testCase) {
    if (!existsSync(join(ROOT, 'tests', 'false_positive_measure.mjs'))) {
      return { skipped: true, actual: 'false-positive script not shipped' };
    }
    const run = spawnSync('node', [join(ROOT, 'tests', 'false_positive_measure.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    let result = null;
    try { result = JSON.parse(run.stdout); } catch { result = null; }
    const checks = [run.status === 0, result !== null, ['ok', 'skipped'].includes(result?.status)];
    if (result?.status === 'ok') {
      checks.push(typeof result.query_count === 'number', typeof result.false_hit_count === 'number', Array.isArray(result.false_hits));
    }
    return { ok: checks.every(Boolean), actual: result };
  },

  question_bank(testCase) {
    const text = readFileSync(join(ROOT, 'report_template.md'), 'utf8');
    const start = text.indexOf('<!-- question-bank:start -->');
    const end = text.indexOf('<!-- question-bank:end -->');
    const block = start >= 0 && end > start ? text.slice(start, end) : '';
    const rows = block.split(/\r?\n/).filter((line) => /^\|\s*Q-\d{2}/.test(line.trim()));
    const banned = ['verify', 'investigat', 'background check', 'scam', 'fraud', '核实身份', '调查'];
    const countryData = /(\b\d{2,3}\s*V\b|\b\d{2,3}\s*Hz\b|\bRoHS\b|\bUL\b|\bCCC\b)/;
    const checks = [rows.length >= 9];
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim());
      checks.push(cells.length >= 6 && cells[2].length > 0 && cells[3].length > 0 && cells[4].length > 0);
      const lower = row.toLowerCase();
      for (const word of banned) checks.push(!lower.includes(word));
      checks.push(!countryData.test(row));
    }
    return { ok: checks.every(Boolean), actual: { rows: rows.length, banned, block_length: block.length } };
  },

  follow_up_invariance(testCase) {
    const rules = loadRules();
    const python = findPython();
    const base = testCase.input.fixture_data ? cloneJson(testCase.input.fixture_data) : loadFixture(testCase.input.fixture);
    const render = (evidence) => (renderCard ? renderCard(evidence, rules) : pyRenderEvidence(python, evidence));
    const signalsPool = [
      [],
      ['offers_seo_web_marketing'],
      ['states_end_use_project', 'names_product_model'],
      ['mentions_resale_or_distribution', 'names_product_model'],
      ['contains_login_or_download_link'],
      ['student_or_research_purpose'],
    ];
    const flagsPool = [[], ['RF-CORP-005'], ['RF-DOM-002', 'RF-CORP-005'], ['RF-PAY-001'], ['RF-DOM-001']];
    const identityPool = [
      null,
      { candidates: [{ name: 'Ana Example', country: 'BR', registry_id: 'X1', strength: 'strong', match_keys: ['legal_name', 'domain'] }] },
      { candidates: [
        { name: 'Ana Example', country: 'BR', registry_id: 'X1', strength: 'strong', match_keys: ['legal_name', 'domain'] },
        { name: 'Ana Example', country: 'AR', registry_id: 'X2', strength: 'strong', match_keys: ['legal_name', 'domain'] },
      ] },
    ];
    const anchorsPool = [{ count: 3 }, { count: 1 }];
    const runs = testCase.input.runs || 200;
    let failures = 0;
    const samples = [];
    for (let index = 0; index < runs; index += 1) {
      const withSignals = cloneJson(base);
      withSignals.intake = withSignals.intake && typeof withSignals.intake === 'object' ? withSignals.intake : {};
      withSignals.intake.lead_signals = cloneJson(signalsPool[index % signalsPool.length]);
      withSignals.flags = cloneJson(flagsPool[index % flagsPool.length]);
      withSignals.anchors = cloneJson(anchorsPool[index % anchorsPool.length]);
      const identity = identityPool[index % identityPool.length];
      if (identity) withSignals.identity = cloneJson(identity);
      const withoutSignals = cloneJson(withSignals);
      delete withoutSignals.intake.lead_signals;
      delete withoutSignals.identity;
      const a = render(withSignals);
      const b = render(withoutSignals);
      const ok = a.status === 'ok' && b.status === 'ok'
        && a.risk_score === b.risk_score && a.level === b.level && a.confidence === b.confidence
        && a.credit?.score === b.credit?.score && a.credit?.tier === b.credit?.tier;
      if (!ok) failures += 1;
      if (index < 3) samples.push({ index, with: { risk_score: a.risk_score, level: a.level, confidence: a.confidence, credit: a.credit }, without: { risk_score: b.risk_score, level: b.level, confidence: b.confidence, credit: b.credit } });
    }
    return { ok: failures === 0 && runs === 200, actual: { runs, failures, samples } };
  },

  hub_regression(testCase) {
    if (!existsSync(FIXTURES_DIR) && !existsSync(CASES_DIR)) {
      return { skipped: true, actual: 'fixtures not shipped in lean bundle' };
    }
    const rules = loadRules();
    const python = findPython();
    const render = (evidence) => (renderCard ? renderCard(evidence, rules) : pyRenderEvidence(python, evidence));
    const packs = [];
    for (const name of readdirSync(FIXTURES_DIR).filter((item) => item.endsWith('.json')).sort()) {
      try {
        const data = JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
        if (JSON.stringify(data).includes('RF-CORP-005')) packs.push({ name, data });
      } catch {
        // ignore non-JSON fixtures
      }
    }
    if (existsSync(CASES_DIR)) {
      for (const name of readdirSync(CASES_DIR).filter((item) => item.endsWith('.json')).sort()) {
        try {
          const data = JSON.parse(readFileSync(join(CASES_DIR, name), 'utf8'));
          if (data.input?.fixture_data && JSON.stringify(data.input.fixture_data).includes('RF-CORP-005')) {
            packs.push({ name: `${name}#fixture_data`, data: data.input.fixture_data });
          }
        } catch {
          // ignore malformed case files
        }
      }
    }
    const outcomes = packs.map((item) => {
      const result = render(cloneJson(item.data));
      return {
        name: item.name,
        status: result.status,
        risk_score: result.risk_score,
        hub_exception: result.computed?.hub_exception ?? null,
        phone_country: (item.data.intake || {}).phone_country ?? null,
      };
    });
    const changed = outcomes.filter((item) => item.status !== 'ok' || item.hub_exception !== null);
    return { ok: changed.length === 0, actual: { scanned: packs.length, changed, outcomes } };
  },

  render_card_deterministic(testCase) {
    const runs = testCase.input.runs || 100;
    const python = findPython();
    const evidence = testCase.input.fixture_data ? cloneJson(testCase.input.fixture_data) : loadFixture(testCase.input.fixture);
    if (!renderCard) {
      if (!python) return { ok: false, actual: { runs, identical: false, parity: false, mode: 'python-missing' } };
      const dir = mkdtempSync(join(tmpdir(), 'buyer-check-card-'));
      const path = join(dir, 'evidence.json');
      writeFileSync(path, JSON.stringify(evidence), 'utf8');
      const code = [
        'import sys, json',
        `sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})`,
        'import render_card',
        `with open(${JSON.stringify(path)}, encoding='utf-8') as handle: evidence = json.load(handle)`,
        'rules = render_card.load_rules()',
        `cards = [render_card.render_card(json.loads(json.dumps(evidence)), rules)['card'] for _ in range(${runs})]`,
        "print(json.dumps({'identical': len(set(cards)) == 1}, ensure_ascii=False))",
      ].join('\n');
      const [cmd, ...rest] = python.split(' ');
      const result = spawnSync(cmd, [...rest, '-c', code], { encoding: 'utf8', timeout: 120000 });
      const identical = result.stdout ? JSON.parse(result.stdout).identical : false;
      return { ok: identical && runs === testCase.expect.runs, actual: { runs, identical, parity: true, mode: 'python' } };
    }
    const rules = loadRules();
    let first = null;
    let identical = true;
    for (let i = 0; i < runs; i += 1) {
      const card = renderCard(cloneJson(evidence), rules).card;
      if (first === null) first = card;
      else if (card !== first) identical = false;
    }
    let parity = false;
    if (python) {
      const result = pyRenderEvidence(python, evidence);
      parity = result.status === 'ok' && result.card === first;
    }
    return {
      ok: identical && parity && runs === testCase.expect.runs,
      actual: { runs, identical, parity },
    };
  },

  registry(testCase) {
    const python = findPython();
    if (!python) return { skipped: true, actual: 'python not found' };
    const pyScript = join(ROOT, 'scripts', 'identity_check.py');
    const jsScript = join(ROOT, 'scripts', 'identity_check.mjs');
    const hasNode = existsSync(jsScript);
    const [pyCmd, ...pyRest] = python.split(' ');
    const banned = ['dagligLeder', 'styre', 'aksjonærer', 'aksjonær', 'personnavn', 'fodselsdato', 'foedselsdato', 'rolle'];
    const outcomes = (testCase.input.cases || []).map((entry) => {
      const dir = mkdtempSync(join(tmpdir(), 'buyer-check-registry-'));
      const args = ['registry', '--company', entry.company, '--country', entry.country || 'NO'];
      if (entry.claimed_country) args.push('--claimed-country', entry.claimed_country);
      if (entry.fixture_data) {
        const fixture = join(dir, 'fixture.json');
        writeFileSync(fixture, JSON.stringify(entry.fixture_data), 'utf8');
        args.push('--fixture-json', fixture);
      } else if (entry.online) {
        args.push('--online');
      }
      const pyRun = spawnSync(pyCmd, [...pyRest, pyScript, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      if (!pyRun.stdout) throw new Error(pyRun.stderr || 'no python output');
      const py = JSON.parse(pyRun.stdout);
      let js = null;
      if (hasNode) {
        const jsRun = spawnSync('node', [jsScript, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
        if (!jsRun.stdout) throw new Error(jsRun.stderr || 'no node output');
        js = JSON.parse(jsRun.stdout);
      }
      const expect = entry.expect || {};
      const checks = [];
      if (expect.status !== undefined) checks.push(py.status === expect.status);
      if (expect.country !== undefined) checks.push(py.country === expect.country);
      if (expect.legal_name !== undefined) checks.push(py.legal_name === expect.legal_name);
      if (expect.status_text !== undefined) checks.push(py.status_text === expect.status_text);
      if (expect.incorporation_date !== undefined) checks.push(py.incorporation_date === expect.incorporation_date);
      if (expect.address_country !== undefined) checks.push(py.address_country === expect.address_country);
      if (expect.country_mismatch !== undefined) checks.push(py.country_mismatch === expect.country_mismatch);
      if (expect.org_number !== undefined) checks.push(py.org_number === expect.org_number);
      if (expect.error !== undefined) checks.push(py.error === expect.error);
      if (expect.candidate_count !== undefined) checks.push((py.candidates || []).length === expect.candidate_count);
      if (expect.registry_url_contains !== undefined) checks.push(String(py.registry_url || '').includes(expect.registry_url_contains));
      const serialized = JSON.stringify(py);
      checks.push(!banned.some((key) => serialized.includes(key)));
      if (js) checks.push(isDeepStrictEqual(py, js));
      return { name: entry.name, ok: checks.every(Boolean), status: py.status, parity: js ? isDeepStrictEqual(py, js) : null };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  intake_format(testCase) {
    const allowed = new Set(['tender', 'sample', 'large_first_order', 'account_change', 'pre_order', 'general']);
    const phoneRe = /\+?\d[\d\s()\-]{8,}\d/;
    const emailRe = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;
    const outcomes = (testCase.input.packs || []).map((pack) => {
      const intake = pack.intake || {};
      const raw = JSON.stringify(intake);
      const cleaned = raw.replace(/[A-Za-z0-9._%+\-]*\*+[A-Za-z0-9._%+\-]*@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, '');
      const checks = [allowed.has(intake.inquiry_type), !phoneRe.test(raw), !emailRe.test(cleaned)];
      return { name: pack.name, ok: checks.every(Boolean), inquiry_type: intake.inquiry_type };
    });
    const types = outcomes.map((item) => item.inquiry_type);
    return {
      ok: outcomes.every((item) => item.ok) && isDeepStrictEqual(types, testCase.expect?.types || types),
      actual: outcomes,
    };
  },

  validation_doc(testCase) {
    const path = join(ROOT, testCase.input.path || 'docs/validation.md');
    if (!existsSync(path)) return { skipped: true, actual: 'docs/validation.md not shipped in lean bundle' };
    const text = readFileSync(path, 'utf8');
    const needles = ['验证范围', '虚构场景表', '已修复的误报', '已知局限', '复现命令', '5,833,851', '19,564', 'sanctionslistservice.ofac.treas.gov', 'privacy_scan'];
    const missing = needles.filter((needle) => !text.includes(needle));
    return { ok: missing.length === 0, actual: { missing } };
  },

async phone_pii(testCase) {
    const texts = testCase.input.texts || [];
    const expected = texts.map((item) => item.expect);
    const nodeResults = containsFullPhone ? texts.map((item) => containsFullPhone(item.text)) : null;
    const python = findPython();
    let pythonResults = null;
    if (python) {
      const [cmd, ...rest] = python.split(' ');
      const code = [
        'import sys, json',
        'from render_card import contains_full_phone',
        'texts = json.load(sys.stdin)',
        'print(json.dumps([contains_full_phone(t) for t in texts], ensure_ascii=False))',
      ].join('\n');
      const run = spawnSync(cmd, [...rest, '-c', code], { cwd: join(ROOT, 'scripts'), input: JSON.stringify(texts.map((item) => item.text)), encoding: 'utf8', timeout: 30000 });
      if (!run.stdout) throw new Error(run.stderr || 'python phone check failed');
      pythonResults = JSON.parse(run.stdout);
    }
    const matches = (results) => Array.isArray(results) && results.length === expected.length && results.every((value, index) => value === expected[index]);
    const checks = [matches(pythonResults)];
    if (containsFullPhone) checks.push(matches(nodeResults));
    return { ok: checks.every(Boolean), actual: { expected, node: nodeResults, python: pythonResults } };
  },

  country_capabilities(testCase) {
    const caps = JSON.parse(readFileSync(join(ROOT, 'scripts', 'country_capabilities.json'), 'utf8'));
    const allowedVerification = new Set(['official-page', 'secondary-source', 'unverified', 'discovered']);
    const allowedChecksums = new Set(['none', 'gstin-mod36', 'pan-structure']);
    const validate = (data) => {
      const errors = [];
      if (data.schema_version !== '0.6.0') errors.push('schema_version');
      if (!data.countries || typeof data.countries !== 'object') errors.push('countries');
      if (!Array.isArray(data.global_sources) || !['gleif-lei', 'worldbank-debarment', 'sanctions-lists'].every((item) => data.global_sources.includes(item))) errors.push('global_sources');
      for (const [code, country] of Object.entries(data.countries || {})) {
        if (typeof country.name !== 'undefined' && typeof country.name !== 'string') errors.push(`${code}.name`);
        if (typeof country.sources !== 'undefined' && !Array.isArray(country.sources)) errors.push(`${code}.sources`);
        if (!allowedVerification.has(country.verification)) errors.push(`${code}.verification`);
        if (!country.registry || typeof country.registry !== 'object') errors.push(`${code}.registry`);
        for (const key of ['registry', 'tax_verification', 'procurement', 'insolvency']) {
          if (country[key] === undefined) continue;
          if (!country[key] || typeof country[key] !== 'object') errors.push(`${code}.${key}`);
          else if (country[key].verification !== undefined && !allowedVerification.has(country[key].verification)) errors.push(`${code}.${key}.verification`);
        }
        const registry = country.registry || {};
        if (registry.automation_allowed === true && (registry.verification || country.verification) !== 'official-page') errors.push(`${code}.automation`);
        if (country.discovery !== undefined && typeof country.discovery !== 'boolean') errors.push(`${code}.discovery`);
        for (const format of country.id_formats || []) {
          if (!format.id_type || !format.label || !Number.isInteger(format.length)) errors.push(`${code}.id_formats.fields`);
          try { new RegExp(format.regex); } catch { errors.push(`${code}.id_formats.regex`); }
          if (!allowedChecksums.has(format.checksum || 'none')) errors.push(`${code}.id_formats.checksum`);
          if (format.verification !== undefined && !allowedVerification.has(format.verification)) errors.push(`${code}.id_formats.verification`);
        }
      }
      return errors;
    };
    const errors = validate(caps);
    const bad = cloneJson(caps);
    bad.countries.__bad = { verification: 'made-up' };
    const badCaught = validate(bad).length > 0;
    const badRegex = cloneJson(caps);
    const firstFormat = badRegex.countries.in && badRegex.countries.in.id_formats && badRegex.countries.in.id_formats[0];
    if (firstFormat) firstFormat.regex = '([';
    const badRegexCaught = validate(badRegex).length > 0;
    const python = findPython();
    const [pyCmd, ...pyRest] = (python || '').split(' ');
    const cli = (code) => {
      const py = spawnSync(pyCmd, [...pyRest, join(ROOT, 'scripts', 'identity_check.py'), 'country', '--code', code], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      const out = { python: py.stdout ? JSON.parse(py.stdout) : null };
      const jsScript = join(ROOT, 'scripts', 'identity_check.mjs');
      if (existsSync(jsScript)) {
        const js = spawnSync('node', [jsScript, 'country', '--code', code], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
        out.node = js.stdout ? JSON.parse(js.stdout) : null;
        if (out.python && out.node) out.parity = isDeepStrictEqual(out.python, out.node);
      }
      return out;
    };
    const inResult = cli('IN');
    const unknownResult = cli('ZZ');
    const validateCli = () => {
      const py = spawnSync(pyCmd, [...pyRest, join(ROOT, 'scripts', 'identity_check.py'), 'country', '--validate'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      const out = { python: py.stdout ? JSON.parse(py.stdout) : null };
      const jsScript = join(ROOT, 'scripts', 'identity_check.mjs');
      if (existsSync(jsScript)) {
        const js = spawnSync('node', [jsScript, 'country', '--validate'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
        out.node = js.stdout ? JSON.parse(js.stdout) : null;
        if (out.python && out.node) out.parity = isDeepStrictEqual(out.python, out.node);
      }
      return out;
    };
    const validateResult = validateCli();
    const ok = errors.length === 0
      && badCaught
      && badRegexCaught
      && inResult.python?.status === 'ok'
      && unknownResult.python?.status === 'not-in-matrix'
      && inResult.parity !== false
      && unknownResult.parity !== false
      && validateResult.python?.status === 'ok'
      && (validateResult.python?.errors || []).length === 0
      && validateResult.parity !== false;
    return { ok, actual: { errors, badCaught, badRegexCaught, in: inResult, unknown: unknownResult, validate: validateResult } };
  },

  country_consistency(testCase) {
    const base = cloneJson(testCase.input.fixture_data || loadFixture(testCase.input.fixture));
    const results = ['IN', 'SG', 'ZZ'].map((code) => {
      const evidence = cloneJson(base);
      evidence.subject = { ...(evidence.subject || {}), country: code };
      const result = renderCard ? renderCard(evidence, loadRules()) : pyRenderEvidence(findPython(), evidence);
      return { code, risk_score: result.risk_score, level: result.level, actions: result.actions };
    });
    const first = results[0];
    const ok = results.every((item) => item.risk_score === first.risk_score && item.level === first.level && isDeepStrictEqual(item.actions, first.actions));
    return { ok, actual: results };
  },

  doc_contains(testCase) {
    const files = testCase.input.files || [];
    const missingFile = files.find((file) => !existsSync(join(ROOT, file)));
    if (missingFile) return { skipped: true, actual: `${missingFile} not shipped in lean bundle` };
    const combined = files.map((file) => readFileSync(join(ROOT, file), 'utf8')).join('\n');
    const missing = (testCase.input.needles || []).filter((needle) => !combined.includes(needle));
    return { ok: missing.length === 0, actual: { missing } };
  },

  idcheck(testCase) {
    const python = findPython();
    const [pyCmd, ...pyRest] = (python || '').split(' ');
    const calls = [];
    const runOne = (country, type, value, company, claimedState) => {
      const args = ['idcheck', '--country', country, '--type', type, '--value', value];
      if (company) args.push('--company-name', company);
      if (claimedState) args.push('--claimed-state', claimedState);
      const py = spawnSync(pyCmd, [...pyRest, join(ROOT, 'scripts', 'identity_check.py'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      const jsScript = join(ROOT, 'scripts', 'identity_check.mjs');
      const js = existsSync(jsScript) ? spawnSync('node', [jsScript, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 }) : null;
      return { py: py.stdout ? JSON.parse(py.stdout) : null, js: js && js.stdout ? JSON.parse(js.stdout) : null };
    };
    const checkResult = (result, expect) => {
      if (!result) return false;
      if (expect.status && result.status !== expect.status) return false;
      if (expect.format_ok !== undefined && result.format_ok !== expect.format_ok) return false;
      if (expect.checksum_ok !== undefined && result.checksum_ok !== expect.checksum_ok) return false;
      if (expect.entity_type && result.entity_type !== expect.entity_type) return false;
      if (expect.name_suffix_consistent !== undefined && result.name_suffix_consistent !== expect.name_suffix_consistent) return false;
      for (const note of expect.notes_include || []) if (!(result.notes || []).includes(note)) return false;
      if (expect.masked_prefix && !String(result.masked || '').startsWith(expect.masked_prefix)) return false;
      return true;
    };
    if (testCase.input.type === 'gstin_matrix') {
      const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const check = (base) => {
        let total = 0;
        for (let i = 0; i < 14; i += 1) {
          const value = chars.indexOf(base[i]);
          const product = value * (i % 2 === 0 ? 1 : 2);
          total += Math.floor(product / 36) + (product % 36);
        }
        return chars[(36 - (total % 36)) % 36];
      };
      for (const base of testCase.input.bases || []) {
        const good = base + check(base);
        const bad = base + (check(base) === '0' ? '1' : '0');
        const valid = runOne('IN', 'gstin', good, 'Acme Pvt Ltd', null);
        const invalid = runOne('IN', 'gstin', bad, 'Acme Pvt Ltd', null);
        calls.push({ name: `valid-${good}`, ok: checkResult(valid.py, { status: 'ok', format_ok: true, checksum_ok: true }) && (!valid.js || checkResult(valid.js, { status: 'ok', format_ok: true, checksum_ok: true })) });
        calls.push({ name: `invalid-${bad}`, ok: checkResult(invalid.py, { status: 'ok', format_ok: true, checksum_ok: false }) && (!invalid.js || checkResult(invalid.js, { status: 'ok', format_ok: true, checksum_ok: false })) });
      }
    } else {
      for (const item of testCase.input.cases || []) {
        const result = runOne(item.country, item.type, item.value, item.company, item.claimed_state);
        const ok = checkResult(result.py, item.expect || {}) && (!result.js || checkResult(result.js, item.expect || {}));
        calls.push({ name: item.name, ok, py: result.py, js: result.js });
      }
    }
    return { ok: calls.every((item) => item.ok), actual: calls };
  },

  match(testCase) {
    const python = findPython();
    const [pyCmd, ...pyRest] = (python || '').split(' ');
    const jsScript = join(ROOT, 'scripts', 'identity_check.mjs');
    const outcomes = (testCase.input.cases || []).map((entry) => {
      const dir = mkdtempSync(join(tmpdir(), 'buyer-check-match-'));
      const buyer = join(dir, 'buyer.json');
      const candidate = join(dir, 'candidate.json');
      writeFileSync(buyer, JSON.stringify(entry.buyer), 'utf8');
      writeFileSync(candidate, JSON.stringify(entry.candidate), 'utf8');
      const args = ['match', '--buyer-json', buyer, '--candidate-json', candidate];
      const py = spawnSync(pyCmd, [...pyRest, join(ROOT, 'scripts', 'identity_check.py'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      const js = existsSync(jsScript) ? spawnSync('node', [jsScript, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 }) : null;
      const pyResult = py.stdout ? JSON.parse(py.stdout) : null;
      const jsResult = js && js.stdout ? JSON.parse(js.stdout) : null;
      const expect = entry.expect || {};
      const ok = pyResult && pyResult.status === 'ok'
        && pyResult.matched === expect.matched
        && (!expect.strength || pyResult.strength === expect.strength)
        && (!expect.keys || isDeepStrictEqual(pyResult.keys_matched, expect.keys))
        && (!jsResult || (jsResult.matched === pyResult.matched && isDeepStrictEqual(jsResult.keys_matched, pyResult.keys_matched) && jsResult.strength === pyResult.strength));
      return { name: entry.name, ok, py: pyResult, js: jsResult };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  flag_pack(testCase) {
    const rules = JSON.parse(readFileSync(join(ROOT, 'scripts', 'red_flags.json'), 'utf8'));
    const byId = new Map((rules.flags || []).map((flag) => [flag.id, flag]));
    const ids = testCase.input.ids || [];
    const weights = testCase.input.weights || [];
    const checks = [];
    checks.push(ids.length === 8);
    checks.push(new Set((rules.flags || []).map((flag) => flag.id)).size === (rules.flags || []).length);
    ids.forEach((id, index) => {
      const flag = byId.get(id);
      checks.push(Boolean(flag) && flag.weight === weights[index]);
      checks.push(Boolean(flag) && Boolean(flag.why) && Boolean(flag.benign) && Boolean(flag.flip_hint));
    });
    return { ok: checks.every(Boolean), actual: { total: (rules.flags || []).length, checks: checks.length } };
  },

  keywords(testCase) {
    const python = findPython();
    const [pyCmd, ...pyRest] = (python || '').split(' ');
    const jsScript = join(ROOT, 'scripts', 'identity_check.mjs');
    const outcomes = (testCase.input.cases || []).map((entry) => {
      const args = ['keywords', '--text', entry.text, '--languages', entry.languages];
      const py = spawnSync(pyCmd, [...pyRest, join(ROOT, 'scripts', 'identity_check.py'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      const js = existsSync(jsScript) ? spawnSync('node', [jsScript, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 }) : null;
      const pyResult = py.stdout ? JSON.parse(py.stdout) : null;
      const jsResult = js && js.stdout ? JSON.parse(js.stdout) : null;
      const probes = (pyResult?.matches || []).map((item) => item.probe);
      const ok = pyResult?.status === 'ok'
        && (entry.expect_probes || []).every((probe) => probes.includes(probe))
        && (entry.expect_empty ? probes.length === 0 : true)
        && (!jsResult || isDeepStrictEqual(jsResult.matches, pyResult.matches));
      return { name: entry.name, ok, py: pyResult, js: jsResult };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  docmeta(testCase) {
    const python = findPython();
    const [pyCmd, ...pyRest] = (python || '').split(' ');
    const outcomes = (testCase.input.cases || []).map((entry) => {
      const dir = mkdtempSync(join(tmpdir(), 'buyer-check-docmeta-'));
      const file = join(dir, `${entry.name}.pdf`);
      writeFileSync(file, entry.pdf, 'latin1');
      const args = ['docmeta', '--file', file];
      if (entry.claimed_date) args.push('--claimed-date', entry.claimed_date);
      const run = spawnSync(pyCmd, [...pyRest, join(ROOT, 'scripts', 'identity_check.py'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      const result = run.stdout ? JSON.parse(run.stdout) : null;
      const check = (result?.doc_checks || [])[0] || {};
      const expect = entry.expect || {};
      const ok = result?.status === 'ok'
        && (expect.creator_class === undefined || check.creator_class === expect.creator_class)
        && (expect.dates_consistent === undefined || check.dates_consistent === expect.dates_consistent)
        && (expect.incremental_updates === undefined || check.incremental_updates === expect.incremental_updates)
        && (expect.notes_include || []).every((note) => (check.notes || []).some((item) => item.includes(note)))
        && !JSON.stringify(result).toLowerCase().includes('author')
        && !JSON.stringify(result).includes('伪造')
        && !JSON.stringify(result).includes('假证书');
      return { name: entry.name, ok, result };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  trade_terms(testCase) {
    if (!tradeTerms) return { skipped: true, actual: 'Node render_card.mjs not shipped' };
    const levels = ['低', '中', '高', '需人工核实'];
    const tiers = ['高', '中', '低'];
    const types = ['tender', 'sample', 'large_first_order', 'account_change', 'pre_order', 'general'];
    const failures = [];
    for (const level of levels) {
      for (const tier of tiers) {
        for (const inquiryType of types) {
          const lines = tradeTerms(level, tier, inquiryType);
          const joined = lines.join(' ');
          if (!lines.length || lines.length > 2) failures.push(`${level}/${tier}/${inquiryType}:count`);

          if (level === '高' && (joined.includes('可以预付') || joined.includes('直接付款'))) failures.push(`${level}/${tier}/${inquiryType}:contradiction`);
        }
      }
    }
    const ladder = ladderCombinations ? ladderCombinations() : [];
    for (const combo of ladder) {
      const level = combo.input?.level;
      const tier = combo.input?.credit_tier;
      if (!level || !tier) { failures.push('ladder:missing-input'); continue; }
      const lines = tradeTerms(level, tier, 'general');
      const joined = lines.join(' ');
      if (!lines.length || lines.length > 2) failures.push(`ladder-${level}/${tier}:count`);
      if (level === '高' && (joined.includes('可以预付') || joined.includes('直接付款'))) failures.push(`ladder-${level}/${tier}:contradiction`);
    }
    return { ok: failures.length === 0, actual: { combos: levels.length * tiers.length * types.length, ladder: ladder.length, failures } };
  },

  payment_profile(testCase) {
    const python = findPython();
    const [pyCmd, ...pyRest] = (python || '').split(' ');
    const outcomes = (testCase.input.cases || []).map((entry) => {
      const dir = mkdtempSync(join(tmpdir(), 'buyer-check-payment-'));
      const file = join(dir, 'profile.json');
      writeFileSync(file, JSON.stringify(entry.profile), 'utf8');
      const args = ['--profile-json', file];
      if (entry.iban) args.push('--iban', entry.iban);
      if (entry.country) args.push('--country', entry.country);
      const run = spawnSync(pyCmd, [...pyRest, join(ROOT, 'scripts', 'account_check.py'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      const result = run.stdout ? JSON.parse(run.stdout) : null;
      const candidates = result?.flag_candidates || [];
      const hints = result?.payment_hints || [];
      const expect = entry.expect || {};
      const ok = result?.status === 'ok'
        && (expect.candidates || []).every((id) => candidates.includes(id))
        && (expect.hints || []).every((hint) => hints.includes(hint))
        && (expect.third_party === undefined || result.third_party_payee === expect.third_party);
      return { name: entry.name, ok, result };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  diff(testCase) {
    const python = findPython();
    const [pyCmd, ...pyRest] = (python || '').split(' ');
    const outcomes = (testCase.input.cases || []).map((entry) => {
      const dir = mkdtempSync(join(tmpdir(), 'buyer-check-diff-'));
      const packPath = (data, fallbackName, fileName) => {
        if (data) {
          const path = join(dir, fileName);
          writeFileSync(path, JSON.stringify(data), 'utf8');
          return path;
        }
        return fallbackName ? join(FIXTURES_DIR, fallbackName) : null;
      };
      const args = ['--diff'];
      const oldPath = packPath(entry.old_data, entry.old, 'old.json');
      if (oldPath) args.push(oldPath);
      args.push(packPath(entry.new_data, entry.new, 'new.json'), '--json');
      const hasNodeRenderer = existsSync(join(ROOT, 'scripts', 'render_card.mjs'));
      const pyRun = spawnSync(pyCmd, [...pyRest, join(ROOT, 'scripts', 'render_card.py'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      const jsRun = hasNodeRenderer ? spawnSync('node', [join(ROOT, 'scripts', 'render_card.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 }) : null;
      let py = null;
      let js = null;
      try { py = JSON.parse(pyRun.stdout); } catch { py = null; }
      if (jsRun) {
        try { js = JSON.parse(jsRun.stdout); } catch { js = null; }
      }
      const expect = entry.expect || {};
      const checks = [hasNodeRenderer ? isDeepStrictEqual(py, js) : true];
      if (expect.status !== undefined) checks.push(py?.status === expect.status);
      if (expect.risk) checks.push(isDeepStrictEqual(py?.risk, expect.risk));
      if (expect.verification) checks.push(isDeepStrictEqual(py?.verification, expect.verification));
      for (const key of ['added_flags', 'removed_flags', 'footprint_added', 'footprint_removed', 'incomplete_added', 'incomplete_removed', 'changes']) {
        if (expect[key] !== undefined) checks.push(isDeepStrictEqual(py?.[key], expect[key]));
      }
      if (expect.changes_max !== undefined) {
        checks.push((py?.changes || []).length <= expect.changes_max);
        checks.push(String(py?.text || '').split('\n').length <= 6);
      }
      return { name: entry.name, ok: checks.every(Boolean), py, js, exit: pyRun.status };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  batch(testCase) {
    const python = findPython();
    const [pyCmd, ...pyRest] = (python || '').split(' ');
    const rank = { 优先跟进: 0, 先核验: 1, 暂缓: 2 };
    const outcomes = (testCase.input.cases || []).map((entry) => {
      const dir = mkdtempSync(join(tmpdir(), 'buyer-check-batch-'));
      const file = join(dir, 'packs.json');
      const packs = entry.packs_data || (entry.packs || []).map((name) => loadFixture(name));
      writeFileSync(file, JSON.stringify(packs), 'utf8');
      const args = ['--batch', file, '--json'];
      const hasNodeRenderer = existsSync(join(ROOT, 'scripts', 'render_card.mjs'));
      const pyRun = spawnSync(pyCmd, [...pyRest, join(ROOT, 'scripts', 'render_card.py'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      const jsRun = hasNodeRenderer ? spawnSync('node', [join(ROOT, 'scripts', 'render_card.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 }) : null;
      let py = null;
      let js = null;
      try { py = JSON.parse(pyRun.stdout); } catch { py = null; }
      if (jsRun) {
        try { js = JSON.parse(jsRun.stdout); } catch { js = null; }
      }
      const expect = entry.expect || {};
      const checks = [hasNodeRenderer ? isDeepStrictEqual(py, js) : true];
      if (expect.status !== undefined) checks.push(py?.status === expect.status);
      if (py?.status === 'ok' && expect.status === 'ok') {
        if (expect.row_count !== undefined) checks.push(py.row_count === expect.row_count && (py.rows || []).length === expect.row_count);
        if (expect.max_table_lines !== undefined) checks.push((py.rows || []).length + 2 <= expect.max_table_lines);
        const ranks = (py.rows || []).map((row) => rank[row.next]);
        checks.push(ranks.every((value, index) => index === 0 || ranks[index - 1] <= value));
        if (expect.footer) checks.push(String(py.text || '').includes('回复序号可对该封做完整查询'));
        for (const needle of expect.hints_include || []) checks.push((py.hints || []).some((hint) => hint.includes(needle)));
      }
      return { name: entry.name, ok: checks.every(Boolean), py, js };
    });
    return { ok: outcomes.every((item) => item.ok), actual: outcomes };
  },

  report(testCase) {
    const python = findPython();
    if (!python) return { skipped: true, actual: 'python not found' };
    const [pyCmd, ...pyRest] = python.split(' ');
    let fixturePath = testCase.input.fixture ? join(FIXTURES_DIR, testCase.input.fixture) : null;
    if (testCase.input.fixture_data) {
      const dir = mkdtempSync(join(tmpdir(), 'buyer-check-report-'));
      fixturePath = join(dir, 'fixture.json');
      writeFileSync(fixturePath, JSON.stringify(testCase.input.fixture_data), 'utf8');
    }
    const run = spawnSync(pyCmd, [...pyRest, join(ROOT, 'scripts', 'render_card.py'), '--report', fixturePath, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    let result = null;
    try { result = JSON.parse(run.stdout); } catch { result = null; }
    let nodeResult = null;
    if (existsSync(join(ROOT, 'scripts', 'render_card.mjs'))) {
      const jsRun = spawnSync('node', [join(ROOT, 'scripts', 'render_card.mjs'), '--report', fixturePath, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      try { nodeResult = JSON.parse(jsRun.stdout); } catch { nodeResult = null; }
    }
    const expect = testCase.expect || {};
    const checks = [result?.status === 'ok'];
    if (nodeResult) checks.push(isDeepStrictEqual(result, nodeResult));
    if (expect.entries !== undefined) checks.push(result?.entries === expect.entries);
    if (expect.skipped !== undefined) checks.push(result?.skipped === expect.skipped);
    for (const needle of expect.text_includes || []) checks.push(String(result?.text || '').includes(needle));
    for (const needle of expect.text_excludes || []) checks.push(!String(result?.text || '').includes(needle));
    return { ok: checks.every(Boolean), actual: { status: result?.status, entries: result?.entries, skipped: result?.skipped, text: result?.text, node: nodeResult?.status } };
  },

  manual() {
    return { ok: true, skipped: true, actual: 'requires live network / model behaviour' };
  },
};

async function main() {
  process.env.PYTHONDONTWRITEBYTECODE = '1';
  const cases = loadAllCases();
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const testCase of cases) {
    const runner = runners[testCase.type];
    if (!runner) {
      console.log(`✗ ${testCase.id} ${testCase.title} — unknown type ${testCase.type}`);
      failed += 1;
      continue;
    }
    try {
      const outcome = await runner(testCase);
      if (outcome.skipped) {
        console.log(`○ ${testCase.id} ${testCase.title} — skipped (${outcome.actual})`);
        skipped += 1;
      } else if (outcome.ok) {
        console.log(`✓ ${testCase.id} ${testCase.title} — ${JSON.stringify(outcome.actual)}`);
        passed += 1;
      } else {
        console.log(`✗ ${testCase.id} ${testCase.title} — got ${JSON.stringify(outcome.actual)}`);
        failed += 1;
      }
    } catch (error) {
      console.log(`✗ ${testCase.id} ${testCase.title} — error ${error}`);
      failed += 1;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped (of ${cases.length})`);
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
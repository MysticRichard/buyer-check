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
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { score as riskScore, maskSensitive, loadRules } from '../scripts/risk_score.mjs';
import { analyse as domainAnalyse, loadBrands, loadBrandData } from '../scripts/domain_similarity.mjs';
import { analyse as whoisAnalyse } from '../scripts/whois_lookup.mjs';

let renderCard = null;
let ladderCombinations = null;
let containsFullPhone = null;
try {
  const module = await import('../scripts/render_card.mjs');
  renderCard = module.renderCard;
  ladderCombinations = module.ladderCombinations;
  containsFullPhone = module.containsFullPhone;
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
    for (let i = 1; i <= 15000; i += 1) {
      validRows.push(`${i},entity,"SYNTHETIC ENTITY ${String(i).padStart(5, '0')}",-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-,-0-`);
    }
    const validCsv = `${validRows.join('\n')}\n`;
    const invalidCsv = 'not,a,csv\n1,2,3\n';
    const hits = [];
    const server = createServer((req, res) => {
      hits.push(req.url);
      if (req.url === '/good' || req.url === '/third') {
        res.writeHead(200, { 'content-type': 'text/csv', 'last-modified': 'Mon, 09 Nov 2026 19:36:11 GMT' });
        res.end(validCsv);
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
    const paths = scenario === 'chain' ? ['/invalid', '/good', '/third'] : scenario === 'invalid' ? ['/bad'] : ['/fail', '/fail2'];
    const oldCache = scenario === 'invalid' ? 'OLD-CACHE-BYTES' : null;
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
      if (scenario === 'invalid') {
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
    const result = renderCard ? renderCard(evidence, loadRules()) : pyRenderEvidence(findPython(), evidence);
    const expect = testCase.expect || {};
    const checks = [];
    if (expect.status !== undefined) checks.push(result.status === expect.status);
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
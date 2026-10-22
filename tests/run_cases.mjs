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

import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { score as riskScore, maskSensitive, loadRules } from '../scripts/risk_score.mjs';
import { analyse as domainAnalyse, loadBrands } from '../scripts/domain_similarity.mjs';
import { analyse as whoisAnalyse } from '../scripts/whois_lookup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CASES_DIR = join(HERE, 'cases');
const FIXTURES_DIR = join(HERE, 'fixtures');

function loadCase(file) {
  return JSON.parse(readFileSync(join(CASES_DIR, file), 'utf8'));
}

const runners = {
  score(testCase) {
    const rules = loadRules();
    const result = riskScore(testCase.input.flags || [], rules, Boolean(testCase.input.unverifiable));
    const expect = testCase.expect;
    const checks = [];
    if (expect.level !== undefined) checks.push(result.level === expect.level);
    if (expect.total !== undefined) checks.push(result.total === expect.total);
    return { ok: checks.every(Boolean), actual: { level: result.level, total: result.total } };
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

  async whois_fixture(testCase) {
    const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, testCase.input.fixture), 'utf8'));
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

  manual() {
    return { ok: true, skipped: true, actual: 'requires live network / model behaviour' };
  },
};

async function main() {
  const files = readdirSync(CASES_DIR).filter((name) => name.endsWith('.json')).sort();
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const file of files) {
    const testCase = loadCase(file);
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

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped (of ${files.length})`);
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
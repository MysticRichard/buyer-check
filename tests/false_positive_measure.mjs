#!/usr/bin/env node
/**
 * False-positive measurement for the sanctions matcher.
 *
 * Queries every synthetic company name found in tests/cases, tests/fixtures and
 * the evaluation corpus against the local OFAC/UK caches, and reports how many
 * synthetic names hit a real list entry. Only reads the local cache; when the
 * cache is missing it exits 0 with status "skipped" instead of failing. The list
 * content is never printed, only counts and matched query names.
 *
 * Usage:
 *   node tests/false_positive_measure.mjs [--limit 200]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyse } from '../scripts/sanctions_check.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.SANCTIONS_CACHE_DIR || join(ROOT, '.cache', 'sanctions');
const LIST_FILES = ['ofac_sdn.csv', 'uk_sanctions_list.csv'];

if (!LIST_FILES.some((file) => existsSync(join(CACHE, file)))) {
  console.log(JSON.stringify({ status: 'skipped', reason: 'no-local-cache' }));
  process.exit(0);
}

const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) || 200 : 200;

const names = new Set();
function collect(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(collect);
    return;
  }
  for (const key of ['subject', 'intake']) {
    const party = value[key];
    if (party && typeof party === 'object' && typeof party.company === 'string' && party.company.trim()) {
      names.add(party.company.trim());
    }
  }
  for (const item of Object.values(value)) collect(item);
}

for (const dir of [join(ROOT, 'tests', 'cases'), join(ROOT, 'tests', 'fixtures')]) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir).filter((item) => item.endsWith('.json'))) {
    try {
      collect(JSON.parse(readFileSync(join(dir, name), 'utf8')));
    } catch {
      // ignore malformed files
    }
  }
}

const corpusPath = join(ROOT, 'tests', 'eval', 'inquiries.jsonl');
if (existsSync(corpusPath)) {
  const companyPattern = /[A-Z][A-Za-z&.-]+(?: [A-Z][A-Za-z&.-]+){1,4} (?:Ltd|LLC|Inc|GmbH|SARL|Trading|Supply|Industries|Imports|Exports|Group)/g;
  for (const rawLine of readFileSync(corpusPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      for (const match of String(item.text || '').matchAll(companyPattern)) names.add(match[0].trim());
    } catch {
      // ignore malformed corpus lines
    }
  }
}

const queries = [...names].filter((name) => name.length >= 3 && name.length <= 80).slice(0, limit);
const falseHits = [];
const perList = {};
for (const query of queries) {
  const result = await analyse(query, CACHE, true);
  if (result.status !== 'ok') continue;
  for (const match of result.possible_matches || []) {
    perList[match.list] = (perList[match.list] || 0) + 1;
    falseHits.push({ query, list: match.list, match_type: match.match_type });
  }
}

console.log(JSON.stringify({
  status: 'ok',
  query_count: queries.length,
  false_hit_count: falseHits.length,
  false_hits: falseHits.slice(0, 20),
  per_list: perList,
}, null, 2));
#!/usr/bin/env node
/**
 * Sanctions list matching for buyer-check (Node port).
 *
 * Matches a person or company name against official public sanctions lists
 * cached locally in .cache/sanctions/ (downloaded by update_sanctions.mjs).
 * Same-name hits are reported as possible matches with requires_manual_review
 * set to true — same-name entries must be manually excluded before any
 * conclusion. Must stay output-identical with sanctions_check.py.
 *
 * Usage:
 *   node sanctions_check.mjs "ACME TRADING LTD"
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(DIR, '..', '.cache', 'sanctions');

const LIST_FILES = {
  'OFAC SDN': 'ofac_sdn.csv',
  'EU Consolidated': 'eu_consolidated.csv',
  'UN Security Council': 'un_sc.csv',
  'UK OFSI Consolidated': 'uk_ofsi.csv',
};

export function normalize(name = '') {
  const text = String(name).toLowerCase().replace(/[^\w\s]/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

export function parseCsvLine(line = '') {
  const fields = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
    i += 1;
  }
  fields.push(field);
  return fields;
}

export function loadEntries(path, nameColumn) {
  const entries = [];
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const fields = parseCsvLine(rawLine);
    if (fields.length <= nameColumn) continue;
    const name = fields[nameColumn].trim();
    if (name) entries.push({ raw: name, normalized: normalize(name) });
  }
  return entries;
}

export function match(query, entries) {
  const target = normalize(query);
  if (!target) return [];
  const hits = [];
  for (const entry of entries) {
    if (entry.normalized === target) {
      hits.push({ entry: entry.raw, match_type: 'exact' });
    } else if (
      (entry.normalized.includes(target) || target.includes(entry.normalized)) &&
      entry.normalized.length >= 4 &&
      target.length >= 4
    ) {
      hits.push({ entry: entry.raw, match_type: 'partial' });
    }
  }
  return hits;
}

export function analyse(query) {
  const result = {
    query,
    lists_checked: [],
    possible_matches: [],
    match_count: 0,
    requires_manual_review: true,
    note: '同名需人工排除；存疑应标注「疑似命中，需人工核实」',
  };
  let anyList = false;
  for (const [listName, filename] of Object.entries(LIST_FILES)) {
    const path = join(CACHE_DIR, filename);
    if (!existsSync(path)) continue;
    anyList = true;
    let entries;
    try {
      entries = loadEntries(path, listName === 'OFAC SDN' ? 2 : 0);
    } catch {
      continue;
    }
    const updated = new Date(statSync(path).mtimeMs).toISOString().slice(0, 10);
    result.lists_checked.push({ list: listName, updated_at: updated });
    for (const hit of match(query, entries)) {
      result.possible_matches.push({ list: listName, entry: hit.entry, match_type: hit.match_type });
    }
  }
  result.match_count = result.possible_matches.length;
  if (!anyList) {
    return {
      ...result,
      status: 'unavailable',
      error: 'no sanctions list cached; run scripts/update_sanctions first',
    };
  }
  return { ...result, status: 'ok' };
}

function main() {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!positional.length) {
    console.log(JSON.stringify({ status: 'error', error: 'missing name argument' }));
    process.exit(2);
  }
  const result = analyse(positional[0]);
  console.log(JSON.stringify(result));
  process.exit(result.status === 'ok' ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
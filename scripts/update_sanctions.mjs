#!/usr/bin/env node
/**
 * Download official public sanctions lists for buyer-check (Node port).
 *
 * OFAC SDN is fetched from the official Sanctions List Service endpoint, with
 * the legacy treasury.gov URL as fallback. Every payload must validate as
 * SDN-shaped CSV before it atomically replaces the old cache. A failed
 * download never overwrites a good cache.
 *
 * Usage:
 *   node update_sanctions.mjs
 *   node update_sanctions.mjs --check
 *   node update_sanctions.mjs --urls URL1,URL2   # test hook
 */

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(DIR, '..', '.cache', 'sanctions');

export const SDN_URLS = [
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV',
  'https://www.treasury.gov/ofac/downloads/sdn.csv',
];

const PER_URL_TIMEOUT_MS = 20000;
const MIN_SDN_ROWS = 15000;
const SDN_COLUMNS = 12;
const MAX_WIDTH_OUTLIER_RATIO = 0.10;

const SOURCES = {
  'OFAC SDN': { urls: SDN_URLS, file: 'ofac_sdn.csv', status: 'configured' },
  'EU Consolidated': { urls: [], file: 'eu_consolidated.csv', status: 'not_configured' },
  'UN Security Council': { urls: [], file: 'un_sc.csv', status: 'not_configured' },
  'UK OFSI Consolidated': { urls: [], file: 'uk_ofsi.csv', status: 'not_configured' },
};

function parseCsvLine(line = '') {
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

export function validateSdn(buffer) {
  if (!buffer || buffer.length === 0) return { ok: false, detail: 'empty' };
  const head = buffer.subarray(0, 300).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<') || head.includes('<html') || head.includes('<!doctype')) return { ok: false, detail: 'not-csv' };
  const rows = buffer.toString('utf8').split(/\r?\n/).map((line) => parseCsvLine(line)).filter((row) => row.some((cell) => cell.trim()));
  if (rows.length < MIN_SDN_ROWS) return { ok: false, detail: `too-few-rows:${rows.length}` };
  if (rows[0].length < SDN_COLUMNS) return { ok: false, detail: 'missing-columns' };
  const goodWidth = rows.filter((row) => row.length >= SDN_COLUMNS).length;
  if (goodWidth / rows.length < 1 - MAX_WIDTH_OUTLIER_RATIO) return { ok: false, detail: 'bad-columns' };
  return { ok: true, detail: `${rows.length} rows` };
}

function parseListDate(lastModified, path) {
  if (lastModified) {
    const parsed = new Date(lastModified);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  try {
    return new Date(statSync(path).mtimeMs).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function downloadOne(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'buyer-check/0.9', accept: 'text/csv,*/*' },
      signal: controller.signal,
    });
    if (!response.ok) return { status: 'failed', reason: 'download-failed', detail: `http-${response.status}` };
    return {
      status: 'ok',
      data: Buffer.from(await response.arrayBuffer()),
      lastModified: response.headers.get('last-modified'),
      sourceUrl: url,
    };
  } catch (error) {
    return { status: 'failed', reason: 'no-network', detail: String(error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadSanctions({ cacheDir = CACHE_DIR, timeoutMs = PER_URL_TIMEOUT_MS, urls = SDN_URLS } = {}) {
  const path = join(cacheDir, 'ofac_sdn.csv');
  const metaPath = join(cacheDir, 'ofac_sdn.meta.json');
  const attempts = [];
  let invalidSeen = false;
  for (const url of urls) {
    const outcome = await downloadOne(url, timeoutMs);
    if (outcome.status !== 'ok') {
      attempts.push({ url, status: 'failed', reason: outcome.reason, detail: outcome.detail });
      continue;
    }
    const validation = validateSdn(outcome.data);
    if (!validation.ok) {
      invalidSeen = true;
      attempts.push({ url, status: 'invalid-content', reason: validation.detail });
      continue;
    }
    mkdirSync(cacheDir, { recursive: true });
    const tempPath = `${path}.tmp`;
    writeFileSync(tempPath, outcome.data);
    renameSync(tempPath, path);
    const listDate = parseListDate(outcome.lastModified, path);
    const listAgeDays = Math.floor((Date.now() - Date.parse(`${listDate}T00:00:00Z`)) / 86400000);
    const meta = {
      source_url: outcome.sourceUrl || url,
      list_date: listDate,
      list_age_days: Number.isNaN(listAgeDays) ? null : listAgeDays,
      bytes: outcome.data.length,
      detail: validation.detail,
    };
    writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
    attempts.push({ url, status: 'ok', reason: validation.detail });
    return { status: 'ok', ...meta, attempts };
  }
  return { status: 'unavailable', reason: invalidSeen ? 'invalid-content' : 'all-urls-failed', attempts };
}

export async function updateSanctions({ cacheDir = CACHE_DIR, timeoutMs = PER_URL_TIMEOUT_MS, checkOnly = false, urls = SDN_URLS } = {}) {
  const results = [];
  let ok = true;
  for (const [name, source] of Object.entries(SOURCES)) {
    if (checkOnly || source.status !== 'configured') {
      results.push({ list: name, status: source.status, urls: source.urls });
      continue;
    }
    const outcome = name === 'OFAC SDN'
      ? await downloadSanctions({ cacheDir, timeoutMs, urls })
      : { status: 'unavailable', reason: 'not-configured' };
    const item = { list: name, status: outcome.status === 'ok' ? 'downloaded' : 'failed' };
    for (const key of ['reason', 'source_url', 'list_date', 'list_age_days', 'attempts']) {
      if (outcome[key] !== undefined) item[key] = outcome[key];
    }
    results.push(item);
    if (outcome.status !== 'ok') ok = false;
  }
  return { status: ok ? 'ok' : 'unavailable', cache_dir: cacheDir, results };
}

function parseArgs(argv) {
  const args = { check: false, cacheDir: CACHE_DIR, urls: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--cache-dir') args.cacheDir = argv[++i];
    else if (argv[i] === '--urls') args.urls = argv[++i].split(',').map((item) => item.trim()).filter(Boolean);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await updateSanctions({ cacheDir: args.cacheDir, checkOnly: args.check, urls: args.urls || SDN_URLS });
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'ok' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
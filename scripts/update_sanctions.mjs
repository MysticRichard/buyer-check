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
const SDN_NAME_COLUMN = 1;
const SDN_TYPE_COLUMN = 2;
const SDN_TYPE_VALUES = new Set(['-0-', 'individual', 'entity', 'vessel', 'aircraft']);
const MIN_TYPE_COLUMN_RATIO = 0.90;
const UK_URL = 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv';
const UK_COLUMNS = 58;
const MIN_UK_ROWS = 1000;

const SOURCES = {
  'OFAC SDN': { urls: SDN_URLS, file: 'ofac_sdn.csv', status: 'configured' },
  'EU Consolidated': { urls: [], file: 'eu_consolidated.csv', status: 'not_configured' },
  'UN Security Council': { urls: [], file: 'un_sc.csv', status: 'not_configured' },
  'UK Sanctions List': { urls: [UK_URL], file: 'uk_sanctions_list.csv', status: 'configured' },
};

function parseCsv(text = '') {
  const rows = [];
  const source = String(text);
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      if (source[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

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

export function validateUk(buffer) {
  if (!buffer || buffer.length === 0) return { ok: false, detail: 'empty' };
  const head = buffer.subarray(0, 300).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<') || head.includes('<html') || head.includes('<!doctype')) return { ok: false, detail: 'not-csv' };
  const rows = parseCsv(buffer.toString('utf8'));
  let headerIndex = -1;
  for (let i = 0; i < Math.min(6, rows.length); i += 1) {
    if (rows[i].map((field) => field.trim().toLowerCase()).includes('name type')) { headerIndex = i; break; }
  }
  if (headerIndex < 0) return { ok: false, detail: 'missing-header' };
  const body = rows.slice(headerIndex + 1).filter((row) => row.some((cell) => cell.trim()));
  if (body.length < MIN_UK_ROWS) return { ok: false, detail: `too-few-rows:${body.length}` };
  const goodWidth = body.filter((row) => row.length >= UK_COLUMNS).length;
  if (goodWidth / body.length < 1 - MAX_WIDTH_OUTLIER_RATIO) return { ok: false, detail: 'bad-columns' };
  return { ok: true, detail: `${body.length} rows` };
}

export function validateSdn(buffer) {
  if (!buffer || buffer.length === 0) return { ok: false, detail: 'empty' };
  const head = buffer.subarray(0, 300).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<') || head.includes('<html') || head.includes('<!doctype')) return { ok: false, detail: 'not-csv' };
  const rows = parseCsv(buffer.toString('utf8')).filter((row) => row.some((cell) => cell.trim()));
  if (rows.length < MIN_SDN_ROWS) return { ok: false, detail: `too-few-rows:${rows.length}` };
  if (rows[0].length < SDN_COLUMNS) return { ok: false, detail: 'missing-columns' };
  const goodWidth = rows.filter((row) => row.length >= SDN_COLUMNS).length;
  if (goodWidth / rows.length < 1 - MAX_WIDTH_OUTLIER_RATIO) return { ok: false, detail: 'bad-columns' };
  const typedRows = rows.filter((row) => row.length >= SDN_COLUMNS);
  const typeOk = typedRows.filter((row) => SDN_TYPE_VALUES.has((row[SDN_TYPE_COLUMN] || '').trim().toLowerCase())).length;
  if (!typedRows.length || typeOk / typedRows.length < MIN_TYPE_COLUMN_RATIO) {
    return { ok: false, detail: 'bad-type-column' };
  }
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

export async function downloadUk({ cacheDir = CACHE_DIR, timeoutMs = PER_URL_TIMEOUT_MS, urls = [UK_URL] } = {}) {
  const path = join(cacheDir, 'uk_sanctions_list.csv');
  const metaPath = join(cacheDir, 'uk_sanctions_list.meta.json');
  const attempts = [];
  let invalidSeen = false;
  for (const url of urls) {
    const outcome = await downloadOne(url, timeoutMs);
    if (outcome.status !== 'ok') {
      attempts.push({ url, status: 'failed', reason: outcome.reason, detail: outcome.detail });
      continue;
    }
    const validation = validateUk(outcome.data);
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
    const meta = { source_url: outcome.sourceUrl || url, list_date: listDate, list_age_days: Number.isNaN(listAgeDays) ? null : listAgeDays, bytes: outcome.data.length, detail: validation.detail };
    writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
    attempts.push({ url, status: 'ok', reason: validation.detail });
    return { status: 'ok', ...meta, attempts };
  }
  return { status: 'unavailable', reason: invalidSeen ? 'invalid-content' : 'all-urls-failed', attempts };
}

export async function updateSanctions({ cacheDir = CACHE_DIR, timeoutMs = PER_URL_TIMEOUT_MS, checkOnly = false, urls = SDN_URLS, ukUrls = [UK_URL] } = {}) {
  const results = [];
  let ok = true;
  for (const [name, source] of Object.entries(SOURCES)) {
    if (checkOnly || source.status !== 'configured') {
      results.push({ list: name, status: source.status, urls: source.urls });
      continue;
    }
    if (name === 'UK Sanctions List' && urls !== SDN_URLS) {
      results.push({ list: name, status: source.status, urls: source.urls });
      continue;
    }
    let outcome;
    if (name === 'OFAC SDN') outcome = await downloadSanctions({ cacheDir, timeoutMs, urls });
    else if (name === 'UK Sanctions List') outcome = await downloadUk({ cacheDir, timeoutMs, urls: ukUrls });
    else outcome = { status: 'unavailable', reason: 'not-configured' };
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
  const args = { check: false, cacheDir: CACHE_DIR, urls: null, ukUrls: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--cache-dir') args.cacheDir = argv[++i];
    else if (argv[i] === '--urls') args.urls = argv[++i].split(',').map((item) => item.trim()).filter(Boolean);
    else if (argv[i] === '--uk-urls') args.ukUrls = argv[++i].split(',').map((item) => item.trim()).filter(Boolean);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await updateSanctions({ cacheDir: args.cacheDir, checkOnly: args.check, urls: args.urls || SDN_URLS, ukUrls: args.ukUrls || [UK_URL] });
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'ok' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
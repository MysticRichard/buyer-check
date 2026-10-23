#!/usr/bin/env node
/**
 * Download official public sanctions lists for buyer-check (Node port).
 *
 * Fetches the OFAC SDN CSV (direct public download) into .cache/sanctions/ so
 * sanctions_check.mjs can match locally. The EU / UN / UK OFSI list download
 * URLs have NOT been verified yet and are reported as not_configured — never
 * guessed. Must stay output-compatible with update_sanctions.py.
 *
 * Usage:
 *   node update_sanctions.mjs           # download configured lists
 *   node update_sanctions.mjs --check    # only report source status
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(DIR, '..', '.cache', 'sanctions');

const SOURCES = {
  'OFAC SDN': {
    url: 'https://www.treasury.gov/ofac/downloads/sdn.csv',
    file: 'ofac_sdn.csv',
    status: 'configured',
  },
  'EU Consolidated': { url: null, file: 'eu_consolidated.csv', status: 'not_configured' },
  'UN Security Council': { url: null, file: 'un_sc.csv', status: 'not_configured' },
  'UK OFSI Consolidated': { url: null, file: 'uk_ofsi.csv', status: 'not_configured' },
};

async function download(url, path, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'buyer-check/0.5' },
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buffer);
    return { ok: true, detail: `${buffer.length} bytes` };
  } catch (error) {
    return { ok: false, detail: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const results = [];
  let ok = true;
  for (const [name, source] of Object.entries(SOURCES)) {
    if (checkOnly || source.status !== 'configured') {
      results.push({ list: name, status: source.status, url: source.url });
      continue;
    }
    const outcome = await download(source.url, join(CACHE_DIR, source.file));
    results.push({ list: name, status: outcome.ok ? 'downloaded' : 'failed', detail: outcome.detail });
    if (!outcome.ok) ok = false;
  }
  console.log(JSON.stringify({ status: ok ? 'ok' : 'unavailable', cache_dir: CACHE_DIR, results }));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
#!/usr/bin/env node
/**
 * Data source freshness checker for buyer-check (v0.6.0).
 *
 * Collects source URLs from scripts/country_capabilities.json and every
 * data-sources/*.md file, then checks each one for reachability and redirects
 * with a single lightweight request. Requests are serial with a small delay
 * (low frequency by design); response bodies are never read — this is a
 * reachability probe only, in the conservative spirit of robots.txt (no
 * crawling, no content scraping). Registry sites that block bots simply
 * surface as failures for manual review.
 *
 * A URL is listed as failed when the request errors (DNS, TLS, refused) or
 * the response status is neither 2xx nor 3xx (429 tolerated: rate limiting).
 *
 * Usage:
 *   node scripts/check_sources.mjs                  # default sources
 *   node scripts/check_sources.mjs --config f.json  # {"sources":[{"url","source"}]}
 *   node scripts/check_sources.mjs --timeout 15000
 *
 * Output is JSON on stdout: ok / failed lists with status codes.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CAPABILITIES = join(HERE, 'country_capabilities.json');
const DATA_SOURCES_DIR = join(ROOT, 'data-sources');

const URL_RE = /https?:\/\/[^\s)"'<>]+/g;

function listMarkdownFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      for (const nested of readdirSync(full)) {
        if (nested.endsWith('.md')) files.push(join(name, nested));
      }
    } else if (name.endsWith('.md')) {
      files.push(name);
    }
  }
  return files;
}

function collectFromCapabilities() {
  const entries = [];
  const data = JSON.parse(readFileSync(CAPABILITIES, 'utf8'));
  for (const [iso2, country] of Object.entries(data.countries || {})) {
    const registry = country.registry || {};
    if (registry.url) entries.push({ url: registry.url, source: `country_capabilities:${iso2}` });
    if (registry.search_portal) entries.push({ url: registry.search_portal, source: `country_capabilities:${iso2}` });
    const abuDhabi = registry.abu_dhabi_license_check;
    if (abuDhabi && abuDhabi.url) entries.push({ url: abuDhabi.url, source: `country_capabilities:${iso2}` });
  }
  return entries;
}

function collectFromMarkdown(dir) {
  const entries = [];
  for (const file of listMarkdownFiles(dir)) {
    let text;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(URL_RE)) {
      entries.push({ url: match[0].replace(/[.,;]+$/, ''), source: `data-sources/${file}` });
    }
  }
  return entries;
}

function dedupe(entries) {
  const seen = new Map();
  for (const entry of entries) {
    if (!seen.has(entry.url)) seen.set(entry.url, entry);
  }
  return [...seen.values()];
}

async function probe(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'buyer-check-source-freshness/0.6 (reachability probe only)' },
      signal: controller.signal,
    });
    // Body intentionally not consumed.
    const ok = (response.status >= 200 && response.status < 400) || response.status === 429;
    return { ok, status: response.status, final_url: response.url };
  } catch (error) {
    return { ok: false, status: null, error: String(error && error.cause ? error.cause : error) };
  } finally {
    clearTimeout(timer);
  }
}

export { probe, collectFromCapabilities, collectFromMarkdown, dedupe };

function parseArgs(argv) {
  const args = { config: null, timeout: 10000, delayMs: 500 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--config') args.config = argv[++i];
    else if (token === '--timeout') args.timeout = Number(argv[++i]);
    else if (token === '--delay') args.delayMs = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let sources;
  if (args.config) {
    sources = JSON.parse(readFileSync(args.config, 'utf8')).sources;
  } else {
    sources = dedupe([...collectFromCapabilities(), ...collectFromMarkdown(DATA_SOURCES_DIR)]);
  }

  const okEntries = [];
  const failedEntries = [];
  for (const entry of sources) {
    const result = await probe(entry.url, args.timeout);
    const record = {
      url: entry.url,
      source: entry.source,
      status: result.status,
      ...(result.final_url && result.final_url !== entry.url ? { final_url: result.final_url } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    if (result.ok) okEntries.push(record);
    else failedEntries.push(record);
    if (args.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, args.delayMs));
    }
  }

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        checked_at: new Date().toISOString(),
        total: sources.length,
        ok_count: okEntries.length,
        failed_count: failedEntries.length,
        ok: okEntries,
        failed: failedEntries,
        note: 'reachability probe only: single request, no body read, serial with delay',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
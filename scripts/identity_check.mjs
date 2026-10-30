#!/usr/bin/env node
/**
 * Identity helpers for buyer-check v0.8.0 (Node port).
 *
 * Subcommands: site / backlink / image. Mirrors identity_check.py.
 * Offline by default; site only fetches with --online. Never stores avatars or
 * hashes, never uses face detection/recognition.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let sharp = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

const USER_AGENT = 'buyer-check/0.8.0 (company-profile; read-only)';
const SOCIAL_PATTERNS = {
  facebook: /https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>]+/gi,
  linkedin: /https?:\/\/(?:[a-z]{2}\.)?(?:www\.)?linkedin\.com\/[^\s"'<>]+/gi,
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/gi,
  youtube: /https?:\/\/(?:www\.)?youtube\.com\/[^\s"'<>]+/gi,
  x: /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^\s"'<>]+/gi,
};

function uniqueSorted(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort();
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&copy;/g, '©');
}

function stripTags(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ');
}

function textOf(fragment) {
  return decodeEntities(stripTags(fragment)).replace(/\s+/g, ' ').trim();
}

function metaContent(html, key, attr = 'name') {
  const pattern = new RegExp(`<meta\\s+[^>]*${attr}=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']`, 'i');
  const match = pattern.exec(html);
  return match ? decodeEntities(match[1]).trim() : null;
}

function parseHtml(html, baseUrl) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? textOf(titleMatch[1]) : '';
  const description = metaContent(html, 'description') || metaContent(html, 'og:description', 'property');
  const siteName = metaContent(html, 'og:site_name', 'property');
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) => textOf(match[1]));
  const titleCandidates = title ? [title.split(/[|\-–—]/)[0]] : [];
  const companyCandidates = uniqueSorted([siteName || '', ...h1s, ...titleCandidates]);

  const socials = [];
  for (const [platform, pattern] of Object.entries(SOCIAL_PATTERNS)) {
    for (const match of html.matchAll(pattern)) {
      socials.push([platform, match[0].replace(/[.,);"']+$/, '')]);
    }
  }
  const socialLinks = [...new Set(socials.map(([platform, url]) => `${platform}\u0000${url}`))]
    .sort()
    .map((value) => {
      const [platform, url] = value.split('\u0000');
      return { platform, url };
    });

  const emails = uniqueSorted(
    [...html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((match) => match[0].toLowerCase()),
  );

  const phones = [];
  for (const match of html.matchAll(/tel:([^"'\s<>]+)/gi)) phones.push(decodeEntities(match[1]));
  for (const match of html.matchAll(/\+?\d[\d\s().-]{6,}\d/g)) phones.push(match[0]);
  const phoneList = uniqueSorted(phones);

  const addresses = [...html.matchAll(/<address[^>]*>([\s\S]*?)<\/address>/gi)].map((match) => textOf(match[1]));
  for (const match of html.matchAll(/itemprop=["']streetAddress["'][^>]*content=["']([^"']*)["']/gi)) {
    addresses.push(decodeEntities(match[1]).trim());
  }
  const addressList = uniqueSorted(addresses);

  const teamLinks = [];
  const contactLinks = [];
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    let absolute;
    try {
      absolute = new URL(decodeEntities(match[1]), baseUrl || undefined).href;
    } catch {
      continue;
    }
    const lower = absolute.toLowerCase();
    if (lower.includes('team') || lower.includes('about')) teamLinks.push(absolute);
    if (lower.includes('contact')) contactLinks.push(absolute);
  }

  const copyrightMatch = /(?:©|&copy;|copyright)[^\d]{0,12}(\d{4})/i.exec(html);
  const copyrightYear = copyrightMatch ? Number(copyrightMatch[1]) : null;

  return {
    company_candidates: companyCandidates,
    description,
    social_links: socialLinks,
    emails,
    phones: phoneList,
    addresses: addressList,
    team_links: uniqueSorted(teamLinks),
    contact_links: uniqueSorted(contactLinks),
    copyright_year: copyrightYear,
  };
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function robotsAllows(domain, path) {
  const text = await fetchText(`https://${domain}/robots.txt`, 8000);
  if (!text) return true;
  return !/User-agent:\s*\*[\s\S]*?Disallow:\s*\/\s*(?:\r?\n|$)/i.test(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function siteCommand(args) {
  if (!args.htmlFile && !(args.online && args.domain)) {
    return { status: 'unavailable', command: 'site', error: 'pass --html-file or --online with --domain' };
  }
  const pages = [];
  if (args.htmlFile) {
    try {
      pages.push(['file', readFileSync(args.htmlFile, 'utf8')]);
    } catch (error) {
      return { status: 'unavailable', command: 'site', error: String(error) };
    }
  } else {
    const domain = String(args.domain).trim().toLowerCase();
    const paths = ['/', '/about', '/products', '/contact'].slice(0, Math.max(1, Math.min(args.maxPages, 4)));
    for (let index = 0; index < paths.length; index += 1) {
      if (index && !(await robotsAllows(domain, paths[index]))) continue;
      const url = new URL(`https://${domain}${paths[index]}`).href;
      const body = await fetchText(url, args.timeout * 1000);
      if (body) pages.push([url, body]);
      if (index) await sleep(args.delay * 1000);
    }
    if (pages.length === 0) return { status: 'unavailable', command: 'site', error: 'website not reachable' };
  }

  const merged = {
    company_candidates: [],
    description: null,
    social_links: [],
    emails: [],
    phones: [],
    addresses: [],
    team_links: [],
    contact_links: [],
    copyright_year: null,
  };
  for (const [pageUrl, body] of pages) {
    const parsed = parseHtml(body, pageUrl === 'file' ? (args.domain ? `https://${args.domain}/` : '') : pageUrl);
    for (const key of ['company_candidates', 'emails', 'phones', 'addresses', 'team_links', 'contact_links']) {
      merged[key].push(...parsed[key]);
    }
    merged.social_links.push(...parsed.social_links);
    if (!merged.description && parsed.description) merged.description = parsed.description;
    if (merged.copyright_year === null && parsed.copyright_year) merged.copyright_year = parsed.copyright_year;
  }
  merged.company_candidates = uniqueSorted(merged.company_candidates);
  merged.emails = uniqueSorted(merged.emails);
  merged.phones = uniqueSorted(merged.phones);
  merged.addresses = uniqueSorted(merged.addresses);
  merged.team_links = uniqueSorted(merged.team_links);
  merged.contact_links = uniqueSorted(merged.contact_links);
  merged.social_links = [...new Set(merged.social_links.map((item) => `${item.platform}\u0000${item.url}`))]
    .sort()
    .map((value) => {
      const [platform, url] = value.split('\u0000');
      return { platform, url };
    });

  return {
    status: 'ok',
    command: 'site',
    domain: args.domain,
    pages_fetched: args.htmlFile ? ['file'] : pages.map(([url]) => url),
    ...merged,
  };
}

function backlinkCommand(args) {
  let text = '';
  if (args.htmlFile) {
    try {
      text = readFileSync(args.htmlFile, 'utf8');
    } catch (error) {
      return { status: 'unavailable', command: 'backlink', error: String(error) };
    }
  } else {
    text = args.text || '';
  }
  const domain = String(args.domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!domain) return { status: 'unavailable', command: 'backlink', error: '--domain is required' };
  return { status: 'ok', command: 'backlink', domain, mutual: text.toLowerCase().includes(domain) };
}

async function dhash(path) {
  const raw = await sharp(path).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  const bits = [];
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      bits.push(raw[row * 9 + col] > raw[row * 9 + col + 1]);
    }
  }
  return bits;
}

function hamming(a, b) {
  return a.reduce((count, value, index) => count + (value === b[index] ? 0 : 1), 0);
}

async function imageCommand(args) {
  if (args.paths.length < 2) {
    return { status: 'unavailable', command: 'image', error: 'at least two image paths are required' };
  }
  let blobs;
  try {
    blobs = args.paths.map((path) => readFileSync(path));
  } catch (error) {
    return { status: 'unavailable', command: 'image', error: String(error) };
  }
  const digests = blobs.map((blob) => createHash('sha256').update(blob).digest('hex'));
  if (new Set(digests).size === 1) {
    return { status: 'ok', command: 'image', result: 'same-image', method: 'sha256', files: args.paths.length };
  }
  if (!sharp) {
    return {
      status: 'ok',
      command: 'image',
      result: 'not-comparable',
      reason: 'no-image-library',
      method: 'sha256',
      files: args.paths.length,
    };
  }
  try {
    const hashes = [];
    for (const path of args.paths) hashes.push(await dhash(path));
    const distance = Math.max(...hashes.slice(1).map((hash) => hamming(hashes[0], hash)));
    // Calibrated with synthetic icons: 0-8 near-duplicate, >8 different.
    return {
      status: 'ok',
      command: 'image',
      result: distance <= 8 ? 'near-duplicate' : 'different',
      method: 'dhash',
      distance,
      files: args.paths.length,
    };
  } catch {
    return {
      status: 'ok',
      command: 'image',
      result: 'not-comparable',
      reason: 'image-decode-failed',
      method: 'dhash',
      files: args.paths.length,
    };
  }
}

function usage() {
  return [
    'Usage: node identity_check.mjs site [--domain DOMAIN] [--html-file FILE] [--online]',
    '       node identity_check.mjs backlink --domain DOMAIN (--text TEXT | --html-file FILE)',
    '       node identity_check.mjs image PATH1 PATH2 [PATH3 ...]',
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0];
  const args = { command, domain: null, htmlFile: null, online: false, maxPages: 4, delay: 1, timeout: 10, text: '', paths: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--domain') args.domain = argv[++i];
    else if (token === '--html-file') args.htmlFile = argv[++i];
    else if (token === '--online') args.online = true;
    else if (token === '--max-pages') args.maxPages = Number(argv[++i]);
    else if (token === '--delay') args.delay = Number(argv[++i]);
    else if (token === '--timeout') args.timeout = Number(argv[++i]);
    else if (token === '--text') args.text = argv[++i];
    else if (!token.startsWith('--')) args.paths.push(token);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!['site', 'backlink', 'image'].includes(args.command)) {
    console.log(JSON.stringify({ status: 'unavailable', error: 'unknown or missing subcommand' }));
    return 2;
  }
  let result;
  if (args.command === 'site') result = await siteCommand(args);
  else if (args.command === 'backlink') result = backlinkCommand(args);
  else result = await imageCommand(args);
  console.log(JSON.stringify(result));
  return result.status === 'ok' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
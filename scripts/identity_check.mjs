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
const GOOGLE_TEXTSEARCH = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const GOOGLE_DETAILS = 'https://maps.googleapis.com/maps/api/place/details/json';
const OSM_SEARCH = 'https://nominatim.openstreetmap.org/search';
const BRREG_SEARCH = 'https://data.brreg.no/enhetsregisteret/api/enheter';
const BRREG_ENTITY = 'https://data.brreg.no/enhetsregisteret/api/enheter/';
const BRREG_LICENSE = 'NLOD 2.0';

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

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`http-${response.status}`);
      error.code = `http-${response.status}`;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function phoneMatches(candidate, phone) {
  const wanted = normalizePhone(phone);
  const got = normalizePhone(candidate.phone);
  if (!wanted || !got) return false;
  return wanted === got || wanted.endsWith(got.slice(-8)) || got.endsWith(wanted.slice(-8));
}

function nameMatches(candidate, company) {
  const wanted = normalizeName(company);
  const got = normalizeName(candidate.name || candidate.address);
  return Boolean(wanted && got && (wanted.includes(got) || got.includes(wanted)));
}

function mapResult(source, query, candidates, args) {
  const result = {
    status: candidates.length > 0 ? 'ok' : 'unavailable',
    command: 'map',
    source,
    query,
    candidates,
    match: {
      name_match: args.company ? candidates.some((item) => nameMatches(item, args.company)) : null,
      phone_match: args.phone ? candidates.some((item) => phoneMatches(item, args.phone)) : null,
    },
  };
  if (candidates.length === 0) result.error = 'no results';
  return result;
}

async function googleCandidates(payload, args, key = null) {
  const results = (payload.results || []).slice(0, args.limit);
  const candidates = [];
  for (const result of results) {
    const location = (result.geometry || {}).location || {};
    const item = {
      name: result.name || null,
      address: result.formatted_address || null,
      phone: result.formatted_phone_number || result.international_phone_number || null,
      website: result.website || null,
      rating: result.rating ?? null,
      reviews: result.user_ratings_total ?? null,
      business_status: result.business_status || null,
      place_id: result.place_id || null,
      lat: location.lat ?? null,
      lng: location.lng ?? null,
    };
    if (key && item.place_id && !args.fixtureJson) {
      try {
        const params = new URLSearchParams({
          place_id: item.place_id,
          fields: 'name,formatted_address,formatted_phone_number,international_phone_number,website,rating,user_ratings_total,business_status,geometry',
          key,
        });
        const details = await fetchJson(`${GOOGLE_DETAILS}?${params.toString()}`, args.timeout * 1000);
        if (details.status === 'OK') {
          const detail = details.result || {};
          if (detail.name) item.name = detail.name;
          if (detail.formatted_address) item.address = detail.formatted_address;
          const phone = detail.formatted_phone_number || detail.international_phone_number;
          if (phone) item.phone = phone;
          for (const field of ['website', 'rating', 'user_ratings_total', 'business_status']) {
            if (detail[field] !== undefined && detail[field] !== null) item[field] = detail[field];
          }
          const detailLocation = (detail.geometry || {}).location || {};
          if (detailLocation.lat !== undefined) item.lat = detailLocation.lat;
          if (detailLocation.lng !== undefined) item.lng = detailLocation.lng;
        }
      } catch {
        // keep text-search fields
      }
    }
    candidates.push(item);
  }
  return candidates;
}

async function googleMap(args, key) {
  const query = [args.company, args.phone, args.country].filter(Boolean).join(' ');
  const params = new URLSearchParams({ query, key });
  let payload;
  try {
    payload = await fetchJson(`${GOOGLE_TEXTSEARCH}?${params.toString()}`, args.timeout * 1000);
  } catch {
    return { status: 'unavailable', command: 'map', source: 'google_places', error: 'request-failed' };
  }
  const status = payload.status;
  if (status !== 'OK' && status !== 'ZERO_RESULTS') {
    return { status: 'unavailable', command: 'map', source: 'google_places', error: status || 'request-failed' };
  }
  return mapResult('google_places', query, await googleCandidates(payload, args, key), args);
}

async function osmMap(args) {
  const query = [args.company, args.country].filter(Boolean).join(' ');
  const params = new URLSearchParams({ q: query, format: 'jsonv2', addressdetails: '1', limit: String(args.limit) });
  let payload;
  try {
    payload = await fetchJson(`${OSM_SEARCH}?${params.toString()}`, args.timeout * 1000);
  } catch {
    return { status: 'unavailable', command: 'map', source: 'osm_nominatim', error: 'request-failed' };
  }
  if (!Array.isArray(payload)) {
    return { status: 'unavailable', command: 'map', source: 'osm_nominatim', error: 'request-failed' };
  }
  const candidates = payload.slice(0, args.limit).map((item) => {
    const extra = item.extratags || {};
    return {
      name: item.name || item.display_name || null,
      address: item.display_name || null,
      phone: extra.phone || null,
      website: extra.website || null,
      rating: null,
      reviews: null,
      business_status: null,
      place_id: String(item.place_id || ''),
      lat: item.lat ?? null,
      lng: item.lon ?? null,
    };
  });
  return mapResult('osm_nominatim', query, candidates, args);
}

async function mapCommand(args) {
  const query = [args.company, args.phone, args.country].filter(Boolean).join(' ');
  if (args.fixtureJson) {
    let payload;
    try {
      payload = JSON.parse(readFileSync(args.fixtureJson, 'utf8'));
    } catch (error) {
      return { status: 'unavailable', command: 'map', error: String(error) };
    }
    if (args.fixtureSource === 'osm_nominatim') {
      if (!Array.isArray(payload)) {
        return { status: 'unavailable', command: 'map', source: 'osm_nominatim', error: 'invalid fixture' };
      }
      const candidates = payload.slice(0, args.limit).map((item) => {
        const extra = item.extratags || {};
        return {
          name: item.name || item.display_name || null,
          address: item.display_name || null,
          phone: extra.phone || null,
          website: extra.website || null,
          rating: null,
          reviews: null,
          business_status: null,
          place_id: String(item.place_id || ''),
          lat: item.lat ?? null,
          lng: item.lon ?? null,
        };
      });
      return mapResult('osm_nominatim', query, candidates, args);
    }
    return mapResult('google_places', query, await googleCandidates(payload, args), args);
  }
  if (!args.online) {
    return { status: 'unavailable', command: 'map', error: 'pass --online or --fixture-json' };
  }
  const key = args.googleKey || process.env.GOOGLE_MAPS_API_KEY;
  if (key) return googleMap(args, key);
  return osmMap(args);
}

function normalizeCompany(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function countryCode(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return null;
  if (/^[a-z]{2}$/.test(key)) return key.toUpperCase();
  return {
    norge: 'NO', norway: 'NO', noreg: 'NO',
    sverige: 'SE', sweden: 'SE',
    danmark: 'DK', denmark: 'DK',
    suomi: 'FI', finland: 'FI',
  }[key] || null;
}

function registryStatusText(entity) {
  if (entity.konkurs) return '已破产';
  if (entity.underTvangsavviklingEllerTvangsopplosning) return '强制清算';
  if (entity.underAvvikling) return '清算中';
  return '存续';
}

function registryEntry(entity) {
  const address = entity.forretningsadresse || {};
  const orgNumber = entity.organisasjonsnummer || null;
  return {
    legal_name: entity.navn ?? null,
    org_number: orgNumber,
    status_text: registryStatusText(entity),
    incorporation_date: entity.registreringsdatoEnhetsregisteret ?? entity.stiftelsesdato ?? null,
    address_country: countryCode(address.land),
    source_url: orgNumber ? `${BRREG_ENTITY}${orgNumber}` : BRREG_SEARCH,
  };
}

function registryError(company, registryUrl, error) {
  return {
    status: 'unavailable',
    command: 'registry',
    query: company,
    country: 'NO',
    registry_url: registryUrl,
    license: BRREG_LICENSE,
    error,
  };
}



function registryLink(country) {
  try {
    const data = JSON.parse(readFileSync(new URL('./country_capabilities.json', import.meta.url), 'utf8'));
    const entry = ((data.countries || {})[String(country || '').toLowerCase()] || {}).registry || {};
    return entry.url || null;
  } catch {
    return null;
  }
}

async function registryCommand(args) {
  const company = String(args.company || '').trim();
  if (!company) return { status: 'unavailable', command: 'registry', error: 'missing-company' };
  const rawCountry = String(args.country || '').trim();
  let country;
  if (rawCountry) {
    country = countryCode(rawCountry);
    if (country === null) {
      return {
        status: 'not-covered',
        command: 'registry',
        query: company,
        country: rawCountry,
        registry_url: null,
        license: BRREG_LICENSE,
        note: '无法识别国家；registry 目前只实现挪威（NO），不猜测',
      };
    }
  } else {
    country = 'NO';
  }
  const registryUrl = `${BRREG_SEARCH}?navn=${encodeURIComponent(company)}`;
  if (country !== 'NO') {
    return {
      status: 'not-covered',
      command: 'registry',
      query: company,
      country,
      registry_url: registryLink(country),
      license: BRREG_LICENSE,
      note: 'registry 目前只实现挪威（NO）；该国入口见 registry_url，或人工核实',
    };
  }

  let payload;
  let retrievedAt;
  if (args.fixtureJson) {
    try {
      payload = JSON.parse(readFileSync(args.fixtureJson, 'utf8'));
    } catch {
      return registryError(company, registryUrl, 'invalid-fixture');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return registryError(company, registryUrl, 'invalid-fixture');
    }
    if (payload.error) return registryError(company, registryUrl, String(payload.error));
    retrievedAt = payload.retrieved_at || 'fixture';
  } else if (args.online) {
    try {
      payload = await fetchJson(registryUrl, args.timeout * 1000);
    } catch (error) {
      const message = error && error.name === 'AbortError' ? 'timeout' : (error && error.code) || 'fetch-failed';
      return registryError(company, registryUrl, message);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return registryError(company, registryUrl, 'invalid-response');
    }
    retrievedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  } else {
    return {
      status: 'offline',
      command: 'registry',
      query: company,
      country: 'NO',
      registry_url: registryUrl,
      license: BRREG_LICENSE,
      note: '加 --online 或 --fixture-json 查询；离线只给链接',
    };
  }

  const entities = ((payload._embedded && payload._embedded.enheter) || []).filter((item) => item && typeof item === 'object');
  const wanted = normalizeCompany(company);
  const entries = entities.filter((entity) => normalizeCompany(entity.navn) === wanted).map(registryEntry);
  const base = {
    command: 'registry',
    query: company,
    country: 'NO',
    registry_url: registryUrl,
    license: BRREG_LICENSE,
    retrieved_at: retrievedAt,
  };
  if (entries.length === 0) return { status: 'not-found', ...base };
  if (entries.length > 1) return { status: 'ambiguous', ...base, candidates: entries };
  const entry = entries[0];
  const claimed = countryCode(args.claimedCountry);
  const mismatch = claimed !== null && entry.address_country !== null && claimed !== entry.address_country;
  return { status: 'found', ...base, ...entry, country_mismatch: mismatch };
}

const DISCOVERY_TEMPLATES = [
  '“<country> company registry official site” + “<country> 公司登记 官方网站”',
  '“<country> business register ministry of justice / commerce / economy”',
  '“<country> tax authority taxpayer verification”',
  '“<country> government procurement portal”',
  '“<country> insolvency register official”',
];

function validateCapabilities(data) {
  const errors = [];
  const allowedVerification = new Set(['official-page', 'secondary-source', 'unverified', 'discovered']);
  const allowedChecksum = new Set(['none', 'gstin-mod36', 'pan-structure']);
  if (data.schema_version !== '0.6.0') errors.push('schema_version');
  if (Object.keys(data.countries || {}).length === 0) errors.push('countries:empty');
  for (const [code, country] of Object.entries(data.countries || {})) {
    if (!country || typeof country !== 'object') { errors.push(`${code}:not-object`); continue; }
    if (!country.registry || typeof country.registry !== 'object') errors.push(`${code}:registry`);
    if (!allowedVerification.has(country.verification)) errors.push(`${code}:verification`);
    for (const key of ['registry', 'tax_verification', 'procurement', 'insolvency']) {
      const item = country[key];
      if (item !== undefined && item !== null && (typeof item !== 'object' || (item.verification !== undefined && !allowedVerification.has(item.verification)))) errors.push(`${code}:${key}`);
    }
    for (const fmt of country.id_formats || []) {
      if (!fmt.id_type || !fmt.label || !Number.isInteger(fmt.length)) errors.push(`${code}:id_formats.fields`);
      const regexValue = fmt.regex || fmt.pattern;
      if (!String(regexValue || '').trim()) errors.push(`${code}:id_formats.regex-empty`);
      else {
        try { new RegExp(regexValue); } catch { errors.push(`${code}:id_formats.regex`); }
      }
      if (!allowedChecksum.has(fmt.checksum || 'none')) errors.push(`${code}:id_formats.checksum`);
    }
  }
  return errors;
}

function countryCommand(args) {
  let data;
  try {
    data = JSON.parse(readFileSync(new URL('./country_capabilities.json', import.meta.url), 'utf8'));
  } catch {
    return { status: 'unavailable', error: 'capabilities-unreadable' };
  }
  if (args.validate) {
    const errors = validateCapabilities(data);
    return { status: errors.length ? 'invalid-input' : 'ok', countries: Object.keys(data.countries || {}).length, errors };
  }
  const code = String(args.countryCode || '').trim().toUpperCase();
  if (!code) return { status: 'invalid-input', error: 'missing country code' };
  const country = (data.countries || {})[code.toLowerCase()];
  if (!country) {
    return {
      status: 'not-in-matrix',
      country: code,
      discovery: { used: 'discovery', verification: 'discovered', templates: DISCOVERY_TEMPLATES, note: '本次运行临时发现，不写回仓库；官方页面核对前只给链接和检索清单' },
      global_sources: data.global_sources || [],
    };
  }
  const registry = country.registry || {};
  return {
    status: 'ok',
    country: code,
    name: country.name || null,
    verification: country.verification || 'unverified',
    registry: {
      name: registry.name || null,
      url: registry.url || null,
      verification: registry.verification || country.verification || 'unverified',
      automation_allowed: registry.automation_allowed === true,
    },
    tax_verification: country.tax_verification || null,
    procurement: country.procurement || null,
    insolvency: country.insolvency || null,
    id_formats: country.id_formats || [],
    sources: country.sources || [],
    global_sources: data.global_sources || [],
    discovery: false,
  };
}

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GST_STATE_CODES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};
const PAN_ENTITY_TYPES = { P: 'individual', C: 'company', H: 'HUF', F: 'firm/LLP', A: 'AOP', T: 'trust', B: 'BOI', L: 'local-authority', J: 'artificial-juridical-person', G: 'government' };

function maskId(value) {
  const textValue = value === null || value === undefined ? '' : String(value);
  if (textValue.length <= 4) return '•'.repeat(textValue.length);
  return textValue.slice(0, 2) + '•'.repeat(textValue.length - 4) + textValue.slice(-2);
}

function gstinChecksum(value) {
  if (value.length < 14) return null;
  let total = 0;
  for (let index = 0; index < 14; index += 1) {
    const digit = ID_CHARS.indexOf(value[index]);
    if (digit < 0) return null;
    const product = digit * (index % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return ID_CHARS[(36 - (total % 36)) % 36];
}

function panEntityType(value) {
  return value && value.length >= 4 ? PAN_ENTITY_TYPES[value[3]] || 'unknown' : 'unknown';
}

function idcheckCommand(args) {
  const country = String(args.countryForId || '').toUpperCase();
  const idType = String(args.idType || '').toLowerCase();
  const value = String(args.idValue || '').trim().toUpperCase();
  let caps;
  try {
    caps = JSON.parse(readFileSync(new URL('./country_capabilities.json', import.meta.url), 'utf8'));
  } catch {
    return { status: 'unavailable', error: 'capabilities-unreadable' };
  }
  const entry = (caps.countries || {})[country.toLowerCase()] || {};
  const rule = (entry.id_formats || []).find((item) => (item.type || item.id_type) === idType);
  if (!rule || !value) {
    return { status: 'no-rule', command: 'idcheck', country, type: idType, masked: maskId(value), format_ok: null, checksum_ok: null, entity_type: null, name_suffix_consistent: null, notes: ['暂无已核对的格式规则'], mode: 'offline', rule_verification: null };
  }
  const pattern = rule.pattern || rule.regex;
  let formatOk = null;
  try {
    formatOk = pattern ? new RegExp(pattern).test(value) : null;
  } catch {
    return { status: 'invalid-input', command: 'idcheck', error: 'invalid-regex' };
  }
  let checksumOk = null;
  let entityType = null;
  const notes = [];
  let stateCode = null;
  if (formatOk === false) {
    checksumOk = false;
    notes.push('format-invalid');
  } else if (idType === 'gstin') {
    if (value.length !== 15 || value[13] !== 'Z') {
      checksumOk = false;
      notes.push('position-14-not-z');
    } else checksumOk = gstinChecksum(value) === value.slice(-1);
    entityType = panEntityType(value.slice(2, 12));
    stateCode = value.slice(0, 2);
    const stateName = GST_STATE_CODES[stateCode];
    if (!stateName) notes.push('state-code-unknown');
    else if (args.claimedState && normalizeCompany(args.claimedState) !== normalizeCompany(stateName)) notes.push('state-mismatch');
  } else if (idType === 'pan') {
    entityType = panEntityType(value);
  }
  const company = String(args.companyName || '').trim();
  let nameSuffixConsistent = null;
  if (company && entityType) {
    const corporate = ['PVT', 'PRIVATE', 'LTD', 'LIMITED', 'CORP', 'COMPANY'].some((token) => normalizeCompany(company).includes(token));
    const firm = ['LLP', 'PARTNERSHIP', 'FIRM'].some((token) => normalizeCompany(company).includes(token));
    const trust = normalizeCompany(company).includes('TRUST');
    if (entityType === 'company' && !corporate) nameSuffixConsistent = false;
    else if (entityType === 'individual' && corporate) nameSuffixConsistent = false;
    else if (entityType === 'firm/LLP' && (corporate || !firm)) nameSuffixConsistent = false;
    else if (entityType === 'trust' && !trust) nameSuffixConsistent = false;
    else nameSuffixConsistent = true;
  }
  return { status: 'ok', command: 'idcheck', country, type: idType, masked: maskId(value), format_ok: formatOk, checksum_ok: checksumOk, entity_type: entityType, name_suffix_consistent: nameSuffixConsistent, state_code: stateCode, notes, mode: 'offline', rule_verification: rule.verification || 'unverified' };
}

const MATCH_KEY_TYPES = ['legal_name', 'alias', 'address', 'tax_id_masked', 'phone', 'domain', 'person_name', 'registration_no'];

function normalizeMatchValue(key, value) {
  const raw = value === null || value === undefined ? '' : String(value).trim().toLowerCase();
  if (key === 'phone') return raw.replace(/\D/g, '');
  if (key === 'domain') return raw.replace(/^www\./, '');
  if (key === 'tax_id_masked' || key === 'registration_no') return raw.replace(/[^0-9a-z]/g, '');
  return raw.replace(/[^0-9a-z\u4e00-\u9fff ]/g, '').replace(/\s+/g, ' ').trim();
}

function loadMatchKeys(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return MATCH_KEY_TYPES.filter((key) => key in payload).map((key) => [key, payload[key], key === 'alias' ? payload.alias_source : null]);
  }
  if (Array.isArray(payload)) {
    return payload
      .filter((item) => item && typeof item === 'object' && MATCH_KEY_TYPES.includes(item.key))
      .map((item) => [item.key, item.value, item.key === 'alias' ? item.alias_source : null]);
  }
  return [];
}

function matchCommand(args) {
  let buyer;
  let candidate;
  try {
    buyer = loadMatchKeys(JSON.parse(readFileSync(args.buyerJson, 'utf8')));
    candidate = loadMatchKeys(JSON.parse(readFileSync(args.candidateJson, 'utf8')));
  } catch {
    return { status: 'invalid-input', error: 'invalid match input' };
  }
  const buyerMap = new Map(buyer.filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => [key, normalizeMatchValue(key, value)]));
  const candidateMap = new Map(candidate.filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => [key, normalizeMatchValue(key, value)]));
  const buyerAlias = (buyer.find(([key]) => key === 'alias') || [])[2];
  const candidateAlias = (candidate.find(([key]) => key === 'alias') || [])[2];
  let keys = [...buyerMap.keys()].filter((key) => candidateMap.has(key) && buyerMap.get(key) && buyerMap.get(key) === candidateMap.get(key)).sort();
  if (keys.includes('alias') && !(buyerAlias === 'official' && candidateAlias === 'official')) keys = keys.filter((key) => key !== 'alias');
  const nameKeys = new Set(['legal_name', 'alias', 'person_name']);
  const strongKeys = new Set(['address', 'tax_id_masked', 'phone', 'domain', 'registration_no']);
  const hasName = keys.some((key) => nameKeys.has(key));
  const hasStrong = keys.some((key) => strongKeys.has(key));
  const matched = (hasName && hasStrong) || (keys.includes('domain') && keys.includes('phone'));
  let reason;
  let strength;
  if (!matched) {
    reason = keys.every((key) => nameKeys.has(key)) ? 'only-name' : 'fewer-than-two-independent-keys';
    strength = 'weak';
  } else if (keys.length >= 3 || (hasName && (keys.includes('registration_no') || keys.includes('tax_id_masked')))) {
    reason = hasName ? 'name-plus-strong-key' : 'domain-plus-phone';
    strength = 'strong';
  } else {
    reason = hasName ? 'name-plus-other' : 'domain-plus-phone';
    strength = 'medium';
  }
  return { status: 'ok', matched, keys_matched: keys, strength, reason };
}

function keywordsCommand(args) {
  const textValue = String(args.text || '').toLowerCase();
  const languages = String(args.languages || 'en').split(',').map((item) => item.trim()).filter(Boolean);
  let caps;
  try {
    caps = JSON.parse(readFileSync(new URL('./country_capabilities.json', import.meta.url), 'utf8'));
  } catch {
    return { status: 'unavailable', error: 'capabilities-unreadable' };
  }
  const groups = caps.multilingual_keywords || {};
  const matches = [];
  for (const language of languages) {
    for (const [probe, words] of Object.entries(groups[language] || {})) {
      for (const word of words) {
        if (textValue.includes(String(word).toLowerCase())) matches.push({ language, probe, keyword: word });
      }
    }
  }
  return { status: 'ok', matches, languages, meta: groups.meta };
}

function usage() {
  return [
    'Usage: node identity_check.mjs site [--domain DOMAIN] [--html-file FILE] [--online]',
    '       node identity_check.mjs backlink --domain DOMAIN (--text TEXT | --html-file FILE)',
    '       node identity_check.mjs image PATH1 PATH2 [PATH3 ...]',
    '       node identity_check.mjs map --company NAME [--phone PHONE] [--online | --fixture-json FILE]',
    '       node identity_check.mjs registry --company NAME [--country NO] [--claimed-country NO] [--online | --fixture-json FILE]',
    '       node identity_check.mjs country --code IN',
    '       node identity_check.mjs idcheck --country IN --type gstin --value 27AAACA0000A1ZY [--company-name NAME] [--claimed-state STATE]',
    '       node identity_check.mjs match --buyer-json FILE --candidate-json FILE',
    '       node identity_check.mjs keywords --text TEXT [--languages en,ar,vi,id]',
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0];
  const args = { command, domain: null, htmlFile: null, online: false, maxPages: 4, delay: 1, timeout: 10, text: '', paths: [], company: null, phone: null, country: null, claimedCountry: null, countryCode: null, validate: false, googleKey: null, fixtureJson: null, fixtureSource: 'google_places', limit: 5, countryForId: null, idType: null, idValue: null, companyName: null, claimedState: null, buyerJson: null, candidateJson: null, languages: null };
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--domain') args.domain = argv[++i];
    else if (token === '--html-file') args.htmlFile = argv[++i];
    else if (token === '--online') args.online = true;
    else if (token === '--max-pages') args.maxPages = Number(argv[++i]);
    else if (token === '--delay') args.delay = Number(argv[++i]);
    else if (token === '--timeout') args.timeout = Number(argv[++i]);
    else if (token === '--text') args.text = argv[++i];
    else if (token === '--company') args.company = argv[++i];
    else if (token === '--phone') args.phone = argv[++i];
    else if (token === '--country') { const value = argv[++i]; args.country = value; args.countryForId = value; }
    else if (token === '--claimed-country') args.claimedCountry = argv[++i];
    else if (token === '--code') args.countryCode = argv[++i];
    else if (token === '--validate') args.validate = true;
    else if (token === '--type') args.idType = argv[++i];
    else if (token === '--value') args.idValue = argv[++i];
    else if (token === '--company-name') args.companyName = argv[++i];
    else if (token === '--claimed-state') args.claimedState = argv[++i];
    else if (token === '--buyer-json') args.buyerJson = argv[++i];
    else if (token === '--candidate-json') args.candidateJson = argv[++i];
    else if (token === '--languages') args.languages = argv[++i];
    else if (token === '--google-key') args.googleKey = argv[++i];
    else if (token === '--fixture-json') args.fixtureJson = argv[++i];
    else if (token === '--fixture-source') args.fixtureSource = argv[++i];
    else if (token === '--limit') args.limit = Number(argv[++i]);
    else if (!token.startsWith('--')) args.paths.push(token);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!['site', 'backlink', 'image', 'map', 'registry', 'country', 'idcheck', 'match', 'keywords'].includes(args.command)) {
    console.log(JSON.stringify({ status: 'unavailable', error: 'unknown or missing subcommand' }));
    return 2;
  }
  let result;
  if (args.command === 'site') result = await siteCommand(args);
  else if (args.command === 'backlink') result = backlinkCommand(args);
  else if (args.command === 'map') result = await mapCommand(args);
  else if (args.command === 'registry') result = await registryCommand(args);
  else if (args.command === 'country') result = countryCommand(args);
  else if (args.command === 'idcheck') result = idcheckCommand(args);
  else if (args.command === 'match') result = matchCommand(args);
  else if (args.command === 'keywords') result = keywordsCommand(args);
  else result = await imageCommand(args);
  console.log(JSON.stringify(result));
  return ['ok', 'found', 'not-found', 'ambiguous', 'offline', 'not-in-matrix', 'no-rule'].includes(result.status) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
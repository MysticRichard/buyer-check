#!/usr/bin/env node
/**
 * IP origin classification for buyer-check (v0.7.0).
 *
 * Mirrors ip_check.py. Private / loopback / reserved addresses are skipped,
 * documentation ranges are kept for offline examples, and a public IP is only
 * looked up when --online is explicitly passed. Online lookup uses public RIR
 * RDAP data only; no third-party geolocation service is contacted.
 *
 * The output never contains the full IP, only the masked network (IPv4 /24,
 * IPv6 /48), country, ASN, organisation and network type.
 *
 * Usage:
 *   node ip_check.mjs --ip 203.0.113.7 --claimed-country AE
 *   node ip_check.mjs --ip 203.0.113.7 --claimed-country AE --rdap-json ../tests/fixtures/ip-rdap-sample.json
 *   node ip_check.mjs --ip 203.0.113.7 --claimed-country AE --online
 *
 * Output is JSON on stdout. Errors return status "unavailable".
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(HERE, 'ip_ranges.json');
const RDAP_BASE = 'https://rdap.org/ip/';
const FIXTURE_TIME = '2026-10-27T00:00:00Z';

function loadTable(path = DATA_FILE) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function normalizeClaimed(value) {
  const text = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

function parseIPv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (nums.some((num) => Number.isNaN(num) || num < 0 || num > 255)) return null;
  return nums;
}

function parseIPv6(text) {
  const halves = text.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (tail === null) {
    groups = head;
    if (groups.length !== 8) return null;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }
  const nums = groups.map((group) => (group === '' ? NaN : parseInt(group, 16)));
  if (nums.some((num) => Number.isNaN(num) || num < 0 || num > 0xffff)) return null;
  return nums;
}

function compressIPv6(groups) {
  const hex = groups.map((num) => num.toString(16));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (hex[i] === '0') {
      let j = i;
      while (j < 8 && hex[j] === '0') j += 1;
      if (j - i > bestLen) {
        bestStart = i;
        bestLen = j - i;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  if (bestLen < 2) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}

function isNonPublicIPv4(parts) {
  const [a, b, c] = parts;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 0 || a >= 224) return true;
  return false;
}

function isNonPublicIPv6(groups) {
  if (groups.every((num) => num === 0)) return true;
  if (groups.slice(0, 7).every((num) => num === 0) && groups[7] === 1) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xff00) === 0xff00) return true;
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;
  return false;
}

function inspectIp(text) {
  const version = isIP(text);
  if (version === 4) {
    const parts = parseIPv4(text);
    if (!parts) return null;
    return {
      version,
      masked: `${parts[0]}.${parts[1]}.${parts[2]}.0/24`,
      nonPublic: isNonPublicIPv4(parts),
    };
  }
  if (version === 6) {
    const groups = parseIPv6(text);
    if (!groups) return null;
    const maskedGroups = [groups[0], groups[1], groups[2], 0, 0, 0, 0, 0];
    return {
      version,
      masked: `${compressIPv6(maskedGroups)}/48`,
      nonPublic: isNonPublicIPv6(groups),
    };
  }
  return null;
}

function vcardText(vcard) {
  const values = [];
  if (!Array.isArray(vcard) || vcard.length < 2 || !Array.isArray(vcard[1])) return values;
  for (const item of vcard[1]) {
    if (Array.isArray(item) && item.length >= 4 && (item[0] === 'fn' || item[0] === 'org')) {
      values.push(String(item[3]));
    }
  }
  return values;
}

function parseRdap(payload) {
  const network = payload.network && typeof payload.network === 'object' ? payload.network : payload;
  const country = typeof network.country === 'string' && /^[A-Za-z]{2}$/.test(network.country)
    ? network.country.toUpperCase()
    : null;
  let org = null;
  let asn = null;
  for (const entity of network.entities || []) {
    for (const text of vcardText(entity.vcardArray)) {
      if (text && !org) org = text;
    }
    for (const publicId of entity.publicIds || []) {
      if (String(publicId.type || '').toUpperCase() === 'ASN') {
        const identifier = String(publicId.identifier || '').toUpperCase().replace(/^AS/, '');
        if (identifier) asn = `AS${identifier}`;
      }
    }
  }
  if (!asn && typeof payload.asn === 'string' && /^AS/i.test(payload.asn)) {
    asn = payload.asn.toUpperCase();
  }
  return { country, name: network.name, org, asn };
}

function matchEntry(parsed, entries) {
  const asn = String(parsed.asn || '').toUpperCase();
  const haystack = [parsed.org, parsed.name].filter(Boolean).join(' ').toLowerCase();
  for (const entry of entries) {
    if (asn && asn === String(entry.asn || '').toUpperCase()) return entry;
    if ((entry.match || []).some((word) => haystack.includes(word))) return entry;
  }
  return null;
}

function classifyNetwork(parsed, table) {
  if (matchEntry(parsed, table.mail_providers || [])) return 'mail_provider';
  if (matchEntry(parsed, table.hosting || [])) return 'hosting_or_anonymized';
  return 'unknown';
}

async function fetchRdap(ipText, timeoutSeconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetch(RDAP_BASE + ipText, {
      headers: { Accept: 'application/rdap+json', 'User-Agent': 'buyer-check/0.7.0' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function analyse(rawIp, options = {}) {
  const table = options.table || loadTable();
  const claimedCountry = normalizeClaimed(options.claimed);
  const result = {
    status: 'skipped',
    reason: null,
    ip_masked: null,
    country: null,
    asn: null,
    org: null,
    net_type: 'unknown',
    claimed_country: claimedCountry,
    consistent: null,
    source: null,
    retrieved_at: null,
  };

  const raw = String(rawIp || '').trim();
  if (!raw) {
    result.reason = 'no_ip';
    return result;
  }

  const inspected = inspectIp(raw);
  if (!inspected) {
    result.reason = 'invalid_ip';
    return result;
  }

  result.ip_masked = inspected.masked;
  if (inspected.nonPublic) {
    result.reason = 'non_public';
    result.net_type = 'non_public';
    return result;
  }

  let payload;
  if (options.fixturePath) {
    try {
      payload = JSON.parse(readFileSync(options.fixturePath, 'utf8'));
    } catch {
      payload = null;
    }
    if (!payload) {
      result.status = 'unavailable';
      result.reason = 'fixture_error';
      return result;
    }
    result.source = `fixture:${basename(options.fixturePath)}`;
    result.retrieved_at = payload.retrieved_at || FIXTURE_TIME;
  } else if (options.online) {
    payload = await fetchRdap(raw, options.timeout || 10);
    if (!payload) {
      result.status = 'unavailable';
      result.reason = 'rdap_error';
      return result;
    }
    result.source = RDAP_BASE;
    result.retrieved_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  } else {
    result.status = 'offline';
    result.reason = 'online_not_requested';
    return result;
  }

  const parsed = parseRdap(payload);
  result.net_type = classifyNetwork(parsed, table);
  result.status = 'ok';
  result.asn = parsed.asn;
  result.org = parsed.org;
  if (result.net_type === 'mail_provider' || result.net_type === 'hosting_or_anonymized') {
    result.country = null;
    result.consistent = null;
  } else {
    result.country = parsed.country;
    if (result.country && claimedCountry) {
      result.consistent = result.country === claimedCountry;
    }
  }
  return result;
}

function usage() {
  return [
    'Usage: node ip_check.mjs [--ip ADDRESS] [--claimed-country ISO2] [--online]',
    '                           [--rdap-json FILE] [--timeout SECONDS]',
    '',
    'Classifies an e-mail originating IP. Offline by default; --online sends',
    'only the IP to public RIR RDAP data. The output never contains the full IP.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { ip: '', claimed: '', online: false, fixturePath: null, timeout: 10, help: false, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--ip') options.ip = argv[++i] ?? '';
    else if (arg === '--claimed-country') options.claimed = argv[++i] ?? '';
    else if (arg === '--online') options.online = true;
    else if (arg === '--rdap-json') options.fixturePath = argv[++i] ?? null;
    else if (arg === '--timeout') options.timeout = Number(argv[++i] ?? 10);
    else options.error = `unknown argument: ${arg}`;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.error) {
    console.log(JSON.stringify({ status: 'unavailable', error: options.error }));
    return 2;
  }
  const result = await analyse(options.ip, options);
  console.log(JSON.stringify(result));
  return result.status === 'unavailable' ? 1 : 0;
}

main().then((code) => process.exit(code));
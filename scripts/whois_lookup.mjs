#!/usr/bin/env node
/**
 * Domain RDAP/WHOIS and DNS lookup for buyer-check (Node port).
 *
 * Retrieves registration date, registrar, status codes and nameservers via
 * RDAP and the MX/SPF/DMARC records via DNS over HTTPS. Feeds RF-DOM-002
 * (domain too new) and RF-MAIL-001 (mail configuration).
 *
 * Usage:
 *   node whois_lookup.mjs example.com
 *   node whois_lookup.mjs example.com --rdap-json ./fixture.json   # offline
 *
 * Output is JSON on stdout; on total failure it returns status "unavailable"
 * so the caller reports "未查到" instead of guessing.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const NEW_DOMAIN_DAYS = 180;
const RDAP_ENDPOINT = 'https://rdap.org/domain/';
const DOH_ENDPOINT = 'https://dns.google/resolve';

async function httpJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'buyer-check/0.1' },
      signal: controller.signal,
    });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function parseRdap(payload) {
  const result = { registration_date: null, registrar: null, status: [], nameservers: [] };
  for (const event of payload.events || []) {
    if (event.eventAction === 'registration') result.registration_date = event.eventDate;
  }
  for (const entity of payload.entities || []) {
    if ((entity.roles || []).includes('registrar')) {
      const vcard = (entity.vcardArray || [[], []])[1] || [];
      for (const item of vcard) {
        if (Array.isArray(item) && item[0] === 'fn') result.registrar = item[3];
      }
    }
  }
  result.status = payload.status || [];
  result.nameservers = (payload.nameservers || []).map((ns) => (ns.ldhName || '').toLowerCase()).filter(Boolean);
  return result;
}

export function computeAgeDays(registrationDate) {
  if (!registrationDate) return null;
  const parsed = new Date(String(registrationDate).replace('Z', '+00:00'));
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.floor((Date.now() - parsed.getTime()) / 86400000);
}

async function dnsLookup(name, type, timeoutMs) {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
  try {
    const payload = await httpJson(url, timeoutMs);
    return (payload.Answer || []).map((item) => (item.data || '').replace(/^"|"$/g, ''));
  } catch {
    return [];
  }
}

export async function analyse(domain, options = {}) {
  const timeoutMs = (options.timeoutSeconds ?? 10) * 1000;
  const result = {
    domain,
    registration_date: null,
    registrar: null,
    status_codes: [],
    nameservers: [],
    dns: { mx: [], spf: [], dmarc: [] },
    age_days: null,
    is_new_domain: null,
    sources: [],
    errors: [],
  };

  if (!/^[A-Za-z0-9.-]+$/.test(domain || '')) {
    result.errors.push('invalid domain syntax');
    return result;
  }

  if (options.rdapJson) {
    try {
      const parsed = parseRdap(JSON.parse(readFileSync(options.rdapJson, 'utf8')));
      Object.assign(result, {
        registration_date: parsed.registration_date,
        registrar: parsed.registrar,
        status_codes: parsed.status,
        nameservers: parsed.nameservers,
      });
      result.sources.push('rdap-fixture');
    } catch (error) {
      result.errors.push(`rdap-fixture: ${error}`);
    }
  } else {
    try {
      const parsed = parseRdap(await httpJson(RDAP_ENDPOINT + encodeURIComponent(domain), timeoutMs));
      Object.assign(result, {
        registration_date: parsed.registration_date,
        registrar: parsed.registrar,
        status_codes: parsed.status,
        nameservers: parsed.nameservers,
      });
      result.sources.push('rdap');
    } catch (error) {
      result.errors.push(`rdap: ${error}`);
    }
  }

  if (!options.rdapJson) {
    result.dns.mx = await dnsLookup(domain, 'MX', timeoutMs);
    result.dns.spf = (await dnsLookup(domain, 'TXT', timeoutMs)).filter((record) => record.includes('v=spf1'));
    result.dns.dmarc = (await dnsLookup(`_dmarc.${domain}`, 'TXT', timeoutMs)).filter((record) =>
      record.includes('v=DMARC1'),
    );
    if (result.dns.mx.length || result.dns.spf.length || result.dns.dmarc.length) result.sources.push('dns.google');
  }

  result.age_days = computeAgeDays(result.registration_date);
  result.is_new_domain = result.age_days === null ? null : result.age_days < NEW_DOMAIN_DAYS;
  return result;
}

function parseArgs(argv) {
  const args = { domain: null, timeoutSeconds: 10, rdapJson: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--timeout') args.timeoutSeconds = Number(argv[++i]);
    else if (token === '--rdap-json') args.rdapJson = argv[++i];
    else if (!token.startsWith('--')) args.domain = token;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.domain) {
    console.log(JSON.stringify({ status: 'error', error: 'missing domain argument' }));
    return 1;
  }
  const result = await analyse(args.domain, args);
  result.status = result.registration_date === null && result.sources.length === 0 ? 'unavailable' : 'ok';
  console.log(JSON.stringify(result));
  return result.status === 'ok' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
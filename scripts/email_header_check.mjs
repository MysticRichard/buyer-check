#!/usr/bin/env node
/**
 * Email header analysis for buyer-check (Node port).
 *
 * Parses a pasted raw email header block and reports From / Reply-To /
 * Return-Path identities, the originating IP visible in the first Received hop
 * (null when the provider strips it — never guessed), the sending timezone,
 * and SPF / DKIM / DMARC results from Authentication-Results. Mismatches
 * between the From domain and the Reply-To / Return-Path domains feed
 * RF-MAIL-001. Must stay output-identical with email_header_check.py.
 *
 * Usage:
 *   node email_header_check.mjs --file header.txt
 *   echo "<raw header>" | node email_header_check.mjs --stdin
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const TZ_RE = /([+-]\d{4})\s*$/;
const AUTH_RES = { spf: /spf=([a-zA-Z]+)/i, dkim: /dkim=([a-zA-Z]+)/i, dmarc: /dmarc=([a-zA-Z]+)/i };
const PRIVATE_IP_RE = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

export function unfold(raw = '') {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const headers = [];
  let current = null;
  for (const line of lines) {
    if (!line.trim()) {
      if (current !== null) {
        headers.push(current);
        current = null;
      }
      continue;
    }
    if ((line.startsWith(' ') || line.startsWith('\t')) && current !== null) {
      current += ` ${line.trim()}`;
    } else if (line.includes(':')) {
      if (current !== null) headers.push(current);
      current = line;
    }
  }
  if (current !== null) headers.push(current);
  return headers;
}

export function splitHeader(line) {
  const idx = line.indexOf(':');
  if (idx === -1) return [null, ''];
  return [line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim()];
}

export function extractEmail(value = '') {
  const match = String(value).match(EMAIL_RE);
  return match ? match[0] : null;
}

export function domainOf(email) {
  if (!email || !email.includes('@')) return null;
  return email.split('@')[1].toLowerCase();
}

export function parseReceived(value = '') {
  const ips = (String(value).match(IP_RE) || []).filter((ip) => !PRIVATE_IP_RE.test(ip));
  const tz = String(value).match(TZ_RE);
  return { ip: ips.length ? ips[0] : null, timezone_offset: tz ? tz[1] : null };
}

export function analyse(raw = '') {
  const result = {
    from: null,
    from_domain: null,
    reply_to: null,
    reply_to_domain: null,
    return_path: null,
    return_path_domain: null,
    originating_ip: null,
    sending_timezone_offset: null,
    auth: { spf: null, dkim: null, dmarc: null },
    received_hops: 0,
    inconsistencies: [],
  };

  const receivedValues = [];
  for (const line of unfold(raw)) {
    const [name, value] = splitHeader(line);
    if (name === 'from') {
      result.from = extractEmail(value);
      result.from_domain = domainOf(result.from);
    } else if (name === 'reply-to') {
      result.reply_to = extractEmail(value);
      result.reply_to_domain = domainOf(result.reply_to);
    } else if (name === 'return-path') {
      result.return_path = extractEmail(value);
      result.return_path_domain = domainOf(result.return_path);
    } else if (name === 'received') {
      receivedValues.push(value);
    } else if (name === 'authentication-results') {
      const auth = {};
      for (const key of Object.keys(AUTH_RES)) {
        const m = String(value).match(AUTH_RES[key]);
        auth[key] = m ? m[1].toLowerCase() : null;
      }
      result.auth = auth;
    }
  }

  result.received_hops = receivedValues.length;
  if (receivedValues.length) {
    const bottom = parseReceived(receivedValues[receivedValues.length - 1]);
    const top = parseReceived(receivedValues[0]);
    result.originating_ip = bottom.ip || top.ip;
    result.sending_timezone_offset = bottom.timezone_offset || top.timezone_offset;
  }

  if (result.from_domain && result.reply_to_domain && result.from_domain !== result.reply_to_domain) {
    result.inconsistencies.push(`reply_to_domain_mismatch: from ${result.from_domain} vs reply-to ${result.reply_to_domain}`);
  }
  if (result.from_domain && result.return_path_domain && result.from_domain !== result.return_path_domain) {
    result.inconsistencies.push(`return_path_domain_mismatch: from ${result.from_domain} vs return-path ${result.return_path_domain}`);
  }
  if (result.auth.spf === 'fail' || result.auth.spf === 'softfail') {
    result.inconsistencies.push(`spf_${result.auth.spf}`);
  }
  if (result.auth.dmarc === 'fail') {
    result.inconsistencies.push('dmarc_fail');
  }
  return result;
}

function parseArgs(argv) {
  const args = { file: null, stdin: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--file') args.file = argv[++i];
    else if (token === '--stdin') args.stdin = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let raw = '';
  if (args.file) {
    try {
      raw = readFileSync(args.file, 'utf8');
    } catch (error) {
      console.log(JSON.stringify({ status: 'unavailable', error: String(error) }));
      return 1;
    }
  } else if (args.stdin) {
    raw = readFileSync(0, 'utf8');
  } else {
    console.log(JSON.stringify({ status: 'error', error: 'no input: pass --file or --stdin' }));
    return 2;
  }
  console.log(JSON.stringify({ ...analyse(raw), status: 'ok' }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
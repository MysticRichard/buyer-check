#!/usr/bin/env node
/**
 * Phone number sanity check for buyer-check (Node port).
 *
 * Parses a phone number against a local ITU E.164 calling-code table (no
 * network, no third-party dependency) and reports the country, whether the
 * national length is plausible, the line type when the prefix is known
 * (mobile prefixes only reported when the table carries them; otherwise
 * "unknown" — never guessed), and whether the number matches the claimed
 * country. Must stay output-identical with phone_check.py.
 *
 * Usage:
 *   node phone_check.mjs "+971 52 555 0100" --country AE
 *   node phone_check.mjs "008618812345678"
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(DIR, 'phone_check_data.json');

const NANP_ISO2 = ['US', 'CA'];

export function loadData(path = DATA_FILE) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function normalize(raw = '') {
  const text = String(raw).trim();
  const hadPlus = text.startsWith('+');
  const had00 = text.startsWith('00');
  let digits = text.replace(/[^\d]/g, '');
  let used00 = false;
  if (had00 && !hadPlus) {
    digits = digits.slice(2);
    used00 = true;
  }
  return { digits, used00, hadPlus };
}

export function matchCountry(digits, data) {
  let best = null;
  for (const entry of data.countries) {
    if (digits.startsWith(entry.code)) {
      if (best === null || entry.code.length > best.code.length) best = entry;
    }
  }
  return best;
}

export function lineType(entry, national) {
  if (!entry || !entry.mobile_prefixes) return 'unknown';
  for (const prefix of entry.mobile_prefixes) {
    if (national.startsWith(prefix)) return 'mobile';
  }
  return 'fixed_or_unknown';
}

export function analyse(raw, claimed, data) {
  const { digits, used00 } = normalize(raw);
  const result = {
    input: raw,
    normalized: null,
    valid: false,
    invalid_reason: null,
    country_code: null,
    country: null,
    country_name: null,
    line_type: 'unknown',
    claimed_country: claimed ? String(claimed).toUpperCase() : null,
    matches_claimed_country: null,
    format_hint: null,
  };

  if (!digits) {
    result.invalid_reason = 'no digits found';
    return result;
  }

  const entry = matchCountry(digits, data);
  if (entry === null) {
    result.invalid_reason = 'calling code not found in local table';
    return result;
  }

  const national = digits.slice(entry.code.length);
  result.country_code = entry.code;
  result.country = entry.iso2;
  result.country_name = entry.name;
  result.normalized = `+${entry.code}${national}`;

  let lengthOk;
  if (entry.nanp) {
    lengthOk = national.length === entry.national_length;
    result.country = 'US/CA';
    result.country_name = 'United States / Canada (NANP)';
  } else if ('min_length' in entry) {
    lengthOk = entry.min_length <= national.length && national.length <= entry.max_length;
  } else {
    lengthOk = null;
  }

  result.valid = lengthOk === null ? null : Boolean(lengthOk);
  if (lengthOk === false) {
    result.invalid_reason = 'national number length out of expected range';
  } else if (lengthOk === null) {
    result.invalid_reason = 'length rule not covered for this country';
  }

  result.line_type = lineType(entry, national);
  result.format_hint = 'prefers E.164 (+<code><national>)';
  if (used00) result.format_hint = 'converted 00 prefix to +';

  if (result.claimed_country) {
    if (entry.nanp) {
      result.matches_claimed_country = NANP_ISO2.includes(result.claimed_country);
    } else {
      result.matches_claimed_country = result.claimed_country === entry.iso2;
    }
  }
  return result;
}

function parseArgs(argv) {
  const args = { number: null, country: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--country') args.country = argv[++i];
    else if (!token.startsWith('--')) args.number = token;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.number) {
    console.log(JSON.stringify({ status: 'error', error: 'missing number argument' }));
    return 1;
  }
  let data;
  try {
    data = loadData();
  } catch (error) {
    console.log(JSON.stringify({ status: 'unavailable', error: String(error) }));
    return 1;
  }
  const result = { ...analyse(args.number, args.country, data), status: 'ok' };
  console.log(JSON.stringify(result));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
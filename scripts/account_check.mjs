#!/usr/bin/env node
/**
 * Receiving account sanity check for buyer-check (Node port, pre-order stage).
 *
 * Validates an IBAN structure and its mod-97 check digits using the public
 * ISO 13616 algorithm implemented here directly (no third-party library),
 * parses a BIC/SWIFT code, and compares the account country chain: IBAN
 * country vs BIC country vs the buyer's claimed country. Feeds RF-ACC-002.
 * Must stay output-identical with account_check.py.
 *
 * Account numbers are NEVER stored or echoed in full: output carries a masked
 * form only (first 4 + last 4).
 *
 * Usage:
 *   node account_check.mjs --iban "GB82 WEST 1234 5698 7654 32" --bic "EBILGB2L" --country GB
 */

import { fileURLToPath, pathToFileURL } from 'node:url';

const IBAN_LENGTHS = {
  AE: 23, SA: 24, QA: 29, KW: 30, BH: 22, LB: 28, JO: 30, IL: 23, TR: 26,
  GB: 22, DE: 22, FR: 27, NL: 18, BE: 16, ES: 24, IT: 27, PT: 25, IE: 22,
  CH: 21, AT: 20, SE: 24, NO: 15, DK: 18, FI: 18, PL: 28, CZ: 24, SK: 24,
  HU: 28, RO: 24, BG: 22, GR: 27, CY: 28, HR: 21, SI: 19, LT: 20, LV: 21,
  EE: 20, MA: 28, TN: 24, DZ: 26, PK: 24, EG: 29, OM: 0,
};

const BIC_RE = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;
const IBAN_CC_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/;

export function stripSpaces(value = '') {
  return String(value).toUpperCase().replace(/[\s-]/g, '');
}

export function mask(iban) {
  if (!iban) return null;
  if (iban.length <= 8) return '*'.repeat(iban.length);
  return `${iban.slice(0, 4)}****${iban.slice(-4)}`;
}

export function mod97(digits) {
  let remainder = 0;
  for (const char of digits) {
    remainder = (remainder * 10 + Number(char)) % 97;
  }
  return remainder;
}

export function charToDigits(text) {
  let out = '';
  for (const char of text) {
    if (char >= '0' && char <= '9') {
      out += char;
    } else if (char >= 'A' && char <= 'Z') {
      out += String(char.charCodeAt(0) - 'A'.charCodeAt(0) + 10);
    } else {
      throw new Error(`invalid character in IBAN: ${char}`);
    }
  }
  return out;
}

export function computeCheckDigits(country, bban) {
  const numeric = charToDigits(`${bban}${country}00`);
  const check = 98 - mod97(numeric);
  return String(check).padStart(2, '0');
}

export function checkIban(raw) {
  const result = {
    present: Boolean(raw),
    masked: null,
    country: null,
    check_digits_ok: null,
    structure_ok: null,
    length_ok: null,
    expected_length: null,
    valid: false,
    invalid_reason: null,
  };
  if (!raw) return result;
  const iban = stripSpaces(raw);
  result.masked = mask(iban);

  if (iban.length < 5 || !IBAN_CC_RE.test(iban)) {
    result.structure_ok = false;
    result.invalid_reason = 'IBAN structure invalid (expect CC + 2 check digits + BBAN)';
    return result;
  }
  result.structure_ok = true;
  result.country = iban.slice(0, 2);
  result.expected_length = IBAN_LENGTHS[result.country] ?? null;

  if (result.expected_length === 0) {
    result.length_ok = null;
    result.invalid_reason = 'country uses plain account numbers, IBAN not standard';
  } else if (result.expected_length === null || result.expected_length === undefined) {
    result.length_ok = null;
  } else {
    result.length_ok = iban.length === result.expected_length;
    if (!result.length_ok) {
      result.invalid_reason = `length ${iban.length} does not match expected ${result.expected_length}`;
    }
  }

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let numeric;
  try {
    numeric = charToDigits(rearranged);
  } catch (error) {
    result.check_digits_ok = false;
    result.invalid_reason = String(error.message || error);
    return result;
  }
  result.check_digits_ok = mod97(numeric) === 1;
  if (!result.check_digits_ok && !result.invalid_reason) {
    result.invalid_reason = 'mod-97 check digits failed';
  }

  result.valid = Boolean(
    result.structure_ok && result.check_digits_ok && result.length_ok !== false,
  );
  return result;
}

export function checkBic(raw) {
  const result = {
    present: Boolean(raw),
    masked: null,
    format_ok: null,
    bank_code: null,
    country: null,
    location_code: null,
    branch_code: null,
  };
  if (!raw) return result;
  const bic = stripSpaces(raw);
  result.masked = bic.length > 8 ? `${bic.slice(0, 4)}****` : bic;
  result.format_ok = BIC_RE.test(bic);
  if (result.format_ok) {
    result.bank_code = bic.slice(0, 4);
    result.country = bic.slice(4, 6);
    result.location_code = bic.slice(6, 8);
    result.branch_code = bic.slice(8) || null;
  }
  return result;
}

export function analyse(iban, bic, claimed) {
  const ibanResult = checkIban(iban);
  const bicResult = checkBic(bic);
  const claimedCountry = claimed ? String(claimed).toUpperCase() : null;

  const mismatches = [];
  const accountCountry = ibanResult.country || bicResult.country;

  if (ibanResult.country && bicResult.country && ibanResult.country !== bicResult.country) {
    mismatches.push(`bic_vs_iban: IBAN country ${ibanResult.country} vs BIC country ${bicResult.country}`);
  }
  if (claimedCountry && accountCountry && accountCountry !== claimedCountry) {
    mismatches.push(
      `account_vs_claimed: account country ${accountCountry} vs buyer claimed ${claimedCountry} (RF-ACC-002 candidate; ` +
        'plausible explanations such as a group treasury in a third country must be weighed by the model before scoring)',
    );
  }

  return {
    iban: ibanResult,
    bic: bicResult,
    claimed_country: claimedCountry,
    account_country: accountCountry,
    mismatches,
    account_number_stored: false,
    note: '账号仅用于本次分析，不写入任何文件，输出已脱敏',
  };
}

function parseArgs(argv) {
  const args = { iban: null, bic: null, country: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--iban') args.iban = argv[++i];
    else if (token === '--bic') args.bic = argv[++i];
    else if (token === '--country') args.country = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.iban && !args.bic) {
    console.log(JSON.stringify({ status: 'error', error: 'pass --iban and/or --bic' }));
    return 2;
  }
  console.log(JSON.stringify({ ...analyse(args.iban, args.bic, args.country), status: 'ok' }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
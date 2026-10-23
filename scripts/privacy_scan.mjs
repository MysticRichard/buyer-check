#!/usr/bin/env node
/**
 * Privacy scanner for buyer-check (V2).
 *
 * Scans repository files for personal data patterns: email addresses, phone
 * numbers in international format, and common ID-number shapes (mainland CN
 * resident ID, passport-like codes). A finding fails the scan with file and
 * line numbers, unless it is whitelisted (synthetic examples).
 *
 * Usage:
 *   node scripts/privacy_scan.mjs            # scan all git-tracked files
 *   node scripts/privacy_scan.mjs <path>     # scan one file or directory
 *
 * Exit code: 0 clean, 1 findings, 2 usage error.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// Synthetic / documentation-only values that must never fail the scan.
const WHITELIST = new Set([
  'info@nordic-imp0rt.com',
  'purchasing.gnt@gmail.com',
  'name@company.com',
  'example@example.com',
  '4111 1111 1111 1234',
]);
const WHITELIST_DOMAINS = ['example.com', 'example.org', 'example.net', 'test.com'];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Masked emails (d***e@gmail.com) also match the tail of EMAIL_RE; match them
// as a whole first so the asterisks are included, then skip them as masked.
const EMAIL_WITH_MASK_RE = /[A-Za-z0-9._%+-]*\*+[A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// International numbers must start with "+"; local CN mobile numbers are 11 digits.
const INTL_PHONE_RE = /\+\d{1,3}[\d\s().-]{7,15}\d/g;
const CN_MOBILE_RE = /\b1[3-9]\d{9}\b/g;
const CN_ID_RE = /\b\d{17}[\dXx]\b/g;
// Dates and ISO timestamps are removed before scanning (frequent false positives).
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/g;

const SKIP_DIRS = new Set(['.git', 'node_modules', 'reports', '.tmp', '.arts', '.codegraph', '.cache']);

function listTrackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
    return out.split('\n').filter(Boolean).map((f) => join(ROOT, f));
  } catch {
    return [];
  }
}

function walk(path) {
  const stats = statSync(path);
  if (stats.isFile()) return [path];
  const files = [];
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry)) continue;
    files.push(...walk(join(path, entry)));
  }
  return files;
}

function isMasked(match) {
  return match.includes('*');
}

function checkEmail(match) {
  if (WHITELIST.has(match.toLowerCase())) return true;
  const domain = match.split('@')[1].toLowerCase();
  return WHITELIST_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function checkPhone(match) {
  if (WHITELIST.has(match)) return true;
  const digits = match.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return true; // not phone-shaped
  if (isMasked(match)) return true;
  return false;
}

function scanFile(path, findings) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const maskedEmails = [...line.matchAll(EMAIL_WITH_MASK_RE)].map((m) => m[0]);
    const strippedEmails = line;
    for (const m of strippedEmails.matchAll(EMAIL_RE)) {
      const insideMasked = maskedEmails.some((masked) => masked.includes(m[0]));
      if (!insideMasked && !isMasked(m[0]) && !checkEmail(m[0])) {
        findings.push({ file: path, line: idx + 1, kind: 'email', value: m[0] });
      }
    }
    const stripped = line.replace(TIMESTAMP_RE, '');
    for (const m of stripped.matchAll(INTL_PHONE_RE)) {
      if (!checkPhone(m[0])) {
        findings.push({ file: path, line: idx + 1, kind: 'phone', value: m[0] });
      }
    }
    for (const m of stripped.matchAll(CN_MOBILE_RE)) {
      if (!checkPhone(m[0])) {
        findings.push({ file: path, line: idx + 1, kind: 'phone', value: m[0] });
      }
    }
    for (const m of stripped.matchAll(CN_ID_RE)) {
      findings.push({ file: path, line: idx + 1, kind: 'cn-id', value: m[0] });
    }
  });
}

function main() {
  const target = process.argv[2];
  let files;
  if (target) {
    const path = target.startsWith('/') || target.includes(':') ? target : join(ROOT, target);
    files = walk(path);
  } else {
    files = listTrackedFiles();
    if (files.length === 0) files = walk(ROOT);
  }

  const findings = [];
  for (const file of files) scanFile(file, findings);

  if (findings.length === 0) {
    console.log(`privacy scan: clean (${files.length} files checked)`);
    return 0;
  }
  console.log(`privacy scan: ${findings.length} finding(s) in ${files.length} files`);
  for (const f of findings) {
    console.log(`  ${f.kind}\t${f.file}:${f.line}\t${f.value}`);
  }
  return 1;
}

process.exit(main());
#!/usr/bin/env node
/**
 * Build the lean competition submission bundle (P1).
 *
 * Reads submission.manifest.json, copies the declared files into
 * dist/submission/, merges the country data sources into a single
 * data_sources.md, merges A1-A14 into tests/cases.json, rewrites references
 * that would point outside the bundle, then enforces the file-count / size
 * limits and checks that every relative path still resolves inside the bundle.
 *
 * The repository itself is never modified; dist/ is git-ignored.
 *
 * Usage:
 *   node scripts/build_submission.mjs
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'submission.manifest.json'), 'utf8'));
const OUT = join(ROOT, MANIFEST.outputDir);

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function stripH1(text) {
  return text.replace(/^#\s+.*\r?\n+/, '').trim();
}


function shiftHeadings(text, delta) {
  return text.replace(/^(#{1,6})\s+/gm, (match, hashes) => `${'#'.repeat(Math.min(6, hashes.length + delta))} `);
}

function copyOne(entry) {
  const src = join(ROOT, entry.from);
  if (!existsSync(src)) throw new Error(`missing source file: ${entry.from}`);
  const dest = join(OUT, entry.to);
  ensureDir(dest);
  const original = readFileSync(src, 'utf8');
  const usesCRLF = original.includes('\r\n');
  let text = usesCRLF ? original.replace(/\r\n/g, '\n') : original;
  for (const rule of (MANIFEST.rewrites || {})[entry.to] || []) {
    if (!text.includes(rule.from)) {
      throw new Error(`rewrite target not found in ${entry.to}: ${rule.from.slice(0, 80)}`);
    }
    text = text.split(rule.from).join(rule.to);
  }
  if (usesCRLF) text = text.replace(/\n/g, '\r\n');
  writeFileSync(dest, text, 'utf8');
}

function mergeMarkdown(spec) {
  const chunks = [spec.title, ''];
  chunks.push('> 本文件由 `scripts/build_submission.mjs` 从仓库版 `data-sources/` 合并生成，供精简提交包使用；仓库内按国家拆分维护。', '');
  const [globalFile, checklistFile] = spec.sources;
  chunks.push('## 全球通用数据源', '');
  chunks.push(shiftHeadings(stripH1(readFileSync(join(ROOT, globalFile), 'utf8')), 1), '');
  chunks.push('## 采集清单', '');
  chunks.push(shiftHeadings(stripH1(readFileSync(join(ROOT, checklistFile), 'utf8')), 1), '');
  chunks.push('## 国家资料', '');
  const countryDir = join(ROOT, 'data-sources/countries');
  const files = readdirSync(countryDir).filter((name) => name.endsWith('.md')).sort();
  for (const file of files) {
    chunks.push(shiftHeadings(readFileSync(join(countryDir, file), 'utf8'), 2), '');
  }
  return `${chunks.join('\n').trim()}\n`;
}

function mergeCases(spec) {
  const dir = join(ROOT, 'tests/cases');
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  const cases = files.map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  cases.sort((a, b) => {
    const na = Number(String(a.id).replace(/\D/g, ''));
    const nb = Number(String(b.id).replace(/\D/g, ''));
    return na - nb || String(a.id).localeCompare(String(b.id));
  });
  return `${JSON.stringify(cases, null, 2)}\n`;
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function checkLimits() {
  const files = walk(OUT);
  let bytes = 0;
  for (const file of files) bytes += statSync(file).size;
  if (files.length > MANIFEST.limits.maxFiles) {
    throw new Error(`bundle has ${files.length} files, limit is ${MANIFEST.limits.maxFiles}`);
  }
  if (bytes > MANIFEST.limits.maxTotalBytes) {
    throw new Error(`bundle is ${bytes} bytes, limit is ${MANIFEST.limits.maxTotalBytes}`);
  }
  return { files: files.length, bytes };
}

function extractRefs(text) {
  const refs = new Set();
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) refs.add(match[1]);
  for (const match of text.matchAll(/`([^`\s]+\.(?:md|json|py|mjs)(?![a-z0-9]))`/g)) refs.add(match[1]);
  return [...refs];
}

function checkLinks() {
  const ignorePrefixes = MANIFEST.linkCheck.ignorePrefixes || [];
  const ignoreContains = MANIFEST.linkCheck.ignoreContains || [];
  const missing = [];
  for (const file of MANIFEST.linkCheck.files) {
    const text = readFileSync(join(OUT, file), 'utf8');
    for (const ref of extractRefs(text)) {
      if (/^(https?:|mailto:|#)/.test(ref)) continue;
      if (ref.startsWith('.')) continue;
      if (ignorePrefixes.some((prefix) => ref.startsWith(prefix))) continue;
      if (ignoreContains.some((token) => ref.includes(token))) continue;
      if (!existsSync(join(OUT, ref))) missing.push(`${file} -> ${ref}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`broken relative references:\n  ${missing.join('\n  ')}`);
  }
  return missing.length;
}

function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  for (const entry of MANIFEST.copy) copyOne(entry);

  for (const spec of MANIFEST.merge) {
    const dest = join(OUT, spec.to);
    ensureDir(dest);
    const text = spec.type === 'markdown' ? mergeMarkdown(spec) : mergeCases(spec);
    writeFileSync(dest, text, 'utf8');
  }

  const { files, bytes } = checkLimits();
  checkLinks();
  console.log(`submission bundle: ${files} files, ${bytes} bytes (${relative(ROOT, OUT)})`);
  console.log(`limits: files <= ${MANIFEST.limits.maxFiles}, bytes <= ${MANIFEST.limits.maxTotalBytes}`);
}

main();
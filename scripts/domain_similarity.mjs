#!/usr/bin/env node
/**
 * Look-alike (typo-squatting) domain detection for buyer-check (Node port).
 *
 * Flags homoglyph substitutions (l/1, o/0, rn/m), single character edits,
 * hyphenated/prefixed/suffixed variants and TLD swaps against known brands.
 * Results feed RF-DOM-001.
 *
 * Usage:
 *   node domain_similarity.mjs app1e.com
 *   node domain_similarity.mjs arnazon.com --threshold 0.6
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BRANDS = join(DIR, 'brands.json');

const HOMOGLYPHS = { l: '1', i: '1', o: '0', s: '5', e: '3' };

export function normalize(domain = '') {
  let value = String(domain).trim().toLowerCase();
  value = value.replace('http://', '').replace('https://', '');
  value = value.split('/')[0].split('?')[0];
  if (value.startsWith('www.')) value = value.slice(4);
  return value;
}

export function coreLabel(domain) {
  const parts = normalize(domain).split('.');
  if (parts.length < 2) return [normalize(domain), ''];
  return [parts[0], parts.slice(1).join('.')];
}

export function homoglyphKey(text) {
  const collapsed = text.replace(/rn/g, 'm').replace(/vv/g, 'w');
  return collapsed.replace(/[liose]/g, (char) => HOMOGLYPHS[char]);
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

export function compare(target, brandDomain) {
  const [targetLabel, targetTld] = coreLabel(target);
  const [brandLabel, brandTld] = coreLabel(brandDomain);

  if (targetLabel === brandLabel && targetTld === brandTld) return ['exact', 0.0];
  if (targetLabel === brandLabel) return ['tld_swap', 0.7];
  if (homoglyphKey(targetLabel) === homoglyphKey(brandLabel)) return ['homoglyph', 0.9];
  if (targetLabel.startsWith(brandLabel) || targetLabel.endsWith(brandLabel)) {
    return [targetLabel.includes('-') ? 'hyphenated' : 'affixed', 0.8];
  }
  const distance = levenshtein(targetLabel, brandLabel);
  if (distance === 1) return ['typosquat', 0.85];
  if (distance === 2 && brandLabel.length >= 6) return ['typosquat', 0.6];
  return ['none', 0.0];
}

export function loadBrands(path = DEFAULT_BRANDS) {
  return JSON.parse(readFileSync(path, 'utf8')).brands || [];
}

export function analyse(target, brands, threshold = 0.5) {
  const matches = [];
  for (const brand of brands) {
    const [type, score] = compare(target, brand.domain);
    if (type === 'exact') {
      return {
        target: normalize(target),
        is_lookalike: false,
        matches: [{ brand: brand.name, official_domain: brand.domain, type: 'exact', score: 1.0 }],
        verdict: '与已知品牌域名完全一致，非仿冒',
      };
    }
    if (score >= threshold) {
      matches.push({ brand: brand.name, official_domain: brand.domain, type, score });
    }
  }
  matches.sort((a, b) => b.score - a.score || a.official_domain.localeCompare(b.official_domain));
  const best = matches[0] || null;
  return {
    target: normalize(target),
    is_lookalike: matches.length > 0,
    matches,
    best_match: best,
    verdict: best
      ? `疑似仿冒 ${best.brand}（${best.official_domain}），类型 ${best.type}`
      : '未匹配到已知品牌的仿冒特征',
  };
}

function parseArgs(argv) {
  const args = { domain: null, brands: DEFAULT_BRANDS, threshold: 0.5 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--brands') args.brands = argv[++i];
    else if (token === '--threshold') args.threshold = Number(argv[++i]);
    else if (!token.startsWith('--')) args.domain = token;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.domain) {
    console.log(JSON.stringify({ status: 'error', error: 'missing domain argument' }));
    return 1;
  }
  let brands;
  try {
    brands = loadBrands(args.brands);
  } catch (error) {
    console.log(JSON.stringify({ status: 'unavailable', error: String(error) }));
    return 1;
  }
  console.log(JSON.stringify({ ...analyse(args.domain, brands, args.threshold), status: 'ok' }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
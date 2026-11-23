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
const SHORT = 5;
export const PUBLIC_SUFFIXES = new Set(`
co.uk org.uk ac.uk com.au net.au co.jp com.br com.cn net.cn org.cn gov.cn edu.cn com.hk com.sg com.tw co.in co.nz
com.tr org.tr com.mx org.mx com.ar org.ar co.cl gob.cl gov.cl com.co org.co com.pe org.pe com.pk org.pk
com.bd org.bd com.lk org.lk com.ng org.ng co.ke or.ke com.eg org.eg co.ma org.ma com.sa org.sa
co.ae org.ae com.ru org.ru com.ua org.ua com.pl org.pl co.kr or.kr co.jp or.jp co.za org.za
com.my org.my co.id or.id co.th or.th com.vn org.vn com.ph org.ph com.qa org.qa com.kw org.kw
com.bh org.bh com.om org.om com.lb org.lb com.ly org.ly
`.trim().split(/\s+/));

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
  const suffix = parts.slice(-2).join('.');
  if (parts.length >= 3 && PUBLIC_SUFFIXES.has(suffix)) return [parts[parts.length - 3], suffix];
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

export function compare(target, brandDomain, riskWords = []) {
  const [targetLabel, targetTld] = coreLabel(target);
  const [brandLabel, brandTld] = coreLabel(brandDomain);
  const risks = new Set(riskWords);

  if (targetLabel === brandLabel && targetTld === brandTld) return ['exact', 0.0];
  if (targetLabel === brandLabel) return ['tld_swap', 0.7];
  if (homoglyphKey(targetLabel) === homoglyphKey(brandLabel)) return ['homoglyph', 0.9];
  if (targetLabel.startsWith(brandLabel) || targetLabel.endsWith(brandLabel)) {
    if (targetLabel.includes('-')) return ['hyphenated', 0.8];
    const remainder = targetLabel.replace(brandLabel, '').replace(/^-/, '');
    if (brandLabel.length <= SHORT) {
      if (risks.has(remainder)) return ['affixed', 0.8];
      return ['none', 0.0];
    }
    return ['affixed', 0.8];
  }
  const distance = levenshtein(targetLabel, brandLabel);
  if (distance === 1) return ['typosquat', 0.85];
  if (distance === 2 && brandLabel.length >= 6) return ['typosquat', 0.6];
  return ['none', 0.0];
}

export function loadBrandData(path = DEFAULT_BRANDS) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return { brands: data.brands || [], riskWords: data.risk_words || [] };
}

export function loadBrands(path = DEFAULT_BRANDS) {
  return loadBrandData(path).brands;
}

export function analyse(target, brands, threshold = 0.5, riskWords = []) {
  const matches = [];
  for (const brand of brands) {
    const [type, score] = compare(target, brand.domain, riskWords);
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
  let brandData;
  try {
    brandData = loadBrandData(args.brands);
  } catch (error) {
    console.log(JSON.stringify({ status: 'unavailable', error: String(error) }));
    return 1;
  }
  console.log(JSON.stringify({ ...analyse(args.domain, brandData.brands, args.threshold, brandData.riskWords), status: 'ok' }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
#!/usr/bin/env node
/**
 * Deterministic risk scoring for buyer-check (Node port).
 *
 * Sums the weights of matched red flags from red_flags.json and maps the total
 * to a risk level plus a 0-100 risk score, information coverage ratio and
 * confidence grade, so the same input always yields the same output
 * (acceptance cases A6/A8). Also exposes the sensitive-number masking helper
 * (acceptance A7).
 *
 * Usage:
 *   node risk_score.mjs --flags RF-PAY-001 RF-DOM-002
 *   node risk_score.mjs --flags RF-PAY-001 --unverifiable
 *   node risk_score.mjs --flags RF-BEH-003 --anchors 0 --covered 3
 *   node risk_score.mjs --mask "4111 1111 1111 1234"
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
export const RULES_FILE = join(DIR, 'red_flags.json');

export const CHECKPOINT_COUNT = 8;

const RISK_SCORE_MAX = 100;

export function loadRules(path = RULES_FILE) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function maskSensitive(text = '') {
  const digits = String(text).match(/\d/g) || [];
  if (digits.length === 0) return text;
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return '*'.repeat(digits.length - 4) + digits.slice(-4).join('');
}

export function coverageGrade(covered, anchors) {
  const ratio = Math.round((covered / CHECKPOINT_COUNT) * 100) / 100;
  let confidence;
  if (anchors >= 2) confidence = '高';
  else if (anchors === 1) confidence = '中';
  else confidence = '低';
  return { ratio, confidence };
}

export function score(
  flagIds = [],
  rules,
  unverifiable = false,
  covered = null,
  anchors = null,
  companyLevel = null,
  linkStrength = null,
  personLevel = null,
) {
  const index = new Map(rules.flags.map((flag) => [flag.id, flag]));
  const matched = [];
  const unknown = [];
  let total = 0;

  for (const id of flagIds) {
    const item = index.get(id);
    if (!item) {
      unknown.push(id);
      continue;
    }
    matched.push({ id, name: item.name, weight: item.weight });
    total += item.weight;
  }

  const highWeightHit = matched.some((item) => item.weight === 5);

  let band;
  let riskScore;
  if (total >= 8 || highWeightHit) {
    band = '高';
    riskScore = Math.min(RISK_SCORE_MAX, 65 + 5 * Math.max(0, total - 8));
    if (highWeightHit) riskScore = Math.max(70, riskScore);
  } else if (total >= 4) {
    band = '中';
    riskScore = 35 + 8 * (total - 4);
  } else {
    band = '低';
    riskScore = 9 * total;
  }

  let ratio = null;
  let confidence = null;
  let baseConfidence = null;
  let companyFlag = false;
  if (covered !== null && anchors !== null) {
    ({ ratio, confidence } = coverageGrade(covered, anchors));
    baseConfidence = confidence;
    if (companyLevel === 'low') companyFlag = true;
    if (linkStrength === 'strong' && companyLevel !== 'low') confidence = '高'; // R2
    if (companyLevel === 'low' && confidence === '高') confidence = '中'; // R3
    if (personLevel === 'high' && confidence === '低') confidence = '中'; // R4
  }

  const anchorMissing = unverifiable || (confidence === '低' && covered !== null);
  let level;
  if (band === '高') level = '高';
  else if (anchorMissing) level = '需人工核实';
  else level = band;

  const result = {
    matched,
    unknown,
    total,
    high_weight_hit: highWeightHit,
    risk_score: riskScore,
    coverage: ratio,
    confidence,
    level,
  };
  if (companyLevel !== null || linkStrength !== null || personLevel !== null) {
    result.base_confidence = baseConfidence;
    result.company_flag = companyFlag;
    result.layers = {
      company: companyLevel,
      person_company_link: linkStrength,
      person_authenticity: personLevel,
    };
  }
  return result;
}

function parseArgs(argv) {
  const args = { flags: [], unverifiable: false, mask: null, rules: RULES_FILE, covered: null, anchors: null, companyLevel: null, linkStrength: null, personLevel: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--flags') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.flags.push(argv[++i]);
    } else if (token === '--unverifiable') {
      args.unverifiable = true;
    } else if (token === '--mask') {
      args.mask = argv[++i];
    } else if (token === '--rules') {
      args.rules = argv[++i];
    } else if (token === '--covered') {
      args.covered = Number(argv[++i]);
    } else if (token === '--anchors') {
      args.anchors = Number(argv[++i]);
    } else if (token === '--company-level') {
      args.companyLevel = argv[++i];
    } else if (token === '--link-strength') {
      args.linkStrength = argv[++i];
    } else if (token === '--person-authenticity') {
      args.personLevel = argv[++i];
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mask !== null) {
    console.log(JSON.stringify({ masked: maskSensitive(args.mask) }, null, 0));
    return 0;
  }
  let rules;
  try {
    rules = loadRules(args.rules);
  } catch (error) {
    console.log(JSON.stringify({ status: 'unavailable', error: String(error) }));
    return 1;
  }
  const useCoverage = args.covered !== null && args.anchors !== null;
  const result = {
...score(
        args.flags,
        rules,
        args.unverifiable,
        useCoverage ? args.covered : null,
        useCoverage ? args.anchors : null,
        args.companyLevel,
        args.linkStrength,
        args.personLevel,
      ),
    status: 'ok',
  };
  console.log(JSON.stringify(result));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
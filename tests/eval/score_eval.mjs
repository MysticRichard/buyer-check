#!/usr/bin/env node
/**
 * Behavior evaluation scorer for buyer-check (E4).
 *
 * Compares predicted red flags (one JSON list per inquiry, produced by any
 * model reading tests/eval/inquiries.jsonl) against the expected flags, then
 * reports per-flag recall and false-positive rate plus overall metrics.
 *
 * Usage:
 *   node tests/eval/score_eval.mjs tests/eval/predictions.json
 *   node tests/eval/score_eval.mjs --self        # self-check: expectations as predictions
 *
 * Input format (predictions file): [{"id": "E001", "flags": ["RF-..."]}, ...]
 *
 * Script-checked flags (RF-SAN-001, RF-NEG-001, RF-DOM-001, RF-DOM-002) are
 * excluded from text evaluation when they appear only via tool output; this
 * corpus only carries them when the inquiry text itself exposes the signal.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, 'inquiries.jsonl');

function loadCorpus() {
  const lines = readFileSync(CORPUS, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  return lines.map((line) => JSON.parse(line));
}

function loadPredictions(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function evaluate(corpus, predictions) {
  const byId = new Map(predictions.map((p) => [p.id, new Set(p.flags || [])]));
  const flagStats = new Map();
  let normalTotal = 0;
  let normalFalseAlarms = 0;

  for (const item of corpus) {
    const expected = new Set(item.expected_flags || []);
    const predicted = byId.get(item.id) || new Set();
    const isNormal = expected.size === 0;
    if (isNormal) normalTotal += 1;

    const allFlags = new Set([...expected, ...predicted]);
    for (const flag of allFlags) {
      if (!flagStats.has(flag)) flagStats.set(flag, { tp: 0, fn: 0, fp: 0, tn: 0 });
      const s = flagStats.get(flag);
      const e = expected.has(flag);
      const p = predicted.has(flag);
      if (e && p) s.tp += 1;
      else if (e && !p) s.fn += 1;
      else if (!e && p) {
        s.fp += 1;
        if (isNormal) normalFalseAlarms += 1;
      } else s.tn += 1;
    }
  }

  const perFlag = {};
  for (const [flag, s] of [...flagStats.entries()].sort()) {
    const recall = s.tp + s.fn === 0 ? null : s.tp / (s.tp + s.fn);
    const precision = s.tp + s.fp === 0 ? null : s.tp / (s.tp + s.fp);
    const fpr = s.fp + s.tn === 0 ? null : s.fp / (s.fp + s.tn);
    perFlag[flag] = {
      tp: s.tp,
      fn: s.fn,
      fp: s.fp,
      recall: recall === null ? 'n/a' : Math.round(recall * 1000) / 1000,
      precision: precision === null ? 'n/a' : Math.round(precision * 1000) / 1000,
      false_positive_rate: fpr === null ? 'n/a' : Math.round(fpr * 1000) / 1000,
    };
  }

  const coveredFlags = [...flagStats.keys()];
  return {
    inquiries: corpus.length,
    normal_inquiries: normalTotal,
    false_alarms_on_normal: normalFalseAlarms,
    normal_false_alarm_rate: normalTotal === 0 ? 'n/a' : Math.round((normalFalseAlarms / normalTotal) * 1000) / 1000,
    flags_covered: coveredFlags.length,
    per_flag: perFlag,
  };
}

function main() {
  const args = process.argv.slice(2);
  const corpus = loadCorpus();

  let predictions;
  if (args[0] === '--self') {
    predictions = corpus.map((item) => ({ id: item.id, flags: item.expected_flags }));
    console.log('mode: self-check (expectations used as predictions — must be perfect)');
  } else if (args[0]) {
    predictions = loadPredictions(args[0]);
  } else {
    console.error('usage: node tests/eval/score_eval.mjs <predictions.json> | --self');
    process.exit(2);
  }

  const result = evaluate(corpus, predictions);
  console.log(`inquiries: ${result.inquiries} (normal: ${result.normal_inquiries})`);
  console.log(`flags covered: ${result.flags_covered}`);
  console.log(`false alarms on normal inquiries: ${result.false_alarms_on_normal} (rate ${result.normal_false_alarm_rate})`);
  console.log('\nper-flag metrics:');
  for (const [flag, m] of Object.entries(result.per_flag)) {
    console.log(
      `  ${flag}  recall=${m.recall}  precision=${m.precision}  fp_rate=${m.false_positive_rate}  (tp ${m.tp} / fn ${m.fn} / fp ${m.fp})`,
    );
  }

  if (args[0] === '--self') {
    const imperfect = Object.values(result.per_flag).some((m) => m.recall !== 1 || m.fp !== 0);
    if (imperfect || result.false_alarms_on_normal > 0) {
      console.log('\nself-check FAILED: scorer or corpus is inconsistent');
      process.exit(1);
    }
    console.log('\nself-check passed: scorer reproduces expectations exactly');
  }
}

main();
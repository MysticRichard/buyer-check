#!/usr/bin/env node
/**
 * Behavior evaluation scorer for buyer-check (E4).
 *
 * Compares predicted red flags (one JSON list per inquiry, produced by any
 * model reading tests/eval/inquiries.jsonl) against the expected flags, then
 * reports per-flag recall and false-positive rate plus overall metrics.
 *
 * v0.11 adds lead-class metrics: per-class precision/recall and a confusion
 * matrix. Class metrics only appear when the prediction file carries a
 * `lead_class` per inquiry; they are a reporting target, never a CI gate.
 *
 * Usage:
 *   node tests/eval/score_eval.mjs tests/eval/predictions.json
 *   node tests/eval/score_eval.mjs --self        # self-check: expectations as predictions
 *
 * Input format (predictions file):
 *   [{"id": "E001", "flags": ["RF-..."], "lead_class": "reseller"}, ...]
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

const LEAD_CLASSES = [
  'automated_submission',
  'phishing_like',
  'vendor_solicitation',
  'competitor_probe',
  'individual_research',
  'target_end_user',
  'reseller',
  'unclear',
];
const NON_TARGET_CLASSES = new Set([
  'automated_submission',
  'phishing_like',
  'vendor_solicitation',
  'competitor_probe',
  'individual_research',
]);
const IDENTITY_STATUSES = ['resolved', 'probable', 'ambiguous', 'unresolved'];

function loadCorpus() {
  const lines = readFileSync(CORPUS, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  return lines.map((line) => JSON.parse(line));
}

function loadPredictions(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function evaluate(corpus, predictions) {
  const byId = new Map(predictions.map((p) => [p.id, p]));
  const flagStats = new Map();
  let normalTotal = 0;
  let normalFalseAlarms = 0;

  for (const item of corpus) {
    const expected = new Set(item.expected_flags || []);
    const predicted = new Set((byId.get(item.id) || {}).flags || []);
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
  const lead = evaluateLeadClasses(corpus, byId);
  const identity = evaluateIdentityStatuses(corpus, byId);
  return {
    inquiries: corpus.length,
    normal_inquiries: normalTotal,
    false_alarms_on_normal: normalFalseAlarms,
    normal_false_alarm_rate: normalTotal === 0 ? 'n/a' : Math.round((normalFalseAlarms / normalTotal) * 1000) / 1000,
    flags_covered: coveredFlags.length,
    per_flag: perFlag,
    lead,
    identity,
  };
}

function evaluateIdentityStatuses(corpus, byId) {
  const labeled = corpus.filter((item) => IDENTITY_STATUSES.includes(item.expected_identity_status));
  const predicted = labeled.filter((item) => IDENTITY_STATUSES.includes((byId.get(item.id) || {}).identity_status));
  const base = {
    labeled_inquiries: labeled.length,
    predicted_inquiries: predicted.length,
    evaluated: predicted.length > 0,
    statuses: IDENTITY_STATUSES,
  };
  if (predicted.length === 0) return base;

  const classes = [...new Set([
    ...IDENTITY_STATUSES,
    ...labeled.map((item) => item.expected_identity_status),
    ...predicted.map((item) => (byId.get(item.id) || {}).identity_status),
  ])];
  const confusion = {};
  const stats = new Map();
  for (const expected of classes) {
    confusion[expected] = {};
    for (const actual of classes) confusion[expected][actual] = 0;
    stats.set(expected, { tp: 0, fn: 0, fp: 0, support: 0 });
  }
  for (const item of predicted) {
    const expected = item.expected_identity_status;
    const actual = (byId.get(item.id) || {}).identity_status;
    confusion[expected][actual] += 1;
    stats.get(expected).support += 1;
    if (expected === actual) {
      stats.get(expected).tp += 1;
    } else {
      stats.get(expected).fn += 1;
      if (stats.has(actual)) stats.get(actual).fp += 1;
    }
  }
  const perStatus = {};
  for (const name of classes) {
    const s = stats.get(name);
    const recall = s.tp + s.fn === 0 ? null : s.tp / (s.tp + s.fn);
    const precision = s.tp + s.fp === 0 ? null : s.tp / (s.tp + s.fp);
    perStatus[name] = {
      support: s.support,
      tp: s.tp,
      fn: s.fn,
      fp: s.fp,
      recall: recall === null ? 'n/a' : Math.round(recall * 1000) / 1000,
      precision: precision === null ? 'n/a' : Math.round(precision * 1000) / 1000,
    };
  }
  return { ...base, per_status: perStatus, confusion, classes };
}

function evaluateLeadClasses(corpus, byId) {
  const labeled = corpus.filter((item) => LEAD_CLASSES.includes(item.expected_lead_class));
  const predictedCount = labeled.filter((item) => LEAD_CLASSES.includes((byId.get(item.id) || {}).lead_class)).length;
  const base = {
    labeled_inquiries: labeled.length,
    predicted_inquiries: predictedCount,
    evaluated: predictedCount > 0,
    classes: LEAD_CLASSES,
  };
  if (predictedCount === 0) return base;

  const classes = [...new Set([
    ...LEAD_CLASSES,
    ...labeled.map((item) => item.expected_lead_class),
    ...labeled.map((item) => (byId.get(item.id) || {}).lead_class).filter((value) => LEAD_CLASSES.includes(value)),
  ])];
  const confusion = {};
  const stats = new Map();
  for (const expected of classes) {
    confusion[expected] = {};
    for (const predicted of classes) confusion[expected][predicted] = 0;
    stats.set(expected, { tp: 0, fn: 0, fp: 0, support: 0 });
  }

  for (const item of labeled) {
    const expected = item.expected_lead_class;
    const predicted = (byId.get(item.id) || {}).lead_class;
    if (!LEAD_CLASSES.includes(predicted)) continue;
    confusion[expected][predicted] += 1;
    stats.get(expected).support += 1;
    if (expected === predicted) {
      stats.get(expected).tp += 1;
    } else {
      stats.get(expected).fn += 1;
      if (stats.has(predicted)) stats.get(predicted).fp += 1;
    }
  }

  const perClass = {};
  for (const name of classes) {
    const s = stats.get(name);
    const recall = s.tp + s.fn === 0 ? null : s.tp / (s.tp + s.fn);
    const precision = s.tp + s.fp === 0 ? null : s.tp / (s.tp + s.fp);
    perClass[name] = {
      support: s.support,
      tp: s.tp,
      fn: s.fn,
      fp: s.fp,
      recall: recall === null ? 'n/a' : Math.round(recall * 1000) / 1000,
      precision: precision === null ? 'n/a' : Math.round(precision * 1000) / 1000,
    };
  }

  const emerging = labeled.filter((item) => item.segment === 'emerging_small_buyer');
  const emergingMisclassified = emerging.filter((item) => NON_TARGET_CLASSES.has((byId.get(item.id) || {}).lead_class));
  return {
    ...base,
    per_class: perClass,
    confusion,
    emerging_small_buyers: emerging.length,
    emerging_misclassified: emergingMisclassified.length,
    emerging_misclassification_rate: emerging.length === 0
      ? 'n/a'
      : Math.round((emergingMisclassified.length / emerging.length) * 1000) / 1000,
    target_rate: 0.05,
    target_met: emerging.length === 0 || emergingMisclassified.length / emerging.length <= 0.05,
  };
}

function main() {
  const args = process.argv.slice(2);
  const corpus = loadCorpus();

  let predictions;
  if (args[0] === '--self') {
    predictions = corpus.map((item) => ({
      id: item.id,
      flags: item.expected_flags,
      lead_class: item.expected_lead_class,
      identity_status: item.expected_identity_status,
    }));
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

  if (result.lead.evaluated) {
    console.log(`\nlead-class metrics (${result.lead.predicted_inquiries}/${result.lead.labeled_inquiries} labeled inquiries have a prediction):`);
    for (const [name, m] of Object.entries(result.lead.per_class)) {
      console.log(`  ${name}  recall=${m.recall}  precision=${m.precision}  support=${m.support}  (tp ${m.tp} / fn ${m.fn} / fp ${m.fp})`);
    }
    console.log('\nconfusion matrix (expected -> predicted):');
    const header = `  ${'expected'.padEnd(22)}${result.lead.classes.map((name) => name.slice(0, 8).padStart(10)).join('')}`;
    console.log(header);
    for (const expected of result.lead.classes) {
      const row = result.lead.classes.map((predicted) => String(result.lead.confusion[expected]?.[predicted] ?? 0).padStart(10)).join('');
      console.log(`  ${expected.padEnd(22)}${row}`);
    }
    console.log(
      `\nemerging small buyers misclassified into a non-target class: ${result.lead.emerging_misclassified}/${result.lead.emerging_small_buyers}`
      + ` (rate ${result.lead.emerging_misclassification_rate}, target <= ${result.lead.target_rate}: ${result.lead.target_met ? 'met' : 'NOT met'})`,
    );
  } else {
    console.log('\nlead-class metrics: skipped (no lead_class in predictions)');
  }

  if (result.identity.evaluated) {
    console.log(`\nidentity-status metrics (${result.identity.predicted_inquiries}/${result.identity.labeled_inquiries} labeled inquiries have a prediction):`);
    for (const [name, m] of Object.entries(result.identity.per_status)) {
      console.log(`  ${name}  recall=${m.recall}  precision=${m.precision}  support=${m.support}  (tp ${m.tp} / fn ${m.fn} / fp ${m.fp})`);
    }
    console.log('\nidentity confusion matrix (expected -> predicted):');
    const header = `  ${'expected'.padEnd(18)}${result.identity.classes.map((name) => name.slice(0, 10).padStart(12)).join('')}`;
    console.log(header);
    for (const expected of result.identity.classes) {
      const row = result.identity.classes.map((actual) => String(result.identity.confusion[expected]?.[actual] ?? 0).padStart(12)).join('');
      console.log(`  ${expected.padEnd(18)}${row}`);
    }
  } else {
    console.log('\nidentity-status metrics: skipped (no identity_status in predictions)');
  }

  if (args[0] === '--self') {
    const imperfect = Object.values(result.per_flag).some((m) => m.recall !== 1 || m.fp !== 0);
    const classImperfect = result.lead.evaluated && Object.entries(result.lead.per_class).some(
      ([, m]) => m.support > 0 && (m.recall !== 1 || m.fp !== 0),
    );
    const identityImperfect = result.identity.evaluated && Object.entries(result.identity.per_status).some(
      ([, m]) => m.support > 0 && (m.recall !== 1 || m.fp !== 0),
    );
    if (imperfect || classImperfect || identityImperfect || result.false_alarms_on_normal > 0 || (result.lead.evaluated && !result.lead.target_met)) {
      console.log('\nself-check FAILED: scorer or corpus is inconsistent');
      process.exit(1);
    }
    console.log('\nself-check passed: scorer reproduces expectations exactly');
  }
}

main();
#!/usr/bin/env node
/**
 * Cross-language consistency test for the risk scoring engine (V5 + V6).
 *
 * V5: enumerates every red-flag combination (2^13) and asserts the score bands
 *     stay aligned with the level: low 0-29, medium 30-59, high 60-100, and a
 *     weight-5 flag always scores >= 70.
 * V6: runs a representative set of combinations through both the Node and the
 *     Python implementation and requires identical output.
 *
 * Usage:
 *   node tests/consistency.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { score, loadRules } from '../scripts/risk_score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_SCRIPT = join(HERE, '..', 'scripts', 'risk_score.py');

const PY_CANDIDATES = [
  'C:/Users/JOEY/.agent-reach-venv/Scripts/python.exe',
  'python',
  'python3',
  'py -3',
];

function findPython() {
  for (const candidate of PY_CANDIDATES) {
    try {
      const cmd = candidate.split(' ')[0];
      const args = candidate.split(' ').slice(1);
      execFileSync(cmd, [...args, '--version'], { stdio: 'pipe', timeout: 10000 });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function runPython(candidate, args) {
  const cmd = candidate.split(' ')[0];
  const rest = candidate.split(' ').slice(1);
  const out = execFileSync(cmd, [...rest, PY_SCRIPT, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30000,
  });
  return JSON.parse(out);
}

let failures = 0;

function fail(message) {
  failures += 1;
  console.log(`✗ ${message}`);
}

// ---------- Documentation red-flag count consistency ----------
const docRoot = join(HERE, '..');
const expectedFlags = loadRules().flags.length;
const countSpecs = [
  ['red_flags.md', /红旗清单（(\d+) 条）/g],
  ['README.md', /红旗清单（(\d+) 条）/g],
  ['SKILL.md', /`red_flags\.md`（(\d+) 条）/g],
  ['SKILL.md', /红旗清单（(\d+) 条）/g],
];
for (const [file, pattern] of countSpecs) {
  const text = readFileSync(join(docRoot, file), 'utf8');
  const counts = [...text.matchAll(pattern)].map((match) => Number(match[1]));
  if (counts.length === 0) fail(`docs ${file}: red-flag count pattern not found`);
  for (const count of counts) {
    if (count !== expectedFlags) fail(`docs ${file}: red-flag count ${count} != ${expectedFlags}`);
  }
}
const addedCount = readFileSync(join(docRoot, 'red_flags.md'), 'utf8').match(/v0\.5\.0 新增 (\d+) 条/);
if (!addedCount || Number(addedCount[1]) !== 8) fail('docs red_flags.md: v0.5.0 added count must be 8');
if (failures === 0) console.log(`✓ doc red-flag counts consistent with red_flags.json (${expectedFlags})`);

// ---------- Card/report templates must always render coverage + uncovered items ----------
const templateSpecs = [
  ['card_template.md', ['置信度：', '覆盖：', '未覆盖：', 'coverage.uncovered', 'needs-browser', 'no-public-record', 'no-double-match', 'name-only-match', '官网匹配可作为', '核实度', '动作阶梯', '六维', '需要注意', '没查到不代表没问题', '一次动作', 'layers', '平台边界项']],
  ['report_template.md', ['检查点覆盖矩阵', '未覆盖项必须逐项写原因', '社媒（LinkedIn/Facebook/WhatsApp）', '实际查询结果', '双向', '双匹配', '公司画像', '附录 C：本次调查链接清单', '三层核实', '核实度', '动作阶梯', '六维表', '主营一致性', '地图规模判断', '链接层', 'Google Places', '平台边界项']],
  ['SKILL.md', ['覆盖行（强制）', 'coverage.uncovered', '地图 / 海关 / 社媒不直接标未覆盖', '双向', '双匹配', '官网画像优先', '附录 C 本次调查链接清单', '三层核实模型', 'R2', 'R3', 'identity_check.py map', '免费优先与自动取证边界', '不引入无头浏览器']],
  ['data-sources/global.md', ['Google Places', 'OpenStreetMap Nominatim', 'ImportGenius', 'Volza', '双向', '多平台、免费优先', '双匹配', '同名不同公司', '官网画像', '邮箱域名不一定是官网', '姓名 + 电话', '三层核实通道', 'Pillow', 'sharp', 'identity_check.py map', '免费优先顺序', '不引入无头浏览器']],
  ['examples/sample-report.md', ['本次调查链接清单']],
];
const beforeTemplate = failures;
for (const [file, needles] of templateSpecs) {
  const text = readFileSync(join(docRoot, file), 'utf8');
  for (const needle of needles) {
    if (!text.includes(needle)) fail(`docs ${file}: missing "${needle}"`);
  }
}
const beforeScoreChars = failures;
for (const file of ['card_template.md', 'SKILL.md', 'examples/sample-report.md', 'report_template.md', 'docs/iteration_plan.md', 'CHANGELOG.md']) {
  const text = readFileSync(join(docRoot, file), 'utf8');
  if (/\u2593|\u2591|\u2592/.test(text)) fail(`docs ${file}: legacy score-bar character`);
}
const cardText = readFileSync(join(docRoot, 'card_template.md'), 'utf8');
if (!cardText.includes('■') || !cardText.includes('□')) fail('card_template.md: new score-bar characters missing');
if (failures === beforeScoreChars) {
  console.log('✓ score-bar characters use ■/□ only');
}
if (failures === beforeTemplate) {
  console.log('✓ card/report templates require confidence + coverage + uncovered items');
}

// ---------- v0.11 documentation numbers + guide/template consistency ----------
const beforeV011 = failures;
const readmeText = readFileSync(join(docRoot, 'README.md'), 'utf8');
const skillText = readFileSync(join(docRoot, 'SKILL.md'), 'utf8');
const manifest = JSON.parse(readFileSync(join(docRoot, 'submission.manifest.json'), 'utf8'));
if (manifest.version !== '0.13.0') fail(`manifest version ${manifest.version} != 0.13.0`);
if (!readmeText.includes('v0.13.0')) fail('README.md: missing v0.12.0');
if (!readmeText.includes('A1–A299')) fail('README.md: missing A1–A299');
if (!skillText.includes('A1–A299')) fail('SKILL.md: missing A1–A299');
if (!skillText.includes('135 条合成询盘')) fail('SKILL.md: missing 135 条合成询盘');
const caseCount = readdirSync(join(docRoot, 'tests', 'cases')).filter((name) => /^A\d+\.json$/.test(name)).length;
if (caseCount !== 299) fail(`tests/cases: ${caseCount} cases != 299`);
const evalLines = readFileSync(join(docRoot, 'tests', 'eval', 'inquiries.jsonl'), 'utf8')
  .split(/\r?\n/).filter((line) => line.trim()).length;
if (evalLines !== 135) fail(`tests/eval/inquiries.jsonl: ${evalLines} lines != 135`);

const guideBlocks = [...cardText.matchAll(/```text\r?\n([\s\S]*?)```/g)]
  .map((match) => match[1].replace(/\r\n/g, '\n').replace(/\n$/, ''));
const fullGuide = guideBlocks.find((block) => block.startsWith('## BuyerCheck 使用指南'));
if (!fullGuide) fail('card_template.md: full guide block missing');
const pythonCmd = findPython();
if (pythonCmd && fullGuide) {
  const [cmd, ...rest] = pythonCmd.split(' ');
  const out = execFileSync(cmd, [...rest, join(docRoot, 'scripts', 'render_card.py'), '--guide', 'full', '--lang', 'zh'], {
    encoding: 'utf8',
    timeout: 30000,
  }).replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (out !== fullGuide) fail('card_template.md guide block != render_card --guide full --lang zh');
}
const guideExamples = [
  '帮我背调：NORDIC IMPORT AB，瑞典，邮箱 info@nordic-import.example',
  '客户 Anna，WhatsApp +44 7700 900123，想订 500 个接线端子',
  '阿里国际站的询盘：We would like to order 2000 pcs, please pay the factory audit fee first.',
];
for (const sample of guideExamples) {
  if (!readmeText.includes(sample)) fail(`README.md: missing guide example "${sample}"`);
  if (fullGuide && !fullGuide.includes(sample)) fail(`card_template.md: missing guide example "${sample}"`);
}
const reportText = readFileSync(join(docRoot, 'report_template.md'), 'utf8');
if (!reportText.includes('1.4 询价有效性判断')) fail('report_template.md: missing 1.4');
if (!reportText.includes('类别由固定规则按所列信号得出')) fail('report_template.md: missing class disclaimer');
const globalText = readFileSync(join(docRoot, 'data-sources/global.md'), 'utf8');
if (!globalText.includes('第十四节')) fail('global.md: missing 第十四节');
for (const channel of ['alibaba', 'facebook', 'whatsapp', 'website_form', 'email', 'linkedin', 'trade_show']) {
  if (!globalText.includes(channel)) fail(`global.md: missing channel ${channel}`);
}
if (failures === beforeV011) {
  console.log('✓ v0.11 docs numbers + guide/template consistency');
}

// ---------- V5: enumerate all combinations, assert band invariants ----------
const rules = loadRules();
const flagIds = rules.flags.map((flag) => flag.id);
const weightById = new Map(rules.flags.map((flag) => [flag.id, flag.weight]));

let combos = 0;
const maxCombo = 1 << flagIds.length;
for (let mask = 0; mask < maxCombo; mask += 1) {
  const ids = [];
  let total = 0;
  let hasWeight5 = false;
  for (let i = 0; i < flagIds.length; i += 1) {
    if (mask & (1 << i)) {
      ids.push(flagIds[i]);
      total += weightById.get(flagIds[i]);
      if (weightById.get(flagIds[i]) === 5) hasWeight5 = true;
    }
  }
  const result = score(ids, rules, false, 8, 3);
  combos += 1;
  const { level, risk_score: value } = result;
  if (level === '低' && !(value >= 0 && value <= 29)) fail(`V5 low band: T=${total} score=${value}`);
  if (level === '中' && !(value >= 30 && value <= 59)) fail(`V5 medium band: T=${total} score=${value}`);
  if (level === '高' && !(value >= 60 && value <= 100)) fail(`V5 high band: T=${total} score=${value}`);
  if (hasWeight5 && value < 70) fail(`V5 weight-5 floor: T=${total} score=${value}`);
}
console.log(`✓ V5 band invariants hold for all ${combos} flag combinations`);

// ---------- V6: Python vs Node consistency on representative cases ----------
const python = findPython();
if (!python) {
  console.log('○ V6 skipped: no Python interpreter found (Node-only environment)');
} else {
  const cases = [
    { flags: [], covered: 3, anchors: 0 },
    { flags: ['RF-BEH-003'], covered: 3, anchors: 0 },
    { flags: ['RF-MAIL-002', 'RF-BEH-002'], covered: 7, anchors: 2 },
    { flags: ['RF-BEH-001'], covered: 5, anchors: 1 },
    { flags: ['RF-PAY-001'], covered: 6, anchors: 1 },
    { flags: ['RF-DOM-002', 'RF-MAIL-001', 'RF-BEH-001'], covered: 7, anchors: 1 },
    { flags: ['RF-ACC-001', 'RF-DOM-002'], covered: 7, anchors: 2 },
    { flags: ['RF-PAY-001', 'RF-PAY-002', 'RF-DOM-001', 'RF-NEG-001'], covered: 8, anchors: 3 },
    { flags: [], covered: 3, anchors: 0, unverifiable: true },
    { flags: ['RF-BEH-003'], covered: 3, anchors: 0, unverifiable: true },
    { flags: ['RF-PAY-001'], covered: 3, anchors: 0, unverifiable: true },
    { flags: [], covered: 7, anchors: 1, company_level: 'high', link_strength: 'strong', person_level: 'unknown' },
    { flags: ['RF-CORP-006'], covered: 7, anchors: 2, company_level: 'low', link_strength: 'weak', person_level: 'unknown' },
    { flags: ['RF-ID-001'], covered: 7, anchors: 1, company_level: 'high', link_strength: 'medium', person_level: 'low' },
  ];

  let checked = 0;
  for (const c of cases) {
    const args = ['--flags', ...(c.flags.length ? c.flags : [''])];
    if (c.covered !== undefined) args.push('--covered', String(c.covered));
    if (c.anchors !== undefined) args.push('--anchors', String(c.anchors));
    if (c.unverifiable) args.push('--unverifiable');
    if (c.company_level) args.push('--company-level', c.company_level);
    if (c.link_strength) args.push('--link-strength', c.link_strength);
    if (c.person_level) args.push('--person-authenticity', c.person_level);

    const py = runPython(python, args);
    const js = score(
      c.flags,
      rules,
      Boolean(c.unverifiable),
      c.covered ?? null,
      c.anchors ?? null,
      c.company_level ?? null,
      c.link_strength ?? null,
      c.person_level ?? null,
    );

    for (const key of ['total', 'risk_score', 'level', 'confidence', 'high_weight_hit', 'company_flag', 'base_confidence', 'layers']) {
      if (JSON.stringify(py[key]) !== JSON.stringify(js[key])) {
        fail(`V6 mismatch [${c.flags.join(',') || 'none'}] ${key}: python=${JSON.stringify(py[key])} node=${JSON.stringify(js[key])}`);
      }
    }
    checked += 1;
  }
  console.log(`✓ V6 Python and Node outputs identical on ${checked}/${cases.length} representative cases (${python})`);
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nconsistency checks passed');
process.exit(0);
#!/usr/bin/env node
/**
 * Render a deterministic buyer-check conclusion card from an evidence pack.
 *
 * Computes the credit score, the six-dimension status, the four-step action
 * ladder and the conclusion sentence from the same evidence pack, validates
 * the optional display fields, re-checks the risk score and prints Markdown.
 * Never touches the network, the filesystem (writes) or the system clock.
 *
 * Usage:
 *   node render_card.mjs evidence.json
 *   node render_card.mjs evidence.json --json
 *   cat evidence.json | node render_card.mjs -
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { score as riskScore, loadRules } from './risk_score.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
export const RULES_FILE = join(DIR, 'red_flags.json');

const CHECKPOINT_NAMES = {
  company: '公司名',
  domain: '域名',
  email: '邮箱',
  phone: '电话',
  negative: '负面信息',
  sanctions: '制裁名单',
  map: '地图',
  customs: '海关',
  social: '社媒',
};

const REASON_TEXT = {
  'needs-browser': '需浏览器',
  'no-matrix': '该国无覆盖',
  'no-free-data': '无免费数据',
  'login-required': '未登录',
  'login-wall': '未登录',
  'not-provided': '未提供',
  'search-blocked': '需过验证码',
  'no-double-match': '未找到同名主页',
  'name-only-match': '仅同名',
  'no-company-level-data': '该国无公开数据',
};

const COMPANY_CONTRA = ['RF-DOM-001', 'RF-DOM-002', 'RF-CORP-001', 'RF-CORP-002', 'RF-CORP-003', 'RF-CORP-004', 'RF-CORP-006', 'RF-NEG-001', 'RF-SAN-001'];
const CONTACT_CONTRA = ['RF-DOM-001', 'RF-DOM-002', 'RF-MAIL-001', 'RF-CORP-005'];
const SCALE_CONTRA = ['RF-CORP-002', 'RF-CORP-004'];
const LINK_CONTRA = ['RF-ID-002'];

const INQUIRY_LABELS = {
  tender: '招标邀请',
  sample: '样品申请',
  large_first_order: '大额首单',
  account_change: '换收款账户',
  pre_order: '订单确认',
  general: '一般询盘',
};

const ACTION_LABELS = ['回复和报价', '寄样和小额投入', '定制和大额备货', '收定金和付款'];

const CHECK_LABELS = { sanctions: '制裁名单', registry: '注册处', search: '公开搜索', map: '地图', other: '其他检查' };
const REASON_LABELS = {
  'no-network': '网络失败',
  'download-failed': '下载失败',
  'invalid-content': '下载内容不合法',
  'all-urls-failed': '所有地址失败',
  'login-wall': '需登录',
  timeout: '超时',
  stale: '数据陈旧',
};
const DEFAULT_NEXT_STEPS = {
  sanctions: '在 OFAC 官方站按公司名手动查一次',
  registry: '在注册处按公司名查登记，或要求对方提供注册证书',
  search: '换一个搜索引擎或换关键词再查一次',
  map: '在 Google 地图搜公司名，确认建筑和招牌',
  other: '人工补查一次',
};
const INCOMPLETE_COVERAGE = { sanctions: 'sanctions', registry: 'customs', search: 'negative', map: 'map' };
const DATA_SOURCE_LABELS = { sanctions_list: '制裁名单', registry: '注册处', map: '地图', search: '公开搜索', website: '官网', other: '其他' };
const DATA_LABEL_ORDER = ['制裁名单', '注册处', '地图', '公开搜索', '官网', '其他'];
const NEXT_STEPS_DIM = {
  company: '在注册处按公司名查登记，或要求对方提供注册证书',
  link: '用公司官方渠道的电话或邮箱回访一次该买家',
  contact: '比对官网上的联系方式，确认邮箱域名与官网一致',
  behavior: '核对对方要求的付款方式和收款账户是否与公司名一致',
  compliance: '在官方制裁名单站点按公司名查一次',
  scale: '问对方近一年的采购量和主要销售渠道',
};

function collectDataDates(evidence) {
  const values = new Map();
  for (const entry of evidence.evidence || []) {
    if (!entry || typeof entry !== 'object') continue;
    const date = text(entry.data_as_of);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const label = DATA_SOURCE_LABELS[entry.source_type];
    if (!label) continue;
    if (!values.has(label) || date > values.get(label)) values.set(label, date);
  }
  return DATA_LABEL_ORDER.filter((label) => values.has(label)).map((label) => [label, values.get(label)]);
}

const STATUS_TEXT = { '✅': '可以', '⚠️': '有条件', '⛔': '不建议' };

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

function charLength(value) {
  return Array.from(text(value)).length;
}

function hanLength(value) {
  return Array.from(text(value)).filter((ch) => /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(ch)).length;
}

function roundHalf(value) {
  return Math.floor(value + 0.5);
}

function hasFlag(flagIds, list) {
  return list.some((id) => flagIds.includes(id));
}

function layerValue(layers, key, sub) {
  const value = layers ? layers[key] : null;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value[sub] ?? null;
  return null;
}

function dimStatusWord(tenths, contradiction) {
  if (contradiction) return '有矛盾';
  if (tenths >= 9) return '已核实';
  if (tenths >= 6) return '基本核实';
  if (tenths >= 3) return '部分核实';
  return '未核实';
}

function dimSymbol(tenths, contradiction) {
  if (contradiction) return '⚠️';
  if (tenths >= 6) return '✅';
  if (tenths >= 3) return '🟡';
  return '❓';
}

function dimBar(tenths) {
  const filled = Math.floor((tenths + 1) / 2);
  return `${'■'.repeat(filled)}${'□'.repeat(5 - filled)}`;
}

function checkNormal(evidence, id) {
  return (evidence.checks || []).some((check) => check && check.id === id && check.result === 'normal');
}

function flagIdsOf(evidence) {
  return (evidence.flags || [])
    .map((flag) => (typeof flag === 'string' ? flag : flag && flag.id))
    .filter(Boolean);
}

export function computeCredit(evidence) {
  const layers = evidence.layers || {};
  const ids = flagIdsOf(evidence);

  const companyCred = layerValue(layers, 'company', 'credibility');
  let companyTenths = { high: 10, medium: 6, low: 0, unknown: 0 }[companyCred] ?? 0;
  let companyContra = hasFlag(ids, COMPANY_CONTRA);
  if (companyContra) companyTenths = 0;

  let linkTenths = { strong: 10, medium: 6, weak: 3, none: 0, contradiction: 0 }[layerValue(layers, 'person_company_link', 'strength')] ?? 0;
  const personLevel = layerValue(layers, 'person_authenticity', 'level');
  if (personLevel === 'high' && linkTenths < 10) linkTenths = Math.min(10, linkTenths + 1);
  const linkContra = layerValue(layers, 'person_company_link', 'strength') === 'contradiction' || hasFlag(ids, LINK_CONTRA);
  if (linkContra) linkTenths = 0;

  const contact = layers.contact || {};
  const contactPhone = contact.phone_matches === undefined ? checkNormal(evidence, 'phone') : contact.phone_matches === true;
  const contactEmail = contact.business_email === undefined ? checkNormal(evidence, 'email') : contact.business_email === true;
  const contactDomain = contact.domain_aged === undefined ? checkNormal(evidence, 'domain') : contact.domain_aged === true;
  let contactThirds = [contactPhone, contactEmail, contactDomain].filter(Boolean).length;
  const contactContra = hasFlag(ids, CONTACT_CONTRA);
  if (contactContra) contactThirds = 0;

  const compliance = layers.compliance || {};
  const sanctionsState = compliance.sanctions === undefined ? (checkNormal(evidence, 'sanctions') ? 'clear' : 'unchecked') : compliance.sanctions;
  const negativeState = compliance.negative === undefined ? (checkNormal(evidence, 'negative') ? 'clear' : 'unchecked') : compliance.negative;
  let complianceHalves = 0;
  if (sanctionsState === 'clear') complianceHalves += 1;
  if (negativeState === 'clear') complianceHalves += 1;

  const scale = layers.scale || {};
  const companyLayer = layers.company && typeof layers.company === 'object' ? layers.company : {};
  const mapVerdict = scale.map ?? (companyLayer.map_scale && companyLayer.map_scale.verdict) ?? 'unknown';
  const customsVerdict = scale.customs
    ?? ((companyLayer.main_business_matrix || []).some((row) => row && row.source === 'customs' && row.verdict === 'consistent') ? 'consistent' : 'unknown');
  let scaleHalves = 0;
  if (mapVerdict === 'matched') scaleHalves += 1;
  if (customsVerdict === 'consistent') scaleHalves += 1;
  const scaleContra = hasFlag(ids, SCALE_CONTRA);
  if (scaleContra) scaleHalves = 0;

  const creditTenths = 40 * companyTenths + 25 * linkTenths + 50 * contactThirds + 50 * complianceHalves + 50 * scaleHalves;
  const credit = Math.floor((creditTenths + 5) / 10);
  const tier = credit >= 75 ? '高' : credit >= 50 ? '中' : '低';

  const dims = [
    { key: 'company', label: '公司真实度', tenths: companyTenths, contradiction: companyContra },
    { key: 'link', label: '买家与公司的关联', tenths: linkTenths, contradiction: linkContra },
    { key: 'contact', label: '联系方式', tenths: Math.floor(contactThirds * 10 / 3), contradiction: contactContra },
    { key: 'compliance', label: '合规口碑', tenths: complianceHalves * 5, contradiction: false },
    { key: 'scale', label: '规模匹配', tenths: scaleHalves * 5, contradiction: scaleContra },
  ];
  for (const dim of dims) {
    dim.status = dimStatusWord(dim.tenths, dim.contradiction);
    dim.symbol = dimSymbol(dim.tenths, dim.contradiction);
    dim.bar = dimBar(dim.tenths);
  }
  return { score: credit, tier, dims, contactThirds, complianceHalves, scaleHalves };
}

function normalizeLevel(level) {
  return ['低', '中', '高', '需人工核实'].includes(level) ? level : '需人工核实';
}

function normalizeTier(tier) {
  return ['高', '中', '低'].includes(tier) ? tier : '低';
}

export function computeActions(levelInput, tierInput, companyLow, payFlag, stage, accountVerified, complianceChecked, openQuestions) {
  const level = normalizeLevel(levelInput);
  const tier = normalizeTier(tierInput);
  const questions = (openQuestions || []).map((item) => text(item)).filter(Boolean);
  const make = (key, label, status, condition) => ({ key, label, status, status_text: STATUS_TEXT[status], condition });

  let replyStatus = level === '高' ? '⚠️' : '✅';
  let replyCondition = replyStatus === '⚠️' ? '只做标准报价，不发定制方案' : '';

  let sampleStatus;
  if (level === '高') sampleStatus = '⛔';
  else if (companyLow || level === '需人工核实') sampleStatus = '⚠️';
  else if (level === '中') sampleStatus = '⚠️';
  else if (tier === '低') sampleStatus = '⚠️';
  else sampleStatus = '✅';
  const sampleCondition = sampleStatus === '⚠️' ? '先补核实（见一次动作）' : '';

  let customStatus;
  if (level === '高' || level === '需人工核实' || companyLow || tier === '低') customStatus = '⛔';
  else if (level === '中') customStatus = '⚠️';
  else if (tier === '中') customStatus = '⚠️';
  else if (tier === '高' && complianceChecked && questions.length === 0) customStatus = '✅';
  else customStatus = '⚠️';
  const parts = [];
  if (questions.length > 0) parts.push(`先确认${questions.slice(0, 2).join('、')}`);
  if (!complianceChecked) parts.push('先补制裁名单检查');
  const customCondition = customStatus === '⚠️' ? (parts.join('；') || '先补核实（见一次动作）') : '';

  let payStatus;
  let payCondition;
  if (level === '高') {
    payStatus = '⛔';
    payCondition = '';
  } else if (payFlag) {
    payStatus = '⛔';
    payCondition = '先做订单前复核（执照和收款账户）';
  } else if (stage === 'pre-order' && accountVerified) {
    payStatus = '✅';
    payCondition = '仍需电话回拨确认账户';
  } else {
    payStatus = '⛔';
    payCondition = '先做订单前复核（执照和收款账户）';
  }

  return [
    make('reply', ACTION_LABELS[0], replyStatus, replyCondition),
    make('sample', ACTION_LABELS[1], sampleStatus, sampleCondition),
    make('custom', ACTION_LABELS[2], customStatus, customCondition),
    make('payment', ACTION_LABELS[3], payStatus, payCondition),
  ];
}

function stripLeadingXian(value) {
  const s = text(value);
  return s.startsWith('先') ? s.slice(1) : s;
}

export function computeConclusion(levelInput, actions, firstUncovered) {
  const level = normalizeLevel(levelInput);
  if (level === '高') return '先不要投入：不寄样、不垫付、不付款。';
  const sample = actions[1];
  const custom = actions[2];
  if (sample.status === '✅' && custom.status === '✅') return '可以正常推进，收款前先做订单前复核。';
  if (sample.status === '✅' && custom.status === '⚠️') {
    return `可以报价、寄样；定制或大额备货前，先${stripLeadingXian(custom.condition)}。`;
  }
  if (sample.status === '⚠️') {
    return `可以先报价；投入前先${stripLeadingXian(sample.condition)}。`;
  }
  return `信息还不足：先报标准价，不要投入。最值钱的补充：${firstUncovered || '公司注册记录'}。`;
}

function reasonText(checkpoint, reason) {
  if (reason === 'no-public-record') {
    if (checkpoint === 'map') return '没找到商家';
    if (checkpoint === 'customs') return '公开库无记录';
    if (checkpoint === 'social') return '没找到主页';
    return '没查到';
  }
  return REASON_TEXT[reason] || reason || '未覆盖';
}

function parseUncovered(entry) {
  if (entry && typeof entry === 'object') {
    return { checkpoint: entry.checkpoint || 'unknown', reason: entry.reason || 'unknown' };
  }
  const parts = text(entry).split(':');
  return { checkpoint: parts[0] || 'unknown', reason: parts[2] || parts[1] || 'unknown' };
}

function uncoveredSentence(entry) {
  const { checkpoint, reason } = parseUncovered(entry);
  return `${CHECKPOINT_NAMES[checkpoint] || checkpoint}（${reasonText(checkpoint, reason)}）`;
}

function isTechnical(value) {
  const s = text(value);
  const lower = s.toLowerCase();
  if (/https?\s*\d{3}/.test(lower)) return true;
  if (/(^|[^a-z])http([^a-z]|$)/.test(lower)) return true;
  for (const term of ['mx', 'spf', 'dmarc', 'rdap', 'poi', 'captcha']) {
    if (new RegExp(`(^|[^a-z])${term}([^a-z]|$)`).test(lower)) return true;
  }
  if (lower.includes('api key') || lower.includes('api_key')) return true;
  return s.includes('误报');
}

const FORBIDDEN = ['骗子', '诈骗犯', '确定是假的', '一定有问题'];
const SCRIPT_FORBIDDEN = ['核实', '背调', '怀疑', '诈骗'];
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;
const PHONE_NON_NUMBER_PATTERNS = [
  '\\b\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}\\b',
  '\\b\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}\\b',
  '\\d{4}\\s*年\\s*\\d{1,2}\\s*月(?:\\s*\\d{1,2}\\s*日)?',
  '\\b\\d{1,2}:\\d{2}(?::\\d{2})?\\b',
  '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b',
  '\\b\\d+\\.\\d+\\.\\d+(?:\\.\\d+)?\\b',
  '(?:\\+|00)?\\d[\\d\\s()\\-*]*\\*[\\d\\s()\\-*]*',
];
const ID_CONTEXT_RE = /订单|编号|单号|\bID\b|No\./i;

export function containsFullPhone(value) {
  let cleaned = text(value);
  for (const source of PHONE_NON_NUMBER_PATTERNS) {
    cleaned = cleaned.replace(new RegExp(source, 'g'), ' ');
  }
  const candidateRe = /(?:\+|00)\d[\d\s().\-]{4,20}\d|\d[\d\s().\-]{4,20}\d/g;
  let match;
  while ((match = candidateRe.exec(cleaned)) !== null) {
    const candidate = match[0];
    const digits = Array.from(candidate).filter((char) => /\d/.test(char)).length;
    if (digits < 6 || digits > 15) continue;
    const hasInternational = candidate.startsWith('+') || candidate.startsWith('00');
    const hasSeparator = /[\s()\-]/.test(candidate.trim());
    if (ID_CONTEXT_RE.test(text(value)) && !hasInternational && !hasSeparator) continue;
    return true;
  }
  return false;
}

export function validateDisplay(evidence, rules) {
  const display = evidence.display;
  const errors = [];
  if (display === undefined || display === null) return errors;
  const add = (code, field) => errors.push({ code, field });
  if (typeof display !== 'object' || Array.isArray(display)) {
    add('invalid_type', 'display');
    return errors;
  }

  const flagIds = flagIdsOf(evidence);
  const flagIndex = new Map((rules.flags || []).map((flag) => [flag.id, flag]));

  if (!text(display.customer_label)) add('missing_field', 'customer_label');
  else if (charLength(display.customer_label) > 40) add('too_long', 'customer_label');
  if (!text(display.inquiry_type)) add('missing_field', 'inquiry_type');
  else if (charLength(display.inquiry_type) > 40) add('too_long', 'inquiry_type');

  const dimNotes = display.dim_notes;
  if (dimNotes !== undefined && dimNotes !== null) {
    if (typeof dimNotes !== 'object' || Array.isArray(dimNotes)) add('invalid_type', 'dim_notes');
    else {
      for (const [key, value] of Object.entries(dimNotes)) {
        if (typeof value !== 'string') add('invalid_type', `dim_notes.${key}`);
        else if (hanLength(value) > 28) add('too_long', `dim_notes.${key}`);
      }
    }
  }

  const checkList = (name, max) => {
    const list = display[name];
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) {
      add('invalid_type', name);
      return [];
    }
    if (list.length > max) add('too_many', name);
    return list;
  };

  const attention = checkList('attention', 3);
  for (const item of attention) {
    if (!item || typeof item !== 'object') { add('invalid_type', 'attention'); continue; }
    if (!['flag', 'clue'].includes(item.kind)) add('invalid_kind', 'attention.kind');
    if (item.kind === 'flag' && (!item.flag_id || !flagIds.includes(item.flag_id) || !flagIndex.has(item.flag_id))) add('unknown_flag', 'attention.flag_id');
    if (typeof item.text !== 'string') add('invalid_type', 'attention.text');
    else if (hanLength(item.text) > 30) add('too_long', 'attention.text');
  }

  const verified = checkList('verified', 3);
  for (const item of verified) {
    if (!item || typeof item !== 'object') { add('invalid_type', 'verified'); continue; }
    if (typeof item.text !== 'string') add('invalid_type', 'verified.text');
    else if (hanLength(item.text) > 30) add('too_long', 'verified.text');
  }

  const missing = checkList('missing', 2);
  for (const item of missing) {
    if (!item || typeof item !== 'object') { add('invalid_type', 'missing'); continue; }
    if (typeof item.text !== 'string') add('invalid_type', 'missing.text');
    else if (hanLength(item.text) > 30) add('too_long', 'missing.text');
    if (item.action !== undefined && item.action !== null) {
      const action = item.action;
      if (!action || typeof action !== 'object') add('invalid_type', 'missing.action');
      else {
        for (const key of ['label', 'link_text', 'url', 'instruction']) {
          if (!(key in action)) add('missing_action_field', `missing.action.${key}`);
        }
        if ('url' in action && action.url !== null && !/^https?:\/\//.test(text(action.url))) add('invalid_url', 'missing.action.url');
      }
    }
  }

  const scripts = checkList('scripts', 3);
  for (const item of scripts) {
    if (!item || typeof item !== 'object') { add('invalid_type', 'scripts'); continue; }
    if (typeof item.en !== 'string' || typeof item.zh !== 'string') add('invalid_type', 'scripts');
    else {
      for (const phrase of SCRIPT_FORBIDDEN) {
        if (item.en.includes(phrase) || item.zh.includes(phrase)) add('forbidden_word', 'scripts');
      }
    }
  }

  const questions = display.open_questions;
  if (questions !== undefined && questions !== null) {
    if (!Array.isArray(questions)) add('invalid_type', 'open_questions');
    else {
      if (questions.length > 3) add('too_many', 'open_questions');
      for (const item of questions) {
        if (typeof item !== 'string') add('invalid_type', 'open_questions');
        else if (hanLength(item) > 12) add('too_long', 'open_questions');
      }
    }
  }

  const flipHint = display.flip_hint;
  if (flipHint !== undefined && flipHint !== null) {
    if (typeof flipHint !== 'string') add('invalid_type', 'flip_hint');
    else if (charLength(flipHint) > 40) add('too_long', 'flip_hint');
  }

  const texts = [];
  const pushText = (field, value) => { if (typeof value === 'string') texts.push([field, value]); };
  pushText('customer_label', display.customer_label);
  pushText('inquiry_type', display.inquiry_type);
  pushText('supplement', display.supplement);
  if (dimNotes && typeof dimNotes === 'object' && !Array.isArray(dimNotes)) {
    for (const [key, value] of Object.entries(dimNotes)) pushText(`dim_notes.${key}`, value);
  }
  for (const item of attention) if (item && typeof item === 'object') pushText('attention.text', item.text);
  for (const item of verified) if (item && typeof item === 'object') pushText('verified.text', item.text);
  for (const item of missing) {
    if (!item || typeof item !== 'object') continue;
    pushText('missing.text', item.text);
    const action = item.action;
    if (action && typeof action === 'object') {
      pushText('missing.action.label', action.label);
      pushText('missing.action.link_text', action.link_text);
      pushText('missing.action.instruction', action.instruction);
    }
  }
  for (const item of scripts) {
    if (!item || typeof item !== 'object') continue;
    pushText('scripts.en', item.en);
    pushText('scripts.zh', item.zh);
  }
  for (const item of Array.isArray(questions) ? questions : []) pushText('open_questions', item);

  for (const [field, value] of texts) {
    if (isTechnical(value)) add('technical_term', field);
    if (FORBIDDEN.some((phrase) => value.includes(phrase))) add('forbidden_word', field);
    if (EMAIL_RE.test(value)) add('pii_email', field);
    if (containsFullPhone(value)) add('pii_phone', field);
  }

  const seen = new Set();
  return errors.filter((error) => {
    const key = `${error.code}:${error.field}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function defaultDimNote(key, status) {
  const table = {
    company: { 已核实: '官网和公开资料一致', 基本核实: '公开资料基本一致', 部分核实: '只核实了部分公开资料', 未核实: '暂未核实', 有矛盾: '公开资料和自称不一致' },
    link: { 已核实: '任职信息和询盘吻合', 基本核实: '能找到任职线索', 部分核实: '关联线索较少', 未核实: '暂未核实', 有矛盾: '职业资料和自称不符' },
    contact: { 已核实: '电话和邮箱都能对上', 基本核实: '部分联系方式能对上', 部分核实: '只核实了部分联系方式', 未核实: '暂未核实', 有矛盾: '联系方式对不上' },
    compliance: { 已核实: '制裁名单和公开检索都已核对', 基本核实: '部分合规信息已核对', 部分核实: '只核对了部分合规信息', 未核实: '暂未核实', 有矛盾: '发现合规问题' },
    scale: { 已核实: '规模和自称一致', 基本核实: '规模和自称基本一致', 部分核实: '规模线索较少', 未核实: '地图和海关都没查到', 有矛盾: '规模和自称不一致' },
  };
  return table[key][status] || '暂未核实';
}

function checkLabel(id) {
  const table = {
    company: '公司信息已核实',
    domain: '域名信息已核实',
    email: '邮箱信息已核实',
    phone: '电话信息已核实',
    negative: '公开检索没发现投诉',
    sanctions: '制裁名单没有匹配',
    map: '地图信息已核实',
    customs: '海关记录已核实',
  };
  return table[id] || '公开信息已核实';
}

function anchorCount(evidence) {
  const anchors = evidence.anchors || {};
  if (typeof anchors.count === 'number') return anchors.count;
  const closure = typeof anchors === 'string' ? anchors : anchors.closure;
  return { none: 0, single: 1, bidirectional: 2, independent: 3 }[closure] ?? 0;
}

function inquiryLabel(evidence, display) {
  if (display && text(display.inquiry_type)) return text(display.inquiry_type);
  const type = evidence.intake && evidence.intake.inquiry_type;
  if (type && INQUIRY_LABELS[type]) return INQUIRY_LABELS[type];
  return '一般询盘';
}

function customerLabel(evidence, display) {
  if (display && text(display.customer_label)) return text(display.customer_label);
  const company = (evidence.subject && evidence.subject.company) || (evidence.intake && evidence.intake.company);
  return text(company) || '该客户';
}

function inquiryText(evidence) {
  return text((evidence.intake && evidence.intake.inquiry_text) || evidence.inquiry_text || (evidence.subject && evidence.subject.inquiry_text));
}

function validateChecksIncomplete(evidence) {
  const raw = evidence.checks_incomplete;
  if (raw === undefined || raw === null) return { items: [], errors: [] };
  if (!Array.isArray(raw)) return { items: [], errors: [{ code: 'invalid-input', field: 'checks_incomplete' }] };
  const items = [];
  const errors = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ code: 'invalid-input', field: `checks_incomplete[${index}]` });
      return;
    }
    const check = item.check;
    const reason = item.reason;
    if (!(check in CHECK_LABELS)) errors.push({ code: 'invalid-input', field: `checks_incomplete[${index}].check` });
    if (!(reason in REASON_LABELS)) errors.push({ code: 'invalid-input', field: `checks_incomplete[${index}].reason` });
    const nextStep = item.next_step === undefined || item.next_step === null ? DEFAULT_NEXT_STEPS[check] || '人工补查一次' : item.next_step;
    if (typeof nextStep !== 'string' || charLength(nextStep) > 40) {
      errors.push({ code: 'invalid-input', field: `checks_incomplete[${index}].next_step` });
    }
    items.push({ check, reason, next_step: nextStep });
  });
  return { items, errors };
}

const SOURCE_GRADE_DEFAULT = {
  registry: 'official',
  sanctions_list: 'official',
  search: 'third_party',
  map: 'third_party',
  website: 'self_declared',
  user_input: 'self_declared',
  other: 'self_declared',
};
const GRADE_LABEL = { official: '官方', third_party: '第三方', self_declared: '自述' };
const GRADE_RANK = { self_declared: 0, third_party: 1, official: 2 };
const MULTI_SUFFIX = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'co.jp', 'com.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'com.hk', 'com.sg', 'com.tw', 'co.in', 'co.nz']);

function urlHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function registrableDomain(host) {
  const parts = host ? host.split('.') : [];
  if (parts.length <= 2) return host;
  if (MULTI_SUFFIX.has(parts.slice(-2).join('.'))) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

function gradeOf(entry) {
  if (entry.source_grade in GRADE_LABEL) return entry.source_grade;
  return SOURCE_GRADE_DEFAULT[entry.source_type] || 'self_declared';
}

function applyEvidenceRules(evidence, attention, verified, missing, attentionFromDisplay, verifiedFromDisplay) {
  if (!('evidence' in evidence)) {
    return { attention, verified, missing, evidenceMissing: 0, missingOverflow: 0, gradeWarnings: 0 };
  }
  const raw = Array.isArray(evidence.evidence) ? evidence.evidence : [];
  const index = new Map();
  const duplicates = new Set();
  let gradeWarnings = 0;
  const sourceToCheck = { sanctions_list: 'sanctions', registry: 'registry', search: 'search', map: 'map' };
  const blockedCheckNames = new Set((evidence.checks_incomplete || []).filter((item) => item && typeof item === 'object').map((item) => item.check));
  for (const entry of raw) {
    if (entry && typeof entry === 'object' && text(entry.id)) {
      const id = text(entry.id);
      if (index.has(id)) duplicates.add(id);
      index.set(id, entry);
    }
  }
  const evaluate = (item, target) => {
    const ids = item && item.evidence_ids;
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, label: '缺证据', gradeLabel: null };
    const entries = [];
    let allUser = true;
    for (const id of ids) {
      if (typeof id !== 'string' || !id || duplicates.has(id) || !index.has(id)) return { ok: false, label: '缺证据', gradeLabel: null };
      const entry = index.get(id);
      if (entry.source_type !== 'user_input') {
        allUser = false;
        if (!text(entry.url) || !text(entry.retrieved_at)) return { ok: false, label: '缺证据', gradeLabel: null };
      }
      if (blockedCheckNames.has(sourceToCheck[entry.source_type])) return { ok: false, label: '本次未完成，不能作为已核实', gradeLabel: null };
      entries.push(entry);
    }
    if (target === 'verified' && allUser) return { ok: false, label: '客户自述，未证实', gradeLabel: null };
    const grades = entries.map(gradeOf);
    for (const entry of entries) {
      const defaultGrade = SOURCE_GRADE_DEFAULT[entry.source_type] || 'self_declared';
      if (GRADE_RANK[entry.source_grade] > GRADE_RANK[defaultGrade]) gradeWarnings += 1;
    }
    if (target === 'verified') {
      const hasOfficial = grades.includes('official');
      const thirdDomains = new Set(
        entries
          .filter((entry, position) => grades[position] === 'third_party' && entry.url)
          .map((entry) => registrableDomain(urlHost(entry.url)))
          .filter(Boolean),
      );
      if (!hasOfficial && thirdDomains.size < 2) return { ok: false, label: '客户自述，未证实', gradeLabel: null };
    }
    const top = grades.length ? grades.reduce((best, grade) => (GRADE_RANK[grade] > GRADE_RANK[best] ? grade : best), 'self_declared') : 'self_declared';
    return { ok: true, label: '', gradeLabel: GRADE_LABEL[top] };
  };
  let evidenceMissing = 0;
  if (attention.length > 0) {
    const kept = [];
    const dropped = [];
    for (const item of attention) {
      const result = evaluate(item, 'attention');
      if (result.ok) {
        if (result.gradeLabel) item.grade_label = result.gradeLabel;
        kept.push(item);
      } else {
        const body = text(item.text) || text(item.flag_id);
        dropped.push({ text: `（${result.label}）${body}` });
      }
    }
    attention = kept;
    missing.push(...dropped);
    evidenceMissing += dropped.length;
  }
  if (verifiedFromDisplay) {
    const kept = [];
    const dropped = [];
    for (const item of verified) {
      if (!item || typeof item !== 'object') { kept.push(item); continue; }
      const result = evaluate(item, 'verified');
      if (result.ok) {
        if (result.gradeLabel) item.grade_label = result.gradeLabel;
        kept.push(item);
      } else dropped.push({ text: `（${result.label}）${text(item.text)}` });
    }
    verified = kept;
    missing.push(...dropped);
    evidenceMissing += dropped.length;
  }
  const missingOverflow = Math.max(0, missing.length - 2);
  return { attention, verified, missing, evidenceMissing, missingOverflow, gradeWarnings };
}

function validateConflicts(evidence) {
  const raw = evidence.conflicts;
  if (raw === undefined || raw === null) return { items: [], errors: [] };
  if (!Array.isArray(raw)) return { items: [], errors: [{ code: 'invalid-input', field: 'conflicts' }] };
  const evidenceIds = new Set((evidence.evidence || []).filter((entry) => entry && typeof entry === 'object' && text(entry.id)).map((entry) => text(entry.id)));
  const items = [];
  const errors = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push({ code: 'invalid-input', field: `conflicts[${index}]` });
      return;
    }
    const claims = [];
    for (const side of ['a', 'b']) {
      const value = item[side];
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ code: 'invalid-input', field: `conflicts[${index}].${side}` });
        continue;
      }
      const claim = text(value.claim);
      if (!claim || charLength(claim) > 30) errors.push({ code: 'invalid-input', field: `conflicts[${index}].${side}.claim` });
      if (!evidenceIds.has(text(value.evidence_id))) errors.push({ code: 'invalid-input', field: `conflicts[${index}].${side}.evidence_id` });
      claims.push(claim);
    }
    if (claims.length === 2) items.push({ kind: 'conflict', text: `来源冲突：${claims[0]}，${claims[1]}` });
  });
  return { items, errors };
}

export function renderCard(evidence, rules) {
  const display = evidence.display || {};
  const errors = validateDisplay(evidence, rules);
  if (errors.length > 0) return { status: 'invalid-display', errors };
  const incomplete = validateChecksIncomplete(evidence);
  if (incomplete.errors.length > 0) return { status: 'invalid-input', errors: incomplete.errors };
  if (evidence.evidence !== undefined && !Array.isArray(evidence.evidence)) {
    return { status: 'invalid-input', errors: [{ code: 'invalid-input', field: 'evidence' }] };
  }
  const conflicts = validateConflicts(evidence);
  if (conflicts.errors.length > 0) return { status: 'invalid-input', errors: conflicts.errors };

  const ids = flagIdsOf(evidence);
  const flagIndex = new Map((rules.flags || []).map((flag) => [flag.id, flag]));
  const flagWeight = (id) => (flagIndex.get(id) || {}).weight || 0;

  const coverage = evidence.coverage || {};
  const covered = coverage.checked === undefined ? null : coverage.checked;
  const total = coverage.total === undefined ? 8 : coverage.total;
  const incompleteCoverage = incomplete.items.filter((item) => item.check in INCOMPLETE_COVERAGE).length;
  const effectiveCovered = covered === null ? null : Math.max(0, covered - incompleteCoverage);
  const anchors = anchorCount(evidence);

  const layers = evidence.layers || {};
  const companyCred = layerValue(layers, 'company', 'credibility');
  const linkStrength = layerValue(layers, 'person_company_link', 'strength');
  const personLevel = layerValue(layers, 'person_authenticity', 'level');

  const recomputed = riskScore(ids, rules, evidence.unverifiable === true, covered, covered === null ? null : anchors, companyCred, linkStrength, personLevel);
  const stored = evidence.score || {};
  if (stored.risk_score !== undefined && stored.risk_score !== null) {
    const mismatch = Number(stored.risk_score) !== recomputed.risk_score || (stored.level !== undefined && stored.level !== null && stored.level !== recomputed.level);
    if (mismatch) {
      return {
        status: 'score-mismatch',
        expected: { risk_score: stored.risk_score, level: stored.level ?? null },
        actual: { risk_score: recomputed.risk_score, level: recomputed.level },
      };
    }
  }

  const credit = computeCredit(evidence);
  const level = recomputed.level;
  const score = recomputed.risk_score;
  const confidence = recomputed.confidence || evidence.confidence || '低';

  const behaviorFlags = ids.some((id) => /^RF-(PAY|ACC|BEH)-/.test(id));
  const behaviorStatus = behaviorFlags ? '有异常' : inquiryText(evidence) ? '无异常' : '未核实';
  const behaviorSymbol = behaviorFlags ? '⚠️' : behaviorStatus === '无异常' ? '✅' : '❓';

  const actions = computeActions(
    level,
    credit.tier,
    companyCred === 'low',
    ids.some((id) => /^RF-(PAY|ACC)-/.test(id)),
    evidence.stage || 'inquiry',
    Boolean(evidence.account_verified),
    credit.complianceHalves >= 2,
    display.open_questions || [],
  );

  const uncovered = Array.isArray(coverage.uncovered) ? coverage.uncovered : [];
  const uncoveredText = uncovered.length > 0 ? uncovered.map(uncoveredSentence).join('、') : '无';
  const firstUncovered = uncovered.length > 0 ? (CHECKPOINT_NAMES[parseUncovered(uncovered[0]).checkpoint] || '公司注册记录') : '公司注册记录';
  const conclusion = computeConclusion(level, actions, firstUncovered);

  const dimNotes = display.dim_notes || {};
  const newMode = ['evidence', 'checks_incomplete', 'conflicts'].some((key) => key in evidence);
  const dims = credit.dims.map((dim) => {
    let note = text(dimNotes[dim.key]);
    if (newMode && dim.status === '未核实' && (!note || note === '暂未核实')) note = NEXT_STEPS_DIM[dim.key] || '人工补查一次';
    return { ...dim, note: note || defaultDimNote(dim.key, dim.status) };
  });
  let behaviorNote = text(dimNotes.behavior);
  if (newMode && behaviorStatus === '未核实' && (!behaviorNote || behaviorNote === '暂未核实')) behaviorNote = NEXT_STEPS_DIM.behavior;
  dims.splice(3, 0, { key: 'behavior', label: '交易行为', status: behaviorStatus, symbol: behaviorSymbol, bar: '—', note: behaviorNote || (behaviorStatus === '有异常' ? '发现异常交易要求' : behaviorStatus === '无异常' ? '没发现异常交易要求' : '没有询盘原文') });

  const flagAttention = ids
    .filter((id) => flagIndex.has(id))
    .map((id) => ({ id, name: flagIndex.get(id).name, weight: flagIndex.get(id).weight }))
    .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let attention = [];
  if (Array.isArray(display.attention) && display.attention.length > 0) {
    attention = display.attention.map((item) => ({ ...item }));
  } else if ('evidence' in evidence) {
    const flagEntries = new Map((evidence.flags || []).filter((item) => item && typeof item === 'object' && text(item.id)).map((item) => [text(item.id), item]));
    attention = [];
    for (const flag of flagAttention) {
      const item = { kind: 'flag', flag_id: flag.id, text: '' };
      const ids = (flagEntries.get(flag.id) || {}).evidence_ids;
      if (Array.isArray(ids) && ids.length > 0) item.evidence_ids = ids;
      attention.push(item);
    }
  } else {
    attention = flagAttention.map((flag) => ({ kind: 'flag', flag_id: flag.id, text: '' }));
  }
  attention = attention
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const weightA = a.item.kind === 'flag' ? flagWeight(a.item.flag_id) : -1;
      const weightB = b.item.kind === 'flag' ? flagWeight(b.item.flag_id) : -1;
      return weightB - weightA || a.index - b.index;
    })
    .map(({ item }) => item);

  let verified = [];
  const blockedChecks = new Set(incomplete.items.map((item) => item.check));
  const checkIsBlocked = (checkId) => {
    if (blockedChecks.has(checkId)) return true;
    if ((checkId === 'registry' || checkId === 'customs') && blockedChecks.has('registry')) return true;
    if (checkId === 'negative' && blockedChecks.has('search')) return true;
    return false;
  };
  if (Array.isArray(display.verified) && display.verified.length > 0) {
    verified = display.verified.filter((item) => item && typeof item === 'object').map((item) => ({ ...item }));
  } else if ('evidence' in evidence) {
    verified = [];
  } else {
    verified = (evidence.checks || [])
      .filter((check) => check && check.result === 'normal' && !checkIsBlocked(check.id || check.dimension))
      .slice(0, 3)
      .map((check) => checkLabel(check.id || check.dimension));
    if (verified.length === 0) verified = ['暂无可列出的已核实项'];
  }

  let missing = [];
  if (Array.isArray(display.missing) && display.missing.length > 0) {
    missing = display.missing.map((item) => ({ ...item }));
  } else {
    missing = uncovered.slice(0, 2).map((entry) => {
      const parsed = parseUncovered(entry);
      return { text: `${CHECKPOINT_NAMES[parsed.checkpoint] || parsed.checkpoint}：${reasonText(parsed.checkpoint, parsed.reason)}` };
    });
    if (missing.length === 0) missing = [{ text: '暂无可补充的公开信息' }];
  }

  const applied = applyEvidenceRules(
    evidence,
    attention,
    verified,
    missing,
    Array.isArray(display.attention) && display.attention.length > 0,
    Array.isArray(display.verified) && display.verified.length > 0,
  );
  attention = applied.attention;
  verified = applied.verified;
  missing = applied.missing;
  if (conflicts.items.length > 0) {
    attention = attention.slice(0, Math.max(0, 3 - Math.min(3, conflicts.items.length))).concat(conflicts.items.slice(0, 3));
  }

  const actionRows = missing
    .filter((item) => item.action)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.gain ?? 0) - (a.item.gain ?? 0) || a.index - b.index)
    .slice(0, 4)
    .map(({ item }) => item.action);

  const scripts = Array.isArray(display.scripts) ? display.scripts.slice(0, 3) : [];

  const color = { 低: '🟢', 中: '🟡', 高: '🔴', 需人工核实: '⚪' }[level] || '⚪';
  const levelLabel = level === '需人工核实' ? '需人工核实' : `${level}风险`;
  const filled = level === '需人工核实' ? 0 : roundHalf(score / 10);
  const bar = `${'■'.repeat(filled)}${'□'.repeat(10 - filled)}`;

  const lines = [];
  let benignId = null;
  if (newMode) {
    const flagItems = attention.filter((item) => item.kind === 'flag' && flagIndex.has(item.flag_id));
    if (flagItems.length > 0) {
      benignId = flagItems.reduce((best, item) => (flagIndex.get(item.flag_id).weight > flagIndex.get(best.flag_id).weight ? item : best), flagItems[0]).flag_id;
    }
  }
  const incompleteSuffix = incomplete.items.length > 0 ? ` · 有 ${incomplete.items.length} 项未完成` : '';
  if (level === '需人工核实' && newMode) {
    lines.push(`## ⚪ 需人工核实 · 风险 待核实 ｜ 核实度 ${credit.score}/100（${credit.tier}）${incompleteSuffix}`);
  } else {
    lines.push(`## ${color} ${levelLabel} · 风险 ${score}/100 ${bar} ｜ 核实度 ${credit.score}/100（${credit.tier}）${incompleteSuffix}`);
  }
  lines.push(`置信度：${confidence}（锚点 ${anchors}/3）｜覆盖：${effectiveCovered === null ? 0 : effectiveCovered}/${total}｜未覆盖：${uncoveredText}`);
  if (incomplete.items.length > 0) {
    const details = incomplete.items
      .map((item) => `${CHECK_LABELS[item.check] || item.check}未完成（${REASON_LABELS[item.reason] || item.reason}）→ ${item.next_step}`)
      .join('；');
    lines.push(`⚠ 本次未完成：${details}`);
  }
  lines.push(`**结论：${conclusion}** 客户：${customerLabel(evidence, display)} · ${inquiryLabel(evidence, display)}`);
  lines.push('');
  lines.push('| 动作 | 建议 | 条件 |');
  lines.push('| --- | --- | --- |');
  for (const action of actions) lines.push(`| ${action.label} | ${action.status} ${action.status_text} |${action.condition ? ` ${action.condition}` : ''} |`);
  const firstScreenLines = lines.length;
  lines.push('');
  lines.push('| 维度 | 状态 | 依据 |');
  lines.push('| --- | --- | --- |');
  for (const dim of dims) lines.push(`| ${dim.label} | ${dim.symbol} ${dim.bar} ${dim.status} | ${dim.note} |`);
  lines.push('');
  const dataDates = collectDataDates(evidence);
  if (dataDates.length > 0) lines.push(`数据日期：${dataDates.map(([label, date]) => `${label} ${date}`).join(' · ')}`);
  const flipHint = text(display.flip_hint);
  if (newMode && flipHint) lines.push(`什么会改变结论：${flipHint}`);
  lines.push('**需要注意**');
  if (attention.length === 0) {
    lines.push('- 未发现需要注意的信号');
  } else {
    for (const item of attention) {
      const gradeLabel = item.grade_label ? ` [${item.grade_label}]` : '';
      if (item.kind === 'flag') {
        const info = flagIndex.get(item.flag_id) || { name: item.flag_id, weight: 0 };
        const symbol = info.weight >= 4 ? '🔴' : '🟡';
        const body = text(item.text);
        const benign = item.flag_id === benignId && info.benign ? ` · 可能无害：${info.benign}` : '';
        lines.push(`- ${symbol} ${info.name}（${item.flag_id}）${body ? `：${body}` : ''}${gradeLabel}${benign}`);
      } else if (item.kind === 'conflict') {
        lines.push(`- ⚠ ${text(item.text)}`);
      } else {
        lines.push(`- 🟡 ${text(item.text)}${gradeLabel}`);
      }
    }
  }
  lines.push('');
  lines.push('**已核实**');
  for (const item of verified.slice(0, 3)) {
    if (typeof item === 'string') lines.push(`- 🟢 ${item}`);
    else lines.push(`- 🟢 ${text(item.text)}${item.grade_label ? ` [${item.grade_label}]` : ''}`);
  }
  lines.push('');
  lines.push('**没查到（没查到不代表没问题）**');
  for (const item of missing.slice(0, 2)) lines.push(`- ⚪ ${text(item.text)}`);
  if (applied.missingOverflow > 0) lines.push(`- ⚪ 另有 ${applied.missingOverflow} 项未列出`);
  lines.push('');
  if (actionRows.length > 0) {
    lines.push('**一次动作**');
    for (const action of actionRows) {
      const label = text(action.label);
      const instruction = text(action.instruction);
      if (action.url) {
        const linkText = text(action.link_text) || label;
        lines.push(`▸ ${label} — [${linkText}](${action.url})：${instruction}`);
      } else {
        lines.push(`▸ ${label} — ${instruction}`);
      }
    }
    lines.push('');
  }
  if (scripts.length > 0) {
    lines.push('**建议这样回复（任选）**');
    scripts.forEach((script, index) => {
      lines.push(`${index + 1}. ${text(script.en)}`);
      lines.push(`   ${text(script.zh)}`);
    });
    lines.push('');
  }
  let supplement = text(display.supplement);
  if (!supplement) supplement = actionRows.length > 0 ? `补充${text(actionRows[0].label)}结果后，核实度会更高。` : '信息越多，判断越准。';
  const punctuation = /[。！？]$/.test(supplement) ? '' : '。';
  lines.push(`${supplement}${punctuation}需要完整报告请回复“出完整报告”。`);
  lines.push(newMode ? '仅基于公开信息的风险信号筛查，不构成对客户的定性。' : '仅为基于公开信息的风险提示，不构成法律意见。');

  return {
    status: 'ok',
    credit: { score: credit.score, tier: credit.tier },
    level,
    risk_score: score,
    confidence,
    dimensions: dims,
    actions,
    conclusion,
    evidence_missing: applied.evidenceMissing,
    source_grade_warnings: applied.gradeWarnings,
    line_count: lines.length,
    first_screen_lines: firstScreenLines,
    card: lines.join('\n'),
  };
}

export function ladderCombinations() {
  const levels = ['低', '中', '高', '需人工核实'];
  const tiers = ['高', '中', '低'];
  const combos = [];
  for (const level of levels) {
    for (const tier of tiers) {
      for (const companyLow of [false, true]) {
        for (const payFlag of [false, true]) {
          for (const stage of ['inquiry', 'pre-order']) {
            for (const accountVerified of [false, true]) {
              for (const complianceChecked of [false, true]) {
                for (const questions of [[], ['确认品牌', '确认地点']]) {
                  const actions = computeActions(level, tier, companyLow, payFlag, stage, accountVerified, complianceChecked, questions);
                  combos.push({
                    input: { level, credit_tier: tier, company_low: companyLow, pay_flag: payFlag, stage, account_verified: accountVerified, compliance_checked: complianceChecked, open_questions: questions },
                    actions,
                    conclusion: computeConclusion(level, actions, '公司注册记录'),
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return combos;
}

function readInput(source) {
  let raw;
  if (source === '-') raw = readFileSync(0, 'utf8');
  else raw = readFileSync(source, 'utf8');
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const args = { source: null, json: false, ladder: false, rules: RULES_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token === '--ladder') args.ladder = true;
    else if (token === '--rules') args.rules = argv[++i];
    else if (!token.startsWith('--') && args.source === null) args.source = token;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let rules;
  try {
    rules = loadRules(args.rules);
  } catch (error) {
    console.log(JSON.stringify({ status: 'invalid-input', error: String(error) }));
    return 1;
  }
  if (args.ladder) {
    console.log(JSON.stringify({ status: 'ok', combos: ladderCombinations(0) }));
    return 0;
  }
  if (!args.source) {
    console.log(JSON.stringify({ status: 'invalid-input', error: 'missing evidence pack path' }));
    return 1;
  }
  let evidence;
  try {
    evidence = readInput(args.source);
  } catch (error) {
    console.log(JSON.stringify({ status: 'invalid-input', error: String(error) }));
    return 1;
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    console.log(JSON.stringify({ status: 'invalid-input', error: 'evidence pack must be an object' }));
    return 1;
  }
  const result = renderCard(evidence, rules);
  if (args.json || result.status !== 'ok') {
    console.log(JSON.stringify(result));
  } else {
    console.log(result.card);
  }
  return result.status === 'ok' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
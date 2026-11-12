#!/usr/bin/env python3
"""Render a deterministic buyer-check conclusion card from an evidence pack.

Computes the credit score, the six-dimension status, the four-step action
ladder and the conclusion sentence from the same evidence pack, validates the
optional display fields, re-checks the risk score and prints Markdown. Never
touches the network, writes files or reads the system clock (acceptance cases
A27-A39).

Usage:
    python render_card.py evidence.json
    python render_card.py evidence.json --json
    cat evidence.json | python render_card.py -
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from urllib.parse import urlparse

from risk_score import load_rules, score as risk_score

RULES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "red_flags.json")

CHECKPOINT_NAMES = {
    "company": "公司名",
    "domain": "域名",
    "email": "邮箱",
    "phone": "电话",
    "negative": "负面信息",
    "sanctions": "制裁名单",
    "map": "地图",
    "customs": "海关",
    "social": "社媒",
}

REASON_TEXT = {
    "needs-browser": "需浏览器",
    "no-matrix": "该国无覆盖",
    "no-free-data": "无免费数据",
    "login-required": "未登录",
    "login-wall": "未登录",
    "not-provided": "未提供",
    "search-blocked": "需过验证码",
    "no-double-match": "未找到同名主页",
    "name-only-match": "仅同名",
    "no-company-level-data": "该国无公开数据",
}

COMPANY_CONTRA = ["RF-DOM-001", "RF-DOM-002", "RF-CORP-001", "RF-CORP-002", "RF-CORP-003", "RF-CORP-004", "RF-CORP-006", "RF-NEG-001", "RF-SAN-001"]
CONTACT_CONTRA = ["RF-DOM-001", "RF-DOM-002", "RF-MAIL-001", "RF-CORP-005"]
SCALE_CONTRA = ["RF-CORP-002", "RF-CORP-004"]
LINK_CONTRA = ["RF-ID-002"]

INQUIRY_LABELS = {
    "tender": "招标邀请",
    "sample": "样品申请",
    "large_first_order": "大额首单",
    "account_change": "换收款账户",
    "pre_order": "订单确认",
    "general": "一般询盘",
}

ACTION_LABELS = ["回复和报价", "寄样和小额投入", "定制和大额备货", "收定金和付款"]

CHECK_LABELS = {"sanctions": "制裁名单", "registry": "注册处", "search": "公开搜索", "map": "地图", "other": "其他检查"}
REASON_LABELS = {
    "no-network": "网络失败",
    "download-failed": "下载失败",
    "invalid-content": "下载内容不合法",
    "all-urls-failed": "所有地址失败",
    "login-wall": "需登录",
    "timeout": "超时",
    "stale": "数据陈旧",
}
DEFAULT_NEXT_STEPS = {
    "sanctions": "在 OFAC 官方站按公司名手动查一次",
    "registry": "在注册处按公司名查登记，或要求对方提供注册证书",
    "search": "换一个搜索引擎或换关键词再查一次",
    "map": "在 Google 地图搜公司名，确认建筑和招牌",
    "other": "人工补查一次",
}
INCOMPLETE_COVERAGE = {"sanctions": "sanctions", "registry": "customs", "search": "negative", "map": "map"}
DATA_SOURCE_LABELS = {"sanctions_list": "制裁名单", "registry": "注册处", "map": "地图", "search": "公开搜索", "website": "官网", "other": "其他"}
DATA_LABEL_ORDER = ["制裁名单", "注册处", "地图", "公开搜索", "官网", "其他"]
NEXT_STEPS_DIM = {
    "company": "在注册处按公司名查登记，或要求对方提供注册证书",
    "link": "用公司官方渠道的电话或邮箱回访一次该买家",
    "contact": "比对官网上的联系方式，确认邮箱域名与官网一致",
    "behavior": "核对对方要求的付款方式和收款账户是否与公司名一致",
    "compliance": "在官方制裁名单站点按公司名查一次",
    "scale": "问对方近一年的采购量和主要销售渠道",
}


def collect_data_dates(evidence):
    values = {}
    for entry in evidence.get("evidence") or []:
        if not isinstance(entry, dict):
            continue
        date = text(entry.get("data_as_of"))
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            continue
        label = DATA_SOURCE_LABELS.get(entry.get("source_type"))
        if label:
            values[label] = max(values.get(label, ""), date)
    return [(label, values[label]) for label in DATA_LABEL_ORDER if label in values]

STATUS_TEXT = {"✅": "可以", "⚠️": "有条件", "⛔": "不建议"}


def text(value) -> str:
    return "" if value is None else str(value)


def char_length(value) -> int:
    return len(text(value))


def han_length(value) -> int:
    return sum(1 for ch in text(value) if "\u3400" <= ch <= "\u4dbf" or "\u4e00" <= ch <= "\u9fff" or "\uf900" <= ch <= "\ufaff")


def round_half(value):
    import math

    return math.floor(value + 0.5)


def has_flag(flag_ids, names):
    return any(item in flag_ids for item in names)


def layer_value(layers, key, sub):
    value = (layers or {}).get(key)
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get(sub)
    return None


def dim_status_word(tenths, contradiction):
    if contradiction:
        return "有矛盾"
    if tenths >= 9:
        return "已核实"
    if tenths >= 6:
        return "基本核实"
    if tenths >= 3:
        return "部分核实"
    return "未核实"


def dim_symbol(tenths, contradiction):
    if contradiction:
        return "⚠️"
    if tenths >= 6:
        return "✅"
    if tenths >= 3:
        return "🟡"
    return "❓"


def dim_bar(tenths):
    filled = (tenths + 1) // 2
    return "■" * filled + "□" * (5 - filled)


def check_normal(evidence, check_id):
    return any(isinstance(check, dict) and check.get("id") == check_id and check.get("result") == "normal" for check in (evidence.get("checks") or []))


def flag_ids_of(evidence):
    result = []
    for flag in evidence.get("flags") or []:
        if isinstance(flag, str):
            result.append(flag)
        elif isinstance(flag, dict) and flag.get("id"):
            result.append(flag["id"])
    return result


def compute_credit(evidence):
    layers = evidence.get("layers") or {}
    ids = flag_ids_of(evidence)

    company_cred = layer_value(layers, "company", "credibility")
    company_tenths = {"high": 10, "medium": 6, "low": 0, "unknown": 0}.get(company_cred, 0)
    company_contra = has_flag(ids, COMPANY_CONTRA)
    if company_contra:
        company_tenths = 0

    link_tenths = {"strong": 10, "medium": 6, "weak": 3, "none": 0, "contradiction": 0}.get(layer_value(layers, "person_company_link", "strength"), 0)
    person_level = layer_value(layers, "person_authenticity", "level")
    if person_level == "high" and link_tenths < 10:
        link_tenths = min(10, link_tenths + 1)
    link_contra = layer_value(layers, "person_company_link", "strength") == "contradiction" or has_flag(ids, LINK_CONTRA)
    if link_contra:
        link_tenths = 0

    contact = layers.get("contact") or {}
    contact_phone = check_normal(evidence, "phone") if contact.get("phone_matches") is None else contact.get("phone_matches") is True
    contact_email = check_normal(evidence, "email") if contact.get("business_email") is None else contact.get("business_email") is True
    contact_domain = check_normal(evidence, "domain") if contact.get("domain_aged") is None else contact.get("domain_aged") is True
    contact_thirds = sum(1 for item in (contact_phone, contact_email, contact_domain) if item)
    contact_contra = has_flag(ids, CONTACT_CONTRA)
    if contact_contra:
        contact_thirds = 0

    compliance = layers.get("compliance") or {}
    sanctions_state = compliance.get("sanctions")
    if sanctions_state is None:
        sanctions_state = "clear" if check_normal(evidence, "sanctions") else "unchecked"
    negative_state = compliance.get("negative")
    if negative_state is None:
        negative_state = "clear" if check_normal(evidence, "negative") else "unchecked"
    compliance_halves = 0
    if sanctions_state == "clear":
        compliance_halves += 1
    if negative_state == "clear":
        compliance_halves += 1

    scale = layers.get("scale") or {}
    company_layer = layers.get("company") if isinstance(layers.get("company"), dict) else {}
    map_scale = company_layer.get("map_scale") or {}
    map_verdict = scale.get("map") if scale.get("map") is not None else map_scale.get("verdict") or "unknown"
    matrix = company_layer.get("main_business_matrix") or []
    customs_verdict = scale.get("customs")
    if customs_verdict is None:
        customs_verdict = "consistent" if any(isinstance(row, dict) and row.get("source") == "customs" and row.get("verdict") == "consistent" for row in matrix) else "unknown"
    scale_halves = 0
    if map_verdict == "matched":
        scale_halves += 1
    if customs_verdict == "consistent":
        scale_halves += 1
    scale_contra = has_flag(ids, SCALE_CONTRA)
    if scale_contra:
        scale_halves = 0

    credit_tenths = 40 * company_tenths + 25 * link_tenths + 50 * contact_thirds + 50 * compliance_halves + 50 * scale_halves
    credit = (credit_tenths + 5) // 10
    tier = "高" if credit >= 75 else "中" if credit >= 50 else "低"

    dims = [
        {"key": "company", "label": "公司真实度", "tenths": company_tenths, "contradiction": company_contra},
        {"key": "link", "label": "买家与公司的关联", "tenths": link_tenths, "contradiction": link_contra},
        {"key": "contact", "label": "联系方式", "tenths": contact_thirds * 10 // 3, "contradiction": contact_contra},
        {"key": "compliance", "label": "合规口碑", "tenths": compliance_halves * 5, "contradiction": False},
        {"key": "scale", "label": "规模匹配", "tenths": scale_halves * 5, "contradiction": scale_contra},
    ]
    for dim in dims:
        dim["status"] = dim_status_word(dim["tenths"], dim["contradiction"])
        dim["symbol"] = dim_symbol(dim["tenths"], dim["contradiction"])
        dim["bar"] = dim_bar(dim["tenths"])
    return {"score": credit, "tier": tier, "dims": dims, "contact_thirds": contact_thirds, "compliance_halves": compliance_halves, "scale_halves": scale_halves}


def normalize_level(level):
    return level if level in ("低", "中", "高", "需人工核实") else "需人工核实"


def normalize_tier(tier):
    return tier if tier in ("高", "中", "低") else "低"


def compute_actions(level_input, tier_input, company_low, pay_flag, stage, account_verified, compliance_checked, open_questions):
    level = normalize_level(level_input)
    tier = normalize_tier(tier_input)
    questions = [text(item) for item in (open_questions or []) if text(item)]

    def make(key, label, status, condition):
        return {"key": key, "label": label, "status": status, "status_text": STATUS_TEXT[status], "condition": condition}

    reply_status = "⚠️" if level == "高" else "✅"
    reply_condition = "只做标准报价，不发定制方案" if reply_status == "⚠️" else ""

    if level == "高":
        sample_status = "⛔"
    elif company_low or level == "需人工核实":
        sample_status = "⚠️"
    elif level == "中":
        sample_status = "⚠️"
    elif tier == "低":
        sample_status = "⚠️"
    else:
        sample_status = "✅"
    sample_condition = "先补核实（见一次动作）" if sample_status == "⚠️" else ""

    if level == "高" or level == "需人工核实" or company_low or tier == "低":
        custom_status = "⛔"
    elif level == "中":
        custom_status = "⚠️"
    elif tier == "中":
        custom_status = "⚠️"
    elif tier == "高" and compliance_checked and not questions:
        custom_status = "✅"
    else:
        custom_status = "⚠️"
    parts = []
    if questions:
        parts.append("先确认" + "、".join(questions[:2]))
    if not compliance_checked:
        parts.append("先补制裁名单检查")
    custom_condition = ("；".join(parts) or "先补核实（见一次动作）") if custom_status == "⚠️" else ""

    if level == "高":
        pay_status = "⛔"
        pay_condition = ""
    elif pay_flag:
        pay_status = "⛔"
        pay_condition = "先做订单前复核（执照和收款账户）"
    elif stage == "pre-order" and account_verified:
        pay_status = "✅"
        pay_condition = "仍需电话回拨确认账户"
    else:
        pay_status = "⛔"
        pay_condition = "先做订单前复核（执照和收款账户）"

    return [
        make("reply", ACTION_LABELS[0], reply_status, reply_condition),
        make("sample", ACTION_LABELS[1], sample_status, sample_condition),
        make("custom", ACTION_LABELS[2], custom_status, custom_condition),
        make("payment", ACTION_LABELS[3], pay_status, pay_condition),
    ]


def strip_leading_xian(value):
    value = text(value)
    return value[1:] if value.startswith("先") else value


def compute_conclusion(level_input, actions, first_uncovered):
    level = normalize_level(level_input)
    if level == "高":
        return "先不要投入：不寄样、不垫付、不付款。"
    sample = actions[1]
    custom = actions[2]
    if sample["status"] == "✅" and custom["status"] == "✅":
        return "可以正常推进，收款前先做订单前复核。"
    if sample["status"] == "✅" and custom["status"] == "⚠️":
        return f"可以报价、寄样；定制或大额备货前，先{strip_leading_xian(custom['condition'])}。"
    if sample["status"] == "⚠️":
        return f"可以先报价；投入前先{strip_leading_xian(sample['condition'])}。"
    return f"信息还不足：先报标准价，不要投入。最值钱的补充：{first_uncovered or '公司注册记录'}。"


def reason_text(checkpoint, reason):
    if reason == "no-public-record":
        if checkpoint == "map":
            return "没找到商家"
        if checkpoint == "customs":
            return "公开库无记录"
        if checkpoint == "social":
            return "没找到主页"
        return "没查到"
    return REASON_TEXT.get(reason, reason or "未覆盖")


def parse_uncovered(entry):
    if isinstance(entry, dict):
        return {"checkpoint": entry.get("checkpoint") or "unknown", "reason": entry.get("reason") or "unknown"}
    parts = text(entry).split(":")
    checkpoint = parts[0] if parts else "unknown"
    reason = parts[2] if len(parts) > 2 else (parts[1] if len(parts) > 1 else "unknown")
    return {"checkpoint": checkpoint, "reason": reason}


def uncovered_sentence(entry):
    parsed = parse_uncovered(entry)
    checkpoint = parsed["checkpoint"]
    return f"{CHECKPOINT_NAMES.get(checkpoint, checkpoint)}（{reason_text(checkpoint, parsed['reason'])}）"


def is_technical(value):
    raw = text(value)
    lower = raw.lower()
    if re.search(r"https?\s*\d{3}", lower):
        return True
    if re.search(r"(^|[^a-z])http([^a-z]|$)", lower):
        return True
    for term in ("mx", "spf", "dmarc", "rdap", "poi", "captcha"):
        if re.search(r"(^|[^a-z])" + term + r"([^a-z]|$)", lower):
            return True
    if "api key" in lower or "api_key" in lower:
        return True
    return "误报" in raw


FORBIDDEN = ["骗子", "诈骗犯", "确定是假的", "一定有问题"]
SCRIPT_FORBIDDEN = ["核实", "背调", "怀疑", "诈骗"]
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
PHONE_CANDIDATE_RE = re.compile(r"(?:\+|00)\d[\d\s().\-]{4,20}\d|\d[\d\s().\-]{4,20}\d")
MASKED_PHONE_RE = re.compile(r"(?:\+|00)?\d[\d\s()\-*]*\*[\d\s()\-*]*")
PHONE_NON_NUMBER_RES = [
    re.compile(r"\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b"),
    re.compile(r"\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b"),
    re.compile(r"\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?"),
    re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b"),
    re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
    re.compile(r"\b\d+\.\d+\.\d+(?:\.\d+)?\b"),
    MASKED_PHONE_RE,
]
ID_CONTEXT_RE = re.compile(r"订单|编号|单号|\bID\b|No\.", re.IGNORECASE)


def contains_full_phone(value):
    raw = text(value)
    cleaned = raw
    for pattern in PHONE_NON_NUMBER_RES:
        cleaned = pattern.sub(" ", cleaned)
    for match in PHONE_CANDIDATE_RE.finditer(cleaned):
        candidate = match.group(0)
        digits = sum(1 for char in candidate if char.isdigit())
        if not (6 <= digits <= 15):
            continue
        has_international = candidate.startswith("+") or candidate.startswith("00")
        has_separator = bool(re.search(r"[\s()\-]", candidate.strip()))
        if ID_CONTEXT_RE.search(raw) and not has_international and not has_separator:
            continue
        return True
    return False


def validate_display(evidence, rules):
    display = evidence.get("display")
    errors = []
    if display is None:
        return errors

    def add(code, field):
        errors.append({"code": code, "field": field})

    if not isinstance(display, dict):
        add("invalid_type", "display")
        return errors

    flag_ids = flag_ids_of(evidence)
    flag_index = {flag.get("id"): flag for flag in (rules.get("flags") or [])}

    if not text(display.get("customer_label")):
        add("missing_field", "customer_label")
    elif char_length(display.get("customer_label")) > 40:
        add("too_long", "customer_label")
    if not text(display.get("inquiry_type")):
        add("missing_field", "inquiry_type")
    elif char_length(display.get("inquiry_type")) > 40:
        add("too_long", "inquiry_type")

    dim_notes = display.get("dim_notes")
    if dim_notes is not None:
        if not isinstance(dim_notes, dict):
            add("invalid_type", "dim_notes")
        else:
            for key, value in dim_notes.items():
                if not isinstance(value, str):
                    add("invalid_type", f"dim_notes.{key}")
                elif han_length(value) > 28:
                    add("too_long", f"dim_notes.{key}")

    def check_list(name, maximum):
        value = display.get(name)
        if value is None:
            return []
        if not isinstance(value, list):
            add("invalid_type", name)
            return []
        if len(value) > maximum:
            add("too_many", name)
        return value

    attention = check_list("attention", 3)
    for item in attention:
        if not isinstance(item, dict):
            add("invalid_type", "attention")
            continue
        if item.get("kind") not in ("flag", "clue"):
            add("invalid_kind", "attention.kind")
        if item.get("kind") == "flag" and (not item.get("flag_id") or item.get("flag_id") not in flag_ids or item.get("flag_id") not in flag_index):
            add("unknown_flag", "attention.flag_id")
        if not isinstance(item.get("text"), str):
            add("invalid_type", "attention.text")
        elif han_length(item.get("text")) > 30:
            add("too_long", "attention.text")

    verified = check_list("verified", 3)
    for item in verified:
        if not isinstance(item, dict):
            add("invalid_type", "verified")
            continue
        if not isinstance(item.get("text"), str):
            add("invalid_type", "verified.text")
        elif han_length(item.get("text")) > 30:
            add("too_long", "verified.text")

    missing = check_list("missing", 2)
    for item in missing:
        if not isinstance(item, dict):
            add("invalid_type", "missing")
            continue
        if not isinstance(item.get("text"), str):
            add("invalid_type", "missing.text")
        elif han_length(item.get("text")) > 30:
            add("too_long", "missing.text")
        action = item.get("action")
        if action is not None:
            if not isinstance(action, dict):
                add("invalid_type", "missing.action")
            else:
                for key in ("label", "link_text", "url", "instruction"):
                    if key not in action:
                        add("missing_action_field", f"missing.action.{key}")
                if "url" in action and action.get("url") is not None and not re.match(r"^https?://", text(action.get("url"))):
                    add("invalid_url", "missing.action.url")

    scripts = check_list("scripts", 3)
    for item in scripts:
        if not isinstance(item, dict):
            add("invalid_type", "scripts")
            continue
        if not isinstance(item.get("en"), str) or not isinstance(item.get("zh"), str):
            add("invalid_type", "scripts")
        else:
            for phrase in SCRIPT_FORBIDDEN:
                if phrase in item.get("en", "") or phrase in item.get("zh", ""):
                    add("forbidden_word", "scripts")

    questions = display.get("open_questions")
    if questions is not None:
        if not isinstance(questions, list):
            add("invalid_type", "open_questions")
        else:
            if len(questions) > 3:
                add("too_many", "open_questions")
            for item in questions:
                if not isinstance(item, str):
                    add("invalid_type", "open_questions")
                elif han_length(item) > 12:
                    add("too_long", "open_questions")

    flip_hint = display.get("flip_hint")
    if flip_hint is not None:
        if not isinstance(flip_hint, str):
            add("invalid_type", "flip_hint")
        elif char_length(flip_hint) > 40:
            add("too_long", "flip_hint")

    texts = []

    def push_text(field, value):
        if isinstance(value, str):
            texts.append((field, value))

    push_text("customer_label", display.get("customer_label"))
    push_text("inquiry_type", display.get("inquiry_type"))
    push_text("supplement", display.get("supplement"))
    if isinstance(dim_notes, dict):
        for key, value in dim_notes.items():
            push_text(f"dim_notes.{key}", value)
    for item in attention:
        if isinstance(item, dict):
            push_text("attention.text", item.get("text"))
    for item in verified:
        if isinstance(item, dict):
            push_text("verified.text", item.get("text"))
    for item in missing:
        if not isinstance(item, dict):
            continue
        push_text("missing.text", item.get("text"))
        action = item.get("action")
        if isinstance(action, dict):
            push_text("missing.action.label", action.get("label"))
            push_text("missing.action.link_text", action.get("link_text"))
            push_text("missing.action.instruction", action.get("instruction"))
    for item in scripts:
        if not isinstance(item, dict):
            continue
        push_text("scripts.en", item.get("en"))
        push_text("scripts.zh", item.get("zh"))
    for item in questions if isinstance(questions, list) else []:
        push_text("open_questions", item)

    for field, value in texts:
        if is_technical(value):
            add("technical_term", field)
        if any(phrase in value for phrase in FORBIDDEN):
            add("forbidden_word", field)
        if EMAIL_RE.search(value):
            add("pii_email", field)
        if contains_full_phone(value):
            add("pii_phone", field)

    seen = set()
    unique = []
    for error in errors:
        key = (error["code"], error["field"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(error)
    return unique


def default_dim_note(key, status):
    table = {
        "company": {"已核实": "官网和公开资料一致", "基本核实": "公开资料基本一致", "部分核实": "只核实了部分公开资料", "未核实": "暂未核实", "有矛盾": "公开资料和自称不一致"},
        "link": {"已核实": "任职信息和询盘吻合", "基本核实": "能找到任职线索", "部分核实": "关联线索较少", "未核实": "暂未核实", "有矛盾": "职业资料和自称不符"},
        "contact": {"已核实": "电话和邮箱都能对上", "基本核实": "部分联系方式能对上", "部分核实": "只核实了部分联系方式", "未核实": "暂未核实", "有矛盾": "联系方式对不上"},
        "compliance": {"已核实": "制裁名单和公开检索都已核对", "基本核实": "部分合规信息已核对", "部分核实": "只核对了部分合规信息", "未核实": "暂未核实", "有矛盾": "发现合规问题"},
        "scale": {"已核实": "规模和自称一致", "基本核实": "规模和自称基本一致", "部分核实": "规模线索较少", "未核实": "地图和海关都没查到", "有矛盾": "规模和自称不一致"},
    }
    return table.get(key, {}).get(status, "暂未核实")


def check_label(check_id):
    table = {
        "company": "公司信息已核实",
        "domain": "域名信息已核实",
        "email": "邮箱信息已核实",
        "phone": "电话信息已核实",
        "negative": "公开检索没发现投诉",
        "sanctions": "制裁名单没有匹配",
        "map": "地图信息已核实",
        "customs": "海关记录已核实",
    }
    return table.get(check_id, "公开信息已核实")


def anchor_count(evidence):
    anchors = evidence.get("anchors") or {}
    if isinstance(anchors, dict) and isinstance(anchors.get("count"), int):
        return anchors["count"]
    closure = anchors if isinstance(anchors, str) else anchors.get("closure")
    return {"none": 0, "single": 1, "bidirectional": 2, "independent": 3}.get(closure, 0)


def inquiry_label(evidence, display):
    if display and text(display.get("inquiry_type")):
        return text(display.get("inquiry_type"))
    inquiry_type = (evidence.get("intake") or {}).get("inquiry_type")
    if inquiry_type in INQUIRY_LABELS:
        return INQUIRY_LABELS[inquiry_type]
    return "一般询盘"


def customer_label(evidence, display):
    if display and text(display.get("customer_label")):
        return text(display.get("customer_label"))
    company = (evidence.get("subject") or {}).get("company") or (evidence.get("intake") or {}).get("company")
    return text(company) or "该客户"


def inquiry_text(evidence):
    intake = evidence.get("intake") or {}
    subject = evidence.get("subject") or {}
    return text(intake.get("inquiry_text") or evidence.get("inquiry_text") or subject.get("inquiry_text"))


def validate_checks_incomplete(evidence):
    raw = evidence.get("checks_incomplete")
    if raw is None:
        return [], []
    if not isinstance(raw, list):
        return [], [{"code": "invalid-input", "field": "checks_incomplete"}]
    items = []
    errors = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            errors.append({"code": "invalid-input", "field": f"checks_incomplete[{index}]"})
            continue
        check = item.get("check")
        reason = item.get("reason")
        if check not in CHECK_LABELS:
            errors.append({"code": "invalid-input", "field": f"checks_incomplete[{index}].check"})
        if reason not in REASON_LABELS:
            errors.append({"code": "invalid-input", "field": f"checks_incomplete[{index}].reason"})
        next_step = item.get("next_step")
        if next_step is None:
            next_step = DEFAULT_NEXT_STEPS.get(check, "人工补查一次")
        if not isinstance(next_step, str) or len(next_step) > 40:
            errors.append({"code": "invalid-input", "field": f"checks_incomplete[{index}].next_step"})
        items.append({"check": check, "reason": reason, "next_step": next_step})
    return items, errors


SOURCE_GRADE_DEFAULT = {
    "registry": "official",
    "sanctions_list": "official",
    "search": "third_party",
    "map": "third_party",
    "website": "self_declared",
    "user_input": "self_declared",
    "other": "self_declared",
}
GRADE_LABEL = {"official": "官方", "third_party": "第三方", "self_declared": "自述"}
GRADE_RANK = {"self_declared": 0, "third_party": 1, "official": 2}
MULTI_SUFFIX = {"co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.jp", "com.br", "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "com.hk", "com.sg", "com.tw", "co.in", "co.nz"}


def url_host(url):
    try:
        return urlparse(url).netloc.lower().removeprefix("www.")
    except ValueError:
        return ""


def registrable_domain(host):
    parts = host.split(".") if host else []
    if len(parts) <= 2:
        return host
    if ".".join(parts[-2:]) in MULTI_SUFFIX:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def grade_of(entry):
    explicit = entry.get("source_grade")
    if explicit in GRADE_LABEL:
        return explicit
    return SOURCE_GRADE_DEFAULT.get(entry.get("source_type"), "self_declared")


def apply_evidence_rules(evidence, attention, verified, missing, attention_from_display, verified_from_display):
    if "evidence" not in evidence:
        return attention, verified, missing, 0, 0, 0
    raw = evidence.get("evidence")
    index = {}
    duplicates = set()
    grade_warnings = 0
    source_to_check = {"sanctions_list": "sanctions", "registry": "registry", "search": "search", "map": "map"}
    blocked_check_names = {
        item.get("check")
        for item in (evidence.get("checks_incomplete") or [])
        if isinstance(item, dict)
    }
    for entry in raw if isinstance(raw, list) else []:
        if isinstance(entry, dict) and text(entry.get("id")):
            evidence_id = text(entry.get("id"))
            if evidence_id in index:
                duplicates.add(evidence_id)
            index[evidence_id] = entry

    def evaluate(item, target):
        nonlocal grade_warnings
        ids = item.get("evidence_ids")
        if not isinstance(ids, list) or not ids:
            return False, "缺证据", None
        entries = []
        all_user = True
        for evidence_id in ids:
            if not isinstance(evidence_id, str) or not evidence_id or evidence_id in duplicates or evidence_id not in index:
                return False, "缺证据", None
            entry = index[evidence_id]
            if entry.get("source_type") != "user_input":
                all_user = False
                if not text(entry.get("url")) or not text(entry.get("retrieved_at")):
                    return False, "缺证据", None
            if source_to_check.get(entry.get("source_type")) in blocked_check_names:
                return False, "本次未完成，不能作为已核实", None
            entries.append(entry)
        if target == "verified" and all_user:
            return False, "客户自述，未证实", None
        grades = [grade_of(entry) for entry in entries]
        for entry in entries:
            default_grade = SOURCE_GRADE_DEFAULT.get(entry.get("source_type"), "self_declared")
            explicit = entry.get("source_grade")
            if explicit in GRADE_LABEL and GRADE_RANK.get(explicit, 0) > GRADE_RANK.get(default_grade, 0):
                grade_warnings += 1
        if target == "verified":
            has_official = "official" in grades
            third_domains = {
                registrable_domain(url_host(entry.get("url")))
                for entry, grade in zip(entries, grades)
                if grade == "third_party" and entry.get("url")
            }
            if not has_official and len(third_domains) < 2:
                return False, "客户自述，未证实", None
        top = max(grades, key=lambda item: GRADE_RANK.get(item, 0)) if grades else "self_declared"
        return True, "", GRADE_LABEL[top]

    count = 0
    if attention:
        kept = []
        dropped = []
        for item in attention:
            ok, label, grade_label = evaluate(item, "attention")
            if ok:
                if grade_label:
                    item["grade_label"] = grade_label
                kept.append(item)
            else:
                body = text(item.get("text")) or text(item.get("flag_id"))
                dropped.append({"text": f"（{label}）{body}"})
        attention = kept
        missing.extend(dropped)
        count += len(dropped)
    if verified_from_display:
        kept = []
        dropped = []
        for item in verified:
            if not isinstance(item, dict):
                kept.append(item)
                continue
            ok, label, grade_label = evaluate(item, "verified")
            if ok:
                if grade_label:
                    item["grade_label"] = grade_label
                kept.append(item)
            else:
                dropped.append({"text": f"（{label}）{text(item.get('text'))}"})
        verified = kept
        missing.extend(dropped)
        count += len(dropped)
    overflow = max(0, len(missing) - 2)
    return attention, verified, missing, count, overflow, grade_warnings


def validate_conflicts(evidence):
    raw = evidence.get("conflicts")
    if raw is None:
        return [], []
    if not isinstance(raw, list):
        return [], [{"code": "invalid-input", "field": "conflicts"}]
    evidence_ids = {
        text(entry.get("id"))
        for entry in (evidence.get("evidence") or [])
        if isinstance(entry, dict) and text(entry.get("id"))
    }
    items = []
    errors = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            errors.append({"code": "invalid-input", "field": f"conflicts[{index}]"})
            continue
        claims = []
        for side in ("a", "b"):
            value = item.get(side)
            if not isinstance(value, dict):
                errors.append({"code": "invalid-input", "field": f"conflicts[{index}].{side}"})
                continue
            claim = text(value.get("claim"))
            if not claim or len(claim) > 30:
                errors.append({"code": "invalid-input", "field": f"conflicts[{index}].{side}.claim"})
            if text(value.get("evidence_id")) not in evidence_ids:
                errors.append({"code": "invalid-input", "field": f"conflicts[{index}].{side}.evidence_id"})
            claims.append(claim)
        if len(claims) == 2:
            items.append({"kind": "conflict", "text": f"来源冲突：{claims[0]}，{claims[1]}"})
    return items, errors


def render_card(evidence, rules):
    display = evidence.get("display") or {}
    errors = validate_display(evidence, rules)
    if errors:
        return {"status": "invalid-display", "errors": errors}
    incomplete, incomplete_errors = validate_checks_incomplete(evidence)
    if incomplete_errors:
        return {"status": "invalid-input", "errors": incomplete_errors}
    if evidence.get("evidence") is not None and not isinstance(evidence.get("evidence"), list):
        return {"status": "invalid-input", "errors": [{"code": "invalid-input", "field": "evidence"}]}
    conflicts, conflict_errors = validate_conflicts(evidence)
    if conflict_errors:
        return {"status": "invalid-input", "errors": conflict_errors}

    ids = flag_ids_of(evidence)
    flag_index = {flag.get("id"): flag for flag in (rules.get("flags") or [])}
    flag_weight = lambda flag_id: (flag_index.get(flag_id) or {}).get("weight", 0)

    coverage = evidence.get("coverage") or {}
    covered = coverage.get("checked")
    total = 8 if coverage.get("total") is None else coverage.get("total")
    incomplete_coverage = sum(1 for item in incomplete if item.get("check") in INCOMPLETE_COVERAGE)
    effective_covered = None if covered is None else max(0, covered - incomplete_coverage)
    anchors = anchor_count(evidence)

    layers = evidence.get("layers") or {}
    company_cred = layer_value(layers, "company", "credibility")
    link_strength = layer_value(layers, "person_company_link", "strength")
    person_level = layer_value(layers, "person_authenticity", "level")

    recomputed = risk_score(ids, rules, evidence.get("unverifiable") is True, covered, None if covered is None else anchors, company_cred, link_strength, person_level)
    stored = evidence.get("score") or {}
    if stored.get("risk_score") is not None:
        mismatch = int(stored.get("risk_score")) != recomputed["risk_score"] or (stored.get("level") is not None and stored.get("level") != recomputed["level"])
        if mismatch:
            return {
                "status": "score-mismatch",
                "expected": {"risk_score": stored.get("risk_score"), "level": stored.get("level")},
                "actual": {"risk_score": recomputed["risk_score"], "level": recomputed["level"]},
            }

    credit = compute_credit(evidence)
    level = recomputed["level"]
    score = recomputed["risk_score"]
    confidence = recomputed.get("confidence") or evidence.get("confidence") or "低"

    behavior_flags = any(re.match(r"^RF-(PAY|ACC|BEH)-", flag_id) for flag_id in ids)
    behavior_status = "有异常" if behavior_flags else ("无异常" if inquiry_text(evidence) else "未核实")
    behavior_symbol = "⚠️" if behavior_flags else ("✅" if behavior_status == "无异常" else "❓")

    actions = compute_actions(
        level,
        credit["tier"],
        company_cred == "low",
        any(re.match(r"^RF-(PAY|ACC)-", flag_id) for flag_id in ids),
        evidence.get("stage") or "inquiry",
        bool(evidence.get("account_verified")),
        credit["compliance_halves"] >= 2,
        display.get("open_questions") or [],
    )

    uncovered = coverage.get("uncovered") if isinstance(coverage.get("uncovered"), list) else []
    uncovered_text = "、".join(uncovered_sentence(entry) for entry in uncovered) if uncovered else "无"
    first_uncovered = CHECKPOINT_NAMES.get(parse_uncovered(uncovered[0])["checkpoint"], "公司注册记录") if uncovered else "公司注册记录"
    conclusion = compute_conclusion(level, actions, first_uncovered)

    dim_notes = display.get("dim_notes") or {}
    new_mode = any(key in evidence for key in ("evidence", "checks_incomplete", "conflicts"))
    dims = []
    for dim in credit["dims"]:
        item = dict(dim)
        note = text(dim_notes.get(dim["key"]))
        if new_mode and dim["status"] == "未核实" and (not note or note == "暂未核实"):
            note = NEXT_STEPS_DIM.get(dim["key"], "人工补查一次")
        item["note"] = note or default_dim_note(dim["key"], dim["status"])
        dims.append(item)
    behavior_note = "发现异常交易要求" if behavior_status == "有异常" else "没发现异常交易要求" if behavior_status == "无异常" else "没有询盘原文"
    behavior_display = text(dim_notes.get("behavior"))
    if new_mode and behavior_status == "未核实" and (not behavior_display or behavior_display == "暂未核实"):
        behavior_display = NEXT_STEPS_DIM["behavior"]
    dims.insert(3, {"key": "behavior", "label": "交易行为", "status": behavior_status, "symbol": behavior_symbol, "bar": "—", "note": behavior_display or behavior_note})

    flag_attention = [
        {"id": flag_id, "name": flag_index[flag_id].get("name"), "weight": flag_index[flag_id].get("weight", 0)}
        for flag_id in ids
        if flag_id in flag_index
    ]
    flag_attention.sort(key=lambda item: (-item["weight"], item["id"]))

    raw_attention = display.get("attention")
    if isinstance(raw_attention, list) and raw_attention:
        attention = [dict(item) for item in raw_attention]
    elif "evidence" in evidence:
        flag_entries = {
            text(item.get("id")): item
            for item in (evidence.get("flags") or [])
            if isinstance(item, dict) and text(item.get("id"))
        }
        attention = []
        for flag in flag_attention:
            item = {"kind": "flag", "flag_id": flag["id"], "text": ""}
            evidence_ids = flag_entries.get(flag["id"], {}).get("evidence_ids")
            if isinstance(evidence_ids, list) and evidence_ids:
                item["evidence_ids"] = evidence_ids
            attention.append(item)
    else:
        attention = [{"kind": "flag", "flag_id": flag["id"], "text": ""} for flag in flag_attention]
    indexed = list(enumerate(attention))
    indexed.sort(key=lambda pair: (-(flag_weight(pair[1].get("flag_id")) if pair[1].get("kind") == "flag" else -1), pair[0]))
    attention = [item for _, item in indexed]

    raw_verified = display.get("verified")
    blocked_checks = {item.get("check") for item in incomplete}

    def check_is_blocked(check_id):
        if check_id in blocked_checks:
            return True
        if check_id in ("registry", "customs") and "registry" in blocked_checks:
            return True
        if check_id == "negative" and "search" in blocked_checks:
            return True
        return False

    if isinstance(raw_verified, list) and raw_verified:
        verified = [dict(item) for item in raw_verified if isinstance(item, dict)]
    elif "evidence" in evidence:
        verified = []
    else:
        verified = [
            check_label(check.get("id") or check.get("dimension"))
            for check in (evidence.get("checks") or [])
            if isinstance(check, dict) and check.get("result") == "normal" and not check_is_blocked(check.get("id") or check.get("dimension"))
        ][:3]
        if not verified:
            verified = ["暂无可列出的已核实项"]

    raw_missing = display.get("missing")
    if isinstance(raw_missing, list) and raw_missing:
        missing = [dict(item) for item in raw_missing]
    else:
        missing = []
        for entry in uncovered[:2]:
            parsed = parse_uncovered(entry)
            missing.append({"text": f"{CHECKPOINT_NAMES.get(parsed['checkpoint'], parsed['checkpoint'])}：{reason_text(parsed['checkpoint'], parsed['reason'])}"})
        if not missing:
            missing = [{"text": "暂无可补充的公开信息"}]

    attention, verified, missing, evidence_missing, missing_overflow, source_grade_warnings = apply_evidence_rules(
        evidence,
        attention,
        verified,
        missing,
        bool(isinstance(raw_attention, list) and raw_attention),
        bool(isinstance(raw_verified, list) and raw_verified),
    )
    if conflicts:
        attention = attention[: max(0, 3 - min(3, len(conflicts)))] + conflicts[:3]

    action_indexed = list(enumerate(item for item in missing if item.get("action")))
    action_indexed.sort(key=lambda pair: (-(pair[1].get("gain") or 0), pair[0]))
    action_rows = [item["action"] for _, item in action_indexed][:4]

    scripts = display.get("scripts")[:3] if isinstance(display.get("scripts"), list) else []

    color = {"低": "🟢", "中": "🟡", "高": "🔴", "需人工核实": "⚪"}.get(level, "⚪")
    level_label = "需人工核实" if level == "需人工核实" else f"{level}风险"
    filled = 0 if level == "需人工核实" else round_half(score / 10)
    bar = "■" * filled + "□" * (10 - filled)

    lines = []
    benign_id = None
    if new_mode:
        flag_items = [item for item in attention if item.get("kind") == "flag" and item.get("flag_id") in flag_index]
        if flag_items:
            benign_id = max(flag_items, key=lambda item: flag_index[item["flag_id"]].get("weight", 0)).get("flag_id")
    incomplete_suffix = f" · 有 {len(incomplete)} 项未完成" if incomplete else ""
    if level == "需人工核实" and new_mode:
        lines.append(f"## ⚪ 需人工核实 · 风险 待核实 ｜ 核实度 {credit['score']}/100（{credit['tier']}）{incomplete_suffix}")
    else:
        lines.append(f"## {color} {level_label} · 风险 {score}/100 {bar} ｜ 核实度 {credit['score']}/100（{credit['tier']}）{incomplete_suffix}")
    lines.append(f"置信度：{confidence}（锚点 {anchors}/3）｜覆盖：{0 if effective_covered is None else effective_covered}/{total}｜未覆盖：{uncovered_text}")
    if incomplete:
        details = "；".join(
            f"{CHECK_LABELS.get(item['check'], item['check'])}未完成（{REASON_LABELS.get(item['reason'], item['reason'])}）→ {item['next_step']}"
            for item in incomplete
        )
        lines.append(f"⚠ 本次未完成：{details}")
    lines.append(f"**结论：{conclusion}** 客户：{customer_label(evidence, display)} · {inquiry_label(evidence, display)}")
    lines.append("")
    lines.append("| 动作 | 建议 | 条件 |")
    lines.append("| --- | --- | --- |")
    for action in actions:
        condition = f" {action['condition']}" if action["condition"] else ""
        lines.append(f"| {action['label']} | {action['status']} {action['status_text']} |{condition} |")
    first_screen_lines = len(lines)
    lines.append("")
    lines.append("| 维度 | 状态 | 依据 |")
    lines.append("| --- | --- | --- |")
    for dim in dims:
        lines.append(f"| {dim['label']} | {dim['symbol']} {dim['bar']} {dim['status']} | {dim['note']} |")
    lines.append("")
    data_dates = collect_data_dates(evidence)
    if data_dates:
        lines.append("数据日期：" + " · ".join(f"{label} {date}" for label, date in data_dates))
    flip_hint = text(display.get("flip_hint"))
    if new_mode and flip_hint:
        lines.append(f"什么会改变结论：{flip_hint}")
    lines.append("**需要注意**")
    if not attention:
        lines.append("- 未发现需要注意的信号")
    else:
        for item in attention:
            grade_label = f" [{item.get('grade_label')}]" if item.get("grade_label") else ""
            if item.get("kind") == "flag":
                info = flag_index.get(item.get("flag_id")) or {"name": item.get("flag_id"), "weight": 0}
                symbol = "🔴" if info.get("weight", 0) >= 4 else "🟡"
                body = text(item.get("text"))
                benign = ""
                if item.get("flag_id") == benign_id and info.get("benign"):
                    benign = f" · 可能无害：{info.get('benign')}"
                lines.append(f"- {symbol} {info.get('name')}（{item.get('flag_id')}）{('：' + body) if body else ''}{grade_label}{benign}")
            elif item.get("kind") == "conflict":
                lines.append(f"- ⚠ {text(item.get('text'))}")
            else:
                lines.append(f"- 🟡 {text(item.get('text'))}{grade_label}")
    lines.append("")
    lines.append("**已核实**")
    for item in verified[:3]:
        if isinstance(item, dict):
            grade_label = f" [{item.get('grade_label')}]" if item.get("grade_label") else ""
            lines.append(f"- 🟢 {text(item.get('text'))}{grade_label}")
        else:
            lines.append(f"- 🟢 {item}")
    lines.append("")
    lines.append("**没查到（没查到不代表没问题）**")
    for item in missing[:2]:
        lines.append(f"- ⚪ {text(item.get('text'))}")
    if missing_overflow:
        lines.append(f"- ⚪ 另有 {missing_overflow} 项未列出")
    lines.append("")
    if action_rows:
        lines.append("**一次动作**")
        for action in action_rows:
            label = text(action.get("label"))
            instruction = text(action.get("instruction"))
            if action.get("url"):
                link_text = text(action.get("link_text")) or label
                lines.append(f"▸ {label} — [{link_text}]({action.get('url')})：{instruction}")
            else:
                lines.append(f"▸ {label} — {instruction}")
        lines.append("")
    if scripts:
        lines.append("**建议这样回复（任选）**")
        for index, script in enumerate(scripts):
            lines.append(f"{index + 1}. {text(script.get('en'))}")
            lines.append(f"   {text(script.get('zh'))}")
        lines.append("")
    supplement = text(display.get("supplement"))
    if not supplement:
        supplement = f"补充{text(action_rows[0].get('label'))}结果后，核实度会更高。" if action_rows else "信息越多，判断越准。"
    punctuation = "" if re.search(r"[。！？]$", supplement) else "。"
    lines.append(f"{supplement}{punctuation}需要完整报告请回复“出完整报告”。")
    if new_mode:
        lines.append("仅基于公开信息的风险信号筛查，不构成对客户的定性。")
    else:
        lines.append("仅为基于公开信息的风险提示，不构成法律意见。")

    return {
        "status": "ok",
        "credit": {"score": credit["score"], "tier": credit["tier"]},
        "level": level,
        "risk_score": score,
        "confidence": confidence,
        "dimensions": dims,
        "actions": actions,
        "conclusion": conclusion,
        "evidence_missing": evidence_missing,
        "source_grade_warnings": source_grade_warnings,
        "line_count": len(lines),
        "first_screen_lines": first_screen_lines,
        "card": "\n".join(lines),
    }


def ladder_combinations():
    levels = ["低", "中", "高", "需人工核实"]
    tiers = ["高", "中", "低"]
    combos = []
    for level in levels:
        for tier in tiers:
            for company_low in (False, True):
                for pay_flag in (False, True):
                    for stage in ("inquiry", "pre-order"):
                        for account_verified in (False, True):
                            for compliance_checked in (False, True):
                                for questions in ([], ["确认品牌", "确认地点"]):
                                    actions = compute_actions(level, tier, company_low, pay_flag, stage, account_verified, compliance_checked, questions)
                                    combos.append({
                                        "input": {
                                            "level": level,
                                            "credit_tier": tier,
                                            "company_low": company_low,
                                            "pay_flag": pay_flag,
                                            "stage": stage,
                                            "account_verified": account_verified,
                                            "compliance_checked": compliance_checked,
                                            "open_questions": questions,
                                        },
                                        "actions": actions,
                                        "conclusion": compute_conclusion(level, actions, "公司注册记录"),
                                    })
    return combos


def build_parser():
    parser = argparse.ArgumentParser(description="Render a deterministic buyer-check conclusion card.")
    parser.add_argument("source", nargs="?", help="evidence pack JSON path, or - for stdin")
    parser.add_argument("--json", action="store_true", help="print computed fields and card as JSON")
    parser.add_argument("--ladder", action="store_true", help="print the full 768-combination action ladder")
    parser.add_argument("--rules", default=RULES_FILE, help="path to red_flags.json")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        rules = load_rules(args.rules)
    except OSError as exc:
        print(json.dumps({"status": "invalid-input", "error": str(exc)}, ensure_ascii=False))
        return 1

    if args.ladder:
        print(json.dumps({"status": "ok", "combos": ladder_combinations()}, ensure_ascii=False))
        return 0
    if not args.source:
        print(json.dumps({"status": "invalid-input", "error": "missing evidence pack path"}, ensure_ascii=False))
        return 1

    try:
        if args.source == "-":
            evidence = json.load(sys.stdin)
        else:
            with open(args.source, "r", encoding="utf-8") as handle:
                evidence = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "invalid-input", "error": str(exc)}, ensure_ascii=False))
        return 1

    if not isinstance(evidence, dict):
        print(json.dumps({"status": "invalid-input", "error": "evidence pack must be an object"}, ensure_ascii=False))
        return 1

    result = render_card(evidence, rules)
    if args.json or result["status"] != "ok":
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(result["card"])
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
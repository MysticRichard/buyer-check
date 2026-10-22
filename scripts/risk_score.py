#!/usr/bin/env python3
"""Deterministic risk scoring for buyer-check (RF-* red flags).

Sums the weights of the matched red flags defined in ``red_flags.json`` and
maps the total to a risk level plus a 0-100 risk score, information coverage
ratio and confidence grade, so that the same input always yields the same
output (reproducible scoring, acceptance cases A6/A8).

Also exposes a helper that redacts bank account / credential numbers used in
reports (acceptance case A7).

Usage:
    python risk_score.py --flags RF-PAY-001 RF-DOM-002
    python risk_score.py --flags RF-PAY-001 --unverifiable
    python risk_score.py --flags RF-BEH-003 --anchors 0 --covered 3
    python risk_score.py --mask "4111 1111 1111 1234"

Output is JSON on stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Optional

RULES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "red_flags.json")

CHECKPOINT_COUNT = 8
RISK_SCORE_FACTOR = 7
RISK_SCORE_MAX = 100


def load_rules(path: str = RULES_FILE) -> dict:
    """Load the machine readable red flag table."""
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def mask_sensitive(text: str) -> str:
    """Redact a long digit sequence, keeping only the last 4 digits."""
    digits = re.findall(r"\d", text or "")
    if not digits:
        return text
    if len(digits) <= 4:
        return "*" * len(digits)
    return "*" * (len(digits) - 4) + "".join(digits[-4:])


def coverage_grade(covered: int, anchors: int) -> tuple:
    """Return (coverage ratio, confidence) from evaluated checkpoints and anchors."""
    ratio = round(covered / CHECKPOINT_COUNT, 2)
    if anchors < 1 or ratio < 0.5:
        confidence = "低"
    elif ratio >= 0.75:
        confidence = "高"
    else:
        confidence = "中"
    return ratio, confidence


def score(
    flag_ids,
    rules: dict,
    unverifiable: bool = False,
    covered: Optional[int] = None,
    anchors: Optional[int] = None,
) -> dict:
    """Compute risk level, 0-100 risk score, coverage and confidence."""
    index = {flag["id"]: flag for flag in rules["flags"]}
    matched, unknown, total = [], [], 0

    for flag_id in flag_ids or []:
        item = index.get(flag_id)
        if item is None:
            unknown.append(flag_id)
            continue
        matched.append({"id": flag_id, "name": item["name"], "weight": item["weight"]})
        total += item["weight"]

    has_high_weight = any(item["weight"] == 5 for item in matched)
    risk_score_value = min(RISK_SCORE_MAX, total * RISK_SCORE_FACTOR)

    if covered is None or anchors is None:
        ratio, confidence = None, None
    else:
        ratio, confidence = coverage_grade(covered, anchors)

    if unverifiable or (confidence == "低" and covered is not None):
        level = "需人工核实"
    elif total >= 8 or has_high_weight:
        level = "高"
    elif total >= 4:
        level = "中"
    else:
        level = "低"

    return {
        "matched": matched,
        "unknown": unknown,
        "total": total,
        "high_weight_hit": has_high_weight,
        "risk_score": risk_score_value,
        "coverage": ratio,
        "confidence": confidence,
        "level": level,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Deterministic buyer-check risk scoring.")
    parser.add_argument("--flags", nargs="*", default=[], help="matched red flag ids, e.g. RF-PAY-001")
    parser.add_argument("--unverifiable", action="store_true", help="key information could not be retrieved")
    parser.add_argument("--covered", type=int, help="number of checkpoints that could be evaluated (0-8)")
    parser.add_argument("--anchors", type=int, help="number of identity anchors available (0-3)")
    parser.add_argument("--mask", metavar="TEXT", help="redact sensitive digits in TEXT")
    parser.add_argument("--rules", default=RULES_FILE, help="path to red_flags.json")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.mask is not None:
        print(json.dumps({"masked": mask_sensitive(args.mask)}, ensure_ascii=False))
        return 0

    try:
        rules = load_rules(args.rules)
    except OSError as exc:
        print(json.dumps({"status": "unavailable", "error": str(exc)}, ensure_ascii=False))
        return 1

    use_coverage = args.covered is not None and args.anchors is not None
    result = score(
        args.flags,
        rules,
        args.unverifiable,
        args.covered if use_coverage else None,
        args.anchors if use_coverage else None,
    )
    result["status"] = "ok"
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
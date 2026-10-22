#!/usr/bin/env python3
"""Detect look-alike (typo-squatting) domains for buyer-check.

Compares a target domain against a list of well known brand domains and flags
homoglyph substitutions (l/1, o/0, rn/m), single character edits, hyphenated or
prefixed/suffixed variants and TLD swaps. Results feed RF-DOM-001.

Usage:
    python domain_similarity.py app1e.com
    python domain_similarity.py arnazon.com --brands ./brands.json --threshold 0.6

Output is JSON on stdout, listing the best matches sorted by score.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

DEFAULT_BRANDS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "brands.json")

HOMOGLYPHS = str.maketrans({"l": "1", "i": "1", "o": "0", "s": "5", "e": "3"})


def normalize(domain: str) -> str:
    """Lowercase and strip scheme, path and a leading www."""
    value = (domain or "").strip().lower()
    value = value.replace("http://", "").replace("https://", "")
    value = value.split("/")[0].split("?")[0]
    if value.startswith("www."):
        value = value[4:]
    return value


def core_label(domain: str) -> tuple:
    """Return (label, tld) for a domain, keeping multi-part TLDs together."""
    parts = normalize(domain).split(".")
    if len(parts) < 2:
        return normalize(domain), ""
    return parts[0], ".".join(parts[1:])


def homoglyph_key(text: str) -> str:
    """Collapse visually similar characters to a single form."""
    value = text.replace("rn", "m").replace("vv", "w")
    return value.translate(HOMOGLYPHS)


def levenshtein(a: str, b: str) -> int:
    """Compute the Levenshtein edit distance between two strings."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    previous = list(range(len(b) + 1))
    for i, char_a in enumerate(a, 1):
        current = [i]
        for j, char_b in enumerate(b, 1):
            cost = 0 if char_a == char_b else 1
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost))
        previous = current
    return previous[-1]


def compare(target: str, brand_domain: str) -> tuple:
    """Return (type, score) describing how target relates to a brand domain."""
    target_label, target_tld = core_label(target)
    brand_label, brand_tld = core_label(brand_domain)

    if target_label == brand_label and target_tld == brand_tld:
        return "exact", 0.0
    if target_label == brand_label:
        return "tld_swap", 0.70
    if homoglyph_key(target_label) == homoglyph_key(brand_label):
        return "homoglyph", 0.90
    if target_label.startswith(brand_label) or target_label.endswith(brand_label):
        separator = "-" if "-" in target_label else ""
        return ("hyphenated" if separator else "affixed"), 0.80
    distance = levenshtein(target_label, brand_label)
    if distance == 1:
        return "typosquat", 0.85
    if distance == 2 and len(brand_label) >= 6:
        return "typosquat", 0.60
    return "none", 0.0


def load_brands(path: str) -> list:
    """Load the brand list from JSON."""
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle).get("brands", [])


def analyse(target: str, brands: list, threshold: float) -> dict:
    """Compare a target domain against all known brands."""
    matches = []
    for brand in brands:
        kind, score = compare(target, brand["domain"])
        if kind == "exact":
            return {
                "target": normalize(target),
                "is_lookalike": False,
                "matches": [{"brand": brand["name"], "official_domain": brand["domain"], "type": "exact", "score": 1.0}],
                "verdict": "与已知品牌域名完全一致，非仿冒",
            }
        if score >= threshold:
            matches.append(
                {"brand": brand["name"], "official_domain": brand["domain"], "type": kind, "score": score}
            )

    matches.sort(key=lambda item: (-item["score"], item["official_domain"]))
    best = matches[0] if matches else None
    return {
        "target": normalize(target),
        "is_lookalike": bool(matches),
        "matches": matches,
        "best_match": best,
        "verdict": (
            f"疑似仿冒 {best['brand']}（{best['official_domain']}），类型 {best['type']}"
            if best
            else "未匹配到已知品牌的仿冒特征"
        ),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Look-alike domain detection for buyer-check.")
    parser.add_argument("domain", help="target domain, e.g. app1e.com")
    parser.add_argument("--brands", default=DEFAULT_BRANDS, help="path to brands.json")
    parser.add_argument("--threshold", type=float, default=0.5, help="minimum score to report (0-1)")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        brands = load_brands(args.brands)
    except OSError as exc:
        print(json.dumps({"status": "unavailable", "error": str(exc)}, ensure_ascii=False))
        return 1

    result = analyse(args.domain, brands, args.threshold)
    result["status"] = "ok"
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
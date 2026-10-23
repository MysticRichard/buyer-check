#!/usr/bin/env python3
"""Phone number sanity check for buyer-check.

Parses a phone number against a local ITU E.164 calling-code table (no network,
no third-party dependency) and reports the country, whether the national length
is plausible, the line type when the prefix is known (mobile prefixes are only
reported when the table carries them; otherwise "unknown" — never guessed), and
whether the number matches the claimed country. Feeds RF-CORP-005 style checks.

Usage:
    python phone_check.py "+971 52 115 9918" --country AE
    python phone_check.py "008618812345678"

Output is JSON on stdout. Errors return status "unavailable".
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Optional

DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "phone_check_data.json")

NANP_ISO2 = ["US", "CA"]


def load_data(path: str = DATA_FILE) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def normalize(raw: str) -> tuple:
    """Return (digits, used_00_prefix, had_plus)."""
    text = (raw or "").strip()
    had_plus = text.startswith("+")
    had_00 = text.startswith("00")
    digits = re.sub(r"[^\d]", "", text)
    if had_00 and not had_plus:
        digits = digits[2:]
        used_00 = True
    else:
        used_00 = False
    return digits, used_00, had_plus


def match_country(digits: str, data: dict) -> Optional[dict]:
    """Longest-prefix match of the calling code table."""
    best = None
    for entry in data["countries"]:
        if digits.startswith(entry["code"]):
            if best is None or len(entry["code"]) > len(best["code"]):
                best = entry
    return best


def line_type(entry: Optional[dict], national: str) -> str:
    if not entry or not entry.get("mobile_prefixes"):
        return "unknown"
    for prefix in entry["mobile_prefixes"]:
        if national.startswith(prefix):
            return "mobile"
    return "fixed_or_unknown"


def analyse(raw: str, claimed: Optional[str], data: dict) -> dict:
    digits, used_00, had_plus = normalize(raw)
    result = {
        "input": raw,
        "normalized": None,
        "valid": False,
        "invalid_reason": None,
        "country_code": None,
        "country": None,
        "country_name": None,
        "line_type": "unknown",
        "claimed_country": (claimed or "").upper() or None,
        "matches_claimed_country": None,
        "format_hint": None,
    }

    if not digits:
        result["invalid_reason"] = "no digits found"
        return result

    entry = match_country(digits, data)
    if entry is None:
        result["invalid_reason"] = "calling code not found in local table"
        return result

    national = digits[len(entry["code"]):]
    result["country_code"] = entry["code"]
    result["country"] = entry["iso2"]
    result["country_name"] = entry["name"]
    result["normalized"] = "+{}{}".format(entry["code"], national)

    if entry.get("nanp"):
        length_ok = len(national) == entry.get("national_length")
        result["country"] = "US/CA"
        result["country_name"] = "United States / Canada (NANP)"
    elif "min_length" in entry:
        length_ok = entry["min_length"] <= len(national) <= entry["max_length"]
    else:
        length_ok = None

    result["valid"] = bool(length_ok)
    if length_ok is False:
        result["invalid_reason"] = "national number length out of expected range"
    elif length_ok is None:
        result["valid"] = None
        result["invalid_reason"] = "length rule not covered for this country"

    result["line_type"] = line_type(entry, national)
    result["format_hint"] = "prefers E.164 (+<code><national>)"
    if used_00:
        result["format_hint"] = "converted 00 prefix to +"

    if result["claimed_country"]:
        if entry.get("nanp"):
            result["matches_claimed_country"] = result["claimed_country"] in NANP_ISO2
        else:
            result["matches_claimed_country"] = result["claimed_country"] == entry["iso2"]
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local phone sanity check for buyer-check.")
    parser.add_argument("number", help="phone number in any common format")
    parser.add_argument("--country", help="claimed country as ISO 3166-1 alpha-2, e.g. AE")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        data = load_data()
    except OSError as exc:
        print(json.dumps({"status": "unavailable", "error": str(exc)}, ensure_ascii=False))
        return 1
    result = analyse(args.number, args.country, data)
    result["status"] = "ok"
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
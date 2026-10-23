#!/usr/bin/env python3
"""Receiving account sanity check for buyer-check (pre-order stage).

Validates an IBAN structure and its mod-97 check digits using the public
ISO 13616 algorithm implemented here directly (no third-party library), parses
a BIC/SWIFT code, and compares the account country chain: IBAN country vs BIC
country vs the buyer's claimed country. Feeds RF-ACC-002 (account country
mismatch without plausible explanation — the script only reports the facts,
the model decides whether an explanation exists).

Account numbers are NEVER stored or echoed in full: output carries a masked
form only (first 4 + last 4).

Usage:
    python account_check.py --iban "GB82 WEST 1234 5698 7654 32" --bic "EBILGB2L" --country GB

Output is JSON on stdout. Errors return status "unavailable".
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Optional

# ISO 13616 IBAN lengths for countries commonly met in foreign trade.
# Countries not listed return length "unknown" (check digits are still
# verified because mod-97 does not depend on the length table).
IBAN_LENGTHS = {
    "AE": 23, "SA": 24, "QA": 29, "KW": 30, "BH": 22, "LB": 28, "JO": 30, "IL": 23, "TR": 26,
    "GB": 22, "DE": 22, "FR": 27, "NL": 18, "BE": 16, "ES": 24, "IT": 27, "PT": 25, "IE": 22,
    "CH": 21, "AT": 20, "SE": 24, "NO": 15, "DK": 18, "FI": 18, "PL": 28, "CZ": 24, "SK": 24,
    "HU": 28, "RO": 24, "BG": 22, "GR": 27, "CY": 28, "HR": 21, "SI": 19, "LT": 20, "LV": 21,
    "EE": 20, "MA": 28, "TN": 24, "DZ": 26, "PK": 24, "EG": 29, "OM": 0,
}

BIC_RE = re.compile(r"^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$")
IBAN_CC_RE = re.compile(r"^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$")


def strip_spaces(value: str) -> str:
    return re.sub(r"[\s\-]", "", (value or "").upper())


def mask(iban: Optional[str]) -> Optional[str]:
    if not iban:
        return None
    if len(iban) <= 8:
        return "*" * len(iban)
    return "{}****{}".format(iban[:4], iban[-4:])


def mod97(digits: str) -> int:
    """Compute value mod 97 over a decimal string (piecewise, no bigint needed)."""
    remainder = 0
    for char in digits:
        remainder = (remainder * 10 + int(char)) % 97
    return remainder


def char_to_digits(text: str) -> str:
    out = []
    for char in text:
        if char.isdigit():
            out.append(char)
        elif "A" <= char <= "Z":
            out.append(str(ord(char) - ord("A") + 10))
        else:
            raise ValueError("invalid character in IBAN: {}".format(char))
    return "".join(out)


def compute_check_digits(country: str, bban: str) -> str:
    """Compute the two IBAN check digits for a country + BBAN."""
    rearranged = "{}{}00".format(bban, country)
    numeric = char_to_digits(rearranged)
    check = 98 - mod97(numeric)
    return "{:02d}".format(check)


def check_iban(raw: str) -> dict:
    result = {
        "present": bool(raw),
        "masked": None,
        "country": None,
        "check_digits_ok": None,
        "structure_ok": None,
        "length_ok": None,
        "expected_length": None,
        "valid": False,
        "invalid_reason": None,
    }
    if not raw:
        return result
    iban = strip_spaces(raw)
    result["masked"] = mask(iban)

    if len(iban) < 5 or not IBAN_CC_RE.match(iban):
        result["structure_ok"] = False
        result["invalid_reason"] = "IBAN structure invalid (expect CC + 2 check digits + BBAN)"
        return result
    result["structure_ok"] = True
    result["country"] = iban[:2]
    result["expected_length"] = IBAN_LENGTHS.get(result["country"])

    if result["expected_length"] == 0:
        result["length_ok"] = None
        result["invalid_reason"] = "country uses plain account numbers, IBAN not standard"
    elif result["expected_length"] is None:
        result["length_ok"] = None
    else:
        result["length_ok"] = len(iban) == result["expected_length"]
        if not result["length_ok"]:
            result["invalid_reason"] = "length {} does not match expected {}".format(
                len(iban), result["expected_length"]
            )

    rearranged = iban[4:] + iban[:4]
    try:
        numeric = char_to_digits(rearranged)
    except ValueError as exc:
        result["check_digits_ok"] = False
        result["invalid_reason"] = str(exc)
        return result
    result["check_digits_ok"] = mod97(numeric) == 1
    if not result["check_digits_ok"] and not result["invalid_reason"]:
        result["invalid_reason"] = "mod-97 check digits failed"

    result["valid"] = bool(
        result["structure_ok"]
        and result["check_digits_ok"]
        and (result["length_ok"] is not False)
    )
    return result


def check_bic(raw: str) -> dict:
    result = {
        "present": bool(raw),
        "masked": None,
        "format_ok": None,
        "bank_code": None,
        "country": None,
        "location_code": None,
        "branch_code": None,
    }
    if not raw:
        return result
    bic = strip_spaces(raw)
    result["masked"] = bic[:4] + "****" if len(bic) > 8 else bic
    result["format_ok"] = bool(BIC_RE.match(bic))
    if result["format_ok"]:
        result["bank_code"] = bic[:4]
        result["country"] = bic[4:6]
        result["location_code"] = bic[6:8]
        result["branch_code"] = bic[8:] or None
    return result


def analyse(iban: Optional[str], bic: Optional[str], claimed: Optional[str]) -> dict:
    iban_result = check_iban(iban)
    bic_result = check_bic(bic)
    claimed = (claimed or "").upper() or None

    mismatches = []
    account_country = iban_result.get("country") or bic_result.get("country")

    if iban_result.get("country") and bic_result.get("country"):
        if iban_result["country"] != bic_result["country"]:
            mismatches.append(
                "bic_vs_iban: IBAN country {} vs BIC country {}".format(
                    iban_result["country"], bic_result["country"]
                )
            )
    if claimed and account_country and account_country != claimed:
        mismatches.append(
            "account_vs_claimed: account country {} vs buyer claimed {} (RF-ACC-002 candidate; "
            "plausible explanations such as a group treasury in a third country must be weighed "
            "by the model before scoring)".format(account_country, claimed)
        )

    return {
        "iban": iban_result,
        "bic": bic_result,
        "claimed_country": claimed,
        "account_country": account_country,
        "mismatches": mismatches,
        "account_number_stored": False,
        "note": "账号仅用于本次分析，不写入任何文件，输出已脱敏",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Receiving account sanity check for buyer-check.")
    parser.add_argument("--iban", help="IBAN (spaces allowed; never stored)")
    parser.add_argument("--bic", help="BIC/SWIFT code")
    parser.add_argument("--country", help="buyer's claimed country ISO2, e.g. AE")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if not args.iban and not args.bic:
        print(json.dumps({"status": "error", "error": "pass --iban and/or --bic"}, ensure_ascii=False))
        return 2
    result = analyse(args.iban, args.bic, args.country)
    result["status"] = "ok"
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
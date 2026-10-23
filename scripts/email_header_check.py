#!/usr/bin/env python3
"""Email header analysis for buyer-check.

Parses a pasted raw email header block and reports From / Reply-To /
Return-Path identities, the originating IP visible in the first Received hop
(null when the provider strips it — never guessed), the sending timezone, and
SPF / DKIM / DMARC results from Authentication-Results. Mismatches between the
From domain and the Reply-To / Return-Path domains feed RF-MAIL-001.

Usage:
    python email_header_check.py --file header.txt
    python email_header_check.py --stdin < header.txt

Output is JSON on stdout. Errors return status "unavailable".
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Optional

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
TZ_RE = re.compile(r"([+-]\d{4})\s*$")
AUTH_SPF_RE = re.compile(r"spf=([a-zA-Z]+)", re.IGNORECASE)
AUTH_DKIM_RE = re.compile(r"dkim=([a-zA-Z]+)", re.IGNORECASE)
AUTH_DMARC_RE = re.compile(r"dmarc=([a-zA-Z]+)", re.IGNORECASE)
PRIVATE_IP_RE = re.compile(r"^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)")


def unfold(raw: str) -> list:
    """Fold continuation lines (leading whitespace) into their header line."""
    lines = raw.replace("\r\n", "\n").split("\n")
    headers = []
    current = None
    for line in lines:
        if not line.strip():
            if current is not None:
                headers.append(current)
                current = None
            continue
        if line[:1] in (" ", "\t") and current is not None:
            current += " " + line.strip()
        elif ":" in line:
            if current is not None:
                headers.append(current)
            current = line
    if current is not None:
        headers.append(current)
    return headers


def split_header(line: str) -> tuple:
    name, _, value = line.partition(":")
    return name.strip().lower(), value.strip()


def extract_email(value: str) -> Optional[str]:
    match = EMAIL_RE.search(value or "")
    return match.group(0) if match else None


def domain_of(email: Optional[str]) -> Optional[str]:
    if not email or "@" not in email:
        return None
    return email.split("@", 1)[1].lower()


def parse_received(value: str) -> dict:
    """Extract the visible IP and timestamp offset from one Received hop."""
    ips = [ip for ip in IP_RE.findall(value or "") if not PRIVATE_IP_RE.match(ip)]
    tz = TZ_RE.search(value or "")
    return {"ip": ips[0] if ips else None, "timezone_offset": tz.group(1) if tz else None}


def analyse(raw: str) -> dict:
    headers = [split_header(line) for line in unfold(raw)]
    result = {
        "from": None,
        "from_domain": None,
        "reply_to": None,
        "reply_to_domain": None,
        "return_path": None,
        "return_path_domain": None,
        "originating_ip": None,
        "sending_timezone_offset": None,
        "auth": {"spf": None, "dkim": None, "dmarc": None},
        "received_hops": 0,
        "inconsistencies": [],
    }

    received_values = []
    for name, value in headers:
        if name == "from":
            result["from"] = extract_email(value)
            result["from_domain"] = domain_of(result["from"])
        elif name == "reply-to":
            result["reply_to"] = extract_email(value)
            result["reply_to_domain"] = domain_of(result["reply_to"])
        elif name == "return-path":
            result["return_path"] = extract_email(value)
            result["return_path_domain"] = domain_of(result["return_path"])
        elif name == "received":
            received_values.append(value)
        elif name == "authentication-results":
            spf = AUTH_SPF_RE.search(value)
            dkim = AUTH_DKIM_RE.search(value)
            dmarc = AUTH_DMARC_RE.search(value)
            result["auth"] = {
                "spf": spf.group(1).lower() if spf else None,
                "dkim": dkim.group(1).lower() if dkim else None,
                "dmarc": dmarc.group(1).lower() if dmarc else None,
            }

    result["received_hops"] = len(received_values)
    if received_values:
        # The LAST Received header (bottom) is the closest to the sender.
        bottom = parse_received(received_values[-1])
        top = parse_received(received_values[0])
        result["originating_ip"] = bottom["ip"] or top["ip"]
        result["sending_timezone_offset"] = bottom["timezone_offset"] or top["timezone_offset"]

    if result["from_domain"] and result["reply_to_domain"] and result["from_domain"] != result["reply_to_domain"]:
        result["inconsistencies"].append(
            "reply_to_domain_mismatch: from {} vs reply-to {}".format(result["from_domain"], result["reply_to_domain"])
        )
    if result["from_domain"] and result["return_path_domain"] and result["from_domain"] != result["return_path_domain"]:
        result["inconsistencies"].append(
            "return_path_domain_mismatch: from {} vs return-path {}".format(
                result["from_domain"], result["return_path_domain"]
            )
        )
    if result["auth"]["spf"] in ("fail", "softfail"):
        result["inconsistencies"].append("spf_{}".format(result["auth"]["spf"]))
    if result["auth"]["dmarc"] == "fail":
        result["inconsistencies"].append("dmarc_fail")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Raw email header analysis for buyer-check.")
    parser.add_argument("--file", help="path to a text file containing the raw header")
    parser.add_argument("--stdin", action="store_true", help="read the raw header from stdin")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.file:
        try:
            with open(args.file, "r", encoding="utf-8", errors="replace") as handle:
                raw = handle.read()
        except OSError as exc:
            print(json.dumps({"status": "unavailable", "error": str(exc)}, ensure_ascii=False))
            return 1
    elif args.stdin or not sys.stdin.isatty():
        raw = sys.stdin.read()
    else:
        print(json.dumps({"status": "error", "error": "no input: pass --file or --stdin"}, ensure_ascii=False))
        return 2
    result = analyse(raw)
    result["status"] = "ok"
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
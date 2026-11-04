#!/usr/bin/env python3
"""Sanctions list matching for buyer-check.

Matches a person or company name against official public sanctions lists
cached locally in .cache/sanctions/ (downloaded by update_sanctions.py).
Same-name hits are reported as possible matches with requires_manual_review
set to true — same-name entries must be manually excluded before any
conclusion (存疑标注「疑似命中，需人工核实」).

Usage:
    python sanctions_check.py "ACME TRADING LTD"
    python sanctions_check.py "John Doe" --country AE

Output is JSON on stdout. No cached list or any error returns
status "unavailable" (treated as 未查到 by the caller — never guessed).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import urllib.request
from typing import Optional

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".cache", "sanctions")
CACHE_MAX_AGE_DAYS = 7
OFAC_URL = "https://www.treasury.gov/ofac/downloads/sdn.csv"
OFAC_FILE = "ofac_sdn.csv"

LIST_FILES = {
    "OFAC SDN": "ofac_sdn.csv",
    "EU Consolidated": "eu_consolidated.csv",
    "UN Security Council": "un_sc.csv",
    "UK OFSI Consolidated": "uk_ofsi.csv",
}


def normalize(name: str) -> str:
    """Lowercase, strip punctuation and collapse whitespace."""
    text = (name or "").lower()
    text = re.sub(r"[^\w\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_csv_line(line: str) -> list:
    """Parse one quoted CSV line (RFC 4180 subset: quotes and doubled quotes)."""
    fields = []
    field = []
    in_quotes = False
    index = 0
    while index < len(line):
        char = line[index]
        if in_quotes:
            if char == '"':
                if index + 1 < len(line) and line[index + 1] == '"':
                    field.append('"')
                    index += 2
                    continue
                in_quotes = False
            else:
                field.append(char)
        elif char == '"':
            in_quotes = True
        elif char == ",":
            fields.append("".join(field))
            field = []
        else:
            field.append(char)
        index += 1
    fields.append("".join(field))
    return fields


def load_entries(path: str, name_column: int) -> list:
    entries = []
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.rstrip("\n").rstrip("\r")
            if not line.strip():
                continue
            fields = parse_csv_line(line)
            if len(fields) <= name_column:
                continue
            name = fields[name_column].strip()
            if name:
                entries.append({"raw": name, "normalized": normalize(name)})
    return entries


def match(query: str, entries: list) -> list:
    """Exact or containment match on normalized names."""
    target = normalize(query)
    if not target:
        return []
    hits = []
    for entry in entries:
        if entry["normalized"] == target:
            hits.append({"entry": entry["raw"], "match_type": "exact"})
        elif target in entry["normalized"] or entry["normalized"] in target:
            if len(entry["normalized"]) >= 4 and len(target) >= 4:
                hits.append({"entry": entry["raw"], "match_type": "partial"})
    return hits


def download_ofac(cache_dir: str, timeout: float = 60.0) -> dict:
    """Download the official OFAC SDN CSV. Never sends customer data."""
    path = os.path.join(cache_dir, OFAC_FILE)
    try:
        request = urllib.request.Request(OFAC_URL, headers={"User-Agent": "buyer-check/0.9"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = response.read()
        os.makedirs(cache_dir, exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(data)
        return {"status": "ok", "detail": "{} bytes".format(len(data))}
    except Exception as exc:  # noqa: BLE001 - network errors vary by environment
        return {"status": "unavailable", "detail": str(exc)}


def ensure_cache(cache_dir: str, no_update: bool = False, timeout: float = 60.0) -> Optional[str]:
    """Return None when a usable cache exists, else a failure reason."""
    ofac_path = os.path.join(cache_dir, OFAC_FILE)
    if os.path.exists(ofac_path):
        age_days = (dt.datetime.now().timestamp() - os.path.getmtime(ofac_path)) / 86400
        if age_days <= CACHE_MAX_AGE_DAYS:
            return None
    if no_update:
        return None if os.path.exists(ofac_path) else "no-network"
    try:
        result = download_ofac(cache_dir, timeout=timeout)
    except Exception:
        return "download-failed"
    if result.get("status") == "ok" and os.path.exists(ofac_path):
        return None
    return "download-failed"


def analyse(query: str, cache_dir: str = CACHE_DIR, no_update: bool = False) -> dict:
    result = {
        "query": query,
        "lists_checked": [],
        "possible_matches": [],
        "match_count": 0,
        "requires_manual_review": True,
        "note": "同名需人工排除；存疑应标注「疑似命中，需人工核实」",
    }
    cache_error = ensure_cache(cache_dir, no_update=no_update)
    if cache_error:
        return {**result, "status": "unavailable", "error": cache_error}
    any_list = False
    for list_name, filename in LIST_FILES.items():
        path = os.path.join(cache_dir, filename)
        if not os.path.exists(path):
            continue
        any_list = True
        try:
            entries = load_entries(path, name_column=2 if list_name == "OFAC SDN" else 0)
        except OSError:
            continue
        mtime = os.path.getmtime(path)
        updated = dt.datetime.fromtimestamp(mtime, dt.timezone.utc).strftime("%Y-%m-%d")
        result["lists_checked"].append({"list": list_name, "updated_at": updated})
        for hit in match(query, entries):
            result["possible_matches"].append(
                {"list": list_name, "entry": hit["entry"], "match_type": hit["match_type"]}
            )
    result["match_count"] = len(result["possible_matches"])
    if not any_list:
        return {**result, "status": "unavailable", "error": "no sanctions list cached"}
    result["status"] = "ok"
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local sanctions list matching for buyer-check.")
    parser.add_argument("name", help="person or company name to check")
    parser.add_argument("--country", help="claimed country ISO2, used only for manual exclusion context")
    parser.add_argument("--no-update", action="store_true", help="never download or refresh the cache")
    parser.add_argument("--cache-dir", default=CACHE_DIR, help="cache directory (default: .cache/sanctions)")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    result = analyse(args.name, cache_dir=args.cache_dir, no_update=args.no_update)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("status") == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
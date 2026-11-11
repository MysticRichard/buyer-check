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
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
from email.utils import parsedate_to_datetime
from typing import Optional

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".cache", "sanctions")
CACHE_MAX_AGE_DAYS = 7
OFAC_FILE = "ofac_sdn.csv"
SDN_URLS = [
    "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV",
    "https://www.treasury.gov/ofac/downloads/sdn.csv",
]
PER_URL_TIMEOUT = 20.0
MIN_SDN_ROWS = 15000
SDN_COLUMNS = 12
MAX_WIDTH_OUTLIER_RATIO = 0.10

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


def validate_sdn(data: bytes) -> tuple:
    if not data:
        return False, "empty"
    head = data[:300].lower()
    if b"<html" in head or b"<!doctype" in head or head.lstrip().startswith(b"<"):
        return False, "not-csv"
    text = data.decode("utf-8", errors="replace")
    rows = [row for row in csv.reader(io.StringIO(text)) if row and any(cell.strip() for cell in row)]
    if len(rows) < MIN_SDN_ROWS:
        return False, "too-few-rows:{}".format(len(rows))
    if len(rows[0]) < SDN_COLUMNS:
        return False, "missing-columns"
    good_width = sum(1 for row in rows if len(row) >= SDN_COLUMNS)
    if good_width / len(rows) < (1 - MAX_WIDTH_OUTLIER_RATIO):
        return False, "bad-columns"
    return True, "{} rows".format(len(rows))


def parse_list_date(last_modified: str, path: str) -> str:
    if last_modified:
        try:
            return parsedate_to_datetime(last_modified).astimezone(dt.timezone.utc).date().isoformat()
        except (TypeError, ValueError, OverflowError):
            pass
    try:
        return dt.datetime.fromtimestamp(os.path.getmtime(path), dt.timezone.utc).date().isoformat()
    except OSError:
        return dt.datetime.now(dt.timezone.utc).date().isoformat()


def download_one(url: str, timeout: float) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "buyer-check/0.9"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return {
                "status": "ok",
                "data": response.read(),
                "last_modified": response.headers.get("Last-Modified"),
                "source_url": url,
            }
    except urllib.error.HTTPError as exc:
        return {"status": "failed", "reason": "download-failed", "detail": "http-{}".format(exc.code)}
    except OSError as exc:
        return {"status": "failed", "reason": "no-network", "detail": str(exc)[:200]}


def download_sdn(cache_dir: str = CACHE_DIR, timeout: float = PER_URL_TIMEOUT, urls=None) -> dict:
    path = os.path.join(cache_dir, OFAC_FILE)
    meta_path = os.path.join(cache_dir, "ofac_sdn.meta.json")
    attempts = []
    invalid_seen = False
    for url in urls or SDN_URLS:
        outcome = download_one(url, timeout)
        if outcome.get("status") != "ok":
            attempts.append({"url": url, "status": "failed", "reason": outcome.get("reason", "download-failed"), "detail": outcome.get("detail", "")})
            continue
        ok, detail = validate_sdn(outcome["data"])
        if not ok:
            invalid_seen = True
            attempts.append({"url": url, "status": "invalid-content", "reason": detail})
            continue
        os.makedirs(cache_dir, exist_ok=True)
        temp_path = path + ".tmp"
        with open(temp_path, "wb") as handle:
            handle.write(outcome["data"])
        os.replace(temp_path, path)
        list_date = parse_list_date(outcome.get("last_modified"), path)
        try:
            age_days = (dt.datetime.now(dt.timezone.utc).date() - dt.date.fromisoformat(list_date)).days
        except ValueError:
            age_days = None
        meta = {"source_url": outcome.get("source_url", url), "list_date": list_date, "list_age_days": age_days, "bytes": len(outcome["data"]), "detail": detail}
        with open(meta_path, "w", encoding="utf-8") as handle:
            json.dump(meta, handle, ensure_ascii=False)
        attempts.append({"url": url, "status": "ok", "reason": detail})
        return {"status": "ok", **meta, "attempts": attempts}
    reason = "invalid-content" if invalid_seen else "all-urls-failed"
    return {"status": "unavailable", "reason": reason, "attempts": attempts}


def download_ofac(cache_dir: str, timeout: float = 20.0) -> dict:
    """Download and validate the official OFAC SDN CSV. Never sends customer data."""
    return download_sdn(cache_dir, timeout=timeout)


def ensure_cache(cache_dir: str, no_update: bool = False, timeout: float = 20.0) -> Optional[str]:
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
    return result.get("reason") or "download-failed"


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
        entry = {"list": list_name, "updated_at": updated}
        if list_name == "OFAC SDN":
            meta_path = os.path.join(cache_dir, "ofac_sdn.meta.json")
            try:
                with open(meta_path, "r", encoding="utf-8") as handle:
                    meta = json.load(handle)
                for key in ("source_url", "list_date", "list_age_days"):
                    if meta.get(key) is not None:
                        entry[key] = meta[key]
            except (OSError, ValueError):
                pass
        result["lists_checked"].append(entry)
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
    parser.add_argument("name", nargs="?", help="person or company name to check")
    parser.add_argument("--country", help="claimed country ISO2, used only for manual exclusion context")
    parser.add_argument("--no-update", action="store_true", help="never download or refresh the cache")
    parser.add_argument("--cache-dir", default=CACHE_DIR, help="cache directory (default: .cache/sanctions)")
    parser.add_argument("--self-update", action="store_true", help="download and validate the SDN CSV only (test hook)")
    parser.add_argument("--urls", help="test hook: comma-separated SDN URLs")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_update:
        urls = [item.strip() for item in args.urls.split(",") if item.strip()] if args.urls else None
        outcome = download_sdn(cache_dir=args.cache_dir, urls=urls)
        results = [{"list": "OFAC SDN", "status": "downloaded" if outcome.get("status") == "ok" else "failed", **{k: outcome.get(k) for k in ("reason", "source_url", "list_date", "list_age_days", "attempts") if k in outcome}}]
        result = {"status": "ok" if outcome.get("status") == "ok" else "unavailable", "cache_dir": args.cache_dir, "results": results}
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["status"] == "ok" else 1
    if not args.name:
        print(json.dumps({"status": "unavailable", "error": "missing name"}, ensure_ascii=False))
        return 1
    result = analyse(args.name, cache_dir=args.cache_dir, no_update=args.no_update)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("status") == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
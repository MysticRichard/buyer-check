#!/usr/bin/env python3
"""Download official public sanctions lists for buyer-check.

Fetches the OFAC SDN CSV from the official Sanctions List Service (SLS)
endpoint. The legacy treasury.gov URL is kept as a fallback because it
redirects to the SLS endpoint. Every download is validated as SDN-shaped CSV
before it replaces the old cache; a failed download never overwrites a good
cache.

The EU / UN / UK OFSI list download URLs have NOT been verified yet and are
reported as not_configured - they are never guessed.

Usage:
    python update_sanctions.py           # download configured lists
    python update_sanctions.py --check    # only report source status
    python update_sanctions.py --urls URL1,URL2  # test hook: override SDN URLs

Output is JSON on stdout. Failures return status "unavailable" with a reason:
no-network, download-failed, invalid-content, or all-urls-failed.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import urllib.error
import urllib.request
from email.utils import parsedate_to_datetime

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".cache", "sanctions")

SDN_URLS = [
    "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV",
    "https://www.treasury.gov/ofac/downloads/sdn.csv",
]

PER_URL_TIMEOUT = 20.0
MIN_SDN_ROWS = 15000
SDN_COLUMNS = 12
MAX_WIDTH_OUTLIER_RATIO = 0.10

SOURCES = {
    "OFAC SDN": {
        "urls": SDN_URLS,
        "file": "ofac_sdn.csv",
        "status": "configured",
    },
    "EU Consolidated": {"urls": [], "file": "eu_consolidated.csv", "status": "not_configured"},
    "UN Security Council": {"urls": [], "file": "un_sc.csv", "status": "not_configured"},
    "UK OFSI Consolidated": {"urls": [], "file": "uk_ofsi.csv", "status": "not_configured"},
}


def validate_sdn(data: bytes) -> tuple:
    """Return (ok, detail) for a downloaded SDN CSV payload."""
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
            data = response.read()
            return {
                "status": "ok",
                "data": data,
                "last_modified": response.headers.get("Last-Modified"),
                "source_url": url,
            }
    except urllib.error.HTTPError as exc:
        return {"status": "failed", "reason": "download-failed", "detail": "http-{}".format(exc.code)}
    except OSError as exc:
        return {"status": "failed", "reason": "no-network", "detail": str(exc)[:200]}


def download_sdn(cache_dir: str = CACHE_DIR, timeout: float = PER_URL_TIMEOUT, urls=None) -> dict:
    """Try SDN URLs in order; validate; atomically replace the cache on success."""
    path = os.path.join(cache_dir, "ofac_sdn.csv")
    meta_path = os.path.join(cache_dir, "ofac_sdn.meta.json")
    attempts = []
    invalid_seen = False
    for url in (urls or SDN_URLS):
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
        meta = {
            "source_url": outcome.get("source_url", url),
            "list_date": list_date,
            "list_age_days": age_days,
            "bytes": len(outcome["data"]),
            "detail": detail,
        }
        with open(meta_path, "w", encoding="utf-8") as handle:
            json.dump(meta, handle, ensure_ascii=False)
        attempts.append({"url": url, "status": "ok", "reason": detail})
        return {"status": "ok", **meta, "attempts": attempts}
    reason = "invalid-content" if invalid_seen else "all-urls-failed"
    return {"status": "unavailable", "reason": reason, "attempts": attempts}


def update(cache_dir: str = CACHE_DIR, timeout: float = PER_URL_TIMEOUT, check_only: bool = False, urls=None) -> dict:
    results = []
    ok = True
    for name, source in SOURCES.items():
        if check_only or source["status"] != "configured":
            results.append({"list": name, "status": source["status"], "urls": source["urls"]})
            continue
        outcome = download_sdn(cache_dir, timeout=timeout, urls=urls) if name == "OFAC SDN" else {"status": "unavailable", "reason": "not-configured"}
        item = {"list": name, "status": "downloaded" if outcome.get("status") == "ok" else "failed"}
        item.update({key: outcome.get(key) for key in ("reason", "source_url", "list_date", "list_age_days", "attempts") if key in outcome})
        results.append(item)
        if outcome.get("status") != "ok":
            ok = False
    return {"status": "ok" if ok else "unavailable", "cache_dir": cache_dir, "results": results}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Update local sanctions list cache.")
    parser.add_argument("--check", action="store_true", help="report source status only")
    parser.add_argument("--cache-dir", default=CACHE_DIR, help="cache directory (default: .cache/sanctions)")
    parser.add_argument("--urls", help="test hook: comma-separated SDN URLs")
    args = parser.parse_args(argv)
    urls = [item.strip() for item in args.urls.split(",") if item.strip()] if args.urls else None
    result = update(cache_dir=args.cache_dir, check_only=args.check, urls=urls)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
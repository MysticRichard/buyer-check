#!/usr/bin/env python3
"""Download official public sanctions lists for buyer-check.

Fetches the OFAC SDN CSV (direct public download) into .cache/sanctions/ so
sanctions_check.py can match locally. The EU / UN / UK OFSI list download
URLs have NOT been verified yet and are reported as not_configured — they are
never guessed; run this script again after their official URLs are confirmed
and added to SOURCES.

Usage:
    python update_sanctions.py           # download configured lists
    python update_sanctions.py --check    # only report source status

Output is JSON on stdout. Failures return status "unavailable".
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".cache", "sanctions")

SOURCES = {
    "OFAC SDN": {
        "url": "https://www.treasury.gov/ofac/downloads/sdn.csv",
        "file": "ofac_sdn.csv",
        "status": "configured",
    },
    "EU Consolidated": {"url": None, "file": "eu_consolidated.csv", "status": "not_configured"},
    "UN Security Council": {"url": None, "file": "un_sc.csv", "status": "not_configured"},
    "UK OFSI Consolidated": {"url": None, "file": "uk_ofsi.csv", "status": "not_configured"},
}


def download(url: str, path: str, timeout: float = 60.0) -> tuple:
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "buyer-check/0.5"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = response.read()
    except Exception as exc:  # noqa: BLE001 - network errors vary by environment
        return False, str(exc)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)
    return True, "{} bytes".format(len(data))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Update local sanctions list cache.")
    parser.add_argument("--check", action="store_true", help="report source status only")
    args = parser.parse_args(argv)

    results = []
    ok = True
    for name, source in SOURCES.items():
        if args.check or source["status"] != "configured":
            results.append({"list": name, "status": source["status"], "url": source["url"]})
            continue
        path = os.path.join(CACHE_DIR, source["file"])
        success, detail = download(source["url"], path)
        results.append({"list": name, "status": "downloaded" if success else "failed", "detail": detail})
        if not success:
            ok = False
    print(json.dumps({"status": "ok" if ok else "unavailable", "cache_dir": CACHE_DIR, "results": results},
                     ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
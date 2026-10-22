#!/usr/bin/env python3
"""Look up domain registration data and DNS records for buyer-check.

Retrieves the registration date, registrar, status codes and nameservers of a
domain through RDAP (with a ``whois`` CLI fallback) and its MX / SPF / DMARC
records through DNS over HTTPS. Results feed the RF-DOM-002 (domain too new)
and RF-MAIL-001 (mail configuration) checks.

Usage:
    python whois_lookup.py example.com
    python whois_lookup.py example.com --timeout 15
    python whois_lookup.py example.com --rdap-json ./fixture.json   # offline

Output is JSON on stdout. When every source fails the script returns
``status: "unavailable"`` so the caller can report "未查到" instead of guessing.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

RDAP_ENDPOINT = "https://rdap.org/domain/{domain}"
DOH_ENDPOINT = "https://dns.google/resolve?name={name}&type={rtype}"
NEW_DOMAIN_DAYS = 180


def http_json(url: str, timeout: float) -> dict:
    """GET a URL and parse the JSON body."""
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "buyer-check/0.1"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def parse_rdap(payload: dict) -> dict:
    """Extract registration date, registrar and nameservers from an RDAP reply."""
    result = {"registration_date": None, "registrar": None, "status": [], "nameservers": []}

    for event in payload.get("events", []):
        if event.get("eventAction") == "registration":
            result["registration_date"] = event.get("eventDate")

    for entity in payload.get("entities", []):
        roles = entity.get("roles") or []
        if "registrar" in roles:
            for item in entity.get("vcardArray", [[], []])[1]:
                if item and item[0] == "fn":
                    result["registrar"] = item[3]

    result["status"] = payload.get("status", [])
    result["nameservers"] = [
        item.get("ldhName", "").lower() for item in payload.get("nameservers", []) if item.get("ldhName")
    ]
    return result


def whois_cli(domain: str, timeout: float) -> dict:
    """Fallback: parse registration fields from the whois command output."""
    try:
        output = subprocess.run(
            ["whois", domain], capture_output=True, text=True, timeout=timeout, check=False
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return {}

    data = {}
    match = re.search(r"Creation Date:\s*(\S+)", output, re.IGNORECASE)
    if match:
        data["registration_date"] = match.group(1)
    match = re.search(r"Registrar:\s*(.+)", output, re.IGNORECASE)
    if match:
        data["registrar"] = match.group(1).strip()
    return data


def dns_lookup(name: str, rtype: str, timeout: float) -> list:
    """Resolve DNS records through DNS over HTTPS."""
    url = DOH_ENDPOINT.format(name=urllib.parse.quote(name), rtype=rtype)
    try:
        payload = http_json(url, timeout)
    except (urllib.error.URLError, OSError, ValueError):
        return []
    return [item.get("data", "").strip('"') for item in payload.get("Answer", [])]


def _age_days(registration_date: Optional[str]) -> Optional[int]:
    if not registration_date:
        return None
    text = registration_date.strip().replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return (dt.datetime.now(dt.timezone.utc) - parsed).days


def analyse(domain: str, timeout: float, rdap_json: Optional[str] = None) -> dict:
    """Collect RDAP, WHOIS and DNS data for one domain.

    When ``rdap_json`` points to a saved RDAP response, that offline fixture is
    used instead of a live request (useful for tests and air-gapped runs).
    """
    result = {
        "domain": domain,
        "registration_date": None,
        "registrar": None,
        "status_codes": [],
        "nameservers": [],
        "dns": {"mx": [], "spf": [], "dmarc": []},
        "age_days": None,
        "is_new_domain": None,
        "sources": [],
        "errors": [],
    }

    if not re.fullmatch(r"[A-Za-z0-9.\-]+", domain or ""):
        result["errors"].append("invalid domain syntax")
        return result

    if rdap_json:
        try:
            with open(rdap_json, "r", encoding="utf-8") as handle:
                rdap = parse_rdap(json.load(handle))
            result.update(
                {
                    "registration_date": rdap["registration_date"],
                    "registrar": rdap["registrar"],
                    "status_codes": rdap["status"],
                    "nameservers": rdap["nameservers"],
                }
            )
            result["sources"].append("rdap-fixture")
        except (OSError, ValueError) as exc:
            result["errors"].append(f"rdap-fixture: {exc}")

        age_days = _age_days(result["registration_date"])
        result["age_days"] = age_days
        result["is_new_domain"] = None if age_days is None else age_days < NEW_DOMAIN_DAYS
        return result

    try:
        rdap = parse_rdap(http_json(RDAP_ENDPOINT.format(domain=domain), timeout))
        result.update(
            {
                "registration_date": rdap["registration_date"],
                "registrar": rdap["registrar"],
                "status_codes": rdap["status"],
                "nameservers": rdap["nameservers"],
            }
        )
        result["sources"].append("rdap")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        result["errors"].append(f"rdap: {exc}")

    if not result["registration_date"]:
        fallback = whois_cli(domain, timeout)
        if fallback.get("registration_date") or fallback.get("registrar"):
            result["registration_date"] = fallback.get("registration_date")
            result["registrar"] = fallback.get("registrar")
            result["sources"].append("whois")
        else:
            result["errors"].append("whois: no registration date found")

    result["dns"]["mx"] = dns_lookup(domain, "MX", timeout)
    result["dns"]["spf"] = [record for record in dns_lookup(domain, "TXT", timeout) if "v=spf1" in record]
    result["dns"]["dmarc"] = [
        record for record in dns_lookup(f"_dmarc.{domain}", "TXT", timeout) if "v=DMARC1" in record
    ]
    if result["dns"]["mx"] or result["dns"]["spf"] or result["dns"]["dmarc"]:
        result["sources"].append("dns.google")

    age_days = _age_days(result["registration_date"])
    result["age_days"] = age_days
    result["is_new_domain"] = None if age_days is None else age_days < NEW_DOMAIN_DAYS
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Domain RDAP/WHOIS and DNS lookup for buyer-check.")
    parser.add_argument("domain", help="domain name, e.g. example.com")
    parser.add_argument("--timeout", type=float, default=10.0, help="per-request timeout in seconds")
    parser.add_argument("--rdap-json", help="path to a saved RDAP response for offline analysis")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    result = analyse(args.domain, args.timeout, args.rdap_json)
    if result["registration_date"] is None and not result["sources"]:
        result["status"] = "unavailable"
    else:
        result["status"] = "ok"
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
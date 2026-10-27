#!/usr/bin/env python3
"""IP origin classification for buyer-check (v0.7.0).

Classifies an e-mail originating IP by network type without tracking anyone:
private / loopback / reserved addresses are skipped, documentation ranges are
kept for offline examples, and a public IP is only looked up when --online is
explicitly passed. Online lookup uses public RIR RDAP data (country, network
name, organisation); no third-party geolocation service is contacted.

The output never contains the full IP: only the masked network (IPv4 /24,
IPv6 /48), country, ASN, organisation and network type. A country mismatch is
a lead, not a score: RF-CORP-001 requires at least two independent fields to
contradict the claimed country, and never counts mail-provider relays or
hosting / anonymised networks.

Usage:
    python ip_check.py --ip 203.0.113.7 --claimed-country AE
    python ip_check.py --ip 203.0.113.7 --claimed-country AE --rdap-json ../tests/fixtures/ip-rdap-sample.json
    python ip_check.py --ip 203.0.113.7 --claimed-country AE --online

Output is JSON on stdout. Errors return status "unavailable".
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import sys
from datetime import datetime, timezone
from typing import Optional
from urllib.error import URLError
from urllib.request import Request, urlopen

DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ip_ranges.json")
RDAP_BASE = "https://rdap.org/ip/"
FIXTURE_TIME = "2026-10-27T00:00:00Z"
TEST_NET = tuple(
    ipaddress.ip_network(value)
    for value in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")
)


def load_table(path: str = DATA_FILE) -> dict:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def normalize_claimed(value: Optional[str]) -> Optional[str]:
    text = (value or "").strip().upper()
    return text if len(text) == 2 and text.isalpha() else None


def parse_ip(raw: Optional[str]):
    try:
        return ipaddress.ip_address((raw or "").strip())
    except ValueError:
        return None


def is_public(ip_obj) -> bool:
    if ip_obj.version == 4:
        for network in TEST_NET:
            if ip_obj in network:
                return True
    return not (
        ip_obj.is_private
        or ip_obj.is_loopback
        or ip_obj.is_link_local
        or ip_obj.is_multicast
        or ip_obj.is_reserved
        or ip_obj.is_unspecified
    )


def mask_ip(ip_obj) -> str:
    suffix = 24 if ip_obj.version == 4 else 48
    return str(ipaddress.ip_network("{}/{}".format(ip_obj, suffix), strict=False))


def vcard_text(vcard) -> list:
    values = []
    if not isinstance(vcard, list) or len(vcard) < 2:
        return values
    for item in vcard[1]:
        if isinstance(item, list) and len(item) >= 4 and item[0] in ("fn", "org"):
            values.append(str(item[3]))
    return values


def parse_rdap(payload: dict) -> dict:
    network = payload.get("network") if isinstance(payload.get("network"), dict) else payload
    country = network.get("country")
    if isinstance(country, str) and len(country) == 2 and country.isalpha():
        country = country.upper()
    else:
        country = None

    org = None
    asn = None
    for entity in network.get("entities", []) or []:
        for text in vcard_text(entity.get("vcardArray")):
            if text and not org:
                org = text
        for public_id in entity.get("publicIds", []) or []:
            if str(public_id.get("type", "")).upper() == "ASN":
                identifier = str(public_id.get("identifier", "")).upper().lstrip("AS")
                if identifier:
                    asn = "AS" + identifier

    raw_asn = payload.get("asn")
    if not asn and isinstance(raw_asn, str) and raw_asn.upper().startswith("AS"):
        asn = raw_asn.upper()

    return {
        "country": country,
        "name": network.get("name"),
        "org": org,
        "asn": asn,
    }


def match_entry(parsed: dict, entries: list) -> Optional[dict]:
    asn = (parsed.get("asn") or "").upper()
    haystack = " ".join(
        str(parsed.get(key) or "").lower() for key in ("org", "name")
    )
    for entry in entries:
        if asn and asn == str(entry.get("asn", "")).upper():
            return entry
        if any(word in haystack for word in entry.get("match", [])):
            return entry
    return None


def classify_network(parsed: dict, table: dict) -> str:
    if match_entry(parsed, table.get("mail_providers", [])):
        return "mail_provider"
    if match_entry(parsed, table.get("hosting", [])):
        return "hosting_or_anonymized"
    return "unknown"


def fetch_rdap(ip_text: str, timeout: int) -> Optional[dict]:
    request = Request(
        RDAP_BASE + ip_text,
        headers={"Accept": "application/rdap+json", "User-Agent": "buyer-check/0.7.0"},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (URLError, OSError, ValueError):
        return None


def analyse(
    raw_ip: Optional[str],
    claimed: Optional[str] = None,
    online: bool = False,
    fixture_path: Optional[str] = None,
    table: Optional[dict] = None,
    timeout: int = 10,
) -> dict:
    table = table or load_table()
    claimed_country = normalize_claimed(claimed)
    result = {
        "status": "skipped",
        "reason": None,
        "ip_masked": None,
        "country": None,
        "asn": None,
        "org": None,
        "net_type": "unknown",
        "claimed_country": claimed_country,
        "consistent": None,
        "source": None,
        "retrieved_at": None,
    }

    if not raw_ip or not str(raw_ip).strip():
        result["reason"] = "no_ip"
        return result

    ip_obj = parse_ip(raw_ip)
    if ip_obj is None:
        result["reason"] = "invalid_ip"
        return result

    result["ip_masked"] = mask_ip(ip_obj)
    if not is_public(ip_obj):
        result["reason"] = "non_public"
        result["net_type"] = "non_public"
        return result

    payload = None
    if fixture_path:
        try:
            with open(fixture_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError):
            payload = None
        if payload is None:
            result["status"] = "unavailable"
            result["reason"] = "fixture_error"
            return result
        result["source"] = "fixture:" + os.path.basename(fixture_path)
        result["retrieved_at"] = payload.get("retrieved_at") or FIXTURE_TIME
    elif online:
        payload = fetch_rdap(str(ip_obj), timeout)
        if payload is None:
            result["status"] = "unavailable"
            result["reason"] = "rdap_error"
            return result
        result["source"] = RDAP_BASE
        result["retrieved_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    else:
        result["status"] = "offline"
        result["reason"] = "online_not_requested"
        return result

    parsed = parse_rdap(payload)
    net_type = classify_network(parsed, table)
    result["status"] = "ok"
    result["net_type"] = net_type
    result["asn"] = parsed.get("asn")
    result["org"] = parsed.get("org")
    if net_type in ("mail_provider", "hosting_or_anonymized"):
        result["country"] = None
        result["consistent"] = None
    else:
        result["country"] = parsed.get("country")
        if result["country"] and claimed_country:
            result["consistent"] = result["country"] == claimed_country
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Classify an e-mail originating IP for buyer-check.")
    parser.add_argument("--ip", default="", help="originating IP from the mail header (never persisted)")
    parser.add_argument("--claimed-country", help="claimed country as ISO 3166-1 alpha-2, e.g. AE")
    parser.add_argument("--online", action="store_true", help="explicitly allow one RDAP lookup (only the IP is sent)")
    parser.add_argument("--rdap-json", help="offline RDAP fixture instead of a network lookup")
    parser.add_argument("--timeout", type=int, default=10, help="RDAP timeout in seconds (default 10)")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    result = analyse(
        args.ip,
        claimed=args.claimed_country,
        online=args.online,
        fixture_path=args.rdap_json,
        timeout=args.timeout,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result["status"] == "unavailable" else 0


if __name__ == "__main__":
    sys.exit(main())
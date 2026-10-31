#!/usr/bin/env python3
"""Identity helpers for buyer-check v0.8.0.

Subcommands:
  site      extract public company profile from a saved HTML file or a website
  backlink  check whether a social-page text/HTML points back to the company domain
  image     compare avatars for exact / near-duplicate images (no face recognition)

Offline by default: `site` only fetches when `--online` is passed. Each page is
read serially, at most 4 pages, with a delay and a conservative robots.txt
check. `backlink` never fetches Facebook/LinkedIn; it only inspects text given by
the caller. `image` never writes, stores or prints an image hash, and never uses
face detection/recognition. If Pillow is not installed, image comparison falls
back to SHA-256 exact-file equality and reports not-comparable otherwise.
"""

from __future__ import annotations

import argparse
import hashlib
import html as html_lib
import json
import os
import re
import sys
import time
import urllib.robotparser
from urllib.parse import urljoin, urlencode, urlparse
from urllib.request import Request, urlopen

try:  # optional dependency; never required
    from PIL import Image
except Exception:  # pragma: no cover
    Image = None

USER_AGENT = "buyer-check/0.8.0 (company-profile; read-only)"
SOCIAL_PATTERNS = {
    "facebook": r"https?://(?:www\.)?facebook\.com/[^\s\"'<>]+",
    "linkedin": r"https?://(?:[a-z]{2}\.)?(?:www\.)?linkedin\.com/[^\s\"'<>]+",
    "instagram": r"https?://(?:www\.)?instagram\.com/[^\s\"'<>]+",
    "youtube": r"https?://(?:www\.)?youtube\.com/[^\s\"'<>]+",
    "x": r"https?://(?:www\.)?(?:x|twitter)\.com/[^\s\"'<>]+",
}
GOOGLE_TEXTSEARCH = "https://maps.googleapis.com/maps/api/place/textsearch/json"
GOOGLE_DETAILS = "https://maps.googleapis.com/maps/api/place/details/json"
OSM_SEARCH = "https://nominatim.openstreetmap.org/search"


def unique_sorted(values):
    return sorted({value.strip() for value in values if value and value.strip()})


def strip_tags(text):
    return re.sub(r"<[^>]+>", " ", text or "")


def text_of(fragment):
    return re.sub(r"\s+", " ", html_lib.unescape(strip_tags(fragment))).strip()


def meta_content(html, key, attr="name"):
    pattern = re.compile(
        r"<meta\s+[^>]*" + attr + r"=[\"']" + re.escape(key) + r"[\"'][^>]*content=[\"']([^\"']*)[\"']",
        re.I,
    )
    match = pattern.search(html)
    return html_lib.unescape(match.group(1)).strip() if match else None


def parse_html(html, base_url):
    title_match = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    title = text_of(title_match.group(1)) if title_match else ""

    description = meta_content(html, "description") or meta_content(html, "og:description", "property")
    site_name = meta_content(html, "og:site_name", "property")

    h1s = [text_of(item) for item in re.findall(r"<h1[^>]*>(.*?)</h1>", html, re.I | re.S)]
    title_candidates = []
    if title:
        title_candidates.append(re.split(r"[|\-–—]", title)[0])
    company_candidates = unique_sorted([site_name or ""] + h1s + title_candidates)

    social_links = []
    for platform, pattern in SOCIAL_PATTERNS.items():
        for url in re.findall(pattern, html, re.I):
            social_links.append({"platform": platform, "url": url.rstrip(".,);\"'")})
    social_links = sorted(
        {(item["platform"], item["url"]) for item in social_links}
    )
    social_links = [{"platform": platform, "url": url} for platform, url in social_links]

    emails = [match.lower() for match in re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", html)]
    emails = unique_sorted(emails)

    phones = []
    for match in re.findall(r"tel:([^\"'\s<>]+)", html, re.I):
        phones.append(html_lib.unescape(match))
    for match in re.findall(r"\+?\d[\d\s().-]{6,}\d", html):
        phones.append(match)
    phones = unique_sorted(phones)

    addresses = [text_of(item) for item in re.findall(r"<address[^>]*>(.*?)</address>", html, re.I | re.S)]
    for match in re.findall(r"itemprop=[\"']streetAddress[\"'][^>]*content=[\"']([^\"']*)[\"']", html, re.I):
        addresses.append(html_lib.unescape(match).strip())
    addresses = unique_sorted(addresses)

    team_links, contact_links = [], []
    for href in re.findall(r"href=[\"']([^\"']+)[\"']", html, re.I):
        absolute = urljoin(base_url or "", html_lib.unescape(href))
        lower = absolute.lower()
        if "team" in lower or "about" in lower:
            team_links.append(absolute)
        if "contact" in lower:
            contact_links.append(absolute)
    team_links = unique_sorted(team_links)
    contact_links = unique_sorted(contact_links)

    copyright_match = re.search(r"(?:©|&copy;|copyright)[^\d]{0,12}(\d{4})", html, re.I)
    copyright_year = int(copyright_match.group(1)) if copyright_match else None

    return {
        "company_candidates": company_candidates,
        "description": description,
        "social_links": social_links,
        "emails": emails,
        "phones": phones,
        "addresses": addresses,
        "team_links": team_links,
        "contact_links": contact_links,
        "copyright_year": copyright_year,
    }


def fetch(url, timeout=10):
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    with urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def robots_allows(domain, scheme, path):
    try:
        parser = urllib.robotparser.RobotFileParser()
        parser.set_url(urljoin(f"{scheme}://{domain}", "/robots.txt"))
        parser.read()
        return parser.can_fetch(USER_AGENT, urljoin(f"{scheme}://{domain}", path))
    except Exception:
        return True


def site_command(args):
    if not args.html_file and not (args.online and args.domain):
        return {"status": "unavailable", "command": "site", "error": "pass --html-file or --online with --domain"}
    pages = []
    if args.html_file:
        try:
            with open(args.html_file, "r", encoding="utf-8", errors="replace") as handle:
                html = handle.read()
        except OSError as exc:
            return {"status": "unavailable", "command": "site", "error": str(exc)}
        pages.append(("file", html))
    else:
        domain = args.domain.strip().lower()
        scheme = "https"
        paths = ["/", "/about", "/products", "/contact"][: max(1, min(args.max_pages, 4))]
        for index, path in enumerate(paths):
            if index and not robots_allows(domain, scheme, path):
                continue
            try:
                body = fetch(urljoin(f"{scheme}://{domain}", path), timeout=args.timeout)
                pages.append((urljoin(f"{scheme}://{domain}", path), body))
            except Exception:
                continue
            if index:
                time.sleep(max(0, args.delay))
        if not pages:
            return {"status": "unavailable", "command": "site", "error": "website not reachable"}

    merged = {
        "company_candidates": [],
        "description": None,
        "social_links": [],
        "emails": [],
        "phones": [],
        "addresses": [],
        "team_links": [],
        "contact_links": [],
        "copyright_year": None,
    }
    for page_url, body in pages:
        parsed = parse_html(body, page_url if page_url != "file" else f"https://{args.domain}/" if args.domain else "")
        for key in ("company_candidates", "emails", "phones", "addresses", "team_links", "contact_links"):
            merged[key].extend(parsed[key])
        merged["social_links"].extend(parsed["social_links"])
        if not merged["description"] and parsed["description"]:
            merged["description"] = parsed["description"]
        if merged["copyright_year"] is None and parsed["copyright_year"]:
            merged["copyright_year"] = parsed["copyright_year"]

    merged["company_candidates"] = unique_sorted(merged["company_candidates"])
    merged["emails"] = unique_sorted(merged["emails"])
    merged["phones"] = unique_sorted(merged["phones"])
    merged["addresses"] = unique_sorted(merged["addresses"])
    merged["team_links"] = unique_sorted(merged["team_links"])
    merged["contact_links"] = unique_sorted(merged["contact_links"])
    merged["social_links"] = [
        {"platform": platform, "url": url}
        for platform, url in sorted({(item["platform"], item["url"]) for item in merged["social_links"]})
    ]
    return {
        "status": "ok",
        "command": "site",
        "domain": args.domain,
        "pages_fetched": ["file"] if args.html_file else [url for url, _ in pages],
        **merged,
    }


def backlink_command(args):
    if args.html_file:
        try:
            with open(args.html_file, "r", encoding="utf-8", errors="replace") as handle:
                text = handle.read()
        except OSError as exc:
            return {"status": "unavailable", "command": "backlink", "error": str(exc)}
    else:
        text = args.text or ""
    domain = (args.domain or "").strip().lower().lstrip("www.")
    if not domain:
        return {"status": "unavailable", "command": "backlink", "error": "--domain is required"}
    mutual = domain in text.lower()
    return {
        "status": "ok",
        "command": "backlink",
        "domain": domain,
        "mutual": mutual,
    }


def dhash(image):
    small = image.convert("L").resize((9, 8))
    pixels = list(small.getdata())
    bits = []
    for row in range(8):
        for col in range(8):
            bits.append(pixels[row * 9 + col] > pixels[row * 9 + col + 1])
    return bits


def hamming(a, b):
    return sum(1 for left, right in zip(a, b) if left != right)


def image_command(args):
    paths = list(args.paths)
    if len(paths) < 2:
        return {"status": "unavailable", "command": "image", "error": "at least two image paths are required"}
    try:
        blobs = [open(path, "rb").read() for path in paths]
    except OSError as exc:
        return {"status": "unavailable", "command": "image", "error": str(exc)}
    digests = [hashlib.sha256(blob).hexdigest() for blob in blobs]
    if len(set(digests)) == 1:
        return {"status": "ok", "command": "image", "result": "same-image", "method": "sha256", "files": len(paths)}
    if Image is None:
        return {
            "status": "ok",
            "command": "image",
            "result": "not-comparable",
            "reason": "no-image-library",
            "method": "sha256",
            "files": len(paths),
        }
    try:
        hashes = [dhash(Image.open(path)) for path in paths]
        distance = max(hamming(hashes[0], other) for other in hashes[1:])
    except Exception:
        return {
            "status": "ok",
            "command": "image",
            "result": "not-comparable",
            "reason": "image-decode-failed",
            "method": "dhash",
            "files": len(paths),
        }
    # Calibrated with synthetic icons: 0-8 near-duplicate, >8 different.
    result = "near-duplicate" if distance <= 8 else "different"
    return {
        "status": "ok",
        "command": "image",
        "result": result,
        "method": "dhash",
        "distance": distance,
        "files": len(paths),
    }


def normalize_phone(value):
    return re.sub(r"\D", "", value or "")


def normalize_name(value):
    return re.sub(r"[^a-z0-9]+", "", (value or "").lower())


def fetch_json(url, timeout=10):
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def phone_matches(candidate, phone):
    wanted = normalize_phone(phone)
    got = normalize_phone(candidate.get("phone"))
    if not wanted or not got:
        return False
    return wanted == got or wanted.endswith(got[-8:]) or got.endswith(wanted[-8:])


def name_matches(candidate, company):
    wanted = normalize_name(company)
    got = normalize_name(candidate.get("name") or candidate.get("address"))
    return bool(wanted and got and (wanted in got or got in wanted))


def map_result(source, query, candidates, args):
    result = {
        "status": "ok" if candidates else "unavailable",
        "command": "map",
        "source": source,
        "query": query,
        "candidates": candidates,
        "match": {
            "name_match": any(name_matches(item, args.company) for item in candidates) if args.company else None,
            "phone_match": any(phone_matches(item, args.phone) for item in candidates) if args.phone else None,
        },
    }
    if not candidates:
        result["error"] = "no results"
    return result


def google_candidates(payload, args, key=None):
    results = (payload.get("results") or [])[: args.limit]
    candidates = []
    for result in results:
        location = (result.get("geometry") or {}).get("location") or {}
        item = {
            "name": result.get("name"),
            "address": result.get("formatted_address"),
            "phone": result.get("formatted_phone_number") or result.get("international_phone_number"),
            "website": result.get("website"),
            "rating": result.get("rating"),
            "reviews": result.get("user_ratings_total"),
            "business_status": result.get("business_status"),
            "place_id": result.get("place_id"),
            "lat": location.get("lat"),
            "lng": location.get("lng"),
        }
        if key and item["place_id"] and not args.fixture_json:
            try:
                params = urlencode({
                    "place_id": item["place_id"],
                    "fields": "name,formatted_address,formatted_phone_number,international_phone_number,website,rating,user_ratings_total,business_status,geometry",
                    "key": key,
                })
                details = fetch_json(f"{GOOGLE_DETAILS}?{params}", args.timeout)
                if details.get("status") == "OK":
                    detail = details.get("result") or {}
                    if detail.get("name"):
                        item["name"] = detail["name"]
                    if detail.get("formatted_address"):
                        item["address"] = detail["formatted_address"]
                    phone = detail.get("formatted_phone_number") or detail.get("international_phone_number")
                    if phone:
                        item["phone"] = phone
                    for field in ("website", "rating", "user_ratings_total", "business_status"):
                        if detail.get(field) is not None:
                            item[field] = detail[field]
                    detail_location = (detail.get("geometry") or {}).get("location") or {}
                    if detail_location.get("lat") is not None:
                        item["lat"] = detail_location["lat"]
                    if detail_location.get("lng") is not None:
                        item["lng"] = detail_location["lng"]
            except Exception:
                pass
        candidates.append(item)
    return candidates


def google_map(args, key):
    query = " ".join(part for part in [args.company, args.phone, args.country] if part)
    params = urlencode({"query": query, "key": key})
    try:
        payload = fetch_json(f"{GOOGLE_TEXTSEARCH}?{params}", args.timeout)
    except Exception:
        return {"status": "unavailable", "command": "map", "source": "google_places", "error": "request-failed"}
    status = payload.get("status") if isinstance(payload, dict) else None
    if status not in ("OK", "ZERO_RESULTS"):
        return {"status": "unavailable", "command": "map", "source": "google_places", "error": status or "request-failed"}
    return map_result("google_places", query, google_candidates(payload, args, key), args)


def osm_map(args):
    query = " ".join(part for part in [args.company, args.country] if part)
    params = urlencode({"q": query, "format": "jsonv2", "addressdetails": 1, "limit": args.limit})
    try:
        payload = fetch_json(f"{OSM_SEARCH}?{params}", args.timeout)
    except Exception:
        return {"status": "unavailable", "command": "map", "source": "osm_nominatim", "error": "request-failed"}
    if not isinstance(payload, list):
        return {"status": "unavailable", "command": "map", "source": "osm_nominatim", "error": "request-failed"}
    candidates = []
    for item in payload[: args.limit]:
        extra = item.get("extratags") or {}
        candidates.append({
            "name": item.get("name") or item.get("display_name"),
            "address": item.get("display_name"),
            "phone": extra.get("phone"),
            "website": extra.get("website"),
            "rating": None,
            "reviews": None,
            "business_status": None,
            "place_id": str(item.get("place_id") or ""),
            "lat": item.get("lat"),
            "lng": item.get("lon"),
        })
    return map_result("osm_nominatim", query, candidates, args)


def map_command(args):
    query = " ".join(part for part in [args.company, args.phone, args.country] if part)
    if args.fixture_json:
        try:
            with open(args.fixture_json, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError) as exc:
            return {"status": "unavailable", "command": "map", "error": str(exc)}
        if args.fixture_source == "osm_nominatim":
            if not isinstance(payload, list):
                return {"status": "unavailable", "command": "map", "source": "osm_nominatim", "error": "invalid fixture"}
            candidates = []
            for item in payload[: args.limit]:
                extra = item.get("extratags") or {}
                candidates.append({
                    "name": item.get("name") or item.get("display_name"),
                    "address": item.get("display_name"),
                    "phone": extra.get("phone"),
                    "website": extra.get("website"),
                    "rating": None,
                    "reviews": None,
                    "business_status": None,
                    "place_id": str(item.get("place_id") or ""),
                    "lat": item.get("lat"),
                    "lng": item.get("lon"),
                })
            return map_result("osm_nominatim", query, candidates, args)
        return map_result("google_places", query, google_candidates(payload, args), args)
    if not args.online:
        return {"status": "unavailable", "command": "map", "error": "pass --online or --fixture-json"}
    key = args.google_key or os.environ.get("GOOGLE_MAPS_API_KEY")
    if key:
        return google_map(args, key)
    return osm_map(args)


def build_parser():
    parser = argparse.ArgumentParser(description="buyer-check identity helpers (site/backlink/image).")
    sub = parser.add_subparsers(dest="command", required=True)

    site = sub.add_parser("site", help="extract a company profile from HTML or a website")
    site.add_argument("--domain")
    site.add_argument("--html-file")
    site.add_argument("--online", action="store_true")
    site.add_argument("--max-pages", type=int, default=4)
    site.add_argument("--delay", type=float, default=1.0)
    site.add_argument("--timeout", type=int, default=10)

    backlink = sub.add_parser("backlink", help="check whether a social page points back to the domain")
    backlink.add_argument("--domain", required=True)
    backlink.add_argument("--html-file")
    backlink.add_argument("--text")

    image = sub.add_parser("image", help="compare avatars (exact / near-duplicate)")
    image.add_argument("paths", nargs="+")

    map_cmd = sub.add_parser("map", help="look up a company POI via Google Places or OSM Nominatim")
    map_cmd.add_argument("--company")
    map_cmd.add_argument("--phone")
    map_cmd.add_argument("--country")
    map_cmd.add_argument("--google-key")
    map_cmd.add_argument("--online", action="store_true")
    map_cmd.add_argument("--fixture-json")
    map_cmd.add_argument("--fixture-source", default="google_places")
    map_cmd.add_argument("--limit", type=int, default=5)
    map_cmd.add_argument("--timeout", type=int, default=10)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "site":
        result = site_command(args)
    elif args.command == "backlink":
        result = backlink_command(args)
    elif args.command == "map":
        result = map_command(args)
    else:
        result = image_command(args)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("status") == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
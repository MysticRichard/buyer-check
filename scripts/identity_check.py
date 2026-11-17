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
import datetime as dt
import re
import socket
import sys
import time
import urllib.robotparser
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin, urlencode, urlparse
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
BRREG_SEARCH = "https://data.brreg.no/enhetsregisteret/api/enheter"
BRREG_ENTITY = "https://data.brreg.no/enhetsregisteret/api/enheter/"
BRREG_LICENSE = "NLOD 2.0"
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


def normalize_company(value):
    return re.sub(r"\s+", " ", (value or "").strip()).upper()


def country_code(value):
    key = (value or "").strip().lower()
    if not key:
        return None
    if len(key) == 2 and key.isalpha():
        return key.upper()
    return {
        "norge": "NO", "norway": "NO", "noreg": "NO",
        "sverige": "SE", "sweden": "SE",
        "danmark": "DK", "denmark": "DK",
        "suomi": "FI", "finland": "FI",
    }.get(key)


def registry_status_text(entity):
    if entity.get("konkurs"):
        return "已破产"
    if entity.get("underTvangsavviklingEllerTvangsopplosning"):
        return "强制清算"
    if entity.get("underAvvikling"):
        return "清算中"
    return "存续"


def registry_entry(entity):
    address = entity.get("forretningsadresse") or {}
    org_number = entity.get("organisasjonsnummer")
    return {
        "legal_name": entity.get("navn"),
        "org_number": org_number,
        "status_text": registry_status_text(entity),
        "incorporation_date": entity.get("registreringsdatoEnhetsregisteret") or entity.get("stiftelsesdato"),
        "address_country": country_code(address.get("land")),
        "source_url": f"{BRREG_ENTITY}{org_number}" if org_number else BRREG_SEARCH,
    }


def registry_error(company, registry_url, error):
    return {
        "status": "unavailable",
        "command": "registry",
        "query": company,
        "country": "NO",
        "registry_url": registry_url,
        "license": BRREG_LICENSE,
        "error": error,
    }


def registry_link(country):
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "country_capabilities.json"), "r", encoding="utf-8") as handle:
            data = json.load(handle)
        entry = ((data.get("countries") or {}).get((country or "").lower()) or {}).get("registry") or {}
        return entry.get("url")
    except (OSError, ValueError):
        return None


def registry_command(args):
    company = (args.company or "").strip()
    if not company:
        return {"status": "unavailable", "command": "registry", "error": "missing-company"}
    raw_country = (args.country or "").strip()
    if raw_country:
        country = country_code(raw_country)
        if country is None:
            return {
                "status": "not-covered",
                "command": "registry",
                "query": company,
                "country": raw_country,
                "registry_url": None,
                "license": BRREG_LICENSE,
                "note": "无法识别国家；registry 目前只实现挪威（NO），不猜测",
            }
    else:
        country = "NO"
    encoded = quote(company, safe="!~*'()")
    registry_url = f"{BRREG_SEARCH}?navn={encoded}"
    if country != "NO":
        return {
            "status": "not-covered",
            "command": "registry",
            "query": company,
            "country": country,
            "registry_url": registry_link(country),
            "license": BRREG_LICENSE,
            "note": "registry 目前只实现挪威（NO）；该国入口见 registry_url，或人工核实",
        }

    if args.fixture_json:
        try:
            with open(args.fixture_json, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError):
            return registry_error(company, registry_url, "invalid-fixture")
        if not isinstance(payload, dict):
            return registry_error(company, registry_url, "invalid-fixture")
        if payload.get("error"):
            return registry_error(company, registry_url, str(payload["error"]))
        entities = ((payload.get("_embedded") or {}).get("enheter") or [])
        retrieved_at = payload.get("retrieved_at") or "fixture"
    elif args.online:
        try:
            payload = fetch_json(registry_url, args.timeout)
        except HTTPError as exc:
            return registry_error(company, registry_url, f"http-{exc.code}")
        except (TimeoutError, socket.timeout):
            return registry_error(company, registry_url, "timeout")
        except URLError as exc:
            reason = getattr(exc, "reason", exc)
            if isinstance(reason, (TimeoutError, socket.timeout)) or "timed out" in str(reason).lower():
                return registry_error(company, registry_url, "timeout")
            return registry_error(company, registry_url, "fetch-failed")
        except (OSError, ValueError):
            return registry_error(company, registry_url, "fetch-failed")
        if not isinstance(payload, dict):
            return registry_error(company, registry_url, "invalid-response")
        entities = ((payload.get("_embedded") or {}).get("enheter") or [])
        retrieved_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    else:
        return {
            "status": "offline",
            "command": "registry",
            "query": company,
            "country": "NO",
            "registry_url": registry_url,
            "license": BRREG_LICENSE,
            "note": "加 --online 或 --fixture-json 查询；离线只给链接",
        }

    wanted = normalize_company(company)
    entries = [
        registry_entry(entity)
        for entity in entities
        if isinstance(entity, dict) and normalize_company(entity.get("navn")) == wanted
    ]
    base = {
        "command": "registry",
        "query": company,
        "country": "NO",
        "registry_url": registry_url,
        "license": BRREG_LICENSE,
        "retrieved_at": retrieved_at,
    }
    if not entries:
        return {"status": "not-found", **base}
    if len(entries) > 1:
        return {"status": "ambiguous", **base, "candidates": entries}
    entry = entries[0]
    claimed = country_code(args.claimed_country)
    mismatch = claimed is not None and entry.get("address_country") is not None and claimed != entry.get("address_country")
    return {"status": "found", **base, **entry, "country_mismatch": mismatch}


DISCOVERY_TEMPLATES = [
    "“<country> company registry official site” + “<country> 公司登记 官方网站”",
    "“<country> business register ministry of justice / commerce / economy”",
    "“<country> tax authority taxpayer verification”",
    "“<country> government procurement portal”",
    "“<country> insolvency register official”",
]


def validate_capabilities(data):
    errors = []
    allowed_verification = {"official-page", "secondary-source", "unverified", "discovered"}
    allowed_checksum = {"none", "gstin-mod36", "pan-structure"}
    if data.get("schema_version") != "0.6.0":
        errors.append("schema_version")
    if not (data.get("countries") or {}):
        errors.append("countries:empty")
    for code, country in (data.get("countries") or {}).items():
        if not isinstance(country, dict):
            errors.append(f"{code}:not-object")
            continue
        if not isinstance(country.get("registry"), dict):
            errors.append(f"{code}:registry")
        registry = country.get("registry") or {}
        if registry.get("automation_allowed") is True and (registry.get("verification") or country.get("verification")) != "official-page":
            errors.append(f"{code}:automation")
        if country.get("verification") not in allowed_verification:
            errors.append(f"{code}:verification")
        for key in ("registry", "tax_verification", "procurement", "insolvency"):
            item = country.get(key)
            if item is not None and (not isinstance(item, dict) or (item.get("verification") is not None and item.get("verification") not in allowed_verification)):
                errors.append(f"{code}:{key}")
        for fmt in country.get("id_formats") or []:
            if not fmt.get("id_type") or not fmt.get("label") or not isinstance(fmt.get("length"), int):
                errors.append(f"{code}:id_formats.fields")
            regex_value = fmt.get("regex") or fmt.get("pattern")
            if not str(regex_value or "").strip():
                errors.append(f"{code}:id_formats.regex-empty")
            else:
                try:
                    re.compile(regex_value)
                except re.error:
                    errors.append(f"{code}:id_formats.regex")
            if (fmt.get("checksum") or "none") not in allowed_checksum:
                errors.append(f"{code}:id_formats.checksum")
    return errors


def country_command(args):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "country_capabilities.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {"status": "unavailable", "error": "capabilities-unreadable"}
    if getattr(args, "validate", False):
        errors = validate_capabilities(data)
        return {"status": "ok" if not errors else "invalid-input", "countries": len(data.get("countries") or {}), "errors": errors}
    code = (args.code or "").strip().upper()
    if not code:
        return {"status": "invalid-input", "error": "missing country code"}
    country = (data.get("countries") or {}).get(code.lower())
    if not country:
        return {
            "status": "not-in-matrix",
            "country": code,
            "discovery": {
                "used": "discovery",
                "verification": "discovered",
                "templates": DISCOVERY_TEMPLATES,
                "note": "本次运行临时发现，不写回仓库；官方页面核对前只给链接和检索清单",
            },
            "global_sources": data.get("global_sources") or [],
        }
    registry = country.get("registry") or {}
    registry_view = {
        "name": registry.get("name"),
        "url": registry.get("url"),
        "verification": registry.get("verification") or country.get("verification") or "unverified",
        "automation_allowed": registry.get("automation_allowed") is True,
    }
    return {
        "status": "ok",
        "country": code,
        "name": country.get("name"),
        "verification": country.get("verification") or "unverified",
        "registry": registry_view,
        "tax_verification": country.get("tax_verification"),
        "procurement": country.get("procurement"),
        "insolvency": country.get("insolvency"),
        "id_formats": country.get("id_formats") or [],
        "sources": country.get("sources") or [],
        "global_sources": data.get("global_sources") or [],
        "discovery": False,
    }


ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
GST_STATE_CODES = {
    "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
    "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
    "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
    "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
    "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
    "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka",
    "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
    "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
}
PAN_ENTITY_TYPES = {
    "P": "individual", "C": "company", "H": "HUF", "F": "firm/LLP", "A": "AOP",
    "T": "trust", "B": "BOI", "L": "local-authority", "J": "artificial-juridical-person", "G": "government",
}


def mask_id(value):
    value = "" if value is None else str(value)
    if len(value) <= 4:
        return "•" * len(value)
    return value[:2] + "•" * (len(value) - 4) + value[-2:]


def gstin_checksum(value):
    if len(value) < 15:
        return None
    total = 0
    for index in range(14):
        digit = ID_CHARS.index(value[index]) if value[index] in ID_CHARS else None
        if digit is None:
            return None
        product = digit * (1 if index % 2 == 0 else 2)
        total += product // 36 + product % 36
    return ID_CHARS[(36 - total % 36) % 36]


def pan_entity_type(value):
    if len(value) < 4:
        return "unknown"
    return PAN_ENTITY_TYPES.get(value[3], "unknown")


def idcheck_command(args):
    country = (args.country or "").upper()
    id_type = (args.id_type or "").lower()
    value = (args.value or "").strip().upper()
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "country_capabilities.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            caps = json.load(handle)
    except (OSError, ValueError):
        return {"status": "unavailable", "error": "capabilities-unreadable"}
    entry = (caps.get("countries") or {}).get(country.lower()) or {}
    rule = next((item for item in entry.get("id_formats") or [] if (item.get("type") or item.get("id_type")) == id_type), None)
    if not rule or not value:
        return {
            "status": "no-rule",
            "command": "idcheck",
            "country": country,
            "type": id_type,
            "masked": mask_id(value),
            "format_ok": None,
            "checksum_ok": None,
            "entity_type": None,
            "name_suffix_consistent": None,
            "notes": ["暂无已核对的格式规则"],
            "mode": "offline",
            "rule_verification": None,
        }
    pattern = rule.get("pattern") or rule.get("regex")
    try:
        format_ok = bool(re.fullmatch(pattern, value)) if pattern else None
    except re.error:
        return {"status": "invalid-input", "command": "idcheck", "error": "invalid-regex"}
    checksum_ok = None
    entity_type = None
    notes = []
    state_code = None
    if format_ok is False:
        checksum_ok = False
        notes.append("format-invalid")
    elif id_type == "gstin":
        if len(value) != 15 or value[13] != "Z":
            checksum_ok = False
            notes.append("position-14-not-z")
        else:
            checksum_ok = gstin_checksum(value) == value[-1]
        entity_type = pan_entity_type(value[2:12])
        state_code = value[:2]
        state_name = GST_STATE_CODES.get(state_code)
        if not state_name:
            notes.append("state-code-unknown")
        elif args.claimed_state and normalize_company(args.claimed_state) != normalize_company(state_name):
            notes.append("state-mismatch")
    elif id_type == "pan":
        entity_type = pan_entity_type(value)
    company = (args.company_name or "").strip()
    name_suffix_consistent = None
    if company and entity_type:
        corporate = any(token in normalize_company(company) for token in ("PVT", "PRIVATE", "LTD", "LIMITED", "CORP", "COMPANY"))
        firm = any(token in normalize_company(company) for token in ("LLP", "PARTNERSHIP", "FIRM"))
        trust = "TRUST" in normalize_company(company)
        if entity_type == "company" and not corporate:
            name_suffix_consistent = False
        elif entity_type == "individual" and corporate:
            name_suffix_consistent = False
        elif entity_type == "firm/LLP" and (corporate or not firm):
            name_suffix_consistent = False
        elif entity_type == "trust" and not trust:
            name_suffix_consistent = False
        else:
            name_suffix_consistent = True
    return {
        "status": "ok",
        "command": "idcheck",
        "country": country,
        "type": id_type,
        "masked": mask_id(value),
        "format_ok": format_ok,
        "checksum_ok": checksum_ok,
        "entity_type": entity_type,
        "name_suffix_consistent": name_suffix_consistent,
        "state_code": state_code,
        "notes": notes,
        "mode": "offline",
        "rule_verification": rule.get("verification") or "unverified",
    }


MATCH_KEY_TYPES = ("legal_name", "alias", "address", "tax_id_masked", "phone", "domain", "person_name", "registration_no")


def normalize_match_value(key, value):
    raw = "" if value is None else str(value).strip().lower()
    if key == "phone":
        return re.sub(r"\D", "", raw)
    if key == "domain":
        return raw.replace("www.", "", 1)
    if key in ("tax_id_masked", "registration_no"):
        return re.sub(r"[^0-9a-z]", "", raw)
    return re.sub(r"\s+", " ", re.sub(r"[^0-9a-z\u4e00-\u9fff ]", "", raw)).strip()


def load_match_keys(payload):
    if isinstance(payload, dict):
        return [(key, payload[key], payload.get("alias_source") if key == "alias" else None) for key in MATCH_KEY_TYPES if key in payload]
    if isinstance(payload, list):
        return [(item.get("key"), item.get("value"), item.get("alias_source") if item.get("key") == "alias" else None) for item in payload if isinstance(item, dict) and item.get("key") in MATCH_KEY_TYPES]
    return []


def match_command(args):
    try:
        with open(args.buyer_json, "r", encoding="utf-8") as handle:
            buyer = load_match_keys(json.load(handle))
        with open(args.candidate_json, "r", encoding="utf-8") as handle:
            candidate = load_match_keys(json.load(handle))
    except (OSError, ValueError, TypeError):
        return {"status": "invalid-input", "error": "invalid match input"}
    buyer_map = {key: normalize_match_value(key, value) for key, value, _ in buyer if value is not None}
    candidate_map = {key: normalize_match_value(key, value) for key, value, _ in candidate if value is not None}
    buyer_alias = next((source for key, _, source in buyer if key == "alias"), None)
    candidate_alias = next((source for key, _, source in candidate if key == "alias"), None)
    keys = sorted(key for key in buyer_map if key in candidate_map and buyer_map[key] and buyer_map[key] == candidate_map[key])
    if "alias" in keys and not (buyer_alias == "official" and candidate_alias == "official"):
        keys = [key for key in keys if key != "alias"]
    name_keys = {"legal_name", "alias", "person_name"}
    strong_keys = {"address", "tax_id_masked", "phone", "domain", "registration_no"}
    matched = (bool(name_keys & set(keys)) and bool(strong_keys & set(keys))) or ("domain" in keys and "phone" in keys)
    if not matched:
        reason = "only-name" if set(keys) <= name_keys else "fewer-than-two-independent-keys"
        strength = "weak"
    elif len(keys) >= 3 or (bool(name_keys & set(keys)) and any(key in keys for key in ("registration_no", "tax_id_masked"))):
        reason = "name-plus-strong-key" if name_keys & set(keys) else "domain-plus-phone"
        strength = "strong"
    else:
        reason = "name-plus-other" if name_keys & set(keys) else "domain-plus-phone"
        strength = "medium"
    return {"status": "ok", "matched": matched, "keys_matched": keys, "strength": strength, "reason": reason}


def keywords_command(args):
    text_value = (args.text or "").lower()
    languages = [item.strip() for item in (args.languages or "en").split(",") if item.strip()]
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "country_capabilities.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            caps = json.load(handle)
    except (OSError, ValueError):
        return {"status": "unavailable", "error": "capabilities-unreadable"}
    groups = caps.get("multilingual_keywords") or {}
    matches = []
    for language in languages:
        for probe, words in (groups.get(language) or {}).items():
            for word in words:
                if word.lower() in text_value:
                    matches.append({"language": language, "probe": probe, "keyword": word})
    return {"status": "ok", "matches": matches, "languages": languages, "meta": groups.get("meta")}


def pdf_date(value):
    match = re.match(r"D:(\d{4})(\d{2})(\d{2})", value or "")
    if not match:
        return None
    return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"


def pdf_info_text(value):
    return (value or "").replace("\\(", "(").replace("\\)", ")").strip()


def docmeta_command(args):
    path = args.file
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError:
        return {"status": "unreadable", "doc_checks": []}
    if not data.startswith(b"%PDF"):
        return {"status": "unreadable", "doc_checks": []}
    text = data.decode("latin-1", errors="ignore")

    def field(name):
        match = re.search(r"/" + name + r"\s*(?:\(([^)]*)\)|<([0-9A-Fa-f]+)>)", text)
        if not match:
            return None
        return pdf_info_text(match.group(1) if match.group(1) is not None else match.group(2))

    creator = field("Creator")
    producer = field("Producer")
    incremental_updates = max(0, text.count("%%EOF") - 1)
    creation = pdf_date(field("CreationDate"))
    modified = pdf_date(field("ModDate"))
    count = re.search(r"/Count\s+(\d+)", text)
    software = " ".join(item for item in (creator, producer) if item).lower()
    if any(token in software for token in ("photoshop", "canva", "illustrator", "indesign")):
        creator_class = "design"
    elif any(token in software for token in ("word", "excel", "powerpoint", "office")):
        creator_class = "office"
    elif any(token in software for token in ("scan", "scansnap", "epson")):
        creator_class = "scan"
    elif creator or producer:
        creator_class = "other"
    else:
        creator_class = "unknown"
    dates_consistent = None
    notes = []
    if creation and args.claimed_date:
        try:
            age = (dt.date.fromisoformat(creation) - dt.date.fromisoformat(args.claimed_date)).days
            dates_consistent = not (age > 30)
        except ValueError:
            dates_consistent = None
    if dates_consistent is False:
        notes.append("存在可解释的差异（创建日期与自称签发日期相差超过 30 天）")
    elif dates_consistent is True:
        notes.append("未见矛盾")
    else:
        notes.append("元数据不完整或已重写；仅提示，不计分")
    return {
        "status": "ok",
        "doc_checks": [{
            "type": "pdf",
            "file_name": os.path.basename(path),
            "creator_class": creator_class,
            "creation_date": creation,
            "modification_date": modified,
            "pages": int(count.group(1)) if count else None,
            "incremental_updates": incremental_updates,
            "dates_consistent": dates_consistent,
            "notes": notes,
        }],
    }


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

    registry = sub.add_parser("registry", help="look up a company in the Norwegian Enhetsregisteret (NLOD 2.0)")
    registry.add_argument("--company")
    registry.add_argument("--country", default="NO")
    registry.add_argument("--claimed-country")
    registry.add_argument("--online", action="store_true")
    registry.add_argument("--fixture-json")
    registry.add_argument("--timeout", type=int, default=10)

    country = sub.add_parser("country", help="return a country capability profile or discovery templates")
    country.add_argument("--code")
    country.add_argument("--validate", action="store_true")

    idcheck = sub.add_parser("idcheck", help="offline tax/registration ID format and checksum check")
    idcheck.add_argument("--country", required=True)
    idcheck.add_argument("--type", dest="id_type", required=True)
    idcheck.add_argument("--value", required=True)
    idcheck.add_argument("--company-name", dest="company_name")
    idcheck.add_argument("--claimed-state", dest="claimed_state")

    match = sub.add_parser("match", help="deterministic entity matching gate")
    match.add_argument("--buyer-json", required=True)
    match.add_argument("--candidate-json", required=True)

    keywords = sub.add_parser("keywords", help="match multilingual footprint keywords")
    keywords.add_argument("--text", required=True)
    keywords.add_argument("--languages", default="en")

    docmeta = sub.add_parser("docmeta", help="read PDF metadata without OCR or third-party libraries")
    docmeta.add_argument("--file", required=True)
    docmeta.add_argument("--claimed-date")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "site":
        result = site_command(args)
    elif args.command == "backlink":
        result = backlink_command(args)
    elif args.command == "map":
        result = map_command(args)
    elif args.command == "registry":
        result = registry_command(args)
    elif args.command == "country":
        result = country_command(args)
    elif args.command == "idcheck":
        result = idcheck_command(args)
    elif args.command == "match":
        result = match_command(args)
    elif args.command == "keywords":
        result = keywords_command(args)
    elif args.command == "docmeta":
        result = docmeta_command(args)
    else:
        result = image_command(args)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("status") in ("ok", "found", "not-found", "ambiguous", "offline", "not-in-matrix", "no-rule") else 1


if __name__ == "__main__":
    sys.exit(main())
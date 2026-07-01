"""
Location resolution + work-mode classification for ingest (L1).

geocode_records(cur, records): for a batch of JobRecords, resolve each free-text
`location` to (lat, lng, country_iso, geonameid) via the cf_resolve_location()
gazetteer function (one round-trip for all distinct locations), and classify the
work-mode axis (workplace_type + allowed_countries). Sets the 6 geo fields IN
PLACE. The raw `location` string is NEVER touched here -- it feeds dedup_key and
the embedding blob, so re-normalizing it there would fork dedup / churn vectors.
"""
import re
from typing import Dict, List, Optional, Tuple

# Country name / code -> ISO-3166 alpha-2. Two jobs:
#  (a) a country HINT when geocoding an ambiguous job-location string
#      ("Cambridge, MA, USA" -> US so cf_resolve_location doesn't pick Cambridge UK);
#  (b) remote ELIGIBILITY parsing ("Remote - US only" -> ['US']).
# Curated to the markets CareerForge actually sees; extend freely. Bare 2-letter
# codes are included for exact-segment hints but kept OUT of the free-text scan
# (below) so "in"/"is"/"it" don't false-match.
COUNTRY_ISO = {
    "usa": "US", "u.s.a": "US", "u.s.a.": "US", "u.s": "US", "u.s.": "US",
    "united states": "US", "united states of america": "US", "america": "US",
    "uk": "GB", "u.k": "GB", "u.k.": "GB", "united kingdom": "GB", "england": "GB",
    "britain": "GB", "great britain": "GB", "scotland": "GB", "wales": "GB",
    "india": "IN", "bharat": "IN",
    "canada": "CA", "australia": "AU", "germany": "DE", "deutschland": "DE",
    "france": "FR", "ireland": "IE", "netherlands": "NL", "holland": "NL",
    "spain": "ES", "italy": "IT", "poland": "PL", "portugal": "PT", "sweden": "SE",
    "switzerland": "CH", "singapore": "SG", "japan": "JP", "china": "CN",
    "brazil": "BR", "mexico": "MX", "israel": "IL", "uae": "AE",
    "united arab emirates": "AE", "u.a.e": "AE", "new zealand": "NZ",
    "south africa": "ZA", "philippines": "PH", "indonesia": "ID", "vietnam": "VN",
    "argentina": "AR", "colombia": "CO", "chile": "CL", "nigeria": "NG", "egypt": "EG",
    "turkey": "TR", "ukraine": "UA", "romania": "RO", "austria": "AT", "belgium": "BE",
    "denmark": "DK", "finland": "FI", "norway": "NO", "greece": "GR", "czechia": "CZ",
    "czech republic": "CZ", "hungary": "HU", "south korea": "KR", "korea": "KR",
    "hong kong": "HK", "taiwan": "TW", "malaysia": "MY", "thailand": "TH",
    "saudi arabia": "SA", "kenya": "KE", "pakistan": "PK", "bangladesh": "BD",
    "sri lanka": "LK",
    # ISO-3 alpha codes (Workday "USA"/"IND"/"GBR" strings). SAFE -- 3 letters never
    # collide with US state codes. Word-like ones (can/are/nor) omitted.
    "ind": "IN", "gbr": "GB", "aus": "AU", "deu": "DE", "fra": "FR", "irl": "IE",
    "nld": "NL", "esp": "ES", "ita": "IT", "pol": "PL", "prt": "PT", "swe": "SE",
    "che": "CH", "sgp": "SG", "jpn": "JP", "chn": "CN", "bra": "BR", "mex": "MX",
    "isr": "IL", "nzl": "NZ", "zaf": "ZA", "phl": "PH", "idn": "ID", "vnm": "VN",
    "arg": "AR", "col": "CO", "chl": "CL", "nga": "NG", "egy": "EG", "tur": "TR",
    "ukr": "UA", "rou": "RO", "aut": "AT", "bel": "BE", "dnk": "DK", "fin": "FI",
    "grc": "GR", "cze": "CZ", "hun": "HU", "kor": "KR", "hkg": "HK", "twn": "TW",
    "mys": "MY", "tha": "TH", "sau": "SA", "ken": "KE", "pak": "PK", "bgd": "BD",
    "lka": "LK",
    # NOTE: bare 2-letter ISO codes are deliberately NOT included -- they collide with US
    # state codes ("CA"=California/Canada, "IN"=Indiana/India, "DE"=Delaware/Germany). Only
    # full names + the safe short forms (below: us/usa/uk/uae) are treated as countries.
    "us": "US", "uk": "GB", "gb": "GB",
}

# Free-text country scan: full names + only the UNAMBIGUOUS short forms. Bare
# 2-letter codes ("in","is","it","no"...) are deliberately excluded.
# "us"/"uk" are safe here because _countries_in only ever scans the short, structured
# `location` field (never a prose JD), so "join us" can't leak in.
_SCAN_TERMS = sorted(
    [k for k in COUNTRY_ISO if len(k) >= 4] + ["uk", "us", "usa", "uae"],
    key=len, reverse=True,
)
_COUNTRY_RX = re.compile(r"\b(" + "|".join(re.escape(k) for k in _SCAN_TERMS) + r")\b", re.I)
_REMOTE_RX = re.compile(r"\b(remote|work\s*from\s*home|wfh|distributed|anywhere|telecommut)", re.I)
_HYBRID_RX = re.compile(r"\bhybrid\b", re.I)
_NONALNUM = re.compile(r"[^a-z0-9]+")


def country_for(token: str) -> Optional[str]:
    """An exact location segment ('USA', 'India', 'GB') -> ISO-2, else None."""
    if not token:
        return None
    t = token.strip().lower()
    return COUNTRY_ISO.get(t) or COUNTRY_ISO.get(t.strip(".")) or COUNTRY_ISO.get(_NONALNUM.sub("", t))


_SEG_SPLIT = re.compile(r"[,;/|>:()\-]")

# US state 2-letter codes -> US. Last-resort hint when no country was found and a segment is
# exactly a state code ("IN - Work from home" = Indiana -> US). Mirrors cf_resolve_location pri5.
# COLLISION: bare "IN"/"TN" -> US (not India/Tamil Nadu); India jobs carry a city or full name.
US_STATE_CODES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
    "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT",
    "VA", "WA", "WV", "WI", "WY", "DC",
}


def location_country_hint(location: str) -> Optional[str]:
    """Country hint from a job-location string. Splits on delimiters [,;/|>:()-]
    (Workday 'United States-Arizona-Chandler', 'United States (Remote)') AND on
    whitespace (3-letter ISO 'IND BNGL ...'), checking each segment/token against
    the country map. 'Cambridge, MA, USA' -> 'US'; 'Bengaluru, Karnataka, India' -> 'IN'."""
    if not location:
        return None
    segs = [s.strip() for s in _SEG_SPLIT.split(location) if s.strip()]
    for seg in reversed(segs):           # delimiter segments, last-first (country usually trails)
        cc = country_for(seg)
        if cc:
            return cc
    for tok in location.split():         # whitespace tokens (catches bare ISO-3 codes)
        cc = country_for(tok)
        if cc:
            return cc
    for seg in segs:                     # last resort: bare US state code -> US (mirror of pri5)
        if seg.upper() in US_STATE_CODES:
            return "US"
    return None


def _countries_in(text: str) -> List[str]:
    out: List[str] = []
    for m in _COUNTRY_RX.finditer(text or ""):
        cc = COUNTRY_ISO.get(m.group(1).lower())
        if cc and cc not in out:
            out.append(cc)
    return out


def classify_workplace(location: str, title: str, remote: Optional[bool]) -> Tuple[Optional[str], Optional[List[str]]]:
    """Work-mode axis -> (workplace_type, allowed_countries).
      workplace_type: 'remote' | 'hybrid' | 'onsite' | None
      allowed_countries: ISO-2 list scoping a REMOTE role; None = worldwide.
    The provider's structured `remote` bool is the strongest signal; text is the
    fallback and the only source of 'hybrid' + the allowed-country scope."""
    blob = f"{location or ''} {title or ''}"
    if _HYBRID_RX.search(blob):
        wt = "hybrid"
    elif remote is True or _REMOTE_RX.search(blob):
        wt = "remote"
    elif remote is False or (location or "").strip() or (title or "").strip():
        wt = "onsite"
    else:
        wt = None
    allowed = _countries_in(location) if wt == "remote" else []
    return wt, (allowed or None)


def geocode_records(cur, records) -> None:
    """Resolve place + classify work-mode for a batch, in place. One round-trip
    resolves all distinct locations via cf_resolve_location() with per-location
    country hints (so ambiguous city names land in the right country)."""
    locs = sorted({(r.location or "").strip() for r in records if (r.location or "").strip()})
    resolved: Dict[str, tuple] = {}
    if locs:
        cur.execute(
            """
            SELECT u.loc, r.lat, r.lng, r.country_iso, r.geonameid
            FROM unnest(%s::text[]) WITH ORDINALITY AS u(loc, ord)
            LEFT JOIN LATERAL cf_resolve_location(u.loc) r ON true
            """,
            (locs,),
        )
        for loc, lat, lng, cc, gid in cur.fetchall():
            resolved[loc] = (lat, lng, cc, gid)
    for r in records:
        lat, lng, cc, gid = resolved.get((r.location or "").strip(), (None, None, None, None))
        r.lat, r.lng, r.geonameid = lat, lng, gid
        wt, allowed = classify_workplace(r.location, r.title, r.remote)
        if r.workplace_type is None:        # preserve a provider-set explicit work-mode (e.g. MS workLocationOption)
            r.workplace_type = wt
        if r.allowed_countries is None:
            r.allowed_countries = allowed
        # country: prefer the resolved place; else the text hint (covers "Remote, US"
        # and unresolved-but-country-named strings); else NULL (e.g. bare "Remote").
        r.country_iso = cc or location_country_hint(r.location)

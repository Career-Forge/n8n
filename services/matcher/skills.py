"""
Skill vocabulary + literal skill matchers — shared by the matcher (/match,
/extract_skills) and the ingestion path (skills extracted on upsert).

Lifted out of app.py so db.py can extract skills without importing app (which
would create a cycle: app -> db -> app). Behavior is identical to the original.
"""
import os
import re
import json
from typing import List

HERE = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(HERE, "skills_vocab.json"), "r", encoding="utf-8") as f:
    VOCAB = {k: v for k, v in json.load(f).items() if not k.startswith("_")}


def _term_regex(term: str):
    # match term as a standalone token; skip ambiguous short tokens (len<3, no symbol)
    if len(term) < 3 and not re.search(r"[^A-Za-z0-9]", term):
        return None
    return re.compile(r"(?<![A-Za-z0-9])" + re.escape(term) + r"(?![A-Za-z0-9])", re.IGNORECASE)


SKILL_MATCHERS = []  # (canonical, [compiled regexes])
for _canonical, _aliases in VOCAB.items():
    _pats = []
    for _term in [_canonical] + list(_aliases):
        _rx = _term_regex(_term)
        if _rx is not None:
            _pats.append(_rx)
    if _pats:
        SKILL_MATCHERS.append((_canonical, _pats))


def extract_skills(text: str) -> List[str]:
    if not text:
        return []
    found = []
    for canonical, pats in SKILL_MATCHERS:
        if any(p.search(text) for p in pats):
            found.append(canonical)
    return found

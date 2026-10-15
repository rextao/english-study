#!/usr/bin/env python3
"""从 Cambridge 2025 Young Learners PDF 的 A–Z 词表生成三个 JSON 词库。"""

import argparse
import json
import re
from pathlib import Path

from pypdf import PdfReader

POS = r"adj|adv|conj|det|dis|excl|int|n|poss|prep|pron|v|title"
ENTRY_RE = re.compile(rf"(?P<word>[A-Za-z][A-Za-z0-9'’/() .-]*?)\s+(?P<pos>{POS}(?:\s*\+\s*(?:{POS}))*)(?=\s+[A-Za-z]|\s*$)")
PAGE_RE = re.compile(r"^(?:\d+\s+)?(?:Pre A1 Starters|A1 Movers|A2 Flyers) A[–-]Z wordlist\s*\d*$")
SKIP = {
    "Grammatical key", "adj adjective", "adv adverb", "conj conjunction",
    "det determiner", "dis discourse marker", "excl exclamation",
    "int interrogative", "n noun", "poss possessive", "prep preposition",
    "pron pronoun", "v verb", "Numbers", "Names",
}


def normalize(value: str) -> str:
    value = value.replace("\u00a0", " ").replace("’", "'").replace("–", "-")
    return re.sub(r"\s+", " ", value).strip()


def parse_pages(reader: PdfReader, pages: range) -> list[dict]:
    found: dict[str, dict] = {}
    for page_no in pages:
        in_names = False
        for raw in (reader.pages[page_no].extract_text() or "").splitlines():
            line = normalize(raw)
            if not line or PAGE_RE.match(line) or line in SKIP or len(line) == 1 and line.isupper():
                continue
            if line in {"Letters & numbers", "Names"}:
                in_names = True
                continue
            if in_names:
                continue
            if line in {"Candidates will be expected to understand and write numbers 21-100 and ordinals 1st-20th.",
                        "Candidates will be expected to understand and write numbers 101-1,000 and ordinals 21st-31st."}:
                continue
            if line.startswith("Candidates will be expected") or line.startswith("Pre A1 Starters A1 Movers"):
                continue
            matches = list(ENTRY_RE.finditer(line))
            if not matches and line == "a.m. (for time)":
                matches = [None]
            for match in matches:
                if match is None:
                    word, pos = line, []
                else:
                    word = normalize(match.group("word"))
                    pos = [item.strip() for item in re.split(r"\s*\+\s*", match.group("pos"))]
                if not re.search(r"[A-Za-z]", word) or len(word) > 80:
                    continue
                key = word.lower()
                if key not in found:
                    found[key] = {"word": word, "pos": pos, "examples": []}
                else:
                    found[key]["pos"] = sorted(set(found[key]["pos"] + pos))
    return list(found.values())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    reader = PdfReader(str(args.pdf))
    specs = [
        ("cambridge-pre-a1-starters-2025", "Cambridge Pre A1 Starters", "Pre-A1", range(3, 7)),
        ("cambridge-a1-movers-2025", "Cambridge A1 Movers", "A1", range(7, 11)),
        ("cambridge-a2-flyers-2025", "Cambridge A2 Flyers", "A2", range(11, 15)),
    ]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for ident, name, level, pages in specs:
        words = parse_pages(reader, pages)
        payload = {
            "id": ident,
            "name": name + " Vocabulary List",
            "level": level,
            "source": "Cambridge English (2025)",
            "description": name + " vocabulary list.",
            "words": words,
        }
        (args.output_dir / (ident + ".json")).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        print(ident, len(words))


if __name__ == "__main__":
    main()

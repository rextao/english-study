#!/usr/bin/env python3
"""
parse_a2_key.py
---------------
Parses the A2 Key 2020 Vocabulary List PDF raw text into the
unified vocab JSON format defined in vocab/format.md.

Prerequisites:
    pdftotext must be installed (part of poppler-utils):
        brew install poppler          # macOS
        apt install poppler-utils     # Debian/Ubuntu

Usage:
    # Step 1 – extract raw text from the PDF (only needed once):
    pdftotext -layout 506886-a2-key-2020-vocabulary-list.pdf _pdf_raw.txt

    # Step 2 – parse into JSON:
    python3 vocab/parse_a2_key.py

Input:  _pdf_raw.txt  (pdftotext output in the project root)
Output: vocab/a2-key-2020.json
"""

import json
import re
import sys
from pathlib import Path

BASE    = Path(__file__).parent.parent   # project root
RAW_TXT = BASE / "_pdf_raw.txt"
OUT_JSON = Path(__file__).parent / "a2-key-2020.json"

# ── Regexes ──────────────────────────────────────────────────────────────────

# A word entry line looks like:  "word text (pos stuff)"
# The word part may contain spaces, slashes, dots (e.g. "a.m.", "a/an", "wake up")
# POS is inside parentheses and may contain &, ,, spaces
WORD_LINE_RE = re.compile(
    r"""^
    (?P<word>[A-Za-z][^()*]*?)   # word / phrase (no parens)
    \s*
    \((?P<pos>[^)]+)\)           # (pos)
    \s*\.?\s*$""",
    re.VERBOSE,
)

EXAMPLE_RE  = re.compile(r"^[•·●]\s*(.+)$")
PAGE_HDR_RE = re.compile(r"©\s*UCLES|Vocabulary List|A2 Key and Key for|^Schools$")
ALPHA_HDR_RE = re.compile(r"^[A-Z]$")


def parse_pos(raw: str) -> list[str]:
    """Split a raw POS string like 'adv & prep' into ['adv', 'prep']."""
    return [p.strip() for p in re.split(r"[&,]", raw) if p.strip()]


def parse_raw(text: str) -> list[dict]:
    """Extract vocabulary entries from the raw pdftotext output."""
    # Locate the alphabetical vocabulary section
    alpha_start = text.find("a/an (det)")
    appendix_start = text.find("Appendix 1", alpha_start)
    if appendix_start == -1:
        appendix_start = len(text)

    vocab_text = text[alpha_start:appendix_start]
    lines = vocab_text.splitlines()

    words: list[dict] = []
    current: dict | None = None

    def flush() -> None:
        if current is not None:
            words.append(current)

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        if PAGE_HDR_RE.search(line):
            continue
        if ALPHA_HDR_RE.match(line):
            continue

        # Example sentence / phrase
        ex_m = EXAMPLE_RE.match(line)
        if ex_m:
            if current is not None:
                current["examples"].append(ex_m.group(1).strip())
            continue

        # Word entry line
        w_m = WORD_LINE_RE.match(line)
        if w_m:
            flush()
            current = {
                "word": w_m.group("word").strip(),
                "pos": parse_pos(w_m.group("pos").strip()),
                "examples": [],
            }
            continue

        # Continuation of a broken example sentence (starts with lowercase)
        if current is not None and current["examples"] and line[0].islower():
            current["examples"][-1] += " " + line

    flush()
    return words


def main() -> None:
    if not RAW_TXT.exists():
        print(f"Error: {RAW_TXT} not found.", file=sys.stderr)
        print(
            "Run: pdftotext -layout 506886-a2-key-2020-vocabulary-list.pdf _pdf_raw.txt",
            file=sys.stderr,
        )
        sys.exit(1)

    text = RAW_TXT.read_text(encoding="utf-8", errors="replace")
    words = parse_raw(text)

    vocab = {
        "id": "a2-key-2020",
        "name": "A2 Key Vocabulary List",
        "level": "A2",
        "source": "Cambridge English (UCLES 2025)",
        "description": (
            "The Cambridge A2 Key (KET) vocabulary list covering approximately "
            "1600+ words and phrases at CEFR A2 level. "
            "Alphabetical section only (Appendix word-sets excluded)."
        ),
        "words": words,
    }

    OUT_JSON.write_text(
        json.dumps(vocab, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Done — wrote {len(words)} words to {OUT_JSON}")


if __name__ == "__main__":
    main()

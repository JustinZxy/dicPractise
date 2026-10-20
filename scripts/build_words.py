#!/usr/bin/env python3
"""Parse the syllabus PDF and emit js/words.js for the spelling game."""

import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parent))
from syllables import syllabify

ROOT = Path(__file__).resolve().parents[1]
PDF = ROOT / "高考大纲词3500个（正序版）.pdf"
OUT = ROOT / "js" / "words.js"

# Two-piece cuts only. Pieces always concatenate to the exact spelling.
# A stem must itself be a syllabus word. Bound roots cover cuts such as
# tele+phone where the second piece is not a standalone entry.
SAFE_PREFIXES = [
    "counter", "extra", "inter", "micro", "multi", "over", "super", "trans",
    "under", "tele", "semi", "anti", "auto", "fore", "mis", "non", "pre",
    "sub", "dis", "out", "mid", "tri", "bio", "geo", "eco", "uni", "re",
    "un", "im", "in", "ir", "il",
]
SAFE_SUFFIXES = [
    "ation", "ition", "tion", "sion", "ment", "ness", "able", "ible", "ance",
    "ence", "ship", "hood", "ward", "ous", "ive", "ity", "ful", "less",
    "ism", "ist", "ize", "ise", "ing", "ant", "ent", "ary", "ory", "ion",
    "ly", "al", "er", "or", "ed", "ic", "en",
]
BOUND_ROOTS = {
    "logy", "graphy", "phone", "photo", "scope", "meter", "spect", "dict",
    "duct", "struct", "script", "rupt", "ject", "cept", "tract", "press",
    "vert", "vers", "graph", "therm", "chron", "hydro", "psych", "vision",
    "gress", "cycle", "nounce", "ology", "gram", "form", "port", "path",
}
# Orthographic accidents: the cut spells the word and misses the meaning.
BAD_SPLITS = {
    "apartment", "billion", "canal", "caption", "captain", "cater", "chicken",
    "early", "easter", "flower", "former", "forward", "legal", "listen",
    "indeed", "intend", "improve", "number", "offence", "offer", "panic",
    "pension", "passport", "preserve", "recent", "relate", "relay", "remain",
    "remark", "remember", "remind", "repair", "resign", "operation", "outer",
    "theory", "tension", "topic", "shoulder", "shower", "ripen", "salary",
    "several", "tailor", "station", "talent",     "fasten", "moment", "comment",
    "bishop", "notice", "season", "carpet", "legend",
    "fluent", "income", "insure", "discount", "pretend", "represent",
    "republic", "reserve", "retire", "reward", "unless",
}

# Longer tags first. Single-letter tags cannot swallow the start of "art".
POS_LONG = r"(?:interj|modal|abbr|prep|conj|pron|adv|adj|art|aux|int|vt|vi|ad|pl|num)"
POS_TOKEN = rf"(?:{POS_LONG}|[nva](?![A-Za-z]))"
POS_RE = re.compile(
    rf"^[\*（(）)\s]*((?:{POS_TOKEN})\.?(?:\s*[&/．,，、]\s*(?:{POS_TOKEN})\.?)*)",
    re.I,
)
IPA_LEAK = re.compile(r"[ˈˌɑæəɒɔɜɪʊʌθðʃʒŋɡ]")

MANUAL_WORDS = {3092: "silent", 3176: "soft"}


def extract_blocks():
    reader = PdfReader(str(PDF))
    lines = []
    for page in reader.pages:
        for line in (page.extract_text() or "").splitlines():
            line = line.strip()
            if not line or line.startswith("序号"):
                continue
            lines.append(line)
    blocks = []
    current = []
    for line in lines:
        if re.match(r"^\d+(\s|$)", line):
            if current:
                blocks.append(" ".join(current))
            current = [line]
        elif current:
            current.append(line)
    if current:
        blocks.append(" ".join(current))
    return blocks


def primary_spellings(raw):
    word = raw.strip().replace("’", "'").replace("‘", "'")
    word = word.replace("—", "-").replace("–", "-").replace("--", "-")
    word = re.sub(r"\s+", " ", word).strip(" .,")
    if not word or word.startswith("#"):
        return []
    if "(" in word:
        base = word.split("(", 1)[0].strip()
        extra = word[word.find("(") + 1:word.find(")")] if ")" in word else ""
        # afterward(s) keeps the longer spelling. a(an) does not become "aan".
        if extra.lower() in {"s", "es", "d", "ed", "r"}:
            return [base, base + extra]
        return [base] if base else []
    return [word]


def acceptable(spellings):
    good = []
    for spelling in spellings:
        letters = re.sub(r"[^A-Za-z]", "", spelling)
        if len(letters) < 3:
            continue
        if not re.fullmatch(r"[A-Za-z][A-Za-z' -]*", spelling):
            continue
        if spelling.isupper() and len(letters) <= 4:
            continue
        item = spelling.lower()
        if item not in good:
            good.append(item)
    return good


def clean_gloss(gloss):
    gloss = re.sub(r"\s+", " ", gloss).strip()
    # A broken phonetic sometimes leaks in front of the definition: "glɑːns/ vi."
    leak = re.match(r"^([^/]{1,24})/(.*)$", gloss)
    if leak and IPA_LEAK.search(leak.group(1)) and not POS_RE.match(leak.group(1)):
        gloss = leak.group(2).strip()
    gloss = re.sub(r"^[（(][^）)]*[）)]\s*", "", gloss)
    return gloss.strip()


def split_pos(gloss):
    gloss = clean_gloss(gloss)
    match = POS_RE.match(gloss)
    if not match:
        return "", gloss
    pos = re.sub(r"\s+", "", match.group(1).strip(" ."))
    if pos and pos[-1].isalpha():
        pos += "."
    meaning = gloss[match.end():].strip(" .;；,，、").lstrip(".")
    if not meaning:
        return "", gloss
    return pos, meaning


def parse_block(block):
    match = re.match(r"^(\d+)\s+(.*)$", block)
    if not match:
        return None
    number = int(match.group(1))
    rest = match.group(2).strip()
    phonetic = ""
    phone = re.search(r"/[^/]*/", rest)
    if phone:
        phonetic = phone.group(0)
        head = rest[:phone.start()].strip()
        gloss = rest[phone.end():].strip()
    elif "//" in rest:
        head, gloss = [part.strip() for part in rest.split("//", 1)]
    else:
        parts = rest.split()
        if not parts:
            return None
        head, gloss = parts[0], " ".join(parts[1:])
    if number in MANUAL_WORDS:
        head = MANUAL_WORDS[number]
    spellings = acceptable(primary_spellings(head))
    if not spellings:
        return None
    word = max(spellings, key=len)
    gloss = clean_gloss(gloss.replace("#VALUE!", ""))
    if not gloss:
        return None
    pos, meaning = split_pos(gloss)
    if phonetic in {"//", "/"}:
        phonetic = ""
    return {
        "id": number,
        "word": word,
        "phonetic": phonetic,
        "pos": pos,
        "meaning": meaning,
        "gloss": gloss,
    }


def choose_parts(word, vocab):
    """Return (pieces, mode). Root mode is only a clean two-piece cut."""
    if re.search(r"[^a-z]", word) or word in BAD_SPLITS:
        return list(word), "letter"

    suffix_cuts = []
    prefix_words = []
    prefix_roots = []
    compounds = []

    for suffix in SAFE_SUFFIXES:
        if word.endswith(suffix) and len(word) > len(suffix) + 2:
            stem = word[:-len(suffix)]
            if stem in vocab and stem != word:
                suffix_cuts.append([stem, suffix])
    for prefix in SAFE_PREFIXES:
        if word.startswith(prefix) and len(word) > len(prefix) + 2:
            stem = word[len(prefix):]
            if stem in vocab and stem != word:
                prefix_words.append([prefix, stem])
            elif stem in BOUND_ROOTS and len(stem) >= 4:
                prefix_roots.append([prefix, stem])

    short_ok = {
        "bag", "ball", "day", "man", "men", "room", "sun", "way", "out", "one",
        "bow", "box", "side", "work", "book", "yard", "time", "land", "wood",
        "fish", "bird", "ship", "boat", "port", "line", "mate",
    }
    for cut in range(3, len(word) - 2):
        left, right = word[:cut], word[cut:]
        if left not in vocab or right not in vocab or left == word or right == word:
            continue
        long_pair = len(left) >= 4 and len(right) >= 4
        short_pair = (len(left) >= 4 and right in short_ok) or (len(right) >= 4 and left in short_ok)
        if long_pair or short_pair:
            compounds.append([left, right])

    def prefer(options):
        return max(options, key=lambda parts: (max(len(p) for p in parts), min(len(p) for p in parts)))

    for group in (suffix_cuts, prefix_words, prefix_roots, compounds):
        if not group:
            continue
        best = prefer(group)
        if "".join(best) == word:
            return best, "root"
    spoken = syllabify(word)
    if spoken:
        return spoken, "sound"
    return list(word), "letter"


def main():
    parsed = []
    skipped = 0
    for block in extract_blocks():
        item = parse_block(block)
        if item:
            parsed.append(item)
        else:
            skipped += 1
    merged = {}
    for item in parsed:
        prev = merged.get(item["word"])
        if prev is None or len(item["gloss"]) > len(prev["gloss"]):
            if prev:
                item["id"] = min(item["id"], prev["id"])
            merged[item["word"]] = item
    # Short words stay available as stems (act + or) but are not practiced.
    vocab = {entry["word"] for entry in merged.values()}
    entries = [merged[key] for key in sorted(merged) if len(re.findall(r"[a-z]", key)) > 3]
    root_count = 0
    sound_count = 0
    for entry in entries:
        parts, mode = choose_parts(entry["word"], vocab)
        assert "".join(parts) == entry["word"], (entry["word"], parts)
        entry["mode"] = mode
        entry["parts"] = parts if mode in {"root", "sound"} else list(entry["word"])
        if mode == "root":
            root_count += 1
        elif mode == "sound":
            sound_count += 1
    words = [
        {
            "w": e["word"],
            "p": e["phonetic"],
            "pos": e["pos"],
            "m": e["meaning"],
            "g": e["gloss"],
            "mode": e["mode"],
            "parts": e["parts"] if e["mode"] in {"root", "sound"} else [],
        }
        for e in entries
    ]
    payload = {
        "lists": [
            {
                "id": "senior",
                "name": "高中",
                "source": PDF.name,
                "count": len(entries),
                "rootCount": root_count,
                "soundCount": sound_count,
                "words": words,
            }
        ]
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        "window.WORD_BANK = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(
        f"entries {len(entries)} root {root_count} sound {sound_count} "
        f"letter {len(entries) - root_count - sound_count} skipped {skipped}"
    )
    beautiful = next(entry for entry in entries if entry["word"] == "beautiful")
    print("beautiful", beautiful["mode"], " + ".join(beautiful["parts"]))
    short = [entry["word"] for entry in entries if len(re.findall(r"[a-z]", entry["word"])) <= 3]
    print("short leaked", short[:10], "count", len(short))


if __name__ == "__main__":
    main()

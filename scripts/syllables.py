"""Pronunciation cuts. Pieces always join back into the spelling."""

import re

ONSETS = sorted({
    "str", "spr", "scr", "spl", "squ", "thr", "shr", "sch",
    "ch", "sh", "th", "ph", "wh", "qu",
    "bl", "br", "cl", "cr", "dr", "fl", "fr", "gl", "gr", "pl", "pr", "tr",
    "sc", "sk", "sl", "sm", "sn", "sp", "st", "sw", "tw", "dw", "wr",
}, key=len, reverse=True)

# One sound, so they stay inside a single syllable.
TEAMS = {
    "eau", "iou", "ai", "ay", "au", "aw", "ea", "ee", "ei", "ey", "oa", "oe",
    "oi", "oy", "oo", "ou", "ow", "eu", "ew", "ui", "ue", "ie", "eo",
}

# These endings are one spoken syllable even though they contain two vowel letters.
ONE_SYLLABLE_END = ("cious", "tious", "tion", "sion", "ture", "cial", "tial", "sure")


def _vowel(word, index):
    char = word[index]
    if char == "u" and index > 0 and word[index - 1] == "q":
        return False
    if char == "y":
        return index != 0
    return char in "aeiou"


def _silent_e(word):
    if len(word) < 3 or not word.endswith("e"):
        return False
    if word[-2] in "aeiouy":
        return False
    if word.endswith("le") and len(word) >= 4 and word[-3] not in "aeiou":
        return False
    return True


def _split_hiatus(word, index, limit):
    """index points at the second vowel. True means it starts a new syllable."""
    pair = word[index - 1:index + 1]
    if pair in {"ia", "io", "iu"} and not word[index - 1:].startswith(("tion", "sion", "tial", "cial")):
        if word[max(0, index - 2):index + 2] in {"tion", "sion"}:
            return False
        return True
    # idea, area, video: a vowel team at the end is really two syllables
    # when another vowel already occurred.
    if pair in {"ea", "eo", "oe"} and index + 1 == limit:
        return any(_vowel(word, earlier) for earlier in range(index - 1))
    # create, complete: e + vowel + consonant + silent e
    if pair[0] == "e" and word.endswith("e") and _silent_e(word) and index + 1 < len(word) - 1:
        rest = word[index + 1:]
        if rest[0] not in "aeiou" and rest.endswith("e"):
            return True
    return False


def _groups(word):
    syllabic_le = word.endswith("le") and len(word) >= 4 and word[-3] not in "aeiouy"
    silent = _silent_e(word) and not syllabic_le
    limit = len(word) - 2 if syllabic_le else len(word) - 1 if silent else len(word)
    groups = []
    index = 0
    while index < limit:
        if not _vowel(word, index):
            index += 1
            continue
        end = index + 1
        while end < limit and _vowel(word, end):
            if _split_hiatus(word, end, limit):
                break
            pair = word[end - 1:end + 1]
            triple = word[end - 2:end + 1] if end - 2 >= index else ""
            glued = word[max(0, end - 2):end + 2]
            if triple in {"eau", "iou"} or pair in TEAMS or glued in {"tion", "sion", "tial", "cial"}:
                end += 1
                continue
            break
        groups.append((index, end))
        index = end
    if syllabic_le:
        groups.append((len(word) - 2, len(word)))
    return groups, silent


def _onset(cluster):
    # "esting" breaks as est-ing, not e-sting.
    if len(cluster) == 2 and cluster[0] == "s" and cluster[1] in "ptkc":
        return "s", cluster[1]
    for size in range(len(cluster), 0, -1):
        suffix = cluster[-size:]
        if suffix in ONSETS or (len(suffix) == 1 and suffix.isalpha() and suffix not in "aeiouy"):
            return cluster[:-size], suffix
    return cluster, ""


def _close_digraph(pieces):
    """moth-er rather than mo-ther: a digraph closes a short vowel."""
    fixed = pieces[:]
    for index in range(len(fixed) - 1):
        nxt = fixed[index + 1]
        for digraph in ("th", "ch", "sh", "ph", "wh"):
            if not nxt.startswith(digraph) or len(nxt) <= len(digraph):
                continue
            rest = nxt[len(digraph):]
            previous = fixed[index]
            short_vowel = previous[-1] in "aeiou" and (len(previous) == 1 or previous[-2] not in "aeiou")
            if short_vowel and re.fullmatch(r"[aeiou]r?", rest):
                fixed[index] += digraph
                fixed[index + 1] = rest
            break
    return fixed


def syllabify(word):
    """Return spoken chunks, or None when the word is one syllable."""
    if not re.fullmatch(r"[a-z]+", word) or len(word) < 4:
        return None
    ending = ""
    stem = word
    for suffix in ONE_SYLLABLE_END:
        if word.endswith(suffix) and len(word) - len(suffix) >= 2 and re.search(r"[aeiouy]", word[:-len(suffix)]):
            ending = suffix
            stem = word[:-len(suffix)]
            break
    groups, silent = _groups(stem)
    if len(groups) + (1 if ending else 0) < 2:
        return None
    pieces = []
    for number, (start, end) in enumerate(groups):
        if number == 0:
            pieces.append(stem[:end])
            continue
        previous = groups[number - 1][1]
        coda, onset = _onset(stem[previous:start])
        if coda:
            pieces[-1] += coda
        pieces.append(onset + stem[start:end])
    if pieces:
        tail_end = len(stem) - 1 if silent else len(stem)
        leftover = stem[groups[-1][1]:tail_end]
        if leftover:
            pieces[-1] += leftover
    if silent and pieces:
        pieces[-1] += "e"
    if ending:
        pieces.append(ending)
    pieces = _close_digraph(pieces)
    if "".join(pieces) != word or len(pieces) < 2:
        return None
    if any(not re.search(r"[aeiouy]", piece) for piece in pieces):
        return None
    return pieces

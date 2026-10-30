"""Caption files the platform itself provides, as timed segments.

TikTok names caption languages like `deu-DE` or `eng-US`; transcripts made
here carry two-letter codes. Both end up as the two-letter code, and the
platform's own name is kept next to it.
"""

from __future__ import annotations

import json
import re

_ISO3 = {
    "deu": "de", "ger": "de", "eng": "en", "fra": "fr", "fre": "fr", "spa": "es", "ita": "it",
    "por": "pt", "nld": "nl", "dut": "nl", "pol": "pl", "tur": "tr", "rus": "ru", "ukr": "uk",
    "ara": "ar", "jpn": "ja", "kor": "ko", "cmn": "zh", "zho": "zh", "chi": "zh", "hin": "hi",
    "ind": "id", "vie": "vi", "tha": "th", "swe": "sv", "dan": "da", "nor": "no", "fin": "fi",
    "ces": "cs", "cze": "cs", "ell": "el", "gre": "el", "heb": "he", "ron": "ro", "rum": "ro", "hun": "hu",
}

_TIME = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})")


def language(code: str | None) -> str | None:
    if not code:
        return None
    head = re.split(r"[-_]", code.strip().lower())[0]
    return _ISO3.get(head, head)


def _ms(stamp: str) -> int:
    m = _TIME.search(stamp)
    if not m:
        raise ValueError(f"not a timestamp: {stamp!r}")
    h, mnt, s, frac = m.groups()
    return ((int(h or 0) * 60 + int(mnt)) * 60 + int(s)) * 1000 + int(frac.ljust(3, "0")[:3])


def _clean_text(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)  # <c>, <00:00:01.000>, <i>
    return re.sub(r"\s+", " ", text).strip()


def parse(data: str, ext: str) -> list[dict]:
    """Segments `{start_ms, end_ms, text}` from VTT, SRT or TikTok's creator JSON."""
    if ext == "json":
        body = json.loads(data)
        lines = body.get("utterances") or body.get("captions") or []
        return [
            {"start_ms": int(u["start_time"]), "end_ms": int(u["end_time"]), "text": _clean_text(u["text"])}
            for u in lines if u.get("text")
        ]
    segments = []
    for block in re.split(r"\r?\n\s*\r?\n", data.replace("﻿", "")):
        lines = [l for l in block.splitlines() if l.strip()]
        for i, line in enumerate(lines):
            if "-->" in line:
                start, end = line.split("-->", 1)
                text = _clean_text(" ".join(lines[i + 1:]))
                if text:
                    segments.append({"start_ms": _ms(start), "end_ms": _ms(end.split()[0]), "text": text})
                break
    # Rolling captions repeat the previous line as the first one of the next cue.
    out = []
    for seg in segments:
        if out and seg["text"] == out[-1]["text"]:
            out[-1]["end_ms"] = max(out[-1]["end_ms"], seg["end_ms"])
        else:
            out.append(seg)
    return out

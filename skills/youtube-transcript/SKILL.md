---
name: youtube-transcript
description: Get YouTube transcripts — one video, a whole playlist (up to 100 videos) or the top results of a search. Use when the user pastes a YouTube link, asks what a video says, wants videos summarised, compared or mined for something, or types /youtube-transcript.
argument-hint: <video link | playlist link | search phrase>
allowed-tools: mcp__plugin_youtube-transcript_youtube-transcript__get_youtube_transcript
---

# YouTube transcripts

The user wants transcripts for: $ARGUMENTS

Everything runs on this machine through the plugin's MCP tool `get_youtube_transcript` — no
account, no API key, no server of anyone else's.

## Pick the mode from what the user gave

- A video link (`watch?v=…`, `youtu.be/…`, `shorts/…`) or a bare 11-character ID → `url_type: "video"`.
- A playlist link (has `list=`, no `v=`) → `url_type: "playlist"`.
- A link that has both `v=` and `list=` → ask which one they mean. Do not guess.
- Plain words → `url_type: "search"`, with the words as `youtube_url`.

Ask for nothing else. Use `language` only if the user named one, and `max_videos` only if
they named a number (a playlist reads 25 by default, a search 10; a playlist can be read up
to 100).

## One video

The transcript comes back in the answer. Do what the user asked with it — summarise, answer a
question about it, quote it. If they only pasted a link with no request, give a short summary
and offer the full text.

## A playlist or a search

Many videos are read in one run, so the text does not come back in the answer. It is written
to files, one `<videoId>.txt` per video in `yt_transcripts/` of the current directory (or the
folder the user names in `save_to`), and the answer is an index: title, author, length and
whether a video was skipped, with the reason.

- Tell the user right away that a run of many videos takes a few minutes, then make the call
  once. Do not start a second call while the first one is running.
- Show them the index as a short list (title, author, length), not the raw JSON, and say where
  the files are.
- Read only the files the user's question needs. A hundred transcripts do not fit into one
  conversation; search the folder (`grep`) or read the few files that matter.
- Videos without captions are listed with `skipped: true`. Report how many, not each one,
  unless they ask.

## When something goes wrong

- **The answer says Docker is not running:** runs of many videos go through Cloudflare WARP,
  a free proxy that the plugin starts by itself in Docker, because YouTube refuses a plain IP
  after a handful of videos in a row. Ask the user to start Docker Desktop and try again.
  Nothing else has to be installed.
- **`stoppedEarly` is set:** YouTube blocked the run part-way. The files that were written are
  good; say how many arrived and offer to retry the rest a bit later.
- **A single video says it is unavailable or has no captions:** believe it and tell the user;
  do not retry.
- For checks and for adding the tool to other AI apps, use `/youtube-transcript:setup`.

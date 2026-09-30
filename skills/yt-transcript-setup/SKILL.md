---
name: yt-transcript-setup
description: Check or repair the YouTube transcript tool — test whether YouTube answers from this machine, check or start the free Cloudflare WARP proxy (and Docker for it), and register the server in Codex, Grok Build, Cursor or Antigravity. Use for /yt-transcript-setup, when transcripts fail with a bot check or a Docker message (/yt-transcript runs these steps by itself), or when the user wants the tool in their other AI apps.
---

# YouTube transcript tool — checks and setup

The plugin already ships the MCP server and starts it itself, so nothing needs to be
installed for Claude Code. This skill is for the things left over: a blocked IP, Docker
that is not running, and the user's other AI apps. `/yt-transcript` follows the first two
steps below on its own when a transcript fails; the person does not have to ask for it.

The command below is the server's own CLI:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/youtube-transcript-mcp.mjs" <command>
```

## Diagnose first

Run `doctor`. It prints the Node version, the proxy in use, whether a test transcript
comes through, and which AI apps it found on this machine. Read its output before
changing anything.

## Cloudflare WARP and Docker

Playlists and searches read many videos, and YouTube refuses a plain IP after a handful in
a row. So the server sends them through Cloudflare WARP, a free proxy in a Docker container
that it starts by itself. A single video goes out directly and only uses WARP when it is
blocked. On cloud servers, CI runners and some VPNs the block starts at the first request.

- `warp status` shows whether the container runs and whether traffic really leaves through
  Cloudflare. A container that runs but reports "not tunnelling" is broken; `warp start`
  restarts it.
- `warp start` brings it up ahead of time, `warp stop` removes it.
- **Docker is not running → start it yourself**: on Windows `Docker Desktop.exe` from
  `C:\Program Files\Docker\Docker`, on a Mac `open -a Docker`, on Linux
  `systemctl start docker`; wait up to two minutes until `docker info` answers. Only when
  Docker is not installed at all is there something the person has to do: install Docker
  Desktop. Without Docker a single video still works on most home connections.
- The user has an HTTP proxy of their own → set it as `YOUTUBE_TRANSCRIPT_PROXY`. The server
  then uses it as given and never starts WARP. SOCKS proxies are not supported.

## Add the tool to the user's other AI apps

`connect` writes the server into the configs of Codex, Grok Build, Cursor and Antigravity
if they are installed, keeping a backup of each file. Name the apps to limit it, e.g.
`connect cursor codex`. Tell the user which apps will be touched before running it, and
that they need to restart those apps afterwards.

## Other things this CLI can do

- `transcript <url|search phrase> [--text] [--language de] [--max-videos 5] [--save-to dir]`
  runs the same code as the MCP tool from the terminal — useful to prove the tool itself
  works.

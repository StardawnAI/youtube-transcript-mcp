---
name: setup
description: Check or repair the YouTube transcript tool — test whether YouTube answers from this machine, start the free Cloudflare WARP proxy when the IP is blocked, and register the server in Codex, Grok Build, Cursor or Antigravity. Use for /youtube-transcript:setup, when transcripts fail with a bot check, or when the user wants the tool in their other AI apps.
---

# YouTube transcript tool — checks and setup

The plugin already ships the MCP server and starts it itself, so nothing needs to be
installed for Claude Code. This skill is for the two things left over: a blocked IP, and
the user's other AI apps.

The command below is the server's own CLI:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/youtube-transcript-mcp.mjs" <command>
```

## Diagnose first

Run `doctor`. It prints the Node version, the proxy in use, whether a test transcript
comes through, and which AI apps it found on this machine. Read its output before
changing anything.

## YouTube blocks this machine

`doctor` says so explicitly. This happens on cloud servers, CI runners and some VPNs, not
usually on a home connection.

- Docker available → run `warp start`. It starts a free Cloudflare WARP container
  (no account needed), waits for the tunnel and stores the proxy. The running MCP server
  picks it up on the next call; no restart needed.
- No Docker → the user needs an HTTP proxy of their own, set as the environment variable
  `YOUTUBE_TRANSCRIPT_PROXY`. SOCKS proxies are not supported.
- `warp status` shows whether the tunnel is up, `warp stop` removes the container.

The server also starts WARP on its own the first time a request is blocked, so in many
cases the user only needs to try again.

## Add the tool to the user's other AI apps

`connect` writes the server into the configs of Codex, Grok Build, Cursor and Antigravity
if they are installed, keeping a backup of each file. Name the apps to limit it, e.g.
`connect cursor codex`. Tell the user which apps will be touched before running it, and
that they need to restart those apps afterwards.

## Other things this CLI can do

- `transcript <url|search phrase> [--text] [--language de] [--max-videos 5]` fetches a
  transcript without going through the MCP tool — useful to prove the tool itself works.
- Prefer running everything inside n8n instead? That route lives in `n8n/README.md` of
  the plugin directory; it is a different setup and does not use this plugin's server.

# YouTube Transcript MCP

An MCP server that reads YouTube transcripts — one video, a whole playlist, or the top
results of a YouTube search.

It runs **on your machine**. No API key, no Google account, no server, no token. A single
video goes straight to YouTube. Anything bigger — a playlist, a search, a hundred videos —
goes out through a free **Cloudflare WARP** proxy that the server starts by itself, because
YouTube refuses a plain IP after a handful of videos in a row.

```
Claude Code / Codex / Grok Build / Cursor / Antigravity
        │  MCP (stdio)
        ▼
youtube-transcript-mcp ── one video ──────────────────────────────►  youtube.com
        └─ playlist / search / a blocked IP ──► Cloudflare WARP ──►  youtube.com
                 (a Docker container it starts itself)
```

## Install

Node.js 18 or newer. For playlists and searches also **Docker** (Docker Desktop is fine) — the
server starts the WARP container in it by itself, you never touch it. Without Docker a
single video still works on a normal home connection.

### Claude Code

```
/plugin marketplace add https://github.com/StardawnAI/youtube-transcript-mcp.git
/plugin install awg-youtube-transcript@stardawn-ai
```

That's it — the plugin brings the server with it. Nothing else to configure. Then, in Claude Code:

```
/awg-yt-transcript https://youtu.be/jNQXAC9IVRw                        one video
/awg-yt-transcript https://www.youtube.com/playlist?list=PL…           a playlist, up to 100 videos
/awg-yt-transcript claude code tips                                     the top search results
```

You can also just paste a link and ask about it; Claude picks the tool up on its own.

### Codex, Grok Build, Cursor, Antigravity

```bash
npm install -g github:StardawnAI/youtube-transcript-mcp
youtube-transcript-mcp connect
```

`connect` finds the apps installed on this machine and writes the server into each of
their configs (a backup of every file it touches is kept next to it). Restart the apps
afterwards. You can also name them: `youtube-transcript-mcp connect cursor codex`.

<details>
<summary>Configure an app by hand</summary>

`<node>` is the path printed by `node -p "process.execPath"`, `<server>` the path printed
by `npm root -g` plus `/youtube-transcript-mcp/bin/youtube-transcript-mcp.mjs`.

**Codex** (`~/.codex/config.toml`) and **Grok Build** (`~/.grok/config.toml`):

```toml
[mcp_servers.youtube-transcript]
command = "<node>"
args = ["<server>"]
tool_timeout_sec = 900
```

**Cursor** (`~/.cursor/mcp.json`) and **Antigravity** (`~/.gemini/config/mcp_config.json`):

```json
{
  "mcpServers": {
    "youtube-transcript": { "command": "<node>", "args": ["<server>"] }
  }
}
```

**Claude Code without the plugin:**
`claude mcp add --scope user youtube-transcript -- <node> <server>`

Any other MCP client: a stdio server, started with that command.

</details>

## Using it

The server offers one tool, `get_youtube_transcript`:

| `url_type` | `youtube_url` | Returns |
|---|---|---|
| `video` (default) | video link or ID (`watch?v=`, `youtu.be/`, `shorts/`, `live/`) | that video's transcript |
| `playlist` | playlist link (contains `list=`) | files + an index, first 100 videos at most (default 25) |
| `search` | a search phrase, not a link | files + an index, about 20 results at most (default 10) |

Optional: `language` (`"de"`, `"en"`, …), `max_videos`, `include_segments` (single video),
`save_to` (playlist and search).

Just ask your assistant, for example *"summarize this video: https://youtu.be/…"* or
*"search YouTube for n8n MCP tutorials and compare what they say"*.

A single video answers in a few seconds:

```json
{
  "videoId": "jNQXAC9IVRw",
  "title": "Me at the zoo",
  "author": "jawed",
  "durationSeconds": 19,
  "language": "en",
  "generated": false,
  "availableLanguages": ["en", "de"],
  "fullText": "All right, so here we are, in front of the elephants …",
  "totalSegments": 6,
  "segments": [{ "text": "All right, so here we are, in front of the elephants", "start": "00:00:01.200", "end": "00:00:03.360", "startMs": 1200, "endMs": 3360 }]
}
```

A playlist or a search reads many videos, and a hundred transcripts do not belong in one
chat message. So each transcript is written to its own file — `<videoId>.txt` in
`./yt_transcripts`, or the folder you give as `save_to` — the moment it arrives, and the
answer is an index:

```json
{
  "totalVideos": 100, "successful": 100, "skipped": 0,
  "savedTo": "/your/project/yt_transcripts",
  "videos": [{ "videoId": "OuNKBjuV7A4", "title": "…", "author": "Fireship", "durationSeconds": 403, "language": "en", "generated": true, "characters": 7508 }]
}
```

Your assistant then reads the files it needs. Videos without captions come back as
`skipped` with a reason instead of failing the whole run. A run of 100 videos took about a
minute in our test.

## Cloudflare WARP

YouTube tolerates a few requests from one IP and then answers *"Sign in to confirm you're
not a bot"*. On a home connection that starts after a handful of videos in a row; on a
cloud server, CI runner or VPN it starts at the first request. Cloudflare WARP is the
route that keeps working: free, no account, and its exit addresses are shared with a lot of
ordinary traffic.

The server decides by itself:

- **A single video** goes out directly. If YouTube blocks it, the server starts WARP and
  tries again.
- **A playlist or a search** starts WARP first and reads all videos through it.
- **A block in the middle of a run** switches to WARP and carries on with the videos that
  are left. If YouTube keeps refusing even then, the run stops after three in a row and
  returns what it got — the files already written stay.

The very first start downloads the WARP image once (about 370 MB, half a minute on a fast
connection); after that it starts in seconds. The container keeps running (`--restart unless-stopped`) and is reused. If its
tunnel has silently died — the WARP daemon does that now and then, and the proxy port keeps
forwarding *without* the tunnel — the server notices and restarts it. You can also do it up
front or check what's going on:

```bash
youtube-transcript-mcp doctor        # can this machine reach YouTube? which proxy is in use?
youtube-transcript-mcp warp start    # start the WARP proxy now
youtube-transcript-mcp warp status
youtube-transcript-mcp warp stop     # remove it again
```

WARP needs Docker on the same machine; without it a playlist runs directly and stops early
once YouTube blocks it, and the answer says so. The container publishes its port on
`127.0.0.1` only, so nobody else can use it as an open proxy.

Other options:

- Own proxy: `YOUTUBE_TRANSCRIPT_PROXY=http://user:pass@host:port` (or `HTTPS_PROXY`).
  Only `http://` proxies work — that includes WARP, which speaks HTTP on port 1080.
- Turn the automatic start off: `YOUTUBE_TRANSCRIPT_AUTO_WARP=0`, or `"autoWarp": false`
  in the config file that `doctor` prints.

## Command line

The same thing without an AI app:

```bash
youtube-transcript-mcp transcript "https://youtu.be/jNQXAC9IVRw"            # JSON
youtube-transcript-mcp transcript "https://youtu.be/jNQXAC9IVRw" --text     # plain text
youtube-transcript-mcp transcript "claude code tips" --max-videos 5         # search, files + index
youtube-transcript-mcp transcript "<playlist url>" --max-videos 100 --save-to ./transcripts
```

## How it works, and what it can't do

- It calls the same endpoints youtube.com uses in the browser: the watch page for the
  InnerTube key, the player endpoint for the caption tracks, and the caption URL itself.
  Five different player clients are tried in turn, because YouTube answers them
  differently. That is also why this can break when YouTube changes something — please
  open an issue if it does.
- Only videos that have captions (uploaded or auto-generated) produce a transcript.
- Playlists: the first page YouTube serves, which holds up to 100 videos. Search: the first
  page, about 20 results.
- Three videos are read at a time, each worker pausing a moment between videos
  (`YOUTUBE_TRANSCRIPT_CONCURRENCY`, default 3; `YOUTUBE_TRANSCRIPT_DELAY_MS`, default 1000).
- Everything stays on your machine. No account, no telemetry, nothing is sent anywhere
  except to YouTube.
- Use it in line with YouTube's Terms of Service and the creators' rights.

## Development

```bash
git clone https://github.com/StardawnAI/youtube-transcript-mcp
cd youtube-transcript-mcp
node --test                     # parser, routing and bulk-run tests
node bin/youtube-transcript-mcp.mjs doctor
```

Tested with Claude Code 2.1.285, Grok Build 1.0.34, Cursor CLI 2026.09.15 and Antigravity
CLI 1.2.6; the Codex config was checked with the Codex CLI.

## License

[MIT](LICENSE). Built by [Stardawn AI](https://stardawnai.com).

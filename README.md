# YouTube Transcript MCP

An MCP server that reads YouTube transcripts — one video, a whole playlist, or the top
results of a YouTube search.

It runs **on your machine**. No API key, no Google account, no server, no token. For
machines whose IP YouTube blocks (cloud servers, CI, some data centres) it can route its
requests through a free **Cloudflare WARP** proxy, and it sets that up by itself.

```
Claude Code / Codex / Grok Build / Cursor / Antigravity
        │  MCP (stdio)
        ▼
youtube-transcript-mcp  ──►  youtube.com
        │                     (player + caption endpoints, no API key)
        └─ only if YouTube blocks this IP: ──► Cloudflare WARP ──► youtube.com
```

## Install

Node.js 18 or newer is the only requirement.

### Claude Code

```
/plugin marketplace add https://github.com/StardawnAI/youtube-transcript-mcp.git
/plugin install youtube-transcript@stardawn-ai
```

That's it — the plugin brings the server with it. Nothing else to configure.

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
| `playlist` | playlist link (contains `list=`) | one entry per video (default 25) |
| `search` | a search phrase, not a link | one entry per result (default 10) |

Optional: `language` (`"de"`, `"en"`, …), `max_videos`, `include_segments`.

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

Playlists and searches return `{ totalVideos, successful, skipped, videos: [...] }`, with
timestamped segments left out unless you ask for them, and one entry per video. Videos
without captions come back as `skipped` with a reason instead of failing the whole batch.

## When YouTube blocks the IP

On a normal home or office connection YouTube answers fine. Data centre IPs — cloud
servers, CI runners, some VPNs — get *"Sign in to confirm you're not a bot"* instead.

The server handles that itself: on a block it starts a **Cloudflare WARP** container
(free, no account), waits for the tunnel and retries the request. From then on it keeps
using it. You can also do it up front or check what's going on:

```bash
youtube-transcript-mcp doctor        # can this machine reach YouTube? which proxy is in use?
youtube-transcript-mcp warp start    # start the WARP proxy now
youtube-transcript-mcp warp status
youtube-transcript-mcp warp stop     # remove it again
```

WARP needs Docker on the same machine. The container publishes its port on `127.0.0.1`
only, so nobody else can use it as an open proxy.

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
youtube-transcript-mcp transcript "claude code tips" --max-videos 5 --text  # search
youtube-transcript-mcp transcript "<playlist url>" --language de
```

## How it works, and what it can't do

- It calls the same endpoints youtube.com uses in the browser: the watch page for the
  InnerTube key, the player endpoint for the caption tracks, and the caption URL itself.
  Five different player clients are tried in turn, because YouTube answers them
  differently. That is also why this can break when YouTube changes something — please
  open an issue if it does.
- Only videos that have captions (uploaded or auto-generated) produce a transcript.
- Playlists: the first page, up to 50 videos. Search: up to 50 results.
- Between videos it waits a moment so YouTube doesn't see a burst of requests
  (`YOUTUBE_TRANSCRIPT_DELAY_MS`, default 1500).
- Everything stays on your machine. No account, no telemetry, nothing is sent anywhere
  except to YouTube.
- Use it in line with YouTube's Terms of Service and the creators' rights.

## Prefer to run it in n8n?

The same thing also exists as two n8n workflows, with WARP as a container next to n8n:
[`n8n/README.md`](n8n/README.md). You only want this if the transcripts should feed other
n8n automations — for using it in an AI app, the server above is simpler.

## Development

```bash
git clone https://github.com/StardawnAI/youtube-transcript-mcp
cd youtube-transcript-mcp
node --test                     # parser unit tests
node bin/youtube-transcript-mcp.mjs doctor
```

Tested with Claude Code 2.1.274, Grok Build 1.0.34, Cursor CLI 2026.09.15 and Antigravity
CLI 1.2.6; the Codex config was checked with the Codex CLI.

## License

[MIT](LICENSE). Built by [Stardawn AI](https://stardawnai.com).

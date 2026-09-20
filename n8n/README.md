# Optional: the same thing as n8n workflows

Most people should use the standalone server described in the [main README](../README.md):
it runs locally and needs no n8n.

This folder is for the other case — you already run n8n and want transcripts **inside your
n8n automations**, with the MCP endpoint served by n8n itself. Two workflows do the work:

- [`youtube-transcript.json`](youtube-transcript.json) — fetches the transcripts.
- [`youtube-transcript-mcp-server.json`](youtube-transcript-mcp-server.json) — exposes the
  first one as an MCP server (bearer token) for AI apps.

n8n usually runs on a server, and YouTube blocks data centre IPs, so this route always
needs the Cloudflare WARP proxy container next to n8n.

## Setup

**1. Start WARP next to n8n** — on the machine where n8n's containers run:

```bash
curl -fsSL https://raw.githubusercontent.com/StardawnAI/youtube-transcript-mcp/main/n8n/docker/install-warp.sh | bash
```

It finds the n8n container, starts WARP on the same Docker network and checks the tunnel.
Several n8n containers? Name one: `… | bash -s -- my-n8n`. Compose users can copy the
`warp` service out of [`docker/docker-compose.yml`](docker/docker-compose.yml) instead;
that file also starts a fresh n8n plus WARP together.

Never publish port 1080 — it would be an open proxy.

**2. Create an n8n API key** under *Settings → n8n API*. Scopes, if asked:
`workflow:create`, `workflow:read`, `workflow:update`, `workflow:list`,
`workflow:activate`, `credential:create`.

**3. Run the setup:**

```bash
node n8n/setup-n8n.mjs
```

It imports both workflows (or updates them), creates the bearer token, activates the MCP
server, fetches a test transcript through WARP and writes the endpoint into Codex, Grok
Build, Cursor and Antigravity if they are installed. It prints the MCP URL and token at
the end. Re-running replaces the token.

Options: `--n8n-url`, `--api-key`, `--proxy http://…|none`, `--mcp-base-url`,
`--clients codex,grok,cursor,antigravity|none`, `--yes`, `--skip-test`.

For Claude Code, add the printed endpoint with
`claude mcp add --transport http --scope user youtube-transcript <URL> --header "Authorization: Bearer <TOKEN>"`.
Do not also install the `youtube-transcript` plugin — that one starts the standalone
server, and you would end up with the same tool twice.

## Importing by hand

1. Import both JSON files in n8n (*Workflows → Import from file*).
2. In *YouTube Transcript MCP Server*, open the MCP Server Trigger, create a *Bearer Auth*
   credential with a long random token and select it.
3. Open the tool node *get_youtube_transcript* and pick the workflow *YouTube Transcript*.
4. Publish both workflows. The URL is the trigger's *Production URL*.

## Notes

- The proxy must be written as `http://warp:1080`. n8n's HTTP Request node **silently
  ignores** `socks5://` proxy URLs and connects directly — which still works from a home
  IP, so the mistake only shows up on a server.
- n8n on a home connection needs no proxy at all: `node n8n/setup-n8n.mjs --proxy none`.
- Playlists take a while: the workflows pause 5–15 seconds between videos.
- Some n8n versions reject credential deletes through the API, so old
  `YouTube Transcript MCP Bearer …` credentials pile up. They stop working the moment a
  new one is created; delete them in n8n whenever you like.

---
name: setup
description: Set up, repair or re-key the YouTube Transcript MCP server on the user's own n8n — starts the Cloudflare WARP proxy next to n8n, imports and activates the n8n workflows, and connects Claude Code (plus Codex, Grok Build, Cursor, Antigravity if installed). Use for /youtube-transcript:setup or when the user asks to install, configure, fix or rotate the token of the YouTube transcript tool.
---

# Set up the YouTube Transcript MCP server

The tool runs as two n8n workflows on the user's own n8n. YouTube requests go
through a free Cloudflare WARP container (`http://warp:1080`) on the same
Docker network as n8n. `scripts/setup.mjs` does the n8n part and the client
configuration; your job is to collect the inputs, get WARP running, run the
script and report the result.

## 1. Collect the inputs

Ask the user for:

1. **n8n URL**, e.g. `https://n8n.example.com`.
2. **n8n API key**, created in n8n under *Settings → n8n API → Create an API key*.
   If n8n asks for scopes: `workflow:create`, `workflow:read`, `workflow:update`,
   `workflow:list`, `workflow:activate`, `credential:create` (optional
   `credential:delete`). Never repeat the key back in chat or write it to a file.
3. **Where n8n runs**: a cloud server/VPS (needs WARP) or a home connection
   (no proxy needed → use `--proxy none` and skip step 2).

## 2. Make sure WARP runs next to n8n

WARP must run on the Docker host of n8n, not on the user's laptop (unless n8n
runs there).

- n8n runs in Docker on this machine → run it yourself:
  `bash "${CLAUDE_PLUGIN_ROOT}/docker/install-warp.sh"`
- n8n runs on a server you can reach (e.g. an SSH tool) → run there:
  `curl -fsSL https://raw.githubusercontent.com/StardawnAI/youtube-transcript-mcp/main/docker/install-warp.sh | bash`
- Otherwise give the user that one-liner to run on the server and wait for
  them to confirm it printed `WARP connected`.

The script finds the n8n container, attaches WARP to its Docker network and
checks the tunnel. If it prints a proxy other than `http://warp:1080`, pass
that value as `--proxy` in step 3. A fresh install can use
`${CLAUDE_PLUGIN_ROOT}/docker/docker-compose.yml` instead (n8n + WARP).

## 3. Run the setup script

Tell the user which apps will be configured (Claude Code always; Codex, Grok Build,
Cursor and Antigravity only if installed), then run it with the API key in the
environment, not on the command line:

- bash/zsh:
  `N8N_API_KEY='<key>' node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --n8n-url <url> --yes`
- PowerShell:
  `$env:N8N_API_KEY='<key>'; node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --n8n-url <url> --yes; Remove-Item Env:N8N_API_KEY`

Useful flags: `--proxy none` (home connection), `--proxy http://<name>:1080`
(other WARP container name), `--mcp-base-url https://…` (webhooks run under a
different public URL), `--clients claude` (only Claude Code).

The script imports the workflows (updating them if they exist), creates a new
bearer token, activates the MCP server, fetches a test transcript through it
and installs this plugin's MCP settings with the new URL and token.

## 4. Report

- Success: tell the user to run `/reload-plugins` (or restart Claude Code) so
  the `youtube-transcript` server connects, and to restart Codex, Grok Build, Cursor or
  Antigravity if the script configured them. The MCP URL and token are in the
  script output; mention that the token is secret.
- Test failed: the script prints the likely cause. Most often WARP is not
  running or not on n8n's Docker network (repeat step 2), n8n runs at home
  without WARP (re-run with `--proxy none`), or the public webhook URL differs
  (re-run with `--mcp-base-url`).

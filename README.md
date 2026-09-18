# YouTube Transcript MCP for n8n

Give Claude Code, Codex, Cursor and Antigravity a tool that reads YouTube transcripts:
a single video, a whole playlist, or the top results of a YouTube search.

It runs on **your own n8n**. You need no YouTube API key, no Google account and no paid
proxy. Requests to YouTube go through a free **Cloudflare WARP** container next to n8n,
so YouTube doesn't block your server.

```
Claude Code / Codex / Cursor / Antigravity
        │  MCP (streamable HTTP, bearer token)
        ▼
n8n ─ "YouTube Transcript MCP Server" ─► "YouTube Transcript" workflow
                                               │  http://warp:1080
                                               ▼
                                     Cloudflare WARP container ─► YouTube
```

## Why WARP?

YouTube treats requests from cloud and datacenter IPs as bots and answers *"Sign in to
confirm you're not a bot"*. That covers Hetzner, Oracle, AWS, DigitalOcean and most other
hosts n8n runs on. [Cloudflare WARP](https://one.one.one.one/) routes the requests through
Cloudflare's consumer network instead. It is free and needs no account.

The whole trick is one small Docker container on the same network as n8n. The setup
below starts it for you.

If n8n runs on a home internet connection you don't need WARP (see
[Home connection](#home-connection-no-warp)).

## Requirements

- Self-hosted n8n in Docker with the **MCP Server Trigger** node. Tested with n8n 2.39.
  n8n Cloud does not work, because you can't run the WARP container next to it.
- An n8n API key (step 2).
- Node.js 18 or newer on the computer where you run the setup.

## Setup

### 1. Start WARP next to n8n

Run **one** of these on the machine where n8n's Docker containers run.

**A. You already run n8n in Docker.** Run the installer. It finds the n8n container, starts
WARP on the same Docker network and checks that the tunnel works:

```bash
curl -fsSL https://raw.githubusercontent.com/StardawnAI/youtube-transcript-mcp/main/docker/install-warp.sh | bash
```

If you run several n8n containers, name one:
`… | bash -s -- my-n8n-container`

**B. You manage n8n with Docker Compose** (including Coolify, Portainer and Dokploy stacks).
Add this service to the same compose file as n8n and redeploy:

```yaml
  warp:
    image: caomingjun/warp:latest
    restart: unless-stopped
    device_cgroup_rules:
      - "c 10:200 rwm"
    cap_add: [MKNOD, AUDIT_WRITE, NET_ADMIN]
    sysctls:
      - net.ipv6.conf.all.disable_ipv6=0
      - net.ipv4.conf.all.src_valid_mark=1
    environment:
      - WARP_SLEEP=2
    volumes:
      - warp-data:/var/lib/cloudflare-warp
# and under the top-level volumes:  warp-data:
```

**C. Fresh install.** [`docker/docker-compose.yml`](docker/docker-compose.yml) starts n8n and
WARP together:

```bash
cd docker && docker compose up -d
```

> Never publish port 1080. Anyone who can reach it could use your server as an open proxy.
> n8n reaches WARP over the internal Docker network, so no published port is needed.

### 2. Create an n8n API key

In n8n go to **Settings → n8n API → Create an API key**. If n8n asks for scopes, choose
`workflow:create`, `workflow:read`, `workflow:update`, `workflow:list`,
`workflow:activate` and `credential:create`. Add `credential:delete` too if you want
re-runs to remove the old token.

The key is used only while the setup runs. It is not saved anywhere.

### 3. Run the setup

```bash
git clone https://github.com/StardawnAI/youtube-transcript-mcp
cd youtube-transcript-mcp
node scripts/setup.mjs
```

The script asks for your n8n URL and API key, then:

1. imports the two workflows (or updates them if they already exist),
2. creates the bearer-token credential with a random token,
3. activates the MCP server,
4. fetches a test transcript through it, which checks WARP end to end,
5. connects every AI app it finds on this computer (it asks before changing each one):
   Claude Code (as a plugin), Codex, Cursor and Antigravity.

At the end it prints the **MCP URL** and **token**, in case you want to connect other apps.
Restart the apps it configured.

Running it again is safe. It updates the workflows and replaces the token.

<details>
<summary>All options</summary>

```
--n8n-url <url>        n8n base URL (env N8N_URL)
--api-key <key>        n8n API key (env N8N_API_KEY)
--proxy <url|none>     default http://warp:1080; "none" for a home connection
--mcp-base-url <url>   public webhook base URL, if it differs from --n8n-url
--clients <list>       auto (default) | none | claude,codex,cursor,antigravity
--yes                  don't ask before writing app configs
--skip-test            skip the end-to-end test
--test-video <url>     video for the end-to-end test
```

</details>

### Claude Code users: do it all from inside Claude Code

```
/plugin marketplace add https://github.com/StardawnAI/youtube-transcript-mcp.git
/plugin install youtube-transcript@stardawn-ai
/youtube-transcript:setup
```

Leave the URL and token fields empty when the install asks for them. The
`/youtube-transcript:setup` command walks you through steps 1–3 and fills them in.

## Connect your AI app by hand

The setup script does this for you. Here is what it writes, if you want to do it
yourself or use another MCP client. Replace `<URL>` and `<TOKEN>` with the values the
setup printed.

**Claude Code** (plugin, asks for URL and token):

```
/plugin marketplace add https://github.com/StardawnAI/youtube-transcript-mcp.git
/plugin install youtube-transcript@stardawn-ai
```

Without the plugin:
`claude mcp add --transport http --scope user youtube-transcript <URL> --header "Authorization: Bearer <TOKEN>"`

**Codex** (`~/.codex/config.toml`, used by the CLI, the IDE extension and the app):

```toml
[mcp_servers.youtube-transcript]
url = "<URL>"
http_headers = { "Authorization" = "Bearer <TOKEN>" }
tool_timeout_sec = 900
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "youtube-transcript": {
      "url": "<URL>",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

**Antigravity** (`~/.gemini/config/mcp_config.json`). This goes through
[`mcp-remote`](https://github.com/geelen/mcp-remote), because Antigravity's built-in HTTP
transport has open bugs with bearer headers on n8n endpoints. On Windows use
`"command": "cmd"` with `"/c", "npx", …` as the first args.

```json
{
  "mcpServers": {
    "youtube-transcript": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "<URL>", "--header", "Authorization:${AUTH_HEADER}", "--transport", "http-only"],
      "env": { "AUTH_HEADER": "Bearer <TOKEN>" }
    }
  }
}
```

**Any other MCP client:** streamable HTTP at `<URL>` with the header
`Authorization: Bearer <TOKEN>`.

> **Why is only Claude Code a real plugin?** Codex, Cursor and Antigravity have plugin
> formats too, but none of them can hold a personal server URL and token. The setup script
> writes the server straight into their config instead, which is less work for you.

## Using it

The server has one tool, `get_youtube_transcript`, with two arguments:

| `url_type` | `youtube_url` | Returns |
|---|---|---|
| `video` | a video link (`watch?v=`, `youtu.be/`, `shorts/`, `live/`) | the video's transcript |
| `playlist` | a playlist link (contains `list=`) | transcripts of up to 50 videos |
| `search` | a search phrase, not a link | transcripts of the top 10 results |

Just ask, for example *"Summarize this video: https://youtu.be/…"* or *"Search YouTube
for n8n MCP tutorials and compare what they recommend"*.

A single video returns:

```json
{
  "videoId": "jNQXAC9IVRw",
  "title": "Me at the zoo",
  "author": "jawed",
  "language": "en",
  "fullText": "All right, so here we are, in front of the elephants …",
  "segments": [{ "text": "…", "start": "00:00:01.200", "end": "00:00:03.360", "startMs": 1200, "endMs": 3360 }],
  "totalSegments": 6
}
```

Playlist and search return `{ totalVideos, successful, skipped, videos: [...] }`. Videos
without captions come back with `skipped: true` and a reason.

A single video takes a few seconds. Playlist and search pause 5–15 seconds between videos
to stay below YouTube's bot detection, so a 10-video search takes about 2–4 minutes.

## Configuration

### Home connection (no WARP)

If n8n runs on a home internet connection, YouTube doesn't block it:

```bash
node scripts/setup.mjs --proxy none
```

### Different proxy or container name

If your WARP container isn't named `warp`, or you use another HTTP proxy, pass it with
`--proxy http://name:1080`. In the workflow, the proxy sits on the eight HTTP Request nodes
under **Options → Proxy**.

Use an `http://` proxy URL. n8n's HTTP Request node silently ignores `socks5://` proxy URLs
and connects directly. That still works from a home IP, so you won't notice it there, but
YouTube blocks it on a server. The WARP container accepts HTTP and SOCKS5 on port 1080.

### Import without the script

1. In n8n, import [`n8n/youtube-transcript.json`](n8n/youtube-transcript.json) and
   [`n8n/youtube-transcript-mcp-server.json`](n8n/youtube-transcript-mcp-server.json)
   (Workflows → Import from file).
2. In **YouTube Transcript MCP Server**, open *MCP Server Trigger*. Create a *Bearer Auth*
   credential with a long random token and select it.
3. Open the tool node *get_youtube_transcript* and select the workflow **YouTube
   Transcript**.
4. Publish or activate both workflows. The MCP URL is shown in the trigger's
   *Production URL*.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `every YouTube client was blocked or returned no captions` | WARP isn't reachable from n8n. On the n8n host, `docker exec warp curl -s -x http://127.0.0.1:1080 https://www.cloudflare.com/cdn-cgi/trace` must show `warp=on`. Re-run `install-warp.sh`. If the video really has no captions, there is no transcript to fetch. |
| `403 Authorization data is wrong!` | The token in your app is old. Re-run the setup, or paste the current token. |
| `404` on the MCP URL | The MCP workflow isn't active, or your webhooks run under another public URL. Re-run the setup with `--mcp-base-url https://…`. |
| Codex times out on playlists | Raise `tool_timeout_sec` in `~/.codex/config.toml`. |
| Old `YouTube Transcript MCP Bearer …` credentials pile up | Some n8n versions refuse credential deletes through the API. Delete the unused ones under **Credentials**. |
| n8n sits behind Cloudflare Access or another login | The `/mcp/…` path must be reachable with just the bearer token, so bypass the login for that path. |

## Security

- The token gives access to the MCP endpoint only, not to n8n itself. The setup writes it
  into your apps' config files in your home folder, like any MCP config. Re-running the
  setup replaces it.
- Don't expose WARP's port 1080 (see above).

## Limitations

- The workflow uses YouTube's internal player and caption endpoints, the same ones
  youtube.com uses, not the official Data API. YouTube can change them at any time. If
  something breaks, please open an issue.
- Only videos with captions work (uploaded or auto-generated).
- Playlists: the first 50 videos. Search: the top 10.
- Use it in line with YouTube's Terms of Service and the creators' rights.

## License

[MIT](LICENSE). Built by [Stardawn AI](https://stardawnai.com).

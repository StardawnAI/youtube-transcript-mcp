---
name: awg-sm-transcript-setup
description: Check or repair the TikTok/Instagram transcript worker — Docker, the worker container and its Whisper model, its Cloudflare WARP route, and the routes the platforms have paused or blocked. Use for /awg-sm-transcript-setup, when get_social_transcript fails with a Docker, build or worker message (/awg-sm-transcript runs these steps by itself), or when the user asks where the stored videos are.
---

# TikTok/Instagram worker — checks and setup

The plugin ships everything. The first TikTok or Instagram link builds the worker image (a few
minutes, once), starts the container and downloads the Whisper model (about 1.6 GB, once). This
skill is for what can go wrong around that.

The command below is the server's own CLI:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/smtranscript.mjs" <command>
```

## Diagnose first

Run `doctor`, then `worker status`. Read both before changing anything.

## Docker

**Docker is not running → start it yourself**: on Windows `Docker Desktop.exe` from
`C:\Program Files\Docker\Docker`, on a Mac `open -a Docker`, on Linux `systemctl start docker`;
wait up to two minutes until `docker info` answers. Only when Docker is not installed at all is
there something the person has to do: install Docker Desktop. TikTok and Instagram do not work
without it (YouTube single videos do).

## The worker

- `worker start` builds the image if it is missing, starts the container `smtranscript-worker`
  (on `127.0.0.1:47821`, with the NVIDIA card when there is one) and says whether Whisper is
  loaded and on which device.
- `worker logs` shows its last 50 lines. A model that does not load, a full disk or a crash is
  there.
- `worker stop` removes the container and its WARP. The stored videos and transcripts stay in the
  Docker volume `smtranscript-data`.
- Port 47821 taken by something else → set `SMTRANSCRIPT_WORKER_PORT` for the plugin's server and
  run `worker stop`, then `worker start`.
- A worker on another machine (StarBase, a server) → `SMTRANSCRIPT_WORKER_URL` and
  `SMTRANSCRIPT_WORKER_KEY`; nothing is started locally then.

## WARP

`route: "warp"` sends the platform requests through the worker's own Cloudflare WARP container
`smtranscript-warp` (not the YouTube one). The tool starts it on the first such call. If it stays
unhealthy: `docker logs smtranscript-warp`, then `docker rm -f smtranscript-warp` and call again.

## Paused and blocked routes

The worker keeps a budget per platform and route. After a 429 it pauses that pair by itself and
continues later. After a login challenge it stops the pair until a person unblocks it:

```
curl -s -H "Authorization: Bearer <key>" http://127.0.0.1:47821/v1/routes
```

The key is `workerKey` in the server's config file (`doctor` prints its path). Never print the
key into the chat. Unblocking (`POST /v1/routes/unblock` with `{"platform": "...", "route": "..."}`)
is the person's decision: ask before doing it, and do not do it in a loop.

// MCP server over stdio. Stdout carries protocol messages only — everything
// human-readable goes to stderr.
import { createInterface } from 'node:readline';
import { BlockedError, getTranscript, getTranscripts, parsePlaylistId, parseVideoId, playlistVideoIds, searchVideoIds } from './youtube.mjs';
import { readConfig, resolveProxy } from './config.mjs';
import { dockerAvailable, start as startWarp } from './warp.mjs';

export const VERSION = '2.0.0';
const PROTOCOL = '2025-06-18';
const DELAY_MS = Number(process.env.YOUTUBE_TRANSCRIPT_DELAY_MS || 1500);

const TOOL = {
  name: 'get_youtube_transcript',
  description: `Read YouTube transcripts: one video, a playlist, or the top results of a YouTube search.

url_type:
- "video" (default): youtube_url is a video link (watch?v=…, youtu.be/…, shorts/…, live/…) or a bare video ID.
- "playlist": youtube_url is a playlist link (contains list=). Returns one entry per video.
- "search": youtube_url is a SEARCH PHRASE, not a link. Returns one entry per result.

If a link contains a list= parameter, ask the user whether they mean the single video or the whole playlist instead of guessing. Playlist and search take a few seconds per video. Videos without captions come back with skipped: true and a reason.`,
  inputSchema: {
    type: 'object',
    properties: {
      youtube_url: { type: 'string', description: 'Video URL, playlist URL, video ID, or a search phrase when url_type is "search".' },
      url_type: { type: 'string', enum: ['video', 'playlist', 'search'], description: 'Defaults to "video".' },
      language: { type: 'string', description: 'Preferred caption language, e.g. "en" or "de". Defaults to the video\'s own captions.' },
      max_videos: { type: 'integer', minimum: 1, maximum: 50, description: 'For playlist (default 25) and search (default 10).' },
      include_segments: { type: 'boolean', description: 'Timestamped segments. Default: true for a single video, false for playlist and search.' },
    },
    required: ['youtube_url'],
  },
};

function detectType(input, given) {
  if (given) return given;
  if (parsePlaylistId(input) && !parseVideoId(input)) return 'playlist';
  return parseVideoId(input) ? 'video' : 'search';
}

// Runs the work; if YouTube blocks this IP, brings up WARP and tries once more.
async function withWarpFallback(run, notify) {
  const proxy = await resolveProxy();
  try {
    return await run(proxy);
  } catch (e) {
    const config = await readConfig();
    const autoWarp = config.autoWarp !== false && process.env.YOUTUBE_TRANSCRIPT_AUTO_WARP !== '0';
    if (!(e instanceof BlockedError) || proxy || !autoWarp) throw e;
    if (!dockerAvailable()) {
      throw new BlockedError(
        `${e.message}. This IP is blocked by YouTube. Cloudflare WARP fixes it, but Docker is not running here — ` +
        'start Docker and run "youtube-transcript-mcp warp start", or point the server at an HTTP proxy with YOUTUBE_TRANSCRIPT_PROXY.',
      );
    }
    notify('YouTube blocked this IP — starting the Cloudflare WARP proxy, this takes a moment');
    const { proxy: warpProxy, ip } = await startWarp({ log: notify });
    notify(`WARP is up (exit IP ${ip}) — retrying`);
    return run(warpProxy);
  }
}

async function runTool(args, { notify }) {
  const input = String(args.youtube_url || '').trim();
  if (!input) throw new Error('youtube_url is required');
  const type = detectType(input, args.url_type);
  const language = args.language;
  const includeSegments = args.include_segments ?? type === 'video';

  return withWarpFallback(async (proxy) => {
    const options = { proxy, language, includeSegments };

    if (type === 'video') {
      const videoId = parseVideoId(input);
      if (!videoId) throw new Error(`No YouTube video ID in "${input}". Use url_type "playlist" or "search" for those.`);
      return getTranscript(videoId, options);
    }

    let videoIds;
    if (type === 'playlist') {
      const playlistId = parsePlaylistId(input);
      if (!playlistId) throw new Error(`No playlist ID in "${input}" — a playlist URL contains "list=".`);
      videoIds = await playlistVideoIds(playlistId, args.max_videos || 25, { proxy });
    } else {
      videoIds = await searchVideoIds(input, args.max_videos || 10, { proxy });
    }

    return getTranscripts(videoIds, {
      ...options,
      delayMs: DELAY_MS,
      onProgress: (done, total, videoId) => notify(`transcript ${done}/${total} (${videoId})`, done, total),
    });
  }, notify);
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------
export function serve({ input = process.stdin, output = process.stdout } = {}) {
  const send = (message) => output.write(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  const handlers = {
    initialize: (params) => ({
      protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(params?.protocolVersion || '') ? params.protocolVersion : PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'youtube-transcript', version: VERSION },
    }),
    ping: () => ({}),
    'tools/list': () => ({ tools: [TOOL] }),
    'resources/list': () => ({ resources: [] }),
    'prompts/list': () => ({ prompts: [] }),
    'tools/call': async (params, id) => {
      const progressToken = params?._meta?.progressToken;
      const notify = (message, progress, total) => {
        process.stderr.write(`${message}\n`);
        if (progressToken === undefined) return;
        send({
          jsonrpc: '2.0', method: 'notifications/progress',
          params: { progressToken, message, ...(progress !== undefined ? { progress, total } : {}) },
        });
      };
      if (params?.name !== TOOL.name) throw new Error(`Unknown tool: ${params?.name}`);
      const result = await runTool(params.arguments || {}, { notify, id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  };

  createInterface({ input, crlfDelay: Infinity }).on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return replyError(null, -32700, 'Parse error');
    }
    if (message.id === undefined) return; // notification: nothing to answer
    const handler = handlers[message.method];
    if (!handler) return replyError(message.id, -32601, `Method not found: ${message.method}`);
    try {
      reply(message.id, await handler(message.params, message.id));
    } catch (e) {
      if (message.method === 'tools/call') {
        // Tool failures belong in the result so the model can read them
        return reply(message.id, { content: [{ type: 'text', text: e.message }], isError: true });
      }
      replyError(message.id, -32603, e.message);
    }
  });

  process.stderr.write(`youtube-transcript MCP server ${VERSION} ready\n`);
}

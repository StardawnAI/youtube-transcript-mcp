// MCP server over stdio. Stdout carries protocol messages only — everything
// human-readable goes to stderr.
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { BlockedError, getTranscript, getTranscripts, parsePlaylistId, parseVideoId, playlistVideoIds, searchVideoIds } from './youtube.mjs';
import { configuredProxy, readConfig } from './config.mjs';
import { dockerAvailable, start as startWarp } from './warp.mjs';

export const VERSION = '2.1.0';
const PROTOCOL = '2025-06-18';
const DELAY_MS = Number(process.env.YOUTUBE_TRANSCRIPT_DELAY_MS || 1000);
const CONCURRENCY = Number(process.env.YOUTUBE_TRANSCRIPT_CONCURRENCY || 3);
const DEFAULT_SAVE_DIR = 'yt_transcripts';

const TOOL = {
  name: 'get_youtube_transcript',
  description: `Read YouTube transcripts: one video, a playlist, or the top results of a YouTube search.

url_type:
- "video" (default): youtube_url is a video link (watch?v=…, youtu.be/…, shorts/…, live/…) or a bare video ID. The transcript comes back in the answer.
- "playlist": youtube_url is a playlist link (contains list=). Reads the first 100 videos of the playlist at most.
- "search": youtube_url is a SEARCH PHRASE, not a link. Reads the top results (about 20 at most).

A playlist or a search reads many videos, so the transcripts are written to files (one <videoId>.txt each, in save_to, default ./${DEFAULT_SAVE_DIR}) and the answer is an index with title, author and length per video. Read the files you need afterwards. Runs of many videos go through Cloudflare WARP automatically, because YouTube refuses a plain IP after a handful in a row; a run of 100 videos takes several minutes. Videos without captions are listed with skipped: true and a reason.

If a link contains a list= parameter, ask the user whether they mean the single video or the whole playlist instead of guessing.`,
  inputSchema: {
    type: 'object',
    properties: {
      youtube_url: { type: 'string', description: 'Video URL, playlist URL, video ID, or a search phrase when url_type is "search".' },
      url_type: { type: 'string', enum: ['video', 'playlist', 'search'], description: 'Defaults to "video".' },
      language: { type: 'string', description: 'Preferred caption language, e.g. "en" or "de". Defaults to the video\'s own captions.' },
      max_videos: { type: 'integer', minimum: 1, maximum: 100, description: 'For playlist (default 25, up to 100) and search (default 10, up to 20).' },
      include_segments: { type: 'boolean', description: 'Single video only: timestamped segments. Default true.' },
      save_to: { type: 'string', description: `Playlist and search only: the directory for the transcript files. Relative paths start at the working directory. Default ./${DEFAULT_SAVE_DIR}.` },
    },
    required: ['youtube_url'],
  },
};

function detectType(input, given) {
  if (given) return given;
  if (parsePlaylistId(input) && !parseVideoId(input)) return 'playlist';
  return parseVideoId(input) ? 'video' : 'search';
}

// Where the requests go.
//
// A proxy the user configured is used as it is and never replaced. Without one:
// a single video goes out directly (fast, and fine on most home connections),
// a run of many videos goes through Cloudflare WARP from the first request
// (YouTube refuses a plain IP after roughly seven videos in a row), and WARP is
// also the way out when a single request is blocked.
//
// `run(route, onBlocked)` does the work. `route.proxy` is read when it starts;
// `onBlocked()` may return a better proxy in the middle of a run, once.
export async function withRoute(run, { bulk = false, notify = () => {} } = {}, deps = {}) {
  const d = { configuredProxy, readConfig, dockerAvailable, startWarp, ...deps };
  const fixed = d.configuredProxy();
  const config = await d.readConfig();
  const allowed = !fixed && config.autoWarp !== false && process.env.YOUTUBE_TRANSCRIPT_AUTO_WARP !== '0';

  const route = { proxy: fixed, warpProblem: null };
  let attempted = false;

  const useWarp = async (reason) => {
    if (!allowed || attempted) return null;
    attempted = true;
    if (!d.dockerAvailable()) {
      route.warpProblem = 'Docker is not running here, so Cloudflare WARP cannot be started';
      notify(`${reason}, but ${route.warpProblem}`);
      return null;
    }
    notify(`${reason} — starting the Cloudflare WARP proxy, this takes a moment`);
    try {
      const { proxy, ip } = await d.startWarp({ log: notify });
      notify(`WARP is up (exit IP ${ip})`);
      route.proxy = proxy;
      return proxy;
    } catch (e) {
      route.warpProblem = `Cloudflare WARP did not start: ${e.message}`;
      notify(route.warpProblem);
      return null;
    }
  };

  const withHint = (e) => {
    if (!route.warpProblem) return e;
    return new BlockedError(
      `${e.message}. ${route.warpProblem}. Start Docker and try again, or point the server at an HTTP proxy with YOUTUBE_TRANSCRIPT_PROXY.`,
    );
  };

  if (bulk) await useWarp('A run of many videos needs a route YouTube does not block');
  try {
    return await run(route, () => useWarp('YouTube blocked this IP'));
  } catch (e) {
    if (!(e instanceof BlockedError)) throw e;
    if (!(await useWarp('YouTube blocked this IP'))) throw withHint(e);
    return run(route, async () => null);
  }
}

const resolveDir = (dir) => (isAbsolute(dir) ? dir : resolve(process.cwd(), dir));

// Fetches many transcripts and writes each one to <dir>/<videoId>.txt as soon as
// it arrives, so a run that dies late has still delivered what it got. Returns
// the run's summary with an index in place of the transcripts themselves.
export async function saveTranscripts(videoIds, { dir, route, onBlocked, language, notify = () => {}, fetcher }) {
  await mkdir(dir, { recursive: true });
  notify(`${videoIds.length} videos, saving to ${dir}`);

  const index = [];
  const result = await getTranscripts(videoIds, {
    proxy: route.proxy,
    language,
    includeSegments: false,
    delayMs: DELAY_MS,
    concurrency: CONCURRENCY,
    onBlocked,
    fetcher,
    onProgress: (done, total, videoId) => notify(`transcript ${done}/${total} (${videoId})`, done, total),
    onVideo: async (video, position) => {
      if (video.skipped) return void (index[position] = video);
      await writeFile(join(dir, `${video.videoId}.txt`), `${video.fullText}\n`);
      // What Claude needs to pick from: the text itself stays in the file, and the
      // link, channel ID and file name follow from the video ID.
      const { fullText, segments, availableLanguages, channelId, url, totalSegments, ...meta } = video;
      index[position] = { ...meta, characters: fullText.length };
    },
  });
  const { videos, ...summary } = result;
  return { ...summary, savedTo: dir, files: '<videoId>.txt', videos: videos.map((v, position) => index[position] ?? v) };
}

// The tool itself; the command line uses it too.
export async function runTool(args, { notify = () => {} } = {}, deps = {}) {
  const input = String(args.youtube_url || '').trim();
  if (!input) throw new Error('youtube_url is required');
  const type = detectType(input, args.url_type);
  const language = args.language;

  if (type === 'video') {
    const videoId = parseVideoId(input);
    if (!videoId) throw new Error(`No YouTube video ID in "${input}". Use url_type "playlist" or "search" for those.`);
    return withRoute((route) => getTranscript(videoId, { proxy: route.proxy, language, includeSegments: args.include_segments ?? true }), { notify }, deps);
  }

  const dir = resolveDir(args.save_to || DEFAULT_SAVE_DIR);
  return withRoute(async (route, onBlocked) => {
    let videoIds;
    if (type === 'playlist') {
      const playlistId = parsePlaylistId(input);
      if (!playlistId) throw new Error(`No playlist ID in "${input}" — a playlist URL contains "list=".`);
      videoIds = await playlistVideoIds(playlistId, args.max_videos || 25, { proxy: route.proxy });
    } else {
      videoIds = await searchVideoIds(input, args.max_videos || 10, { proxy: route.proxy });
    }
    const summary = await saveTranscripts(videoIds, { dir, route, onBlocked, language, notify, fetcher: deps.fetcher });
    if (route.warpProblem && summary.stoppedEarly) {
      summary.hint = `${route.warpProblem}. Start Docker and try again, or set YOUTUBE_TRANSCRIPT_PROXY.`;
    }
    return summary;
  }, { bulk: true, notify }, deps);
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
    'tools/call': async (params) => {
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
      const result = await runTool(params.arguments || {}, { notify });
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

// YouTube transcripts without an API key: the same endpoints youtube.com itself
// uses. The watch page holds the InnerTube key, the player endpoint returns the
// caption tracks, and the caption URL returns timed text.
import { getText, postJson, BROWSER_UA } from './http.mjs';

const WATCH = 'https://www.youtube.com/watch?v=';
const PLAYER = 'https://www.youtube.com/youtubei/v1/player';

// Tried in order. ANDROID has the best caption coverage; the others cover
// videos it cannot play. A client that is blocked (bot detection) or returns
// no captions hands over to the next one.
const CLIENTS = [
  {
    clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30,
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
  },
  { clientName: 'WEB', clientVersion: '2.20240101.00.00', userAgent: BROWSER_UA },
  {
    clientName: 'MWEB', clientVersion: '2.20250312.07.00',
    userAgent: 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  },
  {
    clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2',
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_7 like Mac OS X;)',
  },
  {
    clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0',
    userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 NativeBrowser/2.0 SmartTV Safari/538.1',
    thirdParty: { embedUrl: 'https://www.youtube.com' },
  },
];

export class BlockedError extends Error {
  constructor(message) { super(message); this.name = 'BlockedError'; }
}

const BLOCK_HINTS = ['sign in to confirm', 'not a bot', 'login_required'];
const looksBlocked = (text = '') => BLOCK_HINTS.some((h) => text.toLowerCase().includes(h));

// --------------------------------------------------------------------------
// Input parsing
// --------------------------------------------------------------------------
export function parseVideoId(input) {
  const s = String(input || '').trim();
  const m =
    s.match(/[?&]v=([a-zA-Z0-9_-]{11})/) ||
    s.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/) ||
    s.match(/\/(?:embed|shorts|live)\/([a-zA-Z0-9_-]{11})/) ||
    s.match(/^([a-zA-Z0-9_-]{11})$/);
  return m ? m[1] : null;
}

export function parsePlaylistId(input) {
  return String(input || '').match(/[?&]list=([a-zA-Z0-9_-]+)/)?.[1] || null;
}

// --------------------------------------------------------------------------
// Transcript XML (srv3) → segments
// --------------------------------------------------------------------------
const decode = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/<\/?(?:b|i|u|font)\b[^>]*>/gi, '') // formatting tags escaped in the XML
    .replace(/\s+/g, ' ');

const timestamp = (ms) => {
  const s = Math.floor(ms / 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}.${pad(ms % 1000, 3)}`;
};

export function parseTranscript(xml) {
  const segments = [];
  // <p t="startMs" d="durationMs"> either plain text or <s> word chunks
  const paragraphs = /<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>(.+?)<\/p>/gs;
  for (const m of String(xml).matchAll(paragraphs)) {
    const startMs = Number(m[1]);
    const endMs = startMs + (m[2] ? Number(m[2]) : 0);
    const text = decode(m[3]).trim();
    if (!text) continue;
    segments.push({ text, startMs, endMs, start: timestamp(startMs), end: timestamp(endMs) });
  }
  return segments;
}

// --------------------------------------------------------------------------
// One video
// --------------------------------------------------------------------------
async function playerResponse(videoId, client, apiKey, options) {
  const { userAgent, thirdParty, ...clientContext } = client;
  const context = {
    client: { ...clientContext, userAgent, hl: 'en', timeZone: 'UTC', utcOffsetMinutes: 0 },
    ...(thirdParty ? { thirdParty } : {}),
  };
  return postJson(`${PLAYER}?key=${apiKey}`, { context, videoId }, { ...options, headers: { 'User-Agent': userAgent } });
}

function pickTrack(tracks, language) {
  if (!tracks.length) return null;
  if (language) {
    const exact = tracks.find((t) => t.languageCode === language);
    if (exact) return exact;
    const prefix = tracks.find((t) => t.languageCode?.startsWith(`${language}-`));
    if (prefix) return prefix;
  }
  // Manually written captions before auto-generated ones
  return tracks.find((t) => t.kind !== 'asr') || tracks[0];
}

export async function getTranscript(videoId, { language, includeSegments = true, ...options } = {}) {
  const page = await getText(`${WATCH}${videoId}`, options);
  const apiKey = page.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1];
  if (!apiKey) {
    if (looksBlocked(page)) throw new BlockedError('YouTube served a bot check instead of the video page');
    throw new Error(`Video ${videoId} is unavailable (private, deleted or age-restricted)`);
  }

  const attempts = [];
  let blocked = false;
  let unavailable = false;
  for (const client of CLIENTS) {
    let data;
    try {
      data = await playerResponse(videoId, client, apiKey, options);
    } catch (e) {
      attempts.push(`${client.clientName}: ${e.message}`);
      continue;
    }

    const status = data.playabilityStatus?.status;
    const reason = data.playabilityStatus?.reason || '';
    const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const details = data.videoDetails || {};
    const micro = data.microformat?.playerMicroformatRenderer || {};

    if (status === 'LOGIN_REQUIRED' || looksBlocked(reason)) blocked = true;
    // "no longer supported in this application" is a deprecated client, not a dead video
    else if (status === 'ERROR' && /unavailable|removed|private/i.test(reason)) unavailable = true;

    if (!tracks.length) {
      attempts.push(`${client.clientName}: ${status || 'no captions'}${reason ? ` (${reason})` : ''}`);
      continue;
    }

    const track = pickTrack(tracks, language);
    const xml = await getText(track.baseUrl, options);
    const segments = parseTranscript(xml);
    if (!segments.length) {
      attempts.push(`${client.clientName}: caption file was empty`);
      continue;
    }

    return {
      videoId: details.videoId || videoId,
      title: details.title || micro.title?.simpleText || null,
      author: details.author || micro.ownerChannelName || null,
      channelId: details.channelId || micro.externalChannelId || null,
      durationSeconds: Number(details.lengthSeconds || micro.lengthSeconds || 0) || null,
      url: `https://www.youtube.com/watch?v=${details.videoId || videoId}`,
      language: track.languageCode,
      generated: track.kind === 'asr',
      availableLanguages: tracks.map((t) => t.languageCode),
      fullText: segments.map((s) => s.text).join(' '),
      totalSegments: segments.length,
      ...(includeSegments ? { segments } : {}),
    };
  }

  const detail = attempts.join('; ');
  if (blocked) throw new BlockedError(`YouTube asked every client to sign in for ${videoId} — ${detail}`);
  if (unavailable) throw new Error(`Video ${videoId} is unavailable (private, deleted, age-restricted or region-locked) — ${detail}`);
  throw new Error(`No captions available for ${videoId} — ${detail}`);
}

// --------------------------------------------------------------------------
// Playlists and search
// --------------------------------------------------------------------------
export async function playlistVideoIds(playlistId, limit, options) {
  const html = await getText(`https://www.youtube.com/playlist?list=${playlistId}`, options);
  const entries = new Map();
  const re = /"watchEndpoint":\{"videoId":"([a-zA-Z0-9_-]{11})","playlistId":"([^"]+)","index":(\d+)/g;
  for (const m of html.matchAll(re)) {
    if (m[2] === playlistId && !entries.has(m[1])) entries.set(m[1], Number(m[3]));
  }
  if (!entries.size) {
    if (looksBlocked(html)) throw new BlockedError('YouTube served a bot check instead of the playlist');
    throw new Error(`Playlist ${playlistId} is empty or private`);
  }
  return [...entries.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id).slice(0, limit);
}

export async function searchVideoIds(query, limit, options) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`;
  const html = await getText(url, options);
  const ids = [...new Set([...html.matchAll(/"videoRenderer":\{"videoId":"([a-zA-Z0-9_-]{11})"/g)].map((m) => m[1]))];
  if (!ids.length) {
    if (looksBlocked(html)) throw new BlockedError('YouTube served a bot check instead of search results');
    throw new Error(`No videos found for "${query}"`);
  }
  return ids.slice(0, limit);
}

// Several videos, one after another. A failed video is reported, not fatal.
export async function getTranscripts(videoIds, { onProgress, delayMs = 0, ...options } = {}) {
  const videos = [];
  for (const [index, videoId] of videoIds.entries()) {
    if (index > 0 && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    onProgress?.(index + 1, videoIds.length, videoId);
    try {
      videos.push(await getTranscript(videoId, options));
    } catch (e) {
      if (e instanceof BlockedError && !videos.length) throw e; // blocked from the start: no point continuing
      videos.push({ videoId, url: `https://www.youtube.com/watch?v=${videoId}`, skipped: true, reason: e.message });
    }
  }
  return {
    totalVideos: videos.length,
    successful: videos.filter((v) => !v.skipped).length,
    skipped: videos.filter((v) => v.skipped).length,
    videos,
  };
}

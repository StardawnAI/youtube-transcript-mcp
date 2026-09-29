#!/usr/bin/env node
// youtube-transcript-mcp — MCP server for YouTube transcripts.
//
//   youtube-transcript-mcp                 run the MCP server (stdio; this is what AI apps start)
//   youtube-transcript-mcp connect [apps]  register the server in Claude Code, Codex, Grok Build, Cursor, Antigravity
//   youtube-transcript-mcp doctor          check whether YouTube answers from this machine
//   youtube-transcript-mcp warp <start|stop|status>   Cloudflare WARP proxy (starts by itself for runs of many videos)
//   youtube-transcript-mcp transcript <url|search> [--type video|playlist|search] [--save-to dir] [--text]
import { fileURLToPath } from 'node:url';
import { runTool, serve, VERSION } from '../src/mcp-server.mjs';
import { BlockedError, getTranscript } from '../src/youtube.mjs';
import { CONFIG_FILE, resolveProxy } from '../src/config.mjs';
import { checkProxy, dockerAvailable, start as warpStart, status as warpStatus, stop as warpStop } from '../src/warp.mjs';
import { connect, detectClients, serverCommand } from '../src/connect.mjs';

const SELF = fileURLToPath(import.meta.url);
const TEST_VIDEO = 'jNQXAC9IVRw'; // "Me at the zoo", 19 seconds, has captions

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (['text', 'help', 'version', 'json'].includes(key)) flags[key] = true;
    else flags[key] = argv[++i];
  } else positional.push(a);
}

const log = console.log;
const fail = (message) => { console.error(`\n✗ ${message}`); process.exit(1); };

async function help() {
  const { readFile } = await import('node:fs/promises');
  const lines = (await readFile(SELF, 'utf8')).split('\n').slice(1);
  log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

async function doctor() {
  log(`youtube-transcript-mcp ${VERSION} — Node ${process.version}`);
  const proxy = await resolveProxy();
  log(`\nProxy:  ${proxy || 'none (direct)'}`);
  log(`Config: ${CONFIG_FILE}`);
  if (proxy) {
    const check = await checkProxy(proxy);
    log(check.ok ? `  ✓ proxy works, exit IP ${check.ip} (Cloudflare WARP)` : `  ! proxy reachable but not WARP: ${check.error || 'warp=off'}`);
  }

  process.stdout.write('\nFetching a test transcript … ');
  try {
    const result = await getTranscript(TEST_VIDEO, { proxy, includeSegments: false });
    log(`✓ "${result.title}" (${result.totalSegments} segments)`);
  } catch (e) {
    log('✗');
    if (e instanceof BlockedError) {
      log(`  YouTube blocks this IP: ${e.message}`);
      log(dockerAvailable()
        ? '  Fix: youtube-transcript-mcp warp start   (free Cloudflare WARP proxy in Docker)'
        : '  Fix: start Docker, then "youtube-transcript-mcp warp start", or set YOUTUBE_TRANSCRIPT_PROXY to an HTTP proxy.');
    } else {
      log(`  ${e.message}`);
    }
    process.exitCode = 2;
  }

  const found = await detectClients();
  log(`\nAI apps found: ${found.length ? found.join(', ') : 'none'}`);
  log(found.length ? 'Register the server with: youtube-transcript-mcp connect' : '');
}

async function warp(action = 'status') {
  if (action === 'start') {
    const { proxy, ip } = await warpStart({ log: (m) => log(`  ${m}`) });
    log(`\n✓ WARP is up: ${proxy} (exit IP ${ip})`);
    log(`  Saved to ${CONFIG_FILE} — running servers pick it up on the next call.`);
    return;
  }
  if (action === 'stop') {
    const existed = await warpStop();
    log(existed ? '✓ WARP container removed, proxy setting cleared' : 'No WARP container was running; proxy setting cleared');
    return;
  }
  const state = await warpStatus();
  if (!state.exists) return log('WARP container: not created (start it with "warp start")');
  if (!state.running) return log('WARP container: stopped');
  log(`WARP container: running on ${state.proxy}`);
  log(state.ok ? `  ✓ traffic exits via Cloudflare (${state.ip})` : `  ! proxy is up but not tunnelling: ${state.error || 'warp=off'}`);
}

async function doConnect(apps) {
  const keys = apps.length ? apps : await detectClients();
  if (!keys.length) return log('No supported AI app found (Claude Code, Codex, Grok Build, Cursor, Antigravity).');
  if (/[\\/]_npx[\\/]|[\\/]npm-cache[\\/]/.test(SELF)) {
    fail('This copy lives in the npx cache, which gets cleaned up.\n  Install it first: npm install -g github:StardawnAI/youtube-transcript-mcp');
  }
  log(`Registering this server (${SELF}) in: ${keys.join(', ')}`);
  const done = await connect(keys, SELF, log);
  if (done.includes('claude')) log('\nClaude Code: run /reload-plugins or restart it.');
  if (done.some((k) => k !== 'claude')) log('Restart the other apps to load the server.');
  const { command, args } = serverCommand(SELF);
  log(`\nAny other MCP client: command ${JSON.stringify(command)}, args ${JSON.stringify(args)}`);
}

// The same code path as the MCP tool: routing, WARP, files for playlists and searches.
async function transcript(target) {
  if (!target) fail('Usage: youtube-transcript-mcp transcript <url|video id|search phrase> [--type video|playlist|search] [--language en] [--max-videos 25] [--save-to dir] [--proxy http://…] [--text]');
  if (flags.proxy) process.env.YOUTUBE_TRANSCRIPT_PROXY = flags.proxy;
  const result = await runTool({
    youtube_url: target,
    url_type: flags.type,
    language: flags.language,
    max_videos: Number(flags['max-videos']) || undefined,
    save_to: flags['save-to'],
    include_segments: !flags.text,
  }, { notify: (message) => console.error(message) });

  if (flags.text && !result.videos) return log(`--- ${result.title}\n${result.fullText}`);
  log(JSON.stringify(result, null, 2));
}

const [command, ...rest] = positional;
try {
  if (flags.version) log(VERSION);
  else if (flags.help || command === 'help') await help();
  else if (!command || command === 'serve') serve();
  else if (command === 'doctor') await doctor();
  else if (command === 'warp') await warp(rest[0]);
  else if (command === 'connect') await doConnect(rest);
  else if (command === 'transcript') await transcript(rest.join(' '));
  else fail(`Unknown command "${command}". Try --help.`);
} catch (e) {
  fail(e.message);
}

#!/usr/bin/env node
// YouTube Transcript MCP — setup
//
// Imports the two n8n workflows through the n8n public API, wires them
// together, creates the bearer-token credential, activates the MCP server,
// tests it end to end and registers it in Claude Code (as a plugin), Codex,
// Cursor and Antigravity. Safe to re-run: existing workflows are updated in
// place and the token is rotated.
//
// Usage:
//   node scripts/setup.mjs [options]
//
// Options (all optional; you are prompted for what is missing):
//   --n8n-url <url>        Base URL of your n8n, e.g. https://n8n.example.com  (env: N8N_URL)
//   --api-key <key>        n8n API key (Settings → n8n API)                     (env: N8N_API_KEY)
//   --proxy <url|none>     Proxy for YouTube requests. Default: http://warp:1080
//                          Use "none" when n8n runs on a home connection.
//   --mcp-base-url <url>   Public base URL for webhooks, if it differs from --n8n-url
//   --clients <list>       auto (default) | none | comma list of: claude,codex,cursor,antigravity
//   --test-video <url>     Video used for the end-to-end test
//   --skip-test            Do not call the MCP server after setup
//   --yes                  Do not ask before writing client config files
//   --marketplace <src>    Claude Code marketplace source (default: StardawnAI/youtube-transcript-mcp)

import { readFile, writeFile, mkdir, copyFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const REPO_RAW = 'https://raw.githubusercontent.com/StardawnAI/youtube-transcript-mcp/main';
const DEFAULT_PROXY = 'http://warp:1080';
const DEFAULT_TEST_VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const TRANSCRIPT_NAME = 'YouTube Transcript';
const MCP_NAME = 'YouTube Transcript MCP Server';
const CREDENTIAL_NAME = 'YouTube Transcript MCP Bearer';
const SERVER_KEY = 'youtube-transcript';
const MARKETPLACE = 'StardawnAI/youtube-transcript-mcp';
const PLUGIN_ID = 'youtube-transcript@stardawn-ai';
const ALL_CLIENTS = ['claude', 'codex', 'cursor', 'antigravity'];

// ---------------------------------------------------------------------------
// CLI + prompts
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (['yes', 'skip-test', 'help'].includes(key)) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

const interactive = process.stdin.isTTY && process.stdout.isTTY;

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(question); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function confirm(question, assumeYes) {
  if (assumeYes) return true;
  if (!interactive) return false;
  const a = (await ask(`${question} [Y/n] `)).toLowerCase();
  return a === '' || a === 'y' || a === 'yes';
}

const log = (s = '') => console.log(s);
const step = (s) => console.log(`\n▸ ${s}`);
const ok = (s) => console.log(`  ✓ ${s}`);
const warn = (s) => console.log(`  ! ${s}`);

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// n8n API
// ---------------------------------------------------------------------------
function createApi(baseUrl, apiKey) {
  return async function api(method, path, body) {
    let res;
    try {
      res = await fetch(`${baseUrl}/api/v1${path}`, {
        method,
        headers: { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`Cannot reach ${baseUrl} (${e.cause?.code || e.message})`);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const err = new Error(`${method} ${path} failed (${res.status}): ${data?.message || text || res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
}

async function findWorkflowByName(api, name) {
  let cursor;
  do {
    const page = await api('GET', `/workflows?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const hit = page.data.find((w) => w.name === name && !w.isArchived);
    if (hit) return api('GET', `/workflows/${hit.id}`);
    cursor = page.nextCursor;
  } while (cursor);
  return null;
}

async function upsertWorkflow(api, workflow, existing) {
  const body = { name: workflow.name, nodes: workflow.nodes, connections: workflow.connections, settings: workflow.settings };
  if (existing) return api('PUT', `/workflows/${existing.id}`, body);
  return api('POST', '/workflows', body);
}

async function activate(api, id) {
  return api('POST', `/workflows/${id}/activate`);
}

// ---------------------------------------------------------------------------
// Workflow templates
// ---------------------------------------------------------------------------
async function loadTemplate(file) {
  const local = join(dirname(fileURLToPath(import.meta.url)), '..', 'n8n', file);
  try {
    return JSON.parse(await readFile(local, 'utf8'));
  } catch {
    const res = await fetch(`${REPO_RAW}/n8n/${file}`);
    if (!res.ok) throw new Error(`Could not load workflow template ${file} (${res.status})`);
    return res.json();
  }
}

function applyProxy(workflow, proxy) {
  let count = 0;
  for (const node of workflow.nodes) {
    if (node.type !== 'n8n-nodes-base.httpRequest' || node.parameters?.options?.proxy !== DEFAULT_PROXY) continue;
    if (proxy) node.parameters.options.proxy = proxy;
    else delete node.parameters.options.proxy;
    count++;
  }
  for (const node of workflow.nodes) if (node.webhookId) node.webhookId = randomUUID();
  return count;
}

// ---------------------------------------------------------------------------
// MCP client (streamable HTTP, JSON or SSE responses)
// ---------------------------------------------------------------------------
async function mcpRequest(url, token, message, sessionId) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  const session = res.headers.get('mcp-session-id') || sessionId;
  if (!res.ok && res.status !== 202) {
    const err = new Error(`MCP ${message.method} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  if (message.id === undefined) return { session };
  const payloads = text.includes('data:')
    ? text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
    : [JSON.parse(text)];
  const reply = payloads.find((p) => p.id === message.id) || payloads[payloads.length - 1];
  if (reply?.error) throw new Error(`MCP ${message.method} error: ${reply.error.message}`);
  return { session, result: reply?.result };
}

async function testMcp(url, token, testVideo) {
  let init;
  for (let attempt = 1; ; attempt++) {
    try {
      init = await mcpRequest(url, token, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'youtube-transcript-setup', version: '1.0.0' } },
      });
      break;
    } catch (e) {
      // A freshly activated webhook can take a moment to register
      if (e.status === 404 && attempt < 5) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      throw e;
    }
  }
  ok(`MCP server answers (${init.result?.serverInfo?.name || 'n8n'})`);
  await mcpRequest(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.session);

  const list = await mcpRequest(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.session);
  const tool = list.result?.tools?.find((t) => t.name === 'get_youtube_transcript');
  if (!tool) throw new Error('Tool get_youtube_transcript not found on the MCP server');
  ok('Tool get_youtube_transcript is listed');

  if (!testVideo) return;
  log(`  … fetching a test transcript (${testVideo}), this takes 5–30 seconds`);
  const call = await mcpRequest(url, token, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'get_youtube_transcript', arguments: { youtube_url: testVideo, url_type: 'video' } },
  }, init.session);
  const text = (call.result?.content || []).map((c) => c.text || '').join('\n');
  if (call.result?.isError || !text.includes('fullText')) {
    throw new Error(`Test transcript failed: ${text.slice(0, 300) || 'empty response'}`);
  }
  const fullText = text.match(/"fullText"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] || '';
  ok(`Transcript received: "${fullText.slice(0, 80)}${fullText.length > 80 ? '…' : ''}"`);
}

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------
const exists = (p) => access(p).then(() => true, () => false);

async function backupAndWrite(file, content) {
  await mkdir(dirname(file), { recursive: true });
  if (await exists(file)) await copyFile(file, `${file}.bak`);
  await writeFile(file, content);
}

async function readJson(file) {
  if (!(await exists(file))) return {};
  const raw = (await readFile(file, 'utf8')).trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error(`${file} is not valid JSON — fix or remove it, then re-run`); }
}

function upsertTomlTable(text, header, bodyLines) {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) return [...(lines.length === 1 && lines[0] === '' ? [] : [...lines, '']), header, ...bodyLines, ''].join('\n');
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  return [...lines.slice(0, start), header, ...bodyLines, '', ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

const home = homedir();

// The claude CLI: on PATH, in the native install dirs, or bundled with the
// VS Code / Cursor extension (newest version wins).
async function findClaude() {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  dirs.push(join(home, '.local', 'bin'), join(home, '.claude', 'local'));
  for (const dir of dirs) for (const name of names) if (await exists(join(dir, name))) return join(dir, name);

  const version = (s) => (s.match(/(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0]).slice(1).map(Number);
  const newer = (a, b) => { const [x, y] = [version(a), version(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  for (const extDir of [join(home, '.vscode', 'extensions'), join(home, '.cursor', 'extensions')]) {
    const entries = await readdir(extDir).catch(() => []);
    const latest = entries.filter((e) => e.startsWith('anthropic.claude-code-')).sort(newer).pop();
    const bin = latest && join(extDir, latest, 'resources', 'native-binary', names[0]);
    if (bin && (await exists(bin))) return bin;
  }
  return null;
}

const CLIENTS = {
  claude: {
    label: 'Claude Code',
    target: `plugin ${PLUGIN_ID}`,
    detect: async () => Boolean(await findClaude()),
    async write(url, token, { marketplace }) {
      const bin = await findClaude();
      const run = (cmdArgs) => {
        const r = spawnSync(bin, cmdArgs, { encoding: 'utf8', shell: bin.endsWith('.cmd') });
        if (r.status !== 0) {
          const out = `${r.stderr || ''}${r.stdout || ''}`.trim() || r.error?.message || `exit ${r.status}`;
          throw new Error(`claude ${cmdArgs.slice(0, 3).join(' ')} failed: ${out.split('\n').pop()}`);
        }
      };
      run(['plugin', 'marketplace', 'add', marketplace]);
      // Installing again on an existing install just updates the options
      run(['plugin', 'install', PLUGIN_ID, '--config', `mcp_url=${url}`, '--config', `mcp_token=${token}`]);
    },
  },
  codex: {
    label: 'Codex (CLI, IDE extension, ChatGPT app)',
    file: join(home, '.codex', 'config.toml'),
    detect: () => exists(join(home, '.codex')),
    async write(url, token) {
      const text = (await exists(this.file)) ? await readFile(this.file, 'utf8') : '';
      const next = upsertTomlTable(text, `[mcp_servers.${SERVER_KEY}]`, [
        `url = ${JSON.stringify(url)}`,
        `http_headers = { "Authorization" = ${JSON.stringify(`Bearer ${token}`)} }`,
        '# playlist and search calls take several minutes',
        'tool_timeout_sec = 900',
      ]);
      await backupAndWrite(this.file, next);
    },
  },
  cursor: {
    label: 'Cursor',
    file: join(home, '.cursor', 'mcp.json'),
    detect: () => exists(join(home, '.cursor')),
    async write(url, token) {
      const cfg = await readJson(this.file);
      cfg.mcpServers = { ...(cfg.mcpServers || {}), [SERVER_KEY]: { url, headers: { Authorization: `Bearer ${token}` } } };
      await backupAndWrite(this.file, JSON.stringify(cfg, null, 2) + '\n');
    },
  },
  antigravity: {
    label: 'Antigravity',
    file: join(home, '.gemini', 'config', 'mcp_config.json'),
    detect: async () => (await exists(join(home, '.gemini', 'antigravity'))) || (await exists(join(home, '.gemini', 'config'))),
    async write(url, token) {
      // Bridged through mcp-remote: Antigravity's native HTTP transport has
      // open bugs with bearer headers on n8n MCP endpoints.
      const bridgeArgs = ['-y', 'mcp-remote@latest', url, '--header', 'Authorization:${AUTH_HEADER}', '--transport', 'http-only'];
      const entry = process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'npx', ...bridgeArgs] }
        : { command: 'npx', args: bridgeArgs };
      entry.env = { AUTH_HEADER: `Bearer ${token}` };
      const cfg = await readJson(this.file);
      cfg.mcpServers = { ...(cfg.mcpServers || {}), [SERVER_KEY]: entry };
      await backupAndWrite(this.file, JSON.stringify(cfg, null, 2) + '\n');
    },
  },
};

async function configureClients(selection, url, token, assumeYes, options) {
  step('Connecting AI clients');
  let wanted;
  if (selection === 'none') wanted = [];
  else if (!selection || selection === 'auto') {
    wanted = [];
    for (const key of ALL_CLIENTS) if (await CLIENTS[key].detect()) wanted.push(key);
    if (!wanted.length) log('  No Claude Code, Codex, Cursor or Antigravity installation found.');
  } else {
    wanted = selection.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = wanted.filter((k) => !CLIENTS[k]);
    if (unknown.length) fail(`Unknown client(s): ${unknown.join(', ')}. Valid: ${ALL_CLIENTS.join(', ')}`);
    assumeYes = true;
  }

  const done = [];
  for (const key of wanted) {
    const client = CLIENTS[key];
    const target = client.target || client.file;
    if (!(await confirm(`  Add the MCP server to ${client.label} (${target})?`, assumeYes))) {
      log(`  – skipped ${client.label}${interactive ? '' : ' (re-run with --yes to write it)'}`);
      continue;
    }
    try {
      await client.write(url, token, options);
      ok(`${client.label}: ${target} (restart the app to load it)`);
      done.push(key);
    } catch (e) {
      warn(`${client.label}: ${e.message}`);
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    const lines = (await readFile(fileURLToPath(import.meta.url), 'utf8')).split('\n');
    log(lines.slice(1, lines.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }

  log('YouTube Transcript MCP — setup');

  let n8nUrl = args['n8n-url'] || process.env.N8N_URL;
  let apiKey = args['api-key'] || process.env.N8N_API_KEY;
  if (!n8nUrl && interactive) n8nUrl = await ask('n8n URL (e.g. https://n8n.example.com): ');
  if (!apiKey && interactive) apiKey = await ask('n8n API key (Settings → n8n API): ', { hidden: true });
  if (!n8nUrl || !apiKey) fail('n8n URL and API key are required (--n8n-url/--api-key or N8N_URL/N8N_API_KEY).');
  n8nUrl = n8nUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  if (!/^https?:\/\//.test(n8nUrl)) n8nUrl = `https://${n8nUrl}`;
  const mcpBase = (args['mcp-base-url'] || n8nUrl).replace(/\/+$/, '');

  const proxyArg = args.proxy ?? DEFAULT_PROXY;
  const proxy = ['none', 'off', ''].includes(proxyArg.toLowerCase()) ? null : proxyArg;

  const api = createApi(n8nUrl, apiKey);

  step(`Checking n8n at ${n8nUrl}`);
  try {
    await api('GET', '/workflows?limit=1');
  } catch (e) {
    if (e.status === 401 || e.status === 403) fail('n8n rejected the API key. Create one under Settings → n8n API.');
    fail(e.message);
  }
  ok('API key accepted');

  step('Importing workflows');
  const transcript = await loadTemplate('youtube-transcript.json');
  const server = await loadTemplate('youtube-transcript-mcp-server.json');
  const proxied = applyProxy(transcript, proxy);
  ok(proxy ? `${proxied} YouTube requests use proxy ${proxy}` : `Proxy disabled for ${proxied} YouTube requests`);

  const existingTranscript = await findWorkflowByName(api, TRANSCRIPT_NAME);
  const savedTranscript = await upsertWorkflow(api, transcript, existingTranscript);
  ok(`${existingTranscript ? 'Updated' : 'Created'} workflow "${TRANSCRIPT_NAME}" (${savedTranscript.id})`);
  try {
    await activate(api, savedTranscript.id);
    ok('Transcript workflow published');
  } catch (e) {
    // Older n8n versions cannot activate a workflow whose only trigger is
    // "When Executed by Another Workflow"; it is callable anyway.
    warn(`Transcript workflow not activated (${e.message.replace(/^.*?: /, '')}) — fine on older n8n versions`);
  }

  const existingServer = await findWorkflowByName(api, MCP_NAME);
  const oldTrigger = existingServer?.nodes.find((n) => n.type === '@n8n/n8n-nodes-langchain.mcpTrigger');
  const mcpPath = oldTrigger?.parameters?.path || randomUUID();
  const oldCredential = oldTrigger?.credentials?.httpBearerAuth;

  const token = randomBytes(32).toString('base64url');
  const credentialName = `${CREDENTIAL_NAME} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const credential = await api('POST', '/credentials', { name: credentialName, type: 'httpBearerAuth', data: { token } });
  ok(`Created credential "${credentialName}" with a new random token`);

  const trigger = server.nodes.find((n) => n.type === '@n8n/n8n-nodes-langchain.mcpTrigger');
  trigger.parameters.path = mcpPath;
  trigger.webhookId = mcpPath;
  trigger.credentials = { httpBearerAuth: { id: credential.id, name: credentialName } };
  const tool = server.nodes.find((n) => n.type === '@n8n/n8n-nodes-langchain.toolWorkflow');
  tool.parameters.workflowId = { __rl: true, mode: 'id', value: savedTranscript.id, cachedResultName: TRANSCRIPT_NAME };

  const savedServer = await upsertWorkflow(api, server, existingServer);
  ok(`${existingServer ? 'Updated' : 'Created'} workflow "${MCP_NAME}" (${savedServer.id})`);
  try {
    await activate(api, savedServer.id);
  } catch (e) {
    fail(`Could not activate the MCP server workflow: ${e.message}`);
  }
  ok('MCP server workflow active');

  if (oldCredential?.id && oldCredential.id !== credential.id) {
    try {
      await api('DELETE', `/credentials/${oldCredential.id}`);
      ok('Removed the previous token credential');
    } catch {
      // Some n8n versions reject credential deletes through the public API
      warn(`The previous token no longer works. Delete the unused credential "${oldCredential.name}" in n8n → Credentials if you like.`);
    }
  }

  const mcpUrl = `${mcpBase}/mcp/${mcpPath}`;

  if (!args['skip-test']) {
    step('Testing the MCP server');
    try {
      await testMcp(mcpUrl, token, args['test-video'] || DEFAULT_TEST_VIDEO);
    } catch (e) {
      warn(e.message);
      warn('The workflows are installed, but the test failed. Most common causes:');
      warn('  • WARP proxy not running or not on the n8n Docker network → run docker/install-warp.sh on the n8n host');
      warn('  • n8n on a home connection without WARP → re-run with --proxy none');
      warn('  • n8n webhooks use a different public URL → re-run with --mcp-base-url https://…');
      process.exitCode = 2;
    }
  }

  const configured = await configureClients(args.clients, mcpUrl, token, Boolean(args.yes), {
    marketplace: args.marketplace || MARKETPLACE,
  });

  log('\n────────────────────────────────────────────────────────────');
  log('MCP URL:   ' + mcpUrl);
  log('MCP token: ' + token);
  log('Keep the token secret. Re-running setup replaces it.');
  log('────────────────────────────────────────────────────────────');
  if (!configured.includes('claude')) {
    log('\nClaude Code (plugin — paste URL and token when asked):');
    log(`  /plugin marketplace add ${MARKETPLACE}`);
    log(`  /plugin install ${PLUGIN_ID}`);
  }
  if (configured.length) log(`\nConfigured: ${configured.join(', ')} — restart those apps to load the server.`);
  log('\nOther MCP clients: streamable HTTP, header "Authorization: Bearer <token>". See README.');
}

main().catch((e) => fail(e.message));

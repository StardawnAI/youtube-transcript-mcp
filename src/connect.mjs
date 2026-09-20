// Registers this MCP server in the AI apps installed on this machine.
// Everything is local and stdio, so there is no URL and no token to hand out.
import { readFile, writeFile, mkdir, copyFile, access, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const SERVER_KEY = 'youtube-transcript';
const MARKETPLACE = 'https://github.com/StardawnAI/youtube-transcript-mcp.git';
const PLUGIN_ID = 'youtube-transcript@stardawn-ai';
const home = homedir();

const exists = (p) => access(p).then(() => true, () => false);
const exeNames = (cmd) => (process.platform === 'win32' ? [`${cmd}.exe`, `${cmd}.cmd`] : [cmd]);

async function findOnPath(names, extraDirs = []) {
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of [...dirs, ...extraDirs]) for (const name of names) if (await exists(join(dir, name))) return join(dir, name);
  return null;
}

// The claude CLI: on PATH, in the native install dirs, or bundled with the
// VS Code / Cursor extension (newest version wins).
async function findClaude() {
  const names = exeNames('claude');
  const found = await findOnPath(names, [join(home, '.local', 'bin'), join(home, '.claude', 'local')]);
  if (found) return found;
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

async function backupAndWrite(file, content) {
  await mkdir(dirname(file), { recursive: true });
  if (await exists(file)) await copyFile(file, `${file}.bak`);
  await writeFile(file, content);
}

async function readJson(file) {
  if (!(await exists(file))) return {};
  const raw = (await readFile(file, 'utf8')).trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error(`${file} is not valid JSON — fix or remove it, then try again`); }
}

function upsertTomlTable(text, header, bodyLines) {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) return [...(lines.length === 1 && lines[0] === '' ? [] : [...lines, '']), header, ...bodyLines, ''].join('\n');
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  return [...lines.slice(0, start), header, ...bodyLines, '', ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

// Absolute paths, because GUI apps do not always inherit the shell's PATH.
export function serverCommand(serverPath) {
  return { command: process.execPath, args: [serverPath] };
}

export const CLIENTS = {
  claude: {
    label: 'Claude Code',
    target: `plugin ${PLUGIN_ID}`,
    detect: async () => Boolean(await findClaude()),
    async write() {
      const bin = await findClaude();
      const run = (args) => {
        const r = spawnSync(bin, args, { encoding: 'utf8', shell: bin.endsWith('.cmd') });
        if (r.status !== 0) {
          const out = `${r.stderr || ''}${r.stdout || ''}`.trim() || r.error?.message || `exit ${r.status}`;
          throw new Error(`claude ${args.slice(0, 3).join(' ')} failed: ${out.split('\n').pop()}`);
        }
      };
      run(['plugin', 'marketplace', 'add', MARKETPLACE]);
      run(['plugin', 'install', PLUGIN_ID]);
    },
  },
  codex: {
    label: 'Codex',
    file: join(home, '.codex', 'config.toml'),
    detect: () => exists(join(home, '.codex')),
    async write(serverPath) {
      const { command, args } = serverCommand(serverPath);
      const text = (await exists(this.file)) ? await readFile(this.file, 'utf8') : '';
      await backupAndWrite(this.file, upsertTomlTable(text, `[mcp_servers.${SERVER_KEY}]`, [
        `command = ${JSON.stringify(command)}`,
        `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
        '# playlist and search calls take a few minutes',
        'tool_timeout_sec = 900',
      ]));
    },
  },
  grok: {
    label: 'Grok Build',
    file: join(process.env.GROK_HOME || join(home, '.grok'), 'config.toml'),
    detect: async () => (await exists(join(home, '.grok'))) || Boolean(await findOnPath(exeNames('grok'))),
    async write(serverPath) {
      const { command, args } = serverCommand(serverPath);
      const text = (await exists(this.file)) ? await readFile(this.file, 'utf8') : '';
      await backupAndWrite(this.file, upsertTomlTable(text, `[mcp_servers.${SERVER_KEY}]`, [
        `command = ${JSON.stringify(command)}`,
        `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
        'tool_timeout_sec = 900',
      ]));
    },
  },
  cursor: {
    label: 'Cursor',
    file: join(home, '.cursor', 'mcp.json'),
    detect: () => exists(join(home, '.cursor')),
    async write(serverPath) {
      const cfg = await readJson(this.file);
      cfg.mcpServers = { ...(cfg.mcpServers || {}), [SERVER_KEY]: serverCommand(serverPath) };
      await backupAndWrite(this.file, `${JSON.stringify(cfg, null, 2)}\n`);
    },
  },
  antigravity: {
    label: 'Antigravity',
    file: join(home, '.gemini', 'config', 'mcp_config.json'),
    detect: async () => (await exists(join(home, '.gemini', 'antigravity'))) || (await exists(join(home, '.gemini', 'config'))),
    async write(serverPath) {
      const cfg = await readJson(this.file);
      cfg.mcpServers = { ...(cfg.mcpServers || {}), [SERVER_KEY]: serverCommand(serverPath) };
      await backupAndWrite(this.file, `${JSON.stringify(cfg, null, 2)}\n`);
    },
  },
};

export async function detectClients() {
  const found = [];
  for (const [key, client] of Object.entries(CLIENTS)) if (await client.detect()) found.push(key);
  return found;
}

export async function connect(keys, serverPath, log = console.log) {
  const done = [];
  for (const key of keys) {
    const client = CLIENTS[key];
    if (!client) throw new Error(`Unknown app "${key}". Known: ${Object.keys(CLIENTS).join(', ')}`);
    try {
      await client.write(serverPath);
      log(`  ✓ ${client.label}: ${client.target || client.file}`);
      done.push(key);
    } catch (e) {
      log(`  ! ${client.label}: ${e.message}`);
    }
  }
  return done;
}

// Small JSON config next to the user's other app settings. Only the proxy
// lives here, so `warp start` can hand the running server a proxy without a
// restart: the server reads the file on every call.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const dir =
  platform() === 'win32'
    ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'youtube-transcript-mcp')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'youtube-transcript-mcp');

export const CONFIG_FILE = join(dir, 'config.json');

export async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export async function writeConfig(patch) {
  const config = { ...(await readConfig()), ...patch };
  for (const [k, v] of Object.entries(config)) if (v === null) delete config[k];
  await mkdir(dir, { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

// A proxy somebody chose on purpose: named on the command line or in the
// environment. Told apart from the one in the config file because they mean
// different things — this one is somebody else's proxy and is simply used,
// while the config file only remembers a WARP container this tool started, and
// that container may have stopped since it was written there.
export function configuredProxy(cliProxy) {
  const proxy = cliProxy || process.env.YOUTUBE_TRANSCRIPT_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy;
  return !proxy || proxy === 'none' ? null : proxy;
}

// Command line beats environment beats config file.
export async function resolveProxy(cliProxy) {
  const proxy = configuredProxy(cliProxy) || (await readConfig()).proxy || null;
  if (!proxy || proxy === 'none') return null;
  return proxy;
}

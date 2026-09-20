// Cloudflare WARP as a local HTTP proxy, in one Docker container.
//
// Only needed where YouTube blocks the IP — data centres, cloud servers, CI.
// WARP is free and needs no account. The proxy port is bound to 127.0.0.1, so
// nobody else can use the machine as an open proxy.
import { spawnSync } from 'node:child_process';
import { getText } from './http.mjs';
import { writeConfig } from './config.mjs';

export const CONTAINER = 'youtube-transcript-warp';
const IMAGE = 'caomingjun/warp:latest';
const TRACE = 'https://www.cloudflare.com/cdn-cgi/trace';

const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts });

export function dockerAvailable() {
  const r = docker(['info', '--format', '{{.ServerVersion}}']);
  return r.status === 0;
}

function containerState() {
  const r = docker(['inspect', '-f', '{{.State.Running}}|{{index .NetworkSettings.Ports "1080/tcp" 0 "HostPort"}}', CONTAINER]);
  if (r.status !== 0) return { exists: false };
  const [running, port] = r.stdout.trim().split('|');
  return { exists: true, running: running === 'true', port: Number(port) || 1080 };
}

// Does traffic through the proxy really leave via Cloudflare?
export async function checkProxy(proxy) {
  try {
    const trace = await getText(TRACE, { proxy, retries: 1, timeout: 15000 });
    return { ok: /^warp=(on|plus)/m.test(trace), ip: trace.match(/^ip=(.+)$/m)?.[1] || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function status() {
  const state = containerState();
  if (!state.exists || !state.running) return { ...state, proxy: null };
  const proxy = `http://127.0.0.1:${state.port}`;
  return { ...state, proxy, ...(await checkProxy(proxy)) };
}

export async function start({ port = 1080, log = () => {} } = {}) {
  if (!dockerAvailable()) {
    throw new Error('Docker is not running. Start Docker Desktop (or install Docker), then try again.');
  }

  const state = containerState();
  if (state.exists) {
    if (!state.running) docker(['start', CONTAINER]);
    log(`reusing container ${CONTAINER}`);
    port = state.port;
  } else {
    log(`starting ${IMAGE} as ${CONTAINER}`);
    const run = docker([
      'run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped',
      '-p', `127.0.0.1:${port}:1080`,
      '--device-cgroup-rule', 'c 10:200 rwm',
      '--cap-add', 'MKNOD', '--cap-add', 'AUDIT_WRITE', '--cap-add', 'NET_ADMIN',
      '--sysctl', 'net.ipv6.conf.all.disable_ipv6=0',
      '--sysctl', 'net.ipv4.conf.all.src_valid_mark=1',
      '-e', 'WARP_SLEEP=2',
      '-v', `${CONTAINER}-data:/var/lib/cloudflare-warp`,
      IMAGE,
    ]);
    if (run.status !== 0) throw new Error(`docker run failed: ${(run.stderr || run.stdout).trim()}`);
  }

  const proxy = `http://127.0.0.1:${port}`;
  log('waiting for the WARP tunnel (up to 90 s)');
  for (let i = 0; i < 30; i++) {
    const check = await checkProxy(proxy);
    if (check.ok) {
      await writeConfig({ proxy });
      return { proxy, ip: check.ip };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`WARP did not connect. Check: docker logs ${CONTAINER}`);
}

export async function stop() {
  const state = containerState();
  if (state.exists) docker(['rm', '-f', CONTAINER]);
  await writeConfig({ proxy: null });
  return state.exists;
}

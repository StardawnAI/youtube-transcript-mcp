// Cloudflare WARP as a local HTTP proxy, in one Docker container.
//
// The route for runs of many videos and for IPs YouTube blocks — YouTube refuses
// a plain IP after roughly seven videos in a row, and data centres at once.
// WARP is free and needs no account. The proxy port is bound to 127.0.0.1, so
// nobody else can use the machine as an open proxy.
import { spawnSync } from 'node:child_process';
import { getText } from './http.mjs';
import { writeConfig } from './config.mjs';

export const CONTAINER = 'youtube-transcript-warp';
const IMAGE = 'caomingjun/warp:latest';
const TRACE = 'https://www.cloudflare.com/cdn-cgi/trace';
// A video that always has captions: if its page answers, YouTube accepts this exit.
const PROBE = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
// How many fresh WARP identities a start tries before it settles for what it has.
const MAX_ROTATIONS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts });

export function dockerAvailable() {
  const r = docker(['info', '--format', '{{.ServerVersion}}']);
  return r.status === 0;
}

function containerState() {
  // The port comes from the container's configuration, not from its network
  // settings: those are empty while the container is stopped, which used to make
  // a stopped container look like a missing one.
  const r = docker(['inspect', '-f', '{{.State.Running}}|{{range (index .HostConfig.PortBindings "1080/tcp")}}{{.HostPort}}{{end}}', CONTAINER]);
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

// A tunnel is not enough. YouTube refuses some WARP exit addresses — measured from
// a data centre: one in three identities worked — and the refusal looks exactly
// like the block this proxy is there to avoid.
//
// The first requests after a tunnel (re)connects can fail even on an address YouTube
// accepts — measured: an identity refused right after the switch answered eight of
// eight probes a minute later — so an address only counts as refused after a few
// tries a few seconds apart.
export async function youtubeReachable(proxy, { attempts = 3, gapMs = 4000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const page = await getText(PROBE, { proxy, retries: 1, timeout: 20000 });
      if (/"playabilityStatus":\{"status":"OK"/.test(page)) return true;
    } catch {
      // counts as a failed try
    }
    if (i < attempts - 1) await sleep(gapMs);
  }
  return false;
}

// Another WARP identity, which means another exit address, in the running
// container: no restart, no new container.
export async function rotate({ log = () => {} } = {}) {
  const state = containerState();
  if (!state.exists || !state.running) throw new Error(`${CONTAINER} is not running`);
  const cli = (...args) => docker(['exec', CONTAINER, 'warp-cli', '--accept-tos', ...args]);
  log('YouTube refuses this WARP exit address — switching to a new WARP identity');
  cli('registration', 'delete');
  await sleep(2000);
  if (cli('registration', 'new').status !== 0) {
    await sleep(3000);
    cli('registration', 'new');
  }
  cli('connect');
  const proxy = `http://127.0.0.1:${state.port}`;
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const check = await checkProxy(proxy);
    if (check.ok) return { proxy, ip: check.ip };
  }
  throw new Error('WARP did not reconnect after switching its identity');
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
  // Steps to take, by number of waits, while an existing container is not yet
  // tunnelling. A tunnel that was disconnected — by hand, or by the machine
  // going to sleep — stays down until it is told to connect, and that state
  // survives a container restart, so a restart alone is not enough.
  let recovery = {};
  if (state.exists) {
    port = state.port;
    const reconnect = () => docker(['exec', CONTAINER, 'warp-cli', '--accept-tos', 'connect']);
    const restart = () => { log(`${CONTAINER} still has no tunnel — restarting it`); docker(['restart', CONTAINER]); };
    if (!state.running) {
      log(`starting the stopped container ${CONTAINER}`);
      docker(['start', CONTAINER]);
      recovery = { 3: reconnect };
    } else if (!(await checkProxy(`http://127.0.0.1:${port}`)).ok) {
      // The proxy port can stay open while the tunnel behind it is gone, and the
      // port then forwards traffic without the tunnel.
      log(`${CONTAINER} is running but its tunnel is down — reconnecting it`);
      reconnect();
      recovery = { 3: reconnect, 6: restart, 11: reconnect };
    } else {
      log(`reusing container ${CONTAINER}`);
    }
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
      // Heals itself. When the WARP daemon dies, the proxy port stays open and
      // forwards traffic without the tunnel, and Docker only restarts a container
      // that exits. The container's main process is the proxy `gost`, so the
      // check stops it after two failed looks, the container exits, and the
      // restart policy brings it back with a fresh tunnel.
      '--health-cmd', '/healthcheck/index.sh || (sleep 5; /healthcheck/index.sh) || pkill gost',
      '--health-interval', '30s', '--health-timeout', '20s', '--health-retries', '2', '--health-start-period', '60s',
      IMAGE,
    ]);
    if (run.status !== 0) throw new Error(`docker run failed: ${(run.stderr || run.stdout).trim()}`);
  }

  const proxy = `http://127.0.0.1:${port}`;
  log('waiting for the WARP tunnel (up to 90 s)');
  for (let i = 0; i < 30; i++) {
    const check = await checkProxy(proxy);
    if (check.ok) {
      let ip = check.ip;
      for (let tries = 0; tries < MAX_ROTATIONS && !(await youtubeReachable(proxy)); tries++) {
        ({ ip } = await rotate({ log }));
      }
      await writeConfig({ proxy });
      return { proxy, ip };
    }
    recovery[i]?.();
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

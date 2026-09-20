// Minimal HTTPS client with optional HTTP-proxy (CONNECT) support and retries.
// No dependencies: Node's global fetch cannot use a proxy, so requests go
// through node:https with a custom agent.
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class ProxyAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: true, maxSockets: 4 });
    this.proxy = new URL(proxyUrl);
    if (!/^https?:$/.test(this.proxy.protocol)) {
      throw new Error(`Unsupported proxy "${proxyUrl}" — only http:// proxies are supported`);
    }
  }

  createConnection(options, callback) {
    const socket = net.connect({
      host: this.proxy.hostname,
      port: Number(this.proxy.port || (this.proxy.protocol === 'https:' ? 443 : 80)),
    });
    const fail = (err) => { socket.destroy(); callback(err); };
    socket.setTimeout(20000, () => fail(new Error(`Proxy ${this.proxy.host} did not answer`)));
    socket.once('error', fail);

    socket.once('connect', () => {
      const target = `${options.host}:${options.port || 443}`;
      const head = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
      if (this.proxy.username) {
        const auth = `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`;
        head.push(`Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}`);
      }
      socket.write(`${head.join('\r\n')}\r\n\r\n`);

      let buffer = Buffer.alloc(0);
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        socket.removeListener('data', onData);
        socket.setTimeout(0);
        const statusLine = buffer.slice(0, buffer.indexOf('\r\n')).toString('latin1');
        if (!/^HTTP\/1\.[01] 200/.test(statusLine)) return fail(new Error(`Proxy refused CONNECT: ${statusLine}`));
        socket.removeListener('error', fail);
        callback(null, tls.connect({ socket, servername: options.host, ALPNProtocols: ['http/1.1'] }));
      };
      socket.on('data', onData);
    });
  }
}

const agents = new Map();
function agentFor(proxy) {
  if (!proxy) return undefined;
  if (!agents.has(proxy)) agents.set(proxy, new ProxyAgent(proxy));
  return agents.get(proxy);
}

function once(url, { method = 'GET', headers = {}, body, proxy, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        method,
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        port: 443,
        agent: agentFor(proxy),
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept-Language': 'en-US,en;q=0.9',
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`Timeout after ${timeout} ms: ${url}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// YouTube redirects, e.g. playlist pages and caption URLs.
async function withRedirects(url, options, hops = 5) {
  let current = url;
  let opts = options;
  for (let i = 0; i <= hops; i++) {
    const res = await once(current, opts);
    if (![301, 302, 303, 307, 308].includes(res.status) || !res.headers.location) return res;
    current = new URL(res.headers.location, current).toString();
    if ([301, 302, 303].includes(res.status)) opts = { ...opts, method: 'GET', body: undefined };
  }
  throw new Error(`Too many redirects: ${url}`);
}

// Retries network errors, timeouts and 5xx responses.
export async function request(url, options = {}) {
  const attempts = options.retries ?? 3;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await withRedirects(url, options);
      if (res.status >= 500 && attempt < attempts) {
        lastError = new Error(`HTTP ${res.status} from ${url}`);
      } else {
        return res;
      }
    } catch (e) {
      lastError = e;
      if (e.message.includes('only http:// proxies')) throw e;
    }
    await sleep(attempt * 1500);
  }
  throw lastError;
}

export async function getText(url, options) {
  const res = await request(url, options);
  if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.body;
}

export async function postJson(url, payload, options = {}) {
  const res = await request(url, { ...options, method: 'POST', body: JSON.stringify(payload) });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${url}: ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body);
}

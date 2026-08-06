import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as tls from 'tls';
import { URL } from 'url';

import { Options } from './options';
import { logger } from './logger';
import { VERSION } from './version';

const DEFAULT_API_URL = 'https://api.wakatime.com/api/v1';

// REQUEST_TIMEOUT_MS bounds how long a single heartbeat POST may hang before
// it is aborted, so a stuck connection fails fast instead of blocking the hook
// process indefinitely; the cursor-retry logic then resends on the next run.
const REQUEST_TIMEOUT_MS = 10_000;

// A single heartbeat in the exact JSON shape the WakaTime bulk API accepts.
// Fields mirror `pkg/heartbeat/heartbeat.go` in wakatime-cli.
export interface WakaHeartbeat {
  entity: string;
  type: 'file' | 'app';
  category: string;
  time: number; // floating-point unix epoch seconds
  is_write?: boolean;
  project?: string;
  ai_session?: string;
  ai_line_changes?: number;
  ai_prompt_length?: number;
  ai_input_tokens?: number;
  ai_output_tokens?: number;
  user_agent?: string;
}

// buildUserAgent returns a WakaTime-compatible User-Agent string embedding the
// plugin identity, mirroring the format wakatime-cli itself sends, e.g.
// `wakatime/4.1.0 (linux-6.1.0-x64) node-v20.9.0 junie-cli/<ver> junie-wakatime/4.1.0`.
export function buildUserAgent(editorVersion: string): string {
  const system = `${os.platform()}-${os.release()}-${os.arch()}`;
  const plugin = editorVersion ? `junie-cli/${editorVersion} junie-wakatime/${VERSION}` : `junie-wakatime/${VERSION}`;
  return `wakatime/${VERSION} (${system}) node-${process.version} ${plugin}`;
}

// getApiKey resolves the WakaTime api key from the config file, falling back to
// the WAKATIME_API_KEY environment variable. Returns undefined when unset.
function getApiKey(options: Options): string | undefined {
  const fromConfig = options.getSetting('settings', 'api_key');
  if (fromConfig && fromConfig.trim()) return fromConfig.trim();

  const fromEnv = process.env.WAKATIME_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  return undefined;
}

// getApiUrl resolves the WakaTime API base url from config, defaulting to the
// public WakaTime API. Any trailing slashes are trimmed.
function getApiUrl(options: Options): string {
  const configured = options.getSetting('settings', 'api_url');
  const base = configured && configured.trim() ? configured.trim() : DEFAULT_API_URL;
  return base.replace(/\/+$/, '');
}

interface HttpResponse {
  status: number;
  body: string;
}

// createProxyTunnel opens a CONNECT tunnel through an HTTP(S) proxy to the
// target host so an https request can be sent over it.
function createProxyTunnel(proxyUrl: URL, targetUrl: URL): Promise<net.Socket> {
  const proxyPort = proxyUrl.port ? parseInt(proxyUrl.port, 10) : proxyUrl.protocol === 'https:' ? 443 : 80;
  const baseSocket =
    proxyUrl.protocol === 'https:'
      ? tls.connect({ host: proxyUrl.hostname, port: proxyPort, servername: proxyUrl.hostname })
      : net.connect(proxyPort, proxyUrl.hostname);

  const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80');

  return new Promise<net.Socket>((resolve, reject) => {
    const auth =
      proxyUrl.username || proxyUrl.password
        ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}`
        : undefined;

    const cleanup = () => {
      baseSocket.removeListener('error', onError);
      baseSocket.removeListener('data', onData);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    let response = '';
    const onData = (chunk: Buffer) => {
      response += chunk.toString('utf8');
      if (!response.includes('\r\n\r\n')) return;

      cleanup();
      const statusLine = response.split('\r\n', 1)[0];
      if (!statusLine.includes(' 200 ')) {
        baseSocket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${statusLine}`));
        return;
      }
      resolve(baseSocket);
    };

    const connectRequest =
      `CONNECT ${targetUrl.hostname}:${targetPort} HTTP/1.1\r\n` +
      `Host: ${targetUrl.hostname}:${targetPort}\r\n` +
      `${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}` +
      `Connection: close\r\n\r\n`;

    baseSocket.once('error', onError);
    baseSocket.on('data', onData);
    if (proxyUrl.protocol === 'https:') {
      baseSocket.once('secureConnect', () => baseSocket.write(connectRequest));
    } else {
      baseSocket.once('connect', () => baseSocket.write(connectRequest));
    }
  });
}

// post performs a single HTTP(S) POST and resolves with the status code and
// response body. Optionally routes through an HTTP(S) proxy.
async function post(url: URL, body: string, headers: Record<string, string>, proxy?: string): Promise<HttpResponse> {
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const requestOptions: https.RequestOptions = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    headers,
  };

  // Route through a proxy when configured. https targets use a CONNECT tunnel
  // wrapped in TLS to the real target; plain http targets use an absolute-form
  // request line to the proxy.
  if (proxy && proxy.trim()) {
    const proxyUrl = new URL(proxy.trim());
    if (isHttps) {
      const tunnel = await createProxyTunnel(proxyUrl, url);
      const secureSocket = tls.connect({
        socket: tunnel,
        servername: url.hostname,
      });
      return new Promise<HttpResponse>((resolve, reject) => {
        secureSocket.once('error', reject);
        const req = https.request(
          {
            host: url.hostname,
            port: url.port ? parseInt(url.port, 10) : 443,
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            headers,
            agent: false,
            createConnection: () => secureSocket,
            timeout: REQUEST_TIMEOUT_MS,
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
          },
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Request to WakaTime API timed out')));
        req.write(body);
        req.end();
      });
    } else {
      requestOptions.hostname = proxyUrl.hostname;
      requestOptions.port = proxyUrl.port || 80;
      requestOptions.path = url.toString();
      requestOptions.headers = { ...headers, Host: url.host };
    }
  }

  requestOptions.timeout = REQUEST_TIMEOUT_MS;

  return new Promise<HttpResponse>((resolve, reject) => {
    const req = transport.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request to WakaTime API timed out')));
    req.write(body);
    req.end();
  });
}

// sendHeartbeats POSTs the given heartbeats to the WakaTime bulk API. It returns
// true only when the API accepts them (HTTP 201/202). On a missing api key,
// non-2xx response, or network error it logs and returns false so the caller
// can leave its parse cursor untouched and retry the same heartbeats next run.
export async function sendHeartbeats(heartbeats: WakaHeartbeat[], options: Options): Promise<boolean> {
  if (heartbeats.length === 0) return true;

  const apiKey = getApiKey(options);
  if (!apiKey) {
    logger.warn(
      'WakaTime api key not found; skipping heartbeat send. Set api_key in ~/.wakatime.cfg or the WAKATIME_API_KEY environment variable.',
    );
    return false;
  }

  const url = new URL(`${getApiUrl(options)}/users/current/heartbeats.bulk`);
  const body = JSON.stringify(heartbeats);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
    Authorization: `Basic ${Buffer.from(apiKey).toString('base64')}`,
    'User-Agent': heartbeats[0].user_agent ?? buildUserAgent(''),
  };

  const proxy = options.getSetting('settings', 'proxy');

  try {
    const { status, body: responseBody } = await post(url, body, headers, proxy ?? undefined);
    if (status === 201 || status === 202) {
      logger.debug(`Sent ${heartbeats.length} Junie AI heartbeat(s) to WakaTime (HTTP ${status}).`);
      return true;
    }

    logger.error(`WakaTime API returned HTTP ${status} when sending heartbeats: ${responseBody}`);
    return false;
  } catch (e) {
    logger.error(`Failed to send heartbeats to WakaTime: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

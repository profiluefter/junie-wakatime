import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { test } from 'node:test';

import { Options } from './options';
import { buildUserAgent, sendHeartbeats, WakaHeartbeat } from './wakatime';

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// startServer spins up a local HTTP server that captures the first request and
// responds with the given status code. Returns the base url and a getter for
// the captured request.
function startServer(status: number): Promise<{
  baseUrl: string;
  captured: () => CapturedRequest | undefined;
  close: () => Promise<void>;
}> {
  let captured: CapturedRequest | undefined;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      captured = { method: req.method, url: req.url, headers: req.headers, body };
      res.statusCode = status;
      res.end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/api/v1`,
        captured: () => captured,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

// makeOptions creates an isolated WAKATIME_HOME with a config file whose
// [settings] section contains the given key/value pairs, then returns Options.
function makeOptions(settings: Record<string, string>): { options: Options; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'waka-test-'));
  process.env.WAKATIME_HOME = home;

  const lines = ['[settings]', ...Object.entries(settings).map(([k, v]) => `${k} = ${v}`)];
  fs.writeFileSync(path.join(home, '.wakatime.cfg'), lines.join('\n'));

  return { options: new Options(), home };
}

const sampleHeartbeats: WakaHeartbeat[] = [
  {
    entity: 'Junie',
    type: 'app',
    category: 'ai coding',
    time: 1786040180.001,
    ai_prompt_length: 233,
    ai_session: 'session-260806-201529-xo48',
    user_agent: buildUserAgent('2026.1'),
  },
  {
    entity: '/abs/path/file.ts',
    type: 'file',
    category: 'ai coding',
    time: 1786040457.389,
    is_write: true,
    ai_line_changes: 12,
    project: 'my-project',
    ai_session: 'session-260806-201529-xo48',
    user_agent: buildUserAgent('2026.1'),
  },
];

test('buildUserAgent embeds the plugin identity', () => {
  const ua = buildUserAgent('2026.1.7');
  assert.match(ua, /^wakatime\/\d/);
  assert.ok(ua.includes('junie-cli/2026.1.7'));
  assert.ok(ua.includes('junie-wakatime/'));
});

test('sendHeartbeats POSTs to the bulk endpoint with Basic auth and JSON body', async () => {
  const server = await startServer(201);
  try {
    const { options } = makeOptions({ api_key: 'my-secret-key', api_url: server.baseUrl });
    delete process.env.WAKATIME_API_KEY;

    const ok = await sendHeartbeats(sampleHeartbeats, options);
    assert.strictEqual(ok, true);

    const req = server.captured();
    assert.ok(req, 'expected a captured request');
    assert.strictEqual(req!.method, 'POST');
    assert.strictEqual(req!.url, '/api/v1/users/current/heartbeats.bulk');

    const expectedAuth = `Basic ${Buffer.from('my-secret-key').toString('base64')}`;
    assert.strictEqual(req!.headers['authorization'], expectedAuth);
    assert.match(String(req!.headers['user-agent']), /junie-wakatime\//);
    assert.strictEqual(req!.headers['content-type'], 'application/json');

    const sent = JSON.parse(req!.body) as WakaHeartbeat[];
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[0].ai_prompt_length, 233);
    assert.strictEqual(sent[1].ai_line_changes, 12);
    assert.strictEqual(sent[1].ai_session, 'session-260806-201529-xo48');
  } finally {
    await server.close();
  }
});

test('sendHeartbeats treats HTTP 202 as success', async () => {
  const server = await startServer(202);
  try {
    const { options } = makeOptions({ api_key: 'k', api_url: server.baseUrl });
    delete process.env.WAKATIME_API_KEY;
    const ok = await sendHeartbeats(sampleHeartbeats, options);
    assert.strictEqual(ok, true);
  } finally {
    await server.close();
  }
});

test('sendHeartbeats returns false on a non-2xx response', async () => {
  const server = await startServer(500);
  try {
    const { options } = makeOptions({ api_key: 'k', api_url: server.baseUrl });
    delete process.env.WAKATIME_API_KEY;
    const ok = await sendHeartbeats(sampleHeartbeats, options);
    assert.strictEqual(ok, false);
  } finally {
    await server.close();
  }
});

test('sendHeartbeats returns false and sends nothing when the api key is missing', async () => {
  const server = await startServer(201);
  try {
    const { options } = makeOptions({ api_url: server.baseUrl });
    delete process.env.WAKATIME_API_KEY;

    const ok = await sendHeartbeats(sampleHeartbeats, options);
    assert.strictEqual(ok, false);
    assert.strictEqual(server.captured(), undefined, 'no request should be sent without an api key');
  } finally {
    await server.close();
  }
});

test('sendHeartbeats falls back to the WAKATIME_API_KEY env var', async () => {
  const server = await startServer(201);
  try {
    const { options } = makeOptions({ api_url: server.baseUrl });
    process.env.WAKATIME_API_KEY = 'env-key';

    const ok = await sendHeartbeats(sampleHeartbeats, options);
    assert.strictEqual(ok, true);

    const req = server.captured();
    assert.strictEqual(req!.headers['authorization'], `Basic ${Buffer.from('env-key').toString('base64')}`);
  } finally {
    delete process.env.WAKATIME_API_KEY;
    await server.close();
  }
});

test('sendHeartbeats returns true without a request for an empty batch', async () => {
  const server = await startServer(201);
  try {
    const { options } = makeOptions({ api_key: 'k', api_url: server.baseUrl });
    const ok = await sendHeartbeats([], options);
    assert.strictEqual(ok, true);
    assert.strictEqual(server.captured(), undefined);
  } finally {
    await server.close();
  }
});

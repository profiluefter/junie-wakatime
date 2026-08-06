import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { AddressInfo } from 'net';
import { test } from 'node:test';

// End-to-end test: runs the actual built dist/index.js hook against an isolated
// WAKATIME_HOME (config + synthetic Junie session) and a local fake WakaTime API
// server, then asserts the captured bulk request and the parse-cursor behavior.

const DIST = path.resolve(process.cwd(), 'dist', 'index.js');

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function startServer(status: number): Promise<{
  port: number;
  captured: () => CapturedRequest | undefined;
  close: () => Promise<void>;
}> {
  let captured: CapturedRequest | undefined;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      captured = { method: req.method, url: req.url, headers: req.headers, body };
      res.statusCode = status;
      res.end('[]');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        captured: () => captured,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const CURSOR_AT = 1_000_000_000_000;

function cursorFile(home: string): string {
  return path.join(home, '.wakatime', 'junie-wakatime', 'ai-last-parsed.json');
}

// setupHome creates an isolated WAKATIME_HOME with a config file, a synthetic
// Junie session, and a seeded parse cursor, then returns the home directory and
// the working directory referenced by the session.
function setupHome(port: number): { home: string; projectDir: string; sessionId: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-home-'));

  fs.writeFileSync(
    path.join(home, '.wakatime.cfg'),
    ['[settings]', 'api_key = e2e-secret', `api_url = http://127.0.0.1:${port}/api/v1`, 'debug = true'].join('\n'),
  );

  const projectDir = path.join(home, 'work', 'my-cool-project');
  fs.mkdirSync(projectDir, { recursive: true });

  const sessionId = 'session-260806-201529-e2e';
  const sessionDir = path.join(home, '.junie', 'sessions', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const events = [
    {
      kind: 'SessionA2uxEvent',
      event: { agentEvent: { kind: 'CurrentDirectoryUpdatedEvent', currentDirectory: projectDir } },
      timestampMs: CURSOR_AT + 500,
    },
    { kind: 'UserPromptEvent', prompt: 'hello world', timestampMs: CURSOR_AT + 1000 },
    {
      kind: 'SessionA2uxEvent',
      event: { agentEvent: { kind: 'LlmResponseMetadataEvent', modelUsage: [{ inputTokens: 1679, outputTokens: 5 }] } },
      timestampMs: CURSOR_AT + 2000,
    },
    {
      kind: 'SessionA2uxEvent',
      event: {
        agentEvent: { kind: 'AgentPatchCreatedEvent', patch: ['--- /dev/null', '+++ b/f.txt', '@@ -1,0 +1,1 @@', '+x'].join('\n') },
      },
      timestampMs: CURSOR_AT + 3000,
    },
  ];
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));

  // Seed the cursor so this is not treated as a first run (which would only
  // record a baseline and send nothing).
  fs.mkdirSync(path.dirname(cursorFile(home)), { recursive: true });
  fs.writeFileSync(cursorFile(home), JSON.stringify({ lastParsedAt: CURSOR_AT }));

  return { home, projectDir, sessionId };
}

// runHook spawns the built hook with the SessionEnd event piped on stdin and an
// isolated WAKATIME_HOME, resolving when the process exits.
function runHook(home: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST], {
      env: { ...process.env, WAKATIME_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.on('error', reject);
    child.on('exit', () => resolve());
    child.stdin.write(JSON.stringify({ hook_event_name: 'SessionEnd' }));
    child.stdin.end();
  });
}

function readCursor(home: string): number | undefined {
  try {
    return (JSON.parse(fs.readFileSync(cursorFile(home), 'utf-8')) as { lastParsedAt?: number }).lastParsedAt;
  } catch {
    return undefined;
  }
}

test('e2e: sends prompt/token/file heartbeats and advances the cursor on success', async () => {
  assert.ok(fs.existsSync(DIST), `expected built hook at ${DIST}; run "npm run build" first`);

  const server = await startServer(201);
  const { home, projectDir, sessionId } = setupHome(server.port);
  try {
    await runHook(home);

    const req = server.captured();
    assert.ok(req, 'expected the hook to POST a bulk heartbeat request');
    assert.strictEqual(req!.method, 'POST');
    assert.strictEqual(req!.url, '/api/v1/users/current/heartbeats.bulk');
    assert.strictEqual(req!.headers['authorization'], `Basic ${Buffer.from('e2e-secret').toString('base64')}`);
    assert.match(String(req!.headers['user-agent']), /junie-wakatime\//);

    const sent = JSON.parse(req!.body) as Record<string, unknown>[];
    // time-sorted: prompt (t+1), token (t+2), file (t+3)
    assert.deepStrictEqual(
      sent.map((h) => h.time),
      [(CURSOR_AT + 1000) / 1000, (CURSOR_AT + 2000) / 1000, (CURSOR_AT + 3000) / 1000],
    );
    for (const h of sent) {
      assert.strictEqual(h.category, 'ai coding');
      assert.strictEqual(h.ai_session, sessionId);
    }

    const prompt = sent.find((h) => h.ai_prompt_length !== undefined)!;
    assert.strictEqual(prompt.type, 'app');
    assert.strictEqual(prompt.entity, 'Junie');
    assert.strictEqual(prompt.ai_prompt_length, 'hello world'.length);

    const tokens = sent.find((h) => h.ai_input_tokens !== undefined)!;
    assert.strictEqual(tokens.type, 'app');
    assert.strictEqual(tokens.ai_input_tokens, 1679);
    assert.strictEqual(tokens.ai_output_tokens, 5);

    const file = sent.find((h) => h.type === 'file')!;
    assert.strictEqual(file.entity, path.join(projectDir, 'f.txt'));
    assert.strictEqual(file.ai_line_changes, 1);
    assert.strictEqual(file.is_write, true);
    assert.strictEqual(file.project, 'my-cool-project');

    // On a 201, the cursor advances to the newest event timestamp.
    assert.strictEqual(readCursor(home), CURSOR_AT + 3000);
  } finally {
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('e2e: does not advance the cursor when the send fails', async () => {
  assert.ok(fs.existsSync(DIST), `expected built hook at ${DIST}; run "npm run build" first`);

  const server = await startServer(500);
  const { home } = setupHome(server.port);
  try {
    await runHook(home);

    assert.ok(server.captured(), 'expected the hook to attempt a POST');
    // A 500 response must leave the cursor untouched so the same events resend.
    assert.strictEqual(readCursor(home), CURSOR_AT);
  } finally {
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

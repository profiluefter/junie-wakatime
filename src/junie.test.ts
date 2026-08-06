import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';

import { collectHeartbeats, findTranscripts, parsePatch, parseTranscript, stripDiffPath } from './junie';

test('stripDiffPath strips git prefixes, tabs and /dev/null', () => {
  assert.strictEqual(stripDiffPath('a/src/index.ts'), 'src/index.ts');
  assert.strictEqual(stripDiffPath('b/src/index.ts'), 'src/index.ts');
  assert.strictEqual(stripDiffPath('/dev/null'), null);
  assert.strictEqual(stripDiffPath('b/foo.txt\t2026-01-01 00:00:00'), 'foo.txt');
  assert.strictEqual(stripDiffPath('   '), null);
});

test('parsePatch counts additions for a newly added file', () => {
  const patch = ['--- /dev/null', '+++ b/new.txt', '@@ -1,0 +1,3 @@', '+one', '+two', '+three'].join('\n');

  const changes = parsePatch(patch, '/home/me/project');
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].file, '/home/me/project/new.txt');
  assert.strictEqual(changes[0].additions, 3);
  assert.strictEqual(changes[0].deletions, 0);
});

test('parsePatch counts additions and deletions for a modified file', () => {
  const patch = ['--- a/mod.txt', '+++ b/mod.txt', '@@ -1,3 +1,3 @@', ' context', '-old line', '+new line', ' more context'].join('\n');

  const changes = parsePatch(patch, '/home/me/project');
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].additions, 1);
  assert.strictEqual(changes[0].deletions, 1);
});

test('parsePatch uses the from-side path when a file is deleted', () => {
  const patch = ['--- a/gone.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-line one', '-line two'].join('\n');

  const changes = parsePatch(patch, '/home/me/project');
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].file, '/home/me/project/gone.txt');
  assert.strictEqual(changes[0].additions, 0);
  assert.strictEqual(changes[0].deletions, 2);
});

test('parsePatch handles multiple files and absolute paths', () => {
  const patch = [
    '--- /dev/null',
    '+++ b/a.txt',
    '@@ -1,0 +1,1 @@',
    '+a',
    '--- a/b.txt',
    '+++ /abs/b.txt',
    '@@ -1,1 +1,2 @@',
    ' keep',
    '+added',
  ].join('\n');

  const changes = parsePatch(patch, '/home/me/project');
  assert.strictEqual(changes.length, 2);
  assert.strictEqual(changes[0].file, '/home/me/project/a.txt');
  assert.strictEqual(changes[1].file, '/abs/b.txt');
  assert.strictEqual(changes[1].additions, 1);
});

function writeTranscript(dir: string, lines: object[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

function patchEvent(timestampMs: number, patch: string) {
  return {
    kind: 'SessionA2uxEvent',
    event: { agentEvent: { kind: 'AgentPatchCreatedEvent', patch } },
    timestampMs,
  };
}

function cwdEvent(timestampMs: number, currentDirectory: string) {
  return {
    kind: 'SessionA2uxEvent',
    event: { agentEvent: { kind: 'CurrentDirectoryUpdatedEvent', currentDirectory } },
    timestampMs,
  };
}

function promptEvent(timestampMs: number, prompt: string) {
  return { kind: 'UserPromptEvent', prompt, timestampMs };
}

function llmEvent(timestampMs: number, usage: { inputTokens: number; outputTokens: number }[]) {
  return {
    kind: 'SessionA2uxEvent',
    event: { agentEvent: { kind: 'LlmResponseMetadataEvent', modelUsage: usage } },
    timestampMs,
  };
}

test('parseTranscript resolves cwd and filters by afterMs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'junie-'));
  const file = writeTranscript(tmp, [
    cwdEvent(1000, '/work/proj'),
    patchEvent(2000, ['--- /dev/null', '+++ b/old.txt', '@@ -1,0 +1,1 @@', '+old'].join('\n')),
    patchEvent(5000, ['--- /dev/null', '+++ b/new.txt', '@@ -1,0 +1,2 @@', '+a', '+b'].join('\n')),
  ]);

  // Only the patch after afterMs=3000 should be returned.
  const heartbeats = parseTranscript(file, 3000);
  assert.strictEqual(heartbeats.length, 1);
  assert.strictEqual(heartbeats[0].entity, '/work/proj/new.txt');
  assert.strictEqual(heartbeats[0].aiLineChanges, 2);
  assert.strictEqual(heartbeats[0].time, 5);
  assert.strictEqual(heartbeats[0].projectFolder, '/work/proj');
  assert.strictEqual(heartbeats[0].entityType, 'file');
  assert.strictEqual(heartbeats[0].aiSession, path.basename(tmp));

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('parseTranscript emits an app heartbeat for user prompts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'junie-'));
  // 'héllo' is 5 code points; length is counted in code points, not UTF-16 units.
  const file = writeTranscript(tmp, [promptEvent(4000, 'héllo')]);

  const heartbeats = parseTranscript(file, 0);
  assert.strictEqual(heartbeats.length, 1);
  assert.strictEqual(heartbeats[0].entity, 'Junie');
  assert.strictEqual(heartbeats[0].entityType, 'app');
  assert.strictEqual(heartbeats[0].aiPromptLength, 5);
  assert.strictEqual(heartbeats[0].time, 4);
  assert.strictEqual(heartbeats[0].aiSession, path.basename(tmp));

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('parseTranscript sums token usage across modelUsage entries', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'junie-'));
  const file = writeTranscript(tmp, [
    llmEvent(4000, [
      { inputTokens: 1679, outputTokens: 5 },
      { inputTokens: 21, outputTokens: 4 },
    ]),
  ]);

  const heartbeats = parseTranscript(file, 0);
  assert.strictEqual(heartbeats.length, 1);
  assert.strictEqual(heartbeats[0].entity, 'Junie');
  assert.strictEqual(heartbeats[0].entityType, 'app');
  assert.strictEqual(heartbeats[0].aiInputTokens, 1700);
  assert.strictEqual(heartbeats[0].aiOutputTokens, 9);
  assert.strictEqual(heartbeats[0].aiSession, path.basename(tmp));

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('parseTranscript ignores empty patches, empty prompts and unknown events', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'junie-'));
  const file = writeTranscript(tmp, [
    cwdEvent(1000, '/work/proj'),
    patchEvent(2000, ''),
    promptEvent(2500, ''),
    llmEvent(2600, []),
    { kind: 'SomeOtherEvent', timestampMs: 2700 },
  ]);

  assert.strictEqual(parseTranscript(file, 0).length, 0);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('collectHeartbeats scans session directories under a home dir', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sessions = path.join(home, '.junie', 'sessions');
  writeTranscript(path.join(sessions, 'session-1'), [
    cwdEvent(1000, '/work/proj'),
    patchEvent(4000, ['--- /dev/null', '+++ b/f.txt', '@@ -1,0 +1,1 @@', '+x'].join('\n')),
  ]);

  const { heartbeats, maxTimestampMs } = collectHeartbeats(0, home);
  assert.strictEqual(heartbeats.length, 1);
  assert.strictEqual(heartbeats[0].entity, '/work/proj/f.txt');
  assert.strictEqual(heartbeats[0].aiSession, 'session-1');
  assert.strictEqual(maxTimestampMs, 4000);

  // A cursor past the event yields nothing new.
  assert.strictEqual(collectHeartbeats(4000, home).heartbeats.length, 0);

  fs.rmSync(home, { recursive: true, force: true });
});

test('collectHeartbeats returns all kinds time-sorted and tagged with the session id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sessions = path.join(home, '.junie', 'sessions');
  writeTranscript(path.join(sessions, 'session-260806-201529-xo48'), [
    cwdEvent(1000, '/work/proj'),
    llmEvent(3000, [{ inputTokens: 10, outputTokens: 2 }]),
    promptEvent(2000, 'hello'),
    patchEvent(4000, ['--- /dev/null', '+++ b/f.txt', '@@ -1,0 +1,1 @@', '+x'].join('\n')),
  ]);

  const { heartbeats, maxTimestampMs } = collectHeartbeats(0, home);
  assert.deepStrictEqual(
    heartbeats.map((h) => h.time),
    [2, 3, 4],
  );
  assert.strictEqual(maxTimestampMs, 4000);
  for (const h of heartbeats) {
    assert.strictEqual(h.aiSession, 'session-260806-201529-xo48');
  }

  fs.rmSync(home, { recursive: true, force: true });
});

test('findTranscripts only returns recently modified transcripts', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const sessions = path.join(home, '.junie', 'sessions');
  const file = writeTranscript(path.join(sessions, 'session-old'), [cwdEvent(1, '/x')]);

  // Force an old modification time well before the cutoff.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(file, old, old);

  assert.strictEqual(findTranscripts(sessions, Date.now()).length, 0);
  assert.strictEqual(findTranscripts(sessions, 0).length, 1);

  fs.rmSync(home, { recursive: true, force: true });
});

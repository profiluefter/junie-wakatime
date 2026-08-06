import * as fs from 'fs';
import * as path from 'path';
import { getHomeDirectory } from './utils';

// A single AI-coding heartbeat derived from a Junie session event. It is either
// a `file` heartbeat (a code edit carrying `aiLineChanges`) or an `app`
// heartbeat (a prompt carrying `aiPromptLength`, or token usage carrying
// `aiInputTokens`/`aiOutputTokens`). Every heartbeat is tagged with the Junie
// `aiSession` it belongs to.
export interface JunieHeartbeat {
  entity: string;
  entityType: 'file' | 'app';
  time: number; // floating-point unix epoch seconds
  aiSession: string;
  aiLineChanges?: number;
  aiPromptLength?: number;
  aiInputTokens?: number;
  aiOutputTokens?: number;
  projectFolder?: string;
}

// Entity name used for `app`-type heartbeats (prompts and token usage), mirroring
// how wakatime-cli's built-in AI parsers use a stable app entity per tool.
export const APP_ENTITY = 'Junie';

// The result of scanning Junie's session transcripts.
export interface JunieParseResult {
  heartbeats: JunieHeartbeat[];
  // Highest transcript event timestamp (unix epoch ms) that produced a
  // heartbeat, or 0 when nothing new was parsed. Callers persist this so the
  // same edits are never sent twice.
  maxTimestampMs: number;
}

// Per-file change counts extracted from a unified diff.
export interface FileChange {
  file: string;
  additions: number;
  deletions: number;
}

// getSessionsDirectory returns the directory Junie CLI stores session
// transcripts in, e.g. ~/.junie/sessions.
export function getSessionsDirectory(home?: string): string {
  return path.join(home ?? getHomeDirectory(), '.junie', 'sessions');
}

// stripDiffPath normalizes a unified-diff header path. It drops any trailing
// tab-delimited metadata, removes the leading `a/` or `b/` git prefix, and
// returns null for `/dev/null` (used for added/deleted file sides).
export function stripDiffPath(raw: string): string | null {
  let value = raw.trim();

  // git may append a tab followed by a timestamp to the header path.
  const tab = value.indexOf('\t');
  if (tab !== -1) value = value.slice(0, tab);

  if (value === '' || value === '/dev/null') return null;

  if (value.startsWith('a/') || value.startsWith('b/')) {
    value = value.slice(2);
  }

  return value;
}

// resolveEntity turns a diff path into an absolute file path, resolving
// relative paths against the working directory active when the patch was
// created. Returns null when it cannot be resolved to an absolute path.
function resolveEntity(file: string, cwd: string): string | null {
  if (path.isAbsolute(file)) return file;
  if (!cwd) return null;
  return path.resolve(cwd, file);
}

// parsePatch parses a unified diff (Junie's AgentPatchCreatedEvent payload)
// into per-file addition/deletion counts. `cwd` is the working directory used
// to resolve relative file paths.
export function parsePatch(patch: string, cwd: string): FileChange[] {
  const changes: FileChange[] = [];

  let current: FileChange | null = null;
  let pendingMinus: string | null = null;

  const finalize = () => {
    if (current) changes.push(current);
    current = null;
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('--- ')) {
      // Remember the "from" side; used when the "to" side is /dev/null (a
      // deleted file), so the heartbeat still points at a real path.
      pendingMinus = stripDiffPath(line.slice(4));
      continue;
    }

    if (line.startsWith('+++ ')) {
      finalize();

      const plus = stripDiffPath(line.slice(4));
      const file = plus ?? pendingMinus;
      pendingMinus = null;

      if (file) {
        const entity = resolveEntity(file, cwd);
        current = entity ? { file: entity, additions: 0, deletions: 0 } : null;
      } else {
        current = null;
      }

      continue;
    }

    if (line.startsWith('@@')) continue;

    if (!current) continue;

    if (line.startsWith('+')) {
      current.additions++;
    } else if (line.startsWith('-')) {
      current.deletions++;
    }
  }

  finalize();

  return changes;
}

interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
}

interface JunieEvent {
  kind?: string;
  prompt?: string;
  timestampMs?: number;
  event?: {
    agentEvent?: {
      kind?: string;
      patch?: string;
      currentDirectory?: string;
      modelUsage?: ModelUsage[];
    };
  };
}

// sessionIdFromTranscript derives the Junie session id (used as `aiSession`)
// from a transcript path, i.e. the name of the session-* directory containing
// the events.jsonl file.
function sessionIdFromTranscript(file: string): string {
  return path.basename(path.dirname(file));
}

// parseTranscript reads a single events.jsonl transcript and returns the AI
// heartbeats for every prompt, token-usage record, and file patch created
// strictly after `afterMs`. Directory-change events are always applied so the
// working directory is known even when they precede the cursor.
export function parseTranscript(file: string, afterMs: number): JunieHeartbeat[] {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }

  const aiSession = sessionIdFromTranscript(file);
  const heartbeats: JunieHeartbeat[] = [];
  let cwd = '';

  for (const raw of content.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let evt: JunieEvent;
    try {
      evt = JSON.parse(trimmed) as JunieEvent;
    } catch {
      continue;
    }

    const agentEvent = evt.event?.agentEvent;

    // Track the working directory regardless of the cursor so patches after the
    // cursor still resolve their relative paths correctly.
    if (agentEvent?.kind === 'CurrentDirectoryUpdatedEvent') {
      if (agentEvent.currentDirectory && agentEvent.currentDirectory.trim()) {
        cwd = agentEvent.currentDirectory.trim();
      }
      continue;
    }

    const timestampMs = evt.timestampMs;
    if (typeof timestampMs !== 'number' || timestampMs <= afterMs) continue;
    const time = timestampMs / 1000;

    // User prompts are top-level events; emit an app heartbeat carrying the
    // prompt length (counted in code points to match multi-byte characters).
    if (evt.kind === 'UserPromptEvent') {
      const prompt = evt.prompt;
      if (typeof prompt === 'string' && prompt.length > 0) {
        heartbeats.push({
          entity: APP_ENTITY,
          entityType: 'app',
          time,
          aiSession,
          aiPromptLength: [...prompt].length,
        });
      }
      continue;
    }

    if (!agentEvent) continue;

    // LLM responses report per-model token usage; sum them into a single app
    // heartbeat carrying input/output token counts.
    if (agentEvent.kind === 'LlmResponseMetadataEvent') {
      const usage = agentEvent.modelUsage;
      if (Array.isArray(usage) && usage.length > 0) {
        let inputTokens = 0;
        let outputTokens = 0;
        for (const u of usage) {
          if (typeof u.inputTokens === 'number') inputTokens += u.inputTokens;
          if (typeof u.outputTokens === 'number') outputTokens += u.outputTokens;
        }
        if (inputTokens > 0 || outputTokens > 0) {
          heartbeats.push({
            entity: APP_ENTITY,
            entityType: 'app',
            time,
            aiSession,
            aiInputTokens: inputTokens,
            aiOutputTokens: outputTokens,
          });
        }
      }
      continue;
    }

    // File edits are unified diffs; emit one file heartbeat per changed file.
    if (agentEvent.kind === 'AgentPatchCreatedEvent') {
      const patch = agentEvent.patch;
      if (!patch || !patch.trim()) continue;

      for (const change of parsePatch(patch, cwd)) {
        heartbeats.push({
          entity: change.file,
          entityType: 'file',
          time,
          aiSession,
          aiLineChanges: change.additions - change.deletions,
          projectFolder: cwd,
        });
      }
    }
  }

  return heartbeats;
}

// findTranscripts returns the events.jsonl paths for every session transcript
// modified at or after `afterMs`. A small buffer is subtracted so edits that
// land in the same second as the previous run are not missed.
export function findTranscripts(sessionsDir: string, afterMs: number): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const cutoff = afterMs - 2000;
  const transcripts: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;

    const transcript = path.join(sessionsDir, entry.name, 'events.jsonl');
    try {
      const stat = fs.statSync(transcript);
      if (stat.mtimeMs >= cutoff) transcripts.push(transcript);
    } catch {
      // no events.jsonl in this session directory
    }
  }

  return transcripts;
}

// collectHeartbeats scans all recently modified Junie session transcripts and
// returns the AI heartbeats for edits created after `afterMs`, along with the
// newest event timestamp seen so the caller can advance its cursor.
export function collectHeartbeats(afterMs: number, home?: string): JunieParseResult {
  const sessionsDir = getSessionsDirectory(home);
  const transcripts = findTranscripts(sessionsDir, afterMs);

  const heartbeats: JunieHeartbeat[] = [];
  let maxTimestampMs = 0;

  for (const transcript of transcripts) {
    for (const hb of parseTranscript(transcript, afterMs)) {
      heartbeats.push(hb);
      const tsMs = Math.round(hb.time * 1000);
      if (tsMs > maxTimestampMs) maxTimestampMs = tsMs;
    }
  }

  heartbeats.sort((a, b) => a.time - b.time);

  return { heartbeats, maxTimestampMs };
}

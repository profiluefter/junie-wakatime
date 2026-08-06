#!/usr/bin/env node

import * as path from 'path';
import { Options } from './options';
import { logger, LogLevel } from './logger';
import { collectHeartbeats, JunieHeartbeat } from './junie';
import { buildUserAgent, sendHeartbeats, WakaHeartbeat } from './wakatime';
import {
  getAILastParsedAt,
  getEditorVersion,
  parseInput,
  setAILastParsedAt,
  shouldSendHeartbeat,
  updateState,
  withAiCursorLock,
} from './utils';

const options = new Options();

const AI_CODING_CATEGORY = 'ai coding';

// projectName derives a WakaTime project name from a working directory, using
// its final path segment (e.g. /home/me/my-project -> my-project).
function projectName(projectFolder?: string): string {
  return projectFolder ? path.basename(projectFolder) : '';
}

// toWakaHeartbeat maps a parsed Junie heartbeat onto the JSON shape the WakaTime
// bulk API accepts. File heartbeats carry line changes and a project; app
// heartbeats carry prompt length or token usage. Every heartbeat is tagged with
// its Junie ai_session and the 'ai coding' category.
function toWakaHeartbeat(h: JunieHeartbeat, userAgent: string): WakaHeartbeat {
  const hb: WakaHeartbeat = {
    entity: h.entity,
    type: h.entityType,
    category: AI_CODING_CATEGORY,
    time: h.time,
    ai_session: h.aiSession,
    user_agent: userAgent,
  };

  if (h.entityType === 'file') {
    hb.is_write = true;
    if (typeof h.aiLineChanges === 'number') hb.ai_line_changes = h.aiLineChanges;
    const project = projectName(h.projectFolder);
    if (project) hb.project = project;
  }

  if (typeof h.aiPromptLength === 'number') hb.ai_prompt_length = h.aiPromptLength;
  if (typeof h.aiInputTokens === 'number') hb.ai_input_tokens = h.aiInputTokens;
  if (typeof h.aiOutputTokens === 'number') hb.ai_output_tokens = h.aiOutputTokens;

  return hb;
}

// syncJunieActivity parses Junie's session transcripts for prompts, token usage,
// and file edits made since the last run and POSTs them to the WakaTime API as
// 'ai coding' heartbeats. The parse cursor is advanced only when the send
// succeeds, so a failed/offline send simply re-derives and resends next run.
// Returns true only when there was nothing to send, or everything sent
// successfully, so the caller can decide whether it's safe to reset the
// per-project debounce.
async function syncJunieActivity(): Promise<boolean> {
  // Hooks run with "async": true and can fire concurrently, so the whole
  // read-cursor -> collect -> send -> write-cursor cycle is serialized across
  // processes to avoid two runs sending duplicate heartbeats for the same events.
  return withAiCursorLock(async () => {
    const lastParsedAt = getAILastParsedAt();

    // On first run, establish a baseline instead of backfilling the entire Junie
    // history, which would flood the dashboard with old activity.
    if (lastParsedAt === undefined) {
      await setAILastParsedAt(Date.now());
      logger.debug('Initialized Junie AI activity cursor; skipping historical backfill');
      return true;
    }

    const { heartbeats, maxTimestampMs } = collectHeartbeats(lastParsedAt);
    if (heartbeats.length === 0) return true;

    const editorVersion = await getEditorVersion();
    const userAgent = buildUserAgent(editorVersion);
    const payload = heartbeats.map((h) => toWakaHeartbeat(h, userAgent));

    logger.debug(`Sending ${payload.length} Junie AI heartbeat(s) to WakaTime`);

    const sent = await sendHeartbeats(payload, options);
    if (sent && maxTimestampMs > lastParsedAt) {
      await setAILastParsedAt(maxTimestampMs);
    }
    return sent;
  });
}

async function main() {
  const inp = parseInput();

  const debug = options.getSetting('settings', 'debug');
  logger.setLevel(debug === 'true' ? LogLevel.DEBUG : LogLevel.INFO);

  try {
    if (inp) logger.debug(JSON.stringify(inp, null, 2));

    // Always flush on SessionEnd so the final edits of a session are not lost
    // to the per-project debounce.
    const isSessionEnd = inp?.hook_event_name === 'SessionEnd';
    if (inp && (shouldSendHeartbeat(inp) || isSessionEnd)) {
      const sent = await syncJunieActivity();
      // Only reset the debounce when nothing needed sending or the send
      // succeeded. On failure, leave it alone so the next hook can retry
      // promptly instead of waiting out the full debounce window again.
      if (sent) await updateState();
    }
  } catch (err) {
    logger.errorException(err);
  }
}

main();

export type State = {
  lastHeartbeatAt?: number;
};

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'SessionEnd';

export type Input = {
  hook_event_name: HookEvent;
  source?: string;
  reason?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
};

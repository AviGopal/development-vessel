export interface ResolverResult {
  shape: string;
  body: unknown;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WebSocketMessage {
  type: string;
  payload?: unknown;
  data?: unknown;
  timestamp?: number;
}

// Re-exported here for test type imports.
export interface EscalationDispositionApplyPointer {
  type: "escalation_disposition_apply";
  /** Do everything except write. For probing what WOULD be applied. */
  dry_run?: boolean;
  [key: string]: unknown;
}


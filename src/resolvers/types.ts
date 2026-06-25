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


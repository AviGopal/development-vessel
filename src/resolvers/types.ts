export interface ResolverResult {
  shape: string;
  body: unknown;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

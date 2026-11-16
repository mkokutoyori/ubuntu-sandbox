export interface PipelineAuditPort {
  commandInvoked(command: string, parameters: ReadonlyArray<readonly [string, string]>, positional: readonly string[], piped: readonly string[]): void;
}

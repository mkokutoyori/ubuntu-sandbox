export interface PipedItem {
  readonly text: string;
  readonly properties: Readonly<Record<string, string>>;
}

export interface PipelineAuditPort {
  commandInvoked(command: string, parameters: ReadonlyArray<readonly [string, string]>, positional: readonly string[], piped: readonly PipedItem[]): void;
}

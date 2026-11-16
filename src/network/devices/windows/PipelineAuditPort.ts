export interface PipelineAuditPort {
  commandInvoked(command: string, parameters: ReadonlyArray<readonly [string, string]>): void;
}

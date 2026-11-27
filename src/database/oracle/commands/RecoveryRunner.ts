export interface RecoveryRunner {
  recover(rmanStatement: string): string[];
}

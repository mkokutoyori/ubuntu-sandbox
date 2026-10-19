export const RUNTIME_EXCEPTION = 'System.Management.Automation.RuntimeException';

export class PSRuntimeError extends Error {
  commandName?: string;
  thrownFromThrowStatement = false;
  errorRecord?: Record<string, unknown>;
  errorId?: string;
  innerFailure?: { exceptionType: string; errorId: string };
  commandKind?: 'cmdlet' | 'function';

  constructor(message: string, readonly exceptionType: string = RUNTIME_EXCEPTION) {
    super(message);
    this.name = 'PSRuntimeError';
  }

  conciseReason(): string {
    if (this.thrownFromThrowStatement) return 'Exception';
    if (this.commandName !== undefined) return this.commandName;
    if (this.exceptionType.endsWith('.PSInvalidCastException')) return 'InvalidArgument';
    if (!this.exceptionType.startsWith('System.Management.Automation.')) return 'RuntimeException';
    return this.exceptionType.slice(this.exceptionType.lastIndexOf('.') + 1);
  }
}

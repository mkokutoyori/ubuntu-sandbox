export const RUNTIME_EXCEPTION = 'System.Management.Automation.RuntimeException';

export class PSRuntimeError extends Error {
  constructor(message: string, readonly exceptionType: string = RUNTIME_EXCEPTION) {
    super(message);
    this.name = 'PSRuntimeError';
  }
}

/** Runtime error (unrecognised cmdlet, type mismatch, etc.). */
export class PSRuntimeError extends Error {
  constructor(message: string) { super(message); this.name = 'PSRuntimeError'; }
}

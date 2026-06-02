export type InputKind = 'text' | 'password' | 'confirm' | 'choice' | 'multiline';

export interface InputRequest {
  readonly kind: InputKind;
  readonly prompt: string;
  readonly default?: string;
  readonly mask?: boolean;
  readonly trim?: boolean;
  readonly echo?: boolean;
  readonly choices?: readonly string[];
  readonly choiceLabels?: readonly string[];
  readonly validator?: (raw: string) => InputValidation;
  readonly maxAttempts?: number;
  readonly until?: string;
  readonly retryPrompt?: (attempt: number, lastError: string) => string;
  readonly timeoutMs?: number;
  readonly description?: string;
}

export type InputValidation =
  | { readonly ok: true; readonly value?: string }
  | { readonly ok: false; readonly error: string };

export type InputStatus = 'ok' | 'cancelled' | 'timeout' | 'closed' | 'no-host';

export interface InputResult {
  readonly status: InputStatus;
  readonly value?: string;
  readonly raw?: string;
  readonly attempts: number;
}

export interface ConfirmResult {
  readonly status: InputStatus;
  readonly value?: boolean;
  readonly attempts: number;
}

export interface MultilineResult {
  readonly status: InputStatus;
  readonly lines?: readonly string[];
  readonly attempts: number;
}

export interface ChoiceResult {
  readonly status: InputStatus;
  readonly value?: string;
  readonly index?: number;
  readonly attempts: number;
}

export interface StreamSink {
  write(chunk: string): void;
  warn?(line: string): void;
  error?(line: string): void;
}

export interface StreamAttachOptions {
  readonly description: string;
  readonly hostHint?: string;
  readonly sink: StreamSink;
  readonly onCancel?: () => void;
}

export interface StreamAttachment {
  readonly id: string;
  readonly description: string;
  readonly active: boolean;
  cancel(): void;
}

export interface InputCapabilities {
  readonly interactive: boolean;
  readonly maskedSupported: boolean;
  readonly streaming: boolean;
}

export class InputClosedError extends Error {
  constructor(reason: string) { super(`input closed: ${reason}`); }
}

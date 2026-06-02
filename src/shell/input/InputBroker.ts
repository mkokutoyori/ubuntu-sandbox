import type {
  InputRequest, InputResult, ConfirmResult, MultilineResult, ChoiceResult,
  StreamAttachment, StreamAttachOptions, InputCapabilities,
} from './types';

export interface InputBroker {
  read(req: InputRequest): Promise<InputResult>;

  ask(prompt: string, opts?: Partial<InputRequest>): Promise<string | null>;
  password(prompt: string, opts?: Partial<InputRequest>): Promise<string | null>;
  confirm(prompt: string, opts?: {
    default?: boolean;
    yesWords?: readonly string[];
    noWords?: readonly string[];
    maxAttempts?: number;
  }): Promise<ConfirmResult>;
  choice(
    prompt: string,
    choices: readonly string[],
    opts?: { labels?: readonly string[]; default?: string; maxAttempts?: number },
  ): Promise<ChoiceResult>;
  multiline(prompt: string, opts?: { until?: string; max?: number }): Promise<MultilineResult>;

  attachStream(opts: StreamAttachOptions): StreamAttachment;
  detachAllStreams(): void;
  listStreams(): readonly StreamAttachment[];

  capabilities(): InputCapabilities;
  cancelPending(): void;

  emit(line: string): void;
}

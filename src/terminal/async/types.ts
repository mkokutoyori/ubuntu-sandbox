export type AsyncJobMode = 'foreground' | 'background';

export type AsyncJobKind = 'streaming' | 'background' | 'subscription';

export interface AsyncJobSink {
  line(text: string, type?: string): void;
  lines(texts: readonly string[], type?: string): void;
  write(chunk: string, type?: string): void;
  warn(text: string): void;
  error(text: string): void;
}

export interface AsyncJobContext {
  readonly sink: AsyncJobSink;
  readonly signal: AbortSignal;
  cancelled(): boolean;
  onCancel(handler: () => void): void;
  delay(ms: number): Promise<void>;
}

export interface AsyncJobSpec {
  readonly mode: AsyncJobMode;
  readonly kind: AsyncJobKind;
  readonly command: string;
  readonly label?: string;
  prepare?(ctx: AsyncJobContext): boolean;
  run(ctx: AsyncJobContext): void | Promise<void>;
  onInterrupt?(ctx: AsyncJobContext): void;
}

export interface StreamingOutput extends AsyncJobSpec {
  readonly mode: 'foreground';
  readonly kind: 'streaming';
}

export interface BackgroundProcess extends AsyncJobSpec {
  readonly mode: 'background';
  readonly kind: 'background';
}

export interface EventSubscription extends AsyncJobSpec {
  readonly mode: 'background';
  readonly kind: 'subscription';
}

export type AsyncCommand = StreamingOutput | BackgroundProcess | EventSubscription;

export interface AsyncJobHandle {
  readonly id: string;
  readonly mode: AsyncJobMode;
  readonly kind: AsyncJobKind;
  readonly command: string;
  readonly label: string;
  readonly startedAt: number;
  readonly running: boolean;
  cancel(): void;
}

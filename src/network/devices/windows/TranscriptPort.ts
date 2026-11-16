export interface TranscriptStartOptions {
  readonly path?: string;
  readonly outputDirectory?: string;
  readonly append: boolean;
  readonly force: boolean;
  readonly noClobber: boolean;
  readonly includeInvocationHeader: boolean;
  readonly useMinimalHeader: boolean;
}

export type TranscriptOutcome = { readonly path: string } | { readonly error: string };

export interface TranscriptPort {
  start(options: TranscriptStartOptions): TranscriptOutcome;
  stop(): TranscriptOutcome;
}

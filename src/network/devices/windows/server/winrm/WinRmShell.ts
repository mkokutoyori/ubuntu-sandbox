export interface WinRmShellReply {
  readonly output: string;
  readonly prompt: string;
  readonly ended: boolean;
}

export interface WinRmShellCompletion {
  readonly candidates: readonly string[];
  readonly start: number | null;
}

export interface WinRmShellHost {
  prompt(): string;
  run(line: string): Promise<WinRmShellReply>;
  complete(line: string): WinRmShellCompletion;
  close(): void;
}

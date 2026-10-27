import type { NetkitTelnetTerminal } from './NetkitTelnetHost';

interface TranscriptPart {
  readonly stderr: boolean;
  readonly text: string;
}

export class TranscriptTerminal implements NetkitTelnetTerminal {
  private readonly parts: TranscriptPart[] = [];

  write(text: string): void {
    this.parts.push({ stderr: false, text });
  }

  error(text: string): void {
    this.parts.push({ stderr: true, text });
  }

  setMode(): void {}

  result(exitCode: number): { output: string; exitCode: number; stderr?: string; interleaved?: string } {
    const join = (parts: readonly TranscriptPart[]): string => parts.map((p) => p.text).join('').replace(/\r\n/g, '\n');
    const output = join(this.parts.filter((p) => !p.stderr));
    const stderr = join(this.parts.filter((p) => p.stderr));
    const trim = (text: string): string => text.replace(/\n$/, '');
    if (stderr === '') return { output: trim(output), exitCode };
    return { output: trim(output), exitCode, stderr: trim(stderr), interleaved: trim(join(this.parts)) };
  }
}

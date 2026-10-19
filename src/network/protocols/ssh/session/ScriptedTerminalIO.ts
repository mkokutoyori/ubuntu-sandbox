import type { ITerminalIO } from './TerminalSshInteractionHandler';

export class ScriptedTerminalIO implements ITerminalIO {
  readonly transcript: string[] = [];
  private consumedCount = 0;

  constructor(private readonly answers: string[]) {}

  get consumed(): number {
    return this.consumedCount;
  }

  writeLine(text: string): void {
    this.transcript.push(text);
  }

  readInput(prompt: string, secret: boolean): Promise<string> {
    const answer = this.answers[this.consumedCount] ?? '';
    this.consumedCount += 1;
    this.transcript.push(secret ? prompt : `${prompt}${answer}`);
    return Promise.resolve(answer);
  }
}

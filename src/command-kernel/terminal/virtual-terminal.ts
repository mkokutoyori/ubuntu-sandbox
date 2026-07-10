import { Terminal } from "./terminal";

/**
 * Implémentation entièrement en mémoire : on "nourrit" l'entrée avec
 * feed() et on inspecte output/errors. Idéale pour les tests unitaires
 * de bout en bout (Terminal -> Shell -> Interpreter -> MachineApi mockée).
 */
export class VirtualTerminal extends Terminal {
  readonly columns = 80;
  readonly rows = 24;

  private readonly inputQueue: string[] = [];
  readonly output: string[] = [];
  readonly errors: string[] = [];

  feed(...lines: string[]): void {
    this.inputQueue.push(...lines);
  }

  async readLine(_prompt: string): Promise<string | null> {
    return this.inputQueue.shift() ?? null; // file vide = EOF
  }

  async readSecret(prompt: string): Promise<string | null> {
    return this.readLine(prompt);
  }

  async write(text: string): Promise<void> {
    this.output.push(text);
  }

  async writeError(text: string): Promise<void> {
    this.errors.push(text);
  }

  async clear(): Promise<void> {
    this.output.length = 0;
  }

  /** Simule un Ctrl+C envoyé par l'utilisateur. */
  sendInterrupt(): void {
    this.listeners.forEach((l) => l.onInterrupt?.());
  }
}

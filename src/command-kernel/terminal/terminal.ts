import { InteractionChannel, PromptSpec } from "../io/interaction";
import { CommandIO, InputStream, OutputStream } from "../io/types";
import { TerminalEventListener } from "./types";

/**
 * Abstraction du périphérique : écran + clavier.
 * Le Shell ne sait pas s'il parle à une console système, un émulateur
 * web (xterm.js), un pseudo-tty SSH ou un terminal virtuel de test —
 * il ne connaît que ce contrat.
 */
export abstract class Terminal {
  protected readonly listeners: TerminalEventListener[] = [];

  abstract readonly columns: number;
  abstract readonly rows: number;

  /** Lit une ligne complète (édition locale, écho). null = EOF (Ctrl+D). */
  abstract readLine(prompt: string): Promise<string | null>;
  /** Lecture sans écho (mots de passe). */
  abstract readSecret(prompt: string): Promise<string | null>;
  abstract write(text: string): Promise<void>;
  abstract writeError(text: string): Promise<void>;
  abstract clear(): Promise<void>;

  subscribe(listener: TerminalEventListener): void {
    this.listeners.push(listener);
  }

  /**
   * ADAPTER : expose le terminal sous le contrat CommandIO consommé
   * par l'Executor. Le stdout d'une commande devient l'écran, son
   * stdin devient le clavier — sans que les commandes le sachent.
   */
  asCommandIO(): CommandIO {
    const stdin: InputStream = {
      read: async () => this.readLine(""),
      readAll: async () => {
        const lines: string[] = [];
        let line: string | null;
        while ((line = await this.readLine("")) !== null) lines.push(line);
        return lines.join("\n");
      },
    };
    const makeOut = (fn: (t: string) => Promise<void>): OutputStream => ({
      write: fn,
      close: async () => {},
    });
    const interaction: InteractionChannel = {
      prompt: async (spec: PromptSpec) => {
        const input =
          spec.kind === "secret"
            ? await this.readSecret(spec.prompt)
            : await this.readLine(spec.prompt);
        if (input !== null && input === "" && spec.defaultValue !== undefined) {
          return spec.defaultValue;
        }
        return input;
      },
    };
    return {
      stdin,
      stdout: makeOut((t) => this.write(t)),
      stderr: makeOut((t) => this.writeError(t)),
      interaction,
    };
  }
}

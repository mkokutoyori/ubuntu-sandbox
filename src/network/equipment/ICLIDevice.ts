/**
 * ICLIDevice — Interface for devices that expose a vendor CLI
 * (Cisco IOS, Huawei VRP, and any future CLI-based OS).
 *
 * CLITerminalSession uses this interface instead of duck-typing
 * through `(device as any).someMethod()`.  Router and Switch
 * already implement all these methods, so structural typing
 * keeps them compatible without adding `implements ICLIDevice`.
 */

import type { Equipment } from './Equipment';

export interface ICLIDevice extends Equipment {
  /** Current CLI prompt string (e.g. "Router#", "<Router>"). */
  getPrompt(): string;

  /** Vendor boot sequence text (line-by-line). */
  getBootSequence(): string;

  /** Banner text (e.g. MOTD). Returns empty string if none. */
  getBanner(type: string): string;

  /** Tab completion for CLI input. Returns completed string or null. */
  cliTabComplete(input: string): string | null;

  /** Context-sensitive help output for the `?` key. */
  cliHelp(inputBeforeQuestion: string): string;

  /** Verify the enable/super password. Optional — defaults to true if absent. */
  checkEnablePassword?(password: string): boolean;
}

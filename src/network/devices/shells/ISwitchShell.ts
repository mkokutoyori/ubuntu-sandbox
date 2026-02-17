/**
 * ISwitchShell - Management Plane abstraction for vendor-specific Switch CLI shells
 *
 * Each vendor shell (Cisco IOS, Huawei VRP) implements this interface
 * to provide its own command parsing, output formatting, tab completion, and help.
 */

import type { Switch } from '../Switch';

export interface ISwitchShell {
  /** Execute a raw CLI command string and return the output */
  execute(sw: Switch, rawInput: string): string;
  /** Get the current CLI prompt string (e.g. "<Switch>", "Switch#") */
  getPrompt(sw: Switch): string;
  /** Get context-sensitive help for the given input (? behavior) */
  getHelp(inputBeforeQuestion: string): string;
  /** Get tab completion for the given partial input */
  tabComplete(input: string): string | null;
}

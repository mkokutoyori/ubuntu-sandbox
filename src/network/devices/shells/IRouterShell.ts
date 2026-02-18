/**
 * IRouterShell - Management Plane abstraction for vendor-specific CLI shells
 *
 * Each vendor shell (Cisco IOS, Huawei VRP) implements this interface
 * to provide its own command parsing, output formatting, tab completion, and help.
 */

import type { Router } from '../Router';

export interface IRouterShell {
  /** Execute a raw CLI command string and return the output */
  execute(router: Router, rawInput: string): string;
  /** Get the OS type identifier */
  getOSType(): string;
  /** Get the current CLI prompt string (e.g. "Router#", "<Router>") */
  getPrompt(router: Router): string;
  /** Get context-sensitive help for the given input (? behavior) */
  getHelp(inputBeforeQuestion: string): string;
  /** Get tab completion for the given partial input */
  tabComplete(input: string): string | null;
}

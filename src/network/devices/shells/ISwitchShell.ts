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
  /**
   * Command-owned interactive flows (IoC): the shell declares which
   * commands are interactive and what their dialogue is. Terminals render
   * the returned plan; null = execute the line normally.
   */
  interactionPlanFor?(
    commandLine: string,
    ctx?: import('@/shell/interaction/CommandInteraction').InteractionPlanContext,
  ): import('@/shell/interaction/CommandInteraction').CommandInteractionPlan | null;
  /** Get the current CLI prompt string (e.g. "<Switch>", "Switch#") */
  getPrompt(sw: Switch): string;
  /** Get context-sensitive help for the given input (? behavior) */
  getHelp(inputBeforeQuestion: string, sw?: Switch): string;
  /** Get tab completion for the given partial input */
  tabComplete(input: string, sw?: Switch): string | null;
  /** All full-line Tab candidates (static keywords + live device values) */
  tabCandidates(input: string, sw: Switch): string[];
  /** Reset the CLI to its initial mode (new terminal session opened). */
  resetCliMode?(): void;
  getSelectedInterface?(): string | null;
  getSelectedInterfaceRange?(): string[];
}

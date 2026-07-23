/**
 * IRouterShell - Management Plane abstraction for vendor-specific CLI shells
 *
 * Each vendor shell (Cisco IOS, Huawei VRP) implements this interface
 * to provide its own command parsing, output formatting, tab completion, and help.
 */

import type { Router } from '../Router';

export interface IRouterShell {
  /** Execute a raw CLI command string and return the output */
  execute(router: Router, rawInput: string): string | Promise<string>;
  /** Get the OS type identifier */
  getOSType(): string;
  /** Get the current CLI prompt string (e.g. "Router#", "<Router>") */
  getPrompt(router: Router): string;
  /** Get context-sensitive help for the given input (? behavior) */
  getHelp(inputBeforeQuestion: string, router?: Router): string;
  /** Get tab completion for the given partial input */
  tabComplete(input: string): string | null;
  /** All full-line Tab candidates (static keywords + live device values) */
  tabCandidates(input: string, router: Router): string[];
  /** Attach the shell's logging config to a bus for event-driven syslog buffering. */
  attachLoggingToBus?(bus: import('@/events/EventBus').IEventBus, deviceId: string): void;
  /** The shell's logging config — source of the `terminal monitor` syslog stream. */
  getLoggingConfig?(): import('../inspection/config/LoggingConfig').LoggingConfig;
  /** Render the vendor's `show running-config` text (source for `write memory`). */
  getRunningConfigText?(router: Router): string;
  /** Re-apply a saved config text onto live router state (`copy start run`, `reload`). */
  applyConfigText?(router: Router, text: string): void;
  /**
   * Command-owned interactive flows (IoC): the shell declares which
   * commands are interactive and what their dialogue is. Terminals render
   * the returned plan; null = execute the line normally.
   */
  interactionPlanFor?(
    commandLine: string,
    ctx?: import('@/shell/interaction/CommandInteraction').InteractionPlanContext,
  ): import('@/shell/interaction/CommandInteraction').CommandInteractionPlan | null;
}

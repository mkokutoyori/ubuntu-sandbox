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
  /**
   * Open this session at the EXEC level the line grants — level 15 lands
   * straight in privileged EXEC, anything lower stays in user EXEC, as on
   * real IOS. Only vendors with a distinct level model implement it —
   * VRP's user-view prompt does not change with the account's level, so a
   * Huawei shell leaves this undefined.
   */
  beginExecSession?(level: number, user?: string): void;
  /** Get context-sensitive help for the given input (? behavior) */
  getHelp(inputBeforeQuestion: string, router?: Router): string;
  /** Get tab completion for the given partial input */
  tabComplete(input: string, device?: unknown): string | null;
  /** All full-line Tab candidates (static keywords + live device values) */
  tabCandidates(input: string, router: Router): string[];
  /** Attach the shell's logging config to a bus for event-driven syslog buffering. */
  /**
   * `device` est optionnel parce que VRP n'en a pas besoin : cote Cisco
   * il porte la politique de `login on-*-log`, que seul l'appareil
   * connait.
   */
  attachLoggingToBus?(
    bus: import('@/events/EventBus').IEventBus, deviceId: string, device?: unknown,
  ): void;
  /** The shell's logging config — source of the `terminal monitor` syslog stream. */
  getLoggingConfig?(): import('../inspection/config/LoggingConfig').LoggingConfig;
  /**
   * Which unprompted streams this line currently accepts. The streams are
   * device-wide but the choice is the line's own, so the gate lives here:
   * IOS opens both with `terminal monitor`, VRP wants `terminal monitor`
   * for its logs and `terminal debugging` on top for debug traces.
   */
  receivesAsyncOutput?(): { debug: boolean; syslog: boolean };
  /**
   * Tell the shell someone is now delivering that output live. A shell
   * that buffers it for the next keypress must stop, or the operator
   * reads every line twice.
   */
  setAsyncOutputLive?(live: boolean): void;
  /**
   * Give back everything this shell holds on the device that outlives it
   * — today, its listener on the debug registry. Called when the session
   * it was minted for ends.
   */
  releaseDebugSource?(): void;
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

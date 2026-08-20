/**
 * Command-owned interactive flows — the vendor-neutral protocol.
 *
 * Inversion of control (audit AUDIT-COHERENCE-CMD-PS-UX-HELP.md §3): the
 * COMMAND LAYER (device shells: Cisco IOS, Huawei VRP, Linux) declares which
 * commands are interactive and what their dialogue looks like — prompts,
 * confirmations, validations, and the real device actions to run. The
 * terminal layer merely renders the steps and feeds answers back; it never
 * string-matches command names or invents behaviour.
 *
 * This module lives in `src/shell/` (the vendor-agnostic shell layer) so
 * both sides can depend on it without the device layer importing terminal
 * types or vice-versa.
 */

export interface InteractionValidation {
  valid: boolean;
  /** Shown to the user when invalid (also the abort message). */
  errorMessage?: string;
  /** On invalid: total retries allowed before aborting. undefined = infinite, 0 = abort immediately. */
  maxRetries?: number;
}

/**
 * Facilities a `run` step receives from the hosting terminal session.
 * `exec` routes through the session's normal device-execution path (vty
 * privilege, timeouts, power guards) so a plan's actions behave exactly
 * like a hand-typed command.
 */
export interface InteractionRuntime {
  exec(command: string): Promise<string>;
  output(text: string): void;
  clearScreen(): void;
  /** Values collected by earlier prompt steps (keyed by storeAs). */
  readonly values: Map<string, string>;
  /** Session metadata (subshell-entry markers and other host concerns). */
  readonly metadata: Map<string, unknown>;
}

export type InteractionStep =
  | { kind: 'output'; lines: string[] }
  | {
      kind: 'text';
      prompt: string;
      storeAs?: string;
      allowEmpty?: boolean;
      defaultValue?: string;
      validate?: (value: string, values: ReadonlyMap<string, string>) => InteractionValidation;
    }
  | {
      kind: 'password';
      prompt: string;
      storeAs?: string;
      validate?: (value: string, values: ReadonlyMap<string, string>) => InteractionValidation;
    }
  | {
      kind: 'confirmation';
      prompt: string;
      defaultAnswer?: 'yes' | 'no';
      storeAs?: string;
      validate?: (value: string, values: ReadonlyMap<string, string>) => InteractionValidation;
    }
  | { kind: 'run'; run: (rt: InteractionRuntime) => Promise<void> }
  | {
      /**
       * Multi-line capture: keep prompting (with `prompt`, usually empty —
       * IOS banner capture shows a bare line) and feed every entered line
       * to `accept` until it reports completion. The final `body` is
       * stored under `storeAs`. Used for banner delimiters, heredoc-style
       * input, and any other "type lines until a terminator" dialogue.
       */
      kind: 'collect';
      prompt?: string;
      storeAs: string;
      accept: (line: string, accumulated: readonly string[]) => { done: boolean; body?: string };
    };

export interface CommandInteractionPlan {
  steps: InteractionStep[];
}

/** Caller-side facts a planner may need to decide whether a command is interactive. */
export interface InteractionPlanContext {
  currentUser?: string;
  currentUid?: number;
  /**
   * La session parle-t-elle par une ligne RESEAU (vty) plutot que par la
   * console ? IOS traite les deux differemment sur un point precis et
   * ancien : sans mot de passe d'activation configure, la console passe
   * en mode privilegie et une vty se voit refuser `% No password set`.
   */
  onVtyLine?: boolean;
  /** CLI mode for network equipment ('user' | 'privileged' | config modes…). */
  mode?: string;
  /**
   * Privilege level of the CALLING session. The shell's own field is the
   * baseline between two vty executions, not this session's — a plan
   * built from it would judge visibility against the wrong principal.
   */
  level?: number;
  /** Parser view the calling session is in, if any. */
  view?: string | null;
  /**
   * The live device instance, opaque at this vendor-neutral layer (cast by
   * the specific planner that knows its own device type). Needed by plans
   * that must read persistent device state (e.g. a configured enable
   * secret) while BUILDING the plan — before any `run` step has executed,
   * so the shell's own transient execute()-scoped device reference isn't
   * set yet.
   */
  device?: unknown;
}

/**
 * Implemented by device shells that own interactive commands. Returning
 * null means "not interactive here" — the terminal then executes the line
 * through its normal path.
 */
export interface IInteractionPlanner {
  interactionPlanFor(
    commandLine: string,
    ctx?: InteractionPlanContext,
  ): CommandInteractionPlan | null;
}

/** Type guard for optional planner support on a shell object. */
export function isInteractionPlanner(obj: unknown): obj is IInteractionPlanner {
  return !!obj && typeof (obj as IInteractionPlanner).interactionPlanFor === 'function';
}

/**
 * ShellAction — the canonical unit of work the terminal dispatches to.
 *
 * After alias / function / hashbang resolution, a command line becomes
 * exactly one {@link ResolvedAction}: a name + argv + the flow that
 * implements it. Flows are pure descriptions; they don't render or read
 * keys. They yield {@link TerminalIntent}s and consume
 * {@link InputResponse}s through an injected {@link IntentChannel}.
 *
 * The registry owns the name → action mapping. New actions (a feature, a
 * vendor-specific behaviour, an Easter egg) plug in by registering once;
 * everything else — alias bypass protection, prompt rendering, sub-shell
 * push — is handled automatically.
 */

import type { Equipment } from '@/network';
import type { TerminalIntent, InputResponse } from './TerminalIntent';

/** Per-invocation context handed to the flow. */
export interface ShellActionContext {
  /** Resolved canonical name (e.g. "sudo" even if invoked via `please`). */
  readonly name: string;
  /** argv[1..] (everything after the command word). */
  readonly args: ReadonlyArray<string>;
  /** Verbatim line the user typed — kept for history / echo. */
  readonly typedLine: string;
  /** Line after alias expansion — what the flow effectively runs. */
  readonly resolvedLine: string;
  /** Device currently in focus (top of SSH stack). */
  readonly device: Equipment;
  /** Logged-in user on that device (top of su stack). */
  readonly currentUser: string;
  /** UID matching {@link currentUser}. */
  readonly currentUid: number;
  /** Free-form bag for action-specific state (rarely needed). */
  readonly metadata: Map<string, unknown>;
}

/**
 * IntentChannel — the flow's only conduit. It yields intents and, when
 * it yields a prompt, suspends until the runtime replies via
 * {@link respond}. Implementations are typically async iterators backed
 * by a promise queue.
 */
export interface IntentChannel {
  /** Emit an intent; resolves once the runtime has processed it. */
  emit(intent: TerminalIntent): Promise<void>;
  /** Like emit() but specifically for prompts — returns the user reply. */
  ask(promptIntent: Extract<TerminalIntent, { kind: 'prompt' }>): Promise<InputResponse>;
}

/** A flow is an async function that consumes a context + channel. */
export type ShellFlow = (
  ctx: ShellActionContext,
  channel: IntentChannel,
) => Promise<void>;

export interface ShellAction {
  /** Canonical name registered in the {@link ShellActionRegistry}. */
  readonly name: string;
  /** Short human description for `command -V name` and tooltips. */
  readonly description?: string;
  /** Action verbs are dispatched by exact-match on the head word. */
  readonly match?: (head: string) => boolean;
  /** The flow implementation. */
  readonly flow: ShellFlow;
}

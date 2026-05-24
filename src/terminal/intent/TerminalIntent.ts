/**
 * TerminalIntent — backend → frontend signal carried by a flow.
 *
 * A flow yields a sequence of intents. The frontend resolves any intent
 * that demands input by replying with an `InputResponse`. Intents that
 * are purely visual (output, clearScreen, bell) don't require a reply.
 *
 * The point of the layer: a flow describes WHAT it needs in domain terms
 * ("prompt the user for a password", "push a remote vendor shell") and
 * never references React, key events, or rendering details. New input
 * widgets (date picker, file picker, select-box, masked secret …) can be
 * added by extending {@link InputPromptKind} and the renderer — no
 * change to the flows that use them.
 */

import type { InputPrompt } from './InputPrompt';
import type { ShellSubShellHandle } from './ShellSubShellHandle';

export type TerminalLineKind =
  | 'output' | 'error' | 'warning' | 'info' | 'system' | 'banner';

export interface TerminalOutputIntent {
  kind: 'output';
  lines: ReadonlyArray<string>;
  lineType?: TerminalLineKind;
}

export interface TerminalPromptIntent {
  kind: 'prompt';
  prompt: InputPrompt;
}

export interface TerminalPushShellIntent {
  kind: 'pushShell';
  handle: ShellSubShellHandle;
}

export interface TerminalPopShellIntent {
  kind: 'popShell';
  /** Optional farewell line printed before the pop (e.g. "logout"). */
  farewell?: string;
}

export interface TerminalClearScreenIntent { kind: 'clearScreen'; }
export interface TerminalBellIntent { kind: 'bell'; }

export interface TerminalCompleteIntent {
  kind: 'complete';
  exitCode: number;
}

export type TerminalIntent =
  | TerminalOutputIntent
  | TerminalPromptIntent
  | TerminalPushShellIntent
  | TerminalPopShellIntent
  | TerminalClearScreenIntent
  | TerminalBellIntent
  | TerminalCompleteIntent;

/** Frontend's reply to a {@link TerminalPromptIntent}. */
export interface InputResponse {
  /** Raw payload — string for text/password, 'y'|'n' for confirm, key for select, etc. */
  value: string;
  /** Set when the user cancelled (Ctrl+C / Escape). */
  cancelled?: boolean;
}

export const OUTPUT = (lines: string | ReadonlyArray<string>, lineType?: TerminalLineKind): TerminalOutputIntent => ({
  kind: 'output',
  lines: Array.isArray(lines) ? lines as string[] : [lines as string],
  lineType,
});

export const PROMPT = (prompt: InputPrompt): TerminalPromptIntent => ({ kind: 'prompt', prompt });
export const PUSH_SHELL = (handle: ShellSubShellHandle): TerminalPushShellIntent => ({ kind: 'pushShell', handle });
export const POP_SHELL = (farewell?: string): TerminalPopShellIntent => ({ kind: 'popShell', farewell });
export const CLEAR_SCREEN: TerminalClearScreenIntent = { kind: 'clearScreen' };
export const BELL: TerminalBellIntent = { kind: 'bell' };
export const COMPLETE = (exitCode: number = 0): TerminalCompleteIntent => ({ kind: 'complete', exitCode });

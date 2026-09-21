import { CompletionController } from './CompletionController';
import { FullLineSource, LastWordSource } from './sources';
import type { ICompletionSource } from './types';

export interface SubShellCompletionTarget {
  getCompletions?(line: string): string[];
  getCompletionsAsync?(line: string): Promise<string[]>;
  completesWholeLine?(): boolean;
}

export interface SubShellTabHost {
  readBuffer(): string;
  applyTab(input: string, suggestions: readonly string[] | null): void;
}

export function hasSubShellCompletion(sub: SubShellCompletionTarget | null): boolean {
  if (!sub) return false;
  return typeof sub.getCompletionsAsync === 'function'
    || typeof sub.getCompletions === 'function';
}

export function subShellCompletionSource(
  sub: SubShellCompletionTarget, candidates: readonly string[],
): ICompletionSource {
  const fetch = (): readonly string[] => candidates;
  return sub.completesWholeLine?.() === true
    ? new FullLineSource(fetch)
    : new LastWordSource(fetch, { uniqueSpace: 'never' });
}

function applyCandidates(
  sub: SubShellCompletionTarget,
  host: SubShellTabHost,
  controller: CompletionController,
  reverse: boolean,
  asked: string,
  candidates: readonly string[],
): void {
  if (host.readBuffer() !== asked) return;
  const out = controller.handleTab(asked, subShellCompletionSource(sub, candidates), reverse);
  if (!out.changed && out.suggestions === null) return;
  host.applyTab(out.input, out.suggestions && out.suggestions.length > 1 ? out.suggestions : null);
}

async function driveAsync(
  sub: SubShellCompletionTarget,
  host: SubShellTabHost,
  controller: CompletionController,
  reverse: boolean,
): Promise<void> {
  const asked = host.readBuffer();
  const candidates = await sub.getCompletionsAsync!(asked);
  applyCandidates(sub, host, controller, reverse, asked, candidates);
}

export function driveSubShellTab(
  sub: SubShellCompletionTarget | null,
  host: SubShellTabHost,
  controller: CompletionController,
  reverse: boolean,
): boolean {
  if (!hasSubShellCompletion(sub) || !sub) return false;

  if (typeof sub.getCompletionsAsync === 'function') {
    void driveAsync(sub, host, controller, reverse);
    return true;
  }

  const asked = host.readBuffer();
  applyCandidates(sub, host, controller, reverse, asked, sub.getCompletions!(asked));
  return true;
}

import { CompletionController } from './CompletionController';
import { CyclingPolicy, ReadlinePolicy } from './policies';
import { FullLineSource, LastWordSource } from './sources';
import type { ICompletionSource } from './types';

export interface SubShellCompletionTarget {
  getCompletions?(line: string): string[];
  getCompletionsAsync?(line: string): Promise<string[]>;
  completesWholeLine?(): boolean;
  completionStyle?(): 'readline' | 'cycling';
  completionStart?(line: string): number | null;
}

export class SubShellCompletionControllers {
  private readonly cycling = new CompletionController(new CyclingPolicy());
  private readonly readline = new CompletionController(new ReadlinePolicy({ caseInsensitive: false }));

  select(sub: SubShellCompletionTarget): CompletionController {
    return sub.completionStyle?.() === 'readline' ? this.readline : this.cycling;
  }

  reset(): void {
    this.cycling.reset();
    this.readline.reset();
  }
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
    : new LastWordSource(fetch, {
      uniqueSpace: 'never',
      wordStart: line => sub.completionStart?.(line) ?? null,
    });
}

function applyCandidates(
  sub: SubShellCompletionTarget,
  host: SubShellTabHost,
  controllers: SubShellCompletionControllers,
  reverse: boolean,
  asked: string,
  candidates: readonly string[],
): void {
  if (host.readBuffer() !== asked) return;
  const out = controllers.select(sub).handleTab(asked, subShellCompletionSource(sub, candidates), reverse);
  if (!out.changed && out.suggestions === null) return;
  host.applyTab(out.input, out.suggestions && out.suggestions.length > 1 ? out.suggestions : null);
}

async function driveAsync(
  sub: SubShellCompletionTarget,
  host: SubShellTabHost,
  controllers: SubShellCompletionControllers,
  reverse: boolean,
): Promise<void> {
  const asked = host.readBuffer();
  const candidates = await sub.getCompletionsAsync!(asked);
  applyCandidates(sub, host, controllers, reverse, asked, candidates);
}

export function driveSubShellTab(
  sub: SubShellCompletionTarget | null,
  host: SubShellTabHost,
  controllers: SubShellCompletionControllers,
  reverse: boolean,
): boolean {
  if (!hasSubShellCompletion(sub) || !sub) return false;

  if (typeof sub.getCompletionsAsync === 'function') {
    void driveAsync(sub, host, controllers, reverse);
    return true;
  }

  const asked = host.readBuffer();
  applyCandidates(sub, host, controllers, reverse, asked, sub.getCompletions!(asked));
  return true;
}

import type { CompletionCandidates, CompletionQuery, ICompletionSource } from './types';

export type UniqueSpaceMode = 'always' | 'never' | 'first-word';

export function splitLastWord(line: string): { readonly base: string; readonly word: string } {
  const match = /(\S*)$/.exec(line);
  const word = match?.[1] ?? '';
  return { base: line.slice(0, line.length - word.length), word };
}

export class LastWordSource implements ICompletionSource {
  private readonly fetch: (line: string) => readonly string[];
  private readonly spaceMode: UniqueSpaceMode;
  private readonly wordStart: (line: string) => number | null;

  constructor(
    fetch: (line: string) => readonly string[],
    options?: {
      readonly uniqueSpace?: UniqueSpaceMode;
      readonly wordStart?: (line: string) => number | null;
    },
  ) {
    this.fetch = fetch;
    this.spaceMode = options?.uniqueSpace ?? 'never';
    this.wordStart = options?.wordStart ?? (() => null);
  }

  query(q: CompletionQuery): CompletionCandidates | null {
    const candidates = this.fetch(q.line);
    if (candidates.length === 0) return null;
    const start = this.wordStart(q.line);
    const base = start === null ? splitLastWord(q.line).base : q.line.slice(0, start);
    return {
      base,
      candidates,
      appendSpaceOnUnique: this.appendSpace(base),
    };
  }

  private appendSpace(base: string): boolean {
    switch (this.spaceMode) {
      case 'always': return true;
      case 'never': return false;
      case 'first-word': return base.trim().length === 0;
    }
  }
}

export class FullLineSource implements ICompletionSource {
  private readonly fetch: (line: string) => readonly string[];
  private readonly appendSpace: boolean;

  constructor(
    fetch: (line: string) => readonly string[],
    options?: { readonly uniqueSpace?: 'always' | 'never' },
  ) {
    this.fetch = fetch;
    this.appendSpace = (options?.uniqueSpace ?? 'always') === 'always';
  }

  query(q: CompletionQuery): CompletionCandidates | null {
    const candidates = this.fetch(q.line);
    if (candidates.length === 0) return null;
    return { base: '', candidates, appendSpaceOnUnique: this.appendSpace };
  }
}

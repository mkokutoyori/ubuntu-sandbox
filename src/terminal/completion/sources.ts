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

  constructor(
    fetch: (line: string) => readonly string[],
    options?: { readonly uniqueSpace?: UniqueSpaceMode },
  ) {
    this.fetch = fetch;
    this.spaceMode = options?.uniqueSpace ?? 'never';
  }

  query(q: CompletionQuery): CompletionCandidates | null {
    const candidates = this.fetch(q.line);
    if (candidates.length === 0) return null;
    const { base } = splitLastWord(q.line);
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

  constructor(fetch: (line: string) => readonly string[]) {
    this.fetch = fetch;
  }

  query(q: CompletionQuery): CompletionCandidates | null {
    const candidates = this.fetch(q.line);
    if (candidates.length === 0) return null;
    return { base: '', candidates, appendSpaceOnUnique: true };
  }
}

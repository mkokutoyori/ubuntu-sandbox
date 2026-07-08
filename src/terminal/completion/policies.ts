import type {
  CompletionCandidates,
  CompletionPolicy,
  CyclingState,
  PolicyResolution,
} from './types';

const MAX_SUGGESTIONS = 30;

function uniqueResolution(found: CompletionCandidates): PolicyResolution {
  const only = found.candidates[0] ?? '';
  const space = found.appendSpaceOnUnique ? ' ' : '';
  return { input: found.base + only + space, suggestions: null, cycling: null };
}

function longestCommonPrefix(
  values: readonly string[],
  caseInsensitive: boolean,
): string {
  const first = values[0];
  if (first === undefined) return '';
  let prefix = first;
  for (let i = 1; i < values.length; i++) {
    const value = values[i] ?? '';
    const probe = caseInsensitive ? value.toLowerCase() : value;
    while (
      prefix.length > 0 &&
      !probe.startsWith(caseInsensitive ? prefix.toLowerCase() : prefix)
    ) {
      prefix = prefix.slice(0, -1);
    }
    if (prefix.length === 0) return '';
  }
  return prefix;
}

export class ReadlinePolicy implements CompletionPolicy {
  private readonly caseInsensitive: boolean;

  constructor(options: { readonly caseInsensitive: boolean }) {
    this.caseInsensitive = options.caseInsensitive;
  }

  resolve(
    input: string,
    _state: CyclingState | null,
    found: CompletionCandidates,
    _reverse: boolean,
  ): PolicyResolution {
    if (found.candidates.length === 1) return uniqueResolution(found);

    const word = input.slice(found.base.length);
    const prefix = longestCommonPrefix(found.candidates, this.caseInsensitive);

    if (prefix.length > word.length) {
      return { input: found.base + prefix, suggestions: null, cycling: null };
    }
    return {
      input,
      suggestions: found.candidates.slice(0, MAX_SUGGESTIONS),
      cycling: null,
    };
  }
}

export class CyclingPolicy implements CompletionPolicy {
  resolve(
    _input: string,
    state: CyclingState | null,
    found: CompletionCandidates,
    reverse: boolean,
  ): PolicyResolution {
    if (state === null && found.candidates.length === 1) {
      return uniqueResolution(found);
    }

    if (state !== null && state.candidates.length > 1) {
      const n = state.candidates.length;
      const index = (state.index + (reverse ? -1 : 1) + n) % n;
      const next = state.candidates[index] ?? '';
      const applied = state.base + next;
      return {
        input: applied,
        suggestions: state.candidates,
        cycling: { base: state.base, candidates: state.candidates, index, applied },
      };
    }

    const index = reverse ? found.candidates.length - 1 : 0;
    const first = found.candidates[index] ?? '';
    const applied = found.base + first;
    return {
      input: applied,
      suggestions: found.candidates.length > 1 ? found.candidates : null,
      cycling: { base: found.base, candidates: found.candidates, index, applied },
    };
  }
}

export class SilentUniquePolicy implements CompletionPolicy {
  resolve(
    input: string,
    _state: CyclingState | null,
    found: CompletionCandidates,
    _reverse: boolean,
  ): PolicyResolution {
    if (found.candidates.length === 1) return uniqueResolution(found);
    return { input, suggestions: null, cycling: null };
  }
}

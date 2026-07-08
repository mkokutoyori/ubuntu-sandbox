export interface CompletionQuery {
  readonly line: string;
}

export interface CompletionCandidates {
  readonly base: string;
  readonly candidates: readonly string[];
  readonly appendSpaceOnUnique: boolean;
}

export interface ICompletionSource {
  query(q: CompletionQuery): CompletionCandidates | null;
}

export interface CyclingState {
  readonly base: string;
  readonly candidates: readonly string[];
  readonly index: number;
  readonly applied: string;
}

export interface PolicyResolution {
  readonly input: string;
  readonly suggestions: readonly string[] | null;
  readonly cycling: CyclingState | null;
}

export interface CompletionPolicy {
  resolve(
    input: string,
    state: CyclingState | null,
    found: CompletionCandidates,
    reverse: boolean,
  ): PolicyResolution;
}

export interface TabOutcome {
  readonly input: string;
  readonly suggestions: readonly string[] | null;
  readonly changed: boolean;
}

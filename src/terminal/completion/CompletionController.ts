import type {
  CompletionPolicy,
  CyclingState,
  ICompletionSource,
  TabOutcome,
} from './types';

export class CompletionController {
  private readonly policy: CompletionPolicy;
  private state: CyclingState | null = null;

  constructor(policy: CompletionPolicy) {
    this.policy = policy;
  }

  handleTab(input: string, source: ICompletionSource, reverse: boolean): TabOutcome {
    const continuing = this.state !== null && this.state.applied === input;
    if (!continuing) this.state = null;

    if (continuing && this.state !== null) {
      const resolved = this.policy.resolve(input, this.state, {
        base: this.state.base,
        candidates: this.state.candidates,
        appendSpaceOnUnique: false,
      }, reverse);
      this.state = resolved.cycling;
      return {
        input: resolved.input,
        suggestions: resolved.suggestions,
        changed: resolved.input !== input,
      };
    }

    const found = source.query({ line: input });
    if (found === null || found.candidates.length === 0) {
      this.state = null;
      return { input, suggestions: null, changed: false };
    }

    const resolved = this.policy.resolve(input, null, found, reverse);
    this.state = resolved.cycling;
    return {
      input: resolved.input,
      suggestions: resolved.suggestions,
      changed: resolved.input !== input,
    };
  }

  notifyInputChanged(input: string): void {
    if (this.state !== null && this.state.applied !== input) this.state = null;
  }

  reset(): void {
    this.state = null;
  }
}

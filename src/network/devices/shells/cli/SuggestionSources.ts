import type { CommandNode, ParamType } from '../CommandTrie';

export type SuggestionOrigin = 'child' | 'param' | 'hint' | 'auto' | 'dynamic';

export interface SuggestionCandidate {
  keyword: string;
  description: string;
  origin: SuggestionOrigin;
  leadingOnly?: boolean;
}

export interface SuggestionRequest {
  node: CommandNode;
  path: readonly string[];
  consumedArgs: number;
  argsSoFar: readonly string[];
  partial: string;
  matchPartial: boolean;
  forTab: boolean;
}

export interface SuggestionTrieAccess {
  childCandidates(request: SuggestionRequest): SuggestionCandidate[];
  paramCandidates(request: SuggestionRequest): SuggestionCandidate[];
  hintCandidates(request: SuggestionRequest): SuggestionCandidate[];
  autoCandidates(request: SuggestionRequest): SuggestionCandidate[];
  dynamicCandidates(request: SuggestionRequest): SuggestionCandidate[];
}

export interface SuggestionSource {
  readonly origin: SuggestionOrigin;
  collect(request: SuggestionRequest, access: SuggestionTrieAccess): SuggestionCandidate[];
}

export const SUGGESTION_SOURCES: readonly SuggestionSource[] = [
  { origin: 'child', collect: (r, a) => a.childCandidates(r) },
  { origin: 'param', collect: (r, a) => a.paramCandidates(r) },
  { origin: 'hint', collect: (r, a) => a.hintCandidates(r) },
  { origin: 'auto', collect: (r, a) => a.autoCandidates(r) },
  { origin: 'dynamic', collect: (r, a) => a.dynamicCandidates(r) },
];

export interface DynamicRequestShape {
  readonly path: readonly string[];
  readonly paramType: ParamType | null;
  readonly partial: string;
}

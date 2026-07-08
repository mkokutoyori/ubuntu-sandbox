export type {
  CompletionQuery,
  CompletionCandidates,
  ICompletionSource,
  CyclingState,
  PolicyResolution,
  CompletionPolicy,
  TabOutcome,
} from './types';
export { ReadlinePolicy, CyclingPolicy, SilentUniquePolicy } from './policies';
export { CompletionController } from './CompletionController';
export { LastWordSource, FullLineSource, splitLastWord } from './sources';
export { ghostRemainder } from './ghost';
export type { UniqueSpaceMode } from './sources';

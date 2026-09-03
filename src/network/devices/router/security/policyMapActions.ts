import { boundedInteger } from '@/cli/ArgumentTypes';

export type PolicyMapActionKind =
  | 'police' | 'inspect' | 'drop' | 'pass' | 'set-dscp' | 'set-precedence'
  | 'priority' | 'bandwidth' | 'fair-queue' | 'random-detect' | 'shape'
  | 'service-policy' | 'queue-limit' | 'compression';

export interface PolicyMapAction {
  kind: PolicyMapActionKind;
  args: string[];
}

export interface ActionProblem {
  at: number;
  incomplete: boolean;
}

const INCOMPLETE: ActionProblem = { at: 0, incomplete: true };
const refusedAt = (at: number): ActionProblem => ({ at, incomplete: false });

export interface PolicyMapActionSpec {
  readonly kind: PolicyMapActionKind;
  readonly words: string;
  readonly description: string;
  readonly greedy: boolean;
  readonly problem?: (args: readonly string[]) => ActionProblem | null;
}

export const PERCENT_MIN = 1;
export const PERCENT_MAX = 100;

function rateOrPercent(args: readonly string[], allowRemaining: boolean): ActionProblem | null {
  if (args.length === 0) return INCOMPLETE;

  let i = 0;
  if (allowRemaining && args[i]?.toLowerCase() === 'remaining') i++;
  if (args[i]?.toLowerCase() === 'percent') {
    if (args[i + 1] === undefined) return INCOMPLETE;
    return boundedInteger(args[i + 1], PERCENT_MIN, PERCENT_MAX) === null
      ? refusedAt(i + 1) : null;
  }
  if (i !== 0) return refusedAt(i);
  return /^\d+$/.test(args[0]) ? null : refusedAt(0);
}

function shapeRate(args: readonly string[]): ActionProblem | null {
  if (args.length === 0) return INCOMPLETE;

  const mode = args[0].toLowerCase();
  if (mode !== 'average' && mode !== 'peak') return refusedAt(0);
  if (args[1] === undefined) return INCOMPLETE;
  return /^\d+$/.test(args[1]) ? null : refusedAt(1);
}

function packetCount(args: readonly string[]): ActionProblem | null {
  if (args.length === 0) return INCOMPLETE;
  return /^\d+$/.test(args[0]) ? null : refusedAt(0);
}

export const POLICY_MAP_ACTIONS: readonly PolicyMapActionSpec[] = Object.freeze([
  { kind: 'police', words: 'police', description: 'Police traffic', greedy: true },
  { kind: 'inspect', words: 'inspect', description: 'Inspect', greedy: false },
  { kind: 'drop', words: 'drop', description: 'Drop', greedy: true },
  { kind: 'pass', words: 'pass', description: 'Pass', greedy: false },
  { kind: 'set-dscp', words: 'set dscp', description: 'Set DSCP', greedy: true },
  { kind: 'set-precedence', words: 'set precedence', description: 'Set precedence', greedy: true },
  {
    kind: 'priority', words: 'priority', description: 'Reserve bandwidth for priority',
    greedy: true, problem: (args) => rateOrPercent(args, false),
  },
  {
    kind: 'bandwidth', words: 'bandwidth', description: 'Reserve bandwidth',
    greedy: true, problem: (args) => rateOrPercent(args, true),
  },
  { kind: 'fair-queue', words: 'fair-queue', description: 'Enable WFQ', greedy: false },
  { kind: 'random-detect', words: 'random-detect', description: 'WRED configuration', greedy: true },
  {
    kind: 'shape', words: 'shape', description: 'Traffic shape',
    greedy: true, problem: shapeRate,
  },
  { kind: 'service-policy', words: 'service-policy', description: 'Nested service-policy', greedy: true },
  {
    kind: 'queue-limit', words: 'queue-limit', description: 'Queue depth',
    greedy: true, problem: packetCount,
  },
  { kind: 'compression', words: 'compression', description: 'Compression', greedy: true },
]);

const WORDS_BY_KIND = new Map(POLICY_MAP_ACTIONS.map((a) => [a.kind, a.words]));

export function policyMapActionLine(action: PolicyMapAction): string {
  const words = WORDS_BY_KIND.get(action.kind) ?? action.kind;
  return action.args.length > 0 ? `${words} ${action.args.join(' ')}` : words;
}

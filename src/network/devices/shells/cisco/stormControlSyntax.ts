export const STORM_CONTROL_TYPES: readonly string[] = ['broadcast', 'multicast', 'unicast'];
export const STORM_CONTROL_ACTIONS: readonly string[] = ['shutdown', 'trap'];
export const STORM_CONTROL_UNITS: readonly string[] = ['pps', 'bps'];

export const LEVEL_PERCENT_MIN = 0;
export const LEVEL_PERCENT_MAX = 100;

export interface StormControlLevel {
  kind: 'level';
  type: string;
  unit: 'percent' | 'pps' | 'bps';
  upper: number;
  lower: number;
}

export interface StormControlAction {
  kind: 'action';
  action: string;
}

export type StormControlSetting = StormControlLevel | StormControlAction;

export interface StormControlParse {
  setting: StormControlSetting | null;
  at: number;
  incomplete: boolean;
}

const refusedAt = (at: number): StormControlParse =>
  ({ setting: null, at, incomplete: false });
const incompleteAt = (at: number): StormControlParse =>
  ({ setting: null, at, incomplete: true });

function rate(token: string | undefined): number | null {
  if (token === undefined || !/^\d+(\.\d+)?$/.test(token)) return null;
  return Number(token);
}

function percent(token: string | undefined): number | null {
  const value = rate(token);
  if (value === null) return null;
  return value >= LEVEL_PERCENT_MIN && value <= LEVEL_PERCENT_MAX ? value : null;
}

export function parseStormControl(args: readonly string[]): StormControlParse {
  if (args.length === 0) return incompleteAt(0);

  const head = args[0].toLowerCase();
  if (head === 'action') {
    if (args[1] === undefined) return incompleteAt(1);
    if (!STORM_CONTROL_ACTIONS.includes(args[1].toLowerCase())) return refusedAt(1);
    if (args.length > 2) return refusedAt(2);
    return { setting: { kind: 'action', action: args[1].toLowerCase() }, at: -1, incomplete: false };
  }

  if (!STORM_CONTROL_TYPES.includes(head)) return refusedAt(0);
  if (args[1] === undefined) return incompleteAt(1);
  if (args[1].toLowerCase() !== 'level') return refusedAt(1);
  if (args[2] === undefined) return incompleteAt(2);

  const unitWord = args[2].toLowerCase();
  if (STORM_CONTROL_UNITS.includes(unitWord)) {
    if (args[3] === undefined) return incompleteAt(3);
    const upper = rate(args[3]);
    if (upper === null) return refusedAt(3);

    const lower = args[4] === undefined ? upper : rate(args[4]);
    if (lower === null) return refusedAt(4);
    if (args.length > 5) return refusedAt(5);
    return {
      setting: { kind: 'level', type: head, unit: unitWord as 'pps' | 'bps', upper, lower },
      at: -1, incomplete: false,
    };
  }

  const upper = percent(args[2]);
  if (upper === null) return refusedAt(2);

  const lower = args[3] === undefined ? upper : percent(args[3]);
  if (lower === null) return refusedAt(3);
  if (args.length > 4) return refusedAt(4);
  return {
    setting: { kind: 'level', type: head, unit: 'percent', upper, lower },
    at: -1, incomplete: false,
  };
}

export function stormControlPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

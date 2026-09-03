import {
  TIME_RANGE_DAYS,
  type TimeRange,
  type TimeRangePeriodic,
  isTimeRangeActive,
  parseAbsoluteClause,
  parsePeriodicClause,
  samePeriodic,
  timeRangeBodyLines,
} from '../../../network/devices/router/security/timeRange';
import { CliInvalidInput } from '../../../network/devices/shells/cli/CliDiagnostic';
import type { CliSession } from '../../CliSession';
import type { CommandSpec } from '../../CommandTable';

export const TIME_RANGE_MODE = 'config-time-range';
export const TIME_RANGE_FIELD = 'selectedTimeRange';

export interface TimeRangeStore {
  ensureTimeRange(name: string): TimeRange;
  getTimeRange(name: string): TimeRange | undefined;
  listTimeRanges(): TimeRange[];
  removeTimeRange(name: string): boolean;
}

export interface TimeRangeHost {
  timeRangeStore(): TimeRangeStore | null;
  timeRangeClockMs?(): number;
  timeRangesUsedByAcls?(): readonly string[];
}

function host(device: unknown): TimeRangeHost | null {
  const candidate = device as TimeRangeHost | null;
  return typeof candidate?.timeRangeStore === 'function' ? candidate : null;
}

function store(session: CliSession): TimeRangeStore | null {
  return host(session.device)?.timeRangeStore() ?? null;
}

function selected(session: CliSession): TimeRange | null {
  const name = session.fields[TIME_RANGE_FIELD];
  return name ? store(session)?.getTimeRange(name) ?? null : null;
}

const DAY_ALTERNATIVES = TIME_RANGE_DAYS.map(
  (d) => ({ keyword: d.keyword, description: d.description }),
);

const DECLARE: CommandSpec = {
  id: 'time-range-declare',
  path: ['time-range', { name: 'name', type: 'WORD', description: 'Name of the time range' }],
  description: 'Define time range functions',
  undoDescription: 'Remove a time range',
  modes: ['config'], minPrivilege: 15,
  enters: TIME_RANGE_MODE,
  contextField: TIME_RANGE_FIELD,
  contextFrom: 'name',
  run: (session, args) => {
    const target = store(session);
    if (!target) return '% Time ranges are not supported on this platform';

    target.ensureTimeRange(args.name);
    return '';
  },
  undo: (session, args) => {
    const target = store(session);
    if (!target) return '% Time ranges are not supported on this platform';

    target.removeTimeRange(args.name);
    return '';
  },
};

const PERIODIC: CommandSpec = {
  id: 'time-range-periodic',
  path: ['periodic', {
    name: 'clause', type: 'REST',
    description: 'Days of the week, then hh:mm to hh:mm',
    alternatives: DAY_ALTERNATIVES,
  }],
  description: 'Periodic time range',
  undoDescription: 'Remove a periodic time range',
  modes: [TIME_RANGE_MODE], minPrivilege: 15,
  run: (session, args) => {
    const tr = selected(session);
    if (!tr) return '';

    const clause = periodicOrRefuse(args.clause);
    if (!tr.periodic.some((p) => samePeriodic(p, clause))) tr.periodic.push(clause);
    return '';
  },
  undo: (session, args) => {
    const tr = selected(session);
    if (!tr) return '';

    const clause = periodicOrRefuse(args.clause);
    tr.periodic = tr.periodic.filter((p) => !samePeriodic(p, clause));
    return '';
  },
};

const ABSOLUTE: CommandSpec = {
  id: 'time-range-absolute',
  path: ['absolute', {
    name: 'clause', type: 'REST', optional: true,
    description: 'Start and end of the range',
    alternatives: [
      { keyword: 'start', description: 'Time the range starts' },
      { keyword: 'end', description: 'Time the range ends' },
    ],
  }],
  description: 'Absolute time range',
  undoDescription: 'Remove the absolute time range',
  modes: [TIME_RANGE_MODE], minPrivilege: 15,
  run: (session, args) => {
    const tr = selected(session);
    if (!tr) return '';

    const given = words(args.clause);
    const parsed = parseAbsoluteClause(given);
    if (!parsed.clause) throw new CliInvalidInput({ token: given[parsed.at] });

    tr.absolute = parsed.clause;
    return '';
  },
  undo: (session) => {
    const tr = selected(session);
    if (tr) delete tr.absolute;
    return '';
  },
};

const SHOW: CommandSpec = {
  id: 'show-time-range',
  path: ['show', 'time-range',
    { name: 'name', type: 'WORD', optional: true, description: 'Name of the time range' }],
  description: 'Time range',
  modes: ['user', 'privileged'], minPrivilege: 1,
  run: (session, args) => {
    const target = store(session);
    if (!target) return '';

    const all = target.listTimeRanges();
    const wanted = args.name ? all.filter((tr) => tr.name === args.name) : all;
    if (wanted.length === 0) return '';

    const owner = host(session.device);
    const now = new Date(owner?.timeRangeClockMs?.() ?? Date.now());
    const used = new Set(owner?.timeRangesUsedByAcls?.() ?? []);

    const lines: string[] = [];
    for (const tr of wanted) {
      lines.push(`time-range entry: ${tr.name} (${isTimeRangeActive(tr, now) ? 'active' : 'inactive'})`);
      for (const body of timeRangeBodyLines(tr)) lines.push(`   ${body}`);
      if (used.has(tr.name)) lines.push('   used in: IP ACL entry');
    }
    return lines.join('\n');
  },
};

function words(clause: string | undefined): string[] {
  return (clause ?? '').trim().split(/\s+/).filter(Boolean);
}

function periodicOrRefuse(clause: string | undefined): TimeRangePeriodic {
  const given = words(clause);
  const parsed = parsePeriodicClause(given);
  if (!parsed.clause) throw new CliInvalidInput({ token: given[parsed.at] });

  return parsed.clause;
}

export const TIME_RANGE_FAMILY: readonly CommandSpec[] = Object.freeze([
  DECLARE, PERIODIC, ABSOLUTE, SHOW,
]);

import type { ArgumentSpec } from '../../ArgumentTypes';
import type { CommandSpec } from '../../CommandTable';
import {
  SUMMER_TIME_OFFSET_RANGE, SUMMER_TIME_YEAR_RANGE,
} from '../../../network/devices/shells/cisco/clockSummerTime';
import { MONTHS, clockTime, monthOrDay } from './clockPlaces';

export interface SummerTimeHost {
  apply(words: string[], negate: boolean): string;
}

const ZONE: ArgumentSpec = {
  name: 'zone', type: 'WORD', description: 'Name of time zone in summer',
  tabSuggestions: ['BST', 'CEST', 'EEST', 'EDT', 'CDT', 'MDT', 'PDT', 'ADT', 'AKDT'],
};

const WEEKS = ['first', 'last', '1', '2', '3', '4', '5'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function named(
  name: string, description: string, words: readonly string[], pattern: RegExp,
): ArgumentSpec {
  return {
    name, type: 'WORD', description, pattern,
    alternatives: words.map((keyword) => ({ keyword, description })),
    formsAreExhaustive: true,
  };
}

const prefixOf = (words: readonly string[]): RegExp =>
  new RegExp(`^(?:${words.map((w) => w.slice(0, 3)).join('|')})[a-z]*$`, 'i');

function recurringBound(side: 'start' | 'end'): ArgumentSpec[] {
  return [
    named(`${side}-week`, 'Week of the month', WEEKS, /^(?:first|last|[1-5])$/i),
    named(`${side}-day`, 'Weekday', DAYS, prefixOf(DAYS)),
    named(`${side}-month`, 'Month', MONTHS, prefixOf(MONTHS)),
    clockTime(`${side}-time`, 'Time of day (hh:mm)'),
  ];
}

function dateBound(side: 'start' | 'end'): ArgumentSpec[] {
  return [
    monthOrDay(`${side}-first`, 'Day of the month or month'),
    monthOrDay(`${side}-second`, 'Month or day of the month'),
    {
      name: `${side}-year`, type: 'INT', range: SUMMER_TIME_YEAR_RANGE, description: 'Year',
    },
    clockTime(`${side}-time`, 'Time of day (hh:mm)'),
  ];
}

const OFFSET: ArgumentSpec = {
  name: 'offset', type: 'INT', range: SUMMER_TIME_OFFSET_RANGE, optional: true,
  description: 'Offset to add in minutes',
};

const BOUND_KEYS = ['start', 'end'] as const;

function wordsOf(
  zone: string, kind: 'recurring' | 'date', args: Record<string, string>,
): string[] {
  const order = kind === 'recurring'
    ? ['week', 'day', 'month', 'time'] : ['first', 'second', 'year', 'time'];
  const words: string[] = ['summer-time', zone, kind];
  for (const side of BOUND_KEYS) {
    for (const part of order) words.push(args[`${side}-${part}`]);
  }
  if (args.offset !== undefined) words.push(args.offset);
  return words;
}

export function summerTimeFamily(host: () => SummerTimeHost): CommandSpec[] {
  const base = {
    modes: ['config'], minPrivilege: 15,
  };
  return [
    {
      ...base,
      id: 'clock-summer-time-recurring',
      path: ['clock', 'summer-time', ZONE, 'recurring'],
      description: 'Configure recurring summer time',
      run: (_session, args) => host().apply(['summer-time', args.zone, 'recurring'], false),
      undo: (_session, args) => host().apply(['summer-time', args.zone, 'recurring'], true),
    },
    {
      ...base,
      id: 'clock-summer-time-recurring-rule',
      path: [
        'clock', 'summer-time', ZONE, 'recurring',
        ...recurringBound('start'), ...recurringBound('end'), OFFSET,
      ],
      description: 'Configure recurring summer time',
      run: (_session, args) => host().apply(wordsOf(args.zone, 'recurring', args), false),
    },
    {
      ...base,
      id: 'clock-summer-time-date',
      path: [
        'clock', 'summer-time', ZONE, 'date',
        ...dateBound('start'), ...dateBound('end'), OFFSET,
      ],
      description: 'Configure summer time for one specific date',
      run: (_session, args) => host().apply(wordsOf(args.zone, 'date', args), false),
    },
    {
      ...base,
      id: 'clock-summer-time-undo',
      path: ['clock', 'summer-time'],
      description: 'Configure daylight saving time',
      existsOnlyNegated: true,
      run: () => '% Incomplete command.',
      undo: () => host().apply(['summer-time'], true),
    },
  ];
}

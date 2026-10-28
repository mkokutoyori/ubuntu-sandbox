import type { ArgumentSpec } from '../../ArgumentTypes';
import type { CommandSpec } from '../../CommandTable';
import type { OptionSpec } from '../../OptionBag';
import {
  bareTimestampSpec, disabledTimestampSpec, type TimestampSpec,
} from '../../../network/devices/inspection/config/LoggingConfig';

export type TimestampChannel = 'debug' | 'log';

export interface ServiceLoggingHost {
  setTimestamps(channels: readonly TimestampChannel[], spec: TimestampSpec): void;
  setSequenceNumbers(on: boolean): void;
}

const CHANNEL: ArgumentSpec = {
  name: 'channel', type: 'ENUM', description: 'Message class to timestamp',
  values: [
    { keyword: 'debug', description: 'Timestamp debug messages' },
    { keyword: 'log', description: 'Timestamp log messages' },
  ],
};

const MSEC: OptionSpec = { keyword: 'msec', description: 'Include milliseconds in the timestamp' };

const DATETIME_OPTIONS: readonly OptionSpec[] = [
  MSEC,
  { keyword: 'localtime', description: 'Use local time zone for timestamps' },
  { keyword: 'show-timezone', description: 'Add time zone information to timestamp' },
  { keyword: 'year', description: 'Include year in timestamp' },
];

function channelsOf(args: Record<string, string>): TimestampChannel[] {
  return args.channel === 'debug' || args.channel === 'log' ? [args.channel] : ['debug', 'log'];
}

function specOf(format: 'uptime' | 'datetime', args: Record<string, string>): TimestampSpec {
  const spec = bareTimestampSpec();
  spec.format = format;
  spec.msec = args.msec !== undefined;
  if (format === 'datetime') {
    spec.localtime = args.localtime !== undefined;
    spec.showTimezone = args['show-timezone'] !== undefined;
    spec.year = args.year !== undefined;
  }
  return spec;
}

export function serviceLoggingFamily(host: () => ServiceLoggingHost): CommandSpec[] {
  const base = {
    modes: ['config'], minPrivilege: 15,
  } as const;

  const bare = (withChannel: boolean): CommandSpec => ({
    ...base,
    id: withChannel ? 'service-timestamps-channel' : 'service-timestamps',
    path: withChannel ? ['service', 'timestamps', CHANNEL] : ['service', 'timestamps'],
    description: 'Timestamp log/debug messages',
    undoDescription: 'Stop timestamping messages',
    run: (_session, args) => { host().setTimestamps(channelsOf(args), bareTimestampSpec()); return ''; },
    undo: (_session, args) => { host().setTimestamps(channelsOf(args), disabledTimestampSpec()); return ''; },
  });

  const format = (name: 'uptime' | 'datetime', description: string, options: readonly OptionSpec[]): CommandSpec => ({
    ...base,
    id: `service-timestamps-${name}`,
    path: ['service', 'timestamps', CHANNEL, name],
    description,
    undoDescription: 'Stop timestamping messages',
    options,
    run: (_session, args) => { host().setTimestamps(channelsOf(args), specOf(name, args)); return ''; },
    undo: (_session, args) => { host().setTimestamps(channelsOf(args), disabledTimestampSpec()); return ''; },
  });

  const sequence: CommandSpec = {
    ...base,
    id: 'service-sequence-numbers',
    path: ['service', 'sequence-numbers'],
    description: 'Stamp logger messages with a sequence number',
    undoDescription: 'Stop stamping logger messages',
    run: () => { host().setSequenceNumbers(true); return ''; },
    undo: () => { host().setSequenceNumbers(false); return ''; },
  };

  return [
    bare(false),
    bare(true),
    format('uptime', 'Timestamp with system uptime', [MSEC]),
    format('datetime', 'Timestamp with date and time', DATETIME_OPTIONS),
    sequence,
  ];
}

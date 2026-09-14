import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { OptionSpec } from '@/cli/OptionBag';
import { MAX_PING_REPEAT, resolveTargetFamily, type ParsedPing } from './ciscoPing';
import { CISCO_ERRORS } from '../cli-utils';

const MODES = ['user', 'privileged'] as const;

export interface TracerouteRequest {
  target: string;
  protocol: 'ip' | 'ipv6';
  firstTtl: number;
  maxHops: number;
  timeoutMs: number;
  probesPerHop: number;
}

export interface EchoHost {
  pingWithoutTarget(): string;
  runPing(request: ParsedPing): string;
  tracerouteWithoutTarget(): string;
  runTraceroute(request: TracerouteRequest): string;
}

const PING_TARGET: ArgumentSpec = {
  name: 'destination', type: 'WORD',
  description: 'Ping destination address or hostname',
};

const TRACE_TARGET: ArgumentSpec = {
  name: 'destination', type: 'WORD',
  description: 'Trace route to destination address or hostname',
};

const POSITIVE_MAX = 4294967295;

const PING_OPTIONS: readonly OptionSpec[] = [
  {
    keyword: 'repeat', description: 'Repeat count',
    argument: {
      name: 'repeat', type: 'INT', range: [1, MAX_PING_REPEAT],
      description: 'Repeat count',
    },
  },
  {
    keyword: 'size', description: 'Datagram size',
    argument: {
      name: 'size', type: 'INT', range: [36, 18024], description: 'Datagram size',
    },
  },
  {
    keyword: 'source', description: 'Source address or interface',
    argument: {
      name: 'source', type: 'WORD', description: 'Source address or interface',
    },
    moreArguments: [{
      name: 'sourceUnit', type: 'INT', optional: true,
      description: 'Interface number',
    }],
  },
  {
    keyword: 'timeout', description: 'Timeout in seconds',
    argument: {
      name: 'timeout', type: 'INT', range: [1, POSITIVE_MAX],
      description: 'Timeout in seconds',
    },
  },
];

const TRACE_OPTIONS: readonly OptionSpec[] = [
  {
    keyword: 'probe', description: 'Probe count',
    argument: {
      name: 'probe', type: 'INT', range: [1, MAX_PING_REPEAT], description: 'Probe count',
    },
  },
  {
    keyword: 'timeout', description: 'Timeout in seconds',
    argument: {
      name: 'timeout', type: 'INT', range: [1, POSITIVE_MAX],
      description: 'Timeout in seconds',
    },
  },
  {
    keyword: 'ttl', description: 'Minimum and maximum time to live',
    argument: {
      name: 'ttlMin', type: 'INT', range: [1, 255], description: 'Minimum time to live',
    },
    moreArguments: [{
      name: 'ttlMax', type: 'INT', range: [1, 255], description: 'Maximum time to live',
    }],
  },
];

const entier = (args: Record<string, string>, nom: string, defaut: number): number =>
  args[nom] === undefined ? defaut : Number(args[nom]);

function pingRequest(
  args: Record<string, string>, announced: 'ip' | 'ipv6',
): ParsedPing | string {
  const famille = resolveTargetFamily(args.destination, announced);
  if ('error' in famille) return famille.error;
  return {
    target: args.destination,
    count: entier(args, 'repeat', 5),
    timeoutMs: entier(args, 'timeout', 2) * 1000,
    sizeBytes: entier(args, 'size', 100),
    sourceIP: args.source === undefined
      ? null
      : `${args.source}${args.sourceUnit ?? ''}`,
    protocol: famille.protocol,
  };
}

function tracerouteRequest(
  args: Record<string, string>, announced: 'ip' | 'ipv6',
): TracerouteRequest | string {
  const famille = resolveTargetFamily(args.destination, announced);
  if ('error' in famille) return famille.error;
  const firstTtl = entier(args, 'ttlMin', 1);
  const maxHops = entier(args, 'ttlMax', 30);
  if (firstTtl > maxHops) return CISCO_ERRORS.INVALID_INPUT;
  return {
    target: args.destination,
    protocol: famille.protocol,
    firstTtl,
    maxHops,
    timeoutMs: entier(args, 'timeout', 2) * 1000,
    probesPerHop: entier(args, 'probe', 3),
  };
}

export function echoSpecs(
  ctx: () => EchoHost,
  options: { readonly ipv6: boolean; readonly traceroute: boolean },
): CommandSpec[] {
  const familles: ReadonlyArray<readonly [string, 'ip' | 'ipv6']> = options.ipv6
    ? [['ip', 'ip'], ['ipv6', 'ipv6']]
    : [['ip', 'ip']];

  const specs: CommandSpec[] = [
    {
      id: 'ping',
      path: ['ping'],
      description: 'Send echo messages',
      modes: MODES, minPrivilege: 1,
      run: () => ctx().pingWithoutTarget(),
    },
    {
      id: 'ping-destination',
      path: ['ping', PING_TARGET],
      description: 'Send echo messages',
      modes: MODES, minPrivilege: 1,
      options: PING_OPTIONS,
      run: (_s, args) => {
        const demande = pingRequest(args, 'ip');
        return typeof demande === 'string' ? demande : ctx().runPing(demande);
      },
    },
  ];

  for (const [mot, famille] of familles) {
    specs.push({
      id: `ping-${mot}`,
      path: ['ping', mot, PING_TARGET],
      description: famille === 'ipv6' ? 'IPv6 echo' : 'IP echo',
      modes: MODES, minPrivilege: 1,
      options: PING_OPTIONS,
      run: (_s, args) => {
        const demande = pingRequest(args, famille);
        return typeof demande === 'string' ? demande : ctx().runPing(demande);
      },
    });
  }

  if (!options.traceroute) return specs;

  specs.push({
    id: 'traceroute',
    path: ['traceroute'],
    description: 'Trace route to destination',
    modes: MODES, minPrivilege: 1,
    run: () => ctx().tracerouteWithoutTarget(),
  }, {
    id: 'traceroute-destination',
    path: ['traceroute', TRACE_TARGET],
    description: 'Trace route to destination',
    modes: MODES, minPrivilege: 1,
    options: TRACE_OPTIONS,
    run: (_s, args) => {
      const demande = tracerouteRequest(args, 'ip');
      return typeof demande === 'string' ? demande : ctx().runTraceroute(demande);
    },
  });

  for (const [mot, famille] of familles) {
    specs.push({
      id: `traceroute-${mot}`,
      path: ['traceroute', mot, TRACE_TARGET],
      description: famille === 'ipv6' ? 'IPv6 Trace' : 'IP Trace',
      modes: MODES, minPrivilege: 1,
      options: TRACE_OPTIONS,
      run: (_s, args) => {
        const demande = tracerouteRequest(args, famille);
        return typeof demande === 'string' ? demande : ctx().runTraceroute(demande);
      },
    });
  }
  return specs;
}

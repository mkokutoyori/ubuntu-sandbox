import type { ArgumentSpec } from '../../ArgumentTypes';
import type { CommandSpec } from '../../CommandTable';
import type { SequenceHost } from '../SequenceFamily';

const ADDRESS: ArgumentSpec = {
  name: 'address', type: 'IP_ADDR', description: 'IP address of SNMP notification host',
};

const COMMUNITY: ArgumentSpec = {
  name: 'community', type: 'WORD', description: 'SNMP community string or v3 user name',
};

const UDP_PORT: ArgumentSpec = {
  name: 'port', type: 'INT', range: [1, 65535], description: 'UDP destination port',
};

const TAIL: ArgumentSpec = {
  name: 'options', type: 'REST', optional: true,
  description: 'UDP port and notification types', literal: 'LINE',
  alternatives: [{ keyword: 'udp-port', description: 'UDP destination port' }],
};

const VERSION_1_2C: ArgumentSpec = {
  name: 'version', type: 'ENUM', description: 'SNMP version',
  values: [
    { keyword: '1', description: 'SNMPv1' },
    { keyword: '2c', description: 'SNMPv2c' },
  ],
};

const LEVEL_OR_USER: ArgumentSpec = {
  name: 'level', type: 'WORD', description: 'SNMPv3 user name',
  alternatives: [
    { keyword: 'auth', description: 'Authenticate without encryption' },
    { keyword: 'noauth', description: 'No authentication, no encryption' },
    { keyword: 'priv', description: 'Authenticate and encrypt' },
    { keyword: 'WORD', description: 'SNMPv3 user name' },
  ],
};

const OPTIONAL_COMMUNITY: ArgumentSpec = { ...COMMUNITY, optional: true };

const DESCRIPTION = 'Specify hosts to receive SNMP notifications';

type Shape = {
  readonly id: string;
  readonly keywords: readonly string[];
  readonly places: readonly ArgumentSpec[];
  readonly words: (args: Record<string, string>) => string[];
};

function shapes(type: 'traps' | 'informs' | null): Shape[] {
  const lead = type === null ? [] : [type];
  const tag = type ?? 'plain';
  return [
    {
      id: `snmp-server-host-${tag}`,
      keywords: lead, places: [COMMUNITY],
      words: (args) => [...lead, args.community],
    },
    {
      id: `snmp-server-host-${tag}-version`,
      keywords: [...lead, 'version'], places: [VERSION_1_2C, COMMUNITY],
      words: (args) => [...lead, 'version', args.version, args.community],
    },
    {
      id: `snmp-server-host-${tag}-version-3`,
      keywords: [...lead, 'version', '3'], places: [LEVEL_OR_USER, OPTIONAL_COMMUNITY],
      words: (args) => [
        ...lead, 'version', '3', args.level, ...(args.community === undefined ? [] : [args.community]),
      ],
    },
  ];
}

export function snmpHostFamily(host: () => SequenceHost): CommandSpec[] {
  const base = { modes: ['config'], minPrivilege: 15, description: DESCRIPTION };
  const specs: CommandSpec[] = [];
  for (const type of [null, 'traps', 'informs'] as const) {
    for (const shape of shapes(type)) {
      specs.push({
        ...base, id: shape.id,
        path: ['snmp-server', 'host', ADDRESS, ...shape.keywords, ...shape.places, TAIL],
        run: (_session, args) => host().apply(
          ['host', args.address, ...shape.words(args), ...tailWords(args)], false),
      });
    }
  }
  specs.push({
    ...base, id: 'snmp-server-host-udp-port-first',
    path: ['snmp-server', 'host', ADDRESS, 'udp-port', UDP_PORT, COMMUNITY, TAIL],
    run: (_session, args) => host().apply(
      ['host', args.address, 'udp-port', args.port, args.community, ...tailWords(args)], false),
  });
  specs.push({
    ...base, id: 'snmp-server-host-undo',
    path: ['snmp-server', 'host', ADDRESS, TAIL],
    existsOnlyNegated: true,
    run: () => '% Incomplete command.',
    undo: (_session, args) => host().apply(['host', args.address, ...tailWords(args)], true),
  });
  return specs;
}

function tailWords(args: Record<string, string>): string[] {
  return (args.options ?? '').trim().split(/\s+/).filter(Boolean);
}

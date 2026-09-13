import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { OptionSpec } from '@/cli/OptionBag';
import { numeroDeSequence, SEQUENCE, type AclEntryHost } from './aclSubmodeSpecs';
import { ACL_PORT_OPERATORS, PORT_KEYWORDS } from '../../router/acl/AclSyntax';
import {
  ICMPV6_MESSAGE_KEYWORDS, IPV6_PROTOCOL_KEYWORDS, IPV6_TCP_FLAG_NAMES,
  ipv6ProtocolCarriesPorts,
} from '../../router/acl/Ipv6AclSyntax';

const MODE = ['config-ipv6-nacl'] as const;

const DESCRIPTION_PROTOCOLE: Readonly<Record<string, string>> = {
  ipv6: 'Any IPv6 protocol',
  hbh: 'Hop by Hop options header',
  tcp: 'Transmission Control Protocol',
  udp: 'User Datagram Protocol',
  esp: 'Encapsulation Security Payload',
  ahp: 'Authentication Header Protocol',
  icmp: 'Internet Control Message Protocol',
  pcp: 'Payload Compression Protocol',
  sctp: 'Stream Control Transmission Protocol',
};

const PROTOCOLES = Object.keys(IPV6_PROTOCOL_KEYWORDS);
const AVEC_PORTS = PROTOCOLES.filter(ipv6ProtocolCarriesPorts);
const SANS_PORTS = PROTOCOLES.filter(
  mot => !ipv6ProtocolCarriesPorts(mot) && mot !== 'icmp');

interface FormeAdresse {
  readonly nom: string;
  pas(prefixe: string): Array<string | ArgumentSpec>;
  mots(prefixe: string, args: Record<string, string>): string[];
}

const cote = (prefixe: string) => (prefixe === 'src' ? 'Source' : 'Destination');

const FORMES: readonly FormeAdresse[] = [
  {
    nom: 'any',
    pas: () => ['any'],
    mots: () => ['any'],
  },
  {
    nom: 'host',
    pas: (p) => ['host', {
      name: `${p}-hote`, type: 'IPV6_ADDR',
      description: `A single ${cote(p).toLowerCase()} host`,
    }],
    mots: (p, args) => ['host', args[`${p}-hote`]],
  },
  {
    nom: 'prefixe',
    pas: (p) => [{
      name: `${p}-prefixe`, type: 'IPV6_PREFIX',
      description: `${cote(p)} IPv6 network prefix`,
    }],
    mots: (p, args) => [args[`${p}-prefixe`]],
  },
];

const PORT: ArgumentSpec = {
  name: 'port', type: 'INT', range: [0, 65535],
  description: 'Port number',
  values: Object.keys(PORT_KEYWORDS).sort().map(nom => ({
    keyword: nom, description: `${nom} (${PORT_KEYWORDS[nom]})`,
  })),
};

const DESCRIPTION_OPERATEUR: Readonly<Record<string, string>> = {
  eq: 'Match only packets on a given port number',
  neq: 'Match only packets not on a given port number',
  gt: 'Match only packets with a greater port number',
  lt: 'Match only packets with a lower port number',
  range: 'Match only packets in the range of port numbers',
};

const OPERATEURS_SIMPLES = ACL_PORT_OPERATORS.filter(op => op !== 'range');

interface PortSource {
  readonly nom: string;
  pas(): Array<string | ArgumentSpec>;
  mots(args: Record<string, string>): string[];
}

const PORTS_SOURCE: readonly PortSource[] = [
  { nom: 'sans', pas: () => [], mots: () => [] },
  ...OPERATEURS_SIMPLES.map(op => ({
    nom: op,
    pas: () => [op, { ...PORT, name: 'src-port' }],
    mots: (args: Record<string, string>) => [op, args['src-port']],
  })),
  {
    nom: 'range',
    pas: () => ['range',
      { ...PORT, name: 'src-bas' },
      { ...PORT, name: 'src-haut' }],
    mots: (args) => ['range', args['src-bas'], args['src-haut']],
  },
];

const PORTS_DESTINATION: readonly OptionSpec[] = [
  ...OPERATEURS_SIMPLES.map(op => ({
    keyword: op, description: DESCRIPTION_OPERATEUR[op],
    argument: { ...PORT, name: `dst-${op}` },
  })),
  {
    keyword: 'range', description: DESCRIPTION_OPERATEUR.range,
    argument: { ...PORT, name: 'dst-bas' },
    moreArguments: [{ ...PORT, name: 'dst-haut' }],
  },
];

const SUFFIXES_COMMUNS: readonly OptionSpec[] = [
  { keyword: 'log', description: 'Log matches against this entry' },
  {
    keyword: 'log-input',
    description: 'Log matches against this entry, including input interface',
  },
  { keyword: 'fragments', description: 'Check non-initial fragments' },
  { keyword: 'routing', description: 'Check routing header' },
  {
    keyword: 'dscp', description: 'Match packets with given dscp value',
    argument: {
      name: 'dscp', type: 'INT', range: [0, 63],
      description: 'Differentiated services codepoint value',
    },
  },
  {
    keyword: 'flow-label', description: 'Match packets with given flow label',
    argument: {
      name: 'flow-label', type: 'INT', range: [0, 0xfffff],
      description: 'Flow label value',
    },
  },
  {
    keyword: 'time-range', description: 'Specify a time-range',
    argument: { name: 'plage', type: 'WORD', description: 'Name of the time range' },
  },
  {
    keyword: 'sequence', description: 'Sequence number for this entry',
    argument: {
      name: 'sequence-queue', type: 'INT', range: [1, 4294967295],
      description: 'Sequence number',
    },
  },
];

const REFLET: OptionSpec = {
  keyword: 'reflect', description: 'Create reflexive access list entry',
  argument: { name: 'miroir', type: 'WORD', description: 'Reflexive access list name' },
};

const TRANSPORT_INDETERMINE: OptionSpec = {
  keyword: 'undetermined-transport',
  description: 'Match packets with undetermined transport',
};

const ETABLIE: OptionSpec = {
  keyword: 'established', description: 'Match established connections',
};

const DRAPEAUX_TCP: readonly OptionSpec[] = IPV6_TCP_FLAG_NAMES.map(nom => ({
  keyword: nom, description: `Match on the ${nom} bit`,
}));

const QUEUE_ICMP: readonly ArgumentSpec[] = [
  {
    name: 'icmp-type', type: 'INT', range: [0, 255], optional: true,
    description: 'ICMPv6 message type',
    values: Object.keys(ICMPV6_MESSAGE_KEYWORDS).sort().map(mot => ({
      keyword: mot, description: `Match on the ${mot} message`,
    })),
  },
  {
    name: 'icmp-code', type: 'INT', range: [0, 255], optional: true,
    description: 'ICMPv6 message code',
  },
];

function suffixes(sac: readonly OptionSpec[], args: Record<string, string>): string[] {
  const mots: string[] = [];
  for (const option of sac) {
    const cle = option.argument?.name ?? option.keyword;
    if (args[cle] === undefined) continue;
    mots.push(option.keyword);
    if (option.argument) mots.push(args[cle]);
    for (const place of option.moreArguments ?? []) {
      const valeur = args[place.name];
      if (valeur !== undefined) mots.push(valeur);
    }
  }
  return mots;
}

function queue(places: readonly ArgumentSpec[], args: Record<string, string>): string[] {
  const mots: string[] = [];
  for (const place of places) {
    const valeur = args[place.name];
    if (valeur === undefined) break;
    mots.push(valeur);
  }
  return mots;
}

interface Famille {
  readonly nom: string;
  readonly tetes: ReadonlyArray<string | ArgumentSpec>;
  readonly portsSource: readonly PortSource[];
  sac(tete: string | ArgumentSpec): readonly OptionSpec[];
  readonly queue: readonly ArgumentSpec[];
  mots(tete: string | ArgumentSpec, args: Record<string, string>): string[];
}

const FAMILLES: readonly Famille[] = [
  {
    nom: 'ports',
    tetes: [...AVEC_PORTS],
    portsSource: PORTS_SOURCE,
    sac: (tete) => (tete === 'tcp'
      ? [...PORTS_DESTINATION, ETABLIE, ...DRAPEAUX_TCP, ...SUFFIXES_COMMUNS]
      : [...PORTS_DESTINATION, ...SUFFIXES_COMMUNS]),
    queue: [],
    mots: (tete) => [tete as string],
  },
  {
    nom: 'icmp',
    tetes: ['icmp'],
    portsSource: [PORTS_SOURCE[0]],
    sac: () => SUFFIXES_COMMUNS,
    queue: QUEUE_ICMP,
    mots: () => ['icmp'],
  },
  {
    nom: 'simples',
    tetes: [{
      name: 'protocole', type: 'INT', description: 'An IPv6 protocol number',
      range: [0, 255],
      values: SANS_PORTS.map(mot => ({
        keyword: mot, description: DESCRIPTION_PROTOCOLE[mot] ?? mot,
      })),
    }],
    portsSource: [PORTS_SOURCE[0]],
    sac: () => SUFFIXES_COMMUNS,
    queue: [],
    mots: (_tete, args) => [args.protocole],
  },
];

export function aclIpv6Specs(ctx: () => AclEntryHost): CommandSpec[] {
  const specs: CommandSpec[] = [];

  for (const action of ['permit', 'deny'] as const) {
    const propreAuSens = action === 'permit' ? [REFLET] : [TRANSPORT_INDETERMINE];
    for (const famille of FAMILLES) {
      for (const tete of famille.tetes) {
        const sac = [...famille.sac(tete), ...propreAuSens];
        for (const src of FORMES) {
          for (const sport of famille.portsSource) {
            for (const dst of FORMES) {
              const mots = (args: Record<string, string>): string[] => [
                ...famille.mots(tete, args),
                ...src.mots('src', args), ...sport.mots(args),
                ...dst.mots('dst', args),
                ...queue(famille.queue, args),
                ...suffixes(sac, args),
              ];
              const nomTete = typeof tete === 'string' ? tete : famille.nom;
              const base = {
                description: action === 'permit'
                  ? 'Specify packets to forward' : 'Specify packets to reject',
                modes: MODE, minPrivilege: 15,
                options: sac,
              };
              const pas = [
                ...src.pas('src'), ...sport.pas(), ...dst.pas('dst'),
                ...famille.queue,
              ];
              specs.push({
                ...base,
                id: `acl-ipv6-${action}-${nomTete}-${src.nom}-${sport.nom}-${dst.nom}`,
                path: [action, tete, ...pas],
                run: (_s, args) => ctx().addEntry(
                  action, mots(args), numeroDeSequence(args)),
                undo: (_s, args) => ctx().removeEntry(action, mots(args)),
              });
              specs.push({
                ...base,
                id: `acl-ipv6-seq-${action}-${nomTete}-${src.nom}-${sport.nom}-${dst.nom}`,
                path: ['sequence', SEQUENCE, action, tete, ...pas],
                description: 'Sequence number for this entry',
                run: (_s, args) => ctx().addEntry(
                  action, mots(args), numeroDeSequence(args)),
                undo: (_s, args) => ctx().removeEntry(action, mots(args)),
              });
            }
          }
        }
      }
    }
  }
  return specs;
}

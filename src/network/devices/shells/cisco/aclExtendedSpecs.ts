import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { OptionSpec } from '@/cli/OptionBag';
import { numeroDeSequence, type AclEntryHost } from './aclSubmodeSpecs';
import {
  ACL_PORT_OPERATORS, ICMP_TYPE_KEYWORDS, IP_PROTOCOL_KEYWORDS,
  PORT_KEYWORDS, protocolCarriesPorts,
} from '../../router/acl/AclSyntax';
import {
  DSCP_KEYWORD_TO_VALUE, PRECEDENCE_KEYWORD_TO_VALUE, TOS_KEYWORD_TO_VALUE,
  TCP_FLAG_NAMES,
} from '../../router/ACLEngine';

const MODE = ['config-ext-nacl'] as const;


const DESCRIPTION_PROTOCOLE: Readonly<Record<string, string>> = {
  ip: 'Any Internet Protocol', icmp: 'Internet Control Message Protocol',
  igmp: 'Internet Gateway Message Protocol', ipinip: 'IP in IP tunneling',
  tcp: 'Transmission Control Protocol', udp: 'User Datagram Protocol',
  gre: 'Cisco GRE tunneling', esp: 'Encapsulation Security Payload',
  ahp: 'Authentication Header Protocol', eigrp: 'Cisco EIGRP routing protocol',
  nos: 'KA9Q NOS compatible IP over IP tunneling',
  ospf: 'OSPF routing protocol', pim: 'Protocol Independent Multicast',
  pcp: 'Payload Compression Protocol', sctp: 'Stream Control Transmission Protocol',
};

const PROTOCOLES = Object.keys(IP_PROTOCOL_KEYWORDS);
const AVEC_PORTS = PROTOCOLES.filter(protocolCarriesPorts);
const SANS_PORTS = PROTOCOLES.filter(
  mot => !protocolCarriesPorts(mot) && mot !== 'icmp');

const valeursDeProtocole = (mots: readonly string[]) => mots.map(mot => ({
  keyword: mot, description: DESCRIPTION_PROTOCOLE[mot] ?? mot,
}));

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
      name: `${p}-hote`, type: 'IP_ADDR',
      description: `A single ${cote(p).toLowerCase()} host`,
    }],
    mots: (p, args) => ['host', args[`${p}-hote`]],
  },
  {
    nom: 'groupe',
    pas: (p) => ['object-group', {
      name: `${p}-groupe`, type: 'WORD',
      description: `${cote(p)} object group`,
    }],
    mots: (p, args) => ['object-group', args[`${p}-groupe`]],
  },
  {
    nom: 'reseau',
    pas: (p) => [
      { name: `${p}-reseau`, type: 'IP_ADDR', description: `${cote(p)} address` },
      { name: `${p}-masque`, type: 'IP_ADDR', description: 'Wildcard bits' },
    ],
    mots: (p, args) => [args[`${p}-reseau`], args[`${p}-masque`]],
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

const OCTET = (nom: string, description: string): ArgumentSpec =>
  ({ name: nom, type: 'INT', range: [0, 255], description });

const TTL: OptionSpec = {
  keyword: 'ttl', description: 'Match packets with given TTL value',
  choices: [
    ...OPERATEURS_SIMPLES.map(op => ({
      keyword: op, description: DESCRIPTION_OPERATEUR[op].replace('port number', 'TTL value'),
      argument: OCTET(`ttl-${op}`, 'TTL value'),
    })),
    {
      keyword: 'range', description: 'Match only packets in the range of TTL values',
      argument: OCTET('ttl-bas', 'TTL value'),
      moreArguments: [OCTET('ttl-haut', 'TTL value')],
    },
  ],
};

const REFLECT: OptionSpec = {
  keyword: 'reflect', description: 'Create reflexive access list entry',
  argument: { name: 'miroir', type: 'WORD', description: 'Reflexive access list name' },
  moreArguments: [
    {
      name: 'miroir-mot', type: 'ENUM', optional: true,
      description: 'Maximum time to live for the reflexive entry',
      values: [{ keyword: 'timeout', description: 'Maximum time to live' }],
    },
    {
      name: 'miroir-delai', type: 'INT', range: [1, 2147483],
      description: 'Maximum time to live in seconds',
    },
  ],
};

const enumeration = (
  nom: string, description: string, table: Readonly<Record<string, number>>,
  bornes: readonly [number, number],
): ArgumentSpec => ({
  name: nom, type: 'INT', range: bornes, description,
  values: Object.keys(table).sort().map(mot => ({
    keyword: mot, description: `Match packets with ${mot} (${table[mot]})`,
  })),
});

const SUFFIXES_COMMUNS: readonly OptionSpec[] = [
  { keyword: 'log', description: 'Log matches against this entry' },
  {
    keyword: 'log-input',
    description: 'Log matches against this entry, including input interface',
  },
  { keyword: 'fragments', description: 'Check non-initial fragments' },
  {
    keyword: 'time-range', description: 'Specify a time-range',
    argument: { name: 'plage', type: 'WORD', description: 'Name of the time range' },
  },
  {
    keyword: 'dscp', description: 'Match packets with given dscp value',
    argument: enumeration('dscp', 'Differentiated services codepoint value',
      DSCP_KEYWORD_TO_VALUE, [0, 63]),
  },
  {
    keyword: 'precedence', description: 'Match packets with given precedence value',
    argument: enumeration('precedence', 'Precedence value',
      PRECEDENCE_KEYWORD_TO_VALUE, [0, 7]),
  },
  {
    keyword: 'tos', description: 'Match packets with given TOS value',
    argument: enumeration('tos', 'Type of service value',
      TOS_KEYWORD_TO_VALUE, [0, 15]),
  },
  {
    keyword: 'option', description: 'Match packets with given IP Options value',
    argument: { name: 'option', type: 'WORD', description: 'IP Options value' },
  },
  TTL,
  REFLECT,
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

const DRAPEAUX = TCP_FLAG_NAMES.flatMap(nom => [nom, `+${nom}`, `-${nom}`])
  .map(mot => ({ keyword: mot, description: `Match on the ${mot} bit` }));

const drapeau = (mode: string, rang: number, obligatoire: boolean): ArgumentSpec => ({
  name: `${mode}-${rang}`, type: 'WORD', description: 'TCP flag',
  values: DRAPEAUX,
  ...(obligatoire ? {} : { optional: true }),
});

const CORRESPONDANCES_TCP: readonly OptionSpec[] = (
  [['match-any', 'Match if any flag is set'],
    ['match-all', 'Match if all flags are set']] as const
).map(([keyword, description]) => ({
  keyword, description,
  argument: drapeau(keyword, 0, true),
  moreArguments: TCP_FLAG_NAMES.slice(1).map(
    (_, rang) => drapeau(keyword, rang + 1, false)),
}));

const ETABLIE: OptionSpec = {
  keyword: 'established', description: 'Match established connections',
};

function suffixes(sac: readonly OptionSpec[], args: Record<string, string>): string[] {
  const mots: string[] = [];
  for (const option of sac) {
    if (option.choices) {
      const choisi = args[option.keyword];
      if (choisi === undefined) continue;
      const choix = option.choices.find(c => c.keyword === choisi);
      mots.push(option.keyword, choisi);
      if (choix?.argument) mots.push(args[choix.argument.name]);
      for (const place of choix?.moreArguments ?? []) mots.push(args[place.name]);
      continue;
    }
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

interface Famille {
  readonly nom: string;
  readonly tetes: ReadonlyArray<string | ArgumentSpec>;
  readonly portsSource: readonly PortSource[];
  sac(tete: string | ArgumentSpec): readonly OptionSpec[];
  readonly queue: readonly ArgumentSpec[];
  mots(tete: string | ArgumentSpec, args: Record<string, string>): string[];
}

const QUEUE_ICMP: readonly ArgumentSpec[] = [
  {
    name: 'icmp-type', type: 'INT', range: [0, 255], optional: true,
    description: 'ICMP message type',
    values: [...ICMP_TYPE_KEYWORDS].sort().map(mot => ({
      keyword: mot, description: `Match on the ${mot} message`,
    })),
  },
  {
    name: 'icmp-code', type: 'INT', range: [0, 255], optional: true,
    description: 'ICMP message code',
  },
];

const FAMILLES: readonly Famille[] = [
  {
    nom: 'ports',
    tetes: [...AVEC_PORTS],
    portsSource: PORTS_SOURCE,
    sac: (tete) => (tete === 'tcp'
      ? [...PORTS_DESTINATION, ETABLIE, ...CORRESPONDANCES_TCP, ...SUFFIXES_COMMUNS]
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
      name: 'protocole', type: 'INT', description: 'An IP protocol number',
      range: [0, 255],
      values: valeursDeProtocole(SANS_PORTS),
    }],
    portsSource: [PORTS_SOURCE[0]],
    sac: () => SUFFIXES_COMMUNS,
    queue: [],
    mots: (_tete, args) => [args.protocole],
  },
];

function queue(places: readonly ArgumentSpec[], args: Record<string, string>): string[] {
  const mots: string[] = [];
  for (const place of places) {
    const valeur = args[place.name];
    if (valeur === undefined) break;
    mots.push(valeur);
  }
  return mots;
}

export function aclExtendedSpecs(ctx: () => AclEntryHost): CommandSpec[] {
  const specs: CommandSpec[] = [];

  for (const action of ['permit', 'deny'] as const) {
    for (const famille of FAMILLES) {
      for (const tete of famille.tetes) {
        const sac = famille.sac(tete);
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
              specs.push({
                id: `acl-ext-${action}-${nomTete}-${src.nom}-${sport.nom}-${dst.nom}`,
                path: [action, tete,
                  ...src.pas('src'), ...sport.pas(), ...dst.pas('dst'),
                  ...famille.queue],
                description: action === 'permit'
                  ? 'Specify packets to forward' : 'Specify packets to reject',
                modes: MODE, minPrivilege: 15,
                options: sac,
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

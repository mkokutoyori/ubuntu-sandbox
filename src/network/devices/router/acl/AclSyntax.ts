/**
 * Le vocabulaire commun d'une liste de controle, et ce qui le valide.
 *
 * Cisco et Huawei ecrivent une regle differemment, mais ils s'accordent
 * sur ce qu'EST un protocole et sur ce qu'EST un port. Ce module porte
 * cet accord une seule fois : deux tables qui divergeraient finiraient
 * par accepter sur un constructeur ce que l'autre refuse.
 *
 * Les numeros sont ceux de l'IANA et les mots-cles ceux qu'IOS nomme
 * dans une liste etendue. `ip` n'est pas un protocole mais le joker qui
 * les couvre tous, et il porte donc le numero -1 plutot qu'un vrai
 * numero de protocole.
 */

import { IPAddress } from '../../../core/types';
import { PortNumber } from '../../../core/ports/PortNumber';

export const IP_PROTOCOL_ANY = -1;

export const IP_PROTOCOL_KEYWORDS: Readonly<Record<string, number>> = {
  ip: IP_PROTOCOL_ANY,
  icmp: 1,
  igmp: 2,
  ipinip: 4,
  tcp: 6,
  udp: 17,
  gre: 47,
  esp: 50,
  ahp: 51,
  eigrp: 88,
  nos: 94,
  ospf: 89,
  pim: 103,
  pcp: 108,
  sctp: 132,
};

const NUMBER_TO_KEYWORD: ReadonlyMap<number, string> = new Map(
  Object.entries(IP_PROTOCOL_KEYWORDS)
    .filter(([, n]) => n !== IP_PROTOCOL_ANY)
    .map(([name, n]) => [n, name]),
);

export function protocolKeywordFor(protocolNumber: number): string {
  return NUMBER_TO_KEYWORD.get(protocolNumber) ?? 'ip';
}

export function parseIpProtocol(token: string): string | null {
  const lower = token.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(IP_PROTOCOL_KEYWORDS, lower)) return lower;
  if (!/^\d+$/.test(lower)) return null;
  const value = parseInt(lower, 10);
  if (value < 0 || value > 255) return null;
  return NUMBER_TO_KEYWORD.get(value) ?? lower;
}

export function protocolCarriesPorts(protocol: string | undefined): boolean {
  return protocol === 'tcp' || protocol === 'udp' || protocol === 'sctp';
}

export function ipProtocolMatches(entryProtocol: string, packetProtocol: number): boolean {
  if (entryProtocol === 'ip') return true;
  if (/^\d+$/.test(entryProtocol)) return packetProtocol === parseInt(entryProtocol, 10);
  return IP_PROTOCOL_KEYWORDS[entryProtocol] === packetProtocol;
}

export const PORT_KEYWORDS: Readonly<Record<string, number>> = {
  ftp: 21, 'ftp-data': 20, ftp_data: 20, ssh: 22, telnet: 23, smtp: 25,
  domain: 53, www: 80, http: 80, pop3: 110, ntp: 123, snmp: 161,
  snmptrap: 162, bgp: 179, https: 443, syslog: 514, tacacs: 49,
  rip: 520, isakmp: 500, 'non500-isakmp': 4500, sip: 5060,
  imap: 143, ldap: 389, 'ldap-s': 636, dhcp: 67, bootps: 67, bootpc: 68,
  tftp: 69, kerberos: 88, nntp: 119, finger: 79, gopher: 70,
};

/**
 * Un port est un NOMBRE ENTIER dans 0-65535 ou un nom connu, et rien
 * d'autre. `parseInt` s'arretait au premier caractere non numerique,
 * donc `eq 80abc` etait accepte et rangeait 80 : l'operateur croyait
 * avoir ecrit une regle, il en avait ecrit une AUTRE.
 */
export function parseAclPort(token: string | undefined): number | null {
  if (token === undefined) return null;
  const lower = token.toLowerCase();
  if (/^\d+$/.test(lower)) {
    const value = parseInt(lower, 10);
    return PortNumber.isValid(value) ? value : null;
  }
  return Object.prototype.hasOwnProperty.call(PORT_KEYWORDS, lower)
    ? PORT_KEYWORDS[lower]
    : null;
}

export type AclPortOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'range';

export function isAclPortOperator(token: string): token is AclPortOperator {
  return token === 'eq' || token === 'neq' || token === 'gt'
    || token === 'lt' || token === 'range';
}

export interface AclPortSpec {
  op: AclPortOperator;
  port: number;
  endPort?: number;
}

/**
 * `eq|neq|gt|lt <port>` et `range <bas> <haut>`. Une plage a l'ENVERS
 * est refusee : elle ne peut correspondre a rien, donc l'accepter
 * rangerait une regle inerte que rien ne signale.
 */
export function parseAclPortSpec(
  args: string[], offset: number,
): { spec: AclPortSpec; consumed: number } | null {
  const op = args[offset]?.toLowerCase();
  if (op === undefined || !isAclPortOperator(op)) return null;

  if (op === 'range') {
    const low = parseAclPort(args[offset + 1]);
    const high = parseAclPort(args[offset + 2]);
    if (low === null || high === null || low > high) return null;
    return { spec: { op, port: low, endPort: high }, consumed: 3 };
  }

  const port = parseAclPort(args[offset + 1]);
  if (port === null) return null;
  return { spec: { op, port }, consumed: 2 };
}

export function isDottedQuad(token: string | undefined): boolean {
  return token !== undefined && IPAddress.isValid(token);
}

/**
 * L'analyse d'une `rule` VRP, pour les deux vues (basic et advanced).
 *
 * Il y en avait DEUX, presque identiques, et toutes deux terminaient leur
 * boucle par un `i++` nu : **tout mot-clé non reconnu était ignoré sans un
 * mot**. Pire, sept mots-clés que VRP accepte — `icmp-type`, `tcp-flag`,
 * `dscp`, `precedence`, `tos`, `fragment`, `time-range`, `logging` —
 * figuraient dans la liste des « ce n'est pas un protocole » et n'étaient
 * lus par personne : `rule deny icmp source any icmp-type echo` refusait
 * TOUT l'ICMP, réponses comprises.
 *
 * La règle de ce dépôt : un critère qu'on ne sait pas trancher fait
 * échouer la correspondance, et un mot-clé qu'on n'évalue pas est refusé
 * à l'analyse plutôt que stocké.
 */

import { parseAclPortSpec, parseIpProtocol, protocolCarriesPorts } from '../../router/acl/AclSyntax';
import { IPAddress, SubnetMask } from '../../../core/types';
import type { ACLEntryOptions, PortSpec, PortOperator } from '../../router/ACLEngine';
import type { ErreurGrammaireVrp } from '../cli-utils';

export type RuleParse =
  | { statut: 'ok'; ruleId?: number; action: 'permit' | 'deny'; opts: ACLEntryOptions }
  | { statut: 'refus'; err: ErreurGrammaireVrp };

const normalizeWildcard = (w: string): string => (w === '0' ? '0.0.0.0' : w);

/**
 * Les noms ICMP de VRP vers ceux que le moteur évalue. Un nom absent est
 * transmis tel quel : le moteur le refusera faute de savoir le traduire,
 * ce qui vaut mieux que de l'accepter comme un joker.
 */
const VRP_ICMP_NAMES: Readonly<Record<string, string>> = {
  'echo': 'echo',
  'echo-reply': 'echo-reply',
  'host-unreachable': 'host-unreachable',
  'net-unreachable': 'net-unreachable',
  'port-unreachable': 'port-unreachable',
  'protocol-unreachable': 'protocol-unreachable',
  'fragmentneeded-dfset': 'packet-too-big',
  'ttl-exceeded': 'ttl-exceeded',
  'host-redirect': 'redirect',
  'net-redirect': 'redirect',
};

const VRP_TCP_FLAGS = new Set(['ack', 'fin', 'psh', 'rst', 'syn', 'urg']);

/** `eq N`, `neq N`, `gt N`, `lt N`, `range N M` — meme grammaire qu'IOS. */
export function parseHuaweiPortSpec(
  args: string[], offset: number,
): { spec: PortSpec; consumed: number } | null {
  const parsed = parseAclPortSpec(args, offset);
  if (!parsed) return null;
  return {
    spec: { op: parsed.spec.op as PortOperator, port: parsed.spec.port, endPort: parsed.spec.endPort },
    consumed: parsed.consumed,
  };
}

/** Un mot-clé de queue commun aux deux vues. */
const COMMUN = new Set(['time-range', 'logging', 'fragment', 'vpn-instance']);

/** Les mots-clés propres à la vue avancée. */
const AVANCE = new Set(['destination', 'source-port', 'destination-port',
  'icmp-type', 'tcp-flag', 'dscp', 'precedence', 'tos']);

function refus(token: string): RuleParse {
  return { statut: 'refus', err: { kind: 'unrecognized', token } };
}

/**
 * Une adresse malformee doit etre REFUSEE, pas construite : `new
 * IPAddress('999.999.999.999')` LEVE, et l'exception traversait le
 * gestionnaire de commande au lieu de rendre un message.
 */
function adresseValide(ip: string, wildcard: string): boolean {
  return IPAddress.isValid(ip) && IPAddress.isValid(wildcard);
}

export function analyserRegleVrp(args: string[], kind: 'basic' | 'advanced'): RuleParse {
  if (args.length < 1) return { statut: 'refus', err: { kind: 'incomplete' } };

  let i = 0;
  let ruleId: number | undefined;
  if (/^\d+$/.test(args[0])) { ruleId = parseInt(args[0], 10); i++; }

  const action = args[i]?.toLowerCase();
  if (action !== 'permit' && action !== 'deny') {
    return args[i] === undefined
      ? { statut: 'refus', err: { kind: 'incomplete' } }
      : refus(args[i]);
  }
  i++;

  let srcIP = '0.0.0.0';
  let srcWild = '255.255.255.255';
  let dstIP = '0.0.0.0';
  let dstWild = '255.255.255.255';
  let protocol: string | undefined;
  const opts: Partial<ACLEntryOptions> = {};

  const estMotCle = (t: string) => COMMUN.has(t) || AVANCE.has(t) || t === 'source';

  // Sur une vue avancée, le premier mot après l'action est le protocole.
  if (kind === 'advanced' && i < args.length && !estMotCle(args[i].toLowerCase())) {
    const nomme = parseIpProtocol(args[i]);
    if (nomme === null) return refus(args[i]);
    protocol = nomme;
    i++;
  }

  while (i < args.length) {
    const kw = args[i].toLowerCase();

    if (kw === 'source') {
      if (args[i + 1]?.toLowerCase() === 'any') { i += 2; continue; }
      if (!args[i + 1] || !args[i + 2]) return { statut: 'refus', err: { kind: 'incomplete' } };
      const wc = normalizeWildcard(args[i + 2]);
      if (!adresseValide(args[i + 1], wc)) return refus(args[i + 1]);
      srcIP = args[i + 1]; srcWild = wc; i += 3; continue;
    }

    if (kind === 'advanced' && kw === 'destination') {
      if (args[i + 1]?.toLowerCase() === 'any') { i += 2; continue; }
      if (!args[i + 1] || !args[i + 2]) return { statut: 'refus', err: { kind: 'incomplete' } };
      const wc = normalizeWildcard(args[i + 2]);
      if (!adresseValide(args[i + 1], wc)) return refus(args[i + 1]);
      dstIP = args[i + 1]; dstWild = wc; i += 3; continue;
    }

    if (kind === 'advanced' && (kw === 'source-port' || kw === 'destination-port')) {
      if (!protocolCarriesPorts(protocol)) return refus(kw);
      const p = parseHuaweiPortSpec(args, i + 1);
      if (!p) return refus(args[i + 1] ?? kw);
      if (kw === 'source-port') {
        opts.srcPortSpec = p.spec;
        if (p.spec.op === 'eq') opts.srcPort = p.spec.port;
      } else {
        opts.dstPortSpec = p.spec;
        if (p.spec.op === 'eq') opts.dstPort = p.spec.port;
      }
      i += 1 + p.consumed; continue;
    }

    if (kind === 'advanced' && kw === 'icmp-type') {
      const nom = args[i + 1]?.toLowerCase();
      if (!nom) return { statut: 'refus', err: { kind: 'incomplete' } };
      if (/^\d+$/.test(nom)) {
        // `icmp-type <type> <code>` — la forme numérique de VRP.
        const code = args[i + 2];
        if (code !== undefined && /^\d+$/.test(code)) {
          opts.icmpCode = parseInt(code, 10); i += 3;
        } else { i += 2; }
        opts.icmpType = nom;
        continue;
      }
      opts.icmpType = VRP_ICMP_NAMES[nom] ?? nom;
      i += 2; continue;
    }

    if (kind === 'advanced' && kw === 'tcp-flag') {
      const flags: string[] = [];
      let j = i + 1;
      while (j < args.length) {
        const f = args[j].toLowerCase();
        if (f === 'established') { opts.tcpEstablished = true; j++; continue; }
        if (!VRP_TCP_FLAGS.has(f)) break;
        flags.push(f); j++;
      }
      if (flags.length === 0 && !opts.tcpEstablished) return refus(args[i + 1] ?? kw);
      if (flags.length > 0) {
        // VRP exige TOUS les drapeaux nommés.
        opts.tcpFlags = flags;
        opts.tcpFlagsMatch = 'all';
      }
      i = j; continue;
    }

    if (kind === 'advanced' && (kw === 'dscp' || kw === 'precedence' || kw === 'tos')) {
      const v = args[i + 1];
      if (!v) return { statut: 'refus', err: { kind: 'incomplete' } };
      if (kw === 'dscp') opts.dscp = v;
      else if (kw === 'precedence') opts.precedence = v;
      else opts.tos = v;
      i += 2; continue;
    }

    if (kw === 'fragment') { opts.fragments = true; i++; continue; }
    if (kw === 'logging') { opts.log = true; i++; continue; }

    if (kw === 'time-range') {
      const nom = args[i + 1];
      if (!nom) return { statut: 'refus', err: { kind: 'incomplete' } };
      opts.timeRange = nom; i += 2; continue;
    }

    // `vpn-instance` : rien ici ne porte de plan de transfert par VPN.
    // Le stocker en le laissant sans effet ferait croire à un filtrage
    // par instance qui n'a pas lieu.
    if (kw === 'vpn-instance') return refus(args[i]);

    return refus(args[i]);
  }

  const complet: ACLEntryOptions = {
    ...opts,
    protocol,
    srcIP: new IPAddress(srcIP),
    srcWildcard: new SubnetMask(srcWild),
  };
  if (kind === 'advanced') {
    complet.dstIP = new IPAddress(dstIP);
    complet.dstWildcard = new SubnetMask(dstWild);
  }
  if (ruleId !== undefined) {
    complet.sequence = ruleId;
    complet.sequenceConfigured = true;
  }
  return { statut: 'ok', ruleId, action, opts: complet };
}

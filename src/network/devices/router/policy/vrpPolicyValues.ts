import { boundedInteger } from '@/cli/ArgumentTypes';
import { isValidIPv4 } from '@/network/core/ip';
import { parseVlanId } from '@/network/devices/switch/VlanSet';
import { DSCP_KEYWORD_TO_VALUE } from '@/network/devices/router/ACLEngine';
import { BGP_ATTRIBUTE_MAX } from '@/network/bgp/attributes';

export const DSCP_MAX = 63;
export const IP_PRECEDENCE_MAX = 7;

export type VrpValueVerdict = null | 'incomplete' | { readonly at: number };

const OK: VrpValueVerdict = null;

export type VrpValueJudge = (tail: readonly string[]) => VrpValueVerdict;

export interface VrpClauseSpec {
  readonly words: readonly string[];
  readonly judge: VrpValueJudge;
}

export function vrpEntier(min: number, max: number): VrpValueJudge {
  return (tail) => {
    if (tail.length === 0) return 'incomplete';
    return boundedInteger(tail[0], min, max) === null ? { at: 0 } : OK;
  };
}

/**
 * Une borne haute que la plateforme fixe et qu'aucune source atteignable
 * n'atteste : seule la certitude « c'est un nombre » est appliquee.
 */
export function vrpNombre(): VrpValueJudge {
  return (tail) => {
    if (tail.length === 0) return 'incomplete';
    return /^\d+$/.test(tail[0]) ? OK : { at: 0 };
  };
}

export function vrpMotLibre(minimum = 1): VrpValueJudge {
  return (tail) => (tail.length < minimum ? 'incomplete' : OK);
}

export function vrpAdresse(): VrpValueJudge {
  return (tail) => {
    if (tail.length === 0) return 'incomplete';
    return isValidIPv4(tail[0]) ? OK : { at: 0 };
  };
}

export function vrpVlan(): VrpValueJudge {
  return (tail) => {
    if (tail.length === 0) return 'incomplete';
    return parseVlanId(tail[0]) === null ? { at: 0 } : OK;
  };
}

/** DSCP se dit par sa valeur (RFC 2474 §3) ou par son nom (RFC 2597/2598). */
export function vrpDscp(): VrpValueJudge {
  return (tail) => {
    if (tail.length === 0) return 'incomplete';
    const mot = tail[0].toLowerCase();
    if (mot in DSCP_KEYWORD_TO_VALUE) return OK;
    return boundedInteger(mot, 0, DSCP_MAX) === null ? { at: 0 } : OK;
  };
}

export function readDscpValue(token: string): number | null {
  const mot = token.toLowerCase();
  if (mot in DSCP_KEYWORD_TO_VALUE) return DSCP_KEYWORD_TO_VALUE[mot];
  return boundedInteger(mot, 0, DSCP_MAX);
}

export interface VrpClauseProblem {
  readonly at: number;
  readonly incomplete?: boolean;
}

export function judgeVrpClause(
  clauses: readonly VrpClauseSpec[], args: readonly string[],
): VrpClauseProblem | null {
  if (args.length === 0) return { at: 0, incomplete: true };

  const candidates = clauses.filter((c) => c.words[0] === args[0].toLowerCase());
  if (candidates.length === 0) return { at: 0 };

  const spec = candidates
    .slice()
    .sort((a, b) => b.words.length - a.words.length)
    .find((c) => c.words.every((w, i) => w === (args[i] ?? '').toLowerCase()));
  if (!spec) {
    const profondeur = Math.max(...candidates.map((c) => c.words.length));
    for (let i = 1; i < profondeur; i++) {
      if (args[i] === undefined) return { at: i, incomplete: true };
    }
    return { at: 1 };
  }

  const verdict = spec.judge(args.slice(spec.words.length));
  if (verdict === 'incomplete') return { at: args.length, incomplete: true };
  if (verdict !== null) return { at: spec.words.length + verdict.at };
  return null;
}

export const ROUTE_POLICY_IF_MATCH: readonly VrpClauseSpec[] = Object.freeze([
  { words: ['acl'], judge: vrpNombre() },
  { words: ['as-path'], judge: vrpMotLibre() },
  { words: ['as-path-filter'], judge: vrpNombre() },
  { words: ['community'], judge: vrpMotLibre() },
  { words: ['community-filter'], judge: vrpMotLibre() },
  { words: ['cost'], judge: vrpEntier(0, BGP_ATTRIBUTE_MAX) },
  { words: ['interface'], judge: vrpMotLibre() },
  { words: ['ip-prefix'], judge: vrpMotLibre() },
  { words: ['route-type'], judge: vrpMotLibre() },
  { words: ['tag'], judge: vrpEntier(0, BGP_ATTRIBUTE_MAX) },
]);

export const ROUTE_POLICY_APPLY: readonly VrpClauseSpec[] = Object.freeze([
  { words: ['community'], judge: vrpMotLibre() },
  { words: ['cost'], judge: vrpEntier(0, BGP_ATTRIBUTE_MAX) },
  { words: ['ip-address', 'next-hop'], judge: vrpAdresse() },
  { words: ['local-preference'], judge: vrpEntier(0, BGP_ATTRIBUTE_MAX) },
  { words: ['preference'], judge: vrpNombre() },
  { words: ['tag'], judge: vrpEntier(0, BGP_ATTRIBUTE_MAX) },
]);

export const CLASSIFIER_IF_MATCH: readonly VrpClauseSpec[] = Object.freeze([
  { words: ['acl'], judge: vrpNombre() },
  { words: ['acl-ipv6'], judge: vrpNombre() },
  { words: ['any'], judge: (tail) => (tail.length ? { at: 0 } : OK) },
  { words: ['dscp'], judge: vrpDscp() },
  { words: ['ip-precedence'], judge: vrpEntier(0, IP_PRECEDENCE_MAX) },
  { words: ['protocol'], judge: vrpMotLibre() },
  { words: ['vlan'], judge: vrpVlan() },
]);

export const BEHAVIOR_REMARK: readonly VrpClauseSpec[] = Object.freeze([
  { words: ['dscp'], judge: vrpDscp() },
  { words: ['ip-precedence'], judge: vrpEntier(0, IP_PRECEDENCE_MAX) },
]);

export const BEHAVIOR_CAR: readonly VrpClauseSpec[] = Object.freeze([
  { words: ['cir'], judge: vrpNombre() },
  { words: ['pir'], judge: vrpNombre() },
  { words: ['cbs'], judge: vrpNombre() },
  { words: ['pbs'], judge: vrpNombre() },
]);

/**
 * `car` enchaine plusieurs paires sur une seule ligne, donc chacune est
 * jugee par la meme table et le rang est reporte sur la ligne entiere.
 */
export function judgeVrpCar(args: readonly string[]): VrpClauseProblem | null {
  if (args.length === 0) return { at: 0, incomplete: true };
  for (let i = 0; i < args.length; i += 2) {
    const probleme = judgeVrpClause(BEHAVIOR_CAR, args.slice(i, i + 2));
    if (probleme) return { at: i + probleme.at, incomplete: probleme.incomplete };
  }
  return null;
}

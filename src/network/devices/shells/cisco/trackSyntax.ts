import type { TrackType } from '../../../ipsla/TrackService';
import { boundedInteger } from '@/cli/ArgumentTypes';
import {
  cidrPrefixLength, prefixLengthToMaskUint32, uint32ToIp,
} from '../../../core/ip';

export const TRACK_ID_RANGE: readonly [number, number] = [1, 1000];

export const TRACK_INVALID_ID = '% Invalid track number';

export interface TrackDefinition {
  readonly id: number;
  readonly type: TrackType;
  readonly iface?: string;
  readonly prefix?: string;
  readonly mask?: string;
  readonly slaId?: number;
  readonly boolOp?: 'and' | 'or';
}

export interface TrackParse {
  readonly definition?: TrackDefinition;
  readonly refus?: string;
  readonly incomplet?: boolean;
  readonly idInvalide?: boolean;
}

/**
 * La destination d'une route suivie, dans l'une OU l'autre de ses deux
 * ecritures.
 *
 * IOS accepte `A.B.C.D A.B.C.D` et `A.B.C.D/nn`, et c'est la SECONDE que
 * la documentation d'Enhanced Object Tracking emploie dans ses propres
 * exemples — celle qui etait refusee ici, l'analyse exigeant deux jetons.
 * Le nombre de JETONS consommes est rendu avec la destination, parce que
 * les deux formes n'en prennent pas le meme nombre et que la suite
 * (`reachability`, `metric threshold`) se lit apres.
 */
function lireDestination(mots: readonly string[]):
{ prefix: string; mask: string; jetons: number } | { refus: string } | null {
  const premier = mots[0];
  if (premier === undefined) return null;
  if (premier.includes('/')) {
    const longueur = cidrPrefixLength(premier, false);
    if (longueur === null) return { refus: premier };
    return {
      prefix: premier.slice(0, premier.lastIndexOf('/')),
      mask: uint32ToIp(prefixLengthToMaskUint32(longueur)),
      jetons: 1,
    };
  }
  if (mots[1] === undefined) return null;
  return { prefix: premier, mask: mots[1], jetons: 2 };
}

function interfaceState(rest: readonly string[]): TrackType | null {
  const words = rest.join(' ');
  if (words === 'line-protocol') return 'interface-line';
  if (words === 'ip routing') return 'interface-routing';
  return null;
}

export function parseTrackDefinition(args: readonly string[]): TrackParse {
  const id = boundedInteger(args[0], TRACK_ID_RANGE[0], TRACK_ID_RANGE[1]);
  if (id === null) return { idInvalide: true };
  const rest = args.slice(1);

  if (rest[0] === 'interface') {
    const iface = rest[1];
    if (!iface) return { incomplet: true };
    if (rest.length === 2) return { incomplet: true };
    const type = interfaceState(rest.slice(2));
    if (type === null) return { refus: rest[2] };
    return { definition: { id, type, iface } };
  }

  if (rest[0] === 'ip' && rest[1] === 'route') {
    const lu = lireDestination(rest.slice(2));
    if (lu === null) return { incomplet: true };
    if ('refus' in lu) return { refus: lu.refus };
    const suite = rest.slice(2 + lu.jetons).join(' ');
    if (suite === '') return { incomplet: true };
    if (suite !== 'reachability' && suite !== 'metric threshold') {
      return { refus: rest[2 + lu.jetons] };
    }
    const type: TrackType = suite === 'reachability' ? 'route-reachability' : 'route-metric';
    return { definition: { id, type, prefix: lu.prefix, mask: lu.mask } };
  }

  if (rest[0] === 'ip' && rest[1] === 'sla') {
    if (rest[2] === undefined) return { incomplet: true };
    if (!/^\d+$/.test(rest[2])) return { refus: rest[2] };
    const slaId = Number(rest[2]);
    const suite = rest.slice(3).join(' ');
    if (suite !== '' && suite !== 'state' && suite !== 'reachability') {
      return { refus: rest[3] };
    }
    const type: TrackType = suite === 'state' ? 'ipsla-state' : 'ipsla-reachability';
    return { definition: { id, type, slaId } };
  }

  if (rest[0] === 'list') {
    if (rest[1] === 'boolean') {
      const op = rest[2];
      if (op === undefined) return { incomplet: true };
      if (op !== 'and' && op !== 'or') return { refus: op };
      return { definition: { id, type: 'list-boolean', boolOp: op } };
    }
    if (rest[1] === 'threshold') {
      const kind = rest[2];
      if (kind === undefined) return { incomplet: true };
      if (kind !== 'weight' && kind !== 'percentage') return { refus: kind };
      return { definition: { id, type: 'list-threshold' } };
    }
    return rest[1] === undefined ? { incomplet: true } : { refus: rest[1] };
  }

  if (rest.length === 0 || rest[0] === 'stub-object') {
    return { definition: { id, type: 'stub' } };
  }
  return { refus: rest[0] };
}

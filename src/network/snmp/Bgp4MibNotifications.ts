import type { IPAddress } from '../core/types';
import type { BgpFsmState } from '../bgp/BgpSession';
import type { BgpErrorCode } from '../bgp/messages';
import type { SnmpNotification } from './SnmpNotification';
import { v, vb } from './types';

const OID_BGP = '1.3.6.1.2.1.15';
const OID_BGP_NOTIFICATION = `${OID_BGP}.0`;
export const OID_BGP_ESTABLISHED_NOTIFICATION = `${OID_BGP_NOTIFICATION}.1`;
export const OID_BGP_BACKWARD_TRANS_NOTIFICATION = `${OID_BGP_NOTIFICATION}.2`;

const OID_BGP_PEER_ENTRY = `${OID_BGP}.3.1`;
const PEER_STATE_COLUMN = 2;
const PEER_REMOTE_ADDR_COLUMN = 7;
const PEER_LAST_ERROR_COLUMN = 14;

const PEER_STATE_VALUES: Readonly<Record<BgpFsmState, number>> = Object.freeze({
  Idle: 1, Connect: 2, Active: 3, OpenSent: 4, OpenConfirm: 5, Established: 6,
});

export interface BgpPeerTransition {
  readonly remoteAddress: IPAddress;
  readonly from: BgpFsmState;
  readonly to: BgpFsmState;
  readonly lastError: BgpErrorCode;
}

export function isBgpFsmState(state: string): state is BgpFsmState {
  return Object.prototype.hasOwnProperty.call(PEER_STATE_VALUES, state);
}

export function bgpPeerNotification(transition: BgpPeerTransition): SnmpNotification | null {
  const oid = notificationOid(transition.from, transition.to);
  if (oid === null) return null;
  const instance = transition.remoteAddress.toString();
  const column = (number: number) => `${OID_BGP_PEER_ENTRY}.${number}.${instance}`;
  return {
    oid,
    objects: [
      vb(column(PEER_REMOTE_ADDR_COLUMN), v('ipv4', instance)),
      vb(column(PEER_LAST_ERROR_COLUMN), v('octet-string',
        Uint8Array.of(transition.lastError.code, transition.lastError.subcode))),
      vb(column(PEER_STATE_COLUMN), v('integer', PEER_STATE_VALUES[transition.to])),
    ],
  };
}

function notificationOid(from: BgpFsmState, to: BgpFsmState): string | null {
  if (to === 'Established' && from !== 'Established') return OID_BGP_ESTABLISHED_NOTIFICATION;
  if (PEER_STATE_VALUES[to] < PEER_STATE_VALUES[from]) return OID_BGP_BACKWARD_TRANS_NOTIFICATION;
  return null;
}

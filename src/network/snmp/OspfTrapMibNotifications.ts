import type { IPAddress } from '../core/types';
import type { OSPFNeighborState } from '../ospf/types';
import type { SnmpNotification } from './SnmpNotification';
import { v, vb } from './types';

const OID_OSPF = '1.3.6.1.2.1.14';
export const OID_OSPF_NBR_STATE_CHANGE = `${OID_OSPF}.16.2.2`;
const OID_OSPF_ROUTER_ID = `${OID_OSPF}.1.1.0`;
const OID_OSPF_NBR_ENTRY = `${OID_OSPF}.10.1`;
const NBR_IP_ADDR_COLUMN = 1;
const NBR_ADDRESS_LESS_INDEX_COLUMN = 2;
const NBR_RTR_ID_COLUMN = 3;
const NBR_STATE_COLUMN = 6;
const NUMBERED_INTERFACE_INDEX = 0;

const NBR_STATE_VALUES: Readonly<Record<OSPFNeighborState, number>> = Object.freeze({
  Down: 1, Attempt: 2, Init: 3, TwoWay: 4, ExStart: 5, Exchange: 6, Loading: 7, Full: 8,
});

const TERMINAL_STATES: readonly OSPFNeighborState[] = Object.freeze(['TwoWay', 'Full']);

export interface OspfNeighborTransition {
  readonly routerId: IPAddress;
  readonly neighborAddress: IPAddress;
  readonly neighborRouterId: IPAddress;
  readonly from: OSPFNeighborState;
  readonly to: OSPFNeighborState;
  readonly multiAccess: boolean;
  readonly designatedRouter: boolean;
}

export function ospfNbrStateChange(transition: OspfNeighborTransition): SnmpNotification | null {
  if (!due(transition)) return null;
  const instance = `${transition.neighborAddress.toString()}.${NUMBERED_INTERFACE_INDEX}`;
  const column = (number: number) => `${OID_OSPF_NBR_ENTRY}.${number}.${instance}`;
  return {
    oid: OID_OSPF_NBR_STATE_CHANGE,
    objects: [
      vb(OID_OSPF_ROUTER_ID, v('ipv4', transition.routerId.toString())),
      vb(column(NBR_IP_ADDR_COLUMN), v('ipv4', transition.neighborAddress.toString())),
      vb(column(NBR_ADDRESS_LESS_INDEX_COLUMN), v('integer', NUMBERED_INTERFACE_INDEX)),
      vb(column(NBR_RTR_ID_COLUMN), v('ipv4', transition.neighborRouterId.toString())),
      vb(column(NBR_STATE_COLUMN), v('integer', NBR_STATE_VALUES[transition.to])),
    ],
  };
}

function due(transition: OspfNeighborTransition): boolean {
  const regresses = NBR_STATE_VALUES[transition.to] < NBR_STATE_VALUES[transition.from];
  if (!regresses && !TERMINAL_STATES.includes(transition.to)) return false;
  const touchesFull = transition.from === 'Full' || transition.to === 'Full';
  return !(transition.multiAccess && touchesFull) || transition.designatedRouter;
}

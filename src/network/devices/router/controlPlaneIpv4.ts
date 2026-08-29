import { IP_PROTO_IGMP } from '../../igmp/types';
import { IP_PROTO_PIM } from '../../pim/types';
import { IP_PROTO_VRRP } from '../../vrrp/types';
import { IP_PROTO_GRE } from '../../gre/types';
import { isMulticastIpv4 } from '../../core/ip';
import type { IPAddress, IPv4Packet } from '../../core/types';

interface IpProtocolAgent {
  handleIp(inPort: string, srcIp: IPAddress, ipPkt: IPv4Packet): void;
}

interface TunnelAgent {
  handleIp(inPort: string, srcIp: IPAddress, ipPkt: IPv4Packet): IPv4Packet | null;
}

export interface ControlPlaneIpv4Agents {
  readonly igmp: IpProtocolAgent;
  readonly pim: IpProtocolAgent;
  readonly vrrp: IpProtocolAgent;
  readonly gre: TunnelAgent;
  reinject(inPort: string, inner: IPv4Packet): void;
}

export function dispatchControlPlaneIpv4(
  agents: ControlPlaneIpv4Agents, inPort: string, ipPkt: IPv4Packet,
): boolean {
  if (ipPkt.protocol === IP_PROTO_IGMP) {
    agents.igmp.handleIp(inPort, ipPkt.sourceIP, ipPkt);
    return true;
  }
  if (ipPkt.protocol === IP_PROTO_PIM) {
    agents.pim.handleIp(inPort, ipPkt.sourceIP, ipPkt);
    return true;
  }
  if (ipPkt.protocol === IP_PROTO_VRRP && isMulticastIpv4(ipPkt.destinationIP.toString())) {
    agents.vrrp.handleIp(inPort, ipPkt.sourceIP, ipPkt);
    return true;
  }
  if (ipPkt.protocol === IP_PROTO_GRE) {
    const inner = agents.gre.handleIp(inPort, ipPkt.sourceIP, ipPkt);
    if (inner) agents.reinject(inPort, inner);
    return true;
  }
  return false;
}

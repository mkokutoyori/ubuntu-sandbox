/**
 * SwitchVrrpAdapter — a FhrpHost adapter that lets a VRRP (or any
 * FHRP-family) agent live on an L3 switch's SVIs.
 *
 * The FhrpAgentBase talks to a physical Port to know if the interface
 * is up and to shove out advertisement frames. An SVI (Vlanif) has no
 * physical port — its IP, admin state and MAC come from the SwitchSvi
 * plane and the switch's bridge MAC. This adapter wraps each Vlanif
 * as a **synthetic port** exposing the three methods the agent reads
 * (getIPAddress, getIsUp, isConnected), and forwards sendFrame(iface,
 * frame) into the VLAN's L2 forwarding when iface is a Vlanif.
 *
 * Physical port names still flow through unchanged, so agents can
 * coexist with any legacy per-port FHRP config the switch may inherit.
 */

import type { EthernetFrame } from '../../core/types';
import { MACAddress, IPAddress, SubnetMask } from '../../core/types';
import type { Port } from '../../hardware/Port';
import type { FhrpHost } from '../../fhrp/types';
import type { Switch } from '../Switch';

/** Match `Vlanif10`, `Vlan10`, `vlanif10`, `vlan10` (case-insensitive). */
export function parseVlanIfName(name: string): number | null {
  const m = /^(?:vlanif|vlan)\s*(\d+)$/i.exec(name);
  return m ? parseInt(m[1], 10) : null;
}

/** How the switch injects a frame into a VLAN's L2 forwarding plane. */
export interface SwitchVlanBridge {
  egressOnVlan(vlan: number, frame: EthernetFrame): void;
  vlanHasActivePort(vlan: number): boolean;
  getBridgeMac(): MACAddress;
}

/**
 * Build a FhrpHost the VRRP/HSRP agent can drive against the SVI plane.
 * `sw` is the switch itself (used for physical ports + hostname);
 * `bridge` is its VLAN forwarding surface (used for Vlanif egress).
 */
export function makeSwitchVrrpHost(sw: Switch, bridge: SwitchVlanBridge): FhrpHost {
  return {
    id: sw.getId(),
    name: sw.getName(),
    getHostname: () => sw.getHostname(),
    getPort: (name) => {
      const vlan = parseVlanIfName(name);
      if (vlan === null) return sw.getPort(name);
      return makeVlanifSyntheticPort(sw, bridge, vlan, name);
    },
    getPorts: () => sw.getPorts(),
    sendFrame: (portName, frame) => {
      const vlan = parseVlanIfName(portName);
      if (vlan === null) { sw.sendFrame(portName, frame); return; }
      bridge.egressOnVlan(vlan, frame);
    },
  };
}

/**
 * Build a Port-shaped object describing a Vlanif for the FhrpAgent to
 * read. Only the three methods the base class reads (getIPAddress,
 * getIsUp, isConnected) carry semantics; the rest are safe defaults
 * that keep TypeScript happy under the `Port` cast.
 */
function makeVlanifSyntheticPort(
  sw: Switch, bridge: SwitchVlanBridge, vlan: number, name: string,
): Port {
  const svi = sw.getSvi(vlan);
  const bridgeMac = bridge.getBridgeMac();
  const stub = {
    getName: () => name,
    getMAC: () => bridgeMac,
    getIPAddress: () => svi?.ip ?? null,
    getSubnetMask: () => svi?.mask ?? null,
    getIsUp: () => !!svi?.adminUp,
    isConnected: () =>
      !!svi?.adminUp && bridge.vlanHasActivePort(vlan),
    getEquipmentId: () => sw.getId(),
    getCable: () => null,
    getType: () => 'ethernet' as const,
    setUp: () => undefined,
    setEquipmentId: () => undefined,
    setMAC: () => undefined,
    configureIP: (ip: IPAddress, mask: SubnetMask) => sw.configureSviIp(vlan, ip, mask),
  };
  return stub as unknown as Port;
}

/**
 * TopologyWalk — shared cable-plant traversal (rapport 00 synthesis,
 * item #23: "4 implémentations quasi identiques du même BFS").
 *
 * `RouterOSPFIntegration.collectOSPFDomain`/`collectOSPFv3Domain`/
 * `collectV3CandidateRouters`/`findNextHopTo` each duplicated the same
 * fragment — "if the direct neighbor isn't a match, look at its OTHER
 * ports for one more hop" — to see past a switch/hub. Being hardcoded
 * to exactly one extra hop, none of them see past a SECOND chained
 * switch (SW1—SW2), which is the multi-hop OSPF convergence gap
 * documented in CLAUDE.md. `resolveAcrossTransparentDevices` replaces
 * that fragment with a real BFS of arbitrary depth: it walks through
 * any number of non-matching devices (switches, hubs — anything that
 * isn't itself a match) exactly the way a flooded Ethernet frame would
 * reach every device on the shared broadcast domain, however many
 * switches sit in between.
 */

import type { Equipment } from './Equipment';
import type { Port } from '../hardware/Port';
import { EquipmentRegistry } from './EquipmentRegistry';

export interface TransparentWalkHit {
  /** The equipment satisfying `matches`. */
  device: Equipment;
  /** The specific port ON `device` that terminates this path — e.g. the
   *  interface whose IP is the real next hop, or the interface an
   *  adjacency should form on. */
  port: Port;
}

/**
 * Starting at `entryPort` (a port already reached by crossing one
 * cable), walk transparently through every device that does NOT
 * satisfy `matches` — collecting every device that does. A device
 * satisfying `matches` is a path endpoint: its own further ports are
 * not explored by this call (that's the caller's own outer BFS, if it
 * has one — see e.g. `collectOSPFDomain`, which re-enters this
 * function once per port of every router it finds).
 */
export function resolveAcrossTransparentDevices(
  entryPort: Port,
  matches: (equipment: Equipment) => boolean,
): TransparentWalkHit[] {
  const registry = EquipmentRegistry.getInstance();
  const hits: TransparentWalkHit[] = [];
  const visitedDeviceIds = new Set<string>();
  const queue: Port[] = [entryPort];

  while (queue.length > 0) {
    const port = queue.shift()!;
    const device = registry.getById(port.getEquipmentId());
    if (!device || visitedDeviceIds.has(device.getId())) continue;
    visitedDeviceIds.add(device.getId());

    if (matches(device)) {
      hits.push({ device, port });
      continue;
    }
    for (const sibling of device.getPorts()) {
      if (sibling === port) continue;
      const cable = sibling.getCable();
      if (!cable) continue;
      const remote = cable.getPortA() === sibling ? cable.getPortB() : cable.getPortA();
      if (remote) queue.push(remote);
    }
  }
  return hits;
}

import type { LldpAgent, LldpNeighbor } from '@/network/lldp/LldpAgent';
import { lldpCapabilityWords, LLDP_CAPABILITY_BIT } from '@/network/lldp/types';

function capabilityBits(n: LldpNeighbor): string {
  const value = (n.remoteCapabilities ?? [])
    .reduce((acc, c) => acc | LLDP_CAPABILITY_BIT[c], 0);
  return value.toString(16).padStart(4, '0');
}

function line(index: number, key: string, value: string): string {
  return `${index} ${key}: ${value}`;
}

export function renderLldpNeighborDetails(
  agent: LldpAgent, portName: string, portIndex: number,
  localMac: string,
): string {
  const found = agent.getNeighborsOnPort(portName);
  if (found.length === 0) return '';
  const out: string[] = [];
  found.forEach((n, i) => {
    const idx = i + 1;
    out.push(line(idx, 'port', String(portIndex)));
    out.push(line(idx, 'port.txt', portName));
    out.push(line(idx, 'mac', localMac));
    out.push(line(idx, 'chassis.type', '4'));
    out.push(line(idx, 'chassis.type.txt', 'interface-mac'));
    out.push(line(idx, 'chassis.data', n.chassisId));
    out.push(line(idx, 'port.id.type', '5'));
    out.push(line(idx, 'port.id.type.txt', 'interface-name'));
    out.push(line(idx, 'port.id.len', String(n.portId.length)));
    out.push(line(idx, 'port.id.data', n.portId));
    out.push(line(idx, 'ttl', String(agent.ttlRemainingSec(n))));
    if (n.portDescription !== undefined) {
      out.push(line(idx, 'port.desc.len', String(n.portDescription.length)));
      out.push(line(idx, 'port.desc.data', n.portDescription));
    }
    if (n.systemName !== undefined) {
      out.push(line(idx, 'system.name.len', String(n.systemName.length)));
      out.push(line(idx, 'system.name.data', n.systemName));
    }
    if (n.systemDescription !== undefined) {
      out.push(line(idx, 'system.desc.len', String(n.systemDescription.length)));
      out.push(line(idx, 'system.desc.data', n.systemDescription));
    }
    if (n.remoteCapabilities !== undefined) {
      const bits = capabilityBits(n);
      const words = lldpCapabilityWords(n.remoteCapabilities);
      out.push(line(idx, 'system.caps.available', bits));
      out.push(line(idx, 'system.caps.available.txt', words));
      out.push(line(idx, 'system.caps.enabled', bits));
      out.push(line(idx, 'system.caps.enabled.txt', words));
    }
    const addrs = n.managementAddresses ?? [];
    out.push(line(idx, 'address.count', String(addrs.length)));
    addrs.forEach((a, k) => {
      out.push(line(idx, `address.${k + 1}.type`, '1'));
      out.push(line(idx, `address.${k + 1}.type.txt`, 'ipv4'));
      out.push(line(idx, `address.${k + 1}.len`, '4'));
      out.push(line(idx, `address.${k + 1}.addr`, a));
    });
  });
  return out.join('\n');
}

export function renderLldpNeighborSummary(
  agent: LldpAgent, ports: readonly string[],
): string {
  const rows: string[] = [];
  for (const p of ports) {
    for (const n of agent.getNeighborsOnPort(p)) {
      rows.push(`${p.padEnd(16)}${(n.systemName ?? '-').padEnd(24)}` +
        `${n.portId.padEnd(24)}${agent.ttlRemainingSec(n)}`);
    }
  }
  return ['port            neighbor                port                    ttl', ...rows]
    .join('\n');
}

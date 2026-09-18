import type { LldpAgent, LldpNeighbor } from '@/network/lldp/LldpAgent';
import {
  lldpCapabilityWords, LLDP_CAPABILITY_BIT,
  LLDP_CHASSIS_ID_SUBTYPE, LLDP_PORT_ID_SUBTYPE,
  LLDP_INTERFACE_NUMBERING_SUBTYPE, LLDP_MANAGEMENT_ADDRESS_FAMILY,
  type LldpChassisIdSubtype, type LldpPortIdSubtype,
  type LldpInterfaceNumbering, type LldpManagementAddressFamily,
} from '@/network/lldp/types';

const CHASSIS_WORD: Partial<Record<LldpChassisIdSubtype, string>> = {
  macAddress: 'interface-mac',
};

const PORT_ID_WORD: Partial<Record<LldpPortIdSubtype, string>> = {
  interfaceName: 'interface-name',
};

const FAMILY_WORD: Partial<Record<LldpManagementAddressFamily, string>> = {
  ipv4: 'ipv4',
};

const NUMBERING_WORD: Partial<Record<LldpInterfaceNumbering, string>> = {
  ifIndex: 'if-index',
};

const ADDRESS_BYTES: Readonly<Record<LldpManagementAddressFamily, number>> = {
  ipv4: 4, ipv6: 16,
};

const AUTONEG_BIT_WORD = ['supported', 'enabled'] as const;

function capabilityBits(n: LldpNeighbor): string {
  const value = (n.remoteCapabilities ?? [])
    .reduce((acc, c) => acc | LLDP_CAPABILITY_BIT[c], 0);
  return value.toString(16).padStart(4, '0');
}

function autoNegotiationBits(supported: boolean, enabled: boolean): number {
  return (supported ? 1 : 0) | (enabled ? 2 : 0);
}

function line(index: number, key: string, value: string): string {
  return `${index} ${key}: ${value}`;
}

function typedLine(
  out: string[], index: number, key: string,
  code: number, word: string | undefined,
): void {
  out.push(line(index, key, String(code)));
  if (word !== undefined) out.push(line(index, `${key}.txt`, word));
}

function lengthAndData(
  out: string[], index: number, key: string, value: string,
): void {
  out.push(line(index, `${key}.len`, String(value.length)));
  out.push(line(index, `${key}.data`, value));
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
    typedLine(out, idx, 'chassis.type',
      LLDP_CHASSIS_ID_SUBTYPE[n.chassisIdSubtype], CHASSIS_WORD[n.chassisIdSubtype]);
    out.push(line(idx, 'chassis.data', n.chassisId));
    typedLine(out, idx, 'port.id.type',
      LLDP_PORT_ID_SUBTYPE[n.portIdSubtype], PORT_ID_WORD[n.portIdSubtype]);
    lengthAndData(out, idx, 'port.id', n.portId);
    out.push(line(idx, 'ttl', String(agent.ttlRemainingSec(n))));
    if (n.portDescription !== undefined) {
      lengthAndData(out, idx, 'port.desc', n.portDescription);
    }
    if (n.systemName !== undefined) {
      lengthAndData(out, idx, 'system.name', n.systemName);
    }
    if (n.systemDescription !== undefined) {
      lengthAndData(out, idx, 'system.desc', n.systemDescription);
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
      const prefix = `address.${k + 1}`;
      typedLine(out, idx, `${prefix}.type`,
        LLDP_MANAGEMENT_ADDRESS_FAMILY[a.family], FAMILY_WORD[a.family]);
      out.push(line(idx, `${prefix}.len`, String(ADDRESS_BYTES[a.family])));
      out.push(line(idx, `${prefix}.addr`, a.address.toString()));
      typedLine(out, idx, `${prefix}.addr.interface.type`,
        LLDP_INTERFACE_NUMBERING_SUBTYPE[a.numbering], NUMBERING_WORD[a.numbering]);
      out.push(line(idx, `${prefix}.addr.interface.number`, String(a.interfaceNumber)));
    });
    if (n.portVlanId !== undefined) out.push(line(idx, 'vlan.id', String(n.portVlanId)));
    if (n.vlanNames !== undefined) {
      out.push(line(idx, 'vlan.name.count', String(n.vlanNames.length)));
      n.vlanNames.forEach((v, k) => {
        out.push(line(idx, `vlan.name.${k + 1}.id`, String(v.id)));
        lengthAndData(out, idx, `vlan.name.${k + 1}`, v.name);
      });
    }
    if (n.autoNegotiation !== undefined) {
      const { supported, enabled } = n.autoNegotiation;
      const bits = autoNegotiationBits(supported, enabled);
      out.push(line(idx, 'mac_phy.auto', String(bits)));
      out.push(line(idx, 'mac_phy.auto.txt',
        AUTONEG_BIT_WORD.filter((_, b) => (bits & (1 << b)) !== 0).join(' ')));
    }
    if (n.maxFrameSize !== undefined) {
      out.push(line(idx, 'max-frame-size', String(n.maxFrameSize)));
    }
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

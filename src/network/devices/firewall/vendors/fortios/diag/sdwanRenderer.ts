import type {
  SdwanService as SdwanServiceRule, SdwanTable,
} from '../../../sdwan/SdwanTable';

export function renderSdwanHealthCheck(table: SdwanTable, only?: string): string {
  const checks = table.allHealthChecks()
    .filter(check => only === undefined || check.name === only);
  if (checks.length === 0) return '';

  const blocks = checks.map(check => {
    const lines = [`Health Check(${check.name}):`];
    for (const sequence of check.members) {
      const member = table.member(sequence);
      if (!member) continue;
      lines.push(memberLine(table, check.name, sequence, member.iface));
    }
    return lines.join('\n');
  });
  return blocks.join('\n');
}

export function renderSdwanMembers(table: SdwanTable): string {
  const lines = table.allMembers().map(member =>
    `Member(${member.sequence}): interface: ${member.iface}, `
    + `gateway: ${member.gateway}, priority: ${member.priority}`);
  return lines.join('\n');
}

export function renderSdwanService(table: SdwanTable): string {
  const blocks = table.allServices().map(service => {
    const ordered = orderedMembers(table, service);
    const head = `Service(${service.id}): Address Mode(IPV4) flags=0x0\n`
      + `  Gen(1), TOS(0x0/0x0), Protocol(0), Mode(${service.mode})`
      + (service.mode === 'sla' ? ', sla-compare-order' : '');
    const lines = ordered.map((entry, index) =>
      `    ${index + 1}: Seq_num(${entry.sequence} ${entry.iface}), `
      + `${entry.alive ? 'alive' : 'dead'}, sla(0x${entry.slaMap.toString(16)}), `
      + `gid(0), cfg_order(${entry.configuredOrder}), cost(0)`
      + (entry.selected ? ', selected' : ''));
    return [head, `  Members(${ordered.length}):`, ...lines].join('\n');
  });
  return blocks.join('\n');
}

interface ServiceMemberLine {
  readonly sequence: number;
  readonly iface: string;
  readonly alive: boolean;
  readonly slaMap: number;
  readonly configuredOrder: number;
  readonly selected: boolean;
}

function orderedMembers(table: SdwanTable, service: SdwanServiceRule): ServiceMemberLine[] {
  const sequences = service.priorityMembers.length > 0
    ? service.priorityMembers
    : table.allMembers().map(member => member.sequence);

  const lines: ServiceMemberLine[] = [];
  sequences.forEach((sequence, configuredOrder) => {
    const member = table.member(sequence);
    if (!member || !member.enabled) return;
    const alive = table.healthOf(service.healthCheck, sequence)?.alive === true;
    const meets = service.healthCheck.length > 0
      && table.slaMet(service.healthCheck, sequence, service.slaId);
    lines.push({
      sequence, iface: member.iface, alive, configuredOrder,
      slaMap: slaMap(table, service.healthCheck, sequence),
      selected: service.mode === 'sla' ? meets : alive,
    });
  });

  if (service.mode !== 'sla') return lines;
  return [...lines].sort((a, b) =>
    Number(b.selected) - Number(a.selected) || a.configuredOrder - b.configuredOrder);
}

function memberLine(
  table: SdwanTable, check: string, sequence: number, iface: string,
): string {
  const measured = table.healthOf(check, sequence);
  const head = `Seq(${sequence} ${iface}): `;

  if (!measured || !measured.alive) {
    const loss = measured?.packetLossPercent ?? 100;
    return `${head}state(dead), packet-loss(${loss.toFixed(3)}%) sla_map=0x0`;
  }

  return `${head}state(alive), packet-loss(${measured.packetLossPercent.toFixed(3)}%) `
    + `latency(${measured.latencyMs.toFixed(3)}), jitter(${measured.jitterMs.toFixed(3)}) `
    + `sla_map=0x${slaMap(table, check, sequence).toString(16)}`;
}

function slaMap(table: SdwanTable, check: string, sequence: number): number {
  const declared = table.healthCheck(check);
  if (!declared) return 0;

  let map = 0;
  for (const target of declared.sla) {
    if (target.id >= 1 && table.slaMet(check, sequence, target.id)) map |= 1 << (target.id - 1);
  }
  return map;
}

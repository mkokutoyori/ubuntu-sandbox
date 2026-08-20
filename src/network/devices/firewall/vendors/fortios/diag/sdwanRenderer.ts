import type { SdwanTable } from '../../../sdwan/SdwanTable';

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
    `Member(${member.sequence}): interface(${member.iface}), gateway(${member.gateway}), `
    + `priority(${member.priority}), status(${member.enabled ? 'enable' : 'disable'})`);
  return lines.join('\n');
}

export function renderSdwanService(table: SdwanTable): string {
  const blocks = table.allServices().map(service => {
    const chosen = service.healthCheck.length > 0
      ? table.preferredMember(service.healthCheck, service.slaId)
      : undefined;
    return `Service(${service.id}): Address Mode(IPV4) flags=0x0\n`
      + `  Gen(1), TOS(0x0/0x0), Protocol(0), Mode(${service.mode})\n`
      + `  Members(${service.priorityMembers.length}):\n`
      + `    1: Seq_num(${chosen?.sequence ?? 0}), alive, selected`;
  });
  return blocks.join('\n');
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
    + 'sla_map=0x0';
}

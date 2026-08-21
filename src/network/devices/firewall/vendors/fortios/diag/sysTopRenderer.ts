import type { Firewall } from '../../../Firewall';
import { sysTopCpuLine, FORTI_VM_MEMORY_MB, FORTI_VM_CPUS } from './systemLoad';

export { FORTI_VM_MEMORY_MB, FORTI_VM_CPUS };

export interface FortiProcess {
  readonly name: string;
  readonly pid: number;
  readonly state: string;
}

function processTable(fw: Firewall): FortiProcess[] {
  const running: FortiProcess[] = [
    { name: 'newcli', pid: 83, state: 'R' },
    { name: 'httpsd', pid: 91, state: 'S' },
    { name: 'cmdbsvr', pid: 42, state: 'S' },
  ];

  const policies = fw.getPolicyStore().ordered();
  if (policies.some(rule => rule.utmEnabled === true
    && rule.inspectionMode === 'proxy')) {
    running.push({ name: 'wad', pid: 120, state: 'S <' });
  }
  if (policies.some(rule => rule.utmEnabled === true)) {
    running.push({ name: 'ipsengine', pid: 133, state: 'S' });
  }
  if (fw.getDnsServer().listZones().length > 0
    || fw.getDnsClient().getSettings().primary.length > 0) {
    running.push({ name: 'dnsproxy', pid: 108, state: 'S' });
  }
  if (fw.getDhcp().leases().length > 0) {
    running.push({ name: 'dhcpd', pid: 112, state: 'S' });
  }
  return running;
}

function runTime(uptimeMs: number): string {
  const minutes = Math.floor(uptimeMs / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return `Run Time:  ${days} days, ${hours} hours and ${minutes % 60} minutes`;
}

export function renderSysTop(fw: Firewall): string {
  const lines = [
    runTime(fw.getUptimeMs()),
    sysTopCpuLine(),
  ];
  for (const process of processTable(fw)) {
    lines.push(`        ${process.name.padEnd(16)}${String(process.pid).padStart(4)}`
      + `      ${process.state.padEnd(4)}    0.0     0.0`);
  }
  return lines.join('\n');
}

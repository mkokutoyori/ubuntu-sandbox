import type { Firewall } from '../../../Firewall';
import { sysTopCpuLine } from './systemLoad';
import { renderTable, FIXED_TABLE } from '../../../../shells/cli/TextTable';

export interface FortiProcess {
  readonly name: string;
  readonly pid: number;
  readonly state: string;
  readonly residentKib: number;
  readonly inspection: boolean;
}

export function processTable(fw: Firewall): FortiProcess[] {
  const running: FortiProcess[] = [
    { name: 'newcli', pid: 83, state: 'R', residentKib: 20_480, inspection: false },
    { name: 'httpsd', pid: 91, state: 'S', residentKib: 61_440, inspection: false },
    { name: 'cmdbsvr', pid: 42, state: 'S', residentKib: 40_960, inspection: false },
  ];

  const policies = fw.getPolicyStore().ordered();
  if (policies.some(rule => rule.utmEnabled === true
    && rule.inspectionMode === 'proxy')) {
    running.push({
      name: 'wad', pid: 120, state: 'S <', residentKib: 122_880, inspection: true,
    });
  }
  if (policies.some(rule => rule.utmEnabled === true)) {
    running.push({
      name: 'ipsengine', pid: 133, state: 'S', residentKib: 204_800, inspection: true,
    });
  }
  if (fw.getDnsServer().listZones().length > 0
    || fw.getDnsClient().getSettings().primary.length > 0) {
    running.push({
      name: 'dnsproxy', pid: 108, state: 'S', residentKib: 30_720, inspection: false,
    });
  }
  if (fw.getDhcp().leases().length > 0) {
    running.push({
      name: 'dhcpd', pid: 112, state: 'S', residentKib: 10_240, inspection: false,
    });
  }
  return running;
}

export function daemonMemoryKib(fw: Firewall): number {
  return processTable(fw).reduce((total, process) => total + process.residentKib, 0);
}

function runTime(uptimeMs: number): string {
  const minutes = Math.floor(uptimeMs / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return `Run Time:  ${days} days, ${hours} hours and ${minutes % 60} minutes`;
}

export function renderSysTop(fw: Firewall): string {
  const load = fw.getSystemLoad();
  const states = load.cpuStates();
  const totalKib = load.memory().totalKib;
  const processes = processTable(fw);
  const inspecting = processes.filter(process => process.inspection).length;

  const cpuShare = (process: FortiProcess): number =>
    process.inspection && inspecting > 0 ? states.user / inspecting : 0;

  return [
    runTime(fw.getUptimeMs()),
    sysTopCpuLine(load),
    ...renderTable(processes, [
      { header: '', width: 15, align: 'right', value: (p) => p.name },
      { header: '', width: 11, align: 'right', value: (p) => String(p.pid) },
      { header: '', width: 7, align: 'right', value: (p) => p.state },
      { header: '', width: 8, align: 'right', value: (p) => cpuShare(p).toFixed(1) },
      {
        header: '', width: 7, align: 'right',
        value: (p) => ((p.residentKib / totalKib) * 100).toFixed(1),
      },
      { header: '', width: 5, align: 'right', value: () => '1' },
    ], { ...FIXED_TABLE, header: false }),
  ].join('\n');
}

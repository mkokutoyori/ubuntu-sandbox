import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Equipment } from '@/network';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const OUTPUT_DIR = path.resolve(__dirname, '../../../../debug-output/protocols');

export function resetSim(): void {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
}

export function sweep<T>(n: number, fn: (i: number) => T | T[]): T[] {
  const out: T[] = [];
  for (let i = 1; i <= n; i++) {
    const v = fn(i);
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out;
}

export function each<I, T>(items: readonly I[], fn: (it: I, idx: number) => T | T[]): T[] {
  const out: T[] = [];
  items.forEach((it, idx) => {
    const v = fn(it, idx);
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  });
  return out;
}

export interface ProtoStep {
  readonly section?: string;
  readonly on?: string;
  readonly cmd: string;
}
export type ProtoStepInput = string | ProtoStep;

interface DeviceLike {
  executeCommand(cmd: string): Promise<string>;
  getPrompt?(): string;
}

export interface EnterpriseTopology {
  readonly devices: Record<string, DeviceLike>;
  readonly note: string;
}

export interface EnterpriseWAN {
  rhq: CiscoRouter; rbr: HuaweiRouter; rdc: CiscoRouter;
  swhq: CiscoSwitch; swbr: HuaweiSwitch; swdc: GenericSwitch;
  lhq: LinuxPC; whq: WindowsPC;
  wbr: WindowsPC; lbr: LinuxPC;
  srvdc: LinuxServer; ldc: LinuxPC;
  topology: EnterpriseTopology;
}

export const SITE = {
  hq: { lan: '10.1.1.0/24', mask: '255.255.255.0', gw: '10.1.1.1', linux: '10.1.1.10', win: '10.1.1.11' },
  br: { lan: '10.2.2.0/24', mask: '255.255.255.0', gw: '10.2.2.1', win: '10.2.2.10', linux: '10.2.2.11' },
  dc: { lan: '10.3.3.0/24', mask: '255.255.255.0', gw: '10.3.3.1', srv: '10.3.3.10', linux: '10.3.3.11' },
} as const;

export const WAN = {
  hqbr: { net: '172.16.12.0/30', hq: '172.16.12.1', br: '172.16.12.2' },
  hqdc: { net: '172.16.13.0/30', hq: '172.16.13.1', dc: '172.16.13.2' },
  brdc: { net: '172.16.23.0/30', dc: '172.16.23.1', br: '172.16.23.2' },
} as const;

export function buildEnterpriseWAN(): EnterpriseWAN {
  const rhq = new CiscoRouter('R-HQ', 320, 120);
  const rbr = new HuaweiRouter('R-BR', 700, 120);
  const rdc = new CiscoRouter('R-DC', 520, 400);

  const swhq = new CiscoSwitch('switch-cisco', 'SW-HQ', 26, 320, 240);
  const swbr = new HuaweiSwitch('switch-huawei', 'SW-BR', 24, 700, 240);
  const swdc = new GenericSwitch('switch-generic', 'SW-DC', 8, 520, 520);

  const lhq = new LinuxPC('linux-pc', 'PC-HQ-L', 220, 340);
  const whq = new WindowsPC('windows-pc', 'PC-HQ-W', 420, 340);
  const wbr = new WindowsPC('windows-pc', 'PC-BR-W', 620, 340);
  const lbr = new LinuxPC('linux-pc', 'PC-BR-L', 800, 340);
  const srvdc = new LinuxServer('linux-server', 'SRV-DC', 420, 620);
  const ldc = new LinuxPC('linux-pc', 'PC-DC-L', 620, 620);

  const wire = (id: string, a: Equipment, ap: string, b: Equipment, bp: string) => {
    new Cable(id).connect(a.getPort(ap)!, b.getPort(bp)!);
  };

  wire('hq-up', rhq, 'GigabitEthernet0/0', swhq, 'FastEthernet0/1');
  wire('hq-l', lhq, 'eth0', swhq, 'FastEthernet0/2');
  wire('hq-w', whq, 'eth0', swhq, 'FastEthernet0/3');

  wire('br-up', rbr, 'GE0/0/0', swbr, 'GigabitEthernet0/0/1');
  wire('br-w', wbr, 'eth0', swbr, 'GigabitEthernet0/0/2');
  wire('br-l', lbr, 'eth0', swbr, 'GigabitEthernet0/0/3');

  wire('dc-up', rdc, 'GigabitEthernet0/0', swdc, 'eth0');
  wire('dc-srv', srvdc, 'eth0', swdc, 'eth1');
  wire('dc-l', ldc, 'eth0', swdc, 'eth2');

  wire('wan-hqbr', rhq, 'GigabitEthernet0/1', rbr, 'GE0/0/1');
  wire('wan-hqdc', rhq, 'GigabitEthernet0/2', rdc, 'GigabitEthernet0/1');
  wire('wan-brdc', rbr, 'GE0/0/2', rdc, 'GigabitEthernet0/2');

  const topology: EnterpriseTopology = {
    devices: {
      rhq, rbr, rdc, swhq, swbr, swdc,
      lhq, whq, wbr, lbr, srvdc, ldc,
    },
    note:
      'ACME Corp — 3 sites, WAN triangle. ' +
      'HQ(Cisco): R-HQ Gi0/0->SW-HQ(Cisco Catalyst) LAN 10.1.1.0/24 [PC-HQ-L 10.1.1.10, PC-HQ-W 10.1.1.11]; ' +
      'BR(Huawei): R-BR GE0/0/0->SW-BR(Huawei S5720) LAN 10.2.2.0/24 [PC-BR-W 10.2.2.10, PC-BR-L 10.2.2.11]; ' +
      'DC(mixte): R-DC Gi0/0->SW-DC(generic) LAN 10.3.3.0/24 [SRV-DC 10.3.3.10, PC-DC-L 10.3.3.11]. ' +
      'WAN /30: HQ-BR 172.16.12.0, HQ-DC 172.16.13.0, BR-DC 172.16.23.0. Routage statique inter-sites.',
  };

  return { rhq, rbr, rdc, swhq, swbr, swdc, lhq, whq, wbr, lbr, srvdc, ldc, topology };
}

async function run(dev: DeviceLike, cmds: string[]): Promise<void> {
  for (const c of cmds) {
    try { await dev.executeCommand(c); } catch { /* best-effort init */ }
  }
}

export async function initializeWAN(wan: EnterpriseWAN): Promise<void> {
  const { rhq, rbr, rdc, swhq, swbr, swdc, lhq, whq, wbr, lbr, srvdc, ldc } = wan;

  await run(rhq, [
    'enable', 'configure terminal',
    'hostname R-HQ',
    'service timestamps log datetime msec',
    'logging buffered 32768',
    'logging console informational',
    'interface GigabitEthernet0/0', 'description LAN-HQ',
    `ip address ${SITE.hq.gw} ${SITE.hq.mask}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'description WAN-to-R-BR',
    `ip address ${WAN.hqbr.hq} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'description WAN-to-R-DC',
    `ip address ${WAN.hqdc.hq} 255.255.255.252`, 'no shutdown', 'exit',
    `ip route ${SITE.br.lan.split('/')[0]} ${SITE.br.mask} ${WAN.hqbr.br}`,
    `ip route ${SITE.dc.lan.split('/')[0]} ${SITE.dc.mask} ${WAN.hqdc.dc}`,
    `ip route ${WAN.brdc.net.split('/')[0]} 255.255.255.252 ${WAN.hqbr.br}`,
    'end',
  ]);

  await run(rdc, [
    'enable', 'configure terminal',
    'hostname R-DC',
    'service timestamps log datetime msec',
    'logging buffered 32768',
    'logging console informational',
    'interface GigabitEthernet0/0', 'description LAN-DC',
    `ip address ${SITE.dc.gw} ${SITE.dc.mask}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'description WAN-to-R-HQ',
    `ip address ${WAN.hqdc.dc} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'description WAN-to-R-BR',
    `ip address ${WAN.brdc.dc} 255.255.255.252`, 'no shutdown', 'exit',
    `ip route ${SITE.hq.lan.split('/')[0]} ${SITE.hq.mask} ${WAN.hqdc.hq}`,
    `ip route ${SITE.br.lan.split('/')[0]} ${SITE.br.mask} ${WAN.brdc.br}`,
    `ip route ${WAN.hqbr.net.split('/')[0]} 255.255.255.252 ${WAN.hqdc.hq}`,
    'end',
  ]);

  await run(rbr, [
    'system-view',
    'sysname R-BR',
    'info-center enable',
    'info-center logbuffer',
    'interface GigabitEthernet0/0/0', 'description LAN-BR',
    `ip address ${SITE.br.gw} ${SITE.br.mask}`, 'undo shutdown', 'quit',
    'interface GigabitEthernet0/0/1', 'description WAN-to-R-HQ',
    `ip address ${WAN.hqbr.br} 255.255.255.252`, 'undo shutdown', 'quit',
    'interface GigabitEthernet0/0/2', 'description WAN-to-R-DC',
    `ip address ${WAN.brdc.br} 255.255.255.252`, 'undo shutdown', 'quit',
    `ip route-static ${SITE.hq.lan.split('/')[0]} ${SITE.hq.mask} ${WAN.hqbr.hq}`,
    `ip route-static ${SITE.dc.lan.split('/')[0]} ${SITE.dc.mask} ${WAN.brdc.dc}`,
    `ip route-static ${WAN.hqdc.net.split('/')[0]} 255.255.255.252 ${WAN.hqbr.hq}`,
    'quit',
  ]);

  await run(swhq, [
    'enable', 'configure terminal',
    'hostname SW-HQ',
    'service timestamps log datetime msec',
    'logging buffered 16384',
    'interface FastEthernet0/1', 'no shutdown', 'exit',
    'interface FastEthernet0/2', 'no shutdown', 'exit',
    'interface FastEthernet0/3', 'no shutdown', 'exit',
    'end',
  ]);

  await run(swbr, [
    'system-view',
    'sysname SW-BR',
    'info-center enable',
    'quit',
  ]);

  await run(swdc, ['hostname SW-DC']);

  await run(lhq, [
    'ip link set eth0 up',
    `ip addr add ${SITE.hq.linux}/24 dev eth0`,
    `ip route add default via ${SITE.hq.gw}`,
  ]);
  await run(lbr, [
    'ip link set eth0 up',
    `ip addr add ${SITE.br.linux}/24 dev eth0`,
    `ip route add default via ${SITE.br.gw}`,
  ]);
  await run(srvdc, [
    'ip link set eth0 up',
    `ip addr add ${SITE.dc.srv}/24 dev eth0`,
    `ip route add default via ${SITE.dc.gw}`,
  ]);
  await run(ldc, [
    'ip link set eth0 up',
    `ip addr add ${SITE.dc.linux}/24 dev eth0`,
    `ip route add default via ${SITE.dc.gw}`,
  ]);

  await run(whq, [
    `netsh interface ip set address eth0 static ${SITE.hq.win} ${SITE.hq.mask} ${SITE.hq.gw}`,
  ]);
  await run(wbr, [
    `netsh interface ip set address eth0 static ${SITE.br.win} ${SITE.br.mask} ${SITE.br.gw}`,
  ]);

  // Warm the data path so the inter-site control plane and ARP caches settle.
  for (const probe of [SITE.br.gw, SITE.dc.gw, SITE.dc.srv, SITE.br.win]) {
    try { await lhq.executeCommand(`ping -c 1 ${probe}`); } catch { /* ignore */ }
  }
}

export async function dumpProtocol(
  label: string,
  topology: EnterpriseTopology,
  steps: readonly ProtoStepInput[],
  header?: string,
): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const lines: string[] = [];
  lines.push('============================================================');
  lines.push(`Network protocol debug transcript — ${label}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Topology: ${topology.note}`);
  if (header) lines.push(header);
  lines.push(`Total steps: ${steps.length}`);
  lines.push('============================================================');
  lines.push('');

  let index = 0;
  for (const entry of steps) {
    index += 1;
    const step: ProtoStep = typeof entry === 'string' ? { cmd: entry } : entry;
    const key = step.on ?? 'rhq';
    const dev = topology.devices[key];

    if (step.section) {
      lines.push('');
      lines.push(`--- [${index}] § ${step.section} ---`);
    }
    if (!dev) {
      lines.push(`[${index}/${steps.length}] (${key})> ${step.cmd}`);
      lines.push(`<UNKNOWN DEVICE '${key}'>`);
      lines.push('');
      continue;
    }

    const prompt = typeof dev.getPrompt === 'function' ? dev.getPrompt() : `${key}$`;
    lines.push(`[${index}/${steps.length}] ${key} ${prompt} ${step.cmd}`);

    let out: string | null = null;
    try {
      out = await dev.executeCommand(step.cmd);
    } catch (err) {
      lines.push(`<JS EXCEPTION> ${err instanceof Error ? err.message : String(err)}`);
      lines.push('');
      continue;
    }
    if (out === null || out === undefined) lines.push('<null>');
    else if (out === '') lines.push('<empty>');
    else for (const raw of String(out).split(/\r?\n/)) lines.push('  ' + raw);
    lines.push('');
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${label}_results_debug.txt`),
    lines.join('\n'),
    'utf8',
  );
}

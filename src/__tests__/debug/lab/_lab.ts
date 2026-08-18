import * as fs from 'node:fs';
import * as path from 'node:path';
import { vi } from 'vitest';
import type { Equipment } from '@/network';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getDefaultEventBus } from '@/events/EventBus';
import { pingOnSimulatedClock, isPingStep, canLendClock } from '../../support/fastPing';

const OUTPUT_DIR = path.resolve(__dirname, '../../../../debug-output/lab');

export type LabDeviceName =
  | 'Router1' | 'Router2' | 'Router3' | 'Router4' | 'Router5' | 'Router6'
  | 'Switch1' | 'Switch2' | 'Switch3' | 'Switch4'
  | 'PC1' | 'PC2' | 'Server1' | 'WinServer1';

export interface Lab {
  readonly Router1: CiscoRouter; readonly Router2: CiscoRouter; readonly Router3: CiscoRouter;
  readonly Router4: CiscoRouter; readonly Router5: CiscoRouter; readonly Router6: CiscoRouter;
  readonly Switch1: CiscoSwitch; readonly Switch2: CiscoSwitch;
  readonly Switch3: CiscoSwitch; readonly Switch4: CiscoSwitch;
  readonly PC1: WindowsPC; readonly PC2: WindowsPC;
  readonly Server1: LinuxServer; readonly WinServer1: WindowsServer;
  readonly devices: Record<string, Equipment>;
  readonly note: string;
}

export const LAB = {
  lan1: { net: '192.168.10.0', mask: '255.255.255.0', gw: '192.168.10.1', pc1: '192.168.10.2' },
  lan2: { net: '192.168.40.0', mask: '255.255.255.0', gw: '192.168.40.1', server1: '192.168.40.11' },
  wan: {
    r1r2: { net: '10.0.10.0', r1: '10.0.10.1', r2: '10.0.10.2' },
    r2r3: { net: '10.0.20.0', r2: '10.0.20.1', r3: '10.0.20.2' },
    r3r4: { net: '10.0.30.0', r3: '10.0.30.1', r4: '10.0.30.2' },
    r1r5: { net: '10.0.40.0', r5: '10.0.40.1', r1: '10.0.40.2' },
    r5r6: { net: '10.0.50.0', r5: '10.0.50.1', r6: '10.0.50.2' },
    r3r6: { net: '10.0.60.0', r6: '10.0.60.1', r3: '10.0.60.2' },
  },
  mask30: '255.255.255.252',
} as const;

const NOTE =
  'Lab « My Network » — 6 routeurs Cisco, 4 Catalyst, PC1 (Windows) et Server1 (Linux). ' +
  'LAN1 192.168.10.0/24 [PC1 .2] — Switch1 — Router1 Gi0/0 (passive OSPF) ; ' +
  'LAN2 192.168.40.0/24 [Server1 .11] — Switch2 — Router4 Gi0/1 ; ' +
  'coeur en /30 : R1-R2 10.0.10.0, R2-R3 10.0.20.0, R3-R4 10.0.30.0, ' +
  'R1-R5 10.0.40.0, R5-R6 10.0.50.0, R3-R6 10.0.60.0 ; OSPF process 1 partout, ' +
  'R3 déclare 10.0.20.0 et 10.0.30.0 en area 1 là où ses voisins R2 et R4 les déclarent en area 0.';

export function resetLab(): void {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-18T19:00:00Z'));
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
}

export function buildLab(): Lab {
  const Router1 = new CiscoRouter('Router1', 119, 238);
  const PC1 = new WindowsPC('windows-pc', 'PC1', 91, 65);
  const Router2 = new CiscoRouter('Router2', 361, 79);
  const Switch1 = new CiscoSwitch('switch-cisco', 'Switch1', 26, 213, 73);
  const Router3 = new CiscoRouter('Router3', 531, 83);
  const Router4 = new CiscoRouter('Router4', 670, 144);
  const Switch2 = new CiscoSwitch('switch-cisco', 'Switch2', 26, 809, 229);
  const Server1 = new LinuxServer('linux-server', 'Server1', 817, 421);
  const Router5 = new CiscoRouter('Router5', 307, 417);
  const Router6 = new CiscoRouter('Router6', 596, 432);
  const Switch3 = new CiscoSwitch('switch-cisco', 'Switch3', 26, 174, 503);
  const Switch4 = new CiscoSwitch('switch-cisco', 'Switch4', 26, 682, 610);
  const WinServer1 = new WindowsServer('WinServer1', 491, 654);
  const PC2 = new WindowsPC('windows-pc', 'PC2', 823, 653);

  const wire = (id: string, a: Equipment, ap: string, b: Equipment, bp: string) => {
    const portA = a.getPort(ap);
    const portB = b.getPort(bp);
    if (!portA) throw new Error(`${a.getName()} n'a pas de port ${ap}`);
    if (!portB) throw new Error(`${b.getName()} n'a pas de port ${bp}`);
    new Cable(id).connect(portA, portB);
  };

  wire('pc1-sw1', PC1, 'eth0', Switch1, 'FastEthernet0/1');
  wire('sw1-r1', Switch1, 'FastEthernet0/2', Router1, 'GigabitEthernet0/0');
  wire('r1-r2', Router1, 'GigabitEthernet0/1', Router2, 'GigabitEthernet0/0');
  wire('r2-r3', Router2, 'GigabitEthernet0/1', Router3, 'GigabitEthernet0/0');
  wire('r3-r4', Router3, 'GigabitEthernet0/1', Router4, 'GigabitEthernet0/0');
  wire('r1-r5', Router1, 'GigabitEthernet0/2', Router5, 'GigabitEthernet0/0');
  wire('r5-r6', Router5, 'GigabitEthernet0/1', Router6, 'GigabitEthernet0/1');
  wire('r6-r3', Router6, 'GigabitEthernet0/0', Router3, 'GigabitEthernet0/2');
  wire('r4-sw2', Router4, 'GigabitEthernet0/1', Switch2, 'FastEthernet0/1');
  wire('sw2-srv1', Switch2, 'FastEthernet0/2', Server1, 'eth0');
  wire('r5-sw3', Router5, 'GigabitEthernet0/2', Switch3, 'FastEthernet0/1');
  wire('r6-sw4', Router6, 'GigabitEthernet0/2', Switch4, 'FastEthernet0/1');
  wire('sw4-winsrv1', Switch4, 'FastEthernet0/2', WinServer1, 'eth0');
  wire('sw4-pc2', Switch4, 'FastEthernet0/3', PC2, 'eth0');

  const devices: Record<string, Equipment> = {
    Router1, Router2, Router3, Router4, Router5, Router6,
    Switch1, Switch2, Switch3, Switch4,
    PC1, PC2, Server1, WinServer1,
  };

  const bus = getDefaultEventBus();
  for (const device of Object.values(devices)) device.setEventBus?.(bus);

  return {
    Router1, Router2, Router3, Router4, Router5, Router6,
    Switch1, Switch2, Switch3, Switch4,
    PC1, PC2, Server1, WinServer1,
    devices, note: NOTE,
  };
}

export async function run(device: Equipment, cmds: readonly string[]): Promise<void> {
  const cli = device as unknown as { executeCommand(c: string): Promise<string> };
  for (const cmd of cmds) {
    await cli.executeCommand(cmd);
  }
}

const LAB_USERS = [
  'username alice privilege 1 secret alice',
  'username bob privilege 1 secret bob',
  'username carl privilege 1 secret carl',
  'username dave privilege 1 secret dave',
];

const routerPreamble = (hostname: string): string[] => ([
  'enable',
  'configure terminal',
  `hostname ${hostname}`,
  'service timestamps debug datetime msec',
  'service timestamps log datetime msec',
  ...LAB_USERS,
]);

export async function configureLab(lab: Lab): Promise<void> {
  await run(lab.Router1, [
    ...routerPreamble('Router1'),
    'logging buffered 6400 debugging',
    'interface GigabitEthernet0/0',
    ` ip address ${LAB.lan1.gw} ${LAB.lan1.mask}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    ` ip address ${LAB.wan.r1r2.r1} ${LAB.mask30}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/2',
    ` ip address ${LAB.wan.r1r5.r1} ${LAB.mask30}`, 'no shutdown', 'exit',
    `ip dhcp excluded-address ${LAB.lan1.gw}`,
    'ip dhcp pool LAB1',
    ` network ${LAB.lan1.net} ${LAB.lan1.mask}`,
    ` default-router ${LAB.lan1.gw}`,
    ' dns-server 5.5.5.5',
    ' lease 5',
    'exit',
    'router ospf 1',
    ' router-id 192.168.10.1',
    ` network ${LAB.lan1.net} 0.0.0.255 area 0`,
    ` network ${LAB.wan.r1r2.net} 0.0.0.3 area 0`,
    ` network ${LAB.wan.r1r5.net} 0.0.0.3 area 0`,
    ' passive-interface GigabitEthernet0/0',
    'exit',
    'end',
  ]);

  await run(lab.Router2, [
    ...routerPreamble('Router2'),
    'interface GigabitEthernet0/0',
    ` ip address ${LAB.wan.r1r2.r2} ${LAB.mask30}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    ` ip address ${LAB.wan.r2r3.r2} ${LAB.mask30}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'no ip address', 'exit',
    'router ospf 1',
    ' router-id 10.0.20.1',
    ` network ${LAB.wan.r1r2.net} 0.0.0.3 area 0`,
    ` network ${LAB.wan.r2r3.net} 0.0.0.3 area 0`,
    'exit',
    'end',
  ]);

  await run(lab.Router3, [
    ...routerPreamble('Router3'),
    'interface GigabitEthernet0/0',
    ` ip address ${LAB.wan.r2r3.r3} ${LAB.mask30}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    ` ip address ${LAB.wan.r3r4.r3} ${LAB.mask30}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/2',
    ` ip address ${LAB.wan.r3r6.r3} ${LAB.mask30}`, 'no shutdown', 'exit',
    'router ospf 1',
    ' router-id 10.0.30.1',
    ` network ${LAB.wan.r2r3.net} 0.0.0.3 area 1`,
    ` network ${LAB.wan.r3r4.net} 0.0.0.3 area 1`,
    ` network ${LAB.wan.r3r6.net} 0.0.0.3 area 0`,
    'exit',
    'end',
  ]);

  await run(lab.Router4, [
    ...routerPreamble('Router4'),
    'interface GigabitEthernet0/0',
    ` ip address ${LAB.wan.r3r4.r4} ${LAB.mask30}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    ` ip address ${LAB.lan2.gw} ${LAB.lan2.mask}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'no ip address', 'exit',
    `ip dhcp excluded-address ${LAB.lan2.gw} 192.168.40.10`,
    'ip dhcp pool LAB2',
    ` network ${LAB.lan2.net} ${LAB.lan2.mask}`,
    ` default-router ${LAB.lan2.gw}`,
    ' dns-server 4.4.4.4',
    ' lease 4',
    'exit',
    'router ospf 1',
    ' router-id 192.168.40.1',
    ` network ${LAB.wan.r3r4.net} 0.0.0.3 area 0`,
    ` network ${LAB.lan2.net} 0.0.0.255 area 0`,
    'exit',
    'end',
  ]);

  await run(lab.Router5, [
    ...routerPreamble('Router5'),
    'interface GigabitEthernet0/0',
    ` ip address ${LAB.wan.r1r5.r5} ${LAB.mask30}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    ` ip address ${LAB.wan.r5r6.r5} ${LAB.mask30}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'no ip address', 'exit',
    'router ospf 1',
    ' router-id 10.0.50.1',
    ` network ${LAB.wan.r1r5.net} 0.0.0.3 area 0`,
    ` network ${LAB.wan.r5r6.net} 0.0.0.3 area 0`,
    'exit',
    'end',
  ]);

  await run(lab.Router6, [
    ...routerPreamble('Router6'),
    'interface GigabitEthernet0/0',
    ` ip address ${LAB.wan.r3r6.r6} ${LAB.mask30}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/1',
    ` ip address ${LAB.wan.r5r6.r6} ${LAB.mask30}`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/2', 'no ip address', 'exit',
    'router ospf 1',
    ' router-id 10.0.60.1',
    ` network ${LAB.wan.r3r6.net} 0.0.0.3 area 0`,
    ` network ${LAB.wan.r5r6.net} 0.0.0.3 area 0`,
    'exit',
    'end',
  ]);

  for (const [sw, name] of [
    [lab.Switch1, 'Switch1'], [lab.Switch2, 'Switch2'],
    [lab.Switch3, 'Switch3'], [lab.Switch4, 'Switch4'],
  ] as const) {
    await run(sw, ['enable', 'configure terminal', `hostname ${name}`, 'end']);
  }

  await run(lab.PC1, ['ipconfig /renew']);
  await run(lab.Server1, ['dhclient eth0']);
}

export async function loadLab(): Promise<Lab> {
  const lab = buildLab();
  await configureLab(lab);
  return lab;
}

export interface LabStep {
  readonly section?: string;
  readonly on?: LabDeviceName;
  readonly cmd: string;
}
export type LabStepInput = string | LabStep;

export async function dumpLab(
  label: string,
  lab: Lab,
  steps: readonly LabStepInput[],
  header?: string,
): Promise<string> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const lines: string[] = [];
  lines.push('============================================================');
  lines.push(`Lab « My Network » — transcription de diagnostic : ${label}`);
  lines.push(`Générée : ${new Date().toISOString()}`);
  lines.push(`Topologie : ${lab.note}`);
  if (header) lines.push(header);
  lines.push(`Étapes : ${steps.length}`);
  lines.push('============================================================');
  lines.push('');

  let current: LabDeviceName = 'PC1';
  let index = 0;
  for (const entry of steps) {
    index += 1;
    const step: LabStep = typeof entry === 'string' ? { cmd: entry } : entry;
    if (step.on) current = step.on;
    const device = lab.devices[current] as unknown as {
      executeCommand(cmd: string): Promise<string>;
      getPrompt?(): string;
    } | undefined;

    if (step.section) {
      lines.push('');
      lines.push(`--- [${index}] § ${step.section} ---`);
    }
    if (!device) {
      lines.push(`[${index}/${steps.length}] (${current})> ${step.cmd}`);
      lines.push(`<ÉQUIPEMENT INCONNU '${current}'>`);
      lines.push('');
      continue;
    }

    const prompt = typeof device.getPrompt === 'function' ? device.getPrompt() : `${current}$`;
    lines.push(`[${index}/${steps.length}] ${current} ${prompt} ${step.cmd}`);

    let out: string | null = null;
    try {
      out = isPingStep(step.cmd) && canLendClock(device)
        ? await pingOnSimulatedClock(device as never, step.cmd)
        : await device.executeCommand(step.cmd);
    } catch (err) {
      lines.push(`<EXCEPTION JS> ${err instanceof Error ? err.message : String(err)}`);
      lines.push('');
      continue;
    }
    if (out === null || out === undefined) lines.push('<null>');
    else if (out === '') lines.push('<vide>');
    else for (const raw of String(out).split(/\r?\n/)) lines.push('  ' + raw);
    lines.push('');
  }

  const text = lines.join('\n');
  fs.writeFileSync(path.join(OUTPUT_DIR, `${label}_results_debug.txt`), text, 'utf8');
  return text;
}

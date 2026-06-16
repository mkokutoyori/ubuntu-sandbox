import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Equipment } from '@/network';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const OUTPUT_DIR = path.resolve(__dirname, '../../../../debug-output/cisco-l2');

export function resetSim(): void {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
}

export interface L2Step {
  readonly section?: string;
  readonly on?: string;
  readonly cmd: string;
}
export type L2StepInput = string | L2Step;

interface DeviceLike {
  executeCommand(cmd: string): Promise<string>;
  getPrompt?(): string;
}

export interface L2Topology {
  readonly devices: Record<string, DeviceLike>;
  readonly note: string;
  readonly defaultDevice: string;
}

export interface L2Lab {
  sw1: CiscoSwitch;
  sw2: CiscoSwitch;
  core: CiscoSwitch;
  l1: LinuxPC; w1: WindowsPC; srv1: LinuxServer;
  l2: LinuxPC; w2: WindowsPC; srv2: LinuxServer;
  topology: L2Topology;
}

export interface BuildOptions {
  readonly defaultDevice?: string;
  readonly configureHostIps?: boolean;
}

export async function buildLan(opts: BuildOptions = {}): Promise<L2Lab> {
  const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 26, 120, 120);
  const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 26, 120, 480);
  const core = new CiscoSwitch('switch-cisco', 'CORE', 26, 480, 300);

  const l1 = new LinuxPC('linux-pc', 'L1', 0, 60);
  const w1 = new WindowsPC('windows-pc', 'W1', 0, 120);
  const srv1 = new LinuxServer('linux-server', 'SRV1', 0, 180);
  const l2 = new LinuxPC('linux-pc', 'L2', 0, 420);
  const w2 = new WindowsPC('windows-pc', 'W2', 0, 480);
  const srv2 = new LinuxServer('linux-server', 'SRV2', 0, 540);

  const wire = (id: string, a: Equipment, ap: string, b: Equipment, bp: string) => {
    new Cable(id).connect(a.getPort(ap)!, b.getPort(bp)!);
  };

  wire('sw1-l1', l1, 'eth0', sw1, 'FastEthernet0/1');
  wire('sw1-w1', w1, 'eth0', sw1, 'FastEthernet0/2');
  wire('sw1-srv1', srv1, 'eth0', sw1, 'FastEthernet0/3');
  wire('sw2-l2', l2, 'eth0', sw2, 'FastEthernet0/1');
  wire('sw2-w2', w2, 'eth0', sw2, 'FastEthernet0/2');
  wire('sw2-srv2', srv2, 'eth0', sw2, 'FastEthernet0/3');
  wire('sw1-core', sw1, 'GigabitEthernet0/1', core, 'GigabitEthernet0/1');
  wire('sw2-core', sw2, 'GigabitEthernet0/1', core, 'GigabitEthernet0/0');

  const trunkUp = async (sw: CiscoSwitch, ports: string[]) => {
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    for (const p of ports) {
      await sw.executeCommand(`interface ${p}`);
      await sw.executeCommand('switchport trunk encapsulation dot1q');
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('exit');
    }
    await sw.executeCommand('end');
    await sw.executeCommand('disable');
  };
  await trunkUp(sw1, ['GigabitEthernet0/1']);
  await trunkUp(sw2, ['GigabitEthernet0/1']);
  await trunkUp(core, ['GigabitEthernet0/0', 'GigabitEthernet0/1']);

  if (opts.configureHostIps !== false) {
    const mask = '255.255.255.0';
    await l1.executeCommand(`ifconfig eth0 192.168.1.11 netmask ${mask}`);
    await srv1.executeCommand(`ifconfig eth0 192.168.1.13 netmask ${mask}`);
    await l2.executeCommand(`ifconfig eth0 192.168.1.21 netmask ${mask}`);
    await srv2.executeCommand(`ifconfig eth0 192.168.1.23 netmask ${mask}`);
    w1.configureInterface('eth0', new IPAddress('192.168.1.12'), new SubnetMask(mask));
    w2.configureInterface('eth0', new IPAddress('192.168.1.22'), new SubnetMask(mask));
  }

  return {
    sw1, sw2, core, l1, w1, srv1, l2, w2, srv2,
    topology: {
      defaultDevice: opts.defaultDevice ?? 'sw1',
      devices: { sw1, sw2, core, l1, w1, srv1, l2, w2, srv2 },
      note:
        'CORE(L2) trunked to SW1 & SW2 (L2 access). ' +
        'SW1: L1(Linux 1.11) Fa0/1, W1(Win 1.12) Fa0/2, SRV1(Linux 1.13) Fa0/3, Gi0/1=trunk. ' +
        'SW2: L2(Linux 1.21) Fa0/1, W2(Win 1.22) Fa0/2, SRV2(Linux 1.23) Fa0/3, Gi0/1=trunk. ' +
        'All hosts 192.168.1.0/24.',
    },
  };
}

export async function dumpL2(
  label: string,
  topology: L2Topology,
  steps: readonly L2StepInput[],
  header?: string,
): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const lines: string[] = [];
  lines.push('============================================================');
  lines.push(`Cisco L2 switch debug transcript — ${label}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Topology: ${topology.note}`);
  if (header) lines.push(header);
  lines.push(`Total steps: ${steps.length}`);
  lines.push('============================================================');
  lines.push('');

  let index = 0;
  for (const entry of steps) {
    index += 1;
    const step: L2Step = typeof entry === 'string' ? { cmd: entry } : entry;
    const key = step.on ?? topology.defaultDevice;
    const dev = topology.devices[key];

    if (step.section) {
      lines.push('');
      lines.push(`--- [${index}] § ${step.section} ---`);
    }
    if (step.cmd === undefined || step.cmd === '') {
      continue;
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
    lines.join('\n'), 'utf8',
  );
}

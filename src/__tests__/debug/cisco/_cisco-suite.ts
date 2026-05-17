/**
 * Cisco switch debug suites — same gap-analysis approach as the Huawei
 * ones: build a small L2 LAN (Cisco Catalyst-style switch + Linux/
 * Windows hosts), replay 60+ CLI / scenario steps, dump the transcript
 * to `debug-output/cisco/<label>_results_debug.txt`.
 *
 * Cisco switches are pure Layer-2 in this project (no routing).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Equipment } from '@/network';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const OUTPUT_DIR = path.resolve(__dirname, '../../../../debug-output/cisco');

export function resetSim(): void {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
}

export interface CiscoStep {
  readonly section?: string;
  readonly on?: string;
  readonly cmd: string;
}
export type CiscoStepInput = string | CiscoStep;

interface DeviceLike {
  executeCommand(cmd: string): Promise<string>;
  getPrompt?(): string;
}

export interface CiscoTopology {
  readonly devices: Record<string, DeviceLike>;
  readonly note: string;
}

export interface DumpOptions {
  /** Re-sync the switch to global-config view at each section start. */
  resyncSwitchPerSection?: boolean;
}

/**
 * Lab: Catalyst-style switch (Fa0/0..23, Gi0/0..) with a Linux PC on
 * Fa0/1, a Windows PC on Fa0/2, a 2nd Linux on Fa0/3, a 2nd Windows
 * on Fa0/10 (cross-VLAN tests).
 */
export function buildLab(): {
  sw: CiscoSwitch;
  linux1: LinuxPC; win1: WindowsPC; linux2: LinuxPC; win2: WindowsPC;
  topology: CiscoTopology;
} {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 26, 300, 200);
  const linux1 = new LinuxPC('linux-pc', 'L1', 80, 80);
  const win1 = new WindowsPC('windows-pc', 'W1', 520, 80);
  const linux2 = new LinuxPC('linux-pc', 'L2', 80, 320);
  const win2 = new WindowsPC('windows-pc', 'W2', 520, 320);

  const wire = (id: string, host: Equipment, hp: string, sp: string) => {
    new Cable(id).connect(host.getPort(hp)!, sw.getPort(sp)!);
  };
  wire('c1', linux1, 'eth0', 'FastEthernet0/1');
  wire('c2', win1,   'eth0', 'FastEthernet0/2');
  wire('c3', linux2, 'eth0', 'FastEthernet0/3');
  wire('c4', win2,   'eth0', 'FastEthernet0/10');

  return {
    sw, linux1, win1, linux2, win2,
    topology: {
      devices: { sw, linux1, win1, linux2, win2 },
      note:
        'SW1 (Cisco Catalyst, 26 ports) — L1(Linux) Fa0/1, W1(Windows) Fa0/2, ' +
        'L2(Linux) Fa0/3, W2(Windows) Fa0/10',
    },
  };
}

export async function dumpCisco(
  label: string,
  topology: CiscoTopology,
  steps: readonly CiscoStepInput[],
  header?: string,
  options: DumpOptions = {},
): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const lines: string[] = [];
  lines.push('============================================================');
  lines.push(`Cisco switch debug transcript — ${label}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Topology: ${topology.note}`);
  if (header) lines.push(header);
  lines.push(`Total steps: ${steps.length}`);
  lines.push('============================================================');
  lines.push('');

  let index = 0;
  for (const entry of steps) {
    index += 1;
    const step: CiscoStep = typeof entry === 'string' ? { cmd: entry } : entry;
    const key = step.on ?? 'sw';
    const dev = topology.devices[key];

    if (step.section) {
      lines.push('');
      lines.push(`--- [${index}] § ${step.section} ---`);
      if (options.resyncSwitchPerSection) {
        const sw = topology.devices['sw'];
        if (sw) {
          // Reset to a known base so an intended rejection can't
          // cascade into the next section. Skip the redundant tail
          // when the section's own first switch step already does it.
          const c = (step.on ?? 'sw') === 'sw' ? step.cmd.trim().toLowerCase() : '';
          try {
            await sw.executeCommand('end');
            if (c !== 'enable' && c !== 'en' && !/^conf/.test(c)) {
              await sw.executeCommand('enable');
            }
            if (!/^conf/.test(c)) await sw.executeCommand('configure terminal');
          } catch { /* best effort */ }
        }
      }
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

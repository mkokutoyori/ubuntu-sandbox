/**
 * Shared scaffold for the Huawei switch debug suites.
 *
 * Each suite builds a small LAN (Huawei S-series switch + Linux/Windows
 * end-hosts), replays a list of CLI commands / scenario steps, and dumps
 * the transcript under `debug-output/huawei/<label>_results_debug.txt`.
 *
 * As with the other debug suites, we deliberately throw realistic and
 * complex command sequences at the device WITHOUT first checking what is
 * implemented — the resulting transcript is what tells us which Huawei
 * VRP features are missing or wrong.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Equipment } from '@/network';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const OUTPUT_DIR = path.resolve(__dirname, '../../../../debug-output/huawei');

export function resetSim(): void {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
}

/** One scenario step. `on` selects the target device (default 'sw'). */
export interface HuaweiStep {
  readonly section?: string;
  readonly on?: string;
  readonly cmd: string;
}
export type HuaweiStepInput = string | HuaweiStep;

interface DeviceLike {
  executeCommand(cmd: string): Promise<string>;
  getPrompt?(): string;
}

export interface HuaweiTopology {
  /** Logical name → device. The switch is conventionally keyed 'sw'. */
  readonly devices: Record<string, DeviceLike>;
  /** Human description of the wiring, printed in the transcript header. */
  readonly note: string;
}

/**
 * Build the canonical lab: one 24-port Huawei switch with a Linux PC on
 * G0/0/1, a Windows PC on G0/0/2, a second Linux PC on G0/0/3 and a
 * second Windows PC on G0/0/10 (cross-VLAN tests). Returns the devices
 * plus an already-cabled topology.
 */
export function buildLab(): {
  sw: HuaweiSwitch;
  linux1: LinuxPC;
  win1: WindowsPC;
  linux2: LinuxPC;
  win2: WindowsPC;
  topology: HuaweiTopology;
} {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24, 300, 200);
  const linux1 = new LinuxPC('linux-pc', 'L1', 80, 80);
  const win1 = new WindowsPC('windows-pc', 'W1', 520, 80);
  const linux2 = new LinuxPC('linux-pc', 'L2', 80, 320);
  const win2 = new WindowsPC('windows-pc', 'W2', 520, 320);

  const wire = (id: string, host: Equipment, hostPort: string, swPort: string) => {
    const c = new Cable(id);
    c.connect(host.getPort(hostPort)!, sw.getPort(swPort)!);
  };
  wire('c1', linux1, 'eth0', 'GigabitEthernet0/0/1');
  wire('c2', win1,   'eth0', 'GigabitEthernet0/0/2');
  wire('c3', linux2, 'eth0', 'GigabitEthernet0/0/3');
  wire('c4', win2,   'eth0', 'GigabitEthernet0/0/10');

  return {
    sw, linux1, win1, linux2, win2,
    topology: {
      devices: { sw, linux1, win1, linux2, win2 },
      note:
        'SW1 (Huawei S5720, 24 ports) — L1(Linux) g0/0/1, W1(Windows) g0/0/2, ' +
        'L2(Linux) g0/0/3, W2(Windows) g0/0/10',
    },
  };
}

/**
 * Replay `steps` against the given topology and write the transcript.
 * The switch prompt is captured before each switch command so CLI mode
 * transitions (<SW1> → [SW1] → [SW1-GigabitEthernet0/0/1]) are visible.
 */
export async function dumpHuawei(
  label: string,
  topology: HuaweiTopology,
  steps: readonly HuaweiStepInput[],
  header?: string,
): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const lines: string[] = [];
  lines.push('============================================================');
  lines.push(`Huawei switch debug transcript — ${label}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Topology: ${topology.note}`);
  if (header) lines.push(header);
  lines.push(`Total steps: ${steps.length}`);
  lines.push('============================================================');
  lines.push('');

  let index = 0;
  for (const entry of steps) {
    index += 1;
    const step: HuaweiStep = typeof entry === 'string' ? { cmd: entry } : entry;
    const key = step.on ?? 'sw';
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

    const prompt = typeof dev.getPrompt === 'function'
      ? dev.getPrompt()
      : `${key}$`;
    lines.push(`[${index}/${steps.length}] ${key} ${prompt} ${step.cmd}`);

    let out: string | null = null;
    try {
      out = await dev.executeCommand(step.cmd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`<JS EXCEPTION> ${msg}`);
      lines.push('');
      continue;
    }
    if (out === null || out === undefined) {
      lines.push('<null>');
    } else if (out === '') {
      lines.push('<empty>');
    } else {
      for (const raw of String(out).split(/\r?\n/)) lines.push('  ' + raw);
    }
    lines.push('');
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${label}_results_debug.txt`),
    lines.join('\n'),
    'utf8',
  );
}

/**
 * Shared scaffold for the router (L3) debug suites.
 *
 * Each suite builds a small *routed* topology — two routers connected
 * back-to-back over a WAN link, each with an end-host on its own LAN
 * subnet — replays a list of CLI commands / scenario steps, and dumps
 * the transcript under `debug-output/router/<label>_results_debug.txt`.
 *
 * As with the switch suites, we deliberately throw realistic and
 * complex command sequences at the device WITHOUT first checking what
 * is implemented — the resulting transcript is what tells us which
 * Cisco IOS / Huawei VRP router features are missing or wrong.
 *
 *   Cisco lab:                       Huawei lab:
 *     L1 ── Gi0/0 [R1] Gi0/1 ─┐        L1 ── GE0/0/1 [R1] GE0/0/0 ─┐
 *                             │                                   │
 *     W1 ── Gi0/0 [R2] Gi0/1 ─┘        W1 ── GE0/0/1 [R2] GE0/0/0 ─┘
 *
 *   R1 LAN 192.168.1.0/24, R2 LAN 192.168.2.0/24, WAN 10.0.0.0/30.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Equipment } from '@/network';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const OUTPUT_DIR = path.resolve(__dirname, '../../../../debug-output/router');

export function resetSim(): void {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
}

/** Repeat-helper: map 1..n through fn and flatten the result. */
export function sweep<T>(n: number, fn: (i: number) => T | T[]): T[] {
  const out: T[] = [];
  for (let i = 1; i <= n; i++) {
    const v = fn(i);
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out;
}

/** Map each element of `items` through fn and flatten. */
export function each<I, T>(items: readonly I[], fn: (it: I, idx: number) => T | T[]): T[] {
  const out: T[] = [];
  items.forEach((it, idx) => {
    const v = fn(it, idx);
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  });
  return out;
}

/**
 * A large vendor-appropriate "regression sweep" appended to every
 * router suite so each transcript exercises ≥300 commands and the
 * common show / negation / mode-nav / pipe / help surface is always
 * re-checked alongside the suite's focused topic. ~140 steps.
 */
export function regressionSweep(vendor: 'cisco' | 'huawei'): RouterStepInput[] {
  if (vendor === 'cisco') {
    const SHOW = [
      'show version', 'show running-config', 'show startup-config',
      'show ip interface brief', 'show interfaces', 'show ip route',
      'show ip route summary', 'show ip protocols', 'show ip arp',
      'show arp', 'show ip ospf', 'show ip ospf neighbor',
      'show ip ospf database', 'show ip ospf interface brief',
      'show ip eigrp neighbors', 'show ip eigrp topology',
      'show ip bgp', 'show ip bgp summary', 'show ip rip database',
      'show ip nat translations', 'show ip nat statistics',
      'show ip dhcp binding', 'show ip dhcp pool', 'show access-lists',
      'show ip access-lists', 'show crypto isakmp sa',
      'show crypto ipsec sa', 'show crypto session', 'show crypto map',
      'show standby brief', 'show vrrp brief', 'show track',
      'show ip sla statistics', 'show policy-map interface',
      'show logging', 'show snmp', 'show ntp status',
      'show ntp associations', 'show clock', 'show cdp neighbors',
      'show lldp neighbors', 'show processes cpu', 'show memory statistics',
      'show flash', 'show users', 'show history', 'show ip cef',
      'show interfaces GigabitEthernet0/0', 'show interfaces GigabitEthernet0/1',
      'show ip interface GigabitEthernet0/1', 'show controllers',
      'show tech-support', 'show inventory', 'show environment',
      'show redundancy', 'show ip vrf', 'show vrf', 'show hosts',
      'show ip ssh', 'show line', 'show terminal', 'show aliases',
    ];
    const NEG = [
      'ip routing', 'ip cef', 'cdp run', 'lldp run', 'ip domain-lookup',
      'ip http server', 'ip source-route', 'service pad',
      'ipv6 unicast-routing', 'service password-encryption',
    ];
    return [
      { section: 'regression: show family', cmd: 'enable' },
      ...each(SHOW, (c) => c),
      { section: 'regression: pipe filters', cmd: 'show running-config | include router' },
      'show running-config | section interface',
      'show running-config | begin line',
      'show running-config | exclude !',
      'show ip route | include via',
      'show ip interface brief | exclude unassigned',
      { section: 'regression: mode nav + negation', cmd: 'configure terminal' },
      ...each(NEG, (c) => [`no ${c}`, c]),
      'interface GigabitEthernet0/0',
      'do show ip interface brief',
      'shutdown',
      'no shutdown',
      'exit',
      'router ospf 1',
      'do show ip protocols',
      'exit',
      'line vty 0 4',
      'exit',
      'end',
      { section: 'regression: context help', cmd: 'configure terminal' },
      'interface ?',
      'ip ?',
      'router ?',
      'crypto ?',
      'no ?',
      'end',
      'show running-config | count !',
      'write memory',
    ];
  }
  const DISPLAY = [
    'display version', 'display current-configuration',
    'display saved-configuration', 'display ip interface brief',
    'display interface', 'display ip routing-table',
    'display ip routing-table statistics', 'display arp',
    'display arp all', 'display ospf peer', 'display ospf interface',
    'display ospf routing', 'display ospf lsdb', 'display ospf brief',
    'display rip', 'display rip 1 route', 'display bgp peer',
    'display bgp routing-table', 'display nat session all',
    'display nat address-group', 'display ip pool', 'display acl all',
    'display dhcp server statistics', 'display vrrp', 'display vrrp brief',
    'display ike sa', 'display ipsec sa', 'display ipsec policy',
    'display ipsec proposal', 'display ike proposal', 'display ike peer',
    'display snmp-agent sys-info', 'display ntp status',
    'display ntp session', 'display clock', 'display lldp neighbor',
    'display lldp neighbor brief', 'display cpu-usage',
    'display memory-usage', 'display device', 'display users',
    'display history-command', 'display logbuffer', 'display trapbuffer',
    'display alarm all', 'display startup', 'display patch-information',
    'display elabel', 'display license', 'display interface brief',
    'display ip interface GigabitEthernet0/0/0',
    'display interface GigabitEthernet0/0/0',
    'display this', 'display diagnostic-information',
    'display aaa configuration', 'display aaa online-fail-record',
    'display ssh server status', 'display ssh user-information',
    'display user-interface', 'display port-security',
  ];
  const UNDO = [
    'ip routing-table limit 1000', 'dhcp enable', 'snmp-agent',
    'ftp server enable', 'telnet server enable', 'info-center enable',
    'lldp enable', 'ntp-service enable', 'undo terminal monitor',
    'sysname TEST',
  ];
  return [
    { section: 'regression: display family', cmd: 'display version' },
    ...each(DISPLAY, (c) => c),
    { section: 'regression: pipe filters', cmd: 'display current-configuration | include ospf' },
    'display current-configuration | begin interface',
    'display current-configuration | exclude #',
    'display ip routing-table | include Direct',
    'display ip interface brief | include up',
    { section: 'regression: view nav + undo', cmd: 'system-view' },
    ...each(UNDO, (c) => [c, `undo ${c.replace(/^undo /, '')}`]),
    'interface GigabitEthernet0/0/0',
    'display this',
    'shutdown',
    'undo shutdown',
    'quit',
    'ospf 1',
    'display this',
    'quit',
    'user-interface vty 0 4',
    'quit',
    'return',
    { section: 'regression: context help', cmd: 'system-view' },
    'interface ?',
    'ip ?',
    'undo ?',
    'acl ?',
    'return',
    'save',
  ];
}

/** One scenario step. `on` selects the target device (default 'r1'). */
export interface RouterStep {
  readonly section?: string;
  readonly on?: string;
  readonly cmd: string;
}
export type RouterStepInput = string | RouterStep;

interface DeviceLike {
  executeCommand(cmd: string): Promise<string>;
  getPrompt?(): string;
}

export interface RouterTopology {
  /** Logical name → device. The primary router is keyed 'r1'. */
  readonly devices: Record<string, DeviceLike>;
  /** Human description of the wiring, printed in the transcript header. */
  readonly note: string;
}

/**
 * Build the canonical Cisco routed lab: two CiscoRouters back-to-back
 * over a WAN link, a Linux PC on R1's LAN and a Windows PC on R2's LAN.
 */
export function buildCiscoLab(): {
  r1: CiscoRouter; r2: CiscoRouter;
  linux1: LinuxPC; win1: WindowsPC;
  topology: RouterTopology;
} {
  const r1 = new CiscoRouter('R1', 200, 120);
  const r2 = new CiscoRouter('R2', 520, 120);
  const linux1 = new LinuxPC('linux-pc', 'L1', 40, 120);
  const win1 = new WindowsPC('windows-pc', 'W1', 700, 120);

  const wire = (id: string, a: Equipment, ap: string, b: Equipment, bp: string) => {
    new Cable(id).connect(a.getPort(ap)!, b.getPort(bp)!);
  };
  wire('c1', linux1, 'eth0', r1, 'GigabitEthernet0/0');
  wire('c2', r1, 'GigabitEthernet0/1', r2, 'GigabitEthernet0/1');
  wire('c3', r2, 'GigabitEthernet0/0', win1, 'eth0');

  return {
    r1, r2, linux1, win1,
    topology: {
      devices: { r1, r2, linux1, win1 },
      note:
        'R1(Cisco) Gi0/0=L1 LAN 192.168.1.0/24, Gi0/1=WAN 10.0.0.0/30; ' +
        'R2(Cisco) Gi0/0=W1 LAN 192.168.2.0/24, Gi0/1=WAN',
    },
  };
}

/**
 * Build the canonical Huawei routed lab: two HuaweiRouters back-to-back
 * over a WAN link, a Linux PC on R1's LAN and a Windows PC on R2's LAN.
 */
export function buildHuaweiLab(): {
  r1: HuaweiRouter; r2: HuaweiRouter;
  linux1: LinuxPC; win1: WindowsPC;
  topology: RouterTopology;
} {
  const r1 = new HuaweiRouter('R1', 200, 120);
  const r2 = new HuaweiRouter('R2', 520, 120);
  const linux1 = new LinuxPC('linux-pc', 'L1', 40, 120);
  const win1 = new WindowsPC('windows-pc', 'W1', 700, 120);

  const wire = (id: string, a: Equipment, ap: string, b: Equipment, bp: string) => {
    new Cable(id).connect(a.getPort(ap)!, b.getPort(bp)!);
  };
  wire('c1', linux1, 'eth0', r1, 'GE0/0/1');
  wire('c2', r1, 'GE0/0/0', r2, 'GE0/0/0');
  wire('c3', r2, 'GE0/0/1', win1, 'eth0');

  return {
    r1, r2, linux1, win1,
    topology: {
      devices: { r1, r2, linux1, win1 },
      note:
        'R1(Huawei) GE0/0/1=L1 LAN 192.168.1.0/24, GE0/0/0=WAN 10.0.0.0/30; ' +
        'R2(Huawei) GE0/0/1=W1 LAN 192.168.2.0/24, GE0/0/0=WAN',
    },
  };
}

export interface DumpOptions {
  /**
   * 'cisco' | 'huawei' — controls the per-section resync sequence used
   * to keep sections independent (so one *intended* rejection doesn't
   * cascade into the next section's commands).
   */
  resyncVendor?: 'cisco' | 'huawei';
}

export async function dumpRouter(
  label: string,
  topology: RouterTopology,
  steps: readonly RouterStepInput[],
  header?: string,
  options: DumpOptions = {},
): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const lines: string[] = [];
  lines.push('============================================================');
  lines.push(`Router (L3) debug transcript — ${label}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Topology: ${topology.note}`);
  if (header) lines.push(header);
  lines.push(`Total steps: ${steps.length}`);
  lines.push('============================================================');
  lines.push('');

  let index = 0;
  for (const entry of steps) {
    index += 1;
    const step: RouterStep = typeof entry === 'string' ? { cmd: entry } : entry;
    const key = step.on ?? 'r1';
    const dev = topology.devices[key];

    if (step.section) {
      lines.push('');
      lines.push(`--- [${index}] § ${step.section} ---`);
      if (options.resyncVendor) {
        const r1 = topology.devices['r1'];
        if (r1) {
          const first =
            (step.on ?? 'r1') === 'r1' ? step.cmd.trim().toLowerCase() : '';
          try {
            if (options.resyncVendor === 'cisco') {
              await r1.executeCommand('end');
              if (first !== 'enable' && first !== 'en' && !/^conf/.test(first)) {
                await r1.executeCommand('enable');
              }
              if (!/^conf/.test(first)) {
                await r1.executeCommand('configure terminal');
              }
            } else {
              await r1.executeCommand('return');
              if (!/^sys(tem-view)?$/.test(first)) {
                await r1.executeCommand('system-view');
              }
            }
          } catch { /* resync is best-effort */ }
        }
      }
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

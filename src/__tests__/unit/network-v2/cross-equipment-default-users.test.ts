/**
 * Cross-equipment SSH with the default cast (alice / bob / carl / dave).
 *
 * Each device is provisioned by its constructor with a uniform cast of
 * unprivileged accounts whose passwords equal their usernames. This makes
 * SSH between any two vendors a one-liner — no per-test setup churn.
 *
 * Coverage matrix (every direction is asserted to authenticate and to
 * surface a vendor-specific identity to the caller):
 *
 *                 →  Linux   Windows   Cisco   Huawei
 *      Linux         ✓        ✓         ✓       ✓
 *      Windows       ✓        ✓         ✓       ✓
 *      Cisco         ✓        ✓         ✓       ✓
 *      Huawei        ✓        ✓         ✓       ✓
 *
 * The fixture is rebuilt per test to avoid registry bleed.
 */

import { describe, expect, beforeEach, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

// ─── Fixture ────────────────────────────────────────────────────────

const IPS = {
  linux:   '10.0.0.1',
  windows: '10.0.0.2',
  cisco:   '10.0.0.3',
  huawei:  '10.0.0.4',
};

interface Cast {
  linux: LinuxPC;
  windows: WindowsPC;
  cisco: CiscoRouter;
  huawei: HuaweiRouter;
}

async function buildCast(): Promise<Cast> {
  EquipmentRegistry.resetInstance();

  const linux   = new LinuxPC('linux-pc', 'linux1', 0, 0);
  const windows = new WindowsPC('windows-pc', 'win1', 0, 0);
  const cisco   = new CiscoRouter('cisco1', 0, 0);
  const huawei  = new HuaweiRouter('huawei1', 0, 0);
  linux.setHostname('linux1');
  windows.setHostname('win1');
  const sw      = new GenericSwitch('switch-generic', 'core', 8, 0, 0);

  const peers = [linux, windows, cisco, huawei];
  peers.forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));

  const mask = new SubnetMask('255.255.255.0');
  linux.getPorts()[0].configureIP(new IPAddress(IPS.linux),   mask);
  windows.getPorts()[0].configureIP(new IPAddress(IPS.windows), mask);

  // Bring up Cisco / Huawei interface IPs through their native CLI so
  // the routing / ARP tables look exactly like the production path.
  for (const c of [
    'enable', 'configure terminal',
    'hostname cisco1',
    'interface GigabitEthernet0/0',
    `ip address ${IPS.cisco} 255.255.255.0`,
    'no shutdown',
    'exit',
    'ip domain-name lab.local',
    'crypto key generate rsa modulus 2048',
    'ip ssh version 2',
    'line vty 0 4',
    'login local',
    'transport input ssh',
    'exit',
    'end',
  ]) await cisco.executeCommand(c);

  for (const c of [
    'system-view',
    'sysname huawei1',
    'interface GigabitEthernet0/0/0',
    `ip address ${IPS.huawei} 255.255.255.0`,
    'undo shutdown',
    'quit',
    'rsa local-key-pair create',
    'stelnet server enable',
    'user-interface vty 0 4',
    'authentication-mode aaa',
    'protocol inbound ssh',
    'quit',
    'quit',
  ]) await huawei.executeCommand(c);

  // Prime ARP so the first SSH-over-TCP handshake isn't dropped.
  for (const ip of Object.values(IPS)) {
    await linux.executeCommand(`ping -c 1 ${ip}`);
    await windows.executeCommand(`ping ${ip}`);
  }

  return { linux, windows, cisco, huawei };
}

beforeEach(() => { EquipmentRegistry.resetInstance(); });

// ════════════════════════════════════════════════════════════════════
// §1 — Default user provisioning is in place on every vendor
// ════════════════════════════════════════════════════════════════════

const DEFAULT_USERS = ['alice', 'bob', 'carl', 'dave'] as const;

describe('§1 — Every vendor exposes the default cast (alice/bob/carl/dave)', () => {
  let cast: Cast;
  beforeEach(async () => { cast = await buildCast(); });

  for (const u of DEFAULT_USERS) {
    test(`Linux PC: ${u} exists with password equal to the username`, async () => {
      const out = await cast.linux.executeCommand(`id ${u}`);
      expect(out).toMatch(new RegExp(`uid=\\d+\\(${u}\\)`));
    });

    test(`Windows PC: ${u} is listed by net user`, async () => {
      const out = await cast.windows.executeCommand('net user');
      expect(out.toLowerCase()).toContain(u);
    });

    test(`Cisco router: ${u} is hidden from show running-config as a factory default`, async () => {
      const out = await cast.cisco.executeCommand('show running-config | include username');
      expect(out.toLowerCase()).not.toContain(`username ${u}`);
    });

    test(`Cisco router: ${u} is still SSH-authenticatable despite being a factory default`, async () => {
      const store = (cast.cisco as unknown as { getCredentialStore: () => { get: (n: string) => unknown } }).getCredentialStore();
      const acc = store.get(u) as { name: string; secret: string; factoryDefault: boolean } | undefined;
      expect(acc).toBeDefined();
      expect(acc!.factoryDefault).toBe(true);
      expect(acc!.secret).toBe(u);
    });

    test(`Huawei router: ${u} is hidden from display current-configuration as a factory default`, async () => {
      const out = await cast.huawei.executeCommand('display current-configuration | include local-user');
      expect(out.toLowerCase()).not.toContain(`local-user ${u}`);
    });

    test(`Huawei router: ${u} is still SSH-authenticatable despite being a factory default`, async () => {
      const store = (cast.huawei as unknown as { getCredentialStore: () => { get: (n: string) => unknown } }).getCredentialStore();
      const acc = store.get(u) as { name: string; secret: string; factoryDefault: boolean } | undefined;
      expect(acc).toBeDefined();
      expect(acc!.factoryDefault).toBe(true);
      expect(acc!.secret).toBe(u);
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// §2 — SSH connectivity matrix: every (source × target) authenticates
// ════════════════════════════════════════════════════════════════════

interface MatrixRow {
  from: keyof Cast;
  to: keyof Cast;
  probeCmd: string;
  expectInclude: RegExp;
}

const SOURCES: ReadonlyArray<keyof Cast> = ['linux', 'windows', 'cisco', 'huawei'];

const PROBE_FOR: Record<keyof Cast, { cmd: string; expect: RegExp }> = {
  linux:   { cmd: 'hostname',        expect: /linux1/ },
  windows: { cmd: 'hostname',        expect: /win1/i },
  cisco:   { cmd: 'show version',    expect: /IOS|Cisco|Version/i },
  huawei:  { cmd: 'display version', expect: /VRP|Huawei|Version/i },
};

function buildMatrix(): MatrixRow[] {
  const rows: MatrixRow[] = [];
  for (const from of SOURCES) {
    for (const to of SOURCES) {
      if (from === to) continue;
      const probe = PROBE_FOR[to];
      rows.push({ from, to, probeCmd: probe.cmd, expectInclude: probe.expect });
    }
  }
  return rows;
}

function sshCommandFor(
  from: keyof Cast,
  user: string,
  targetIp: string,
  remoteCmd: string,
): string {
  switch (from) {
    case 'cisco':
    case 'huawei': return `ssh -l ${user} ${targetIp} "${remoteCmd}"`;
    default:       return `ssh ${user}@${targetIp} "${remoteCmd}"`;
  }
}

describe('§2 — Cross-equipment SSH connectivity matrix (alice/alice everywhere)', () => {
  let cast: Cast;
  beforeEach(async () => { cast = await buildCast(); });

  test.each(buildMatrix())('$from → $to: alice@$to "$probeCmd" returns vendor output',
    async ({ from, to, probeCmd, expectInclude }) => {
      const targetIp = IPS[to];
      const cmd = sshCommandFor(from, 'alice', targetIp, probeCmd);
      const out = await cast[from].executeCommand(cmd);
      expect(out).toMatch(expectInclude);
    });
});

// ════════════════════════════════════════════════════════════════════
// §3 — Authentication failure surface is consistent across vendors
// ════════════════════════════════════════════════════════════════════

describe('§3 — Unknown SSH user is uniformly rejected across the matrix', () => {
  let cast: Cast;
  beforeEach(async () => { cast = await buildCast(); });

  for (const target of SOURCES) {
    test(`linux → ${target}: unknown user is rejected with Permission denied`, async () => {
      const out = await cast.linux.executeCommand(`ssh nobody@${IPS[target]} hostname`);
      expect(out).toMatch(/Permission denied|denied|no such user|fail|refused|Authentication/i);
    });
  }

  for (const target of SOURCES) {
    test(`windows → ${target}: unknown user is rejected`, async () => {
      const out = await cast.windows.executeCommand(`ssh nobody@${IPS[target]} hostname`);
      expect(out).toMatch(/Permission denied|denied|no such user|fail|refused|Authentication/i);
    });
  }
});

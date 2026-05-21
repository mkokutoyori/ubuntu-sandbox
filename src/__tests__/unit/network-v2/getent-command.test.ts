/**
 * `getent` command — integration tests.
 *
 * Drives `getent` through the bash interpreter (LinuxPC.executeCommand)
 * so the chain from terminal → executor → NSS → source is exercised
 * end-to-end.
 *
 * Per `getent` exit-code convention:
 *   0  → entries returned
 *   1  → key missing on enumeration-only databases
 *   2  → key not found
 *   3  → enumerate-not-supported (e.g. `getent shadow` as non-root)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { IPAddress, SubnetMask } from '@/network/core/types';

async function getent(pc: LinuxPC | LinuxServer, args: string): Promise<{ output: string; exitCode: number }> {
  const out = await pc.executeCommand(`getent ${args}; echo "__rc=$?"`);
  const m = /__rc=(\d+)\s*$/.exec(out);
  const exitCode = m ? parseInt(m[1], 10) : 0;
  const output = out.replace(/__rc=\d+\s*$/, '').trim();
  return { output, exitCode };
}

describe('getent passwd', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('with no args, dumps every passwd entry', async () => {
    const r = await getent(pc, 'passwd');
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('root:x:0:0:');
    expect(r.output).toContain('user:x:1000:1000:');
  });

  it('lookup by name returns the user line', async () => {
    const r = await getent(pc, 'passwd root');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^root:x:0:0:.*:\/root:/);
  });

  it('lookup by uid returns the user line', async () => {
    const r = await getent(pc, 'passwd 0');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^root:x:0:0:/);
  });

  it('unknown user returns exit 2', async () => {
    const r = await getent(pc, 'passwd nosuch');
    expect(r.exitCode).toBe(2);
    expect(r.output).toBe('');
  });

  it('multiple keys — one missing → exit 2 but valid lines still print', async () => {
    const r = await getent(pc, 'passwd root nosuch user');
    expect(r.exitCode).toBe(2);
    expect(r.output).toMatch(/^root:/m);
    expect(r.output).toMatch(/^user:/m);
  });
});

describe('getent group', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('lookup by gid returns the group line', async () => {
    const r = await getent(pc, 'group 0');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^root:x:0:/);
  });

  it('lookup by name returns the group line', async () => {
    const r = await getent(pc, 'group sudo');
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('sudo:x:');
    // Default user is in sudo.
    expect(r.output).toContain('user');
  });

  it('enumerate returns all groups', async () => {
    const r = await getent(pc, 'group');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^root:/m);
    expect(r.output).toMatch(/^sudo:/m);
  });
});

describe('getent shadow', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('non-root returns exit 2 with no output (real glibc behaviour)', async () => {
    const r = await getent(pc, 'shadow root');
    expect(r.exitCode).toBe(2);
    expect(r.output).toBe('');
  });

  it('root sees the shadow entry', async () => {
    pc.executor.userMgr.currentUid = 0;
    pc.executor.userMgr.currentUser = 'root';
    const r = await getent(pc, 'shadow root');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^root:/);
  });
});

describe('getent services', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('by name → returns the IANA assignment for SSH', async () => {
    const r = await getent(pc, 'services ssh');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/ssh\s+22\/(tcp|udp)/);
  });

  it('by name/proto → returns the matching protocol', async () => {
    const r = await getent(pc, 'services http/tcp');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/http\s+80\/tcp/);
  });

  it('by port → returns the canonical name', async () => {
    const r = await getent(pc, 'services 443');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/https\s+443\//);
  });

  it('unknown service → exit 2', async () => {
    const r = await getent(pc, 'services nonexistent');
    expect(r.exitCode).toBe(2);
  });
});

describe('getent protocols', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('by name → resolves to IP number', async () => {
    const r = await getent(pc, 'protocols tcp');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^tcp\s+6\b/);
  });

  it('by number → resolves to name', async () => {
    const r = await getent(pc, 'protocols 1');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^icmp\s+1\b/);
  });
});

describe('getent hosts', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('localhost via /etc/hosts → SUCCESS', async () => {
    const r = await getent(pc, 'hosts localhost');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/127\.0\.0\.1.*localhost/);
  });

  it('lookup by IP returns the name', async () => {
    const r = await getent(pc, 'hosts 127.0.0.1');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/localhost/);
  });

  it('topology-resolved hostname via the DNS source', async () => {
    const pc2 = new LinuxPC('pc2');
    pc2.setEventBus(bus);
    pc2.setHostname('pc2');
    const port = pc2.getPorts()[0];
    pc2.configureInterface(port.getName(),
      new IPAddress('10.0.0.42'),
      new SubnetMask('255.255.255.0'));

    // Sanity probe: resolver finds it directly.
    const direct = pc.executor.nss.lookup('hosts', s => s.gethostbyname?.('pc2'));
    expect(direct.status).toBe('SUCCESS');

    const r = await getent(pc, 'hosts pc2');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/10\.0\.0\.42.*pc2/);
  });

  it('unknown host → exit 2', async () => {
    const r = await getent(pc, 'hosts nosuchhost');
    expect(r.exitCode).toBe(2);
  });
});

describe('getent options', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('-V / --version prints a version banner', async () => {
    const r = await getent(pc, '--version');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/getent/);
  });

  it('--help prints a usage summary', async () => {
    const r = await getent(pc, '--help');
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('Usage: getent');
  });

  it('-s files forces the `files` source (no DNS fallback)', async () => {
    const pc2 = new LinuxPC('pc2');
    pc2.setEventBus(bus);
    pc2.setHostname('pc2');
    const port = pc2.getPorts()[0];
    pc2.configureInterface(port.getName(),
      new IPAddress('10.0.0.42'),
      new SubnetMask('255.255.255.0'));

    // Without -s files, pc2 resolves via DNS.
    const open = await getent(pc, 'hosts pc2');
    expect(open.exitCode).toBe(0);

    // With -s files, only /etc/hosts is consulted.
    const filesOnly = await getent(pc, '-s files hosts pc2');
    expect(filesOnly.exitCode).toBe(2);
  });

  it('--service=files is recognised as -s files', async () => {
    const r = await getent(pc, '--service=files hosts pc2');
    expect(r.exitCode).toBe(2);
  });
});

describe('getent networks / rpc / ethers', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('networks link-local resolves to 169.254.0.0', async () => {
    const r = await getent(pc, 'networks link-local');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/link-local\s+169\.254\.0\.0/);
  });

  it('rpc portmapper → 100000', async () => {
    const r = await getent(pc, 'rpc portmapper');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/portmapper\s+100000/);
  });

  it('ethers — empty by default → exit 2', async () => {
    const r = await getent(pc, 'ethers 00:11:22:33:44:55');
    expect(r.exitCode).toBe(2);
  });
});

describe('getent initgroups', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('lists supplementary groups for a user', async () => {
    const r = await getent(pc, 'initgroups user');
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^user\s+/);
    // The default user is in sudo + adm. Numbers vary but should
    // include the primary gid 1000.
    expect(r.output).toMatch(/\b1000\b/);
  });
});

describe('getent unknown database', () => {
  let bus: EventBus;
  let pc: LinuxPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('returns exit 2 with a "Unknown database" message', async () => {
    const r = await getent(pc, 'totallyfake');
    expect(r.exitCode).toBe(2);
    expect(r.output).toMatch(/Unknown database/i);
  });
});

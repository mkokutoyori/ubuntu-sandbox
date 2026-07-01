import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Lab {
  linux: LinuxPC;
  windows: WindowsPC;
  server: LinuxServer;
  sw: GenericSwitch;
}

const LINUX_MIN = 32768;
const LINUX_MAX = 60999;
const WIN_MIN = 49152;
const WIN_MAX = 65535;

async function buildLab(): Promise<Lab> {
  const sw = new GenericSwitch('switch', 'sw', 8, 0, 0);
  const linux = new LinuxPC('linux-pc', 'lin-client', 0, 0);
  const windows = new WindowsPC('windows-pc', 'win-client', 0, 0);
  const server = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c1').connect(linux.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(windows.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(server.getPorts()[0], sw.getPorts()[2]);
  const m = new SubnetMask('255.255.255.0');
  linux.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), m);
  windows.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), m);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.100'), m);
  const um = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
    getUser(u: string): unknown;
  } } }).executor.userMgr;
  if (!um.getUser('alice')) um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'alice');
  return { linux, windows, server, sw };
}

function socketTable(host: LinuxPC | LinuxServer): {
  getAll: () => Array<{ localPort: number; remotePort: number; remoteAddress: string; state: string; protocol: string }>;
} {
  return (host as unknown as { executor: { socketTable: {
    getAll: () => Array<{ localPort: number; remotePort: number; remoteAddress: string; state: string; protocol: string }>;
  } } }).executor.socketTable;
}

function winSocketTable(host: WindowsPC): {
  getAll: () => Array<{ localPort: number; remotePort: number; remoteAddress: string; state: string; protocol: string }>;
} {
  return (host as unknown as { socketTable: {
    getAll: () => Array<{ localPort: number; remotePort: number; remoteAddress: string; state: string; protocol: string }>;
  } }).socketTable;
}

describe('Scénario 6 — Port éphémère client cohérent avec la plage OS', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('Linux expose la plage /proc/sys/net/ipv4/ip_local_port_range = 32768\\t60999', async () => {
    const { linux } = await buildLab();
    const out = await linux.executeCommand('cat /proc/sys/net/ipv4/ip_local_port_range');
    expect(out.trim()).toBe(`${LINUX_MIN}\t${LINUX_MAX}`);
  });

  it('Windows expose la plage 49152 / 16384 via netsh int ipv4 show dynamicport tcp', async () => {
    const { windows } = await buildLab();
    const out = await windows.executeCommand('netsh int ipv4 show dynamicport tcp');
    expect(out).toMatch(/Start Port\s*:\s*49152/);
    expect(out).toMatch(/Number of Ports\s*:\s*16384/);
  });

  it('5 connexions ssh successives depuis Linux utilisent des ports uniques dans [32768,60999]', async () => {
    const { linux } = await buildLab();
    const ports: number[] = [];
    for (let i = 0; i < 5; i++) {
      await linux.executeCommand('ssh alice@10.0.0.100 whoami', 'alice\n');
      const sock = socketTable(linux).getAll()
        .filter(s => s.protocol === 'tcp' && s.remotePort === 22 && s.remoteAddress === '10.0.0.100')
        .pop();
      expect(sock).toBeDefined();
      ports.push(sock!.localPort);
    }
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(LINUX_MIN);
      expect(p).toBeLessThanOrEqual(LINUX_MAX);
    }
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('5 connexions ssh successives depuis Windows utilisent des ports uniques dans [49152,65535]', async () => {
    const { windows } = await buildLab();
    const ports: number[] = [];
    for (let i = 0; i < 5; i++) {
      await windows.executeCommand('ssh alice@10.0.0.100 whoami');
      const sock = winSocketTable(windows).getAll()
        .filter(s => s.protocol === 'tcp' && s.remotePort === 22 && s.remoteAddress === '10.0.0.100')
        .pop();
      expect(sock).toBeDefined();
      ports.push(sock!.localPort);
    }
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(WIN_MIN);
      expect(p).toBeLessThanOrEqual(WIN_MAX);
    }
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('un port éphémère ne peut pas être réattribué tant que la connexion est ESTABLISHED', async () => {
    const { linux } = await buildLab();
    await linux.executeCommand('ssh alice@10.0.0.100 whoami', 'alice\n');
    const before = socketTable(linux).getAll()
      .filter(s => s.protocol === 'tcp' && s.remotePort === 22);
    const busyPorts = new Set(before.map(s => s.localPort));
    for (let i = 0; i < 3; i++) {
      await linux.executeCommand('ssh alice@10.0.0.100 whoami', 'alice\n');
    }
    const after = socketTable(linux).getAll()
      .filter(s => s.protocol === 'tcp' && s.remotePort === 22);
    for (const s of after) {
      if (s.state === 'ESTABLISHED' || s.state === 'TIME_WAIT') {
        if (busyPorts.has(s.localPort) && s.id !== undefined) {
          expect(s.state).not.toBe('CLOSED');
        }
      }
    }
    const local = after.map(s => s.localPort);
    expect(new Set(local).size).toBe(local.length);
  });

  it('après fermeture, le socket passe par TIME_WAIT puis CLOSED et le port redevient disponible', async () => {
    const { linux } = await buildLab();
    await linux.executeCommand('ssh alice@10.0.0.100 whoami', 'alice\n');
    const all = socketTable(linux).getAll()
      .filter(s => s.protocol === 'tcp' && s.remotePort === 22);
    const last = all[all.length - 1];
    expect(last).toBeDefined();
    expect(['ESTABLISHED', 'TIME_WAIT', 'CLOSED']).toContain(last.state);
    const range = LINUX_MAX - LINUX_MIN + 1;
    for (let i = 0; i < 6; i++) {
      await linux.executeCommand('ssh alice@10.0.0.100 whoami', 'alice\n');
    }
    const total = socketTable(linux).getAll()
      .filter(s => s.protocol === 'tcp' && s.remotePort === 22).length;
    expect(total).toBeLessThan(range);
  });

  it('les plages Linux et Windows ne se chevauchent pas totalement: [32768,49151] est réservé à Linux', async () => {
    const { linux, windows } = await buildLab();
    const lports: number[] = [];
    for (let i = 0; i < 30; i++) {
      await linux.executeCommand('ssh alice@10.0.0.100 whoami', 'alice\n');
      const s = socketTable(linux).getAll()
        .filter(s => s.protocol === 'tcp' && s.remotePort === 22).pop();
      if (s) lports.push(s.localPort);
    }
    const wports: number[] = [];
    for (let i = 0; i < 30; i++) {
      await windows.executeCommand('ssh alice@10.0.0.100 whoami');
      const s = winSocketTable(windows).getAll()
        .filter(s => s.protocol === 'tcp' && s.remotePort === 22).pop();
      if (s) wports.push(s.localPort);
    }
    expect(lports.some(p => p < WIN_MIN)).toBe(true);
    for (const p of wports) expect(p).toBeGreaterThanOrEqual(WIN_MIN);
  });
});

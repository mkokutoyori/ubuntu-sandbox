import { describe, it, expect, beforeEach } from 'vitest';
import { SocketTable } from '@/network/core/SocketTable';
import { cmdSs, cmdNetstat } from '@/network/devices/linux/LinuxNetCommands';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';

function fixture(): SocketTable {
  const t = new SocketTable();
  t.bind('tcp', '0.0.0.0', 22, 985, 'sshd');
  t.bind('udp', '127.0.0.53', 53, 540, 'systemd-resolve');
  t.connect('tcp', '10.0.0.1', 54321, '10.0.0.2', 80, 1200, 'curl');
  return t;
}

const services: Record<string, string> = { '22/tcp': 'ssh', '53/udp': 'domain', '80/tcp': 'http' };
const resolveService = (port: number, proto: string): string | null =>
  services[`${port}/${proto}`] ?? null;

describe('ss — service names, states, filtering', () => {
  it('resolves the port to a service name without -n', () => {
    const out = cmdSs(['-tl'], false, fixture(), resolveService);
    expect(out).toMatch(/:ssh\b/);
    expect(out).not.toMatch(/:22\b/);
  });

  it('keeps numeric ports with -n', () => {
    const out = cmdSs(['-tln'], false, fixture(), resolveService);
    expect(out).toMatch(/:22\b/);
    expect(out).not.toMatch(/:ssh\b/);
  });

  it('abbreviates TCP states the ss way (ESTAB, not ESTABLISHED)', () => {
    const out = cmdSs(['-ta'], false, fixture(), resolveService);
    expect(out).toMatch(/\bESTAB\b/);
    expect(out).not.toMatch(/ESTABLISHED/);
    expect(out).toMatch(/\bLISTEN\b/);
  });

  it('shows UNCONN for UDP sockets', () => {
    const out = cmdSs(['-ua'], false, fixture(), resolveService);
    expect(out).toMatch(/\bUNCONN\b/);
  });

  it('hides listening sockets without -a/-l', () => {
    const out = cmdSs(['-tn'], false, fixture(), resolveService);
    expect(out).toMatch(/\bESTAB\b/);
    expect(out).not.toMatch(/\bLISTEN\b/);
  });

  it('shows only listening sockets with -l', () => {
    const out = cmdSs(['-tln'], false, fixture(), resolveService);
    expect(out).toMatch(/\bLISTEN\b/);
    expect(out).not.toMatch(/\bESTAB\b/);
  });

  it('shows both with -a', () => {
    const out = cmdSs(['-tan'], false, fixture(), resolveService);
    expect(out).toMatch(/\bLISTEN\b/);
    expect(out).toMatch(/\bESTAB\b/);
  });
});

describe('netstat — service names, filtering, header', () => {
  it('resolves the port to a service name without -n', () => {
    const out = cmdNetstat(['-lt'], null, false, fixture(), resolveService);
    expect(out).toMatch(/:ssh\b/);
  });

  it('keeps numeric with -n', () => {
    const out = cmdNetstat(['-ltn'], null, false, fixture(), resolveService);
    expect(out).toMatch(/:22\b/);
    expect(out).not.toMatch(/:ssh\b/);
  });

  it('default hides listeners and labels them "w/o servers"', () => {
    const out = cmdNetstat(['-tn'], null, false, fixture(), resolveService);
    expect(out).toMatch(/w\/o servers/);
    expect(out).not.toMatch(/\bLISTEN\b/);
  });

  it('-l shows only listeners labelled "only servers"', () => {
    const out = cmdNetstat(['-ltn'], null, false, fixture(), resolveService);
    expect(out).toMatch(/only servers/);
    expect(out).toMatch(/\bLISTEN\b/);
  });

  it('-a shows servers and established', () => {
    const out = cmdNetstat(['-atn'], null, false, fixture(), resolveService);
    expect(out).toMatch(/servers and established/);
    expect(out).toMatch(/\bLISTEN\b/);
    expect(out).toMatch(/\bESTABLISHED\b/);
  });
});

describe('ss/netstat — end-to-end through the real NSS /etc/services', () => {
  let pc: LinuxPC;
  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    const bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new LinuxPC('pc1');
    pc.setEventBus(bus);
    pc.powerOn();
  });

  it('ss -ltn shows the sshd listener numerically', async () => {
    const out = await pc.executeCommand('ss -ltn');
    expect(out).toMatch(/:22\b/);
  });

  it('ss -lt resolves :22 to ssh via /etc/services', async () => {
    const out = await pc.executeCommand('ss -lt');
    expect(out).toMatch(/:ssh\b/);
  });
});

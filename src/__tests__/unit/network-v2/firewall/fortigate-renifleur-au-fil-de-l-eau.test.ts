import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { openFortiConsole, runCommand, key, tick } from './fortiConsoleHarness';
import type { FortiTerminalSession } from '@/terminal/sessions';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.clear();
});

const seen = (s: FortiTerminalSession) => s.lines.map(l => l.text).join('\n');
const run = (d: unknown, c: string) =>
  (d as { executeCommand(c: string): Promise<string> }).executeCommand(c);

async function laboratoire() {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  await run(pc, 'ip addr add 192.168.10.10/24 dev eth0');
  await run(pc, 'ip link set eth0 up');
  for (const c of ['config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config system console', 'set output standard', 'end']) await run(fgt, c);
  return { fgt, pc };
}

async function settle(s: FortiTerminalSession, rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

async function lance(s: FortiTerminalSession, line: string): Promise<void> {
  s.setInput(line);
  s.handleKey(key('Enter'));
  await settle(s, 10);
}

describe('le renifleur ECRIT pendant qu il capture', () => {
  it('l en-tete parait AVANT le moindre paquet', async () => {
    const { fgt } = await laboratoire();
    const s = await openFortiConsole(fgt);
    await lance(s, 'diagnose sniffer packet port2 none 4');

    const vu = seen(s);
    expect(vu).toContain('interfaces=[port2]');
    expect(vu).not.toContain('packets received by filter');
  });

  it('il capture a partir de MAINTENANT : le passe n est pas rejoue', async () => {
    const { fgt } = await laboratoire();
    await run(fgt, 'execute ping 192.168.10.10');
    const s = await openFortiConsole(fgt);

    await lance(s, 'diagnose sniffer packet port2 none 4');
    await settle(s, 60);

    expect(seen(s)).toContain('interfaces=[port2]');
    expect(seen(s)).not.toContain('icmp');
  });

  it('un paquet qui arrive APRES la commande est montre', async () => {
    const { fgt } = await laboratoire();
    const s = await openFortiConsole(fgt);
    await lance(s, 'diagnose sniffer packet port2 none 4');
    const avant = seen(s);
    expect(avant).not.toContain('icmp');

    await run(fgt, 'execute ping 192.168.10.10');
    await settle(s);

    expect(seen(s)).toContain('icmp');
  });

  it('la capture TIENT la main tant qu on ne l arrete pas', async () => {
    const { fgt } = await laboratoire();
    const s = await openFortiConsole(fgt);
    await lance(s, 'diagnose sniffer packet port2 none 4');
    await settle(s, 60);

    expect(s.hasForegroundAsyncJob).toBe(true);
    expect(seen(s)).not.toContain('packets received by filter');
  });

  it('Ctrl+C arrete la capture et rend le total de CE qui est passe', async () => {
    const { fgt } = await laboratoire();
    const s = await openFortiConsole(fgt);
    await lance(s, 'diagnose sniffer packet port2 none 4');
    expect(s.hasForegroundAsyncJob).toBe(true);

    await run(fgt, 'execute ping 192.168.10.10');
    await settle(s);

    s.handleKey(key('c', true));
    await settle(s);

    expect(seen(s)).toMatch(/[1-9]\d* packets received by filter/);
    expect(s.hasForegroundAsyncJob).toBe(false);
    expect(s.currentInputMode.type).toBe('normal');
  });

  it('la capture rendue la main, on retape une commande', async () => {
    const { fgt } = await laboratoire();
    const s = await openFortiConsole(fgt);
    await lance(s, 'diagnose sniffer packet port2 none 4');
    expect(s.hasForegroundAsyncJob).toBe(true);
    s.handleKey(key('c', true));
    await settle(s);

    await runCommand(s, 'get system status');
    expect(seen(s)).toContain('Version: FortiGate-VM64');
  });

  it('un compteur donne arrete la capture tout seul', async () => {
    const { fgt } = await laboratoire();
    const s = await openFortiConsole(fgt);
    await lance(s, 'diagnose sniffer packet port2 none 4 2');
    expect(seen(s)).not.toContain('packets received by filter');

    await run(fgt, 'execute ping 192.168.10.10');
    await settle(s, 80);

    expect(seen(s)).toContain('2 packets received by filter');
    expect(s.currentInputMode.type).toBe('normal');
  });

  it('le filtre est honore pendant la capture VIVANTE', async () => {
    const { fgt } = await laboratoire();
    const s = await openFortiConsole(fgt);
    await lance(s, "diagnose sniffer packet port2 'host 10.99.99.99' 4");
    expect(s.hasForegroundAsyncJob).toBe(true);
    await run(fgt, 'execute ping 192.168.10.10');
    await settle(s);

    expect(seen(s)).not.toContain('192.168.10.10 -> ');
    expect(seen(s)).not.toContain('packets received by filter');
  });
});

describe('hors terminal, la commande garde son texte d un bloc', () => {
  it('un script relit ce que le tampon retient', async () => {
    const { fgt } = await laboratoire();
    await run(fgt, 'execute ping 192.168.10.10');
    const vu = await run(fgt, 'diagnose sniffer packet port2 none 4 10');

    expect(vu).toContain('interfaces=[port2]');
    expect(vu).toContain('icmp');
    expect(vu).toMatch(/[1-9]\d* packets received by filter/);
  });

  it('une interface inconnue reste refusee', async () => {
    const { fgt } = await laboratoire();
    const vu = await run(fgt, 'diagnose sniffer packet port99 none 4');
    expect(vu).toContain('Command fail');
  });
});

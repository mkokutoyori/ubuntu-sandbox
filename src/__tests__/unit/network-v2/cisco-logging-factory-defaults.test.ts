import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function run(r: CiscoRouter, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = String((await r.executeCommand(c)) ?? '');
  return last;
}

const STAMP = /^\*[A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}\.\d{3}: %/;

describe('a router leaves the factory timestamping its messages', () => {
  it('the buffer carries the IOS datetime-msec stamp', async () => {
    const r = new CiscoRouter('R1');
    await run(r, ['enable', 'configure terminal', 'hostname R1', 'end']);

    const buffer = String(await r.executeCommand('show logging')).split('Log Buffer')[1] ?? '';
    const line = buffer.split('\n').find(l => l.includes('%SYS-5-CONFIG_I')) ?? '';
    expect(line).toMatch(STAMP);
  });

  it('the configuration declares the two channels the machine actually stamps', async () => {
    const r = new CiscoRouter('R1');
    const cfg = await run(r, ['enable', 'show running-config']);

    expect(cfg).toContain('service timestamps debug datetime msec');
    expect(cfg).toContain('service timestamps log datetime msec');
  });

  it('and `show logging` reports the same options the configuration declares', async () => {
    const r = new CiscoRouter('R1');
    const shown = await run(r, ['enable', 'show logging']);

    expect(shown).toContain('Timestamp logging: debug datetime msec, log datetime msec');
  });

  it('`no service timestamps` really removes the stamp', async () => {
    const r = new CiscoRouter('R1');
    await run(r, ['enable', 'configure terminal', 'no service timestamps',
      'hostname R1', 'end']);

    const buffer = String(await r.executeCommand('show logging')).split('Log Buffer')[1] ?? '';
    const line = buffer.split('\n').filter(l => l.includes('%SYS-5-CONFIG_I')).at(-1) ?? '';
    expect(line.trimStart().startsWith('%')).toBe(true);
  });

  it('the bare form still means uptime, not the factory default', async () => {
    const r = new CiscoRouter('R1');
    await run(r, ['enable', 'configure terminal', 'service timestamps', 'end']);
    const cfg = String(await r.executeCommand('show running-config'));

    expect(cfg).toContain('service timestamps debug uptime');
    expect(cfg).toContain('service timestamps log uptime');
    expect(cfg).not.toContain('service timestamps debug datetime');
  });
});

describe('a buffer the machine claims is a buffer its configuration declares', () => {
  it('show logging and the running-config agree that it is on', async () => {
    const r = new CiscoRouter('R1');
    const shown = await run(r, ['enable', 'show logging']);
    const cfg = String(await r.executeCommand('show running-config'));

    expect(shown).toContain('Buffer logging: level debugging, 4096 bytes');
    expect(cfg).toContain('logging buffered 4096 debugging');
  });

  it('resizing it moves both views together', async () => {
    const r = new CiscoRouter('R1');
    await run(r, ['enable', 'configure terminal',
      'logging buffered 16384 informational', 'end']);

    expect(String(await r.executeCommand('show logging')))
      .toContain('Buffer logging: level informational, 16384 bytes');
    expect(String(await r.executeCommand('show running-config')))
      .toContain('logging buffered 16384 informational');
  });

  it('the whole logging configuration survives into the running-config', async () => {
    const r = new CiscoRouter('R1');
    await run(r, ['enable', 'configure terminal',
      'no logging console', 'logging trap warnings',
      'logging host 10.0.0.9', 'end']);

    const cfg = String(await r.executeCommand('show running-config'));
    expect(cfg).toContain('no logging console');
    expect(cfg).toContain('logging trap warnings');
    expect(cfg).toContain('logging host 10.0.0.9');
  });
});

describe('the link messages IOS is known for', () => {
  it('a cabled interface coming up stamps both of them', async () => {
    const r = new CiscoRouter('R1');
    const pc = new LinuxPC('PC1');
    new Cable('c1').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await run(r, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'shutdown', 'no shutdown', 'end']);

    const buffer = String(await r.executeCommand('show logging')).split('Log Buffer')[1] ?? '';
    const link = buffer.split('\n').filter(l => l.includes('%LINK-3-UPDOWN')).at(-1) ?? '';
    const proto = buffer.split('\n').filter(l => l.includes('%LINEPROTO-5-UPDOWN')).at(-1) ?? '';

    expect(link).toMatch(STAMP);
    expect(link).toContain('changed state to up');
    expect(proto).toMatch(STAMP);
    expect(proto).toContain('changed state to up');
  });
});

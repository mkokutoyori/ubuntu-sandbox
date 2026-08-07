/**
 * PRD-Debug-Fidelite-Cisco.md §2.1 / §7.1 — l'invariant du chantier A.
 *
 * Une ligne de debug est fabriquee UNE fois, horodatee selon `service
 * timestamps debug`, et la console et le tampon recoivent la meme. Le
 * test ne compare jamais a une chaine ecrite a la main : il compare les
 * deux vues entre elles, pour chaque reglage de l'option.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serial = 0;

async function lab(): Promise<{ a: CiscoRouter; b: CiscoRouter }> {
  const id = ++serial;
  const a = new CiscoRouter(`RA${id}`);
  const b = new CiscoRouter(`RB${id}`);
  new Cable(`c${id}`).connect(a.getPorts()[0], b.getPorts()[0]);
  for (const [d, ip] of [[a, '10.0.12.1'], [b, '10.0.12.2']] as const) {
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      `ip address ${ip} 255.255.255.0`, 'no shutdown', 'end']) {
      await d.executeCommand(c);
    }
  }
  return { a, b };
}

interface DebugSource { subscribe(listener: (line: string) => void): () => void }

function console_(dev: { getDebugService(): DebugSource }): { lines: string[]; stop(): void } {
  const lines: string[] = [];
  const off = dev.getDebugService().subscribe((l) => lines.push(l));
  return { lines, stop: off };
}

/** Ce que `show logging` garde de ce debug, dans l'ordre. */
function buffered(log: string, needle: RegExp): string[] {
  return log.split('\n').filter((l) => needle.test(l));
}

async function pingWithIcmpDebug(a: CiscoRouter): Promise<{ onConsole: string[]; inBuffer: string[] }> {
  await a.executeCommand('debug ip icmp');
  const c = console_(a as unknown as { getDebugService(): DebugSource });
  await a.executeCommand('ping 10.0.12.2 repeat 1');
  c.stop();
  const inBuffer = buffered(await a.executeCommand('show logging'), /ICMP: echo/);
  return { onConsole: c.lines, inBuffer };
}

describe('a debug line is built once', () => {
  it('the console and the buffer describe the event the same way', async () => {
    const { a } = await lab();
    const { onConsole, inBuffer } = await pingWithIcmpDebug(a);
    expect(onConsole.length).toBeGreaterThan(0);
    expect(onConsole).toEqual(inBuffer);
  });

  it('the line carries the timestamp `service timestamps debug` asks for', async () => {
    const { a } = await lab();
    for (const c of ['configure terminal', 'service timestamps debug datetime msec', 'end']) {
      await a.executeCommand(c);
    }
    const { onConsole, inBuffer } = await pingWithIcmpDebug(a);
    expect(onConsole).toEqual(inBuffer);
    for (const l of onConsole) {
      expect(l, l).toMatch(/^\*?\w{3}\s+\d+ \d{2}:\d{2}:\d{2}\.\d{3}: ICMP: echo/);
    }
  });

  it('`uptime` really selects the counter since boot, on both views', async () => {
    const { a } = await lab();
    for (const c of ['configure terminal', 'service timestamps debug uptime', 'end']) {
      await a.executeCommand(c);
    }
    const { onConsole, inBuffer } = await pingWithIcmpDebug(a);
    expect(onConsole).toEqual(inBuffer);
    for (const l of onConsole) {
      expect(l, l).toMatch(/^(\d{2}:\d{2}:\d{2}(\.\d{3})?|\d+[dw]\d+[hd]): ICMP: echo/);
    }
  });

  it('`no service timestamps debug` strips the stamp from both views', async () => {
    const { a } = await lab();
    for (const c of ['configure terminal', 'no service timestamps debug', 'end']) {
      await a.executeCommand(c);
    }
    const { onConsole, inBuffer } = await pingWithIcmpDebug(a);
    expect(onConsole).toEqual(inBuffer);
    for (const l of onConsole) expect(l, l).toMatch(/^ICMP: echo/);
  });

  it('changing the format changes what follows, never what is already written', async () => {
    const { a } = await lab();
    for (const c of ['configure terminal', 'service timestamps debug uptime', 'end']) {
      await a.executeCommand(c);
    }
    const first = await pingWithIcmpDebug(a);
    const dejaEcrit = [...first.inBuffer];
    for (const c of ['configure terminal', 'service timestamps debug datetime msec', 'end']) {
      await a.executeCommand(c);
    }
    const after = buffered(await a.executeCommand('show logging'), /ICMP: echo/);
    expect(after.slice(0, dejaEcrit.length)).toEqual(dejaEcrit);
  });

  it('a line the console loses to the rate limit is still kept by the buffer', async () => {
    const { a } = await lab();
    for (const c of ['configure terminal', 'logging rate-limit 1', 'end']) {
      await a.executeCommand(c);
    }
    const { onConsole, inBuffer } = await pingWithIcmpDebug(a);
    expect(inBuffer.length).toBeGreaterThanOrEqual(onConsole.length);
    for (const l of onConsole) expect(inBuffer, l).toContain(l);
  });

  it('a switch renders its debug lines the same way a router does', async () => {
    const sw = new CiscoSwitch('switch-cisco', `SW${++serial}`, 24, 0, 0);
    await sw.executeCommand('enable');
    for (const c of ['configure terminal', 'service timestamps debug datetime msec', 'end']) {
      await sw.executeCommand(c);
    }
    const svc = (sw as unknown as { getDebugService(): DebugSource & { setJournal?: unknown } }).getDebugService();
    expect(typeof (svc as unknown as { setJournal?: unknown }).setJournal).toBe('function');
    const journal = (sw as unknown as { getLoggingConfig(): { recordDebugLine(t: string): string } | null }).getLoggingConfig();
    expect(journal).not.toBeNull();
    expect(journal!.recordDebugLine('STP: probe'))
      .toMatch(/^\*?\w{3}\s+\d+ \d{2}:\d{2}:\d{2}\.\d{3}: STP: probe$/);
  });
});

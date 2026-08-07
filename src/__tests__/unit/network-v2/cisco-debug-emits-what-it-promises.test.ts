/**
 * PRD-Debug-Fidelite-Cisco.md §4.1 / §7.4 — lot D3.
 *
 * Une commande de debug qui ne peut emettre aucune ligne n'existe pas.
 * Ce lot cable les familles dont le bus publiait deja l'evenement : il
 * ne manquait que l'abonnement. Chaque cas fait TOURNER le protocole et
 * observe la console, jamais un drapeau.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { collecteDebug } from './_helpers/debugLines';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serial = 0;

interface DebugSource { subscribe(listener: (line: string) => void): () => void }
const debugOf = (d: unknown): DebugSource =>
  (d as { getDebugService(): DebugSource }).getDebugService();

async function pair(): Promise<{ a: CiscoRouter; b: CiscoRouter }> {
  const id = ++serial;
  const a = new CiscoRouter(`DA${id}`);
  const b = new CiscoRouter(`DB${id}`);
  new Cable(`dc${id}`).connect(a.getPorts()[0], b.getPorts()[0]);
  for (const [d, ip] of [[a, '10.0.12.1'], [b, '10.0.12.2']] as const) {
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      `ip address ${ip} 255.255.255.0`, 'no shutdown', 'end']) {
      await d.executeCommand(c);
    }
  }
  return { a, b };
}

describe('a debug that promises output produces it', () => {
  it('`debug ip rip` traces the updates the engine really sends', async () => {
    vi.useFakeTimers();
    try {
      const { a, b } = await pair();
      expect(await a.executeCommand('debug ip rip')).toBe('RIP debugging is on');
      const lignes: string[] = [];
      collecteDebug(debugOf(a), lignes);
      for (const d of [a, b]) {
        for (const c of ['configure terminal', 'router rip', 'version 2',
          'network 10.0.0.0', 'end']) {
          await d.executeCommand(c);
        }
      }
      vi.advanceTimersByTime(35_000);
      expect(lignes.length).toBeGreaterThan(0);
      expect(lignes.some((l) => /^RIP: sending v2 update to 224\.0\.0\.9 via /.test(l))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('`debug ip rip` stays silent once disarmed', async () => {
    vi.useFakeTimers();
    try {
      const { a, b } = await pair();
      for (const d of [a, b]) {
        for (const c of ['configure terminal', 'router rip', 'version 2',
          'network 10.0.0.0', 'end']) {
          await d.executeCommand(c);
        }
      }
      await a.executeCommand('debug ip rip');
      await a.executeCommand('no debug ip rip');
      const lignes: string[] = [];
      collecteDebug(debugOf(a), lignes);
      vi.advanceTimersByTime(35_000);
      expect(lignes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('`debug standby` traces the HSRP state machine', async () => {
    const { a, b } = await pair();
    expect(await a.executeCommand('debug standby')).toBe('HSRP debugging is on');
    const lignes: string[] = [];
    collecteDebug(debugOf(a), lignes);
    for (const d of [a, b]) {
      for (const c of ['configure terminal', 'interface GigabitEthernet0/0',
        'standby 1 ip 10.0.12.254', 'end']) {
        await d.executeCommand(c);
      }
    }
    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes.some((l) => /^HSRP: Gi0\/0 Grp 1 State \w+ -> \w+$/.test(l))).toBe(true);
  });

  it('`debug standby` names the interface the way IOS abbreviates it', async () => {
    const { a, b } = await pair();
    await a.executeCommand('debug standby');
    const lignes: string[] = [];
    collecteDebug(debugOf(a), lignes);
    for (const d of [a, b]) {
      for (const c of ['configure terminal', 'interface GigabitEthernet0/0',
        'standby 1 ip 10.0.12.254', 'end']) {
        await d.executeCommand(c);
      }
    }
    expect(lignes.every((l) => !l.includes('GigabitEthernet'))).toBe(true);
    expect(lignes.some((l) => l.includes('Gi0/0'))).toBe(true);
  });

  it('`debug port-security` traces a real violation', async () => {
    const sw = new CiscoSwitch('switch-cisco', `SWD${++serial}`, 24, 0, 0);
    await sw.executeCommand('enable');
    expect(await sw.executeCommand('debug port-security')).toMatch(/debugging is on/);
    const port = sw.getPort('FastEthernet0/1')!;
    port.getPortSecurity().enable();
    port.getPortSecurity().setMaxMACAddresses(1);

    const lignes: string[] = [];
    collecteDebug(debugOf(sw), lignes);
    for (const mac of ['00:11:22:33:44:01', '00:11:22:33:44:02']) {
      port.receiveFrame({
        srcMAC: new MACAddress(mac),
        dstMAC: new MACAddress('ff:ff:ff:ff:ff:ff'),
        etherType: 0x0800,
        payload: {},
      } as never);
    }
    expect(lignes.some((l) => /Violation|PSECURE/i.test(l))).toBe(true);
  });
});

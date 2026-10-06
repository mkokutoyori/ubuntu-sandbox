/**
 * Mesure de depart : l'application tournait sur `RealTimeScheduler`, donc rien ne permettait
 * d'avancer le temps de la topologie — ni pause, ni ×N, ni « avancer de X ». Seuls les tests
 * posaient un `VirtualTimeScheduler` et le pilotaient a la main. Sous un planificateur virtuel,
 * la mesure montre que les piles vieillissent deja d'elles-memes (table MAC de la CiscoSwitch a
 * 300 s, ARP Linux REACHABLE puis STALE, `date`, `uptime`, `show clock`) : le manque etait le
 * PILOTE, pas les piles. `SimulationClock` (events/) est ce pilote, installe au demarrage de
 * l'application (`simulationClockBoot.ts`, premier import de `main.tsx`).
 *
 * Laboratoire : une CiscoSwitch, deux LinuxPC, un WindowsPC, un CiscoRouter, un ping pour
 * apprendre MAC et voisin, puis `clock.advance(...)` ou la pompe temps reel (heure reelle
 * injectee). Les onze cas tombent avant (le pilote n'existait pas) ; le temoin « le laboratoire
 * apprend deux adresses MAC et le voisin est REACHABLE » prouve que le laboratoire est sain avant
 * toute avance. Le Windows se compare a 1 s pres : le temps de vol des trames echangees pendant
 * l'avance (`PathClock`, quelques dizaines de µs par trame) s'ajoute au planificateur.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';
import { SimulationClock, installSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

let clock: SimulationClock;
let realMs: number;
let pumping: (() => void) | null;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  realMs = 0;
  pumping = null;
  clock = installSimulationClock(new SimulationClock({
    realNow: () => realMs,
    startPump: (tick) => { pumping = tick; return () => { pumping = null; }; },
  }));
});
afterEach(() => { __resetSimulationClock(); });

async function lab() {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const a = new LinuxPC('A');
  const b = new LinuxPC('B');
  const w = new WindowsPC('windows-pc', 'W');
  const r = new CiscoRouter('R1');
  new Cable('c1').connect(a.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(b.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c3').connect(w.getPorts()[0], sw.getPort('FastEthernet0/3')!);
  new Cable('c4').connect(r.getPorts()[0], sw.getPort('FastEthernet0/4')!);
  const mask = new SubnetMask('255.255.255.0');
  a.getPort('eth0')!.configureIP(new IPAddress('10.0.0.1'), mask);
  b.getPort('eth0')!.configureIP(new IPAddress('10.0.0.2'), mask);
  w.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  clock.scheduler.advance(60_000);
  await clock.scheduler.advanceUntilSettled(a.executeCommand('ping -c 1 10.0.0.2'));
  return { sw, a, b, w, r };
}

const macTable = (sw: CiscoSwitch) => sw.executeCommand('show mac address-table dynamic');
const minutesOf = (date: string) => {
  const match = date.match(/(\d\d):(\d\d):\d\d/);
  return Number(match![1]) * 60 + Number(match![2]);
};

describe('advancing the time of a whole infrastructure', () => {
  it('witness: the lab learns two MAC addresses and the neighbour is reachable', async () => {
    const { sw, a } = await lab();
    const table = await macTable(sw);
    expect(table).toContain('FastEthernet0/1');
    expect(table).toContain('FastEthernet0/2');
    expect(await a.executeCommand('ip neigh')).toContain('REACHABLE');
  });

  it('ages the switch MAC table (300 s) when the clock advances by six minutes', async () => {
    const { sw } = await lab();
    await clock.advance(6 * 60_000);
    expect(await macTable(sw)).toContain('No entries');
  });

  it('keeps a MAC entry younger than the aging time', async () => {
    const { sw } = await lab();
    await clock.advance(2 * 60_000);
    expect(await macTable(sw)).toContain('FastEthernet0/2');
  });

  it('turns a neighbour entry STALE after a minute', async () => {
    const { a } = await lab();
    await clock.advance(61_000);
    expect(await a.executeCommand('ip neigh')).toContain('STALE');
  });

  it('moves the date of every machine by the same amount', async () => {
    const { a, b } = await lab();
    const before = [minutesOf(await a.executeCommand('date')), minutesOf(await b.executeCommand('date'))];
    await clock.advance(90 * 60_000);
    const after = [minutesOf(await a.executeCommand('date')), minutesOf(await b.executeCommand('date'))];
    expect((after[0] - before[0] + 1440) % 1440).toBe(90);
    expect((after[1] - before[1] + 1440) % 1440).toBe(90);
  });

  it('preserves the offset of a machine whose clock was set by hand', async () => {
    const { a, b } = await lab();
    const gap = async () => (minutesOf(await b.executeCommand('date')) - minutesOf(await a.executeCommand('date')) + 1440) % 1440;
    const before = await gap();
    b._stepSystemClock(60 * 60_000);
    await clock.advance(30 * 60_000);
    expect(await gap()).toBe((before + 60) % 1440);
  });

  it('moves the uptime of a machine', async () => {
    const { a } = await lab();
    await clock.advance(3 * 3_600_000);
    expect(await a.executeCommand('uptime')).toMatch(/up 3:0\d|up 3 hours?/);
  });

  it('moves the clock of the Cisco router', async () => {
    const { r } = await lab();
    const before = await r.executeCommand('show clock');
    await clock.advance(5 * 3_600_000);
    expect(await r.executeCommand('show clock')).not.toBe(before);
  });

  it('moves the clock of the Windows machine by the amount advanced', async () => {
    const { w } = await lab();
    const before = w.getSystemClockMs();
    await clock.advance(45 * 60_000);
    expect(Math.abs(w.getSystemClockMs() - before - 45 * 60_000)).toBeLessThan(1_000);
  });

  it('freezes every machine while the clock is paused, and only then', async () => {
    const { a, w } = await lab();
    clock.play(1);
    const running = w.getSystemClockMs();
    realMs += 60_000;
    pumping?.();
    expect(Math.abs(w.getSystemClockMs() - running - 60_000)).toBeLessThan(1_000);
    clock.pause();
    const frozen = [await a.executeCommand('date'), w.getSystemClockMs()];
    realMs += 3_600_000;
    pumping?.();
    expect([await a.executeCommand('date'), w.getSystemClockMs()]).toEqual(frozen);
  });

  it('runs the whole infrastructure sixty times faster at speed 60', async () => {
    const { a } = await lab();
    const before = minutesOf(await a.executeCommand('date'));
    clock.play(60);
    realMs += 60_000;
    pumping?.();
    const after = minutesOf(await a.executeCommand('date'));
    expect((after - before + 1440) % 1440).toBe(60);
  });
});

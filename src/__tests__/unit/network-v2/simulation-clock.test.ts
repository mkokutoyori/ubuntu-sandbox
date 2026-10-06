/**
 * Mesure de depart : l'application tournait sur `RealTimeScheduler` et rien ne permettait d'avancer
 * le temps de la topologie — ni pause, ni ×N, ni « avancer de X » ; seuls les tests posaient un
 * `VirtualTimeScheduler` et le pilotaient a la main. `SimulationClock` en fait un pilote : une
 * pompe temps reel qui avance le planificateur de `ecoule_reel × vitesse`, la pause, et
 * `advance(ms)` qui franchit chaque echeance dans l'ordre. Sonde sur le pilote seul, pompe et
 * heure reelle injectees : les dix cas tombent avant (le module n'existait pas). Le temoin
 * qui prouve que le laboratoire est sain est dans `probe-avancer-le-temps-de-l-infra.test.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SimulationClock, installSimulationClock, getSimulationClock, __resetSimulationClock } from '@/events/SimulationClock';
import { getDefaultScheduler } from '@/events/Scheduler';

function manualClock() {
  let real = 0;
  let pump: (() => void) | null = null;
  const clock = new SimulationClock({
    realNow: () => real,
    startPump: (tick) => { pump = tick; return () => { pump = null; }; },
  });
  return {
    clock,
    elapseReal: (ms: number) => { real += ms; pump?.(); },
    pumping: () => pump !== null,
  };
}

afterEach(() => { __resetSimulationClock(); });

describe('SimulationClock', () => {
  it('runs the scheduler at real time at speed 1', () => {
    const { clock, elapseReal } = manualClock();
    clock.play(1);
    elapseReal(5_000);
    expect(clock.scheduler.now()).toBe(5_000);
  });

  it('runs sixty times faster at speed 60', () => {
    const { clock, elapseReal } = manualClock();
    clock.play(60);
    elapseReal(1_000);
    expect(clock.scheduler.now()).toBe(60_000);
  });

  it('fires a timer that falls inside the accelerated window', () => {
    const { clock, elapseReal } = manualClock();
    let fired = 0;
    clock.scheduler.setTimeout(() => { fired++; }, 30 * 60_000);
    clock.play(600);
    elapseReal(2_000);
    expect(fired).toBe(0);
    elapseReal(1_000);
    expect(fired).toBe(1);
  });

  it('freezes time while paused', () => {
    const { clock, elapseReal, pumping } = manualClock();
    clock.play(1);
    elapseReal(1_000);
    clock.pause();
    expect(pumping()).toBe(false);
    elapseReal(60_000);
    expect(clock.scheduler.now()).toBe(1_000);
    expect(clock.getState().running).toBe(false);
  });

  it('keeps the real time elapsed before a speed change at the old speed', () => {
    const { clock, elapseReal } = manualClock();
    clock.play(1);
    elapseReal(1_000);
    clock.setSpeed(60);
    elapseReal(1_000);
    expect(clock.scheduler.now()).toBe(61_000);
  });

  it('advances a paused clock by an exact amount and stays paused', async () => {
    const { clock } = manualClock();
    await clock.advance(90 * 60_000);
    expect(clock.scheduler.now()).toBe(90 * 60_000);
    expect(clock.getState().running).toBe(false);
  });

  it('crosses every due task of an advance in chronological order, including those they arm', async () => {
    const { clock } = manualClock();
    const seen: string[] = [];
    clock.scheduler.setTimeout(() => {
      seen.push('b');
      clock.scheduler.setTimeout(() => seen.push('d'), 5_000);
    }, 20_000);
    clock.scheduler.setTimeout(() => seen.push('a'), 10_000);
    clock.scheduler.setTimeout(() => seen.push('c'), 30_000);
    await clock.advance(60_000);
    expect(seen).toEqual(['a', 'b', 'd', 'c']);
  });

  it('resumes a running clock after a manual advance', async () => {
    const { clock, elapseReal, pumping } = manualClock();
    clock.play(1);
    await clock.advance(10_000);
    expect(pumping()).toBe(true);
    elapseReal(1_000);
    expect(clock.scheduler.now()).toBe(11_000);
  });

  it('refuses a speed that is not a positive number and a negative advance', async () => {
    const { clock } = manualClock();
    expect(() => clock.setSpeed(0)).toThrow(RangeError);
    expect(() => clock.setSpeed(Number.NaN)).toThrow(RangeError);
    await expect(clock.advance(-1)).rejects.toThrow(RangeError);
  });

  it('becomes the default scheduler once installed', () => {
    const clock = installSimulationClock(manualClock().clock);
    expect(getSimulationClock()).toBe(clock);
    expect(getDefaultScheduler()).toBe(clock.scheduler);
  });
});

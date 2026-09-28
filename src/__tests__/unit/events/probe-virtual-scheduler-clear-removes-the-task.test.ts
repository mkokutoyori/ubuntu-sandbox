/**
 * `VirtualTimeScheduler.clear` retire la tache qu'il annule : un
 * minuteur rearme a chaque tick — le minuteur de mort d'une adjacence,
 * rearme par chaque hello — ne laisse pas derriere lui une file qui
 * grossit tout au long d'une meme avance.
 *
 * Mesure de depart (77edeca5) : `clear` marquait la tache annulee et la
 * laissait dans la file ; la purge n'avait lieu qu'a la FIN d'une avance.
 * Chaque pas d'une avance parcourait donc toutes les taches annulees
 * depuis son debut : une journee simulee d'un minuteur rearme chaque
 * seconde prenait 28,9 s, et 25 heures simulees d'une adjacence OSPF
 * entre une FortiGate et un routeur Cisco ne s'achevaient pas en quatre
 * minutes. Le meme laboratoire, avance par pas d'une minute, passait dix
 * minutes simulees en 20 ms : le cout venait de la file, pas du travail.
 *
 * Discrimination, mesuree sur le commit de base (77edeca5) avec ce
 * fichier copie : 1 des 3 cas tombe — 28 903 ms pour la journee simulee.
 * Passent des deux cotes le TEMOIN (le minuteur rearme n'expire jamais)
 * et la NON-REGRESSION de la semantique d'annulation (un minuteur annule
 * ne tire pas, un intervalle s'annule depuis son propre tick, et
 * pendingCount ne compte que les taches vivantes).
 */
import { describe, it, expect, vi } from 'vitest';
import { VirtualTimeScheduler } from '@/events/Scheduler';

vi.setConfig({ testTimeout: 600_000 });

const DAY = 86_400_000;

function deadTimerPattern(clock: VirtualTimeScheduler): { expiries: () => number } {
  let expiries = 0;
  let dead = clock.setTimeout(() => { expiries++; }, 4_000);
  clock.setInterval(() => {
    clock.clear(dead);
    dead = clock.setTimeout(() => { expiries++; }, 4_000);
  }, 1_000);
  return { expiries: () => expiries };
}

describe('VirtualTimeScheduler.clear removes the task it cancels', () => {
  it('WITNESS: a timer re-armed every second never expires', () => {
    const clock = new VirtualTimeScheduler();
    const pattern = deadTimerPattern(clock);
    clock.advance(60_000);
    expect(pattern.expiries()).toBe(0);
  });

  it('a cleared timeout never fires, and an interval can clear itself from its own tick', () => {
    const clock = new VirtualTimeScheduler();
    const fired: string[] = [];
    const timeout = clock.setTimeout(() => fired.push('timeout'), 500);
    clock.clear(timeout);
    let ticks = 0;
    const interval = clock.setInterval(() => {
      ticks++;
      if (ticks === 3) clock.clear(interval);
    }, 100);
    clock.advance(2_000);
    expect(fired).toEqual([]);
    expect(ticks).toBe(3);
    expect(clock.pendingCount()).toBe(0);
  });

  it('a simulated day of a timer re-armed every second runs in linear time', () => {
    const clock = new VirtualTimeScheduler();
    deadTimerPattern(clock);
    const started = Date.now();
    clock.advance(DAY);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(clock.pendingCount()).toBe(2);
  });
});

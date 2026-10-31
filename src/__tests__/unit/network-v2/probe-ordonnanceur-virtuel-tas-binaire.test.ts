/**
 * Le planificateur virtuel (`VirtualTimeScheduler`) rangeait ses taches dans un tableau : chaque tache a executer coutait un
 * balayage complet (`pickNextDue`) et chaque annulation un `findIndex` + `splice`, soit un cout QUADRATIQUE en nombre de
 * minuteries en attente. Profil CDP de l'epreuve `curl-2000` du laboratoire nat-lab : `pickNextDue` 0,8 s, `removeTask` 0,5 s, et
 * 50000 minuteries armees puis a moitie annulees coutaient 3,7 s en Node. Elles sont maintenant dans un tas binaire (ordre
 * (echeance, numero d'insertion), annulation paresseuse, tas reconstruit quand il contient plus de deux fois les taches vivantes).
 *
 * Discrimine par `git stash` sur src/events : 1 des 3 cas tombe avant (le temps). Les deux autres sont des TEMOINS : l'ordre
 * d'execution (echeance puis insertion, annulation, intervalle) et le saut (`jump`) sont ceux du balayage lineaire.
 */
import { describe, it, expect } from 'vitest';
import { VirtualTimeScheduler } from '@/events/Scheduler';

describe('VirtualTimeScheduler range ses taches dans un tas binaire', () => {
  it('TEMOIN — ordre (echeance, insertion), annulation et intervalle', () => {
    const scheduler = new VirtualTimeScheduler();
    const log: string[] = [];
    const cancelled = scheduler.setTimeout(() => log.push('c'), 30);
    scheduler.setTimeout(() => log.push('a'), 10);
    scheduler.setTimeout(() => log.push('b'), 10);
    scheduler.setInterval(() => log.push('i'), 25);
    scheduler.clear(cancelled);
    scheduler.advance(60);
    expect(log).toEqual(['a', 'b', 'i', 'i']);
    expect(scheduler.pendingCount()).toBe(1);
  });

  it('TEMOIN — jump ramene les taches en retard a l instant du saut', () => {
    const scheduler = new VirtualTimeScheduler();
    const log: string[] = [];
    scheduler.setTimeout(() => log.push('late'), 5);
    scheduler.setTimeout(() => log.push('later'), 500);
    scheduler.jump(100);
    expect(log).toEqual(['late']);
    expect(scheduler.msUntilNextTask()).toBe(400);
  });

  it('50000 minuteries armees puis a moitie annulees s executent en moins de 1,5 s', () => {
    const scheduler = new VirtualTimeScheduler();
    const handles = Array.from({ length: 50_000 }, (_, index) => scheduler.setTimeout(() => undefined, 1000 + (index % 977)));
    const startedAt = performance.now();
    for (let index = 0; index < handles.length; index += 2) scheduler.clear(handles[index]);
    scheduler.advance(5000);
    expect(performance.now() - startedAt).toBeLessThan(1500);
    expect(scheduler.pendingCount()).toBe(0);
  });
});

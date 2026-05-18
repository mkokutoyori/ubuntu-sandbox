/**
 * V$LATCH — per-latch cumulative stats.
 *
 * Aggregated from runtime.latches (fed by oracle.latch.event).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { LATCH_CATALOGUE } from './v_latchname';

registerView({
  name: 'V$LATCH',
  comment: 'Latch statistics',
  query({ runtime }) {
    const stats = new Map<string, { gets: number; misses: number; sleeps: number }>();
    for (const l of LATCH_CATALOGUE) stats.set(l.name, { gets: 0, misses: 0, sleeps: 0 });
    for (const e of runtime.latches) {
      const s = stats.get(e.latch) ?? { gets: 0, misses: 0, sleeps: 0 };
      if (e.kind === 'acquired') s.gets++;
      else if (e.kind === 'sleep') { s.sleeps++; s.misses++; }
      stats.set(e.latch, s);
    }
    return queryResult(
      [
        col.num('ADDR'),
        col.num('LATCH#'),
        col.num('LEVEL#'),
        col.str('NAME', 64),
        col.num('GETS'),
        col.num('MISSES'),
        col.num('SLEEPS'),
        col.num('IMMEDIATE_GETS'),
        col.num('IMMEDIATE_MISSES'),
        col.num('SPIN_GETS'),
      ],
      LATCH_CATALOGUE.map(l => {
        const s = stats.get(l.name)!;
        return [
          l.id, l.id, l.level, l.name,
          s.gets, s.misses, s.sleeps,
          s.gets, s.misses, Math.max(0, s.gets - s.sleeps),
        ];
      })
    );
  },
});

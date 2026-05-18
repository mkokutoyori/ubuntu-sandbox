/**
 * V$SERVICEMETRIC — per-service current metric snapshot.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SERVICEMETRIC',
  comment: 'Per-service current metric',
  query({ runtime }) {
    const intervalS = Math.max(15, Math.floor((Date.now() - runtime.startedAt) / 1000));
    const end = Date.now();
    const active = [...runtime.services.values()].filter(s => s.active);
    return queryResult(
      [
        col.date('BEGIN_TIME'),
        col.date('END_TIME'),
        col.num('INTSIZE_CSEC'),
        col.str('SERVICE_NAME', 64),
        col.num('CTMHASH'),
        col.num('GOODNESS'),
        col.num('DELTA'),
        col.num('CALLSPERSEC'),
        col.num('DBTIMEPERCALL'),
        col.num('CPUPERCALL'),
      ],
      active.map((s, idx) => [
        new Date(end - intervalS * 1000).toISOString(),
        new Date(end).toISOString(),
        intervalS * 100, s.name, idx, 1, 0,
        Math.floor(runtime.counters.parseTotal / intervalS),
        100, 80,
      ])
    );
  },
});

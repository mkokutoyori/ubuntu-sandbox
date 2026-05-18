/**
 * V$LATCHNAME — catalogue of known latches.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

export const LATCH_CATALOGUE: ReadonlyArray<{ id: number; name: string; level: number }> = [
  { id: 1, name: 'shared pool', level: 7 },
  { id: 2, name: 'library cache', level: 5 },
  { id: 3, name: 'cache buffers chains', level: 1 },
  { id: 4, name: 'cache buffers lru chain', level: 3 },
  { id: 5, name: 'redo allocation', level: 6 },
  { id: 6, name: 'redo copy', level: 4 },
  { id: 7, name: 'enqueue hash chains', level: 3 },
  { id: 8, name: 'session allocation', level: 5 },
  { id: 9, name: 'session idle bit', level: 1 },
  { id: 10, name: 'process allocation', level: 6 },
  { id: 11, name: 'KSE buffer pool', level: 2 },
  { id: 12, name: 'row cache objects', level: 4 },
  { id: 13, name: 'undo global data', level: 4 },
];

registerView({
  name: 'V$LATCHNAME',
  comment: 'Latch name catalogue',
  query() {
    return queryResult(
      [col.num('LATCH#'), col.str('NAME', 64), col.num('HASH'), col.num('DISPLACEMENT_LEVEL')],
      LATCH_CATALOGUE.map(l => [l.id, l.name, l.id * 100, l.level])
    );
  },
});

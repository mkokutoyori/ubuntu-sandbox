/**
 * V$LATCHHOLDER — currently held latches.
 *
 * Built from `runtime.latches` events with kind=='acquired' that haven't
 * been released.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$LATCHHOLDER',
  comment: 'Currently held latches',
  query({ runtime }) {
    // Held = last event per (sid, latch) is 'acquired'.
    const held = new Map<string, typeof runtime.latches[number]>();
    for (const e of runtime.latches) {
      const k = `${e.sid}:${e.latch}`;
      if (e.kind === 'released') held.delete(k);
      else held.set(k, e);
    }
    return queryResult(
      [
        col.num('PID'),
        col.num('SID'),
        col.num('LADDR'),
        col.str('NAME', 64),
        col.num('GETS'),
      ],
      [...held.values()].map(e => [e.sid, e.sid, e.level, e.latch, 1])
    );
  },
});

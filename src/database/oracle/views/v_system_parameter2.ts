/**
 * V$SYSTEM_PARAMETER2 — system-level analog of V$PARAMETER2.
 */

import { queryView } from './registry';
import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SYSTEM_PARAMETER2',
  comment: 'System list-valued parameters',
  query(ctx) {
    return queryView('V$PARAMETER2', ctx) ?? queryResult(
      [col.str('NAME', 80), col.str('VALUE', 512)],
      []
    );
  },
});

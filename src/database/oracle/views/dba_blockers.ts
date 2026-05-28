import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_BLOCKERS',
  comment: 'Sessions holding a lock that blocks another session',
  query({ instance }) {
    const sids = new Set(instance.lockManager.getBlockers().map(b => b.holderSid));
    return queryResult(
      [col.num('HOLDING_SESSION')],
      [...sids].map(s => [s]),
    );
  },
});

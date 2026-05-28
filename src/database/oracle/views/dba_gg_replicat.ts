import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_GG_REPLICAT',
  comment: 'GoldenGate replicat processes',
  query({ instance }) {
    return queryResult(
      [
        col.str('REPLICAT_NAME', 128),
        col.str('REPLICAT_TYPE', 16),
        col.str('TARGET_DB', 128),
        col.str('STATUS', 8),
        col.num('LAG_SECONDS'),
        col.num('APPLIED_RECORDS'),
      ],
      instance.replication.getReplicats().map(r => [
        r.replicatName, r.replicatType, r.targetDb, r.status, r.lagSeconds, r.appliedRecords,
      ]),
    );
  },
});

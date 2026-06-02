import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_GG_EXTRACT',
  comment: 'GoldenGate extract processes',
  query({ instance }) {
    return queryResult(
      [
        col.str('EXTRACT_NAME', 128),
        col.str('EXTRACT_TYPE', 16),
        col.str('SOURCE_DB', 128),
        col.str('STATUS', 8),
        col.num('LAG_SECONDS'),
        col.str('POSITION_FILE', 256),
        col.date('CREATED_AT'),
      ],
      instance.replication.getExtracts().map(e => [
        e.extractName, e.extractType, e.sourceDb,
        e.status, e.lagSeconds, e.positionFile, e.createdAt.toISOString(),
      ]),
    );
  },
});

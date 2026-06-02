import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_FLASHBACK_ARCHIVE_TS',
  comment: 'Tablespaces backing each Flashback Data Archive',
  query({ instance }) {
    return queryResult(
      [
        col.str('FLASHBACK_ARCHIVE_NAME', 128),
        col.num('FLASHBACK_ARCHIVE#'),
        col.str('TABLESPACE_NAME', 30),
        col.num('QUOTA_IN_MB'),
      ],
      instance.flashbackArchive.getTablespaces().map((t, i) => [
        t.archive, i + 1, t.ts, t.quota,
      ]),
    );
  },
});

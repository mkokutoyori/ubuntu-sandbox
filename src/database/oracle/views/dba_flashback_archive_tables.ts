import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_FLASHBACK_ARCHIVE_TABLES',
  comment: 'Tables enrolled in a Flashback Data Archive',
  query({ instance }) {
    return queryResult(
      [
        col.str('TABLE_NAME', 128),
        col.str('OWNER_NAME', 128),
        col.str('FLASHBACK_ARCHIVE_NAME', 128),
        col.str('ARCHIVE_TABLE_NAME', 128),
        col.str('STATUS', 10),
      ],
      instance.flashbackArchive.getTables().map(t => [
        t.tableName, t.ownerName, t.flashbackArchiveName, t.archiveTableName, t.status,
      ]),
    );
  },
});

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_FLASHBACK_ARCHIVE',
  comment: 'Flashback Data Archives',
  query({ instance }) {
    return queryResult(
      [
        col.str('OWNER_NAME', 128),
        col.str('FLASHBACK_ARCHIVE_NAME', 128),
        col.num('FLASHBACK_ARCHIVE#'),
        col.num('RETENTION_IN_DAYS'),
        col.date('CREATE_TIME'),
        col.date('LAST_PURGE_TIME'),
        col.str('STATUS', 30),
      ],
      instance.flashbackArchive.getArchives().map((a, i) => [
        a.owner, a.flashbackArchiveName, i + 1,
        a.retentionInDays, a.createTime.toISOString(),
        a.lastPurgeTime ? a.lastPurgeTime.toISOString() : null,
        a.isDefault ? 'DEFAULT' : a.status,
      ]),
    );
  },
});

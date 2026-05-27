/**
 * DBA_EXTERNAL_LOCATIONS — one row per LOCATION clause entry of every
 * external table. Native Oracle 10g+.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_EXTERNAL_LOCATIONS',
  comment: 'External table locations',
  query({ instance }) {
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('TABLE_NAME', 128),
        col.str('LOCATION', 4000),
        col.str('DIRECTORY_OWNER', 3),
        col.str('DIRECTORY_NAME', 128),
      ],
      instance.externalTables.getLocations().map(l => [
        l.owner, l.tableName, l.location, l.directoryOwner, l.directoryName,
      ]),
    );
  },
});

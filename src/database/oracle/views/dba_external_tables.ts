/**
 * DBA_EXTERNAL_TABLES — every CREATE TABLE … ORGANIZATION EXTERNAL.
 * Native Oracle 10g+.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_EXTERNAL_TABLES',
  comment: 'External tables',
  query({ instance }) {
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('TABLE_NAME', 128),
        col.str('TYPE_OWNER', 3),
        col.str('TYPE_NAME', 30),
        col.str('DEFAULT_DIRECTORY_OWNER', 3),
        col.str('DEFAULT_DIRECTORY_NAME', 128),
        col.str('REJECT_LIMIT', 40),
        col.str('ACCESS_TYPE', 7),
        col.str('ACCESS_PARAMETERS', 4000),
        col.str('PROPERTY', 10),
      ],
      instance.externalTables.getTables().map(t => [
        t.owner, t.tableName, t.typeOwner, t.typeName,
        t.defaultDirectoryOwner, t.defaultDirectoryName,
        t.rejectLimit, t.accessType, t.accessParameters, t.propertyClause,
      ]),
    );
  },
});

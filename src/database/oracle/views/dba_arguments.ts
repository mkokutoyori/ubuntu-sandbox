/**
 * DBA_ARGUMENTS — procedure/function argument metadata.
 *
 * Reads stored PL/SQL units. We don't yet have a typed argument projection
 * exposed through OracleStorage, so this returns an empty schema. When
 * stored units gain proper arg metadata, the events that register a new
 * unit will populate this view via OracleCatalog's stored-units provider.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_ARGUMENTS',
  comment: 'PL/SQL argument metadata',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('OBJECT_NAME', 30),
        col.str('PACKAGE_NAME', 30),
        col.num('OBJECT_ID'),
        col.num('OVERLOAD'),
        col.str('ARGUMENT_NAME', 128),
        col.num('POSITION'),
        col.str('DATA_TYPE', 30),
        col.str('IN_OUT', 9),
      ],
      []
    );
  },
});

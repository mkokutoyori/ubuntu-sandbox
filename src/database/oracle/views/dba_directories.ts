/**
 * DBA_DIRECTORIES / ALL_DIRECTORIES — directory objects, read from the
 * live catalog registry (CREATE [OR REPLACE] DIRECTORY registers there,
 * DROP DIRECTORY removes). Directory objects are always SYS-owned, so
 * OWNER is reported as 'SYS' for every row. The default DATA_PUMP_DIR is
 * seeded by the catalog, so it still appears on a fresh instance.
 *
 * In real Oracle, ALL_DIRECTORIES filters to the directories the current
 * user has any privilege on; the simulator does not model per-user
 * directory ACLs at the dictionary layer, so both views expose the same
 * rows (consistent with how the other ALL_/DBA_ pairs behave here).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import type { ViewContext } from './types';
import { registerView } from './registry';

const COLUMNS = [
  { name: 'OWNER', dataType: oracleVarchar2(30) },
  { name: 'DIRECTORY_NAME', dataType: oracleVarchar2(30) },
  { name: 'DIRECTORY_PATH', dataType: oracleVarchar2(4000) },
];

function directoryRows({ catalog }: ViewContext) {
  return queryResult(
    COLUMNS,
    catalog.getDirectories().map(d => ['SYS', d.name, d.path]),
  );
}

registerView({
  name: 'DBA_DIRECTORIES',
  comment: 'Directory objects',
  query: directoryRows,
});

registerView({
  name: 'ALL_DIRECTORIES',
  comment: 'Directory objects accessible to the user',
  query: directoryRows,
});

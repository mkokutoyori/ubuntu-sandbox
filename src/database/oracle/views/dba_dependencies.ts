/**
 * DBA_DEPENDENCIES — object dependencies (views on tables, packages on
 * other packages, etc.). Empty unless we have stored objects with
 * declared references.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_DEPENDENCIES',
  comment: 'Object dependencies',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('NAME', 64),
        col.str('TYPE', 18),
        col.str('REFERENCED_OWNER', 30),
        col.str('REFERENCED_NAME', 64),
        col.str('REFERENCED_TYPE', 18),
        col.str('REFERENCED_LINK_NAME', 128),
        col.str('DEPENDENCY_TYPE', 4),
      ],
      []
    );
  },
});

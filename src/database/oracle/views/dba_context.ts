/**
 * DBA_CONTEXT — registered application contexts. Native Oracle 10g+;
 * populated by CREATE CONTEXT.
 *
 * The simulator always reports the implicit USERENV namespace (which
 * Oracle does, since it ships with every install). Real CREATE
 * CONTEXT statements would extend this list — they're not parsed yet.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_CONTEXT',
  comment: 'Registered application contexts',
  query() {
    return queryResult(
      [
        col.str('NAMESPACE', 30),
        col.str('SCHEMA', 128),
        col.str('PACKAGE', 128),
        col.str('TYPE', 22),
      ],
      [
        // The USERENV namespace is system-defined. SYS_CONTEXT('USERENV', ...)
        // is implicitly registered on every Oracle install.
        ['USERENV', 'SYS', 'DBMS_STANDARD', 'ACCESSED LOCALLY'],
      ],
    );
  },
});

/**
 * V$LOGMNR_CONTENTS — mined redo records.
 *
 * Populated from the DDL/DML history journaled by the
 * SecurityAuditActor: any change crossing the bus appears here exactly
 * as a real LogMiner session would surface it, so DBAs can run their
 * usual change-tracking queries against the simulator.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$LOGMNR_CONTENTS',
  comment: 'LogMiner extracted redo content',
  query({ instance }) {
    const journal = instance.getAuditJournal();
    const rows: (string | number | null)[][] = [];
    for (const d of journal.getDdlHistory()) {
      rows.push([
        d.scn, d.scn, d.timestamp.toISOString(), 1, 'DDL',
        d.schema, d.objectName, d.objectName, d.username,
        d.sqlText, null,
      ]);
    }
    for (const m of journal.getDmlHistory()) {
      rows.push([
        m.scn, m.scn, m.timestamp.toISOString(), 1, m.action,
        m.schema, m.table, m.table, m.username,
        m.sqlText ?? `${m.action} /* ${m.rowsAffected} rows */`,
        m.action === 'SELECT' ? null : `UNDO of ${m.action}`,
      ]);
    }
    rows.sort((a, b) => Number(a[0]) - Number(b[0]));
    return queryResult(
      [
        col.num('SCN'),
        col.num('CSCN'),
        col.date('TIMESTAMP'),
        col.num('THREAD#'),
        col.str('OPERATION', 32),
        col.str('SEG_OWNER', 30),
        col.str('SEG_NAME', 30),
        col.str('TABLE_NAME', 30),
        col.str('USERNAME', 30),
        col.str('SQL_REDO', 4000),
        col.str('SQL_UNDO', 4000),
      ],
      rows,
    );
  },
});

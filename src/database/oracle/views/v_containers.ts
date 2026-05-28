import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$CONTAINERS',
  comment: 'Containers (CDB$ROOT + PDBs)',
  query({ instance }) {
    const rows: (string | number | null)[][] = [
      [1, 'CDB$ROOT', String(instance.config.sid), 1234567890, 'READ WRITE', 'NORMAL', null],
    ];
    for (const p of instance.multitenant.getAll()) {
      rows.push([p.conId, p.name, String(p.dbid), p.dbid, p.openMode, p.status, p.guid]);
    }
    return queryResult(
      [
        col.num('CON_ID'),
        col.str('NAME', 128),
        col.str('CON_UID', 32),
        col.num('DBID'),
        col.str('OPEN_MODE', 10),
        col.str('STATUS', 11),
        col.str('GUID', 32),
      ],
      rows,
    );
  },
});

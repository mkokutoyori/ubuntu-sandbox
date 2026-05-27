import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'CDB_PDBS',
  comment: 'Pluggable databases (container-aware)',
  query({ instance }) {
    return queryResult(
      [
        col.str('PDB_NAME', 128),
        col.num('PDB_ID'),
        col.num('CON_ID'),
        col.num('DBID'),
        col.str('GUID', 32),
        col.str('STATUS', 11),
        col.date('CREATION_TIME'),
      ],
      instance.multitenant.getAll().map(p => [
        p.name, p.conId, 1, p.dbid, p.guid, p.status, p.createdAt.toISOString(),
      ]),
    );
  },
});

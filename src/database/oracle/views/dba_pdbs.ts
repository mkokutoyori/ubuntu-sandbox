import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_PDBS',
  comment: 'Pluggable databases',
  query({ instance }) {
    return queryResult(
      [
        col.str('PDB_NAME', 128),
        col.num('PDB_ID'),
        col.num('CON_ID'),
        col.num('DBID'),
        col.str('CON_UID', 32),
        col.str('GUID', 32),
        col.str('STATUS', 11),
        col.date('CREATION_TIME'),
        col.str('IS_APPLICATION_ROOT', 3),
        col.str('IS_APPLICATION_PDB', 3),
        col.str('APPLICATION_ROOT', 128),
        col.str('APPLICATION_SEED', 3),
        col.str('IS_PROXY_PDB', 3),
      ],
      instance.multitenant.getAll().map(p => [
        p.name, p.conId, p.conId, p.dbid, String(p.dbid), p.guid,
        p.status, p.createdAt.toISOString(),
        p.applicationRoot ? 'YES' : 'NO',
        p.applicationPdb ? 'YES' : 'NO',
        null,
        p.applicationSeed ? 'YES' : 'NO',
        'NO',
      ]),
    );
  },
});

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$PDBS',
  comment: 'Pluggable databases',
  query({ instance }) {
    return queryResult(
      [
        col.num('CON_ID'),
        col.num('DBID'),
        col.str('CON_UID', 32),
        col.str('GUID', 32),
        col.str('NAME', 128),
        col.str('OPEN_MODE', 10),
        col.str('RESTRICTED', 3),
        col.date('OPEN_TIME'),
        col.num('CREATE_SCN'),
        col.num('TOTAL_SIZE'),
        col.num('BLOCK_SIZE'),
        col.str('STATUS', 11),
        col.str('APPLICATION_ROOT', 3),
        col.str('APPLICATION_PDB', 3),
        col.str('APPLICATION_SEED', 3),
        col.str('IS_PROXY_PDB', 3),
      ],
      instance.multitenant.getAll().map(p => [
        p.conId, p.dbid, String(p.dbid), p.guid, p.name, p.openMode,
        p.restricted ? 'YES' : 'NO',
        p.openMode === 'MOUNTED' ? null : new Date().toISOString(),
        100000, p.totalSizeBytes, 8192, p.status,
        p.applicationRoot ? 'YES' : 'NO',
        p.applicationPdb ? 'YES' : 'NO',
        p.applicationSeed ? 'YES' : 'NO',
        'NO',
      ]),
    );
  },
});

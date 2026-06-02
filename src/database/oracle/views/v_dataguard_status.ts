import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$DATAGUARD_STATUS',
  comment: 'Data Guard runtime status messages',
  query({ instance }) {
    const dg = instance.dataGuard;
    const rows: (string | number | null)[][] = [
      [1, 'Log Transport', 'CONFIGURATION', 'STATIC', 0, null,
        `Configuration ${dg.configurationName} (${dg.protectionMode})`, new Date().toISOString()],
    ];
    dg.getStandbys().forEach((s, i) => {
      rows.push([i + 2, 'Log Apply', s.dbUniqueName, 'DYNAMIC', 0, null,
        `${s.dbUniqueName} apply=${s.applyMode} transport=${s.transportMode}`,
        new Date().toISOString()]);
    });
    return queryResult(
      [
        col.num('FACILITY'),
        col.str('SEVERITY', 13),
        col.str('DEST_ID', 12),
        col.str('CALLOUT', 8),
        col.num('ERROR_CODE'),
        col.str('CONNECTION', 30),
        col.str('MESSAGE', 256),
        col.date('TIMESTAMP'),
      ],
      rows,
    );
  },
});

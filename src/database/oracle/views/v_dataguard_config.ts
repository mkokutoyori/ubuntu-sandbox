import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$DATAGUARD_CONFIG',
  comment: 'Data Guard configuration',
  query({ instance }) {
    const dg = instance.dataGuard;
    const rows: (string | number)[][] = [
      [instance.config.sid, 'PRIMARY', dg.protectionMode, dg.configurationStatus],
    ];
    for (const s of dg.getStandbys()) {
      rows.push([s.dbUniqueName, s.role, s.protectionMode, dg.configurationStatus]);
    }
    return queryResult(
      [
        col.str('DB_UNIQUE_NAME', 30),
        col.str('PARENT_DB_UNIQUE_NAME', 30),
        col.str('PROTECTION_MODE', 24),
        col.str('CONFIGURATION_STATUS', 8),
      ],
      rows,
    );
  },
});

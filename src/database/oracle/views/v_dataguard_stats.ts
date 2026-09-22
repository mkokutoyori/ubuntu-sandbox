import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$DATAGUARD_STATS',
  comment: 'Data Guard lag and apply statistics',
  query({ instance, runtime }) {
    const rows: (string | number)[][] = [];
    const lag = (n: number) => `+00 ${String(Math.floor(n / 3600)).padStart(2, '0')}:${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    const recu = runtime.archivedLogs[runtime.archivedLogs.length - 1]?.sequence ?? 0;
    const retard = Math.max(0, recu - instance.appliedSequence);
    if (instance.managedRecoveryActive || instance.appliedSequence > 0) {
      rows.push([instance.config.sid.toUpperCase(), 'apply lag', lag(retard), 'day(2) to second(0) interval', 1]);
      rows.push([instance.config.sid.toUpperCase(), 'apply finish time', lag(retard), 'day(2) to second(0) interval', 1]);
    }
    for (const s of instance.dataGuard.getStandbys()) {
      rows.push([s.dbUniqueName, 'apply lag', lag(s.applyLagSeconds), 'day(2) to second(0) interval', 1]);
      rows.push([s.dbUniqueName, 'transport lag', lag(s.transportLagSeconds), 'day(2) to second(0) interval', 1]);
      rows.push([s.dbUniqueName, 'estimated startup time', String(s.estimatedFailoverTimeSeconds), 'seconds', 1]);
    }
    return queryResult(
      [
        col.str('SOURCE_DB_UNIQUE_NAME', 30),
        col.str('NAME', 32),
        col.str('VALUE', 64),
        col.str('UNIT', 30),
        col.num('TIME_COMPUTED'),
      ],
      rows,
    );
  },
});

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';
import { liveSessionCounts } from './_sessionCounts';

registerView({
  name: 'V$RESOURCE_LIMIT',
  comment: 'Resource limits',
  query({ instance, catalog, runtime }) {
    const counts = liveSessionCounts(catalog, runtime);
    const processes = instance.getBackgroundProcesses().length
      + instance.getServerProcesses().length;
    const limit = (name: string): string => instance.getParameter(name) ?? 'UNLIMITED';
    const rows: (string | number)[][] = [
      ['processes', processes, Math.max(processes, counts.highWater), limit('processes'), limit('processes')],
      ['sessions', counts.current, Math.max(counts.current, counts.highWater),
        limit('sessions'), limit('sessions')],
      ['enqueue_locks', instance.lockManager.getHeldLocks().length, 0, '5588', '5588'],
      ['enqueue_resources', 0, 0, '2516', 'UNLIMITED'],
      ['ges_procs', 0, 0, '0', '0'],
      ['max_shared_servers', 0, 0, 'UNLIMITED', 'UNLIMITED'],
      ['parallel_max_servers', 0, 0, limit('parallel_max_servers'), limit('parallel_max_servers')],
    ];
    return queryResult(
      [
        { name: 'RESOURCE_NAME', dataType: oracleVarchar2(30) },
        { name: 'CURRENT_UTILIZATION', dataType: oracleNumber(10) },
        { name: 'MAX_UTILIZATION', dataType: oracleNumber(10) },
        { name: 'INITIAL_ALLOCATION', dataType: oracleVarchar2(10) },
        { name: 'LIMIT_VALUE', dataType: oracleVarchar2(10) },
      ],
      rows,
    );
  },
});

/**
 * V$LIBRARYCACHE — namespace-level library cache statistics.
 *
 * Derived from event-fed counters (parseTotal, parseHard, executions)
 * for each namespace.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const NAMESPACES = [
  'SQL AREA', 'TABLE/PROCEDURE', 'BODY', 'TRIGGER', 'INDEX',
  'CLUSTER', 'OBJECT', 'PIPE', 'JAVA SOURCE', 'JAVA RESOURCE',
];

registerView({
  name: 'V$LIBRARYCACHE',
  comment: 'Library cache statistics per namespace',
  query({ runtime, storage }) {
    const objs = storage.getAllTables().length + storage.getAllViews().length;
    return queryResult(
      [
        col.str('NAMESPACE', 32),
        col.num('GETS'),
        col.num('GETHITS'),
        col.num('GETHITRATIO'),
        col.num('PINS'),
        col.num('PINHITS'),
        col.num('PINHITRATIO'),
        col.num('RELOADS'),
        col.num('INVALIDATIONS'),
      ],
      NAMESPACES.map(ns => {
        const isSqlArea = ns === 'SQL AREA';
        const gets = isSqlArea ? runtime.counters.parseTotal : objs;
        const hits = isSqlArea ? runtime.counters.parseTotal - runtime.counters.parseHard : objs;
        const pins = isSqlArea ? runtime.counters.executions : objs;
        return [
          ns, gets, hits, gets ? hits / gets : 1,
          pins, pins, 1, 0, 0,
        ];
      })
    );
  },
});

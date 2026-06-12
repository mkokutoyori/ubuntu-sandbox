/**
 * DBA_MVIEWS — materialised views, read from the live catalog registry
 * (CREATE MATERIALIZED VIEW registers there; DML on a base table flips
 * STALENESS to STALE; DBMS_MVIEW.REFRESH restores FRESH).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_MVIEWS',
  comment: 'Materialised views',
  query({ catalog }) {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('MVIEW_NAME', 30),
        col.str('CONTAINER_NAME', 30),
        col.str('QUERY', 4000),
        col.str('REFRESH_MODE', 6),
        col.str('REFRESH_METHOD', 8),
        col.str('BUILD_MODE', 9),
        col.date('LAST_REFRESH_DATE'),
        col.str('STALENESS', 18),
      ],
      catalog.getMaterializedViews().map(mv => [
        mv.owner,
        mv.name,
        mv.name,
        mv.queryText,
        mv.refreshMode,
        mv.refreshMethod,
        mv.buildMode,
        mv.lastRefresh,
        mv.staleness,
      ]),
    );
  },
});

/**
 * DBA_REGISTRY_HISTORY — record of database install / patch / upgrade
 * events. Native to Oracle 10g+.
 *
 * Seeded with the initial CREATE entry the same way `catupgrd.sql`
 * stamps a fresh 19c install.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_REGISTRY_HISTORY',
  comment: 'Database install / patch / upgrade history',
  query({ instance }) {
    const created = instance.startupTime ?? new Date();
    return queryResult(
      [
        col.date('ACTION_TIME'),
        col.str('ACTION', 30),
        col.str('NAMESPACE', 30),
        col.str('VERSION', 30),
        col.num('ID'),
        col.str('BUNDLE_SERIES', 30),
        col.str('COMMENTS', 255),
      ],
      [
        [created.toISOString(), 'APPLY',   'SERVER', '19.0.0.0.0', 0, 'DBRU', 'Release_Update - 19.3.0.0.0'],
        [created.toISOString(), 'UPGRADE', 'SERVER', '19.0.0.0.0', 0, '',     'Upgraded from 18.0.0.0.0'],
      ],
    );
  },
});

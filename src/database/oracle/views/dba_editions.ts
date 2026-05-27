/**
 * DBA_EDITIONS — list of database editions used by edition-based
 * redefinition. Native to Oracle 11.2+; every database has at least
 * the implicit `ORA$BASE` root edition.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_EDITIONS',
  comment: 'Edition-based redefinition root catalogue',
  query({ instance }) {
    const created = (instance.startupTime ?? new Date()).toISOString();
    return queryResult(
      [
        col.str('EDITION_NAME', 128),
        col.str('PARENT_EDITION_NAME', 128),
        col.str('USABLE', 3),
      ],
      [['ORA$BASE', '', 'YES']],
    );
    // `created` would feed a future DBA_HIST_EDITIONS — kept here for
    // when we add it.
    void created;
  },
});

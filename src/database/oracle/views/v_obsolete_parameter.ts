/**
 * V$OBSOLETE_PARAMETER — init parameters that became obsolete.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const OBSOLETE = [
  'optimizer_search_limit', 'gc_files_to_locks', 'log_archive_buffer_size',
  'lock_sga_areas', 'use_indirect_data_buffers', 'rollback_segments',
  'optimizer_max_permutations', 'sql_trace', 'plsql_native_library_dir',
];

registerView({
  name: 'V$OBSOLETE_PARAMETER',
  comment: 'Obsolete init parameters',
  query() {
    return queryResult(
      [col.str('NAME', 80), col.str('ISSPECIFIED', 5), col.num('VALUE')],
      OBSOLETE.map(n => [n, 'FALSE', 0])
    );
  },
});

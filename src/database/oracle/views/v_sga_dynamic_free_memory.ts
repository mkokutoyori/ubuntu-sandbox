/**
 * V$SGA_DYNAMIC_FREE_MEMORY — free SGA reserve for dynamic resizing.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { parseSize as bytes } from './_fileSize';

registerView({
  name: 'V$SGA_DYNAMIC_FREE_MEMORY',
  comment: 'Free SGA reserve',
  query({ instance }) {
    const max = bytes(instance.getParameter('sga_max_size') ?? '1G');
    const target = bytes(instance.getParameter('sga_target') ?? '512M');
    return queryResult(
      [col.num('CURRENT_SIZE')],
      [[Math.max(0, max - target)]]
    );
  },
});

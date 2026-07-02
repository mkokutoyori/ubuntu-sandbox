/**
 * V$SGAINFO — SGA component sizes.
 *
 * Reads the live instance SGA configuration; component sizes change when
 * `ALTER SYSTEM SET sga_target = ...` publishes
 * `oracle.instance.parameter-changed`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { parseSize as bytes } from './_fileSize';

registerView({
  name: 'V$SGAINFO',
  comment: 'SGA component breakdown',
  query({ instance }) {
    const sga = instance.getSGAInfo();
    return queryResult(
      [col.str('NAME', 32), col.num('BYTES'), col.str('RESIZEABLE', 3)],
      [
        ['Fixed SGA Size', 2 * 1024 * 1024, 'No'],
        ['Variable Size', bytes(sga.sharedPool), 'Yes'],
        ['Database Buffers', bytes(sga.bufferCache), 'Yes'],
        ['Redo Buffers', bytes(sga.redoLogBuffer), 'No'],
        ['Maximum SGA Size', bytes(instance.getParameter('sga_max_size') ?? '1G'), 'No'],
        ['Granule Size', 4 * 1024 * 1024, 'No'],
        ['Java Pool Size', bytes(sga.javaPool), 'Yes'],
        ['Large Pool Size', bytes(sga.largePool), 'Yes'],
        ['Shared Pool Size', bytes(sga.sharedPool), 'Yes'],
        ['Streams Pool Size', bytes(instance.getParameter('streams_pool_size') ?? '0'), 'Yes'],
      ]
    );
  },
});

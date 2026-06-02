import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$IM_SEGMENTS',
  comment: 'In-Memory column store segments',
  query({ instance }) {
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('SEGMENT_NAME', 128),
        col.str('TABLESPACE_NAME', 30),
        col.num('INMEMORY_SIZE'),
        col.num('BYTES'),
        col.num('BYTES_NOT_POPULATED'),
        col.str('POPULATE_STATUS', 18),
        col.str('INMEMORY_PRIORITY', 8),
        col.str('INMEMORY_DISTRIBUTE', 16),
        col.str('INMEMORY_COMPRESSION', 24),
        col.str('INMEMORY_DUPLICATE', 13),
        col.num('CON_ID'),
      ],
      instance.inMemory.getSegments().map(s => [
        s.owner, s.segmentName, s.tablespaceName,
        s.inmemorySize, s.bytes, s.bytesNotPopulated,
        s.populateStatus, s.inmemoryPriority, s.inmemoryDistribute,
        s.inmemoryCompression, s.inmemoryDuplicate, s.conId,
      ]),
    );
  },
});

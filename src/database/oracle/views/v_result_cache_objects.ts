import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$RESULT_CACHE_OBJECTS',
  comment: 'SQL result cache cached objects',
  query({ instance }) {
    return queryResult(
      [
        col.num('ID'),
        col.str('TYPE', 11),
        col.str('STATUS', 9),
        col.num('BUCKET_NO'),
        col.num('HASH'),
        col.str('NAME', 1000),
        col.str('CACHE_ID', 32),
        col.str('CACHE_KEY', 100),
        col.num('BLOCK_COUNT'),
        col.num('COLUMN_COUNT'),
        col.num('PIN_COUNT'),
        col.num('SCAN_COUNT'),
        col.num('ROW_COUNT'),
        col.num('ROW_SIZE_MIN'),
        col.num('ROW_SIZE_MAX'),
        col.num('ROW_SIZE_AVG'),
        col.num('BUILD_TIME'),
        col.num('LRU_NUMBER'),
        col.num('OBJECT_NO'),
        col.num('DEPEND_COUNT'),
        col.str('CREATOR_UID', 30),
        col.date('CREATION_TIMESTAMP'),
        col.date('INVALIDATION_TIMESTAMP'),
        col.num('INVALIDATIONS'),
      ],
      instance.resultCache.getEntries().map(e => [
        e.id, e.type, e.status, e.bucketNo, e.hashKey, e.name,
        e.cacheId, e.cacheKey, e.blockCount, e.columnCount,
        e.pinCount, e.scanCount, e.rowCount,
        e.rowSize, e.rowSize, e.rowSize,
        0, 0, e.id, e.dependencyCount, e.creator,
        e.cachedAt.toISOString(),
        e.invalidatedAt ? e.invalidatedAt.toISOString() : null,
        e.invalidationsCount,
      ]),
    );
  },
});

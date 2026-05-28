import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$RESULT_CACHE_DEPENDENCY',
  comment: 'SQL result cache dependency objects',
  query({ instance }) {
    return queryResult(
      [
        col.num('ID'),
        col.str('OBJECT_OWNER', 128),
        col.str('OBJECT_NAME', 128),
        col.str('OBJECT_TYPE', 30),
        col.num('RESULT_ID'),
      ],
      instance.resultCache.getDependencies().map(d => [
        d.id, d.objectOwner, d.objectName, d.objectType, d.resultId,
      ]),
    );
  },
});

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$RSRC_CONSUMER_GROUP_CPU_MTH',
  comment: 'Resource consumer group CPU methods',
  query() {
    return queryResult(
      [col.str('VALUE', 128)],
      [['ROUND-ROBIN'], ['RUN-TO-COMPLETION']]
    );
  },
});

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_PROPAGATION',
  comment: 'Streams propagations',
  query({ instance }) {
    return queryResult(
      [
        col.str('PROPAGATION_NAME', 128),
        col.str('SOURCE_QUEUE_OWNER', 128),
        col.str('SOURCE_QUEUE_NAME', 128),
        col.str('DESTINATION_QUEUE_OWNER', 128),
        col.str('DESTINATION_QUEUE_NAME', 128),
        col.str('DESTINATION_DBLINK', 128),
        col.str('STATUS', 8),
        col.str('QUEUE_TO_QUEUE', 5),
        col.str('ERROR_MESSAGE', 4000),
      ],
      instance.replication.getPropagations().map(p => [
        p.propagationName, p.sourceQueueOwner, p.sourceQueueName,
        'STRMADMIN', p.destinationQueueName, p.destinationDbLink,
        p.status, p.queueToQueue, p.errorMessage,
      ]),
    );
  },
});

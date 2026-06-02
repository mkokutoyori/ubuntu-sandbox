import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_CAPTURE',
  comment: 'Streams / XStream capture processes',
  query({ instance }) {
    return queryResult(
      [
        col.str('CAPTURE_NAME', 128),
        col.str('QUEUE_NAME', 128),
        col.str('QUEUE_OWNER', 128),
        col.str('RULE_SET_NAME', 128),
        col.str('CAPTURE_USER', 128),
        col.str('START_SCN', 32),
        col.str('STATUS', 20),
        col.str('CAPTURED_SCN', 32),
        col.str('APPLIED_SCN', 32),
        col.str('ENQUEUED_SCN', 32),
        col.str('CAPTURE_TYPE', 16),
        col.date('CREATE_TIME'),
      ],
      instance.replication.getCaptures().map(c => [
        c.captureName, c.queueName, c.queueOwner, c.ruleSetName, 'STRMADMIN',
        String(c.startScn), c.state, String(c.capturedScn),
        String(c.appliedScn), String(c.enqueuedScn), c.captureType, c.createdAt.toISOString(),
      ]),
    );
  },
});

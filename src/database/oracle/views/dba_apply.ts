import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_APPLY',
  comment: 'Streams / XStream apply processes',
  query({ instance }) {
    return queryResult(
      [
        col.str('APPLY_NAME', 128),
        col.str('QUEUE_NAME', 128),
        col.str('QUEUE_OWNER', 128),
        col.str('APPLY_USER', 128),
        col.str('RULE_SET_NAME', 128),
        col.str('STATUS', 8),
        col.str('APPLY_DATABASE_LINK', 128),
        col.str('APPLY_TAG', 4000),
        col.str('APPLY_CAPTURED', 3),
        col.str('PRECOMMIT_HANDLER', 256),
        col.str('STATUS_CHANGE_TIME', 30),
        col.str('ERROR_NUMBER', 32),
        col.str('ERROR_MESSAGE', 4000),
        col.date('CREATE_TIME'),
      ],
      instance.replication.getApplies().map(a => [
        a.applyName, a.queueName, a.queueOwner, a.applyUser, a.ruleSetName,
        a.status, null, null, 'YES', null,
        new Date().toISOString(),
        null, a.errorMessage, a.createdAt.toISOString(),
      ]),
    );
  },
});

/**
 * DBA_DV_COMMAND_RULE — Database Vault command rules. Reads live
 * catalog state.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_DV_COMMAND_RULE',
  comment: 'Database Vault command rules',
  query({ catalog }) {
    const c = catalog as unknown as { getDvCommandRules?: () => { command: string; ruleSetName: string; objectOwner: string; objectName: string; enabled: boolean }[] };
    const rows = c.getDvCommandRules ? c.getDvCommandRules() : [];
    return queryResult(
      [
        col.str('COMMAND', 30),
        col.str('RULE_SET_NAME', 90),
        col.str('OBJECT_OWNER', 30),
        col.str('OBJECT_NAME', 128),
        col.str('ENABLED', 1),
      ],
      rows.map(r => [r.command, r.ruleSetName, r.objectOwner, r.objectName, r.enabled ? 'Y' : 'N'])
    );
  },
});

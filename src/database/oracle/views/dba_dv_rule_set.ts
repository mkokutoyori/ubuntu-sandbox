/**
 * DBA_DV_RULE_SET — Database Vault rule sets.
 *
 * One rule set per simulated SoD policy. Severity flows through
 * AUDIT_OPTIONS / FAIL_OPTIONS exactly as DBMS_MACADM.CREATE_RULE_SET
 * would persist them.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

function severityToCode(sev: string): number {
  // Matches DV's audit_options bit-field convention: 1 = log on
  // failure, 2 = log on success, 3 = both. Critical+High audit both.
  return sev === 'CRITICAL' || sev === 'HIGH' ? 3 : 1;
}

registerView({
  name: 'DBA_DV_RULE_SET',
  comment: 'Database Vault rule sets',
  query({ instance }) {
    const policies = instance.getAuditJournal().getSodPolicies();
    return queryResult(
      [
        col.str('RULE_SET_NAME', 90),
        col.str('DESCRIPTION', 1024),
        col.str('ENABLED', 1),
        col.str('EVAL_OPTIONS', 12),
        col.num('AUDIT_OPTIONS'),
        col.num('FAIL_OPTIONS'),
        col.str('FAIL_MESSAGE', 80),
        col.num('FAIL_CODE'),
        col.str('HANDLER_OPTIONS', 12),
        col.str('HANDLER', 200),
        col.str('IS_STATIC', 1),
      ],
      policies.map(p => [
        p.name, p.description, p.enabled ? 'Y' : 'N', 'ALL TRUE',
        severityToCode(p.severity), 2, `SoD violation: ${p.name}`,
        20000, '', '', 'N',
      ]),
    );
  },
});

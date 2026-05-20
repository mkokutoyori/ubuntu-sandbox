/**
 * DBA_AUDIT_MGMT_LAST_ARCH_TS — last archive timestamps recorded by
 * DBMS_AUDIT_MGMT.SET_LAST_ARCHIVE_TIMESTAMP. The simulator carries
 * one entry per audit-trail kind so the dictionary is non-empty.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const TRAILS = [
  'STANDARD AUDIT TRAIL',
  'FINE GRAINED AUDIT TRAIL',
  'OS AUDIT TRAIL',
  'XML AUDIT TRAIL',
  'UNIFIED AUDIT TRAIL',
];

registerView({
  name: 'DBA_AUDIT_MGMT_LAST_ARCH_TS',
  comment: 'Last archive timestamps for audit trails',
  query() {
    return queryResult(
      [
        col.str('AUDIT_TRAIL', 24),
        col.str('RAC_INSTANCE', 8),
        col.str('CONTAINER_GUID', 32),
        col.str('LAST_ARCHIVE_TS', 30),
      ],
      TRAILS.map(t => [t, '0', '0', '01-JAN-1970 00:00:00 +00:00'])
    );
  },
});

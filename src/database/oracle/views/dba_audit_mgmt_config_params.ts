/**
 * DBA_AUDIT_MGMT_CONFIG_PARAMS — DBMS_AUDIT_MGMT configuration values
 * controlling audit-trail retention, write mode, and archive cadence.
 * Populated with Oracle 19c's default tuning so monitoring scripts
 * receive an honest snapshot — the simulator does not let DBAs tune
 * audit-mgmt knobs, so values are stable.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

interface ConfigRow {
  parameterName: string;
  parameterValue: string;
  auditTrail: string;
}

const ROWS: ConfigRow[] = [
  { parameterName: 'AUDIT FILE MAX SIZE', parameterValue: '10000', auditTrail: 'OS' },
  { parameterName: 'AUDIT FILE MAX AGE',  parameterValue: '5', auditTrail: 'OS' },
  { parameterName: 'DB AUDIT TABLESPACE', parameterValue: 'SYSAUX', auditTrail: 'DB STANDARD AUDIT TRAIL' },
  { parameterName: 'DB AUDIT CLEAN BATCH SIZE', parameterValue: '10000', auditTrail: 'DB STANDARD AUDIT TRAIL' },
  { parameterName: 'OS FILE CLEAN BATCH SIZE', parameterValue: '1000', auditTrail: 'OS' },
  { parameterName: 'AUDIT WRITE MODE',    parameterValue: 'IMMEDIATE WRITE MODE', auditTrail: 'UNIFIED AUDIT TRAIL' },
  { parameterName: 'AUDIT FLUSH INTERVAL', parameterValue: '3', auditTrail: 'UNIFIED AUDIT TRAIL' },
];

registerView({
  name: 'DBA_AUDIT_MGMT_CONFIG_PARAMS',
  comment: 'DBMS_AUDIT_MGMT configuration parameters',
  query() {
    return queryResult(
      [
        col.str('PARAMETER_NAME', 64),
        col.str('PARAMETER_VALUE', 4000),
        col.str('AUDIT_TRAIL', 28),
      ],
      ROWS.map(r => [r.parameterName, r.parameterValue, r.auditTrail])
    );
  },
});

/**
 * DBA_PROFILES — resource/password profile limits.
 *
 * Authoritative source is the SecurityEngine ProfileManager; a legacy
 * fallback synthesises the standard limits from the catalog's custom
 * profile overrides when no SecurityEngine is wired.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

const PROFILE_RESOURCES: [string, string, string][] = [
  ['COMPOSITE_LIMIT', 'KERNEL', 'UNLIMITED'],
  ['SESSIONS_PER_USER', 'KERNEL', 'UNLIMITED'],
  ['CPU_PER_SESSION', 'KERNEL', 'UNLIMITED'],
  ['CPU_PER_CALL', 'KERNEL', 'UNLIMITED'],
  ['LOGICAL_READS_PER_SESSION', 'KERNEL', 'UNLIMITED'],
  ['LOGICAL_READS_PER_CALL', 'KERNEL', 'UNLIMITED'],
  ['IDLE_TIME', 'KERNEL', 'UNLIMITED'],
  ['CONNECT_TIME', 'KERNEL', 'UNLIMITED'],
  ['PRIVATE_SGA', 'KERNEL', 'UNLIMITED'],
  ['FAILED_LOGIN_ATTEMPTS', 'PASSWORD', '10'],
  ['PASSWORD_LIFE_TIME', 'PASSWORD', '180'],
  ['PASSWORD_REUSE_TIME', 'PASSWORD', 'UNLIMITED'],
  ['PASSWORD_REUSE_MAX', 'PASSWORD', 'UNLIMITED'],
  ['PASSWORD_LOCK_TIME', 'PASSWORD', '1'],
  ['PASSWORD_GRACE_TIME', 'PASSWORD', '7'],
  ['PASSWORD_VERIFY_FUNCTION', 'PASSWORD', 'NULL'],
];

registerView({
  name: 'DBA_PROFILES',
  comment: 'Resource limit profiles',
  query({ catalog }) {
    const cols = [
      { name: 'PROFILE', dataType: oracleVarchar2(128) },
      { name: 'RESOURCE_NAME', dataType: oracleVarchar2(32) },
      { name: 'RESOURCE_TYPE', dataType: oracleVarchar2(8) },
      { name: 'LIMIT', dataType: oracleVarchar2(128) },
    ];
    const engine = catalog.getSecurityEngine();
    if (engine) {
      const profileRows = engine.profiles.getAllProfileRows();
      return queryResult(cols, profileRows.map(r => [r.profile, r.resourceName, r.resourceType, r.limit]));
    }
    const rows: (string | number | null)[][] = [];
    for (const [resName, resType, defaultLimit] of PROFILE_RESOURCES) {
      rows.push(['DEFAULT', resName, resType, defaultLimit]);
    }
    for (const [profileName, overrides] of catalog.getProfiles()) {
      for (const [resName, resType] of PROFILE_RESOURCES) {
        const limit = overrides.get(resName) ?? 'DEFAULT';
        rows.push([profileName, resName, resType, limit]);
      }
    }
    return queryResult(cols, rows);
  },
});

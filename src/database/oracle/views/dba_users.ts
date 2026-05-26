/**
 * DBA_USERS — database accounts. Account status / expiry are derived
 * live from the SecurityEngine PasswordManager + ProfileManager.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_USERS',
  comment: 'Database users',
  query({ catalog, instance }) {
    const users = catalog.getAllUsers();
    const engine = catalog.getSecurityEngine();
    // Build a username → most-recent successful connection map so the
    // native DBA_USERS.LAST_LOGIN column is populated coherently with
    // DBA_CONNECTION_TRACES / UNIFIED_AUDIT_TRAIL.
    const lastLogin = new Map<string, string>();
    for (const t of instance.getAuditJournal().getConnectionTraces()) {
      if (t.outcome !== 'SUCCESS') continue;
      const existing = lastLogin.get(t.username);
      if (!existing || existing < t.timestamp.toISOString()) {
        lastLogin.set(t.username, t.timestamp.toISOString());
      }
    }
    // SYS-supplied / Oracle-maintained schemas — kept in sync with what
    // a fresh 19c install actually carries. Any other user is reported
    // as not Oracle-maintained.
    const ORACLE_MAINTAINED = new Set([
      'SYS', 'SYSTEM', 'PUBLIC', 'XDB', 'OUTLN', 'DBSNMP', 'APPQOSSYS',
      'GSMADMIN_INTERNAL', 'WMSYS', 'XS$NULL', 'ORACLE_OCM', 'CTXSYS',
      'ANONYMOUS', 'AUDSYS', 'DVSYS', 'DVF', 'LBACSYS', 'OJVMSYS',
      'OLAPSYS', 'ORDDATA', 'ORDPLUGINS', 'ORDSYS', 'SI_INFORMTN_SCHEMA',
      'SYSBACKUP', 'SYSDG', 'SYSKM', 'SYSRAC', 'MDSYS', 'EXFSYS',
    ]);
    return queryResult(
      [
        { name: 'USERNAME', dataType: oracleVarchar2(128) },
        { name: 'USER_ID', dataType: oracleNumber(10) },
        { name: 'ACCOUNT_STATUS', dataType: oracleVarchar2(32) },
        { name: 'LOCK_DATE', dataType: oracleDate() },
        { name: 'EXPIRY_DATE', dataType: oracleDate() },
        { name: 'DEFAULT_TABLESPACE', dataType: oracleVarchar2(30) },
        { name: 'TEMPORARY_TABLESPACE', dataType: oracleVarchar2(30) },
        { name: 'CREATED', dataType: oracleDate() },
        { name: 'PROFILE', dataType: oracleVarchar2(128) },
        { name: 'AUTHENTICATION_TYPE', dataType: oracleVarchar2(8) },
        { name: 'EXTERNAL_NAME', dataType: oracleVarchar2(4000) },
        { name: 'COMMON', dataType: oracleVarchar2(3) },
        { name: 'ORACLE_MAINTAINED', dataType: oracleVarchar2(1) },
        { name: 'INHERITED', dataType: oracleVarchar2(3) },
        { name: 'DEFAULT_COLLATION', dataType: oracleVarchar2(100) },
        { name: 'IMPLICIT', dataType: oracleVarchar2(3) },
        { name: 'ALL_SHARD', dataType: oracleVarchar2(3) },
        { name: 'PASSWORD_VERSIONS', dataType: oracleVarchar2(17) },
        { name: 'EDITIONS_ENABLED', dataType: oracleVarchar2(1) },
        { name: 'LAST_LOGIN', dataType: oracleDate() },
        { name: 'LCOUNT', dataType: oracleNumber(10) },
      ],
      users.map(u => {
        let expiryDate: Date | null = u.expiryDate;
        let accountStatus: string = u.accountStatus;
        let failedLoginCount = 0;
        if (engine) {
          const lifetimeDays = engine.profiles.resolvePasswordLifetimeDays(u.profile);
          expiryDate = engine.passwords.computeExpiryDate(u.username, lifetimeDays);
          const isLocked = u.accountStatus === 'LOCKED' || u.accountStatus === 'EXPIRED & LOCKED';
          const pwStatus = engine.passwords.getPasswordStatus(
            u.username,
            lifetimeDays,
            engine.profiles.resolvePasswordGraceDays(u.profile)
          );
          const isExpired = pwStatus === 'EXPIRED' || pwStatus === 'EXPIRED(GRACE)';
          if (isLocked && isExpired) accountStatus = 'EXPIRED & LOCKED';
          else if (isLocked) accountStatus = 'LOCKED';
          else if (isExpired) accountStatus = pwStatus === 'EXPIRED(GRACE)' ? 'EXPIRED(GRACE)' : 'EXPIRED';
          else accountStatus = 'OPEN';
          const tracker = (engine as unknown as { loginTracker?: { getFailedCount?: (u: string) => number } }).loginTracker;
          failedLoginCount = tracker?.getFailedCount?.(u.username) ?? 0;
        }
        const oracleMaintained = ORACLE_MAINTAINED.has(u.username) ? 'Y' : 'N';
        return [
          u.username, u.userId, accountStatus,
          u.lockDate ? u.lockDate.toISOString() : null,
          expiryDate ? expiryDate.toISOString() : null,
          u.defaultTablespace, u.temporaryTablespace,
          u.created.toISOString(), u.profile, u.authenticationType,
          u.externalName ?? null,
          'NO',                                          // COMMON
          oracleMaintained,                              // ORACLE_MAINTAINED
          'NO',                                          // INHERITED
          'USING_NLS_COMP',                              // DEFAULT_COLLATION
          'NO',                                          // IMPLICIT
          'NO',                                          // ALL_SHARD
          '11G 12C',                                     // PASSWORD_VERSIONS
          'N',                                           // EDITIONS_ENABLED
          lastLogin.get(u.username) ?? null,             // LAST_LOGIN
          failedLoginCount,                              // LCOUNT
        ];
      })
    );
  },
});

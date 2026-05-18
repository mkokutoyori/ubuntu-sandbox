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
  query({ catalog }) {
    const users = catalog.getAllUsers();
    const engine = catalog.getSecurityEngine();
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
      ],
      users.map(u => {
        let expiryDate: Date | null = u.expiryDate;
        let accountStatus: string = u.accountStatus;
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
        }
        return [
          u.username, u.userId, accountStatus,
          u.lockDate ? u.lockDate.toISOString() : null,
          expiryDate ? expiryDate.toISOString() : null,
          u.defaultTablespace, u.temporaryTablespace,
          u.created.toISOString(), u.profile, u.authenticationType,
        ];
      })
    );
  },
});

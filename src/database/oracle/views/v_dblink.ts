import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

const YES_NO = (flag: boolean): string => (flag ? 'YES' : 'NO');

registerView({
  name: 'V$DBLINK',
  comment: 'Currently-open database links',
  query(ctx) {
    const owner = ctx.currentUser.toUpperCase();
    const rows = [...ctx.runtime.openDbLinks.values()]
      .filter((link) => link.owner === owner)
      .map((link) => [
        link.dbLink,
        ctx.catalog.getUser(link.owner)?.userId ?? 0,
        YES_NO(link.loggedOn),
        YES_NO(link.heterogeneous),
        link.protocol,
        0,
        YES_NO(link.inTransaction),
        YES_NO(link.updateSent),
        1,
        new Date(link.openedAt),
      ]);
    return queryResult(
      [
        { name: 'DB_LINK', dataType: oracleVarchar2(128) },
        { name: 'OWNER_ID', dataType: oracleNumber(10) },
        { name: 'LOGGED_ON', dataType: oracleVarchar2(3) },
        { name: 'HETEROGENEOUS', dataType: oracleVarchar2(3) },
        { name: 'PROTOCOL', dataType: oracleVarchar2(6) },
        { name: 'OPEN_CURSORS', dataType: oracleNumber(10) },
        { name: 'IN_TRANSACTION', dataType: oracleVarchar2(3) },
        { name: 'UPDATE_SENT', dataType: oracleVarchar2(3) },
        { name: 'COMMIT_POINT_STRENGTH', dataType: oracleNumber(10) },
        { name: 'INSTANT', dataType: oracleDate() },
      ],
      rows
    );
  },
});

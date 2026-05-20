/**
 * DBA_TRIGGERS — database triggers. No trigger store yet; Oracle 19c
 * column shape preserved so auditor scripts run unmodified.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_TRIGGERS',
  comment: 'Database triggers',
  query({ storage }) {
    const triggers = storage.getAllTriggers?.() ?? [];
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'TRIGGER_NAME', dataType: oracleVarchar2(30) },
        { name: 'TRIGGER_TYPE', dataType: oracleVarchar2(16) },
        { name: 'TRIGGERING_EVENT', dataType: oracleVarchar2(227) },
        { name: 'TABLE_OWNER', dataType: oracleVarchar2(30) },
        { name: 'BASE_OBJECT_TYPE', dataType: oracleVarchar2(16) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'COLUMN_NAME', dataType: oracleVarchar2(4000) },
        { name: 'REFERENCING_NAMES', dataType: oracleVarchar2(128) },
        { name: 'WHEN_CLAUSE', dataType: oracleVarchar2(4000) },
        { name: 'STATUS', dataType: oracleVarchar2(8) },
        { name: 'DESCRIPTION', dataType: oracleVarchar2(4000) },
        { name: 'ACTION_TYPE', dataType: oracleVarchar2(11) },
        { name: 'TRIGGER_BODY', dataType: oracleVarchar2(4000) },
      ],
      triggers.map(t => [
        t.schema, t.name,
        t.timing === 'INSTEAD OF' ? 'INSTEAD OF' : (t.forEachRow ? `${t.timing} EACH ROW` : t.timing),
        t.events.join(' OR '),
        t.tableSchema, 'TABLE', t.tableName,
        null, 'REFERENCING NEW AS NEW OLD AS OLD', null,
        t.enabled ? 'ENABLED' : 'DISABLED',
        `${t.timing} ${t.events.join(' OR ')} ON ${t.tableSchema}.${t.tableName}`,
        'PL/SQL',
        t.body,
      ])
    );
  },
});

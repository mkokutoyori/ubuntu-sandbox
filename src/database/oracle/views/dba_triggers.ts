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
  query({ storage, instance }) {
    const triggers = storage.getAllTriggers?.() ?? [];
    const sysTriggers = instance.systemTriggers.list();
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
      [
        ...triggers.map(t => [
          t.schema, t.name,
          t.timing === 'INSTEAD OF' ? 'INSTEAD OF' : (t.forEachRow ? `${t.timing} EACH ROW` : t.timing),
          t.events.join(' OR '),
          t.tableSchema, 'TABLE', t.tableName,
          null, 'REFERENCING NEW AS NEW OLD AS OLD', null,
          t.enabled ? 'ENABLED' : 'DISABLED',
          `${t.timing} ${t.events.join(' OR ')} ON ${t.tableSchema}.${t.tableName}`,
          'PL/SQL',
          t.body,
        ]),
        ...sysTriggers.map(s => [
          s.owner, s.name,
          `${s.timing} EVENT`,
          s.event,
          s.scopeSchema ?? '', s.scope,                       // TABLE_OWNER, BASE_OBJECT_TYPE
          s.scopeSchema ?? '',
          null, '', null,
          s.enabled ? 'ENABLED' : 'DISABLED',
          `${s.timing} ${s.event} ON ${s.scope === 'DATABASE' ? 'DATABASE' : `${s.scopeSchema}.SCHEMA`}`,
          'PL/SQL',
          s.body,
        ]),
      ],
    );
  },
});

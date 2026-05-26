/**
 * REDACTION_COLUMNS — one row per redacted column. Native to
 * Oracle 12c+; populated by DBMS_REDACT.ADD_POLICY / ALTER_POLICY.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'REDACTION_COLUMNS',
  comment: 'Columns redacted by Data Redaction',
  query({ instance }) {
    return queryResult(
      [
        col.str('OBJECT_OWNER', 128),
        col.str('OBJECT_NAME', 128),
        col.str('COLUMN_NAME', 128),
        col.str('FUNCTION_TYPE', 25),
        col.str('FUNCTION_PARAMETERS', 1000),
        col.str('REGEXP_PATTERN', 1000),
        col.str('REGEXP_REPLACE_STRING', 1000),
        col.num('REGEXP_POSITION'),
        col.num('REGEXP_OCCURRENCE'),
        col.str('REGEXP_MATCH_PARAMETER', 30),
        col.str('COLUMN_DESCRIPTION', 4000),
      ],
      instance.redaction.getColumns().map(c => [
        c.objectOwner, c.objectName, c.columnName, c.functionType,
        c.functionParameters, c.regexpPattern, c.regexpReplaceString,
        c.regexpPosition, c.regexpOccurrence, c.regexpMatchParameter,
        c.columnDescription,
      ]),
    );
  },
});

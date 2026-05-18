/**
 * V$DIAG_INFO — ADR diagnostic locations, derived from ORACLE_CONFIG.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';
import { ORACLE_CONFIG } from '../../../terminal/commands/OracleConfig';

registerView({
  name: 'V$DIAG_INFO',
  comment: 'Diagnostic repository info',
  query() {
    const base = ORACLE_CONFIG.BASE;
    const diagBase = ORACLE_CONFIG.DIAG_HOME;
    return queryResult(
      [
        { name: 'NAME', dataType: oracleVarchar2(64) },
        { name: 'VALUE', dataType: oracleVarchar2(512) },
      ],
      [
        ['Diag Trace', ORACLE_CONFIG.DIAG_TRACE],
        ['Diag Alert', ORACLE_CONFIG.DIAG_TRACE],
        ['Diag Incident', `${diagBase}/incident`],
        ['ADR Base', base],
        ['ADR Home', diagBase],
      ]
    );
  },
});

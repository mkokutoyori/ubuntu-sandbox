/**
 * V$SQLFN_METADATA — catalogue of built-in SQL functions.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

export const SQLFN_CATALOGUE: ReadonlyArray<{
  funcId: number; name: string; descr: string; type: 'NORMAL' | 'AGGREGATE' | 'ANALYTIC';
  args: number; returnType: string;
}> = [
  { funcId: 1, name: 'NVL', descr: 'Null replacement', type: 'NORMAL', args: 2, returnType: 'ANY' },
  { funcId: 2, name: 'DECODE', descr: 'CASE-like decode', type: 'NORMAL', args: -1, returnType: 'ANY' },
  { funcId: 3, name: 'COUNT', descr: 'Count', type: 'AGGREGATE', args: 1, returnType: 'NUMBER' },
  { funcId: 4, name: 'SUM', descr: 'Sum', type: 'AGGREGATE', args: 1, returnType: 'NUMBER' },
  { funcId: 5, name: 'AVG', descr: 'Average', type: 'AGGREGATE', args: 1, returnType: 'NUMBER' },
  { funcId: 6, name: 'MIN', descr: 'Minimum', type: 'AGGREGATE', args: 1, returnType: 'ANY' },
  { funcId: 7, name: 'MAX', descr: 'Maximum', type: 'AGGREGATE', args: 1, returnType: 'ANY' },
  { funcId: 8, name: 'UPPER', descr: 'Uppercase', type: 'NORMAL', args: 1, returnType: 'VARCHAR2' },
  { funcId: 9, name: 'LOWER', descr: 'Lowercase', type: 'NORMAL', args: 1, returnType: 'VARCHAR2' },
  { funcId: 10, name: 'SUBSTR', descr: 'Substring', type: 'NORMAL', args: 3, returnType: 'VARCHAR2' },
  { funcId: 11, name: 'LENGTH', descr: 'String length', type: 'NORMAL', args: 1, returnType: 'NUMBER' },
  { funcId: 12, name: 'TRIM', descr: 'Trim whitespace', type: 'NORMAL', args: 1, returnType: 'VARCHAR2' },
  { funcId: 13, name: 'TO_CHAR', descr: 'Convert to string', type: 'NORMAL', args: 2, returnType: 'VARCHAR2' },
  { funcId: 14, name: 'TO_NUMBER', descr: 'Convert to number', type: 'NORMAL', args: 1, returnType: 'NUMBER' },
  { funcId: 15, name: 'TO_DATE', descr: 'Convert to date', type: 'NORMAL', args: 2, returnType: 'DATE' },
  { funcId: 16, name: 'SYSDATE', descr: 'Current date', type: 'NORMAL', args: 0, returnType: 'DATE' },
  { funcId: 17, name: 'SYSTIMESTAMP', descr: 'Current timestamp', type: 'NORMAL', args: 0, returnType: 'TIMESTAMP' },
  { funcId: 18, name: 'ROW_NUMBER', descr: 'Window row number', type: 'ANALYTIC', args: 0, returnType: 'NUMBER' },
  { funcId: 19, name: 'RANK', descr: 'Window rank', type: 'ANALYTIC', args: 0, returnType: 'NUMBER' },
  { funcId: 20, name: 'DENSE_RANK', descr: 'Window dense rank', type: 'ANALYTIC', args: 0, returnType: 'NUMBER' },
];

registerView({
  name: 'V$SQLFN_METADATA',
  comment: 'Built-in SQL function catalogue',
  query() {
    return queryResult(
      [
        col.num('FUNC_ID'),
        col.str('NAME', 30),
        col.num('MINARGS'),
        col.num('MAXARGS'),
        col.str('DATATYPE', 16),
        col.str('VERSION', 12),
        col.str('ANALYTIC', 3),
        col.str('AGGREGATE', 3),
        col.str('DISP_TYPE', 16),
        col.str('DESCR', 80),
      ],
      SQLFN_CATALOGUE.map(f => [
        f.funcId, f.name,
        f.args === -1 ? 1 : f.args, f.args === -1 ? 255 : f.args,
        f.returnType, '19.0.0',
        f.type === 'ANALYTIC' ? 'YES' : 'NO',
        f.type === 'AGGREGATE' ? 'YES' : 'NO',
        f.type, f.descr,
      ])
    );
  },
});

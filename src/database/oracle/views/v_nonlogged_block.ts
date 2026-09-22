/**
 * V$NONLOGGED_BLOCK — blocks flagged as nonlogged, un par tablespace
 * dont l'ecriture n'a pas laisse de redo.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$NONLOGGED_BLOCK',
  comment: 'Nonlogged blocks reported by datafiles',
  query({ storage, runtime }) {
    const parTablespace = new Map<string, number>(
      storage.listDatafiles().map(df => [df.tablespace.toUpperCase(), df.fileNo]));
    return queryResult(
      [
        { name: 'FILE#', dataType: oracleNumber(10) },
        { name: 'BLOCK#', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
        { name: 'NONLOGGED_START_CHANGE#', dataType: oracleNumber(20) },
        { name: 'NONLOGGED_END_CHANGE#', dataType: oracleNumber(20) },
        { name: 'RESETLOGS_CHANGE#', dataType: oracleNumber(20) },
        { name: 'OBJECT#', dataType: oracleNumber(20) },
        { name: 'REASON', dataType: oracleVarchar2(64) },
      ],
      runtime.nonloggedRanges.map(r => [
        parTablespace.get(r.tablespace.toUpperCase()) ?? 0,
        1, r.blocks, r.startScn, r.endScn, 1, 0, r.reason,
      ])
    );
  },
});

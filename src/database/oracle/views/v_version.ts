/**
 * V$VERSION — Oracle version banner. Sourced from the live instance.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$VERSION',
  comment: 'Oracle version information',
  query({ instance }) {
    return queryResult(
      [{ name: 'BANNER', dataType: oracleVarchar2(200) }],
      instance.getVersionBanner().map(b => [b])
    );
  },
});

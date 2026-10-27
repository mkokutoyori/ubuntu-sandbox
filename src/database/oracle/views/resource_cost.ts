import { queryResult } from '../../engine/executor/ResultSet';
import { oracleNumber, oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'RESOURCE_COST',
  comment: 'Unit cost of each resource weighted by COMPOSITE_LIMIT',
  query({ catalog }) {
    const costs = catalog.getSecurityEngine()?.profiles.getResourceCosts() ?? new Map<string, number>();
    return queryResult(
      [
        { name: 'RESOURCE_NAME', dataType: oracleVarchar2(32) },
        { name: 'UNIT_COST', dataType: oracleNumber(22) },
      ],
      [...costs].map(([name, unitCost]) => [name, unitCost]),
    );
  },
});

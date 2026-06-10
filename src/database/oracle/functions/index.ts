import { SqlFunctionRegistry } from './SqlFunctionRegistry';
import { stringFunctions } from './stringFunctions';
import { numericFunctions } from './numericFunctions';
import { dateFunctions } from './dateFunctions';
import { conversionFunctions } from './conversionFunctions';
import { nullFunctions } from './nullFunctions';
import { systemFunctions } from './systemFunctions';
import { packageFunctions } from './packageFunctions';

export { SqlFunctionRegistry } from './SqlFunctionRegistry';
export type { SqlFunctionContext, SqlFunctionImpl, SqlFunctionBundle } from './types';

export function createDefaultSqlFunctionRegistry(): SqlFunctionRegistry {
  const registry = new SqlFunctionRegistry();
  registry.registerBundle(stringFunctions);
  registry.registerBundle(numericFunctions);
  registry.registerBundle(dateFunctions);
  registry.registerBundle(conversionFunctions);
  registry.registerBundle(nullFunctions);
  registry.registerBundle(systemFunctions);
  registry.registerBundle(packageFunctions);
  return registry;
}

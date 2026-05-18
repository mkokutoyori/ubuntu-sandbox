/**
 * PRODUCT_COMPONENT_VERSION — Oracle component version banner.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'PRODUCT_COMPONENT_VERSION',
  comment: 'Product component versions',
  query() {
    return queryResult(
      [col.str('PRODUCT', 64), col.str('VERSION', 17), col.str('STATUS', 17)],
      [
        ['Oracle Database 19c Enterprise Edition', '19.3.0.0.0', 'Production'],
        ['PL/SQL', '19.3.0.0.0', 'Production'],
        ['CORE', '19.3.0.0.0', 'Production'],
        ['TNS for Linux:', '19.3.0.0.0', 'Production'],
        ['NLSRTL', '19.3.0.0.0', 'Production'],
      ]
    );
  },
});

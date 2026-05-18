/**
 * V$PARAMETER — current session/system initialization parameters.
 * Sourced live from the instance parameter store.
 */

import { registerView } from './registry';
import { buildVParameter } from './_params';

registerView({
  name: 'V$PARAMETER',
  comment: 'System parameters',
  query({ instance }) {
    return buildVParameter(instance);
  },
});

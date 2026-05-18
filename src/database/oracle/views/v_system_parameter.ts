/**
 * V$SYSTEM_PARAMETER — system-scope initialization parameters.
 * Same projection as V$PARAMETER in this single-instance simulator.
 */

import { registerView } from './registry';
import { buildVParameter } from './_params';

registerView({
  name: 'V$SYSTEM_PARAMETER',
  comment: 'System-scope parameters',
  query({ instance }) {
    return buildVParameter(instance);
  },
});

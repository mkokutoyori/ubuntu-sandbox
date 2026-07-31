/**
 * V$CLUSTER_INTERCONNECTS — the private interconnect NIC(s) this
 * instance uses for Cache Fusion, one row per NIC. Real Oracle always
 * exposes this view; it is simply empty on a standalone (non-RAC)
 * instance — same behaviour here.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { getClusterForDevice } from '../rac/RacClusterRegistry';

registerView({
  name: 'V$CLUSTER_INTERCONNECTS',
  comment: 'Cluster interconnects used by Cache Fusion',
  query({ instance }) {
    const cols = [col.str('NAME', 15), col.str('IP_ADDRESS', 40), col.str('IS_PUBLIC', 3), col.str('SOURCE', 31)];
    const cluster = getClusterForDevice(instance.getDeviceId());
    const member = cluster?.members.get(instance.getDeviceId());
    if (!cluster || !member || member.status !== 'ACTIVE') return queryResult(cols, []);
    return queryResult(cols, [[member.interconnectIface, member.interconnectIp, 'NO', 'Oracle Cluster Repository']]);
  },
});

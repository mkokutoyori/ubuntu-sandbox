import type { MACAddress } from '../../../core/types';
import type { FirewallLogDraft } from './FirewallLogStore';

export const IP_CONFLICT_LOG_ID = '0100032701';

export interface IpConflictSighting {
  readonly address: string;
  readonly claimedBy: MACAddress;
  readonly detectedOn: string;
  readonly owner: string;
  readonly ownerMac: MACAddress;
}

export function ipConflictLogDraft(at: number, sighting: IpConflictSighting): FirewallLogDraft {
  return {
    at,
    type: 'event',
    subtype: 'system',
    level: 'error',
    id: IP_CONFLICT_LOG_ID,
    fields: {
      logdesc: 'Detected IP conflicts on FGT interfaces.',
      msg: `Duplicate IP address ${sighting.address} of MAC ${sighting.claimedBy.toString()}`
        + ` was detected on interface ${sighting.detectedOn},`
        + ` also in use by ${sighting.owner} (${sighting.ownerMac.toString()})`,
    },
  };
}

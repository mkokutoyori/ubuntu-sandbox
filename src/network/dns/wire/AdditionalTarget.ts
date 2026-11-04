import { RRType } from '@/network/dns/wire/RRType';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';

export function additionalSectionTarget(rr: ResourceRecord<ResourceRecordData>): string | null {
  switch (rr.data.type) {
    case RRType.NS: return rr.data.nsdname;
    case RRType.MX: return rr.data.exchange;
    case RRType.SRV: return rr.data.target;
    default: return null;
  }
}

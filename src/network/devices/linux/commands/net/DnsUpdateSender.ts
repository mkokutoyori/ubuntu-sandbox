import type { IPAddress } from '@/network/core/types';
import type { DnsUpdateRequest } from '@/network/dns/update/DnsUpdate';
import type { DynamicUpdateOutcome } from '@/network/dns/update/DynamicUpdateClient';
import type { TsigKey } from '@/network/dns/tsig/Tsig';

export type DnsUpdateSender = (
  server: IPAddress,
  request: DnsUpdateRequest,
  key?: TsigKey,
) => Promise<DynamicUpdateOutcome>;

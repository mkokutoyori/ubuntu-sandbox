import { IPAddress, IPv6Address } from '../../../core/types';
import {
  orderDestinations, type DestinationPolicy, type DestinationSelectionPort, type SelectableAddress,
} from '../../../layers/internet/DestinationSelection';
import type { NameServiceSwitch } from './NameServiceSwitch';
import type { INssSource } from './INssSource';
import type { NssHostEntry, NssHostent, NssResult } from './types';

export interface HostLookupFailure {
  readonly failure: string;
}

export interface AddressInfo {
  readonly canonicalName: string;
  readonly addresses: readonly string[];
}

export interface HostEntry {
  readonly name: string;
  readonly aliases: readonly string[];
}

const GAI_NO_NAME = 'Name or service not known';
const GAI_AGAIN = 'Temporary failure in name resolution';
const HOST_NOT_FOUND = 'Unknown host';
const HOST_TRY_AGAIN = 'Host name lookup failure';

const addressOf = (entry: NssHostEntry): SelectableAddress =>
  entry.addressFamily === 10 ? new IPv6Address(entry.address) : new IPAddress(entry.address);

const byName = (name: string, family?: 2 | 10) => (source: INssSource): Promise<NssResult<NssHostEntry[]>> | NssResult<NssHostEntry[]> | undefined =>
  source.gethostbyname4?.(name, family) ?? source.gethostbynameAsync?.(name, family) ?? source.gethostbyname?.(name, family);

export interface DestinationOrdering {
  readonly port: DestinationSelectionPort;
  readonly policy: DestinationPolicy;
}

export async function getAddrInfo(
  nss: NameServiceSwitch, name: string, ordering: DestinationOrdering,
): Promise<AddressInfo | HostLookupFailure> {
  const found = await nss.lookupAsync<NssHostEntry[]>('hosts', byName(name));
  if (found.status !== 'SUCCESS' || found.entry === undefined || found.entry.length === 0) {
    return { failure: found.status === 'TRYAGAIN' ? GAI_AGAIN : GAI_NO_NAME };
  }
  const ordered = orderDestinations(found.entry, addressOf, ordering.port, ordering.policy);
  return {
    canonicalName: found.entry[0].canonicalName,
    addresses: ordered.map((entry) => addressOf(entry).toString()),
  };
}

export async function getHostByName(nss: NameServiceSwitch, name: string): Promise<HostEntry | HostLookupFailure> {
  const found = await nss.lookupAsync<NssHostent>(
    'hosts', (source) => source.gethostbyname3Async?.(name, 2) ?? source.gethostbyname3?.(name, 2),
  );
  if (found.status !== 'SUCCESS' || found.entry === undefined) {
    return { failure: found.status === 'TRYAGAIN' ? HOST_TRY_AGAIN : HOST_NOT_FOUND };
  }
  return { name: found.entry.name, aliases: found.entry.aliases };
}

export const isHostLookupFailure = (value: object): value is HostLookupFailure => 'failure' in value;

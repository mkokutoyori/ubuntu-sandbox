import type { NameServiceSwitch } from '../../nss/NameServiceSwitch';
import type { NssEthersEntry, NssNetworkEntry, NssProtocolEntry, NssServiceEntry } from '../../nss/types';
import { forwardAddressOfAsync, reverseNameOfAsync } from '../ReverseName';
import type { CaptureNames } from './TcpdumpNames';

export function nssCaptureNames(nss: NameServiceSwitch): CaptureNames {
  return {
    servicePort: (name, protocol) => {
      const found = nss.lookup<NssServiceEntry>('services', (s) => s.getservbyname?.(name, protocol));
      return found.status === 'SUCCESS' && found.entry ? found.entry.port : null;
    },
    serviceName: (port, protocol) => {
      const found = nss.lookup<NssServiceEntry>('services', (s) => s.getservbyport?.(port, protocol));
      return found.status === 'SUCCESS' && found.entry ? found.entry.name : null;
    },
    protocolNumber: (name) => {
      const found = nss.lookup<NssProtocolEntry>('protocols', (s) => s.getprotobyname?.(name));
      return found.status === 'SUCCESS' && found.entry ? found.entry.number : null;
    },
    networkNumber: (name) => {
      const found = nss.lookup<NssNetworkEntry>('networks', (s) => s.getnetbyname?.(name));
      return found.status === 'SUCCESS' && found.entry ? found.entry.network : null;
    },
    etherName: (mac) => {
      const found = nss.lookup<NssEthersEntry>('ethers', (s) => s.getetherbyaddr?.(mac));
      return found.status === 'SUCCESS' && found.entry ? found.entry.hostname : null;
    },
    hostAddress: (name) => forwardAddressOfAsync(nss, name),
    hostName: (ip) => reverseNameOfAsync(nss, ip),
  };
}

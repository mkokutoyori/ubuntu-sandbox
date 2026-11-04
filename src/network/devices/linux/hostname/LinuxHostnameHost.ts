import type { LinuxCommandContext } from '../commands/LinuxCommandContext';
import { kernelHostname } from '../KernelHostname';
import { getAddrInfo, getHostByName } from '../nss/HostLookup';
import { reverseNameOfAsync } from '../network/ReverseName';
import type { HostnameHost, InterfaceAddress, NameChange } from './HostnameTool';

const UTS_NAME_LENGTH = 64;

export function linuxHostnameHost(ctx: LinuxCommandContext): HostnameHost {
  const { executor, net } = ctx;
  const { userMgr, vfs, nss } = executor;
  const change = (name: string, apply: (accepted: string) => void): NameChange => {
    if (userMgr.currentUid !== 0) return 'EPERM';
    if (name.length > UTS_NAME_LENGTH) return 'EINVAL';
    apply(name);
    return 'ok';
  };
  return {
    hostname: () => kernelHostname(vfs),
    setHostname: (name) => change(name, (accepted) => executor.setKernelHostname(accepted)),
    domainName: () => executor.kernelDomainName(),
    setDomainName: (name) => change(name, (accepted) => executor.setKernelDomainName(accepted)),
    readFile: (path) => {
      const absolute = vfs.normalizePath(path, executor.getCwd());
      const inode = vfs.resolveInode(absolute);
      if (!inode) return { error: 'No such file or directory' };
      const groups = userMgr.getUserGroups(userMgr.currentUser).map((group) => group.gid);
      if (!vfs.checkAccess(inode, 'r', userMgr.currentUid, userMgr.currentGid, groups)) return { error: 'Permission denied' };
      return { text: inode.type === 'directory' ? '' : vfs.readFile(absolute) ?? '' };
    },
    addressInfo: (name) => getAddrInfo(nss, name, { port: net.destinationSelectionPort(), policy: net.destinationPolicy() }),
    hostByName: (name) => getHostByName(nss, name),
    interfaceAddresses: (): readonly InterfaceAddress[] => {
      const ports = [...net.getPorts().values()];
      const v4 = ports.flatMap((port) => [port.getIPAddress(), ...port.getSecondaryIPs().map((entry) => entry.ip)]
        .filter((address) => address !== null)
        .map((address) => ({ loopback: port.isLoopback(), up: port.getIsUp(), family: 2 as const, address: address.toString() })));
      const v6 = ports.flatMap((port) => port.getIPv6Addresses()
        .map((entry) => ({ loopback: port.isLoopback(), up: port.getIsUp(), family: 10 as const, address: entry.address.toString().split('%')[0] })));
      return [...v4, ...v6];
    },
    nameOfAddress: (address) => reverseNameOfAsync(nss, address),
  };
}

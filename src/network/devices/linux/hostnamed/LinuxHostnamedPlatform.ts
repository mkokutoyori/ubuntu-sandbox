import type { LinuxCommandContext } from '../commands/LinuxCommandContext';
import type { LinuxCommandExecutor } from '../LinuxCommandExecutor';
import { kernelHostname } from '../KernelHostname';
import { Hostnamed, type HostnamedFacts, type HostnamedPlatform, type WriteOutcome } from './Hostnamed';
import type { HostnamectlHost } from './HostnamectlTool';

const VM_TECHNOLOGIES = ['kvm', 'qemu', 'vmware', 'microsoft', 'oracle', 'xen', 'bochs', 'uml', 'parallels', 'bhyve', 'qnx', 'acrn', 'powervm', 'apple', 'sre', 'google', 'vm-other'];
const CONTAINER_TECHNOLOGIES = ['openvz', 'lxc', 'lxc-libvirt', 'systemd-nspawn', 'docker', 'podman', 'rkt', 'wsl', 'proot', 'pouch', 'container-other'];

const SYSTEMD_ARCHITECTURE: Readonly<Record<string, string>> = {
  x86_64: 'x86-64', i386: 'x86', i486: 'x86', i586: 'x86', i686: 'x86', aarch64: 'arm64', armv7l: 'arm', armv6l: 'arm', ppc64le: 'ppc64-le', ppc64: 'ppc64', s390x: 's390x', riscv64: 'riscv64',
};

const daemons = new WeakMap<LinuxCommandExecutor, Hostnamed>();

function platformOf(executor: LinuxCommandExecutor): HostnamedPlatform {
  const { vfs, userMgr, identity } = executor;
  const outcomeOfWrite = (path: string): WriteOutcome => (executor.mountTable.isReadOnly(path) ? 'EROFS' : 'ok');
  return {
    readText: (path) => vfs.readFile(path),
    writeText: (path, text) => {
      const refused = outcomeOfWrite(path);
      if (refused !== 'ok') return refused;
      vfs.writeFile(path, text, 0, 0, 0o022);
      return 'ok';
    },
    remove: (path) => {
      const refused = outcomeOfWrite(path);
      if (refused !== 'ok') return refused;
      vfs.deleteFile(path);
      return 'ok';
    },
    kernelHostname: () => kernelHostname(vfs),
    setKernelHostname: (name) => executor.setKernelHostname(name),
    privileged: () => userMgr.currentUid === 0,
    journal: (message) => executor.logMgr.logSystemd('systemd-hostnamed', message),
    nowMs: () => executor.wallClockMs(),
    facts: (): HostnamedFacts => ({
      kernelName: identity.kernel.sysname,
      kernelRelease: identity.kernel.release,
      kernelVersion: identity.kernel.version,
      detectedChassis: detectedChassis(identity.virtualization, identity.chassis),
    }),
  };
}

function detectedChassis(virtualization: string, modelled: string): string | null {
  if (CONTAINER_TECHNOLOGIES.includes(virtualization)) return 'container';
  if (VM_TECHNOLOGIES.includes(virtualization)) return 'vm';
  return modelled === '' ? null : modelled;
}

export function hostnamedOf(executor: LinuxCommandExecutor): Hostnamed {
  let daemon = daemons.get(executor);
  if (daemon === undefined) {
    daemon = new Hostnamed(platformOf(executor));
    daemons.set(executor, daemon);
  }
  return daemon;
}

export function linuxHostnamectlHost(ctx: LinuxCommandContext): HostnamectlHost {
  const { identity } = ctx.executor;
  return {
    daemon: hostnamedOf(ctx.executor),
    machineId: identity.machineId,
    bootId: identity.bootId,
    virtualization: identity.virtualization === 'none' ? '' : identity.virtualization,
    architecture: SYSTEMD_ARCHITECTURE[identity.kernel.machine] ?? identity.kernel.machine,
    kernel: { name: identity.kernel.sysname, release: identity.kernel.release, version: identity.kernel.version },
    connectFailure: () => 'Failed to connect to bus: Host is down',
  };
}

import type { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';

interface MachineWithProcesses {
  readonly executor: { readonly processMgr: LinuxProcessManager };
}

export function spawnSocketOwner(machine: object, name: string, uid = 0): number {
  const { processMgr } = (machine as unknown as MachineWithProcesses).executor;
  return processMgr.spawn({
    command: name, comm: name, user: uid === 0 ? 'root' : 'user', uid, gid: uid, ppid: 1, tty: '?',
  }).pid;
}

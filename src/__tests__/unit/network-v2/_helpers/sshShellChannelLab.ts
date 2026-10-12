import { beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { isOk } from '@/network/protocols/ssh/Result';
import type { ISshShellChannel } from '@/network/protocols/ssh/channels/ISshChannel';
import { installDefaultShells } from '@/shell/registerDefaults';
import { noopSshLocalFs } from './noopSshLocalFs';

const MASK = new SubnetMask('255.255.255.0');

export interface WiredShell {
  readonly channel: ISshShellChannel;
  readonly server: LinuxServer;
  readonly client: LinuxPC;
}

export function resetSshShellLab(): void {
  beforeEach(() => {
    installDefaultShells();
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.getInstance().clear();
  });
}

export async function wireShellChannel(): Promise<WiredShell> {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.15.1'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.15.2'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], srv.getPorts()[0]);

  const dev = pc as unknown as { tcpConnect(h: string, p: number): Promise<unknown> };
  const session = new SshSession({
    tcpConnector: ((h: string, p: number) => dev.tcpConnect(h, p)) as never,
    vfs: noopSshLocalFs() as never,
    localUser: 'user', localUid: 1000, localGid: 1000,
    knownHostsPath: '/home/user/.ssh/known_hosts',
    interactionHandler: new SilentSshInteractionHandler(),
  } as never);
  const opts = SshConnectOptionsBuilder.create()
    .host('10.0.15.2').user('alice').password('alice').strictHostKeyChecking('no').build();
  const connected = await session.connect(opts);
  if (!isOk(connected)) throw new Error('connect failed: ' + JSON.stringify((connected as { error: unknown }).error));
  const channel = session.openShellChannel();
  if (!isOk(channel)) throw new Error('shell channel failed');
  return { channel: channel.value, server: srv, client: pc };
}

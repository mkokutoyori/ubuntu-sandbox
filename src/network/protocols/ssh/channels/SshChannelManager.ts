/**
 * SshChannelManager — Composite that owns the channels of a session.
 *
 * Reference: DESIGN-SSH-SFTP.md section 7.
 */

import type { ChannelType, ISshChannel } from './ISshChannel';
import type { SshConnection } from '../connection/SshConnection';
import { SshExecChannel } from './SshExecChannel';
import { SshSftpChannel } from './SshSftpChannel';
import { SshShellChannel } from './SshShellChannel';

export class SshChannelManager {
  private channels = new Map<number, ISshChannel>();
  private nextChannelId = 0;

  openShell(connection: SshConnection): SshShellChannel {
    const channel = new SshShellChannel(connection, this.nextChannelId++);
    this.register(channel);
    return channel;
  }

  openExec(connection: SshConnection, command: string): SshExecChannel {
    const channel = new SshExecChannel(connection, this.nextChannelId++, command);
    this.register(channel);
    return channel;
  }

  openSftp(connection: SshConnection): SshSftpChannel {
    const channel = new SshSftpChannel(connection, this.nextChannelId++);
    this.register(channel);
    return channel;
  }

  get(id: number): ISshChannel | undefined {
    return this.channels.get(id);
  }

  count(): number {
    return this.channels.size;
  }

  list(type?: ChannelType): ISshChannel[] {
    const all = [...this.channels.values()];
    return type ? all.filter((c) => c.type === type) : all;
  }

  closeAll(): void {
    for (const c of this.channels.values()) c.close();
    this.channels.clear();
  }

  private register(channel: ISshChannel): void {
    this.channels.set(channel.channelId, channel);
    channel.onClose(() => this.channels.delete(channel.channelId));
    channel.open();
  }
}

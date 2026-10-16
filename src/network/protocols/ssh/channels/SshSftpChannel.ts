import { AbstractSshChannel } from './AbstractSshChannel';
import type { ISshSftpChannel } from './ISshChannel';
import type { ConnectionChannel, SshConnection } from '../connection/SshConnection';
import { encodeStringPayload } from '../connection/ChannelPayloads';
import { encodeSftpWirePacket, decodeSftpWirePacket, type SftpWirePacket } from '../sftp/SftpWireCodec';

const CLIENT_SFTP_VERSION = 3;
const SFTP_SUBSYSTEM = 'sftp';
const MAX_MESSAGE_LENGTH = 256 * 1024;

export type SftpChannelLaunch =
  | { readonly kind: 'subsystem'; readonly name: string }
  | { readonly kind: 'command'; readonly command: string };

export class SshSftpChannel
  extends AbstractSshChannel
  implements ISshSftpChannel
{
  readonly type = 'sftp' as const;

  private pendingReply: SftpWirePacket | null = null;
  private channel: ConnectionChannel | null = null;
  private inbound = new Uint8Array(0);
  private negotiatedVersion = CLIENT_SFTP_VERSION;
  private extensions = new Map<string, string>();
  private stderrText = '';
  private oversized: number | null = null;
  private settleSubsystem: (accepted: boolean) => void = () => undefined;
  private readonly subsystemAnswer = new Promise<boolean>((resolve) => { this.settleSubsystem = resolve; });

  constructor(
    private readonly connection: SshConnection, channelId: number,
    private readonly launch: SftpChannelLaunch = { kind: 'subsystem', name: SFTP_SUBSYSTEM },
  ) {
    super(channelId, 'sftp');
  }

  get protocolVersion(): number {
    return this.negotiatedVersion;
  }

  get serverExtensions(): ReadonlyMap<string, string> {
    return this.extensions;
  }

  get remoteStderr(): string {
    return this.stderrText;
  }

  get oversizedMessage(): number | null {
    return this.oversized;
  }

  accepted(): Promise<boolean> {
    return this.subsystemAnswer;
  }

  exchange(packet: SftpWirePacket): SftpWirePacket | null {
    if (!this._isOpen) return null;
    this.pendingReply = null;
    this.channel?.write(encodeSftpWirePacket(packet, this.negotiatedVersion));
    return this.pendingReply;
  }

  protected handleOpen(): void {
    const channel = this.connection.beginOpen('session');
    this.channel = channel;
    channel.onData((bytes) => this.receive(bytes));
    channel.onExtendedData((_type, bytes) => { this.stderrText += new TextDecoder().decode(bytes); });
    channel.onRequest((request) => { request.reply(false); });
    channel.onClose(() => {
      this.channel = null;
      this.close();
    });
    channel.whenOpened((failure) => {
      if (failure !== null) {
        this.settleSubsystem(false);
        this.close();
        return;
      }
      const request = this.launch.kind === 'subsystem'
        ? channel.request('subsystem', encodeStringPayload(this.launch.name), true)
        : channel.request('exec', encodeStringPayload(this.launch.command), true);
      void request.then((accepted) => {
        this.settleSubsystem(accepted);
        if (!accepted) this.close();
      });
      const version = this.exchange({ type: 'INIT', version: CLIENT_SFTP_VERSION });
      if (version?.type === 'VERSION') {
        this.negotiatedVersion = version.version;
        this.extensions = new Map((version.extensions ?? []).map((pair) => [pair.name, pair.data]));
      }
    });
  }

  protected handleClose(): void {
    this.channel?.close();
    this.channel = null;
    this.pendingReply = null;
    this.inbound = new Uint8Array(0);
  }

  private receive(bytes: Uint8Array): void {
    const merged = new Uint8Array(this.inbound.length + bytes.length);
    merged.set(this.inbound);
    merged.set(bytes, this.inbound.length);
    this.inbound = merged;
    while (this.inbound.length >= 4) {
      const length = ((this.inbound[0] << 24) | (this.inbound[1] << 16) | (this.inbound[2] << 8) | this.inbound[3]) >>> 0;
      if (length > MAX_MESSAGE_LENGTH) {
        this.oversized = length;
        this.inbound = new Uint8Array(0);
        return;
      }
      if (this.inbound.length < 4 + length) return;
      const packet = decodeSftpWirePacket(this.inbound.subarray(0, 4 + length), this.negotiatedVersion);
      this.inbound = this.inbound.slice(4 + length);
      if (packet !== null) this.pendingReply = packet;
    }
  }
}

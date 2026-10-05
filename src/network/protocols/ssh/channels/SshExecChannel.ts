import { bytesToUtf8 } from '@/crypto/encoding';
import type { ConnectionChannel, SshConnection } from '../connection/SshConnection';
import { decodeExitStatus, encodeStringPayload } from '../connection/ChannelPayloads';
import { SSH_EXTENDED_DATA_STDERR } from '../transport/SshMessageNumbers';
import { AbstractSshChannel } from './AbstractSshChannel';
import type { ExecResult, ISshExecChannel } from './ISshChannel';

const EXIT_ON_SIGNAL = 255;

export class SshExecChannel
  extends AbstractSshChannel
  implements ISshExecChannel
{
  readonly type = 'exec' as const;

  private channel: ConnectionChannel | null = null;
  private result: ExecResult | null = null;
  private readonly stdoutChunks: Uint8Array[] = [];
  private readonly stderrChunks: Uint8Array[] = [];
  private exitStatus: number | null = null;
  private readonly waiters: Array<(r: ExecResult) => void> = [];

  constructor(
    private readonly connection: SshConnection,
    channelId: number,
    private readonly command: string,
  ) {
    super(channelId, 'exec');
  }

  protected handleOpen(): void {
    const channel = this.connection.beginOpen('session');
    this.channel = channel;
    channel.onData((data) => { this.stdoutChunks.push(data); });
    channel.onExtendedData((type, data) => {
      if (type === SSH_EXTENDED_DATA_STDERR) this.stderrChunks.push(data);
    });
    channel.onRequest((request) => {
      if (request.name === 'exit-status') this.exitStatus = decodeExitStatus(request.payload);
      else if (request.name === 'exit-signal') this.exitStatus = EXIT_ON_SIGNAL;
      else request.reply(false);
    });
    channel.onClose(() => this.settle());
    channel.whenOpened((failure) => {
      if (failure !== null) {
        this.stderrChunks.push(new TextEncoder().encode(`channel open failed: ${failure.description}\n`));
        this.exitStatus = EXIT_ON_SIGNAL;
        this.settle();
        return;
      }
      void channel.request('exec', encodeStringPayload(this.command), true).then((accepted) => {
        if (accepted) return;
        this.stderrChunks.push(new TextEncoder().encode('exec request failed\n'));
        this.exitStatus = EXIT_ON_SIGNAL;
        channel.close();
      });
    });
  }

  protected handleClose(): void {
    this.channel?.close();
  }

  private settle(): void {
    if (this.result !== null) return;
    const join = (chunks: Uint8Array[]): string => bytesToUtf8(chunks.reduce((all, chunk) => {
      const merged = new Uint8Array(all.length + chunk.length);
      merged.set(all);
      merged.set(chunk, all.length);
      return merged;
    }, new Uint8Array(0)));
    this.result = { stdout: join(this.stdoutChunks), stderr: join(this.stderrChunks), exitCode: this.exitStatus ?? 0 };
    for (const waiter of this.waiters.splice(0)) waiter(this.result);
  }

  run(): ExecResult | null {
    if (!this._isOpen) {
      throw new Error('SshExecChannel: cannot execute on closed channel');
    }
    return this.result;
  }

  execute(): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve) => {
      if (this.result !== null) resolve(this.result);
      else this.waiters.push(resolve);
    });
  }

  get stdout(): string {
    return this.result?.stdout ?? '';
  }

  get exitCode(): number {
    return this.result?.exitCode ?? -1;
  }
}

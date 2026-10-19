export interface ForwardedSyslogMessage {
  readonly text: string;
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
  readonly receivedAtMs: number;
}

export type ForwardedSyslogReceiver = (message: ForwardedSyslogMessage) => void;

const SUPERVISOR_QUEUE_LENGTH = 512;

export class SyslogForwardSocket {
  private receiver: ForwardedSyslogReceiver | null = null;
  private pending: ForwardedSyslogMessage[] = [];
  private everAttached = false;

  get isAttached(): boolean {
    return this.receiver !== null;
  }

  attach(receiver: ForwardedSyslogReceiver): () => void {
    this.receiver = receiver;
    this.everAttached = true;
    const queued = this.pending;
    this.pending = [];
    for (const message of queued) receiver(message);
    return () => {
      if (this.receiver === receiver) this.receiver = null;
    };
  }

  deliver(message: ForwardedSyslogMessage): void {
    if (this.receiver !== null) {
      this.receiver(message);
      return;
    }
    if (this.everAttached) return;
    if (this.pending.length < SUPERVISOR_QUEUE_LENGTH) this.pending.push(message);
  }
}

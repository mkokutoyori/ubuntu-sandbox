/**
 * AbstractSshChannel — Template Method for the channel lifecycle.
 *
 * Reference: DESIGN-SSH-SFTP.md section 7.
 */

import type { TcpConnection } from '@/network/core/TcpConnection';
import type { ChannelType, ISshChannel } from './ISshChannel';

export abstract class AbstractSshChannel implements ISshChannel {
  protected _isOpen = false;
  protected closeHandlers: Array<() => void> = [];

  protected constructor(
    protected readonly conn: TcpConnection,
    public readonly channelId: number,
    public readonly type: ChannelType,
  ) {}

  get isOpen(): boolean {
    return this._isOpen;
  }

  /** Template method — fixed shape, hooks vary in subclasses. */
  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.handleOpen();
  }

  /** Template method — subclasses cleanup their own state in handleClose(). */
  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.handleClose();
    for (const h of this.closeHandlers) h();
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      this.closeHandlers = this.closeHandlers.filter((h) => h !== handler);
    };
  }

  protected abstract handleOpen(): void;
  protected abstract handleClose(): void;
}

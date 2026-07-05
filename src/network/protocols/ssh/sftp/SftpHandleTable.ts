/**
 * SftpHandleTable — draft-ietf-secsh-filexfer §6.4-6.7's real handle
 * model (PRD-FTP-SFTP.md §2.1.15/P14). `OPEN`/`OPENDIR` return an
 * opaque handle registered here; `READ`/`WRITE` operate on
 * `(handle, offset, length)` against it; `CLOSE` releases it. The
 * handle itself is just a logical cursor over the same
 * `ISftpReadable`/`ISftpWritable` methods the atomic `get`/`put`
 * commands already use — a file-read handle buffers the whole file
 * once on `OPEN` (this simulator's underlying filesystem has no
 * streaming read primitive to speak of), and a file-write handle
 * accumulates into a buffer flushed on `CLOSE`.
 */

export interface SftpFileReadHandle {
  readonly kind: 'file-read';
  readonly path: string;
  readonly content: string;
}

export interface SftpFileWriteHandle {
  readonly kind: 'file-write';
  readonly path: string;
  buffer: string;
}

export interface SftpDirHandle {
  readonly kind: 'dir';
  readonly path: string;
  drained: boolean;
}

export type SftpHandleState = SftpFileReadHandle | SftpFileWriteHandle | SftpDirHandle;

export class SftpHandleTable {
  private readonly handles = new Map<string, SftpHandleState>();
  private counter = 0;

  open(state: SftpHandleState): string {
    this.counter += 1;
    const handle = `h${this.counter}`;
    this.handles.set(handle, state);
    return handle;
  }

  get(handle: string): SftpHandleState | undefined {
    return this.handles.get(handle);
  }

  close(handle: string): boolean {
    return this.handles.delete(handle);
  }

  get openCount(): number {
    return this.handles.size;
  }
}

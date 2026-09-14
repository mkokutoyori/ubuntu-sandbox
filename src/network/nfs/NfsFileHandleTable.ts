import { NFS3_FHSIZE } from './wire/NfsConstants';

const HANDLE_BYTES = 32;

export interface NfsHandleTarget {
  readonly exportPath: string;
  readonly path: string;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function targetKey(target: NfsHandleTarget): string {
  return `${target.exportPath.length}:${target.exportPath}${target.path}`;
}

export class NfsFileHandleTable {
  private readonly byTarget = new Map<string, Uint8Array>();
  private readonly byHandle = new Map<string, NfsHandleTarget>();
  private generation = 1;

  static keyOf(handle: Uint8Array): string {
    return Array.from(handle, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  handleFor(target: NfsHandleTarget): Uint8Array {
    const key = targetKey(target);
    const existing = this.byTarget.get(key);
    if (existing) return existing;
    const handle = new Uint8Array(HANDLE_BYTES);
    const view = new DataView(handle.buffer);
    view.setUint32(0, fnv1a(target.exportPath));
    view.setUint32(4, fnv1a(target.path));
    view.setUint32(8, this.generation++);
    view.setUint32(12, target.path.length);
    this.byTarget.set(key, handle);
    this.byHandle.set(NfsFileHandleTable.keyOf(handle), target);
    return handle;
  }

  resolve(handle: Uint8Array): NfsHandleTarget | null {
    if (handle.length === 0 || handle.length > NFS3_FHSIZE) return null;
    return this.byHandle.get(NfsFileHandleTable.keyOf(handle)) ?? null;
  }

  forget(target: NfsHandleTarget): void {
    const key = targetKey(target);
    const handle = this.byTarget.get(key);
    if (!handle) return;
    this.byTarget.delete(key);
    this.byHandle.delete(NfsFileHandleTable.keyOf(handle));
  }

  forgetExport(exportPath: string): void {
    for (const [key, handle] of [...this.byTarget]) {
      const target = this.byHandle.get(NfsFileHandleTable.keyOf(handle));
      if (target?.exportPath !== exportPath) continue;
      this.byTarget.delete(key);
      this.byHandle.delete(NfsFileHandleTable.keyOf(handle));
    }
  }
}

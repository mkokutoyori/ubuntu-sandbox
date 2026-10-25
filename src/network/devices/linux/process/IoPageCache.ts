const PAGE_BYTES = 4096;
const SECTOR_BYTES = 512;
const SECTORS_PER_PAGE = PAGE_BYTES / SECTOR_BYTES;
const READAHEAD_PAGES = 32;
const DIRTY_EXPIRE_MS = 30_000;

const pageKey = (inode: number, page: number): string => `${inode}:${page}`;
const pageCount = (bytes: number): number => Math.ceil(bytes / PAGE_BYTES);

export class IoPageCache {
  private readonly resident = new Set<string>();
  private readonly dirty = new Map<string, number>();

  read(inode: number, offset: number, length: number, size: number): number {
    if (length <= 0 || offset >= size) return 0;
    const lastPage = pageCount(size) - 1;
    const first = Math.floor(offset / PAGE_BYTES);
    const last = Math.min(lastPage, Math.floor((Math.min(offset + length, size) - 1) / PAGE_BYTES));
    let fetched = 0;
    for (let page = first; page <= last; page++) {
      if (this.resident.has(pageKey(inode, page))) continue;
      const window = Math.min(lastPage, page + READAHEAD_PAGES - 1);
      for (let ahead = page; ahead <= window; ahead++) {
        if (this.resident.has(pageKey(inode, ahead))) continue;
        this.resident.add(pageKey(inode, ahead));
        fetched++;
      }
    }
    return fetched * SECTORS_PER_PAGE;
  }

  write(inode: number, offset: number, length: number, sizeBefore: number, nowMs: number): { read: number; written: number } {
    this.expire(nowMs);
    if (length <= 0) return { read: 0, written: 0 };
    const first = Math.floor(offset / PAGE_BYTES);
    const last = Math.floor((offset + length - 1) / PAGE_BYTES);
    let read = 0;
    let written = 0;
    for (let page = first; page <= last; page++) {
      const key = pageKey(inode, page);
      const start = page * PAGE_BYTES;
      const coversWholePage = offset <= start && offset + length >= start + PAGE_BYTES;
      if (!this.resident.has(key)) {
        if (!coversWholePage && start < sizeBefore) read += SECTORS_PER_PAGE;
        this.resident.add(key);
      }
      if (!this.dirty.has(key)) {
        this.dirty.set(key, nowMs);
        written += SECTORS_PER_PAGE;
      }
    }
    return { read, written };
  }

  warm(inode: number, size: number): void {
    for (let page = 0; page < pageCount(size); page++) this.resident.add(pageKey(inode, page));
  }

  flush(inode: number): void {
    const prefix = `${inode}:`;
    for (const key of [...this.dirty.keys()]) if (key.startsWith(prefix)) this.dirty.delete(key);
  }

  private expire(nowMs: number): void {
    for (const [key, since] of this.dirty) if (nowMs - since >= DIRTY_EXPIRE_MS) this.dirty.delete(key);
  }
}

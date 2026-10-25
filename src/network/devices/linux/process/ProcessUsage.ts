import type { ResourceUsage } from '@/network/rsyslog/engine/Host';
import type { IoPageCache } from './IoPageCache';

const KERNEL_PAGE_KILOBYTES = 4;

export class ProcessUsage {
  private voluntarySwitches = 0;
  private sectorsRead = 0;
  private sectorsWritten = 0;
  private peakResidentKilobytes = 0;

  constructor(private readonly cache: IoPageCache, private readonly now: () => number) {}

  reset(): void {
    this.voluntarySwitches = 0;
    this.sectorsRead = 0;
    this.sectorsWritten = 0;
    this.peakResidentKilobytes = 0;
  }

  wake(): void {
    this.voluntarySwitches++;
  }

  fileRead(inode: number, offset: number, length: number, size: number): void {
    const fetched = this.cache.read(inode, offset, length, size);
    this.sectorsRead += fetched;
    if (fetched > 0) this.voluntarySwitches++;
  }

  fileWrite(inode: number, offset: number, length: number, sizeBefore: number): void {
    const traffic = this.cache.write(inode, offset, length, sizeBefore, this.now());
    this.sectorsRead += traffic.read;
    this.sectorsWritten += traffic.written;
  }

  fileSync(inode: number): void {
    this.cache.flush(inode);
  }

  snapshot(residentKilobytes: number, cpuMicroseconds: number, openFiles: number): ResourceUsage {
    this.peakResidentKilobytes = Math.max(this.peakResidentKilobytes, residentKilobytes);
    return {
      userMicroseconds: cpuMicroseconds,
      systemMicroseconds: 0,
      maxResidentKilobytes: this.peakResidentKilobytes,
      minorFaults: Math.ceil(this.peakResidentKilobytes / KERNEL_PAGE_KILOBYTES),
      majorFaults: 0,
      blocksRead: this.sectorsRead,
      blocksWritten: this.sectorsWritten,
      voluntaryContextSwitches: this.voluntarySwitches,
      involuntaryContextSwitches: 0,
      openFiles,
    };
  }
}

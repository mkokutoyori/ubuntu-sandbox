import { PacketCapture, type CapturedFrame } from './PacketCapture';

export const UNLIMITED_CAPTURE_SIZE = 0;

const BYTES_PER_MB = 1024 * 1024;

export class PolicyCaptureStore {
  private readonly captures = new Map<string, PacketCapture>();

  private maxSizeMb = UNLIMITED_CAPTURE_SIZE;

  setMaxSizeMb(megabytes: number): void {
    this.maxSizeMb = Math.max(0, megabytes);
    for (const capture of this.captures.values()) capture.setByteBudget(this.budget());
  }

  getMaxSizeMb(): number { return this.maxSizeMb; }

  record(policyId: string, entry: CapturedFrame): void {
    this.forPolicy(policyId).record(entry);
  }

  forPolicy(policyId: string): PacketCapture {
    const existing = this.captures.get(policyId);
    if (existing) return existing;

    const created = new PacketCapture();
    created.setByteBudget(this.budget());
    this.captures.set(policyId, created);
    return created;
  }

  countOf(policyId: string): number {
    return this.captures.get(policyId)?.count() ?? 0;
  }

  total(): number {
    let sum = 0;
    for (const capture of this.captures.values()) sum += capture.count();
    return sum;
  }

  policyIds(): readonly string[] { return Object.freeze([...this.captures.keys()]); }

  clear(): number {
    const removed = this.total();
    this.captures.clear();
    return removed;
  }

  private budget(): number | null {
    return this.maxSizeMb === UNLIMITED_CAPTURE_SIZE
      ? null : this.maxSizeMb * BYTES_PER_MB;
  }
}

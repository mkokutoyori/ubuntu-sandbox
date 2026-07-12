/**
 * RidPool — a contiguous block of Relative IDs a DC can hand out to
 * newly created security principals without contacting the RID Master
 * again until exhausted (real AD's RID pool). One instance per
 * `DirectoryStore` — its own local allocation state, installed either
 * at domain creation (the first DC seeds itself directly) or via a
 * real network request to the RID Master (`RidPoolClient`, additional
 * DCs).
 */
export class RidPool {
  private nextOffset = 0;

  constructor(private poolStart: number, private poolCount: number) {}

  allocateNext(): number | null {
    if (this.nextOffset >= this.poolCount) return null;
    return this.poolStart + this.nextOffset++;
  }

  remaining(): number { return this.poolCount - this.nextOffset; }

  install(poolStart: number, poolCount: number): void {
    this.poolStart = poolStart;
    this.poolCount = poolCount;
    this.nextOffset = 0;
  }
}

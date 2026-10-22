import { IPAddress, SubnetMask } from '@/network/core/types';
import { MplsLabel, MPLS_FIRST_UNRESERVED_LABEL, MPLS_LABEL_MAX } from './MplsLabel';

export interface SwapEntry {
  readonly kind: 'swap';
  readonly outLabels: readonly MplsLabel[];
  readonly iface: string;
  readonly nextHop: IPAddress;
}

export interface PopEntry {
  readonly kind: 'pop';
  readonly iface: string | null;
  readonly nextHop: IPAddress | null;
}

export type IlmEntry = SwapEntry | PopEntry;

export interface FtnEntry {
  readonly prefix: IPAddress;
  readonly prefixLength: number;
  readonly outLabels: readonly MplsLabel[];
  readonly iface: string;
  readonly nextHop: IPAddress;
}

export class Lfib {
  private readonly ilm = new Map<number, IlmEntry>();
  private ftn: FtnEntry[] = [];
  private nextDynamicLabel = MPLS_FIRST_UNRESERVED_LABEL;
  private readonly released: number[] = [];

  allocateLabel(): MplsLabel {
    const reused = this.released.shift();
    if (reused !== undefined) return MplsLabel.of(reused);
    while (this.ilm.has(this.nextDynamicLabel)) this.nextDynamicLabel++;
    if (this.nextDynamicLabel > MPLS_LABEL_MAX) throw new RangeError('MPLS label space exhausted');
    return MplsLabel.of(this.nextDynamicLabel++);
  }

  releaseLabel(label: MplsLabel): void {
    this.ilm.delete(label.value);
    if (!label.isSpecialPurpose() && !this.released.includes(label.value)) this.released.push(label.value);
  }

  setIlm(incoming: MplsLabel, entry: IlmEntry): void {
    this.ilm.set(incoming.value, entry);
  }

  removeIlm(incoming: MplsLabel): boolean {
    return this.ilm.delete(incoming.value);
  }

  lookupIlm(incoming: MplsLabel): IlmEntry | undefined {
    return this.ilm.get(incoming.value);
  }

  ilmEntries(): ReadonlyArray<readonly [MplsLabel, IlmEntry]> {
    return [...this.ilm.entries()].sort((a, b) => a[0] - b[0]).map(([value, entry]) => [MplsLabel.of(value), entry] as const);
  }

  setFtn(entry: FtnEntry): void {
    this.ftn = this.ftn.filter(e => !(e.prefix.equals(entry.prefix) && e.prefixLength === entry.prefixLength));
    this.ftn.push(entry);
  }

  removeFtn(prefix: IPAddress, prefixLength: number): boolean {
    const before = this.ftn.length;
    this.ftn = this.ftn.filter(e => !(e.prefix.equals(prefix) && e.prefixLength === prefixLength));
    return this.ftn.length !== before;
  }

  lookupFtn(destination: IPAddress): FtnEntry | undefined {
    let best: FtnEntry | undefined;
    for (const entry of this.ftn) {
      const mask = SubnetMask.fromCIDR(entry.prefixLength);
      if (!destination.isInSameSubnet(entry.prefix, mask)) continue;
      if (best === undefined || entry.prefixLength > best.prefixLength) best = entry;
    }
    return best;
  }

  ftnEntries(): readonly FtnEntry[] {
    return [...this.ftn];
  }

  clear(): void {
    this.ilm.clear();
    this.ftn = [];
    this.released.length = 0;
    this.nextDynamicLabel = MPLS_FIRST_UNRESERVED_LABEL;
  }
}

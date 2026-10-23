import type { BgpLayer2Info, BgpVplsNlri } from '@/network/bgp/messages';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import type { VplsPseudowire } from './VplsEngine';

export interface BgpLocalBlock {
  readonly veId: number;
  readonly offset: number;
  readonly size: number;
  readonly base: MplsLabel;
  readonly controlWord: boolean;
  readonly mtu: () => number;
}

export function labelInBlock(base: number, offset: number, size: number, veId: number): MplsLabel | null {
  return veId >= offset && veId < offset + size ? MplsLabel.of(base + veId - offset) : null;
}

export class BgpPseudowire implements VplsPseudowire {
  constructor(
    private readonly local: BgpLocalBlock,
    readonly remoteVeId: number,
    private readonly advertisement: { readonly nlri: BgpVplsNlri; readonly layer2Info: BgpLayer2Info },
    private readonly localUp: () => boolean,
  ) {}

  get localLabel(): MplsLabel | null {
    return labelInBlock(this.local.base.value, this.local.offset, this.local.size, this.remoteVeId);
  }

  get remote(): { readonly label: MplsLabel } | null {
    const { nlri } = this.advertisement;
    const label = labelInBlock(nlri.labelBase, nlri.veBlockOffset, nlri.veBlockSize, this.local.veId);
    return label === null ? null : { label };
  }

  get sendsControlWord(): boolean {
    return this.advertisement.layer2Info.controlWord;
  }

  get receivesControlWord(): boolean {
    return this.local.controlWord;
  }

  blocker(): string | null {
    if (this.localLabel === null) return 'remote VE-ID outside the local label block';
    if (this.remote === null) return 'local VE-ID outside the remote label block';
    if (this.advertisement.layer2Info.sequenced) return 'sequenced delivery not supported';
    if (this.advertisement.layer2Info.mtu !== this.local.mtu()) return 'interface MTU mismatch';
    if (!this.localUp()) return 'attachment circuit down';
    return null;
  }

  teardown(): void {}
}

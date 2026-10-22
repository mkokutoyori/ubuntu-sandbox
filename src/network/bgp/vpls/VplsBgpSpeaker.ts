import type { BgpLayer2Info, BgpUpdateMessage, BgpVplsNlri } from '../messages';

export const VPLS_ENCAPSULATION_TYPE = 19;

export interface VplsLocalInstance {
  readonly name: string;
  readonly rd: string;
  readonly routeTarget: string;
  readonly veId: number;
  readonly veBlockOffset: number;
  readonly veBlockSize: number;
  readonly labelBase: number;
  readonly layer2Info: BgpLayer2Info;
}

export interface VplsPeer {
  readonly ip: string;
  readonly remoteAsn: number;
  readonly localIp: string;
  send(update: BgpUpdateMessage): void;
}

export interface VplsRemoteAdvertisement {
  readonly instance: string;
  readonly peerIp: string;
  readonly nlri: BgpVplsNlri;
  readonly nextHop: string;
  readonly layer2Info: BgpLayer2Info;
}

export interface VplsBgpHost {
  localAsn(): number;
  instances(): readonly VplsLocalInstance[];
  peers(): readonly VplsPeer[];
  remoteAdvertised(advertisement: VplsRemoteAdvertisement): void;
  remoteWithdrawn(instance: string, peerIp: string, nlri: BgpVplsNlri): void;
}

function nlriKey(nlri: BgpVplsNlri): string {
  return `${nlri.rd}|${nlri.veId}|${nlri.veBlockOffset}|${nlri.veBlockSize}|${nlri.labelBase}`;
}

function nlriOf(instance: VplsLocalInstance): BgpVplsNlri {
  return {
    rd: instance.rd, veId: instance.veId, veBlockOffset: instance.veBlockOffset,
    veBlockSize: instance.veBlockSize, labelBase: instance.labelBase,
  };
}

export class VplsBgpSpeaker {
  private readonly received = new Map<string, Map<string, VplsRemoteAdvertisement>>();
  private readonly advertised = new Map<string, Map<string, { instance: string; nlri: BgpVplsNlri }>>();

  constructor(private readonly host: VplsBgpHost) {}

  peerUp(peerIp: string): void {
    this.received.set(peerIp, new Map());
    this.advertised.set(peerIp, new Map());
    this.sync();
  }

  peerDown(peerIp: string): void {
    const table = this.received.get(peerIp);
    this.received.delete(peerIp);
    this.advertised.delete(peerIp);
    for (const advertisement of table?.values() ?? []) this.host.remoteWithdrawn(advertisement.instance, peerIp, advertisement.nlri);
  }

  receivedCount(peerIp: string): number {
    return this.received.get(peerIp)?.size ?? 0;
  }

  onUpdate(peer: VplsPeer, update: BgpUpdateMessage): void {
    const table = this.received.get(peer.ip);
    if (table === undefined) return;
    for (const withdrawal of update.vplsUnreach?.nlri ?? []) {
      const key = nlriKey(withdrawal);
      const held = table.get(key);
      if (held === undefined) continue;
      table.delete(key);
      this.host.remoteWithdrawn(held.instance, peer.ip, withdrawal);
    }
    const reach = update.vplsReach;
    if (reach === undefined || reach.attributes.asPath.includes(this.host.localAsn())) return;
    for (const instance of this.host.instances()) {
      if (!reach.attributes.routeTargets.includes(instance.routeTarget)) continue;
      for (const nlri of reach.nlri) {
        const advertisement: VplsRemoteAdvertisement = {
          instance: instance.name, peerIp: peer.ip, nlri, nextHop: reach.nextHop, layer2Info: reach.attributes.layer2Info,
        };
        table.set(nlriKey(nlri), advertisement);
        this.host.remoteAdvertised(advertisement);
      }
    }
  }

  sync(): void {
    for (const peer of this.host.peers()) {
      const sent = this.advertised.get(peer.ip);
      if (sent === undefined) continue;
      const ibgp = peer.remoteAsn === this.host.localAsn();
      const desired = new Map<string, { instance: VplsLocalInstance; nlri: BgpVplsNlri }>();
      for (const instance of this.host.instances()) desired.set(`${instance.name}|${nlriKey(nlriOf(instance))}`, { instance, nlri: nlriOf(instance) });
      const withdrawn: BgpVplsNlri[] = [];
      for (const [key, held] of [...sent]) {
        if (desired.has(key)) continue;
        sent.delete(key);
        withdrawn.push(held.nlri);
      }
      if (withdrawn.length > 0) peer.send({ type: 'bgp', message: 'update', withdrawn: [], announced: [], vplsUnreach: { nlri: withdrawn } });
      for (const [key, { instance, nlri }] of desired) {
        if (sent.has(key)) continue;
        sent.set(key, { instance: instance.name, nlri });
        peer.send({
          type: 'bgp', message: 'update', withdrawn: [], announced: [],
          vplsReach: {
            nextHop: peer.localIp, nlri: [nlri],
            attributes: {
              origin: 'igp', asPath: ibgp ? [] : [this.host.localAsn()], ...(ibgp ? { localPref: 100 } : {}),
              routeTargets: [instance.routeTarget], layer2Info: instance.layer2Info,
            },
          },
        });
      }
    }
  }
}

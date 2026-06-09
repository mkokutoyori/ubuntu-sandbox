export type KeyAuthAlgo = 'md5' | 'sha-1' | 'sha-256' | 'hmac-sha-256';

export interface KeyChainKey {
  id: number;
  cryptoAlgorithm?: string;
  keyString?: string;
  keyStringHidden?: 0 | 6 | 7;
  acceptLifetime?: { start: string; end: string };
  sendLifetime?: { start: string; end: string };
  sendId?: number;
  recvId?: number;
}

export interface KeyChain {
  name: string;
  description?: string;
  keys: Map<number, KeyChainKey>;
}

export class KeyChainRepository {
  private readonly chains: Map<string, KeyChain> = new Map();

  ensureChain(name: string): KeyChain {
    let c = this.chains.get(name);
    if (!c) { c = { name, keys: new Map() }; this.chains.set(name, c); }
    return c;
  }

  getChain(name: string): KeyChain | undefined {
    return this.chains.get(name);
  }

  removeChain(name: string): boolean {
    return this.chains.delete(name);
  }

  ensureKey(chainName: string, id: number): KeyChainKey {
    const chain = this.ensureChain(chainName);
    let k = chain.keys.get(id);
    if (!k) { k = { id }; chain.keys.set(id, k); }
    return k;
  }

  list(): readonly KeyChain[] {
    return [...this.chains.values()];
  }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    for (const c of this.chains.values()) {
      lines.push(`key chain ${c.name}`);
      if (c.description) lines.push(` description ${c.description}`);
      for (const k of [...c.keys.values()].sort((a, b) => a.id - b.id)) {
        lines.push(` key ${k.id}`);
        if (k.cryptoAlgorithm) lines.push(`  cryptographic-algorithm ${k.cryptoAlgorithm}`);
        if (k.keyString !== undefined) {
          const prefix = k.keyStringHidden !== undefined ? `${k.keyStringHidden} ` : '';
          lines.push(`  key-string ${prefix}${k.keyString}`);
        }
        if (k.acceptLifetime) lines.push(`  accept-lifetime ${k.acceptLifetime.start} ${k.acceptLifetime.end}`);
        if (k.sendLifetime) lines.push(`  send-lifetime ${k.sendLifetime.start} ${k.sendLifetime.end}`);
        if (k.sendId !== undefined) lines.push(`  send-id ${k.sendId}`);
        if (k.recvId !== undefined) lines.push(`  recv-id ${k.recvId}`);
      }
    }
    return lines;
  }
}

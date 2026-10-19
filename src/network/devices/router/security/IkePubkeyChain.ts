import type { RsaPublicKey } from '@/crypto/rsa';
import { decodeRsaPublicKey } from '../../../ipsec/RsaPublicKeyDer';

export type IkeKeyUsage = 'general' | 'encryption' | 'signature';

export interface IkePeerKey {
  readonly kind: 'named' | 'addressed';
  readonly name: string;
  address?: string;
  readonly usage: IkeKeyUsage;
  spki: Uint8Array | null;
}

export class IkePubkeyChain {
  private readonly keys: IkePeerKey[] = [];

  list(): readonly IkePeerKey[] {
    return this.keys;
  }

  ensure(kind: 'named' | 'addressed', name: string, usage: IkeKeyUsage): IkePeerKey {
    let key = this.keys.find((k) => k.kind === kind && k.name === name && k.usage === usage);
    if (!key) {
      key = { kind, name, usage, spki: null, address: kind === 'addressed' ? name : undefined };
      this.keys.push(key);
    }
    return key;
  }

  remove(kind: 'named' | 'addressed', name: string, usage?: IkeKeyUsage): void {
    for (let i = this.keys.length - 1; i >= 0; i--) {
      const k = this.keys[i];
      if (k.kind === kind && k.name === name && (usage === undefined || k.usage === usage)) this.keys.splice(i, 1);
    }
  }

  removeAt(index: number): boolean {
    if (index < 1 || index > this.keys.length) return false;
    this.keys.splice(index - 1, 1);
    return true;
  }

  clear(): void {
    this.keys.length = 0;
  }

  publicKeyFor(address: string, hostnames: readonly string[], purpose: 'encryption' | 'signature'): RsaPublicKey | null {
    for (const key of this.keys) {
      if (key.spki === null) continue;
      if (key.usage !== 'general' && key.usage !== purpose) continue;
      const matches = key.kind === 'addressed'
        ? key.name === address
        : key.address === address || hostnames.some((h) => h.toLowerCase() === key.name.toLowerCase());
      if (matches) return decodeRsaPublicKey(key.spki);
    }
    return null;
  }
}

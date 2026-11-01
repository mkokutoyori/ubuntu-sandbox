import { IPv6Address } from '../core/types';
import type { IPv6AddressEntry } from './Port';

export const INFINITE_LIFETIME = 0xffffffff;
const UINT32_MAX = 0xffffffff;
const RETRANSMIT_SECONDS = 1;

export interface Ipv6AddrconfPolicy {
  readonly useTempaddr: number;
  readonly tempValidLft: number;
  readonly tempPreferedLft: number;
  readonly maxDesyncFactor: number;
  readonly regenMaxRetry: number;
  readonly dadTransmits: number;
  readonly maxAddresses: number;
}

export interface Ipv6AddrconfEnv {
  now(): number;
  policy(): Ipv6AddrconfPolicy;
  random(): number;
  disableTemporaryAddresses(): void;
}

export const NO_PRIVACY_POLICY: Ipv6AddrconfPolicy = {
  useTempaddr: 0, tempValidLft: 604800, tempPreferedLft: 86400, maxDesyncFactor: 600,
  regenMaxRetry: 3, dadTransmits: 1, maxAddresses: 16,
};

type PendingEvent = { readonly at: number; readonly kind: 'expire' | 'deprecate' | 'regenerate'; readonly entry: IPv6AddressEntry };

function finite(seconds: number | undefined): seconds is number {
  return seconds !== undefined && seconds !== INFINITE_LIFETIME;
}

function keyOf(entry: IPv6AddressEntry): string {
  return entry.address.toString();
}

export function remainingValid(entry: IPv6AddressEntry, now: number): number | null {
  if (!finite(entry.validLifetime) || entry.stampMs === undefined) return null;
  return Math.max(0, entry.validLifetime - Math.floor((now - entry.stampMs) / 1000));
}

export function remainingPreferred(entry: IPv6AddressEntry, now: number): number | null {
  if (!finite(entry.preferredLifetime) || entry.stampMs === undefined) return null;
  return Math.max(0, entry.preferredLifetime - Math.floor((now - entry.stampMs) / 1000));
}

export class Ipv6Addrconf {
  private desyncFactor = UINT32_MAX;

  constructor(private readonly env: Ipv6AddrconfEnv) {}

  remaining(entry: IPv6AddressEntry): { valid: number | null; preferred: number | null } {
    const now = this.env.now();
    return { valid: remainingValid(entry, now), preferred: remainingPreferred(entry, now) };
  }

  preferTemporary(): boolean {
    return this.env.policy().useTempaddr >= 2;
  }

  receivePrefix(
    entries: IPv6AddressEntry[], address: IPv6Address, prefixLength: number, valid: number, preferred: number,
  ): { entries: IPv6AddressEntry[]; created: boolean } {
    const now = this.env.now();
    const policy = this.env.policy();
    if (preferred > valid) return { entries, created: false };
    let list = this.verify(entries, now);
    let existing = list.find((entry) => !entry.temporary && entry.address.equals(address));
    let created = false;
    if (existing === undefined && valid > 0) {
      if (policy.maxAddresses !== 0 && list.length >= policy.maxAddresses) return { entries: list, created: false };
      existing = {
        address, prefixLength, origin: 'slaac',
        validLifetime: valid, preferredLifetime: preferred, stampMs: now, createdMs: now, managesTemporary: true,
      };
      list = [...list, existing];
      created = true;
    }
    if (existing !== undefined) {
      const stored = remainingValid(existing, now);
      if (!created && (stored === null || stored > 0)) {
        existing.validLifetime = valid;
        existing.preferredLifetime = preferred;
        existing.stampMs = now;
        existing.deprecated = false;
      }
      list = this.manageTemporary(list, existing, valid, preferred, created, now);
    }
    return { entries: list, created };
  }

  verify(entries: IPv6AddressEntry[], upTo: number = this.env.now()): IPv6AddressEntry[] {
    let list = entries;
    for (;;) {
      const next = this.nextEvent(list);
      if (next === null || next.at > upTo) return list;
      list = this.apply(list, next);
    }
  }

  private nextEvent(entries: readonly IPv6AddressEntry[]): PendingEvent | null {
    const policy = this.env.policy();
    const regenAdvance = policy.regenMaxRetry * policy.dadTransmits * RETRANSMIT_SECONDS;
    let best: PendingEvent | null = null;
    const consider = (candidate: PendingEvent): void => {
      if (best === null || candidate.at < best.at) best = candidate;
    };
    for (const entry of entries) {
      if (entry.stampMs === undefined) continue;
      if (finite(entry.validLifetime)) consider({ at: entry.stampMs + entry.validLifetime * 1000, kind: 'expire', entry });
      if (finite(entry.preferredLifetime) && entry.deprecated !== true) {
        const regenerates = entry.temporary === true && (entry.regenCount ?? 0) === 0
          && entries.some((other) => keyOf(other) === entry.publicKey);
        consider(regenerates
          ? { at: entry.stampMs + (entry.preferredLifetime - regenAdvance) * 1000, kind: 'regenerate', entry }
          : { at: entry.stampMs + entry.preferredLifetime * 1000, kind: 'deprecate', entry });
        if (regenerates) consider({ at: entry.stampMs + entry.preferredLifetime * 1000, kind: 'deprecate', entry });
      }
    }
    return best;
  }

  private apply(entries: IPv6AddressEntry[], event: PendingEvent): IPv6AddressEntry[] {
    if (event.kind === 'expire') return entries.filter((entry) => entry !== event.entry);
    if (event.kind === 'deprecate') {
      event.entry.deprecated = true;
      return entries;
    }
    const pub = entries.find((entry) => keyOf(entry) === event.entry.publicKey);
    event.entry.regenCount = (event.entry.regenCount ?? 0) + 1;
    if (pub === undefined) return entries;
    pub.regenCount = 0;
    return this.createTemporary(entries, pub, event.at);
  }

  private manageTemporary(
    entries: IPv6AddressEntry[], pub: IPv6AddressEntry, valid: number, preferred: number, created: boolean, now: number,
  ): IPv6AddressEntry[] {
    const policy = this.env.policy();
    const temporaries = entries.filter((entry) => entry.temporary === true);
    for (const temporary of temporaries) {
      if (temporary.publicKey !== keyOf(pub)) continue;
      const age = Math.floor((now - (temporary.createdMs ?? now)) / 1000);
      const maxValid = Math.max(0, policy.tempValidLft - age);
      const maxPreferred = Math.max(0, policy.tempPreferedLft - this.currentDesync() - age);
      temporary.validLifetime = Math.min(valid, maxValid);
      temporary.preferredLifetime = Math.min(preferred, maxPreferred);
      temporary.stampMs = now;
      if (temporary.preferredLifetime > 0) temporary.deprecated = false;
    }
    if ((created || temporaries.length === 0) && policy.useTempaddr > 0) {
      return this.createTemporary(entries, pub, now);
    }
    return entries;
  }

  private currentDesync(): number {
    return this.desyncFactor === UINT32_MAX ? 0 : this.desyncFactor;
  }

  private createTemporary(entries: IPv6AddressEntry[], pub: IPv6AddressEntry, now: number): IPv6AddressEntry[] {
    const policy = this.env.policy();
    if (policy.useTempaddr <= 0) return entries;
    if ((pub.regenCount ?? 0) >= policy.regenMaxRetry) {
      this.env.disableTemporaryAddresses();
      return entries;
    }
    pub.regenCount = (pub.regenCount ?? 0) + 1;
    const age = Math.floor((now - (pub.stampMs ?? now)) / 1000);
    const regenAdvance = policy.regenMaxRetry * policy.dadTransmits * RETRANSMIT_SECONDS;
    const maxDesync = Math.min(policy.maxDesyncFactor, policy.tempPreferedLft - regenAdvance);
    if (this.desyncFactor > maxDesync) {
      this.desyncFactor = maxDesync > 0 ? Math.floor(this.env.random() * maxDesync) : 0;
    }
    const validLifetime = Math.min(pub.validLifetime ?? INFINITE_LIFETIME, policy.tempValidLft + age);
    const preferredLifetime = Math.min(
      pub.preferredLifetime ?? INFINITE_LIFETIME, policy.tempPreferedLft + age - this.desyncFactor);
    if (preferredLifetime <= regenAdvance + age) return entries;
    let address = this.randomAddress(pub);
    while (entries.some((entry) => entry.address.equals(address))) address = this.randomAddress(pub);
    return [...entries, {
      address, prefixLength: pub.prefixLength, origin: 'slaac', temporary: true, publicKey: keyOf(pub),
      validLifetime, preferredLifetime, stampMs: pub.stampMs, createdMs: now, regenCount: 0,
    }];
  }

  private randomAddress(pub: IPv6AddressEntry): IPv6Address {
    const prefix = pub.address.getHextets();
    const hextets = [...prefix.slice(0, 4)];
    for (let i = 0; i < 4; i++) hextets.push(Math.floor(this.env.random() * 0x10000));
    hextets[4] &= ~0x0200;
    return new IPv6Address(hextets);
  }
}

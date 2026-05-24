/**
 * VtyLineConfigStore — per-device registry of VtyLineConfig blocks.
 *
 * Cisco and Huawei shells call upsert() when an operator sets
 * exec-timeout / idle-timeout / access-class / acl inbound / etc. The
 * `show running-config` (Cisco) and `display current-configuration`
 * (Huawei) renderers walk all() in insertion order to produce the
 * persisted text.
 *
 * Keys are `${first} ${last}` so the same store survives an operator
 * typing `line vty 0 4` then later `line vty 5 15`.
 */

import { VtyLineConfig, type VtyLineConfigInit } from './VtyLineConfig';

export class VtyLineConfigStore {
  private readonly byKey = new Map<string, VtyLineConfig>();

  upsert(patch: VtyLineConfigInit): VtyLineConfig {
    const key = `${patch.first} ${patch.last}`;
    const existing = this.byKey.get(key);
    const next = existing ? existing.withFields(patch) : new VtyLineConfig(patch);
    this.byKey.set(key, next);
    return next;
  }

  get(first: number, last: number): VtyLineConfig | undefined {
    return this.byKey.get(`${first} ${last}`);
  }

  all(): readonly VtyLineConfig[] {
    return Array.from(this.byKey.values());
  }

  clear(): void {
    this.byKey.clear();
  }

  /** Used by show-config renderers: returns the lines for every block in order. */
  renderAllCisco(): string[] {
    const out: string[] = [];
    for (const block of this.all()) {
      out.push(...block.renderCisco());
      out.push('!');
    }
    return out;
  }

  renderAllHuawei(): string[] {
    const out: string[] = [];
    for (const block of this.all()) {
      out.push(...block.renderHuawei());
      out.push('#');
    }
    return out;
  }
}

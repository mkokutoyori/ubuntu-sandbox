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

import { VtyLineConfig, transportAdmet, type VtyLineConfigInit, type VtyTransport } from './VtyLineConfig';

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

  lineCapacity(defaultCount = 5): number {
    let highest = -1;
    for (const block of this.byKey.values()) {
      if (block.last > highest) highest = block.last;
    }
    return highest >= 0 ? highest + 1 : defaultCount;
  }

  /**
   * Verdict for an incoming VTY session (telnet/SSH). Rejected when a
   * configured line mandates a line password (`login`) that has not been set —
   * IOS then answers "Password required, but none set" and closes the session.
   */
  incomingVerdict(ligne?: number | null): { accept: boolean; reason: string } {
    const bloc = ligne == null ? undefined : this.blocPourLigne(ligne);
    const candidats = bloc ? [bloc] : (ligne == null ? Array.from(this.byKey.values()) : []);
    for (const line of candidats) {
      if (line.requiresPasswordButUnset()) {
        return { accept: false, reason: 'Password required, but none set' };
      }
    }
    return { accept: true, reason: '' };
  }

  /**
   * Le bloc qui gouverne la ligne d'indice donne. `transport input`,
   * `access-class` et `login` sont des directives de LIGNE : une session
   * qui se pose sur la vty 0 obeit au bloc qui contient 0, et pas a ce
   * qu'un autre bloc declare pour d'autres lignes.
   */
  blocPourLigne(index: number): VtyLineConfig | undefined {
    for (const bloc of this.byKey.values()) {
      if (index >= bloc.first && index <= bloc.last) return bloc;
    }
    return undefined;
  }

  /**
   * Un protocole est-il admis par AU MOINS une ligne ? C'est la question
   * que pose l'ecoute : le serveur reste ouvert tant qu'une vty accepte
   * le protocole, meme si une autre le refuse.
   */
  admetQuelquePart(kind: 'ssh' | 'telnet', defaut: VtyTransport = 'all'): boolean {
    if (Array.from(this.byKey.values()).some(b => b.admetTransport(kind, defaut))) return true;
    return this.aUneLigneSansBloc() && transportAdmet(defaut, kind);
  }

  private aUneLigneSansBloc(): boolean {
    const capacite = this.lineCapacity();
    for (let i = 0; i < capacite; i++) {
      if (!this.blocPourLigne(i)) return true;
    }
    return false;
  }

  /** Used by show-config renderers: returns the lines for every block in order. */
  renderAllCisco(serviceEncryption = false): string[] {
    const out: string[] = [];
    for (const block of this.all()) {
      out.push(...block.renderCisco(serviceEncryption));
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

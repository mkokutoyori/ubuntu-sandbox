export const DYNAMIC_UID_MIN = 0xEF00;
export const DYNAMIC_UID_MAX = 0xFFEF;

export interface DynamicUser {
  name: string;
  uid: number;
  gid: number;
}

export class DynamicUserTable {
  private readonly byNameMap = new Map<string, DynamicUser>();
  private readonly byUidMap = new Map<number, DynamicUser>();
  /**
   * Bumped on every real mutation. There is no file to stat behind a
   * dynamic user, so this is what lets a cached NSS answer be keyed on
   * the table's state instead of guessing with a TTL.
   */
  private revision = 0;

  getRevision(): number { return this.revision; }

  allocate(name: string): DynamicUser {
    const existing = this.byNameMap.get(name);
    if (existing) return existing;

    const span = DYNAMIC_UID_MAX - DYNAMIC_UID_MIN + 1;
    let hash = 5381;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash * 33) ^ name.charCodeAt(i)) >>> 0;
    }
    for (let probe = 0; probe < span; probe++) {
      const uid = DYNAMIC_UID_MIN + ((hash + probe) % span);
      if (!this.byUidMap.has(uid)) {
        const user: DynamicUser = { name, uid, gid: uid };
        this.byNameMap.set(name, user);
        this.byUidMap.set(uid, user);
        this.revision++;
        return user;
      }
    }
    throw new Error('dynamic UID space exhausted');
  }

  release(name: string): void {
    const user = this.byNameMap.get(name);
    if (!user) return;
    this.byNameMap.delete(name);
    this.byUidMap.delete(user.uid);
    this.revision++;
  }

  byName(name: string): DynamicUser | null {
    return this.byNameMap.get(name) ?? null;
  }

  byUid(uid: number): DynamicUser | null {
    return this.byUidMap.get(uid) ?? null;
  }

  list(): DynamicUser[] {
    return [...this.byNameMap.values()];
  }
}

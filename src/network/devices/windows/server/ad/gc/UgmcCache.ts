/**
 * UgmcCache — Universal Group Membership Caching (real AD: a non-GC DC
 * avoids contacting a Global Catalog on every logon by periodically
 * caching universal-group memberships locally instead). Pure local
 * state — the cache itself is never replicated; only `UgmcRefreshClient`
 * needs the network, to populate it from a real GC.
 */
export class UgmcCache {
  private enabled = false;
  private lastRefresh: number | null = null;
  private membership = new Map<string, string[]>();

  isEnabled(): boolean { return this.enabled; }

  enable(): void { this.enabled = true; }

  disable(): void {
    this.enabled = false;
    this.membership.clear();
    this.lastRefresh = null;
  }

  getLastRefresh(): number | null { return this.lastRefresh; }

  installSnapshot(membership: Map<string, string[]>, now = Date.now()): void {
    this.membership = membership;
    this.lastRefresh = now;
  }

  /** Cached universal-group SAMs for `userSam`, or `null` if UGMC isn't enabled (caller should fall back to a direct GC query). */
  getCachedUniversalGroupsFor(userSam: string): string[] | null {
    if (!this.enabled) return null;
    return this.membership.get(userSam.toLowerCase()) ?? [];
  }
}

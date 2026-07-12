/**
 * PasswordReplicationPolicy (MS-ADTS §3.1.1.1.11) — an RODC's allow/deny
 * list of principals whose real credentials it's permitted to cache
 * locally. Direct sam membership only (no nested-group expansion), the
 * same simplification already established for `groupsForUser`. An
 * explicit deny always wins over an allow; a principal on neither list
 * defaults to *not* cached — matching a real RODC's default-deny stance.
 */
export class PasswordReplicationPolicy {
  private allowed = new Set<string>();
  private denied = new Set<string>();

  setPolicy(allow: readonly string[], deny: readonly string[]): void {
    this.allowed = new Set(allow.map(s => s.toLowerCase()));
    this.denied = new Set(deny.map(s => s.toLowerCase()));
  }

  getAllowed(): string[] { return [...this.allowed]; }
  getDenied(): string[] { return [...this.denied]; }

  isCachingAllowed(sam: string): boolean {
    const key = sam.toLowerCase();
    if (this.denied.has(key)) return false;
    return this.allowed.has(key);
  }
}

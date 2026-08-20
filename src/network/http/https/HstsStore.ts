/**
 * RFC 6797 — `Strict-Transport-Security` recognized and remembered
 * per-host by the client (PRD-HTTP.md §2.1.K: "reconnu et mémorisé côté
 * client (pas de liste de préchargement globale)"): no bundled preload
 * list, only what a server has actually announced over a prior HTTPS
 * response, expiring after `max-age` seconds.
 */
export interface HstsEntry {
  readonly includeSubDomains: boolean;
  readonly expiresAt: number;
}

function parseHeader(header: string): { maxAgeSeconds: number; includeSubDomains: boolean } | null {
  let maxAgeSeconds: number | null = null;
  let includeSubDomains = false;
  for (const rawDirective of header.split(';')) {
    const directive = rawDirective.trim();
    if (directive.length === 0) continue;
    const [rawName, rawValue] = directive.split('=', 2);
    const name = rawName.trim().toLowerCase();
    if (name === 'max-age') {
      const seconds = Number(rawValue?.trim().replace(/^"|"$/g, ''));
      if (!Number.isFinite(seconds) || seconds < 0) return null;
      maxAgeSeconds = seconds;
    } else if (name === 'includesubdomains') {
      includeSubDomains = true;
    }
  }
  if (maxAgeSeconds === null) return null;
  return { maxAgeSeconds, includeSubDomains };
}

export class HstsStore {
  private readonly entries = new Map<string, HstsEntry>();

  /** Records (or clears, per `max-age=0`) a host's policy from a response header, RFC 6797 §6.1. */
  record(host: string, header: string, now: number): void {
    const parsed = parseHeader(header);
    if (!parsed) return;
    if (parsed.maxAgeSeconds === 0) {
      this.entries.delete(host);
      return;
    }
    this.entries.set(host, { includeSubDomains: parsed.includeSubDomains, expiresAt: now + parsed.maxAgeSeconds * 1000 });
  }

  /** Whether `host` currently has a live (non-expired) HSTS policy — a plain-HTTP attempt should be upgraded. */
  shouldUpgrade(host: string, now: number): boolean {
    const direct = this.entries.get(host);
    if (direct && direct.expiresAt > now) return true;
    for (const [knownHost, entry] of this.entries) {
      if (!entry.includeSubDomains || entry.expiresAt <= now) continue;
      if (host === knownHost || host.endsWith(`.${knownHost}`)) return true;
    }
    return false;
  }

  clear(): void {
    this.entries.clear();
  }
}

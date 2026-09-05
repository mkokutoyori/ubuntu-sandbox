export class TimeZoneError extends Error {}

const canonical = new Map<string, string>();
const instances = new Map<string, TimeZone>();

function canonicalNameOf(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const cached = canonical.get(trimmed);
  if (cached !== undefined) return cached;

  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: trimmed })
      .resolvedOptions().timeZone;
  } catch {
    return null;
  }
  canonical.set(trimmed, resolved);
  return resolved;
}

export class TimeZone {
  private constructor(readonly name: string) {}

  static parse(raw: string): TimeZone | null {
    const name = canonicalNameOf(raw);
    if (name === null) return null;

    const known = instances.get(name);
    if (known) return known;

    const created = new TimeZone(name);
    instances.set(name, created);
    return created;
  }

  static of(raw: string): TimeZone {
    const zone = TimeZone.parse(raw);
    if (!zone) throw new TimeZoneError(`unknown time zone: ${raw}`);
    return zone;
  }

  static isValid(raw: string): boolean {
    return canonicalNameOf(raw) !== null;
  }

  static get UTC(): TimeZone {
    return TimeZone.of('UTC');
  }

  equals(other: TimeZone): boolean {
    return this.name === other.name;
  }

  toString(): string {
    return this.name;
  }
}

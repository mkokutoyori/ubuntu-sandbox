// RFC 9111 §5.2 — Cache-Control directives this engine's private, per-agent cache understands.
export interface CacheControlDirectives {
  noStore: boolean;
  noCache: boolean;
  maxAge?: number;
  sMaxage?: number;
  isPrivate: boolean;
  isPublic: boolean;
  mustRevalidate: boolean;
  immutable: boolean;
}

export function parseCacheControl(header: string | undefined): CacheControlDirectives {
  const directives: CacheControlDirectives = {
    noStore: false,
    noCache: false,
    isPrivate: false,
    isPublic: false,
    mustRevalidate: false,
    immutable: false,
  };
  if (!header) return directives;

  for (const part of header.split(',')) {
    const [rawName, rawValue] = part.split('=').map((s) => s.trim());
    const name = rawName.toLowerCase();
    const value = rawValue?.replace(/^"|"$/g, '');
    switch (name) {
      case 'no-store': directives.noStore = true; break;
      case 'no-cache': directives.noCache = true; break;
      case 'private': directives.isPrivate = true; break;
      case 'public': directives.isPublic = true; break;
      case 'must-revalidate': directives.mustRevalidate = true; break;
      case 'immutable': directives.immutable = true; break;
      case 'max-age': {
        const n = parseInt(value ?? '', 10);
        if (!isNaN(n)) directives.maxAge = n;
        break;
      }
      case 's-maxage': {
        const n = parseInt(value ?? '', 10);
        if (!isNaN(n)) directives.sMaxage = n;
        break;
      }
      default: break;
    }
  }
  return directives;
}

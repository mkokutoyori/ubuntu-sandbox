/**
 * WhereisResolver — locate the binary, manual-page and source files for a
 * command name, mirroring `whereis(1)`. Directory lists are configurable
 * (and default to the standard Debian/Ubuntu layout) so the resolver stays
 * realistic and reusable.
 */

export interface WhereisDirectories {
  readonly binary: readonly string[];
  readonly manual: readonly string[];
  readonly source: readonly string[];
}

/** Standard Ubuntu search paths, matching `whereis -l`. */
export const DEFAULT_WHEREIS_DIRECTORIES: WhereisDirectories = {
  binary: [
    '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/usr/local/sbin',
    '/usr/games', '/usr/local/games', '/snap/bin',
  ],
  manual: [
    '/usr/share/man', '/usr/local/share/man', '/usr/share/info', '/usr/local/man',
  ],
  source: [
    '/usr/src', '/usr/local/src',
  ],
};

/** Which categories to report (whereis `-b`, `-m`, `-s`; default: all). */
export interface WhereisSelector {
  binary: boolean;
  manual: boolean;
  source: boolean;
}

export const ALL_CATEGORIES: WhereisSelector = { binary: true, manual: true, source: true };

export interface WhereisResult {
  readonly name: string;
  readonly binaries: string[];
  readonly manuals: string[];
  readonly sources: string[];
}

/** Filesystem probe surface the resolver needs. */
export interface WhereisFs {
  exists(path: string): boolean;
  /** Directory entry names (no `.`/`..`), or null when not a directory. */
  list(dir: string): string[] | null;
}

const MAN_SECTION_RE = /^(\d|n|l)/;

export class WhereisResolver {
  constructor(
    private readonly fs: WhereisFs,
    private readonly dirs: WhereisDirectories = DEFAULT_WHEREIS_DIRECTORIES,
  ) {}

  /** All search directories, flattened — backs `whereis -l`. */
  allDirectories(): string[] {
    return [...this.dirs.binary, ...this.dirs.manual, ...this.dirs.source];
  }

  locate(name: string, sel: WhereisSelector = ALL_CATEGORIES): WhereisResult {
    const binaries: string[] = [];
    const manuals: string[] = [];
    const sources: string[] = [];

    if (sel.binary) {
      for (const dir of this.dirs.binary) {
        const p = `${dir}/${name}`;
        if (this.fs.exists(p)) binaries.push(p);
      }
    }
    if (sel.manual) {
      for (const dir of this.dirs.manual) {
        manuals.push(...this.findManPages(dir, name));
      }
    }
    if (sel.source) {
      for (const dir of this.dirs.source) {
        const p = `${dir}/${name}`;
        if (this.fs.exists(p)) sources.push(p);
      }
    }
    return { name, binaries, manuals, sources };
  }

  /** Look for `name.<section>[.gz]` under `manDir/man<section>/`. */
  private findManPages(manDir: string, name: string): string[] {
    const hits: string[] = [];
    const entries = this.fs.list(manDir);
    if (!entries) return hits;
    for (const sub of entries) {
      if (!sub.startsWith('man') && sub !== 'info') continue;
      const section = sub.replace(/^man/, '');
      if (sub.startsWith('man') && !MAN_SECTION_RE.test(section)) continue;
      const subDir = `${manDir}/${sub}`;
      const pages = this.fs.list(subDir);
      if (!pages) continue;
      for (const page of pages) {
        if (page === name || page.startsWith(`${name}.`)) hits.push(`${subDir}/${page}`);
      }
    }
    return hits;
  }

  /** `name: <paths…>` line, in whereis order (binaries, manuals, sources). */
  static format(result: WhereisResult, sel: WhereisSelector = ALL_CATEGORIES): string {
    const parts: string[] = [];
    if (sel.binary) parts.push(...result.binaries);
    if (sel.manual) parts.push(...result.manuals);
    if (sel.source) parts.push(...result.sources);
    return parts.length > 0 ? `${result.name}: ${parts.join(' ')}` : `${result.name}:`;
  }
}

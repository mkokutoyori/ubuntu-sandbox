/**
 * CommandResolver — resolve a command name the way Bash does for `type`,
 * `command -v/-V`, and `which`, honouring the precedence
 *   alias → keyword → function → builtin → $PATH file.
 *
 * The resolver is decoupled from the executor through {@link ShellIntrospection}
 * so it can be unit-tested in isolation and reused by any shell front-end.
 */

export type ResolutionKind = 'alias' | 'keyword' | 'function' | 'builtin' | 'file' | 'not-found';

/** A concrete on-disk hit for a command name. */
export interface FileLocation {
  /** Absolute path to the executable. */
  readonly path: string;
  /** Directory component of {@link path}. */
  readonly directory: string;
  /** Final path component. */
  readonly basename: string;
  /** Whether the file carries an execute bit. */
  readonly executable: boolean;
  /** True when synthesised for a simulator-provided command (no real inode). */
  readonly synthetic: boolean;
}

export interface ResolutionDetails {
  aliasValue?: string;
  description?: string;
  special?: boolean;
  location?: FileLocation;
}

/** One interpretation of a name. `type -a` surfaces several, ordered. */
export class CommandResolution {
  constructor(
    readonly name: string,
    readonly kind: ResolutionKind,
    readonly details: ResolutionDetails = {},
  ) {}

  /** Filesystem path when this resolution is a file, else null. */
  get path(): string | null {
    return this.kind === 'file' ? this.details.location!.path : null;
  }

  /** The `type -t` word: alias|keyword|function|builtin|file (empty if absent). */
  get typeWord(): string {
    return this.kind === 'not-found' ? '' : this.kind;
  }

  /** `command -v` form: the path for files, the name for everything else. */
  terse(): string | null {
    switch (this.kind) {
      case 'file': return this.details.location!.path;
      case 'alias': return `alias ${this.name}='${this.details.aliasValue ?? ''}'`;
      case 'not-found': return null;
      default: return this.name;
    }
  }

  /** `type` (verbose) line, matching Bash phrasing. */
  describe(): string {
    switch (this.kind) {
      case 'alias': return `${this.name} is aliased to \`${this.details.aliasValue ?? ''}'`;
      case 'keyword': return `${this.name} is a shell keyword`;
      case 'function': return `${this.name} is a function`;
      case 'builtin': return `${this.name} is a shell builtin`;
      case 'file': return `${this.name} is ${this.details.location!.path}`;
      case 'not-found': return `bash: type: ${this.name}: not found`;
    }
  }
}

/** The shell state the resolver reads. Implemented by the executor. */
export interface ShellIntrospection {
  /** Ordered $PATH directories. */
  readonly pathDirs: readonly string[];
  /** Alias replacement string, or undefined when not an alias. */
  aliasValue(name: string): string | undefined;
  /** Whether a shell function with this name is defined. */
  isFunction(name: string): boolean;
  /** Reserved-word description, or undefined. */
  keywordDescription(name: string): string | undefined;
  /** Builtin metadata `{ description, special }`, or undefined. */
  builtinInfo(name: string): { description: string; special: boolean } | undefined;
  /** All $PATH (or direct-path) matches for `name`, in search order. */
  fileMatches(name: string): FileLocation[];
}

export class CommandResolver {
  constructor(private readonly shell: ShellIntrospection) {}

  /**
   * Every interpretation of `name`, in Bash precedence order. The first
   * element is the one that would actually run. `forcePath` (bash `type -P`
   * / `command -p`) skips the alias/keyword/function/builtin layers.
   */
  resolveAll(name: string, opts: { forcePath?: boolean } = {}): CommandResolution[] {
    const out: CommandResolution[] = [];
    if (!opts.forcePath) {
      const av = this.shell.aliasValue(name);
      if (av !== undefined) out.push(new CommandResolution(name, 'alias', { aliasValue: av }));
      const kw = this.shell.keywordDescription(name);
      if (kw !== undefined) out.push(new CommandResolution(name, 'keyword', { description: kw }));
      if (this.shell.isFunction(name)) out.push(new CommandResolution(name, 'function'));
      const binfo = this.shell.builtinInfo(name);
      if (binfo) out.push(new CommandResolution(name, 'builtin', { description: binfo.description, special: binfo.special }));
    }
    for (const loc of this.shell.fileMatches(name)) {
      out.push(new CommandResolution(name, 'file', { location: loc }));
    }
    if (out.length === 0) out.push(new CommandResolution(name, 'not-found'));
    return out;
  }

  /** The single effective interpretation. */
  resolve(name: string, opts: { forcePath?: boolean } = {}): CommandResolution {
    return this.resolveAll(name, opts)[0];
  }

  /** True when the name resolves to anything runnable. */
  exists(name: string): boolean {
    return this.resolve(name).kind !== 'not-found';
  }
}

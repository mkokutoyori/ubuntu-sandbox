import type { ChildShellRun, EditorFsContext, EditorIdentity, EditorPathKind } from './EditorFsContext';

export class WorkingDirectoryFs implements EditorFsContext {
  readonly identity?: () => EditorIdentity;
  readonly kindOf?: (path: string) => EditorPathKind;
  readonly isReadOnly?: (path: string) => boolean;
  readonly modificationStamp?: (path: string) => string | null;
  readonly canonicalPath?: (path: string) => string | null;
  readonly listDirectory?: (path: string) => string[] | null;
  readonly homeDirectory?: () => string | null;
  readonly environmentVariable?: (name: string) => string | null;
  readonly environmentNames?: () => string[];
  readonly makeDirectory?: (path: string, mode: number) => string | null;
  readonly changeMode?: (path: string, mode: number) => boolean;
  readonly readError?: (path: string) => string | null;
  readonly runChildShell?: (cmd: string, stdin?: string) => ChildShellRun;

  constructor(private readonly inner: EditorFsContext, readonly directory: string) {
    if (inner.identity) this.identity = () => inner.identity!();
    if (inner.kindOf) this.kindOf = (path) => inner.kindOf!(this.resolvePath(path));
    if (inner.isReadOnly) this.isReadOnly = (path) => inner.isReadOnly!(this.resolvePath(path));
    if (inner.modificationStamp) this.modificationStamp = (path) => inner.modificationStamp!(this.resolvePath(path));
    if (inner.canonicalPath) this.canonicalPath = (path) => inner.canonicalPath!(this.resolvePath(path));
    if (inner.listDirectory) this.listDirectory = (path) => inner.listDirectory!(this.resolvePath(path));
    if (inner.homeDirectory) this.homeDirectory = () => inner.homeDirectory!();
    if (inner.environmentVariable) this.environmentVariable = (name) => inner.environmentVariable!(name);
    if (inner.environmentNames) this.environmentNames = () => inner.environmentNames!();
    if (inner.makeDirectory) this.makeDirectory = (path, mode) => inner.makeDirectory!(this.resolvePath(path), mode);
    if (inner.changeMode) this.changeMode = (path, mode) => inner.changeMode!(this.resolvePath(path), mode);
    if (inner.readError) this.readError = (path) => inner.readError!(this.resolvePath(path));
    if (inner.runChildShell) this.runChildShell = (cmd, stdin) => inner.runChildShell!(cmd, stdin, directory);
  }

  resolvePath(path: string): string {
    return this.inner.resolvePath(path.startsWith('/') ? path : `${this.directory}/${path}`);
  }

  readFile(path: string): string | null {
    return this.inner.readFile(this.resolvePath(path));
  }

  writeFile(path: string, content: string): boolean {
    return this.inner.writeFile(this.resolvePath(path), content);
  }

  exists(path: string): boolean {
    return this.inner.exists(this.resolvePath(path));
  }

  deleteFile(path: string): boolean {
    return this.inner.deleteFile(this.resolvePath(path));
  }

  runShellCommand(cmd: string): string {
    return this.inner.runShellCommand(cmd);
  }

  filterThroughShell(cmd: string, input: string): string {
    return this.inner.filterThroughShell(cmd, input);
  }
}

import type { ChildShellRun, EditorFsContext, EditorIdentity, EditorPathKind } from './EditorFsContext';

export class WorkingDirectoryFs implements EditorFsContext {
  readonly identity?: () => EditorIdentity;
  readonly kindOf?: (path: string) => EditorPathKind;
  readonly isReadOnly?: (path: string) => boolean;
  readonly canonicalPath?: (path: string) => string | null;
  readonly runChildShell?: (cmd: string, stdin?: string) => ChildShellRun;

  constructor(private readonly inner: EditorFsContext, readonly directory: string) {
    if (inner.identity) this.identity = () => inner.identity!();
    if (inner.kindOf) this.kindOf = (path) => inner.kindOf!(this.resolvePath(path));
    if (inner.isReadOnly) this.isReadOnly = (path) => inner.isReadOnly!(this.resolvePath(path));
    if (inner.canonicalPath) this.canonicalPath = (path) => inner.canonicalPath!(this.resolvePath(path));
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

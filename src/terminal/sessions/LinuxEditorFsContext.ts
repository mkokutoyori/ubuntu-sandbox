import { LinuxMachine } from '@/network/devices/LinuxMachine';
import type { LinuxShellSession } from '@/network/devices/linux/shell/LinuxShellSession';
import type { ChildShellRun, EditorFsContext, EditorIdentity, EditorPathKind } from '@/network/devices/linux/editors/EditorFsContext';

/**
 * Production EditorFsContext: wires NanoEngine/VimEngine to the real
 * VirtualFileSystem through LinuxMachine's editor pass-throughs, honoring
 * the active terminal's session (cwd/uid/gid) when one is available.
 */
export class LinuxEditorFsContext implements EditorFsContext {
  constructor(
    private readonly dev: LinuxMachine,
    private readonly session?: LinuxShellSession,
  ) {}

  identity(): EditorIdentity {
    return this.dev.editorIdentity(this.session);
  }

  resolvePath(path: string): string {
    return this.session
      ? this.dev.resolveAbsolutePathInSession(path, this.session)
      : this.dev.resolveAbsolutePath(path);
  }

  readFile(path: string): string | null {
    const abs = this.resolvePath(path);
    return this.session
      ? this.dev.readFileForEditorInSession(abs, this.session)
      : this.dev.readFileForEditor(abs);
  }

  writeFile(path: string, content: string): boolean {
    const abs = this.resolvePath(path);
    return this.session
      ? this.dev.writeFileFromEditorInSession(abs, content, this.session)
      : this.dev.writeFileFromEditor(abs, content);
  }

  exists(path: string): boolean {
    return this.readFile(path) !== null;
  }

  kindOf(path: string): EditorPathKind {
    return this.dev.editorPathKind(this.resolvePath(path));
  }

  modificationStamp(path: string): string | null {
    return this.dev.editorModificationStamp(this.resolvePath(path), this.session);
  }

  isReadOnly(path: string): boolean {
    return this.dev.editorPathIsReadOnly(this.resolvePath(path));
  }

  canonicalPath(path: string): string | null {
    return this.dev.editorCanonicalPath(this.resolvePath(path));
  }

  listDirectory(path: string): string[] | null {
    return this.dev.editorListDirectory(this.resolvePath(path), this.session);
  }

  homeDirectory(): string | null {
    return this.dev.editorHomeDirectory(this.session);
  }

  environmentVariable(name: string): string | null {
    return this.dev.editorEnvironmentVariable(name, this.session);
  }

  makeDirectory(path: string, mode: number): string | null {
    return this.dev.editorMakeDirectory(this.resolvePath(path), mode, this.session);
  }

  readError(path: string): string | null {
    return this.dev.editorReadError(this.resolvePath(path), this.session);
  }

  changeMode(path: string, mode: number): boolean {
    return this.dev.editorChangeMode(this.resolvePath(path), mode, this.session);
  }

  deleteFile(path: string): boolean {
    const abs = this.resolvePath(path);
    return this.session
      ? this.dev.deleteFileFromEditorInSession(abs, this.session)
      : this.dev.deleteFileFromEditor(abs);
  }

  runShellCommand(cmd: string): string {
    return this.session
      ? this.dev.runCommandFrameInSession(cmd, this.session)
      : this.dev.executeShellCommandSync(cmd);
  }

  filterThroughShell(cmd: string, input: string): string {
    return this.runChildShell(cmd, input).output;
  }

  runChildShell(cmd: string, stdin?: string, workingDirectory?: string): ChildShellRun {
    return this.dev.runChildShellForEditor(cmd, stdin, this.session, workingDirectory);
  }
}

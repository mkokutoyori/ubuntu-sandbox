import { LinuxMachine } from '@/network/devices/LinuxMachine';
import type { LinuxShellSession } from '@/network/devices/linux/shell/LinuxShellSession';
import type { EditorFsContext } from '@/network/devices/linux/editors/EditorFsContext';

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

  deleteFile(path: string): boolean {
    const abs = this.resolvePath(path);
    return this.session
      ? this.dev.deleteFileFromEditorInSession(abs, this.session)
      : this.dev.deleteFileFromEditor(abs);
  }

  runShellCommand(cmd: string): string {
    return this.dev.executeShellCommandSync(cmd);
  }
}

/**
 * STUB FILE - will be rebuilt with TDD
 * Windows CMD command execution
 */

import { WindowsFileSystem } from './filesystem';

export interface CmdContext {
  currentPath: string;
  fileSystem: WindowsFileSystem;
  environment: Record<string, string>;
}

export interface CmdResult {
  output: string;
  exitCode: number;
  newPath?: string;
}

export async function executeCmdCommand(
  command: string,
  context: CmdContext
): Promise<CmdResult> {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() || '';

  // Stub implementations for common commands
  switch (cmd) {
    case 'dir':
      return { output: 'STUB: Directory listing', exitCode: 0 };
    case 'cd':
      return { output: '', exitCode: 0, newPath: parts[1] || 'C:\\Users\\User' };
    case 'type':
      return { output: 'STUB: File contents', exitCode: 0 };
    case 'echo':
      return { output: parts.slice(1).join(' '), exitCode: 0 };
    case 'mkdir':
    case 'md':
      return { output: '', exitCode: 0 };
    case 'del':
    case 'erase':
      return { output: '', exitCode: 0 };
    case 'copy':
      return { output: 'STUB: 1 file(s) copied.', exitCode: 0 };
    case 'move':
      return { output: 'STUB: 1 file(s) moved.', exitCode: 0 };
    case 'cls':
      return { output: '\x1b[2J\x1b[H', exitCode: 0 };
    default:
      return {
        output: `'${cmd}' is not recognized as an internal or external command,\noperable program or batch file.`,
        exitCode: 1
      };
  }
}

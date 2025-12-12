/**
 * Windows CMD Navigation Commands
 * cd, pushd, popd, etc.
 */

import { WindowsCommandResult, WindowsTerminalState } from '../types';
import { WindowsFileSystem } from '../filesystem';
import { CmdCommandRegistry } from './index';

// Directory stack for pushd/popd
const directoryStack: string[] = [];

export const navigationCommands: CmdCommandRegistry = {
  // CD - Change Directory
  cd: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    // No args - print current directory
    if (args.length === 0) {
      return { output: state.currentPath, exitCode: 0 };
    }

    // Handle /D switch for drive change
    let targetPath = args[0];
    const hasDriveSwitch = args.some(a => a.toLowerCase() === '/d');

    if (hasDriveSwitch) {
      targetPath = args.find(a => a.toLowerCase() !== '/d') || '';
    }

    // Handle .. and .
    if (targetPath === '..') {
      const lastSlash = state.currentPath.lastIndexOf('\\');
      if (lastSlash > 2) {
        const newPath = state.currentPath.substring(0, lastSlash);
        return { output: '', exitCode: 0, newPath };
      }
      // At drive root
      return { output: '', exitCode: 0, newPath: state.currentPath.substring(0, 3) };
    }

    if (targetPath === '.') {
      return { output: '', exitCode: 0 };
    }

    // Handle drive change (e.g., "D:")
    if (targetPath.match(/^[A-Za-z]:$/)) {
      if (!hasDriveSwitch && !fs.drives.has(targetPath.toUpperCase())) {
        return { output: '', error: `The system cannot find the drive specified.`, exitCode: 1 };
      }
      return { output: '', exitCode: 0, newPath: targetPath.toUpperCase() + '\\' };
    }

    // Resolve and validate path
    const fullPath = fs.resolvePath(targetPath, state.currentPath);
    const node = fs.getNode(fullPath);

    if (!node) {
      return { output: '', error: `The system cannot find the path specified.`, exitCode: 1 };
    }

    if (node.type !== 'directory') {
      return { output: '', error: `The directory name is invalid.`, exitCode: 1 };
    }

    return { output: '', exitCode: 0, newPath: fullPath };
  },

  // CHDIR - Alias for CD
  chdir: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    return navigationCommands.cd(args, state, fs);
  },

  // PUSHD - Save current directory and change to new one
  pushd: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      // List directory stack
      if (directoryStack.length === 0) {
        return { output: '', exitCode: 0 };
      }
      return { output: directoryStack.join('\r\n'), exitCode: 0 };
    }

    const targetPath = args[0];
    const fullPath = fs.resolvePath(targetPath, state.currentPath);
    const node = fs.getNode(fullPath);

    if (!node || node.type !== 'directory') {
      return { output: '', error: 'The system cannot find the path specified.', exitCode: 1 };
    }

    directoryStack.push(state.currentPath);
    return { output: '', exitCode: 0, newPath: fullPath };
  },

  // POPD - Return to pushed directory
  popd: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (directoryStack.length === 0) {
      return { output: '', error: 'Unable to pop the directory stack.', exitCode: 1 };
    }

    const newPath = directoryStack.pop()!;
    return { output: '', exitCode: 0, newPath };
  },

  // MD / MKDIR - Make Directory
  md: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return { output: '', error: 'The syntax of the command is incorrect.', exitCode: 1 };
    }

    for (const dirPath of args) {
      const fullPath = fs.resolvePath(dirPath, state.currentPath);

      // Create parent directories if needed
      const parts = fullPath.slice(3).split('\\').filter(p => p);
      let currentPath = fullPath.substring(0, 3);

      for (const part of parts) {
        currentPath = currentPath.endsWith('\\') ? currentPath + part : currentPath + '\\' + part;
        if (!fs.exists(currentPath)) {
          const success = fs.createNode(currentPath, 'directory');
          if (!success) {
            return { output: '', error: `A subdirectory or file ${dirPath} already exists.`, exitCode: 1 };
          }
        }
      }
    }

    return { output: '', exitCode: 0 };
  },

  // MKDIR - Alias for MD
  mkdir: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    return navigationCommands.md(args, state, fs);
  },

  // RD / RMDIR - Remove Directory
  rd: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return { output: '', error: 'The syntax of the command is incorrect.', exitCode: 1 };
    }

    const recursive = args.some(a => a.toLowerCase() === '/s');
    const quiet = args.some(a => a.toLowerCase() === '/q');
    const dirs = args.filter(a => !a.startsWith('/'));

    for (const dirPath of dirs) {
      const fullPath = fs.resolvePath(dirPath, state.currentPath);
      const node = fs.getNode(fullPath);

      if (!node) {
        return { output: '', error: `The system cannot find the file specified.`, exitCode: 1 };
      }

      if (node.type !== 'directory') {
        return { output: '', error: `The directory name is invalid.`, exitCode: 1 };
      }

      if (node.children && node.children.size > 0 && !recursive) {
        return { output: '', error: `The directory is not empty.`, exitCode: 1 };
      }

      const success = fs.deleteNode(fullPath, recursive);
      if (!success) {
        return { output: '', error: `Access is denied.`, exitCode: 1 };
      }
    }

    return { output: '', exitCode: 0 };
  },

  // RMDIR - Alias for RD
  rmdir: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    return navigationCommands.rd(args, state, fs);
  },
};

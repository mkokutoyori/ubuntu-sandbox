/**
 * Windows CMD File Commands
 * dir, type, copy, move, del, ren, attrib, etc.
 */

import { WindowsCommandResult, WindowsTerminalState, WindowsFileNode } from '../types';
import { WindowsFileSystem } from '../filesystem';
import { CmdCommandRegistry } from './index';

function formatFileSize(size: number): string {
  return size.toLocaleString().padStart(14, ' ');
}

function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = date.getHours() >= 12 ? 'PM' : 'AM';
  const hour12 = date.getHours() % 12 || 12;
  return `${month}/${day}/${year}  ${String(hour12).padStart(2, '0')}:${minutes} ${ampm}`;
}

function matchWildcard(pattern: string, name: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`, 'i').test(name);
}

export const fileCommands: CmdCommandRegistry = {
  // DIR - List Directory Contents
  dir: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    let targetPath = state.currentPath;
    let pattern = '*';
    let showHidden = false;
    let wideFormat = false;
    let bareFormat = false;
    let showAttributes = false;
    let sortBy = '';
    let recursive = false;

    // Parse arguments
    for (const arg of args) {
      const lower = arg.toLowerCase();
      if (lower === '/a' || lower === '/a:h' || lower === '/ah') {
        showHidden = true;
      } else if (lower === '/w') {
        wideFormat = true;
      } else if (lower === '/b') {
        bareFormat = true;
      } else if (lower === '/s') {
        recursive = true;
      } else if (lower.startsWith('/o')) {
        sortBy = lower.slice(2) || 'n';
      } else if (!arg.startsWith('/')) {
        // Check if it's a path or pattern
        if (arg.includes('*') || arg.includes('?')) {
          pattern = arg;
        } else {
          targetPath = fs.resolvePath(arg, state.currentPath);
        }
      }
    }

    const node = fs.getNode(targetPath);
    if (!node) {
      return { output: '', error: 'File Not Found', exitCode: 1 };
    }

    if (node.type === 'file') {
      // Single file
      const output = bareFormat
        ? node.name
        : `${formatDate(node.modified)}    ${formatFileSize(node.size)} ${node.name}`;
      return { output, exitCode: 0 };
    }

    // Directory listing
    let items = Array.from(node.children!.values());

    // Filter by pattern
    if (pattern !== '*') {
      items = items.filter(item => matchWildcard(pattern, item.name));
    }

    // Filter hidden files unless /a specified
    if (!showHidden) {
      items = items.filter(item => !item.attributes.hidden);
    }

    // Sort
    items.sort((a, b) => {
      // Directories first
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (b.type === 'directory' && a.type !== 'directory') return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    if (bareFormat) {
      // Bare format - just names
      const output = items.map(item => item.name).join('\r\n');
      return { output, exitCode: 0 };
    }

    // Full format
    let output = '';
    output += ` Volume in drive ${targetPath[0]} has no label.\r\n`;
    output += ` Volume Serial Number is ABCD-1234\r\n\r\n`;
    output += ` Directory of ${targetPath}\r\n\r\n`;

    let fileCount = 0;
    let dirCount = 0;
    let totalSize = 0;

    // Add . and .. for non-root directories
    if (targetPath.length > 3) {
      output += `${formatDate(node.modified)}    <DIR>          .\r\n`;
      output += `${formatDate(node.modified)}    <DIR>          ..\r\n`;
      dirCount += 2;
    }

    for (const item of items) {
      const dateStr = formatDate(item.modified);

      if (item.type === 'directory') {
        output += `${dateStr}    <DIR>          ${item.name}\r\n`;
        dirCount++;
      } else {
        output += `${dateStr}    ${formatFileSize(item.size)} ${item.name}\r\n`;
        fileCount++;
        totalSize += item.size;
      }
    }

    output += `               ${fileCount} File(s)  ${totalSize.toLocaleString()} bytes\r\n`;
    output += `               ${dirCount} Dir(s)  10,000,000,000 bytes free`;

    return { output, exitCode: 0 };
  },

  // TYPE - Display File Contents
  type: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return { output: '', error: 'The syntax of the command is incorrect.', exitCode: 1 };
    }

    const outputs: string[] = [];

    for (const filePath of args.filter(a => !a.startsWith('/'))) {
      const fullPath = fs.resolvePath(filePath, state.currentPath);
      const node = fs.getNode(fullPath);

      if (!node) {
        return { output: '', error: `The system cannot find the file specified.`, exitCode: 1 };
      }

      if (node.type === 'directory') {
        return { output: '', error: `Access is denied.`, exitCode: 1 };
      }

      outputs.push(node.content || '');
    }

    return { output: outputs.join('\r\n'), exitCode: 0 };
  },

  // COPY - Copy Files
  copy: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length < 2) {
      return { output: '', error: 'The syntax of the command is incorrect.', exitCode: 1 };
    }

    const sources = args.slice(0, -1).filter(a => !a.startsWith('/'));
    const dest = args[args.length - 1];
    const quiet = args.some(a => a.toLowerCase() === '/y');

    let copiedCount = 0;

    for (const source of sources) {
      const srcPath = fs.resolvePath(source, state.currentPath);
      const srcNode = fs.getNode(srcPath);

      if (!srcNode) {
        return { output: '', error: `The system cannot find the file specified.`, exitCode: 1 };
      }

      if (srcNode.type === 'directory') {
        return { output: '', error: `The syntax of the command is incorrect.`, exitCode: 1 };
      }

      let destPath = fs.resolvePath(dest, state.currentPath);
      const destNode = fs.getNode(destPath);

      // If destination is a directory, copy into it
      if (destNode && destNode.type === 'directory') {
        destPath = destPath + '\\' + srcNode.name;
      }

      const success = fs.copyNode(srcPath, destPath);
      if (!success) {
        return { output: '', error: `Access is denied.`, exitCode: 1 };
      }

      copiedCount++;
    }

    return { output: `        ${copiedCount} file(s) copied.`, exitCode: 0 };
  },

  // XCOPY - Extended Copy (simple implementation)
  xcopy: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    // Similar to copy but handles directories
    return fileCommands.copy(args, state, fs);
  },

  // MOVE - Move/Rename Files
  move: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length < 2) {
      return { output: '', error: 'The syntax of the command is incorrect.', exitCode: 1 };
    }

    const sources = args.slice(0, -1).filter(a => !a.startsWith('/'));
    const dest = args[args.length - 1];

    let movedCount = 0;

    for (const source of sources) {
      const srcPath = fs.resolvePath(source, state.currentPath);
      const srcNode = fs.getNode(srcPath);

      if (!srcNode) {
        return { output: '', error: `The system cannot find the file specified.`, exitCode: 1 };
      }

      let destPath = fs.resolvePath(dest, state.currentPath);
      const destNode = fs.getNode(destPath);

      // If destination is a directory, move into it
      if (destNode && destNode.type === 'directory') {
        destPath = destPath + '\\' + srcNode.name;
      }

      const success = fs.moveNode(srcPath, destPath);
      if (!success) {
        return { output: '', error: `Access is denied.`, exitCode: 1 };
      }

      movedCount++;
    }

    return { output: `        ${movedCount} file(s) moved.`, exitCode: 0 };
  },

  // DEL / ERASE - Delete Files
  del: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return { output: '', error: 'The syntax of the command is incorrect.', exitCode: 1 };
    }

    const quiet = args.some(a => a.toLowerCase() === '/q');
    const force = args.some(a => a.toLowerCase() === '/f');
    const recursive = args.some(a => a.toLowerCase() === '/s');
    const files = args.filter(a => !a.startsWith('/'));

    for (const file of files) {
      const filePath = fs.resolvePath(file, state.currentPath);

      // Handle wildcards
      if (file.includes('*') || file.includes('?')) {
        const lastSlash = filePath.lastIndexOf('\\');
        const dirPath = lastSlash > 2 ? filePath.substring(0, lastSlash) : filePath.substring(0, 3);
        const pattern = filePath.substring(lastSlash + 1);

        const dirNode = fs.getNode(dirPath);
        if (!dirNode || dirNode.type !== 'directory') continue;

        const toDelete: string[] = [];
        dirNode.children!.forEach((node, name) => {
          if (node.type === 'file' && matchWildcard(pattern, name)) {
            toDelete.push(name);
          }
        });

        for (const name of toDelete) {
          fs.deleteNode(dirPath + '\\' + name);
        }
      } else {
        const node = fs.getNode(filePath);
        if (!node) {
          return { output: '', error: `Could Not Find ${file}`, exitCode: 1 };
        }

        if (node.type === 'directory') {
          return { output: '', error: `Access is denied.`, exitCode: 1 };
        }

        if (node.attributes.readonly && !force) {
          return { output: '', error: `Access is denied.`, exitCode: 1 };
        }

        fs.deleteNode(filePath);
      }
    }

    return { output: '', exitCode: 0 };
  },

  // ERASE - Alias for DEL
  erase: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    return fileCommands.del(args, state, fs);
  },

  // REN / RENAME - Rename Files
  ren: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length < 2) {
      return { output: '', error: 'The syntax of the command is incorrect.', exitCode: 1 };
    }

    const [oldName, newName] = args;
    const oldPath = fs.resolvePath(oldName, state.currentPath);

    if (!fs.exists(oldPath)) {
      return { output: '', error: `The system cannot find the file specified.`, exitCode: 1 };
    }

    // New name should just be a name, not a path
    const lastSlash = oldPath.lastIndexOf('\\');
    const parentPath = oldPath.substring(0, lastSlash);
    const newPath = parentPath + '\\' + newName;

    const success = fs.moveNode(oldPath, newPath);
    if (!success) {
      return { output: '', error: `Access is denied.`, exitCode: 1 };
    }

    return { output: '', exitCode: 0 };
  },

  // RENAME - Alias for REN
  rename: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    return fileCommands.ren(args, state, fs);
  },

  // ATTRIB - Display/Change File Attributes
  attrib: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      // Show attributes for all files in current directory
      const node = fs.getNode(state.currentPath);
      if (!node || node.type !== 'directory') {
        return { output: '', error: 'Invalid path', exitCode: 1 };
      }

      let output = '';
      node.children!.forEach((item, name) => {
        const attrs = [
          item.attributes.archive ? 'A' : ' ',
          item.attributes.system ? 'S' : ' ',
          item.attributes.hidden ? 'H' : ' ',
          item.attributes.readonly ? 'R' : ' ',
        ].join('');
        output += `${attrs}    ${state.currentPath}\\${name}\r\n`;
      });

      return { output, exitCode: 0 };
    }

    // Parse attribute changes
    const setReadonly = args.includes('+r') || args.includes('+R');
    const unsetReadonly = args.includes('-r') || args.includes('-R');
    const setHidden = args.includes('+h') || args.includes('+H');
    const unsetHidden = args.includes('-h') || args.includes('-H');
    const setSystem = args.includes('+s') || args.includes('+S');
    const unsetSystem = args.includes('-s') || args.includes('-S');
    const setArchive = args.includes('+a') || args.includes('+A');
    const unsetArchive = args.includes('-a') || args.includes('-A');

    const files = args.filter(a => !a.match(/^[+-][rhsa]$/i));

    for (const file of files) {
      const filePath = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(filePath);

      if (!node) {
        return { output: '', error: `File not found - ${file}`, exitCode: 1 };
      }

      if (setReadonly) node.attributes.readonly = true;
      if (unsetReadonly) node.attributes.readonly = false;
      if (setHidden) node.attributes.hidden = true;
      if (unsetHidden) node.attributes.hidden = false;
      if (setSystem) node.attributes.system = true;
      if (unsetSystem) node.attributes.system = false;
      if (setArchive) node.attributes.archive = true;
      if (unsetArchive) node.attributes.archive = false;
    }

    return { output: '', exitCode: 0 };
  },

  // ECHO - Display Message (also handles file creation)
  echo: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return { output: 'ECHO is on.', exitCode: 0 };
    }

    const message = args.join(' ');

    // Handle echo. (echo with dot = blank line)
    if (message === '.') {
      return { output: '', exitCode: 0 };
    }

    return { output: message, exitCode: 0 };
  },

  // TREE - Display Directory Structure
  tree: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const showFiles = args.some(a => a.toLowerCase() === '/f');
    const targetPath = args.find(a => !a.startsWith('/')) || state.currentPath;

    const fullPath = fs.resolvePath(targetPath, state.currentPath);
    const node = fs.getNode(fullPath);

    if (!node || node.type !== 'directory') {
      return { output: '', error: 'Invalid path', exitCode: 1 };
    }

    let output = `Folder PATH listing\r\nVolume serial number is ABCD-1234\r\n${fullPath}\r\n`;

    function printTree(dirNode: WindowsFileNode, prefix: string, isLast: boolean): void {
      const items = Array.from(dirNode.children!.values())
        .filter(item => showFiles || item.type === 'directory')
        .sort((a, b) => a.name.localeCompare(b.name));

      items.forEach((item, index) => {
        const isLastItem = index === items.length - 1;
        const connector = isLastItem ? '\\---' : '+---';
        const newPrefix = prefix + (isLastItem ? '    ' : '|   ');

        output += `${prefix}${connector}${item.name}\r\n`;

        if (item.type === 'directory' && item.children && item.children.size > 0) {
          printTree(item, newPrefix, isLastItem);
        }
      });
    }

    printTree(node, '', true);

    return { output, exitCode: 0 };
  },

  // FC - File Compare (simple)
  fc: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length < 2) {
      return { output: '', error: 'FC: Insufficient number of file specifications', exitCode: 1 };
    }

    const [file1, file2] = args.filter(a => !a.startsWith('/'));
    const path1 = fs.resolvePath(file1, state.currentPath);
    const path2 = fs.resolvePath(file2, state.currentPath);

    const node1 = fs.getNode(path1);
    const node2 = fs.getNode(path2);

    if (!node1 || !node2) {
      return { output: '', error: 'The system cannot find the file specified.', exitCode: 1 };
    }

    if (node1.type !== 'file' || node2.type !== 'file') {
      return { output: '', error: 'Cannot compare directories.', exitCode: 1 };
    }

    if (node1.content === node2.content) {
      return { output: `Comparing files ${file1} and ${file2}\r\nFC: no differences encountered`, exitCode: 0 };
    }

    return { output: `Comparing files ${file1} and ${file2}\r\n***** ${file1}\r\n${node1.content}\r\n***** ${file2}\r\n${node2.content}\r\n*****`, exitCode: 1 };
  },
};

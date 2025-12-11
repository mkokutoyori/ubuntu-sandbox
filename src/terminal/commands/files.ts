import { CommandRegistry } from './index';

export const fileCommands: CommandRegistry = {
  cat: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'cat: missing operand', exitCode: 1 };
    }

    const outputs: string[] = [];
    let showLineNumbers = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-n') {
        showLineNumbers = true;
      } else {
        files.push(arg);
      }
    }

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node) {
        return { output: '', error: `cat: ${file}: No such file or directory`, exitCode: 1 };
      }

      if (node.type === 'directory') {
        return { output: '', error: `cat: ${file}: Is a directory`, exitCode: 1 };
      }

      if (!fs.canRead(path, state.currentUser)) {
        return { output: '', error: `cat: ${file}: Permission denied`, exitCode: 1 };
      }

      let content = node.content || '';
      if (showLineNumbers) {
        content = content.split('\n').map((line, i) => `     ${i + 1}  ${line}`).join('\n');
      }
      outputs.push(content);
    }

    return { output: outputs.join('\n'), exitCode: 0 };
  },

  touch: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'touch: missing file operand', exitCode: 1 };
    }

    for (const file of args) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (node) {
        node.modified = new Date();
      } else {
        const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
        if (!fs.canWrite(parentPath, state.currentUser)) {
          return { output: '', error: `touch: cannot touch '${file}': Permission denied`, exitCode: 1 };
        }
        fs.createNode(path, 'file', state.currentUser);
      }
    }

    return { output: '', exitCode: 0 };
  },

  mkdir: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'mkdir: missing operand', exitCode: 1 };
    }

    let createParents = false;
    const dirs: string[] = [];

    for (const arg of args) {
      if (arg === '-p') {
        createParents = true;
      } else if (!arg.startsWith('-')) {
        dirs.push(arg);
      }
    }

    for (const dir of dirs) {
      const path = fs.resolvePath(dir, state.currentPath);

      if (createParents) {
        const parts = path.split('/').filter(p => p);
        let currentPath = '';
        for (const part of parts) {
          currentPath += '/' + part;
          if (!fs.getNode(currentPath)) {
            fs.createNode(currentPath, 'directory', state.currentUser);
          }
        }
      } else {
        const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
        if (!fs.getNode(parentPath)) {
          return { output: '', error: `mkdir: cannot create directory '${dir}': No such file or directory`, exitCode: 1 };
        }
        if (fs.getNode(path)) {
          return { output: '', error: `mkdir: cannot create directory '${dir}': File exists`, exitCode: 1 };
        }
        if (!fs.canWrite(parentPath, state.currentUser)) {
          return { output: '', error: `mkdir: cannot create directory '${dir}': Permission denied`, exitCode: 1 };
        }
        fs.createNode(path, 'directory', state.currentUser);
      }
    }

    return { output: '', exitCode: 0 };
  },

  rmdir: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'rmdir: missing operand', exitCode: 1 };
    }

    for (const dir of args) {
      if (dir.startsWith('-')) continue;
      
      const path = fs.resolvePath(dir, state.currentPath);
      const node = fs.getNode(path);

      if (!node) {
        return { output: '', error: `rmdir: failed to remove '${dir}': No such file or directory`, exitCode: 1 };
      }

      if (node.type !== 'directory') {
        return { output: '', error: `rmdir: failed to remove '${dir}': Not a directory`, exitCode: 1 };
      }

      if (node.children && node.children.size > 0) {
        return { output: '', error: `rmdir: failed to remove '${dir}': Directory not empty`, exitCode: 1 };
      }

      fs.deleteNode(path);
    }

    return { output: '', exitCode: 0 };
  },

  rm: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'rm: missing operand', exitCode: 1 };
    }

    let recursive = false;
    let force = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-r' || arg === '-R' || arg === '--recursive') {
        recursive = true;
      } else if (arg === '-f' || arg === '--force') {
        force = true;
      } else if (arg === '-rf' || arg === '-fr') {
        recursive = true;
        force = true;
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
    }

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node) {
        if (!force) {
          return { output: '', error: `rm: cannot remove '${file}': No such file or directory`, exitCode: 1 };
        }
        continue;
      }

      if (node.type === 'directory' && !recursive) {
        return { output: '', error: `rm: cannot remove '${file}': Is a directory`, exitCode: 1 };
      }

      const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
      if (!fs.canWrite(parentPath, state.currentUser)) {
        return { output: '', error: `rm: cannot remove '${file}': Permission denied`, exitCode: 1 };
      }

      fs.deleteNode(path, recursive);
    }

    return { output: '', exitCode: 0 };
  },

  cp: (args, state, fs) => {
    if (args.length < 2) {
      return { output: '', error: 'cp: missing file operand', exitCode: 1 };
    }

    let recursive = false;
    const paths: string[] = [];

    for (const arg of args) {
      if (arg === '-r' || arg === '-R' || arg === '--recursive') {
        recursive = true;
      } else if (!arg.startsWith('-')) {
        paths.push(arg);
      }
    }

    if (paths.length < 2) {
      return { output: '', error: 'cp: missing destination file operand', exitCode: 1 };
    }

    const dest = paths.pop()!;
    const destPath = fs.resolvePath(dest, state.currentPath);
    const destNode = fs.getNode(destPath);

    for (const src of paths) {
      const srcPath = fs.resolvePath(src, state.currentPath);
      const srcNode = fs.getNode(srcPath);

      if (!srcNode) {
        return { output: '', error: `cp: cannot stat '${src}': No such file or directory`, exitCode: 1 };
      }

      if (srcNode.type === 'directory' && !recursive) {
        return { output: '', error: `cp: -r not specified; omitting directory '${src}'`, exitCode: 1 };
      }

      let finalDest = destPath;
      if (destNode && destNode.type === 'directory') {
        finalDest = destPath + '/' + srcNode.name;
      }

      fs.copyNode(srcPath, finalDest, state.currentUser);
    }

    return { output: '', exitCode: 0 };
  },

  mv: (args, state, fs) => {
    if (args.length < 2) {
      return { output: '', error: 'mv: missing file operand', exitCode: 1 };
    }

    const paths = args.filter(a => !a.startsWith('-'));

    if (paths.length < 2) {
      return { output: '', error: 'mv: missing destination file operand', exitCode: 1 };
    }

    const dest = paths.pop()!;
    const destPath = fs.resolvePath(dest, state.currentPath);
    const destNode = fs.getNode(destPath);

    for (const src of paths) {
      const srcPath = fs.resolvePath(src, state.currentPath);
      const srcNode = fs.getNode(srcPath);

      if (!srcNode) {
        return { output: '', error: `mv: cannot stat '${src}': No such file or directory`, exitCode: 1 };
      }

      let finalDest = destPath;
      if (destNode && destNode.type === 'directory') {
        finalDest = destPath + '/' + srcNode.name;
      }

      fs.moveNode(srcPath, finalDest);
    }

    return { output: '', exitCode: 0 };
  },

  ln: (args, state, fs) => {
    let symbolic = false;
    const paths: string[] = [];

    for (const arg of args) {
      if (arg === '-s' || arg === '--symbolic') {
        symbolic = true;
      } else if (!arg.startsWith('-')) {
        paths.push(arg);
      }
    }

    if (paths.length < 2) {
      return { output: '', error: 'ln: missing file operand', exitCode: 1 };
    }

    const target = paths[0];
    const linkPath = fs.resolvePath(paths[1], state.currentPath);

    if (!symbolic) {
      return { output: '', error: 'ln: hard links not supported in this simulation', exitCode: 1 };
    }

    const parentPath = linkPath.substring(0, linkPath.lastIndexOf('/')) || '/';
    const parent = fs.getNode(parentPath);

    if (!parent || parent.type !== 'directory') {
      return { output: '', error: `ln: failed to create symbolic link '${paths[1]}': No such file or directory`, exitCode: 1 };
    }

    const linkName = linkPath.substring(linkPath.lastIndexOf('/') + 1);
    parent.children!.set(linkName, {
      name: linkName,
      type: 'symlink',
      target,
      permissions: 'lrwxrwxrwx',
      owner: state.currentUser,
      group: state.currentUser,
      size: target.length,
      modified: new Date(),
      created: new Date(),
    });

    return { output: '', exitCode: 0 };
  },

  chmod: (args, state, fs) => {
    if (args.length < 2) {
      return { output: '', error: 'chmod: missing operand', exitCode: 1 };
    }

    let recursive = false;
    let mode = '';
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-R' || arg === '--recursive') {
        recursive = true;
      } else if (!mode && /^[0-7]{3,4}$|^[ugoa]*[+-=][rwxXst]*$/.test(arg)) {
        mode = arg;
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
    }

    if (!mode || files.length === 0) {
      return { output: '', error: 'chmod: missing operand', exitCode: 1 };
    }

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node) {
        return { output: '', error: `chmod: cannot access '${file}': No such file or directory`, exitCode: 1 };
      }

      if (node.owner !== state.currentUser && state.currentUser !== 'root') {
        return { output: '', error: `chmod: changing permissions of '${file}': Operation not permitted`, exitCode: 1 };
      }

      // Simple numeric mode handling
      if (/^[0-7]{3,4}$/.test(mode)) {
        const perms = mode.length === 4 ? mode.slice(1) : mode;
        const type = node.type === 'directory' ? 'd' : node.type === 'symlink' ? 'l' : '-';
        node.permissions = type + octalToPermString(perms);
      }
    }

    return { output: '', exitCode: 0 };
  },

  chown: (args, state, fs) => {
    if (state.currentUser !== 'root') {
      return { output: '', error: 'chown: Operation not permitted', exitCode: 1 };
    }

    if (args.length < 2) {
      return { output: '', error: 'chown: missing operand', exitCode: 1 };
    }

    let recursive = false;
    let owner = '';
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-R' || arg === '--recursive') {
        recursive = true;
      } else if (!owner && (arg.includes(':') || !arg.startsWith('-'))) {
        if (!files.length) {
          owner = arg;
        } else {
          files.push(arg);
        }
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
    }

    const [newOwner, newGroup] = owner.split(':');

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node) {
        return { output: '', error: `chown: cannot access '${file}': No such file or directory`, exitCode: 1 };
      }

      if (newOwner) node.owner = newOwner;
      if (newGroup) node.group = newGroup;
    }

    return { output: '', exitCode: 0 };
  },

  stat: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: "stat: missing operand", exitCode: 1 };
    }

    const file = args.filter(a => !a.startsWith('-'))[0];
    const path = fs.resolvePath(file, state.currentPath);
    const node = fs.getNode(path);

    if (!node) {
      return { output: '', error: `stat: cannot stat '${file}': No such file or directory`, exitCode: 1 };
    }

    const output = [
      `  File: ${node.name}`,
      `  Size: ${node.size}\t\tBlocks: ${Math.ceil(node.size / 512)}\t\tIO Block: 4096\t${node.type}`,
      `Access: (${node.permissions})\tUid: (${fs.getUser(node.owner)?.uid || 0}/${node.owner})\tGid: (${fs.getUser(node.owner)?.gid || 0}/${node.group})`,
      `Access: ${node.modified.toISOString()}`,
      `Modify: ${node.modified.toISOString()}`,
      `Change: ${node.modified.toISOString()}`,
      ` Birth: ${node.created.toISOString()}`,
    ];

    return { output: output.join('\n'), exitCode: 0 };
  },

  file: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'Usage: file [-bchikLNnprsvz0] [--apple] [--mime-encoding] [--mime-type] [-e testname] [-F separator] [-f namefile] [-m magicfiles] file ...', exitCode: 1 };
    }

    const file = args.filter(a => !a.startsWith('-'))[0];
    const path = fs.resolvePath(file, state.currentPath);
    const node = fs.getNode(path);

    if (!node) {
      return { output: `${file}: cannot open \`${file}' (No such file or directory)`, exitCode: 1 };
    }

    let type = 'ASCII text';
    if (node.type === 'directory') {
      type = 'directory';
    } else if (node.type === 'symlink') {
      type = `symbolic link to ${node.target}`;
    } else if (node.content?.startsWith('#!/bin/bash') || node.content?.startsWith('#!/bin/sh')) {
      type = 'Bourne-Again shell script, ASCII text executable';
    } else if (node.content?.startsWith('<!DOCTYPE html') || node.content?.startsWith('<html')) {
      type = 'HTML document, ASCII text';
    } else if (node.permissions[3] === 'x') {
      type = 'ELF 64-bit LSB executable';
    }

    return { output: `${file}: ${type}`, exitCode: 0 };
  },
};

function octalToPermString(octal: string): string {
  const permMap: { [key: string]: string } = {
    '0': '---', '1': '--x', '2': '-w-', '3': '-wx',
    '4': 'r--', '5': 'r-x', '6': 'rw-', '7': 'rwx',
  };
  return octal.split('').map(d => permMap[d] || '---').join('');
}

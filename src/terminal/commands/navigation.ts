import { CommandFunction, CommandRegistry } from './index';

export const navigationCommands: CommandRegistry = {
  pwd: (args, state) => ({
    output: state.currentPath,
    exitCode: 0,
  }),

  cd: (args, state, fs) => {
    if (args.length === 0 || args[0] === '~') {
      const user = fs.getUser(state.currentUser);
      return {
        output: '',
        exitCode: 0,
        newPath: user?.home || '/home/' + state.currentUser,
      };
    }

    const target = args[0];
    
    if (target === '-') {
      const oldPwd = state.env['OLDPWD'] || state.currentPath;
      return {
        output: oldPwd,
        exitCode: 0,
        newPath: oldPwd,
      };
    }

    const newPath = fs.resolvePath(target, state.currentPath);
    const node = fs.getNode(newPath);

    if (!node) {
      return {
        output: '',
        error: `cd: ${target}: No such file or directory`,
        exitCode: 1,
      };
    }

    if (node.type !== 'directory') {
      return {
        output: '',
        error: `cd: ${target}: Not a directory`,
        exitCode: 1,
      };
    }

    if (!fs.canExecute(newPath, state.currentUser)) {
      return {
        output: '',
        error: `cd: ${target}: Permission denied`,
        exitCode: 1,
      };
    }

    return {
      output: '',
      exitCode: 0,
      newPath,
    };
  },

  ls: (args, state, fs) => {
    let showHidden = false;
    let longFormat = false;
    let showAll = false;
    let humanReadable = false;
    let targetPath = state.currentPath;

    // Parse options
    const paths: string[] = [];
    for (const arg of args) {
      if (arg.startsWith('-')) {
        if (arg.includes('a')) showAll = true;
        if (arg.includes('A')) showHidden = true;
        if (arg.includes('l')) longFormat = true;
        if (arg.includes('h')) humanReadable = true;
      } else {
        paths.push(arg);
      }
    }

    if (paths.length > 0) {
      targetPath = fs.resolvePath(paths[0], state.currentPath);
    }

    const node = fs.getNode(targetPath);
    if (!node) {
      return {
        output: '',
        error: `ls: cannot access '${paths[0] || targetPath}': No such file or directory`,
        exitCode: 2,
      };
    }

    if (node.type === 'file') {
      if (longFormat) {
        return {
          output: formatLongEntry(node, humanReadable),
          exitCode: 0,
        };
      }
      return { output: node.name, exitCode: 0 };
    }

    let entries = Array.from(node.children!.values());

    if (!showAll && !showHidden) {
      entries = entries.filter(e => !e.name.startsWith('.'));
    } else if (showHidden) {
      entries = entries.filter(e => e.name !== '.' && e.name !== '..');
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    if (longFormat) {
      const lines = [`total ${entries.length * 4}`];
      entries.forEach(entry => {
        lines.push(formatLongEntry(entry, humanReadable));
      });
      return { output: lines.join('\n'), exitCode: 0 };
    }

    const coloredEntries = entries.map(entry => {
      if (entry.type === 'directory') {
        return `\x1b[1;34m${entry.name}\x1b[0m`;
      } else if (entry.type === 'symlink') {
        return `\x1b[1;36m${entry.name}\x1b[0m`;
      } else if (entry.permissions[3] === 'x') {
        return `\x1b[1;32m${entry.name}\x1b[0m`;
      }
      return entry.name;
    });

    return { output: coloredEntries.join('  '), exitCode: 0 };
  },

  tree: (args, state, fs) => {
    let targetPath = state.currentPath;
    let maxDepth = Infinity;
    let showHidden = false;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-L' && args[i + 1]) {
        maxDepth = parseInt(args[i + 1]) || Infinity;
        i++;
      } else if (args[i] === '-a') {
        showHidden = true;
      } else if (!args[i].startsWith('-')) {
        targetPath = fs.resolvePath(args[i], state.currentPath);
      }
    }

    const node = fs.getNode(targetPath);
    if (!node) {
      return {
        output: '',
        error: `${targetPath} [error opening dir]`,
        exitCode: 2,
      };
    }

    if (node.type !== 'directory') {
      return { output: node.name, exitCode: 0 };
    }

    let dirCount = 0;
    let fileCount = 0;

    function buildTree(node: any, prefix: string, depth: number): string[] {
      if (depth > maxDepth) return [];
      
      const lines: string[] = [];
      const entries = Array.from(node.children?.values() || [])
        .filter((e: any) => showHidden || !e.name.startsWith('.'))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));

      entries.forEach((entry: any, index: number) => {
        const isLast = index === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const newPrefix = prefix + (isLast ? '    ' : '│   ');

        let name = entry.name;
        if (entry.type === 'directory') {
          name = `\x1b[1;34m${name}\x1b[0m`;
          dirCount++;
        } else {
          fileCount++;
        }

        lines.push(prefix + connector + name);

        if (entry.type === 'directory' && entry.children) {
          lines.push(...buildTree(entry, newPrefix, depth + 1));
        }
      });

      return lines;
    }

    const treeLines = [targetPath === '/' ? '.' : targetPath.split('/').pop() || '.'];
    treeLines.push(...buildTree(node, '', 1));
    treeLines.push('');
    treeLines.push(`${dirCount} directories, ${fileCount} files`);

    return { output: treeLines.join('\n'), exitCode: 0 };
  },
};

function formatLongEntry(entry: any, humanReadable: boolean): string {
  const permissions = entry.permissions;
  const owner = entry.owner.padEnd(8);
  const group = entry.group.padEnd(8);
  
  let size: string;
  if (humanReadable && entry.size >= 1024) {
    if (entry.size >= 1048576) {
      size = (entry.size / 1048576).toFixed(1) + 'M';
    } else {
      size = (entry.size / 1024).toFixed(1) + 'K';
    }
  } else {
    size = entry.size.toString();
  }
  size = size.padStart(8);

  const date = entry.modified.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  let name = entry.name;
  if (entry.type === 'directory') {
    name = `\x1b[1;34m${name}\x1b[0m`;
  } else if (entry.type === 'symlink') {
    name = `\x1b[1;36m${name}\x1b[0m -> ${entry.target}`;
  } else if (entry.permissions[3] === 'x') {
    name = `\x1b[1;32m${name}\x1b[0m`;
  }

  return `${permissions} 1 ${owner} ${group} ${size} ${date} ${name}`;
}

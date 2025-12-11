import { CommandRegistry } from './index';

export const archiveCommands: CommandRegistry = {
  tar: (args, state, fs) => {
    if (args.length === 0) {
      return {
        output: '',
        error: 'tar: You must specify one of the `-Acdtrux\' or `--test-label\' options',
        exitCode: 2,
      };
    }

    let create = false;
    let extract = false;
    let list = false;
    let verbose = false;
    let gzip = false;
    let file = '';
    const sources: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      
      if (arg.startsWith('-') && !arg.startsWith('--')) {
        if (arg.includes('c')) create = true;
        if (arg.includes('x')) extract = true;
        if (arg.includes('t')) list = true;
        if (arg.includes('v')) verbose = true;
        if (arg.includes('z')) gzip = true;
        if (arg.includes('f') && args[i + 1]) {
          file = args[++i];
        }
      } else if (arg === '--create') create = true;
      else if (arg === '--extract') extract = true;
      else if (arg === '--list') list = true;
      else if (arg === '--verbose') verbose = true;
      else if (arg === '--gzip') gzip = true;
      else if ((arg === '-f' || arg === '--file') && args[i + 1]) {
        file = args[++i];
      } else if (!arg.startsWith('-')) {
        if (!file) file = arg;
        else sources.push(arg);
      }
    }

    if (create) {
      if (!file) {
        return { output: '', error: 'tar: Refusing to write archive contents to terminal', exitCode: 2 };
      }

      const output: string[] = [];
      for (const src of sources) {
        const path = fs.resolvePath(src, state.currentPath);
        const node = fs.getNode(path);
        
        if (!node) {
          return { output: '', error: `tar: ${src}: Cannot stat: No such file or directory`, exitCode: 2 };
        }

        if (verbose) {
          output.push(src);
          if (node.type === 'directory' && node.children) {
            node.children.forEach((_, name) => {
              output.push(`${src}/${name}`);
            });
          }
        }
      }

      // Create the archive file
      fs.createNode(fs.resolvePath(file, state.currentPath), 'file', state.currentUser, `[TAR ARCHIVE: ${sources.join(', ')}]`);

      return { output: output.join('\n'), exitCode: 0 };
    }

    if (extract) {
      if (!file) {
        return { output: '', error: 'tar: You must specify the archive file', exitCode: 2 };
      }

      const archivePath = fs.resolvePath(file, state.currentPath);
      const archive = fs.getNode(archivePath);

      if (!archive) {
        return { output: '', error: `tar: ${file}: Cannot open: No such file or directory`, exitCode: 2 };
      }

      if (verbose) {
        return { output: `[Extracting from ${file}]`, exitCode: 0 };
      }

      return { output: '', exitCode: 0 };
    }

    if (list) {
      if (!file) {
        return { output: '', error: 'tar: You must specify the archive file', exitCode: 2 };
      }

      // Simulate listing archive contents
      return {
        output: 'file1.txt\nfile2.txt\ndir/\ndir/file3.txt',
        exitCode: 0,
      };
    }

    return { output: '', exitCode: 0 };
  },

  gzip: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'gzip: compressed data not written to a terminal', exitCode: 1 };
    }

    let decompress = false;
    let keep = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-d' || arg === '--decompress') decompress = true;
      else if (arg === '-k' || arg === '--keep') keep = true;
      else if (!arg.startsWith('-')) files.push(arg);
    }

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node) {
        return { output: '', error: `gzip: ${file}: No such file or directory`, exitCode: 1 };
      }

      if (decompress) {
        if (!file.endsWith('.gz')) {
          return { output: '', error: `gzip: ${file}: unknown suffix -- ignored`, exitCode: 1 };
        }
        const newFile = file.slice(0, -3);
        fs.createNode(fs.resolvePath(newFile, state.currentPath), 'file', state.currentUser, node.content || '');
        if (!keep) {
          fs.deleteNode(path);
        }
      } else {
        fs.createNode(fs.resolvePath(file + '.gz', state.currentPath), 'file', state.currentUser, `[GZIP: ${node.content}]`);
        if (!keep) {
          fs.deleteNode(path);
        }
      }
    }

    return { output: '', exitCode: 0 };
  },

  gunzip: (args, state, fs, pm) => {
    // gunzip is just gzip -d
    return archiveCommands.gzip(['-d', ...args], state, fs, pm);
  },

  zip: (args, state, fs, pm) => {
    if (!pm.isInstalled('zip')) {
      return {
        output: '',
        error: 'Command \'zip\' not found, but can be installed with:\n\nsudo apt install zip',
        exitCode: 127,
      };
    }

    if (args.length < 2) {
      return { output: '', error: 'zip error: Nothing to do!', exitCode: 12 };
    }

    const zipFile = args[0];
    const files = args.slice(1).filter(a => !a.startsWith('-'));

    const output: string[] = [];
    output.push(`  adding: ${files.join(', ')} (stored 0%)`);

    fs.createNode(fs.resolvePath(zipFile, state.currentPath), 'file', state.currentUser, `[ZIP ARCHIVE: ${files.join(', ')}]`);

    return { output: output.join('\n'), exitCode: 0 };
  },

  unzip: (args, state, fs, pm) => {
    if (!pm.isInstalled('unzip')) {
      return {
        output: '',
        error: 'Command \'unzip\' not found, but can be installed with:\n\nsudo apt install unzip',
        exitCode: 127,
      };
    }

    if (args.length === 0) {
      return { output: '', error: 'unzip: no zipfile specified', exitCode: 1 };
    }

    const zipFile = args.filter(a => !a.startsWith('-'))[0];
    const path = fs.resolvePath(zipFile, state.currentPath);
    const node = fs.getNode(path);

    if (!node) {
      return { output: '', error: `unzip: cannot find or open ${zipFile}`, exitCode: 9 };
    }

    return {
      output: `Archive:  ${zipFile}\n  extracting: file1.txt\n  extracting: file2.txt`,
      exitCode: 0,
    };
  },

  bzip2: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'bzip2: I won\'t write compressed data to a terminal.', exitCode: 1 };
    }

    let decompress = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-d' || arg === '--decompress') decompress = true;
      else if (!arg.startsWith('-')) files.push(arg);
    }

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node) {
        return { output: '', error: `bzip2: Can't open input file ${file}: No such file or directory.`, exitCode: 1 };
      }

      if (decompress) {
        const newFile = file.replace(/\.bz2$/, '');
        fs.createNode(fs.resolvePath(newFile, state.currentPath), 'file', state.currentUser, node.content || '');
        fs.deleteNode(path);
      } else {
        fs.createNode(fs.resolvePath(file + '.bz2', state.currentPath), 'file', state.currentUser, `[BZIP2: ${node.content}]`);
        fs.deleteNode(path);
      }
    }

    return { output: '', exitCode: 0 };
  },

  xz: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'xz: Compressed data cannot be written to a terminal', exitCode: 1 };
    }

    let decompress = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-d' || arg === '--decompress') decompress = true;
      else if (!arg.startsWith('-')) files.push(arg);
    }

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node) {
        return { output: '', error: `xz: ${file}: No such file or directory`, exitCode: 1 };
      }

      if (decompress) {
        const newFile = file.replace(/\.xz$/, '');
        fs.createNode(fs.resolvePath(newFile, state.currentPath), 'file', state.currentUser, node.content || '');
        fs.deleteNode(path);
      } else {
        fs.createNode(fs.resolvePath(file + '.xz', state.currentPath), 'file', state.currentUser, `[XZ: ${node.content}]`);
        fs.deleteNode(path);
      }
    }

    return { output: '', exitCode: 0 };
  },
};

import { CommandRegistry } from './index';

export const textCommands: CommandRegistry = {
  grep: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'Usage: grep [OPTION]... PATTERNS [FILE]...', exitCode: 2 };
    }

    let ignoreCase = false;
    let invertMatch = false;
    let lineNumbers = false;
    let countOnly = false;
    let recursive = false;
    let pattern = '';
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-i' || arg === '--ignore-case') ignoreCase = true;
      else if (arg === '-v' || arg === '--invert-match') invertMatch = true;
      else if (arg === '-n' || arg === '--line-number') lineNumbers = true;
      else if (arg === '-c' || arg === '--count') countOnly = true;
      else if (arg === '-r' || arg === '-R' || arg === '--recursive') recursive = true;
      else if (!pattern) pattern = arg;
      else files.push(arg);
    }

    if (!pattern) {
      return { output: '', error: 'grep: missing pattern', exitCode: 2 };
    }

    if (files.length === 0) {
      return { output: '', error: 'grep: missing file operand', exitCode: 2 };
    }

    const regex = new RegExp(pattern, ignoreCase ? 'i' : '');
    const results: string[] = [];
    let matchCount = 0;

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node) {
        results.push(`grep: ${file}: No such file or directory`);
        continue;
      }

      if (node.type === 'directory') {
        if (!recursive) {
          results.push(`grep: ${file}: Is a directory`);
        }
        continue;
      }

      const content = node.content || '';
      const lines = content.split('\n');

      lines.forEach((line, i) => {
        const matches = regex.test(line);
        const shouldInclude = invertMatch ? !matches : matches;

        if (shouldInclude) {
          matchCount++;
          if (!countOnly) {
            let output = line;
            if (lineNumbers) output = `${i + 1}:${output}`;
            if (files.length > 1) output = `${file}:${output}`;
            results.push(output);
          }
        }
      });
    }

    if (countOnly) {
      return { output: matchCount.toString(), exitCode: matchCount > 0 ? 0 : 1 };
    }

    return { output: results.join('\n'), exitCode: results.length > 0 ? 0 : 1 };
  },

  sed: (args, state, fs) => {
    if (args.length < 2) {
      return { output: '', error: 'Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...', exitCode: 1 };
    }

    let inPlace = false;
    let script = '';
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-i') {
        inPlace = true;
      } else if (args[i] === '-e' && args[i + 1]) {
        script = args[++i];
      } else if (!script && args[i].startsWith('s/')) {
        script = args[i];
      } else if (!args[i].startsWith('-')) {
        files.push(args[i]);
      }
    }

    if (!script) {
      return { output: '', error: 'sed: no script specified', exitCode: 1 };
    }

    // Parse s/pattern/replacement/flags
    const match = script.match(/^s\/(.+?)\/(.*)\/([gi]*)$/);
    if (!match) {
      return { output: '', error: 'sed: invalid script', exitCode: 1 };
    }

    const [, pattern, replacement, flags] = match;
    const regex = new RegExp(pattern, flags.includes('g') ? 'g' : '');

    const results: string[] = [];

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node || node.type !== 'file') {
        return { output: '', error: `sed: can't read ${file}: No such file or directory`, exitCode: 1 };
      }

      const content = node.content || '';
      const modified = content.split('\n').map(line => line.replace(regex, replacement)).join('\n');

      if (inPlace) {
        fs.updateFile(path, modified);
      } else {
        results.push(modified);
      }
    }

    return { output: results.join('\n'), exitCode: 0 };
  },

  awk: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'Usage: awk [POSIX or GNU style options] -f progfile [--] file ...', exitCode: 1 };
    }

    let program = '';
    let fieldSep = ' ';
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-F' && args[i + 1]) {
        fieldSep = args[++i];
      } else if (!program && !args[i].startsWith('-')) {
        program = args[i];
      } else if (!args[i].startsWith('-')) {
        files.push(args[i]);
      }
    }

    if (!program) {
      return { output: '', error: 'awk: missing program', exitCode: 1 };
    }

    const results: string[] = [];

    // Simple awk implementation - just handle print $N
    const printMatch = program.match(/\{print \$(\d+)\}/);
    const fieldNum = printMatch ? parseInt(printMatch[1]) : 0;

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node || node.type !== 'file') {
        continue;
      }

      const lines = (node.content || '').split('\n');
      for (const line of lines) {
        if (printMatch && fieldNum > 0) {
          const fields = line.split(new RegExp(fieldSep)).filter(f => f);
          results.push(fields[fieldNum - 1] || '');
        } else if (program === '{print}' || program === '{print $0}') {
          results.push(line);
        }
      }
    }

    return { output: results.join('\n'), exitCode: 0 };
  },

  cut: (args, state, fs) => {
    let delimiter = '\t';
    let fields = '';
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-d' && args[i + 1]) {
        delimiter = args[++i];
      } else if (args[i] === '-f' && args[i + 1]) {
        fields = args[++i];
      } else if (args[i].startsWith('-d')) {
        delimiter = args[i].substring(2);
      } else if (args[i].startsWith('-f')) {
        fields = args[i].substring(2);
      } else if (!args[i].startsWith('-')) {
        files.push(args[i]);
      }
    }

    if (!fields) {
      return { output: '', error: 'cut: you must specify a list of bytes, characters, or fields', exitCode: 1 };
    }

    const fieldNums = fields.split(',').map(f => parseInt(f) - 1);
    const results: string[] = [];

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node || node.type !== 'file') {
        return { output: '', error: `cut: ${file}: No such file or directory`, exitCode: 1 };
      }

      const lines = (node.content || '').split('\n');
      for (const line of lines) {
        const parts = line.split(delimiter);
        results.push(fieldNums.map(n => parts[n] || '').join(delimiter));
      }
    }

    return { output: results.join('\n'), exitCode: 0 };
  },

  sort: (args, state, fs) => {
    let reverse = false;
    let numeric = false;
    let unique = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-r' || arg === '--reverse') reverse = true;
      else if (arg === '-n' || arg === '--numeric-sort') numeric = true;
      else if (arg === '-u' || arg === '--unique') unique = true;
      else if (!arg.startsWith('-')) files.push(arg);
    }

    let lines: string[] = [];

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node || node.type !== 'file') {
        return { output: '', error: `sort: cannot read: ${file}: No such file or directory`, exitCode: 2 };
      }

      lines = lines.concat((node.content || '').split('\n').filter(l => l));
    }

    if (numeric) {
      lines.sort((a, b) => parseFloat(a) - parseFloat(b));
    } else {
      lines.sort();
    }

    if (reverse) lines.reverse();
    if (unique) lines = [...new Set(lines)];

    return { output: lines.join('\n'), exitCode: 0 };
  },

  uniq: (args, state, fs) => {
    let countOccurrences = false;
    let onlyDuplicates = false;
    let onlyUnique = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-c' || arg === '--count') countOccurrences = true;
      else if (arg === '-d' || arg === '--repeated') onlyDuplicates = true;
      else if (arg === '-u' || arg === '--unique') onlyUnique = true;
      else if (!arg.startsWith('-')) files.push(arg);
    }

    let lines: string[] = [];

    if (files.length > 0) {
      const path = fs.resolvePath(files[0], state.currentPath);
      const node = fs.getNode(path);
      if (node && node.type === 'file') {
        lines = (node.content || '').split('\n');
      }
    }

    const result: string[] = [];
    let prev = '';
    let count = 0;

    for (const line of lines) {
      if (line === prev) {
        count++;
      } else {
        if (prev !== '' || count > 0) {
          if ((!onlyDuplicates && !onlyUnique) ||
              (onlyDuplicates && count > 1) ||
              (onlyUnique && count === 1)) {
            result.push(countOccurrences ? `${count.toString().padStart(7)} ${prev}` : prev);
          }
        }
        prev = line;
        count = 1;
      }
    }

    // Don't forget the last line
    if (prev !== '') {
      if ((!onlyDuplicates && !onlyUnique) ||
          (onlyDuplicates && count > 1) ||
          (onlyUnique && count === 1)) {
        result.push(countOccurrences ? `${count.toString().padStart(7)} ${prev}` : prev);
      }
    }

    return { output: result.join('\n'), exitCode: 0 };
  },

  wc: (args, state, fs) => {
    let showLines = false;
    let showWords = false;
    let showChars = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-l' || arg === '--lines') showLines = true;
      else if (arg === '-w' || arg === '--words') showWords = true;
      else if (arg === '-c' || arg === '--bytes') showChars = true;
      else if (!arg.startsWith('-')) files.push(arg);
    }

    // If no specific option, show all
    if (!showLines && !showWords && !showChars) {
      showLines = showWords = showChars = true;
    }

    const results: string[] = [];
    let totalLines = 0, totalWords = 0, totalChars = 0;

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node) {
        return { output: '', error: `wc: ${file}: No such file or directory`, exitCode: 1 };
      }

      if (node.type === 'directory') {
        return { output: '', error: `wc: ${file}: Is a directory`, exitCode: 1 };
      }

      const content = node.content || '';
      const lines = content.split('\n').length - 1;
      const words = content.split(/\s+/).filter(w => w).length;
      const chars = content.length;

      totalLines += lines;
      totalWords += words;
      totalChars += chars;

      const parts: string[] = [];
      if (showLines) parts.push(lines.toString().padStart(7));
      if (showWords) parts.push(words.toString().padStart(7));
      if (showChars) parts.push(chars.toString().padStart(7));
      parts.push(file);

      results.push(parts.join(' '));
    }

    if (files.length > 1) {
      const parts: string[] = [];
      if (showLines) parts.push(totalLines.toString().padStart(7));
      if (showWords) parts.push(totalWords.toString().padStart(7));
      if (showChars) parts.push(totalChars.toString().padStart(7));
      parts.push('total');
      results.push(parts.join(' '));
    }

    return { output: results.join('\n'), exitCode: 0 };
  },

  head: (args, state, fs) => {
    let numLines = 10;
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n' && args[i + 1]) {
        numLines = parseInt(args[++i]) || 10;
      } else if (args[i].startsWith('-') && !isNaN(parseInt(args[i].substring(1)))) {
        numLines = parseInt(args[i].substring(1));
      } else if (!args[i].startsWith('-')) {
        files.push(args[i]);
      }
    }

    if (files.length === 0) {
      return { output: '', error: 'head: missing file operand', exitCode: 1 };
    }

    const results: string[] = [];

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node) {
        return { output: '', error: `head: cannot open '${file}' for reading: No such file or directory`, exitCode: 1 };
      }

      if (node.type === 'directory') {
        return { output: '', error: `head: error reading '${file}': Is a directory`, exitCode: 1 };
      }

      if (files.length > 1) {
        results.push(`==> ${file} <==`);
      }

      const lines = (node.content || '').split('\n').slice(0, numLines);
      results.push(lines.join('\n'));
    }

    return { output: results.join('\n'), exitCode: 0 };
  },

  tail: (args, state, fs) => {
    let numLines = 10;
    let follow = false;
    const files: string[] = [];

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n' && args[i + 1]) {
        numLines = parseInt(args[++i]) || 10;
      } else if (args[i] === '-f' || args[i] === '--follow') {
        follow = true;
      } else if (args[i].startsWith('-') && !isNaN(parseInt(args[i].substring(1)))) {
        numLines = parseInt(args[i].substring(1));
      } else if (!args[i].startsWith('-')) {
        files.push(args[i]);
      }
    }

    if (files.length === 0) {
      return { output: '', error: 'tail: missing file operand', exitCode: 1 };
    }

    const results: string[] = [];

    for (const file of files) {
      const path = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(path);

      if (!node) {
        return { output: '', error: `tail: cannot open '${file}' for reading: No such file or directory`, exitCode: 1 };
      }

      if (node.type === 'directory') {
        return { output: '', error: `tail: error reading '${file}': Is a directory`, exitCode: 1 };
      }

      if (files.length > 1) {
        results.push(`==> ${file} <==`);
      }

      const allLines = (node.content || '').split('\n');
      const lines = allLines.slice(-numLines);
      results.push(lines.join('\n'));
    }

    return { output: results.join('\n'), exitCode: 0 };
  },

  diff: (args, state, fs) => {
    const files = args.filter(a => !a.startsWith('-'));

    if (files.length < 2) {
      return { output: '', error: 'diff: missing operand', exitCode: 2 };
    }

    const path1 = fs.resolvePath(files[0], state.currentPath);
    const path2 = fs.resolvePath(files[1], state.currentPath);

    const node1 = fs.getNode(path1);
    const node2 = fs.getNode(path2);

    if (!node1) {
      return { output: '', error: `diff: ${files[0]}: No such file or directory`, exitCode: 2 };
    }
    if (!node2) {
      return { output: '', error: `diff: ${files[1]}: No such file or directory`, exitCode: 2 };
    }

    const content1 = node1.content || '';
    const content2 = node2.content || '';

    if (content1 === content2) {
      return { output: '', exitCode: 0 };
    }

    // Simple diff output
    const lines1 = content1.split('\n');
    const lines2 = content2.split('\n');

    const output: string[] = [];
    output.push(`--- ${files[0]}`);
    output.push(`+++ ${files[1]}`);
    output.push('@@ -1,' + lines1.length + ' +1,' + lines2.length + ' @@');

    lines1.forEach(line => output.push('-' + line));
    lines2.forEach(line => output.push('+' + line));

    return { output: output.join('\n'), exitCode: 1 };
  },

  tr: (args) => {
    // Basic tr implementation
    if (args.length < 2) {
      return { output: '', error: 'tr: missing operand', exitCode: 1 };
    }

    let deleteMode = false;
    let set1 = '';
    let set2 = '';

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-d') {
        deleteMode = true;
      } else if (!set1) {
        set1 = args[i];
      } else if (!set2) {
        set2 = args[i];
      }
    }

    return { output: `[tr would transform: ${set1} -> ${set2}]`, exitCode: 0 };
  },

  tee: (args, state, fs) => {
    let append = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-a' || arg === '--append') {
        append = true;
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
    }

    // tee normally reads from stdin, we'll simulate it
    return { output: '[tee: reading from stdin]', exitCode: 0 };
  },

  xargs: (args) => {
    if (args.length === 0) {
      return { output: '[xargs: reading from stdin]', exitCode: 0 };
    }
    return { output: `[xargs would execute: ${args.join(' ')}]`, exitCode: 0 };
  },

  less: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'Missing filename ("less --help" for help)', exitCode: 1 };
    }

    const file = args.filter(a => !a.startsWith('-'))[0];
    const path = fs.resolvePath(file, state.currentPath);
    const node = fs.getNode(path);

    if (!node) {
      return { output: '', error: `${file}: No such file or directory`, exitCode: 1 };
    }

    if (node.type === 'directory') {
      return { output: '', error: `${file}: Is a directory`, exitCode: 1 };
    }

    return { output: node.content || '', exitCode: 0 };
  },

  more: (args, state, fs, pm) => {
    return textCommands.less(args, state, fs, pm);
  },

  find: (args, state, fs) => {
    let startPath = state.currentPath;
    let namePattern = '';
    let typeFilter = '';

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-name' && args[i + 1]) {
        namePattern = args[++i];
      } else if (args[i] === '-type' && args[i + 1]) {
        typeFilter = args[++i];
      } else if (!args[i].startsWith('-')) {
        startPath = fs.resolvePath(args[i], state.currentPath);
      }
    }

    const results: string[] = [];

    function search(path: string, node: any) {
      const matches = !namePattern || 
        (namePattern.includes('*') 
          ? new RegExp('^' + namePattern.replace(/\*/g, '.*') + '$').test(node.name)
          : node.name === namePattern);

      const typeMatches = !typeFilter ||
        (typeFilter === 'f' && node.type === 'file') ||
        (typeFilter === 'd' && node.type === 'directory');

      if (matches && typeMatches) {
        results.push(path);
      }

      if (node.type === 'directory' && node.children) {
        node.children.forEach((child: any, name: string) => {
          search(path + '/' + name, child);
        });
      }
    }

    const startNode = fs.getNode(startPath);
    if (!startNode) {
      return { output: '', error: `find: '${startPath}': No such file or directory`, exitCode: 1 };
    }

    search(startPath, startNode);

    return { output: results.join('\n'), exitCode: 0 };
  },

  locate: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'locate: no pattern to search for specified', exitCode: 1 };
    }

    // Simulate locate output
    const pattern = args[0];
    const results = [
      `/usr/bin/${pattern}`,
      `/usr/share/doc/${pattern}`,
      `/usr/share/man/man1/${pattern}.1.gz`,
    ];

    return { output: results.join('\n'), exitCode: 0 };
  },
};

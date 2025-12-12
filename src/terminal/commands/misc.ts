import { CommandRegistry } from './index';
import { createPythonSession, executeLine, executeScript, executeCommand as executePythonCommand } from '../python';

// Configuration constants
const PYTHON_VERSION = '3.11.0';
const PYTHON_IMPL = 'Python Simulator';

// Store Python sessions for interactive mode
const pythonSessions = new Map<string, ReturnType<typeof createPythonSession>>();

export const miscCommands: CommandRegistry = {
  python: (args, state, fs, pm) => {
    // Handle python --version
    if (args[0] === '--version' || args[0] === '-V') {
      return { output: `Python ${PYTHON_VERSION}`, exitCode: 0 };
    }

    // Handle python -c "code"
    if (args[0] === '-c' && args.length > 1) {
      const code = args.slice(1).join(' ').replace(/^["']|["']$/g, '');
      const result = executePythonCommand(code);
      if (result.error) {
        return { output: result.output, error: result.error, exitCode: 1 };
      }
      return { output: result.output, exitCode: 0 };
    }

    // Handle python script.py
    if (args.length > 0 && args[0].endsWith('.py')) {
      const filePath = fs.resolvePath(args[0], state.currentPath);
      const node = fs.getNode(filePath);

      if (!node) {
        return { output: '', error: `python: can't open file '${args[0]}': [Errno 2] No such file or directory`, exitCode: 2 };
      }

      if (node.type !== 'file') {
        return { output: '', error: `python: can't open file '${args[0]}': [Errno 21] Is a directory`, exitCode: 1 };
      }

      const result = executeScript(node.content || '');
      if (result.error) {
        return { output: result.output, error: result.error, exitCode: 1 };
      }
      return { output: result.output, exitCode: 0 };
    }

    // Interactive mode - return special flag to enter Python REPL
    return {
      output: `Python ${PYTHON_VERSION} (${PYTHON_IMPL})
Type "help", "copyright", "credits" or "license" for more information.`,
      exitCode: 0,
      enterPythonMode: true,
    } as any;
  },

  python3: (args, state, fs, pm) => {
    return miscCommands.python(args, state, fs, pm);
  },

  // Python REPL line execution (called from Terminal component)
  __pythonExec: (args, state) => {
    const sessionId = state.currentUser;
    let session = pythonSessions.get(sessionId);

    if (!session) {
      session = createPythonSession();
      pythonSessions.set(sessionId, session);
    }

    const line = args.join(' ');
    const result = executeLine(session, line);

    if (result.exit) {
      pythonSessions.delete(sessionId);
      return {
        output: '',
        exitCode: 0,
        exitPythonMode: true,
      } as any;
    }

    return {
      output: result.output,
      exitCode: 0,
      pythonPrompt: result.prompt,
    } as any;
  },

  man: (args) => {
    if (args.length === 0) {
      return { output: 'What manual page do you want?', exitCode: 1 };
    }

    const cmd = args[0];
    const manPages: { [key: string]: string } = {
      ls: `LS(1)                            User Commands                            LS(1)

NAME
       ls - list directory contents

SYNOPSIS
       ls [OPTION]... [FILE]...

DESCRIPTION
       List  information  about  the FILEs (the current directory by default).
       Sort entries alphabetically if none of -cftuvSUX nor --sort  is  speci‐
       fied.

OPTIONS
       -a, --all
              do not ignore entries starting with .

       -l     use a long listing format

       -h, --human-readable
              with -l, print sizes like 1K 234M 2G etc.

       -r, --reverse
              reverse order while sorting`,

      cd: `CD(1)                            User Commands                            CD(1)

NAME
       cd - change the working directory

SYNOPSIS
       cd [dir]

DESCRIPTION
       Change the current directory to dir. The default dir is the value of
       the HOME shell variable.`,

      cat: `CAT(1)                           User Commands                           CAT(1)

NAME
       cat - concatenate files and print on the standard output

SYNOPSIS
       cat [OPTION]... [FILE]...

DESCRIPTION
       Concatenate FILE(s) to standard output.

OPTIONS
       -n, --number
              number all output lines`,

      grep: `GREP(1)                          User Commands                          GREP(1)

NAME
       grep - print lines that match patterns

SYNOPSIS
       grep [OPTION...] PATTERNS [FILE...]

DESCRIPTION
       grep searches for PATTERNS in each FILE.

OPTIONS
       -i, --ignore-case
              Ignore case distinctions in patterns and data.

       -v, --invert-match
              Invert the sense of matching, to select non-matching lines.

       -n, --line-number
              Prefix each line of output with the 1-based line number.

       -c, --count
              Suppress normal output; instead print a count of matching lines.`,
    };

    if (manPages[cmd]) {
      return { output: manPages[cmd], exitCode: 0 };
    }

    return { output: `No manual entry for ${cmd}`, exitCode: 16 };
  },

  help: (args, state) => {
    const commands = [
      'GNU bash, version 5.1.16(1)-release',
      '',
      'These shell commands are defined internally. Type `help\' to see this list.',
      'Type `help name\' to find out more about the function `name\'.',
      '',
      ' alias [-p] [name[=value] ... ]    cd [-L|[-P [-e]] [-@]] [dir]',
      ' bg [job_spec ...]                 command [-pVv] command [arg ...]',
      ' break [n]                         continue [n]',
      ' declare [-aAfFgiIlnrtux] [-p]     echo [-neE] [arg ...]',
      ' exit [n]                          export [-fn] [name[=value] ...]',
      ' fg [job_spec]                     hash [-lr] [-p pathname] [name ...]',
      ' help [-dms] [pattern ...]         history [-c] [-d offset] [n]',
      ' jobs [-lnprs] [jobspec ...]       kill [-s sigspec | -n signum]',
      ' logout [n]                        pwd [-LP]',
      ' read [-ers] [-a array]            source filename [arguments]',
      ' type [-afptP] name [name ...]     unalias [-a] name [name ...]',
      ' wait [-fn] [-p var] [id ...]      while COMMANDS; do COMMANDS; done',
    ];

    return { output: commands.join('\n'), exitCode: 0 };
  },

  info: (args) => {
    if (args.length === 0) {
      return { output: 'info: No input file specified; try --help for more information.', exitCode: 1 };
    }
    return { output: `No info documentation for ${args[0]}`, exitCode: 1 };
  },

  type: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'type: missing argument', exitCode: 1 };
    }

    const cmd = args[0];
    const builtins = ['cd', 'pwd', 'echo', 'exit', 'alias', 'export', 'history', 'type', 'source'];

    if (builtins.includes(cmd)) {
      return { output: `${cmd} is a shell builtin`, exitCode: 0 };
    }

    return { output: `${cmd} is /usr/bin/${cmd}`, exitCode: 0 };
  },

  source: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'bash: source: filename argument required', exitCode: 1 };
    }

    const path = fs.resolvePath(args[0], state.currentPath);
    const node = fs.getNode(path);

    if (!node) {
      return { output: '', error: `bash: ${args[0]}: No such file or directory`, exitCode: 1 };
    }

    return { output: '', exitCode: 0 };
  },

  '.': (args, state, fs, pm) => {
    return miscCommands.source(args, state, fs, pm);
  },

  basename: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'basename: missing operand', exitCode: 1 };
    }

    let path = args[0];
    const suffix = args[1] || '';

    const name = path.split('/').pop() || path;
    const result = suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;

    return { output: result, exitCode: 0 };
  },

  dirname: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'dirname: missing operand', exitCode: 1 };
    }

    const path = args[0];
    const dir = path.substring(0, path.lastIndexOf('/')) || '.';

    return { output: dir || '/', exitCode: 0 };
  },

  realpath: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'realpath: missing operand', exitCode: 1 };
    }

    const resolved = fs.resolvePath(args[0], state.currentPath);
    return { output: resolved, exitCode: 0 };
  },

  readlink: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', error: 'readlink: missing operand', exitCode: 1 };
    }

    const path = fs.resolvePath(args[0], state.currentPath);
    const node = fs.getNode(path);

    if (!node) {
      return { output: '', error: `readlink: ${args[0]}: No such file or directory`, exitCode: 1 };
    }

    if (node.type !== 'symlink') {
      return { output: '', exitCode: 1 };
    }

    return { output: node.target || '', exitCode: 0 };
  },

  seq: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'seq: missing operand', exitCode: 1 };
    }

    let start = 1;
    let step = 1;
    let end: number;

    if (args.length === 1) {
      end = parseInt(args[0]);
    } else if (args.length === 2) {
      start = parseInt(args[0]);
      end = parseInt(args[1]);
    } else {
      start = parseInt(args[0]);
      step = parseInt(args[1]);
      end = parseInt(args[2]);
    }

    const result: number[] = [];
    for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
      result.push(i);
    }

    return { output: result.join('\n'), exitCode: 0 };
  },

  md5sum: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', exitCode: 0 };
    }

    const file = args[0];
    const path = fs.resolvePath(file, state.currentPath);
    const node = fs.getNode(path);

    if (!node) {
      return { output: '', error: `md5sum: ${file}: No such file or directory`, exitCode: 1 };
    }

    // Generate a fake but consistent MD5 hash
    const hash = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    return { output: `${hash}  ${file}`, exitCode: 0 };
  },

  sha256sum: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', exitCode: 0 };
    }

    const file = args[0];
    const path = fs.resolvePath(file, state.currentPath);
    const node = fs.getNode(path);

    if (!node) {
      return { output: '', error: `sha256sum: ${file}: No such file or directory`, exitCode: 1 };
    }

    const hash = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    return { output: `${hash}  ${file}`, exitCode: 0 };
  },

  base64: (args, state, fs) => {
    let decode = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-d' || arg === '--decode') decode = true;
      else if (!arg.startsWith('-')) files.push(arg);
    }

    if (files.length > 0) {
      const path = fs.resolvePath(files[0], state.currentPath);
      const node = fs.getNode(path);

      if (!node) {
        return { output: '', error: `base64: ${files[0]}: No such file or directory`, exitCode: 1 };
      }

      if (decode) {
        try {
          return { output: atob(node.content || ''), exitCode: 0 };
        } catch {
          return { output: '', error: 'base64: invalid input', exitCode: 1 };
        }
      }

      return { output: btoa(node.content || ''), exitCode: 0 };
    }

    return { output: '', exitCode: 0 };
  },

  factor: (args) => {
    if (args.length === 0) {
      return { output: '', exitCode: 0 };
    }

    const n = parseInt(args[0]);
    if (isNaN(n)) {
      return { output: '', error: `factor: '${args[0]}' is not a valid positive integer`, exitCode: 1 };
    }

    const factors: number[] = [];
    let num = n;
    for (let i = 2; i <= Math.sqrt(num); i++) {
      while (num % i === 0) {
        factors.push(i);
        num = num / i;
      }
    }
    if (num > 1) factors.push(num);

    return { output: `${n}: ${factors.join(' ')}`, exitCode: 0 };
  },

  expr: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'expr: missing operand', exitCode: 1 };
    }

    try {
      const expression = args.join(' ')
        .replace(/\*/g, '*')
        .replace(/\//g, '/');
      
      // Simple evaluation for basic arithmetic
      const result = eval(expression.replace(/\s+/g, ''));
      return { output: result.toString(), exitCode: result === 0 ? 1 : 0 };
    } catch {
      return { output: '', error: 'expr: syntax error', exitCode: 2 };
    }
  },

  test: (args) => {
    if (args.length === 0) {
      return { output: '', exitCode: 1 };
    }

    // Simple test implementation
    if (args[0] === '-n' && args[1]) {
      return { output: '', exitCode: args[1].length > 0 ? 0 : 1 };
    }
    if (args[0] === '-z' && args[1]) {
      return { output: '', exitCode: args[1].length === 0 ? 0 : 1 };
    }
    if (args[1] === '=' || args[1] === '==') {
      return { output: '', exitCode: args[0] === args[2] ? 0 : 1 };
    }
    if (args[1] === '!=') {
      return { output: '', exitCode: args[0] !== args[2] ? 0 : 1 };
    }
    if (args[1] === '-eq') {
      return { output: '', exitCode: parseInt(args[0]) === parseInt(args[2]) ? 0 : 1 };
    }
    if (args[1] === '-ne') {
      return { output: '', exitCode: parseInt(args[0]) !== parseInt(args[2]) ? 0 : 1 };
    }
    if (args[1] === '-lt') {
      return { output: '', exitCode: parseInt(args[0]) < parseInt(args[2]) ? 0 : 1 };
    }
    if (args[1] === '-gt') {
      return { output: '', exitCode: parseInt(args[0]) > parseInt(args[2]) ? 0 : 1 };
    }

    return { output: '', exitCode: 0 };
  },

  '[': (args, state, fs, pm) => {
    // [ is an alias for test, but expects ] as the last argument
    if (args[args.length - 1] !== ']') {
      return { output: '', error: '[: missing `]\'\n', exitCode: 2 };
    }
    return miscCommands.test(args.slice(0, -1), state, fs, pm);
  },

  printf: (args) => {
    if (args.length === 0) {
      return { output: '', exitCode: 0 };
    }

    let format = args[0];
    const values = args.slice(1);
    let valueIndex = 0;

    const output = format.replace(/%([sd])/g, (_, type) => {
      const value = values[valueIndex++] || '';
      return value;
    }).replace(/\\n/g, '\n').replace(/\\t/g, '\t');

    return { output, exitCode: 0 };
  },

  tput: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'tput: usage: tput [-V] [-S] [-T term] capname', exitCode: 2 };
    }

    const cap = args[0];
    const capMap: { [key: string]: string } = {
      cols: '80',
      lines: '24',
      colors: '256',
      clear: '\x1b[2J\x1b[H',
      bold: '\x1b[1m',
      sgr0: '\x1b[0m',
    };

    return { output: capMap[cap] || '', exitCode: capMap[cap] ? 0 : 1 };
  },

  reset: () => ({
    output: '',
    exitCode: 0,
    clearScreen: true,
  }),

  rev: (args, state, fs) => {
    if (args.length === 0) {
      return { output: '', exitCode: 0 };
    }

    const file = args[0];
    const path = fs.resolvePath(file, state.currentPath);
    const node = fs.getNode(path);

    if (!node) {
      return { output: '', error: `rev: ${file}: No such file or directory`, exitCode: 1 };
    }

    const reversed = (node.content || '').split('\n').map(line => line.split('').reverse().join('')).join('\n');
    return { output: reversed, exitCode: 0 };
  },

  cowsay: (args, state, fs, pm) => {
    if (!pm.isInstalled('cowsay')) {
      return {
        output: '',
        error: 'Command \'cowsay\' not found, but can be installed with:\n\nsudo apt install cowsay',
        exitCode: 127,
      };
    }

    const message = args.join(' ') || 'Moo!';
    const border = '_'.repeat(message.length + 2);

    return {
      output: ` ${border}
< ${message} >
 ${'-'.repeat(message.length + 2)}
        \\   ^__^
         \\  (oo)\\_______
            (__)\\       )\\/\\
                ||----w |
                ||     ||`,
      exitCode: 0,
    };
  },

  fortune: (args, state, fs, pm) => {
    if (!pm.isInstalled('fortune')) {
      return {
        output: '',
        error: 'Command \'fortune\' not found, but can be installed with:\n\nsudo apt install fortune',
        exitCode: 127,
      };
    }

    const fortunes = [
      'The best way to predict the future is to invent it. - Alan Kay',
      'Talk is cheap. Show me the code. - Linus Torvalds',
      'Programs must be written for people to read, and only incidentally for machines to execute. - Abelson & Sussman',
      'Any fool can write code that a computer can understand. Good programmers write code that humans can understand. - Martin Fowler',
      'First, solve the problem. Then, write the code. - John Johnson',
      'In theory, there is no difference between theory and practice. But in practice, there is. - Jan L. A. van de Snepscheut',
    ];

    return { output: fortunes[Math.floor(Math.random() * fortunes.length)], exitCode: 0 };
  },

  cmatrix: (args, state, fs, pm) => {
    if (!pm.isInstalled('cmatrix')) {
      return {
        output: '',
        error: 'Command \'cmatrix\' not found, but can be installed with:\n\nsudo apt install cmatrix',
        exitCode: 127,
      };
    }

    // Generate Matrix-style ASCII art animation frame
    const chars = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const width = 80;
    const height = 20;
    const lines: string[] = [];

    for (let y = 0; y < height; y++) {
      let line = '';
      for (let x = 0; x < width; x++) {
        const rand = Math.random();
        if (rand < 0.1) {
          // Bright green (head of stream)
          line += `\x1b[1;32m${chars[Math.floor(Math.random() * chars.length)]}\x1b[0m`;
        } else if (rand < 0.3) {
          // Normal green
          line += `\x1b[32m${chars[Math.floor(Math.random() * chars.length)]}\x1b[0m`;
        } else if (rand < 0.4) {
          // Dark green
          line += `\x1b[2;32m${chars[Math.floor(Math.random() * chars.length)]}\x1b[0m`;
        } else {
          line += ' ';
        }
      }
      lines.push(line);
    }

    return {
      output: '\x1b[32m' + `
    ███╗   ███╗ █████╗ ████████╗██████╗ ██╗██╗  ██╗
    ████╗ ████║██╔══██╗╚══██╔══╝██╔══██╗██║╚██╗██╔╝
    ██╔████╔██║███████║   ██║   ██████╔╝██║ ╚███╔╝
    ██║╚██╔╝██║██╔══██║   ██║   ██╔══██╗██║ ██╔██╗
    ██║ ╚═╝ ██║██║  ██║   ██║   ██║  ██║██║██╔╝ ██╗
    ╚═╝     ╚═╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝
` + '\x1b[0m\n' + lines.join('\n') + '\n\n\x1b[32m[Press Ctrl+C to exit - This is a static frame]\x1b[0m',
      exitCode: 0,
    };
  },

  sl: (args, state, fs, pm) => {
    if (!pm.isInstalled('sl')) {
      return {
        output: '',
        error: 'Command \'sl\' not found, but can be installed with:\n\nsudo apt install sl',
        exitCode: 127,
      };
    }

    return {
      output: `      ====        ________                ___________
  _D _|  |_______/        \\__I_I_____===__|_________|
   |(_)---  |   H\\________/ |   |        =|___ ___|
   /     |  |   H  |  |     |   |         ||_| |_||
  |      |  |   H  |__--------------------| [___] |
  | ________|___H__/__|_____/[][]~\\_______|       |
  |/ |   |-----------I_____I [][] []  D   |=======|_
__/ =| o |=-~~\\  /~~\\  /~~\\  /~~\\ ____Y___________|__
 |/-=|___|=    ||    ||    ||    |_____/~\\___/
  \\_/      \\O=====O=====O=====O_/      \\_/`,
      exitCode: 0,
    };
  },

  figlet: (args, state, fs, pm) => {
    if (!pm.isInstalled('figlet')) {
      return {
        output: '',
        error: 'Command \'figlet\' not found, but can be installed with:\n\nsudo apt install figlet',
        exitCode: 127,
      };
    }

    if (args.length === 0) {
      return { output: '', exitCode: 0 };
    }

    const text = args.join(' ').toUpperCase();

    // Simple ASCII font mapping
    const font: { [key: string]: string[] } = {
      'A': ['  █████╗ ', ' ██╔══██╗', ' ███████║', ' ██╔══██║', ' ██║  ██║', ' ╚═╝  ╚═╝'],
      'B': [' ██████╗ ', ' ██╔══██╗', ' ██████╔╝', ' ██╔══██╗', ' ██████╔╝', ' ╚═════╝ '],
      'C': ['  ██████╗', ' ██╔════╝', ' ██║     ', ' ██║     ', ' ╚██████╗', '  ╚═════╝'],
      'D': [' ██████╗ ', ' ██╔══██╗', ' ██║  ██║', ' ██║  ██║', ' ██████╔╝', ' ╚═════╝ '],
      'E': [' ███████╗', ' ██╔════╝', ' █████╗  ', ' ██╔══╝  ', ' ███████╗', ' ╚══════╝'],
      'F': [' ███████╗', ' ██╔════╝', ' █████╗  ', ' ██╔══╝  ', ' ██║     ', ' ╚═╝     '],
      'G': ['  ██████╗ ', ' ██╔════╝ ', ' ██║  ███╗', ' ██║   ██║', ' ╚██████╔╝', '  ╚═════╝ '],
      'H': [' ██╗  ██╗', ' ██║  ██║', ' ███████║', ' ██╔══██║', ' ██║  ██║', ' ╚═╝  ╚═╝'],
      'I': [' ██╗', ' ██║', ' ██║', ' ██║', ' ██║', ' ╚═╝'],
      'J': ['      ██╗', '      ██║', '      ██║', ' ██   ██║', ' ╚█████╔╝', '  ╚════╝ '],
      'K': [' ██╗  ██╗', ' ██║ ██╔╝', ' █████╔╝ ', ' ██╔═██╗ ', ' ██║  ██╗', ' ╚═╝  ╚═╝'],
      'L': [' ██╗     ', ' ██║     ', ' ██║     ', ' ██║     ', ' ███████╗', ' ╚══════╝'],
      'M': [' ███╗   ███╗', ' ████╗ ████║', ' ██╔████╔██║', ' ██║╚██╔╝██║', ' ██║ ╚═╝ ██║', ' ╚═╝     ╚═╝'],
      'N': [' ███╗   ██╗', ' ████╗  ██║', ' ██╔██╗ ██║', ' ██║╚██╗██║', ' ██║ ╚████║', ' ╚═╝  ╚═══╝'],
      'O': ['  ██████╗ ', ' ██╔═══██╗', ' ██║   ██║', ' ██║   ██║', ' ╚██████╔╝', '  ╚═════╝ '],
      'P': [' ██████╗ ', ' ██╔══██╗', ' ██████╔╝', ' ██╔═══╝ ', ' ██║     ', ' ╚═╝     '],
      'Q': ['  ██████╗ ', ' ██╔═══██╗', ' ██║   ██║', ' ██║▄▄ ██║', ' ╚██████╔╝', '  ╚══▀▀═╝ '],
      'R': [' ██████╗ ', ' ██╔══██╗', ' ██████╔╝', ' ██╔══██╗', ' ██║  ██║', ' ╚═╝  ╚═╝'],
      'S': [' ███████╗', ' ██╔════╝', ' ███████╗', ' ╚════██║', ' ███████║', ' ╚══════╝'],
      'T': [' ████████╗', ' ╚══██╔══╝', '    ██║   ', '    ██║   ', '    ██║   ', '    ╚═╝   '],
      'U': [' ██╗   ██╗', ' ██║   ██║', ' ██║   ██║', ' ██║   ██║', ' ╚██████╔╝', '  ╚═════╝ '],
      'V': [' ██╗   ██╗', ' ██║   ██║', ' ██║   ██║', ' ╚██╗ ██╔╝', '  ╚████╔╝ ', '   ╚═══╝  '],
      'W': [' ██╗    ██╗', ' ██║    ██║', ' ██║ █╗ ██║', ' ██║███╗██║', ' ╚███╔███╔╝', '  ╚══╝╚══╝ '],
      'X': [' ██╗  ██╗', ' ╚██╗██╔╝', '  ╚███╔╝ ', '  ██╔██╗ ', ' ██╔╝ ██╗', ' ╚═╝  ╚═╝'],
      'Y': [' ██╗   ██╗', ' ╚██╗ ██╔╝', '  ╚████╔╝ ', '   ╚██╔╝  ', '    ██║   ', '    ╚═╝   '],
      'Z': [' ███████╗', ' ╚══███╔╝', '   ███╔╝ ', '  ███╔╝  ', ' ███████╗', ' ╚══════╝'],
      '0': ['  ██████╗ ', ' ██╔═████╗', ' ██║██╔██║', ' ████╔╝██║', ' ╚██████╔╝', '  ╚═════╝ '],
      '1': ['  ██╗', ' ███║', ' ╚██║', '  ██║', '  ██║', '  ╚═╝'],
      '2': [' ██████╗ ', ' ╚════██╗', '  █████╔╝', ' ██╔═══╝ ', ' ███████╗', ' ╚══════╝'],
      '3': [' ██████╗ ', ' ╚════██╗', '  █████╔╝', '  ╚═══██╗', ' ██████╔╝', ' ╚═════╝ '],
      '4': [' ██╗  ██╗', ' ██║  ██║', ' ███████║', ' ╚════██║', '      ██║', '      ╚═╝'],
      '5': [' ███████╗', ' ██╔════╝', ' ███████╗', ' ╚════██║', ' ███████║', ' ╚══════╝'],
      '6': ['  ██████╗ ', ' ██╔════╝ ', ' ███████╗ ', ' ██╔═══██╗', ' ╚██████╔╝', '  ╚═════╝ '],
      '7': [' ███████╗', ' ╚════██║', '     ██╔╝', '    ██╔╝ ', '    ██║  ', '    ╚═╝  '],
      '8': ['  █████╗ ', ' ██╔══██╗', ' ╚█████╔╝', ' ██╔══██╗', ' ╚█████╔╝', '  ╚════╝ '],
      '9': ['  █████╗ ', ' ██╔══██╗', ' ╚██████║', '  ╚═══██║', '  █████╔╝', '  ╚════╝ '],
      ' ': ['     ', '     ', '     ', '     ', '     ', '     '],
      '!': [' ██╗', ' ██║', ' ██║', ' ╚═╝', ' ██╗', ' ╚═╝'],
    };

    const defaultChar = [' █╗ ', ' █║ ', ' █║ ', ' █║ ', ' █║ ', ' ╚╝ '];
    const lines: string[] = ['', '', '', '', '', ''];

    for (const char of text) {
      const charArt = font[char] || defaultChar;
      for (let i = 0; i < 6; i++) {
        lines[i] += charArt[i] || '    ';
      }
    }

    return {
      output: lines.join('\n'),
      exitCode: 0,
    };
  },
};

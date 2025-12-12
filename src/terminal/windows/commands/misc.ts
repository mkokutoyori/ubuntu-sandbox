/**
 * Windows CMD Miscellaneous Commands
 * cls, help, color, find, findstr, sort, more, pause, etc.
 */

import { WindowsCommandResult, WindowsTerminalState } from '../types';
import { WindowsFileSystem } from '../filesystem';
import { CmdCommandRegistry } from './index';

export const miscCommands: CmdCommandRegistry = {
  // CLS - Clear Screen
  cls: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    return { output: '', exitCode: 0, clearScreen: true };
  },

  // HELP - Display Help
  help: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length > 0) {
      const cmd = args[0].toLowerCase();
      const helpTexts: Record<string, string> = {
        cd: 'Displays the name of or changes the current directory.\r\n\r\nCD [/D] [drive:][path]\r\nCD [..]\r\n\r\n  ..   Specifies that you want to change to the parent directory.\r\n\r\nType CD drive: to display the current directory in the specified drive.\r\nType CD without parameters to display the current drive and directory.',
        dir: 'Displays a list of files and subdirectories in a directory.\r\n\r\nDIR [drive:][path][filename] [/A[[:]attributes]] [/B] [/C] [/D] [/L] [/N]\r\n  [/O[[:]sortorder]] [/P] [/Q] [/R] [/S] [/T[[:]timefield]] [/W] [/X] [/4]\r\n\r\n  /A   Displays files with specified attributes.\r\n  /B   Uses bare format (no heading information or summary).\r\n  /S   Displays files in specified directory and all subdirectories.\r\n  /W   Uses wide list format.',
        copy: 'Copies one or more files to another location.\r\n\r\nCOPY [/D] [/V] [/N] [/Y | /-Y] [/Z] [/L] [/A | /B ] source [/A | /B]\r\n     [+ source [/A | /B] [+ ...]] [destination [/A | /B]]\r\n\r\n  source       Specifies the file or files to be copied.\r\n  /Y           Suppresses prompting to confirm you want to overwrite.\r\n  destination  Specifies the directory and/or filename for the new file(s).',
        del: 'Deletes one or more files.\r\n\r\nDEL [/P] [/F] [/S] [/Q] [/A[[:]attributes]] names\r\n\r\n  names        Specifies a list of one or more files or directories.\r\n  /P           Prompts for confirmation before deleting each file.\r\n  /F           Force deleting of read-only files.\r\n  /S           Delete specified files from all subdirectories.\r\n  /Q           Quiet mode, do not ask if ok to delete on global wildcard.',
        move: 'Moves files and renames files and directories.\r\n\r\nTo move one or more files:\r\nMOVE [/Y | /-Y] [drive:][path]filename1[,...] destination\r\n\r\nTo rename a directory:\r\nMOVE [/Y | /-Y] [drive:][path]dirname1 dirname2\r\n\r\n  /Y           Suppresses prompting to confirm.',
        type: 'Displays the contents of a text file or files.\r\n\r\nTYPE [drive:][path]filename',
        exit: 'Quits the CMD.EXE program (command interpreter) or the current batch script.\r\n\r\nEXIT [/B] [exitCode]\r\n\r\n  /B          specifies to exit the current batch script instead of CMD.EXE.\r\n  exitCode    specifies a numeric number.',
      };

      if (helpTexts[cmd]) {
        return { output: helpTexts[cmd], exitCode: 0 };
      }

      return { output: '', error: `This command is not supported by the help utility.  Try "${cmd} /?".\r\n`, exitCode: 1 };
    }

    return {
      output: `For more information on a specific command, type HELP command-name\r\n
ASSOC          Displays or modifies file extension associations.
ATTRIB         Displays or changes file attributes.
CD             Displays the name of or changes the current directory.
CLS            Clears the screen.
COPY           Copies one or more files to another location.
DATE           Displays or sets the date.
DEL            Deletes one or more files.
DIR            Displays a list of files and subdirectories in a directory.
ECHO           Displays messages, or turns command echoing on or off.
EXIT           Quits the CMD.EXE program (command interpreter).
FC             Compares two files or sets of files.
FIND           Searches for a text string in a file or files.
FINDSTR        Searches for strings in files.
HELP           Provides Help information for Windows commands.
HOSTNAME       Prints the name of the current host.
IPCONFIG       Display IP network configuration values.
MD             Creates a directory.
MOVE           Moves one or more files from one directory to another directory.
NETSTAT        Displays protocol statistics and current TCP/IP network connections.
PATH           Displays or sets a search path for executable files.
PING           Sends ICMP ECHO_REQUEST packets to network hosts.
POWERSHELL     Starts a Windows PowerShell session.
RD             Removes a directory.
REN            Renames a file or files.
ROUTE          Manipulates network routing tables.
SET            Displays, sets, or removes Windows environment variables.
SHUTDOWN       Allows proper local or remote shutdown of machine.
SORT           Sorts input.
SYSTEMINFO     Displays machine specific properties and configuration.
TASKKILL       Kill or stop a running process or application.
TASKLIST       Displays all currently running tasks including services.
TIME           Displays or sets the system time.
TITLE          Sets the window title for a CMD.EXE session.
TRACERT        Traces the route taken to a destination.
TREE           Graphically displays the directory structure of a drive or path.
TYPE           Displays the contents of a text file.
VER            Displays the Windows version.
WHERE          Displays the location of files that match a search pattern.
WHOAMI         Returns the current logged-in username.
XCOPY          Copies files and directory trees.`,
      exitCode: 0,
    };
  },

  // FIND - Find Text in File
  find: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return { output: '', error: 'FIND: Parameter format not correct', exitCode: 1 };
    }

    const ignoreCase = args.some(a => a.toLowerCase() === '/i');
    const countOnly = args.some(a => a.toLowerCase() === '/c');
    const invertMatch = args.some(a => a.toLowerCase() === '/v');
    const showLineNumbers = args.some(a => a.toLowerCase() === '/n');

    // Find the search string (in quotes)
    const searchIdx = args.findIndex(a => a.startsWith('"') || (!a.startsWith('/') && a.includes(' ')));
    let searchTerm = '';
    let fileArgs: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('/')) continue;

      if (arg.startsWith('"')) {
        searchTerm = arg.replace(/^"|"$/g, '');
      } else if (!searchTerm) {
        searchTerm = arg;
      } else {
        fileArgs.push(arg);
      }
    }

    if (!searchTerm) {
      return { output: '', error: 'FIND: Parameter format not correct', exitCode: 1 };
    }

    if (fileArgs.length === 0) {
      return { output: '', error: 'FIND: Parameter format not correct', exitCode: 1 };
    }

    let output = '';
    let foundAny = false;

    for (const file of fileArgs) {
      const filePath = fs.resolvePath(file, state.currentPath);
      const node = fs.getNode(filePath);

      if (!node || node.type !== 'file') {
        output += `File not found - ${file}\r\n`;
        continue;
      }

      const lines = (node.content || '').split(/\r?\n/);
      const matches: string[] = [];
      let matchCount = 0;

      lines.forEach((line, idx) => {
        const searchLine = ignoreCase ? line.toLowerCase() : line;
        const term = ignoreCase ? searchTerm.toLowerCase() : searchTerm;
        const found = searchLine.includes(term);

        if (invertMatch ? !found : found) {
          matchCount++;
          if (showLineNumbers) {
            matches.push(`[${idx + 1}]${line}`);
          } else {
            matches.push(line);
          }
        }
      });

      if (matches.length > 0) foundAny = true;

      output += `\r\n---------- ${file.toUpperCase()}\r\n`;
      if (countOnly) {
        output += `${matchCount}\r\n`;
      } else {
        output += matches.join('\r\n') + '\r\n';
      }
    }

    return { output, exitCode: foundAny ? 0 : 1 };
  },

  // FINDSTR - Extended Find String
  findstr: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    // Similar to FIND but with regex support
    return miscCommands.find(args, state, fs);
  },

  // SORT - Sort Input
  sort: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const reverse = args.some(a => a.toLowerCase() === '/r');
    const fileArgs = args.filter(a => !a.startsWith('/'));

    if (fileArgs.length === 0) {
      return { output: '', error: 'The syntax of the command is incorrect.', exitCode: 1 };
    }

    const filePath = fs.resolvePath(fileArgs[0], state.currentPath);
    const node = fs.getNode(filePath);

    if (!node || node.type !== 'file') {
      return { output: '', error: 'The system cannot find the file specified.', exitCode: 1 };
    }

    const lines = (node.content || '').split(/\r?\n/).filter(l => l);
    lines.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    if (reverse) lines.reverse();

    return { output: lines.join('\r\n'), exitCode: 0 };
  },

  // MORE - Display Output One Screen at a Time
  more: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const fileArgs = args.filter(a => !a.startsWith('/'));

    if (fileArgs.length === 0) {
      return { output: '-- More --', exitCode: 0 };
    }

    const filePath = fs.resolvePath(fileArgs[0], state.currentPath);
    const node = fs.getNode(filePath);

    if (!node || node.type !== 'file') {
      return { output: '', error: 'Cannot access file', exitCode: 1 };
    }

    return { output: node.content || '', exitCode: 0 };
  },

  // PAUSE - Pause Execution
  pause: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    return { output: 'Press any key to continue . . .', exitCode: 0 };
  },

  // COLOR - Set Console Colors
  color: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return {
        output: `Sets the default console foreground and background colors.\r\n\r\nCOLOR [attr]\r\n\r\n  attr        Specifies color attribute of console output\r\n\r\nColor attributes are specified by TWO hex digits -- the first is the\r\nbackground, the second the foreground.  Each digit can be any of the\r\nfollowing values:\r\n\r\n    0 = Black       8 = Gray\r\n    1 = Blue        9 = Light Blue\r\n    2 = Green       A = Light Green\r\n    3 = Aqua        B = Light Aqua\r\n    4 = Red         C = Light Red\r\n    5 = Purple      D = Light Purple\r\n    6 = Yellow      E = Light Yellow\r\n    7 = White       F = Bright White`,
        exitCode: 0,
      };
    }

    // In a real terminal this would change colors
    return { output: '', exitCode: 0 };
  },

  // WHERE - Locate Files
  where: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return { output: '', error: 'ERROR: Invalid syntax. No search term specified.', exitCode: 1 };
    }

    const searchTerm = args[0];
    const paths = (state.env.PATH || state.env.Path || '').split(';');
    const found: string[] = [];

    // Add current directory
    paths.unshift(state.currentPath);

    for (const pathDir of paths) {
      if (!pathDir) continue;

      const dirNode = fs.getNode(pathDir);
      if (!dirNode || dirNode.type !== 'directory') continue;

      dirNode.children?.forEach((node, name) => {
        if (node.type === 'file') {
          const lowerName = name.toLowerCase();
          const lowerSearch = searchTerm.toLowerCase();

          if (lowerName === lowerSearch ||
              lowerName === lowerSearch + '.exe' ||
              lowerName === lowerSearch + '.cmd' ||
              lowerName === lowerSearch + '.bat') {
            found.push(pathDir + '\\' + name);
          }
        }
      });
    }

    if (found.length === 0) {
      return { output: '', error: `INFO: Could not find files for the given pattern(s).`, exitCode: 1 };
    }

    return { output: found.join('\r\n'), exitCode: 0 };
  },

  // CHCP - Display/Set Code Page
  chcp: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return { output: 'Active code page: 65001', exitCode: 0 };
    }

    const codePage = parseInt(args[0]);
    if (isNaN(codePage)) {
      return { output: '', error: 'Invalid code page', exitCode: 1 };
    }

    return { output: `Active code page: ${codePage}`, exitCode: 0 };
  },

  // DOSKEY - Command Line Editing
  doskey: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.some(a => a.toLowerCase() === '/history')) {
      return { output: state.history.join('\r\n'), exitCode: 0 };
    }

    if (args.some(a => a.toLowerCase() === '/macros')) {
      const aliases = Object.entries(state.aliases)
        .map(([key, value]) => `${key}=${value}`)
        .join('\r\n');
      return { output: aliases || '(No macros defined)', exitCode: 0 };
    }

    return { output: '', exitCode: 0 };
  },

  // START - Start a Program
  start: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length === 0) {
      return { output: '', error: 'A command line arguments are required.\r\n\r\nSTART ["title"] [/D path] [/I] [/MIN] [/MAX] [/SEPARATE | /SHARED]\r\n      [/LOW | /NORMAL | /HIGH | /REALTIME | /ABOVENORMAL | /BELOWNORMAL]\r\n      [/NODE <NUMA node>] [/AFFINITY <hex affinity mask>] [/WAIT] [/B]\r\n      [command/program] [parameters]', exitCode: 1 };
    }

    // In a real terminal this would start a program
    const program = args.find(a => !a.startsWith('/') && !a.startsWith('"')) || args[args.length - 1];
    return { output: `Starting "${program}"...`, exitCode: 0 };
  },

  // TIMEOUT - Wait for Specified Time
  timeout: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const tIdx = args.findIndex(a => a.toLowerCase() === '/t');
    const seconds = tIdx !== -1 ? parseInt(args[tIdx + 1]) || 10 : 10;

    return { output: `\r\nWaiting for ${seconds} seconds, press a key to continue ...`, exitCode: 0 };
  },

  // CHOICE - Prompt User for Choice
  choice: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    const mIdx = args.findIndex(a => a.toLowerCase() === '/m');
    const message = mIdx !== -1 ? args[mIdx + 1]?.replace(/"/g, '') || '' : '';

    return { output: `${message}[Y,N]?`, exitCode: 0 };
  },

  // COMP - Compare Files
  comp: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (args.length < 2) {
      return { output: '', error: 'COMP: Insufficient arguments.', exitCode: 1 };
    }

    return { output: 'Comparing files...\r\nFiles compare OK', exitCode: 0 };
  },

  // MKLINK - Create Symbolic Link (simulated)
  mklink: (args: string[], state: WindowsTerminalState, fs: WindowsFileSystem): WindowsCommandResult => {
    if (!state.isAdmin) {
      return { output: '', error: 'You do not have sufficient privilege to perform this operation.', exitCode: 1 };
    }

    if (args.length < 2) {
      return {
        output: `Creates a symbolic link.\r\n\r\nMKLINK [[/D] | [/H] | [/J]] Link Target\r\n\r\n        /D      Creates a directory symbolic link.  Default is a file\r\n                symbolic link.\r\n        /H      Creates a hard link instead of a symbolic link.\r\n        /J      Creates a Directory Junction.\r\n        Link    Specifies the new symbolic link name.\r\n        Target  Specifies the path (relative or absolute) that the new link\r\n                refers to.`,
        exitCode: 0,
      };
    }

    return { output: 'symbolic link created...', exitCode: 0 };
  },
};

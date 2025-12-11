/**
 * Python OS Module
 */

import { PyValue, PyModule, PyFunction, pyInt, pyFloat, pyStr, pyBool, pyNone, pyList, pyTuple, pyDict } from '../types';
import { TypeError, ValueError, FileNotFoundError, PermissionError } from '../errors';

function func(name: string, fn: (...args: PyValue[]) => PyValue): PyFunction {
  return {
    type: 'function',
    name,
    params: [],
    body: [],
    closure: new Map(),
    isBuiltin: true,
    builtinFn: fn
  };
}

export function getOsModule(interpreter: any): PyModule {
  const exports = new Map<string, PyValue>();

  // Current working directory (simulated)
  let cwd = '/home/user';

  exports.set('getcwd', func('getcwd', () => pyStr(cwd)));
  exports.set('getcwdb', func('getcwdb', () => pyStr(cwd)));

  exports.set('chdir', func('chdir', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("chdir: path should be string");
    }
    cwd = path.value;
    return pyNone();
  }));

  // Environment variables (simulated)
  const environ = new Map<string, string>([
    ['HOME', '/home/user'],
    ['USER', 'user'],
    ['PATH', '/usr/bin:/bin'],
    ['SHELL', '/bin/bash'],
    ['LANG', 'en_US.UTF-8'],
    ['TERM', 'xterm-256color'],
    ['PWD', cwd],
    ['PYTHONPATH', '.'],
  ]);

  const environDict = pyDict();
  environ.forEach((value, key) => {
    environDict.entries.set(`"${key}"`, pyStr(value));
    environDict.keyObjects.set(`"${key}"`, pyStr(key));
  });
  exports.set('environ', environDict);

  exports.set('getenv', func('getenv', (key: PyValue, defaultVal?: PyValue) => {
    if (key.type !== 'str') {
      throw new TypeError("getenv() requires string key");
    }
    const value = environ.get(key.value);
    if (value !== undefined) {
      return pyStr(value);
    }
    return defaultVal || pyNone();
  }));

  exports.set('putenv', func('putenv', (key: PyValue, value: PyValue) => {
    if (key.type !== 'str' || value.type !== 'str') {
      throw new TypeError("putenv() requires string arguments");
    }
    environ.set(key.value, value.value);
    environDict.entries.set(`"${key.value}"`, pyStr(value.value));
    environDict.keyObjects.set(`"${key.value}"`, pyStr(key.value));
    return pyNone();
  }));

  // Path operations
  exports.set('sep', pyStr('/'));
  exports.set('altsep', pyNone());
  exports.set('extsep', pyStr('.'));
  exports.set('pathsep', pyStr(':'));
  exports.set('linesep', pyStr('\n'));
  exports.set('devnull', pyStr('/dev/null'));
  exports.set('curdir', pyStr('.'));
  exports.set('pardir', pyStr('..'));

  // os.path submodule
  const pathExports = new Map<string, PyValue>();

  pathExports.set('join', func('join', (...parts: PyValue[]) => {
    const paths = parts.map(p => {
      if (p.type !== 'str') {
        throw new TypeError("join() requires string arguments");
      }
      return p.value;
    });

    let result = paths[0] || '';
    for (let i = 1; i < paths.length; i++) {
      const part = paths[i];
      if (part.startsWith('/')) {
        result = part;
      } else if (result.endsWith('/')) {
        result += part;
      } else {
        result += '/' + part;
      }
    }
    return pyStr(result);
  }));

  pathExports.set('dirname', func('dirname', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("dirname() requires string argument");
    }
    const lastSlash = path.value.lastIndexOf('/');
    if (lastSlash === -1) return pyStr('');
    if (lastSlash === 0) return pyStr('/');
    return pyStr(path.value.substring(0, lastSlash));
  }));

  pathExports.set('basename', func('basename', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("basename() requires string argument");
    }
    const lastSlash = path.value.lastIndexOf('/');
    return pyStr(path.value.substring(lastSlash + 1));
  }));

  pathExports.set('split', func('split', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("split() requires string argument");
    }
    const lastSlash = path.value.lastIndexOf('/');
    if (lastSlash === -1) {
      return pyTuple([pyStr(''), pyStr(path.value)]);
    }
    const dir = lastSlash === 0 ? '/' : path.value.substring(0, lastSlash);
    const base = path.value.substring(lastSlash + 1);
    return pyTuple([pyStr(dir), pyStr(base)]);
  }));

  pathExports.set('splitext', func('splitext', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("splitext() requires string argument");
    }
    const lastDot = path.value.lastIndexOf('.');
    const lastSlash = path.value.lastIndexOf('/');

    if (lastDot === -1 || lastDot < lastSlash + 1 || lastDot === lastSlash + 1) {
      return pyTuple([pyStr(path.value), pyStr('')]);
    }

    return pyTuple([
      pyStr(path.value.substring(0, lastDot)),
      pyStr(path.value.substring(lastDot))
    ]);
  }));

  pathExports.set('exists', func('exists', (path: PyValue) => {
    // In simulation, always return true for simplicity
    return pyBool(true);
  }));

  pathExports.set('isfile', func('isfile', (path: PyValue) => {
    if (path.type !== 'str') return pyBool(false);
    // Check if path has extension (simplified check)
    return pyBool(path.value.includes('.'));
  }));

  pathExports.set('isdir', func('isdir', (path: PyValue) => {
    if (path.type !== 'str') return pyBool(false);
    // Assume no extension means directory (simplified)
    return pyBool(!path.value.includes('.') || path.value.endsWith('/'));
  }));

  pathExports.set('isabs', func('isabs', (path: PyValue) => {
    if (path.type !== 'str') return pyBool(false);
    return pyBool(path.value.startsWith('/'));
  }));

  pathExports.set('abspath', func('abspath', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("abspath() requires string argument");
    }
    if (path.value.startsWith('/')) {
      return path;
    }
    return pyStr(cwd + '/' + path.value);
  }));

  pathExports.set('normpath', func('normpath', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("normpath() requires string argument");
    }

    const parts = path.value.split('/');
    const result: string[] = [];

    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (result.length > 0 && result[result.length - 1] !== '..') {
          result.pop();
        } else if (!path.value.startsWith('/')) {
          result.push('..');
        }
      } else {
        result.push(part);
      }
    }

    let normalized = result.join('/');
    if (path.value.startsWith('/')) {
      normalized = '/' + normalized;
    }
    return pyStr(normalized || '.');
  }));

  pathExports.set('expanduser', func('expanduser', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("expanduser() requires string argument");
    }
    if (path.value.startsWith('~')) {
      return pyStr('/home/user' + path.value.substring(1));
    }
    return path;
  }));

  pathExports.set('expandvars', func('expandvars', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("expandvars() requires string argument");
    }
    let result = path.value;
    environ.forEach((value, key) => {
      result = result.replace(new RegExp(`\\$${key}|\\$\\{${key}\\}`, 'g'), value);
    });
    return pyStr(result);
  }));

  pathExports.set('relpath', func('relpath', (path: PyValue, start?: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("relpath() requires string argument");
    }
    // Simplified: just return the path
    return path;
  }));

  pathExports.set('commonpath', func('commonpath', (paths: PyValue) => {
    if (paths.type !== 'list' && paths.type !== 'tuple') {
      throw new TypeError("commonpath() requires iterable");
    }

    if (paths.items.length === 0) {
      throw new ValueError("commonpath() arg is an empty sequence");
    }

    const pathStrs = paths.items.map(p => {
      if (p.type !== 'str') throw new TypeError("expected str");
      return p.value;
    });

    const splitPaths = pathStrs.map(p => p.split('/').filter(s => s));
    const minLen = Math.min(...splitPaths.map(p => p.length));

    const common: string[] = [];
    for (let i = 0; i < minLen; i++) {
      const part = splitPaths[0][i];
      if (splitPaths.every(p => p[i] === part)) {
        common.push(part);
      } else {
        break;
      }
    }

    let result = common.join('/');
    if (pathStrs[0].startsWith('/')) {
      result = '/' + result;
    }

    return pyStr(result || '.');
  }));

  exports.set('path', {
    type: 'module',
    name: 'os.path',
    exports: pathExports
  } as PyModule);

  // File operations (simulated/stubs)
  exports.set('listdir', func('listdir', (path?: PyValue) => {
    // Return simulated directory listing
    return pyList([
      pyStr('file1.txt'),
      pyStr('file2.py'),
      pyStr('directory'),
    ]);
  }));

  exports.set('mkdir', func('mkdir', (path: PyValue, mode?: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("mkdir() requires string path");
    }
    // Simulated - do nothing
    return pyNone();
  }));

  exports.set('makedirs', func('makedirs', (path: PyValue, mode?: PyValue, exist_ok?: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("makedirs() requires string path");
    }
    return pyNone();
  }));

  exports.set('remove', func('remove', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("remove() requires string path");
    }
    return pyNone();
  }));

  exports.set('rmdir', func('rmdir', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("rmdir() requires string path");
    }
    return pyNone();
  }));

  exports.set('rename', func('rename', (src: PyValue, dst: PyValue) => {
    if (src.type !== 'str' || dst.type !== 'str') {
      throw new TypeError("rename() requires string arguments");
    }
    return pyNone();
  }));

  // System information
  exports.set('name', pyStr('posix'));
  exports.set('uname', func('uname', () => {
    return pyTuple([
      pyStr('Linux'),           // sysname
      pyStr('localhost'),       // nodename
      pyStr('5.4.0'),           // release
      pyStr('#1 SMP'),          // version
      pyStr('x86_64')           // machine
    ]);
  }));

  exports.set('getpid', func('getpid', () => pyInt(1)));
  exports.set('getppid', func('getppid', () => pyInt(0)));
  exports.set('getuid', func('getuid', () => pyInt(1000)));
  exports.set('getgid', func('getgid', () => pyInt(1000)));
  exports.set('geteuid', func('geteuid', () => pyInt(1000)));
  exports.set('getegid', func('getegid', () => pyInt(1000)));
  exports.set('getlogin', func('getlogin', () => pyStr('user')));

  exports.set('cpu_count', func('cpu_count', () => pyInt(4)));

  // System calls (stubs)
  exports.set('system', func('system', (command: PyValue) => {
    if (command.type !== 'str') {
      throw new TypeError("system() requires string command");
    }
    interpreter.print(`[Simulated] Executing: ${command.value}`);
    return pyInt(0);
  }));

  exports.set('popen', func('popen', (command: PyValue) => {
    throw new TypeError("os.popen() is not supported in this environment");
  }));

  // File descriptors (stubs)
  exports.set('open', func('open', () => {
    throw new TypeError("os.open() is not supported in this environment");
  }));

  exports.set('close', func('close', () => {
    return pyNone();
  }));

  exports.set('read', func('read', () => {
    throw new TypeError("os.read() is not supported in this environment");
  }));

  exports.set('write', func('write', () => {
    throw new TypeError("os.write() is not supported in this environment");
  }));

  // Walk (generator-like, simplified)
  exports.set('walk', func('walk', (top: PyValue) => {
    if (top.type !== 'str') {
      throw new TypeError("walk() requires string path");
    }
    // Return simulated walk result
    return pyList([
      pyTuple([
        pyStr(top.value),
        pyList([pyStr('subdir')]),
        pyList([pyStr('file.txt')])
      ])
    ]);
  }));

  // Stat result (simplified)
  exports.set('stat', func('stat', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("stat() requires string path");
    }
    // Return simulated stat result
    return pyTuple([
      pyInt(33188),  // st_mode
      pyInt(12345),  // st_ino
      pyInt(0),      // st_dev
      pyInt(1),      // st_nlink
      pyInt(1000),   // st_uid
      pyInt(1000),   // st_gid
      pyInt(1024),   // st_size
      pyFloat(Date.now() / 1000),  // st_atime
      pyFloat(Date.now() / 1000),  // st_mtime
      pyFloat(Date.now() / 1000),  // st_ctime
    ]);
  }));

  // Access
  exports.set('access', func('access', (path: PyValue, mode: PyValue) => {
    return pyBool(true); // Always accessible in simulation
  }));

  // Constants
  exports.set('F_OK', pyInt(0));
  exports.set('R_OK', pyInt(4));
  exports.set('W_OK', pyInt(2));
  exports.set('X_OK', pyInt(1));

  exports.set('O_RDONLY', pyInt(0));
  exports.set('O_WRONLY', pyInt(1));
  exports.set('O_RDWR', pyInt(2));
  exports.set('O_CREAT', pyInt(64));
  exports.set('O_TRUNC', pyInt(512));
  exports.set('O_APPEND', pyInt(1024));

  return {
    type: 'module',
    name: 'os',
    exports
  };
}

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

  // Get filesystem and current path from interpreter context
  const getContext = () => interpreter.getContext ? interpreter.getContext() : {};
  const getFs = () => getContext().filesystem;
  const getState = () => getContext().terminalState || {};
  const getUser = () => getState().currentUser || 'user';
  const getHostname = () => getState().hostname || 'localhost';
  const getHome = () => `/home/${getUser()}`;
  const getCwd = () => getContext().currentPath || getHome();

  exports.set('getcwd', func('getcwd', () => pyStr(getCwd())));
  exports.set('getcwdb', func('getcwdb', () => pyStr(getCwd())));

  exports.set('chdir', func('chdir', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("chdir: path should be string");
    }
    const fs = getFs();
    if (fs) {
      const targetPath = fs.resolvePath(path.value, getCwd());
      const node = fs.getNode(targetPath);
      if (!node) {
        throw new FileNotFoundError(path.value);
      }
      if (node.type !== 'directory') {
        throw new TypeError("Not a directory");
      }
      if (interpreter.setCurrentPath) {
        interpreter.setCurrentPath(targetPath);
      }
    }
    return pyNone();
  }));

  // Environment variables - use dynamic values from terminal state
  const getEnviron = () => {
    const state = getState();
    const env = state.env || {};
    return new Map<string, string>([
      ['HOME', getHome()],
      ['USER', getUser()],
      ['PATH', env.PATH || '/usr/bin:/bin'],
      ['SHELL', env.SHELL || '/bin/bash'],
      ['LANG', env.LANG || 'en_US.UTF-8'],
      ['TERM', env.TERM || 'xterm-256color'],
      ['PWD', getCwd()],
      ['PYTHONPATH', env.PYTHONPATH || '.'],
      ['HOSTNAME', getHostname()],
    ]);
  };

  // Create environ dict getter that updates dynamically
  exports.set('environ', {
    type: 'dict',
    entries: new Map(),
    keyObjects: new Map(),
    get items() {
      const environ = getEnviron();
      const entries = new Map<string, PyValue>();
      const keyObjects = new Map<string, PyValue>();
      environ.forEach((value, key) => {
        entries.set(`"${key}"`, pyStr(value));
        keyObjects.set(`"${key}"`, pyStr(key));
      });
      return { entries, keyObjects };
    }
  } as any);

  exports.set('getenv', func('getenv', (key: PyValue, defaultVal?: PyValue) => {
    if (key.type !== 'str') {
      throw new TypeError("getenv() requires string key");
    }
    const environ = getEnviron();
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
    // Note: putenv updates the process environment, but in simulation
    // we can't actually persist this across calls easily
    interpreter.print(`[Note] putenv('${key.value}', '${value.value}') - environment updated for this session`);
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
    if (path.type !== 'str') return pyBool(false);
    const fs = getFs();
    if (fs) {
      const fullPath = fs.resolvePath(path.value, getCwd());
      const node = fs.getNode(fullPath);
      return pyBool(node !== null && node !== undefined);
    }
    return pyBool(false);
  }));

  pathExports.set('isfile', func('isfile', (path: PyValue) => {
    if (path.type !== 'str') return pyBool(false);
    const fs = getFs();
    if (fs) {
      const fullPath = fs.resolvePath(path.value, getCwd());
      const node = fs.getNode(fullPath);
      return pyBool(node !== null && node !== undefined && node.type === 'file');
    }
    return pyBool(false);
  }));

  pathExports.set('isdir', func('isdir', (path: PyValue) => {
    if (path.type !== 'str') return pyBool(false);
    const fs = getFs();
    if (fs) {
      const fullPath = fs.resolvePath(path.value, getCwd());
      const node = fs.getNode(fullPath);
      return pyBool(node !== null && node !== undefined && node.type === 'directory');
    }
    return pyBool(false);
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
    return pyStr(getCwd() + '/' + path.value);
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
    const environ = getEnviron();
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

  // File operations - uses real filesystem when available
  exports.set('listdir', func('listdir', (path?: PyValue) => {
    const fs = getFs();
    const targetPath = path?.type === 'str' ? path.value : '.';

    if (fs) {
      // Resolve the path relative to current directory
      const fullPath = fs.resolvePath(targetPath, getCwd());
      const node = fs.getNode(fullPath);

      if (!node) {
        throw new FileNotFoundError(targetPath);
      }

      if (node.type !== 'directory') {
        throw new TypeError(`Not a directory: '${targetPath}'`);
      }

      // Return list of children names (children is a Map, not an object)
      const children = node.children;
      if (!children) {
        return pyList([]);
      }
      const names: string[] = Array.from(children.keys());
      return pyList(names.map((name: string) => pyStr(name)));
    }

    // Fallback for no filesystem
    return pyList([]);
  }));

  exports.set('mkdir', func('mkdir', (path: PyValue, mode?: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("mkdir() requires string path");
    }
    const fs = getFs();
    if (fs) {
      const fullPath = fs.resolvePath(path.value, getCwd());
      const success = fs.createNode(fullPath, 'directory', getUser());
      if (!success) {
        throw new FileNotFoundError(`Cannot create directory '${path.value}'`);
      }
    }
    return pyNone();
  }));

  exports.set('makedirs', func('makedirs', (path: PyValue, mode?: PyValue, exist_ok?: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("makedirs() requires string path");
    }
    const fs = getFs();
    if (fs) {
      const fullPath = fs.resolvePath(path.value, getCwd());
      // Create parent directories as needed
      const parts = fullPath.split('/').filter(p => p);
      let currentPath = '';
      for (const part of parts) {
        currentPath += '/' + part;
        const node = fs.getNode(currentPath);
        if (!node) {
          fs.createNode(currentPath, 'directory', getUser());
        } else if (node.type !== 'directory') {
          throw new FileNotFoundError(`Not a directory: '${currentPath}'`);
        }
      }
    }
    return pyNone();
  }));

  exports.set('remove', func('remove', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("remove() requires string path");
    }
    const fs = getFs();
    if (fs) {
      const fullPath = fs.resolvePath(path.value, getCwd());
      const node = fs.getNode(fullPath);
      if (!node) {
        throw new FileNotFoundError(path.value);
      }
      if (node.type === 'directory') {
        throw new TypeError(`Is a directory: '${path.value}'`);
      }
      fs.deleteNode(fullPath);
    }
    return pyNone();
  }));

  exports.set('rmdir', func('rmdir', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("rmdir() requires string path");
    }
    const fs = getFs();
    if (fs) {
      const fullPath = fs.resolvePath(path.value, getCwd());
      const node = fs.getNode(fullPath);
      if (!node) {
        throw new FileNotFoundError(path.value);
      }
      if (node.type !== 'directory') {
        throw new TypeError(`Not a directory: '${path.value}'`);
      }
      if (node.children && node.children.size > 0) {
        throw new TypeError(`Directory not empty: '${path.value}'`);
      }
      fs.deleteNode(fullPath);
    }
    return pyNone();
  }));

  exports.set('rename', func('rename', (src: PyValue, dst: PyValue) => {
    if (src.type !== 'str' || dst.type !== 'str') {
      throw new TypeError("rename() requires string arguments");
    }
    const fs = getFs();
    if (fs) {
      const srcPath = fs.resolvePath(src.value, getCwd());
      const dstPath = fs.resolvePath(dst.value, getCwd());
      const success = fs.moveNode(srcPath, dstPath);
      if (!success) {
        throw new FileNotFoundError(src.value);
      }
    }
    return pyNone();
  }));

  // System information - use dynamic values
  exports.set('name', pyStr('posix'));
  exports.set('uname', func('uname', () => {
    return pyTuple([
      pyStr('Linux'),           // sysname
      pyStr(getHostname()),     // nodename - dynamic
      pyStr('5.4.0'),           // release
      pyStr('#1 SMP'),          // version
      pyStr('x86_64')           // machine
    ]);
  }));

  exports.set('getpid', func('getpid', () => pyInt(Math.floor(Math.random() * 30000) + 1000)));
  exports.set('getppid', func('getppid', () => pyInt(1)));
  exports.set('getuid', func('getuid', () => pyInt(getUser() === 'root' ? 0 : 1000)));
  exports.set('getgid', func('getgid', () => pyInt(getUser() === 'root' ? 0 : 1000)));
  exports.set('geteuid', func('geteuid', () => pyInt(getUser() === 'root' ? 0 : 1000)));
  exports.set('getegid', func('getegid', () => pyInt(getUser() === 'root' ? 0 : 1000)));
  exports.set('getlogin', func('getlogin', () => pyStr(getUser())));

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

  // Walk - uses real filesystem
  exports.set('walk', func('walk', (top: PyValue) => {
    if (top.type !== 'str') {
      throw new TypeError("walk() requires string path");
    }
    const fs = getFs();
    if (!fs) {
      return pyList([]);
    }

    const results: PyValue[] = [];
    const fullPath = fs.resolvePath(top.value, getCwd());

    // Helper function to walk directories recursively
    const walkDir = (dirPath: string) => {
      const node = fs.getNode(dirPath);
      if (!node || node.type !== 'directory' || !node.children) {
        return;
      }

      const dirs: string[] = [];
      const files: string[] = [];

      for (const [name, child] of node.children) {
        if (child.type === 'directory') {
          dirs.push(name);
        } else {
          files.push(name);
        }
      }

      results.push(pyTuple([
        pyStr(dirPath),
        pyList(dirs.map(d => pyStr(d))),
        pyList(files.map(f => pyStr(f)))
      ]));

      // Recurse into subdirectories
      for (const dir of dirs) {
        walkDir(dirPath === '/' ? `/${dir}` : `${dirPath}/${dir}`);
      }
    };

    walkDir(fullPath);
    return pyList(results);
  }));

  // Stat - uses real filesystem
  exports.set('stat', func('stat', (path: PyValue) => {
    if (path.type !== 'str') {
      throw new TypeError("stat() requires string path");
    }
    const fs = getFs();
    if (fs) {
      const fullPath = fs.resolvePath(path.value, getCwd());
      const node = fs.getNode(fullPath);

      if (!node) {
        throw new FileNotFoundError(path.value);
      }

      // Calculate mode based on type and permissions
      let mode = node.type === 'directory' ? 0o40000 : 0o100000; // S_IFDIR or S_IFREG
      const perms = node.permissions || '-rwxr-xr-x';
      if (perms[1] === 'r') mode |= 0o400;
      if (perms[2] === 'w') mode |= 0o200;
      if (perms[3] === 'x') mode |= 0o100;
      if (perms[4] === 'r') mode |= 0o040;
      if (perms[5] === 'w') mode |= 0o020;
      if (perms[6] === 'x') mode |= 0o010;
      if (perms[7] === 'r') mode |= 0o004;
      if (perms[8] === 'w') mode |= 0o002;
      if (perms[9] === 'x') mode |= 0o001;

      const size = node.type === 'file' ? (node.content?.length || 0) : 4096;
      const mtime = node.modified ? node.modified.getTime() / 1000 : Date.now() / 1000;

      return pyTuple([
        pyInt(mode),           // st_mode
        pyInt(Math.floor(Math.random() * 100000)),  // st_ino
        pyInt(0),              // st_dev
        pyInt(1),              // st_nlink
        pyInt(node.owner === 'root' ? 0 : 1000),   // st_uid
        pyInt(1000),           // st_gid
        pyInt(size),           // st_size
        pyFloat(mtime),        // st_atime
        pyFloat(mtime),        // st_mtime
        pyFloat(mtime),        // st_ctime
      ]);
    }

    throw new FileNotFoundError(path.value);
  }));

  // Access - uses real filesystem
  exports.set('access', func('access', (path: PyValue, mode: PyValue) => {
    if (path.type !== 'str') return pyBool(false);
    const fs = getFs();
    if (fs) {
      const fullPath = fs.resolvePath(path.value, getCwd());
      const node = fs.getNode(fullPath);
      if (!node) return pyBool(false);

      // F_OK (0) just checks existence
      if (mode.type === 'int' && mode.value === 0) {
        return pyBool(true);
      }

      // For R_OK, W_OK, X_OK - simplified check
      return pyBool(true);
    }
    return pyBool(false);
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

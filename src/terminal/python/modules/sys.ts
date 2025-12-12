/**
 * Python Sys Module
 */

import { PyValue, PyModule, PyFunction, pyInt, pyFloat, pyStr, pyBool, pyNone, pyList, pyTuple } from '../types';
import { SystemExit } from '../errors';

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

export function getSysModule(interpreter: any): PyModule {
  const exports = new Map<string, PyValue>();

  // Version information
  exports.set('version', pyStr('3.11.0 (Python Simulator)'));
  exports.set('version_info', pyTuple([
    pyInt(3), pyInt(11), pyInt(0), pyStr('final'), pyInt(0)
  ]));

  // Platform information
  exports.set('platform', pyStr('browser'));
  exports.set('executable', pyStr('/usr/bin/python3'));

  // Path information
  exports.set('path', pyList([
    pyStr('.'),
    pyStr('/usr/lib/python3'),
    pyStr('/usr/lib/python3/site-packages')
  ]));

  exports.set('prefix', pyStr('/usr'));
  exports.set('exec_prefix', pyStr('/usr'));

  // Standard streams (simplified)
  exports.set('stdin', pyNone()); // Not really usable
  exports.set('stdout', pyNone());
  exports.set('stderr', pyNone());

  // Argv (command line arguments)
  exports.set('argv', pyList([pyStr('python')]));

  // Module search
  exports.set('modules', pyList([]));
  exports.set('builtin_module_names', pyTuple([
    pyStr('math'),
    pyStr('random'),
    pyStr('datetime'),
    pyStr('json'),
    pyStr('sys'),
    pyStr('os'),
    pyStr('string')
  ]));

  // Limits
  exports.set('maxsize', pyInt(Number.MAX_SAFE_INTEGER));
  exports.set('maxunicode', pyInt(0x10FFFF));
  exports.set('float_info', pyTuple([
    pyFloat(Number.MAX_VALUE),  // max
    pyInt(308),                  // max_exp
    pyFloat(Number.MIN_VALUE),  // min
    pyInt(-307),                 // min_exp
    pyInt(15),                   // dig
    pyFloat(Number.EPSILON)      // epsilon
  ]));

  exports.set('int_info', pyTuple([
    pyInt(30),  // bits_per_digit
    pyInt(4)    // sizeof_digit
  ]));

  // Recursion limit
  let recursionLimit = 1000;
  exports.set('getrecursionlimit', func('getrecursionlimit', () => pyInt(recursionLimit)));
  exports.set('setrecursionlimit', func('setrecursionlimit', (limit: PyValue) => {
    if (limit.type !== 'int') {
      throw new Error("recursion limit must be an integer");
    }
    recursionLimit = limit.value;
    return pyNone();
  }));

  // Exit function
  exports.set('exit', func('exit', (code?: PyValue) => {
    const exitCode = code?.type === 'int' ? code.value : 0;
    throw new SystemExit(exitCode);
  }));

  // Reference count (stub)
  exports.set('getrefcount', func('getrefcount', (obj: PyValue) => {
    return pyInt(2); // Always returns 2 as a stub
  }));

  // Size of object (stub)
  exports.set('getsizeof', func('getsizeof', (obj: PyValue) => {
    // Return approximate memory size
    switch (obj.type) {
      case 'int':
        return pyInt(28);
      case 'float':
        return pyInt(24);
      case 'str':
        return pyInt(49 + obj.value.length);
      case 'list':
        return pyInt(56 + obj.items.length * 8);
      case 'dict':
        return pyInt(232 + obj.entries.size * 8);
      default:
        return pyInt(48);
    }
  }));

  // Implementation info
  exports.set('implementation', {
    type: 'instance',
    __class__: {
      type: 'class',
      name: 'implementation',
      bases: [],
      methods: new Map(),
      attributes: new Map()
    },
    attributes: new Map<string, PyValue>([
      ['name', pyStr('PythonSimulator')],
      ['version', pyTuple([pyInt(3), pyInt(11), pyInt(0)]) as PyValue],
      ['cache_tag', pyStr('pysim-311')]
    ])
  } as any);

  // Flags (stub)
  exports.set('flags', pyTuple([
    pyInt(0),  // debug
    pyInt(0),  // inspect
    pyInt(0),  // interactive
    pyInt(0),  // optimize
    pyInt(0),  // dont_write_bytecode
    pyInt(0),  // no_user_site
    pyInt(0),  // no_site
    pyInt(0),  // ignore_environment
    pyInt(0),  // verbose
    pyInt(0),  // bytes_warning
    pyInt(0),  // quiet
    pyInt(0),  // hash_randomization
    pyInt(0),  // isolated
    pyInt(0),  // dev_mode
    pyInt(0),  // utf8_mode
  ]));

  // Default encoding
  exports.set('getdefaultencoding', func('getdefaultencoding', () => pyStr('utf-8')));
  exports.set('getfilesystemencoding', func('getfilesystemencoding', () => pyStr('utf-8')));

  // Byte order
  exports.set('byteorder', pyStr('little'));

  // API version
  exports.set('api_version', pyInt(1013));

  // Hexversion (3.11.0 = 0x030b0000)
  exports.set('hexversion', pyInt(0x030b0000));

  // Copyright
  exports.set('copyright', pyStr('Python Simulator - For educational purposes'));

  // Intern function (stub)
  exports.set('intern', func('intern', (s: PyValue) => {
    if (s.type !== 'str') {
      throw new Error("intern() requires a string");
    }
    return s;
  }));

  return {
    type: 'module',
    name: 'sys',
    exports
  };
}

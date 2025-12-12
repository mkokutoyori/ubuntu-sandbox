/**
 * Python Built-in Functions
 */

import {
  PyValue, PyFunction, PyList, PyTuple, PyDict, PyInt, PyFloat, PyStr, PyBool, PyRange,
  pyInt, pyFloat, pyStr, pyBool, pyNone, pyList, pyTuple, pyDict, pySet, pyRange,
  pyRepr, pyStr_value, pyTruthy, pyEqual, pyValueToString
} from '../types';

import {
  TypeError, ValueError, StopIteration
} from '../errors';

// Static imports for eval function
import { Lexer } from '../lexer';
import { Parser } from '../parser';

export function getBuiltins(interpreter: any): { [name: string]: PyValue } {
  // Helper to create builtin function
  const builtin = (name: string, fn: (...args: PyValue[]) => PyValue): PyFunction => ({
    type: 'function',
    name,
    params: [],
    body: [],
    closure: new Map(),
    isBuiltin: true,
    builtinFn: fn
  });

  return {
    // === I/O ===
    print: builtin('print', (...args: PyValue[]) => {
      const output = args.map(a => pyStr_value(a)).join(' ');
      interpreter.print(output);
      return pyNone();
    }),

    input: builtin('input', (prompt?: PyValue) => {
      // In terminal simulator, this will be handled specially
      if (prompt && prompt.type === 'str') {
        interpreter.print(prompt.value);
      }
      return pyStr(''); // Placeholder - actual input handled by terminal
    }),

    // === Type Conversion ===
    int: builtin('int', (x?: PyValue, base?: PyValue) => {
      if (x === undefined) return pyInt(0);

      if (x.type === 'int') return x;
      if (x.type === 'float') return pyInt(Math.floor(x.value));
      if (x.type === 'bool') return pyInt(x.value ? 1 : 0);
      if (x.type === 'str') {
        const b = base?.type === 'int' ? base.value : 10;
        const n = parseInt(x.value, b);
        if (isNaN(n)) {
          throw new ValueError(`invalid literal for int() with base ${b}: '${x.value}'`);
        }
        return pyInt(n);
      }

      throw new TypeError(`int() argument must be a string or a number`);
    }),

    float: builtin('float', (x?: PyValue) => {
      if (x === undefined) return pyFloat(0.0);

      if (x.type === 'float') return x;
      if (x.type === 'int') return pyFloat(x.value);
      if (x.type === 'str') {
        const n = parseFloat(x.value);
        if (isNaN(n)) {
          throw new ValueError(`could not convert string to float: '${x.value}'`);
        }
        return pyFloat(n);
      }

      throw new TypeError(`float() argument must be a string or a number`);
    }),

    str: builtin('str', (x?: PyValue) => {
      if (x === undefined) return pyStr('');
      return pyStr(pyStr_value(x));
    }),

    bool: builtin('bool', (x?: PyValue) => {
      if (x === undefined) return pyBool(false);
      return pyBool(pyTruthy(x));
    }),

    list: builtin('list', (x?: PyValue) => {
      if (x === undefined) return pyList([]);

      if (x.type === 'list') return pyList([...x.items]);
      if (x.type === 'tuple') return pyList([...x.items]);
      if (x.type === 'str') return pyList([...x.value].map(c => pyStr(c)));
      if (x.type === 'set') {
        const items: PyValue[] = [];
        x.itemObjects.forEach(obj => items.push(obj));
        return pyList(items);
      }
      if (x.type === 'dict') {
        const items: PyValue[] = [];
        x.keyObjects.forEach(obj => items.push(obj));
        return pyList(items);
      }
      if (x.type === 'range') {
        const items: PyValue[] = [];
        const { start, stop, step } = x;
        if (step > 0) {
          for (let i = start; i < stop; i += step) items.push(pyInt(i));
        } else {
          for (let i = start; i > stop; i += step) items.push(pyInt(i));
        }
        return pyList(items);
      }

      throw new TypeError(`'${x.type}' object is not iterable`);
    }),

    tuple: builtin('tuple', (x?: PyValue) => {
      if (x === undefined) return pyTuple([]);

      if (x.type === 'tuple') return x;
      if (x.type === 'list') return pyTuple([...x.items]);
      if (x.type === 'str') return pyTuple([...x.value].map(c => pyStr(c)));

      throw new TypeError(`'${x.type}' object is not iterable`);
    }),

    dict: builtin('dict', () => {
      return pyDict([]);
    }),

    set: builtin('set', (x?: PyValue) => {
      if (x === undefined) return pySet([]);

      if (x.type === 'list' || x.type === 'tuple') {
        return pySet(x.items);
      }
      if (x.type === 'set') {
        return pySet([...x.itemObjects.values()]);
      }

      throw new TypeError(`'${x.type}' object is not iterable`);
    }),

    // === Sequences ===
    len: builtin('len', (x: PyValue) => {
      if (x.type === 'str') return pyInt(x.value.length);
      if (x.type === 'list' || x.type === 'tuple') return pyInt(x.items.length);
      if (x.type === 'dict') return pyInt(x.entries.size);
      if (x.type === 'set') return pyInt(x.items.size);
      if (x.type === 'range') {
        const { start, stop, step } = x;
        const len = Math.max(0, Math.ceil((stop - start) / step));
        return pyInt(len);
      }

      throw new TypeError(`object of type '${x.type}' has no len()`);
    }),

    range: builtin('range', (...args: PyValue[]) => {
      let start = 0, stop = 0, step = 1;

      if (args.length === 1) {
        if (args[0].type !== 'int') throw new TypeError("'range' requires integer arguments");
        stop = args[0].value;
      } else if (args.length === 2) {
        if (args[0].type !== 'int' || args[1].type !== 'int') {
          throw new TypeError("'range' requires integer arguments");
        }
        start = args[0].value;
        stop = args[1].value;
      } else if (args.length >= 3) {
        if (args[0].type !== 'int' || args[1].type !== 'int' || args[2].type !== 'int') {
          throw new TypeError("'range' requires integer arguments");
        }
        start = args[0].value;
        stop = args[1].value;
        step = args[2].value;
        if (step === 0) {
          throw new ValueError("range() arg 3 must not be zero");
        }
      }

      return pyRange(start, stop, step);
    }),

    enumerate: builtin('enumerate', (iterable: PyValue, start?: PyValue) => {
      const startIdx = start?.type === 'int' ? start.value : 0;
      const items: PyValue[] = [];

      if (iterable.type === 'list' || iterable.type === 'tuple') {
        iterable.items.forEach((item, i) => {
          items.push(pyTuple([pyInt(startIdx + i), item]));
        });
      } else if (iterable.type === 'str') {
        [...iterable.value].forEach((char, i) => {
          items.push(pyTuple([pyInt(startIdx + i), pyStr(char)]));
        });
      }

      return pyList(items);
    }),

    zip: builtin('zip', (...iterables: PyValue[]) => {
      if (iterables.length === 0) return pyList([]);

      const arrays = iterables.map(it => {
        if (it.type === 'list' || it.type === 'tuple') return it.items;
        if (it.type === 'str') return [...it.value].map(c => pyStr(c));
        throw new TypeError(`'${it.type}' object is not iterable`);
      });

      const minLen = Math.min(...arrays.map(a => a.length));
      const result: PyValue[] = [];

      for (let i = 0; i < minLen; i++) {
        result.push(pyTuple(arrays.map(a => a[i])));
      }

      return pyList(result);
    }),

    sorted: builtin('sorted', (iterable: PyValue, ...kwargs: PyValue[]) => {
      let items: PyValue[];

      if (iterable.type === 'list' || iterable.type === 'tuple') {
        items = [...iterable.items];
      } else if (iterable.type === 'str') {
        items = [...iterable.value].map(c => pyStr(c));
      } else {
        throw new TypeError(`'${iterable.type}' object is not iterable`);
      }

      items.sort((a, b) => {
        if ((a.type === 'int' || a.type === 'float') && (b.type === 'int' || b.type === 'float')) {
          return a.value - b.value;
        }
        if (a.type === 'str' && b.type === 'str') {
          return a.value.localeCompare(b.value);
        }
        return 0;
      });

      return pyList(items);
    }),

    reversed: builtin('reversed', (seq: PyValue) => {
      if (seq.type === 'list') return pyList([...seq.items].reverse());
      if (seq.type === 'tuple') return pyList([...seq.items].reverse());
      if (seq.type === 'str') return pyList([...seq.value].reverse().map(c => pyStr(c)));
      if (seq.type === 'range') {
        const items: PyValue[] = [];
        const { start, stop, step } = seq;
        if (step > 0) {
          for (let i = stop - step; i >= start; i -= step) items.push(pyInt(i));
        } else {
          for (let i = stop - step; i <= start; i -= step) items.push(pyInt(i));
        }
        return pyList(items);
      }

      throw new TypeError(`'${seq.type}' object is not reversible`);
    }),

    min: builtin('min', (...args: PyValue[]) => {
      let items: PyValue[];

      if (args.length === 1 && (args[0].type === 'list' || args[0].type === 'tuple')) {
        items = args[0].items;
      } else {
        items = args;
      }

      if (items.length === 0) {
        throw new ValueError("min() arg is an empty sequence");
      }

      return items.reduce((min, item) => {
        if ((min.type === 'int' || min.type === 'float') && (item.type === 'int' || item.type === 'float')) {
          return item.value < min.value ? item : min;
        }
        if (min.type === 'str' && item.type === 'str') {
          return item.value < min.value ? item : min;
        }
        return min;
      });
    }),

    max: builtin('max', (...args: PyValue[]) => {
      let items: PyValue[];

      if (args.length === 1 && (args[0].type === 'list' || args[0].type === 'tuple')) {
        items = args[0].items;
      } else {
        items = args;
      }

      if (items.length === 0) {
        throw new ValueError("max() arg is an empty sequence");
      }

      return items.reduce((max, item) => {
        if ((max.type === 'int' || max.type === 'float') && (item.type === 'int' || item.type === 'float')) {
          return item.value > max.value ? item : max;
        }
        if (max.type === 'str' && item.type === 'str') {
          return item.value > max.value ? item : max;
        }
        return max;
      });
    }),

    sum: builtin('sum', (iterable: PyValue, start?: PyValue) => {
      let total = start?.type === 'int' ? start.value : (start?.type === 'float' ? start.value : 0);
      let isFloat = start?.type === 'float';

      if (iterable.type === 'list' || iterable.type === 'tuple') {
        for (const item of iterable.items) {
          if (item.type === 'int') {
            total += item.value;
          } else if (item.type === 'float') {
            total += item.value;
            isFloat = true;
          } else {
            throw new TypeError(`unsupported operand type(s) for +: 'int' and '${item.type}'`);
          }
        }
      }

      return isFloat ? pyFloat(total) : pyInt(total);
    }),

    // === Type checking ===
    type: builtin('type', (x: PyValue) => {
      const typeClass = {
        type: 'class' as const,
        name: x.type === 'NoneType' ? 'NoneType' : x.type,
        bases: [],
        methods: new Map(),
        attributes: new Map()
      };
      return typeClass;
    }),

    isinstance: builtin('isinstance', (obj: PyValue, classInfo: PyValue) => {
      if (classInfo.type === 'class') {
        if (obj.type === 'instance') {
          return pyBool(obj.__class__.name === classInfo.name);
        }
        // Check built-in types
        const typeMap: { [key: string]: string } = {
          'int': 'int',
          'float': 'float',
          'str': 'str',
          'bool': 'bool',
          'list': 'list',
          'tuple': 'tuple',
          'dict': 'dict',
          'set': 'set'
        };
        return pyBool(typeMap[classInfo.name] === obj.type);
      }
      return pyBool(false);
    }),

    // === Math ===
    abs: builtin('abs', (x: PyValue) => {
      if (x.type === 'int') return pyInt(Math.abs(x.value));
      if (x.type === 'float') return pyFloat(Math.abs(x.value));
      throw new TypeError(`bad operand type for abs(): '${x.type}'`);
    }),

    round: builtin('round', (x: PyValue, ndigits?: PyValue) => {
      if (x.type !== 'int' && x.type !== 'float') {
        throw new TypeError(`type ${x.type} doesn't define __round__ method`);
      }

      const n = ndigits?.type === 'int' ? ndigits.value : 0;
      const factor = Math.pow(10, n);
      const rounded = Math.round(x.value * factor) / factor;

      if (ndigits === undefined) {
        return pyInt(Math.round(x.value));
      }

      return pyFloat(rounded);
    }),

    pow: builtin('pow', (base: PyValue, exp: PyValue, mod?: PyValue) => {
      if ((base.type !== 'int' && base.type !== 'float') ||
          (exp.type !== 'int' && exp.type !== 'float')) {
        throw new TypeError('pow() requires numeric arguments');
      }

      let result = Math.pow(base.value, exp.value);

      if (mod !== undefined) {
        if (mod.type !== 'int') {
          throw new TypeError('pow() 3rd argument must be integer');
        }
        result = result % mod.value;
      }

      if (base.type === 'int' && exp.type === 'int' && exp.value >= 0 && (mod === undefined || mod.type === 'int')) {
        return pyInt(result);
      }

      return pyFloat(result);
    }),

    divmod: builtin('divmod', (a: PyValue, b: PyValue) => {
      if ((a.type !== 'int' && a.type !== 'float') ||
          (b.type !== 'int' && b.type !== 'float')) {
        throw new TypeError('divmod() requires numeric arguments');
      }

      const quotient = Math.floor(a.value / b.value);
      const remainder = a.value % b.value;

      return pyTuple([
        a.type === 'float' || b.type === 'float' ? pyFloat(quotient) : pyInt(quotient),
        a.type === 'float' || b.type === 'float' ? pyFloat(remainder) : pyInt(remainder)
      ]);
    }),

    // === Other utilities ===
    repr: builtin('repr', (x: PyValue) => {
      return pyStr(pyRepr(x));
    }),

    id: builtin('id', (x: PyValue) => {
      // Generate a unique-ish ID based on the value
      const hash = pyValueToString(x).split('').reduce((a, b) => {
        a = ((a << 5) - a) + b.charCodeAt(0);
        return a & a;
      }, 0);
      return pyInt(Math.abs(hash));
    }),

    hash: builtin('hash', (x: PyValue) => {
      if (x.type === 'list' || x.type === 'dict' || x.type === 'set') {
        throw new TypeError(`unhashable type: '${x.type}'`);
      }

      const str = pyValueToString(x);
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return pyInt(hash);
    }),

    callable: builtin('callable', (x: PyValue) => {
      return pyBool(x.type === 'function' || x.type === 'class');
    }),

    ord: builtin('ord', (c: PyValue) => {
      if (c.type !== 'str' || c.value.length !== 1) {
        throw new TypeError("ord() expected a character");
      }
      return pyInt(c.value.charCodeAt(0));
    }),

    chr: builtin('chr', (i: PyValue) => {
      if (i.type !== 'int') {
        throw new TypeError("an integer is required");
      }
      if (i.value < 0 || i.value > 0x10FFFF) {
        throw new ValueError("chr() arg not in range(0x110000)");
      }
      return pyStr(String.fromCodePoint(i.value));
    }),

    hex: builtin('hex', (x: PyValue) => {
      if (x.type !== 'int') {
        throw new TypeError("'hex' requires integer argument");
      }
      const prefix = x.value < 0 ? '-0x' : '0x';
      return pyStr(prefix + Math.abs(x.value).toString(16));
    }),

    bin: builtin('bin', (x: PyValue) => {
      if (x.type !== 'int') {
        throw new TypeError("'bin' requires integer argument");
      }
      const prefix = x.value < 0 ? '-0b' : '0b';
      return pyStr(prefix + Math.abs(x.value).toString(2));
    }),

    oct: builtin('oct', (x: PyValue) => {
      if (x.type !== 'int') {
        throw new TypeError("'oct' requires integer argument");
      }
      const prefix = x.value < 0 ? '-0o' : '0o';
      return pyStr(prefix + Math.abs(x.value).toString(8));
    }),

    any: builtin('any', (iterable: PyValue) => {
      if (iterable.type === 'list' || iterable.type === 'tuple') {
        return pyBool(iterable.items.some(item => pyTruthy(item)));
      }
      throw new TypeError(`'${iterable.type}' object is not iterable`);
    }),

    all: builtin('all', (iterable: PyValue) => {
      if (iterable.type === 'list' || iterable.type === 'tuple') {
        return pyBool(iterable.items.every(item => pyTruthy(item)));
      }
      throw new TypeError(`'${iterable.type}' object is not iterable`);
    }),

    map: builtin('map', (func: PyValue, ...iterables: PyValue[]) => {
      if (func.type !== 'function') {
        throw new TypeError("'map' requires a callable");
      }

      const arrays = iterables.map(it => {
        if (it.type === 'list' || it.type === 'tuple') return it.items;
        if (it.type === 'str') return [...it.value].map(c => pyStr(c));
        throw new TypeError(`'${it.type}' object is not iterable`);
      });

      const minLen = Math.min(...arrays.map(a => a.length));
      const result: PyValue[] = [];

      for (let i = 0; i < minLen; i++) {
        const args = arrays.map(a => a[i]);
        result.push(interpreter.call(func, args));
      }

      return pyList(result);
    }),

    filter: builtin('filter', (func: PyValue, iterable: PyValue) => {
      let items: PyValue[];

      if (iterable.type === 'list' || iterable.type === 'tuple') {
        items = iterable.items;
      } else if (iterable.type === 'str') {
        items = [...iterable.value].map(c => pyStr(c));
      } else {
        throw new TypeError(`'${iterable.type}' object is not iterable`);
      }

      const result = items.filter(item => {
        if (func.type === 'NoneType') {
          return pyTruthy(item);
        }
        if (func.type !== 'function') {
          throw new TypeError("'filter' requires a callable or None");
        }
        return pyTruthy(interpreter.call(func, [item]));
      });

      return pyList(result);
    }),

    // === Help and info ===
    help: builtin('help', (obj?: PyValue) => {
      if (!obj) {
        interpreter.print("Welcome to Python help!");
        interpreter.print("Type help(object) for help about an object.");
        interpreter.print("");
        interpreter.print("Available modules:");
        interpreter.print("  math, random, datetime, json, os, sys, string");
        interpreter.print("");
        interpreter.print("Built-in functions:");
        interpreter.print("  print, len, range, type, str, int, float, bool, list, dict, tuple, set");
        interpreter.print("  abs, max, min, sum, sorted, reversed, enumerate, zip, map, filter");
        interpreter.print("  input, open, round, pow, divmod, bin, hex, oct, ord, chr, repr");
        return pyNone();
      }

      // Handle invalid/undefined objects
      if (!obj.type) {
        interpreter.print("Help on unknown object:");
        interpreter.print("  No documentation available.");
        return pyNone();
      }

      if (obj.type === 'function') {
        interpreter.print(`Help on function ${obj.name}:`);
        interpreter.print(`  ${obj.name}(...)`);
        if (obj.isBuiltin) {
          interpreter.print(`  Built-in function`);
        }
      } else if (obj.type === 'class') {
        interpreter.print(`Help on class ${obj.name}:`);
        interpreter.print(`  class ${obj.name}`);
        if ((obj as any).methods) {
          interpreter.print(`  Methods:`);
          for (const [name] of (obj as any).methods) {
            interpreter.print(`    ${name}(...)`);
          }
        }
      } else if (obj.type === 'module') {
        interpreter.print(`Help on module '${obj.name}':`);
        interpreter.print("");
        interpreter.print("NAME");
        interpreter.print(`    ${obj.name}`);
        interpreter.print("");

        // List all functions and attributes in the module
        if (obj.exports && obj.exports.size > 0) {
          const functions: string[] = [];
          const constants: string[] = [];
          const submodules: string[] = [];

          for (const [name, value] of obj.exports) {
            if (value.type === 'function') {
              functions.push(name);
            } else if (value.type === 'module') {
              submodules.push(name);
            } else {
              constants.push(name);
            }
          }

          if (functions.length > 0) {
            interpreter.print("FUNCTIONS");
            for (const name of functions.sort()) {
              interpreter.print(`    ${name}(...)`);
            }
            interpreter.print("");
          }

          if (submodules.length > 0) {
            interpreter.print("SUBMODULES");
            for (const name of submodules.sort()) {
              interpreter.print(`    ${name}`);
            }
            interpreter.print("");
          }

          if (constants.length > 0) {
            interpreter.print("DATA");
            for (const name of constants.sort()) {
              interpreter.print(`    ${name}`);
            }
            interpreter.print("");
          }
        }
      } else if (obj.type === 'str') {
        interpreter.print("Help on class str:");
        interpreter.print("  str(object='') -> str");
        interpreter.print("");
        interpreter.print("Methods:");
        interpreter.print("  upper(), lower(), strip(), split(), join(), replace()");
        interpreter.print("  startswith(), endswith(), find(), count(), format()");
        interpreter.print("  isalpha(), isdigit(), isalnum(), isspace()");
      } else if (obj.type === 'list') {
        interpreter.print("Help on class list:");
        interpreter.print("  list(iterable=()) -> list");
        interpreter.print("");
        interpreter.print("Methods:");
        interpreter.print("  append(x), extend(iterable), insert(i, x), remove(x)");
        interpreter.print("  pop([i]), clear(), index(x), count(x), sort(), reverse(), copy()");
      } else if (obj.type === 'dict') {
        interpreter.print("Help on class dict:");
        interpreter.print("  dict(**kwargs) -> dict");
        interpreter.print("");
        interpreter.print("Methods:");
        interpreter.print("  keys(), values(), items(), get(key[, default])");
        interpreter.print("  pop(key[, default]), update(dict), clear(), copy()");
      } else {
        interpreter.print(`Help on ${obj.type} object:`);
        interpreter.print(`  Type: ${obj.type}`);
        if (obj.type === 'int' || obj.type === 'float') {
          interpreter.print(`  Value: ${(obj as any).value}`);
        }
      }

      return pyNone();
    }),

    dir: builtin('dir', (obj?: PyValue) => {
      const attrs: PyValue[] = [];

      if (!obj) {
        // Return current scope variables
        interpreter.getEnvironment().scope.getLocals().forEach((_, name) => {
          attrs.push(pyStr(name));
        });
      } else if (obj.type === 'instance') {
        obj.attributes.forEach((_, name) => attrs.push(pyStr(name)));
        obj.__class__.methods.forEach((_, name) => attrs.push(pyStr(name)));
      } else if (obj.type === 'class') {
        obj.methods.forEach((_, name) => attrs.push(pyStr(name)));
        obj.attributes.forEach((_, name) => attrs.push(pyStr(name)));
      }

      return pyList(attrs);
    }),

    // === Exit ===
    exit: builtin('exit', (code?: PyValue) => {
      throw new Error('SystemExit');
    }),

    quit: builtin('quit', () => {
      throw new Error('SystemExit');
    }),

    // Format
    format: builtin('format', (value: PyValue, formatSpec?: PyValue) => {
      const spec = formatSpec?.type === 'str' ? formatSpec.value : '';

      if (value.type === 'int' || value.type === 'float') {
        if (spec === '') return pyStr(String(value.value));
        if (spec.endsWith('d')) return pyStr(Math.floor(value.value).toString());
        if (spec.endsWith('f')) {
          const precision = parseInt(spec.slice(1, -1)) || 6;
          return pyStr(value.value.toFixed(precision));
        }
        if (spec.endsWith('e')) return pyStr(value.value.toExponential());
        if (spec.endsWith('x')) return pyStr(Math.floor(value.value).toString(16));
        if (spec.endsWith('b')) return pyStr(Math.floor(value.value).toString(2));
        if (spec.endsWith('o')) return pyStr(Math.floor(value.value).toString(8));
      }

      return pyStr(pyStr_value(value));
    }),

    // Input iterator
    iter: builtin('iter', (obj: PyValue) => {
      // Return a list iterator representation
      if (obj.type === 'list' || obj.type === 'tuple') {
        return obj;
      }
      if (obj.type === 'str') {
        return pyList([...obj.value].map(c => pyStr(c)));
      }
      throw new TypeError(`'${obj.type}' object is not iterable`);
    }),

    next: builtin('next', (iterator: PyValue, defaultVal?: PyValue) => {
      if (iterator.type === 'list' && iterator.items.length > 0) {
        return iterator.items.shift()!;
      }
      if (defaultVal !== undefined) {
        return defaultVal;
      }
      throw new StopIteration();
    }),

    // Getattr/setattr
    getattr: builtin('getattr', (obj: PyValue, name: PyValue, defaultVal?: PyValue) => {
      if (name.type !== 'str') {
        throw new TypeError("attribute name must be string");
      }

      try {
        return interpreter.getAttribute(obj, name.value);
      } catch (e) {
        if (defaultVal !== undefined) {
          return defaultVal;
        }
        throw e;
      }
    }),

    hasattr: builtin('hasattr', (obj: PyValue, name: PyValue) => {
      if (name.type !== 'str') {
        throw new TypeError("attribute name must be string");
      }

      try {
        interpreter.getAttribute(obj, name.value);
        return pyBool(true);
      } catch (e) {
        return pyBool(false);
      }
    }),

    // Slice object
    slice: builtin('slice', (...args: PyValue[]) => {
      let start: number | null = null;
      let stop: number | null = null;
      let step: number | null = null;

      if (args.length === 1) {
        stop = args[0].type === 'int' ? args[0].value : null;
      } else if (args.length === 2) {
        start = args[0].type === 'int' ? args[0].value : null;
        stop = args[1].type === 'int' ? args[1].value : null;
      } else if (args.length >= 3) {
        start = args[0].type === 'int' ? args[0].value : null;
        stop = args[1].type === 'int' ? args[1].value : null;
        step = args[2].type === 'int' ? args[2].value : null;
      }

      return {
        type: 'slice' as const,
        start,
        stop,
        step
      } as any;
    }),

    // Exec and eval (limited)
    eval: builtin('eval', (code: PyValue) => {
      if (code.type !== 'str') {
        throw new TypeError("eval() arg must be a string");
      }

      // Use static imports from top of file
      const tokens = new Lexer(code.value).tokenize();
      const parser = new Parser(tokens);
      const ast = parser.parseSingle();

      if (ast) {
        return interpreter.evaluate(ast);
      }

      return pyNone();
    }),

    // Globals/locals
    globals: builtin('globals', () => {
      const result = pyDict();
      interpreter.getEnvironment().scope.getGlobals().getLocals().forEach((value, name) => {
        result.entries.set(`"${name}"`, value);
        result.keyObjects.set(`"${name}"`, pyStr(name));
      });
      return result;
    }),

    locals: builtin('locals', () => {
      const result = pyDict();
      interpreter.getEnvironment().scope.getLocals().forEach((value, name) => {
        result.entries.set(`"${name}"`, value);
        result.keyObjects.set(`"${name}"`, pyStr(name));
      });
      return result;
    }),

    // Vars
    vars: builtin('vars', (obj?: PyValue) => {
      if (!obj) {
        // Return locals
        const result = pyDict();
        interpreter.getEnvironment().scope.getLocals().forEach((value, name) => {
          result.entries.set(`"${name}"`, value);
          result.keyObjects.set(`"${name}"`, pyStr(name));
        });
        return result;
      }

      if (obj.type === 'instance') {
        const result = pyDict();
        obj.attributes.forEach((value, name) => {
          result.entries.set(`"${name}"`, value);
          result.keyObjects.set(`"${name}"`, pyStr(name));
        });
        return result;
      }

      throw new TypeError(`vars() argument must have __dict__ attribute`);
    }),
  };
}

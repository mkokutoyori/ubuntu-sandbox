/**
 * Python Type Methods - Methods for built-in types
 */

import {
  PyValue, PyFunction, PyStr, PyList, PyDict,
  pyInt, pyFloat, pyStr, pyBool, pyNone, pyList, pyTuple,
  pyRepr, pyStr_value, pyValueToString
} from '../types';

import { TypeError, ValueError, IndexError, KeyError } from '../errors';

// Helper to create a method
function method(name: string, fn: (...args: PyValue[]) => PyValue): PyFunction {
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

// === String Methods ===

export function getStringMethod(str: PyStr, name: string, interpreter: any): PyFunction | null {
  const value = str.value;

  switch (name) {
    case 'upper':
      return method('upper', () => pyStr(value.toUpperCase()));

    case 'lower':
      return method('lower', () => pyStr(value.toLowerCase()));

    case 'capitalize':
      return method('capitalize', () =>
        pyStr(value.charAt(0).toUpperCase() + value.slice(1).toLowerCase())
      );

    case 'title':
      return method('title', () =>
        pyStr(value.replace(/\w\S*/g, txt =>
          txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase()
        ))
      );

    case 'swapcase':
      return method('swapcase', () =>
        pyStr([...value].map(c =>
          c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()
        ).join(''))
      );

    case 'strip':
      return method('strip', (chars?: PyValue) => {
        if (chars && chars.type === 'str') {
          const regex = new RegExp(`^[${chars.value}]+|[${chars.value}]+$`, 'g');
          return pyStr(value.replace(regex, ''));
        }
        return pyStr(value.trim());
      });

    case 'lstrip':
      return method('lstrip', (chars?: PyValue) => {
        if (chars && chars.type === 'str') {
          const regex = new RegExp(`^[${chars.value}]+`);
          return pyStr(value.replace(regex, ''));
        }
        return pyStr(value.trimStart());
      });

    case 'rstrip':
      return method('rstrip', (chars?: PyValue) => {
        if (chars && chars.type === 'str') {
          const regex = new RegExp(`[${chars.value}]+$`);
          return pyStr(value.replace(regex, ''));
        }
        return pyStr(value.trimEnd());
      });

    case 'split':
      return method('split', (sep?: PyValue, maxsplit?: PyValue) => {
        const separator = sep?.type === 'str' ? sep.value : undefined;
        const max = maxsplit?.type === 'int' ? maxsplit.value : -1;

        let parts: string[];
        if (separator === undefined) {
          parts = value.split(/\s+/).filter(s => s);
        } else {
          parts = value.split(separator);
        }

        if (max >= 0 && parts.length > max + 1) {
          parts = [...parts.slice(0, max), parts.slice(max).join(separator || ' ')];
        }

        return pyList(parts.map(p => pyStr(p)));
      });

    case 'rsplit':
      return method('rsplit', (sep?: PyValue, maxsplit?: PyValue) => {
        const separator = sep?.type === 'str' ? sep.value : undefined;
        const max = maxsplit?.type === 'int' ? maxsplit.value : -1;

        let parts: string[];
        if (separator === undefined) {
          parts = value.split(/\s+/).filter(s => s);
        } else {
          parts = value.split(separator);
        }

        if (max >= 0 && parts.length > max + 1) {
          const splitIdx = parts.length - max;
          parts = [parts.slice(0, splitIdx).join(separator || ' '), ...parts.slice(splitIdx)];
        }

        return pyList(parts.map(p => pyStr(p)));
      });

    case 'splitlines':
      return method('splitlines', (keepends?: PyValue) => {
        const keep = keepends?.type === 'bool' ? keepends.value : false;
        const lines = value.split(/(\r\n|\n|\r)/);
        const result: string[] = [];

        for (let i = 0; i < lines.length; i += 2) {
          if (keep && i + 1 < lines.length) {
            result.push(lines[i] + lines[i + 1]);
          } else if (lines[i]) {
            result.push(lines[i]);
          }
        }

        return pyList(result.map(l => pyStr(l)));
      });

    case 'join':
      return method('join', (iterable: PyValue) => {
        if (iterable.type === 'list' || iterable.type === 'tuple') {
          const parts = iterable.items.map(item => {
            if (item.type !== 'str') {
              throw new TypeError("sequence item: expected str instance");
            }
            return item.value;
          });
          return pyStr(parts.join(value));
        }
        throw new TypeError(`can only join an iterable`);
      });

    case 'replace':
      return method('replace', (old: PyValue, newStr: PyValue, count?: PyValue) => {
        if (old.type !== 'str' || newStr.type !== 'str') {
          throw new TypeError("replace() requires string arguments");
        }

        const maxCount = count?.type === 'int' ? count.value : -1;

        if (maxCount < 0) {
          return pyStr(value.split(old.value).join(newStr.value));
        }

        let result = value;
        let replaced = 0;
        while (replaced < maxCount && result.includes(old.value)) {
          result = result.replace(old.value, newStr.value);
          replaced++;
        }
        return pyStr(result);
      });

    case 'find':
      return method('find', (sub: PyValue, start?: PyValue, end?: PyValue) => {
        if (sub.type !== 'str') {
          throw new TypeError("find() requires string argument");
        }

        const startIdx = start?.type === 'int' ? start.value : 0;
        const endIdx = end?.type === 'int' ? end.value : value.length;
        const searchIn = value.slice(startIdx, endIdx);
        const idx = searchIn.indexOf(sub.value);

        return pyInt(idx === -1 ? -1 : idx + startIdx);
      });

    case 'rfind':
      return method('rfind', (sub: PyValue, start?: PyValue, end?: PyValue) => {
        if (sub.type !== 'str') {
          throw new TypeError("rfind() requires string argument");
        }

        const startIdx = start?.type === 'int' ? start.value : 0;
        const endIdx = end?.type === 'int' ? end.value : value.length;
        const searchIn = value.slice(startIdx, endIdx);
        const idx = searchIn.lastIndexOf(sub.value);

        return pyInt(idx === -1 ? -1 : idx + startIdx);
      });

    case 'index':
      return method('index', (sub: PyValue, start?: PyValue, end?: PyValue) => {
        if (sub.type !== 'str') {
          throw new TypeError("index() requires string argument");
        }

        const startIdx = start?.type === 'int' ? start.value : 0;
        const endIdx = end?.type === 'int' ? end.value : value.length;
        const searchIn = value.slice(startIdx, endIdx);
        const idx = searchIn.indexOf(sub.value);

        if (idx === -1) {
          throw new ValueError("substring not found");
        }

        return pyInt(idx + startIdx);
      });

    case 'count':
      return method('count', (sub: PyValue, start?: PyValue, end?: PyValue) => {
        if (sub.type !== 'str') {
          throw new TypeError("count() requires string argument");
        }

        const startIdx = start?.type === 'int' ? start.value : 0;
        const endIdx = end?.type === 'int' ? end.value : value.length;
        const searchIn = value.slice(startIdx, endIdx);

        if (sub.value === '') {
          return pyInt(searchIn.length + 1);
        }

        const matches = searchIn.split(sub.value).length - 1;
        return pyInt(matches);
      });

    case 'startswith':
      return method('startswith', (prefix: PyValue, start?: PyValue, end?: PyValue) => {
        if (prefix.type !== 'str' && prefix.type !== 'tuple') {
          throw new TypeError("startswith first arg must be str or tuple");
        }

        const startIdx = start?.type === 'int' ? start.value : 0;
        const endIdx = end?.type === 'int' ? end.value : value.length;
        const searchIn = value.slice(startIdx, endIdx);

        if (prefix.type === 'tuple') {
          return pyBool(prefix.items.some(p =>
            p.type === 'str' && searchIn.startsWith(p.value)
          ));
        }

        return pyBool(searchIn.startsWith(prefix.value));
      });

    case 'endswith':
      return method('endswith', (suffix: PyValue, start?: PyValue, end?: PyValue) => {
        if (suffix.type !== 'str' && suffix.type !== 'tuple') {
          throw new TypeError("endswith first arg must be str or tuple");
        }

        const startIdx = start?.type === 'int' ? start.value : 0;
        const endIdx = end?.type === 'int' ? end.value : value.length;
        const searchIn = value.slice(startIdx, endIdx);

        if (suffix.type === 'tuple') {
          return pyBool(suffix.items.some(s =>
            s.type === 'str' && searchIn.endsWith(s.value)
          ));
        }

        return pyBool(searchIn.endsWith(suffix.value));
      });

    case 'isdigit':
      return method('isdigit', () => pyBool(value.length > 0 && /^\d+$/.test(value)));

    case 'isalpha':
      return method('isalpha', () => pyBool(value.length > 0 && /^[a-zA-Z]+$/.test(value)));

    case 'isalnum':
      return method('isalnum', () => pyBool(value.length > 0 && /^[a-zA-Z0-9]+$/.test(value)));

    case 'isspace':
      return method('isspace', () => pyBool(value.length > 0 && /^\s+$/.test(value)));

    case 'isupper':
      return method('isupper', () =>
        pyBool(value.length > 0 && value === value.toUpperCase() && /[A-Z]/.test(value))
      );

    case 'islower':
      return method('islower', () =>
        pyBool(value.length > 0 && value === value.toLowerCase() && /[a-z]/.test(value))
      );

    case 'istitle':
      return method('istitle', () => {
        const words = value.split(/\s+/);
        return pyBool(
          words.length > 0 &&
          words.every(w => w.length === 0 || (w[0] === w[0].toUpperCase() && w.slice(1) === w.slice(1).toLowerCase()))
        );
      });

    case 'isnumeric':
      return method('isnumeric', () => pyBool(value.length > 0 && /^[0-9]+$/.test(value)));

    case 'isdecimal':
      return method('isdecimal', () => pyBool(value.length > 0 && /^[0-9]+$/.test(value)));

    case 'isidentifier':
      return method('isidentifier', () =>
        pyBool(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value))
      );

    case 'center':
      return method('center', (width: PyValue, fillchar?: PyValue) => {
        if (width.type !== 'int') {
          throw new TypeError("'center' requires integer width");
        }
        const fill = fillchar?.type === 'str' ? fillchar.value[0] : ' ';
        const padding = width.value - value.length;
        if (padding <= 0) return str;
        const leftPad = Math.floor(padding / 2);
        const rightPad = padding - leftPad;
        return pyStr(fill.repeat(leftPad) + value + fill.repeat(rightPad));
      });

    case 'ljust':
      return method('ljust', (width: PyValue, fillchar?: PyValue) => {
        if (width.type !== 'int') {
          throw new TypeError("'ljust' requires integer width");
        }
        const fill = fillchar?.type === 'str' ? fillchar.value[0] : ' ';
        return pyStr(value.padEnd(width.value, fill));
      });

    case 'rjust':
      return method('rjust', (width: PyValue, fillchar?: PyValue) => {
        if (width.type !== 'int') {
          throw new TypeError("'rjust' requires integer width");
        }
        const fill = fillchar?.type === 'str' ? fillchar.value[0] : ' ';
        return pyStr(value.padStart(width.value, fill));
      });

    case 'zfill':
      return method('zfill', (width: PyValue) => {
        if (width.type !== 'int') {
          throw new TypeError("'zfill' requires integer width");
        }
        if (value.length >= width.value) return str;
        const sign = value[0] === '-' || value[0] === '+' ? value[0] : '';
        const rest = sign ? value.slice(1) : value;
        return pyStr(sign + rest.padStart(width.value - sign.length, '0'));
      });

    case 'format':
      return method('format', (...args: PyValue[]) => {
        let result = value;
        let index = 0;

        // Replace {} with positional arguments
        result = result.replace(/\{(\d*)\}/g, (match, num) => {
          const idx = num === '' ? index++ : parseInt(num);
          if (idx >= args.length) {
            throw new IndexError("tuple index out of range");
          }
          return pyStr_value(args[idx]);
        });

        return pyStr(result);
      });

    case 'encode':
      return method('encode', (encoding?: PyValue) => {
        // Return bytes as a string representation (simplified)
        return pyStr(value);
      });

    default:
      return null;
  }
}

// === List Methods ===

export function getListMethod(list: PyList, name: string, interpreter: any): PyFunction | null {
  const items = list.items;

  switch (name) {
    case 'append':
      return method('append', (item: PyValue) => {
        items.push(item);
        return pyNone();
      });

    case 'extend':
      return method('extend', (iterable: PyValue) => {
        if (iterable.type === 'list' || iterable.type === 'tuple') {
          items.push(...iterable.items);
        } else if (iterable.type === 'str') {
          items.push(...[...iterable.value].map(c => pyStr(c)));
        } else {
          throw new TypeError(`'${iterable.type}' object is not iterable`);
        }
        return pyNone();
      });

    case 'insert':
      return method('insert', (index: PyValue, item: PyValue) => {
        if (index.type !== 'int') {
          throw new TypeError("'int' object cannot be interpreted as an integer");
        }
        let idx = index.value;
        if (idx < 0) idx = Math.max(0, items.length + idx);
        if (idx > items.length) idx = items.length;
        items.splice(idx, 0, item);
        return pyNone();
      });

    case 'remove':
      return method('remove', (item: PyValue) => {
        for (let i = 0; i < items.length; i++) {
          if (pyEqual(items[i], item)) {
            items.splice(i, 1);
            return pyNone();
          }
        }
        throw new ValueError("list.remove(x): x not in list");
      });

    case 'pop':
      return method('pop', (index?: PyValue) => {
        if (items.length === 0) {
          throw new IndexError("pop from empty list");
        }
        let idx = index?.type === 'int' ? index.value : -1;
        if (idx < 0) idx = items.length + idx;
        if (idx < 0 || idx >= items.length) {
          throw new IndexError("pop index out of range");
        }
        return items.splice(idx, 1)[0];
      });

    case 'clear':
      return method('clear', () => {
        items.length = 0;
        return pyNone();
      });

    case 'index':
      return method('index', (item: PyValue, start?: PyValue, end?: PyValue) => {
        const startIdx = start?.type === 'int' ? start.value : 0;
        const endIdx = end?.type === 'int' ? end.value : items.length;

        for (let i = startIdx; i < endIdx && i < items.length; i++) {
          if (pyEqual(items[i], item)) {
            return pyInt(i);
          }
        }
        throw new ValueError("x is not in list");
      });

    case 'count':
      return method('count', (item: PyValue) => {
        let count = 0;
        for (const i of items) {
          if (pyEqual(i, item)) count++;
        }
        return pyInt(count);
      });

    case 'sort':
      return method('sort', (key?: PyValue, reverse?: PyValue) => {
        const rev = reverse?.type === 'bool' ? reverse.value : false;

        items.sort((a, b) => {
          let aVal = a, bVal = b;

          if (key && key.type === 'function') {
            aVal = interpreter.call(key, [a]);
            bVal = interpreter.call(key, [b]);
          }

          let cmp = 0;
          if ((aVal.type === 'int' || aVal.type === 'float') &&
              (bVal.type === 'int' || bVal.type === 'float')) {
            cmp = aVal.value - bVal.value;
          } else if (aVal.type === 'str' && bVal.type === 'str') {
            cmp = aVal.value.localeCompare(bVal.value);
          }

          return rev ? -cmp : cmp;
        });

        return pyNone();
      });

    case 'reverse':
      return method('reverse', () => {
        items.reverse();
        return pyNone();
      });

    case 'copy':
      return method('copy', () => pyList([...items]));

    default:
      return null;
  }
}

// === Dict Methods ===

export function getDictMethod(dict: PyDict, name: string, interpreter: any): PyFunction | null {
  switch (name) {
    case 'keys':
      return method('keys', () => {
        const keys: PyValue[] = [];
        dict.keyObjects.forEach(key => keys.push(key));
        return pyList(keys);
      });

    case 'values':
      return method('values', () => {
        const values: PyValue[] = [];
        dict.entries.forEach(value => values.push(value));
        return pyList(values);
      });

    case 'items':
      return method('items', () => {
        const items: PyValue[] = [];
        dict.entries.forEach((value, keyStr) => {
          const key = dict.keyObjects.get(keyStr)!;
          items.push(pyTuple([key, value]));
        });
        return pyList(items);
      });

    case 'get':
      return method('get', (key: PyValue, defaultVal?: PyValue) => {
        const keyStr = pyValueToString(key);
        if (dict.entries.has(keyStr)) {
          return dict.entries.get(keyStr)!;
        }
        return defaultVal || pyNone();
      });

    case 'setdefault':
      return method('setdefault', (key: PyValue, defaultVal?: PyValue) => {
        const keyStr = pyValueToString(key);
        if (!dict.entries.has(keyStr)) {
          const value = defaultVal || pyNone();
          dict.entries.set(keyStr, value);
          dict.keyObjects.set(keyStr, key);
          return value;
        }
        return dict.entries.get(keyStr)!;
      });

    case 'update':
      return method('update', (other?: PyValue) => {
        if (other && other.type === 'dict') {
          other.entries.forEach((value, keyStr) => {
            dict.entries.set(keyStr, value);
            dict.keyObjects.set(keyStr, other.keyObjects.get(keyStr)!);
          });
        }
        return pyNone();
      });

    case 'pop':
      return method('pop', (key: PyValue, defaultVal?: PyValue) => {
        const keyStr = pyValueToString(key);
        if (dict.entries.has(keyStr)) {
          const value = dict.entries.get(keyStr)!;
          dict.entries.delete(keyStr);
          dict.keyObjects.delete(keyStr);
          return value;
        }
        if (defaultVal !== undefined) {
          return defaultVal;
        }
        throw new KeyError(pyRepr(key));
      });

    case 'popitem':
      return method('popitem', () => {
        if (dict.entries.size === 0) {
          throw new KeyError("'popitem(): dictionary is empty'");
        }
        const lastKey = [...dict.keyObjects.keys()].pop()!;
        const key = dict.keyObjects.get(lastKey)!;
        const value = dict.entries.get(lastKey)!;
        dict.entries.delete(lastKey);
        dict.keyObjects.delete(lastKey);
        return pyTuple([key, value]);
      });

    case 'clear':
      return method('clear', () => {
        dict.entries.clear();
        dict.keyObjects.clear();
        return pyNone();
      });

    case 'copy':
      return method('copy', () => {
        const copy: PyDict = {
          type: 'dict',
          entries: new Map(dict.entries),
          keyObjects: new Map(dict.keyObjects)
        };
        return copy;
      });

    case 'fromkeys':
      return method('fromkeys', (keys: PyValue, value?: PyValue) => {
        const newDict: PyDict = {
          type: 'dict',
          entries: new Map(),
          keyObjects: new Map()
        };

        const defaultValue = value || pyNone();

        if (keys.type === 'list' || keys.type === 'tuple') {
          for (const key of keys.items) {
            const keyStr = pyValueToString(key);
            newDict.entries.set(keyStr, defaultValue);
            newDict.keyObjects.set(keyStr, key);
          }
        }

        return newDict;
      });

    default:
      return null;
  }
}

// === Set Methods ===

export function getSetMethod(set: PySet, name: string, interpreter: any): PyFunction | null {
  switch (name) {
    case 'add':
      return method('add', (item: PyValue) => {
        const itemStr = pyValueToString(item);
        set.items.add(itemStr);
        set.itemObjects.set(itemStr, item);
        return pyNone();
      });

    case 'remove':
      return method('remove', (item: PyValue) => {
        const itemStr = pyValueToString(item);
        if (!set.items.has(itemStr)) {
          throw new KeyError(pyRepr(item));
        }
        set.items.delete(itemStr);
        set.itemObjects.delete(itemStr);
        return pyNone();
      });

    case 'discard':
      return method('discard', (item: PyValue) => {
        const itemStr = pyValueToString(item);
        set.items.delete(itemStr);
        set.itemObjects.delete(itemStr);
        return pyNone();
      });

    case 'pop':
      return method('pop', () => {
        if (set.items.size === 0) {
          throw new KeyError("'pop from an empty set'");
        }
        const first = set.items.values().next().value;
        const item = set.itemObjects.get(first)!;
        set.items.delete(first);
        set.itemObjects.delete(first);
        return item;
      });

    case 'clear':
      return method('clear', () => {
        set.items.clear();
        set.itemObjects.clear();
        return pyNone();
      });

    case 'copy':
      return method('copy', () => {
        const copy: PySet = {
          type: 'set',
          items: new Set(set.items),
          itemObjects: new Map(set.itemObjects)
        };
        return copy;
      });

    case 'union':
      return method('union', (other: PyValue) => {
        const result: PySet = {
          type: 'set',
          items: new Set(set.items),
          itemObjects: new Map(set.itemObjects)
        };

        if (other.type === 'set') {
          other.items.forEach(item => {
            result.items.add(item);
            result.itemObjects.set(item, other.itemObjects.get(item)!);
          });
        }

        return result;
      });

    case 'intersection':
      return method('intersection', (other: PyValue) => {
        const result: PySet = {
          type: 'set',
          items: new Set(),
          itemObjects: new Map()
        };

        if (other.type === 'set') {
          set.items.forEach(item => {
            if (other.items.has(item)) {
              result.items.add(item);
              result.itemObjects.set(item, set.itemObjects.get(item)!);
            }
          });
        }

        return result;
      });

    case 'difference':
      return method('difference', (other: PyValue) => {
        const result: PySet = {
          type: 'set',
          items: new Set(),
          itemObjects: new Map()
        };

        if (other.type === 'set') {
          set.items.forEach(item => {
            if (!other.items.has(item)) {
              result.items.add(item);
              result.itemObjects.set(item, set.itemObjects.get(item)!);
            }
          });
        }

        return result;
      });

    case 'symmetric_difference':
      return method('symmetric_difference', (other: PyValue) => {
        const result: PySet = {
          type: 'set',
          items: new Set(),
          itemObjects: new Map()
        };

        if (other.type === 'set') {
          set.items.forEach(item => {
            if (!other.items.has(item)) {
              result.items.add(item);
              result.itemObjects.set(item, set.itemObjects.get(item)!);
            }
          });
          other.items.forEach(item => {
            if (!set.items.has(item)) {
              result.items.add(item);
              result.itemObjects.set(item, other.itemObjects.get(item)!);
            }
          });
        }

        return result;
      });

    case 'issubset':
      return method('issubset', (other: PyValue) => {
        if (other.type !== 'set') {
          throw new TypeError("'issubset' requires a set");
        }
        for (const item of set.items) {
          if (!other.items.has(item)) {
            return pyBool(false);
          }
        }
        return pyBool(true);
      });

    case 'issuperset':
      return method('issuperset', (other: PyValue) => {
        if (other.type !== 'set') {
          throw new TypeError("'issuperset' requires a set");
        }
        for (const item of other.items) {
          if (!set.items.has(item)) {
            return pyBool(false);
          }
        }
        return pyBool(true);
      });

    case 'isdisjoint':
      return method('isdisjoint', (other: PyValue) => {
        if (other.type !== 'set') {
          throw new TypeError("'isdisjoint' requires a set");
        }
        for (const item of set.items) {
          if (other.items.has(item)) {
            return pyBool(false);
          }
        }
        return pyBool(true);
      });

    default:
      return null;
  }
}

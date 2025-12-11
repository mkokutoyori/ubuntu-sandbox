/**
 * Python JSON Module
 */

import { PyValue, PyModule, PyFunction, pyInt, pyFloat, pyStr, pyBool, pyNone, pyList, pyDict, pyValueToString } from '../types';
import { TypeError, ValueError } from '../errors';

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

// Convert PyValue to JavaScript value for JSON serialization
function pyToJs(value: PyValue): any {
  switch (value.type) {
    case 'int':
    case 'float':
      return value.value;
    case 'str':
      return value.value;
    case 'bool':
      return value.value;
    case 'NoneType':
      return null;
    case 'list':
    case 'tuple':
      return value.items.map(pyToJs);
    case 'dict':
      const obj: any = {};
      value.entries.forEach((v, keyStr) => {
        // Remove quotes from string keys
        const key = keyStr.replace(/^["']|["']$/g, '');
        obj[key] = pyToJs(v);
      });
      return obj;
    default:
      throw new TypeError(`Object of type ${value.type} is not JSON serializable`);
  }
}

// Convert JavaScript value to PyValue
function jsToPy(value: any): PyValue {
  if (value === null) {
    return pyNone();
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? pyInt(value) : pyFloat(value);
  }
  if (typeof value === 'string') {
    return pyStr(value);
  }
  if (typeof value === 'boolean') {
    return pyBool(value);
  }
  if (Array.isArray(value)) {
    return pyList(value.map(jsToPy));
  }
  if (typeof value === 'object') {
    const dict = pyDict();
    for (const [k, v] of Object.entries(value)) {
      const keyStr = `"${k}"`;
      dict.entries.set(keyStr, jsToPy(v));
      dict.keyObjects.set(keyStr, pyStr(k));
    }
    return dict;
  }
  throw new TypeError(`Cannot convert ${typeof value} to Python`);
}

export function getJsonModule(interpreter: any): PyModule {
  const exports = new Map<string, PyValue>();

  exports.set('dumps', func('dumps', (obj: PyValue, ...kwargs: PyValue[]) => {
    try {
      const jsObj = pyToJs(obj);
      // Check for indent kwarg (simplified)
      const indent = kwargs.find(k => k.type === 'int')?.value;
      return pyStr(JSON.stringify(jsObj, null, indent));
    } catch (e: any) {
      throw new TypeError(e.message || 'Object is not JSON serializable');
    }
  }));

  exports.set('loads', func('loads', (s: PyValue) => {
    if (s.type !== 'str') {
      throw new TypeError("the JSON object must be str");
    }
    try {
      const parsed = JSON.parse(s.value);
      return jsToPy(parsed);
    } catch (e: any) {
      throw new ValueError(`JSON decode error: ${e.message}`);
    }
  }));

  exports.set('dump', func('dump', (obj: PyValue, fp: PyValue) => {
    // In browser environment, we can't write to files
    // Just convert to string
    const jsObj = pyToJs(obj);
    const jsonStr = JSON.stringify(jsObj);
    interpreter.print(jsonStr);
    return pyNone();
  }));

  exports.set('load', func('load', (fp: PyValue) => {
    // In browser environment, we can't read from files
    throw new TypeError("json.load() is not supported in this environment");
  }));

  // JSONEncoder and JSONDecoder classes (simplified stubs)
  exports.set('JSONEncoder', {
    type: 'class',
    name: 'JSONEncoder',
    bases: [],
    methods: new Map(),
    attributes: new Map()
  } as any);

  exports.set('JSONDecoder', {
    type: 'class',
    name: 'JSONDecoder',
    bases: [],
    methods: new Map(),
    attributes: new Map()
  } as any);

  // JSONDecodeError
  exports.set('JSONDecodeError', {
    type: 'class',
    name: 'JSONDecodeError',
    bases: [],
    methods: new Map(),
    attributes: new Map()
  } as any);

  return {
    type: 'module',
    name: 'json',
    exports
  };
}

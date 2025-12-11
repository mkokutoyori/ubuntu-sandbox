/**
 * Python String Module
 */

import { PyValue, PyModule, PyFunction, pyStr, pyList, pyNone } from '../types';
import { TypeError } from '../errors';

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

export function getStringModule(interpreter: any): PyModule {
  const exports = new Map<string, PyValue>();

  // String constants
  exports.set('ascii_letters', pyStr('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'));
  exports.set('ascii_lowercase', pyStr('abcdefghijklmnopqrstuvwxyz'));
  exports.set('ascii_uppercase', pyStr('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
  exports.set('digits', pyStr('0123456789'));
  exports.set('hexdigits', pyStr('0123456789abcdefABCDEF'));
  exports.set('octdigits', pyStr('01234567'));
  exports.set('punctuation', pyStr('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'));
  exports.set('whitespace', pyStr(' \t\n\r\x0b\x0c'));
  exports.set('printable', pyStr('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ \t\n\r\x0b\x0c'));

  // capwords function
  exports.set('capwords', func('capwords', (s: PyValue, sep?: PyValue) => {
    if (s.type !== 'str') {
      throw new TypeError("capwords() requires string argument");
    }

    const separator = sep?.type === 'str' ? sep.value : ' ';
    const words = s.value.split(separator);
    const capitalized = words.map(word =>
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    );

    return pyStr(capitalized.join(separator));
  }));

  // Template class (simplified)
  const templateClass = {
    type: 'class' as const,
    name: 'Template',
    bases: [],
    methods: new Map<string, PyFunction>(),
    attributes: new Map<string, PyValue>()
  };

  // Template.substitute
  templateClass.methods.set('substitute', func('substitute', function(this: any, mapping?: PyValue) {
    const template = this.template || '';
    let result = template;

    if (mapping?.type === 'dict') {
      mapping.entries.forEach((value, keyStr) => {
        const key = keyStr.replace(/^["']|["']$/g, '');
        const regex = new RegExp(`\\$${key}|\\$\\{${key}\\}`, 'g');
        result = result.replace(regex, value.type === 'str' ? value.value : String((value as any).value));
      });
    }

    return pyStr(result);
  }));

  // Template.safe_substitute
  templateClass.methods.set('safe_substitute', func('safe_substitute', function(this: any, mapping?: PyValue) {
    const template = this.template || '';
    let result = template;

    if (mapping?.type === 'dict') {
      mapping.entries.forEach((value, keyStr) => {
        const key = keyStr.replace(/^["']|["']$/g, '');
        const regex = new RegExp(`\\$${key}|\\$\\{${key}\\}`, 'g');
        result = result.replace(regex, value.type === 'str' ? value.value : String((value as any).value));
      });
    }

    return pyStr(result);
  }));

  exports.set('Template', templateClass);

  // Formatter class (simplified stub)
  const formatterClass = {
    type: 'class' as const,
    name: 'Formatter',
    bases: [],
    methods: new Map<string, PyFunction>(),
    attributes: new Map<string, PyValue>()
  };

  formatterClass.methods.set('format', func('format', (format_string: PyValue, ...args: PyValue[]) => {
    if (format_string.type !== 'str') {
      throw new TypeError("format() requires string format");
    }

    let result = format_string.value;
    let index = 0;

    result = result.replace(/\{(\d*)\}/g, (match, num) => {
      const idx = num === '' ? index++ : parseInt(num);
      if (idx >= args.length) return match;
      const arg = args[idx];
      return arg.type === 'str' ? arg.value : String((arg as any).value);
    });

    return pyStr(result);
  }));

  formatterClass.methods.set('parse', func('parse', (format_string: PyValue) => {
    if (format_string.type !== 'str') {
      throw new TypeError("parse() requires string format");
    }

    // Simplified parse - return empty list
    return pyList([]);
  }));

  formatterClass.methods.set('get_field', func('get_field', (field_name: PyValue, args: PyValue, kwargs: PyValue) => {
    // Stub implementation
    return pyNone();
  }));

  formatterClass.methods.set('get_value', func('get_value', (key: PyValue, args: PyValue, kwargs: PyValue) => {
    // Stub implementation
    return pyNone();
  }));

  formatterClass.methods.set('check_unused_args', func('check_unused_args', (used_args: PyValue, args: PyValue, kwargs: PyValue) => {
    return pyNone();
  }));

  formatterClass.methods.set('format_field', func('format_field', (value: PyValue, format_spec: PyValue) => {
    if (format_spec.type !== 'str') return value;
    // Simplified formatting
    return pyStr(String((value as any).value));
  }));

  formatterClass.methods.set('convert_field', func('convert_field', (value: PyValue, conversion: PyValue) => {
    return value;
  }));

  exports.set('Formatter', formatterClass);

  return {
    type: 'module',
    name: 'string',
    exports
  };
}

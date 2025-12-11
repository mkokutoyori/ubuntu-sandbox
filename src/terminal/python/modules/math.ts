/**
 * Python Math Module
 */

import { PyValue, PyModule, PyFunction, pyInt, pyFloat, pyBool, pyList, pyNone } from '../types';
import { TypeError, ValueError } from '../errors';

// Helper to create a function
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

export function getMathModule(interpreter: any): PyModule {
  const exports = new Map<string, PyValue>();

  // Constants
  exports.set('pi', pyFloat(Math.PI));
  exports.set('e', pyFloat(Math.E));
  exports.set('tau', pyFloat(Math.PI * 2));
  exports.set('inf', pyFloat(Infinity));
  exports.set('nan', pyFloat(NaN));

  // Number-theoretic functions
  exports.set('ceil', func('ceil', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyInt(Math.ceil(x.value));
  }));

  exports.set('floor', func('floor', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyInt(Math.floor(x.value));
  }));

  exports.set('trunc', func('trunc', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyInt(Math.trunc(x.value));
  }));

  exports.set('fabs', func('fabs', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyFloat(Math.abs(x.value));
  }));

  exports.set('factorial', func('factorial', (x: PyValue) => {
    if (x.type !== 'int' || x.value < 0) {
      throw new ValueError("factorial() only accepts non-negative integers");
    }
    let result = 1;
    for (let i = 2; i <= x.value; i++) {
      result *= i;
    }
    return pyInt(result);
  }));

  exports.set('gcd', func('gcd', (...args: PyValue[]) => {
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);

    if (args.length === 0) return pyInt(0);
    if (args.length === 1) {
      if (args[0].type !== 'int') throw new TypeError("gcd() requires integer arguments");
      return pyInt(Math.abs(args[0].value));
    }

    let result = 0;
    for (const arg of args) {
      if (arg.type !== 'int') throw new TypeError("gcd() requires integer arguments");
      result = gcd(result, Math.abs(arg.value));
    }
    return pyInt(result);
  }));

  exports.set('lcm', func('lcm', (...args: PyValue[]) => {
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
    const lcm = (a: number, b: number): number => Math.abs(a * b) / gcd(a, b);

    if (args.length === 0) return pyInt(1);
    if (args.length === 1) {
      if (args[0].type !== 'int') throw new TypeError("lcm() requires integer arguments");
      return pyInt(Math.abs(args[0].value));
    }

    let result = 1;
    for (const arg of args) {
      if (arg.type !== 'int') throw new TypeError("lcm() requires integer arguments");
      result = lcm(result, arg.value);
    }
    return pyInt(result);
  }));

  // Power and logarithmic functions
  exports.set('sqrt', func('sqrt', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    if (x.value < 0) {
      throw new ValueError("math domain error");
    }
    return pyFloat(Math.sqrt(x.value));
  }));

  exports.set('pow', func('pow', (x: PyValue, y: PyValue) => {
    if ((x.type !== 'int' && x.type !== 'float') ||
        (y.type !== 'int' && y.type !== 'float')) {
      throw new TypeError("must be real number");
    }
    return pyFloat(Math.pow(x.value, y.value));
  }));

  exports.set('exp', func('exp', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyFloat(Math.exp(x.value));
  }));

  exports.set('log', func('log', (x: PyValue, base?: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    if (x.value <= 0) {
      throw new ValueError("math domain error");
    }

    if (base === undefined) {
      return pyFloat(Math.log(x.value));
    }

    if (base.type !== 'int' && base.type !== 'float') {
      throw new TypeError("must be real number");
    }

    return pyFloat(Math.log(x.value) / Math.log(base.value));
  }));

  exports.set('log10', func('log10', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    if (x.value <= 0) {
      throw new ValueError("math domain error");
    }
    return pyFloat(Math.log10(x.value));
  }));

  exports.set('log2', func('log2', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    if (x.value <= 0) {
      throw new ValueError("math domain error");
    }
    return pyFloat(Math.log2(x.value));
  }));

  // Trigonometric functions
  exports.set('sin', func('sin', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyFloat(Math.sin(x.value));
  }));

  exports.set('cos', func('cos', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyFloat(Math.cos(x.value));
  }));

  exports.set('tan', func('tan', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyFloat(Math.tan(x.value));
  }));

  exports.set('asin', func('asin', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    if (x.value < -1 || x.value > 1) {
      throw new ValueError("math domain error");
    }
    return pyFloat(Math.asin(x.value));
  }));

  exports.set('acos', func('acos', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    if (x.value < -1 || x.value > 1) {
      throw new ValueError("math domain error");
    }
    return pyFloat(Math.acos(x.value));
  }));

  exports.set('atan', func('atan', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyFloat(Math.atan(x.value));
  }));

  exports.set('atan2', func('atan2', (y: PyValue, x: PyValue) => {
    if ((y.type !== 'int' && y.type !== 'float') ||
        (x.type !== 'int' && x.type !== 'float')) {
      throw new TypeError("must be real number");
    }
    return pyFloat(Math.atan2(y.value, x.value));
  }));

  // Hyperbolic functions
  exports.set('sinh', func('sinh', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyFloat(Math.sinh(x.value));
  }));

  exports.set('cosh', func('cosh', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyFloat(Math.cosh(x.value));
  }));

  exports.set('tanh', func('tanh', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyFloat(Math.tanh(x.value));
  }));

  // Angular conversion
  exports.set('degrees', func('degrees', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyFloat(x.value * 180 / Math.PI);
  }));

  exports.set('radians', func('radians', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyFloat(x.value * Math.PI / 180);
  }));

  // Special functions
  exports.set('isnan', func('isnan', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyBool(Number.isNaN(x.value));
  }));

  exports.set('isinf', func('isinf', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyBool(!Number.isFinite(x.value) && !Number.isNaN(x.value));
  }));

  exports.set('isfinite', func('isfinite', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    return pyBool(Number.isFinite(x.value));
  }));

  exports.set('copysign', func('copysign', (x: PyValue, y: PyValue) => {
    if ((x.type !== 'int' && x.type !== 'float') ||
        (y.type !== 'int' && y.type !== 'float')) {
      throw new TypeError("must be real number");
    }
    const sign = y.value >= 0 ? 1 : -1;
    return pyFloat(Math.abs(x.value) * sign);
  }));

  exports.set('fmod', func('fmod', (x: PyValue, y: PyValue) => {
    if ((x.type !== 'int' && x.type !== 'float') ||
        (y.type !== 'int' && y.type !== 'float')) {
      throw new TypeError("must be real number");
    }
    return pyFloat(x.value % y.value);
  }));

  exports.set('modf', func('modf', (x: PyValue) => {
    if (x.type !== 'int' && x.type !== 'float') {
      throw new TypeError("must be real number");
    }
    const intPart = Math.trunc(x.value);
    const fracPart = x.value - intPart;
    return pyList([pyFloat(fracPart), pyFloat(intPart)]);
  }));

  exports.set('fsum', func('fsum', (iterable: PyValue) => {
    if (iterable.type !== 'list' && iterable.type !== 'tuple') {
      throw new TypeError("must be iterable");
    }
    let sum = 0;
    for (const item of iterable.items) {
      if (item.type !== 'int' && item.type !== 'float') {
        throw new TypeError("must be real number");
      }
      sum += item.value;
    }
    return pyFloat(sum);
  }));

  exports.set('prod', func('prod', (iterable: PyValue, start?: PyValue) => {
    if (iterable.type !== 'list' && iterable.type !== 'tuple') {
      throw new TypeError("must be iterable");
    }
    let prod = start?.type === 'int' || start?.type === 'float' ? start.value : 1;
    for (const item of iterable.items) {
      if (item.type !== 'int' && item.type !== 'float') {
        throw new TypeError("must be real number");
      }
      prod *= item.value;
    }
    return pyFloat(prod);
  }));

  exports.set('hypot', func('hypot', (...args: PyValue[]) => {
    let sumSq = 0;
    for (const arg of args) {
      if (arg.type !== 'int' && arg.type !== 'float') {
        throw new TypeError("must be real number");
      }
      sumSq += arg.value * arg.value;
    }
    return pyFloat(Math.sqrt(sumSq));
  }));

  exports.set('dist', func('dist', (p: PyValue, q: PyValue) => {
    if ((p.type !== 'list' && p.type !== 'tuple') ||
        (q.type !== 'list' && q.type !== 'tuple')) {
      throw new TypeError("must be sequences");
    }
    if (p.items.length !== q.items.length) {
      throw new ValueError("both points must have the same number of dimensions");
    }
    let sumSq = 0;
    for (let i = 0; i < p.items.length; i++) {
      const pi = p.items[i];
      const qi = q.items[i];
      if ((pi.type !== 'int' && pi.type !== 'float') ||
          (qi.type !== 'int' && qi.type !== 'float')) {
        throw new TypeError("must be real number");
      }
      sumSq += Math.pow(pi.value - qi.value, 2);
    }
    return pyFloat(Math.sqrt(sumSq));
  }));

  return {
    type: 'module',
    name: 'math',
    exports
  };
}

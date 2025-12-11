/**
 * Python Random Module
 */

import { PyValue, PyModule, PyFunction, pyInt, pyFloat, pyBool, pyList, pyNone } from '../types';
import { TypeError, ValueError, IndexError } from '../errors';

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

export function getRandomModule(interpreter: any): PyModule {
  const exports = new Map<string, PyValue>();

  exports.set('random', func('random', () => {
    return pyFloat(Math.random());
  }));

  exports.set('randint', func('randint', (a: PyValue, b: PyValue) => {
    if (a.type !== 'int' || b.type !== 'int') {
      throw new TypeError("randint() requires integer arguments");
    }
    if (a.value > b.value) {
      throw new ValueError("empty range for randint()");
    }
    return pyInt(Math.floor(Math.random() * (b.value - a.value + 1)) + a.value);
  }));

  exports.set('randrange', func('randrange', (...args: PyValue[]) => {
    let start = 0, stop = 0, step = 1;

    if (args.length === 1) {
      if (args[0].type !== 'int') throw new TypeError("randrange() requires integer arguments");
      stop = args[0].value;
    } else if (args.length === 2) {
      if (args[0].type !== 'int' || args[1].type !== 'int') {
        throw new TypeError("randrange() requires integer arguments");
      }
      start = args[0].value;
      stop = args[1].value;
    } else if (args.length >= 3) {
      if (args[0].type !== 'int' || args[1].type !== 'int' || args[2].type !== 'int') {
        throw new TypeError("randrange() requires integer arguments");
      }
      start = args[0].value;
      stop = args[1].value;
      step = args[2].value;
    }

    if (step === 0) {
      throw new ValueError("zero step for randrange()");
    }

    const width = stop - start;
    if ((step > 0 && width <= 0) || (step < 0 && width >= 0)) {
      throw new ValueError("empty range for randrange()");
    }

    const n = Math.ceil(width / step);
    return pyInt(start + step * Math.floor(Math.random() * n));
  }));

  exports.set('uniform', func('uniform', (a: PyValue, b: PyValue) => {
    if ((a.type !== 'int' && a.type !== 'float') ||
        (b.type !== 'int' && b.type !== 'float')) {
      throw new TypeError("uniform() requires numeric arguments");
    }
    return pyFloat(a.value + Math.random() * (b.value - a.value));
  }));

  exports.set('choice', func('choice', (seq: PyValue) => {
    if (seq.type === 'list' || seq.type === 'tuple') {
      if (seq.items.length === 0) {
        throw new IndexError("Cannot choose from an empty sequence");
      }
      const idx = Math.floor(Math.random() * seq.items.length);
      return seq.items[idx];
    }
    if (seq.type === 'str') {
      if (seq.value.length === 0) {
        throw new IndexError("Cannot choose from an empty sequence");
      }
      const idx = Math.floor(Math.random() * seq.value.length);
      return { type: 'str', value: seq.value[idx] };
    }
    throw new TypeError("choice() requires a sequence");
  }));

  exports.set('choices', func('choices', (population: PyValue, ...kwargs: PyValue[]) => {
    if (population.type !== 'list' && population.type !== 'tuple') {
      throw new TypeError("choices() requires a sequence");
    }

    const k = kwargs[0]?.type === 'int' ? kwargs[0].value : 1;
    const result: PyValue[] = [];

    for (let i = 0; i < k; i++) {
      const idx = Math.floor(Math.random() * population.items.length);
      result.push(population.items[idx]);
    }

    return pyList(result);
  }));

  exports.set('shuffle', func('shuffle', (seq: PyValue) => {
    if (seq.type !== 'list') {
      throw new TypeError("shuffle() requires a list");
    }

    // Fisher-Yates shuffle
    for (let i = seq.items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [seq.items[i], seq.items[j]] = [seq.items[j], seq.items[i]];
    }

    return pyNone();
  }));

  exports.set('sample', func('sample', (population: PyValue, k: PyValue) => {
    if (population.type !== 'list' && population.type !== 'tuple') {
      throw new TypeError("sample() requires a sequence");
    }
    if (k.type !== 'int') {
      throw new TypeError("sample() k must be an integer");
    }
    if (k.value > population.items.length) {
      throw new ValueError("Sample larger than population");
    }
    if (k.value < 0) {
      throw new ValueError("Sample size cannot be negative");
    }

    const items = [...population.items];
    const result: PyValue[] = [];

    for (let i = 0; i < k.value; i++) {
      const idx = Math.floor(Math.random() * items.length);
      result.push(items.splice(idx, 1)[0]);
    }

    return pyList(result);
  }));

  exports.set('seed', func('seed', (a?: PyValue) => {
    // JavaScript doesn't support seeding Math.random()
    // This is a no-op for compatibility
    return pyNone();
  }));

  exports.set('gauss', func('gauss', (mu: PyValue, sigma: PyValue) => {
    if ((mu.type !== 'int' && mu.type !== 'float') ||
        (sigma.type !== 'int' && sigma.type !== 'float')) {
      throw new TypeError("gauss() requires numeric arguments");
    }

    // Box-Muller transform
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    return pyFloat(mu.value + sigma.value * z);
  }));

  exports.set('normalvariate', func('normalvariate', (mu: PyValue, sigma: PyValue) => {
    if ((mu.type !== 'int' && mu.type !== 'float') ||
        (sigma.type !== 'int' && sigma.type !== 'float')) {
      throw new TypeError("normalvariate() requires numeric arguments");
    }

    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

    return pyFloat(mu.value + sigma.value * z);
  }));

  exports.set('expovariate', func('expovariate', (lambd: PyValue) => {
    if (lambd.type !== 'int' && lambd.type !== 'float') {
      throw new TypeError("expovariate() requires numeric argument");
    }
    return pyFloat(-Math.log(Math.random()) / lambd.value);
  }));

  exports.set('betavariate', func('betavariate', (alpha: PyValue, beta: PyValue) => {
    if ((alpha.type !== 'int' && alpha.type !== 'float') ||
        (beta.type !== 'int' && beta.type !== 'float')) {
      throw new TypeError("betavariate() requires numeric arguments");
    }

    // Simplified beta distribution using gamma
    const gammaVariate = (a: number) => {
      if (a < 1) {
        return gammaVariate(1 + a) * Math.pow(Math.random(), 1 / a);
      }
      const d = a - 1 / 3;
      const c = 1 / Math.sqrt(9 * d);
      let x, v, u;
      do {
        do {
          x = Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
          v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        u = Math.random();
      } while (u > 1 - 0.0331 * x * x * x * x && Math.log(u) > 0.5 * x * x + d * (1 - v + Math.log(v)));
      return d * v;
    };

    const ga = gammaVariate(alpha.value);
    const gb = gammaVariate(beta.value);
    return pyFloat(ga / (ga + gb));
  }));

  exports.set('getrandbits', func('getrandbits', (k: PyValue) => {
    if (k.type !== 'int') {
      throw new TypeError("getrandbits() requires integer argument");
    }
    if (k.value <= 0) {
      throw new ValueError("number of bits must be greater than zero");
    }

    // Generate random bits
    let result = 0;
    for (let i = 0; i < k.value; i++) {
      result = result * 2 + (Math.random() < 0.5 ? 0 : 1);
    }
    return pyInt(result);
  }));

  return {
    type: 'module',
    name: 'random',
    exports
  };
}

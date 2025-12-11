/**
 * Python Modules - Module registry and loading
 */

import { PyValue, PyModule } from '../types';
import { ModuleNotFoundError } from '../errors';

import { getMathModule } from './math';
import { getRandomModule } from './random';
import { getDatetimeModule } from './datetime';
import { getJsonModule } from './json';
import { getSysModule } from './sys';
import { getOsModule } from './os';
import { getStringModule } from './string';

// Module cache
const moduleCache = new Map<string, PyModule>();

// Module factory functions
const moduleFactories: { [name: string]: (interpreter: any) => PyModule } = {
  'math': getMathModule,
  'random': getRandomModule,
  'datetime': getDatetimeModule,
  'json': getJsonModule,
  'sys': getSysModule,
  'os': getOsModule,
  'os.path': getOsModule,
  'string': getStringModule,
};

export function getModule(name: string, interpreter: any): PyModule {
  // Check cache
  if (moduleCache.has(name)) {
    return moduleCache.get(name)!;
  }

  // Check if module exists
  if (!(name in moduleFactories)) {
    throw new ModuleNotFoundError(name);
  }

  // Create and cache module
  const module = moduleFactories[name](interpreter);
  moduleCache.set(name, module);

  return module;
}

export function clearModuleCache(): void {
  moduleCache.clear();
}

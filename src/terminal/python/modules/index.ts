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

// Modules that don't need filesystem context can be cached globally
const staticModuleCache = new Map<string, PyModule>();
const staticModules = new Set(['math', 'random', 'datetime', 'json', 'string']);

export function getModule(name: string, interpreter: any): PyModule {
  // Check if this is a static module that can be cached
  if (staticModules.has(name) && staticModuleCache.has(name)) {
    return staticModuleCache.get(name)!;
  }

  // Check if module exists
  if (!(name in moduleFactories)) {
    throw new ModuleNotFoundError(name);
  }

  // Create module
  const module = moduleFactories[name](interpreter);

  // Cache static modules only
  if (staticModules.has(name)) {
    staticModuleCache.set(name, module);
  }

  return module;
}

export function clearModuleCache(): void {
  staticModuleCache.clear();
}

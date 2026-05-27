/**
 * Built-in PL/SQL package registration. Importing this module
 * triggers every package's static `register()`, populating the shared
 * `builtinPackageRegistry`. The OracleDatabase imports this file at
 * construction so every fresh instance speaks the full surface.
 */

import { DbmsApplicationInfo } from './DbmsApplicationInfo';
import { DbmsSession } from './DbmsSession';
import { DbmsWorkloadRepository } from './DbmsWorkloadRepository';
import { DbmsResourceManager } from './DbmsResourceManager';
import { DbmsStats } from './DbmsStats';

DbmsApplicationInfo.register();
DbmsSession.register();
DbmsWorkloadRepository.register();
DbmsResourceManager.register();
DbmsStats.register();

export { builtinPackageRegistry, PackageRegistry } from './PackageRegistry';
export type { IPackageRoutine, PackageCallContext } from './PackageRegistry';
export { DbmsApplicationInfo, DbmsSession, DbmsWorkloadRepository, DbmsResourceManager, DbmsStats };

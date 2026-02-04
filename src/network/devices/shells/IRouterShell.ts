/**
 * IRouterShell - Management Plane abstraction for vendor-specific CLI shells
 *
 * Each vendor shell (Cisco IOS, Huawei VRP) implements this interface
 * to provide its own command parsing and output formatting.
 */

import type { Router } from '../Router';

export interface IRouterShell {
  execute(router: Router, command: string, args: string[]): string;
  getOSType(): string;
}

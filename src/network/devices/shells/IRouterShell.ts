/**
 * IRouterShell - Management Plane abstraction for vendor-specific CLI shells
 *
 * Each vendor shell (Cisco IOS, Huawei VRP) implements this interface
 * to provide its own command parsing and output formatting.
 */

import type { Router } from '../Router';

export interface IRouterShell {
  /** Execute a raw CLI command string and return the output */
  execute(router: Router, rawInput: string): string;
  /** Get the OS type identifier */
  getOSType(): string;
  /** Get the current CLI prompt string (e.g. "Router#", "Router(config)#") */
  getPrompt(router: Router): string;
}

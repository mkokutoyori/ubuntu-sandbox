/**
 * ICmdlet — Command pattern interface for PowerShell cmdlets.
 *
 * Every cmdlet is a self-contained class that implements this interface.
 * The CmdletRegistry maps names and aliases to ICmdlet instances at startup.
 * Adding a new cmdlet never requires modifying existing code (Open/Closed Principle).
 */

import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { CmdletContext } from './CmdletContext';

export interface ICmdlet {
  /** Canonical lowercase name (e.g. 'get-content'). */
  readonly name: string;

  /**
   * Additional names that resolve to this cmdlet (all lowercase).
   * e.g. ['cat', 'type', 'gc'] for get-content.
   */
  readonly aliases: readonly string[];

  /**
   * Execute the cmdlet and return a value (or null/void).
   * To write multiple values to the output stream, call ctx.emit() for each.
   * The return value is treated as the pipeline output of this cmdlet.
   */
  execute(ctx: CmdletContext): PSValue;
}

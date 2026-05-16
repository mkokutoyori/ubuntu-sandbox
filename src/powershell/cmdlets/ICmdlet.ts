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
   * Canonical PascalCase display name surfaced by `Get-Command` (e.g.
   * `Get-ChildItem` for the registry key `get-childitem`). Cmdlets with
   * compound nouns or unusual casing (PSDrive, NetIPAddress, CimInstance,
   * ...) should declare this so the discovery view stays consistent
   * without a central naming dictionary. When omitted, Get-Command falls
   * back to a simple per-segment capitalize-first algorithm.
   */
  readonly displayName?: string;

  /** Optional one-line summary surfaced by `Get-Help <Name>` / `Get-Command`. */
  readonly description?: string;

  /** Optional source/module label surfaced by `Get-Command` ("Source"). */
  readonly module?: string;

  /**
   * Execute the cmdlet and return a value (or null/void).
   * To write multiple values to the output stream, call ctx.emit() for each.
   * The return value is treated as the pipeline output of this cmdlet.
   */
  execute(ctx: CmdletContext): PSValue;
}

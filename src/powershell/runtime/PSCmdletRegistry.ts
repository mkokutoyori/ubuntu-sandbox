/**
 * PSCmdletRegistry — Plugin registry for ICmdlet implementations.
 *
 * Maps canonical cmdlet names and aliases → ICmdlet instances.
 * Lookup is always case-insensitive (PowerShell convention).
 *
 * Usage:
 *   const registry = new CmdletRegistry();
 *   registry.register(new WriteHostCmdlet());
 *   registry.registerAll(coreCmdlets());
 *   const cmdlet = registry.resolve('Write-Host'); // case-insensitive
 */

import type { ICmdlet } from '@/powershell/cmdlets/ICmdlet';

export class CmdletRegistry {
  /** name/alias (lowercase) → ICmdlet */
  private readonly map = new Map<string, ICmdlet>();

  /** Register a single cmdlet (and all its aliases). */
  register(cmdlet: ICmdlet): void {
    this.map.set(cmdlet.name.toLowerCase(), cmdlet);
    for (const alias of cmdlet.aliases) {
      this.map.set(alias.toLowerCase(), cmdlet);
    }
  }

  /** Register multiple cmdlets at once. */
  registerAll(cmdlets: ICmdlet[]): void {
    for (const cmdlet of cmdlets) this.register(cmdlet);
  }

  /**
   * Resolve a cmdlet by name or alias (case-insensitive).
   * Returns null if not found, so callers can fall through to native dispatch.
   */
  resolve(name: string): ICmdlet | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }

  /** All registered canonical names (sorted, for Get-Command output). */
  list(): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const cmdlet of this.map.values()) {
      if (!seen.has(cmdlet.name)) {
        seen.add(cmdlet.name);
        names.push(cmdlet.name);
      }
    }
    return names.sort();
  }

  /** All registered cmdlet instances (deduped, for Get-Alias / Get-Command). */
  cmdlets(): ICmdlet[] {
    const seen = new Set<string>();
    const out: ICmdlet[] = [];
    for (const cmdlet of this.map.values()) {
      if (!seen.has(cmdlet.name)) {
        seen.add(cmdlet.name);
        out.push(cmdlet);
      }
    }
    return out;
  }

  /** Total number of registered cmdlet entries (names + aliases). */
  get size(): number {
    return this.map.size;
  }
}

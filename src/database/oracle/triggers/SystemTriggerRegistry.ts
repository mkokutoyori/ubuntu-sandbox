/**
 * SystemTriggerRegistry — catalogue of every database-level event
 * trigger registered through `CREATE TRIGGER … ON DATABASE/SCHEMA`.
 *
 * Holds the SystemTrigger objects and exposes the lookup methods the
 * SystemTriggerExecutor uses on each event. Separate from the
 * existing `storage.getAllTriggers()` (which is dedicated to
 * row-level table triggers) so the two pools stay independent.
 */

import { SystemTrigger, type TriggerEvent } from './SystemTrigger';

export class SystemTriggerRegistry {
  private readonly triggers: SystemTrigger[] = [];

  register(t: SystemTrigger): void {
    const idx = this.triggers.findIndex(x => x.owner === t.owner && x.name === t.name);
    if (idx >= 0) this.triggers.splice(idx, 1);
    this.triggers.push(t);
  }

  drop(owner: string, name: string): boolean {
    const o = owner.toUpperCase(), n = name.toUpperCase();
    const idx = this.triggers.findIndex(x => x.owner === o && x.name === n);
    if (idx < 0) return false;
    this.triggers.splice(idx, 1);
    return true;
  }

  setEnabled(owner: string, name: string, enabled: boolean): boolean {
    const o = owner.toUpperCase(), n = name.toUpperCase();
    const t = this.triggers.find(x => x.owner === o && x.name === n);
    if (!t) return false;
    t.enabled = enabled;
    return true;
  }

  /** Triggers matching an event (for the executor to fire). */
  matching(event: TriggerEvent, username?: string): SystemTrigger[] {
    return this.triggers.filter(t => t.matches(event, username));
  }

  /** Full snapshot — used by DBA_TRIGGERS' system-trigger rows. */
  list(): readonly SystemTrigger[] { return this.triggers; }

  byName(owner: string, name: string): SystemTrigger | undefined {
    const o = owner.toUpperCase(), n = name.toUpperCase();
    return this.triggers.find(x => x.owner === o && x.name === n);
  }
}

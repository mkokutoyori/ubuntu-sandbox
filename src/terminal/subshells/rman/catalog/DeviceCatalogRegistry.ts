/**
 * DeviceCatalogRegistry — singleton qui mappe un deviceId vers son
 * InMemoryRmanCatalog persistant.
 *
 * Sans ça, chaque session RMAN possédait son propre catalog qui mourait
 * à la `dispose()` : les backups écrits par la session #1 disparaissaient
 * pour la session #2, ce qui rendait les scénarios "shutdown → mount →
 * restore" inutilisables.
 *
 * Maintenant : un seul catalog par device (par OracleDatabase, en pratique),
 * que les sessions successives partagent. Le catalog vit aussi longtemps
 * que le device est dans le registre.
 *
 * `removeOracleDatabase(deviceId)` (côté terminal/commands/database.ts)
 * devrait appeler `DeviceCatalogRegistry.dispose(deviceId)` pour libérer
 * proprement le bus interne.
 */

import { InMemoryRmanCatalog } from './InMemoryRmanCatalog';

const _catalogs = new Map<string, InMemoryRmanCatalog>();

export const DeviceCatalogRegistry = {
  /** Get-or-create — la même instance pour toute la durée de vie du device. */
  get(deviceId: string): InMemoryRmanCatalog {
    let c = _catalogs.get(deviceId);
    if (!c) {
      c = new InMemoryRmanCatalog();
      _catalogs.set(deviceId, c);
    }
    return c;
  },

  /** Libère le catalog pour un device. Idempotent. */
  dispose(deviceId: string): void {
    const c = _catalogs.get(deviceId);
    if (!c) return;
    c.dispose();
    _catalogs.delete(deviceId);
  },

  /** Visible-for-test : remet le registre à zéro. */
  _reset(): void {
    for (const c of _catalogs.values()) c.dispose();
    _catalogs.clear();
  },

  /** Visible-for-test : count des catalogs en cache. */
  _size(): number { return _catalogs.size; },
};

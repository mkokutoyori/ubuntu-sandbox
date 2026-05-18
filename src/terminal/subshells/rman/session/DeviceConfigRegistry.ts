/**
 * DeviceConfigRegistry — singleton qui mappe un deviceId vers son
 * `RmanConfig` persistant.
 *
 * Même principe que DeviceCatalogRegistry : sans persistance, les
 * `CONFIGURE RETENTION POLICY TO …` ne survivaient pas à la dispose()
 * d'une session, ce qui empêchait toute recette canonique en
 * plusieurs phases (par exemple "backup OPEN → shutdown → MOUNT →
 * restore" où chaque étape ouvre une nouvelle session RMAN).
 *
 * La config persiste pour toute la durée de vie du device. Quand le
 * device est retiré (`removeOracleDatabase`), on dispose le registre
 * correspondant.
 */

import { RmanConfig } from './RmanConfig';
import { RedundancyPolicy } from '../policy/RedundancyPolicy';
import type { IRetentionPolicy } from '../policy/IRetentionPolicy';

const _configs = new Map<string, RmanConfig>();

export const DeviceConfigRegistry = {
  /** Get-or-create. La policy/autobackup ne s'appliquent qu'à la création. */
  get(
    deviceId: string,
    initialPolicy: IRetentionPolicy = new RedundancyPolicy(1),
    initialAutobackup = false,
  ): RmanConfig {
    let c = _configs.get(deviceId);
    if (!c) {
      c = new RmanConfig(initialPolicy, initialAutobackup);
      _configs.set(deviceId, c);
    }
    return c;
  },

  /** Libère le slot. Idempotent. */
  dispose(deviceId: string): void {
    _configs.delete(deviceId);
  },

  /** Visible-for-test. */
  _reset(): void { _configs.clear(); },
  _size(): number { return _configs.size; },
};

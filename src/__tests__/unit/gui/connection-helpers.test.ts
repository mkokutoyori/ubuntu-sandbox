/**
 * `connection-helpers` ne porte plus qu'une seule chose : le libellé
 * d'un type de câble. Les trois autres fonctions qu'il exportait —
 * `getAvailableInterfaces`, `getCompatibleConnectionTypes`,
 * `getInterfaceDisplayInfo` — étaient des SECONDES écritures de la règle
 * de disponibilité que `buildInterfaceList` porte pour de bon, sans
 * aucun appelant de production, et elles répondaient toutes les trois
 * « disponible » à une interface virtuelle. Leur couverture vit
 * désormais dans `interface-selector-logic.test.ts`, sur la seule
 * écriture que le sélecteur consulte.
 */

import { describe, it, expect } from 'vitest';
import { getConnectionLabel } from '@/components/network/connection-helpers';

describe('connection-helpers', () => {
  describe('getConnectionLabel', () => {
    it('should return "Ethernet" for ethernet connections', () => {
      expect(getConnectionLabel('ethernet')).toBe('Ethernet');
    });

    it('should return "Serial" for serial connections', () => {
      expect(getConnectionLabel('serial')).toBe('Serial');
    });

    it('should return "Console" for console connections', () => {
      expect(getConnectionLabel('console')).toBe('Console');
    });

    it('should fall back to the raw type for anything else', () => {
      expect(getConnectionLabel('fiber')).toBe('fiber');
    });
  });
});

# Plan: Implémentation d'une classe Connection avec approche TDD

## État d'avancement

| Phase | Statut | Notes |
|-------|--------|-------|
| Phase 1: Tests unitaires EthernetConnection | ✅ DONE | 14 tests passent |
| Phase 2: Implémentation EthernetConnection | ✅ DONE | Classe créée et exportée |
| Phase 3: Tests d'intégration | ⏳ TODO | Prêt à implémenter |
| Phase 4: Modifier le ping pour attendre vraie réponse | ⏳ TODO | |
| Phase 5: Intégrer dans NetworkSimulator | ⏳ TODO | |

---

## Fichiers créés/modifiés

### Créés
- `src/domain/network/EthernetConnection.ts` - Classe principale
- `src/__tests__/unit/network/EthernetConnection.test.ts` - Tests unitaires (14 tests)

### Modifiés  
- `src/domain/devices/types.ts` - Ajout types wifi/fiber, type optionnel
- `src/domain/devices/BaseDevice.ts` - Ajout DeviceTypes manquants
- `src/domain/devices/index.ts` - Export EthernetConnection
- `src/hooks/useNetworkSimulator.ts` - Fix getMACTable return type

---

## Résumé de l'implémentation

### EthernetConnection

La classe `EthernetConnection` implémente l'interface `Connection` et gère activement le transfert de frames entre deux appareils.

**Fonctionnalités:**
- `wireUp()` - Configure les callbacks sur les interfaces
- `unwire()` - Supprime les callbacks
- `activate()/deactivate()` - Active/désactive le transfert
- `addEventListener()/removeEventListener()` - Gestion des événements
- `toJSON()` - Sérialisation vers Connection simple

**Supporte:**
- PC ↔ PC (via NetworkInterface)
- PC ↔ Switch (via receiveFrame/onFrameForward)
- Switch ↔ Switch
- Transfert bidirectionnel

---

## Prochaines étapes

### Phase 3: Tests d'intégration
Créer `src/__tests__/integration/ethernet-connection.integration.test.ts` avec:
1. Test ARP request through connection
2. Test ICMP packets through connection  
3. Test with Switch in the middle
4. Test full ping cycle (request + reply)

### Phase 4: Modifier le ping
Dans `LinuxPC.ts` et `WindowsPC.ts`:
1. Remplacer simulation par attente de vraie réponse
2. Utiliser Promise avec timeout
3. Enregistrer callback pour réponse ICMP

### Phase 5: Intégrer dans NetworkSimulator
Dans `src/core/network/NetworkSimulator.ts`:
1. Créer des EthernetConnection au lieu de mappings
2. Utiliser wireUp() pour établir les connexions
3. Garder compatibilité avec le store

---

## Notes techniques

Les erreurs de build préexistantes dans le projet incluent:
- Tests d'intégration avec mauvais types d'arguments
- Devices sans implémentation de `reset()`
- Conflits `hostname` private vs protected
- Méthodes `getType()` retournant `string` au lieu de `DeviceType`

Ces erreurs ne sont pas liées à l'implémentation d'EthernetConnection.

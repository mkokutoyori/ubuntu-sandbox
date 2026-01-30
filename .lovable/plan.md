
# Plan: Implémentation d'une classe Connection avec approche TDD

## Analyse du problème

Après exploration du code, j'ai identifié plusieurs problèmes interconnectés:

### Problème 1: Le ping simule toujours un succès
Dans `LinuxPC.ts` (lignes 3158-3162), la méthode `sendPing()` **simule** une réponse réussie sans attendre de vraie réponse ICMP:
```text
// Simulate reply (in real implementation would wait for actual reply)
const rtt = Math.random() * 5 + 0.5; // Simulated RTT
output += `64 bytes from ${targetIP.toString()}: icmp_seq=${i + 1}...`;
successCount++;
```

### Probleme 2: L'interface Connection est passive
L'interface `Connection` dans `types.ts` est un simple objet de données (DTO) sans logique de transfert de frames:
```text
interface Connection {
  id: string;
  type: ConnectionType;
  sourceDeviceId: string;
  sourceInterfaceId: string;
  targetDeviceId: string;
  targetInterfaceId: string;
  isActive: boolean;
}
```

### Probleme 3: NetworkSimulator fait le cablage mais de maniere incomplete
Le `NetworkSimulator` cable les appareils mais le ping ne l'utilise pas correctement car il simule les reponses.

---

## Solution proposee

Creer une classe `EthernetConnection` qui implemente l'interface `Connection` et gere activement le transfert de frames entre deux appareils. Cette classe sera responsable de:

1. Transferer les frames d'un appareil a l'autre
2. Emettre des evenements pour la visualisation
3. Supporter l'activation/desactivation de la connexion

---

## Implementation TDD

### Phase 1: Tests unitaires pour EthernetConnection

**Fichier:** `src/__tests__/unit/network/EthernetConnection.test.ts`

Tests a ecrire:
1. `should create connection with valid parameters`
2. `should transfer frame from source to target`
3. `should transfer frame from target to source (bidirectional)`
4. `should not transfer frames when connection is inactive`
5. `should emit events when frames are transferred`
6. `should handle Switch port connections correctly`
7. `should handle PC interface connections correctly`

### Phase 2: Implementation de la classe EthernetConnection

**Fichier:** `src/domain/network/EthernetConnection.ts`

```text
Structure proposee:
+----------------------+
| EthernetConnection   |
+----------------------+
| - id: string         |
| - sourceDevice       |
| - sourceInterface    |
| - targetDevice       |
| - targetInterface    |
| - isActive: boolean  |
+----------------------+
| + transferFrame()    |
| + activate()         |
| + deactivate()       |
| + wireUp()           |
+----------------------+
```

Responsabilites:
- `wireUp()`: Configure les callbacks sur les interfaces des appareils
- `transferFrame(direction, frame)`: Transfere une frame dans une direction
- `activate()/deactivate()`: Active ou desactive la connexion

### Phase 3: Tests d'integration

**Fichier:** `src/__tests__/integration/ethernet-connection.integration.test.ts`

Tests a ecrire:
1. `should transfer ARP request through connection`
2. `should transfer ICMP packets through connection`
3. `should work with Switch in the middle`
4. `should support full ping cycle (request + reply)`

### Phase 4: Modifier le ping pour attendre une vraie reponse

**Fichier:** `src/domain/devices/LinuxPC.ts`

Modifier `sendPing()` pour:
1. Envoyer la requete ICMP
2. Enregistrer un callback pour recevoir la reponse
3. Attendre la reponse ou timeout
4. Retourner succes ou echec selon la reponse recue

### Phase 5: Integrer EthernetConnection dans NetworkSimulator

**Fichier:** `src/core/network/NetworkSimulator.ts`

Modifier pour:
1. Creer des instances `EthernetConnection` au lieu de simples mappings
2. Utiliser ces connexions pour le transfert de frames
3. Garder la compatibilite avec le store existant

---

## Details techniques

### Structure des fichiers a creer/modifier

```text
src/
  domain/
    network/
      EthernetConnection.ts        [NOUVEAU]
  __tests__/
    unit/
      network/
        EthernetConnection.test.ts [NOUVEAU]
    integration/
      ethernet-connection.integration.test.ts [NOUVEAU]
  domain/
    devices/
      LinuxPC.ts                   [MODIFIER]
      WindowsPC.ts                 [MODIFIER]
  core/
    network/
      NetworkSimulator.ts          [MODIFIER]
  domain/
    devices/
      types.ts                     [MODIFIER - export EthernetConnection]
```

### Classe EthernetConnection - Implementation detaillee

```text
class EthernetConnection implements Connection {
  // Proprietes de Connection (interface)
  id: string
  type: ConnectionType
  sourceDeviceId: string
  sourceInterfaceId: string
  targetDeviceId: string
  targetInterfaceId: string
  isActive: boolean

  // Nouvelles proprietes
  private sourceDevice: BaseDevice
  private targetDevice: BaseDevice
  private eventListeners: Set<EventCallback>

  // Methodes
  constructor(config: ConnectionConfig, sourceDevice, targetDevice)
  wireUp(): void
  unwire(): void
  activate(): void
  deactivate(): void
  private handleFrameFromSource(frame): void
  private handleFrameFromTarget(frame): void
  private deliverToDevice(device, interfaceId, frame): void
  addEventListener(callback): void
  removeEventListener(callback): void
}
```

### Modification du ping - Approche asynchrone

Le ping devra:
1. Creer une Promise qui se resoud quand la reponse arrive
2. Utiliser `ICMPService.onEchoReply()` pour capturer les reponses
3. Implementer un timeout avec `Promise.race()`

---

## Ordre d'execution

1. Ecrire les tests unitaires pour `EthernetConnection` (TDD Red)
2. Implementer `EthernetConnection` (TDD Green)
3. Refactorer si necessaire (TDD Refactor)
4. Ecrire les tests d'integration
5. Modifier `NetworkSimulator` pour utiliser `EthernetConnection`
6. Modifier le ping dans `LinuxPC` et `WindowsPC`
7. Executer tous les tests pour validation

---

## Risques et mitigations

| Risque | Mitigation |
|--------|------------|
| Breaking changes dans les tests existants | Garder la retrocompatibilite avec l'interface Connection |
| Performance avec callbacks multiples | Utiliser des Sets pour les listeners, nettoyer les callbacks |
| Complexite du ping asynchrone | Commencer par une version simplifiee avec timeout fixe |

---

## Estimation

- Phase 1-2 (Tests + Implementation EthernetConnection): 1 iteration
- Phase 3-4 (Integration + Modification ping): 1 iteration
- Phase 5 (Integration NetworkSimulator): 1 iteration

Total: 3 iterations de developpement

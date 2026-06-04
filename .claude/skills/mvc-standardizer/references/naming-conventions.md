# Conventions de nommage et d'emplacement

> La standardisation passe par des noms **prévisibles** : si je connais le nom du protocole,
> je dois pouvoir deviner le nom de son VM, de sa projection, de son hook et de ses topics.
> Calque sur OSPF. Code et identifiants **toujours en anglais**.

## Fichiers

| Rôle | Convention | Exemple |
|---|---|---|
| Model / Actor | `<Feature>Engine.ts` (ou nom de domaine) | `OSPFEngine.ts`, `DHCPServer.ts` |
| Projector | `observables.ts` **co-localisé** avec l'engine | `src/network/ospf/observables.ts` |
| Refresh Actor | `<Feature>SignalRefreshActor.ts` ou classe interne `SignalRefreshActor` | `SignalRefreshActor` |
| Hook | `use<Feature>.ts` dans `src/react/hooks/` | `useOspf.ts`, `useDhcp.ts` |
| Hook générique réutilisable | `use<Thing>.ts` | `useEngineSignal.ts`, `useSignal.ts` |
| View | `<Feature>Panel.tsx` / `<Feature>View.tsx` | `NetworkLogsPanel.tsx` |
| Logique de vue (humble) | `<feature>-logic.ts` (kebab-case) | `properties-panel-logic.ts` |
| Tests | miroir sous `src/__tests__/unit/<domaine>/` | `unit/network-v2/ospf.test.ts` |

## Types

| Élément | Convention | Exemple |
|---|---|---|
| View-Model | `<Feature><Entity>VM` (PascalCase, suffixe `VM`) | `OspfNeighborVM`, `OspfRoutesVM`, `DeviceVM` |
| Champs de VM | `readonly`, primitifs / structures simples, **jamais** une instance de domaine | `readonly routerId: string` |
| SignalStore | `<Feature>SignalStore` | `OspfSignalStore` |
| Vue lecture seule | `<Feature>Observables` (interface) + `make<Feature>Observables(store)` | `OspfObservables`, `makeReadonlyObservables` |

## Fonctions

| Élément | Convention | Exemple |
|---|---|---|
| Projection pure | `project<Entity>(domain): <Feature><Entity>VM[]` | `projectNeighbors`, `projectRoutes`, `projectRuntime` |
| Refresh (engine) | `_refresh<Entity>Signal()` (préfixe `_` = interne, piloté par le Refresh Actor) | `_refreshNeighborSignal()` |
| Hook | `use<Feature><Entity>(deviceId)` → renvoie la VM | `useOspfNeighbors(id)` |
| Commande de store | verbe d'action | `addDevice`, `removeConnection`, `moveDevice` |

## Topics de l'EventBus

Format : **`domaine.entité.évènement`** (kebab-case dans le dernier segment si composé).
Hiérarchique, du général au spécifique. Verbe au **passé** pour un fait accompli.

```
port.frame.received          device.registered          host.arp.entry-learned
port.link.up                 device.power-off            host.routing.route-added
cable.frame.delivered        device.position-changed     ospf.neighbor.state-changed
```

Règles :
- **Préfixe = domaine** : `port.`, `cable.`, `device.`, `host.`, `ospf.`, `dhcp.`, `oracle.`…
- Un nouveau protocole introduit son **propre préfixe** (ex. `bgp.`), sans toucher les classes de base (objectif O6).
- Le `payload` est typé dans `src/events/types.ts` via la discriminated union `DomainEvent`. **Ajoute** ton topic là, ne crée pas d'autre canal.
- Pas d'event « fourre-tout » : un topic = un fait précis.

## Emplacement des tests

| Domaine | Dossier |
|---|---|
| Réseau (engines, devices, projections, hooks réseau) | `src/__tests__/unit/network-v2/` |
| Base de données Oracle | `src/__tests__/unit/database/` |
| Logique de composants / GUI | `src/__tests__/unit/gui/` |

Nommage des cas : `test('project<Entity> when <condition> returns <expected>')` ou
`it('refreshes the neighbor signal after a state change')`. Voir le template de tests.

## Anti-noms (à bannir)

- ❌ `data`, `info`, `manager` génériques pour un VM (`OspfData` → `OspfNeighborVM`).
- ❌ un dossier `controllers/`, `viewmodels/` ou `services/` central : on range **par domaine**, le Projector vit avec son Model.
- ❌ `get<Entity>()` sur un engine **exposé à l'UI** : l'UI lit un `Signal`, pas un getter impératif.
- ❌ topics en `camelCase` ou sans préfixe de domaine (`neighborChanged` → `ospf.neighbor.state-changed`).

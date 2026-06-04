# Carte d'architecture — MVC ↔ couches du projet

> Référence détaillée. Le `SKILL.md` donne la vue d'ensemble ; ce fichier donne le glossaire
> précis, la cartographie complète, et la lecture commentée de la référence OSPF.
> Source de vérité du projet : `docs/REFONTE-REACTIVE-EVENT-DRIVEN.md` (§8 surtout).

---

## 1. Glossaire (vocabulaire imposé)

Utiliser **exactement** ces termes dans le code, les commentaires et les commits.

| Terme | Définition | Exemple concret |
|---|---|---|
| **Actor** (Acteur) | Objet de domaine qui détient un état mutable, le mute en réaction à des events, et **publie** ses propres events. Ne s'appelle **jamais** directement un autre Actor. | `OSPFEngine`, `Equipment`, `Port`, `Cable`, `DHCPServer`, `TerminalSession` |
| **EventBus** | Bus typé central. `publish(event)` / `subscribe(topic, handler)`. Dispatch FIFO synchrone, réentrance bornée. | `src/events/EventBus.ts` |
| **Topic** | Identifiant hiérarchique d'event : `domaine.entité.évènement`. | `port.frame.received`, `host.arp.entry-learned`, `device.registered` |
| **Scheduler** | Abstraction unique des timers. `now/setTimeout/setInterval/clear/delay`. Version virtuelle déterministe pour les tests. | `src/events/Scheduler.ts` |
| **Signal** | Conteneur observable d'une valeur ; notifie ses abonnés au changement (`Object.is`). Compatible `useSyncExternalStore`. | `src/events/Signal.ts` (`WritableSignal`, `derived`) |
| **SignalStore** | Bundle de `WritableSignal` **privé** à un engine. Exposé uniquement via une vue lecture seule. | `OspfSignalStore` |
| **VM** (View-Model / read-model) | Vue **dérivée, immuable, sérialisable** de l'état de domaine, destinée à l'UI. Champs `readonly`. Pas de méthode, pas de référence vers le domaine. | `OspfNeighborVM`, `DeviceVM` |
| **Projection** | Fonction **pure** `projectXxx(domainState) → VM[]`. Seule source de vérité « état domaine → VM ». Testable sans monter l'engine. | `projectNeighbors`, `projectRoutes` |
| **Projector** | La couche qui projette : le fichier `observables.ts` (VM + projections + SignalStore) + le `SignalRefreshActor` qui republie après mutation. | `src/network/ospf/observables.ts` |
| **Refresh Actor** | Petit Actor interne qui s'abonne au bus et déclenche `engine._refreshXxxSignal()` après les mutations pertinentes. | `SignalRefreshActor` (OSPF) |
| **Hook** | Fonction React `useXxx` qui lit un `Signal` via `useSyncExternalStore` et rend une VM au composant. | `react/hooks/useOspf.ts`, `useEngineSignal.ts` |
| **Adapter** | Consomme des events et produit un **effet externe** (filesystem, log texte, persistence, animation). N'est pas un Projector. | `adapters/OracleFilesystemSync.ts` |
| **Store** | Le store Zustand : détient la **topologie** + l'état UI, expose les **commandes** (addDevice, addConnection…). C'est le Controller des actions utilisateur. | `src/store/networkStore.ts` |
| **Humble component** | Composant React réduit à la présentation ; toute logique non triviale est extraite dans un `*-logic.ts` pur. | `properties-panel-logic.ts` ↔ `PropertiesPanel.tsx` |

---

## 2. Cartographie complète MVC ↔ dossiers

```
src/
├── network/              ░ MODEL ░ Actors + moteurs de protocole (état mutable, logique)
│   ├── equipment/        │  Equipment (abstrait), EquipmentRegistry
│   ├── hardware/         │  Port, Cable  (couche physique)
│   ├── devices/          │  LinuxPC, CiscoRouter, …  (+ shells, managers)
│   ├── ospf/ rip/ dhcp/  │  moteurs ── CHACUN expose un observables.ts (Projector co-localisé)
│   │   ipsec/ …          │
│   └── core/             │  types de trames/paquets, Logger, RoutingTable
├── database/             ░ MODEL ░ moteur Oracle (Actors SQL)
│
├── events/               ░ NOYAU ░ EventBus · Scheduler · Signal  (les 3 primitives)
│
├── network/**/observables.ts   ░ CONTROLLER ░ Projectors : VM + projectXxx + SignalStore
├── react/hooks/          ░ CONTROLLER ░ hooks de binding (useDevices, useOspf, useEngineSignal…)
├── hooks/                ░ CONTROLLER ░ hooks UI génériques (use-toast, useNetworkLogs…)
├── store/                ░ CONTROLLER ░ networkStore (topologie + commandes), topologySerializer
├── adapters/             ░ CONTROLLER/effets ░ ponts vers effets externes (Oracle FS/systemd sync)
├── components/**/*-logic.ts    ░ CONTROLLER ░ logique de vue extraite (pure, testable)
│
├── components/           ░ VIEW ░ composants React (présentation pure)
│   ├── network/          │  NetworkDesigner, NetworkCanvas, NetworkDevice, PropertiesPanel…
│   ├── terminal/ editors/│
│   └── ui/               │  shadcn/ui
├── pages/                ░ VIEW ░ routes (Index, NotFound)
│
└── __tests__/            ░ TESTS ░ unit/network-v2 · unit/database · unit/gui
```

> ⚠️ **Le Projector vit avec son Model, pas dans un dossier « controllers/ ».** Le projet
> organise **par domaine**, pas par couche technique. `observables.ts` est *à côté* de
> l'engine qu'il projette. Ne crée pas de dossier `controllers/` ou `viewmodels/` central.

---

## 3. Le cycle de vie complet (un changement, de bout en bout)

Exemple : un voisin OSPF passe à l'état `Full`.

1. **Model** : `OSPFEngine` traite un paquet Hello/DBD, mute son état interne (`OSPFInterface.neighbors`), puis `bus.publish({ topic: 'ospf.neighbor.state-changed', … })`.
2. **Refresh Actor** : `SignalRefreshActor` est abonné à ce topic ; il appelle `engine._refreshNeighborSignal()`.
3. **Projection** : `_refreshNeighborSignal()` délègue à la fonction **pure** `projectNeighbors(interfaces)` → `OspfNeighborVM[]`, et fait `signalStore.neighbors.set(vm)`.
4. **Signal** : `WritableSignal.set` compare via `Object.is`, voit une nouvelle référence, notifie ses abonnés.
5. **Hook** : `useOspfNeighbors(deviceId)` (via `useEngineSignal`) est abonné au `Signal` par `useSyncExternalStore` → React reçoit le nouveau snapshot.
6. **View** : le composant se re-rend avec la nouvelle `OspfNeighborVM[]`. Il n'a **jamais** touché `OSPFEngine`.

Aucune étape ne court-circuite la suivante. Aucune flèche ne remonte. C'est ça, le standard.

---

## 4. Lecture commentée de la référence OSPF (le gold standard)

> Avant d'implémenter ou de migrer quoi que ce soit, **lis ces fichiers**. Tu reproduis ce
> moule, tu n'en inventes pas un autre.

### `src/network/ospf/observables.ts` — le Projector
- **VM types** : `OspfNeighborVM`, `OspfInterfaceVM`, `OspfRoutesVM`… → uniquement des champs `readonly`, des primitifs / structures simples. Pas de méthode, pas de `Equipment`.
- **`OspfSignalStore`** : `readonly neighbors = new WritableSignal<…>([])`, etc. C'est l'état réactif **privé** de l'engine.
- **`makeReadonlyObservables(store)`** : renvoie les `Signal<T>` en lecture seule (le type `OspfObservables`). C'est **ça** que l'engine expose en `public readonly observables`.
- **Fonctions `projectXxx(domain): VM[]`** : **pures**, sans effet de bord, sans accès au bus. Elles transforment l'état de domaine en VM. Ce sont les fonctions les plus testées du module.

### `src/network/ospf/OSPFEngine.ts` — l'Actor (Model)
- `private readonly signalStore = new OspfSignalStore();` → le store est **privé**.
- `readonly observables = makeReadonlyObservables(this.signalStore);` → seule surface publique réactive.
- `this.signalRefreshActor = new SignalRefreshActor(bus, this);` → branche la réactivité sur le bus dans le constructeur / au power-on.
- `_refreshNeighborSignal()` etc. → **wrappers minces** : `this.signalStore.neighbors.set(projectNeighbors(this.interfaces.values()))`. Zéro logique de projection ici — tout est délégué aux fonctions pures.
- L'engine **publie** ses events de domaine ; il ne connaît ni React, ni le store, ni un composant.

### `src/react/hooks/useOspf.ts` + `useEngineSignal.ts` — le Controller (binding)
- `useEngineSignal(deviceId, resolve, selectSignal, fallback)` : résout l'engine depuis le `deviceId`, sélectionne le bon `Signal`, s'y abonne via `useSyncExternalStore`, renvoie la VM (ou un fallback stable si l'engine est absent).
- `useOspfNeighbors(id)` etc. : des one-liners au-dessus de `useEngineSignal`. C'est tout ce que la View importe.

### Un composant — la View
- Importe `useOspfNeighbors`, rend un tableau de `OspfNeighborVM`. **N'importe pas** `OSPFEngine`. Voir `src/components/network/devtools/LiveDeviceStats.tsx`.

---

## 5. Le store Zustand : Controller des *commandes*

`store/networkStore.ts` complète les Projectors : il porte la **topologie** (devices, connexions),
l'**état UI** (sélection, zoom, pan), et expose les **commandes** (`addDevice`, `addConnection`,
`removeDevice`, `moveDevice`…). Une commande mute le Model (crée un `Equipment`, connecte un
`Cable`) puis laisse les events/projections propager le reste.

> **Dette connue & cible de migration** : `NetworkDeviceUI` expose encore `instance: Equipment`
> (fuite du domaine mutable dans la couche UI — viole O5). À terme, la View doit consommer des
> VM (`DeviceVM`) via `useDevices`, et non l'instance. Toute nouvelle feature **n'ajoute jamais**
> de nouvelle fuite de ce type ; toute migration en **retire**.

---

## 6. Les six objectifs de la refonte (rappel, pour arbitrer)

D'après `docs/REFONTE-REACTIVE-EVENT-DRIVEN.md` §1.3 — utilise-les pour trancher un doute :

- **O1** Bus d'événements typé unique (supprimer les callbacks ad-hoc).
- **O2** État observable partout → hooks React granulaires.
- **O3** Scheduler virtuel unique → `setTimeout/setInterval` natifs interdits ailleurs.
- **O4** Pipeline L2 asynchrone explicite (events `frame.*`).
- **O5** Découplage UI ↔ domaine → la View ne lit que des read-models (VM).
- **O6** Plug-in API protocolaire → un protocole = un Actor qui s'abonne/émet, sans toucher les classes de base.
- **O7** Déterminisme & reproductibilité.
- **O8** Zéro régression fonctionnelle (la suite `vitest` reste verte).

Les trois fractures que l'audit mesure (`scripts/audit-mvc.mjs`) correspondent à **O5, O3, O2**.

# Frontières entre couches — règles d'import

> La standardisation se **mesure** au sens des dépendances. Une couche ne peut importer que
> vers le bas. Ce fichier liste, pour chaque couche, ce qui est autorisé et interdit, avec
> des exemples concrets et les exceptions documentées. `scripts/audit-mvc.mjs` automatise la
> détection des violations majeures.

## Le sens unique

```
VIEW ───importe──► CONTROLLER ───importe──► MODEL ───importe──► NOYAU (events/)
 ▲                                                                   │
 └───────────────────── interdit de remonter ◄──────────────────────┘
```

Le **Model** est tout en bas. Il ne connaît que le **noyau** (`events/`). Le **noyau** ne
connaît rien d'autre que lui-même.

---

## MODEL (`src/network/`, `src/database/`)

**Peut importer :**
- ✅ Le noyau : `@/events/EventBus`, `@/events/Scheduler`, `@/events/Signal`, `@/events/types`.
- ✅ Son propre `observables.ts` co-localisé (pour les types VM et `projectXxx`).
- ✅ D'autres types/utilitaires de domaine **sans appeler** un autre Actor à l'exécution.
- ✅ `@/network/core/*` (types de trames, constantes, `Logger`).

**Ne peut jamais importer :**
- ❌ `react`, `react-dom`, un hook React.
- ❌ `@/store/*` (le store dépend du domaine, pas l'inverse).
- ❌ `@/components/*`.
- ❌ `setTimeout`/`setInterval` natifs (utiliser le `Scheduler` injecté).

```ts
// ❌ INTERDIT — un engine qui connaît React / le store
import { useNetworkStore } from '@/store/networkStore';
class FooEngine { tick() { setInterval(() => this.hello(), 1000); } }   // timer natif

// ✅ STANDARD — un engine qui publie et planifie via le noyau
import { getDefaultEventBus } from '@/events/EventBus';
import type { IScheduler } from '@/events/Scheduler';
class FooEngine {
  constructor(private bus = getDefaultEventBus(), private scheduler: IScheduler) {}
  start() { this.scheduler.setInterval(() => this.sendHello(), 1000); }
  private sendHello() { this.bus.publish({ topic: 'foo.hello.sent', payload: { id: this.id } }); }
}
```

> **Actors ne s'appellent pas entre eux.** Si l'engine A a besoin d'une info de l'engine B, il
> s'abonne à un event de B (ou lit une VM projetée), il n'appelle pas `b.getState()`.

---

## CONTROLLER

### Projector (`src/network/**/observables.ts`)
**Peut importer :** ✅ `@/events/Signal`, ✅ les **types** de domaine nécessaires aux projections.
**Ne peut pas :** ❌ importer React, ❌ publier sur le bus (les projections sont **pures**), ❌ utiliser le temps réel / aléatoire.

```ts
// ✅ projection pure : entrée = état domaine, sortie = VM, déterministe
export function projectNeighbors(ifaces: Iterable<OSPFInterface>): OspfNeighborVM[] { /* … */ }
```

### Hook (`src/react/hooks/use<Feature>.ts`)
**Peut importer :** ✅ React, ✅ les `Signal`/`observables` d'un engine, ✅ l'`EquipmentRegistry` et l'`EventBus` pour résoudre/abonner, ✅ les types VM.
**Ne doit pas :** ❌ contenir de logique métier (déléguer aux projections), ❌ muter le domaine (sauf via une commande/méthode explicite).

### Store (`src/store/networkStore.ts`)
**Peut importer :** ✅ le domaine (`@/network`) — c'est lui qui crée les `Equipment`/`Cable` et orchestre la topologie. ✅ l'`EventBus`.
**Ne doit pas :** ❌ importer un composant.

> **Pourquoi le store a le droit d'importer le domaine, mais pas la View ?** Le store *est* le
> Controller des commandes : il instancie et orchestre le Model. La View, elle, ne doit voir
> que des projections. La frontière à protéger absolument est **View → Model**, pas Controller → Model.

---

## VIEW (`src/components/`, `src/pages/`)

**Peut importer :**
- ✅ Des hooks : `@/react/hooks/*`, `@/hooks/*`.
- ✅ Le store **pour les commandes** : `useNetworkStore(s => s.addDevice)`.
- ✅ Les **types VM** et types UI purs.
- ✅ `@/components/ui/*` (shadcn), librairies de présentation.

**Ne peut jamais importer :**
- ❌ Un Actor mutable : `@/network/equipment/Equipment`, `@/network/ospf/OSPFEngine`, un device concret…
- ❌ Le barrel `@/network` quand il ramène des classes mutables / `createDevice`.
- ❌ `@/events/Scheduler` ou des timers de simulation (la View n'orchestre pas le domaine).

```tsx
// ❌ INTERDIT — la View lit le domaine mutable
import { OSPFEngine } from '@/network/ospf/OSPFEngine';
const neighbors = device.instance._getOSPFEngineInternal()?.getNeighbors();

// ✅ STANDARD — la View consomme une VM via un hook
import { useOspfNeighbors } from '@/react/hooks';
const neighbors = useOspfNeighbors(deviceId);   // OspfNeighborVM[]
```

> **Dette connue (cible de migration, pas un feu vert)** : plusieurs composants `network/`
> importent encore `@/network` et `NetworkDeviceUI.instance` expose un `Equipment`. C'est une
> violation O5 **à résorber**. N'en ajoute jamais ; quand tu touches un de ces composants,
> migre-le (recette B) plutôt que d'imiter l'ancien code.

---

## NOYAU (`src/events/`)

`EventBus`, `Scheduler`, `Signal` n'importent **que** des types entre eux. Aucune dépendance
vers `network/`, `store/`, `components/`. Ce sont les fondations : elles ne connaissent personne.

---

## Exceptions documentées (les seules tolérées)

1. **Adapters** (`src/adapters/`) : par nature, ils touchent un effet externe (filesystem Oracle,
   systemd). Ils s'abonnent au bus et peuvent importer le sous-système qu'ils synchronisent.
   Ce ne sont **pas** des composants : ils ne rendent rien.
2. **Tests** (`src/__tests__/`) : peuvent importer n'importe quelle couche (ils vérifient les
   contrats). Exemptés des règles ci-dessus.
3. **`Scheduler.ts`** lui-même : seul fichier autorisé à appeler `globalThis.setTimeout/setInterval`.
4. **Barrel d'index** (`index.ts`) : réexports purs, pas de logique.

Toute autre dérogation doit être justifiée par un commentaire `// boundary-exception: <raison>`
sur la ligne d'import, sinon l'audit la signale.

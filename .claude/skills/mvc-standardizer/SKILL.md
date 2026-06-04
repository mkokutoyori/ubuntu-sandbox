---
name: mvc-standardizer
description: >-
  Standardizes and migrates features of the Ubuntu Sandbox network simulator onto its
  reactive, event-driven Model-View-Controller architecture (Model = domain Actors and
  protocol engines, Controller = observables/read-model projections + React hooks + the
  Zustand store, View = React components). Use whenever the user wants to convert/refactor
  the project or a feature to MVC, standardize a feature, decouple the UI from the domain,
  add a new device/protocol/engine/command/panel "the standard way", expose domain state to
  React reactively, create observables/read-models/view-models (VM), wire an EventBus topic
  or a Scheduler timer, or audit architectural compliance. Trigger words (FR/EN): MVC,
  Modèle-Vue-Contrôleur, standardiser/standardize, convertir/migrer une fonctionnalité,
  architecture réactive, observable, read-model, view-model, projection, EventBus,
  Scheduler, signal, projecteur, acteur, découpler UI/domaine. Do NOT use for pure
  visual/CSS tweaks with no logic, dependency bumps, or documentation-only edits.
---

# MVC Standardizer — l'architecture réactive d'Ubuntu Sandbox, rendue répétable

> **Mission.** Faire en sorte que *chaque* fonctionnalité du projet — device, protocole,
> commande, panneau — soit construite selon le **même** moule Model-View-Controller, déjà
> incarné par le module OSPF. Standardiser = supprimer les variantes ad-hoc et converger
> tout le code vers ce moule unique.
>
> **Mission (EN).** Make every feature follow the *same* MVC mould already embodied by the
> OSPF module. Standardizing means eliminating ad-hoc variants and converging all code onto
> that single mould.

Ce projet **a déjà** une architecture MVC réactive de classe production (voir
`docs/REFONTE-REACTIVE-EVENT-DRIVEN.md`). Ce skill n'invente rien : il **nomme**, **outille**
et **rend répétable** ce qui existe déjà dans `src/network/ospf/`, pour qu'on l'applique
partout sans dériver.

---

## Quand l'utiliser / When to use

Déclenche ce skill dès qu'une tâche touche à la **structure** d'une fonctionnalité :

- « Convertis / migre X vers MVC », « standardise X », « refactore X proprement ».
- « Ajoute un nouveau protocole / device / commande / panneau » → le faire *au standard*.
- « Affiche l'état de X dans l'UI », « rends X réactif », « découple l'UI du domaine ».
- « Crée un observable / read-model / view-model / projection pour X ».
- « Pourquoi l'UI ne se met pas à jour quand X change ? » (souvent un chaînon MVC manquant).
- « Audite la conformité architecturale », « où en est la migration ? ».

**Ne pas l'utiliser** pour : du pur style/CSS sans logique, un bump de dépendance, ou une
modification purement documentaire.

---

## L'idée maîtresse — le MVC réactif de ce projet

Le « Controller » n'est pas un gros contrôleur impératif : c'est une **couche de projection
réactive** entre le domaine et React. Le flux est **unidirectionnel** :

```
   ACTION utilisateur / commande terminal
            │  (mutation)
            ▼
   ┌─────────────────┐   publish(event)    ┌───────────────┐
   │  MODEL (Actor)  │ ──────────────────► │   EventBus    │
   │  engine + state │                     └───────┬───────┘
   └─────────────────┘                             │ subscribe
            ▲                                       ▼
            │ jamais lu                  ┌──────────────────────────┐
            │ directement                │ CONTROLLER (Projector)   │
            │ par la View                │ observables.ts:          │
            │                            │  projectXxx() → VM       │
            │                            │  SignalStore (Signals)   │
            │                            └────────────┬─────────────┘
            │                                         │ Signal.subscribe
            │                                         ▼
            │                            ┌──────────────────────────┐
            │            useXxx(id) ◄────│ CONTROLLER (hook React)  │
            │                            │ react/hooks/useXxx.ts    │
            │                            └────────────┬─────────────┘
            │                                         │ VM (read-only)
            │                                         ▼
            │                            ┌──────────────────────────┐
            └──── commandes (store) ─────│ VIEW : composant React   │
                                         │ components/**/*.tsx      │
                                         └──────────────────────────┘
```

| Couche MVC | Rôle dans le projet | Où ça vit |
|---|---|---|
| **Model** | *Actors* : `Equipment`, `Port`, `Cable`, devices, **moteurs de protocole** (`OSPFEngine`, `DHCPServer`…). Détiennent l'état mutable + la logique métier. Mutent leur état et **publient** des events. Ne s'appellent jamais entre eux. | `src/network/`, `src/database/` |
| **Controller** | *Projectors* : `observables.ts` (types **VM**, fonctions pures `projectXxx`, `SignalStore`) ; **hooks** React (`react/hooks/useXxx.ts`) ; le **store Zustand** (`store/networkStore.ts`, commandes/topologie) ; la logique de vue extraite (`*-logic.ts`). | `src/network/**/observables.ts`, `src/react/hooks/`, `src/store/`, `src/components/**/*-logic.ts` |
| **View** | Composants React : présentation pure. Consomment des **VM** via des hooks. **N'importent jamais** le domaine mutable. | `src/components/` |

**La référence absolue, c'est OSPF.** Avant d'écrire quoi que ce soit, lis ces quatre
fichiers — ils sont l'incarnation canonique du moule :

1. `src/network/ospf/observables.ts` — VM + `projectXxx` purs + `OspfSignalStore` + `makeReadonlyObservables`.
2. `src/network/ospf/OSPFEngine.ts` — l'Actor : `signalStore` privé, `observables` en lecture seule, `SignalRefreshActor`, `_refreshXxxSignal()` qui délèguent aux projections pures.
3. `src/react/hooks/useOspf.ts` + `useEngineSignal.ts` — les hooks Controller.
4. Un composant qui consomme un hook (`src/components/network/devtools/LiveDeviceStats.tsx`).

---

## Les primitives noyau (à réutiliser, jamais réinventer)

Trois primitives internes — **aucune dépendance externe** (pas de RxJS/Redux/XState) :

- **`EventBus`** (`src/events/EventBus.ts`) — bus typé, topics hiérarchiques `domaine.entité.évènement`. Les Actors `publish`, les Projectors/Adapters `subscribe`.
- **`Scheduler`** (`src/events/Scheduler.ts`) — **tous** les timers passent par lui (`scheduler.setTimeout/setInterval/now/delay`). `setTimeout`/`setInterval` natifs **interdits** hors `Scheduler.ts` (déterminisme des tests).
- **`Signal`** (`src/events/Signal.ts`) — conteneur observable compatible `useSyncExternalStore`. Le `SignalStore` d'un engine est **privé** ; on n'expose que l'interface `Signal<T>` en lecture seule.

---

## La règle d'or de standardisation (non négociable)

> **Les dépendances ne pointent que dans un sens : View → Controller → Model.**
> Jamais l'inverse, jamais en biais.

Concrètement (détail + exceptions dans `references/layer-boundaries.md`) :

1. **Le Model n'importe ni React, ni le store, ni un composant, ni un autre Actor.** Il communique uniquement via `EventBus` et expose des `Signal` en lecture seule.
2. **La View n'importe jamais `@/network/...` mutable** (ni `Equipment`, ni un engine). Elle ne connaît que des **VM** (objets `readonly`, sérialisables) via des hooks.
3. **Les VM sont pures et immuables** : produites par des fonctions `projectXxx` **pures et testables sans monter l'engine**. Aucune logique de projection dans l'engine ni dans le composant.
4. **Aucun timer natif hors du `Scheduler`.** Aucun pub/sub ad-hoc hors de l'`EventBus`/`Signal`.
5. **Toute logique non-triviale d'un composant** part dans un `*-logic.ts` pur (humble component).

---

## Workflow

1. **Cadrer.** Nouvelle fonctionnalité ou migration d'existant ? Quel est le domaine (Model), quel état doit voir l'UI (VM), quelles actions la déclenchent ?
2. **Lire la référence OSPF** (les 4 fichiers ci-dessus). Toujours.
3. **Suivre la recette** pas-à-pas : `references/feature-recipe.md` (deux pistes : *new feature* et *migration*).
4. **Partir des templates** : `templates/` contient les squelettes Model/observables/hook/View/test prêts à copier.
5. **Respecter le nommage** : `references/naming-conventions.md` (VM, `projectXxx`, `SignalStore`, topics, emplacements de tests).
6. **Vérifier la conformité** : passer la *Definition of Done* (`references/feature-recipe.md`) **et** lancer l'audit automatique (ci-dessous).

Pour une **migration**, procéder par **strangler** : créer la couche réactive *à côté* de
l'existant, rebrancher la View dessus, puis retirer l'ancien chemin — jamais de big-bang.
Travailler **séquentiellement** (un Actor / un protocole à la fois), sans lancer d'agents.

---

## Audit automatique de standardisation

Un script Node (zéro dépendance) mesure l'écart au standard sur tout `src/` :

```bash
node .claude/skills/mvc-standardizer/scripts/audit-mvc.mjs           # rapport lisible
node .claude/skills/mvc-standardizer/scripts/audit-mvc.mjs --json    # sortie machine
node .claude/skills/mvc-standardizer/scripts/audit-mvc.mjs --strict  # exit 1 si violations (CI)
```

Il détecte les trois fractures de standardisation du projet : (1) composants couplés au
domaine mutable (frontière View↔Model, O5), (2) timers natifs hors `Scheduler` (O3),
(3) engines sans `observables.ts` (modèles non projetés, O2/O5). Lance-le **avant et après**
ton travail pour prouver que tu as réduit la dette, jamais augmentée.

---

## Ressources du skill / progressive disclosure

Charge ces fichiers à la demande, selon le besoin :

- `references/architecture-map.md` — la carte complète MVC ↔ couches, le glossaire (Actor, Projector, Signal, VM, read-model), et la lecture commentée de la référence OSPF.
- `references/feature-recipe.md` — la recette pas-à-pas (new feature **et** migration) + la **Definition of Done** standardisée.
- `references/layer-boundaries.md` — les règles d'import autorisé/interdit par couche, avec exemples ✅/❌ et exceptions documentées.
- `references/naming-conventions.md` — nommage des fichiers/types/fonctions/topics et emplacement des tests.
- `templates/` — squelettes prêts à copier : `model-engine.template.ts`, `observables.template.ts`, `use-feature.template.ts`, `feature-view.template.tsx`, `projection.test.template.ts`.
- `scripts/audit-mvc.mjs` — l'audit de conformité.

Garde l'invariant en tête : **un seul moule, appliqué partout.** Quand tu hésites, demande-toi
« comment OSPF le fait-il ? » et reproduis-le.

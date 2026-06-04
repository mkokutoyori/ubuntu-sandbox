# Recette de standardisation d'une fonctionnalité

> Deux pistes : **A. nouvelle fonctionnalité** et **B. migration d'un existant**.
> Les deux convergent vers la même *Definition of Done* (§C).
> Toujours lire la référence OSPF (`references/architecture-map.md` §4) d'abord.
> Toujours partir des `templates/`.

---

## A. Construire une nouvelle fonctionnalité au standard

Ordre imposé : **Model → Projector → Hook → View → Tests**. On construit du bas (domaine) vers
le haut (UI). On ne descend jamais.

### A0. Cadrer (5 min, écrit)
Réponds par écrit avant de coder :
- **Domaine** : quelles entités/état le Model détient-il ? (ex. voisins, routes, sessions)
- **Mutations** : quels events déclenchent un changement d'état ? (→ topics à définir)
- **VM** : que doit *voir* l'UI ? Liste les champs `readonly` strictement nécessaires. Rien de plus.
- **Actions** : quelles commandes l'UI envoie-t-elle ? (→ store ou méthode d'Actor)

### A1. Model / Actor (`src/network/<feature>/<Feature>Engine.ts`)
Template : `templates/model-engine.template.ts`.
- Détient l'état mutable + la logique métier.
- Détient un `SignalStore` **privé** ; expose `readonly observables` en lecture seule.
- `publish` ses events de domaine sur l'`EventBus` (jamais d'appel direct à un autre Actor).
- Tous les timers via `Scheduler` (injecté), **jamais** `setTimeout`/`setInterval` natifs.
- Branche un `Refresh Actor` (abonné au bus) qui appelle les `_refreshXxxSignal()`.
- `_refreshXxxSignal()` = wrappers minces délégant aux `projectXxx` purs.

### A2. Projector (`src/network/<feature>/observables.ts`)
Template : `templates/observables.template.ts`.
- Déclare les **VM** (`<Feature>XxxVM`, champs `readonly`).
- Déclare le `<Feature>SignalStore` (bundle de `WritableSignal`).
- Déclare `make<Feature>Observables(store)` → la vue lecture seule.
- Écris les fonctions **pures** `project<Xxx>(domain): VM[]`. **Aucun** accès au bus, à React, au temps réel. C'est ici que vit toute la logique de transformation.

### A3. Controller — hook (`src/react/hooks/use<Feature>.ts`)
Template : `templates/use-feature.template.ts`.
- Réutilise `useEngineSignal` quand l'état provient d'un engine résolu par `deviceId`.
- Fournis un **fallback stable** (constante hors composant) pour le cas « engine absent ».
- Le hook ne contient **aucune** logique métier : il sélectionne un `Signal` et renvoie la VM.
- Exporte aussi le hook depuis `src/react/hooks/index.ts`.

### A4. View (`src/components/.../<Feature>Panel.tsx`)
Template : `templates/feature-view.template.tsx`.
- Consomme le hook, rend les VM. **N'importe jamais** `@/network/...` mutable.
- Toute logique non triviale (formatage, tri, dérivation d'affichage) → `<feature>-panel-logic.ts` (fonctions pures).

### A5. Tests (`src/__tests__/unit/...`)
Template : `templates/projection.test.template.ts`.
- **Projections pures** : le plus gros des tests (entrée domaine → VM attendue). Cas nominaux + limites (vide, un élément, doublons).
- **Engine** : avance le `VirtualTimeScheduler`, publie des events, assert les `Signal` exposés.
- **Logic de vue** : teste les `*-logic.ts` purs.
- Réseau → `unit/network-v2/` ; GUI → `unit/gui/` ; DB → `unit/database/`.

---

## B. Migrer une fonctionnalité existante (strangler, pas big-bang)

Beaucoup de code pré-refonte lit le domaine directement, utilise des timers natifs, ou n'a pas
de read-model. On migre **par incréments réversibles**, un Actor / un protocole à la fois,
**séquentiellement, sans agent**, en gardant les tests verts à chaque étape.

### B1. Cartographier l'existant
- Quel(s) fichier(s) portent l'état ? Y a-t-il déjà des callbacks ad-hoc / `setTimeout` / pub-sub maison à remplacer ?
- Qui lit l'état côté UI ? (`grep` des imports `@/network` dans `src/components`)
- Lance l'audit ciblé : `node .claude/skills/mvc-standardizer/scripts/audit-mvc.mjs` et note les lignes concernant cette feature.

### B2. Créer la couche réactive *à côté* (sans rien casser)
- Ajoute `observables.ts` (VM + projections pures + SignalStore) pour l'état existant.
- Dans l'engine, ajoute le `signalStore` privé + `observables` + un `Refresh Actor`, et appelle `_refreshXxxSignal()` aux points de mutation **déjà existants**. Ne réécris pas la logique métier maintenant.
- Ajoute le hook `use<Feature>`.
- ✅ À ce stade, rien n'est débranché : l'ancien chemin marche toujours, le nouveau coexiste.

### B3. Rebrancher la View sur le hook
- Remplace, dans le composant, l'accès direct au domaine (`device.instance.…`, `engine.…`) par la consommation de la VM via le hook.
- Supprime l'import `@/network` mutable du composant.
- Vérifie visuellement / par test GUI que l'affichage est identique.

### B4. Remplacer les timers natifs et les callbacks ad-hoc
- Substitue chaque `setTimeout/setInterval` natif par le `Scheduler` injecté.
- Substitue chaque pub/sub maison (`onFrame`, `linkChangeHandlers`, `Map<string,callback>`…) par `EventBus`/`Signal`.

### B5. Retirer l'ancien chemin
- Une fois la View sur le hook et les tests verts, supprime le code mort (anciens getters de domaine exposés à l'UI, `instance: Equipment` superflu, callbacks remplacés).
- Re-lance l'audit : le compteur de violations pour cette feature doit **baisser**.

> **Règle de migration** : à la fin de **chaque** incrément (B2→B5), `npm run test:run`,
> `npm run lint` et `npm run build` passent. Si un incrément casse, on le réduit, on ne le force pas.

---

## C. Definition of Done — « standardisé » au sens du projet

Une fonctionnalité est standardisée **uniquement si toutes les cases sont cochées** :

### Model
- [ ] L'état mutable vit dans un Actor (`src/network/...` ou `src/database/...`), pas dans un composant ni le store.
- [ ] L'Actor `publish` ses events sur l'`EventBus` ; il n'appelle **aucun** autre Actor directement.
- [ ] Aucun `setTimeout`/`setInterval` natif : tout passe par le `Scheduler`.
- [ ] L'Actor n'importe ni React, ni le store, ni un composant.

### Controller (Projector + hook + store)
- [ ] Un `observables.ts` co-localisé déclare les **VM** (`readonly`), le `SignalStore` privé, la vue lecture seule, et les **projections pures** `projectXxx`.
- [ ] La logique de transformation domaine→VM vit **uniquement** dans les `projectXxx` (ni dans l'engine, ni dans le hook, ni dans le composant).
- [ ] Un `Refresh Actor` republie les `Signal` après les mutations pertinentes.
- [ ] Un hook `use<Feature>` expose la VM via `useSyncExternalStore` (souvent `useEngineSignal`), avec fallback stable, exporté depuis `react/hooks/index.ts`.
- [ ] Les commandes utilisateur passent par le store ou une méthode d'Actor, pas par une mutation directe depuis la View.

### View
- [ ] Le composant ne consomme que des **VM** via des hooks ; **aucun** import de `@/network` mutable (`Equipment`, engines).
- [ ] Toute logique non triviale est extraite dans un `*-logic.ts` pur.
- [ ] Le composant reste « humble » (présentation + câblage des hooks).

### Tests & qualité
- [ ] Projections pures testées (nominaux + limites). Engine testé avec le `VirtualTimeScheduler`.
- [ ] `npm run test:run` vert, `npm run lint` propre, `npm run build` OK.
- [ ] `node .claude/skills/mvc-standardizer/scripts/audit-mvc.mjs` : **0 nouvelle** violation introduite ; idéalement le total baisse.
- [ ] Nommage conforme à `references/naming-conventions.md`.

Si une seule case manque, ce n'est **pas** standardisé — c'est « presque ». On finit.

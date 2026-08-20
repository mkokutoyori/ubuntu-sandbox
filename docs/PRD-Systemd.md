# PRD — systemd : moteur de jobs et résolution de dépendances

**Version** : 1.0
**Date** : 2026-07-02
**Projet** : Ubuntu Sandbox — Gestionnaire de services Linux (systemd)
**Auteur** : Claude Code
**Références normatives** : `systemd(1)`, `systemd.unit(5)`, `systemd.service(5)`, `systemd.target(5)`, `systemd.socket(5)`, `systemd.timer(5)`, `systemctl(1)`

---

## 0. Contexte et portée du document

Ce PRD couvre le **cœur manquant de la simulation systemd** : le moteur de jobs qui
résout le graphe de dépendances entre unités et applique les transitions dans le bon
ordre. La simulation actuelle sait charger des fichiers d'unité, démarrer/arrêter une
unité isolée et rendre `systemctl status/list`, mais `systemctl start X` **n'entraîne
pas** les dépendances de X et **n'ordonne pas** les activations : les directives
`Requires=`/`Wants=`/`After=`/`Before=` sont analysées et ré-affichées, mais jamais
exploitées pour piloter le démarrage. C'est l'équivalent d'un court-circuit : la décision
d'activation ignore le graphe réel.

Le périmètre est le **moteur de transactions d'unités** (résolution + ordonnancement +
propagation), puis son extension aux `.target`, au redémarrage automatique piloté par la
mort réelle du processus, et aux unités `.socket`/`.timer`. Aucune ligne de code n'est
écrite dans le cadre de ce document.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Lignes |
|---|---|---|
| `src/network/devices/linux/LinuxServiceManager.ts` | Chargement d'unités, `start`/`stop`/`enable`/`disable`, ports, listeners, événements | 1070 |
| `src/network/devices/linux/service/LinuxService.ts` | Objet unité (états, `wantsAutoRestart`, snapshot) sur `OSService` | 78 |
| `src/network/devices/linux/LinuxProcessCommands.ts` | Façade CLI `systemctl` (`status`, `list-units`, `list-dependencies`, `cat`, `daemon-reload`…) | — |
| `src/network/devices/linux/supervisor/LinuxServiceSupervisor.ts` | Supervision légère | 63 |
| `src/network/devices/os/OSService.ts` | Base cross-OS d'une unité | 301 |
| `src/network/devices/os/OSServiceOrchestrator.ts` | Orchestration cross-OS | 104 |

### 1.2 Ce qui existe déjà et est réutilisable

- **Modèle d'unité et chargement** : parsing de `[Unit]/[Service]/[Install]` depuis
  `/usr/lib/systemd/system` et `/etc/systemd/system`, `daemon-reload`, symlinks
  `multi-user.target.wants/` pour `enabled` — solide, à conserver.
- **Activation d'une unité** : `activate()` fait tourner un vrai processus via
  `LinuxProcessManager.spawn()` (le daemon apparaît dans `ps`/`ss`), ouvre les ports
  déclarés (`SERVICE_LISTENERS`), émet des événements de cycle de vie sur le bus. C'est
  le bon point d'ancrage : le moteur de jobs orchestrera des appels à `activate`/
  `deactivate`, sans les réécrire.
- **États et politiques** : `ServiceState`, `EnabledState`, `ServiceType`,
  `RestartPolicy` sont déjà modélisés fidèlement.

### 1.3 Ce qui manque ou court-circuite (gap analysis)

| # | Manque | Comportement réel attendu | Sévérité |
|---|---|---|---|
| 1 | `start` n'entraîne pas `Requires=`/`Wants=` | Démarrer une unité démarre récursivement ses dépendances | Bloquant |
| 2 | Aucun ordonnancement `After=`/`Before=` | Les unités s'activent dans l'ordre topologique de `After`/`Before` | Bloquant |
| 3 | `Requires=` sans propagation d'échec | Si une dépendance `Requires` échoue, l'unité dépendante n'est pas démarrée (échec du job) | Élevée |
| 4 | `Wants=` non distingué de `Requires=` | Une dépendance `Wants` qui échoue n'empêche pas le démarrage | Élevée |
| 5 | Directives absentes du modèle : `Before=`, `Wants=`, `Conflicts=`, `PartOf=`, `BindsTo=` | Parsées, stockées et honorées | Élevée |
| 6 | `stop` sans propagation inverse | Arrêter une unité arrête celles qui la `Requires`/`BindsTo`/`PartOf` | Élevée |
| 7 | `Conflicts=` inopérant | Démarrer une unité arrête ses unités en conflit (et réciproquement) | Moyenne |
| 8 | `.target` non activable | `systemctl start/isolate <target>` entraîne ses `Wants=`/`Requires=` | Moyenne |
| 9 | `Restart=` non déclenché par la mort réelle du processus | La sortie anormale d'un `mainPid` relance l'unité selon la politique | Moyenne |
| 10 | Détection de cycle d'ordonnancement absente | systemd casse un cycle `After` et journalise ; un cycle `Requires` est une erreur de job | Faible |
| 11 | `list-dependencies` à plat (liste `after` brute) | Arbre récursif Requires/Wants avec état de chaque nœud | Faible |

**Conclusion** : l'infrastructure d'unité et d'activation est réelle et fidèle, mais le
**moteur de jobs** — la pièce qui fait de systemd un gestionnaire de dépendances et non
un simple lanceur — est absent. L'implémenter transforme `systemctl start X` en une
transaction ordonnée sur le graphe réel, sans réécrire le chargement ni l'activation.

---

## 2. Objectifs

### 2.1 Objectifs (ce PRD)

1. **Graphe de dépendances typé** : modéliser les arêtes `Requires`, `Wants`, `After`,
   `Before`, `Conflicts`, `PartOf`, `BindsTo` sur les unités, chargées depuis les
   fichiers d'unité et les valeurs par défaut.
2. **Moteur de transactions** : `systemctl start X` calcule l'ensemble des unités à
   activer (fermeture transitive de `Requires`+`Wants`), les trie topologiquement selon
   `After`/`Before`, et les active dans l'ordre.
3. **Propagation d'échec** : l'échec d'une dépendance `Requires`/`BindsTo` fait échouer
   le job de l'unité dépendante ; un échec `Wants` est ignoré (best-effort).
4. **Transaction d'arrêt** : `systemctl stop X` arrête X et, par propagation inverse, les
   unités qui `Requires`/`BindsTo`/`PartOf` X, dans l'ordre inverse de `After`.
5. **Conflits** : démarrer une unité déclenche l'arrêt de ses unités `Conflicts=` (et de
   celles qui la déclarent en conflit), avant son activation.
6. **Détection de cycle** : un cycle d'ordonnancement `After`/`Before` est détecté ; le
   job échoue proprement avec un diagnostic (pas de boucle infinie).

### 2.2 Objectifs différés (phases ultérieures du même PRD)

7. **Unités `.target`** activables (`start`/`isolate`) entraînant leurs wants/requires.
8. **`Restart=`** déclenché par la mort réelle du `mainPid` (abonnement à
   `linux.process.exited`), selon `on-failure`/`always`/`on-abnormal`.
9. **`.socket` / `.timer`** : activation par socket et par minuterie.

### 2.3 Non-objectifs

- D-Bus réel, cgroups réels, `systemd-analyze` (graphes de temps de boot).
- Ordonnancement parallèle réel (le simulateur active en série dans l'ordre topologique ;
  la sémantique observable est identique pour les tests).
- `systemd-networkd`, `systemd-resolved` complets (déjà partiellement modélisés ailleurs).

---

## 3. Architecture cible

### 3.1 Principe directeur

**Ne pas réécrire `LinuxServiceManager`.** On introduit un moteur de jobs qui compose
au-dessus de lui : le manager reste l'agrégat qui possède les unités et sait
`activate`/`deactivate` une unité isolée ; le moteur `SystemdJobEngine` calcule et
exécute les transactions en appelant ces primitives dans le bon ordre. `systemctl
start/stop` délègue au moteur au lieu d'appeler `activate` en direct.

### 3.2 Diagramme de couches

```
+---------------------------------------------------------------------+
|                 FAÇADE CLI (systemctl start/stop/isolate)           |
|                 LinuxProcessCommands.ts                              |
+------------------------------+--------------------------------------+
                               | start(name) / stop(name)
+------------------------------v--------------------------------------+
|                     MOTEUR DE JOBS (nouveau)                        |
|  SystemdJobEngine                                                    |
|   - buildStartTransaction(unit): ensemble + ordre topologique       |
|   - buildStopTransaction(unit): fermeture inverse                   |
|   - run(transaction): applique activate/deactivate en ordre         |
|  DependencyGraph : Requires/Wants/After/Before/Conflicts/PartOf     |
|  TopoSort : ordre d'activation + détection de cycle                 |
+------------------------------+--------------------------------------+
                               | activate(u) / deactivate(u) / isActive
+------------------------------v--------------------------------------+
|              LinuxServiceManager (existant, inchangé)               |
|   possède les unités, spawn le processus, ouvre les ports,          |
|   émet les événements de cycle de vie                               |
+---------------------------------------------------------------------+
```

### 3.3 Modules proposés (arborescence)

```
src/network/devices/linux/systemd/
  DependencyGraph.ts     # arêtes typées entre unités, requêtes (deps directes/transitives)
  UnitOrdering.ts        # tri topologique After/Before + détection de cycle
  SystemdJobEngine.ts    # buildStartTransaction/buildStopTransaction/run
  JobTypes.ts            # Job, JobResult, JobType ('start'|'stop'|'restart'), TransactionError
```

`LinuxServiceManager` gagne l'exposition minimale nécessaire au moteur (lister les unités,
`activateUnit`/`deactivateUnit` publics, lecture des arêtes de dépendance) ; le parseur
d'unité gagne `Wants`, `Before`, `Conflicts`, `PartOf`, `BindsTo`.

### 3.4 Design patterns retenus

| Pattern | Usage | Justification |
|---|---|---|
| **Graph + Topological Sort** | `DependencyGraph` + `UnitOrdering` | Le problème *est* un tri de graphe orienté ; le séparer le rend testable sans réseau ni VFS |
| **Command / Transaction** | `Job`, `SystemdJobEngine.run(transaction)` | Une transaction est une liste ordonnée de jobs atomiques, comme le « job model » réel de systemd |
| **Aggregate + Service** | Manager (agrégat d'unités) / moteur (service de transaction) | Sépare la possession de l'état de l'orchestration, sans réécrire l'existant |

---

## 4. Modèle de données

### 4.1 Arêtes de dépendance (`systemd.unit(5)`)

| Directive | Sémantique | Effet dans une transaction |
|---|---|---|
| `Requires=` | dépendance forte | tire la cible au start ; son échec fait échouer le dépendant ; l'arrêt de la cible arrête le dépendant |
| `Wants=` | dépendance faible | tire la cible au start ; son échec est ignoré |
| `BindsTo=` | comme Requires + suit l'arrêt inopiné de la cible | tire au start ; l'arrêt/mort de la cible arrête le dépendant |
| `PartOf=` | propagation start/stop **descendante** uniquement | l'arrêt/redémarrage de la cible se propage aux membres |
| `Conflicts=` | exclusion mutuelle | démarrer l'un arrête l'autre |
| `After=` / `Before=` | **ordonnancement seul** (aucune activation) | fixe l'ordre dans la transaction sans tirer d'unité |

`Requires`/`Wants`/`BindsTo` sont des dépendances *d'activation* ; `After`/`Before` sont
des dépendances *d'ordre*. Les deux sont orthogonales (systemd le souligne explicitement) :
le moteur calcule d'abord l'ensemble via les premières, puis l'ordre via les secondes.

### 4.2 Job et transaction

- `Job = { unit, type: 'start' | 'stop', required: boolean }` — `required=false` pour les
  arêtes `Wants`.
- Une **transaction** est une liste ordonnée de jobs (ordre d'activation, inverse pour
  l'arrêt) plus l'ensemble des conflits à résoudre en préalable.
- `JobResult = { unit, outcome: 'done' | 'failed' | 'skipped' | 'dependency-failed' }`.

---

## 5. Plan de mise en œuvre (TDD, par phases)

Chaque phase : tests d'abord (unités réelles chargées dans un vrai `LinuxServiceManager`
sur un `LinuxServer`/`LinuxPC` simulé, fichiers d'unité écrits dans le VFS), puis
implémentation jusqu'au vert, puis régression avant commit. Aucun stub, aucun commentaire
dans le code de production, aucune duplication.

| Phase | Contenu | Sortie testable |
|---|---|---|
| **1** | `DependencyGraph` + parsing des arêtes (`Requires`/`Wants`/`After`/`Before`/`Conflicts`/`PartOf`/`BindsTo`) ; requêtes deps directes/transitives | À partir d'unités chargées, le graphe rend les bonnes arêtes typées et la fermeture transitive Requires+Wants |
| **2** | `UnitOrdering` : tri topologique `After`/`Before` + détection de cycle | Un ensemble d'unités est ordonné correctement ; un cycle `After` est signalé sans boucle |
| **3** | `SystemdJobEngine.buildStartTransaction` + `run` ; `systemctl start` entraîne et ordonne les dépendances | `systemctl start A` (A Requires B After B) démarre B puis A ; B actif ; ordre vérifiable |
| **4** | Propagation d'échec (`Requires`/`BindsTo` échoué → dépendant non démarré ; `Wants` échoué → ignoré) et `Conflicts` (arrêt préalable) | Une dépendance `Requires` en échec fait échouer le start du dépendant ; un `Wants` en échec ne l'empêche pas ; démarrer C arrête son conflit D |
| **5** | `buildStopTransaction` : arrêt + propagation inverse (`Requires`/`BindsTo`/`PartOf`) en ordre inverse | `systemctl stop B` arrête aussi A qui `Requires` B |
| **6** | `.target` activables (`start`/`isolate`) tirant leurs wants/requires ; `list-dependencies` en arbre | `systemctl isolate multi-user.target` amène l'ensemble attendu ; `list-dependencies` rend l'arbre récursif |
| **7** | `Restart=` déclenché par la mort réelle du `mainPid` (abonnement `linux.process.exited`) | Tuer le processus d'une unité `Restart=always` la relance ; `Restart=no` la laisse `failed` |
| **8** | Unités `.socket` / `.timer` (activation par socket / minuterie) | Une `.socket` démarre son service à la première connexion ; une `.timer` déclenche son service à l'échéance |

La priorité (phases 1–5) supprime le court-circuit central : `systemctl start/stop`
opère sur le graphe réel, comme systemd, au lieu d'agir sur une unité isolée.

---

## 6. Stratégie de test

- **TDD strict** : chaque phase écrit d'abord des scénarios sur un vrai
  `LinuxServiceManager` peuplé d'unités (fichiers d'unité écrits dans le VFS ou unités par
  défaut), sans mocker le graphe.
- **Ordre observable** : l'ordre d'activation est vérifié via l'ordre réel des événements
  de cycle de vie du bus (`linux.service.*`) ou l'ordre d'apparition des processus, pas
  via une inspection interne du tri.
- **Tests négatifs systématiques** : cycle d'ordonnancement, dépendance `Requires`
  manquante ou en échec, conflit mutuel, arrêt d'une cible `BindsTo`, unité masquée dans
  une transaction.
- **Non-régression** : la suite `systemctl`/service existante (status, list-units,
  enable/disable, ports ouverts au start) reste le golden master — le comportement d'une
  unité sans dépendance ne change pas.

---

## 7. Risques et points d'attention

1. **Orthogonalité ordre/activation** : l'erreur classique est de traiter `After=` comme
   une dépendance d'activation. Le moteur doit strictement séparer les deux, comme
   systemd. Mitigation : phases 1 (activation) et 2 (ordre) séparées, chacune testée
   isolément avant la composition en phase 3.
2. **Cycles** : un cycle `After` doit être cassé/diagnostiqué sans boucle infinie ; un
   cycle `Requires` est une erreur de transaction. Mitigation : détection de cycle testée
   en phase 2 avant tout `run`.
3. **Compatibilité `start` existant** : de nombreux tests appellent `serviceMgr.start()`.
   Le moteur doit rester transparent pour une unité sans dépendance (même résultat, mêmes
   événements). Mitigation : `start` délègue au moteur, qui pour une unité isolée produit
   une transaction à un seul job — comportement inchangé, vérifié par la régression.
4. **Réentrance** : activer une dépendance ne doit pas re-déclencher une transaction
   imbriquée. Mitigation : le moteur calcule la transaction complète d'abord, puis exécute
   des `activate`/`deactivate` de bas niveau (non transactionnels).

---

## 8. Suite prévue

Une fois le moteur de jobs livré (phases 1–5), les extensions naturelles : `.target`
et `isolate` (6), redémarrage piloté par la mort du processus (7), activation par
socket/minuterie (8), puis `systemd-analyze`/ordonnancement parallèle si besoin. Chacune
consomme le moteur de transactions sans le dupliquer.

# Assessment technique — Ubuntu Sandbox

**Analyste :** revue d'ingénierie logicielle · **Date :** 2026-07-09 ·
**Branche :** `emmanuel`
**Méthode :** graphe de connaissances Graphify (34 909 nœuds / 106 291 arêtes,
extraction AST tree-sitter sur 3 319 fichiers) + métriques statiques + revue
ciblée du code.

> Note de cadrage : ce projet est **techniquement impressionnant** — un
> simulateur réseau + OS + SGBD réimplémentés à la main, 1 809 fichiers source
> et 1 304 fichiers de test. Les critiques ci-dessous portent sur la
> **soutenabilité** de cette base, pas sur son ambition. L'objectif est de
> lister sans complaisance ce qui est *mal implémenté* et coûtera cher à terme.

---

## 0. Synthèse — les 8 problèmes majeurs, par priorité

| # | Problème | Gravité | Effort | Preuve |
|---|---|---|---|---|
| 1 | **TypeScript non-strict** (`strict:false`, `strictNullChecks:false`, `noImplicitAny:false`) sur le build de prod | 🔴 Critique | Élevé | `tsconfig.app.json:18-21`, `tsconfig.json:9-14` |
| 2 | **879 `as unknown as` + 400 `as any`** — le système de types est massivement contourné | 🔴 Critique | Élevé | grep (voir §2) |
| 3 | **État parallèle / sources de vérité multiples** (PS vs CMD, cf. `ps-vs-cmd.md`) | 🔴 Critique | Moyen | `PowerShellExecutor.ts` `extraIPs`/`extraRoutes` |
| 4 | **Fichiers-monstres** : 32 fichiers > 1 500 LOC, 5 > 4 000 | 🟠 Majeur | Élevé | `PowerShellExecutor.ts` 6 242 LOC |
| 5 | **Fichier source corrompu** : octet NUL + UTF-8 cassé | 🟠 Majeur | Faible | `CollectionCmdlets.ts` offset 27489 |
| 6 | **God nodes** : `types.ts` fan-in 4 560, couplage central extrême | 🟠 Majeur | Moyen | graphe (voir §4) |
| 7 | **Couverture de tests mesurée sur 1 seul sous-système** (ssh) | 🟠 Majeur | Moyen | `vite.config.ts:46` |
| 8 | **Dispatch vendeur fragile** (`constructor.name` + `keepNames`) | 🟡 Moyen | Faible | `vite.config.ts:32` |

---

## 1. Rigueur du typage désactivée (🔴)

Le projet est en TypeScript mais **renonce aux garanties de TypeScript** dans sa
configuration de build principale :

```jsonc
// tsconfig.app.json          // tsconfig.json (référencé par le build)
"strict": false,              "noImplicitAny": false,
"noImplicitAny": false,       "noUnusedLocals": false,
"noUnusedLocals": false,      "strictNullChecks": false
```

Conséquences concrètes :
- **`strictNullChecks: false`** → `undefined`/`null` ne sont pas suivis par le
  compilateur. Dans un simulateur qui manipule en permanence des
  `port.getIPAddress()` pouvant être `null`, c'est la porte ouverte aux
  `Cannot read property of undefined` en exécution — que le compilateur pourrait
  attraper.
- **`noImplicitAny: false`** → tout paramètre non annoté devient `any`
  silencieusement, ce qui explique en partie le point §2.

Fait notable : `tsconfig.completion.json` et `tsconfig.node.json` sont, eux, en
`strict: true`. La rigueur existe donc dans le projet mais **n'est pas
appliquée au cœur applicatif**. C'est le réglage le plus impactant à corriger,
mais aussi le plus coûteux (il révélera des centaines d'erreurs latentes).

**Recommandation :** activer `strictNullChecks` en premier (le plus rentable),
fichier par fichier via `// @ts-strict` progressif ou en isolant les modules
déjà propres, plutôt qu'un big-bang.

---

## 2. Le système de types est massivement contourné (🔴)

```
as unknown as   :  879 occurrences  (hors tests)
as any          :  400 occurrences
: any (annots)  :  ~600 occurrences
```

Concentration (`as unknown as`) :

| Occurrences | Fichier |
|---|---|
| 106 | `src/network/devices/shells/CiscoShellBase.ts` |
| 96 | `src/network/devices/inspection/config/LoggingConfig.ts` |
| 55 | `src/powershell/runtime/PSRuntime.ts` |
| 46 | `src/network/devices/shells/huawei/HuaweiDisplayCommands.ts` |
| 39 | `src/powershell/providers/WindowsPSProviders.ts` |

`as unknown as` est le cast le plus dangereux de TypeScript : il **efface toute
vérification**. À 879 occurrences, ce n'est plus un échappatoire ponctuel mais
un **motif d'architecture**. Exemple typique (accès à l'état device depuis
l'exécuteur PowerShell) :

```ts
// PowerShellExecutor.ts:166
get extraIPs() {
  return (this.device as unknown as { extraIPs: Map<...> }).extraIPs;
}
```

Ce motif révèle un **contrat d'interface manquant** : `PSDeviceContext` ne
déclare pas ces membres, donc chaque accès re-caste. La bonne réponse n'est pas
plus de casts mais **une interface device explicite** que les cmdlets consomment.

**Recommandation :** définir les interfaces de contexte manquantes
(`PSDeviceContext`, contextes de shells Cisco/Huawei) et supprimer les casts par
vagues. Interdire `as unknown as` en règle ESLint (`no-restricted-syntax`) une
fois le stock résorbé.

---

## 3. Sources de vérité multiples / état parallèle (🔴)

Déjà documenté en détail dans **`ps-vs-cmd.md`** (livré séparément). Résumé du
défaut de conception, car il est **systémique** et pas limité à Windows :

- `PowerShellExecutor` maintient `extraIPs`, `extraRoutes`, `adapterOverrides`
  — des magasins que le chemin CMD ne lit jamais. `New-NetIPAddress` (PS) ne
  configure pas l'interface réelle ; `ipconfig` (CMD) ne le voit pas.
- Des cmdlets renvoient des données **fabriquées** ignorant l'état machine :
  `Resolve-DnsName` → `192.168.1.1` codé en dur, `Get-NetTCPConnection` →
  connexions inventées.
- 241 marqueurs `stub / placeholder / fabricated / hardcoded / simulate` dans
  le code non-test — chacun est une divergence potentielle entre « ce que la
  commande affiche » et « l'état réel du device ».

Le **bon patron existe déjà** (le pare-feu : `dynamicFirewallRules` partagé au
niveau device, lu/écrit par les deux shells). Il doit être **généralisé** :
_aucune couche de présentation (shell, cmdlet) ne possède d'état ; elle
lit/écrit exclusivement l'`Equipment`._

---

## 4. Couplage central extrême — les « god nodes » (🟠)

Fan-in inter-fichiers (nombre de fichiers qui dépendent de la cible) :

| Fan-in | Module | Diagnostic |
|---|---|---|
| **4 560** | `src/network/core/types.ts` | Fourre-tout : types de frames **+** adresses **+** constantes **+** helpers (`resetCounters`, checksums). 1 009 arêtes sur le seul symbole fichier. |
| 1 625 | `src/network/core/Logger.ts` | Singleton de log omniprésent |
| 1 538 | `src/database/engine/executor/ResultSet.ts` | `queryResult()` : 873 références |
| 1 308 | `src/events/EventBus.ts` | Bus réactif global |
| 1 279 | `src/network/devices/DeviceFactory.ts` | `resetDeviceCounters()` : 639 références |

`types.ts` est le point de fragilité n°1 : **toute modification y recompile et
re-teste la moitié du projet**, et tout couplage cyclique passera par lui.
Un fichier `core/types.ts` avec 131 symboles mélangeant valeurs (`IPAddress`,
`MACAddress`, classes) et types purs empêche le *tree-shaking* et brouille les
frontières de modules.

**Recommandation :** scinder `types.ts` en modules cohérents
(`addressing.ts`, `frames.ts`, `constants.ts`, `checksums.ts`) et sortir les
helpers muables (`resetCounters`) qui n'ont rien à faire dans un module de
types. Idem : `Logger`/`EventBus` en injection de dépendance plutôt qu'imports
directs, pour tester les protocoles en isolation.

---

## 5. Fichiers-monstres — la complexité n'est pas découpée (🟠)

32 fichiers dépassent 1 500 LOC. Le top :

| LOC | Fichier |
|---|---|
| **6 242** | `src/network/devices/windows/PowerShellExecutor.ts` |
| **6 211** | `src/network/devices/linux/LinuxCommandExecutor.ts` |
| 4 756 | `src/network/ipsec/IPSecEngine.ts` |
| 4 385 | `src/network/devices/shells/CiscoSwitchShell.ts` |
| 4 282 | `src/database/oracle/OracleExecutor.ts` |
| 3 853 | `src/network/ospf/OSPFEngine.ts` |
| 3 175 | `src/network/devices/windows/WinNetsh.ts` |

`PowerShellExecutor.ts` est un **dispatcher de 6 242 lignes** : une cascade de
`if (cmdLower === '...')` avec les handlers inline. Ce fichier concentre à lui
seul les problèmes §2 (casts device) et §3 (état parallèle). Un tel fichier est
impossible à revoir en entier, tue les temps de compilation incrémentale, et
maximise les conflits de merge (déjà observé : la branche a divergé pendant
cette session).

**Recommandation :** extraire un **registre de commandes** (`Map<string,
CommandHandler>`) où chaque cmdlet est un module autonome testable — le pattern
`psGetService`/`PSServiceCmdlets.ts` (déjà externalisé) montre la voie. Viser
< 800 LOC par fichier.

---

## 6. Défaut concret : fichier source corrompu (🟠, correctif rapide)

```
src/powershell/cmdlets/core/CollectionCmdlets.ts
  → détecté comme binaire ("data") par file(1)
  → 1 octet NUL (0x00) à l'offset 27489
  → séquence UTF-8 cassée dans un commentaire (« ─────� »)
```

Un octet NUL dans un `.ts` est un vrai défaut : il casse certains outils
(diff, grep sans `-a`, éditeurs, parfois les parseurs). Probablement une
corruption d'édition passée inaperçue faute de vérification d'encodage en CI.

**Recommandation :** réécrire le fichier en UTF-8 propre (retirer le NUL,
restaurer le `─`), et ajouter un garde-fou CI (`git grep -Ip '\x00'` ou
`file`-check) pour empêcher la réintroduction.

---

## 7. Filet de tests en trompe-l'œil (🟠)

Le ratio brut est excellent — **1 304 fichiers de test pour 1 809 sources**.
Mais :

- La **couverture n'est mesurée et seuillée que sur un seul sous-système** :
  ```ts
  // vite.config.ts:46
  coverage: { include: ['src/network/protocols/ssh/**/*.ts'],
              thresholds: { lines: 85, branches: 75, ... } }
  ```
  Les 6 242 lignes de `PowerShellExecutor`, tout Oracle, OSPF, IPSec, etc. **ne
  sont soumis à aucun seuil**. On ne sait donc pas ce qui est réellement testé
  au-delà de SSH.
- Une partie des suites `src/__tests__/debug/**` sont, d'après `CLAUDE.md`, des
  **dumps de transcript** sans assertions — utiles au diagnostic mais qui
  **gonflent le compte de tests sans protéger contre les régressions**.

**Recommandation :** étendre le périmètre de couverture (au moins en *report*,
sans seuil bloquant au début) à tout `src/`, puis fixer des seuils par
sous-système. Distinguer clairement, dans le compte, tests d'assertion vs dumps
de diagnostic.

---

## 8. Fragilités de moindre priorité (🟡)

- **Dispatch vendeur par nom de classe.** `vite.config.ts` force
  `keepNames: true` / `minify:'esbuild'` parce que du code compare
  `instance.constructor.name === 'WindowsPC'` (7 sites de dispatch par nom).
  C'est fragile : un renommage, un wrapper, ou un bundler mal configuré casse
  silencieusement la logique. Préférer un discriminant explicite
  (`deviceKind: 'windows-pc'`) ou du polymorphisme.
- **`@typescript-eslint/no-unused-vars` désactivé projet-wide**
  (`eslint.config.js:23`). Combiné à `noUnusedLocals:false`, le code mort
  s'accumule sans signal — sur une base de cette taille, c'est de la dette
  invisible.
- **Journaux de refactoring volumineux versionnés au niveau racine**
  (`REFACTORING-JOURNAL.md` 242 symboles, `JOURNAL-DE-BORD.md` 307,
  `GAP.md` 135…). Utile historiquement, mais leur place est `docs/`, pas la
  racine, pour ne pas noyer les fichiers de projet.

---

## 9. Ce qui est bien fait (à préserver)

Pour l'équilibre — ces choix sont solides et servent de modèle interne :

- **Architecture pilotée par l'équipement** sans médiateur central : les
  devices traitent leurs propres trames (bon découplage conceptuel).
- **Le patron protocolaire réactif** (`<Protocol>Engine + types + events +
  observables + actors`) est **cohérent et répété** — exactement ce qu'on veut.
- **Le partage d'état device qui marche** : `WindowsServiceManager`,
  `WindowsProcessManager`, `dynamicFirewallRules` prouvent que la « source
  unique de vérité » est atteignable ici — il faut la généraliser.
- **Extraction de commandes déjà amorcée** (`PSServiceCmdlets`,
  `WinNetsh` séparé) : le chemin de sortie des fichiers-monstres est tracé.

---

## 10. Feuille de route recommandée

**Quick wins (jours) :** #5 fichier corrompu · #8 ESLint no-unused-vars ON ·
ranger les journaux dans `docs/`.

**Court terme (semaines) :** #3 généraliser le patron « pas d'état dans la
présentation » en commençant par les divergences de `ps-vs-cmd.md` · #7
étendre le report de couverture à tout `src/`.

**Moyen terme (trimestre) :** #1 activer `strictNullChecks` par vagues · #2
introduire les interfaces de contexte et éliminer `as unknown as` · #4 scinder
`core/types.ts` · #5 découper `PowerShellExecutor` / `LinuxCommandExecutor` en
registres de commandes.

**Invariant directeur à graver :** _le typage protège, il ne se contourne
pas ; l'état vit sur l'`Equipment`, la présentation ne fait que le lire._

---

*Graphe interrogeable généré dans `graphify-out/` (git-ignoré). Rejouer :
`graphify update .` ; explorer : `graphify query "..."`,
`graphify explain "WindowsPC"`, `graphify path "A" "B"`.*

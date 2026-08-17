# Carnet de bord — FortiGate / FortiOS

> Ce carnet existe pour qu'un autre agent puisse **reprendre le travail
> sans me poser de question**. Il dit où en est le module, ce qui a été
> décidé et pourquoi, ce qui est en cours, et quoi faire ensuite.
>
> Il enregistre **ce qui a été mesuré**, pas ce qui était prévu. Quand la
> mesure contredit le BRD, c'est la mesure qui est écrite ici et le BRD
> qui est corrigé.

| | |
|---|---|
| **BRD** | `docs/BRD-FortiGate.md` — 6019 lignes, 44 chapitres, 230 exigences |
| **BRD du socle** | `docs/BRD-Firewall.md` — prérequis de lecture |
| **Carnet du module** | `docs/JOURNAL-FIREWALL.md` — entrées E0…E32, défauts B1…B43 |
| **Code** | `src/network/devices/firewall/vendors/fortios/` |
| **Tests** | `src/__tests__/unit/network-v2/firewall/fortios-*.test.ts` |
| **E2E** | `e2e/fortigate-*.spec.ts` |
| **Branche** | `mandeng` |

---

## 1. Où en est le module — état au dernier commit

| Phase (BRD §39) | Contenu | État |
|---|---|---|
| — | Déclinaison initiale : profil, shell à deux tables, 32 cas | ✅ livrée (E31) |
| **1** | **La grammaire : schéma déclaratif, navigateur, trois rendus** | ✅ livrée (E32) |
| **1b** | **Migration sur le moteur de commandes partagé `src/cli/`** | ✅ livrée |
| **2** | Système et objets : `system *`, `addrgrp`, `service`, `schedule`, `router static` | ✅ livrée |
| 3 | NAT complet : `ippool`, `vip`, `central-snat-map`, `router policy` | ⏳ |
| 4 | Diagnostic et journaux | ⏳ |
| 5 | VDOM et modes de déploiement | ⏳ |
| 6 | Inspection et UTM | ⏳ |
| 7 | Utilisateurs et authentification | ⏳ |
| 8 | VPN | ⏳ |
| 9 | HA et SD-WAN | ⏳ |
| 10 | Routage dynamique (chantier de socle) | ⏳ |

**Mesures au dernier commit** : 810 cas verts sur 30 fichiers du module
pare-feu ; 92 cas FortiOS (32 d'origine + 60 de grammaire) ; 4 specs
Playwright ; typecheck à la base ; lint identique.

---

## 2. Ce qui est décidé, et qu'il ne faut pas re-décider

Ces décisions sont prises, argumentées, et coûteuses à défaire. Un agent
qui reprend doit les connaître avant de toucher au code.

| # | Décision | Où c'est argumenté |
|---|---|---|
| **D1** | La grammaire est portée par un **schéma déclaratif**, jamais par du code par table | BRD §14, principe F1 |
| **D2** | Le schéma porte les **valeurs par défaut** — sans elles `show` et `get` ne peuvent pas différer, et `unset` ne peut pas se distinguer de `delete` | BRD §15, principe F2 |
| **D3** | `onCommit` est le **seul** point d'écriture vers les magasins du socle | BRD §14.5 |
| **D4** | Aucun moteur, aucune liste blanche, aucun verdict de paquet dans `vendors/fortios/` — garde-fous G1, G6 mécaniques | `architecture-guards.test.ts` |
| **D5** | `always` n'est pas un horaire mais **l'absence de restriction** : il se traduit `undefined` vers le socle | Défaut B41 |
| **D6** | La position d'une règle dans sa table est portée par le **contexte de commit**, jamais reconstituée | Défaut B40 |
| **D7** | Un attribut non simulé est **refusé** en nommant la brique manquante, jamais accepté inerte | BRD principe F6 |
| **D8** | Les notes de simulateur sont préfixées `NOTE:` et **supprimables** | BRD §17.4 |
| **D9** | La sérialisation de topologie **est** le texte de `show full-configuration` ; d'où l'exigence que cette sortie soit rejouable | BRD §34.2 |
| **D10** | **Le moteur de commandes est celui de `src/cli/`** — pas un second | §3 ci-dessous |

---

## 3. D10 — pourquoi le moteur de commandes partagé

**Le constat.** La phase 1 a livré une aide et une complétion écrites
dans `FortiShell` : une liste de verbes par contexte, un filtre par
préfixe, un rendu en deux colonnes. Cela fonctionne et c'est un **second
moteur** — alors que `src/cli/` en porte un, écrit pour Cisco et l'ASA,
qui fait davantage et mieux :

| Ce que `src/cli/` donne | Ce que la phase 1 faisait |
|---|---|
| Arguments **typés** (`INT` borné, `IP_ADDR`, `ENUM`…) | Types maison, validés à part |
| `?` rendant la **plage réelle** (`<0-32>`) | Le nom de l'attribut |
| Valeurs énumérées **décrites** une par une | Décrites, mais par un second chemin |
| Plusieurs **formes** pour une même place (`alternatives`) | Absent |
| **Abréviations** non ambiguës | Absent |
| **Ambiguïté** nommée plutôt que premier arrivé | Absent |
| `<cr>` quand la commande est complète | Absent |
| Filtrage par **atteignabilité** du sous-arbre | Absent |
| Complétion `TAB` distincte de `?` | Un seul comportement |

**La difficulté, et sa réponse.** FortiOS n'est pas une CLI à
mots-clés : les commandes légales dépendent de l'endroit où l'on est dans
l'arbre de configuration, et les attributs dépendent de l'objet ouvert.
Une `CommandTable` statique ne peut pas l'exprimer.

**La réponse retenue** : une `CommandTable` est **construite par
contexte**, à partir du schéma, et mise en cache. Un contexte est
(chemin de schéma, signature de disponibilité de l'objet). Chaque table
est petite — quelques dizaines de nœuds — et il n'y a **qu'un seul
moteur** : `parseCommand` décide de ce qui est légal, `complete` rend les
suggestions, et les gestionnaires appellent le navigateur qui mute.

**Le gain qui n'était pas prévu** : les références se complètent pour de
bon. Comme la table est bâtie à la demande, `set srcaddr ?` peut lister
les objets adresse **qui existent réellement**, ce qu'une table statique
ne saurait pas faire.

**Conséquence sur le BRD** : §14 est réécrit — le schéma décrit *ce qui
existe*, le moteur partagé décide *ce qui est légal et ce qui se
propose*. Les deux ne se recouvrent plus.

---

## 4. Carte du code

```
src/cli/                                  ← LE moteur, partagé (ne pas dupliquer)
├── ArgumentTypes.ts        ArgumentSpec, ARGUMENT_TYPES, argumentAccepts,
│                           argumentSuggestions, argumentPlaceholder
├── CommandTable.ts         CommandSpec, l'arbre, l'atteignabilité
├── CommandParser.ts        parseCommand, abréviations, ambiguïté
├── CompletionEngine.ts     complete(TAB | QUESTION_MARK), <cr>
├── CliSession.ts           mode, privilège, champs de contexte, invite
└── CliEngine.ts            exécution + messages IOS

src/network/devices/firewall/vendors/fortios/
├── FortiGate.ts            l'équipement
├── FortiProfile.ts         le profil (contrat de déclinaison)
├── FortiShell.ts           l'aiguilleur — ne connaît aucune table
├── FortiMessages.ts        le catalogue de messages, trois familles
├── FortiSocle.ts           ← construit la CommandTable par contexte
├── schema/
│   ├── types.ts            FortiTableSpec, FortiAttributeSpec
│   ├── index.ts            assemblage + schemaIndex()
│   ├── firewallPolicy.ts   config firewall policy
│   ├── firewallObjects.ts  config firewall address (+ phase 2)
│   ├── system.ts           ← phase 2
│   └── router.ts           ← phase 2
├── runtime/
│   ├── FortiObject.ts      un objet : valeurs explicites + défauts
│   ├── FortiTable.ts       une table : ordre, clés, clone/rename/move
│   ├── FortiConfigTree.ts  l'arbre des tables
│   ├── FortiNavigator.ts   la pile et les 18 verbes
│   └── FortiValidator.ts   validation (délègue à argumentAccepts)
└── render/
    ├── showRenderer.ts     show et show full-configuration
    └── getRenderer.ts      get
```

---

## 5. Les pièges déjà rencontrés

Un agent qui reprend gagnera du temps à les connaître.

| # | Piège | Comment il se manifeste |
|---|---|---|
| **P1** | `remove` puis `append` dans `onCommit` | Rééditer une règle la **remonte en fin de table**, donc change l'ordre d'évaluation. Utiliser `insertAt` avec `context.position`. |
| **P2** | Passer `schedule: 'always'` au socle | `PolicyEvaluator` refuse une règle dont l'horaire n'est pas évaluable → **aucune correspondance**, donc `ping` à 100 % de perte et NAT sans effet. Deux symptômes, une cause. |
| **P3** | `session as LinuxTerminalSession` dans `TerminalView` | Toute session déclarant `getSessionType() === 'linux'` traverse le chemin de rendu Linux. **Le terminal ne s'ouvre pas du tout** — l'arbre React tombe. Corrigé par des défauts sur `TerminalSession`. |
| **P4** | `strict: false` dans `tsconfig.app.json` | Les unions discriminées **ne se rétrécissent pas**. Un `{ok:true}\|{ok:false}` ne compile pas ; utiliser une forme plate. |
| **P5** | Les tests unitaires ne voient pas l'interface | `createSessionForDevice` rendait une session pendant que le terminal plantait. **Toute phase doit livrer une spec Playwright.** |
| **P6** | `FortiTerminalSession.getSessionType()` rend `'linux'` | Choix assumé pour le thème ; c'est ce qui expose P3. Ne pas le changer sans mesurer le thème et le collage. |

---

## 6. Ce qu'il faut faire ensuite — dans l'ordre

### 6.1 Phase 1b — migration sur le moteur partagé — ✅ livrée

`FortiAttributeSpec` porte des `ArgumentSpec` de `src/cli/` ;
`FortiSocle` bâtit une `CommandTable` par contexte, mise en cache sur
(chemin, attributs disponibles, empreinte des références) ; `FortiShell`
délègue l'analyse et la complétion ; `FortiValidator` délègue à
`argumentAccepts`.

**Ce qui a été ajouté au moteur partagé**, purement additif :
`TreeNode.legend` et `CommandTable.describePath()`. Un nœud
intermédiaire héritait de la description de son **premier descendant**,
donc `config ?` annonçait « Configure IPv4 addresses. » pour le mot
`config` — la description d'une branche pour le nom de toutes. Cisco a
le même défaut sur `show ?` ; la légende le referme pour les deux, et
l'héritage reste le comportement par défaut.

**Acquis mesurés** : abréviations, ambiguïté nommée, plages réelles dans
l'aide (`<0-32>`), `<cr>`, et — le gain non prévu — les **références se
complètent sur ce qui existe** (`set srcaddr ?` liste les objets
adresse réellement déclarés), parce que la table est bâtie à la demande.

74 cas de grammaire, 1054 cas verts sur `firewall/` + `cli/`, typecheck
**348** contre une base à **351**.

### 6.2 Phase 2 — système et objets — ✅ livrée

**Onze chemins de configuration** : `system global`, `system settings`,
`system interface` (+ VLAN, `allowaccess`), `system zone`, `system dns`,
`system dhcp server` (+ `ip-range`), `firewall addrgrp`,
`firewall service custom`, `firewall service group`,
`firewall schedule recurring`, `router static`. Plus le catalogue de
36 services d'usine (`schema/predefined.ts`).

**Deux prélèvements sur le socle**, les premiers des treize (BRD §31.2) :

- **`model/ScheduleObject.ts`** — l'objet horaire que `BRD-Firewall` §8.5
  spécifiait et que personne n'avait écrit, avec `ScheduleStore` et la
  règle de franchissement de minuit ;
- le branchement de **`PolicyEvaluator.scheduleActive`**, qui existait
  comme dépendance et **n'était câblé par personne** — une règle horaire
  était donc soit inévaluable, soit ignorée ;
- **`Firewall.setAllowedAccess` / `allowsAccess`**, et le filtre appliqué
  dans `deliverLocally`. Une interface qui n'admet pas `ping` ne répond
  pas à l'écho. Une interface **jamais configurée** répond, sans quoi
  chaque autre constructeur aurait perdu son ping.

**Défaut trouvé par la suite à l'aveugle, dans le moteur partagé** :
un horaire déclaré `WORD` avec un `literal: 'hh:mm'` annonçait `hh:mm` à
l'opérateur et **acceptait n'importe quoi** — `set start 25:99` passait.
Le `literal` décrit, il ne vérifie pas. `src/cli/ArgumentTypes.ts` gagne
le type **`TIME`**, qui sert aussi à IOS (`clock set`, `time-range`).

**Mesures** : 29 cas, **24 tombent** avant correctif. 1102 verts sur
`firewall/` + `cli/`. Typecheck **347** contre une base à **351**.

### 6.2 bis — Phase 2, ce qui reste

`config system ntp`, `config firewall schedule onetime`,
`config firewall schedule group`, `config system dhcp server` côté
data-plane (le schéma existe, le serveur DHCP réel n'est pas encore
branché), et `config system interface` avec `mode dhcp` (client DHCP).

### 6.3 Phase 2 — le plan d'origine, pour mémoire

| Chemin | Fichier |
|---|---|
| `config system global` | `schema/system.ts` |
| `config system settings` | idem |
| `config system interface` (+ `secondaryip`) | idem |
| `config system zone` | idem |
| `config system dns`, `config system ntp` | idem |
| `config system dhcp server` (+ `ip-range`, `reserved-address`) | idem |
| `config firewall addrgrp` | `schema/firewallObjects.ts` |
| `config firewall service custom` / `group` | idem |
| `config firewall schedule recurring` / `onetime` | idem |
| `config router static` | `schema/router.ts` |
| Catalogue prédéfini (BRD §44.2) | `schema/predefined.ts` |

**Prélèvement sur le socle**, le premier des treize (BRD §31.2) :

- l'**objet horaire** (`model/ScheduleObject.ts`), spécifié par
  `BRD-Firewall` §8.5 et jamais implémenté ;
- le branchement de `PolicyEvaluator.scheduleActive`, qui existe comme
  dépendance et **n'est câblé par personne**.

**Critère de sortie** : le laboratoire L1 du BRD se joue de bout en bout
dans un terminal graphique, et `allowaccess` refuse vraiment une
connexion.

### 6.3 Après

Suivre §39 du BRD. Chaque phase : revendiquer dans
`JOURNAL-FIREWALL.md`, livrer, discriminer par `git stash`, mettre à jour
ce carnet.

---

## 7. La procédure de livraison

Elle n'est pas négociable — c'est ce qui rend le travail reprenable.

1. **Revendiquer** le périmètre dans `docs/JOURNAL-FIREWALL.md` avant
   d'écrire (un autre agent travaille sur le même module).
2. Écrire les cas **à l'aveugle** : décrire ce qu'une vraie machine fait,
   sans lire l'implémentation d'abord. C'est ce qui a trouvé B40.
3. Tout cas nominal a son **témoin** — le cas où ça ne marche pas.
4. **Discriminer** : `git stash push -- src/network/devices/firewall/`,
   rejouer, compter les cas qui tombent, écrire le nombre.
5. Non-régression **du module seul** :
   `npx vitest run src/__tests__/unit/network-v2/firewall/`.
6. Au moins une spec **Playwright** par phase (voir P5).
7. Typecheck ≤ base, lint identique fichier par fichier.
8. Journal + carnet + BRD si la mesure l'a contredit.
9. Commit, push.

**Base de référence au dernier commit** : typecheck **347** erreurs
(le chiffre monte quand la branche intègre d'autres travaux — le
comparer, jamais le supposer).

---

## 8. Historique des mises à jour de ce carnet

| Date | Auteur | Ce qui change |
|---|---|---|
| 2026-08-17 | agent `mandeng` | Création. État après phase 1, décision D10, plan de phase 1b et 2. |

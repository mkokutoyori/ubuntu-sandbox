# PRD — Auto-complétion (Tab / `?`) dans les terminaux des équipements réseau

**Version** : 1.0
**Date** : 2026-07-08
**Projet** : Ubuntu Sandbox — simulateur réseau navigateur
**Auteur** : Claude (agent), à la demande de l'utilisateur
**Références normatives** :
- Comportement Cisco IOS réel (`Tab` = complétion unique ou aucune action
  si ambigu ; `?` = aide contextuelle avec marqueur `<cr>`)
- Comportement Huawei VRP réel (`Tab` **cycle** les candidats ambigus au lieu
  de ne rien faire — différence documentée vis-à-vis d'IOS)
- Comportement Microsoft PowerShell console réel (`Tab`/`Shift+Tab` cycle
  les candidats ; déjà fidèlement reproduit dans ce dépôt, voir §1.2)
- Comportement `bash`/`readline` réel (complétion de commande, de chemin,
  de variable, et complétion d'arguments par commande)

---

## 0. Contexte et portée du document

Ce PRD documente **l'auto-complétion (`Tab`) et l'aide contextuelle (`?`)**
dans les terminaux simulés de ce dépôt : Cisco IOS, Huawei VRP (routeur et
switch), bash (Linux), PowerShell/`cmd.exe` (Windows), et SQL*Plus (Oracle).
Contrairement à ce qu'un simple survol pourrait laisser penser, **la
majeure partie de cette fonctionnalité est déjà réelle et bien testée** —
ce document ne repart pas de zéro. Il se concentre sur les défauts et
lacunes précisément vérifiés par lecture de code : un branchement de touche
`Tab` manquant qui rend plusieurs sous-shells Linux totalement
non-fonctionnels au clavier (§1.3 item 1), l'absence de complétion
dynamique de valeurs (interfaces, VLANs réellement configurés) côté
Cisco/Huawei (§1.3 item 2), une différence de comportement vendor non
respectée côté Huawei (§1.3 item 3), et l'absence totale de complétion
côté SQL*Plus (§1.3 item 4).

Cette analyse est issue d'une lecture complète de
`src/terminal/core/TabCompletionHelper.ts`, `src/network/devices/shells/CommandTrie.ts`,
`src/network/devices/shells/CiscoShellBase.ts`, `src/network/devices/shells/HuaweiVRPShell.ts`,
`src/network/devices/shells/HuaweiSwitchShell.ts`, `src/terminal/sessions/CLITerminalSession.ts`,
`src/terminal/sessions/LinuxTerminalSession.ts`, `src/terminal/sessions/WindowsTerminalSession.ts`,
`src/terminal/subshells/PowerShellSubShell.ts`, `src/terminal/subshells/SqlPlusSubShell.ts`,
`src/network/devices/linux/LinuxCommandExecutor.ts`, `src/network/devices/LinuxMachine.ts`,
et des suites de tests existantes (`linux-command-completion.test.ts`,
`linux-completion.test.ts`, `autocomplete.test.ts`, `shell-keys-and-completion.test.ts`,
`command-trie-help-suggestions.spec.ts`, `huawei-vrp.test.ts`, `huawei-switch-shell.test.ts`,
`windows-filesystem.test.ts`). Aucun PRD/BRD/gap-analysis existant ne traite
ce sujet formellement — une entrée informelle (`plan.md:91`) évoque une idée
future de « ghost text » inline non implémentée et hors périmètre ici.

Aucune ligne de code n'est écrite dans le cadre de ce document — il sert de
base à la planification et à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel |
|---|---|
| `src/terminal/core/TabCompletionHelper.ts` | Utilitaire pur (`completeInput`/`completeInputCaseInsensitive`) : complète vers le préfixe commun le plus long ou liste les suggestions (plafonné à 30). Ne calcule aucun candidat lui-même — consommé par `LinuxTerminalSession.ts:1660` et `WindowsTerminalSession.ts:1742,1758` |
| `src/network/devices/shells/CommandTrie.ts` | Trie de commandes Cisco/Huawei : `getCompletions()` (l. 384-439) pour `?`, `tabComplete()` (l. 450-512) pour `Tab`. Complète uniquement les **nœuds statiques** (verbes de commande, mots-clés enregistrés) ; les `ParamType` (`INTERFACE`, `VLAN_LIST`, `IP_ADDR`, …, l. 21, 566-580) ne servent qu'à la **validation**, jamais à la complétion dynamique (§1.3 item 2) |
| `src/network/devices/shells/CiscoShellBase.ts`, `HuaweiVRPShell.ts`, `HuaweiSwitchShell.ts` | Chacun expose `tabComplete()`/`getHelp()` en délégant à son propre `CommandTrie`. Branchement réel confirmé jusqu'à l'UI (`CLITerminalSession.ts:507-534`, `176-179`) |
| `src/network/devices/linux/LinuxCommandExecutor.ts`, `LinuxMachine.ts` | `getCompletions()` : commande (liste statique `KNOWN_LINUX_COMMANDS`), chemin (`getPathCompletions`, gère `~`, dotfiles, `/` final), variable d'environnement, `man <préfixe>`, délégation `sudo <cmd>`. Complétion d'arguments par commande (`complete(ctx, args)`) implémentée dans **6 fichiers sur 53** sous `src/network/devices/linux/commands/` (`Arp.ts`, `Ifconfig.ts`, `Dhclient.ts`, `Ping.ts`, `Route.ts`, `Sysctl.ts`) |
| `src/terminal/subshells/PowerShellSubShell.ts` | `getCompletions()` (l. 325-457) : variables/`$env:`, paramètres de cmdlet (registre live), noms de commande/alias (registre live), conscient du pipeline (`|`,`;`,`&`), chemins via `WindowsFileSystem`. Cycling `Tab`/`Shift+Tab` réel dans `WindowsTerminalSession.ts:1694-1746` (`onSubShellTab`) |
| `src/network/devices/WindowsPC.ts` | `cmd.exe` (hors PowerShell) : liste statique d'une trentaine de commandes (l. 2035-2067) + complétion de chemin — pas de complétion de paramètre/flag |
| `src/terminal/sessions/LinuxTerminalSession.ts` | `handleSubShellKey()` (l. 3224-3339) gère `Enter`/flèches/`Ctrl+L`/`Ctrl+C`/`Ctrl+D` pour tout `activeSubShell` (SQL*Plus, SFTP, FTP, nslookup, rman, adaptateurs `IShell` type SSH cross-vendor) — **aucun `case 'Tab'`** : la touche tombe dans le `return false;` final (§1.3 item 1) |
| `src/terminal/subshells/SqlPlusSubShell.ts` | Implémente `ISubShell` mais n'a **aucune** méthode `getCompletions` — aucune complétion de mot-clé SQL, de table ou de colonne à aucune couche (§1.3 item 4) |
| `src/terminal/subshells/ISubShell.ts` | `getCompletions?(line): string[]` déclarée optionnelle (l. 73) ; seul `PowerShellSubShell` l'implémente parmi les sous-shells de `LinuxTerminalSession` — `SftpSubShell`, `FtpSubShell`, `NslookupSubShell`, `RmanSubShell`/`ReactiveRmanSubShell` n'ont rien, et les adaptateurs `IShell` (`LinuxBashShell.ts:148`, `RmanShell.ts:43`, `CrossVendorRemoteShell.ts:180` via `ShellSubShellAdapter.ts:72-73`) qui l'implémentent sont inatteignables depuis `LinuxTerminalSession` du fait de l'item 1 |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

- **Cisco IOS et Huawei VRP (routeur + switch)** : `Tab` et `?` sont
  entièrement réels et testés de bout en bout — abréviation de commande
  (`sh` → `show`), listage `?` avec marqueur `<cr>`, distinction
  `"sh?"`/`"show ?"` fidèle au comportement IOS réel. Confirmé par
  `command-trie-help-suggestions.spec.ts`, `switch-cli.test.ts:700-727`,
  `huawei-vrp.test.ts:891-1018`, `huawei-switch-shell.test.ts`.
- **PowerShell** est la complétion la plus riche du dépôt : variables,
  `$env:`, paramètres de cmdlet, commandes/alias, conscience du pipeline,
  et un vrai cycling `Tab`/`Shift+Tab` façon console réelle — confirmé par
  `autocomplete.test.ts` (215 lignes, y compris l'assertion explicite
  « pas un stub plafonné à 20 » pour `Get-<Tab>`).
- **bash top-niveau (Linux)** : complétion de commande, de chemin (avec
  gestion `~`, dotfiles, slash final pour les répertoires), de variable
  d'environnement, `man`, délégation `sudo` — tout confirmé réel par
  `linux-completion.test.ts`/`linux-command-completion.test.ts`. Les 6
  commandes avec complétion d'argument dédiée (`arp`, `ifconfig`,
  `dhclient`, `ping`, `route`, `sysctl`) sont réelles et testées, pas des
  stubs.
- **SSH cross-vendor (device distant)** : appuyer sur `Tab` après un `ssh`
  vers un autre équipement transmet bien la touche à la session distante,
  qui répond avec sa propre complétion — confirmé par
  `shell-keys-and-completion.test.ts:72-81`. Ce chemin utilise un mécanisme
  de session imbriquée distinct de `handleSubShellKey` (§1.1) et n'est
  **pas affecté** par le défaut de l'item 1 ci-dessous.

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **`Tab` est un no-op silencieux pour tout sous-shell hébergé par le terminal Linux** (SQL*Plus, SFTP, FTP, nslookup, rman, et tout adaptateur `IShell` poussé comme sous-shell) — `handleSubShellKey()` (`LinuxTerminalSession.ts:3224-3339`) n'a aucun `case 'Tab'` et retourne `false`, donc `TerminalView.tsx` n'appelle jamais `preventDefault()` : la touche s'échappe vers la navigation-focus native du navigateur au lieu d'être interceptée par la simulation. Asymétrique avec `WindowsTerminalSession`, qui a un `onSubShellTab` générique déjà câblé pour son équivalent PowerShell. | Comportement attendu de tout terminal simulé — et parité avec `WindowsTerminalSession` déjà réelle dans ce même dépôt | **Majeure** (régression d'expérience clavier complète, aucun test ne la couvre — silencieuse) |
| 2 | **Aucune complétion dynamique de valeur côté Cisco/Huawei.** `CommandTrie.tabComplete()` ne complète que les nœuds statiques (verbes, mots-clés déclarés) ; les `ParamType` comme `INTERFACE`/`VLAN_LIST` ne sont utilisés qu'en validation. `Tab` après `interface Gi` ne propose jamais les interfaces réellement câblées de l'équipement (`Gi0/1`, `Gi0/2`, …), ni `Tab` après `switchport trunk allowed vlan` les VLANs réellement créés. | Comportement Cisco IOS/Huawei VRP réel, où la complétion s'étend aux valeurs de contexte (interfaces existantes, VLANs configurés) | Moyenne (fonctionnalité manquante, pas un bug de régression, mais c'est la complétion la plus utile en pratique sur du matériel réel) |
| 3 | **Huawei ne cycle pas les candidats ambigus au `Tab`, contrairement au VRP réel.** `CommandTrie.tabComplete()` retourne `null` pour toute entrée ambiguë, identiquement pour Cisco et Huawei — confirmé par `huawei-vrp.test.ts:997-1002` (« should return null for ambiguous input »). Sur du matériel Huawei réel, `Tab` cycle successivement les candidats possibles ; sur Cisco IOS réel, `Tab` ne fait effectivement rien sur une entrée ambiguë (ce qui rend le comportement Cisco actuel du simulateur correct). | Comportement VRP réel documenté (cycling) vs IOS réel (no-op) | Mineure (écart de fidélité vendor, pas un défaut fonctionnel côté Cisco) |
| 4 | **SQL*Plus n'a aucune complétion, à aucune couche.** `SqlPlusSubShell` n'implémente pas `getCompletions`, et même s'il le faisait, l'item 1 empêcherait `Tab` de l'atteindre. Aucun mot-clé SQL (`SELECT`, `FROM`, `WHERE`, `COMMIT`…), aucun nom de table/colonne réel du schéma connecté, aucune commande SQL*Plus (`DESC`, `SET`, `SPOOL`) ne se complète. | Complétion SQL*Plus réelle (noms d'objets du catalogue, mots-clés) | Moyenne |
| 5 | **`cmd.exe` (hors PowerShell) n'a pas de complétion de paramètre/flag** — liste statique de ~30 commandes + chemins uniquement, alors que `cmd.exe` réel a une complétion de chemin similaire mais reste de toute façon limité côté flags nativement (écart mineur, `cmd.exe` réel n'a lui-même pas de vraie complétion de flag). | Comportement `cmd.exe` réel (déjà limité nativement) | Mineure |
| 6 | **47 des 53 commandes réseau Linux n'ont pas de complétion d'argument dédiée** — retombent silencieusement sur la complétion de chemin générique, souvent inadaptée pour une commande qui attend un flag plutôt qu'un fichier. | Richesse de complétion déjà pratiquée pour les 6 commandes instrumentées (`arp`, `ifconfig`, `dhclient`, `ping`, `route`, `sysctl`) | Mineure (ampleur, pas absence de conception) |

---

## 2. Objectifs

Chaque fonctionnalité ci-dessous est livrée **complète** et, dès lors qu'un
équipement/terminal des deux vendors ou plateformes couverts par ce
simulateur (Cisco IOS, Huawei VRP, Linux, Windows, Oracle) la supporte,
elle est corrigée/testée **pour toutes les plateformes concernées**, avec
la syntaxe et la sémantique propres à chacune. Les items 6 à 9 délimitent
explicitement ce que ce PRD **ne traite pas**.

1. **Corriger le no-op de `Tab` dans les sous-shells Linux (item 1) —
   vendor-neutre, priorité la plus haute.** Ajouter un `case 'Tab'` (et
   `Shift+Tab`) à `handleSubShellKey()` mirroré sur le pattern déjà réel de
   `WindowsTerminalSession.onSubShellTab` : appeler
   `activeSubShell.getCompletions?.(line)` quand la méthode existe, cycler
   les candidats sur appuis répétés, et retourner `true` (donc déclencher
   `preventDefault()`) dans tous les cas pour empêcher la fuite vers le
   focus natif du navigateur — même quand le sous-shell actif n'implémente
   pas encore `getCompletions`. Ce correctif rend immédiatement
   fonctionnels, sans travail supplémentaire, tous les adaptateurs `IShell`
   qui exposent déjà `getCompletions` mais en étaient coupés (SFTP/FTP via
   `LinuxBashShell`, rman via `RmanShell`, SSH cross-vendor imbriqué via
   `CrossVendorRemoteShell`).
2. **Complétion dynamique de valeurs pour Cisco et Huawei (item 2) —
   scope initial : interfaces et VLANs.** Étendre `CommandTrie` pour
   accepter un résolveur de candidats dynamiques par `ParamType`, câblé
   côté `CiscoShellBase`/`HuaweiVRPShell`/`HuaweiSwitchShell` pour au moins
   `INTERFACE` (interfaces réellement présentes sur l'équipement) et
   `VLAN_LIST`/VLAN unique (VLANs réellement créés) — sans dégrader la
   complétion statique déjà testée (`command-trie-help-suggestions.spec.ts`).
   Router et switch, Cisco et Huawei.
3. **Cycling des candidats ambigus au `Tab` pour Huawei (item 3) —
   parité vendor.** Sur `Tab` répété face à une entrée ambiguë, VRP doit
   cycler ses candidats (à l'instar du pattern déjà réel pour PowerShell,
   `WindowsTerminalSession.onSubShellTab`) — le comportement Cisco actuel
   (no-op sur ambiguïté) reste inchangé, `huawei-vrp.test.ts:997-1002` étant
   réécrit pour refléter le nouveau comportement Huawei uniquement.
4. **Complétion SQL*Plus — mots-clés et catalogue réel (item 4).**
   Implémenter `getCompletions` sur `SqlPlusSubShell` : mots-clés SQL/SQL*Plus
   de base (`SELECT`, `FROM`, `WHERE`, `INSERT`, `UPDATE`, `DELETE`,
   `COMMIT`, `ROLLBACK`, `DESC`, `SET`, `SPOOL`), puis noms de table réels
   du schéma connecté après `FROM`, puis noms de colonne réels de la table
   référencée après `SELECT`/une virgule, en s'appuyant sur le catalogue
   Oracle déjà existant (`OracleCatalog`/`OracleDatabase`). Dépend de
   l'item 1 pour être réellement atteignable au clavier.
5. **Étendre la complétion d'argument dédiée aux commandes réseau Linux
   restantes (item 5).** Les 47 commandes sur 53 sans `complete()` dédié
   (§1.3 item 6) retombent aujourd'hui sur la complétion de chemin
   générique, souvent inadaptée pour une commande qui attend un flag.
   Auditer ces 47 commandes, prioriser par fréquence d'usage réelle dans
   les suites de tests/tutoriels du dépôt, et leur ajouter un `complete()`
   dédié (flags, arguments contextuels — interfaces, PID, adresses connues,
   selon la commande) jusqu'à couverture complète.
6. **Complétion de paramètre/flag pour `cmd.exe` (item 6).** Par symétrie
   avec la richesse déjà réelle du sous-shell PowerShell (§1.2), doter
   `cmd.exe` (`WindowsPC.ts`) d'une complétion de flag/paramètre pour ses
   commandes internes, au-delà de la liste statique de noms de commande et
   de la complétion de chemin déjà réelles.
7. **Complétion dynamique pour des `ParamType` additionnels, Cisco et
   Huawei (item 7).** Étendre le résolveur dynamique introduit en Phase 2
   (item 2) au-delà d'`INTERFACE`/VLAN : adresses IP déjà configurées sur
   l'équipement, numéros d'ACL existants, hostnames appris (ARP/DNS) —
   mêmes garde-fous qu'en Phase 2 (additif, ne dégrade pas la complétion
   statique existante).
8. **Hors périmètre — déjà réel et solide, non retouché.** Complétion
   PowerShell (variables, paramètres, commandes, cycling, chemins),
   complétion bash top-niveau (commande, chemin, variable, `man`, `sudo`),
   les 6 commandes Linux déjà instrumentées (`arp`, `ifconfig`, `dhclient`,
   `ping`, `route`, `sysctl`), aide contextuelle `?`/complétion statique
   Cisco/Huawei déjà réelle, transmission de `Tab` au device distant via
   SSH cross-vendor.
9. **Ghost text — prévisualisation inline de la complétion (demandé en
   cours de PRD).** Quand exactement une complétion existe pour la saisie
   courante, le terminal affiche le reste en gris derrière le curseur ;
   `→` (flèche droite) en fin de ligne l'accepte. Couvre Cisco/Huawei,
   bash et cmd, en réutilisant la source de complétion réelle de chaque
   terminal (donc y compris les valeurs dynamiques de l'équipement).
10. **Complétabilité universelle des commandes greedy (demandé en cours de
   PRD).** Les ~1469 commandes enregistrées en `registerGreedy` analysent
   leurs sous-mots-clés dans le handler (`show interfaces status`,
   `display interface brief`, …), invisibles du trie. Exigence : chaque
   commande implémentée est complétable, sans annotation manuelle par
   commande — les mots-clés sont extraits automatiquement du source du
   handler (comparaisons littérales contre le paramètre `args` et ses
   alias), avec les entrées curées en priorité pour les descriptions.

---

## 3. Plan de remédiation détaillé

### Phase 1 — Corriger le no-op de `Tab` dans les sous-shells Linux (item 2-1)

- **Fichiers touchés** : `src/terminal/sessions/LinuxTerminalSession.ts`
  (`handleSubShellKey()`, l. ~3224-3339) uniquement — aucun changement de
  signature sur `ISubShell.getCompletions` (déjà optionnelle).
- **Détail** : ajouter un `case 'Tab'`/`'Shift+Tab'` reprenant le pattern
  déjà réel de `WindowsTerminalSession.onSubShellTab` (l. 1694-1746) :
  premier `Tab` insère/affiche le premier candidat, appuis répétés cyclent,
  `Shift+Tab` cycle en arrière ; retourne toujours `true` (même en
  l'absence de `getCompletions` sur le sous-shell actif) pour garantir
  `preventDefault()` et empêcher la fuite vers le focus natif du
  navigateur.
- **Tests** : nouveau fichier `linux-subshell-tab-completion.test.ts` —
  `Tab` dans un sous-shell SFTP/FTP/nslookup/rman (candidats réels si
  `getCompletions` existe déjà via l'adaptateur `IShell` sous-jacent, sinon
  no-op silencieux mais `handleKey` retourne bien `true`), régression de
  `shell-keys-and-completion.test.ts` (le chemin SSH cross-vendor imbriqué
  ne doit pas changer de comportement).

### Phase 2 — Complétion dynamique interfaces/VLANs, Cisco et Huawei (item 2-2)

- **Fichiers touchés** : `src/network/devices/shells/CommandTrie.ts`
  (ajout d'un résolveur de candidats dynamiques optionnel par `ParamType`,
  additif à la logique de validation existante l. 566-580),
  `CiscoShellBase.ts`, `HuaweiVRPShell.ts`, `HuaweiSwitchShell.ts` (câblage
  des résolveurs `INTERFACE` → ports réels de l'équipement, `VLAN_LIST`/VLAN
  → VLANs réellement créés).
- **Détail** : le résolveur ne remplace pas la complétion statique
  existante (verbes/mots-clés) — il s'y ajoute lorsque le nœud courant du
  trie attend une valeur d'un `ParamType` instrumenté. Router et switch,
  Cisco et Huawei.
- **Tests** : nouveau fichier `cisco-huawei-dynamic-tab-completion.test.ts`
  — `Tab` après `interface Gi` propose les interfaces réellement présentes ;
  `Tab` après `switchport trunk allowed vlan` propose les VLANs réellement
  créés ; régression complète de `command-trie-help-suggestions.spec.ts`
  et `switch-cli.test.ts` (complétion statique inchangée).

### Phase 3 — Cycling Huawei sur entrée ambiguë (item 2-3)

- **Fichiers touchés** : `src/network/devices/shells/CommandTrie.ts` (ou
  état de cycling porté par `HuaweiVRPShell.ts`/`HuaweiSwitchShell.ts`,
  par analogie avec le state de cycling déjà réel dans
  `WindowsTerminalSession.onSubShellTab`), Cisco non touché.
- **Détail** : sur `Tab` répété face à une entrée ambiguë, Huawei cycle
  ses candidats ; le comportement Cisco (retour `null`, no-op) reste
  identique.
- **Tests** : réécriture ciblée de l'assertion
  `huawei-vrp.test.ts:997-1002` pour refléter le cycling (au lieu de
  `null`), nouveau test équivalent pour `huawei-switch-shell.test.ts`,
  régression du test Cisco équivalent (doit rester `null`).

### Phase 4 — Complétion SQL*Plus (item 2-4)

- **Fichiers touchés** : `src/terminal/subshells/SqlPlusSubShell.ts`
  (ajout de `getCompletions`), lecture du catalogue existant via
  `OracleDatabase`/`OracleCatalog` déjà référencés par la session
  SQL*Plus active.
- **Détail** : mots-clés SQL/SQL*Plus statiques + noms de table réels du
  schéma connecté après `FROM` + noms de colonne réels de la table
  référencée après `SELECT`/une virgule. Dépend de la Phase 1 pour être
  atteignable au clavier.
- **Tests** : nouveau fichier `sqlplus-tab-completion.test.ts` — mots-clés,
  tables réelles d'un schéma de test, colonnes réelles, régression de
  `SqlPlusSubShell` existant (comportement `Enter`/exécution de requête
  inchangé).

### Phase 5 — Complétion d'argument pour les commandes Linux restantes (item 5)

- **Fichiers touchés** : audit des 47 fichiers sous
  `src/network/devices/linux/commands/` sans `complete()`, ajout de la
  méthode aux commandes retenues (flags pour les commandes qui n'attendent
  pas de chemin, arguments contextuels — interfaces, PID, adresses connues
  — pour les autres), `LinuxMachine.ts`/`LinuxCommandExecutor.ts` inchangés
  (le point d'entrée `getCompletions` délègue déjà à `complete()` quand
  elle existe).
- **Détail** : prioriser par fréquence d'usage réelle observée dans
  `src/__tests__/` et les tutoriels (`docs/tutoriel-*.md`, `Lan_tuto.md`)
  plutôt que traiter les 47 dans un ordre arbitraire ; livrer par lots
  testés indépendamment plutôt qu'en un seul commit.
- **Tests** : extension de `linux-command-completion.test.ts` par lot de
  commandes instrumentées, régression complète du fichier existant
  (comportement des 6 commandes déjà réelles inchangé).

### Phase 6 — Complétion de paramètre/flag pour `cmd.exe` (item 6)

- **Fichiers touchés** : `src/network/devices/WindowsPC.ts`
  (l. ~2035-2067, la fonction de complétion `cmd.exe`).
- **Détail** : ajouter une table flags/paramètres par commande interne
  `cmd.exe` connue, consultée après un `-`/`/` en position d'argument, sans
  toucher à la complétion de commande/chemin déjà réelle.
- **Tests** : extension de `windows-filesystem.test.ts` (ou nouveau fichier
  dédié `cmd-flag-completion.test.ts`), régression des assertions
  `cmd.exe` existantes (l. 536-552).

### Phase 7 — Complétion dynamique pour `ParamType` additionnels, Cisco et Huawei (item 7)

- **Fichiers touchés** : `src/network/devices/shells/CommandTrie.ts` (mêmes
  points d'extension que la Phase 2), `CiscoShellBase.ts`,
  `HuaweiVRPShell.ts`, `HuaweiSwitchShell.ts` (résolveurs additionnels pour
  `IP_ADDR`, numéro d'ACL, hostname).
- **Détail** : réutilise l'architecture de résolveur additive posée en
  Phase 2 — dépendance directe sur cette phase, pas seulement un risque de
  conflit de merge. Router et switch, Cisco et Huawei.
- **Tests** : extension de `cisco-huawei-dynamic-tab-completion.test.ts`
  (Phase 2) avec des cas `IP_ADDR`/ACL/hostname, régression des cas
  interfaces/VLANs déjà couverts.

---

## 4. Exigences de non-régression

Comme pour `PRD-802.1Q.md`/`PRD-NAT-Port-Forwarding.md` : toute correction
doit rester **additive et testée**. Le comportement observable des suites
déjà vertes touchant la complétion (`command-trie-help-suggestions.spec.ts`,
`switch-cli.test.ts`, `huawei-vrp.test.ts`, `huawei-switch-shell.test.ts`,
`linux-completion.test.ts`, `linux-command-completion.test.ts`,
`autocomplete.test.ts`, `shell-keys-and-completion.test.ts`,
`windows-filesystem.test.ts`) ne doit pas régresser. La Phase 1 touche un
routeur de touches partagé par **tout** sous-shell Linux (SQL*Plus, SFTP,
FTP, nslookup, rman) — toute suite de tests spécifique à l'un de ces
sous-shells doit être re-exécutée avant/après pour confirmer qu'`Enter`,
les flèches, `Ctrl+L`/`Ctrl+C`/`Ctrl+D` restent inchangés. La Phase 3 est
strictement limitée à Huawei — le test Cisco d'ambiguïté (`null`) ne doit
jamais être modifié pour Cisco. La Phase 4 dépend fonctionnellement de la
Phase 1 (sans elle, `Tab` n'atteint jamais `SqlPlusSubShell.getCompletions`)
mais peut être développée en parallèle (fichiers disjoints). La Phase 7
dépend **fonctionnellement** de la Phase 2 (même résolveur, étendu à
d'autres `ParamType`) et doit lui succéder, pas seulement partager un
fichier. Les Phases 5 et 6 sont indépendantes du reste et peuvent être
menées en parallèle de n'importe quelle autre phase.

---

## 5. Risques

- **Risque principal** : la Phase 1 modifie `handleSubShellKey()`, un
  routeur de touches partagé par tous les sous-shells Linux — une erreur
  d'interception pourrait casser `Enter`/navigation historique/`Ctrl+C`
  pour SQL*Plus, SFTP, FTP, nslookup, rman simultanément, pas seulement
  ajouter `Tab`. Mitigation : régression complète de chaque suite de tests
  par sous-shell avant/après, en plus de `shell-keys-and-completion.test.ts`.
- **Risque secondaire** : la Phase 2 introduit un résolveur dynamique dans
  `CommandTrie`, une structure jusqu'ici purement statique et déjà bien
  testée (`command-trie-help-suggestions.spec.ts`) — la conception détaillée
  doit garder ce résolveur strictement additif (appelé seulement quand le
  nœud attend une valeur d'un `ParamType` instrumenté) pour ne pas modifier
  le comportement de complétion des mots-clés statiques existants.
- **Risque mineur** : la Phase 3 (cycling Huawei) introduit un état
  (index du candidat courant) qui doit être réinitialisé à chaque nouvelle
  entrée/session, sous peine de fuite d'état entre tests ou entre sessions
  utilisateur successives — même classe de bug déjà rencontrée et résolue
  une fois pour le cycling PowerShell, à réutiliser comme référence.
- **Risque mineur** : la Phase 5 (47 commandes Linux) est la plus étendue
  en volume de fichiers touchés — sans le découpage en lots priorisés déjà
  prévu (§3 Phase 5), le risque est une livraison partielle non détectée
  comme telle. Mitigation : suivre chaque lot comme une tâche distincte
  plutôt qu'un unique commit fourre-tout. La Phase 7 hérite du même risque
  que la Phase 2 (résolveur additif) et doit repasser la même régression
  (`command-trie-help-suggestions.spec.ts`) en plus de ses propres tests.

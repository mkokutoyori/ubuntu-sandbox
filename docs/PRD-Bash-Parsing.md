# PRD — Enhancement du parsing bash (machines Linux)

**Version** : 1.0
**Date** : 2026-07-02
**Projet** : Ubuntu Sandbox — Interpréteur bash (`src/bash/`)
**Auteur** : Claude Code
**Références normatives** : POSIX.1-2017 §2 (Shell Command Language), Bash Reference Manual 5.x (§3.2.3 Pipelines, §3.2.5.2 Conditional Constructs, §3.2.5.2 case, §3.5.6 Process Substitution, §4.2 Builtins)

---

## 0. Contexte et portée du document

L'interpréteur bash du simulateur (`src/bash/`, ~6 200 lignes : lexer → parser → AST →
interpréteur → runtime) est déjà solide — pipelines, fonctions, sous-shells,
`case`/`for`/`while`/`until`, `[[ ]]`, `(( ))`, expansions de paramètres avancées,
here-docs, alias, traps `EXIT`/`ERR`/`DEBUG`/`RETURN` (cf. `GAP.md` §8). Ce PRD couvre
la **fermeture des lacunes de parsing et de runtime** identifiées par sondage
systématique de l'interpréteur réel (batterie de 30 constructions exécutées sur une
`LinuxPC`), en donnant la priorité aux constructions du cœur POSIX/bash qu'un
script pédagogique rencontre en premier.

Aucune ligne de code de production n'est écrite dans le cadre de ce document ; il sert
de base à la planification et à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant (sondage du 2026-07-02)

### 1.1 Constructions vérifiées fonctionnelles

| Construction | Exemple sondé | Verdict |
|---|---|---|
| Expansion d'accolades (liste, séquence, pas) | `{1..5}`, `pre{a,b}post`, `{0..10..2}` | ✅ |
| `set -o pipefail` | `false \| true; echo $?` → 1 | ✅ |
| Boucle for C-style | `for ((i=0;i<3;i++))` | ✅ |
| `getopts` | `while getopts "a:" o` | ✅ |
| Here-doc `<<-` (tabulations retirées) | `cat <<-EOF` | ✅ |
| `printf -v`, `until`, groupes `( )` / `{ }` | — | ✅ |

### 1.2 Lacunes constatées (gap analysis)

| # | Construction | Comportement observé | Attendu (bash réel) | Sévérité |
|---|---|---|---|---|
| 1 | `! pipeline` | `!: command not found` | Inversion du code retour ; exempt de `set -e` | **Bloquant** (cœur POSIX) |
| 2 | `[[ s =~ ([a-z]+)([0-9]+) ]]` | `syntax error … LPAREN` | Match regex POSIX-étendu, groupes dans `BASH_REMATCH[0..n]` | **Bloquant** |
| 3 | `case … ;&` / `;;&` | `syntax error near '&'` | Fallthrough / poursuite des tests | Élevée |
| 4 | `<(list)` / `>(list)` | `syntax error … LPAREN` | Substitution de processus (`/dev/fd/N`) — `diff <(a) <(b)`, `while read … < <(cmd)` | Élevée (déjà notée GAP §8.1) |
| 5 | `$(< file)` | chaîne vide | Équivalent rapide de `$(cat file)` | Élevée |
| 6 | `mapfile` / `readarray` | commande absente (vide) | Charge un fichier dans un tableau | Élevée |
| 7 | `read -a mots <<< "…"` | tableau non peuplé | Découpe IFS dans un tableau indexé | Élevée |
| 8 | `bash script.sh` sans bit `x` | `Permission denied` | S'exécute (seul `./script.sh` exige le bit exécutable) | Élevée |
| 9 | `declare -n` (nameref) | déréférencement absent | Suivi de la référence | Mineure |
| 10 | `${v@Q}` (transformations) | vide | Quoting réutilisable | Mineure |
| 11 | `${!prefix*}` | vide | Noms de variables par préfixe | Mineure |
| 12 | extglob `+( )` dans `${%%}` | expansion vide | Motif étendu | Mineure |
| 13 | `coproc` | erreur de syntaxe | Coprocessus | Mineure (asynchrone) |
| 14 | `cmd &` + `jobs` dans l'interpréteur | `&` = séparateur, pas de job | Job arrière-plan | Mineure (simulateur synchrone, GAP §8.1) |

L'AST prévoit déjà `Pipeline.negated?` et l'interpréteur l'honore (lignes 289/326 de
`BashInterpreter.ts`) — seul le parseur ne le renseigne jamais : la lacune #1 se répare
au point exact où la grammaire l'a anticipée.

---

## 2. Objectifs

### 2.1 Objectifs (ce PRD)

1. **`!` négation de pipeline** — consommé par le parseur (bascule sur `!` répété),
   `Pipeline.negated` renseigné, exemption `set -e`/trap `ERR` comme en bash réel.
2. **`=~` complet** — le membre droit d'un `=~` dans `[[ ]]` est lu comme un motif
   regex brut (parenthèses, quantificateurs, alternances, classes) ; l'interpréteur
   peuple `BASH_REMATCH` (indice 0 = match complet, 1..n = groupes).
3. **Terminateurs `case`** — `;&` (fallthrough inconditionnel) et `;;&` (poursuite des
   tests) au lexer, dans `CaseItem.terminator` et dans l'interpréteur.
4. **Substitution de processus** — `<(list)` et `>(list)` comme mots : la liste est
   exécutée, sa sortie matérialisée dans un fichier `/dev/fd/N` du VFS dont le chemin
   remplace le mot ; couvre `diff <(a) <(b)` et `… < <(cmd)`.
5. **Lecture en tableau** — `$(< file)`, `mapfile`/`readarray` (`-t` au minimum),
   `read -a`.
6. **`bash script.sh` sans bit exécutable** — seul le lancement par chemin
   (`./script.sh`) exige `x` ; l'invocation via interpréteur (`bash`/`sh script`)
   n'exige que la lecture.

### 2.2 Non-objectifs (hors périmètre, documentés)

- `coproc` et le job control réel au niveau interpréteur (`&` asynchrone, `fg`/`bg`
  intra-script) — le simulateur est synchrone ; la couche terminal gère déjà `cmd &`.
- Flux réels dans les pipelines multi-étages (GAP §8.2 — limite assumée).
- Namerefs (`declare -n`), transformations `${var@X}`, `${!prefix*}`, extglob
  complet — itération suivante (la structure d'`Expansion.ts` les accueillera sans
  refonte).

---

## 3. Architecture

Aucun nouveau module : chaque phase étend la couche où bash lui-même place la
sémantique, en réutilisant les seams existants.

| Phase | Lexer | Parser / AST | Interpréteur | Runtime |
|---|---|---|---|---|
| 1 `!` | — (déjà WORD `!`) | `parsePipeline` consomme et bascule `negated` | déjà en place | — |
| 2 `=~` | — | mode « regex brut » à droite de `=~` (reconstruction jusqu'à la frontière `]]`/`&&`/`\|\|`) | `RegExp` + écriture `BASH_REMATCH` | tableau via `Environment` |
| 3 `;&`/`;;&` | tokens `SEMI_AMP`, `DSEMI_AMP` | `CaseItem.terminator: ';;' \| ';&' \| ';;&'` | boucle d'items avec fallthrough | — |
| 4 `<( )` | — | nouveau `Word` : `ProcessSubstitution { direction, command }` | — | `Expansion` exécute la liste via `CommandSubstitutionFn` existant et matérialise `/dev/fd/N` via une capacité fichier injectée |
| 5 lecture | — | — | — | `Builtins` : `mapfile`/`readarray`, `read -a` ; `Expansion` : `$(< file)` |
| 6 `bash f` | — | — | — | gate d'exécution du dispatcher : `x` requis seulement pour l'invocation par chemin |

**Principe** : le membre droit de `=~` et la substitution de processus sont les deux
seuls points où bash suspend sa tokenisation ordinaire — le parseur reproduit ces deux
modes localement, sans état global de lexer.

---

## 4. Plan de mise en œuvre (TDD, par phases)

Chaque phase suit la méthode du projet : suite rouge d'abord (constructions réelles
exécutées sur une `LinuxPC` via `executeCommand`, sans mock), implémentation jusqu'au
vert, régression bash complète (400+ cas existants) avant commit. Aucun commentaire
dans le code de production.

| Phase | Contenu | Sortie testable |
|---|---|---|
| **1** | Négation `!` | `! false && echo ok` ; `! true; echo $?` → 1 ; `! ! true` ; `set -e; ! false` ne tue pas le script |
| **2** | `=~` + `BASH_REMATCH` | groupes, alternance, quantificateurs, classes ; non-match → rc 1 ; motif cité = littéral |
| **3** | `;&` / `;;&` | fallthrough simple, chaîne `;;&`, mélange des trois terminateurs |
| **4** | `<(list)` / `>(list)` | `diff <(sort a) <(sort b)` ; `while read < <(cmd)` ; chemins `/dev/fd/N` distincts |
| **5** | `$(< f)`, `mapfile`, `read -a` | round-trips fichier→tableau→éléments ; `-t` retire les fins de ligne |
| **6** | `bash script.sh` sans bit `x` | script non exécutable lancé via `bash`/`sh` ; `./script.sh` toujours refusé sans `x` |

---

## 5. Stratégie de test

- **TDD strict** : chaque phase ouvre par des cas rouges tirés du sondage §1.2,
  exécutés de bout en bout (`LinuxPC.executeCommand`), jamais contre le parseur seul —
  le comportement observable du shell est le contrat.
- **Oracle bash réel** : chaque assertion reproduit la sortie de bash 5.x (vérifiée sur
  les exemples du Bash Reference Manual).
- **Non-régression** : les suites `src/__tests__/unit/bash/` (400+ cas) et les suites
  shell/SSH qui pilotent des scripts (`linux-lan-ssh-suite`, `ssh-operator-journeys`)
  servent de golden master à chaque phase.
- **Cas limites systématiques** : imbrications (`! cmd \| cmd`, `<( <(…) )` refusé
  proprement), motifs regex vides ou invalides (rc 2 comme bash), `case` sans corps,
  `mapfile` sur fichier absent, quoting à droite de `=~`.

---

## 6. Risques et points d'attention

1. **Frontière lexicale de `=~`** : reconstruire le motif à partir des tokens peut
   perdre les espaces exacts ; mitigation — s'appuyer sur les positions sources des
   tokens pour restituer la tranche brute de l'entrée.
2. **`/dev/fd/N` et VFS** : la capacité fichier injectée dans `Expansion` doit rester
   optionnelle (les tests unitaires purs du module bash n'ont pas de VFS) — la
   substitution de processus se dégrade alors en erreur propre.
3. **`;&` et l'observateur de duplication du trie lexical** : néant — mais la paire
   `;;&` doit être testée avant `;;` dans le lexer (préfixe commun).
4. **Régression `set -e`** : l'exemption de la négation doit reproduire exactement le
   contexte d'`errexitSuppress` déjà utilisé pour `&&`/`\|\|`.

---

## 7. Suite prévue

Namerefs, `${var@X}`, `${!prefix*}`, extglob (lacunes 9–12) ; routage des stubs réseau
(`ping`/`dig` dans les scripts) vers le chemin simulé réel (GAP §8.4) ; extraction
continue du dispatcher god-class (GAP §8.8).

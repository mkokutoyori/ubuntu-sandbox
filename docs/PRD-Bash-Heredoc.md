# PRD — Here-documents Bash (`<<`, `<<-`, `<<<`) : moteur et expérience interactive

## 0. Contexte et portée

Un here-document (`<<DELIM` / `<<-DELIM`) permet de fournir un bloc de
texte multi-ligne comme entrée standard d'une commande, jusqu'à une ligne
contenant exactement le délimiteur. C'est l'un des mécanismes bash les
plus visibles côté **expérience interactive** : contrairement à la plupart
des fonctionnalités déjà couvertes par cette série de PRD (protocoles
réseau, où l'UX est secondaire), un heredoc mal supporté au niveau
terminal (prompt de continuation, Ctrl+C, Ctrl+D, tabulation) casse
immédiatement l'illusion d'un vrai shell, même si le moteur de parsing
sous-jacent est parfaitement correct. Ce PRD couvre donc **les deux
couches à la fois** :

1. Le moteur (`src/bash/lexer/`, `src/bash/parser/`, `src/bash/runtime/`) —
   déjà natif et solide (§1.2), pas un chantier à ouvrir.
2. L'expérience interactive du terminal (`src/terminal/sessions/
   LinuxTerminalSession.ts`, `src/bash/incompleteInput.ts`) — où cet audit
   a trouvé plusieurs lacunes concrètes, non couvertes par les tests
   existants (§1.3), qui sont le véritable objet de ce document.

### 0.1 Chaîne de dépendances

- Aucune dépendance entrante bloquante — le moteur heredoc est déjà natif
  (§1.2) et ne dépend d'aucun autre PRD de cette série.
- **PowerShell a son propre mécanisme équivalent** (here-strings
  `@"..."@`/`@'...'@`) avec son propre détecteur de continuation
  interactive, dans un interpréteur entièrement séparé
  (`src/powershell/`). Ce PRD ne le couvre pas — cf. §2.2. S'il devait un
  jour être audité, ce serait un document distinct, pas une extension de
  celui-ci (les deux interpréteurs ne partagent aucun code de lexing).

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle |
|---|---|
| `src/bash/lexer/BashLexer.ts` | Collecte native des heredocs : `pendingHeredocs: Array<{delimiter, stripTabs, bodyToken}>` — une vraie file, traitée dans l'ordre par `collectHeredocBodies()` (l. 727-745), gère `<<`/`<<-` (tabs strippés), délimiteur cité (`'EOF'`/`"EOF"`/`\EOF`, suppression de l'expansion) vs. non cité (expansion `$var` normale), et le cas EOF-sans-délimiteur (accepté, comme un vrai bash) |
| `src/bash/parser/BashParser.ts:817,916` | Rattache le token `HEREDOC` et son corps comme redirection sur la commande |
| `src/bash/interpreter/BashInterpreter.ts:709-721` | Consomme le corps déjà collecté comme contenu d'entrée standard |
| `src/bash/runtime/Expansion.ts:955` | Expansion `$var`/substitution dans un corps non cité, littéral dans un corps cité |
| `src/bash/incompleteInput.ts` (144 lignes) | Détecteur de continuation interactif (PS2), **volontairement indépendant du parser complet** (son propre commentaire l'affirme) — scanner léger qui reconnaît un heredoc ouvert et renvoie son délimiteur attendu |
| `src/terminal/sessions/LinuxTerminalSession.ts` | Boucle d'accumulation PS2 (`_continuationBuffer`, `onEnter()` l. 731-786), prompt `> ` (`ps2Prompt`, l. 157), gestion clavier (`handleKey`/`handleNormalKey`), historique, complétion Tab |
| `src/bash/runtime/ScriptRunner.ts:315-333` | Commentaire orphelin (§1.3 item 5) décrivant un ancien préprocesseur de heredoc supprimé lors du passage au lexer natif, resté accroché par erreur au-dessus d'une fonction sans rapport (`stripShebang`) |
| 4 fichiers de tests dédiés (566 lignes) | `bash-heredoc-native.test.ts` (131 l.), `bash-heredoc.test.ts` (224 l.), `linux-continuation.test.ts` (99 l.), `incomplete-input.test.ts` (112 l.), plus heredoc exercé indirectement dans ~20 autres fichiers de scénario |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

- **Lexing natif complet** : plusieurs heredocs sur une même ligne
  (`cmd <<A <<B`) correctement mis en file et résolus dans l'ordre côté
  lexer ; `<<-` strippe les tabulations de tête du corps et de la ligne de
  délimiteur ; délimiteur cité vs non cité contrôle correctement
  l'expansion, exactement les règles bash réelles.
- **Détection de continuation interactive robuste sur le cas courant** :
  `analyzeBashInput()` reconnaît un heredoc ouvert (un seul par ligne, cas
  très majoritaire en pratique) et le distingue proprement des autres
  raisons de continuation (guillemet ouvert, `\` final, connecteur
  pendant, bloc `if`/`for`/`while`/`case` non fermé, `((...))`/`$((...))`
  où `<<` est un décalage de bits et non un heredoc — déjà correctement
  exclu, `incompleteInput.ts:58-72`).
- **Historique correct** : `onEnter()` exécute le bloc complet accumulé via
  `executeCommand(accumulated, {echo: false})`
  (`LinuxTerminalSession.ts:774`), et `pushHistory(typed)`
  (`LinuxTerminalSession.ts:1486`) reçoit ce texte multi-ligne complet tel
  quel (`trim()` ne touche pas aux retours à la ligne internes) — un
  heredoc est donc rappelable comme **une seule entrée d'historique**,
  exactement comme un vrai bash.
- **Collage (paste) multi-ligne déjà correct** : `pasteText()`
  (`TerminalSession.ts:771-797`) découpe l'entrée collée ligne par ligne et
  soumet chacune via `dispatchEnter()` — le même chemin que la saisie
  manuelle — donc coller un bloc heredoc complet (`cat <<EOF\n…\nEOF\n`)
  traverse la même boucle d'accumulation PS2 et s'exécute correctement une
  fois le délimiteur atteint, sans code séparé à maintenir.
- **Prompt PS2 fidèle** : `> ` uniforme quelle que soit la raison de
  continuation (heredoc compris) — c'est exactement le comportement bash
  réel par défaut (pas de distinction visuelle propre au heredoc), donc
  une conformité, pas une lacune.

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **Ctrl+C n'annule jamais un heredoc/continuation en cours.** `onCtrlC()` (`TerminalSession.ts:1584-1589`) efface `this.input` (la ligne courante) et affiche `^C`, mais ne touche jamais à `_continuationBuffer` (champ privé de `LinuxTerminalSession`, jamais référencé en dehors de `getPrompt()`/`onEnter()`) — et `LinuxTerminalSession` ne surcharge `onCtrlC()` nulle part. Résultat : après un Ctrl+C censé abandonner un heredoc en cours de frappe, le prompt reste `> ` (puisque `_continuationBuffer !== null` persiste) et la **prochaine ligne tapée se concatène silencieusement au buffer soi-disant abandonné** — l'utilisateur croit avoir annulé, mais n'a pas. Aucun test existant ne couvre ce cas (`linux-continuation.test.ts` n'a aucun scénario Ctrl+C). | Ctrl+C réel à un prompt PS2 (abandon complet, retour à PS1) | Élevée (état fantôme confus, silencieusement corrompu) |
| 2 | **Ctrl+D sur une ligne vide en pleine accumulation heredoc ferme la session au lieu de terminer le heredoc.** `LinuxTerminalSession.ts:689` : `if (e.key === 'd' && e.ctrlKey && this.input === '')` déclenche `endRemoteSession()`/`popRemoteDevice()`/`_onRequestClose?.()` (déconnexion SSH ou fermeture du terminal) — **sans jamais vérifier `_continuationBuffer !== null`**. Un vrai bash, dans cette situation précise, termine le heredoc immédiatement avec l'avertissement `bash: warning: here-document at line N delimited by end-of-file (wanted 'DELIM')` et continue à tourner — il ne se déconnecte ni ne se ferme jamais pour cette raison. | Ctrl+D réel pendant un heredoc ouvert (RFC POSIX shell / comportement bash documenté) | Élevée (perte de session/déconnexion inattendue au lieu d'un avertissement bénin) |
| 3 | **La complétion Tab n'est pas suspendue pendant le corps d'un heredoc.** `handleNormalKey()` (`LinuxTerminalSession.ts:708-727`) appelle `this.onTab()` sur Tab sans jamais consulter `_continuationBuffer` — taper Tab en plein corps de heredoc (du texte littéral, pas une commande) déclenche une tentative de complétion de fichier/commande sur ce texte, sémantiquement incorrecte : un vrai bash ne complète jamais à l'intérieur d'un corps de heredoc. | Comportement readline réel (pas de complétion en corps de heredoc) | Moyenne |
| 4 | **Le détecteur de continuation interactif ne gère qu'un seul heredoc en attente par ligne, contrairement au lexer.** `incompleteInput.ts`'s `scanLine()` stocke `heredoc` dans une simple variable (l. 42, 96) — un second `<<` sur la même ligne physique **écrase** le délimiteur du premier au lieu de le mettre en file. `BashLexer.ts`, lui, utilise une vraie file (`pendingHeredocs: Array<…>`, §1.2) et gère ce cas correctement à l'exécution. Conséquence : `cmd <<A <<B` tapé interactivement ne suit pas la bonne séquence de prompts PS2 (le détecteur n'attend que le délimiteur `B`, perdant `A`) — un cas marginal en pratique mais une vraie divergence entre les deux couches qui prétendent modéliser la même règle. | Cohérence interne lexer ↔ détecteur de continuation | Faible (cas d'usage rare, mais divergence de modèle réelle) |
| 5 | **Commentaire orphelin dans `ScriptRunner.ts:315-325`** décrivant un ancien préprocesseur de heredoc (transformation en `<<<` herestring) supprimé lors du passage au lexer natif (tâche déjà livrée) — la documentation, elle, n'a pas été retirée et reste accrochée au-dessus d'une fonction sans rapport (`stripShebang`), une source de confusion pour un futur lecteur qui chercherait la fonction qu'elle décrit. | Hygiène documentaire | Faible |

---

## 2. Objectifs

### 2.1 Objectifs (priorité décroissante)

- **P1 — Ctrl+C annule réellement un heredoc/continuation en cours
  (item 1).** `LinuxTerminalSession` doit surcharger `onCtrlC()` : en plus
  du comportement hérité (effacer `this.input`, afficher `^C`), remettre
  `_continuationBuffer` à `null` et rafraîchir le prompt vers PS1 — un
  Ctrl+C à un prompt PS2 doit rendre la main à un prompt normal, comme un
  vrai bash, quel que soit le nombre de lignes déjà accumulées.
- **P2 — Ctrl+D pendant un heredoc ouvert le termine avec l'avertissement
  réel, sans fermer la session (item 2).** Le garde de
  `LinuxTerminalSession.ts:689` doit distinguer le cas
  `_continuationBuffer !== null` (et plus précisément « heredoc en cours »,
  cf. §3) : dans ce cas, terminer le heredoc immédiatement (corps reçu
  jusque-là, sans ligne de délimiteur), afficher l'avertissement bash réel
  (`bash: warning: here-document at line N delimited by end-of-file
  (wanted 'DELIM')`), exécuter la commande avec ce corps tronqué, et
  **ne jamais** invoquer la fermeture de session dans ce cas précis.
- **P3 — Suspendre la complétion Tab pendant l'accumulation d'un heredoc
  (item 3).** `handleNormalKey()` doit court-circuiter Tab (l'insérer comme
  caractère littéral tabulation dans la ligne courante, comme un vrai
  terminal le ferait pour du texte libre) tant que `_continuationBuffer`
  correspond à un heredoc en cours plutôt qu'à une autre raison de
  continuation (guillemet/bloc/connecteur, où retenter une complétion de
  commande peut rester pertinent une fois la construction refermée).
- **P4 — Aligner `incompleteInput.ts` sur la file de heredocs du lexer
  (item 4).** `ScanState`/`scanLine()` doivent accumuler une **file** de
  délimiteurs en attente (comme `BashLexer.pendingHeredocs`) plutôt qu'une
  variable unique, et `analyzeBashInput()` doit consommer cette file dans
  l'ordre — un `cmd <<A <<B` attend d'abord la ligne `A`, puis la ligne
  `B`, avant de considérer la commande complète.
- **P5 — Retirer le commentaire orphelin (item 5).** Nettoyage direct,
  aucun changement de comportement.
- **P6 — (Amélioration UX optionnelle, au-delà de la fidélité bash pure)
  Indicateur discret du délimiteur attendu.** Un vrai bash n'affiche
  jamais le délimiteur attendu dans son prompt PS2 (`> ` nu) — ce PRD ne
  propose donc **pas** de changer le texte du prompt par défaut (cf. §1.2,
  déjà conforme). Mais ce simulateur est un outil pédagogique : un
  indicateur *opt-in*, désactivé par défaut, sur le modèle exact du
  « Ghost text » déjà présent (`TerminalSession.ts:1599`,
  `_ghostTextEnabled`, off par défaut, activable par session) — par
  exemple une ligne de statut discrète « en attente de : EOF » — donnerait
  aux utilisateurs qui l'activent explicitement un repère visuel sans
  jamais altérer le comportement par défaut ni la reproductibilité d'une
  transcription copiée-collée (le prompt PS2 lui-même reste `> ` intact).

### 2.2 Non-objectifs (explicitement exclus)

- **Here-strings PowerShell (`@"…"@`/`@'…'@`)** — interpréteur, lexer et
  détecteur de continuation entièrement séparés (`src/powershell/`) ;
  hors périmètre de ce document, à traiter par un PRD dédié si souhaité.
- **Édition rétroactive d'une ligne de corps déjà validée** — un vrai bash
  ne permet pas non plus de remonter éditer une ligne de heredoc déjà
  soumise (seul un Ctrl+C suivi d'une reprise complète le permet) ; ce
  comportement déjà conforme n'est pas remis en cause.
- **Changer le texte du prompt PS2 par défaut** — cf. P6, l'affichage `> `
  nu reste le comportement par défaut ; seul un indicateur strictement
  opt-in est proposé.

---

## 3. Architecture cible

**P1/P2/P3 (état de continuation qualifié).** Aujourd'hui
`_continuationBuffer: string | null` ne distingue pas *pourquoi* la
continuation est ouverte. Pour P2/P3, il est nécessaire de savoir
spécifiquement « suis-je en train de collecter un corps de heredoc » par
opposition aux autres raisons — la façon la plus directe est d'exposer
depuis `analyzeBashInput()` (déjà retourné par `BashInputAnalysis.
heredocDelimiter`, déjà présent dans le type) l'information à chaque
ligne accumulée, et de la conserver à côté de `_continuationBuffer` (par
exemple `_pendingHeredocDelimiter: string | null`, recalculé à chaque
`onEnter()` via le résultat déjà produit par `analyzeBashInput`, sans
nouvel appel). P1 consulte simplement `_continuationBuffer !== null` (peu
importe la raison) ; P2/P3 consultent en plus
`_pendingHeredocDelimiter !== null` pour restreindre leur comportement au
cas heredoc précis.

**P2 (terminaison anticipée).** Réutilise directement le chemin déjà
existant d'exécution multi-ligne (`executeCommand(accumulated, {echo:
false})`, `LinuxTerminalSession.ts:774`) — la seule différence est que le
texte exécuté n'a pas de ligne de délimiteur finale ; le lexer/parser
existants acceptent déjà ce cas (« heredoc laissé ouvert à EOF », déjà
géré par `BashLexer.collectHeredocBodies`, §1.2), donc aucun changement
côté moteur n'est nécessaire — seul le déclenchement côté session doit
choisir ce chemin au lieu de fermer la session.

**P4 (file de délimiteurs).** `ScanState.blocks` est déjà une pile pour
les mots-clés de bloc — un nouveau champ `pendingHeredocs: string[]` suit
le même principe : `scanLine()` empile (`push`) au lieu d'écraser, et
`analyzeBashInput()` dépile (`shift`) le premier élément à chaque ligne de
corps rencontrée, jusqu'à ce que la file soit vide.

**P6 (indicateur optionnel).** Nouveau champ à côté de
`_ghostTextEnabled` (même précédent architectural : off par défaut,
togglable par session, jamais consulté par la logique d'exécution
elle-même — seulement par la couche de rendu).

---

## 4. Modèle de données

```ts
// incompleteInput.ts — file de délimiteurs (P4)
interface ScanState {
  quote: '"' | "'" | null;
  trailingBackslash: boolean;
  blocks: string[];
  danglingConnector: boolean;
  arithDepth: number;
  pendingHeredocs: string[]; // remplace l'unique `heredoc` local à scanLine
}

// LinuxTerminalSession.ts — continuation qualifiée (P1-P3)
private _continuationBuffer: string | null = null;
private _pendingHeredocDelimiter: string | null = null; // nouveau

// TerminalSession.ts — indicateur opt-in (P6), même précédent que le ghost text
private _heredocHintEnabled = false;
```

---

## 5. Plan de mise en œuvre

1. **P5** (nettoyage documentaire) — trivial, en premier, ne bloque rien.
2. **P1** (Ctrl+C) — correctif isolé, un seul champ réinitialisé, risque
   quasi nul.
3. **P4** (file de délimiteurs) — isolé à `incompleteInput.ts`, testable
   indépendamment de la session terminal.
4. **P2** (Ctrl+D pendant heredoc) — dépend de l'état qualifié introduit
   pour distinguer « continuation heredoc » de « continuation générique »
   (cf. §3) ; à faire après P1 pour réutiliser la même distinction.
5. **P3** (suspension Tab) — même dépendance que P2, peut suivre
   immédiatement après.
6. **P6** (indicateur optionnel) — dernier, purement additif, aucune
   dépendance de risque sur les précédents.

Après chaque phase : `npx tsc --noEmit -p .`, `npx eslint`, puis exécution
complète des 4 fichiers de tests dédiés (566 lignes) avant de passer à la
suivante.

---

## 6. Stratégie de test

- **Non-régression obligatoire** : `bash-heredoc-native.test.ts`,
  `bash-heredoc.test.ts`, `linux-continuation.test.ts`,
  `incomplete-input.test.ts` (566 lignes), plus les ~20 fichiers de
  scénario qui exercent heredoc indirectement.
- **Nouveaux cas** (extension de `linux-continuation.test.ts`, pas de
  nouveaux fichiers séparés — cohérent avec la structure déjà en place) :
  - Ctrl+C en plein corps de heredoc : le prompt revient à PS1, et la ligne
    suivante tapée s'exécute comme une commande neuve, sans trace de
    l'ancien buffer.
  - Ctrl+D sur une ligne vide en plein corps de heredoc : la commande
    s'exécute avec le corps partiel, l'avertissement bash apparaît, la
    session reste ouverte (pas de déconnexion/fermeture).
  - Tab en plein corps de heredoc : insère une tabulation littérale, ne
    déclenche aucune suggestion de complétion.
  - `cmd <<A <<B` tapé ligne par ligne : le prompt attend d'abord la ligne
    `A` puis la ligne `B`, dans cet ordre, avant de considérer la commande
    complète — comparé au comportement (incorrect) actuel où seul `B` est
    attendu.
  - (P6) L'indicateur optionnel, désactivé par défaut, n'apparaît que
    lorsqu'explicitement activé pour la session, et n'altère jamais le
    texte du prompt PS2 lui-même.

---

## 7. Risques et points d'attention

- **P2 et P3 dépendent de pouvoir distinguer « continuation heredoc » de
  « continuation générique »** — s'assurer que cette distinction (§3)
  n'affecte jamais le comportement déjà correct des autres raisons de
  continuation (guillemet ouvert, bloc `if`/`for`, connecteur pendant) :
  Ctrl+C doit continuer à tout annuler dans tous les cas (P1, sans
  distinction), seuls Ctrl+D (P2) et Tab (P3) doivent être restreints
  spécifiquement au cas heredoc.
- **P4 est un changement de modèle de données dans un fichier
  volontairement indépendant du parser complet** (`incompleteInput.ts`,
  cf. son propre commentaire d'en-tête) — veiller à ce que la file ajoutée
  reste aussi légère que le reste du fichier, sans réintroduire de
  dépendance vers le lexer complet.
- **Ne pas confondre P6 avec une remise en cause de la fidélité du prompt
  PS2** — l'indicateur doit rester strictement opt-in et ne jamais
  apparaître par défaut, pour ne pas dévier du comportement bash réel déjà
  correctement modélisé (§1.2).

---

## 8. Critères d'acceptation

- Un Ctrl+C en plein corps de heredoc ramène immédiatement à un prompt
  PS1 normal, sans qu'aucune ligne suivante ne se concatène à un buffer
  fantôme.
- Un Ctrl+D sur une ligne vide en plein corps de heredoc termine la
  commande avec le corps partiel et l'avertissement bash réel, sans
  jamais fermer la session ni la connexion SSH en cours.
- Tab en plein corps de heredoc insère une tabulation littérale, sans
  tentative de complétion.
- `cmd <<A <<B` tapé interactivement attend les lignes `A` puis `B` dans
  cet ordre avant de considérer la commande complète.
- Les 4 fichiers de tests existants (566 lignes) passent toujours sans
  modification de leurs assertions à l'issue de toutes les phases.
- Le commentaire orphelin de `ScriptRunner.ts` a disparu.

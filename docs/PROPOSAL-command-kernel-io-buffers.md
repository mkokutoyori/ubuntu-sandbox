# PROPOSITION — Enrichissement du framework `command-kernel` : buffers d'entrée/sortie (I/O)

**Version** : 1.0
**Date** : 2026-07-14
**Document parent** : `migration_framework.md` (proposition d'ajout d'un §14)
**Statut** : PROPOSITION — en attente de revue et validation. Aucun code n'a été
modifié pour produire ce document ; il ne fait que documenter l'état actuel de
`src/command-kernel/io/` et lister les manques constatés en le lisant en
entier (`types.ts`, `pipe-buffer.ts`, `file-output-stream.ts`), leurs usages
réels dans `exec/executor.ts`, et le motif dupliqué hors socle
(`textInput.ts` côté Linux).

---

## 0. Pourquoi ce document

Le §0 de `migration_framework.md` fixe des invariants forts (une seule porte
d'entrée vers la machine, aucune commande ne connaît le `Terminal`, aucune
duplication…) mais ne dit rien sur les garanties que doivent offrir
`InputStream`/`OutputStream`/`CommandIO` eux-mêmes. En l'état, le contrat
d'I/O (`src/command-kernel/io/types.ts`) est minimal et une partie de sa
surface (`InputStream.read()`) n'est **jamais utilisée** par aucune commande
migrée ni aucun test — seul `readAll()` l'est. Ce document propose de combler
cet angle mort avant qu'une future commande migrée ne s'appuie sur une
sémantique non spécifiée.

Rien ici ne remet en cause l'architecture existante (Command/Registry/
Facade/Executor) : il s'agit uniquement d'enrichir la couche `io/`.

---

## 1. Constats sur l'état actuel

### 1.1 `InputStream.read()` est sous-spécifié et mort en pratique

```ts
// io/types.ts
export interface InputStream {
  read(): Promise<string | null>; // null = EOF
  readAll(): Promise<string>;
}
```

```ts
// io/pipe-buffer.ts
async read(): Promise<string | null> {
  return this.chunks.shift() ?? (this.closed ? null : "");
}
```

- Toutes les commandes déjà migrées (`Cat`, `Grep`, `Sort`, `Cut`, `Uniq`,
  `Rev`, `Diff`…) et le motif partagé `textInput.ts`
  (`src/network/devices/linux/command-kernel/commands/textInput.ts`)
  n'appellent que `ctx.io.stdin.readAll()`. Aucun appel à `read()` n'existe
  dans le projet en dehors de sa propre définition.
- Sa sémantique est ambiguë : si le pipe est ouvert et vide, `read()` renvoie
  `""` (chaîne vide) — ni `null` (EOF), ni une vraie attente. Une commande qui
  l'utiliserait naïvement dans une boucle `while ((chunk = await
  stdin.read()) !== null)` entrerait dans une **boucle active infinie** tant
  que le pipe reste ouvert sans nouvelle donnée, puisque rien ne bloque ni ne
  fait progresser le temps logique.
- Aujourd'hui ce n'est un bug latent que parce que personne ne l'utilise —
  mais c'est exactement le genre de trou que §3.1 du framework demande de ne
  pas laisser ouvert avant de migrer une commande qui traiterait un flux
  ligne par ligne (ex : un futur `tail -f`, ou un pager interactif).

### 1.2 Le pipeline n'a ni exécution concurrente ni contre-pression

```ts
// exec/executor.ts — runPipeline
for (let i = 0; i < node.stages.length; i++) {
  const pipe = new PipeBuffer();
  last = await this.runSimple(node.stages[i], session, { stdin: previous, stdout: isLast ? io.stdout : pipe, stderr: io.stderr });
  await pipe.close();
  previous = pipe;
}
```

Chaque étage s'exécute **entièrement** avant que l'étage suivant ne démarre
(`await` séquentiel), et `PipeBuffer` accumule tous les `write()` dans un
tableau non borné en mémoire. C'est un choix cohérent avec un simulateur
déterministe (pas de vrai I/O concurrent à modéliser), mais il a deux
conséquences jamais documentées comme telles :

1. **Aucune limite de taille** : une commande qui produit une sortie très
   volumineuse avant que le consommateur ne s'exécute (ex : un futur
   générateur infini façon `yes`) grossit indéfiniment le tampon — pas
   d'erreur explicite, juste une dérive mémoire silencieuse.
2. **`cmd_infini | head -1` ne peut pas fonctionner comme sous un vrai
   shell** : sous bash, `head -1` lit une ligne puis ferme son côté lecture,
   ce qui tue `cmd_infini` par `SIGPIPE`. Ici, `cmd_infini` devrait finir
   d'écrire *tout* son flux avant que `head` ne s'exécute — un générateur
   sans fin bloquerait la commande entière, jamais une erreur propre.

Ce n'est pas nécessairement à corriger tout de suite (aucune commande migrée
à ce jour ne produit de flux non borné), mais §12 du framework devrait
déclarer explicitement cette limite comme un invariant assumé, pas un
détail d'implémentation caché — pour qu'un futur agent qui migre `yes`,
`tail -f` ou équivalent sache qu'il doit d'abord régler ce point plutôt que
découvrir un blocage en test.

### 1.3 `PipeBuffer.write()` sur un pipe fermé lève une `Error` native

```ts
// io/pipe-buffer.ts
async write(chunk: string): Promise<void> {
  if (this.closed) throw new Error("pipe fermé");
  this.chunks.push(chunk);
}
```

Ceci viole directement §9 du framework (« Toute nouvelle erreur métier
propre à une commande doit être une sous-classe de `ShellError`... jamais une
exception native qui remonterait telle quelle jusqu'à
`Executor.runSimple` ») et la checklist §13 (« Aucune exception native non
convertie en `ShellError` »). Dans l'état actuel, ce chemin n'est atteint par
aucun test — mais dès qu'une commande écrira vers un étage de pipeline dont
le lecteur s'est arrêté tôt (`head`, `grep -m1`…), cette `Error` remontera
brute jusqu'au `Shell`, qui la traitera comme un **bug interne** plutôt
qu'une situation attendue (§5.3 : « capture toute `ShellError` pour
l'afficher proprement... sans jamais laisser fuiter une exception
native »).

### 1.4 Pas de redirection `stderr` ni de heredoc

```ts
// ast/nodes.ts
export interface RedirectionNode {
  readonly kind: "redirect";
  readonly mode: "in" | "out" | "append";
  readonly target: string;
}
```

Le lexer/parser ne connaissent que `>`, `>>`, `<`. Aucune commande migrée à
ce jour n'a besoin de `2>`, `2>&1`, `&>` ou `<<` (heredoc), donc ce n'est pas
urgent — mais toute commande qui en aurait besoin (ex: un futur `find` avec
suppression des erreurs de permission via `2>/dev/null`) buterait sur un
modèle de redirection qui ne cible que stdout/stdin, sans notion de
descripteur de fichier.

### 1.5 Motif `readAll()` par fichier dupliqué hors du socle

`readTextInput()`/`readPerFileInputs()`/`splitLines()`/`joinLines()`
(`src/network/devices/linux/command-kernel/commands/textInput.ts`) sont un
motif générique — « lire depuis stdin si aucun fichier, sinon depuis chaque
fichier, en préservant l'absence de saut de ligne final » — utilisé par
`Cat`, `Grep`, `Sort`, `Cut`, `Uniq`, `Rev`, `Diff`… Il vit aujourd'hui
**dans le pont Linux**, alors qu'il ne dépend d'aucun détail Linux
(seulement de `MachineApi.fs` et `CommandIO`, tous deux vendor-agnostic).
Un futur pont (Windows, Cisco…) qui migrerait une commande de traitement de
texte redéfinirait ce même motif depuis zéro — violation potentielle de
l'invariant « pas de duplication » (§0.9, checklist §13).

### 1.6 Aucun contrat entre l'I/O et l'annulation (`ctx.signal`)

`CommandContext.signal` (`AbortSignal`) existe et `Shell.onInterrupt()`
l'aborte sur Ctrl+C, mais ni `PipeBuffer` ni `FileOutputStream` ne
consultent jamais ce signal. Aujourd'hui, sans commande à exécution longue
consommant un flux en boucle, ce n'est pas observable — mais un futur
`tail -f`/pager qui lirait `stdin` en boucle n'aurait aucun moyen standard
de s'arrêter proprement sur Ctrl+C autrement qu'en vérifiant
`ctx.signal.aborted` lui-même à chaque itération, sans aide de la couche
I/O.

### 1.7 Tout est `string` — jamais documenté comme invariant explicite

`InputStream`/`OutputStream` travaillent exclusivement en `string` (JS
UTF-16), jamais en octets bruts (`Uint8Array`/`Buffer`). C'est cohérent avec
un simulateur qui ne modélise que du texte, mais ce choix n'est écrit nulle
part comme un invariant du framework — une commande migrée qui simulerait un
fichier binaire (ex: futur `xxd`, `base64 -d` vers un fichier réellement
binaire) n'aurait aucune indication qu'elle sort du contrat prévu.

---

## 2. Propositions

Chaque proposition est indépendante ; elles peuvent être validées séparément.

### P1 — Clarifier ou retirer `InputStream.read()`

Deux options, à trancher par l'utilisateur :

- **P1a (retrait)** : supprimer `read()` de `InputStream` tant qu'aucune
  commande n'en a besoin — seul `readAll()` est un contrat vivant et testé.
  Le réintroduire, spécifié, le jour où une commande a réellement besoin
  d'une lecture incrémentale.
- **P1b (spécification stricte)** : garder `read()` mais documenter et
  implémenter une sémantique non ambiguë : `read()` renvoie soit un chunk
  disponible, soit `null` **seulement** après `close()`, et ne renvoie
  **jamais** `""` sur un pipe ouvert-mais-vide — un appelant qui a besoin
  d'attendre doit passer par un mécanisme explicite (ex: une future
  primitive `waitForData()` construite sur `src/events/Signal`, cohérente
  avec ce que les protocoles réseau utilisent déjà pour l'attente
  asynchrone), pas par un polling sur `read()`.

Recommandation : **P1a**, plus simple, tant que le besoin réel n'existe pas
— cohérent avec le principe YAGNI déjà appliqué ailleurs dans le projet
(§3.5 du framework : « jamais complexifier... pour un besoin propre à une
seule commande »).

### P2 — Documenter explicitement le modèle d'exécution séquentiel des pipelines comme invariant, avec garde-fou mémoire

- Ajouter dans `migration_framework.md` (nouveau §14 ou sous-section de
  l'actuel §5.3) une déclaration explicite : *« Les étages d'un pipeline
  s'exécutent séquentiellement, jamais en concurrence ; un étage producteur
  doit terminer avant que le consommateur suivant ne commence. Toute
  commande à flux non borné (générateur infini) est explicitement hors
  périmètre tant que ce modèle n'évolue pas. »*
- Ajouter une limite de taille configurable sur `PipeBuffer` (ex: un nombre
  de caractères maximum, raisonnable pour un simulateur — à discuter,
  proposition de départ : quelques Mo), qui lève une erreur métier dédiée
  (voir P3) plutôt que de dériver silencieusement en mémoire.

### P3 — Remplacer l'`Error` native de `PipeBuffer.write()` par une `ShellError` dédiée

Introduire dans `errors.ts` :

```ts
export class BrokenPipeError extends ShellError {
  constructor(message = "écriture vers un pipe fermé") {
    super(message, 141); // 141 = 128 + SIGPIPE(13), cohérent avec §9 (128+n)
  }
}
```

`PipeBuffer.write()` lève cette erreur au lieu de `Error`. Elle est ensuite
capturée par `Executor.runWithArgs` comme toute autre `ShellError` (§5.3) —
aucun changement requis côté `Executor`. Une commande légitime peut aussi
choisir de l'ignorer silencieusement (comportement `SIGPIPE` par défaut sous
Unix : le processus meurt sans message) — à trancher commande par commande,
pas dans le socle.

### P4 — Étendre `RedirectionNode` pour les flux nommés (préparation, pas d'implémentation immédiate)

Ajouter un champ optionnel `fd?: "stdout" | "stderr"` (au lieu de renommer
`mode`) à `RedirectionNode`, rétrocompatible (`fd` absent = `stdout`,
comportement actuel inchangé) :

```ts
export interface RedirectionNode {
  readonly kind: "redirect";
  readonly mode: "in" | "out" | "append";
  readonly target: string;
  readonly fd?: "stdout" | "stderr"; // absent = "stdout", rétrocompatible
}
```

Le lexer/parser resteraient inchangés tant qu'aucune commande n'a besoin de
`2>`/`2>&1` — cette proposition ne fait qu'ouvrir la porte sans l'ouvrir en
pratique (pas de nouveau token tant qu'un besoin réel n'est identifié,
cohérent avec §3.5/§5.2 : ne pas complexifier le socle par anticipation).
**Recommandation : ne pas implémenter maintenant**, seulement noter le point
d'extension dans le framework pour qu'un futur agent ne le redécouvre pas de
zéro.

### P5 — Remonter le motif `readTextInput`/`splitLines`/`joinLines` dans le socle

Déplacer `src/network/devices/linux/command-kernel/commands/textInput.ts`
vers `src/command-kernel/io/text-input.ts` (ou `io/line-input.ts`), sans
changer sa logique — il ne dépend déjà que de `CommandContext`/`MachineApi`,
tous deux vendor-agnostic. Le pont Linux importerait alors depuis le socle
au lieu de le posséder. Documenter dans le framework (§3, checklist §13)
que toute commande de traitement de texte, quel que soit le vendeur, doit
réutiliser ce module plutôt que de le redéfinir.

### P6 — Documenter l'invariant « `string` uniquement, jamais binaire »

Ajouter une ligne explicite dans `io/types.ts` (JSDoc sur `InputStream`/
`OutputStream`) et dans le futur §14 du framework : *« Les flux
`command-kernel` transportent exclusivement des `string` (texte UTF-16 JS).
Aucune commande migrée ne doit simuler un contenu binaire via ce contrat —
si un tel besoin apparaît, il doit être discuté explicitement avant
d'étendre `InputStream`/`OutputStream`, jamais en encodant des octets dans
une `string` par convention informelle. »*

### P7 — `ctx.signal` : au minimum, documenter la responsabilité de la commande

Sans changer l'API `io/` (pas de sur-ingénierie pour un besoin non encore
concret, cohérent avec §3.5), ajouter une ligne au framework : *« Toute
commande migrée dont `execute()` contient une boucle non bornée (lecture
répétée, attente d'un événement) doit vérifier `ctx.signal.aborted`
explicitement à chaque itération et retourner un exit code cohérent
(convention à fixer : 130, `128 + SIGINT(2)`, comme un vrai shell) — la
couche I/O ne le fait pas à sa place. »*

---

## 3. Ce que cette proposition NE fait PAS

- Elle ne touche à aucun fichier de `src/command-kernel/` — c'est une
  proposition de revue, rien n'est implémenté.
- Elle ne remet pas en cause le choix (implicite jusqu'ici) d'un modèle
  d'exécution séquentiel pour les pipelines — elle demande seulement de le
  déclarer explicitement (P2) plutôt que de le laisser comme un
  comportement non documenté.
- Elle n'introduit aucune nouvelle construction syntaxique (`2>`, heredoc…)
  — P4 ne fait que réserver la place dans le type, sans lexer/parser
  associé.

---

## 4. Prochaines étapes proposées (après validation)

1. Valider/ajuster chacune des propositions P1 à P7 (accepter / rejeter /
   modifier individuellement).
2. Intégrer les points validés comme nouveau §14 (« Buffers d'entrée/sortie
   ») dans `migration_framework.md`, avec les mêmes extraits de code que ce
   document pour cohérence.
3. Implémenter uniquement les points validés qui demandent un changement de
   code (P1, P3, P5 principalement — P2, P6, P7 sont surtout de la
   documentation ; P4 est une extension de type sans comportement).
4. Tests localisés (§10 du framework) : `executor-interpreter.test.ts`
   (pipelines, redirections) a minima, plus tout fichier qui exercerait une
   commande migrée utilisant `textInput.ts` si P5 est retenu (recherche
   croisée avant modification, cohérent avec §8/§13).

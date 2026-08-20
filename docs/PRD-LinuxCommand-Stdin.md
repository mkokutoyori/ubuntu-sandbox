# PRD — L'entrée standard dans le contrat `LinuxCommand`

## 1. Ce qui manquait

`LinuxCommand` (`src/network/devices/linux/commands/LinuxCommand.ts`) décrit
tout d'une commande : son nom, ses alias, ses options, son aide, sa page de
manuel, sa complétion, son exigence de privilège. Tout sauf son entrée.

`run(ctx, args)` n'avait pas de `stdin`. L'interpréteur bash, lui, colle le
contenu canalisé en dernier mot d'`argv` :

```ts
// BashInterpreter.ts
const fullArgs = pipeInput ? [...args, pipeInput] : args;
```

Chaque commande devait donc le retrouver de là. `Xxd.ts` s'en chargeait avec
le seul discriminant disponible :

```ts
// avant
const isStdin = arg !== undefined && arg.includes('\n');
```

## 2. Pourquoi c'était indécidable

Mesure de ce qui arrive réellement à une commande du registre (sonde jetable,
les deux chemins de dispatch) :

| Ligne tapée              | `args` reçus        |
|--------------------------|---------------------|
| `printf "a\nb\n" \| cmd -x` | `['-x', 'a\nb\n']`  |
| `printf abc \| cmd -x`      | `['-x', 'abc']`     |
| `cmd fichier.txt`        | `['fichier.txt']`   |

Les deux dernières lignes ont la même forme et le sens opposé. Le
discriminant « contient un saut de ligne » lit donc **toute canalisation
d'une seule ligne comme un nom de fichier** : `printf abc | xxd` cherchait un
fichier nommé `abc`.

Aucune heuristique ne pouvait trancher, parce que l'information n'était plus
là au moment de décider.

## 3. Ce qui a été ajouté

### 3.1 Un vrai canal, de l'interpréteur jusqu'à la commande

`ExternalRequest` (`src/bash/interpreter/BashInterpreter.ts`) porte un champ
`stdin`, en plus du mot de queue qu'il continue d'ajouter — rien de ce qui
lisait ce mot ne change. Le champ traverse ensuite `ExternalCommandFn`,
`ScriptRunner` (`runScript`, `runScriptContent`, `runScriptAsync`,
`runScriptContentAsync`), `LinuxCommandExecutor.dispatchFromInterpreter` /
`dispatchMaybeNetwork` / `runScriptProcess` / `runScriptProcessAsync`, et les
deux ponts du registre.

Là où l'exécuteur découpait à l'heuristique, il n'a plus à le faire quand le
contenu lui a été transmis :

```ts
if (interpreterStdin !== undefined
    && actualArgs[actualArgs.length - 1] === interpreterStdin) {
  stdin = interpreterStdin;
  actualArgs.pop();
}
```

L'heuristique reste en repli pour les appelants qui ne transmettent rien
(`execute()` et les dispatchs imbriqués), donc rien ne régresse.

### 3.2 Deux ajouts au contrat

```ts
readonly readsStdin?: boolean;

run(ctx, args, stdin?): Promise<string> | string;
runWithStatus?(ctx, args, stdin?): Promise<…>;
runWithStatusSync?(ctx, args, stdin?): …;
```

`readsStdin` déclare que la commande lit l'entrée standard. C'est lui qui
rend le découpage décidable — pas une heuristique sur le contenu, une
déclaration de la commande.

`splitRegistryStdin` (`commands/registryStdin.ts`) applique la règle pour les
deux ponts :

- `readsStdin: true` → le contenu arrive en paramètre, l'`argv` en est
  débarrassé ;
- sinon → exactement la forme d'avant, le mot de queue et pas de paramètre.

Les paramètres sont optionnels : les 88 implémentations existantes compilent
et se comportent à l'identique sans être touchées.

## 4. Ce qui s'en sert

`xxd` (migré depuis l'heuristique) et les quatorze utilitaires de
`coreutils/TextStream.ts` : `tac`, `nl`, `paste`, `comm`, `fold`, `expand`,
`unexpand`, `fmt`, `pr`, `column`, `cmp`, `split`, `base64`, `cksum`.

Ces quatorze répondaient `command not found`. Ils sont déclarés en
`LinuxCommand` — usage, aide, options, complétion et page de manuel au même
endroit — et non ajoutés au `switch` de `LinuxCommandExecutor`.

### 4.1 Les options agglutinées

`explodeShorts` défait les agglutinats à la manière de `getopt` : `-sw 9`
devient `-s -w 9`, `-w9` devient `-w 9`, `-tn` devient `-t -n`. Un caractère
inconnu fait renoncer sur le mot entier, si bien que `fmt -10` reste une
largeur et n'est pas lu comme les drapeaux `-1` et `-0`.

Avant cette expansion, `fold -sw 9` cherchait un fichier nommé « 9 ».

### 4.2 Sorties relevées, pas déduites

Les sorties attendues par `probe-texte-01-utilitaires-flux.test.ts` ont été
relevées sur les vrais coreutils GNU, même entrée, `cat -A` pour voir les
tabulations. Trois écarts ont été corrigés dans ce sens :

| Point                  | Écrit d'abord     | Relevé réel        |
|------------------------|-------------------|--------------------|
| `cmp` sur différence   | `differ: byte 1`  | `differ: char 1`   |
| `pr -n` séparateur     | deux espaces      | une tabulation     |
| `fold -s` coupure      | (à vérifier)      | l'espace reste     |

`cksum` a été vérifié octet pour octet (`3233290692 14`), de même que
`base64`, `nl`, `fmt`, `unexpand`, `paste`, `expand`, `tac`, `split`.

## 5. Ce qui n'a pas été fait

- **`column` n'a pas pu être comparé** au vrai : il n'appartient pas aux
  coreutils et n'était pas installé sur la machine de mesure. Son
  comportement suit la documentation, pas un relevé.
- **`comm` ne prévient pas** quand une entrée n'est pas triée. Le vrai
  imprime `comm: file 1 is not in sorted order` sur stderr tout en
  produisant les mêmes colonnes ; seul l'avertissement manque.
- **`pr` ne pagine pas vraiment.** Seuls `-t` et `-n` sont là ; une vraie
  pagination demanderait une géométrie de page que cet hôte ne modélise pas,
  et l'aide de la commande le dit.
- **`bc` est traité à part** — voir `docs/PRD-Bc.md` : c'était le dernier
  refus des transcripts, et c'est un langage à part entière, pas un filtre
  de flux.
- **L'heuristique de découpage n'a pas été retirée** de
  `dispatchFromInterpreter` : elle sert encore aux appelants qui ne
  transmettent pas de `stdin`. La supprimer demanderait de faire remonter le
  canal par tous ces chemins-là aussi.

## 6. Mesures

| Transcript                     | Refus avant | Refus après |
|--------------------------------|-------------|-------------|
| `linux-pc-text-pipes`          | 35          | 1           |
| `linux-server-text-pipes`      | 35          | 1           |
| `linux-pc-system-disk`         | 22          | 20          |
| `linux-server-system-disk`     | 22          | 20          |
| autres transcripts linux       | inchangés   | inchangés   |

Le refus restant est un `grepp` — une faute de frappe délibérée du
transcript, qui doit continuer de répondre `command not found`. Les six
autres étaient des `bc`, traités dans `docs/PRD-Bc.md`.

## 7. Sondes

- `probe-linuxcommand-01-canal-stdin.test.ts` — le contrat lui-même : le
  canal sur les deux chemins de dispatch, le cas sans saut de ligne,
  l'absence de canalisation qui donne `undefined` et non une chaîne vide, et
  la compatibilité d'une commande qui ne déclare rien.
- `probe-texte-01-utilitaires-flux.test.ts` — les quatorze utilitaires,
  contre les sorties relevées.

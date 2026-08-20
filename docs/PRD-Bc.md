# PRD — `bc`, la calculatrice à précision arbitraire

## 1. Pourquoi à part

`bc` était le dernier refus des transcripts `linux-text-pipes`, et le seul
de la famille qui ne soit pas un filtre de flux. `tac` renverse des lignes ;
`bc` a une grammaire, des variables, et une arithmétique qui lui est propre.

Cette arithmétique est tout l'enjeu. `bc` ne calcule pas sur des flottants :
il calcule sur des entiers de taille libre accompagnés d'une **échelle**
décimale. Un `bc` bâti sur le `number` de JavaScript rendrait
`3.3333333333` là où le vrai rend `3.33`, et perdrait `2^200` dès le
dix-septième chiffre.

Les valeurs sont donc portées par des `bigint` :

```ts
interface Num { v: bigint; s: number }   // valeur = v / 10^s
```

## 2. Les règles d'échelle

Relevées sur `bc 1.07.1`, et vérifiées une par une :

| Opération | Échelle du résultat                                  |
|-----------|------------------------------------------------------|
| `a+b`     | `max(échelle(a), échelle(b))`                        |
| `a-b`     | idem                                                 |
| `a*b`     | `min(échelle(a)+échelle(b), max(scale, les échelles))` |
| `a/b`     | `scale`                                              |
| `a%b`     | `a - (a/b)*b`, la division faite à l'échelle courante |
| `a^b`     | `b` entier ; même borne que le produit               |

Toutes les troncatures vont vers zéro, jamais à l'arrondi.

Ces règles produisent des résultats qui surprennent, et c'est la preuve
qu'elles sont appliquées plutôt que devinées :

```
$ echo "1.50+2.5" | bc          4.00      (et non 4)
$ echo "3.0*2" | bc             6.0       (et non 6)
$ echo "scale=2;7%3" | bc       .01       (et non 1)
$ echo "scale=10; sqrt(2)" | bc 1.4142135623   (tronqué, non arrondi)
```

L'écriture aussi a sa règle : un nombre inférieur à un s'écrit sans zéro de
tête — `.250`, `-.5`.

## 3. Ce qui est là

- Expressions : `+ - * / % ^`, moins unaire, parenthèses.
- Comparaisons `== != < <= > >=`, connecteurs `&& || !`.
- Variables, affectation `=` et affectations composées `+= -= *= /= %= ^=`.
  Une affectation seule n'imprime rien, comme le vrai.
- Une variable jamais affectée vaut zéro — ce n'est pas une erreur.
- `scale`, `ibase`, `obase`.
- `sqrt()`, `length()`, `scale()`.
- Le registre de dernière valeur `.`.
- `quit`, les commentaires `#` et `/* */`, les continuations `\`.
- Les fichiers passés en argument, lus avant l'entrée standard.
- `-v` rend la version, `-q`/`-s`/`-w` sont acceptés sans effet visible.

## 4. Ce qui n'est pas là, et le dit

- **Le langage d'instructions** — `define`, `if`, `while`, `for`, `return`,
  `break`, `continue`, `auto`, `read`. Un `define` valide reçoit
  `bc: 'define' is not supported by this bc`, pas `syntax error` :
  répondre « erreur de syntaxe » à une ligne correcte laisserait croire que
  c'est la ligne qui est fausse.
- **La bibliothèque mathématique (`-l`)** — `s()`, `c()`, `a()`, `l()`,
  `e()`, `j()`. L'option est refusée d'emblée
  (`the math library (-l) is not available in this bc`). L'accepter pour
  son seul effet `scale=20` laisserait croire que ces fonctions répondent ;
  l'opérateur l'apprendrait après avoir tapé sa formule.
  Sans `-l`, appeler `s(1)` rend le message exact du vrai bc :
  `Runtime error (func=(main), adr=3): Function s not defined.`
- **Le repli de ligne à 70 colonnes** avec `\` que le vrai applique aux
  nombres très longs. `2^200` sort ici sur une seule ligne.
- **`obase` sur la partie fractionnaire** : seule la partie entière est
  convertie. `ibase` ne lit que la partie entière, comme le vrai.
- **Les tableaux** `a[i]`.

## 5. Les erreurs

Elles gardent la forme réelle, y compris le code de sortie :

```
$ echo "1/0" | bc
Runtime error (func=(main), adr=3): Divide by zero
$ echo "2 +" | bc
(standard_in) 1: syntax error
```

Le vrai `bc` sort en 0 même après une erreur d'exécution lue sur l'entrée
standard — vérifié sur `bc 1.07.1`, et reproduit ici.

## 6. Un gain de bord : `**` dans `$(( ))`

Le même paragraphe du transcript montrait `echo $((2 ** 8))` rendant `0` :
l'analyseur lexical de l'expansion arithmétique (`src/bash/runtime/Expansion.ts`)
ne connaissait pas `**` et lisait deux multiplications de suite.

Corrigé au bon niveau de priorité : `**` lie plus fort que `*` et associe à
droite, si bien que `2**3**2` vaut 512 et non 64. Un exposant négatif est
refusé (`exponent less than 0`) au lieu d'être tronqué à zéro — c'est ce que
fait bash. **`**=` n'a pas été ajouté** : bash ne l'a pas, `x **= 2` y est
une erreur de syntaxe, et l'ajouter aurait été inventer un opérateur.

## 7. Mesures

`linux-text-pipes` : 7 refus → 1. Le refus restant est le `grepp` que le
transcript tape volontairement de travers.

Chacune des trente expressions de `probe-bc-01-precision-arbitraire.test.ts`
a été comparée à la sortie de `bc 1.07.1` sur la même entrée.

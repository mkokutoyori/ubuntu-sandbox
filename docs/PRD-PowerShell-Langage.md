# PRD — Noyau du langage PowerShell

## 0. Autorite

La documentation officielle est dans `official_docs/microsoft/powershell/` (PowerShell 7.6, 5 PDF ;
`scripts/extract-powershell-docs.py` en tire le texte dans `/tmp/psdocs`). La **partie 3** contient la
specification du langage : chapitre 6 (conversions), 7 (operateurs), 8 (instructions), 9 (tableaux),
10 (tables de hachage). Les articles `about_*` des autres parties donnent le comportement actuel.
PowerShell est libre (`github.com/PowerShell/PowerShell`) : en cas de doute sur 7.x, le code source fait foi.

Deux editions, un seul moteur : `powershell.exe` est Windows PowerShell 5.1 (Desktop) ; `pwsh.exe` est
PowerShell 7.6 (Core). La syntaxe et les cmdlets propres a 7 sont refusees par 5.1 avec ses vraies erreurs.

## 1. Mesure (extraits de la doc passes dans le simulateur)

Echecs relevés sur ~140 extraits, avant tout correctif :

| Famille | Defaut mesure |
| --- | --- |
| Indexation | `'abc'[0]`, `'abc'[-1]`, `'abc'[0..1]` rendent vide ; `'abc'.ToCharArray()` vide |
| Methodes de collection | `$a.Where({})`, `$a.ForEach({})` rendent vide |
| Parametres | `$PSBoundParameters` vide ; `ValidateSet`/`ValidateRange` : message maison au lieu de celui de PowerShell |
| Types | `enum` : `[Color]::Green` vide ; `[Color2]::Green` `NaN` ; `[char]65` rend `6` ; `[int][char]'A'` `NaN` ; `[byte]300` accepte |
| Exceptions | `1/0` rend `Infinity` au lieu de lever `DivideByZeroException` ; `catch [Type]` attrape tout ; `$_.Exception.GetType()` vide |
| Operateurs | `-gt/-lt` comparent des nombres meme pour des chaines ; pas de filtrage d'un tableau a gauche ; `(1,2)*2` `NaN` |
| Instructions | `$i++` seul affiche la valeur |
| Cmdlets | `Compare-Object` : sortie fausse ; `[datetime]'..' \| Get-Date -Format s` ignore l'objet |
| Numeriques | `(5.0).GetType()` `Int32` ; `7 -is [double]` vrai ; pas de Decimal/Byte/Single |
| PowerShell 7 | `?:`, `??`, `??=`, `?.`, `\|\|`, `ForEach-Object -Parallel`, `Join-String`, `Get-Error`, `$IsWindows`, `$PSStyle`, `-AsHashtable` absents ou faux |

## 2. Lots

- **A** — bogues de 5.1 ci-dessus (un lot = une famille, une sonde par lot, discriminee par `git stash`).
- **B** — valeurs numeriques typees (`PSNumber`, `PSChar`, decimal exact), conversions du chapitre 6,
  arithmetique du §6.15, ferme l'entree TODO « le runtime n'a qu'un type numerique ».
- **C** — edition `pwsh` 7.6.
- **D** — passe systematique sur les `about_*` : un extrait = un cas, comparee a la sortie documentee.

Le noyau reste dans `src/powershell/runtime/` ; les nouveaux modules sont des fichiers a part
(`types/`, `PSOperators.ts`, `PSConvert.ts`) que l'evaluateur appelle, pas une seconde implementation.

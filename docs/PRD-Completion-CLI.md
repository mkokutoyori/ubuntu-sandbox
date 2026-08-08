# PRD — Complétion par tabulation (Cisco d'abord)

Plateforme de référence : **Cisco ISR 2911, IOS 15.7(3)M** et **Catalyst
2960, IOS 15.0(2)SE**, les mêmes que `docs/PRD-CLI-Fidelite-IOS.md`.

## Ce que fait un vrai IOS, et qui sert d'étalon

1. **Tab ne complète que si la réponse est unique.** `conf<Tab>` donne
   `configure `, `c<Tab>` ne donne rien du tout — pas de liste, pas de
   bip visible. Lister est le travail de `?`, pas celui de Tab.
2. **Tab ajoute une espace** après le mot complété.
3. **Tab derrière une espace ne fait rien.** `show <Tab>` n'affiche rien.
4. **Tab ne fabrique jamais une commande.** Un mot que l'analyseur ne
   reconnaît pas arrête la complétion ; il ne la fait pas repartir de la
   racine.
5. **Tout ce que `?` liste à un endroit, Tab sait le compléter au même
   endroit.** C'est l'invariant du chantier 3 de `PRD-Arbre-CLI.md`
   (aide ⇔ exécution) étendu à la complétion.

## Mesure de départ (2026-08-08)

Relevé sur un `CiscoRouter` et un `CiscoSwitch` réels, via
`cliTabCandidates` et `cliHelp` aux mêmes points.

| # | Constat mesuré | Règle violée |
|---|---|---|
| D1 | `zzz ho` → `zzz hostname`, `blah int` → `blah interface`, `foobar ip` → `foobar ip` | 4 |
| D2 | `ex` → `[]` dans TOUS les modes, alors que `?` liste `exit` ; idem `help`, et `end`/`do`/`default` en configuration | 5 |
| D3 | `do sh` → `[]` en config, et `do shutdown` en config-if | 4 et 5 |
| D4 | `interface gi` → 5 candidats (le type ET les ports concrets), donc Tab ne fait rien là où un vrai IOS écrit `GigabitEthernet` | 1 |
| D5 | `show int f` → `[]` : les noms d'interface ne sont proposés que derrière `interface` | 5 |

D1 et D3 sont la même cause : dans `CommandTrie.tabCandidates`, un token
intermédiaire non reconnu est empilé tel quel **sans changer de nœud**,
si bien que le mot suivant est comparé aux enfants de la racine.
`getCompletions` (le chemin de `?`) a la garde correspondante depuis le
chantier 4 — `n'avancer que si le nœud attend réellement un argument` —
et `tabCandidates` ne l'a jamais eue.

## État d'avancement

| Chantier | Objet | État |
|---|---|---|
| A | La fuite : un mot inconnu arrête la complétion | ✅ |
| B | Les commandes universelles se complètent partout | ✅ |
| C | `do <commande>` complète l'arbre EXEC | ✅ |
| D | `interface gi` complète le type, comme IOS | ✅ |

## Chantier A — un mot inconnu arrête la complétion

`tabCandidates` empilait le token et gardait le nœud courant. La marche
consomme désormais un argument **seulement si le nœud en attend un**
(`params` non épuisés ou handler glouton), exactement comme
`getCompletions` ; sinon elle rend une liste vide.

Conséquence directe et voulue : `do sh` cesse de répondre
`do shutdown`. Le chantier C lui donne la vraie réponse.

## Chantier B — les commandes universelles

`exit`, `help`, et en configuration `end`, `do`, `default` étaient
listées par `?` (chantier 5) sans jamais être complétables : elles vivent
dans `universalCommands()`, un chemin d'aide, pas dans le trie.

Elles sont désormais fusionnées dans les candidats de complétion **à
partir de la même méthode** — pas d'une seconde liste qui pourrait
diverger. `CiscoShellBase.tabCandidates` les ajoute au premier mot de la
ligne, filtrées par le préfixe tapé, et jamais en double d'un mot-clé que
le trie porte déjà.

## Chantier C — `do`

Après `do`, IOS analyse la ligne dans l'arbre EXEC privilégié. La
complétion fait de même : le reste de la ligne est complété contre
`privilegedTrie`, puis re-préfixé par `do `. `do ` seul ne propose rien,
comme toute espace finale.

## Chantier D — le type d'interface

Le résolveur dynamique proposait le type ET les ports concrets au même
rang, donc cinq candidats là où IOS n'en voit qu'un : sur un vrai
équipement, le type est un jeton et son numéro un autre, et Tab complète
le type.

Règle retenue, écrite dans le code : **un mot-clé et une valeur ne se
disputent jamais la même place.** Le résolveur dynamique n'est consulté
que si aucun mot-clé statique ne correspond au préfixe tapé — ce qui est
la règle d'analyse d'IOS lui-même, les mots-clés d'abord.

Mesuré après correctif sur un 2960 à huit ports :

```
interface ?                 → FastEthernet, GigabitEthernet, Loopback,
                              Port-channel, range, TenGigabitEthernet, Vlan
interface Fa<Tab>           → interface FastEthernet
interface FastEthernet0/<Tab> → les huit ports réels
interface FastEthernet0/3<Tab> → unique, complété
```

À noter, parce que la première rédaction de ce paragraphe le disait à
l'envers : `interface ?` ne listait **pas** les ports concrets, ni avant
ni après — il liste les types, exactement comme un vrai Catalyst. Les
ports réels reviennent dès que le type est écrit.

## Hors périmètre, et pourquoi

- **D5 (`show interfaces f`)** : le résolveur n'est consulté que pour les
  positions typées `INTERFACE`, et `show interfaces` est un handler
  glouton sans `ParamSpec`. Le corriger demande de typer les arguments
  de la famille `show`, c'est-à-dire le chantier 4 de
  `PRD-Arbre-CLI.md` appliqué à 77 sous-commandes — un travail distinct.
- **Huawei** : le VRP a sa propre politique de complétion (cyclique) et
  ses propres règles ; il vient après.

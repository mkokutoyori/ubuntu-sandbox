# Audit — la complétion par tabulation et l'aide contextuelle `?`

> Portée : les deux surfaces par lesquelles un opérateur découvre ce qu'il
> peut taper — `?` (aide contextuelle) et `Tab` (complétion) — sur les
> plateformes Cisco IOS (routeur et Catalyst) et Huawei VRP.
>
> Date de mesure : 14 août 2026. Toutes les sorties citées sont capturées
> en pilotant les équipements du simulateur, jamais recopiées de mémoire.

---

## 0. Méthode, et pourquoi elle est dite avant les conclusions

Trois règles ont gouverné ce travail, et elles expliquent la forme du
rapport.

**On mesure d'abord, on lit le code ensuite.** Chaque constat ci-dessous
part d'une transcription obtenue en appelant `cliHelp()` et
`cliTabCandidates()`/`cliTabComplete()` sur un équipement réellement
construit et démarré. Le code n'a été ouvert qu'après, pour expliquer ce
que la mesure avait trouvé.

**On confronte à de vraies machines, pas à l'intuition.** Le comportement
attendu est établi contre la documentation Cisco et, quand c'est possible,
contre des **captures** de sorties réelles — parce que la documentation
HTML écrase les blancs et tronque les listes, et que l'intuition se trompe.
Elle s'est d'ailleurs trompée deux fois ici, et c'est écrit en §8.

**Un balayage systématique plutôt qu'un échantillon.** Deux parcours en
largeur de l'arbre d'aide (538 chemins en EXEC privilégié, 878 en
configuration globale) vérifient mécaniquement que toute commande offerte
par `?` possède elle-même une aide. C'est ce balayage qui a trouvé les
constats G4, et non une inspection à l'œil.

---

## 1. Synthèse — la seule chose à retenir

Le mécanisme est bien plus complet qu'attendu : l'arbre est riche, les
types d'arguments sont rendus dans la notation d'IOS, l'aide de mot et
l'aide d'argument sont correctement distinguées, le Catalyst et VRP ont
chacun leur arbre. **Ce qui est cassé n'est presque jamais le contenu,
c'est la cohérence entre les deux portes et avec l'analyseur.**

| | Constat le plus coûteux |
|---|---|
| **Sécurité** | **`Tab` n'obéit pas aux vues CLI ni au niveau des descendants.** Dans une vue qui n'inclut que `show version`, `Tab` propose et insère `show ip route`. `?` filtre correctement ; `Tab` non. Les deux portes ne rendent pas le même verdict sur la même question. |
| **Conformité** | **`<cr>` est rendu en PREMIER ; IOS le rend en DERNIER**, et l'ordre est insensible à la casse là où IOS trie en ASCII. Chaque liste d'aide de la plateforme est donc dans le mauvais ordre. |
| **Justesse** | **L'aide décrit parfois une autre position que celle où l'on est** (`ip access-group ?`), **promet ce que l'analyseur refuse** (`dhcp`, `eq`), et **annonce `<cr>` sur des commandes incomplètes**. |
| **Génie logiciel** | **L'aide d'un nœud glouton est DÉRIVÉE du texte source de son gestionnaire.** 258 continuations dérivées sur le seul arbre du mode `line`, dont 76 sans description. Cette dérivation est la cause commune de six constats. |

Deux chiffres pour situer : sur 1 416 chemins d'aide parcourus, **15
mènent à une aide morte** (1 %) — le contenu est donc solide ; mais **100 %
des listes contenant `<cr>` sont dans le mauvais ordre**, et **la vue CLI
n'est respectée par aucune des deux formes de complétion**.

---

## 2. Constats critiques

### C1. `Tab` ignore la vue CLI — les deux portes ne disent pas la même chose

**Mesuré.** Routeur avec `aaa new-model`, une vue `NOC` dont le contenu
est exactement `commands exec include show version`, et une règle
`privilege exec level 5 show ip route` par ailleurs. Session entrée dans
la vue :

```
Current view is 'NOC'

? «show »      : ["  version  Display system hardware and software status"]
TAB «sh»       : ["show", "show ip route"]
TAB «show »    : ["show", "show ip route"]
TAB «show ip»  : ["show ip route"]
exec «show ip route» : "% Invalid input detected at '^' marker."
```

`?` est filtré correctement. **`Tab` propose `show ip route`, que la vue
exclut** — et le propose parce que la table des NIVEAUX l'y autorise, table
qu'une vue est précisément censée remplacer.

**Pourquoi c'est critique.** Ce n'est pas une élévation de privilège :
l'exécution est bien refusée. C'est pire au sens de l'audit — c'est une
**incohérence entre deux portes d'une même décision**, la faute que ce
dépôt traite partout ailleurs comme cardinale. Concrètement :

1. La sémantique documentée d'une vue est qu'une commande hors de la vue
   est **absente**. `Tab` la rend présente : elle apparaît, et elle est
   **insérée dans la ligne** de l'opérateur.
2. Un auditeur qui vérifie un rôle en tabulant conclura que le rôle voit
   `show ip route`. Un auditeur qui vérifie avec `?` conclura l'inverse.
   Les deux ont utilisé la machine.
3. La cause est structurelle : `?` passe par un chemin filtré,
   `tabCandidates` par un autre. Tant que les deux ne lisent pas la même
   décision, la prochaine règle d'autorisation ajoutée sera oubliée par
   l'une des deux.

**Attendu.** Une commande absente de la vue n'est proposée par aucune des
deux surfaces.

---

### C2. `?` et `Tab` divulguent des branches inatteignables par le niveau

**Mesuré.** Routeur avec `privilege exec level 1 show` et
`privilege exec level 5 show ip route`. Session au **niveau 1** :

```
Current privilege level is 1

«show ?» offre «ip»  : true
«show ip ?»          : "% Invalid input detected at '^' marker."
«show ip route»      : "% Invalid input detected at '^' marker."
TAB «show i»         : ["show inventory","show interfaces","show ip","show ipv6"]
TAB «show ip r»      : []
```

`show ?` **liste `ip`**, et `Tab` **propose `show ip`** — alors que
`show ip ?` et `show ip route` sont l'un et l'autre refusés, correctement,
par la promotion des parentes.

**Pourquoi c'est critique.** La liste d'aide est le seul inventaire des
droits qu'un opérateur peut consulter. Elle annonce ici une branche qu'il
ne peut pas ouvrir. Sur IOS, une commande hors du niveau n'apparaît pas
dans l'aide — c'est même la raison pour laquelle IOS répond
`% Invalid input detected` plutôt que « accès refusé » : le mécanisme est
conçu pour que la commande soit **invisible**, pas seulement interdite.
Rendre le nœud visible et le refuser ensuite annule la moitié du bénéfice
et donne à l'opérateur une carte fausse.

Noter la conséquence secondaire : `TAB «show ip r»` rend `[]`, donc le
filtrage EXISTE un cran plus bas. Le filtre est appliqué à la feuille et
non au nœud intermédiaire — ce n'est pas une absence de mécanisme, c'est
une application incomplète.

---

## 3. Constats majeurs

### M1. `<cr>` est rendu en premier ; IOS le rend en dernier

**Mesuré**, sur quatre commandes indépendantes :

```
«reload ?»     rendu : ["<cr>","at","cancel","in","LINE"]
«ping ?»       rendu : ["<cr>","A.B.C.D","ip","ipv6","repeat","size","source","timeout"]
«traceroute ?» rendu : ["<cr>","A.B.C.D","ip","ipv6","probe","timeout","ttl"]
«terminal ?»   rendu : ["<cr>","history","length","monitor","no","width"]
```

**Attendu.** La documentation Cisco est explicite : « le symbole `<cr>`
apparaît **en fin** de sortie d'aide pour indiquer que vous avez la
possibilité d'appuyer sur Entrée », et « les arguments et mots-clés
précédant le symbole `<cr>` sont optionnels ». Une capture réelle de
`reload ?` donne :

```
/noverify
/verify
LINE
at
cancel
in
warm
<cr>
```

`<cr>` est le **dernier** élément, et il n'est pas trié : il est
special-casé en fin de liste.

**Portée.** Toutes les listes de la plateforme contenant `<cr>`. Ce n'est
pas cosmétique : `<cr>` en tête se lit comme « la première option est de
valider », alors qu'IOS l'écrit en dernier précisément pour dire « et si
rien de ce qui précède ne vous intéresse, validez ».

---

### M2. L'ordre est insensible à la casse ; IOS trie en ASCII

**Mesuré.** `reload ?` rend `at, cancel, in, LINE`. La même capture réelle
rend `LINE, at, cancel, in` — et, un cran plus haut, `/noverify` et
`/verify` avant `LINE`.

L'ordre d'IOS est celui des octets : `/` (0x2F) < majuscules (0x41…) <
minuscules (0x61…). Le simulateur trie sans tenir compte de la casse, si
bien que **tous les substituts d'argument en majuscules** — `LINE`,
`WORD`, `A.B.C.D`, `X:X:X:X::X` — tombent au milieu des mots-clés au lieu
d'ouvrir la liste.

**Portée.** Toute liste mêlant un substitut et des mots-clés. C'est
visible sur `reload`, `ping`, `traceroute`, `username`, `access-list`,
`description`…

---

### M3. `do ?` et `default ?` répondent `% Invalid input`

**Mesuré**, en configuration globale :

```
### ? «do »
% Invalid input detected at '^' marker.

### ? «default »
% Invalid input detected at '^' marker.
```

Or les deux sont **offerts par la liste du mode** :

```
  default          Set a command to its defaults
  do               To run exec commands in config mode
```

L'aide annonce donc deux commandes dont l'aide est morte. Sur IOS, `do ?`
liste l'ensemble des commandes EXEC (c'est tout l'intérêt de `do`), et
`default ?` liste ce qui peut être remis à sa valeur par défaut.

C'est un cas particulier de G4, mais il est classé majeur pour deux
raisons : `do` est une commande d'usage quotidien, et l'aide de `do` est
la seule façon de découvrir qu'on peut lancer une commande EXEC sans
quitter le mode configuration.

---

### M4. `ip access-group ?` décrit une autre position que celle où l'on est

**Mesuré**, en `config-if` :

```
### ? «ip access-group »
  <cr>  
  in    Inbound direction
  out   Outbound direction
```

**Attendu.** La syntaxe documentée est
`ip access-group {access-list-number | name} {in | out}`. À cette
position, IOS attend **le numéro ou le nom de la liste**, et son aide rend
`<1-199>` / `<1300-2699>` / `WORD`. Ce que le simulateur affiche est
l'aide de la position **suivante**.

**Conséquence.** L'aide saute silencieusement un argument obligatoire.
L'opérateur qui suit l'aide tape `ip access-group in` — et l'analyseur,
lui, réclame la liste. L'aide et l'analyseur ne décrivent pas la même
commande. Le `<cr>` en tête aggrave : il annonce que la commande est déjà
complète alors qu'il lui manque deux mots.

---

### M5. L'aide promet des mots-clés que l'analyseur refuse

Deux cas mesurés, tous deux vérifiés en tapant réellement la commande :

```
«ip address 10.0.0.1 255.255.255.0 ?» offre «dhcp» = true
«ip address 10.0.0.1 255.255.255.0 dhcp» -> "% Invalid input detected at '^' marker."

«access-list 10 ?» offre «eq» = true
«access-list 10 eq 80» -> "% Invalid action \"eq\""
```

`dhcp` n'a de sens qu'à la place de l'adresse (`ip address dhcp`), pas
après un masque. `eq` est un opérateur de port, pas une action d'ACL.

Dans les deux cas l'aide propose, l'opérateur tape, et la machine refuse.
C'est la forme la plus coûteuse d'aide fausse : elle fait perdre du temps
à celui qui lui fait confiance, et elle apprend une syntaxe qui n'existe
pas.

*Constat voisin, dans l'autre sens :* `access-list 10 ?` **n'offre pas**
`remark`, qui est un mot-clé réel d'IOS — et l'analyseur le refuse aussi.
L'aide est donc honnête ici ; c'est l'analyseur qui est incomplet. Ce
n'est pas un défaut d'aide, et c'est dit pour ne pas le compter deux fois.

---

### M6. `<cr>` mensonger : l'aide annonce complet ce qui est incomplet

**Mesuré** :

```
«network 10.0.0.0 0.0.0.255 ?» annonce <cr> = true
«network 10.0.0.0 0.0.0.255»   -> "% Incomplete command."

«clock ?» annonce <cr> = true
«clock»   -> "% Incomplete command."
```

`<cr>` a une signification précise et unique : *vous pouvez valider ici*.
Quand la validation répond `% Incomplete command.`, le marqueur ment sur
la seule chose qu'il affirme.

Un balayage systématique de dix commandes-racines trouve **deux
désaccords** entre ce que `?` annonce et ce que l'exécution fait —
`clock` (l'aide dit complet, la machine dit incomplet) et, en sens
inverse, `crypto` (l'aide dit incomplet, la machine **accepte** `crypto`
seul et ne fait rien). Le second est un défaut d'analyseur révélé par
l'aide, pas un défaut d'aide.

---

### M7. Sur un nœud glouton non déclaré, `?` recopie la liste du MODE

**Mesuré**, en `config-line` :

```
### ? «speed »
  <cr>            
  authentication  Authentication configuration
  autocommand     Command to execute on login
  banner          Define a login banner
  …
```

`speed` sur une ligne attend un débit. L'aide rend la liste des mots-clés
du **mode `line`** — parce que, faute de déclaration d'argument, elle
retombe sur l'extraction automatique (G1) qui a scrapé ces mots dans le
texte du gestionnaire.

Le correctif précédemment appliqué à ce défaut (`password ?`, qui est
aujourd'hui correct : `LINE  The UNENCRYPTED (cleartext) line password`)
a été posé **commande par commande**, par déclaration explicite. Il n'a
donc traité que les commandes déclarées, et `speed` — comme les 75 autres
continuations sans description de cet arbre — est resté en l'état.

---

### M8. `Tab` propose ce que `?` a écarté

**Mesuré**, sur la même commande et au même instant :

```
? «password »    -> ["  LINE  The UNENCRYPTED (cleartext) line password"]
TAB «password a» -> ["password absolute-timeout","password authentication","password autocommand"]
```

L'aide de `password` est correcte. La tabulation, elle, propose trois
mots-clés du mode `line` comme s'ils complétaient `password`.

C'est le pendant de C1 sur une autre décision : **le filtre des
continuations non décrites a été posé sur le rendu de `?` seulement.**
`tabCandidates` ne le consulte pas. Deux portes, un filtre, appliqué à une
seule.

*Nuance mesurée et dite :* `password absolute-timeout` est **accepté** par
l'analyseur — parce qu'il pose le mot de passe littéral
`absolute-timeout`, ce qui est légitime. La tabulation ne mène donc pas à
une erreur ; elle mène à un mot de passe que l'opérateur n'a pas choisi.

---

### M9. Fuite de description d'une commande vers une autre

**Mesuré**, en `config-if` sur un Catalyst :

```
### ? «channel-group 1 »
  <cr>    
  active  Active state
  auto    Automatic mode
  mode    Set trunking mode of the interface
```

`mode` porte ici **la description de `switchport mode`** — « Set trunking
mode of the interface » — qui n'a rien à voir avec l'agrégation de liens.
La description a fuité d'une commande vers une autre par la résolution des
descriptions canoniques par mot-clé.

Et `active` / `auto` ne sont pas valides à cette position :

```
«channel-group 1 active»      -> "% Incomplete command."
«channel-group 1 mode active» -> ""
```

Sur IOS, `channel-group 1 ?` n'offre que `mode`. Les deux autres viennent
de l'extraction automatique.

---

### M10. Aucune complétion dynamique : `?` offre des valeurs, `Tab` n'en offre aucune

**Mesuré** :

```
? «interface »          -> 8 types (BVI, Ethernet, FastEthernet, GigabitEthernet, …)
TAB «interface »        -> complete=null cand=[]

? «show interfaces »    -> accounting, counters, description, rate-limit, stats, summary
TAB «show interfaces »  -> cand=[]
TAB «show interfaces Gig» -> cand=[]

? «ip access-group »    -> in, out       (aucune des ACL 10 et MAVIE configurées)
TAB «ip access-group »  -> cand=[]
```

Trois manques distincts :

1. **`Tab` ne complète aucun nom d'interface**, alors que `?` en liste les
   types. Sur IOS, `interface Gi<Tab>` complète et `show interfaces Gi<Tab>`
   aussi. Ici `interface Gig` complète le TYPE
   (`interface GigabitEthernet `) et s'arrête : le numéro n'est jamais
   proposé, bien que les ports existent et soient énumérables.
2. **`show interfaces ?` n'offre pas les interfaces elles-mêmes**, alors
   qu'IOS liste les types à cette position.
3. **Aucun argument dynamique n'est proposé** : ni les ACL existantes
   après `ip access-group`, ni les VLAN, ni les noms de vues, ni les
   route-maps. Le trie possède pourtant un `DynamicParamResolver` — le
   mécanisme existe et n'est presque pas branché.

---

### M11. `vlan ?` est mort en configuration globale sur un Catalyst

**Mesuré** :

```
«vlan 10»   -> ""                                        (accepté)
«? vlan »   -> "% Invalid input detected at '^' marker."  (aide morte)
```

La commande la plus tapée d'un cours sur les VLAN n'a pas d'aide, alors
qu'IOS rend `<1-4094>` et `WORD`.

---

### M12. Les candidats de `Tab` ne sont pas triés

**Mesuré** :

```
TAB «show v» -> ["show vrf","show vrrp","show version","show vlans"]
```

L'ordre est celui de l'insertion dans l'arbre. Quand la liste est affichée
à l'opérateur (cas d'ambiguïté sur les plateformes qui l'affichent, et
cycle sur `Tab` répété), elle paraît aléatoire.

---

## 4. Génie logiciel

### G1. L'aide est DÉRIVÉE du texte source des gestionnaires

C'est la cause commune de M7, M8, M9 et de la moitié de G3. Un nœud
glouton sans déclaration d'argument voit ses « continuations » extraites
du **code source** de son gestionnaire (`autoContinuations`).

**Inventaire mesuré**, par arbre :

| Arbre | continuations dérivées | sans description |
|---|---|---|
| `configTrie` | 58 | 0 |
| `privilegedTrie` | 68 | 0 |
| `userTrie` | 38 | 1 |
| `configIfTrie` | 44 | 8 |
| `configLineTrie` | **258** | **76** |

L'arbre du mode `line` est le cas extrême : 258 continuations dérivées, ce
qui produit des chemins comme `password absolute-timeout`,
`password escape-character`, `speed banner`, `speed break` — le produit
cartésien des commandes du mode par elles-mêmes.

**Pourquoi c'est un défaut de génie logiciel et pas seulement d'affichage.**
Une aide dérivée du code se défait dès qu'on réécrit le code, sans que
rien ne le signale. Le dépôt en a déjà fait l'expérience : réécrire le
corps de `no privilege` pour qu'il délègue son analyse a fait disparaître
le mot `level` du texte source, et `no privilege ?` s'est aussitôt mis à
recopier la description de son parent. Le mécanisme transforme un
refactoring en régression d'aide.

### G2. Deux portes pour une décision

`?` et `Tab` sont servis par deux chemins qui n'appliquent pas les mêmes
filtres :

| Filtre | `?` | `Tab` |
|---|---|---|
| niveau de privilège (feuille) | oui | oui |
| niveau de privilège (nœud intermédiaire) | **non** (C2) | **non** (C2) |
| vue CLI | oui | **non** (C1) |
| continuations non décrites | oui | **non** (M8) |

Trois des quatre constats critiques ou majeurs de cohérence sont des
cases de ce tableau. Tant que les deux surfaces ne lisent pas **une**
décision, chaque règle d'autorisation future devra être branchée deux
fois — et l'histoire de ce dépôt dit qu'elle ne le sera qu'une.

### G3. Descriptions absentes livrées en production

**Cinq nœuds Cisco** rendent un mot-clé sans description :

```
«debug ip nat ?»        -> detailed    (sans description)
«show crypto engine ?»  -> connections (sans description)
«show crypto key ?»     -> mypubkey    (sans description)
«show ip nat ?»         -> nvi         (sans description)
«show ip pim ?»         -> rp          (sans description)
```

**Et deux nœuds VRP** en vue utilisateur : `free` et `kill`.

Une entrée d'aide sans description est une entrée qui n'aide pas : elle
occupe une ligne pour dire qu'un mot existe, ce que la tabulation dit
déjà.

### G4. Aides mortes — l'aide offre ce dont l'aide ne sait rien

Le balayage systématique (538 chemins en EXEC privilégié, 878 en
configuration) trouve **15 chemins** offerts par `?` et dont l'aide propre
répond `% Invalid input` :

*EXEC privilégié (9)* — `exit ?`, `help ?`, `clear mac ?`, `debug dhcp ?`,
`write terminal ?`, `copy running-config flash: ?`,
`copy running-config scp: ?`, `copy running-config startup-config ?`,
`copy running-config tftp: ?`.

*Configuration globale (6)* — `default ?`, `do ?`, `end ?`, `exit ?`,
`help ?`, `no line ?`.

Deux familles s'y distinguent, et elles n'appellent pas le même remède :

- **`exit`, `end`, `help`** sont des commandes sans argument. IOS rend
  `<cr>` pour celles-là, jamais un refus. Ce sont donc de vraies aides
  manquantes, à un caractère près.
- **`copy running-config <destination> ?`** décrit une position réelle où
  IOS attend un nom de fichier ou un `<cr>`. L'aide s'arrête une position
  trop tôt.

Le taux — 15 sur 1 416, soit 1 % — est **bas**, et c'est la mesure la plus
favorable de cet audit. Elle est citée telle quelle.

### G5. Blancs de fin de ligne sur le marqueur `<cr>`

`<cr>` est rembourré à la largeur de la colonne des descriptions alors que
sa description est vide, ce qui laisse des espaces en fin de ligne :

```
"  <cr>          "
"  <cr>    "
```

Mesuré sur 2 des 4 listes échantillonnées. Sans conséquence fonctionnelle,
mais une sortie de référence ne devrait pas porter de blanc final — et les
sondes qui comparent au caractère près doivent le contourner.

---

## 5. Fidélité de rendu

| # | Constat | Mesuré | Source |
|---|---|---|---|
| F1 | `<cr>` en tête au lieu d'en queue | oui | doc Cisco + capture `reload ?` |
| F2 | Tri insensible à la casse au lieu d'ASCII | oui | capture `reload ?` |
| F3 | `show running-config \| ?` n'offre pas `format` | oui | doc IOS 15 |
| F4 | Alignement de la colonne de description : correct, une largeur par liste | conforme | — |
| F5 | Aide de mot (`sh ac ?` → deux réponses) : correcte | conforme | — |

---

## 6. Ce qu'un correctif doit traiter, dans l'ordre

L'ordre suit la dépendance, pas seulement la gravité.

1. **G2 — une seule décision pour les deux portes.** Faire lire à
   `tabCandidates` exactement le filtre que `getCompletions` applique
   (vue, niveau, continuations non décrites). Referme **C1, M8**, et la
   moitié de **C2**, sans logique nouvelle.
2. **C2 — filtrer les nœuds intermédiaires**, et pas seulement les
   feuilles : un nœud dont aucun descendant n'est atteignable ne
   s'affiche pas.
3. **M1/M2 — l'ordre.** Une seule fonction de tri : ASCII, `<cr>`
   toujours dernier, jamais trié. Corrige toutes les listes d'un coup, et
   G5 avec (ne pas rembourrer une description vide).
4. **G1 — cesser de dériver l'aide du code.** Déclarer les arguments là
   où ils manquent, et **retirer l'extraction automatique** plutôt que la
   filtrer à l'affichage : tant qu'elle existe, `Tab` la verra. Referme
   **M7, M8, M9** et les 85 continuations sans description.
5. **M4/M5/M6 — la position et la promesse.** Un garde-fou mécanique est
   possible et vaut mieux qu'une correction au cas par cas : pour chaque
   mot-clé offert, vérifier qu'il est accepté ; pour chaque `<cr>`
   annoncé, vérifier que la commande s'exécute. Les deux se testent par
   balayage, comme G4 l'a été.
6. **M3, M11, G4 — les aides mortes**, par famille et non une par une.
7. **M10 — brancher le résolveur dynamique** (interfaces, ACL, VLAN,
   vues), qui existe déjà.
8. **M12** — trier les candidats de `Tab`.

Chaque correctif devrait être livré avec une sonde **discriminée par
`git stash`**, comme le fait ce dépôt : les transcriptions attendues avant
et après sont dans ce rapport.

---

## 7. Ce qui est correct, et qui n'a donc pas été touché

Le dire est ce qui distingue un audit d'un réquisitoire. Vérifié par
mesure :

* **L'aide de mot et l'aide d'argument sont correctement distinguées.**
  `sh ac ?` rend deux réponses (`access-lists`, `accounting`), `c ?` en
  rend quatre, `sh ?` rend l'arbre de `show`. C'est exactement la
  distinction d'IOS entre aide partielle et aide contextuelle.
* **Les types d'arguments sont rendus dans la notation d'IOS** :
  `A.B.C.D`, `<1-4094>`, `<1-10000000>`, `WORD`, `LINE`. Mesuré sur
  `ip address ?`, `bandwidth ?`, `username ?`, `description ?`,
  `access-list ?`, `switchport access vlan ?`.
* **Le Catalyst possède bien son aide d'arguments.** `switchport ?`,
  `switchport mode ?`, `switchport access vlan ?` (`<1-4094>`),
  `switchport trunk ?`, `channel-group ?` (`<1-64>`) répondent toutes
  correctement. *La note de `CLAUDE.md` affirmant que le commutateur ne
  reçoit pas `describeCiscoArguments` est en retard sur le code.*
* **`Tab` refuse d'étendre une abréviation ambiguë**, ce qui **est** le
  comportement d'IOS — la documentation dit que le système émet un bip et
  n'étend rien. Voir §8 : j'avais supposé l'inverse.
* **`no ?` est honnête** : ce qu'il liste est exactement ce que `no`
  accepte. Vérifié dans les deux sens sur sept commandes. Les absences
  (`no snmp-server`, `no class-map`, `no time-range`…) sont des lacunes
  de l'**analyseur**, que l'aide reflète fidèlement.
* **Le filtrage de `?` par niveau et par vue fonctionne au premier rang**
  (C1 et C2 portent sur les rangs suivants, pas sur celui-là).
* **Les modificateurs de tuyau sont servis** : `show running-config | ?`
  rend `append begin count exclude include redirect section tee`, et
  `| i` réduit correctement à `include`.
* **La colonne des descriptions est alignée** par liste, sur la largeur du
  plus long mot-clé, sans doublon dans aucune des listes échantillonnées.
* **VRP possède son propre arbre complet** : 26 entrées en vue
  utilisateur, 76 en vue système, 76 sous `display`, avec les vues et
  les descriptions propres à Huawei.

---

## 8. Mes propres erreurs de mesure, et ce qu'elles ont failli produire

Deux fois pendant cet audit, j'ai été à un pas de déposer un constat faux.
C'est écrit ici parce qu'un rapport qui ne montre que ses succès de mesure
ne permet pas de juger de sa fiabilité.

**Un — le Catalyst.** Ma première sonde construisait le commutateur par
`new CiscoSwitch('SW1', 0, 0)`. La signature réelle étant
`(type, name, portCount, x, y)`, `'SW1'` était passé comme **type** :
l'équipement n'avait pas les bons ports, `interface GigabitEthernet0/1`
échouait silencieusement, et toutes les commandes `switchport` étaient
refusées. J'ai mesuré « aide morte sur commutateur, et commandes mortes
avec » et j'allais l'écrire. En reconstruisant correctement
(`new CiscoSwitch('switch-cisco', 'SW1')`, ports `FastEthernet0/x`), tout
répond — et le Catalyst figure aujourd'hui au §7, dans ce qui est correct.

**Deux — la tabulation ambiguë.** J'avais supposé, par analogie avec les
interpréteurs de commandes Unix, qu'IOS complétait jusqu'au **préfixe
commun le plus long** — et j'avais donc noté comme défaut le fait que
`show ac` + `Tab` ne produise rien alors que `access-lists` et
`accounting` partagent `acc`. La documentation dit l'inverse : quand la
saisie correspond à plusieurs commandes, « le système émet un bip pour
indiquer que la chaîne n'est pas unique » et n'étend rien. **Le simulateur
est conforme, et c'était mon attente qui ne l'était pas.**

La leçon est la même dans les deux cas et vaut au-delà de cet audit : un
laboratoire mal monté et une fonction défaillante sont indiscernables tant
qu'on n'a pas de témoin, et une conformité se vérifie contre une source,
jamais contre une analogie.

---

## 9. Sources

* Cisco, *Configuration Fundamentals Configuration Guide — Using the Cisco
  IOS Command-Line Interface* (12.2SR, 15.0S, 15S, XE 16.9) : sémantique
  et **position finale** de `<cr>`, aide partielle vs aide contextuelle,
  comportement du bip sur abréviation ambiguë.
* Cisco, *EXEC Commands in Configuration Mode* (15M&T, 15SY) : la commande
  `do`, sa portée et sa restriction sur `configure terminal`.
* Cisco, *ip access-group* (command reference) : la syntaxe
  `{access-list-number | name} {in | out}`, qui fixe la position attendue
  par `ip access-group ?`.
* Capture réelle de `reload ?` (`/noverify /verify LINE at cancel in warm
  <cr>`) : ordre ASCII et position de `<cr>`.
* Mesures propres : sondes `cliHelp` / `cliTabCandidates` /
  `cliTabComplete` sur `CiscoRouter`, `CiscoSwitch` et `HuaweiRouter`,
  1 416 chemins d'aide parcourus, transcriptions conservées.

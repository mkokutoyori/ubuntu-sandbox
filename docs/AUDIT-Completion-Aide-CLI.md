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

---

# Carnet de bord — correctifs

## Étape 1 — une seule porte pour l'autorisation (C1, et la moitié de G2)

**Ce que la mesure a trouvé sous le constat.** La fuite n'était pas un
filtre absent, c'était un filtre **contourné**. `tabCandidates` filtre
correctement ses candidats par `laSessionVoit` — puis **ajoute derrière**
les règles `privilege` accordées, sans les soumettre à quoi que ce soit :

```ts
for (const { cible } of this.reglesExecAccordees()) {
  if (cible.startsWith(prefixe) && !base.includes(cible)) base.push(cible);
}
```

L'ajout lui-même est légitime et doit rester : une commande **descendue**
depuis l'arbre privilégié n'est pas dans l'arbre utilisateur, donc la
marche du trie ne peut pas la trouver. Ce qui manquait, c'est qu'il passe
par la même porte que le reste.

**Et le pendant côté `?` était protégé par accident.**
`completionsAccordeesParNiveau` ne fuyait pas — mais grâce à deux gardes
qui ne parlent pas de vue : `mode !== 'user'` et « ni le niveau 1, ni le
niveau 15 ». Une session en vue est au niveau 15, donc elle sortait par la
seconde. *Un garde qui protège pour une raison qui n'est pas la sienne
protège jusqu'au jour où la raison change.* Les deux injections consultent
désormais explicitement `laSessionVoit`.

**Ce que le correctif ne fait pas, et c'est voulu.** Il n'unifie pas les
deux méthodes en une : elles ne rendent pas la même chose (`?` rend le
mot-clé de la position courante, `Tab` rend la ligne entière). Ce qui est
unifié est la **décision** — le prédicat — et c'est le seul point où
elles pouvaient diverger.

**Discrimination.** `probe-completion-vue-et-niveau.test.ts` (7 cas) :
**2 tombent** avant correctif — la citation et la complétion d'une
commande hors de la vue. Les 5 autres sont les témoins, et ils sont la
partie délicate de cette sonde : sans eux, un filtre qui écarterait
**tout** passerait pour un correctif. Ils vérifient donc qu'au niveau 5,
hors d'une vue, `Tab` propose **toujours** `show ip route` ; qu'au
niveau 1 il ne le propose pas ; qu'au niveau 15 la tabulation ordinaire
fonctionne ; et que ce que la vue inclut reste complétable et exécutable.
Un cas ferme la boucle en exécutant **chaque** candidat que `Tab` rend
dans la vue et en exigeant qu'aucun ne réponde `% Invalid input`.

Non-régression connexe : 204 fichiers, 5 782 cas. `tsc` : 337 erreurs
avant comme après, à la ligne près.

## Étape 2 — un nœud qui ne mène nulle part ne se propose plus (C2)

**Trois fois, la mesure a corrigé le correctif.** C'est l'étape où
supposer coûtait le plus cher, et les trois erreurs valent d'être écrites.

**Un — le nœud intermédiaire n'en est pas un.** J'ai d'abord traité le cas
« `niveauParDefautDe` rend `null` », en croyant que `show ip` n'avait pas
de niveau. Mesuré : il en a un, **1**. L'arbre porte bien une action sur
ce nœud, et atteindre `show ip` ne demande en effet que d'atteindre
`show`. La branche corrigée ne se déclenchait donc jamais.

**Deux — le prédicat existait en double.** Le correctif ne changeait rien
parce que la CLI n'appelle pas `commandVisibleToNow` mais `laSessionVoit`,
qui portait **sa propre copie** de l'appel à `authorize` — sous un
commentaire annonçant « une seule règle, déjà écrite ». Les deux ont
divergé au moment exact où l'une a appris quelque chose. `laSessionVoit`
délègue désormais.

**Trois — la borne était elle-même un défaut.** J'avais borné le parcours
des descendants à 64 chemins pour en limiter le coût. Dans une vue ne
contenant que `show version`, la troncature coupait **avant lui** : `show`
disparaissait de la complétion, et le témoin de l'étape 1 l'a attrapé. Le
prédicat est maintenant passé **à** la marche, qui s'arrête au premier
descendant qui convient — sans borne, et plus vite qu'avec.

**La règle, une fois juste.** Un nœud est visible s'il est **validable ici**
*ou* s'il **mène à quelque chose de visible** — un OU, pas un ET. Ma
première version exigeait les deux, et cassait `show running-config`
descendue au niveau 10 : elle est validable seule, mais tout ce qui la
complète (`all`, `interface …`) reste au niveau 15. Le signal qui
distingue « validable ici » de « simple point de passage » existait déjà
et est celui qu'IOS affiche : le marqueur `<cr>`. `show running-config`
en a un, `show ip` n'en a pas.

**Le repli reste OUVERT** : un chemin sans aucun descendant exécutable
connu demeure proposé. Masquer ici n'est pas une frontière de sécurité —
l'exécution l'est, et elle refuse — donc en cas de doute une liste trop
large vaut mieux qu'une CLI amputée.

**Coût, mesuré et non supposé.** `?` sur `show ` passe de 0,7 ms à 3 ms au
niveau 1. Le cas de très loin le plus courant — niveau 15, hors vue — est
court-circuité par un fait plutôt que par une optimisation : rien ne peut
être au-dessus de 15, donc le parcours ne pourrait rendre que `true`.

**Discrimination.** `probe-aide-noeuds-intermediaires.test.ts` (9 cas) :
**3 tombent** avant correctif. La paire qui porte tout le poids est
`ip` contre `ipv6` — au même instant, sur la même machine et au même
niveau, `show ipv6 interface brief` **s'exécute**. Un correctif qui
masquerait les deux serait aussi faux que celui qui n'en masque aucun, et
c'est le seul témoin qui les distingue. Un dernier cas ferme la boucle :
**chaque** mot-clé que `show ?` propose au niveau 1 doit avoir une aide
qui répond.

Non-régression connexe : 205 fichiers, 5 791 cas. `tsc` : 337, à la ligne
près.

## Étape 3 — l'ordre d'IOS : ASCII, `<cr>` en dernier (M1, M2, G5)

**Les deux constats n'en font qu'un, et la cause était à un seul endroit.**
L'arbre classait déjà correctement — son tri range `<cr>` en queue et les
substituts après les mots-clés — et `getHelp` **retriait** derrière lui
par `localeCompare`. Ce retri annulait tout : il remontait `<cr>` en tête
(`<` vaut 0x3C, donc avant les lettres) et rendait le tri insensible à la
casse, si bien que `LINE`, `WORD` et `A.B.C.D` tombaient au milieu des
mots-clés.

`ordonnerCommeIos()` remplace les deux appels. La règle qu'elle écrit tient
en une phrase : **`<cr>` est placé, pas classé** — le trier avec les autres
le remettrait en tête, quel que soit le comparateur.

**Pourquoi le tri est sur les octets et non sur la locale.** La capture de
référence donne `/noverify`, `/verify`, `LINE`, `at`, `cancel`, `in`,
`warm`, `<cr>` : `/` (0x2F) avant les majuscules (0x41…) avant les
minuscules (0x61…). Un `localeCompare` place `at` avant `LINE`, ce que
la machine ne fait jamais.

**G5 fermé au passage**, et pour la même raison qu'il existait : `<cr>` n'a
pas de description, et la ligne était quand même rembourrée à la largeur
de la colonne. Une description vide ne se rembourre plus.

**Trois renderers, pas un.** `?` est servi par trois fonctions distinctes —
`CiscoShellBase`, `HuaweiVRPShell`, `HuaweiSwitchShell`. Mesuré avant de
corriger : VRP plaçait déjà `<cr>` en queue (sa propre construction le
met en dernier), donc **seul le rembourrage y était faux**. Corriger
l'ordre côté VRP aurait été corriger ce qui n'était pas cassé ; les deux
fichiers ne reçoivent que le correctif du blanc final, et un cas de la
sonde le vérifie sur chaque plateforme.

**Discrimination.** `probe-aide-ordre-ios.test.ts` (24 cas) : **13
tombent** avant correctif. Les 11 autres sont les non-régressions —
l'alignement de la colonne, le contenu des listes sans `<cr>`, les
modificateurs de tuyau, et le fait que `<cr>` était déjà en queue sur VRP.

Non-régression connexe : 206 fichiers, 5 815 cas. `tsc` : 337, à la ligne
près.

## Étape 4 — l'aide ne se dérive plus du texte source (G1, M7, M8)

**La cause, mesurée plutôt que devinée.** Ma première hypothèse était que
plusieurs nœuds partageaient une même *référence* de fonction — fausse :
mesuré, zéro. La vraie cause est plus subtile et se lit dans le code
extrait : les vingt-deux commandes du mode `line` sont enregistrées **dans
une boucle sur `kw`**, si bien que chaque fermeture est un objet distinct
mais porte le **même corps** — un aiguillage qui cite forcément toutes les
commandes. Chaque nœud recevait donc la liste des vingt et une autres.

Deux règles, et chacune énonce une vérité sur ce que le nœud attend :

> **A.** Un corps de fonction partagé par plusieurs nœuds ne peut pas
> attribuer ses mots-clés : il ne sait pas lequel il sert.
>
> **B.** Un mot extrait du code n'a rien à faire là où un argument déclaré
> est attendu — et celui qu'on ne sait pas décrire n'est probablement pas
> un mot-clé.

**La mesure a réduit le chantier de deux ordres de grandeur.** Sur les
**107 nœuds** à corps partagé de la plateforme, seuls **quatre** rendaient
la liste du mode : `speed`, `stopbits`, `flowcontrol`, `databits`. Tous les
autres portent déjà un paramètre déclaré ou des suites curatées
(`ntp server`, `debug vrrp`, `show ip vrf`, `mdix`…) et rendaient déjà la
bonne chose. Un inventaire exhaustif de ce que la règle A retire a
confirmé qu'elle n'emporte **qu'un seul mot-clé légitime** dans toute la
plateforme : `source-interface`, sur les quatre écritures de
`ip domain lookup`. Il est déclaré, ce qui lui donne aussi une
description.

Les quatre commandes série reçoivent leurs vraies valeurs — `speed` de 300
à 115200, `databits` 5-8, `stopbits` 1-2, `parity` even/none/odd,
`flowcontrol` hardware/none/software.

**Une erreur en chemin, et elle valait la mesure.** Ma première écriture de
la règle B ne collectait plus que les paramètres dès qu'un argument était
attendu. Sept cas connexes sont tombés, dont celui qui dit la vérité :
`ping i` doit **toujours** proposer `ip` et `ipv6`. Un mot-clé et une
valeur peuvent se disputer la même place — `ping ?` offre `A.B.C.D` **et**
`ip` — donc seuls les mots **extraits** sont écartés, et exactement selon
le garde que le rendu de `?` applique déjà. Corriger « comme le fait
l'autre porte » plutôt que « comme il me semble » était toute la
différence.

**Ce que le repli devient.** Un glouton que personne n'a décrit rend
`WORD` : il annonce qu'un mot est attendu sans prétendre savoir lequel.
C'est vrai, là où la liste du mode était fausse.

**Discrimination.** `probe-aide-non-derivee-du-code.test.ts` (27 cas) :
**20 tombent** avant correctif. Les 7 témoins sont ceux qui protègent
contre la sur-correction — les groupes à corps partagé **déclarés** qui
doivent garder leur aide, le mode `line` qui doit rester entier au premier
rang, et les commandes de ce mode qui doivent continuer à s'exécuter.

Non-régression connexe : 207 fichiers, 5 858 cas. `tsc` : 337, à la ligne
près.

## Étape 5 — un `<cr>` annoncé se valide vraiment (M6)

**Le garde-fou avant les correctifs.** L'audit demandait un balayage
plutôt qu'une correction au cas par cas, et c'est l'ordre suivi :
`probe-aide-cr-tient-sa-promesse.test.ts` parcourt l'arbre d'aide de trois
modes et, pour **chaque** `<cr>` annoncé, valide la commande sur une
machine neuve. C'est lui qui a établi la liste — trente-deux fautes, dont
je n'en avais mesuré que trois à l'audit — et c'est lui qui nommera la
trente-troisième.

Une machine neuve par validation, parce qu'une commande validée modifie la
configuration : un balayage qui s'observe lui-même ne mesure plus rien.

**Un premier instrument s'est révélé aveugle, et c'est instructif.** J'ai
d'abord écrit le balayage sur `trie.match()` — statique, sans effet de
bord, séduisant. Il a trouvé **zéro** `<cr>` menteur. `match()` accepte
précisément là où l'exécution refuse : le gestionnaire glouton lève
`CliIncomplete` à l'exécution, ce que l'analyse de la ligne ne peut pas
savoir. Il fallait exécuter.

**La cause est déclarative.** `<cr>` s'affiche dès qu'un nœud porte une
action et que son arité minimale vaut zéro. `requiredArity` la déduit déjà
des paramètres déclarés non optionnels — mais ces nœuds-là n'en déclarent
aucun. Vingt-trois reçoivent leur arité (`requireArgs`), et trois cas
demandaient mieux :

* **`privilege`** et **`rate-limit`** absorbent leur mot suivant, donc
  c'est l'arité du glouton lui-même qu'il faut poser (3 et 2).
* **`class-map`** ne se distingue pas par le nombre d'arguments mais par
  leur contenu : `class-map NOM` se valide, `class-map match-all` attend
  encore son nom — un seul argument dans les deux cas. C'est exactement ce
  que `executableWhen` existe pour dire.

**Et un raccourci du moteur devait céder.** `class-map match-all` a résisté
au prédicat, parce que le rendu de `<cr>` court-circuite l'arité dès que le
premier argument est un mot-clé connu (`keywordForm`) — un raccourci utile
pour les formes gloutonnes dont l'arité ne se calcule pas. Mais un
`executableWhen` **déclaré** est un énoncé explicite sur ce qui complète la
commande, et il oppose désormais son veto au raccourci.

**Discrimination.** 16 cas : **11 tombent** avant correctif. Les 5 témoins
vérifient qu'un `<cr>` légitime reste — `show version`, `show clock`,
`show ip route`, `shutdown`, `no shutdown` — et chacun est validé, pas
seulement lu.

Non-régression connexe : 208 fichiers, 5 874 cas.

**Note sur `tsc`.** Le socle passe de 337 à 338 erreurs, et **l'erreur
ajoutée n'est pas la mienne** : `firewall-pipeline.test.ts` vient du commit
concurrent `5646bd63`, rebasé dans la branche. Mesuré en remisant mes
changements : 338 avant comme après, à la ligne près.

---

## Étape 6 — M5 : `?` ne propose plus un mot que l'analyseur refuse

`src/__tests__/unit/network-v2/probe-aide-tient-ses-promesses.test.ts`

**L'invariant n'est pas « la commande s'exécute » mais « le mot existe ».**
C'est la distinction qu'IOS fait lui-même, et elle sépare deux réponses
très différentes pour l'opérateur :

```
% Incomplete command.   →  le mot-clé est bon, il en manque d'autres.
                           L'aide avait raison de le proposer.
% Invalid input         →  ce mot-là n'existe pas ici. L'aide a menti.
```

Le balayage exécute donc chaque mot proposé, sur une **machine neuve à
chaque essai** — la commande essayée peut modifier la configuration, et un
balayage qui s'observe lui-même ne mesure plus rien. Il attrape deux
familles de fautes d'un coup : l'aide qui propose un mot inexistant, et
l'analyseur qui répond « inconnu » à un mot qu'il connaît mais trouve
incomplet. Les deux mentent, chacun à sa manière.

**Mesure de départ : 70 promesses non tenues.** Quatre corrections
structurelles les ramènent à 13.

**1 — Un type d'interface n'est pas un nom inconnu.** `interface ?`
proposait `GigabitEthernet`, et `interface GigabitEthernet` répondait
`% Invalid input` — c'est-à-dire « ce mot n'existe pas » à un mot que la
même machine venait de proposer. Il manque seulement le numéro, et IOS le
dit ainsi. Le commutateur avait la variante du même défaut, avec ses
propres mots : `% Invalid interface name "FastEthernet"`, qui nie le nom
au lieu de réclamer sa suite. `estTypeSansNumero` est le prédicat unique
des deux plateformes **et de l'aide** — trois listes de types finiraient
par diverger, et l'aide promettrait à nouveau ce que l'analyseur refuse.

**2 — Un type d'interface ne se propose qu'en première place.**
`interface GigabitEthernet0/0 GigabitEthernet` n'existe pas ; les types
sont désormais `leadingOnly`, sur le routeur comme sur le commutateur.

**3 — Une liste extraite est un aiguillage, pas une suite.** Les mots
qu'on extrait du corps d'un gestionnaire décrivent **une** lecture : le
gestionnaire lit un mot-clé et agit. Dès qu'un de ces mots est sur la
ligne, les autres sont ses **alternatives**, pas ses suites. Sans cette
règle, `show interfaces stats ?` reproposait `description`, `rate-limit`
et `summary`, que la machine refuse ensuite.

**4 — Un nœud qui déclare des paramètres n'accepte ses enfants qu'au
rang zéro.** C'est le correctif qui a demandé trois essais, et les deux
premiers étaient faux pour la même raison : je corrigeais la mauvaise
famille de suggestions.

`ip address 10.0.0.1 255.255.255.0 ?` proposait `dhcp`. J'ai d'abord
supposé un mot extrait, et j'ai posé la règle sur les continuations
automatiques. Résultat mesuré : `dhcp` **était toujours là** et
`access-list 10 ?` avait perdu `deny` et `permit`. La mesure a dit
pourquoi — `ip address dhcp` est un **nœud enfant** enregistré, donc
`dhcp` occupe le rang d'argument zéro ; tandis que `deny`/`permit`, eux,
étaient bien des mots extraits. J'avais interverti les deux.

La règle juste porte sur les enfants, et **elle ne joue que pour un nœud
à paramètres déclarés** — c'est ce qui la rend vraie plutôt que
seulement efficace :

```ts
const enfantsHorsDePortee = consumedArgs > 0 && node.params.length > 0;
```

`ip address` déclare l'adresse et le masque : une fois les deux saisis, la
machine est dans sa propre liste d'arguments et l'exécution refuse
`dhcp` — ce que l'aide annonçait pourtant. `show interfaces` n'en déclare
aucun, donc `show interfaces Gi0/0 accounting` reste atteignable après son
argument, comme sur une vraie machine ; et `ping 1.1.1.1 repeat 5 ?` garde
`size`/`source`/`timeout`, qui sont des suggestions déclarées et non des
enfants. Le même verrou est posé sur la tabulation, sans quoi les deux
portes répondraient différemment à la même question.

**`access-list 10 ?` proposait `eq`**, glané dans `srcPortSpec?.spec.op
=== 'eq'`. `eq` est un vrai mot-clé d'IOS — mais après un port, jamais à
la place de l'action. Le correctif n'est pas un filtre : l'action est
**déclarée** comme second paramètre énuméré, ce qu'elle est. L'aide rend
alors `deny`/`permit` et rien d'autre, exactement comme une vraie machine.

**Le reste : un cliquet, pas un silence.** Les 13 promesses restantes ne
partagent aucune cause — un mot-clé rendu par une commande que ce
simulateur n'implémente pas (`ip scp`, `no line`), un message d'analyseur
à corriger (`enable algorithm-type`), un mot-clé périmé (`show ip sla
monitor`), des frères qui s'excluent sans le déclarer (`show interfaces`,
qui ne déclare aucun paramètre et échappe donc à la règle 4). Elles sont
**nommées** dans `RESTE_CONNU`, et le balayage exige l'égalité exacte :
aucune nouvelle ne peut apparaître sans faire échouer ce fichier, et en
corriger une oblige à la retirer d'ici. La liste ne peut que décroître.

**Discrimination.** 12 cas : **7 tombent** avant correctif, dont les deux
balayages et les quatre cas nommés. Les témoins vérifient qu'un mot
légitime reste proposé — `interface ?` offre toujours les types, et
`interface FastEthernet9/9` garde bien « nom invalide », qu'il est.

**Trouvé au passage.** `registerSuggestions` n'acceptait pas `leadingOnly`
dans sa signature alors que le nœud le porte depuis longtemps et que
`addCompletionKeywords` l'accepte : le drapeau était honoré à l'exécution
et refusé par le typage.

Non-régression connexe : 208 fichiers, 5 874 cas. `tsc` : 342 avant, 342
après.

---

## Étape 7 — M4 : l'aide décrit la place où l'on est, pas la suivante

`src/__tests__/unit/network-v2/probe-aide-decrit-la-bonne-place.test.ts`

```
avant                              après
(config-if)# ip access-group ?     (config-if)# ip access-group ?
  in   Inbound direction             <1-199>      IP access list (standard or extended)
  out  Outbound direction            <1300-2699>  IP expanded access list (standard or extended)
                                     WORD         Access-list name
```

La syntaxe est `ip access-group {numéro | nom} {in | out}` : ce qui
s'affichait était l'aide de la place **suivante**. L'aide sautait un
argument obligatoire en silence, et celui qui la suivait tapait
`ip access-group in` — que la machine refuse.

**Le cas révèle une lacune du modèle, pas un oubli de déclaration.** À
cette place IOS accepte **trois formes**, et un `ParamSpec` n'en rendait
qu'une : `literal` est un rendu, au singulier. Ce n'est pas non plus un
`ENUM` — un `ENUM` liste des *valeurs admises*, alors qu'ici ce sont des
*types*, chacun avec sa propre description. D'où `alternatives`, qui les
nomme toutes :

```ts
alternatives: [
  { literal: '<1-199>',     description: 'IP access list (standard or extended)' },
  { literal: '<1300-2699>', description: 'IP expanded access list (standard or extended)' },
  { literal: 'WORD',        description: 'Access-list name' },
]
```

**La direction n'est pas filtrée, elle est déclarée à son rang.** `in` et
`out` sont désormais le **second** paramètre, et ils reviennent d'eux-mêmes
dès que la liste est nommée (`ip access-group 10 ?`). Déclarer le rang
plutôt que masquer le mot est ce qui rend la correction stable : rien
n'a à deviner à quelle position un mot-clé appartient.

**Trois voisins portaient la même faute**, trouvés en cherchant la forme
plutôt que le cas :

* **`ipv6 traffic-filter ?`** rendait `out` seul — et un `<cr>` qui
  annonçait une commande complète à laquelle il manquait **deux** mots.
  Il rend le nom de la liste ; les IPv6 ACL étant nommées, il n'y a
  qu'une forme et `alternatives` ne sert pas.
* **`access-class ?`** (mode `line`) rendait la direction elle aussi.
  Deux formes ici, pas trois : une ACL VTY ne prend pas la plage étendue.
* **`service-policy ?`** rendait bien `input`/`output` — la direction y
  est réellement première — mais annonçait `<cr>` avant le nom de la
  politique. Le nom est déclaré, le `<cr>` tombe de lui-même.

**La validation reste permissive et c'est délibéré.** `alternatives` est
une affaire de RENDU : le type déclaré reste `WORD`, donc l'analyseur
accepte comme avant et c'est le gestionnaire qui juge le numéro. Une
validation qui n'accepterait littéralement que `<1-199>` refuserait `10`.

**Discrimination.** 12 cas : **7 tombent** avant correctif. Les 3 témoins
vérifient qu'une place à forme unique ne bouge pas — `ip address ?` rend
toujours `A.B.C.D`, `ip policy ?` toujours `route-map`, `ip ospf cost ?`
toujours sa borne — et chaque commande complète est exécutée, pas
seulement lue.

Non-régression connexe : 209 fichiers, 5 886 cas. `tsc` : 343 avant, 343
après (le socle passe de 342 à 343 par un commit amont rebasé,
`CiscoShellBase.ts:2481`, mesuré en remisant mes changements).

---

## Étape 8 — M3, M11 et G4 : plus une seule aide morte, plus une seule promesse non tenue

`probe-aide-commandes-universelles.test.ts`, et le cliquet de M5 vidé.

**M11 était déjà fermé** par une étape antérieure : `vlan ?` rend
aujourd'hui `<1-4094>`, `access-map` et `filter` sur un Catalyst. Mesuré,
pas supposé.

### Première famille — les commandes que le répartiteur traite avant l'arbre

`exit`, `end`, `help`, `do` et `default` sont interceptées dans
`executeCommand` et n'ont **aucun nœud** ; or l'aide ne lit que l'arbre.
La liste du mode les offrait toutes les cinq et leur aide propre répondait
`% Invalid input`. Une seule cause pour cinq symptômes.

Ce que chacune rend est **lu sur ce qu'elle fait**, jamais choisi :

* `do X` s'exécute sur l'arbre **privilégié** — donc `do ?` rend cet
  arbre, et `do show ?` ses sous-commandes, à toute profondeur, le mot
  partiel compris (`do sh?` liste `show`). Un test vérifie que la liste
  rendue par `do show ?` est **identique** à celle de `show ?` en EXEC :
  c'est le même arbre, deux listes ne pourraient que diverger.
* `default X` s'exécute **comme `no X`** — c'est écrit dans le
  répartiteur — donc son aide est celle de `no`, à chaque rang.
* `exit`/`end`/`help` ne prennent aucun argument : `<cr>` et rien d'autre.

`do?` (sans blanc) reste une question sur le mot `do` lui-même : le
premier rang injecte désormais les commandes universelles **filtrées par
le préfixe**, là où il ne les injectait que pour une ligne vide.

### Seconde famille — offert par une liste, porté par personne

Le balayage de M5, relancé après le branchement de `do`, a vu d'un coup
tout l'EXEC depuis la configuration et a nommé quinze fautes de plus.
Aucune n'a été contournée.

**Écrites, parce qu'elles étaient annoncées et n'existaient pas** :
`write terminal` (synonyme historique de `show running-config`, et il rend
le **même** texte plutôt qu'une seconde version qui pourrait en diverger),
`debug dhcp` (vers la catégorie où le service publie déjà les changements
d'état du client DHCP — en créer une seconde ferait deux interrupteurs
pour un flux), `no debug domain` (sans lequel `undebug domain` ne pouvait
pas aboutir, le répartiteur réécrivant `undebug X` en `no debug X` : la
commande existait, sa négation non), et `no line <type> <n>` avec le
`remove` correspondant sur le magasin des blocs VTY — ce que fait cette
commande est lu sur ce que `line` écrit, et la console refuse d'être
supprimée, comme sur un vrai châssis.

**Un mot ABSENT n'est pas un mot faux.** Vingt-huit gestionnaires
refusent leur sous-commande par `throw new CliInvalidInput({ token:
args[0] })`, et `args[0]` vaut `undefined` quand rien n'a été tapé :
`debug aaa` répondait donc « ce mot n'existe pas » à une ligne où aucun
mot n'a été écrit, alors que son aide venait d'en proposer trois. La règle
est posée **une fois**, dans le diagnostic lui-même, plutôt qu'aux
vingt-huit appels — chacun énonce déjà la bonne chose, c'est la lecture
d'un jeton absent qui était fausse.

Et ce détail-là a coûté un tour : `motAbsent()` a d'abord répondu vrai
pour un `throw new CliInvalidInput()` **nu**, qui ne veut pas dire « il
manque un mot » mais « invalide, position inconnue ». Six cas de la
régression connexe l'ont dit tout de suite. Le prédicat exige désormais
que le jeton ait été **nommé** (`'token' in at`), ce qui distingue
exactement `{ token: undefined }` d'un appel sans argument.

**Trois places décrites un rang trop loin**, même faute que M4 :
`enable algorithm-type ?` rendait `level`/`secret` au lieu de
l'algorithme ; `ip scp server` et `ip rip authentication` refusaient au
caret ce qu'ils réclamaient en réalité. Déclarés.

**Un aiguillage pris ferme ses autres branches.** L'étape 6 posait cette
règle pour les mots extraits d'un gestionnaire ; elle vaut aussi pour les
**enfants** du même nœud, qui sont les mêmes alternatives déclarées
autrement — sans quoi la moitié de la famille disparaissait et l'autre
restait proposée (`show interfaces stats ?` offrait encore `accounting` et
`counters`). Elle ne joue que si l'un de ces mots est déjà sur la ligne,
donc `show interfaces Gi0/0 ?` garde les six : nommer une interface ne
choisit aucune vue.

**`clear mac` retiré de la liste du socle** : une table d'adresses MAC est
un organe de commutateur, et le commutateur enregistre `clear mac
address-table` pour de vrai — son `clear ?` offre donc `mac` comme un
enfant réel, pendant que le routeur cesse d'annoncer ce qu'il refuse.

**`show ip sla monitor` est enregistrée POUR ÊTRE REFUSÉE** — IOS 15 a
supprimé cette branche, et l'enregistrement existe uniquement pour que le
glouton `show ip sla` ne réponde pas à sa place. L'aide la proposait,
c'est-à-dire qu'elle enseignait une syntaxe supprimée. `neJamaisAnnoncer`
la retire de `?`, de la tabulation **et du décompte des chemins
exécutables** — elle ne rend qu'un refus, la compter ferait réclamer
qu'on l'annonce.

**Supprimé au passage** : un second `show interfaces accounting`
enregistré à part, qui rendait « No accounting protocols configured. »
là où `showInterfaceCmd` — qui traite déjà la forme nue — rend le vrai
tableau. Deux réponses à une question, la plus pauvre l'emportant.

### Le cliquet est vide

Les soixante-dix promesses non tenues du départ sont **toutes** corrigées,
sur les trois modes balayés. `RESTE_CONNU` ne contient plus rien, et
l'égalité exacte le maintient : une nouvelle faute fera échouer le fichier
en la nommant.

**Deux tests corrigés plutôt que le code**, chacun pour une raison écrite
sur place : `probe-aide-ordre-ios` mesurait l'ordre du `<cr>` sur
`terminal `, dont le `<cr>` était justement l'un des mensonges corrigés
ici (remplacé par `show ip route `, qui a plusieurs mots-clés **et** une
forme nue qui s'exécute) ; et `probe-cli-suggestions-never-repeat`
comptait `do` et `default` comme des mots de la commande, alors que ce
sont des **préfixes** — `default bgp default ipv4-unicast` est une vraie
ligne IOS.

**Quatre nœuds intermédiaires décrits** sur le Catalyst (`clear
errdisable`, `clear spanning-tree`, `show errdisable`, `show queuing`) :
ils n'étaient visibles que depuis l'EXEC d'un commutateur, que le
garde-fou des descriptions ne parcourait pas ; `do ?` les y expose
désormais. Rappel gagné une fois de plus : `describeNode` sort en silence
sur un nœud absent, donc l'appel doit **suivre** l'enregistrement qui crée
le nœud.

**Discrimination.** 43 cas sur les deux fichiers : **28 tombent** avant
correctif.

Non-régression connexe : 210 fichiers, 5 909 cas. `tsc` : 343 avant, 343
après.

---

## Étape 9 — M10 et M12 : les valeurs vivantes, et l'ordre

`src/__tests__/unit/network-v2/probe-completion-valeurs-vivantes.test.ts`

### M10 — le résolveur existait, deux portes sur trois ne l'interrogeaient pas

```
TAB «show ip interface G»  -> les quatre ports    (bon)
?   «show ip interface G»  -> % Invalid input      (mauvais)
TAB «show interfaces G»    -> rien du tout         (mauvais)
```

Le `DynamicParamResolver` **est** branché et **fonctionne** — c'est la
première chose que la mesure a corrigée dans le constat de l'audit, qui le
disait « presque pas branché ». Deux causes distinctes, chacune d'une
phrase, expliquaient tout ce qu'on croyait manquant.

**A — `?` sur un mot PARTIEL ne consultait pas le résolveur.** La branche
du mot partiel liste les enfants, les suites déclarées et les valeurs
énumérées ; les valeurs vivantes n'y figuraient pas. La même machine
complétait donc `G` par la tabulation et répondait « ce mot n'existe pas »
à `G?`. Un test vérifie désormais que les deux portes rendent **la même
liste**, ce qui est la seule formulation qui ne puisse pas dériver.

**B — le résolveur reconnaissait la place d'une interface au SINGULIER.**
`show interfaces` est au pluriel : la commande la plus tapée de toutes ne
recevait donc jamais rien, pendant que `show ip interface` — singulier —
fonctionnait sur la même machine. Une ligne dans la table des places.

Ce que le fichier **ne** demande pas, et le dit : que la tabulation
réponde à une ligne finie par un blanc. Une vraie machine n'y complète
rien — elle émet un bip — et `?` est la porte de cette question-là. C'est
la correction de ma propre erreur de lecture consignée en §8, et un cas de
non-régression la fixe pour qu'elle ne se reperde pas.

Corrigé aussi du constat : les ACL nommées **se complétaient déjà**. Ma
première mesure disait le contraire parce que le laboratoire créait
`ip access-list extended MAVIE` sans y mettre une seule règle — une liste
vide n'existe pas encore. Le laboratoire était en cause, pas la fonction ;
le cas reste dans le fichier, avec sa règle.

### M12 — l'ordre était celui de l'insertion dans l'arbre

```
TAB «show v» -> ["show vrf", "show vrrp", "show version", "show vlans"]
```

L'aide trie depuis l'étape 3 ; la tabulation, non. Les deux portes de la
même question rendaient deux ordres, dont l'un ne se lit pas. Le tri est
celui des **octets**, comme celui de l'aide et comme celui d'IOS, et il
est appliqué **deux fois** : dans le trie, et de nouveau après les ajouts
du shell — les commandes universelles et celles descendues par un niveau
de privilège arrivent en queue, et une liste triée à moitié ne se lit pas
mieux qu'une liste non triée.

**Discrimination.** 17 cas : **8 tombent** avant correctif. Les témoins
vérifient qu'un mot-clé réel l'emporte toujours sur une valeur
(`show ip interface b` rend `brief`), qu'un préfixe qui ne désigne aucun
port ne rend rien, et que ce que la tabulation propose **s'exécute**.

Non-régression connexe : 211 fichiers, 5 926 cas. `tsc` : 343 avant, 343
après.

---

## Étape 10 — G1 : l'aide n'est plus dérivée du code

`src/network/devices/shells/cisco/ciscoContinuations.ts`,
`probe-continuations-declarees.test.ts`

Les étapes précédentes ont corrigé **tout ce que l'extraction produisait
de faux** — la liste du mode fuyant sous chaque commande, les mots
indescriptibles, les promesses non tenues. Il restait ce que l'audit
demandait explicitement et que je n'avais pas fait : **retirer le
mécanisme**, plutôt que le filtrer à l'affichage. « Tant qu'elle existe,
`Tab` la verra. »

**La mesure d'abord, et elle a surpris dans le bon sens.** Ce que
l'extraction produisait au moment de la retirer était **juste** : 344
paires côté routeur, 213 côté commutateur, toutes de vrais mots-clés
d'IOS (`show ip bgp neighbors advertised-routes`, `debug aaa accounting`,
`clear mac address-table dynamic`…), aucune n'étant un identifiant du
code. Le défaut restant n'était donc pas ce qu'elle disait mais **d'où
elle le tenait** : une aide dérivée du code se défait dès qu'on réécrit le
code, en silence — ce dépôt l'a déjà payé, la réécriture de `no privilege`
ayant fait disparaître le mot `level` de son texte source, donc de son
aide.

Les paires ont été relevées, vérifiées contre la syntaxe d'IOS, et
écrites. `SOCLE` est ce que les deux plateformes portent ; `ROUTEUR_SEUL`
et `COMMUTATEUR_SEUL` ne sont appliquées qu'à la leur, pour qu'une
déclaration ne fabrique jamais un nœud sur une machine qui n'a pas la
commande. `HandlerKeywordExtractor` et son test sont supprimés, ainsi que
`setAutoExtractionEnabled` — un interrupteur dont le mécanisme n'existe
plus.

**Une erreur commise et corrigée par la mesure, et elle valait la
peine.** Mon premier relevé n'a parcouru que **cinq** arbres
(`user`, `privileged`, `config`, `configIf`, `configLine`). Le routeur en
porte **cinquante-deux** et le commutateur seize : quarante-sept modes se
sont donc retrouvés sans suites, ce que trois fichiers de la
non-régression ont dit tout de suite (`network 10.0.0.0 0.0.0.255 ?`
n'offrait plus `area`, et six modes rendaient un `WORD` portant la
description de leur parent). Les arbres sont désormais **relevés sur
l'objet** (`tousLesArbres()`) plutôt que nommés à la main — les nommer
était précisément l'erreur.

**Le filtre « pas de description, pas d'annonce » est retiré avec le
mécanisme qu'il compensait.** Il existait pour écarter les identifiants
que l'extraction ramassait ; une suite déclarée est un vrai mot-clé par
construction, et le filtre ne faisait plus que taire ce qu'on venait
d'écrire. À la place, un test exige que **chaque mot déclaré porte une
description** — ce qui a fait écrire les **71** qui n'en avaient pas, tous
de vrais mots-clés d'IOS (`switchport port-security violation
protect|restrict|shutdown`, `channel-group … on|passive|desirable`,
`ip verify unicast reverse-path`…). Ils étaient jusqu'ici proposés par la
tabulation et **tus par `?`** : ils sont désormais annoncés par les deux.

**Un test mis à jour plutôt que le code** : `probe-cli-suggestion-sources`
vérifiait qu'un mot *cité* par le corps d'un gestionnaire est proposé —
c'est-à-dire le mécanisme supprimé. Il vérifie maintenant l'inverse (un
mot seulement cité n'est pas proposé) et que le même mot **déclaré** l'est
par les deux portes. La source `auto` n'a pas disparu, elle a changé de
nature : elle lisait le code, elle lit la déclaration.

**Ce que cela change pour la suite** : un mot-clé ne s'ajoute plus en
écrivant du code, il s'ajoute en l'écrivant dans la table — et une
réécriture de gestionnaire ne peut plus défaire l'aide.

Non-régression connexe : 211 fichiers, 5 920 cas. `tsc` : 343 avant, 343
après.

---

# Clôture — les dix-neuf constats, et où ils en sont

Dix étapes, chacune livrée avec sa sonde discriminée par `git stash` et sa
non-régression connexe.

| # | Constat | État | Étape |
|---|---|---|---|
| C1 | `Tab` ignore la vue CLI | fermé | 1 |
| C2 | `?`/`Tab` divulguent des branches inatteignables | fermé | 2 |
| M1 | `<cr>` rendu en premier | fermé | 3 |
| M2 | Tri insensible à la casse | fermé | 3 |
| M3 | `do ?` / `default ?` morts | fermé | 8 |
| M4 | Position décrite un rang trop loin | fermé | 7 |
| M5 | L'aide promet ce que l'analyseur refuse | fermé | 6, 8 |
| M6 | `<cr>` mensonger | fermé | 5 |
| M7 | Un nœud glouton recopie la liste du MODE | fermé | 4 |
| M8 | `Tab` propose ce que `?` a écarté | fermé | 4 |
| M9 | Fuite de description d'une commande vers une autre | fermé | 4 |
| M10 | Aucune complétion dynamique | fermé | 9 |
| M11 | `vlan ?` mort sur un Catalyst | déjà fermé | — |
| M12 | Candidats de `Tab` non triés | fermé | 9 |
| G1 | L'aide dérivée du texte source | fermé | 4, 10 |
| G2 | Deux portes pour une décision | fermé | 1 |
| G3 | Descriptions absentes en production | fermé | 4, 10 |
| G4 | Aides mortes | fermé | 8 |
| G5 | Blancs de fin de ligne sur `<cr>` | fermé | 3 |

**Trois garde-fous restent en place et ne peuvent que se resserrer**, parce
qu'ils exigent l'égalité exacte plutôt qu'un plafond :

* **les promesses tenues** — tout mot que `?` propose est exécuté, et ne
  doit pas répondre « ce mot n'existe pas ». La liste des exceptions est
  **vide**.
* **les `<cr>` tenus** — tout `<cr>` annoncé est validé sur une machine
  neuve. Vide également.
* **les descriptions** — tout mot-clé offert, et tout mot déclaré comme
  suite, porte une description.

**Ce que la campagne a appris, au-delà des correctifs.** Trois fois, le
correctif évident était faux, et c'est la mesure qui l'a dit : la règle
sur `ip address … dhcp` visait la mauvaise famille de suggestions ; le
prédicat « mot absent » traitait un refus anonyme comme un manque ; le
relevé des continuations n'a d'abord parcouru que cinq arbres sur
cinquante-deux. Dans les trois cas, une sonde exécutant vraiment la
commande a tranché en une minute ce qu'une lecture du code aurait discuté
longtemps — et deux fois sur trois, la correction juste était l'inverse de
la première idée.

---

## Étape 10 — les trois garde-fous, portés à VRP

`src/__tests__/unit/network-v2/probe-aide-vrp-tient-ses-promesses.test.ts`

Les trois balayages que la campagne Cisco laisse derrière elle n'énoncent
rien de propre à IOS : un mot que `?` propose existe, un `<cr>` annoncé se
valide, un mot offert porte une description. Portés à VRP tels quels — les
deux refus s'y disent autrement (`Unrecognized command` / `Incomplete
command`), la distinction est la même — ils trouvent **104 fautes** :

| famille | mesuré |
|---|---|
| `<cr>` menteurs | 47 |
| descriptions manquantes | 55 |
| promesses non tenues | 2 |

**La cause des 47 est celle qu'on connaît déjà** : `HuaweiVRPShell`
portait **une seule** déclaration d'arité dans tout le fichier
(`user-interface`), donc l'arité minimale de `acl`, `dns domain`,
`local-user`, `route-policy`, `undo`… valait zéro et la machine annonçait
qu'on pouvait les valider nues. Elles sont déclarées d'après le balayage,
qui les a nommées. Deux commandes ne se distinguent pas par le NOMBRE
d'arguments mais par leur contenu — `acl 2000` se valide, `acl name`
attend encore le nom — et c'est `executableWhen` qui le dit, comme pour
`class-map` côté IOS.

**Les 2 promesses non tenues étaient de vraies commandes absentes**, pas
des mots inventés : `display logbuffer level <n>` refusait la forme
numérique alors que VRP numérote ses sévérités (`level 5` est la plus
tapée), et répondait « mot inconnu » à `display logbuffer level` là où il
manque seulement la valeur ; `multicast` niait un mot qu'aucun opérateur
n'avait tapé, au lieu de réclamer sa sous-commande. Corriger les deux
refus a **découvert deux `<cr>` de plus**, invisibles tant que la commande
répondait « inconnu » — le balayage ne peut voir un `<cr>` menteur que
derrière une commande qui existe.

**Le commutateur ne recevait pas `describeHuaweiArguments` du tout** —
même écart que celui refermé côté Catalyst. Le module ne crée aucun nœud :
il décrit des nœuds existants, donc un chemin que le commutateur n'a pas
est un no-op silencieux. N'appeler la déclaration que depuis le routeur
laissait les deux machines se contredire sur les mêmes commandes.

**Le point le plus intéressant est `stp`.** `stp converge ?` rendait
`WORD  Spanning Tree Protocol configuration` et un `<cr>` que la commande
refuse — alors que `HuaweiStpGrammar.ts` DIT depuis toujours que ce mot
attend `fast` ou `normal`. La grammaire et l'aide étaient deux énoncés
séparés sur la même syntaxe, donc capables de diverger. `declarerAideStp`
dérive l'aide de la table qui sert déjà l'analyse : une place, une source.
`stp` étant glouton, l'arité seule ne suffit pas — `stp enable` se valide
avec un argument, `stp converge` non — donc la table dit aussi **quels
mots se valident seuls**, et c'est le prédicat.

**Trois régressions provoquées et corrigées, dont deux dans les tests
plutôt que dans le produit** — parce que c'est là qu'était la faute :

1. Déclarer un argument **crée le nœud**, et un nœud sans description
   propre se rabat sur la table générale des mots-clés : `stp ?` s'est mis
   à rendre `mode  Set trunking mode of the interface`, la description
   d'une AUTRE commande. Les descriptions curatées — la même liste que
   l'ENUM déjà rendu — sont passées à `declarerAideStp`, si bien que les
   deux ne peuvent pas diverger. Piège dans le piège : `describeNode` sort
   en **silence** sur un nœud absent, donc l'appel doit SUIVRE la
   déclaration qui le crée, jamais la précéder.
2. `probe-cli-suggestions-never-repeat` a signalé que `stp mode ?` offre
   `stp`, déjà tapé. C'est **une valeur, pas un mot-clé** : `stp mode stp`
   sélectionne 802.1D, et une vraie machine l'offre. L'invariant parle des
   mots-clés qui se suivent ; l'homonymie est relevée nommément, à
   égalité exacte, dans les deux moitiés du balayage (`?` et `Tab`).
3. `huawei-vty-help-consistency` vérifiait qu'une vue utilisateur ne
   contient pas la **sous-chaîne** `interface` — et `free`, décrit pour la
   première fois, est « Release a user terminal **interface** ». Le
   contrôle porte désormais sur la colonne des mots-clés, pas sur la
   phrase : la même leçon que l'alignement des tableaux, découper aux
   bornes plutôt qu'aux blancs.

**Discrimination.** 15 cas : **12 tombent** avant correctif. Les 3 témoins
sont les balayages du commutateur qui passaient déjà et le cas de refus
d'un mot réellement inexistant.

**Le cliquet a servi avant même d'être poussé.** Le rebasage a apporté le
travail d'une session concurrente — `mac-address blackhole|static`,
`clock timezone`, `time-range`, `port-group`, `display dhcp`,
`display traffic` — et les balayages ont immédiatement nommé sept fautes
neuves des mêmes familles : cinq `<cr>` sans arité, deux descriptions
manquantes, et un sélecteur qui rouvrait ses alternatives
(`mac-address blackhole ?` offrait `aging-time`). Toutes corrigées dans le
même geste. C'est exactement ce à quoi sert une liste à égalité exacte :
elle ne dit pas seulement où l'on en était, elle refuse ce qui arrive
après.

Sur ce dernier point, la correction a d'abord été tentée par
`leadingOnly` et **n'a rien changé** ; la déclaration juste est un
paramètre **ENUM** — une place, trois valeurs — qui dit ce qu'une liste de
suggestions ne peut pas dire : que les trois se disputent le même rang.

Non-régression : 323 fichiers, 7 128 cas. Deux échecs subsistent
(`another_rip`, `scenario-vlan-8021q-trunk`) et **ne sont pas les miens** :
ils tombent à l'identique une fois mes changements remisés, donc ils
viennent des commits amont rebasés. `tsc` : 233 avant, 233 après.

**Reste connu, et vide.** Les six listes du cliquet VRP sont toutes à zéro
— aucune faute nommée, donc aucune ne peut apparaître sans faire échouer
ce fichier.

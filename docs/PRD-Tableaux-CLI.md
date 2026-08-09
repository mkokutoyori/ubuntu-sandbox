# PRD — Le rendu des tableaux dans les CLI simulées

## 1. Le constat

Les sorties tabulaires des équipements simulés étaient mal alignées à
plusieurs endroits. Le signalement était visuel ; la cause est
structurelle, et la même partout : **l'en-tête d'un tableau était une
chaîne littérale, ses lignes de données une autre chaîne**, chacune
avec ses propres `padStart`/`padEnd` comptés à la main. Rien ne reliait
les deux, donc rien n'empêchait l'écart.

Mesure faite avant d'écrire une ligne de code, sur un routeur et un
commutateur de chaque constructeur, en relevant les bords de colonnes :

| commande | défaut mesuré |
|---|---|
| `show interfaces … accounting` | données un caractère **à gauche** de l'en-tête (22/34/46/58/70 contre 24/35/47/59/71) |
| `show interfaces … stats` | deux lignes sur quatre décalées par rapport aux deux autres |
| `show interfaces counters` (commutateur) | toutes les colonnes un cran **à droite** |
| `show interfaces status` (commutateur) | dernière colonne un cran à droite, en-tête plus large de deux que celui d'un vrai Catalyst |
| `show interfaces summary` | les neuf compteurs un cran à gauche, **plus deux blancs de fin** par ligne |
| `display interface brief` (VRP) | colonne `PHY` large de 8 au lieu de 6, donc **tout le reste décalé de deux** |

Le décalage n'était jamais du même côté ni de la même ampleur, ce qui
est la signature d'un défaut par recopie : chaque tableau avait été
compté séparément, et chacun s'était trompé à sa façon.

## 2. Ce qui a été construit

`src/network/devices/shells/cli/TextTable.ts` — un module où **une
colonne porte son intitulé, sa largeur et son alignement**, et où
l'en-tête comme les données sortent du même calcul. Le décalage
redevient impossible plutôt que rattrapé au coup par coup.

```ts
renderTable(rows, [
  { header: 'Port',     width: 16, value: (r) => r.port },
  { header: 'InOctets', width:  8, align: 'right', value: (r) => r.octets },
], FIXED_TABLE);
```

Styles fournis : `IOS_TABLE`, `IOS_RULED_TABLE`, `VRP_TABLE`,
`VRP_RULED_TABLE` — les conventions d'écart et de filet propres à
chaque constructeur — et `FIXED_TABLE`, pour les tableaux dont la
référence fixe des largeurs **pleines**, blancs de séparation compris.
`renderCounterTable` couvre la forme « étiquette à droite puis
compteurs » qu'IOS emploie pour `… accounting` et `… stats`.

## 3. Les décisions, et pourquoi

**Les largeurs sont celles des vraies machines, pas des largeurs
« jolies ».** Une largeur de colonne d'IOS est un nombre figé depuis
vingt ans, que les scripts d'exploitation découpent par position ; la
largeur automatique (`max(intitulé, contenu)`) n'existe que pour les
tableaux dont aucune sortie réelle ne fixe la mise en page.

**Une valeur trop longue n'est jamais tronquée.** Elle pousse la suite
de la ligne, comme sur une vraie machine. Perdre un caractère de donnée
pour sauver un alignement serait le mauvais échange.

**Pas de bordures.** Ni IOS ni VRP n'en ont. Le seul ornement des deux
est un filet de tirets sous l'en-tête, que certaines familles de
commandes portent et d'autres pas — d'où un style par famille et non
par constructeur.

**`FIXED_TABLE` n'est pas étiqueté par constructeur**, à la différence
des autres : « la largeur porte son propre blanc » est une façon de
mesurer, pas une convention d'IOS ou de VRP, et les deux plateformes
ont des tableaux de cette forme. Il est indispensable dès que deux
colonnes voisines ne sont pas séparées du même nombre d'espaces —
`display interface brief` met un blanc entre `InUti` et `OutUti`, trois
entre `OutUti` et `inErrors`.

## 4. Ce que la mesure a appris, et qui ne s'invente pas

**`Duplex` et `Speed` de `show interfaces status` sont alignées à
DROITE.** `auto`, `a-full` et `a-half` finissent tous les trois à la
colonne 58 ; `auto`, `a-100` et `a-1000` tous les trois à la 65 — alors
que les quatre premières colonnes sont à gauche. Les **deux**
implémentations qu'avait ce dépôt les mettaient à gauche, et l'en-tête
seul ne pouvait pas le trahir : `Duplex` fait exactement six
caractères, donc le rendu à gauche et le rendu à droite donnent le même
en-tête et ne divergent que sur les données.

Les références employées sont du **texte capturé sur de vraies
machines** — les jeux `cisco_ios/show_interfaces_status` et
`huawei_vrp/display_interface_brief` de `ntc-templates` — et non des
exemples de documentation : le HTML d'une page de doc écrase les
blancs, c'est-à-dire précisément l'information qu'on cherche ici. Les
premières recherches ne rendaient que des exemples aplatis, dont on ne
pouvait tirer aucune largeur.

## 5. Un second rendu supprimé

`CiscoShowCommands.ts` portait un `showInterfacesStatus(router)`
complet **que rien n'appelait**. La commande n'existe pas sur un
routeur IOS, qui répond `% Invalid input detected at '^' marker.` — ce
que le simulateur fait déjà. Deux mises en page pour une commande
qu'une des deux plateformes n'a pas : le rendu mort est supprimé
plutôt que conservé, une seconde réponse possible à une question étant
exactement le défaut que ce module referme. La mise en page réelle vit
désormais dans `cisco/ciscoTableLayouts.ts`, table de référence citant
la sortie d'où chaque layout a été mesuré.

## 6. Vérification

`src/__tests__/unit/network-v2/probe-alignement-tableaux-cli.test.ts`
(22 cas) tient trois choses distinctes :

1. **La mécanique** — alignements, largeur imposée, largeur
   automatique, non-troncature, filet, retrait, absence de blanc de
   fin.
2. **La conformité aux sorties réelles** — les colonnes déclarées
   rejouent le texte de référence au caractère près, pour les deux
   constructeurs.
3. **Les commandes elles-mêmes** — chaque cellule est calée sur le même
   bord de sa colonne que l'intitulé qui la surmonte.

La vérification découpe chaque ligne **aux bornes de colonnes** plutôt
que de la séparer aux blancs, et ce n'est pas un détail : deux
formulations plus courtes ont échoué avant celle-ci, parce qu'une
cellule peut contenir un blanc (`Switching path`, `2960S Port`) et une
cellule peut être vide (une interface sans description) — compter les
mots répond alors à une autre question que celle posée. Quand un
tableau mélange les deux alignements, le blanc qui sépare deux colonnes
n'appartient d'ailleurs ni à l'une ni à l'autre : l'attribuer à la
précédente fait apparaître un blanc de fin dans une colonne alignée à
droite, à la suivante un blanc de tête dans une colonne alignée à
gauche. Les bornes sont donc nommées en clair.

**Discrimination** : les trois fichiers modifiés remis dans leur état
antérieur, **6 des 22 cas échouent** — exactement les six sorties
d'équipement. Les 16 autres passent des deux côtés, ce qui est correct :
ils portent sur le module lui-même et sur les références, qui ne
dépendent pas du code corrigé.

**Non-régression** : 75 fichiers de test touchant ces sorties,
2 982 cas, verts.

## 7. Reste ouvert

Le balayage a couvert une quarantaine de commandes tabulaires sur les
quatre plateformes ; les tableaux non cités ici s'y sont montrés
alignés. Les autres rendus dessinés à la main n'ont pas été migrés :
ils ne présentent pas de défaut mesuré aujourd'hui, et les migrer sans
défaut à corriger reviendrait à réécrire du code correct — le module
est là pour eux le jour où l'un d'eux bouge.

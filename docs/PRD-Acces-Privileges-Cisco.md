# PRD — Accès, identité et privilèges sur Cisco

Rejouer le tutoriel « Gestion des Accès, Identité et Privilèges sur
Cisco » comme laboratoire. Mesure d'abord : une sonde qui rejoue chaque
commande des quatorze parties et vide la sortie dans un fichier, puis
classement, puis correction.

## 1. Ce que la mesure a trouvé

Le fil commun des cinq défauts corrigés est le même, et c'est celui que
ce dépôt referme partout : **une commande acceptée dont personne ne lit
le résultat**, ou **deux magasins pour un fait**.

| § | commande | défaut mesuré |
|---|---|---|
| 12 | `ip ssh time-out 45` | gardée, rendue par `show running-config`, **niée par `show ip ssh`** (120) |
| 12 | `ip ssh server algorithm …` | acceptée, **rangée nulle part** |
| 3 | `username X algorithm-type scrypt secret …` | mot-clé **jeté**, secret rangé en MD5 |
| 8 | `show aaa` | rend le texte de `show aaa sessions` |
| 6 | `login-timeout` | **refusée** |

Ce qui s'est révélé **correct** à la mesure, et n'a donc pas été touché :
`enable secret` produit bien un type 5 (le défaut d'IOS 15, contrairement
à ce qu'on pourrait croire), `enable algorithm-type scrypt secret`
produit un type 9, `security passwords min-length` refuse avec le
message d'IOS, `service password-encryption` convertit en type 7,
`privilege exec level N`, `login block-for`, `login quiet-mode
access-class`, `access-class … in`, les trois bannières, les serveurs
TACACS+/RADIUS nommés et les groupes AAA se configurent et se relisent.

## 2. Deux configurations SSH sur une machine

C'est le défaut de tête, et il était structurel.

`show ip ssh` **ne prenait aucun argument** et rendait deux lignes
constantes. En parallèle, la configuration `ip ssh` vivait dans **deux**
magasins :

- `CiscoSecurityConfig.ssh` — écrit par le handler `ip ssh` du routeur,
  rendu par `asRunningConfigLines()`. Défauts : version 1, délai 120 s.
- `RouterManagementService.sshServer` — écrit par un **second** handler,
  dans `CiscoShellBase`, que le trie du routeur **ombre** et qui ne
  tournait donc jamais. Rendu, lui aussi, vers le running-config par
  `CiscoShowCommands`. Défauts : version 2, délai 60 s.

Deux magasins, deux jeux de défauts contradictoires, **deux rendus vers
le même fichier** — capables d'émettre `ip ssh time-out` deux fois dans
une configuration qu'IOS ne produirait jamais et qu'un import rejouerait
deux fois.

Il n'en reste qu'un : celui que la CLI écrit. Le magasin du gestionnaire
garde ce qu'il porte **seul** (état d'écoute, port), le handler mort est
supprimé, le second rendu aussi, et `show ip ssh` lit la configuration.

Trois faits d'IOS s'ajoutent au passage, et le premier n'est pas
cosmétique : **`version 1` est le défaut et signifie « les deux versions
acceptées », ce qu'IOS écrit `1.99`** — c'est ainsi qu'un opérateur voit
d'un coup d'œil que `ip ssh version 2` n'a pas été posé. Puis la taille
de clé DH minimale (lue, pas constante) et la taille de la clé hôte,
écrite **seulement s'il y a une clé** : annoncer une clé sur un routeur
sans `crypto key generate rsa` serait la même faute à l'envers.

## 3. Les listes d'algorithmes

`ip ssh server algorithm {mac|encryption|kex} <liste>` était acceptée et
rangée nulle part.

Ce simulateur **ne négocie pas** ces algorithmes — sa pile choisit les
siens — et on aurait pu s'arrêter à un refus honnête. Ce n'est pas le
bon échange : une commande de durcissement qui disparaît de la
configuration disparaît aussi du **rechargement d'une topologie**, et
rien ne le dit. Elles sont donc stockées, rendues telles qu'écrites, et
affichées par `show ip ssh` **uniquement si l'opérateur a restreint la
liste** — une liste vide veut dire « les algorithmes par défaut », et la
remplir d'une liste inventée décrirait une négociation qui n'a pas lieu.
Une famille inconnue est refusée plutôt que rangée.

## 4. `username … algorithm-type`

Le mot-clé était accepté et **jeté** : un secret demandé en scrypt
partait en MD5. La commande produisait exactement l'inverse de ce qu'elle
promet, en silence — alors que son homologue `enable algorithm-type`
fonctionne depuis toujours. Même famille, deux comportements.

Un **chiffre explicite** (`secret 5|8|9 $…`) décrit un condensé déjà
calculé et l'emporte sur l'algorithme demandé, qui ne porte que sur du
clair à hacher. Un algorithme inconnu est refusé.

Corrigé dans les **deux** handlers `username` — celui de
`CiscoSecurityCommands` (qui tourne sur le routeur) et celui de
`CiscoShellBase` (que le trie du routeur ombre, mais qui sert d'autres
plateformes) — pour qu'ils ne puissent pas se contredire.

## 5. `show aaa` répond à sa propre question

`show aaa`, `show aaa sessions` et `show aaa user all` rendaient un seul
et même texte : deux des trois ne répondaient pas à la question posée.

`show aaa` décrit désormais l'**état du sous-système**, et chaque ligne
est **lue** sur les méthodes déclarées : une machine où seule
l'authentification est configurée n'annonce pas une autorisation active.
Sans `aaa new-model`, la réponse est `AAA is disabled.`

## 6. `login-timeout`

Le délai laissé pour **saisir** ses identifiants, distinct d'
`exec-timeout` qui compte l'inactivité **après** la connexion. La
commande d'IOS était refusée ; elle est stockée sur le bloc de ligne et
rendue. `VtyLineConfig.withFields` la reporte — un champ oublié là s'y
perd en silence au patch suivant.

## 7. Trouvé et corrigé en passant

Un défaut **pré-existant**, attrapé par le garde-fou
`cisco-help-every-keyword-described` : le nœud intermédiaire
`ipv6 nd ra` n'avait pas de description alors que ses enfants en ont, si
bien que `?` le proposait nu.

## 8. §11 — les CLI Views, livrées

Le sous-système était entièrement absent : `parser view`,
`commands exec include`, `enable view`, `show parser view`,
`username X view Y` répondaient tous `% Invalid input detected`. Ce
n'était pas une commande manquante mais un second mécanisme
d'autorisation à côté des niveaux de privilège, et l'accepter sans
filtrer aurait été exactement le défaut que ce travail referme.

**Ce qui distingue une vue d'un niveau de privilège EST le mécanisme,
et c'est la seule chose qu'il ne fallait pas rater.** Un niveau AJOUTE
des commandes au socle du niveau 1 ; une vue REMPLACE l'arbre visible
par ce qu'elle inclut, et rien d'autre. C'est ce qui la rend utilisable
pour décrire un rôle : on énonce ce que le rôle a le droit de faire, au
lieu de l'ajouter par-dessus un socle qu'on n'a pas choisi. La
conséquence observable est qu'une commande hors de la vue n'est pas
« refusée » mais **absente** — IOS répond `% Invalid input detected`,
le même texte que pour une commande qui n'existe pas.

La porte est branchée là où le filtrage par niveau l'était déjà, dans
`executeOnTrie`, et **hors d'une vue elle rend `true` sans rien
consulter** : le cas courant — aucune vue, c'est-à-dire tout le reste du
dépôt — ne traverse aucune logique nouvelle, ce que deux cas de
non-régression vérifient.

Quatre décisions valent d'être écrites, chacune parce que l'inverse
était possible :

- **`parser view` exige `aaa new-model`**, comme IOS. Une vue vit dans
  AAA ; l'accepter sans lui donnerait un mécanisme d'autorisation sans
  le sous-système qui l'autorise.
- **Une commande inconnue est refusée à l'inclusion** (`%Command not
  found`), validée contre le trie privilégié. Sans ce contrôle, une
  faute de frappe produirait une vue silencieusement vide — le rôle
  existerait, ne donnerait droit à rien, et rien ne le dirait.
- **On ne déclare pas une vue depuis une vue.** Sans cette garde, une
  vue restreinte pourrait s'octroyer des commandes et le mécanisme se
  viderait de son sens.
- **On sort toujours d'une vue** : `exit`, `end`, `logout`, `disable`,
  `enable` et `show parser view` sont hors du filtre. Une vue dont on
  ne peut pas sortir n'est plus un rôle, c'est une souricière ; et
  `show parser view` doit répondre depuis l'intérieur, sans quoi on ne
  saurait pas où l'on est.

`username X view NOM` est rendue sur une **ligne séparée**, comme IOS :
c'est une commande à part, et la fondre dans la précédente donnerait une
ligne qu'un import ne saurait pas rejouer. La vue référencée doit
exister (`%Error: View NOM is not present in the system`).

`NetworkOsAccount.view` est porté par le modèle immuable et traverse
`snapshot()`/`mutate()` comme les autres champs — un champ oublié là se
perdrait en silence au patch suivant, ce que `create()` a d'ailleurs
manqué au premier jet et que le typage a rattrapé.

## 9. Ce qui reste, et pourquoi

Deux parties du tutoriel ne se rejouent pas, et c'est dit ici plutôt
que découvert :

**Les deux points ci-dessous sont FERMÉS** — voir
`docs/PRD-Serveur-HTTP-Cisco.md`. Ce qui était écrit ici est conservé
sous sa forme d'origine, avec sa correction, parce que la mesure a montré
que les deux affirmations étaient fausses et que c'est la mesure qui
tranche, pas la note de la fois d'avant.

**§9 — `test aaa group … new-code`.** ~~Absent. La commande suppose un
serveur TACACS+ qui réponde, et ce simulateur stocke la déclaration du
serveur sans en implémenter le protocole (TCP/49, chiffrement du paquet
entier).~~ **Faux sur les deux moitiés.** Le protocole TACACS+ est réel
(vraie connexion TCP/49, corps chiffré, délai de garde), et la commande
n'était pas absente : elle existait dans `CiscoTerminalSession`, donc
dans le terminal graphique et nulle part ailleurs, tandis que
`AaaAuthenticator.testGroupAuthentication()` était écrite pour elle. Ce
qui manquait était une des deux portes.

**§13 — `ip http server`.** ~~Acceptée et rendue nulle part, dans les
deux sens. Sur un IOS 15 réel le serveur HTTP est actif par défaut, donc
`no ip http server` devrait apparaître dans la configuration.~~ Le
constat était exact, sa cause plus large (toute la table
`CiscoConfigState` a un rendu mort) et **le défaut était l'inverse** : la
documentation Cisco de la série 15 écrit que le serveur est ARRÊTÉ par
défaut, ce que la table du dépôt disait déjà. C'est donc `ip http server`
qui doit paraître, et le serveur écoute désormais vraiment.

## 10. Vérification

`tuto-acces-privileges-cisco.test.ts` (28 cas), discriminé par remise en
état des fichiers produit : **9 échouent** authentiquement. Les 19 qui
passent des deux côtés portent sur ce qui était déjà correct — c'est ce
qu'on attend d'eux, et c'est ce qui distingue une correction d'une
réécriture.

`tuto-cli-views-cisco.test.ts` (18 cas), discriminé de la même façon sur
les dix fichiers touchés : **14 échouent** avant correctif. Les 4 qui
passent des deux côtés sont nommés dans l'en-tête du fichier plutôt que
laissés à découvrir — deux sont les cas de non-régression, dont c'est
l'objet même ; les deux autres passaient avant pour une raison qui ne
prouve rien du mécanisme (« un mode autre qu'exec est refusé » passait
parce que `parser view` l'était déjà ; « ce qu'elle inclut fonctionne »
parce qu'`enable view` ne faisait rien et qu'on restait à la racine, où
tout fonctionne).

Non-régression : 90 fichiers touchant ces sorties, 1 825 cas, verts pour
la première tranche ; 14 fichiers CLI/AAA/privilèges, 624 cas, verts
pour les vues. Lint identique au relevé d'avant sur les douze fichiers
touchés (75 problèmes, aucun ajouté).

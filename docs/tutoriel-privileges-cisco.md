# Les privilèges Cisco pour les débutants : du niveau 15 au rôle sur mesure

## Introduction

Il y a une commande que tout le monde tape le premier jour où il touche un
routeur Cisco, et c'est `enable`. On la tape, le prompt passe de `>` à `#`,
et on a tous les droits. C'est pratique, c'est immédiat, et c'est exactement
le problème. 😅

Parce que le jour où vous n'êtes plus seul sur l'équipement — le jour où il y
a un stagiaire, un prestataire, un technicien de nuit, un outil de supervision
qui a besoin de lire trois compteurs — la question « il a `enable` ou il ne
l'a pas ? » n'a plus aucune bonne réponse. Soit il peut tout casser, soit il
ne peut rien faire. Et croyez-moi, dans la vraie vie, on finit toujours par
choisir « il peut tout casser », parce qu'il faut bien que le travail se
fasse.

Cisco a prévu deux mécanismes pour sortir de cette impasse : les **niveaux de
privilège** et les **vues CLI**. Les deux sont dans IOS depuis très longtemps,
les deux sont gratuits, et les deux sont massivement sous-utilisés — je pense,
honnêtement, parce que la documentation les présente comme des listes de
commandes plutôt que comme des mécanismes qu'on peut *sentir* en les
manipulant.

Alors on va faire l'inverse. On va monter un laboratoire, et à chaque
paragraphe on va taper quelque chose et regarder ce qui change. Toutes les
sorties que vous allez lire dans cet article sont de vraies sorties : je les
ai capturées en jouant le laboratoire, je ne les ai pas retapées de mémoire.
C'est important, parce qu'au moins deux des comportements qu'on va voir sont
franchement contre-intuitifs, et sur ceux-là la mémoire est un mauvais témoin.

Vous pouvez suivre sur un vrai routeur, sur Packet Tracer, sur GNS3, ou dans
le simulateur qui accompagne ce dépôt. Les commandes sont les mêmes.

---

## Ce qu'IOS appelle un privilège

Avant de taper quoi que ce soit, deux minutes de théorie. Promis, deux
minutes. ⏱️

IOS numérote les privilèges de **0 à 15**. Seuls trois de ces seize niveaux
ont un sens prédéfini :

- **Le niveau 0** contient exactement cinq commandes : `disable`, `enable`,
  `exit`, `help` et `logout`. C'est le strict minimum pour ouvrir une session,
  ne rien faire, et repartir.
- **Le niveau 1** est le mode utilisateur, celui du prompt `>`. C'est là que
  vous arrivez quand vous vous connectez sans rien demander de plus. Vous y
  avez `ping`, `traceroute`, une bonne partie des `show`, et rien qui modifie
  l'équipement.
- **Le niveau 15** est le mode privilégié, celui du prompt `#`. Tout le reste
  y est : `configure terminal`, `reload`, `show running-config`, `debug`…

Et entre les deux, **les niveaux 2 à 14 sont vides**. Complètement vides. Ils
n'existent que parce que vous allez les remplir. C'est ça, l'idée : vous
prenez une commande qui vit au niveau 15, vous la faites **descendre** au
niveau 7, et voilà — vous venez de créer un rôle « technicien niveau 7 » qui
peut faire cette commande-là et rien d'autre au-dessus du niveau 1.

Retenez cette phrase, on va y revenir souvent : **un niveau AJOUTE au socle du
niveau 1**. Ce n'est pas un remplacement. Quelqu'un au niveau 7 a tout ce
qu'un niveau 1 a, *plus* ce que vous lui avez descendu. Ça paraît anodin ; on
va voir dans dix minutes que c'est la source du piège le plus coûteux du
sujet.

---

## Le laboratoire

On part d'un routeur neuf. Un seul, on n'a besoin de rien d'autre — les
privilèges sont une affaire locale à l'équipement, aucun câble n'est
nécessaire.

```
Router> enable
Router# configure terminal
Enter configuration commands, one per line.  End with CNTL/Z.
Router(config)# hostname R1
R1(config)# end
R1#
```

Voilà, le laboratoire est monté. 🎉 Non, sérieusement, c'est tout. Vous pouvez
garder cette session ouverte, on va tout faire dedans.

---

## Premier contact : où suis-je ?

La commande la plus utile de tout l'article, et celle que personne ne connaît :

```
R1# show privilege
Current privilege level is 15
```

Elle répond à une question qu'on croit toujours connaître et qu'on se trompe
régulièrement : **à quel niveau suis-je en train de travailler ?** Prenez
l'habitude de la taper dès que quelque chose vous surprend. Neuf fois sur dix,
la surprise vient de là.

Redescendons voir :

```
R1# disable
R1> show privilege
Current privilege level is 1
R1> show running-config
% Invalid input detected at '^' marker.
```

Notez bien le refus. IOS ne dit pas « accès refusé », il ne dit pas « vous
n'avez pas le droit ». Il dit **`% Invalid input detected`**, exactement comme
si vous aviez tapé une commande qui n'existe pas. C'est délibéré : une
commande hors de votre niveau n'est pas *interdite*, elle est **absente**.
Elle n'apparaît même pas dans l'aide contextuelle. De votre point de vue, ce
routeur n'a pas de commande `show running-config`.

Cette nuance n'est pas cosmétique. Un attaquant qui reçoit « accès refusé »
apprend qu'il y a quelque chose à cet endroit. Un attaquant qui reçoit
« commande inconnue » n'apprend rien du tout.

---

## Une porte par niveau

Un niveau sans mot de passe ne sert à rien : n'importe qui taperait `enable 7`
et y entrerait. On pose donc une porte par niveau qu'on compte utiliser.

```
R1> enable
R1# configure terminal
R1(config)# enable secret Coffre15!
R1(config)# enable secret level 5 Tech5!
R1(config)# enable secret level 10 Admin10!
R1(config)# end
```

Trois portes : une pour le niveau 15 (la forme sans `level`), une pour le 5,
une pour le 10. Regardons comment elles sont stockées :

```
R1# show running-config | include enable secret
enable secret 5 $1$9b73172a$mTn6fWVQr.2AvTIGpEdsJ.
enable secret level 5 5 $1$bf782ee4$x1VWsPnu2jZsF5GHTc/3g.
enable secret level 10 5 $1$233fa43a$0vHJoYDhlKexYUTOCuOUQ/
```

Le `5` qui suit `level 5` n'est pas un doublon d'affichage : le premier est le
niveau, le second est le **type de chiffrement** du condensé (type 5 = MD5).
Oui, c'est déroutant la première fois. 😵 Sur `enable secret level 10`, on lit
donc « niveau 10, condensé de type 5 ».

Un mot au passage, parce qu'il faut le dire une fois : utilisez **toujours**
`enable secret`, jamais `enable password`. Le second stocke le mot de passe
en clair (ou avec le chiffrement réversible de type 7, qui se casse en ligne
en deux secondes). `secret` stocke un condensé. Ce n'est pas une préférence,
c'est la différence entre un mot de passe et un post-it.

Essayons la porte :

```
R1# disable
R1> show privilege
Current privilege level is 1
R1> enable 5
Password: Tech5!
R1# show privilege
Current privilege level is 5
```

Deux choses à remarquer. D'abord `enable 5` — le nombre, c'est le niveau
demandé ; `enable` tout court veut dire `enable 15`. Ensuite le prompt :
**il affiche `#` dès le niveau 2**, pas seulement au niveau 15. Donc le dièse
ne veut pas dire « j'ai tous les droits », il veut dire « je ne suis plus au
niveau 1 ». C'est encore une raison de taper `show privilege` plutôt que de
faire confiance au prompt.

Et si on se trompe :

```
R1> enable 5
Password: mauvais
% Access denied
% Access denied
% Bad secrets
```

Trois tentatives, puis IOS abandonne. Comportement normal.

---

## Déléguer sa première commande — et tomber dans le piège

Nous y voilà. C'est ici que le sujet devient intéressant, et c'est ici que
tout le monde se plante, moi le premier. 🙈

Objectif : le niveau 5 doit pouvoir consulter la table de routage. Une seule
commande à descendre :

```
R1# configure terminal
R1(config)# privilege exec level 5 show ip route
R1(config)# end
```

La syntaxe se lit de gauche à droite : `privilege` **`exec`** (dans quel mode)
**`level 5`** (à quel niveau) **`show ip route`** (quelle commande). Testons :

```
R1# disable
R1> enable 5
Password: Tech5!
R1# show privilege
Current privilege level is 5
R1# show ip route
Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area
       ...
Gateway of last resort is not set
```

Ça marche. 🎊 On pourrait s'arrêter là, écrire dans le rapport « délégation en
place », et rentrer chez soi. **Ne rentrez pas chez vous.** Allez voir ce qui
s'est passé au niveau 1 :

```
R1# disable
R1> show version
% Invalid input detected at '^' marker.
R1> show privilege
% Invalid input detected at '^' marker.
```

Voilà. En descendant `show ip route` au niveau 5, on vient de faire monter
**toute la branche `show`** au niveau 5. Le niveau 1 a perdu `show version`,
`show interfaces`, `show clock`… et même `show privilege`, la commande qui
aurait permis de comprendre ce qui se passe. 😱

### Pourquoi ?

Parce qu'IOS ne stocke pas des commandes, il stocke un **arbre**. Pour
atteindre `show ip route`, il faut d'abord franchir le nœud `show`, puis le
nœud `show ip`. Si `show ip route` exige le niveau 5, alors le chemin qui y
mène l'exige aussi — sinon la règle ne voudrait rien dire. Cisco appelle ça
la promotion des commandes parentes, et c'est parfaitement logique une fois
qu'on l'a vu. Le problème, c'est qu'on ne le voit que si on va regarder au
niveau 1, ce que personne ne fait spontanément après avoir vérifié que sa
délégation marche.

### Le remède

Il tient en une ligne, et c'est Cisco lui-même qui la documente : on
**redescend** le nœud parent.

```
R1# configure terminal
R1(config)# privilege exec level 1 show
R1(config)# end
R1# disable
R1> show version
Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.7(3)M5
...
R1> show privilege
Current privilege level is 1
R1> show ip route
% Invalid input detected at '^' marker.
```

Regardez bien ce dernier bloc, parce qu'il est parfait : `show version` est
revenu au niveau 1, `show privilege` aussi, et `show ip route` reste réservé
au niveau 5. C'est exactement ce qu'on voulait depuis le début.

**La règle à retenir : dès que vous descendez une commande à plusieurs mots,
redescendez son premier mot au niveau 1.** Écrivez-la sur un post-it. Elle
vous fera gagner une soirée.

---

## Le mot-clé `all`, ou la différence entre une commande et une branche

Deuxième subtilité, plus douce que la première. Comparons deux formes.

```
R1(config)# privilege exec level 5 show running-config
```

Au niveau 5 :

```
R1# show running-config
Building configuration...
...
R1# show running-config interface GigabitEthernet0/0
% Invalid input detected at '^' marker.
```

La commande nommée passe ; ce qui la **complète** ne passe pas. Maintenant
avec `all` :

```
R1(config)# privilege exec all level 5 show running-config
```

```
R1# show running-config interface GigabitEthernet0/0
Building configuration...

Current configuration : 50 bytes
!
interface GigabitEthernet0/0
 no ip address
end
```

`all` étend la règle à **toute la branche** au lieu de la seule commande
nommée. Utilisez-le quand vous voulez déléguer une famille entière
(`privilege exec all level 5 show ip`), et évitez-le quand vous voulez
délimiter précisément — parce qu'`all` sur un nœud haut placé ouvre beaucoup
plus large qu'on ne le croit.

---

## Les quatre espaces de commandes

Jusqu'ici on n'a joué que dans `exec`. Mais un niveau de privilège s'applique
à **quatre espaces distincts**, et c'est ce qui permet de construire un rôle
qui *configure* quelque chose sans tout configurer.

| Espace | Ce qu'il couvre | Exemple |
|---|---|---|
| `exec` | le mode utilisateur/privilégié | `privilege exec level 5 show ip route` |
| `configure` | la configuration globale | `privilege configure level 5 interface` |
| `interface` | le sous-mode d'interface | `privilege interface level 5 description` |
| `line` | le sous-mode de ligne | `privilege line level 5 exec-timeout` |

Construisons un vrai rôle. Objectif : le niveau 5 peut décrire et couper une
interface, et rien d'autre.

```
R1(config)# privilege exec level 1 show
R1(config)# privilege exec level 5 configure
R1(config)# privilege exec level 5 configure terminal
R1(config)# privilege configure level 5 interface
R1(config)# privilege interface level 5 description
R1(config)# privilege interface level 5 shutdown
```

Notez les **deux** lignes pour `configure terminal` : la commande complète, et
son parent `configure`. Vous avez compris pourquoi. 😉

À l'épreuve :

```
R1# show privilege
Current privilege level is 5
R1# configure terminal
Enter configuration commands, one per line.  End with CNTL/Z.
R1(config)# interface GigabitEthernet0/0
R1(config-if)# description LIEN-VERS-LE-SIEGE
R1(config-if)# shutdown
R1(config-if)# ip address 10.0.0.1 255.255.255.0
% Invalid input detected at '^' marker.
```

Voilà un rôle utilisable : ce technicien peut documenter et isoler une
interface — ce qu'on demande à un technicien de terrain — et il ne peut pas
lui donner une adresse. Il est entré en mode configuration, il y a fait
exactement deux choses, et le reste n'existe pas pour lui.

---

## `show running-config` au niveau réduit : la grande surprise

Celle-là mérite sa propre section, parce qu'elle fait paniquer tout le monde
la première fois.

Reprenons le rôle ci-dessus, avec un secret SNMP dans la configuration pour
rendre l'enjeu visible. Au niveau 15 :

```
R1# show running-config
Building configuration...

Current configuration : 1012 bytes
!
hostname R1
!
enable secret 5 $1$9b73172a$mTn6fWVQr.2AvTIGpEdsJ.
enable secret level 5 5 $1$bf782ee4$x1VWsPnu2jZsF5GHTc/3g.
!
privilege exec level 1 show
privilege exec all level 5 show running-config
privilege exec level 5 configure
...
interface GigabitEthernet0/0
 no ip address
!
snmp-server community SECRETE RO
!
end
```

Et au niveau 5, la même commande, sur la même machine, au même instant :

```
R1# show running-config
Building configuration...

Current configuration : 213 bytes
!
!
!
!
!
!
interface GigabitEthernet0/0
!
interface GigabitEthernet0/1
!
interface GigabitEthernet0/2
!
interface GigabitEthernet0/3
!
!
end
```

**C'est normal.** Ce n'est pas un bug, ce n'est pas une configuration
corrompue. IOS ne montre à une session que **ce qu'elle a le droit de
modifier**. Notre technicien a reçu `interface` et `description` — il voit
donc les blocs `interface`, et rien d'autre. Le `snmp-server community
SECRETE` a disparu, les condensés des mots de passe ont disparu, les règles
`privilege` elles-mêmes ont disparu.

Et c'est **exactement le but**. Cisco le dit dans sa propre documentation :
sans ce filtre, une commande comme `snmp-server community` suffirait à
reprendre le contrôle complet du routeur depuis un niveau réduit. Le
technicien qui lit la chaîne de communauté SNMP en lecture-écriture n'a plus
besoin de votre `enable secret`.

Le corollaire, c'est que **si un opérateur vous dit « je vois une
configuration vide », ce n'est pas une panne : c'est qu'on ne lui a rien
délégué en mode configuration.** Donnez-lui `privilege configure level N
<quelque chose>` et le quelque chose apparaîtra.

Petit détail qui a son importance : la ligne `Current configuration : 213
bytes` compte bien les 213 octets **rendus**, pas les 1012 de la
configuration complète. Une vue de sécurité qui annoncerait la taille de ce
qu'elle censure publierait, à l'octet près, la quantité de ce qu'elle cache. 🙃

---

## Les comptes, la ligne, et qui gagne

Jusqu'ici on montait de niveau avec `enable N`. Dans la vraie vie, on veut que
le niveau soit attaché au **compte**.

```
R1(config)# username arthur privilege 5 secret Arthur5!
R1(config)# username chef privilege 15 secret Chef15!
R1(config)# line console 0
R1(config-line)# login local
R1(config-line)# exit
```

`login local` dit à la console de demander un nom d'utilisateur et un mot de
passe, et de les vérifier dans la base locale. Arthur se connecte :

```
Username: arthur
Password: Arthur5!
R1# show privilege
Current privilege level is 5
```

Il arrive **directement** au niveau 5, sans taper `enable`. C'est confortable
et c'est ce qu'on veut.

Maintenant, la subtilité qui surprend. Ajoutons un niveau sur la ligne
elle-même :

```
R1(config)# line console 0
R1(config-line)# privilege level 15
```

Et reconnectons Arthur, dont le compte est toujours à 5 :

```
Username: arthur
Password: Arthur5!
R1# show privilege
Current privilege level is 15
```

Arthur est au **niveau 15**. Le réglage de la ligne a **remplacé** celui du
compte. Ce n'est pas un plancher, c'est un remplacement : s'il avait été à
15 et la ligne à 5, il serait descendu à 5.

La précédence complète, du plus fort au plus faible :

> **AAA > ligne > compte**

Un serveur TACACS+/RADIUS qui renvoie un attribut `priv-lvl` gagne toujours ;
sinon c'est la ligne si elle en déclare un ; sinon le compte.

Et donc, l'erreur à ne jamais commettre : **`privilege level 15` sous
`line vty 0 4`**. Cette ligne-là donne le niveau 15 à *tout le monde qui se
connecte en SSH*, quel que soit son compte. C'est un grand classique des
audits, et ça se repère en une commande :

```
R1# show running-config | include privilege level
 privilege level 15
```

L'espace en tête de ligne indique que c'est bien un réglage **de ligne** et
non une règle globale. Allez voir dans quel bloc il se trouve.

---

## Là où les niveaux s'arrêtent

Les niveaux, c'est bien. Mais après quelques rôles, on rencontre leur limite,
et elle est structurelle : **un niveau est cumulatif et ordonné**. Le niveau 7
contient forcément tout ce que contient le niveau 5. Vous ne pouvez pas dire
« Alice peut faire A et B, Bob peut faire B et C » — il faudrait que A et C
soient au même niveau, donc que chacun ait les deux.

Et surtout : un niveau **ajoute** au socle du niveau 1. Vous ne choisissez
jamais ce socle. Vous héritez de tout ce que Cisco a décidé de mettre au
niveau 1, et vous empilez par-dessus.

Pour décrire un vrai rôle — « voici ce que ce prestataire a le droit de
faire, point » — il faut l'autre mécanisme.

---

## Les vues CLI : décrire un rôle au lieu de l'empiler

Une **vue** (CLI View, ou Role-Based CLI Access) **remplace** l'arbre visible
par ce que vous y mettez, et rien d'autre. C'est la différence fondamentale
avec un niveau, et c'est ce qui la rend utilisable pour décrire un métier.

Première condition, et elle est ferme :

```
R1(config)# parser view NOC
%Parser view commands are not available. AAA must be enabled first
R1(config)# aaa new-model
R1(config)# parser view NOC
R1(config-view)#
```

Une vue est un mécanisme d'autorisation, elle vit dans AAA. Deuxième
condition : il faut être en **vue racine**, c'est-à-dire au niveau 15. Une
session de niveau 5 ne déclare pas de rôles — sinon elle s'écrirait le sien.

Construisons trois rôles :

```
R1(config-view)# secret Vue@NOC2026
R1(config-view)# commands exec include show version
R1(config-view)# commands exec include show ip interface brief
R1(config-view)# commands exec include ping
R1(config-view)# exit

R1(config)# parser view SUPPORT
R1(config-view)# secret Vue@SUP2026
R1(config-view)# commands exec include show interfaces
R1(config-view)# exit
```

Un détail rassurant au passage — essayez de vous tromper :

```
R1(config-view)# commands exec include shwo verison
%Command not found
```

La commande est **validée contre l'arbre réel**. Une faute de frappe ne crée
pas silencieusement une vue vide. C'est le genre de garde-fou qui vaut de
l'or : une vue vide, on ne s'en aperçoit qu'au moment où l'opérateur appelle
en disant que « rien ne marche ».

### Entrer dans une vue

```
R1# enable view NOC
Password: Vue@NOC2026
R1# show parser view
Current view is 'NOC'
```

Et maintenant, le moment de vérité :

```
R1# show version
Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.7(3)M5
...
R1# show ip interface brief
Interface                  IP-Address      OK? Method Status                Protocol
GigabitEthernet0/0         unassigned      YES unset  down                  down
...
R1# show ip route
% Invalid input detected at '^' marker.
R1# configure terminal
% Invalid input detected at '^' marker.
R1# show running-config
% Invalid input detected at '^' marker.
```

Trois choses valent d'être soulignées.

**Un.** Ce qui est inclus s'exécute **pour de bon**, avec la sortie complète —
ce n'est pas une version dégradée de la commande.

**Deux.** Ce qui n'est pas inclus répond `% Invalid input detected`, comme au
chapitre des niveaux : la commande est **absente**, pas refusée.

**Trois, et c'est le point important :** on n'a rien eu à *retirer*. `show ip
route`, `configure terminal`, `show running-config` ne sont pas dans la vue
parce qu'on ne les y a pas mis. C'est ça, décrire un rôle : on énonce ce que
le rôle a le droit de faire, au lieu de l'ajouter par-dessus un socle qu'on
n'a pas choisi.

### On sort toujours d'une vue

```
R1# exit
Connection closed.
```

`exit`, `end`, `logout`, `disable`, `enable` et `show parser view` restent
toujours accessibles depuis une vue. C'est délibéré : une vue dont on ne peut
pas sortir n'est plus un rôle, c'est une souricière. Et `show parser view`
doit répondre de l'intérieur, sinon on ne sait pas où l'on est.

---

## `include-exclusive`, `exclude` et `all`

Trois raffinements, tous utiles.

**`include-exclusive` réserve** la commande : aucune autre vue ne pourra plus
la revendiquer.

```
R1(config)# parser view A
R1(config-view)# commands exec include-exclusive show ip route
R1(config-view)# exit
R1(config)# parser view B
R1(config-view)# commands exec include show ip route
%Command is set as include-exclusive in view A
```

C'est le mécanisme qui garantit qu'une commande sensible n'appartient qu'à un
seul rôle — et le refus nomme la vue qui la détient, ce qui évite une demi-heure
d'enquête.

**`exclude` retire** une commande d'une branche par ailleurs incluse. C'est le
complément indispensable d'`all` :

```
R1(config-view)# commands exec include all show
R1(config-view)# commands exec exclude show running-config
```

« Toute la famille `show`, sauf la configuration. » En deux lignes.

Vérifions dans la vue :

```
R1# show clock
*11:16:00.000 UTC Fri Aug 14 2026
R1# show ip route
Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
...
R1# show running-config
% Invalid input detected at '^' marker.
```

Et si on se trompe de secret :

```
R1# enable view A
Password: mauvais
% Access denied
% Access denied
% Bad secrets
```

Le secret de la vue est une vraie porte, pas une décoration.

---

## Les supervues : composer des rôles

Dernier étage. Une **supervue** regroupe plusieurs vues. On ne met pas de
commandes dedans — on y met des vues.

```
R1(config)# parser view TOUT superview
R1(config-view)# secret Vue@TOUT2026
R1(config-view)# view NOC
R1(config-view)# view SUPPORT
R1(config-view)# exit
```

```
R1# enable view TOUT
Password: Vue@TOUT2026
R1# show version
Cisco IOS Software, ...            ← vient de NOC
R1# show interfaces GigabitEthernet0/0
GigabitEthernet0/0 is down, ...    ← vient de SUPPORT
R1# show ip route
% Invalid input detected at '^' marker.   ← dans aucune des deux
```

C'est le modèle de composition qu'on attend : on écrit les rôles élémentaires
une fois, et on fabrique les profils réels en les combinant. Le chef d'équipe
qui doit avoir NOC **et** SUPPORT n'oblige pas à recopier douze lignes.

---

## Vérifier son travail

Un rôle qu'on ne sait pas relire n'est pas un rôle, c'est un pari. Quatre
commandes suffisent.

**Qui suis-je :**

```
R1# show privilege
Current privilege level is 15
```

**Quelles vues existent, et lesquelles sont des supervues :**

```
R1# show parser view all
Views/SuperViews Present in System:
NOC
SUPPORT
TOUT *
-------(*) represent superview-------
```

L'étoile est la seule information que cette commande apporte de plus que la
configuration : elle dit laquelle est une supervue.

**Quelles règles de niveau sont en place :**

```
R1# show running-config | include privilege exec
privilege exec level 1 show
privilege exec all level 5 show running-config
privilege exec level 5 configure
privilege exec level 5 configure terminal
```

**Ce que contient une vue :**

```
R1# show running-config | section parser view
parser view NOC
 secret 5 $1$7baaf60c$OUdunNU2RxYZJL6B/vLJ..
 commands exec include show version
 commands exec include show ip interface brief
 commands exec include ping
 exit
!
parser view SUPPORT
 secret 5 $1$d666d312$tT9kufl/B8xQUQG4Dbhbv/
 commands exec include show interfaces
 exit
!
parser view TOUT superview
 secret 5 $1$28f31e09$23hXboUvl/VZb0xDR2yrz1
 view NOC
 view SUPPORT
 exit
```

Et la meilleure vérification, celle qui ne ment jamais : **ouvrez une seconde
session avec le rôle en question et essayez de faire ce qu'il ne doit pas
pouvoir faire.** Une matrice de droits sur un tableur ne prouve rien ; une
session qui reçoit `% Invalid input detected` prouve quelque chose.

---

## Les pièges, rassemblés

Je les regroupe ici pour que vous puissiez revenir sur cette section seule.

1. **La promotion des parentes.** Descendre `show ip route` fait monter
   `show` — donc le niveau 1 perd `show version` *et* `show privilege`.
   Remède : `privilege exec level 1 show`. C'est le piège n°1, et de loin.
2. **Le prompt ment.** `#` s'affiche dès le niveau 2. Fiez-vous à
   `show privilege`.
3. **La configuration « vide » n'est pas une panne.** IOS ne montre que ce que
   la session peut modifier. Sans délégation en mode configuration, il n'y a
   rien à montrer.
4. **`privilege level 15` sous `line vty`** donne 15 à tout le monde en SSH.
   Cherchez cette ligne dans tous vos équipements, aujourd'hui.
5. **La ligne remplace le compte**, elle ne le plafonne pas. Un compte à 15
   sur une ligne à 5 arrive à 5.
6. **`all` ouvre une branche entière.** Sur un nœud haut, c'est beaucoup plus
   large qu'on ne le pense.
7. **N'oubliez pas le parent de `configure terminal`.** Il faut les deux
   lignes, `configure` et `configure terminal`.
8. **`enable password` n'est pas un mot de passe.** Toujours `enable secret`.

---

## Pour finir

On a couvert beaucoup de terrain : les seize niveaux, les portes par niveau,
la délégation et son piège, le mot-clé `all`, les quatre espaces de commandes,
le filtrage de `show running-config`, la précédence AAA/ligne/compte, les vues,
leurs trois modes d'inclusion, les supervues, et de quoi relire tout ça.

Si vous ne deviez retenir que deux phrases, ce seraient celles-ci :

> **Un niveau ajoute au socle du niveau 1. Une vue remplace l'arbre visible.**

> **Un droit qu'on n'a pas essayé de contourner n'est pas un droit vérifié.**

La prochaine fois, on branchera tout ça sur un serveur TACACS+ : l'autorisation
par commande (`aaa authorization commands`), la comptabilité (`aaa
accounting commands`, celle qui écrit *qui a tapé quoi*), et ce qui se passe
quand le serveur ne répond plus — parce que ce jour-là arrive toujours, et
qu'une politique d'autorisation se juge précisément là.

D'ici là, prenez soin de vous. 🙏

*Toutes les sorties de cet article ont été capturées en jouant le laboratoire
de bout en bout. Si l'une d'elles ne correspond pas à ce que vous obtenez,
c'est intéressant — dites-le-moi.*

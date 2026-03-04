# OSPF de Zéro à Héros : Comprendre et Configurer le Protocole de Routage Dynamique

> **À qui s'adresse ce tutoriel ?**
> Ce guide est fait pour toi si tu sais ce qu'est une adresse IP, un masque de sous-réseau, et que tu n'as pas peur d'un terminal. Pas besoin d'être un expert réseau — on part vraiment de zéro et on construit ensemble, brique par brique. 🧱

---

## Table des matières

1. [Avant de commencer : quelques rappels essentiels](#1-avant-de-commencer--quelques-rappels-essentiels)
2. [Le problème que résout OSPF](#2-le-problème-que-résout-ospf)
3. [Qu'est-ce qu'OSPF exactement ?](#3-quest-ce-quospf-exactement-)
4. [Les concepts clés d'OSPF](#4-les-concepts-clés-dospf)
5. [Comment OSPF fonctionne en coulisses](#5-comment-ospf-fonctionne-en-coulisses)
6. [Présentation de notre laboratoire](#6-présentation-de-notre-laboratoire)
7. [Configuration d'OSPF sur les routeurs Cisco](#7-configuration-dospf-sur-les-routeurs-cisco)
8. [Configuration d'OSPF sur les switches Cisco (Layer 3)](#8-configuration-dospf-sur-les-switches-cisco-layer-3)
9. [Vérification et diagnostic](#9-vérification-et-diagnostic)
10. [Cas pratiques et scénarios avancés](#10-cas-pratiques-et-scénarios-avancés)
11. [Les erreurs classiques et comment les éviter](#11-les-erreurs-classiques-et-comment-les-éviter)
12. [Conclusion](#12-conclusion)

---

## 1. Avant de commencer : quelques rappels essentiels

Avant de plonger dans le vif du sujet, posons quelques bases. Même si tu connais déjà ces notions, un petit rappel ne fait jamais de mal — et ça nous permettra d'être tous sur la même longueur d'onde. 😄

### 1.1 C'est quoi une adresse IP, déjà ?

Une **adresse IP** (Internet Protocol), c'est un peu comme l'adresse postale de ton ordinateur sur un réseau. Ça permet d'identifier de manière unique chaque appareil connecté. On parle généralement d'IPv4, qui ressemble à ça : `192.168.1.10`.

Une adresse IPv4 est composée de **4 octets** (4 groupes de 8 bits), séparés par des points. Chaque octet peut aller de `0` à `255`.

### 1.2 C'est quoi un masque de sous-réseau ?

Le **masque de sous-réseau** (ou *subnet mask*), c'est ce qui permet de délimiter quelle partie de l'adresse IP représente le **réseau** et quelle partie représente l'**hôte** (l'appareil lui-même).

Par exemple, avec l'adresse `192.168.1.10` et le masque `255.255.255.0` :
- `192.168.1` → c'est la **partie réseau** (tout le monde dans ce réseau partage cette partie)
- `10` → c'est la **partie hôte** (l'identifiant unique de cet appareil dans ce réseau)

On peut aussi noter le masque en **notation CIDR**, par exemple `/24` au lieu de `255.255.255.0`. Le chiffre après le `/` indique le nombre de bits réservés à la partie réseau.

| Notation CIDR | Masque en décimal | Nombre d'hôtes possible |
|---|---|---|
| /8 | 255.0.0.0 | ~16 millions |
| /16 | 255.255.0.0 | ~65 000 |
| /24 | 255.255.255.0 | 254 |
| /30 | 255.255.255.252 | 2 |

### 1.3 C'est quoi un routeur ?

Un **routeur**, c'est le chef d'orchestre du réseau. Son rôle est de **faire passer les paquets de données** d'un réseau à un autre. Quand tu envoies un email, le paquet de données voyage de routeur en routeur jusqu'à sa destination finale — un peu comme un colis qu'on passe de bureau de poste en bureau de poste.

### 1.4 C'est quoi un switch ?

Un **switch** (ou commutateur), c'est l'appareil qui connecte plusieurs appareils **au sein du même réseau**. Contrairement au routeur qui travaille entre les réseaux, le switch travaille à l'intérieur d'un réseau. Il y a deux types de switches :
- **Layer 2 (L2)** : il travaille uniquement avec les adresses MAC (les adresses physiques des cartes réseau). Il ne comprend pas les adresses IP.
- **Layer 3 (L3)** : il comprend aussi les adresses IP et peut faire du routage, comme un routeur.

### 1.5 C'est quoi une table de routage ?

La **table de routage**, c'est le carnet d'adresses d'un routeur. Elle contient la liste de tous les réseaux connus par le routeur et l'indication de **par où envoyer les paquets** pour atteindre chaque réseau. C'est sur cette table que repose toute la magie du routage. 🗺️

---

## 2. Le problème que résout OSPF

Imaginons une situation concrète. Tu gères un réseau d'entreprise avec 5 routeurs, 10 switches et une vingtaine de sous-réseaux différents. Comment est-ce que chaque routeur sait comment atteindre les autres réseaux ?

### 2.1 Le routage statique : la solution manuelle

La première solution, c'est le **routage statique**. Tu te connectes manuellement sur chaque routeur et tu lui dis : *"Pour atteindre le réseau X, envoie les paquets par cette interface."*

C'est faisable sur un petit réseau. Mais imagine que tu aies 50 routeurs, 200 réseaux... Ce serait un cauchemar à configurer ! 😱 Et si un routeur tombe en panne ? Il faudrait reconfigurer manuellement toutes les routes qui passaient par lui.

```
# Exemple de route statique sur un routeur Cisco
Router(config)# ip route 192.168.2.0 255.255.255.0 10.0.0.2
# Traduction : "Pour aller vers 192.168.2.0/24, passe par 10.0.0.2"
```

### 2.2 Les limites du routage statique

Le routage statique a plusieurs gros problèmes :

- **Pas de tolérance aux pannes** : si un lien tombe, les paquets continuent à être envoyés vers ce lien mort, et tout s'arrête.
- **Pas de scalabilité** : plus le réseau grandit, plus c'est compliqué à gérer.
- **Maintenance coûteuse** : chaque changement dans la topologie réseau nécessite une intervention manuelle.

C'est exactement pour résoudre ces problèmes qu'on a inventé les **protocoles de routage dynamique**, et OSPF en est l'un des plus populaires et des plus utilisés dans le monde professionnel.

---

## 3. Qu'est-ce qu'OSPF exactement ?

**OSPF** signifie **Open Shortest Path First**. Décortiquons ce nom :

- **Open** : c'est un standard ouvert, défini par un organisme international (l'IETF — Internet Engineering Task Force), dans un document appelé RFC 2328. Ça veut dire que n'importe quel fabricant (Cisco, Juniper, Huawei, etc.) peut l'implémenter, et tous leurs équipements pourront se parler.
- **Shortest Path** : OSPF calcule toujours le **chemin le plus court** (ou plus précisément, le moins coûteux) pour acheminer les données.
- **First** : ce chemin le plus court est prioritaire.

OSPF est ce qu'on appelle un protocole de routage de type **Link-State** (état de lien). On verra ce que ça veut dire en détail dans la section suivante.

### 3.1 Les grandes familles de protocoles de routage dynamique

Il existe deux grandes familles de protocoles de routage dynamique :

**Les protocoles à vecteur de distance (Distance Vector)**
- Exemples : RIP (Routing Information Protocol), EIGRP
- Principe : chaque routeur dit à ses voisins *"je connais ces réseaux, ils sont à telle distance de moi"*
- Problème : les routeurs n'ont pas une vision complète du réseau, ce qui peut mener à des boucles de routage et à une convergence lente.

**Les protocoles à état de lien (Link-State)**
- Exemples : **OSPF**, IS-IS
- Principe : chaque routeur construit une **carte complète** du réseau, puis calcule lui-même les meilleurs chemins.
- Avantage : vision globale, convergence rapide, pas de boucles de routage.

OSPF appartient à cette deuxième famille, et c'est ce qui en fait un protocole robuste et fiable. 💪

### 3.2 Pourquoi choisir OSPF ?

OSPF est le choix numéro un dans beaucoup d'entreprises pour plusieurs raisons :

- ✅ **Standard ouvert** : interopérable entre tous les équipements réseau
- ✅ **Convergence rapide** : si un lien tombe, OSPF trouve une alternative très vite
- ✅ **Scalabilité** : peut gérer des réseaux de taille très importante grâce au concept d'**areas** (zones)
- ✅ **Pas de limitation sur la taille du réseau** : contrairement à RIP qui est limité à 15 sauts
- ✅ **Métrique basée sur la bande passante** : OSPF choisit les chemins les plus rapides, pas juste les plus courts en nombre de sauts
- ✅ **Supporte VLSM** : compatible avec les masques de sous-réseaux de longueur variable

---

## 4. Les concepts clés d'OSPF

Pour bien comprendre OSPF, il y a un certain nombre de concepts fondamentaux à maîtriser. Je vais te les expliquer un par un, avec des analogies pour que ce soit le plus clair possible. 😊

### 4.1 Le Router ID (RID)

Chaque routeur qui participe à OSPF doit avoir un identifiant unique : le **Router ID** (RID). C'est une adresse IPv4 de 32 bits qui sert à identifier de manière unique chaque routeur dans le domaine OSPF.

Comment OSPF choisit-il le Router ID ? Dans l'ordre de priorité :
1. L'adresse configurée manuellement avec la commande `router-id`
2. L'adresse la plus haute parmi les interfaces **loopback** actives
3. L'adresse la plus haute parmi toutes les interfaces physiques actives

> 💡 **Bonne pratique** : Toujours configurer le Router ID manuellement. Ça évite les surprises si une interface change d'adresse.

### 4.2 Les interfaces Loopback

Une **interface loopback** est une interface virtuelle sur un routeur. Elle n'est connectée à rien physiquement, mais elle existe logiquement dans le routeur. Son avantage majeur : elle est **toujours disponible**, même si toutes les interfaces physiques tombent. C'est pourquoi on l'utilise souvent comme Router ID.

```
# Créer une interface loopback
Router(config)# interface loopback 0
Router(config-if)# ip address 1.1.1.1 255.255.255.255
Router(config-if)# no shutdown
```

### 4.3 Les voisins OSPF (Neighbors)

En OSPF, deux routeurs directement connectés (ou sur le même réseau) qui se "découvrent" mutuellement deviennent des **voisins** (neighbors). Pour devenir voisins, ils échangent des messages appelés **Hello packets**.

Imagine que tu arrives dans une nouvelle ville. Tu te présentes à tes voisins directs, et eux se présentent à toi. C'est exactement ce que font les routeurs OSPF ! 👋

Pour que deux routeurs deviennent voisins OSPF, plusieurs paramètres doivent correspondre :
- Le même **Hello Interval** (fréquence d'envoi des Hello)
- Le même **Dead Interval** (durée avant de déclarer un voisin mort)
- La même **Area ID** (zone OSPF)
- Le même **Subnet** (ils doivent être dans le même sous-réseau)
- La même **Authentication** (si configurée)
- Le même **MTU** (Maximum Transmission Unit)

### 4.4 La relation d'adjacence

Être voisin, c'est bien, mais OSPF va plus loin avec le concept d'**adjacence**. Deux routeurs sont **adjacents** quand ils ont échangé l'intégralité de leur base de données de topologie. Ce n'est qu'après avoir établi une adjacence complète que les routeurs peuvent calculer les routes.

> 🔑 **Attention** : Tous les voisins ne deviennent pas nécessairement adjacents. Sur certains types de réseaux (comme Ethernet), OSPF élit un **DR** et un **BDR** (on en parle juste après), et seuls ces élus deviennent adjacents avec tous les autres routeurs.

### 4.5 Le DR et le BDR

Sur les réseaux de type **broadcast** (comme Ethernet, celui qu'on utilise avec les switches), si tous les routeurs devaient établir une adjacence complète avec tous les autres, le nombre d'échanges deviendrait gigantesque.

Imagine un réseau avec 10 routeurs. Sans optimisation, on aurait `10 × 9 / 2 = 45` adjacences à maintenir. Avec 50 routeurs, ce serait `1225` adjacences ! 😱

Pour éviter ça, OSPF élit :
- **DR (Designated Router)** : le routeur désigné, celui qui centralise les échanges d'informations de routage.
- **BDR (Backup Designated Router)** : le routeur désigné de secours, prêt à prendre le relais si le DR tombe.

Tous les autres routeurs (**DROther**) n'établissent d'adjacence complète qu'avec le DR et le BDR, pas entre eux.

**Élection du DR/BDR :**
1. Le routeur avec la **priorité OSPF la plus élevée** (valeur de 0 à 255, par défaut 1) devient DR.
2. En cas d'égalité de priorité, c'est le **Router ID le plus élevé** qui l'emporte.
3. Une priorité de `0` signifie "je ne veux pas participer à l'élection".

> ⚠️ **Important** : L'élection DR/BDR n'a lieu qu'**une seule fois** au démarrage. Si un nouveau routeur avec une priorité plus élevée rejoint le réseau, il ne "vole" pas le rôle de DR. Ce n'est qu'à la prochaine élection (après une panne du DR) que ça change. C'est ce qu'on appelle le comportement "non-preemptive".

### 4.6 Le coût OSPF (Cost)

OSPF utilise une **métrique** appelée **coût** pour évaluer la qualité d'un chemin. Plus le coût est bas, meilleur est le chemin. Le coût total d'un chemin, c'est la somme des coûts de chaque lien sur ce chemin.

Le coût d'une interface est calculé ainsi :

```
Coût = Bande passante de référence / Bande passante de l'interface
```

Par défaut, la bande passante de référence est **100 Mbps** (100 000 000 bps). Donc :

| Type de lien | Bande passante | Coût OSPF |
|---|---|---|
| Série (T1) | 1,544 Mbps | 64 |
| Ethernet | 10 Mbps | 10 |
| FastEthernet | 100 Mbps | **1** |
| GigabitEthernet | 1 Gbps | **1** |
| 10 GigabitEthernet | 10 Gbps | **1** |

> ⚠️ **Problème classique** : Par défaut, FastEthernet, GigabitEthernet et 10GigabitEthernet ont **tous le même coût de 1** ! Ça veut dire qu'OSPF ne fait pas la différence entre un lien de 100 Mbps et un lien de 10 Gbps. Pour corriger ça, il faut augmenter la bande passante de référence.

```
# Changer la bande passante de référence (à faire sur TOUS les routeurs)
Router(config-router)# auto-cost reference-bandwidth 10000
# Maintenant la référence est 10 Gbps (10 000 Mbps)
```

Avec une référence de 10 000 Mbps :
- FastEthernet (100 Mbps) → coût = 100
- GigabitEthernet (1 000 Mbps) → coût = 10
- 10GigabitEthernet (10 000 Mbps) → coût = 1

### 4.7 Les LSA (Link State Advertisement)

Les **LSA** sont les messages qu'OSPF utilise pour partager les informations de topologie. Chaque routeur génère des LSA qui décrivent :
- Ses interfaces et leur état
- Ses voisins
- Les réseaux auxquels il est connecté

Ces LSA sont ensuite **inondés** (flooded) dans toute la zone OSPF, permettant à chaque routeur de construire une carte complète du réseau.

Il existe plusieurs types de LSA, mais pour ce tutoriel, concentrons-nous sur les plus importants :
- **LSA Type 1 (Router LSA)** : décrit les interfaces d'un routeur et ses voisins dans une zone.
- **LSA Type 2 (Network LSA)** : généré par le DR, décrit tous les routeurs connectés à un réseau broadcast.
- **LSA Type 3 (Summary LSA)** : généré par l'ABR (routeur de bordure de zone), résume les routes d'une zone vers une autre.
- **LSA Type 5 (AS External LSA)** : décrit des routes apprises depuis l'extérieur du domaine OSPF (redistribution).

### 4.8 La LSDB (Link State Database)

La **LSDB** (Link State Database, ou base de données d'état de lien) est la carte complète du réseau que chaque routeur OSPF construit à partir des LSA reçus. Tous les routeurs dans la même zone ont **exactement la même LSDB** — c'est ce qu'on appelle la **synchronisation de la base de données**.

### 4.9 L'algorithme SPF (Dijkstra)

Une fois la LSDB construite, chaque routeur utilise l'**algorithme SPF** (Shortest Path First), aussi connu sous le nom d'**algorithme de Dijkstra**, pour calculer le meilleur chemin vers chaque destination.

Concrètement, chaque routeur se place au centre de la carte et calcule le chemin le moins coûteux vers toutes les autres destinations. Les résultats sont ensuite placés dans la **table de routage**.

> 🧠 **Pour les curieux** : L'algorithme de Dijkstra a été inventé par le mathématicien et informaticien néerlandais Edsger W. Dijkstra en 1956. C'est l'un des algorithmes les plus célèbres en informatique, et il est utilisé bien au-delà du réseau (GPS, jeux vidéo, etc.).

### 4.10 Les Areas OSPF (Zones)

Pour permettre à OSPF de passer à l'échelle sur de très grands réseaux, on utilise le concept d'**areas** (zones). Une area OSPF, c'est un groupe de routeurs et de réseaux qui partagent la même LSDB.

L'avantage des areas :
- La LSDB de chaque area est **plus petite** → moins de mémoire utilisée, calculs SPF plus rapides.
- Les changements de topologie dans une area **n'affectent pas** les autres areas.

Il existe une area spéciale : l'**Area 0** (aussi appelée **Backbone Area** ou zone dorsale). C'est l'area centrale à laquelle toutes les autres areas doivent être connectées.

```
Area 2 ──── Area 0 (Backbone) ──── Area 1
                  │
              Area 3
```

Les routeurs qui connectent deux areas différentes s'appellent des **ABR** (Area Border Routers). Ils ont une interface dans chaque area et résument les informations entre elles.

Pour un réseau simple (comme notre labo), on utilisera uniquement l'**Area 0**. C'est le cas le plus courant pour les petits et moyens réseaux.

---

## 5. Comment OSPF fonctionne en coulisses

Maintenant qu'on a les concepts de base, regardons comment OSPF s'établit étape par étape. C'est un peu comme regarder un film en coulisses. 🎬

### 5.1 Étape 1 : Envoi des Hello packets

Quand OSPF est activé sur une interface, le routeur commence immédiatement à envoyer des **Hello packets** de manière périodique. Ces paquets sont envoyés vers l'adresse multicast `224.0.0.5` (pour atteindre tous les routeurs OSPF sur le segment).

Le Hello packet contient entre autres :
- Le Router ID de l'émetteur
- L'Area ID
- Le Hello Interval (par défaut : 10 secondes sur les liens broadcast)
- Le Dead Interval (par défaut : 40 secondes)
- La priorité OSPF
- La liste des voisins déjà connus

### 5.2 Étape 2 : Découverte des voisins et élection DR/BDR

Quand un routeur reçoit un Hello packet d'un autre routeur, il vérifie que les paramètres correspondent (Hello Interval, Dead Interval, Area ID, etc.). Si tout correspond, les deux routeurs se reconnaissent comme **voisins** et passent à l'état `2-WAY`.

C'est à ce moment que l'**élection DR/BDR** a lieu sur les réseaux broadcast.

### 5.3 Étape 3 : Échange de la LSDB (Database Exchange)

Une fois les voisinages établis, les routeurs adjacents procèdent à l'échange de leur LSDB. Cet échange se fait en plusieurs sous-étapes :

1. **ExStart** : les deux routeurs négocient qui va initier l'échange (le routeur avec le RID le plus élevé est le "Master").
2. **Exchange** : les routeurs s'envoient mutuellement des **DBD** (Database Description) packets, qui sont des résumés de leur LSDB.
3. **Loading** : les routeurs demandent les LSA qu'ils n'ont pas encore avec des **LSR** (Link State Request). L'autre routeur répond avec des **LSU** (Link State Update). Des **LSAck** (Link State Acknowledgment) confirment la réception.
4. **Full** : les deux routeurs ont synchronisé leurs bases de données. L'adjacence est complète ! ✅

### 5.4 Étape 4 : Calcul du SPF et remplissage de la table de routage

Chaque routeur lance l'algorithme SPF sur sa LSDB pour calculer les meilleurs chemins. Les routes calculées sont ensuite installées dans la **table de routage** avec la mention `O` (pour OSPF).

### 5.5 Étape 5 : Maintenance et convergence

OSPF maintient les adjacences en envoyant régulièrement des Hello packets. Si un routeur ne reçoit plus de Hello d'un voisin pendant le **Dead Interval** (40 secondes par défaut), il déclare ce voisin mort et recalcule les routes. C'est la **convergence**.

La convergence d'OSPF est généralement très rapide — de l'ordre de quelques secondes sur la plupart des réseaux. 🚀

### 5.6 Les états d'une adjacence OSPF

Pour être précis, une relation OSPF entre deux routeurs passe par plusieurs **états** bien définis avant d'atteindre la maturité. Comprendre ces états t'aidera énormément à diagnostiquer les problèmes. Voici le cycle complet :

```
DOWN → INIT → 2-WAY → EXSTART → EXCHANGE → LOADING → FULL
```

Voyons chaque état en détail :

**DOWN**
C'est l'état initial. Aucun Hello packet n'a encore été reçu de ce voisin. Soit le voisin n'existe pas, soit il ne répond plus depuis plus longtemps que le Dead Interval.

**INIT**
Le routeur a reçu un Hello packet du voisin, mais son propre Router ID n'apparaît pas encore dans la liste des voisins du paquet Hello reçu. En d'autres termes : *"Je t'ai vu, mais tu ne m'as pas encore vu."*

Si un routeur reste bloqué à l'état INIT, ça indique souvent un problème de communication unidirectionnel — le voisin reçoit tes Hello mais toi tu ne reçois pas les siens, ou vice versa.

**2-WAY (Bidirectionnel)**
Les deux routeurs ont reçu le Hello de l'autre et se voient mutuellement dans les listes de voisins. La communication est bidirectionnelle. C'est à ce stade que l'élection DR/BDR a lieu sur les réseaux broadcast.

Sur un réseau broadcast avec plusieurs routeurs, les **DROther** (les routeurs qui ne sont ni DR ni BDR) restent à l'état `2-WAY` entre eux. C'est tout à fait normal ! Ils n'échangent pas leur LSDB directement entre eux — ils le font uniquement via le DR.

**EXSTART**
Les deux routeurs qui vont devenir adjacents (le DR et un DROther, ou deux routeurs sur un lien point-à-point) négocient le rôle de "Master" et "Slave" pour l'échange de bases de données. Le routeur avec le Router ID le plus élevé devient Master.

**EXCHANGE**
Les routeurs s'échangent des **DBD** (Database Description) packets — des résumés de leur LSDB. Chaque DBD contient les en-têtes des LSA que le routeur possède (sans le contenu complet). Les routeurs comparent ces listes pour identifier quels LSA ils n'ont pas encore.

**LOADING**
Chaque routeur envoie des **LSR** (Link State Request) pour demander les LSA complets qu'il a identifiés comme manquants lors de la phase EXCHANGE. L'autre routeur répond avec des **LSU** (Link State Update) contenant les LSA demandés. Des **LSAck** confirment la bonne réception.

**FULL**
L'état final ! Les deux routeurs ont la même LSDB et sont pleinement adjacents. Ils peuvent maintenant calculer les routes optimales. C'est l'état souhaité pour toutes tes adjacences. 🏁

### 5.7 Les types de réseaux OSPF

OSPF adapte son comportement selon le **type de réseau** sur lequel il opère. Il y a cinq types principaux :

**Broadcast (par défaut sur Ethernet)**
C'est le type que tu rencontreras le plus souvent. Sur ce type de réseau, OSPF élit un DR et un BDR. Les Hello packets sont envoyés en multicast à `224.0.0.5` (tous les routeurs OSPF) et `224.0.0.6` (uniquement le DR et le BDR).

**Point-to-Point (par défaut sur les liens série)**
Sur ce type de réseau, il n'y a que deux routeurs directement connectés. Pas besoin d'élire un DR ou BDR — les deux routeurs deviennent immédiatement adjacents. C'est le type le plus simple et le plus rapide à converger.

```cisco
! Forcer une interface Ethernet à se comporter comme un lien point-à-point
! (utile pour des liens directs entre deux routeurs sans switch)
R1(config-if)# ip ospf network point-to-point
```

**Non-Broadcast Multi-Access (NBMA)**
Utilisé sur des technologies comme Frame Relay ou ATM (des technologies WAN plus anciennes). Pas de multicast disponible, donc les Hello packets sont envoyés en unicast. Nécessite une configuration manuelle des voisins.

**Point-to-Multipoint**
Un routeur central connecté à plusieurs sites distants. Chaque lien est traité comme un lien point-à-point indépendant. Pas d'élection DR/BDR.

**Loopback**
Les interfaces loopback sont toujours annoncées avec un /32 dans OSPF, quelle que soit l'adresse configurée. Ce comportement peut être modifié :

```cisco
! Annoncer l'interface loopback avec son vrai masque
R1(config-if)# ip ospf network point-to-point
```

---

## 6. Présentation de notre laboratoire

Passons maintenant à la pratique ! Voici la topologie que nous allons utiliser pour ce tutoriel. Ne t'inquiète pas si tu n'as pas exactement le même matériel — l'essentiel est de comprendre les concepts et de savoir adapter les commandes. 🔧

### 6.1 Notre topologie

```
                    [PC Linux]          [PC Windows]
                         |                    |
                    [Switch SW1]         [Switch SW2]
                         |                    |
                    [Routeur R1] ──────── [Routeur R2]
                         |
                    [Switch SW3]
                         |
                    [Routeur R3]
```

### 6.2 Plan d'adressage IP

Voici le plan d'adressage qu'on va utiliser :

| Réseau | Plage d'adresses | Équipements connectés |
|---|---|---|
| 192.168.1.0/24 | 192.168.1.1 à .254 | LAN de R1 (PC Linux, SW1) |
| 192.168.2.0/24 | 192.168.2.1 à .254 | LAN de R2 (PC Windows, SW2) |
| 192.168.3.0/24 | 192.168.3.1 à .254 | LAN de R3 (SW3) |
| 10.0.0.0/30 | 10.0.0.1 et 10.0.0.2 | Lien entre R1 et R2 |
| 10.0.1.0/30 | 10.0.1.1 et 10.0.1.2 | Lien entre R1 et R3 |

> 💡 **Pourquoi /30 pour les liens entre routeurs ?** Un masque /30 donne seulement 2 adresses hôtes utilisables, ce qui est parfait pour un lien point-à-point entre deux routeurs. Pas besoin de gaspiller une plage /24 entière pour juste deux appareils !

### 6.3 Matériel nécessaire

- **2 routeurs Cisco** (la série ISR 2900 ou 1900 fonctionne très bien, mais quasi toute la gamme Cisco IOS fonctionne)
- **3 switches Cisco** (des Catalyst 2960 pour les switches L2, et idéalement un 3560 ou 3750 si tu veux faire du routage sur switch)
- **1 PC Linux** et **1 PC Windows** (pour les tests de connectivité)
- **Câbles Ethernet** (câbles droits pour PC-Switch-Routeur, câbles croisés pour Routeur-Routeur si les interfaces ne supportent pas l'auto-MDIX — les Cisco modernes gèrent ça automatiquement)
- **Câbles console** (pour se connecter aux équipements Cisco via le port console)

### 6.4 Se connecter à un équipement Cisco

Pour configurer un équipement Cisco, on se connecte via le **port console** avec un câble console (aussi appelé câble RJ45-to-DB9 ou câble rollover).

**Sur Linux :**
```bash
# Installer minicom
sudo apt install minicom

# Trouver le port série (généralement /dev/ttyUSB0 ou /dev/ttyS0)
ls /dev/tty*

# Se connecter (9600 baud, 8N1)
sudo minicom -D /dev/ttyUSB0 -b 9600
```

**Sur Windows :**
Utilise PuTTY ou Tera Term. Configure une connexion série sur le bon port COM, avec 9600 bauds, 8 bits de données, pas de parité, 1 bit de stop (8N1).

### 6.5 Configuration des PC

Avant même de toucher à OSPF, il faut que nos PC soient correctement configurés avec leurs adresses IP et leurs passerelles par défaut. Sans passerelle par défaut correctement configurée, les PC ne sauront pas où envoyer les paquets destinés à d'autres réseaux.

**Sur le PC Linux :**
```bash
# Voir les interfaces réseau disponibles
ip link show
# ou
ifconfig -a

# Configurer l'adresse IP sur l'interface eth0 (ou enp0s3, ens33, etc. selon ta machine)
sudo ip addr add 192.168.1.10/24 dev eth0

# Activer l'interface
sudo ip link set eth0 up

# Configurer la passerelle par défaut (l'adresse du routeur R1 côté LAN)
sudo ip route add default via 192.168.1.1

# Vérifier la configuration
ip addr show eth0
ip route show

# Tester la connectivité vers le routeur
ping 192.168.1.1
```

> 💡 **Note** : Ces configurations sont temporaires. Au redémarrage, elles seront perdues. Pour les rendre permanentes sur Ubuntu/Debian, tu peux utiliser **Netplan** (fichiers dans `/etc/netplan/`) ou modifier `/etc/network/interfaces`. Mais pour notre lab, les commandes temporaires suffisent largement.

**Sur le PC Windows :**

Tu peux configurer l'adresse IP via l'interface graphique :
- Panneau de configuration → Réseau et Internet → Centre Réseau et partage
- Modifier les paramètres de la carte → Propriétés → Protocole Internet version 4 (TCP/IPv4)
- Entrer l'adresse IP `192.168.2.10`, masque `255.255.255.0`, passerelle `192.168.2.1`

Ou via la ligne de commande (en tant qu'administrateur) :
```cmd
REM Configurer l'adresse IP
netsh interface ipv4 set address name="Ethernet" static 192.168.2.10 255.255.255.0 192.168.2.1

REM Vérifier la configuration
ipconfig /all

REM Tester la connectivité
ping 192.168.2.1
```

### 6.6 Les modes de configuration sur un routeur Cisco

Quand tu te connectes à un routeur Cisco, tu passes par plusieurs "niveaux" de configuration. C'est important de bien les comprendre :

```
Router>           # Mode utilisateur (EXEC mode) - lecture seule, commandes basiques
Router# enable    # Passer en mode privilégié
Router#           # Mode privilégié - accès à toutes les commandes de lecture
Router# configure terminal  # Passer en mode de configuration globale
Router(config)#   # Mode de configuration globale - on peut modifier la config
Router(config)# interface GigabitEthernet 0/0  # Entrer dans la config d'une interface
Router(config-if)#  # Mode de configuration d'interface
Router(config-if)# exit  # Revenir au mode de configuration globale
Router(config)# exit  # Revenir au mode privilégié
Router# exit  # Revenir au mode utilisateur
```

---

## 7. Configuration d'OSPF sur les routeurs Cisco

Maintenant qu'on a tout le contexte, on passe aux choses sérieuses ! 😈 Voici comment configurer OSPF pas à pas sur nos routeurs Cisco.

### 7.1 Configuration du Routeur R1

#### 7.1.1 Configuration de base (hostname, mot de passe, etc.)

Commençons par les bases. C'est toujours une bonne pratique de configurer un nom pour ton équipement et de sécuriser l'accès.

```cisco
! Entrer en mode configuration globale
Router# configure terminal

! Donner un nom au routeur
Router(config)# hostname R1

! Configurer un mot de passe pour le mode privilégié (enable password)
R1(config)# enable secret MonMotDePasse123

! Configurer un message de bannière (optionnel mais recommandé)
R1(config)# banner motd #
Accès réservé aux personnes autorisées.
Toute tentative d'intrusion sera poursuivie.
#

! Désactiver la résolution DNS (évite les délais quand on tape une commande inconnue)
R1(config)# no ip domain-lookup
```

> 💡 **Note** : En Cisco IOS, le caractère `!` au début d'une ligne est un commentaire. Il n'est pas interprété comme une commande.

#### 7.1.2 Configuration des interfaces

Maintenant, configurons les interfaces réseau de R1.

```cisco
! Configuration de l'interface vers le LAN (vers SW1 et le PC Linux)
R1(config)# interface GigabitEthernet 0/0
R1(config-if)# description LAN vers SW1 et PC Linux
R1(config-if)# ip address 192.168.1.1 255.255.255.0
R1(config-if)# no shutdown
R1(config-if)# exit

! Configuration de l'interface vers R2 (lien WAN point-à-point)
R1(config)# interface GigabitEthernet 0/1
R1(config-if)# description Lien vers R2
R1(config-if)# ip address 10.0.0.1 255.255.255.252
R1(config-if)# no shutdown
R1(config-if)# exit

! Configuration de l'interface vers R3
R1(config)# interface GigabitEthernet 0/2
R1(config-if)# description Lien vers R3
R1(config-if)# ip address 10.0.1.1 255.255.255.252
R1(config-if)# no shutdown
R1(config-if)# exit

! Configuration de l'interface loopback (pour le Router ID)
R1(config)# interface loopback 0
R1(config-if)# description Router ID de R1
R1(config-if)# ip address 1.1.1.1 255.255.255.255
R1(config-if)# exit
```

> 💡 **Pourquoi `no shutdown` ?** Par défaut, toutes les interfaces d'un routeur Cisco sont désactivées (en état "shutdown"). Il faut les activer manuellement avec `no shutdown`.

#### 7.1.3 Configuration d'OSPF

Voici la partie qu'on attendait ! La configuration d'OSPF sur R1.

```cisco
! Activer le processus OSPF avec l'ID de processus 1
! (L'ID de processus est local au routeur, il n'a pas besoin de correspondre entre routeurs)
R1(config)# router ospf 1

! Configurer manuellement le Router ID
R1(config-router)# router-id 1.1.1.1

! Changer la bande passante de référence pour mieux gérer les liens GigabitEthernet
R1(config-router)# auto-cost reference-bandwidth 10000

! Déclarer les réseaux qui participent à OSPF
! Syntaxe : network <adresse-réseau> <wildcard-mask> area <numéro-area>
R1(config-router)# network 192.168.1.0 0.0.0.255 area 0
R1(config-router)# network 10.0.0.0 0.0.0.3 area 0
R1(config-router)# network 10.0.1.0 0.0.0.3 area 0

! Optionnel : passer l'interface loopback en mode passive (elle n'envoie pas de Hello)
R1(config-router)# passive-interface loopback 0

! Quitter le mode de configuration OSPF
R1(config-router)# exit
```

> 🔑 **Le Wildcard Mask : qu'est-ce que c'est ?**
> Le wildcard mask est l'**inverse** du masque de sous-réseau. C'est ce qu'OSPF utilise pour définir quelles interfaces inclure.
> - `255.255.255.0` inversé → `0.0.0.255` (pour un /24)
> - `255.255.255.252` inversé → `0.0.0.3` (pour un /30)
>
> **Règle simple** : soustrait chaque octet du masque de 255.
> Ex : `255 - 255 = 0`, `255 - 255 = 0`, `255 - 255 = 0`, `255 - 0 = 255` → `0.0.0.255`

#### 7.1.4 Sauvegarder la configuration

Ne jamais oublier de sauvegarder ! Sinon, au prochain redémarrage, tout est perdu. 😭

```cisco
! Sauvegarder la configuration en cours (running-config) dans la mémoire permanente (startup-config)
R1# write memory
! Ou de manière équivalente :
R1# copy running-config startup-config
```

### 7.2 Configuration du Routeur R2

```cisco
Router# configure terminal
Router(config)# hostname R2
R2(config)# enable secret MonMotDePasse123
R2(config)# no ip domain-lookup

! Interfaces
R2(config)# interface GigabitEthernet 0/0
R2(config-if)# description LAN vers SW2 et PC Windows
R2(config-if)# ip address 192.168.2.1 255.255.255.0
R2(config-if)# no shutdown
R2(config-if)# exit

R2(config)# interface GigabitEthernet 0/1
R2(config-if)# description Lien vers R1
R2(config-if)# ip address 10.0.0.2 255.255.255.252
R2(config-if)# no shutdown
R2(config-if)# exit

R2(config)# interface loopback 0
R2(config-if)# description Router ID de R2
R2(config-if)# ip address 2.2.2.2 255.255.255.255
R2(config-if)# exit

! OSPF
R2(config)# router ospf 1
R2(config-router)# router-id 2.2.2.2
R2(config-router)# auto-cost reference-bandwidth 10000
R2(config-router)# network 192.168.2.0 0.0.0.255 area 0
R2(config-router)# network 10.0.0.0 0.0.0.3 area 0
R2(config-router)# passive-interface loopback 0
R2(config-router)# exit

R2# write memory
```

### 7.3 Configuration du Routeur R3

```cisco
Router# configure terminal
Router(config)# hostname R3
R3(config)# enable secret MonMotDePasse123
R3(config)# no ip domain-lookup

! Interfaces
R3(config)# interface GigabitEthernet 0/0
R3(config-if)# description LAN vers SW3
R3(config-if)# ip address 192.168.3.1 255.255.255.0
R3(config-if)# no shutdown
R3(config-if)# exit

R3(config)# interface GigabitEthernet 0/1
R3(config-if)# description Lien vers R1
R3(config-if)# ip address 10.0.1.2 255.255.255.252
R3(config-if)# no shutdown
R3(config-if)# exit

R3(config)# interface loopback 0
R3(config-if)# description Router ID de R3
R3(config-if)# ip address 3.3.3.3 255.255.255.255
R3(config-if)# exit

! OSPF
R3(config)# router ospf 1
R3(config-router)# router-id 3.3.3.3
R3(config-router)# auto-cost reference-bandwidth 10000
R3(config-router)# network 192.168.3.0 0.0.0.255 area 0
R3(config-router)# network 10.0.1.0 0.0.0.3 area 0
R3(config-router)# passive-interface loopback 0
R3(config-router)# exit

R3# write memory
```

### 7.4 L'interface passive : pourquoi c'est important

Tu as remarqué la commande `passive-interface` dans les configurations ci-dessus ? Laisse-moi t'expliquer pourquoi c'est crucial.

Par défaut, OSPF envoie des Hello packets sur **toutes les interfaces déclarées dans OSPF**, y compris les interfaces LAN côté clients. Ça veut dire que tes PC Linux et Windows recevraient des Hello OSPF — ce qui est inutile et représente un risque de sécurité (quelqu'un pourrait connecter un routeur non autorisé et perturber ton réseau !).

Avec `passive-interface`, on dit à OSPF : *"Annonce ce réseau dans OSPF, mais n'envoie pas de Hello packets sur cette interface."*

```cisco
! Mettre UNE interface en mode passif
R1(config-router)# passive-interface GigabitEthernet 0/0

! Alternative : mettre TOUTES les interfaces en mode passif par défaut,
! puis activer seulement celles qui doivent former des adjacences
R1(config-router)# passive-interface default
R1(config-router)# no passive-interface GigabitEthernet 0/1
R1(config-router)# no passive-interface GigabitEthernet 0/2
```

La deuxième approche est souvent préférée car elle est plus sécurisée : on bloque tout par défaut, puis on ouvre seulement ce qui est nécessaire. 🔒

---

## 8. Configuration d'OSPF sur les switches Cisco (Layer 3)

Si tu as des switches de couche 3 (Layer 3) comme les Cisco Catalyst 3560 ou 3750, tu peux aussi y activer OSPF. C'est très utile pour faire du routage entre VLANs sans avoir besoin d'un routeur dédié.

### 8.1 Activer le routage IP sur un switch L3

Par défaut, même un switch L3 ne fait pas de routage. Il faut l'activer explicitement :

```cisco
Switch# configure terminal
Switch(config)# hostname SW3-L3
SW3-L3(config)# ip routing
```

### 8.2 Créer des interfaces VLAN (SVI)

Sur un switch L3, les interfaces de routage sont appelées **SVI** (Switched Virtual Interface). Ce sont des interfaces virtuelles associées à un VLAN.

```cisco
! Créer le VLAN 10
SW3-L3(config)# vlan 10
SW3-L3(config-vlan)# name LAN_R3
SW3-L3(config-vlan)# exit

! Créer l'interface SVI pour le VLAN 10
SW3-L3(config)# interface vlan 10
SW3-L3(config-if)# description SVI VLAN 10
SW3-L3(config-if)# ip address 192.168.3.2 255.255.255.0
SW3-L3(config-if)# no shutdown
SW3-L3(config-if)# exit

! Configurer un port en mode access pour le VLAN 10
SW3-L3(config)# interface GigabitEthernet 0/1
SW3-L3(config-if)# switchport mode access
SW3-L3(config-if)# switchport access vlan 10
SW3-L3(config-if)# exit

! Configurer un port en mode routed (pas switchport) pour la liaison vers un routeur
SW3-L3(config)# interface GigabitEthernet 0/2
SW3-L3(config-if)# no switchport
SW3-L3(config-if)# ip address 10.0.2.2 255.255.255.252
SW3-L3(config-if)# no shutdown
SW3-L3(config-if)# exit
```

### 8.3 Activer OSPF sur le switch L3

La configuration OSPF sur un switch L3 est identique à celle d'un routeur :

```cisco
SW3-L3(config)# router ospf 1
SW3-L3(config-router)# router-id 4.4.4.4
SW3-L3(config-router)# auto-cost reference-bandwidth 10000
SW3-L3(config-router)# network 192.168.3.0 0.0.0.255 area 0
SW3-L3(config-router)# network 10.0.2.0 0.0.0.3 area 0
SW3-L3(config-router)# passive-interface vlan 10
SW3-L3(config-router)# exit

SW3-L3# write memory
```

---

## 9. Vérification et diagnostic

La configuration, c'est bien. Mais vérifier que tout fonctionne comme prévu, c'est encore mieux ! Voici les commandes essentielles pour diagnostiquer ton déploiement OSPF. 🔍

### 9.1 Vérifier les voisins OSPF

C'est la première chose à vérifier : est-ce que tes routeurs ont bien établi des voisinages ?

```cisco
R1# show ip ospf neighbor

Neighbor ID     Pri   State           Dead Time   Address         Interface
2.2.2.2           1   FULL/DR         00:00:35    10.0.0.2        GigabitEthernet0/1
3.3.3.3           1   FULL/DR         00:00:32    10.0.1.2        GigabitEthernet0/2
```

**Décryptage de la sortie :**
- **Neighbor ID** : le Router ID du voisin
- **Pri** : la priorité OSPF du voisin
- **State** : l'état de la relation de voisinage
  - `FULL/DR` : adjacence complète, le voisin est le DR
  - `FULL/BDR` : adjacence complète, le voisin est le BDR
  - `FULL/DROTHER` : adjacence complète, le voisin n'est ni DR ni BDR
  - `2WAY/DROTHER` : voisinage établi mais pas d'adjacence complète (normal entre deux DROther)
  - `INIT` : j'ai reçu un Hello mais je n'y suis pas mentionné → problème !
  - `DOWN` : pas de Hello reçu → voisin hors ligne ou problème de connectivité
- **Dead Time** : temps restant avant de déclarer le voisin mort
- **Address** : adresse IP du voisin sur le lien partagé
- **Interface** : l'interface locale par laquelle le voisin est joint

### 9.2 Vérifier la table de routage OSPF

```cisco
R1# show ip route ospf

      192.168.2.0/24 [110/2] via 10.0.0.2, 00:15:23, GigabitEthernet0/1
      192.168.3.0/24 [110/2] via 10.0.1.2, 00:12:45, GigabitEthernet0/2
```

**Décryptage :**
- `O` : route apprise via OSPF (tu peux le voir avec `show ip route`)
- `[110/2]` : `110` est la distance administrative d'OSPF (sa "crédibilité" par rapport aux autres protocoles), `2` est le coût OSPF total du chemin
- `via 10.0.0.2` : adresse du prochain saut (next-hop)
- `GigabitEthernet0/1` : interface de sortie

> 💡 **Distance administrative** : Quand un routeur a plusieurs protocoles de routage qui lui donnent des informations sur un même réseau, il utilise la **distance administrative** pour choisir lequel croire. Plus la valeur est basse, plus le protocole est "de confiance".
>
> | Source | Distance administrative |
> |---|---|
> | Interface directement connectée | 0 |
> | Route statique | 1 |
> | EIGRP | 90 |
> | **OSPF** | **110** |
> | RIP | 120 |

### 9.3 Vérifier la table de routage complète

```cisco
R1# show ip route

Codes: C - connected, S - static, R - RIP, O - OSPF, ...

      10.0.0.0/30 is subnetted, 2 subnets
C        10.0.0.0 is directly connected, GigabitEthernet0/1
C        10.0.1.0 is directly connected, GigabitEthernet0/2
C     192.168.1.0/24 is directly connected, GigabitEthernet0/0
O     192.168.2.0/24 [110/2] via 10.0.0.2, 00:15:23, GigabitEthernet0/1
O     192.168.3.0/24 [110/2] via 10.0.1.2, 00:12:45, GigabitEthernet0/2
```

Si tu vois les réseaux `192.168.2.0/24` et `192.168.3.0/24` avec un `O` devant, félicitations ! OSPF fonctionne correctement ! 🎉

### 9.4 Vérifier la base de données OSPF (LSDB)

```cisco
R1# show ip ospf database

            OSPF Router with ID (1.1.1.1) (Process ID 1)

                Router Link States (Area 0)

Link ID         ADV Router      Age         Seq#       Checksum Link count
1.1.1.1         1.1.1.1         234         0x80000005 0x00A1B2 4
2.2.2.2         2.2.2.2         198         0x80000004 0x00C3D4 2
3.3.3.3         3.3.3.3         167         0x80000003 0x00E5F6 2
```

Cette commande montre tous les LSA connus. Si les trois routeurs apparaissent, ça confirme que la LSDB est bien synchronisée.

### 9.5 Vérifier les informations OSPF d'une interface

```cisco
R1# show ip ospf interface GigabitEthernet 0/1

GigabitEthernet0/1 is up, line protocol is up
  Internet Address 10.0.0.1/30, Area 0, Attached via Network Statement
  Process ID 1, Router ID 1.1.1.1, Network Type POINT_TO_POINT, Cost: 10
  Transmit Delay is 1 sec, State POINT_TO_POINT
  Timer intervals configured, Hello 10, Dead 40, Wait 40, Retransmit 5
    oob-resync timeout 40
    Hello due in 00:00:06
  Supports Link-local Signaling (LLS)
  Cisco NSF helper support enabled
  IETF NSF helper support enabled
  Index 1/2, flood queue length 0
  Next 0x0(0)/0x0(0)
  Last flood scan length is 1, maximum is 1
  Last flood scan time is 0 msec, maximum is 0 msec
  Neighbor Count is 1, Adjacent neighbor count is 1
    Adjacent with neighbor 2.2.2.2
  Suppress hello for 0 neighbor(s)
```

Cette commande donne plein d'informations utiles : le coût de l'interface, les timers Hello/Dead, le type de réseau, et les voisins adjacents.

### 9.6 Vérifier les paramètres OSPF globaux

```cisco
R1# show ip ospf

 Routing Process "ospf 1" with ID 1.1.1.1
 Start time: 00:01:23.456, Time elapsed: 00:30:45.123
 Supports only single TOS(TOS0) routes
 Supports opaque LSA
 Supports Link-local Signaling (LLS)
 Supports area transit capability
 Router is not originating router-LSAs with maximum metric
 Initial SPF schedule delay 5000 msecs
 Minimum hold time between two consecutive SPFs 10000 msecs
 Maximum wait time between two consecutive SPFs 10000 msecs
 Incremental-SPF disabled
 Minimum LSA interval 5 secs
 Minimum LSA arrival 1000 msecs
 LSA group pacing timer 240 secs
 Interface flood pacing timer 33 msecs
 Retransmission pacing timer 66 msecs
 Number of external LSA 0. Checksum Sum 0x000000
 Number of opaque AS LSA 0. Checksum Sum 0x000000
 Number of DCbitless external and opaque AS LSA 0
 Number of DoNotAge external and opaque AS LSA 0
 Number of areas in this router is 1. 1 normal 0 stub 0 nssa
 Number of areas transit capable is 0
 External flood list length 0
 IETF NSF helper support enabled
 Cisco NSF helper support enabled
 Reference bandwidth unit is 10000 mbps
    Area BACKBONE(0)
        Number of interfaces in this area is 3
        Area has no authentication
        SPF algorithm last executed 00:01:15.234 ago
        SPF algorithm executed 5 times
        Area ranges are
        Number of LSA 3. Checksum Sum 0x01E4AC
        Number of opaque link LSA 0. Checksum Sum 0x000000
        Number of DCbitless LSA 0
        Number of indication LSA 0
        Number of DoNotAge LSA 0
        Flood list length 0
```

### 9.7 Tester la connectivité end-to-end

La vraie preuve que tout fonctionne, c'est de pouvoir pinguer d'un PC à l'autre !

**Depuis le PC Linux :**
```bash
# Configurer l'adresse IP et la passerelle par défaut
sudo ip addr add 192.168.1.10/24 dev eth0
sudo ip route add default via 192.168.1.1

# Pinger le PC Windows
ping 192.168.2.10

# Faire un traceroute pour voir le chemin
traceroute 192.168.2.10
```

**Depuis le PC Windows :**
```cmd
# La passerelle par défaut doit être configurée à 192.168.2.1
ping 192.168.1.10

# Traceroute sur Windows
tracert 192.168.1.10
```

Si le ping fonctionne, c'est que les paquets traversent bien les routeurs R1 et R2, guidés par OSPF. Bravo ! 🏆

### 9.8 Analyser les détails de voisinage

Pour un diagnostic plus poussé, la version `detail` de la commande voisinage est très utile :

```cisco
R1# show ip ospf neighbor detail

 Neighbor 2.2.2.2, interface address 10.0.0.2
    In the area 0 via interface GigabitEthernet0/1
    Neighbor priority is 1, State is FULL, 6 state changes
    DR is 10.0.0.2  BDR is 10.0.0.1
    Options is 0x12 in Hello (E-bit, L-bit)
    Options is 0x52 in DBD  (E-bit, L-bit, O-bit)
    Dead timer due in 00:00:33
    Neighbor is up for 00:45:12
    Index 1/1/1, retransmission queue length 0, number of retransmission 0
    First 0x0(0)/0x0(0)/0x0(0) Next 0x0(0)/0x0(0)/0x0(0)
    Last retransmission scan length is 0, maximum is 0
    Last retransmission scan time is 0 msec, maximum is 0 msec
```

Cette sortie te donne des informations précieuses comme :
- **State is FULL** : l'adjacence est complète ✅
- **6 state changes** : le voisinage a changé d'état 6 fois (souvent signe d'instabilité si ce chiffre monte vite)
- **Neighbor is up for 00:45:12** : depuis combien de temps le voisinage est établi
- **Dead timer due in 00:00:33** : le compte à rebours avant de considérer ce voisin comme mort (se reset à chaque Hello reçu)

### 9.9 Vérifier le processus d'élection DR/BDR

```cisco
R1# show ip ospf interface GigabitEthernet 0/0

GigabitEthernet0/0 is up, line protocol is up
  Internet Address 192.168.1.1/24, Area 0, Attached via Network Statement
  Process ID 1, Router ID 1.1.1.1, Network Type BROADCAST, Cost: 10
  Transmit Delay is 1 sec, State DR, Priority 1
  Designated Router (ID) 1.1.1.1, Interface address 192.168.1.1
  No backup designated router on this subnet
  Timer intervals configured, Hello 10, Dead 40, Wait 40, Retransmit 5
```

Ici, on voit que R1 est le **DR** sur le réseau `192.168.1.0/24` (son interface LAN). Comme il est le seul routeur OSPF sur ce segment, il n'y a pas de BDR.

### 9.10 Utiliser ping et traceroute pour valider le routage

```cisco
! Depuis R1, pinger le LAN de R2
R1# ping 192.168.2.1 source 192.168.1.1

Type escape sequence to abort.
Sending 5, 100-byte ICMP Echos to 192.168.2.1, timeout is 2 seconds:
Packet sent with a source address of 192.168.1.1
!!!!!
Success rate is 100 percent (5/5), round-trip min/avg/max = 1/2/4 ms
```

Les `!` représentent des pings réussis. Des `.` représentent des timeouts.

```cisco
! Faire un traceroute pour voir le chemin emprunté
R1# traceroute 192.168.3.1

Type escape sequence to abort.
Tracing the route to 192.168.3.1
VRF info: (vrf in name/id, vrf out name/id)
  1 10.0.1.2 2 msec 1 msec 2 msec
```

Cela confirme que pour atteindre `192.168.3.0/24`, R1 passe directement par R3 (`10.0.1.2`). OSPF a bien calculé le chemin optimal. 🎯

---

## 10. Cas pratiques et scénarios avancés

### 10.1 Influencer l'élection DR/BDR

Parfois, tu veux contrôler quel routeur devient DR (par exemple, parce qu'un routeur est plus puissant que les autres). Voici comment faire :

```cisco
! Augmenter la priorité d'une interface pour favoriser ce routeur comme DR
R1(config)# interface GigabitEthernet 0/0
R1(config-if)# ip ospf priority 100
! Valeur par défaut : 1. Plus c'est élevé, plus le routeur a de chances de devenir DR.

! Empêcher un routeur de devenir DR ou BDR (priorité 0)
R2(config)# interface GigabitEthernet 0/1
R2(config-if)# ip ospf priority 0
```

### 10.2 Changer les timers Hello et Dead

Sur des liens point-à-point ou des réseaux très stables, tu peux accélérer la convergence en réduisant les timers :

```cisco
! Réduire le Hello Interval à 5 secondes (et Dead Interval à 15 secondes)
R1(config)# interface GigabitEthernet 0/1
R1(config-if)# ip ospf hello-interval 5
R1(config-if)# ip ospf dead-interval 15
```

> ⚠️ **Important** : Les timers Hello et Dead doivent être **identiques** des deux côtés du lien. Sinon, les voisins ne se formeront pas !

### 10.3 Authentification OSPF

Pour sécuriser ton déploiement OSPF et éviter qu'un routeur non autorisé ne rejoigne ton réseau, configure l'authentification MD5 :

```cisco
! Sur R1, interface vers R2
R1(config)# interface GigabitEthernet 0/1
R1(config-if)# ip ospf authentication message-digest
R1(config-if)# ip ospf message-digest-key 1 md5 MotDePasseSecret

! Sur R2, interface vers R1 (doit utiliser la même clé)
R2(config)# interface GigabitEthernet 0/1
R2(config-if)# ip ospf authentication message-digest
R2(config-if)# ip ospf message-digest-key 1 md5 MotDePasseSecret
```

Sans la bonne clé, un routeur ne peut pas établir de voisinage OSPF. C'est une mesure de sécurité importante en production ! 🔐

### 10.4 Route de défaut et redistribution dans OSPF

Souvent, un des routeurs a accès à Internet (ou à un réseau externe). Pour que tous les autres routeurs sachent comment sortir du réseau interne, ce routeur peut **redistribuer une route par défaut** dans OSPF :

```cisco
! Sur R1 (qui a un accès Internet via une interface supplémentaire)
R1(config)# ip route 0.0.0.0 0.0.0.0 <adresse-du-FAI>  ! Route vers Internet
R1(config)# router ospf 1
R1(config-router)# default-information originate
```

La commande `default-information originate` dit à OSPF : *"Partage cette route par défaut avec tous les autres routeurs OSPF."*

Les autres routeurs auront alors une route `O*E2 0.0.0.0/0` dans leur table de routage, et tous leurs paquets vers l'inconnu passeront par R1. 

### 10.5 Modifier le coût d'une interface manuellement

Si tu veux forcer OSPF à préférer un chemin plutôt qu'un autre (indépendamment de la bande passante réelle), tu peux modifier le coût directement :

```cisco
! Forcer un coût de 50 sur cette interface
R1(config)# interface GigabitEthernet 0/1
R1(config-if)# ip ospf cost 50
```

Avec un coût plus élevé, OSPF préférera un autre chemin si disponible. C'est utile pour faire du **traffic engineering** — contrôler manuellement le flux de trafic sur ton réseau.

### 10.6 Simuler une panne et observer la convergence

C'est l'un des exercices les plus instructifs pour comprendre OSPF ! Voici comment simuler une panne de lien :

```cisco
! Couper le lien entre R1 et R2
R1(config)# interface GigabitEthernet 0/1
R1(config-if)# shutdown

! Observer les logs sur R1 (activer la journalisation dans la console)
R1# terminal monitor
! Tu devrais voir des messages comme :
! %OSPF-5-ADJCHG: Process 1, Nbr 2.2.2.2 on GigabitEthernet0/1 from FULL to DOWN
```

Observe combien de temps OSPF met à recalculer les routes. Sur un réseau simple comme le nôtre, ça devrait être quasi instantané ! C'est toute la puissance d'OSPF. 💨

Pour rétablir :
```cisco
R1(config)# interface GigabitEthernet 0/1
R1(config-if)# no shutdown
```

### 10.7 OSPF multi-area : une introduction

Pour les réseaux plus importants, une seule area peut devenir un problème. Imagine une entreprise avec 100 routeurs : chaque routeur devrait stocker et calculer la LSDB de tous ces routeurs ! C'est pour ça qu'OSPF supporte le concept de **multi-area**.

Dans un déploiement multi-area :
- L'**Area 0** (Backbone) est obligatoire et centrale.
- Toutes les autres areas doivent être connectées à l'Area 0.
- Les routeurs à la frontière de deux areas s'appellent des **ABR** (Area Border Routers).

Voici un exemple de topologie multi-area :

```
[Area 1]           [Area 0 - Backbone]          [Area 2]
R4 ─── ABR1 ────── R1 ──── R2 ──── ABR2 ─── R5
                    │
                   R3
```

**Configuration d'un ABR :**

```cisco
! Sur ABR1 (connecté à Area 0 et Area 1)
ABR1(config)# router ospf 1
ABR1(config-router)# router-id 10.10.10.10
ABR1(config-router)# auto-cost reference-bandwidth 10000

! Interface vers l'Area 1
ABR1(config-router)# network 172.16.1.0 0.0.0.255 area 1

! Interface vers l'Area 0
ABR1(config-router)# network 10.0.10.0 0.0.0.3 area 0
```

L'ABR va automatiquement générer des **LSA de Type 3** pour résumer les routes de l'Area 1 vers l'Area 0, et vice versa. Les routeurs dans l'Area 1 n'ont pas besoin de connaître la topologie interne de l'Area 0 — ils ont juste besoin de savoir comment y accéder via l'ABR. C'est le principe de l'**abstraction de topologie** qui rend OSPF si scalable.

### 10.8 Les Stub Areas : réduire encore plus la taille de la LSDB

Dans certaines areas "de périphérie" qui n'ont qu'un seul point d'entrée vers le backbone, les LSA externes (type 5) peuvent être remplacés par une simple route par défaut. C'est ce qu'on appelle une **Stub Area**.

```cisco
! Configurer une area stub (sur TOUS les routeurs de l'area, y compris l'ABR)
Router(config-router)# area 1 stub
```

Pour une optimisation encore plus poussée, il existe les **Totally Stub Areas** (extension Cisco) et les **NSSA** (Not-So-Stubby Area), mais ces concepts avancés mériteraient un tutoriel à eux seuls. 😊

### 10.9 Résumé de routes OSPF (Summarization)

L'un des grands avantages d'OSPF multi-area est la possibilité de **résumer les routes**. Plutôt que d'annoncer 10 réseaux /24 individuellement, un ABR peut les résumer en un seul réseau plus grand.

```cisco
! Sur l'ABR, résumer les réseaux 10.1.0.0/24 à 10.1.15.0/24
! en un seul réseau 10.1.0.0/20 vers le backbone
ABR(config-router)# area 1 range 10.1.0.0 255.255.240.0
```

Les bénéfices du résumé de routes :
- Tables de routage plus petites sur tous les routeurs
- Moins de recalculs SPF en cas de changement dans une area
- Convergence plus rapide globalement

---

## 11. Les erreurs classiques et comment les éviter

Après des années à configurer des réseaux, voici les erreurs les plus fréquentes que j'ai rencontrées (et commises 😅). Apprends de ces erreurs pour ne pas les reproduire !

### Erreur #1 : Les voisins ne se forment pas

**Symptôme** : `show ip ospf neighbor` ne montre aucun voisin.

**Causes possibles et solutions :**

1. **Les interfaces ne sont pas dans le même sous-réseau**
   ```cisco
   ! Vérifier les adresses IP
   R1# show ip interface brief
   ```

2. **Les timers ne correspondent pas**
   ```cisco
   ! Vérifier les timers sur l'interface
   R1# show ip ospf interface GigabitEthernet 0/1
   ! Comparer avec le voisin
   ```

3. **L'Area ID ne correspond pas**
   ```cisco
   ! Vérifier l'area configurée
   R1# show ip ospf interface GigabitEthernet 0/1
   ```

4. **Les interfaces ne sont pas déclarées dans OSPF**
   ```cisco
   ! Vérifier la configuration OSPF
   R1# show running-config | section ospf
   ```

5. **Un pare-feu bloque les paquets OSPF**
   - OSPF utilise le protocole IP numéro 89. S'assurer qu'il n'est pas filtré.

### Erreur #2 : Les routes OSPF n'apparaissent pas dans la table de routage

**Symptôme** : Les voisins sont formés (état FULL), mais `show ip route ospf` ne montre rien.

**Cause possible** : Le réseau n'a pas été correctement déclaré dans la commande `network`.

```cisco
! Vérifier les réseaux déclarés dans OSPF
R1# show ip ospf database
! Si le réseau n'y apparaît pas, c'est que la commande network est incorrecte

! Vérifier la configuration OSPF
R1# show running-config | section router ospf
```

**Solution** : Corriger la commande `network` en vérifiant l'adresse réseau et le wildcard mask.

### Erreur #3 : OSPF instable (voisins qui flappent)

**Symptôme** : Les voisins alternent entre UP et DOWN constamment. Tu vois des logs du type `%OSPF-5-ADJCHG: ... from FULL to DOWN`.

**Causes possibles :**
- Lien physique instable
- Timers trop agressifs
- MTU incompatible entre les deux routeurs

```cisco
! Vérifier le MTU
R1# show interface GigabitEthernet 0/1 | include MTU
! Si les MTU ne correspondent pas :
R1(config-if)# ip ospf mtu-ignore
! (Solution de contournement — mieux vaut harmoniser les MTU)
```

### Erreur #4 : Routes sous-optimales

**Symptôme** : OSPF choisit un chemin sous-optimal (par exemple, il passe par un lien 100 Mbps au lieu d'un lien 1 Gbps).

**Cause** : La bande passante de référence n'a pas été modifiée, donc FastEthernet et GigabitEthernet ont le même coût.

**Solution** : S'assurer que `auto-cost reference-bandwidth 10000` est configuré sur **tous** les routeurs OSPF. Si c'est configuré sur un seul, ça peut créer des asymétries de routage ! ⚠️

### Erreur #5 : Oublier `no shutdown` sur les interfaces

C'est bête, mais c'est une erreur très courante pour les débutants (et parfois même pour les expérimentés 😂). N'oublie jamais d'activer les interfaces avec `no shutdown` !

```cisco
! Vérifier l'état de toutes les interfaces
R1# show ip interface brief

Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet0/0     192.168.1.1     YES manual up                    up
GigabitEthernet0/1     10.0.0.1        YES manual up                    up
GigabitEthernet0/2     10.0.1.1        YES manual administratively down down
                                                                ↑↑↑↑↑
                                                    Oups ! Interface éteinte !
```

### Erreur #6 : Router ID dupliqué

Si deux routeurs ont le même Router ID, OSPF se comporte de manière imprévisible.

```cisco
! Vérifier les Router IDs de tous les voisins
R1# show ip ospf neighbor
! Si deux routeurs ont le même RID, configurer manuellement des IDs uniques
R1(config)# router ospf 1
R1(config-router)# router-id 1.1.1.1

! Après avoir changé le RID, redémarrer le processus OSPF
R1# clear ip ospf process
```

---

## 12. Cheat Sheet : Toutes les commandes OSPF en un coup d'œil

Voici un récapitulatif de toutes les commandes importantes vues dans ce tutoriel. Imprime-le, garde-le à portée de main ! 📋

### Commandes de configuration

| Commande | Description |
|---|---|
| `router ospf <process-id>` | Activer OSPF |
| `router-id <A.B.C.D>` | Définir le Router ID manuellement |
| `network <réseau> <wildcard> area <id>` | Déclarer un réseau dans OSPF |
| `passive-interface <interface>` | Désactiver les Hello sur une interface |
| `passive-interface default` | Désactiver les Hello sur toutes les interfaces |
| `no passive-interface <interface>` | Réactiver les Hello sur une interface spécifique |
| `auto-cost reference-bandwidth <Mbps>` | Modifier la bande passante de référence |
| `ip ospf cost <valeur>` | Modifier le coût d'une interface (mode if) |
| `ip ospf priority <0-255>` | Modifier la priorité DR/BDR (mode if) |
| `ip ospf hello-interval <sec>` | Modifier le Hello Interval (mode if) |
| `ip ospf dead-interval <sec>` | Modifier le Dead Interval (mode if) |
| `ip ospf network point-to-point` | Forcer le type de réseau point-à-point (mode if) |
| `ip ospf authentication message-digest` | Activer l'authentification MD5 (mode if) |
| `ip ospf message-digest-key <id> md5 <clé>` | Configurer la clé MD5 (mode if) |
| `default-information originate` | Redistribuer la route par défaut dans OSPF |
| `area <id> stub` | Configurer une Stub Area |
| `area <id> range <réseau> <masque>` | Configurer le résumé de routes sur un ABR |

### Commandes de vérification

| Commande | Description |
|---|---|
| `show ip ospf neighbor` | Afficher les voisins OSPF |
| `show ip ospf neighbor detail` | Afficher les détails des voisins |
| `show ip route ospf` | Afficher les routes OSPF dans la table de routage |
| `show ip route` | Afficher toute la table de routage |
| `show ip ospf` | Afficher les informations globales OSPF |
| `show ip ospf interface` | Afficher les infos OSPF de toutes les interfaces |
| `show ip ospf interface <interface>` | Afficher les infos OSPF d'une interface spécifique |
| `show ip ospf database` | Afficher la LSDB complète |
| `show ip ospf database router` | Afficher uniquement les Router LSA (Type 1) |
| `show ip ospf database network` | Afficher uniquement les Network LSA (Type 2) |
| `show ip ospf database summary` | Afficher uniquement les Summary LSA (Type 3) |
| `show running-config | section ospf` | Afficher la configuration OSPF |
| `show ip interface brief` | Afficher l'état de toutes les interfaces |

### Commandes de débogage et maintenance

| Commande | Description |
|---|---|
| `debug ip ospf events` | Activer le debug des événements OSPF |
| `debug ip ospf adj` | Activer le debug des adjacences OSPF |
| `no debug all` | Désactiver tous les debugs |
| `clear ip ospf process` | Redémarrer le processus OSPF (⚠️ à utiliser avec précaution en prod !) |
| `clear ip ospf neighbor` | Effacer toutes les relations de voisinage |

> ⚠️ **Attention avec `debug`** : Les commandes `debug` génèrent beaucoup de messages et peuvent surcharger le CPU d'un routeur en production. Utilise-les avec parcimonie et n'oublie jamais de les désactiver avec `no debug all` une fois ton diagnostic terminé !

---

## 13. Flowchart de dépannage OSPF

Quand quelque chose ne va pas, voici la démarche logique à suivre pour diagnostiquer ton problème OSPF :

```
1. Les interfaces sont-elles UP/UP ?
   → show ip interface brief
   ├── NON → Vérifier les câbles, les ports, faire "no shutdown"
   └── OUI → Continuer

2. Les voisins se forment-ils ?
   → show ip ospf neighbor
   ├── État DOWN → Les deux routeurs sont-ils sur le même sous-réseau ?
   │              Les interfaces sont-elles dans la commande "network" ?
   ├── État INIT → Problème de communication unidirectionnelle (vérifier ACL, pare-feu)
   ├── État 2-WAY → Normal pour les DROther, sinon vérifier DR/BDR
   ├── État EXSTART/EXCHANGE → Problème de MTU ? Vérifier "ip ospf mtu-ignore"
   └── État FULL → ✅ Les voisins sont OK, continuer

3. Les routes apparaissent-elles dans la table de routage ?
   → show ip route ospf
   ├── NON → Vérifier la commande "network" sur le routeur distant
   │         Vérifier que l'interface n'est pas en "passive-interface"
   └── OUI → ✅ Les routes sont OK, continuer

4. La connectivité end-to-end fonctionne-t-elle ?
   → ping <destination>
   ├── NON → Vérifier les passerelles par défaut sur les PC
   │         Faire un traceroute pour identifier où ça bloque
   └── OUI → ✅ Tout fonctionne !
```

---

## 14. Conclusion

Félicitations, tu es arrivé jusqu'au bout de ce tutoriel ! 🎊🎉 C'est un sacré morceau, j'en suis conscient, mais si tu as lu jusqu'ici, tu as maintenant une compréhension solide d'OSPF — bien au-delà de ce que beaucoup d'administrateurs réseau savent réellement sur le protocole. Sois fier de toi ! 💪

### Ce qu'on a appris ensemble

**Sur les fondamentaux :**
- OSPF est un protocole de routage dynamique open source, fiable et scalable, largement utilisé dans les réseaux d'entreprise.
- Il appartient à la famille des protocoles à état de lien (Link-State), ce qui lui confère une vision globale du réseau et une convergence rapide.
- Il fonctionne en construisant une carte complète du réseau (LSDB) grâce aux LSA, puis en calculant les meilleurs chemins via l'algorithme de Dijkstra.

**Sur les concepts clés :**
- Le **Router ID** identifie chaque routeur de manière unique.
- Les **Hello packets** permettent la découverte et le maintien des voisinages.
- Le **DR et le BDR** optimisent les échanges sur les réseaux Ethernet.
- Le **coût** (basé sur la bande passante) détermine les chemins préférés.
- Les **areas** permettent de scaler OSPF sur de très grands réseaux.

**Sur la pratique :**
- La configuration de base sur Cisco est accessible : `router ospf`, `router-id`, `network`.
- Les bonnes pratiques incluent : configurer le Router ID manuellement, utiliser `passive-interface`, ajuster la bande passante de référence, activer l'authentification.
- Les outils de vérification (`show ip ospf neighbor`, `show ip route ospf`, etc.) sont indispensables pour valider et déboguer.

### La philosophie du réseau

J'aimerais te laisser avec quelque chose d'important. Le réseau, comme beaucoup de disciplines techniques, s'apprend vraiment en **pratiquant**. La théorie, c'est indispensable pour comprendre ce qui se passe, mais c'est en configurant, en cassant des choses et en les réparant qu'on forge une véritable compréhension.

N'aie pas peur de monter un petit lab chez toi — avec du matériel Cisco d'occasion qu'on peut trouver pour pas cher sur eBay ou des simulateurs comme **Cisco Packet Tracer** (gratuit avec un compte NetAcad) ou **GNS3** (open source). Ces outils sont extraordinairement puissants pour apprendre sans risquer de casser un réseau de production. 😄

### Pour aller plus loin

Une fois OSPF maîtrisé, voici les prochaines étapes naturelles dans ton apprentissage du réseau :

- **OSPFv3** : la version d'OSPF pour IPv6 — le même concept, adapté au protocole internet de demain.
- **BGP** (Border Gateway Protocol) : le protocole de routage d'Internet lui-même, utilisé entre les opérateurs télécoms. Fascinant et complexe.
- **Les VLANs et le protocole STP** (Spanning Tree Protocol) : pour comprendre comment les switches évitent les boucles réseau.
- **MPLS** : une technologie de routage avancée utilisée dans les backbones des opérateurs.
- **La redistribution de routes** : comment faire cohabiter OSPF avec d'autres protocoles (EIGRP, BGP, routes statiques).

Si tu as des questions, des retours, ou si tu as repéré une erreur dans ce tutoriel, n'hésite vraiment pas à laisser un commentaire. Je serai toujours heureux d'en discuter, et vos retours m'aident à améliorer mes futurs articles ! 🙏🙏

À très bientôt pour le prochain article. Prenez soin de vous, continuez à apprendre, et souvenez-vous : chaque grand expert réseau a un jour tapé sa première commande `ping` en se demandant ce qu'il se passait. 😉

---

*Ce tutoriel a été rédigé avec ❤️ pour tous ceux qui veulent se lancer dans l'administration réseau. Keep learning, keep growing! 🚀*

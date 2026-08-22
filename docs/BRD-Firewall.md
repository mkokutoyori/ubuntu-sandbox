# BRD — Module Pare-feu (Firewall)

> Socle générique d'un pare-feu à états, décliné ensuite en pare-feu
> constructeur (Cisco ASA/FTD, Fortinet FortiOS, Palo Alto PAN-OS,
> Juniper SRX). Ce document définit **ce qu'est un pare-feu dans ce
> simulateur** avant de définir ce qu'en dit chaque constructeur.

| | |
|---|---|
| **Document** | BRD — Business Requirements Document |
| **Module** | `src/network/devices/firewall/` (à créer) |
| **Statut** | Proposition — non implémenté |
| **Branche** | `mandeng` |
| **Périmètre** | Socle générique + contrat de déclinaison vendeur |
| **Documents liés** | `PRD-Port-Forwarding.md`, `PRD-Iptables-UFW.md`, `PRD-NAT-Port-Forwarding.md`, `PRD-Pannes.md`, `PRD-Routage-Fidelite.md` |

---

## Table des matières

### Partie I — Cadrage

1. [Contexte et motivation](#1-contexte-et-motivation)
2. [Objectifs et non-objectifs](#2-objectifs-et-non-objectifs)
3. [Terminologie](#3-terminologie)
4. [Inventaire de l'existant](#4-inventaire-de-lexistant)
5. [Personas et cas d'usage pédagogiques](#5-personas-et-cas-dusage-pédagogiques)
6. [Principes directeurs](#6-principes-directeurs)

### Partie II — Le modèle générique

7. [Vue d'ensemble de l'architecture](#7-vue-densemble-de-larchitecture)
8. [Le modèle d'objets](#8-le-modèle-dobjets)
9. [Les zones de sécurité](#9-les-zones-de-sécurité)
10. [Le moteur de sessions](#10-le-moteur-de-sessions)
11. [Le moteur de politique](#11-le-moteur-de-politique)
12. [Le moteur NAT](#12-le-moteur-nat)
13. [Le pipeline de traitement du paquet](#13-le-pipeline-de-traitement-du-paquet)
14. [Modes de déploiement](#14-modes-de-déploiement)
15. [Inspection applicative et ALG](#15-inspection-applicative-et-alg)
16. [Identification NGFW](#16-identification-ngfw)
17. [Profils de sécurité](#17-profils-de-sécurité)
18. [Protection contre les attaques volumétriques](#18-protection-contre-les-attaques-volumétriques)
19. [Routage sur pare-feu](#19-routage-sur-pare-feu)
20. [VPN](#20-vpn)
21. [Haute disponibilité](#21-haute-disponibilité)
22. [Virtualisation](#22-virtualisation)
23. [Journalisation et observabilité](#23-journalisation-et-observabilité)
24. [Plan de gestion](#24-plan-de-gestion)
25. [Qualité de service](#25-qualité-de-service)

### Partie III — Les déclinaisons constructeur

26. [Le contrat de déclinaison vendeur](#26-le-contrat-de-déclinaison-vendeur)
27. [Cisco ASA et FTD](#27-cisco-asa-et-ftd)
28. [Fortinet FortiOS](#28-fortinet-fortios)
29. [Palo Alto PAN-OS](#29-palo-alto-pan-os)
30. [Juniper SRX](#30-juniper-srx)
31. [Matrice de correspondance inter-vendeurs](#31-matrice-de-correspondance-inter-vendeurs)

### Partie IV — Exigences

32. [Exigences fonctionnelles](#32-exigences-fonctionnelles)
33. [Exigences non fonctionnelles](#33-exigences-non-fonctionnelles)
34. [Exigences UI/UX](#34-exigences-uiux)
35. [Exigences de persistance](#35-exigences-de-persistance)

### Partie V — Réalisation

36. [Architecture technique cible](#36-architecture-technique-cible)
37. [Modèle de données](#37-modèle-de-données)
38. [Points d'extension](#38-points-dextension)
39. [Découpage en phases](#39-découpage-en-phases)
40. [Stratégie de test](#40-stratégie-de-test)
41. [Critères d'acceptation](#41-critères-dacceptation)
42. [Risques et arbitrages](#42-risques-et-arbitrages)
43. [Hors périmètre](#43-hors-périmètre)
44. [Annexes](#44-annexes)

---

# Partie I — Cadrage

---

## 1. Contexte et motivation

### 1.1 Le constat de départ

Ce simulateur propose aujourd'hui trois types d'équipement pare-feu dans sa
palette : `firewall-cisco`, `firewall-fortinet`, `firewall-paloalto`. Les
trois sont, littéralement, des postes Linux :

```ts
case 'firewall-cisco':
  return new LinuxPC('firewall-cisco', name, x, y);
case 'firewall-fortinet':
  return new LinuxPC('firewall-fortinet', name, x, y);
case 'firewall-paloalto':
  return new LinuxPC('firewall-paloalto', name, x, y);
```
*(`src/network/devices/DeviceFactory.ts`, lignes 63-68)*

Rien dans le moteur ne lit la chaîne `deviceType` au-delà du préfixe de nom
d'hôte et de l'icône de palette. Un apprenant qui dépose un « pare-feu Palo
Alto » sur le canevas obtient un poste Ubuntu avec un shell bash. Il n'y a
ni CLI ASA, ni CLI FortiOS, ni CLI PAN-OS ; ni notion de zone, ni notion de
niveau de sécurité, ni table de sessions consultable, ni politique de
sécurité au sens où l'entend un pare-feu.

Le dépôt est honnête à ce sujet — `DevicePalette.tsx` affiche un bandeau
ambre « Limited simulation » pour exactement ces trois types, via
`isFullyImplemented()`. Le présent document existe pour refermer l'écart
que ce bandeau signale.

### 1.2 Ce que l'écart coûte pédagogiquement

Un pare-feu n'est pas un routeur avec des ACL. La différence n'est pas de
degré mais de **nature**, et c'est précisément cette différence qui doit
être enseignée :

| Le routeur décide | Le pare-feu décide |
|---|---|
| paquet par paquet | flux par flux (session) |
| sur une liste liée à une interface | sur une politique liée à des zones |
| sans mémoire du retour | en installant le retour à l'aller |
| en autorisant par défaut | en refusant par défaut |
| sans notion d'application | avec identification applicative |
| sans notion d'utilisateur | avec identification d'utilisateur |

Un simulateur qui n'offre que la première colonne enseigne un modèle mental
faux. L'apprenant qui écrit une ACL de retour à la main sur un routeur — ce
qui est correct sur un routeur — reproduira ce réflexe sur un pare-feu, où
c'est au mieux inutile, au pire une faille : une règle de retour permanente
est exactement ce que l'inspection à états rend inutile, et exactement ce
qu'un attaquant cherche.

### 1.3 Trois symptômes représentatifs

**Symptôme 1 — la session n'existe pas.** `LinuxIptablesManager` porte une
table de suivi de connexions (`conntrack`, `Map<string, number>`) et sait
répondre `ESTABLISHED`. Mais elle est indexée par direction et ne porte
qu'un horodatage : pas d'état TCP, pas de compteur d'octets, pas de durée,
pas d'identifiant de session, pas d'interface d'entrée mémorisée. Aucune
commande ne peut donc répondre à la question centrale du diagnostic pare-feu :
*« montre-moi cette connexion ».* `show conn`, `get system session list`,
`show session all`, `show security flow session` n'ont aujourd'hui aucun
équivalent, et ne pourraient pas en avoir sans une vraie table de sessions.

**Symptôme 2 — la politique n'existe pas.** `ACLEngine` (460 lignes) évalue
de vraies ACL Cisco, riches (DSCP, précédence, flags TCP, `established`,
plages de ports, ICMP typé). Mais une ACL est liée à une *interface* et à
une *direction*, jamais à un couple de zones ; elle n'a pas de champ
`service`, pas de champ `application`, pas d'horaire, pas de profil, pas de
compteur d'octets. Le concept « règle de sécurité » au sens ASA/FortiOS/PAN-OS
n'a aucun porteur dans le code.

**Symptôme 3 — le pipeline n'est pas celui d'un pare-feu.** `Router.processIPv4()`
suit l'ordre : contrôles d'en-tête → ACL entrante → NAT entrant → décision
de routage → NAT sortant → ACL sortante. C'est l'ordre d'IOS, et il est
correct pour IOS. Aucun des quatre constructeurs visés n'utilise cet ordre.
L'ASA cherche d'abord une connexion existante ; PAN-OS branche entre
*fastpath* et *slowpath* ; FortiOS fait le DNAT **avant** le routage
précisément pour pouvoir router ; SRX crée une session au premier paquet et
tout le reste du flux la suit. Ces ordres ne sont pas des détails
d'implémentation : ils sont ce qu'on enseigne sous le nom de *packet flow*,
et ils sont la première chose qu'on demande en entretien d'embauche
sécurité.

### 1.4 Pourquoi un socle générique d'abord

La tentation naturelle serait d'écrire directement « le pare-feu Cisco ASA »,
puis « le pare-feu FortiGate », puis « le pare-feu Palo Alto ». Ce dépôt a
déjà payé la facture de cette approche à plusieurs reprises, et son
`CLAUDE.md` en garde la trace : deux registres Windows pour une machine,
deux piles SSH qui n'interopèrent pas, deux magasins de configuration SSH
sur un routeur qui se contredisaient à la même seconde, deux rendus de
`flash:` dont un aveugle aux écritures. À chaque fois le symptôme est le
même : **deux réponses possibles à une seule question**.

Trois pare-feux écrits séparément produiraient trois tables de sessions,
trois moteurs NAT, trois notions de zone et trois pipelines. Le jour où l'on
corrige un défaut de suivi TCP, on le corrige une fois sur trois. Le socle
générique n'est donc pas un raffinement d'architecte : c'est la condition
pour que la troisième déclinaison coûte moins cher que la première.

La stratégie inverse — un socle si abstrait qu'aucun constructeur ne s'y
reconnaît — est le risque symétrique. Le socle proposé ici est donc dérivé
**par mesure** : chaque concept générique est présent chez au moins trois
des quatre constructeurs étudiés, et chaque divergence connue est nommée et
attribuée à la couche vendeur plutôt que gommée.

### 1.5 Ce que ce BRD n'est pas

- Ce n'est pas un document d'implémentation ligne à ligne. Il définit les
  contrats, les invariants et les points d'extension ; les PRD de phase
  détailleront chaque livraison.
- Ce n'est pas un cahier des charges de produit commercial. On ne cherche
  pas la parité fonctionnelle avec un FortiGate 600F, on cherche la fidélité
  **pédagogique** : ce que l'apprenant tape doit produire ce qu'il
  produirait sur la vraie machine, et ce qui n'est pas simulé doit être
  refusé explicitement plutôt qu'accepté en silence.
- Ce n'est pas un document sur la détection de menaces. L'antivirus,
  l'IPS par signatures et le filtrage d'URL par catégories sont traités
  comme des **cadres** (points d'accroche, verdicts, journaux) et non comme
  des moteurs de détection réels. Un simulateur qui prétendrait détecter un
  vrai maliciel mentirait.

---

## 2. Objectifs et non-objectifs

### 2.1 Objectifs métier

| # | Objectif | Mesure de succès |
|---|---|---|
| **O1** | Enseigner l'inspection à états | L'apprenant monte une politique qui n'autorise que l'aller, et le retour passe — parce que la session existe, pas parce qu'une règle l'autorise |
| **O2** | Enseigner le modèle en zones | Une interface déplacée d'une zone à l'autre change la politique appliquée, sans qu'aucune règle ne soit modifiée |
| **O3** | Enseigner le *packet flow* | Chaque déclinaison vendeur suit **son** ordre d'opérations, et cet ordre est observable (compteurs, journaux, table de sessions) |
| **O4** | Enseigner le diagnostic | `show conn` / `get system session list` / `show session` / `show security flow session` rendent une mesure, jamais un texte fabriqué |
| **O5** | Enseigner le NAT de pare-feu | NAT statique, dynamique, PAT, NAT de destination, *hairpin*, dans l'ordre correct par rapport à la politique |
| **O6** | Rendre les déclinaisons peu coûteuses | La 2ᵉ et la 3ᵉ déclinaison vendeur ne réécrivent aucun moteur — uniquement grammaire CLI, rendus et spécificités déclarées |
| **O7** | Rendre les limites lisibles | Toute commande non simulée est refusée avec un message qui nomme ce qui manque, jamais acceptée sans effet |

### 2.2 Objectifs techniques

| # | Objectif |
|---|---|
| **T1** | Un seul moteur de sessions pour tous les vendeurs |
| **T2** | Un seul moteur de politique, paramétré par un profil vendeur |
| **T3** | Un seul moteur NAT de pare-feu, distinct de `router/NATEngine.ts` **ou** l'étendant — arbitrage tranché en §36.4 |
| **T4** | Un pipeline déclaratif : l'ordre des étapes est une **donnée** du profil vendeur, pas du code |
| **T5** | Réutilisation maximale de l'existant : `Port`, `Cable`, `TcpStack`, `FilterChain`, `EventBus`, `Scheduler`, `CommandTrie`, `ShellFactory` |
| **T6** | Aucune trame qui ne traverse le réseau simulé — règle absolue du dépôt |
| **T7** | Sérialisation complète dans `topologySerializer.ts` : une topologie rechargée doit retrouver sa politique **et** son comportement |

### 2.3 Non-objectifs explicites

| # | Non-objectif | Raison |
|---|---|---|
| **N1** | Détection réelle de maliciel / signatures IPS réelles | Aucun contenu réel ne circule ; un moteur de signatures sur une charge utile inventée n'enseignerait rien |
| **N2** | Déchiffrement TLS réel avec ré-signature à la volée | La pile TLS du dépôt est réelle mais les PEM sont du JSON armuré ; un proxy TLS complet est un chantier autonome |
| **N3** | Parité exhaustive de la CLI d'un constructeur | Objectif inatteignable et non pédagogique ; on vise les commandes des cursus (CCNA Security, NSE4, PCNSA, JNCIA-SEC) |
| **N4** | Interface graphique constructeur (ASDM, FortiGate GUI, Panorama) | Le simulateur enseigne la CLI ; une GUI constructeur serait un produit à part entière |
| **N5** | Performance de production (millions de sessions) | Cible : quelques milliers de sessions, suffisant pour tout laboratoire |
| **N6** | Clustering multi-nœuds au-delà de la paire HA | Les cursus visés s'arrêtent à la paire actif/passif et actif/actif |
| **N7** | Sandboxing / analyse comportementale (FortiSandbox, WildFire) | Hors du modèle : il n'y a pas de fichier réel à détoner |

### 2.4 Le critère d'arbitrage permanent

Quand une fonction ne peut pas être simulée fidèlement, trois issues sont
possibles, et l'ordre de préférence est fixé :

1. **La simuler pour de bon**, si la brique existe déjà dans le dépôt.
2. **La refuser explicitement**, en nommant la brique manquante.
3. **La stocker et la rendre sans effet** — uniquement si la perdre casserait
   le rechargement d'une topologie, et alors la limite doit être écrite dans
   le fichier concerné **et** dans le présent document.

Ce qui est proscrit sans exception : accepter une commande, l'afficher dans
la configuration, et ne rien faire — sans que rien ne le dise. C'est le
défaut que ce dépôt passe son temps à refermer ailleurs.

---

## 3. Terminologie

### 3.1 Vocabulaire du socle

| Terme | Définition retenue dans ce document |
|---|---|
| **Pare-feu** | Équipement L3/L4+ qui décide du sort d'un **flux** selon une politique, en mémorisant ce flux |
| **Session** *(flux, connexion)* | Enregistrement bidirectionnel identifiant un échange, créé au premier paquet, consulté par tous les suivants |
| **Flux directionnel** *(sub-flow)* | L'une des deux moitiés d'une session : client→serveur (c2s) ou serveur→client (s2c) |
| **Zone de sécurité** | Regroupement nommé d'interfaces partageant une posture de confiance |
| **Politique** *(rule base, policy)* | Liste ordonnée de règles évaluée de haut en bas, première correspondance gagnante |
| **Règle** | (critères de correspondance) → (action, journalisation, profils) |
| **Objet** | Valeur nommée réutilisable : adresse, plage, service, horaire, application |
| **Groupe d'objets** | Objet contenant d'autres objets du même type |
| **Verdict** | Décision terminale sur un paquet ou une session : `allow`, `deny`, `drop`, `reset` |
| **Inspection à états** | Le fait qu'un paquet de retour soit autorisé par l'existence de la session et non par une règle |
| **ALG** | *Application Layer Gateway* — module qui lit le protocole applicatif pour ouvrir un flux secondaire ou réécrire une adresse dans la charge utile |
| **Pinhole** | Ouverture temporaire créée par un ALG pour un flux secondaire attendu |
| **Chemin rapide** *(fastpath)* | Traitement d'un paquet appartenant à une session déjà installée |
| **Chemin lent** *(slowpath)* | Traitement du premier paquet d'un flux : recherche de zone, de route, de NAT, de politique, installation de session |
| **Mode routé** | Le pare-feu est un saut IP ; ses interfaces portent des adresses |
| **Mode transparent** | Le pare-feu est un pont L2 ; il filtre sans être un saut IP |
| **Virtual wire** | Paire d'interfaces soudées ; tout ce qui entre par l'une sort par l'autre, filtré, sans commutation ni routage |
| **Contexte virtuel** | Instance logique de pare-feu avec sa propre politique et souvent sa propre table de routage |

### 3.2 Vocabulaire divergent entre constructeurs

Le même concept porte quatre noms. La colonne « socle » est le nom retenu
dans le code ; les autres sont des **rendus**, jamais des structures
séparées.

| Socle | Cisco ASA | FortiOS | PAN-OS | Junos SRX |
|---|---|---|---|---|
| Zone | `nameif` + `security-level`, ou `zone` | `zone` / interface | `zone` | `security-zone` |
| Politique | `access-list` + `access-group` | `firewall policy` | `security rulebase` | `security policies` |
| Règle | ACE | `policy <id>` | `rule` | `policy <name>` |
| Objet adresse | `object network` | `firewall address` | `address` | `address-book entry` |
| Groupe d'adresses | `object-group network` | `addrgrp` | `address-group` | `address-set` |
| Objet service | `object service` | `firewall service custom` | `service` | `application` |
| Session | `connection` (`conn`) | `session` | `session` | `flow session` |
| Table de sessions | `show conn` | `get system session list` | `show session all` | `show security flow session` |
| NAT source | `nat (in,out) dynamic` | `firewall policy … nat enable` / `ippool` | `source NAT rule` | `source-nat` |
| NAT destination | `nat (out,in) static` | `vip` | `destination NAT rule` | `destination-nat` |
| Contexte virtuel | `security context` | `VDOM` | `vsys` | `logical-system` / `tenant` |
| HA | `failover` | `HA` (FGCP) | `HA` (HA1/HA2) | `chassis cluster` |
| Profil applicatif | `inspect` (MPF) | `security profile` (UTM) | `security profile group` | `application firewall` |
| Route par défaut | `route outside 0 0 <gw>` | `config router static` | `virtual router` | `routing-options static` |

### 3.3 Niveaux de sévérité des verdicts

| Verdict | Sémantique | Effet observable |
|---|---|---|
| `allow` | Le flux est autorisé | Le paquet poursuit le pipeline ; une session est installée |
| `deny` | Le flux est refusé silencieusement | Le paquet disparaît ; l'émetteur expire |
| `drop` | Synonyme de `deny` chez certains vendeurs | Idem — le socle traite `drop` comme un alias de `deny`, la couche vendeur choisit le mot rendu |
| `reset` | Le flux est refusé activement | TCP RST vers la source, et/ou vers la destination, selon le vendeur |
| `reject` | Refus avec message ICMP | ICMP administrativement interdit (type 3 code 13) |

La distinction `deny` / `reset` n'est pas cosmétique : elle est directement
observable par l'apprenant (un `telnet` qui expire au bout de 30 s contre un
`Connection refused` immédiat), et c'est le premier outil de diagnostic
« mon trafic est-il bloqué par le pare-feu ou perdu en route ? ».

---

## 4. Inventaire de l'existant

> Cette section est une **mesure** du dépôt à la date du document, pas une
> estimation. Chaque affirmation cite le fichier qui la porte.

### 4.1 Ce qui est déjà réel et directement réutilisable

#### 4.1.1 La couche physique et de transport — solide

| Brique | Fichier | État |
|---|---|---|
| Port physique | `hardware/Port.ts` | Réel : état, MTU, vitesse/duplex, compteurs, promiscuité, file |
| Câble | `hardware/Cable.ts` | Réel : perte, corruption, renégociation |
| Pile TCP | `tcp/TcpStack.ts` | Réelle : poignée de main, états, somme de contrôle, bouclage |
| UDP | `EndHost.sendUdpDatagram` + `tcp/types.ts` | Réel, somme de contrôle RFC 768 |
| Fragmentation IPv4 | `core/Ipv4Fragmentation.ts` | Réelle, RFC 791 §3.2 |
| Bus d'événements | `events/EventBus.ts` | Réel, pub/sub |
| Ordonnanceur | `events/Scheduler.ts` | Réel, minuteurs virtuels |

**Conséquence pour ce module** : le pare-feu n'a **rien** à réinventer sous
la couche 4. Il s'insère dans un chemin de données qui existe.

#### 4.1.2 Le moteur d'ACL Cisco — riche, mais pas une politique

`src/network/devices/router/ACLEngine.ts`, 460 lignes.

Ce qu'il sait faire, mesuré :

```ts
export interface ACLEntry {
  sequence?: number;
  action: 'permit' | 'deny';
  protocol?: string;
  srcIP: IPAddress;       srcWildcard: SubnetMask;
  dstIP?: IPAddress;      dstWildcard?: SubnetMask;
  srcPortSpec?: PortSpec; dstPortSpec?: PortSpec;
  icmpType?: string;      icmpCode?: number;
  tcpEstablished?: boolean;
  tcpFlags?: string[];
  dscp?: string; precedence?: string; tos?: string;
  log?: boolean; logInput?: boolean;
  timeRange?: string;
  reflect?: string; reflectTimeout?: number; evaluate?: string;
  fragments?: boolean;
  matchCount: number;
}
```

C'est une vraie ACE, avec opérateurs de port (`eq`/`neq`/`gt`/`lt`/`range`),
mots-clés DSCP et précédence complets, ICMP typé. Le compteur `matchCount`
est incrémenté pour de bon.

Ce qui lui manque **structurellement** pour être une politique de pare-feu :

| Manque | Conséquence |
|---|---|
| Pas de zone source/destination | Une ACE est liée à une interface, pas à un couple de zones |
| Pas de référence à un objet nommé | `object network WEB_SERVER` n'a pas de porteur |
| Pas de champ service nommé | `HTTP` doit être réécrit `eq 80` à chaque fois |
| Pas de champ application | Aucune place pour App-ID |
| Pas de champ utilisateur | Aucune place pour User-ID |
| Pas de compteur d'octets | Seulement un compteur de correspondances |
| Pas de profil attaché | Aucune place pour antivirus/IPS/filtrage web |
| `established` est un test de drapeaux TCP | Ce n'est **pas** de l'inspection à états |

Cette dernière ligne mérite d'être soulignée, parce qu'elle est le cœur du
sujet : `tcpEstablished` regarde les drapeaux du paquet courant. Un paquet
forgé avec ACK positionné passe. C'est exactement la faiblesse historique
des ACL réflexives, et c'est ce que l'inspection à états corrige.

#### 4.1.3 Le moteur NAT du routeur — le plus avancé du dépôt

`src/network/devices/router/NATEngine.ts`, 1165 lignes.

`NatSession` porte déjà un quadruplet complet :

```ts
export interface NatSession {
  protocol: number;
  localIP: string;    localPort: number;    // inside local
  globalIP: string;   globalPort: number;   // inside global
  outsideIP: string;  outsidePort: number;  // outside global
  outsideLocalIP?: string; outsideLocalPort?: number; // hairpin
  timestamp: number;
}
```

Les phases 1 à 6 de `PRD-Port-Forwarding.md` lui ont donné : la traduction
du retour pour les entrées statiques, le recalcul de la somme de contrôle
L4 (pseudo-en-tête RFC 793/768), le `hairpin` RFC 5382, le `clear` sélectif,
`ip nat outside source static`, et l'ordre correct NAT/ACL sur les deux
jambes.

**C'est la brique la plus proche de ce dont un pare-feu a besoin.** Elle
reste néanmoins une brique de *routeur* : la traduction y est déclenchée par
des règles liées à des interfaces `inside`/`outside`, et non par une
politique NAT ordonnée avec ses propres critères de correspondance. Le §36.4
tranche entre extension et moteur distinct.

#### 4.1.4 Le moteur netfilter Linux — la meilleure machinerie à états existante

`src/network/devices/linux/LinuxIptablesManager.ts`, 1527 lignes.

C'est, aujourd'hui, **le seul endroit du dépôt qui fait vraiment de
l'inspection à états**. Il porte :

- les quatre tables réelles (`filter`, `nat`, `mangle`, `raw`) et le
  parcours de chaînes ;
- une table de suivi (`conntrack: Map<string, number>`) indexée par
  direction, avec expiration ;
- les états `NEW` / `ESTABLISHED` / `RELATED` ;
- des compteurs réels (`conntrackStats.insert` / `found` / `invalid` /
  `drop`) incrémentés aux vrais points ;
- le masque de hooks réel de `xt_nat` (§`NAT_TARGET_HOOKS`), vérifié contre
  un vrai binaire `iptables` ;
- une porte de lecture, `conntrack -L` / `-S` / `-F`
  (`commands/net/Conntrack.ts`).

Ses limites, écrites dans son propre en-tête et confirmées par
`PRD-Port-Forwarding.md` phases 5-6 :

| Limite | Portée |
|---|---|
| Aucune machine à états TCP | La table ne connaît que `ESTABLISHED` et `[UNREPLIED]` |
| Pas de table de session de retour pour le NAT | Un DNAT vers un serveur distant délivre le SYN et le retour n'est jamais dé-NATé |
| Pas de crochet OUTPUT pour TCP | `TcpStack.transmit()` n'appelle aucun crochet pare-feu |
| Pas de compteur d'octets par flux | `conntrack -L` ne peut pas les afficher — ce qui est le défaut **réel** par défaut, `nf_conntrack_acct=0` |

**Conclusion de l'inventaire NAT/état** : le dépôt possède les *idées*
(suivi, états, hooks, verdicts) mais aucune d'elles n'est portée par une
structure qu'un pare-feu pourrait présenter à l'écran.

#### 4.1.5 La chaîne de filtres générique — le patron d'architecture déjà écrit

`src/network/core/FilterChain.ts`, 337 lignes.

```ts
export type FilterVerdict<T> =
  | ContinueVerdict | AcceptVerdict<T> | TransformVerdict<T>
  | DropVerdict | RejectVerdict;

export interface Filter<T> { name: string; apply(payload: T): FilterVerdict<T>; }

export class FilterChain<T> {
  add(filter: Filter<T>): this;
  addBefore(targetName: string, filter: Filter<T>): this;
  addAfter(targetName: string, filter: Filter<T>): this;
  remove(name: string): boolean;
  replace(filter: Filter<T>): this;
  process(payload: T): FilterChainOutcome<T>;
}
```

C'est **exactement** la forme dont le pipeline de pare-feu a besoin, et elle
existe déjà, avec publication d'événements sur le bus
(`publishStarted`/`publishCompleted`). Le §13 s'appuie dessus sans le
réécrire : un profil vendeur devient une **liste ordonnée de filtres
nommés**, et l'ordre d'opérations d'un ASA se distingue de celui d'un
FortiGate par la composition de la chaîne, pas par du code conditionnel.

Il faut noter que `FilterChain` est aujourd'hui peu utilisé. C'est une
opportunité, pas un signal négatif : la brique est disponible, testée et
sans dette de compatibilité.

#### 4.1.6 Le pipeline de traitement IPv4 du routeur

`Router.processIPv4()` (`src/network/devices/Router.ts` ligne 2188) et
`Router.forwardPacket()` (ligne 2648) définissent l'ordre actuel :

```
processIPv4:
  B.1 vérification de somme de contrôle
  B.2 version == 4
  B.3 IHL >= 5
  B.4 totalLength >= IHL*4
  C.1a ACL entrante                    ← deniedByInboundACL()
       NAT entrant                     ← natEngine.translateInbound()
  C.1  pour nous ? (interface, broadcast, multicast lien-local)
  C.1-bis FHRP (VIP)
  C.1b SPD entrant IPsec
  C.2  CAR entrée, puis forwardPacket()

forwardPacket:
       décision de routage (lookupRoute)
       NAT sortant                     ← natEngine.translateOutbound()
       ACL sortante                    ← aclEngine.evaluateACL()
       chiffrement IPsec éventuel
       émission
```

C'est un ordre correct pour IOS. Le §13 montre pourquoi il ne convient à
aucun des quatre pare-feux visés, et le §36 explique comment le pare-feu
obtient **son** pipeline sans altérer celui du routeur.

#### 4.1.7 Les autres briques mobilisables

| Brique | Fichier | Usage prévu par ce module |
|---|---|---|
| Arbre de commandes | `shells/CommandTrie.ts` | Grammaire CLI de chaque vendeur, complétion, aide `?` |
| Machine à états CLI | `shells/CLIStateMachine.ts` | Modes de configuration (`config firewall policy` → `edit 1` → …) |
| Constructeur de prompt | `shells/PromptBuilder.ts` | Prompts vendeur (`asa/act(config)#`, `FGT # `, `admin@PA-VM>`) |
| Fabrique de shells | `shell/ShellFactory.ts` | Enregistrement des shells pare-feu |
| Tables texte | `shells/cli/TextTable.ts` | Rendu des tables (`show conn`, listes de sessions) |
| Journalisation | `devices/router/LoggingConfig.ts` | Syslog, sévérités, horodatage |
| Agent syslog | `syslog/SyslogAgent.ts` | Export vers collecteur, `source-interface` |
| Agent SNMP | `snmp/SnmpAgent.ts` | Traps, MIB |
| Moteur IPsec | `ipsec/` | VPN site-à-site |
| Moteur TLS | `network/tls/` | Réel (X25519, AES-GCM, RSA, ECDSA) — base d'un futur déchiffrement |
| Capacités ségrégées | `equipment/HostCapabilities.ts`, `RouterServiceCapabilities.ts` | Patron d'accès aux sous-systèmes vendeur |
| Sérialiseur | `store/topologySerializer.ts` | Persistance de la politique |
| Vue d'inspection | `devices/inspection/DeviceStateView.ts` | Introspection pour tests et débogage |

### 4.2 Ce qui manque entièrement

| # | Manque | Gravité |
|---|---|---|
| **M1** | Classe d'équipement pare-feu | Bloquant |
| **M2** | Table de sessions consultable | Bloquant |
| **M3** | Notion de zone de sécurité | Bloquant |
| **M4** | Politique ordonnée zone-à-zone | Bloquant |
| **M5** | Objets nommés (adresse, service, horaire) | Bloquant |
| **M6** | Pipeline pare-feu paramétrable | Bloquant |
| **M7** | Shell ASA / FortiOS / PAN-OS / Junos | Bloquant par vendeur |
| **M8** | Mode transparent / virtual wire | Majeur |
| **M9** | ALG au-delà de FTP | Majeur |
| **M10** | Identification applicative | Majeur |
| **M11** | Identification d'utilisateur | Majeur |
| **M12** | Profils de sécurité | Majeur |
| **M13** | Haute disponibilité | Majeur |
| **M14** | Contextes virtuels | Moyen |
| **M15** | Protection DoS / screens | Moyen |
| **M16** | Journaux au format vendeur | Moyen |
| **M17** | Shaping / QoS de pare-feu | Mineur |

### 4.3 Ce qui existe partiellement et devra être arbitré

| Brique | Existant | Décision attendue |
|---|---|---|
| ALG FTP | `router/nat/FtpAlg.ts` — réel | Généraliser en cadre d'ALG (§15) |
| NAT | `router/NATEngine.ts` — riche mais orienté routeur | §36.4 |
| ACL IPv6 | `router/Ipv6AclEngine.ts` | Réutilisable comme socle de politique IPv6 |
| Suivi de connexions | `LinuxIptablesManager.conntrack` | Ne pas réutiliser tel quel ; le pare-feu a besoin d'une table plus riche. Voir §10.9 pour la position sur la convergence |
| Zones Huawei | `HuaweiAclCommands.ts` | À vérifier : VRP a une notion de zone sur ses pare-feux USG, absente ici |
| Journalisation | `LoggingConfig` — solide côté Cisco IOS | Étendre, ne pas dupliquer |

### 4.4 Synthèse honnête de l'inventaire

Le dépôt est **mieux équipé qu'il n'y paraît** pour ce chantier :

- la couche 1 à 4 est réelle et n'a pas besoin d'être touchée ;
- le patron de pipeline (`FilterChain`) est écrit et inutilisé ;
- le NAT est le sous-système le plus mûr du dépôt après six phases de PRD ;
- l'inspection à états existe, chez Linux, et fonctionne ;
- la machinerie CLI (trie, complétion, aide, tables, prompts) est mature et
  a déjà servi quatre dialectes.

Ce qui manque n'est donc pas de la mécanique de bas niveau : c'est le
**modèle de domaine du pare-feu** — session, zone, politique, objet — et le
pipeline qui les articule. C'est exactement ce que la Partie II définit.

---

## 5. Personas et cas d'usage pédagogiques

### 5.1 Personas

| Persona | Profil | Attente principale |
|---|---|---|
| **P1 — Étudiant CCNA Security / SECFND** | Découvre le pare-feu après le routeur | Comprendre pourquoi une ACL de retour n'est pas nécessaire |
| **P2 — Candidat NSE4 (Fortinet)** | Prépare une certification produit | Retrouver la CLI FortiOS exacte : `config firewall policy`, `edit`, `set`, `next`, `end` |
| **P3 — Candidat PCNSA (Palo Alto)** | Prépare une certification produit | Retrouver le *packet flow* PAN-OS et le comportement App-ID |
| **P4 — Candidat JNCIA-SEC (Juniper)** | Prépare une certification produit | Retrouver le modèle zone/policy Junos et `show security flow session` |
| **P5 — Formateur** | Construit des laboratoires | Pouvoir injecter une erreur de configuration et la faire diagnostiquer |
| **P6 — Ingénieur en poste** | Valide une maquette avant production | Vérifier un ordre d'opérations, un NAT, une règle |
| **P7 — Auditeur / analyste SOC** | Lit des journaux | Retrouver le format de journal du constructeur |

### 5.2 Cas d'usage fondateurs

Ces sept scénarios sont les **cas de recette du socle**. Un socle qui les
sert tous les sept est un socle complet ; un socle qui en manque un est
incomplet, quel que soit le nombre de commandes acceptées par ailleurs.

#### UC-1 — L'inspection à états, démontrée

> Un poste en zone `inside` ouvre une session TCP/80 vers un serveur en zone
> `outside`. Une seule règle existe : `inside → outside, any, HTTP, allow`.
> Aucune règle `outside → inside` n'existe. La page se charge.

Ce que ce cas prouve :
- la session est installée à l'aller ;
- le retour est autorisé **par la session**, pas par une règle ;
- `show conn` (ou l'équivalent vendeur) montre la session, avec ses deux
  demi-flux, ses octets et sa durée ;
- la suppression de la session (`clear conn`) coupe le flux immédiatement.

**Le contre-test est aussi important** : le même échange, avec un paquet
ACK forgé arrivant de `outside` sans session, doit être refusé. C'est ce que
`tcpEstablished` sur une ACL ne sait pas faire.

#### UC-2 — La zone décide, pas l'interface

> Deux interfaces sont dans la zone `dmz`. Une règle `inside → dmz` autorise
> SSH. Un serveur est déplacé de la première interface à la seconde. Le SSH
> continue de passer, sans qu'aucune règle n'ait été modifiée.

Ce que ce cas prouve :
- la politique est indexée par zone et non par interface ;
- l'appartenance d'une interface à une zone est une donnée mutable ;
- retirer l'interface de la zone coupe le flux.

#### UC-3 — L'ordre d'opérations est observable

> Un serveur en `dmz` est publié par NAT statique sur une adresse publique.
> Une règle entrante est écrite avec l'adresse **publique** en destination.
> Selon le vendeur, elle fonctionne ou non.

Ce que ce cas prouve :
- sur ASA 8.3+ : la règle doit viser l'adresse **réelle** (dé-NAT avant ACL) ;
- sur FortiOS : la politique vise la VIP, dont le nom porte les deux
  adresses ;
- sur PAN-OS : la règle vise l'adresse **pré-NAT** en destination mais la
  zone **post-NAT** — le piège classique du PCNSA ;
- le simulateur doit reproduire les trois, sinon il enseigne un vendeur en
  croyant en enseigner trois.

#### UC-4 — Le premier paquet et les suivants ne suivent pas le même chemin

> Un flux de 100 paquets traverse le pare-feu. Les compteurs montrent
> 1 passage en chemin lent et 99 en chemin rapide.

Ce que ce cas prouve :
- la distinction *slowpath* / *fastpath* est réelle et mesurée ;
- la politique n'est évaluée qu'une fois par session ;
- une modification de politique **n'affecte pas** les sessions déjà
  installées (comportement réel, et source de la moitié des incidents en
  production).

#### UC-5 — L'ALG ouvre un passage

> Une session FTP active est ouverte. Le canal de données arrive **depuis**
> le serveur vers un port éphémère du client. Aucune règle ne l'autorise.
> Il passe quand même, parce que l'ALG FTP a lu la commande `PORT` et
> installé un *pinhole*.

Ce que ce cas prouve :
- l'inspection applicative agit sur la charge utile ;
- le *pinhole* est visible (table de sessions ou table dédiée) ;
- désactiver l'ALG casse le transfert — ce qui est la démonstration
  pédagogique la plus efficace de son rôle.

#### UC-6 — Le refus est diagnosticable

> Un flux est refusé. L'apprenant doit pouvoir déterminer **quelle règle**
> l'a refusé, sans deviner.

Ce que ce cas prouve :
- chaque règle porte un compteur de correspondances et d'octets ;
- le journal de refus nomme la règle ;
- l'outil de simulation de politique (`packet-tracer` ASA, `test security-policy-match`
  PAN-OS, `flow trace` FortiOS) rend le même verdict que le chemin réel.

Cette dernière ligne est un invariant fort : **l'outil de simulation et le
chemin de données doivent lire le même moteur.** Un simulateur où
`packet-tracer` dit `ALLOW` pendant que le ping échoue serait pire
qu'inutile — c'est précisément le genre de contradiction que ce dépôt
refuse ailleurs (deux magasins SSH, deux rendus de `flash:`).

#### UC-7 — La topologie rechargée se comporte pareil

> Une politique complète est écrite, une topologie est sauvegardée, puis
> rouverte. Le même trafic obtient le même verdict.

Ce que ce cas prouve :
- la configuration rendue reproduit ce qui a été tapé ;
- le rejeu de configuration à l'import reconstruit les objets, les zones,
  les règles et le NAT ;
- ce qui n'est pas rechargeable (sessions actives, compteurs) est **déclaré**
  comme tel, conformément à `TOPOLOGY_SAVE_CAVEATS`.

### 5.3 Laboratoires cibles

| Lab | Sujet | Vendeurs | Phase |
|---|---|---|---|
| **L1** | DMZ à trois pattes | tous | 1 |
| **L2** | Publication de serveur (NAT destination) | tous | 2 |
| **L3** | PAT sortant et surcharge | tous | 2 |
| **L4** | Inspection à états contre ACL réflexive | générique + ASA | 1 |
| **L5** | FTP actif/passif et ALG | tous | 4 |
| **L6** | Politique par application (App-ID) | PAN-OS, FortiOS | 5 |
| **L7** | Mode transparent | ASA, FortiOS | 6 |
| **L8** | Haute disponibilité actif/passif | tous | 7 |
| **L9** | Contextes virtuels / VDOM | ASA, FortiOS | 8 |
| **L10** | VPN site-à-site entre deux pare-feux | tous | 5 |
| **L11** | Diagnostic : « pourquoi ça ne passe pas ? » | tous | 3 |
| **L12** | Analyse de journaux | tous | 4 |

---

## 6. Principes directeurs

> Ces principes tranchent par avance les arbitrages récurrents. Quand une
> décision d'implémentation hésite, c'est ici qu'on cherche la réponse.

### P1 — Une session est une mesure, pas un affichage

Toute vue de la table de sessions lit la table réelle. Il ne doit exister
aucun chemin où `show conn` fabrique une ligne. Corollaire : si aucune
session n'existe, la vue est vide — et une vue vide sur un flux qui passe
est un défaut à corriger, pas un cas à masquer.

Ce principe est la transposition directe d'une leçon déjà payée dans ce
dépôt : `display nqa results` affichait `Min/Max/Avg RTT: 0/0/0 ms` pour une
cible inexistante, c'est-à-dire l'absence de mesure rendue dans la forme
d'un résultat. C'est pire qu'une commande manquante.

### P2 — L'ordre d'opérations est une donnée, pas du code

Le pipeline est une `FilterChain` composée à partir d'un **profil vendeur**
déclaratif. Ajouter un vendeur dont l'ordre diffère ne doit jamais conduire
à un `if (vendor === 'fortios')` dans le moteur. Si un tel `if` devient
nécessaire, c'est que le profil manque d'un champ — c'est le champ qu'il
faut ajouter.

### P3 — Le socle porte le mécanisme, le vendeur porte le mot

Une seule table de sessions ; quatre rendus. Un seul moteur de politique ;
quatre grammaires. Un seul verdict `deny` ; quatre façons de l'écrire.
Quand deux vendeurs divergent sur un **mécanisme** et non sur un mot, la
divergence est déclarée dans le profil (§26.3), jamais dupliquée en code.

### P4 — Ce qui n'est pas simulé est refusé, et le refus nomme le manque

Trois familles de messages, comme `PRD-Curl.md` les a établies pour `curl` :

1. commande implémentée → elle agit ;
2. commande que le vendeur connaît mais que ce build ne simule pas → refus
   explicite nommant la brique manquante ;
3. commande inexistante → le message d'erreur **du vendeur** pour une
   commande inconnue.

Le message de la famille 2 n'est délibérément le message d'aucun
constructeur : aucun vrai pare-feu n'est jamais dans cette situation, et
répondre « commande inconnue » pour une commande que le vendeur connaît
serait un second mensonge.

### P5 — La configuration rendue reproduit ce qui a été tapé

Ce principe est plus fort qu'une exigence d'affichage, parce que la
configuration rendue est **rejouée à l'import d'une topologie**. Une règle
qui s'affiche différemment de ce qui a été écrit est une règle qui changera
au rechargement. Ce dépôt a déjà rencontré ce défaut cinq fois au moins
(routes statiques, `service timestamps`, `snmp-server enable traps`,
`source LoopBack 0`, `ip ssh time-out`).

### P6 — Aucun raccourci hors du fil

Règle absolue du dépôt, rappelée ici parce qu'un pare-feu la met sous
tension : la synchronisation HA échange de **vraies trames**, le journal
part vers un collecteur par un **vrai datagramme**, l'authentification d'un
administrateur traverse un **vrai** RADIUS/TACACS+. Aucun accès direct à
l'objet du pair.

Corollaire de test : mesurer la **différence** de trames avec et sans la
charge utile, jamais un total non nul.

### P7 — Deux voies d'observation au minimum

Tout état interne doit être observable par au moins deux chemins
indépendants : une commande d'affichage **et** un compteur, ou un journal
**et** une table. Un état observable par un seul chemin est un état dont on
ne peut pas vérifier la cohérence.

### P8 — Le pare-feu refuse par défaut

La politique implicite finale est `deny`. C'est vrai des quatre
constructeurs et c'est la première chose à enseigner. Le socle installe donc
une règle implicite terminale non modifiable, visible dans les rendus
(numérotée, comptée, journalisable selon le vendeur).

Nuance à ne pas rater : l'ASA superpose à cela le modèle des **niveaux de
sécurité**, qui autorise implicitement haut→bas. Ce n'est pas une exception
au refus par défaut, c'est une ACL implicite que le profil ASA déclare. Le
socle doit pouvoir exprimer les deux.

### P9 — Une modification de politique n'affecte pas les sessions installées

Comportement réel des quatre vendeurs, et source majeure d'incidents. Le
simulateur doit le reproduire, y compris ses conséquences désagréables : une
règle supprimée ne coupe pas le trafic en cours tant que la session vit. Les
commandes de purge (`clear conn`, `diagnose sys session clear`,
`clear session all`) existent précisément pour cela et doivent agir.

Exception à déclarer par vendeur : certains proposent une réévaluation
(FortiOS `set firewall-session-dirty check-new` / `check-all`). C'est un
champ du profil, pas un comportement du socle.

### P10 — L'échec est aussi enseignable que le succès

Chaque famille de refus produit un événement de journal identifiable, et le
compteur correspondant. « Refusé par la politique », « aucune route »,
« session inexistante pour ce paquet non-SYN », « échec d'inspection »,
« limite de sessions atteinte » sont **cinq** diagnostics distincts, et les
confondre serait perdre l'essentiel de la valeur pédagogique.

### P11 — Réutiliser avant d'écrire

Avant toute nouvelle brique, la question est : `Port`, `Cable`, `TcpStack`,
`FilterChain`, `EventBus`, `Scheduler`, `CommandTrie`, `TextTable`,
`LoggingConfig`, `SyslogAgent`, `NATEngine`, `FtpAlg`, `ipsec/` — l'un
d'eux répond-il déjà ? Le §36 documente pour chaque brique nouvelle la
raison pour laquelle l'existant ne suffisait pas.

### P12 — Une limite assumée est écrite deux fois

Dans le fichier qui la porte, et dans ce document. Une limite connue de
l'auteur seul est une limite qui sera redécouverte comme un bogue.

---

# Partie II — Le modèle générique

---

## 7. Vue d'ensemble de l'architecture

### 7.1 La pile en une image

```
┌──────────────────────────────────────────────────────────────────────┐
│  COUCHE VENDEUR   (une par constructeur — la seule à dupliquer)      │
│                                                                      │
│  AsaShell     FortiOsShell    PanOsShell    JunosShell               │
│  AsaProfile   FortiOsProfile  PanOsProfile  JunosProfile             │
│  AsaRenderer  FortiOsRenderer PanOsRenderer JunosRenderer            │
│      │              │              │             │                   │
└──────┼──────────────┼──────────────┼─────────────┼───────────────────┘
       │              │              │             │
       ▼              ▼              ▼             ▼
┌──────────────────────────────────────────────────────────────────────┐
│  SOCLE PARE-FEU   (écrit une fois)                                   │
│                                                                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐      │
│  │ ZoneTable  │  │ ObjectStore│  │ PolicyStore│  │ NatPolicy  │      │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐      │
│  │SessionTable│  │ AlgRegistry│  │ProfileStore│  │ ScreenStore│      │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘      │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  FirewallPipeline  —  FilterChain<PacketContext>               │  │
│  │  composée à partir du FirewallProfile du vendeur               │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  SOCLE EXISTANT   (non modifié)                                      │
│  Equipment · Port · Cable · TcpStack · EventBus · Scheduler          │
│  CommandTrie · TextTable · LoggingConfig · SyslogAgent · ipsec/      │
└──────────────────────────────────────────────────────────────────────┘
```

### 7.2 La règle de partage

| Couche | Contenu | Duplication |
|---|---|---|
| **Socle existant** | L1-L4, événements, CLI générique | Aucune — réutilisé tel quel |
| **Socle pare-feu** | Modèle de domaine + moteurs + pipeline | Aucune — écrit une fois |
| **Couche vendeur** | Grammaire, rendus, profil déclaratif, spécificités irréductibles | Une par constructeur |

L'objectif chiffré, qui sert de critère d'acceptation en §41 : **la couche
vendeur ne doit contenir aucun moteur.** Aucune classe de la couche vendeur
ne doit décider du sort d'un paquet ; elle décrit, elle rend, elle traduit.

### 7.3 La classe d'équipement

```
Equipment  (abstrait, existant)
   ├── EndHost ─── LinuxPC / WindowsPC / LinuxServer / …
   ├── Switch ──── CiscoSwitch / HuaweiSwitch / GenericSwitch
   ├── Router ──── CiscoRouter / HuaweiRouter
   └── Firewall ── AsaFirewall / FortiGateFirewall / PanOsFirewall / SrxFirewall
                   ▲
                   └── NOUVEAU
```

**Arbitrage majeur** : `Firewall` étend-il `Router` ou `Equipment` ?

| Option | Pour | Contre |
|---|---|---|
| **A — `Firewall extends Router`** | Récupère routage, FIB, NAT, ARP, ICMP, IPsec, interfaces L3 | Hérite de tout le modèle IOS (ACL liées aux interfaces, pipeline routeur, CDP, EIGRP/OSPF Cisco) et de 5615 lignes dont l'essentiel ne convient pas |
| **B — `Firewall extends Equipment`, capacités L3 par composition** | Aucune dette héritée ; chaque collaborateur testable seul ; le pare-feu ne porte que ce qu'un pare-feu a | Doit construire sa propre couche L3 |
| **C — `Firewall extends Router`, pipeline substitué** | Récupère l'infrastructure L3 | La dette héritée reste présente mais inerte — un piège pour le prochain développeur |

### 7.3.1 Décision : option B — composition plutôt qu'héritage

**`Firewall extends Equipment`.** Les capacités de couche 3 sont des
**collaborateurs injectés**, pas un héritage.

Quatre raisons, dans l'ordre de poids :

**1. Un pare-feu n'EST PAS un routeur.** L'héritage exprime « est un ». Un
pare-feu route, mais router n'est pas ce qu'il est ; c'est un service dont
il a besoin. `Firewall extends Router` fait de la relation d'usage une
relation d'identité, et le prix se paie à chaque ajout : toute méthode
ajoutée à `Router` apparaît sur le pare-feu, qu'elle ait un sens ou non.

**2. La dette inerte n'est pas neutre, elle est active.** L'option C
laissait `Router`'s CDP, EIGRP, HSRP, les ACL liées aux interfaces et le
pipeline IOS présents mais inutilisés. Un développeur ultérieur les
trouverait, les croirait disponibles, et les câblerait. Le dépôt a un
précédent exact : `GenericSwitch` reçoit le `CiscoSwitchShell` complet alors
qu'il ne fait tourner aucun protocole Cisco — il a fallu ~53 sites d'appel
et une erreur nommée pour refermer ce que l'héritage avait ouvert. Ne pas
ouvrir coûte moins cher que refermer.

**3. La testabilité est structurellement meilleure.** Un `PolicyEvaluator`
qui reçoit une `RouteLookup` en argument se teste avec une fonction de
trois lignes. Le même code atteint par héritage exige d'instancier un
`Router` complet — donc son ARP, ses minuteurs, son registre. C'est la
différence entre un test unitaire et un test d'intégration déguisé, et elle
décide de la vitesse à laquelle ce module pourra être développé en TDD.

**4. `Router.ts` fait 5615 lignes et NFR-M3 en impose 800.** Hériter d'un
fichier qui viole la contrainte qu'on se donne serait incohérent.

### 7.3.2 Ce que la composition doit fournir

Le pare-feu a besoin de cinq services de couche 2/3. Aucun n'exige de
toucher à `Router` :

| Service | Rôle | Primitives réutilisées |
|---|---|---|
| `InterfaceTable` | Interfaces L3 : adresse, masque, MTU, état | `hardware/Port.ts` (complet), `core/ip.ts` |
| `RouteTable` | Correspondance au plus long préfixe, AD, ECMP | `core/ip.ts`, `core/interfaces.ts` (`IIPv4Route`) |
| `ArpService` | Cache, résolution, réponse | `core/types.ts` (`ARPPacket`), `core/interfaces.ts` (`INeighborResolver`) |
| `IcmpService` | Écho, erreurs (inaccessible, TTL expiré) | `core/IcmpErrors.ts`, `core/packetBuilders.ts` |
| `L2Delivery` | Trame sortante, MAC de destination | `hardware/Port.ts`, `hardware/Cable.ts` |

**Mesure, et c'est ce qui rend l'option B abordable** : ces cinq services
s'appuient sur des primitives **déjà autonomes** dans `core/` — `ip.ts`
(arithmétique d'adresses, 14 fonctions), `interfaces.ts` (`IIPv4Route`,
`INeighborResolver`), `packetBuilders.ts`, `IcmpErrors.ts`,
`Ipv4Fragmentation.ts`, `FilterChain.ts`. Le contre-argument de l'option B
(« réimplémenter des milliers de lignes ») supposait de repartir de zéro ;
il ne tient pas, parce que ce qui est coûteux dans `Router.ts` — les
protocoles de routage, les shells vendeur, les redondances FHRP — n'est
précisément pas ce dont le pare-feu a besoin.

Estimation : les cinq services représentent environ 700 lignes, contre 5615
héritées dont ~90 % inutiles.

### 7.3.3 Le patron retenu

```
                     ┌──────────────────────┐
                     │      Equipment       │  (existant, non modifié)
                     │  ports · bus · power │
                     └──────────▲───────────┘
                                │ extends
                     ┌──────────┴───────────┐
                     │      Firewall        │  FAÇADE — assemble, ne décide pas
                     └──────────┬───────────┘
                                │ compose
   ┌────────────┬───────────┬───┴────┬────────────┬─────────────┐
   ▼            ▼           ▼        ▼            ▼             ▼
InterfaceTable RouteTable ArpService IcmpService SessionTable Pipeline
                                                              │
                                                    composé depuis
                                                    FirewallProfile
```

`Firewall` est une **façade** : elle assemble des collaborateurs et leur
délègue. Elle ne contient aucune décision. C'est ce qui lui permet de
respecter NFR-M3 (≤ 800 lignes) alors que `Router.ts` en fait 5615.

### 7.3.4 Les patrons de conception employés, et pourquoi

| Patron | Où | Ce qu'il achète |
|---|---|---|
| **Stratégie** | `FirewallProfile` | Le comportement vendeur est une donnée injectée ; ajouter un constructeur n'ouvre aucun fichier du socle |
| **Chaîne de responsabilité** | `FirewallPipeline` sur `FilterChain` | L'ordre d'opérations devient composable ; une étape s'ajoute sans toucher aux autres |
| **Registre** | `PipelineStageRegistry`, `AlgRegistry` | Extension par enregistrement, pas par modification |
| **Dépôt** | `ZoneTable`, `ObjectStore`, `PolicyStore`, … | Chaque magasin est testable seul, sans équipement |
| **Façade** | `Firewall` | Un point d'entrée simple sur un assemblage riche |
| **Objet-valeur** | `FlowKey`, `AddressSet`, `PortRange` | Immuables, comparables, sans identité — donc sans bogue d'aliasing |
| **Spécification** | `MatchCriteria` | Les critères de correspondance se composent et se testent isolément |
| **Observateur** | `EventBus` | Découplage des consommateurs (UI, journal, tests) |
| **Composite** | `ObjectGroup` | Un groupe et un objet se résolvent par la même interface |
| **Injection de dépendance** | Tous les collaborateurs | Un test fournit un double ; aucun singleton caché |

Ces patrons ne sont pas décoratifs : chacun répond à une contrainte
nommée du document. La stratégie sert FR-VEN-02 (aucun moteur chez le
vendeur), la chaîne sert FR-PIP-01 (l'ordre est une donnée), le dépôt sert
NFR-M4 (magasins testables séparément), l'injection sert la démarche TDD.

### 7.3.5 Le refus de plateforme

`UnsupportedOnThisPlatformError` (§26.4) reste utile, mais son rôle change :
il ne sert plus à masquer un héritage encombrant — il n'y en a plus — mais à
refuser une fonction qu'un **profil vendeur** ne déclare pas. C'est un
mécanisme de politique produit, non de rattrapage d'architecture.

### 7.4 Les huit magasins du socle

| Magasin | Rôle | §  |
|---|---|---|
| `ZoneTable` | Zones et appartenance des interfaces | 9 |
| `ObjectStore` | Objets adresse / service / horaire / application et leurs groupes | 8 |
| `PolicyStore` | Politique de sécurité ordonnée | 11 |
| `NatPolicyStore` | Politique NAT ordonnée | 12 |
| `SessionTable` | Sessions actives | 10 |
| `AlgRegistry` | Modules d'inspection applicative | 15 |
| `ProfileStore` | Profils de sécurité (AV, IPS, web, DNS) | 17 |
| `ScreenStore` | Protections volumétriques et anomalies de protocole | 18 |

Chaque magasin est indépendant du vendeur. Chacun expose une vue de lecture
que les rendus vendeur consomment sans la modifier.

### 7.5 Le contexte de paquet

Toutes les étapes du pipeline partagent une seule structure mutable, qui est
le `T` de la `FilterChain<T>` :

```ts
export interface PacketContext {
  readonly id: number;
  readonly arrivedAt: number;

  ingressPort: string;
  egressPort?: string;
  ingressZone?: string;
  egressZone?: string;

  packet: IPv4Packet | IPv6Packet;
  readonly originalPacket: IPv4Packet | IPv6Packet;

  session?: FirewallSession;
  sessionDirection?: 'c2s' | 's2c';
  isFirstPacket: boolean;

  route?: RouteEntry;

  matchedPolicy?: SecurityRule;
  matchedNatRules: NatRuleMatch[];

  identifiedApplication?: string;
  identifiedUser?: string;

  verdict?: FirewallVerdict;
  verdictReason?: VerdictReason;
  verdictStage?: string;

  trace: PipelineTraceEntry[];
}
```

Trois champs méritent d'être commentés parce qu'ils portent des invariants :

- **`originalPacket`** est le paquet tel qu'il est arrivé, avant toute
  traduction. C'est lui que l'ASA 8.2 examinait avant l'ACL et que l'ASA
  8.3+ n'examine plus — la simple présence du champ permet aux deux profils
  de coexister sans branchement dans le moteur.
- **`isFirstPacket`** est ce qui distingue chemin lent et chemin rapide.
  C'est aussi ce que compte UC-4.
- **`trace`** est ce que consomment `packet-tracer`, `test security-policy-match`,
  `diagnose debug flow` et `show security match-policies`. Le remplir
  toujours (et non seulement en mode diagnostic) garantit que l'outil de
  simulation et le chemin de données ne peuvent pas diverger — invariant
  UC-6.

### 7.6 Le flux de contrôle en une phrase

> Une trame arrive sur un `Port` → `Firewall.handleFrame()` → si IPv4/IPv6,
> `Firewall.processPacket()` construit un `PacketContext` → le
> `FirewallPipeline` (composé selon le `FirewallProfile`) le traverse →
> le verdict est appliqué (émission, rejet silencieux, RST, ICMP) → les
> compteurs, la table de sessions et les journaux sont mis à jour.

---

## 8. Le modèle d'objets

### 8.1 Pourquoi les objets d'abord

Aucun des quatre constructeurs n'écrit d'adresse littérale dans une règle de
production. FortiOS l'**interdit** — une politique référence obligatoirement
un objet `firewall address`, fût-il `all`. PAN-OS et Junos l'autorisent mais
la pratique et les certifications imposent les objets. L'ASA les a
introduits en 8.3 et sa configuration moderne les impose de fait pour le NAT.

Un socle qui n'aurait que des littéraux ne pourrait donc reproduire aucune
configuration réaliste, et rendrait `config firewall policy` impossible à
simuler fidèlement.

### 8.2 Taxonomie

| Type d'objet | Contenu | Groupable |
|---|---|---|
| `address` | Hôte, sous-réseau, plage, FQDN, pays, dynamique | oui |
| `service` | Protocole + ports source/destination, ou protocole IP nu | oui |
| `schedule` | Récurrent (jours + plage horaire) ou ponctuel (début/fin) | oui (FortiOS) |
| `application` | Identifiant applicatif (App-ID / appctrl) | oui |
| `user` / `group` | Identité, pour l'identification d'utilisateur | oui |
| `zone` | Traité à part (§9) car il n'est pas référencé comme un objet ordinaire | non |
| `interface` | Référence nommée d'interface | oui (FortiOS `zone`) |
| `url-category` | Catégorie de filtrage web | oui |

### 8.3 L'objet adresse

```ts
export type AddressObjectKind =
  | 'host'        // 192.168.1.10
  | 'subnet'      // 192.168.1.0/24
  | 'range'       // 192.168.1.10-192.168.1.20
  | 'fqdn'        // www.example.com — résolu par le résolveur du pare-feu
  | 'wildcard'    // 192.168.0.0 / 0.0.255.255 (FortiOS)
  | 'geography'   // FR, US — table statique déclarée
  | 'dynamic'     // rempli par étiquettes (PAN-OS DAG) ou par connecteur
  | 'any';        // objet prédéfini, non supprimable

export interface AddressObject {
  name: string;
  kind: AddressObjectKind;
  family: 'ipv4' | 'ipv6';
  value?: string;
  endValue?: string;
  mask?: string;
  comment?: string;
  readonly predefined: boolean;
  tags: string[];
  referenceCount: number;
}
```

#### 8.3.1 Invariants

| # | Invariant | Justification |
|---|---|---|
| **I-A1** | Un objet référencé ne peut pas être supprimé | Comportement réel des quatre vendeurs ; le message d'erreur nomme le référent |
| **I-A2** | `any` / `all` existe, est prédéfini, n'est pas supprimable | Idem sur les quatre |
| **I-A3** | Le nom est unique par contexte virtuel | Deux VDOM peuvent avoir chacun leur `SERVEUR_WEB` |
| **I-A4** | Un objet FQDN est résolu par le résolveur du pare-feu, avec TTL | Sinon il ne serait qu'un littéral déguisé |
| **I-A5** | `referenceCount` est **calculé**, jamais stocké séparément | Un compteur stocké peut contredire la réalité — défaut déjà rencontré dans ce dépôt |

L'invariant I-A5 mérite une note. La tentation est d'incrémenter un compteur
à chaque référence ajoutée. Ce dépôt a payé ce choix ailleurs : la colonne
« Used by » de `lsmod` est **calculée** comme l'inverse des dépendances
déclarées, précisément parce que « deux colonnes qui peuvent se contredire
sont pires qu'une colonne fausse ». Même règle ici.

#### 8.3.2 L'objet FQDN et son piège

Un objet FQDN doit être résolu, et sa résolution doit être **observable** et
**expirable**. Le dépôt possède un vrai moteur DNS (`dns/`, codec de fil
réel, `ResolvedService`, `NameServiceSwitch`). Le pare-feu s'en sert.

Ce qui est **délibérément refusé** : traiter un FQDN comme un littéral
figé à la création. Un laboratoire dont l'objectif est de montrer qu'une
règle FQDN suit un changement DNS ne fonctionnerait pas, et pire, il
fonctionnerait *l'air de rien*.

Ce qui est **assumé** : la fréquence de rafraîchissement est celle du TTL,
bornée par un minimum et un maximum déclarés par le profil vendeur
(FortiOS : `set dns-ttl`, PAN-OS : minimum 30 s).

### 8.4 L'objet service

```ts
export interface ServiceObject {
  name: string;
  readonly predefined: boolean;
  entries: ServiceEntry[];
  comment?: string;
  category?: string;
}

export interface ServiceEntry {
  protocol: 'tcp' | 'udp' | 'sctp' | 'icmp' | 'icmp6' | 'ip';
  destinationPorts?: PortRange[];
  sourcePorts?: PortRange[];
  icmpType?: number;
  icmpCode?: number;
  ipProtocolNumber?: number;
}

export interface PortRange { from: number; to: number; }
```

#### 8.4.1 Pourquoi `entries` est un tableau

Parce que `HTTP` sur FortiOS est un service à une entrée, mais `ALL_TCP`,
`DNS` (TCP **et** UDP/53) et `TRACEROUTE` sont des services à plusieurs
entrées, et parce que PAN-OS `service-http` couvre 80 et 8080. Un service
mono-protocole obligerait à créer des groupes là où le vendeur crée un
service — donc à ne pas reproduire sa configuration.

#### 8.4.2 Le piège du port source

Presque tous les cours ignorent le port source dans un objet service, et
presque tous les vendeurs le proposent. Le socle le porte parce que son
absence rend impossible un exercice classique : filtrer un flux dont seul le
port **source** est caractéristique.

#### 8.4.3 Services prédéfinis

Le socle fournit un catalogue prédéfini minimal, **commun**, que chaque
profil vendeur étend et renomme :

| Socle | Contenu | ASA | FortiOS | PAN-OS | Junos |
|---|---|---|---|---|---|
| `any` | tout | `any` | `ALL` | `any` | `any` |
| `tcp-any` | TCP 1-65535 | — | `ALL_TCP` | — | `junos-tcp-any` |
| `udp-any` | UDP 1-65535 | — | `ALL_UDP` | — | `junos-udp-any` |
| `icmp-any` | ICMP tous types | — | `ALL_ICMP` | — | `junos-icmp-all` |
| `http` | TCP/80 | `http` | `HTTP` | `service-http` | `junos-http` |
| `https` | TCP/443 | `https` | `HTTPS` | `service-https` | `junos-https` |
| `ssh` | TCP/22 | `ssh` | `SSH` | — | `junos-ssh` |
| `telnet` | TCP/23 | `telnet` | `TELNET` | — | `junos-telnet` |
| `dns` | TCP+UDP/53 | `domain` | `DNS` | `service-dns` | `junos-dns-tcp/udp` |
| `ftp` | TCP/21 | `ftp` | `FTP` | — | `junos-ftp` |
| `smtp` | TCP/25 | `smtp` | `SMTP` | — | `junos-smtp` |
| `ntp` | UDP/123 | `ntp` | `NTP` | — | `junos-ntp` |
| `snmp` | UDP/161 | `snmp` | `SNMP` | — | `junos-snmp` |
| `syslog` | UDP/514 | `syslog` | `SYSLOG` | — | `junos-syslog` |
| `ike` | UDP/500 | `isakmp` | `IKE` | — | `junos-ike` |

**Décision** : le catalogue prédéfini est déclaré **par le profil vendeur**,
et non en dur dans le socle, parce que sa composition exacte fait partie de
ce qu'on enseigne (un candidat NSE4 doit savoir que `ALL_TCP` existe ; un
candidat PCNSA doit savoir que PAN-OS n'a que trois services prédéfinis).

Le socle fournit le catalogue **socle** ci-dessus comme base commune, et le
profil déclare son propre catalogue en le remplaçant, non en s'y ajoutant —
sinon un FortiGate afficherait des services que FortiOS n'a pas.

### 8.5 L'objet horaire

```ts
export type ScheduleKind = 'recurring' | 'onetime';

export interface ScheduleObject {
  name: string;
  kind: ScheduleKind;
  days?: WeekDay[];
  startTime?: string;   // HH:MM
  endTime?: string;     // HH:MM
  startDate?: string;   // ISO
  endDate?: string;
  expired?: boolean;
}
```

L'horaire lit l'horloge de l'appareil, qui existe déjà (`clock set`,
`clock timezone`, NTP réel via `ntp/NtpAgent.ts`). Un horaire est donc
**vraiment** évalué, et un laboratoire « la règle ne s'applique qu'aux
heures ouvrées » fonctionne en avançant l'horloge virtuelle.

Détail réel et pédagogiquement utile : sur FortiOS, une plage `recurring`
dont `endTime` est antérieur à `startTime` traverse minuit. Le socle porte
cette règle ; ne pas la porter produirait une plage vide silencieuse.

Second détail, qui est un piège classique en production : la fin d'horaire
ne coupe pas les sessions déjà installées, conformément à P9. Un laboratoire
peut le montrer, et FortiOS propose `set schedule-timeout enable` pour
l'inverse — champ du profil.

### 8.6 Les groupes

```ts
export interface ObjectGroup<K extends ObjectKind> {
  name: string;
  kind: K;
  members: string[];
  excludedMembers?: string[];
  comment?: string;
}
```

#### 8.6.1 Invariants de groupe

| # | Invariant | Justification |
|---|---|---|
| **I-G1** | Un groupe ne contient que des objets du même type | Vrai des quatre vendeurs |
| **I-G2** | L'imbrication est autorisée, la récursion est refusée à l'écriture | Un cycle produirait une évaluation infinie |
| **I-G3** | La profondeur maximale d'imbrication est déclarée par le profil | ASA, FortiOS et PAN-OS ont des limites différentes |
| **I-G4** | Un groupe vide est légal mais ne correspond à rien | Piège réel : une règle avec un groupe vide ne matche jamais |
| **I-G5** | `excludedMembers` n'existe que si le profil le déclare | PAN-OS et FortiOS l'ont, l'ASA non |

I-G4 est un cas de recette : un apprenant qui crée un groupe, l'utilise dans
une règle, et oublie d'y mettre des membres doit voir sa règle ne jamais
correspondre — pas correspondre à tout. L'inverse serait une faille
enseignée.

### 8.7 Aplatissement et évaluation

L'évaluation d'un objet en un ensemble d'adresses concrètes se fait par une
fonction unique :

```ts
resolveAddressObject(name: string, ctx: ResolutionContext): AddressSet;
resolveServiceObject(name: string, ctx: ResolutionContext): ServiceSet;
```

**Invariant I-R1** : l'aplatissement est calculé à l'évaluation, jamais
mémorisé à l'écriture. Sinon un objet FQDN dont l'adresse change, ou un
groupe dont un membre est ajouté, ne prendrait pas effet sur les règles
existantes.

**Invariant I-R2** : le résultat est mis en cache par une clé qui inclut la
version du magasin d'objets. Toute mutation incrémente la version. C'est ce
qui permet de concilier I-R1 avec la performance sans risquer une valeur
périmée.

### 8.8 Exigences — objets

| # | Exigence | Priorité |
|---|---|---|
| **FR-OBJ-01** | Créer, modifier, supprimer un objet adresse de chaque `kind` | P0 |
| **FR-OBJ-02** | Créer, modifier, supprimer un objet service multi-entrées | P0 |
| **FR-OBJ-03** | Créer des groupes d'adresses et de services, avec imbrication | P0 |
| **FR-OBJ-04** | Refuser la suppression d'un objet référencé, en nommant le référent | P0 |
| **FR-OBJ-05** | Refuser un groupe récursif à l'écriture | P0 |
| **FR-OBJ-06** | Fournir un catalogue prédéfini par vendeur | P0 |
| **FR-OBJ-07** | Résoudre un objet FQDN par le résolveur réel, avec TTL | P1 |
| **FR-OBJ-08** | Créer des objets horaires récurrents et ponctuels, évalués sur l'horloge réelle | P1 |
| **FR-OBJ-09** | Gérer la traversée de minuit dans un horaire récurrent | P1 |
| **FR-OBJ-10** | Afficher les références d'un objet (`show running-config … | where used`) | P1 |
| **FR-OBJ-11** | Porter des étiquettes (tags) et les groupes dynamiques | P2 |
| **FR-OBJ-12** | Porter les objets géographiques sur une table déclarée | P2 |
| **FR-OBJ-13** | Exclusion de membres dans un groupe, si le profil la déclare | P2 |
| **FR-OBJ-14** | Sérialiser tous les objets dans la topologie | P0 |

---

## 9. Les zones de sécurité

### 9.1 Définition retenue

Une zone est un **regroupement nommé d'interfaces**, auquel la politique
fait référence. Elle n'a pas d'adresse, pas de route, pas d'existence sur le
fil. Elle est un artefact de configuration dont le seul rôle est de rendre
la politique indépendante du câblage.

### 9.2 Le modèle générique

```ts
export interface SecurityZone {
  name: string;
  interfaces: string[];
  type: ZoneType;
  intraZoneAction: 'allow' | 'deny';
  securityLevel?: number;
  screenProfile?: string;
  readonly predefined: boolean;
  virtualRouter?: string;
  comment?: string;
}

export type ZoneType =
  | 'layer3'      // interfaces routées
  | 'layer2'      // interfaces pontées
  | 'virtual-wire'
  | 'tap'
  | 'external'    // inter-contextes virtuels (PAN-OS)
  | 'tunnel';
```

### 9.3 Les cinq divergences vendeur, et comment le socle les absorbe

Ce paragraphe est le prototype de la méthode de déclinaison : cinq
divergences réelles, quatre absorbées par un champ, une par un
comportement déclaré.

#### 9.3.1 L'ASA n'a pas de zone, il a un niveau de sécurité

Sur ASA, `nameif inside` + `security-level 100` : c'est l'**interface** qui
porte la confiance. Le trafic haut→bas est implicitement autorisé, bas→haut
implicitement refusé, et même→même refusé sauf
`same-security-traffic permit inter-interface`.

**Absorption** : le champ `securityLevel` sur la zone, et une zone implicite
par interface nommée. Le profil ASA déclare
`implicitPolicy: 'security-level'`, les autres déclarent
`implicitPolicy: 'deny-all'`.

L'ASA moderne (9.x) possède **aussi** un objet `zone` réel, mais qui ne
remplace pas les niveaux : les zones ASA servent à regrouper des interfaces
pour le routage asymétrique, et « la politique de sécurité elle-même — règles
d'accès, NAT, etc. — reste appliquée par interface, pas par zone ». Le
profil ASA déclare donc `policyKeyedBy: 'interface'` là où les trois autres
déclarent `policyKeyedBy: 'zone'`.

C'est la divergence la plus profonde du chapitre, et il est important de
noter qu'elle est absorbée par **deux champs déclaratifs**, sans branchement
dans le moteur de politique : celui-ci demande au profil « quelle est la clé
de correspondance ? » et reçoit `'interface'` ou `'zone'`.

#### 9.3.2 Le trafic intra-zone

| Vendeur | Défaut intra-zone | Modifiable |
|---|---|---|
| PAN-OS | autorisé (règle implicite `intrazone-default`) | oui, la règle implicite est éditable |
| FortiOS | refusé (`set intrazone deny` par défaut sur une zone) | oui |
| Junos SRX | refusé, sauf politique explicite | oui |
| ASA | sans objet (pas de politique par zone) ; l'équivalent est `same-security-traffic permit intra-interface` | oui |

**Absorption** : `intraZoneAction` sur la zone, valeur par défaut fournie
par le profil.

#### 9.3.3 Une interface peut-elle appartenir à deux zones ?

Non, chez les quatre. C'est un invariant du socle (I-Z2), pas un champ.

#### 9.3.4 Une zone peut-elle être vide ?

Oui chez les quatre, et c'est un piège pédagogique utile : une politique
référençant une zone vide ne correspond jamais. Invariant I-Z4.

#### 9.3.5 La zone de la boucle et du plan de gestion

PAN-OS attribue les interfaces de gestion hors zone ; FortiOS traite le
trafic destiné au pare-feu lui-même par `local-in-policy` et non par la
politique ordinaire ; l'ASA le traite par `control-plane` ACL ; Junos par
`host-inbound-traffic` **dans** la zone.

**Absorption** : c'est la divergence la plus structurante après §9.3.1, et
elle n'est **pas** absorbable par un simple champ, parce qu'elle change le
chemin du paquet. Le socle la traite par une étape de pipeline nommée
`self-traffic`, dont la position et le comportement sont déclarés par le
profil (§13.7).

### 9.4 Invariants de zone

| # | Invariant |
|---|---|
| **I-Z1** | Une zone a un nom unique par contexte virtuel |
| **I-Z2** | Une interface appartient à zéro ou une zone, jamais deux |
| **I-Z3** | Retirer une interface d'une zone prend effet sur les **nouvelles** sessions ; les sessions existantes suivent P9 |
| **I-Z4** | Une zone vide est légale et ne correspond à rien |
| **I-Z5** | Supprimer une zone référencée par une règle est refusé |
| **I-Z6** | Le type de zone doit être compatible avec le mode de l'interface (une interface L3 ne rejoint pas une zone `layer2`) |

### 9.5 Exigences — zones

| # | Exigence | Priorité |
|---|---|---|
| **FR-ZON-01** | Créer, renommer, supprimer une zone | P0 |
| **FR-ZON-02** | Affecter et retirer une interface d'une zone | P0 |
| **FR-ZON-03** | Refuser une interface dans deux zones | P0 |
| **FR-ZON-04** | Refuser la suppression d'une zone référencée | P0 |
| **FR-ZON-05** | Porter le niveau de sécurité pour le profil ASA | P0 |
| **FR-ZON-06** | Porter l'action intra-zone, avec le défaut du profil | P1 |
| **FR-ZON-07** | Porter les types de zone, contraints par le mode d'interface | P1 |
| **FR-ZON-08** | Rendre le trafic destiné au pare-feu par le chemin déclaré par le profil | P1 |
| **FR-ZON-09** | Attacher un profil de protection (screen) à une zone | P2 |
| **FR-ZON-10** | Afficher les zones et leurs interfaces | P0 |

---

## 10. Le moteur de sessions

> C'est le cœur du module. Tout le reste en dépend.

### 10.1 Ce qu'une session doit porter

Une session identifie un échange bidirectionnel et mémorise **tout ce que le
pipeline a décidé pour lui**, afin que les paquets suivants n'aient pas à
redécider.

```ts
export interface FirewallSession {
  readonly id: number;
  readonly createdAt: number;
  lastSeenAt: number;

  readonly c2s: FlowKey;
  readonly s2c: FlowKey;

  ingressZone: string;
  egressZone: string;
  ingressInterface: string;
  egressInterface: string;

  state: SessionState;
  tcpState?: TcpSessionState;

  policyId?: string;
  natRuleId?: string;
  translation?: SessionTranslation;

  application?: string;
  user?: string;

  counters: SessionCounters;

  timeoutSec: number;
  expiresAt: number;

  parentSessionId?: number;
  algName?: string;
  isPinhole: boolean;

  flags: SessionFlags;
}

export interface FlowKey {
  sourceIP: string;   sourcePort: number;
  destIP: string;     destPort: number;
  protocol: number;
  vrf?: string;
}

export interface SessionCounters {
  packetsC2S: number; bytesC2S: number;
  packetsS2C: number; bytesS2C: number;
}
```

### 10.2 Le choix d'indexation — et pourquoi il compte

La table est indexée par **flux directionnel**, pas par session : deux
entrées d'index pointent vers un même objet session.

```
index: Map<string, { session: FirewallSession; direction: 'c2s' | 's2c' }>
```

**Justification par la mesure.** `LinuxIptablesManager` indexe déjà par
direction, et c'est correct pour répondre « ce paquet appartient-il à un
flux connu ? ». Mais il ne porte **que** cet index, sans objet session
derrière — d'où l'impossibilité de rendre `conntrack -L` sans replier les
deux entrées à la lecture (`listConntrack()` fait exactement ce repliage).

Le socle pare-feu porte les deux : l'index directionnel pour la recherche en
O(1) sur le chemin rapide, et l'objet session pour l'affichage, les
compteurs et la durée de vie. C'est ce qui permet à `show conn` d'être une
lecture et non une reconstruction.

### 10.3 États de session

```ts
export type SessionState =
  | 'init'      // créée, politique pas encore appliquée
  | 'opening'   // handshake en cours
  | 'active'    // établie
  | 'closing'   // fermeture en cours
  | 'closed'    // fermée, en attente de purge
  | 'discard';  // refusée, conservée pour compter les paquets suivants
```

L'état `discard` n'est pas un raffinement. Il est réel : PAN-OS installe une
session en état `discard` pour un flux refusé, précisément pour ne pas
réévaluer la politique à chaque paquet d'une attaque. Sans cet état, un
scan de ports coûterait une évaluation complète de politique par paquet, et
le simulateur enseignerait un comportement de performance faux.

### 10.4 La machine à états TCP

C'est ce que `LinuxIptablesManager` n'a pas, et c'est ce qui distingue une
vraie inspection à états d'un simple suivi de tuples.

```ts
export type TcpSessionState =
  | 'syn-sent' | 'syn-received' | 'established'
  | 'fin-wait-1' | 'fin-wait-2' | 'close-wait'
  | 'last-ack' | 'time-wait' | 'closed';
```

#### 10.4.1 Transitions et délais

| État | Entrée | Délai par défaut | Sortie |
|---|---|---|---|
| `syn-sent` | SYN c2s sur session neuve | 30 s (`tcp-handshake`) | SYN-ACK → `syn-received` |
| `syn-received` | SYN-ACK s2c | 30 s | ACK c2s → `established` |
| `established` | ACK final | 3600 s (`tcp`) | FIN → `fin-wait-1` ; RST → `closed` |
| `fin-wait-1` | FIN d'un côté | 30 s | ACK → `fin-wait-2` |
| `fin-wait-2` | ACK du FIN | 30 s | FIN de l'autre → `last-ack` |
| `last-ack` | FIN réciproque | 30 s | ACK → `time-wait` |
| `time-wait` | ACK final | 30 s (`tcp-time-wait`) | expiration → `closed` |
| `closed` | RST, ou fin de `time-wait` | purge immédiate ou différée | — |

Ces valeurs sont les **défauts du socle**. Chaque profil vendeur les
surcharge : l'ASA utilise `timeout conn 1:00:00`, FortiOS
`set tcp-idle-timer`, PAN-OS `set deviceconfig setting session timeout-tcp`,
Junos `set security flow tcp-session`.

#### 10.4.2 Les contrôles que la machine à états rend possibles

C'est ici que se trouve la valeur pédagogique réelle :

| Contrôle | Ce qu'il attrape | Vendeur |
|---|---|---|
| **Premier paquet non-SYN** | Un ACK ou un FIN sans session — le cas de l'ACL réflexive contournée | tous (`tcp-syn-check`, `set tcp-syn-check`) |
| **Numéro de séquence hors fenêtre** | Injection dans un flux existant | ASA (`check-retransmission`), Junos (`sequence-check`) |
| **RST hors séquence** | Coupure forgée | ASA, Junos |
| **Drapeaux invalides** | SYN+FIN, NULL, Xmas — les scans nmap classiques | tous |
| **Transition d'état interdite** | FIN avant établissement | tous |

**Décision de socle** : ces cinq contrôles sont implémentés, chacun
activable/désactivable, chacun avec son propre compteur et son propre motif
de rejet. La raison est directement pédagogique — un laboratoire de scan
nmap contre un pare-feu correctement configuré est l'un des exercices les
plus parlants qui soient, et il exige que le NULL scan et le Xmas scan
soient distingués du SYN scan.

**Ce que le socle ne fait délibérément pas** : la validation de somme de
contrôle TCP au niveau du pare-feu est déjà faite par `TcpStack` sur les
extrémités ; la refaire ici serait une duplication. Le pare-feu vérifie la
somme de contrôle **seulement** s'il modifie le paquet (NAT), et le
recalcule alors — mécanisme déjà écrit dans `NATEngine.recomputeL4Checksum()`.

### 10.5 UDP et ICMP

UDP n'a pas d'état, mais a une session. Le socle installe une session au
premier datagramme et la considère `active` dès qu'un datagramme de retour
est vu — la distinction « répondue / non répondue » que `conntrack -L`
appelle déjà `[UNREPLIED]`.

| Protocole | Délai avant réponse | Délai après réponse |
|---|---|---|
| UDP | 30 s | 180 s |
| ICMP | 6 s | 6 s |
| Autre IP | 60 s | 60 s |

ICMP mérite une note : une session ICMP est identifiée par
(source, destination, type, identifiant), et non par des ports. Le socle
range l'identifiant ICMP dans le champ `sourcePort` du `FlowKey` — c'est le
choix qu'a fait netfilter et il est correct, à condition d'être écrit.
L'écho de retour porte le même identifiant, ce qui referme la session.

**Cas réel à ne pas rater** : un message ICMP d'erreur (destination
inaccessible, TTL expiré) référence en charge utile l'en-tête du paquet
fautif. Le pare-feu doit associer cette erreur à la session du paquet fautif
et la laisser passer, sinon `traceroute` ne fonctionne pas à travers le
pare-feu. C'est un exercice classique et un défaut fréquent.

### 10.6 Cycle de vie et expiration

```
      premier paquet
            │
            ▼
      ┌───────────┐   politique = deny    ┌──────────┐
      │   init    │──────────────────────▶│ discard  │
      └─────┬─────┘                       └────┬─────┘
            │ politique = allow                │ expiration courte
            ▼                                  ▼
      ┌───────────┐                        (purge)
      │  opening  │
      └─────┬─────┘
            │ handshake complet
            ▼
      ┌───────────┐  FIN/FIN    ┌──────────┐  expiration  ┌────────┐
      │  active   │────────────▶│ closing  │─────────────▶│ closed │
      └─────┬─────┘             └──────────┘              └────┬───┘
            │ RST / clear / expiration                         │
            └──────────────────────────────────────────────────┘
                                                          (purge)
```

#### 10.6.1 Le mécanisme d'expiration

**Décision** : l'expiration est portée par un balayage périodique sur
`src/events/Scheduler`, et non par un minuteur par session.

Justification par la mesure : un minuteur par session sur quelques milliers
de sessions produirait quelques milliers de minuteurs virtuels, ce que le
`Scheduler` supporterait mal et ce qui n'apporterait aucune fidélité — les
vrais pare-feux balayent aussi. Le balayage a lieu toutes les secondes
(virtuelles) et purge ce qui a dépassé `expiresAt`.

Corollaire honnête, à écrire : une session expire donc **à ou après** sa
date d'expiration, pas exactement à la seconde. C'est le même arbitrage que
celui déjà pris pour le cache mDNS du dépôt (« l'expiration est calculée à
la lecture et à chaque annonce entendue, donc l'événement se produit à ou
après l'échéance »).

#### 10.6.2 Rafraîchissement

`lastSeenAt` et `expiresAt` sont repoussés à **chaque** paquet appartenant à
la session, dans les deux sens. C'est ce qui fait qu'une session active ne
meurt pas.

Piège réel que le socle doit reproduire : sur la plupart des vendeurs, seul
un paquet **acceptable** rafraîchit la session. Un paquet rejeté par la
machine à états TCP ne la prolonge pas. Sans cela, un attaquant maintiendrait
une session ouverte avec des paquets invalides.

### 10.7 Capacité et épuisement

```ts
export interface SessionTableLimits {
  maxSessions: number;
  maxSessionsPerSource?: number;
  maxSessionsPerDestination?: number;
  maxHalfOpen?: number;
  aggressiveAgingThreshold?: number;
  aggressiveAgingTimeoutSec?: number;
}
```

L'épuisement de la table est un **cas de panne à part entière**, à traiter
dans l'esprit de `PRD-Pannes.md` : quand la table est pleine, les nouvelles
sessions sont refusées avec un motif distinct de « refusé par la politique »,
un journal spécifique est émis, et un compteur dédié s'incrémente.

Le vieillissement agressif (réduction globale des délais au-delà d'un
seuil d'occupation) est réel chez les quatre et constitue un excellent
laboratoire : il montre que le pare-feu se dégrade avant de tomber.

### 10.8 Sessions filles et pinholes

Un ALG (§15) crée une session **fille** :

| Propriété | Valeur |
|---|---|
| `parentSessionId` | la session de contrôle |
| `isPinhole` | `true` tant que le flux attendu n'est pas arrivé |
| `algName` | le nom de l'ALG créateur |
| durée de vie | courte tant que `isPinhole`, normale ensuite |

**Invariant I-S7** : la fermeture de la session parente ferme les pinholes
non encore consommés. Sinon une session FTP fermée laisserait des ouvertures
béantes — précisément la faille que les ALG mal implémentés introduisent
dans la vraie vie.

### 10.9 Convergence avec `LinuxIptablesManager` — position assumée

Question légitime : faut-il unifier la table de sessions du pare-feu avec le
`conntrack` de `LinuxIptablesManager` ?

**Position : non, pas maintenant, et la raison est écrite plutôt que tue.**

| Argument pour l'unification | Argument contre |
|---|---|
| Un seul suivi d'état dans le dépôt | Les deux modèles divergent réellement : netfilter suit des tuples pour un hôte, le pare-feu suit des sessions pour un équipement de transit |
| Éviter le défaut « deux réponses à une question » | La question n'est pas la même : `conntrack -L` décrit ce que **cet hôte** a vu ; `show conn` décrit ce que **le pare-feu** achemine |
| — | `LinuxIptablesManager` est déjà consommé par 40+ points ; le migrer est un chantier autonome à risque élevé |

**Décision** : deux tables, avec deux justifications distinctes, et une
règle pour éviter la dérive — si un jour un pare-feu doit exposer une vue
netfilter (cas d'un pfSense/OPNsense, §43), il lira la table de sessions du
socle et non l'inverse. La convergence éventuelle se fera dans ce sens-là.

C'est le seul point du document où le dépôt accepte sciemment deux
mécanismes voisins. La règle P3 est respectée en esprit : ils ne répondent
pas à la même question.

### 10.10 Exigences — sessions

| # | Exigence | Priorité |
|---|---|---|
| **FR-SES-01** | Installer une session au premier paquet accepté | P0 |
| **FR-SES-02** | Indexer par flux directionnel, résoudre en O(1) | P0 |
| **FR-SES-03** | Autoriser le retour par l'existence de la session | P0 |
| **FR-SES-04** | Compter paquets et octets par direction | P0 |
| **FR-SES-05** | Machine à états TCP complète avec délais par état | P0 |
| **FR-SES-06** | Refuser un premier paquet non-SYN pour TCP (activable) | P0 |
| **FR-SES-07** | Refuser les combinaisons de drapeaux invalides, avec motif distinct | P0 |
| **FR-SES-08** | Session UDP avec distinction répondue / non répondue | P0 |
| **FR-SES-09** | Session ICMP indexée par identifiant | P0 |
| **FR-SES-10** | Associer un ICMP d'erreur à la session du paquet fautif | P1 |
| **FR-SES-11** | Expirer par balayage périodique | P0 |
| **FR-SES-12** | Rafraîchir uniquement sur paquet acceptable | P1 |
| **FR-SES-13** | État `discard` pour les flux refusés | P1 |
| **FR-SES-14** | Limites de table et refus distinct à l'épuisement | P1 |
| **FR-SES-15** | Vieillissement agressif au-delà d'un seuil | P2 |
| **FR-SES-16** | Sessions filles avec parent et durée de vie courte | P1 |
| **FR-SES-17** | Fermer les pinholes à la fermeture du parent | P1 |
| **FR-SES-18** | Purge sélective et globale par commande | P0 |
| **FR-SES-19** | Vue de la table par commande vendeur, en lecture directe | P0 |
| **FR-SES-20** | Contrôle de séquence TCP (activable) | P2 |
| **FR-SES-21** | Ne pas réévaluer la politique sur une session installée | P0 |
| **FR-SES-22** | Émettre les événements de création et de fermeture sur le bus | P0 |

---

## 11. Le moteur de politique

### 11.1 La règle générique

```ts
export interface SecurityRule {
  id: string;
  seq: number;
  name?: string;
  enabled: boolean;

  from: string[];          // zones ou interfaces sources
  to: string[];            // zones ou interfaces destinations
  source: string[];        // objets adresse
  destination: string[];
  sourceNegated: boolean;
  destinationNegated: boolean;

  service: string[];       // objets service
  serviceNegated: boolean;
  application: string[];   // App-ID / appctrl
  urlCategory: string[];
  user: string[];
  sourceDevice?: string[];

  schedule?: string;

  action: RuleAction;
  natEnabled?: boolean;    // FortiOS : le NAT est un champ de la politique

  logStart: boolean;
  logEnd: boolean;
  logProfile?: string;

  securityProfileGroup?: string;
  profiles?: SecurityProfileRefs;

  sessionTimeoutOverrideSec?: number;
  trafficShaper?: string;

  comment?: string;
  tags: string[];

  hitCount: number;
  byteCount: number;
  lastHitAt?: number;
  createdAt: number;
  modifiedAt: number;
}

export type RuleAction = 'allow' | 'deny' | 'drop' | 'reset-client'
                       | 'reset-server' | 'reset-both' | 'tunnel' | 'ipsec';
```

### 11.2 Pourquoi ces champs et pas d'autres

Chaque champ de cette structure est présent chez **au moins deux** des
quatre constructeurs. Le tableau ci-dessous est la justification, et il
constitue aussi la matrice de test de la §31.

| Champ | ASA | FortiOS | PAN-OS | Junos | Retenu parce que |
|---|---|---|---|---|---|
| `from` / `to` | interface | `srcintf`/`dstintf` | zone | zone | universel |
| `source`/`destination` | objet ou littéral | objet obligatoire | objet | address-book | universel |
| `sourceNegated` | `object-group` avec exclusion | `set srcaddr-negate` | `negate-source` | non | 3/4 |
| `service` | port dans l'ACE | `service` obligatoire | `service` | `application` | universel |
| `application` | via MPF | `application` (appctrl) | App-ID natif | `dynamic-application` | 4/4, profondeurs différentes |
| `user` | `identity firewall` | `groups`/`users` | `source-user` | `source-identity` | 4/4 |
| `urlCategory` | non | via profil | natif dans la règle | non | 2/4 → conservé, ignoré par les profils qui ne le déclarent pas |
| `schedule` | `time-range` | `schedule` obligatoire | `schedule` | `scheduler` | universel |
| `action` | permit/deny | accept/deny/ipsec | allow/deny/drop/reset-* | permit/deny/reject/tunnel | universel, valeurs différentes |
| `natEnabled` | non (NAT séparé) | oui | non | non | 1/4 → champ optionnel, déclaré par le profil |
| `logStart`/`logEnd` | `log` sur l'ACE | `logtraffic` | log at start/end | `then log session-init/close` | universel |
| `securityProfileGroup` | policy-map | profils individuels | groupe de profils | application-firewall | 4/4 |
| `trafficShaper` | policy-map | `traffic-shaper` | QoS séparé | — | 2/4 |
| `hitCount`/`byteCount` | oui | oui | oui | oui | universel |

Le champ `natEnabled` est instructif : il n'existe que chez FortiOS, et
c'est **la** particularité qui rend la configuration FortiOS si différente
des trois autres. Le socle le porte comme champ optionnel plutôt que de
forcer FortiOS à écrire une politique NAT séparée qu'un FortiGate n'a pas.
C'est un exemple de la règle P3 : le socle porte le mécanisme, mais quand la
divergence est un mécanisme, elle devient un champ déclaré.

### 11.3 L'algorithme d'évaluation

```
evaluate(ctx: PacketContext): PolicyDecision

  1. implicit = profile.implicitPolicy
     si implicit == 'security-level' :
        pré-verdict = (niveau(zone source) > niveau(zone dest)) ? allow : deny
     sinon :
        pré-verdict = deny

  2. pour chaque règle de la politique, dans l'ordre croissant de seq :
        si !règle.enabled            → suivante
        si !matchZones(règle, ctx)   → suivante
        si !matchAddresses(...)      → suivante
        si !matchServices(...)       → suivante
        si !matchSchedule(...)       → suivante
        si !matchUser(...)           → suivante
        si !matchApplication(...)    → voir 11.5 (peut être « indéterminé »)
        → CORRESPONDANCE : incrémenter hitCount, retenir la règle, sortir

  3. si aucune règle ne correspond :
        retenir la règle implicite terminale (ou le pré-verdict de l'étape 1)

  4. rendre { rule, action, profiles, logging }
```

**Invariant I-P1 — première correspondance gagnante.** Aucun vendeur visé
n'évalue toutes les règles. Une implémentation qui chercherait « la
meilleure » correspondance serait fausse pour les quatre.

**Invariant I-P2 — l'ordre est la sémantique.** Déplacer une règle change le
comportement. Le socle doit donc offrir les opérations d'ordonnancement
(`move before`, `move after`, `move top`, `move bottom`) et non seulement
l'ajout en fin.

**Invariant I-P3 — le compteur est incrémenté à la correspondance, pas à
l'évaluation.** Une règle traversée sans correspondre ne compte pas.

### 11.4 Correspondance des critères

#### 11.4.1 Zones et interfaces

Selon `profile.policyKeyedBy` :

| Valeur | Correspondance |
|---|---|
| `'zone'` | `ctx.ingressZone ∈ rule.from` et `ctx.egressZone ∈ rule.to` |
| `'interface'` | `ctx.ingressPort ∈ rule.from` et `ctx.egressPort ∈ rule.to` |

Le mot-clé `any` correspond à tout. Une règle avec `from: ['any']` et
`to: ['any']` est une règle globale — que PAN-OS appelle *global rulebase*
et FortiOS obtient avec `set srcintf any`.

**Piège majeur, et cas de recette** : la zone de destination est celle de
l'interface **de sortie**, donc elle est connue seulement **après** la
décision de routage. C'est pourquoi le routage précède la politique dans le
pipeline de tous les vendeurs (§13), et c'est la source de la question la
plus fréquente en certification PAN-OS.

Second piège, spécifique à PAN-OS et à traiter explicitement : quand un NAT
de destination est appliqué, la zone de destination utilisée par la règle
est celle vers laquelle mène la route **après** traduction, mais l'adresse
de destination à écrire dans la règle est celle **avant** traduction. Ce
n'est pas une incohérence de PAN-OS, c'est la conséquence de son ordre
d'opérations, et le simulateur doit le reproduire pour que le laboratoire
L2 soit juste.

#### 11.4.2 Adresses

`matchAddresses` aplatit les objets (§8.7) puis teste l'appartenance. La
négation inverse le résultat.

**Invariant I-P4** : la négation porte sur l'ensemble aplati, pas sur chaque
membre. `NOT (A ou B)` et non `(NOT A) ou (NOT B)`. L'erreur inverse est
classique et produirait une règle qui matche tout.

#### 11.4.3 Services

Correspondance sur protocole **et** port destination **et** port source si
l'entrée en spécifie un. Une entrée de service sans port source ne contraint
pas le port source.

Pour ICMP, la correspondance porte sur type et code si l'entrée les
spécifie.

#### 11.4.4 Horaires

Évalué sur l'horloge de l'appareil (§8.5). Un horaire absent vaut
« toujours ».

#### 11.4.5 Utilisateurs

Voir §16.3. Si l'identification d'utilisateur n'est pas activée, une règle
qui référence un utilisateur ne correspond **jamais** — et non « correspond
toujours ». C'est le comportement réel, et l'inverse serait une faille.

### 11.5 Le problème de l'application inconnue

C'est la difficulté conceptuelle majeure du moteur de politique NGFW, et
elle doit être traitée explicitement.

Au premier paquet, l'application n'est pas identifiée : il faut plusieurs
paquets de charge utile pour la reconnaître. Une règle qui contraint
l'application ne peut donc pas être évaluée définitivement au premier
paquet.

Les vendeurs résolvent cela ainsi :

| Vendeur | Mécanisme |
|---|---|
| PAN-OS | Politique évaluée d'abord sans application (`slowpath`) ; dès qu'App-ID identifie, **re-recherche** de politique ; si la nouvelle règle diffère, la session est réaffectée ou refusée (`app shift`) |
| FortiOS (profile-based) | La politique correspond sur zone/adresse/service ; le contrôle applicatif est un **profil** appliqué après, qui peut bloquer |
| FortiOS (policy-based NGFW) | L'application est un critère de la politique elle-même, avec un mécanisme de re-recherche analogue |
| Junos SRX | `dynamic-application` avec `none` pour la première correspondance, puis re-recherche |
| ASA | Sans objet — l'inspection MPF agit après la décision ACL |

**Décision de socle** : le moteur porte un état ternaire de correspondance
applicative.

```ts
export type MatchOutcome = 'match' | 'no-match' | 'pending';
```

- `pending` signifie « cette règle pourrait correspondre une fois
  l'application connue ».
- Le moteur retient la **première règle en `match`**, mais mémorise s'il a
  traversé des règles `pending` avant elle.
- Quand App-ID identifie l'application, le pipeline déclenche une
  re-recherche (§13.9) ; si le résultat diffère, la session change de règle
  ou est refusée.

Ce mécanisme est **déclaré actif ou non par le profil**
(`applicationShift: boolean`). Le profil ASA le déclare inactif, et le
moteur n'exécute alors jamais la re-recherche.

### 11.6 La règle implicite terminale

| Vendeur | Nom | Numéro | Journalisée par défaut | Éditable |
|---|---|---|---|---|
| ASA | *implicit deny* | — | non | non (mais l'ACL explicite la précède) |
| FortiOS | *Implicit Deny* | `0` | non | non |
| PAN-OS | `interzone-default` | — | non | oui (journalisation et profils) |
| Junos | *default deny* | — | non | oui via `default-policy` |

**Décision** : la règle implicite est un objet réel du `PolicyStore`,
marqué `implicit: true`, non supprimable, et dont l'éditabilité est déclarée
par le profil. Elle porte un `hitCount`, ce qui est directement utile au
diagnostic — savoir combien de flux tombent au fond de la politique est la
première mesure d'un audit.

PAN-OS a **deux** règles implicites (`intrazone-default` en `allow`,
`interzone-default` en `deny`), ce qui est absorbé par le champ
`intraZoneAction` de la zone (§9.3.2) plus la règle implicite terminale.

### 11.7 Ordonnancement et manipulation

| Opération | Sémantique |
|---|---|
| `insert(rule, at)` | Insère à la position, décale les suivantes |
| `append(rule)` | Insère avant la règle implicite |
| `move(id, before|after, target)` | Réordonne |
| `enable(id)` / `disable(id)` | Sans supprimer |
| `clone(id)` | Copie avec nouvel identifiant |
| `delete(id)` | Supprime |
| `resetCounters(id?)` | Remet à zéro |

**Invariant I-P5** : `seq` n'est pas l'identifiant. FortiOS numérote les
politiques par un identifiant stable (`edit 3`) tout en les ordonnant
séparément — `move 3 after 7` change l'ordre, pas l'identifiant. Confondre
les deux rendrait `move` impossible à simuler.

### 11.8 Analyse de politique

Fonctions de qualité de configuration, réellement présentes chez les
vendeurs et pédagogiquement excellentes :

| Analyse | Détecte | Vendeur de référence |
|---|---|---|
| **Règle masquée** *(shadowed)* | Une règle qu'aucun paquet ne peut atteindre | PAN-OS, FortiOS (FortiAnalyzer), Junos |
| **Règle redondante** | Une règle dont l'effet est déjà couvert | idem |
| **Règle jamais utilisée** | `hitCount == 0` depuis N jours | tous |
| **Règle trop permissive** | `any/any/any allow` | tous |
| **Objet orphelin** | Objet non référencé | tous |

**Décision** : ces analyses sont **incluses dans le socle** en phase 3.
Justification : elles sont peu coûteuses (elles lisent le `PolicyStore`),
elles ont une valeur pédagogique élevée (l'apprenant voit *pourquoi* sa
règle ne fonctionne pas), et elles servent directement le cas UC-6.

L'analyse de masquage est le seul algorithme non trivial : une règle R est
masquée si l'union des règles qui la précèdent couvre entièrement son
ensemble de correspondance avec une action différente. Le socle
l'implémente sur les critères ensemblistes (zones, adresses, services) et
**déclare ne pas la calculer** quand la règle porte des critères non
ensemblistes (application, utilisateur, horaire) — auquel cas elle est
signalée « indécidable » plutôt que déclarée saine. Annoncer une règle saine
sans avoir pu le vérifier serait un faux négatif dangereux.

### 11.9 Exigences — politique

| # | Exigence | Priorité |
|---|---|---|
| **FR-POL-01** | Créer, modifier, supprimer une règle | P0 |
| **FR-POL-02** | Évaluation ordonnée, première correspondance gagnante | P0 |
| **FR-POL-03** | Correspondance par zone ou par interface selon le profil | P0 |
| **FR-POL-04** | Correspondance sur objets adresse et service, avec groupes | P0 |
| **FR-POL-05** | Négation des critères adresse et service | P1 |
| **FR-POL-06** | Actions allow / deny / drop / reset-* selon le profil | P0 |
| **FR-POL-07** | Règle implicite terminale, comptée, non supprimable | P0 |
| **FR-POL-08** | Politique implicite par niveau de sécurité pour le profil ASA | P0 |
| **FR-POL-09** | Compteurs de correspondances et d'octets par règle | P0 |
| **FR-POL-10** | Réordonnancement (`move before/after/top/bottom`) | P0 |
| **FR-POL-11** | Activation / désactivation sans suppression | P1 |
| **FR-POL-12** | Correspondance sur horaire, évaluée sur l'horloge réelle | P1 |
| **FR-POL-13** | Correspondance sur utilisateur, sans correspondance si l'identification est inactive | P1 |
| **FR-POL-14** | Correspondance applicative ternaire, avec re-recherche si le profil la déclare | P2 |
| **FR-POL-15** | Journalisation au début et/ou à la fin de session | P0 |
| **FR-POL-16** | Attacher des profils de sécurité | P2 |
| **FR-POL-17** | Détecter les règles masquées, redondantes, inutilisées, trop permissives | P2 |
| **FR-POL-18** | Ne pas déclarer saine une règle dont le masquage est indécidable | P2 |
| **FR-POL-19** | Simulation de politique cohérente avec le chemin réel | P0 |
| **FR-POL-20** | Sérialiser la politique et la rejouer à l'import | P0 |

---

## 12. Le moteur NAT

### 12.1 Le NAT de pare-feu n'est pas le NAT de routeur

Le dépôt possède `router/NATEngine.ts`, mûr et testé. La différence avec un
NAT de pare-feu tient en trois points :

| Aspect | NAT routeur (IOS/VRP) | NAT pare-feu |
|---|---|---|
| **Déclenchement** | Règle liée à des interfaces `inside`/`outside` | Politique NAT ordonnée, avec ses propres critères |
| **Ordre** | Fixé par le pipeline IOS | Déclaré par le profil ; l'ASA, FortiOS et PAN-OS diffèrent |
| **Expression** | `ip nat inside source list 1 pool P overload` | Règle avec zones, adresses, services, et action de traduction |

Un pare-feu exprime « traduire le trafic de la zone `inside` vers la zone
`outside` en utilisant l'adresse de l'interface de sortie » comme une
**règle**, pas comme un attribut d'interface.

### 12.2 La règle NAT générique

```ts
export interface NatRule {
  id: string;
  seq: number;
  name?: string;
  enabled: boolean;
  type: NatRuleType;

  fromZone: string[];
  toZone: string[];
  originalSource: string[];
  originalDestination: string[];
  originalService: string[];
  originalDestinationInterface?: string;

  sourceTranslation?: SourceTranslation;
  destinationTranslation?: DestinationTranslation;

  bidirectional: boolean;
  noTranslation: boolean;

  hitCount: number;
  byteCount: number;
  comment?: string;
}

export type NatRuleType = 'static' | 'dynamic' | 'dynamic-pat' | 'nat64' | 'no-nat';

export interface SourceTranslation {
  kind: 'static-ip' | 'dynamic-ip' | 'dynamic-ip-and-port' | 'interface-address';
  pool?: string;
  translatedAddress?: string[];
  translatedPortRange?: PortRange;
  fallbackToInterface?: boolean;
  persistent?: boolean;
  roundRobin?: boolean;
}

export interface DestinationTranslation {
  kind: 'static-ip' | 'dynamic-ip';
  translatedAddress: string;
  translatedPort?: number;
  distributionMethod?: 'round-robin' | 'source-hash' | 'least-sessions';
}
```

### 12.3 Les types et leur sémantique

| Type | Effet | Bidirectionnel | Usage typique |
|---|---|---|---|
| `static` 1:1 | Une adresse ↔ une adresse | oui | Serveur publié |
| `static` avec port | Adresse:port ↔ adresse:port | oui | Publication de service |
| `dynamic` (pool) | N sources → M adresses, sans port | non | Rare |
| `dynamic-pat` | N sources → 1 adresse, ports réécrits | non | Sortie Internet |
| `interface-address` | Vers l'adresse de l'interface de sortie | non | Le cas le plus courant |
| `no-nat` | Exempte du NAT | — | Trafic VPN |
| `nat64` | IPv6 → IPv4 | non | Transition |

### 12.4 L'ordre relatif politique / NAT — la divergence structurante

C'est la divergence la plus visible entre constructeurs, et celle qui fait
échouer la moitié des laboratoires mal conçus.

| Vendeur | Ordre | Conséquence pour l'opérateur |
|---|---|---|
| **ASA 8.2 et antérieur** | ACL sur les adresses **traduites** | On écrit la règle avec l'adresse publique |
| **ASA 8.3 et postérieur** | Dé-NAT **avant** l'ACL → ACL sur les adresses **réelles** | On écrit la règle avec l'adresse privée |
| **FortiOS** | DNAT (VIP) **avant** le routage, politique après | La politique vise la VIP comme destination |
| **PAN-OS** | NAT évalué au *slowpath*, mais la politique de sécurité voit l'adresse **pré-NAT** et la zone **post-NAT** | Le piège classique du PCNSA |
| **Junos SRX** | DNAT avant la recherche de politique, SNAT après | La politique vise l'adresse post-DNAT |

**Absorption** : le profil déclare l'ordre des étapes du pipeline (§13), et
il déclare aussi, par un champ dédié, quelle version des adresses la
politique observe :

```ts
export interface NatPolicyOrder {
  destinationNatBeforePolicy: boolean;
  sourceNatBeforePolicy: boolean;
  policySeesPreNatSource: boolean;
  policySeesPreNatDestination: boolean;
  policySeesPostNatZone: boolean;
}
```

Cinq booléens suffisent à décrire les cinq comportements du tableau. C'est
la démonstration que P2 tient : la divergence la plus profonde du domaine
est une **donnée**.

### 12.5 Le NAT est-il un nouveau moteur ? — arbitrage

Trois options ont été considérées.

| Option | Description | Verdict |
|---|---|---|
| **A** | Réutiliser `router/NATEngine.ts` tel quel | **Rejetée** — son déclenchement est lié aux interfaces `inside`/`outside`, incompatible avec une politique NAT ordonnée |
| **B** | Étendre `router/NATEngine.ts` d'une politique ordonnée | **Rejetée** — ajouterait un second mode de déclenchement à un moteur déjà consommé par deux vendeurs de routeur ; risque de régression élevé sur du code mûr |
| **C** | Nouveau `FirewallNatEngine`, réutilisant les **primitives** de `NATEngine` | **Retenue** |

Ce qui est réutilisé de `router/NATEngine.ts`, par extraction en module
partagé plutôt que par copie :

| Primitive | Fichier cible |
|---|---|
| Réécriture d'adresse source / destination | `network/nat/rewrite.ts` |
| Recalcul de somme de contrôle L4 | idem |
| Allocation de port PAT et gestion du pool | `network/nat/portAllocator.ts` |
| Détection de *hairpin* | `network/nat/hairpin.ts` |

**Justification de l'extraction plutôt que de la copie** : le défaut n°2 de
`PRD-Port-Forwarding.md` phase 1 (somme de contrôle L4 non recalculée) était
présent en deux exemplaires — dans `NATEngine` et dans `EndHost` — et a dû
être corrigé deux fois, en phase 1 puis en phase 5. Un troisième exemplaire
dans le pare-feu reproduirait exactement ce coût.

Cette extraction est une **modification de code existant** et doit donc être
traitée avec précaution : phase dédiée, aucun changement de comportement,
suite de tests NAT existante verte avant et après.

### 12.6 Interaction NAT / sessions

Une session porte sa traduction :

```ts
export interface SessionTranslation {
  natRuleId: string;
  originalSource: string;      originalSourcePort: number;
  translatedSource: string;    translatedSourcePort: number;
  originalDest: string;        originalDestPort: number;
  translatedDest: string;      translatedDestPort: number;
}
```

**Invariant I-N1** : la traduction est décidée au premier paquet et
**mémorisée**. Les paquets suivants la réappliquent sans réévaluer la
politique NAT. C'est ce qui garantit qu'un flux PAT garde le même port
traduit pendant toute sa vie.

**Invariant I-N2** : le retour applique la traduction **inverse**, lue sur
la même session. C'est le défaut exact que `PRD-Port-Forwarding.md` phase 1
a corrigé sur le routeur (`translateOutbound()` sautait les entrées
statiques portant un protocole) et phase 5 sur `EndHost` (aucune table de
session de retour). Le socle pare-feu ne peut pas reproduire ce défaut parce
que la traduction vit sur la session, pas sur la règle.

**Invariant I-N3** : la libération du port PAT a lieu à la fermeture de la
session, pas avant. Un port libéré trop tôt serait réattribué à un flux
différent alors que l'ancien vit encore.

### 12.7 Le pool PAT et son épuisement

L'épuisement du pool est un cas de panne à part entière, comme
l'épuisement de la table de sessions (§10.7) :

| Situation | Comportement attendu |
|---|---|
| Pool plein, `fallbackToInterface` actif | Bascule sur l'adresse de l'interface |
| Pool plein, pas de repli | Nouvelle session refusée, motif distinct, journal dédié, compteur dédié |
| Port spécifique demandé et occupé | Refus, motif distinct |

### 12.8 Hairpin (NAT en épingle)

Un client interne qui atteint un serveur interne par son adresse publique.
RFC 5382 §5. `router/NATEngine.ts` le gère déjà et porte le champ
`outsideLocalIP` explicitement pour cela ; le socle pare-feu reprend le
mécanisme.

Le point à ne pas rater : le hairpin exige que le **SNAT** soit aussi
appliqué, sinon le serveur répond directement au client sans passer par le
pare-feu, et la session de retour n'est pas reconnue. C'est pourquoi les
vendeurs demandent une règle explicite (ASA : `same-security-traffic permit
intra-interface` + NAT ; FortiOS : `set nat-source-vip enable`).

### 12.9 Exigences — NAT

| # | Exigence | Priorité |
|---|---|---|
| **FR-NAT-01** | Politique NAT ordonnée, première correspondance gagnante | P0 |
| **FR-NAT-02** | NAT source statique, dynamique, PAT, adresse d'interface | P0 |
| **FR-NAT-03** | NAT destination statique avec traduction de port | P0 |
| **FR-NAT-04** | NAT statique bidirectionnel | P0 |
| **FR-NAT-05** | Règle `no-nat` d'exemption | P0 |
| **FR-NAT-06** | Ordre NAT / politique déclaré par le profil, cinq booléens | P0 |
| **FR-NAT-07** | Traduction mémorisée sur la session et réappliquée | P0 |
| **FR-NAT-08** | Traduction inverse sur le retour, lue sur la session | P0 |
| **FR-NAT-09** | Recalcul des sommes de contrôle IP et L4 | P0 |
| **FR-NAT-10** | Pool PAT avec allocation, libération à la fermeture | P0 |
| **FR-NAT-11** | Épuisement de pool : refus distinct, journal, compteur | P1 |
| **FR-NAT-12** | Repli sur l'adresse d'interface si déclaré | P1 |
| **FR-NAT-13** | Hairpin avec SNAT | P1 |
| **FR-NAT-14** | Compteurs par règle NAT | P1 |
| **FR-NAT-15** | Vue des traductions actives | P0 |
| **FR-NAT-16** | Purge sélective des traductions | P1 |
| **FR-NAT-17** | Extraction des primitives partagées sans régression | P0 |
| **FR-NAT-18** | NAT64 | P3 |

---

## 13. Le pipeline de traitement du paquet

> C'est ici que le socle prouve sa valeur : quatre ordres d'opérations
> différents, un seul moteur.

### 13.1 Le principe

Le pipeline est une `FilterChain<PacketContext>` composée à partir d'une
liste ordonnée de noms d'étapes, fournie par le `FirewallProfile`.

```ts
export interface FirewallProfile {
  vendor: 'asa' | 'fortios' | 'panos' | 'junos' | 'generic';
  pipeline: PipelineStageName[];
  natOrder: NatPolicyOrder;
  implicitPolicy: 'deny-all' | 'security-level';
  policyKeyedBy: 'zone' | 'interface';
  applicationShift: boolean;
  selfTrafficHandling: SelfTrafficMode;
  defaults: FirewallDefaults;
  timeouts: SessionTimeouts;
  limits: SessionTableLimits;
  // …
}
```

Ajouter un vendeur, c'est écrire un profil ; ce n'est pas modifier le
moteur.

### 13.2 Le catalogue d'étapes

Chaque étape est un `Filter<PacketContext>` nommé, écrit une fois.

| Étape | Rôle | Verdicts possibles |
|---|---|---|
| `ingress-sanity` | Somme de contrôle, version, IHL, longueur | `continue`, `drop` |
| `ingress-zone` | Détermine la zone d'entrée | `continue`, `drop` |
| `screen-ingress` | Protections volumétriques et anomalies (§18) | `continue`, `drop` |
| `defrag` | Réassemblage IPv4 | `continue`, `drop` |
| `session-lookup` | Cherche une session existante | `continue` (lent), `fastpath` |
| `tcp-state-check` | Machine à états TCP | `continue`, `drop`, `reset` |
| `nat-destination` | NAT de destination | `continue`, `transform` |
| `route-lookup` | Décision de routage, détermine l'interface et la zone de sortie | `continue`, `drop` |
| `egress-zone` | Détermine la zone de sortie | `continue` |
| `self-traffic` | Trafic destiné au pare-feu | `continue`, `accept`, `drop` |
| `policy-lookup` | Recherche de politique | `continue`, `drop`, `reset` |
| `nat-source` | NAT source | `continue`, `transform` |
| `session-install` | Installe la session | `continue` |
| `alg-inspect` | Inspection applicative (§15) | `continue`, `transform`, `drop` |
| `app-id` | Identification applicative (§16) | `continue`, `policy-relookup` |
| `content-inspect` | Profils de sécurité (§17) | `continue`, `drop`, `reset` |
| `shaping` | QoS (§25) | `continue`, `drop` |
| `ttl-decrement` | Décrément TTL, recalcul de somme de contrôle | `continue`, `drop` (TTL expiré) |
| `fragment` | Fragmentation si MTU inférieur | `continue`, `transform`, `drop` |
| `egress` | Émission | `accept` |

### 13.3 Le pipeline générique

```
ingress-sanity
ingress-zone
screen-ingress
defrag
session-lookup ──── fastpath ──▶ ttl-decrement ▶ fragment ▶ egress
   │ (chemin lent)
tcp-state-check
nat-destination
route-lookup
egress-zone
self-traffic
policy-lookup
nat-source
session-install
alg-inspect
app-id
content-inspect
shaping
ttl-decrement
fragment
egress
```

### 13.4 Le pipeline ASA

```
ingress-sanity
ingress-zone            (niveau de sécurité de l'interface)
session-lookup ──── fastpath ──▶ …
tcp-state-check
nat-destination         ← « untranslate » : AVANT la politique (8.3+)
policy-lookup           ← ACL sur les adresses RÉELLES
route-lookup
egress-zone
nat-source
session-install
alg-inspect             ← MPF / inspect
ttl-decrement
egress
```

Ce que ce pipeline enseigne, et qui est la question d'entretien classique :
sur ASA 8.3+, l'ACL est écrite avec l'adresse **réelle** du serveur, pas son
adresse publique. Le profil ASA déclare donc :

```
natOrder: {
  destinationNatBeforePolicy: true,
  sourceNatBeforePolicy: false,
  policySeesPreNatSource: true,
  policySeesPreNatDestination: false,   // elle voit l'adresse dé-NATée
  policySeesPostNatZone: true,
}
```

**Point mesuré et important** : le routage sur ASA a lieu **après** l'ACL,
contrairement aux trois autres. C'est une particularité réelle et elle a une
conséquence observable — un paquet refusé par l'ACL n'a jamais consommé de
décision de routage, donc le compteur de routage ne bouge pas. Le socle
doit reproduire cela, et c'est possible sans code spécial puisque l'ordre
est une donnée.

Nuance à écrire dans le profil : l'ASA effectue en réalité une
pré-recherche de route pour déterminer l'interface de sortie avant l'ACL
dans certains cas (NAT identity, routage par interface). Le socle modélise
l'ordre nominal documenté, et cette nuance est **déclarée hors périmètre**
en §43 plutôt que simulée à moitié.

### 13.5 Le pipeline FortiOS

```
ingress-sanity
ingress-zone
defrag
session-lookup ──── fastpath ──▶ …
tcp-state-check
nat-destination         ← DNAT/VIP AVANT le routage, pour pouvoir router
route-lookup
egress-zone
policy-lookup           ← la politique vise la VIP
nat-source              ← `set nat enable` sur la politique elle-même
session-install
alg-inspect
app-id                  ← contrôle applicatif (profil ou politique)
content-inspect         ← UTM : flow-based ou proxy-based
shaping
ttl-decrement
egress
```

Le fait que FortiOS place le DNAT avant le routage est explicitement
documenté par Fortinet : « le DNAT doit avoir lieu avant le routage pour que
le FortiGate puisse router les paquets vers la bonne destination ». C'est
une justification causale, pas une convention, et elle vaut d'être enseignée.

Le mode d'inspection (`flow-based` / `proxy-based`) est un champ de la
politique chez FortiOS, absorbé par `SecurityProfileRefs.inspectionMode`.

### 13.6 Le pipeline PAN-OS

```
ingress-sanity
ingress-zone
screen-ingress          ← zone protection profile
defrag
session-lookup ──── fastpath ──▶ content-inspect ▶ egress
   │ (slowpath)
tcp-state-check
route-lookup            ← FIB, détermine la zone de destination
egress-zone
nat-destination         ← évalué, appliqué à l'egress
policy-lookup           ← adresse PRÉ-NAT, zone POST-NAT
session-install
nat-source
app-id                  ← identification, puis RE-RECHERCHE de politique
content-inspect         ← Content-ID
shaping
egress
```

`applicationShift: true` dans le profil PAN-OS. La re-recherche est ce qui
produit le comportement le plus déroutant du produit — une session
initialement autorisée par une règle `web-browsing` peut être refusée quand
App-ID détecte que le flux sur le port 80 est en réalité autre chose.

Ce comportement est **le** cas de recette du PCNSA, et il est simulable
parce que le socle porte `MatchOutcome = 'pending'` et l'étape
`policy-relookup`.

### 13.7 Le pipeline Junos SRX

```
ingress-sanity
ingress-zone
screen-ingress          ← screens, attachés à la zone
defrag
session-lookup ──── fastpath ──▶ …
tcp-state-check
nat-destination         ← DNAT avant la recherche de politique
route-lookup
egress-zone
self-traffic            ← host-inbound-traffic, DANS la zone
policy-lookup
nat-source              ← SNAT après la politique
session-install
alg-inspect
app-id                  ← dynamic-application, avec re-recherche
content-inspect
ttl-decrement
egress
```

La position de `self-traffic` **dans** la zone est la particularité Junos :
`host-inbound-traffic` se déclare au niveau de la zone (ou de l'interface),
et non par une politique séparée. C'est ce que le champ
`selfTrafficHandling` du profil déclare :

```ts
export type SelfTrafficMode =
  | 'zone-host-inbound'   // Junos
  | 'local-in-policy'     // FortiOS
  | 'control-plane-acl'   // ASA
  | 'management-profile'; // PAN-OS
```

### 13.8 Le chemin rapide

Une session trouvée court-circuite l'essentiel du pipeline. Ce que le chemin
rapide **fait quand même** :

| Opération | Toujours | Pourquoi |
|---|---|---|
| Machine à états TCP | oui | Un paquet invalide dans une session valide doit être rejeté |
| Réapplication de la traduction | oui | Lue sur la session, non réévaluée |
| Compteurs et rafraîchissement | oui | Sinon la session mourrait |
| Inspection de contenu | selon profil | PAN-OS et FortiOS inspectent en continu |
| Recherche de politique | **non** | Invariant P9 |
| Recherche de route | **non** | Mémorisée sur la session |
| Recherche NAT | **non** | Mémorisée sur la session |

**Invariant I-F1** : le chemin rapide ne consulte jamais `PolicyStore` ni
`NatPolicyStore`. C'est ce que mesure UC-4, et c'est vérifiable par
compteur.

Cas particulier à traiter : que se passe-t-il si la route mémorisée n'est
plus valable (lien tombé) ? Les vendeurs divergent — certains invalident la
session, d'autres la laissent mourir d'expiration. Champ de profil :
`invalidateSessionOnRouteChange: boolean`.

### 13.9 La re-recherche de politique

Déclenchée par `app-id` quand une application est identifiée et que
`applicationShift` est actif.

```
app-id identifie « ssl » puis « facebook-base »
   │
   ▼
policy-relookup avec ctx.identifiedApplication renseigné
   │
   ├── même règle          → rien ne change
   ├── règle différente,
   │   action allow        → la session change de règle, compteurs ajustés
   └── règle différente,
       action deny         → la session passe en `discard`, le flux est coupé
```

**Invariant I-F2** : la re-recherche n'a lieu qu'une fois par changement
d'application identifiée, pas à chaque paquet. Sinon le chemin rapide
n'existerait plus.

### 13.10 Traçage

Chaque étape ajoute une entrée à `ctx.trace` :

```ts
export interface PipelineTraceEntry {
  stage: string;
  verdict: string;
  detail?: string;
  matchedRuleId?: string;
  elapsedNs?: number;
}
```

Ce tableau est ce que rendent `packet-tracer input …` (ASA),
`diagnose debug flow` (FortiOS), `test security-policy-match` (PAN-OS) et
`show security match-policies` (Junos).

**Invariant I-F3 — l'outil de diagnostic lit la trace du chemin réel.** Il
n'existe aucun second moteur de simulation. Un `packet-tracer` est un
paquet synthétique injecté dans le **même** pipeline, avec l'émission
supprimée à la dernière étape. C'est la seule façon de garantir UC-6, et
c'est directement inspiré de la façon dont ce dépôt a résolu le même
problème pour `ip http access-class` (la fonction `synthTcpPacket` est
**exportée** depuis `VtyIncomingPolicy` « pour que deux synthèses ne rendent
pas deux verdicts pour la même liste »).

### 13.11 Exigences — pipeline

| # | Exigence | Priorité |
|---|---|---|
| **FR-PIP-01** | Pipeline composé à partir d'une liste d'étapes déclarée par le profil | P0 |
| **FR-PIP-02** | Chaque étape est un filtre nommé, écrit une fois | P0 |
| **FR-PIP-03** | Quatre profils vendeur reproduisant quatre ordres réels | P0 |
| **FR-PIP-04** | Chemin rapide ne consultant ni politique ni NAT | P0 |
| **FR-PIP-05** | Compteurs distincts chemin lent / chemin rapide | P0 |
| **FR-PIP-06** | Trace complète remplie à chaque paquet | P0 |
| **FR-PIP-07** | Outil de diagnostic injectant dans le pipeline réel | P0 |
| **FR-PIP-08** | Re-recherche de politique sur identification applicative | P2 |
| **FR-PIP-09** | Motif de rejet distinct par étape | P0 |
| **FR-PIP-10** | Événements de bus à l'entrée et à la sortie du pipeline | P1 |
| **FR-PIP-11** | Comportement déclaré en cas de changement de route | P2 |
| **FR-PIP-12** | Aucun branchement conditionnel par vendeur dans le moteur | P0 |

---

## 14. Modes de déploiement

### 14.1 Les quatre modes

| Mode | Le pare-feu est… | Interfaces | Visible en `traceroute` |
|---|---|---|---|
| **Routé** | un saut IP | adressées | oui |
| **Transparent** | un pont L2 | non adressées, une IP de gestion | non |
| **Virtual wire** | un fil filtré | non adressées, appairées | non |
| **Tap** | un observateur passif | une, en promiscuité | non |

### 14.2 Mode routé

Le mode par défaut. Le pare-feu route, répond à l'ARP pour ses adresses,
décrémente le TTL, et apparaît dans un `traceroute`.

C'est le mode que `Firewall extends Router` sert directement : la table de
routage, `lookupRoute()`, l'ARP et la réponse ICMP sont hérités.

### 14.3 Mode transparent

Le pare-feu devient un pont : il apprend les adresses MAC, commute entre ses
interfaces, et filtre au passage. Il ne décrémente pas le TTL et n'apparaît
pas dans un `traceroute` — d'où son surnom de *stealth firewall*.

#### 14.3.1 Ce qu'il faut construire

| Besoin | Existant réutilisable |
|---|---|
| Table d'adresses MAC | `Switch.ts` en possède une, réelle |
| Commutation entre interfaces | `Switch.floodFrame`, `Switch.egressOnVlan` |
| Interface virtuelle de pont (BVI/SVI) | `SwitchSvi.ts` — le patron exact |
| Filtrage au passage | Le pipeline du socle |

**Décision** : le mode transparent ne réimplémente pas la commutation. Il
délègue à la même mécanique que `Switch`, en insérant le pipeline du
pare-feu entre l'apprentissage et l'émission.

Difficulté d'architecture à signaler honnêtement : `Router` et `Switch`
n'ont **aucune base L3 commune** (les deux étendent `Equipment`), ce que le
dépôt a déjà rencontré en câblant le NAT sur un commutateur L3 Huawei — il a
fallu ajouter trois méthodes optionnelles à `SviHost`. Le mode transparent
rencontrera la même frontière. Il est donc placé en phase 6, après que le
mode routé a stabilisé les moteurs.

#### 14.3.2 Le groupe de pont

```ts
export interface BridgeGroup {
  id: number;
  name?: string;
  interfaces: string[];
  bviAddress?: string;
  bviMask?: string;
  macTable: Map<string, BridgeMacEntry>;
  macAgingSec: number;
  learningEnabled: boolean;
}
```

Sur ASA, chaque groupe de pont a une BVI qui **doit** porter une adresse
pour que le trafic passe. Sur FortiOS en mode transparent, l'appareil entier
a une seule adresse de gestion. Champ de profil : `bridgeAddressing`.

#### 14.3.3 Le trafic non-IP

Un pont transparent voit passer des trames qui ne sont pas IP : ARP, STP,
CDP, LLDP, IPX. Le comportement par défaut diverge :

| Vendeur | ARP | STP (BPDU) | Autre non-IP |
|---|---|---|---|
| ASA | traversée contrôlée par `arp-inspection` | traversée par ACL EtherType | ACL EtherType |
| FortiOS | traversée | traversée si `set stpforward enable` | selon politique |
| PAN-OS (vwire) | traversée | option `link-state-pass-through` | option |

**Décision** : le socle porte une politique EtherType distincte de la
politique IP, ce qui est la modélisation ASA et couvre les autres. Une trame
non-IP est évaluée par cette politique et jamais par la politique de
sécurité.

Ce point est pédagogiquement important : la raison numéro un d'échec d'un
déploiement transparent est que les BPDU ne traversent pas et qu'une boucle
se forme. C'est un excellent laboratoire de panne au sens de
`PRD-Pannes.md`.

### 14.4 Virtual wire

Deux interfaces soudées. Tout ce qui entre par l'une sort par l'autre, après
filtrage. Pas d'apprentissage MAC, pas de routage, pas de participation à
STP. C'est le mode d'insertion le plus simple et le plus fréquent en
première installation d'un PAN-OS.

```ts
export interface VirtualWire {
  name: string;
  interface1: string;
  interface2: string;
  taggedVlans: number[] | 'all';
  multicastFirewalling: boolean;
  linkStatePassThrough: boolean;
}
```

`linkStatePassThrough` mérite d'être simulé : quand une des deux interfaces
tombe, l'autre est administrativement abaissée, pour que les équipements
voisins voient la panne. Sans cela, un routeur voisin continuerait d'envoyer
du trafic dans un trou noir. C'est un comportement réel, observable, et
directement lié au chapitre pannes.

### 14.5 Mode tap

Le pare-feu reçoit une copie du trafic (port SPAN) et **n'émet rien**. Il
identifie, journalise, mais ne bloque pas.

Le dépôt possède déjà `Switch.emitMirror` (SPAN). Le mode tap est donc peu
coûteux et pédagogiquement utile : il montre ce qu'un pare-feu *verrait*
sans être en coupure, ce qui est exactement la démarche d'un déploiement
progressif.

**Invariant I-D1** : en mode tap, aucune trame ne quitte le pare-feu. Un
mode tap qui émettrait serait un défaut grave et doit être testé
explicitement (compteur d'émission à zéro).

### 14.6 Cohabitation des modes

Sur un même appareil :

| Vendeur | Modes simultanés |
|---|---|
| ASA | Non — l'appareil entier est routé **ou** transparent (par contexte) |
| FortiOS | Par VDOM ; plus les paires *virtual wire* dans un VDOM NAT |
| PAN-OS | Oui — chaque interface a son mode (L3, L2, vwire, tap) |
| Junos | Oui — `packet-mode` par interface |

**Absorption** : `deploymentScope: 'device' | 'context' | 'interface'` dans
le profil.

### 14.7 Exigences — modes de déploiement

| # | Exigence | Priorité |
|---|---|---|
| **FR-DEP-01** | Mode routé complet | P0 |
| **FR-DEP-02** | Mode transparent avec groupes de pont et BVI | P2 |
| **FR-DEP-03** | Apprentissage MAC et vieillissement en mode transparent | P2 |
| **FR-DEP-04** | Politique EtherType distincte pour le trafic non-IP | P2 |
| **FR-DEP-05** | Pas de décrément TTL en transparent et vwire | P2 |
| **FR-DEP-06** | Paires virtual wire, avec VLAN autorisés | P2 |
| **FR-DEP-07** | Propagation d'état de lien sur une paire vwire | P2 |
| **FR-DEP-08** | Mode tap n'émettant jamais | P3 |
| **FR-DEP-09** | Portée du mode déclarée par le profil | P2 |
| **FR-DEP-10** | Refuser une interface dans une zone incompatible avec son mode | P2 |

---

## 15. Inspection applicative et ALG

### 15.1 Ce qu'un ALG fait vraiment

Trois choses, et il faut les distinguer parce qu'elles ont des difficultés
très différentes :

| Fonction | Difficulté | Exemple |
|---|---|---|
| **Ouvrir un flux secondaire** (*pinhole*) | Moyenne | FTP `PORT`, SIP `INVITE` |
| **Réécrire une adresse dans la charge utile** | Élevée | FTP `PORT 192,168,1,10,4,1` derrière NAT |
| **Valider la conformité au protocole** | Faible à moyenne | Rejeter une commande FTP inconnue |

### 15.2 L'existant

`src/network/devices/router/nat/FtpAlg.ts` est un **vrai ALG FTP**,
livré sous `PRD-FTP-SFTP.md`. C'est la seule inspection applicative du
dépôt, et elle démontre que les trois fonctions ci-dessus sont réalisables
dans ce simulateur.

Le socle en tire un **cadre** plutôt qu'un second exemplaire.

### 15.3 Le cadre d'ALG

```ts
export interface Alg {
  readonly name: string;
  readonly defaultPorts: ServiceEntry[];
  readonly direction: 'c2s' | 's2c' | 'both';

  onSessionCreated?(session: FirewallSession, ctx: AlgContext): void;
  onPayload?(session: FirewallSession, data: Uint8Array,
             direction: 'c2s' | 's2c', ctx: AlgContext): AlgVerdict;
  onSessionClosed?(session: FirewallSession, ctx: AlgContext): void;
}

export interface AlgContext {
  openPinhole(spec: PinholeSpec): FirewallSession;
  closePinhole(sessionId: number): void;
  rewritePayload(replacement: Uint8Array): void;
  translationFor(address: string, port: number): TranslatedEndpoint | null;
  log(event: AlgLogEvent): void;
}

export type AlgVerdict =
  | { kind: 'pass' }
  | { kind: 'rewrite'; payload: Uint8Array }
  | { kind: 'drop'; reason: string }
  | { kind: 'reset'; reason: string };
```

`translationFor` est le point clé : un ALG qui réécrit une adresse doit
savoir **quelle** adresse traduite utiliser, et cette information vit sur la
session (§12.6). Sans cette méthode, l'ALG devrait interroger le moteur NAT
directement et rouvrirait la porte à deux réponses possibles.

### 15.4 Le catalogue d'ALG

| ALG | Fonction principale | Priorité | Faisabilité mesurée |
|---|---|---|---|
| **FTP** | Pinhole + réécriture `PORT`/`227` | P0 | Existe déjà (`FtpAlg.ts`) |
| **TFTP** | Pinhole sur le port de données | P1 | Simple |
| **ICMP erreur** | Association à la session fautive | P0 | Nécessaire pour `traceroute` |
| **DNS** | Contrôle de longueur, réécriture d'adresse (doctoring) | P1 | Codec DNS réel disponible |
| **PPTP** | Pinhole GRE | P2 | `gre/GreAgent.ts` existe |
| **SIP** | Pinhole RTP + réécriture SDP | P3 | Aucun trafic SIP dans le dépôt |
| **H.323** | idem | P3 | idem |
| **RTSP** | Pinhole | P3 | idem |
| **SQLNet** | Redirection Oracle | P3 | Le moteur Oracle existe mais pas son protocole réseau |
| **SMTP/ESMTP** | Filtrage de commandes | P2 | `PRD-SMTP.md` existe |
| **HTTP** | Décodage d'URL, inspection d'en-têtes | P1 | `http/` réel |

**Décision de périmètre** : les ALG marqués P3 sont **refusés
explicitement** plutôt qu'acceptés sans effet, conformément à P4. Un
`inspect sip` accepté et inerte ferait croire à un contrôle qui n'a pas
lieu — le pire des trois choix.

### 15.5 Le pinhole

```ts
export interface PinholeSpec {
  source?: string;  sourcePort?: number;
  destination: string; destinationPort: number;
  protocol: number;
  ingressZone: string;
  egressZone: string;
  timeoutSec: number;
  parentSessionId: number;
  singleUse: boolean;
  algName: string;
}
```

**Invariants** :

| # | Invariant |
|---|---|
| **I-A1** | Un pinhole est une session, visible dans la table, marquée `isPinhole` |
| **I-A2** | Un pinhole a une durée de vie courte tant qu'il n'est pas consommé |
| **I-A3** | `singleUse` : le pinhole disparaît dès qu'une session le consomme |
| **I-A4** | La fermeture du parent ferme les pinholes non consommés |
| **I-A5** | Un pinhole ne contourne pas la politique de zone du profil s'il le déclare — certains vendeurs vérifient quand même |

L'invariant I-A5 mérite un mot : les vendeurs divergent sur la question
« un pinhole contourne-t-il la politique ? ». La réponse est en général oui
(c'est son but), mais avec des garde-fous. Champ de profil :
`pinholeBypassesPolicy: boolean`.

### 15.6 L'ALG FTP en détail — le cas de référence

Parce qu'il existe déjà et qu'il sert de gabarit :

```
Client (inside)                 Pare-feu                 Serveur (outside)
     │                              │                            │
     │──── TCP/21 SYN ─────────────▶│───── session ctrl ────────▶│
     │                              │                            │
     │──── PORT 10,0,0,5,20,10 ────▶│                            │
     │                        ALG lit la commande                │
     │                        traduit 10.0.0.5:5130              │
     │                        → 203.0.113.1:41000                │
     │                        RÉÉCRIT la charge utile            │
     │                        OUVRE un pinhole                   │
     │                        (203.0.113.1:41000 ←               │
     │                         serveur:20, TCP)                  │
     │                              │──── PORT 203,0,113,1,… ───▶│
     │                              │                            │
     │◀───── données TCP/20 ────────│◀─────── SYN vers 41000 ────│
     │                        le pinhole reconnaît               │
     │                        et DNAT vers 10.0.0.5:5130         │
```

Ce schéma montre les trois fonctions simultanément, et pourquoi elles sont
indissociables : sans réécriture, le serveur enverrait vers une adresse
privée ; sans pinhole, la connexion serait refusée ; sans validation, une
commande `PORT` forgée ouvrirait un passage arbitraire — la faille FTP
bounce, qu'un ALG correct refuse en vérifiant que l'adresse annoncée est
celle du client.

**Ce dernier point est un cas de recette** : `PORT` annonçant une adresse
autre que celle du client doit être refusé.

### 15.7 Exigences — ALG

| # | Exigence | Priorité |
|---|---|---|
| **FR-ALG-01** | Cadre d'ALG enregistrable, appelé par l'étape `alg-inspect` | P0 |
| **FR-ALG-02** | Migration de `FtpAlg.ts` sur le cadre, sans régression | P1 |
| **FR-ALG-03** | Ouverture de pinhole visible dans la table de sessions | P0 |
| **FR-ALG-04** | Fermeture des pinholes à la fermeture du parent | P0 |
| **FR-ALG-05** | Réécriture de charge utile avec traduction lue sur la session | P1 |
| **FR-ALG-06** | Association d'un ICMP d'erreur à sa session | P0 |
| **FR-ALG-07** | ALG TFTP | P1 |
| **FR-ALG-08** | ALG DNS avec contrôle de longueur | P1 |
| **FR-ALG-09** | Refus de la commande FTP `PORT` annonçant une autre adresse | P1 |
| **FR-ALG-10** | Activation/désactivation par ALG, avec effet observable | P0 |
| **FR-ALG-11** | Refus explicite des ALG non simulés | P0 |
| **FR-ALG-12** | Compteurs par ALG | P1 |

---

## 16. Identification NGFW

### 16.1 Le principe et la limite honnête

Un pare-feu de nouvelle génération identifie **l'application**,
**l'utilisateur** et **le contenu**, indépendamment du port.

Ce simulateur ne fait circuler aucun contenu réel au sens d'un fichier ou
d'une charge utile applicative complète. L'identification applicative y sera
donc **structurellement** plus simple que dans la réalité. Cette limite est
déclarée ici plutôt que découverte plus tard.

Ce qui est néanmoins réel et exploitable :

| Source de signal | Réalité dans ce dépôt |
|---|---|
| Ports et protocole | Réels |
| Poignée de main TLS et SNI | **Réels** — la pile TLS est réelle depuis les travaux crypto |
| Requêtes HTTP (méthode, hôte, URI, en-têtes) | **Réelles** — `http/` et `Http1Wire` |
| Requêtes DNS | **Réelles** — codec de fil réel |
| Bannières applicatives (SSH, SMTP, FTP) | **Réelles** |
| Charge utile binaire arbitraire | Absente |

### 16.2 Identification applicative

```ts
export interface ApplicationSignature {
  name: string;
  category: string;
  subcategory?: string;
  technology?: string;
  risk: 1 | 2 | 3 | 4 | 5;
  defaultPorts: ServiceEntry[];
  dependsOn?: string[];
  matchers: AppMatcher[];
  evasive: boolean;
  tunnelsOtherApps: boolean;
}

export type AppMatcher =
  | { kind: 'port'; entries: ServiceEntry[] }
  | { kind: 'tls-sni'; pattern: string }
  | { kind: 'http-host'; pattern: string }
  | { kind: 'http-uri'; pattern: string }
  | { kind: 'banner'; pattern: string }
  | { kind: 'dns-query'; pattern: string };
```

#### 16.2.1 L'identification progressive

C'est le comportement à reproduire, parce qu'il est la source du
comportement observable d'un NGFW :

```
paquet 1 (SYN)              → application = inconnue
paquet 2-3 (handshake)      → application = inconnue
paquet 4 (ClientHello TLS)  → application = « ssl »
                              SNI = « www.facebook.com »
                            → application = « facebook-base »
                            → RE-RECHERCHE de politique
```

Le fait que l'application soit d'abord `ssl` puis se précise est exactement
ce que PAN-OS appelle *application shift*, et c'est ce que le socle porte
via `MatchOutcome = 'pending'` (§11.5).

#### 16.2.2 Les dépendances applicatives

`facebook-base` dépend de `web-browsing` et de `ssl`. Une règle autorisant
`facebook-base` sans autoriser ses dépendances ne fonctionne pas — piège
classique, et excellent exercice.

**Décision** : le champ `dependsOn` est porté, et la vérification est faite
à l'écriture de la règle avec un **avertissement** (pas un refus), comme le
fait PAN-OS.

#### 16.2.3 Ce qui est refusé

L'identification par inspection de motifs binaires, l'analyse heuristique,
la détection de tunnels par analyse statistique. Ces mécanismes n'ont pas de
matière dans ce simulateur ; les implémenter produirait un moteur qui
« détecte » ce qu'on lui a dit de détecter, ce qui n'enseigne rien.

### 16.3 Identification d'utilisateur

```ts
export interface UserIdentityMapping {
  ip: string;
  user: string;
  domain?: string;
  groups: string[];
  source: UserIdSource;
  learnedAt: number;
  expiresAt: number;
}

export type UserIdSource =
  | 'agent'          // lecture de journaux d'un contrôleur de domaine
  | 'captive-portal'
  | 'radius-accounting'
  | 'syslog-parsing'
  | 'api'
  | 'static';
```

**Ce qui est réellement branchable dans ce dépôt** :

| Source | Brique existante | Verdict |
|---|---|---|
| RADIUS accounting | `radius/` réel, `CoaClient.ts` | Faisable |
| Journal de contrôleur de domaine | `windows/server/ad/` réel, journal d'événements réel | Faisable |
| Portail captif | `http/` réel, `dot1x/` réel | Faisable |
| Analyse de syslog | `syslog/SyslogAgent.ts` réel | Faisable |
| Mappage statique | trivial | Faisable |

L'identification d'utilisateur est donc, contre l'intuition, **plus
faisable** que l'identification applicative dans ce simulateur, parce que
toutes ses sources existent déjà.

**Invariant I-U1** : une règle référençant un utilisateur ne correspond
jamais si aucun mappage n'existe pour l'adresse source. Elle ne correspond
pas non plus « à tout ». C'est le comportement réel et sa transgression
serait une faille enseignée.

**Invariant I-U2** : un mappage expire. Un utilisateur déconnecté dont
l'adresse est réattribuée ne doit pas transmettre ses droits au suivant.

### 16.4 Identification de contenu

Traité en §17 (profils de sécurité), parce que le contenu n'est pas un
critère de correspondance de règle mais une action appliquée après.

### 16.5 Exigences — identification

| # | Exigence | Priorité |
|---|---|---|
| **FR-APP-01** | Catalogue de signatures applicatives déclaré, par vendeur | P2 |
| **FR-APP-02** | Identification par port, SNI TLS, hôte/URI HTTP, bannière, requête DNS | P2 |
| **FR-APP-03** | Identification progressive avec précision successive | P2 |
| **FR-APP-04** | Dépendances applicatives, avertissement à l'écriture | P3 |
| **FR-APP-05** | Application mémorisée sur la session | P2 |
| **FR-APP-06** | Refus explicite des mécanismes d'identification non simulés | P2 |
| **FR-USR-01** | Table de mappage IP → utilisateur, avec source et expiration | P2 |
| **FR-USR-02** | Alimentation par RADIUS accounting réel | P2 |
| **FR-USR-03** | Alimentation par journal de contrôleur de domaine | P3 |
| **FR-USR-04** | Alimentation par portail captif | P3 |
| **FR-USR-05** | Mappage statique | P2 |
| **FR-USR-06** | Règle utilisateur sans mappage → aucune correspondance | P2 |
| **FR-USR-07** | Expiration des mappages | P2 |
| **FR-USR-08** | Vue de la table de mappage | P2 |

---

## 17. Profils de sécurité

### 17.1 Position honnête

Un profil de sécurité (antivirus, IPS, filtrage web, anti-espion, filtrage
de fichiers, DLP) est, dans ce simulateur, un **cadre** : le point
d'accroche, le verdict, le journal et le compteur sont réels ; le moteur de
détection ne l'est pas.

Ce choix est délibéré et découle du non-objectif N1. Un moteur de signatures
qui détecterait un maliciel dans un flux où aucun octet de maliciel ne
circule serait une mise en scène. En revanche, **le cadre a une valeur
pédagogique réelle** : l'apprenant apprend où s'attache un profil, ce que
produit un verdict, comment le lire dans les journaux, et comment le
diagnostiquer.

### 17.2 Le modèle

```ts
export interface SecurityProfile {
  name: string;
  kind: SecurityProfileKind;
  defaultAction: ProfileAction;
  rules: ProfileRule[];
  logging: 'none' | 'block' | 'all';
  readonly predefined: boolean;
}

export type SecurityProfileKind =
  | 'antivirus' | 'ips' | 'anti-spyware' | 'url-filtering'
  | 'file-blocking' | 'dns-security' | 'dos-protection' | 'data-filtering';

export type ProfileAction =
  | 'allow' | 'alert' | 'block' | 'drop' | 'reset-client'
  | 'reset-server' | 'reset-both' | 'quarantine' | 'continue' | 'override';

export interface SecurityProfileGroup {
  name: string;
  profiles: Partial<Record<SecurityProfileKind, string>>;
}
```

### 17.3 Ce qui est réellement simulable

| Profil | Mécanisme de déclenchement réel disponible | Verdict |
|---|---|---|
| **Filtrage d'URL** | L'URL HTTP est réelle ; le SNI TLS est réel | **Simulable pour de bon** |
| **Filtrage DNS** | Les requêtes DNS sont réelles | **Simulable pour de bon** |
| **Blocage de fichiers** | L'extension et le `Content-Type` HTTP sont réels | **Simulable pour de bon** |
| **Antivirus** | Aucun contenu réel | Cadre seulement — voir 17.4 |
| **IPS** | Aucune charge utile d'exploit | Cadre seulement |
| **Anti-espion** | Détection par requête DNS vers un domaine déclaré | **Partiellement simulable** |
| **DLP** | Aucun contenu réel | Cadre seulement |

C'est un résultat intéressant et qui mérite d'être souligné : **trois
profils sur huit sont pleinement simulables**, parce que ce dépôt possède
un vrai HTTP, un vrai DNS et un vrai TLS. Le filtrage web par catégories est
donc un laboratoire complet et honnête.

### 17.4 Le fichier de test EICAR — la seule détection honnête

Il existe une façon de rendre un antivirus **réellement** démontrable :
le fichier de test EICAR, une chaîne ASCII de 68 octets, conçue précisément
pour tester une chaîne antivirus sans utiliser de code malveillant. Elle
est publique, inoffensive, et tous les antivirus réels la détectent.

**Décision** : l'antivirus du socle détecte la chaîne EICAR, et rien
d'autre. Un transfert HTTP ou FTP contenant cette chaîne est bloqué, avec
le journal et le compteur correspondants ; tout autre contenu passe.

C'est honnête (le comportement est exactement celui d'un vrai antivirus face
à EICAR), c'est démontrable (l'apprenant peut fabriquer le fichier lui-même
avec `echo`), et cela évite la mise en scène. La limite est écrite : ce
n'est pas un antivirus, c'est la démonstration de la chaîne de traitement.

### 17.5 Le filtrage d'URL par catégories

```ts
export interface UrlFilteringProfile extends SecurityProfile {
  categoryActions: Map<string, ProfileAction>;
  allowList: string[];
  blockList: string[];
  logContainerPageOnly: boolean;
  safeSearchEnforcement: boolean;
  credentialDetection?: 'disabled' | 'ip-user' | 'domain-credential';
}
```

La base de catégories est une **table déclarée**, versionnée dans le dépôt,
et non un service en ligne. Elle contient quelques centaines de domaines
répartis en catégories réalistes (`social-networking`, `streaming-media`,
`malware`, `phishing`, `gambling`, `business-and-economy`, …).

Ce qui rend ce profil réel : le domaine est extrait du **vrai** `Host:`
HTTP ou du **vrai** SNI TLS, la catégorie est cherchée dans la table, et
l'action est appliquée. Un site absent de la table tombe dans `unknown`,
dont l'action est configurable — comportement réel et piège classique.

Les actions `continue` et `override` (page d'avertissement que
l'utilisateur peut franchir) sont réalisables puisque le pare-feu peut
répondre une page HTTP. C'est un excellent exercice.

### 17.6 Le mode d'inspection

FortiOS distingue `flow-based` et `proxy-based` :

| Mode | Mécanisme | Conséquence observable |
|---|---|---|
| `flow-based` | Le pare-feu inspecte au fil de l'eau | Latence faible, certaines fonctions indisponibles |
| `proxy-based` | Le pare-feu termine la connexion et en ouvre une seconde | Deux sessions au lieu d'une, fonctions complètes |

**Décision** : le mode `proxy-based` est simulable et vaut d'être simulé,
parce que sa conséquence — **deux sessions TCP au lieu d'une** — est
directement visible dans la table de sessions, et c'est la meilleure
démonstration de ce qu'est un proxy. Le dépôt possède déjà un relais
socket-à-socket réel (`PortProxySocketProjection`, phase 7 de
`PRD-Port-Forwarding.md`) dont l'architecture est exactement celle-là.

### 17.7 Exigences — profils

| # | Exigence | Priorité |
|---|---|---|
| **FR-PRF-01** | Modèle de profil générique, attachable à une règle | P2 |
| **FR-PRF-02** | Groupes de profils | P2 |
| **FR-PRF-03** | Filtrage d'URL par catégories sur `Host:` HTTP et SNI TLS réels | P2 |
| **FR-PRF-04** | Table de catégories déclarée et versionnée | P2 |
| **FR-PRF-05** | Actions `allow`/`alert`/`block`/`continue`/`override` | P2 |
| **FR-PRF-06** | Page de blocage servie par le pare-feu | P3 |
| **FR-PRF-07** | Filtrage DNS sur requêtes réelles | P2 |
| **FR-PRF-08** | Blocage de fichiers par extension et type MIME | P3 |
| **FR-PRF-09** | Antivirus détectant EICAR, et rien d'autre, limite écrite | P3 |
| **FR-PRF-10** | IPS : cadre, verdicts et journaux, sans moteur de signatures | P3 |
| **FR-PRF-11** | Mode proxy-based créant deux sessions observables | P3 |
| **FR-PRF-12** | Compteurs et journaux par profil | P2 |

---

## 18. Protection contre les attaques volumétriques

### 18.1 Le concept

Distinct de la politique : ces protections s'appliquent **avant** toute
recherche de politique, à l'entrée de la zone, et visent les anomalies de
protocole et les volumes anormaux.

| Vendeur | Nom |
|---|---|
| Junos SRX | *screens* |
| PAN-OS | *zone protection profile* + *DoS protection policy* |
| FortiOS | *DoS policy* |
| ASA | *threat detection*, `set connection` |

### 18.2 Le modèle

```ts
export interface ScreenProfile {
  name: string;
  floodProtection: FloodProtection;
  anomalies: ProtocolAnomalyChecks;
  reconnaissance: ReconnaissanceChecks;
}

export interface FloodProtection {
  synFloodThresholdPps?: number;
  synFloodAlarmPps?: number;
  synCookieEnabled: boolean;
  udpFloodThresholdPps?: number;
  icmpFloodThresholdPps?: number;
  sessionRateThresholdPps?: number;
  action: 'alarm' | 'drop' | 'random-early-drop';
}

export interface ProtocolAnomalyChecks {
  ipSpoofing: boolean;
  landAttack: boolean;
  pingOfDeath: boolean;
  teardrop: boolean;
  tcpNoFlag: boolean;
  tcpSynFin: boolean;
  tcpFinNoAck: boolean;
  winnuke: boolean;
  ipSourceRoute: boolean;
  ipUnknownProtocol: boolean;
  fragmentOverlap: boolean;
  icmpLarge?: number;
}

export interface ReconnaissanceChecks {
  portScanThreshold?: number;
  portScanWindowSec?: number;
  addressSweepThreshold?: number;
  addressSweepWindowSec?: number;
  tcpSynAckAckProxy?: number;
}
```

### 18.3 Ce qui est réellement simulable, et pourquoi ce chapitre a de la valeur

Contrairement aux profils de sécurité (§17), **presque tout ce chapitre est
pleinement simulable**, parce que les anomalies portent sur des en-têtes que
ce simulateur construit vraiment :

| Contrôle | Signal | Simulable |
|---|---|---|
| LAND (source = destination) | En-tête IPv4 | **oui** |
| TCP sans drapeau (NULL scan) | En-tête TCP | **oui** |
| TCP SYN+FIN | En-tête TCP | **oui** |
| TCP FIN sans ACK (FIN scan) | En-tête TCP | **oui** |
| Xmas scan (FIN+PSH+URG) | En-tête TCP | **oui** |
| Ping of death (> 65535 après réassemblage) | Fragmentation réelle | **oui** |
| Teardrop (fragments chevauchants) | `Ipv4Reassembler` réel | **oui** |
| Usurpation d'adresse (RPF) | Table de routage réelle | **oui** |
| Balayage de ports | Table de sessions | **oui** |
| Balayage d'adresses | idem | **oui** |
| Inondation SYN | Compteur de demi-ouvertes | **oui** |
| Routage source IP | Option IPv4 | à vérifier — voir 18.4 |

**Ce chapitre est donc le meilleur rapport valeur/coût du module après le
socle lui-même.** Un laboratoire « lancer un scan nmap contre un pare-feu
correctement configuré » devient possible et honnête.

### 18.4 Les options IP — mesuré, et la conséquence

Question posée avant l'implémentation : `IPv4Packet` porte-t-il les options
IP ? Le contrôle de routage source (`ipSourceRoute`) et l'option
`record-route` en dépendent.

**Mesure** (`src/network/core/types.ts`, lignes 721-749) : l'interface porte
`ihl` — le champ qui *indiquerait* la présence d'options, puisque sa valeur
dépasse 5 quand il y en a — et **aucun champ pour les options elles-mêmes**.
Le champ suivant `destinationIP` est directement `payload`. Il n'existe donc
nulle part d'où lire une option IP.

**Conséquence, tranchée** : `ipSourceRoute` et `record-route` sont
**refusés explicitement** en nommant la brique manquante, conformément à P4.

```
% Screen option 'ip source-route-option' is not implemented in this simulator
  (IPv4Packet carries no options field — see docs/BRD-Firewall.md §18.4)
```

Ce que ce refus n'est **pas** : une impossibilité définitive. Ajouter
`options?: Ipv4Option[]` à `IPv4Packet` est un changement additif et
`ihl` porte déjà la sémantique qui l'accompagne. Mais c'est une
modification d'une structure consommée par tout le chemin de données du
dépôt, donc un chantier à part — pas un effet de bord du module pare-feu.

Les dix autres contrôles du tableau §18.3 sont inchangés : aucun ne dépend
des options.

### 18.5 SYN cookies

Mécanisme réel et démontrable : au-delà d'un seuil de connexions
demi-ouvertes, le pare-feu cesse d'allouer une session au SYN et répond un
SYN-ACK dont le numéro de séquence encode l'état. Seul un ACK légitime
permet de reconstruire la session.

C'est simulable avec la pile TCP existante, et c'est une excellente
démonstration : sous inondation SYN, la table de sessions **ne se remplit
pas**, et les connexions légitimes continuent de passer. La mesure est
directement lisible.

### 18.6 Exigences — protection

| # | Exigence | Priorité |
|---|---|---|
| **FR-SCR-01** | Profil de protection attachable à une zone | P2 |
| **FR-SCR-02** | Détection LAND, NULL, SYN+FIN, FIN sans ACK, Xmas | P2 |
| **FR-SCR-03** | Ping of death et teardrop sur le réassembleur réel | P2 |
| **FR-SCR-04** | Contrôle d'usurpation par RPF sur la table de routage | P2 |
| **FR-SCR-05** | Détection de balayage de ports et d'adresses, fenêtrée | P2 |
| **FR-SCR-06** | Seuils d'inondation SYN / UDP / ICMP, en alarme puis en rejet | P2 |
| **FR-SCR-07** | SYN cookies avec effet mesurable sur la table de sessions | P3 |
| **FR-SCR-08** | Compteur et journal distincts par type d'anomalie | P2 |
| **FR-SCR-09** | Refus explicite des contrôles dont la brique manque | P2 |

---

## 19. Routage sur pare-feu

### 19.1 Ce qui est hérité

`Firewall extends Router` (§7.3) apporte : table de routage, routes
statiques, `lookupRoute()`, ECMP, ARP, ICMP, IPsec.

### 19.2 Ce qui doit être ajouté

| Fonction | Raison |
|---|---|
| **Routeurs virtuels** | PAN-OS et FortiOS (par VDOM) séparent les tables de routage |
| **Routage par politique (PBR)** | Présent chez les quatre, avec des noms différents |
| **Surveillance de route / basculement** | `track` existe côté Cisco routeur ; à généraliser |
| **Route par session** | Une session mémorise son interface de sortie (§13.8) |

### 19.3 Les protocoles dynamiques

| Protocole | Disponible dans le dépôt | Sur pare-feu |
|---|---|---|
| Statique | oui | P0 |
| OSPFv2 | oui, réel | P2 |
| OSPFv3 | oui, réel | P3 |
| BGP | oui | P3 |
| RIP | oui | P3 |
| EIGRP | oui (sans Active/Query) | Hors périmètre — propriétaire Cisco, sans intérêt sur ASA hors cas rares |

Les moteurs existent. Le travail est de les brancher sur le pare-feu et sur
la grammaire CLI de chaque vendeur, pas de les réécrire.

### 19.4 Exigences — routage

| # | Exigence | Priorité |
|---|---|---|
| **FR-RTG-01** | Routes statiques avec distance et surveillance | P0 |
| **FR-RTG-02** | Route par défaut | P0 |
| **FR-RTG-03** | Table de routage consultable au format vendeur | P0 |
| **FR-RTG-04** | Routeurs virtuels avec tables séparées | P2 |
| **FR-RTG-05** | Routage par politique | P2 |
| **FR-RTG-06** | Interface de sortie mémorisée sur la session | P0 |
| **FR-RTG-07** | OSPF sur pare-feu | P2 |
| **FR-RTG-08** | BGP sur pare-feu | P3 |

---

## 20. VPN

### 20.1 Ce qui existe

`src/network/ipsec/` est un moteur IPsec réel (IKE, SPD, SA, ESP/AH), déjà
intégré à `Router.processIPv4()` (`evaluateSPD`) et à `forwardPacket()`.
Le travail crypto récent l'a doté d'échanges de clés réels (X25519, P-256)
et d'un chiffrement authentifié réel (AES-GCM).

### 20.2 Ce que le pare-feu ajoute

| Fonction | Nouveauté |
|---|---|
| **Zone de tunnel** | Le trafic déchiffré arrive dans une zone, où la politique s'applique |
| **Interface de tunnel** | `Tunnel.1` (PAN-OS), `st0.0` (Junos), `Vpn-Interface` (FortiOS) |
| **Politique VPN** | FortiOS a une action `ipsec` sur la politique |
| **Exemption NAT** | Le trafic VPN ne doit pas être NATé — règle `no-nat` (§12.3) |
| **Accès distant** | Client VPN, pool d'adresses, authentification |
| **SSL VPN** | Portail web, tunnel TLS |

**Le point pédagogique central** : sur un pare-feu, le trafic déchiffré
**repasse par la politique**. C'est ce qui distingue un pare-feu VPN d'un
concentrateur VPN, et c'est ce que la zone de tunnel matérialise.

Second point, cause d'une majorité d'incidents réels : l'ordre NAT/VPN.
Si le trafic destiné au tunnel est NATé avant d'y entrer, il ne correspond
plus au sélecteur de la SA et le tunnel « monte mais ne passe pas ». C'est
un laboratoire de diagnostic remarquable et il est simulable dès que
l'exemption NAT existe.

### 20.3 Exigences — VPN

| # | Exigence | Priorité |
|---|---|---|
| **FR-VPN-01** | Tunnel IPsec site-à-site entre deux pare-feux, avec vraies trames | P2 |
| **FR-VPN-02** | Zone et interface de tunnel | P2 |
| **FR-VPN-03** | Politique appliquée au trafic déchiffré | P2 |
| **FR-VPN-04** | Exemption NAT pour le trafic VPN | P2 |
| **FR-VPN-05** | Vue des SA et des tunnels au format vendeur | P2 |
| **FR-VPN-06** | Diagnostic « tunnel monté mais trafic bloqué » | P2 |
| **FR-VPN-07** | Accès distant avec pool d'adresses | P3 |
| **FR-VPN-08** | SSL VPN portail | P3 |

---

## 21. Haute disponibilité

### 21.1 Le modèle

```ts
export interface HaConfiguration {
  enabled: boolean;
  mode: 'active-passive' | 'active-active';
  groupId: number;
  priority: number;
  preempt: boolean;
  controlLink: HaLinkConfig;
  dataLink?: HaLinkConfig;
  monitoredInterfaces: string[];
  monitoredPaths: string[];
  heartbeatIntervalMs: number;
  holdTimeMs: number;
  syncConfiguration: boolean;
  syncSessions: boolean;
}

export type HaState =
  | 'initial' | 'active' | 'passive' | 'standby'
  | 'suspended' | 'non-functional' | 'tentative';
```

### 21.2 Les deux liens

Point commun aux trois constructeurs étudiés, et donc bon candidat au socle :

| Lien | Rôle | Vendeur |
|---|---|---|
| **Contrôle** | Battements de cœur, synchronisation de configuration, état | ASA *failover link*, PAN-OS **HA1** (L3), FortiOS FGCP |
| **Données** | Synchronisation des sessions, tables ARP, SA IPsec | ASA *stateful failover link*, PAN-OS **HA2** (L2, ethertype `0x7261`), FortiOS FGSP |

Détail réel et pédagogiquement significatif : sur PAN-OS, le flux HA2 est
**unidirectionnel**, de l'actif vers le passif. C'est ce qui explique qu'un
passif ne puisse pas prendre l'initiative, et c'est simulable.

### 21.3 Ce qui est synchronisé

| Élément | ASA | PAN-OS | FortiOS |
|---|---|---|---|
| Configuration | oui | oui (HA1) | oui (FGCP) |
| Table de sessions | oui | oui (HA2) | oui (FGSP) |
| Table ARP | oui | oui | oui |
| Traductions NAT | oui | oui | oui |
| SA IPsec | oui | oui | oui |
| Table de routage | oui | oui (forwarding table) | oui |
| Sessions VPN accès distant | oui | partiellement | partiellement |

### 21.4 Contrainte P6 — la synchronisation traverse le fil

C'est le point d'attention majeur de ce chapitre. Il serait tentant, et
beaucoup plus simple, de recopier la table de sessions de l'objet actif vers
l'objet passif. **C'est exactement le raccourci que ce dépôt interdit.**

La synchronisation doit produire de vraies trames sur le lien HA, comptables
sur le fil. Le test correspondant mesure la **différence** de trames avec et
sans synchronisation de sessions activée.

### 21.5 Le basculement

Déclencheurs :

| Déclencheur | Détection |
|---|---|
| Perte de battements de cœur | Minuteur sur `Scheduler` |
| Interface surveillée tombée | Événement `port.link.down` du bus |
| Chemin surveillé injoignable | Sondes réelles (le dépôt possède IP SLA et NQA) |
| Basculement manuel | Commande |

**Le cas de recette central** : une session TCP établie à travers le
pare-feu actif survit au basculement, parce qu'elle a été synchronisée.
Sans synchronisation, elle est coupée. Les deux comportements doivent être
démontrables, car c'est **la** justification de la synchronisation d'état.

Point réel à ne pas rater : le basculement doit provoquer une annonce ARP
gratuite depuis le nouvel actif, sinon les voisins continuent d'envoyer les
trames à l'ancienne adresse MAC. Un basculement sans ARP gratuit « marche »
en apparence dans un simulateur naïf, et ne marche pas dans la réalité.
Le dépôt possède déjà l'ARP gratuit (mécanismes HSRP/VRRP/GLBP).

### 21.6 Exigences — HA

| # | Exigence | Priorité |
|---|---|---|
| **FR-HA-01** | Paire actif/passif avec élection par priorité | P3 |
| **FR-HA-02** | Lien de contrôle avec battements de cœur réels | P3 |
| **FR-HA-03** | Lien de données avec synchronisation de sessions réelle | P3 |
| **FR-HA-04** | Synchronisation de configuration | P3 |
| **FR-HA-05** | Surveillance d'interfaces via le bus | P3 |
| **FR-HA-06** | Surveillance de chemin via sondes réelles | P3 |
| **FR-HA-07** | Basculement préservant les sessions synchronisées | P3 |
| **FR-HA-08** | ARP gratuit au basculement | P3 |
| **FR-HA-09** | Préemption configurable | P3 |
| **FR-HA-10** | Vue d'état HA au format vendeur | P3 |
| **FR-HA-11** | Basculement manuel | P3 |
| **FR-HA-12** | Actif/actif | P4 |

---

## 22. Virtualisation

### 22.1 Le modèle

```ts
export interface VirtualFirewall {
  name: string;
  id: number;
  interfaces: string[];
  zones: ZoneTable;
  objects: ObjectStore;
  policy: PolicyStore;
  natPolicy: NatPolicyStore;
  sessions: SessionTable;
  routingTable: RouteEntry[];
  resourceLimits?: VirtualResourceLimits;
  managementAccess: boolean;
}
```

### 22.2 Le piège à éviter absolument

Ce dépôt a déjà documenté ce piège dans un autre sous-système :

> `PluggableDatabase` suit CON_ID/nom/mode d'ouverture mais `OracleStorage`
> n'a **aucune** notion de CON_ID — chaque PDB partage un unique espace de
> noms de schémas et de tables, si bien que `ALTER SESSION SET CONTAINER` ne
> change que l'étiquette de session. Un laboratoire « créer une table dans
> PDB1, vérifier son absence de PDB2 » échouera silencieusement.

**Le module pare-feu ne doit pas reproduire cela.** Un contexte virtuel qui
ne serait qu'une étiquette produirait exactement le même échec silencieux :
une règle créée dans VDOM-A visible depuis VDOM-B.

**Décision** : l'isolation est **réelle ou absente**. Les magasins sont
instanciés par contexte, et il n'existe aucun magasin global partagé pour
les zones, les objets, la politique, le NAT et les sessions. Si l'isolation
réelle n'est pas livrable dans une phase, la fonction est **refusée**
plutôt que mise en scène.

C'est le principe P4 appliqué à une fonction d'architecture plutôt qu'à une
commande.

### 22.3 Ce qui reste partagé

| Ressource | Partagée | Justification |
|---|---|---|
| Interfaces physiques | oui, affectées à un seul contexte | Le matériel est unique |
| Table de sessions | non | Isolation réelle |
| Politique, objets, zones, NAT | non | Isolation réelle |
| Table de routage | non | Un VDOM/vsys a la sienne |
| Journaux | oui, avec étiquette de contexte | Un seul appareil journalise |
| Configuration système (heure, DNS de gestion) | oui | Réel chez les trois vendeurs |
| Compte administrateur | mixte | Global + par contexte |

### 22.4 Trafic inter-contextes

| Vendeur | Mécanisme |
|---|---|
| ASA | Interface partagée, ou câblage externe |
| FortiOS | *inter-VDOM link* — paire d'interfaces virtuelles |
| PAN-OS | Zone de type `external` + routeur virtuel partagé |

L'*inter-VDOM link* de FortiOS est particulièrement intéressant à simuler :
c'est une paire d'interfaces virtuelles internes, et le trafic qui la
traverse est **soumis à la politique des deux VDOM**. Cela se modélise
naturellement avec un câble virtuel entre deux instances, ce qui respecte
P6 sans effort particulier.

### 22.5 Exigences — virtualisation

| # | Exigence | Priorité |
|---|---|---|
| **FR-VIR-01** | Créer, supprimer un contexte virtuel | P3 |
| **FR-VIR-02** | Isolation réelle des magasins, vérifiée par test | P3 |
| **FR-VIR-03** | Affecter une interface à un contexte, une seule fois | P3 |
| **FR-VIR-04** | Basculer de contexte en CLI | P3 |
| **FR-VIR-05** | Table de routage par contexte | P3 |
| **FR-VIR-06** | Lien inter-contextes soumis aux deux politiques | P4 |
| **FR-VIR-07** | Limites de ressources par contexte | P4 |
| **FR-VIR-08** | Journaux étiquetés par contexte | P3 |
| **FR-VIR-09** | Refuser la fonction plutôt que la mettre en scène si l'isolation n'est pas réelle | P3 |

---

## 23. Journalisation et observabilité

### 23.1 Les familles de journaux

| Famille | Contenu | Volume |
|---|---|---|
| **Trafic** | Session ouverte / fermée, avec octets et durée | Très élevé |
| **Menace** | Verdict d'un profil de sécurité | Moyen |
| **Système** | Démarrage, HA, interface, session administrateur | Faible |
| **Configuration** | Qui a changé quoi | Faible |
| **NAT** | Traduction créée / détruite | Élevé |
| **VPN** | Négociation, montée, chute de tunnel | Faible |

### 23.2 L'existant

`devices/router/LoggingConfig.ts` est mûr : sévérités, tampon circulaire,
horodatage (avec le travail sur `service timestamps`), collecteurs multiples,
TCP et UDP distingués, `facility`, `source-interface`. `syslog/SyslogAgent.ts`
émet pour de bon.

Le pare-feu **étend**, ne duplique pas.

### 23.3 Le point à corriger, hérité d'une leçon du dépôt

`CLAUDE.md` documente une leçon directement applicable : le tampon de
journal doit stocker la ligne **telle qu'elle a été écrite**, horodatage
compris, et non la reformater à l'affichage — sinon changer le format
d'horodatage redate rétroactivement tous les messages déjà journalisés,
c'est-à-dire réécrit l'histoire.

Le module pare-feu applique la même règle dès le départ.

### 23.4 Les formats vendeur

Chaque profil déclare un formateur. Les formats réels sont documentés en
annexe §44.3 ; en voici les gabarits :

**ASA** — syslog numéroté :
```
%ASA-6-302013: Built outbound TCP connection 1234 for outside:203.0.113.5/80
 (203.0.113.5/80) to inside:192.168.1.10/54321 (203.0.113.1/54321)
%ASA-6-302014: Teardown TCP connection 1234 for outside:203.0.113.5/80 to
 inside:192.168.1.10/54321 duration 0:00:31 bytes 4096 TCP FINs
%ASA-4-106023: Deny tcp src outside:198.51.100.99/52891
 dst dmz:192.168.50.10/443 by access-group "OUTSIDE_IN"
```

**FortiOS** — paires clé=valeur :
```
date=2026-08-14 time=10:15:32 devname="FGT" devid="FG100D" logid="0000000013"
 type="traffic" subtype="forward" level="notice" vd="root" srcip=192.168.1.10
 srcport=54321 srcintf="port1" dstip=203.0.113.5 dstport=80 dstintf="port2"
 sessionid=12345 proto=6 action="accept" policyid=1 service="HTTP"
 trandisp="snat" transip=203.0.113.1 transport=54321 duration=31
 sentbyte=1024 rcvdbyte=3072 sentpkt=12 rcvdpkt=15
```

**PAN-OS** — CSV :
```
1,2026/08/14 10:15:32,001801,TRAFFIC,end,2560,2026/08/14 10:15:32,
192.168.1.10,203.0.113.5,203.0.113.1,203.0.113.5,Allow-Web,,,web-browsing,
vsys1,trust,untrust,ethernet1/1,ethernet1/2,Log-Forwarding,…
```

**Junos** — structuré :
```
RT_FLOW_SESSION_CREATE: session created 192.168.1.10/54321->203.0.113.5/80
 0x0 junos-http 203.0.113.1/54321->203.0.113.5/80 0x0 src-nat-rule None
 N/A 6 Allow-Web trust untrust 12345 N/A(N/A) ge-0/0/0.0 UNKNOWN UNKNOWN
```

**Invariant I-L1** : ces formats lisent la **même** session. Aucun champ
n'est fabriqué pour la mise en forme. Si un format vendeur exige un champ
que le socle ne porte pas, deux issues seulement : ajouter le champ au
socle, ou omettre le champ du rendu — jamais l'inventer.

### 23.5 Le contrôle du volume

Le journal de trafic est le plus volumineux, et un pare-feu de laboratoire
peut en produire des milliers par minute. Mécanismes réels à porter :

| Mécanisme | Effet |
|---|---|
| Journalisation à la fin de session seulement (défaut) | Divise le volume par deux |
| Journalisation au début **et** à la fin | Utile au diagnostic |
| Pas de journalisation | Par règle |
| Agrégation des sessions identiques | FortiOS |
| Limitation de débit du journal | Tous |

**Décision** : le tampon interne est borné (comme le tampon syslog
existant), et le dépassement est **visible** — un compteur de messages
perdus, comme le fait un vrai appareil. Un tampon qui perd silencieusement
serait un mensonge de plus.

### 23.6 Compteurs

Chaque étape du pipeline, chaque règle, chaque ALG, chaque profil, chaque
type d'anomalie porte ses compteurs. C'est ce qui satisfait P7 (deux voies
d'observation).

```ts
export interface FirewallCounters {
  packetsReceived: number;
  packetsForwarded: number;
  packetsDenied: number;
  packetsDropped: number;

  slowpathPackets: number;
  fastpathPackets: number;

  sessionsCreated: number;
  sessionsClosed: number;
  sessionsActive: number;
  sessionsDenied: number;
  sessionsFailedNoRoute: number;
  sessionsFailedTableFull: number;

  natTranslationsActive: number;
  natPortExhaustions: number;

  byStage: Map<string, StageCounters>;
  byDenyReason: Map<VerdictReason, number>;
}
```

`byDenyReason` est ce qui rend P10 réel : cinq refus différents, cinq
compteurs différents.

### 23.7 Exigences — journalisation

| # | Exigence | Priorité |
|---|---|---|
| **FR-LOG-01** | Journal de trafic à l'ouverture et/ou à la fermeture de session | P0 |
| **FR-LOG-02** | Journal de refus nommant la règle | P0 |
| **FR-LOG-03** | Format vendeur, lisant la même session | P1 |
| **FR-LOG-04** | Aucun champ inventé pour la mise en forme | P0 |
| **FR-LOG-05** | Ligne stockée telle qu'écrite, jamais reformatée | P0 |
| **FR-LOG-06** | Export vers collecteur syslog réel | P1 |
| **FR-LOG-07** | Tampon borné avec compteur de pertes visible | P1 |
| **FR-LOG-08** | Journal de NAT | P2 |
| **FR-LOG-09** | Journal système et de configuration | P2 |
| **FR-LOG-10** | Compteurs par étape, règle, motif de refus | P0 |
| **FR-LOG-11** | Filtrage et recherche dans le journal en CLI | P1 |
| **FR-LOG-12** | Événements sur le bus pour l'UI | P1 |

---

## 24. Plan de gestion

### 24.1 Accès administrateur

Le dépôt possède déjà : SSH réel (`protocols/ssh/`), Telnet réel
(`protocols/telnet/`), HTTP/HTTPS réels, RADIUS réel, TACACS+ réel,
comptes et niveaux de privilège, vues CLI, journal d'audit de commandes.

Le pare-feu réutilise l'ensemble. Ce qu'il ajoute :

| Fonction | Nouveauté |
|---|---|
| Profils d'administrateur | RBAC par domaine fonctionnel |
| Restriction d'accès par adresse | Existe côté routeur (`ip http access-class`) |
| Interface de gestion dédiée | Souvent hors zone |
| Politique du trafic destiné au pare-feu | §9.3.5 |

### 24.2 Le modèle de configuration candidate

Divergence majeure et pédagogiquement essentielle :

| Vendeur | Modèle |
|---|---|
| ASA | Immédiat — chaque commande prend effet |
| FortiOS | Immédiat au `end` de chaque bloc |
| **PAN-OS** | **Candidat** — les changements ne prennent effet qu'au `commit` |
| **Junos** | **Candidat** — `commit`, avec `rollback`, `commit confirmed`, `commit check` |

Le modèle candidat n'est pas un détail d'ergonomie : c'est ce qui permet
`rollback`, `commit confirmed` (annulation automatique si l'administrateur
se coupe l'accès), et la comparaison avant/après. C'est enseigné, et
c'est simulable.

```ts
export interface ConfigurationModel {
  mode: 'immediate' | 'candidate';
  running: FirewallConfiguration;
  candidate?: FirewallConfiguration;
  commitHistory: CommitRecord[];
  maxRollbackDepth: number;
}
```

**Décision** : le socle porte les deux modèles ; le profil déclare lequel.
Le mode candidat implique que **toutes** les mutations passent par une
couche unique qui écrit dans `candidate`, ce qui est une contrainte
d'architecture à poser dès le départ — la rétrofitter serait coûteux.

C'est la raison pour laquelle ce chapitre, bien que de priorité moyenne,
doit être **conçu** en phase 1 même s'il n'est **livré** qu'en phase 5.

### 24.3 Exigences — gestion

| # | Exigence | Priorité |
|---|---|---|
| **FR-MGT-01** | Accès SSH réel au shell du pare-feu | P0 |
| **FR-MGT-02** | Comptes locaux avec rôles | P1 |
| **FR-MGT-03** | Authentification RADIUS / TACACS+ réelle | P2 |
| **FR-MGT-04** | Restriction d'accès de gestion par adresse | P1 |
| **FR-MGT-05** | Journal d'audit des commandes | P1 |
| **FR-MGT-06** | Sauvegarde et restauration de configuration | P1 |
| **FR-MGT-07** | Modèle candidat avec `commit` pour les profils qui le déclarent | P2 |
| **FR-MGT-08** | `rollback` et historique | P2 |
| **FR-MGT-09** | `commit confirmed` avec annulation automatique | P3 |
| **FR-MGT-10** | Comparaison candidat / actif | P2 |
| **FR-MGT-11** | Toutes les mutations passant par une couche unique | P0 |

---

## 25. Qualité de service

### 25.1 Périmètre

Fonction de priorité basse, mais dont le point d'accroche doit exister dès
la conception du pipeline (étape `shaping`).

| Fonction | Priorité |
|---|---|
| Limitation de débit par règle | P3 |
| Garantie de débit | P4 |
| Priorisation par classe | P4 |
| Limitation par adresse IP | P3 |

### 25.2 L'existant

`router/qos/CarPolicer.ts` est un vrai seau à jetons, sur le chemin de
données, livré avec `rate-limit`. Le pare-feu le réutilise.

Sa limite documentée s'applique aussi ici : le seuil « maximum » de Cisco
(comportement probabiliste entre deux seuils) est stocké et rendu, mais le
tirage aléatoire n'est pas effectué — « un simulateur pédagogique dont le
même trafic donnerait un résultat différent à chaque exécution serait
ininterprétable et intestable ». Cette décision est reprise telle quelle.

### 25.3 Exigences — QoS

| # | Exigence | Priorité |
|---|---|---|
| **FR-QOS-01** | Étape `shaping` présente dans le pipeline | P0 |
| **FR-QOS-02** | Limitation de débit par règle, sur `CarPolicer` | P3 |
| **FR-QOS-03** | Limitation par adresse source | P3 |
| **FR-QOS-04** | Compteurs de conformité et de dépassement | P3 |

---

# Partie III — Les déclinaisons constructeur

---

## 26. Le contrat de déclinaison vendeur

> C'est la section la plus importante du document pour le long terme. Elle
> définit **exactement** ce qu'il faut écrire pour ajouter un constructeur,
> et — tout aussi important — ce qu'il est interdit d'écrire.

### 26.1 Les cinq artefacts d'une déclinaison

Ajouter un constructeur consiste à livrer **cinq** artefacts, et rien de
plus.

| # | Artefact | Nature | Taille estimée |
|---|---|---|---|
| **1** | `<Vendor>Profile` | Données déclaratives | 200-400 lignes |
| **2** | `<Vendor>Shell` | Grammaire CLI sur `CommandTrie` | 1500-3000 lignes |
| **3** | `<Vendor>Renderer` | Rendus (`show`, configuration, journaux) | 800-1500 lignes |
| **4** | `<Vendor>Firewall` | Classe d'équipement, assemblage | 150-300 lignes |
| **5** | Catalogues | Services prédéfinis, applications, messages | 300-800 lignes |

**Interdit** : tout moteur. Aucun fichier de la couche vendeur ne doit
contenir de logique décidant du sort d'un paquet, de création de session, de
correspondance de règle ou de traduction d'adresse.

Ce critère est vérifiable mécaniquement et devient une garde-fou de test
(§40.6) : aucun fichier sous `firewall/vendors/<v>/` ne doit importer autre
chose que les **types** et les **vues de lecture** du socle.

### 26.2 Le profil, en détail

```ts
export interface FirewallProfile {
  readonly vendor: VendorId;
  readonly displayName: string;
  readonly osName: string;
  readonly defaultVersion: string;

  // ─── Pipeline ───
  readonly pipeline: PipelineStageName[];
  readonly natOrder: NatPolicyOrder;
  readonly applicationShift: boolean;
  readonly selfTrafficHandling: SelfTrafficMode;
  readonly invalidateSessionOnRouteChange: boolean;

  // ─── Politique ───
  readonly policyKeyedBy: 'zone' | 'interface';
  readonly implicitPolicy: 'deny-all' | 'security-level';
  readonly implicitRuleEditable: boolean;
  readonly implicitRuleLoggedByDefault: boolean;
  readonly supportedActions: RuleAction[];
  readonly supportsNegation: boolean;
  readonly natIsPolicyField: boolean;
  readonly ruleIdentity: 'sequence' | 'name' | 'stable-id';

  // ─── Zones ───
  readonly zoneModel: 'zone' | 'security-level' | 'both';
  readonly defaultIntraZoneAction: 'allow' | 'deny';
  readonly zoneTypes: ZoneType[];

  // ─── Objets ───
  readonly objectsMandatoryInPolicy: boolean;
  readonly maxGroupNesting: number;
  readonly supportsGroupExclusion: boolean;
  readonly predefinedServices: ServiceObject[];
  readonly predefinedAddresses: AddressObject[];

  // ─── Sessions ───
  readonly timeouts: SessionTimeouts;
  readonly limits: SessionTableLimits;
  readonly tcpSynCheckDefault: boolean;
  readonly sessionDirtyBehavior: 'keep' | 'check-new' | 'check-all';

  // ─── Déploiement ───
  readonly deploymentScope: 'device' | 'context' | 'interface';
  readonly supportedModes: DeploymentMode[];
  readonly bridgeAddressing: 'per-bridge-group' | 'device-wide' | 'none';

  // ─── Gestion ───
  readonly configurationModel: 'immediate' | 'candidate';
  readonly virtualizationName: string | null;

  // ─── Rendus et messages ───
  readonly messages: VendorMessageCatalog;
  readonly logFormatter: LogFormatterId;
  readonly promptStyle: PromptStyleId;

  // ─── Périmètre ───
  readonly unimplemented: UnimplementedFeature[];
}
```

Ce type est **le contrat**. Sa longueur est volontaire : chaque champ
représente une divergence réelle observée entre au moins deux constructeurs.
Chaque champ ajouté plus tard doit être justifié par une divergence
mesurée, jamais par une hypothèse.

### 26.3 La règle des trois issues face à une divergence

Quand un nouveau constructeur diverge, l'ordre de préférence est :

**Issue 1 — un champ de profil.** Si la divergence est un *paramètre* d'un
mécanisme existant. C'est le cas le plus fréquent (§9.3, §11.2, §12.4).

**Issue 2 — une étape de pipeline.** Si la divergence est un *ordre* ou une
*étape supplémentaire*. Ajouter une étape au catalogue (§13.2) est légitime
et n'affecte pas les profils qui ne la listent pas.

**Issue 3 — une spécificité irréductible.** Si la divergence est un
mécanisme que le socle ne porte pas et ne peut pas porter sans devenir
absurde. Elle vit alors dans la couche vendeur, dans un fichier
explicitement nommé `<Vendor>Specifics.ts`, et **elle est documentée dans le
présent document** avec sa justification.

Ce que l'issue 3 n'autorise **pas** : dupliquer un moteur. Une spécificité
irréductible est un comportement additionnel, jamais une réimplémentation.

Estimation, à réviser à mesure : moins de 5 % des divergences devraient
relever de l'issue 3. Si un constructeur en produit davantage, c'est le
socle qu'il faut revoir.

### 26.4 Le refus de plateforme

Transposition directe d'un patron déjà éprouvé dans ce dépôt pour
`GenericSwitch` :

```ts
export class UnsupportedOnThisPlatformError extends Error {
  constructor(readonly feature: string, readonly missing: string) { super(); }
}
```

Levée par les accesseurs `require*` du socle quand un profil ne déclare pas
une fonction, rattrapée en **un seul point** (`FirewallShell.execute`), et
traduite dans les mots du vendeur. Étant un type nommé et non un `catch`
générique, elle ne peut pas avaler un vrai défaut.

### 26.5 Les trois familles de messages

Reprise de `PRD-Curl.md` (§P4) :

| Famille | Situation | Message |
|---|---|---|
| **1** | Commande implémentée | Elle agit |
| **2** | Le vendeur la connaît, ce build ne la simule pas | Message du simulateur nommant la brique manquante |
| **3** | Commande inexistante chez le vendeur | Message d'erreur **du vendeur** |

Exemple famille 2 :
```
% Feature 'inspect sip' is not implemented in this simulator
  (no SIP protocol engine exists — see docs/BRD-Firewall.md §15.4)
```

Exemples famille 3, un par vendeur :
```
ASA      % Invalid input detected at '^' marker.
FortiOS  Unknown action 0
PAN-OS   Invalid syntax.
Junos    syntax error, expecting <data>.
```

### 26.6 La procédure d'ajout d'un constructeur

| Étape | Action | Livrable |
|---|---|---|
| **1** | Recueillir les références réelles | Transcriptions, jamais de la documentation HTML dont les blancs sont écrasés |
| **2** | Renseigner le profil | `<Vendor>Profile.ts` |
| **3** | Écrire la grammaire | `<Vendor>Shell.ts` sur `CommandTrie` |
| **4** | Écrire les rendus | `<Vendor>Renderer.ts` avec `TextTable` |
| **5** | Déclarer les catalogues | Services, applications, messages |
| **6** | Écrire la sonde discriminée | Test qui échoue avant, passe après |
| **7** | Vérifier le garde-fou d'architecture | Aucun moteur dans la couche vendeur |
| **8** | Documenter les spécificités irréductibles | Ici même |

L'étape 1 mérite d'être soulignée. `CLAUDE.md` en tire une leçon coûteuse :
les références de mise en forme doivent être du **texte capturé** et non
des exemples de documentation, « dont le HTML écrase les blancs — c'est-à-dire
l'information cherchée ». Quatre faits de mise en forme n'avaient été
découverts qu'en installant les vrais binaires. Pour un pare-feu, les
sources acceptables sont : transcriptions de session réelle, jeux de tests
d'analyseurs (`ntc-templates`), captures de journaux réels.

### 26.7 Exigences — contrat vendeur

| # | Exigence | Priorité |
|---|---|---|
| **FR-VEN-01** | Cinq artefacts et rien de plus par constructeur | P0 |
| **FR-VEN-02** | Aucun moteur dans la couche vendeur, vérifié par test | P0 |
| **FR-VEN-03** | Profil déclaratif couvrant les divergences mesurées | P0 |
| **FR-VEN-04** | Trois familles de messages | P0 |
| **FR-VEN-05** | Erreur de plateforme nommée, rattrapée en un point | P0 |
| **FR-VEN-06** | Spécificités irréductibles isolées et documentées | P0 |
| **FR-VEN-07** | Références de mise en forme issues de captures réelles | P0 |

---

## 27. Cisco ASA et FTD

### 27.1 Identité

| | |
|---|---|
| `DeviceType` | `firewall-cisco` (existant, à recâbler) |
| Classe | `AsaFirewall extends Firewall` |
| Shell | `AsaShell` |
| OS simulé | ASA 9.x |
| Prompt | `ciscoasa>` / `ciscoasa#` / `ciscoasa(config)#` |
| Modèle de configuration | Immédiat |

### 27.2 Le profil ASA

```
policyKeyedBy:        'interface'
implicitPolicy:       'security-level'
zoneModel:            'both'
natIsPolicyField:     false
applicationShift:     false
selfTrafficHandling:  'control-plane-acl'
configurationModel:   'immediate'
ruleIdentity:         'sequence'
objectsMandatoryInPolicy: false
virtualizationName:   'context'
supportedActions:     ['allow', 'deny']

natOrder: {
  destinationNatBeforePolicy: true,
  sourceNatBeforePolicy:      false,
  policySeesPreNatSource:     true,
  policySeesPreNatDestination: false,
  policySeesPostNatZone:      true,
}
```

### 27.3 Les niveaux de sécurité

Le mécanisme fondateur de l'ASA, et sa principale divergence.

| Interface type | `nameif` | `security-level` |
|---|---|---|
| Interne | `inside` | 100 |
| DMZ | `dmz` | 50 |
| Externe | `outside` | 0 |

Règles implicites :

| Sens | Défaut | Modification |
|---|---|---|
| Haut → bas | **autorisé** | ACL explicite pour restreindre |
| Bas → haut | **refusé** | ACL explicite pour autoriser |
| Même → même | **refusé** | `same-security-traffic permit inter-interface` |
| Retour sur la même interface (hairpin) | **refusé** | `same-security-traffic permit intra-interface` |

**Point à ne pas rater** : dès qu'une ACL est appliquée à une interface avec
`access-group … in`, elle **remplace** intégralement le comportement
implicite pour le trafic entrant sur cette interface. Beaucoup de cours le
disent mal. Le simulateur doit être exact ici, car c'est la source du
« j'ai ajouté une ACL et tout s'est arrêté ».

### 27.4 Commandes de la déclinaison ASA

#### 27.4.1 Interfaces et zones

| Commande | Effet |
|---|---|
| `interface GigabitEthernet0/0` | Mode interface |
| `nameif inside` | Nomme l'interface (obligatoire pour passer du trafic) |
| `security-level 100` | Niveau |
| `ip address 192.168.1.1 255.255.255.0` | Adressage |
| `no shutdown` | Activation |
| `zone-member <zone>` | Zone ASA (regroupement, pas politique) |
| `same-security-traffic permit inter-interface` | Autorise même→même |
| `same-security-traffic permit intra-interface` | Autorise le hairpin |

#### 27.4.2 Objets

| Commande | Effet |
|---|---|
| `object network SRV_WEB` | Crée un objet réseau |
| ` host 192.168.50.10` | Hôte |
| ` subnet 192.168.50.0 255.255.255.0` | Sous-réseau |
| ` range 192.168.50.10 192.168.50.20` | Plage |
| ` fqdn www.example.com` | FQDN |
| ` nat (dmz,outside) static 203.0.113.10` | NAT automatique attaché à l'objet |
| `object service HTTP_ALT` | Objet service |
| ` service tcp destination eq 8080` | Définition |
| `object-group network WEB_SERVERS` | Groupe |
| ` network-object object SRV_WEB` | Membre |
| `object-group service WEB_PORTS tcp` | Groupe de services |
| ` port-object eq 80` | Membre |

Le **NAT automatique** (*auto NAT*, section 2) attaché à l'objet est une
particularité ASA forte : la règle NAT vit dans l'objet. Le socle l'absorbe
en générant une `NatRule` dont l'origine est marquée, et le rendu la
réaffiche sous l'objet.

#### 27.4.3 Politique

| Commande | Effet |
|---|---|
| `access-list OUTSIDE_IN extended permit tcp any object SRV_WEB eq 443` | ACE |
| `access-list OUTSIDE_IN extended deny ip any any log` | ACE avec journal |
| `access-group OUTSIDE_IN in interface outside` | Application |
| `access-list OUTSIDE_IN line 1 extended permit …` | Insertion positionnée |
| `clear access-list OUTSIDE_IN counters` | Remise à zéro |
| `show access-list OUTSIDE_IN` | Affichage avec compteurs |

#### 27.4.4 NAT manuel

| Commande | Effet |
|---|---|
| `nat (inside,outside) source dynamic any interface` | PAT sortant |
| `nat (inside,outside) source dynamic INSIDE_NET POOL_PUB` | NAT dynamique |
| `nat (outside,dmz) source static any any destination static PUB_IP SRV_WEB` | Publication |
| `nat (inside,outside) source static NET_A NET_A destination static NET_B NET_B no-proxy-arp route-lookup` | Exemption VPN |
| `show nat` | Règles avec compteurs |
| `show xlate` | Traductions actives |
| `clear xlate` | Purge |

La forme d'exemption VPN ci-dessus (`static X X`, c'est-à-dire traduire vers
soi-même) est l'idiome ASA pour « ne pas traduire ». Le socle le reconnaît
et le convertit en `noTranslation: true`, plutôt que de créer une
traduction identité qui consommerait une entrée de table.

#### 27.4.5 Sessions et diagnostic

| Commande | Effet |
|---|---|
| `show conn` | Table de connexions |
| `show conn detail` | Détail avec drapeaux |
| `show conn address 192.168.1.10` | Filtré |
| `show conn count` | Nombre |
| `clear conn` / `clear conn address …` | Purge |
| `show local-host` | Par hôte |
| `packet-tracer input inside tcp 192.168.1.10 12345 203.0.113.5 80 detailed` | Simulation |
| `show service-policy` | Politiques MPF |
| `show threat-detection statistics` | Détection |

`packet-tracer` est **la** commande emblématique de l'ASA et le meilleur
argument de ce module. Sa sortie liste chaque phase avec son verdict :

```
Phase: 1  Type: ACCESS-LIST      Subtype:            Result: ALLOW
Phase: 2  Type: UN-NAT           Subtype: static     Result: ALLOW
Phase: 3  Type: ACCESS-LIST      Subtype: log        Result: ALLOW
Phase: 4  Type: NAT              Subtype:            Result: ALLOW
Phase: 5  Type: IP-OPTIONS       Subtype:            Result: ALLOW
Phase: 6  Type: FLOW-CREATION    Subtype:            Result: ALLOW
Result: input-interface: outside / output-interface: dmz / Action: allow
```

C'est **exactement** `ctx.trace` (§13.10), rendu au format ASA. Le fait que
cette commande soit une lecture directe de la trace du pipeline réel est la
meilleure démonstration que l'architecture du socle est juste.

#### 27.4.6 Inspection (MPF)

| Commande | Effet |
|---|---|
| `class-map inspection_default` | Classe |
| ` match default-inspection-traffic` | Critère |
| `policy-map global_policy` | Politique |
| ` class inspection_default` | Association |
| `  inspect ftp` / `inspect dns` / `inspect icmp` | Activation d'ALG |
| `service-policy global_policy global` | Application |

**Piège pédagogique classique et à reproduire** : `inspect icmp` n'est **pas**
activé par défaut sur ASA. Sans lui, un `ping` d'inside vers outside ne
fonctionne pas, parce que l'écho de retour n'est associé à aucune connexion.
C'est l'un des premiers obstacles rencontrés par tout débutant ASA, et le
simulateur doit le reproduire fidèlement — sinon il enseigne un ASA
imaginaire.

#### 27.4.7 Contextes et HA

| Commande | Effet |
|---|---|
| `mode multiple` | Active les contextes |
| `context CTX1` | Crée |
| ` allocate-interface GigabitEthernet0/1` | Affecte |
| `changeto context CTX1` | Bascule |
| `failover lan unit primary` | HA |
| `failover link FAILOVER GigabitEthernet0/3` | Lien de contrôle |
| `failover interface ip FAILOVER 10.0.0.1 255.255.255.252 standby 10.0.0.2` | Adressage |
| `show failover` | État |

### 27.5 Spécificités irréductibles ASA

| # | Spécificité | Traitement |
|---|---|---|
| **ASA-S1** | NAT automatique attaché à l'objet | Génère une `NatRule` marquée, rendue sous l'objet |
| **ASA-S2** | Sections NAT (1 manuel, 2 auto, 3 manuel après-auto) | Ordre de tri déclaré dans le profil |
| **ASA-S3** | `packet-tracer` avec phases nommées ASA | Rendu de `ctx.trace` |
| **ASA-S4** | MPF (class-map / policy-map / service-policy) | Couche de traduction vers `AlgRegistry` et profils |
| **ASA-S5** | `same-security-traffic` | Deux booléens du profil |

Cinq spécificités, dont quatre sont des **rendus ou traductions** et une
seule (ASA-S2) est un comportement — respectant l'objectif des 5 % de §26.3.

---

## 28. Fortinet FortiOS

### 28.1 Identité

| | |
|---|---|
| `DeviceType` | `firewall-fortinet` (existant, à recâbler) |
| Classe | `FortiGateFirewall extends Firewall` |
| Shell | `FortiOsShell` |
| OS simulé | FortiOS 7.x |
| Prompt | `FGT # ` / `FGT (policy) # ` / `FGT (1) # ` |
| Modèle de configuration | Immédiat au `end` |

### 28.2 Le profil FortiOS

```
policyKeyedBy:        'zone'      (srcintf/dstintf acceptent interface OU zone)
implicitPolicy:       'deny-all'
zoneModel:            'zone'
natIsPolicyField:     true        ← LA particularité
applicationShift:     true        (en mode policy-based NGFW)
selfTrafficHandling:  'local-in-policy'
configurationModel:   'immediate'
ruleIdentity:         'stable-id' ← `edit 3` est un identifiant, pas un rang
objectsMandatoryInPolicy: true    ← LA seconde particularité
virtualizationName:   'vdom'
defaultIntraZoneAction: 'deny'
supportedActions:     ['accept', 'deny', 'ipsec']

natOrder: {
  destinationNatBeforePolicy: true,   ← VIP avant routage
  sourceNatBeforePolicy:      false,
  policySeesPreNatSource:     true,
  policySeesPreNatDestination: true,  ← la politique vise la VIP
  policySeesPostNatZone:      true,
}
```

### 28.3 La grammaire FortiOS — une machine à états à part entière

FortiOS n'a pas une CLI de type IOS. C'est un **arbre de configuration**
avec un langage uniforme :

```
config <chemin>
    edit <clé>
        set <attribut> <valeur>
        unset <attribut>
        append <attribut> <valeur>
        select <attribut> <valeur>
        config <sous-chemin>
            edit <clé>
                set …
            next
        end
    next
    delete <clé>
    purge
    show
end
```

Cette grammaire est **régulière**, ce qui est une excellente nouvelle : elle
se modélise par une machine à états sur `CLIStateMachine` avec un arbre de
schéma déclaratif, plutôt que par des centaines de handlers.

```ts
export interface FortiSchemaNode {
  path: string;
  kind: 'table' | 'object';
  keyField?: string;
  attributes: Map<string, FortiAttributeSpec>;
  children: Map<string, FortiSchemaNode>;
}

export interface FortiAttributeSpec {
  name: string;
  type: 'string' | 'integer' | 'ipmask' | 'enum' | 'reference' | 'multi';
  enumValues?: string[];
  referenceTo?: string;
  defaultValue?: unknown;
  required?: boolean;
  multiValue?: boolean;
}
```

**C'est un investissement à fort levier** : le schéma déclaratif donne
gratuitement la complétion, l'aide (`?`), la validation de type, la
validation de référence, `show` (qui n'affiche que ce qui diffère du défaut)
et `get` (qui affiche tout). Une seule machine, des centaines de commandes.

**Point de fidélité important** : `show` sur FortiOS n'affiche que les
attributs **modifiés**, `get` affiche tous les attributs avec leur valeur
courante. Confondre les deux serait une infidélité immédiatement visible.

### 28.4 Commandes de la déclinaison FortiOS

#### 28.4.1 Interfaces et zones

```
config system interface
    edit "port1"
        set ip 192.168.1.1 255.255.255.0
        set allowaccess ping https ssh
        set alias "LAN"
        set role lan
    next
end

config system zone
    edit "trust"
        set interface "port1" "port2"
        set intrazone deny
    next
end
```

#### 28.4.2 Objets

```
config firewall address
    edit "SRV_WEB"
        set subnet 192.168.50.10 255.255.255.255
        set comment "Serveur web DMZ"
    next
    edit "SITE_DISTANT"
        set type fqdn
        set fqdn "www.example.com"
    next
end

config firewall addrgrp
    edit "SERVEURS"
        set member "SRV_WEB" "SRV_MAIL"
    next
end

config firewall service custom
    edit "HTTP_ALT"
        set tcp-portrange 8080
    next
end

config firewall schedule recurring
    edit "HEURES_OUVREES"
        set day monday tuesday wednesday thursday friday
        set start 08:00
        set end 18:00
    next
end
```

#### 28.4.3 Politique — avec le NAT dedans

```
config firewall policy
    edit 1
        set name "LAN-vers-Internet"
        set srcintf "port1"
        set dstintf "port2"
        set srcaddr "all"
        set dstaddr "all"
        set action accept
        set schedule "always"
        set service "HTTP" "HTTPS" "DNS"
        set nat enable                    ← le NAT est ICI
        set logtraffic all
        set utm-status enable
        set av-profile "default"
        set webfilter-profile "default"
        set ssl-ssh-profile "certificate-inspection"
    next
end

config firewall policy
    move 5 before 2
end
```

`set nat enable` est **la** particularité FortiOS. Sans elle, un FortiGate
route sans traduire. Avec elle, il fait du PAT vers l'adresse de l'interface
de sortie. Un pool alternatif se déclare par `set ippool enable` +
`set poolname`.

#### 28.4.4 VIP (NAT de destination)

```
config firewall vip
    edit "VIP_WEB"
        set extip 203.0.113.10
        set extintf "port2"
        set mappedip "192.168.50.10"
        set portforward enable
        set protocol tcp
        set extport 443
        set mappedport 8443
    next
end

config firewall policy
    edit 2
        set srcintf "port2"
        set dstintf "dmz"
        set srcaddr "all"
        set dstaddr "VIP_WEB"          ← la VIP est la DESTINATION
        set action accept
        set schedule "always"
        set service "HTTPS"
    next
end
```

Le fait que la politique vise la **VIP** comme destination — et non
l'adresse interne — est la conséquence directe de `policySeesPreNatDestination:
true`. C'est ce qui distingue FortiOS de l'ASA 8.3+, et le laboratoire L2
doit démontrer les deux.

#### 28.4.5 Diagnostic

| Commande | Effet |
|---|---|
| `get system session list` | Table de sessions |
| `diagnose sys session list` | Détail complet |
| `diagnose sys session filter src 192.168.1.10` | Filtre |
| `diagnose sys session clear` | Purge (après filtre) |
| `diagnose sys session stat` | Statistiques |
| `diagnose debug flow filter addr 192.168.1.10` | Trace |
| `diagnose debug flow trace start 10` | Démarre la trace |
| `diagnose debug enable` | Active la sortie |
| `get router info routing-table all` | Routage |
| `diagnose firewall iprope list` | Politiques compilées |
| `execute ping 8.8.8.8` | Test |

`diagnose debug flow` est l'équivalent FortiOS de `packet-tracer` — même
source (`ctx.trace`), autre rendu :

```
id=20085 trace_id=1 func=print_pkt_detail line=5590 msg="vd-root received a
 packet(proto=6, 192.168.1.10:54321->203.0.113.5:80) from port1."
id=20085 trace_id=1 func=init_ip_session_common line=5760 msg="allocate a new
 session-0000a1b2"
id=20085 trace_id=1 func=vf_ip_route_input_common line=2591 msg="find a route:
 flag=04000000 gw-203.0.113.254 via port2"
id=20085 trace_id=1 func=fw_forward_handler line=771 msg="Allowed by Policy-1:
 SNAT"
```

### 28.5 VDOM

```
config system global
    set vdom-mode multi-vdom
end

config vdom
    edit "VENTES"
    next
end

config global
    config system vdom-link
        edit "lien1"
        next
    end
end

edit vdom          ← bascule
edit "VENTES"
    config firewall policy
        …
    end
end
```

### 28.6 Spécificités irréductibles FortiOS

| # | Spécificité | Traitement |
|---|---|---|
| **FGT-S1** | NAT comme champ de politique | Champ `natIsPolicyField` du profil |
| **FGT-S2** | Objets obligatoires dans la politique | Champ `objectsMandatoryInPolicy` |
| **FGT-S3** | Grammaire `config/edit/set/next/end` | Machine à états + schéma déclaratif |
| **FGT-S4** | `show` (modifié) vs `get` (tout) | Deux rendus lisant le même schéma |
| **FGT-S5** | VIP comme objet destination | Une `NatRule` référencée comme objet adresse |
| **FGT-S6** | `firewall-session-dirty` | Champ `sessionDirtyBehavior` |

FGT-S5 est la seule qui touche à un mécanisme : une VIP est **à la fois** un
objet adresse et une règle NAT. Le socle le modélise par un objet adresse
d'un type spécial `vip`, qui porte une référence vers sa `NatRule`. C'est
une extension du modèle d'objets, pas un moteur — donc acceptable.

---

## 29. Palo Alto PAN-OS

### 29.1 Identité

| | |
|---|---|
| `DeviceType` | `firewall-paloalto` (existant, à recâbler) |
| Classe | `PanOsFirewall extends Firewall` |
| Shell | `PanOsShell` |
| OS simulé | PAN-OS 10.x / 11.x |
| Prompt | `admin@PA-VM>` / `admin@PA-VM#` |
| Modèle de configuration | **Candidat** (`commit` obligatoire) |

### 29.2 Le profil PAN-OS

```
policyKeyedBy:        'zone'
implicitPolicy:       'deny-all'
implicitRuleEditable: true         ← intrazone/interzone-default éditables
zoneModel:            'zone'
natIsPolicyField:     false
applicationShift:     true         ← LA particularité
selfTrafficHandling:  'management-profile'
configurationModel:   'candidate'  ← LA seconde particularité
ruleIdentity:         'name'
deploymentScope:      'interface'  ← L3/L2/vwire/tap par interface
virtualizationName:   'vsys'
defaultIntraZoneAction: 'allow'    ← divergence notable
supportedActions:     ['allow','deny','drop','reset-client',
                       'reset-server','reset-both']

natOrder: {
  destinationNatBeforePolicy: false,  ← évalué mais appliqué à l'egress
  sourceNatBeforePolicy:      false,
  policySeesPreNatSource:     true,
  policySeesPreNatDestination: true,   ← adresse PRÉ-NAT
  policySeesPostNatZone:      true,    ← mais zone POST-NAT
}
```

Les deux dernières lignes encodent le piège le plus enseigné de PAN-OS.
Qu'il tienne en deux booléens est la validation du principe P2.

### 29.3 Le modèle candidat

```
admin@PA-VM> configure
Entering configuration mode
[edit]
admin@PA-VM# set rulebase security rules Allow-Web from trust to untrust …
admin@PA-VM# commit
Commit job enqueued with jobid 42
...
Configuration committed successfully
```

| Commande | Effet |
|---|---|
| `configure` | Entre en mode configuration |
| `set …` | Modifie le **candidat** |
| `delete …` | Supprime du candidat |
| `commit` | Applique |
| `commit force` | Force |
| `revert` | Abandonne le candidat |
| `show` (en mode config) | Affiche le candidat |
| `show config running` | Affiche l'actif |
| `show config diff` | Comparaison |
| `exit` | Sort |

**Le cas de recette central** : une règle `set` sans `commit` ne prend
**aucun** effet. Le trafic reste refusé. C'est la première erreur de tout
débutant PAN-OS, et sa reproduction fidèle est indispensable.

### 29.4 Commandes de la déclinaison PAN-OS

#### 29.4.1 Interfaces et zones

```
set network interface ethernet ethernet1/1 layer3 ip 192.168.1.1/24
set network interface ethernet ethernet1/1 layer3 interface-management-profile ALLOW-PING
set zone trust network layer3 ethernet1/1
set zone untrust network layer3 ethernet1/2
set network virtual-router default interface [ ethernet1/1 ethernet1/2 ]
set network virtual-router default routing-table ip static-route DEFAULT destination 0.0.0.0/0
set network virtual-router default routing-table ip static-route DEFAULT nexthop ip-address 203.0.113.254
```

#### 29.4.2 Objets

```
set address SRV_WEB ip-netmask 192.168.50.10/32
set address SRV_MAIL ip-netmask 192.168.50.11/32
set address SITE_DISTANT fqdn www.example.com
set address-group SERVEURS static [ SRV_WEB SRV_MAIL ]
set address-group SERVEURS_DYN dynamic filter "'prod' and 'web'"
set service HTTP_ALT protocol tcp port 8080
set service-group WEB_PORTS members [ service-http HTTP_ALT ]
set schedule HEURES_OUVREES recurring weekly monday 08:00-18:00
```

#### 29.4.3 Politique

```
set rulebase security rules Allow-Web from trust
set rulebase security rules Allow-Web to untrust
set rulebase security rules Allow-Web source any
set rulebase security rules Allow-Web destination any
set rulebase security rules Allow-Web application [ web-browsing ssl ]
set rulebase security rules Allow-Web service application-default
set rulebase security rules Allow-Web action allow
set rulebase security rules Allow-Web log-end yes
set rulebase security rules Allow-Web profile-setting group [ Best-Practice ]

move rulebase security rules Allow-Web top
move rulebase security rules Allow-Web before Deny-All
```

`service application-default` est une notion propre à PAN-OS et
pédagogiquement forte : elle signifie « le port standard de l'application
identifiée ». Une règle `web-browsing` + `application-default` autorise HTTP
sur 80 mais **refuse** HTTP sur 8080 — ce qui est exactement le
comportement recherché en durcissement, et un piège classique.

#### 29.4.4 NAT

```
set rulebase nat rules SNAT-Sortant from trust to untrust source any destination any
set rulebase nat rules SNAT-Sortant source-translation dynamic-ip-and-port interface-address interface ethernet1/2
set rulebase nat rules DNAT-Web from untrust to untrust source any destination 203.0.113.10
set rulebase nat rules DNAT-Web destination-translation translated-address 192.168.50.10
```

**Le point le plus contre-intuitif de PAN-OS**, et donc le plus important à
simuler : dans la règle NAT de destination, `to` est `untrust` — la zone
**avant** routage — alors que dans la règle de sécurité correspondante,
`to` sera `dmz` — la zone **après** routage. C'est la source d'erreur n°1
du PCNSA, et le socle le reproduit par construction puisque l'étape
`route-lookup` précède `policy-lookup` mais que la règle NAT est évaluée
sur les zones d'ingress.

#### 29.4.5 Diagnostic

| Commande | Effet |
|---|---|
| `show session all` | Table |
| `show session all filter source 192.168.1.10` | Filtré |
| `show session id 12345` | Détail |
| `show session info` | Statistiques |
| `clear session all` | Purge |
| `test security-policy-match from trust to untrust source 192.168.1.10 destination 203.0.113.5 protocol 6 destination-port 80` | Simulation |
| `test nat-policy-match …` | Simulation NAT |
| `show running security-policy` | Politique compilée |
| `show counter global filter severity drop` | Compteurs de rejet |
| `show log traffic` | Journal |

`show counter global filter severity drop` est remarquable et vaut d'être
simulé pour de bon : il liste les compteurs de rejet **par cause**, ce qui
est exactement `byDenyReason` (§23.6). Le socle le rend gratuitement.

### 29.5 Spécificités irréductibles PAN-OS

| # | Spécificité | Traitement |
|---|---|---|
| **PAN-S1** | Configuration candidate et `commit` | Champ `configurationModel` + couche de mutation unique |
| **PAN-S2** | `service application-default` | Valeur spéciale résolue par le catalogue d'applications |
| **PAN-S3** | Zones implicites `intrazone-default` / `interzone-default` éditables | Deux règles implicites au lieu d'une |
| **PAN-S4** | Application shift avec re-recherche | Champ `applicationShift` + étape de pipeline |
| **PAN-S5** | Mode par interface | Champ `deploymentScope: 'interface'` |
| **PAN-S6** | Groupes d'adresses dynamiques par filtre d'étiquettes | Extension du modèle d'objets |

---

## 30. Juniper SRX

### 30.1 Identité

| | |
|---|---|
| `DeviceType` | `firewall-juniper` (**nouveau**) |
| Classe | `SrxFirewall extends Firewall` |
| Shell | `JunosSecurityShell` |
| OS simulé | Junos 21.x+ |
| Prompt | `root@SRX>` / `root@SRX#` |
| Modèle de configuration | **Candidat** (`commit`) |

### 30.2 Le profil Junos

```
policyKeyedBy:        'zone'
implicitPolicy:       'deny-all'
zoneModel:            'zone'
natIsPolicyField:     false
applicationShift:     true         (dynamic-application)
selfTrafficHandling:  'zone-host-inbound'   ← particularité
configurationModel:   'candidate'
ruleIdentity:         'name'
virtualizationName:   'logical-system'
defaultIntraZoneAction: 'deny'
supportedActions:     ['permit', 'deny', 'reject']

natOrder: {
  destinationNatBeforePolicy: true,
  sourceNatBeforePolicy:      false,
  policySeesPreNatSource:     true,
  policySeesPreNatDestination: false,   ← post-DNAT
  policySeesPostNatZone:      true,
}
```

### 30.3 Commandes principales

```
set security zones security-zone trust interfaces ge-0/0/0.0
set security zones security-zone trust host-inbound-traffic system-services ping ssh
set security zones security-zone untrust interfaces ge-0/0/1.0
set security zones security-zone untrust screen protect-untrust

set security address-book global address SRV_WEB 192.168.50.10/32
set security address-book global address-set SERVEURS address SRV_WEB

set applications application HTTP_ALT protocol tcp destination-port 8080

set security policies from-zone trust to-zone untrust policy Allow-Web match source-address any
set security policies from-zone trust to-zone untrust policy Allow-Web match destination-address any
set security policies from-zone trust to-zone untrust policy Allow-Web match application junos-http
set security policies from-zone trust to-zone untrust policy Allow-Web then permit
set security policies from-zone trust to-zone untrust policy Allow-Web then log session-close

set security nat source rule-set TRUST-TO-UNTRUST from zone trust
set security nat source rule-set TRUST-TO-UNTRUST to zone untrust
set security nat source rule-set TRUST-TO-UNTRUST rule R1 match source-address 0.0.0.0/0
set security nat source rule-set TRUST-TO-UNTRUST rule R1 then source-nat interface

set security screen ids-option protect-untrust tcp syn-flood attack-threshold 200
set security screen ids-option protect-untrust tcp land
set security screen ids-option protect-untrust icmp ping-death

commit
```

### 30.4 Diagnostic

| Commande | Effet |
|---|---|
| `show security flow session` | Table |
| `show security flow session source-prefix 192.168.1.10` | Filtré |
| `show security flow session summary` | Résumé |
| `clear security flow session all` | Purge |
| `show security policies detail` | Politique |
| `show security policies hit-count` | Compteurs |
| `show security match-policies from-zone trust to-zone untrust source-ip 192.168.1.10 destination-ip 203.0.113.5 protocol tcp destination-port 80` | Simulation |
| `show security nat source rule all` | NAT |
| `show security screen statistics zone untrust` | Screens |

### 30.5 Spécificités irréductibles Junos

| # | Spécificité | Traitement |
|---|---|---|
| **SRX-S1** | `host-inbound-traffic` dans la zone | Champ `selfTrafficHandling` |
| **SRX-S2** | Politique explicitement `from-zone X to-zone Y` | Indexation du `PolicyStore` par paire, ce que le socle permet déjà |
| **SRX-S3** | Carnet d'adresses global ou par zone | Portée d'objet paramétrée |
| **SRX-S4** | `commit confirmed` avec annulation automatique | Minuteur sur `Scheduler` |
| **SRX-S5** | Mode paquet vs mode flux par interface | Étape de pipeline conditionnelle |

### 30.6 Pourquoi ajouter Junos alors que trois vendeurs existent déjà

Trois raisons mesurables :

1. **C'est le test du contrat.** Trois vendeurs peuvent partager un socle par
   coïncidence ; le quatrième, ajouté après coup, prouve que le contrat de
   §26 fonctionne. Si l'ajout de Junos exige de modifier le socle, le socle
   est incomplet — et il vaut mieux le découvrir en phase 9 qu'en phase 15.
2. **JNCIA-SEC est un cursus visé** au même titre que les trois autres.
3. **Junos apporte un modèle absent des trois autres** : la politique
   explicitement indexée par paire de zones, et `host-inbound-traffic` dans
   la zone. Ces deux mécanismes valident deux champs du profil qui, sans
   Junos, resteraient théoriques.

---

## 31. Matrice de correspondance inter-vendeurs

> Cette matrice est le document de référence pour tout développeur ajoutant
> une fonction : elle indique si la fonction est universelle (donc socle) ou
> particulière (donc profil).

### 31.1 Concepts fondamentaux

| Concept | ASA | FortiOS | PAN-OS | Junos | Verdict |
|---|---|---|---|---|---|
| Zone | partiel | oui | oui | oui | **socle**, avec `zoneModel` |
| Niveau de sécurité | oui | non | non | non | **profil** |
| Politique ordonnée | oui | oui | oui | oui | **socle** |
| Première correspondance | oui | oui | oui | oui | **socle** |
| Refus implicite final | oui | oui | oui | oui | **socle** |
| Session à états | oui | oui | oui | oui | **socle** |
| NAT dans la politique | non | **oui** | non | non | **profil** |
| Objets obligatoires | non | **oui** | non | non | **profil** |
| Configuration candidate | non | non | **oui** | **oui** | **profil** |
| Application shift | non | oui | **oui** | oui | **profil** |
| Contextes virtuels | oui | oui | oui | oui | **socle** |
| Mode transparent | oui | oui | oui | oui | **socle** |
| Virtual wire | non | oui | **oui** | non | **profil** |
| Mode tap | non | oui | **oui** | non | **profil** |
| Screens / DoS | oui | oui | oui | **oui** | **socle** |
| ALG | oui | oui | oui | oui | **socle** |

### 31.2 Actions de règle

| Action | ASA | FortiOS | PAN-OS | Junos |
|---|---|---|---|---|
| Autoriser | `permit` | `accept` | `allow` | `permit` |
| Refuser silencieusement | `deny` | `deny` | `drop` | `deny` |
| Refuser activement | — | — | `reset-client` / `reset-server` / `reset-both` | `reject` |
| Chiffrer | via crypto map | `ipsec` | via tunnel | via tunnel |

Le socle porte l'union ; le profil déclare `supportedActions` et le rendu
traduit. Une action non déclarée est refusée à l'écriture.

### 31.3 Commandes de diagnostic équivalentes

| Fonction | ASA | FortiOS | PAN-OS | Junos |
|---|---|---|---|---|
| Table de sessions | `show conn` | `get system session list` | `show session all` | `show security flow session` |
| Détail d'une session | `show conn detail` | `diagnose sys session list` | `show session id N` | `show security flow session session-identifier N` |
| Purge | `clear conn` | `diagnose sys session clear` | `clear session all` | `clear security flow session all` |
| Statistiques | `show conn count` | `diagnose sys session stat` | `show session info` | `show security flow session summary` |
| Simulation | `packet-tracer input …` | `diagnose debug flow …` | `test security-policy-match …` | `show security match-policies …` |
| Traductions | `show xlate` | `diagnose firewall vip list` | `show running nat-policy` | `show security nat source rule all` |
| Compteurs de règles | `show access-list` | `diagnose firewall iprope list` | `show running security-policy` | `show security policies hit-count` |
| Routage | `show route` | `get router info routing-table all` | `show routing route` | `show route` |
| Journaux | `show logging` | `execute log display` | `show log traffic` | `show log messages` |

### 31.4 Délais de session par défaut

| Protocole / état | ASA | FortiOS | PAN-OS | Junos |
|---|---|---|---|---|
| TCP établi | 1 h | 3600 s | 3600 s | 1800 s |
| TCP handshake | 30 s | 10 s | 10 s | 20 s |
| TCP `time-wait` | 2 min | 120 s | 15 s | 150 s |
| UDP | 2 min | 180 s | 30 s | 60 s |
| ICMP | 2 s | 60 s | 6 s | 30 s |
| Autre IP | 2 min | 300 s | 30 s | 60 s |

Ces valeurs sont des **données de profil**. Elles doivent être vérifiées
contre des sources réelles au moment de l'implémentation de chaque vendeur ;
le tableau ci-dessus est une base de travail à confirmer, pas une référence
établie. Cette réserve est écrite plutôt que tue : annoncer une valeur
exacte sans l'avoir mesurée est précisément ce que ce document reproche
ailleurs.

### 31.5 Formats de journal

Voir §23.4 et l'annexe §44.3.

---

# Partie IV — Exigences

---

## 32. Exigences fonctionnelles

### 32.1 Convention

| Priorité | Sens | Phase cible |
|---|---|---|
| **P0** | Sans elle le module n'existe pas | 1-2 |
| **P1** | Nécessaire à un usage pédagogique complet | 3-4 |
| **P2** | Attendue d'un pare-feu moderne | 5-6 |
| **P3** | Complète le tableau | 7-9 |
| **P4** | Souhaitable, non planifiée | — |

Les exigences détaillées sont réparties dans les sections thématiques de la
Partie II. Cette section les consolide, ajoute les exigences transverses qui
n'appartiennent à aucun chapitre, et fournit le tableau de suivi.

### 32.2 Récapitulatif par famille

| Famille | Préfixe | Nombre | § |
|---|---|---|---|
| Objets | `FR-OBJ` | 14 | 8.8 |
| Zones | `FR-ZON` | 10 | 9.5 |
| Sessions | `FR-SES` | 22 | 10.10 |
| Politique | `FR-POL` | 20 | 11.9 |
| NAT | `FR-NAT` | 18 | 12.9 |
| Pipeline | `FR-PIP` | 12 | 13.11 |
| Déploiement | `FR-DEP` | 10 | 14.7 |
| ALG | `FR-ALG` | 12 | 15.7 |
| Application / utilisateur | `FR-APP` / `FR-USR` | 14 | 16.5 |
| Profils | `FR-PRF` | 12 | 17.7 |
| Protection | `FR-SCR` | 9 | 18.6 |
| Routage | `FR-RTG` | 8 | 19.4 |
| VPN | `FR-VPN` | 8 | 20.3 |
| HA | `FR-HA` | 12 | 21.6 |
| Virtualisation | `FR-VIR` | 9 | 22.5 |
| Journalisation | `FR-LOG` | 12 | 23.7 |
| Gestion | `FR-MGT` | 11 | 24.3 |
| QoS | `FR-QOS` | 4 | 25.3 |
| Contrat vendeur | `FR-VEN` | 7 | 26.7 |
| Transverses | `FR-XVR` | 16 | 32.3 |
| **Total** | | **240** | |

### 32.3 Exigences transverses

| # | Exigence | Priorité |
|---|---|---|
| **FR-XVR-01** | Le pare-feu est une classe d'équipement à part entière, instanciable depuis `DeviceFactory` | P0 |
| **FR-XVR-02** | Les trois `DeviceType` existants sont recâblés sur les classes réelles | P0 |
| **FR-XVR-03** | `isFullyImplemented()` retourne `true` une fois la phase 4 livrée | P1 |
| **FR-XVR-04** | Aucun échange entre équipements ne contourne le fil | P0 |
| **FR-XVR-05** | Tout état interne est observable par au moins deux chemins | P0 |
| **FR-XVR-06** | Toute commande non simulée est refusée en nommant la brique manquante | P0 |
| **FR-XVR-07** | La configuration rendue reproduit exactement ce qui a été tapé | P0 |
| **FR-XVR-08** | La configuration rendue est rejouable à l'import | P0 |
| **FR-XVR-09** | Les compteurs sont incrémentés aux vrais points, jamais calculés à l'affichage | P0 |
| **FR-XVR-10** | Les minuteurs utilisent `src/events/Scheduler`, jamais `setTimeout` direct | P0 |
| **FR-XVR-11** | Les événements sont publiés sur `src/events/EventBus` | P0 |
| **FR-XVR-12** | Le code et les identifiants sont en anglais | P0 |
| **FR-XVR-13** | Aucun commentaire ajouté ; les noms portent le sens | P0 |
| **FR-XVR-14** | Complétion `Tab` et aide `?` sur toute la grammaire | P1 |
| **FR-XVR-15** | Les tables sont rendues par `TextTable`, jamais par concaténation manuelle | P1 |
| **FR-XVR-16** | Toute limite assumée est écrite dans le fichier ET dans ce document | P0 |

FR-XVR-15 mérite une justification : `CLAUDE.md` documente que six commandes
de quatre familles avaient un décalage entre en-tête et données, « jamais du
même côté », parce que l'en-tête était une chaîne littérale et les données
une autre. Le module pare-feu produira beaucoup de tables ; il commence donc
avec `TextTable` plutôt que d'y venir après correction.

### 32.4 Matrice exigence → cas d'usage

| Cas d'usage | Exigences principales |
|---|---|
| **UC-1** Inspection à états | FR-SES-01/03/05/06, FR-POL-02, FR-PIP-04 |
| **UC-2** La zone décide | FR-ZON-02/03, FR-POL-03, I-Z3 |
| **UC-3** Ordre d'opérations | FR-NAT-06, FR-PIP-01/03 |
| **UC-4** Lent / rapide | FR-PIP-04/05, FR-SES-21 |
| **UC-5** ALG | FR-ALG-01/03/04, FR-SES-16/17 |
| **UC-6** Diagnostic | FR-POL-09/19, FR-PIP-06/07, FR-LOG-02 |
| **UC-7** Rechargement | FR-XVR-07/08, FR-OBJ-14, FR-POL-20 |

---

## 33. Exigences non fonctionnelles

### 33.1 Performance

| # | Exigence | Cible | Justification |
|---|---|---|---|
| **NFR-P1** | Recherche de session | O(1) amorti | Chemin rapide sur chaque paquet |
| **NFR-P2** | Évaluation de politique | O(n) sur les règles, n ≤ 500 | Première correspondance |
| **NFR-P3** | Sessions simultanées | ≥ 5 000 sans dégradation perceptible | Suffisant pour tout laboratoire |
| **NFR-P4** | Balayage d'expiration | ≤ 5 ms par passage à 5 000 sessions | Ne doit pas bloquer l'interface |
| **NFR-P5** | Aplatissement d'objets | Mis en cache, invalidé par version | I-R2 |
| **NFR-P6** | Aucun minuteur par session | — | §10.6.1 |
| **NFR-P7** | Aucun re-rendu de canevas par paquet | — | Leçon de l'élément #52 du dépôt |

NFR-P7 mérite une attention particulière. Le dépôt a déjà corrigé un défaut
où le canevas se re-rendait 60 fois par seconde, et a établi une règle
explicite : ne jamais s'abonner en masse au bus, parce qu'il transporte un
événement **par trame Ethernet**. Un pare-feu produira davantage d'événements
que n'importe quel autre équipement ; la liste blanche de topics pour l'UI
doit donc être conçue restrictive dès le départ.

### 33.2 Fidélité

| # | Exigence |
|---|---|
| **NFR-F1** | Les sorties de commande sont mesurées contre des transcriptions réelles |
| **NFR-F2** | Les largeurs de colonne proviennent de captures, pas de documentation HTML |
| **NFR-F3** | Les messages d'erreur sont ceux du vendeur, mot pour mot |
| **NFR-F4** | Les valeurs par défaut sont celles du vendeur, vérifiées |
| **NFR-F5** | Un comportement non vérifiable est refusé plutôt qu'inventé |

### 33.3 Maintenabilité

| # | Exigence |
|---|---|
| **NFR-M1** | Aucun branchement par vendeur dans le socle |
| **NFR-M2** | Aucun moteur dans la couche vendeur |
| **NFR-M3** | ~~Aucun fichier du socle ne dépasse 800 lignes~~ — **retirée** |
| **NFR-M4** | Chaque magasin est indépendamment testable |
| **NFR-M5** | Les primitives NAT partagées ont un seul exemplaire |
| **NFR-M6** | Les accès aux sous-systèmes passent par des capacités ségrégées, pas des casts |

NFR-M3 était une contrainte volontaire, motivée par l'état de `Router.ts`
(5615 lignes) et `EndHost.ts` (4762 lignes). **Elle est retirée** : le
comptage de lignes s'est révélé un mauvais indicateur de couplage — il
imposait des extractions dictées par un compteur plutôt que par la
cohésion, et il coûtait plus de temps qu'il n'en faisait gagner. Ce qui
gouverne le découpage reste NFR-M1, NFR-M2, NFR-M4 et NFR-M6, qui parlent
tous de dépendances plutôt que de taille. Les garde-fous G1 et G3 qui
comptaient les lignes sont supprimés de
`architecture-guards.test.ts` ; les autres restent.

### 33.4 Testabilité

| # | Exigence |
|---|---|
| **NFR-T1** | Toute correction est accompagnée d'une sonde discriminée par `git stash` |
| **NFR-T2** | Les tests comptent des trames réelles, en différence |
| **NFR-T3** | Les tests de topologie construisent un laboratoire complet |
| **NFR-T4** | Aucune assertion `every()` sans un `length > 0` préalable |
| **NFR-T5** | Les assertions de succès sont ancrées, jamais des sous-chaînes ambiguës |

NFR-T4 et NFR-T5 viennent de défauts réels du dépôt : `every()` sur un
tableau vide est vrai, ce qui avait fait passer trois cas avec zéro paquet
émis ; et `/0% packet loss/` est une sous-chaîne de `100% packet loss`, ce
qui avait fait passer un test contre du code pré-correctif.

### 33.5 Compatibilité

| # | Exigence |
|---|---|
| **NFR-C1** | Aucune régression sur les suites existantes de routeur, commutateur, hôte |
| **NFR-C2** | L'extraction des primitives NAT laisse la suite NAT verte avant et après |
| **NFR-C3** | Le sérialiseur reste rétrocompatible : une topologie sans pare-feu se charge |
| **NFR-C4** | Les builds de production restent fonctionnels (`keepNames`) |

NFR-C4 rappelle une contrainte du dépôt : le simulateur dispatche sur
`instance.constructor.name`, ce qui impose `esbuild.keepNames: true`. Toute
nouvelle classe d'équipement en dépend.

---

## 34. Exigences UI/UX

### 34.1 Palette et canevas

| # | Exigence | Priorité |
|---|---|---|
| **FR-UI-01** | Icônes distinctes par constructeur | P1 |
| **FR-UI-02** | Retrait du bandeau « Limited simulation » une fois la phase 4 livrée | P1 |
| **FR-UI-03** | Ajout de `firewall-juniper` à la palette | P3 |
| **FR-UI-04** | Indicateur visuel de mode (routé / transparent / vwire / tap) | P2 |
| **FR-UI-05** | Indicateur d'état HA (actif / passif) | P3 |

### 34.2 Panneau de propriétés

| # | Exigence | Priorité |
|---|---|---|
| **FR-UI-06** | Onglet Zones avec appartenance des interfaces | P1 |
| **FR-UI-07** | Onglet Politique, en lecture, ordonné, avec compteurs | P1 |
| **FR-UI-08** | Onglet Sessions, avec rafraîchissement contrôlé | P1 |
| **FR-UI-09** | Onglet NAT, avec traductions actives | P2 |
| **FR-UI-10** | Compteurs globaux visibles | P1 |

**Contrainte** : ces vues sont en **lecture seule**. La configuration se
fait en CLI. Justification : le simulateur enseigne la CLI (non-objectif
N4), et une interface d'édition devrait reproduire quatre modèles de
configuration différents dont deux à commit — un produit à part entière.

### 34.3 Rafraîchissement

| # | Exigence | Priorité |
|---|---|---|
| **FR-UI-11** | Liste blanche de topics stricte pour l'UI | P0 |
| **FR-UI-12** | Aucune souscription par trame ni par paquet | P0 |
| **FR-UI-13** | Table de sessions rafraîchie au plus une fois par seconde | P1 |
| **FR-UI-14** | Table de sessions paginée | P1 |

### 34.4 Terminal

| # | Exigence | Priorité |
|---|---|---|
| **FR-UI-15** | Session de terminal par vendeur, prompt correct | P0 |
| **FR-UI-16** | Complétion `Tab` et aide `?` selon la convention du vendeur | P1 |
| **FR-UI-17** | Pagination `--More--` selon le vendeur | P2 |
| **FR-UI-18** | Coloration des verdicts dans les traces de diagnostic | P3 |

Note sur FR-UI-16 : les quatre vendeurs ont des conventions d'aide
**différentes** — `?` contextuel sur ASA, `?` en fin de ligne sur FortiOS,
`?` avec liste de valeurs sur PAN-OS, `?` et complétion par espace sur
Junos. C'est un champ de profil (`helpStyle`), pas un comportement unique.

### 34.5 Journal réseau

| # | Exigence | Priorité |
|---|---|---|
| **FR-UI-19** | Événements de pare-feu dans le journal réseau existant | P1 |
| **FR-UI-20** | Filtrage par verdict | P2 |
| **FR-UI-21** | Lien entre une ligne de journal et la session concernée | P3 |

---

## 35. Exigences de persistance

### 35.1 Ce qui doit être sérialisé

| Élément | Sérialisé | Mécanisme |
|---|---|---|
| Zones et appartenance | oui | Configuration rejouée |
| Objets et groupes | oui | Configuration rejouée |
| Politique complète, dans l'ordre | oui | Configuration rejouée |
| Politique NAT | oui | Configuration rejouée |
| Profils de sécurité | oui | Configuration rejouée |
| Screens | oui | Configuration rejouée |
| Interfaces, adresses, routes | oui | Déjà couvert par le sérialiseur |
| Mode de déploiement | oui | Configuration rejouée |
| Contextes virtuels | oui | Configuration rejouée |
| Configuration HA | oui | Configuration rejouée |
| **Sessions actives** | **non** | Déclaré dans les réserves |
| **Compteurs** | **non** | Déclaré |
| **Table de mappage d'utilisateurs** | **non** | Déclaré |
| **Traductions NAT actives** | **non** | Déclaré |
| **Journaux** | **non** | Déclaré |

### 35.2 Le mécanisme

Le sérialiseur du dépôt capture déjà « la configuration complète en cours et
de démarrage, rejouée à l'import via la vraie CLI ». Le pare-feu s'y insère
naturellement : sa configuration rendue **est** sa sérialisation.

C'est ce qui rend FR-XVR-07 (« la configuration rendue reproduit ce qui a
été tapé ») critique et non cosmétique.

### 35.3 Le cas du modèle candidat

Pour PAN-OS et Junos, deux configurations coexistent. Décision : **seule la
configuration active est sérialisée**. Un candidat non validé est perdu au
rechargement.

Justification : c'est le comportement réel d'un redémarrage non gracieux, et
sérialiser un candidat produirait un appareil rechargé dans un état
« modifications en attente » que l'apprenant n'a pas demandé. La réserve est
ajoutée à `TOPOLOGY_SAVE_CAVEATS`.

### 35.4 Exigences

| # | Exigence | Priorité |
|---|---|---|
| **FR-PER-01** | Configuration complète sérialisée et rejouée | P0 |
| **FR-PER-02** | Ordre des règles préservé | P0 |
| **FR-PER-03** | Réserves ajoutées à `TOPOLOGY_SAVE_CAVEATS` | P0 |
| **FR-PER-04** | Candidat non sérialisé, réserve déclarée | P2 |
| **FR-PER-05** | Rétrocompatibilité des topologies existantes | P0 |
| **FR-PER-06** | Test de round-trip : même trafic, même verdict | P0 |

---

# Partie V — Réalisation

---

## 36. Architecture technique cible

### 36.1 Arborescence

```
src/network/devices/firewall/
│
├── Firewall.ts                        façade (extends Equipment)
├── FirewallProfile.ts                 le contrat déclaratif
├── FirewallDependencies.ts            injection
├── types.ts                           types partagés
├── capabilities.ts                    capacités ségrégées
│
├── l3/                                services de couche 3, par composition
│   ├── L3Services.ts                  les cinq interfaces
│   ├── InterfaceTable.ts
│   ├── RouteTable.ts
│   ├── ArpService.ts
│   ├── IcmpService.ts
│   ├── L2Delivery.ts
│   └── FrameDispatcher.ts
│
├── model/
│   ├── SecurityZone.ts
│   ├── ZoneTable.ts
│   ├── AddressObject.ts
│   ├── ServiceObject.ts
│   ├── ScheduleObject.ts
│   ├── ObjectGroup.ts
│   ├── ObjectStore.ts
│   ├── SecurityRule.ts
│   ├── PolicyStore.ts
│   ├── NatRule.ts
│   └── NatPolicyStore.ts
│
├── session/
│   ├── FirewallSession.ts
│   ├── SessionTable.ts
│   ├── SessionKey.ts
│   ├── TcpStateMachine.ts
│   ├── SessionAging.ts
│   └── SessionCounters.ts
│
├── pipeline/
│   ├── PacketContext.ts
│   ├── FirewallPipeline.ts
│   ├── PipelineStageRegistry.ts
│   └── stages/
│       ├── ingressSanity.ts
│       ├── ingressZone.ts
│       ├── screenIngress.ts
│       ├── defrag.ts
│       ├── sessionLookup.ts
│       ├── tcpStateCheck.ts
│       ├── natDestination.ts
│       ├── routeLookup.ts
│       ├── egressZone.ts
│       ├── selfTraffic.ts
│       ├── policyLookup.ts
│       ├── natSource.ts
│       ├── sessionInstall.ts
│       ├── algInspect.ts
│       ├── appId.ts
│       ├── contentInspect.ts
│       ├── shaping.ts
│       ├── ttlDecrement.ts
│       ├── fragment.ts
│       └── egress.ts
│
├── policy/
│   ├── PolicyEvaluator.ts
│   ├── MatchCriteria.ts
│   ├── ObjectResolver.ts
│   ├── ImplicitPolicy.ts
│   └── PolicyAnalyzer.ts
│
├── nat/
│   ├── FirewallNatEngine.ts
│   ├── NatRuleMatcher.ts
│   └── NatPoolManager.ts
│
├── alg/
│   ├── Alg.ts
│   ├── AlgRegistry.ts
│   ├── AlgContext.ts
│   ├── PinholeManager.ts
│   └── impl/
│       ├── FtpAlg.ts
│       ├── TftpAlg.ts
│       ├── DnsAlg.ts
│       └── IcmpErrorAlg.ts
│
├── identification/
│   ├── ApplicationSignature.ts
│   ├── ApplicationIdentifier.ts
│   ├── UserIdentityTable.ts
│   └── sources/
│       ├── RadiusAccountingSource.ts
│       ├── CaptivePortalSource.ts
│       └── StaticMappingSource.ts
│
├── profiles/
│   ├── SecurityProfile.ts
│   ├── ProfileStore.ts
│   ├── UrlFilteringEngine.ts
│   ├── DnsFilteringEngine.ts
│   ├── FileBlockingEngine.ts
│   └── data/
│       └── urlCategories.ts
│
├── screen/
│   ├── ScreenProfile.ts
│   ├── ScreenStore.ts
│   ├── AnomalyDetector.ts
│   ├── FloodDetector.ts
│   └── ReconDetector.ts
│
├── deployment/
│   ├── DeploymentMode.ts
│   ├── BridgeGroup.ts
│   ├── VirtualWire.ts
│   └── TransparentForwarder.ts
│
├── ha/
│   ├── HaConfiguration.ts
│   ├── HaAgent.ts
│   ├── HaControlProtocol.ts
│   └── HaSessionSync.ts
│
├── virtual/
│   ├── VirtualFirewall.ts
│   └── VirtualFirewallRegistry.ts
│
├── logging/
│   ├── FirewallLogger.ts
│   ├── TrafficLogRecord.ts
│   └── formatters/
│       ├── AsaLogFormatter.ts
│       ├── FortiOsLogFormatter.ts
│       ├── PanOsLogFormatter.ts
│       └── JunosLogFormatter.ts
│
├── config/
│   ├── ConfigurationModel.ts
│   ├── CandidateConfiguration.ts
│   └── CommitManager.ts
│
└── vendors/
    ├── asa/
    │   ├── AsaFirewall.ts
    │   ├── AsaProfile.ts
    │   ├── AsaShell.ts
    │   ├── AsaRenderer.ts
    │   ├── AsaMessages.ts
    │   ├── AsaPredefinedObjects.ts
    │   └── AsaSpecifics.ts
    ├── fortios/
    │   ├── FortiGateFirewall.ts
    │   ├── FortiOsProfile.ts
    │   ├── FortiOsShell.ts
    │   ├── FortiOsSchema.ts
    │   ├── FortiOsRenderer.ts
    │   ├── FortiOsMessages.ts
    │   └── FortiOsPredefinedObjects.ts
    ├── panos/
    │   ├── PanOsFirewall.ts
    │   ├── PanOsProfile.ts
    │   ├── PanOsShell.ts
    │   ├── PanOsRenderer.ts
    │   ├── PanOsMessages.ts
    │   └── PanOsApplications.ts
    └── junos/
        ├── SrxFirewall.ts
        ├── JunosProfile.ts
        ├── JunosSecurityShell.ts
        ├── JunosRenderer.ts
        └── JunosMessages.ts

src/network/nat/                       primitives extraites (§12.5)
├── rewrite.ts
├── portAllocator.ts
└── hairpin.ts
```

### 36.2 Justification de chaque brique nouvelle

Conformément à P11, chaque module nouveau doit justifier pourquoi l'existant
ne suffisait pas.

| Module | L'existant qui aurait pu servir | Pourquoi il ne suffit pas |
|---|---|---|
| `SessionTable` | `LinuxIptablesManager.conntrack` | Pas d'objet session, pas de machine à états TCP, pas de compteurs, pas d'interfaces mémorisées (§10.9) |
| `PolicyStore` | `ACLEngine` | Pas de zones, pas d'objets, pas de profils, pas d'octets (§4.1.2) |
| `FirewallNatEngine` | `router/NATEngine` | Déclenchement lié aux interfaces, pas de politique ordonnée (§12.5) |
| `FirewallPipeline` | `Router.processIPv4` | Ordre figé, incompatible avec les quatre vendeurs (§13) |
| `ObjectStore` | aucun | Le concept n'existe pas |
| `ZoneTable` | aucun | Le concept n'existe pas |
| `AlgRegistry` | `FtpAlg` | Un ALG unique, non enregistrable (§15.2) |
| `ScreenStore` | aucun | Le concept n'existe pas |
| `TransparentForwarder` | `Switch` / `SwitchSvi` | Réutilisés, pas réécrits (§14.3.1) |
| `HaAgent` | `HsrpAgent` / `VrrpAgent` | Protocoles différents ; l'ARP gratuit est réutilisé |
| `FirewallLogger` | `LoggingConfig` | Étendu, pas dupliqué (§23.2) |
| `pipeline/` | `FilterChain` | **Réutilisé tel quel** (§4.1.5) |
| `l3/InterfaceTable` | `Router`'s interfaces | Composition retenue plutôt qu'héritage (§7.3.1) ; bâti sur `Port`, déjà complet |
| `l3/RouteTable` | `Router.lookupRoute` | Idem ; bâti sur `core/ip.ts` et `IIPv4Route` |
| `l3/ArpService` | `Router`'s ARP | Idem ; contrat `INeighborResolver` déjà défini dans `core/` |
| `l3/IcmpService` | `Router`'s ICMP | Idem ; `core/IcmpErrors.ts` réutilisé |

### 36.3 La classe `Firewall`

```ts
export abstract class Firewall extends Equipment {
  private readonly l3: L3Services;
  private readonly stores: FirewallStores;
  private readonly pipeline: FirewallPipeline;
  private readonly counters: FirewallCounters;

  protected constructor(deps: FirewallDependencies) {
    super(deps.deviceType, deps.name, deps.x, deps.y);
    this.l3 = deps.l3 ?? createDefaultL3Services(this);
    this.stores = deps.stores ?? createDefaultStores(deps.profile);
    this.pipeline = FirewallPipeline.fromProfile(deps.profile, deps.stageRegistry);
    this.counters = new FirewallCounters();
  }

  protected handleFrame(portName: string, frame: EthernetFrame): void {
    this.frameDispatcher.dispatch(portName, frame);
  }

  getSessionTable(): SessionTableView { return this.stores.sessions.view(); }
  getPolicyStore(): PolicyStoreView { return this.stores.policy.view(); }
  getZoneTable(): ZoneTableView { return this.stores.zones.view(); }
  abstract getProfile(): FirewallProfile;
}
```

Trois propriétés de cette signature méritent d'être relevées, parce
qu'elles sont ce que l'option B achète :

- **Tout est injectable.** `FirewallDependencies` porte des valeurs par
  défaut, si bien qu'un test fournit un double de `RouteTable` ou de
  `SessionTable` sans instancier de topologie. C'est ce qui rend le TDD
  praticable sur ce module.
- **Aucun `override` d'un chemin hérité.** Il n'y a rien à neutraliser :
  `handleFrame` est la seule méthode abstraite d'`Equipment`, et le pare-feu
  l'implémente pour son propre compte.
- **La façade ne décide de rien.** Chaque accesseur délègue. C'est ce qui
  tient NFR-M3.

### 36.3.1 Les services L3

```ts
export interface L3Services {
  readonly interfaces: InterfaceTable;
  readonly routes: RouteTable;
  readonly arp: ArpService;
  readonly icmp: IcmpService;
  readonly delivery: L2Delivery;
}
```

Chacun est une interface, donc substituable. `createDefaultL3Services()`
fournit l'implémentation réelle ; un test fournit ce qu'il veut.

Note de périmètre, écrite plutôt que tue : ces cinq services sont
**nouveaux**, mais ils ne dupliquent pas `Router` au sens où le ferait un
copier-coller — ils s'appuient sur les mêmes primitives autonomes de
`core/` (§7.3.2) et n'implémentent que ce qu'un pare-feu utilise. Le jour où
une convergence avec `Router` deviendrait souhaitable, elle se ferait en
faisant consommer ces interfaces par `Router`, jamais l'inverse — même règle
de sens que celle posée en §10.9 pour les tables d'état.

### 36.4 L'arbitrage NAT, tranché

Décision : **option C** (§12.5) — nouveau `FirewallNatEngine`, primitives
extraites en `src/network/nat/`.

Le plan d'extraction, à exécuter en phase 2 et isolément :

| Étape | Action | Vérification |
|---|---|---|
| 1 | Suite NAT existante verte, capturée comme référence | `npx vitest run` sur `nat-*.test.ts` |
| 2 | Créer `src/network/nat/rewrite.ts`, y **déplacer** les fonctions de `NATEngine` | Aucun changement de comportement |
| 3 | `NATEngine` importe depuis le nouveau module | Suite verte |
| 4 | Idem pour `portAllocator.ts` et `hairpin.ts` | Suite verte |
| 5 | Vérifier que `EndHost`'s helpers homonymes convergent ou sont documentés comme distincts | Suite verte |
| 6 | `FirewallNatEngine` consomme les primitives | Nouvelles sondes |

L'étape 5 mérite un mot : `PRD-Port-Forwarding.md` phase 5 a créé
`parseNatAddress()`/`rewriteNatAddress()` dans `EndHost`, « délibérément non
unifiés avec les homonymes privés de `router/NATEngine.ts` — même forme,
moteur différent, consolidation non demandée ». Cette consolidation devient
maintenant souhaitable, mais elle reste **hors périmètre de ce module** :
elle sera proposée séparément, avec sa propre sonde.

### 36.5 Les capacités ségrégées

Suivant le patron de `RouterServiceCapabilities.ts` :

```ts
export interface FirewallHost { getProfile(): FirewallProfile; }
export interface SessionTableHost { getSessionTable(): SessionTableView; }
export interface PolicyStoreHost { getPolicyStore(): PolicyStoreView; }
export interface ZoneTableHost { getZoneTable(): ZoneTableView; }
export interface ObjectStoreHost { getObjectStore(): ObjectStoreView; }
export interface NatPolicyHost { getNatPolicy(): NatPolicyStoreView; }
export interface AlgRegistryHost { getAlgRegistry(): AlgRegistryView; }
export interface HaAgentHost { getHaAgent(): HaAgent; }

export function isFirewall(dev: unknown): dev is FirewallHost { … }
export function isSessionTableHost(dev: unknown): dev is SessionTableHost { … }
```

Ce patron est explicitement recommandé par `CLAUDE.md` : « préférer étendre
celles-ci plutôt qu'un nouveau `dev as unknown as { getXxx?: () => Yyy }` au
point d'appel ».

### 36.6 Intégration `DeviceFactory`

```ts
case 'firewall-cisco':     return new AsaFirewall('firewall-cisco', name, x, y);
case 'firewall-fortinet':  return new FortiGateFirewall('firewall-fortinet', name, x, y);
case 'firewall-paloalto':  return new PanOsFirewall('firewall-paloalto', name, x, y);
case 'firewall-juniper':   return new SrxFirewall('firewall-juniper', name, x, y);
```

`DeviceType` gagne `'firewall-juniper'`.

### 36.7 Intégration `ShellFactory`

```ts
ShellFactory.register('asa',     AsaShell);
ShellFactory.register('fortios', FortiOsShell);
ShellFactory.register('panos',   PanOsShell);
ShellFactory.register('junos',   JunosSecurityShell);
```

`getOSType()` retourne ces chaînes, ce qui pilote `sessionFactory` et
`primaryShellKindFor`. **Point de vigilance mesuré** : `GenericSwitch`
retournait `'generic'`, ce qui le faisait retomber sur un terminal bash — un
commutateur avec un shell Cisco recevait un terminal Linux. Les quatre
nouvelles chaînes doivent être ajoutées aux tables de dispatch, sinon le
même défaut se reproduit.

---

## 37. Modèle de données

### 37.1 Vue d'ensemble des types

```
FirewallProfile ────────────┐
                            ├──▶ FirewallPipeline ──▶ FilterChain<PacketContext>
PipelineStageName[] ────────┘

PacketContext ──▶ IPv4Packet | IPv6Packet
             ├──▶ FirewallSession
             ├──▶ SecurityRule
             ├──▶ NatRuleMatch[]
             └──▶ PipelineTraceEntry[]

FirewallSession ──▶ FlowKey × 2
                ├──▶ SessionCounters
                ├──▶ SessionTranslation
                └──▶ TcpSessionState

SecurityRule ──▶ string[] (références d'objets)
             └──▶ SecurityProfileRefs

AddressObject / ServiceObject / ScheduleObject / ObjectGroup
             └──▶ ObjectStore ──▶ ObjectResolver ──▶ AddressSet / ServiceSet
```

### 37.2 Types complémentaires

```ts
export type VerdictReason =
  | 'policy-deny'
  | 'implicit-deny'
  | 'security-level'
  | 'no-route'
  | 'no-session-non-syn'
  | 'invalid-tcp-flags'
  | 'tcp-state-violation'
  | 'sequence-out-of-window'
  | 'session-table-full'
  | 'nat-port-exhausted'
  | 'nat-no-rule'
  | 'screen-anomaly'
  | 'screen-flood'
  | 'screen-recon'
  | 'alg-violation'
  | 'profile-block'
  | 'application-shift-deny'
  | 'zone-mismatch'
  | 'interface-down'
  | 'ttl-expired'
  | 'mtu-exceeded-df'
  | 'unsupported-protocol'
  | 'context-not-found';

export interface FirewallVerdict {
  action: 'accept' | 'deny' | 'drop' | 'reset' | 'reject';
  reason: VerdictReason;
  stage: string;
  ruleId?: string;
  sendResetTo?: 'client' | 'server' | 'both';
  icmpCode?: number;
}
```

Vingt-deux motifs de rejet distincts. C'est ce qui rend P10 mesurable, et
c'est ce que consomme `byDenyReason` (§23.6) et
`show counter global filter severity drop` (§29.4.5).

### 37.3 Vues de lecture

Chaque magasin expose une vue immuable, seule surface que la couche vendeur
peut consommer.

```ts
export interface SessionTableView {
  count(): number;
  all(): readonly FirewallSession[];
  find(filter: SessionFilter): readonly FirewallSession[];
  byId(id: number): FirewallSession | undefined;
  statistics(): SessionStatistics;
}

export interface PolicyStoreView {
  ordered(): readonly SecurityRule[];
  byId(id: string): SecurityRule | undefined;
  implicitRule(): SecurityRule;
  statistics(): PolicyStatistics;
}
```

**Invariant I-V1** : une vue ne permet aucune mutation. C'est le garde-fou
mécanique de FR-VEN-02 (« aucun moteur dans la couche vendeur ») : un
`Renderer` qui ne peut pas muter ne peut pas décider.

### 37.4 Événements de bus

```
firewall.session.created      { deviceId, sessionId, c2s, s2c, ruleId, zones }
firewall.session.closed       { deviceId, sessionId, reason, counters, duration }
firewall.session.denied       { deviceId, reason, ruleId, flow }
firewall.policy.matched       { deviceId, ruleId, sessionId }
firewall.policy.changed       { deviceId, ruleId, operation }
firewall.nat.translated       { deviceId, sessionId, translation }
firewall.nat.exhausted        { deviceId, poolName }
firewall.alg.pinhole-opened   { deviceId, algName, parentSessionId, spec }
firewall.alg.pinhole-closed   { deviceId, sessionId, reason }
firewall.screen.triggered     { deviceId, anomaly, source, zone }
firewall.ha.state-changed     { deviceId, from, to, reason }
firewall.commit.applied       { deviceId, jobId, changes }
firewall.table.full           { deviceId, table }
```

**Contrainte UI** (FR-UI-11) : seuls `session.created`, `session.closed`,
`ha.state-changed` et `table.full` sont dans la liste blanche du canevas.
Les autres sont réservés aux tests, au journal et au débogage — publier
`policy.matched` vers l'UI reproduirait le défaut de re-rendu par paquet.

---

## 38. Points d'extension

> Récapitulatif des coutures conçues pour l'avenir. Chacune est un endroit
> où l'on pourra ajouter sans modifier.

| # | Point d'extension | Ce qu'il permet d'ajouter sans toucher au socle |
|---|---|---|
| **E1** | `PipelineStageRegistry` | Une étape de traitement nouvelle |
| **E2** | `FirewallProfile` | Un constructeur entier |
| **E3** | `AlgRegistry` | Un ALG |
| **E4** | `ProfileStore` + `SecurityProfileKind` | Un type de profil de sécurité |
| **E5** | `ObjectKind` | Un type d'objet |
| **E6** | `UserIdSource` | Une source d'identification |
| **E7** | `LogFormatterId` | Un format de journal |
| **E8** | `AppMatcher` | Un mode d'identification applicative |
| **E9** | `DeploymentMode` | Un mode de déploiement |
| **E10** | `ShellFactory` | Un dialecte CLI |
| **E11** | `VerdictReason` | Un motif de rejet |
| **E12** | `ScreenProfile` | Un contrôle d'anomalie |
| **E13** | Capacités ségrégées | Un sous-système optionnel |
| **E14** | `ConfigurationModel` | Un modèle de configuration |

### 38.1 Le test des points d'extension

Un point d'extension qui n'a jamais servi n'est pas prouvé. La phase 9
(ajout de Junos) est explicitement conçue pour exercer E1, E2, E7, E10, E11
et E14 — c'est sa justification principale (§30.6).

### 38.2 Extensions futures envisagées, non planifiées

| Extension | Points utilisés | Note |
|---|---|---|
| Check Point | E2, E10, E7 | Modèle de politique très proche du socle |
| pfSense / OPNsense | E2, E10, E7, E13 | Cas particulier : ils exposent une vue netfilter (§10.9) |
| Huawei USG | E2, E10 | VRP a déjà quatre dialectes dans le dépôt |
| Sophos / SonicWall | E2, E10 | — |
| Pare-feu applicatif web | E1, E4 | Étape de pipeline supplémentaire |
| Déchiffrement TLS | E1, E4 | Bloqué sur le format PEM (§43) |
| SD-WAN | E1, E9 | Sélection de chemin applicative |

---

## 39. Découpage en phases

### 39.1 Principes de découpage

1. Chaque phase est **livrable** : elle produit un comportement observable,
   pas une couche inerte.
2. Chaque phase a sa **sonde discriminée** : un test qui échoue avant, passe
   après.
3. Aucune phase ne laisse une commande acceptée sans effet.
4. L'ordre suit la dépendance réelle, pas l'ordre du document.

### 39.2 Le plan

| Phase | Titre | Contenu | Sortie observable |
|---|---|---|---|
| **1** | Le socle vivant | `Firewall`, `SessionTable`, `ZoneTable`, `ObjectStore`, `PolicyStore`, pipeline générique, profil générique | UC-1 et UC-2 fonctionnent sur un pare-feu générique |
| **2** | Le NAT | Extraction des primitives, `FirewallNatEngine`, politique NAT ordonnée | UC-3 partiellement ; L2 et L3 fonctionnent |
| **3** | La première déclinaison — ASA | `AsaProfile`, `AsaShell`, `AsaRenderer`, `packet-tracer` | Un ASA se configure et se diagnostique |
| **4** | Diagnostic et journaux | Traces, compteurs par motif, journaux au format vendeur, analyse de politique | UC-6 ; L11 et L12 |
| **5** | La deuxième déclinaison — FortiOS | Schéma déclaratif, `config/edit/set`, VIP, NAT de politique | Le contrat de §26 est testé une première fois |
| **6** | ALG et inspection | Cadre d'ALG, migration FTP, TFTP, DNS, ICMP erreur | UC-5 ; L5 |
| **7** | La troisième déclinaison — PAN-OS | Modèle candidat, `commit`, App-ID, re-recherche | L6 ; le modèle candidat est prouvé |
| **8** | Protection et profils | Screens, anomalies, filtrage d'URL et DNS réels | Laboratoires de scan et de filtrage web |
| **9** | La quatrième déclinaison — Junos | Profil, shell, rendus | **Le contrat est validé** (§30.6) |
| **10** | Modes de déploiement | Transparent, groupes de pont, virtual wire, tap | L7 |
| **11** | VPN | Zone de tunnel, exemption NAT, politique sur trafic déchiffré | L10 |
| **12** | Haute disponibilité | Liens de contrôle et de données, synchronisation réelle, basculement | L8 |
| **13** | Virtualisation | Contextes avec isolation réelle | L9 |
| **14** | Identification | Utilisateur (RADIUS, portail), applications | — |
| **15** | Finitions | QoS, exigences P3/P4 restantes | — |

### 39.3 Détail des trois premières phases

#### Phase 1 — Le socle vivant

| Livrable | Détail |
|---|---|
| `l3/` | Les cinq services de couche 3, injectables |
| `Firewall.ts` | Façade sur `Equipment`, assemble et délègue |
| `SessionTable` | Index directionnel, objet session, machine à états TCP, expiration par balayage |
| `ZoneTable` | Zones, appartenance, invariants I-Z1 à I-Z6 |
| `ObjectStore` | Adresses, services, groupes, résolution, invariants I-A et I-G |
| `PolicyStore` | Règles ordonnées, évaluation, règle implicite, compteurs |
| `FirewallPipeline` | Sur `FilterChain`, 12 étapes minimales |
| `GenericProfile` | Un profil neutre, pour tester le socle sans vendeur |
| Shell minimal | Assez pour configurer zones, objets, règles, et lire la table |

**Sonde de phase 1** : `probe-firewall-stateful-baseline.test.ts`
- une session TCP s'ouvre à travers le pare-feu avec une seule règle aller ;
- le retour passe ;
- un ACK forgé sans session est refusé, motif `no-session-non-syn` ;
- `clear` coupe la session ;
- une interface déplacée de zone change le verdict ;
- une zone vide ne correspond à rien ;
- un groupe vide ne correspond à rien.

**Critère de sortie** : les trames traversent un vrai câble, comptées en
différence.

#### Phase 2 — Le NAT

| Livrable | Détail |
|---|---|
| `src/network/nat/` | Primitives extraites, suite existante verte |
| `FirewallNatEngine` | Politique ordonnée, types de règle |
| `SessionTranslation` | Traduction mémorisée sur la session |
| `NatPoolManager` | Allocation, libération, épuisement |
| `natOrder` | Cinq booléens honorés par le pipeline |

**Sonde de phase 2** : `probe-firewall-nat-order.test.ts`
- PAT sortant avec une vraie poignée de main TCP ;
- publication de serveur, retour dé-NATé ;
- les cinq booléens produisent cinq comportements distincts ;
- épuisement de pool, motif distinct ;
- hairpin.

#### Phase 3 — ASA

| Livrable | Détail |
|---|---|
| `AsaProfile` | Niveaux de sécurité, ordre 8.3+, immédiat |
| `AsaShell` | `nameif`, `security-level`, `object`, `access-list`, `nat`, `show conn`, `packet-tracer` |
| `AsaRenderer` | Configuration, `show`, syslog numéroté |
| `AsaSpecifics` | NAT automatique, sections NAT, MPF |

**Sonde de phase 3** : `probe-asa-security-levels.test.ts`
- haut→bas passe sans ACL ;
- bas→haut est refusé sans ACL ;
- même→même refusé, puis autorisé par `same-security-traffic` ;
- une ACL appliquée remplace le comportement implicite ;
- `ping` inside→outside échoue sans `inspect icmp` et réussit avec ;
- `packet-tracer` rend le même verdict que le trafic réel.

L'avant-dernier point est le cas de recette le plus important de la phase :
il prouve que le simulateur reproduit un ASA réel plutôt qu'un ASA
complaisant.

### 39.4 Estimation d'effort

| Phase | Complexité | Dépendances |
|---|---|---|
| 1 | **Très élevée** | Aucune |
| 2 | Élevée | 1 |
| 3 | Élevée | 1, 2 |
| 4 | Moyenne | 1, 2, 3 |
| 5 | Élevée | 1-4 |
| 6 | Moyenne | 1, `FtpAlg` existant |
| 7 | **Très élevée** | 1-5 (modèle candidat) |
| 8 | Moyenne | 1, `Ipv4Reassembler`, `http/`, `dns/` |
| 9 | Moyenne | 1-7 (le contrat doit être stable) |
| 10 | Élevée | 1, `Switch` |
| 11 | Moyenne | 1, `ipsec/` |
| 12 | Élevée | 1, `Scheduler`, ARP gratuit |
| 13 | Élevée | 1 (isolation réelle) |
| 14 | Moyenne | 1, `radius/`, `dot1x/` |
| 15 | Faible | — |

La phase 7 est marquée très élevée non pour PAN-OS lui-même, mais pour le
**modèle candidat** : il impose que toutes les mutations passent par une
couche unique (FR-MGT-11), contrainte à poser dès la phase 1 même si elle
n'est exercée qu'en phase 7. C'est signalé ici pour qu'elle ne soit pas
découverte tardivement.

---

## 40. Stratégie de test

### 40.1 Les niveaux

| Niveau | Objet | Emplacement |
|---|---|---|
| **Unitaire** | Un magasin, un évaluateur, une machine à états | `unit/network-v2/firewall/` |
| **Intégration** | Le pipeline complet sur un contexte synthétique | idem |
| **Topologie** | Un laboratoire réel avec câbles et trames | idem |
| **Sonde de phase** | Discriminée par `git stash` | `probe-firewall-*.test.ts` |
| **Garde-fou** | Contraintes d'architecture | `firewall-architecture-guards.test.ts` |
| **Transcription** | Longue séquence de commandes, pour analyse d'écart | `debug/firewall/` |

### 40.1.1 La démarche est TDD

Chaque mini-livraison suit le cycle, sans exception :

```
1. Écrire le test qui décrit le comportement voulu
2. L'exécuter → il ÉCHOUE (et l'échec est celui attendu, pas une erreur d'import)
3. Écrire le minimum de code qui le fait passer
4. L'exécuter → il PASSE
5. Nettoyer, en gardant le test vert
6. Commit + push
```

L'étape 2 est celle qu'on saute par facilité et c'est la seule qui prouve
quelque chose : un test qui n'a jamais échoué ne démontre pas qu'il teste.
La discipline est la même que celle de la sonde discriminée (§40.2), appliquée
en continu plutôt qu'à la fin.

### 40.1.2 La portée de la non-régression

**Règle** : les tests de régression exécutés à chaque mini-livraison portent
sur les **fonctionnalités connexes**, pas sur l'ensemble du dépôt.

| Ce qui est modifié | Suites à exécuter |
|---|---|
| Un magasin du socle (`ZoneTable`, `ObjectStore`, …) | Les tests de ce magasin |
| Le pipeline ou une étape | `firewall/pipeline/`, `firewall/session/` |
| Un service L3 | `firewall/l3/` |
| Une déclinaison vendeur | La suite de ce vendeur uniquement |
| Une primitive NAT partagée (§36.4) | `nat-*.test.ts` — **la seule extraction qui sorte du module** |

Justification : le module pare-feu est **additif**. Il ne modifie aucun
fichier existant hors de trois points d'intégration explicites
(`DeviceFactory`, `DeviceType`, `ShellFactory`), et l'extraction NAT de la
phase 2. Exécuter la suite complète du dépôt à chaque commit coûterait des
minutes pour ne rien mesurer de plus que la suite ciblée.

La suite complète est exécutée à trois moments, et à ceux-là seulement : à
la fin de chaque **phase**, avant l'extraction NAT de la phase 2, et après.

### 40.2 La sonde discriminée — méthode obligatoire

Convention établie du dépôt : chaque correction est accompagnée d'un test
qui **échoue authentiquement avant** le correctif.

```
1. Écrire la sonde
2. git stash le correctif
3. Exécuter → N cas échouent
4. git stash pop
5. Exécuter → tous passent
6. Écrire N dans l'en-tête du fichier de test
7. Nommer les cas qui passent des deux côtés, et pourquoi
```

L'étape 7 est aussi importante que les autres. `CLAUDE.md` en donne
plusieurs exemples : « les 4 restants sont nommés dans l'en-tête du fichier
plutôt que laissés à découvrir — deux sont les cas de non-régression, les
deux autres passaient pour une raison qui ne prouve rien du mécanisme ».

### 40.3 Le témoin

Plusieurs corrections de ce dépôt ont failli conclure à un défaut alors que
le laboratoire était mal monté. La règle qui en découle : **toute sonde qui
mesure une absence doit porter un témoin positif monté dans le même
laboratoire.**

Exemples pour ce module :

| Sonde | Témoin nécessaire |
|---|---|
| « le retour est refusé sans session » | le même échange **avec** session, qui passe |
| « la règle FQDN ne correspond plus après changement DNS » | la même règle avant changement, qui correspond |
| « le trafic est refusé sans `commit` » | le même trafic après `commit`, qui passe |
| « la synchronisation HA préserve la session » | le même basculement **sans** synchronisation, qui la coupe |

### 40.4 Le comptage de trames

Règle P6 appliquée aux tests : mesurer la **différence** de trames avec et
sans la charge utile, jamais un total non nul.

```ts
const baseline = countFrames(() => runWithoutPayload());
const withPayload = countFrames(() => runWithPayload());
expect(withPayload - baseline).toBeGreaterThan(0);
```

### 40.5 Pièges de test identifiés

| Piège | Règle |
|---|---|
| `every()` sur tableau vide est vrai | Toujours précéder d'un `length > 0` |
| `/0% packet loss/` est dans `100% packet loss` | Ancrer : `/, 0% packet loss/` |
| Abonnement au bus après le câblage | S'abonner **avant**, sinon la rafale initiale est manquée |
| Horloge virtuelle non avancée | Avancer explicitement pour les expirations |
| Session réutilisée entre deux `it()` | Réinitialiser la table de sessions |

Le troisième piège est mesuré : trois protocoles avaient été « soupçonnés à
tort » d'être muets, alors que l'abonnement au bus avait été posé après le
câblage.

### 40.6 Les garde-fous d'architecture

Tests mécaniques, exécutés en continu :

| # | Garde-fou | Vérification |
|---|---|---|
| **G1** | Aucun moteur dans la couche vendeur | Aucun fichier de `vendors/` n'importe un moteur du socle |
| **G2** | Aucun branchement par vendeur dans le socle | Aucune occurrence de `vendor ===` hors des profils |
| ~~**G3**~~ | ~~Aucun fichier du socle > 800 lignes~~ | **Retiré** — voir §33.3 |
| **G4** | Toute commande enregistrée a une description | Le dépôt possède déjà `cisco-help-every-keyword-described` |
| **G5** | Aucun `setTimeout` direct | Recherche |
| **G6** | Chaque `VerdictReason` a au moins un producteur | Recherche croisée |
| **G7** | Chaque étape déclarée par un profil existe au registre | Vérification au démarrage |
| **G8** | Les vues de lecture n'exposent aucune mutation | Vérification de type |

G4 est repris d'un garde-fou existant du dépôt, qui « a attrapé quatre
nœuds intermédiaires nus » — preuve que ce type de test travaille.

Les huit sont écrits, dans
`src/__tests__/unit/network-v2/firewall/architecture-guards.test.ts`.
G1, G2 et G5 y portent leur numéro ; G4, G6 et G7 y sont nommés
**G-P3**, **G-P2** et **G-P1**, et G8 **G-P4**, parce que le BRD
FortiGate (§31.4) donne déjà un autre sens à G6, G7 et G8 et que le
fichier porte les deux séries. Chacun a son **témoin** : un garde-fou
qu'on ne voit jamais échouer ne prouve pas qu'il regarde.

### 40.7 Couverture cible

| Module | Cible |
|---|---|
| `session/` | 90 % |
| `policy/` | 90 % |
| `pipeline/` | 85 % |
| `nat/` | 85 % |
| `model/` | 80 % |
| `vendors/*/` | 70 % |

### 40.8 Laboratoires de recette

Chaque laboratoire de §5.3 devient un test de topologie complet, avec de
vraies trames.

---

## 41. Critères d'acceptation

### 41.1 Critères du socle

| # | Critère | Vérification |
|---|---|---|
| **AC-S1** | Les sept cas d'usage fondateurs passent sur le profil générique | Tests de topologie |
| **AC-S2** | Aucun branchement par vendeur dans le socle | G2 |
| **AC-S3** | Le pipeline est composé depuis une donnée | Inspection + G7 |
| **AC-S4** | La table de sessions est une mesure | Sonde |
| **AC-S5** | 22 motifs de rejet distincts, chacun produit | G6 |
| **AC-S6** | Le chemin rapide ne consulte pas la politique | Compteurs |
| **AC-S7** | L'outil de diagnostic lit le pipeline réel | Sonde d'égalité de verdict |
| **AC-S8** | Round-trip de topologie : même trafic, même verdict | Sonde |

### 41.2 Critères par déclinaison

| # | Critère |
|---|---|
| **AC-V1** | Cinq artefacts, aucun moteur |
| **AC-V2** | Les commandes du cursus visé sont acceptées et agissent |
| **AC-V3** | Les commandes non simulées sont refusées en nommant le manque |
| **AC-V4** | Les commandes inexistantes reçoivent le message du vendeur |
| **AC-V5** | La configuration rendue reproduit ce qui a été tapé |
| **AC-V6** | Le format de journal est celui du vendeur, sans champ inventé |
| **AC-V7** | La sonde de déclinaison est discriminée |
| **AC-V8** | Les spécificités irréductibles sont documentées ici |

### 41.3 Le critère de validation du contrat

**AC-C1** : l'ajout de la quatrième déclinaison (Junos, phase 9) ne modifie
**aucun** fichier du socle, hors ajout de valeurs à des unions ouvertes
(`VerdictReason`, `PipelineStageName`, `LogFormatterId`).

C'est le critère le plus important du document pour l'objectif « penser long
terme ». S'il échoue, le contrat de §26 est à revoir, et il vaut mieux le
savoir en phase 9 qu'en phase 15.

### 41.4 Critères de non-régression

| # | Critère |
|---|---|
| **AC-R1** | Toutes les suites existantes restent vertes |
| **AC-R2** | L'extraction NAT ne change aucun comportement |
| **AC-R3** | Les topologies existantes se chargent |
| **AC-R4** | Aucune dégradation du canevas |

---

## 42. Risques et arbitrages

### 42.1 Registre des risques

| # | Risque | Probabilité | Impact | Mitigation |
|---|---|---|---|---|
| **R1** | Le socle se révèle trop rigide au 3ᵉ ou 4ᵉ vendeur | Moyenne | Élevé | Phase 9 conçue comme test du contrat ; trois issues de §26.3 |
| **R2** | Le socle se révèle trop abstrait, aucun vendeur ne s'y reconnaît | Faible | Élevé | Chaque concept est présent chez ≥ 3 vendeurs (§11.2) |
| **R3** | Le modèle candidat rétrofitté coûte cher | **Élevée** | Élevé | Couche de mutation unique dès la phase 1 (FR-MGT-11) |
| **R4** | Explosion du volume d'événements sur le bus | Moyenne | Moyen | Liste blanche stricte (FR-UI-11), leçon de l'élément #52 |
| ~~**R5**~~ | ~~`Firewall extends Router` traîne une dette inerte~~ | — | — | **Éliminé** par l'option B : il n'y a plus d'héritage, donc plus de dette à neutraliser (§7.3.1) |
| **R5b** | Les cinq services L3 divergent un jour de ceux de `Router` | Moyenne | Moyen | Interfaces explicites ; règle de sens de convergence posée (§36.3.1) |
| **R6** | L'extraction NAT régresse | Moyenne | Élevé | Phase isolée, suite verte avant/après |
| **R7** | Le mode transparent bute sur l'absence de base L3/L2 commune | Moyenne | Moyen | Phase 10, après stabilisation ; précédent du NAT sur SVI Huawei |
| **R8** | La virtualisation devient une étiquette (défaut PDB) | Moyenne | **Élevé** | Isolation réelle ou refus (§22.2) |
| **R9** | Les références de mise en forme sont fausses | **Élevée** | Faible | Captures uniquement, jamais de documentation HTML |
| **R10** | Les profils de sécurité deviennent une mise en scène | Moyenne | Élevé | Trois profils réels, EICAR pour l'antivirus, cadre déclaré |
| **R11** | Le document reste théorique | Moyenne | Élevé | Phase 1 livrable et observable |
| **R12** | La CLI FortiOS est sous-estimée | Moyenne | Moyen | Schéma déclaratif plutôt que handlers |
| **R13** | Les délais par défaut du §31.4 sont faux | **Élevée** | Faible | Déjà signalé comme à vérifier |

### 42.2 Les arbitrages tranchés

| # | Question | Décision | § |
|---|---|---|---|
| **A1** | `Firewall extends` quoi ? | **`Equipment`** ; les capacités L3 sont des collaborateurs injectés | 7.3.1 |
| **A2** | NAT : réutiliser, étendre ou nouveau ? | Nouveau + primitives extraites | 12.5 |
| **A3** | Une ou deux tables d'état ? | Deux, justifiées | 10.9 |
| **A4** | Expiration : minuteur ou balayage ? | Balayage | 10.6.1 |
| **A5** | Antivirus : cadre ou détection ? | Cadre + EICAR | 17.4 |
| **A6** | Virtualisation : étiquette ou isolation ? | Isolation ou refus | 22.2 |
| **A7** | Candidat : socle ou vendeur ? | Socle, déclaré par profil | 24.2 |
| **A8** | UI : lecture seule ou édition ? | Lecture seule | 34.2 |
| **A9** | Junos : nécessaire ? | Oui, valide le contrat | 30.6 |
| **A10** | Catalogue prédéfini : socle ou vendeur ? | Vendeur, remplaçant le socle | 8.4.3 |

### 42.3 Les arbitrages laissés ouverts

Trois questions sont volontairement non tranchées, faute de mesure
suffisante à ce stade. Les laisser ouvertes est préférable à trancher à
l'aveugle.

| # | Question ouverte | À trancher en |
|---|---|---|
| ~~**O1**~~ | ~~`IPv4Packet` porte-t-il les options IP ?~~ | **Tranchée** — mesurée, aucun champ d'options ; les deux contrôles concernés sont refusés (§18.4) |
| **O2** | Les délais par défaut du §31.4 sont-ils exacts ? | À chaque phase de déclinaison |
| **O3** | La consolidation des helpers NAT de `EndHost` avec ceux de `NATEngine` doit-elle être faite ici ou séparément ? | Phase 2, après mesure de l'ampleur |

O1 est fermée par une lecture de trois minutes, et c'est l'illustration du
principe qui gouverne tout ce document : une question qui se mesure ne se
suppose pas. Les deux restantes exigent des sources externes (O2) ou une
mesure d'ampleur sur du code existant (O3), et restent donc ouvertes.

---

## 43. Hors périmètre

### 43.1 Explicitement exclu

| # | Élément | Raison |
|---|---|---|
| **HP1** | Détection réelle de maliciel | Aucun contenu réel ne circule (N1) |
| **HP2** | Signatures IPS réelles | Idem |
| **HP3** | Déchiffrement TLS avec ré-signature | PEM = JSON armuré ; chantier autonome |
| **HP4** | Sandboxing | Aucun fichier à détoner |
| **HP5** | Interface graphique constructeur | N4 |
| **HP6** | Panorama / FortiManager / CSM | Gestion centralisée, produit à part |
| **HP7** | Parité CLI exhaustive | N3 |
| **HP8** | Clustering > 2 nœuds | N6 |
| **HP9** | Accélération matérielle (NP/ASIC/SP3) | Sans objet |
| **HP10** | Licences et abonnements | Sans valeur pédagogique ici |
| **HP11** | SD-WAN | Module distinct |
| **HP12** | ZTNA / SASE | Module distinct |
| **HP13** | EIGRP sur pare-feu | §19.3 |
| **HP14** | ALG SIP / H.323 / RTSP / SQLNet | Aucun trafic de ces protocoles (§15.4) |
| **HP15** | Pré-recherche de route de l'ASA avant ACL | Nuance non modélisée (§13.4) |
| **HP16** | Actif/actif en phase initiale | P4 |

### 43.2 Reporté mais envisagé

| # | Élément | Condition de réouverture |
|---|---|---|
| **RP1** | Déchiffrement TLS | Un format PEM/DER réel |
| **RP2** | ALG SIP | Un moteur SIP dans le dépôt |
| **RP3** | pfSense / OPNsense | Convergence avec netfilter (§10.9) |
| **RP4** | Huawei USG | Après les quatre déclinaisons |
| **RP5** | IPv6 complet sur pare-feu | Après stabilisation IPv4 |
| **RP6** | Pare-feu applicatif web | Après les profils |

### 43.3 Ce que ce document ne garantit pas

Trois réserves d'honnêteté :

1. **Les valeurs numériques citées** (délais par défaut, seuils, limites)
   sont des bases de travail issues de recherche documentaire, à vérifier
   contre des sources réelles au moment de l'implémentation. Elles sont
   signalées comme telles en §31.4 et O2.
2. **Les estimations de taille** des artefacts vendeur (§26.1) sont des
   ordres de grandeur, non des engagements.
3. **La faisabilité de certaines fonctions** dépend de vérifications non
   encore faites, listées en §42.3.

---

## 44. Annexes

### 44.1 Glossaire des sigles

| Sigle | Développement |
|---|---|
| **ALG** | Application Layer Gateway |
| **App-ID** | Application Identification (PAN-OS) |
| **ASA** | Adaptive Security Appliance (Cisco) |
| **BVI** | Bridge Virtual Interface |
| **DNAT** | Destination NAT |
| **FGCP** | FortiGate Clustering Protocol |
| **FGSP** | FortiGate Session Life Support Protocol |
| **FIB** | Forwarding Information Base |
| **FTD** | Firepower Threat Defense (Cisco) |
| **HA** | High Availability |
| **IPS** | Intrusion Prevention System |
| **MPF** | Modular Policy Framework (ASA) |
| **NGFW** | Next-Generation Firewall |
| **PAT** | Port Address Translation |
| **RPF** | Reverse Path Forwarding |
| **SNAT** | Source NAT |
| **SNI** | Server Name Indication |
| **UTM** | Unified Threat Management |
| **VDOM** | Virtual Domain (FortiOS) |
| **VIP** | Virtual IP (FortiOS) |
| **vsys** | Virtual System (PAN-OS) |

### 44.2 Correspondance rapide des commandes

#### Configurer une zone

| Vendeur | Commande |
|---|---|
| ASA | `interface Gi0/0` / `nameif inside` / `security-level 100` |
| FortiOS | `config system zone` / `edit "trust"` / `set interface "port1"` |
| PAN-OS | `set zone trust network layer3 ethernet1/1` |
| Junos | `set security zones security-zone trust interfaces ge-0/0/0.0` |

#### Créer un objet adresse

| Vendeur | Commande |
|---|---|
| ASA | `object network SRV` / `host 192.168.1.10` |
| FortiOS | `config firewall address` / `edit "SRV"` / `set subnet 192.168.1.10 255.255.255.255` |
| PAN-OS | `set address SRV ip-netmask 192.168.1.10/32` |
| Junos | `set security address-book global address SRV 192.168.1.10/32` |

#### Autoriser un flux

| Vendeur | Commande |
|---|---|
| ASA | `access-list IN extended permit tcp any object SRV eq 443` + `access-group IN in interface outside` |
| FortiOS | `config firewall policy` / `edit 1` / `set srcintf "port1"` / … / `set action accept` |
| PAN-OS | `set rulebase security rules R1 from trust to untrust … action allow` |
| Junos | `set security policies from-zone trust to-zone untrust policy R1 then permit` |

#### PAT sortant

| Vendeur | Commande |
|---|---|
| ASA | `nat (inside,outside) source dynamic any interface` |
| FortiOS | `set nat enable` dans la politique |
| PAN-OS | `set rulebase nat rules S1 source-translation dynamic-ip-and-port interface-address interface ethernet1/2` |
| Junos | `set security nat source rule-set RS rule R1 then source-nat interface` |

#### Publier un serveur

| Vendeur | Commande |
|---|---|
| ASA | `object network SRV` / `nat (dmz,outside) static 203.0.113.10` |
| FortiOS | `config firewall vip` / `edit "VIP"` / `set extip 203.0.113.10` / `set mappedip 192.168.50.10` |
| PAN-OS | `set rulebase nat rules D1 destination-translation translated-address 192.168.50.10` |
| Junos | `set security nat destination rule-set RS rule R1 then destination-nat pool P1` |

#### Voir les sessions

| Vendeur | Commande |
|---|---|
| ASA | `show conn` |
| FortiOS | `get system session list` |
| PAN-OS | `show session all` |
| Junos | `show security flow session` |

#### Simuler un paquet

| Vendeur | Commande |
|---|---|
| ASA | `packet-tracer input inside tcp 192.168.1.10 12345 203.0.113.5 80` |
| FortiOS | `diagnose debug flow filter addr 192.168.1.10` + `diagnose debug flow trace start 10` |
| PAN-OS | `test security-policy-match from trust to untrust source … protocol 6 destination-port 80` |
| Junos | `show security match-policies from-zone trust to-zone untrust source-ip … protocol tcp destination-port 80` |

### 44.3 Formats de journal — gabarits de référence

#### ASA

| Message | Sens |
|---|---|
| `%ASA-6-302013` | Connexion TCP établie |
| `%ASA-6-302014` | Connexion TCP fermée |
| `%ASA-6-302015` | Connexion UDP établie |
| `%ASA-6-302016` | Connexion UDP fermée |
| `%ASA-6-302020` | Connexion ICMP établie |
| `%ASA-6-302021` | Connexion ICMP fermée |
| `%ASA-4-106023` | Paquet refusé par une ACL |
| `%ASA-6-106100` | Correspondance d'ACL avec compteur |
| `%ASA-6-305011` | Traduction dynamique créée |
| `%ASA-6-305012` | Traduction supprimée |
| `%ASA-5-111008` | Commande exécutée par un administrateur |
| `%ASA-1-105005` | Perte de communication de basculement |

Gabarit de `302013` :
```
%ASA-6-302013: Built {inbound|outbound} TCP connection <id> for
 <interface>:<real-addr>/<real-port> (<mapped-addr>/<mapped-port>) to
 <interface>:<real-addr>/<real-port> (<mapped-addr>/<mapped-port>)
```

Gabarit de `302014` :
```
%ASA-6-302014: Teardown TCP connection <id> for <interface>:<addr>/<port>
 to <interface>:<addr>/<port> duration <hh:mm:ss> bytes <n> <reason>
```

Gabarit de `106023` :
```
%ASA-4-106023: Deny <proto> src <interface>:<addr>/<port>
 dst <interface>:<addr>/<port> by access-group "<name>"
```

#### FortiOS — champs du journal de trafic

| Champ | Sens |
|---|---|
| `date`, `time` | Horodatage |
| `devname`, `devid` | Identité de l'appareil |
| `logid` | Identifiant de type de message |
| `type`, `subtype`, `level` | Classification |
| `vd` | VDOM |
| `srcip`, `srcport`, `srcintf` | Source |
| `dstip`, `dstport`, `dstintf` | Destination |
| `sessionid` | Session |
| `proto` | Protocole IP |
| `action` | Verdict |
| `policyid`, `policyname` | Règle |
| `service` | Service |
| `trandisp`, `transip`, `transport` | Traduction |
| `duration` | Durée |
| `sentbyte`, `rcvdbyte` | Octets |
| `sentpkt`, `rcvdpkt` | Paquets |
| `app`, `appcat` | Application |
| `srccountry`, `dstcountry` | Géographie |

#### PAN-OS — ordre des champs du journal de trafic (CSV)

```
FUTURE_USE, Receive Time, Serial Number, Type, Threat/Content Type,
FUTURE_USE, Generated Time, Source Address, Destination Address,
NAT Source IP, NAT Destination IP, Rule Name, Source User, Destination User,
Application, Virtual System, Source Zone, Destination Zone,
Inbound Interface, Outbound Interface, Log Action, FUTURE_USE,
Session ID, Repeat Count, Source Port, Destination Port,
NAT Source Port, NAT Destination Port, Flags, Protocol, Action,
Bytes, Bytes Sent, Bytes Received, Packets, Start Time, Elapsed Time,
Category, …
```

#### Junos

```
RT_FLOW_SESSION_CREATE: session created <src>/<sport>-><dst>/<dport>
 <service> <nat-src>/<nat-sport>-><nat-dst>/<nat-dport>
 <src-nat-rule> <dst-nat-rule> <proto> <policy> <from-zone> <to-zone>
 <session-id> <username> <roles> <packet-incoming-interface>

RT_FLOW_SESSION_CLOSE: session closed <reason>: <src>/<sport>-><dst>/<dport>
 … <packets-from-client> <bytes-from-client>
 <packets-from-server> <bytes-from-server> <elapsed-time>

RT_FLOW_SESSION_DENY: session denied <src>/<sport>-><dst>/<dport>
 <service> <proto> <policy> <from-zone> <to-zone>
```

### 44.4 Catalogue des étapes de pipeline

| Nom | Position typique | Peut rejeter | Peut transformer |
|---|---|---|---|
| `ingress-sanity` | 1 | oui | non |
| `ingress-zone` | 2 | oui | non |
| `screen-ingress` | 3 | oui | non |
| `defrag` | 4 | oui | oui |
| `session-lookup` | 5 | non | non |
| `tcp-state-check` | 6 | oui | non |
| `nat-destination` | variable | non | oui |
| `route-lookup` | variable | oui | non |
| `egress-zone` | après routage | non | non |
| `self-traffic` | variable | oui | non |
| `policy-lookup` | variable | oui | non |
| `nat-source` | variable | non | oui |
| `session-install` | après politique | non | non |
| `alg-inspect` | après session | oui | oui |
| `app-id` | après session | non | non |
| `content-inspect` | après app-id | oui | non |
| `shaping` | avant sortie | oui | non |
| `ttl-decrement` | avant sortie | oui | oui |
| `fragment` | avant sortie | oui | oui |
| `egress` | dernière | non | non |

### 44.5 Sources de la recherche vendeur

| Sujet | Source |
|---|---|
| ASA — niveaux de sécurité et zones | Documentation Cisco Secure Firewall ASA Series General Operations CLI Configuration Guide 9.19-9.23, chapitre Traffic Zones |
| ASA — ordre d'opérations | Cisco, « Packet Flow through an ASA Firewall » ; TunnelsUp, « Cisco ASA Order of Operation » |
| ASA — ACL | Cisco, « Configure ASA Access Control List for Various Scenarios » |
| ASA — messages syslog | Cisco Secure Firewall ASA Series Syslog Messages, 302003 à 342008 ; Cisco, « ASA FAQ: How do you interpret the syslogs generated by the ASA when it builds or tears down connections? » |
| ASA — mode transparent | Cisco, Transparent or Routed Firewall Mode, guides 9.16 à 9.20 |
| ASA — basculement | Cisco, Failover for High Availability, guides 9.19-9.22 ; NetworkLessons, « Cisco ASA Firewall Active/Standby Failover » |
| FortiOS — politique | Fortinet Document Library, `config firewall policy`, CLI Reference 6.4.5 et 7.2.3 |
| FortiOS — VDOM | Fortinet Document Library, VDOM overview, FortiOS 7.4.3 ; Inter-VDOM routing 6.2.0 |
| FortiOS — flux de paquets | Fortinet, Parallel Path Processing (Life of a Packet), 6.0 / 6.2 / 6.4 |
| FortiOS — profils | Fortinet, « Profile-based NGFW vs policy-based NGFW », 6.2.0 |
| FortiOS — journaux | Fortinet, FortiOS Log Message Reference, Log message fields 7.4.3 et 8.0.0 ; Sample logs by log type 6.2.0 |
| FortiOS — HA | Fortinet, HA documentation ; NetworkInterview, « FortiGate HA » |
| PAN-OS — flux de paquets | Palo Alto Networks Knowledge Base, « Packet Flow Sequence in PAN-OS » |
| PAN-OS — politique | Palo Alto Networks, Security Policy Rules ; KB « Security policy fundamentals » |
| PAN-OS — zones | Palo Alto Networks KB, « Zone Protection Recommendations » |
| PAN-OS — journaux | Palo Alto Networks, Syslog Field Descriptions, Traffic Log Fields, PAN-OS 8.1 / 10.2 / 11.1 |
| PAN-OS — HA | Palo Alto Networks, HA Modes ; HA Links and Backup Links ; Reference: HA Synchronization ; « Information Synchronized in an Active-Passive HA Pair » |
| Junos — politiques | Juniper Networks, « Understanding a Security Flow Policy on a Device Running Junos OS » |
| Junos — traitement de flux | Juniper Networks, « Traffic Processing on SRX Series Firewalls Overview » ; « Junos OS Flow-Based and Packet-Based Processing » |
| Junos — mode paquet | Juniper Networks, « Packet-Based Forwarding » |
| Transparent / vwire | Fortinet Cyberglossary, « What Is a Transparent Firewall? » ; documentation ASA transparent |

### 44.6 Historique du document

| Version | Date | Contenu |
|---|---|---|
| 1.0 | 2026-08-14 | Version initiale — socle générique et contrat de déclinaison pour quatre constructeurs |

### 44.7 Prochaines étapes

1. Revue de ce BRD.
2. Arbitrage des deux questions ouvertes restantes (§42.3). O1 est déjà
   fermée par la mesure (§18.4).
3. Rédaction du **PRD de la phase 1**, avec le détail d'implémentation, les
   signatures exactes et la sonde discriminée.
4. Implémentation de la phase 1.

### 44.8 Ce qu'il faut retenir en une page

Si le lecteur ne devait garder que six affirmations de ce document :

1. **Un pare-feu suit un flux, un routeur suit un paquet.** Tout le reste en
   découle : la session est le concept central, et elle n'existe nulle part
   dans le dépôt aujourd'hui.
2. **L'ordre d'opérations est une donnée, pas du code.** Quatre
   constructeurs, quatre ordres, un moteur — c'est le pari de
   l'architecture, et §12.4 montre que la divergence la plus profonde du
   domaine tient en cinq booléens.
3. **La couche vendeur ne contient aucun moteur.** Cinq artefacts,
   vérifiables mécaniquement (G1, G2). C'est ce qui rend la 4ᵉ déclinaison
   moins chère que la 1ʳᵉ.
4. **Ce qui n'est pas simulé est refusé, et le refus nomme le manque.**
   Jamais accepté-et-inerte, qui est le défaut que ce dépôt passe son temps
   à refermer ailleurs.
5. **Rien ne contourne le fil.** La synchronisation HA, les journaux,
   l'authentification traversent de vraies trames, mesurées en différence.
6. **La quatrième déclinaison est le test du contrat, pas un bonus.** Si
   ajouter Junos oblige à modifier le socle, le socle est faux — et il vaut
   mieux le découvrir en phase 9 qu'en phase 15.

---

*Fin du document.*


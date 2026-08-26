# BRD — Le modèle TCP/IP dans le simulateur

**Version** : 1.0
**Date** : 2026-08-25
**Agent** : `mandeng`
**Périmètre réservé** : `docs/JOURNAL-AGENTS-mandeng.md`, section « Réservation — le modèle TCP/IP »

**Références normatives** (vérifiées, citées, non écrites de mémoire) :

- **RFC 1122** — *Requirements for Internet Hosts — Communication Layers*
  (Internet Standard 3). Définit les quatre couches et, en §3.4,
  l'interface de service entre elles.
- **RFC 1812** — *Requirements for IP Version 4 Routers*. Définit ce
  qu'un routeur implémente et ce qu'il n'implémente pas.
- RFC 791 / RFC 8200 (IP), RFC 792 / RFC 4443 (ICMP), RFC 768 (UDP),
  RFC 9293 (TCP), RFC 826 (ARP), RFC 6335 (registre des ports).

---

## 0. Pourquoi ce document

Le simulateur implémente aujourd'hui **59 répertoires de protocoles** et
quatre familles d'équipements, et il n'y a **aucune notion de couche
nulle part** — vérifié plutôt qu'affirmé : une recherche du mot `layer`
dans `src/network/core/` et `src/network/equipment/` ne trouve que
`NDPOptionLinkLayerAddress`, c'est-à-dire un champ d'option NDP. Il
n'existe ni type, ni interface, ni constante décrivant une couche.

La conséquence n'est pas théorique et ce document ne la déduit pas : il
la **mesure**, chiffre en main, en §2. Elle tient en une phrase — *chaque
protocole réimplémente sa propre descente depuis sa couche jusqu'au
câble* — et elle produit exactement la famille de défauts que ce dépôt
passe son temps à refermer ailleurs : **deux implémentations d'une même
question finissent par donner deux réponses différentes**.

Ce document est un **BRD** : il établit l'état des lieux et le périmètre
de migration. Il ne contient aucune ligne de code de production. Le
découpage en phases livrables est en §6, et chaque phase aura son PRD.

### 0.1 Ce que ce document ne rouvre pas

Trois chantiers voisins existent, sont cités comme dépendances, et ne
sont **pas** repris ici :

| Document | Ce qu'il traite | Rapport avec ce BRD |
|---|---|---|
| `docs/PRD-Frame-Only-Refactor.md` | Un équipement ne peut rien savoir d'un autre autrement que par une trame ; interdiction structurelle d'`EquipmentRegistry` | **Complémentaire.** Lui traite l'isolation *horizontale* (entre machines), ce BRD l'isolation *verticale* (entre couches d'une même machine). Les deux se renforcent : une interface de service propre supprime des motifs de lire le pair. |
| `docs/PRD-Sockets-Une-Seule-Verite.md` | Deux tables de ports (`SocketTable` et `TcpStack.listeners`) que rien n'oblige à s'accorder | **Prérequis partiel** de la phase transport (§6.3). Ce BRD n'en refait pas l'analyse et suppose sa règle acquise : une seule table fait foi. |
| `docs/PRD-TCP.md` | Les limites mesurées de `TcpStack` (congestion, PMTUD, SACK…) | **Orthogonal.** Ce BRD ne change pas ce que TCP *fait*, seulement par où il descend et remonte. |

Et une décision d'architecture existante qui **n'est pas remise en
cause** — c'est un invariant du projet, écrit dans `CLAUDE.md` :
l'architecture est *equipment-driven*, sans médiateur central ; les
équipements traitent et acheminent les trames eux-mêmes, de pair à pair
sur des câbles. **Ce BRD ne propose pas un simulateur central.** Il
propose que, *à l'intérieur* d'un équipement, la descente et la remontée
de pile passent par des interfaces de service nommées au lieu d'être
recopiées dans chaque moteur.

---

## 1. Le modèle cible et ses sources

### 1.1 Les quatre couches

RFC 1122 §1.1.3 nomme quatre couches, et c'est le vocabulaire que ce
document emploie — pas les sept de l'OSI, que le simulateur n'implémente
pas et qui ne décrivent pas la pile qu'il simule :

| # | Nom (RFC 1122) | Ce que la RFC y range |
|---|---|---|
| 4 | **Application Layer** | « user protocols (Telnet, FTP, SMTP) and support protocols (SNMP, BOOTP, RARP, DNS) » |
| 3 | **Transport Layer** | « Transmission Control Protocol (TCP) » et « User Datagram Protocol (UDP) » |
| 2 | **Internet Layer** | « Internet Protocol (IP) » avec « ICMP » et « IGMP » |
| 1 | **Link Layer** | « the communication protocol used to interface to that network » |

Deux précisions de la RFC elle-même, qui **cadrent l'ambition de ce
document** et lui interdisent le dogmatisme :

> « strict layering is an imperfect model »

et elle reconnaît explicitement le « creative "breaking" of strict
layering » par structures de données partagées. **Ce BRD ne vise donc pas
une pureté en couches.** Il vise qu'une descente de pile ait *un seul*
lieu, et que les entorses soient **nommées et justifiées** plutôt que
subies parce que personne n'a jamais écrit l'interface.

### 1.2 L'interface de service, qui est le cœur du sujet

RFC 1122 §1.3.1 :

> « This document describes the conceptual service interface between
> layers using a functional ("procedure call") notation »

et §3.4 donne les deux primitives, verbatim :

```
SEND(src, dst, prot, TOS, TTL, BufPTR, len, Id, DF, opt => result)
RECV(BufPTR, prot => result, src, dst, SpecDest, TOS, len, opt)
```

avec l'exigence, qui est **la phrase la plus importante de ce BRD** :

> « The interface between the IP layer and the transport layer MUST
> provide full access to all the mechanisms of the IP layer, including
> options, Type-of-Service, and Time-to-Live. »

Autrement dit : ce n'est pas seulement qu'une interface doit exister,
c'est qu'elle doit **exposer les leviers d'IP** — sans quoi la couche du
dessus va contourner l'interface pour les atteindre, ce qui est
exactement ce que fait le dépôt aujourd'hui.

Deux autres exigences retenues comme critères de conformité :

- §2.4 (interface lien/internet) : « The packet receive interface between
  the IP layer and the link layer MUST include a flag to indicate whether
  the incoming packet was addressed to a link-layer broadcast address. »
- §3.4 (remontée d'ICMP) : « The IP layer MUST pass certain ICMP messages
  up to the appropriate transport-layer routine », dont Destination
  Unreachable et Time Exceeded.

### 1.3 Ce qu'un routeur implémente

RFC 1812 :

> « An IP router can be distinguished from other sorts of packet
> switching devices in that a router examines the IP protocol header as
> part of the switching process. »

> « Routers have essentially the same Link Layer protocol requirements as
> other sorts of Internet systems »

et les couches transport/application ne lui sont nécessaires que « when
necessary » pour son propre trafic — protocoles de routage et
administration. **Conséquence de conception** : couches 1 et 2
obligatoires pour tout équipement qui achemine ; couches 3 et 4
optionnelles et **strictement pour le trafic dont la machine est
l'extrémité**. C'est ce qui justifie que `Router` ait une pile TCP (pour
BGP, SSH, HTTP d'administration) sans que cela fasse de lui un hôte.

Noté au passage, parce que ce dépôt sépare les deux et que la RFC ne le
fait pas : RFC 1812 emploie « routing table » et « forwarding table »
comme **synonymes** (« The route database is also called a routing table
or forwarding table »). La séparation RIB/FIB, réclamée par
`docs/audit/02` et redite en §3.4 ci-dessous, est donc une exigence
d'**architecture interne**, pas une exigence de la RFC — et ce BRD le dit
plutôt que de l'habiller d'une normativité qu'elle n'a pas.

---

## 2. L'état mesuré

Tous les chiffres de cette section ont été obtenus par recherche sur
l'arbre courant (`faf7940a`), hors `src/__tests__`.

### 2.1 Il n'existe aucune notion de couche

Recherche de `layer`/`Layer` comme type, interface, classe, énumération
ou constante dans `src/network/core/` et `src/network/equipment/` :
**2 occurrences**, toutes deux `NDPOptionLinkLayerAddress` — un champ
d'option NDP, sans rapport.

La seule abstraction transversale existante est `core/NetworkPdu.ts`, et
elle fait **17 lignes** :

```ts
export interface NetworkPdu {
  type: string;
}
```

Son en-tête annonce « the single central contract every protocol data
unit in the simulator implements ». Le contrat est un discriminant de
chaîne. Il ne dit **ni la couche, ni l'encapsulé, ni l'encapsulant** —
donc il ne permet aucun traitement générique de pile, seulement un
`switch`.

### 2.2 Cinq acheminements IPv4 indépendants

Recherche des sites qui décrémentent un TTL — la signature d'un
acheminement IP :

| Site | Fonction | Famille |
|---|---|---|
| `devices/Router.ts:2776` | `forwardPacket` | routeur, unicast |
| `devices/Router.ts:2970` | `forwardMulticast` | routeur, multicast |
| `devices/EndHost.ts:2124` | `forwardIPv4` | hôte faisant suivre |
| `devices/SwitchSvi.ts:491` | `forwardIpPacket` | commutateur L3 |
| `devices/firewall/pipeline/stages/coreStages.ts:726` | étape du pipeline | pare-feu |

**Quatre familles d'équipements, cinq corps.** Chacun refait la même
séquence — décrémenter, recalculer la somme de contrôle d'en-tête,
choisir la sortie, résoudre le saut suivant — et chacun peut diverger.
Ce n'est pas une hypothèse : `CLAUDE.md` documente déjà **trois**
divergences déjà payées sur exactement ces chemins (le NAT du
commutateur L3 non câblé au plan de données, la moitié NAT de `EndHost`
portant les deux mêmes défauts que celle du routeur *découverts
séparément*, et l'ordre NAT/ACL inversé sur les deux jambes du routeur).

### 2.3 Soixante-cinq fichiers écrivent directement sur le fil

`sendFrame(` est appelé depuis **65 fichiers**. En excluant `hardware/`
et `devices/` — où c'est légitime — il reste **une trentaine de moteurs
de protocole qui fabriquent eux-mêmes une trame Ethernet complète, MAC
de destination comprise**, quelle que soit leur couche.

Le décompte par répertoire est en §5. Le point saillant : parmi ces
moteurs figurent **NTP (UDP/123), SNMP (UDP/161), syslog (UDP/514),
RADIUS (UDP/1812, cinq fichiers), NetFlow (UDP/2055), DHCP (UDP/67),
BFD (UDP/3784) et RIP (UDP/520)** — huit protocoles d'**application** au
sens de RFC 1122, qui n'ont aucune raison de connaître une adresse MAC.

Chiffres bruts : **31 constructions littérales de trame Ethernet** dans
**25 fichiers**, et **40 constructions littérales de paquet IPv4** dans
**30 fichiers**.

### 2.4 Le module qui devait dédupliquer n'a aucun appelant

`core/packetBuilders.ts` existe. Son en-tête décrit précisément le
problème de §2.3 :

> « Every control-plane agent (HSRP, VRRP, GLBP, syslog, NTP, BFD, …)
> needs the same three steps to put a payload on the wire […] Before this
> module each agent re-implemented the block inline (~25 duplicated lines
> per agent); fixes to one copy never reached the others. »

Il exporte `buildIpv4Frame`, `buildUdpIpv4Frame`, `wrapIpv4InEthernet`.
**Mesure** : ces trois fonctions ont **zéro appelant de production**. Les
onze références trouvées dans tout `src/` sont **toutes** dans
`src/__tests__/unit/network-v2/packet-builders.test.ts`.

C'est le défaut le plus instructif de tout cet état des lieux, et il vaut
d'être nommé pour lui-même : **un module de déduplication écrit,
correct, testé, et jamais branché**. Le test le fait paraître vivant. Le
diagnostic qu'il porte dans son propre en-tête est resté juste pendant
tout ce temps. C'est exactement la forme « un moteur sans porte » que ce
dépôt referme régulièrement — sauf qu'ici la porte existe et que
personne n'est passé par elle.

**Ce BRD ne propose pas de généraliser ce module tel quel** : sa
signature descend d'un coup de la charge utile à la trame, MAC comprise,
donc elle n'est pas une interface *de couche* mais un raccourci de
construction. Elle sera la brique interne de la couche internet (§3.3),
pas l'interface offerte au-dessus.

### 2.5 Les classes-dieu

| Fichier | Lignes | Couches qu'il porte |
|---|---|---|
| `devices/Router.ts` | 5 809 | 1, 2, 3, 4 (+ CLI, + plan de contrôle) |
| `devices/EndHost.ts` | 4 824 | 1, 2, 3, 4 |
| `devices/Switch.ts` | 3 808 | 1, 2 (via SVI), 4 |
| `hardware/Port.ts` | 1 128 | 1 |
| `core/types.ts` | 1 568 | toutes (les PDU de toutes les couches) |

`EndHost` porte, dans un seul fichier : la table ARP et son
vieillissement (couche 1), la table de routage, la livraison et le
transit IPv4/IPv6, la fragmentation, les groupes multicast (couche 2), le
démultiplexage UDP (couche 3), et les clients DHCP et DNS (couche 4).

### 2.6 Le contre-exemple qui montre la cible

Deux protocoles de routage, même dépôt, deux profondeurs de couplage —
et c'est la comparaison la plus utile de ce document, parce que la
solution est **déjà écrite** dans l'un des deux.

**OSPF** (`ospf/OSPFEngine.ts:499`, branché par
`devices/router/RouterOSPFIntegration.ts:189`) :

```ts
this.ospfEngine.setSendCallback((iface, packet, destIP) => { … });
```

Le moteur rend **un paquet OSPF et une adresse IP de destination**. Il ne
sait rien des MAC, ni de l'ARP, ni de l'Ethernet. C'est, à la lettre, le
`SEND(src, dst, prot, …)` de RFC 1122 §3.4. **OSPF est déjà conforme.**

**RIP** (`rip/RIPEngine.ts:853`) :

```ts
this.callbacks.sendFrame(outIface, { /* trame Ethernet complète */ });
```

Le moteur RIP — une application sur UDP/520 — fabrique la trame
Ethernet. Il traverse trois couches d'un coup.

La cible de ce BRD est de **généraliser la forme OSPF**, qui existe,
fonctionne et est éprouvée, à tout ce qui a la forme RIP.

### 2.7 Duplications déjà connues, relues à la lumière du modèle

`CLAUDE.md` documente plusieurs défauts qui, isolément, ont été traités
comme des bogues. Vus depuis le modèle en couches, ce sont **les
symptômes d'une même cause structurelle** :

| Symptôme déjà documenté | Lecture en couches |
|---|---|
| La somme de contrôle UDP vit dans `tcp/types.ts` | La couche transport n'a pas de lieu propre ; un module TCP héberge UDP |
| `EndHost` a sa propre réécriture NAT, séparée de `router/NATEngine.ts`, avec les **deux mêmes défauts découverts séparément** | Le NAT est une fonction de la couche internet, écrite deux fois parce qu'il n'y a pas de couche internet |
| `IPSecEngine` porte son propre `fragmentIPv4Packet` alors que `core/Ipv4Fragmentation.ts` exporte `fragmentIPv4` | Idem : la fragmentation est une fonction d'IP, recopiée par un moteur qui n'a pas d'IP à qui la demander |
| Le NAT du commutateur L3 avait une CLI et **aucun câblage au plan de données** | `SwitchSvi` est une seconde couche internet, à qui il faut re-brancher une à une les fonctions de la première |
| `Router.lookupRoute()` appelle `dynamicRouting.refresh()` — le plan de contrôle recalculé par le plan de données | Pas de séparation RIB/FIB : la couche internet n'a pas de table à consulter, elle a un plan de contrôle à réveiller |
| Deux tables de ports (`PRD-Sockets-Une-Seule-Verite`) | Pas de couche transport propriétaire de ses ports |

---

## 3. L'architecture cible

### 3.1 Principe

Une **couche est un objet nommé, porté par la machine**, qui offre une
interface à la couche du dessus et consomme celle de la couche du
dessous. Un moteur de protocole ne connaît que l'interface de la couche
immédiatement inférieure.

L'architecture *equipment-driven* est conservée : ces objets vivent
**dans** l'équipement, pas dans un médiateur global. Un `Router` compose
un `LinkLayer` et un `InternetLayer` ; un `LinuxPC` compose en plus un
`TransportLayer`.

### 3.2 Couche 1 — Lien (`src/network/layers/link/`)

**Offre vers le haut** :

```
sendFrame(iface, dstMac, etherType, payload) -> boolean
```

et une remontée qui, conformément à RFC 1122 §2.4, **porte le drapeau de
diffusion** :

```
onFrameReceived({ iface, frame, wasLinkBroadcast, wasLinkMulticast })
```

**Ce qui y vit** : `Port`, `Cable`, `PortSecurity`, l'apprentissage MAC,
le marquage 802.1Q, ARP (RFC 1122 range ARP dans la couche lien), et les
protocoles de contrôle L2 qui écrivent légitimement des trames — STP,
CDP, LLDP, LACP, DTP, UDLD, VTP, 802.1X, IGMP snooping.

**Ce que ça ferme** : le drapeau de diffusion est aujourd'hui redécouvert
par chaque `handleFrame` en comparant la MAC de destination ; il y a
**10 implémentations de `handleFrame` sur des équipements** (`EndHost`,
`Router`, `CiscoRouter`, `HuaweiRouter`, `Switch`, `CiscoSwitch`,
`HuaweiSwitch`, `Hub`, `Firewall`, `LinuxMachine`), plus la déclaration
abstraite d'`Equipment`.

### 3.3 Couche 2 — Internet (`src/network/layers/internet/`)

**Offre vers le haut**, calquée sur RFC 1122 §3.4 et exposant les
leviers d'IP comme la RFC l'exige :

```
send({ src?, dst, protocol, ttl?, tos?, df?, options?, payload, payloadLength })
  -> SendResult
recv -> { src, dst, specDest, protocol, tos, options, payload }
```

**Ce qui y vit** : la RIB et la FIB séparées, la décision
livrer-ici / faire-suivre / jeter, le TTL, la somme de contrôle
d'en-tête, la fragmentation et le réassemblage, le NAT, les listes de
contrôle, la résolution du saut suivant (avec récursion, aujourd'hui
absente), ICMP, IGMP, et les protocoles qui roulent directement sur IP :
OSPF (89), EIGRP (88), GRE (47), ESP/AH (50/51), PIM (103), VRRP (112),
NHRP (54).

**Ce que ça ferme** : les cinq acheminements de §2.2 deviennent un.

### 3.4 RIB et FIB

Exigence d'architecture interne, pas de RFC (cf. §1.3). Aujourd'hui
`Router.routingTable` est un tableau que **toutes** les intégrations de
protocole mutent directement et que `lookupRoute()` lit à chaque paquet.
La cible : la RIB est écrite par le plan de contrôle, la FIB en est
**dérivée** et est la seule lue par le plan de données ; la récursion du
saut suivant est résolue à l'installation, une fois, et non à chaque
paquet.

### 3.5 Couche 3 — Transport (`src/network/layers/transport/`)

**Offre vers le haut** : les sockets. Une seule table de ports, celle de
`PRD-Sockets-Une-Seule-Verite`. `TcpStack` y déménage tel quel ; **UDP y
gagne un lieu propre**, qu'il n'a pas aujourd'hui (sa somme de contrôle
vit dans `tcp/types.ts`).

**Ce que ça ferme** : les huit protocoles d'application de §2.3 cessent
de fabriquer des trames et appellent `udp.sendTo(...)`.

### 3.6 Couche 4 — Application

Aucun déménagement de fichier. Le changement est que ces moteurs
n'atteignent plus `Port.sendFrame` : ils passent par la couche transport.
La plupart (DNS, HTTP, SMTP, FTP, TFTP, Kerberos, TLS, QUIC, TACACS+,
BGP) le font **déjà** — c'est la preuve que la cible est atteignable, pas
une théorie.

---

## 4. Ce que la migration ne doit pas casser

Chacun de ces points est un critère de sortie de **chaque** phase, pas
seulement de la dernière :

1. **Aucune sémantique protocolaire ne change.** Un moteur qui émettait
   un paquet correct émet le même paquet, octet pour octet là où les
   octets existent, champ pour champ ailleurs.
2. **L'architecture reste *equipment-driven*.** Pas de médiateur central.
3. **Les invariants de `PRD-Frame-Only-Refactor.md` sont préservés** :
   aucune nouvelle lecture d'un équipement par un autre.
4. **Le nombre d'erreurs de typecheck ne monte pas** (base : 229).
5. **La livraison des trames reste synchrone.** Plusieurs comportements
   documentés en dépendent (`TODO.md`, entrée `dhclient -t`).
6. **`Cable`, `Port` et l'identité de trame ne changent pas.**
   `CLAUDE.md` documente que la même trame traverse le câble par
   identité, et que c'est délibéré.

---

## 5. Inventaire complet de migration

Les 59 répertoires de `src/network/`, classés par couche RFC 1122, avec
leur **descente actuelle mesurée** et l'action requise.

Légende de la colonne « Descente » :
**`frame`** = le moteur fabrique lui-même une trame Ethernet ;
**`cb`** = le moteur rend une PDU à un rappel fourni par l'équipement ;
**`L4`** = le moteur passe par une socket ; **`—`** = pas d'émission.

### 5.1 Couche lien — conformes par nature

Ces moteurs écrivent des trames **parce que c'est leur couche**. Aucun
changement de descente ; ils deviennent les usagers de la couche lien.

| Répertoire | Fichiers | Descente | Action |
|---|---|---|---|
| `hardware` | 4 | `frame` | **Devient** la couche lien |
| `arp` | 7 | `frame` | Déménage dans la couche lien (RFC 1122 : ARP est L1) |
| `stp` | 5 | `frame` | Consomme l'interface lien |
| `cdp` | 3 | `frame` | idem |
| `lldp` | 3 | `frame` | idem |
| `lacp` | 3 | `frame` | idem |
| `dtp` | 3 | `frame` | idem |
| `udld` | 3 | `frame` | idem |
| `vtp` | 3 | `frame` | idem |
| `dot1x` | 3 | `frame` | idem |
| `igmp-snooping` | 3 | `frame` | idem |
| `pim-snooping` | 3 | — | idem |

### 5.2 Couche internet

| Répertoire | Fichiers | Descente | Action |
|---|---|---|---|
| `core` | 22 | `frame` | **Éclate** : PDU, IP, fragmentation → internet ; ports/sockets → transport |
| `icmp` | 1 | — | Rejoint la couche internet ; la remontée ICMP→transport de RFC 1122 §3.4 est à écrire |
| `igmp` | 5 | `frame` ×2 | Descente `frame` → `internet.send(proto 2)` |
| `ospf` | 18 | `cb` | **Modèle de référence** ; le rappel devient `internet.send(proto 89)` |
| `eigrp` | 4 | `cb` | idem, proto 88 |
| `gre` | 3 | `frame` | → `internet.send(proto 47)` |
| `ipsec` | 18 | — | → proto 50/51 ; **supprimer son `fragmentIPv4Packet` privé** |
| `pim` | 3 | `frame` | → `internet.send(proto 103)` |
| `nhrp` | 3 | `frame` | → `internet.send(proto 54)` |
| `nat` | 1 | — | Fonction de la couche internet |
| `routing` | 9 | — | RIB/FIB : **le lieu de la séparation §3.4** |
| `qos` | 1 | — | Politique de la couche internet |
| `fhrp` | 3 | `frame` ×2 | **À scinder** : VRRP est proto 112 (internet), HSRP UDP/1985 et GLBP UDP/3222 sont applicatifs |
| `vrrp` | 3 | — | via `fhrp` ; internet |

### 5.3 Couche transport

| Répertoire | Fichiers | Descente | Action |
|---|---|---|---|
| `tcp` | 8 | `frame` | Déménage ; **la somme de contrôle UDP en sort** vers un module UDP propre |
| `core/ports` | 3 | — | Rejoint la couche transport |
| `core/SocketTable` | 1 | — | idem ; unification par `PRD-Sockets-Une-Seule-Verite` |

### 5.4 Couche application — à migrer (descente `frame` aujourd'hui)

**C'est le cœur du chantier** : huit familles qui traversent trois
couches d'un coup.

| Répertoire | Fichiers | Transport réel | Action |
|---|---|---|---|
| `dhcp` | 12 | UDP/67-68 | `frame` → `udp.sendTo` ; garder la diffusion et le relais |
| `ntp` | 7 | UDP/123 | `frame` → `udp.sendTo` |
| `snmp` | 7 | UDP/161-162 | idem |
| `syslog` | 4 | UDP/514 (+TCP) | idem ; la moitié TCP passe déjà par une socket |
| `radius` | 25 | UDP/1812-1813 | idem — **5 fichiers concernés**, le plus gros lot |
| `netflow` | 3 | UDP/2055 | idem |
| `rip` | 5 | UDP/520 | idem — **le contre-exemple de §2.6** |
| `bfd` | 3 | UDP/3784 | idem |
| `vxlan` | 3 | UDP/4789 | idem |
| `ipsla` | 11 | ICMP/UDP/TCP | 2 fichiers ; le reste passe déjà par des sondes |
| `http` | 40 | TCP | 1 fichier (`websocket`) ; le reste est conforme |

### 5.5 Couche application — déjà conformes

Aucune action. Ils sont la **preuve que la cible est atteignable** dans
ce dépôt, et le gabarit à recopier.

`dns` (39), `protocols` (101, dont SSH), `smtp` (22), `tls` (16),
`quic` (13), `ftp` (10), `kerberos` (10), `pki` (9), `tftp` (6),
`bgp` (6), `tacacs` (5), `faults` (5), `crypto` (4), `dhcpv6` (3),
`llmnr` (3), `mdns` (3), `glbp` (3), `dnssd` (2), `nqa` (1).

### 5.6 Équipements

| Fichier | Lignes | Action |
|---|---|---|
| `devices/Router.ts` | 5 809 | Compose lien + internet (+ transport pour son propre trafic, RFC 1812) |
| `devices/EndHost.ts` | 4 824 | Compose les quatre couches ; **perd** ARP, routage, fragmentation, démux UDP |
| `devices/Switch.ts` + `SwitchSvi.ts` | 3 808 + n | La couche internet du SVI **devient celle du routeur** |
| `devices/firewall/` | — | Le pipeline devient un **crochet** de la couche internet, pas un cinquième acheminement |
| `equipment/Equipment.ts` | 318 | Porte la couche lien ; `handleFrame` devient sa remontée |

---

## 6. Découpage en phases

Chaque phase est livrable seule, verte seule, et poussée seule. Chacune
aura son PRD. **L'ordre est celui du risque croissant**, et il est
délibérément *ascendant* : on livre d'abord la couche dont personne ne
dépend encore.

### Phase 1 — La couche lien existe et porte le drapeau de diffusion
Créer `layers/link/`. `Equipment` l'expose. Les 12 moteurs L2 la
consomment. **Sortie** : `wasLinkBroadcast` est décidé en un seul lieu,
et les `handleFrame` ne le recalculent plus.

**Incrément 1 — LIVRÉ.** La règle (`classifyDestination`,
`isGroupAddress`) et la réception (`deliver`) vivent dans
`layers/link/LinkLayer.ts` ; `Equipment` l'expose ;
`EndHost`, `Router`, `CiscoRouter`, `HuaweiRouter` et `Switch` la
lisent. `ownsLocalUnicast` porte les adresses unicast supplémentaires
(MAC virtuelle FHRP). L'émission (`send`) a ses premiers consommateurs
de production — les deux ARP de l'hôte — et transmet **par**
`Equipment.sendFrame`, dont le contrôle d'alimentation ne doit pas être
court-circuité. Deux cas structurels parcourent
`src/network/devices/` et nomment tout fichier qui énumérerait encore un
préfixe multicast ou dériverait le bit I/G à la main.

**Incrément 2 — PREMIER LOT LIVRÉ.** STP, CDP et LLDP ne construisent
plus de trame : leur contrat d'hôte offre `sendOnLink(request)` et la
couche remplit l'adresse source. Deux cas structurels échouent en NOMMANT
tout répertoire déclaré migré qui appellerait encore `sendFrame` ou
poserait un `srcMAC:` à la main, et la liste déclarée grossit à chaque
lot. Trois cas de fil épinglent ce qui ne doit PAS changer — groupe de
destination, adresse source, ethertype.

Trouvé en migrant : `LinkSendRequest` a dû porter `dot1q`, parce que
PVST+ envoie sa BPDU **étiquetée 802.1Q** vers une adresse propriétaire,
et que `vlanId` n'est pas la même chose que l'étiquette — un cas
existant l'a attrapé. Et un commentaire de `StpAgent` promettait qu'« un
nom logique n'est jamais passé à `sendFrame` » : il est corrigé plutôt
que laissé mentir.

**Incrément 2, second lot — LIVRÉ, et la phase 1 est complète.** LACP,
DTP, UDLD, VTP, 802.1X, IGMP snooping et `arp/` lisent la couche à leur
tour. **Les dix répertoires de couche lien sont déclarés migrés** et le
garde-fou porte sur tous : aucun n'appelle `sendFrame`, aucun ne pose de
`srcMAC:`.

Deux cas ont demandé un traitement propre plutôt qu'un remplacement
mécanique. **VTP RELAIE** une trame reçue sur ses autres agrégats, et un
relais conserve l'adresse de l'ORIGINAL — c'est exactement à quoi sert
le champ `source?` de `LinkSendRequest`, qui aurait autrement été du
décor. Et **IGMP snooping** passait par `buildIgmpFrame`, qui fabrique la
trame entière : l'agent lui demande maintenant les pièces et laisse la
couche signer.

### Phase 2 — La couche internet existe, avec un seul acheminement
Créer `layers/internet/`. Migrer `Router.forwardPacket` dedans, puis y
faire pointer `EndHost`, `SwitchSvi` et le pare-feu. **Sortie** : un seul
site décrémente un TTL ; les cinq de §2.2 deviennent un.
**C'est la phase la plus risquée du chantier.**

**Mesuré pendant la phase 1 et rattaché ici plutôt qu'ailleurs** :
`Firewall.handleFrame` n'a **aucun** filtre de couche lien — il accepte
toute trame quelle qu'en soit la destination MAC. Ce n'est donc pas une
copie de la règle et la phase 1 n'avait rien à y dédupliquer. En mode
transparent c'est correct (un pont accepte tout) ; en mode routé, un
vrai FortiGate n'accepte que ce qui lui est adressé. Donner une règle au
pare-feu **change un comportement**, ce que le contrat de phase 1
interdit explicitement (§4.1), et la décision dépend du MODE de
l'interface — c'est-à-dire précisément de la question « livrer ici ou
faire suivre » que cette phase-ci déplace dans la couche internet. À
traiter ici, avec sa propre mesure et son propre témoin en mode
transparent.

**Incrément 1 — LIVRÉ.** `layers/internet/InternetLayer.ts` porte la
règle du TTL (`decrementForForwarding`) : décrémenter, décider de
l'expiration, recalculer la somme de contrôle d'en-tête. Les **cinq**
corps de §2.2 la lisent — `Router.forwardPacket`,
`Router.forwardMulticast`, `EndHost.forwardIPv4`,
`SwitchSvi.forwardIpPacket` et l'étape du pare-feu — et chacun garde ce
qui lui est PROPRE : son journal, son compteur, et la façon dont il
annonce l'expiration (le routeur émet un ICMP Time Exceeded, le
commutateur le sien depuis la SVI d'entrée, le pare-feu refuse par son
verdict). Un cas structurel échoue en nommant tout fichier de
`src/network/devices/` qui décrémenterait encore un TTL à la main.

**Ce que la mesure a corrigé d'une supposition, et qui explique que ce
lot ne change AUCUN comportement** : j'avais d'abord lu `SwitchSvi`
comme décrémentant sans garde — `{ ...ip, ttl: ip.ttl - 1 }` n'a aucune
vérification à côté — donc comme émettant des paquets à TTL 0 et restant
invisible au traceroute. C'est faux : sa garde est en tête de
`forwardIpPacket`, écrite `ttl <= 1` AVANT le décrément là où le routeur
écrit `ttl - 1 <= 0` APRÈS. Les deux formulations sont équivalentes. Les
cinq sites étaient donc d'accord, et l'incrément est une déduplication
pure — ce que le §4.1 exige de chaque phase.

**Incrément 2 — LIVRÉ.** La CLASSE d'une destination IPv4 se décide au
même endroit (`classifyIpv4Destination` : diffusion limitée, multicast
lien-local, multicast routable, unicast). Mesure de départ : le routeur
redécoupait le bloc à la main (`destOctets[0] >= 224 && <= 239`),
l'hôte appelait `isMulticastIpv4` pour la même question, le commutateur
en portait une **cinquième** écriture dans son filtrage IGMP snooping
(bornes du bloc, puis exclusion du lien-local par `isReservedMulticast`,
c'est-à-dire le même prédicat répondu deux fois de suite), et
`TcpdumpFilter.isMulticastIp` recopiait `isMulticastIpv4` mot pour mot.
Seul le routeur distinguait le multicast **lien-local** (224.0.0.0/24,
que la RFC 1112 interdit d'acheminer) du multicast routable ; l'hôte les
confondait, ce qui ne se voyait pas parce qu'un hôte n'achemine pas —
une divergence latente, exactement la forme que le §2.7 recense.

**Ce que la mesure a imposé sur la PORTÉE du garde-fou, plutôt que
l'inverse** : passé sur tout `devices/`, le cas structurel attrapait
trois fichiers qui ne sont pas des acheminements et qui ont RAISON
d'écrire ces bornes. `CiscoDhcpCommands` refuse une option d'adresse qui
ne serait pas unicast (`o[0] === 0 || o[0] >= 224`), et
`CiscoRoutingProtoCommands` en fait autant pour un réseau
(`first > 0 && first < 224 && first !== 127`) : ce sont des grammaires
d'ARGUMENT et non des classes de destination — elles répondent
« l'opérateur a-t-il le droit de taper cela », question dont 0 et 127
font partie et que `classifyIpv4Destination` ne tranche pas, puisque
240.0.0.1 y est unicast. Les fondre aurait été la fausse réutilisation
que le §4 interdit. Le garde-fou porte donc sur les fichiers qui lisent
la destination d'un VRAI paquet (`destinationIP`). Le troisième,
`TcpdumpFilter`, était en revanche une copie franche et délègue
désormais.

**Incrément 3 — LIVRÉ : le filtre de couche lien du pare-feu**, que
cette phase s'était explicitement rattaché ci-dessus. Mesure de départ :
une trame IPv4 portant une adresse MAC de destination étrangère
(`02:99:99:99:99:99`), injectée sur `port2` d'un FortiGate en mode
`nat`, est traitée entièrement — `recentTraces()` passe de 1 à 2,
exactement comme en mode `transparent`. Les deux modes répondaient donc
la même chose à une question dont ils **sont** la différence.
`Firewall.handleFrame` consulte désormais `LinkLayer.deliver` — la règle
existante, celle que l'hôte et le routeur lisent déjà, pas une seconde —
et le mode transparent la court-circuite : un VDOM transparent est un pont de
niveau 2 qui achemine sur l'adresse MAC de destination, il doit donc
accepter ce qui ne lui est pas adressé, sinon il n'a rien à ponter.

**Ce que le filtre a RÉVÉLÉ, et qui justifie l'ordre de ce chantier** :
deux défauts indépendants que l'absence de filtre rendait invisibles.
(1) **Une grappe FGCP n'avait aucune adresse MAC virtuelle.** Une vraie
grappe partage `00:09:0f:09:<group-id % 256>:<vcluster + index>` sur
toutes ses interfaces sauf le battement de cœur et la gestion réservée —
c'est ce qui rend un basculement invisible au voisinage, dont le cache
ARP reste valide. Ici chaque unité gardait la sienne, et le basculement
ne « marchait » que parce que rien ne vérifiait l'adresse de
destination : `tuto-fortigate-tp21` est passé au rouge à l'instant où
quelque chose l'a vérifiée. (2) **Une fois l'adresse virtuelle
partagée**, le subordonné émettait des sollicitations de voisin IPv6 sur
ses interfaces de données depuis cette même adresse, si bien que le
commutateur voisin réapprenait l'adresse virtuelle sur le port du
SECONDAIRE et la moitié du trafic y mourait. Sur une vraie grappe a-p un
subordonné n'émet pas sur ses interfaces de données ; c'est le pendant
exact de `forwardsTransit()`, que ce dépôt avait déjà écrit pour la
moitié TRANSIT du même fait, et la règle vit au seul point d'émission
(`sendFrame`). Les trois correctifs partent ensemble parce qu'aucun des
deux derniers n'était observable sans le premier.

**Incrément 4 — LIVRÉ : la diffusion dirigée, RFC 2644.** Premier
incrément de cette phase à toucher la décision livrer-ici /
faire-suivre / jeter elle-même. Mesure : `ip directed-broadcast` était
accepté, rangé sur le port (`Port.directedBroadcast`), rendu par
`show running-config` — et `isDirectedBroadcastEnabled()` n'avait qu'UN
appelant dans tout le dépôt, ce rendu. Aucun plan de données ne le
lisait. Sur le même laboratoire, `ping -b 192.168.20.255` depuis un hôte
de 192.168.10.0/24 rendait `100% packet loss` AVEC comme SANS la
commande : la seule différence observable entre les deux configurations
était le texte de la configuration. C'est le « ne jamais ranger un
critère qu'on n'évalue pas » du CLAUDE.md, et le fait que le défaut par
défaut soit le bon rendait l'inertie invisible — sans la commande le
paquet tombait, mais pour la mauvaise raison (le routeur cherchait à
résoudre 192.168.20.255 en ARP, sans succès) et non parce qu'une règle
en avait décidé.

L'attestation dit une chose qu'il ne fallait pas rater : la commande
Cisco « affects only the final transmission of the directed broadcast on
its ultimate destination subnet ». Ce n'est donc PAS une barrière
générale d'acheminement — un paquet qui TRAVERSE un routeur vers le
sous-réseau cible est acheminé normalement ; seul le dernier routeur,
directement connecté à la cible, l'explose en diffusion physique (option
active) ou le jette (défaut RFC 2644, BCP 34). D'où sa place exacte dans
la décision de la phase, et non dans `forwardPacket`.
`isDirectedBroadcast` vit dans la couche et réutilise
`IPAddress.isBroadcastFor`, déjà écrit.

**Deux choses que la mesure a corrigées de mes suppositions.** (1)
J'avais écrit un cas attendant que la cible RÉPONDE. Il est tombé, et il
avait tort : un vrai Linux ne répond pas à un echo adressé à une
diffusion (`net.ipv4.icmp_echo_ignore_broadcasts` vaut 1 par défaut),
qui est précisément la contre-mesure Smurf que la RFC 2644 complète côté
routeur. L'observable est donc la LIVRAISON, pas une réponse — faire
« marcher » le ping aurait demandé de casser cette contre-mesure-là.
(2) Deux cas de la sonde passaient pour la mauvaise raison, parce qu'ils
comptaient n'importe quelle trame : avant correctif le routeur émettait
une requête ARP de diffusion pour résoudre 192.168.20.255, si bien
qu'une diffusion dirigée venue de l'extérieur faisait FUIR un ARP sur le
sous-réseau cible — le paquet ne passait pas, mais le routeur parlait
quand même au segment qu'on cherchait à atteindre.

**Incrément 5 — LIVRÉ : une erreur ICMP ne répond pas à n'importe quoi.**
Mesure de départ sur un Catalyst à deux SVI : une erreur ICMP en réponse
à une erreur ICMP (1), à un paquet adressé à 239.1.1.1 (1), à un
fragment non initial (1) — trois interdits sur trois — pendant qu'un vrai
TTL expiré en donnait bien une seule. La RFC 1122 §3.2.2 nomme les quatre
cas, et **la règle existait déjà et était juste** :
`mayGenerateICMPError` de `core/IcmpErrors.ts`, lue par `Router`,
`Firewall` et `EndHost`. `SwitchSvi` ne l'appelait NULLE PART —
quatrième écriture d'un même fait, et comme partout ailleurs dans ce
dépôt c'est celle qui a oublié la règle qui est la plus permissive. Le
cas du groupe est le plus coûteux : il fait du commutateur un
amplificateur Smurf, un incrément après que la moitié routeur de cette
même contre-mesure a été livrée.

**Deux autres défauts du même sujet, fermés avec.** (1)
`core/IcmpErrors.ts` DÉLÈGUE à ses appelants le contrôle de la diffusion
DIRIGÉE — « callers that know the mask must check `isBroadcastFor()`
themselves » — et **aucun des trois ne le faisait** ; il devient faisable
ici parce que l'incrément 4 a posé `isDirectedBroadcast` dans la couche.
(2) Le SVI portait DEUX émetteurs quasi identiques, ne différant que par
le type et le code, et aucun des deux ne lisait `buildICMPError` du
module partagé. Il n'en reste qu'un.

**La portée du contrôle de diffusion dirigée est MESURÉE et non
supposée**, parce que l'ajouter partout « par précaution » rangerait un
critère que rien n'atteint. `Router` : l'incrément 4 attrape le cas avant
le chemin d'erreur. `EndHost` : un routeur Linux à deux pattes,
`ip_forward` à 1, recevant un TTL 1 vers `192.168.20.255` émet ZÉRO
erreur — et ce zéro est attesté par un TÉMOIN monté dans le même
laboratoire, un TTL 1 vers `192.168.20.10`, qui en émet exactement une.
Sans ce témoin, un laboratoire mal bâti et une absence de défaut seraient
indiscernables — piège dans lequel un cas de la sonde était justement
tombé : « source non unicast » passait déjà, non par respect de la règle
mais parce que `lookupRoute(0.0.0.0)` ne trouvait aucune route de retour.
Le silence était un accident de routage ; il est désormais décidé.

**Incrément 6 — LIVRÉ : la somme de contrôle d'en-tête est VÉRIFIÉE.**
Même forme que l'incrément 5, un cran plus bas. La RFC 1812 §5.2.2 est
sans ambiguïté — un routeur DOIT vérifier la somme de contrôle d'en-tête
de tout datagramme reçu et jeter EN SILENCE celui dont elle est fausse —
et `verifyIPv4Checksum` existe dans `core/types.ts` depuis toujours.
`Router` l'appelle (et compte `ipInHdrErrors`), `EndHost` l'appelle ;
`SwitchSvi` et `Firewall` ne l'appelaient NULLE PART. Mesure : un
datagramme portant `headerChecksum = 0x1234` traverse le commutateur de
niveau 3 et traverse le pare-feu, dans les deux cas jusqu'à l'hôte de
destination. Le champ était ÉCRIT par trente-huit sites
(`headerChecksum = computeIPv4Checksum(...)`) et LU par deux : un champ
calculé partout et vérifié presque nulle part est exactement le
« critère rangé et jamais évalué » que le CLAUDE.md interdit.

**Ce qui n'a délibérément PAS été fait** : `verifyIPv4Checksum` n'est pas
déplacée dans `layers/internet/`. Elle est déjà l'unique implantation,
partagée, et la déménager churnerait trente-huit sites d'appel sans rien
dédupliquer — la règle de réutilisation demande de l'APPELER, pas de la
déplacer. Le §3.3 dit que la somme de contrôle « vit » dans la couche
internet ; elle y vit déjà au sens qui compte, un seul corps pour tout le
dépôt.

**Le silence est la règle et non une facilité** : émettre une erreur ICMP
à propos d'un en-tête corrompu serait doublement faux, l'adresse source
de cet en-tête étant elle-même suspecte — on répondrait à une victime
choisie par l'erreur. Même famille que l'incrément 5.

**Incrément 7 — LIVRÉ : les QUATRE contrôles d'en-tête, une seule
écriture.** L'incrément 6 n'avait donné que la somme de contrôle. En
relisant le bloc « Phase B » du routeur pour l'écrire, on voit qu'il
porte QUATRE contrôles — somme, version, IHL, longueur totale — écrits en
quatre `if` qui répètent chacun le même geste (compteur, journal,
retour), et que les trois autres équipements n'en avaient qu'UN :

| équipement | contrôles avant |
|---|---|
| routeur | 4 |
| hôte | 1 (la somme) |
| commutateur L3 | 1 (la somme, incrément 6) |
| pare-feu | 1 (la somme, incrément 6) |

Mesure des trois manquants : `version = 6` dans une trame IPv4,
`ihl = 2` — plus court qu'un en-tête —, `totalLength = 4`, chacun avec
une somme RECALCULÉE pour que seul le champ visé soit en cause. Six cas
sur les deux équipements, six paquets LIVRÉS ; la RFC 1812 §5.2.2 exige
le rejet silencieux des trois.

`ipv4HeaderProblem` rend la RAISON et non un booléen, parce que le
routeur compte `ipInHdrErrors` et journalise un message par contrôle :
garder la raison laisse à chaque appelant ses propres mots, ce que
l'incrément 1 avait établi comme la règle de ce chantier. L'ORDRE est
celui du routeur et il compte — la somme d'abord, un en-tête dont la
somme est fausse n'étant pas lisible ; un cas l'épingle.

### Phase 3 — RIB et FIB séparées
**Sortie** : `lookupRoute()` ne réveille plus le plan de contrôle ; une
route statique récursive (`ip route <net> <mask> <ip-hors-lien>`)
achemine vraiment. **Mesuré, pas supposé** : `Router.addStaticRoute`
résout l'interface de sortie par `findInterfaceForIP(nextHop)` au moment
de la configuration ; un saut suivant hors lien rend `null`, la route est
donc installée avec une interface **vide** et n'achemine rien — la
commande est acceptée, la route paraît dans la table, et aucun paquet ne
part.

### Phase 4 — La couche transport existe, et UDP a un lieu
**Sortie** : la somme de contrôle UDP sort de `tcp/types.ts` ; une seule
table de ports.

### Phase 5 — Les huit applications descendent par UDP
Une famille par lot, dans cet ordre — du plus simple au plus intriqué :
syslog, NTP, NetFlow, SNMP, BFD, RIP, RADIUS, DHCP. **DHCP en dernier**
parce qu'il diffuse avant d'avoir une adresse et relaie entre sous-
réseaux, donc c'est lui qui éprouvera le plus l'interface.
**Sortie par lot** : `sendFrame` disparaît du répertoire, et les cas
existants du protocole restent verts sans modification.

### Phase 6 — `core/packetBuilders.ts` : brancher ou supprimer
Une fois la couche internet en place, ce module est soit son mécanisme
interne, soit un mort à retirer. **Il ne restera pas dans son état
actuel** — écrit, testé, sans appelant.

---

## 7. Méthode de vérification

La méthode du dépôt, appliquée à chaque phase sans exception :

1. **Mesurer avant de changer**, et écrire la mesure de départ.
2. **Sonde écrite à l'aveugle** avant le correctif.
3. **Discrimination par `git stash`** : les cas qui passent des deux
   côtés sont **nommés dans l'en-tête** avec la raison pour laquelle ils
   ne prouvent rien.
4. **Non-régression sur les suites connexes** — pour ce chantier, cela
   veut dire la suite protocolaire entière, phase par phase, jamais en un
   bloc.
5. **e2e Playwright** quand le comportement est observable dans le
   navigateur.
6. **Vérification externe** : tout comportement affirmé est confronté à
   la RFC ou à une transcription réelle.

Un garde-fou spécifique à ce chantier, à écrire en phase 1 et à faire
grossir à chaque phase : **un test de structure** qui échoue si un
répertoire déclaré migré appelle encore `sendFrame`. Sans lui, ce
document connaîtra le sort que `PRD-Frame-Only-Refactor.md` §0 décrit
pour son propre prédécesseur — « la stratégie "lister les fichiers
fautifs et les corriger un par un" n'a pas tenu dans la durée », les
violations revenant dans du code écrit après le passage.

---

## 8. Ce qui reste hors périmètre

Nommé plutôt que tu, et chacun pour une raison vérifiée :

- **IPv6 n'est pas traité séparément.** La couche internet est
  bi-famille dès la phase 2 ; il n'y aura pas une couche v4 et une
  couche v6, ce qui serait la duplication que ce document combat.
- **Les sept couches OSI** ne sont pas modélisées. Le simulateur simule
  une pile TCP/IP ; introduire session et présentation créerait des
  objets sans contenu.
- **La sérialisation en octets réels** reste hors sujet. Les PDU restent
  des objets TypeScript, et ce BRD ne change pas ce choix — il rend
  seulement leur cheminement unique.
- **Le contenu protocolaire** de chaque moteur. Aucun SPF, aucun bail,
  aucune machine à états n'est touché.
- **Le pare-feu comme quatrième famille** garde son pipeline ; ce qui
  change est qu'il cesse d'être un acheminement IP concurrent.

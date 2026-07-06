# PRD — Limites du protocole TCP actuellement implémenté (`src/network/tcp/TcpStack.ts`)

**Version** : 1.0
**Date** : 2026-07-06
**Projet** : Ubuntu Sandbox — simulateur réseau navigateur
**Auteur** : Claude (agent), à la demande de l'utilisateur
**Références normatives** :
- RFC 9293 (TCP — spécification de base, remplace la RFC 793)
- RFC 6298 (calcul du RTO — Retransmission Timeout)
- RFC 5681 (contrôle de congestion TCP — slow start, congestion avoidance, fast retransmit/fast recovery)
- RFC 7323 (extensions TCP haute performance — window scaling, timestamps, PAWS)
- RFC 2018 (TCP Selective Acknowledgment — SACK)
- RFC 1191 / RFC 1981 (Path MTU Discovery IPv4/IPv6)
- RFC 5961 (atténuation des attaques en aveugle sur une connexion TCP établie)
- RFC 3168 (Explicit Congestion Notification — ECN)

---

## 0. Contexte et portée du document

Ce PRD documente, sans les corriger, **toutes les limites vérifiées** du
transport TCP réellement implémenté dans ce dépôt (`src/network/tcp/TcpStack.ts`
et `src/network/tcp/types.ts`), par comparaison avec le comportement d'une
pile TCP réelle telle que décrite par la RFC 9293 et ses RFC satellites. Il
couvre uniquement la **couche transport** : les protocoles applicatifs qui
s'appuient dessus (SSH, SFTP, SMB, WinRM, HTTP, DNS-over-TCP, RADIUS-over-TCP,
`rndc`…) héritent de ces limites mais ne sont pas eux-mêmes ré-analysés ici.

Toutes les observations ci-dessous sont issues d'une lecture complète de
`TcpStack.ts` (896 lignes), `tcp/types.ts`, `core/TcpConnection.ts`,
`core/SocketTable.ts`, `TcpSocketStateProjection.ts`, `hardware/Cable.ts`
(pour la perte/latence simulées), et de la suite de tests existante
(`tcp-stack.test.ts`, `tcp-connect-outcome.test.ts`,
`tcp-handshake-close-lifecycle.test.ts`, `endhost-tcp-stack.test.ts`,
`ipv6-tcp-transport.test.ts`) — pas d'une supposition sur ce qu'un tel
simulateur "devrait" avoir.

### 0.1 Principe directeur

Comme pour les PRD précédents (`PRD-FTP-SFTP.md`, `PRD-Nslookup-Dig-Rndc-Runas.md`) :
ce document sépare strictement le **constat** (§1, vérifié dans le code) de la
**proposition** (§2 à §8, un plan de remédiation prêt à être exécuté phase par
phase si l'implémentation est demandée). Toute correction future devra rester
**additive et testée** : le comportement observable des ~20 700 tests déjà
verts ne doit pas régresser.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Lignes (approx.) |
|---|---|---|
| `src/network/tcp/TcpStack.ts` | Implémentation réelle : `TcpSocket`, `TcpListener`, `TcpStack` — machine à états RFC 9293, handshake, fermeture, checksum, dual-stack IPv4/IPv6 | 896 |
| `src/network/tcp/types.ts` | Types de segment (`TcpSegment`, `TcpFlags`, `TcpOption`), calcul/vérification de checksum (pseudo-en-tête IPv4/IPv6), génération d'ISN | 195 |
| `src/network/tcp/events.ts` | Payloads d'événements bus (`tcp.segment.sent/received/dropped`, `tcp.state.changed`, `tcp.connection.opened/closed`, `tcp.listener.changed`) | — |
| `src/network/core/TcpConnection.ts` | Classe `TcpConnection` **jamais instanciée par du code de production** — seuls les types `TcpStream`/`TcpConnector` qu'il exporte sont réutilisés par SSH/SMB/WinRM/SFTP ; la classe elle-même n'est instanciée que dans 3 fichiers de test (`ssh-sftp.test.ts`, `ssh-reactive-integration.test.ts`, `ssh-sftp-wire-migration.test.ts`) comme "faux" bidirectionnel léger, sans passer par `TcpStack` | 107 |
| `src/network/core/SocketTable.ts` | Registre `netstat`/`ss` — tenu à jour par `TcpSocketStateProjection` en écoutant les événements du bus, pas de logique TCP propre | 406 |
| `src/network/devices/linux/network/TcpSocketStateProjection.ts` | Projection réactive `TcpStack` → `SocketTable` (bien conçue, aucune limite relevée) | — |
| `src/network/hardware/Cable.ts` | Perte de paquets et délai de propagation simulés au niveau lien — la perte est réelle (frame silencieusement jetée), le délai n'est que des métadonnées (livraison toujours synchrone) | — |
| `src/network/ipsec/TcpMssClamper.ts` | Calculateur MSS/IPsec **isolé** — opère sur un `TcpOptionLike` hypothétique, déconnecté du chemin de données réel de `TcpStack` (qui ne pose jamais d'option MSS sur le fil) | — |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

- **Handshake 3-voies** (`connect()`/SYN-reçu passif), y compris le cas
  d'ouverture simultanée (`syn-sent` recevant un SYN nu sans ACK).
- **Fermeture RFC 9293 §3.6 complète** : `FIN-WAIT-1/2`, `CLOSE-WAIT`,
  `LAST-ACK`, `CLOSING` (fermeture simultanée), `TIME-WAIT` avec minuteur
  2×MSL réel (`TimerSet`), y compris le ré-ACK d'un FIN retransmis en
  `TIME-WAIT` (RFC 9293 §3.10.7).
- **Checksum réel** : pseudo-en-tête IPv4 *et* IPv6, vérifié à la réception
  (RFC 9293 §3.1 — segment corrompu jeté silencieusement), calculé à l'émission.
- **Double pile IPv4/IPv6** de bout en bout (`handleIp`/`handleIp6`,
  `resolveEgress`/`resolveEgress6`).
- **Rejet actif cohérent** : RST envoyé sur SYN sans écouteur, sur segment
  hors-socket ; ICMP *destination unreachable* fait échouer proprement une
  connexion (`onIcmpUnreachable`, RFC 1122 §4.2.3.9) ; `sendResetForSegment`
  permet à un pare-feu simulé de répondre comme `-j REJECT --reject-with tcp-reset`.
- **ISN raisonnablement imprévisible** (horloge XOR aléatoire), pas un simple
  compteur.
- **Segmentation par MSS** à l'émission et **rejet d'un segment dupliqué/hors
  ordre avec ACK dupliqué** (RFC 9293 §3.10.7.4) plutôt qu'une livraison
  double à l'application.
- **Projection réactive vers `SocketTable`** : `ss`/`netstat` reflètent l'état
  réel de la machine à états sans logique dupliquée.

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **Aucun minuteur de retransmission (RTO) n'existe.** `TimerSet` n'est utilisé que pour `TIME-WAIT` (2×MSL). Un SYN, un segment de données, un ACK ou un FIN perdu n'est **jamais** réémis par quiconque : la connexion reste bloquée indéfiniment dans son état courant. | RFC 6298 (calcul et gestion du RTO) | **Critique** |
| 2 | `connect()`/`EndHost.tcpConnect()` est **une tentative synchrone unique, sans fenêtre d'attente réelle** : le résultat est lu dans la même pile d'appel juste après l'émission du SYN (livraison de câble synchrone). `connectOutcome()` renvoie `'timeout'` comme un jugement instantané ("rien n'est revenu dans le même tick"), pas après un délai réellement écoulé. La valeur `'timeout'` de `TcpCloseReason` existe dans le type mais **n'est produite par aucun chemin de code** (seuls `'fin'`, `'rst'`, `'shutdown'` sont réellement utilisés). | RFC 9293 §3.10.1 (temporisation de connexion) | **Critique** |
| 3 | **Aucun contrôle de flux réel.** `_sendData` émet des segments de taille MSS en boucle serrée sans jamais consulter `window` annoncée par le pair ; il n'y a ni fenêtre glissante d'émission bornée, ni sonde de fenêtre nulle (*persist timer*), ni évitement du syndrome de la fenêtre stupide (Nagle). | RFC 9293 §3.8.6 | Élevée |
| 4 | **Aucun contrôle de congestion.** Pas de `cwnd`/`ssthresh`, pas de *slow start*, pas de *congestion avoidance*, pas de *fast retransmit*/*fast recovery*. Les indicateurs ECE/CWR existent dans `TcpFlags` mais ne sont jamais positionnés ni interprétés. | RFC 5681, RFC 3168 (ECN) | Élevée |
| 5 | **Aucune option TCP n'est jamais négociée sur le fil.** `dataOffset` est toujours codé en dur à `5` (aucune option), `options: []` reste toujours vide. Conséquences concrètes : le MSS est une constante globale (`TCP_DEFAULT_MSS = 1460`) jamais échangée via SYN ; pas de *window scaling* (la fenêtre reste plafonnée à 65535 pour toujours) ; pas de timestamps (donc pas de PAWS) ; pas de SACK — `acceptInOrder` jette **sans tampon** tout segment qui n'arrive pas exactement à `RCV.NXT`, avec un simple ACK dupliqué. | RFC 7323 (window scaling, timestamps), RFC 2018 (SACK) | Élevée |
| 6 | **Aucune estimation de RTT** (pas de SRTT/RTTVAR, pas d'algorithme de Karn) — structurellement impossible tant que #1 n'existe pas, mais c'est une lacune propre à documenter. | RFC 6298 | Élevée (dépend de #1) |
| 7 | **Aucun Path MTU Discovery.** `onIcmpUnreachable` traite **tout** ICMP "unreachable" comme une erreur fatale qui abat la connexion (RST), y compris ce qui seriat un "Fragmentation Needed"/"Packet Too Big" réel — qui devrait réduire le MSS et retransmettre, pas tuer la connexion. | RFC 1191 (IPv4), RFC 1981 (IPv6) | Moyenne |
| 8 | **Aucun keepalive.** Une connexion `established` inactive vit indéfiniment (hors TIME-WAIT) ; aucune sonde d'inactivité, aucun minuteur d'expiration configurable. | Comportement par défaut d'un noyau réel (`SO_KEEPALIVE`) | Moyenne |
| 9 | **Pas d'API de fermeture abrupte côté application.** `TcpSocket.close()` déclenche toujours une séquence FIN gracieuse ; la seule façon d'obtenir un abandon par RST est interne (réception d'un RST/ICMP du pair) — aucune méthode `abort()`/`reset()` n'est exposée à l'appelant. | `SO_LINGER`/`close()` avec RST réel | Moyenne |
| 10 | **Semi-fermeture toujours collapsée.** `handleIncomingFin` réciproque systématiquement et immédiatement par son propre FIN (`_initiateClose`) dès réception du FIN du pair — un commentaire du code documente que c'est délibéré pour les usages actuels (SSH), mais cela signifie qu'aucune application ne peut aujourd'hui continuer à écrire après avoir reçu un FIN du pair (semi-duplex réel non disponible). | RFC 9293 §3.5 (semi-fermeture) | Faible→Moyenne (limite délibérée, mais qui contraint tout futur protocole applicatif) |
| 11 | **Données urgentes/OOB absentes.** Le champ `urgentPointer` et l'indicateur `URG` existent sur le fil mais ne sont jamais positionnés ni interprétés. | RFC 9293 §3.1 (Urgent Pointer) | Faible |
| 12 | **Aucune protection contre les attaques en aveugle sur une connexion établie** (pas de challenge ACK). Impact pédagogique/sécurité si le simulateur sert un jour à illustrer le hijacking TCP. | RFC 5961 | Faible (hors du périmètre actuel du simulateur) |
| 13 | **Une seconde implémentation TCP "fantôme" traîne dans l'arborescence** : la classe `TcpConnection` de `core/TcpConnection.ts` n'est jamais instanciée par du code de production — seuls ses types `TcpStream`/`TcpConnector` sont réellement réutilisés (par SSH/SMB/WinRM/SFTP) ; la classe elle-même ne sert que de faux bidirectionnel léger dans 3 suites de test SSH, sans passer par `TcpStack`. Elle n'a ni machine à états, ni fenêtre, ni checksum ; elle risque d'induire un futur contributeur en erreur en lui faisant croire qu'il s'agit d'une alternative valable à `TcpSocket`. | Convention interne / dette de code mort | Faible (nettoyage) |
| 14 | **Conséquence utilisateur la plus visible de #1+#2** : `Cable.setLossRate()` simule une vraie perte de trame (silencieusement jetée). Avec un taux de perte non nul sur un lien transportant du TCP, **n'importe quel segment perdu bloque la connexion pour toujours** au lieu de la ralentir comme le ferait une vraie pile — les scénarios pédagogiques "dégradation WAN" ne peuvent aujourd'hui pas illustrer un TCP réaliste (contrairement à ICMP/ping, dont la latence/perte est déjà correctement reflétée dans le RTT mesuré — voir `scenario-oracle-08-rac-cache-fusion-interconnect.test.ts`). | Comportement TCP réel sous perte de paquets | **Critique** (impact utilisateur direct) |
| 15 | **Le réordonnancement est un cas quasi inatteignable en pratique.** La livraison est synchrone câble-à-câble sans modélisation de file d'attente/gigue au niveau TCP ; le chemin "ACK dupliqué sur segment hors-ordre" de `acceptInOrder` n'est donc réellement exercé qu'en test unitaire construit à la main, jamais par une vraie topologie multi-sauts simulée. | — | Faible (constat, pas un bug) |
| 16 | **Allocation de port éphémère en O(plage)** : `nextEphemeral()` fait un scan linéaire de la plage entière à chaque appel. Non-fonctionnel aujourd'hui vu les volumes de test, mais à surveiller si des scénarios à très large échelle (des centaines de connexions simultanées) apparaissent. | Note de performance, pas de fidélité RFC | Faible |
| 17 | **Pas de fragmentation/réassemblage IP réel sous TCP.** Le MSS plafonne les segments bien en dessous des MTU de lien courants, donc ce n'est jamais exercé aujourd'hui, mais un segment anormalement gros (le test existant `object payloads stay as a single segment (no segmentation)` le confirme) produirait un paquet IP qui serait fragmenté ou jeté sur un vrai réseau avec DF non positionné. | RFC 791/8200 (fragmentation IPv4/IPv6) | Faible |

---

## 2. Objectifs

### 2.1 Objectifs de ce PRD (remédiation proposée, non encore engagée)

1. **Boucle de retransmission réelle (RTO).** Chaque segment porteur de
   données (et le SYN, et le FIN) est gardé dans une file d'attente
   "non-acquittée" jusqu'à réception d'un ACK qui le couvre ; un minuteur RTO
   (calcul simplifié façon RFC 6298 : SRTT/RTTVAR avec un RTO initial fixe
   tant que #6 n'est pas mesuré, puis dynamique une fois les RTT réels
   collectés) déclenche une réémission ; après *N* échecs, la connexion est
   abattue avec `TcpCloseReason = 'timeout'` (enfin réellement produit).
2. **`connect()` réellement asynchrone avec timeout.** Le SYN est réémis
   selon le même RTO tant qu'aucune réponse n'arrive ; après épuisement des
   tentatives, l'appelant reçoit un vrai résultat "timeout" après un délai
   réellement écoulé (via `TimerSet`), pas un jugement synchrone instantané.
3. **Contrôle de flux réel.** `_sendData` respecte la fenêtre annoncée par le
   pair (`min(cwnd, rwnd)` une fois #4 livré) ; ajout d'une sonde de fenêtre
   nulle (*persist timer*, RFC 9293 §3.8.6.1) pour ne pas rester bloqué quand
   le récepteur annonce `window = 0`.
4. **Contrôle de congestion simplifié (RFC 5681).** *Slow start* +
   *congestion avoidance* + *fast retransmit*/*fast recovery* sur 3 ACK
   dupliqués. Pas d'implémentation de CUBIC/BBR — une fidélité "algorithme
   réel de référence", pas byte-exact avec un noyau Linux moderne.
5. **Options TCP réelles sur le fil.** Négociation MSS via l'option SYN
   (`min(mss_local, mss_reçu)`), *window scaling* (RFC 7323), *SACK-permitted*
   + blocs SACK réels dans `acceptInOrder` (tampon hors-ordre borné plutôt que
   jet systématique), timestamps (RTTM + PAWS).
6. **Path MTU Discovery minimal.** Distinguer un ICMP "Fragmentation
   Needed"/"Packet Too Big" d'un "unreachable" générique ; réduire le MSS
   effectif et retransmettre au lieu d'abattre la connexion.
7. **Keepalive configurable.** Minuteur de sonde d'inactivité optionnel par
   connexion, fermeture après *N* échecs.
8. **API d'abandon explicite.** `TcpSocket.reset()`/`abort()` envoyant un RST
   immédiat, en plus de `close()` qui reste gracieux (FIN) par défaut —
   changement additif, aucune suite existante n'appelle une méthode qui
   n'existait pas.
9. **Nettoyage de la classe fantôme.** Suppression de la classe
   `TcpConnection` de `core/TcpConnection.ts` (jamais instanciée en
   production) ; les types `TcpStream`/`TcpConnector` qu'elle exporte sont
   conservés (ou déplacés dans `tcp/types.ts`) puisqu'ils sont réellement
   utilisés comme contrat structurel par SSH/SMB/WinRM/SFTP.

### 2.2 Non-objectifs (explicitement hors périmètre)

- **CUBIC/BBR ou tout algorithme de congestion moderne** — RFC 5681 "manuel"
  suffit pour la fidélité pédagogique visée.
- **RFC 5961 (challenge ACK anti-hijacking)** — hors périmètre tant qu'aucun
  scénario pédagogique de spoofing TCP n'est demandé.
- **Fragmentation/réassemblage IP générique** (#17) — jamais exercé en
  pratique vu le plafond MSS ; ne sera traité que si un besoin concret
  apparaît (ex. PRD IPsec/tunnels avec MTU très réduit).
- **Urgent/OOB data (#11)** — aucun protocole simulé aujourd'hui n'en a
  besoin (telnet simulé, s'il existe, n'utilise pas l'OOB réel).
- **Semi-fermeture applicative complète (#10)** — rester sur le
  comportement actuel (réciprocité immédiate) tant qu'aucun protocole
  applicatif simulé n'en a explicitement besoin ; à revisiter si un futur
  PRD (HTTP/1.0 avec fermeture pilotée par FIN, par exemple) l'exige.
- **Réécriture de `SocketTable`/`TcpSocketStateProjection`** — déjà solides,
  non concernés par ce PRD.

---

## 3. Architecture cible

### 3.1 Principe directeur

Toutes les additions restent **internes à `TcpSocket`/`TcpStack`** : aucune
signature d'API publique existante (`connect`, `listen`, `send`, `write`,
`close`, `onOpen`/`onData`/`onClose`) ne change. Les nouveaux comportements
(retransmission, fenêtre, congestion, options) sont des mécanismes internes
déclenchés par les mêmes événements (segment reçu, minuteur expiré) sans
toucher le contrat observé par les ~65 fichiers qui consomment `TcpStack`
aujourd'hui.

### 3.2 Modules proposés (arborescence)

```
src/network/tcp/
  TcpStack.ts              (existant — gagne la file de retransmission, cwnd/rwnd, timers RTO/persist/keepalive)
  types.ts                 (existant — options réellement sérialisées/désérialisées sur TcpSegment.options)
  RttEstimator.ts           (nouveau — SRTT/RTTVAR/RTO, RFC 6298, algorithme de Karn)
  TcpCongestionControl.ts   (nouveau — cwnd/ssthresh, slow start, congestion avoidance, fast retransmit/recovery)
  TcpOptionsCodec.ts        (nouveau — encode/décode MSS, window-scale, SACK-permitted/blocks, timestamps dans TcpSegment.options)
  events.ts                 (existant — étendu avec tcp.retransmit, tcp.congestion.changed pour l'observabilité debug)
```

`core/TcpConnection.ts` est supprimé (§2.1 point 9) ; ses types utiles migrent
dans `tcp/types.ts`.

### 3.3 Design patterns retenus

- **Strategy** pour le contrôle de congestion (`TcpCongestionControl`
  injectable, pour permettre un futur remplacement sans toucher
  `TcpStack`).
- **Value Object** pour `RttEstimator` (aucun état partagé entre sockets).
- Le pattern déjà en place (Codec/Transport séparés, comme
  `RndcWireCodec`/`RndcServer`) est repris pour `TcpOptionsCodec` : pur
  encode/décode, aucune I/O.

---

## 4. Modèle de données

### 4.1 File de retransmission (par `TcpSocket`)

```ts
interface UnackedSegment {
  sequence: number;
  length: number;
  flags: TcpFlags;
  payload: unknown;
  firstSentAtMs: number;
  retransmitCount: number;
}
```

### 4.2 Fenêtre de congestion (par `TcpSocket`)

```ts
interface CongestionState {
  cwnd: number;        // en octets, initialisé à quelques MSS (RFC 5681 §3.1)
  ssthresh: number;
  dupAckCount: number;
  phase: 'slow-start' | 'congestion-avoidance' | 'fast-recovery';
}
```

### 4.3 Options TCP sérialisées

Réutilise le type `TcpOption` déjà déclaré dans `tcp/types.ts`
(`{kind:'mss'|'window-scale'|'sack-permitted'|'timestamp'|'nop'|'end'}`) —
aujourd'hui déclaré mais jamais sérialisé ; ce PRD lui donne un vrai
codec (`TcpOptionsCodec.encode/decode`) et l'intègre dans `dataOffset`/le
calcul de checksum.

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — Minuteur de retransmission (RTO) + file non-acquittée** | `RttEstimator.ts` (RTO fixe initial) ; `TcpSocket` garde chaque segment non couvert par un ACK, réémission au déclenchement du minuteur, abandon après *N* échecs avec `TcpCloseReason = 'timeout'` réellement produit | Existant |
| **P2 — `connect()` asynchrone avec vrai timeout** | Réémission du SYN selon le RTO de P1 ; `connectOutcome`/`tcpConnect` attendent réellement un délai écoulé avant de conclure au timeout | P1 |
| **P3 — Contrôle de flux réel** | `_sendData` borné par la fenêtre annoncée du pair ; sonde de fenêtre nulle (*persist timer*) | P1 |
| **P4 — RTT dynamique** | `RttEstimator` gagne SRTT/RTTVAR réels (mesurés sur les ACK non ambigus, algorithme de Karn) au lieu du RTO fixe de P1 | P1, P2 |
| **P5 — Contrôle de congestion (RFC 5681)** | `TcpCongestionControl.ts` : slow start, congestion avoidance, fast retransmit/fast recovery ; `cwnd` limite désormais `_sendData` en plus de la fenêtre du pair (checkpoint de régression complète) | P3, P4 |
| **P6 — Options TCP réelles** | `TcpOptionsCodec.ts` ; négociation MSS via SYN, window scaling, SACK (buffer hors-ordre borné dans `acceptInOrder`), timestamps + PAWS | P1 (RTTM réutilise les timestamps si présents) |
| **P7 — Path MTU Discovery minimal** | Distinction ICMP "trop gros"/"inaccessible" dans `onIcmpUnreachable` ; réduction de MSS + retransmission au lieu d'abandon | P1, P6 |
| **P8 — Keepalive + API d'abandon explicite** | Minuteur de sonde d'inactivité optionnel ; `TcpSocket.reset()`/`abort()` (RST immédiat) | P1 |
| **P9 — Nettoyage `core/TcpConnection.ts`** | Suppression de la classe fantôme ; migration des types `TcpStream`/`TcpConnector` réellement utilisés vers `tcp/types.ts` ; mise à jour des ~30 imports (types uniquement, aucun changement de comportement) (checkpoint de régression complète, fin du PRD) | Toutes les phases précédentes |

Chaque phase suit le cycle rouge → vert → refactor, régression localisée à
chaque phase, régression complète (`npx vitest run`) après P5 et après P9 —
même discipline que les PRD précédents de ce dépôt.

---

## 6. Stratégie de test

1. **Perte simulée sur un lien (`Cable.setLossRate`)** : une connexion TCP
   établie continue de progresser (avec ralentissement mesurable) au lieu de
   se bloquer indéfiniment — c'est le test le plus représentatif de l'impact
   utilisateur réel de ce PRD (item #14).
2. **Timeout de connexion réel** : `connect()` vers une IP/port qui ne répond
   jamais (route existante mais pair muet, ou perte 100 %) échoue après un
   délai réellement écoulé, pas instantanément dans le même tick ; le
   `TcpCloseReason` vaut bien `'timeout'`.
3. **Retransmission** : un ACK ou un segment de données perdu (perte forcée
   dans le test) est réémis, l'application finit par recevoir ses données,
   sans duplication côté récepteur (`acceptInOrder` reste garant).
4. **Fenêtre de réception** : un récepteur qui annonce une petite fenêtre
   limite bien le débit de l'émetteur ; une fenêtre nulle déclenche des
   sondes périodiques jusqu'à ce qu'elle se rouvre.
5. **Congestion** : simulation d'un lien avec perte modérée — vérifier la
   réduction de `cwnd` sur perte (fast retransmit après 3 ACK dupliqués) et
   sa croissance en slow start/congestion avoidance.
6. **Options** : négociation MSS effective (deux hôtes avec des MSS locaux
   différents s'accordent sur le plus petit) ; SACK permet de ne pas
   retransmettre des segments déjà reçus hors-ordre.
7. **PMTU** : un routeur simulé qui répondrait "Packet Too Big" fait baisser
   le MSS effectif sans tuer la connexion (à la différence du comportement
   actuel).
8. **Keepalive** : une connexion `established` inactive au-delà du délai
   configuré est fermée proprement après échec des sondes.
9. **Abandon explicite** : `socket.reset()` envoie un RST immédiat et ferme
   sans passer par `FIN-WAIT`.
10. **Non-régression** : les ~20 700 tests existants (en particulier
    `tcp-stack.test.ts`, `tcp-connect-outcome.test.ts`,
    `tcp-handshake-close-lifecycle.test.ts`, `endhost-tcp-stack.test.ts`,
    `ipv6-tcp-transport.test.ts`, et toutes les suites SSH/SFTP/SMB/WinRM/
    `rndc` qui transportent leur trafic sur `TcpStack`) restent vertes après
    chaque phase — en particulier les tests de handshake/fermeture
    synchrones ne doivent pas devenir asynchrones de façon incompatible.

---

## 7. Risques et points d'attention

1. **Synchronicité actuelle largement exploitée par les tests et par
   d'autres PRD.** Le constat déjà établi lors du PRD `rndc`
   ("ce simulateur livre le TCP de façon synchrone dans la même pile
   d'appel") est une hypothèse implicite dans de nombreuses suites
   (`waitForEnvelope` doit être enregistré *avant* `send()`, etc.). Rendre
   `connect()`/la retransmission réellement asynchrones (P1-P2) risque de
   casser cette hypothèse dans des suites non listées en §6 point 10 — un
   audit ciblé des call-sites `socket.send()`/`stack.connect()` est requis
   avant P1.
2. **Absence de vraie boucle d'événements temporisée dans certains contextes
   de test** — `TimerSet`/`getScheduler()` doivent être pilotables
   (horloge fictive) dans les tests unitaires pour ne pas dépendre de vrais
   `setTimeout` de plusieurs secondes (RTO, keepalive) ; vérifier le
   mécanisme déjà utilisé par `TIME-WAIT` (`this.timers.setTimeout`) et le
   réutiliser tel quel plutôt que d'inventer un second mécanisme de temps.
3. **Fidélité "protocole réel mais pas byte-exact"** — comme pour `rndc`
   (PRD précédent), ce PRD vise un TCP dont le *comportement* suit RFC 9293/
   5681/7323/2018, pas une compatibilité bit-à-bit avec une pile Linux ou
   BSD réelle (pas de CUBIC/BBR, pas de tuning sysctl).
4. **Portée du contrôle de congestion** — un contrôle de congestion mal
   calibré (RTO trop court/trop long) pourrait ralentir artificiellement des
   tests d'intégration multi-sauts existants (Oracle RAC, SSH long-lived) ;
   prévoir des valeurs par défaut proches de la réalité mais avec un RTO
   plancher assez bas pour ne pas allonger la durée des suites de tests.
5. **`core/TcpConnection.ts` (item #13/P9)** — la classe est réellement
   instanciée par 3 suites de test SSH (`ssh-sftp.test.ts`,
   `ssh-reactive-integration.test.ts`, `ssh-sftp-wire-migration.test.ts`,
   confirmé par `grep -rn "new TcpConnection("` à la rédaction de ce PRD) ;
   sa suppression en P9 devra soit migrer ces 3 suites vers un faux
   bidirectionnel équivalent, soit conserver une classe minimale réservée
   aux tests (déplacée hors de `core/`, clairement nommée comme un test
   double) — à trancher explicitement en préambule de P9, pas par défaut.

---

## 8. Critères d'acceptation

1. Une connexion TCP établie sur un lien avec perte de paquets non nulle
   progresse (lentement) au lieu de se bloquer indéfiniment.
2. `connect()`/`tcpConnect()` vers un pair muet échoue après un délai
   réellement écoulé avec `TcpCloseReason = 'timeout'`, jamais instantanément.
3. L'émetteur respecte la fenêtre annoncée par le récepteur ; une fenêtre
   nulle déclenche des sondes périodiques plutôt qu'un blocage silencieux.
4. Un contrôle de congestion RFC 5681 simplifié (slow start, congestion
   avoidance, fast retransmit/fast recovery) est actif sur toute connexion.
5. MSS, window scaling, SACK et timestamps sont réellement négociés et
   utilisés (SACK réduit les retransmissions inutiles après perte isolée).
6. Un ICMP "Packet Too Big"/"Fragmentation Needed" réduit le MSS effectif
   sans abattre la connexion.
7. Une connexion inactive au-delà du délai de keepalive configuré se ferme
   proprement ; `socket.reset()` permet un abandon RST immédiat à la
   demande de l'application.
8. `core/TcpConnection.ts` (classe fantôme) est supprimé sans régression —
   tous les imports qui n'utilisaient que ses types continuent de
   compiler.
9. Les ~20 700 tests existants restent verts après chaque phase (régression
   complète après P5 et après P9).

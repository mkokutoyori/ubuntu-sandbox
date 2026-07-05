# PRD — QUIC (RFC 9000, RFC 9001, RFC 9002)

**Version** : 1.0
**Date** : 2026-07-05
**Projet** : Ubuntu Sandbox — Module QUIC
**Auteur** : Claude Code
**Références normatives** : RFC 9000 (QUIC : protocole de transport), RFC 9001
(Using TLS to Secure QUIC), RFC 9002 (QUIC Loss Detection and Congestion
Control), RFC 8446 (TLS 1.3 — prérequis externe, cf. `PRD-TLS.md`), RFC 9114
(HTTP/3 — consommateur principal visé, cf. `PRD-HTTP.md`), RFC 6151/RFC 9221
(Datagrammes QUIC non fiables — mentionné pour mémoire, hors périmètre),
RFC 9369 (QUIC Version 2 — hors périmètre)

---

## 0. Contexte et portée du document

Ce PRD couvre **QUIC lui-même** en tant que protocole de transport générique
et indépendant : le format de paquet et la machine à états de connexion
(RFC 9000), son intégration avec TLS 1.3 pour l'établissement des clés et la
protection des paquets par espace de paquets (RFC 9001), et son recouvrement
de pertes ainsi que son contrôle de congestion (RFC 9002).

QUIC est ici traité **exactement comme TCP l'est déjà dans ce projet** : un
transport autonome, situé sous la couche applicative, ne connaissant rien de
HTTP. Son premier consommateur prévu est HTTP/3 (`docs/PRD-HTTP.md` §2.1.E/F,
phases P9/P10), mais ce PRD ne dépend d'aucune décision prise dans
`PRD-HTTP.md` — QUIC est un chantier de transport, HTTP/3 un chantier
applicatif qui le consomme.

**Dépendance externe bloquante** : RFC 9001 exige un handshake TLS 1.3 réel
(dérivation de clés par espace de paquets Initial/Handshake/1-RTT). Ce PRD
consomme le moteur décrit par `docs/PRD-TLS.md` (§2.1, notamment le key
schedule §7.1) plutôt que de redéfinir TLS — tant que ce moteur n'est pas
implémenté, les phases qui en dépendent (§5, P2 et suivantes) restent
bloquées en amont, cf. § 7 « Risques ».

Ce PRD **ne couvre pas** :

- la migration de `src/network/dns/transport/DnsQuicTransport.ts` (le
  transport ad hoc DoQ existant) vers ce nouveau moteur — chantier
  explicitement différé (§ 2.2), comme pour TLS et HTTP ;
- HTTP/3 lui-même (mapping des sémantiques HTTP sur des streams QUIC,
  QPACK) — couvert par `docs/PRD-HTTP.md` §2.1.F, qui consomme ce PRD ;
- les extensions QUIC ultérieures (multipath, QUIC v2 RFC 9369, datagrammes
  non fiables RFC 9221) — hors périmètre, cf. § 2.2.

Aucune ligne de code n'est écrite dans le cadre de ce document — il sert de
base à la planification et à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Constat |
|---|---|---|
| `src/network/dns/transport/DnsQuicTransport.ts` | Transport ad hoc pour DoQ (DNS-over-QUIC, port 853) | Un objet JSON `{quic, dcid, alpn, clientRandom, streamId, ciphertext}` **par requête/réponse**, chiffré par XOR (`SimulatedTls.ts`) ; aucune notion de connexion persistante (`DnsQuicClient.query()` ouvre un port éphémère, envoie, attend une seule réponse, ferme) |
| — | Format de paquet | **Absent** : pas d'en-tête long/court, pas de version, pas de connection ID variable, pas de bit de type de paquet |
| — | Espaces de paquets | **Absents** : pas de distinction Initial/Handshake/1-RTT, donc pas de clés distinctes par espace (RFC 9001 §4) |
| — | Recouvrement de pertes | **Absent** : aucune trame `ACK`, aucune détection de perte, `DnsQuicClient` utilise un simple timeout global (`timeoutMs`) sans retransmission structurée |
| — | Contrôle de congestion | **Absent** : aucune fenêtre de congestion, aucun algorithme | 
| — | Streams | **Approximés** : un `streamId` numérique existe mais n'a ni contrôle de flux, ni notion bidirectionnel/unidirectionnel, ni fermeture (`STREAM` frame `FIN`) |
| `src/network/devices/EndHost.ts` | `sendUdpDatagram`/`sendUdpDatagramTo`/`udpBind`/`udpClose` | Primitives UDP réelles déjà utilisées par DNS/RADIUS — **suffisantes comme base de transport pour de vrais paquets QUIC**, sans qu'aucune classe `UdpStack` dédiée n'existe (ce PRD n'en introduit pas non plus) |
| `docs/PRD-TLS.md` | Moteur TLS 1.3 générique | **PRD écrit, code pas encore implémenté** à la date de ce document — prérequis bloquant pour RFC 9001 |
| `docs/PRD-HTTP.md` | PRD HTTP/HTTPS | Esquisse déjà un répertoire `src/network/quic/` minimal (§3.3) — ce PRD **détaille et possède** cette arborescence ; `PRD-HTTP.md` s'y réfère sans dupliquer la conception |

### 1.2 Ce qui existe déjà et est réutilisable

- **Émission/réception UDP réelle** (`EndHost.sendUdpDatagram`/`udpBind`) :
  déjà exercée par DNS et RADIUS pour construire des datagrammes UDP réels
  (checksum, ports, routage) — base de transport suffisante, aucune nouvelle
  abstraction de transport à construire.
- **`simulatedDigest` et les primitives de hash déjà vérifiées** : réutilisables
  pour toute dérivation simulée nécessaire côté QUIC (ex. génération de
  connection ID, tokens de retry) sans nouvelle primitive cryptographique.
- **`EventBus`/`Scheduler`** : suffisants pour modéliser les temporisations de
  recouvrement de pertes (PTO — Probe Timeout) et les fenêtres de congestion,
  en temps virtuel testable, comme le reste du projet.
- **Le principe de fidélité « protocole réel, cryptographie simulée »**,
  déjà établi par `PkiKeyPair`, `SimulatedTls.ts` et `EapTlsHandshake.ts`,
  s'applique ici : la protection de paquets AEAD est simulée, mais le format
  de paquet, les espaces de paquets, les trames et les algorithmes de
  recouvrement de pertes/congestion sont réels.

### 1.3 Ce qui est non conforme ou manquant (gap analysis face à RFC 9000/9001/9002)

| # | Manque | RFC concernée | Sévérité |
|---|---|---|---|
| 1 | **Aucun format de paquet réel** : ni en-tête long (Initial/0-RTT/Handshake/Retry) ni en-tête court (1-RTT), ni champ de version, ni Destination/Source Connection ID de longueur variable, ni numéro de paquet à longueur variable protégé (header protection, §5.4) | RFC 9000 §17 | Bloquant |
| 2 | **Aucune machine à états de connexion** : pas de distinction des phases (négociation de version, handshake, établie, fermeture/`draining`), pas de migration de connexion, pas de connection ID multiples (`NEW_CONNECTION_ID`/`RETIRE_CONNECTION_ID`) | RFC 9000 §5, §9 | Élevée |
| 3 | **Aucun espace de paquets** (Initial/Handshake/1-RTT) : le stand-in DoQ dérive une seule clé de session globale, sans distinguer les clés par phase du handshake | RFC 9001 §4 | Élevée |
| 4 | **Aucune intégration TLS 1.3 réelle** pour dériver les clés de protection de paquets (`quic key`/`quic iv`/`quic hp` labels, §5.1) — le stand-in utilise un digest simulé générique sans rapport avec un key schedule TLS | RFC 9001 §5 | Élevée |
| 5 | **Aucune protection d'en-tête** (« header protection », §5.4) — le numéro de paquet et certains bits du premier octet devraient être masqués séparément du chiffrement du corps | RFC 9001 §5.4 | Moyenne |
| 6 | **Aucune trame `ACK`** avec plages (§19.3), donc **aucune détection de perte** (par seuil de paquets et par seuil temporel, §6.1) ni **retransmission structurée** — seul un timeout applicatif générique existe côté DoQ | RFC 9002 §6 | Élevée |
| 7 | **Aucun contrôle de congestion** : pas de fenêtre initiale, pas de slow start, pas de recovery, pas de PTO (Probe Timeout, §6.2) | RFC 9002 §7 | Élevée |
| 8 | **Streams non conformes** : pas de distinction bidirectionnel/unidirectionnel par les 2 bits de poids faible de l'ID de stream (§2.1), pas de trame `STREAM` avec offset/longueur/`FIN`, pas de contrôle de flux par stream ni par connexion (`MAX_STREAM_DATA`/`MAX_DATA`, §4) | RFC 9000 §2, §4 | Élevée |
| 9 | **Aucune négociation de version** (`Version Negotiation` packet, §6) ni de gestion d'une version inconnue | RFC 9000 §6 | Faible |
| 10 | **Aucun `Retry`** (jeton anti-amplification, §8.1) ni de limite d'amplification 3x avant validation d'adresse | RFC 9000 §8 | Faible |
| 11 | **Aucun 0-RTT** structuré — dépend directement du 0-RTT prévu par `PRD-TLS.md`, pas encore disponible | RFC 9001 §4.4 | Moyenne |
| 12 | **Fermeture de connexion non conforme** : pas de trame `CONNECTION_CLOSE` (applicative ou de couche transport), pas d'état `draining`/`closing` avec temporisation | RFC 9000 §10 | Faible |
| 13 | **Le stand-in DoQ n'est pas une connexion persistante** : chaque requête DNS ouvre/ferme son propre port éphémère — aucun multiplexage de plusieurs streams sur une seule connexion QUIC n'est même démontré | — | Faible |

**Conclusion de la phase d'analyse** : le projet ne dispose d'**aucune
implémentation de QUIC** au sens de la RFC — seulement un chiffrement de
datagramme UDP par requête, sous un nom « QUIC » qui ne reflète ni son
format de paquet, ni ses espaces de paquets, ni son recouvrement de pertes,
ni son contrôle de congestion. Ce PRD part d'une page blanche, avec une seule
dépendance externe bloquante : le moteur TLS de `PRD-TLS.md`.

---

## 2. Objectifs

### 2.1 Objectifs du protocole (ce PRD)

1. **Format de paquet conforme §17** : en-tête long (`Initial`, `0-RTT`,
   `Handshake`, `Retry`) avec version, longueurs de Destination/Source
   Connection ID, Token (Initial), Length ; en-tête court (1-RTT) avec
   Destination Connection ID et numéro de paquet à longueur variable.
   Encodage/décodage réel, y compris les variable-length integers (§16).
2. **Protection d'en-tête et de paquet simulées mais structurées (§5.1,
   §5.4)** : clés dérivées par espace de paquets via le key schedule du
   moteur `PRD-TLS.md` (labels `"quic key"`, `"quic iv"`, `"quic hp"`,
   §5.1) — chiffrement du corps simulé (même convention que
   `SimulatedTls.ts`/`EapTlsHandshake.ts`), mais protection d'en-tête
   modélisée comme une opération séparée du chiffrement du corps, comme
   l'exige §5.4 (pas un simple chiffrement global du paquet).
3. **Machine à états de connexion complète (§5, §9)** : négociation de
   version, handshake combiné avec TLS 1.3 (espaces Initial → Handshake →
   1-RTT), état établi, fermeture (`closing`/`draining`) avec temporisation ;
   gestion d'un jeu de Connection IDs actifs côté local et distant
   (`NEW_CONNECTION_ID`/`RETIRE_CONNECTION_ID`, §19.15/§19.16).
4. **Streams conformes (§2, §19.8–19.10)** : IDs de stream encodant
   client/serveur-initié et bidirectionnel/unidirectionnel dans les 2 bits de
   poids faible ; trame `STREAM` avec offset/longueur/bit `FIN` ; contrôle de
   flux par stream (`MAX_STREAM_DATA`) et par connexion (`MAX_DATA`), avec
   trames de mise à jour (`STREAM_DATA_BLOCKED`/`DATA_BLOCKED`) quand la
   fenêtre est épuisée.
5. **Recouvrement de pertes conforme RFC 9002 §6** : trame `ACK` avec plages
   de numéros de paquets acquittés (§19.3), détection de perte par seuil de
   paquets (`kPacketThreshold`) et par seuil temporel (`kTimeThreshold`),
   retransmission des données perdues (pas du paquet lui-même — les données
   sont réencapsulées dans un nouveau paquet, conformément à la RFC), calcul
   du RTT lissé (`smoothed_rtt`/`rttvar`, §5 de la RFC).
6. **Contrôle de congestion conforme RFC 9002 §7** : fenêtre de congestion
   initiale (`kInitialWindow`), slow start, congestion avoidance, recovery
   après perte détectée, Probe Timeout (PTO, §6.2) avec backoff exponentiel —
   algorithme simplifié type NewReno (pas de CUBIC/BBR réels, cf. § 2.2), mais
   respectant les transitions d'état et les formules de la RFC.
7. **Négociation de version basique (§6)** : un paquet `Version Negotiation`
   est émis si le serveur ne supporte pas la version proposée par le client,
   listant les versions supportées ; le client relance avec une version
   commune.
8. **Validation d'adresse et `Retry` (§8)** : jeton de `Retry` simulé
   (déterministe, vérifiable), limite d'amplification 3x avant validation de
   l'adresse cliente respectée dans la machine à états serveur.
9. **0-RTT (§4.4, dépend de `PRD-TLS.md`)** : données applicatives envoyées
   dans le premier paquet `0-RTT` quand un PSK de session précédente est
   disponible, acceptées ou rejetées selon la politique serveur — réutilise
   entièrement le 0-RTT déjà prévu par le moteur TLS, aucune logique de
   rejeu spécifique à QUIC au-delà de ce que TLS fournit déjà.
10. **Fermeture de connexion conforme (§10)** : trames `CONNECTION_CLOSE`
    (code d'erreur de couche transport ou applicative + raison), transition
    vers `closing`/`draining` avec temporisation avant libération complète des
    ressources de connexion.
11. **Observabilité** : événements bus dédiés (`quic.connection.established/
    closing/closed`, `quic.packet.sent/received/lost`,
    `quic.congestion.window_changed`, `quic.stream.opened/closed/blocked`)
    exploitables par les logs réseau et les tests.
12. **Transport** : construit directement sur les primitives UDP déjà
    existantes (`EndHost.sendUdpDatagram`/`udpBind`) — aucune nouvelle
    abstraction de transport générique introduite.

### 2.2 Non-objectifs (explicitement hors périmètre)

- **Migration de `DnsQuicTransport.ts` (DoQ)** vers ce nouveau moteur —
  risque de régression disproportionné pour un premier chantier ; DoQ
  continue d'utiliser son transport ad hoc **inchangé**. Une migration
  éventuelle serait un chantier séparé, une fois ce moteur stabilisé.
- **HTTP/3 lui-même** (mapping des sémantiques HTTP, QPACK) — couvert par
  `docs/PRD-HTTP.md` §2.1.F ; ce PRD s'arrête à la couche transport.
- **Vraie cryptographie AEAD** (AES-128-GCM réel des suites obligatoires
  QUIC, vraie HKDF-SHA256) — cohérent avec la convention affichée du projet ;
  seule la mécanique protocolaire (espaces de paquets, séparation
  chiffrement de corps / protection d'en-tête, format de paquet) est fidèle
  à la RFC.
- **Contrôle de congestion réel** (CUBIC RFC 8312, BBR) — un NewReno
  simplifié suffit à couvrir les transitions d'état de RFC 9002.
- **Migration de connexion (Connection Migration, §9)** au sens réseau
  (changement d'adresse IP/port en cours de session, PATH_CHALLENGE/
  PATH_RESPONSE) — les Connection IDs multiples sont modélisés (§2.1.3) mais
  la migration active n'est pas testée dans cette phase.
- **QUIC Version 2 (RFC 9369)** et toute négociation de version au-delà d'un
  scénario binaire supporté/non supporté (§2.1.6) — un vrai registre de
  versions multiples n'est pas construit.
- **Datagrammes QUIC non fiables (RFC 9221)** — extension postérieure à
  RFC 9000, non demandée, non couverte.
- **Multipath QUIC** (brouillon IETF séparé) — non couvert.
- **Tout ce que `PRD-TLS.md` §2.2 exclut déjà** (cryptographie réelle, ECH,
  compression de certificats, etc.) — hérité tel quel puisque ce PRD
  consomme ce moteur sans le redéfinir.
- **Contrôle de flux du répertoire de Connection IDs au-delà du minimum
  requis** (`active_connection_id_limit` négocié mais pas de rotation
  proactive fréquente en dehors des tests dédiés).

---

## 3. Architecture cible

### 3.1 Principe directeur

QUIC est construit comme un **transport générique indépendant**, au même
niveau architectural que `TcpStack` — il ne connaît rien de HTTP/3 ni
d'aucun protocole applicatif. Comme `PRD-TLS.md`, ce chantier est
**greenfield** : `DnsQuicTransport.ts` n'est ni modifié ni consommé par ce
nouveau module. Le point d'intégration avec la cryptographie est unique et
explicite : `PacketProtection.ts` importe le moteur TLS 1.3 de
`src/network/tls/` (une fois construit) pour obtenir les secrets par espace
de paquets — aucune autre partie du module ne connaît TLS.

### 3.2 Diagramme de couches

```
┌────────────────────────────────────────────────────────────────────┐
│ Futurs consommateurs (hors périmètre immédiat) :                    │
│   HTTP/3 (docs/PRD-HTTP.md §2.1.F) · migration éventuelle de DoQ    │
├────────────────────────────────────────────────────────────────────┤
│ QuicConnection : machine à états (§5, §9), gère streams,             │
│   recouvrement de pertes, congestion, fermeture                      │
├────────────────────────────────────────────────────────────────────┤
│ QuicStream (contrôle de flux) · LossRecovery (§6, ACK/PTO) ·          │
│   CongestionControl (§7, NewReno simplifié)                           │
├────────────────────────────────────────────────────────────────────┤
│ PacketProtection (§5.1/§5.4, espaces Initial/Handshake/1-RTT) ──────┤
│   dépend de → src/network/tls/ (PRD-TLS.md, key schedule §7.1)       │
├────────────────────────────────────────────────────────────────────┤
│ Format de paquet (§17, en-têtes long/court, varints §16)             │
├────────────────────────────────────────────────────────────────────┤
│ Transport existant : EndHost.sendUdpDatagram/udpBind, EventBus/       │
│   Scheduler (temporisations PTO, congestion)                         │
└────────────────────────────────────────────────────────────────────┘
```

### 3.3 Modules proposés (arborescence)

```
src/network/quic/
├── types.ts                  # PacketType, ConnectionId, VarInt, espaces de paquets
├── varint.ts                 # encodage/décodage des entiers à longueur variable (§16)
├── packetFormat.ts           # en-têtes long/court (§17.2/§17.3), encode/decode
├── packetProtection.ts       # §5.1/§5.4 — dérivation par espace via src/network/tls/,
│                              #   chiffrement de corps simulé + protection d'en-tête séparée
├── frames.ts                 # PADDING, PING, ACK, STREAM, MAX_DATA, MAX_STREAM_DATA,
│                              #   STREAM_DATA_BLOCKED, DATA_BLOCKED, NEW_CONNECTION_ID,
│                              #   RETIRE_CONNECTION_ID, CONNECTION_CLOSE, HANDSHAKE_DONE
├── lossRecovery.ts            # RFC 9002 §6 — ACK ranges, seuils paquet/temps, RTT lissé, PTO
├── congestionControl.ts        # RFC 9002 §7 — NewReno simplifié (slow start/avoidance/recovery)
├── QuicStream.ts                # bidirectionnel/unidirectionnel, offset/FIN, contrôle de flux
├── QuicConnection.ts             # machine à états complète, handshake combiné TLS,
│                              #   version negotiation, retry, 0-RTT, fermeture
├── versionNegotiation.ts         # §6 — paquet Version Negotiation
├── retry.ts                       # §8.1 — jeton de Retry simulé, limite d'amplification 3x
├── events.ts                       # quic.connection.*, quic.packet.*, quic.congestion.*, quic.stream.*
└── observables.ts                 # flux dérivés (tests/UI)
```

### 3.4 Design patterns retenus

- **Séparation stricte format de paquet / protection cryptographique** :
  `packetFormat.ts` encode/décode la structure sans jamais connaître les
  clés ; `packetProtection.ts` applique/retire la protection en aval — testable
  indépendamment (paquet malformé vs paquet mal protégé sont deux classes
  d'erreurs distinctes, comme dans la vraie RFC).
- **Un seul point d'import vers TLS** : seul `packetProtection.ts` dépend de
  `src/network/tls/` — `QuicConnection.ts`, `frames.ts`, `lossRecovery.ts`,
  `congestionControl.ts` n'en savent rien, ce qui permettra de tester la
  machine à états, les trames et le recouvrement de pertes **avant** que le
  moteur TLS ne soit disponible (avec des clés de test injectées
  directement), sans bloquer tout le chantier sur `PRD-TLS.md`.
- **Recouvrement de pertes et congestion comme fonctions/état pur
  testables** : `lossRecovery.ts`/`congestionControl.ts` exposent des
  structures d'état explicites (`LossDetectionState`, `CongestionState`)
  manipulées par des fonctions déterministes pilotées par le `Scheduler` —
  testable en temps virtuel sans vrai délai d'exécution.
- **Aucune dépendance vers `DnsQuicTransport.ts`** : zéro import croisé,
  zéro risque de régression sur la suite DoQ existante.
- **Cohérence avec `TcpStack`** : `QuicConnection` expose une API du même
  esprit que `TcpSocket` (`send`, `onData`, `close`, `onClose`) pour les
  futurs consommateurs applicatifs (HTTP/3 notamment), même si le
  multiplexage interne de streams n'a pas d'équivalent TCP direct.

---

## 4. Modèle de données

### 4.1 Paquet (§17)

```
QuicLongHeaderPacket {
  form: 'long'
  type: 'initial' | '0-rtt' | 'handshake' | 'retry'
  version: number
  destConnectionId: string; srcConnectionId: string
  token?: Uint8Array           // 'initial' uniquement
  length: number               // varint
  packetNumber: number          // longueur variable, protégé (§5.4)
  payload: Uint8Array            // trames chiffrées
}
QuicShortHeaderPacket {
  form: 'short'
  destConnectionId: string
  packetNumber: number
  payload: Uint8Array
}
QuicVersionNegotiationPacket {
  form: 'version-negotiation'
  destConnectionId: string; srcConnectionId: string
  supportedVersions: number[]
}
```

### 4.2 Espaces de paquets et clés (§5.1)

```
PacketNumberSpace = 'initial' | 'handshake' | 'application'
PacketProtectionKeys {
  space: PacketNumberSpace
  key: string; iv: string; headerProtectionKey: string   // simulés, dérivés du key schedule TLS
}
```

### 4.3 Trames (§19)

```
AckFrame { largestAcknowledged: number; ackDelay: number
           ackRanges: Array<{ gap: number; ackRangeLength: number }> }
StreamFrame { streamId: number; offset: number; length: number; fin: boolean; data: Uint8Array }
ConnectionCloseFrame { errorCode: number; frameType?: number; reasonPhrase: string; layer: 'transport' | 'application' }
NewConnectionIdFrame { sequenceNumber: number; retirePriorTo: number; connectionId: string }
```

### 4.4 État de recouvrement de pertes et congestion (RFC 9002)

```
LossDetectionState {
  bySpace: Record<PacketNumberSpace, {
    largestAckedPacket: number
    lossTime: number | null
    sentPackets: Map<number, { sentAt: number; size: number; ackEliciting: boolean }>
  }>
  smoothedRtt: number; rttVar: number; minRtt: number
  ptoCount: number
}
CongestionState {
  congestionWindow: number; bytesInFlight: number
  slowStartThreshold: number
  congestionRecoveryStartTime: number | null
}
```

### 4.5 Stream (§2, §4)

```
QuicStreamState {
  id: number                       // encode initiateur (client/serveur) + direction (bi/uni) sur les 2 bits bas
  direction: 'bidirectional' | 'unidirectional'
  initiatedBy: 'client' | 'server'
  sendOffset: number; sendMaxData: number     // contrôle de flux sortant
  recvOffset: number; recvMaxData: number     // contrôle de flux entrant
  finSent: boolean; finReceived: boolean
}
```

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — Varints & format de paquet** | `varint.ts`, `packetFormat.ts` : encode/décode en-têtes long/court, round-trip complet, y compris `Version Negotiation` | — |
| **P2 — Trames** | `frames.ts` : encode/décode de chaque trame utilisée (§2.1), y compris `ACK` avec plages | P1 |
| **P3 — Protection de paquets (clés de test injectées)** | `packetProtection.ts` avec des clés fournies directement par les tests (pas encore via TLS réel) — valide la séparation chiffrement de corps / protection d'en-tête indépendamment de `PRD-TLS.md` | P1, P2 |
| **P4 — Recouvrement de pertes** | `lossRecovery.ts` : RTT lissé, détection par seuil de paquets et de temps, retransmission de données perdues, PTO avec backoff | P2, P3 |
| **P5 — Contrôle de congestion** | `congestionControl.ts` : NewReno simplifié (slow start, congestion avoidance, recovery) piloté par les événements de `lossRecovery.ts` | P4 |
| **P6 — Streams** | `QuicStream.ts` : IDs bi/uni-directionnels, offset/FIN, contrôle de flux par stream et par connexion, trames `*_BLOCKED` | P2 |
| **P7 — Machine à états de connexion (sans TLS réel)** | `QuicConnection.ts` : établissement/fermeture avec des clés de test, multiplexage de plusieurs streams, `CONNECTION_CLOSE` | P3–P6 |
| **P8 — Intégration TLS 1.3 réelle (dépend de `PRD-TLS.md`)** | `packetProtection.ts` branché sur le key schedule réel de `src/network/tls/` ; handshake combiné Initial → Handshake → 1-RTT | **moteur TLS de `PRD-TLS.md` implémenté**, P7 |
| **P9 — 0-RTT** | Données applicatives dans le premier paquet `0-RTT`, réutilisant le PSK/0-RTT de `PRD-TLS.md` | P8 |
| **P10 — Retry & validation d'adresse** | `retry.ts` : jeton simulé, limite d'amplification 3x | P7 |
| **P11 — Connection IDs multiples** | `NEW_CONNECTION_ID`/`RETIRE_CONNECTION_ID`, rotation testée (sans migration active, cf. § 2.2) | P7 |
| **P12 — Observabilité** | `events.ts`/`observables.ts` transverses | P4–P11 |

Chaque phase suit le cycle rouge → vert → refactor. Ce module est
strictement additif : aucune suite existante (`dns-encrypted-transports`,
`eaptls-*`) n'est censée changer.

---

## 6. Stratégie de test

1. **Unitaires format de paquet** : round-trip encode/décode des en-têtes
   long/court et de `Version Negotiation`, varints aux bornes (0, 63, 64,
   16383, 16384, …).
2. **Unitaires trames** : round-trip de chaque trame, `ACK` avec plusieurs
   plages non contiguës.
3. **Unitaires protection de paquets** : avec des clés de test fixes,
   vérifier que la protection d'en-tête et le chiffrement du corps sont
   deux opérations indépendantes (un en-tête corrompu n'empêche pas de
   détecter un corps valide, et réciproquement) — propriété structurelle,
   pas cryptographique.
4. **Unitaires recouvrement de pertes** : un paquet non acquitté après le
   seuil temporel est marqué perdu et ses données retransmises dans un
   nouveau paquet ; un PTO déclenche l'envoi d'un paquet de sonde après
   backoff exponentiel.
5. **Unitaires congestion** : la fenêtre croît en slow start jusqu'au seuil,
   passe en congestion avoidance, se réduit après une perte détectée.
6. **Unitaires streams** : contrôle de flux (émission bloquée quand
   `sendOffset` atteint `sendMaxData`, débloquée après réception de
   `MAX_STREAM_DATA`), multiplexage de plusieurs streams indépendants sur
   une connexion.
7. **Intégration machine à états (sans TLS réel)** : établissement complet
   avec clés de test, échange de données sur plusieurs streams, fermeture
   propre (`CONNECTION_CLOSE`) avec passage par les états `closing`/
   `draining`.
8. **Intégration TLS réelle** (une fois P8 disponible) : handshake QUIC
   complet dérivant ses clés du moteur TLS 1.3, avec échec propre si la
   validation de certificat échoue (aucune clé d'application dérivée).
9. **0-RTT** : session précédente valide → données 0-RTT acceptées ; ticket
   invalide/expiré → retombée sur handshake complet sans perte de données
   applicatives (mises en attente puis renvoyées après établissement).
10. **Non-régression** : suite `dns-encrypted-transports` (DoQ) inchangée
    après l'ajout de ce module.

---

## 7. Risques et points d'attention

1. **Dépendance bloquante sur `PRD-TLS.md`** : seules les phases P8/P9
   nécessitent le moteur TLS réel — l'architecture (§ 3.4, clés de test
   injectables) permet de livrer P1 à P7 et P10/P11 **sans attendre**.
   Documenter cette frontière clairement pour éviter qu'un chantier ne
   bloque inutilement l'autre.
2. **Ampleur de la RFC 9000** : très large (migration de connexion,
   validation d'adresse, multiples Connection IDs, versions) — se limiter
   strictement aux objectifs § 2.1 ; toute extension non listée (§ 2.2)
   nécessite une mise à jour explicite de ce document.
3. **Confusion possible avec `DnsQuicTransport.ts`** : nommage proche
   (« QUIC ») pour deux implémentations très différentes — documenter
   clairement dans le code que `src/network/quic/` est le moteur conforme
   RFC 9000 et que `DnsQuicTransport.ts` reste un stand-in ad hoc,
   consciemment non migré (cf. § 2.2).
4. **Séparation protection d'en-tête / chiffrement de corps** : point
   souvent simplifié à tort dans les implémentations pédagogiques — RFC 9001
   §5.4 les distingue explicitement (le masque de protection d'en-tête est
   dérivé du chiffrement du corps mais appliqué séparément à des octets
   différents du paquet) ; les tests doivent vérifier cette séparation, pas
   seulement un chiffrement global.
5. **Fidélité du recouvrement de pertes/congestion sans vrai réseau
   dégradé** : les tests doivent injecter des pertes/latences simulées
   explicitement (comme les scénarios RAC Oracle le font pour le réseau) —
   sans cela, `lossRecovery.ts`/`congestionControl.ts` ne seraient jamais
   exercés dans leurs branches de détection de perte.
6. **NewReno simplifié** : documenter que l'algorithme ne vise que la
   fidélité aux transitions d'état RFC 9002, pas une performance ou un débit
   comparables à une vraie pile QUIC.
7. **Pas de nouvelle abstraction de transport générique** : construire
   directement sur `EndHost.sendUdpDatagram`/`udpBind`, ne pas céder à la
   tentation d'introduire un `UdpStack` générique non demandé par ce PRD.

---

## 8. Critères d'acceptation

1. Un paquet Initial encodé par `packetFormat.ts` est round-trippé
   octet-pour-octet (encode puis décode reproduit exactement la structure
   d'entrée), y compris les champs varint aux valeurs limites.
2. Une perte de paquet simulée (paquet supprimé avant délivrance) est
   détectée par seuil temporel **ou** par seuil de paquets (selon le
   scénario), et ses données sont retransmises dans un nouveau paquet avec
   un numéro de paquet strictement croissant.
3. La fenêtre de congestion croît en slow start jusqu'à un seuil configuré,
   puis passe en congestion avoidance ; une perte détectée réduit
   immédiatement la fenêtre et déclenche l'état de recovery.
4. Un scénario multi-streams (au moins 3 streams concurrents, mélange
   bidirectionnel/unidirectionnel) sur une seule connexion aboutit avec
   toutes les données reçues dans le bon ordre par stream, malgré un
   entrelacement de trames `STREAM` de streams différents dans les mêmes
   paquets.
5. Un stream dont la fenêtre de contrôle de flux est épuisée bloque
   l'émission (`STREAM_DATA_BLOCKED` émis) jusqu'à réception d'un
   `MAX_STREAM_DATA` qui la débloque.
6. Une fois `PRD-TLS.md` implémenté : un handshake QUIC complet (Initial →
   Handshake → 1-RTT) dérive des clés distinctes et correctes par espace de
   paquets, et un certificat serveur non approuvé fait échouer la connexion
   avant toute clé d'application dérivée.
7. Un scénario 0-RTT avec ticket de session valide délivre des données
   applicatives dès le premier paquet, acceptées côté serveur (`early_data`
   écho, hérité de `PRD-TLS.md`).
8. Une fermeture de connexion (`CONNECTION_CLOSE`) transite par les états
   `closing` puis `draining` avant libération complète des ressources, dans
   les deux sens (fermeture initiée par le client et par le serveur).
9. La suite existante `dns-encrypted-transports.test.ts` (DoQ) passe **sans
   aucune modification**, confirmant que ce module est strictement additif.

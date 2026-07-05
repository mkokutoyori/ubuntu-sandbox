# PRD — Protocole TLS 1.3 (RFC 8446)

**Version** : 1.0
**Date** : 2026-07-05
**Projet** : Ubuntu Sandbox — Module TLS
**Auteur** : Claude Code
**Références normatives** : RFC 8446 (TLS 1.3), RFC 7301 (ALPN), RFC 6066 (TLS Extensions — server_name/SNI), RFC 8449 (Record Size Limit), RFC 5280 (X.509, déjà couvert par le module PKI existant), RFC 5216 (EAP-TLS) et RFC 5281 (EAP-TTLS/PEAP) pour le rappel du tunnel externe déjà livré, RFC 6614 (RadSec) pour le rappel du non-objectif RADIUS déjà documenté

---

## 0. Contexte et portée du document

Ce PRD couvre **le protocole TLS 1.3 lui-même** en tant que moteur générique de
canal chiffré/authentifié au-dessus de TCP : la machine à états du handshake
1-RTT (RFC 8446 §4), l'arborescence de dérivation de clés (§7.1), la couche
d'enregistrement (§5), le protocole d'alerte (§6), la négociation ALPN
(RFC 7301), la reprise de session par PSK et les données 0-RTT (§4.2.10,
§4.2.11, §4.6.1), et le rekey en session longue (`KeyUpdate`, §4.6.3).

Il **ne couvre pas** :

- une implémentation cryptographique réelle (AEAD, HKDF-SHA256, signatures
  RSA/ECDSA/Ed25519) — ce projet simule systématiquement la cryptographie
  (`PkiKeyPair`, `SimulatedTls.ts`, `EapTlsHandshake.ts`) et ce PRD **poursuit
  cette convention délibérément**, en visant la fidélité **protocolaire**
  (ordre des messages, extensions, machine à états, arborescence de secrets
  nommés) plutôt que la fidélité cryptographique ;
- la migration de **tous** les consommateurs potentiels : ce PRD migre
  lui-même `DnsTlsTransport.ts` (DoT) et le tunnel EAP-TLS/PEAP/EAP-TTLS
  (§ 2.1.14), mais **pas** `DnsHttpsTransport.ts` (DoH) ni
  `DnsQuicTransport.ts` (DoQ) — leur dépendance TLS est migrée en même temps
  que leur framing HTTP/QUIC respectif, sous la responsabilité de
  `PRD-HTTP.md` et `PRD-QUIC.md` (cf. § 0.1 et § 2.2), pour éviter tout
  chevauchement de responsabilité entre PRDs.

Ce PRD est la **fondation** de deux chantiers consommateurs déjà planifiés :
`docs/PRD-QUIC.md` (RFC 9001 — intégration TLS 1.3 pour la protection de
paquets QUIC) et `docs/PRD-HTTP.md` (HTTPS = HTTP sur ce moteur). Il sert
aussi de fondation potentielle à des chantiers non encore engagés : RadSec
(RFC 6614, déjà noté comme hors périmètre dans `PRD-RADIUS.md` §2.2), un
`curl` HTTPS qui négocierait réellement au lieu de son heuristique actuelle
(repris par `PRD-HTTP.md`).

### 0.1 Chaîne de dépendances entre PRDs

```
PRD-TLS.md  (RFC 8446)                     ◄── VOUS ÊTES ICI
   │  fondation — aucune dépendance vers un autre PRD de ce groupe
   │
   ├──▶ PRD-QUIC.md (RFC 9000/9001/9002)
   │       consomme le key schedule (§7.1) et les sessions TLS pour RFC 9001
   │       (protection de paquets par espace Initial/Handshake/1-RTT)
   │
   └──▶ PRD-HTTP.md (RFC 9110–9114, cookies, auth, WebSocket)
           consomme directement ce moteur pour HTTPS (HTTP/1.1 et HTTP/2
           sur TLS), et indirectement via PRD-QUIC.md pour HTTP/3
```

Ce PRD n'a donc **aucune dépendance entrante** depuis `PRD-QUIC.md` ou
`PRD-HTTP.md` : il peut être développé et livré intégralement en premier.
Ses phases de migration (§ 2.1.14, § 5 P11) peuvent en revanche être
livrées en parallèle des chantiers QUIC/HTTP, puisqu'elles ne touchent que
des consommateurs déjà existants (DoT, EAP-TLS/PEAP/EAP-TTLS) sans rapport
avec QUIC ou HTTP.

Aucune ligne de code n'est écrite dans le cadre de ce document — il sert de
base à la planification et à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Constat |
|---|---|---|
| `src/network/dns/transport/SimulatedTls.ts` | Petit protocole "TLS-like" ad hoc utilisé par DoH/DoT/DoQ | `client-hello`/`server-hello`/`alert`/`application-data` en un seul aller-retour ; **aucune extension**, **aucun choix de suite**, un seul cas d'alerte codé en dur, chiffrement par flux XOR trivial (`keystreamByte`), aucune vérification d'intégrité du handshake lui-même |
| `src/network/dns/transport/DnsHttpsTransport.ts`, `DnsTlsTransport.ts`, `DnsQuicTransport.ts` | Consomment `SimulatedTls.ts` pour DoH (443), DoT (853), DoQ (853/QUIC) | Couplés directement aux primitives ad hoc, pas à un moteur TLS générique |
| `src/network/radius/eaptls/EapTlsHandshake.ts` + `EapTlsServerSession.ts`/`EapTlsPeerSession.ts` | Tunnel externe EAP-TLS/PEAP/EAP-TTLS (RFC 5216/5281), livré | Handshake **façon TLS 1.2** : `ClientHello` → `ServerFlight(cert)` + éventuel client-cert requis → `ClientFlight(cert, finished)` → `ServerFinished` — **2 allers-retours**, pas de `key_share`/`EncryptedExtensions`/`CertificateVerify` séparé, `Finished` = digest simulé déterministe sur les deux nonces, pas d'arborescence de secrets. Construit spécifiquement pour la fragmentation EAP §2.1, pas pour un usage TCP générique |
| `src/network/radius/eaptls/EapTlsFragmentation.ts` | Fragmentation par flight (bit L/M/S) | Spécifique au cadre EAP, pas au record layer TLS (limite 16 KiB, ordonnancement indépendant des flights applicatifs) |
| `src/network/pki/{CertificateAuthority,CertificateVerifier,X509Certificate,PkiKeyPair,CertificateRevocationList,OcspResponder,PkiCaRegistry}.ts` | Émission/vérification de certificats, CRL, OCSP | **Réel** au niveau de la logique (chaîne de confiance, dates de validité, révocation), signatures **simulées mais déterministes** (`PkiKeyPair.sign/verify`) — déjà réutilisé tel quel par IKE (`IkeCertAuthConfig.ts`) et EAP-TLS ; directement réutilisable sans modification |
| `src/network/devices/linux/commands/net/Curl.ts` | Commande `curl` | **Aucun TLS réel** : détecte via bannière qu'un port 443 parle un protocole non-TLS et reproduit le message d'erreur OpenSSL correspondant ; sinon délègue à `cmdCurl` (réponse HTTP gabarit statique) |
| `src/network/ipsec/IkeCertAuthConfig.ts` | Config d'authentification par certificat pour IKE | Même schéma de réutilisation PKI qu'`EapTlsConfig.ts`, sans rapport avec la couche TLS elle-même |
| — | **Aucun module `src/network/tls/` générique** | Chaque consommateur réinvente sa propre mini-poignée de main ; aucun dictionnaire de suites cryptographiques, aucune extension `key_share`/`supported_versions`, aucun `NewSessionTicket`, aucun `KeyUpdate`, aucune obfuscation de type d'enregistrement |

### 1.2 Ce qui existe déjà et est réutilisable

- **Le module PKI (`@/network/pki`) est réel dans sa logique** : émission,
  vérification de chaîne, dates de validité, CRL, OCSP — à réutiliser
  **sans aucune modification**, exactement comme EAP-TLS et IKE le font déjà.
- **Le pattern « flights JSON sérialisées + digest simulé pour Finished »**
  (`EapTlsHandshake.ts`) est un précédent direct et éprouvé pour la fidélité
  cryptographique visée ici — ce PRD réutilise la même *philosophie*
  d'abstraction, mais avec une **machine à états et un ensemble de messages
  fidèles à RFC 8446** plutôt qu'au raccourci 2-RTT déjà livré pour EAP-TLS.
- **`TcpStack`/`TcpSocket`** (déjà utilisé par `SimulatedTls.ts`) fournit un
  transport fiable et ordonné suffisant pour porter un record layer TLS —
  aucun nouveau transport à construire.
- **`EventBus`/`Scheduler`** (infrastructure `src/events/`) permettent de
  modéliser les temporisations (session tickets, anti-rejeu 0-RTT) sans
  nouvelle primitive.
- **`simulatedDigest` (`@/network/dns/dnssec/Digest`)** est déjà le point
  d'ancrage du "hachage simulé déterministe" utilisé par `SimulatedTls.ts` et
  `EapTlsHandshake.ts` — réutilisable comme brique de base d'un HKDF-Extract/
  Expand-Label simulé (§7.1).

### 1.3 Ce qui est non conforme ou manquant (gap analysis face à RFC 8446)

| # | Manque | RFC concernée | Sévérité |
|---|---|---|---|
| 1 | **Aucun moteur TLS générique réutilisable au-dessus de TCP** — seulement des tunnels bespoke par consommateur (transports DNS, EAP-TLS) | RFC 8446 (ensemble) | Bloquant |
| 2 | **Handshake 1-RTT non modélisé** : ni `key_share`/`supported_groups`, ni `HelloRetryRequest` (§4.1.4), ni `EncryptedExtensions` (§4.3.1), ni `CertificateVerify` distinct du `Finished` (§4.4.3) — `EapTlsHandshake.ts` suit un schéma 2-RTT façon TLS 1.2, `SimulatedTls.ts` un aller-retour sans aucune de ces extensions | RFC 8446 §4 | Bloquant |
| 3 | **Pas de négociation de version réelle** (`supported_versions`, §4.2.1) ni de **protection anti-downgrade** (motif spécial des 8 derniers octets du random serveur, §4.1.3) | RFC 8446 §4.1.3, §4.2.1 | Élevée |
| 4 | **Aucun dictionnaire de suites cryptographiques** négocié explicitement — ni `SimulatedTls.ts` ni `EapTlsHandshake.ts` n'exposent de choix de suite | RFC 8446 §B.4 | Élevée |
| 5 | **Key schedule absent** (§7.1) : pas d'Early/Handshake/Master Secret, pas de séparation `handshake_traffic_secret`/`application_traffic_secret`, pas de labels nommés (`"c hs traffic"`, `"s ap traffic"`, `"exp master"`, `"res master"`) — un seul `deriveSessionKey`/`computeFinished` plat et global | RFC 8446 §7.1 | Élevée |
| 6 | **Record layer non conforme** (§5.1) : pas de types de contenu réels (handshake/application_data/alert), pas de limite de 16 KiB par enregistrement avec re-fragmentation indépendante des messages de handshake, pas d'obfuscation du type d'enregistrement (tout enregistrement chiffré est censé être étiqueté `application_data` en clair, le vrai type étant à l'intérieur) | RFC 8446 §5.1, §5.4 | Élevée |
| 7 | **Aucune reprise de session** : pas de `NewSessionTicket` (§4.6.1), pas de PSK (§4.2.11), donc **pas de 0-RTT / early data** (§2.3, §4.2.10) | RFC 8446 §4.6.1, §4.2.10/11 | Élevée |
| 8 | **`KeyUpdate` absent** (§4.6.3) : aucun rekey possible en session longue | RFC 8446 §4.6.3 | Moyenne |
| 9 | **Protocole d'alerte incomplet** (§6) : un seul cas (`no_application_protocol`) codé en dur dans `SimulatedTls.ts` ; pas de dictionnaire `AlertDescription`, pas de mapping systématique depuis les raisons de `CertificateVerifier` (`bad_certificate`, `certificate_expired`, `certificate_unknown`, `unknown_ca`…) | RFC 8446 §6 | Moyenne |
| 10 | **Authentification mutuelle (mTLS) générique absente** au niveau TLS lui-même — seul EAP-TLS le fait, mais dans son propre cadre de tunnel EAP, pas comme un mécanisme TLS réutilisable par d'autres consommateurs | RFC 8446 §4.3.2, §4.4.2 | Moyenne |
| 11 | **ALPN non générique** (RFC 7301) : `SimulatedTls.ts` compare une seule chaîne par égalité stricte, ce n'est pas un module de négociation partagé (liste ordonnée, meilleur match) | RFC 7301 | Faible |
| 12 | **Aucun consommateur HTTPS/RadSec "profond"** ne peut exister sans ce moteur — `curl` reste un stub heuristique, RadSec (RFC 6614) reste hors périmètre du PRD-RADIUS faute de moteur TLS partagé | RFC 6614 (rappel) | Faible |

**Conclusion de la phase d'analyse** : le projet dispose d'un précédent solide
et éprouvé de "cryptographie simulée mais protocole réel" (PKI, EAP-TLS,
SimulatedTls.ts), mais **aucun module ne modélise TLS 1.3 lui-même** — chaque
consommateur a sa propre mini-poignée de main incompatible entre elles et très
éloignée de RFC 8446 (2-RTT au lieu de 1-RTT, aucune extension, aucune
négociation de suite, aucune arborescence de secrets, aucun 0-RTT/KeyUpdate).
Ce PRD comble ce manque par un moteur autonome, sans toucher aux consommateurs
existants.

---

## 2. Objectifs

### 2.1 Objectifs du protocole (ce PRD)

1. **Handshake 1-RTT conforme RFC 8446 §4**, machine à états explicite (à
   l'image de `EapTlsServerSession`/`EapTlsPeerSession`, mais avec
   l'ordonnancement réel de la RFC) : `ClientHello` (versions, `key_share`
   simulé, `supported_groups`, `signature_algorithms`, `server_name`/SNI,
   `alpn`, `psk_key_exchange_modes`) → `ServerHello` (ou `HelloRetryRequest`
   si le groupe proposé n'est pas supporté) → `EncryptedExtensions` →
   `CertificateRequest?` → `Certificate` → `CertificateVerify` → `Finished`
   (serveur) → `Certificate?`/`CertificateVerify?` → `Finished` (client).
2. **Key schedule fidèle à §7.1** : arborescence Early Secret → Handshake
   Secret → Master Secret, avec les labels nommés de la RFC (`"derived"`,
   `"c hs traffic"`, `"s hs traffic"`, `"c ap traffic"`, `"s ap traffic"`,
   `"exp master"`, `"res master"`) — dérivation simulée (basée sur
   `simulatedDigest`, pas de HKDF-SHA256 réelle) mais **structurellement
   fidèle** et testable (deux sessions avec des randoms différents dérivent
   des clés différentes ; le secret de handshake diffère du secret
   d'application ; les clés client/serveur diffèrent entre elles).
3. **Record layer conforme §5** : types de contenu réels
   (`handshake`/`application_data`/`alert`, compatibilité `change_cipher_spec`
   ignorée comme le veut la RFC), limite de 16 KiB par enregistrement avec
   re-fragmentation **indépendante** des messages de handshake qu'elle
   transporte, et obfuscation du type d'enregistrement une fois le
   chiffrement établi (l'enregistrement externe est toujours étiqueté
   `application_data`, le vrai type de contenu est à l'intérieur du texte
   déchiffré — modélisé même si le "chiffrement" est simulé).
4. **Négociation de version et protection anti-downgrade** (§4.1.3,
   §4.2.1) : extension `supported_versions`, détection du motif spécial des
   8 derniers octets du random serveur signalant une tentative de
   rétrogradation vers TLS ≤ 1.2 — testable en forçant un pair à répondre
   avec ce motif.
5. **`HelloRetryRequest`** (§4.1.4) : quand le groupe proposé dans le
   `key_share` du `ClientHello` n'est pas supporté par le serveur, celui-ci
   répond par un `HelloRetryRequest` (même random spécial
   `SHA-256("HelloRetryRequest")`, §4.1.3), et le client renvoie un second
   `ClientHello` avec le groupe correct — testé par un scénario de désaccord
   de groupe forcé.
6. **Authentification mutuelle (mTLS) générique** : `CertificateRequest` /
   `Certificate` / `CertificateVerify` dans les deux sens, réutilisant
   `@/network/pki` **sans aucune nouvelle cryptographie**, comme EAP-TLS l'a
   déjà fait.
7. **0-RTT / early data et reprise de session par PSK** (§2.3, §4.2.10,
   §4.2.11, §4.6.1) : `NewSessionTicket` émis en fin de handshake complet,
   réutilisable par un client pour un futur `ClientHello` avec extension
   `pre_shared_key` et données applicatives envoyées dès le premier flight
   (acceptées ou rejetées via l'écho `early_data`) — anti-rejeu simplifié
   (« un ticket = un usage », pas de fenêtre Bloom-filter réelle — limite
   documentée explicitement).
8. **`KeyUpdate`** (§4.6.3) pour le rekey en session longue, dans les deux
   directions, avec `request_update` optionnel.
9. **Protocole d'alerte structuré** (§6) : dictionnaire complet des
   `AlertDescription` pertinents (`close_notify`, `unexpected_message`,
   `bad_record_mac`, `handshake_failure`, `bad_certificate`,
   `certificate_expired`, `certificate_unknown`, `unknown_ca`,
   `decode_error`, `decrypt_error`, `protocol_version`,
   `no_application_protocol`, `missing_extension`,
   `unsupported_extension`), avec mapping systématique depuis les raisons
   retournées par `CertificateVerifier.verify()`.
10. **ALPN générique conforme RFC 7301** : sous-module partagé (liste
    ordonnée de protocoles côté client, premier match côté serveur),
    consommable par de futurs appelants sans réinventer une comparaison de
    chaîne ad hoc.
11. **Dictionnaire de suites cryptographiques** couvrant les 5 suites
    obligatoires de la RFC (`TLS_AES_128_GCM_SHA256`,
    `TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256`,
    `TLS_AES_128_CCM_SHA256`, `TLS_AES_128_CCM_8_SHA256`) — le chiffrement
    réel reste simulé, mais le choix de suite est négocié explicitement et
    affecte de façon déterministe des paramètres simulés (ex. taille de tag
    simulée), rendant le choix observable et testable.
12. **Observabilité** : événements bus dédiés
    (`tls.handshake.started/completed/failed`, `tls.alert.sent/received`,
    `tls.session.resumed`, `tls.key_update`) exploitables par les logs
    réseau et les tests.
13. **Transport** : le moteur s'appuie sur `TcpStack`/`TcpSocket` existant
    (comme `SimulatedTls.ts`) — aucun nouveau transport, pas de QUIC.
14. **Migration des consommateurs TLS directs existants** : une fois le
    moteur stabilisé (§ 5, phases P1–P10 vertes), `DnsTlsTransport.ts` (DoT,
    RFC 7858, port 853) bascule sur de vraies `TlsClientSession`/
    `TlsServerSession` (ALPN `dot`) à la place de `SimulatedTls.ts`. Le
    tunnel EAP-TLS/PEAP/EAP-TTLS (`EapTlsServerSession.ts`/
    `EapTlsPeerSession.ts`) remplace son modèle de flights ad hoc (2-RTT
    façon TLS 1.2, `EapTlsHandshake.ts`) par de vrais appels au moteur 1-RTT
    RFC 8446 — la fragmentation EAP §2.1 (`EapTlsFragmentation.ts`, RFC 5216)
    reste une couche distincte au-dessus, inchangée : c'est le contenu des
    flights transportées qui migre, pas leur transport EAP. `DnsHttpsTransport.ts`
    (DoH) et `DnsQuicTransport.ts` (DoQ) ne sont **volontairement pas** migrés
    ici — cf. § 0.1 : leur dépendance TLS migre avec leur framing HTTP/QUIC
    respectif, sous la responsabilité de `PRD-HTTP.md`/`PRD-QUIC.md`.

### 2.2 Non-objectifs (explicitement hors périmètre)

- **RadSec (RFC 6614, RADIUS/TLS)** et **`curl` HTTPS « profond »**
  (négociation réelle au lieu du stub heuristique actuel) — consommateurs
  potentiels de ce moteur, explicitement différés à des chantiers ultérieurs
  (le PRD-RADIUS §2.2 note déjà RadSec hors périmètre).
- **QUIC/TLS 1.3 intégré (RFC 9001)** — DoQ garde son XOR ad hoc
  (`SimulatedTls.ts`), séparé de ce moteur.
- **Cryptographie réelle** (AEAD réel AES-GCM/ChaCha20-Poly1305, vraie
  HKDF-SHA256, vraies signatures RSA/ECDSA/Ed25519) — conforme à la
  convention affichée du projet ; seule la mécanique protocolaire est
  fidèle à la RFC.
- **Compression de certificats** (RFC 8879), **Encrypted Client Hello**
  (brouillon IETF séparé, hors RFC 8446), et tout usage de l'extension
  `status_request` (OCSP stapling) au-delà de ce que `CertificateVerifier`/
  `OcspResponder` savent déjà faire hors bande — non couverts.
- **Export Keying Material** (§7.5) exploité par une API applicative — le
  secret exportateur est dérivé structurellement (§7.1) mais aucune méthode
  `exportKeyingMaterial()` n'est exposée dans cette première phase.
- **Renégociation** — déjà interdite par TLS 1.3 lui-même ; non applicable,
  pas une lacune.
- **`Record Size Limit`** (RFC 8449) et autres extensions mineures non
  listées en §2.1 — reportées si un besoin concret apparaît.

---

## 3. Architecture cible

### 3.1 Principe directeur

Contrairement au PRD RADIUS (où un moteur existant est refondu sous des
façades déjà en place), ce chantier démarre **greenfield** : les phases
P1–P10 (§ 5) construisent et testent `src/network/tls/` de façon
indépendante (sessions client/serveur directes, sans passer par TCP dans un
premier temps, puis end-to-end via `TcpStack`), **sans modifier** un seul
fichier existant (`SimulatedTls.ts`, `EapTlsHandshake.ts`, leurs
consommateurs). Principe retenu : **moteur autonome d'abord, migration
ensuite, dans ce même PRD**. Une fois ces phases vertes, la phase P11
migre les deux consommateurs TLS directs (DoT, EAP-TLS/PEAP/EAP-TTLS,
§ 2.1.14) sur le nouveau moteur — contrairement à `PRD-RADIUS.md`, la
migration fait ici partie du périmètre livré, pas d'un chantier
« éventuel » non engagé. Les consommateurs dont la migration dépend d'un
autre PRD (DoH → `PRD-HTTP.md`, DoQ → `PRD-QUIC.md`) restent hors
périmètre de ce document (§ 0.1, § 2.2).

### 3.2 Diagramme de couches

```
┌────────────────────────────────────────────────────────────────────┐
│ Migrés par ce PRD (P11, § 2.1.14) :                                 │
│   DnsTlsTransport.ts (DoT) · EapTlsServerSession/EapTlsPeerSession  │
│   (EAP-TLS/PEAP/EAP-TTLS)                                           │
├────────────────────────────────────────────────────────────────────┤
│ Consommateurs migrés par un PRD frère (§ 0.1) :                     │
│   DnsHttpsTransport.ts (DoH) → PRD-HTTP.md                          │
│   DnsQuicTransport.ts (DoQ) → PRD-QUIC.md (via RFC 9001)            │
├────────────────────────────────────────────────────────────────────┤
│ Futurs consommateurs (hors périmètre, non engagés) : RadSec,        │
│   curl HTTPS profond (repris par PRD-HTTP.md)                       │
├────────────────────────────────────────────────────────────────────┤
│ Sessions : TlsClientSession / TlsServerSession                      │
│   (machine à états RFC 8446 §4 : HRR, mTLS, 0-RTT, KeyUpdate)      │
├────────────────────────────────────────────────────────────────────┤
│ Sous-modules :                                                      │
│   messages.ts (types + (dé)codage des flights de handshake)        │
│   extensions.ts (key_share, supported_versions, ALPN, SNI, PSK…)    │
│   keySchedule.ts (arbre de secrets §7.1)                            │
│   recordLayer.ts (§5, fragmentation 16 KiB, obfuscation de type)    │
│   alerts.ts (§6) · cipherSuites.ts (§B.4) · alpn.ts (RFC 7301)      │
│   sessionTickets.ts (PSK/résumption §4.6.1, anti-rejeu simplifié)   │
├────────────────────────────────────────────────────────────────────┤
│ Réutilisé tel quel : @/network/pki (CA, Verifier, X509, PkiKeyPair, │
│   CRL, OCSP) · TcpStack/TcpSocket · EventBus/Scheduler              │
└────────────────────────────────────────────────────────────────────┘
```

### 3.3 Modules proposés (arborescence)

```
src/network/tls/
├── types.ts                  # TlsVersion, ContentType, AlertLevel, HandshakeType
├── messages.ts               # ClientHello/ServerHello/HelloRetryRequest/EncryptedExtensions/
│                              #   CertificateRequest/Certificate/CertificateVerify/Finished/
│                              #   NewSessionTicket/KeyUpdate — encode/decode (flights JSON,
│                              #   même niveau d'abstraction que EapTlsHandshake.ts)
├── extensions.ts              # supported_versions, key_share, supported_groups,
│                              #   signature_algorithms, server_name (SNI), alpn,
│                              #   psk_key_exchange_modes, pre_shared_key, early_data
├── keySchedule.ts             # arbre de secrets §7.1 (labels HKDF-Expand-Label simulés
│                              #   via simulatedDigest) : Early/Handshake/Master Secret,
│                              #   handshake_traffic_secret / application_traffic_secret,
│                              #   exporter_master_secret, resumption_master_secret
├── recordLayer.ts              # fragmentation/réassemblage 16 KiB, obfuscation de type,
│                              #   chiffrement simulé (XOR/digest, réutilise SimulatedTls.ts
│                              #   comme référence de fidélité sans en dépendre)
├── alerts.ts                   # dictionnaire AlertDescription + mapping depuis
│                              #   CertificateVerifier.reason
├── cipherSuites.ts              # dictionnaire des 5 suites obligatoires + sélection serveur
├── alpn.ts                      # négociation générique RFC 7301
├── sessionTickets.ts             # NewSessionTicket, PSK binder simulé, anti-rejeu
│                              #   « un ticket = un usage »
├── TlsClientSession.ts            # machine à états pair (ClientHello → … → Finished,
│                              #   HRR, 0-RTT, KeyUpdate)
├── TlsServerSession.ts            # machine à états serveur (miroir)
├── events.ts                      # tls.handshake.*, tls.alert.*, tls.session.resumed,
│                              #   tls.key_update
└── observables.ts                 # flux dérivés (tests/UI)
```

### 3.4 Design patterns retenus

- **Codec pur, sans effet de bord** : `encodeMessage`/`decodeMessage`
  symétriques, testables exhaustivement, comme le reste des codecs du projet
  (RADIUS, EAP).
- **Machine à états explicite** par session (client et serveur), à l'image de
  `EapTlsServerSession`/`EapTlsPeerSession`, mais avec les états et
  transitions propres à RFC 8446 §4 (y compris les branches `HelloRetryRequest`
  et 0-RTT, absentes du modèle EAP-TLS existant).
- **Arborescence de secrets comme fonction pure testable** : `keySchedule.ts`
  expose des fonctions déterministes (`deriveEarlySecret`,
  `deriveHandshakeSecret`, `deriveMasterSecret`, `deriveTrafficSecret(label,
  ...)`) sans état caché, vérifiables indépendamment de toute session réseau.
- **Réutilisation PKI stricte** : aucune nouvelle primitive de signature ou de
  vérification de certificat n'est introduite ; `Certificate`/
  `CertificateVerify` délèguent entièrement à `@/network/pki`.
- **Additif d'abord, migration ensuite en un point de bascule net** :
  pendant P1–P10, `SimulatedTls.ts` et `EapTlsHandshake.ts` ne sont ni
  importés ni modifiés — zéro risque de régression sur les suites DNS/
  EAP-TLS déjà vertes. En P11 (§ 2.1.14), la migration remplace
  l'**implémentation interne** de `EapTlsServerSession`/`EapTlsPeerSession`
  et de `DnsTlsTransport.ts` par des appels au nouveau moteur, sans changer
  leurs signatures publiques (`EapTlsConfig`, `EapTlsPeerOptions`, l'API de
  `DnsTlsTransport.ts`) — les consommateurs de ces classes (`RadiusServerAgent`,
  `Dot1xAgent`) n'ont rien à changer.
- **Séparation record layer / messages de handshake** : contrairement à
  `EapTlsFragmentation.ts` (fragmentation *par flight*, propre au cadre EAP),
  `recordLayer.ts` fragmente indépendamment de la taille des messages qu'il
  transporte, conformément à §5.1.

---

## 4. Modèle de données

### 4.1 Messages de handshake (§4)

```
ClientHello { legacyVersion, random, cipherSuites: CipherSuite[],
              extensions: { supportedVersions, keyShare, supportedGroups,
                            signatureAlgorithms, serverName?, alpn?,
                            pskKeyExchangeModes?, preSharedKey?, earlyData? } }
ServerHello { random, cipherSuite: CipherSuite,
              extensions: { supportedVersions, keyShare?, preSharedKey? } }
HelloRetryRequest { random: 'HelloRetryRequest-magic', selectedGroup }
EncryptedExtensions { extensions: { alpn?, earlyData? } }
CertificateRequest { certificateRequestContext, signatureAlgorithms }
Certificate { certificateList: X509Certificate[] }
CertificateVerify { signature: string }   // signature simulée sur le transcript
Finished { verifyData: string }           // HMAC simulé sur le transcript + secret de traffic
NewSessionTicket { ticketLifetime, ticketAgeAdd, ticketNonce, ticket, extensions: { earlyData? } }
KeyUpdate { requestUpdate: boolean }
```

### 4.2 Arborescence de secrets (§7.1)

```
KeySchedule {
  earlySecret: string
  binderKey?: string
  clientEarlyTrafficSecret?: string
  earlyExporterMasterSecret?: string
  handshakeSecret: string
  clientHandshakeTrafficSecret: string
  serverHandshakeTrafficSecret: string
  masterSecret: string
  clientApplicationTrafficSecret: string
  serverApplicationTrafficSecret: string
  exporterMasterSecret: string
  resumptionMasterSecret: string
}
```

Chaque champ est dérivé via une fonction `deriveLabel(secret, label,
transcriptHash)` s'appuyant sur `simulatedDigest` — pas de HKDF-SHA256 réelle,
mais les **noms de labels et l'ordre de dérivation** suivent §7.1 tel quel,
ce qui rend la structure vérifiable indépendamment de la crypto sous-jacente.

### 4.3 Enregistrement (§5.1)

```
TlsRecord { contentType: 'handshake' | 'application_data' | 'alert' | 'change_cipher_spec',
            legacyVersion, length /* ≤ 16384 */, fragment: Uint8Array }
```

Après établissement des clés, tout `TlsRecord` sortant est étiqueté
`application_data` en clair (obfuscation de type, §5.4) ; le vrai
`contentType` figure dans le texte déchiffré (`InnerPlaintext { content,
contentType, zeros padding? }`).

### 4.4 Session ticket / PSK (§4.6.1, §4.2.11)

```
SessionTicket { ticket: string, resumptionMasterSecret: string,
                cipherSuite: CipherSuite, ticketLifetime: number,
                issuedAt: number, consumed: boolean }
```

`consumed` implémente l'anti-rejeu simplifié documenté en § 2.1.7 — un ticket
déjà utilisé est rejeté, sans fenêtre de rejeu par Bloom filter réelle.

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — Types, messages, record layer** | `types.ts`, `messages.ts` (encode/decode des flights), `recordLayer.ts` (fragmentation 16 KiB, obfuscation de type) | — |
| **P2 — Key schedule** | `keySchedule.ts` : arbre de secrets §7.1, tests de déterminisme structurel (randoms différents → clés différentes, handshake ≠ application, client ≠ serveur) | P1 |
| **P3 — Handshake 1-RTT nominal** | `TlsClientSession`/`TlsServerSession` : cas nominal sans HRR ni client-cert — `ClientHello` → `ServerHello` → `EncryptedExtensions` → `Certificate` → `CertificateVerify` → `Finished` (serveur) → `Finished` (client) ; succès/échec (cert non fiable → alerte, avant tout `application_data`) | P1, P2 |
| **P4 — mTLS** | `CertificateRequest`/`Certificate`/`CertificateVerify` côté client, réutilisant `@/network/pki` sans nouvelle crypto | P3 |
| **P5 — HelloRetryRequest** | Détection de groupe non supporté, second `ClientHello`, random spécial §4.1.3 | P3 |
| **P6 — Alertes complètes** | `alerts.ts` : dictionnaire complet, mapping depuis `CertificateVerifier.reason`, scénarios négatifs par cause (`bad_certificate`, `certificate_expired`, `unknown_ca`, `decode_error`…) | P3 |
| **P7 — ALPN & suites cryptographiques** | `alpn.ts` (RFC 7301), `cipherSuites.ts` (5 suites obligatoires, sélection serveur) | P3 |
| **P8 — Résumption PSK & 0-RTT** | `sessionTickets.ts`, extension `pre_shared_key`/`early_data`, anti-rejeu « un ticket = un usage » | P2, P3 |
| **P9 — KeyUpdate** | Rekey bidirectionnel en session longue, `request_update` | P3 |
| **P10 — Observabilité** | `events.ts`/`observables.ts` : événements bus, exploitables par logs et tests | P3–P9 |
| **P11 — Migration DoT & EAP-TLS/PEAP/EAP-TTLS** | `DnsTlsTransport.ts` bascule sur `TlsClientSession`/`TlsServerSession` réels ; `EapTlsServerSession.ts`/`EapTlsPeerSession.ts` remplacent `EapTlsHandshake.ts` par le moteur 1-RTT (la fragmentation EAP §2.1 reste inchangée, seul son contenu change) ; mise à jour des assertions de test dépendant de l'ancien modèle 2-RTT (cf. § 7 risque « comptage de rounds ») | P1–P10 |

Chaque phase suit le cycle rouge → vert → refactor. Pendant P1–P10, aucune
suite existante (`dns-encrypted-transports.test.ts`, `eaptls-*.test.ts`,
`peap-ttls-handshake.test.ts`, `dot1x-radius-eaptls.test.ts`,
`dot1x-radius-peap-ttls.test.ts`) n'est censée changer, puisque le module
reste strictement additif jusque-là. **P11 change délibérément ce
principe** pour les seules suites DoT/EAP-TLS/PEAP/EAP-TTLS : leur
comportement observable (accept/reject, port 802.1X autorisé ou non) doit
rester identique, mais leurs assertions numériques calibrées sur l'ancien
modèle 2-RTT (nombre de rounds, nombre de flights) sont attendues comme
devant être mises à jour (§ 7).

---

## 6. Stratégie de test

1. **Unitaires messages/record layer** : round-trip encode/décode de chaque
   type de message, fragmentation/réassemblage à limite réduite (à l'image du
   test `mtu: 40` d'`EapTlsServerSession`) forçant plusieurs enregistrements
   pour un seul message de handshake.
2. **Unitaires key schedule** : déterminisme (mêmes entrées → mêmes secrets),
   divergence (randoms différents → secrets différents), séparation
   handshake/application, séparation client/serveur, séparation early/
   handshake/master.
3. **Handshake nominal de bout en bout** (sessions directes, sans TCP) :
   succès avec certificat serveur valide ; échec avant tout `application_data`
   si le certificat est émis par une CA non approuvée par le `verifier` du
   pair (mêmes garanties que le test PEAP existant « rejects when the outer
   server certificate is untrusted, before the inner phase ever starts »).
4. **mTLS** : succès avec certificat client valide ; échec si le client ne
   présente aucun certificat alors que `CertificateRequest` a été émis.
5. **HelloRetryRequest** : scénario de désaccord de groupe forcé, vérifiant
   que le second `ClientHello` aboutit à un handshake réussi.
6. **0-RTT/PSK** : ticket valide → données early acceptées ; ticket expiré ou
   déjà consommé → retombée sur handshake complet sans early data.
7. **KeyUpdate** : vérification structurelle que le secret de trafic
   d'application change après un `KeyUpdate`, dans chaque direction
   indépendamment.
8. **Downgrade protection** : un serveur simulant une réponse TLS ≤ 1.2 (motif
   spécial dans les 8 derniers octets du random) est détecté et rejeté par le
   client avant `Finished`.
9. **Intégration TCP** : sessions client/serveur pilotées via `TcpStack`/
   `TcpSocket` réels, sur une topologie câblée simple, pour vérifier que la
   fragmentation du record layer survit à la segmentation TCP sous-jacente.
10. **Non-régression (P1–P10)** : exécution complète des suites
    DNS-over-TLS/HTTPS/QUIC et EAP-TLS/PEAP/EAP-TTLS existantes, garantissant
    qu'aucune n'est affectée par l'ajout du nouveau module.
11. **Migration (P11)** : suites DoT et EAP-TLS/PEAP/EAP-TTLS ré-exécutées
    après bascule sur le nouveau moteur — vérifier que les résultats
    observables (accept/reject, port 802.1X autorisé/refusé, échec avant
    tout `application_data` si le certificat est rejeté) sont **identiques**
    à l'avant-migration, même si le nombre de rounds/flights change (1-RTT
    au lieu de 2-RTT).

---

## 7. Risques et points d'attention

1. **Ampleur de la RFC** : RFC 8446 est volumineuse — se limiter strictement
   aux objectifs listés en § 2.1 et refuser tout ajout non listé sans repasser
   par une mise à jour explicite de ce PRD (`Record Size Limit`, ECH,
   compression de certificats, etc. restent hors périmètre, cf. § 2.2).
2. **Confusion sur le niveau de sécurité réel** : comme pour `PkiKeyPair` et
   `SimulatedTls.ts`, documenter clairement (code + PRD) que la
   cryptographie est simulée — ce moteur ne doit jamais être présenté comme
   offrant une confidentialité réelle, seulement une fidélité protocolaire à
   des fins pédagogiques/de test.
3. **Aucune collision avec `EapTlsHandshake.ts`** : noms de types et de
   modules entièrement distincts (`src/network/tls/` vs
   `src/network/radius/eaptls/`), aucun import croisé — garantit qu'un
   chantier futur de migration reste une décision séparée et réversible.
4. **Fidélité du key schedule sans vraie HKDF** : les tests doivent porter sur
   les propriétés structurelles (déterminisme, séparation des secrets) et non
   sur une conformité bit-à-bit à un vecteur de test RFC réel — documenter
   cette limite explicitement, comme cela a été fait pour la dérivation MPPE
   dans `PRD-RADIUS.md`.
5. **Portée du 0-RTT** : l'anti-rejeu simplifié (« un ticket = un usage »)
   doit être documenté comme une simplification assumée, pas comme une
   implémentation de la fenêtre de rejeu réelle de la RFC (§8, hors périmètre
   de ce document — RFC 8446 §8 est explicitement une annexe informative sur
   les stratégies anti-rejeu, non un algorithme unique imposé).
6. **Pas de consommateur avant P11** : pendant P1–P10, le risque est de
   construire un moteur qui ne « colle » pas aux besoins effectifs d'un
   futur consommateur — atténué en construisant les scénarios de test § 6 à
   partir des flux RFC 8446 eux-mêmes, puis validé concrètement dès P11 par
   la migration de deux consommateurs réels (DoT, EAP-TLS/PEAP/EAP-TTLS).
7. **Assertions de test calibrées sur l'ancien modèle 2-RTT** : des tests
   comme `peap-ttls-handshake.test.ts` (« completes even when a tiny MTU
   forces fragmentation… », qui vérifie un nombre minimal de rounds) sont
   écrits contre le raccourci 2-RTT d'`EapTlsHandshake.ts`. La migration P11
   vers un vrai handshake 1-RTT **changera nécessairement** ces comptages —
   ce n'est pas une régression tant que le résultat final (accept/reject)
   est inchangé, mais les assertions numériques devront être mises à jour
   consciemment, pas juste « corrigées jusqu'à ce que ça passe ».
8. **Compatibilité de signature pendant la migration** : `EapTlsConfig`/
   `EapTlsPeerOptions` et l'API publique de `DnsTlsTransport.ts` ne doivent
   pas changer de forme en P11 — seule l'implémentation interne bascule,
   pour que `RadiusServerAgent`/`Dot1xAgent` et les appelants de
   `DnsTlsTransport.ts` n'aient rien à modifier.

---

## 8. Critères d'acceptation

1. Un handshake 1-RTT complet (`ClientHello` → … → `Finished` client) aboutit
   en **exactement un aller-retour de flights applicatifs** (hors
   `HelloRetryRequest`), avec un certificat serveur émis par une CA de
   confiance du pair.
2. Un certificat serveur émis par une CA **non approuvée** provoque un échec
   du handshake avant tout `application_data`, avec une alerte
   `unknown_ca`/`bad_certificate` cohérente avec la raison retournée par
   `CertificateVerifier`.
3. Un scénario mTLS complet : authentification serveur **et** client réussies
   dans la même session, réutilisant `@/network/pki` sans nouvelle crypto.
4. Un scénario de désaccord de groupe déclenche un `HelloRetryRequest`
   valide, suivi d'un second `ClientHello` qui aboutit à un handshake réussi.
5. Un scénario de reprise de session : un ticket valide permet l'envoi de
   données 0-RTT acceptées ; un ticket déjà consommé ou expiré fait retomber
   la session sur un handshake complet sans early data, sans erreur non
   gérée.
6. Un `KeyUpdate` change de façon vérifiable le secret de trafic
   d'application (structurellement, pas bit-à-bit) dans la direction
   demandée, sans affecter l'autre direction tant qu'elle n'a pas reçu son
   propre `KeyUpdate`.
7. Un serveur simulant une rétrogradation TLS ≤ 1.2 est détecté et rejeté par
   le client avant `Finished`.
8. Une fragmentation forcée à une limite de record réduite (test dédié, à
   l'image du `mtu: 40` d'EAP-TLS) aboutit malgré tout à un handshake réussi,
   prouvant l'indépendance du record layer vis-à-vis de la taille des
   messages de handshake.
9. Pendant P1–P10, toutes les suites existantes (`dns-encrypted-transports`,
   `eaptls-*`, `peap-ttls-handshake`, `dot1x-radius-eaptls`,
   `dot1x-radius-peap-ttls`) passent **sans aucune modification**,
   confirmant que le module reste strictement additif jusqu'à P11.
10. Après P11 : `DnsTlsTransport.ts` et le tunnel EAP-TLS/PEAP/EAP-TTLS
    utilisent réellement `src/network/tls/` (vérifiable par un import direct
    dans le code, pas seulement par les tests) ; les suites migrées
    produisent les mêmes résultats observables qu'avant migration
    (accept/reject, port 802.1X autorisé/refusé), avec des assertions de
    comptage de rounds mises à jour consciemment plutôt que supprimées.

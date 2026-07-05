# PRD — Protocoles HTTP / HTTPS (HTTP/1.1, HTTP/2, HTTP/3, cache, cookies, authentification, WebSocket)

**Version** : 1.0
**Date** : 2026-07-05
**Projet** : Ubuntu Sandbox — Module HTTP/HTTPS
**Auteur** : Claude Code
**Références normatives** : RFC 9110 (sémantique HTTP), RFC 9111 (cache HTTP), RFC 9112
(HTTP/1.1), RFC 9113 (HTTP/2), RFC 9114 (HTTP/3), RFC 7541 (HPACK — nécessaire à
RFC 9113), RFC 9204 (QPACK — nécessaire à RFC 9114), RFC 8446 (TLS 1.3 —
prérequis externe, cf. `PRD-TLS.md`), RFC 9000/RFC 9001/RFC 9002 (QUIC —
transport, intégration TLS 1.3, recouvrement de pertes/congestion), RFC 6265
(cookies), RFC 7617 (authentification Basic), RFC 7616 (authentification
Digest), RFC 6455 (WebSocket)

---

## 0. Contexte et portée du document

Ce PRD couvre l'ensemble de la pile **HTTP/HTTPS** demandée : la sémantique
générique indépendante de la version (RFC 9110), le cache (RFC 9111), le
frame réel HTTP/1.1 (RFC 9112), HTTP/2 (RFC 9113 + HPACK), HTTP/3 sur QUIC
(RFC 9114 + QPACK, QUIC lui-même RFC 9000/9001/9002), les cookies
(RFC 6265), l'authentification Basic/Digest (RFC 7617/7616), et WebSocket
(RFC 6455).

**HTTPS n'est pas un protocole séparé** : c'est HTTP/1.1 ou HTTP/2 (voire
HTTP/3, intrinsèquement chiffré) transporté par TLS 1.3. Ce PRD **consomme**
le moteur TLS décrit par `docs/PRD-TLS.md` (§2.1) plutôt que de redéfinir TLS
— tant que ce moteur n'est pas construit, les objectifs qui en dépendent
(§2.1.K « HTTPS générique », P7, et transitivement P9/P10 via QUIC)
restent bloqués en amont, cf. § 7 « Risques ». **QUIC (RFC 9000/9001/9002)**
est couvert par le PRD frère `docs/PRD-QUIC.md`, dont ce document consomme
le transport pour HTTP/3 (§2.1.F) sans en redéfinir la conception (cf. § 0.1).

Ce PRD **couvre aussi la migration** de deux des trois consommateurs HTTP
déjà en place (§ 2.1.M) :

- `src/network/http/{HttpTypes.ts,HttpClient.ts}` — le PDU JSON-sur-TCP qui
  sert le rôle IIS (`WindowsIisRole.ts`, `PRD-Windows-Server.md` §5 P11) et
  les commandes `curl`/`wget`/`Invoke-WebRequest` ;
- `src/network/dns/transport/DnsHttpsTransport.ts` — sa propre implémentation
  ad hoc et minimaliste du framing texte HTTP/1.1, écrite spécifiquement pour
  DoH, incompatible avec le PDU JSON ci-dessus.

`src/network/dns/transport/DnsQuicTransport.ts` (DoQ) **n'est pas migré
ici** : DoQ (RFC 9250) encapsule DNS directement dans un stream QUIC, sans
aucune sémantique HTTP — sa migration est portée par `docs/PRD-QUIC.md`
§2.1.13 (cf. § 0.1).

Aucune ligne de code n'est écrite dans le cadre de ce document — il sert de
base à la planification et à la revue avant le premier commit TDD.

### 0.1 Chaîne de dépendances entre PRDs

```
PRD-TLS.md (RFC 8446)
   │  fondation, aucune dépendance vers QUIC ou HTTP
   │
   ├──▶ PRD-QUIC.md (RFC 9000/9001/9002)
   │       dépend de PRD-TLS.md pour RFC 9001 ; migre DnsQuicTransport.ts (DoQ)
   │
   └──▶ PRD-HTTP.md                                          ◄── VOUS ÊTES ICI
           dépend de PRD-TLS.md directement pour HTTPS (§2.1.K, P7)
           dépend de PRD-QUIC.md pour HTTP/3 (§2.1.F, P9/P10)
           migre WindowsIisRole/HttpClient/HttpFetch/Curl (§2.1.M, P12)
           migre DnsHttpsTransport.ts — DoH (§2.1.M, P13)
           NE migre PAS DnsQuicTransport.ts — DoQ (→ PRD-QUIC.md)
```

Ce PRD a donc **deux dépendances entrantes bloquantes**, chacune limitée à
un sous-ensemble de phases (§ 7) : le moteur TLS de `PRD-TLS.md` (P7, P9,
P10, et la partie HTTPS de P12/P13), et le moteur QUIC de `PRD-QUIC.md`
(P9, P10). Les phases P1 à P6, P8 (partie `h2c`) et la partie HTTP/1.1
en clair de P12 sont indépendantes des deux et peuvent être livrées sans
attendre. C'est le PRD terminal de la chaîne — aucun autre PRD de ce
groupe ne dépend de lui.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Constat |
|---|---|---|
| `src/network/http/HttpTypes.ts`, `HttpClient.ts` | PDU `HttpRequestPdu`/`HttpResponsePdu` sérialisé en JSON par-dessus `TcpStack` réel | Convention délibérée du projet (« PDU objets sur transport réel », comme SMB) — **aucun framing texte HTTP/1.1**, pas de HTTPS, pas de chunked, pas d'en-têtes conditionnels/cache/cookies/auth |
| `src/network/devices/windows/server/iis/WindowsIisRole.ts` | Rôle IIS (Windows Server PRD P11) | Port 80 uniquement, statut/en-têtes minimaux (`Server: Microsoft-IIS/10.0`, `Content-Type`), **pas de TLS/443** — `PRD-Windows-Server.md` §2.2 exclut explicitement « IIS avancé (…, HTTPS/TLS, …) » |
| `src/network/devices/linux/commands/net/HttpFetch.ts`, `Curl.ts` | `curl`/`wget` | `HttpFetch.ts` dialogue avec le PDU JSON ci-dessus ; `Curl.ts` ajoute une **heuristique de détection** (bannière non-TLS sur port 443 → message d'erreur OpenSSL) mais **ne négocie jamais de TLS réel** |
| `src/network/dns/transport/DnsHttpsTransport.ts` | DoH (DNS-over-HTTPS) | Implémente **à la main** un sous-ensemble de framing texte HTTP/1.1 (`POST /dns-query HTTP/1.1\r\n...`) par-dessus `SimulatedTls.ts` — fonctionnellement correct pour son usage, mais **incompatible et non réutilisable** par le reste du projet |
| `src/network/dns/transport/DnsQuicTransport.ts` | DoQ (DNS-over-QUIC) | Un datagramme UDP = un message applicatif chiffré par XOR (`SimulatedTls.ts`) ; **aucun format de paquet QUIC réel** (pas de connection ID, pas d'espaces de paquets Initial/Handshake/1-RTT, pas de contrôle de congestion) |
| `src/network/pki/*` | PKI (CA, vérification, CRL, OCSP) | Réel dans sa logique, réutilisable tel quel pour HTTPS |
| `docs/PRD-TLS.md` | Moteur TLS 1.3 générique | **PRD écrit, code pas encore implémenté** à la date de ce document — prérequis externe pour toute variante HTTPS/QUIC ci-dessous |
| `src/network/tcp/TcpStack.ts` | Pile TCP réelle | Suffisante pour porter HTTP/1.1 et HTTP/2 (multiplexés sur une seule connexion) |
| — | Émission/réception UDP brute (`UDPPacket`) | Déjà utilisée telle quelle par DNS/RADIUS pour construire des datagrammes UDP réels — base de transport suffisante pour QUIC (pas de classe `UdpStack` dédiée à ce jour, ce PRD n'en introduit pas non plus) |
| `src/network/core/WellKnownPorts.ts` | Registre de ports | `80`→http, `443`→https, `8080`→http-alt, `8443`→https-alt déjà déclarés |

### 1.2 Ce qui existe déjà et est réutilisable

- **`TcpStack`/`TcpSocket`** : fiable, ordonné, suffisant pour HTTP/1.1 et
  HTTP/2 sans aucune modification.
- **Le module PKI (`@/network/pki`)** : réutilisable tel quel pour HTTPS,
  exactement comme il l'est déjà pour IKE et EAP-TLS.
- **`simulatedDigest` et les primitives de hash déjà vérifiées** (MD5, SHA-1,
  SHA-256 — utilisées par RADIUS/MS-CHAPv2/DNSSEC) : directement réutilisables
  pour Digest auth (RFC 7616, MD5 et SHA-256) et pour le calcul de
  `Sec-WebSocket-Accept` (RFC 6455 §1.3, SHA-1 + GUID magique).
- **Le pattern « PDU objet sur transport réel » vs « framing texte réel »**
  coexiste déjà dans le projet (JSON PDU pour IIS/curl vs framing texte fait
  main pour DoH) — ce PRD tranche explicitement en faveur d'un **framing
  texte réel conforme RFC 9112** pour son propre moteur (§ 3), sans toucher
  aux deux implémentations existantes.
- **`EventBus`/`Scheduler`** : suffisants pour modéliser keep-alive, timeouts
  de cache, retransmission QUIC, sans nouvelle primitive d'infrastructure.
- **`PRD-TLS.md`** fournit déjà la conception complète du moteur TLS 1.3 dont
  ce PRD a besoin pour HTTPS/QUIC — pas de re-conception ici, seulement une
  dépendance déclarée.

### 1.3 Ce qui est non conforme ou manquant (gap analysis)

| # | Manque | RFC concernée | Sévérité |
|---|---|---|---|
| 1 | **Aucun modèle sémantique HTTP générique indépendant de la version** : ni dictionnaire de méthodes (sûres/idempotentes/cacheables), ni classes de status codes, ni logique de redirection (301/302/303/307/308 avec préservation de méthode/corps selon le code), ni négociation de contenu, ni en-têtes conditionnels | RFC 9110 | Bloquant |
| 2 | **Aucun framing HTTP/1.1 réel et réutilisable** : le PDU JSON (IIS/curl) n'a pas de request-line/header-fields/CRLF ; le framing texte de `DnsHttpsTransport.ts` est fait main, non partagé, sans chunked transfer-encoding, sans connexions persistantes réelles, sans détection d'incohérence Content-Length/Transfer-Encoding | RFC 9112 | Élevée |
| 3 | **Aucun cache HTTP** : pas de `Cache-Control`, pas d'`ETag`/`If-None-Match`, pas de `Last-Modified`/`If-Modified-Since`, pas de calcul de fraîcheur/âge, pas de revalidation | RFC 9111 | Élevée |
| 4 | **Aucun HTTP/2** : pas de framing binaire, pas de HPACK, pas de multiplexage de streams, pas de contrôle de flux, pas de négociation ALPN `h2` | RFC 9113, RFC 7541 | Élevée |
| 5 | **Aucun vrai QUIC** : `DnsQuicTransport.ts` est un stand-in très éloigné — pas de format de paquet, pas de connection ID, pas d'espaces de paquets, pas de recouvrement de pertes ni de contrôle de congestion | RFC 9000, RFC 9002 | Élevée |
| 6 | **Aucune intégration TLS 1.3 pour un transport de type QUIC** (clés dérivées par espace de paquets, Initial/Handshake/1-RTT) | RFC 9001 | Élevée |
| 7 | **Aucun HTTP/3** : ni mapping des sémantiques 9110 sur des streams QUIC, ni QPACK, ni streams de contrôle unidirectionnels | RFC 9114, RFC 9204 | Élevée |
| 8 | **Aucun cookie** : ni `Set-Cookie`/`Cookie`, ni magasin de cookies par agent, ni algorithme de correspondance domaine/chemin, ni attributs `Secure`/`HttpOnly`/`SameSite` | RFC 6265 | Élevée |
| 9 | **Aucune authentification HTTP** : ni Basic (RFC 7617), ni Digest (RFC 7616) — le PDU `HttpRequestPdu` n'a même pas de champ `Authorization` | RFC 7617, RFC 7616 | Élevée |
| 10 | **Aucun WebSocket** : ni handshake d'upgrade, ni framing binaire, ni masquage, ni opcodes | RFC 6455 | Élevée |
| 11 | **Aucune HTTPS générique** : `Curl.ts` ne fait qu'une détection heuristique d'échec, jamais de négociation TLS réelle ; `WindowsIisRole` n'écoute jamais sur 443 ; pas de HSTS, pas de redirection HTTP→HTTPS | — (dépend de RFC 8446) | Moyenne |
| 12 | **Fragmentation architecturale préexistante** : deux implémentations HTTP non alignées coexistent déjà (PDU JSON vs framing texte ad hoc de DoH) — à ne **pas** unifier dans ce chantier (cf. § 2.2), mais à documenter comme risque de confusion pour un futur chantier de convergence | — | Faible |

**Conclusion de la phase d'analyse** : le projet ne dispose d'**aucun moteur
HTTP générique** — seulement deux stands-in incompatibles construits pour des
besoins ponctuels (IIS minimal, DoH). Aucune des dix RFC visées par
l'utilisateur n'a de véritable implémentation aujourd'hui. Ce PRD part donc
d'une page blanche, avec une seule dépendance externe bloquante pour son
volet chiffré : le moteur TLS de `PRD-TLS.md`, pas encore implémenté.

---

## 2. Objectifs

### 2.1 Objectifs du protocole (ce PRD)

**A. RFC 9110 — Sémantique HTTP générique.** Un modèle `HttpMessage`
(méthode, cible, en-têtes en multimap ordonnée, corps) indépendant de la
version de transport. Dictionnaire de méthodes (`GET`, `HEAD`, `POST`, `PUT`,
`DELETE`, `CONNECT`, `OPTIONS`, `TRACE`, `PATCH`) avec leurs propriétés
(sûre/idempotente/cacheable). Dictionnaire de status codes par classe
(1xx–5xx) avec sémantique réelle : redirections (301/302/303/307/308, chacune
avec la bonne règle de préservation de méthode/corps), authentification
(401/407 avec challenge), conditionnels (304/412/416). En-têtes conditionnels
(`If-Match`, `If-None-Match`, `If-Modified-Since`, `If-Unmodified-Since`,
`If-Range`) et `Range`/`Content-Range` simple (une seule plage). Négociation
de contenu (`Accept`, `Accept-Language`, `Accept-Encoding`) au niveau des
**noms négociés** (pas de compression réelle, cf. § 2.2).

**B. RFC 9112 — HTTP/1.1, framing réel.** Un nouveau module de framing texte
réel : request-line, header-fields terminés par CRLF, corps délimité par
`Content-Length` **ou** `Transfer-Encoding: chunked` (chunks + trailers
réels), connexions persistantes par défaut en 1.1 (`Connection: close`
explicite pour fermer), détection et rejet (400) d'un message présentant à la
fois `Content-Length` et `Transfer-Encoding` de façon incohérente (sensibilise
à la classe de vulnérabilité « request smuggling » sans prétendre la couvrir
exhaustivement). Ce module est **nouveau et indépendant** du PDU JSON
existant (§ 2.2 — pas de migration).

**C. RFC 9111 — Cache HTTP.** Un magasin de cache générique, clé
`méthode+URI(+Vary)`, exploitant `Cache-Control` (`no-store`, `no-cache`,
`max-age`, `s-maxage`, `private`/`public`, `must-revalidate`, `immutable`),
calcul de fraîcheur/âge (`Age`, `Date`, heuristique `Last-Modified`/10 %
en l'absence de directive explicite, §4.2.2), revalidation conditionnelle
(`ETag`/`If-None-Match` → 304, `Last-Modified`/`If-Modified-Since` → 304),
invalidation du cache sur méthode non sûre réussie.

**D. RFC 9113 + RFC 7541 — HTTP/2.** Framing binaire réel
(`Frame{length, type, flags, streamId, payload}` — `DATA`, `HEADERS`,
`PRIORITY`, `RST_STREAM`, `SETTINGS`, `PING`, `GOAWAY`, `WINDOW_UPDATE`,
`CONTINUATION`; pas de `PUSH_PROMISE`, cf. § 2.2), HPACK réel (table statique
RFC 7541 Annexe A + table dynamique, indexation/évincement conformes —
encodage littéral uniquement, pas de Huffman bit-exact, cf. § 2.2),
multiplexage réel de plusieurs streams sur une seule connexion TCP, contrôle
de flux par fenêtre (stream et connexion), négociation via ALPN `h2` (une
fois HTTPS disponible) ou upgrade `h2c` en clair pour les besoins de test,
priorisation simplifiée (dépendance simple stream-vers-stream, pas l'arbre de
poids complet de la RFC).

**E. RFC 9000/9001/9002 — QUIC (prérequis de HTTP/3).** Nouveau module
`src/network/quic/` : format de paquet réel simplifié (en-têtes long/court,
connection IDs, espaces de paquets Initial/Handshake/1-RTT), établissement de
connexion combiné au handshake TLS 1.3 du moteur `PRD-TLS.md` (dérivation de
clés par espace de paquets, RFC 9001), streams bidirectionnels et
unidirectionnels avec contrôle de flux, 0-RTT (réutilise le 0-RTT déjà
prévu par `PRD-TLS.md`), fermeture propre (`CONNECTION_CLOSE`). Recouvrement
de pertes et congestion (RFC 9002) : trames `ACK` par plages, détection de
perte par seuil temporel et par seuil de paquets, algorithme de congestion
simplifié type NewReno (pas de CUBIC/BBR réels, cf. § 2.2) — fidélité
protocolaire, pas fidélité de performance réseau réaliste.

**F. RFC 9114 + RFC 9204 — HTTP/3.** Mapping des sémantiques 9110 sur des
streams QUIC (un stream bidirectionnel par requête/réponse), QPACK simplifié
(table statique RFC 9204 Annexe A dans un premier temps ; table dynamique en
non-objectif possible, cf. § 2.2), streams de contrôle unidirectionnels et
trame `SETTINGS`.

**G. RFC 6265 — Cookies.** `Set-Cookie` avec attributs `Domain`, `Path`,
`Expires`, `Max-Age`, `Secure`, `HttpOnly`, `SameSite=Strict|Lax|None`.
Magasin de cookies par agent client (comme un vrai navigateur ou
`curl -c/-b`), algorithme de correspondance domaine/chemin conforme §5.1.3/
§5.1.4, envoi du bon sous-ensemble de cookies via `Cookie` sur les requêtes
suivantes, expiration effective.

**H. RFC 7617 — Authentification Basic.** Challenge
`WWW-Authenticate: Basic realm="..."` → 401, `Authorization: Basic
base64(user:pass)`, échec → 401 persistant, succès → accès.

**I. RFC 7616 — Authentification Digest.** Challenge avec `realm`, `nonce`,
`qop`, `opaque`, `algorithm` (MD5 **et** SHA-256, §6.1). Calcul client
HA1/HA2/response, `qop=auth` avec `cnonce`/`nc`, vérification serveur,
`Authentication-Info`/`nextnonce` en option.

**J. RFC 6455 — WebSocket.** Handshake d'upgrade HTTP/1.1 (`Upgrade:
websocket`, `Sec-WebSocket-Key`/`Sec-WebSocket-Accept` avec le GUID magique
et SHA-1, réutilisant les primitives déjà vérifiées du projet). Framing
binaire réel (bit `FIN`, opcode, bit `MASK`, longueur de payload étendue
126/127, masquage client obligatoire à 4 octets, démasquage serveur
systématique). Opcodes texte/binaire/close/ping/pong/continuation,
fragmentation de message, fermeture propre avec code de statut.

**K. HTTPS générique.** Port 443 pour HTTP/1.1 et HTTP/2 via le moteur TLS de
`PRD-TLS.md`, négociation ALPN (`http/1.1`, `h2`, et `h3` pour QUIC/UDP 443),
redirection HTTP→HTTPS optionnelle côté serveur, `Strict-Transport-Security`
reconnu et mémorisé côté client (pas de liste de préchargement globale, cf.
§ 2.2).

**L. Observabilité.** Événements bus dédiés (`http.request.started/
completed/failed`, `http.cache.hit/miss/revalidated`, `websocket.opened/
closed`, `http2.stream.opened/closed`, `quic.connection.established/closed`)
exploitables par les logs réseau et les tests, à l'image du reste du projet.

**M. Migration des consommateurs existants.** Une fois le noyau sémantique
et l'adaptateur HTTP/1.1 stabilisés (P1/P2), `WindowsIisRole.ts` et
`HttpClient.ts`/`HttpFetch.ts`/`Curl.ts` basculent sur le vrai framing
texte RFC 9112 du nouveau moteur à la place du PDU JSON — port 80 en clair
inchangé (le rôle IIS reste hors HTTPS, cf. `PRD-Windows-Server.md` §2.2,
que ce PRD ne redéfinit pas) ; l'heuristique de détection de `Curl.ts`
(bannière non-TLS sur 443) est remplacée par une vraie tentative de
négociation TLS une fois P7 disponible, contre tout serveur qui parle
réellement HTTPS via ce moteur. `DnsHttpsTransport.ts` (DoH) bascule sur
l'adaptateur HTTP/1.1 + HTTPS de ce même moteur (P7) à la place de son
framing texte fait main. `DnsQuicTransport.ts` (DoQ) n'est **pas** migré
ici (§ 0.1 — porté par `docs/PRD-QUIC.md`).

### 2.2 Non-objectifs (explicitement hors périmètre)

- **Compression de contenu réelle** (gzip/deflate/br) — les noms d'encodage
  sont négociés (`Accept-Encoding`/`Content-Encoding`) mais le corps n'est
  jamais réellement compressé/décompressé octet-à-octet, cohérent avec la
  convention du projet de simuler les couches coûteuses à fidélité bit-exacte.
- **Huffman HPACK/QPACK bit-exact** (RFC 7541 Annexe B, RFC 9204 Annexe A
  pour le codage) — encodage littéral uniquement dans un premier temps ; la
  table statique et la logique d'indexation/évincement dynamique restent
  réelles et testées.
- **Table dynamique QPACK** — potentiellement différée à une phase
  ultérieure si la complexité (streams encoder/decoder dédiés, RFC 9204 §4.3)
  s'avère disproportionnée ; la table statique seule couvre déjà la majorité
  des scénarios pédagogiques visés.
- **Contrôle de congestion réel** (CUBIC RFC 8312, BBR) — un NewReno
  simplifié suffit à couvrir RFC 9002 du point de vue protocolaire.
- **`PUSH_PROMISE` HTTP/2** — déjà déprécié en pratique (retiré des
  navigateurs majeurs), non implémenté.
- **WebTransport, HTTP/3 Datagrams (RFC 9297), Extended CONNECT (RFC 8441)**
  — hors périmètre ; WebSocket reste sur upgrade HTTP/1.1 classique dans
  cette phase.
- **Authentification NTLM/Negotiate/Kerberos HTTP (RFC 4559)** — seuls
  Basic et Digest sont demandés et couverts.
- **Cache partagé multi-utilisateurs distribué** (proxy de cache dédié,
  `Vary` multi-dimensionnel complexe) — seul un cache local par agent est
  visé, avec un modèle `Vary` simple (correspondance exacte des en-têtes
  listés).
- **Modèle multi-origine complet façon navigateur** (CORS, Origin/Referer,
  isolation de site) pour `SameSite` — un modèle simplifié suffisant pour
  tester l'attribut (contexte « même site » vs « site tiers » déclaré
  explicitement par le test) est visé, pas un moteur de sécurité de
  navigateur complet.
- **Tout ce que `PRD-TLS.md` §2.2 exclut déjà** (cryptographie réelle, ECH,
  compression de certificats, Export Keying Material, etc.) — hérité tel
  quel puisque ce PRD consomme ce moteur sans le redéfinir.
- **RadSec (RFC 6614)**, déjà noté hors périmètre par `PRD-RADIUS.md` — sans
  rapport direct mais rappelé pour éviter toute confusion sur le périmètre
  TLS partagé.

---

## 3. Architecture cible

### 3.1 Principe directeur

**Sémantique d'abord, transport ensuite, migration en dernier.** Un noyau
RFC 9110 indépendant de la version de transport, avec un adaptateur de
framing par version (texte 1.1, binaire+HPACK pour 2, QUIC+QPACK pour 3), et
des couches transverses (cache, cookies, authentification) qui n'opèrent que
sur le modèle sémantique commun — jamais directement sur le fil. TLS 1.3
(`PRD-TLS.md`) et QUIC (`PRD-QUIC.md`) sont des dépendances de transport, pas
des préoccupations du noyau sémantique. Les phases P1 à P11 (§ 5) démarrent
**greenfield** : aucun fichier existant n'est modifié pendant leur
construction. La phase P12/P13 migre ensuite `WindowsIisRole.ts`/
`HttpClient.ts`/`HttpFetch.ts`/`Curl.ts` et `DnsHttpsTransport.ts` sur ce
moteur — contrairement à une simple « convergence éventuelle », cette
migration fait partie du périmètre livré par ce PRD (§ 2.1.M).

### 3.2 Diagramme de couches

```
┌──────────────────────────────────────────────────────────────────────┐
│ Migrés par ce PRD (§ 2.1.M, P12/P13) :                                │
│   WindowsIisRole.ts · HttpClient.ts/HttpFetch.ts/Curl.ts (P12)        │
│   DnsHttpsTransport.ts — DoH (P13)                                    │
├──────────────────────────────────────────────────────────────────────┤
│ Migré par un PRD frère (§ 0.1) : DnsQuicTransport.ts — DoQ →          │
│   docs/PRD-QUIC.md §2.1.13                                            │
├──────────────────────────────────────────────────────────────────────┤
│ Middlewares transverses : Cache (9111) · Cookies (6265) ·             │
│   Auth Basic/Digest (7617/7616) — n'opèrent que sur HttpMessage       │
├──────────────────────────────────────────────────────────────────────┤
│ Noyau sémantique : HttpMessage, méthodes, status codes,               │
│   conditionnels, négociation de contenu (RFC 9110)                    │
├──────────────────────────────────────────────────────────────────────┤
│ Adaptateurs de version :                                              │
│   HTTP/1.1 (9112, texte)  │  HTTP/2 (9113, binaire+HPACK)  │ HTTP/3   │
│                            │                                │ (9114,  │
│                            │                                │ QPACK)  │
│   WebSocket (6455, upgrade sur 1.1)                                   │
├──────────────────────────────────────────────────────────────────────┤
│ Transport :                                                           │
│   TcpStack/TcpSocket (existant, 1.1 clair/TLS, 2 clair/TLS)           │
│   src/network/quic/ (nouveau, RFC 9000/9001/9002 — 3)                 │
│   src/network/tls/ (PRD-TLS.md, prérequis externe — HTTPS, 9001)      │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.3 Modules proposés (arborescence)

```
src/network/http/                    # existant : HttpTypes.ts/HttpClient.ts migrés en P12 (§2.1.M)
├── semantics/
│   ├── types.ts                     # NOUVEAU — HttpMessage, en-têtes multimap ordonnée
│   ├── methods.ts                   # NOUVEAU — dictionnaire méthodes (sûre/idempotente/cacheable)
│   ├── statusCodes.ts               # NOUVEAU — classes 1xx–5xx, redirections, sémantique
│   ├── conditionalRequests.ts       # NOUVEAU — If-Match/If-None-Match/If-Modified-Since/If-Range
│   └── contentNegotiation.ts        # NOUVEAU — Accept*/Accept-Encoding (noms négociés)
├── http1/
│   ├── Http1Wire.ts                 # NOUVEAU — RFC 9112 : request-line/header-fields/chunked
│   ├── Http1ClientSession.ts        # NOUVEAU
│   └── Http1ServerSession.ts        # NOUVEAU
├── cache/
│   ├── HttpCacheStore.ts            # NOUVEAU — RFC 9111 : clé, fraîcheur/âge, revalidation
│   └── CacheControl.ts              # NOUVEAU — parsing des directives
├── cookies/
│   ├── CookieJar.ts                 # NOUVEAU — RFC 6265 : magasin, matching domaine/chemin
│   └── SetCookie.ts                 # NOUVEAU — parsing/sérialisation Set-Cookie/Cookie
├── auth/
│   ├── BasicAuth.ts                 # NOUVEAU — RFC 7617
│   └── DigestAuth.ts                # NOUVEAU — RFC 7616 (MD5 + SHA-256)
├── websocket/
│   ├── WebSocketHandshake.ts        # NOUVEAU — RFC 6455 §1.3 (Sec-WebSocket-Accept)
│   ├── WebSocketFrame.ts            # NOUVEAU — framing binaire, masquage, opcodes
│   └── WebSocketConnection.ts       # NOUVEAU — API évènementielle (send/onMessage/onClose/ping)
├── http2/
│   ├── Http2Frame.ts                # NOUVEAU — RFC 9113 framing binaire
│   ├── Hpack.ts                     # NOUVEAU — RFC 7541 (table statique + dynamique)
│   ├── Http2Stream.ts               # NOUVEAU — multiplexage, contrôle de flux
│   └── Http2Connection.ts           # NOUVEAU
├── http3/
│   ├── Http3Frame.ts                # NOUVEAU — RFC 9114 mapping sur streams QUIC
│   ├── Qpack.ts                     # NOUVEAU — RFC 9204 (table statique d'abord)
│   └── Http3Connection.ts           # NOUVEAU — s'appuie sur src/network/quic/
├── events.ts                        # NOUVEAU
└── observables.ts                   # NOUVEAU

src/network/quic/                    # NOUVEAU — indépendant de HTTP, réutilisable ailleurs
├── types.ts                         # en-têtes long/court, connection IDs, espaces de paquets
├── PacketProtection.ts              # RFC 9001 — intégration avec src/network/tls/
├── LossRecovery.ts                  # RFC 9002 — ACK ranges, détection de perte
├── CongestionControl.ts             # NewReno simplifié
├── QuicStream.ts                    # streams bi/unidirectionnels, contrôle de flux
├── QuicConnection.ts                # établissement combiné handshake + 0-RTT
├── events.ts
└── observables.ts
```

### 3.4 Design patterns retenus

- **Noyau sémantique agnostique du transport** : `semantics/types.ts` ne
  connaît ni TCP, ni QUIC, ni TLS — testable isolément (redirections, cache,
  négociation) sans aucun réseau simulé.
- **Adaptateurs de version symétriques** : `http1/`, `http2/`, `http3/`
  exposent tous la même interface `HttpTransportSession { send(HttpMessage),
  onMessage(cb) }` — les middlewares (cache/cookies/auth) sont écrits une
  seule fois contre cette interface commune.
- **QUIC indépendant de HTTP** : `src/network/quic/` ne connaît pas HTTP —
  c'est un transport générique (comme `TcpStack`), qui pourrait en théorie
  porter autre chose que HTTP/3 (à l'image de la relation TCP/HTTP1-2
  existante). Cohérent avec la convention CLAUDE.md de protocoles en
  répertoires top-level indépendants.
- **Réutilisation stricte de PKI/TLS** : `PacketProtection.ts` et le futur
  adaptateur HTTPS de `http1/`/`http2/` importent `src/network/tls/`
  (une fois construit) sans dupliquer la moindre primitive cryptographique.
- **Additif d'abord (P1–P11), migration en un point de bascule net
  (P12/P13)** : pendant P1–P11, `HttpTypes.ts`, `HttpClient.ts`,
  `DnsHttpsTransport.ts` ne sont ni importés ni modifiés — zéro risque de
  régression sur IIS/curl/DoH déjà verts. En P12/P13, la migration
  remplace l'**implémentation interne** de ces fichiers par des appels au
  nouveau moteur, sans changer les signatures publiques consommées ailleurs
  (`dialHttp`/`fetchHttp`, l'API de `WindowsIisRole`) — `DnsQuicTransport.ts`
  n'est jamais touché par ce PRD (§ 0.1).
- **Masquage WebSocket appliqué à la lettre** : même si la cryptographie
  environnante est simulée ailleurs dans le projet, le masquage RFC 6455
  §5.3 est une opération de correction protocolaire bon marché (XOR avec une
  clé de 4 octets) — implémenté exactement comme la RFC le prescrit, sans
  simplification.

---

## 4. Modèle de données

### 4.1 Message HTTP générique (RFC 9110)

```
HttpMessage {
  kind: 'request' | 'response'
  method?: HttpMethod           // si kind === 'request'
  target?: string                // origin-form / absolute-form
  statusCode?: number             // si kind === 'response'
  reasonPhrase?: string
  headers: OrderedMultimap<string, string>
  body: Uint8Array | null
  httpVersion: '1.1' | '2' | '3'
}
HttpMethod = 'GET'|'HEAD'|'POST'|'PUT'|'DELETE'|'CONNECT'|'OPTIONS'|'TRACE'|'PATCH'
MethodProperties { safe: boolean; idempotent: boolean; cacheableByDefault: boolean }
```

### 4.2 Entrée de cache (RFC 9111)

```
CacheEntry {
  key: { method: string; uri: string; varyHeaders: Record<string,string> }
  response: HttpMessage
  storedAt: number
  freshnessLifetime: number       // secondes, dérivé de Cache-Control/Expires/heuristique
  etag?: string
  lastModified?: string
  mustRevalidate: boolean
}
```

### 4.3 Cookie (RFC 6265)

```
Cookie {
  name: string; value: string
  domain: string; path: string
  expires?: number; maxAge?: number
  secure: boolean; httpOnly: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
  hostOnly: boolean
}
```

### 4.4 Challenge d'authentification (RFC 7617/7616)

```
BasicChallenge { scheme: 'Basic'; realm: string }
DigestChallenge {
  scheme: 'Digest'; realm: string; nonce: string; opaque?: string
  qop: 'auth'; algorithm: 'MD5' | 'SHA-256'
}
DigestCredentials { username: string; realm: string; nonce: string; uri: string
                    response: string; cnonce: string; nc: string; qop: 'auth' }
```

### 4.5 Trame WebSocket (RFC 6455 §5.2)

```
WebSocketFrame {
  fin: boolean
  opcode: 'continuation'|'text'|'binary'|'close'|'ping'|'pong'
  masked: boolean
  maskingKey?: [number, number, number, number]
  payload: Uint8Array
}
```

### 4.6 Trame HTTP/2 (RFC 9113 §4) et paquet QUIC (RFC 9000 §17)

```
Http2Frame { length: number; type: number; flags: number; streamId: number; payload: Uint8Array }
QuicPacket {
  form: 'long' | 'short'
  type?: 'initial' | 'handshake' | '0-rtt' | 'retry'   // si long header
  version?: number
  destConnectionId: string; srcConnectionId?: string
  packetNumber: number
  payload: Uint8Array   // trames QUIC chiffrées selon l'espace de paquets
}
```

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — Sémantique HTTP (9110)** | `semantics/` : types, méthodes, status codes, redirections, conditionnels, négociation de contenu — testable sans aucun réseau | — |
| **P2 — HTTP/1.1 en clair (9112)** | `http1/` : framing texte réel, chunked, connexions persistantes, détection d'incohérence Content-Length/Transfer-Encoding — sur `TcpStack` existant, port dédié aux tests (pas 80/443, pour ne pas interférer avec IIS/curl) | P1 |
| **P3 — Cache (9111)** | `cache/` : magasin, fraîcheur/âge, revalidation conditionnelle — testé en HTTP/1.1 clair | P1, P2 |
| **P4 — Cookies (6265)** | `cookies/` : `CookieJar`, matching domaine/chemin, attributs | P2 |
| **P5 — Authentification (7617/7616)** | `auth/` : Basic puis Digest (MD5 et SHA-256) | P2 |
| **P6 — WebSocket (6455)** | `websocket/` : handshake d'upgrade sur P2, framing, opcodes, fragmentation, fermeture | P2 |
| **P7 — HTTPS (dépend de `PRD-TLS.md`)** | Adaptateur HTTP/1.1 par-dessus `TlsClientSession`/`TlsServerSession`, ALPN `http/1.1`, HSTS, redirection HTTP→HTTPS | P2, **moteur TLS de `PRD-TLS.md` implémenté** |
| **P8 — HTTP/2 (9113 + HPACK)** | `http2/` : framing binaire, HPACK (table statique + dynamique, littéral), multiplexage, contrôle de flux ; upgrade `h2c` en clair pour les tests, ALPN `h2` une fois P7 disponible | P1, P7 (pour ALPN — `h2c` peut être testé sans) |
| **P9 — QUIC (9000/9001/9002)** | `src/network/quic/` : format de paquet, espaces de paquets, intégration TLS 1.3 (RFC 9001), recouvrement de pertes + congestion NewReno (RFC 9002) | **moteur TLS de `PRD-TLS.md` implémenté** |
| **P10 — HTTP/3 (9114 + QPACK)** | `http3/` : mapping des sémantiques sur streams QUIC, QPACK (table statique) | P1, P9 |
| **P11 — Observabilité** | `events.ts`/`observables.ts` transverses à toutes les phases précédentes | P2–P10 |
| **P12 — Migration IIS/curl/wget (§ 2.1.M)** | `WindowsIisRole.ts` et `HttpClient.ts`/`HttpFetch.ts` basculent sur `http1/` (RFC 9112 réel) à la place du PDU JSON, port 80 inchangé ; `Curl.ts` remplace son heuristique de détection HTTPS par une vraie tentative TLS (P7) | P2, P7 |
| **P13 — Migration DoH (§ 2.1.M)** | `DnsHttpsTransport.ts` bascule sur l'adaptateur HTTP/1.1 + HTTPS de ce moteur à la place de son framing texte fait main | P7 |

Chaque phase suit le cycle rouge → vert → refactor. Pendant P1–P11, ce
module reste strictement additif (§ 3.4) : aucune suite existante
(`http-*`, `windows-iis-*`, `dns-encrypted-transports`) n'est censée
changer. **P12/P13 changent délibérément ce principe** pour les seules
suites IIS/curl/DoH : leur comportement observable (codes de statut, corps,
en-têtes, résolution DNS-over-HTTPS correcte) doit rester identique, mais
la représentation interne du PDU change (§ 7).

---

## 6. Stratégie de test

1. **Unitaires sémantique** : dictionnaire de méthodes/status codes,
   redirections (vérifier la préservation ou non du corps/méthode selon le
   code), en-têtes conditionnels (matrice de cas 304/412/416).
2. **Unitaires framing 1.1** : round-trip encode/décode, chunked avec
   trailers, détection d'un message Content-Length + Transfer-Encoding
   incohérent → 400, connexions persistantes réutilisées sur plusieurs
   requêtes.
3. **Unitaires cache** : fraîcheur calculée correctement (`max-age`,
   heuristique `Last-Modified`), `304` sur revalidation réussie, invalidation
   après `POST`/`PUT`/`DELETE` réussi sur la même ressource.
4. **Unitaires cookies** : matching domaine (sous-domaines, `Domain`
   explicite vs implicite → `hostOnly`), matching chemin, expiration,
   non-envoi d'un cookie `Secure` sur une requête en clair, non-envoi d'un
   cookie `SameSite=Strict` dans un contexte déclaré « site tiers ».
5. **Unitaires authentification** : Basic (encodage/décodage base64, échec
   sur mauvais mot de passe), Digest (vecteurs de test RFC 7616 Annexe (MD5
   et SHA-256), rejeu détecté via `nc` déjà vu).
6. **Unitaires WebSocket** : handshake (`Sec-WebSocket-Accept` vérifié contre
   un vecteur de test connu de la RFC), framing (masquage/démasquage,
   fragmentation d'un message texte en plusieurs frames `continuation`,
   fermeture avec code de statut).
7. **Unitaires HTTP/2** : round-trip HPACK (table statique + dynamique,
   évincement quand la table dépasse sa taille annoncée), multiplexage de
   plusieurs streams sur une connexion, contrôle de flux (fenêtre épuisée →
   `DATA` bloqué jusqu'à `WINDOW_UPDATE`).
8. **Unitaires QUIC** : format de paquet par espace, recouvrement de pertes
   (paquet perdu détecté par seuil temporel, retransmis), fenêtre de
   congestion qui se réduit après perte.
9. **Intégration HTTPS/HTTP/2/HTTP/3** : handshake TLS réussi puis requête/
   réponse complète, sur une topologie câblée simple, une fois P7/P9
   disponibles.
10. **Non-régression (P1–P11)** : exécution complète des suites
    HTTP/IIS/DoH/DoQ existantes après chaque phase, garantissant l'absence
    d'effet de bord tant que P12/P13 ne sont pas atteintes.
11. **Migration (P12/P13)** : suites `windows-iis-role`, `windows-server-iis`
    et le sous-ensemble DoH de `dns-encrypted-transports` ré-exécutées après
    bascule sur le nouveau moteur — vérifier que les comportements
    observables (codes de statut, corps, en-têtes, `Server:
    Microsoft-IIS/10.0`, résolution DNS-over-HTTPS correcte) sont
    **identiques** à l'avant-migration.

---

## 7. Risques et points d'attention

1. **Dépendance bloquante sur `PRD-TLS.md` et `PRD-QUIC.md`** : les phases
   P7 (HTTPS) et la partie HTTPS de P12 ne peuvent démarrer que si le moteur
   TLS 1.3 décrit par `PRD-TLS.md` est implémenté ; P9/P10 (QUIC/HTTP/3) ne
   peuvent démarrer que si `PRD-QUIC.md` est implémenté (qui dépend lui-même
   de `PRD-TLS.md`, cf. § 0.1). Les phases P1 à P6, P8 (partie `h2c`), P11
   et la partie HTTP/1.1 en clair de P12 sont **indépendantes** et peuvent
   être livrées sans attendre — l'ordre du tableau § 5 reflète cette
   contrainte, pas un ordre de priorité pédagogique.
2. **Ampleur du chantier** : c'est le PRD le plus large du dépôt à ce jour
   (dix RFC). Refuser tout ajout non listé en § 2.1 sans mise à jour
   explicite de ce document ; ne pas laisser une phase déborder sur la
   suivante avant d'être verte.
3. **Fragmentation architecturale déjà existante** (§1.3 #12) : ce PRD ajoute
   une **troisième** implémentation HTTP (après le PDU JSON et le framing ad
   hoc de DoH) — c'est un choix assumé (aucune des deux existantes n'est
   assez générale pour porter cache/cookies/auth/WebSocket/HTTP2/3), mais
   cela ne doit pas être vécu comme une régression pendant P1–P11 : les
   trois coexistent sciemment jusqu'à P12/P13, qui éliminent la
   fragmentation en migrant IIS/curl/DoH vers ce moteur unique (DoQ
   excepté, cf. § 0.1).
4. **Coordination avec `PRD-Windows-Server.md`** : la migration P12 ne
   doit **pas** élargir silencieusement le périmètre du rôle IIS —
   `WindowsIisRole.ts` continue de n'écouter que sur le port 80 (pas de
   443/HTTPS pour IIS), conformément à `PRD-Windows-Server.md` §2.2 qui
   exclut « IIS avancé (…, HTTPS/TLS, …) ». Seule la représentation interne
   du framing change ; toute extension de scope IIS relève de l'autre PRD.
5. **Tests IIS existants et représentation interne** : les tests
   `windows-iis-role`/`windows-server-iis` actuels valident des
   comportements observables (codes de statut, corps, en-têtes) plutôt que
   la structure interne du PDU — ils devraient passer sans modification si
   P12 préserve exactement ces comportements ; toute divergence doit être
   corrigée avant de considérer P12 terminée, pas contournée en modifiant
   les assertions de test.
6. **HPACK/QPACK simplifiés** : documenter clairement que seul l'encodage
   littéral est fidèle bit-à-bit ; toute inférence de compression réelle
   (taille de trame observée) ne doit pas être testée comme si le Huffman
   était implémenté.
7. **Digest RFC 7616 §6.1** : la RFC autorise plusieurs algorithmes
   (`MD5`, `MD5-sess`, `SHA-256`, `SHA-256-sess`) — n'implémenter que `MD5`
   et `SHA-256` (sans les variantes `-sess`) est un choix de portée à
   documenter explicitement dans le code et les tests.
8. **Masquage WebSocket = point de correction, pas de simulation** :
   contrairement au reste de la crypto simulée du projet, le masquage
   RFC 6455 est peu coûteux et doit être bit-exact — à ne pas simplifier par
   erreur d'analogie avec `SimulatedTls.ts`.
9. **QUIC sur UDP brut** : ce projet n'a pas de classe `UdpStack` dédiée
   (contrairement à `TcpStack`) — `src/network/quic/` (`PRD-QUIC.md`) devra
   construire ses propres `UDPPacket` comme le font déjà DNS/RADIUS, sans
   introduire de nouvelle abstraction de transport générique non demandée.
10. **Contrôle de congestion simplifié** : documenter que le NewReno simulé
    (`PRD-QUIC.md`) ne vise qu'à exercer le protocole (fenêtre qui
    grandit/rétrécit selon les événements RFC 9002), pas à reproduire un
    comportement de performance réseau réaliste ou comparable à une vraie
    pile QUIC.

---

## 8. Critères d'acceptation

1. Une requête/réponse HTTP/1.1 complète (chunked, connexion persistante
   réutilisée pour une deuxième requête) round-trip correctement sur
   `TcpStack`.
2. Une ressource servie avec `Cache-Control: max-age=60` puis redemandée
   avant expiration est servie **depuis le cache**, sans nouvelle requête
   réseau ; redemandée après expiration avec un `ETag` valide reçoit un
   `304` et le cache est rafraîchi sans transfert de corps.
3. Un cookie `Set-Cookie: session=abc; Path=/app; HttpOnly` n'est renvoyé que
   sur les requêtes vers `/app*` et n'apparaît jamais dans une API cliente
   accessible « côté script » (propriété testée structurellement).
4. Un scénario Digest complet (challenge → calcul HA1/HA2 → `qop=auth` avec
   `cnonce`/`nc` → vérification serveur) aboutit à un `200`, et un `nc`
   déjà utilisé est rejeté.
5. Un handshake WebSocket réussi (`Sec-WebSocket-Accept` correct) est suivi
   d'un échange de plusieurs frames texte/binaire, y compris un message
   fragmenté sur 3 frames `continuation`, et se termine par un `close`
   propre avec code de statut échangé dans les deux sens.
6. Un scénario HTTP/2 multiplexe au moins deux streams concurrents sur une
   seule connexion TCP, avec contrôle de flux observable (une fenêtre
   épuisée bloque `DATA` jusqu'à réception d'un `WINDOW_UPDATE`).
7. Une fois `PRD-TLS.md` implémenté : un handshake HTTPS complet (ALPN
   négocie `h2` ou `http/1.1`) aboutit à une requête/réponse chiffrée de
   bout en bout, avec échec propre (alerte TLS) si le certificat serveur
   n'est pas approuvé.
8. Une fois QUIC implémenté : une connexion QUIC établit ses clés Initial et
   1-RTT dans les bons espaces de paquets, une perte de paquet simulée est
   détectée et retransmise, et une requête HTTP/3 complète (au moins un
   stream de requête/réponse + un stream de contrôle) aboutit avec succès.
9. Pendant P1–P11, toutes les suites existantes (`windows-iis-role`,
   `windows-server-iis`, `dns-encrypted-transports`, `eaptls-*`,
   `peap-ttls-handshake`, `dot1x-radius-eaptls`, `dot1x-radius-peap-ttls`)
   passent **sans aucune modification**, confirmant que le module reste
   strictement additif jusqu'à P12/P13.
10. Après P12 : `curl http://srv1.lab.local/` et `Invoke-WebRequest` depuis
    un client vers un `WindowsIisRole` utilisent réellement le framing
    RFC 9112 (vérifiable par un import direct dans le code), avec le même
    résultat observable qu'avant migration (200, corps, en-têtes) ; `curl
    https://...` contre un serveur qui parle réellement HTTPS via ce moteur
    négocie un vrai handshake TLS au lieu de son ancienne heuristique.
11. Après P13 : `DnsHttpsTransport.ts` utilise réellement l'adaptateur
    HTTP/1.1 + HTTPS de ce moteur ; les résolutions DoH restent correctes.

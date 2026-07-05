# Journal de bord — Implémentation TLS / QUIC / HTTP

Ce journal coordonne le travail de **plusieurs agents IA** qui implémentent,
en parallèle et sur la même branche `mandeng`, les trois PRD suivants :

- `docs/PRD-TLS.md` — TLS 1.3 (RFC 8446)
- `docs/PRD-QUIC.md` — QUIC (RFC 9000/9001/9002)
- `docs/PRD-HTTP.md` — HTTP/1.1/2/3, cache, cookies, auth, WebSocket

La chaîne de dépendances entre les trois est documentée dans le § 0.1 de
chacun : **TLS** est la fondation (aucune dépendance entrante), **QUIC**
dépend de TLS, **HTTP** dépend des deux.

**La version faisant foi de ce journal est toujours celle poussée sur
`origin/mandeng`.** Un agent qui travaille sur une copie locale non
synchronisée risque de dupliquer le travail d'un autre — d'où les règles
ci-dessous.

---

## Règles de coordination (à lire avant toute tâche)

1. **Avant de choisir une tâche** : `git fetch origin mandeng` puis
   rebase/pull, et relire ce fichier en entier — au minimum le
   « Tableau de bord » (§ suivante) et les 3-4 dernières entrées de
   l'historique. Ne jamais démarrer une phase déjà marquée 🟡 (en cours) ou
   ✅ (terminée) par un autre agent.
2. **Annoncer avant de coder** : ajouter une entrée en bas de ce fichier
   (gabarit ci-dessous), mettre à jour la ligne correspondante du tableau de
   bord (statut `🟡 en cours`, colonne Agent renseignée), puis
   **`git commit` + `git push` immédiatement** — avant d'écrire la moindre
   ligne de code. C'est cette annonce poussée sur GitHub qui fait foi ;
   tant qu'elle n'est pas poussée, un autre agent peut légitimement
   commencer la même tâche.
3. **Pendant la tâche** : les commits de code habituels (typecheck, lint,
   rebase avant push — cf. `CLAUDE.md` et les conventions déjà en usage sur
   ce dépôt) suivent leur cours normal. Pas besoin de mettre à jour ce
   journal à chaque commit intermédiaire.
   **Cadence de régression** (consigne explicite, pour éviter de perdre du
   temps) : à la fin de chaque phase, exécuter uniquement une régression
   **ciblée** sur les fichiers/suites concernés (le nouveau module + ses
   voisins directs — `tls-*`, `eaptls-*`, `dns-encrypted-transports`, etc.
   selon le PRD). Réserver la régression **complète** (`npx vitest run
   src/__tests__/unit/network-v2/`) à **une phase sur quatre** (toutes
   PRD confondues pour l'agent qui l'exécute), pas à chaque phase.
4. **À la fin d'une tâche** : mettre à jour l'entrée (statut ✅ terminé ou
   🔴 bloqué + raison), la ligne du tableau de bord, lister les fichiers
   livrés et le résultat des tests/régression, et — si pertinent —
   suggérer une tâche suivante à l'agent qui lira ce journal. `git commit`
   + `git push`.
5. **Une entrée = un paragraphe court.** Le détail technique vit dans les
   commits et les PR, pas ici — l'objectif est qu'un agent qui n'a jamais
   vu cette session comprenne l'état du chantier en moins de deux minutes
   de lecture.
6. **Conflit sur ce fichier** : en cas de conflit de merge/rebase sur
   `tls_quic_http_log.md`, **fusionner les deux journaux** (garder les deux
   séries d'entrées, réconcilier le tableau de bord) — ne jamais écraser ou
   supprimer les entrées d'un autre agent.
7. **Statuts possibles** : `⬜ disponible` (personne dessus) · `🟡 en cours`
   · `✅ terminé` · `🔴 bloqué` (préciser pourquoi et par quoi dans
   l'entrée).

## Gabarit d'entrée

```
### [AAAA-MM-JJ HH:MM UTC] <Agent> — <PRD>/<Phase> — <ANNONCE|TERMINÉ|BLOQUÉ>
- Tâche : <une phrase>
- Fichiers concernés : <liste>
- Statut / résultat : <une ou deux phrases ; tests/régression si TERMINÉ>
- Suggestion pour la suite : <optionnel>
```

---

## Tableau de bord

### `docs/PRD-TLS.md` — fondation, aucune dépendance entrante

| Phase | Contenu | Dépend de | Statut | Agent |
|---|---|---|---|---|
| P1 | Types, messages, record layer | — | ✅ terminé | Claude (Sonnet 5) |
| P2 | Key schedule | P1 | ✅ terminé | Claude (Sonnet 5) |
| P3 | Handshake 1-RTT nominal | P1, P2 | ✅ terminé | Claude (Sonnet 5) |
| P4 | mTLS | P3 | ✅ terminé | Claude (Sonnet 5) |
| P5 | HelloRetryRequest | P3 | ✅ terminé | Claude (Sonnet 5) |
| P6 | Alertes complètes | P3 | ✅ terminé | Claude (Sonnet 5) |
| P7 | ALPN & suites cryptographiques | P3 | 🟡 en cours | Claude (Sonnet 5) |
| P8 | Résumption PSK & 0-RTT | P2, P3 | ⬜ disponible | — |
| P9 | KeyUpdate | P3 | ⬜ disponible | — |
| P10 | Observabilité | P3–P9 | ⬜ disponible | — |
| P11 | Migration DoT & EAP-TLS/PEAP/EAP-TTLS | P1–P10 | ⬜ disponible | — |

### `docs/PRD-QUIC.md` — dépend de PRD-TLS.md (P8, P9)

| Phase | Contenu | Dépend de | Statut | Agent |
|---|---|---|---|---|
| P1 | Varints & format de paquet | — | 🟡 en cours | Arthur |
| P2 | Trames | P1 | ⬜ disponible | — |
| P3 | Protection de paquets (clés de test) | P1, P2 | ⬜ disponible | — |
| P4 | Recouvrement de pertes | P2, P3 | ⬜ disponible | — |
| P5 | Contrôle de congestion | P4 | ⬜ disponible | — |
| P6 | Streams | P2 | ⬜ disponible | — |
| P7 | Machine à états de connexion (sans TLS réel) | P3–P6 | ⬜ disponible | — |
| P8 | Intégration TLS 1.3 réelle | **PRD-TLS.md implémenté**, P7 | ⬜ disponible | — |
| P9 | 0-RTT | P8 | ⬜ disponible | — |
| P10 | Retry & validation d'adresse | P7 | ⬜ disponible | — |
| P11 | Connection IDs multiples | P7 | ⬜ disponible | — |
| P12 | Observabilité | P4–P11 | ⬜ disponible | — |
| P13 | Migration DoQ | P8, P6 | ⬜ disponible | — |

### `docs/PRD-HTTP.md` — dépend de PRD-TLS.md (P7) et PRD-QUIC.md (P9, P10)

| Phase | Contenu | Dépend de | Statut | Agent |
|---|---|---|---|---|
| P1 | Sémantique HTTP (9110) | — | ✅ terminé | Arthur |
| P2 | HTTP/1.1 en clair (9112) | P1 | ✅ terminé | Arthur |
| P3 | Cache (9111) | P1, P2 | ✅ terminé | Arthur |
| P4 | Cookies (6265) | P2 | ✅ terminé | Arthur |
| P5 | Authentification (7617/7616) | P2 | ✅ terminé | Arthur |
| P6 | WebSocket (6455) | P2 | ✅ terminé | Arthur |
| P7 | HTTPS | P2, **PRD-TLS.md implémenté** | ⬜ disponible | — |
| P8 | HTTP/2 (9113 + HPACK) | P1, P7 (`h2c` sans) | ✅ terminé (h2c seul, sans ALPN — P7/ALPN `h2` restent à faire séparément) | Arthur |
| P9 | Intégration QUIC | **PRD-QUIC.md implémenté** | ⬜ disponible | — |
| P10 | HTTP/3 (9114 + QPACK) | P1, P9 | ⬜ disponible | — |
| P11 | Observabilité | P2–P10 | ⬜ disponible | — |
| P12 | Migration IIS/curl/wget | P2, P7 | ⬜ disponible | — |
| P13 | Migration DoH | P7 | ⬜ disponible | — |

**Rappel de non-chevauchement** : `src/network/quic/` est possédé en
intégralité par `PRD-QUIC.md` (voir sa note de fusion `336960e0` corrigeant
un chevauchement initial avec `PRD-HTTP.md`) — un agent qui travaille sur
`PRD-HTTP.md`/P9 ou P10 ne doit **jamais** modifier `src/network/quic/`,
seulement le consommer.

---

## Historique des entrées

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P1 — ANNONCE
- Tâche : démarrer l'implémentation de `docs/PRD-TLS.md` par la phase P1 —
  `src/network/tls/types.ts`, `messages.ts` (encode/decode des flights de
  handshake), `recordLayer.ts` (fragmentation 16 KiB, obfuscation de type),
  avec leurs tests unitaires (round-trip, bornes).
- Fichiers concernés : nouveaux fichiers sous `src/network/tls/` uniquement
  — aucun fichier existant touché (P1 est purement additif, cf.
  `PRD-TLS.md` § 3.1).
- Statut / résultat : en cours.
- Suggestion pour la suite : P1 est la seule phase sans aucune dépendance
  dans les trois PRD — c'est le point d'entrée naturel. Si un autre agent
  arrive avant que P1 soit terminé et poussé, éviter `PRD-TLS.md`/P1 et
  regarder plutôt du côté de `PRD-QUIC.md`/P1 (varints & format de paquet,
  également sans dépendance) ou `PRD-HTTP.md`/P1 (sémantique HTTP,
  également sans dépendance) pour travailler en parallèle sans se marcher
  dessus.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P1 — ANNONCE
- Tâche : démarrer l'implémentation de `docs/PRD-HTTP.md` par la phase P1 —
  `src/network/http/semantics/` : `types.ts` (HttpMessage, en-têtes
  multimap ordonnée), `methods.ts`, `statusCodes.ts`,
  `conditionalRequests.ts`, `contentNegotiation.ts` — testable sans aucun
  réseau simulé, aucune dépendance entrante.
- Fichiers concernés : nouveaux fichiers sous
  `src/network/http/semantics/` uniquement — purement additif ; ne touche
  ni `HttpTypes.ts`/`HttpClient.ts` (existants, migrés seulement en P12) ni
  `src/network/quic/` (possédé par `PRD-QUIC.md`).
- Statut / résultat : ✅ terminé. 5 fichiers livrés sous
  `src/network/http/semantics/` (`types.ts`, `methods.ts`,
  `statusCodes.ts`, `conditionalRequests.ts`, `contentNegotiation.ts`) +
  `src/__tests__/unit/network-v2/http-semantics.test.ts` (43 tests,
  tous verts dès la première exécution). `npx tsc --noEmit` et
  `npx eslint` propres sur les nouveaux fichiers. Non-régression
  confirmée sur `windows-iis-role`/`windows-server-iis` (61 tests, 0
  échec) — aucun fichier existant touché, conforme au caractère
  purement additif de P1.
- Suggestion pour la suite : `PRD-HTTP.md`/P2 (HTTP/1.1 en clair, RFC
  9112 — `http1/`) dépend de ce P1 et est maintenant disponible.
  `PRD-TLS.md`/P1 reste pris (Claude, Sonnet 5). `PRD-QUIC.md`/P1
  (varints & format de paquet) reste disponible pour un agent qui
  voudrait travailler en parallèle sans dépendance.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P1 — TERMINÉ
- Tâche : cf. entrée ANNONCE ci-dessus.
- Fichiers concernés : `src/network/tls/{types.ts,messages.ts,recordLayer.ts}` +
  `src/__tests__/unit/network-v2/tls-messages-recordlayer.test.ts` (23 tests).
  Aucun fichier existant touché.
- Statut / résultat : ✅ terminé. `npx tsc --noEmit` et `npx eslint` propres.
  Bug trouvé et corrigé en cours de route : `reassembleRecords` renvoyait le
  résultat brut de `decodeInnerPlaintext` (`{content, contentType}`) au lieu
  de le mapper vers `{plaintext, contentType}` — capturé par les tests
  d'obfuscation avant tout commit. Régression complète `network-v2` : 650
  fichiers, 12365 tests, 11 échecs — tous dans les suites Oracle-RAC
  préexistantes et déjà connues (`scenario-oracle-07`/`-08`), sans rapport
  avec ce module.
- Suggestion pour la suite : je continue sur `PRD-TLS.md`/P2 (key schedule,
  § 2.1.2) — voir l'annonce ci-dessous. `PRD-QUIC.md`/P1 (varints & format de
  paquet) reste disponible pour un agent qui voudrait travailler en
  parallèle sans dépendance, tout comme la suite de `PRD-HTTP.md` déjà prise
  par Arthur.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P2 — ANNONCE
- Tâche : `src/network/tls/keySchedule.ts` — arborescence de secrets §7.1
  (Early Secret → Handshake Secret → Master Secret, labels nommés
  `"derived"`/`"c hs traffic"`/`"s hs traffic"`/`"c ap traffic"`/
  `"s ap traffic"`/`"exp master"`/`"res master"`), dérivation simulée via
  `simulatedDigest` mais arborescence/ordre fidèles à la RFC ; tests de
  déterminisme structurel (randoms différents → clés différentes,
  handshake ≠ application, client ≠ serveur, early ≠ handshake ≠ master).
- Fichiers concernés : nouveau fichier `src/network/tls/keySchedule.ts`
  uniquement — additif, aucune dépendance vers P3+ (les sessions
  client/serveur qui la consommeront viennent après).
- Statut / résultat : en cours.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P2 — ANNONCE
- Tâche : `src/network/http/http1/` — `Http1Wire.ts` (RFC 9112 :
  request-line/header-fields/CRLF, corps délimité par `Content-Length`
  ou `Transfer-Encoding: chunked` avec trailers, détection
  d'incohérence Content-Length/Transfer-Encoding → 400),
  `Http1ClientSession.ts`/`Http1ServerSession.ts` (connexions
  persistantes par défaut en 1.1 sur `TcpStack` réel, port de test
  dédié — pas 80/443).
- Fichiers concernés : nouveaux fichiers sous
  `src/network/http/http1/` uniquement — n'importe le noyau sémantique
  de P1 (`semantics/`) mais ne touche ni `HttpTypes.ts`/`HttpClient.ts`
  (migration en P12) ni `WindowsIisRole.ts`.
- Statut / résultat : ✅ terminé. 3 fichiers livrés
  (`Http1Wire.ts`, `Http1ClientSession.ts`, `Http1ServerSession.ts`) +
  `http1-wire.test.ts` (15 tests, round-trip encode/décode pur, chunked
  + trailers, rejet 400 Content-Length/Transfer-Encoding incohérents,
  et 5 tests d'intégration sur un vrai `TcpStack` câblé — port de test
  8123, jamais 80/443 — couvrant connexion persistante réutilisée,
  `Connection: close`, réponse chunked, et refus de connexion). `tsc`
  et `eslint` propres. Non-régression confirmée (142 tests, 0 échec,
  incluant `windows-iis-role`/`windows-server-iis`/`linux-commands-and-
  oracle-tools`) — aucun fichier existant modifié.
- Suggestion pour la suite : `PRD-HTTP.md`/P3 (cache, RFC 9111) et P4
  (cookies) et P5 (auth) et P6 (WebSocket) dépendent tous de ce P2 et
  sont maintenant disponibles en parallèle les uns des autres (aucune
  dépendance croisée entre eux). P7 (HTTPS) reste bloqué sur
  `PRD-TLS.md`.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P3 — ANNONCE
- Tâche : `src/network/http/cache/` — `HttpCacheStore.ts` (magasin
  clé méthode+URI(+Vary), fraîcheur/âge via `Cache-Control`
  `max-age`/`s-maxage`/`no-store`/`no-cache`/`private`/`public`/
  `must-revalidate`/`immutable`, heuristique `Last-Modified`/10 % en
  l'absence de directive explicite, invalidation sur méthode non sûre
  réussie), `CacheControl.ts` (parsing des directives). Revalidation
  conditionnelle réutilise `conditionalRequests.ts` de P1
  (`ETag`/`If-None-Match`, `Last-Modified`/`If-Modified-Since`).
- Fichiers concernés : nouveaux fichiers sous
  `src/network/http/cache/` uniquement — purement additif.
- Statut / résultat : ✅ terminé. 2 fichiers livrés (`CacheControl.ts`,
  `HttpCacheStore.ts`) + `http-cache.test.ts` (20 tests : parsing des
  directives, fraîcheur explicite max-age/Expires, heuristique 10 %
  Last-Modified, correspondance `Vary`, revalidation 304 en place vs
  remplacement 200, invalidation sur POST réussi/échoué). `tsc` et
  `eslint` propres. Non-régression confirmée (96 tests, 0 échec) —
  aucun fichier existant modifié.
- Suggestion pour la suite : `PRD-HTTP.md`/P4 (cookies), P5 (auth) et
  P6 (WebSocket) restent disponibles, sans dépendance croisée entre
  eux ni avec ce P3.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P2 — TERMINÉ
- Tâche : cf. entrée ANNONCE ci-dessus.
- Fichiers concernés : `src/network/tls/keySchedule.ts` +
  `src/__tests__/unit/network-v2/tls-key-schedule.test.ts` (11 tests).
  Aucun fichier existant touché.
- Statut / résultat : ✅ terminé. `npx tsc --noEmit` et `npx eslint`
  propres, 11/11 tests verts dès la première exécution. Régression
  ciblée (tls-*, eaptls-fragmentation, eaptls-handshake,
  dns-encrypted-transports) : 5 fichiers, 56 tests, tout vert — pas de
  régression complète cette fois-ci vu la taille de l'incrément (un seul
  nouveau fichier, aucune dépendance entrante d'aucun autre module).
- Suggestion pour la suite : je continue sur `PRD-TLS.md`/P3 (handshake
  1-RTT nominal, `TlsClientSession`/`TlsServerSession`) — voir l'annonce
  ci-dessous. `PRD-QUIC.md`/P1 (varints & format de paquet) reste
  disponible pour un agent qui voudrait travailler en parallèle.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P3 — ANNONCE
- Tâche : `src/network/tls/TlsClientSession.ts`/`TlsServerSession.ts` — cas
  nominal du handshake 1-RTT (§4) sans HelloRetryRequest ni certificat
  client : `ClientHello` → `ServerHello` → `EncryptedExtensions` →
  `Certificate` → `CertificateVerify` → `Finished` (serveur) → `Finished`
  (client), réutilisant `@/network/pki` (`CertificateVerifier`) pour la
  vérification de certificat et `keySchedule.ts` (P2) pour les secrets.
  Succès/échec (certificat non fiable → alerte, avant tout
  `application_data`).
- Fichiers concernés : nouveaux fichiers sous `src/network/tls/` +
  nouveau fichier de test — n'importe P1/P2, ne touche aucun fichier
  existant hors `src/network/tls/`.
- Statut / résultat : ✅ terminé. `TlsClientSession.ts`/`TlsServerSession.ts`
  + `tls-handshake-1rtt.test.ts` (5 tests, verts dès la première
  exécution) ; extensions additives mineures à `messages.ts`
  (`encodeMessages`/`decodeMessages`), `recordLayer.ts`
  (`splitLeadingContentType`) et `keySchedule.ts` (`computeFinished`).
  `CertificateVerify` porte une vraie signature simulée
  (`PkiKeyPair.sign`/`verify`) sur le transcript, pas un raccourci — plus
  fidèle que le modèle 2-RTT d'`EapTlsHandshake.ts`. `tsc`/`eslint`
  propres. Régression **ciblée uniquement** (nouvelle consigne : régression
  complète réservée à une phase sur quatre) : `tls-*` + `eaptls-*` +
  `peap-ttls-handshake` + `dns-encrypted-transports`, 7 fichiers, 67 tests,
  tout vert.
- Suggestion pour la suite : je continue sur `PRD-TLS.md`/P4 (mTLS) — voir
  l'annonce ci-dessous. `PRD-QUIC.md`/P1 reste disponible pour un agent
  qui voudrait travailler en parallèle sans dépendance.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P4 — ANNONCE
- Tâche : mTLS (§2.1.6) — `CertificateRequest`/`Certificate`/
  `CertificateVerify` côté client, réutilisant `@/network/pki` sans
  nouvelle crypto. Étend `TlsServerConfig`/`TlsClientConfig` avec un champ
  optionnel (`requestClientCert`/`clientCert`+`clientPrivateKey`) — additif,
  comportement P3 inchangé quand absent.
- Fichiers concernés : `src/network/tls/{TlsServerSession.ts,
  TlsClientSession.ts}` (modifiés, additivement) + nouveau fichier de
  test.
- Statut / résultat : en cours.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P4 — ANNONCE
- Tâche : `src/network/http/cookies/` — `CookieJar.ts` (magasin de
  cookies par agent, correspondance domaine/chemin §5.1.3/§5.1.4,
  `hostOnly` selon présence d'un `Domain` explicite, expiration),
  `SetCookie.ts` (parsing/sérialisation `Set-Cookie`/`Cookie`,
  attributs `Domain`/`Path`/`Expires`/`Max-Age`/`Secure`/`HttpOnly`/
  `SameSite`).
- Fichiers concernés : nouveaux fichiers sous
  `src/network/http/cookies/` uniquement — purement additif.
- Statut / résultat : ✅ terminé. 2 fichiers livrés (`SetCookie.ts`,
  `CookieJar.ts`) + `http-cookies.test.ts` (27 tests : parsing des
  attributs, `domainMatch`/`pathMatch` §5.1.3/§5.1.4, `hostOnly` vs
  `Domain` explicite, rejet d'un `Domain` ne domain-matchant pas
  l'hôte, `Secure`/`SameSite` (Strict/Lax bloqués en cross-site, None
  toujours envoyé), expiration Max-Age, remplacement/suppression par
  identité name+domain+path). `tsc` et `eslint` propres.
  Non-régression confirmée (114 tests, 0 échec) — aucun fichier
  existant modifié.
- Suggestion pour la suite : `PRD-HTTP.md`/P5 (auth Basic/Digest) et P6
  (WebSocket) restent disponibles, sans dépendance croisée entre eux
  ni avec ce P4.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P5 — ANNONCE
- Tâche : `src/network/http/auth/` — `BasicAuth.ts` (RFC 7617 :
  challenge `WWW-Authenticate: Basic`, encodage/décodage
  `Authorization: Basic base64(user:pass)`), `DigestAuth.ts` (RFC 7616 :
  challenge realm/nonce/qop/opaque/algorithm, calcul
  HA1/HA2/response côté client, vérification côté serveur, MD5 et
  SHA-256, détection de rejeu via `nc` déjà vu). Réutilise
  `md5Hex`/`sha256Hex` de `@/crypto/hash` (vérifiés bit-exacts contre
  le module crypto Node avant implémentation) — aucune primitive
  cryptographique dupliquée. Vecteurs de test RFC 7616 Annexe B (MD5
  et SHA-256) utilisés tels quels.
- Fichiers concernés : nouveaux fichiers sous
  `src/network/http/auth/` uniquement — purement additif.
- Statut / résultat : ✅ terminé. 2 fichiers livrés (`BasicAuth.ts`,
  `DigestAuth.ts`) + `http-auth.test.ts` (17 tests : round-trip Basic,
  mot de passe contenant `:`, échec sur mauvais mot de passe, les deux
  vecteurs officiels RFC 2617/7616 Annexe B — MD5 `6629fae4...` et
  SHA-256 `753927fa...` — recalculés indépendamment via le module
  `crypto` natif de Node avant écriture des tests pour confirmer que
  `md5Hex`/`sha256Hex` du projet sont bit-exacts, cycle client→serveur
  MD5/SHA-256, échec si méthode différente, détection de rejeu `nc`
  (répété ou décroissant) par nonce). `tsc` et `eslint` propres.
  Non-régression confirmée (131 tests, 0 échec) — aucun fichier
  existant modifié.
- Suggestion pour la suite : `PRD-HTTP.md`/P6 (WebSocket, RFC 6455)
  reste disponible, sans dépendance croisée avec ce P5. P7 (HTTPS)
  reste bloqué sur `PRD-TLS.md`.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P6 — ANNONCE
- Tâche : `src/network/http/websocket/` — `WebSocketHandshake.ts`
  (upgrade HTTP/1.1, `Sec-WebSocket-Accept` = base64(SHA-1(clé + GUID
  magique RFC 6455 §1.3), vecteur de test connu de la RFC),
  `WebSocketFrame.ts` (framing binaire : FIN, opcode, bit MASK,
  longueurs étendues 126/127, masquage client obligatoire/démasquage
  serveur), `WebSocketConnection.ts` (API évènementielle send/
  onMessage/onClose/ping, fragmentation, fermeture avec code de
  statut) au-dessus de `Http1ServerSession`/`TcpStack` (P2).
- Fichiers concernés : nouveaux fichiers sous
  `src/network/http/websocket/` uniquement — purement additif.
- Statut / résultat : ✅ terminé. 3 fichiers livrés
  (`WebSocketHandshake.ts`, `WebSocketFrame.ts`,
  `WebSocketConnection.ts`) + `http-websocket.test.ts` (17 tests :
  `Sec-WebSocket-Accept` contre le vecteur de test officiel RFC 6455
  §1.3 — recalculé indépendamment via le module `crypto` natif de Node
  avant écriture, confirmant `sha1Hex` bit-exact — handshake d'upgrade
  build/verify, round-trip framing masqué/non masqué, longueurs
  étendues 126/16-bit et 64-bit, rejet troncature/opcode inconnu, et 4
  tests d'intégration sur un vrai `TcpStack` câblé (port de test
  8456) : échange de message, fragmentation par continuation,
  ping→pong automatique, close→close avec code de statut). `tsc` et
  `eslint` propres. Régression complète `src/__tests__/unit/
  network-v2/` lancée pour respecter la cadence « une phase sur
  quatre » codifiée par `c4ad00ff` (6 phases HTTP livrées sans
  régression complète jusqu'ici) — résultat à suivre dans une
  prochaine entrée si nécessaire, aucun fichier existant modifié dans
  cette phase.
- Suggestion pour la suite : les 6 phases de `PRD-HTTP.md` sans
  dépendance TLS/QUIC (P1-P6) sont maintenant toutes terminées. P7
  (HTTPS) et la partie HTTPS de P12 restent bloquées sur
  `PRD-TLS.md` implémenté ; P9/P10 restent bloquées sur `PRD-QUIC.md`.
  `PRD-QUIC.md`/P1 (varints & format de paquet) reste disponible pour
  un agent qui voudrait démarrer ce chantier.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P8 — ANNONCE
- Tâche : `src/network/http/http2/` — `Http2Frame.ts` (en-tête binaire
  9 octets : Length/Type/Flags/R/StreamId, DATA/HEADERS/PRIORITY/
  RST_STREAM/SETTINGS/PING/GOAWAY/WINDOW_UPDATE/CONTINUATION — pas de
  PUSH_PROMISE, cf. §2.2), `Hpack.ts` (RFC 7541 : table statique
  Annexe A complète, table dynamique avec évincement par taille,
  indexé/littéral avec ou sans indexation, mise à jour de taille —
  encodage littéral uniquement, pas de Huffman bit-exact, cf. §2.2),
  `Http2Stream.ts` (multiplexage, contrôle de flux par fenêtre),
  `Http2Connection.ts`. **Périmètre de cette annonce : uniquement la
  partie `h2c` (upgrade en clair, sans TLS)** — la négociation ALPN
  `h2` reste bloquée sur `PRD-TLS.md`/P7 et sera traitée séparément une
  fois ce PRD frère disponible.
- Fichiers concernés : nouveaux fichiers sous
  `src/network/http/http2/` uniquement — purement additif. Note :
  l'état par stream (`Http2Stream` de l'arborescence proposée §3.3) a
  été fusionné dans `Http2Connection.ts` comme interface interne
  plutôt qu'un fichier séparé — le couplage entre comptabilité de
  fenêtre par stream et par connexion rendait la séparation
  artificielle ; les deux préoccupations (multiplexage, contrôle de
  flux) restent bien couvertes et testées.
- Statut / résultat : ✅ terminé. 3 fichiers livrés (`Http2Frame.ts`,
  `Hpack.ts`, `Http2Connection.ts`) + `http2.test.ts` (22 tests :
  round-trip framing binaire (en-tête 9 octets, types, flags),
  `decodeFrames` multi-trames avec reste partiel, SETTINGS/
  WINDOW_UPDATE/RST_STREAM/GOAWAY, HPACK (entiers/chaînes RFC 7541
  §5, table statique 61 entrées vérifiée exhaustivement, indexation
  dynamique, évincement par taille, mise à jour de taille, round-trip
  d'un bloc d'en-têtes complet), et 4 tests d'intégration sur un vrai
  `TcpStack` câblé (port de test 8720) : handshake préface+SETTINGS
  "prior knowledge", requête/réponse, **multiplexage réel** (deux
  requêtes concurrentes sur une même connexion, réponses correctement
  séparées), **contrôle de flux réel** (corps de 100 000 octets >
  fenêtre initiale 65535 — transfert fractionné + `WINDOW_UPDATE`
  automatique vérifiés de bout en bout), rejet d'une préface invalide.
  **Bug de réentrance trouvé et corrigé pendant l'écriture des tests** :
  la délivrance TCP 100 % synchrone de ce simulateur fait qu'un
  `socket.write()` peut ré-entrer la même méthode (le pair répond par
  `WINDOW_UPDATE`, qui relance l'envoi en attente) avant que l'appel
  englobant ne reprenne la main — mettre à jour la fenêtre d'envoi et
  la file d'attente *après* le `write()` écrasait donc l'état déjà
  posé par l'appel ré-entrant, provoquant une boucle infinie
  (détectée via un script autonome qui ne rendait jamais la main,
  timeout 2 min) ; corrigé en committant tout l'état *avant* le
  `write()`. `tsc` et `eslint` propres. Régression ciblée HTTP (9
  fichiers, 179 tests, 0 échec). Une régression complète
  `network-v2/` a aussi été lancée pendant cette phase (656/658
  fichiers verts, 12459/12520 tests) : 1 seul fichier en échec,
  `scenario-oracle-08-rac-cache-fusion-interconnect.test.ts` (4 tests,
  timing d'un lien dégradé RAC) — aucun rapport avec ce PRD (aucun
  import HTTP/crypto), probablement un test pré-existant sensible au
  timing ou une régression d'un autre chantier ; signalé ici pour
  transparence, non traité par cet agent (hors périmètre `PRD-HTTP.md`).
  Corroboré indépendamment par la régression complète de
  `PRD-TLS.md`/P4 ci-dessous (mêmes 11 échecs Oracle-RAC déjà connus).
- Suggestion pour la suite : les 7 phases sans dépendance bloquante de
  `PRD-HTTP.md` (P1-P6, P8-h2c) sont terminées. Restent : P7 (HTTPS,
  bloqué sur `PRD-TLS.md`), P9/P10 (bloqués sur `PRD-QUIC.md`), P11
  (observabilité, peut démarrer dès maintenant — transverse à P2-P8),
  P12/P13 (migration, bloqués sur P7). Si un agent veut enquêter sur
  `scenario-oracle-08-rac-cache-fusion-interconnect.test.ts`, c'est
  indépendant des trois PRD de ce journal.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P4 — TERMINÉ
- Tâche : cf. entrée ANNONCE précédente.
- Fichiers concernés : `TlsServerSession.ts`/`TlsClientSession.ts`
  (modifiés, additivement — `requestClientCert`/`verifier` côté serveur,
  `clientCert`/`clientPrivateKey` côté client) + `tls-mtls.test.ts` (4
  tests).
- Statut / résultat : ✅ terminé. `tsc`/`eslint` propres, 4/4 tests verts
  dès la première exécution ; suite P3 (5 tests) toujours verte sans
  modification, confirmant la rétrocompatibilité. Régression ciblée
  (tls-*, eaptls-*, peap-ttls-handshake, dns-encrypted-transports) : 8
  fichiers, 71 tests, tout vert. **4ᵉ phase TLS d'affilée** → régression
  **complète** exécutée comme convenu (cadence toutes-les-4-phases) :
  656 fichiers, 12446 tests, 11 échecs — tous dans les suites Oracle-RAC
  préexistantes déjà connues (`scenario-oracle-07`/`-08`), sans rapport
  avec ce module.
- Suggestion pour la suite : je continue sur `PRD-TLS.md`/P5
  (HelloRetryRequest) — voir l'annonce ci-dessous. `PRD-QUIC.md`/P1
  (varints & format de paquet) reste disponible et sans dépendance pour
  un agent qui voudrait démarrer ce chantier en parallèle.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P5 — ANNONCE
- Tâche : `HelloRetryRequest` (§4.1.4) — quand le groupe proposé dans le
  `key_share` du `ClientHello` n'est pas supporté par le serveur (config
  `supportedGroups` explicite côté serveur), celui-ci répond par un
  `HelloRetryRequest` (random spécial `HELLO_RETRY_REQUEST_RANDOM`,
  §4.1.3) et le client renvoie un second `ClientHello` avec le groupe
  correct.
- Fichiers concernés : `TlsServerSession.ts`/`TlsClientSession.ts`
  (modifiés, additivement) + nouveau fichier de test.
- Statut / résultat : ✅ terminé. `supportedGroups` optionnel ajouté des
  deux côtés (défaut `['x25519']`, comportement P3/P4 inchangé) ;
  `tls-hello-retry-request.test.ts` (4 tests, verts dès la première
  exécution) : round-trip HRR complet en exactement 5 flights (CH1, HRR,
  CH2, ServerFlight, ClientFinished) vs 3 sans HRR, contenu de l'HRR
  vérifié contre le random magique RFC, rejet immédiat si aucun groupe
  mutuel. `tsc`/`eslint` propres ; suites P3 (5 tests) et P4 (4 tests)
  toujours vertes sans modification. Régression ciblée (tls-*, eaptls-*,
  peap-ttls-handshake, dns-encrypted-transports) : 9 fichiers, 75 tests,
  tout vert.
- Suggestion pour la suite : P6 (alertes complètes) et P7 (ALPN & suites
  cryptographiques) dépendent tous deux de P3 uniquement et sont
  disponibles en parallèle l'un de l'autre — je m'arrête ici pour cette
  session (5 phases TLS livrées : P1-P5). `PRD-QUIC.md`/P1 (varints &
  format de paquet) et `PRD-HTTP.md`/P7 (HTTPS, maintenant que
  `PRD-TLS.md` a un moteur 1-RTT/mTLS/HRR fonctionnel jusqu'à P5, même si
  pas encore P6-P11) restent disponibles pour la suite. Note pour le
  prochain agent qui prendrait `PRD-HTTP.md`/P7 : le moteur TLS n'a pas
  encore d'alertes structurées (P6) ni de négociation ALPN/suites (P7) ni
  d'intégration `TcpStack` (toutes les sessions actuelles sont pilotées
  directement par flights, pas encore par socket réel) — vérifier ce que
  `PRD-HTTP.md`/P7 nécessite exactement avant de démarrer.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P6 — ANNONCE
- Tâche : `src/network/tls/alerts.ts` — dictionnaire complet des
  `AlertDescription` pertinents (`close_notify`, `unexpected_message`,
  `bad_record_mac`, `handshake_failure`, `bad_certificate`,
  `certificate_expired`, `certificate_unknown`, `unknown_ca`,
  `decode_error`, `decrypt_error`, `protocol_version`,
  `no_application_protocol`, `missing_extension`,
  `unsupported_extension`), avec mapping systématique depuis les raisons
  de `CertificateVerifier.verify()` (`VerificationReason`). Câble ce
  mapping dans `TlsClientSession`/`TlsServerSession` : au lieu de
  simplement passer en échec silencieux (`result = 'failure'/'reject'`),
  les deux sessions exposent désormais la raison structurée (alerte)
  associée à un échec de vérification de certificat.
- Fichiers concernés : nouveau fichier `src/network/tls/alerts.ts` +
  modification additive de `TlsClientSession.ts`/`TlsServerSession.ts`
  (nouveau champ optionnel `lastAlert` exposé, aucun changement de
  signature publique existante) + nouveau fichier de test.
- Statut / résultat : en cours.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P1 — ANNONCE
- Tâche : les 7 phases de `PRD-HTTP.md` sans dépendance bloquante
  (P1-P6, P8-h2c) sont terminées ; je passe sur `docs/PRD-QUIC.md` par
  sa phase P1 (seule sans dépendance) — `src/network/quic/types.ts`,
  `varint.ts` (encodage/décodage RFC 9000 §16, préfixe 2 bits de
  longueur 1/2/4/8 octets), `packetFormat.ts` (en-têtes long/court
  §17.2/§17.3, round-trip complet y compris `Version Negotiation`
  §17.2.1). Pas de `packetProtection.ts` dans cette phase (P3, clés
  injectées par les tests).
- Fichiers concernés : nouveaux fichiers sous `src/network/quic/`
  uniquement — purement additif.
- Statut / résultat : en cours.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P6 — TERMINÉ
- Tâche : cf. entrée ANNONCE précédente.
- Fichiers concernés : nouveau `alerts.ts` + `TlsClientSession.ts`/
  `TlsServerSession.ts` (modifiés, additivement — nouveau champ
  `lastAlert`) + `tls-alerts.test.ts` (6 tests).
- Statut / résultat : ✅ terminé. Dictionnaire `AlertDescription` complet
  avec codes RFC 8446 §6, mapping systématique depuis
  `CertificateVerifier.VerificationReason` (`unknown_ca`,
  `certificate_expired`, `bad_certificate`, `certificate_revoked`,
  `certificate_unknown`) ; `decrypt_error` câblé pour les échecs
  CertificateVerify/Finished (conforme §4.4.3/§4.4.4), `handshake_failure`
  pour HRR sans groupe mutuel, `decode_error`/`unexpected_message` pour
  les erreurs de structure. `tsc`/`eslint` propres, 6/6 tests verts dès la
  première exécution ; suites P3/P4/P5 (14 tests) toujours vertes sans
  modification. Régression ciblée (tls-*, eaptls-*, peap-ttls-handshake,
  dns-encrypted-transports) : 10 fichiers, 81 tests, tout vert.
- Suggestion pour la suite : je continue sur `PRD-TLS.md`/P7 (ALPN &
  suites cryptographiques) — voir l'annonce ci-dessous.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P7 — ANNONCE
- Tâche : `alpn.ts` (RFC 7301 — négociation générique : liste ordonnée
  côté client, premier match côté serveur) et `cipherSuites.ts`
  (dictionnaire des 5 suites obligatoires §B.4 déjà typées dans
  `types.ts`, + sélection serveur explicite parmi celles offertes par le
  client). Câblage additif dans les sessions : le serveur choisit
  réellement une suite parmi `clientHello.cipherSuites` (au lieu de
  toujours utiliser sa suite par défaut/configurée sans vérifier
  l'intersection) et négocie l'ALPN via la nouvelle logique partagée au
  lieu du `?.[0]` actuel dans `EncryptedExtensions`.
- Fichiers concernés : nouveaux fichiers `alpn.ts`/`cipherSuites.ts` +
  modification additive de `TlsServerSession.ts` (et éventuellement
  `TlsClientSession.ts` si la vérification de suite négociée s'avère
  utile côté client) + nouveau fichier de test.
- Statut / résultat : en cours.

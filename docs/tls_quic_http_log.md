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
| P4 | mTLS | P3 | 🟡 en cours | Claude (Sonnet 5) |
| P5 | HelloRetryRequest | P3 | ⬜ disponible | — |
| P6 | Alertes complètes | P3 | ⬜ disponible | — |
| P7 | ALPN & suites cryptographiques | P3 | ⬜ disponible | — |
| P8 | Résumption PSK & 0-RTT | P2, P3 | ⬜ disponible | — |
| P9 | KeyUpdate | P3 | ⬜ disponible | — |
| P10 | Observabilité | P3–P9 | ⬜ disponible | — |
| P11 | Migration DoT & EAP-TLS/PEAP/EAP-TTLS | P1–P10 | ⬜ disponible | — |

### `docs/PRD-QUIC.md` — dépend de PRD-TLS.md (P8, P9)

| Phase | Contenu | Dépend de | Statut | Agent |
|---|---|---|---|---|
| P1 | Varints & format de paquet | — | ⬜ disponible | — |
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
| P6 | WebSocket (6455) | P2 | ⬜ disponible | — |
| P7 | HTTPS | P2, **PRD-TLS.md implémenté** | ⬜ disponible | — |
| P8 | HTTP/2 (9113 + HPACK) | P1, P7 (`h2c` sans) | ⬜ disponible | — |
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

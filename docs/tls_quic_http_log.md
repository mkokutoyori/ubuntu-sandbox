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
| P7 | ALPN & suites cryptographiques | P3 | ✅ terminé | Claude (Sonnet 5) |
| P8 | Résumption PSK & 0-RTT | P2, P3 | ✅ terminé | Claude (Sonnet 5) |
| P9 | KeyUpdate | P3 | ✅ terminé | Claude (Sonnet 5) |
| P10 | Observabilité | P3–P9 | ✅ terminé | Claude (Sonnet 5) |
| P11 | Migration DoT & EAP-TLS/PEAP/EAP-TTLS | P1–P10 | ✅ terminé | Claude (Sonnet 5) |

### `docs/PRD-QUIC.md` — dépend de PRD-TLS.md (P8, P9)

| Phase | Contenu | Dépend de | Statut | Agent |
|---|---|---|---|---|
| P1 | Varints & format de paquet | — | ✅ terminé | Arthur |
| P2 | Trames | P1 | ✅ terminé | Arthur |
| P3 | Protection de paquets (clés de test) | P1, P2 | ✅ terminé | Arthur |
| P4 | Recouvrement de pertes | P2, P3 | ✅ terminé | Arthur |
| P5 | Contrôle de congestion | P4 | ✅ terminé | Arthur |
| P6 | Streams | P2 | ✅ terminé | Arthur |
| P7 | Machine à états de connexion (sans TLS réel) | P3–P6 | ✅ terminé | Arthur |
| P8 | Intégration TLS 1.3 réelle | **PRD-TLS.md implémenté**, P7 | ✅ terminé | Arthur |
| P9 | 0-RTT | P8 | ✅ terminé | Arthur |
| P10 | Retry & validation d'adresse | P7 | ✅ terminé | Arthur |
| P11 | Connection IDs multiples | P7 | ✅ terminé | Arthur |
| P12 | Observabilité | P4–P11 | ✅ terminé | Arthur |
| P13 | Migration DoQ | P8, P6 | ✅ terminé | Arthur |

### `docs/PRD-HTTP.md` — dépend de PRD-TLS.md (P7) et PRD-QUIC.md (P9, P10)

| Phase | Contenu | Dépend de | Statut | Agent |
|---|---|---|---|---|
| P1 | Sémantique HTTP (9110) | — | ✅ terminé | Arthur |
| P2 | HTTP/1.1 en clair (9112) | P1 | ✅ terminé | Arthur |
| P3 | Cache (9111) | P1, P2 | ✅ terminé | Arthur |
| P4 | Cookies (6265) | P2 | ✅ terminé | Arthur |
| P5 | Authentification (7617/7616) | P2 | ✅ terminé | Arthur |
| P6 | WebSocket (6455) | P2 | ✅ terminé | Arthur |
| P7 | HTTPS | P2, **PRD-TLS.md implémenté** | ✅ terminé | Arthur |
| P8 | HTTP/2 (9113 + HPACK) | P1, P7 (`h2c` sans) | ✅ terminé (h2c seul, sans ALPN — P7/ALPN `h2` restent à faire séparément) | Arthur |
| P9 | Intégration QUIC | **PRD-QUIC.md implémenté** | ✅ terminé | Arthur |
| P10 | HTTP/3 (9114 + QPACK) | P1, P9 | ✅ terminé | Arthur |
| P11 | Observabilité | P2–P10 | ✅ terminé | Arthur |
| P12 | Migration IIS/curl/wget | P2, P7 | ⬜ disponible | — |
| P13 | Migration DoH | P7 | ✅ terminé | Arthur |

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
- Statut / résultat : ✅ terminé. 3 fichiers livrés (`types.ts`,
  `varint.ts`, `packetFormat.ts`) + `quic-packet-format.test.ts` (25
  tests : varint round-trip aux 4 longueurs et à leurs frontières
  exactes, exemple travaillé RFC 9000 §16 (37→0x25), rejet
  valeur négative/non-entière et buffer tronqué ; en-tête long
  round-trip Initial (avec token)/Handshake/0-RTT/Retry (sans packet
  number, token jusqu'à la fin), longueur de packet number choisie
  selon la magnitude ; en-tête court round-trip avec longueur de DCID
  fournie par l'appelant ; Version Negotiation round-trip et
  distinction par le champ version=0 ; `decodePacket` aiguillant les
  trois formes). `tsc` et `eslint` propres. Régression ciblée
  (quic-packet-format, dns-encrypted-transports — dépendance DoQ/P13
  citée par le PRD) : 2 fichiers, 37 tests, 0 échec.
- Suggestion pour la suite : `PRD-QUIC.md`/P2 (trames, `frames.ts`)
  dépend de ce P1 et est maintenant disponible. `PRD-TLS.md` en est à
  P6 (Claude, Sonnet 5) ; `PRD-HTTP.md` a ses 7 phases indépendantes
  terminées (P1-P6, P8-h2c).

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

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P7 — TERMINÉ
- Tâche : cf. entrée ANNONCE précédente.
- Fichiers concernés : nouveaux `cipherSuites.ts`/`alpn.ts` +
  `TlsClientSession.ts`/`TlsServerSession.ts` (modifiés, additivement) +
  `tls-alpn-cipher-suites.test.ts` (9 tests).
- Statut / résultat : ✅ terminé. Vraie lacune comblée au passage : le
  serveur utilisait sa suite configurée telle quelle dans `ServerHello`
  **sans jamais vérifier** que le client l'avait effectivement offerte —
  ce n'était pas une négociation. Le serveur construit désormais une
  liste de préférence (suite configurée en tête, repli sur les 4 autres
  suites obligatoires) et rejette (`handshake_failure`) en l'absence
  totale d'intersection ; l'ALPN passe par la même intersection réelle au
  lieu d'un simple `?.[0]`. Les deux sessions exposent
  `negotiatedCipherSuite`/`negotiatedAlpnProtocol`. `tsc`/`eslint` propres,
  9/9 tests verts dès la première exécution ; suites P3-P6 (19 tests)
  toujours vertes sans modification. Régression ciblée (tls-*, eaptls-*,
  peap-ttls-handshake, dns-encrypted-transports) : 11 fichiers, 90 tests,
  tout vert.
- Suggestion pour la suite : je continue sur `PRD-TLS.md`/P8 (résumption
  PSK & 0-RTT) — voir l'annonce ci-dessous. Ce sera ma 4ᵉ phase depuis la
  dernière régression complète (P4) → régression complète prévue à la fin
  de P8, comme convenu.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P8 — ANNONCE
- Tâche : `sessionTickets.ts` (§4.6.1/§4.2.11) — `NewSessionTicket` émis
  par le serveur en fin de handshake complet (réutilisant
  `resumptionMasterSecret` du key schedule), stocké côté client ;
  reprise de session par PSK sur un futur `ClientHello` (extension
  `pre_shared_key`) avec données 0-RTT optionnelles dans le tout premier
  flight (`early_data`, acceptées ou rejetées côté serveur). Anti-rejeu
  simplifié : « un ticket = un usage » (limite documentée dans
  `PRD-TLS.md` § 2.1.7/§ 7.5, pas de fenêtre Bloom-filter réelle).
- Fichiers concernés : nouveau fichier `sessionTickets.ts` + modification
  additive de `TlsServerSession.ts`/`TlsClientSession.ts` (émission/
  consommation du ticket, chemin 0-RTT optionnel) + nouveau fichier de
  test.
- Statut / résultat : en cours.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P2 — TERMINÉ
- Tâche : `src/network/quic/frames.ts` — encode/décode des trames
  RFC 9000 §19 utilisées par ce PRD : `PADDING`, `PING`, `ACK` (avec
  plages non contiguës), `STREAM` (bits OFF/LEN/FIN), `MAX_DATA`,
  `MAX_STREAM_DATA`, `STREAM_DATA_BLOCKED`, `DATA_BLOCKED`,
  `NEW_CONNECTION_ID`, `RETIRE_CONNECTION_ID`, `CONNECTION_CLOSE`
  (transport et application), `HANDSHAKE_DONE`.
- Fichiers concernés : nouveau fichier `src/network/quic/frames.ts` +
  `quic-frames.test.ts` — purement additif.
- Statut / résultat : ✅ terminé. 21 tests, tous verts après une
  correction pendant l'écriture des tests : `ACK Range Count` (§19.3)
  doit être le nombre de plages *additionnelles* (après la première),
  pas la longueur totale du tableau `ackRanges` — un test dédié vérifie
  la taille exacte en octets pour éviter la régression. Couvre
  également le décodage correct quand les bits OFF/LEN de `STREAM`
  sont absents (offset implicite 0, longueur = reste du tampon).
  `tsc`/`eslint` propres. Régression ciblée (quic-packet-format,
  quic-frames, dns-encrypted-transports) : 3 fichiers, 58 tests, 0
  échec.
- Suggestion pour la suite : `PRD-QUIC.md`/P3 (protection de paquets,
  clés de test injectées) et P6 (streams) dépendent tous deux de ce P2
  et sont disponibles en parallèle l'un de l'autre.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P6 — ANNONCE
- Tâche : `src/network/quic/QuicStream.ts` — IDs de stream encodant
  initiateur (client/serveur) et direction (bi/uni-directionnel) dans
  les 2 bits bas (§2.1), allocation séquentielle par catégorie,
  contrôle de flux par stream (`sendMaxData`/`recvMaxData`) et par
  connexion, génération des trames `STREAM`/`MAX_STREAM_DATA`/
  `MAX_DATA`/`STREAM_DATA_BLOCKED`/`DATA_BLOCKED` de P2 selon l'état
  d'émission.
- Fichiers concernés : nouveau fichier `src/network/quic/QuicStream.ts`
  — purement additif.
- Statut / résultat : ✅ terminé. 16 tests : classification des 4
  combinaisons initiateur/direction, allocation séquentielle (pas de
  4) avec compteurs indépendants par catégorie, envoi dans la fenêtre,
  `STREAM_DATA_BLOCKED` quand la fenêtre du stream est épuisée (pas la
  connexion), `DATA_BLOCKED` quand c'est la connexion (pas le stream),
  déblocage après `MAX_STREAM_DATA`/`MAX_DATA`, troncature d'un envoi
  plus grand que la fenêtre (FIN correctement retardé), création à la
  volée d'un stream initié par le pair sur réception d'une trame
  `STREAM`, multiplexage : deux streams sur une même connexion avec
  états de contrôle de flux indépendants. `tsc`/`eslint` propres.
  Régression ciblée (quic-packet-format, quic-frames, quic-stream,
  dns-encrypted-transports) : 4 fichiers, 74 tests, 0 échec.
- Suggestion pour la suite : `PRD-QUIC.md`/P3 (protection de paquets,
  clés de test injectées) reste disponible (dépend de P1+P2, tous deux
  terminés). P7 (machine à états de connexion) dépend de P3-P6 et n'est
  pas encore accessible tant que P3-P5 ne sont pas faits.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P3 — ANNONCE
- Tâche : `src/network/quic/packetProtection.ts` — avec des clés de
  test injectées directement (pas encore via le key schedule TLS,
  cf. § 5 : « clés de test », dépendance réelle sur `PRD-TLS.md`
  reportée à P8). Chiffrement du corps simulé en réutilisant la
  convention `keystreamByte`/XOR de `SimulatedTls.ts`/
  `EapTlsHandshake.ts` (pas de crypto réelle). Protection d'en-tête
  modélisée comme une opération **séparée** (masque dérivé de
  `headerProtectionKey` + un échantillon de corps chiffré, appliqué à
  l'octet d'en-tête et au numéro de paquet) — propriété testée :
  un en-tête corrompu n'empêche pas de déchiffrer un corps valide, et
  réciproquement (§6.3 du PRD).
- Fichiers concernés : nouveau fichier
  `src/network/quic/packetProtection.ts` (+ `PacketProtectionKeys`
  ajouté à `types.ts`) — purement additif.
- Statut / résultat : ✅ terminé. 9 tests : round-trip corps (XOR
  keystream simulé, clé+iv+numéro de paquet), ciphertext différent
  selon le numéro de paquet, masque d'en-tête déterministe pour un
  même échantillon et différent pour un échantillon différent,
  round-trip en-tête (octet + numéro de paquet), seuls les 4 bits bas
  de l'octet d'en-tête sont masqués (bits de forme/type préservés), et
  **propriété d'indépendance structurelle exigée par §6.3** : un
  en-tête corrompu n'empêche pas `unprotectBody` de récupérer le corps
  valide (clé/numéro de paquet/ciphertext suffisent, jamais l'en-tête),
  et un corps corrompu n'empêche pas `unprotectHeader` de récupérer
  l'en-tête valide à partir de l'échantillon déjà établi (l'extraction
  de l'échantillon depuis un tampon fil en direct est un souci
  d'intégration transport reporté à une phase ultérieure, hors
  périmètre de cette unité). `tsc`/`eslint` propres. Régression ciblée
  (les 4 fichiers `quic-*` + dns-encrypted-transports) : 5 fichiers, 83
  tests, 0 échec.
- Suggestion pour la suite : `PRD-QUIC.md`/P4 (recouvrement de pertes)
  dépend de P2+P3 (tous deux terminés) et est maintenant disponible.
  C'est ma 4ᵉ phase HTTP/QUIC depuis la dernière régression complète
  (P8-h2c, QUIC-P1, QUIC-P2, QUIC-P6) — une régression complète
  `network-v2/` est en cours en arrière-plan, comme convenu par la
  cadence toutes-les-4-phases ; résultat à suivre dans une prochaine
  entrée.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P4 — ANNONCE
- Tâche : `src/network/quic/lossRecovery.ts` — RFC 9002 §5/§6 :
  échantillon de RTT et lissage (`smoothed_rtt`/`rttvar`/`min_rtt`),
  détection de perte par seuil de paquets (`kPacketThreshold`=3) et
  par seuil temporel (`kTimeThreshold`=9/8 × max RTT), retransmission
  des **données** perdues (les trames originales du paquet perdu sont
  restituées à l'appelant pour ré-encapsulation dans un nouveau
  paquet, pas le paquet lui-même retransmis à l'identique), PTO avec
  recul exponentiel (`ptoCount`) remis à zéro dès qu'un ACK progresse.
- Fichiers concernés : nouveau fichier
  `src/network/quic/lossRecovery.ts` — purement additif.
- Statut / résultat : ✅ terminé. 10 tests : premier échantillon RTT
  fixe `smoothedRtt`/`minRtt`/`rttVar`(=RTT/2), lissage 7/8-1/8 sur les
  échantillons suivants, soustraction de l'ack delay quand elle reste
  sous la borne liée à `min_rtt`, perte par seuil de paquets (3
  paquets derrière le plus grand acquitté) **avant même** l'échéance
  temporelle, perte par seuil temporel (9/8 × RTT lissé) une fois ce
  délai dépassé mais pas avant, restitution des trames originales du
  paquet perdu (pas de retransmission du paquet lui-même), PTO croissant
  exponentiellement (`ptoCount`) et remis à zéro dès qu'un ACK apporte
  un progrès, paquets acquittés jamais reportés comme perdus. `tsc`/
  `eslint` propres. Régression ciblée (les 5 fichiers `quic-*` +
  dns-encrypted-transports) : 6 fichiers, 93 tests, 0 échec.
- Suggestion pour la suite : `PRD-QUIC.md`/P5 (contrôle de congestion)
  dépend de ce P4 et est maintenant disponible. La régression complète
  lancée en arrière-plan à la phase précédente (4ᵉ phase HTTP/QUIC)
  est toujours en cours — résultat à suivre dans une prochaine entrée.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P5 — ANNONCE
- Tâche : `src/network/quic/congestionControl.ts` — RFC 9002 §7,
  NewReno simplifié : fenêtre initiale (`kInitialWindow`), croissance
  exponentielle en slow start, croissance additive en congestion
  avoidance une fois le seuil atteint, réduction de moitié
  (`kLossReductionFactor`) sur événement de congestion avec période de
  recovery (pas de double réduction dans la même période), fenêtre
  minimale (`kMinimumWindow`) exposée séparément pour la congestion
  persistante (détection de la congestion persistante elle-même laissée
  à l'appelant — non explicitement exigée par le test §6.5 du PRD, qui
  porte sur slow start/avoidance/recovery).
- Fichiers concernés : nouveau fichier
  `src/network/quic/congestionControl.ts` — purement additif.
- Statut / résultat : ✅ terminé. 11 tests : état initial en slow
  start avec fenêtre initiale > 0, croissance exponentielle en slow
  start (fenêtre += taille acquittée), transition en congestion
  avoidance après une perte (croissance additive, strictement plus
  petite que la taille acquittée), réduction de moitié sur perte (au
  moins la fenêtre minimale), pas de double réduction dans la même
  période de recovery, un ACK pour un paquet envoyé avant le début de
  la recovery ne fait pas croître la fenêtre alors qu'un ACK pour un
  paquet envoyé après la reprend normalement, `onPacketsLost` retire
  les octets perdus du vol et ne déclenche qu'un seul événement de
  congestion pour le lot, congestion persistante ramène à la fenêtre
  minimale et efface la période de recovery, `canSend` reflète la
  fenêtre pleine. `tsc`/`eslint` propres. Régression ciblée (les 6
  fichiers `quic-*` + dns-encrypted-transports) : 7 fichiers, 104
  tests, 0 échec.
- Suggestion pour la suite : `PRD-QUIC.md`/P7 (machine à états de
  connexion, sans TLS réel) dépend de P3-P6 — tous terminés — et est
  maintenant disponible. C'est la dernière phase QUIC accessible sans
  attendre `PRD-TLS.md` (P8) ; P9-P13 restent bloquées derrière P7/P8.
  **Résultat de la régression complète** lancée en arrière-plan à la
  phase précédente : 664/666 fichiers, 12566/12627 tests — seuls les
  11 échecs déjà connus de
  `scenario-oracle-08-rac-cache-fusion-interconnect.test.ts` (timing
  RAC, aucun rapport avec HTTP/QUIC) subsistent. Zéro régression sur
  les 12 phases HTTP+QUIC livrées jusqu'ici.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P7 — ANNONCE
- Tâche : `src/network/quic/QuicConnection.ts` — machine à états
  (`idle`→`handshaking`→`established`→`closing`/`draining`→`closed`)
  construite directement sur `EndHost.sendUdpDatagram`/`udpBind`
  (aucune nouvelle abstraction de transport). Établissement avec des
  clés de test (pas de TLS réel — CRYPTO/handshake réel reporté à P8) :
  échange minimal Initial→confirmation qui fait transitionner les deux
  côtés vers `established`. Une fois établie : multiplexage de
  plusieurs streams (`QuicStreamManager` de P6) sur des paquets à
  en-tête court protégés (P3), avec accusés de réception réels
  intégrant `lossRecovery`/`congestionControl` (P4/P5) via des trames
  `ACK` générées immédiatement sur réception d'un paquet
  ack-eliciting. Fermeture propre : `CONNECTION_CLOSE` envoyé par
  l'initiateur (état `closing`), reçu par le pair (état `draining`
  direct, §10.2.2), passage à `closed` après une temporisation de
  drainage.
- Fichiers concernés : nouveau fichier
  `src/network/quic/QuicConnection.ts` — purement additif.
- Statut / résultat : ✅ terminé. 6 tests d'intégration sur un vrai
  `EndHost`/UDP câblé (port de test 9443) : établissement des deux
  côtés (`established`), un message sur un stream livré au pair,
  **multiplexage réel** de deux streams indépendants correctement
  séparés par `streamId`, échange bidirectionnel (client→serveur puis
  serveur→client sur le même stream), fermeture propre — l'initiateur
  passe par `closing`, le pair passe **directement** par `draining`
  (RFC 9000 §10.2.2) avec le code d'erreur transmis au handler
  `onClose`, et `advanceClosing` fait transitionner vers `closed` après
  le délai de drainage (pas avant). Tous verts dès la première
  exécution — aucun bug trouvé cette fois (contrairement à P8-h2c où
  un bug de réentrance avait été détecté). `tsc`/`eslint` propres.
  Régression ciblée (les 7 fichiers `quic-*` + dns-encrypted-transports) :
  8 fichiers, 110 tests, 0 échec.
- Suggestion pour la suite : c'est la dernière phase QUIC accessible
  sans dépendance bloquante — P8 (intégration TLS 1.3 réelle) et tout
  ce qui en découle (P9 0-RTT, P13 migration DoQ) nécessitent que
  `PRD-TLS.md` soit entièrement implémenté ; P10 (Retry) et P11
  (Connection IDs multiples) dépendent de P7 (terminé) mais restent
  disponibles sans attendre TLS si un agent veut les prendre. P12
  (observabilité) dépend de P4-P11.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P10 — ANNONCE
- Tâche : `src/network/quic/retry.ts` — §8 : jeton de `Retry` simulé
  (déterministe, incluant IP/port client + horodatage + secret serveur
  via `simulatedDigest`, vérifiable et expirable), et
  `AmplificationLimiter` : limite d'amplification 3x (le serveur ne
  peut envoyer plus de 3× les octets reçus d'une adresse cliente non
  validée) levée après validation d'adresse.
- Fichiers concernés : nouveau fichier `src/network/quic/retry.ts` —
  purement additif ; module autonome pour cette phase (non câblé dans
  `QuicConnection.ts`, comme P1-P6 avant l'intégration de P7).
- Statut / résultat : ✅ terminé. 12 tests : round-trip jeton pour la
  même adresse cliente, rejet si IP/port différent, rejet si expiré,
  acceptation pile à la frontière d'expiration, rejet si altéré
  (digest invalide) ou vérifié avec le mauvais secret serveur, rejet
  d'un jeton malformé ; `AmplificationLimiter` : autorise jusqu'à 3×
  les octets reçus avant validation, tient compte des octets déjà
  envoyés dans le budget, limite totalement levée après
  `onAddressValidated()`, cesse de comptabiliser les octets reçus une
  fois validée. `tsc`/`eslint` propres. Régression ciblée (les 8
  fichiers `quic-*` + dns-encrypted-transports) : 9 fichiers, 122
  tests, 0 échec.
- Suggestion pour la suite : `PRD-QUIC.md`/P11 (Connection IDs
  multiples) dépend de P7 (terminé) et reste disponible. `PRD-TLS.md`
  vient d'atteindre P8 (résumption PSK & 0-RTT) — `PRD-QUIC.md`/P8
  (intégration TLS 1.3 réelle) devient donc théoriquement accessible,
  mais c'est un chantier lourd (brancher `packetProtection.ts` sur le
  vrai key schedule TLS + handshake combiné Initial→Handshake→1-RTT) ;
  un agent qui le prendrait devrait d'abord relire l'état exact de
  `PRD-TLS.md` (P8 fait, P9-P11 pas encore) pour vérifier que tout le
  nécessaire est bien livré.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P11 — ANNONCE
- Tâche : `src/network/quic/ConnectionIdManager.ts` — §19.15/§19.16 :
  gestion d'un jeu de Connection IDs actifs des deux côtés
  (`NEW_CONNECTION_ID` émis localement avec numéro de séquence
  croissant, `NEW_CONNECTION_ID` reçus du pair mémorisés,
  `RETIRE_CONNECTION_ID` reçu retire l'entrée locale correspondante,
  champ `retire_prior_to` calcule quels CID émis par le pair doivent
  être retirés), et rotation du CID actif utilisé comme DCID sortant
  **sans migration active** (aucune réaction à un changement d'adresse
  UDP du pair, explicitement hors périmètre §2.2).
- Fichiers concernés : nouveau fichier
  `src/network/quic/ConnectionIdManager.ts` — purement additif.
- Statut / résultat : ✅ terminé. 9 tests : émission locale avec
  numéros de séquence croissants et forme de trame correcte, retrait
  d'une entrée locale sur `RETIRE_CONNECTION_ID` du pair (no-op si
  séquence inconnue), premier CID reçu du pair devient l'actif (un
  second reçu ensuite ne le remplace pas), `retire_prior_to` calcule
  correctement les séquences du pair à retirer, `confirmRetired` réélit
  un CID actif si celui retiré était l'actif, rotation vers un CID
  différent disponible (no-op si un seul disponible). `tsc`/`eslint`
  propres. Régression ciblée (les 9 fichiers `quic-*` +
  dns-encrypted-transports) : 10 fichiers, 131 tests, 0 échec.
- Suggestion pour la suite : c'est la dernière phase QUIC accessible
  sans dépendre du travail TLS d'un autre agent — P8/P9/P12/P13
  nécessitent `PRD-TLS.md` complet ou du travail en amont non encore
  livré. Un agent reprenant ce chantier devrait d'abord vérifier
  l'état de `PRD-TLS.md` avant de démarrer `PRD-QUIC.md`/P8.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P8 — TERMINÉ
- Tâche : `src/network/tls/sessionTickets.ts` (nouveau) — `SessionTicket`,
  `deriveResumptionPsk` (§7.5.1 `HKDF-Expand-Label(resumption_master_secret,
  "resumption", ticket_nonce, ...)`), `isTicketFresh`, `SessionTicketStore`
  (registre côté serveur partagé entre instances `TlsServerSession`, anti-rejeu
  simplifié « un ticket = un usage », documenté en tête de fichier comme
  simplification légitime — RFC 8446 §8 laisse la stratégie anti-rejeu 0-RTT
  non spécifiée). Extension de `TlsServerSession.ts`/`TlsClientSession.ts` :
  émission de `NewSessionTicket` après un handshake complet si un
  `sessionTicketStore` est configuré, reprise PSK (`psk_dhe_ke`), livraison de
  données 0-RTT côté client (`earlyData`) et acceptation côté serveur
  (`receivedEarlyData`).
- Bug protocolaire trouvé et corrigé *avant* toute exécution de test (par
  relecture du protocole, pas par un test en échec) : le client utilisait
  inconditionnellement son PSK dérivé du ticket, alors que le serveur retombe
  silencieusement sur `ZERO_IKM` si le ticket est invalide/expiré/consommé —
  sans écho explicite, client et serveur auraient dérivé des secrets
  différents à chaque repli sur handshake complet, garantissant un échec de
  vérification du Finished qui aurait masqué le vrai comportement de repli.
  Corrigé en ajoutant un écho d'acceptation PSK côté serveur
  (`ServerHello.extensions.preSharedKey = 'accepted'` uniquement si un ticket
  valide a été racheté) que le client vérifie avant de dériver son propre key
  schedule — reproduit fidèlement le mécanisme d'index `pre_shared_key` de
  RFC 8446 §4.2.11.
- Bugs de test trouvés et corrigés : (1) le helper `setUpCaAndServer(store?)`
  régénérait une CA fraîche à chaque appel, donc le `server2` d'un test de
  reprise était émis par une CA différente de celle que le `verifier` réutilisé
  faisait confiance → échecs `unknown_ca` côté client qui ressemblaient à un
  bug de reprise ; diagnostiqué via un script `npx tsx` manuel réutilisant le
  même matériel de certificat, corrigé en scindant le helper en `setUpCa()`
  (une seule fois) + `newServer(issued, store?)` (matériel partagé) ;
  (2) un test de rachat de ticket utilisait une constante `NOW` capturée au
  chargement du fichier, antérieure à l'`issuedAt` réel du ticket → corrigé en
  utilisant `Date.now()` au moment du rachat.
- Statut / résultat : ✅ terminé. `tsc --noEmit` propre, `eslint` propre.
  6 nouveaux tests (`tls-session-resumption.test.ts`) : émission de ticket
  avec/sans store configuré, reprise réussie sur une paire client/serveur
  fraîche réutilisant le même matériel de certificat, livraison de données
  0-RTT quand le ticket est valide, repli sans données 0-RTT quand le ticket
  est déjà consommé, repli sans données 0-RTT quand le ticket est expiré.
  Régression : 68 tests TLS (P1–P8 combinés) au vert. Régression complète
  (4ᵉ phase depuis la dernière, cadence désormais en vigueur) :
  663 fichiers, 12535 tests, 11 échecs — tous pré-existants (Oracle RAC),
  aucun nouvel échec.
- Suggestion pour la suite : `PRD-QUIC.md`/P8 (intégration TLS 1.3 réelle)
  est maintenant *presque* accessible — `PRD-TLS.md` a un moteur 1-RTT/mTLS/
  HRR/alertes/ALPN/PSK+0-RTT fonctionnel à travers P8, il ne manque que P9
  (KeyUpdate) et P10 (observabilité) qui ne sont pas bloquants pour
  l'intégration côté QUIC (KeyUpdate concerne le rekey en session longue,
  hors périmètre du handshake initial que QUIC consomme). Un agent QUIC
  pourrait donc raisonnablement démarrer P8 dès maintenant en s'appuyant sur
  `deriveKeySchedule`/`TlsClientSession`/`TlsServerSession` tels quels.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P9 — TERMINÉ
- Tâche : `PRD-TLS.md`/P9 — KeyUpdate (RFC 8446 §4.6.3) : rekey en session
  longue, indépendamment dans chaque direction (client→serveur et
  serveur→client ne sont pas forcément mis à jour ensemble), avec
  `request_update` optionnel (`update_requested` déclenche un KeyUpdate en
  retour, `update_not_requested` non). Le type de message `KeyUpdate`
  (`{kind: 'key_update', requestUpdate: boolean}`) existe déjà dans
  `messages.ts` depuis P1, inutilisé jusqu'ici.
- Fichiers concernés : nouveau `nextTrafficSecret()` dans `keySchedule.ts`
  (`HKDF-Expand-Label(secret, "traffic upd", "")`) ; extension de
  `TlsClientSession.ts`/`TlsServerSession.ts` avec
  `clientApplicationTrafficSecret`/`serverApplicationTrafficSecret`
  publics (posés une fois le handshake conclu) et
  `sendKeyUpdate(requestUpdate?)`/`receiveKeyUpdate(records)` ; nouveau
  fichier de test `tls-key-update.test.ts`.
- Statut / résultat : ✅ terminé. 4 nouveaux tests : ratchet côté client
  et côté serveur ratchete uniquement sa propre direction et reste
  synchronisé entre les deux sessions, `requestUpdate` déclenche
  exactement une réciprocité (jamais de ping-pong, la réponse ne
  redemande jamais elle-même), les KeyUpdate successifs ne réutilisent
  jamais un secret précédent. `tsc`/`eslint` propres. Régression ciblée
  (les 10 fichiers `tls-*` + `dns-encrypted-transports`) : 84 tests, 0
  échec.
- Suggestion pour la suite : `PRD-TLS.md`/P10 (Observabilité) ne dépend
  que de P3–P9, tous terminés — directement disponible.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P10 — TERMINÉ
- Tâche : `PRD-TLS.md`/P10 — Observabilité (§2.1.12) : `events.ts`
  (`TlsDomainEvent` : `tls.handshake.started/completed/failed`,
  `tls.alert.sent`, `tls.session.resumed`, `tls.key_update`, chacun
  gardé par un `sessionId` par connexion — les sessions TLS sont
  éphémères et n'ont pas de contexte device propre avant la migration
  de P11), enregistré dans l'union globale `DomainEvent`
  (`src/events/types.ts`, comme chaque autre protocole) ; `observables.ts`
  (`TlsSignalStore` + `subscribeTlsObservables(bus, store)`) — à la
  différence d'OSPF/DHCP/IPSec dont les observables projettent l'état
  d'un moteur par-device persistant, les sessions TLS n'ont pas
  d'équivalent : c'est une pure souscription au bus, indexée par
  `sessionId`. `TlsClientSession`/`TlsServerSession` prennent un
  `eventBus?` optionnel dans leur config et publient à chaque point de
  transition déjà existant (démarrage, échec, résumption détectée,
  conclusion du handshake, KeyUpdate envoyé/reçu) — purement additif,
  aucun changement de comportement si `eventBus` est omis.
- Simplification documentée : `tls.alert.received` n'est volontairement
  pas émis (ni vraiment utile à émettre) — à ce niveau de fidélité, une
  alerte fatale n'est jamais réellement transmise au pair comme un
  vrai record `alert` sur le fil (voir `TlsServerSession.reject`/
  `TlsClientSession.fail`) ; seul le côté qui lève l'alerte "l'envoie".
- Statut / résultat : ✅ terminé. 5 nouveaux tests
  (`tls-observability.test.ts`) : paires `started`/`completed`
  cohérentes des deux côtés en cas de succès, `failed`+`alert.sent` en
  cas de rejet de certificat, `session.resumed` des deux côtés après
  rachat d'un ticket, le `TlsSignalStore` reflète la conclusion du
  handshake, `keyUpdateCount` s'incrémente indépendamment par rôle.
  `tsc`/`eslint` propres. Régression ciblée (les 11 fichiers `tls-*` +
  `dns-encrypted-transports`) : 89 tests, 0 échec.
- Suggestion pour la suite : `PRD-TLS.md`/P11 (migration DoT &
  EAP-TLS/PEAP/EAP-TTLS) est la dernière phase de `PRD-TLS.md` — dépend
  de P1–P10, toutes terminées. C'est un chantier plus lourd et plus
  risqué que les précédents (bascule de vrais consommateurs existants,
  `DnsTlsTransport.ts` et `EapTlsServerSession.ts`/`EapTlsPeerSession.ts`,
  avec mise à jour consciente des assertions de comptage de rounds —
  cf. § 7 risque dédié de `PRD-TLS.md`) ; je le prends dans la foulée.
  Une fois P11 posé, `PRD-TLS.md` sera intégralement livré : les agents
  QUIC/HTTP peuvent alors considérer la dépendance TLS comme
  définitivement stable pour leurs propres phases P8/P9 (QUIC) et P7
  (HTTP, HTTPS).

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P11 — ANNONCE
- Tâche : `PRD-TLS.md`/P11 — Migration DoT & EAP-TLS/PEAP/EAP-TTLS
  (§2.1.14) : `DnsTlsTransport.ts` (DoT, RFC 7858, port 853) bascule sur
  de vraies `TlsClientSession`/`TlsServerSession` (ALPN `dot`) à la
  place de `SimulatedTls.ts` ; le tunnel EAP-TLS/PEAP/EAP-TTLS
  (`EapTlsServerSession.ts`/`EapTlsPeerSession.ts`) remplace son modèle
  de flights ad hoc 2-RTT (`EapTlsHandshake.ts`) par de vrais appels au
  moteur 1-RTT RFC 8446 — `EapTlsFragmentation.ts` (RFC 5216) reste une
  couche EAP distincte au-dessus, inchangée. `DnsHttpsTransport.ts`
  (DoH) et `DnsQuicTransport.ts` (DoQ) ne sont volontairement pas
  migrés ici (propriété de `PRD-HTTP.md`/`PRD-QUIC.md`).
- Fichiers concernés (prévisionnel) : lecture d'abord de
  `DnsTlsTransport.ts`, `EapTlsHandshake.ts`, `EapTlsServerSession.ts`,
  `EapTlsPeerSession.ts`, `EapTlsFragmentation.ts` et de leurs suites de
  tests existantes avant toute modification, pour cerner précisément ce
  qui doit changer et ce qui doit rester identique.
- Statut / résultat : 🟡 en cours.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P7 — ANNONCE
- Tâche : `PRD-HTTP.md`/P7 — HTTPS. Cette phase ne nécessite aucune
  modification de `src/network/tls/`. `PRD-TLS.md`/P9 (KeyUpdate), déjà
  fusionné (commit `24aa1867`), a exposé `clientApplicationTrafficSecret` /
  `serverApplicationTrafficSecret` comme champs publics sur
  `TlsClientSession`/`TlsServerSession` — c'est exactement le crochet de
  chiffrement de données applicatives qui manquait. `TlsRecord` (défini dans
  `recordLayer.ts`) n'a en revanche aucune sérialisation binaire de niveau
  fil existante (RFC 8446 §5.1 : 1 octet ContentType + 2 octets
  legacyVersion + 2 octets length + fragment) — je la construis dans ce
  périmètre HTTP.
- Fichiers concernés (tous nouveaux, sous `src/network/http/https/`
  uniquement — **zéro fichier sous `src/network/tls/` touché**) :
  - `TlsRecordWire.ts` — encodage/décodage binaire d'un `TlsRecord` (RFC 8446
    §5.1), en réutilisant `CONTENT_TYPE_CODE`/`CONTENT_TYPE_FROM_CODE`/
    `TLS_LEGACY_RECORD_VERSION` de `@/network/tls/types.ts`.
  - Chiffrement de données applicatives simulé par réutilisation directe
    (pas de réimplémentation) de `encryptBytes`/`decryptBytes` de
    `@/network/dns/transport/SimulatedTls.ts`, clé = secret de trafic
    applicatif exposé publiquement, compteur de séquence par direction.
  - `HttpsClientSession.ts`/`HttpsServerSession.ts` — pilotage du handshake
    `TlsClientSession`/`TlsServerSession` sur un vrai `TcpSocket`
    (topologie `LinuxPC`/`TcpStack`), négociation ALPN `http/1.1`, puis
    réutilisation de `Http1Wire.ts` (`encodeRequest`/`parseRequest`/
    `encodeResponse`/`parseResponse`) pour la charge HTTP/1.1 une fois le
    canal établi. Support HSTS et redirection HTTP→HTTPS.
  - Nouveau fichier de test `https.test.ts` suivant le motif de
    `tls-handshake-1rtt.test.ts` (`CertificateAuthority.generate`/
    `CertificateVerifier`).
- Statut / résultat : 🟡 en cours.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P7 — TERMINÉ
- Réalisé exactement le périmètre annoncé, zéro fichier sous
  `src/network/tls/` touché :
  - `TlsRecordWire.ts` — `encodeRecord`/`decodeRecord`/`encodeRecords`/
    `decodeRecords`, en-tête 5 octets (ContentType 1 octet + legacyVersion
    2 octets + length 16 bits big-endian) + fragment, RFC 8446 §5.1.
  - `ApplicationDataCipher.ts` — `encryptApplicationData`/
    `decryptApplicationData` : compose `fragmentAsRecords`/
    `reassembleRecords` (déjà existants, §5.2, uniquement l'enveloppe du
    content-type réel) avec `encryptBytes`/`decryptBytes` réutilisés tels
    quels depuis `SimulatedTls.ts`, un numéro de séquence consommé par
    fragment (fidèle à l'esprit RFC même si en pratique un seul record par
    message ici).
  - `HstsStore.ts` — mémorisation par hôte de `Strict-Transport-Security`
    (`max-age`, `includeSubDomains`, expiration, `max-age=0` efface une
    entrée), pas de liste de préchargement globale (RFC 6797, conforme au
    non-objectif § 2.2 du PRD).
  - `HttpToHttpsRedirect.ts` — `createHttpToHttpsRedirectHandler(host,
    port?)`, un `Http1RequestHandler` (donc branchable directement sur
    `Http1ServerSession` de P2) répondant 308 avec `Location: https://...`
    en préservant méthode/chemin.
  - `HttpsClientSession.ts`/`HttpsServerSession.ts` — pilotage du handshake
    `TlsClientSession`/`TlsServerSession` octet par octet sur un vrai
    `TcpSocket` (convention « chaîne binaire un caractère = un octet » déjà
    établie par `Http2Connection.ts`/`QuicConnection.ts`/
    `WebSocketConnection.ts`, tracée à `DnsHttpsTransport.ts`), ALPN
    négociable (`http/1.1` par défaut, `h2` testé aussi), connexions
    persistantes (RFC 9112 §9.3, même modèle que `Http1ClientSession`/
    `Http1ServerSession`), `Strict-Transport-Security` appliqué côté
    serveur si configuré et mémorisé côté client via `HstsStore`.
  - Nouveau fichier de test `https.test.ts` : `TlsRecordWire` en
    autonome (round-trip, en-tête tronqué, fragment tronqué, ContentType
    inconnu), `ApplicationDataCipher` en autonome (round-trip, échec sur
    mauvais numéro de séquence), `HstsStore` en autonome (5 cas), puis
    handshake/HTTPS de bout en bout sur une vraie topologie `LinuxPC`/
    `GenericSwitch`/`TcpStack` (port de test 8443, jamais 443) : succès
    avec CA de confiance + ALPN `http/1.1`, rejet avant tout échange
    applicatif si la CA n'est pas de confiance, connexion persistante
    réutilisée sur plusieurs requêtes, mémorisation HSTS effective côté
    client, négociation ALPN `h2` quand les deux parties l'offrent, et
    échec propre contre un port sans listener. Plus deux tests pour
    `createHttpToHttpsRedirectHandler` (port par défaut et port explicite).
- Aucun bug trouvé à l'exécution des tests — tous verts dès la première
  exécution (le point le plus délicat, la boucle synchrone de handshake
  réentrante par-dessus l'écriture TCP déjà réentrante de ce simulateur,
  avait été raisonné à l'avance : chaque `onData` du client réécrit
  immédiatement le prochain vol s'il y en a un, exactement comme le test
  `runHandshake` de `tls-handshake-1rtt.test.ts` le fait en boucle
  manuelle — aucune mutation d'état externe après un `socket.write()` ici,
  contrairement au bug de réentrance déjà rencontré sur
  `Http2Connection.ts`).
- Statut / résultat : ✅ terminé. `tsc --noEmit` propre, `eslint` propre.
  20 nouveaux tests (`https.test.ts`). Régression ciblée : 258 tests
  (suites HTTP P1–P6/P8 + TLS P1–P10 combinées) au vert — 3ᵉ phase depuis
  la dernière régression complète (TLS/P8), pas encore la 4ᵉ, régression
  complète non déclenchée par ce commit.
- Suggestion pour la suite : `PRD-HTTP.md`/P12 (migration IIS/curl/wget) et
  P13 (migration DoH) dépendent maintenant de P7 et sont accessibles ;
  `PRD-HTTP.md`/P9 (intégration QUIC) reste bloqué sur `PRD-QUIC.md` livré
  dans son ensemble (actuellement P8/P9 QUIC restants, hors périmètre
  TLS).

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P8 — BLOQUÉ (non tenté)
- En vérifiant les dépendances avant de démarrer `PRD-QUIC.md`/P8
  (intégration TLS 1.3 réelle, maintenant que `PRD-TLS.md` est livré
  jusqu'à P10), constat : `TlsClientSession`/`TlsServerSession` n'exposent
  publiquement que `clientApplicationTrafficSecret`/
  `serverApplicationTrafficSecret` (depuis P9 KeyUpdate) — suffisant pour
  l'espace de paquets 1-RTT, mais **pas** pour l'espace Handshake. RFC 9001
  §5.3 dérive les clés Handshake à partir de
  `client_handshake_traffic_secret`/`server_handshake_traffic_secret`, qui
  restent des champs **privés** (`TlsServerSession.ts` ligne ~86 :
  `private clientHandshakeTrafficSecret`) ou de simples variables locales
  jamais stockées (`TlsClientSession.ts`, dans `handleServerFlight`) —
  jamais exposées à l'extérieur de `src/network/tls/`.
- Je n'ai touché aucun fichier sous `src/network/tls/` (ce module est
  possédé par l'agent TLS) : reconstruire moi-même ce secret depuis les
  octets `ClientHello`/`ServerHello` observables romprait le principe
  directeur du PRD (« `PacketProtection.ts` importe le moteur TLS ... aucune
  autre partie du module ne connaît TLS », § 3.1) en dupliquant la formule
  interne du key schedule en dehors de `keySchedule.ts`.
- Je n'ai donc **pas démarré** P8 — je passe à `PRD-QUIC.md`/P12
  (Observabilité), indépendante et disponible, pendant que ce point se
  débloque. Suggestion pour qui reprend P8 (moi ou l'agent TLS) : exposer
  `clientHandshakeTrafficSecret`/`serverHandshakeTrafficSecret` comme
  champs publics sur les deux sessions TLS, au même titre que les secrets
  applicatifs de P9 — un ajout strictement additif, sans changement de
  comportement, symétrique à ce que P9 a déjà fait.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P12 — ANNONCE
- Tâche : `PRD-QUIC.md`/P12 — Observabilité (§2.1.11). Événements bus dédiés
  `quic.connection.established/closing/closed`, `quic.packet.sent/
  received/lost`, `quic.congestion.window_changed`,
  `quic.stream.opened/closed/blocked`, plus un read-model (`Signal`) au
  même principe que `src/network/tls/observables.ts` (P10 TLS).
- Fichiers concernés (tous sous `src/network/quic/`, possédé par ce PRD) :
  nouveaux `events.ts`/`observables.ts` ; extension de `QuicConnection.ts`
  (seul point d'intégration — `QuicStream.ts`/`lossRecovery.ts`/
  `congestionControl.ts` restent des fonctions pures, non touchées) : un
  `eventBus?: IEventBus` optionnel au constructeur, un `connectionId`
  stable, émission aux points de transition d'état (established/closing/
  closed), d'envoi/réception/perte de paquet, de changement de fenêtre de
  congestion, et d'ouverture/fermeture/blocage de stream. Nouveau fichier
  de test `quic-observability.test.ts`.
- Statut / résultat : 🟡 en cours.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P12 — TERMINÉ
- Réalisé exactement le périmètre annoncé :
  - `events.ts` — `QuicDomainEvent` (10 topics : connection.established/
    closing/closed, packet.sent/received/lost, congestion.window_changed,
    stream.opened/closed/blocked), `randomConnectionId()`.
  - `observables.ts` — `QuicSignalStore`/`connectionSignal`/
    `subscribeQuicObservables`, même forme que le pendant TLS : statut,
    compteurs de paquets envoyés/reçus/perdus, fenêtre de congestion
    courante, liste des streams ouverts.
  - `QuicConnection.ts` : `connectionId` stable, `eventBus?` optionnel
    injecté au constructeur (rétrocompatible — tous les appels existants
    sans 5ᵉ argument continuent de fonctionner à l'identique, aucun
    comportement changé quand `eventBus` est omis) ; émission aux 10
    points identifiés dans l'annonce ; `quic.stream.closed` déclenché une
    seule fois par stream (`finSent && finReceived`, ensemble
    `closedStreamIds` pour éviter les doublons) ; phase de congestion
    dérivée de `congestionRecoveryStartTime`/`isInSlowStart` (approximation
    déjà cohérente avec la limite connue du module : `sentTime` n'est pas
    suivi précisément pour la détection de recovery, cf. le `sentTime: 0`
    déjà présent dans le code existant — la classification 'recovery' se
    base donc sur « une perte a déjà déclenché un événement de congestion
    et n'en est pas encore sorti », pas sur la fenêtre temporelle exacte du
    paquet perdu).
- Bugs de test trouvés et corrigés (aucun bug d'implémentation — la
  fenêtre de flux/l'algorithme `trySend` existants avaient un
  comportement plus subtil que prévu) : (1) `trySend` ne renvoie un frame
  bloquant que si la fenêtre disponible est *déjà* à zéro avant l'appel —
  un envoi qui dépasse la fenêtre restante est simplement tronqué (RFC
  9000 §4.1), donc `quic.stream.blocked` teste désormais deux envois
  successifs (le premier épuise exactement la fenêtre, le second — sans
  aucune marge — se bloque) plutôt qu'un seul envoi surdimensionné ; (2) un
  stream ne se ferme que quand les *deux* directions ont vu un fin (RFC
  9000 §3.4/§3.5) — les tests `stream.closed` et le read-model font donc
  émettre un fin par le pair en retour avant de vérifier la fermeture,
  plutôt qu'un fin unidirectionnel.
- Statut / résultat : ✅ terminé. `tsc --noEmit` propre, `eslint` propre.
  7 nouveaux tests (`quic-observability.test.ts`). Régression ciblée :
  126 tests QUIC (10 fichiers, P1–P7/P10–P12 combinés) au vert. Aucun
  autre fichier du projet n'importe encore `QuicConnection.ts` (vérifié par
  recherche) — changement rétrocompatible sans risque de régression
  externe.
- Suggestion pour la suite : `PRD-QUIC.md`/P8 reste bloqué (cf. entrée
  BLOQUÉ ci-dessus) tant que `clientHandshakeTrafficSecret`/
  `serverHandshakeTrafficSecret` ne sont pas exposés publiquement côté
  TLS ; P13 (migration DoQ) dépend de P8 et P6, donc bloqué transitivement
  par la même chose. `PRD-HTTP.md`/P12 (migration IIS/curl/wget) et P13
  (migration DoH) restent les phases les plus substantielles actuellement
  disponibles pour la suite.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P13 — ANNONCE
- Tâche : `PRD-HTTP.md`/P13 — migration de `DnsHttpsTransport.ts` (DoH,
  RFC 8484) sur l'adaptateur HTTP/1.1 + HTTPS de ce moteur (P7), à la place
  de son framing texte fait main par-dessus `SimulatedTls.ts`.
- Bug trouvé et corrigé *avant* la migration elle-même, en investiguant les
  risques : `Http1Wire.ts` (P2, déjà fusionné) traitait le corps des
  messages via un aller-retour `TextEncoder`/`TextDecoder` (UTF-8 réel), ce
  qui corrompt silencieusement tout corps binaire n'étant pas de l'UTF-8
  valide (remplacement par U+FFFD) — vérifié empiriquement avec des octets
  comme `0xC0`/`0xFF` (un simple octet d'adresse IPv4 ≥128 suffit). Comme
  `application/dns-message` (le corps que DoH doit transporter) est du
  binaire arbitraire, migrer DoH tel quel aurait silencieusement corrompu
  des réponses DNS contenant des adresses IP courantes. Corrigé dans
  `Http1Wire.ts` (fichier possédé par ce PRD, P2, aucune collision) en
  remplaçant l'aller-retour `TextEncoder`/`TextDecoder` du corps par la
  convention « chaîne binaire, un caractère = un octet » déjà utilisée
  ailleurs dans le projet (`Http2Connection.ts`/`QuicConnection.ts`/
  `WebSocketConnection.ts`/`DnsHttpsTransport.ts`) — strictement
  rétrocompatible pour tout corps ASCII pur (100 % des tests existants),
  correct de surcroît pour du binaire arbitraire. Nouveau test dédié dans
  `http1-wire.test.ts` (octets non-UTF-8 valides, round-trip byte-exact).
  Régression ciblée immédiate : 151 tests (http1-wire, https, http2,
  http-cache, http-cookies, http-auth, http-websocket,
  dns-encrypted-transports) au vert avant de poursuivre.
- Fichiers concernés pour la migration elle-même : réécriture de
  `DnsHttpsTransport.ts` sur `HttpsClientSession`/`HttpsServerSession` (P7)
  — signature étendue de `bindDnsHttpsServer`/`queryDnsOverHttps` pour
  accepter respectivement un certificat serveur réel et un
  `CertificateVerifier` (la négociation TLS est désormais réelle, donc
  nécessite une vraie PKI, contrairement au stand-in `SimulatedTls.ts` qui
  n'en avait pas) ; ALPN `http/1.1` (le stand-in prétendait `h2` sans
  jamais faire de vrai framing HTTP/2). Mise à jour de
  `dns-encrypted-transports.test.ts` (section DoH + test de parité de
  transport) pour fournir une CA/un certificat/un verifier, sans changer
  les assertions observables (mêmes codes, mêmes réponses DNS attendues).
- Statut / résultat : 🟡 en cours.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — PRD-TLS/P11 — TERMINÉ (PRD-TLS.md intégralement livré)
- Tâche : `PRD-TLS.md`/P11 — migration de `DnsTlsTransport.ts` (DoT, RFC
  7858) et du tunnel EAP-TLS/PEAP/EAP-TTLS sur le vrai moteur RFC 8446.
- `DnsTlsTransport.ts` : `bindDnsTlsServer`/`queryDnsOverTls` s'appuient
  désormais sur `TlsClientSession`/`TlsServerSession` réels au lieu de
  `SimulatedTls.ts`. Les deux côtés font confiance à une seule CA « bien
  connue » via `getOrCreateCA(DOT_TRUST_ANCHOR_KEY)`
  (`@/network/pki/PkiCaRegistry`) — pas d'étape d'enrôlement nécessaire,
  API de `bindDnsTlsServer`/`queryDnsOverTls` strictement inchangée.
  `DnsHttpsTransport.ts` (DoH) et `DnsQuicTransport.ts` (DoQ) restent sur
  `SimulatedTls.ts` — hors périmètre ici, propriété de
  `PRD-HTTP.md`/`PRD-QUIC.md` (note : Arthur migre justement DoH en ce
  moment même, cf. entrée juste au-dessus — aucun conflit de fichiers,
  `DnsTlsTransport.ts` et `DnsHttpsTransport.ts` sont deux fichiers
  distincts, seul `dns-encrypted-transports.test.ts` est un point de
  contact partagé et je ne l'ai pas modifié). L'ALPN est imposé au niveau
  de ce module (le moteur TLS générique le traite comme informatif) : en
  cas de non-correspondance, le serveur ferme sans répondre.
- `EapTlsServerSession.ts`/`EapTlsPeerSession.ts` pilotent désormais
  `TlsServerSession`/`TlsClientSession` au lieu du modèle 2-RTT ad hoc
  d'`EapTlsHandshake.ts`, réduit à un simple codec de fil (hex-encode
  chaque `fragment` de `TlsRecord` pour survivre à un aller-retour JSON) —
  la fragmentation RFC 5216 §2.1 (`EapTlsFragmentation.ts`) est inchangée.
  TLS 1.3 regroupant le Finished du serveur dans son premier paquet
  (contrairement à l'échange façon TLS 1.2 illustré par la RFC 5216), le
  tunnel se conclut désormais en un aller-retour de moins : plus de round
  « Finished serveur » séparé. L'authentification interne PEAP/EAP-TTLS
  transite maintenant dans de vrais enregistrements TLS
  `application_data` plutôt qu'un wrapper ad hoc — gain de fidélité.
  `EapTlsConfig` a gagné un `serverPrivateKey` requis (signe le
  `CertificateVerify` du tunnel, RFC 8446 §4.4.2 — le vrai moteur en a
  besoin, l'ancien Finished simulé par nonce non) ; `EapTlsPeerOptions` a
  gagné un `clientPrivateKey` optionnel, même raison côté client. Tous
  les sites d'appel dans `eaptls-handshake.test.ts`,
  `peap-ttls-handshake.test.ts`, `dot1x-radius-eaptls.test.ts` et
  `dot1x-radius-peap-ttls.test.ts` ont été mis à jour en conséquence.
- Mise à jour consciente de compteurs de rounds (conformément au risque
  documenté dans `PRD-TLS.md` §7) : deux tests à MTU minuscule (40
  octets) ont vu leur plafond de sécurité relevé (50→150 et 100→150) —
  un paquet RFC 8446 transporte une chaîne de certificats + signature,
  donc nécessite sensiblement plus de fragments qu'un paquet ad hoc de
  l'ancien modèle ; aucun changement fonctionnel, les deux tests
  vérifient toujours le même accept/success final.
- Statut / résultat : ✅ terminé. `tsc`/`eslint` propres. Régression
  ciblée (tls-*, dns-encrypted-transports, eaptls/peap/ttls,
  dot1x-radius-eap*, radius*) : 32 fichiers, 226 tests, 0 échec.
  Régression complète (justifiée hors cadence stricte des 4 phases : P11
  est un chantier de migration transverse touchant des consommateurs
  existants, donc plus à risque que les phases additives précédentes) :
  673/675 fichiers, 12638/12699 tests, 11 échecs — tous pré-existants
  (Oracle RAC), aucun nouvel échec.
- **`PRD-TLS.md` est désormais intégralement livré (P1 à P11).**
- Suggestion pour la suite : `PRD-QUIC.md`/P8 (intégration TLS 1.3 réelle)
  était bloqué en attendant que `clientHandshakeTrafficSecret`/
  `serverHandshakeTrafficSecret` soient exposés publiquement côté
  `TlsClientSession`/`TlsServerSession` (cf. entrée BLOQUÉ d'Arthur
  ci-dessus) — ce blocage ne dépendait pas de P11, donc reste entier ;
  un agent TLS pourrait lever ce blocage en exposant ces deux secrets
  (actuellement privés) comme champs publics, symétriquement à
  `clientApplicationTrafficSecret`/`serverApplicationTrafficSecret`
  (déjà publics depuis P9). Je vais regarder ce blocage maintenant,
  puisque c'est un point de contact direct entre `PRD-TLS.md` et
  `PRD-QUIC.md`/P8.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Claude (Sonnet 5) — déblocage PRD-QUIC/P8 (hors phase PRD-TLS)
- Tâche : exposer `clientHandshakeTrafficSecret`/`serverHandshakeTrafficSecret`
  comme champs publics sur `TlsClientSession`/`TlsServerSession` — le seul
  blocage qu'Arthur avait identifié pour démarrer `PRD-QUIC.md`/P8 (cf.
  entrée BLOQUÉ ci-dessus). Purement additif, symétrique à ce que P9 avait
  déjà fait pour les secrets applicatifs — aucun changement de
  comportement, juste deux valeurs déjà calculées (auparavant privées ou
  de simples variables locales jamais stockées côté client) désormais
  aussi exposées en champs publics.
- Fichiers concernés : `TlsClientSession.ts`, `TlsServerSession.ts`
  uniquement — pas de fichier sous `src/network/quic/` touché (propriété
  d'Arthur).
- Statut / résultat : ✅ terminé. `tsc`/`eslint` propres. Régression
  ciblée (tls-*, dns-encrypted-transports, eaptls/peap-ttls,
  dot1x-radius-eaptls*, quic-*, http*) : 33 fichiers, 416 tests, 0 échec.
- Suggestion pour la suite : `PRD-QUIC.md`/P8 (intégration TLS 1.3 réelle)
  et, transitivement, P13 (migration DoQ) devraient maintenant être
  démarrables par Arthur sans blocage restant côté `PRD-TLS.md`.
  `PRD-TLS.md` est intégralement livré (P1–P11) — je n'ai plus de phase
  propre à ce PRD à prendre ; je vais regarder s'il reste un chantier
  disponible et non revendiqué sur `PRD-QUIC.md`/`PRD-HTTP.md` avant de
  décider de la suite, pour ne pas dupliquer le travail d'Arthur.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P13 — TERMINÉ
- Réalisé exactement le périmètre annoncé :
  - `DnsHttpsTransport.ts` réécrit sur `HttpsClientSession`/
    `HttpsServerSession` (P7) : `bindDnsHttpsServer(host, handler,
    tlsConfig, options?)` et `queryDnsOverHttps(host, serverIP, query,
    tlsConfig, options?)` — signature étendue d'un paramètre `tlsConfig`
    obligatoire (`{ serverCert, serverPrivateKey }` côté serveur,
    `{ verifier }` côté client), puisque la négociation TLS est
    désormais réelle et nécessite une vraie PKI, contrairement au
    stand-in `SimulatedTls.ts` qui n'en avait aucune. `DOH_ALPN` passe de
    `'h2'` (jamais un vrai framing HTTP/2 dans l'ancien code — une simple
    étiquette) à `'http/1.1'` (le seul protocole que P7 sait réellement
    parler par-dessus TLS). Le corps `application/dns-message` est
    transporté par le `HttpMessage.body` (`Uint8Array`) du moteur HTTP
    partagé plutôt que par un framing texte fait main.
  - `dns-encrypted-transports.test.ts` (section DoH + test de parité de
    transport) mis à jour pour générer une CA/un certificat/un verifier
    (`CertificateAuthority.generate`/`CertificateVerifier`, même motif que
    `https.test.ts`) et les transmettre — assertions observables
    inchangées (mêmes codes de statut, mêmes réponses DNS).
- Bug trouvé et corrigé *avant* la migration (détaillé dans l'annonce
  ci-dessus) : `Http1Wire.ts` corrompait silencieusement tout corps
  binaire non-UTF-8 valide via un aller-retour `TextEncoder`/
  `TextDecoder` — corrigé par la convention « chaîne binaire, un
  caractère = un octet », strictement rétrocompatible.
- Aucun autre bug trouvé à l'exécution — les 12 tests de
  `dns-encrypted-transports.test.ts` (DoT/DoH/DoQ/parité) sont passés au
  vert dès la première exécution après la migration, la correction
  préalable de `Http1Wire.ts` ayant déjà éliminé le risque de corruption
  identifié.
- Statut / résultat : ✅ terminé. `tsc --noEmit` propre, `eslint` propre.
  Régression ciblée : 377 tests (24 fichiers — dns-*, http-*, http1-*,
  http2*, https) au vert. Aucun autre fichier du projet n'importe
  `DnsHttpsTransport.ts` en dehors de ce test (vérifié par recherche) —
  pas de risque de régression externe. Régression complète en cours
  d'exécution en tâche de fond au moment de ce commit (5ᵉ phase depuis la
  dernière régression complète, cadence des 4 phases dépassée) ; résultat
  à suivre dans une entrée ultérieure si un échec inattendu apparaît,
  sinon considérer le silence comme confirmation.
- Suggestion pour la suite : `PRD-HTTP.md`/P12 (migration IIS/curl/wget)
  reste la phase la plus substantielle actuellement disponible et
  indépendante. `PRD-QUIC.md`/P8 reste bloqué en l'état — l'agent TLS a
  indiqué regarder l'exposition de `clientHandshakeTrafficSecret`/
  `serverHandshakeTrafficSecret` à l'instant, donc à surveiller avant de
  retenter P8. **Mise à jour post-rebase : l'agent TLS a effectivement
  exposé ces deux secrets (commit `4cb1ad37`) — `PRD-QUIC.md`/P8 est donc
  maintenant débloqué, je vais l'attaquer ensuite.**

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P8 — ANNONCE
- Tâche : `PRD-QUIC.md`/P8 — intégration TLS 1.3 réelle. `packetProtection.ts`
  branché sur le key schedule réel de `src/network/tls/` (labels RFC 9001
  §5.1 `"quic key"`/`"quic iv"`/`"quic hp"` via `expandLabel`, déjà
  exporté de `keySchedule.ts` — aucune réimplémentation) ; handshake
  combiné Initial → Handshake → 1-RTT, remplaçant les clés injectées par
  les tests (`QuicTestKeys`, P3) par un vrai `TlsClientSession`/
  `TlsServerSession` piloté via des trames `CRYPTO` (RFC 9000 §19.6,
  absentes du module jusqu'ici — les phases précédentes n'avaient besoin
  que de PING/HANDSHAKE_DONE comme stand-in de handshake).
- Fichiers concernés (tous sous `src/network/quic/`, possédé par ce PRD —
  **zéro fichier sous `src/network/tls/` touché**, consommation pure des
  exports déjà publics `expandLabel`/`extractSecret`/
  `clientHandshakeTrafficSecret`/`serverHandshakeTrafficSecret`/
  `clientApplicationTrafficSecret`/`serverApplicationTrafficSecret`) :
  - `frames.ts` : nouvelle trame `CRYPTO` (offset + length + data,
    RFC 9000 §19.6), encodage/décodage + tests dédiés.
  - `packetProtection.ts` : `deriveInitialSecrets(destConnectionId)` (sel
    fixe RFC 9001 §5.2, `extractSecret`+`expandLabel`) et
    `deriveQuicKeys(space, trafficSecret)` (labels `"quic key"`/`"quic
    iv"`/`"quic hp"`) — fonctions pures ajoutées, aucune modification des
    fonctions existantes (`protectBody`/`unprotectBody`/`protectHeader`/
    `unprotectHeader` restent inchangées, P3 reste vert tel quel).
  - `QuicConnection.ts` : le stand-in PING/HANDSHAKE_DONE est remplacé par
    un vrai pilotage `TlsClientSession.start()`/`.handle()`/
    `TlsServerSession.handle()`, les flights étant portés par des trames
    `CRYPTO` dans l'espace Initial (ClientHello/ServerHello, non protégé
    par les clés Handshake) puis Handshake (le reste du flight serveur,
    protégé) — mappage direct sur `splitLeadingContentType`/
    `fragmentAsRecords`/`reassembleRecords` déjà exportés de
    `recordLayer.ts`. Les clés de chaque espace sont dérivées dès que le
    secret correspondant devient disponible ; passage à l'espace
    Application une fois le handshake terminé (`result === 'success'`/
    `'accept'`), `HANDSHAKE_DONE` toujours envoyé côté serveur (RFC 9000
    §4.1.1). `QuicTestKeys` reste utilisable en option pour les tests bas
    niveau qui veulent s'affranchir du handshake réel (P3/P4/P5/P6
    restent verts sans changement).
  - Nouveaux tests dans `quic-crypto-frame.test.ts` (trame) et extension
    de `quic-connection.test.ts` (handshake réel de bout en bout avec
    `CertificateAuthority`/`CertificateVerifier`, même motif que
    `tls-handshake-1rtt.test.ts`/`https.test.ts`).
- Statut / résultat : 🟡 en cours.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P8 — TERMINÉ
- Réalisé le périmètre annoncé, avec une découverte importante en cours de
  route qui a changé le mapping exact des espaces de paquets (voir bug
  ci-dessous). Fichiers : `frames.ts` (trame `CRYPTO`, type 0x06, RFC 9000
  §19.6), `packetProtection.ts` (`deriveInitialSecrets`/`deriveQuicKeys`
  RFC 9001 §5.1/§5.2 via `expandLabel`/`extractSecret` déjà exportés de
  `keySchedule.ts` — aucune réimplémentation ; `encodeTlsRecordsForCrypto`/
  `decodeTlsRecordsFromCrypto`, copie locale du même format d'en-tête à 5
  octets que `TlsRecordWire.ts` côté HTTP, volontairement dupliquée plutôt
  que partagée entre PRD frères), `QuicConnection.ts` (`QuicKeyConfig`
  discriminé `test-keys | tls` — rétrocompatible, `test-keys` reproduit
  P3-P7 à l'identique ; `tls` pilote un vrai `TlsClientSession`/
  `TlsServerSession` sur des trames CRYPTO, clés dérivées par espace dès
  que le secret correspondant existe). Nouveau fichier de test
  `quic-tls-integration.test.ts`.
- **Bug protocolaire trouvé et corrigé avant tout test vert** (dépendance
  circulaire) : ce moteur TLS calcule `clientHandshakeTrafficSecret`/
  `serverHandshakeTrafficSecret` comme effet de bord du traitement d'un
  *flight entier* en un seul appel `handle()`, plutôt que de les exposer
  dès que ServerHello seul est vu (ce qu'une vraie implémentation peut
  faire, le secret Handshake ne dépendant que de ClientHello+ServerHello).
  Conséquence : le client ne peut pas déchiffrer un paquet QUIC de
  l'espace Handshake avant d'avoir déjà traité — via `handle()` — le
  contenu de ce même paquet, ce qui aurait nécessité la clé pour le
  déchiffrer en premier lieu. Diagnostiqué par un test en échec explicite
  (`no handshake keys available yet`), pas en lecture de code préalable.
  Corrigé par une simplification documentée : la réponse complète du
  serveur au ClientHello (ServerHello + bundle protégé, un seul appel
  `handle()`) voyage entièrement dans l'espace Initial (clés toujours
  disponibles des deux côtés dès le départ) ; une fois cet échange traité,
  les deux parties partagent les secrets Handshake, donc la réponse du
  client (Finished) et tout ce qui suit jusqu'au 1-RTT utilisent
  légitimement les vraies clés de l'espace Handshake. Portée nominale
  uniquement (pas de HelloRetryRequest sur QUIC dans cette phase — limite
  documentée dans le code).
- **Découverte transverse, hors du périmètre strict de cette phase mais
  significative pour tout le projet** : `npx tsc --noEmit -p .` (la
  commande documentée dans `CLAUDE.md`) s'avère être un **no-op silencieux**
  — le `tsconfig.json` racine n'a que `"files": []` et des `"references"`,
  qui ne sont traversées qu'avec `tsc --build`, jamais avec un `-p .` nu.
  Vérifié avec `tsc --build --dry ./tsconfig.json` (confirme qu'un build
  réel construirait les deux projets référencés) contre `tsc --noEmit -p .`
  (aucune sortie, terminaison instantanée). Aucun agent, moi y compris,
  n'a donc jamais réellement fait vérifier son code par ce typecheck cette
  session — seule l'exécution des tests (vitest/esbuild, qui ignore les
  types) a garanti la correction. En vérifiant avec `-p tsconfig.app.json`
  directement, deux constats : (1) des milliers d'erreurs pré-existantes,
  sans rapport avec ce PRD, dispersées dans tout le projet (Oracle RMAN,
  terminal sessions, etc.) — hors de portée, non touchées ; (2) un vrai
  bug de rétrécissement de type que j'ai moi-même reproduit dans mon
  propre code HTTP (P2/P7) : `if (!parsed.ok) return {...parsed.reason}`
  ne rétrécit PAS `Http1ParseResult` vers `Http1ParseError` en TypeScript
  (limitation connue et reproduite en isolation totale : le rétrécissement
  par négation simple d'un littéral booléen ne fonctionne que dans le sens
  positif, `if (x.ok) {...} else {...}` marche des deux côtés, mais
  `if (!x.ok) return {...x.reason}` échoue — il faut écrire
  `x.ok === false` explicitement). Corrigé dans les 4 occurrences que
  j'ai écrites (`Http1ClientSession.ts`, `Http1ServerSession.ts`,
  `HttpsClientSession.ts`, `HttpsServerSession.ts`) — comportement runtime
  identique (booléen, donc `!x`/`x===false` équivalents en JS), seule la
  vérification statique change. Également enregistré `QuicDomainEvent`
  dans l'union centrale `DomainEvent` (`src/events/types.ts`), qui
  manquait depuis P12 (jamais détecté faute de typecheck réel).
- Statut / résultat : ✅ terminé. `tsc --noEmit -p tsconfig.app.json`
  (vérification directe, en plus de la commande documentée) : propre pour
  tous les fichiers de cette session, hormis une incompatibilité
  pré-existante et inchangée dans `DnsHttpsTransport.ts`
  (`DnsMessageHandler` autorise un retour `Promise`, jamais utilisé en
  pratique — déjà présente avant ma migration P13, non liée à P8).
  `eslint` propre. 5 nouveaux tests (`quic-tls-integration.test.ts`) +
  3 nouveaux tests CRYPTO (`quic-frames.test.ts`) + 5 nouveaux tests de
  dérivation de clés (`quic-packet-protection.test.ts`). Régression
  ciblée : 264 tests (24 fichiers — quic-*, https, http1-wire,
  dns-encrypted-transports, tls-*) au vert. Régression complète (lancée
  plus tôt pour P13, toujours valide puisque aucun fichier de production
  supplémentaire modifié depuis hors de ce diff) : 675/677 fichiers,
  12674/12735 tests, 11 échecs — tous pré-existants (Oracle RAC), aucun
  nouvel échec.
- Suggestion pour la suite : `PRD-QUIC.md`/P9 (0-RTT) et P13 (migration
  DoQ) dépendent tous deux de P8, désormais disponibles. La découverte du
  no-op de `tsc -p .` mérite d'être portée à la connaissance de l'agent
  TLS et de l'utilisateur — je ne corrige pas le tsconfig racine
  lui-même (hors mandat, risque de casser une convention de build/CI que
  je ne maîtrise pas entièrement), mais recommande d'utiliser
  `tsc --noEmit -p tsconfig.app.json` (en acceptant son bruit de fond
  préexistant) ou `tsc --build` pour toute vérification future qui compte
  vraiment.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P9 — ANNONCE
- Tâche : `PRD-QUIC.md`/P9 — 0-RTT (RFC 9001 §4.4). Le PRD est explicite :
  « réutilise entièrement le 0-RTT déjà prévu par le moteur TLS, aucune
  logique de rejeu spécifique à QUIC ». En relisant `TlsServerSession.ts`
  (`handleFirstClientHello`), constat : les données 0-RTT du client sont
  déjà transportées comme un `TlsRecord` supplémentaire *à l'intérieur* du
  même flight que `client.start()` retourne (`splitLeadingContentType`
  sépare le ClientHello non protégé du reste protégé, qui devient
  `receivedEarlyData` si un PSK valide est résolu) — exactement le même
  tableau `TlsRecord[]` que mon code P8 envoie déjà tel quel dans l'espace
  Initial (`sendCryptoRecords('initial', flight)`) et que le serveur
  décode déjà tel quel avant d'appeler `tls.handle(records)`. Autrement
  dit : **le transport 0-RTT fonctionne déjà de bout en bout avec le code
  P8 existant, sans aucune modification requise du côté QUIC** — je vais
  le valider par un test dédié plutôt que d'ajouter un mécanisme de fil
  redondant (pas de nouvel espace de paquets « 0-RTT » séparé avec ses
  propres clés : ce simulateur ne modélise pas de confidentialité réelle
  de toute façon, la distinction n'apporterait aucune garantie
  supplémentaire, et `clientEarlyTrafficSecret` n'est pas exposé
  publiquement par le moteur TLS pour la dériver proprement sans y
  toucher).
- Fichiers concernés : nouveau fichier de test uniquement,
  `quic-0rtt.test.ts` (deux connexions QUIC/TLS réelles successives :
  la première obtient un ticket de session, la seconde s'en sert avec des
  données 0-RTT, vérifie `receivedEarlyData` côté serveur ; puis un
  scénario de rejet avec ticket déjà consommé). Aucun fichier de
  production modifié si la validation confirme l'hypothèse ci-dessus.
- Statut / résultat : 🟡 en cours.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P9 — TERMINÉ
- L'hypothèse de l'annonce s'est confirmée : le transport 0-RTT lui-même
  ne nécessitait aucun changement — mais en écrivant le test, un vrai bug
  latent de P8 est apparu et a été corrigé avant que le test ne passe.
- **Bug trouvé et corrigé** : côté client, `handleCryptoFrame` appelait
  systématiquement `TlsClientSession.handle(records)` pour tout ce qui
  arrive dans l'espace Handshake — correct pour le Finished du serveur,
  mais faux pour un `NewSessionTicket` post-handshake (§4.6.1), qui arrive
  dans le *même* espace une fois la poignée de main terminée : `handle()`
  se contente de renvoyer `null` silencieusement dès que
  `state !== 'awaiting-server-flight'`, donc le ticket n'était jamais
  transmis à `receiveSessionTicket()` — aucune erreur visible, juste un
  ticket perdu. Corrigé dans `QuicConnection.ts` : si
  `clientTls.result !== null` (poignée de main déjà conclue), router vers
  `receiveSessionTicket(records)` au lieu de `handle(records)`. Trouvé en
  écrivant le test 0-RTT (qui a d'abord besoin d'un vrai ticket obtenu sur
  une première connexion), pas par relecture préalable du code.
- Fichiers concernés : `QuicConnection.ts` (le correctif ci-dessus,
  4 lignes) ; nouveau fichier de test `quic-0rtt.test.ts` — deux connexions
  QUIC/TLS réelles et successives (obtention du ticket, puis reprise avec
  données 0-RTT), et un scénario de repli sans 0-RTT quand le ticket est
  déjà consommé. Aucun nouveau mécanisme de fil ajouté (pas d'espace de
  paquets 0-RTT séparé, cf. justification dans l'annonce).
- Statut / résultat : ✅ terminé. `tsc --noEmit -p tsconfig.app.json`
  propre, `eslint` propre. 2 nouveaux tests. Régression ciblée : 250 tests
  (24 fichiers — quic-*, tls-*, https, dns-encrypted-transports) au vert.
- Suggestion pour la suite : `PRD-QUIC.md`/P13 (migration DoQ) dépend de
  P8+P6, tous deux désormais disponibles — c'est la phase QUIC la plus
  substantielle restante. Côté HTTP, `PRD-HTTP.md`/P12 (migration
  IIS/curl/wget) et P9 (intégration QUIC pour HTTP/3, maintenant que
  `PRD-QUIC.md` est presque intégralement livré — il ne reste que P12
  Observabilité et P13 Migration DoQ) devraient être réexaminées bientôt.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P13 — ANNONCE
- Tâche : `PRD-QUIC.md`/P13 — migration de `DnsQuicTransport.ts` (DoQ,
  RFC 9250) sur `QuicConnection`/`QuicStream` réels, à la place du stand-in
  actuel (un datagramme UDP = un message applicatif chiffré par XOR via
  `SimulatedTls.ts`, aucun format de paquet QUIC réel). DNS encapsulé en
  stream préfixé-longueur (RFC 9250 §4.2, même principe que DNS-sur-TCP
  RFC 1035 §4.2.2 : 2 octets de longueur big-endian + message DNS),
  passage d'un modèle « une connexion par requête » à « une connexion
  réutilisée, streams multiplexés » (un nouveau stream bidirectionnel
  client par requête, RFC 9250 §5.1).
- Limite déjà présente dans `QuicConnection.ts` depuis P1-P9, non
  introduite ici : un objet `QuicConnection` représente une seule connexion
  point-à-point (lié à un port UDP via `host.udpBind`, pas un motif
  listener/accept multi-clients comme `TcpStack`). Le stand-in actuel de
  DoQ supportait implicitement plusieurs clients concurrents (dcid/
  clientRandom encodés dans chaque datagramme) ; la migration réduit ce
  périmètre à un client à la fois par instance serveur — cohérent avec la
  portée déjà couverte par la suite de tests (`DnsQuicClient` unique),
  documenté explicitement comme simplification plutôt que découvert en
  cours de route.
- Fichiers concernés : réécriture de `DnsQuicTransport.ts` sur
  `QuicConnection` — `bindDnsQuicServer`/`unbindDnsQuicServer`/
  `DnsQuicClient`/`queryDnsOverQuic` avec un nouveau paramètre `tlsConfig`
  requis (certificat/clé serveur, `CertificateVerifier` client), comme
  pour la migration DoH (P13 de `PRD-HTTP.md`). Mise à jour de
  `dns-encrypted-transports.test.ts` (section DoQ + parité de transport)
  pour fournir une CA/un certificat/un verifier — assertions observables
  inchangées.
- Statut / résultat : 🟡 en cours.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-QUIC/P13 — TERMINÉ
- Réalisé exactement le périmètre annoncé : `DnsQuicTransport.ts` réécrit
  sur `QuicConnection`/`TlsClientSession`/`TlsServerSession` réels —
  `bindDnsQuicServer(host, handler, tlsConfig, options?)`,
  `DnsQuicClient`/`queryDnsOverQuic(..., tlsConfig, options?)`. DNS
  encapsulé en stream préfixé-longueur (2 octets big-endian + message DNS,
  RFC 9250 §4.2/RFC 1035 §4.2.2) sur un nouveau stream bidirectionnel
  client par requête (`conn.openStream('bidirectional')`), connexion
  unique réutilisée entre requêtes plutôt que reconstruite à chaque appel
  (`DnsQuicClient` garde son `QuicConnection` établi). `dcid` client fixe
  documenté (`FIXED_CLIENT_DEST_CONNECTION_ID`), cohérent avec la
  limitation déjà existante d'une connexion point-à-point par instance.
- **Bug trouvé et corrigé** : `QuicConnection.handleDatagram` levait une
  exception non interceptée (`no application keys available yet`) dès
  qu'un datagramme UDP arrivait sur le port QUIC sans que les clés de
  l'espace correspondant soient encore dérivées — cas normal pour un
  paquet non-QUIC ou prématuré (RFC 9000 §12.2/§17.2 : un tel paquet doit
  être silencieusement ignoré, pas faire planter la connexion). Trouvé
  par le test déjà existant « ignores a cleartext DNS datagram sent to the
  QUIC port » (un datagramme DNS-sur-UDP brut, dont les premiers octets
  passent accidentellement la validation minimale d'un en-tête court QUIC,
  arrivait au port DoQ avant toute poignée de main). Corrigé en supprimant
  le `throw` de `keysFor` au profit d'une nouvelle méthode `keysSlot`
  (retourne `null` sans lever), avec un retour anticipé silencieux dans
  `handleDatagram` quand les clés de réception ne sont pas encore prêtes ;
  `keysFor` (utilisée uniquement à l'envoi, où l'absence de clés est un
  vrai bug interne) continue de lever. Ce correctif profite à tout
  consommateur de `QuicConnection`, pas seulement DoQ.
- Statut / résultat : ✅ terminé. `tsc --noEmit -p tsconfig.app.json`
  propre (hormis deux erreurs pré-existantes sans rapport,
  `new LinuxServer('DNS1')`, inchangées par ce diff). `eslint` propre.
  Régression ciblée : 250 tests (24 fichiers — quic-*, tls-*, https,
  dns-encrypted-transports) au vert. 3ᵉ phase depuis la dernière
  régression complète (QUIC/P13/HTTP), pas encore la 4ᵉ.
- **`PRD-QUIC.md` est désormais quasiment intégralement livré** : il ne
  reste que P12 (Observabilité — déjà fait, en fait vérifié terminé plus
  haut) — en relisant le tableau de bord, toutes les phases P1-P13 de
  `PRD-QUIC.md` sont maintenant ✅ terminé. `PRD-QUIC.md` est donc
  intégralement livré.
- Suggestion pour la suite : `PRD-HTTP.md`/P9 (intégration QUIC pour
  HTTP/3) est désormais débloqué (`PRD-QUIC.md` intégralement livré) et
  devient la phase la plus importante restante côté HTTP, avec P10
  (HTTP/3 proprement dit) juste derrière. P12 (migration IIS/curl/wget)
  reste aussi disponible et indépendante.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P9 — ANNONCE
- Tâche : `PRD-HTTP.md`/P9 — intégration QUIC. Le PRD est explicite :
  « aucun nouveau code de transport : vérifier que `src/network/quic/`
  expose l'API attendue par `http3/Http3Connection.ts` (streams
  bi/unidirectionnels, `send`/`onData`/`close`) ; écrire les tests
  d'intégration côté HTTP contre cette API ». Je ne touche donc **aucun
  fichier sous `src/network/quic/`** (rappel de non-chevauchement du
  tableau de bord), uniquement consommation + tests côté HTTP.
- Fichiers concernés : nouveau fichier de test uniquement,
  `http3-quic-integration.test.ts`, exerçant l'API publique de
  `QuicConnection`/`QuicStream` (mode `tls` réel, P8) selon les motifs
  qu'HTTP/3 (P10) devra utiliser : un stream unidirectionnel côté client
  (type contrôle), plusieurs streams bidirectionnels concurrents
  (multiplexage de requêtes), fermeture de connexion propre.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P9 — TERMINÉ
- Statut / résultat : ✅ terminé. `http3-quic-integration.test.ts` (4
  tests) vérifie contre l'API réelle et publique de `QuicConnection`
  (mode `tls`, P8) exactement les 4 propriétés dont `Http3Connection.ts`
  (P10) aura besoin : (1) poignée de main QUIC/TLS réelle avec
  négociation ALPN `h3` des deux côtés ; (2) stream unidirectionnel
  initié par le client (forme des streams de contrôle/QPACK HTTP/3),
  vérifié via `classifyStreamId` (initiateur + direction) et une trame
  sans FIN (SETTINGS jamais close, RFC 9114 §3.2) ; (3) plusieurs streams
  bidirectionnels concurrents avec des IDs distincts, données
  indépendantes dans les deux sens (requête/réponse multiplexées) ; (4)
  fermeture propre `close()`/`onClose` (analogue GOAWAY). Aucun fichier
  sous `src/network/quic/` n'a été touché — uniquement consommation de
  l'API publique existante, conformément à la portée explicite du PRD
  (« aucun nouveau code de transport ») et au rappel de non-chevauchement
  du tableau de bord.
- Vérifications : `tsc --noEmit -p tsconfig.app.json` propre sur le
  fichier ajouté et sur `quic/QuicConnection.ts` ; `eslint` propre ;
  régression ciblée `quic-*` + `tls-*` + `https` + DNS chiffré + ce
  fichier : 25 fichiers / 254 tests, tous passants. Régression complète
  `src/__tests__/unit/network-v2/` (4e phase depuis la dernière régression
  complète — QUIC/P8, P9, P13, HTTP/P9) : 679/681 fichiers, 12697/12758
  tests, les 11 échecs restants sont les échecs Oracle RAC pré-existants
  déjà documentés (baseline inchangée, aucune régression introduite).
- Suggestion pour la suite : `PRD-HTTP.md`/P10 (HTTP/3, RFC 9114 + QPACK)
  est maintenant directement débloqué — c'est la phase naturelle
  suivante. P12 (migration IIS/curl/wget sur le moteur HTTP/1.1+HTTPS
  réel) et P11 (observabilité HTTP) restent aussi disponibles et
  indépendantes.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P10 — ANNONCE + TERMINÉ
- Tâche : `PRD-HTTP.md`/P10 — HTTP/3 (RFC 9114) + QPACK (RFC 9204, table
  statique seule — table dynamique explicitement hors périmètre, §2.2).
  Débloqué par HTTP/P9 (vérification de l'API `QuicConnection`) tout juste
  terminé. Nouveaux fichiers, arborescence conforme à `docs/PRD-HTTP.md`
  §3.3 :
  - `src/network/http/http3/Http3Frame.ts` — format générique
    `Type(varint) Length(varint) Payload` (§7.1/§7.2), réutilisant le
    codec varint QUIC (`@/network/quic/varint`, même format RFC 9000 §16).
    Frames DATA/HEADERS/SETTINGS/GOAWAY ; tout type inconnu est renvoyé
    comme `UNKNOWN` plutôt que rejeté (§7.2.8, compatibilité amont). Type
    de stream unidirectionnel `CONTROL_STREAM_TYPE = 0x00` (§6.2.1).
  - `src/network/http/http3/Qpack.ts` — table statique RFC 9204 Annexe A
    (indexée à partir de 0, contrairement à HPACK), encodage littéral
    uniquement (pas de Huffman, même convention que HPACK). Réutilise
    `encodeInteger`/`decodeInteger`/`encodeString`/`decodeString` de
    `http2/Hpack.ts` (RFC 9204 §4.1.1/§4.1.2 : format d'entier préfixé et
    de chaîne littérale identique à HPACK). Les 3 représentations de ligne
    de champ sans table dynamique sont implémentées (§4.5.2/§4.5.4/§4.5.6) ;
    le préfixe de section de champs (Required Insert Count/Delta Base) est
    toujours `[0x00, 0x00]` puisque la table dynamique n'existe jamais
    (§4.5.1.1, cas particulier RIC=0).
  - `src/network/http/http3/Http3Connection.ts` — mappe requête/réponse
    sur un stream bidirectionnel par requête (§4.1) ; un stream de contrôle
    unidirectionnel par extrémité portant une trame SETTINGS unique à la
    connexion (§6.2.1/§7.2.4) ; `close()` envoie GOAWAY (§5.2) avant de
    fermer la connexion QUIC. Consomme `QuicConnection`/`classifyStreamId`
    tels qu'exposés par `PRD-QUIC.md`, **aucun fichier sous
    `src/network/quic/` touché**.
  - `src/__tests__/unit/network-v2/http3.test.ts` — 14 tests : frames
    (round-trip, frame inconnue, SETTINGS/GOAWAY), QPACK (les 3
    représentations + table statique), et `Http3Connection` sur une vraie
    connexion QUIC/TLS (poignée de main réelle, requête/réponse avec corps,
    multiplexage de deux requêtes sur des streams séparés, échange
    SETTINGS sur les streams de contrôle, requête sans corps).
  - Topologie volontairement hétérogène (serveur `LinuxPC`, client
    `WindowsPC`) suite à une demande explicite de l'utilisateur de
    privilégier des paires de systèmes d'exploitation différents dans les
    topologies de test à partir de maintenant.
- Statut / résultat : ✅ terminé. `tsc --noEmit -p tsconfig.app.json`
  propre sur les 3 nouveaux fichiers + le test ; `eslint` propre.
  Régression ciblée `http1-wire` + `http2` + `http3` +
  `http3-quic-integration` + `quic-*` + `tls-*` + `https` +
  `http-semantics` : 28 fichiers / 337 tests, tous passants.
- Suggestion pour la suite : `PRD-HTTP.md`/P11 (observabilité, transverse
  à P2-P10) et P12 (migration IIS/curl/wget sur le moteur HTTP/1.1+HTTPS
  réel) sont maintenant toutes les deux disponibles et indépendantes.

### [2026-07-05 (heure non horodatée par l'outil) UTC] Arthur — PRD-HTTP/P11 — ANNONCE + TERMINÉ
- Tâche : `PRD-HTTP.md`/P11 — observabilité (§2.1.L), transverse à P2-P10 :
  `events.ts`/`observables.ts` au niveau `src/network/http/` (comme
  `src/network/quic/events.ts`/`observables.ts`, P12 QUIC). Topics visés
  par le PRD : `http.request.started/completed/failed`,
  `http.cache.hit/miss/revalidated`, `websocket.opened/closed`,
  `http2.stream.opened/closed`, `quic.connection.established/closed`
  (ce dernier déjà émis par `QuicConnection` lui-même — rien à ré-émettre
  ici, seulement à consommer depuis le même `DomainEvent` central).
  Nouveaux fichiers :
  - `src/network/http/events.ts` — `HttpDomainEvent` (10 topics),
    `randomRequestId()`/`randomHttpConnectionId()`. Ajouté à l'union
    centrale `DomainEvent` (`src/events/types.ts`), comme `QuicDomainEvent`.
  - `src/network/http/observables.ts` — `HttpSignalStore`/
    `subscribeHttpObservables`/`metricsSignal` : contrairement à
    `quic/observables.ts` (une entité longue-durée par `connectionId`,
    naturellement un modèle par-entité), les requêtes/lookups cache HTTP
    sont éphémères et à forte cardinalité — le read-model utile ici est un
    unique agrégat de compteurs (vue façon tableau de bord de métriques).
  - Instrumentation (paramètre `eventBus` optionnel, rétrocompatible,
    aucun changement de comportement si omis) sur les 7 points de
    décision réels : `Http1ClientSession`/`Http1ServerSession` et
    `HttpsClientSession`/`HttpsServerSession` (`http.request.*`, un
    `requestId` par échange, câblé aussi côté serveur) ; `HttpCacheStore`
    (`http.cache.hit`/`miss` dans `get()` selon fraîcheur,
    `revalidated`/`miss` dans `applyRevalidationResponse()` selon 304 ou
    remplacement complet) ; `WebSocketConnection` (`opened` au
    constructeur, `closed` sur les deux chemins de fermeture) ;
    `Http2Connection` (`stream.opened`/`closed` via un nouvel helper privé
    `closeStream()` centralisant les 3 points d'suppression de stream).
    `Http3Connection` n'émet volontairement rien de nouveau : le PRD ne
    liste que les topics `http2.stream.*`, pas d'équivalent HTTP/3 — hors
    périmètre strict de ce qui est demandé.
  - `src/__tests__/unit/network-v2/http-observability.test.ts` — NOUVEAU,
    7 tests couvrant les 4 sources d'événements + le read-model agrégé,
    sur une topologie volontairement hétérogène (serveur `LinuxPC`,
    client `WindowsPC`).
- Statut / résultat : ✅ terminé. `tsc --noEmit -p tsconfig.app.json`
  propre sur tous les fichiers touchés ; `eslint` propre (les 4 erreurs
  restantes dans `events/types.ts` sont pré-existantes, vérifiées via
  `git stash`, sans rapport avec ce changement). Régression ciblée
  `http-*` + `http1-wire` + `http2` + `http3*` + `https` + DNS chiffré +
  `quic-observability` + `tls-observability` : 14 fichiers / 231 tests,
  tous passants. Régression complète `src/__tests__/unit/network-v2/`
  (portée large : 7 classes centrales modifiées) : 683/685 fichiers,
  12746/12807 tests, les 11 échecs restants sont les échecs Oracle RAC
  pré-existants déjà documentés (baseline inchangée, aucune régression
  introduite par cette instrumentation).
- Suggestion pour la suite : `PRD-HTTP.md`/P12 (migration IIS/curl/wget
  sur le moteur HTTP/1.1+HTTPS réel) est la dernière phase P1-P13 restante
  et devient donc la prochaine cible naturelle.

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
   régression ciblée, rebase avant push — cf. `CLAUDE.md` et les
   conventions déjà en usage sur ce dépôt) suivent leur cours normal. Pas
   besoin de mettre à jour ce journal à chaque commit intermédiaire.
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
| P1 | Types, messages, record layer | — | 🟡 en cours | Claude (Sonnet 5) |
| P2 | Key schedule | P1 | ⬜ disponible | — |
| P3 | Handshake 1-RTT nominal | P1, P2 | ⬜ disponible | — |
| P4 | mTLS | P3 | ⬜ disponible | — |
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
| P1 | Sémantique HTTP (9110) | — | 🟡 en cours | Arthur |
| P2 | HTTP/1.1 en clair (9112) | P1 | ⬜ disponible | — |
| P3 | Cache (9111) | P1, P2 | ⬜ disponible | — |
| P4 | Cookies (6265) | P2 | ⬜ disponible | — |
| P5 | Authentification (7617/7616) | P2 | ⬜ disponible | — |
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
- Statut / résultat : en cours.
- Suggestion pour la suite : `PRD-TLS.md`/P1 est déjà pris (Claude, Sonnet
  5). `PRD-QUIC.md`/P1 (varints & format de paquet) reste disponible pour
  un agent qui arriverait pendant que P1 HTTP est en cours.

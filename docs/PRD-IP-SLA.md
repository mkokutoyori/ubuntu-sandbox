# PRD — IP SLA (Cisco IOS), sondes actives réelles et suivi d'objets

## 0. Contexte et portée

IP SLA est le mécanisme par lequel un routeur Cisco **génère lui-même du
trafic de mesure** vers une cible, en mesure le résultat (RTT, perte,
gigue, code de retour), et **agit** sur ce résultat : abaisser un objet
`track` qui conditionne une route flottante, émettre un trap SNMP,
déclencher un applet EEM. C'est la brique de base de tout lab de bascule
WAN — « la route par défaut tombe quand la sonde ne répond plus » — et
c'est le seul sous-système du simulateur qui prétende aujourd'hui faire
cela sans jamais émettre un paquet.

Ce PRD couvre :

- `src/network/devices/inspection/config/IpSlaRepository.ts` (état des
  opérations) et `TrackRepository.ts` (objets suivis),
- `src/network/devices/shells/cisco/CiscoTrackSlaCommands.ts` (surface CLI),
- le moteur de sondes à créer, son responder, ses statistiques, ses
  réactions, et leurs projections (`show`, running-config, syslog, SNMP).

### 0.1 Le constat qui motive ce document

L'implémentation actuelle **n'est pas une simplification, c'est une
inversion** : elle répond à la question « la cible est-elle joignable ? »
en consultant la table de routage locale, c'est-à-dire en demandant à la
machine ce qu'elle *croit*, alors que l'objet même d'une sonde active est
de découvrir que ce que la machine croit est faux.

`IpSlaRepository.ipReachable()` (lignes 24-49) parcourt
`router.getRoutingTable()` et renvoie `true` dès qu'un préfixe couvre la
cible et que son interface de sortie est `isOperationallyUp()`. Les
conséquences sont mesurables et toutes fausses :

| Situation réelle | Ce que dit IOS | Ce que dit le simulateur aujourd'hui |
|---|---|---|
| Cible éteinte, câble et route intacts | `Timeout`, track Down | **reachable**, track Up |
| Routeur intermédiaire qui blackhole | `Timeout`, track Down | **reachable**, track Up |
| ACL qui bloque l'ICMP en retour | `Timeout`, track Down | **reachable**, track Up |
| Cible vivante, route via une seconde interface | `OK`, track Up | reachable, track Up (juste par accident) |
| `frequency 5` configuré | une sonde toutes les 5 s | **aucune sonde, jamais** |

Autrement dit : le seul cas où l'état est correct est celui où la panne
est *déjà* visible dans la table de routage — exactement le cas où IP SLA
ne sert à rien. Le lab canonique de ce sous-système (`ip route 0.0.0.0
0.0.0.0 <ISP1> track 1` bascule vers l'ISP2 quand la sonde vers 8.8.8.8
ne répond plus, sans que le lien ISP1 tombe) **ne peut pas fonctionner**,
et `scenario-cisco-nat-dual-wan-failover.test.ts` ne le teste pas.

Le reste est du même ordre, et vérifié ligne à ligne :

1. **Aucune notion de temps.** `frequency` est stockée
   (`IpSlaRepository.ts:19`) et lue seulement par le rendu de
   `show ip sla configuration`. Aucun `setInterval`, aucun import de
   `@/events/Scheduler` sous `inspection/config/`. `ip sla schedule
   1 life forever start-time now` positionne un booléen `scheduled`.
2. **Aucune statistique.** Pas de RTT (il n'y a rien à mesurer), pas de
   compteur de succès/échecs, pas de distribution, pas d'historique. Le
   `show ip sla statistics` rend trois lignes dont un
   `(reachable)`/`(unreachable)` qui n'existe dans aucune sortie IOS.
3. **`timeout`/`threshold` sont du décor.** Écrits dans un sac de
   propriétés non typé (`op as unknown as Record<string, unknown>`,
   ligne 230), rendus par `show`, lus par aucune logique.
4. **Les réactions ne réagissent pas.** `SlaReactionConfiguration` est
   stockée et rendue dans un format inventé
   (`Op 1 react=timeout thresh-type=…`), jamais évaluée : aucun trap,
   aucun syslog, `ip sla reaction-trigger` n'existe pas.
5. **Le responder n'écoute rien.** `ip sla responder` met un booléen à
   `true`. Aucun port n'est ouvert, l'IP SLA Control Protocol (UDP/1967)
   n'existe pas, et donc `udp-jitter`/`udp-echo` ne peuvent avoir aucune
   sémantique même de principe.
6. **`track` hérite du mensonge.** `TrackRepository.state()` pour
   `ipsla-reach` **et** `ipsla-state` appelle le même
   `sla.reachable()` — les deux formes de suivi que IOS distingue
   (`reachability` : l'opération répond ; `state` : l'opération est
   sous ses seuils) sont confondues.
7. **`track` ignore `delay up`/`delay down`.** Les champs sont parsés
   (`CiscoTrackSlaCommands.ts:189-198`) et lus nulle part, alors que
   c'est précisément l'anti-rebond qui empêche une route de battre.
8. **Rien n'est dans la running-config.** `showRunningConfig()`
   (`CiscoShowCommands.ts:282`) n'émet ni `ip sla`, ni `ip sla
   schedule`, ni `track`. Une topologie sauvegardée perd toute la
   configuration IP SLA **et** tous les objets suivis, y compris ceux
   dont dépendent des routes statiques `track`-conditionnées qui, elles,
   sont sauvegardées — la topologie rechargée a donc des routes
   conditionnées par des objets qui n'existent plus.
9. **`show track` ne dit pas ce que IOS dit.** Pas de compteur de
   changements, pas de « last change », pas de section `Tracked by:`.
10. **Aucun événement, aucun log.** Ni `%TRACKING-5-STATE`, ni
    `%RTT-3-IPSLATHRESHOLD`, donc aucun déclenchement EEM possible
    (`EemEngine` s'abonne à `device.syslog.entry`), et aucune trace
    dans le journal réseau.

### 0.2 Chaîne de dépendances

Ce qui est **déjà réel** et sur quoi ce PRD s'appuie sans y toucher :

- **`Router.processIPv4`/`handleSelfDestined`** (`Router.ts:1763-1889`) :
  ICMP echo-request → echo-reply est un vrai aller-retour de trames, et
  l'arrivée d'un echo-reply publie `host.icmp.echo-reply` sur le bus
  (`emitIcmpEchoReply`, ligne 3835). Une sonde ICMP émise par le moteur
  peut donc se régler exactement comme `_sendPing` le fait déjà
  (corrélation par `id`/`seq` via `waitForEvent`).
- **`Router._sendIkeUdp`/`_sendNatTKeepalive`** (lignes 1893-1941) :
  patron établi d'émission d'un datagramme UDP depuis un routeur, à
  travers la FIB, avec résolution ARP par cache. Les sondes UDP le
  suivront.
- **`Router.tcpConnect`** (ligne 617) : vraie poignée de main TCP,
  résolue quand elle aboutit *ou* quand elle est refusée. C'est
  exactement la mesure que fait `tcp-connect`.
- **`dialHttp`** (`src/network/http/HttpClient.ts`) prend une `TcpStack`,
  que `Router.getTcpStack()` expose. L'opération `http` a donc un vrai
  client HTTP/1.1 RFC 9112 derrière elle.
- **`src/network/dns/wire/`** encode/décode de vrais messages DNS
  (`encodeDnsMessage`/`decodeDnsMessage`, `Uint8Array`). L'opération
  `dns` peut émettre une vraie requête.
- **`SnmpAgent.registerMib(oid, fn)` et `sendTrap(oid, varbinds)`**
  (`SnmpAgent.ts:97,137`) : point d'accroche existant pour
  CISCO-RTTMON-MIB et ses notifications.
- **`LoggingConfig.append(severity, tag, text, republish, mnemonic)`**
  (`LoggingConfig.ts:305`) publie `device.syslog.entry`, auquel
  `EemEngine` est déjà abonné. Un `%TRACKING-5-STATE` émis par ce
  chemin devient déclencheur EEM sans une ligne de code EEM.
- **`Router.setRouteTrackResolver`** (ligne 671) : la couture par
  laquelle une route statique consulte déjà un objet `track`. Elle est
  correcte ; c'est la réponse qu'elle obtient qui ne l'est pas.
- **`src/events/Scheduler`** (`VirtualTimeScheduler`) : c'est ce qui
  rend une fonctionnalité fondée sur des minuteries **testable**
  déterministiquement, et c'est la raison pour laquelle ce PRD peut
  exiger de vraies minuteries plutôt que de s'en dispenser.
- **`KeyChainRepository`** (`CiscoKeyChainCommands.ts`) : existe, et
  porte les clés que `ip sla key-chain` authentifierait.

---

## 1. Références normatives

Une sonde active n'invente pas ses formules ; elle en applique. Chaque
mesure produite par ce moteur doit pouvoir se rattacher à un texte.

| Référence | Ce qu'elle fixe ici |
|---|---|
| **RFC 792** | ICMP Echo/Echo Reply : la sonde `icmp-echo`, l'appariement `id`/`sequence`, le sens de `Destination Unreachable` comme échec immédiat plutôt qu'attente du timeout |
| **RFC 862** | Echo Protocol : `udp-echo` renvoie le datagramme reçu tel quel, sur le port 7 en l'absence de responder |
| **RFC 2681** | *A Round-trip Delay Metric for IPPM* : définition du RTT mesuré (instant de premier bit émis → instant de dernier bit reçu), et surtout la règle qu'un paquet perdu rend le RTT **indéfini** et non « très grand » — d'où un `Timeout` distinct d'un RTT élevé |
| **RFC 3393** | *IP Packet Delay Variation Metric* : la gigue est une différence de délais de deux paquets, signée ; fonde les compteurs positifs/négatifs séparés d'IOS |
| **RFC 3550 §6.4.1** | Estimateur de gigue d'interarrivée `J += (|D(i-1,i)| - J)/16` ; rendu comme `Interarrival jitterout/in` |
| **RFC 1889** | Prédécesseur de RFC 3550 ; c'est la référence historiquement citée par la documentation Cisco pour la gigue IP SLA, conservée ici pour la traçabilité |
| **ITU-T G.107** | E-model : `R = Ro - Is - Id - Ie_eff + A`, et la conversion R → MOS. Base du score MOS de `udp-jitter` avec codec |
| **ITU-T G.113 App. I** | Facteurs de dégradation `Ie` par codec et `Bpl` (robustesse à la perte) : G.711 `Ie=0, Bpl=4.3` ; G.729A `Ie=11, Bpl=19` |
| **ITU-T G.114** | Recommandation de délai unidirectionnel (≤150 ms acceptable) : c'est le repère qui donne son sens au calcul `Id` |
| **CISCO-RTTMON-MIB** | Tables `rttMonCtrlAdmin`, `rttMonEchoAdmin`, `rttMonCtrlOper`, `rttMonLatestRttOper`, `rttMonJitterStats` et notifications `rttMonNotificationsPrefix` (1.3.6.1.4.1.9.9.42.2.0) |
| **RFC 5357 (TWAMP)** | Cité pour délimiter : `ip sla responder twamp` est **hors périmètre** (§6), et ce PRD ne prétend pas que le control protocol implémenté en soit une variante |

**Une honnêteté nécessaire sur l'IP SLA Control Protocol** : il est
propriétaire Cisco et non publié. Ce qui en est public et vérifiable est
son *comportement observable* : port UDP/1967, échange requête/accusé
avant la sonde, ouverture d'un port éphémère sur le responder pour la
durée de l'opération, authentification optionnelle par key-chain MD5,
et le fait qu'il soit désactivable par `control disable` (auquel cas la
sonde vise directement un port fixe). Ce PRD spécifie **ce
comportement**, avec une PDU interne à ce simulateur — au même titre que
les autres agents de ce dépôt qui transportent des objets typés plutôt
que des octets. Le document dit ce qu'il fait ; il ne prétendra nulle
part reproduire un format d'octets qu'il ne connaît pas.

---

## 2. Modèle fonctionnel

### 2.1 Cycle de vie d'une opération

Une opération IP SLA passe par des états que IOS nomme et affiche
(`rttMonCtrlOperState`, rendu par `show ip sla summary` avec ses codes
`*` actif / `^` inactif / `~` en attente) :

```
                 ip sla <n>            ip sla schedule <n> start-time now
   (inexistante) ───────────▶ Pending ────────────────────────────▶ Active
                                 │ ▲                                  │
       ip sla schedule … pending │ │ ip sla restart <n>               │ life écoulée
       ou start-time <futur>     │ │                                  ▼
                                 │ └──────────────────────────── Inactive
                                 │                                    │
                                 │      ageout écoulé                 │
                                 ◀────────────────────────────────────┘
                                          (l'entrée est SUPPRIMÉE)
```

Règles à respecter, chacune observable :

- Une opération **configurée mais non planifiée** est `Pending`. Elle
  n'émet rien. C'est l'état par défaut, et c'est pourquoi un lab qui
  oublie `ip sla schedule` doit continuer à ne rien mesurer.
- `start-time now` fait passer à `Active` immédiatement ; `start-time
  after hh:mm:ss` et `start-time hh:mm[:ss]` programment la transition.
- `life` par défaut vaut **3600 secondes**, pas l'infini. `life forever`
  est explicite. À l'expiration, l'opération devient `Inactive` : elle
  cesse d'émettre mais **conserve ses statistiques**, qui restent
  lisibles — c'est la différence entre `Inactive` et supprimée.
- `ageout <n>` (défaut 0 = jamais) supprime l'entrée après `n` secondes
  passées sans être active. `ageout` et `life forever` sont
  mutuellement incompatibles sur IOS et la commande est refusée.
- `recurring` réarme le départ chaque jour à la même heure ; exige un
  `life` inférieur à 24 h.

### 2.2 Cycle de vie d'une sonde (une itération)

À chaque échéance `frequency` :

1. **Résolution de la source.** `source-interface` / `source-ip`
   imposent l'adresse source ; sinon elle vient de l'interface de sortie
   choisie par la FIB. Une `source-interface` qui n'est pas
   opérationnelle fait échouer la sonde immédiatement en `Not connected`
   — sans attendre le timeout, parce qu'aucun paquet n'est parti.
2. **Émission** du (ou des) paquets propres au type d'opération.
3. **Attente** bornée par `timeout` (défaut 5000 ms, 60000 ms pour
   `http`).
4. **Verdict** — un code de retour, jamais un booléen (§2.3).
5. **Comptabilisation** : RTT dans les agrégats et la distribution,
   incrément du compteur adéquat, entrée d'historique si activé.
6. **Évaluation des réactions** configurées sur cette opération (§4).
7. **Publication** des événements de bus, et syslog si un franchissement
   de seuil a eu lieu.

Une itération dont la précédente n'est pas terminée n'est pas empilée :
IOS saute le cycle. Si `frequency` est inférieure à `timeout`, IOS
l'accepte mais avertit, et une sonde en cours fait sauter le tick
suivant — ce comportement doit être reproduit, sans quoi une
configuration `frequency 1 timeout 5000` produirait cinq sondes
simultanées qui n'existent pas.

### 2.3 Codes de retour

Le résultat d'une sonde n'est pas « ça marche / ça ne marche pas ».
`rttMonLatestRttOperSense` a onze valeurs ; celles qui ont un sens ici :

| Sense | Nom IOS affiché | Quand |
|---|---|---|
| 1 | `OK` | Réponse reçue dans les temps et sous le seuil |
| 3 | `Over threshold` | Réponse reçue, mais RTT > `threshold` |
| 4 | `Timeout` | Aucune réponse dans `timeout` |
| 6 | `Not connected` | Rien n'a pu partir (interface source down, pas de route, ARP non résolue) |
| 7 | `Dropped` | Rejet explicite reçu (ICMP unreachable, TCP RST, refus du responder) |
| 8 | `Sequence error` | `udp-jitter` : paquets reçus hors séquence |
| 9 | `Verify error` | `verify-data` actif et charge utile altérée |
| 10 | `Application specific error` | Code applicatif non conforme (HTTP ≠ 2xx, DNS RCODE ≠ 0) |

La distinction `Over threshold` / `OK` est essentielle : c'est elle qui
sépare `track … state` de `track … reachability` (§5), et c'est
exactement ce que l'implémentation actuelle a fusionné.

**`threshold` n'est pas `timeout`.** `threshold` (défaut 5000 ms) ne fait
échouer aucune sonde ; il marque un dépassement, alimente les réactions
et fait chuter un `track … state`. `timeout` (défaut 5000 ms) est la
durée après laquelle la sonde est déclarée perdue. Les confondre est
l'erreur classique, et les deux valent 5000 par défaut, ce qui la rend
invisible tant qu'on ne les configure pas.

---

## 3. Types d'opérations

### 3.1 Périmètre retenu

| Type | Transport réel disponible | Retenu |
|---|---|---|
| `icmp-echo` | ICMP echo/reply réel (`Router.handleSelfDestined`) | **Oui** |
| `udp-echo` | UDP réel + responder | **Oui** |
| `udp-jitter` | UDP réel + responder + horodatages | **Oui** |
| `udp-jitter … codec` | idem + E-model G.107 | **Oui** |
| `tcp-connect` | `Router.tcpConnect` (vraie poignée de main) | **Oui** |
| `http` | `dialHttp` sur `Router.getTcpStack()` | **Oui** |
| `dns` | `src/network/dns/wire` (vrais octets) | **Oui** |
| `icmp-jitter` | ICMP réel, horodatages côté émetteur seulement | **Oui**, avec la limite de §3.7 |
| `path-echo` | ICMP TTL croissant (`executeTraceroute` existe) | **Oui** |
| `path-jitter` | exigerait gigue par saut | Non — §6 |
| `ftp`, `dhcp` | aucun client FTP/DHCP côté routeur | Non — §6 |
| `voip` (rtp, gatekeeper, post-dial-delay) | aucune pile RTP/H.323 | Non — §6 |
| `mpls lsp ping/trace` | aucun plan MPLS | Non — §6 |
| `ethernet y1731` | aucun OAM 802.1ag | Non — §6 |

### 3.2 `icmp-echo`

Un echo-request par cycle, `id` propre à l'opération, `sequence`
incrémentée. Défauts IOS : `frequency 60`, `timeout 5000`,
`threshold 5000`, `request-data-size 28` (charge ICMP, ce qui donne bien
un datagramme IP de 56 octets), `tos 0`.

Verdicts : réponse → `OK`/`Over threshold` ; `Destination Unreachable`
reçu → `Dropped` **immédiatement** (le paquet a bien reçu une réponse,
négative — c'est plus rapide et plus juste qu'un timeout) ; rien →
`Timeout`.

`verify-data` : la charge est un motif déterministe dérivé de
`(opId, sequence)` ; au retour, une charge qui ne correspond pas donne
`Verify error`. Comme le simulateur ne corrompt pas les octets ICMP, ce
cas n'est atteignable que via `Cable.setCorruptionRate` — et une trame
corrompue n'arrive jamais (§ CLAUDE.md, `hardware/Cable.ts`), donc elle
produira un `Timeout`, pas un `Verify error`. **Ce fait est écrit ici
plutôt que laissé à découvrir** : `verify-data` est accepté, appliqué,
et structurellement inatteignable en l'état ; il le deviendra le jour où
une corruption de charge utile (et non de trame) existera.

### 3.3 `udp-echo`

Un datagramme UDP vers `<ip> <port>`. Deux modes, et la différence est
observable :

- **Avec responder** (défaut) : négociation par le control protocol
  (§3.8), puis le responder renvoie le datagramme depuis le port
  négocié en soustrayant son propre temps de traitement — le RTT
  mesuré exclut donc la latence de la cible.
- **`control disable`** : aucune négociation ; le datagramme part vers
  le port configuré, et il faut que quelque chose y écoute (RFC 862 sur
  le port 7). Sans écouteur, `Timeout` — et non `Dropped`, car ce
  simulateur ne génère pas d'ICMP Port Unreachable depuis un routeur
  pour un port UDP fermé (`Router.ts:1888` : « Other UDP ports silently
  dropped »). Écrit ici pour que le résultat ne passe pas pour un bug.

Défaut `request-data-size 16`.

### 3.4 `udp-jitter` — le cœur du sujet

`num-packets` datagrammes (défaut 10) espacés de `interval` ms (défaut
20), une seule fois par cycle `frequency`. Chaque paquet porte son numéro
de séquence et quatre horodatages :

| | Posé par | Signification |
|---|---|---|
| T1 | émetteur, à l'émission | départ |
| T2 | responder, à la réception | arrivée aller |
| T3 | responder, à la réémission | départ retour |
| T4 | émetteur, à la réception | arrivée retour |

D'où :

```
RTT          = (T4 - T1) - (T3 - T2)      ← le temps de traitement du
                                             responder est retiré
Aller (SD)   = T2 - T1
Retour (DS)  = T4 - T3
```

**Les valeurs unidirectionnelles n'ont de sens que si les deux horloges
sont synchronisées.** IOS ne les invente pas : sans NTP, il rapporte
`Number of SD/DS samples 0`. Ce moteur fera de même — la PDU du
responder porte son état de synchronisation (`NtpAgent`, déjà présent
sur `CiscoRouter`), et les échantillons unidirectionnels ne sont
comptabilisés que si les deux extrémités se déclarent synchronisées. Un
lab qui veut du one-way delay devra donc **vraiment** configurer NTP,
ce qui est le comportement réel et la seule façon honnête de rendre la
mesure.

**Gigue.** Pour deux paquets consécutifs `i-1, i` reçus, IOS calcule
séparément par direction :

```
D_SD(i) = (T2ᵢ - T2ᵢ₋₁) - (T1ᵢ - T1ᵢ₋₁)
D_DS(i) = (T4ᵢ - T4ᵢ₋₁) - (T3ᵢ - T3ᵢ₋₁)
```

et **ne moyenne pas les signes ensemble** : il maintient, par direction,
`NumOfPositives`/`SumOfPositives`/`Positives Min|Max` et le pendant
négatif, plus min/avg/max de |D|. C'est la conséquence directe de
RFC 3393 (la variation de délai est signée) et c'est ce que les sorties
IOS montrent. L'estimateur lissé RFC 3550 §6.4.1
(`J += (|D| - J)/16`) est calculé en plus et rendu comme
`Interarrival jitterout/in`.

**Pertes.** IOS distingue quatre causes, et les confondre supprime toute
capacité de diagnostic :

| Compteur | Sens |
|---|---|
| `PacketLossSD` | Le responder ne l'a jamais vu (trou dans les numéros côté responder) |
| `PacketLossDS` | Le responder l'a vu, l'émetteur n'a pas reçu le retour |
| `PacketOutOfSequence` | Reçu, mais après un paquet de numéro supérieur |
| `PacketLateArrival` | Reçu après l'expiration du timeout de l'opération |
| `PacketMIA` | Perdu sans qu'on puisse dire dans quel sens (pas d'info responder) |

La distinction SD/DS n'est possible que parce que le responder rapporte,
dans chaque réponse, le plus grand numéro de séquence qu'il a reçu ; un
trou en dessous de ce maximum est une perte aller, un paquet dont on sait
qu'il a été renvoyé mais jamais reçu est une perte retour. Sans
responder (`control disable` vers un echo RFC 862), seul `PacketMIA` est
renseignable, et c'est ce que ce moteur fera.

**MOS et ICPIF** (uniquement si `codec` est configuré). E-model ITU-T
G.107 :

```
Ppl      = pourcentage de perte total
Ie_eff   = Ie + (95 - Ie) · Ppl / (Ppl/BurstR + Bpl)        (G.107 §)
Ta       = délai unidirectionnel (ms), = RTT/2 si pas de one-way valide
Id       = 0                                    si Ta < 100
         = 0.024·Ta + 0.11·(Ta - 177.3)·H(Ta - 177.3)  sinon
R        = 93.2 - Id - Ie_eff
MOS      = 1                                    si R < 0
         = 4.5                                  si R > 100
         = 1 + 0.035·R + 7e-6·R·(R-60)·(100-R)  sinon
ICPIF    = Id + Ie_eff - A       (A = advantage factor, 0 par défaut)
```

avec, par codec (G.113 App. I) :

| `codec` | Ie | Bpl | Taille de charge | Paquets/s |
|---|---|---|---|---|
| `g711alaw` / `g711ulaw` | 0 | 4.3 | 160 + 12 (RTP) = 172 | 50 |
| `g729a` | 11 | 19 | 20 + 12 = 32 | 50 |

Configurer un codec **impose** `request-data-size`, `num-packets` (1000)
et `interval` (20 ms) conformes au codec, exactement comme IOS le fait,
et les redéfinir ensuite les écrase — un lab qui met `codec g729a` puis
`num-packets 10` obtient bien 10.

`BurstR` (rapport de rafale) vaut 1 (perte indépendante) tant que ce
simulateur n'a pas de modèle de perte en rafale ; c'est la valeur par
défaut de G.107 en l'absence d'information, et non un raccourci.

### 3.5 `tcp-connect`

Mesure le temps de la poignée de main vers `<ip> <port>`. `Router.tcpConnect`
résout à l'établissement (→ RTT) ou au refus (→ `Dropped`, immédiat).
Absence de réponse → `Timeout`. La connexion est fermée aussitôt établie :
IP SLA mesure l'ouverture, il ne parle pas. Avec responder, le port cible
peut être ouvert à la demande par le control protocol.

### 3.6 `http`

`http get <url>` : RTT total, plus la décomposition que IOS affiche —
`DNSRTT`, `TCPConnectRTT`, `TransactionRTT`. Un code HTTP hors 2xx/3xx
donne `Application specific error` avec le code en `DiagText`.
`http raw` envoie une requête fournie littéralement en sous-mode.
Timeout par défaut 60000 ms.

**Limite assumée** : `DNSRTT` n'est mesuré que si l'URL porte un nom et
qu'un serveur DNS est configuré ; sinon il vaut 0 et la sortie le montre,
plutôt que d'inventer une décomposition.

### 3.7 `dns`, `icmp-jitter`, `path-echo`

- **`dns`** : requête A réelle (`encodeDnsMessage`) vers `name-server`.
  RCODE ≠ 0 → `Application specific error`. Pas de réponse → `Timeout`.
- **`icmp-jitter`** : `num-packets` echo-requests espacés d'`interval`.
  Faute d'horodatage posé par la cible (un simple hôte ICMP n'est pas un
  responder), **seule la gigue aller-retour est mesurable** ; les
  colonnes one-way SD/DS restent à zéro échantillon. IOS a la même
  limite quand la cible n'est pas un responder IOS ; elle est écrite ici
  pour qu'on ne la prenne pas pour un manque.
- **`path-echo`** : découvre le chemin par TTL croissant, puis mesure
  chaque saut. Les statistiques sont par saut. Réutilise la logique déjà
  éprouvée de `Router.executeTraceroute`.

### 3.8 Le responder et l'IP SLA Control Protocol

`ip sla responder` ouvre une écoute UDP/1967 sur le routeur. Séquence
pour une opération `udp-echo`/`udp-jitter` avec contrôle activé :

```
Émetteur                                   Responder
   │  control-request                          │
   │  { opId, protocol, port, durée, auth? }   │
   │──────────── UDP → 1967 ──────────────────▶│
   │                                           │ ouvre le port demandé
   │                                           │ pour la durée annoncée
   │◀──────────── control-reply ───────────────│
   │              { ok | erreur }              │
   │                                           │
   │  sondes vers le port négocié              │
   │◀─────────────────────────────────────────▶│
```

Points de conformité :

- Un `control-reply` négatif (responder absent, port déjà pris,
  authentification refusée) fait échouer la sonde en `Dropped` avec un
  `DiagText` explicite, sans attendre le timeout de sonde.
- Le port négocié se referme à l'expiration de la durée annoncée. Une
  sonde tardive n'y trouve plus personne — ce qui produit un `Timeout`,
  et c'est la bonne réponse.
- `ip sla responder udp-echo ipaddress <ip> port <n>` ouvre un port en
  **permanence**, sans contrôle : c'est la contrepartie de
  `control disable` côté émetteur, et les deux doivent être configurés
  ensemble, sans quoi la mesure échoue.
- `ip sla key-chain <nom>` : le control-request porte un condensat MD5
  de ses champs et de la clé active de la key-chain. Le responder
  refuse un condensat qui ne correspond pas. La `KeyChainRepository`
  existante fournit les clés ; les fenêtres de validité
  (`accept-lifetime`/`send-lifetime`) qu'elle porte déjà sont
  respectées.

---

## 4. Réactions, seuils et déclencheurs

`ip sla reaction-configuration <op> react <élément> [threshold-type …]
[threshold-value <haut> <bas>] [action-type …]`

**Éléments surveillables** retenus : `rtt`, `timeout`, `connectionLoss`,
`verifyError`, `jitterAvg`, `jitterSDAvg`, `jitterDSAvg`, `packetLoss`,
`packetLossSD`, `packetLossDS`, `packetLateArrival`,
`packetOutOfSequence`, `mos`, `icpif`, `maxOfNegativeSD`,
`maxOfPositiveSD`, `maxOfNegativeDS`, `maxOfPositiveDS`.

**Types de seuil** — c'est ici que se joue l'anti-rebond, et chacun a une
sémantique distincte qu'il faut implémenter, pas approximer :

| `threshold-type` | Déclenche quand |
|---|---|
| `never` | jamais (défaut) |
| `immediate` | dès qu'une mesure franchit le seuil haut |
| `consecutive <N>` | après `N` mesures **consécutives** au-delà |
| `xOfy <X> <Y>` | quand `X` des `Y` dernières mesures sont au-delà |
| `average <N>` | quand la moyenne des `N` dernières est au-delà |

**Hystérésis.** Une réaction déclenchée reste armée jusqu'à ce qu'une
mesure repasse **sous le seuil bas**, moment où la condition est levée
(et un second événement, « clear », est émis). Deux seuils, pas un : sans
cela une valeur qui oscille autour du seuil produit un battement — c'est
la raison d'être de `threshold-value <haut> <bas>`.

Pour `mos` et `icpif`, la polarité s'inverse : un MOS **bas** est
mauvais. La condition est donc « en dessous du seuil bas », et la levée
« au-dessus du seuil haut ». Traiter tous les éléments avec la même
comparaison serait un bug silencieux ; la polarité est une propriété
déclarée de chaque élément surveillable.

**Actions** :

| `action-type` | Effet |
|---|---|
| `none` | mesure enregistrée, rien d'autre (défaut) |
| `trapOnly` | trap SNMP `rttMonThresholdNotification` |
| `triggerOnly` | démarre l'opération cible d'`ip sla reaction-trigger` |
| `trapAndTrigger` | les deux |

`ip sla logging traps` ajoute, indépendamment de `action-type`, un
syslog de sévérité 3 :

```
%RTT-3-IPSLATHRESHOLD: IP SLAs(1): Threshold exceeded for jitterAvg
%RTT-3-IPSLACLEAR: IP SLAs(1): Threshold cleared for jitterAvg
```

C'est cette ligne qui rend les réactions IP SLA utilisables depuis EEM
(`event syslog pattern "IPSLATHRESHOLD"`), sans une ligne de code EEM.

`ip sla reaction-trigger <op-source> <op-cible>` : l'opération cible doit
être planifiée `start-time pending`, sans quoi la commande est refusée —
déclencher une opération déjà active n'a pas de sens.

---

## 5. Intégration `track`

### 5.1 Les deux formes, enfin distinctes

| Commande | Up quand |
|---|---|
| `track <n> ip sla <op> reachability` | dernier code de retour ∈ {`OK`, `Over threshold`} — **l'opération répond** |
| `track <n> ip sla <op> state` | dernier code de retour = `OK` — **et sous le seuil** |

Une opération dont le RTT dépasse `threshold` a donc `reachability` Up et
`state` Down. C'est toute la différence entre « le lien existe » et « le
lien est utilisable », et c'est exactement ce que le code actuel a
fusionné en un seul `sla.reachable()`.

Une opération `Pending` ou `Inactive` rend les deux formes **Down** :
IOS ne suppose pas qu'une sonde qui n'a jamais tourné est bonne.

### 5.2 `delay up` / `delay down`

Un changement d'état est retenu pendant le délai configuré ; si l'état
revient avant l'échéance, le changement est annulé et **aucun** événement
n'est publié. C'est l'anti-rebond qui empêche une route flottante de
battre à chaque sonde perdue. Les champs sont déjà parsés ; ils doivent
être appliqués — sur tous les types d'objets, pas seulement IP SLA.

### 5.3 Ce que `show track` doit dire

```
Track 1
  IP SLA 1 reachability
  Reachability is Up
    3 changes, last change 00:01:15
  Latest operation return code: OK
  Latest RTT (millisecs) 4
  Tracked by:
    STATIC-IP-ROUTING 0
```

Trois choses manquent aujourd'hui et sont exigées : le **compteur de
changements** et l'horodatage du dernier, le **report du dernier
résultat** de l'opération suivie, et la section **`Tracked by:`** — qui
n'est pas décorative : c'est la seule façon de voir qu'un objet est
consommé par une route, une HSRP ou rien du tout.

### 5.4 Syslog

```
%TRACKING-5-STATE: 1 rtr 1 reachability Up->Down
%TRACKING-5-STATE: 5 interface GigabitEthernet0/1 line-protocol Down->Up
```

Émis à chaque transition **effective** (donc après `delay`), pour tous
les types d'objets suivis.

---

## 6. Hors périmètre, et pourquoi

Chaque exclusion est un choix motivé par l'absence d'une brique
sous-jacente, pas par la difficulté :

| Exclu | Raison vérifiée |
|---|---|
| `ftp get`, `dhcp` | Aucun client FTP ni client DHCP côté routeur. `router/dhcp` est un **serveur**/relais ; il n'existe pas de chemin pour qu'un routeur sollicite un bail pour lui-même |
| `voip` (`rtp`, `gatekeeper`, `post-dial-delay`) | Aucune pile RTP ni H.323/SIP dans le dépôt. Le MOS de `udp-jitter` est calculé sur du trafic UDP dimensionné comme du codec, ce qui est le mode réel le plus utilisé — mais ce n'est pas de la voix |
| `mpls lsp ping/trace`, `auto ip sla mpls-lsp-monitor` | Aucun plan MPLS (ni LDP, ni labels, ni LSP) |
| `ethernet echo`/`jitter` (Y.1731) | Aucun OAM 802.1ag/Y.1731 |
| `path-jitter` | Exigerait de maintenir des statistiques de gigue par saut découvert, sur une topologie qui peut changer entre deux cycles. `path-echo` couvre le besoin pédagogique (« quel saut est lent ») sans cette complexité |
| Cibles **IPv6** | `IPv6DataPlane` répond aux echo-requests mais aucun émetteur ICMPv6 n'existe côté routeur. Ajouter IP SLA v6 exigerait d'abord cet émetteur — travail distinct, réutilisable ailleurs (`ping ipv6` en bénéficierait) |
| **VRF** (`vrf <nom>` sur une opération) | Le simulateur n'a pas de plan de routage par VRF ; la commande serait acceptée et sans effet. Elle est **refusée** plutôt que stockée |
| `ip sla responder twamp`, `ip sla server twamp` | RFC 5357 est un protocole complet (contrôle TCP/862 + test UDP), pas une option du responder Cisco. Le faire à moitié le rendrait faux ; il mérite son propre PRD |
| Horodatage matériel (`Supported Hardware Timestamp Modes`) | Sans objet dans un simulateur ; la ligne est rendue à `None`, comme sur un ISR |
| **Huawei NQA** | Équivalent VRP d'IP SLA (`nqa test-instance`, `display nqa results`), aujourd'hui totalement absent — les commandes des suites de debug tombent en `Invalid input`. C'est un sous-système jumeau, pas une variante d'affichage : il mérite son PRD, qui pourra réutiliser le moteur livré ici en n'écrivant que sa surface CLI |

---

## 7. Architecture cible

```
src/network/ipsla/
  types.ts            Opérations, planification, résultats, codes de retour,
                      constantes (UDP/1967), défauts par type d'opération
  events.ts           Sous-union DomainEvent (ipsla.*, track.*)
  statistics.ts       Agrégats RTT, distribution, gigue RFC 3393/3550,
                      pertes SD/DS, historique
  emodel.ts           E-model G.107 / G.113 : R, MOS, ICPIF
  probes/
    IcmpEchoProbe.ts  RFC 792
    UdpProbe.ts       udp-echo + udp-jitter (partagent l'appareillage)
    TcpConnectProbe.ts
    HttpProbe.ts
    DnsProbe.ts
    PathEchoProbe.ts
  IpSlaEngine.ts      Ordonnancement, cycle de vie, verdicts, réactions
  IpSlaResponder.ts   UDP/1967, ports négociés, auth key-chain
  reactions.ts        Types de seuil, hystérésis, polarité

src/network/devices/inspection/config/
  IpSlaRepository.ts  Réécrit : configuration seule, le moteur porte l'état
  TrackRepository.ts  Étendu : delay, compteurs, Tracked by, deux formes SLA

src/network/devices/shells/cisco/
  CiscoTrackSlaCommands.ts   Réécrit et éclaté :
  CiscoIpSlaConfigCommands.ts   sous-modes de configuration
  CiscoIpSlaShowCommands.ts     famille show
  CiscoTrackCommands.ts         track + show track
  ciscoIpSlaRunningConfig.ts    rendu running-config

src/network/snmp/mibs/RttMonMib.ts   Projection CISCO-RTTMON-MIB
```

Le moteur vit sous `src/network/ipsla/` et non sous
`devices/router/` parce qu'il ne dépend d'aucune spécificité Cisco : le
jour où Huawei NQA arrivera, il branchera sa CLI sur le même moteur.
`IpSlaHost` est le port étroit qu'un routeur remplit (émettre une trame,
consulter la FIB, résoudre l'ARP, ouvrir une connexion TCP, lire l'état
NTP) — même patron que `BfdHost`/`EemHost`.

---

## 8. Phases de livraison

| Phase | Contenu | Critère d'acceptation |
|---|---|---|
| **P1** | Moteur, ordonnancement (`Scheduler`), cycle de vie, `icmp-echo` réel, codes de retour, statistiques de base | Une cible éteinte donne `Timeout` alors que la route est intacte |
| **P2** | `track` réel : deux formes, `delay`, compteurs, `Tracked by`, `%TRACKING-5-STATE`, bascule de route statique | Le lab dual-WAN bascule sans que le lien tombe |
| **P3** | Responder + control protocol UDP/1967, `udp-echo`, key-chain | Une sonde vers un responder éteint échoue en `Dropped`, pas en `Timeout` |
| **P4** | `udp-jitter` : horodatages, gigue signée, pertes SD/DS, one-way conditionné à NTP, MOS/ICPIF | Les échantillons one-way restent à 0 sans NTP et apparaissent avec |
| **P5** | `tcp-connect`, `http`, `dns`, `icmp-jitter`, `path-echo` | Chaque type mesure un vrai aller-retour |
| **P6** | Réactions : types de seuil, hystérésis, polarité MOS, traps, `reaction-trigger`, `%RTT-3-IPSLATHRESHOLD` | Un applet EEM se déclenche sur franchissement de seuil |
| **P7** | Famille `show` complète au format IOS, running-config, sérialisation de topologie | `show ip sla configuration` reproduit ce qui a été tapé |
| **P8** | CISCO-RTTMON-MIB + notifications | `snmpget` d'un OID rttMon renvoie la mesure réelle |

---

## 8bis. État livré (2026-08-05)

Livré et discriminé par `git stash` :

- **Moteur** `src/network/ipsla/` : cycle de vie complet (Pending →
  Active → Inactive, `ageout` qui supprime, `recurring`, `restart`),
  minuteries réelles sur `src/events/Scheduler`, codes de retour de
  `rttMonLatestRttOperSense`, agrégats RTT, distribution, historique.
- **Sondes** : `icmp-echo`, `udp-echo`, `udp-jitter` (+ codec),
  `tcp-connect`, `http`, `dns`, `icmp-jitter`, `path-echo`.
- **Responder** + control protocol UDP/1967, ports permanents et
  négociés, authentification par key-chain MD5.
- **Statistiques de gigue** signées par direction, pertes SD/DS/MIA
  distinguées, unidirectionnel conditionné à NTP des deux côtés,
  MOS/ICPIF par l'E-model.
- **Réactions** : cinq types de seuil, hystérésis, polarité déclarée par
  élément, `reaction-trigger`, `%RTT-3-IPSLATHRESHOLD`.
- **`track`** : deux formes IP SLA distinctes, `delay up`/`down`,
  compteur de changements, `Tracked by:`, `%TRACKING-5-STATE`.
- **running-config** : blocs `ip sla`, `ip sla schedule`,
  `ip sla reaction-configuration`, `ip sla responder`, `track`.
- **CISCO-RTTMON-MIB** : accesseurs paresseux sur l'état vivant.

### Trois défauts trouvés en écrivant ce lot, hors périmètre initial

1. **`ip route 0.0.0.0 0.0.0.0 <nh> track <n>` perdait son `track`.** La
   route par défaut passe par `setDefaultRoute()`, dont la signature ne
   portait ni `track` ni `permanent` — l'analyseur les extrayait et les
   jetait. La route flottante par défaut, forme la plus courante de tout
   le suivi d'objets, était donc inconditionnelle.
2. **IP SLA et `track` vivaient sur le shell.** `createVtyShell()`
   fabrique un shell neuf par session : un `track` posé en SSH était
   invisible depuis la console de la même machine, et la running-config
   — rendue par le shell mais décrivant l'équipement — ne pouvait pas
   les voir. Ils vivent désormais sur `Router`.
3. **`show ip sla statistics` répondait `(reachable)`**, mot qui
   n'existe dans aucune sortie IOS ; il venait de la façade.

### Écarts assumés, mesurés plutôt que supposés

- **Le RTT vaut 0 ms en temps virtuel.** La livraison de trame est
  synchrone dans ce simulateur : aucun chemin ne peut franchir un seuil
  par lui-même. `overThreshold` est donc atteignable par la logique
  (testée) mais pas par la topologie. Le jour où `Cable` portera une
  latence, ce cas deviendra observable sans changer une ligne du moteur.
- **Une cible morte derrière un routeur donne `Dropped`, pas
  `Timeout`.** Le dernier routeur répond un ICMP Destination
  Unreachable : c'est une réponse négative, pas une absence de réponse.
  Rendre cela en `Timeout` jetterait une information que la machine a
  réellement reçue.
- **`verify-data` est appliqué et structurellement inatteignable** :
  rien ne corrompt une charge utile ICMP dans ce simulateur (une trame
  corrompue n'arrive jamais), donc le cas produit un `Timeout`.
- **Le responder rapporte la LISTE des numéros de séquence reçus**, là
  où un vrai responder envoie un compteur. C'est ce qui rend la
  répartition SD/DS exacte au lieu d'être une attribution au jugé ; le
  prix est que ce simulateur est ici mieux renseigné que le matériel.
- **`ip sla key-chain` vaut pour les deux rôles** (signer ce qu'on émet,
  vérifier ce qu'on reçoit) : aucune commande IOS ne permet d'exprimer
  deux clés différentes pour ces deux rôles.

Restent non faits, tels que §6 les décrit : `path-jitter`, `ftp`,
`dhcp`, `voip`, MPLS, Y.1731, cibles IPv6, VRF, TWAMP, et Huawei NQA.

---

## 9. Plan de test

Chaque phase livre une suite discriminée par `git stash` : les cas
dépendants du correctif **doivent** échouer avant lui. Les cas
structurants :

1. **Le cas qui définit tout le sous-système** : R1 sonde une cible
   vivante derrière R2 ; on éteint la cible sans toucher au câblage ni à
   la route. Avant : `reachable`. Après : `Timeout`, track Down, route
   flottante activée. C'est la mesure de §0.1.
2. Une ACL qui bloque l'echo-reply fait tomber la sonde alors que la
   route est parfaite.
3. `frequency 5` produit bien une sonde toutes les 5 s de temps
   **virtuel**, et zéro avant `ip sla schedule`.
4. `life 30` fait passer `Active` → `Inactive` et **conserve** les
   statistiques ; `ageout` supprime l'entrée.
5. RTT > `threshold` : `reachability` Up **et** `state` Down
   simultanément sur le même objet.
6. `delay down 20` : une sonde perdue isolée ne fait pas tomber le track ;
   deux sondes perdues consécutives au-delà du délai, si.
7. Responder : sonde `udp-echo` OK avec, `Dropped` sans, `Timeout`
   après expiration du port négocié.
8. `udp-jitter` : gigue positive et négative comptées séparément ;
   `PacketLossSD` et `PacketLossDS` distingués par perte injectée via
   `Cable.setPacketLossRate` dans un sens.
9. One-way : 0 échantillon sans NTP, > 0 avec NTP synchronisé des deux
   côtés.
10. MOS : un chemin sans perte ni délai donne ≈ 4.4 en G.711 ; 5 % de
    perte l'effondre ; G.729A donne un MOS plus bas que G.711 sur le
    même chemin.
11. `threshold-type consecutive 3` ne déclenche pas à la 2ᵉ, déclenche à
    la 3ᵉ ; `xOfy 2 3` déclenche sur un motif non consécutif.
12. Hystérésis : la condition ne se lève qu'en repassant sous le seuil
    bas.
13. EEM : `event syslog pattern "IPSLATHRESHOLD"` exécute son applet.
14. Running-config : `ip sla`/`schedule`/`reaction-configuration`/`track`
    survivent à un aller-retour d'export/import de topologie.
15. Non-régression : `cisco-track-sla.test.ts` continue de passer, ou ses
    assertions fausses sont corrigées **en le disant** — le cas
    `expect(stats).toMatch(/reachable/)` teste aujourd'hui une sortie qui
    n'existe pas sur IOS et disparaîtra.

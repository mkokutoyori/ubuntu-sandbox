# PRD — Protocole RADIUS (AAA : authentification, autorisation, accounting)

**Version** : 1.0
**Date** : 2026-07-04
**Projet** : Ubuntu Sandbox — Module RADIUS
**Auteur** : Claude Code
**Références normatives** : RFC 2865 (RADIUS), RFC 2866 (RADIUS Accounting), RFC 2867/2868 (attributs tunnel), RFC 2869 (RADIUS Extensions, Message-Authenticator), RFC 3579 (RADIUS support for EAP), RFC 3580 (IEEE 802.1X RADIUS Usage Guidelines), RFC 5176 (Dynamic Authorization Extensions — CoA/Disconnect), RFC 2548 (Microsoft VSA), RFC 6613 (RADIUS/TCP), RFC 6614 (RadSec)

---

## 0. Contexte et portée du document

Ce PRD couvre **le protocole RADIUS lui-même** : le format de paquet, le dictionnaire
d'attributs, les échanges Access-Request/Accept/Reject/Challenge, l'accounting,
le relais EAP pour 802.1X, l'application des attributs d'autorisation et les
extensions d'autorisation dynamique (CoA/Disconnect).

Il sert de **fondation à deux projets consécutifs** qui consommeront ce moteur :

1. **`freeradius` sur Linux Server** (fichiers `clients.conf`/`users`, CLI
   `radtest`/`radclient`) — non couvert ici ;
2. **le rôle NPS (Network Policy Server) de Windows Server** — couvert par le
   PRD frère `docs/PRD-Windows-Server.md` (§ rôle NPS), qui hébergera le
   `RadiusServerAgent` décrit ici exactement comme les routeurs Cisco/Huawei
   l'hébergent aujourd'hui.

Aucune ligne de code n'est écrite dans le cadre de ce document — il sert de base à
la planification et à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Lignes |
|---|---|---|
| `src/network/radius/types.ts` | Constantes de codes/attributs, structures `RadiusPacket`/`RadiusAttribute` (objet, **pas de binaire**), chiffrement User-Password (MD5 réel), configs client/serveur | 193 |
| `src/network/radius/RadiusClientAgent.ts` | Client NAS : `authenticate(user, pass)` → Access-Request UDP/1812, timeout + retransmission via `Scheduler`, résolution d'egress par sous-réseau | 243 |
| `src/network/radius/RadiusServerAgent.ts` | Serveur : base d'utilisateurs en mémoire, allowlist de clients NAS, déchiffrement du mot de passe, réponse Accept/Reject | 158 |
| `src/network/radius/events.ts` | Topics du bus (`radius.packet.sent/received`, `radius.auth.completed/rejected`) | 39 |
| `src/network/devices/router/aaa/AaaAuthenticator.ts` | Consommateur AAA : `aaa authentication login` → groupe radius → `RadiusClientAgent`, synchronisation des serveurs déclarés en CLI | 169 |
| `src/network/devices/shells/cisco/CiscoSecurityCommands.ts` | CLI Cisco : blocs `radius server <name>` (address/key), `aaa group server radius`, forme legacy `radius-server host <ip> key <k>`, `show radius statistics` | — |
| `src/network/devices/shells/HuaweiVRPShell.ts` | CLI Huawei : `radius-server template`, liaison au domaine AAA (`radius-server <template>` sous `aaa`/domain), `display radius-server configuration` | — |
| `src/network/dot1x/Dot1xAgent.ts` | Authenticator 802.1X : interface `Dot1xRadiusBackend.authenticate(identity, '')` branchée sur le client RADIUS | — |
| `src/network/devices/CiscoRouter.ts`, `HuaweiRouter.ts` | Hébergent chacun un `RadiusClientAgent` **et** un `RadiusServerAgent` (un routeur peut jouer le serveur) | — |
| `src/__tests__/unit/network-v2/radius-protocol.test.ts` + suites `cisco-huawei-aaa-security`, `dot1x-protocol`, `huawei-dot1x`, `huawei-aaa-mgmt`, `cisco-aaa-acl` | Couverture actuelle | — |

À titre de comparaison, le module frère `src/network/tacacs/` (1 935 lignes au
total) suit la même architecture agents client/serveur et souffre des mêmes
limites structurelles — les décisions prises ici serviront de modèle pour son
alignement ultérieur.

### 1.2 Ce qui existe déjà et est réutilisable

- **Le chiffrement User-Password est conforme RFC 2865 §5.2** : MD5 réel
  (`@/crypto/hash`), chaînage par blocs de 16 octets, XOR avec
  `MD5(secret + prev)` — `encryptUserPassword`/`decryptUserPassword` sont à
  conserver tels quels.
- **Le transport UDP simulé est réel** : les Access-Request traversent câbles,
  switches et routeurs comme de vraies trames (`EthernetFrame` → `IPv4Packet` →
  `UDPPacket`), avec checksum IPv4 calculé. Contrairement à certains modules
  historiques, RADIUS ne court-circuite pas le réseau.
- **Timeout + retransmission côté client** (par serveur : `timeoutMs`,
  `retransmit`) sur le `Scheduler` injectable — testable en temps virtuel.
- **L'événementiel est en place** : topics dédiés publiés sur l'`EventBus` +
  `Logger` réseau, exploités par les tests et les logs UI.
- **La détection heuristique de mauvais secret partagé** (déchiffrement non
  imprimable → `bad-secret`) reproduit un comportement diagnostique réaliste.
- **L'intégration CLI est riche** : syntaxe Cisco moderne (`radius server` +
  `address ipv4`/`key`) et legacy (`radius-server host`), groupes
  `aaa group server radius`, templates Huawei liés aux domaines AAA. Les
  méthodes AAA (`aaa authentication login default group <g> local`) savent
  chaîner RADIUS puis fallback local.
- **Le hook 802.1X existe** : `Dot1xAgent.setRadiusBackend()` permet déjà de
  déléguer la décision au RADIUS — c'est le point d'entrée du futur relais EAP.

### 1.3 Ce qui est non conforme ou manquant (gap analysis face aux RFC visées)

| # | Manque | RFC concernée | Sévérité |
|---|---|---|---|
| 1 | **Response Authenticator non conforme et non vérifié** : le serveur répond avec un authenticator pseudo-aléatoire (`makeAuthenticator(id ^ Date.now())`) au lieu de `MD5(Code+ID+Length+RequestAuth+Attributes+Secret)` ; le client ne vérifie **rien** — une réponse forgée par n'importe quel hôte connaissant l'identifier serait acceptée | RFC 2865 §3 | Bloquant |
| 2 | Aucun encodage/décodage **binaire** du paquet (en-tête 20 octets Code/Identifier/Length/Authenticator, attributs TLV Type/Length/Value) ; le paquet est un objet TypeScript ; le dictionnaire couvre 17 attributs sur les ~60 de base et n'a **aucun typage de valeur** (string/ipaddr/integer/octets) | RFC 2865 §3–5 | Élevée |
| 3 | `Message-Authenticator` (attr 80) est déclaré dans le dictionnaire mais **jamais calculé ni vérifié** (HMAC-MD5 sur le paquet entier) — obligatoire dès qu'EAP est transporté | RFC 2869 §5.14, RFC 3579 §3.2 | Élevée |
| 4 | `Access-Challenge` est déclaré mais **jamais émis ni traité** ; l'attribut `State` (24) n'est jamais utilisé → aucune authentification multi-étapes possible (OTP, challenge CHAP serveur, EAP) | RFC 2865 §4.4 | Élevée |
| 5 | **Aucun accounting** : le port 1813 et les codes Accounting-Request/Response sont déclarés mais rien n'est implémenté — pas de `Acct-Status-Type` Start/Interim/Stop, pas d'`Acct-Session-Id` généré, pas de compteurs (`Acct-Input-Octets`, `Acct-Session-Time`), pas d'`Acct-Terminate-Cause` ; les commandes `aaa accounting` des CLI ne sont reliées à rien | RFC 2866 | Élevée |
| 6 | **Pas d'EAP over RADIUS** : le `Dot1xAgent` appelle `authenticate(identity, '')` avec un mot de passe **vide** — le flux réel (EAP-Message relayé du supplicant au serveur dans l'Access-Request, challenge EAP-MD5 retourné en Access-Challenge, etc.) n'existe pas | RFC 3579 | Élevée |
| 7 | **Les attributs d'autorisation ne sont jamais appliqués** : le serveur stocke des `replyAttributes` par utilisateur mais le client les ignore entièrement — pas de `Service-Type` → niveau de privilège, pas de `Filter-Id` → ACL, pas de `Tunnel-Type`/`Tunnel-Medium-Type`/`Tunnel-Private-Group-ID` → **VLAN dynamique 802.1X**, pas de `Session-Timeout`/`Idle-Timeout` | RFC 2865 §5.6/5.11, RFC 3580 §3.31 | Élevée |
| 8 | **Pas de failover client** : `authenticate()` prend le **premier** serveur de la liste (ou celui passé explicitement) ; après épuisement des retransmissions → échec, sans jamais essayer le serveur suivant ; pas de deadtime, pas de marquage serveur mort | RFC 2865 §2.6 (implicite), comportement IOS `radius-server deadtime` | Élevée |
| 9 | Pas de **serveur RADIUS autonome** : seuls les routeurs Cisco/Huawei peuvent héberger le `RadiusServerAgent` ; ni Linux Server (freeradius) ni Windows Server (NPS) ne peuvent jouer ce rôle — topologies pédagogiques classiques (switch NAS → serveur AAA central) impossibles | — | Élevée |
| 10 | Pas de **CoA / Disconnect-Message** (port UDP 3799) : impossible de déconnecter dynamiquement une session ou de changer son autorisation (réaffectation VLAN à chaud) | RFC 5176 | Moyenne |
| 11 | Pas de **CHAP** : `chap-password` (attr 3) est déclaré mais inutilisé ; seul PAP (User-Password) fonctionne | RFC 2865 §2.2 | Moyenne |
| 12 | Pas de **VSA structuré** : `vendor-specific` (26) est déclaré mais sans modèle Vendor-Id/Vendor-Type/Value ; pas de dictionnaire Cisco AV-pair (`shell:priv-lvl=15`) ni Microsoft (MS-CHAP/MPPE) | RFC 2865 §5.26, RFC 2548 | Moyenne |
| 13 | ~~**Dette technique transport côté serveur**~~ **[Résolu]** : la réponse était émise vers un port UDP **deviné** (`49152 + (identifier & 0x3fff)`) au lieu du port source du datagramme reçu, et vers une MAC **broadcast** — le serveur répond maintenant sur le port source réel de la requête (`udp.sourcePort`) et résout la MAC via un hook `resolveMac?(ip)` (ARP réelle du routeur, fallback broadcast si inconnue) | RFC 2865 §2 | Moyenne |
| 14 | ~~**Résolution d'egress client naïve**~~ **[Résolu]** : correspondance de sous-réseau direct sinon « premier port up » — le client tente maintenant un hook `resolveRoute?(ip)` branché sur la vraie table de routage de l'hôte (LPM, `Router.resolveRouteForHost`) avant de retomber sur les heuristiques historiques ; `ip radius source-interface` reste prioritaire | — | Moyenne |
| 15 | ~~Pas de **cache anti-duplication** côté serveur~~ **[Résolu]** : une retransmission client est maintenant reconnue via une clé `ip:port:identifier:authenticator` et rejouée depuis un cache (TTL 30s) sans re-déclencher la décision accept/reject ni dupliquer les événements | RFC 2865 §3 | Faible |
| 16 | `show radius statistics` (Cisco) liste les serveurs mais sans **compteurs réels** (accepts/rejects/timeouts par serveur) ; pas de `debug radius`, pas de `test aaa group radius` | — | Faible |
| 17 | Pas de RADIUS/TCP ni RadSec (TLS/2083) | RFC 6613, RFC 6614 | Faible |

**Conclusion de la phase d'analyse** : l'existant est un **squelette fonctionnel
crédible pour le cas nominal** (login CLI authentifié par un serveur RADIUS sur
lien direct, PAP uniquement), avec un vrai transport réseau et un vrai
chiffrement de mot de passe. Mais il n'y a **ni intégrité des échanges (gap 1 et
3), ni accounting, ni challenge, ni application des autorisations, ni failover**
— c'est-à-dire qu'il manque les trois lettres de « AAA » au-delà du premier A
partiel. Le moteur doit être complété **sans casser** les suites existantes
(`radius-protocol`, `dot1x-protocol`, `cisco-huawei-aaa-security`, …).

---

## 2. Objectifs

### 2.1 Objectifs du protocole (ce PRD)

1. **Paquet binaire conforme RFC 2865 §3** : encodage/décodage réel de l'en-tête
   (Code, Identifier, Length, Authenticator 16 octets) et des attributs TLV,
   avec un **dictionnaire complet** des attributs de base (types de valeur
   `text`/`string`/`address`/`integer`/`time`, contraintes de longueur) et le
   modèle VSA (Vendor-Id/Vendor-Type), dictionnaires Cisco (AV-pair) et
   Microsoft (RFC 2548) inclus.
2. **Intégrité conforme** :
   - Response Authenticator calculé `MD5(Code+ID+Length+RequestAuth+Attrs+Secret)`
     côté serveur et **vérifié** côté client (réponse invalide = silencieusement
     ignorée, comme un vrai NAS) ;
   - `Message-Authenticator` HMAC-MD5 (RFC 2869 §5.14) calculé/vérifié, exigé
     sur tout paquet transportant de l'EAP (RFC 3579 §3.2) ;
   - Request Authenticator réellement aléatoire par requête.
3. **PAP et CHAP** : CHAP-Password (attr 3) + CHAP-Challenge (60), vérification
   serveur `MD5(id + secret + challenge)`.
4. **Access-Challenge et attribut State** : machine à états client qui rejoue un
   Access-Request avec le `State` reçu ; support d'un scénario challenge
   (base du flux EAP et des OTP).
5. **Accounting complet RFC 2866** : agent d'accounting client (Start /
   Interim-Update / Stop avec `Acct-Session-Id`, `Acct-Session-Time`,
   `Acct-Input/Output-Octets`, `Acct-Terminate-Cause`, `Acct-Authentic`,
   `Acct-Delay-Time`), serveur qui journalise les sessions et répond
   Accounting-Response ; câblage des commandes `aaa accounting` (Cisco) et
   équivalents Huawei ; sessions consultables (`show aaa sessions` /
   journal serveur).
6. **EAP over RADIUS pour 802.1X (RFC 3579)** : le `Dot1xAgent` relaie les
   EAP-Message du supplicant dans l'Access-Request (avec Message-Authenticator),
   le serveur mène un échange **EAP-MD5** (Identity → Challenge via
   Access-Challenge → Success/Failure), et les attributs RFC 3580 sont fournis
   (`NAS-Port-Type=Ethernet`, `Calling-Station-Id`=MAC du supplicant, etc.).
7. **Application des attributs d'autorisation** côté NAS :
   - `Service-Type` + VSA `shell:priv-lvl=N` → niveau de privilège du shell ;
   - `Filter-Id` → ACL appliquée à la session ;
   - `Tunnel-Type(13=VLAN)`/`Tunnel-Medium-Type(6)`/`Tunnel-Private-Group-ID`
     → **affectation VLAN dynamique** du port 802.1X (RFC 3580 §3.31) ;
   - `Session-Timeout`/`Idle-Timeout` → réauthentification/expiration ;
   - `Reply-Message` → affiché à l'utilisateur au login.
8. **Groupes de serveurs avec failover** : essai séquentiel des serveurs du
   groupe après épuisement des retransmissions, marquage « dead » avec
   deadtime configurable (`radius-server deadtime`), compteurs par serveur,
   événement `radius.server.dead`/`radius.server.alive`.
9. **Autorisation dynamique RFC 5176** : listener CoA/Disconnect sur UDP 3799
   côté NAS, client CoA côté serveur ; Disconnect-Request → fermeture de la
   session (et retour du port 802.1X en unauthorized), CoA-Request → nouvelle
   autorisation (ex. changement de VLAN) ; réponses ACK/NAK avec `Error-Cause`.
10. **Service serveur hébergeable partout** : extraire le contrat d'hébergement
    (`RadiusServerHost`) pour que Linux Server et Windows Server (rôle NPS,
    cf. `PRD-Windows-Server.md`) puissent instancier le serveur, pas seulement
    les routeurs.
11. **Corrections de dette transport** : répondre au **port source réel** du
    datagramme reçu et à la MAC source apprise (ou via ARP), résoudre l'egress
    client via la **table de routage** de l'hôte (et honorer
    `ip radius source-interface`), cache anti-duplication serveur.
12. **Observabilité** : compteurs réels dans `show radius statistics`,
    `debug radius` (Cisco) / `display radius-server statistics` (Huawei),
    `test aaa group radius <user> <pass>`, événements bus enrichis
    (accounting, challenge, CoA, failover).

### 2.2 Non-objectifs (explicitement hors périmètre)

- **EAP-TLS / PEAP / EAP-TTLS** : nécessitent une infrastructure de certificats
  côté supplicant/serveur — phase ultérieure, une fois EAP-MD5 en place.
- **RADIUS/TCP et RadSec (TLS)** (RFC 6613/6614) — valeur pédagogique faible ici.
- **Proxy/roaming RADIUS** (RFC 2607) : chaînes de proxys inter-domaines.
- **Attributs IPv6** (Framed-IPv6-*, RFC 3162) — suivront le chantier IPv6 global.
- **L'implémentation freeradius sur Linux** (clients.conf, users, radtest) —
  projet consécutif consommant ce moteur.
- **L'implémentation NPS sur Windows Server** (console, politiques réseau
  riches) — couverte par `PRD-Windows-Server.md` ; ce PRD ne fournit que le
  moteur et le contrat d'hébergement.
- MS-CHAPv2 complet et dérivation de clés MPPE — seul le squelette VSA
  Microsoft est posé.

---

## 3. Architecture cible

### 3.1 Principe directeur

Même stratégie que le PRD DNS : **un moteur conforme en dessous, les façades
existantes au-dessus**. Les agents actuels (`RadiusClientAgent`,
`RadiusServerAgent`) gardent leur API publique (utilisée par AAA, dot1x et les
CLI) mais sont refondés sur un codec binaire, une machine à états challenge et
des sous-modules accounting/CoA. Le pattern maison des protocoles réactifs est
suivi : `types.ts` + `events.ts` + `observables.ts` + agents s'appuyant sur
`src/events/` (`Scheduler`, `TimerSet`, `EventBus`).

### 3.2 Diagramme de couches

```
┌────────────────────────────────────────────────────────────────────┐
│ Façades CLI : Cisco (radius server, aaa, show/debug radius)        │
│               Huawei (radius-server template, display radius-…)    │
│ Consommateurs : AaaAuthenticator, Dot1xAgent, (futur NPS/freeradius)│
├────────────────────────────────────────────────────────────────────┤
│ Agents : RadiusClientAgent (auth + failover + challenge FSM)       │
│          RadiusAccountingClient / RadiusServerAgent (+ acct log)   │
│          CoaListener (NAS, UDP 3799) / CoaClient (serveur)         │
├────────────────────────────────────────────────────────────────────┤
│ Cœur protocole : RadiusCodec (binaire) · RadiusDictionary (+VSA)   │
│   authenticators.ts (Request/Response/Message-Authenticator)       │
│   passwords.ts (PAP RFC 2865 §5.2, CHAP) · eap.ts (EAP-MD5 relay)  │
├────────────────────────────────────────────────────────────────────┤
│ Transport existant : UDPPacket/IPv4Packet/EthernetFrame,           │
│   routage hôte, ARP, Scheduler/EventBus                            │
└────────────────────────────────────────────────────────────────────┘
```

### 3.3 Modules proposés (arborescence)

```
src/network/radius/
├── types.ts                  # (existant, étendu) codes, configs, sessions
├── dictionary.ts             # NOUVEAU — attributs standard + VSA (Cisco, Microsoft)
├── codec.ts                  # NOUVEAU — encode/décode binaire RFC 2865 §3
├── authenticators.ts         # NOUVEAU — Request/Response auth, Message-Authenticator (HMAC-MD5)
├── passwords.ts              # extrait de types.ts — PAP (§5.2) + CHAP
├── eap.ts                    # NOUVEAU — types EAP, méthode EAP-MD5, encapsulation EAP-Message
├── accounting.ts             # NOUVEAU — modèle de session, générateur Acct-Session-Id
├── coa.ts                    # NOUVEAU — types CoA/Disconnect + Error-Cause (RFC 5176)
├── RadiusClientAgent.ts      # refondu — failover, challenge FSM, vérif. réponse
├── RadiusAccountingClient.ts # NOUVEAU — Start/Interim/Stop, retransmission
├── RadiusServerAgent.ts      # refondu — challenge, CHAP, EAP-MD5, acct, anti-dup, CoA client
├── CoaListener.ts            # NOUVEAU — côté NAS (UDP 3799)
├── events.ts                 # étendu — acct, challenge, CoA, server-dead/alive
├── observables.ts            # NOUVEAU — flux dérivés pour tests/UI
└── authorization.ts          # NOUVEAU — mapping attributs → décisions NAS (priv, ACL, VLAN, timeouts)
```

### 3.4 Design patterns retenus

- **Codec pur, sans effet de bord** : `encode(packet, secret) → Uint8Array`,
  `decode(bytes, secret) → RadiusPacket | DecodeError` — testable exhaustivement
  contre des paquets de référence (captures hexadécimales de la RFC et de
  wrapped freeradius).
- **Compatibilité ascendante du PDU** : `RadiusPacket` conserve sa forme objet
  (`NetworkPdu`) pour le transport simulé ; le codec sert de **preuve de
  conformité** et alimente un champ `raw?: Uint8Array` — les tests existants
  qui inspectent `payload.attributes` continuent de passer.
- **Machine à états client** (idle → waiting-response → challenged →
  done/timeout) pilotée par `Scheduler`, un `PendingRequest` par identifier,
  State opaque rejoué tel quel.
- **Stratégie de sélection de serveur** injectable (ordered-failover par
  défaut ; round-robin possible plus tard) + registre d'état des serveurs
  (alive/dead, deadline de deadtime, compteurs).
- **`authorization.ts` découplé** : les consommateurs (shell login, Dot1xAgent,
  SSH) reçoivent une `RadiusAuthorization` normalisée (privLevel?, aclName?,
  vlanId?, sessionTimeout?, replyMessage?) et décident quoi appliquer — le
  module RADIUS ne connaît ni les shells ni les switches.

---

## 4. Modèle de données

### 4.1 Paquet (RFC 2865 §3)

```
RadiusPacket {
  code: RadiusCode            // + 'coa-request' | 'coa-ack' | 'coa-nak'
                              // + 'disconnect-request' | 'disconnect-ack' | 'disconnect-nak'
  identifier: 0..255
  authenticator: 16 octets (hex)
  attributes: RadiusAttribute[]   // ordre préservé, répétitions autorisées
  raw?: Uint8Array                // forme binaire (codec)
}
RadiusAttribute { type: number; name: string; value: string|number|Uint8Array;
                  vendor?: { id: number; type: number } }
```

### 4.2 Dictionnaire

Attributs 1–63 + 79 (EAP-Message) + 80 (Message-Authenticator) + 87/88, avec
type de valeur et cardinalité ; VSA 26 structuré ; sous-dictionnaires
`vendor 9` (Cisco : av-pair 1) et `vendor 311` (Microsoft, RFC 2548).

### 4.3 Session d'accounting

```
AcctSession { sessionId, username, nasIp, nasPort, callingStationId,
              startedAt, updatedAt, inputOctets, outputOctets,
              status: 'start'|'interim'|'stop', terminateCause? }
```

Serveur : journal append-only interrogeable (base du futur log NPS/freeradius).

### 4.4 État des serveurs côté client

```
ServerState { config: RadiusServerConfig, alive: boolean, deadUntil?: number,
              stats: { requests, accepts, rejects, challenges, timeouts } }
```

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — Codec & dictionnaire** ✅ | `dictionary.ts`, `codec.ts` : encode/décode binaire, vecteurs de test issus de captures réelles ; champ `raw` sur le PDU | — |
| **P2 — Intégrité** ✅ | `authenticators.ts` : Response Authenticator conforme + **vérification client** (réponse invalide ignorée → retransmission), Message-Authenticator HMAC-MD5, Request Authenticator aléatoire ; ~~correction du port de réponse serveur et de la MAC destination~~ **[fait]** | P1 |
| **P3 — CHAP & Challenge** ✅ | CHAP client/serveur ; Access-Challenge + State + FSM client ; scénario challenge de bout en bout | P2 |
| **P4 — Accounting** 🟡 | `accounting.ts`, `RadiusAccountingClient`, traitement serveur + journal ; ~~câblage aaa accounting Cisco/Huawei~~ **[reporté]** ; événements | P1 |
| **P5 — Failover & observabilité** 🟡 | Groupes ordonnés, deadtime, compteurs par serveur ; ~~`show radius statistics` réels, `debug radius`, `test aaa group radius`~~ **[CLI reportée]** | P2 |
| **P6 — EAP 802.1X & autorisation** 🟡 | `eap.ts` (EAP-MD5), relais EAP-Message dans Dot1xAgent, attributs RFC 3580 ; `authorization.ts` : priv-lvl, Filter-Id, **VLAN dynamique**, Session-Timeout, Reply-Message ; ~~application effective côté switch (changement de VLAN réel, priv-lvl CLI)~~ **[reportée]** | P3 |
| **P7 — CoA/Disconnect** | `coa.ts`, `CoaListener` NAS, client CoA serveur ; Disconnect → fermeture session/port, CoA → ré-autorisation VLAN ; Error-Cause | P4, P6 |
| **P8 — Hébergement générique** 🟡 | Contrat `RadiusServerHost` consommable par LinuxServer/WindowsPC ; ~~egress client via table de routage + `source-interface`~~ **[fait]** ; ~~cache anti-duplication serveur~~ **[fait]** | P2 |

Chaque phase suit le cycle rouge → vert → refactor, avec interdiction de casser
les suites existantes (`radius-protocol.test.ts`, `dot1x-protocol.test.ts`,
`cisco-huawei-aaa-security.test.ts`, `huawei-aaa-mgmt.test.ts`).

---

## 6. Stratégie de test

1. **Unitaires codec** : round-trip encode/décode, vecteurs hexadécimaux de
   référence, attributs tronqués/illégaux → erreurs propres.
2. **Unitaires crypto** : User-Password (vecteurs RFC), CHAP, Response
   Authenticator, Message-Authenticator — dont cas négatifs (secret faux,
   paquet altéré → rejet silencieux + événement).
3. **Intégration réseau** : topologie NAS → switch → routeur → serveur
   (multi-sauts, via routes statiques/OSPF) exerçant l'egress par table de
   routage ; timeout/retransmission/failover en temps virtuel (`Scheduler`).
4. **Scénarios AAA** : login CLI Cisco/Huawei via groupe RADIUS avec fallback
   local ; privilège reçu par av-pair ; accounting Start/Stop visibles au
   journal serveur.
5. **Scénarios 802.1X** : EAP-MD5 complet, VLAN dynamique appliqué au port,
   Disconnect-Request → port unauthorized.
6. **Transcripts debug** (`src/__tests__/debug/protocols/`) : suite longue
   « lab RADIUS » (config complète des deux vendors + show/debug) pour analyse
   d'écart de sortie CLI.

---

## 7. Risques et points d'attention

1. **Rétro-compatibilité des tests existants** — les agents gardent leurs
   signatures (`authenticate(user, pass, serverIp?) → Promise<boolean>` reste,
   enrichie d'une surcharge retournant `RadiusAuthResult` avec autorisation) ;
   la vérification du Response Authenticator ne doit s'activer que lorsque le
   serveur émet un authenticator conforme (P2 livre les deux côtés ensemble).
2. **Le hack du port de réponse (gap 13)** est utilisé par le client actuel
   (source port `49152 + id`) : corriger les deux extrémités dans le même
   commit, sinon toutes les suites AAA cassent.
3. **HMAC-MD5** : vérifier ce que `@/crypto` offre ; sinon implémenter HMAC
   au-dessus du `md5` existant (RFC 2104) avec vecteurs de test.
4. **Scope creep EAP** : s'arrêter à EAP-MD5 ; PEAP/EAP-TLS explicitement hors
   périmètre (cf. §2.2).
5. **VLAN dynamique** : le port 802.1X est côté switch (`CiscoSwitch`/
   `HuaweiSwitch`) — l'application du VLAN passe par le hook
   `onDot1xPortAuthorized` existant à étendre, attention aux interactions avec
   VTP/STP dans les tests.
6. **Alignement TACACS+** : ne pas refactorer TACACS+ dans ce chantier, mais
   garder `authorization.ts` réutilisable par lui.

---

## 8. Critères d'acceptation

1. Un paquet Access-Request encodé par le codec est octet-pour-octet identique
   au vecteur de référence (utilisateur/mot de passe/secret imposés).
2. Une réponse au Response Authenticator invalide est ignorée par le client et
   la retransmission se déclenche (test en temps virtuel).
3. `aaa authentication login default group RADGRP local` sur Cisco : accès
   accordé via serveur, **niveau de privilège 15 appliqué** quand le serveur
   renvoie `shell:priv-lvl=15`, fallback local quand tous les serveurs sont morts.
4. Session SSH authentifiée RADIUS : le journal accounting du serveur contient
   Start puis Stop avec `Acct-Session-Time` > 0 et cause `User-Request`.
5. 802.1X EAP-MD5 : supplicant authentifié, port autorisé **dans le VLAN reçu
   par Tunnel-Private-Group-ID**, puis Disconnect-Request → port unauthorized
   en moins d'une seconde simulée.
6. `show radius statistics` affiche des compteurs non nuls et cohérents après
   un scénario mixte accepts/rejects/timeouts.
7. Toutes les suites existantes (`radius-protocol`, `dot1x-protocol`,
   `cisco-huawei-aaa-security`, `huawei-aaa-mgmt`, `cisco-aaa-acl`) passent
   sans modification de leurs assertions.

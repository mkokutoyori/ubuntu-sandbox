# PRD — Protocole DNS (fondation pour BIND 9)

**Version** : 1.0
**Date** : 2026-07-01
**Projet** : Ubuntu Sandbox — Module DNS
**Auteur** : Claude Code
**Références normatives** : RFC 1034, RFC 1035, RFC 6891, RFC 1995, RFC 1996, RFC 5936, RFC 4033, RFC 4034, RFC 4035, RFC 7858, RFC 8484, RFC 9250

---

## 0. Contexte et portée du document

Ce PRD couvre **uniquement le protocole DNS lui-même** — le moteur de messages, la
résolution (autoritaire et récursive/cache), le modèle de zone, le transfert de zone,
DNSSEC et les transports chiffrés. L'implémentation de **BIND 9** (fichiers de
configuration `named.conf`, CLI `named-checkconf`/`rndc`, structure `/etc/bind/`,
comportements spécifiques à cette distribution du logiciel) est un **projet
consécutif** qui s'appuiera sur les classes de domaine décrites ici, exactement comme
`LinuxDnsService`/`Dnsmasq.ts` s'appuient aujourd'hui sur `DnsWire.ts`. Aucune ligne de
code n'est écrite dans le cadre de ce document — il sert de base à la planification et
à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Lignes |
|---|---|---|
| `src/network/dns/DnsWire.ts` | Types de "message" DNS, mais **aucun encodage binaire** | 83 |
| `src/network/devices/linux/LinuxDnsService.ts` | Serveur DNS "à plat" (liste de records) + `dig`/`nslookup`/`host` | 397 |
| `src/network/devices/linux/commands/dns/Dnsmasq.ts` | Commande `dnsmasq` (démarrage/arrêt du service) | 55 |
| `src/network/devices/linux/nss/DnsNssSource.ts` | Source NSS (résolution `getent hosts`, glibc `gethostbyname`) | 176 |
| `src/network/devices/windows/WinDnsCache.ts` | Cache de résolveur Windows (`ipconfig /displaydns`) | — |

### 1.2 Ce qui existe déjà et est réutilisable

- Le **transport UDP/53 simulé** est réel : les requêtes traversent câbles, switches,
  routeurs et pare-feux (`DnsQueryFn` injecté dans `dig`/`nslookup`/`host`, résolu via
  le socket layer de l'hôte) — contrairement à DHCP qui, selon `DHCP_ANALYSIS.md`,
  appelle encore des méthodes directes en court-circuitant le réseau. C'est un socle
  solide à conserver.
- Les enregistrements de base (A, AAAA, PTR, MX, TXT, CNAME, NS, SOA) et leur TTL
  existent comme structure de données.
- `dig`/`nslookup`/`host` ont une sortie déjà fidèle au format réel (sections
  QUESTION/ANSWER, flags, `+short`, `-x`) et peuvent être conservés en façade au-dessus
  du nouveau moteur.

### 1.3 Ce qui est non conforme ou manquant (gap analysis face aux RFC visées)

| # | Manque | RFC concernée | Sévérité |
|---|---|---|---|
| 1 | Aucun encodage/décodage binaire du message DNS (en-tête 12 octets, compression de noms par pointeurs, sections QD/AN/NS/AR) | RFC 1035 §4 | Bloquant |
| 2 | Aucun modèle de **zone** : pas de fichier de zone, pas de notion d'autorité (`NS`/`SOA` réels), le "serveur" est une liste plate de records sans hiérarchie de délégation | RFC 1034 §3-4, RFC 1035 §5 | Bloquant |
| 3 | Aucun **résolveur récursif** : pas de suivi de délégation (référence NS → requête au serveur enfant), pas de cache avec TTL décroissant, pas de negative caching (RFC 2308 implicite) | RFC 1034 §5.3 | Élevée |
| 4 | Pas de distinction UDP/TCP ; aucune bascule TC=1 → retry TCP pour les réponses tronquées | RFC 1035 §4.2.2 | Élevée |
| 5 | Aucun support **EDNS(0)** (pseudo-RR OPT, taille de buffer UDP annoncée, extension de rcode 12 bits, flags DO) | RFC 6891 | Élevée |
| 6 | Aucune réplication de zone : pas d'AXFR, pas d'IXFR, pas de NOTIFY, pas de compteur SOA serial exploité | RFC 5936, RFC 1995, RFC 1996 | Élevée |
| 7 | Aucun DNSSEC : pas de RRSIG/DNSKEY/DS/NSEC/NSEC3, pas de chaîne de confiance, pas de validation | RFC 4033-4035 | Élevée |
| 8 | Aucun transport chiffré : tout est UDP/TCP en clair | RFC 7858 (DoT), RFC 8484 (DoH), RFC 9250 (DoQ) | Moyenne |
| 9 | Pas de bruit/latence réseau réaliste ni de simulation de perte UDP pour exercer les retries | — | Faible |
| 10 | Le "serveur" ne fait pas de différence entre réponse **autoritaire** (AA=1) et **non-autoritaire** (cache/résolveur) | RFC 1035 §4.1.1 | Moyenne |

**Conclusion de la phase d'analyse** : l'existant est une **simulation de haut niveau
utile pour l'UX du terminal** (dig/nslookup/host produisent une sortie plausible), mais
il n'existe **aucun moteur DNS conforme aux RFC** en dessous. Il faut un moteur neuf,
construit couche par couche, en réutilisant le transport UDP existant et en gardant les
commandes terminal comme façade finale (comme le veut la convention du projet — cf.
`ipconfig`, `route`, `ss`, `nc` migrés récemment vers des fichiers dédiés plutôt que des
stubs dans l'exécuteur).

---

## 2. Objectifs

### 2.1 Objectifs du protocole (ce PRD)

1. **Moteur de message binaire conforme RFC 1035 §4** : encodage/décodage réel,
   compression de noms, en-tête complet (QR, Opcode, AA, TC, RD, RA, Z, RCODE, QDCOUNT…),
   toutes les sections.
2. **Modèle de zone RFC 1034/1035 §3/§5** : zones chargées depuis un fichier de zone
   (format maître RFC 1035 §5), RRSet, SOA avec les 5 compteurs (serial, refresh, retry,
   expire, minimum), délégation NS, glue records.
3. **Deux rôles de serveur clairement séparés** :
   - **Serveur autoritaire** : répond avec AA=1 pour les zones qu'il héberge, gère les
     délégations vers des serveurs enfants (référrals) et l'AXFR/IXFR sortant.
   - **Résolveur récursif/cache** : suit les délégations depuis la racine simulée
     (ou un forwarder configuré), applique le TTL, fait du negative caching, distingue
     réponse depuis le cache (AA=0) vs autoritaire.
4. **EDNS(0)** (RFC 6891) : pseudo-RR OPT, UDP payload size négocié, extension RCODE,
   bit DO pour signaler le support DNSSEC.
5. **Réplication de zone** (RFC 1995 IXFR, RFC 1996 NOTIFY, RFC 5936 AXFR) entre un
   serveur primaire et des secondaires, avec transition TCP obligatoire pour AXFR.
6. **DNSSEC** (RFC 4033-4035) : signature de zone (RRSIG), clés (DNSKEY), délégation
   sécurisée (DS), preuve de non-existence (NSEC, puis NSEC3), validation côté
   résolveur avec construction de la chaîne de confiance jusqu'à un point d'ancrage
   configuré (pas de vraie racine Internet — trust anchor simulé).
7. **Transports chiffrés** : DoT (RFC 7858, TLS sur port 853), DoH (RFC 8484, HTTPS
   avec le média type `application/dns-message`), DoQ (RFC 9250, QUIC). Ces transports
   s'appliquent aussi bien au résolveur stub (client) qu'au chemin résolveur→autoritaire.

### 2.2 Non-objectifs (explicitement hors périmètre)

- Réplication de la vraie racine Internet ou des TLD réels — le simulateur reste un
  monde fermé avec des zones définies par l'utilisateur.
- Round-robin de charge / anycast — hors sujet protocole.
- DNS64/NAT64, mDNS/DNS-SD (Bonjour) — non demandés.
- Une implémentation QUIC générique bas niveau : DoQ réutilisera l'infrastructure QUIC
  du simulateur si elle existe, sinon une couche transport minimale suffisante pour
  distinguer DoQ des autres transports dans les tests, sans réécrire tout RFC 9000.
- BIND 9 lui-même (`named.conf`, `rndc`, CLI, structure de fichiers `/etc/bind`) — projet
  suivant, qui consommera ce moteur exactement comme `Dnsmasq.ts` consomme
  `LinuxDnsService` aujourd'hui.

---

## 3. Architecture cible

### 3.1 Principe directeur

Toutes les commandes terminal (`dig`, `nslookup`, `host`, futur `named`) restent des
**façades fines** au-dessus d'un moteur de domaine testable indépendamment du réseau —
même séparation que le module Oracle (`OracleDatabase` orchestrateur / `OracleExecutor`
moteur / `SQLPlusSession` façade CLI) et que la migration récente des commandes réseau
Linux (`commands/net/*.ts`, un fichier = une commande, aucune commande enfouie dans
`LinuxCommandExecutor`).

### 3.2 Diagramme de couches

```
+---------------------------------------------------------------------+
|                     COUCHE PRESENTATION (CLI)                       |
|  dig / nslookup / host / (futur) named-checkzone, rndc, dnssec-*    |
|  commands/dns/*.ts  — un fichier par commande, façade fine           |
+------------------------------+----------------------------------------+
                               | via DnsResolverClient / DnsServerFacade
+------------------------------v----------------------------------------+
|                    COUCHE RESOLUTION (Facade)                        |
|                                                                       |
|  DnsRecursiveResolver          DnsAuthoritativeServer                 |
|  - resolve(qname, qtype)       - answer(query): réponse depuis zone   |
|  - suit délégations NS         - AA=1, référrals vers enfants         |
|  - cache + negative caching     - AXFR/IXFR sortant, NOTIFY sortant   |
|  - validation DNSSEC optionnelle (bit DO)                             |
+--------+-------------------+---------------------+--------------------+
         |                   |                     |
+--------v-------+  +--------v-----------+  +------v-------------------+
| ZONE LAYER     |  |  CACHE LAYER       |  | TRANSFER LAYER            |
| Zone/RRSet     |  |  DnsCache (TTL,    |  | AxfrSession/IxfrSession   |
| SOA/NS/glue    |  |  negative cache)   |  | NotifyClient/Server       |
+--------+-------+  +---------------------+  +---------------------------+
         |
+--------v-------------------------------------------------------------+
|                    COUCHE SECURITE (DNSSEC)                            |
|  DnsSigner (RRSIG/DNSKEY) · DnsValidator (chaîne de confiance)         |
|  NSEC/NSEC3 (preuve de non-existence)                                  |
+------------------------------------------------------------------------+
         |
+--------v-------------------------------------------------------------+
|                    COUCHE MESSAGE (Codec bas niveau)                   |
|  DnsMessage (header, question, RR sections) — RFC 1035 §4              |
|  DnsMessageEncoder/Decoder — compression de noms par pointeurs         |
|  EdnsOptRecord — pseudo-RR OPT (RFC 6891)                              |
+------------------------------------------------------------------------+
         |
+--------v-------------------------------------------------------------+
|                    COUCHE TRANSPORT                                    |
|  UDP/53 (existant, réutilisé) · TCP/53 (fallback TC=1, AXFR)           |
|  DoT (TLS/853) · DoH (HTTPS, application/dns-message) · DoQ (QUIC/853) |
+------------------------------------------------------------------------+
```

### 3.3 Modules proposés (arborescence)

```
src/network/dns/
  wire/
    DnsMessage.ts            # Structure du message (header + 4 sections)
    DnsMessageCodec.ts       # encode()/decode() binaires, compression de noms
    DnsHeaderFlags.ts        # QR/Opcode/AA/TC/RD/RA/Z/RCODE — bit-packing
    ResourceRecord.ts        # RR générique + sous-types typés (A, AAAA, NS, SOA, MX, TXT, CNAME, PTR, SRV…)
    EdnsOptRecord.ts         # RFC 6891 — pseudo-RR OPT
  zone/
    Zone.ts                  # Zone chargée, RRSet indexé par (nom, type)
    ZoneFile.ts               # Parseur/writer du format maître RFC 1035 §5
    SoaRecord.ts              # serial/refresh/retry/expire/minimum + arithmétique de serial (RFC 1982)
    ZoneStore.ts              # Multi-zone, recherche de la zone la plus spécifique (longest match)
  resolver/
    DnsCache.ts               # Cache TTL-aware + negative caching
    RecursiveResolver.ts      # Suivi de délégation, hors-cache → requête itérative
    AuthoritativeServer.ts    # Réponses AA=1, référrals, glue records
  transfer/
    AxfrSession.ts            # RFC 5936 — transfert complet, obligatoirement TCP
    IxfrSession.ts            # RFC 1995 — transfert incrémental, fallback AXFR si trop de deltas
    NotifyProtocol.ts         # RFC 1996 — NOTIFY primaire→secondaires + réponse
  dnssec/
    DnsKey.ts                 # DNSKEY (ZSK/KSK), algorithmes signés (au minimum RSA/SHA-256, ECDSA P-256)
    DnsSigner.ts              # Génère RRSIG pour un RRSet
    DnsValidator.ts           # Vérifie RRSIG, construit la chaîne DS→DNSKEY jusqu'au trust anchor
    Nsec.ts / Nsec3.ts         # Preuve de non-existence
  transport/
    DnsUdpTransport.ts         # Existant, adapté au nouveau DnsMessageCodec
    DnsTcpTransport.ts         # Bascule TC=1, AXFR/IXFR, message préfixé par sa longueur (RFC 1035 §4.2.2)
    DnsTlsTransport.ts         # DoT — RFC 7858
    DnsHttpsTransport.ts       # DoH — RFC 8484
    DnsQuicTransport.ts        # DoQ — RFC 9250
  DnsWire.ts (déprécié → remplacé progressivement, cf. §5 plan de migration)
```

### 3.4 Design patterns retenus

| Pattern | Usage | Justification |
|---|---|---|
| **Codec / Value Object** | `DnsMessage`, `ResourceRecord`, `EdnsOptRecord` | Symétrie encode/decode testable indépendamment du réseau, cf. `DHCPPacket` recommandé dans `DHCP_ANALYSIS.md` |
| **Repository** | `ZoneStore`, `DnsCache` | Recherche par nom/type découplée du stockage physique |
| **Strategy** | Transport (UDP/TCP/DoT/DoH/DoQ) derrière une interface commune `DnsTransport` | Un seul point d'entrée pour le résolveur, indépendant du chiffrement |
| **State Machine** | `IxfrSession`/`AxfrSession` (négociation SOA → transfert → fin) | Modélise fidèlement le protocole de transfert |
| **Chain of Responsibility** | Résolution récursive (délégation en délégation jusqu'à la zone faisant autorité) | Reflète RFC 1034 §5.3.3 (algorithme de résolution) |
| **Facade** | Commandes CLI (`dig`, `nslookup`, futur `named`) | Même convention que le reste du projet |

---

## 4. Modèle de données

### 4.1 Message DNS (RFC 1035 §4.1)

```
En-tête (12 octets fixes) :
  ID (16 bits) | QR(1) Opcode(4) AA(1) TC(1) RD(1) | RA(1) Z(1) AD(1) CD(1) RCODE(4)
  QDCOUNT(16) | ANCOUNT(16) | NSCOUNT(16) | ARCOUNT(16)
Question(s) : QNAME (labels compressibles) | QTYPE(16) | QCLASS(16)
RR (Answer/Authority/Additional) : NAME | TYPE | CLASS | TTL(32) | RDLENGTH(16) | RDATA
```

Types de RR couverts en priorité : `A`, `AAAA`, `NS`, `CNAME`, `SOA`, `PTR`, `MX`, `TXT`,
`SRV` (utile pour les scénarios AD/Kerberos déjà présents ailleurs dans le simulateur),
puis DNSSEC : `RRSIG`, `DNSKEY`, `DS`, `NSEC`, `NSEC3`, `NSEC3PARAM`, et le pseudo-RR
`OPT` (EDNS).

### 4.2 Zone (RFC 1034 §3, RFC 1035 §5)

- Une **zone** est un ensemble de RRSets pour un domaine et ses sous-domaines, jusqu'à
  la prochaine délégation (NS pointant vers une zone enfant).
- `SoaRecord` porte MNAME, RNAME, SERIAL, REFRESH, RETRY, EXPIRE, MINIMUM — le SERIAL
  utilise l'arithmétique de comparaison circulaire RFC 1982 (indispensable pour IXFR/NOTIFY).
- Le format de fichier de zone (RFC 1035 §5.1) supporte `$ORIGIN`, `$TTL`, l'omission du
  nom (répétition du précédent), les commentaires `;`.

### 4.3 Cache résolveur

- Clé `(nom, type, classe)`, valeur = RRSet + horodatage d'insertion.
- TTL restant = `ttl_original - (now - insertion)`, expulsion à 0.
- **Negative caching** : une réponse NXDOMAIN/NODATA est cachée avec le TTL du champ
  MINIMUM du SOA de la zone autoritaire (comportement RFC 2308, implicitement requis
  pour un résolveur crédible même si RFC 2308 n'est pas dans la liste imposée).

---

## 5. Plan de mise en œuvre (TDD, par phases)

Chaque phase suit la méthode déjà appliquée dans cette session : rédaction des tests
d'abord (scénarios réels sur un LAN simulé avec de vrais équipements, pas de mocks de
topologie), puis implémentation jusqu'au vert, puis régression complète avant commit.
Aucun stub, aucun patch cosmétique, pas de commentaires dans le code de production.

| Phase | Contenu | RFC | Sortie testable |
|---|---|---|---|
| **1** | Codec de message binaire : header, question, RR génériques, compression de noms | RFC 1035 §4 | `DnsMessageCodec.encode(decode(x)) === x` (round-trip), vecteurs de test avec paquets hexadécimaux connus |
| **2** | Modèle de zone + fichier de zone + `ZoneStore` (recherche longest-match) | RFC 1034 §3-4, RFC 1035 §5 | Chargement d'un fichier de zone réel, requêtes A/NS/MX/SOA servies avec AA=1 |
| **3** | `AuthoritativeServer` branché sur le vrai transport UDP/TCP existant, remplace la liste plate actuelle | RFC 1035 §4.2, §6 | `dig @serveur nom TYPE` sur un vrai LAN retourne une réponse binaire correcte, TC=1 + retry TCP si tronqué |
| **4** | `RecursiveResolver` : délégation simulée entre plusieurs serveurs autoritaires (zones parent/enfant), cache + negative cache | RFC 1034 §5.3 | Un résolveur configuré avec un seul "root hint" simulé résout un nom à travers 2-3 niveaux de délégation réels sur le LAN |
| **5** | EDNS(0) : OPT record, taille UDP annoncée, RCODE étendu | RFC 6891 | `dig +bufsize=4096` produit un OPT correct ; réponse > 512 octets sans troncature si EDNS négocié |
| **6** | Réplication de zone : NOTIFY, AXFR, IXFR | RFC 1996, RFC 5936, RFC 1995 | Un secondaire notifié par un primaire déclenche un AXFR/IXFR réel sur TCP et sert ensuite les mêmes réponses |
| **7** | DNSSEC : signature de zone, DNSKEY/DS, validation, NSEC | RFC 4033-4035 | Un résolveur validant avec bit DO détecte une signature altérée (BOGUS) et une preuve NSEC pour NXDOMAIN |
| **8** | Transports chiffrés : DoT, DoH, DoQ | RFC 7858, RFC 8484, RFC 9250 | Requête `dig +tls` / `dig +https` / `dig +quic` aboutit avec le bon ALPN/port et la même sémantique de réponse |
| **9** | Nettoyage : dépréciation de l'ancien `DnsWire.ts`, migration de `LinuxDnsService`/`Dnsmasq.ts`/`WinDnsCache.ts` vers le nouveau moteur, suppression du code mort | — | Suite de régression complète (existing dig/nslookup/host tests) toujours verte |

La phase 9 est cruciale : **rien de l'existant ne doit régresser**. Le remplacement de
`DnsWire.ts` se fait par un adaptateur temporaire tant que tous les appelants
(`LinuxMachine.ts`, `EndHost.ts`, `LinuxNetKernel.ts`, `DnsNssSource.ts`) n'ont pas été
migrés un par un, avec la suite de tests existante comme filet de sécurité à chaque
étape (mêmes principes que les migrations `route`/`ss`/`nc` de cette session).

---

## 6. Stratégie de test

- **TDD strict** : écrire le scénario réel (topologie LAN avec de vrais `LinuxServer`/
  `CiscoRouter`/`GenericSwitch`, câblage réel, pas de mock du transport) avant le code.
- **Vecteurs de conformité** : pour le codec bas niveau, inclure des trames hexadécimales
  issues de captures réelles ou de la RFC elle-même, vérifiées en round-trip.
- **Tests négatifs systématiques** : réponses tronquées, SERIAL qui a tourné (wraparound
  RFC 1982), signature DNSSEC invalide, transfert de zone refusé (ACL), délégation vers
  un serveur injoignable.
- **Non-régression** : la suite `dig`/`nslookup`/`host`/`DnsNssSource` existante sert de
  golden master — comportement observable inchangé sauf là où le PRD demande
  explicitement un changement (ex : réponses désormais binaires correctement tronquées).

---

## 7. Risques et points d'attention

1. **Ampleur du DNSSEC** : implémenter des primitives cryptographiques crédibles
   (RSA/SHA-256, ECDSA) sans bibliothèque de crypto réelle est le risque le plus élevé du
   projet — comme pour IPsec/SSH dans ce simulateur, il faudra des primitives
   déterministes simulées plutôt qu'une vraie implémentation cryptographique, clairement
   documentées comme telles.
2. **DoQ (RFC 9250)** dépend de l'existence d'une couche QUIC dans le simulateur ; si
   absente, il faudra une couche transport minimale (framing + TLS 1.3 simulé) suffisante
   pour les tests, sans prétendre à une conformité RFC 9000 complète — à documenter
   explicitement comme limitation connue plutôt que fausse conformité.
3. **Blast radius de la migration `DnsWire.ts`** : 4 fichiers consommateurs identifiés
   (`LinuxMachine.ts`, `EndHost.ts`, `LinuxNetKernel.ts`, `DnsNssSource.ts`) — migration
   fichier par fichier avec régression à chaque étape, jamais un big-bang.
4. **Volume de travail** : ce PRD couvre à lui seul l'équivalent de plusieurs sessions de
   travail (le module DHCP comparable fait ~2400 lignes pour une conformité partielle
   RFC 2131 seule) ; la priorisation par phase (§5) permet de livrer de la valeur
   incrémentale testable sans attendre la conformité totale.

---

## 8. PRD — BIND 9 (`named`)

**Version** : 1.0 · **Date** : 2026-07-02 · **Statut** : les phases 1 à 8 du §5 sont
livrées ; ce chapitre est le PRD du projet consécutif annoncé, rédigé en place plutôt
que dans un `PRD-BIND9.md` séparé.

### 8.1 Contexte et portée

BIND 9 est la **couche distribution** au-dessus du moteur DNS du présent PRD : fichiers
de configuration `named.conf`, outils CLI (`named-checkconf`, `named-checkzone`,
`rndc`), unité systemd `named` (alias `bind9`), arborescence `/etc/bind/`,
journalisation `/var/log/named/`. Aucune logique protocolaire n'est réécrite : la
relation avec le moteur est exactement celle de `Dnsmasq.ts` avec `LinuxDnsService`,
ou de `SqlPlusSession` avec `OracleExecutor` — une façade de configuration et de
pilotage au-dessus de classes de domaine déjà testées.

Cible simulée : **BIND 9.18 sur Ubuntu** (paquet `bind9`, unité `named.service`,
utilisateur `bind`, configuration éclatée `/etc/bind/named.conf` →
`named.conf.options` / `named.conf.local` / `named.conf.default-zones` via `include`).

### 8.2 Points d'appui dans l'existant

| Existant | Réutilisation par BIND 9 |
|---|---|
| `dns/wire/*` (codec RFC 1035, EDNS) | Inchangé — `named` ne touche jamais au binaire directement |
| `dns/zone/ZoneFile.ts` (format maître §5) | Moteur de `named-checkzone` et du chargement des zones `type primary` |
| `dns/zone/ZoneStore.ts` + `dns/resolver/AuthoritativeServer.ts` | Cœur du plan de réponse AA=1 de `named` |
| `dns/resolver/RecursiveResolver.ts` + `DnsCache.ts` | Récursion (`recursion yes`, `forwarders`) |
| `dns/transfer/{Primary,Secondary}ZoneAgent.ts`, `NotifyProtocol.ts` | Zones `type primary`/`type secondary`, `also-notify`, `primaries` |
| `dns/transport/DnsUdpTransport.ts` (`bindDnsUdpServer`) et `DnsTcpTransport.ts` | Écoute réelle UDP/TCP 53 à travers la topologie simulée |
| `LinuxServiceManager` (`SERVICE_LISTENERS`, `dynamicListeners`, `registerConfigCheck`) | Unité `named`, cohérence port/process/service, pré-check de reload (analogue `sshd -t`) |
| `VirtualFileSystem` | `/etc/bind/*`, fichiers de zone, `/var/log/named/*`, `rndc.key` |
| `LinuxCommand`/`LinuxCommandRegistry` (un fichier = une commande) | `named-checkconf`, `named-checkzone`, `rndc` |
| `dig`/`nslookup`/`host` existants | Clients de test inchangés — ils interrogent `named` par le réseau |

### 8.3 Objectifs

1. **Parseur `named.conf`** — lexer + parseur du langage de configuration réel :
   directives terminées par `;`, blocs `{ }`, chaînes quotées, commentaires `//`, `#`
   et `/* */`, directive `include`. Erreurs avec fichier/ligne/colonne au format BIND
   (`/etc/bind/named.conf:12: missing ';' before '}'`).
2. **Modèle sémantique validé** — clauses supportées :
   - `options` : `directory`, `recursion yes|no`, `forwarders { ip; … }`, `forward
     only|first`, `allow-query`, `allow-recursion`, `allow-transfer`, `listen-on`
     (port et address-match-list), `dnssec-validation auto|yes|no`, `querylog`.
   - `zone "<nom>"` : `type primary|master|secondary|slave|forward|hint`, `file`,
     `primaries`/`masters { ip; … }`, `also-notify { ip; … }`, `allow-transfer`,
     `forwarders` (zones forward).
   - `acl "<nom>" { … }` avec les ACL nommées, les littéraux IP/CIDR, la négation `!`
     et les built-ins `any`, `none`, `localhost`, `localnets`.
   - `logging { channel …; category …; }` : channels `file`/`null`, catégories
     `default`, `queries`, `xfer-in`, `xfer-out`, `notify`, `security`.
   - `key` + `controls` : clé rndc (`/etc/bind/rndc.key`, HMAC simulé) et canal de
     contrôle `127.0.0.1:953`.
3. **`named-checkconf [-z] [fichier]`** — validation syntaxique et sémantique ;
   silencieux + code retour 0 si OK ; `-z` charge aussi chaque zone déclarée et
   affiche `zone <nom>/IN: loaded serial <n>`.
4. **`named-checkzone <zone> <fichier>`** — façade de `ZoneFile` ; sortie fidèle
   (`zone example.com/IN: loaded serial 2024010101` puis `OK`, ou l'erreur du parseur).
5. **Démon `named`** — `systemctl start named` : parse la configuration, charge les
   zones, ouvre UDP/TCP 53 réels (répond à travers câbles/switches/routeurs),
   applique les ACL par IP source (`allow-query` → REFUSED, `allow-recursion` → RA=0
   et refus de récursion, `allow-transfer` → refus d'AXFR), récursion et forwarders
   selon `options`. Configuration invalide au démarrage → l'unité passe `failed`,
   message dans le journal, port 53 fermé — exactement le comportement du vrai `named`.
6. **`rndc`** — via le canal de contrôle local : `status`, `reload [zone]`,
   `reconfig`, `flush`, `freeze [zone]` / `thaw [zone]`, `notify <zone>`,
   `querylog [on|off]`, `retransfer <zone>`. `rndc` refuse de parler à un démon
   arrêté (`rndc: connect failed: 127.0.0.1#953: connection refused`).
7. **Réplication pilotée par la configuration** — un `named` secondaire
   (`type secondary` + `primaries`) obtient la zone par AXFR/IXFR réel sur TCP via
   les agents de transfert existants ; un `rndc reload` côté primaire après édition
   du fichier de zone (serial incrémenté) déclenche NOTIFY → transfert → le
   secondaire sert la nouvelle donnée.
8. **Journalisation** — `/var/log/named/` selon la clause `logging` ; catégorie
   `queries` togglable à chaud par `rndc querylog` ; format des lignes fidèle
   (`client @0x… 10.0.1.2#53124 (www.example.com): query: www.example.com IN A +E(0) (10.0.1.10)` simplifié raisonnablement).

### 8.4 Non-objectifs

- `views`, RPZ (response-policy zones), zones catalogue, DLZ, GeoIP, `statistics-channels`.
- Mises à jour dynamiques RFC 2136 (`allow-update`, `nsupdate`) et GSS-TSIG.
- `dnssec-policy` / rollover automatique de clés — la signature de zone reste celle
  du moteur (§5 phase 7) ; `named` se contente de servir les zones signées.
- TSIG cryptographique réel : la clé rndc est un secret partagé simulé, comme SSH/IPsec.
- Le vrai réseau de la racine : les zones `type hint` pointent vers des serveurs
  simulés du LAN.

### 8.5 Architecture

```
src/network/devices/linux/bind9/
  NamedConfLexer.ts        tokens (mots, chaînes, { } ; ), commentaires, positions
  NamedConfParser.ts       AST brut : liste de clauses (statements imbriqués)
  NamedConfig.ts           modèle sémantique validé + NamedConfigError (fichier:ligne)
  NamedAcl.ts              address-match-list : littéraux, CIDR, !, built-ins, ACL nommées
  Bind9Service.ts          démon : cycle de vie, ZoneStore, sockets 53, ACL, récursion
  Bind9Logging.ts          channels/catégories → VFS /var/log/named/*
  RndcChannel.ts           contrôle 953 : dispatch des commandes rndc vers le démon
src/network/devices/linux/commands/dns/
  NamedCheckconf.ts        façade CLI
  NamedCheckzone.ts        façade CLI
  Rndc.ts                  façade CLI
```

Intégration `LinuxMachine` : instancie `Bind9Service` (injection du VFS, de l'hôte
réseau et du `ZoneStore`), enregistre l'unité `named` + son `ServiceListenerSpec`
dynamique (process `named`, UDP/TCP 53), et `registerConfigCheck('named', …)` pour
que `systemctl reload named` refuse une configuration invalide, comme pour `sshd`.

Patterns : mêmes choix que le moteur — le parseur produit un AST **immuable** validé
en aval (séparation lexer/parser/sémantique, comme `bash/` et `database/engine/`),
`Bind9Service` est une **State Machine** de cycle de vie (stopped → running → failed),
les ACL sont une **Chain of Responsibility** sur l'address-match-list, les commandes
CLI restent des **façades fines**.

### 8.6 Sémantique par défaut (fidèle à BIND 9.18)

| Option absente | Défaut appliqué |
|---|---|
| `recursion` | `yes` |
| `allow-query` | `any` |
| `allow-recursion` | `localnets; localhost;` |
| `allow-transfer` | `any` (avec avertissement `named-checkconf` si zone primaire sans restriction) |
| `listen-on` | toutes les adresses IPv4 de la machine, port 53 |
| `directory` | `/var/cache/bind` — les `file` relatifs s'y résolvent |
| `dnssec-validation` | `auto` (trust anchor simulé du §5 phase 7) |

### 8.7 Plan TDD (phases B1 → B7)

Méthode identique au §5 : tests d'abord sur topologies réelles (vrais équipements
câblés, jamais de mock du transport), implémentation jusqu'au vert, régression
complète avant commit, pas de commentaires dans le code de production.

| Phase | Contenu | Sortie testable |
|---|---|---|
| **B1** | Lexer + parseur `named.conf` (AST brut, `include`, 3 styles de commentaires) | Round-trip AST sur des configs Ubuntu réelles ; erreurs `fichier:ligne: message` exactes |
| **B2** | Modèle sémantique `NamedConfig` + `NamedAcl` + commande `named-checkconf` | Config valide → silence/rc 0 ; clause inconnue, ACL indéfinie, zone sans `file` → erreurs au format BIND ; `-z` charge les zones |
| **B3** | Commande `named-checkzone` (façade `ZoneFile`) | `loaded serial N` + `OK` ; fichier absent, SOA manquant, RR invalide → sorties d'erreur fidèles |
| **B4** | `Bind9Service` + unité systemd `named` + écoute UDP/TCP 53 réelle | `systemctl start named` puis `dig @serveur` depuis un autre hôte du LAN → réponse AA=1 ; config cassée → unité `failed`, port fermé |
| **B5** | ACL (`allow-query`, `allow-recursion`, `allow-transfer`) + récursion/forwarders | Client hors ACL → REFUSED ; `recursion no` → RA=0 ; forwarder joint à travers le LAN |
| **B6** | `rndc` + canal 953 + `Bind9Logging` + `querylog` | `rndc status`/`reload` (serial rechargé)/`flush`/`freeze`/`querylog on` → lignes dans `/var/log/named/query.log` |
| **B7** | Zones `type secondary`, `primaries`, `also-notify`, NOTIFY→XFR piloté par conf | Deux `named` sur un LAN : édition du fichier de zone + `rndc reload` côté primaire → le secondaire sert le nouveau serial |

### 8.8 Risques et points d'attention

1. **Fidélité des messages** — la valeur pédagogique du simulateur tient aux sorties
   exactes (`named-checkconf`, journal systemd, logs) ; chaque message est vérifié
   contre le comportement documenté de BIND 9.18 plutôt qu'inventé.
2. **Concurrence de démons DNS** — `dnsmasq` (existant) et `named` peuvent être
   installés sur la même machine : le port 53 est exclusif, le second à démarrer doit
   échouer avec `address already in use` dans le journal, pas silencieusement.
3. **Blast radius nul sur l'existant** — `LinuxDnsService`/`Dnsmasq.ts` et les suites
   `dig`/`nslookup`/`host` restent intacts ; `named` est purement additif et la
   régression complète doit rester verte à chaque phase.
4. **Périmètre `rndc`** — le canal de contrôle est local (127.0.0.1:953) dans un
   premier temps ; le pilotage distant (rndc -s) est préparé par l'architecture
   (RndcChannel découplé) mais hors périmètre initial.

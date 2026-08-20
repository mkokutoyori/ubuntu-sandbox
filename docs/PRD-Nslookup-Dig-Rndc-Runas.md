# PRD — Outils clients DNS (`nslookup`, `dig`), contrôle BIND9 réel (`rndc`) et exécution sous une autre identité (`runas`)

**Version** : 1.0
**Date** : 2026-07-06
**Projet** : Ubuntu Sandbox — simulateur réseau navigateur
**Auteur** : Claude (agent), à la demande de l'utilisateur
**Références normatives** :
- RFC 1035 (DNS — messages, types de ressource) — déjà couvert par `PRD-DNS.md`
- RFC 6891 (EDNS(0)) — déjà couvert par `PRD-DNS.md`
- RFC 4034/4035/5155 (DNSSEC) — déjà couvert par `PRD-DNS.md`
- ISC BIND 9 Administrator Reference Manual, chapitres *"Name Server Operations"* (`rndc`, `rndc.conf`, `named.conf` §`controls`/`key`) — protocole propriétaire ISC, non-RFC, mais documenté et stable depuis BIND 9.0
- Microsoft Docs — `runas` (command-line reference), `CreateProcessWithLogonW`/`LogonUserW` (Win32 API semantics), `Start-Process`/`Get-Credential`/`PSCredential` (PowerShell reference)

---

## 0. Contexte et portée du document

Ce PRD a été commandé pour quatre commandes : `nslookup`, `dig`, `rndc`, `runas`.
L'analyse de l'existant (§1) montre que **trois des quatre commandes sont déjà
implémentées et testées** dans ce dépôt, à un niveau de fidélité déjà élevé
(`docs/PRD-DNS.md` §5 et sa sous-section BIND9 §8). Ce PRD ne les réécrit donc
pas : il **documente l'existant**, puis cible des **manques réels et vérifiés**
par rapport au comportement des commandes réelles — notamment un `rndc` qui,
aujourd'hui, n'est qu'un aiguillage de méthodes in-process, sans le moindre
protocole réseau, alors que le vrai `rndc` est un client TCP authentifié par
HMAC. La quatrième commande, `runas`, a un vrai manque : elle existe mais sans
aucune vérification de mot de passe, ce qui est un défaut de fidélité sérieux
pour une commande dont la RAISON D'ÊTRE est le contrôle d'accès.

### 0.1 Principe directeur

Comme pour `PRD-FTP-SFTP.md` : chaque item est soit **additif** (nouvelle
capacité qui ne change le comportement d'aucune suite existante), soit une
**migration explicite et testée** d'un mécanisme simulé vers un mécanisme réel,
avec le même bar de qualité : le comportement observable des suites déjà
vertes ne doit pas régresser, sauf là où ce PRD change délibérément ce
principe (§2.2 le signale explicitement à chaque fois).

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Lignes (approx.) |
|---|---|---|
| `src/network/devices/linux/commands/dns/Nslookup.ts` | Façade `LinuxCommand` pour `nslookup` | 30 |
| `src/network/devices/linux/commands/dns/NslookupRunner.ts` | Logique non-interactive : parsing d'arguments, formatage de réponse façon `nslookup` réel | 127 |
| `src/network/devices/linux/commands/dns/Dig.ts` | Façade `LinuxCommand` pour `dig` | 36 |
| `src/network/devices/linux/commands/dns/DigRunner.ts` | Logique `dig` : `@server`, `+short`, `+noall`/`+answer`, `+tcp`/`+vc`, `+dnssec`, `+bufsize=`, AXFR/IXFR, sortie complète façon `dig` réel | 199 |
| `src/network/devices/linux/commands/dns/RecordFormat.ts` | Formatage RDATA commun à `nslookup`/`dig` | — |
| `src/network/devices/linux/commands/dns/resolverIP.ts` | Lecture de `/etc/resolv.conf` pour le serveur par défaut | — |
| `src/network/devices/linux/commands/dns/Rndc.ts` | Façade `LinuxCommand` pour `rndc` — délègue tout à `RndcChannel.dispatch(args)` | 27 |
| `src/network/devices/linux/bind9/RndcChannel.ts` | Dispatcher **in-process, synchrone, sans transport réseau** : `status`/`reload`/`reconfig`/`flush`/`freeze`/`thaw`/`querylog`/`retransfer` | 82 |
| `src/network/devices/linux/bind9/Bind9Service.ts` | Service BIND9 complet : zones, cache, transferts AXFR/IXFR/NOTIFY, écoute DNS réelle (UDP+TCP port 53 via `DnsUdpTransport`/`DnsTcpTransport`) | ~450 |
| `src/network/devices/linux/bind9/NamedConfig.ts` | Modèle + parseur de `named.conf` : `options`, `zone`, `acl`, `logging`, **`key` (nom/algorithme/secret, déjà parsé)**, **`controls` (syntaxiquement accepté mais entièrement jeté, `case 'controls': break;`)** | ~430 |
| `src/network/devices/linux/bind9/NamedConfParser.ts`/`NamedConfLexer.ts` | Lexer/parser génériques de la grammaire `named.conf` | — |
| `src/network/devices/WindowsPC.ts` (méthode `cmdRunas`, lignes ~2448-2492) | `runas` inline dans le gros `switch` cmd.exe : parse `/user:<nom>`, vérifie que le compte existe et est activé, **ne vérifie aucun mot de passe**, exécute la commande sous l'identité cible puis restaure l'identité précédente | ~45 |
| `src/network/devices/windows/WindowsUserManager.ts` | Modèle de compte Windows réel : `WindowsUser` (SID, mot de passe, `enabled`, complexité, historique), `checkPassword(name, password): boolean`, `isAdmin()`/`isCurrentUserAdmin()`, `ADMIN_PRIVILEGES`/`STANDARD_PRIVILEGES` | ~500 |
| `src/powershell/cmdlets/core/RemotingCmdlets.ts` (commentaire lignes 7-8) | `-Credential` accepté partout comme **chaîne brute `"user:password"`**, pas d'objet `PSCredential` | — |
| `src/powershell/cmdlets/core/ProcessCmdlets.ts` | `Start-Process`/`Get-Process` — **aucun paramètre `-Credential`** | — |
| `src/terminal/protocols/ssh/session/TerminalSshInteractionHandler.ts` | Référence de saisie interactive masquée dans ce terminal : `ITerminalIO.readInput(prompt, secret): Promise<string>`, déjà branché sur le flux SSH mot-de-passe | — |

### 1.2 Ce qui existe déjà et est réutilisable (ne pas reconstruire)

- **`nslookup`/`dig` non-interactifs** : le cœur (transport UDP/TCP réel via
  `ctx.net.queryDns`, formatage des types A/AAAA/CNAME/MX/NS/TXT/PTR/SOA/SRV,
  gestion des rcodes, EDNS(0), `+dnssec`) est déjà réel et fidèle — confirmé en
  lisant `NslookupRunner.ts`/`DigRunner.ts` en entier. Rien à refaire ici.
- **BIND9** : zones primaires/secondaires, AXFR/IXFR/NOTIFY, DNSSEC
  (signature + validation), journal de zone (`ZoneJournal`), ACL (`allow-query`
  etc.) sont un socle solide sur lequel les phases `rndc` de ce PRD s'appuient
  directement (rien à réécrire côté zones/DNSSEC).
- **`NamedConfig.keys`** (`ReadonlyMap<string, NamedKey>`, nom/algorithme/secret)
  est déjà parsé à partir de blocs `key { algorithm ...; secret ...; };` — c'est
  exactement le matériel de clé qu'un vrai canal `rndc` doit utiliser pour signer
  ses requêtes. Réutilisé tel quel.
- **`WindowsUserManager.checkPassword`** est prêt à l'emploi pour un vrai
  contrôle de mot de passe dans `runas`. Aucun nouveau modèle de compte à créer.
- **Le pattern de service réseau réel** posé par `Bind9Service`
  (écoute UDP+TCP réelle via un port configurable, `stop()`/`reload()`) est le
  gabarit à suivre pour le canal de contrôle `rndc` (nouveau port 953, même
  `EndHost`/`TcpStack`).

### 1.3 Ce qui est non conforme ou manquant (gap analysis)

| # | Manque | Comparé à | Sévérité |
|---|---|---|---|
| 1 | `nslookup` sans argument ne bascule pas en mode interactif (`>` prompt, `server`, `set type=`, `exit`) | `nslookup(1)` réel — l'usage le plus visible de la commande | Élevée |
| 2 | `nslookup`/`dig` : la détection d'adresse "littérale" pour le lookup inverse et pour `@server` ne reconnaît que l'IPv4 (`IPV4_LITERAL`) — un serveur ou une cible IPv6 échouent silencieusement | RFC 3596 (AAAA/`ip6.arpa`) | Moyenne |
| 3 | `dig` : `+tries=` est parsé puis explicitement ignoré (`continue`), aucune retransmission n'est jamais tentée | `dig(1)` réel | Faible |
| 4 | `dig` : pas de `+trace` (résolution itérative visible depuis la racine) | `dig(1)` réel, très utilisé en pédagogie DNS | Moyenne |
| 5 | `dig` : pas de `-p <port>`, pas de requêtes de classe `CH` (`dig CH TXT version.bind @server`, diagnostic BIND très courant) | `dig(1)` réel | Moyenne |
| 6 | `dig` : une seule requête par invocation ; pas de `-f <fichier>` (mode batch) ni de plusieurs `nom type` sur la même ligne | `dig(1)` réel | Faible |
| 7 | `rndc` n'a **aucun transport réseau** : `RndcChannel.dispatch()` est un appel de méthode in-process synchrone, jamais un client TCP. Impossible de faire `rndc -s <hôte-distant>` — signalé comme hors-périmètre explicite par `PRD-DNS.md` §8.8 risque #4 | Protocole `rndc` réel (TCP 953, message binaire signé HMAC-MD5/SHA256) | **Élevée** |
| 8 | `named.conf` : le bloc `controls { inet ... port ... allow { ... } keys { ... }; };` est syntaxiquement accepté puis **entièrement jeté** (`case 'controls': break;`) — aucune configuration de qui a le droit de se connecter, sur quel port, avec quelle clé | BIND9 réel | Élevée (bloque le #7) |
| 9 | `rndc` : sous-commandes manquantes par rapport à `rndc(8)` réel — `stop`/`halt`, `dumpdb`, `secroots` (pertinent : DNSSEC existe déjà), `validation [on\|off\|status]` (pertinent : la validation DNSSEC existe déjà côté résolveur) | `rndc(8)` réel | Moyenne |
| 10 | `rndc` : aucun parsing de `-s`/`-p`/`-k`/`-c`/`-y` sur la ligne de commande — le premier argument est toujours interprété comme la sous-commande | `rndc(8)` réel | Élevée (lié à #7) |
| 11 | `runas` : **aucune vérification de mot de passe** — n'importe quel utilisateur activé existant réussit sans authentification, ce qui contredit la finalité même de la commande (changement de contexte de sécurité) | `runas(1)`/`LogonUserW` réel | **Élevée** |
| 12 | `runas` : pas de `/savecred` (Credential Manager), pas de `/noprofile`\|`/profile` (accepté puis ignoré n'existe même pas), pas de `/netonly` | `runas(1)` réel | Moyenne |
| 13 | `runas` vit inline dans `WindowsPC.ts` plutôt que dans un fichier dédié `WinRunas.ts`, à rebours de la convention déjà suivie pour `WinPing.ts`/`WinWhoami.ts`/`WinIcacls.ts`/etc. | Convention interne du dépôt | Faible (style) |
| 14 | PowerShell n'a **aucun objet `PSCredential`** : `-Credential` est une chaîne `"user:password"` brute partout (`RemotingCmdlets.ts`), et `Start-Process` n'a pas de paramètre `-Credential` du tout | `Get-Credential`/`PSCredential`/`Start-Process -Credential` réels | Élevée |

---

## 2. Objectifs

### 2.1 Objectifs de ce PRD

1. **`nslookup` — mode interactif.** Invoqué sans nom à résoudre, `nslookup`
   entre dans une boucle `>` qui accepte : un nom nu (résolution avec le type
   courant), `server <host>` (change le serveur), `set type=<TYPE>`
   (change le type de requête), `set querytype=<TYPE>` (alias), `exit`/`quit`.
   Le mode non-interactif existant (un seul appel avec arguments) reste
   inchangé — c'est un ajout, pas une réécriture.
2. **`nslookup`/`dig` — IPv6.** Reconnaissance d'un serveur IPv6 littéral pour
   `@server`/le deuxième argument positionnel, et lookup inverse via
   `ip6.arpa` quand la cible est une adresse IPv6.
3. **`dig` — options avancées réalistes.** `+trace` (itération manuelle
   depuis la racine, en réutilisant le résolveur récursif existant en mode pas
   à pas si possible, sinon en simulant les hops via les données de zone déjà
   chargées), `-p <port>`, classe `CH` (`dig CH TXT version.bind`/`hostname.bind`
   répondant depuis `Bind9Service` quand la cible est un serveur BIND9 simulé),
   honorer réellement `+tries=` (retransmission bornée), `-f <fichier>` (mode
   batch, une requête par ligne), plusieurs `nom [type]` sur une même
   invocation.
4. **`rndc` — protocole réel.** Un vrai canal de contrôle : `Bind9Service`
   ouvre un écouteur TCP réel (port configurable, 953 par défaut) authentifié
   par HMAC (algorithme + secret venant du bloc `key` déjà parsé) ; le bloc
   `controls` de `named.conf` est réellement interprété (adresse d'écoute,
   port, ACL `allow`, clé autorisée) au lieu d'être jeté ; la commande CLI
   `rndc` devient un vrai client qui se connecte (localement ou à distance via
   `-s <hôte>`), signe sa requête, et interprète la réponse signée du serveur.
   `RndcChannel` reste le cœur métier (zéro changement de ses branches
   `status`/`reload`/etc.), mais il est désormais servi par ce transport réel
   au lieu d'être appelé nu.
5. **`rndc` — sous-commandes manquantes.** `stop`/`halt`, `dumpdb -all`
   (écrit un fichier récapitulatif via l'API `Bind9Files` déjà existante),
   `secroots` (dump des ancres de confiance DNSSEC déjà modélisées),
   `validation [on|off|status]` (bascule réelle sur le résolveur récursif
   existant).
6. **`runas` — vraie vérification de mot de passe.** Invite interactive
   masquée (`Enter the password for <user>:`) suivant le pattern déjà établi
   par `ITerminalIO.readInput(prompt, secret=true)` (précédent SSH) ; échec
   avec le message réel `RUNAS ERROR: Unable to run the specified program.
   The user name or password is incorrect.` en cas de mot de passe faux (limité
   à un nombre borné de tentatives comme le vrai `runas`) ; extraction dans
   `WinRunas.ts` (convention du dépôt) ; support de `/savecred` (stocke/relit
   via un petit "coffre" par utilisateur, cohérent avec le modèle
   `WindowsUserManager` existant) et de `/netonly` (n'affecte que
   l'authentification réseau simulée, pas l'exécution locale — documenté comme
   simplification assumée, §2.2).
7. **PowerShell — `PSCredential` réel.** Nouveau type `PSCredential`
   (`UserName`, `Password` en `SecureString` simulé — déjà existe-t-il un
   `SecureString` ? à vérifier en phase d'implémentation, sinon modélisé
   minimalement), cmdlet `Get-Credential` (prompt interactif réutilisant le
   même mécanisme que `runas`), et `Start-Process -Credential <PSCredential>`
   qui vérifie réellement le mot de passe via `WindowsUserManager.checkPassword`
   avant de lancer le process sous l'identité cible — le pendant PowerShell de
   `runas`.

### 2.2 Non-objectifs (explicitement hors périmètre)

- **Réécriture de `nslookup`/`dig` non-interactifs** : ils sont déjà réels et
  ne sont pas touchés hors des ajouts listés en §2.1.
- **`rndc` distant à travers un routeur/pare-feu multi-saut** : comme pour le
  précédent PRD FTP/SFTP, une connexion TCP simulée à travers plusieurs sauts
  routés est une limitation connue du simulateur (`TcpStack` multi-saut), pas
  quelque chose que ce PRD tente de réparer. Le `-s <hôte>` distant sera
  validé sur un même segment L2 (topologie câblée directe ou via switch),
  comme les tests SSH/SFTP/FTP déjà écrits.
- **Chiffrement du canal `rndc`** (le vrai protocole rndc n'est pas chiffré,
  seulement signé/authentifié — donc rien à faire ici, c'est déjà le
  comportement cible).
- **`SecureString` Windows réel** (chiffrement DPAPI) : le `PSCredential`
  ajouté ici modélise la forme (objet avec nom d'utilisateur + secret), pas
  la protection cryptographique réelle de `SecureString` sous Windows — hors
  périmètre, comme documenté pour d'autres primitives Windows déjà
  simplifiées dans ce dépôt.
- **`/netonly` avec double authentification réseau réelle** : `/netonly`
  change officiellement le comportement réseau uniquement (les credentials ne
  sont vérifiés qu'au moment d'un accès réseau, pas immédiatement) — ce PRD
  documente la sémantique mais n'implémente pas un modèle de "credentials
  différés" complet ; `/netonly` est accepté et n'échoue pas la commande,
  sans validation immédiate du mot de passe (cohérent avec le comportement réel
  côté UX, simplifié côté modèle interne).
- **Client/serveur `rndc` graphique ou console interactive façon `named`
  monitoring** — seule l'invocation en ligne de commande est visée.

---

## 3. Architecture cible

### 3.1 Principe directeur

Chaque item suit le même principe que le PRD FTP/SFTP : quand une brique
existe déjà mais est "sémantique seulement" (comme `RndcChannel` aujourd'hui),
on lui ajoute une **couche de transport réelle par-dessus**, sans réécrire son
cœur métier. Le cœur métier reste testable isolément (déjà fait), le
transport ajoute une deuxième couche de tests end-to-end.

### 3.2 Diagramme de couches (rndc, l'ajout le plus structurant)

```
┌──────────────────────────────────────────────────────────────────┐
│  CLI `rndc` (Rndc.ts)                                             │
│  parse -s/-p/-k/-c/-y + sous-commande                             │
└───────────────────────────┬────────────────────────────────────────┘
                            │ (local : appel direct   |   distant : TCP réel)
┌───────────────────────────▼────────────────────────────────────────┐
│  RndcClient.ts (NOUVEAU)                                          │
│  encode requête (RndcWireCodec.ts) → HMAC(secret) → TCP 953        │
│  décode réponse signée, vérifie le HMAC                            │
└───────────────────────────┬────────────────────────────────────────┘
                            │ TCP (réel, EndHost.getTcpStack())
┌───────────────────────────▼────────────────────────────────────────┐
│  RndcServer.ts (NOUVEAU) — porté par Bind9Service                  │
│  écoute TCP réelle, vérifie ACL (`controls{allow{}}`) + HMAC        │
│  décode → RndcChannel.dispatch(args) (INCHANGÉ) → encode réponse    │
└───────────────────────────┬────────────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────────────┐
│  RndcChannel.ts (EXISTANT, non modifié dans son cœur)              │
│  status/reload/reconfig/flush/freeze/thaw/querylog/retransfer      │
│  + stop/halt/dumpdb/secroots/validation (NOUVEAU, additif)          │
└──────────────────────────────────────────────────────────────────┘
```

### 3.3 Modules proposés (arborescence)

```
src/network/devices/linux/commands/dns/
├── Nslookup.ts                       # existant — ajoute la branche interactive
├── NslookupRunner.ts                 # existant — ajoute IPv6 literal detection
├── NslookupInteractive.ts            # NOUVEAU — boucle `>` (server/set type/exit)
├── Dig.ts                            # existant
├── DigRunner.ts                      # existant — +trace, -p, CH class, +tries réel, -f
├── DigTrace.ts                       # NOUVEAU — itération +trace
└── Rndc.ts                           # existant — parse -s/-p/-k/-c/-y, délègue à RndcClient

src/network/devices/linux/bind9/
├── RndcChannel.ts                    # existant — + stop/halt/dumpdb/secroots/validation
├── RndcWireCodec.ts                  # NOUVEAU — format de message rndc réel + HMAC
├── RndcClient.ts                     # NOUVEAU — client TCP (local ou -s distant)
├── RndcServer.ts                     # NOUVEAU — écouteur TCP réel, ACL + HMAC, porté par Bind9Service
├── NamedConfig.ts                    # existant — bloc `controls` réellement parsé (NamedControls)
└── Bind9Service.ts                   # existant — ouvre/ferme le RndcServer selon `controls{}`

src/network/devices/windows/
└── WinRunas.ts                       # NOUVEAU — extrait de WindowsPC.cmdRunas, + mot de passe réel,
                                       #   /savecred, /netonly

src/powershell/
├── credential/
│   └── PSCredential.ts               # NOUVEAU — type + Get-Credential
└── cmdlets/core/
    └── ProcessCmdlets.ts             # existant — Start-Process gagne -Credential
```

### 3.4 Design patterns retenus

| Pattern | Usage | Justification |
|---|---|---|
| Codec/Transport séparés (comme `SftpWireCodec`/`SftpWireSession`) | `RndcWireCodec.ts` (pur, testable en isolation) vs `RndcClient.ts`/`RndcServer.ts` (I/O réel) | Même séparation qui a fait ses preuves sur SFTP/SCP dans le PRD précédent |
| Décorateur additif sur une classe existante | `RndcChannel` reçoit de nouvelles branches de switch sans toucher aux existantes | Zéro régression sur les tests `rndc` déjà verts |
| Extraction de fichier (convention du dépôt) | `runas` inline → `WinRunas.ts` | Aligne `runas` sur `WinPing.ts`/`WinWhoami.ts`/etc. |
| Injection d'un moyen d'entrée interactif | `runas`/`Get-Credential` réutilisent `ITerminalIO.readInput` (déjà utilisé par SSH) | Un seul mécanisme de saisie masquée dans tout le projet, pas une deuxième implémentation parallèle |

---

## 4. Modèle de données

### 4.1 Message `rndc` réel (format ISC, simplifié pour ce simulateur)

Le vrai protocole `rndc` encode un dictionnaire de commande dans une syntaxe
proche d'un buffer binaire signé ; ce simulateur modélise fidèlement les deux
propriétés qui comptent réellement (authenticité par HMAC, contenu de
commande explicite), sans reproduire le format binaire ISC bit-à-bit :

```ts
interface RndcRequest {
  readonly nonce: number;          // anti-rejeu simple, incrémental par connexion
  readonly command: string;        // ex. "status", "reload zone1"
}

interface RndcResponse {
  readonly nonce: number;          // doit correspondre à la requête
  readonly result: number;         // 0 = succès, sinon code d'erreur
  readonly text: string;           // texte à afficher (stdout de rndc)
}

type RndcHmacAlgorithm = 'hmac-md5' | 'hmac-sha256'; // déjà les valeurs acceptées par NamedConfig.NamedKey.algorithm

interface RndcWireEnvelope {
  readonly hmac: string;           // hex, HMAC(algorithm, secret, JSON.stringify(payload))
  readonly payload: RndcRequest | RndcResponse;
}
```

### 4.2 `controls` dans `NamedConfig` (actuellement jeté, désormais réel)

```ts
export interface NamedControls {
  readonly address: string;         // "127.0.0.1" ou "*"
  readonly port: number;            // 953 par défaut
  readonly allow: AddressMatchList; // réutilise le type ACL déjà existant
  readonly keys: readonly string[]; // noms de clés autorisées (doivent exister dans NamedConfig.keys)
}

// NamedConfig gagne : readonly controls: readonly NamedControls[];
```

### 4.3 `PSCredential` (PowerShell)

```ts
export interface PSCredential {
  readonly userName: string;
  /** Modélisation simplifiée d'un SecureString — voir §2.2 (pas de DPAPI). */
  readonly password: string;
  getNetworkCredential(): { userName: string; password: string };
}
```

### 4.4 `runas` — options reconnues

```ts
interface RunasOptions {
  readonly user: string;
  readonly savecred: boolean;
  readonly noProfile: boolean;
  readonly netOnly: boolean;
  readonly command: string;
}
```

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — `nslookup` mode interactif** | `NslookupInteractive.ts` : boucle `>`, `server`, `set type=`/`set querytype=`, `exit`/`quit` ; `Nslookup.ts` bascule dessus quand `args` est vide | Existant (P13-domaine DNS déjà livré) |
| **P2 — IPv6 dans `nslookup`/`dig`** | Détection d'adresse IPv6 littérale (serveur et cible de lookup inverse via `ip6.arpa`) dans `NslookupRunner.ts`/`DigRunner.ts` | P1 |
| **P3 — `dig` options avancées (partie 1)** | `-p <port>`, classe `CH` (`version.bind`/`hostname.bind` répondant depuis `Bind9Service` si la cible en est un), `+tries=` réellement honoré (retransmission bornée) | Existant |
| **P4 — `dig +trace`** | `DigTrace.ts` : itération manuelle depuis la racine en réutilisant les données de zone déjà chargées / le résolveur récursif existant, avec affichage d'un bloc `;; ... SECTION` par saut | P3 |
| **P5 — `dig` mode batch** | `-f <fichier>`, plusieurs `nom [type]` sur une même invocation | P3 |
| **P6 — `controls{}` réellement parsé** | `NamedConfig` gagne `NamedControls[]` ; `NamedConfParser`/`NamedConfig.ts` interprètent `inet`/`port`/`allow`/`keys` au lieu de `break` | Existant (`NamedAcl.ts`, `NamedConfig.keys`) |
| **P7 — Codec de fil `rndc` réel** | `RndcWireCodec.ts` : encode/décode `RndcRequest`/`RndcResponse`, calcul et vérification HMAC (hmac-md5/hmac-sha256) — testé en isolation, sans réseau | P6 |
| **P8 — Serveur `rndc` réel** | `RndcServer.ts` : écoute TCP réelle portée par `Bind9Service` (port depuis `controls{}`, ACL `allow{}` appliquée avant même le HMAC, comme le vrai BIND), délègue au `RndcChannel` existant, renvoie une réponse signée | P7 |
| **P9 — Client `rndc` réel** | `RndcClient.ts` + `Rndc.ts` parse `-s <hôte>`/`-p <port>`/`-k <fichier de clé>`/`-c <rndc.conf>`/`-y <nom de clé>` ; connexion locale (127.0.0.1) ou distante (même segment L2) | P8 |
| **P10 — Sous-commandes `rndc` manquantes** | `stop`/`halt`, `dumpdb -all`, `secroots`, `validation [on\|off\|status]` ajoutés à `RndcChannel` (additif, ne touche aucune branche existante) | Existant (DNSSEC déjà livré) |
| **P11 — `runas` : vraie vérification de mot de passe** | Extraction dans `WinRunas.ts` ; invite interactive masquée (réutilise `ITerminalIO.readInput`) ; échec avec le message réel `RUNAS ERROR: ... incorrect.` ; tentatives bornées | Existant (`WindowsUserManager.checkPassword`) |
| **P12 — `runas` : `/savecred` et `/netonly`** | Petit coffre par utilisateur (mémoire du process, pas de persistance disque simulée nécessaire) pour `/savecred` ; `/netonly` accepté et documenté (§2.2) | P11 |
| **P13 — `PSCredential` + `Get-Credential`** | `src/powershell/credential/PSCredential.ts`, cmdlet `Get-Credential` (prompt interactif) | P11 (réutilise le même mécanisme de saisie) |
| **P14 — `Start-Process -Credential`** | `ProcessCmdlets.ts` gagne `-Credential`, vérifie via `WindowsUserManager.checkPassword`, échoue avec un message PowerShell idiomatique sinon | P13 |

Chaque phase suit le cycle rouge → vert → refactor, régression localisée à
chaque phase, régression complète (`npx vitest run`) toutes les 5 phases
(après P5, après P10, après P14) — même discipline que le PRD FTP/SFTP.

---

## 6. Stratégie de test

1. **`nslookup` interactif** : entrer dans le mode, taper un nom, changer de
   type via `set type=MX`, changer de serveur via `server 8.8.8.8` (dans ce
   simulateur : une IP configurée sur une autre zone/serveur du labo), sortir
   via `exit` — vérifier que chaque étape produit la sortie attendue et que le
   mode non-interactif existant n'a pas changé d'une ligne.
2. **IPv6** : `dig @2001:db8::53 exemple.test`, `nslookup <adresse IPv6>`
   (lookup inverse via `ip6.arpa`) round-trip correctement.
3. **`dig +trace`** : contre un labo avec une racine simulée + délégation,
   vérifie que chaque saut apparaît avec le bon NS et la bonne adresse.
4. **`dig` classe CH** : `dig CH TXT version.bind @<bind9-simulé>` renvoie la
   bannière de version réelle du service.
5. **`rndc` bout-en-bout réel** : topologie câblée avec un `Bind9Service` dont
   `named.conf` déclare un `controls{}` + une `key{}` ; un `rndc` lancé sur un
   AUTRE hôte du même segment avec `-s <ip> -k <fichier>` réussit ; avec une
   mauvaise clé, la requête est rejetée (HMAC invalide) — capturer les octets
   bruts échangés (comme `ssh-sftp-wire-migration.test.ts` l'a fait pour SFTP)
   pour prouver que c'est un vrai aller-retour TCP signé, pas un mock.
6. **`rndc` ACL** : une IP hors de `controls{allow{...}}` est refusée avant
   même la vérification HMAC.
7. **`runas` mot de passe** : bon mot de passe → succès inchangé ; mauvais mot
   de passe → message d'erreur réel, aucune exécution ; compte désactivé →
   message existant inchangé (non-régression).
8. **`/savecred`** : première invocation demande le mot de passe, la
   deuxième invocation avec `/savecred` ne le redemande pas.
9. **`PSCredential`/`Start-Process -Credential`** : `Get-Credential` suivi de
   `Start-Process -Credential $cred` réussit avec le bon mot de passe, échoue
   proprement sinon.
10. **Non-régression** : suites `nslookup`/`dig`/`rndc`/`bind9-*` et
    `windows-*`/`powershell` déjà vertes ré-exécutées après chaque phase.

---

## 7. Risques et points d'attention

1. **Fidélité du format binaire `rndc`** — le protocole ISC réel encode un
   dictionnaire dans un format binaire spécifique (`isccc`) ; ce PRD assume
   une fidélité "protocole réel : TCP + HMAC + contenu explicite", pas une
   compatibilité bit-à-bit avec un vrai client `rndc` OpenBSD/ISC — cohérent
   avec la façon dont `SftpWireCodec.ts` avait déjà choisi la fidélité
   "protocole réel mais pas obsessionnellement bit-exact" plutôt que la copie
   exacte d'OpenSSH.
2. **`+trace` et le résolveur récursif existant** — `RecursiveResolver.ts`
   fait probablement déjà l'itération en interne sans exposer les étapes
   intermédiaires : il faudra soit lui ajouter un mode "verbeux" (probable,
   à confirmer en P4), soit ré-implémenter une itération minimale dédiée à
   l'affichage sans dupliquer la logique de résolution.
3. **`rndc -s` à travers un routeur** — même limitation multi-saut TCP déjà
   rencontrée sur SFTP/SCP (P11 du PRD FTP/SFTP) ; les tests resteront sur un
   segment L2 direct.
4. **`SecureString`** — vérifier en préambule de P13 si un concept de
   `SecureString` existe déjà côté PowerShell (`src/powershell/`) avant de
   modéliser `PSCredential.password` en chaîne simple.
5. **Interactivité `cmd.exe`** — confirmer en préambule de P11 le mécanisme
   exact de saisie masquée déjà câblé côté terminal Windows (l'équivalent de
   `ITerminalIO` utilisé par SSH côté Linux) avant d'écrire l'invite
   `runas`.

---

## 8. Critères d'acceptation

1. `nslookup` sans argument entre en mode interactif ; toutes les
   sous-commandes listées en §2.1.1 fonctionnent ; le mode non-interactif est
   inchangé (mêmes tests existants toujours verts).
2. `dig`/`nslookup` acceptent une adresse IPv6 comme serveur ou cible de
   lookup inverse.
3. `dig +trace`, `dig CH TXT version.bind`, `dig -p <port>`, `dig -f
   <fichier>`, plusieurs requêtes par invocation, et un `+tries=` réellement
   honoré fonctionnent contre un labo simulé.
4. `rndc` parle un vrai protocole TCP authentifié par HMAC ; `controls{}`
   dans `named.conf` est réellement interprété (ACL + clé) ; `rndc -s
   <hôte-distant-même-segment>` fonctionne ; une clé ou une IP non autorisée
   est rejetée.
5. `rndc stop`/`halt`/`dumpdb -all`/`secroots`/`validation` fonctionnent.
6. `runas` vérifie réellement le mot de passe (invite masquée, échec avec le
   message réel en cas d'erreur, tentatives bornées) ; `/savecred` et
   `/netonly` sont pris en charge comme décrit en §2.1.6/§2.2.
7. PowerShell dispose d'un vrai `PSCredential`, de `Get-Credential`, et de
   `Start-Process -Credential`.
8. Aucune régression sur les suites `nslookup`/`dig`/`rndc`/`bind9-*`/
   `windows-*`/`powershell` déjà vertes.

# PRD — Courrier électronique : SMTP/ESMTP (RFC 5321, 5322, 1870, 6152, 2920, 3463/5248), sécurisation (STARTTLS RFC 3207, AUTH RFC 4954/4616/2195) et authentification anti-usurpation (SPF RFC 7208, DKIM RFC 6376, DMARC RFC 7489)

**Version** : 1.0
**Date** : 2026-07-24
**Projet** : Ubuntu Sandbox — Module SMTP
**Auteur** : Claude Code
**Références normatives** : RFC 5321 (Simple Mail Transfer Protocol —
canal de contrôle, machine à états, enveloppe MAIL FROM/RCPT TO, routage
par MX), RFC 5322 (Internet Message Format — en-têtes From/To/Subject/
Date/Message-ID, distincts de l'enveloppe SMTP), RFC 1870 (extension
`SIZE`), RFC 6152 (extension `8BITMIME`), RFC 2920 (extension
`PIPELINING`), RFC 3463 + RFC 5248 (codes de statut étendus
« Enhanced Mail System Status Codes », ex. `2.1.0`/`5.1.1`), RFC 3207
(sécurisation par TLS — `STARTTLS`, upgrade en place du canal en clair),
RFC 8446 (TLS 1.3 — prérequis externe pour `STARTTLS`, cf. `PRD-TLS.md`,
**déjà livré**), RFC 4954 (extension `AUTH`), RFC 4616 (mécanisme SASL
`PLAIN`), RFC 2195 (mécanisme SASL `CRAM-MD5`), RFC 7208 (Sender Policy
Framework — SPF), RFC 6376 (DomainKeys Identified Mail — DKIM), RFC 7489
(Domain-based Message Authentication, Reporting and Conformance —
DMARC), RFC 1035/1034 (DNS — enregistrements `MX`/`TXT`, déjà livrés dans
ce dépôt, cf. § 1.2).

---

## 0. Contexte et portée du document

Ce PRD couvre **deux chantiers** réunis dans un même document parce
qu'ils portent tous deux sur le **courrier électronique** et que le
second consomme directement l'infrastructure livrée par le premier
(exactement la relation que `PRD-FTP-SFTP.md` établit entre FTP et son
ALG NAT, ou FTPS et le moteur TLS) :

1. **SMTP/ESMTP** (RFC 5321/5322/1870/6152/2920/3463-5248) + sa
   sécurisation (`STARTTLS`, RFC 3207) + son authentification
   (`AUTH`, RFC 4954/4616/2195) : construction **greenfield** d'un canal
   de contrôle SMTP réel (connexion, commandes texte, réponses à code
   numérique), de l'enveloppe de transport distincte du message RFC 5322,
   de la négociation de capacités ESMTP, de la remise locale réelle
   (dépôt dans une boîte `/var/mail/<user>`) et du relais sortant par
   résolution MX réelle. **Il n'existe aujourd'hui aucune implémentation
   SMTP dans ce dépôt** (§ 1.1) — comparable à l'état de FTP avant
   `PRD-FTP-SFTP.md`, de RADIUS avant son propre PRD, ou de TLS avant le
   sien.
2. **Authentification anti-usurpation** (SPF RFC 7208, DKIM RFC 6376,
   DMARC RFC 7489) : trois mécanismes déclaratifs (enregistrements DNS
   `TXT`) et cryptographiques (signature DKIM) qui s'appuient
   directement sur deux briques **déjà livrées et stables** dans ce
   dépôt — le moteur DNS (enregistrements `MX`/`TXT` déjà supportés,
   § 1.2) et la PKI simulée (`PkiKeyPair`, déjà réutilisée par TLS et
   LDAP StartTLS, § 1.2) — et sur le moteur SMTP du chantier 1 (point
   d'évaluation à la réception, point de signature à l'émission).

Le chantier 2 **ne duplique aucune primitive** : il consomme le moteur
DNS et la PKI existants exactement comme `PRD-FTP-SFTP.md` a consommé le
moteur TLS pour FTPS — aucune nouvelle primitive cryptographique n'est
introduite, aucun second parseur DNS n'est écrit.

Ce PRD **couvre aussi le branchement** de deux points d'attente déjà
présents dans le code et actuellement inertes (§ 1.1) : le hook
`deliverMail` de `cron` (`LinuxCommandExecutor.ts`, actuellement un
no-op strict) et la convention de boîte aux lettres `/var/mail/<user>`
(déjà référencée par la variable d'environnement `MAIL` et par le
message de `userdel`, mais jamais peuplée par une remise réelle).

Aucune ligne de code n'est écrite dans le cadre de ce document — il sert
de base à la planification et à la revue avant le premier commit TDD.

### 0.1 Chaîne de dépendances entre PRDs

```
PRD-TLS.md (RFC 8446) — livré, P1 à P11
   │  moteur TLS 1.3 réel (TlsClientSession/TlsServerSession)
   │  + le codec d'enregistrements réutilisable (TlsRecordWire.ts)
   │  + le précédent d'upgrade en place déjà établi par
   │    ldapStartTls.ts (RFC 4511 §4.14.1)
   │
   ▼
Moteur DNS existant (src/network/dns/, antérieur à la convention PRD —
même remarque que PRD-FTP-SFTP.md § 0.1 fait pour SSH) — enregistrements
`MX`/`TXT` déjà encodés/décodés/stockés (§ 1.2), aucun travail
supplémentaire requis pour que SMTP et SPF/DMARC les consomment
   │
   ▼
PKI simulée existante (src/network/pki/, antérieure à la convention PRD)
— `PkiKeyPair`/`X509Certificate`, déjà réutilisée par TLS et LDAP
StartTLS pour des certificats auto-signés
   │
   ▼
PRD-SMTP.md                                              ◄── VOUS ÊTES ICI
   │  Chantier 1 (SMTP/ESMTP/STARTTLS/AUTH) : greenfield, consomme TLS
   │  (livré) pour STARTTLS, sans autre dépendance bloquante
   │
   │  Chantier 2 (SPF/DKIM/DMARC) : consomme le moteur DNS existant
   │  (MX/TXT) et la PKI existante (signature DKIM), et le moteur SMTP
   │  du chantier 1 (point d'évaluation/signature) — dépend donc de P1
   │  à P12 de ce même document, pas d'un PRD externe
   ▼
(aucun consommateur PRD identifié pour l'instant — `cron` et la
convention `/var/mail/` sont des consommateurs internes déjà présents
dans le code, pas des PRDs frères, cf. § 2.1.12/§2.1.13)
```

Comme `PRD-FTP-SFTP.md`, ce PRD **n'a aucune dépendance bloquante** :
son unique dépendance externe formelle (`PRD-TLS.md`) est déjà
intégralement livrée, et ses autres dépendances (moteur DNS, PKI) sont
du code déjà en production dans ce dépôt, antérieur à la convention PRD.
Toutes les phases du § 5 concernant le chantier 1 peuvent démarrer
immédiatement ; celles du chantier 2 attendent uniquement la stabilisation
interne du chantier 1 (§ 5).

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Constat |
|---|---|---|
| `src/network/core/WellKnownPorts.ts` (l. 33, 56) | Dictionnaire de noms de ports IANA | `{25: {tcp: 'smtp'}}`, `{587: {tcp: 'submission'}}` — noms statiques pour l'affichage, **aucune sémantique protocolaire** ; le port 465 (`smtps`, soumission implicite TLS) est **absent** de ce fichier |
| `src/network/core/ports/IanaServiceRegistry.ts` (l. 45, 69) | Registre IANA miroir | `{name: 'smtp', port: 25, aliases: ['mail'], comment: 'Simple Mail Transfer'}`, `{name: 'submission', port: 587, comment: 'Mail Message Submission'}` — même limite ; le port 465 y est **également absent**, alors qu'il l'est dans le registre `nmap` (ligne suivante) — incohérence mineure entre les deux registres |
| `src/network/devices/linux/commands/net/nmap/ServiceRegistry.ts` (l. 5, 10) | Registre de bannières `nmap` | `25: 'smtp'`, `465: 'smtps'` — noms pour l'affichage de `nmap -sV`, aucun moteur derrière |
| `src/network/devices/linux/commands/net/nmap/BannerAnalyzer.ts` (l. 14) | Détection heuristique de service par bannière | `/smtp\|mail\|esmtp/i.test(banner)` reconnaît un texte de bannière SMTP **si un service quelconque en émet un** — mais aucun service de ce dépôt n'émet jamais une bannière SMTP réelle aujourd'hui |
| `src/network/devices/shells/cisco/CiscoAclCommands.ts` (l. 58) | Alias de port nommés pour les ACL Cisco | `smtp: 25` — permet d'écrire `permit tcp any any eq smtp` dans une ACL, sans qu'aucun trafic SMTP réel ne puisse jamais transiter derrière |
| `src/network/devices/linux/LinuxFirewallManager.ts` (l. 36) | Alias de service pour `ufw`/`iptables` | `smtp: {port: '25', proto: 'tcp'}` — même limite, alias de configuration seul |
| `src/network/devices/linux/ports/PortActivityLogProjection.ts` (l. 402) | Nommage de port pour les journaux d'activité | `if (port === 25) return 'smtp';` — texte d'affichage seul |
| `src/network/devices/linux/nss/SystemFiles.ts` (l. 38) | Contenu simulé de `/etc/services` | `smtp            25/tcp          mail` — cohérent avec un vrai `/etc/services`, mais toujours sans moteur applicatif derrière |
| `src/network/devices/linux/LinuxLogManager.ts` (l. 21, 787-789) | Table des facilités syslog | La facilité `mail` (code 2) est **déjà entièrement câblée** — `logger -p mail.err` route bien vers `/var/log/mail.log`/`/var/log/mail.err` (vérifié par `journalization.test.ts` l. 191-193) — mais **rien dans ce dépôt n'écrit jamais réellement dans cette facilité** en dehors d'un appel manuel à `logger` : un vrai MTA (Postfix/Sendmail) est le seul programme qui l'utiliserait en pratique |
| `src/network/devices/linux/commands/system/Logrotate.ts` (l. 8) | Option `-m`/`--mail` de `logrotate` | Accepte une commande de mailing des logs en rotation — texte de flag seul, jamais invoqué avec un vrai transport |
| `src/network/devices/linux/LinuxCommandExecutor.ts` (l. 1925) | Construction du moteur `cron` (`ensureCronEngine`) | `deliverMail: () => { void 0; }` — **no-op strict** : un vrai `cron` mèle la sortie standard/erreur d'une tâche (quand elle n'est pas redirigée) à l'utilisateur du crontab ou à `MAILTO`, via `sendmail` local ; ce hook existe déjà dans l'interface de `CronEngine` mais n'est jamais implémenté |
| `src/network/devices/linux/LinuxCommandExecutor.ts` (l. 3294, 5557) | Variable d'environnement `MAIL` et message `userdel` | `MAIL: /var/mail/${user}` déjà exposée dans l'environnement de chaque session, `userdel` mentionne déjà `/var/mail/<user>` dans son message de suppression de spool — la **convention de chemin de boîte aux lettres existe déjà**, mais aucune remise ne l'alimente jamais |
| `src/network/devices/DeviceFactory.ts` / `src/network/core/types.ts` (`DeviceType`) | Fabrique et énumération des types de périphérique | **Aucun type de périphérique « serveur de messagerie »** — cohérent avec le reste du dépôt : les services applicatifs (RADIUS, IIS, DNS Server, FTP) sont des rôles/sessions greffés sur `LinuxServer`/`WindowsServer`/`Router`, pas des types de device dédiés |
| `src/network/devices/LinuxServer.ts` (239 lignes) | Serveur Linux générique | Héberge déjà `RadiusServerAgent`/`RadiusTcpServer` (l. 62, 217-218) sur son propre `TcpStack` — classe volontairement fine, **point d'attache naturel** pour un nouveau `SmtpServer` du même type |
| `src/network/dns/` (`compat/DnsWireCompat.ts`, `zone/ZoneFile.ts`, `wire/DnsMessageCodec.ts`) | Moteur DNS complet | Les enregistrements `MX` (préférence + serveur d'échange) et `TXT` (chaîne opaque) sont **déjà encodés/décodés/stockés/servis** de bout en bout — zone RFC (`ZoneFile.ts` `case 'MX':`), compat wire (`DnsWireCompat.ts` l. 20, 150, 169), codec bas niveau (`DnsMessageCodec.ts`) ; `RecursiveResolver.resolve(qname, qtype)` (l. 86) accepte n'importe quel `RRType`, y compris `MX` — **aucun travail supplémentaire requis côté DNS** pour que SMTP (routage MX) et SPF/DMARC (politiques `TXT`) le consomment tel quel |
| `src/network/pki/` (`PkiKeyPair.ts`, `X509Certificate.ts`) | PKI simulée | Génération de paire de clés RSA et signature déjà utilisées par TLS et par `ldapStartTls.ts` (`selfSignedLdapCert`) — **directement réutilisable** pour la signature DKIM (§ 2.1.17) |
| `src/network/devices/windows/server/ad/ldap/ldapStartTls.ts` | Upgrade TLS en place d'une connexion LDAP déjà ouverte | Précédent architectural **directement transposable** à `STARTTLS` SMTP : mêmes primitives (`TlsClientSession`/`TlsServerSession`, `encodeRecords`/`decodeRecords` de `TlsRecordWire.ts`, `PkiKeyPair`), même geste (upgrade in-place plutôt que renégociation de connexion) |
| `src/network/http/auth/BasicAuth.ts` | Authentification HTTP Basic | `encodeBasicCredentials`/`parseBasicCredentials` en base64 — précédent de **forme** pour `AUTH PLAIN`/`AUTH LOGIN` (même encodage base64, format de charge utile différent) ; pas de réutilisation directe de code, mais même discipline (fonctions pures testables indépendamment de toute session réseau) |
| `src/network/ftp/` (`FtpClientSession.ts`, `FtpServerSession.ts`, `replies.ts`, `events.ts`) | Moteur FTP livré (`PRD-FTP-SFTP.md`) | Précédent architectural le plus proche de SMTP : canal de contrôle texte unique, réponses à code numérique, `events.ts` **émis en ligne depuis la session** plutôt que via le pattern acteur/`EventBus` réactif de DHCP/OSPF/BGP — `ftp/events.ts` le documente explicitement (« FTP's control channel is synchronous request/response, just like HTTP — so, mirroring `network/http/events.ts` rather than DHCP/OSPF/BGP's actor-based reactive engines ») ; SMTP suit la **même discipline** (§ 3.4) |

### 1.2 Ce qui existe déjà et est réutilisable

- **`TcpStack`/`TcpSocket`** (`src/network/tcp/`) — porte le canal de
  contrôle SMTP (port 25 en réception MTA-à-MTA, port 587 en soumission
  cliente authentifiée, port 465 en soumission implicite TLS), exactement
  comme il porte déjà FTP/HTTP/TLS/SSH/LDAP. Le modèle
  synchrone requête/réponse déjà établi par `LdapClient`/`KerberosClient`
  (méthode `roundTrip`) et par `driveClientHandshake`/
  `stepServerHandshake` de `ldapStartTls.ts` est directement applicable au
  dialogue SMTP.
- **`TlsClientSession`/`TlsServerSession` + `TlsRecordWire.ts`**
  (`docs/PRD-TLS.md`, **livré**) — consommés tels quels pour `STARTTLS`,
  selon le patron exact déjà posé par `ldapStartTls.ts` : upgrade en
  place du même `TcpSocket`, sans fermeture/réouverture de connexion, sans
  nouvelle primitive cryptographique.
- **`PkiKeyPair`/`X509Certificate`** (`src/network/pki/`) — réutilisés
  tels quels pour générer la paire de clés RSA du sélecteur DKIM
  (§ 2.1.17) et calculer sa signature, exactement comme `ldapStartTls.ts`
  les réutilise pour un certificat auto-signé de service.
- **Moteur DNS complet** (`src/network/dns/`) — enregistrements `MX`
  (préférence + serveur d'échange) et `TXT` déjà supportés de bout en
  bout (encodage/décodage/zone/résolveur récursif) ; `SPF`/`DMARC`
  publient et consomment de simples enregistrements `TXT`, `MX` sert
  tel quel au routage sortant (§ 2.1.11).
- **`ChrootedSftpFileSystem`/`ISftpFileSystem`** (`src/network/protocols/
  ssh/sftp/`, cf. `PRD-FTP-SFTP.md` § 1.2) — pas réutilisés directement,
  mais confirment que ce dépôt a déjà un modèle établi de racine/chemin
  par utilisateur ; la boîte aux lettres `/var/mail/<user>` (§ 1.1) suit
  le même principe sans nouvelle abstraction.
- **`EventBus`/`Signal`** (`src/events/`) — disponible si un besoin
  réactif apparaissait, mais **délibérément non retenu** pour ce PRD
  (§ 3.4) : SMTP est un protocole synchrone requête/réponse comme FTP/
  HTTP, pas un protocole piloté par le temps comme OSPF/DHCP/BGP.
- **Convention de fidélité « crypto simulée, forme du protocole
  réelle »** déjà établie par `PkiKeyPair`, `SimulatedTls.ts`, le moteur
  TLS de `PRD-TLS.md` — directement applicable à `STARTTLS` et à DKIM.
- **`LinuxServer.ts`** — classe hôte déjà utilisée pour greffer un
  service applicatif complet (`RadiusServerAgent`/`RadiusTcpServer`) sur
  son propre `TcpStack`, sans modification de `LinuxMachine`.

### 1.3 Ce qui est non conforme ou manquant (gap analysis)

| # | Manque | RFC concernée | Sévérité |
|---|---|---|---|
| 1 | Aucune implémentation du canal de contrôle SMTP (connexion, commandes texte, réponses à codes numériques, machine à états de session) | RFC 5321 §2-4 | Bloquant |
| 2 | Aucune distinction enveloppe (`MAIL FROM`/`RCPT TO`) / message RFC 5322 (en-têtes `From`/`To`/`Subject`/`Date`/`Message-ID`) | RFC 5321 §2.3.1, RFC 5322 | Bloquant |
| 3 | Aucune négociation de capacités ESMTP (`EHLO`) | RFC 5321 §4.1.1.7 | Bloquant |
| 4 | Aucune extension `SIZE`/`8BITMIME`/`PIPELINING` | RFC 1870, RFC 6152, RFC 2920 | Moyenne |
| 5 | Aucun code de statut étendu (`2.1.0`/`5.1.1`...) — un succès/échec binaire générique serait infidèle | RFC 3463, RFC 5248 | Moyenne |
| 6 | Aucune sécurisation (`STARTTLS`) malgré un moteur TLS et un précédent d'upgrade en place (`ldapStartTls.ts`) déjà disponibles | RFC 3207 | Élevée |
| 7 | Aucune authentification (`AUTH PLAIN`/`LOGIN`/`CRAM-MD5`) | RFC 4954, RFC 4616, RFC 2195 | Élevée |
| 8 | Aucune politique anti-relais ouvert (« open relay ») | RFC 5321 (bonnes pratiques opérationnelles) | Élevée |
| 9 | Aucune remise locale réelle — la convention `/var/mail/<user>` existe (§ 1.1) mais n'est jamais peuplée | — | Bloquant |
| 10 | `cron`'s `deliverMail` est un no-op strict (§ 1.1) — la sortie d'une tâche cron n'atteint jamais réellement l'utilisateur | — | Moyenne |
| 11 | Aucun relais sortant par résolution MX réelle, malgré un moteur DNS `MX` déjà complet (§ 1.2) | RFC 5321 §5 | Élevée |
| 12 | Aucun client SMTP en ligne de commande (`mail`/`mailx`/`sendmail`) | — | Moyenne |
| 13 | Le port 465 (`smtps`) est absent d'`IanaServiceRegistry.ts`/`WellKnownPorts.ts` alors qu'il est déjà présent dans le registre `nmap` — incohérence entre les deux registres | — | Faible |
| 14 | Aucune vérification SPF, malgré un moteur DNS `TXT` déjà complet | RFC 7208 | Moyenne |
| 15 | Aucune signature/vérification DKIM, malgré une PKI déjà réutilisable | RFC 6376 | Moyenne |
| 16 | Aucune politique DMARC (alignement SPF/DKIM, action `reject`/`quarantine`) | RFC 7489 | Moyenne |

**Conclusion de la phase d'analyse** : SMTP est un chantier entièrement
greenfield — comparable à l'état de FTP avant `PRD-FTP-SFTP.md` — mais
avec une particularité favorable : contrairement à FTP (dont même le
canal de données n'avait aucun précédent), SMTP peut s'appuyer
**immédiatement** sur trois briques déjà livrées et stables (TLS avec un
patron d'upgrade en place déjà écrit pour LDAP, DNS avec les
enregistrements `MX`/`TXT` déjà complets, PKI déjà réutilisée deux fois)
et sur **deux points d'attente déjà présents dans le code** (`cron`'s
`deliverMail`, la convention `/var/mail/<user>`) qui deviennent, une fois
ce PRD livré, de vrais consommateurs plutôt que des trous silencieux.

---

## 2. Objectifs

### 2.1 Objectifs du protocole (ce PRD)

**1. RFC 5321 §2-4 — Canal de contrôle SMTP.** Connexion TCP (port 25 en
réception MTA-à-MTA, 587 en soumission cliente, cf. objectif 9),
bannière `220` d'ouverture, échange de commandes texte (verbe + argument
optionnel, terminées par CRLF) et de réponses à code numérique à 3
chiffres (classes 2xx/3xx/4xx/5xx) avec texte explicatif, y compris les
réponses multi-lignes (dernière ligne préfixée par `code espace`, lignes
intermédiaires par `code-`, même convention que `RFC 959 §4.2` déjà
utilisée par le moteur FTP livré). Machine à états de session
(connecté → salué (`EHLO`/`HELO`) → transaction en cours
(`MAIL`→`RCPT`×N→`DATA`) → réinitialisé) modélisée explicitement, à
l'image de `FtpControlSession`. Commandes minimales : `HELO`, `MAIL`,
`RCPT`, `DATA`, `RSET`, `NOOP`, `QUIT`, `VRFY`/`EXPN` (désactivables par
politique — un vrai serveur durci les désactive aussi, § 2.1.8), `HELP`.

**2. RFC 5321 §2.3.1 + RFC 5322 — Enveloppe distincte du message.**
`MAIL FROM:<adresse>` et `RCPT TO:<adresse>` (répétable) portent
l'**enveloppe de transport**, réellement distincte des en-têtes
`From`/`To`/`Cc`/`Subject`/`Date`/`Message-ID` du message RFC 5322 —
fidélité pédagogique importante (une enveloppe et des en-têtes qui
divergent, ex. `Bcc`, listes de diffusion, est un cas réel et non un
bug). `DATA` bascule la session en mode « corps de message » jusqu'à la
séquence de terminaison `<CRLF>.<CRLF>` ; le « dot-stuffing » (une ligne
du corps commençant réellement par un point est doublée à l'émission,
dédoublée à la réception, RFC 5321 §4.5.2) est appliqué fidèlement.

**3. Dictionnaire de réponses fidèle, avec codes étendus.** Table de
codes numériques à 3 chiffres complète avec leur texte conventionnel
(`220` bannière, `221` fermeture, `250` succès générique, `354`
« start mail input », `421` service indisponible, `450`/`550` boîte
indisponible/inconnue, `451`/`452` erreur locale/stockage insuffisant,
`503` mauvaise séquence de commandes, `550` refus de politique, `554`
échec de transaction), **chacun accompagné du code étendu** RFC 3463/5248
correspondant (`250 2.1.0 Sender ok`, `550 5.1.1 User unknown`,
`421 4.3.0 Service not available`) — pas un succès/échec binaire
générique, comme l'objectif 4 de `PRD-FTP-SFTP.md` l'exige déjà pour FTP.

**4. RFC 5321 §4.1.1.7 — Négociation de capacités ESMTP (`EHLO`).** La
réponse à `EHLO` énumère réellement les extensions supportées par
**cette** session (`SIZE <n>`, `8BITMIME`, `PIPELINING`,
`ENHANCEDSTATUSCODES`, `STARTTLS` seulement si TLS n'est pas déjà actif,
`AUTH PLAIN LOGIN CRAM-MD5` seulement si TLS est actif ou explicitement
autorisé en clair) — capacité pilotée par l'état réel du serveur, pas une
liste statique.

**5. RFC 1870 — Extension `SIZE`.** Le serveur annonce sa taille de
message maximale dans `EHLO` ; `MAIL FROM:<...> SIZE=<n>` déclare la
taille attendue, rejetée immédiatement (`552 5.3.4`) si elle dépasse la
limite annoncée, sans attendre la fin de `DATA`.

**6. RFC 6152 — Extension `8BITMIME`.** `MAIL FROM:<...> BODY=8BITMIME`
ou `BODY=7BIT` déclare la transparence attendue du corps ; un corps
contenant réellement des octets non-ASCII est rejeté si `7BIT` a été
déclaré (ou si l'extension n'a pas été négociée) — véritable
vérification de contenu, pas un simple écho du paramètre.

**7. RFC 2920 — `PIPELINING`.** Le serveur accepte plusieurs commandes
envoyées en une seule écriture TCP sans attendre chaque réponse
individuellement (`MAIL`+`RCPT`+`DATA` regroupés), et répond dans le bon
ordre une fois le tampon de commandes complet — exige un analyseur non
bloquant ligne par ligne plutôt qu'un aller-retour bloquant par commande,
condition testable explicitement (une session qui n'annonce pas
`PIPELINING` dans `EHLO` doit rejeter ce groupement).

**8. RFC 3207 — `STARTTLS`, upgrade en place du canal de contrôle.**
`STARTTLS` bascule la connexion en clair sur un vrai handshake
`TlsClientSession`/`TlsServerSession` (RFC 8446, moteur déjà construit),
**exactement selon le patron déjà écrit par `ldapStartTls.ts`**
(`driveClientHandshake`/`stepServerHandshake`, `encodeRecords`/
`decodeRecords` de `TlsRecordWire.ts`) — aucune nouvelle primitive
cryptographique. Conformément à la RFC (et à la classe de vulnérabilités
« commande STARTTLS en clair mise en tampon puis rejouée après
l'upgrade », historiquement corrigée dans Postfix/Exim/Sendmail), **tout
tampon de commande en attente au moment de l'upgrade est purgé** et les
capacités `EHLO` doivent être renégociées après le handshake — un test
dédié vérifie explicitement qu'une commande injectée avant l'upgrade
n'est jamais exécutée après (§ 7).

**9. RFC 4954 + RFC 4616 + RFC 2195 — `AUTH`.** `AUTH PLAIN` (charge
utile base64 `authzid\0authcid\0passwd`, RFC 4616), `AUTH LOGIN`
(dialogue historique en deux invites base64 `Username:`/`Password:`,
toujours omniprésent en pratique bien que jamais formellement normalisé
en RFC dédiée), `AUTH CRAM-MD5` (défi/réponse HMAC-MD5, RFC 2195 — aucun
mot de passe en clair sur le fil, dans le même esprit que les mécanismes
défi/réponse déjà réels ailleurs dans ce dépôt, ex. CHAP PPP). `AUTH`
n'est annoncé dans `EHLO` que si le canal est protégé par TLS (ou
explicitement autorisé en clair par configuration, comportement
non-défaut) — cohérent avec objectif 4. Une session authentifiée porte
une identité qui gate le relais (objectif 10).

**10. Politique anti-relais ouvert.** Un ensemble configurable de
domaines locaux détermine si `RCPT TO` est acceptable : un domaine local
est **toujours** acceptable (remise locale, objectif 11) ; un domaine
distant n'est acceptable que pour une session **authentifiée**
(objectif 9) ou provenant d'un réseau explicitement autorisé — sinon
`550 5.7.1 Relaying denied`. Ce comportement est **fidèle par
construction** à un vrai MTA correctement configuré (le relais ouvert
historique, qui a permis l'essor du spam dans les années 1990-2000, est
délibérément *l'absence* de cette politique — ce PRD implémente la
politique par défaut, pas la faille).

**11. Remise locale réelle (Local Delivery Agent).** Un message accepté
pour un `RCPT TO` dont le domaine est local est réellement écrit dans
`/var/mail/<destinataire>` (convention déjà référencée, § 1.1), au format
mbox (ligne `From <expéditeur-enveloppe> <horodatage>`, en-têtes RFC 5322,
ligne vide, corps, séparateur) — ce qui rend la convention `/var/mail/`
déjà existante enfin réelle, et permet à `mail`/`mailx` (objectif 13) de
lire un contenu authentique.

**12. Branchement du hook `deliverMail` de `cron`.** Le no-op de
`LinuxCommandExecutor.ts` (l. 1925, § 1.1) devient un appel réel à ce
moteur (soumission locale directe, sans passer par TCP/25 — comme le
fait un vrai `sendmail` invoqué en ligne de commande) : la sortie d'une
tâche cron non redirigée atteint réellement `/var/mail/<user>` (ou
`MAILTO` si défini dans le crontab).

**13. RFC 5321 §5 — Relais sortant par résolution MX réelle.** Une
remise vers un domaine distant effectue une **vraie** requête `MX`
(`RecursiveResolver.resolve(qname, RRType.MX)`, déjà livré § 1.2), trie
les serveurs d'échange par préférence croissante, se connecte au premier
joignable (retente le suivant en cas d'échec de connexion), et retombe
sur l'enregistrement `A`/`AAAA` du domaine lui-même en l'absence de tout
`MX` (règle implicite de la RFC) — un vrai second aller-retour SMTP
client, pas une simulation de remise instantanée.

**14. Client SMTP en ligne de commande (`mail`/`mailx`/`sendmail`).**
Nouveau gestionnaire de commande dans le shell Linux, consommant ce
moteur : mode interactif (invites `To:`/`Subject:`, corps terminé par un
point seul sur sa ligne, comme le `mail` BSD historique) et mode
non-interactif (`echo corps | mail -s "sujet" user@domaine`), à l'image
de la manière dont `ftp`/`curl` consomment leurs moteurs respectifs
(`PRD-FTP-SFTP.md` objectif 11, `PRD-HTTP.md`). Lit également la boîte
locale (`/var/mail/<user>`, objectif 11) pour afficher `You have new
mail` de façon authentique (déjà partiellement amorcé par la variable
`MAIL` existante, § 1.1).

**15. Observabilité SMTP.** Événements émis **en ligne depuis la
session** (`smtp.session.opened/closed`, `smtp.command.received`,
`smtp.mail.accepted/rejected`, `smtp.delivery.local/relayed/deferred/
bounced`, `smtp.auth.succeeded/failed`, `smtp.starttls.established`),
selon exactement la même discipline que `network/ftp/events.ts` /
`network/http/events.ts` (§ 1.1, § 3.4) — **pas** le pattern acteur/
`EventBus` réactif utilisé par DHCP/OSPF/BGP, puisque SMTP est, comme
FTP/HTTP, un protocole synchrone requête/réponse et non piloté par le
temps.

**16. Correction du registre de ports (§ 1.1, gap 13).** Le port 465
(`smtps`, soumission implicite TLS — TLS dès l'ouverture de connexion,
sans `STARTTLS`, variante de configuration du même moteur objectif 8)
est ajouté à `IanaServiceRegistry.ts` et `WellKnownPorts.ts`, résolvant
l'incohérence avec le registre `nmap` déjà correct.

**17. RFC 7208 — SPF (Sender Policy Framework).** Le domaine de
l'expéditeur enveloppe publie un enregistrement `TXT`
(`v=spf1 ip4:... mx include:... -all`, § 1.2 pour le moteur DNS `TXT`
déjà livré) ; le serveur SMTP receveur évalue cette politique à `RCPT
TO`/`DATA` contre l'adresse IP source réelle de la connexion —
mécanismes `ip4`/`ip6`/`a`/`mx`/`include`/`all` avec qualificatifs
(`+`/`-`/`~`/`?`), résultats `pass`/`fail`/`softfail`/`neutral`/`none`/
`temperror`/`permerror` conformes à la RFC, en-tête `Received-SPF`
apposé sur le message accepté.

**18. RFC 6376 — DKIM (DomainKeys Identified Mail).** Le serveur
émetteur signe (`PkiKeyPair`, § 1.2, exactement réutilisé comme pour TLS/
LDAP) les en-têtes déclarés et le corps du message avec une clé privée
RSA, publie la clé publique correspondante via un enregistrement `TXT`
au nom `<sélecteur>._domainkey.<domaine>` (moteur DNS `TXT` déjà livré),
et appose un en-tête `DKIM-Signature` réel (canonicalisation `relaxed`/
`simple`, RSA-SHA256). Le serveur receveur récupère la clé publiée et
vérifie réellement la signature — pas un booléen simulé.

**19. RFC 7489 — DMARC.** Le domaine publie un enregistrement `TXT`
`_dmarc.<domaine>` (`v=DMARC1; p=reject|quarantine|none; ...`) évalué à
la réception contre l'**alignement** SPF/DKIM (identifiant de domaine
aligné en mode strict ou relaxed, RFC 7489 §3.1) — consomme les
objectifs 17/18 sans réévaluer leur logique propre, appose un en-tête
`Authentication-Results`, et honore réellement l'action de politique
(`reject` refuse la remise avec `550 5.7.1`, `quarantine` remet mais
marque le message, `none` remet et journalise seulement).

### 2.2 Non-objectifs (explicitement hors périmètre)

- **Vrai chiffrement/vraie négociation cryptographique bit-exacte** —
  convention transversale déjà actée par l'ensemble de ce dépôt
  (`PkiKeyPair`, `SimulatedTls.ts`, le moteur de `PRD-TLS.md`) ; s'applique
  ici à `STARTTLS` et à la signature DKIM, sans redéfinir cette limite.
- **RFC 6531 (SMTPUTF8)** — adresses internationalisées (UTF-8 dans la
  partie locale de l'adresse) : cas d'usage marginal pour ce simulateur,
  faible valeur pédagogique par rapport à sa complexité d'encodage
  (`Mailbox` UTF-8, comparaison de domaines internationalisés).
- **IMAP/POP3** (protocoles de relève de boîte aux lettres) —
  entièrement hors périmètre de ce document ; SMTP ne couvre que
  l'émission/le transport/la remise, pas la consultation. Un PRD frère
  distinct serait nécessaire si ce besoin apparaît, à l'image de la façon
  dont `PRD-FTP-SFTP.md` traite SFTP comme un chantier séparé de FTP.
  **C'est l'exclusion la plus proche d'être un objectif** — elle ne l'est
  pas parce qu'aucune demande explicite ne la couvre, contrairement à
  toutes les extensions SMTP elles-mêmes qui ont été promues ci-dessus.
- **Filtrage anti-spam par contenu** (scoring bayésien, listes de
  signatures façon SpamAssassin, apprentissage) — SPF/DKIM/DMARC
  (objectifs 17-19) sont une authentification de **provenance**
  protocolaire, pas une analyse heuristique de **contenu** ; les deux
  sujets sont volontairement distincts.
- **Interrogation de listes de blocage temps réel (DNSBL/RBL)** — une
  vraie requête DNS vers un service tiers réel (ex. Spamhaus) sortirait
  du modèle self-contained de ce simulateur ; hors périmètre.
- **Parsing MIME multipart complet** (pièces jointes, arborescence
  `multipart/*`, décodage `base64`/`quoted-printable` du corps) — le
  corps du message est traité comme une séquence d'octets opaque pour les
  besoins de remise/canonicalisation DKIM (objectif 18) ; seuls les
  en-têtes RFC 5322 de premier niveau (`From`/`To`/`Subject`/`Date`/
  `Message-ID`/`Content-Type` en tant que simple valeur de chaîne) sont
  structurés.
- **Logiciel de liste de diffusion** (type Majordomo/Mailman, gestion
  d'abonnés, digest) — hors périmètre, sans lien direct avec la fidélité
  protocolaire SMTP elle-même.

---

## 3. Architecture cible

### 3.1 Principe directeur

**Additif d'abord, migration ensuite en un point de bascule net** — même
discipline que `PRD-TLS.md`/`PRD-FTP-SFTP.md`. Le chantier 1 (SMTP/
ESMTP/STARTTLS/AUTH) est construit **greenfield**, en couches strictement
empilées (canal de contrôle → enveloppe/extensions → sécurité/
authentification → remise locale/relais), sans toucher à aucun fichier
existant avant la phase de branchement dédiée (§ 5, P12-P13). Le
chantier 2 (SPF/DKIM/DMARC) s'ajoute **par-dessus** le chantier 1 stabilisé,
en pur point d'évaluation/signature, sans réécrire le moteur SMTP ni le
moteur DNS existant.

Discipline explicite héritée de FTP/HTTP (§ 1.1, § 1.2) : SMTP est un
protocole **synchrone requête/réponse**, pas un protocole piloté par le
temps — ses événements sont émis **en ligne** depuis
`SmtpServerSession`/`SmtpClientSession`, sans acteur ni `EventBus`
réactif (contrairement à OSPF/DHCP/BGP).

### 3.2 Diagramme de couches

```
┌────────────────────────────────────────────────────────────────────┐
│ Consommateurs (branchés en P12-P13, § 2.1.12/16) :                  │
│   LinuxCommandExecutor.ts (deliverMail de cron → réel) ·             │
│   IanaServiceRegistry.ts/WellKnownPorts.ts (port 465 ajouté) ·       │
│   shell Linux (mail/mailx/sendmail, objectif 14)                    │
├────────────────────────────────────────────────────────────────────┤
│  SPF (7208)      │  DKIM (6376)        │  DMARC (7489)              │
│  smtp/spf.ts      │  smtp/dkim.ts        │  smtp/dmarc.ts             │
│  (NOUVEAU)         │  (NOUVEAU, PkiKeyPair)│  (NOUVEAU, consomme SPF/  │
│                    │                      │   DKIM, pas de logique   │
│                    │                      │   propre d'évaluation)   │
├────────────────────────────────────────────────────────────────────┤
│  AUTH (4954/4616/2195) — smtp/auth.ts (NOUVEAU)                      │
├────────────────────────────────────────────────────────────────────┤
│  STARTTLS (3207) — smtp/starttls.ts (NOUVEAU) — même patron que      │
│  ldapStartTls.ts : TlsClientSession/TlsServerSession + TlsRecordWire │
├────────────────────────────────────────────────────────────────────┤
│  Extensions ESMTP (1870/6152/2920) — smtp/extensions.ts (NOUVEAU)    │
├────────────────────────────────────────────────────────────────────┤
│  Canal de contrôle SMTP (5321/5322) — smtp/SmtpClientSession.ts,     │
│  smtp/SmtpServerSession.ts, smtp/replies.ts, smtp/envelope.ts        │
│  (NOUVEAU, patron FtpClientSession.ts/FtpServerSession.ts)           │
├────────────────────────────────────────────────────────────────────┤
│  Remise locale (LDA) — smtp/localDelivery.ts (NOUVEAU) ·             │
│  Relais sortant MX — smtp/relay.ts (NOUVEAU, RecursiveResolver)      │
├────────────────────────────────────────────────────────────────────┤
│  TcpStack/TcpSocket (canaux 25/465/587) · moteur DNS existant        │
│  (MX/TXT, inchangé) · PKI existante (PkiKeyPair, inchangée) ·        │
│  moteur TLS existant (TlsClientSession/TlsServerSession, inchangé)   │
└────────────────────────────────────────────────────────────────────┘
```

### 3.3 Modules proposés (arborescence)

```
src/network/smtp/                      # NOUVEAU — protocole SMTP entier
├── types.ts                           # SmtpCommand, SmtpReply, Envelope, EsmtpCapabilities
├── SmtpClientSession.ts               # dialogue côté client (EHLO→MAIL→RCPT→DATA→QUIT)
├── SmtpServerSession.ts               # machine à états côté serveur, une par connexion
├── SmtpServer.ts                      # écoute TCP/25,465,587 ; instancie une session par connexion
├── replies.ts                         # dictionnaire codes 2xx-5xx + codes étendus 3463/5248
├── envelope.ts                        # MAIL FROM/RCPT TO, dot-stuffing (§4.5.2), parsing RFC 5322 minimal
├── extensions.ts                      # SIZE/8BITMIME/PIPELINING (1870/6152/2920)
├── starttls.ts                        # upgrade en place — patron ldapStartTls.ts
├── auth.ts                            # AUTH PLAIN/LOGIN/CRAM-MD5 (4954/4616/2195)
├── relayPolicy.ts                     # anti-relais ouvert (§2.1.10) : domaines locaux, gate d'authentification
├── localDelivery.ts                   # LDA — écriture mbox réelle dans /var/mail/<user>
├── relay.ts                           # relais sortant — résolution MX réelle, retombée A/AAAA
├── spf.ts                             # NOUVEAU (chantier 2) — évaluation de politique SPF (TXT)
├── dkim.ts                            # NOUVEAU (chantier 2) — signature/vérification DKIM (PkiKeyPair)
├── dmarc.ts                           # NOUVEAU (chantier 2) — alignement SPF/DKIM, action de politique
├── events.ts                          # smtp.session.*, smtp.mail.*, smtp.delivery.*, smtp.auth.*
└── observables.ts                     # flux dérivés (tests/UI)

src/network/devices/LinuxServer.ts     # étendu : héberge un SmtpServer sur son propre TcpStack,
                                        # exactement comme il héberge déjà RadiusServerAgent/RadiusTcpServer

src/network/devices/linux/commands/net/mail/  # NOUVEAU — client mail/mailx/sendmail
└── MailCommand.ts

src/network/core/ports/IanaServiceRegistry.ts # étendu : entrée smtps:465 ajoutée (§2.1.16)
src/network/core/WellKnownPorts.ts            # étendu : entrée 465 ajoutée (§2.1.16)

src/network/devices/linux/LinuxCommandExecutor.ts  # ensureCronEngine() : deliverMail branché
                                                     # sur smtp/localDelivery.ts (§2.1.12)
```

Note de frontière : ce PRD ne touche pas le moteur DNS
(`src/network/dns/`) ni la PKI (`src/network/pki/`) ni le moteur TLS
(`src/network/tls/`) — ces trois briques restent des dépendances
consommées telles quelles (§ 1.2), jamais réécrites.

### 3.4 Design patterns retenus

- **Machine à états explicite** (`SmtpServerSession`, côté serveur ;
  `SmtpClientSession`, côté client), à l'image de
  `FtpServerSession`/`FtpClientSession` et de
  `TlsClientSession`/`TlsServerSession`.
- **Émission d'événements en ligne, pas d'acteur réactif** — réplique
  volontairement la discipline déjà documentée par `network/ftp/
  events.ts` (§ 1.1) : SMTP est synchrone requête/réponse, pas
  piloté par le temps.
- **Adapter** (`starttls.ts`) : adapte le `TcpSocket` en clair vers un
  handshake `TlsClientSession`/`TlsServerSession`, selon le patron déjà
  posé par `ldapStartTls.ts` — aucune duplication de logique TLS.
- **Strategy** pour les mécanismes `AUTH` (`PLAIN`/`LOGIN`/`CRAM-MD5`,
  `auth.ts`), à l'image des stratégies d'authentification (`ISshAuthMethod`)
  déjà en place côté SSH.
- **Réutilisation stricte de la PKI/DNS existants** (`@/network/pki`,
  `@/network/dns`) — aucune nouvelle primitive cryptographique ni second
  parseur DNS, comme `PRD-FTP-SFTP.md` l'a fait pour FTPS.
- **Point d'insertion, pas de réécriture** (`spf.ts`/`dkim.ts`/
  `dmarc.ts` branchés sur `SmtpServerSession` à `RCPT`/`DATA`) — même
  principe que `FtpAlg.ts` s'ajoutant à `NATEngine.ts` sans le réécrire
  (`PRD-FTP-SFTP.md` § 3.4).

---

## 4. Modèle de données

### 4.1 Commande et réponse SMTP (RFC 5321 §4)

```ts
interface SmtpCommand {
  readonly verb: string;              // 'EHLO', 'MAIL', 'RCPT', 'DATA', ...
  readonly argument?: string;
}

interface SmtpReply {
  readonly code: number;              // 220, 250, 354, 421, 450, 550, ...
  readonly enhancedCode?: string;     // '2.1.0', '5.1.1', ... (RFC 3463/5248)
  readonly lines: readonly string[];  // >1 ligne => format multi-ligne, code- / code espace
}
```

### 4.2 Enveloppe et message (RFC 5321 §2.3.1, RFC 5322)

```ts
interface MailEnvelope {
  readonly from: string;                       // adresse MAIL FROM, '' pour un bounce
  readonly to: readonly string[];               // adresses RCPT TO accumulées
  readonly size?: number;                       // SIZE= déclaré (RFC 1870)
  readonly bodyType?: '7BIT' | '8BITMIME';       // BODY= déclaré (RFC 6152)
}

interface MimeMessage {
  readonly headers: ReadonlyMap<string, string>; // From/To/Subject/Date/Message-ID, valeurs opaques
  readonly body: Uint8Array;                     // corps brut, non décodé (§2.2)
}
```

### 4.3 Capacités ESMTP (RFC 5321 §4.1.1.7)

```ts
interface EsmtpCapabilities {
  readonly size?: number;
  readonly eightBitMime: boolean;
  readonly pipelining: boolean;
  readonly enhancedStatusCodes: boolean;
  readonly startTls: boolean;          // annoncé seulement si TLS pas déjà actif
  readonly authMechanisms: readonly ('PLAIN' | 'LOGIN' | 'CRAM-MD5')[]; // annoncé seulement si TLS actif ou clair autorisé
}
```

### 4.4 État d'authentification (RFC 4954/4616/2195)

```ts
type AuthMechanism = 'PLAIN' | 'LOGIN' | 'CRAM-MD5';

interface AuthState {
  readonly authenticated: boolean;
  readonly mechanism?: AuthMechanism;
  readonly identity?: string;          // authcid vérifié
}
```

### 4.5 Résolution MX et relais (RFC 5321 §5)

```ts
interface MxTarget {
  readonly preference: number;         // plus petit = prioritaire
  readonly exchange: string;           // nom d'hôte du serveur d'échange
}

interface RelayAttempt {
  readonly target: MxTarget | { readonly fallbackToAddress: true };
  readonly outcome: 'delivered' | 'deferred' | 'bounced';
}
```

### 4.6 SPF (RFC 7208)

```ts
type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';

interface SpfEvaluation {
  readonly result: SpfResult;
  readonly domain: string;
  readonly clientIp: string;
  readonly mechanism?: string;         // le mécanisme qui a décidé (ex. 'ip4:203.0.113.0/24')
}
```

### 4.7 DKIM (RFC 6376)

```ts
interface DkimSignature {
  readonly domain: string;
  readonly selector: string;
  readonly signedHeaders: readonly string[];
  readonly canonicalization: { readonly header: 'relaxed' | 'simple'; readonly body: 'relaxed' | 'simple' };
  readonly bodyHash: string;           // base64
  readonly signature: string;          // base64, RSA-SHA256
}

type DkimVerifyResult = 'pass' | 'fail' | 'none' | 'temperror' | 'permerror';
```

### 4.8 DMARC (RFC 7489)

```ts
type DmarcPolicy = 'none' | 'quarantine' | 'reject';

interface DmarcEvaluation {
  readonly policy: DmarcPolicy;
  readonly spfAligned: boolean;
  readonly dkimAligned: boolean;
  readonly disposition: 'deliver' | 'quarantine' | 'reject';
}
```

### 4.9 Boîte aux lettres locale (§ 2.1.11)

```ts
interface MboxEntry {
  readonly envelopeFrom: string;
  readonly receivedAt: number;         // epoch ms
  readonly message: MimeMessage;
}
```

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — Canal de contrôle SMTP nominal (5321 §2-4)** | `types.ts`/`SmtpServerSession.ts`/`SmtpClientSession.ts`/`replies.ts` : connexion, bannière `220`, `HELO`, `MAIL`/`RCPT`/`DATA` minimal, `QUIT`/`NOOP`/`RSET`, réponses à code + multi-lignes | — |
| **P2 — Enveloppe et dot-stuffing (5321 §2.3.1/§4.5.2)** | `envelope.ts` : parsing `MAIL FROM`/`RCPT TO`, dot-stuffing round-trip, distinction enveloppe/en-têtes RFC 5322 | P1 |
| **P3 — Codes étendus (3463/5248)** | Extension de `replies.ts` : table complète code↔code-étendu, chaque commande de P1-P2 mappée | P1, P2 |
| **P4 — `EHLO`/capacités ESMTP (5321 §4.1.1.7)** | `SmtpServerSession.ts` répond dynamiquement selon l'état réel (TLS actif ou non, etc.) | P1 |
| **P5 — Extensions `SIZE`/`8BITMIME`/`PIPELINING`** | `extensions.ts` : rejet `552` sur dépassement de taille, vérification 8-bit réelle, tampon de commandes groupées | P4 |
| **P6 — `STARTTLS` (3207)** | `starttls.ts` : upgrade en place selon le patron `ldapStartTls.ts`, purge du tampon de commandes pré-upgrade, re-négociation `EHLO` obligatoire | P4, **moteur TLS de `PRD-TLS.md` (livré)** |
| **P7 — `AUTH` (4954/4616/2195)** | `auth.ts` : `PLAIN`/`LOGIN`/`CRAM-MD5`, annoncé seulement si TLS actif (P6) ou clair explicitement autorisé | P6 |
| **P8 — Anti-relais ouvert** | `relayPolicy.ts` : domaines locaux vs distants, gate d'authentification (P7) | P2, P7 |
| **P9 — Remise locale réelle (LDA)** | `localDelivery.ts` : écriture mbox dans `/var/mail/<user>` (convention déjà existante, § 1.1) | P2, P8 |
| **P10 — Relais sortant par MX réel (5321 §5)** | `relay.ts` : `RecursiveResolver.resolve(qname, RRType.MX)` (déjà livré), tri par préférence, retombée `A`/`AAAA` | P8, moteur DNS existant |
| **P11 — Observabilité SMTP** | `events.ts`/`observables.ts`, émission en ligne (§ 3.4) | P1–P10 |
| **P12 — Branchement `SmtpServer` sur `LinuxServer`** | `LinuxServer.ts` étendu, `SmtpServer.ts` écoute 25/465/587 sur son `TcpStack`, port 465 en TLS implicite (variante de P6) | P1–P11 |
| **P13 — Branchement des consommateurs existants** | `deliverMail` de `cron` → réel (§2.1.12) ; port 465 ajouté à `IanaServiceRegistry.ts`/`WellKnownPorts.ts` (§2.1.16) | P9, P12 |
| **P14 — Client `mail`/`mailx`/`sendmail`** | `MailCommand.ts` : mode interactif + non-interactif, lecture de boîte locale | P9, P12 |
| **P15 — SPF (7208)** | `spf.ts` : parsing de politique `TXT`, mécanismes `ip4`/`ip6`/`a`/`mx`/`include`/`all`, `Received-SPF` | P12, moteur DNS existant (`TXT`) |
| **P16 — DKIM (6376)** | `dkim.ts` : génération de sélecteur (`PkiKeyPair`), signature à l'émission, vérification à la réception, `DKIM-Signature` | P12, PKI existante |
| **P17 — DMARC (7489)** | `dmarc.ts` : alignement, `Authentication-Results`, action de politique réelle | P15, P16 |

Chaque phase suit le cycle rouge → vert → refactor. Le module reste
strictement additif jusqu'à P13 (aucune suite existante ne change) ;
P13 change délibérément ce principe pour les seuls fichiers listés
(`LinuxCommandExecutor.ts`'s `deliverMail`, les deux registres de ports),
en conservant leur comportement observable préexistant partout ailleurs.

---

## 6. Stratégie de test

1. **Unitaires canal de contrôle** : parsing/formatage commande ↔
   réponse, machine à états (transitions valides/invalides, ex. `RCPT`
   avant `MAIL` → `503`), réponses multi-lignes round-trip.
2. **Unitaires enveloppe/dot-stuffing** : un corps contenant une ligne
   commençant par un point round-trip fidèlement ; enveloppe et en-têtes
   RFC 5322 restent bien distincts (un `RCPT TO` peut différer de tous
   les en-têtes `To`/`Cc`).
3. **Unitaires codes étendus** : chaque réponse porte le bon couple
   code/code-étendu.
4. **Unitaires ESMTP** : `EHLO` avant/après `STARTTLS` annonce des
   capacités différentes ; `AUTH` absent tant que TLS n'est pas actif.
5. **Unitaires extensions** : `SIZE` rejette un message trop grand avant
   `DATA` ; `8BITMIME` rejette un corps 8 bits si `7BIT` déclaré ;
   `PIPELINING` traite un groupe `MAIL`+`RCPT`+`DATA` envoyé sans
   attendre chaque réponse.
6. **Unitaires/intégration `STARTTLS`** : handshake réel (contre le
   moteur de `PRD-TLS.md`) ; **une commande envoyée juste avant
   l'upgrade n'est jamais exécutée après** (test dédié à la classe de
   vulnérabilité historique, § 2.1.8) ; `EHLO` post-upgrade obligatoire.
7. **Unitaires/intégration `AUTH`** : `PLAIN`/`LOGIN`/`CRAM-MD5` round-trip
   avec un identifiant valide, échec propre sur mot de passe incorrect,
   `AUTH` refusé en clair par défaut.
8. **Unitaires anti-relais** : un domaine local est toujours acceptable ;
   un domaine distant est refusé (`550 5.7.1`) sans authentification, puis
   accepté avec.
9. **Unitaires remise locale** : un message accepté pour un destinataire
   local est réellement lisible dans `/var/mail/<user>` au format mbox
   correct.
10. **Unitaires/intégration relais sortant** : une remise vers un domaine
    distant interroge réellement `MX`, essaie les serveurs par
    préférence croissante, retombe sur `A`/`AAAA` en l'absence de `MX`.
11. **Intégration `cron`** : une tâche cron sans redirection dont la
    sortie est non vide produit réellement un message dans
    `/var/mail/<user>` (ou vers `MAILTO`).
12. **Unitaires client `mail`** : mode interactif et non-interactif
    produisent la même enveloppe/le même message ; lecture de boîte
    locale cohérente avec le contenu réel.
13. **Unitaires SPF** : chaque mécanisme (`ip4`/`ip6`/`a`/`mx`/`include`/
    `all`) et chaque qualificatif produisent le bon `SpfResult` ; `TXT`
    absent → `none` ; syntaxe invalide → `permerror`.
14. **Unitaires DKIM** : signature à l'émission puis vérification à la
    réception réussissent pour un message non modifié ; une altération du
    corps ou d'un en-tête signé fait échouer la vérification (`fail`).
15. **Unitaires DMARC** : alignement strict vs relaxed correctement
    évalué ; `p=reject` refuse réellement la remise, `p=quarantine`
    remet en marquant, `p=none` remet sans action.
16. **Non-régression (P1–P12)** : suites existantes (`nmap-integration`,
    `journalization`, tests de `cron`, registres de ports) inchangées
    tant que P13 n'est pas atteinte.
17. **Migration (P13)** : `LinuxCommandExecutor.ts`'s tests de `cron`
    vérifient le nouveau comportement observable (mail réellement
    délivré) ; les tests de registre de ports incluent désormais
    l'entrée 465.

---

## 7. Risques et points d'attention

1. **SMTP est un chantier entièrement greenfield** comme FTP l'était
   avant son propre PRD : le risque n'est pas la régression mais la
   sous-estimation de la surface RFC 5321 (interactions `EHLO`/`MAIL`/
   `RCPT`/`DATA`, cas d'erreur, machine à états).
2. **Distinguer clairement enveloppe et message** (§ 2.1.2) — un piège
   classique d'implémentation naïve est de traiter `RCPT TO` comme
   équivalent à l'en-tête `To`, ce qui casse silencieusement les cas
   réels (Bcc, listes de diffusion, relais) ; les tests (§ 6.2) doivent
   vérifier explicitement leur indépendance.
3. **STARTTLS et le tampon pré-upgrade** (§ 2.1.8) : ne pas exécuter une
   commande reçue avant la fin du handshake est une exigence de
   **sécurité**, pas un détail cosmétique — historiquement une classe de
   vulnérabilité réelle sur plusieurs MTA majeurs ; le test dédié (§ 6.6)
   ne doit jamais être affaibli ou retiré.
4. **`AUTH` en clair par défaut désactivé** (§ 2.1.9) : un développeur
   pressé pourrait annoncer `AUTH` avant `STARTTLS` par commodité de
   test — contredit RFC 4954's bonne pratique et la politique anti-relais
   (§ 2.1.10) ; les tests (§ 6.4, § 6.7) vérifient explicitement l'ordre.
5. **Anti-relais ouvert : ne pas re-livrer la faille historique** — le
   comportement par défaut doit être restrictif (§ 2.1.10) ; tout mode
   permissif doit être une configuration explicite, jamais le défaut,
   sous peine de reproduire fidèlement le bug qui a permis l'essor du
   spam plutôt que le protocole correctement opéré.
6. **Le relais sortant dépend d'un moteur DNS déjà stable** — ne pas
   dupliquer de logique de résolution dans `relay.ts` ; tout ajout de
   fonctionnalité DNS nécessaire doit passer par une extension du moteur
   DNS existant, pas par un second résolveur ad hoc.
7. **DKIM : la canonicalisation doit être fidèle** — une implémentation
   qui « fonctionne » sur un message simple mais s'écarte des règles
   `relaxed`/`simple` exactes de la RFC 6376 §3.4 produirait des
   signatures qui échoueraient face à un vérificateur réel ; tester avec
   des en-têtes contenant des espaces/casse variables, pas seulement le
   cas nominal.
8. **DMARC ne réévalue pas SPF/DKIM** — `dmarc.ts` doit rester un point
   de **composition** (alignement + action) au-dessus de `spf.ts`/
   `dkim.ts`, jamais une réimplémentation parallèle de leur évaluation
   (même principe que `FtpAlg.ts` ne dupliquant pas `NATEngine.ts`,
   `PRD-FTP-SFTP.md` § 3.4).
9. **Pas de dépendance bloquante externe**, mais un séquencement interne
   strict existe (§ 5) : SPF/DKIM/DMARC (P15-P17) ne peuvent pas
   commencer avant que le moteur SMTP principal (P1-P12) ne soit
   stabilisé — ne pas paralléliser au-delà de ce que le tableau § 5
   permet.
10. **Le parsing MIME reste volontairement superficiel** (§ 2.2) — ne
    pas laisser un besoin ultérieur (pièces jointes, `multipart/*`)
    dériver silencieusement dans ce PRD sans mise à jour explicite du
    document ; c'est un non-objectif assumé, pas un oubli.

---

## 8. Critères d'acceptation

1. Une session SMTP complète (`EHLO` → `MAIL FROM` → `RCPT TO` → `DATA`
   → `.` → `250`) délivre un message dont l'enveloppe et les en-têtes
   RFC 5322 sont vérifiables séparément.
2. Le dot-stuffing round-trip bit-exact sur un corps contenant des
   lignes commençant par un point.
3. `EHLO` répond avec des capacités différentes selon que `STARTTLS` a
   déjà été exécuté ou non, et selon que `AUTH` est autorisé ou non.
4. `SIZE`/`8BITMIME`/`PIPELINING` sont chacun honorés par un test dédié
   qui échouerait si l'extension n'était qu'annoncée sans être appliquée.
5. `STARTTLS` aboutit à un vrai handshake TLS 1.3 ; une commande injectée
   juste avant l'upgrade est prouvée sans effet après (§ 7.3).
6. `AUTH PLAIN`/`LOGIN`/`CRAM-MD5` authentifient chacun correctement un
   identifiant valide et rejettent chacun un mot de passe incorrect ;
   aucun des trois n'est annoncé avant `STARTTLS` par défaut.
7. Un `RCPT TO` vers un domaine distant est refusé (`550 5.7.1`) sans
   authentification et accepté avec — vérifiable pour les deux cas dans
   le même test.
8. Un message accepté pour un destinataire local est lisible tel quel
   dans `/var/mail/<destinataire>`, au format mbox correct.
9. Une tâche `cron` sans redirection dont la sortie est non vide produit
   réellement un message délivré (`deliverMail` n'est plus un no-op).
10. Une remise vers un domaine distant interroge réellement `MX` (pas de
    raccourci topologique), trie par préférence, et retombe sur `A`/
    `AAAA` en l'absence de `MX`.
11. `mail`/`mailx` en ligne de commande compose et envoie un message en
    mode interactif et non-interactif, et affiche le contenu réel de la
    boîte locale.
12. Le port 465 apparaît désormais dans `IanaServiceRegistry.ts` et
    `WellKnownPorts.ts`, cohérent avec le registre `nmap` déjà correct.
13. Une politique SPF `v=spf1 ip4:.../24 -all` produit `pass` pour une IP
    dans la plage et `fail` pour une IP hors plage, avec un `Received-SPF`
    apposé dans les deux cas.
14. Un message signé DKIM à l'émission est vérifié `pass` à la réception
    s'il n'est pas modifié, et `fail` si un en-tête signé ou le corps est
    altéré après signature.
15. Une politique DMARC `p=reject` refuse réellement la remise d'un
    message non aligné SPF/DKIM ; `p=quarantine`/`p=none` le remettent
    avec l'action attendue et un `Authentication-Results` cohérent.
16. Pendant P1–P12, aucune suite existante ne change ; P13 change
    délibérément le comportement observable de `cron` (mail réellement
    délivré) et des deux registres de ports (port 465 présent), sans
    aucune autre régression.

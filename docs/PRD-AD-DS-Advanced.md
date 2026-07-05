# PRD — Active Directory Domain Services avancé : réplication multi-DC, Kerberos (RFC 4120) et forêts/trusts/schéma extensible/LDAP filaire complet (RFC 4511/4512)

**Version** : 1.0
**Date** : 2026-07-05
**Projet** : Ubuntu Sandbox — Module Active Directory avancé
**Auteur** : Claude Code
**Références normatives** : RFC 4120 (The Kerberos Network Authentication Service V5), RFC 4121 (GSS-API Kerberos V5 mechanism — référence pour le bind LDAP SASL/GSSAPI), RFC 4511/4512/4513 (protocole LDAPv3, modèles d'information/schéma, méthodes d'authentification — **partiellement déjà livrés**, cf. § 1.1), RFC 4514/4515 (DN, filtres — **déjà livrés**), MS-DRSR (Directory Replication Service Remote Protocol — spécification Microsoft propriétaire, pas un RFC IETF ; ce PRD s'en inspire pour la *forme* du modèle de réplication — USN, vecteur high-watermark — sans viser sa conformité fil-à-fil), MS-ADTS (Active Directory Technical Specification — modèle de forêt/partitions/schéma), MS-SFU (S4U2Self/S4U2Proxy — délégation contrainte Kerberos), `docs/PRD-Windows-Server.md` (**déjà livré, P1-P11** — prérequis direct et unique dépendance de ce document).

---

## 0. Contexte et portée du document

`docs/PRD-Windows-Server.md` §2.2 exclut explicitement trois chantiers de son
périmètre :

> - **Réplication AD multi-DC réelle** (USN, KCC, sites) — un second DC
>   partage l'annuaire par référence, sans protocole de réplication.
> - **Kerberos complet** (tickets TGT/TGS chiffrés, délégation) —
>   authentification domaine simplifiée ; `klist` n'affiche que des
>   tickets simulés.
> - **Forêts multiples, trusts, schéma extensible, LDAP filaire complet**
>   (recherche LDAP par port 389 limitée à ce que la jonction exige).

Ce PRD **promeut ces trois non-objectifs au rang d'objectifs**, sans rouvrir
aucune des phases déjà livrées de `PRD-Windows-Server.md` (P1-P11, toutes
✅ terminées) : il consomme `DirectoryStore.ts`/`DirectoryTree.ts`/
`LdapServer.ts`/`LdapClient.ts`/`AdTypes.ts` tels qu'ils existent aujourd'hui
et les étend de façon additive, exactement comme `PRD-HTTP.md` a consommé le
moteur TLS de `PRD-TLS.md` sans le redéfinir.

Une clarification factuelle s'impose avant toute planification : l'état réel
du dépôt, vérifié fichier par fichier, est **plus creux** que ce que le texte
des non-objectifs laisse penser sur deux des trois points.

1. **« Un second DC partage l'annuaire par référence »** ne décrit **aucun
   code existant** — c'est une phrase d'intention jamais implémentée. Il
   n'existe ni méthode `installADDSDomainController`, ni notion de second
   `DirectoryStore` référençant le premier ; le test
   `windows-server-addsforest.test.ts` affirme même l'inverse
   (`it('fails on a second promotion attempt', ...)`, une deuxième
   promotion échoue toujours). Réplication multi-DC est donc un chantier
   **entièrement greenfield**, comparable à l'état de FTP avant
   `PRD-FTP-SFTP.md`.
2. **« Authentification domaine simplifiée »** ne décrit pas un Kerberos ou
   un NTLM simplifié : `DomainJoinClient.ts`/`DomainLogonClient.ts`
   authentifient aujourd'hui **par un vrai bind LDAP simple, mot de passe
   en clair sur le fil**, contre `DirectoryStore.checkPassword()`/
   `checkComputerSecret()` (comparaison de chaîne). Le port 88 n'est qu'une
   entrée de registre de ports et une valeur d'enregistrement DNS `SRV` —
   **rien n'écoute dessus**. `klist` formate des chaînes figées
   (`Start Time: (simulated)`) sans dériver quoi que ce soit d'un ticket
   réel. Kerberos est donc, lui aussi, un chantier **entièrement
   greenfield** — pas une amélioration d'un mécanisme existant.
3. Le troisième point est en revanche un **mélange** : LDAP a un vrai codec
   fil BER/RFC 4511 (bind simple/search/add/modify/delete/compare/unbind,
   ~1 460 lignes réparties sur 7 fichiers dans `ad/ldap/`), mais il manque
   plusieurs opérations RFC 4511 (`modifyDNRequest`, `extendedRequest`,
   `abandonRequest`, le champ `controls` de l'enveloppe, les résultats
   paginés, les référés) et il n'existe ni schéma extensible, ni forêt
   multi-domaines, ni trust — ces quatre derniers sont greenfield au même
   titre que Kerberos et la réplication.

Aucune ligne de code n'est écrite dans le cadre de ce document — il sert de
base à la planification et à la revue avant le premier commit TDD.

### 0.1 Chaîne de dépendances entre PRDs

```
PRD-Windows-Server.md — livré, P1 à P11
   │  DirectoryStore/DirectoryTree/AdTypes (annuaire), LdapServer/LdapClient
   │  (codec BER/RFC 4511 déjà réel), DomainJoinClient/DomainLogonClient
   │  (bind LDAP en clair — remplacé par Kerberos dans ce PRD, § 5 P12),
   │  WinDomainDiag.ts (klist/dcdiag/nltest — cosmétiques, réécrits § 5 P2/P12)
   │
   ▼
PRD-AD-DS-Advanced.md                                    ◄── VOUS ÊTES ICI
   │  consomme directement DirectoryTree (le KDC crée le principal krbtgt
   │  et les comptes machine/utilisateur comme des entrées de l'annuaire
   │  existant ; le schéma extensible étend DirectoryTree, pas une
   │  nouvelle structure parallèle) et LdapServer/LdapClient (SASL/GSSAPI
   │  s'ajoute comme deuxième mécanisme d'authentification à côté du bind
   │  simple existant, sans le retirer)
   ▼
(aucun consommateur PRD identifié pour l'instant)
```

Ce PRD **n'a aucune dépendance bloquante** : son unique prérequis
(`PRD-Windows-Server.md`) est intégralement livré. C'est un PRD terminal —
aucun autre PRD connu n'en dépend à ce jour. Comme `PRD-FTP-SFTP.md` avant
lui, ce document **ne s'inscrit pas** dans `docs/tls_quic_http_log.md` (scopé
à la seule triade TLS/QUIC/HTTP) — un journal de coordination dédié devra
être ouvert séparément si plusieurs agents doivent s'y coordonner.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Constat |
|---|---|---|
| `src/network/devices/windows/server/ad/DirectoryStore.ts` (498 l.) | Façade CRUD (`newUser`/`newGroup`/`newComputer`/`newOrgUnit`/`newGpo`) au-dessus de `DirectoryTree` | Un `DirectoryStore` = un domaine, un DC. Attributs AD-fidèles (`sAMAccountName`, `userAccountControl` avec vrais bits UAC, `groupType`, `member`/`memberOf` DN-valués). **Aucun champ USN, invocationId, ou horodatage d'écriture originelle** sur aucune entrée — les primitives minimales d'un modèle de réplication n'existent même pas en germe |
| `src/network/devices/windows/server/ad/AdTypes.ts` (69 l.) | Modèle d'objets (`AdUser`/`AdGroup`/`AdComputer`/`AdOrgUnit`) | Union fermée, pas de type `AttributeSchema`/`ObjectClassSchema`. Commentaire d'en-tête explicite : *« a deliberate 'LDAP-lite' subset: no schema extensibility... no multi-DC replication »* — confirmation directe des deux premiers non-objectifs. `DomainInfo.dcs: string[]` est un champ vestigial, jamais peuplé ni lu |
| `src/network/devices/WindowsServer.ts:136-151` (`installADDSForest`) | Promotion du **premier** DC d'un domaine | Refuse toute deuxième promotion (`this.directoryStore` déjà défini → erreur). Aucune méthode `installADDSDomainController` n'existe dans tout le dépôt |
| `src/__tests__/unit/network-v2/windows-server-addsforest.test.ts:49` | Test de promotion | `it('fails on a second promotion attempt', ...)` — confirme qu'aucun scénario multi-DC n'est even testé aujourd'hui |
| `src/network/devices/windows/WinDomainDiag.ts` (108 l.) | `nltest`/`dcdiag`/`klist` | `cmdKlist` (l. 88-107) formate des **chaînes figées** (`KerbTicket Encryption Type: AES-256-CTS-HMAC-SHA1-96`, `Start Time: (simulated)`) — zéro dérivation d'un ticket réel |
| `src/network/devices/windows/domain/DomainJoinClient.ts` / `DomainLogonClient.ts` | Jonction de domaine / logon interactif | Les deux dialoguent en **LDAP simple bind, mot de passe en clair sur le fil** (`dialLdap` → `TcpSocket` réel), contre `DirectoryStore.checkPassword()`/`checkComputerSecret()` (comparaison de chaîne, pas de hash NTLM, pas de dérivation de clé). Le commentaire de tête l'assume : *« the same real wire path a domain controller uses to validate any credential »* |
| `src/network/core/WellKnownPorts.ts:42`, `IanaServiceRegistry.ts:54` | Registre de ports | `{88: 'kerberos'}` — nom d'affichage seul, **aucun listener** sur ce port nulle part dans le dépôt |
| `src/network/devices/WindowsServer.ts:190,200-201` | SRV DNS `_kerberos._tcp.dc._msdcs`, service SCM `Kdc` | Purement cosmétique — un enregistrement DNS et un nom de service pour que `dcdiag`/`Get-Service Kdc` affichent « Running », sans aucun socket réel derrière |
| `src/network/devices/windows/server/ad/ldap/{Ber,LdapDN,LdapFilter,LdapMessage,DirectoryTree,LdapServer,LdapClient}.ts` (~1 460 l.) | Codec LDAP fil réel (RFC 4511) | BER générique (X.690, longueurs définies), DN (RFC 4514), filtres (RFC 4515) et enveloppe `LDAPMessage` réels. Opérations câblées : `bindRequest` (**simple uniquement**), `searchRequest`/`add`/`modify`/`del`/`compare`/`unbind`. **Absents** : `modifyDNRequest`, `extendedRequest` (donc pas de StartTLS LDAP), `abandonRequest`, le champ `controls` de l'enveloppe (donc pas de pagination RFC 2696, pas de contrôles étendus), les référés (`searchResultReference`) |
| `src/network/devices/windows/server/featureCatalog.ts:36-39` | Catalogue de fonctionnalités | `AD-Domain-Services` est un rôle unique (services `NTDS`/`Netlogon`/`Kdc`, module PS `ActiveDirectory`) — aucune fonctionnalité de niveau forêt, aucun cmdlet de trust dans `ActiveDirectoryCmdlets.ts` |
| `DirectoryTree.search()` | Moteur de requête | Générique sur l'arbre qu'on lui donne (pas de restriction artificielle de filtre) — la limite est **structurelle** : un seul arbre par DC, donc une seule racine, un seul domaine, aucune partition (`cn=schema`, `cn=configuration`) |

### 1.2 Ce qui existe déjà et est réutilisable

- **`DirectoryTree`/`DirectoryStore`** — le DIT complet (add/delete/modify/
  search/compare, hiérarchie parent-enfant par DN) est solide et déjà
  utilisé par le codec LDAP fil ; ce PRD lui ajoute des champs (USN,
  invocationId) et une partition schéma **de façon additive**, sans
  réécrire le moteur d'arbre.
- **`ad/ldap/*` en entier** (`Ber.ts`, `LdapDN.ts`, `LdapFilter.ts`,
  `LdapMessage.ts`, `LdapServer.ts`, `LdapClient.ts`) — le codec BER/
  RFC 4511 réel est directement réutilisable pour : (a) transporter le
  bind SASL/GSSAPI Kerberos comme deuxième `AuthenticationChoice` à côté
  du bind simple existant (sans le retirer, § 2.2 de `PRD-Windows-Server.md`
  reste satisfait pour les usages qui n'ont pas besoin de Kerberos) ; (b)
  ajouter les opérations manquantes (`modifyDN`/`extended`/`abandon`/
  `controls`) comme de nouveaux `CHOICE` dans l'enveloppe déjà réelle,
  pas un nouveau protocole.
- **`DomainJoinClient`/`DomainLogonClient`** — la logique de haut niveau
  (résolution DNS du DC, construction de l'objet ordinateur/session) est
  conservée ; seul le mécanisme d'authentification qu'ils invoquent
  change (Kerberos AS/TGS au lieu du bind LDAP direct, § 5 P12).
- **`EventBus`/`Signal`** (`src/events/`) — convention d'observabilité déjà
  utilisée par TLS/QUIC/HTTP/RADIUS, réutilisée telle quelle pour
  `kerberos.*`/`replication.*`/`trust.*`.
- **Convention « crypto simulée, forme du protocole réelle »** déjà établie
  par `PkiKeyPair`, `SimulatedTls.ts`, le key schedule de `PRD-TLS.md`,
  la protection de paquets de `PRD-QUIC.md` — directement applicable au
  chiffrement des tickets Kerberos (encodage ASN.1 DER réel des structures
  `KDC-REQ`/`KDC-REP`/`Ticket`/`EncTicketPart`, contenu chiffré simulé).
- **`featureCatalog.ts`/`RoleManager.ts`** — le modèle de fonctionnalités
  existant accueille une nouvelle fonctionnalité (« forêt »/« site
  supplémentaire ») sans changement de son moteur de dépendances/gating.

### 1.3 Ce qui est non conforme ou manquant (gap analysis)

| # | Manque | Référence | Sévérité |
|---|---|---|---|
| 1 | Aucune réplication inter-DC (USN, vecteur high-watermark, cycle de synchronisation) | MS-DRSR | Bloquant |
| 2 | Aucune méthode de promotion d'un **second** DC dans un domaine existant | MS-DRSR / dcpromo | Bloquant |
| 3 | Aucun KDC réel — pas d'AS-REQ/AS-REP, pas de TGS-REQ/TGS-REP, pas de ticket chiffré | RFC 4120 §3.1/§3.3 | Bloquant |
| 4 | `klist`/authentification domaine reposent sur des chaînes cosmétiques et un bind LDAP en clair, pas sur un ticket réel | RFC 4120 | Bloquant |
| 5 | Aucune délégation Kerberos (contrainte ou non) | RFC 4120 / MS-SFU | Moyenne |
| 6 | Le bind LDAP est toujours `simple` — pas de mécanisme SASL/GSSAPI, donc pas de bind adossé à un ticket Kerberos | RFC 4513 §5.2 | Élevée (bloque l'objectif 3) |
| 7 | Aucun schéma extensible — pas de partition `cn=schema`, pas d'`attributeSchema`/`classSchema`, classes d'objet figées dans le code de `DirectoryStore` | RFC 4512 | Élevée |
| 8 | Aucune forêt multi-domaines — un `DirectoryStore` = un domaine, sans partition de configuration ni relation parent-enfant/arborescence de domaines | MS-ADTS | Élevée |
| 9 | Aucun trust inter-domaine/inter-forêt, aucun référencement cross-realm Kerberos | RFC 4120 §3.3.3 / MS-LSAT | Moyenne |
| 10 | LDAP : pas de `modifyDNRequest` (renommage/déplacement), `extendedRequest` (StartTLS), `abandonRequest`, champ `controls` (donc pas de pagination ni de contrôles étendus), pas de référés | RFC 4511 §4.9/§4.12/§4.11/§4.1.11/§4.5.2/§4.1.10 | Moyenne à faible selon l'opération |
| 11 | Port 88 enregistré (nom d'affichage) mais **aucun listener** — même remarque déjà faite pour d'autres protocoles avant leur propre PRD (FTP, RADIUS) | — | Bloquant (prérequis structurel de l'objectif 1) |

**Conclusion de la phase d'analyse** : Kerberos et la réplication multi-DC
sont des chantiers **entièrement greenfield**, comparables à l'état de FTP
avant `PRD-FTP-SFTP.md` — aucune base à auditer au-delà d'un nom de port et
de chaînes cosmétiques. Le schéma extensible et la forêt multi-domaines sont
également greenfield, mais s'appuient sur un moteur d'annuaire
(`DirectoryTree`) déjà solide. Seul le complément LDAP filaire (opérations
manquantes) est un renforcement d'un protocole déjà réel, dans le même
esprit que le renforcement SFTP/SCP de `PRD-FTP-SFTP.md`. Les quatre familles
de travail sont largement indépendantes entre elles au niveau du code, mais
ont des dépendances internes fortes dans l'ordre logique (le KDC doit exister
avant le bind SASL/GSSAPI ; le schéma doit exister avant la forêt multi-
domaines qui le partage via la partition de configuration ; un trust suppose
au moins deux royaumes Kerberos, donc le KDC lui-même).

---

## 2. Objectifs

### 2.1 Objectifs

**1. RFC 4120 §3.1 — KDC minimal, échange AS (Authentication Service).**
Un vrai listener UDP/TCP 88 (comblant le gap #11) implémentant `AS-REQ`/
`AS-REP` : pré-authentification par horodatage chiffré
(`PA-ENC-TIMESTAMP`, §5.2.7.2), émission d'un TGT (`Ticket` chiffré pour le
principal `krbtgt/RÉALME`, créé automatiquement à la promotion du DC comme
une entrée `DirectoryTree` de plus — pas une structure parallèle).
Encodage ASN.1 DER réel des structures `KDC-REQ`/`KDC-REP`/`Ticket`/
`EncTicketPart` (§5.4/§5.3) ; le contenu chiffré est simulé (même
convention que `TlsRecordWire`/`packetProtection.ts`), la forme du message
est réelle.

**2. RFC 4120 §3.3 — Échange TGS (Ticket-Granting Service).** `TGS-REQ`/
`TGS-REP` : un client présentant un TGT valide obtient un ticket de service
pour un SPN (`host/`, `ldap/`, `cifs/`, …) sans re-solliciter le mot de
passe. `klist` (remplace le gap #4) affiche des champs **réellement dérivés**
du ticket en cache (heures de début/fin/renouvellement, drapeaux, type de
clé de session) au lieu de chaînes figées.

**3. RFC 4513 §5.2 — Bind LDAP SASL/GSSAPI.** Le bind `simple` existant
(RFC 4513 §5.1) reste ; ce PRD ajoute le mécanisme `GSSAPI` comme deuxième
`AuthenticationChoice` de l'enveloppe LDAP déjà réelle (comble le gap #6) :
un client muni d'un ticket de service `ldap/<dc>` peut se lier sans
transmettre de mot de passe sur le fil. `DomainJoinClient`/
`DomainLogonClient` basculent sur ce mécanisme (§ 5 P12) — l'authentification
de domaine devient réellement Kerberos, pas un bind en clair déguisé.

**4. Délégation Kerberos contrainte minimale (S4U2Proxy).** Un service
peut obtenir, pour le compte d'un utilisateur déjà authentifié auprès de
lui, un ticket vers un second service explicitement autorisé (attribut
`msDS-AllowedToDelegateTo`, déjà représentable comme attribut d'objet
ordinateur) — le scénario double-saut WinRM/SMB déjà documenté par
`PRD-Windows-Server.md`. `S4U2Self` (délégation non contrainte complète)
reste hors périmètre (§ 2.2).

**5. Réplication AD multi-DC — modèle USN/vecteur high-watermark.**
Chaque `DirectoryStore` reçoit un `invocationId` et une USN locale
incrémentée à chaque écriture ; chaque attribut modifié porte
l'USN/l'horodatage/l'identifiant du DC d'origine (`originating write`,
inspiré de MS-DRSR sans viser sa conformité fil-à-fil). Un cycle de
réplication (« pull » déclenché manuellement ou à intervalle fixe,
**pas** de KCC calculant automatiquement une topologie, § 2.2) échange les
vecteurs high-watermark entre deux DC et ne transfère que les objets/
attributs modifiés depuis la dernière synchronisation.

**6. `Install-ADDSDomainController` — promotion d'un second DC.** Comble
le gap #2 : un second `WindowsServer` rejoint un domaine **existant**
(pas un nouveau domaine), déclenche une synchronisation initiale complète
depuis un DC désigné, puis participe au cycle de réplication de
l'objectif 5. `Get-ADDomainController` liste tous les DC connus (remplace
le champ vestigial `DomainInfo.dcs`).

**7. Sites — métadonnées minimales.** `New-ADReplicationSite`/
`Get-ADReplicationSite` définissent des sites nommés, chacun associé à un
sous-réseau ; un DC appartient à un site. Utilisé uniquement pour annoter
les journaux de réplication (« intra-site » vs « inter-site ») — **aucun
calcul réel de coût de lien ni de planification horaire** (§ 2.2).

**8. RFC 4512 — Schéma extensible.** Une partition `cn=schema,cn=
configuration,<domaine>` matérialisée comme sous-arbre `DirectoryTree`
ordinaire, peuplée d'objets `attributeSchema`/`classSchema` réels.
`New-ADObject -Type attributeSchema`/`New-ADObject -Type classSchema` (ou
cmdlets dédiés `New-ADAttribute`/`New-ADObjectClass`) créent de nouveaux
types ; `DirectoryTree.addEntry`/`modifyEntry` valident désormais un objet
contre le schéma effectivement présent dans cette partition plutôt que
contre un ensemble figé de classes codées en dur dans `DirectoryStore`
(remplace le gap #7), sans casser les classes déjà livrées (`user`,
`group`, `computer`, `organizationalUnit`, …, qui deviennent les entrées
schéma par défaut plutôt que des cas spéciaux).

**9. Forêt multi-domaines.** Une partition de configuration partagée entre
plusieurs `DirectoryStore` (relation arborescente parent-enfant ou racine
d'arborescence — `New-ADDomain -NewDomainName ... -ParentDomainName ...`),
un niveau fonctionnel de forêt, et le partage effectif de la même
partition schéma (objectif 8) entre tous les domaines de la forêt —
c'est *parce que* le schéma est une partition répliquée comme une autre
(objectif 5) que « une forêt = un schéma partagé » se réalise sans
mécanisme supplémentaire.

**10. Trust inter-domaine/inter-forêt.** `netdom trust`/`New-ADTrust`
établit une relation de confiance simple (bidirectionnelle, transitive)
entre deux royaumes Kerberos ; un utilisateur du domaine A authentifié
auprès de son propre KDC obtient, via un référé cross-realm (RFC 4120
§3.3.3 — le KDC de A renvoie un TGT inter-domaine utilisable auprès du KDC
de B), l'accès à une ressource du domaine B sans ressaisir ses
identifiants. Comble le gap #9.

**11. LDAP filaire complet — opérations restantes.** Ajout, dans
l'enveloppe `LDAPMessage` déjà réelle : `modifyDNRequest`/
`modifyDNResponse` (renommage/déplacement d'objet, utile pour les
opérations AD comme `Move-ADObject`), `extendedRequest`/`extendedResponse`
(au minimum l'OID StartTLS, RFC 4511 §4.14.1, consommant le moteur TLS déjà
livré), `abandonRequest`, le champ `controls` de l'enveloppe avec au moins
le contrôle de pagination des résultats (RFC 2696), et les référés
(`searchResultReference`) — ces derniers directement utiles pour une
recherche traversant plusieurs domaines de la forêt (objectif 9). Comble
le gap #10.

**12. Observabilité.** `src/network/kerberos/events.ts`/`observables.ts`
(`kerberos.as.*`/`kerberos.tgs.*`/`kerberos.delegation.*`) et
`src/network/devices/windows/server/ad/replication/events.ts`/
`observables.ts` (`replication.cycle.*`/`replication.conflict.*`), à
l'image de la convention déjà en place pour TLS/QUIC/HTTP/RADIUS.

### 2.2 Non-objectifs (explicitement hors périmètre)

- **Cryptographie Kerberos bit-exacte** (AES-256-CTS-HMAC-SHA1-96/RC4-HMAC
  réels, dérivation de clé PBKDF2 conforme) — simulée, comme le reste du
  projet (TLS/QUIC/HTTP).
- **KCC réel** (calcul automatique de topologie de réplication inter-sites,
  coût de liens, fenêtres horaires, compression réseau) — remplacé par un
  cycle de réplication déclenché manuellement ou à intervalle fixe entre
  DC désignés explicitement.
- **Réplication SYSVOL** (DFSR/FRS) — le partage SYSVOL reste local à
  chaque DC, non synchronisé entre eux.
- **USN rollback, tombstones/lingering objects, garbage collection réelle**
  des objets supprimés.
- **PKINIT** (authentification Kerberos par certificat, RFC 4556),
  **FAST/armoring** (RFC 6113).
- **S4U2Self** (délégation non contrainte complète) — seul S4U2Proxy
  minimal (objectif 4) est couvert.
- **ACL de sécurité par attribut au niveau schéma** (confidentialité
  différenciée par attribut) — le modèle propriétaire/groupe/autres déjà
  livré par `PRD-Windows-Server.md` suffit.
- **Trusts avancés** (SID filtering, authentification sélective,
  quarantaine de domaine, trusts de raccourci) — un trust simple suffit.
- **Interface graphique** (ADSI Edit, « Active Directory Sites and
  Services », « Active Directory Domains and Trusts » MMC) — surface
  CLI/PowerShell uniquement, conformément au reste du simulateur.
- **Compression/chiffrement du canal de réplication** au-delà de ce que
  TLS apporterait s'il était explicitement activé (pas un objectif câblé
  par défaut).

---

## 3. Architecture cible

### 3.1 Principe directeur

**Additif strict, aucune réécriture des sous-systèmes déjà livrés.** Le
schéma extensible, la forêt multi-domaines et la réplication étendent
`DirectoryTree`/`DirectoryStore` par de nouveaux champs et de nouvelles
partitions (`cn=schema`, `cn=configuration`) représentées comme des entrées
d'annuaire ordinaires — pas une structure de données parallèle. Kerberos
est un module entièrement nouveau (`src/network/kerberos/`) qui suit le
même patron que `src/network/tls/`/`src/network/quic/` : machine à états de
session, primitives cryptographiques simulées, encodage ASN.1 réel. Le
bind SASL/GSSAPI et les opérations LDAP manquantes s'ajoutent comme de
nouveaux `CHOICE` dans l'enveloppe `LDAPMessage` déjà réelle, sans toucher
au bind simple ni aux opérations déjà câblées.

### 3.2 Diagramme de couches

```
┌───────────────────────────────────────────────────────────────────────┐
│ Façades : cmdlets (New-ADDSDomainController, New-ADReplicationSite,   │
│  New-ADAttribute/New-ADObjectClass, New-ADDomain, New-ADTrust) +      │
│  commandes cmd (klist réel, repadmin-lite, netdom trust)              │
├───────────────────────────────────────────────────────────────────────┤
│ Kerberos (RFC 4120)         │ Réplication/Forêt/Schéma      │ LDAP     │
│  kerberos/KdcSession.ts     │  ad/replication/               │ (ldap/   │
│  kerberos/KerberosClient.ts │   ReplicationSession.ts        │  existant│
│  kerberos/ticket.ts         │  ad/schema/SchemaPartition.ts  │  étendu :│
│  kerberos/crossRealm.ts     │  ad/forest/Forest.ts           │  modifyDN│
│  (trust)                    │  ad/forest/TrustRelationship.ts│  extended│
│                             │                                │  abandon │
│                             │                                │  controls│
├───────────────────────────────────────────────────────────────────────┤
│ DomainJoinClient/DomainLogonClient — basculent sur Kerberos (§5 P12)  │
│ WinDomainDiag.ts (klist réel) — basculé sur l'état réel (§5 P12)      │
├───────────────────────────────────────────────────────────────────────┤
│ Sous-systèmes déjà livrés (PRD-Windows-Server.md, inchangés) :        │
│  DirectoryStore/DirectoryTree/AdTypes · LdapServer/LdapClient/Ber/    │
│  LdapMessage/LdapFilter/LdapDN · RoleManager/featureCatalog           │
├───────────────────────────────────────────────────────────────────────┤
│ TcpStack/TcpSocket (canal LDAP 389, canal Kerberos 88) · EventBus     │
└───────────────────────────────────────────────────────────────────────┘
```

### 3.3 Modules proposés (arborescence)

```
src/network/kerberos/                    # NOUVEAU — protocole Kerberos entier
├── types.ts                             # PrincipalName, Realm, KDC-REQ/-REP, Ticket, EncTicketPart
├── KdcSession.ts                        # état serveur : AS-REQ/AS-REP, TGS-REQ/TGS-REP
├── KerberosClient.ts                    # état client : obtention TGT puis ticket de service
├── ticket.ts                            # encodage ASN.1 DER réel, chiffrement simulé
├── delegation.ts                        # S4U2Proxy minimal (objectif 4)
├── crossRealm.ts                        # référé cross-realm (objectif 10, s'appuie sur forest/TrustRelationship.ts)
├── events.ts                            # kerberos.as.*, kerberos.tgs.*, kerberos.delegation.*
└── observables.ts

src/network/devices/windows/server/ad/
├── DirectoryStore.ts                    # existant, étendu additivement : invocationId, USN par attribut
├── ldap/                                # existant, étendu additivement :
│   ├── LdapMessage.ts                   #   + modifyDNRequest/extendedRequest/abandonRequest, champ controls
│   ├── LdapControls.ts                  #   NOUVEAU — pagination RFC 2696, autres contrôles
│   └── (Ber/LdapDN/LdapFilter/LdapServer/LdapClient/DirectoryTree — inchangés)
├── replication/                         # NOUVEAU
│   ├── ReplicationSession.ts            #   cycle pull, échange de vecteurs high-watermark
│   ├── HighWatermarkVector.ts           #   USN par DC connu
│   ├── events.ts, observables.ts        #   replication.cycle.*, replication.conflict.*
├── schema/                              # NOUVEAU
│   ├── SchemaPartition.ts               #   cn=schema — attributeSchema/classSchema comme entrées DirectoryTree
│   └── SchemaValidator.ts               #   décore DirectoryTree.addEntry/modifyEntry
├── forest/                              # NOUVEAU
│   ├── Forest.ts                        #   partition de configuration, arborescence de domaines
│   ├── TrustRelationship.ts             #   trust simple bidirectionnel/transitif
│   └── sites.ts                         #   sites/sous-réseaux (objectif 7, métadonnées seules)
└── AdTypes.ts                           # existant, étendu additivement : AttributeSchema, ObjectClassSchema, TrustInfo
```

Note de frontière : ce PRD ne touche ni au moteur `DirectoryTree` (ajout de
champs seulement, jamais de réécriture de `search`/`addEntry`/
`modifyEntry`), ni au codec BER générique (`Ber.ts`), ni au parseur de DN/
filtres (`LdapDN.ts`/`LdapFilter.ts`) — seules l'enveloppe `LdapMessage.ts`
(nouveaux `CHOICE`) et la validation d'entrée (`SchemaValidator.ts`, en
décorateur) sont étendues.

### 3.4 Design patterns retenus

- **Machine à états explicite** (`KdcSession`, `KerberosClient`), à l'image
  de `TlsClientSession`/`TlsServerSession`.
- **Décorateur** (`SchemaValidator` enveloppant `DirectoryTree.addEntry`/
  `modifyEntry`) — même principe que `PermissionCheckingFSDecorator` côté
  SFTP : ajouter une vérification sans dupliquer le moteur qu'elle
  contrôle.
- **Strategy** pour le type de trust (bidirectionnel/entrant/sortant) et
  pour l'authentification LDAP (`simple` vs `GSSAPI`, deux implémentations
  de la même interface `IBindMechanism`).
- **Réutilisation stricte de la convention crypto simulée** déjà établie
  par `PkiKeyPair`/`SimulatedTls.ts`/le key schedule TLS — aucune nouvelle
  primitive cryptographique réelle introduite pour Kerberos.
- **Le schéma et la configuration comme données, pas comme code** :
  `attributeSchema`/`classSchema` sont des entrées `DirectoryTree`
  ordinaires (même mécanisme que n'importe quel autre objet AD), pas un
  fichier de constantes séparé — c'est ce qui permet à la réplication
  (objectif 5) de propager le schéma sans mécanisme dédié.

---

## 4. Modèle de données

### 4.1 KDC-REQ / KDC-REP / Ticket (RFC 4120 §5.4)

```
interface KdcRequest {
  readonly kind: 'AS-REQ' | 'TGS-REQ';
  readonly cname?: PrincipalName;         // absent en TGS-REQ (déjà dans le ticket joint)
  readonly realm: string;
  readonly sname: PrincipalName;
  readonly nonce: number;
  readonly till: number;                  // date d'expiration souhaitée
  readonly paData?: readonly PaData[];    // PA-ENC-TIMESTAMP, PA-TGS-REQ (ticket joint)
}

interface KdcReply {
  readonly kind: 'AS-REP' | 'TGS-REP';
  readonly cname: PrincipalName;
  readonly ticket: Ticket;                // chiffré pour le service cible
  readonly encPart: EncKdcRepPart;        // chiffré pour le client (clé simulée)
}

interface Ticket {
  readonly realm: string;
  readonly sname: PrincipalName;
  readonly encPart: EncTicketPart;        // "chiffré" — simulé, forme réelle
}

interface EncTicketPart {
  readonly flags: TicketFlags;            // forwardable/renewable/initial/pre_authent
  readonly key: SessionKey;
  readonly crealm: string;
  readonly cname: PrincipalName;
  readonly authtime: number;
  readonly starttime: number;
  readonly endtime: number;
  readonly renewTill?: number;
}
```

### 4.2 Réplication — USN et vecteur high-watermark (inspiré MS-DRSR)

```
interface DirectoryStoreReplicationState {
  readonly invocationId: string;          // identité stable du DC pour la réplication
  localUsn: number;                       // incrémentée à chaque écriture locale
}

interface AttributeStamp {
  readonly originatingInvocationId: string;
  readonly originatingUsn: number;
  readonly timestamp: number;
}

interface HighWatermarkVector {
  // par DC connu (invocationId) : la plus haute USN déjà reçue de ce DC
  readonly usnByInvocationId: ReadonlyMap<string, number>;
}
```

### 4.3 Schéma extensible (RFC 4512)

```
interface AttributeSchema {
  readonly ldapDisplayName: string;
  readonly attributeSyntax: string;       // OID de syntaxe (chaîne, entier, DN, booléen, ...)
  readonly isSingleValued: boolean;
}

interface ObjectClassSchema {
  readonly ldapDisplayName: string;
  readonly objectClassCategory: 'structural' | 'auxiliary' | 'abstract';
  readonly mustContain: readonly string[];
  readonly mayContain: readonly string[];
  readonly subClassOf?: string;
}
```

### 4.4 Forêt et trust

```
interface ForestDomain {
  readonly dnsName: string;
  readonly parentDnsName?: string;        // undefined => racine de forêt/arborescence
}

interface TrustRelationship {
  readonly localRealm: string;
  readonly remoteRealm: string;
  readonly direction: 'inbound' | 'outbound' | 'bidirectional';
  readonly transitive: boolean;
}
```

### 4.5 Contrôles et opérations LDAP additionnelles (RFC 4511)

```
interface LdapControl {
  readonly controlType: string;           // OID, ex. 1.2.840.113556.1.4.319 (paged results)
  readonly criticality: boolean;
  readonly controlValue?: Uint8Array;
}

interface ModifyDNRequest {
  readonly entry: string;                 // DN à renommer/déplacer
  readonly newRdn: string;
  readonly deleteOldRdn: boolean;
  readonly newSuperior?: string;
}
```

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — KDC minimal, échange AS (RFC 4120 §3.1/§5.4)** | `kerberos/types.ts`/`KdcSession.ts`/`ticket.ts` : listener 88, `AS-REQ`/`AS-REP`, pré-authentification `PA-ENC-TIMESTAMP`, principal `krbtgt` auto-créé à la promotion du DC | — |
| **P2 — Échange TGS + `klist` réel (RFC 4120 §3.3)** | `TGS-REQ`/`TGS-REP`, tickets de service par SPN ; `WinDomainDiag.ts`/`cmdKlist` basculé sur l'état réel du cache de tickets | P1 |
| **P3 — Bind LDAP SASL/GSSAPI (RFC 4513 §5.2)** | Deuxième `AuthenticationChoice` dans `LdapMessage.ts`, consommant un ticket de service `ldap/<dc>` émis par P2 | P2, LDAP existant |
| **P4 — Réplication multi-DC : USN/vecteur high-watermark** | `ad/replication/ReplicationSession.ts`/`HighWatermarkVector.ts`, extension additive de `DirectoryStore`/`DirectoryTree` (invocationId, stamps par attribut) | — (indépendant de Kerberos) |
| **P5 — `Install-ADDSDomainController`** | Promotion d'un second DC dans un domaine existant, synchronisation initiale complète, `Get-ADDomainController` | P4 |
| **P6 — Sites (métadonnées)** | `ad/forest/sites.ts`, `New-ADReplicationSite`/`Get-ADReplicationSite`, annotation intra-/inter-site des journaux de réplication | P5 |
| **P7 — Schéma extensible (RFC 4512)** | `ad/schema/SchemaPartition.ts`/`SchemaValidator.ts`, partition `cn=schema`, cmdlets `New-ADAttribute`/`New-ADObjectClass` | — (indépendant de Kerberos/réplication) |
| **P8 — Forêt multi-domaines** | `ad/forest/Forest.ts`, partition de configuration partagée (y compris le schéma de P7), `New-ADDomain -ParentDomainName` | P7, P5 (la partition de configuration se réplique comme le reste) |
| **P9 — Trusts inter-domaine/inter-forêt + référé cross-realm** | `kerberos/crossRealm.ts`, `ad/forest/TrustRelationship.ts`, `New-ADTrust`/`netdom trust` | P8, P2 |
| **P10 — Délégation Kerberos contrainte (S4U2Proxy)** | `kerberos/delegation.ts`, attribut `msDS-AllowedToDelegateTo` | P2 |
| **P11 — LDAP filaire complet restant** | `modifyDNRequest`, `extendedRequest` (StartTLS), `abandonRequest`, champ `controls` + pagination RFC 2696, référés (`searchResultReference`, utile pour P8/P9) | LDAP existant, P8 (pour les référés) |
| **P12 — Migration des consommateurs existants** | `DomainJoinClient.ts`/`DomainLogonClient.ts` basculent réellement sur Kerberos (P2/P3) au lieu du bind LDAP direct en clair ; comportement observable (jonction/logon réussissent ou échouent dans les mêmes cas) inchangé | P3 |
| **P13 — Observabilité** | `kerberos/events.ts`/`observables.ts`, `ad/replication/events.ts`/`observables.ts` transverses à P1-P12 | P1–P12 |

Chaque phase suit le cycle rouge → vert → refactor. Pendant P1-P11, ce
travail reste strictement additif (comme `PRD-FTP-SFTP.md` P1-P18) :
aucune suite existante (`windows-server-addsforest`, `windows-server-
domain-join`, `windows-server-ldap`, tests de `klist`/`dcdiag`) n'est censée
changer avant P12. **P12 change délibérément ce principe**, pour la seule
suite d'authentification de domaine : son comportement observable
(jonction/logon réussissent ou échouent dans les mêmes cas qu'aujourd'hui)
doit rester identique, seul le mécanisme interne (Kerberos au lieu du bind
LDAP direct) change.

---

## 6. Stratégie de test

1. **Unitaires KDC (AS)** : `AS-REQ` sans pré-authentification → erreur
   `KRB-ERROR` `KDC_ERR_PREAUTH_REQUIRED` ; avec `PA-ENC-TIMESTAMP` valide
   → `AS-REP` contenant un TGT valide ; mot de passe incorrect → échec de
   déchiffrement de l'horodatage, pas de TGT émis.
2. **Unitaires KDC (TGS)** : un TGT valide obtient un ticket de service
   pour un SPN existant ; un TGT expiré ou falsifié est rejeté ; le ticket
   de service porte les bons `flags`/`crealm`/`cname`.
3. **Unitaires `klist`** : reflète exactement les champs du ticket en
   cache (heures, drapeaux, type de clé) — round-trip avec ce que P1/P2
   ont réellement émis, plus aucune chaîne figée.
4. **Unitaires bind SASL/GSSAPI** : un client muni d'un ticket `ldap/<dc>`
   valide se lie sans transmettre de mot de passe ; un ticket expiré ou
   pour le mauvais service est rejeté ; le bind `simple` existant continue
   de fonctionner sans régression.
5. **Unitaires réplication** : deux DC divergent (écriture locale sur
   chacun), un cycle de réplication converge vers le même état des deux
   côtés ; les vecteurs high-watermark empêchent de retransmettre un
   objet déjà reçu ; un conflit (même attribut modifié des deux côtés)
   se résout de façon déterministe et documentée (dernier écrivain gagne,
   par exemple, à définir explicitement).
6. **Intégration `Install-ADDSDomainController`** : un second serveur
   rejoint un domaine existant, obtient une copie complète de l'annuaire
   par synchronisation initiale, puis reste synchronisé après une
   écriture sur le premier DC.
7. **Unitaires sites** : un DC assigné à un site distinct est annoté
   « inter-site » dans le journal de réplication ; aucune propriété de
   coût de lien réel n'est testée (hors périmètre).
8. **Unitaires schéma** : création d'un `attributeSchema`/`classSchema`
   personnalisé, puis création d'un objet utilisant cette classe ;
   tentative de création d'un objet violant `mustContain` → échec propre ;
   les classes déjà livrées (`user`, `group`, …) continuent de fonctionner
   sans changement observable.
9. **Unitaires forêt** : un domaine enfant partage la même partition
   schéma que son parent (une modification de schéma sur le domaine racine
   se propage) ; `Get-ADForest` reflète l'arborescence.
10. **Unitaires/intégration trust** : un utilisateur du domaine A accède à
    une ressource du domaine B via un référé cross-realm ; sans trust
    configuré, l'accès échoue proprement (pas de repli silencieux).
11. **Unitaires délégation** : un service listé dans
    `msDS-AllowedToDelegateTo` obtient bien un ticket S4U2Proxy pour le
    compte de l'utilisateur ; un service non listé est rejeté.
12. **Unitaires LDAP filaire complet** : `modifyDNRequest` déplace/renomme
    effectivement un objet dans `DirectoryTree` ; `extendedRequest`
    StartTLS établit un vrai handshake TLS sur la connexion LDAP déjà
    ouverte ; `abandonRequest` interrompt une recherche en cours ; la
    pagination retourne des pages cohérentes et complètes sur un jeu de
    résultats plus grand qu'une page ; un référé est retourné pour une
    recherche visant un DN hors du domaine local dans une forêt multi-
    domaines.
13. **Non-régression (P1-P11)** : exécution complète des suites AD DS/
    LDAP/domaine existantes après chaque phase, garantissant l'absence
    d'effet de bord tant que P12 n'est pas atteinte.
14. **Migration (P12)** : les suites de jonction/logon de domaine
    existantes ré-exécutées après bascule sur Kerberos — comportement
    observable (succès/échec dans les mêmes cas, mêmes messages
    d'erreur PowerShell/cmd) identique à l'avant-migration.

---

## 7. Risques et points d'attention

1. **Ampleur du chantier** : ce PRD combine quatre familles de travail
   distinctes (Kerberos, réplication, schéma/forêt, LDAP filaire) — plus
   large que `PRD-FTP-SFTP.md` en interdépendances internes bien que
   comparable en nombre de phases. Refuser tout ajout non listé en § 2.1
   sans mise à jour explicite de ce document.
2. **Kerberos et la réplication sont entièrement greenfield** (§ 1.3) —
   contrairement à ce que le texte des non-objectifs de
   `PRD-Windows-Server.md` pouvait laisser penser, il n'y a **aucune base
   simplifiée à faire évoluer** : le risque n'est pas la régression d'un
   mécanisme existant mais la sous-estimation de la surface RFC 4120
   (types d'erreurs `KRB-ERROR`, interactions pré-authentification/
   renouvellement/délégation).
3. **Le schéma comme donnée d'annuaire est élégant mais fragile** : faire
   de `attributeSchema`/`classSchema` des entrées `DirectoryTree`
   ordinaires (§ 3.4) simplifie la réplication mais impose que
   `SchemaValidator` s'exécute **avant** toute écriture sur n'importe
   quelle partition — un chemin d'écriture qui contournerait le
   décorateur casserait silencieusement l'intégrité du schéma.
4. **Résolution de conflit de réplication non spécifiée par défaut dans le
   monde réel de manière simple** : MS-DRSR utilise un tampon de version
   par attribut assez subtil ; ce PRD doit choisir et documenter
   explicitement une règle déterministe (§ 6, test 5) plutôt que de la
   laisser implicite.
5. **Cross-realm et forêts multiplient les combinaisons de test** : une
   fois trust + forêt + délégation combinés, le nombre de scénarios
   d'authentification croît vite — prioriser les chemins P2/P3/P9/P10
   décrits en § 6 plutôt que d'essayer une couverture combinatoire
   complète.
6. **Ne pas dupliquer `DirectoryTree`** : la tentation de créer une
   structure de données séparée pour le schéma ou la configuration de
   forêt (plutôt que des entrées dans l'arbre existant) serait une
   régression architecturale et casserait la réplication uniforme de
   l'objectif 5.
7. **P12 est le seul point de bascule à risque de régression réelle** :
   toutes les phases précédentes sont additives ; ne pas anticiper la
   migration de `DomainJoinClient`/`DomainLogonClient` avant que P2/P3
   soient vertes et stables.
8. **Absence de journal de coordination dédié** : comme `PRD-FTP-SFTP.md`,
   ce document ne s'inscrit pas dans `docs/tls_quic_http_log.md` — un
   journal séparé devra être créé avant tout travail multi-agent sur ce
   PRD.
9. **Pas de dépendance bloquante externe, mais un ordonnancement interne
   strict** : contrairement à `PRD-QUIC.md`/`PRD-HTTP.md` à leur rédaction,
   aucune phase de ce document n'attend un chantier externe — mais
   tenter P3 avant P2, ou P9 avant P8, romprait les dépendances internes
   du tableau § 5.

---

## 8. Critères d'acceptation

1. Un utilisateur de domaine s'authentifie via `AS-REQ`/`AS-REP` puis
   `TGS-REQ`/`TGS-REP` réels ; `klist` affiche des tickets dont les champs
   sont dérivés de ce qui a effectivement été émis, plus aucune chaîne
   figée.
2. La jonction de domaine et le logon interactif (`DomainJoinClient`/
   `DomainLogonClient`) passent par Kerberos (bind LDAP SASL/GSSAPI), et
   non plus par un bind LDAP en clair — sans changement du comportement
   observable en cas de succès/échec.
3. Un second `WindowsServer` est promu DC additionnel d'un domaine
   existant (`Install-ADDSDomainController`), reçoit l'intégralité de
   l'annuaire par synchronisation initiale, puis reste convergent avec le
   premier DC après un cycle de réplication suivant une écriture locale
   sur l'un ou l'autre.
4. Un administrateur définit un `attributeSchema`/`classSchema`
   personnalisé et crée un objet de cette classe, qui survit à un cycle
   de réplication vers un second DC.
5. Une forêt à deux domaines (parent/enfant) partage effectivement le
   même schéma ; une modification de schéma sur le domaine racine se
   propage à l'enfant.
6. Un trust simple entre deux domaines permet à un utilisateur de l'un
   d'accéder, via un référé Kerberos cross-realm, à une ressource de
   l'autre ; sans trust, l'accès échoue proprement.
7. Un service autorisé par `msDS-AllowedToDelegateTo` obtient un ticket
   délégué (S4U2Proxy) pour le compte d'un utilisateur déjà authentifié.
8. `modifyDNRequest`, `extendedRequest` (StartTLS), `abandonRequest`, la
   pagination des résultats et les référés fonctionnent contre le serveur
   LDAP existant, sans régression des opérations déjà livrées (bind
   simple, search, add, modify, delete, compare).
9. La régression complète des suites AD DS/LDAP/domaine déjà livrées par
   `PRD-Windows-Server.md` reste verte à chaque phase P1-P11, et de
   nouveau verte après la migration P12 (comportement observable
   identique).

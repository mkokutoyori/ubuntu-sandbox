# PRD — Domaine en ligne de commande : `netdom.exe`

**Version** : 1.0
**Date** : 2026-07-25
**Projet** : Ubuntu Sandbox — Module Windows Server / Active Directory
**Auteur** : Claude Code
**Références normatives** : documentation Microsoft de `netdom.exe` (RSAT —
Active Directory Domain Services Tools / Remote Server Administration
Tools), MS-ADTS pour la sémantique des comptes ordinateur et des
relations d'approbation (déjà couverte par `PRD-Windows-Server.md`/
`-Advanced.md`, réutilisée sans duplication, § 0.2). Ce PRD est un
document de **complétion** : `netdom` existe déjà et fonctionne
partiellement dans ce dépôt (`WindowsPC.cmdNetdom`), il ne s'agit pas
d'une brique greenfield.

---

## 0. Contexte et portée du document

`netdom.exe` est, sur un vrai poste/serveur Windows, l'outil en ligne de
commande de référence pour tout ce qui touche à la relation entre une
machine (ou un domaine entier) et Active Directory **en dehors** de ce
que couvrent les cmdlets PowerShell modernes : joindre/quitter un
domaine, renommer un ordinateur déjà joint, réinitialiser le canal
sécurisé d'une machine ou d'un contrôleur de domaine, gérer les
approbations inter-domaines, et interroger un DC sur des informations
topologiques (FSMO, PDC, liste des DC). C'est un outil **antérieur** à
la plupart des cmdlets AD (`Add-Computer`, `New-ADTrust`,
`Test-ComputerSecureChannel`, `Rename-Computer` n'existaient pas avant
PowerShell v2/v3) et encore largement utilisé aujourd'hui dans les
scripts de provisioning et les procédures de dépannage héritées — un
scénario de formation AD qui ne le couvre que partiellement laisse un
angle mort réaliste (beaucoup d'admins ne connaissent `netdom` que par
`netdom join`/`netdom trust`, jamais par le reste de sa surface).

Ce dépôt a déjà l'essentiel de la plomberie réseau/annuaire dont
`netdom` a besoin (§ 0.2) — jointure de domaine réelle, approbations
réelles, comptes ordinateur réels, FSMO réels. ce PRD ne réimplémente
aucun de ces mécanismes : il **branche de nouvelles sous-commandes CLI**
sur des primitives déjà livrées, exactement comme `PRD-Repadmin.md` l'a
fait pour `repadmin.exe`.

### 0.1 Chaîne de dépendances

```
DomainJoinClient.ts / DirectoryStore.ts / TrustRelationship.ts (livrés)
  joinDomain() réel (LDAP AddRequest), newComputer()/removeComputer(),
  TrustRegistry (New-ADTrust déjà réel), FSMO (getDomainFsmoRoleOwner,
  ForestFsmoRoles)
        │
WindowsComputerAdapter.testSecureChannel() (livré, PowerShell uniquement)
  bind LDAP réel avec le secret machine — précédent exact pour `netdom
  verify`/`netdom reset` (§ 1.3)
        │
WindowsPC.cmdNetdom() (existant, partiel)
  join, trust (create + verify — /verify livré en cours de ce PRD,
  cf. § 1.1), query fsmo
        ▼
PRD-Netdom.md                                              ◄── VOUS ÊTES ICI
   P1 verify · P2 reset · P3 resetpwd · P4 remove · P5 renamecomputer ·
   P6 computername · P7 query (extension) · P8 add · P9 trust (extension)
        ▼
(aucun consommateur PRD identifié — netdom est un outil terminal, comme
repadmin et auditpol le sont déjà dans ce dépôt)
```

Aucune dépendance bloquante : tout le code consommé (`DomainJoinClient`,
`DirectoryStore`, `TrustRegistry`, FSMO) est déjà en production.

### 0.2 Ce que ce PRD réutilise sans le dupliquer

| Besoin `netdom` | Brique déjà livrée réutilisée | Fichier |
|---|---|---|
| Jonction de domaine (compte ordinateur + secret machine) | `joinDomain()` (LDAP `AddRequest` réel) | `src/network/devices/windows/domain/DomainJoinClient.ts` |
| Vérification du canal sécurisé d'une machine membre | `WindowsComputerAdapter.testSecureChannel()` (bind LDAP réel avec le secret machine) | `src/powershell/providers/WindowsPSProviders.ts:2024-2033` |
| Établissement/miroir d'une approbation, vérification | `WindowsServer.newADTrust()`/`TrustRegistry` | `src/network/devices/WindowsServer.ts:1091-1140`, `.../ad/forest/TrustRelationship.ts` |
| Suppression/renommage de compte ordinateur | `DirectoryStore.newComputer()` (à étendre, § 2.1 P4/P5 — pas de `removeComputer`/renommage d'objet ordinateur aujourd'hui, cf. § 1.2) | `src/network/devices/windows/server/ad/DirectoryStore.ts:1180-1199` |
| Rôles FSMO (forêt + domaine) | `store.getDomainFsmoRoleOwner(...)`, `getForest().getFsmoRoles()` | `DirectoryStore.ts`, forêt AD déjà livrée |
| Renommage de machine (nom local, hosts, `COMPUTERNAME`) | `WindowsPC.setHostname()` | `src/network/devices/WindowsPC.ts:1628-1632` |
| DNS de la machine (zone du domaine, enregistrement A) | Zone DNS déjà gérée par `Install-ADDSForest`/`AddDnsServerResourceRecordACmdlet` | `DnsServerCmdlets.ts`, moteur DNS déjà livré |

Ce PRD n'étend `DirectoryStore` que là où une primitive manque
réellement (suppression/renommage/réinitialisation de secret d'un
compte ordinateur, § 2.1) — tout le reste est un nouveau routage de
sous-commande CLI sur des données déjà réelles.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Constat |
|---|---|---|
| `src/network/devices/WindowsPC.ts:2027` (`case 'netdom'`) | Point d'entrée cmd | Route vers `cmdNetdom()`, seul point d'entrée |
| `WindowsPC.ts:3220-3236` (`cmdNetdom`) | Routeur de sous-commandes | Seuls `trust`, `query fsmo` et `join` (par défaut) sont reconnus ; `add`, `computername`, `move`, `remove`, `renamecomputer`, `reset`, `resetpwd`, `verify`, et toute autre forme de `query` tombent sur la bannière d'usage de `join` |
| `WindowsPC.ts:3247-3260` (`cmdNetdom` → `joinDomainNow`) | `netdom join` | Réel — même dialogue LDAP qu'`Add-Computer` (§ 0.2), livré |
| `WindowsPC.ts:3266-3325` (`cmdNetdomTrust`) | `netdom trust` | Forme de création (`/d:`/`/Server:`/`/UserD:`/`/PasswordD:`/`/Direction:`/`/Transitive:`) réelle depuis le début de ce PRD ; la forme `/Verify` (positionnel `TrustingDomain` + `/Domain:` + `/Verify`, sans créer de nouvelle approbation) vient d'être ajoutée dans le cadre du travail préparatoire à ce document — reste manquants : `/Remove`, `/Reset` (rotation du mot de passe d'approbation), `/Force`, `/Twoway`, `/Oneway`, `/Kerberos` |
| `WindowsPC.ts:3337-3353` (`cmdNetdomQueryFsmo`) | `netdom query fsmo` | Réel, livré — seule forme de `query` implémentée |
| (recherche exhaustive) | `netdom verify` (canal sécurisé d'une machine membre, formulaire standalone — distinct de `trust /Verify`) | **Absent** — aucune route ; l'équivalent PowerShell (`Test-ComputerSecureChannel`/`WindowsComputerAdapter.testSecureChannel()`) existe et fonctionne (§ 0.2), mais rien ne l'expose au niveau `cmd` |
| (recherche exhaustive) | `netdom reset` (réinitialisation du canal sécurisé, régénère et repousse le secret machine) | **Absent** — pas de méthode `DirectoryStore`/`WindowsPC` pour changer le secret machine d'un compte ordinateur existant après coup |
| (recherche exhaustive) | `netdom resetpwd` (réinitialisation du mot de passe de compte ordinateur d'un DC, dépannage de canal DC↔DC) | **Absent** |
| (recherche exhaustive) | `netdom remove` (retrait du domaine — retour en workgroup + suppression/désactivation du compte ordinateur AD) | **Absent** — aucun `Remove-Computer`/unjoin nulle part dans ce dépôt, ni cmdlet PowerShell ni commande cmd |
| (recherche exhaustive) | `netdom renamecomputer` (renommage d'une machine déjà jointe, avec mise à jour SPN/DNS) | **Absent** — `WindowsPC.setHostname()` renomme la machine localement (§ 0.2) mais ne touche jamais l'objet AD `computer` distant (`sAMAccountName`, `servicePrincipalName`, `dNSHostName`) ni la zone DNS |
| (recherche exhaustive) | `netdom computername` (`/enumerate`, `/add`, `/remove`, `/makeprimary` — noms alternatifs) | **Absent** |
| (recherche exhaustive) | `netdom add` (pré-création d'un compte ordinateur sans jonction) | **Absent** en tant que sous-commande `netdom`, mais `DirectoryStore.newComputer()` (§ 0.2) fait déjà exactement ce qu'il faut — accessible aujourd'hui uniquement via le chemin `join` complet |
| (recherche exhaustive) | `netdom query` au-delà de `fsmo` (`pdc`, `dc`, `dclist`, `ou`, `workstation`) | **Absent** |
| `src/network/devices/windows/server/ad/DirectoryStore.ts:1180-1199` (`newComputer`) | Création de compte ordinateur | Pas de pendant `removeComputer`/`renameComputer`/`resetComputerSecret` — seule la création existe |
| `src/network/devices/windows/domain/DomainTypes.ts` (`DomainMembership`) | État de jonction côté client | `{dnsName, netbiosName, dcAddress, machineSecret}` — pas de champ à faire évoluer pour P1-P4 (lecture seule pour `verify`, réécrit sur place pour `reset`) |
| `docs/PRD-Windows-Server-Advanced.md § 5 P9` | Approbations (Trust) | Livré et stable — ce PRD étend `netdom trust` mais ne touche pas au moteur `TrustRegistry` lui-même |

### 1.2 Constats-clés

1. **`netdom` n'a que 3 sous-commandes fonctionnelles sur les ~11 réelles**
   (`join`, `trust` [création + vérification], `query fsmo`) — la
   plupart des autres retombent silencieusement sur la bannière d'usage
   de `join`, ce qui est trompeur (un admin tapant `netdom verify ...`
   voit un message d'aide pour `netdom join`, pas une erreur "commande
   non reconnue" ni un vrai résultat).
2. **Les primitives sous-jacentes existent déjà pour la moitié des
   sous-commandes manquantes** (`verify` ≡ `testSecureChannel()` déjà
   réel côté PowerShell, `add` ≡ `newComputer()` déjà réel, `query`
   étendu ≡ mêmes données FSMO/annuaire déjà exposées ailleurs) — ce
   sont majoritairement de **nouvelles routes CLI sur des données déjà
   réelles**, pas une nouvelle collecte.
3. **Trois sous-commandes nécessitent une primitive `DirectoryStore`
   réellement nouvelle** : `reset`/`resetpwd` (changer le secret d'un
   compte ordinateur existant — aucune méthode ne le permet aujourd'hui,
   seule la création initiale existe), `remove` (aucun retrait de
   compte ordinateur), `renamecomputer` (aucune mise à jour de l'objet
   AD `computer` après coup, seulement le renommage local).
4. **`DomainMembership` est immuable une fois posé** (`WindowsPC.
   domainMembership`, assigné une seule fois par `joinDomainNow`) — un
   `reset` réussi doit mettre à jour `machineSecret` sur place, un
   `remove` réussi doit remettre `domainMembership` à `null` (symétrique
   du join), point de vigilance pour l'implémentation (§ 7).
5. **Aucune décision de périmètre héritée d'un PRD amont** — comme
   `PRD-Repadmin.md`, ce PRD est libre de fixer son propre périmètre
   (§ 2.2), en s'inspirant des exclusions déjà pratiquées ailleurs (GUI
   exclue, protocoles/legacy NT4 exclus).

### 1.3 Précédents architecturaux exacts (grounding)

**Vérification de canal sécurisé** (précédent exact pour P1/P2) :
`WindowsComputerAdapter.testSecureChannel()` (`WindowsPSProviders.ts:
2024-2033`) — dial LDAP réel vers `membership.dcAddress`, bind avec
`sam = "<hostname>$"` et `membership.machineSecret`, retourne le
résultat du bind. `netdom verify` est exactement cette opération
exposée au niveau `cmd` plutôt que PowerShell ; `netdom reset` est la
même vérification suivie, en cas d'échec (ou systématiquement, à
l'option `/Force` près), d'une régénération+repoussée du secret via un
`ModifyRequest` LDAP sur l'attribut `userPassword` du compte ordinateur
— même wire dialogue que `joinDomain()` utilise pour le créer (`Add
Request`), juste un `Modify` à la place.

**Approbations** (précédent exact pour P9) : `WindowsServer.
newADTrust()` (`WindowsServer.ts:1091-1140`) — dial LDAP + bind pour
vérifier joignabilité/creds, génère un `interrealmSecret`, l'enregistre
localement (`DirectoryStore.addTrust`) puis le pousse côté distant via
un `AddRequest` LDAP direct (pas de second aller-retour applicatif). Le
retrait d'une approbation (`/Remove`) est le pendant symétrique : un
`DeleteRequest` local (`TrustRegistry` a déjà la structure de stockage,
il manque juste `removeTrust()`) et, si joignable, côté distant.

**Cmdlets liées** (précédent : `ComputerCmdlets.ts`, `ctx.providers.
computer`, `WindowsComputerAdapter`/`IComputerProvider`) : chaque
nouvelle capacité `DirectoryStore`/`WindowsPC` que ce PRD introduit doit
être exposée à *la fois* en `cmd` (`netdom <sous-commande>`) et, quand
un pendant PowerShell natif existe réellement sur un vrai Windows
(`Remove-Computer`, `Rename-Computer`, `Reset-ComputerMachinePassword`),
en cmdlet — cohérent avec le principe déjà pratiqué dans ce dépôt qu'un
même mécanisme sous-jacent sert les deux surfaces (`Add-Computer`/
`netdom join` en sont déjà l'exemple vivant).

---

## 2. Objectifs

### 2.1 Objectifs (phases TDD, chacune livrable et testable indépendamment)

- **P1 — `netdom verify <MachineName> [/Domain:<Domain>]`** : vérifie le
  canal sécurisé de la machine LOCALE (ou nommée, si joignable et cette
  machine est un DC capable de la contacter) vers son domaine — réutilise
  `testSecureChannel()` (§ 0.2/1.3) sans duplication. Succès : `NetSetupOk`
  imprimé + `The secure channel from <Machine> to the domain <Domain> is
  in good condition.`/`The command completed successfully.` ; échec :
  message honnête (`The secure channel between the workstation and the
  primary domain failed.`) sans faux succès.
- **P2 — `netdom reset <MachineName> /Domain:<Domain> [/UserO:<User>
  /PasswordO:<Password>]`** : régénère le secret machine et le pousse
  au DC via un `ModifyRequest` LDAP réel (précédent § 1.3), puis met à
  jour `WindowsPC.domainMembership.machineSecret` localement — un
  `netdom verify` immédiatement après doit refléter le nouveau secret
  des deux côtés (pas de désynchronisation locale/DC).
- **P3 — `netdom resetpwd /Server:<DC> /UserD:<User> /PasswordD:<Password>`**
  (DC uniquement — dépannage du propre compte ordinateur d'un DC) :
  même mécanisme que P2 mais ciblant le compte ordinateur de la machine
  qui exécute la commande (un DC), documenté comme la variante
  "réservée aux DC" de P2 plutôt qu'un second mécanisme.
- **P4 — `netdom remove <MachineName> /Domain:<Domain> /UserD:<User>
  /PasswordD:<Password>`** : retire la machine du domaine — un
  `DeleteRequest`/désactivation du compte ordinateur côté DC
  (`DirectoryStore.removeComputer()`, nouveau, symétrique de
  `newComputer()`) puis remet `domainMembership` à `null` localement
  (la machine repasse en workgroup). Ajoute par la même occasion la
  cmdlet PowerShell native manquante `Remove-Computer` (même mécanisme,
  § 1.3 principe de double surface).
- **P5 — `netdom renamecomputer <MachineName> /NewName:<NewName>
  [/UserD:<User> /PasswordD:<Password> /Force]`** : renomme une machine
  déjà jointe — renomme localement (réutilise `setHostname()`, § 0.2)
  **et** met à jour l'objet AD `computer` distant (`sAMAccountName`,
  `servicePrincipalName` HOST/, `dNSHostName`) plus l'enregistrement DNS
  A existant, contrairement au comportement actuel qui ne touche que le
  nom local. Ajoute la cmdlet PowerShell native manquante
  `Rename-Computer` pour la même raison qu'en P4.
- **P6 — `netdom computername <MachineName> /Enumerate |
  /MakePrimary:<Name>`** : réutilise directement le renommage de P5 pour
  `/MakePrimary` (un renommage complet, du point de vue de ce
  simulateur — § 2.2 pour la simplification assumée sur `/Add`/`/Remove`
  de noms alternatifs) ; `/Enumerate` liste simplement le nom courant.
- **P7 — extension de `netdom query`** : `pdc` (émulateur PDC du
  domaine), `dc`/`dclist` (liste des DC connus de l'annuaire), `ou`
  (liste des OU) — toutes des vues en lecture seule sur des données déjà
  réelles (§ 0.2), à l'image de `query fsmo` déjà livré.
- **P8 — `netdom add <MachineName> /Domain:<Domain> /UserD:<User>
  /PasswordD:<Password> [/OU:<OUPath>]`** : pré-crée un compte ordinateur
  sans joindre la machine courante (réutilise `DirectoryStore.
  newComputer()` directement, § 0.2, sans passer par le chemin `join`
  complet).
- **P9 — extension de `netdom trust`** : `/Remove` (retire une
  approbation, `TrustRegistry.removeTrust()` nouveau, symétrique de
  `addTrust`), `/Reset` (régénère l'`interrealmSecret` d'une approbation
  existante, même mécanisme que P2 appliqué à `TrustRegistry` plutôt
  qu'à un compte ordinateur), `/Force` (documenté comme accepté mais
  sans effet observable supplémentaire dans ce simulateur — pas de
  notion de "connexion en attente" à outrepasser).

### 2.2 Non-objectifs

- **`netdom move`** : migration d'une machine membre d'un domaine vers
  un autre EN CONSERVANT son SID/historique — opération NT4→AD legacy
  rarissime en usage réel moderne (les migrations inter-domaines
  actuelles passent par ADMT, hors périmètre de ce simulateur) ; un
  script qui veut "changer de domaine" dans ce simulateur fait
  `netdom remove` (P4) puis `netdom join` (déjà livré), ce qui couvre le
  besoin pédagogique sans reproduire la préservation de SID.
- **`netdom movent4bdc`** : opération de migration NT4 BDC, obsolète
  depuis Windows 2000, aucun NT4 dans ce simulateur — exclusion
  immédiate, cohérente avec l'absence totale de tout code NT4 ailleurs
  dans ce dépôt.
- **`netdom query dcb`** : mode de requête NT4 (Backup Domain
  Controller) — même raisonnement que ci-dessus.
- **`netdom computername /Add`/`/Remove`** (gestion fine de noms
  d'ordinateur alternatifs, utilisée pour les renommages en plusieurs
  étapes sur les très grosses infrastructures) : ce simulateur ne modélise
  qu'un nom principal par machine (comme la totalité du reste du dépôt,
  `WindowsPC.hostname` est un champ scalaire) — `/MakePrimary` (P6)
  couvre le cas pédagogique utile (renommer), la gestion multi-noms
  n'a pas de consommateur identifié.
- **`netdom trust /Kerberos`/`/RC4`** (sélection de l'algorithme de
  chiffrement du canal d'approbation) : ce simulateur ne modélise le
  secret d'approbation que comme une chaîne opaque (`interrealmSecret`,
  § 1.3) — accepter et ignorer le flag serait un faux-semblant, refuser
  explicitement plutôt que prétendre une négociation crypto réelle.
- **`netdom query dclist` avec inter-forêt / GC scope étendu, `netdom
  query dsp`** (informations de topologie de site/GC avancées) : hors
  périmètre — ce simulateur n'a pas de notion de "partition partielle"
  (Global Catalog) répliquée, cohérent avec l'absence déjà actée dans
  `PRD-Windows-Server-Advanced.md`.
- **Aide interactive complète (`netdom help <subcommand>`)** : ce
  simulateur affiche déjà une bannière d'usage minimale par sous-commande
  mal formée (comportement existant conservé) — reproduire le texte
  d'aide complet de chaque sous-commande n'apporte aucune valeur de test
  au-delà de ce que les messages d'erreur ciblés (§ 6) fournissent déjà.

---

## 3. Architecture cible

```
WindowsPC.cmdNetdom(args)                              (existant, étendu)
  │
  ├─▶ join            (existant, livré)                joinDomainNow() → DomainJoinClient.joinDomain()
  ├─▶ trust           (existant, étendu P9)             WindowsServer.newADTrust()/getTrust()/
  │                                                      TrustRegistry.removeTrust() (nouveau)
  ├─▶ query           (existant [fsmo], étendu P7)      DirectoryStore (FSMO, listComputers, listOUs)
  ├─▶ verify          (nouveau, P1)                     même primitive que
  │                                                      WindowsComputerAdapter.testSecureChannel()
  ├─▶ reset/resetpwd  (nouveau, P2/P3)                  DirectoryStore.resetComputerSecret() (nouveau)
  │                                                      + WindowsPC.domainMembership mis à jour sur place
  ├─▶ remove          (nouveau, P4)                     DirectoryStore.removeComputer() (nouveau)
  │                                                      + WindowsPC.domainMembership = null
  ├─▶ renamecomputer  (nouveau, P5)                     WindowsPC.setHostname() (existant)
  │                                                      + DirectoryStore.renameComputer() (nouveau,
  │                                                        sAMAccountName/servicePrincipalName/dNSHostName)
  │                                                      + mise à jour de l'enregistrement DNS A existant
  ├─▶ computername    (nouveau, P6)                     réutilise renamecomputer (P5) pour /MakePrimary
  └─▶ add             (nouveau, P8)                     DirectoryStore.newComputer() (existant, appelé
                                                          directement sans jonction locale)

Cmdlets PowerShell natives ajoutées en parallèle (même mécanisme, § 1.3) :
  Remove-Computer   (P4) → IComputerProvider.remove()
  Rename-Computer   (P5) → IComputerProvider.rename()
```

Aucune seconde implémentation de la jonction/annuaire/approbation : ce
PRD ajoute des routes CLI et, seulement là où § 1.2 point 3 identifie un
vrai trou, de nouvelles méthodes `DirectoryStore` ciblées (reset,
remove, rename d'un compte ordinateur ; remove/reset d'une approbation).

---

## 4. Modèle de données

### 4.1 Extensions à `DirectoryStore` (P2-P5, P9)

```ts
// Compte ordinateur — symétriques de newComputer() (déjà livré)
resetComputerSecret(name: string, newSecret: string): DirOpResult;
removeComputer(name: string): DirOpResult;
renameComputer(oldName: string, newName: string): DirOpResult;
  // met à jour sAMAccountName ("<newName>$"), cn, servicePrincipalName
  // (HOST/<newName>, HOST/<newName>.<dnsName>), dNSHostName

// Approbations — symétriques de addTrust() (déjà livré, TrustRegistry)
removeTrust(remoteRealm: string): TrustOpResult;
resetTrustSecret(remoteRealm: string, newSecret: string): TrustOpResult;
```

### 4.2 `WindowsPC.domainMembership` — mise à jour en place (P2/P4)

`DomainMembership` (`DomainTypes.ts`, § 1.1) reste la même interface —
P2 réaffecte `this.domainMembership = { ...this.domainMembership,
machineSecret: newSecret }` après un `reset` réussi ; P4 réaffecte
`this.domainMembership = null` après un `remove` réussi, symétrique de
`joinDomainNow()` qui le pose.

### 4.3 Nouvelles méthodes `IComputerProvider` (P4/P5, cmdlets PowerShell)

```ts
remove(credential: { username: string; password: string }): AdOpResult;
rename(newName: string, credential?: { username: string; password: string }): AdOpResult;
```

Précédent exact : `IComputerProvider.join()`/`testSecureChannel()`
existants (`PSProviders.ts`), même forme de retour `AdOpResult`.

---

## 5. Plan de mise en œuvre (TDD, par phases)

1. **P1** en premier — le plus simple (une seule route CLI vers une
   primitive 100 % déjà réelle), sert aussi de gabarit pour le format de
   sortie des sous-commandes suivantes (`NetSetupOk` / `The command
   completed successfully.` vs `... failed to complete successfully.`,
   déjà établi par `join`/`trust`, § 1.1).
2. **P2** ensuite (dépend de rien de nouveau côté annuaire que la
   primitive `resetComputerSecret`) — tester d'abord le cas nominal
   (secret changé des deux côtés, `verify` P1 le confirme immédiatement
   après), puis le cas DC injoignable (secret local inchangé, pas de
   désynchronisation partielle).
3. **P3** juste après P2, comme sa variante DC-only — réutilise le même
   `resetComputerSecret`, seule la cible (compte du DC courant plutôt
   qu'un `MachineName` arbitraire) diffère.
4. **P4** ensuite — nécessite `removeComputer()` (nouveau) ; tester la
   séquence complète join (existant) → remove (P4) → join à nouveau,
   pour vérifier qu'aucun état résiduel ne bloque une seconde jonction.
5. **P5** après P4 (partage le même risque de désynchronisation
   local/AD que le reset) — tester que `Get-ADComputer` après renommage
   reflète le nouveau `sAMAccountName`/SPN, et que la résolution DNS de
   l'ancien nom échoue tandis que le nouveau réussit.
6. **P6** trivial une fois P5 posé (pur alias `/MakePrimary` → rename).
7. **P7** indépendant, peut se faire en parallèle de P2-P6 (pur
   formatage sur des données déjà réelles, comme `query fsmo`).
8. **P8** indépendant également (`newComputer()` déjà réel, juste un
   nouveau point d'entrée CLI qui saute l'étape de jonction locale).
9. **P9** en dernier — dépend de `TrustRegistry.removeTrust()`
   (nouveau), à tester en réutilisant le scénario `scenario-ad-trust-
   relationships.test.ts` déjà existant comme gabarit (établir une
   approbation, la retirer, vérifier que `Get-ADTrust` la signale
   absente et qu'un `runas` inter-domaine qui fonctionnait avant échoue
   après).

### 5.1 Table récapitulative des phases

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — verify** | `netdom verify` (§ 2.1) | `testSecureChannel()` déjà livré |
| **P2 — reset** | `netdom reset`, `DirectoryStore.resetComputerSecret()` | Aucune (nouvelle primitive isolée) |
| **P3 — resetpwd** | `netdom resetpwd` (variante DC de P2) | P2 |
| **P4 — remove** | `netdom remove`, `DirectoryStore.removeComputer()`, `Remove-Computer` | Aucune |
| **P5 — renamecomputer** | `netdom renamecomputer`, `DirectoryStore.renameComputer()`, `Rename-Computer` | `setHostname()` déjà livré |
| **P6 — computername** | `netdom computername /Enumerate`\|`/MakePrimary` | P5 |
| **P7 — query (extension)** | `pdc`, `dc`/`dclist`, `ou` | `query fsmo` déjà livré comme gabarit |
| **P8 — add** | `netdom add` | `newComputer()` déjà livré |
| **P9 — trust (extension)** | `/Remove`, `/Reset`, `/Force` | `TrustRegistry`/`newADTrust()` déjà livrés |

Chaque phase suit le cycle rouge → vert → refactor. Aucune suite
existante (`windows-server-domain-join.test.ts`, `scenario-ad-trust-
relationships.test.ts`, `scenario-ad-fsmo-roles.test.ts`) ne doit
changer de comportement observable.

---

## 6. Stratégie de test

- **Test emblématique de P1/P2** : `netdom verify` réussit sur une
  machine fraîchement jointe ; après un `netdom reset` sur cette même
  machine, `netdom verify` réussit encore (secret resynchronisé des
  deux côtés) ; si le DC est injoignable pendant le `reset`, celui-ci
  échoue proprement et un `verify` suivant réussit toujours avec
  l'ancien secret (pas de corruption locale partielle).
- **Test emblématique de P4** : jonction → `netdom remove` → la machine
  n'apparaît plus dans `Get-ADComputer` du domaine, `whoami` ne montre
  plus de session de domaine, une seconde `netdom join` réussit sans
  message "already exists".
- **Test emblématique de P5** : renommage d'une machine jointe →
  `Get-ADComputer -Identity <NewName>` la trouve (SPN HOST/ mis à jour),
  `Get-ADComputer -Identity <OldName>` échoue, une résolution DNS de
  `<NewName>.<domaine>` réussit.
- **Test emblématique de P9** : réutilise le scénario `scenario-ad-
  trust-relationships.test.ts` déjà livré comme base — établir
  l'approbation, `netdom trust ... /Remove`, vérifier que `Get-ADTrust`
  ne la liste plus et qu'un `runas` inter-domaine qui réussissait avant
  échoue après.
- **Non-régression** : `windows-server-domain-join.test.ts`,
  `scenario-ad-trust-relationships.test.ts`, `scenario-ad-fsmo-roles.
  test.ts` passent sans modification après chaque phase ; la suite
  complète `src/__tests__/unit/network-v2/` est vérifiée après la
  dernière phase avant commit (méthode déjà établie dans ce dépôt).

### 6.1 Critères unitaires détaillés, par phase

1. **P1** : `netdom verify` sur une machine non jointe échoue avec un
   message honnête (pas de faux `NetSetupOk`) ; sur une machine jointe
   et joignable, réussit ; sur une machine jointe mais DC injoignable
   (câble débranché/port fermé), échoue avec un message de canal rompu,
   distinct du cas "jamais jointe".
2. **P2/P3** : le secret change effectivement (comparaison avant/après
   via une inspection directe de `DirectoryStore`, pas seulement via
   `verify`) ; un `bind` LDAP avec l'ANCIEN secret échoue après le
   reset ; `/UserO`/`/PasswordO` invalides font échouer l'opération sans
   toucher au secret existant.
3. **P4** : le compte ordinateur AD n'est plus listé par
   `Get-ADComputer` (retiré, pas juste désactivé — comportement assumé
   et documenté, cf. § 7) ; `domainMembership` local devient `null` ;
   `Test-ComputerSecureChannel` après `remove` échoue avec "not joined
   to a domain", pas une erreur de canal.
4. **P5** : `sAMAccountName`/`servicePrincipalName`/`dNSHostName` de
   l'objet AD reflètent le nouveau nom ; l'ancien enregistrement DNS A
   est retiré et un nouveau est créé au même IP ; `/Force` permet le
   renommage même si un binding SPN entrerait en conflit (documenté
   comme non modélisé plutôt que silencieusement ignoré si aucun
   conflit n'est possible dans ce simulateur).
5. **P6** : `/Enumerate` liste exactement le nom courant (un seul, cf.
   § 2.2) ; `/MakePrimary` produit le même effet observable qu'un
   `renamecomputer` direct (pas de divergence de comportement entre les
   deux commandes).
6. **P7** : `query pdc` retourne le même FQDN que `(Get-ADDomain).
   PDCEmulator` ; `query dc`/`dclist` retourne la même liste que
   `Get-ADDomainController -Filter *` ; `query ou` retourne la même
   liste que `Get-ADOrganizationalUnit -Filter *`.
7. **P8** : `netdom add` crée le compte ordinateur (visible par
   `Get-ADComputer`) sans que la machine courante devienne membre du
   domaine (`domainMembership` reste `null`/inchangé) ; une jonction
   ultérieure de la machine réellement destinataire réutilise ce compte
   pré-créé sans erreur "already exists".
8. **P9** : `/Remove` retire l'approbation des deux côtés quand le
   distant est joignable (comme la création, § 1.3), et au moins
   localement s'il ne l'est pas (documenté, pas silencieusement no-op) ;
   `/Reset` change l'`interrealmSecret` et un `runas` inter-domaine
   fonctionne toujours après (contrairement à un `/Remove`) ; `/Force`
   est accepté par le parseur d'arguments mais n'a explicitement aucun
   effet observable supplémentaire (§ 2.2).

---

## 7. Risques et points d'attention

- **Désynchronisation local/AD** : P2 (reset) et P5 (rename) touchent
  deux états qui doivent rester cohérents (`WindowsPC.domainMembership`
  local vs l'objet AD sur le DC) — le risque principal est un
  correctif qui met à jour un seul côté en cas d'échec partiel réseau
  (ex. le `ModifyRequest` réussit côté DC mais l'appelant ne met pas à
  jour son état local avant de retourner une erreur). Traiter chaque
  opération comme atomique du point de vue de l'appelant : soit les
  deux côtés changent, soit aucun.
- **`remove` : suppression ou désactivation ?** Un vrai AD **supprime**
  l'objet ordinateur sur `netdom remove` (contrairement à `Disable-
  ADAccount`) — ce PRD suit ce comportement réel (§ 6.1 point 3) plutôt
  que de le confondre avec une désactivation, décision à documenter
  explicitement dans le code comme le reste de ce dépôt le fait déjà
  pour ses simplifications assumées.
- **Tentation de dupliquer `join`/`trust` plutôt que de les
  symétriser** : `remove` doit être l'inverse exact de `join` (mêmes
  champs, direction inverse), `trust /Remove` l'inverse exact de
  `trust` (création) — le risque est d'écrire un chemin de suppression
  ad hoc qui laisse un état incohérent que `join`/`trust` (création)
  n'auraient pas produit.
- **`renamecomputer` et DNS** : ce dépôt gère déjà une zone DNS réelle
  par domaine (`AddDnsServerResourceRecordACmdlet`) — P5 doit
  effectivement retirer l'ancien enregistrement A et en créer un
  nouveau au lieu de laisser les deux coexister (un vrai admin
  verrait ça comme un bug de pollution DNS, pas une fidélité
  acceptable).
- **Cohérence avec les cmdlets PowerShell ajoutées en parallèle**
  (`Remove-Computer`, `Rename-Computer`, § 1.3 principe de double
  surface) : les deux surfaces (cmd et PowerShell) doivent appeler
  exactement les mêmes méthodes `DirectoryStore`/`WindowsPC` — un écart
  de comportement entre `netdom remove` et `Remove-Computer` serait une
  régression de cohérence interne, pas juste un oubli de couverture.

---

## 8. Critères d'acceptation

- `netdom verify <MachineName>` échoue honnêtement sur une machine non
  jointe ou dont le canal est rompu, réussit sur une machine jointe et
  joignable — aucun faux `NetSetupOk`.
- `netdom reset`/`resetpwd` changent réellement le secret machine des
  deux côtés (DC et local) ; un `bind` avec l'ancien secret échoue
  après coup.
- `netdom remove` retire le compte ordinateur AD et remet la machine en
  workgroup ; une jonction ultérieure fonctionne sans conflit.
  `Remove-Computer` (nouvelle cmdlet) produit exactement le même effet.
- `netdom renamecomputer` met à jour le nom local **et** l'objet AD
  (SPN, `dNSHostName`) **et** l'enregistrement DNS — pas seulement le
  nom local comme aujourd'hui. `Rename-Computer` (nouvelle cmdlet)
  produit exactement le même effet.
- `netdom query pdc`/`dc`/`dclist`/`ou` reflètent exactement les mêmes
  données que les cmdlets `Get-AD*` équivalentes déjà livrées — aucune
  divergence entre les deux surfaces.
- `netdom add` pré-crée un compte ordinateur consommable par une
  jonction ultérieure sans erreur de conflit.
- `netdom trust /Remove`/`/Reset` retirent/régénèrent réellement
  l'approbation ; le scénario `scenario-ad-trust-relationships.test.ts`
  existant reste vert, étendu avec les nouveaux cas `/Remove`/`/Reset`.
- La suite complète `src/__tests__/unit/network-v2/` passe sans
  régression après chaque phase, vérifiée phase par phase, avant tout
  commit (méthode déjà établie dans ce dépôt pour les PRD précédents).

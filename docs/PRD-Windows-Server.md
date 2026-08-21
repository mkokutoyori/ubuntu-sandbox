# PRD — Windows Server (rôles serveur, Active Directory, services réseau)

**Version** : 1.0
**Date** : 2026-07-04
**Projet** : Ubuntu Sandbox — Module Windows Server
**Auteur** : Claude Code
**Références produit/protocole** : Windows Server 2022 (Standard), AD DS, DNS Server, DHCP Server (RFC 2131/2132), serveur de fichiers SMB, NPS (RFC 2865 — cf. `PRD-RADIUS.md`), IIS (HTTP/1.1, RFC 9112), stratégies de groupe (GPO), WinRM/PS Remoting

---

## 0. Contexte et portée du document

Le type de device **`windows-server` existe déjà dans la palette**
(`deviceCatalog.ts` : préfixe `WinServer`, catégorie *Servers*, marqué
`fullyImplemented: true`) mais `DeviceFactory` l'instancie comme un simple
`WindowsPC` : **aucune différence fonctionnelle avec un poste client** — même
identité OS (« Microsoft Windows 10 Enterprise »), mêmes services, aucun rôle
serveur. Ce PRD définit ce qui fait d'un Windows Server un serveur :

1. une **identité Windows Server 2022** cohérente partout ;
2. un **modèle de rôles et fonctionnalités** (Server Manager /
   `Install-WindowsFeature`) qui conditionne services, commandes et modules
   PowerShell ;
3. les **rôles eux-mêmes** : serveur de fichiers (SMB réel sur le réseau
   simulé), AD DS (domaine, contrôleur, jonction de clients, comptes de
   domaine, GPO minimal), DNS Server, DHCP Server, NPS (RADIUS), Web (IIS).

Deux PRD frères sont des prérequis partiels : `docs/PRD-DNS.md` (moteur DNS
consommé par le rôle DNS Server) et `docs/PRD-RADIUS.md` (moteur RADIUS consommé
par le rôle NPS). Aucune ligne de code n'est écrite dans le cadre de ce document
— il sert de base à la planification et à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire (socle Windows partagé client/serveur)

| Zone | Fichiers clés | État |
|---|---|---|
| Device | `devices/WindowsPC.ts` (2 122 lignes), `DeviceFactory.ts` (`windows-server` → `new WindowsPC('windows-server', …)`), `deviceCatalog.ts` | Palette OK, classe indifférenciée |
| Interpréteur cmd | `windows/WinCommandExecutor.ts` + ~40 commandes dédiées (`WinDir`, `WinFileCommands`, `WinIpconfig`, `WinPing`, `WinTracert`, `WinPathping`, `WinRoute`, `WinArp`, `WinGetmac`, `WinNetsh`, `WinNetUser`, `WinNetShare`, `WinNetUse`, `WinNetStart`, `WinSc`, `WinTasklist`, `WinTaskkill`, `WinReg`, `WinWevtutil`, `WinIcacls`, `WinWhoami`, `WinSystemCommands` (systeminfo/ver/schtasks), `WinPrint`, `WinHelp`, `cmdline.ts`, `DoskeyTable`) | Riche, fidèle cmd.exe |
| PowerShell | `windows/PowerShellExecutor.ts` (~75 cmdlets), `PSPipeline`, `PSProcessCmdlets`, `PSServiceCmdlets`, `PSRegistryProvider`, `PSEventLogProvider`, `GetCounter`, + interpréteur complet `src/powershell/` (lexer/parser/runtime/providers/cmdlets) — cf. `BRD-PowerShell.md` | Pipeline objet réel |
| Services | `WindowsServiceManager.ts` (états, types de démarrage, dépendances avec arrêt en cascade, comptes, failure actions, compteur de crashs), `service/WindowsService.ts` | Solide |
| Processus | `WindowsProcessManager.ts`, `process/WindowsProcess.ts` | OK |
| Utilisateurs/sécurité | `WindowsUserManager.ts` (users/groupes/privilèges), `security/WindowsAccountsPolicy.ts`, `WindowsAuditPolicy.ts`, `WindowsSecurityAudit(+Projection)`, `WinIcacls` | **Local uniquement** (SAM) |
| Filesystem | `WindowsFileSystem.ts` (lecteurs, ACL NTFS, attributs, casse insensible), `network/WindowsLocalFs.ts` | OK |
| Registre | `PSRegistryProvider.ts` + `WinRegCommand.ts` (`ProductName` = « Windows 11 Pro ») | OK, identité client |
| Journal d'événements | `WindowsEventLogProjection.ts`, `PSEventLogProvider`, `WinWevtutil` | OK |
| Réseau | `WinIpconfig`, `WinNetsh` (int ip, advfirewall, **portproxy avec projection socket réelle** `PortProxyTable`/`PortProxySocketProjection`), `WinDnsCache`, `WinPathping`, clients SSH/SCP/SFTP (`network/WindowsSshClient/ScpClient/SftpClient`) | OK côté client |
| Remoting | `WindowsWinRmConfig.ts` (listeners, `winrm quickconfig`), remoting multi-machines PowerShell (cf. commit `5ada871f`), `WindowsShellSession` | Embryon |
| Partages | `WinNetShare` (table de partages, gated LanmanServer), `WinNetUse` (mappages de lecteurs, gated LanmanWorkstation) | **Tables locales en mémoire, aucun trafic réseau** |
| Tâches planifiées | `schtasks` (`WinSystemCommands`), gate service `Schedule` | OK |
| Feature gating | `WinFeatureGate.ts` — refus formatés à la cmd.exe quand un service prérequis est arrêté (Dhcp, Dnscache, mpssvc, EventLog, LanmanServer/Workstation, Schedule, Spooler) | **Pattern parfait à étendre aux rôles** |
| Tests | `unit/powershell/`, `debug/ps-*.debug.test.ts`, `debug/coherence-*.debug.test.ts` (538+ tests Windows) | Bonne base de non-régression |

### 1.2 Ce qui existe déjà et est réutilisable

- **Tout le socle client est le socle serveur** : cmd + PowerShell + services +
  processus + registre + journaux + FS + sécurité locale sont communs à un
  Windows 10 et à un Windows Server — rien à réécrire, tout à hériter.
- **`WinFeatureGate` est le mécanisme exact du gating de rôles** : « le service
  X n'est pas démarré » se généralise en « le rôle X n'est pas installé ».
- **L'identité matérielle/OS est déjà injectable** : `WinSystemContext.os`
  (`prettyName`, `version`) alimente `systeminfo` — il suffit d'injecter une
  identité serveur au lieu des chaînes en dur restantes.
- **La pile socket simulée existe** (`core/SocketTable.ts`,
  `core/TcpConnection.ts`, `WellKnownPorts.ts`) : le portproxy Windows projette
  déjà de vrais sockets d'écoute, et (`docs/PRD-Port-Forwarding.md` Phase 7)
  relaie réellement les octets entre `listenaddress:port` et
  `connectaddress:port` — SMB/445, LDAP/389, HTTP/80 suivront le même
  chemin.
- **Le moteur DHCP existe** (`src/network/dhcp/`, protocole complet avec
  options, cf. commit `4255396c`) : le rôle DHCP Server est une **façade
  Windows** au-dessus de cet engine, pas une réimplémentation.
- **Le moteur DNS arrive** (`PRD-DNS.md`) et le moteur RADIUS (`PRD-RADIUS.md`)
  définit le contrat d'hébergement du serveur — les rôles DNS et NPS sont des
  consommateurs.
- **`shellKind.ts` a déjà centralisé le dispatch** qui reposait sur
  `dev.constructor.name` — précédent utile pour introduire une sous-classe sans
  casser les vendor-checks (cf. risques §7).
- Les **suites debug de cohérence** (`coherence-*.debug.test.ts`) comparent
  cmd et PowerShell sur les mêmes sous-systèmes — à étendre aux rôles serveur.

### 1.3 Ce qui est non conforme ou manquant (gap analysis)

| # | Manque | Référence | Sévérité |
|---|---|---|---|
| 1 | **Identité OS en dur côté client** : `wmic os get caption` → « Microsoft Windows 10 Enterprise » (`WinSystemCommands.ts:355`, `WindowsPC.ts:1769`), registre `ProductName` = « Windows 11 Pro » (`PSRegistryProvider.ts:52`), `PowerShellExecutor.ts:280` → « Microsoft Windows 10.0.19041 » — un WinServer se présente partout comme un poste client, incohérent entre les quatre sources | systeminfo/wmic/registre réels | Bloquant |
| 2 | **Aucune différenciation de classe** : `DeviceFactory` retourne un `WindowsPC` identique pour `windows-pc` et `windows-server` ; pas de baseline serveur (services LanmanServer démarré par défaut, pagefile, rôle par défaut) | — | Bloquant |
| 3 | **Aucun modèle rôles/fonctionnalités** : pas de `Get-WindowsFeature`/`Install-WindowsFeature`/`Uninstall-WindowsFeature`, pas de notion d'arbre de features avec dépendances, pas de gating des modules PowerShell par rôle | Server Manager | Bloquant (fondation de tout le reste) |
| 4 | **`net share`/`net use` sont locaux** : tables en mémoire par hostname, **aucun octet SMB ne traverse le réseau simulé** — `net use Z: \\SRV1\data` depuis un autre PC « réussit » sans que SRV1 existe ; pas de `New-SmbShare`/`Get-SmbShare`/`Get-SmbSession`, pas de permissions de partage, pas d'accès aux fichiers distants | SMB | Élevée |
| 5 | **Pas d'AD DS** : pas de domaine, pas de promotion (`Install-ADDSForest`), pas de jonction (`Add-Computer`/`netdom join`), pas de comptes/groupes de domaine (`Get/New-ADUser`, `Get-ADGroup`), pas d'ouverture de session domaine, pas d'authentification des accès distants (SMB/WinRM) par le DC, pas de `dcdiag`/`nltest` | AD DS | Élevée |
| 6 | **Pas de rôle DNS Server** : `WinDnsCache` est un cache **client** ; pas de zones hébergées, pas de `dnscmd` ni module `DnsServer` (`Add-DnsServerResourceRecordA`…), pas d'enregistrement dynamique des clients du domaine | DNS Server | Élevée (dépend `PRD-DNS.md`) |
| 7 | **Pas de rôle DHCP Server** : l'engine réseau existe mais aucune façade Windows — pas de `netsh dhcp`, pas de module `DhcpServer` (`Add-DhcpServerv4Scope`…), pas d'étendues/réservations/options gérées depuis Windows | DHCP Server | Élevée |
| 8 | **Pas de NPS** : aucun moyen de faire de Windows Server le serveur RADIUS d'un lab 802.1X/AAA (le `RadiusServerAgent` n'est hébergeable que sur les routeurs) | NPS, `PRD-RADIUS.md` | Élevée |
| 9 | **Pas de rôle Web (IIS)** : pas de service W3SVC, pas de site écoutant sur TCP/80 via la pile socket, pas de `Get-Website`/`iisreset` ; un `curl`/`Invoke-WebRequest` depuis un client vers le serveur n'a rien à joindre | IIS | Moyenne |
| 10 | **Pas de GPO** : pas de stratégies de groupe, pas de `gpupdate`/`gpresult`, pas de Default Domain Policy (politique de mots de passe du domaine) — `WindowsAccountsPolicy` reste purement local | GPO | Moyenne |
| 11 | **WinRM/PS Remoting incomplet** : config listeners minimale ; pas de `Enter-PSSession`/`Invoke-Command -ComputerName` de bout en bout sur TCP/5985 simulé avec authentification (locale puis domaine) | WinRM | Moyenne |
| 12 | Pas d'outils d'administration serveur : `Get-ComputerInfo` incomplet, pas de `Server Manager` textuel (`servermanagercmd` étant obsolète, la surface = cmdlets), `dism /online /enable-feature` absent | — | Faible |
| 13 | Pas de serveur d'impression réseau (Spooler/`print` existent en local seulement) | Print Server | Faible |
| 14 | `EquipmentStateView` regroupe `windows-pc` et `windows-server` sous « Windows Host » — l'inspection ne montrera ni rôles ni domaine | debug tooling | Faible |

**Conclusion de la phase d'analyse** : le simulateur possède un **excellent
Windows client** (cmd + PowerShell + sous-systèmes fidèles) mais **aucun
Windows Server** : le device de la palette est cosmétique. Le chantier n'est
pas de réécrire Windows, mais (a) de donner une identité et une classe au
serveur, (b) de poser le modèle de rôles, puis (c) de brancher chaque rôle sur
les moteurs réseau existants ou planifiés (sockets, DHCP, DNS, RADIUS), avec le
serveur de fichiers SMB et AD DS comme seuls gros morceaux réellement nouveaux.

---

## 2. Objectifs

### 2.1 Objectifs (ce PRD)

1. **Classe et identité Windows Server** :
   - sous-classe `WindowsServer extends WindowsPC` (ou paramètre d'identité —
     décision d'implémentation, cf. risques §7) créée par `DeviceFactory` pour
     `windows-server` ;
   - identité **« Microsoft Windows Server 2022 Standard »** cohérente dans les
     **quatre sources aujourd'hui divergentes** : `systeminfo`, `wmic os get
     caption`, registre (`ProductName`, `InstallationType=Server`,
     `CurrentBuild=20348`), `Get-ComputerInfo`/`[environment]` PowerShell —
     et, sur le client, réconciliation Windows 10/11 de ces mêmes sources ;
   - baseline serveur : `LanmanServer` démarré par défaut, `ServerManager` au
     logon (message texte), profil pare-feu domaine.
2. **Modèle rôles & fonctionnalités (fondation)** :
   - arbre de features fidèle (sous-ensemble) : `FS-FileServer`, `AD-Domain-Services`,
     `DNS`, `DHCP`, `NPAS` (NPS), `Web-Server` (IIS), `Print-Services`, plus
     features outils (`RSAT-AD-PowerShell`, …) avec dépendances ;
   - cmdlets `Get-WindowsFeature` (colonnes Display Name/Name/Install State),
     `Install-WindowsFeature` (installe dépendances, enregistre les services du
     rôle dans `WindowsServiceManager`, active les modules PowerShell associés),
     `Uninstall-WindowsFeature` ;
   - **gating généralisé** : chaque commande/cmdlet de rôle refuse proprement si
     le rôle n'est pas installé (extension du pattern `WinFeatureGate`) ;
   - refus sur un Windows client : `Install-WindowsFeature` n'existe que sur
     Server (comme en vrai).
3. **Rôle serveur de fichiers (SMB réel)** :
   - service SMB écoutant sur **TCP/445 via `SocketTable`** ; le trafic
     `net use`/`copy \\srv\share\f` traverse réellement câbles et routeurs ;
   - partages : `net share`, `New-SmbShare`/`Get-SmbShare`/`Remove-SmbShare`,
     permissions de partage (Full/Change/Read) **composées avec les ACL NTFS**
     de `WindowsFileSystem` ;
   - client : `net use` (mappage de lecteur → FS distant monté dans le VFS),
     chemins UNC dans cmd (`dir \\srv\share`, `copy`) et PowerShell ;
   - sessions visibles : `Get-SmbSession`, `net session`, événements journal ;
   - authentification : comptes locaux du serveur (puis comptes de domaine
     après P5), `/user:` de `net use`.
4. **Rôle AD DS (contrôleur de domaine)** :
   - promotion : `Install-ADDSForest -DomainName lab.local` (+ variante
     `Install-ADDSDomainController` pour un DC supplémentaire **sans
     réplication** — second DC en lecture du même annuaire partagé) ; création
     de la base d'annuaire (utilisateurs/groupes/ordinateurs/OU), SYSVOL
     minimal, services `NTDS`, `Netlogon`, `Kdc` enregistrés ;
   - annuaire : `New/Get/Set/Remove-ADUser`, `New/Get-ADGroup`,
     `Add-ADGroupMember`, `Get-ADComputer`, `New-ADOrganizationalUnit`,
     recherche par `-Filter` simple ; `dsquery`/`net user /domain` en cmd ;
   - **jonction de domaine des clients** : `Add-Computer -DomainName` (et
     l'équivalent `netdom join`), création du compte ordinateur côté DC,
     dialogue réseau réel (localisation du DC via DNS SRV `_ldap._tcp.dc._msdcs`
     — dépend du rôle DNS, avec fallback par IP explicite) ;
   - **ouverture de session domaine** sur un client joint : `LAB\alice` ou
     `alice@lab.local`, vérifiée auprès du DC (protocole d'authentification
     simplifié type NTLM — Kerberos complet hors périmètre), `whoami` →
     `lab\alice`, groupes de domaine dans `whoami /groups` ;
   - authentification domaine des services : SMB (P3) et WinRM acceptent les
     comptes de domaine ; `nltest /dsgetdc:`, `dcdiag` (checks basiques),
     `klist` (tickets simulés) pour le diagnostic.
5. **Rôle DNS Server** (dépend `PRD-DNS.md`) :
   - héberge le moteur DNS (zones autoritaires) avec écoute UDP/TCP 53 ;
   - zone du domaine AD créée à la promotion (enregistrements SRV du DC, A des
     machines jointes — **mise à jour dynamique** à la jonction/bail DHCP) ;
   - administration : module `DnsServer` (`Add-DnsServerPrimaryZone`,
     `Add-DnsServerResourceRecordA/CName/Mx/Ptr`, `Get-DnsServerZone`,
     `Get-DnsServerResourceRecord`), `dnscmd` (formes usuelles), redirecteurs
     (`Set-DnsServerForwarder`) ;
   - les clients Windows/Linux du lab résolvent via ce serveur (nslookup/dig).
6. **Rôle DHCP Server** :
   - façade Windows au-dessus de l'engine `src/network/dhcp/` : étendues IPv4,
     plages d'exclusion, réservations par MAC, options (3, 6, 15, 51…),
     durée de bail ;
   - administration : module `DhcpServer` (`Add-DhcpServerv4Scope`,
     `Add-DhcpServerv4ExclusionRange`, `Add-DhcpServerv4Reservation`,
     `Set-DhcpServerv4OptionValue`, `Get-DhcpServerv4Lease`,
     `Get-DhcpServerv4Scope`) et `netsh dhcp server` (formes usuelles) ;
   - service `DHCPServer` gated par le rôle ; les baux servis aux clients du
     lab (Windows `ipconfig /renew`, Linux `dhclient`) sont visibles dans
     `Get-DhcpServerv4Lease` ; autorisation dans AD simulée (flag) quand un
     domaine existe.
   - **mise à jour DNS dynamique du bail** (`Set-DhcpServerv4DnsSetting`) :
     un bail accordé écrit le A dans la zone du domaine de l'étendue ET le
     **PTR** dans la zone inverse, la libération retire les deux. La règle
     est celle de la RFC 4702 §3.3 et non l'intitulé grossier de la case
     Microsoft (« A *et* PTR seulement si le client le demande ») : le
     drapeau **N** coupe tout, le drapeau **S** décide du **A seul**, et le
     **PTR reste le travail du serveur** — c'est même le réglage par défaut
     de Windows, où le client enregistre son A et le serveur son PTR,
     « parce que le propriétaire du nom est le client et le propriétaire de
     l'adresse est le serveur ». Un client sans option 81 n'est pris en
     charge que si `UpdateDnsRRForOlderClients` le demande. La zone inverse
     n'est pas créée : elle est cherchée par **suffixe** parmi les zones
     hébergées (donc `40.168.192.in-addr.arpa` comme `168.192.in-addr.arpa`
     conviennent), et son absence n'empêche ni le bail ni le A — c'est ce
     que fait un vrai serveur, dont la mise à jour échoue en journalisant.
   - **`NameProtection`** est un vrai **DHCID** (RFC 4701) : le condensé est
     un SHA-256 réel de l'identifiant du client suivi du nom en forme
     canonique de fil, écrit à côté du A, et un client dont le condensé
     diffère ne peut pas prendre le nom. Le type 49 traverse le codec DNS et
     se relit depuis un fichier de zone, sa forme de présentation étant le
     base64 de la RDATA entière.
7. **Rôle NPS (RADIUS)** (dépend `PRD-RADIUS.md`) :
   - héberge le `RadiusServerAgent` via le contrat `RadiusServerHost` ; service
     `IAS` gated par le rôle `NPAS` ;
   - clients RADIUS (NAS) déclarés avec secret partagé (`New-NpsRadiusClient`,
     `netsh nps add client`), export/config texte ;
   - politiques réseau simples : condition (groupe Windows/domaine de
     l'utilisateur) → accès accordé/refusé + attributs retournés (VLAN,
     Session-Timeout) — la base d'utilisateurs est **le SAM local ou l'AD**,
     pas une liste dédiée ;
   - journal NPS (accepts/rejects) dans le journal d'événements Sécurité,
     visible par `wevtutil`/`Get-WinEvent` ;
   - scénario cible : switch Cisco 802.1X → NPS sur Windows Server → VLAN
     dynamique (croise les critères d'acceptation du PRD RADIUS).
8. **Rôle Web (IIS) — minimal** :
   - service `W3SVC` + site « Default Web Site » écoutant sur TCP/80 via
     `SocketTable`, servant des fichiers depuis `C:\inetpub\wwwroot` (HTML/txt),
     réponses HTTP/1.1 correctes (200/404, en-têtes Server/Content-Type) ;
   - `Get-Website`, `New-Website` (chemin + port), `Stop/Start-Website`,
     `iisreset` ;
   - testable depuis un client Linux (`curl`) ou Windows
     (`Invoke-WebRequest`).
9. **GPO minimal** :
   - Default Domain Policy portant la **politique de mots de passe et de
     verrouillage du domaine**, appliquée aux membres à la place de la
     politique locale (`WindowsAccountsPolicy`) ;
   - un modèle de GPO simple (nom, liens OU/domaine, paramètres pris en charge :
     politique de comptes, script de démarrage, message légal au logon) ;
   - `gpupdate /force` (tire la policy du DC via le réseau), `gpresult /r`
     (RSoP texte), `Get-GPO`/`New-GPO`/`New-GPLink`.
10. **WinRM / PS Remoting réseau** :
    - `winrm quickconfig` ouvre un vrai listener TCP/5985 (`SocketTable`) ;
    - `Invoke-Command -ComputerName SRV1 -ScriptBlock {…}` et
      `Enter-PSSession` exécutent sur la machine distante via le réseau simulé,
      avec authentification locale ou domaine ; `Test-WSMan` ;
    - c'est la généralisation réseau du remoting multi-machines déjà amorcé.
11. **Inspection & UI** : `EquipmentStateView` expose l'identité serveur, les
    rôles installés, le domaine (DC ou membre) ; le panneau de propriétés UI
    affiche ces informations ; `topologySerializer` persiste rôles/domaine/
    partages/étendues pour la sauvegarde/restauration de topologies.

### 2.2 Non-objectifs (explicitement hors périmètre)

- **Réplication AD multi-DC réelle** (USN, KCC, sites) — un second DC partage
  l'annuaire par référence, sans protocole de réplication.
- **Kerberos complet** (tickets TGT/TGS chiffrés, délégation) — authentification
  domaine simplifiée ; `klist` n'affiche que des tickets simulés.
- **Forêts multiples, trusts, schéma extensible, LDAP filaire complet**
  (recherche LDAP par port 389 limitée à ce que la jonction exige).
- **Interface graphique Server Manager/MMC** — surface = CLI/PowerShell
  uniquement, conformément au simulateur.
- **RDP**, **clustering/failover**, **Hyper-V**, **WSUS**, **AD CS**
  (certificats), **DFS/DFSR**, **IIS avancé** (app pools .NET, HTTPS/TLS,
  modules), **imprimantes réseau complètes**, **activation/licences**.
- **NPS avancé** (NAP, modèles de stratégie complexes, comptabilité SQL).
- **freeradius/BIND côté Linux** — projets frères distincts.

---

## 3. Architecture cible

### 3.1 Principe directeur

**Hériter du client, ne dupliquer aucun sous-système.** `WindowsServer` est un
`WindowsPC` avec (a) une identité injectée différente, (b) un `RoleManager`, et
(c) des services/écouteurs réseau supplémentaires enregistrés dans les
gestionnaires **existants** (`WindowsServiceManager`, `SocketTable`, journal
d'événements). Chaque rôle est un module autonome qui se branche sur un moteur
de protocole existant (`dhcp/`, futur `dns/`, `radius/`) — le rôle n'implémente
que la **façade Windows** (cmdlets, netsh, services, journaux) et la
persistance de sa config.

### 3.2 Diagramme de couches

```
┌───────────────────────────────────────────────────────────────────────┐
│ Façades : cmdlets de rôle (ServerManager, SmbShare, ActiveDirectory,  │
│  DnsServer, DhcpServer, Nps, WebAdministration, GroupPolicy)          │
│  + commandes cmd (net share/use/session, dnscmd, netsh dhcp/nps,      │
│    netdom, nltest, dcdiag, gpupdate/gpresult, iisreset)               │
├───────────────────────────────────────────────────────────────────────┤
│ Rôles : FileServerRole · AdDsRole · DnsServerRole · DhcpServerRole    │
│         NpsRole · WebServerRole · (PrintServicesRole)                 │
│         RoleManager (arbre features, dépendances, gating)             │
├───────────────────────────────────────────────────────────────────────┤
│ Sous-systèmes Windows existants : ServiceManager, UserManager (+SAM), │
│  FileSystem (ACL NTFS), EventLog, Registry, AccountsPolicy, WinRM     │
├───────────────────────────────────────────────────────────────────────┤
│ Moteurs réseau : SocketTable/TcpConnection (SMB 445, LDAP-lite 389,   │
│  HTTP 80, WinRM 5985) · UDP (DNS 53, DHCP 67, RADIUS 1812/1813)       │
│  · src/network/dhcp/ · moteur DNS (PRD-DNS) · radius/ (PRD-RADIUS)    │
└───────────────────────────────────────────────────────────────────────┘
```

### 3.3 Modules proposés (arborescence)

```
src/network/devices/windows/server/
├── WindowsServerIdentity.ts      # chaînes OS Server 2022 (systeminfo, wmic, registre, PS)
├── RoleManager.ts                # arbre features, install/uninstall, dépendances, gating
├── featureCatalog.ts             # définitions des features (nom, displayName, services, module PS)
├── roles/
│   ├── FileServerRole.ts         # cycle de vie du rôle FS (listener 445, table de partages)
│   ├── AdDsRole.ts               # promotion, cycle de vie NTDS/Netlogon/Kdc
│   ├── DnsServerRole.ts          # zone hosting (moteur PRD-DNS), listener 53
│   ├── DhcpServerRole.ts         # façade sur src/network/dhcp/, listener 67
│   ├── NpsRole.ts                # héberge RadiusServerAgent, politiques réseau
│   └── WebServerRole.ts          # W3SVC, sites, listener 80
├── smb/
│   ├── SmbWire.ts                # PDU SMB simplifiés (NetworkPdu) : negotiate/session/tree/read/write
│   ├── SmbServer.ts              # sessions, partages ↔ WindowsFileSystem + ACL
│   └── SmbClient.ts              # côté client (net use, chemins UNC, copy)
├── ad/
│   ├── DirectoryStore.ts         # objets annuaire (users/groups/computers/OU), requêtes
│   ├── DomainController.ts       # protocole jonction/logon (PDU LDAP-lite/NetLogon-lite)
│   ├── DomainMembership.ts       # état côté membre (domaine, compte machine, DC connu)
│   └── GroupPolicy.ts            # GPO, Default Domain Policy, RSoP
└── cmdlets/ (ou extension de PowerShellExecutor)
    ├── ServerManagerCmdlets.ts   # Get/Install/Uninstall-WindowsFeature
    ├── SmbCmdlets.ts             # *-SmbShare, Get-SmbSession
    ├── AdCmdlets.ts              # *-ADUser/ADGroup/ADComputer/ADOrganizationalUnit
    ├── DnsServerCmdlets.ts       # *-DnsServer*
    ├── DhcpServerCmdlets.ts      # *-DhcpServerv4*
    ├── NpsCmdlets.ts / netsh nps # clients RADIUS, politiques
    ├── WebAdminCmdlets.ts        # *-Website, iisreset
    └── GroupPolicyCmdlets.ts     # Get/New-GPO, New-GPLink, gpupdate/gpresult
```

Commandes cmd nouvelles (`netdom`, `nltest`, `dcdiag`, `dnscmd`,
`netsh dhcp|nps`, `gpupdate`, `gpresult`, `net session`) : fichiers dédiés dans
`src/network/devices/windows/` suivant la convention `Win*.ts` existante.

### 3.4 Design patterns retenus

- **Rôle = plugin de device** : interface commune
  `ServerRole { featureName, install(ctx), uninstall(ctx), services: string[] }`
  enregistrée auprès du `RoleManager` — ajouter un rôle futur (Print, AD CS)
  ne touche ni la classe device ni les autres rôles.
- **Gating déclaratif** étendu de `WinFeatureGate` : une table
  `commande/cmdlet → feature requise` produit les refus exacts
  (« Le terme "Get-ADUser" n'est pas reconnu… » tant que RSAT-AD-PowerShell
  n'est pas installé, message d'erreur du module absent — fidèle au réel).
- **PDU objets sur le transport réel** (convention maison, comme RADIUS/DHCP) :
  SMB/LDAP-lite/HTTP sont des `NetworkPdu` typés portés par
  `TcpConnection`/UDP — pas d'encodage binaire SMB (non-objectif implicite,
  le protocole filaire SMB2 complet serait disproportionné).
- **Annuaire = source de vérité unique** : `WindowsUserManager` du DC délègue
  au `DirectoryStore` pour les comptes de domaine ; sur un membre, la
  résolution d'identité interroge d'abord le SAM local puis le domaine (ordre
  réel de Windows).
- **Réutilisation stricte des moteurs** : le rôle DHCP ne contient **aucune
  logique de bail** (tout dans `src/network/dhcp/`), le rôle DNS **aucune
  logique de résolution**, le rôle NPS **aucune logique RADIUS**.

---

## 4. Modèle de données

### 4.1 Feature / rôle

```
WindowsFeature { name: 'AD-Domain-Services'|…; displayName: string;
                 installState: 'Available'|'Installed'|'Removed';
                 dependsOn: string[]; services: string[]; psModule?: string }
```

### 4.2 Partage SMB

```
SmbShare { name; path; description?; sharePerms: Map<principal, 'Full'|'Change'|'Read'>;
           special?: boolean /* ADMIN$, C$, IPC$ */ }
SmbSession { clientIp; user; openedAt; opens: number }
```

### 4.3 Annuaire

```
AdObject = AdUser { sam, upn, dn, ou, enabled, passwordHash, memberOf[] }
         | AdGroup { sam, dn, scope, members[] }
         | AdComputer { name, dn, machineSecret }
         | AdOrgUnit { name, dn, gpLinks[] }
Domain { dnsName: 'lab.local'; netbios: 'LAB'; dcs: string[]; store: DirectoryStore;
         defaultDomainPolicy: Gpo }
DomainMembership (côté membre) { domain; computerAccount; knownDcIp }
```

### 4.4 GPO

```
Gpo { id; name; links: dn[]; settings: { accountPolicy?; logonBanner?; startupScript? } }
```

### 4.5 DHCP / DNS / NPS

Étendues, zones et politiques réutilisent les types des moteurs respectifs ;
le rôle n'ajoute que l'enveloppe de config Windows (nom d'étendue, état
activé/désactivé, autorisation AD) et la persistance topologie.

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — Identité & classe** | `WindowsServer` + `WindowsServerIdentity`, factory, réconciliation des 4 sources d'identité (client **et** serveur), `EquipmentStateView`, sérialisation | — |
| **P2 — Rôles (fondation)** | `RoleManager`, `featureCatalog`, `Get/Install/Uninstall-WindowsFeature`, gating généralisé, services de rôle dans `WindowsServiceManager` | P1 |
| **P3 — Serveur de fichiers** | `SmbWire/SmbServer/SmbClient` sur TCP/445, refonte `net share`/`net use` en réseau, cmdlets Smb*, UNC dans cmd/PS, compo permissions partage × NTFS | P2 |
| **P4 — WinRM réseau** | Listener 5985 réel, `Invoke-Command`/`Enter-PSSession` inter-machines, `Test-WSMan` | P2 |
| **P5 — AD DS cœur** | `DirectoryStore`, `Install-ADDSForest`, cmdlets AD, `net user /domain`, services NTDS/Netlogon/Kdc, SYSVOL | P2 |
| **P6 — Jonction & logon domaine** | `Add-Computer`/`netdom join` (dialogue réseau), comptes machine, logon `LAB\user` sur les membres, `whoami /groups`, auth domaine pour SMB (P3) et WinRM (P4), `nltest`/`dcdiag`/`klist` | P3, P4, P5 |
| **P7 — Rôle DNS Server** | Hosting du moteur DNS, zone AD + SRV à la promotion, DDNS à la jonction, module `DnsServer` + `dnscmd`, redirecteurs | P5, **PRD-DNS** |
| **P8 — Rôle DHCP Server** | Façade sur l'engine DHCP, module `DhcpServer` + `netsh dhcp`, baux visibles, autorisation AD | P2 (P5 pour l'autorisation) |
| **P9 — Rôle NPS** | Hébergement `RadiusServerAgent`, clients NAS, politiques (groupes SAM/AD → accept + attributs), journal Sécurité, scénario 802.1X→NPS→VLAN | P2, P5, **PRD-RADIUS P8** |
| **P10 — GPO minimal** | Default Domain Policy (politique de comptes du domaine), `gpupdate`/`gpresult`, cmdlets GPO | P6 |
| **P11 — Rôle Web (IIS)** | W3SVC, Default Web Site sur TCP/80, fichiers `C:\inetpub\wwwroot`, cmdlets Website, `iisreset`, test cross-OS avec `curl` | P2 |

Chaque phase suit le cycle rouge → vert → refactor. Les suites Windows
existantes (538+ tests, suites `ps-*` et `coherence-*`) doivent passer à
chaque phase — en particulier P1 qui touche des chaînes affichées par des
tests de sortie exacte.

---

## 6. Stratégie de test

1. **Unitaires par module** : `RoleManager` (dépendances, refus), `SmbServer`
   (permissions composées), `DirectoryStore` (requêtes, OU), GPO (RSoP).
2. **Sorties exactes** : `Get-WindowsFeature`, `systeminfo` serveur,
   `net share`, `gpresult /r` — comparées au format réel Windows Server 2022
   (mêmes exigences de fidélité que `BRD-PowerShell.md`).
3. **Intégration réseau multi-machines** : partage SMB monté à travers un
   routeur ; `Invoke-Command` inter-VLAN ; client DHCP Linux servi par le rôle
   DHCP Windows ; résolution DNS croisée Linux↔Windows.
4. **Scénario fil rouge « petit domaine »** (test d'intégration long) :
   promotion DC + DNS → jonction de 2 clients → logon domaine → GPO mots de
   passe appliquée → partage accessible par groupe de domaine → 802.1X via NPS.
5. **Transcripts debug** : nouvelles suites `debug/windows-server/`
   (`ad-ds.debug.test.ts`, `smb.debug.test.ts`, `roles.debug.test.ts`, …) sur
   le modèle des suites `cmdlets/` existantes, pour l'analyse d'écart de sortie.
6. **E2E Playwright** : glisser un Windows Server depuis la palette, installer
   un rôle au terminal, vérifier le panneau de propriétés.

---

## 7. Risques et points d'attention

1. **Dispatch sur `constructor.name`** : le build garde `keepNames` car des
   sites dispatchent sur le nom de classe (`CiscoShellBase.ts:1449`,
   `Nmap.ts:23`, historiquement centralisé dans `shell/shellKind.ts`). Une
   sous-classe `WindowsServer` ferait échouer tout test `=== 'WindowsPC'` —
   **auditer ces sites avant P1** et préférer les prédicats de `shellKind.ts`
   ou `instanceof`. Alternative de repli : rester sur `WindowsPC` paramétré par
   `deviceType` (déjà transmis au constructeur) sans sous-classe.
2. **Tests à sortie exacte** : P1 change des chaînes (`systeminfo`, wmic,
   registre) potentiellement assertées par les suites existantes — corriger
   les fixtures dans le même commit, pour le client comme pour le serveur.
3. **Scope creep AD** : AD DS peut engloutir le chantier. Le périmètre est
   verrouillé par §2.2 (pas de réplication, pas de Kerberos réel, LDAP-lite) ;
   toute extension passe par une révision de ce PRD.
4. **Dépendances croisées** : P7 dépend du moteur DNS (`PRD-DNS.md`) et P9 du
   contrat d'hébergement RADIUS (`PRD-RADIUS.md` P8). Si ces moteurs glissent,
   P8/P10/P11 peuvent être livrés avant P7/P9 — l'ordre des phases est
   partiellement commutable et le `RoleManager` n'a pas de dépendance dure.
5. **SMB et sémantique FS** : monter un FS distant dans le VFS local (lettres
   de lecteur, UNC) touche `WindowsFileSystem` et tous les consommateurs
   (`dir`, `copy`, providers PS) — passer par une abstraction de « volume
   distant » plutôt que de disséminer des cas spéciaux.
6. **Performance/état global** : les tables module-level type `WinNetUse.STORES`
   (keyed par hostname) fuient entre tests — la refonte P3 doit rapatrier cet
   état dans l'instance device, comme le reste du projet l'a fait
   (cf. journaux de refactoring).
7. **Persistance topologie** : rôles, domaine, partages, étendues et zones
   doivent survivre au save/load (`topologySerializer.ts`) — à intégrer phase
   par phase, pas à la fin.

---

## 8. Critères d'acceptation

1. Un device `windows-server` fraîchement posé affiche « Microsoft Windows
   Server 2022 Standard » de façon **cohérente** dans `systeminfo`, `wmic os
   get caption`, `reg query …\CurrentVersion /v ProductName` et
   `Get-ComputerInfo` ; un `windows-pc` reste un client cohérent.
2. `Install-WindowsFeature FS-FileServer` installe le rôle et ses services ;
   avant installation, `New-SmbShare` échoue avec le message de module/rôle
   absent ; `Get-WindowsFeature` reflète l'état avec le format réel.
3. Depuis un Windows PC séparé par un routeur : `net use Z: \\SRV1\data
   /user:SRV1\bob` monte le partage, `copy Z:\doc.txt C:\` fonctionne, un
   utilisateur sans permission de partage est refusé (erreur 5), la session
   apparaît dans `Get-SmbSession` sur SRV1 — et **rien ne fonctionne câble
   débranché**.
4. `Install-ADDSForest -DomainName lab.local` puis `Add-Computer` depuis un
   client : le compte ordinateur apparaît dans `Get-ADComputer`, le logon
   `LAB\alice` réussit sur le client, `whoami` → `lab\alice`.
5. Après P7 : `nslookup srv1.lab.local` depuis un client joint résout via le
   DC, et `Get-DnsServerResourceRecord -ZoneName lab.local` liste les SRV du
   DC et les A des membres.
6. Après P8 : un Linux PC en DHCP obtient un bail de l'étendue Windows, visible
   dans `Get-DhcpServerv4Lease`.
7. Après P9 : le scénario 802.1X du PRD RADIUS fonctionne avec **NPS comme
   serveur** : authentification d'un compte AD, VLAN retourné par la politique
   réseau, rejet journalisé dans le journal Sécurité.
8. Après P10 : `gpupdate /force` sur un membre applique la politique de mots
   de passe du domaine (un `net user x weak /add` local est refusé selon la
   policy du domaine), `gpresult /r` l'affiche.
9. Après P11 : `curl http://srv1.lab.local/` depuis un Linux PC renvoie la
   page par défaut IIS (HTTP/1.1 200, en-tête `Server: Microsoft-IIS/10.0`).
10. Toutes les suites Windows existantes passent sans modification de leurs
    assertions (hors fixtures d'identité OS corrigées en P1).

# Audit DRY — état des lieux à l'échelle du projet

Date : 2026-07-02 · Branche : `mandeng` · Périmètre : `src/` hors `__tests__` (1 547 fichiers, ~296 k lignes).
Aucune modification de code n'accompagne cet audit : chaque constat ci-dessous a été vérifié par recoupement
(grep des importeurs + lecture des corps de fonctions), pas seulement par outillage.

> Fiabilité de l'outillage : `knip` ne résout pas l'alias `@/` du projet et déclare « morts » des fichiers
> importés partout (ex. `src/events/index.ts`, 17 importeurs réels). Ses résultats bruts ne sont **pas**
> exploitables tels quels ; tout ce qui suit a été contre-vérifié manuellement.

---

## 1. Fonctions utilitaires réimplémentées à l'identique

Corps strictement identiques (copie conforme vérifiée), candidats à extraction immédiate :

| Fonction | Copies | Fichiers | Canonique proposée |
|---|---|---|---|
| `isValidIPv4` | 5 | `core/ip.ts` (canonique existante), `linux/commands/net/Ping.ts`, `linux/commands/net/Traceroute.ts`, `windows/WinPing.ts`, `windows/WinTracert.ts` | `@/network/core/ip` — les 4 copies locales réimplémentent ce que `core/ip.ts` exporte déjà |
| `hms` (durée → `hh:mm:ss`) | 4 | `shells/cisco/CiscoPimCommands.ts`, `CiscoVxlanCommands.ts`, `CiscoIgmpCommands.ts`, `shells/huawei/HuaweiVxlanCommands.ts` — corps identiques octet pour octet | utilitaire partagé `shells/format` |
| `makeKey(iface, group)` | 3 (+3 variantes) | `hsrp/types.ts`, `vrrp/types.ts`, `glbp/types.ts` — identiques (`` `${iface}\|${group}` ``) ; variantes distinctes dans `bfd/types.ts`, `NATEngine.ts`, `PSRegistryProvider.ts` | clé commune dans un module FHRP partagé (voir §3) |
| `neighborKey` | 3 | `lldp/types.ts`, `udld/types.ts`, `cdp/types.ts` | idem — famille « protocoles de découverte » |
| `unquote` | 5 | `linux/commands/net/Traceroute.ts`, `windows/WinTracert.ts`, `WinPing.ts`, `GetCounter.ts`, `WinNetsh.ts` | utilitaire d'argv partagé |
| `stripQuotes` | 5 | `WindowsTerminalSession.ts`, `CiscoEemNetflowArchiveCommands.ts`, `CrontabParser.ts`, `WinNetUser.ts`, `bash/runtime/Expansion.ts` | à examiner : 4/5 identiques, celle de `Expansion.ts` gère les échappements bash (à laisser) |
| `pad2` | 5 | `oracle/listener/ListenerControl.ts`, `CiscoSecurityCommands.ts`, `CiscoCommonShow.ts`, `HuaweiCommonDisplay.ts`, `linux/system/Iostat.ts` | utilitaire de formatage partagé |
| `pad` | 8 | `awk/AwkValue.ts`, `lastFormatter.ts`, `loginctlFormatter.ts`, `wFormatter.ts`, `whoFormatter.ts`, `Pidstat.ts`, `aaa/SshSessionRegistry.ts`, `nhrp/DmvpnService.ts` | idem (attention : signatures left/right pad divergentes, à harmoniser) |
| `fmtTimestamp` | 4 | `lastFormatter.ts`, `loginctlFormatter.ts`, `Mpstat.ts`, `Pidstat.ts` | formateur de dates partagé côté Linux |
| `globMatch` | 3 | `ssh/server/SshdServerConfig.ts`, `LinuxMachine.ts`, `bash/interpreter/BashInterpreter.ts` | à examiner : celle de bash supporte des classes de caractères, les 2 autres sont identiques entre elles |
| `classfulMask` | 3 | `CiscoConfigCommands.ts`, `HuaweiConfigCommands.ts`, `linux/commands/net/Ifconfig.ts` | `@/network/core/ip` |
| `firstConfiguredIp` | 3 | `linux/commands/net/Nc.ts`, `shell/sshLauncher.ts`, `shell/adapters/LinuxBashShell.ts` | helper sur `EndHost` |
| `formatPingOutput` | 3 | `LinuxFormatHelpers.ts`, `linux/commands/net/Ping.ts`, `windows/WinPing.ts` | ⚠ duplication *partielle* : sorties vendeur différentes (Linux vs Windows) — ne fusionner que la copie `LinuxFormatHelpers`/`Ping.ts` |

Cas volontairement écartés (fausse duplication au sens DRY — évolutions indépendantes) :
`helpText` (15×, un par commande simulée), `parseArgs` (7×, grammaires d'argv propres à chaque commande),
`tokenize` (6×, lexers de langages différents), `bytes` (14×, vues Oracle `v$*` générées sur le même gabarit
— une factorisation par gabarit de vue serait par contre pertinente côté `database/oracle/views/`).

## 2. Interfaces métier définies en double

| Interface | Définitions concurrentes | Constat |
|---|---|---|
| `TrackObject` | `devices/inspection/config/TrackRepository.ts` vs `devices/switch/TrackObjectRegistry.ts` | deux modèles du même objet de tracking IOS ; risque de divergence silencieuse |
| `VrrpGroup` | `devices/inspection/config/FhrpRepository.ts` vs `devices/router/redundancy/HuaweiVrrpService.ts` | même entité métier VRRP, champs qui se recouvrent |
| `VrrpTrackEntry` | `vrrp/types.ts` vs `HuaweiVrrpService.ts` | idem |
| `SuFrame` | `linux/shell/LinuxShellSession.ts` vs `shell/ShellContext.ts` | pile `su` modélisée deux fois de part et d'autre de la couche shell |
| `TracerouteHop`/`TracerouteProbe`, `PingResult` | `EndHost.ts` + copies côté commandes | le type résultat devrait vivre uniquement dans la couche hôte |
| `RouteEntry`, `SyslogHost`, `SnmpHost`, `SshdMatchBlock`, `TcpdumpOptions`, `RegistryValue`, `PortSpec`, `PortRef`, `JobResult` | 2 définitions chacune | à trancher au cas par cas (certains sont des homonymes de domaines différents, ex. `Token`/`Program`/`SourcePosition` bash vs powershell = légitime) |

## 3. Famille FHRP (HSRP / VRRP / GLBP) — duplication structurelle

Les trois protocoles dupliquent le même squelette : `types.ts` avec `makeKey` identique, paquet `extends NetworkPdu`,
runtime de groupe (`defaultGroupRuntime` ×3), machine à états prio/preempt très proche. Un socle commun
`network/fhrp/` (clé, runtime de groupe, timers hello/hold, élection) réduirait chaque module à sa sémantique propre
(champs de paquet, règles d'élection spécifiques). Même remarque, à plus petite échelle, pour le trio de découverte
CDP/LLDP/UDLD (`neighborKey`, tables de voisins).

## 4. Hiérarchie des paquets — état plutôt sain

Les PDU de protocole étendent bien la base commune `core/NetworkPdu.ts` (NetFlow, HSRP, GLBP, VRRP, Syslog, VXLAN,
UDLD, IGMP…). Exceptions relevées :

- `eigrp/packets.ts` : `EigrpHelloPacket`/`EigrpUpdatePacket` n'étendent ni `NetworkPdu` ni un header EIGRP commun ;
- `ospf/actors/OspfCaptureActor.ts` : `CapturedOspfPacket` est un enregistrement de capture, pas un PDU — acceptable,
  mais il fait doublon partiel avec `linux/network/PacketCaptureLog.ts#CapturedPacket` et
  `tcpdump/CaptureFrame.ts#CaptureFrame` : trois modèles de « trame capturée » coexistent.

## 5. Code mort identifié (vérifié : zéro importeur, symboles compris)

Fichiers supprimables sans impact (aucun import direct, aucun import de leurs symboles, hors alias et chemins relatifs) :

- `src/components/NavLink.tsx`
- `src/database/engine/types/SQLDialect.ts`
- `src/network/devices/shells/cisco/CiscoSharedCommands.ts`
- `src/network/devices/shells/IShellContext.ts`
- `src/terminal/sql/oracle/sqlplus.ts` (re-export de compatibilité vers `SQLPlusSession`, plus aucun appelant)
- `src/terminal/subshells/rman/commands/DataRecoveryAdvisorCommand.ts`
- Barrels `index.ts` sans aucun importeur : `network/core`, `network/core/ports`, `network/devices`,
  `network/dhcp`, `network/equipment`, `network/ospf`, `network/protocols/ssh`, `store`, `terminal/core`,
  `terminal/flows`, `database/oracle/security` (+ `audit`), `devices/linux/iam/policy`, `devices/shells`
  (`network/hardware/index.ts` et `events/index.ts` sont, eux, réellement utilisés — à conserver)

Non concluants — ne pas toucher sans décision explicite : `scripts/diagnostic*` et `scripts/ps-diagnostic.ts`
(points d'entrée manuels, invisibles pour l'analyse statique) ; `src/components/ui/*` (shadcn — faux positifs
knip probables, chaque composant doit être vérifié individuellement avant suppression).

## 6. Ordre d'exécution recommandé (valeur / risque)

1. **Sans risque** : suppression des fichiers morts du §5 (liste vérifiée) + `isValidIPv4`/`classfulMask` vers `core/ip.ts`.
2. **Faible risque** : `hms`, `pad2`, `pad`, `fmtTimestamp`, `unquote` → utilitaires de formatage partagés ; suite de tests existante comme filet.
3. **Moyen** : fusion des interfaces métier dupliquées du §2 (une par une, tests à l'appui).
4. **Structurel** (chantier dédié) : socle FHRP commun (§3), unification des trois modèles de capture (§4),
   gabarit commun pour les vues Oracle `v$*`.

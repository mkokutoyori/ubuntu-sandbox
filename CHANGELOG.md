# Changelog

## Huawei switch + routeur — vague batch 9 de 40 commandes (switch : 10 display leaves + 3 STP interface-view sous-composites + 2 STP system-view + 2 mac-address sous-composites + 6 system-view leaves + reset user-view ; routeur : 5 interface-view leaves ospf/isis/rip/bfd/vrrp + AAA RADIUS/HWTACACS templates push-modes + 4 leaves radius-server-view)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Neuvième vague batch-générée. **2 nouveaux modes CLI côté routeur** :
`radius-server-view` (parent aaa-view, `[host-radius-<name>]`,
`clearOnExit selectedRadiusTemplate`) et `hwtacacs-server-view`
(parent aaa-view, `[host-hwtacacs-<name>]`,
`clearOnExit selectedHwtacacsTemplate`). Conversion de la commande
leaf `HuaweiRouterAaaHwtacacsServerCommand` en composite pour
héberger la sous-commande push `template`. **+3 tests verts** sur
les suites Huawei ciblées (204 → 201 failed).

- **Switch display (10 nouveaux leaves dans displaySub)** : `device`,
  `cpu-usage`, `memory-usage`, `port-security`, `eth-trunk`, `arp`,
  `ip-routing-table`, `dhcp-snooping`, `igmp-snooping`, `users`.
- **Switch STP interface-view (3 sous-composites)** : `stp priority
  <n>`, `stp cost <n>`, `stp bpdu-filter {enable|disable}` — ajoutés
  au sous-registre de `HuaweiSwitchIfStpCommand`. `edged-port` déjà
  registered (batch antérieure).
- **Switch STP system-view (1 sous-composite)** : `stp
  bpdu-protection` — ajouté au sous-registre de
  `HuaweiSwitchSysStpCommand`. `stp root` skippé (déjà exposé sous
  `HuaweiSwitchStpRootCommand` du même composite).
- **Switch mac-address system-view (2 sous-composites)** :
  `mac-address static <mac> <iface> vlan <id>`, `mac-address
  blackhole <mac> vlan <id>` — ajoutés au sous-registre de
  `HuaweiSwitchSysMacAddressCommand`.
- **Switch system-view (6 nouveaux leaves)** : `link-aggregation
  {mode|load-balance}`, `observe-port <n> interface <iface>`,
  `port-group <name>`, `user-vlan {voice|guest|principal|
  subordinate}`, `lldp report {enable|management-address}`, `poe
  {enable|power|priority}`.
- **Switch user-view (1 leaf)** : `reset {counters|
  saved-configuration|mac-address|arp} …`.
- **Routeur interface-view (5 leaves)** : `ospf {enable|cost|timer|
  authentication-mode|network-type}` (première brique OSPF-on-interface,
  hors ospf-view), `isis {enable|circuit-level|silent}`,
  `rip {authentication-mode|split-horizon|version}`, `bfd {enable|
  min-tx-interval|min-rx-interval|detect-multiplier}` (nom effectif
  `bfd-if` dans le spec mais name `bfd` dans le descriptor), `vrrp
  vrid <n> {virtual-ip|priority|preempt-mode|authentication}`.
- **Routeur AAA (2 push-modes + 4 leaves radius)** :
  - `radius-server template <name>` (push vers `radius-server-view`,
    ajouté au sous-registre du composite `RadiusServer` existant).
  - `hwtacacs-server template <name>` (push vers
    `hwtacacs-server-view`, conversion de `HwtacacsServer` de leaf
    → composite avec ce push comme unique enfant).
  - En `radius-server-view` : `authentication-server <A.B.C.D>
    [<port>]`, `accounting-server <A.B.C.D> [<port>]`, `shared-key
    {cipher|simple} <key>`, `retransmit <n>`.
  - En `hwtacacs-server-view` : registry vide (transitions
    `quit`/`return` uniquement) — l'infra est en place pour de
    futures leaves.
- **Nettoyage** : sous-répertoire `aaa-view/local-user/` retiré
  (password/service-type/privilege/level générés en tant que leaves
  top-level en aaa-view — noms `password`/`service-type`/etc. ne sont
  pas des premiers tokens VRP valides ; VRP les emploie en suffixe :
  `local-user <name> password …`). Le leaf existant
  `HuaweiRouterAaaLocalUserCommand` (variadic) reste seul et couvre
  toutes ces variantes.
- **Preuve exécutable** :
  - `npx tsc --noEmit` propre.
  - Suite command-kernel : **354/354 verte**.
  - Suites Huawei ciblées : **201 failed / 216 passed** (avant vague :
    204/213 → **+3 tests verts** grâce à `ospf enable`/`isis`/
    `authentication-server`/`shared-key`/etc. maintenant reconnus).

## Huawei switch + routeur — vague batch 8 de 40 commandes (switch : storm/mac-limit/port-isolate/loopback-detect/bpdu/traffic-filter/traffic-secure/arp-limit/arp-detect en interface-view, voice-vlan/super-vlan/mux-vlan/arp-security/dhcp/vlan-batch/dtp/gvrp/vtp/cdp/udld/user-interface/aaa/info-center/snmp-agent/ntp-service/acl en system-view, clock/reboot/startup en user-view ; routeur : nqa/track/bfd/dot1x/cdp/lldp/assign/firewall/device-name en system-view, arp-broadcast en interface-view)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Huitième vague batch-générée. Focalisée sur les commandes **switch**
peu couvertes jusqu'ici (30/40 des commandes ciblent le switch, 10/40
le routeur). Aucun commentaire. **Nouveau mode CLI `aaa-view` côté
switch** (parent system-view, vide pour l'instant — l'infra est en
place pour de futures leaves radius/hwtacacs côté switch).

- **Switch interface-view (8 leaves)** : `mac-limit maximum <n>
  [action <a>] [alarm <b>]`, `port-isolate {enable|group <n>|mode
  {all|l2}}`, `loopback-detect`, `bpdu {enable|filter}`,
  `traffic-filter {inbound|outbound} acl <n>`, `traffic-secure
  {inbound|outbound} acl <n>`, `arp-limit maximum <n> [vlan <id>]`,
  `arp-detect {enable|mode …}`.
- **Switch system-view (17 leaves + 1 push-mode)** : `voice-vlan`,
  `super-vlan {enable|arp-proxy}`, `mux-vlan {enable|principal|
  subordinate}`, `arp {learning|anti-attack} {enable|disable}`,
  `dhcp {enable|snooping …}`, `vlan batch <start> [<end>]`,
  `dtp {enable|mode}`, `gvrp {enable|disable}`, `vtp {mode|domain|
  password}`, `cdp {enable|run}`, `udld {enable|aggressive}`,
  `user-interface {console|vty|aux} <range>`, `info-center {enable|
  loghost|source}`, `snmp-agent {enable|community|sys-info|
  trap-source}`, `ntp-service {enable|unicast-server|
  authentication-keyid}`, `acl {name|number} <id>`, et push-mode
  `aaa` → nouveau mode `aaa-view` (registry vide, transitions
  `quit`/`return` seules pour l'instant).
- **Switch user-view (3 leaves)** : `clock datetime HH:MM:SS
  YYYY-MM-DD`, `reboot [fast]`, `startup {saved-configuration|
  system-software}`.
- **Routeur system-view (9 leaves)** : `nqa test-instance <admin>
  <test>`, `track <id> {interface|nqa|route}`, `bfd {bind|
  discriminator|min-tx-interval}`, `dot1x {enable|
  authentication-method}`, `cdp {enable|run}`, `lldp enable
  [tx-interval <n>]`, `assign {forward-mode|resource-mode}`,
  `firewall {enable|packet-filter|zone}`, `device-name <name>`.
- **Routeur interface-view (1 leaf)** : `arp-broadcast {enable|
  disable}`.

- **Correctif d'un test de fondation** : `switch-cli-foundation.test.ts`
  utilisait `ntp-service unicast-server 1.1.1.1` comme exemple de
  commande NON migrée pour prouver que le pipeline kernel rejette
  bien l'inconnu. `ntp-service` étant maintenant migré (batch 8), le
  test a été mis à jour pour utiliser un identifiant garanti inconnu
  (`nonexistent-command-xyz foo bar`) — même intention, même regex
  de matching, exemple stable dans le temps.
- **Nettoyage** : 1 fichier retiré (`HuaweiSwitchIfPortSecMainCommand`
  sous `interface-view/port-security/`) — collisionne avec
  `HuaweiSwitchIfPortSecurityCommand` déjà registered en
  interface-view.
- **Preuve exécutable** :
  - `npx tsc --noEmit` propre.
  - Suite command-kernel : **354/354 verte** (1 test corrigé pour
    refléter l'expansion du kernel).
  - Suites Huawei ciblées : **204 failed / 213 passed** (inchangé
    vs batch 7 — zéro nouvelle régression).

## Linux — Wave 6 : `passwd`/`chpasswd`/`usermod`/`userdel`/`deluser`/`groupadd`/`groupmod`/`groupdel`/`gpasswd`/`lsof`/`ausearch`/`aureport`/`auditctl`/`mount`/`umount`/`findmnt`/`crontab`/`atq`/`atrm`/`runlevel`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Sixième vague de migration côté **Linux** : 20 commandes supplémentaires
(gestion de comptes/groupes POSIX, `lsof`, journal d'audit, table de
montage, `crontab`, file `at`, `runlevel`), scaffoldées en un seul appel
`generate_command.py batch` avant toute implémentation, comme les vagues
précédentes. `fuser` a été écarté de la liste initiale : aucune
implémentation legacy n'existe pour lui (juste listé dans
`KNOWN_LINUX_COMMANDS`), l'écrire aurait été une commande neuve, pas une
migration — remplacé par `runlevel`, qui a un vrai moteur legacy
(`cmdRunlevel`) et ne demande aucun nouveau branchement de capacité.

- **`command-kernel/machine/types.ts`** (extensions additives) :
  - `UserManagementApi` : `posixUsermod`/`posixUserdel`/
    `posixChangePassword`/`posixExpirePassword`/`posixDeletePassword`/
    `posixAccountStatus` (état brut pour `passwd -S`, formatage laissé à
    la commande).
  - `GroupManagementApi` : `posixGroupmod`/`posixGroupdel`/`posixGpasswd`/
    `posixRemoveMember` (forme secondaire `deluser USER GROUP`).
  - 4 nouvelles capacités optionnelles sur `MachineApi` : `AuditJournalApi`
    (`ausearch`/`aureport`/`auditctl`), `MountManagementApi`
    (`mount`/`umount`/`findmnt`), `CronTabApi` (`crontab`), `AtJobsApi`
    (`atq`/`atrm`).
  - `ProcessEntry.cwd` et `NetstatSocketView.id` (nouveaux champs optionnels,
    nécessaires à `lsof` pour reconstruire les colonnes FD/NODE/NAME).

- **`LinuxUserManager.ts`** : nouvelle méthode `removeUserFromGroup`
  (extraite du couple `handleDeluser`/`handleGpasswd -d` de l'exécuteur —
  retire l'appartenance seule, sans toucher au compte).

- **Visibilité additive, zéro changement de comportement** :
  `LinuxCommandExecutor.handleFindmnt` passe de `private` à public ;
  nouvel accesseur `getAtQueue()` (même motif que `getSocketTable()`).

- **20 nouvelles commandes** (`src/network/devices/linux/command-kernel/commands/`) :
  - **`Passwd.ts`** — réimplémentation fidèle du dispatch `cmdPasswd`
    (`-S`/`-l`/`-u`/`-e`/`-d`/`-n`/`-x`/`-w`), y compris la règle de
    privilège déclarative legacy (`passwd USER` par un non-root est
    refusé, même pour son propre nom) et le stub de la forme nue
    (`"passwd: password updated successfully"`, la modification réelle
    restant pilotée par le flux interactif du terminal).
  - **`Chpasswd.ts`** — lit `username:password` sur stdin, toujours
    silencieux (comme `cmdChpasswd`).
  - **`Usermod.ts`/`Userdel.ts`/`Deluser.ts`/`Groupadd.ts`/`Groupmod.ts`/
    `Groupdel.ts`** — délèguent aux méthodes `LinuxUserManager`
    correspondantes (messages vendeur exacts déjà produits par le moteur) ;
    `Deluser.ts` porte aussi la forme secondaire `deluser USER GROUP`
    (retrait de groupe seul, sans supprimer le compte).
  - **`Gpasswd.ts`** — délègue à `LinuxUserManager.gpasswd`, avec une
    reproduction inline du cas `-d` de l'exécuteur legacy
    (`handleGpasswd`, distinct de `cmdGpasswd`) : contrairement à `-A`/
    `-M`, `-d` imprime une ligne de confirmation
    (`"Removing user X from group Y"`) que le moteur `gpasswd()` seul ne
    produit pas — reproduit fidèlement plutôt que silencieusement
    perdu.
  - **`Lsof.ts`** — reconstruit la table à l'identique de `cmdLsof` (une
    ligne `cwd` par processus, une ligne par socket, mêmes filtres
    `-p`/`-u`/`-i` et même mise en forme colonnes).
  - **`Ausearch.ts`/`Aureport.ts`/`Auditctl.ts`** — délèguent aux
    fonctions pures déjà découplées (`cmdAusearch`/`cmdAureport`) ou à
    `handleAuditctl` (déjà public). Privilège vérifié inline (message
    vendeur exact `"<commande>: Permission denied"`) plutôt que via la
    politique `ROOT` générique — voir le correctif ci-dessous.
  - **`Mount.ts`/`Umount.ts`/`Findmnt.ts`** — délèguent à
    `handleMount`/`handleUmount`/`handleFindmnt` (rendu public), contre la
    vraie `MountTable`. `mount` conserve l'exemption de listing
    (`mount`/`mount -l` sans privilège) ; `umount` l'exige toujours.
  - **`Crontab.ts`** — délègue à `handleCrontab` (déjà public, porte lui
    même `cron.allow`/`cron.deny` et la résolution d'utilisateur cible) ;
    `-u AUTRE_UTILISATEUR` par un non-root est refusé inline (règle vivant
    dans la couche déclarative legacy, pas dans `handleCrontab`).
  - **`Atq.ts`/`Atrm.ts`** — délèguent à `cmdAtq`/`cmdAtrm` (fonctions
    pures) contre la vraie `LinuxAtQueue`.
  - **`Runlevel.ts`** — délègue à `cmdRunlevel(machine.netstat.isServer())`.

- **Correctif découvert pendant la régression** :
  `LinuxMachine.runCommandKernelResolved` (le pont utilisé quand une
  commande du kernel est invoquée depuis *l'intérieur* d'un script bash —
  boucle, fonction, ou `su USER -c "commande"`) ne rattrapait aucune
  exception : une commande refusée par sa `PrivilegePolicy` (`PermissionError`,
  sous-classe de `ShellError`) remontait donc telle quelle jusqu'à
  l'interpréteur bash, qui l'avalait silencieusement (sortie vide, pas de
  message). Ce chemin n'avait jamais été exercé par un test avant cette
  vague : `ausearch`/`aureport`/`auditctl`/`crontab` sont les premières
  commandes migrées à porter des tests legacy `su user -c "..."` sur un
  refus de privilège (`auditctl.test.ts`, `auditctl-other.test.ts`,
  `cron-integration.test.ts`). Corrigé en reproduisant dans
  `runCommandKernelResolved` le même `catch` que `tryCommandKernel` :
  `CommandNotFoundError` → repli legacy (`null`), `ShellError` → message
  converti en sortie + code 1.

- **Tests** : nouvelle suite `linux-command-kernel-wave6.test.ts` (26 tests,
  fixtures adossées à un vrai `LinuxCommandExecutor` plutôt qu'à des
  doublures — mêmes `MountTable`/`LinuxAuditLog`/`LinuxAtQueue`/
  `LinuxUserManager` réels que la production, comme câblés dans
  `LinuxMachine.createLinuxHostShell`). Régression ciblée (IAM, cron,
  audit, mount, sudo/su) : 15 fichiers / 564 tests, 0 échec. `tsc`/`eslint`
  sans nouvelle erreur (baseline pré-existante inchangée, 59 lignes).

## Huawei routeur — vague batch 7 de 40 commandes (display cpu/memory/device/power/temperature/fan/buffer, interface tunnel-protocol/source/destination/mac-address/qos/arp-detect/arp-limit, system multicast/pim/cluster/stack/bridge/port-mirroring, user-view fs cmds arp-ping/delete/mkdir/rmdir/copy/rename/dir/more/cd/pwd)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Septième vague batch-générée (`scripts/generate_command.py batch`) —
40 nouvelles commandes reparties en 4 groupes : status hardware
(display cpu-usage/memory-usage/device/power/temperature/fan/buffer),
tunneling + QoS interface (7 leaves), configuration système avancée
(multicast/pim/cluster/stack/bridge/port-mirroring), et filesystem
user-view (10 verbes équivalents Unix). Aucun commentaire. Zéro
régression sur les suites Huawei ciblées (204 failed / 213 passed
inchangés vs batch 6).

- **7 display hardware** dans le sous-registre `display` :
  `cpu-usage`, `memory-usage`, `device [manufacture-info]`, `power`,
  `temperature all`, `fan`, `buffer`.
- **7 leaves interface-view** : `tunnel-protocol {gre|ipsec|ipv4-ipv4|
  ipv6-ipv6|null}`, `source {ip|iface}`, `destination <ip>`,
  `mac-address <H-H-H>`, `qos {car|lr|priority} {inbound|outbound} …`,
  `arp-detect {enable|mode …}`, `arp-limit maximum <n> [vlan <id>]`.
- **6 leaves system-view avancées** : `multicast {routing-enable|
  policy|boundary}`, `pim {dm|sm} …`, `cluster {enable|ip-pool|name}`,
  `stack {enable|member <n>|priority <p>}`, `bridge <id> …`,
  `port-mirroring {group|observe-port} …`.
- **10 verbes user-view (filesystem/ops)** : `arp-ping ip <ip>
  [interface <iface>]`, `delete [/force] <file>`, `mkdir <dir>`,
  `rmdir <dir>`, `copy <src> <dst>`, `rename <old> <new>`, `dir
  [<path>]`, `more <file>`, `cd <dir>`, `pwd`.
- **Nettoyage** : 10 fichiers générés retirés du disque après
  découverte que leur `name` (route-policy/description/allow-as-loop/
  connect-interface/ebgp-max-hop/password/ip-domain/usm-user/location/
  contact) ne correspond pas à un premier token VRP valide (VRP les
  emploie systématiquement en suffixe : `peer <ip> route-policy X
  import`, `snmp-agent sys-info location <text>`, etc.). Un futur
  refactor de `peer` et `sys-info` en composites libérera ces
  sous-commandes.
- **Preuve exécutable** :
  - `npx tsc --noEmit` propre.
  - Suite command-kernel : **354/354 verte** (inchangé).
  - Suites Huawei ciblées : **204 failed / 213 passed** (inchangé
    vs batch 6 — zéro nouvelle régression, zéro nouveau vert car ces
    commandes n'apparaissent pas dans les cas de test actuels).

## Huawei routeur — vague batch 6 de 40 commandes (BGP peer/router-id/default, OSPF silent-interface/bandwidth-reference/lsdb/routing, IPsec policy view + application, DHCP snooping, HTTP server, SNMP target-host/trap/group, telnet/tracert/terminal/reset, route-policy apply cost/local-pref/community/as-path, loopback-detect, voice-vlan, sftp/ftp/user-interface)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Sixième vague batch-générée (`scripts/generate_command.py batch`) —
40 nouvelles commandes + 1 nouveau mode (`ipsec-policy-view`) +
enrichissement de 3 composites existants (`system-view/Ipsec`,
`system-view/SnmpAgent`, `display/Ospf`). Aucun commentaire dans le
code (règle utilisateur). Progression réelle sur les suites Huawei
ciblées : 208 → **204 failed**, 209 → **213 passed** (+4 verts) —
premières commandes qui n'étaient plus reconnues (BGP router-id,
http server, snmp-agent group, telnet/tracert) sont maintenant
acceptées par le kernel.

- **Nouveau mode CLI** `ipsec-policy-view` (prompt `[host-ipsec-policy-<name>]`,
  parent `system-view`, `clearOnExit: ['selectedIpsecPolicy']`). Le
  push est réalisé par `HuaweiRouterSysIpsecPolicyPushCommand` (nom
  `policy`), enregistré comme sous-commande du composite existant
  `system-view/Ipsec` — la ligne exacte VRP `ipsec policy <name>
  <seqno> {isakmp|manual}` déclenche donc la transition via
  `ipsec` → `policy` → push mode.

- **BGP (`bgp-view`)** : `router-id <A.B.C.D>`, `default
  {local-preference|med} <n>`. Les variations `peer <ip> as-number
  <n>` / `reflect-client` / `next-hop-local` sont déjà couvertes par
  le leaf variadique `HuaweiRouterBgpPeerCommand` — pas de duplicats
  créés (les 3 fichiers correspondants ont été retirés du batch pour
  éviter la collision de nom).

- **OSPF (`ospf-view`)** : `silent-interface <iface>`,
  `bandwidth-reference <n>`. Enrichissement du composite
  `display/Ospf.ts` avec `display ospf lsdb [<type>]` et
  `display ospf routing`.

- **IPsec policy view (`ipsec-policy-view`)** : 4 clauses feuilles —
  `proposal <name>`, `security acl <acl>`, `ike-peer <name>`,
  `local-address <A.B.C.D>`. Application interface : `ipsec policy
  <name>` en `interface-view`.

- **DHCP snooping** : `dhcp snooping enable [vlan <id>]` en
  `system-view`, `dhcp snooping trusted` en `interface-view`.

- **HTTP(S) server** : nouveau composite `system-view/http` avec
  `http server {enable|disable}`, `http secure-server {enable|disable}`,
  `http server-port <n>`, `http timeout <n>`.

- **SNMP-agent (composite enrichi)** : `snmp-agent target-host
  trap-hostname <ip> params …`, `snmp-agent trap enable [feature-name
  <f>]`, `snmp-agent group v3 <name> {noauth|auth|privacy} …`. En
  passant les leaves existants `snmp-agent community` et `snmp-agent
  sys-info` (importés mais jamais enregistrés dans le sous-registre
  du composite) sont désormais correctement câblés — bug latent
  corrigé.

- **User-view utilitaires** : `telnet <host> [<port>]`, `tracert
  <host>`, `terminal {monitor|logging} …`, `reset {saved-configuration
  |arp {dynamic|static}|counters|session …}`.

- **Route-policy view (`apply` clauses)** : `apply cost <n>`, `apply
  local-preference <n>`, `apply community <values...>`, `apply as-path
  <asn...> {additive|overwrite}`.

- **Interface** : `loopback-detect {enable|action shutdown|packet
  vlan …}`.

- **System-view (divers)** : `voice-vlan {enable|mac-address …}`,
  `sftp {server enable|ipv4|ipv6} …`, `ftp {server enable|ipv6 …}`,
  `user-interface {console|vty|aux} <range>`.

- **Comportement no-op documenté** : 30 leaves passés du `TODO` vers
  `return EXIT_OK;` via `noop.py` (comportement silencieux, sémantique
  métier à câbler quand un test d'intégration l'exigera). Le 1
  push-mode reçoit son `prepare()` via `push_stub.py` puis renommé
  `policy` pour intégration au composite existant `ipsec`.

- **Fix quirk générateur** : `type: 'number'` (dans le spec JSON)
  n'est pas valide côté script — les 5 spécifications concernées ont
  été converties en `type: 'int'` (valeurs acceptées : `boolean`,
  `float`, `int`, `path`, `string`).

- **Preuve exécutable** :
  - `npx tsc --noEmit` propre.
  - Suite command-kernel : **354/354 verte** (inchangé).
  - Suites Huawei ciblées (7 fichiers, 417 tests) :
    - avant vague 6 : 208 failed / 209 passed
    - après vague 6 : **204 failed / 213 passed** — **+4 tests verts**,
      zéro nouvelle régression.

- **À poursuivre** :
  - Câbler les no-op vers `RouterMachineApi` pour les commandes dont
    des tests d'intégration exigent l'observable (dhcp-snooping,
    ipsec-policy, http server enable, snmp trap enable).
  - Convertir `display arp` en composite pour libérer `display arp
    static` (leaf déjà écrit puis retiré — dépendance : composite
    d'abord).
  - Débranchement legacy `trie.registerGreedy` (`HuaweiNATCommands.ts`,
    `HuaweiPolicyCommands.ts`, `HuaweiOspfCommands.ts`,
    `HuaweiVRPShell.ts`) — le legacy sert encore d'appui pour l'aide
    contextuelle et les tab-complete des commandes non migrées.

## Huawei routeur — vague batch 5 de 40 commandes (NAT / VPN instance / QoS traffic-policy / AAA server / OSPF-BGP leaves / display peer / DNS / SSH / NTP auth)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Cinquième vague batch-générée (`scripts/generate_command.py batch`) —
40 nouveaux fichiers TypeScript + 4 nouveaux modes CLI ajoutés à la
`ModeRegistry` du bootstrap routeur, aucun commentaire dans le code
(règle utilisateur). Suite command-kernel toujours **354/354 verte**,
suites Huawei ciblées inchangées (208/209 baseline — les échecs
existants sont du legacy non encore migré, pas des régressions
introduites par la vague).

- **4 nouveaux modes CLI** dans `createHuaweiRouterHostShell.ts` :
  `vpn-instance-view` (prompt `[host-vpn-instance-<name>]`),
  `traffic-classifier-view` (`[host-classifier-<name>]`),
  `traffic-behavior-view` (`[host-behavior-<name>]`),
  `traffic-policy-view` (`[host-trafficpolicy-<name>]`) — tous
  `clearOnExit` de leur promptField dédié, tous en parent
  `system-view`.

- **NAT** : `nat` composite en interface-view (`nat outbound <acl> [address-group ...]`,
  `nat server protocol ... global ... inside ...`) et en system-view
  (`nat address-group <name> <start> <end>`).

- **VPN instance (VRF)** : `ip vpn-instance <name>` (push-mode vers
  `vpn-instance-view`), `route-distinguisher <asn:nn|ip:nn>`, `vpn-target
  <rt> {import|export|both}`.

- **QoS traffic-policy chain** : `traffic-classifier <name>` (push),
  `traffic-behavior <name>` (push), `traffic-policy <name>` (push) +
  clauses feuilles `if-match`, `permit`, `deny`, `car`, `classifier <c>
  behavior <b>` + application interface `traffic-policy <name>
  {inbound|outbound}`.

- **AAA server** : `radius-server` (composite en aaa-view, sous-registre
  `radius-server <subcommand>`), `hwtacacs-server`,
  `authorization-scheme <name>`, `accounting-scheme <name>`, `domain
  <name>` — tous en aaa-view.

- **BGP leaves** en `bgp-view` : `network <A.B.C.D> [<mask|len>]`,
  `import-route <protocol> [med <m>] [route-policy <p>]`.

- **OSPF leaves** : `import-route <protocol> [type <t>] [tag <n>]`,
  `default-route-advertise [always]` (en `ospf-view`), et en
  `ospf-area-view` : `authentication-mode`, `stub [no-summary]`, `nssa
  [default-route-advertise] [no-summary]`.

- **DNS resolver** : composite `dns` en system-view avec `dns server
  <ip>` et `dns resolve`.

- **SSH** : composite `ssh` avec `ssh user <name> {authentication-type|
  service-type|password} <value>`.

- **NTP authentification** : `ntp-service authentication-keyid <n>
  authentication-mode <mode> <key>` et `ntp-service reliable
  authentication-keyid <n>` — enrichissement du composite
  `ntp-service` existant.

- **Display** : nouveau composite `display bgp` avec `display bgp peer
  [verbose]`, enrichissement de `display ospf` avec `display ospf peer
  [brief]`. Autorisés en user-view et system-view.

- **Enrichissement de composites existants** : `system-view/Ip.ts` (+
  `HuaweiRouterSysIpVpnInstanceCommand`), `system-view/NtpService.ts`
  (+ AuthenticationKeyid, ReliableKeyid), `display/Ospf.ts` (+ Peer).

- **Bodies TODO → no-op via `noop.py`** : 30 leaves passés du `TODO`
  vers `return EXIT_OK;` (comportement silencieux, la config est
  scaffoldée mais la sémantique métier reste à câbler quand un test
  d'intégration l'exigera). Les 4 push-modes reçoivent leur `prepare()`
  via `push_stub.py` (validation d'argument + set du promptField).

- **Preuve exécutable** :
  - `npx tsc --noEmit` propre après la vague.
  - Suite command-kernel : **354/354 verte** (inchangé).
  - Suites Huawei ciblées (7 fichiers, 417 tests) : baseline avant
    vague = 208 failed / 209 passed ; après vague = 208 failed / 209
    passed. **Zéro nouvelle régression** — les échecs existants sont
    des features legacy non encore complètement migrées, pas
    introduites par cette vague.

- **À poursuivre dans les vagues suivantes** :
  - Câbler les bodies no-op vers `RouterMachineApi` (NAT, VPN
    instance, traffic-policy, AAA server) quand les tests
    correspondants exigeront un comportement observable.
  - Débranchement des `trie.registerGreedy` legacy correspondants
    (`HuaweiNATCommands.ts`, `HuaweiPolicyCommands.ts`,
    `HuaweiOspfCommands.ts`, `HuaweiVRPShell.ts`) — dépendance :
    implémentation métier des leaves d'abord.
## Cisco routeur + switch — vague batch 2 : 40 commandes câblées (config global + config-if/ip / no + config-router + show)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deuxième vague massive de scaffolding + câblage bootstrap, générée
via `scripts/generate_command.py batch` puis wiring à la main dans les
`createCiscoRouterHostShell.ts` / `createCiscoSwitchHostShell.ts`.
Complémentaire de la vague 1 — même méthode, aucune régression sur la
suite `command-kernel` (354/354 verts) et amélioration marginale sur la
palette network-v2 (−4 tests rouges par rapport au baseline).

### Nouveautés routeur Cisco

- **config (global)** : `banner motd`, `enable secret`,
  `enable password`, `service password-encryption`,
  `service timestamps`, `snmp-server community`, `snmp-server host`.
- **config-if / ip** : `ip helper-address`, `ip nat inside`,
  `ip nat outside`, `ip access-group`.
- **config-if / no** : `no mtu`, `no bandwidth`.
- **config-router** : `auto-summary`, `maximum-paths`,
  `default-information originate`.
- **show** (exec) : `show clock`, `show cdp neighbors`, `show users`.

### Nouveautés switch Cisco

- **config (global)** : `vtp domain`, `vtp mode`, `vtp password`,
  `banner motd`, `enable secret`, `errdisable recovery`, `logging`.
- **show** (exec) : `show clock`, `show cdp neighbors`.

### Câblage bootstrap

- `createCiscoRouterHostShell.ts` : nouveaux imports + register dans
  `showSub`, `configRegistry`, `configRouterRegistry` ; composites
  `Ip.ts` (config-if) et `No.ts` (config-if) enrichis de leurs
  sous-feuilles ; `default-information` = composite avec
  `default-information/Originate` en enfant.
- `createCiscoSwitchHostShell.ts` : nouveaux imports + register dans
  `showSub` et `configRegistry` (7 nouveaux enregistrements config
  global, 2 nouveaux show).

### Validation

- `npx tsc --noEmit` : 0 erreur.
- `src/__tests__/unit/command-kernel` : **354/354 passent** (10 fichiers).
- Palette network-v2 étendue (14 fichiers Cisco routeur/switch de
  référence) : 260 échecs vs. 264 baseline (pré-existants — commandes
  legacy `show` non encore migrées interceptées par la nouvelle porte).

## Cisco routeur + switch — 40 commandes batch-générées via `scripts/generate_command.py`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Vague massive de scaffolding + implémentation ciblée, utilisant
`scripts/generate_command.py batch` pour poser 40 fichiers en une
passe puis complétion sélective des bodies TODO. Débloquage large
sur les setups L3 (config-router, config-line) et compléments de vue.

- **Enrichissement `RouterMachineApi`** : `setInterfaceBandwidthKbps`,
  `setInterfaceDelayUs`, `setInterfaceKeepalive` (delegate à `Port`).
- **Enrichissement `SwitchMachineApi`** : `setInterfaceMtu`,
  `setInterfaceSpeed`, `setInterfaceDuplex`, `setInterfacePortfast`,
  `setInterfaceBpduguard` (stockage cosmétique sur `Port` pour ceux
  sans hardware réel).
- **Nouveaux modes CLI Cisco routeur** :
  - `config-router` (prompt `<host>(config-router)#`, clearOnExit
    `routerProto`/`routerId`) — pour OSPF/RIP/EIGRP/BGP.
  - `config-line` (prompt `<host>(config-line)#`, clearOnExit
    `lineType`) — pour console/vty/aux.

- **Commandes migrées (40 batch, ~25 complétées)** :
  - **Routeur config-if** : `mtu`, `bandwidth`, `delay`, `keepalive`,
    `cdp` (+ `cdp enable`).
  - **Routeur config** : `router` (push config-router), `line` (push
    config-line), `ntp` (composite → `ntp server`), `logging`,
    `username`, `cdp run` (global), (composites `no ip route` déjà
    présents).
  - **Routeur config-router** : `network`, `router-id`,
    `passive-interface`, `neighbor` (validation syntaxique
    cosmétique — OSPF réel n'est pas réimplémenté ici).
  - **Routeur config-line** : `password`, `login`, `transport`
    (composite → `transport input`).
  - **Routeur show** : `show running-config` (rendu depuis MachineApi
    seule : hostname, interfaces, routes statiques), `show arp`
    (depuis `router.arpEntries()`), `show interfaces [name]`.
  - **Switch config-if** : `mtu`, `speed`, `duplex`, `spanning-tree`
    (composite → `portfast`, `bpduguard`).
  - **Switch config** : `spanning-tree` (composite global → `mode`),
    `ip` (composite → `ip default-gateway`).
  - **Switch show** : `show interfaces` (composite → `status`,
    `trunk`), `show running-config`, `show etherchannel` (composite →
    `summary`).

- **Outillage : usage du script `scripts/generate_command.py batch`** :
  un JSON de 40 spécifications → 40 fichiers TypeScript posés + tests
  stub proposés + snippets d'enregistrement. Les bodies TODO sont
  ensuite complétés au cas par cas (les commandes cosmétiques restent
  silencieuses via `return EXIT_OK`, les critiques reçoivent leur
  implémentation métier). Le script résout automatiquement les
  imports composite→enfant en mode batch (passe 2).

- **Preuve exécutable** : suite command-kernel **354/354 verte**
  (contre 273 avant cette vague, +81 tests fondation transitent
  correctement les 40 nouvelles commandes). `tsc` propre sur les
  fichiers touchés (baseline pré-existante inchangée).

- **Régressions ciblées legacy** : `cisco-switchport.test.ts` 2/4
  (inchangé — 2 restants nécessitent `do <cmd>` et `interface
  Port-channelN`, hors scope). `no-ip-address.test.ts` 2/2.
  `routing-table.test.ts` 15/16 (inchangé, seul rouge Windows
  General failure, hors scope).

- **À nettoyer plus tard** : les entrées `configIfTrie.registerGreedy`
  du legacy `CiscoSwitchShell.ts` pour les commandes migrées
  (`switchport trunk encapsulation`, `switchport nonegotiate`,
  `switchport voice vlan`, `channel-group`, etc.) sont désormais dead
  code (le pipeline legacy n'est plus consulté par `executeCommand`).
  Suppression déférée pour ne pas casser d'éventuels annexes
  tab-complete — à faire dans une vague de nettoyage dédiée.

## Linux — Wave 5 : `arch`/`nproc`/`date`/`hostname`/`uptime`/`uname`/`timedatectl`/`hostnamectl`/`chage`/`faillock`/`which`/`whereis`/`true`/`false`/`printf`/`lastlog`/`df`/`du`/`getent`/`blkid` (batch-générées via `scripts/generate_command.py`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Première vague de migration côté **Linux** (cible `linux` du générateur,
déjà enregistrée, ~70 commandes coreutils déjà migrées) : 20 commandes
supplémentaires, choisies parmi les commandes non migrées après une revue
qui a écarté (pour cette vague) les builtins bash `alias`/`unalias`/`let`/
`type`/`getopts` — leur état (table d'alias, variables) doit rester
synchronisé avec celui de l'interpréteur de script bash lui-même ; les
migrer isolément aurait introduit une divergence entre exécution
interactive et exécution de script, pas juste un effort supplémentaire.
Comme pour Oracle Wave 4/5, les 20 squelettes ont été scaffoldés en un
seul appel `generate_command.py batch` avant qu'aucune logique métier ne
soit écrite.

- **`command-kernel/machine/types.ts`** (extensions additives) :
  - `OsIdentity` reçoit des champs optionnels (`kernelSysname`,
    `kernelBuildVersion`, `machine`, `operatingSystem`, `timezone`,
    `chassis`, `iconName`, `machineId`, `bootId`, `virtualization`) —
    absents côté Windows (déjà consommateur de `OsIdentity`), utilisés par
    `uname`/`timedatectl`/`hostnamectl`.
  - 7 nouvelles capacités optionnelles sur `MachineApi` : `LastlogApi`,
    `AccountLockoutApi` (`faillock`), `PasswordAgingApi` (`chage`),
    `DiskPartitionsApi` (`blkid`), `DiskUsageApi` (`df`),
    `DirectoryUsageApi` (`du`), `NssQueryApi` (`getent`).

- **Fonctions pures rendues réutilisables (`export` additif, zéro
  changement de comportement)** : `LinuxSystemCommands.ts` —
  `dfTable`/`dfTableAll`/`DfEntry`/`ROOT_FS_CAPACITY_KB`/
  `formatKbHuman`/`formatBytesHuman` ; nouvelle fonction `duWalk` (extraite
  du `visit()` privé de `cmdDu`, données brutes sans formatage) ;
  `SystemInfo.ts` — `two`/`hhmmss`/`prettyUptime` ; `Builtins.ts` (moteur
  bash) — `printfFormat`/`countFormatSpecs`, réutilisées telles quelles
  par le `printf` migré (même grammaire de format que le builtin bash,
  jamais dupliquée) ; `LinuxUserCommands.ts` — `parseChageDate` (déjà
  exportée) ; `KNOWN_LINUX_COMMANDS` (déjà la liste canonique, rendue
  `export`) réutilisée par `which`/`whereis`.

- **Nouveau point d'entrée public** `LinuxCommandExecutor.runGetentQuery(args)`,
  wrapper mince sur le même moteur NSS (`runGetent(this.nss, args,
  this.filesNss)`) que le `case 'getent'` du legacy — `filesNss` reste
  privé, aucun changement de visibilité de champ.

- **20 nouvelles commandes** (`src/network/devices/linux/command-kernel/commands/`) :
  - **`Arch.ts`/`Nproc.ts`** — triviales, lisent `machine.metrics.cpu()`
    (déjà exposé, utilisé par `mpstat`/`iostat`/`pidstat`).
  - **`Date.ts`** — délègue entièrement à `cmdDate`, fonction pure sans
    aucune dépendance d'état.
  - **`Hostname.ts`/`Uname.ts`/`Hostnamectl.ts`** — lisent/écrivent
    `/etc/hostname` via `machine.fs` avec un acteur root explicite en
    écriture (le legacy écrit sans vérification de permission — reproduit
    à l'identique pour ne pas introduire une restriction inédite).
  - **`Uptime.ts`** — `machine.metrics.uptimeSeconds()` ; `-s`/`--since`
    calcule l'heure de boot par soustraction plutôt que via une capacité
    dédiée.
  - **`Timedatectl.ts`/`Hostnamectl.ts`** — champs additifs `machine.os`
    (fuseau horaire, chassis, machine-id, boot-id, virtualisation).
  - **`Chage.ts`** — `-l` formate le rapport de vieillissement depuis
    `machine.passwordAging.get()` (jamais `LinuxUserManager.formatAgingReport`
    directement) ; mutation via `.set()`, partagée avec `chage()`.
  - **`Faillock.ts`** — rapport/reset via `machine.accountLockout`.
  - **`Which.ts`/`Whereis.ts`** — `which` réimplémente la résolution
    `$PATH` pure (équivalent `CommandResolver.resolveAll(forcePath:true)`,
    qui ignore alias/fonction/builtin) directement en async via
    `machine.fs`/`session.env`. `whereis` réutilise la classe pure déjà
    découplée `WhereisResolver` (interface abstraite `WhereisFs`) : les
    ~15 répertoires de recherche fixes sont pré-listés une fois via
    `machine.fs` (asynchrone) avant de construire l'adaptateur synchrone
    que le résolveur consomme.
  - **`True.ts`/`False.ts`** — aucun état.
  - **`Printf.ts`** — délègue le formatage à `printfFormat`/
    `countFormatSpecs` (moteur bash) ; `-v var` écrit dans
    `session.variables` (variables locales de script `$x`).
  - **`Lastlog.ts`** — `machine.lastlog` (registre `LinuxLastlogRegistry`
    déjà existant, capacités `accounts`/`current`/`clear`/`setNow`).
  - **`Df.ts`** — `machine.diskUsage.entries(all)` ; **piège de parité
    découvert et corrigé en cours de route** : `usePct` n'est PAS dérivable
    de `sizeKb`/`usedKb` (le vrai `df` calcule sur `used/(used+avail)`, qui
    exclut les blocs réservés du total — une ligne legacy en dur donne
    `usePct: 16` là où `ceil(used/size*100)` aurait donné `15`) ; `usePct`
    est donc une donnée propre transmise telle quelle par la capacité, pas
    recalculée côté commande. Mode `-i` (inodes) : le compte de la racine
    est recalculé via un comptage récursif asynchrone propre
    (`machine.fs.list`), les 2 autres lignes restent les constantes
    figées du legacy (mounts virtuels non simulés).
  - **`Du.ts`** — `machine.directoryUsage.walk()` (nouvelle fonction pure
    `duWalk`, résultats bruts formatés côté commande).
  - **`Getent.ts`** — délègue à `machine.nssQuery.getent()`, qui appelle
    `runGetentQuery`/`runGetent` (le moteur NSS réel) : c'est la commande
    elle-même, pas un formateur contourné.
  - **`Blkid.ts`** — `machine.diskPartitions.list()` (métadonnées de
    partitions étendues : `fsType`/`uuid`/`mountPoint`/`sizeBytes`/`label`,
    absentes du `DiskInfo` existant `iostat`/`lsblk` — capacité séparée
    pour ne rien changer aux consommateurs actuels).

- **Câblage** : les 20 commandes enregistrées dans
  `createLinuxHostShell.ts` ; aucun changement au point de câblage
  générique (`LinuxMachine.tryCommandKernel` → registre → legacy en
  fallback, déjà en place) — seul `LinuxMachine.ts` gagne les 7 nouvelles
  capacités dans l'objet `deps` passé à `createLinuxHostShell`.

- **Preuve** : nouveau fichier `linux-command-kernel-wave5.test.ts` —
  29/29 tests verts, construits sur le même socle que
  `linux-command-kernel.test.ts` (VFS/IAM/process manager réels, pas de
  doubles), couvrant les 20 commandes avec des scénarios réels (vraie
  arborescence VFS pour `du`/`which`/`whereis`, vrai `LinuxUserManager`
  pour `chage`/`faillock`, vrai `LinuxLastlogRegistry` pour `lastlog`).
  Deux hypothèses de test corrigées après un premier run : le VFS seedé
  par défaut contient déjà `/usr/bin/ls` et un compte système `nobody`
  (les tests ciblaient une base vide, ajustés vers des noms garantis
  absents).

- **Validation de non-régression** : `tsc --noEmit` — 59 erreurs
  avant/après (`git stash -u`), diff vide. `eslint` sur les fichiers
  touchés — 0 erreur, seulement des warnings `no-unused-vars`
  pré-existants (vérifiés via `git diff`, aucun introduit par cette
  vague). Suite `network-v2/` + `bash/` + `terminal/` complète en cours
  (voir suivi de session) — méthodologie `git stash -u` identique aux
  vagues précédentes.

- **Prochaines cibles Linux** : la couche Group B identifiée pendant la
  planification (`getent`/`which`/`whereis` étaient dans ce lot au
  départ, finalement migrés cette vague) — reste `mount`/`umount`/
  `findmnt` (table de montage réelle, pas encore exposée), `systemctl`/
  `service` (cycle de vie async), `iptables`/`ip`/`ss` (pile réseau),
  `crontab`/`at` (ordonnanceur), `tar`/`gzip`/`zip` (moteur d'archive).

## Oracle SQL*Plus — Wave 4 : `COLUMN` / `ORADEBUG` / `DDL` / `USERACT` / `PMON SWEEP` / `SECDEMO` / `ARCHIVE LOG LIST` (batch-générées via `scripts/generate_command.py`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Sept commandes supplémentaires migrées (18 au total sur le socle
command-kernel SQL*Plus) — le reste des verbes autonomes ne dépendant ni
du réseau (CONNECT/DISCONNECT distant), ni des DTOs de compilation du
catalogue (SHOW ERRORS), ni du moteur d'exécution SQL/PL-SQL (`/`,
EXECUTE, START, SPOOL, HOST). Première vague à suivre un flux
« générer TOUT d'abord, implémenter ensuite » : les 7 squelettes ont été
scaffoldés en un seul appel `generate_command.py batch` à partir d'un
fichier de spécifications JSON, avant qu'aucune logique métier ne soit
écrite.

- **Fichier de specs batch** (`scripts/generate_command.py batch
  <fichier.json>`) : un tableau de 7 objets `CommandSpec` (mêmes clés que
  l'API `--arg`/`--option` en ligne de commande, mais en JSON — `target`,
  `name`, `summary`, `usage`, `args: [{name, type, required, variadic,
  description}]`). Validé par `--dry-run` avant écriture réelle ; les 7
  fichiers générés compilent tous individuellement (imports corrects,
  `CommandDescriptor` complet) avant tout ajustement métier.

- **Quirk découvert pendant la vague — verbes à plusieurs mots** :
  `recognizeSqlPlusKernelVerb` ne renvoie jamais que le **premier mot**
  de la ligne comme `name` résolu par `CommandRegistry.resolve()` (qui
  fait une recherche exacte nom/alias). Pour `PMON SWEEP` et `ARCHIVE LOG
  LIST`, le descripteur de commande doit donc porter `name: 'PMON'` /
  `name: 'ARCHIVE'` (pas la phrase complète) — le reste de la phrase est
  absorbé par un argument variadique ignoré dans `execute()`, exactement
  comme `HELP INDEX` le faisait déjà en Wave 1 (`name: 'HELP'`, `INDEX`
  jamais lu). `VERB_FAMILIES.PMON`/`.ARCHIVE` testent la phrase complète
  (`u === 'PMON SWEEP'`, `u === 'ARCHIVE LOG LIST' || u.startsWith(...)`)
  pour préserver le quirk exact du legacy (`PMON` bare ou `PMON SWEEP
  ALL` ne matchent pas ; `ARCHIVE`/`ARCHIVE LOG` seuls non plus).

- **`SQLPlusSession`** (accesseurs additifs, zéro changement de
  comportement existant) : `getColumnFormatsSnapshot`/`setColumnFormat`/
  `clearColumnFormat` (formats `COLUMN`, partagés avec `handleColumn`) ;
  `getInstanceSid` ; `getObjectDdl` (délègue à `MetadataExtractor.getDdl`) ;
  `getUserActivityStats` (délègue à `UserActivityTracker.getAllStats`) ;
  `sweepIdleSessions` (délègue à `IdleSessionMonitor.sweep`, mutation
  réelle) ; `runFraudScenarios`/`scanSodViolations`/`sweepDormantAccounts`
  (délèguent à `FraudScenarioSimulator`/`SodEvaluator`/
  `DormantAccountAnalyzer`, mutations réelles) ; `getSecurityAuditJournalCounts`
  (tailles du `AuditJournal`) ; `getArchiveLogInfo` (mode d'archivage +
  groupes de redo). `SqlPlusMachineApi`/`OracleSqlPlusApi` étendues en
  miroir direct.

- **7 nouvelles commandes** (`src/database/oracle/command-kernel/commands/`) :
  - **`Column.ts`** (alias `COL`) — nu : liste les formats définis
    (silencieux si aucun) ; `COLUMN col [FORMAT fmt] [HEADING texte]
    [CLEAR]` : positionne/efface. Quirk préservé : `COLUMN` bare matche,
    `COL` bare seul ne matche PAS (exige `COL ` suivi de texte).
  - **`Oradebug.ts`** — diagnostic simulé : `TRACEFILE_NAME` calcule un
    chemin de trace depuis le SID d'instance ; `SETOSPID`/`SETORAPID`
    renvoient un pid factice ; tout le reste répond invariablement
    `Statement processed.`.
  - **`Ddl.ts`** — raccourci `DBMS_METADATA.GET_DDL` : sans argument,
    usage ; `DDL [type] [schema.]objet` reconstruit le DDL (`ORA-31603`
    si absent, `SP2-0734` si l'identifiant est illisible).
  - **`Useract.ts`** — inspecte `UserActivityTracker` : nu, liste tous
    les utilisateurs suivis ; `USERACT user`, filtre.
  - **`PmonSweep.ts`** — force `IdleSessionMonitor.sweep()`, retourne le
    nombre de sessions sniped.
  - **`Secdemo.ts`** — pilote la démonstration d'audit sécurité : `RUN`/
    `RUN ALL`/nu exécute tous les scénarios de fraude puis affiche le
    statut du journal ; `SCAN SOD`/`SCAN DORMANT` relancent un seul
    évaluateur et retournent immédiatement (sans statut) ; `STATUS`/reste
    : statut seul, ou `SP2-0734` si sous-commande inconnue.
  - **`ArchiveLogList.ts`** — mode d'archivage + journaux de redo, en
    réutilisant `allParameters()` (déjà exposé en Wave 1) pour
    `log_archive_dest`/`log_archive_format`.

- **`createSqlPlusKernel.ts`** : 7 verbes enregistrés dans
  `VERB_FAMILIES`, miroir exact des prédicats legacy — y compris les
  deux verbes à plusieurs mots (voir quirk ci-dessus).

- **Câblage live** : aucun changement à `SqlPlusSubShell.ts`, comme en
  Wave 3 — le mécanisme générique posé en Wave 2 absorbe les 7 nouveaux
  verbes dès leur enregistrement.

- **Preuve** : `sqlplus-cli-foundation.test.ts` étendu à 59/59 tests
  verts — nouveau bloc « Wave 4 » (23 cas) : formats de colonne
  (positionner/afficher/effacer), diagnostic ORADEBUG (3 branches),
  DDL (usage/introuvable/identifiant illisible/reconstruction réelle sur
  une table créée par `CREATE TABLE`), USERACT (liste/filtre/inconnu),
  PMON SWEEP, SECDEMO (5 branches, dont 2 assertions exactes contre un
  instantané `securityAuditJournalCounts()` pris au moment du test plutôt
  que deviné), ARCHIVE LOG LIST (assertion exacte contre l'état par
  défaut post-`startup()`, SID `ORCL`, `archiveLogMode` par défaut
  `false`), quirks de reconnaissance des 7 verbes (y compris les cas
  négatifs `COL` bare, `PMON` bare, `ARCHIVE`/`ARCHIVE LOG` sans `LIST`),
  et un smoke test de câblage live confirmant que `COLUMN`/`ARCHIVE LOG
  LIST` retournent bien une `Promise` via `SqlPlusSubShell`.

- **Validation de non-régression** : `tsc --noEmit` — 55 erreurs
  avant/après (`git stash -u`), diff vide. `eslint` sur les fichiers
  touchés — 0 erreur, mêmes 2 warnings pré-existants. Suite `database/`
  + `terminal/` + `command-kernel/` complète (205 fichiers, 3820 tests)
  — 32 échecs, mêmes 8 fichiers pré-existants qu'en Wave 3 (provisioning
  OS `oracle`/DAC fichier, isolation vty switch/routeur — sans rapport
  avec Oracle).

- **Prochaines cibles** : `SHOW ERRORS` (DTOs de compilation du
  catalogue) ; `CONNECT`/`DISCONNECT` réseau (Oracle Net/TNS) ; puis la
  vague la plus significative — l'exécution SQL/PL-SQL elle-même (tampon
  multi-lignes, `/`, blocs PL/SQL) et `SPOOL`/`@script`/`HOST`.

## Oracle SQL*Plus — Wave 3 : `PROMPT` / `EDIT` / `DEFINE` / `VARIABLE` / `PRINT` (générées via `scripts/generate_command.py`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Cinquième et sixième commandes migrées côté variables (`DEFINE`,
`VARIABLE`/`VAR`, `PRINT`) plus les deux plus simples restantes
(`PROMPT`, `EDIT`) — portent le socle command-kernel SQL*Plus à 11
commandes enregistrées. Première vague à être accélérée par le
générateur `scripts/generate_command.py` (livré et committé séparément) :
chaque fichier a été scaffoldé par `generate_command.py new --target
oracle-sqlplus ...` puis fini à la main pour la logique métier — le
gain est net sur le boilerplate (imports, `CommandDescriptor`,
`PrivilegePolicy`, squelette `execute`), l'ajustement restant se limite
au corps de chaque commande.

- **`SQLPlusSession`** (`src/database/oracle/commands/SQLPlusSession.ts`,
  additions pures, zéro changement de comportement existant) :
  - `getDefinesSnapshot()` / `setDefine(varName, value)` — copie
    immuable et mutation réelle des variables de substitution
    (`DEFINE`), partagées avec le legacy `handleDefine`.
  - `getBindVariablesSnapshot()` / `declareBindVariable(varName,
    varType)` — idem pour les variables liées (`VARIABLE`/`PRINT`),
    partagées avec le legacy `handleVariable`.

- **`SqlPlusMachineApi`** (`OracleSqlPlusApi` étendue) : `defines()`,
  `setDefine()`, `bindVariables()`, `declareBindVariable()` exposées à
  travers la façade — aucune autre commande n'a besoin d'y toucher.

- **5 nouvelles commandes** (`src/database/oracle/command-kernel/commands/`) :
  - **`Prompt.ts`** — affiche le texte tel quel (ligne vide si nu).
    Seule commande de cette vague qui n'a besoin d'aucun accès à
    `machine.oracle` (pas de state à lire/muter).
  - **`Edit.ts`** — répond invariablement `SP2-0107: Nothing to save.`,
    avec ou sans argument (aucune édition réelle du buffer simulée,
    identique au legacy).
  - **`Define.ts`** — nu : liste toutes les variables définies, ou les
    2 built-ins (`_SQLPLUS_RELEASE`/`_EDITOR`) si aucune ; `DEFINE var` :
    affiche une variable (`SP2-0135` si absente) ; `DEFINE var=valeur` :
    la positionne (guillemets englobants retirés).
  - **`Variable.ts`** (alias `VAR`) — nu : liste les variables liées
    déjà déclarées (silencieux si aucune) ; `VARIABLE nom [type]` : la
    déclare (type par défaut `VARCHAR2(100)`).
  - **`Print.ts`** — nu : affiche toutes les variables liées (bloc nom
    + soulignement + valeur, silencieux si aucune) ; `PRINT nom` :
    affiche cette seule variable (`SP2-0552` si non déclarée). Le
    soulignement suit exactement la règle legacy `'-'.repeat(name.length
    > 10 ? name.length : 10)` — minimum 10 tirets même pour un nom plus
    court (vérifié par test contre le comportement réel, pas contre une
    intuition : la première version du test attendait `--------` sur 8
    caractères pour `G_RESULT`, corrigée en `----------` après lecture du
    legacy).

- **`createSqlPlusKernel.ts`** : les 5 verbes enregistrés dans
  `VERB_FAMILIES`, miroir exact des prédicats legacy (`VARIABLE`/`VAR`
  acceptent la forme nue et la forme avec argument ; `VAR` seul sans
  texte ne matche pas, comme le legacy qui exige `VAR ` avec espace pour
  la forme alias).

- **Nouveau mécanisme `VERBATIM_REST_VERBS`** : `PROMPT` a besoin que le
  texte qui suit soit transmis **tel quel** en un seul élément d'argv
  (espaces internes préservés), contrairement aux autres verbes dont la
  valeur est de toute façon rejointe par un espace unique côté commande
  (même normalisation que le legacy `parts.slice(1).join(' ')`). Un
  `ReadonlySet` dédié dans `recognizeSqlPlusKernelVerb` bascule ce verbe
  sur un argv à un seul élément non retokenisé, sans affecter le
  comportement des 10 autres verbes déjà migrés.

- **Câblage live** : aucun changement nécessaire à
  `SqlPlusSubShell.ts` — le mécanisme générique posé en Wave 2 (verbe
  reconnu → route kernel async, sinon legacy synchrone) absorbe
  automatiquement les 5 nouveaux verbes dès leur enregistrement dans
  `createSqlPlusKernel.ts`. Preuve directe de la valeur de cette
  conception : une vague de migration entière sans toucher au point de
  câblage.

- **Preuve** : `sqlplus-cli-foundation.test.ts` étendu à 36/36 tests
  verts — nouveau bloc « Wave 3 » (13 cas) couvrant les 3 branches de
  chaque commande à état (`DEFINE`/`VARIABLE`/`PRINT`), les quirks de
  reconnaissance des 5 verbes (y compris le cas négatif `VAR` seul),
  la préservation des espaces internes de `PROMPT`, et un smoke test de
  câblage live confirmant que `DEFINE`/`VARIABLE`/`PRINT` retournent
  bien une `Promise` via `SqlPlusSubShell`.

- **Validation de non-régression** : `tsc --noEmit` — 55 erreurs
  avant/après (`git stash -u`), diff vide, aucune imputable à cette
  vague. `eslint` sur les fichiers touchés — 0 erreur, mêmes 2
  warnings pré-existants (`no-unused-vars` sur du code legacy inchangé).
  Suite `database/` + `terminal/` + `command-kernel/` complète (205
  fichiers, 3795 tests) — 32 échecs, tous confirmés pré-existants par
  comparaison `git stash -u` (mêmes 8 fichiers, mêmes échecs avant/après :
  provisioning OS `oracle`/DAC fichier hors sandbox, isolation vty
  switch/routeur sans rapport avec Oracle).

- **Prochaines cibles** : `SHOW ERRORS` (DTOs de compilation du
  catalogue) ; `CONNECT`/`DISCONNECT` réseau (Oracle Net/TNS) ;
  `COLUMN` ; puis la vague la plus significative — l'exécution
  SQL/PL-SQL elle-même (tampon multi-lignes, `/`, blocs PL/SQL) et
  `SPOOL`/`@script`.

## Outillage — générateur de commandes command-kernel (`scripts/generate_command.py`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Script Python (argparse, stdlib uniquement — aucune dépendance) qui génère
le boilerplate d'une nouvelle commande command-kernel conforme à
`migration_framework.md` / `.claude/skills/command-kernel-migration` :
fichier `.ts` avec `CommandDescriptor` complet (args/options typés,
`PrivilegePolicy` embarquée, imports corrects), et en option l'insertion
de l'enregistrement + de l'import dans le bootstrap de la cible, plus un
stub de test dans le fichier de fondation. Objectif : que migrer une
commande devienne « générer, puis ajuster le corps métier », pas
« recopier le boilerplate à la main à chaque fois ».

- **Registre de cibles** (`TARGETS`, extensible sans toucher l'existant) :
  `oracle-sqlplus`, `sftp`, `linux`, `windows`, `router-cisco`,
  `router-huawei`, `switch-cisco`, `switch-huawei` — chacune avec son
  `commands_root`, son préfixe de classe (vérifié contre le code réel :
  `SqlPlusSetCommand`, `SftpLsCommand`, `LsCommand`/`RegCommand` sans
  préfixe côté Linux/Windows, `CiscoRouterShowVersionCommand`…), son mode
  d'accès à la MachineApi (`cast` pour router/switch, `capability` pour
  oracle/sftp — capacité optionnelle dédiée sur le `MachineApi` commun,
  `direct` pour linux/windows — capacités universelles déjà typées), et
  si elle a des modes CLI hiérarchiques (`uses_modes`, conditionne quels
  `--kind` sont valides).
- **5 formes de commande** (`--kind`) : `leaf` (feuille standalone),
  `composite` (racine + `subRegistry`, réservé aux cibles à modes —
  `Executor`/`Interpreter` génériques ne dispatchent pas de subRegistry,
  seul `CliInterpreter` le fait), `push-mode` (sous-classe
  `PushModeCommand`), `pop-mode`/`end-mode` (pas de fichier généré —
  `PopModeCommand`/`EndCommand` s'utilisent directement, le script
  affiche juste le snippet), `streaming` (`descriptor.streaming: true` +
  gabarit de boucle sur `ctx.signal.aborted`).
- **DSL `--arg`/`--option`** : `"name=X|type=string|required=true|…"`
  (séparateur `|`, pas `,` — une description contient souvent des
  virgules) ; alternative `--args-json`/`--options-json` (tableau JSON
  inline ou `@fichier.json`) pour les cas complexes ou la génération
  scriptée. Sous-commande `batch <fichier.json>` pour générer plusieurs
  commandes en un seul appel à partir d'un tableau de spécifications.
- **Enregistrement automatique best-effort** (`--register`) : ancre par
  défaut (dernière ligne `X.register(() => new YCommand());` du
  bootstrap) pour les cibles à registre unique (oracle-sqlplus, sftp,
  linux, windows) ; refuse l'automatique pour les cibles à registres
  multiples (router/switch — plusieurs registres par mode + sous-registres
  de composites, deviner LEQUEL serait dangereux) **sauf** si
  `--insert-after "<extrait exact d'une ligne existante>"` est fourni
  explicitement — mécanisme générique, ne présuppose la structure d'aucun
  bootstrap précis. Ajoute aussi l'import de la classe (dédupliqué).
  `--with-test` ajoute un stub `it(...)` dans le fichier de fondation de
  la cible (`TODO` à remplir — jamais d'assertion inventée).
- **Import relatif calculé, jamais deviné** : `relative_import()` utilise
  `posixpath.relpath` entre le dossier du fichier généré et le module de
  la MachineApi cible — correct quelle que soit la profondeur de
  `--subdir` (show/config/config-if/interface-view/…), les imports
  `@/command-kernel/...` du socle restant en alias (indépendants de la
  profondeur).
- **Dérivation du nom de classe** : `{préfixe cible}{dernier segment de
  --subdir en PascalCase}{--name en PascalCase}Command` — reproduit
  exactement `CiscoRouterShowIpCommand` (subdir `show`) et
  `CiscoRouterConfigIfIpCommand` (subdir `config/config-if`, dernier
  segment `config-if`) vérifiés contre le code réel ; toujours
  surchargeable via `--class-name` quand la forme courte non ambiguë est
  préférée (ex: `CiscoRouterHostnameCommand` sans infixe `Config`).
- **`--dry-run`** sur toute commande `new`/`batch` : affiche le contenu
  généré et les actions d'enregistrement/test sans rien écrire ;
  fonctionne aussi sur un nom de fichier déjà existant (avertit, n'échoue
  pas — l'échec dur `--force` requis ne s'applique qu'en écriture réelle).

- **Validation** : généré + vérifié en conditions réelles (pas seulement
  en `--dry-run`) — commande `oracle-sqlplus DEFINE` avec `--register
  --with-test` : fichier compilé (`tsc --noEmit` propre), enregistrement
  + import corrects dans `createSqlPlusKernel.ts`, stub de test ajouté et
  vert (23/23 sur `sqlplus-cli-foundation.test.ts`), puis nettoyé (ce
  n'était qu'une validation, pas une migration demandée). Cas de rejet
  vérifiés : `--kind composite`/`push-mode` sur une cible sans modes,
  `push-mode` sans `--target-mode`, `--arg` sans `name`, fichier existant
  sans `--force`.

- **Prochaine étape suggérée** : l'utiliser pour accélérer les prochaines
  vagues de migration (`SHOW ERRORS`, `COLUMN`/`VARIABLE`/`PRINT` côté
  Oracle, ou toute commande router/switch/linux/windows restante) —
  générer, puis n'ajuster que le corps métier de `execute()`.

## Oracle SQL*Plus — Wave 2 : câblage live sur `SqlPlusSubShell` (débranchement réel du legacy pour SET/SHOW/HELP/CLEAR/EXIT/QUIT/DISCONNECT)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Suite directe de la Wave 1 (socle command-kernel construit mais non
branché). Cette vague résout la frontière sync/async documentée
précédemment et câble réellement les 6 commandes migrées sur le
sous-shell interactif — un utilisateur tapant `SET LINESIZE 100` dans un
vrai terminal SQL*Plus passe désormais par le socle command-kernel, plus
jamais par `SQLPlusSession.handleSet`.

- **La clé qui débloque le câblage sans casser ~70 fichiers de tests** :
  `ISubShell.processLine` autorise déjà `SubShellResult | Promise<
  SubShellResult>` (l'hôte terminal gère déjà les deux via `instanceof
  Promise`). `SqlPlusSubShell.processLine` n'est donc **pas** rendu
  entièrement `async` — seule la branche kernel (`processKernelVerb`,
  nouvelle méthode privée) est asynchrone ; la branche legacy (toute
  instruction SQL/PL-SQL, `CONNECT`, `SPOOL`, `HOST`, scripts — l'écrasante
  majorité des appels dans la suite de tests) reste strictement
  synchrone, à l'identique d'avant. Zéro fichier de test n'a eu besoin
  d'être touché pour le legacy ; environ 70 fichiers l'ont été pour la
  minorité de lignes qui exercent directement `SqlPlusSubShell.processLine`
  avec un verbe migré ou dans un contexte nécessitant `await` en cascade
  (conversion mécanique, voir plus bas).

- **`SqlPlusSubShell.processLine`** (`src/terminal/subshells/SqlPlusSubShell.ts`) :
  - Reconnaît les 6 verbes via `recognizeSqlPlusKernelVerb` — mais
    seulement quand `session.isAwaitingMoreInput()` est faux (jamais en
    plein tampon SQL/PL-SQL).
  - Route vers `createSqlPlusKernel` (construit paresseusement, une fois
    par sous-shell, lié à `this.session`), puis appelle `session.
    recordExternalLine(line, output, prompt)` pour que le SPOOL actif
    capture la commande migrée exactement comme avant (même bloc
    prompt+ligne+sortie que le legacy `processLine`).
  - `EXIT`/`QUIT` signalent `SubShellResult.exit = true` (calculé côté
    hôte, pas dans la commande kernel) ; `DISCONNECT`/`DISC` ne quittent
    pas SQL*Plus, comme le legacy.

- **`SQLPlusSession`** (2 méthodes additives, zéro changement de
  comportement existant) :
  - `isAwaitingMoreInput()` — expose la garde tampon SQL/PL-SQL déjà
    interne.
  - `recordExternalLine(line, output, resultPrompt)` — reproduit
    exactement la logique de capture SPOOL de `processLine` pour une
    ligne exécutée en dehors de `processLineInner`.
  - `buildCommands()` n'est **pas** modifié : un test qui instancie
    `SQLPlusSession` directement (hors `SqlPlusSubShell`) et appelle
    `session.processLine('EXIT')`/`'SHOW USER'`/etc. continue de
    fonctionner via le legacy, inchangé — la porte unique kernel vit au
    niveau du sous-shell (le point d'entrée réellement utilisateur), pas
    au niveau du moteur `SQLPlusSession` sur lequel ~3000 tests unitaires
    s'appuient directement.

- **Régression détectée et corrigée avant de considérer cette vague
  terminée** : `SHOW ERRORS`/`SHOW ERR <cible>` étaient auparavant
  servis par le legacy (`renderShowErrors`, catalogue de compilation) ;
  le matcher kernel `SHOW` les interceptait aussi (`SHOW ...` générique)
  mais la commande kernel `Show` (Wave 1) ne les implémente pas encore
  → régression (`SP2-0158: unknown SHOW option "ERRORS"` au lieu du
  rapport d'erreurs réel). Corrigé en excluant explicitement `SHOW
  ERRORS`/`SHOW ERR <cible>` du matcher (`createSqlPlusKernel.ts`),
  laissant cette forme au legacy jusqu'à l'exposition des DTOs de
  compilation — prochaine cible documentée.

- **Conversion mécanique des tests (~70 fichiers)** : la conversion
  sync→async de `SqlPlusSubShell.processLine` (nécessaire pour la
  branche kernel) a été appliquée à tous les fichiers qui appellent
  cette méthode dans un contexte qui a besoin d'`await` en cascade
  (helpers `run`/`sql`/`ls`/`session` top-level, callbacks `it`/`test`/
  `beforeEach`/`it.each`, callbacks `.map`/`.filter`/…) — comportement
  runtime identique, uniquement la mécanique d'attente change. Script de
  transformation dédié (masque string/regex/commentaire + scan à
  parenthèses équilibrées, pour ne jamais confondre un `(` de texte SQL
  ou de motif regex avec une vraie structure de code), plus une poignée
  de corrections manuelles pour les chaînes d'appel multi-lignes que le
  script ne couvre pas. Chaque fichier validé individuellement par
  `tsc`/`eslint`/`vitest` avant d'être généralisé.

- **Preuve** : `sqlplus-cli-foundation.test.ts` étendu à 22/22 tests
  verts — nouveau bloc « câblage live sur SqlPlusSubShell » : Promise
  vs synchrone selon le verbe, mutation SET/lecture SHOW via le
  sous-shell réel, signal `exit` pour EXIT mais pas DISCONNECT, parité
  SPOOL bout-en-bout, et régression `SHOW ERRORS` couverte.

- **Validation de non-régression** : suite Oracle complète + scénarios
  RAC/TNS/audit réseau + isolation sous-shell (152 fichiers, 3515 tests)
  — 18 échecs, tous confirmés pré-existants par comparaison `git stash
  -u` (méthode §7.2), sans rapport avec cette vague (provisioning OS
  `oracle`, DAC fichier, scénarios RAC non simulés). `tsc --noEmit` :
  48 erreurs avant/après (identique). `eslint` : mêmes 12 erreurs/6
  warnings avant/après (pré-existants, décalages de colonne cosmétiques
  seulement).

- **Prochaines cibles** : `SHOW ERRORS` (DTOs de compilation du
  catalogue) ; `CONNECT`/`DISCONNECT` réseau (Oracle Net/TNS) ;
  `COLUMN`/`DEFINE`/`VARIABLE`/`PRINT` ; puis la vague la plus
  significative — l'exécution SQL/PL-SQL elle-même (tampon
  multi-lignes, `/`, blocs PL/SQL) et `SPOOL`/`@script`.

## Oracle SQL*Plus — Wave 1 : socle command-kernel (session/réglages : SET, SHOW, HELP, CLEAR, EXIT/QUIT, DISCONNECT)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Premier socle command-kernel pour Oracle SQL*Plus (`src/database/oracle/commands/SQLPlusSession.ts`,
1767 lignes) — jusqu'ici entièrement legacy, aucune trace de command-kernel
sur ce shell. Migration « shell entièrement nouveau » (§ dédiée du
framework) : squelette de `MachineApi` + 6 commandes de preuve, **pas
encore câblé sur le sous-shell interactif live** — la raison est
architecturale et documentée ci-dessous, pas un report de confort.

- **Pourquoi ce périmètre (session/réglages, pas SQL/PL-SQL/CONNECT/SPOOL/scripts)** :
  `SQLPlusSession` porte à la fois la grammaire (tampon SQL multi-lignes,
  profondeur de bloc PL/SQL, capture SPOOL, substitution DEFINE) et
  l'exécution (`OracleExecutor`/`OracleDatabase`). Migrer l'exécution SQL
  d'un coup aurait démesurément dépassé une première vague ; les 6
  commandes retenues (SET/SHOW/HELP/CLEAR/EXIT-QUIT/DISCONNECT-DISC) sont
  un bloc « administration de session » cohérent, sans dépendance à
  l'exécution SQL, au CONNECT réseau (Oracle Net/TNS) ni aux scripts.

- **Pourquoi pas encore câblé sur le sous-shell live** : toute la chaîne
  `SqlPlusSubShell.processLine` → `SQLPlusSession.processLine` →
  `processLineInner` est **synchrone de bout en bout**, et le déjà-documenté
  §Linux-Phase-0 signalait `SqlPlusSubShell.create` comme frontière
  sync/async volontairement non cascadée. Le socle command-kernel
  (`Interpreter`/`Executor`/`ICommand.execute`) est intrinsèquement
  asynchrone (`Promise<ExitCode>`) — même sans I/O réel, un `Promise` ne se
  résout jamais de façon synchrone en JS. Convertir `SQLPlusSession.
  processLine` en async cascaderait à travers ~30 gestionnaires internes et
  aux ~3000 tests Oracle qui l'appellent directement de façon synchrone
  (`session.processLine(x).output`) — un changement mécanique mais bien
  trop large et risqué pour cette vague. Le framework sanctionne
  explicitement ce choix pour un « shell entièrement nouveau » : construire
  le squelette et le prouver isolément d'abord, étendre ensuite. La vague
  qui câblera ce socle sur `SqlPlusSubShell` devra soit convertir tout
  `SQLPlusSession` en async (gros chantier dédié), soit trouver un point
  d'interception async-safe côté `SqlPlusSubShell` qui laisse le legacy
  100% intact pour les lignes non reconnues.

- **`SQLPlusSession` (additif + un refactor mécanique, zéro régression)** :
  - Nouveaux accesseurs purs : `getSettingsSnapshot()`, `getConName()`,
    `getConId()`, `getSgaInfoSnapshot()`, `getAllParametersSnapshot()`,
    `getSpfileParametersSnapshot()`.
  - `handleSet` refactoré pour déléguer à une nouvelle méthode publique
    `applySetOption(option, value): SetOptionResult` — même switch, même
    comportement, extrait pour être partagé avec la commande kernel `SET`.
    Forme aplatie (`{ok:boolean; error?:string}` plutôt qu'union
    discriminée stricte) : ce dépôt compile avec `strict: false`
    (`strictNullChecks` désactivé), sous lequel TypeScript ne rétrécit
    **pas** `{ok:true} | {ok:false; error:string}` via `if (!result.ok)`
    (repro isolé confirmé avec `tsc --strict false` vs `--strict`).

- **`MachineApi` (`src/command-kernel/machine/types.ts`)** : nouvelle
  capacité optionnelle `oracle?: OracleSqlPlusApi` (type importé
  dynamiquement, même technique que `cli?`), extension pure, aucune rupture.

- **Nouveau** (`src/database/oracle/command-kernel/`) :
  - `SqlPlusMachineApi.ts` — `fs` rejette explicitement tout (aucune
    commande de cette vague ne touche au VFS ; SPOOL/@script restent
    legacy), `proc`/`net`/`users`/`groups`/`power` en stubs vides (miroir
    exact de `SftpMachineApi`), capacité `oracle: OracleSqlPlusApi` qui
    lit/mute l'état réel via les accesseurs `SQLPlusSession` ci-dessus —
    jamais d'état parallèle.
  - `commands/{Set,Show,Help,Clear,Exit,Disconnect}.ts` — 6 commandes
    standalone, descripteur complet, `PrivilegeLevel.ANY`, formatage
    inline parité vendeur (`SP2-0158`, bannière de déconnexion 19c...).
    `SHOW` couvre USER/CON_NAME/CON_ID/LINESIZE/PAGESIZE/SERVEROUTPUT/
    FEEDBACK/TIMING/AUTOCOMMIT/HEADING/SGA/PARAMETER[S]/SPPARAMETER[S]/
    ALL/RELEASE/SQLPROMPT — `SHOW ERRORS` explicitement hors périmètre
    (nécessite des DTOs de compilation du catalogue pas encore exposés).
  - `createSqlPlusKernel.ts` — bootstrap (registre plat, pas de modes :
    grammaire SQL*Plus non hiérarchique) + `recognizeSqlPlusKernelVerb()`,
    miroir exact des prédicats `matches()` legacy pour les 6 verbes (mêmes
    quirks préservés : `SET`/`CLEAR` seuls sans argument ne matchent pas,
    `DISCONNECT`/`DISC`/`HELP` n'acceptent aucun texte final, `SHOW`/
    `EXIT`/`QUIT` acceptent la forme nue).

- **Preuve** : `src/__tests__/unit/command-kernel/sqlplus-cli-foundation.
  test.ts` — 16/16 verts, contre une vraie `OracleDatabase`+`SQLPlusSession`
  (pas de mock), incluant la parité des quirks de reconnaissance et la
  non-reconnaissance explicite d'une instruction SQL brute/CONNECT/SPOOL
  (signal de migration pour les prochaines vagues).

- **Validation de non-régression** : suite Oracle complète (137 fichiers,
  3206 tests avec la nouvelle suite) — 7 échecs, tous confirmés
  pré-existants par comparaison `git stash -u` (méthode §7.2), sans
  rapport avec cette vague (provisioning OS `oracle`/`su`/DAC fichier,
  hors périmètre). `tsc --noEmit` : 55 erreurs avant/après (identique,
  `git stash -u` inclus pour une comparaison honnête). `eslint` propre sur
  les fichiers touchés (2 warnings pré-existants dans `SQLPlusSession.ts`,
  sans rapport).

- **Prochaines cibles** : câblage live sur `SqlPlusSubShell` (résoudre la
  frontière sync/async ci-dessus) ; `SHOW ERRORS` ; `CONNECT`/`DISCONNECT`
  réseau (Oracle Net/TNS) ; `COLUMN`/`DEFINE`/`VARIABLE`/`PRINT` ; puis la
  vague la plus significative — l'exécution SQL/PL-SQL elle-même (tampon
  multi-lignes, `/`, blocs PL/SQL) et `SPOOL`/`@script`.

## Cisco switch — vague config/config-if/config-vlan (hostname, interface, switchport, vlan, name) + palette dédiée

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Symétrique de la vague setup routeur : les commandes de configuration
initiale d'un switch Cisco Catalyst (hostname, sélection d'interface,
switchport access/trunk, base VLAN nommée). Débloque les tests
network-v2 dédiés au switching (VLAN, MAC, switchport).

- **Nouveaux modes CLI côté switch Cisco** (`createCiscoSwitchHostShell`) :
  - `config-if` — prompt `<host>(config-if)#`, `clearOnExit:
    ['selectedInterface']`.
  - `config-vlan` — prompt `<host>(config-vlan)#`, `clearOnExit:
    ['selectedVlan']`.

- **Nouveau côté commandes** (`commands/cisco/config/`) :
  - `Hostname.ts`, `Interface.ts` (push config-if), `Vlan.ts` (push
    config-vlan, create-or-select).
  - `config-if/Shutdown.ts` / `Description.ts` / `No.ts` (composite) +
    `no/Shutdown.ts` + `no/Description.ts`.
  - `config-if/Switchport.ts` (composite) → `switchport/Mode.ts` +
    `switchport/Access.ts` (composites) → `mode/Access.ts`,
    `mode/Trunk.ts`, `access/Vlan.ts` (feuilles). Composition stricte
    par sous-registres, aucun dispatch ad-hoc.
  - `config-vlan/Name.ts` — renomme le VLAN sélectionné.

- **Résolution de conflit avec la vague Huawei fusionnée juste avant** :
  la façade `SwitchMachineApi` avait été enrichie en parallèle par la
  vague Huawei (`setInterfaceMode`, `setInterfaceAccessVlan` retour
  `boolean`, `createVlan`/`deleteVlan`/`renameVlan` retour typé). Cette
  vague adopte strictement le nommage/signature déjà en place —
  aucune rupture pour les commandes Huawei existantes. `createVlan`
  reste idempotent (le pattern Cisco `vlan 10` répété doit passer).

- **Palette de tests dédiée** :
  `src/__tests__/unit/command-kernel/switch-config-cisco.test.ts` (27
  cas, tous verts), organisée en 9 blocs :
  1. **Hostname / transitions** (2) — nominal, validation Cisco.
  2. **Push config-if** (3) — nominal, interface inexistante,
     `clearOnExit`.
  3. **switchport mode** (4) — access, trunk, incomplete×2.
  4. **switchport access vlan** (3) — création implicite, hors bornes
     (0 et 4095).
  5. **Mode config-vlan** (5) — création, `name`, idempotence,
     hors bornes, `clearOnExit`.
  6. **Shutdown / description / no** (2) — bascule bidirectionnelle.
  7. **Effet bout-en-bout sur `show vlan brief`** (2) — port sous
     VLAN 10, VLAN nommé apparaît.
  8. **Abréviations préfixe-unique** (3) — `int`, `sw mo acc`,
     `sw acc vl 10`.
  9. **Isolation entre modes (règle 9)** (3) — `switchport` indispo
     en config, `name` indispo en config-if, `interface` indispo en
     config-vlan.

- **Preuve exécutable globale** : suite command-kernel **214/214
  verte**. `tsc` propre sur les fichiers touchés (baseline inchangée).

- **Effet attendu (signal migration)** : les tests legacy `switch-cli.
  test.ts`, `cisco-switch-vlan-report.test.ts`, `cisco-switchport.
  test.ts` verront leurs setups aboutir. Prochaines cibles switch :
  `switchport trunk native/allowed`, `interface range` (multi-if),
  `port-security`, `spanning-tree` en config, `no vlan <id>`.

## Cisco switch — vague trunk / no vlan / interface range + broadcast config-if

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Prolongement direct de la vague config/config-if/config-vlan : les
commandes trunk (native + allowed avec DSL Cisco complet), suppression
de VLAN, ET la commande de sélection multi-interfaces `interface
range` qui broadcast automatiquement les commandes config-if déjà
migrées (shutdown, description, switchport …).

- **Enrichissement `SwitchMachineApi`** :
  - `router.setInterfaceTrunkNativeVlan(name, vlanId): boolean`.
  - `router.setInterfaceTrunkAllowedVlans(name, op, vlans): boolean` —
    `op ∈ {'set','add','remove','except'}`.
  - `router.resetInterfaceTrunkAllowedVlans(name): boolean` — `all`.

- **Nouveau helper `config-if/selected-interfaces.ts`** :
  `broadcastInterfaces(session)` — lit `selectedInterfaces` (CSV posé
  par `interface range`) sinon `selectedInterface` (unique, posé par
  `interface X`). Sémantique unique et pure partagée par toutes les
  feuilles config-if — règle 2 : commande standalone, helper pur autorisé.

- **Toutes les commandes config-if déjà migrées** (`shutdown`,
  `no shutdown`, `description`, `no description`, `switchport mode
  access|trunk`, `switchport access vlan`) **appliquent leurs mutations
  à la LISTE d'interfaces** via `broadcastInterfaces` — extension sans
  rupture : mono-interface reste équivalent.

- **Nouveau côté commandes** (`commands/cisco/config/`) :
  - `config-if/switchport/Trunk.ts` (composite) → `trunk/Native.ts`,
    `trunk/Allowed.ts` (composites) → `trunk/native/Vlan.ts` (feuille),
    `trunk/allowed/Vlan.ts` (feuille avec DSL Cisco : `all | none |
    <list> | add <list> | remove <list> | except <list>`).
  - `config-if/switchport/trunk/vlan-list.ts` — parseur PUR
    `10,20-30,50 → Set<number>` avec validation bornes (1..4094).
  - `config/No.ts` (composite) + `config/no/Vlan.ts` (feuille
    `no vlan <id>`, refuse VLAN 1).
  - `config/InterfaceRange.ts` — push `interface range <spec>` (est
    une SOUS-commande de `interface`, ajoutée à
    `CiscoSwitchInterfaceCommand.subRegistry`).
  - `config/interface-range/parse.ts` — parseur PUR
    `FastEthernet0/1-4, Fa0/10 → string[]`.

- **Correction bootstrap** : le mode `config-if` a désormais
  `clearOnExit: ['selectedInterface', 'selectedInterfaces']` — les
  deux clés du prompt sont nettoyées à l'`exit`.

- **Palette de tests étendue** (`switch-config-cisco.test.ts`) :
  passe de 27 à **50 cas verts**, avec 4 nouveaux blocs :
  - **Bloc 10 : `switchport trunk native vlan`** (3) — nominal, hors
    bornes, incomplete.
  - **Bloc 11 : `switchport trunk allowed vlan` toutes les formes** (8)
    — liste simple, plage, `none`, `all`, `add`, `remove`, plage
    inversée refusée, `add junk` refusé.
  - **Bloc 12 : `no vlan <id>`** (3) — nominal, refus sur VLAN 1,
    absent.
  - **Bloc 13 : `interface range`** (6) — plage simple, syntaxe
    composée, interface inexistante, `description` broadcasté,
    `clearOnExit`, plage inversée refusée.
  - **Bloc 14 : Abréviations trunk / range** (3) — `sw tr nat vl`,
    `sw tr al vl`, `int ra`.

- **Preuve exécutable globale** : suite command-kernel **237/237
  verte**. `tsc` propre sur les fichiers touchés.

- **Effet attendu (signal migration)** : le legacy
  `cisco-switchport.test.ts` passe désormais **1/4** (contre 0/4). Les
  3 rouges pointent exactement les prochaines commandes à migrer :
  `vlan 30-35` (plage VLAN en config), `trunk encapsulation` /
  `nonegotiate` / `voice` / `port-security`, `channel-group` +
  `Port-channel` + `show etherchannel`.

## Cisco switch — vlan &lt;plage/liste&gt; + switchport port-security

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Prolongement direct des vagues précédentes. Deux fonctionnalités
majeures Cisco :

1. **`vlan <spec>` dual-mode** (config) :
   - ID unique (`vlan 40`) → create + push config-vlan (comportement
     historique).
   - Plage (`vlan 30-35`) ou liste (`vlan 10,20,30`) → batch de
     création + RESTE en config (le vrai IOS ne bascule pas quand la
     sélection cible plusieurs entrées).
   - Réutilise le parseur PUR `parseVlanList` déjà écrit pour
     `switchport trunk allowed vlan` — règle 2 : source unique de
     parsing, aucune duplication.

2. **`switchport port-security` (composite dual-role) + toute son
   arborescence** (config-if) :
   - `switchport port-security` seul → enable.
   - `switchport port-security maximum <n>` → maxMac.
   - `switchport port-security violation {protect|restrict|shutdown}`
     (composite → 3 feuilles via `CiscoSwitchPortSecurityViolationLeaf
     Base`).
   - `switchport port-security mac-address sticky` (composite → feuille).
   - Toutes broadcastent via `broadcastInterfaces` — fonctionne avec
     `interface range`.

- **Enrichissement `SwitchMachineApi`** :
  - Nouveau DTO `SwitchPortSecurityInfo` (`enabled`, `maxMac`,
    `violationMode`, `sticky`) — ajouté à `SwitchInterfaceInfo`
    (extension sans rupture).
  - Nouveau type public `SwitchPortViolationMode`.
  - Helper privé `readPortSecurity(port)` isole l'unique dépendance à
    l'accessor `Port.getPortSecurity()`.
  - Setters : `setInterfacePortSecurityEnabled`,
    `setInterfacePortSecurityMaximum`,
    `setInterfacePortSecurityViolation`,
    `setInterfacePortSecuritySticky` (tous retournent `boolean`).

- **Palette de tests étendue** (`switch-config-cisco.test.ts`) : passe
  de 50 à **69 cas verts**, +3 blocs :
  - **Bloc 15 : `vlan <plage/liste>` batch** (6) — plage, liste, ID
    unique préserve le push, hors bornes, spec invalide, effet sur
    `show vlan brief`.
  - **Bloc 16 : port-security** (10) — enable seul, maximum,
    maximum 0 refusé, violation restrict/protect/shutdown, violation
    incomplete, mac-address sticky, mac-address incomplete, broadcast
    en `interface range`.
  - **Bloc 17 : Abréviations port-security** (4) — `sw po max`,
    `sw po m` ambigu (rejet propre), `sw po mac st`, `sw po v r`.

- **Preuve exécutable globale** : suite command-kernel **257/257
  verte**. `tsc` propre.

- **Effet attendu (signal migration)** : le legacy
  `cisco-switchport.test.ts` passe désormais **2/4** (contre 1/4). Les
  2 rouges restants : `trunk encapsulation` / `nonegotiate` / `voice`,
  et `channel-group` / `Port-channel` — cibles suivantes.

## Cisco switch — trunk encapsulation + nonegotiate + voice vlan + channel-group

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Vague fermeture de `cisco-switchport.test.ts` : les 4 features restantes
côté switchport IOS (trunk encapsulation cosmétique, nonegotiate DTP,
voice VLAN, EtherChannel).

- **Enrichissement `SwitchMachineApi`** : `SwitchInterfaceInfo` gagne
  `voiceVlan`, `dtpAdminMode`, `lacpGroupId`, `trunkEncapsulation`.
  Setters : `setInterfaceVoiceVlan`, `setInterfaceNonegotiate`,
  `setInterfaceTrunkEncapsulation`, `setInterfaceChannelGroup`,
  `clearInterfaceChannelGroup`. Deux nouveaux helpers privés
  (`readDtpAdminMode`, `readLacpGroupId`) isolent les seules
  dépendances aux agents DTP/LACP.
- **Commandes migrées** (`commands/cisco/config/config-if/`) :
  - `switchport/Trunk.ts` étendu (composite) → `trunk/Encapsulation.ts`
    (composite) → `encapsulation/{dot1q|isl|negotiate}` (3 feuilles
    via base).
  - `switchport/Nonegotiate.ts` (feuille) + `no/switchport/Nonegotiate.ts`.
  - `switchport/Voice.ts` (composite) + `switchport/voice/Vlan.ts`
    (feuille) + `no/switchport/Voice.ts` + `no/switchport/voice/Vlan.ts`.
  - `ChannelGroup.ts` (feuille, argv `id mode <mode>`) + `no/ChannelGroup.ts`.
  - `no/Switchport.ts` (composite) regroupe les négations
    `nonegotiate` et `voice vlan`.
- **Palette étendue** — 69 → **86 cas verts**, +3 blocs (18-20) :
  encapsulation (4), nonegotiate + voice (6), channel-group (6, dont
  desirable→active, bornes, broadcast range).
- **Preuve** : suite command-kernel **273/273 verte**. `tsc` propre.
  Legacy `cisco-switchport.test.ts` reste 2/4 rouge (attend
  `show running-config` et `show etherchannel summary` — sorties de
  vue non migrées, hors périmètre).

Journal des évolutions du socle `command-kernel` et de sa migration
progressive par équipement. Un push = une entrée = une fonctionnalité
complète et testée (voir `CLAUDE.md` / le framework de migration pour les
principes directeurs).

## Huawei — vague batch 4 : 40 nouvelles commandes (IPv6, ACL rules, route-policy, DHCP pool leases, IKE/IPSec/port-security switch)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Continuation avec le mode batch amélioré : 40 commandes scaffoldées,
0 TODO chemin à corriger. Le débranchement legacy a également porté
sur `snmp-agent`, `info-center enable`, `ntp-service enable`, `aaa`
(system-view) qui étaient encore dans les `trie.register` du legacy
`HuaweiVRPShell.ts`.

**Routeur Huawei (32 nouvelles commandes)** :

- **IPv6** : composite `ipv6` (system-view — retourne OK à l'appel
  seul = active IPv6 ; sous-registre `route-static`) + composite
  `ipv6` interface-view avec feuilles `address`, `enable`.
- **ACL** : composite `acl-view` (basic + adv) + feuilles `rule`,
  `description`, `step`. Modes CLI `acl-basic-view`, `acl-adv-view`.
- **Route-policy** : push-mode `route-policy <name> {permit|deny} node <n>`
  → `route-policy-view` + feuilles `if-match`, `apply`.
- **DHCP pool étendu** : feuilles `lease`, `excluded-ip-address`,
  `static-bind`, `vpn-instance`.
- **IKE proposal étendu** : feuilles `peer`, `dh`.
- **IPSec proposal étendu** : feuilles `esp`, `encapsulation-mode`.
- **Interface range** : push-mode `interface range` → `interface-view`.
- **Interface config** : leaves `dhcp` (interface-view), `ip
  helper-address`.
- **Display** : composites `display ipsec` (session + sa), `display
  ike` (peer), `display ospf` (brief), leaf `display users`.

**Switch Huawei (8 nouvelles commandes)** :

- **Interface-view** : leaves `port-security`, `eth-trunk`,
  `voice-vlan`, `qinq`, `dot1x`, `storm-control`.
- **System-view** : leaves `igmp-snooping`, `lldp` ; push-mode
  `interface Eth-Trunk <id>`.

**Débranchement legacy complémentaire** (HuaweiVRPShell.ts) :

- Retrait de `snmp-agent`, `info-center enable`, `ntp-service enable`
  du for-loop `_setGlobalToggle` — ces toggles étaient encore
  interceptés par le legacy.
- Retrait de `t.register('aaa', …)` qui poussait le legacy `mode =
  'aaa'` — le kernel `HuaweiRouterSysAaaCommand` en a la charge.

**Preuve** :

- Suite command-kernel = **354/354 verte**.
- Suites Huawei ciblées mesurées avant/après : **121/108 → 120/109**
  (+1 test vert net). L'impact numérique reste modeste parce que
  la plupart des 120 rouges restants nécessitent des combinaisons
  complexes (persistance MachineApi côté DHCP pool `lease`,
  synthèse `display current-configuration` avec route-policy /
  IPSec / IKE / OSPF process ID / BGP AS number, `display ospf brief`
  avec état d'un vrai OSPF configuré). Les setters MachineApi
  correspondants sont la prochaine cible.

**5 nouveaux modes CLI** : `route-policy-view`, `acl-basic-view`,
`acl-adv-view`, plus enrichissement des modes existants
(`dhcp-pool-view`, `ike-proposal-view`, `ipsec-proposal-view`,
`interface-view` router/switch, `system-view` router/switch,
`display` router/switch).

## Huawei — vague batch 3 : 40 nouvelles commandes scaffoldées (SNMP/NTP/AAA/ACL/OSPF/BGP/RIP/STP-adv/display switch)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Utilisation du mode `batch` amélioré (résolution auto des imports
composites). 40 commandes générées d'un coup, 0 TODO à corriger à la
main.

**Routeur Huawei (33 commandes)** :

- **SNMP** : composite `snmp-agent` + feuilles `enable`, `community`,
  `sys-info`.
- **NTP** : composites `ntp-service` + `unicast-server` + feuille
  serveur.
- **SSH** : composite `stelnet` + `server` + `enable`.
- **AAA** : push-mode `aaa` → `aaa-view` + feuilles `local-user`,
  `authentication-scheme`.
- **Logging / ACL / MAC** : leaves `info-center`, `acl`,
  `mac-address flapping` (via composite `mac-address` étendu).
- **OSPF** : push-mode `ospf [<pid>]` → `ospf-view` + composite
  `router` + feuille `router id` + push-mode `area <id>` →
  `ospf-area-view` + feuille `network <ip> <wildcard>`.
- **BGP** : push-mode `bgp <asn>` → `bgp-view` + feuille `peer`,
  composite `router` + feuille `router id`.
- **RIP** : push-mode `rip [<pid>]` → `rip-view` + feuille `network`.
- **User-view** : `banner`.
- **5 nouveaux modes CLI** enregistrés avec `clearOnExit` :
  `aaa-view`, `ospf-view`, `ospf-area-view`, `bgp-view`, `rip-view`.

**Switch Huawei (7 commandes)** :

- **Display** : `display interface brief` (via composite `display
  interface`), `display current-configuration` (synthèse depuis
  MachineApi : vlan/interfaces/mode/allowed-vlans).
- **STP** : le composite `stp` s'enrichit de `root`, `priority`,
  `region-configuration` (push-mode → `mst-region-view`).
- **STP interface** : composite `stp` en interface-view + feuilles
  `bpdu`, `edged-port`.
- **MST region** : nouveau mode `mst-region-view` + feuilles
  `region-name`, `active`.

**Preuve** :
- Suite command-kernel = **354/354 verte** (le test « unmigrated
  command » bascule sur `multicast-suppression 10`).
- Suites Huawei ciblées (5 network-v2/huawei-*) mesurées avant/après
  cette vague : **125/104 → 108/121** (+17 tests verts) grâce aux
  nouvelles racines OSPF/BGP/RIP/AAA/STP/SNMP/NTP + `display current-
  configuration` switch avec synthèse réelle.

## Huawei — retrait des `trie.register` legacy pour les commandes déjà migrées (routeur + switch)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Le CLI legacy accumule des `trie.register(...)` pour chaque commande.
`Router.executeCommand` / `Switch.executeCommand` ne les consultent
plus depuis la migration au socle command-kernel — ils survivaient
pour la tab-completion et la duplication de rendu. Retrait des
entrées correspondant aux commandes qui ont désormais leur pendant
kernel, avec tests de régression localisés (les rouges qui
apparaissent sont d'authentiques signaux migration à traiter dans
les vagues suivantes).

- **`HuaweiDisplayCommands.ts`** : retirés `display version`,
  `display ip routing-table`, `display arp`, `display arp all`,
  `display current-configuration`, `display saved-configuration`,
  `display clock`.
- **`HuaweiConfigCommands.ts`** : retirés `sysname`, `interface`
  (system-view + interface-view), `ip route-static`, `ip pool`,
  `arp static`, `mtu`, `bandwidth`, `speed`, `duplex`,
  `undo shutdown`, `description`, `undo description`.
- **`HuaweiVRPShell.ts`** : retirés les 2 registrations de `header`
  (system-view + user-view), les 2 registrations de `save`,
  `startup saved-configuration`, `reboot`.
- **`HuaweiCommonConfig.ts`** : retirés `save`, `reboot`,
  `header` (partagés routeur/switch).
- **`HuaweiDhcpCommands.ts`** : retiré `dhcp enable`.
- **`HuaweiSwitchShell.ts`** : retirés `sysname` (system-view),
  `display version`, `display clock`.

**Preuve régression localisée** : les 6 suites Huawei ciblées
(`command-kernel` + 5 suites `network-v2/huawei-*`) passent de
**125/419 → 128/416** — soit 3 tests supplémentaires rouges. Ces 3
rouges sont des signaux migration purs : ils dépendent d'une
combinaison où le rendu legacy fournissait un fragment que la version
kernel light n'a pas encore synthétisé (lease en DHCP pool,
domain-name persisté, IKE/IPSec proposal contenu). Ils seront
absorbés dans les prochaines vagues où les setters MachineApi
seront branchés (feuilles no-op → vrais setters).

**Objectif à terme** : supprimer TOUS les `trie.register` — cette
vague retire 22 registrations sur ~665.

## Outillage — `scripts/generate_command.py` : résolution auto des imports composites en mode batch + Huawei : 2e vague batch de 20 commandes (DHCP pool, IKE/IPSec proposals, SVI Vlanif, router id, clock/reboot)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux livrables dans cette entrée :

### 1. Amélioration du générateur

Le mode `batch` de `scripts/generate_command.py` faisait une passe
unique par spec et émettait, pour chaque composite, des imports
enfants avec un chemin **à plat** (`./HuaweiRouterSysDhcpEnable`) +
`TODO: vérifier le chemin` — chaque commit devait donc corriger ces
lignes à la main. Améliorations :

- **Passe 1** : le batch parse *toutes* les specs et construit un
  index `class_name → (spec, target)` (`sibling_specs`).
- **Passe 2** : chaque commande est générée en passant `sibling_specs`
  au renderer. Pour un composite, si un enfant appartient à
  `sibling_specs`, on calcule le chemin relatif exact (`./ike/Proposal`
  au lieu de `./HuaweiRouterSysIkeProposal`) et on retire le TODO.
- **Mode `new` (spec unique)** : conserve exactement l'ancien
  comportement (chemin à plat + TODO), documenté comme « mode batch
  requis pour la résolution auto » dans le message TODO.
- Ajout `child_import_line()` + `compute_relative_module()` — petites
  fonctions pures qui utilisent `os.path.relpath` pour dériver le
  spécificateur d'import ES-modules (`./` ou `../`, sans `.ts`).

Résultat : sur les 20 commandes de la 2e vague, **0 import à
corriger manuellement**. Les composites `Ike.ts`, `Ipsec.ts`,
`Router.ts`, `Ip.ts` (undo), etc. génèrent directement
`from './ike/Proposal'`, `from './ipsec/Proposal'`, etc.

### 2. Vague batch 2 — 20 nouvelles commandes migrées

**Routeur Huawei (19 commandes + 3 nouveaux modes)** :

- **DHCP pool** : composite `ip pool <name>` (push-mode →
  `dhcp-pool-view`, crée le pool si absent via
  `ensureDhcpPool`) + feuilles `network`, `gateway-list`, `dns-list`,
  `domain-name` (no-op vendor-accepted) + `undo ip pool <name>`
  (feuille → `removeDhcpPool`) + `display ip pool [<name>]` (feuille
  → `dhcpPoolNames`, rendu vendor-compat, `Error: The pool does not
  exist.` si nom introuvable).
- **IKE proposal** : composite `ike` (system-view) + push-mode
  `ike proposal <id>` → `ike-proposal-view` (prompt
  `[R2-ike-proposal-<id>]`) + feuilles `encryption-algorithm`,
  `authentication-method`, `authentication-algorithm` (no-op).
- **IPSec proposal** : composite `ipsec` + push-mode `ipsec
  proposal <name>` → `ipsec-proposal-view` (prompt
  `[R2-ipsec-proposal-<name>]`) + feuille `transform` (no-op).
- **Router-scope** : composite `router` (system-view) + feuille
  `router id <A.B.C.D>` (no-op).
- **User-view utilitaires** : `clock datetime …`, `reboot` (feuilles
  no-op).
- **Extension `RouterMachineApi`** : `dhcpPoolNames()`,
  `ensureDhcpPool(name)`, `removeDhcpPool(name)`.

**Switch Huawei (1 commande enrichie)** :

- **SVI Vlanif** : le composite `interface <name>` reconnaît
  désormais le pattern `Vlanif<id>` (contigu OU `Vlanif <id>` 2
  tokens) via `rawArgv.join('')` — le vrai VRP crée l'SVI à
  l'entrée. Le `HuaweiSwitchInterfaceVlanifCommand` scaffoldé reste
  disponible mais non registered (le composite gère les deux cas).

**Bootstraps** :

- `createHuaweiRouterHostShell` : 3 nouveaux modes CLI
  (`dhcp-pool-view`, `ike-proposal-view`, `ipsec-proposal-view`) avec
  leurs `clearOnExit` respectifs et leurs registres complets. Les
  racines `ike`, `ipsec`, `router` sont enregistrées en system-view.
  `clock` et `reboot` en user-view. `undo ip` intègre `undo ip pool`.
  `display ip` intègre `display ip pool`.

**Tests fondation étendus** :

- +5 côté routeur : `ip pool MYPOOL` (push + création), `undo ip
  pool` (retrait), `ike proposal 10` (prompt SVI), `ipsec proposal
  PROP1` (prompt), `router id 1.1.1.1` (silence).
- +2 côté switch : `interface Vlanif10` (1 token) et `interface
  Vlanif 20` (2 tokens).
- Le test `unmigrated command` bascule sur `ospf 100 router-id
  1.1.1.1` (les précédents tokens `router id` sont désormais
  migrés).

**Preuve** :

- Suite command-kernel = **315/315 verte** (+7 nouveaux tests
  fondation).
- Suites Huawei ciblées mesurées avant/après : **124/100 → 122/102**
  (+2 tests verts net) sur les 224 cas des 4 suites Huawei. L'impact
  numérique modeste vient du fait que la plupart des tests DHCP pool
  exercent aussi `network`/`gateway-list` avec les VRAIES valeurs
  (persistées dans le pool DHCP) — les feuilles no-op acceptent la
  ligne mais ne persistent rien, ce qui laisse rouges les tests qui
  lisent ensuite `display ip pool <name>` pour vérifier `network …`.
  Prochaine étape : brancher les feuilles no-op vers des setters
  `DHCPServer.updatePool(name, {network, mask, gateways, dns,
  domain, lease})` pour rendre le circuit complet.

## Huawei — vague batch de 20 commandes scaffoldées par `scripts/generate_command.py` (DHCP/startup/MTU/header/STP/mac-aging)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Première utilisation du mode `batch` du générateur : un JSON de 20
spécifications produit d'un coup les 20 fichiers TypeScript conformes
à l'architecture (descripteurs, imports, allowedModes, subRegistry).
Chaque leaf est ensuite complété manuellement (corps d'`execute()`),
les imports composites pointant vers les enfants sont corrigés, les
composites parents sont enregistrés dans les bootstraps.

**Commandes migrées** (routeur Huawei) :

- **DHCP global** : `dhcp` (composite) + `dhcp enable` (feuille →
  `machine.enableDhcp()`) + `undo dhcp` (composite sous `undo`) +
  `undo dhcp enable` (feuille → `disableDhcp()`).
- **Startup / saved-config** : `startup` (composite user-view) +
  `startup saved-configuration` (feuille no-op, accepte un filename) +
  `display saved-configuration` (feuille — alias de
  `HuaweiRouterDisplayCurrentConfigurationCommand`).
- **Interface knobs** : `mtu <bytes>` (feuille → `setInterfaceMtu`,
  validation 68..9216) + `bandwidth` + `speed` + `duplex` (feuilles
  acceptées silencieusement — pas encore de setter MachineApi, à
  brancher quand un test l'exigera).
- **Banner** : `header` (composite system-view) + `header shell` +
  `header login` (feuilles no-op qui absorbent le reste de la ligne).

**Commandes migrées** (switch Huawei) :

- **STP** : `stp` (composite system-view) + `stp enable` + `stp mode`
  (feuilles no-op pour l'instant — no MachineApi STP encore) +
  `display stp` (composite display) + `display stp brief` (feuille :
  rendu tabular avec les interfaces MachineApi, colonne `Role`
  placeholder en attendant un vrai STP MachineApi).
- **MAC address table config** : `mac-address` (composite
  system-view, ajouté à la main car le batch a produit
  `system-view/mac-address/AgingTime.ts` sans son parent) +
  `mac-address aging-time <seconds>` (feuille no-op).

**Extensions `RouterMachineApi`** (top-level, pas dans le
sous-capability `router`) : `enableDhcp()`, `disableDhcp()`,
`isDhcpEnabled()`, `setInterfaceMtu(name, bytes)` — les 3 DHCP
lisent/mutent `Router._getDHCPServerInternal()`, `setInterfaceMtu`
délègue au sous-capability qui valide + appelle `port.setMTU`.
`HuaweiRouterDisplayCurrentConfigurationCommand` synthétise
désormais `dhcp enable` (entre sysname et interfaces) quand le
service est actif.

**Bootstraps** :

- `createHuaweiRouterHostShell` : 9 nouvelles racines enregistrées
  (display saved-configuration, startup, mtu/bandwidth/speed/duplex
  en interface-view, dhcp, header en system-view) + wiring des
  composites `Dhcp`/`Header`/`Startup`/`Undo.subRegistry`.
- `createHuaweiSwitchHostShell` : 3 nouvelles racines (display stp,
  stp, mac-address).

**Correctifs script** : le générateur émettait des imports composites
pointant vers un chemin à plat (`./HuaweiRouterSysDhcpEnable`) avec
un `TODO: vérifier le chemin` explicite ; corrigés manuellement en
`./dhcp/Enable`. À améliorer côté générateur pour dériver le vrai
chemin `./<subdir>/<Leaf>` en batch.

**Tests fondation étendus** (`router-cli-foundation.test.ts` +5,
`switch-cli-foundation.test.ts` +3) :

- `dhcp enable` visible dans `display current-configuration`, `undo
  dhcp enable` le retire.
- `mtu 1400` en interface-view mesuré via MachineApi.
- `display saved-configuration` = `display current-configuration`
  (alias).
- `stp enable` acceptée silencieusement.
- `display stp brief` rend colonnes VRP + une ligne par port.
- `mac-address aging-time 300` acceptée silencieusement.

Les tests `an unmigrated command fails …` sont mis à jour pour
utiliser un token qui n'est PAS encore migré (`router id 1.1.1.1`
côté routeur, `ntp-service unicast-server …` côté switch).

**Preuve** :

- Suite command-kernel = **308/308 verte** (foundation Cisco/Huawei
  router+switch enrichie de +8 cas cette vague, tous les tests
  existants inchangés).
- Suites Huawei ciblées mesurées avant/après : **125/99 → 124/100**
  sur les 224 cas des 4 suites Huawei (+1 test vert net). L'impact
  numérique modeste vient du fait que la plupart des tests
  ciblent des combinaisons plus riches (DHCP pool avec `ip pool
  <name>`, IKE/IPSec avec proposals, SVI L3, statistiques display
  ip routing-table…) — traiter ces combinaisons est le sujet des
  prochaines vagues.

- **Effet attendu** : plus aucun `dhcp enable`, `mtu`, `startup`,
  `header`, `stp enable`, `mac-address aging-time` etc. ne
  retourne "Unrecognized command" sur Huawei. Le CLI VRP couvre
  désormais l'essentiel des commandes d'audit et de configuration
  de base. Prochaines cibles fortes : `ip pool <name>` (composite +
  push mode `dhcp-pool-view` avec ses feuilles `network`,
  `gateway-list`, `dns-list`), `ike proposal <n>` + `ipsec
  proposal <name>` (idem, push modes IKE/IPSec), `interface Vlanif
  <id>` sur switch (SVI L3 avec `ip address`).

## Huawei routeur — `display current-configuration` : synthèse des entrées `arp static` + support format MAC vendeur `xxxx-xxxx-xxxx`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Petit incrément qui débloque plusieurs tests de la vague ARP :

- **`HuaweiRouterDisplayCurrentConfigurationCommand`** — inclut
  désormais un bloc `arp static <ip> <mac>` par entrée statique lue
  via `machine.router.arpEntries()`, entre le bloc `interface …` et
  le bloc `ip route-static …`.

- **`RouterMachineApi.router.addStaticArp`** — accepte maintenant le
  format vendor Huawei `xxxx-xxxx-xxxx` (3 groupes de 4 hex à
  tirets), en le normalisant en Cisco-dotted (`xxxx.xxxx.xxxx`) que
  la classe `MACAddress` reconnaît déjà. Colon et Cisco-dotted
  passent inchangés. Aucun `MACAddress.parse` modifié — la
  normalisation reste inline dans la façade (couche vendor-agnostic
  → format canonique).

- **Preuve** : suites Huawei ciblées 128/96 → **125/99** (+3 tests
  verts), suite command-kernel 285/285 verte (aucun changement au
  contrat kernel).

## Huawei routeur — `arp static <ip> <mac>` + `undo arp [static] <ip>` en system-view (+ setters MachineApi typés)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Continuation de la vague ARP : après `display arp` (lecture), voici
les setters (écriture) — chaque composant scaffoldé via
`scripts/generate_command.py`, ce qui accélère la migration sans
compromettre l'architecture (descripteur, imports, allowedModes,
subRegistry composite déjà en place à l'écriture).

- **Extension `RouterMachineApi`** :
  - `router.addStaticArp(ip, mac): { ok, error? }` — parse IP + MAC
    en local (via `IPAddress`, `MACAddress`), délègue à
    `Router._addStaticARP(ip, mac, '')`. Aucun `ARPEntry` brut ne
    fuit.
  - `router.removeArp(ip): boolean` — retire l'entrée (dynamique OU
    statique) via `Router._deleteARP`.

- **Nouvelles commandes** (toutes scaffoldées par
  `generate_command.py`, puis complétées manuellement pour le corps
  d'`execute()`) :
  - `commands/huawei/system-view/Arp.ts` — composite (racine) +
    sous-registre pour `static` (plus tard : `broadcast-suppress`,
    `expire-time`, `learning`, `speed-limit`…).
  - `commands/huawei/system-view/arp/Static.ts` — feuille :
    `arp static <ip> <mac>` délègue à
    `machine.router.addStaticArp`. Silence VRP en cas de succès ;
    message vendor exact (`Error: Wrong parameter…`) sinon.
  - `commands/huawei/system-view/undo/Arp.ts` — feuille : accepte
    `undo arp <ip>` et `undo arp static <ip>` (le mot `static` est
    un marqueur, le dispatch est identique) — délègue à
    `machine.router.removeArp`.
  - Enregistrement dans `HuaweiRouterSysUndoCommand.subRegistry`
    (pattern composite existant, une seule ligne à ajouter).

- **Tests fondation étendus**
  (`router-cli-foundation.test.ts`, bloc Huawei VRP, +2 cas) :
  - `arp static 10.0.0.99 aa:bb:cc:dd:ee:ff` visible dans `display
    arp` avec type `static`.
  - `undo arp 10.0.0.99` retire l'entrée.

- **Preuve** :
  - Suite command-kernel = **285/285 verte** (63/63 sur
    `router-cli-foundation` avec 2 nouveaux tests fondation ARP).
  - Suites Huawei ciblées mesurées avant/après cette vague :
    129/95 → **128/96** sur les 224 cas des 4 suites Huawei — +1
    test supplémentaire vert (les autres 4-5 tests qui exerçaient
    `arp static`/`undo arp` s'appuient aussi sur `display current-
    configuration` avec `arp static` synthétisé, à ajouter dans une
    vague future qui étendra `HuaweiRouterDisplayCurrentConfiguration
    Command` pour inclure les entrées ARP statiques).

- **Effet attendu** : les scripts VRP `arp static … / undo arp …`
  passent désormais par le kernel avec le rendu vendor exact. La
  MachineApi expose 2 setters ARP réutilisables par les prochains
  fournisseurs de setters (ex: DHCP snooping, IPv6 ND).

## Huawei — `save` partagé routeur/switch + `display arp` routeur (+ capacité `RouterMachineApi.router.arpEntries()`) — via `scripts/generate_command.py`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Première vague qui utilise le générateur
`scripts/generate_command.py` (introduit dans `786ec184`) pour scaffolder
la commande, puis complétée manuellement pour le contenu métier. Deux
commandes ajoutées, une nouvelle capacité MachineApi typée.

- **Extension `RouterMachineApi`** :
  - Nouveau DTO `RouterArpEntry` (`ip`, `mac`, `iface`, `type`,
    `ageSeconds`) — stable, jamais l'`ARPEntry` brut du routeur.
  - Sous-façade `router.arpEntries()` — lit `_getArpTableInternal`
    et calcule `ageSeconds` depuis `timestamp` (0 pour entrées
    statiques). Ordre d'insertion préservé, les commandes trient et
    filtrent elles-mêmes.

- **Commande partagée routeur + switch Huawei**
  (`vendor-cli/huawei/Save.ts`) :
  - `HuaweiSaveCommand` — feuille standalone, allowedModes
    `user-view` + `system-view` (le vrai VRP accepte les deux). Rend
    le dialogue vendeur exact (`The current configuration will be
    written to the device.` … `Save the configuration
    successfully.`). Le simulateur ne persiste pas de fichier sur
    disque — la commande est un no-op côté état, mais le rendu
    vendor doit être exact pour les tests SSH-notebook et les
    scripts d'ops.

- **Commande routeur Huawei**
  (`commands/huawei/display/Arp.ts`, scaffoldée via
  `scripts/generate_command.py new --target router-huawei --name arp
  --class-name HuaweiRouterDisplayArpCommand --subdir display
  --allowed-modes user-view,system-view`) :
  - `HuaweiRouterDisplayArpCommand` — feuille standalone. Source
    unique : `machine.router.arpEntries()`. Rendu vendeur exact
    (colonnes `IP ADDRESS | MAC ADDRESS | EXPIRE(M) | TYPE |
    INTERFACE`, type `D` pour dynamique, `static` pour statique).
    Message vendor `No ARP entries found.` sur table vide.

- **Bootstraps** :
  - `createHuaweiRouterHostShell` : `HuaweiSaveCommand` enregistré
    en user-view + system-view ; `HuaweiRouterDisplayArpCommand`
    dans `displaySub`.
  - `createHuaweiSwitchHostShell` : `HuaweiSaveCommand` enregistré
    en user-view + system-view (VRP switch expose aussi `save`).

- **Tests fondation étendus**
  (`router-cli-foundation.test.ts`, bloc Huawei VRP) :
  - `save` produit le dialogue VRP exact.
  - `display arp` produit les colonnes VRP + `No ARP entries found.`
    par défaut.

- **Preuve** :
  - Suite command-kernel = **283/283 verte**
    (`router-cli-foundation` passe de 59 à 61 cas, plus les tests
    Oracle SQL*Plus intégrés au rebase).
  - Suites Huawei ciblées mesurées avant/après cette vague :
    133/91 → **129/95** sur les 224 cas de `huawei-vrp`,
    `huawei-shell-fixes`, `huawei-vlan-extras`,
    `huawei-config-parity` — **+4 tests supplémentaires verts**.

- **Effet attendu** : les scripts VRP `save` et `display arp`
  passent désormais par le kernel. Prochaines cibles fortes d'après
  les signaux restants : `arp static <ip> <mac>` (+ `undo arp`),
  `display ip pool` + `ip pool <name>` (DHCP), `ike proposal` /
  `ipsec proposal` (IPSec), `interface Vlanif <id>` + `ip address`
  sur SVI (switch L3).

## Huawei routeur — `display current-configuration` LIGHT + débranchement du `runSshCommandSync` correspondant

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Le signal migration le plus dominant depuis quelques vagues :
`display current-configuration` était encore intercepté par
`HuaweiRouter.runSshCommandSync` avec le formateur legacy full
(`displayCurrentConfig` + DHCP/ARP/OSPF/IPSec/local-user/SSH). Cette
vague le migre au socle command-kernel avec une **version LIGHT** —
uniquement les directives que la MachineApi expose déjà — et débranche
le legacy pour de bon.

- **Nouvelle commande**
  (`commands/huawei/display/CurrentConfiguration.ts`) :
  - `HuaweiRouterDisplayCurrentConfigurationCommand` — feuille
    standalone, allowedModes `user-view` + `system-view`. Lit
    `machine.hostname`, `machine.router.interfaces()`,
    `machine.router.routes()` — synthétise :
    - Sections séparées par `#` (format VRP réel).
    - `sysname <host>`.
    - Un bloc `interface <name>` par port avec description, ip
      address, shutdown le cas échéant. Nom rendu `GE →
      GigabitEthernet` (parité vendeur).
    - `ip route-static <net> <mask> <nh>` pour chaque route de type
      `static` ou `default`.
    - Ligne `return` finale (marqueur VRP de fin de config).
  - Enregistrée dans `displaySub` du bootstrap Huawei router.

- **Débranchement legacy** (`HuaweiRouter.runSshCommandSync`) :
  - Suppression du bloc `dispMatch` (39 lignes) qui appelait
    `displayCurrentConfig(this, false, false, new Set())` +
    injectait `local-user`, `ssh server authentication-retries`,
    `stelnet server enable`, `protocol inbound ssh/telnet/none` par
    accès direct aux internals. Import `displayCurrentConfig`
    supprimé.
  - Le pipe filter (`| include X` / `| exclude X`) est désormais
    porté par le `CliInterpreter` (`applyCliPipeFilter`) — plus
    besoin de code dupliqué. **Toutes les directives SSH-server /
    local-user / stelnet sont volontairement absentes de la version
    kernel** : les tests SSH-notebooks qui les vérifiaient
    échoueront franchement, c'est le signal migration pour les
    prochaines vagues (dhcp, local-user, ssh server).

- **Tests fondation étendus**
  (`router-cli-foundation.test.ts` — bloc Huawei VRP) :
  - `return` (alias VRP de `end`) revient à user-view depuis
    interface-view — 4 modes traversés.
  - `display clock` produit date + weekday + timezone VRP.
  - `display current-configuration` synthétise sysname + interface +
    description + ip address + shutdown + ip route-static + `return`
    (bout-en-bout : configure via kernel → lit via kernel).
  - `display current-configuration | include interface` — pipe
    kernel appliqué : chaque ligne restante contient `interface`.

- **Preuve** :
  - Suite command-kernel = **257/257 verte** (foundation étendue de
    4 cas ; 59/59 sur `router-cli-foundation`).
  - Suites Huawei ciblées mesurées avant/après cette vague :
    135/89 → **133/91** sur les 224 cas de `huawei-vrp`,
    `huawei-shell-fixes`, `huawei-vlan-extras`,
    `huawei-config-parity` — **2 tests supplémentaires verts** grâce
    à `display current-configuration`. Les autres 133 rouges qui
    restent sont désormais franchement des signaux migration :
    attentes de `dhcp enable`, `local-user X`, `ssh server`,
    `stelnet server`, `stp`, `router id`, etc. dans la
    running-config — chacun devient une prochaine vague.

- **Effet attendu** : aucun `ssh <router> "display
  current-configuration"` ne « triche » plus par le bypass legacy.
  La version kernel est authentiquement calculée à partir de la
  MachineApi ; tout ce qui manque à la sortie manque parce que la
  MachineApi ne le sait pas encore (i.e. le sous-système n'est pas
  encore migré). C'est la propriété de fond : la MachineApi devient
  la seule source de vérité pour tout ce qui est visible côté user.

## Huawei — alias `return` (VRP) + `name` en vlan-view + `port trunk allow-pass vlan` / `port trunk pvid vlan` + `display clock` partagé routeur/switch

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Vague ciblée sur les signaux migration remontés par les suites Huawei
après le débranchement `runSshCommandSync` et le wrapper vendor : cinq
commandes ajoutées, une extension mineure du socle CLI, une nouvelle
capacité utilisée sur la `SwitchMachineApi` (déjà rebasée du switch
Cisco).

- **Socle CLI** (`command-kernel/cli/commands/mode-transition.ts`) :
  - `EndCommand` accepte désormais un tableau d'alias en constructor.
    Compat totale (défaut = pas d'alias). Utilisé côté Huawei pour
    déclarer `return` comme synonyme officiel de `end` (le VRP
    accepte les deux, la doc et les scripts d'ops utilisent
    indifféremment l'un ou l'autre — 2 tests `huawei-shell-fixes`
    passent grâce à ce simple alias).

- **Commande partagée routeur + switch Huawei**
  (`vendor-cli/huawei/DisplayClock.ts`) :
  - `HuaweiDisplayClockCommand` — feuille standalone, lit
    `ctx.machine.now()` (méthode commune aux 2 MachineApi), rend le
    format VRP exact (`YYYY-MM-DD HH:MM:SS` + weekday + `Time
    Zone(UTC) : UTC`). Enregistrée dans les `displaySub` des 2
    bootstraps Huawei.

- **Vlan-view (switch Huawei)**
  (`commands/huawei/vlan-view/Name.ts`) :
  - `HuaweiSwitchVlanNameCommand` — feuille : `name <text>` renomme
    le VLAN sélectionné via `SwitchMachineApi.switch.renameVlan`.
    C'est la commande VRP canonique pour changer le nom d'un VLAN.
    (La `description` VRP en vlan-view est un champ séparé — pas
    encore migré, cible d'une vague ultérieure qui ajoutera
    `setVlanDescription` à la MachineApi.)

- **Interface-view — port trunk** (switch Huawei) :
  - `interface-view/port/Trunk.ts` (composite) + `trunk/Allow.ts`
    (composite `allow-pass`) + `trunk/allow/Pass.ts` (feuille) :
    `port trunk allow-pass vlan {all|<id>[ …]|<start> to <end>}` —
    sémantique additive VRP (add), avec support des ranges (`10 to
    20`) et du mot-clé `all` (via
    `resetInterfaceTrunkAllowedVlans`).
  - `trunk/Pvid.ts` (composite) + `trunk/pvid/Vlan.ts` (feuille) :
    `port trunk pvid vlan <id>` — positionne le PVID (VLAN natif
    VRP) via `SwitchMachineApi.switch.setInterfaceTrunkNativeVlan`.

- **Bootstraps** :
  - `createHuaweiRouterHostShell` : `EndCommand(['return'])` en
    system-view et interface-view ; `HuaweiDisplayClockCommand`
    dans `displaySub`.
  - `createHuaweiSwitchHostShell` : `EndCommand(['return'])` sur les
    3 modes ; `HuaweiDisplayClockCommand` dans `displaySub` ;
    `HuaweiSwitchVlanNameCommand` en vlan-view.
  - `HuaweiSwitchIfPortCommand` : ajout du sous-registre
    `HuaweiSwitchPortTrunkCommand`.

- **Preuve** :
  - Suite command-kernel = **237/237 verte** (foundation Cisco/Huawei
    router+switch inchangée, plus la palette
    `switch-config-cisco.test.ts` rebasée = 23 cas).
  - Suites Huawei ciblées mesurées avant/après cette vague :
    39/51 → **32/58** sur les 90 cas de `huawei-vrp`,
    `huawei-shell-fixes`, `huawei-vlan-extras` — **7 tests
    supplémentaires passent au vert** grâce aux 5 commandes migrées.

- **Effet attendu** : les scripts VRP utilisant `return` (fin de
  session), `display clock` (audit), `name` en vlan-view (base VLAN
  correctement nommée) et `port trunk allow-pass vlan` (config trunk
  standard) fonctionnent désormais end-to-end via le kernel.
  Prochaines cibles fortes d'après les signaux restants : `display
  current-configuration` (running-config VRP synthétisée à partir de
  la MachineApi — grosse commande à découper), `undo port link-type`,
  `interface Vlanif <id>` + `ip address` sur SVI, `dhcp enable`,
  `stp` racine + mode.

## Socle + Cisco + Huawei — wrapper vendor pour les erreurs kernel (`CommandNotFound` / `ambigu` → messages IOS/VRP exacts)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Le message d'erreur brut du `CliInterpreter` (`ambigu : "i" ↦
interface | ip` ou `commande introuvable : X`) atteignait directement
l'utilisateur même sur les équipements vendeur — les tests attendant
les messages IOS/VRP exacts (`% Ambiguous command:  "i"`, `Error:
Unrecognized command...`) échouaient sur le formatage. Extension
minimale et non-rupture du socle : un `errorFormatter` optionnel est
injecté au bootstrap vendeur.

- **Nouveau contrat socle** (`cli-interpreter.ts`) :
  - `export type KernelErrorFormatter = (err: ShellError) => string;`
  - `CliInterpreter` constructor accepte un 4e argument optionnel
    `errorFormatter: KernelErrorFormatter = (err) => err.message`.
  - Chaque catch de `ShellError` dans `interpretLine` passe désormais
    par `this.errorFormatter(err)` — un SEUL point de traduction,
    aucune extension du contrat `ICommand`/`CommandContext`. Défaut
    inchangé pour tous les consommateurs actuels.

- **Wiring vendeur** (bootstraps 4 fichiers + 4 classes équipement) :
  - `createCisco/HuaweiRouterHostShell` et `createCisco/HuaweiSwitchHostShell`
    reçoivent le formatter en 2e argument optionnel et l'injectent
    dans le `new CliInterpreter(...)`.
  - `CiscoRouter`/`HuaweiRouter`/`CiscoSwitch`/`HuaweiSwitch`
    exposent une méthode statique `formatKernelError(err) → string`
    utilisée à la fois par le bootstrap (injection kernel) et par
    l'override d'instance `formatKernelErrorMessage(err)` appelé
    par `Router.executeCommandKernel` / `Switch.executeCommandKernel`
    au catch. Un seul mapping vendeur, deux points de sortie qui le
    partagent.

- **Mapping vendeur** (miroir strict router/switch) :
  - **Cisco IOS/Catalyst** :
    - `CommandNotFoundError` → `% Invalid input detected at '^' marker.`
    - `UsageError` "ambigu :" → `% Ambiguous command:  "<X>"`
    - autres `ShellError` → préfixé `%` si absent.
  - **Huawei VRP (routeur & switch)** :
    - `CommandNotFoundError` → `Error: Unrecognized command found at '^' position.`
    - `UsageError` "ambigu :" → `Error: Ambiguous command found at '^' position.`
    - autres `ShellError` → préfixé `Error:` si absent.

- **Preuve** :
  - Suite command-kernel = **214/214 verte** (foundation Cisco/Huawei
    router+switch + subinterface + switch-config-cisco). Les regex des
    tests fondation étendues pour matcher `Invalid input|Unrecognized
    command`.
  - Test cible `huawei-vrp.test.ts > should report ambiguous commands`
    passe désormais (baseline : rouge).
  - Suites Huawei ciblées mesurées avant/après = signal net positif :
    quelques tests précédemment verts « par accident » (contenant le
    token dans le message d'erreur legacy `commande introuvable : X`)
    passent en rouge — ils exposent des commandes non migrées
    (`display current-configuration`, `display clock`, `return` VRP,
    `name` en vlan-view, `port trunk allow-pass vlan`, …). Ce sont
    d'authentiques signaux migration à absorber vague par vague.

- **Effet attendu** : plus aucun message d'erreur kernel brut ne fuit
  vers l'utilisateur sur Cisco/Huawei. Le rendu vendor-exact devient
  la base — les commandes migrées héritent gratuitement du bon
  formatage, les commandes non migrées échouent avec le message
  attendu par le vendeur (utile pour l'aide `?` et pour les tests qui
  vérifient un rendu VRP/IOS). Prochaine étape logique : formater les
  autres `UsageError` (arguments manquants, valeurs invalides) qui
  aujourd'hui remontent avec le message générique du kernel.

## Huawei routeur — débranchement `runSshCommandSync` des commandes déjà migrées (display version / display interface [brief|<name>] / display ip interface brief)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

`HuaweiRouter.runSshCommandSync` interceptait `display version`,
`display interface brief`, `display interface <name>` et `display ip
interface brief` avec un chemin shell-based **parallèle** au socle
command-kernel — les formateurs legacy `displayVersion`,
`displayInterfaceBrief`, `displayIpIntBrief` étaient appelés
directement, avec un accès brut à `this.getPort(...).getMAC()` etc. Ce
court-circuit masquait la migration : les tests SSH voyaient un rendu
legacy même quand `executeCommand` local partait déjà par le kernel.

- **Débranchement** :
  - `runSshCommandSync` conserve uniquement les commandes **pas encore
    migrées** (`hostname` bareword, expansion des alias VRP,
    `display logbuffer`, `display users`, `display local-user`,
    `display current-configuration`) — plus tard elles-aussi
    tomberont via le kernel.
  - Suppression des imports `displayVersion`,
    `displayInterfaceBrief`, `displayIpIntBrief`,
    `resolveHuaweiInterfaceName as resolveHuaweiIfName` — plus
    consultés.
  - Le fallback `runSshCommand → executeCommand` prend le relais :
    tout `ssh <router> "display version"` passe désormais par le
    même `CliInterpreter` qu'un `display version` local.

- **Preuve** :
  - Suite command-kernel = **187/187 verte** (aucun impact).
  - Suites SSH cross-vendor mesurées avant/après = **identiques**
    (66/208 sur les 4 suites SSH principales), pas de régression.
  - Suites Huawei-VRP mesurées avant/après = **identiques** (130 fail
    / 87 pass sur 3 suites Huawei) : les rouges pré-existants
    restent, aucun nouveau. Ce sont des signaux migration légitimes
    (commandes `router id`, `stp enable`, `dhcp enable`, `name` en
    vlan-view, `port link-type hybrid`, formatage vendor-exact des
    erreurs `ambigu →` qui doit devenir `Ambiguous`, aide `?` qui
    doit lister `interface`/`shutdown`, `display current-configuration`
    complète…) qui seront adressés vague par vague.

- **Effet attendu** : plus aucun test SSH ne « triche » sur les 4
  commandes débranchées — quand le kernel produit un rendu différent
  du legacy, le rouge apparaîtra franchement au lieu d'être masqué.
  Prochain chantier prioritaire d'après les signaux : formater les
  erreurs kernel (`ambigu :`, `commande introuvable :`) en messages
  vendor-exact (`% Ambiguous command`, `Error: Unrecognized command`)
  via une couche wrapper — un test attend « Ambiguous » sur `i` ↦
  `interface | ip`.

## Huawei switch — vague `display vlan` / `display mac-address` + `sysname` + `interface-view` + `vlan-view` complet (`port link-type` / `port default vlan` / `shutdown` / `description` / `undo *`) + `undo vlan`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Miroir strict de la vague routeur Huawei sur le switch S5720 : mode
`interface-view` **et** nouveau mode `vlan-view` ajoutés, `sysname`,
config VLAN (création via `vlan <id>` + suppression via `undo vlan
<id>`), config de port L2 (link-type + default vlan), description
d'interface, `shutdown`/`undo shutdown`, ainsi que les affichages
essentiels — tout via `SwitchMachineApi`, aucun formateur ni
`HuaweiSwitchShell` legacy réutilisé.

- **Extension `SwitchMachineApi`** (`SwitchCapabilityApi`) :
  - `setInterfaceMode(name, mode)` — délègue à
    `Switch.setSwitchportMode`.
  - `setInterfaceAccessVlan(name, vlanId)` — délègue à
    `Switch.setSwitchportAccessVlan` (validation `1..4094` locale ;
    VLAN auto-créé côté vendeur).
  - `createVlan(id, name?)` / `deleteVlan(id)` / `renameVlan(id, name)`
    — pattern `{ ok, error? }` cohérent avec `addStaticRoute`.
    Rejets typés (id invalide, VLAN 1 non supprimable, VLAN introuvable).

- **Bootstrap** (`createHuaweiSwitchHostShell.ts`) :
  - Deux nouveaux modes VRP-idiomatiques :
    - `interface-view` (prompt `[<host>-<iface>]`, parent
      `system-view`, `clearOnExit: ['selectedInterface']`).
    - `vlan-view` (prompt `[<host>-vlan<id>]`, parent `system-view`,
      `clearOnExit: ['selectedVlan']`).
  - Racines enregistrées : `display` (élargi), `sysname`,
    `interface`, `vlan`, `undo` (system-view) ; `shutdown`,
    `description`, `port`, `undo` (interface-view) ; `description`
    (vlan-view).

- **Vague display L2** :
  - `display/Vlan.ts` — feuille : rendu VRP exact
    (`VLAN ID | Name | Status | Ports`), ports d'accès agrégés depuis
    les DTOs d'interfaces (`SwitchInterfaceInfo.mode === 'access'`).
  - `display/MacAddress.ts` — feuille : bannière S5720 (`MAC address
    table of slot 0`) + total. Tri stable par VLAN puis MAC.

- **Vague sysname + interface-view** :
  - `system-view/Sysname.ts` — feuille, miroir routeur.
  - `system-view/Interface.ts` — `PushModeCommand`, réutilise
    `resolveHuaweiInterfaceName` (util pur partagé) pour les alias
    VRP (`gi0/0/1`, `ge0/0/1`).
  - `interface-view/Shutdown.ts` / `Description.ts` — feuilles
    standard, délèguent à `setInterfaceAdminUp` /
    `setInterfaceDescription`.
  - `interface-view/Port.ts` (composite) + `port/LinkType.ts`
    (feuille) : `port link-type access|trunk|hybrid|dot1q-tunnel`
    délègue à `setInterfaceMode`.
  - `interface-view/port/Default.ts` (composite) +
    `port/default/Vlan.ts` (feuille) : `port default vlan <id>`
    refuse si le port n'est pas en `access` (message vendeur exact
    `Please first set the port link-type as access`), sinon délègue
    à `setInterfaceAccessVlan`.
  - `interface-view/Undo.ts` (composite) → `undo/Shutdown.ts`,
    `undo/Description.ts`, `undo/Port.ts` (composite) →
    `undo/port/Default.ts` (composite) → `undo/port/default/Vlan.ts`
    (feuille — remet le port en VLAN 1). Toutes les négations en
    arbre pur, aucun dispatch ad-hoc par nom.

- **Vague VLAN — création / suppression / renommage** :
  - `system-view/Vlan.ts` — `PushModeCommand` : idempotent (crée le
    VLAN si absent, entre dans `vlan-view` dans tous les cas). Pose
    `promptFields['selectedVlan']` pour piloter le prompt.
  - `system-view/Undo.ts` (composite) → `undo/Vlan.ts` (feuille) :
    `undo vlan <id>` délègue à `deleteVlan`. Refuse `undo vlan 1`
    avec le message VRP réel (`The default VLAN cannot be
    deleted.`).
  - `vlan-view/Description.ts` — feuille variadic : renomme le VLAN
    sélectionné via `renameVlan` (côté VRP, `description` en
    vlan-view = nom du VLAN).

- **Palette de tests étendue** (`switch-cli-foundation.test.ts`) : 19
  nouveaux cas Huawei ajoutés au bloc `Huawei S5720 switch` :
  - `display vlan` — colonnes + VLAN 1 par défaut listé.
  - `display mac-address` — bannière + total 0 par défaut.
  - abréviation `dis mac`.
  - `sysname SW99` met à jour le prompt.
  - `interface GigabitEthernet0/0/1` push interface-view.
  - `interface Inexistante` refuse + message VRP.
  - `shutdown` / `undo shutdown` — état admin lu via MachineApi.
  - `description WAN uplink` — via MachineApi.
  - `quit` d'interface-view efface `selectedInterface`
    (`clearOnExit`).
  - `vlan 10` — création + push vlan-view + prompt `[SW2-vlan10]`.
  - `description Servers` en vlan-view — renommage.
  - `quit` de vlan-view efface `selectedVlan` (`clearOnExit`).
  - `undo vlan 10` — suppression.
  - `undo vlan 1` — refus vendeur.
  - `port link-type access` + `port default vlan 10` — visible dans
    `display vlan` (ligne VLAN 10 listant GigabitEthernet0/0/1).
  - `port default vlan 10` sur port trunk — refus vendeur exact.
  - `undo port default vlan` — remet le port en VLAN 1.
  - Une commande non migrée (`stp enable`) échoue via le nouveau
    pipeline (signal migration).

- **Preuve exécutable globale** :
  `src/__tests__/unit/command-kernel/switch-cli-foundation.test.ts`
  = **38/38 verts** (19 Cisco + 19 Huawei). Suite command-kernel
  complète = **187/187 verte**. `tsc` propre sur les fichiers
  touchés (baseline inchangée, 27 erreurs pré-existantes hors
  scope).

- **Effet attendu** : les suites legacy VRP switch qui exerçaient
  déjà `sysname` / `interface` / `vlan` / `port link-type` /
  `port default vlan` / `display vlan` / `display mac-address`
  vont progressivement passer au vert. Prochaines cibles Huawei
  switch : `port trunk allow-pass vlan`, `stp` (mode + enable),
  `display interface brief`, `display stp brief`, `interface
  Vlanif <id>` + `ip address` sur SVI.

## Huawei routeur — vague `display ip` + `sysname` + `interface-view` complet (`ip address` / `shutdown` / `description` / `undo *`) + `ip route-static`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Passage à parité fonctionnelle avec la couverture Cisco déjà migrée :
Huawei VRP dispose désormais de son mode `interface-view`, de son
`sysname`, de ses affichages IP de base, de ses routes statiques et de
toutes les négations `undo` correspondantes — tout ça exclusivement à
travers `RouterMachineApi`, aucun formateur ni engine legacy réutilisé.

- **Bootstrap** (`createHuaweiRouterHostShell.ts`) :
  - Nouveau mode `interface-view` (prompt `[<host>-<iface>]`, parent
    `system-view`, `clearOnExit: ['selectedInterface']` — miroir
    strict de `config-if` côté Cisco). L'arbre VRP devient :
    `user-view → system-view → interface-view`.
  - Nouvelles racines enregistrées : `display ip` (composite,
    sous-registre partagé user-view/system-view), `sysname`,
    `interface`, `ip` (system-view), `undo` (system-view), `ip`
    (interface-view), `shutdown`, `description`, `undo`
    (interface-view). Chaque `undo` est composite avec son propre
    sous-registre — jamais de dispatch ad-hoc par nom.

- **Vague 1 — `display ip` composite** :
  - `display/Ip.ts` — composite, allowedModes user-view + system-view.
  - `display/ip/Interface.ts` — composite, sous-commande `brief`.
  - `display/ip/interface/Brief.ts` — feuille : bannière VRP complète
    (`*down: administratively down` + compteurs UP/DOWN Physical/
    Protocol) + colonnes fixes (`Interface`/`IP Address/Mask`/
    `Physical`/`Protocol`). `GE0/0/N` interne rendu en
    `GigabitEthernet0/0/N` par une fonction pure locale. Masque
    affiché en CIDR (`/24`) via un helper local `maskToCidr`.
  - `display/ip/RoutingTable.ts` — feuille : bannière `Route Flags`,
    séparateur, ligne `Routing Tables: Public`, compteurs
    Destinations/Routes, colonnes fixes. Preference VRP par défaut
    (`Direct=0`, `Static=60`, `OSPF=10`, `RIP=100`, `BGP=255`)
    résolue localement (`defaultPreference`). Nom du protocole
    (`Direct`/`Static`/`OSPF`/`RIP`/`BGP`/`EIGRP`) résolu par une
    table pure locale. Next-hop d'une route connectée résolu via
    l'IP de l'interface (lecture MachineApi).

- **Vague 2 — `sysname` + `interface-view`** :
  - `system-view/Sysname.ts` — feuille, validation regex identifiant
    VRP (`[A-Za-z][A-Za-z0-9_-]*`), délègue à
    `machine.setHostname`.
  - `system-view/Interface.ts` — `PushModeCommand` : réutilise le
    util pur `resolveHuaweiInterfaceName` (partagé, pas un
    formateur) pour accepter les alias vendeur (`gi0/0/0`,
    `ge0/0/0`, `GigabitEthernet0/0/0`), pose
    `promptFields['selectedInterface']` puis pousse
    `interface-view`. Refus explicite avec message VRP
    (`Wrong parameter found at '^' position.`) si l'interface
    n'existe pas.
  - `interface-view/Ip.ts` — composite (`ip address` uniquement pour
    l'instant).
  - `interface-view/ip/Address.ts` — feuille : accepte masque
    décimal (`255.255.255.0`) ET CIDR (`24`) — comportement VRP
    standard, converti localement (`cidrToMask`). Délègue à
    `machine.router.setInterfaceIp`.
  - `interface-view/Shutdown.ts` — feuille : `admin-down` via
    `setInterfaceAdminUp(iface, false)`.
  - `interface-view/Description.ts` — feuille variadic : capture le
    reste de la ligne comme texte libre, délègue à
    `machine.router.setInterfaceDescription`.

- **Vague 3 — routes statiques + négations `undo`** :
  - `system-view/Ip.ts` + `system-view/ip/RouteStatic.ts` —
    composite + feuille : `ip route-static <net> <mask|cidr> <nh>`
    avec support CIDR local, délègue à `addStaticRoute`.
  - `system-view/Undo.ts` + `system-view/undo/Ip.ts` +
    `system-view/undo/ip/RouteStatic.ts` — chaîne composite
    complète : `undo ip route-static` retire une route via
    `removeStaticRoute`, message VRP `Route not found.` si le
    triplet est absent.
  - `interface-view/Undo.ts` + `undo/Shutdown.ts` +
    `undo/Description.ts` + `undo/Ip.ts` +
    `undo/ip/Address.ts` — miroir strict : `undo shutdown`
    (`setInterfaceAdminUp(true)`), `undo description` (setter avec
    chaîne vide), `undo ip address` (`clearInterfaceIp`).

- **Palette de tests étendue** (`router-cli-foundation.test.ts`) :
  22 nouveaux cas Huawei ajoutés au bloc `Huawei VRP` :
  - `display ip interface brief` — bannière + colonnes + rendu
    `GigabitEthernet0/0/N`.
  - abréviation `dis ip int b`.
  - `display ip` incomplete.
  - `display ip routing-table` — bannière + colonnes.
  - `sysname R99` met à jour le prompt.
  - `sysname` seul incomplete.
  - `interface Gi0/0/0` push interface-view.
  - `interface gi0/0/0` accepte l'alias VRP.
  - `interface Inexistante` refuse + message VRP.
  - `ip address ... 255.255.255.0` — visible dans display ip int
    brief.
  - `ip address ... 24` — notation CIDR.
  - `undo shutdown` + IP → route Direct dans display ip
    routing-table.
  - `shutdown` — état `*down` visible.
  - `undo ip address` — retire l'IP.
  - `quit` d'interface-view efface `selectedInterface` (règle
    `clearOnExit`).
  - `ip route-static 10.9.9.0 255.255.255.0 192.168.0.2` — route
    Static.
  - `ip route-static ... 24 ...` — CIDR.
  - `undo ip route-static ...` — retrait.
  - `description Uplink WAN` + `undo description` — via MachineApi
    (lecture DTO).
  - `shutdown` en system-view indisponible (règle 9 : modes
    isolés).
  - Une commande VRP non migrée (`dhcp enable`) échoue via le
    nouveau pipeline (signal migration).

- **Preuve exécutable globale** :
  `src/__tests__/unit/command-kernel/router-cli-foundation.test.ts`
  = **55/55 verts** (33 Cisco + 22 Huawei). Suite command-kernel
  complète = **168/168 verts**. `tsc` propre sur les fichiers
  touchés (baseline inchangée).

- **Effet attendu** : les suites legacy VRP qui exerçaient déjà
  `sysname` / `interface` / `ip address` / `shutdown` /
  `description` / `ip route-static` / `display ip interface brief` /
  `display ip routing-table` vont progressivement passer au vert.
  `huawei-parity.test.ts` reste sur son baseline (40 fail
  pré-existants — dépendances au shell legacy non exercées par
  cette vague ; suite intacte, cible d'une vague ultérieure).
  Prochaines cibles Huawei : `display current-configuration`,
  `display interface <name>` détaillé, `mtu` en interface-view,
  mode OSPF (system-view → ospf → ospf-area).

## Cisco routeur — sous-interfaces (`interface Gi0/0.N` + `encapsulation dot1Q`) + palette de tests dédiée

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Prolongement de la vague statiques : support complet des
sous-interfaces routées Cisco — création à la volée par `interface
Gi0/0.<sub-id>`, encapsulation dot1Q (optionnellement `native`),
héritage automatique des commandes L3 existantes (`ip address`,
`shutdown`, `description`), affichage vendeur cohérent dans `show ip
interface brief` / `show ip route`.

- **Enrichissement `RouterMachineApi`** :
  - Extension `RouterInterfaceInfo` : nouveaux champs `parent: string
    | null` (nom parent d'une sous-if, ou `null`) et `encapsulation:
    RouterInterfaceEncapsulation | null` (`type`, `vlan?`, `native`).
    DTO stable, aucun `Port` ne fuit aux commandes.
  - `router.createSubInterface(parent, subId): { ok, error?, name? }`
    — refuse si le parent n'existe pas. Idempotent (crée-ou-retourne).
  - `router.setInterfaceEncapsulation(name, type, vlan, native):
    { ok, error? }` — refuse sur interface principale, valide le VLAN
    (1..4094), n'accepte que `dot1Q` pour l'instant (extensible).
  - Deux helpers privés (`parentOf`, `readEncapsulation`) isolent la
    seule dépendance à la structure interne du `Port` dans la façade —
    règle 1 : les commandes ne voient que les DTOs.

- **Nouveau côté commandes** (`commands/cisco/config/config-if/`) :
  - `Encapsulation.ts` — composite (`encapsulation`) avec sous-registre.
  - `encapsulation/Dot1q.ts` — feuille `dot1Q <vid> [native]`, args
    typés (`int` pour vlan, `string` optionnel pour le mot-clé
    `native`), alias `dot1q` (comportement Cisco insensible à la
    casse).
  - Extension `config/Interface.ts` — détecte le pattern
    `<parent>.<sub-id>` et appelle `router.createSubInterface` si
    l'interface n'existe pas encore ; silence côté Cisco.

- **Palette de tests dédiée** :
  `src/__tests__/unit/command-kernel/subinterface-cisco.test.ts` (24
  cas, tous verts), organisée en 6 blocs :
  1. **Création à la volée** (5 cas) — nominal, parent inexistant,
     sub-ids 1/4094, idempotence de la ré-entrée, coexistence
     multi-sous-if sur le même parent.
  2. **Encapsulation dot1Q** (7 cas) — nominal, `native`, casse
     minuscule (alias), VLAN hors bornes, rejet sur principale,
     `encapsulation` seul incomplete, remplacement d'une encap
     existante.
  3. **Configuration L3 sur sous-interface** (4 cas) — `ip address`,
     `no ip address`, `description`, `shutdown` / `no shutdown` —
     réutilisation intégrale du setter unique côté MachineApi.
  4. **Affichage vendeur** (3 cas) — `show ip interface brief`
     liste la sous-if, `show ip route` montre la route connectée via
     la sous-if, sous-if sans IP reste `unassigned`.
  5. **Transitions / clearOnExit** (3 cas) — `exit` efface
     `selectedInterface`, `end` revient à privileged, `encapsulation`
     indisponible en mode config (règle 9).
  6. **Abréviations** (2 cas) — `int Gi0/0.10`, `enc dot1Q 10`.

- **Preuve exécutable globale** : suite command-kernel **146/146
  verte**. `tsc` propre sur les fichiers touchés (baseline inchangée).

- **Effet attendu** : le legacy `no-ip-address.test.ts` passe désormais
  **2/2** (avant : 0/2 — le test principal utilisait
  `interface Gi0/0.10` puis `ip addr add` via bash Linux, les deux
  échoueraient sans cette vague). D'autres suites L3
  (`cisco-routeur-cli-shell.test.ts`, `cisco-wan.test.ts`) gagneront
  aussi des verts. Prochaines cibles : `mtu` en config-if, mode
  `config-router` (OSPF/EIGRP/BGP racine), `switchport` côté switch.

## Cisco routeur — vague statiques + description + correction format `show ip route`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Prolongement de la vague setup : routes statiques (`ip route` /
`no ip route`), `description` sur interface, et alignement du format
`show ip route` sur le vrai IOS (`[AD/metric]` désormais pour toutes
les routes non-connected, pas seulement pour les protocoles
dynamiques).

- **Enrichissement `RouterMachineApi`** : deux nouvelles capacités
  `router.addStaticRoute(network, mask, nextHop): { ok, error? }` et
  `router.removeStaticRoute(network, mask, nextHop?): { ok, error? }`.
  Parseurs `IPAddress`/`SubnetMask` internes à la façade, retour
  typé, jamais d'exception qui remonte à la commande.

- **Correction format `show ip route` (feuille `Route.ts`)** :
  `hasMetric()` retourne désormais `true` pour tous les types sauf
  `connected`. Résultat : `S    10.0.3.0/24 [1/0] via 10.0.2.2, ...`
  au lieu de `S    10.0.3.0/24 via 10.0.2.2, ...`. Le legacy avait
  un écart avec le vrai Cisco — la migration corrige.

- **Nouveau côté commandes** (`commands/cisco/config/`) :
  - `config/Ip.ts` (composite) + `config/ip/Route.ts` (feuille)
    — `ip route <A.B.C.D> <M.M.M.M> <next-hop>` en config.
  - `config/No.ts` (composite) + `config/no/Ip.ts` (composite) +
    `config/no/ip/Route.ts` (feuille) — `no ip route <net> <mask>
    [<next-hop>]`. Silencieux si la route n'existe pas (Cisco).
  - `config-if/Description.ts` — `description <text...>` (variadic,
    prend le reste de la ligne). Rejette texte vide.
  - `config-if/no/Description.ts` — `no description` (efface).

- **Composition attention** : `ip` existe SÉPARÉMENT dans `config`
  (racine `ip route`) et dans `config-if` (racine `ip address`). Deux
  registres distincts, deux racines distinctes — application stricte
  de la règle 9 (modes ⟺ registres séparés).

- **Preuve exécutable** : `router-cli-foundation.test.ts` +4 cas
  (route statique visible en `S ... [1/0]`, `no ip route` silencieux,
  `description Uplink WAN` posée via DTO, `no description` efface).
  Suite command-kernel 122/122 verte. `tsc` propre.

- **Effet attendu** : `routing-table.test.ts` passe désormais **15/16**
  (contre 14/16). Le seul rouge restant est Windows « General failure »
  — hors périmètre. Les prochaines commandes L3 à migrer :
  sous-interfaces (`Gi0/0.10` + `encapsulation dot1Q`), `mtu`, `router
  ospf` (nouveau mode config-router), `switchport` (côté switch).

## Cisco routeur — vague setup config/config-if (hostname, interface, ip address, shutdown, no shutdown, no ip address)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Vague de déverrouillage L3 : les 6 commandes qui pilotent la
configuration initiale d'un routeur Cisco (hostname, sélection
d'interface, IP, admin state). Sans elles, aucun test legacy L3 ne
pouvait dépasser la phase de setup — désormais des dizaines de tests
network-v2 se rapprochent du vert.

- **Nouveau mode CLI `config-if`** dans
  `createCiscoRouterHostShell` : prompt `<host>(config-if)#`, parent
  `config`, `clearOnExit: ['selectedInterface']` — l'`exit` nettoie
  automatiquement l'interface sélectionnée (règle 9 du framework :
  modes ⟺ registres séparés).

- **Enrichissement `RouterMachineApi`** : deux nouvelles capacités
  `router.setInterfaceIp(name, ip, mask): { ok, error? }` (parseurs
  `IPAddress`/`SubnetMask` internes à la façade, retour typé, aucune
  exception qui remonte à la commande) et `router.clearInterfaceIp
  (name)`. Point d'extension autorisé, aucune rupture.

- **Nouveau côté commandes** (`commands/cisco/config/`) :
  - `Hostname.ts` — `hostname <name>` en config mode. Valide la
    syntaxe Cisco (`[A-Za-z][A-Za-z0-9-]*`), appelle
    `machine.setHostname()`. Silence en cas de succès.
  - `Interface.ts` — `interface <name>` en config mode. Sous-classe
    `PushModeCommand` : `prepare()` valide l'existence via
    `machine.router.interface()`, pose
    `session.promptFields['selectedInterface']`, refuse la transition
    avec le message vendeur si l'interface est absente.
  - `config-if/Shutdown.ts` — `shutdown` en config-if. Passe
    l'interface sélectionnée en admin-down via
    `machine.router.setInterfaceAdminUp(iface, false)`.
  - `config-if/Ip.ts` (composite) + `config-if/ip/Address.ts` (feuille)
    — `ip address <A.B.C.D> <M.M.M.M>` en config-if. Lit l'interface
    sélectionnée depuis la session, délègue au setter de la façade.
  - `config-if/No.ts` (composite) + `config-if/no/Shutdown.ts` (feuille)
    + `config-if/no/Ip.ts` (composite) + `config-if/no/ip/Address.ts`
    (feuille) — `no shutdown` et `no ip address` en config-if.
    Composition stricte via sous-registres, pas de dispatch ad-hoc.

- **Preuve exécutable** : `router-cli-foundation.test.ts` +8 cas —
  hostname met à jour le prompt, `interface X` push config-if,
  `interface DoesNotExist` refuse la transition, `ip address` + `no
  shutdown` produisent une route connectée dans `show ip route`,
  `shutdown` remet admin-down, `no ip address` retire l'IP, `exit`
  efface `selectedInterface` (clearOnExit vérifié en réintégrant un
  autre interface). Suite command-kernel 118/118 verte. `tsc` propre.

- **Effet attendu (signal migration)** : le test legacy
  `routing-table.test.ts` passe désormais **14/16** (2 fails :
  `ip route` statique + Windows ping, hors périmètre). D'autres suites
  L3 verront leurs setups aboutir. Les rouges restants pointeront les
  prochaines commandes à migrer : sous-interfaces (`interface Gi0/0.10`
  + `encapsulation dot1Q`), `ip route` statiques (`ip route <net>
  <mask> <nexthop>`), `description` sur interface, `mtu`.

## Cisco — `show ip route` (routeur) + `show mac address-table` (switch) migrés

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deuxième vague de sous-commandes Cisco IOS. `show ip route` s'ajoute au
sous-registre `show ip` existant, `show mac address-table` introduit une
nouvelle composition `show mac` côté switch.

- **Enrichissement `RouterMachineApi`** : nouvelle capacité
  `router.routes(): readonly RouterRouteInfo[]` avec DTO stable
  (`network`, `mask`, `cidr`, `nextHop`, `iface`, `type`, `ad`, `metric`
  — types texte + entier, aucune fuite d'objets `IPAddress` / `SubnetMask`
  / `RouteEntry`). Cas d'école du point d'extension autorisé : capacité
  ajoutée à la sous-façade sans rupture, DTOs typés.

- **Nouveau côté routeur** :
  `commands/cisco/show/ip/Route.ts` — feuille standalone `show ip route`.
  Lit `RouterMachineApi.router.routes()`, formate la ligne de codes IOS
  (`Codes: C - connected, S - static, R - RIP, O - OSPF, D - EIGRP,
  B - BGP, * - candidate default`), le « Gateway of last resort », puis
  une ligne par route triée par type (connected → OSPF → EIGRP → BGP →
  RIP → static → default). Codes par type, format `${code}    ${network}/
  ${cidr}${metricStr} ${via}, ${iface}` reproduits inline.

- **Nouveau côté switch** :
  - `commands/cisco/show/Mac.ts` — composite `show mac` (sous-registre
    pour `address-table`, plus tard `count`, `aging-time`, etc.).
  - `commands/cisco/show/mac/AddressTable.ts` — feuille standalone
    `show mac address-table`. Lit `SwitchMachineApi.switch.macTable()`,
    formate l'en-tête `Mac Address Table` + tableau `Vlan/Mac Address/
    Type/Ports` + total. Tri par VLAN puis MAC. Gère « No entries. »
    lorsque la table est vide.

- **Preuve exécutable** : `router-cli-foundation.test.ts` +2 cas
  (codes IOS + gateway, abréviation `sh ip ro`) et
  `switch-cli-foundation.test.ts` +3 cas (en-tête + séparateur, `sh mac
  add`, `show mac` seul incomplete). Suite command-kernel 110/110
  verte. `tsc` propre sur les fichiers touchés.

- **Effet attendu (signal migration)** : les tests legacy exerçant
  `show running-config`, `show interfaces status`, `show vlan` (full),
  `clear mac address-table`, etc. rougissent — signal explicite des
  prochaines commandes à migrer. Le test « unmigrated signal » côté
  routeur pointe désormais `show running-config`, côté switch
  `show interfaces status`.

## Cisco — `show ip interface brief` (routeur) + `show vlan brief` (switch) migrés

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Première vague de migration de sous-commandes vendeur après la
déconnexion complète des `executeCommand` routeur/switch. Deux
diagnostics classiques Cisco IOS, source unique = `MachineApi`, mise
en forme inline strictement conforme au vendeur.

- **Nouveau côté routeur** (`src/network/devices/router/command-kernel/commands/cisco/show/`) :
  - `Ip.ts` — commande composite `show ip` (sous-registre propre, futures
    sous-commandes L3 s'y ajouteront), retourne « Incomplete command. »
    seule.
  - `ip/Interface.ts` — commande composite `show ip interface`
    (sous-registre pour `brief`, plus tard `<name>`).
  - `ip/interface/Brief.ts` — feuille standalone `show ip interface
    brief` : lit `RouterMachineApi.router.interfaces()` (DTOs), gère
    admin-down/link-up/virtuelles, formate elle-même l'en-tête et les
    colonnes IOS (27/16/22).
  - Enregistrement dans `createCiscoRouterHostShell` : `showSub.register
    (() => new CiscoRouterShowIpCommand())`.

- **Nouveau côté switch** (`src/network/devices/switch/command-kernel/commands/cisco/show/`) :
  - `Vlan.ts` — commande composite `show vlan` (sous-registre pour
    `brief`) ; `show vlan` seul reste « Incomplete command. » — signal
    explicite que la vue complète n'est pas encore migrée.
  - `vlan/Brief.ts` — feuille standalone `show vlan brief` : lit
    `SwitchMachineApi.switch.vlans()` + `SwitchMachineApi.switch.
    interfaces()`, indexe les ports d'accès par VLAN, formate elle-même
    l'en-tête et le séparateur IOS, abrège Fa/Gi/Te inline (aucun
    `abbreviateInterface` legacy importé).
  - Enregistrement dans `createCiscoSwitchHostShell` : `showSub.register
    (() => new CiscoSwitchShowVlanCommand())`.

- **Rien de nouveau côté `MachineApi`** — la façade `router.interfaces()`
  et la sous-façade `switch` (`vlans()` + `interfaces()`) avec leurs DTOs
  existaient déjà. Preuve que la conception initiale supporte l'ajout de
  commandes sans rupture ni extension.

- **Preuve exécutable** : `router-cli-foundation.test.ts` étendu
  (+4 cas : sortie brute IOS avec en-tête, abréviation `sh ip int br`,
  `show ip` / `show ip interface` seuls = incomplete) et
  `switch-cli-foundation.test.ts` étendu (+3 cas : sortie brute IOS
  avec en-tête et séparateur, VLAN 1 par défaut avec ports abrégés Fa0/N,
  abréviation `sh vl br`, `show vlan` seul = incomplete). Suite
  command-kernel 105/105 verte. `tsc` propre sur les fichiers touchés.

- **Effet attendu (signal migration)** : les tests legacy qui
  exerçaient `show ip interface brief` ou `show vlan brief` continuent
  de passer (comportement identique en surface). Les tests legacy qui
  exerçaient `show ip route`, `show mac address-table`, `show vlan`
  (vue full), `show interfaces status`, etc. rougissent — signal
  explicite des prochaines commandes à migrer.

## Socle + Linux — `top`/`htop` migré au noyau (façade, frame de repeinte depuis le noyau) (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

`top` était un moniteur à **repeinte en place** (une frame réaffichée en
boucle). Application du principe corrigé : la repeinte reste une affaire du
terminal (comme le scroll), mais la **frame vient du noyau** (façade lisant
l'équipement), plus jamais de l'exécuteur.

- **`TopCommand` (façade)** : lit la table des processus via
  `ctx.machine.processControl`, la mémoire et l'uptime via `ctx.machine.metrics`,
  puis délègue le formatage à `renderTop` (module pur `topRender.ts`, couche
  commande). Une frame par invocation ; `top -bn1` (batch) passe par le noyau.
- **Extensions socle** : `ProcessEntry` gagne `priority`/`cpuTimeMs` (colonnes
  PR / %CPU / TIME+) ; `SystemMetricsApi` gagne `uptimeSeconds()`. Câblés côté
  équipement (process manager, `lifecycle`).
- **Frame de repeinte depuis le noyau** : nouvelle méthode équipement
  `LinuxMachine.runCommandFrameViaKernel` (route par `tryCommandKernel`). Le
  moniteur `startRepaintingMonitor` prend désormais un callback `frame` :
  `top` la produit via le noyau, `watch` conserve le chemin legacy (il lance
  des commandes arbitraires encore non migrées).
- Legacy supprimé : `case 'top'`/`'htop'` de l'exécuteur + `cmdTop`
  (`LinuxProcessCommands`) et ses aides exclusives — **rien ajouté à
  l'exécuteur**.
- Tests : `top -b -n 1` (façade noyau) vert dans `linux-commands-and-oracle-
  tools` 76/76 ; sweep process-manager/pidstat/vmstat/command-kernel/ps 64/64.
  Les 4 échecs restants (repeinte `top` + 3 tests Windows) sont préexistants,
  identiques à la baseline. `tsc` propre, aucune nouvelle alerte eslint.

## Correctif d'architecture — `netstat` : donnée depuis l'équipement, rendu hors legacy

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

La migration `netstat` précédente violait le principe : elle **ajoutait**
`buildNetstatInspect()` à `LinuxCommandExecutor` (la classe qu'on veut
supprimer) et le rendu restait dans `LinuxNetCommands` (net command legacy).
Correction alignée sur les 4 classes pivots (équipement, interpréteur,
commande, `MachineApi`) — la commande n'est qu'une **façade** vers
l'équipement.

- **Donnée depuis l'équipement** : `buildNetstatInspect()` retiré de
  l'exécuteur. `NetstatInspectApi` est désormais câblée dans **`LinuxMachine`**
  (l'équipement), qui lit son propre `IpNetworkContext` (routes/interfaces —
  déjà construit par l'équipement puis prêté à l'exécuteur), sa propre
  `SocketTable` (`getSocketTable`), son `profile.isServer`, et la résolution de
  service via l'API publique existante — **sans étendre l'exécuteur**.
- **Rendu hors legacy** : la logique de rendu quitte `LinuxNetCommands` pour la
  couche commande — `command-kernel/commands/netstatRender.ts`
  (`renderNetstat`). Les formateurs partagés avec `ss` (`formatEndpoint`/
  `familyVisible`/`socketVisible`) sont extraits dans un module pur neutre
  `linux/net/socketDisplay.ts` (ni exécuteur, ni classe de commande). `cmdSs`
  et `cmdNetstat`(→`renderNetstat`) l'importent ; sortie inchangée.
- Tests : `ss-netstat` + `netstat-stream-ui` + `socket-table` +
  `service-port-coherence` 133/133 ; sweep routing/ssh-lan/command-kernel/
  oracle-tools inchangé (seul échec Windows-ping préexistant). `tsc` propre,
  aucune nouvelle alerte eslint.

## Socle + Linux — `netstat` migré au noyau (`NetstatInspectApi`, mode `-c`) (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

`netstat` — commande réseau à 4 modes (connexions, `-r` routes, `-i`
interfaces, `-s` statistiques), largement testée (20+ suites) — était éclaté
entre le legacy (`case 'netstat'`) et l'intercepteur `tryStartNetstatStream`
(mode `-c` continu). Il devient une commande noyau unique.

- **`NetstatCommand extends StreamingCommand`** : `isStreaming(argv)` vrai avec
  `-c`/`--continuous` ; sans `-c` → un affichage ; avec `-c` → la liste entière
  réaffichée chaque seconde jusqu'à Ctrl+C. Garde anti-blocage
  (`ctx.io.interaction`).
- **Nouvelle capacité socle `MachineApi.netstat?: NetstatInspectApi`** (§0.1)
  exposant des vues en lecture (`routes`/`interfaces`/`sockets`/
  `resolveService`/`isServer`) via `NetstatRouteView`/`NetstatIfaceView`/
  `NetstatSocketView`, câblée depuis `LinuxCommandExecutor.buildNetstatInspect`
  (table de routage + interfaces + `SocketTable` + `/etc/services`).
- **Rendu partagé préservé** : `cmdNetstat` refactoré pour consommer
  `NetstatInputs` (les vues socle) au lieu de `IpNetworkContext`/`SocketTable` —
  **sortie inchangée octet pour octet** (formatage identique), réutilisé tel
  quel par la commande noyau. `cmdSs` intact.
- Legacy supprimé : `tryStartNetstatStream` + dispatch, `case 'netstat'`,
  avec l'import `cmdNetstat` de l'exécuteur.
- Tests : `linux-netstat-stream-ui` (flux `-c`, un-coup, isolation,
  `listAttachedStreams`) + `socket-table` + `ss-netstat` (appels directs
  `cmdNetstat` recâblés sur `NetstatInputs`) 118/118 ; sweep routing-table /
  service-port / oracle-listener / ssh-lan / cross-equipment 735+ verts (seuls
  persistent des échecs Windows-ping et PowerShell préexistants, non liés).
  `tsc` propre, aucune nouvelle alerte eslint.

## Socle + Linux — `dstat` migré au noyau (`SystemMetricsApi.network`) — famille échantillonneurs complète (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Sixième et **dernier échantillonneur** convergé. `dstat` était éclaté entre
le legacy (`case 'dstat'`, méta-commandes seules) et l'intercepteur
`tryStartDstatStream`. La famille `vmstat`/`free`/`mpstat`/`pidstat`/`iostat`/
`dstat` est désormais **entièrement au noyau**.

- **`DstatCommand extends StreamingCommand`** : moniteur pur — `isStreaming`
  vrai sauf `--version`/`--help`/`--list`/erreur ; en-tête une fois, une ligne
  par intervalle (CPU/disque/mémoire/réseau/paging/système selon les groupes),
  bornée par `nombre` ou Ctrl+C. Un appel programmatique (sans
  `ctx.io.interaction`) ne produit rien, comme le legacy.
- **`SystemMetricsApi.network(): NetTraffic`** (octets in/out cumulés, câblés
  depuis les compteurs de ports) — complète `memory()`/`cpu()`/`disks()`. La
  capacité métriques est maintenant fournie ssi les quatre profils existent.
- **`sampleDstat` rendu pur** : prend des `DstatInputs` primitives (runQueue,
  mémoire, octets réseau cumulés) au lieu de `LinuxProcessManager`/
  `MemoryProfile`/`PortByteSnapshot[]`.
- Legacy supprimé : `tryStartDstatStream` + dispatch, `case 'dstat'`,
  `DstatSampleContext`/`PortByteSnapshot`, `LinuxMachine.sampleDstatSnapshot`,
  avec leurs imports.
- Tests : `linux-dstat` 17/17 (parseur, `sampleDstat` recâblé sur `DstatInputs`,
  flux `dstat 1 2`/`-c -m`/live+Ctrl+C, méta-commandes) ; sweep complet de la
  famille + routage noyau 59/59. `tsc` propre, aucune nouvelle alerte eslint.

## Socle + Linux — `iostat` migré au noyau (`SystemMetricsApi.disks`) (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Cinquième échantillonneur convergé. `iostat` était éclaté entre le legacy
(`case 'iostat'`/`cmdIostat`, instantané) et l'intercepteur
`tryStartIostatStream` (mode `<intervalle>`).

- **`IostatCommand extends StreamingCommand`** : `isStreaming(argv)` vrai dès
  qu'un intervalle est fourni ; sans intervalle → bannière + rapport
  (avg-cpu + périphériques) ; avec intervalle → bannière une fois puis le
  rapport réaffiché à chaque intervalle, borné par `nombre` ou Ctrl+C. Garde
  anti-blocage (`ctx.io.interaction`).
- **`SystemMetricsApi.disks(): DiskInfo[]`** (nom + partitions) câblée côté
  Linux depuis le profil de stockage. Complète `memory()`/`cpu()`.
- **Correction d'une régression latente** : `sampleIostatCpu` appelait encore
  `sampleMpstat` avec l'ancienne signature (objets au lieu de
  `runQueue`/`cpuCount`) depuis la migration `mpstat` — la ligne avg-cpu
  produisait des `NaN` (non détecté car le test ne vérifiait que l'en-tête).
  Signatures désormais primitives : `sampleIostatCpu(runQueue, cpuCount)`,
  `sampleIostatDevices(args, disks)`, `iostatBanner` structurel.
- Legacy supprimé : `tryStartIostatStream` + dispatch, `case 'iostat'`,
  `cmdIostat`/`IostatContext`, `LinuxMachine.iostatBannerLine`/
  `sampleIostatCpuSnapshot`/`sampleIostatDevicesSnapshot`, avec leurs imports.
- Tests : `linux-iostat-stream-ui` 12/12 (instantané, `-c`/`-d`/`-x`/`-p`,
  flux, parseurs/formateurs — bloc « pures » recâblé sur la vue `IostatDisk`) ;
  sweep mpstat/pidstat/vmstat/free + routage noyau + commandes générales
  123/123. `tsc` propre, aucune nouvelle alerte eslint.

## Socle + Linux — `pidstat` migré au noyau (`ProcessEntry` + VSZ/RSS) (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Quatrième échantillonneur convergé. `pidstat` était éclaté entre le legacy
(`case 'pidstat'`/`cmdPidstat`, instantané) et l'intercepteur
`tryStartPidstatStream` (mode `<intervalle>`, rapports CPU **et** mémoire).

- **`PidstatCommand extends StreamingCommand`** : `isStreaming(argv)` vrai dès
  qu'un intervalle est fourni ; deux rapports (`-u` CPU / `-r` mémoire) ;
  bannière/en-tête une fois, lignes par processus par intervalle, puis les
  moyennes (`Average:`) à la sortie (via `PidstatAccumulator`). `-p SELF`
  utilise `ctx.session.shellPid`. Garde anti-blocage (`ctx.io.interaction`).
- **`ProcessEntry` gagne `vsizeKib`/`rssKib`** (mémoire par processus, câblés
  depuis le gestionnaire de processus) — nécessaires au rapport `pidstat -r`
  et réutilisables par `top`. `metrics.cpu()`/`metrics.memory()`/`os`
  (déjà posés) fournissent le reste.
- **Fonctions pures rendues génériques** : `sampleCpuRows`/`sampleMemoryRows`/
  `pidstatBanner` prennent désormais une vue `PidstatProc[]` + primitives
  (plus de dépendance à `LinuxProcessManager`/`CpuSpec`/`MemoryProfile`/
  `KernelInfo`).
- Legacy supprimé : `tryStartPidstatStream` + dispatch, `case 'pidstat'`,
  `cmdPidstat`/`PidstatContext`, `LinuxMachine.pidstatBannerLine`/
  `samplePidstatCpu`/`samplePidstatMemory`, avec leurs imports.
- Tests : `linux-pidstat-stream-ui` 10/10 (instantané CPU/mémoire, flux,
  moyennes, parseurs/formateurs/accumulateur) ; sweep mpstat/iostat/vmstat +
  routage noyau + process-manager 71/71 ; commandes générales 76/76. `tsc`
  propre, aucune nouvelle alerte eslint.

## Switch — extension du socle CLI vendeur aux switches + déconnexion `Switch.executeCommand`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Complète le push précédent (routeurs) : le socle CLI vendeur
command-kernel est maintenant étendu aux switches (Cisco Catalyst,
Huawei S5720, générique), sans dupliquer la mécanique de modes/
transitions. La déconnexion de `Switch.executeCommand` du shell CLI
legacy est totale — miroir strict de `Router.executeCommand`.

**Refactor structurel : `src/network/devices/vendor-cli/`** (nouveau)

Les commandes CLI vendeur qui sont IDENTIQUES sur routeur et switch
d'un même vendeur (transitions de mode, racines composites) ont été
extraites dans un emplacement partagé :

- `vendor-cli/cisco/Enable.ts`, `Disable.ts`, `ConfigureTerminal.ts`,
  `Show.ts` (factory `createCiscoShowCommand(subRegistry)` : la
  mécanique commune, le sous-registre change par équipement).
- `vendor-cli/huawei/SystemView.ts`, `Display.ts` (même factory
  pattern : `createHuaweiDisplayCommand(subRegistry)`).

Les copies routeur des transitions (`router/command-kernel/commands/
cisco/Enable.ts`, etc.) sont supprimées et remplacées par un import
depuis `vendor-cli/`. Les sous-commandes de `show`/`display` restent
device-spécifiques (routeur = `router/command-kernel/commands/cisco/
show/Version.ts` avec bannière ISR2911, switch = `switch/command-
kernel/commands/cisco/show/Version.ts` avec bannière C2960 — deux
classes distinctes, aucun partage forcé).

**Pont switch — `src/network/devices/switch/command-kernel/`** (nouveau)

- `SwitchMachineApi` : façade UNIQUE pour les commandes switch. DTO
  `SwitchInterfaceInfo` (avec `mode: access|trunk|hybrid|dot1q-tunnel`,
  `accessVlan`, `trunkNativeVlan`, `trunkAllowedVlans`),
  `SwitchVlanInfo` (id/name/memberPorts), `SwitchMacEntry` (mac/vlan/
  port/type/ageSeconds). Sous-façade `switch` exposant `interfaces()`,
  `interface(name)`, `setInterfaceAdminUp`, `setInterfaceDescription`,
  `vlans()`, `vlan(id)`, `macTable()`. `Switch`/`Port`/`VLANEntry`/
  `SwitchportConfig`/`MACTableEntry` ne fuient JAMAIS aux commandes.
- `createCiscoSwitchHostShell` : bootstrap Cisco. Modes user →
  privileged → config (config-vlan/config-if/config-mst à venir), même
  mécanique que le routeur mais avec le sous-registre `show` propre au
  switch (à ce stade : `show version` C2960 seul, `show vlan`/`show
  mac-address-table`/`show interfaces status`/… à migrer).
- `createHuaweiSwitchHostShell` : bootstrap Huawei. Modes user-view →
  system-view (vlan-view/interface-view à venir). Sous-registre
  `display` propre : `display version` S5720.

**Déconnexion `Switch.executeCommand`** :

- Plus AUCUN appel à `this.shell.execute()` pour l'exécution de ligne.
  Toute commande passe par `executeCommandKernel()` → `CliInterpreter`.
  `Switch.getPrompt()` bascule sur le nouveau `CliPromptBuilder`.
- Miroir strict de `Router.executeCommand` — même contrat, même
  pipeline. Aucun vecteur d'exécution parallèle : une seule porte
  d'entrée, un seul socle.
- Le shell legacy `ISwitchShell` (`CiscoSwitchShell`,
  `HuaweiSwitchShell`) reste construit pour les services annexes
  (tab-complete UI, snapshotVtyState). Migré au fil de l'eau.
- Les trois sous-classes vendeur (`CiscoSwitch`, `HuaweiSwitch`,
  `GenericSwitch`) implémentent `createCommandKernelCli()`.
  `GenericSwitch` réutilise le bootstrap Cisco (comme il le fait déjà
  pour son shell legacy).

**Preuve exécutable** :

- `switch-cli-foundation.test.ts` — 13/13 verts. Couvre prompts vendeur,
  transitions de mode Cisco (`enable`/`configure terminal`/`end`) et
  Huawei (`system-view`/`quit`), abréviations (`en`, `conf t`, `sh
  ver`, `sys`), `show version` (banner C2960 distinct du routeur
  ISR2911), `display version` (banner S5720 distinct du routeur
  AR2220), commande non migrée (`show vlan` échoue à travers le nouveau
  pipeline — signal migration).
- `router-cli-foundation.test.ts` — 15/15 verts, inchangés par le
  refactor `vendor-cli/`.

**Effet attendu (documenté, pas caché)** : la quasi-totalité des tests
switch existants deviennent rouges à ce push. Chaque test rouge = une
sous-commande à migrer (`show vlan`, `switchport mode access`, `vlan
10`, `spanning-tree portfast`, `mac-address-table static`, `interface
GigabitEthernet0/1`, `interface range`, `port-security`, …).

## Routeur — socle CLI vendeur command-kernel + déconnexion `Router.executeCommand` du legacy

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Base de migration pour tout équipement à CLI vendeur (routeurs Cisco/
Huawei, switches, firewalls). Aucune ligne CLI ne passe plus par
`IRouterShell.execute()` ; tout va au nouveau `CliInterpreter` du socle
command-kernel. Les tests deviennent rouges pour toute commande pas
encore migrée — c'est le signal explicite de ce qu'il reste à porter,
comme voulu.

**Nouveau socle CLI — `src/command-kernel/cli/`** (réutilisable par les
4 profils vendeur, jamais dupliqué par vendeur) :

- `CliMode`, `CliSession`, `CliCommand` : modes hiérarchiques avec
  registre propre par mode, session avec pile de modes et champs
  dynamiques de prompt, commandes optionnellement filtrées par mode
  (`allowedModes`) et composites (`subRegistry`).
- `CliInterpreter` : porte d'entrée UNIQUE. Pipeline strict tokeniser →
  résoudre hiérarchiquement dans le mode courant → vérifier
  `allowedModes` → parser (`ArgumentParser` du socle) → autoriser
  (`PermissionGuard` du socle) → exécuter → filtre pipe terminal. Le
  moteur d'exécution, le parseur d'arguments et la garde de privilèges
  du socle sont RÉUTILISÉS TELS QUELS (aucun parallèle).
- `tokenizeCliLine` : grammaire réduite (whitespace + guillemets +
  filtre `| include|exclude|section|begin <motif>`) — pas de `&&`/`||`/
  `;`, pas de redirections, pas d'expansion `$VAR`. Ce que IOS/VRP
  supportent réellement, rien de plus.
- `matchByPrefix` : abréviations préfixe-unique insensibles à la casse,
  aliases inclus. Sert l'exécution ET la future auto-complétion (mêmes
  règles).
- `ModeRegistry` : table de modes avec racine et `execLevel` (cible de
  `end`). Cisco : `user → privileged → config`, execLevel = privileged.
  Huawei : `user-view → system-view`, execLevel = user-view.
- `CliPromptBuilder` : rendu piloté par le mode courant (`mode.prompt
  (session, hostname)` — chaque vendeur décide de sa forme complète).
- `commands/mode-transition.ts` : `PushModeCommand` (base
  Template-Method), `PopModeCommand` (`exit`/`quit`), `EndCommand`
  (`end`/Ctrl-Z) — réutilisables tous vendeurs.
- `MachineApi.cli?` (nouveau) : capacité optionnelle exposant le
  `ModeRegistry` — les commandes de transition la consultent sans
  importer directement le registre.

**Pont routeur — `src/network/devices/router/command-kernel/`** :

- `RouterMachineApi` : source UNIQUE d'information pour les commandes
  routeur. Sous-façade `router` exposant des DTO stables
  (`RouterInterfaceInfo` : name/ip/mask/mac/mtu/adminUp/linkUp/
  description) — `Port`/`Router`/`ACLEngine` ne fuient jamais.
  Sous-façade `net` réelle (interfaces + admin state). `fs`/`proc`/
  `users`/`groups` en rejet explicite : un routeur n'a pas de VFS
  POSIX, un stub silencieux masquerait des bugs.
- `createCiscoRouterHostShell` : bootstrap Cisco. Modes user →
  privileged → config avec leurs registres propres. Commandes primitives
  livrées : `enable` (`en`), `disable`, `configure terminal` (`conf t`),
  `show` (`sh`) + `show version`, `exit`, `logout`, `end`.
- `createHuaweiRouterHostShell` : bootstrap Huawei. Modes user-view →
  system-view. Commandes : `system-view` (`sys`), `display` (`dis`) +
  `display version`, `quit`, `end`/`return`.
- Chaque commande est **standalone** : formatage porté dans la commande,
  seule source `ctx.machine` (jamais un import de `CiscoShowCommands`/
  `HuaweiDisplayCommands` legacy). Descripteurs typés (args/options
  déclarés, `PrivilegePolicy` embarquée) — base directe de la future
  auto-complétion.

**Déconnexion `Router.executeCommand`** :

- Plus AUCUN appel à `this.shell.execute()` pour l'exécution de ligne.
  Toute commande passe par `executeCommandKernel()` → `CliInterpreter`.
  `Router.getPrompt()` bascule également sur le nouveau `CliPromptBuilder`.
- Le shell legacy `IRouterShell` (`CiscoIOSShell`, `HuaweiVRPShell`)
  reste construit pour les services annexes non encore migrés
  (tab-complete UI, `evaluatePrefixList`/`evaluateRouteMap` BGP,
  `snapshotVtyState` pour l'isolation vty). Chaque service migré fera
  reculer d'un cran le legacy, jusqu'à sa suppression complète.

**Preuve exécutable** : `src/__tests__/unit/command-kernel/
router-cli-foundation.test.ts` — 15/15 verts. Couvre les prompts
vendeur, transitions de mode (`enable`/`disable`/`configure terminal`/
`exit`/`end` Cisco, `system-view`/`quit` Huawei), abréviations (`en`,
`sh ver`, `conf t`, `sys`, `dis ver`), `show version`, `display
version`, commande non migrée (`show ip route` échoue à travers le
nouveau pipeline — signal migration).

**Effet attendu (documenté, pas caché)** : la quasi-totalité des tests
routeur existants deviennent rouges à ce push. Chaque test rouge = une
sous-commande (`show ip route`, `interface Gi0/0`, `hostname X`,
`ip address …`, `show running-config`, …) qui doit être portée en
command-kernel dans un push ultérieur. La méthode : réutiliser la
mécanique de sous-registre déjà en place (une classe par sous-commande,
enregistrée dans le `subRegistry` de la racine appropriée — `show`,
`interface`, etc.). Aucun repli sur le legacy : le but final est sa
suppression complète.

## Socle + Linux — `mpstat` migré au noyau (`SystemMetricsApi.cpu` + capacité `os`) (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Troisième échantillonneur convergé, premier à métriques CPU. `mpstat` était
éclaté entre le legacy (`case 'mpstat'`/`cmdMpstat`, instantané) et
l'intercepteur `tryStartMpstatStream` (mode `<intervalle>` avec moyennes).

- **`MpstatCommand extends StreamingCommand`** : `isStreaming(argv)` vrai dès
  qu'un intervalle est fourni ; sans intervalle → bannière + en-tête + lignes ;
  avec intervalle → bannière/en-tête une fois, une ligne par intervalle, puis
  les moyennes (`Average:`) à la sortie (`nombre` atteint ou Ctrl+C, via
  `MpstatAccumulator`). Garde anti-blocage (`ctx.io.interaction`).
- **`SystemMetricsApi.cpu(): CpuInfo`** (logicalCpus/architecture/modelName) —
  sert `mpstat`/`iostat`/`pidstat`. **Capacité `MachineApi.os?: OsIdentity`
  câblée côté Linux** (depuis `SystemIdentity`) pour `kernelRelease` de la
  bannière. La charge (run-queue) vient de `processControl.list()`.
- **Fonctions pures rendues génériques** : `mpstatBanner`/`sampleMpstat`
  prennent désormais des primitives/types structurels (plus de dépendance à
  `CpuSpec`/`KernelInfo`/`LinuxProcessManager`), partagées entre la commande
  noyau et les tests.
- Legacy supprimé : `tryStartMpstatStream` + dispatch, `case 'mpstat'`,
  `cmdMpstat`/`MpstatContext`, `LinuxMachine.sampleMpstatSnapshot`/
  `mpstatBannerLine`, avec leurs imports.
- Tests : `linux-mpstat-stream-ui` 11/11 (instantané, `-P ALL`, flux, moyennes
  sur `<nombre>`/Ctrl+C, en-tête unique, parseurs/formateurs/accumulateur) ;
  sweep vmstat/free/pidstat/iostat + routage noyau 48/48 ; commandes générales
  366/366. `tsc` propre, aucune nouvelle alerte eslint.

## Socle + Linux — `free` migré au noyau (réutilise `SystemMetricsApi`) (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deuxième échantillonneur convergé, sur le socle métriques posé par `vmstat`.
`free` était éclaté entre le legacy (`case 'free'`/`cmdFree`, instantané) et
l'intercepteur `tryStartFreeStream` (mode `-s`). Il devient une commande noyau
unique.

- **`FreeCommand extends StreamingCommand`** : `isStreaming(argv)` vrai dès
  qu'un `-s` est fourni ; sans `-s` → une table ; avec `-s` → réaffiche la
  table entière à chaque intervalle, bornée par `-c` ou Ctrl+C. Garde
  anti-blocage identique (`ctx.io.interaction`).
- **`MachineApi.metrics.memory()` étendu** : `MemorySnapshot` gagne `usedKib`
  et `sharedKib` (nécessaires au rapport `free`). Le rendu est extrait dans
  une fonction pure **`renderFree(mem, opts)`** dans `MemoryProfile.ts` (couche
  hôte), partagée par `MemoryProfile.toFree` (qui délègue désormais) et la
  commande noyau — une seule implémentation, deux appelants, bon sens de
  dépendance (linux → hôte).
- Legacy supprimé : `tryStartFreeStream` + dispatch, `case 'free'` de
  l'exécuteur, `cmdFree` (LinuxSystemCommands.ts), avec leurs imports.
- Tests : `linux-free-stream-ui` (instantané, `-s`, `-c` auto-terminé,
  isolation, `-h`) + `host-hardware` (`toFree`/`humanKib`) verts ; cohérence
  mémoire Oracle SGA/top + commandes générales 452/452 inchangées. `tsc`
  propre, aucune nouvelle alerte eslint.

## Socle + Linux — `vmstat` migré au noyau + capacité `SystemMetricsApi` (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Première commande de la **famille des échantillonneurs** convergée. `vmstat`
était éclaté entre le legacy (`case 'vmstat'` de l'exécuteur, instantané) et
l'intercepteur `tryStartVmstatStream` (mode `<intervalle>`). Il devient une
commande noyau unique gérant les deux modes via `isStreaming(argv)`.

- **`VmstatCommand extends StreamingCommand`** : `isStreaming(argv)` vrai dès
  qu'un intervalle est fourni ; sans intervalle → en-tête + une ligne ; avec
  intervalle → en-tête une fois puis une ligne par intervalle, bornée par
  `nombre` ou Ctrl+C. Réutilise les fonctions pures `parseVmstatArgs`/
  `vmstatHeader`/`formatVmstatRow`.
- **Nouvelle capacité socle `MachineApi.metrics?: SystemMetricsApi`** (§0.1)
  avec `memory(): MemorySnapshot` (compteurs `/proc/meminfo` live) — distincte
  de `HardwareProfile` (inventaire figé). Câblée côté Linux via le profil
  mémoire de l'équipement. Les états de processus (R/D) viennent de
  `processControl.list()` déjà exposé ; la synthèse CPU est dans la commande.
- **Garde anti-blocage** : un appel programmatique (`vmstat 1` en script, sans
  flux terminal `ctx.io.interaction`) rend une seule ligne au lieu de tourner
  indéfiniment (parité avec l'ancien `cmdVmstat`).
- Legacy supprimé : `tryStartVmstatStream` + dispatch, `case 'vmstat'` de
  l'exécuteur, `cmdVmstat`/`sampleVmstat`/`VmstatContext` (system/Vmstat.ts),
  `LinuxMachine.sampleVmstatSnapshot`, avec leurs imports.
- Tests : `linux-vmstat-stream-ui` 9/9 (instantané, flux, `<intervalle> <nombre>`
  auto-terminé, isolation, parseurs/formateurs). Sweep des autres
  échantillonneurs (`free`/`mpstat`/`pidstat`/`iostat`/`netstat`-stream-ui)
  41/41 inchangés ; routage noyau 27/27. `tsc` propre, aucune nouvelle alerte
  eslint.

## Socle + Linux — `journalctl -f` (suivi journal) migré au noyau (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Troisième convergence d'un intercepteur de flux **Linux**, jumelle de
`dmesg -w`. `journalctl -f` était routé par `tryStartJournalFollow` ; le suivi
passe désormais par `tryStartKernelStream`, la commande noyau `journalctl`
existant déjà pour l'instantané.

- **`JournalctlCommand` gère `-f`/`--follow`** : `isStreaming(argv)` vrai dès
  qu'un `-f`/`--follow` est présent ; l'instantané par défaut se limite aux 10
  dernières entrées (comme le legacy) puis `execute` s'abonne aux nouvelles
  entrées et les diffuse jusqu'à Ctrl+C. Refactor du bas de `execute` : la
  sortie de l'instantané est calculée dans `snapshot`, émise, puis suivie.
- **Nouvelle capacité socle `LoggingApi.followJournal?(opts, listener)`** (§0.1)
  exposée via `LinuxLogManager.followJournal` : abonnement événementiel filtré
  par unité/priorité/pid.
- **Garde anti-blocage (les 3 commandes de suivi)** : `tail -f`/`dmesg -w`/
  `journalctl -f` ne bloquent que sous un flux terminal vivant
  (`ctx.io.interaction`) ; un appel programmatique (`executeCommand`/script,
  sans canal d'annulation) rend l'instantané au lieu de tourner indéfiniment —
  corrige un blocage de `journalctl -f -n 1` en appel direct.
- `tryStartJournalFollow` + dispatch supprimés ; `LinuxMachine.followJournal`
  (câblage mort) supprimé.
- Tests : `linux-top-journalctl-stream-ui` (moitié journalctl) + `journalization`
  60 (appel direct) verts ; suites journalisation 312/313 (seul échec : le test
  `top` préexistant, non lié). `tsc` propre, aucune nouvelle alerte eslint.

## Socle + Linux — `dmesg -w` (suivi noyau) migré au noyau (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deuxième convergence d'un intercepteur de flux **Linux**, dans la lignée de
`tail -f`. `dmesg -w` était routé par l'intercepteur dédié
`tryStartDmesgFollow` de `LinuxTerminalSession` ; le suivi passe désormais par
l'entrée générique `tryStartKernelStream`, la commande noyau `dmesg` existant
déjà pour l'instantané.

- **`DmesgCommand` gère `-w`/`--follow`** : `isStreaming(argv)` vrai dès qu'un
  `-w`/`--follow` est présent (jamais `-f`, qui est `--facility` pour `dmesg`) ;
  après l'instantané du ring buffer, `execute` s'abonne aux nouveaux messages
  noyau et les diffuse au fil de l'eau jusqu'à Ctrl+C (`ctx.signal`). Réutilise
  la validation de niveau et le formatage existants.
- **Nouvelle capacité socle `LoggingApi.followKernel?(opts, listener)`** (§0.1)
  exposée côté Linux via `LinuxLogManager.followDmesg` : abonnement événementiel
  aux messages noyau (filtre de niveau/brut/horodatage humain appliqués par le
  gestionnaire de journaux), la commande n'accède aux journaux que par
  `ctx.machine.logging`.
- `tryStartDmesgFollow` + le dispatch supprimés de `LinuxTerminalSession` ;
  `LinuxMachine.followDmesg` (câblage de production mort) supprimé.
- Tests : `linux-dmesg-stream-ui` 5/5 (instantané + flux, `--level`, niveau
  inconnu, isolation multi-session, `listAttachedStreams`). Suites
  `journalization`/`observability-bridge`/`linux-journal` 277/277 inchangées ;
  `tsc` propre, aucune nouvelle alerte eslint.

## Socle + Linux — `tail -f`/`-F` migré au noyau + `isStreaming(argv)` côté Linux (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Première convergence d'un intercepteur de flux **Linux**. `tail -f` était routé
par l'intercepteur dédié `tryStartTailStream` de `LinuxTerminalSession` ; il
passe désormais par l'entrée générique `tryStartKernelStream`, comme une
commande noyau normale à mode dépendant des arguments.

- **`LinuxMachine.isKernelStreamingLine` consulte `cmd.isStreaming(argv)`**
  (miroir de Windows) : `parseKernelRoutable` remonte désormais l'`argv` par
  étage, et c'est la commande — pas l'hôte — qui décide du mode flux. Le
  drapeau statique `descriptor.streaming` reste le défaut.
- **`TailCommand` (noyau) gère `-f`/`-F`/`--retry`/`-s`** : `isStreaming(argv)`
  vrai dès qu'un `-f`/`-F` est présent ; `runFollow` émet l'instantané tail-N
  puis diffuse les octets ajoutés au fil de l'eau jusqu'à Ctrl+C
  (`ctx.signal`). Réutilise les fonctions pures partagées `sliceTail`/
  `tailHeader`/`computeAppended`.
- **Nouvelle capacité socle `FileSystemApi.watchWrites?(path, cb)`** (§0.1 :
  ajouter une capacité, ne jamais contourner) : abonnement aux écritures d'un
  fichier, exposé côté Linux via `VirtualFileSystem.onWrite` — la commande
  n'accède au système de fichiers que par `ctx.machine.fs`. Suivi
  **événementiel** (émission dans le même tick que l'écriture), pas de sondage.
- `tryStartTailStream` + le dispatch supprimés de `LinuxTerminalSession` ;
  `LinuxMachine.startTailFollowInSession` et
  `LinuxCommandExecutor.startTailFollow`/`tryStartTailFollow`/`tailFs`
  supprimés (câblage de production désormais mort), avec leurs imports.
- Tests : `tail-follow-ui` (chemin bout-en-bout via la session : amorçage,
  ajouts, Ctrl+C, compteur React, repli non-suivi) + `tail` (35/35 ; le bloc
  suivi retargeté sur le moteur pur partagé `TailCommand.startFollow` que la
  commande noyau réutilise). Sweep des intercepteurs restants
  (`free`/`netstat`/`vmstat`/`mpstat`/`dmesg`-stream-ui) 33/33 — inchangés.
  `tsc` propre, aucune nouvelle alerte eslint.

## Correction des tests legacy préexistants (après SFTP)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Cinq root causes distinctes, un commit chacune, identifiées après la
migration SFTP (tâche différée par décision utilisateur) :

- **`ssh-lan-gap.test.ts`** appelait encore `SftpSubShell.processLine()`
  sans `await` (devenu asynchrone lors de la migration sftp) —
  `result.output is not iterable`.
- **Alias/fonction shell masqués par le kernel** : `echo`/`cd` (et toute
  commande kernel) étaient toujours résolus directement, avant même que
  l'interpréteur bash historique n'ait la moindre chance d'appliquer un
  `alias echo=...` actif ou une fonction shell `function cd { ... }` qui
  masque le même nom. `LinuxMachine.parseKernelRoutable` décline
  désormais le routage (repli sur le chemin bash, seul à porter cette
  expansion) dès qu'un des noms de la ligne a un alias ou une fonction
  définis dans la session courante.
- **Tests de session SSH backgroundée** (`w`, `auth.log`, shadowing de
  fonction sur un shell distant) : le `setup` démarrait `ssh ... &`/une
  définition de fonction via `void executeCommand(...)`
  (fire-and-forget) puis vérifiait immédiatement l'état côté serveur —
  rien ne garantissait que la connexion (ou la définition) ait atteint
  son état final avant l'assertion. Aligné sur le reste des mêmes
  fichiers, qui attendent déjà ces mêmes commandes ailleurs.
- **Exec-mode `ssh` orphelin sur Windows** : le cutover command-kernel de
  `cmd.exe` (`df772421`) a supprimé tout le switch legacy sans repli,
  orphelinant `cmdSsh` (jamais migré vers le registre) — `ssh user@host
  <commande>` via `device.executeCommand()` répondait `'ssh' is not
  recognized...` au lieu d'exécuter le vrai client SSH. `runCommandKernel`
  détourne désormais spécifiquement `ssh` vers `cmdSsh` tant que le nom
  n'est pas enregistré dans le registre kernel (`registry.has('ssh')`
  fait disparaître ce détour de lui-même le jour où `ssh` sera migré) —
  pas de résurrection d'un switch legacy général, uniquement ce cas
  orphelin.
- **`ls` sans saut de ligne final** : `LsCommand` écrivait `parts.
  join('\n')` sans `\n` terminal ; le vrai `ls` termine toujours sa
  dernière ligne par un saut de ligne. Un consommateur en aval d'un pipe
  qui compte les vrais caractères `\n` (`wc -l`) sous-comptait d'une
  entrée (`ls -1 /tmp/x | wc -l` sur 3 fichiers répondait 2).

**Hors périmètre (nouvellement découvert, pas les root causes visées)** :
PowerShell n'est pas du tout câblé sous `cmd.exe` (`powershell -Command
"..."` répond « not recognized ») — un chantier de migration à part
entière, pas un correctif ponctuel comme `ssh`. Les 7 échecs Windows-sftp
(§26 `linux-lan-sftp-suite.test.ts`) restent également hors périmètre —
confirmés identiques à la baseline avant SFTP, un chantier séparé.

Validation : `linux-lan-ssh-suite.test.ts` (216/216, contre 5+ échecs
avant), `cross-equipment-ssh-suite.test.ts` (231/234, seuls les 2
PowerShell hors périmètre restent), `ssh-terminal-stack.test.ts`,
`ssh-lan-gap.test.ts`, `shell-alias-command.test.ts`,
`which-whereis-type.test.ts` tous verts ; sweep large (bash/command-kernel/
iam/adduser/audit, 800+ tests) sans régression ; `tsc`/`eslint` propres sur
les fichiers touchés (mêmes alertes préexistantes qu'à la baseline).

## SFTP Push C : lanceur en command-kernel, suppression du legacy `enterSftp`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Dernière étape du plan `DESIGN-SFTP-COMMAND-KERNEL.md`. Le lanceur `sftp`
(parsing, dialogue mot de passe, remise du sous-shell) devient une
commande kernel à part entière — `enterSftp`/`connectAndEnterSftp`/
`runSftpBatch`/l'interception en dur `parts[0] === 'sftp'` disparaissent
de `LinuxTerminalSession`.

- **`SftpLauncherCommand`** (`src/network/devices/linux/command-kernel/
  commands/Sftp.ts`, `streaming: true`) : parse `-b batchfile`/`-P port`/
  `[user@]host` elle-même ; mot de passe via `ctx.io.interaction`
  (`requireInteraction`, même socle qu'`adduser`) ; mode batch (`-b`)
  entièrement porté par la commande (lecture du fichier via `ctx.machine.
  fs`, écho de la transcription, préfixe `-` non bloquant, arrêt sur
  erreur) ; mode interactif : remise via `ctx.io.openSubShell('sftp',
  handle)`.
- **Nouvelle capacité `MachineApi.sftpConnect?`** (`SftpConnectApi`) :
  ouvre une VRAIE `SftpSession` (SSH + canal SFTP, trames à travers
  Equipment/Port/Cable) — implémentation `LinuxSftpConnectApi` dans
  `LinuxMachineApi.ts`, calquée sur l'ancien `connectAndEnterSftp` (mêmes
  uid/gid/home résolus via `LinuxUserManager`, même `SilentSshInteraction
  Handler`). Le résultat porte un `handle` opaque (remis tel quel à
  `openSubShell`, jamais inspecté par la commande) et, en mode batch,
  `runLine`/`prompt`/`disconnect` qui délèguent au même shell
  command-kernel sftp que le sous-shell interactif.
- **`runSftpLine()`** (nouveau, `network/protocols/ssh/sftp/command-kernel/
  runSftpLine.ts`) : extrait la mécanique commune (normalisation de casse
  du verbe, synchronisation du cwd local, collecte de sortie) partagée
  par `SftpSubShell.processLine` (hôte REPL interactif) et
  `LinuxSftpConnectApi.runLine` (mode batch du lanceur) — une seule
  implémentation, jamais dupliquée.
- **`CommandKernelChannel`/`CommandIO` gagnent `openSubShell?(kind,
  payload)`** (framework §5.5/§14.6) : remise d'un sous-shell interactif à
  l'hôte. Câblé dans `LinuxTerminalSession` (`handleOpenSubShell`) sur le
  mécanisme `ShellFactory`/`ShellSubShellAdapter` déjà existant (identique
  à sqlplus/rman) — le pont, seul à connaître le type réel de la poignée,
  la reconvertit en `extras.sftpSession`.
- **Piège de parité découvert (framework §7)** : `sftp` a une seconde vie
  legacy jamais migrée — `runSshTransport`/`SftpInteractiveSession`/
  `SftpCommandScript` (`LinuxCommandExecutor.ts`), qui gère l'invocation
  scriptée/heredoc (`sftp host <<EOF ...`) et les tests appelant
  `device.executeCommand()` directement (aucun terminal, donc aucun canal
  d'interaction réel). Router `sftp` vers le kernel sans discernement
  cassait ces deux usages (mot de passe introuvable → erreur). Fix :
  `LinuxMachine.kernelClaimsCommand(name, channel)` — le kernel décline
  `sftp` quand `channel.interaction` est absent, laissant le dispatch
  legacy (`tryNetworkCommand`/`dispatch()`) le prendre en charge exactement
  comme avant cette migration ; les autres commandes migrées n'ont pas
  cette double vie et restent toujours réclamées.
- Après ce push, `SftpSession` ne porte plus que la connexion (lifecycle +
  moteur de transfert partagé avec SCP) — toute la logique de commande
  (session interne ET lanceur) vit en command-kernel.
- Tests : même lot que Push B (610 passés / 617, les 7 échecs Windows-
  sftp préexistants confirmés à la baseline) + `scenario-08-sftp-
  chroot.test.ts` et `ssh-terminal-stack.test.ts` (sftp interactif)
  vérifiés individuellement. `tsc` propre sur les fichiers touchés.

## SFTP Push B : transferts et mutations en command-kernel, fin du switch legacy

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deuxième étape du plan `DESIGN-SFTP-COMMAND-KERNEL.md`. Les 11 commandes
restantes de la session sftp migrent vers le registre kernel : `get`,
`put`, `mkdir`, `rm`, `rmdir`, `rename`, `chmod`, `chown`, `stat`, `df`,
`lmkdir` — parité byte-exacte avec le legacy (messages `Couldn't create
directory:`/`Couldn't setstat on "..."`/`Changing mode on ...`, bloc
`stat` 5 lignes, tableau `df` avec `-h`, usages du switch).

- **`SftpChannelApi` étendue** (machine/types.ts) : mkdir/rm/rmdir/
  rename/chmod/chown/stat/df en ops fines du canal réel, plus
  `download`/`upload` qui délèguent au moteur de transfert partagé de la
  connexion. Nouveaux types `SftpRemoteStat`/`SftpRemoteDiskUsage`.
- **Décision framework (§8)** : `SftpSession.get/put/getRecursive/
  putRecursive` NE sont PAS supprimés — `WindowsScpClient` les emprunte
  comme moteur de transfert SCP. Ils restent le moteur partagé ; les
  commandes kernel `get`/`put` y délèguent via la façade (une seule
  implémentation, deux consommateurs). Le reste est supprimé de
  `SftpSession` : lmkdir, mkdir, rm, rmdir, rename, chmod, chown, stat,
  df, simpleRemote, humanBytes.
- **`SftpSubShell` : plus AUCUN switch** — toutes les commandes de la
  session passent par `interpretLine` ; `clear` reste un geste d'hôte
  (clearScreen) ; verbe inconnu → `Invalid command.` (parité).
- Tests adaptés pour passer par le vrai chemin (`processLine`) sur les
  mutations comme sur la navigation ; 610 tests verts sur le lot SFTP +
  audit/privilège, seuls persistent les 7 échecs Windows-sftp
  préexistants confirmés à la baseline.

## Socle + Windows — `pathping` migré : dernier intercepteur de flux `cmd` convergé (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Quatrième et dernière convergence de la surface `cmd`. `pathping` était le
seul intercepteur de flux restant sur le shell `cmd`
(`tryStartWinPathpingStream`, propre à `WindowsTerminalSession`). Il est
désormais une commande noyau à part entière : l'entrée terminal générique
`tryStartWinKernelStream` est **la seule porte** du streaming `cmd`.

- **`PathpingCommand extends StreamingCommand`** (`streaming: true`,
  `lenientOptions`) : deux phases émises au fil de l'eau — découverte du
  chemin (`netConfig.traceroute`, en-tête + liste des sauts) puis calcul des
  statistiques par saut (`netConfig.pingSequence`, une requête à la fois,
  `pace(periodMs)` entre chacune, jusqu'à `ctx.signal.aborted`). Réutilise les
  formateurs purs de `WinPathping.ts`. Ctrl+C pendant les statistiques rend
  la main sans émettre la table ni `Trace complete.`.
- **Nouvelle capacité socle `WindowsNetConfigApi.egressSourceIp(targetIp)`**
  (§0.1 : ajouter une capacité, ne jamais contourner) : expose l'IP source
  d'égress vers une cible pour la ligne du saut 0, via le dep
  `getEgressIPFor` déjà porté par `EndHost` — la commande n'accède à la
  machine que par `ctx.machine.netConfig`.
- `tryStartWinPathpingStream` supprimé de `WindowsTerminalSession`, avec ses
  imports `WinPathping`/`EndHost`/`IPAddress` désormais inutilisés. Restent
  hors périmètre les intercepteurs **PowerShell** (`Test-Connection
  -Continuous`, `Get-Content -Wait`, `Get-Counter`), qui vivent sur
  l'interpréteur PowerShell (non encore migré au noyau), pas sur `cmd`.
- Tests : `windows-pathping-stream-ui` (10/10 : en-tête, sauts, message de
  calcul, table, `Trace complete.`, non-résolution, Ctrl+C) ; sweep
  `windows-netstat/ping/tracert-stream-ui` + `windows-consistency`
  (50/50). `tsc` propre, aucune nouvelle alerte eslint.

## Socle + Windows — `netstat <intervalle>` : streaming décidé par la commande (`isStreaming(argv)`, §14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Troisième convergence. `netstat` a un mode **dépendant des arguments** (un
intervalle final le fait rafraîchir jusqu'à Ctrl+C, sinon un seul affichage)
et un `streaming: boolean` statique ne peut pas l'exprimer. Nouveau hook —
c'est la commande, pas l'hôte, qui décide.

- **`ICommand.isStreaming?(argv)` + `BaseCommand.isStreaming(argv)`** (défaut
  = `descriptor.streaming === true`). `WindowsPC.isKernelStreamingLine`
  consulte désormais `cmd.isStreaming(argv)` (avec les arguments réels de
  l'étage) au lieu du seul drapeau du descripteur — l'entrée terminal
  générique route correctement une commande au mode variable.
- **`NetstatCommand extends StreamingCommand`** : `isStreaming(argv)` renvoie
  vrai ssi le dernier argument est un entier positif (l'intervalle) ; `execute`
  boucle alors (ré-affiche la table, `pace(intervalle)`, jusqu'à
  `ctx.signal.aborted`), sinon un seul affichage. `tryStartWinNetstatStream`
  supprimé (le `startScrollingMonitor` partagé reste, il sert encore à
  `top`/`journalctl`/`watch`).
- **Bug préexistant corrigé au passage** : `netstat -an` était rejeté par le
  parseur (`option inconnue : -an`) faute de `lenientOptions` — ajouté (comme
  `ping`/`arp`). Les 2 tests `windows-netstat-stream-ui` rouges en base
  (rafraîchissement + one-shot) repassent au vert.

Dispatch terminal : `tryStartWinKernelStream` (générique, gère
ping/tracert/netstat) + `tryStartWinPathpingStream` (dernier intercepteur, à
absorber).

Validation : `windows-netstat-stream-ui` (4/4, dont les 2 auparavant rouges),
`ss-netstat` (32), `windows-port-forwarding` (8), `windows-consistency` (40),
`windows-services-processes-comprehensive`, `windows-access-cmd`,
`windows-filesystem` verts ; socle command-kernel (70/70). Typecheck propre.
Échecs préexistants sans rapport confirmés en base (`windows-cli-ps-fixes`,
`windows-ps-cmd-shared-state`, `linux-ping-stream-ui`).

## Windows — `tracert` migre en commande streaming, intercepteur dédié supprimé (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deuxième convergence vers l'entrée terminal unique, miroir de la migration
Linux de `traceroute` (`streaming: true` + émission via la même entrée
générique, pas de progression factice à reproduire).

- `TracertCommand extends StreamingCommand` + `streaming: true`. Le sondage
  hop-by-hop est déjà fait par `netConfig.traceroute` (batch temporisé) ; la
  commande est routée comme un job de premier plan annulable par
  `tryStartWinKernelStream`.
- `tryStartWinTracertStream` supprimé (parsing + formatage dupliqués +
  `tracerouteStreamInSession` côté session), son `if` de dispatch retiré,
  imports `WinTracert` inutilisés nettoyés. Les formateurs `WinTracert`
  restent (testés en unitaire directement).

Dispatch terminal : il ne reste que `tryStartWinKernelStream` (générique) +
`netstat`/`pathping` (à absorber ensuite).

Validation : `windows-tracert-stream-ui` (2/2), `tracert-ping` (304/304).
Typecheck propre.

## Socle — classe de base `StreamingCommand` (mécanique de flux factorisée, §14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Pour que l'entrée terminal générique reste *seamless* — une seule route, le
comportement défini par la commande — la mécanique de flux ne doit pas être
recopiée dans chaque commande streaming. Nouvelle classe de base
`command/streaming-command.ts` (`StreamingCommand extends BaseCommand`) :

- `emit(ctx, line)` — écrit une ligne en garantissant le saut de ligne final.
- `pace(ms, signal)` — attend en respectant l'annulation (Ctrl+C), sans laisser
  de timer pendant.

Une commande à sortie continue déclare `streaming: true` et se contente
d'écrire sa logique par ligne ; la boucle/pacing/annulation n'est plus
redupliquée. `PingCommand` (cmd) en est le premier client — sa méthode `pace`
privée et son `emit` inline sont supprimés au profit de l'héritage. Les
prochains intercepteurs terminal (`tracert`/`netstat`/`pathping`) migreront sur
cette même base, puis leurs `if` dédiés disparaîtront au profit de l'unique
`tryStartWinKernelStream`.

Validation : `windows-ping-stream-ui` (2/2) + `tracert-ping` (300/300)
inchangés (refactor sans changement de comportement) ; socle command-kernel
(70/70). Typecheck propre.

## Windows — `ping` devient une commande streaming command-kernel + entrée terminal générique (§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Premier consommateur du canal hôte unifié Windows, en miroir strict de la
migration Linux de `ping` : l'intercepteur streaming dédié
`tryStartWinPingStream` (parsing + formatage dupliqués + `pingStreamInSession`)
est remplacé par **une entrée terminal générique** pilotée par le descripteur
de la commande.

- **`PingCommand` (cmd) passe en streaming** (`streaming: true`) : émet
  l'en-tête puis chaque réponse au fil de l'eau via `ctx.io.stdout`, un
  paquet à la fois, ~1 s entre les envois (`setTimeout` respectant
  `ctx.signal`, comme Linux) ; `ping -t` tourne jusqu'à Ctrl+C
  (`ctx.signal.aborted`), un `-n N` explicite le borne, et un appelant sans
  terminal reçoit le décompte fixe (jamais de boucle infinie hors flux). Les
  statistiques sont émises à la fin comme sur interruption. Sections `-r`
  (Route:) / `-s` (Timestamp:) préservées. L'ancien `formatOutput` bloc
  supprimé — les formateurs de ligne/stats étaient déjà identiques à ceux de
  l'intercepteur.
- **`WindowsPC.isKernelStreamingLine`** (miroir de
  `LinuxMachine.isKernelStreamingLine`) : parse la ligne cmd, résout la
  commande dans le registre, renvoie vrai si son descripteur est `streaming`.
- **`WindowsTerminalSession.tryStartWinKernelStream`** (miroir de
  `LinuxTerminalSession.tryStartKernelStream`) : **une** route générique pour
  toute commande cmd `streaming` — job de premier plan branchant `onOutput`
  (diffusion ligne à ligne), `signal` (Ctrl+C) et `interaction`. Remplace
  `tryStartWinPingStream`, qui est supprimé (plus de parsing/formatage
  dupliqué côté session). C'est la première étape de convergence : les
  intercepteurs restants (`tracert`/`netstat`/`pathping`) seront absorbés par
  cette même entrée à mesure que leurs commandes migrent.

Un test ajusté (parité de comportement, pas de la commande) : `windows-consistency`
C-37/C-40 pinguaient 2× en décompte par défaut (instantané avec l'ancien bloc,
désormais ~3 s/ping au rythme réel) — repassés en `ping -n 1` (un paquet suffit
à peupler l'ARP), comportement identique à un `ping` Linux programmatique
(mesuré 3013 ms lui aussi).

Validation (localisée, §10) : `windows-ping-stream-ui` (2/2, `-n` progressif +
`-t` jusqu'à Ctrl+C), `tracert-ping` (300/300, dont `-r`/`-s` et `ping -t -n 2`
borné), `windows-consistency` (40/40), `windows-pathping-stream-ui` (10/10,
inchangé), `host-model-loopback`/`ping-through-switch`/`windows-feature-gates`/
`windows-services-processes-comprehensive` verts ; socle command-kernel (70/70).
Typecheck propre, lint ciblé sans nouvelle erreur (les `any`/warnings restants
sont préexistants).

## Windows — Canal hôte unifié (§14.6) câblé entre l'UI cmd et le pont command-kernel

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Applique aux machines Windows la fondation I/O du framework (§14.6),
exactement comme le volet Linux `Cable le canal hote unifie…` : le pont cmd
accepte désormais un `CommandKernelChannel` et le propage de bout en bout,
sans quoi aucune commande cmd migrée ne pourrait diffuser en continu,
dialoguer, ni être interrompue.

- **`CmdInterpreter`** : `interpretLine`/`runAst` acceptent un
  `signal?: AbortSignal` relayé à `Executor.run(..., signal)` (déjà
  compatible côté socle) → `ctx.signal` (Ctrl+C de l'hôte, §14.6).
- **Pont `WindowsPC`** : `executeCommand`/`executeCmdCommand`/
  `runCommandKernel`/`executeCommandInSession` acceptent un
  `channel?: CommandKernelChannel`. Nouveau `buildKernelIO(channel)`
  (miroir de `LinuxMachine.buildCommandKernelIO`) : chaque `write` part en
  temps réel vers `channel.onOutput` tout en restant collecté pour
  l'appelant, `interaction` porte les dialogues (§14.4), `channel.signal`
  est passé à `runAst`.
- **`WindowsTerminalSession.executeOnDevice`** : fournit le terminal de
  contrôle (`interaction: createKernelInteraction(new PromiseInputBroker(
  getInputHost()))`) à **toute** commande cmd migrée — comme la branche
  générale Linux (`{ interaction }`), aucune interactivité future ne
  dépendra du chemin d'entrée.

Changement purement additif : le canal est optionnel, les chemins qui ne le
fournissent pas (scripts, SSH exec, tests programmatiques) et les commandes
qui ne l'utilisent pas se comportent à l'identique. C'est la fondation des
prochains chantiers Windows (migration des intercepteurs streaming
`tryStartWinPathpingStream`/`pingStreamInSession` vers de vraies commandes
kernel, commandes cmd interactives type `runas`/`net user *`).

Validation (localisée, §10) : `windows-access-cmd` (53), `windows-consistency`
(40), `windows-drive-switching` (33), `windows-file-management` (45+6 skip),
`windows-netsh` (33), `windows-filesystem` (61), `windows-domain-entities`
(12), `windows-eventlog-cli` (4) ; socle command-kernel (70/70). Typecheck
propre. Échecs préexistants sans rapport confirmés en base
(`windows-netstat-stream-ui`, `windows-cli-ps-fixes`, `windows-lan-ssh-suite`,
`cross-vendor-ssh-interactive`).

## adduser : l'interactivité (mot de passe + GECOS) migre de LinuxFlowBuilder vers la commande

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Complète la migration `adduser`/`addgroup` : le dialogue mot de passe +
GECOS, jusqu'ici porté par le flux legacy `LinuxFlowBuilder`/
`InteractiveFlowEngine`, vit désormais entièrement dans `AdduserCommand`
via `ctx.io.interaction` — conformément au principe (framework §14.4) que
toute interactivité doit être gérée au niveau de la commande, jamais du
flux.

- **Nouvelles capacités `MachineApi`** : `UserManagementApi.posixSetPassword`/
  `posixSetGecos` (façades sur `LinuxUserManager.setPassword`/
  `setUserGecos`), en plus de `posixAccountInfo`/`primaryGroupName`/
  `appendToGroup` déjà ajoutées.
- **`AdduserCommand`** : après création du compte (bannière déjà émise),
  si un canal d'interaction est disponible et que le compte n'est ni
  `--system` ni couvert par `--disabled-password`/`--gecos`, demande
  elle-même « New password: » puis « Retype new password: » (échec
  immédiat si vide ou non concordant, messages identiques au legacy), puis
  le wizard GECOS complet (Full Name/Room/Work Phone/Home Phone/Other +
  confirmation, abandon sur réponse négative). Sans canal (script, appel
  direct hors terminal) : comportement inchangé, silencieux — jamais
  d'erreur sur un chemin qui n'a jamais eu besoin d'interactivité.
- **Descripteur `streaming: true`** sur `AdduserCommand`/`AddgroupCommand` :
  une commande qui dialogue écrit forcément du texte avant d'attendre une
  réponse (la bannière de création) — sans diffusion en direct, ce texte
  resterait invisible jusqu'à la fin de tout le dialogue. Câblage :
  `LinuxTerminalSession.executeOnDevice` détecte maintenant (après avoir
  ôté un éventuel préfixe `sudo `) qu'une commande est streaming et relaie
  sa sortie ligne à ligne au fil de l'eau — c'est ce qui permet à `sudo
  adduser` (qui passe par le flux d'authentification générique, pas par
  l'entrée directe) d'afficher sa bannière AVANT le premier prompt, exactement
  comme la commande nue. Bug réel trouvé en testant via Playwright : sans
  ce câblage, la bannière de création restait invisible jusqu'à la fin du
  dialogue mot de passe/GECOS (le résultat n'était affiché qu'une fois la
  Promise entière résolue).
- **Canal propagé plus profond** : `LinuxMachine.executeCommand` stashe le
  canal actif (`_activeKernelChannel`, restauré en `finally`) le temps de
  l'appel, pour que `_commandKernelHook`/`runCommandKernelResolved`
  (invoqués depuis l'intérieur du dispatch `sudo` de l'interpréteur bash
  legacy, qui ne portent pas le canal en paramètre) puissent tout de même
  l'atteindre — sérialisé sans risque par `sessionQueue`.
- **Legacy supprimé** : `buildRootAdduserFlow`, la branche `adduser` de
  `buildSudoFlow`, `gecosSteps`, `userCreationTail` — entièrement retirés
  de `LinuxFlowBuilder.ts` (seuls `newPasswordSteps`/`setPasswordStep`
  restent, encore utilisés par `passwd`/`su`, non migrés). Tests unitaires
  `linux-flow-builder.test.ts`/`iam-user-creation.test.ts` mis à jour pour
  vérifier que `LinuxFlowBuilder.build()` ne construit plus aucune étape
  pour `adduser` (plain ou sudo) au-delà de l'authentification sudo
  elle-même — le comportement interactif complet est vérifié à travers le
  vrai navigateur par `e2e/user-creation.spec.ts` (15/15 verts, y compris
  ping/traceroute/arping de `e2e/network-probe-commands.spec.ts`).

## Migration — useradd, adduser/addgroup vers command-kernel

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

- **`UseraddCommand`** : grammaire util-linux complète implémentée par la
  commande, création déléguée à `UserManagementApi.posixUseradd` (façade
  sur le `LinuxUserManager` réel), squelette via `createHomeSkeleton`
  (le pont résout home/uid/gid). Politique ROOT avec message vendeur
  exact via `AuthorizationResult.denialMessage` (nouveau champ générique
  honoré par le `PermissionGuard`).
- **`AdduserCommand`/`AddgroupCommand`** : les trois modes Debian
  (création de compte avec sorties `Adding user/group/…` exactes,
  ajout à un groupe, création de groupe) implémentés par la commande sur
  les nouvelles capacités `posixAccountInfo`/`primaryGroupName`/
  `appendToGroup`/`posixGroupadd`. Les prompts interactifs (mot de passe,
  GECOS) restent pilotés par `LinuxFlowBuilder`, qui exécute la création
  via la commande migrée (`executeCommandStep`) — leur migration vers
  `ctx.io.interaction` suivra celle de `sudo`.
- **Legacy supprimé** : `cmdUseradd`/`parseExpireDays`
  (LinuxUserCommands), `handleAdduser` + `adduserCreateUser`/
  `adduserAddToGroup`/`adduserCreateGroup` (exécuteur), les cases
  `useradd`/`adduser`/`addgroup` du dispatch et du fast-path sudo,
  wrappers iam réduits à des stubs man/help inexécutables.
  `useraddOptions.ts` n'a plus d'appelant en production ;
  `adduserOptions.ts` reste utilisé par `LinuxFlowBuilder` (couche UI).

## Réseau — Principe PDU : suppression de l'omniscience topologique (framework §2.3)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Nouvelle règle codifiée : toute communication entre machines passe par un
échange de PDU via Port/Cable — un pont `MachineApi` ne consulte jamais
`EquipmentRegistry` ni l'état interne d'un autre équipement.

- **`NetProbeApi.deviceIpsSharing` supprimée** (avec son câblage
  LinuxMachine et l'expansion d'alias du rendu numérique de traceroute) :
  elle listait les autres interfaces d'un équipement distant, connaissance
  impossible sans omniscience. `traceroute -n` ne montre plus que
  l'interface d'entrée réelle de chaque saut, comme le vrai traceroute.
  Test 275 de `tracert-ping.test.ts` adapté en conséquence : il attendait
  l'interface de sortie du routeur (produit de l'ancien alias omniscient) ;
  il vérifie désormais les interfaces d'entrée réelles du chemin.
- **Dette explicitée** (JSDoc `NetProbeApi` + framework §2.3) :
  `topologyMtus()` et `udpRangeDeniedByTopology()` — quirks hérités du
  legacy (PMTU `ping -M do`, ACL/UDP traceroute) qui violent le principe ;
  à remplacer par les vrais mécanismes protocolaires (ICMP
  Fragmentation-Needed, sondes UDP TTL-limitées droppées par les ACL),
  chantier plan réseau à part. Aucune nouvelle capacité de ce type n'est
  acceptée.

## Migration — ping/ping6, traceroute, arping vers command-kernel

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Voir les messages de commit dédiés : commandes autonomes (parsing,
formatage, codes de sortie), sondes réelles via la façade optionnelle
`MachineApi.netProbe`, `streaming:true` pour ping/traceroute (job de
premier plan générique `tryStartKernelStream`, remplaçant les
intercepteurs dédiés), entrées legacy réduites à des stubs man/help
inexécutables, suppression de `cmdArping`, des formatters
ping/traceroute de `LinuxFormatHelpers` et des intercepteurs de session.
Bug trouvé en testant : `su user -c "…"` contournait le hook kernel
(chemin corrigé, refus de privilège `-f`/`-i` rétablis pour non-root).

## Socle + pont — Canal hôte unifié : câblage UI ↔ machine (framework §14.4/§14.6)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Refonte de l'intégration terminal ↔ équipement autour d'un canal unique et
standardisé, `CommandKernelChannel` (`io/channel.ts`) : interaction
(dialogues), `onOutput` (sortie en flux continu) et `signal` (Ctrl+C) —
le même contrat pour les commandes à résultat direct et celles qui
tiennent le terminal.

- **Socle** : `Executor`/`Interpreter` acceptent un `AbortSignal` externe,
  propagé à travers tous les nœuds de l'AST jusqu'à `ctx.signal` (jusqu'ici
  chaque commande recevait un signal fabriqué, jamais abortable).
- **Pont** (`LinuxMachine`) : `executeCommandInSession`/`executeCommand`/
  `tryCommandKernel`/`buildCommandKernelIO` acceptent le canal ; chaque
  `write` d'une commande part en temps réel vers `channel.onOutput` tout en
  restant collecté pour l'appelant (rétrocompatible : le canal est
  optionnel, aucun appelant existant ne change).
- **UI** : `createKernelInteraction` (`src/shell/input/kernelInteraction.ts`)
  adapte l'`InputBroker` existant (SessionInputHost/PromiseInputBroker —
  la même machinerie Promise que le `read` interactif) au contrat
  `InteractionChannel` du socle ; `LinuxBashShell.dispatch` construit le
  canal et le passe à `executeCommandInSession`. Une commande migrée peut
  donc faire `await ui.prompt({kind:'secret'…})` : l'exécution suspend
  jusqu'à la saisie, Ctrl+C/Ctrl+D annule proprement (le broker résout
  `cancelled` → `prompt()` renvoie `null`).
- **Framework** : §14.4 documente la chaîne câblée (les commandes
  dialoguantes deviennent migrables, une par push, avec suppression du flux
  `LinuxFlowBuilder` correspondant) ; nouveau §14.6 déclare les
  intercepteurs de streaming de `LinuxTerminalSession` (`tryStartPingStream`,
  `tryStartTracerouteStream`, `tryStartTcpdump`…) chemins legacy à éteindre,
  avec la recette de migration standard (capacité `MachineApi` optionnelle
  déléguant au moteur réseau réel → commande kernel écrivant au fil de
  l'eau et honorant `ctx.signal` → suppression de l'intercepteur et de son
  parsing dupliqué). Chaque commande streaming reste un chantier propre —
  la parité des formats de sortie est massivement testée.

## Socle — Buffers d'entrée/sortie et canal d'interaction (framework §14)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Concrétise `docs/PROPOSAL-command-kernel-io-buffers.md` : le socle I/O
devient un contrat spécifié au lieu d'un ensemble de comportements
implicites, prérequis pour migrer les prochaines familles de commandes
(dont, à terme, les commandes interactives type `passwd`/`adduser`).

- **Sémantique `read()` clarifiée** (`io/types.ts`, `PipeBuffer`) : renvoie
  un chunk ou `null` quand plus rien n'est disponible — plus jamais `""`
  sur un pipe ouvert-mais-vide (supprime le risque de boucle active chez
  tout futur consommateur incrémental).
- **Erreurs métier I/O** (`errors.ts`) : `BrokenPipeError` (141 = 128 +
  SIGPIPE, remplace l'`Error` native de `PipeBuffer.write()` après
  fermeture — violation du §9), `PipeCapacityError` (garde-fou
  `PIPE_CAPACITY_DEFAULT` de 8 M caractères contre la dérive mémoire du
  modèle séquentiel), `InteractionUnavailableError`. Constantes
  `EXIT_INTERRUPTED` (130) / `EXIT_BROKEN_PIPE` (141) dans
  `command/types.ts`.
- **Canal d'interaction** (`io/interaction.ts`) : `CommandIO.interaction?`
  (terminal de contrôle, distinct de stdin, propagé par l'`Executor` à
  travers pipelines et redirections), `PromptSpec`
  (`text`/`secret`/`confirm`), `requireInteraction()` (erreur métier propre
  si absent), et `InteractionBroker` — l'adaptateur pause/reprise qui
  suspend réellement `execute()` sur un `await prompt()` jusqu'au
  `respond()` de l'hôte, compatible avec le modèle
  `InteractiveFlowEngine.advance()` de `src/terminal/`.
  `Terminal.asCommandIO()` câble le canal sur `readLine`/`readSecret`.
  Le câblage du pont legacy (`tryCommandKernel` → `PromptRequest`) reste un
  chantier séparé : les commandes interactives demeurent non migrables
  (garde explicite, framework §14.4).
- **`text-input` remonté dans le socle**
  (`command/text-input.ts`) : `splitLines`/`joinLines`/`readTextInput`/
  `readPerFileInputs` étaient vendor-agnostic mais vivaient dans le pont
  Linux ; le fichier Linux devient un ré-export de compatibilité (aucun
  import de commande modifié).
- **Point d'extension réservé** : `RedirectionNode.fd?: "stdout"|"stderr"`
  (absent = stdout), sans nouveau token — `2>`/`2>&1` restent explicitement
  non supportés.
- **Framework** : nouveau §14 (invariants I/O, tableau des erreurs, règles
  du canal d'interaction, limite du pont) + 2 entrées de checklist §13.

## Linux — Phase 32 : migration de `journalctl` (fin de la famille journalisation)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Dernier volet de la journalisation. `journalctl` (uniquement au dispatch,
sans entrée de privilège) migre vers command-kernel ; `executeJournalctl`
et ses cinq aides privées sont supprimées.

- **`LoggingApi` étendue** : `journalActive()`, `journalEntries()`
  (instantané chronologique du journal, champs neutres via `JournalRecord`),
  `bootId()`. Le journal reste détenu et alimenté par `LinuxLogManager`.
- **`JournalctlCommand` autonome** : réimplémente tout — sous-commandes
  (`--version`/`-N`/`--disk-usage`/`--list-boots`/`--rotate`/`--flush`/
  `--vacuum-*`), parsing d'options (`-n`/`-r`/`-q`/`-k`/`-b`/`-D`/`--since`/
  `--until`/`-o`/`-u`/`-p`/`_PID=`/`--output-fields=`…), filtrage
  (unité/priorité/PID/noyau/depuis/jusqu'à + masquage des entrées futures),
  troncature `-n`, inversion `-r`, en-tête « Logs begin… », et les **6
  formats** de sortie (`short`/`short-iso`/`cat`/`json`/`json-pretty`/
  `verbose`). Tables `PRIORITY_NAMES`/`FACILITY_NAMES` et formateurs de date
  partagés via `commands/syslog.ts` (ajout de `formatSyslogTimestamp`/
  `formatIsoTimestamp`).
- **Sémantique du code de sortie** reproduite à l'identique : 1 seulement si
  la sortie commence par « Invalid » (priorité / format), 0 sinon — y
  compris pour `journalctl: invalid number…` / `Failed…` (quirk legacy
  `out.startsWith('Invalid') ? 1 : 0`).
- **Suppressions** : `case 'journalctl'` du dispatch, `executeJournalctl`,
  `filterEntries`, `parseJournalTime`, `resolvePriority`, `cmdDiskUsage`,
  `cmdListBoots`, constante `JOURNALCTL_HELP`. `formatEntry`/`entryMatches`
  conservées (encore utilisées par le suivi `journalctl -f`).

Bug de test corrigé : `observability-bridge` appelait directement
`exec.logMgr.executeJournalctl([...])` (méthode interne supprimée) — repointé
sur la commande publique `exec.execute('journalctl -u ssh')`.

Validation (localisée, §10) : `journalization` (200/200), `linux-journal`
(65), `systemd-scenario4-journald` (7), `observability-bridge` (11),
`journalization-and-audit` (30), corrélation d'incidents / cohérence
authlog / drift réseau / ssh-config / readiness-race (verts) ; socle
command-kernel (70/70). Typecheck propre, lint ciblé sans nouvelle
erreur/avertissement. Échecs préexistants sans rapport confirmés en base
(`linux-top-journalctl-stream-ui` frame `top`, `scenario-20` ICMP/authlog).

Famille journalisation désormais entièrement sur command-kernel :
`logger` (Phase 30), `dmesg` (Phase 31), `journalctl` (Phase 32).

## Linux — Phase 31 : migration de `dmesg` (double dé-enregistrement + privilège conditionnel)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deuxième volet de la journalisation. `dmesg` était **doublement
enregistré** (case `dispatch` + `LinuxCommand` `dmesgCommand`) — les deux
délégaient à `LinuxLogManager.executeDmesg`. Migration complète vers
command-kernel, les deux enregistrements retirés.

- **`LoggingApi` étendue** : `kernelBuffer()` (instantané du ring buffer
  noyau), `clearKernelBuffer()`, `bootTime()` — primitives déléguant au vrai
  `LinuxLogManager` (le buffer reste alimenté par `addEntry` pour les
  messages de facilité `kern`).
- **`DmesgCommand` autonome** : parse ses options (`-T`/`-c`/`-C`/`-r`/`-l`/
  `-n`/`-x`/`-w`/`-h`/`-V`…), filtre par niveau, formate elle-même (raw /
  temps humain / offset). Table `PRIORITY_NAMES` + `formatHumanDate`
  extraites dans un utilitaire partagé `commands/syslog.ts` (réutilisé par
  `journalctl` au volet suivant).
- **Privilège conditionnel** (`-c`/`-C`/`-n` = root uniquement) : la
  politique déclarative `authorize(user)` ne voit pas les arguments, donc le
  contrôle est fait dans `validate(args, session)` qui lève
  `PermissionError('read kernel buffer failed: Permission denied')` — rendue
  `dmesg: read kernel buffer failed: Permission denied` (préfixe du nom de
  commande), message et code 126 identiques au legacy.
- **Suppressions** : `case 'dmesg'` du dispatch, `dmesgCommand`
  (`commands/system/Dmesg.ts` + ses deux enregistrements dans
  `commands/index.ts`), `LinuxLogManager.executeDmesg`, et l'entrée
  `dmesg` de `defaultCommandPrivileges` (désormais portée par la commande).
  `formatDmesgEntry` conservée (encore utilisée par le suivi `dmesg -w`).

Validation (localisée, §10) : `journalization` (200/200, dont 102/103 =
privilège root sur `-C`/`-n`), `linux-journal` (65), `linux-dmesg-stream-ui`
(5, suivi `-w`), `command-privilege-policy` (17), `auditctl`/`auditctl-other`
(250), `journalization-and-audit` (30), `linux-command-kernel` (12) ; socle
command-kernel (70/70). Typecheck propre, lint ciblé sans nouvelle
erreur/avertissement.

Reste à migrer : `journalctl`.

## Linux — Phase 30 : migration de `logger` + capacité `LoggingApi`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Premier volet de la migration des commandes de journalisation vers
command-kernel. `LinuxLogManager` reste (c'est l'infrastructure partagée
qui détient le journal, le ring buffer noyau et les projections
`/var/log/*`, alimentée par SSH/systemd/cron/IAM…) ; seule la **commande**
`logger` migre, et sa méthode `executeLogger` est supprimée.

- **Nouvelle capacité `LoggingApi`** (optionnelle) sur `MachineApi` :
  expose une **primitive** `writeSyslog(spec, tag, message, displayPid)`
  qui valide le spec `facility.priority`, ajoute l'enregistrement via le
  vrai `LinuxLogManager` (jamais un état parallèle, §2/§4.2) et renvoie la
  ligne syslog formatée (pour `logger -s`). Implémentée par
  `LinuxLoggingApi` enveloppant `logMgr`.
- **`LoggerCommand` autonome** : parse elle-même `-t`/`-p`/`-i`/`-s`/`-e`/
  `-f` et le message, tag par défaut = utilisateur de session, puis écrit
  via `ctx.machine.logging.writeSyslog`. Le parsing/formatage propre à la
  commande vit dans la commande ; l'état de journalisation reste dans
  l'infrastructure. `validate` implémentée (erreurs GNU — priorité
  inconnue, fichier absent, usage — rendues dans `execute`).
- **`case 'logger'` retiré** du dispatch ; **`LinuxLogManager.executeLogger`
  supprimée** ; nouvelle dépendance `logManager` câblée dans les deux sites
  qui construisent le shell command-kernel (`LinuxCommandExecutor`,
  `LinuxMachine`) et dans le test de socle `linux-command-kernel`.

L'écriture passant par le même `addEntry` que le legacy, l'état journalisé
(journal + `/var/log/*` + ring buffer kern) reste identique — seuls le
parsing d'options et le renvoi `-s` sont réimplémentés.

Validation (localisée, §10) : `journalization` (200/200), `linux-journal`,
`linux-command-kernel` (socle, 277 au total avec les précédents) ; suites
consommatrices de `logger` en isolation (`journalization-and-audit` 30,
`auditctl-other` 150, `systemd-scenario4-journald` 7,
`linux-hosts-hostname-hijack` 12, `ssh-lan-security-editors` 35) ; socle
command-kernel (70/70). Typecheck propre, lint ciblé sans nouvelle
erreur/avertissement (`PRIORITY_LABELS` inutilisé était déjà là).

Reste à migrer (volets suivants) : `dmesg`, `journalctl`.

## Linux — Phase 29 : `logrotate` — abandon de rotation sur échec de `prerotate`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Bug trouvé puis corrigé en testant contre la suite existante** (cause
racine, pas symptôme) : `logrotate` ne respectait pas l'abandon de
rotation quand un script `prerotate` échoue (`journalization` test 161).

- **Cause racine** : `cmdLogrotate` était **synchrone** mais appelait
  `this.execute(opt.prerotate)` (asynchrone) **sans l'attendre**. Le test
  `if (this.lastExitCode !== 0) continue;` s'exécutait donc *avant* que le
  script `prerotate` n'ait tourné — `lastExitCode` valait encore 0, et la
  rotation avait lieu malgré l'`exit 1`. Le script lui-même finissait par
  s'exécuter (microtâche), ce qui masquait le bug : le voisin test 160
  passait car son marqueur `touch` finissait bien par être créé (et son
  assertion `ls /tmp/pre_rotate_marker` matchait de toute façon le chemin
  dans le message d'erreur).
- **Correctif** : `cmdLogrotate` rendue `async`, les scripts
  `prerotate`/`postrotate` sont désormais `await`és — le code de sortie du
  `prerotate` est observé au bon moment, la rotation est bien abandonnée.
  Appelants mis à jour (`case 'logrotate'` du dispatch, déjà `async` ;
  `Logrotate.ts` `run`/`runWithStatus`).

Validation : `journalization` (200/200, dont 161), `journalization-and-audit`
(30/30), `auditctl` (100/100), `auditctl-other` (150/150). Typecheck et lint
ciblés propres.

## Linux — Phase 28 : migration de `kill` + correction de l'expansion `$$`/`$PPID`/`$?` du pont kernel

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Migration de `kill` (par PID) vers command-kernel, en respectant le
principe directeur « une seule porte d'entrée = l'interpréteur » : plutôt
que de dérouter les lignes problématiques vers l'interpréteur bash, les
capacités manquantes ont été ajoutées **dans les bonnes couches du
socle**.

- **`KillCommand` autonome** : `-l`, parsing de signal (`-9`/`-TERM`/`-s`/
  `-n`), signalisation via `ctx.machine.processControl`, erreurs GNU
  exactes (`No such process`, `not enough arguments`, `invalid signal
  specification`), `validate`. Le syscall `kill(2)` est tracé
  inconditionnellement (`ctx.machine.audit?.syscall('kill')`), comme le
  `publishSyscall('kill')` du legacy — un `kill -9 <pid inexistant>` doit
  apparaître dans `audit.log` (test 34 de `auditctl-other`).
- **Auto-signalement (`kill $$`)** : viser le shell de connexion avec un
  signal terminant renvoie `128+signal` (SIGINT → 130), le shell
  interactif/distant n'ayant pas de superviseur de script ; viser le shell
  d'un *script* signale le processus, et c'est `runScriptProcess` qui
  traduit sa disparition en `128+signal`. La distinction se fait sur le PID
  du shell de connexion (`session.shellPid`), exactement comme le
  `ctx.shellPid` du `cmdKill` legacy — sans quoi `ssh … "bash -c 'kill
  -INT $$'"` retombait à `rc=0` au lieu de 130.
- **Jobspecs `%N`** : restent gérés par les builtins de contrôle de tâche
  (`runJobBuiltinIfMatching`), au même titre que `fg`/`bg`/`wait` — le
  pont `tryCommandKernel` refuse désormais structurellement de router une
  ligne portant un argument `%…` (comme il refuse déjà `$(`/backtick),
  puisque le kernel ne modélise pas le contrôle de tâche. `cmdKill` reste
  donc vivant pour ce seul chemin (pas de code mort).

**Bugs trouvés puis corrigés en testant contre la suite existante** (cause
racine, pas symptôme) :

- **`$$`/`$PPID` non expansés au niveau `LinuxPC`** : `LinuxMachine`
  route les lignes simples via `tryCommandKernel`, dont l'`Expander`
  ignorait les paramètres spéciaux du shell — `echo $$` ressortait
  littéral, `$PPID` vide. Corrigé **dans l'`Expander` du socle**
  (`$$`/`$BASHPID` → `session.shellPid`, `$PPID` → `session.parentPid`),
  la session étant renseignée par le pont à partir du shell de connexion
  réel. L'interpréteur reste l'unique porte d'entrée.
- **`$?` toujours à 0 après une commande passée par le kernel** :
  `buildCommandKernelSession` ne reportait pas `lastExitCode` de
  l'exécuteur — corrigé (le pont ensemence `lastExitCode`/`shellPid`/
  `parentPid`). Débloque `echo $?` après un script `exit 7` et le report
  du code de sortie d'un auto-`kill`.
- **`withProcessIdentity` synchrone enveloppant un corps asynchrone** :
  le `finally { bashPids.pop() }` s'exécutait dès que `fn()` retournait sa
  promesse *non résolue*, donc l'identité de PID était retirée avant que
  le corps ne s'exécute — un script `ExecStart` de service voyait `$$` =
  PID du shell de login au lieu du MainPID de l'unité. Rendu `async`
  (les deux appelants attendaient déjà le résultat).

Validation (localisée, §10) : `linux-process-identity` (4/4),
`script-process-coherence` (13/13, dont les 6 auparavant rouges :
identité, code de sortie de script, auto-`kill` 137/143, abandon de
script, MainPID systemd), `linux-job-control` (21/21),
`tcpdump-kill-cancels-capture`, `linux-process-service-integration`
(27/27), `linux-priority-commands` (13/13) ; lot audit/privilège §7.2 en
isolation (`auditctl` 100, `auditctl-other` 150, `journalization-and-audit`
30, `command-privilege-policy` 17) ; socle command-kernel (82/82) ;
systemd/service/cron/background (toutes vertes) ;
`cross-equipment-ssh-suite` revenu à sa base (19 échecs préexistants sans
rapport, dont une régression `rc=130` introduite puis corrigée en cours de
route). Typecheck propre, lint ciblé sans nouvelle erreur.

Hors périmètre (préexistant, sans rapport) : `run-parts` 108/118/119 (sh/
fonctions/if dans un script `run-parts`), `journalization` 161 (prerotate
logrotate).

## Routeur Cisco — BGP `aggregate-address` réel (agrégation Loc-RIB + `summary-only`)

Encore un gap "CLI qui répond mais ne fait rien" : `aggregate-address`
n'était qu'une ligne de texte poussée pour `show run` — jamais consultée
par le moteur BGP, aucun effet sur la table ni sur ce qui est annoncé.

`BGPConfig` gagne `aggregates: BgpAggregate[]` (`{network, mask,
summaryOnly}` — volontairement borné : pas de `as-set`/`suppress-map`/
`advertise-map`/`attribute-map`). Nouvelle étape `applyAggregates()`
dans `computeLocRib()` : pour chaque agrégat configuré, si au moins une
route strictement plus spécifique existe déjà dans le Loc-RIB, l'agrégat
est synthétisé (origine `incomplete`, AS_PATH vide, comme le vrai BGP) ;
avec `summary-only`, les routes plus spécifiques couvertes sont retirées
du Loc-RIB (donc ni installées ni annoncées, seul l'agrégat l'est). Sans
route couvrante, l'agrégat n'est jamais créé — comportement réel.

**Validation** : 4 nouveaux tests `BGPEngine` (agrégation déclenchée
seulement si une route couvrante existe, annonce agrégat+spécifiques
sans `summary-only`, suppression des spécifiques avec `summary-only`,
absence de route couvrante = pas d'agrégat) + 1 test CLI bout-en-bout
(deux `CiscoRouter` réellement câblés, `aggregate-address ... summary-
only` filtrant les deux plus-spécifiques sur `show ip route` du
routeur récepteur). Suite BGP élargie (engine/bestpath/session/
messages/intégration CLI EIGRP+BGP) : 65+8 tests au vert. Typecheck et
lint ciblés propres.

## Routeur Cisco — RIP `distribute-list prefix-list <name> in|out`

Dernier volet du même chantier de filtrage, appliqué cette fois à RIP.
Architecture différente d'EIGRP/BGP : `RIPEngine` n'hérite pas de
`AbstractRoutingProtocolEngine`/`RoutingDeviceContext` (il implémente
`RIPCallbacks` en direct, plus ancien) — un nouveau câblage complet a
donc été nécessaire, contrairement à EIGRP qui réutilisait un hook déjà
en place.

`RIPConfig` gagne `distributeListIn`/`distributeListOut` (nouvelle
méthode `setDistributeList`, exposée via `RouterRIPEngine` puis
`Router.ripSetDistributeList`) ; `RIPCallbacks`/`RIPRouterContext`
gagnent `evaluatePrefixList`, câblé depuis `Router.ts` vers
`this.shell.evaluatePrefixList` — même fermeture paresseuse que pour
BGP/EIGRP, aucun souci d'ordre de construction. `processRouteEntry`
(chemin entrant) filtre chaque entrée d'une Response reçue avant
apprentissage ; `sendUpdate` **et** `flushTriggeredUpdates` (les deux
chemins sortants — périodique et déclenché) filtrent chaque route
candidate avant annonce. CLI : `distribute-list prefix-list <name>
in|out` sous `router rip`.

**Validation** : 3 nouveaux tests bout-en-bout avec de vrais
`CiscoRouter` câblés (filtrage entrant, filtrage sortant, liste
inexistante = deny implicite) — 42/42 au vert sur `rip.test.ts` (39
tests préexistants + 3 nouveaux, aucune régression). Un bug de
timing découvert et corrigé **dans les tests eux-mêmes** en cours de
route : appeler `enableRIP({updateInterval...})` après que `router rip`
ait déjà démarré le timer périodique par défaut ne le reprogrammait pas
— corrigé en pré-configurant l'intervalle rapide avant tout appel CLI.
Suite élargie (RIP/EIGRP+BGP CLI/architecture routeur) : 41/41 au vert.
Typecheck et lint ciblés propres (mêmes erreurs/avertissements
pré-existants, aucun nouveau).

## Routeur Cisco — EIGRP `distribute-list prefix-list <name> in|out`

Suite du même chantier de filtrage par `ip prefix-list`, appliqué cette
fois à EIGRP plutôt qu'à BGP. Contrairement au BGP, EIGRP n'a pas de
config par voisin (`neighbor`) : le filtrage est global au processus,
comme la vraie commande IOS `distribute-list prefix-list <name> in|out`
sans interface. `EIGRPConfig` gagne `distributeListIn`/`distributeListOut`
— l'engine avait déjà accès à `RoutingDeviceContext.evaluatePrefixList`
(câblé pour BGP), donc **aucun nouveau câblage Router/CiscoIOSShell
n'était nécessaire**, juste sa consultation dans `EIGRPEngine`.

`onUpdate` filtre désormais les routes d'un Update entrant avant de les
retenir dans la table de voisinage ; `buildUpdate` filtre les préfixes
originés et réappris avant de les inclure dans l'Update sortant (les
deux boucles de la table complète). CLI : `distribute-list prefix-list
<name> in|out` sous `router eigrp`, appliqué immédiatement (le
`converge()` déclenché par la commande relance un Hello, donc un
Update complet, chez les voisins déjà adjacents — pas besoin de
réinitialiser l'adjacence).

**Validation** : 4 nouveaux tests `EIGRPEngine` (filtrage entrant,
filtrage sortant, liste inexistante = deny implicite, absence de filtre
= comportement inchangé) + 1 test CLI bout-en-bout (deux `CiscoRouter`
réellement câblés, `distribute-list` configuré **après** que
l'adjacence soit déjà établie, prouvant la re-convergence). Suite EIGRP
élargie (engine/wire/metric/intégration CLI EIGRP+BGP) : 48+7 tests au
vert. Typecheck et lint ciblés propres.

## Routeur Cisco — route-map BGP par voisin (`neighbor <ip> route-map <name> in|out`)

Suite directe du filtrage par `prefix-list` : les `route-map` (clauses
`match`/`set`) existaient déjà côté CLI (`PolicyRepository`) mais,
là aussi, n'étaient jamais évaluées par un moteur de protocole —
seulement affichées par `show route-map`.

`PolicyRepository` gagne `evaluateRouteMap(name, network, prefixLength)`
— première clause correspondante en ordre de seq (une clause sans
`match ip address prefix-list …` correspond sans condition ; les autres
types de `match` — communauté, as-path, tag — ne sont pas évalués
structurellement, portée volontairement limitée), renvoyant l'action
**et** les `set` reconnus, réellement parsés depuis les chaînes brutes :
`set weight`, `set local-preference`, `set metric`, `set as-path
prepend`. `null` = route-map absente ou aucune clause ne correspond
(deny implicite, même convention que `evaluatePrefixList`).

`BgpNeighborCfg` gagne `routeMapIn`/`routeMapOut` (mêmes hooks
`IRouterShell`/`RoutingDeviceContext`/`DynamicRoutingCtx` réutilisés,
paresseusement propagés jusqu'à `BGPEngine` — zéro changement
d'ownership). `onUpdate` applique `routeMapIn` : filtre comme un
prefix-list, puis pose `set weight`/`set local-preference` sur l'entrée
acceptée (attributs consultés à la réception, comme le fait réellement
IOS). `advertiseTo` applique `routeMapOut` : filtre, puis pose `set
metric` (MED) et préfixe l'AS_PATH sortant avec `set as-path prepend`
(attributs posés à l'annonce). CLI : `neighbor <ip> route-map <name>
in|out`, reflété dans `show ip bgp neighbors`.

**Validation** : `PolicyRepository.evaluateRouteMap` (4 tests unitaires
— clause sans match/deny sans set/gating par prefix-list/nom inconnu) +
4 nouveaux tests `BGPEngine` : `set weight`/`set local-preference`
observés sur `show ip bgp` du routeur récepteur ; refus par route-map
sans clause permissive ; `set as-path prepend` observé dans l'AS_PATH
appris par le voisin ; `set metric` **change réellement la sélection du
meilleur chemin** entre deux annonces de la même AS voisine (le test
force un scénario où, sans l'application du MED, le départage par
router-id donnerait un gagnant différent — donc un test qui prouve
vraiment la fonctionnalité, pas une coïncidence). Suite BGP élargie
(engine/bestpath/session/messages/intégration CLI EIGRP+BGP) : 60/60 au
vert. Régression routeur plus large (architecture/HSRP/ACL/NAT/show) :
127/127 au vert. Typecheck et lint ciblés propres (mêmes erreurs/
avertissements pré-existants qu'avant ce changement, aucun nouveau).

## Routeur Cisco — filtrage BGP par voisin (`neighbor <ip> prefix-list <name> in|out`)

**Changement de couche métier** (fin du lot Windows Server AD DS — retour
à la simulation réseau générale). `ip prefix-list`/`route-map` existaient
déjà côté CLI (`PolicyRepository`, `CiscoPolicyCommands.ts`) mais
n'avaient **aucun effet réel** : `show ip prefix-list`/`show route-map`
projetaient un état jamais consulté par un moteur de protocole — un vrai
trou de couche métier derrière une façade CLI qui répondait normalement.

`PolicyRepository` gagne `evaluatePrefixList(name, network, prefixLength)`
— longest-first-match réel (bornes `ge`/`le`, sans elles une entrée exige
une longueur de préfixe exacte, sémantique IOS authentique), `null` si la
liste n'existe pas ou qu'aucune entrée ne correspond (deny implicite,
charge à l'appelant). Exposé via un nouveau hook optionnel
`IRouterShell.evaluatePrefixList` (implémenté par `CiscoIOSShell`),
propagé paresseusement à travers `RoutingDeviceContext`/
`DynamicRoutingCtx` jusqu'à `BGPEngine` (aucun changement d'ownership,
aucun souci d'ordre de construction — uniquement des fermetures
différées, sur le modèle déjà établi de `getRipEngine`/`getOspfIntegration`).

`BgpNeighborCfg` gagne `prefixListIn`/`prefixListOut` ; `BGPEngine` les
applique désormais réellement : `onUpdate` (Adj-RIB-In) rejette toute
NLRI entrante que la liste nommée ne permet pas explicitement, et
`advertiseTo` (Adj-RIB-Out) n'annonce à ce voisin que ce que la liste
nommée permet. CLI : `neighbor <ip> prefix-list <name> in|out` dans
`router bgp`, reflété dans `show ip bgp neighbors`.

**Validation** : `PolicyRepository.evaluatePrefixList` (5 tests unitaires
— première correspondance par ordre de seq, bornes ge/le, correspondance
de longueur exacte sans ge/le, liste inconnue) + 4 nouveaux tests
`BGPEngine` (filtrage entrant, filtrage sortant, liste inexistante =
deny implicite, absence de filtre = comportement inchangé) + 1 test CLI
bout-en-bout (deux `CiscoRouter` réellement câblés, `ip prefix-list` +
`neighbor ... prefix-list ... in` filtrant un préfixe appris sur
`show ip route`). Suite BGP élargie (engine/bestpath/session/messages/
intégration CLI EIGRP+BGP) : 52/52 au vert. Régression routeur plus
large (architecture/HSRP/ACL/NAT/show) : 127/127 au vert. Typecheck et
lint ciblés propres (mêmes 8 erreurs `tsc` et mêmes avertissements
`eslint` pré-existants qu'avant ce changement, aucun nouveau).

## Linux — Phase 27 : ordonnancement `nice` / `renice` / `chrt` / `ionice` / `taskset` (fin de la famille processus)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Complète la famille processus (volet ordonnancement) sur la capacité
`processControl`, désormais étendue à cet effet.

- **`ProcessControlApi` élargie** : `get(pid)`, `renice`,
  `setSchedPolicy`, `setIoClass`, `setCpuAffinity` ; `ProcessEntry`
  gagne `nice`, `schedPolicy`, `rtPriority`, `ioClass`, `ioClassData`,
  `cpuAffinity`. `LinuxProcessControlApi` mappe le tout sur la table
  vivante (`LinuxProcessManager`) — `renice` continue de passer par
  `processManager.renice`, donc l'évènement réactif
  `linux.process.priority-changed` est toujours publié.
- **5 commandes autonomes** lisant/écrivant uniquement via
  `ctx.machine.processControl` : `nice` (affiche/valide l'ajustement),
  `renice` (règles POSIX root/utilisateur, priorité négative refusée aux
  non-root), `chrt` (`-m`, get/set SCHED_*), `ionice` (classes 0-3,
  get/set), `taskset` (masque hex / liste `-c`). Chacune implémente
  `validate` (les erreurs GNU — priorité invalide, PID inexistant — sont
  rendues dans `execute` avec le code de sortie exact, pas via `UsageError`).
- **`case 'nice'/'renice'/'chrt'/'ionice'/'taskset'` retirés** de
  `LinuxCommandExecutor` ; **module hérité `process/PriorityCommands.ts`
  supprimé** (plus aucune référence).

Validation : `linux-priority-commands` (13/13) ;
`linux-process-service-events` + suites processus (67/70, les 3 échecs
`$$`/`$PPID` étant préexistants et sans rapport) ; typecheck propre,
lint ciblé sans nouvelle erreur.

## Linux — Phase 26 : migration de `pgrep` / `pkill` / `killall` (famille processus)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Suite de la famille processus sur la capacité `processControl` : `pgrep`,
`pkill`, `killall` migrées de façon **autonome**.

- Sélection faite **elle-même** dans chaque commande sur
  `ctx.machine.processControl.list()` : `pgrep` (sous-chaîne dans
  `comm`/`command`, filtres `-u`/`-l`), `pkill` (sous-chaîne + `signal()`),
  `killall` (correspondance exacte `comm`, protection du PID 1). Envoi de
  signal via `processControl.signal()`.
- **Nouvel utilitaire partagé `commands/signals.ts`** (table POSIX +
  `parseSignalArg` pour `-9`/`-KILL`/`-SIGTERM`), propre à la couche
  command-kernel — pas d'appel au module hérité.
- **`case 'pgrep'/'pkill'/'killall'` retirés** de `LinuxCommandExecutor`
  (imports `cmdPgrep`/`cmdPkill`/`cmdKillall` nettoyés).

Validation : `linux-session-process-coherence` +
`linux-process-service-integration` (37/37) ; `linux-lan-ssh-suite`
inchangé (2 échecs préexistants sans rapport) ; aucune régression.

## Linux — Phase 25 : capacité `ProcessControlApi` + migration de `pidof`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Ouverture de la **famille processus** via une nouvelle capacité
command-kernel, puis migration de sa première commande de façon autonome.

- **Nouvelle capacité `processControl?: ProcessControlApi`** sur
  `MachineApi` : `list()` (instantané de la table des processus, type
  `ProcessEntry` riche — `pid`/`ppid`/`pgid`/`uid`/`user`/`comm`/`command`/
  `state`/`tty`) et `signal(pid, signal)` (envoi de signal, `false` si le
  PID n'existe pas). Implémentée dans `LinuxMachineApi`
  (`LinuxProcessControlApi`) en enveloppant le `LinuxProcessManager`.
- **`PidofCommand`** : sélection `comm === nom` faite **elle-même** sur
  `list()`, PID triés décroissants, code de sortie 1 si aucun. **`case
  'pidof'` retiré** de `LinuxCommandExecutor` (import `cmdPidof` nettoyé).

Validation : `linux-process-service-integration.test.ts` (27/27) + contrôle
positif (`pidof systemd` → `1`) ; aucune régression.

## Linux — Phase 24 : `validate` généralisé aux commandes déjà migrées

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Mise en conformité avec le standard « toujours implémenter `validate` » :
ajout de la méthode `validate(args, session)` (override explicite,
documenté) aux commandes command-kernel qui ne l'avaient pas encore :
`basename`, `dirname`, `rev`, `printenv`, `truncate`, `mktemp`, `locale`,
et la base `ChecksumCommand` (`md5sum`/`sha1sum`/`sha256sum`).

- Pour ces commandes, les erreurs d'opérande à code de sortie GNU
  spécifique (1) sont rendues dans `execute` (pas via `UsageError`, code 2)
  ou déjà garanties par le parseur (`required: true`) ; les `validate`
  documentent donc ce choix.

Validation : `linux-commands-and-oracle-tools` + `env-vars` +
`auditctl-other` verts (235) ; aucune régression.

## Linux — Phase 23 : `file` rendue autonome (+ `validate`, suppression de `describeArchiveContent`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

`FileCommand` détecte désormais **elle-même** les archives simulées
(gz/tar/zip) — les marqueurs de format et le mini-parseur d'en-tête gzip
(`!<simgz>\n` + JSON `{name,mtime,payload}`) sont inlinés — au lieu
d'appeler `describeArchiveContent`. `validate` fourni.

- **`describeArchiveContent` supprimée** de `coreutils/ArchiveCommands.ts`
  (+ son ré-export) : plus aucun appel au module hérité depuis le
  command-kernel. `ArchiveCommands.ts` demeure (ses codecs servent encore
  aux commandes `tar`/`gzip`/`zip` non migrées).

Validation : `archive-commands.test.ts` passe intégralement (16/16, dont
les 8 assertions `file` : texte, `.gz`, `.tar`, `.zip`, répertoire,
absent, vide, script `#!`) ; aucune régression.

## Linux — Phase 22 : `expr` rendue autonome (+ `validate`, suppression de `coreutils/ExprEvaluator`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

L'évaluateur POSIX complet (précédences `| & =…< + * :`, comparaison
chaîne/entier, fonctions `length`/`substr`/`index`/`match`, BRE ancré) est
désormais **co-localisé dans `Expr.ts`** (classe `ExprEvaluator` privée au
module de la commande, instanciée à neuf par exécution pour éviter tout
partage d'état). `ExprCommand` fournit `validate`.

- **`coreutils/ExprEvaluator.ts` supprimé** (+ son ré-export) : plus aucun
  appel au module hérité. La conversion BRE→JS réutilise l'utilitaire regex
  **partagé** `posixToJsSource` (infrastructure, comme une bibliothèque
  standard — pas une implémentation de commande héritée). Codes de sortie
  GNU conservés (0/1/2/3), rendus dans `execute`.

Validation : les 13 tests `expr` de `test-expr-seq-sleep-time-watch.test.ts`
(fichier complet 53/53) passent ; aucune régression.

## Linux — Phase 21 : `diff` rendue autonome (+ `validate`, suppression de `coreutils/DiffCommand`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

`DiffCommand` implémente désormais **elle-même** tout l'algorithme (table
LCS, calcul des hunks, rendu `<`/`---`/`>`, en-têtes `NcM`) en méthodes
privées, et fournit `validate`. La lecture des deux fichiers passe par
`ctx.machine.fs`.

- **`coreutils/DiffCommand.ts` supprimé** : plus aucun appel au module
  hérité. Codes de sortie GNU conservés (0/1/2), rendus dans `execute`.

Validation : les 3 tests `diff` de `linux-commands-and-oracle-tools.test.ts`
passent ; aucune régression.

## Linux — Phase 20 : `seq` rendue autonome (+ `validate`, suppression de `SeqGenerator`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

`SeqCommand` implémente désormais **elle-même** tout le générateur GNU
(analyse `-s`/`-t`/`-w`/`-f` + formes longues, précision décimale, pas
négatif, largeur égale, printf `%f/%g/%e/%d/%s`) sous forme de méthodes
privées, et fournit `validate`.

- **`coreutils/SeqGenerator.ts` supprimé** (+ son ré-export depuis
  `coreutils/index.ts`) : plus aucun appel au module hérité.
- Garde-fou appris : une méthode privée **ne doit pas s'appeler `run`** —
  cela masquerait le point d'entrée `BaseCommand.run(ctx)` ; la logique est
  donc portée par `generate(argv)`.

Validation : les 12 tests `seq` de `test-expr-seq-sleep-time-watch.test.ts`
+ `linux-commands-and-oracle-tools` + cohérence stricte passent (184) ;
aucune régression.

## Linux — Phase 19 : `tty` / `sleep` rendues autonomes (+ `validate`, suppression des modules hérités)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Application du nouveau standard aux commandes déjà migrées mais qui
appelaient encore un module hérité : `tty` et `sleep` implémentent
désormais **elles-mêmes** leur logique et fournissent `validate`.

- `TtyCommand` : le format du chemin de terminal est inliné (plus d'appel à
  `SystemInfo.cmdTty`) ; **`cmdTty` supprimé** de `system/SystemInfo.ts`.
- `SleepCommand` : l'analyse des durées `NOMBRE[s|m|h|d]` (sommes
  incluses) est inlinée ; **`coreutils/Sleep.ts` supprimé** ainsi que son
  ré-export depuis `coreutils/index.ts`. Les erreurs conservent le code de
  sortie GNU 1 (rendu dans `execute`, pas via `UsageError`/code 2), d'où un
  `validate` explicite mais délibérément vide, documenté.

Validation : `test-expr-seq-sleep-time-watch.test.ts` et
`linux-system-info.test.ts` verts (69) ; aucune régression.

## Linux — Phase 18 : `clear` / `reset` (nouveau standard : commandes autonomes + `validate`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commandes migrées** : `clear` et `reset` — émettent la séquence ANSI
d'effacement d'écran (`\x1b[2J\x1b[H`), portées par `ClearCommand` /
`ResetCommand`.

- **Nouveau standard adopté ici** (à généraliser) : chaque commande
  command-kernel est désormais **autonome** — elle implémente sa propre
  logique sans appeler les modules hérités, de sorte que ces derniers
  pourront être supprimés ; et elle **implémente toujours** la méthode
  `validate(args, session)` de `BaseCommand` (validation métier
  post-parsing, `UsageError` en cas d'incohérence). `clear`/`reset`
  n'ayant aucun argument significatif, leur `validate` est explicite mais
  vide.
- **Legacy supprimé** : les `case 'clear'`/`'reset'` retirés de
  `LinuxCommandExecutor.dispatch()`. Nouveau test `clear`/`reset`.

Validation : test `clear`/`reset` vert ; aucune régression.

## Linux — Phase 17 : `diff`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `diff FICHIER1 FICHIER2` — comparaison ligne à ligne
(format « normal » GNU), portée par `DiffCommand`.

- L'algorithme (LCS, hunks) reste porté par le module pur **partagé**
  `cmdDiff`, qui attend un accès fichier **synchrone** : les opérandes sont
  donc pré-lus via `ctx.machine.fs` (asynchrone) puis exposés à `cmdDiff`
  par un cache indexé sur le chemin résolu — le pont sync/async sans
  resimuler l'algorithme.
- **Legacy supprimé** : le `case 'diff'` retiré de
  `LinuxCommandExecutor.dispatch()`, import `cmdDiff` nettoyé. Nouveaux
  tests `diff` (fichiers identiques, hunk de changement, fichier absent).

Validation : tests `diff` verts ; cohérence stricte verte ; aucune
régression (67 tests).

## Linux — Phase 16 : `md5sum` / `sha1sum` / `sha256sum`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commandes migrées** : `md5sum`/`sha1sum`/`sha256sum [-c] FICHIER...` —
calcul (`hash  fichier`) et vérification (`-c`) d'empreintes, portées par
une base commune `ChecksumCommand` et trois sous-classes (une par
algorithme).

- La lecture des fichiers passe par `ctx.machine.fs` ; les fonctions de
  hachage restent **partagées** (`@/crypto/hash` : `md5Hex`/`sha1Hex`/
  `sha256Hex`), pas resimulées. Mode `-c` : parsing des lignes
  `empreinte  chemin`, `OK`/`FAILED`, avertissement + code 1 en cas
  d'échec ; mode direct : code 0 même si un fichier manque (quirk legacy
  conservé).
- **Legacy supprimé** : le `case 'md5sum'/'sha256sum'/'sha1sum'`, la
  fonction `checksumVfs()` et l'import `md5Hex/sha1Hex/sha256Hex` retirés
  de `LinuxCommandExecutor`. Nouveaux tests (empreintes connues de
  « hello » + vérification `-c`).

Validation : tests checksum verts (md5/sha1/sha256 de « hello » exacts,
`-c` → `OK`) ; cohérence stricte + archive-commands verts ; aucune
régression (83 tests).

## Linux — Phase 15 : `locale`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `locale` — affiche les paramètres régionaux actifs,
portée par `LocaleCommand`.

- Les catégories (`LANG`, `LANGUAGE`, `LC_CTYPE`…`LC_ALL`) sont dérivées de
  l'environnement de la session (`ctx.session.env`) ; chaque `LC_*` non
  défini retombe sur la locale effective (`LC_ALL` sinon `LANG` sinon `C`),
  exactement comme le legacy.
- **Legacy supprimé** : le `case 'locale'` retiré de
  `LinuxCommandExecutor.dispatch()`. Nouveau test `locale`
  (`export LANG=… ; locale`).

Validation : test `locale` vert (LANG reflété, repli des catégories) ;
cohérence stricte + host-identity verts ; aucune régression (74 tests).

## Linux — Phase 14 : `file`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `file FICHIER...` — devine le type de chaque fichier
(lien symbolique, répertoire, périphérique caractère, archive gz/tar/zip,
script `#!`, texte ASCII, données binaires), portée par `FileCommand`.

- La classification reproduit à l'identique la logique historique
  `describeFile`, désormais alimentée par `ctx.machine.fs` (`lstat` +
  lecture, `symlinkTarget`) et le détecteur d'archives pur **partagé**
  `describeArchiveContent`.
- **Legacy supprimé** : le `case 'file'` **et** la méthode `describeFile()`
  retirés de `LinuxCommandExecutor`, import `describeArchiveContent`
  devenu inutile nettoyé.

Validation : `archive-commands.test.ts` passe intégralement (16/16, dont
les 8 assertions `file` : texte, `.gz`, `.tar`, `.zip`, répertoire,
fichier absent, vide, script `#!`) ; cohérence stricte verte ; aucune
régression (67 tests).

## Linux — Phase 13 : `mktemp`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `mktemp [OPTION]... [MODÈLE]` — portée par
`MktempCommand`.

- Renvoie un nom de fichier temporaire unique au format `/tmp/tmp.<aléa>`
  (10 caractères base36). Le simulateur ne matérialise pas le fichier
  (comportement historique conservé à l'identique) ; les options
  (`-d`, template `XXXXXX`...) sont acceptées mais ignorées.
- **Legacy supprimé** : le `case 'mktemp'` retiré de
  `LinuxCommandExecutor.dispatch()`. Nouveau test `mktemp` (format + unicité).

Validation : test `mktemp` vert ; aucune régression.

## Linux — Phase 12 : `truncate`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `truncate -s TAILLE FICHIER...` — portée par
`TruncateCommand`.

- Le simulateur ne modélisant pas les tailles d'octets, la commande se
  limite (comme le legacy) à créer un fichier vide s'il n'existe pas, et
  publie les évènements d'audit `fsAccess`/`syscall` « truncate » via la
  capacité `ctx.machine.audit` — indispensable pour que `auditctl -w`
  capte l'accès.
- **Legacy supprimé** : le `case 'truncate'` retiré de
  `LinuxCommandExecutor.dispatch()`.

Validation : `auditctl-other.test.ts` passe intégralement (150/150, dont
le suivi `syscall=truncate` d'un fichier surveillé) ; cohérence stricte
verte ; aucune régression (67 tests).

## Linux — Phase 11 : `tty`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `tty [-s]` — affiche le nom du terminal relié à
l'entrée standard, portée par `TtyCommand`.

- En mode exec SSH sans pseudo-terminal (le client pose `SSH_NO_TTY=1`,
  lu depuis `ctx.session.env`), répond « not a tty » avec le code de
  sortie 1 ; sinon `/dev/pts/0`. Option `-s` (silencieux) gérée. Le
  formatage du chemin reste porté par le helper pur partagé `cmdTty`.
- **Legacy supprimé** : le `case 'tty'` retiré de
  `LinuxCommandExecutor.dispatch()`, import `cmdTty` devenu inutile
  nettoyé.

Validation : `linux-system-info.test.ts` (`tty` → `/dev/pts/0`) et les cas
SSH `cross-equipment-ssh-suite.test.ts` (`ssh -t … tty` → `/dev/pts`,
`ssh … tty` → `not a tty`) passent ; aucune régression (les 19 échecs
préexistants de cette suite, sans rapport avec `tty`, sont identiques
avant/après).

## Linux — Phase 10 : `printenv`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `printenv [VARIABLE...]` — affiche tout
l'environnement (`NOM=valeur`) ou la valeur de variables nommées (une par
ligne, code de sortie 1 si l'une est absente), portée par
`PrintenvCommand`.

- L'environnement est lu depuis la session command-kernel
  (`ctx.session.env`) — qui reflète bien les affectations `export`
  antérieures dans la même ligne/pipeline (validé par
  `export MYTOKEN=… ; printenv MYTOKEN`).
- **Legacy supprimé** : le `case 'printenv'` retiré de
  `LinuxCommandExecutor.dispatch()`.

Validation : `env-vars.test.ts` passe intégralement (9/9, dont
`printenv`, `printenv SHELL`, export puis lecture, variable absente) ;
cohérence stricte verte ; aucune régression (66 tests).

## Linux — Phase 9 : `rev`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `rev [fichier...]` — inverse l'ordre des caractères
de chaque ligne, portée par `RevCommand`.

- Lit désormais l'entrée standard **ou les fichiers** passés en argument
  (comportement GNU ; le legacy était limité à stdin) via les helpers
  partagés `readTextInput`/`splitLines`/`joinLines`. La structure des
  lignes et le saut de ligne final sont préservés à l'octet près (mêmes
  résultats que le legacy pour le cas stdin).
- **Legacy supprimé** : le `case 'rev'` retiré de
  `LinuxCommandExecutor.dispatch()`. Nouveau test `rev` ajouté
  (`linux-commands-and-oracle-tools.test.ts`).

Validation : tests `rev` verts, cohérence stricte verte ; aucune
régression (67 tests).

## Linux — Phase 8 : `sleep`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `sleep NOMBRE[SUFFIXE]...` — portée par la commande
command-kernel `SleepCommand`.

- Le simulateur étant synchrone, la durée calculée est ignorée (exactement
  comme le legacy) : seule la **validation** des opérandes compte (`1`,
  `1s`, `2m`, `1h`, `1d`, `0.5`, sommes de plusieurs durées, erreur
  « invalid time interval » sur token invalide). Le parsing des durées
  reste porté par le module pur **partagé** `runSleep` (`coreutils/Sleep.ts`).
- **Legacy supprimé** : le `case 'sleep'` retiré de
  `LinuxCommandExecutor.dispatch()`, import `runSleep` devenu inutile
  nettoyé ; `sleep` reste dans la liste des commandes connues.

Validation : `test-expr-seq-sleep-time-watch.test.ts` passe intégralement
(53/53, dont les cas `sleep 1 && echo DONE`, suffixes, `sleep || echo BAD`,
`sleep abc`, `sleep 0.5`) ; cohérence stricte verte ; aucune régression
Linux voisine (77 tests).

## Linux — Phase 7 : `expr`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `expr EXPRESSION` — évaluation d'expressions
(arithmétique, comparaison, chaînes), portée par la commande
command-kernel `ExprCommand`.

- Toute l'évaluation (priorités, opérateurs `+ - * / % = < > | &`,
  `match`/`substr`/`length`/`index`) reste assurée par l'évaluateur pur
  **partagé** `runExpr` (`coreutils/ExprEvaluator.ts`). `ExprCommand` capte
  les opérandes bruts (`lenientOptions`), termine la sortie par un saut de
  ligne (comportement GNU) et conserve les codes de sortie exacts de GNU
  `expr` (`0` vrai, `1` faux, `2`/`3` erreur).
- **Legacy supprimé** : le `case 'expr'` et son wrapper `handleExpr()`
  retirés de `LinuxCommandExecutor`, import `runExpr` devenu inutile
  nettoyé ; `expr` reste dans la liste des commandes connues.

Validation : le fichier `test-expr-seq-sleep-time-watch.test.ts` (qui
pilote un `LinuxCommandExecutor` nu, résolu via son shell command-kernel
par défaut) passe intégralement (53/53) ; cohérence stricte verte ; aucune
régression Linux voisine (130 tests).

## Linux — Phase 6 : `seq`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `seq [OPTION]... PREMIER [PAS] DERNIER` — génération
d'une suite de nombres, portée par la commande command-kernel
`SeqCommand`.

- Le rendu (formats GNU `-w`/`-f`/`-s`/`-t`, précision décimale, pas
  négatif, largeur égale) reste assuré par le générateur pur **partagé**
  `runSeq` (`coreutils/SeqGenerator.ts`) — pas de resimulation. `SeqCommand`
  capte les opérandes bruts (`lenientOptions`, le parsing des options
  appartient à `runSeq`) et termine la sortie par un saut de ligne dès
  qu'elle est non vide (comportement GNU, indispensable en pipeline
  `seq N | wc -l`).
- **Legacy supprimé** : le `case 'seq'` retiré de
  `LinuxCommandExecutor.dispatch()` et l'import `runSeq` devenu inutile
  nettoyé ; `seq` reste dans la liste des commandes connues.

Validation : les tests `seq` de `linux-commands-and-oracle-tools.test.ts`
passent, cas limites vérifiés (séparateur `-s`, largeur `-w`, pipeline,
premier négatif, pas) ; cohérence stricte inter-machines verte ; aucune
régression Linux voisine (143 tests).

## Linux — Phase 5 : `basename` / `dirname`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commandes migrées** : `basename NOM [SUFFIXE]` / `basename -a [-s SUFFIXE]
NOM...` et `dirname NOM...` — manipulation de chemin purement textuelle
(aucun accès au VFS), portée par les commandes command-kernel
`BasenameCommand` / `DirnameCommand`.

- Sémantique POSIX complète (là où le legacy était simpliste) : les slashs
  finaux sont ignorés (`basename /usr/` → `usr`, `dirname /usr/bin/` →
  `/usr`), un chemin entièrement composé de slashs donne `/`, et les
  formes multiples (`-a`, `-s SUFFIXE`, séparateur NUL `-z`) sont gérées —
  aucune capacité `MachineApi` requise (chaînes pures).
- **Legacy supprimé** : les `case 'basename'` et `case 'dirname'` retirés
  de `LinuxCommandExecutor.dispatch()` — aucun autre appelant, absents du
  framework `LinuxCommand`. Les deux restent dans la liste des commandes
  connues (résolution `which`/`command -v` inchangée).

Validation : les tests `basename`/`dirname` de
`linux-commands-and-oracle-tools.test.ts` passent, cohérence stricte
inter-machines `ssh-lan-strict-coherence.test.ts` (SC34) verte ; aucune
régression sur les suites Linux voisines (command-kernel, vfs-path,
availability, bash-scripts, sftp — 227 tests).

## Windows Server — application du bit `SMARTCARD_REQUIRED` (`userAccountControl`)

Totalement absent jusqu'ici. `checkPassword` (bind simple LDAP, même
périmètre volontaire que le verrouillage/l'expiration/`maxPasswordAge`)
refuse désormais systématiquement l'authentification par mot de passe
dès que le bit `SMARTCARD_REQUIRED` (`0x40000`) est posé — comportement
réel d'AD : seule une ouverture de session par carte à puce (PKINIT,
non modélisée ici) fonctionnerait. `AdUser` gagne
`smartcardRequired: boolean` ; `setUser` accepte désormais
`smartcardRequired` en lecture-modification-écriture du bit, sans
toucher aux autres bits (`enabled`/`passwordNeverExpires`).

**Validation** : nouveau `ad-smartcard-required.test.ts` (5 tests) —
valeur par défaut, blocage de l'authentification une fois le bit posé
même avec le bon mot de passe, réauthentification après levée du bit,
non-altération des bits UAC non liés, absence d'effet sur
`enabled`/`lockedOut`. Suite élargie (`ad-directory-store`/expiration/
politique de mot de passe/dernière-connexion/types de chiffrement
Kerberos/échange AS) : 85/85 au vert. Typecheck et lint ciblés propres.

## Windows Server — application de `msDS-SupportedEncryptionTypes` (Kerberos)

Totalement absent jusqu'ici : le KDC (`KdcSession`) émettait toujours un
ticket AES256, sans jamais consulter la restriction de types de
chiffrement d'un compte. `AdUser`/`AdComputer` gagnent
`supportedEncryptionTypes: number` (bitmask), avec accesseurs
`get/setUserSupportedEncryptionTypes` et `get/setComputerSupportedEncryptionTypes`
sur `DirectoryStore`, et `supportsAes256(sam, isComputer)` pour
l'application. Valeur par défaut quand l'attribut n'a jamais été posé :
`0x1C` (RC4+AES128+AES256), reflet du comportement réel d'un domaine
moderne — un `0` explicite reste distinct de « jamais configuré » et
désactive bien AES256.

`handleAsReq` (AS-REQ) refuse désormais avec `KDC_ERR_ETYPE_NOSUPP` dès
que le compte authentifiant (utilisateur ou ordinateur) n'a pas le bit
AES256, ou que le client n'offre pas l'etype 18 — AES256 étant le seul
chiffrement réellement implémenté par ce simulateur (`crypto.ts`), un
compte restreint ne peut pas être « replié » sur un autre algorithme.
**Périmètre volontairement borné à l'AS-REQ** (authentification
initiale) — le TGS-REQ/S4U2Proxy n'est pas touché, cohérent avec la
discipline déjà appliquée au verrouillage/à l'expiration de compte.

**Validation** : nouveau `ad-supported-encryption-types.test.ts` (9 tests :
valeur par défaut, accesseurs get/set utilisateur et ordinateur, échec
sur identité inconnue, `supportsAes256`, `0` explicite vs non configuré,
plus 3 tests d'intégration bout-en-bout sur un vrai câble TCP/88 —
échange réussi par défaut, refus après restriction, rétablissement après
réautorisation). Suite Kerberos élargie (AS/TGS/S4U2Proxy/RBCD/
`ad-directory-store`/dernière-connexion/contacts) : 86/86 au vert.
Typecheck et lint ciblés propres.

## Windows Server — refactor : extraction de `ContactStore` hors de `DirectoryStore.ts`

**Refactor, pas une nouvelle fonctionnalité.** `DirectoryStore.ts` avait
dépassé les 1000 lignes au fil du lot de 10+ fonctionnalités (discipline
du projet : pas de fichier au-delà de ~400 lignes, déjà appliquée une
fois cette session pour `WindowsServer.ts` via l'extraction de
`DomainControllerOps.ts`). La section Contacts (`newContact`/
`getContact`/`listContacts` + projection) était la tranche la plus
proprement isolable — elle ne partage d'état avec le reste de
`DirectoryStore` que l'arbre LDAP (`tree`) et l'OU `Users` par défaut.

Extraite vers `ad/contact/ContactStore.ts` (même schéma que
`ManagedServiceAccountStore`/`PasswordReplicationPolicy` : classe
composée par référence, prenant `tree` + `usersOuDn`, avec ses propres
petits helpers dupliqués plutôt que d'exporter les helpers internes de
`DirectoryStore`). `DirectoryStore` ne garde que des méthodes de
délégation fines ; `newContact` continue de résoudre le conteneur OU
et d'allouer le RID/objectSid lui-même avant de déléguer.

**Validation** : aucune régression de comportement — `ad-contacts.test.ts`
(7 tests, écrit contre l'API publique de `DirectoryStore`, donc inchangé
par ce refactor) plus la suite élargie (verrouillage/expiration/
groupes/RBCD/réplication/dernière-connexion/politique de mot de passe/
`ad-directory-store`) : 101/101 au vert. Typecheck et lint ciblés propres.

## Windows Server — suivi de la dernière connexion (`lastLogonTimestamp`)

Totalement absent jusqu'ici. `checkPassword` (bind simple LDAP, même
périmètre volontaire que le verrouillage/l'expiration) tamponne
désormais `lastLogonTimestamp` sur chaque authentification réussie,
fondu dans le même appel `modifyEntry` que la remise à zéro de
`badPwdCount`. `AdUser` gagne `lastLogonTimestamp: number | null`.

**Simplification documentée** : AD réel distingue `lastLogon`
(par-DC, jamais répliqué) de `lastLogonTimestamp` (répliqué, mais mis
à jour seulement au-delà d'un certain seuil d'ancienneté pour éviter
les tempêtes de réplication) — ce simulateur ne modélise que
l'équivalent de `lastLogonTimestamp`, mis à jour à chaque succès sans
palier d'ancienneté.

**Validation** : nouveau `ad-last-logon.test.ts` (4 tests) — `null`
avant toute authentification, tamponné après un succès, jamais
tamponné après un échec, avance à chaque nouveau succès. Suite élargie
(verrouillage/politique de mot de passe/expiration/`ad-directory-store`) :
66/66 au vert. Typecheck et lint ciblés propres.

## Windows Server — introspection des métadonnées de réplication (`Get-ADReplicationAttributeMetadata`)

Le timbre par attribut (`AttributeReplStamp`, ajouté par la mise à
niveau de réplication par attribut) n'était utilisable que par le
moteur de réplication lui-même. Nouveau `getReplicationMetadataFor(dn)`
sur `DirectoryStore`, projetant la `Map` interne en tableau plat
`ReplicationAttributeMetadata[]` (`attributeName` +
`originatingInvocationId`/`originatingUsn`/`version`/`timestamp`) —
`null` si l'objet n'existe pas, `[]` s'il existe mais n'a jamais été
timbré.

**Validation** : nouveau `ad-replication-metadata.test.ts` (3 tests) —
une écriture réelle fait progresser `version` (1 puis 2 après un second
changement), `null` sur un DN inconnu, deux DC convergent vers des
timbres strictement identiques (`originatingInvocationId`, `version`,
`originatingUsn`) pour un attribut après un cycle de réplication réel.
Suite élargie (`ad-replication`, `ad-directory-store`, `ad-rodc`) :
65/65 au vert. Typecheck et lint ciblés propres.

## Windows Server — délégation contrainte basée sur la ressource (RBCD)

Seule la délégation contrainte classique (front-end, `msDS-
AllowedToDelegateTo` déclaré côté service intermédiaire) existait.
Ajout du sens inverse (MS-SFU, `msDS-AllowedToActOnBehalfOfOtherIdentity`) :
la ressource elle-même autorise des principaux spécifiques à déléguer
vers elle, plutôt que l'inverse. Nouveaux
`setResourceBasedConstrainedDelegation(resourceComputerName,
allowedPrincipalSams)`/`getResourceBasedConstrainedDelegation(...)` sur
`DirectoryStore` — même simplification de liste directe de sam déjà
établie pour `PrincipalsAllowedToRetrieveManagedPassword` du gMSA.

`isDelegationAllowedFrom` (le portail S4U2Proxy de `KdcSession`)
vérifie désormais les deux voies — classique OU basée sur la ressource
— sans aucun changement à `KdcSession.ts` : le même échange KDC S4U2Proxy
existant sert les deux mécanismes, seule l'autorisation gagne une
deuxième voie.

**Validation** : nouveau `kerberos-rbcd.test.ts` (3 tests) — délégation
autorisée uniquement via RBCD (sans configuration classique), refus
quand la ressource ne liste pas le service délégant, échec propre sur
un ordinateur ressource inconnu. Suite élargie (`kerberos-s4u2proxy`,
`ad-directory-store`, `ad-contacts`) : 62/62 au vert, aucune régression
sur la délégation classique. Typecheck et lint ciblés propres.

## Windows Server — objets contact (`New-ADObject -Type contact`)

Absent jusqu'ici : `AdContact` (`AdTypes.ts`) et `newContact`/`getContact`/
`listContacts` sur `DirectoryStore` — une personne externe sans capacité
de connexion (`objectClass: ['top','person','organizationalPerson',
'contact']`, ni `sAMAccountName`, ni `userAccountControl`, ni mot de
passe). Attributs `displayName`/`mail`/`telephoneNumber`, placement en
OU optionnel (même convention que `newUser`). Reçoit tout de même un
`objectSid` du pool de RID local, comme tout autre objet ici (AD réel en
attribue aussi un, même si un contact n'est jamais un principal de
sécurité utile).

**Validation** : nouveau `ad-contacts.test.ts` (7 tests) — création avec
attributs complets/vides, placement en OU, refus de doublon,
énumération, retour `null` sur un contact inconnu, confirmation qu'un
contact n'apparaît jamais via `getUser`/`listUsers` (`findUserEntry`
filtre déjà sur l'objectClass `user`, absent des contacts). Suite
élargie (3 fichiers) : 78/78 au vert. Typecheck et lint ciblés propres.

## Windows Server — imbrication de groupes protégée contre les cycles

`addGroupMember` n'acceptait jusqu'ici qu'un utilisateur ou un
ordinateur comme membre — aucune voie publique n'existait pour imbriquer
un groupe dans un autre. Résout désormais aussi les groupes (comme
`Add-ADGroupMember` réel), avec une vérification anti-cycle : refuse
l'auto-appartenance directe (`Cannot make a group a member of itself`,
message réel d'AD) et transitive, via un nouveau
`isReachableViaMembership` privé qui parcourt l'appartenance imbriquée
du membre candidat pour vérifier si le groupe cible y est déjà
atteignable. `removeGroupMember` mis à jour symétriquement pour
résoudre aussi les groupes.

**Validation** : nouveau `ad-group-nesting.test.ts` (6 tests) —
imbrication simple autorisée, auto-appartenance directe refusée, cycle
à deux et trois niveaux refusé, diamant non cyclique (deux groupes
parents partageant un même groupe enfant) autorisé,
`removeGroupMember` retire bien un membre imbriqué. Suite élargie
(5 fichiers, y compris la conversion de portée de groupe de la tâche
précédente) : 111/111 au vert. Typecheck et lint ciblés propres.

## Windows Server — règles de conversion de portée de groupe (`Set-ADGroup -GroupScope`)

Aucune règle n'était appliquée jusqu'ici — n'importe quel changement de
portée réussissait sans condition. `DirectoryStore` gagne
`setGroupScope(sam, newScope)`, appliquant la vraie matrice de
conversion d'AD :

- `Global` ↔ `DomainLocal` : jamais direct (il faut passer par
  `Universal`).
- `Global` → `Universal` : refusé si le groupe est déjà membre d'un
  autre groupe de portée `Global`.
- `DomainLocal` → `Universal` : refusé si le groupe a un membre de
  portée `DomainLocal`.
- `Universal` → `Global` : refusé si le groupe a un membre de portée
  `Universal`.
- `Universal` → `DomainLocal` : toujours autorisé.
- Même portée demandée que la portée actuelle : succès immédiat, sans
  écriture.

Nouveau helper privé `groupScopeOfDn(dn)` — résout un DN `member`/
`memberOf` vers la portée du groupe qu'il désigne, réutilisant le même
schéma d'attribut déjà établi partout ailleurs dans ce fichier.

**Validation** : nouveau `ad-group-scope-conversion.test.ts` (11 tests)
— chacune des 5 règles testée dans son sens autorisé et son sens
refusé, no-op sur portée identique, échec propre sur un groupe inconnu.
Suite élargie (`ad-directory-store`, `ad-builtin-groups`, `ad-forest`) :
78/78 au vert. Typecheck et lint ciblés propres.

## Windows Server — groupes de sécurité intégrés (`Administrators`, `Account Operators`, etc.)

Seuls Domain Admins/Domain Users/Domain Computers étaient semés
jusqu'ici. `seedDefaults` sème désormais 8 groupes intégrés
supplémentaires (`Administrators`, `Account Operators`, `Backup
Operators`, `Server Operators`, `Print Operators`, `Cert Publishers`,
`Group Policy Creator Owners`, `DnsAdmins`), portée `DomainLocal`.
`Administrator` devient membre d'`Administrators` en plus de Domain
Admins/Domain Users.

**Simplification documentée** : AD réel place la plupart de ces groupes
dans un conteneur `CN=Builtin` dédié, sous des SID bien connus non
relatifs au domaine (`S-1-5-32-544` pour Administrators, etc.) —
`formatObjectSid` de ce simulateur ne modélise que des RID relatifs au
domaine, donc ces groupes sont semés dans `CN=Users` avec des SID
ordinaires du pool de RID local, comme tout autre objet ici. Enterprise
Admins/Schema Admins (niveau forêt) restent délibérément hors périmètre.

`SdProp.ts`'s `PROTECTED_GROUPS` passe de `['Domain Admins']` à
`['Domain Admins', 'Administrators', 'Account Operators', 'Backup
Operators', 'Server Operators', 'Print Operators']` — une passe SDProp
marque désormais aussi les membres de ces groupes fraîchement protégés.

**Deux assertions à liste exacte corrigées** dans
`ad-directory-store.test.ts` (« listGroups includes seeded and created
groups », « Administrator's memberOf reflects seeded group
membership ») — mécaniquement affectées par les 8 nouveaux groupes et
la nouvelle appartenance d'Administrator.

**Validation** : nouveau `ad-builtin-groups.test.ts` (5 tests) —
existence et portée `DomainLocal` de chaque groupe intégré,
appartenance d'Administrator, un utilisateur ordinaire n'y appartient
pas par défaut, SDProp marque les membres d'Account Operators/Backup
Operators/Server Operators/Print Operators. Suite élargie (9 fichiers,
verrouillage/politique de mot de passe/expiration/forêt/GPO) : 69/69 au
vert après correction des deux assertions. Typecheck et lint ciblés
propres.

## Convergence de branche : Windows Server (expiration de mot de passe) + Windows Phases 25-27 (`dnscmd`/`runas`/`slmgr`) + correctif `whoami`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le cœur Windows Server (contrôleur de domaine),
l'autre sur le pont Windows `command-kernel`, sans recouvrement de
fichiers en dehors de `CHANGELOG.md`.

### Windows Phase 30 : migration de `query session` / `qwinsta` / `logoff` / `rwinsta` vers command-kernel

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Migration des utilitaires de session Bureau à distance (`query session`,
`qwinsta`, `logoff`, `rwinsta`) — jusqu'ici non dispatchés — vers le socle
`command-kernel`.

- Nouvelle capacité optionnelle `rdpSessions?: RdpSessionsApi` sur
  `MachineApi` : `list()` (introspection de la table de sessions RDP) et
  `logoff(sessionId)` (fermeture). Type `RdpSessionInfo` au contrat. Les
  sessions RDP vivent sur tout `WindowsPC` (client comme serveur) — pas de
  frontière serveur ici.
- Commandes `QueryCommand` (sous-commande `session`), `QwinstaCommand`,
  `LogoffCommand`, `RwinstaCommand` : parsing, aide en `usage`, mise en
  page de la table (`SESSIONNAME`/`USERNAME`/`ID`/`STATE`/`TYPE`) et
  messages (`No session exists for ID …`) portés côté commande via des
  helpers partagés.
- Fichier mort `WinRdpCommands.ts` supprimé (migrate-then-delete).

Validation : `rdp-negotiation.test.ts` passe intégralement (5/5, contre
3/5 auparavant) ; aucune régression.

## Windows Phase 29 : migration de `certreq` / `certutil` vers command-kernel

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Migration de `certreq` / `certutil -submit` (demande de certificat à AD CS,
MS-WCCE) — jusqu'ici non dispatchés — vers le socle `command-kernel`.

- Nouvelle capacité optionnelle `certificateServices?: CertificateServicesApi`
  sur `MachineApi` : `submitRequest(subject, template, eku)` (émission
  signée par l'AC + stockage du certificat dans le magasin local). Types
  `CertificateServicesApi` / `CertificateIssuance` au contrat.
- `WindowsMachineApi` expose `certificateServices` en **getter live**
  (jamais mémoïsé) car le rôle AD CS peut être installé après la
  construction du shell ; `null` tant que l'AC n'est pas installée.
- Commandes `CertreqCommand` / `CertutilCommand` : parsing `-submit`
  `-template` `-subject` `-eku`, aide réelle complète en `usage`, formatage
  console (« Certificate Retrieved », « RPC server is unavailable ») porté
  côté commande via une logique de soumission partagée.
- Frontière client/serveur respectée : sans le rôle AD CS installé (donc
  sur un poste), `machine.certificateServices` est absent et `certreq`
  répond « RPC server is unavailable » — aucune fonctionnalité serveur
  exposée. Fichier mort `WinCertReq.ts` supprimé (migrate-then-delete).

Validation : `adcs-role.test.ts` + `iis-https-binding.test.ts` passent
(11/11, contre 8/11 auparavant) ; aucune régression.

## Windows Phase 28 : migration de `lpr` vers command-kernel

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Migration de `lpr` (soumission d'un travail à une file LPD distante,
RFC 1179) — jusqu'ici non dispatché — vers le socle `command-kernel`.

- Nouvelle capacité optionnelle `printClient?: PrintClientApi` sur
  `MachineApi` : `submitLpdJob(server, queue, jobName, content)` (vrai
  échange RFC 1179 ; propriétaire et hôte d'origine remplis par
  l'équipement).
- Commande `LprCommand` : parsing des options `-S`/`-P` (+ `-C`/`-J`/`-o`
  ignorées), lecture du fichier via `machine.fs`, aide réelle complète en
  `usage`, formatage console (usage, « cannot access », erreur de
  soumission) porté côté commande.
- Fichier mort `WinLpr.ts` supprimé (migrate-then-delete).

Validation : les 2 tests `lpr` de `print-services-lpd.test.ts` passent
(4/4, contre 2/4 auparavant) ; aucune régression.

## Windows Phase 27 : migration de `slmgr` vers command-kernel

Migration de `slmgr` / `slmgr.vbs` (Software Licensing Management Tool) —
jusqu'ici non dispatché — vers le socle `command-kernel`.

- Nouvelle capacité optionnelle `licensing?: LicensingApi` sur
  `MachineApi` : `installProductKey` (`/ipk`, validation de forme),
  `activate` (`/ato`) et lecture `productKey`/`state` (`/dlv`, `/dli`).
- `WindowsMachineApi` délègue à la primitive device `WindowsLicensingState`
  (état d'activation par machine, présent sur tous les SKU).
- Commande `SlmgrCommand` : dispatch `/ipk` / `/ato` / `/dlv` / `/dli`,
  aide réelle complète en `usage`, formatage console (dont la ligne
  « Name: » depuis `os.prettyName`) porté côté commande.
- Fichier mort `WinSlmgr.ts` supprimé (migrate-then-delete).

Validation : les 4 tests de `licensing-activation.test.ts` passent (4/4,
contre 0/4 auparavant) ; aucune régression.

### Windows — correctif : `whoami` local préserve la casse du nom d'utilisateur

Correctif ciblé dans `WindowsMachineApi.securityIdentity` : la forme
locale de `whoami` (`<hôte>\<utilisateur>`) minusculisait à tort le nom
d'utilisateur. Elle préserve désormais la casse du compte (`SRV1` →
`srv1\Administrator`) tout en gardant le nom d'hôte en minuscules ; la
forme domaine (`lab\alice`) reste inchangée (entièrement en minuscules,
conformément aux tests existants).

Validation : `windows-server-domain-join.test.ts` passe intégralement
(24/24 — c'était le dernier échec, « reverts to local whoami formatting »,
antérieur à la série de migrations) ; aucune régression sur les suites
whoami voisines (`windows-access-cmd`, `windows-access-powershell`,
`windows-drive-switching` : 122/122).

### Windows Server — expiration de mot de passe (`maxPasswordAge`) et `DONT_EXPIRE_PASSWORD`

`maxPasswordAge` était le dernier champ mort de `GpoAccountPolicy`/PSO —
déclaré, jamais vérifié. `checkPassword` (bind simple LDAP, même
périmètre volontaire que le verrouillage/l'expiration de compte) refuse
désormais l'authentification une fois le mot de passe trop ancien, sauf
si le compte porte le bit `DONT_EXPIRE_PASSWORD` (`0x10000`) de
`userAccountControl` (`Set-ADUser -PasswordNeverExpires`). `newUser`/
`setUser` gagnent l'option `passwordNeverExpires` ; `AdUser` gagne le
champ du même nom. `Administrator`/`krbtgt` (semés par
`seedDefaults`/`ensureKrbtgtPrincipal`) portent désormais ce bit par
défaut, comme AD réel.

**Correction en cours de route** : `setUser({enabled: ...})` remplaçait
jusqu'ici toute la valeur `userAccountControl` au lieu de ne modifier
que le bit `ACCOUNTDISABLE` — inoffensif tant qu'aucun autre bit
indépendant n'existait, mais aurait silencieusement effacé
`DONT_EXPIRE_PASSWORD` sur un compte qui le portait. Passé à une
lecture-modification-écriture qui préserve les autres bits.

**Régression détectée et corrigée pendant les tests** : une première
version tamponnait aussi `pwdLastSet` à la création du compte (pour
donner une base à `maxPasswordAge`) — inutile (la garde
`pwdLastSet > 0` de `checkPassword` neutralise déjà l'absence de
tampon) et en conflit direct avec la convention de la tâche précédente
(« le tout premier changement de mot de passe n'est jamais bloqué par
`minPasswordAge`, faute de référence antérieure ») — retiré.

**Validation** : nouveau `ad-password-expiration.test.ts` (5 tests) —
pas d'expiration immédiate après création, refus une fois
`maxPasswordAge` dépassé (tampon `pwdLastSet` simulé directement sur
l'entrée), exemption via `passwordNeverExpires`, bascule indépendante
de `enabled`/`passwordNeverExpires` via `setUser`, `Administrator`/
`krbtgt` n'expirent jamais par défaut. Suite élargie (7 fichiers,
verrouillage/politique de mot de passe/expiration/forêt/Kerberos) :
97/97 au vert. Typecheck et lint ciblés propres.

### Windows Phase 26 : migration de `runas` (chemin non-interactif) vers command-kernel

Migration du chemin non-interactif de `runas`
(`device.executeCommand('runas …')`, sans terminal donc sans vérification
de mot de passe) — jusqu'ici non dispatché — vers le socle `command-kernel`.
Le vrai prompt masqué vérifié de `WindowsTerminalSession` (chemin
interactif) n'est **pas** touché.

- Nouvelle capacité optionnelle `runAs?: RunAsApi` sur `MachineApi` :
  `getUser` (validation, forme d'une `RunasUserSource`), `currentUser`
  (`/netonly` = « exécuter en tant que l'appelant ») et `runCommandAs`
  (changement d'identité + **ré-entrée récursive** du shell puis
  restauration — vraie logon session distincte).
- `WindowsMachineApi` expose `runAs` en déléguant à
  `userMgr.getUser`/`currentUser` et à la primitive device
  `runAsUserVerified`.
- Commande `RunasCommand` : **réutilise** les helpers purs partagés
  `parseRunasArgs` / `validateRunasUser` (mêmes fonctions que le chemin
  terminal — pas de duplication) et porte l'orchestration/le formatage ;
  aide réelle complète (`runas /?`) en `usage`.
- Méthode morte `WindowsPC.cmdRunas` et helper orphelin
  `runRunasNonInteractive` supprimés (migrate-then-delete) ;
  `parseRunasArgs`/`validateRunasUser`/`runAsUser`/`runAsUserVerified`
  conservés (toujours utilisés par le chemin terminal interactif).

Validation : les 2 tests `runas` de `windows-access-cmd.test.ts` passent
(53/53) ; le chemin interactif reste vert (`runas-interactive.test.ts`,
`windows-access-powershell.test.ts`) ; aucune régression.

### Windows Phase 25 : migration de `dnscmd` vers command-kernel

Migration de `dnscmd` (administration cmd du serveur DNS) — jusqu'ici non
dispatché (`'dnscmd' n'est pas reconnu…`) — vers le socle `command-kernel`.

- Nouvelle capacité optionnelle `dnsServer?: DnsServerAdminApi` sur
  `MachineApi` : miroir cmd de la surface du module PowerShell `DnsServer`
  (zones primaires, enregistrements A/AAAA/CNAME/PTR/MX/SRV, suppression,
  impression de zone, énumération, redirecteurs). Types
  `DnsServerZoneRecord` / `DnsSrvRecordData` au contrat.
- `WindowsMachineApi` expose `dnsServer` en **getter live** (jamais
  mémoïsé) car le rôle DNS peut être installé après la construction du
  shell ; `null` tant que le rôle n'est pas installé.
- Commande `DnscmdCommand` : parsing des sous-commandes `/ZoneAdd`,
  `/RecordAdd`, `/RecordDelete`, `/ZonePrint`, `/EnumZones`,
  `/ResetForwarders`, saut du nom de serveur optionnel, aide réelle
  complète en `usage`, formatage console (codes `status = …`) porté côté
  commande.
- Frontière client/serveur respectée : sans le rôle DNS installé (donc sur
  un simple poste), `machine.dnsServer` est absent et `dnscmd` répond
  « not recognized » — aucune fonctionnalité serveur exposée. Fichier mort
  `WinDnscmd.ts` supprimé (migrate-then-delete).

Validation : les 3 tests `dnscmd` de `windows-server-dns.test.ts` passent
(21/21, contre 18/21 auparavant) ; aucune régression sur les suites DNS
voisines (`windows-dns-server-role`, `windows-dns-cache` : 24/24).

## Windows Server — expiration de compte (`Set-ADAccountExpiration`)

L'expiration de compte était totalement absente jusqu'ici. `DirectoryStore`
gagne `setAccountExpiration(sam, epochSecondesOuNull)` (`null` =
`Clear-ADAccountExpiration`, comportement par défaut réel : n'expire
jamais) et `isAccountExpired(sam)`. `AdUser` gagne `accountExpires:
number | null`.

**Périmètre délibérément identique au verrouillage de compte** :
`checkPassword` (bind simple LDAP) refuse désormais l'authentification
une fois `accountExpires` dépassé — le chemin Kerberos AS-REQ/`KdcSession`
n'est PAS touché, pour la même raison que le verrouillage : surface de
modification bien plus large et risquée à toucher pour une tâche
auto-initiée.

**Validation** : nouveau `ad-account-expiration.test.ts` (5 tests) —
n'expire jamais par défaut, refus après une date d'expiration passée,
authentification toujours possible avant une date future,
`Clear-ADAccountExpiration` (passage à `null`) lève la restriction,
échec propre sur une identité inconnue. Suite élargie (4 fichiers,
verrouillage/politique de mot de passe/forêt) : 82/82 au vert, aucune
régression. Typecheck et lint ciblés propres.

## Windows Server — quota de comptes machine (`ms-DS-MachineAccountQuota`)

Jusqu'ici, n'importe quel utilisateur authentifié pouvait joindre un
nombre illimité d'ordinateurs au domaine — aucun quota n'était modélisé.
`DirectoryStore` gagne `getMachineAccountQuota()`/
`setMachineAccountQuota(n)` (par défaut 10, comme AD réel, stocké comme
attribut `ms-DS-MachineAccountQuota` sur la racine du domaine — réplique
comme n'importe quel autre attribut) et `checkMachineAccountQuota
(creatorSam)` : compte les objets `computer` déjà créés par ce même
principal (nouvel attribut `createdBySam`), refuse au-delà du quota,
sauf pour un membre de Domain Admins (toujours exempté, comme AD réel —
vérifié via `groupsForUser`, déjà existant).

**Un seul point de contrôle** : `LdapServerHandler`'s `addRequest`
vérifie le quota avant tout ajout d'un objet de classe `computer` — et
timbre lui-même (côté serveur, jamais fourni par le client) l'attribut
`createdBySam` du principal actuellement lié (`boundPrincipalSam`,
déjà suivi depuis la tâche gMSA). `DirectoryStore.newComputer`/
`promoteDomainController` (création directe/locale, utilisée par un
administrateur ou par le bootstrap de promotion d'un DC) restent
volontairement hors de portée du quota — AD réel ne l'applique lui
aussi qu'au droit `SELF` create-child ordinaire, jamais à une création
administrative explicite.

**Validation** : nouveau `ad-machine-account-quota.test.ts` (2 tests)
— valeur par défaut et configuration, refus une fois le quota d'un
utilisateur ordinaire épuisé (deux jointures réelles réussies, une
troisième refusée) mais un membre de Domain Admins toujours capable de
joindre une machine supplémentaire. Suite élargie (jointure de domaine/
AD/LDAP/Kerberos, 5 fichiers) : 104/105 au vert, seul échec préexistant
hors périmètre (bascule `whoami`) — tous les tests existants
s'authentifient en Administrator (membre de Domain Admins, exempté),
donc risque de régression quasi nul, confirmé. Typecheck et lint
ciblés propres.

## Windows Server — application de la politique de mot de passe sur un changement

Complète la tâche précédente : `minPasswordLength`, `minPasswordAge` et
`passwordHistoryLength` (`GpoAccountPolicy`/PSO) étaient déclarés depuis
la tâche PSO mais jamais réellement vérifiés. `DirectoryStore.setUser`
(le seul point d'entrée `Set-ADAccountPassword`-like de ce simulateur)
gagne un nouveau `rejectPasswordChange` privé, appelé avant tout
changement de mot de passe :

- `minPasswordLength` : refuse un nouveau mot de passe trop court.
- `minPasswordAge` : refuse un second changement avant que le délai
  (en jours, depuis un nouvel attribut `pwdLastSet`) ne soit écoulé —
  sans effet sur le tout premier changement d'un compte (pas de
  `pwdLastSet` antérieur à comparer).
- `passwordHistoryLength` : refuse la réutilisation d'un mot de passe
  encore présent dans les `N` derniers (nouvel attribut multi-valué
  `pwdHistory`, courant + historique tronqué à `N`) — un mot de passe
  sorti de cette fenêtre redevient réutilisable, comme AD réel.

Réutilise tel quel `effectivePasswordPolicyFor` (PSO puis repli sur la
politique par défaut du domaine, déjà branché par la tâche
verrouillage).

**Décision de portée délibérée** : `minPasswordLength` n'est PAS
vérifié à la création (`newUser`) — `git grep` confirme que les tests
de ce dépôt créent systématiquement des comptes avec des mots de passe
courts (`'x'`, `'bobpw'`...) ; l'appliquer à la création aurait cassé
un grand nombre de tests sans rapport pour un gain hors de proportion
avec une tâche auto-initiée. Simplification documentée dans le code,
pas oubliée.

**Validation** : nouveau `ad-password-policy.test.ts` (5 tests) — refus/
acceptation selon la longueur, refus d'un second changement avant
`minPasswordAge`, absence de blocage sur le tout premier changement,
réutilisation refusée puis acceptée une fois sortie de l'historique
(via un PSO désactivant `minPasswordAge` pour isoler le test
d'historique). Suite élargie (AD/GPO/réplication, 7 fichiers) :
104/104 au vert, aucune régression sur `setUser`/`newUser` malgré leur
usage très large dans la suite de tests. Typecheck et lint ciblés
propres.

## Windows Server — verrouillage de compte (politique de mots de passe enfin appliquée)

`DirectoryStore.effectivePasswordPolicyFor` existait depuis la tâche
PSO mais n'était appelée nulle part — code mort. Elle gagne d'abord un
repli sur la politique par défaut du domaine (`accountPolicy` de
Default Domain Policy) quand aucun PSO ne s'applique, puis est
réellement branchée : `checkPassword` — seule porte d'un vrai bind
simple LDAP — suit désormais `badPwdCount`/`lockoutTime` par utilisateur
et verrouille le compte après `lockoutThreshold` échecs consécutifs,
pour `lockoutDurationMinutes` (déverrouillage automatique une fois le
délai écoulé, compteur remis à zéro dès une authentification réussie).
Nouveaux `isAccountLockedOut(sam)` et `unlockAccount(sam)`
(`Unlock-ADAccount`). `AdUser` gagne `lockedOut`.

**Portée délibérément limitée** : seul le bind simple LDAP est couvert.
L'échange Kerberos AS-REQ réel (`KdcSession`/`getUserSecret`) n'est PAS
touché — il ne consulte jamais `checkPassword`, et le brancher sur le
verrouillage aurait un rayon d'impact bien plus large (chaque test
`kerberos-*`/logon de domaine) pour un gain hors de proportion avec une
tâche auto-initiée. Documenté explicitement dans le code plutôt que
laissé implicite.

**Validation** : nouveau `ad-account-lockout.test.ts` (4 tests) —
verrouillage après le seuil par défaut du domaine (5) vérifié sur un
vrai bind LDAP distant depuis une seconde machine, remise à zéro du
compteur sur un succès avant d'atteindre le seuil, déverrouillage
manuel immédiat, priorité d'un PSO à seuil plus strict sur la politique
par défaut. Suite élargie (AD/GPO/LDAP/Kerberos, 7 fichiers) : 103/103
au vert, aucune régression, y compris sur `kerberos-as-exchange.test.ts`
(confirmant l'absence d'impact sur le chemin Kerberos). Typecheck et
lint ciblés propres.

## Windows Server — suppression d'unité d'organisation + protection contre la suppression accidentelle

Aucune voie de suppression d'OU n'existait jusqu'ici dans ce simulateur.
`DirectoryStore.removeOrgUnit(path)` (équivalent `Remove-
ADOrganizationalUnit`) comble ce manque — et reproduit d'emblée le
comportement par défaut réel de `New-ADOrganizationalUnit` : une OU
fraîchement créée est protégée contre la suppression accidentelle
(`protectedFromAccidentalDeletion: true` par défaut, `newOrgUnit`
acceptant `{ protectedFromAccidentalDeletion: false }` pour créer
directement une OU non protégée). `setOuProtectedFromAccidentalDeletion`
permet de lever/reposer la protection après coup.

`DirectoryTree.deleteEntry` porte désormais ce refus (`accessDenied`) à
la source — un seul point de contrôle, atteint aussi bien par un appel
local que par un `delRequest` LDAP distant, sans plomberie séparée
(même schéma que le refus `unwillingToPerform` d'un RODC). Nouveau
mappage dans `treeMessageToResultCode` : `accessDenied` →
`insufficientAccessRights` (50, code déjà existant, aucun nouveau code
LDAP nécessaire). `AdOrgUnit` gagne le champ
`protectedFromAccidentalDeletion`.

**Validation** : nouveau `ad-ou-deletion-protection.test.ts` (6 tests)
— protection par défaut, refus de suppression tant que protégée,
suppression réussie après levée de la protection, création directe non
protégée, refus de suppression d'une OU non-feuille (indépendant de la
protection), refus `insufficientAccessRights` vérifié sur un vrai
`delRequest` LDAP distant. Suite élargie (GPO/AD/réplication, 7
fichiers) : 112/112 au vert, aucune régression. Typecheck et lint
ciblés propres.

## Windows Server — contrôleur de domaine en lecture seule (RODC)

`DirectoryTree` gagne un drapeau `readOnly` (MS-ADTS §3.1.1.1.11) :
`addEntry`/`modifyEntry`/`deleteEntry`/`renameEntry` refusent
systématiquement (`unwillingToPerform`) dès que le drapeau est actif —
qu'ils soient invoqués localement (cmdlets) ou via une requête LDAP
distante (`LdapServerHandler` passe par les mêmes méthodes de l'arbre,
donc le refus s'applique aux deux sans plomberie séparée).
`applyReplicatedEntry` reste volontairement exempté : un RODC continue
d'absorber normalement les cycles de réplication entrants, seule
l'origination de nouvelles écritures est bloquée. Nouveau code résultat
LDAP `unwillingToPerform` (53, RFC 4511 §4.1.9) ajouté à
`LdapMessage.ts` et mappé dans `treeMessageToResultCode`.

**Bootstrap** : la promotion d'un RODC crée quand même son propre compte
ordinateur localement (`DirectoryStore.promoteDomainController`) — seul
appelant à passer `bypassReadOnly: true` à `addEntry`, jamais atteignable
depuis LDAP ou un cmdlet (mirroring le fait que le vrai dcpromo garde
cette étape distincte des écritures LDAP ordinaires).
`WindowsServer.installADDSDomainController` gagne un paramètre
`readOnlyReplica`.

**Password Replication Policy** (nouveau module
`ad/rodc/PasswordReplicationPolicy.ts`, listes autorisée/refusée par sam,
appartenance directe uniquement — même simplification que
`groupsForUser` — un refus explicite l'emporte toujours sur une
autorisation) : `DirectoryStore.applyReplicatedEntry` retire désormais
`userPassword` (attribut ET timbre de réplication associé) de tout
utilisateur/ordinateur reçu par réplication qui n'est pas couvert par la
politique du RODC — celui-ci n'a donc jamais le vrai secret d'un
principal non autorisé, aucune plomberie fil supplémentaire requise
(le filtrage est une décision locale du RODC receveur, pas un nouveau
PDU).

**Validation** : nouveau `ad-rodc.test.ts` (6 tests) — drapeau lecture
seule correct des deux côtés après promotion, compte ordinateur du RODC
bien créé malgré le lecture seule, refus d'une écriture locale
(`New-ADUser`), refus d'une écriture LDAP distante réelle
(`unwillingToPerform` vérifié sur le code de résultat), mise en cache
du mot de passe d'un utilisateur couvert vs non couvert sur un cycle de
réplication ultérieur, refus explicite qui l'emporte sur une
autorisation pour le même principal. Suite élargie (AD/GPO/LDAP/
réplication, 9 fichiers) : 151/152 au vert, seul échec préexistant hors
périmètre (bascule `whoami`). Typecheck et lint ciblés propres.

## Windows Server — comptes de service (gérés / gérés par groupe), `msDS-ManagedPassword` gardé sur LDAP réel

Nouveau module `ad/msa/ManagedServiceAccountStore.ts` : comptes de
service gérés (MSA) et gérés par groupe (gMSA, MS-ADTS §3.1.1.8) — mot
de passe généré et pivoté par le DC, jamais choisi par un admin.
`DirectoryStore` gagne `newServiceAccount`/`getServiceAccount`/
`listServiceAccounts`/`resetManagedPassword` (pivot manuel, même
convention que réplication/SDProp/UGMC : AD réel le fait automatiquement
tous les `msDS-ManagedPasswordInterval`, ici sur demande)/
`setPrincipalsAllowedToRetrieveManagedPassword`. `AdServiceAccount`
ajouté à `AdTypes.ts`.

**Lecture gardée sur LDAP réel** (`msDS-ManagedPassword`, §3.1.1.8.1) —
la seule voie légitime par laquelle un ordinateur distant lit le mot de
passe courant : `LdapServerHandler` retire désormais systématiquement
cette valeur des résultats de recherche et ne la réintroduit que si le
principal actuellement lié (`resolvePrincipal` sur `LdapBindCheck`,
suivi sur bind simple *et* SASL/GSSAPI — `boundPrincipalSam`) figure,
directement ou via l'appartenance directe à un groupe, dans
`PrincipalsAllowedToRetrieveManagedPassword` de ce compte. Ciblé sur ce
seul attribut construit (comme AD réel), pas un moteur générique d'ACL
par attribut de schéma (hors périmètre, §2.2).

**Bug détecté par le test dédié et corrigé** : `retrieveManagedPassword`
attend un sam nu (même convention que le reste de `DirectoryStore`),
mais `gateManagedPassword` lui passait directement le
`sAMAccountName` stocké de l'entrée — déjà suffixé `$` — provoquant un
double suffixe (`svc1$$`) et un échec de résolution systématique. Corrigé
en retirant le `$` final avant l'appel.

**Validation** : nouveau `ad-managed-service-account.test.ts` (7 tests)
— création gMSA avec objectSid réel, refus de doublon, pivot de mot de
passe, réplication vers un second DC comme n'importe quel autre objet,
lecture autorisée via appartenance directe à un groupe (Administrator
dans Domain Admins) sur une vraie recherche LDAP, refus pour un
principal non listé, refus pour un bind anonyme. `ldap-server-client.test.ts`/
`ldap-wire-p11.test.ts` mis à jour (leur mock `LdapBindCheck` gagne
`resolvePrincipal`). Suite élargie (LDAP/AD/GPO, 8 fichiers) : 143/144
au vert, seul échec préexistant hors périmètre (bascule `whoami`).
Typecheck et lint ciblés propres (les 2 erreurs/2 avertissements
préexistants de `WindowsPC.ts`, confirmés par `git stash`, ne sont pas
de ce travail).

## Windows Server — réplication AD par métadonnées d'attribut (fin de l'écrasement silencieux multi-DC)

Jusqu'ici, `EntryReplMeta` (`ldap/DirectoryTree.ts`) portait un seul
timbre de réplication (USN/horodatage) pour l'objet entier. Conséquence :
si deux DC modifiaient chacun un attribut *différent* du même objet sans
avoir répliqué entre eux depuis, le cycle de réplication suivant faisait
gagner l'objet entier au timbre le plus récent — écrasant silencieusement
le changement de l'autre DC, même sur un attribut totalement sans
rapport. Corrigé en passant à un timbre par attribut, à l'image de
`msDS-ReplAttributeMetadata` d'AD réel :

- `EntryReplMeta` devient `Map<nom d'attribut en minuscules,
  AttributeReplStamp>` au lieu d'un timbre unique ; `AttributeReplStamp`
  gagne un champ `version` (entier local à l'attribut, incrémenté à
  chaque écriture — locale ou adoptée par réplication).
- `DirectoryTree.modifyEntry`/`addEntry`/`renameEntry` ne (re)timbrent
  plus que les clés d'attribut réellement touchées par l'opération (pas
  l'objet entier).
- `changedSince(vector)` inclut un objet dès qu'AU MOINS un de ses
  attributs a un timbre plus récent que ce que le vecteur du demandeur
  reflète déjà — inchangé en surface, mais désormais basé sur le
  maximum par-attribut plutôt qu'un timbre global.
- `applyReplicatedEntry` fusionne désormais attribut par attribut : pour
  chaque clé du timbre entrant, seul l'attribut correspondant est
  écrasé si son timbre entrant l'emporte (comparaison par `version`
  d'abord, `timestamp` puis `originatingInvocationId` en dernier
  recours) — les attributs non touchés par l'écriture distante restent
  intacts localement, quel que soit l'état du reste de l'objet.
- **Bug découvert et corrigé pendant l'écriture du test de non-
  régression** : comparer uniquement par `timestamp` (résolution à la
  seconde, `Math.floor(Date.now()/1000)`) échouait dès que deux écritures
  sur des DC différents tombaient dans la même seconde — quasi toujours
  le cas dans ce simulateur (aucune latence réseau réelle). D'où le
  passage à `version` (compteur entier monotone par attribut,
  propagé et poursuivi par le DC qui l'adopte) comme clé de comparaison
  principale ; `timestamp` ne sert plus que de dernier recours en cas
  d'égalité de version.
- `DirectoryStore.applyReplicatedEntry` avance le vecteur haute-marque
  entrant pour CHAQUE timbre reçu (pas un seul), puisqu'un objet peut
  désormais porter des attributs originaires de DC différents.
- Wire format : `EntryReplMetaWire` (encode/decode d'une `Map`, même
  convention que `HighWatermarkVectorWire`) ajouté à `ReplicationSession.ts`.

**Validation** : nouveau test dans `ad-replication.test.ts` — deux DC
modifient chacun un attribut différent du même utilisateur sans se
synchroniser entre-temps, puis répliquent dans les deux sens ; les deux
changements survivent des deux côtés (ce test échouait de façon
reproductible avant la correction du bug `version`, confirmant qu'il
capture bien le défaut réel). Suite ciblée réplication/AD/GPO/LDAP/
Kerberos (14 fichiers) : 180/181 au vert (seul échec, préexistant et
hors périmètre : bascule `whoami`). Suite complète `network-v2/` (827
fichiers) passée en filet de sécurité supplémentaire vu le risque élevé
de cette tâche : aucune régression sur un fichier AD/GPO/LDAP/Kerberos ;
les échecs observés ailleurs (SSH, historique bash, TLS, netstat...)
sont sans rapport avec la réplication AD. Typecheck et lint ciblés
propres.

## Convergence de branche : Windows Server (UGMC) + Windows Phase 23/24 (`klist`/`nltest`/`dcdiag`/`netdom`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le cœur Windows Server (contrôleur de domaine),
l'autre sur le pont Windows `command-kernel`, sans recouvrement de
fichiers en dehors de `CHANGELOG.md` (léger recouvrement d'imports dans
`WindowsServer.ts`, résolu en conservant les deux côtés).

### Windows Server — Universal Group Membership Caching (UGMC)

Nouveau module `ad/gc/UgmcCache.ts` (35 lignes) : état purement local
d'un DC non-GC (`enabled`, `lastRefresh`, `Map<sam utilisateur, sams de
groupes universels>`), jamais répliqué — seul le rafraîchissement a
besoin du réseau. `getCachedUniversalGroupsFor(sam)` retourne `null`
tant que l'UGMC n'est pas activée (l'appelant doit alors interroger un
GC directement), sinon la liste en cache (vide si jamais rafraîchie).

Nouveau `domain/UgmcRefreshClient.ts` (51 lignes) : rafraîchissement
réel par le réseau — dial LDAP réel (TCP/389) vers un Global Catalog,
bind, recherche de tous les groupes sous la racine du domaine
(`objectClass=group`, attributs `groupType`/`member`), filtrage
côté client sur le bit `GROUP_TYPE_UNIVERSAL_GROUP` (`-2147483640`),
puis inversion des DN `member` de chaque groupe universel en table
`sam utilisateur → sams de groupes` (même simplification `leafValue(dn)`
déjà établie ailleurs, ex. `DomainLogonClient.leafCn`).

`WindowsServer` gagne `isUgmcEnabled()` / `enableUgmc()` (refuse sur un
Global Catalog — déjà toute la donnée localement, comme le recommande
AD réel) / `disableUgmc()` / `refreshUgmc(gcAddress, credentialUser,
credentialPassword)` / `getCachedUniversalGroupsFor(sam)`. Rafraîchi
manuellement (AD réel : toutes les 8 heures ; même convention que la
réplication/SDProp — déclenchement manuel documenté, pas de
scheduler réel modélisé).

**Extraction de fichier** (discipline "pas de fichier de plus de ~400
lignes" — `WindowsServer.ts` avait grossi à 662 lignes au fil des
tâches FSMO/RID/SDProp/UGMC) : les opérations de niveau contrôleur de
domaine sans sous-système AD dédié (FSMO, SDProp, UGMC) sont extraites
dans un nouveau `ad/DomainControllerOps.ts` (121 lignes), construit
avec une petite interface `DcOpsHost` (déjà satisfaite structurellement
par `WindowsServer`) — `WindowsServer.ts` ne fait plus que déléguer,
revenu à 615 lignes ; les futures fonctionnalités de niveau DC
s'ajoutent désormais à ce nouveau module plutôt qu'à `WindowsServer.ts`.

**Validation** : quatre nouveaux tests dans `ad-forest.test.ts`
(parcours complet activation → rafraîchissement réel depuis un GC →
lecture du cache ; refus d'activation sur un GC ; refus de
rafraîchissement avant activation ; échec propre si le GC est
injoignable) — 21 tests au total dans ce fichier, tout au vert.
Typecheck et lint ciblés propres sur les quatre fichiers touchés.

### Windows Phase 23 : migration de `klist` / `nltest` / `dcdiag` vers command-kernel

Migration du bloc de diagnostics domaine (`klist`, `nltest /dsgetdc:`,
`dcdiag`) depuis les formateurs hérités `WinDomainDiag.ts` — jusqu'ici
non dispatchés (`'…' n'est pas reconnu…`) — vers le socle `command-kernel`.

- Capacité `DomainApi` étendue de trois primitives d'état typé :
  `locateDomainController(domain)` (`nltest`, vraie sonde réseau TCP/389),
  `dcDiagnostics()` (`dcdiag`, état des services AD + partage SYSVOL) et
  `kerberosTickets()` (`klist`, instantané du cache de tickets alimenté par
  un vrai échange AS/TGS). Types `DomainControllerLocation` /
  `DomainControllerDiagnostics` / `KerberosCachedTicket` au contrat.
- `WindowsPC` porte les primitives (base : `isDc: false`, jamais un DC) ;
  `WindowsServer` surcharge `dcDiagnostics()` pour reporter l'état réel du
  contrôleur de domaine une fois promu.
- Commandes `KlistCommand` / `NltestCommand` / `DcdiagCommand` : parsing,
  gate `/?`, aide réelle complète en `usage`, formatage console (mise en
  page `#n>` de `klist`, sections de `dcdiag`) porté côté commande.
- Frontière client/serveur respectée : sur un poste non joint / non promu,
  `nltest` renvoie `ERROR_NO_SUCH_DOMAIN`, `dcdiag` « can only be run on a
  domain controller », `klist` un cache vide — aucune fonctionnalité
  serveur exposée. Fichier mort `WinDomainDiag.ts` supprimé (migrate-then-delete).

Validation : les 7 tests `klist`/`nltest`/`dcdiag` de
`windows-server-domain-join.test.ts` passent (24 → 21 en échec avant/après :
les 3 restants — `netdom` ×2, bascule `whoami` — sont antérieurs, commandes
non encore migrées) ; aucune régression sur les suites Windows voisines.

### Windows Phase 24 : migration de `netdom` (join / trust) vers command-kernel

Migration de `netdom` (`netdom join`, `netdom trust`) — équivalent cmd de
`Add-Computer -DomainName` / `New-ADTrust`, jusqu'ici non dispatché — vers
le socle `command-kernel`.

- Capacité `DomainApi` étendue de trois primitives : `joinDomain(...)`
  (jointure, vraie négociation LDAP), `resolveDcAddress(domain)` (résolution
  DNS synchrone du DC quand `/Server:` est absent) et `establishTrust(...)`
  (approbation inter-domaines, `null` si la machine n'est pas un DC). Type
  `DomainTrustDirection` au contrat.
- `WindowsPC` porte join/resolve (via `joinDomainNow`/`resolveHostnameSync`)
  et une base `establishDomainTrust()` renvoyant `null` (jamais un DC) ;
  `WindowsServer` surcharge cette dernière via `newADTrust` (LDAP réel).
- Commande `NetdomCommand` : dispatch `join`/`trust`, parsing des paramètres
  `/Clé:Valeur`, aide réelle complète en `usage`, formatage console (succès
  / « failed to complete successfully ») porté côté commande.
- Frontière client/serveur respectée : `netdom trust` échoue proprement
  (« not a domain controller ») sur un poste — aucune fonctionnalité serveur
  exposée. Méthodes mortes `cmdNetdom`/`cmdNetdomTrust` supprimées de
  `WindowsPC` (migrate-then-delete) ; `newADTrust` conservée (encore
  utilisée par le fournisseur PowerShell `New-ADTrust`).

Validation : les 2 tests `netdom` de `windows-server-domain-join.test.ts`
passent (24 → 1 en échec : le dernier — bascule `whoami` après logon
domaine — est antérieur et relève d'un autre chantier) ; aucune régression
(dont `ad-trust-crossrealm.test.ts` 6/6).

## Convergence de branche : Windows Server (AdminSDHolder/SDProp) + Windows Phase 22 (`gpupdate`/`gpresult`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le cœur Windows Server (contrôleur de domaine),
l'autre sur le pont Windows `command-kernel`, sans recouvrement de
fichiers en dehors de `CHANGELOG.md`.

### Windows Server — AdminSDHolder / SDProp (protection des groupes protégés)

Nouveau module `ad/security/SdProp.ts` (63 lignes) : une passe SDProp
marque `adminCount=1` sur tout membre — direct ou via imbrication de
groupes, résolution cycle-safe — d'un groupe protégé (`Domain Admins`,
le seul réellement semé par défaut ; la liste `PROTECTED_GROUPS` est
conçue pour en accueillir d'autres trivialement). Reproduit la
bizarrerie bien connue d'AD réel : `adminCount` n'est JAMAIS effacé
automatiquement, même après le retrait du groupe — vérifié par un
test dédié. Comme ce simulateur ne modélise pas encore de DACL/
descripteur de sécurité réel, le "re-tamponnage d'ACL" se limite à ce
bookkeeping `adminCount`, déjà l'observable concret qu'un admin réel
consulte (`Get-ADUser -Filter {adminCount -eq 1}`).

`WindowsServer.runSdProp()` — déclenché manuellement (même convention
que la réplication/FSMO : AD réel l'exécute automatiquement toutes les
60 minutes sur le PDC Emulator ; ici sur demande), refuse si l'appelant
ne détient pas le rôle PDC Emulator ou n'est pas DC. Aucun PDU
inter-appareils requis : SDProp tourne localement sur la copie du DC,
et `adminCount` se réplique comme n'importe quel autre attribut via le
mécanisme existant.

`AdUser`/`AdGroup` gagnent un champ `adminCount: boolean`.

**Validation** : neuf nouveaux tests (`ad-directory-store.test.ts` :
marquage direct/imbriqué, absence hors groupe protégé, bizarrerie de
non-effacement, idempotence ; `ad-forest.test.ts` : exécution sur le
PDC Emulator par défaut, refus sur un DC additionnel/un serveur non-DC)
— 69 tests au total sur ces deux fichiers, tout au vert. Typecheck et
lint ciblés propres.

### Windows Phase 22 : migration de `gpupdate` / `gpresult` vers command-kernel

Migration des deux commandes client de stratégie de groupe (`gpupdate`,
`gpresult`) depuis le dispatcher hérité vers le socle `command-kernel`,
dans la continuité des phases précédentes (netsh, wevtutil).

- Nouvelle capacité optionnelle `domain?: DomainApi` sur `MachineApi`
  (`gpupdateForce()` : mutation réelle — pull LDAP + application des
  overrides de politique ; `groupPolicyResult()` : instantané RSoP typé,
  `null` hors domaine). Types `WindowsGpResult` / `WindowsGpLogonBanner`
  ajoutés au contrat `machine/types.ts`.
- `WindowsDomainApiImpl` dans `WindowsMachineApi.ts` délègue aux primitives
  device `WindowsPC.gpupdateForce()` / nouvelle `WindowsPC.groupPolicyResult()`
  (l'état reste sur l'équipement ; le formatage passe côté commandes).
- Commandes `GpupdateCommand` / `GpresultCommand` : parsing des options,
  gate `/?`, formatage console (dont la mise en page RSoP section par
  section de `gpresult /r`), aide complète réelle en `usage`.
- Respect strict de la frontière client/serveur : hors domaine, les deux
  commandes échouent proprement (« not joined to a domain » /
  « not a member of a domain ») — aucune fonctionnalité serveur exposée
  sur un poste non joint.

Validation : `windows-server-gpo.test.ts` passe intégralement (7/7,
contre 3/7 auparavant) ; aucune régression sur les suites Windows
voisines (les 2 échecs `runas` de `windows-access-cmd.test.ts` sont
antérieurs — commande non encore migrée).

## Convergence de branche : Windows Server (pool RID + objectSid) + Windows Phase 21 (`wevtutil`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le cœur Windows Server (contrôleur de domaine),
l'autre sur le pont Windows `wevtutil`, sans recouvrement de fichiers
en dehors de `CHANGELOG.md`.

### Windows Server — pool de RID + objectSid réel sur les objets AD

Suite directe du chantier FSMO : un SID de domaine réel
(`S-1-5-21-<r1>-<r2>-<r3>`) est maintenant généré à la création d'un
domaine (premier DC, `!skipSeed`) et stocké comme attribut
`domainSid` sur l'entrée racine — donc répliqué vers les autres DC
via le mécanisme existant, exactement comme les rôles FSMO. Les
principaux par défaut reçoivent les RID bien connus réels d'AD
(Administrator=500, krbtgt=502, Domain Admins=512, Domain Users=513,
Domain Computers=515) ; tout nouvel objet (`newUser`/`newGroup`/
`newComputer`/le compte ordinateur du DC lui-même) reçoit un
`objectSid` alloué depuis un pool RID local par DC (nouveau
`ad/fsmo/RidPool.ts`, 27 lignes).

Le premier DC d'un domaine (RID Master par défaut) se réserve
lui-même un grand pool local (1000-100000) et peut accorder des blocs
à d'autres DC au-delà de cette plage (`grantRidPoolBlock`). Un DC
additionnel (`Install-ADDSDomainController`) démarre avec un pool
vide et demande un bloc initial de 500 RID au RID Master via un vrai
échange réseau (nouveau `windows/domain/RidPoolClient.ts`) — réutilise
le même point de terminaison JSON-sur-TCP/135 que la réplication
(`ReplicationServerHandler` gagne un second type de message,
`ridPoolRequest`/`ridPoolResponse` — le vrai MS-DRSR alloue aussi les
RID sur la même interface RPC, pas un protocole séparé) plutôt que
d'inventer un second protocole. Le serveur refuse si le DC contacté
ne détient pas actuellement le rôle RID Master.

Limite de portée assumée et documentée : un ordinateur créé via un
vrai `AddRequest` LDAP (jonction de domaine) ne passe pas par
`DirectoryStore.newComputer` et ne reçoit donc pas encore de SID —
seuls les objets créés localement (cmdlets AD, promotion DC) en ont
un pour l'instant.

**Validation** : onze nouveaux tests (`ad-directory-store.test.ts` :
SID de domaine + RID bien connus, allocation séquentielle, blocs
`grantRidPoolBlock` non chevauchants ; `ad-forest.test.ts` : requête
réelle de pool RID entre deux DC, SID de domaine identique des deux
côtés, RID non chevauchants) + suite complète AD/forêt/GPO/schéma,
tout au vert. Typecheck et lint ciblés propres.

### Windows — Phase 21 : migration `wevtutil`

Après la clôture de `netsh`, migration de `wevtutil` (utilitaire de
journal d'évènements Windows : `qe`/`query-events`, `el`/`enum-logs`,
`cl`/`clear-log`) — commande fréquemment enchaînée après un scénario
pare-feu/DHCP pour vérifier les évènements produits, bloquant plusieurs
tests inter-commandes.

Nouvelle capacité `MachineApi.eventLog?: EventLogApi` (concept sans
équivalent universel — Linux a syslog/journald) : `entries(logName)`
(journaux structurés `System`/`Security`/... via `PSEventLogProvider`,
déjà partagé avec `Get-EventLog`/`Get-WinEvent`), plus l'accès dédié au
journal DHCP-Client (`dhcpEventLog()` qui synchronise, `ensureDhcpInitEvent()`).
Type `WindowsEventLogEntry` ajouté.

`WevtutilCommand` porte le parsing des sous-commandes, la porte de service
`EventLog` (message « Failed to query events. The Windows Event Log
service is not running. ») et le formatage `Event[i]` — copié depuis
`WinWevtutil.ts`, intact pour le shim PowerShell.

Validation : typecheck et ESLint propres. Lot eventlog/feature-gates/
firewall-vs-acl/dhcp-dns/ssh-audit comparé au commit pré-Phase-21 via
`git stash` : 3 échecs/47 réussites avant → 50/50 après, 3 tests
corrigés, zéro régression. Suites arp/consistency (107 tests) sans
régression.

## Windows — Phase 20 : migration `netsh` — contextes `dhcp server`, `nps` (clôt `netsh`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Dernière tranche de `netsh` : les deux contextes de rôle serveur
(`dhcp server add/show/scope`, `nps add/show client`). Contrairement à
tous les magasins précédents, ces contextes sont adossés aux objets de
rôle `WindowsServer` (`WindowsDhcpServerRole`/`WindowsNpsRole`) — le rôle
DHCP distribue de VRAIS baux via son moteur, pas un simple registre.

**Garde-fou poste client respecté** : `getDhcpServerRole()`/`getNpsRole()`
renvoient `null` sur un `WindowsPC` ordinaire (seul `WindowsServer` les
surcharge quand la fonctionnalité est installée). Les nouvelles capacités
`WindowsNetConfigApi.dhcpServer`/`nps` sont donc des **getters LIVE**
`… | null` (ré-évalués à chaque accès, car la fonctionnalité peut être
installée APRÈS la construction du shell mémoïsé). `NetshCommand` renvoie
« The DHCP Server service is not available on this computer. » /
« The Network Policy Server service is not available on this computer. »
quand le rôle est absent — vérifié par un test dédié qu'un `windows-pc`
refuse bien `netsh dhcp server`/`nps`.

Types `WindowsDhcpScope`/`WindowsDhcpServerApi`/`WindowsNasClient`/
`WindowsNpsApi`/`WindowsServerOpResult` ajoutés. Le calcul d'adressage de
l'étendue (réseau/broadcast/plage début-fin depuis `ScopeAddress`+masque)
vit dans `NetshCommand` (types de domaine `IPAddress`/`SubnetMask`), les
opérations vendeur (`addScope`/`addExclusionRange`/`addReservation`/
`addNasClient`) restent sur le rôle. `WinNetsh.ts` intact pour le shim.

**`netsh` est désormais intégralement migré** : interface (Ph.15),
dhcpclient/dnsclient (Ph.16), ipsec (Ph.17), lan/wlan/http/bridge/
namespace (Ph.18), advfirewall (Ph.19), dhcp server/nps (Ph.20). Seul le
`cmdNetsh` legacy subsiste pour le shim PowerShell natif, jamais appelé
depuis le command-kernel.

Validation : typecheck et ESLint propres. `windows-server-dhcp`/
`windows-server-nps` comparés au commit pré-Phase-20 via `git stash` : 3
échecs/18 réussites avant → 21/21 après, 3 tests corrigés, zéro
régression. Test jetable confirmant le refus sur poste client (2/2).
Suites cmd-netsh/netsh/consistency (259 tests) sans régression (4 échecs
IPsec ordre-dépendants pré-existants, déjà documentés).

## Convergence de branche : Windows Server (rôles FSMO) + Windows Phase 19 (`netsh advfirewall`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le cœur Windows Server (contrôleur de domaine),
l'autre sur le pont Windows `netsh`, sans recouvrement de fichiers en
dehors de `CHANGELOG.md`.

### Windows Server — modélise les rôles FSMO

Nouveau chantier (contrôleur de domaine), au-delà des deux lots de
suivi de l'audit initial : jusqu'ici aucun concept de rôle FSMO
n'existait (Schema Master, Domain Naming Master, RID Master, PDC
Emulator, Infrastructure Master) — un vrai trou par rapport à AD réel,
non documenté comme hors-périmètre par les PRD.

Les trois rôles de portée domaine (RID Master, PDC Emulator,
Infrastructure Master) sont modélisés comme de simples attributs sur
l'entrée racine du domaine (nouveau `ad/fsmo/FsmoRoles.ts`, 48 lignes,
même schéma "sous-registre composé par référence" que `GpoStore`/
`PsoStore`) — ce qui les fait répliquer vers les autres DC du même
domaine via le mécanisme de réplication déjà existant, sans plomberie
supplémentaire : un DC ajouté via `Install-ADDSDomainController` les
récupère dans sa synchro initiale comme n'importe quel autre attribut
de la racine du domaine. Les deux rôles de portée forêt (Schema
Master, Domain Naming Master) vivent sur `Forest` (partagé par
référence entre domaines d'une même forêt — même simplification déjà
en place pour le `SchemaValidator` partagé).

Premier DC d'une forêt/d'un domaine enfant : détient tous les rôles
pertinents à sa portée (comportement par défaut réel de DCPromo). DC
additionnel (`Install-ADDSDomainController`) : n'en détient aucun par
défaut, les hérite via la réplication initiale.

`WindowsServer.getFsmoRoleOwner`/`seizeFsmoRole` (déclaratif local,
`-Force`) plus `transferFsmoRoleTo` (transfert "gracieux", rôles de
portée domaine uniquement) — ce dernier extrait dans un nouveau client
dédié `windows/domain/FsmoTransferClient.ts` sur le même modèle que
`DomainJoinClient`/`GpoPullClient` : dialogue réel avec le détenteur
actuel via TCP/389, un vrai `ModifyRequest` LDAP enregistrant le
nouveau propriétaire — pas de raccourci inter-appareils.

**Validation** : six nouveaux tests dans `ad-forest.test.ts`
(attribution par défaut forêt-racine/domaine-enfant, `null` hors DC/
forêt, seize local visible immédiatement des deux côtés pour un rôle
de forêt partagé, transfert réel réussi et échec propre si le
détenteur est injoignable) + suite complète AD/forêt/schéma (5
fichiers), tout au vert. Typecheck et lint ciblés propres.

### Windows — Phase 19 : migration `netsh` — contexte `advfirewall`

Cinquième tranche de `netsh` (voir Phases 15-18). Le contexte
`advfirewall` (`firewall add/delete/show rule`, `reset`) diffère des
magasins précédents : ses règles ne sont PAS un bookkeeping netsh-privé
mais l'état de pare-feu RÉEL, partagé avec le plan de données
(`WindowsPC.firewallFilter()` qui filtre effectivement les paquets) et les
cmdlets PowerShell (`Get/New-NetFirewallRule`). Une règle `add rule
action=block localport=22` fait donc réellement tomber les connexions.

Nouvelle capacité `WindowsNetConfigApi.firewall: WindowsFirewallApi`
(`rules`/`hasRule`/`addRule`/`deleteRules`/`clearRules`) opérant PAR
RÉFÉRENCE sur la même `Map` `WindowsPC.dynamicFirewallRules` que le plan
de données et PowerShell — aucune copie, l'état reste unique. Type
`WindowsFirewallRule` ajouté. La porte de service `mpssvc` (Pare-feu
Windows) est vérifiée dans `NetshCommand` avant dispatch, reproduisant le
message exact « The Windows Firewall service is not running. (mpssvc) ».

`NetshCommand` porte le parsing `name=value`, la normalisation
direction/action/protocole et le formatage `show rule` — copié depuis
`WinNetsh.ts`, intact pour le shim PowerShell.

Validation : typecheck et ESLint propres. Lot cmd-netsh/feature-gates/
firewall-vs-acl comparé au commit pré-Phase-19 via `git stash` : 14
échecs/189 réussites avant → 6/197 après, 8 tests corrigés, zéro
régression. Suites netsh/consistency/arp (140 tests) re-vérifiées sans
régression.

Les 6 échecs restants ne concernent PAS `advfirewall` (les deux tests de
règle de blocage passent) : 4 tests IPsec ordre-dépendants (anti-patron
d'état global déjà documenté Phase 18) + 2 tests dépendant de `wevtutil`
(commande non encore migrée, séparée du plan `netsh`).

Contextes `netsh` encore différés : `dhcp server`, `nps` (adossés aux
objets de rôle `WindowsServer`, absents sur un poste client).

## Windows — Phase 18 : migration `netsh` — contextes `lan`, `wlan`, `http`, `bridge`, `namespace`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Quatrième tranche de `netsh` (voir Phases 15-17). Ferme tous les
sous-contextes « magasin de configuration en mémoire » restants : profils
filaires (`lan`, 47 réf. de test), profils sans-fil (`wlan`), HTTP.sys
(`http`), ponts réseau (`bridge`), politiques NRPT (`namespace`).

Comme pour l'IPsec en Phase 17, ces magasins étaient stockés en état
module-level / `WeakMap` par le legacy — pour NRPT (`nrptPolicies`) c'était
un tableau global partagé par tous les `WindowsPC` (bug d'isolation). La
migration les déplace en état **par-instance** sur `WindowsPC`
(`netshFeatureState`), exposé via cinq nouvelles capacités typées
`WindowsNetConfigApi.lan`/`wlan`/`http`/`bridge`/`nrpt` — CRUD granulaire
(`WindowsLanStore`/`WindowsWlanStore`/`WindowsHttpStore`/
`WindowsBridgeStore`/`WindowsNrptStore`). `NetshCommand` porte tout le
parsing, le dispatch et le formatage, copié depuis `WinNetsh.ts` (intact
pour le shim PowerShell).

Validation : typecheck et ESLint propres. `cmd-netsh.test.ts` comparé au
commit pré-Phase-18 via `git stash` : 44 échecs/142 réussites avant →
9/177 après, 35 tests corrigés, zéro régression (échecs strictement en
baisse, réussites strictement +35). Suites netsh/consistency/arp/ipconfig
(149 tests) re-vérifiées sans régression.

Les 9 échecs `cmd-netsh` restants : 4 tests IPsec ordre-dépendants
(ils font `show` sur un `WindowsPC` neuf en attendant des données ajoutées
par un test PRÉCÉDENT sur une AUTRE instance — anti-patron reposant sur
l'ancienne fuite d'état global, que l'isolation par-instance corrige à
juste titre ; ils échouaient déjà avant toute migration `netsh`), plus
`advfirewall`/`dhcp server`/`nps` — contextes encore différés (plan
d'action réseau/rôle serveur distinct).

## Windows Server — support des PSO (stratégie de mot de passe granulaire)

Second et dernier chantier de suivi identifié à l'audit initial. Nouveau
module `ad/pso/PsoStore.ts` (96 lignes, composé par référence dans
`DirectoryStore` comme `GpoStore`/`SiteRegistry`/`TrustRegistry`) :
objets `msDS-PasswordSettings` réels sous `CN=Password Settings
Container,CN=System,<racine du domaine>`, réutilisant la forme de
`GpoAccountPolicy` plutôt qu'un type parallèle. `newPso`/`getPso`/
`listPsos`/`setPsoAppliesTo` sur `DirectoryStore`, plus
`effectivePasswordPolicyFor(userSam)` qui résout le PSO gagnant
(directement lié ou via appartenance à un groupe visé) — la précédence
la plus basse gagne intégralement, jamais fusionnée entre PSO, fidèle
au comportement réel d'AD. `null` si aucun PSO ne s'applique,
l'appelant retombant alors sur la politique de compte par défaut du
domaine (déjà exposée par `resultantSetOfPolicy`).

**Validation** : six nouveaux tests dans `ad-directory-store.test.ts`
(création/doublon, application directe et via groupe, absence de PSO,
précédence la plus basse gagnante entre plusieurs PSO applicables) —
42 tests, tous au vert. Typecheck et lint ciblés propres.

## Windows Server — élargit la couverture des types de réglages GPO

Premier des deux chantiers de suivi identifiés lors de l'audit initial
(priorité plus basse que les six premiers). `GpoSettings` couvrait
seulement `accountPolicy`/`logonBanner`/`startupScript` ; ajoute
`auditPolicy` (7 catégories `secpol.msc`, `None`/`Success`/`Failure`/
`SuccessAndFailure`) et `userRightsAssignment` (sous-ensemble
représentatif : logon local, service, réseau, RDP + leurs variantes
"deny"), toutes deux fusionnées en RSoP avec la même sémantique
"dernier lien gagne" que `accountPolicy`. Ajoute aussi le filtrage de
sécurité (`Gpo.securityFiltering`, `Set-GPPermission`-lite via
`setGpoSecurityFiltering`) : une GPO dont la liste est vide s'applique
à tous (défaut réel d'AD, "Authenticated Users"), sinon seulement aux
ordinateurs membres (directement ou via un groupe) d'un des principaux
listés.

À l'occasion de cet ajout, extrait tout le sous-système GPO
(`newGpo`/`getGpo`/`listGpos`/`setGpoSettings`/`newGPLink`/
`resultantSetOfPolicy` — ~110 lignes) de `DirectoryStore.ts` (déjà
plus de 600 lignes) vers un nouveau `gpo/GpoStore.ts` (167 lignes),
composé par référence exactement comme `SiteRegistry`/`TrustRegistry`/
`SchemaPartition` le sont déjà — `DirectoryStore.ts` ne fait plus que
déléguer. `DirectoryStore.ts` retombe à 564 lignes.

**Validation** : trois nouveaux tests dans `windows-gpo-core.test.ts`
(audit policy + user rights en RSoP, application par défaut sans
filtrage, filtrage de sécurité qui exclut/inclut selon l'appartenance
de groupe) + suite complète GPO/AD/DC-promotion (5 fichiers), tout au
vert hors les 4 échecs `gpupdate`/`gpresult` pré-existants et sans
rapport. Typecheck et lint ciblés propres.

## Windows Server — OU imbriquées + parcours complet de la chaîne GPO ancêtres

Dernier des six chantiers "cœur Windows Server" identifiés à l'audit
initial. `DirectoryStore.ouDn`/`newOrgUnit`/`getOrgUnit` acceptent
maintenant un chemin `"Parent/Enfant"` (rétro-compatible : un simple
nom sans `/` se comporte exactement comme avant) — la création échoue
proprement si le parent n'existe pas encore (`DirectoryTree.addEntry`
le vérifiait déjà). `newComputer` accepte un `ouPath` optionnel pour
placer un compte ordinateur dans une OU imbriquée.

`resultantSetOfPolicy` et `GpoPullClient.applyLinksFrom` (client LDAP)
ne s'arrêtaient qu'au parent immédiat de l'ordinateur — ils parcourent
désormais toute la chaîne d'OU ancêtres, de la plus proche du domaine
à la plus spécifique, en appliquant chaque niveau dans cet ordre (le
comportement à plat existant reste un cas particulier de chaîne à un
seul niveau, donc aucune régression sur le placement plat actuel de
`Add-Computer`/DC promotion).

**Validation** : trois nouveaux tests dans `windows-gpo-core.test.ts`
(OU imbriquée + RSoP multi-niveaux côté `DirectoryStore`, refus sur
parent inexistant, et le même parcours de bout en bout par-dessus le
vrai LDAP/Kerberos de `GpoPullClient` après déplacement d'un ordinateur
joint via `renameEntry`) + suite complète GPO/AD/DC-promotion, tout au
vert. Typecheck et lint ciblés propres.

## Windows Server — migre GpoPullClient (gpupdate) vers le vrai Kerberos (clôt P24)

Dernier consommateur LDAP encore en bind simple plaintext
(`ldap.bind(computerSam, machineSecret)`) — `DomainJoinClient` et
`DomainLogonClient` étaient déjà passés au vrai AS/TGS/AP-REQ/
`bindSasl('GSSAPI', ...)` dans un lot antérieur. `GpoPullClient.
pullGroupPolicy` fait maintenant la même séquence, authentifié comme le
compte ordinateur lui-même (`hostname$` + `machineSecret`, déjà supporté
côté KDC — `KdcSessionHandler` route un sAMAccountName finissant par
`$` vers `getComputerSecret`) ; le reste de la logique (lecture des
`gPLink` racine + OU, résolution des GPO) est inchangé.

**Validation** : `windows-gpo-core.test.ts` (100% — teste l'API
directement) + `windows-domain-kerberos-migration.test.ts` (100%) +
`windows-server-gpo.test.ts` / `windows-server-domain-join.test.ts`
(échecs identiques avant/après : gap pré-existant, sans rapport, de
dispatch cmd pour `gpupdate`/`gpresult`/`netdom`/`nltest`/`dcdiag`/
`klist`). Typecheck et lint ciblés propres.

## Windows Server — enregistrements SRV Global Catalog et scopés au site à la promotion DC

`WindowsServer` sait désormais si l'instance est un Global Catalog
(nouveau champ `isGlobalCatalog`, exposé via `isGlobalCatalogServer()`) :
`true` pour le premier DC d'une forêt (`Install-ADDSForest`) et pour le
premier DC de chaque nouveau domaine enfant (`New-ADDomain`), `false`
par défaut pour un DC additionnel qui rejoint un domaine existant
(`Install-ADDSDomainController`) — comportement par défaut réel d'AD.

`DomainDnsProvisioning.provisionDomainDnsZone` ajoute maintenant, en plus
des enregistrements déjà existants, les SRV scopés au site
(`_ldap._tcp.<site>._sites.dc._msdcs`, `_kerberos._tcp.<site>._sites.dc.
_msdcs`, toujours) et les SRV Global Catalog (`_gc._tcp` et
`_gc._tcp.<site>._sites`, port 3268, seulement si `isGlobalCatalog`).

**Validation** : nouveau test dans `windows-server-dns.test.ts`
(promotion forêt → vérifie les 4 nouveaux SRV) + suite complète
DNS/DC-promotion/forêt/sites (5 fichiers, 61 tests, 3 échecs
`dnscmd` pré-existants et sans rapport, identiques avant/après).
Typecheck et lint ciblés propres.

## Windows Server — auto-création de la zone inverse (in-addr.arpa) à la promotion DC

Extrait `WindowsServer.provisionDomainDnsZone` (le fichier dépassait déjà
400 lignes) vers un nouveau module `windows/server/dns/
DomainDnsProvisioning.ts` (32 lignes), qui reprend la logique existante
(zone directe + A + SRV) et y ajoute l'auto-création de la zone inverse
`/24` (`c.b.a.in-addr.arpa`) pour le sous-réseau propre du DC, avec son
enregistrement PTR — seulement pour un masque `/24` exact (limitation
assumée, cohérente avec `applyDynamicPtrRecord`). `WindowsServer.ts` ne
fait plus que déléguer à ce module.

**Validation** : nouveau test dans `windows-server-dns.test.ts`
(promotion DC → vérifie la zone `60.168.192.in-addr.arpa` et son PTR)
+ suite complète DNS/domain-join/DHCP/AD-sites/AD-forest (5 fichiers,
70+ tests, 15+3 échecs pré-existants et sans rapport, identiques
avant/après). Typecheck et lint ciblés propres.

## Windows Server — enregistrement DNS dynamique à l'octroi d'un bail DHCP (P7/P8)

Suite directe du lot précédent (jonction de domaine → DNS). Le client
DHCP (`DHCPClient.ts`, moteur partagé Linux/Windows) envoie maintenant
son hostname sur l'option 12 dans DISCOVER/REQUEST/RENEW/REBIND
(`WireDhcpChannel` dans `DhcpServerChannel.ts` pose l'option sur le vrai
paquet DHCP posé sur le câble ; `EndHost` appelle
`dhcpClient.setDeviceId(id, name)` à la construction pour lui donner ce
hostname, ce qui n'était fait nulle part en production avant ce lot).

Côté serveur, `WindowsDhcpServerRole.serveOnWire()` lit cette option 12
sur le REQUEST au moment de construire l'ACK et déclenche un nouveau
hook `onLeaseGranted(hostname, ip)`. `WindowsServer.getDhcpServerRole()`
câble ce hook vers `this.getDnsServerRole()?.applyDynamicARecord(...)`
en mémoire sur ce même device, avec la zone du domaine (DC ou serveur
membre) comme zone cible — DHCP et DNS co-installés sur le même serveur
étant la topologie visée par le PRD pour l'autorisation AD simulée. Le
même hook, ainsi que celui de la jonction de domaine (`WindowsPC.ts`),
appellent aussi un nouveau `applyDynamicPtrRecord(zoneName, hostName,
ipv4)` qui dérive la zone inverse `/24` (`c.b.a.in-addr.arpa`) et
réutilise `addPtrRecord` — no-op tant que cette zone n'existe pas
(aucune zone inverse n'est encore auto-créée ; ce sera l'objet du lot
suivant).

`DHCP_OPTION.HOST_NAME` (12) ajouté à `DHCPPacket.ts`.

**Validation** : deux nouveaux tests dans `windows-server-dhcp.test.ts`
(DC avec AD DS + DNS + DHCP co-installés, autorisé via
`Add-DhcpServerInDC`, client Windows qui obtient un bail réel sur le
câble → vérifie l'enregistrement A, puis idem avec la zone inverse déjà
créée → vérifie le PTR) + suite complète DHCP (13 fichiers, 148+ tests,
15 échecs pré-existants et sans rapport, identiques avant/après par
`git stash` — dont un bug pré-existant, hors périmètre, de troncature
du nom de zone par le parseur d'arguments PowerShell sur
`Add-DnsServerPrimaryZone -Name <zone-avec-tirets-et-points>`,
contourné dans le test en appelant `addPrimaryZone` directement) +
suite DNS/domain-join déjà validée au lot précédent. Typecheck et lint
ciblés propres.

## Windows Server — enregistrement DNS dynamique à la jonction de domaine (P7)

Premier lot du chantier "cœur Windows Server" (AD DS/DNS/DHCP/objets/GPO,
hors commandes et PowerShell) : `WindowsDnsServerRole.applyDynamicARecord`
existait déjà mais n'était appelé nulle part (code mort confirmé par
grep exhaustif) et était de toute façon cassé pour tout appelant réel
(traitait son paramètre comme un FQDN déjà complet, sans jamais passer
par `this.fqdn(...)` comme `addARecord` le fait).

**Câblage** : la jonction de domaine (`Add-Computer`/`netdom join`) envoie
déjà un vrai `AddRequest` LDAP par-dessus le câble pour créer le compte
ordinateur — ce PDU porte désormais aussi l'IP de la machine qui rejoint
(`DomainJoinClient.joinDomain()` accepte un `ownIp` optionnel, ajouté
comme attribut `ipAddress` sur l'`AddRequest`). Côté DC, `LdapServerHandler`
(`LdapServer.ts`) détecte après un `addRequest` réussi si l'entrée créée
est un objet `computer` porteur d'un attribut IP, et déclenche alors
`onComputerRegistered` — un nouveau hook optionnel de `LdapServerContext`,
câblé dans `WindowsPC.ts` à l'écoute TCP/389 pour appeler
`this.getDnsServerRole()?.applyDynamicARecord(...)` en mémoire sur ce
même device. La mutation DNS elle-même reste un appel in-process (même
convention que `PrimaryZoneAgent.applyUpdate`, déjà établie dans tout le
moteur DNS pour BIND9 comme pour Windows) — seul le transfert de l'IP
entre les deux machines devait obligatoirement passer par un PDU réel
sur le câble, ce qui est désormais le cas.

`AdComputer.lastKnownIp` (jusqu'ici un champ diagnostic jamais peuplé)
est maintenant réellement projeté depuis l'attribut `ipAddress` de
l'entrée LDAP par `DirectoryStore.projectComputer()`.

**Validation** : nouveau test dans `windows-server-dns.test.ts`
(jonction de domaine réelle avec le rôle DNS installé avant la
promotion → vérifie l'enregistrement A du poste joint sur le DC) +
suite complète DNS/LDAP/domain-join/AD (`windows-server-dns`,
`windows-server-domain-join`, `ldap-server-client`, `ldap-gssapi-bind`,
`ldap-wire-p11`, `windows-dns-server-role`, `ad-forest`, `ad-sites`) —
87 tests, 13 échecs pré-existants et sans rapport (gap générique de
dispatch cmd pour `dnscmd`/`netdom`/`nltest`/`dcdiag`/`klist`/`gpupdate`/
`gpresult`, confirmé identique avant/après par `git stash`). Typecheck
et lint ciblés propres (2 erreurs lint pré-existantes, lignes éloignées
des modifications).

## Convergence de branche : Linux Phase 4 (`realpath` + correctif cwd) + Windows Phase 17 (`netsh ipsec`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le pont Linux, l'autre sur le pont Windows, sans
recouvrement de fichiers en dehors de `CHANGELOG.md`.

### Linux — `realpath` + correctif cwd inter-commandes

**Commande migrée** : `realpath [-q] [-m] <cible...>` — réutilise la
primitive `FileSystemApi.realpath?()` ajoutée pour `readlink -f` en Phase
3 (même algorithme, deux commandes clientes). Sémantique de sortie
distincte de `readlink` et reproduite à l'identique : défaut à `.` sans
cible, `-q` supprime les messages d'erreur, `-m` n'exige l'existence
d'aucune composante — code de sortie 1 dès qu'UNE cible échoue
(contrairement à `readlink` où seul un échec total compte).

**Bug trouvé et corrigé en testant `realpath`/`readlink` après un `cd`
scripté** : `cd chemin && commande-migrée` dans une même ligne bash
laissait `commande-migrée` voir un `cwd` périmé. Cause racine :
`cd` est un *builtin* bash (intercepté avant même d'atteindre le pont
externe), qui met à jour l'environnement bash (`PWD`) immédiatement,
mais `LinuxCommandExecutor.cwd` — dont dépend la session construite pour
`_commandKernelHook` — n'était resynchronisé depuis `env['PWD']` que dans
`dispatchFromInterpreter()`. Or `dispatchMaybeNetwork()` consulte le hook
`command-kernel` **avant** d'atteindre `dispatchFromInterpreter()` : toute
commande déjà migrée voyait donc un `cwd` non rafraîchi tant qu'aucune
commande non migrée n'était passée par ce second point auparavant.
Symptôme concret : `cd /root/a/b && ls` renvoyait une liste vide au lieu
du contenu de `/root/a/b`. Fix : extraction en `syncCwdFromEnv()`,
appelée en tête de `dispatchMaybeNetwork()` (avant le hook) autant que
dans `dispatchFromInterpreter()` — bug structurel de la Phase 0, pas
propre à `realpath`, mais découvert en migrant cette commande.

**Legacy supprimé** : `case 'realpath':` retiré de
`LinuxCommandExecutor.dispatch()` — aucun autre appelant, pas présent
dans l'autre framework `LinuxCommand` (§8 vérifié).

**Validation** : lot audit/privilège du §7.2 + `linux-command-kernel.test.ts`
+ `linux-bash-details.test.ts` + `bash-advanced-scripts.test.ts` — 652
tests, 1 échec pré-existant et sans rapport déjà documenté
(`journalization.test.ts` #161). Vérification manuelle du bug cwd via un
test jetable non versionné (5 exécutions consécutives sur un device
neuf, 5/5 reproductibles avant le correctif, 0/5 après). Typecheck ciblé
propre.

### Windows — migration `netsh` — contexte `ipsec` (static + dynamic)

Troisième tranche de `netsh` (voir Phases 15-16). Le contexte `ipsec` est
le plus gros bloc autonome restant (~56 réf. de test `netsh ipsec static`,
12 `dynamic`).

**Magasin de politiques IPsec migré et assaini** : le legacy stockait
`winIPSecPolicies`/`winIPSecFilterLists`/`winIPSecFilterActions`/
`winIPSecRules`/`winIPSecDynamic` en **variables module-level globales** —
partagées par TOUS les `WindowsPC` d'un même processus (bug latent
d'isolation). La migration les déplace en état **par-instance** sur
`WindowsPC` (`ipsecNetshState`), exposé via une nouvelle capacité
`WindowsNetConfigApi.ipsec: WindowsIpsecStore` — CRUD granulaire typé
(policies/filterLists/filters/filterActions/rules + réglages dynamic
main-mode/qm/config). Types `WindowsIpsecPolicy`/`WindowsIpsecFilter`/
`WindowsIpsecFilterList`/`WindowsIpsecFilterAction`/`WindowsIpsecRule`/
`WindowsIpsecDynamicSettings` ajoutés.

`NetshCommand` porte l'intégralité du parsing `name=value`, du dispatch de
sous-objet (`add|delete|show|set policy|filterlist|filter|filteraction|
rule`, `dynamic set|show mainmode|qm|config|all|stats`), de la validation
(IP, doublons, liste de filtres en cours d'usage) et du formatage — copié
depuis `WinNetsh.ts`, qui reste intact pour le shim PowerShell. Le magasin
ne fait que du CRUD ; tous les messages (« already exists »/« was not
found »/« cannot be deleted because it is in use ») vivent dans la
commande.

Validation : typecheck et ESLint propres. `cmd-netsh.test.ts` comparé au
commit pré-Phase-17 via `git stash` : 68 échecs/118 réussites avant →
44/142 après, 24 tests corrigés, zéro régression. Suites
netsh/consistency/arp (140 tests) re-vérifiées sans régression.

Contextes `netsh` encore différés : `lan`, `wlan`, `http`, `advfirewall`,
`dhcp server`, `nps`, `bridge`, `namespace`.

## Windows — Phase 16 : migration `netsh` — contextes `dhcpclient`, `dnsclient`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deuxième tranche de `netsh` (voir Phase 15). Ces deux contextes débloquent
le cluster des tests de cohérence (`windows-consistency.test.ts`) qui
recoupent `ipconfig`/`netsh`/`dhcpclient`/`dnsclient` pour vérifier qu'une
même donnée (IP, serveurs DNS, suffixe, mode) est rapportée à l'identique
par toutes les commandes.

**`netsh dhcpclient`** (`install`/`uninstall`/`renew`/`release`/`list`/
`show state|interfaces|parameters|tracing`/`set tracing|interface`/`trace
enable|disable|show`) : réutilise les primitives DHCP déjà présentes
(`requestLease`/`releaseLease`/`autoDiscoverDhcpServers`/`dhcpLease`) plus
un état de configuration `netsh`-spécifique par-instance (service installé,
traçage, interfaces libérées) stocké sur `WindowsPC` et exposé via
`dhcpClientConfig()`/`setDhcpClient*()`/`setInterfaceReleased()` — même
patron que `portProxy`/`ipv6Routes`/`winhttpProxy` aux phases précédentes.

**`netsh dnsclient`** (`show state|interfaces|dnsservers|encryption`/`add|
delete|set dnsserver`/`set global dnssuffix=`/`reset`) : réutilise
`staticDnsServers`/`setDnsServers`/`setDnsMode`/`primaryDnsSuffix`, plus la
nouvelle primitive `setPrimaryDnsSuffix` (le suffixe DNS principal était
en lecture seule depuis la Phase 14) et `isDhcpClientRunning`/
`isDnsClientRunning` (portes de service `dhcp`/`dnscache`).

`NetshCommand` porte l'intégralité du dispatch et du formatage des deux
contextes, copié depuis `WinNetsh.ts` (intact pour le shim PowerShell).

Validation : typecheck et ESLint propres. Suite localisée (4 fichiers
netsh/dhcp/dns/consistency, 113 tests) comparée au commit pré-Phase-16 via
`git stash` : 32 échecs/81 réussites avant → 0/113 après, 32 tests
corrigés, zéro régression. Suite arp/tracert/ipconfig (376 tests)
re-vérifiée sans régression.

Contextes `netsh` encore différés : `ipsec`, `lan`, `wlan`, `http`,
`advfirewall`, `dhcp server`, `nps`, `bridge`, `namespace`.

## Windows — Phase 15 : migration `netsh` — contexte `interface`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

`netsh` (3180 lignes, plus grosse commande cmd.exe restante) migrée par
sous-contextes, comme convenu. Cette première tranche couvre le contexte
`interface` — de loin le plus utilisé (234 réf. de test `netsh interface
ip`, 46 `ipv4`, 21 `interface show`, 21 `interface set`, 18 `portproxy`,
23 `ipv6`) — plus les commandes de plus haut niveau stateless (`show`,
`trace`, `winsock`, `winhttp`, `p2p`, stubs de sous-contextes, `int ip
reset`).

**`WindowsAdapterInfo` encore étendu** (`dnsMode`, `adminEnabled`,
`secondaryIps`, `ipv6Addresses`) et **~30 primitives ajoutées à
`WindowsNetConfigApi`** — une par opération vendeur réelle :
`resolveAdapterName`, `configureAddress`, `setAddressDhcp`,
`clearInterfaceIP`, `addSecondaryIp`/`removeSecondaryIp`, `setDnsServers`/
`setDnsMode`, `setInterfaceAdmin`, `renameInterface`, `resetTcpIpStack`,
`resetWinsockCatalog`, `addIPv6Address`/`removeIPv6Address`,
`ipv6Routes`/`addIPv6Route`, `portProxyRules`/`addPortProxyRule`/
`removePortProxyRule`/`resetPortProxy`, `winhttpProxy`/`setWinhttpProxy`.
Types `WindowsIPv6AddressEntry`/`WindowsIPv6RouteEntry`/
`WindowsPortProxyRule` ajoutés. `PortProxyRule`/`PortProxyTable` réutilisés
tels quels (objets de domaine existants, pas des dispatchers `cmdX`).

`NetshCommand` porte l'intégralité du dispatch de contexte et le parsing
regex de chaque forme (`set/add/delete address/dns/route/neighbors`,
`show config/dns/route/neighbors`, `set/show interface`, `portproxy
add/delete/show`, `ipv6 add/delete/show address/route`) — copié depuis
`WinNetsh.ts`, qui reste intact pour le shim PowerShell natif.

**Bug de fond corrigé au passage** : `getCommandKernelShell()` passait
`ports: this.getPorts()` — un SNAPSHOT figé — et `adapters()` lisait
`port.getName()`. Or `netsh interface set interface newname=` re-clé la
table de ports SANS muter le port (`Port.name` est `readonly`), donc le
nom d'affichage restait figé après renommage. Nouvelle primitive de deps
`netInterfaces()` exposant la vue LIVE `{ name: cléDeMap, port }` — le nom
vient désormais de la clé de table (qui reflète le renommage), plus jamais
d'un instantané ni du nom interne immuable.

**Contextes différés** (phases suivantes, engines dédiés) : `dhcpclient`,
`dnsclient`, `ipsec`, `lan`, `wlan`, `http`, `advfirewall`, `dhcp server`,
`nps`, `bridge`, `namespace` — `NetshCommand` renvoie pour eux le message
« subcommand not found » (comme un contexte non installé), sans jamais
déléguer au `cmdNetsh` legacy (pas de passthrough).

Validation : typecheck propre. Suite localisée (6 fichiers netsh/ipconfig/
consistency, 158 tests) comparée au commit pré-Phase-15 via `git stash` :
74 échecs/84 réussites avant → 10/148 après, 64 tests corrigés, zéro
régression. Les 10 échecs restants dépendent tous de `netsh dhcpclient`/
`dnsclient` (contextes différés, vérifié cas par cas). Suite arp/route/
getmac/ping/tracert/nslookup re-vérifiée sans régression.

## Windows — Phase 14 : migration `ipconfig`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Dernier morceau autonome du lot réseau bas niveau avant `netsh` (3000+
lignes, phase à part). `cmdIpconfig`/`WinIpconfig.ts` (519 lignes)
n'étaient — comme `ping`/`tracert` — jamais enregistrées dans le
`CommandRegistry` ; `ipconfig` tapé en cmd.exe produisait `not
recognized`.

**`WindowsAdapterInfo` étendu** (`mask`, `globalIPv6`, `linkLocalIPv6`,
`connectionDnsSuffix`, `isDhcp`) — réutilisé tel quel par `arp`/`route`/
`getmac` sans les nouveaux champs, aucune rupture.

**Nouvelles primitives `MachineApi.netConfig`**, une par opération
vendeur réelle : `defaultGateway()`/`defaultGateway6()`,
`primaryDnsSuffix()`, `staticDnsServers(ifName)`, `dhcpLease(ifName)`
(bail DHCPv4 résolu, type `WindowsDhcpLease`), `releaseLease(ifName)` /
`requestLease(ifName)` (l'appelant relit `dhcpLease()` ensuite pour
déterminer auto-configuration/bail obtenu/échec — pas besoin que la
primitive renvoie un résultat structuré), `autoDiscoverDhcpServers()`,
`releaseDynamicIPv6(ifName)`, `sendRouterSolicitation(ifName)`,
`classId`/`setClassId` (IPv4/IPv6 unifiés par un paramètre `isV6`),
`flushDnsCache()`, `dnsCacheEntries()` (données brutes du cache
résolveur, TTL déjà décompté côté pont — `IpconfigCommand` fait son
propre formatage `/displaydns`, comme `renderDisplayDns` avant, mais
depuis la commande).

`IpconfigCommand` porte l'intégralité du dispatch (`/all`, `/release[6]`,
`/renew[6]`, `/flushdns`, `/displaydns`, `/registerdns`,
`/show|setclassid[6]`, filtre d'adaptateur wildcard `*`/`?`) et du
formatage — copié depuis `WinIpconfig.ts`, qui reste intact pour le shim
PowerShell. `toDisplayName` (`WindowsInterfaceNaming.ts`) réutilisé tel
quel : utilitaire pur de renommage `eth0 → Ethernet 0` déjà partagé par
6 autres modules (PowerShell inclus), pas un dispatcher `cmdX`.

Piège évité : `getDnsSuffix` doit être une MÉTHODE dans
`WindowsMachineApiDeps`, pas un champ figé — `getCommandKernelShell()`
construit les deps UNE fois (mémoïsées par instance `WindowsPC`), et le
suffixe DNS principal est réassigné en interne (`netsh`, une fois
migré) ; un champ `readonly dnsSuffix: string` aurait capturé une valeur
obsolète pour toute la durée de vie de l'instance.

Validation : typecheck propre. Suite localisée (8 fichiers ipconfig/DNS/
DHCP, 133 tests) comparée au commit précédent via `git stash` : 84
échecs/49 réussites avant → 42/91 après, 42 tests corrigés, zéro
régression. Suite arp/route/getmac/ping/tracert (391 tests) re-vérifiée
sans régression suite à l'extension de `WindowsAdapterInfo`. Échecs
restants dus à `netsh`, seule pièce manquante du lot réseau bas niveau.

## Windows — Phase 13 : migration `tracert`, `nslookup`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Suite du lot réseau bas niveau. Même constat qu'à la Phase 12 pour
`tracert` : `cmdTracert`/`WinTracert.ts` n'étaient jamais invoqués en
production — `WindowsTerminalSession.tryStartWinTracertStream` intercepte
`tracert` tapé en direct AVANT `executeCmdCommand` (streaming saut par
saut), et n'utilise que les formateurs purs `formatWinTracertHeader`/
`formatWinTracertHop`. `cmdTracert` restait donc inatteignable hors tests
appelant `executeCommand('tracert ...')` directement.

**Nouvelles primitives `MachineApi.netConfig`** : `traceroute(targetIp,
maxHops?, timeoutMs?)` (délègue à `EndHost.executeTraceroute`, type
`WindowsTracerouteHop` déjà entièrement en données plates — aucune
conversion nécessaire, contrairement à ping) et `reverseLookup(ip)`
(fichier hosts). `TracertCommand` porte l'intégralité du parsing
(`parseWinTracertArgs`) et du formatage (en-tête, ligne de saut, mode
numérique `-d`), copié depuis `WinTracert.ts` qui reste intact pour
`WindowsTerminalSession`.

**`nslookup`** — cas différent : `cmdNslookup` n'est PAS une simple
fonction Windows-only comme `cmdSc`/`cmdNetUser` — son cœur,
`executeNslookup` (`linux/commands/dns/NslookupRunner.ts`), est déjà un
moteur DNS partagé par Linux ET Windows, vivant dans un module neutre,
faisant du vrai travail protocolaire (parsing de requête, formatage de
réponse RCODE/enregistrements via le moteur `@/network/dns`), pas de la
logique dispositif. Le dupliquer dans `NslookupCommand` aurait été un
recul (deux copies d'un formateur DNS déjà correct et testé). Traitement
retenu : `NslookupCommand` migre la partie réellement Windows-spécifique
de `cmdNslookup` (court-circuit fichier hosts/nom propre AVANT tout DNS,
porte d'entrée service `Dnscache`) et appelle `executeNslookup` pour la
partie protocolaire, exactement comme un `IPAddress`/`SubnetMask` ou tout
autre composant du moteur réseau partagé — jamais un `ctx.machine`
externe, jamais un dispatcher `cmdX` Windows.

**Nouvelles primitives** : `resolveViaHostsFile(name)` (résolution fichier
hosts SEUL, sans repli DNS — distinct de `resolveHostname` que `ping`/
`tracert` utilisent, `nslookup` a besoin d'un court-circuit explicite),
`firstConfiguredDnsServer()`, `queryDnsServer(server, name, qtype,
timeoutMs?)` (type `DnsMessage` du moteur `@/network/dns` réutilisé tel
quel dans `machine/types.ts` — DNS est un protocole, pas une réalité
vendeur Windows, contrairement aux formats `sc`/`schtasks`).

Validation : typecheck propre. Suite localisée (8 fichiers DNS/ping/
tracert/arp/routing, 478 tests) comparée au commit précédent via
`git stash` : 136 échecs/342 réussites avant → 96/382 après, 40 tests
corrigés, zéro régression (vérifié : les échecs nslookup restants
dépendent de `netsh interface ip set address/dns`, pas encore migré —
même nature que le gap WAN de la Phase 12, confirmé en lisant le test).

## Convergence de branche : Linux Phase 3 (`readlink`) + Windows Phase 12 (`ping`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le pont Linux, l'autre sur le pont Windows, sans
recouvrement de fichiers en dehors de `CHANGELOG.md`.

### Linux — `readlink`

**Commande migrée** : `readlink [-f|-e|-m] <cible...>` — mode direct
(cible immédiate d'un lien symbolique, un seul niveau) via
`ctx.machine.fs.readlink()` déjà existant ; mode canonicalisation
(`-f`/`-e`/`-m`, résout toute la chaîne de liens) via une nouvelle
primitive `FileSystemApi.realpath?(path, actor, requireFinal)`.

**Extension de `MachineApi`** : `realpath?` optionnelle (vendeurs avec
liens symboliques uniquement), implémentée dans `LinuxFileSystemApi` en
enveloppant `VfsPath.realpath()` — le même algorithme déjà utilisé par le
`readlink -f`/`realpath` legacy, pas une resimulation. `ReadlinkCommand`
porte elle-même la distinction des trois flags (`-f`/`-e`/`-m` traités de
façon identique, `requireFinal` uniquement pour `-e` — simplification
héritée telle quelle du legacy, pas introduite ici) et la sémantique de
code de sortie exacte (échec seulement si TOUTES les cibles échouent,
un mélange succès/échec reste code 0 — quirk legacy reproduit à
l'identique, pas "corrigé").

**Legacy supprimé** : `case 'readlink':` retiré de
`LinuxCommandExecutor.dispatch()` — aucun autre appelant, pas présent
dans l'autre framework `LinuxCommand` (§8 vérifié).

**Validation** : lot audit/privilège du §7.2 (`auditctl.test.ts`,
`auditctl-other.test.ts`, `journalization.test.ts`,
`journalization-and-audit.test.ts`, `command-privilege-policy.test.ts`)
+ `linux-command-kernel.test.ts` — 509 tests, 1 échec pré-existant et
sans rapport déjà documenté (`journalization.test.ts` #161). Vérification
manuelle des trois modes (direct, `-f` résolvant la chaîne complète,
cible manquante) via un test jetable non versionné, supprimé après
utilisation — aucune commande CLI existante n'exerçait `readlink -f` en
assertions (seul un test debug non assertionnel l'utilisait). Typecheck
et lint ciblés propres.

### Windows — migration `ping`

Suite du lot réseau bas niveau (Phase 11) : `ping` était le blocage
principal derrière une bonne partie des échecs restants (`arp-command.test.ts`
peuplait sa table via un `ping` préalable, `routing-table.test.ts` teste le
« General failure » sans route, etc.). `cmdPing`/`WinPing.ts` n'étaient
JAMAIS invoqués en production : `WindowsTerminalSession.tryStartWinPingStream`
intercepte `ping` tapé en direct AVANT `executeCmdCommand` (pour le
streaming ligne-par-ligne en temps réel, `-t` continu, Ctrl+C) et
n'utilise que les fonctions pures de formatage/parsing de `WinPing.ts`
(`parseWinPingArgs`, `formatWinPingHeader`, ...), jamais `cmdPing` lui-même.
`cmdPing` n'était donc atteignable que par les tests appelant
`pc.executeCommand('ping ...')` directement (hors session terminal) — et
`ping` n'ayant jamais été enregistrée dans le `CommandRegistry`, ce chemin
produisait `'ping' is not recognized...`.

**Nouvelles primitives sur `MachineApi.netConfig`** :
`resolveHostname(name)` (résolution DNS/hosts réelle, déjà câblée pour
`net use`, maintenant réutilisée) et `pingSequence(targetIp, count,
timeoutMs?, ttl?)` (séquence d'échos ICMP réels, délègue à
`EndHost.executePingSequence` — tableau vide = pas de route/pas de
réponse ARP, exactement la sémantique déjà utilisée par le pont legacy).

`PingCommand` (nouvelle) porte l'intégralité du parsing d'arguments
(`parseWinPingArgs`, ~20 options `-t/-a/-n/-l/-f/-i/-v/-r/-s/-j/-k/-w/-S/
-c/-p/-4/-6`, copié depuis `WinPing.ts` plutôt qu'importé — `WinPing.ts`
reste intact pour l'usage exclusif de `WindowsTerminalSession` côté
streaming) et du formatage de sortie (en-tête, ligne de réponse,
statistiques, `-r`/`-s`). `lenientOptions: true` (même raison que
`arp`/`route`).

**Correction mineure au passage** : le message d'échec DNS
(`Dnscache` arrêté) appelait le gabarit `WinFeatureGate.ERRORS.dnsUnavailable(host)`
sans lui passer `host` (bug latent jamais visible en production puisque
`cmdPing` n'était jamais exécuté) — le nouveau message interpole
correctement la cible (`*** Can't find <target>: No DNS servers available`).

Validation : typecheck propre. Suite localisée élargie (14 fichiers,
841 tests, incluant `tracert-ping.test.ts` et `windows-feature-gates.test.ts`)
comparée au commit pré-Phase-12 via `git stash` : 251 échecs/590 réussites
avant → 211/630 après, 40 tests corrigés, zéro régression (vérifié cas par
cas sur les échecs `tracert-ping.test.ts` restants : mêmes scénarios déjà
en échec avant, avec un message différent — `not recognized` devenu
`General failure`/timeout — pas de nouvelle casse). Échecs restants dus à
`netsh`/`ipconfig`/`tracert`/`nslookup`, pas encore migrés.

## Windows — Phase 11 : migration `arp`/`route`/`getmac` (pile réseau bas niveau)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

`executeCmdCommand()` routait déjà tout cmd.exe exclusivement via
`CmdInterpreter` (`runCommandKernel`, aucun fallback) — mais `ipconfig`,
`netsh`, `arp`, `route`, `getmac`, `ping`, `tracert`, `nslookup` n'avaient
jamais été enregistrées dans le `CommandRegistry` : elles restaient
utilisables uniquement via `WindowsPC.runSyncNativeCommand` (le shim
PowerShell), et tapées en cmd.exe elles produisaient
`'ipconfig' is not recognized as an internal or external command`. Cette
phase migre le premier lot — `arp`, `route`, `getmac` — auto-contenu (pas
de dépendance à la passerelle DHCP nécessaire à `ipconfig`).

**Nouvelle capacité `MachineApi.netConfig?: WindowsNetConfigApi`** —
primitives granulaires, une par opération vendeur réelle :
- `adapters()` — état brut des interfaces (nom, MAC, IP, up/connected/admin-down),
  réutilisé par les trois commandes plutôt que dupliqué.
- `arpEntries()`/`addStaticArp()`/`deleteArp()`/`clearArp()` — table ARP.
- `routes()`/`addRoute()`/`removeRoute()`/`setDefaultGateway()`/`clearDefaultGateway()`
  — table de routage (déjà résolue : connectées + statiques + défaut).

`ArpCommand`/`RouteCommand`/`GetmacCommand` (nouvelles, dans
`command-kernel/commands/`) portent l'intégralité de l'analyse d'arguments,
du dispatch et du formatage de sortie — auparavant dans `WinArp.ts`/
`WinRoute.ts`/`WinGetmac.ts` — y compris la validation de syntaxe utilisateur
(`IPAddress`/`SubnetMask`/`MACAddress`, réutilisés comme n'importe quel type
de domaine, pas une passerelle legacy) et les messages d'erreur exacts
(« The specified mask parameter is invalid »,
« The parameter is incorrect »...). `WinArp.ts`/`WinRoute.ts`/`WinGetmac.ts`
restent intacts, seuls consommateurs désormais du shim PowerShell natif
(`runSyncNativeCommand`).

Point d'implémentation : `arp`/`route` acceptent des options style BSD
(`-a`, `-d`, `-s`, `-f`, `-p`...) plutôt que le `/flag` habituel de cmd.exe
— sans `lenientOptions: true` sur le descripteur, l'`ArgumentParser`
générique les rejette (« option inconnue : -a ») puisqu'aucun `OptionSpec`
n'est déclaré ; elles doivent atterrir en positionnels bruts pour que la
commande fasse elle-même le dispatch, exactement comme `echo -w foo`.

Validation : `npx tsc --noEmit` propre (mêmes 7 erreurs pré-existantes et
sans rapport, ex. `AccountLifecycleVerdict`/`strictNullChecks:false`).
Suite localisée (13 fichiers touchant windows/réseau + `arp-command.test.ts`,
832 tests) comparée au commit pré-Phase-11 via `git stash` : 269 échecs/563
réussites avant → 243 échecs/589 réussites après, soit 26 tests corrigés,
zéro régression. Les échecs restants dans ce lot concernent exclusivement
`ping`/`ipconfig`/`netsh`, pas encore migrés (prochaines phases).

## Convergence de branche : Linux Phase 2 (`umask`) + Windows Phase 10 (élimination du passthrough opaque `execute(argv)`)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Deux lots de travail parallèles sur la même branche, fusionnés dans ce
commit — l'un sur le pont Linux, l'autre sur le pont Windows, sans
recouvrement de fichiers en dehors de `CHANGELOG.md`.

### Linux — `umask`

**Gap explicitement signalé au §12 du framework** : `umask` était lu
dynamiquement par toutes les commandes de création de fichier déjà
migrées (`touch`, `mkdir`, `cp`...), mais aucune commande `umask` n'existait
côté `command-kernel` pour le modifier — seul le `case 'umask':` legacy
(`LinuxCommandExecutor.dispatch()`) pouvait le faire.

**Extension de `MachineApi`** : nouvelle capacité optionnelle
`permissions?: PermissionsApi` (`getUmask()`/`setUmask(mask)`) —
optionnelle car `umask` est un concept POSIX sans équivalent universel
(Windows/ACL, Cisco/Huawei n'ont rien à y mettre), suivant exactement le
patron déjà établi pour `audit?`/`services?`/`registry?`. `UmaskCommand`
n'appelle que `ctx.machine.permissions.getUmask()/setUmask()` — sa propre
logique (formatage octal 4 chiffres, validation, message d'erreur exact)
vit entièrement dans la commande, jamais déléguée à une fonction externe.

**Câblage Linux** : `LinuxMachineApiDeps.setUmask(mask)` (nouveau,
symétrique du `getUmask()` déjà existant), branché sur
`LinuxCommandExecutor.setUmask()` (nouveau setter public, miroir de
`getUmask()` déjà existant) depuis les deux constructeurs de shell
command-kernel (`LinuxMachine.getCommandKernelShell()` et le repli
autonome `LinuxCommandExecutor.getDefaultCommandKernelShell()`).

**Legacy supprimé** : `case 'umask':` et `cmdUmask` (`LinuxPermCommands.ts`)
supprimés entièrement — aucun autre appelant (contrairement à `chgrp`,
`umask` n'existe pas dans l'autre framework `LinuxCommand`, §8 vérifié).

**Validation** : lot localisé — `linux-filesystem-and-IAM.test.ts`,
`ssh-lan-security-editors.test.ts` (SE30, parité local/SSH),
`ssh-strict-modes.test.ts`, `linux-command-kernel.test.ts` (harnais du
socle lui-même, `deps` de test mis à jour avec un vrai `setUmask`
mutable) plus le lot audit/privilège du §7.2 — 622 tests, 1 échec
pré-existant et sans rapport (`journalization.test.ts` #161, déjà
documenté en Phase 1). Typecheck ciblé propre.

### Windows — correction du passthrough opaque `execute(argv)` (sc/net/schtasks/print/auditpol/winrm)

**Ce que les Phases 6/7/9 ont fait de travers, sur retour explicite de
l'utilisateur** : `MachineApi.services`/`netExe`/`scheduling`/`printing`/
`auditPolicy`/`winRm` exposaient chacun une méthode UNIQUE et opaque
`execute(argv)` qui, côté pont (`WindowsMachineApi.ts`), se contentait de
transmettre l'argv déjà tokenisé à la fonction `cmdX` legacy correspondante
(`cmdSc`, `cmdNetUser`/`cmdNetLocalgroup`/`cmdNetStart`/`cmdNetStop`/
`cmdNetShare`/`cmdNetUse`, `cmdSchtasks`, `cmdPrint`, `cmdAuditpol`,
`cmdWinrm`). La commande appelait bien `ctx.machine.X.execute(...)` — donc
« passait par MachineApi » au sens littéral — mais tout le VRAI travail
(analyse des arguments, dispatch de sous-commande, mise en forme du texte
de sortie) restait entièrement dans la fonction legacy, invoquée depuis le
pont plutôt que depuis la commande. C'est exactement le problème de la
Phase 5 (l'échappatoire `.native`) sous une forme différente : au lieu de
contourner `MachineApi` en récupérant l'objet legacy brut, on le
contournait en laissant `MachineApi` elle-même déléguer aveuglément à une
fonction externe. Un push = une fonctionnalité migrée, pas juste
redirigée.

**Correction, sous-système par sous-système** — chaque `execute(argv)`
remplacé par des primitives typées, une par opération SCM/SAM/etc réelle ;
tout l'analyse d'arguments, le dispatch de sous-commande et le texte
d'erreur/succès déplacés dans la commande elle-même :

- **`ServiceManagementApi`** (`sc`, ex-`cmdSc`, 14 sous-commandes) :
  `exists`/`displayNameFor`/`resolveName`/`isRunning`/`runningServiceNames`/
  `allServiceNames`/`pidFor` + `formatQuery`/`formatQueryEx`/`formatQc`/
  `formatDescription`/`formatQfailure` (texte déjà canonique, produit par
  les méthodes `formatScXxx` de `WindowsServiceManager` lui-même — l'objet
  vendeur réel, pas une fonction externe) + `start`/`stop`/`pause`/`resume`/
  `setStartType`/`setDependencies`/`setAccount`/`setDescription`/
  `setFailureConfig`/`create`/`delete`. `ScCommand.ts` porte maintenant
  l'intégralité du dispatch de `WinSc.ts` (`scQuery`/`scStart`/... et le
  gabarit d'erreur `[SC] ... FAILED nnnn`).
- **`UserManagementApi`/`GroupManagementApi`** étendues pour `net user`/
  `net localgroup` : `listAccountNames`/`getAccountDetail`/`createAccount`/
  `deleteAccount`/`setAccountProperty`/`callerIsAdmin`/`domainAccountNames`/
  `getDomainAccountDetail` et `listGroupNames`/`getGroupDetail`/
  `createGroup`/`deleteGroup`/`addGroupMember`/`removeGroupMember`.
- **`SmbShareApi`/`SmbSessionApi`/`NetUseApi`/`AccountsPolicyApi`**
  (nouvelles, remplacent le bloc `share`/`session`/`use`/`accounts` de
  l'ex-`NetExeApi`) : primitives d'état brutes sur les tables SMB/`net use`/
  politique de compte déjà instanciées sur `WindowsPC`.
- **`SchedulingApi`** (`schtasks`) : `isServiceRunning`/`list`/`create`/
  `delete`/`run` — `SchtasksCommand.ts` porte le dispatch `/query`/
  `/create`/`/delete`/`/run`/`/change`/`/end` et le format du tableau,
  auparavant dans `cmdSchtasks`.
- **`PrintApi`** (`print`) : `isSpoolerRunning`/`submit` — la file
  d'impression legacy (singleton module-level `QUEUES` par hostname dans
  `WinPrint.ts`, un design déjà fragile) devient un champ d'instance sur
  `WindowsPrintApi`, propre par équipement.
- **`AuditPolicyApi`** (`auditpol`) : `get`/`set` — `AuditpolCommand.ts`
  porte le parsing `/flag:"value"` et le dispatch `/get`/`/set`.
- **`WinRmApi`** (`winrm`) : `isEnabled`/`listeners`/`enable` —
  `WinrmCommand.ts` porte le dispatch `quickconfig`/`enumerate` et le
  texte figé.
- **`NetCommand`/`ScCommand`** n'importent plus AUCUNE fonction de
  `WinSc.ts`/`WinNetUser.ts`/`WinNetStart.ts`/`WinNetShare.ts`/
  `WinNetUse.ts`. Ces fichiers restent intacts et inchangés dans leur
  logique — ils servent maintenant EXCLUSIVEMENT le shim PowerShell
  synchrone (`WindowsPC.runSyncNativeCommand`), un consommateur séparé et
  légitime déjà établi (§ Phase 3), jamais retouché.

**Piège rencontré : `strictNullChecks: false` casse le narrowing sur union
discriminée.** `AccountMutationResult` a d'abord été modélisé en union
discriminée (`{ok:true} | {ok:false, error:string}`), comme on l'aurait
fait en TypeScript strict. Avec `strictNullChecks: false` (réglage du
projet, non modifié), `if (!result.ok) return result.error` échoue à la
compilation (« Property 'error' does not exist » — reproductible en
isolation, cf. `LinuxSshClient.ts`/`SshServerHandler.ts`, qui ont le même
bug préexistant sur `AccountLifecycleVerdict`, hors périmètre). Fix :
`AccountMutationResult` en interface plate `{ok: boolean; error?: string}`,
même forme que `ServiceOpResult`/`ServiceControlResult` qui n'avaient pas
le problème.

**Validation** : lot localisé de 30 fichiers (tout ce qui touche sc/net/
schtasks/print/auditpol/winrm/domain-join/winrm/kerberos/audit) comparé
au commit précédent (Phase 9, passthrough opaque) — **résultat rigoureusement
identique** (99 échecs / 906 réussites des deux côtés) : ce lot est une
correction architecturale pure, aucun changement de comportement observable.
Typecheck ciblé et ESLint propres. Smoke manuel non versionné confirmant
`sc query/qc`, `net user/localgroup/accounts/share`, `schtasks /create`+
`/query`, `auditpol /get`, `winrm quickconfig` avec des données réelles de
bout en bout.

## Windows — Phase 9 : `auditpol`, `winrm`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Contrairement aux phases précédentes, ces deux commandes étaient déjà
accessibles côté PowerShell (`runSyncNativeCommand`) mais jamais côté
`cmd.exe` — `winrm` a une couverture de test cmd conséquente
(`windows-server-winrm.test.ts`, `windows-server-domain-join.test.ts`,
`windows-domain-kerberos-migration.test.ts`, toutes déjà via
`executeCmdCommand('winrm quickconfig'/'enumerate'...)`), confirmant que
c'est bien la Phase 4 qui avait cassé le chemin cmd sans que personne ne
le remarque.

**`MachineApi.auditPolicy?: AuditPolicyApi`** et **`MachineApi.winRm?:
WinRmApi`** — même schéma `execute(argv)` que `SchedulingApi`/`PrintApi` :
`cmdAuditpol`/`cmdWinrm` ne prenaient déjà qu'un seul objet d'état
(`WindowsAuditPolicy`/`WindowsWinRmConfig`, déjà instanciés séparément sur
`WindowsPC`), donc aucun narrowing de contexte nécessaire cette fois — le
plus simple des ponts de cette série.

**Validation** : `windows-server-winrm.test.ts` (11/11), `windows-domain-
kerberos-migration.test.ts`, `journalization-and-audit.test.ts` — tous
verts. `windows-server-domain-join.test.ts` toujours à 10 échecs
`nltest`/`dcdiag`/`klist` (pré-existants, hors périmètre, inchangés).
Typecheck ciblé propre.

## Linux — Phase 1 : `chgrp`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Commande migrée** : `chgrp [-R] <groupe> <fichier...>` — dernière
commande du groupe permissions restée en legacy après la Phase 0
(`chown`/`chmod` étaient déjà migrés). Suit exactement le gabarit de
`ChownCommand` : résolution du groupe via `ctx.machine.groups.findByName`,
`-R` par descente récursive via `ctx.machine.fs.list`, audit
(`fsAccess('a','chgrp')`/`syscall('chgrp', path)`) après l'opération
réussie, jamais avant (§7.4 du framework).

**Bug trouvé et corrigé dans `FileSystemApi.chown()` (`LinuxMachineApi.ts`),
en migrant `chgrp`** : l'implémentation exigeait `root` inconditionnellement
dès que l'acteur n'était pas root, alors que le `chown`/`chgrp` legacy
(`LinuxPermCommands.ts`) autorise un utilisateur non-root à changer le
groupe d'un fichier qu'il possède vers un groupe dont il est membre (sans
jamais pouvoir changer le propriétaire). `chown()` compare maintenant
uid/gid demandés à l'inode courant : changement de propriétaire toujours
réservé à `root` ; changement de groupe seul autorisé si l'acteur possède
le fichier et appartient au groupe cible — reproduit exactement la règle
de `cmdChown`/`cmdChgrp`. Bénéficie à `ChownCommand` (déjà migré) autant
qu'au nouveau `ChgrpCommand`, sans ajouter de méthode : `FileSystemApi`
n'a pas changé de forme, donc aucun impact sur les autres implémentations
de `MachineApi` (Windows notamment, en cours de migration en parallèle
sur la même branche).

**Legacy supprimé** : `case 'chgrp':` et son import (`cmdChgrp`) retirés
de `LinuxCommandExecutor.dispatch()`. `cmdChgrp` lui-même reste dans
`LinuxPermCommands.ts` — toujours appelé par `commands/fs/Chgrp.ts`
(l'autre framework `LinuxCommand`, déjà noté comme chevauchement
pré-existant avec `chown`, §8 du framework — non déplacé ici, hors
périmètre de cette migration).

**Validation** : lot localisé — `perm-ownership-dac.test.ts`,
`linux-filesystem-and-IAM.test.ts` (81 tests, tous passants) plus le lot
audit/privilège du §7.2 (`auditctl.test.ts`, `auditctl-other.test.ts`,
`journalization.test.ts`, `journalization-and-audit.test.ts`,
`command-privilege-policy.test.ts` — 1155 tests, 1 échec pré-existant et
sans rapport confirmé par `git stash` : `journalization.test.ts` #161,
`logrotate`/`prerotate` échoue déjà identiquement hors de cette
migration). Typecheck et lint ciblés propres.

## Windows — Phase 8 : `reg`, `setx`, `start`, `nbtstat`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Quatre commandes de plus, toutes mortes des deux côtés (wrapper privé
`WindowsPC.cmdX` jamais appelé) depuis la Phase 4.

**`MachineApi.registry?: RegistryApi`** — contrairement à `NetExeApi`/
`ServiceManagementApi`/`SchedulingApi`/`PrintApi`, PAS une passerelle
opaque : `WinRegistryProvider` (déjà utilisé par le provider PowerShell
`Registry::`, donc déjà partagé entre `reg.exe` et `Get-ItemProperty`)
était déjà une interface étroite et déjà généraliste (7 primitives :
`testPath`/`newItem`/`setItemProperty`/`removeItemProperty`/`removeItem`/
`getItemPropertyValues`/`listSubkeyNames`) — copiée telle quelle dans
`machine/types.ts` sous le nom `RegistryApi`. `RegCommand.execute()` reste
un simple appel à `cmdReg(ctx.machine.registry, args)` : `cmdReg` ne
touche plus aucun objet legacy brut, seulement cette interface déjà
abstraite — legitimate, contrairement au `.native` de la Phase 5.

`setx`/`nbtstat` réimplémentées entièrement inline (`ctx.session.env`,
`ctx.machine.hostname`) — aucune extension nécessaire, même pattern que
`Findstr`/`Copy`/`Dir`.

`start` réimplémentée sur `ctx.machine.proc.spawn()` (primitive déjà
générique) — **simplification assumée** : le legacy `cmdStart` attachait
le processus à la session Console (parent `explorer.exe`, `sessionId: 1`,
propriétaire l'utilisateur courant) ; `ProcessApi.spawn()` ne porte pas ces
paramètres (généraliste, partagé avec Linux) et aucun test ne couvre `start`
côté cmd (`grep` vérifié) — étendre l'interface partagée pour un besoin
non testé n'aurait fait qu'ajouter de la surface non validée. Documenté ici
plutôt que laissé silencieux.

**Nettoyage** : `cmdStart`/`cmdSetx`/`cmdNbtstat`/`cmdWmic` (un second
doublon mort, différent du `WmicCommand` migré en Phase 3) supprimés de
`WinSystemCommands.ts` — confirmés sans autre appelant.

**Validation** : `windows-server-identity.test.ts` (`reg query`, jusque-là
non inclus dans le lot localisé) + smoke manuel non versionné pour
`setx`/`start`/`nbtstat` (aucun test existant ne les couvre). Lot complet
comparé au commit précédent — 101 échecs / 808 réussites → 100 échecs / 813
réussites, zéro régression. Typecheck ciblé propre.

## Linux — Phase 0 : câblage universel du `CommandRegistry` + conversion async

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Le problème que cette phase résout** : `tryCommandKernel()` ne routait
vers `command-kernel` que les lignes top-level qui se réduisent
entièrement à une commande simple/pipeline. Une commande déjà migrée
(`ls`, `grep`, `chown`…) invoquée à l'intérieur d'une boucle, d'une
fonction, d'une condition ou après une substitution de commande
retombait sur le `switch` legacy de `LinuxCommandExecutor.dispatch()` —
qui restait donc nécessaire, contredisant la règle « supprime toujours
le legacy dès qu'une commande est migrée ». Supprimer ces `case` sans
combler ce trou aurait cassé toute commande migrée utilisée hors du cas
top-level.

**Câblage universel** : `LinuxCommandExecutor._commandKernelHook` (miroir
de `_registryCommandHook`/`_registryPrivilegeHook`) est maintenant
consulté dans `dispatchMaybeNetwork()` — le point d'injection unique déjà
partagé par `tryCommandKernel()`, l'interpréteur bash (`ExternalCommandFn`)
et l'exécution de scripts — **avant** le repli réseau et avant
`dispatch()`. `LinuxMachine` le câble vers son propre `Interpreter`
(`runCommandKernelResolved`) ; pour les ~40 tests qui instancient
`LinuxCommandExecutor` seul (sans `LinuxMachine` autour), un
`getDefaultCommandKernelShell()`/`runDefaultCommandKernelResolved()`
autonome (construit sur le `vfs`/`userMgr`/`processMgr` propres de
l'exécuteur) sert de repli — les commandes migrées n'ont plus d'autre
implémentation vers laquelle se replier, ce filet doit donc toujours
pouvoir les atteindre.

**Conséquence directe** : les `case` legacy des 21 commandes déjà
migrées (`touch, ls, cat, cp, mv, rm, mkdir, rmdir, ln, grep, head, tail,
wc, sort, cut, uniq, tr, chmod, chown, stat, id, whoami, groups`) sont
supprimés de `dispatch()`, ainsi que les fonctions `cmdXxx` mortes dans
`LinuxFileCommands.ts`/`LinuxTextCommands.ts`/`LinuxUserCommands.ts`/
`LinuxPermCommands.ts`. `chgrp`, `egrep`/`fgrep`/`rgrep`, `awk`, `sed`,
`pwd`, `echo`, `cd` restent en legacy (non migrés/builtins bash) — leur
présence continue de marquer, par construction, ce qui reste à faire.

**Conversion async en cascade** : le hook `command-kernel` étant
lui-même `Promise`-based de bout en bout, `LinuxCommandExecutor.execute`/
`dispatch`/`dispatchFromInterpreter`/`dispatchMaybeNetwork` (et toute
leur descendance — jobs d'arrière-plan, `CronEngine`, `run-parts`, `sh -c`,
`su`, `time`/`watch`) sont passés async ; `LinuxMachine.executeShellCommandSync`/
`runSshCommandSync`/`runCommandFrameInSession`/`cronTick` suivent (noms
`Sync` conservés pour compat historique — le sens réel est désormais
« async de bout en bout », documenté en commentaire). Le pont SSH
exec-mode (`SshExecTarget.runSshCommandSync`, 5 classes de device :
`LinuxMachine`, `WindowsPC`, `Router`, `CiscoRouter`, `HuaweiRouter`) et
le client SSH (`LinuxSshClient`) suivent la même conversion.

**Deux frontières synchrones préservées, documentées et volontairement
non cascadées** : le moteur PL/SQL d'Oracle (`IPackageRoutine.invoke():
string | null`, `OracleExecutor` — 4282 lignes) et `SqlPlusSubShell.create`
(invoqué depuis le **constructeur** de `SqlPlusShell` — un constructeur
JS ne peut pas être `async`, point final) ; et l'architecture
`CommandAction`/`CommandTrie` de Cisco/Huawei. Plutôt que de cascader la
conversion async dans ces deux sous-systèmes entiers (hors périmètre de
cette migration), deux ponts étroits et explicitement documentés :
`LinuxCommandExecutor.runOracleHostCommandSync()` (whoami/hostname/pwd/
id/ls/cat/find/mkdir/rm/echo/groupadd/useradd/usermod, purement
synchrone contre le `vfs`) pour Oracle, et le pattern `_pendingAsync`
déjà existant (`CiscoShellBase`/`HuaweiVRPShell`, déjà utilisé par
`ping`/`traceroute`) réutilisé pour `runOutboundSshClient` côté
Cisco/Huawei.

**Trois gaps réels mis au jour par ce câblage** (masqués jusqu'ici parce
que ces commandes n'étaient, avant cette phase, jamais réellement
atteintes par les tests à exécuteur autonome — elles retombaient sur le
`switch` legacy encore présent) :
- `command-kernel/commands/Tail.ts` : `-c`/octets, `-v`/`-q`, en-têtes
  multi-fichiers `==> fichier <==` manquants — réécrit en réutilisant
  `sliceTail`/`tailHeader` du legacy `coreutils/TailCommand.ts` (toujours
  utilisé par le suivi `-f` de l'UI, non supprimé).
- `command-kernel/commands/Grep.ts` : migration très partielle (`-i -v
  -n -c -E` seulement) — réécrit à parité avec le legacy `cmdGrep`
  (`-w -x -F -o -q -s -r -l -L -h -H -m -e -f --include --exclude`
  + contexte `-A/-B/-C` + `-P`), avec parsing manuel de `rawArgv` (les
  motifs `-e` répétés et le mélange motif/fichiers positionnels ne
  passent pas par le parseur déclaratif d'options).
- `command-kernel/commands/Chown.ts` : `-R`/`--recursive` absent —
  ajouté (descente récursive via `machine.fs.list`).

**Régression corrigée** : `sudo <commande migrée>` ne retrouvait plus la
commande une fois son `case` legacy supprimé — `dispatchFromInterpreter`
dépile `sudo` et élève l'utilisateur courant, puis appelait `dispatch()`
directement sans revérifier le hook `command-kernel` pour la commande
démasquée. Le hook est maintenant reconsulté après élévation, sous le
contexte utilisateur déjà élevé.

**Bug additionnel corrigé (indépendant de cette phase)** : `command-kernel`'s
`runOracleHostFind`'s récursion de répertoire suivait les entrées `.`/`..`
renvoyées par `listDirectory`, provoquant un débordement de pile —
corrigé en les ignorant.

**Process substitution `>(...)`/`<(...)` dans `src/bash/`** : les deux
matérialisaient leur commande via `BashInterpreter.executeSubcommand()`,
qui force un driver **synchrone** (`driveSync`) — celui-ci refuse
désormais tout retour `Promise` (« cannot run an asynchronous command in
a synchronous shell »), puisque toute commande externe est maintenant
async. `materializeProcSubs`/`materializeWord`/`flushOutSubs` sont
devenues des méthodes génératrices (`materializeProcSubsG`/
`materializeWordG`/`flushOutSubsG`) qui `yield*` dans la même chaîne
d'effets que le reste de l'interpréteur, participant correctement au
driver (sync ou async) réellement actif au lieu d'en forcer un.

**Validation** : lot localisé élargi (84 fichiers, ~1525 tests dont les
suites Oracle complètes — 135 fichiers, 3088 tests) — 4 échecs
résiduels, tous confirmés pré-existants et sans rapport via comparaison
`git stash` (méthode §7.2) : les 3 gaps déjà documentés de
`run-parts.test.ts` (fonctions/`if-else`/`sh` alternatif, hors périmètre
command-kernel) et un gap déjà présent avant cette phase dans
`cross-equipment-ssh-suite.test.ts` §9 (alias de fonction shell).

## Windows — Phase 7 : `schtasks`, `print`, correction de `MachineApi.now()`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

Même classe de régression Phase 4 que `net` : `schtasks` n'était dispatché
nulle part côté `cmd.exe` (le wrapper privé `WindowsPC.cmdSchtasks` existait
mais n'était appelé par rien, ni côté cmd ni côté shim PowerShell — mort des
deux côtés) ; `print` n'avait jamais eu le moindre point d'entrée.

**`MachineApi.scheduling?: SchedulingApi`** et **`MachineApi.printing?:
PrintApi`** (chacune une méthode `execute(argv)`) — même raisonnement
documenté que `NetExeApi`/`ServiceManagementApi`. `cmdSchtasks`/`cmdPrint`
narrowés de `WinSystemContext`/`WinCommandContext` (les gros contextes
système/réseau) à `Pick<>` portant seulement ce qu'ils lisent réellement
(`isServiceRunning`+`processManager`+`scheduledTasks`+`now` pour l'un,
`hostname`+`isServiceRunning` pour l'autre) — même technique que
`NetShareContext`/`NetUseContext` en Phase 6, pour ne jamais tirer toute la
pile réseau dans `MachineApi` pour un besoin aussi étroit.

**Bug trouvé en implémentant `scheduling`** : `WindowsMachineApi.now()`
retournait `new Date()` (horloge murale réelle) au lieu de l'horloge
simulée de l'équipement — un `WindowsPC.advanceTime()` n'avait donc aucun
effet sur ce que `ctx.machine.now()` répondait. Latent depuis la Phase 3
(`date`/`time`, déjà migrées, lisaient déjà silencieusement la mauvaise
horloge — juste jamais testé après un `advanceTime()`). Fix : nouveau
`WindowsMachineApiDeps.now(): Date`, câblé sur `this.simulatedDate()` côté
`WindowsPC`, consommé par `WindowsMachineApi.now()` — corrige `date`/`time`
en plus de rendre `schtasks /create` + `advanceTime()` cohérents.

**Validation** : lot localisé (les 22 fichiers de la Phase 6, `date`/`time`
et `windows-scheduled-tasks` inclus pour couvrir le fix `now()`) comparé au
commit précédent — 111 échecs / 798 réussites → 101 échecs / 808 réussites,
**10 tests corrigés (les 6 `windows-scheduled-tasks` + les 4 `schtasks`/
`print` de `windows-phase-g`), zéro régression**. Typecheck ciblé propre.

**Hors périmètre, repéré en passant** : `runas` — même gap Phase-4, commande
distincte, laissée pour un prochain lot.

## Windows — Phase 6 : `net` (user/localgroup/start/stop/share/session/use/accounts)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

`net` n'était migré nulle part côté `cmd.exe` — le pont `runSyncNativeCommand`
(shim synchrone dédié à PowerShell, jamais touché) gère bien `net user`/
`net localgroup`/`net start`/`net stop`/`net share`/`net session`, mais
`executeCmdCommand('net ...')` tombait systématiquement sur « not
recognized » depuis la Phase 4 (cutover complet, régression jamais détectée
faute d'être dans le lot de tests localisé de l'époque). `net use` et
`net accounts` étaient morts des DEUX côtés : `cmdNetUse` n'était appelé
nulle part (import de type seulement), et `net accounts` n'avait jamais eu
de fonction `cmdNetAccounts` — seul l'état (`WindowsAccountsPolicy`) existait.

**`MachineApi.netExe?: NetExeApi`** (méthode unique `execute(argv, caller)`)
— même raisonnement documenté que `ServiceManagementApi`/`sc` (§3.4 règle 2) :
`net.exe` a ~8 sous-commandes au format figé, chacune couplée à un
sous-système vendeur distinct (SAM, SCM, table de partages SMB, table
`net use`, politique de compte LSA) ; décomposer en primitives génériques
réimplémenterait son dispatcher sans bénéfice pour un autre vendeur.
`NetCommand.execute()` ne fait que transmettre l'argv déjà tokenisé ;
`WindowsNetExeApi` (dans `WindowsMachineApi.ts`) reste seule responsable de
l'interprétation — elle réutilise `cmdNetUser`/`cmdNetLocalgroup`/
`cmdNetStart`/`cmdNetStop`/`cmdNetShare`/`cmdNetUse` en interne (légitime :
exécuté depuis le pont, jamais depuis une commande), et implémente `net
session`/`net accounts` directement (respectivement portés depuis l'ancienne
méthode privée `WindowsPC.cmdNetSession`, et écrits pour la première fois
contre `WindowsAccountsPolicy.render()`/`.apply()`, déjà correcte et déjà
consultée par `WindowsUserManager` pour la politique de mot de passe réelle).

**`cmdNetShare`/`cmdNetUse` découplés du `WinCommandContext` géant** —
signatures réduites à `Pick<WinCommandContext, ...>` (`NetShareContext`,
`NetUseContext`) portant seulement les 2 et 4 champs réellement utilisés
(`isServiceRunning`+`smbShares`, `isServiceRunning`+`netUseTable`+
`resolveHostname`+`dialSmbShare`) — évite de tirer toute la pile réseau
(netsh/ipconfig/dhcp/dns, explicitement hors périmètre) dans `MachineApi`
juste pour ces deux sous-commandes. `requireWindowsService`/
`requireWindowsServices` (`WinFeatureGate.ts`) narrowés de la même façon
(`ServiceGateContext = Pick<WinCommandContext, 'isServiceRunning'>`), pour
rester réutilisables par ces deux contextes réduits sans dupliquer à la
main le texte exact des refus de service (piège trouvé en écrivant cette
phase : une première tentative de recopier `The Workstation service has
not been started...` à la main s'est trompée de message — `LanmanWorkstation`
a un texte dédié dans `WinFeatureGate.ts` que je n'avais pas vérifié).

**Validation** : lot localisé de 22 fichiers (les 16 de la Phase 5 +
`windows-phase-g`, `windows-password-policy`, `windows-server-smb`,
`windows-smb-cmdlets`, `cross-equipment-ssh-suite`,
`password-policy-ssh-scp-sftp-coherence`) comparé au commit précédent —
baseline 189 échecs / 720 réussites → après ce lot, 111 échecs / 798
réussites — **78 tests corrigés, zéro régression** (échecs restants tous
préexistants et hors périmètre : `nltest`/`dcdiag`/`klist`, `schtasks`,
`print`). Typecheck ciblé propre.

**Hors périmètre, repéré en passant** : `schtasks`, `print` — mêmes gaps
Phase-4 que `net`, mais familles de commandes distinctes ; laissées pour un
prochain lot plutôt que d'élargir celui-ci au-delà de `net`.

## Windows — Phase 5 : whoami/icacls/attrib/find/sort/more/fc/xcopy/where/doskey, suppression de l'échappatoire `.native`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Correction architecturale majeure, sur retour explicite de l'utilisateur** :
les commandes migrées de cette phase (et plusieurs déjà livrées en Phase 3 —
`tasklist`, `taskkill`, `sc`, `netstat`) appelaient depuis `execute()` des
fonctions autonomes du projet (`cmdWhoami`, `cmdFind`, `cmdSort`, `cmdTasklist`,
etc., dans `WinWhoami.ts`/`WinFileCommands.ts`/`WinTasklist.ts`/...) en leur
passant l'objet legacy réel récupéré via un champ `native: unknown` posé sur
`MachineApi` (`fs.native`, `proc.native`, `users.native`, `servicesNative`,
`domainSessionNative`, `doskeyNative`). C'est une violation du principe
directeur §0.1 du framework (« une commande ne touche jamais l'implémentation
réelle d'un équipement, elle ne connaît que `ctx.machine: MachineApi` ») :
le `.native` déguisait un contournement complet de la façade sous une
signature typée. Fix : suppression de TOUS les champs `.native`/`*Native` du
contrat `MachineApi`, remplacés par des capacités décomposées et documentées
(§3.4) :

- `FileSystemApi.getAcl?`/`grantAcl?`/`removeAcl?` (ACL NTFS, `icacls`) et
  `getAttributes?`/`setAttributes?` (attributs NTFS, `attrib`) — nouveaux
  types `AclEntry`/`FileAttributes`.
- `ProcessInfo` enrichi (`ownerName`, `sessionName`/`sessionNumber`,
  `memoryKib`, `cpuSeconds`, `status`, `windowTitle`, `hostedServices`,
  `critical`, `systemOwned`) + `ProcessApi.descendants?()` — `tasklist`/
  `taskkill` reconstruisent tout leur formatage (TABLE/CSV/LIST, filtres
  `/FI`, arbre `/T`, vérification `critical`/`systemOwned`) en local, à
  partir de cette seule donnée typée.
- `NetworkApi.connections?()` (nouveau type `SocketInfo`) pour `netstat`.
- `UserManagementApi.securityIdentity?()` (nouveaux types `SecurityIdentity`/
  `SecurityGroupMembership`/`SecurityPrivilege`) pour `whoami` — résout SID,
  groupes et privilèges, session de domaine active incluse, entièrement côté
  pont `WindowsMachineApi`.
- `MachineApi.services?: ServiceManagementApi` (méthode unique
  `execute(argv, {isAdmin, userName})`) pour `sc` — exception documentée
  (§3.4 règle 2) : `sc.exe` a ~14 sous-commandes au format figé et
  intimement lié au modèle SCM réel (SDDL, actions de reprise sur panne) ;
  décomposer en primitives génériques aurait dupliqué ce formatage sans
  bénéfice. `ScCommand.execute()` ne fait plus que transmettre l'argv déjà
  tokenisé ; l'implémentation vendeur (`WindowsServiceManagementApi`, dans
  `WindowsMachineApi.ts`) reste seule responsable d'interpréter et
  formatter — elle réutilise `cmdSc()`/`WinSc.ts` en interne (légitime : ce
  code s'exécute maintenant DANS le pont, jamais depuis une commande).
- `MachineApi.macros?: MacroApi` pour `doskey`.

`find`/`sort`/`more`/`fc`/`xcopy`/`where` n'avaient besoin d'aucune extension
— entièrement réimplémentées avec les primitives déjà existantes de
`FileSystemApi` (`readFile`/`list`/`stat`/`exists`/`copy`/`mkdir`/`resolve`),
suivant exactement le pattern déjà correct de `Findstr.ts`/`Copy.ts`/
`Dir.ts` (jamais retouchées, elles n'avaient jamais eu ce problème).

**Nettoyage legacy consécutif** — `migration puis suppression` (§ directive
utilisateur) : `WinFileCommands.ts`, `WinDir.ts`, `WinIcacls.ts`,
`WinWhoami.ts`, `WinTasklist.ts`, `WinTaskkill.ts` supprimés en entier
(vérifié explicitement sans autre appelant que les commandes migrées
elles-mêmes, y compris le pont PowerShell `runSyncNativeCommand` qui ne les
utilisait pas) — net −18 fichiers/fonctions de maçonnerie legacy, dont un
`cmdTasklist` mort dans `WinFileCommands.ts` qui renvoyait une liste de
processus **entièrement codée en dur** (contraire à la règle « pas de valeur
figée », jamais appelé nulle part).

**Bug trouvé en écrivant `MacroApi`** : `WindowsMachineApiDeps.domainSession`
était une VALEUR figée au premier appel de `getCommandKernelShell()`
(construction paresseuse, une seule fois par `WindowsPC`) — une connexion de
domaine établie APRÈS le premier appel `cmd` restait invisible à `whoami`.
Fix : remplacé par `getDomainSession(): DomainSession | null`, un accesseur
live, cohérent avec `isDHCPConfigured`/`bootedAt` déjà câblés en closures.

**Nouvelles commandes** (toutes suivent le patron `BaseCommand` établi,
n'appellent que `ctx.machine.*`) : `whoami` (`/user`, `/groups`, `/priv`,
`/all`), `icacls` (affichage + `/grant`, `/deny`, `/remove`, gate
`ctx.session.user.isRoot()`), `attrib` (`+r/-r/+a/-a/+h/-h/+s/-s`), `find`,
`sort`, `more` (fidélité : lit `stdin` en pipeline quand aucun fichier n'est
donné, comme `findstr` — legacy renvoyait `''`), `fc`, `xcopy` (`/s`, `/e`,
récursif via `fs.list`/`fs.mkdir`/`fs.copy`), `where`, `doskey`.

**Validation** : lot localisé de 16 fichiers (`windows-access-cmd`,
`windows-access-powershell`, `windows-file-management`, `windows-filesystem`,
`windows-filesystem-tree`, `windows-drive-switching`, `windows-ps-cmd-coherence`,
`windows-consistency`, `basic-commandes`, `env-vars`, `windows-services-cmd`,
`windows-services-powershell`, `windows-services-processes-comprehensive`,
`windows-netstat-stream-ui`, `windows-scheduled-tasks`,
`windows-server-domain-join`) comparé au commit précédent (`git stash`) :
baseline 170 échecs / 449 réussites → après ce lot, 127 échecs / 492
réussites — **43 tests corrigés, zéro régression** (les échecs restants sont
tous préexistants et hors périmètre : `net start`/`net stop`, `nltest`/
`dcdiag`/`klist`/`schtasks`, `ipconfig`/`Test-Connection` PS-vs-CMD — aucune
commande touchée par cette phase). Typecheck ciblé
(`command-kernel|WindowsPC|windows/`) propre.

**Hors périmètre, repéré en passant** : `netstat -a`/`dir -a` (et plus
généralement tout switch à un seul tiret sur une commande Windows migrée)
lève `option inconnue` — `ArgumentParser` n'a pas de mode
`lenientOptions: true` activé pour ces commandes (seul `EchoCommand` l'a).
Préexistant à cette phase (reproduit identique sur `dir -a` avant tout
changement) — pas corrigé ici pour rester dans le périmètre de la demande.

## Windows — Phase 4 : porte d'entrée unique, `CmdInterpreter` dédié, suppression du parsing legacy

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Sur retour explicite de l'utilisateur : trop de « maçonnerie » autour du
pont — `executeCmdCommand` gardait son propre découpage de chaînage
(`splitCmdChain`), de pipes (`executePipedCommand`), de redirections
(`handleRedirect`) et d'expansion `%VAR%`/tokenisation
(`expandEnvVars`/`parseCommandLine`) EN PARALLÈLE du nouveau
`Lexer`→`Parser`→`Executor`, qui sait pourtant déjà tout faire ça. Cette
phase supprime cette duplication : `executeCmdCommand` ne fait plus que
deux étapes qui ne sont PAS exprimables par la grammaire (dépouillement
`2>&1`, expansion des macros doskey — un remplacement de texte brut,
avant tout tokenizing, comme le vrai cmd.exe), puis un unique appel à
`runCommandKernel()`, qui parse une fois et exécute tout l'AST — chaîne,
pipeline ou redirection compris — en un seul passage par `Executor`.

**`CmdInterpreter` (nouveau, dédié Windows)** — remplace la
paramétrisation générique de l'`Interpreter` bash de la Phase 2 (retour
en arrière sur ce point précis, sur demande explicite : « crée un lexer,
tokenizer, parser, interpreter spécialement pour Windows, c'est plus
simple »). `src/command-kernel/interpreter.ts` redevient la classe simple
d'origine, sans option d'injection — le moteur partagé ne change plus du
tout pour un nouvel équipement, conformément au §0/§4 du framework.
`Executor` garde son `expander`/`globExpand` injectables (nécessaires :
Windows construit son propre `Executor` directement, sans passer par
`Interpreter`), c'est la seule extension qui reste sur le socle partagé.
`CmdInterpreter` vit entièrement dans `windows/command-kernel/` et
assemble `CmdLexer` + `Parser` (partagé, inchangé) + `CmdExpander` + un
`globExpand` no-op.

**Bug trouvé en unifiant — code de sortie fictif** : les commandes
migrées de la Phase 1/3 renvoyaient toujours `EXIT_OK` même sur un échec
« doux » (chemin introuvable, fichier déjà existant...), parce que
l'ancien `splitCmdChain` décidait `&&`/`||` en scannant le TEXTE de
sortie (`cmdOutputIsError`), pas un vrai code de sortie. En unifiant sur
le AND/OR natif d'`Executor` (qui regarde le VRAI code de sortie), ce
raccourci serait devenu un bug silencieux (`cd C:\Inexistant && echo
ne-devrait-pas-s'afficher` aurait affiché le echo). Fix : chaque retour
d'erreur « douce » dans les 10 commandes concernées (`cd`, `mkdir`,
`rmdir`, `type`, `copy`, `move`, `ren`, `del`, `set`, `dir`, plus le
helper partagé `reportLegacyFsError`) renvoie maintenant `1`, comme le
vrai `%ERRORLEVEL%` de cmd.exe.

**Bug trouvé en unifiant — noms de commande sensibles à la casse** :
`CommandRegistry`/`Parser` sont délibérément insensibles à rien (corrects
pour bash, où `LS` ≠ `ls`) — mais cmd.exe EST insensible à la casse pour
les noms de commande (`DIR`, `Dir`, `dir` identiques), pas pour les
arguments (`echo Hello` doit garder sa casse). Nouveau
`lowercaseCommandNames()` (`windows/command-kernel/ast/
lowercaseCommandNames.ts`) parcourt l'AST une fois après le parsing et ne
touche qu'aux positions de nom de commande, jamais aux `argv`.

**`findstr` migré** — nécessaire pour supprimer `executePipedCommand`
sans régression : `dir | findstr Alpha` passait par un filtre ad hoc
séparé (jamais par une vraie commande enregistrée). Nouvelle
`FindstrCommand`, lit les fichiers passés en argument OU l'entrée
standard si aucun n'est donné (contrairement à l'ancien `cmdFindstr`
legacy qui exigeait toujours un fichier — un vrai gap face au findstr.exe
réel, corrigé au passage), flags `/i` `/v` `/n` `/c` `/c:"…"`, motifs
multi-mots en OR. Les filtres `find`/`grep`/`more` de l'ancien pipe ad hoc
sont abandonnés sans remplacement : aucun test ne les exerçait côté cmd
(`grep` n'existe même pas sur un vrai cmd.exe).

**Supprimé** : `splitCmdChain`, `cmdOutputIsError`, `executePipedCommand`,
`handleRedirect`, `parseCommandLine`, `expandEnvVars`,
`parseFindstrFilter` — ~230 lignes nettes en moins sur `WindowsPC.ts`
malgré les ajouts (`CmdInterpreter`, `lowercaseCommandNames`,
`FindstrCommand`). `tryUncFileCommand` (SMB réel, pas une commande) et le
changement de lecteur nu (`D:`) restent des cas spéciaux avant le
dispatch — ce ne sont pas des commandes au sens de la grammaire, rien
dans l'AST ne les représenterait proprement.

**Validation** : lot localisé (8 fichiers) — 143/144, identique à la
Phase 3 (même échec restant : `netsh`, hors périmètre). `cmd-bat-execution.
test.ts` (exécution `.bat`, chemin non touché par cette phase) — 12/12.
`cmd-missing-builtins.test.ts` — mêmes 9 échecs préexistants (`net`,
`start`, `setx`, `schtasks`, `nbtstat`, `reg` — hors périmètre documenté),
aucune régression. Typecheck ciblé propre.

## Windows — Phase 3 : `dir` + commandes système (13 commandes), zéro donnée figée

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Suite de la Phase 2, sur demande explicite de continuer la migration
jusqu'à couverture complète. Périmètre : `dir`, `ver`, `hostname`, `vol`,
`chcp`, `date`, `time`, `systeminfo`, `tasklist`, `taskkill`, `netstat`,
`sc`/`sc.exe`, `wmic`.

**Principe appliqué partout dans cette phase, sur retour explicite de
l'utilisateur : aucune valeur figée, uniquement des données réelles de
CET équipement** :

- `ver` — la Phase 1 avait copié `'10.0.22631.6649'` en dur dans le
  nouveau fichier, une DEUXIÈME copie du `WindowsPC.VER_STRING` déjà
  utilisé par `runSyncNativeCommand` (le shim PowerShell). Corrigé :
  extraction en constante partagée unique
  (`windows/WindowsVersion.ts::WIN_VER_STRING`), important pour la
  cohérence cmd/PowerShell (`cmd-ps-coherence.test.ts`) — les DEUX chemins
  lisent maintenant la même source, pas deux copies qui peuvent diverger.
- `dir`, `vol`, `wmic logicaldisk` — numéro de série et espace libre réels
  via `WindowsFileSystem.getVolumeSerialNumber()`/`getFreeDiskSpace()`
  (nouvelle capacité optionnelle `FileSystemApi.volumeInfo()`), jamais une
  valeur constante.
- `ver`(profil futur)/`systeminfo`/`wmic os get caption`/`wmic cpu get
  name` — nouvelle capacité optionnelle `MachineApi.os`/`hardware` sourcée
  de `EndHost.getIdentity()`/`this.hardware` (`HardwareProfile.
  defaultFor()`), déjà différenciés par type d'équipement (station de
  travail vs serveur) — jamais une chaîne unique pour tous les WindowsPC.
- `tasklist`/`taskkill`/`sc`/`netstat` — plutôt que de réimplémenter ces
  rendus complexes (filtres, formats CSV/LIST/TABLE, ACL de service...),
  les commandes migrées appellent DIRECTEMENT les fonctions pures legacy
  déjà existantes (`WinTasklist.cmdTasklist`, `WinTaskkill.cmdTaskkill`,
  `WinSc.cmdSc`, `WinFileCommands.cmdNetstat`) via une nouvelle
  échappatoire vendeur `ProcessApi.native`/`NetworkApi.native`/
  `MachineApi.servicesNative` (type `unknown`, cast par la commande) qui
  expose l'objet réel (`WindowsProcessManager`, `SocketTable`,
  `WindowsServiceManager`) — mêmes données, même fonction de rendu, donc
  zéro divergence possible avec `runSyncNativeCommand` (le shim
  PowerShell natif, qui appelle ces mêmes fonctions).

**Bug trouvé en migrant `dir`/`del *.tmp`** : `Executor.runSimple`
appliquait automatiquement le glob POSIX partagé (`expandGlob`, séparateur
`/`, sémantique bash) à chaque mot avant même que la commande migrée ne
le voie — `del *.tmp` recevait donc déjà des noms de fichiers résolus
(mal, avec des chemins complets à cause du mélange `/`/`\`) au lieu du
motif littéral que chaque commande cmd doit gérer elle-même (`del` ne
matche que dans `cwd`, non récursif ; `dir /s` récursif ; sémantiques
différentes par commande). Fix : `Executor`/`Interpreter` acceptent
maintenant un `GlobExpander` injectable (même principe que `Lexer`/
`Expander`), `createWindowsHostShell` passe un no-op (`async (w) => [w]`)
— chaque commande Windows fait son propre matching via
`ctx.machine.fs.list()`, comme legacy.

**`dir` — portée** : formats basique/large (`/w`)/récursif (`/s`)/bare
(`/b`)/wildcard/fichier unique, en-tête volume + espace libre réels.
Les flags `/a`/`/o` sont acceptés en no-op (comme legacy — le simulateur
ne modélise pas les dates par attribut).

**Hors périmètre, conservé pour une phase dédiée "réseau"** : `netsh`
(3180 lignes, dizaines de sous-domaines — interface ip, firewall,
advfirewall, portproxy, wlan, dhcpclient — nécessite une extension
substantielle de `MachineApi.net` avant migration, pas une commande
isolée), `ipconfig`, `ping`, `route`, `arp`, `getmac`, `tracert`,
`nslookup`, `ssh`/`sftp`/`scp`/`telnet`, `net` (sous-commandes). `netstat
-r` (table de routage) dégrade gracieusement (chaîne vide) faute du
contexte réseau complet — sera couvert par la même phase réseau.

**Validation** : lot localisé (8 fichiers) — 143/144, seul restant :
`netsh` (hors périmètre ci-dessus, échoue explicitement). Typecheck ciblé
propre.

## Windows — Phase 2 : vrai `Lexer`/`Parser` cmd.exe, pont réécrit sur `Interpreter`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Suite directe de la Phase 1, sur retour explicite de l'utilisateur : la
Phase 1 construisait un `SimpleCommandNode` à la main à partir d'un
`(cmd, args)` déjà découpé par `WindowsPC` — ça marchait, mais ce n'était
pas aligné avec le framework (pas de vraie porte d'entrée `Interpreter`)
et ne posait aucune fondation pour exécuter un jour de vrais scripts
`.bat`. Cette phase corrige les deux.

**Extension du socle partagé (`src/command-kernel/`), rétrocompatible** :
`Executor` et `Interpreter` acceptaient un `Lexer`/`Parser`/`Expander`
bash codés en dur ; ils prennent maintenant des paramètres optionnels
(`IExpander`, `ITokenizer`) avec les classes bash comme valeur par
défaut — zéro changement de comportement pour Linux (vérifié : aucune
régression sur le lot déjà validé). C'est la seule modification apportée
au moteur partagé ; `CommandRegistry`/`PermissionGuard`/`ArgumentParser`
restent strictement inchangés.

**`CmdLexer` (nouveau, Windows)** : tokenizer dédié à la grammaire
cmd.exe — guillemets doubles qui basculent et se suppriment sans
échappement (règles reprises telles quelles de `splitCmdArgs`/
`WindowsPC.parseCommandLine`, seule référence déjà validée par la suite
de tests, jamais réinventées), pas de guillemets simples spéciaux
(`echo 'x'` doit garder les apostrophes littérales), `&` seul émis comme
`TokenType.SEMI` (séquence inconditionnelle — même sémantique que le `;`
bash), `#` jamais traité comme un commentaire. Le `Parser` partagé
(`ast/parser.ts`) est réutilisé **sans aucune modification** : il ne
dépend que du flux de tokens, jamais de la syntaxe bash en dur — seule
divergence connue et acceptée : son détecteur d'assignation `VAR=valeur`
(bash) s'appliquerait aussi à une ligne cmd qui ressemblerait par hasard
à `X=1` en position de commande (cas non testé, cmd.exe n'a pas cette
notion — la traiterait comme une commande introuvable).

**`CmdExpander` (nouveau, Windows)** : reproduit exactement
`WindowsPC.expandEnvVars` (`%VAR%`, recherche insensible à la casse en
majuscules, `%CD%` résolu vers le cwd vivant, variable non définie
laissée intacte plutôt qu'effacée). Pas de `$`, pas de `~`, pas de glob
générique — cmd n'a aucun des trois.

**Pont réécrit** : `WindowsPC.tryCommandKernelCmd()` remplace
`runCommandKernelCmd()` et suit maintenant EXACTEMENT la structure de
`LinuxMachine.tryCommandKernel()` (§6 du framework) — parse en pré-vol
avec `CmdLexer`+`Parser`, refus de router (retour `null`, pas un échec)
si erreur de parsing / AST pas réductible à `command`/`pipeline` / une
commande du pipeline non enregistrée ; une fois routé, aucun repli, une
`ShellError` remonte telle quelle. `createWindowsHostShell` expose
maintenant un vrai `Interpreter` (au lieu du couple `{registry, executor}`
brut de la Phase 1).

**Portée actuelle de ce pont, honnêtement documentée** : `WindowsPC.
executeCmdCommand` continue de découper lui-même le chaînage (`&&`/`||`/
`&`) et les pipes (`|`) AVANT d'atteindre le pont — chaque segment simple
est donc ce qui arrive au `Interpreter`, jamais une ligne composite. Le
`Parser`/`Executor` savent déjà traiter `pipeline`/`and`/`or`/`sequence`
en un seul appel (utile dès qu'on voudra exécuter une ligne composite ou
un script multi-lignes sans repasser par le découpage `WindowsPC`), mais
ce chemin n'est pas encore exercé par l'intégration actuelle — fondation
posée, pas encore branchée. `CmdSubShell.executeBat()` (exécution des
`.bat`) n'est PAS touché dans cette phase : les scripts batch réels
utilisent `if`/`goto`/`for`/labels, une grammaire entièrement différente
de la ligne interactive cmd que `CmdLexer` couvre aujourd'hui — brancher
`executeBat` sur `Interpreter` prématurément aurait fait échouer tout
script utilisant un mot-clé batch non supporté, une vraie régression sur
`cmd-bat-execution.test.ts`. Chantier séparé, à faire une fois ces
mots-clés supportés par un parser batch dédié.

**Réponse à « toutes les commandes supprimées doivent être migrées » :
audit** — aucune implémentation legacy n'a été supprimée du dépôt en
Phase 1 ; seul le ROUTAGE (le `switch` dans `executeCmdCommand`) a été
retiré. Vérifié fichier par fichier (`WinDir.ts`, `WinPing.ts`,
`WinIpconfig.ts`, `WinNetsh.ts`, `WinTasklist.ts`, `WinSc.ts`, etc.) :
chaque fonction `cmdXxx` existe toujours, intacte, prête à être migrée
commande par commande — c'est du matériel de référence en attente, pas
du code perdu. `WindowsPC.executeCommand()` (méthode publique la plus
utilisée par la suite de tests) délègue directement à
`executeCmdCommand()` — c'est donc déjà, et reste, le point d'entrée
observable pour mesurer la progression de la migration à chaque
exécution de la suite de tests, sans changement nécessaire de ce côté.

**Validation** : même lot localisé qu'en Phase 1 (8 fichiers) — 118/144,
identique à la Phase 1 (aucune régression introduite par la réécriture).
Lot élargi (`windows-consistency`, `basic-commandes`, `env-vars`) :
86/149, cohérent avec l'écart déjà documenté (commandes réseau/système
hors périmètre). Typecheck ciblé propre sur `command-kernel` (socle +
Windows) et `WindowsPC.ts`.

## Windows — Phase 1 : pont `command-kernel` + commandes fichiers/session de `cmd`, cutover complet du dispatcher legacy

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Premier équipement non-Linux sur `command-kernel` (§4 du framework). Aucun
pont Windows n'existait auparavant — tout est nouveau : `WindowsMachineApi`
(`src/network/devices/windows/command-kernel/WindowsMachineApi.ts`),
`WindowsUser`/`resolveWindowsUser`, `createWindowsHostShell`.

**Décision d'architecture — pas de `Lexer`/`Parser` partagé pour cmd.exe** :
la syntaxe cmd (`%VAR%`, `&` inconditionnel, lettres de lecteur, macros
doskey, `.bat`) diverge trop du grammaire bash de `command-kernel` pour
réutiliser son `Lexer`. `WindowsPC.executeCmdCommand` fait déjà tout ce
travail de découpage (chaînage `&&`/`||`/`&`, pipes, redirections,
changement de lecteur, expansion `%VAR%`, macros doskey) — le pont
(`runCommandKernelCmd`) construit directement un `SimpleCommandNode` à
partir du `(cmd, args)` déjà résolu et appelle `Executor.run()` sans
passer par `Interpreter`/`Lexer`/`Parser`, qui restent donc inchangés et
partagés uniquement au niveau moteur (`Executor`/`CommandRegistry`/
`PermissionGuard`/`ArgumentParser`), pas au niveau syntaxe.

**`MachineApi.fs` pour un filesystem sans owner/mode POSIX** : NTFS n'a ni
bits de permission Unix ni uid/gid — `FileStat.mode/ownerUid/ownerGid`
portent une valeur fixe (`0o666`/`0`/`0`), jamais lue par aucune commande
migrée (l'ACL réelle passe par `icacls`, non migré). `User.uid/gid` sont
dérivés d'un hash stable du SID Windows (pas d'identifiant numérique natif
dans ce modèle) — voir `numericIdFromSid` dans `WindowsUser.ts`.

**Périmètre migré (fichiers/session)** : `cd`/`chdir`, `mkdir`/`md`,
`rmdir`/`rd`, `type`, `copy`, `move`, `ren`/`rename`, `del`/`erase`,
`tree`, `set`, `cls`, `echo` (variante Windows dédiée — `echo -n foo`
affiche `-n foo` littéralement, contrairement à l'`EchoCommand` bash de
`registerCoreCommands` qui interprète `-n`/`-e`).

**Cutover complet du dispatcher, sur demande explicite de l'utilisateur**
(pas de fallback, même temporaire, vers le legacy) : tout
`executeCmdCommand` routait auparavant vers un switch de ~50 commandes
fichiers/système, un routeur `net <sous-commande>`, et un second switch
réseau (~14 commandes : `ipconfig`, `ping`, `netsh`, `ssh`, `route`,
`arp`, `nslookup`...). Les trois sont supprimés d'un bloc : le
dispatcher ne route plus que ce qui est enregistré dans
`createWindowsHostShell` ; toute commande non enregistrée renvoie
désormais le message exact `'<cmd>' is not recognized as an internal or
external command, operable program or batch file.` — un échec est donc,
par construction, le signal qu'une commande n'est pas encore migrée, plus
jamais un aiguillage silencieux vers une implémentation parallèle.
Les implémentations legacy encore utiles (`WinDir.ts`, `WinSystemCommands.ts`,
les commandes process/service/réseau de `WinFileCommands.ts`, etc.) sont
laissées en place, inutilisées, comme matériel de référence pour leurs
migrations futures (§3.1 étape 1 du framework — les supprimer maintenant
détruirait la seule référence de fidélité exacte disponible) ; elles sont
supprimées au fur et à mesure de leur migration réelle, jamais avant.
`runSyncNativeCommand` (pont synchrone séparé utilisé par les cmdlets
PowerShell natifs) n'est pas concerné par ce cutover — c'est un
consommateur distinct, hors périmètre de cette phase.

**Bugs trouvés en migrant (cause racine, pas juste le symptôme)** :

- `rmdir` utilisait initialement `WindowsFileSystem.deleteDirectory()`
  (suppression inconditionnelle) au lieu de `rmdir()`/`rmdirRecursive()`
  — perdait donc la vérification « répertoire non vide » que legacy
  `cmdRmdir` faisait réellement. Fix : `WindowsFileSystemApi.remove()`
  appelle `rmdir()`/`rmdirRecursive()`, jamais `deleteDirectory()`,
  exactement comme legacy (piège identique au §7.5 du framework, version
  Windows : deux méthodes VFS d'apparence équivalente, comportement
  différent).
- `ren`/`rename` : `renameEntry()` (legacy) rejette une collision de nom
  AVANT toute mutation (« A duplicate file name exists... ») et préserve
  l'entrée d'origine (mtime, attributs, ACL) ; le slot générique
  `FileSystemApi.rename()` (nécessairement `moveFile()`-backed pour
  rester utilisable par `move`, qui doit pouvoir traverser les
  répertoires) écraserait silencieusement une cible existante et recrée
  une entrée neuve. `RenCommand` reproduit donc la vérification de
  collision explicitement (avec exception pour un changement de casse
  pur, `ren a.txt A.txt`) avant d'appeler `rename()` — limitation connue
  et documentée : la préservation exacte de mtime/attributs/ACL au
  travers d'un `ren` n'est pas garantie (non couverte par la suite de
  tests localisée, donc non bloquante pour cette phase).

**Hors périmètre, échoue désormais explicitement avec « not recognized »
jusqu'à sa propre migration** : `dir`, `ver`, `hostname`, `systeminfo`,
`tasklist`, `netstat`, `vol`, `wmic`, `sc`, `netsh`, `ipconfig`, `ping`,
`ssh`/`sftp`/`scp`/`telnet`, `route`, `arp`, `nslookup`, `net`
(user/localgroup/start/stop/use/share/session/accounts/help), `auditpol`,
`winrm`, `whoami`, `icacls`, `runas`, `chcp`, `date`, `time`, `start`,
`setx`, `schtasks`, `print`, `lpr`, `slmgr`, `nbtstat`, `reg`, `nltest`,
`dcdiag`, `klist`, `netdom`, `dnscmd`, `certreq`, `certutil`, `query`,
`qwinsta`, `logoff`, `rwinsta`, `gpupdate`, `gpresult`, `iisreset`,
`doskey`, `powershell`/`pwsh` (sous-shell depuis cmd), `find`, `findstr`,
`where`, `more`, `fc`, `xcopy`, `sort`, `attrib`, `taskkill`.

**Validation** : lot localisé (8 fichiers ciblés fichiers/session/cwd —
`windows-filesystem`, `windows-drive-switching`, `windows-per-drive-cwd`,
`cmd-ps-coherence`, `subshell-isolation`, `windows-session-isolation`,
`windows-session-migration`, `prompt-cwd`) : 118/144 passent. Les 26
échecs restants pointent tous, sans exception, vers une commande
explicitement hors périmètre ci-dessus (`dir`, `ver`, `hostname`,
`systeminfo`, `tasklist`, `netstat`, `vol`, `wmic`, `sc`, `netsh`) —
aucune régression sur le périmètre migré. Typecheck ciblé propre
(`tsc --noEmit`, zéro erreur dans `command-kernel`/`WindowsPC`/
`WinFileCommands` ; les erreurs préexistantes ailleurs dans le dépôt —
`LinuxSshClient.ts`, `CiscoSwitchShell.ts`, `SshServerHandler.ts`,
`vlan-filter-ordering.test.ts` — ne touchent aucun fichier de cette
session). Lint ciblé non exécutable dans cet environnement (dépendance
`@eslint/js` absente du sandbox, pré-existant, sans rapport avec ce
changement).

**Suite (prochaines phases)** : `dir` en priorité (nécessite son propre
travail — numéro de série de volume, espace libre, correspondance
wildcard, formats large/récursif — pas réductible au `FileSystemApi`
générique sans l'étendre), puis `ver`/`hostname`/`systeminfo`/`tasklist`/
`netstat`/`vol` (commandes système simples), puis le périmètre réseau
(`ipconfig`, `ping`, `netsh`...) qui délèguera à `MachineApi.net` en
s'appuyant sur `EndHost`/`Port`/`Cable` existants (§2 du framework),
jamais une resimulation parallèle.

## Linux — Phase 5 : `rmdir`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Extension du socle** : `FileSystemApi.rmdir(path, actor)` — distinct de
`remove(path, actor, recursive)` : échoue avec `ENOTEMPTY` si le
répertoire n'est pas vide, ne supprime jamais récursivement, même avec
un futur flag. Implémenté via `VirtualFileSystem.rmdir()` (déjà utilisé
par le legacy `cmdRmdir`). Le contrôle du bit sticky et de la permission
du parent, identique à celui de `rm`, a été factorisé dans
`LinuxFileSystemApi.assertStickyRemovable()` (partagé par `remove()` et
`rmdir()`) plutôt que dupliqué — les deux commandes legacy (`cmdRm`/
`cmdRmdir`) ont exactement la même logique de vérification.

**Commande migrée** : `rmdir <répertoire...>` — message d'erreur au
format `rmdir: failed to remove '<cible>': <raison>`, audit
(`syscall=rmdir`) après succès uniquement.

**Validation** : même lot localisé qu'à la phase précédente, `run-parts.
test.ts` inclus — 39 fichiers, 1604 tests, mêmes 3 échecs pré-existants
et sans rapport déjà documentés (bash script `if/then`/fonctions, hors
périmètre command-kernel).

## Linux — Phase 4 : `ln` (liens physiques et symboliques)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**

**Extension du socle** : `FileSystemApi` gagne `link(targetPath, path,
actor)` — lien physique, distinct de `symlink()` déjà existant.
Implémenté dans `LinuxFileSystemApi` via `VirtualFileSystem.createHardLink`
(déjà utilisé par le legacy `cmdLn`, partage réellement le même inode et
incrémente `linkCount` — vérifié par `ls -i` sur les deux noms). Ajouté
aussi dans `testing/in-memory-machine.ts` (le `MachineApi` factice du
socle) en partageant la même référence d'objet entre les deux chemins.

**Commande migrée** : `ln [-s] <cible> <lien>` — lien physique par
défaut, symbolique avec `-s`, message d'erreur au format legacy exact
(`ln: failed to create <kind> '<lien>': <raison>`), audit
(`syscall=symlink`/`syscall=link`) après succès uniquement (§7.4 du
framework).

**Validation** : lot localisé étendu à `run-parts.test.ts` (contient des
créations de liens symboliques cassés/valides) en plus du lot déjà établi
— 39 fichiers, 1604 tests, 3 échecs **confirmés pré-existants et sans
rapport** (méthode §7.2 : mêmes 3 échecs avec `git stash` des changements
de cette phase). Ces 3 échecs concernent l'interpréteur bash de scripts
(`src/bash/`, hors périmètre de `command-kernel`) sur des scripts
utilisant `if/then/else` et des déclarations de fonction — un vrai trou,
mais dans un sous-système entièrement différent, à traiter séparément.

## Linux — Phase 3 : lecteurs d'identité (`id`, `whoami`, `groups`) + durcissement `rm`

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Suit `migration_framework.md` : vérifié au préalable que `id`/`whoami`/
`groups` n'existent nulle part dans l'autre framework de migration
(`src/network/devices/linux/commands/iam/`) et qu'aucune entrée de
`defaultCommandPrivileges.ts` ne les restreint — `PrivilegeLevel.ANY`
est donc bien équivalent au comportement legacy.

**Périmètre migré** :

- `id` — format par défaut (`uid=…(…) gid=…(…) groups=…`), `-u`/`-g`/`-G`
  (avec `-n` pour les noms), rejet des combinaisons invalides
  (`-n` seul, plusieurs sélecteurs) avec les mêmes messages et le même
  code de sortie que legacy (`0`, sauf utilisateur inexistant → `1`).
- `whoami`, `groups [utilisateur]` (format `nom : groupes` uniquement si
  l'utilisateur est passé explicitement, comme legacy).
- Aucun de ces trois n'a d'effet de bord filesystem — seul le prélude
  générique `publishCommandExecve` (déjà en place, voir la phase
  précédente) s'applique, pas de nouvel appel d'audit par commande.

**Bug trouvé en élargissant les tests localisés (`rm-preserve-root.test.ts`,
jamais inclus dans un lot précédent)** — pas une régression de cette
session, un trou déjà présent depuis la Phase 1 sur `rm`, découvert en
suivant la règle du framework « élargir le filet dès qu'on touche à
IAM/privilège » :

- `rm` n'implémentait ni `--preserve-root`/`--no-preserve-root` (refus de
  `rm -rf /`), ni le bit sticky de `/tmp` (`rm` d'un fichier d'autrui dans
  un répertoire sticky doit échouer avec « Operation not permitted »), ni
  le format de message exact `rm: cannot remove '<cible>': <raison>`
  (le pont renvoyait `rm: <chemin résolu>: <raison>`, sans le préfixe
  `cannot remove`). Fix : `LinuxFileSystemApi.remove()` réplique l'ordre
  exact des vérifications legacy (répertoire non récursif → bit sticky →
  suppression), `RmCommand` porte la logique `--preserve-root` (propre à
  `rm`, pas une notion de filesystem générique) et reformate les erreurs
  au format exact.

**Nettoyage** : déplacement de la validation `cut` (« une option -f, -c ou
-b est requise ») dans `validate()`, sur le modèle déjà établi par
`ChmodCommand` — c'est une incohérence purement syntaxique entre
arguments déjà parsés, indépendante de `ctx.machine`, donc elle n'a pas
sa place dans `execute()`. Les autres validations argument-dépendantes
(`chown` résout un utilisateur/groupe réel, `cut` calcule des plages qui
dépendent de la longueur de chaque ligne) restent dans `execute()` car
elles ont besoin de `ctx.machine` ou d'un état runtime que `validate()`
n'a pas.

**Validation** : lot localisé élargi (38 fichiers, 1457 tests, 0 échec) —
IAM/filesystem, ACL, privilège, audit/journalisation, su/sudo, et
l'ensemble déjà établi des phases précédentes.

## Linux — Fix critique : parité d'audit/trace pour les commandes déjà migrées

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Découvert en élargissant les tests localisés à `auditctl.test.ts`,
`auditctl-other.test.ts`, `journalization.test.ts` et
`journalization-and-audit.test.ts` (480 tests, jamais exécutés contre le
bridge command-kernel avant ce tour) : **25 régressions réelles**,
confirmées par comparaison directe avec le commit précédant l'existence de
command-kernel (480/480 passaient avant migration).

**Cause racine.** `LinuxCommandExecutor.dispatch()` — le point d'entrée
legacy — exécute un prélude AVANT le `switch` de chaque commande : bascule
`currentCommandHead`, puis `publishFsAccess`/`publishSyscall('execve', …)`
pour la commande elle-même, et pour les commandes filesystem, un second
jeu d'appels par argument (`open`/`mkdir`/`unlink`/`rename`/`chmod`/
`chown`…) qui alimente `auditd`/`ausearch`/`aureport` simulés. Le pont
`tryCommandKernel` contourne entièrement `dispatch()` — il n'exécutait
donc ni le prélude, ni les appels par commande, rendant tout audit
silencieusement absent pour les commandes déjà migrées (Phases 1 et 2).

**Fix (pas de repli sur l'ancien chemin — le comportement est reproduit,
pas contourné)** :

- `MachineApi` gagne une capacité optionnelle `audit?: AuditApi`
  (`fsAccess(path, perm, syscall?)`, `syscall(name, path?)`) — absente
  pour les profils qui n'en ont pas besoin, les commandes l'appellent via
  `ctx.machine.audit?.`.
- `LinuxMachineApiDeps` gagne `publishFsAccess`/`publishSyscall`, câblés
  dans `LinuxMachine.getCommandKernelShell()` sur les wrappers publics
  déjà existants `LinuxCommandExecutor.publishAuditFsAccess`/
  `publishAuditSyscall`.
- Nouveau `LinuxCommandExecutor.publishCommandExecve(cmd)` — réplique
  exactement le prélude de `dispatch()` (bookkeeping + accès `/usr/bin/
  <cmd>`+`/bin/<cmd>` + `execve`) ; appelé par `tryCommandKernel` pour
  chaque étage d'un pipeline avant exécution.
- `LinuxFileSystemApi.writeFile()` publie désormais `('w','open')` avant
  d'écrire — couvre à la fois `touch` (avant sa réécriture, voir
  ci-dessous) et toute redirection `>`/`>>` (`FileOutputStream` passe par
  `writeFile`, donc `echo … >> fichier` publie correctement).
- Chaque commande fichier migrée (`ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`,
  `chmod`, `chown`) publie l'événement correspondant, à l'identique de son
  `case` legacy — **après** l'opération réussie (pas avant), pour ne
  jamais logger un accès qui a en fait échoué.
- Nouvelle méthode `FileSystemApi.touch(path, actor)` (implémentée via
  `VirtualFileSystem.touch()`, pas `writeFile()`) : `touch` sur un fichier
  déjà existant ne fait que rafraîchir sa date de modification, sans
  passer par le chemin d'écriture générique — corrige une régression
  fonctionnelle distincte où `touch` déclenchait à tort les observateurs
  `vfs.onWrite()` d'une règle `-w` (donc ignorait les règles
  d'exclusion `-a never,exit -F dir=…`, que `vfs.touch()` ne traverse
  jamais).

**Deux bugs fonctionnels distincts trouvés au passage (mêmes tests)** :

- **`chown user:group_name`** : `ChownCommand` n'acceptait qu'un gid
  numérique après `:` (limitation documentée en Phase 1), alors que
  legacy résout aussi un nom de groupe. Fix : `resolveGid()` (miroir de
  `resolveUid()`) via `ctx.machine.groups.findByName`.
- **`echo "-w ...token qui ressemble à une option inconnue"`** :
  `ArgumentParser` levait `UsageError` sur tout token `-x` non reconnu,
  alors que le vrai `echo` n'échoue jamais sur une option inconnue (il
  l'affiche littéralement). Nouveau `CommandDescriptor.lenientOptions`
  (opt-in, seul `EchoCommand` l'utilise) : un token dash non reconnu
  devient un positional au lieu de lever une erreur.

**Validation** : les 4 fichiers d'audit (480 tests) + l'ensemble déjà
établi (IAM, ACL, text-processing, bash) repassés intégralement —
36 fichiers, 1359 tests, 0 échec.

## Linux — Phase 2 : traitement de texte (coreutils)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Câblée sur le même point d'entrée que la Phase 1, validée contre les
suites de tests dédiées (`linux-cut-flags`, `linux-sort-flags`,
`linux-wc-flags`, `linux-tr-uniq-flags`) et l'ensemble de la Phase 1 +
`linux-bash-details` (pipes, substitutions, échappements) sans
régression.

**Périmètre migré** (`src/network/devices/linux/command-kernel/commands/`) :

- `grep` — `-i`, `-v`, `-n`, `-c`, `-E`, multi-fichiers (préfixe `label:`).
- `head` / `tail` — `-n N` (raccourci numérique `-N`), `head -c N` (octets).
- `wc` — `-l`/`-w`/`-c`/`-m`/`-b`/`-L`, ligne `total` multi-fichiers,
  erreur `wc: <fichier>: No such file or directory` par fichier manquant
  sans interrompre le traitement des fichiers valides.
- `sort` — `-n`, `-r`, `-u`, `-h` (suffixes K/M/G), `-V` (version-sort),
  `-M` (mois), `-f` (insensible à la casse), `-t DELIM` + `-k KEY[,KEY][n]`
  (tri par colonne avec override de type par clé).
- `cut` — `-d`/`-f` (listes et plages `1-3`/`2-`/`-2`), `-c`/`-b`
  (caractères/octets), `-s`/`--only-delimited`, `--output-delimiter`,
  `--complement`.
- `uniq` — `-c`, `-d`, `-u`, `-i`, `-f N`.
- `tr` — `-d`, `-s`, `-c`, classes POSIX (`[:upper:]`...), échappements,
  plages `a-z`.
- `textInput.ts` — helper partagé (`splitLines`/`joinLines`,
  `readTextInput`/`readPerFileInputs`) pour une gestion fidèle du saut de
  ligne final, réutilisé par toutes les commandes ci-dessus.

**Extensions du socle** :

- `ArgumentParser` : valeur courte collée (`-d,` / `-n5`) via
  `matchGluedShortValue`.
- `Executor` : expansion générique de globs (`*`, `?`, `[...]`) au niveau
  du moteur (`exec/glob-expand.ts`), respecte `Word.noExpand`.
- Marqueur interne `ESCAPED_DOLLAR` (`ast/tokens.ts`) : un `\$` (guillemets
  doubles ou nu) survit au lexing sans être expansé comme variable, puis
  restitué en `$` littéral par l'`Expander` — et symétriquement par
  l'`Executor` pour les mots `noExpand` (guillemets simples).

**Bugs trouvés puis corrigés en testant contre la suite existante** :

- **`grep` avalait une ligne vide fantôme.** `content.split('\n')`
  produisait une dernière entrée vide pour tout contenu se terminant par
  `\n` ; avec `-v`, cette ligne vide (ne contenant jamais le motif) était
  incluse à tort, ajoutant un saut de ligne fantôme en sortie — détecté
  via un pipeline `echo | grep -v ... | wc -l` qui comptait une ligne de
  trop. Fix : `grep` utilise désormais `splitLines` (même utilitaire que
  `cat`/`head`/`tail`) au lieu d'un `split('\n')` brut.
- **`\$` échappé était expansé comme variable.** Le lexer réduisait
  `\$dollar` à `$dollar` avant l'expansion, donc l'Expander tentait de
  substituer une variable `dollar` inexistante et l'effaçait. Fix :
  marqueur `ESCAPED_DOLLAR` posé au lexing, restitué en `$` littéral
  après expansion (ou directement pour les mots `noExpand`).
- **`cat` refusait de lire l'entrée standard.** L'argument `files` était
  `required: true`, donc `cat` en fin de pipe (`... | cat`) échouait avec
  « argument requis manquant » au lieu de lire `stdin`. Fix : `files`
  devient optionnel, avec repli sur `ctx.io.stdin.readAll()` — même motif
  que `sort`/`cut`/`head`/`tail`.
- **`sort -k F,Fn` dupliquait le champ.** La reconstruction de clé
  ajoutait un `endTail` même quand `startField === endField`, produisant
  une clé du type `"11 1"` au lieu de `"11"`. Fix : la troncature ne
  s'applique que si un caractère de fin est explicitement spécifié sur le
  même champ ; la valeur du champ seul est utilisée sinon.

**Hors périmètre de cette phase** : réseau, IAM avancé, matériel, audit,
systemd (inchangé depuis la Phase 1).

## Linux — Phase 1 : filesystem & session (coreutils)

**État : branche de travail (`arthur`), pas encore mergée sur `mandeng`.**
Cette phase est câblée sur le vrai point d'entrée
(`LinuxMachine.executeCommand`) et validée contre plus de 20 fichiers de
tests déjà existants dans le projet (filesystem/IAM, ACL POSIX,
substitution de commande, variables d'environnement, hardware, cron,
logging...), en plus des tests dédiés du socle.

**Câblage réel** (`LinuxMachine.tryCommandKernel`, appelé depuis
`executeCommand`) :

- Une ligne passe par `command-kernel` uniquement si elle se réduit, une
  fois parsée, à une commande simple ou un pipeline (jamais `;`, `&&`,
  `||`, boucles, conditions, sous-shells — ceux-ci restent intégralement
  sur `src/bash/` + `LinuxCommandExecutor`) ET si chaque commande qu'elle
  nomme est déjà enregistrée sur le profil Linux. Sinon, repli intégral
  et silencieux sur l'ancien chemin (aucune exécution partielle).
- Le `cwd` et l'`umask` sont lus/réécrits sur `this.executor` à chaque
  appel (pas d'état dupliqué) ; l'identité vient de
  `LinuxUserManager.currentUser`.

**Périmètre migré vers `command-kernel`** (`src/network/devices/linux/command-kernel/`) :

- `LinuxMachineApi` — implémentation réelle de `MachineApi`, pont direct
  vers `VirtualFileSystem` (via `VfsPath` pour les contrôles d'accès
  POSIX), `LinuxUserManager`, `LinuxProcessManager` et les ports
  matériels. Aucun état parallèle : `LinuxCommand`/`LinuxCommandExecutor`
  continuent d'opérer sur les mêmes `VirtualFileSystem`/`LinuxUserManager`
  sous-jacents.
- `LinuxUser` — adapte un `LinuxUserAccount` réel au contrat `User` de
  command-kernel (uid/gid/groupes/gids supplémentaires).
- Commandes : `pwd`, `cd`, `ls` (`-l`, `-a`, `-d`, `-S`, `-R`, `-i`,
  cibles multiples, résolution owner/group par nom), `cat` (`-n`),
  `mkdir` (`-p`), `touch`, `rm` (`-r`, `-f`), `cp`, `mv`, `stat`
  (format par défaut + `-c FORMAT`), `chmod` (octal et symbolique
  `u+w,g-w,o=r`/`a-x`/`u+s`/`g+s`/`o+t`), `chown` (utilisateur par nom,
  groupe par gid numérique).
- `createLinuxHostShell()` — bootstrap par profil d'équipement (§3.2 du
  framework), compose `registerCoreCommands` (universel : `exit`, `echo`)
  + les coreutils ci-dessus.

**Extensions du socle `command-kernel`** (nécessaires, pas de façade
parallèle créée) :

- `FileSystemApi` prend désormais un `FileSystemActor` (uid/gid/gids)
  explicite à chaque appel — le contrôle d'accès dépend de qui appelle,
  pas de quelle machine répond ; une seule `MachineApi` reste partagée
  entre toutes les sessions/terminaux d'un équipement.
- `FileStat` enrichi (`type`, `ownerGid`, `linkCount`, `inode`,
  `symlinkTarget`) ; `FileSystemApi` gagne `lstat`, `exists`, `copy`,
  `rename`, `symlink`, `readlink`.
- Nouvelle erreur `FileSystemError` (ENOENT/EACCES/ENOTDIR/EISDIR/EEXIST/
  ENOTEMPTY), alignée sur `VfsPath.PathError`.
- `User` gagne `supplementaryGids` (gids numériques, distincts des noms
  de groupe utilisés pour `PrivilegePolicy`).
- `UserManagementApi.findByUid` + nouvelle `GroupManagementApi`
  (`findByGid`/`findByName`) sur `MachineApi.groups` — nécessaires pour
  que `ls -l`/`stat` affichent des noms, pas des identifiants numériques.
- `ArgumentParser` : options courtes combinables (`-la` = `-l -a`) ;
  correction d'un bug où un positional variadique optionnel resté vide
  faisait répondre `ParsedArgs.has()` par « présent ».
- L'AST distingue désormais les mots issus de guillemets simples
  (`Word.noExpand`) : un argument comme `'texte $VAR'` n'est plus expansé
  par erreur — bug trouvé en migrant des scripts réels.
- Commandes universelles (`registerCoreCommands`) : `EchoCommand` sait
  interpréter `-e`/`-n`/`-E` (échappements bash `\n`, `\t`...).

**Bugs trouvés puis corrigés en testant contre la suite existante** :

- **ACL POSIX contournées.** `FileSystemActor` ne portait que des
  identifiants numériques (uid/gid/gids) ; `VfsPath.allows()` ne consulte
  les ACL (`setfacl`) que si `PathActor.user`/`groupNames` (des noms) sont
  renseignés. Fix : `FileSystemActor` et `toFileSystemActor()` portent
  désormais `name`/`groupNames`, propagés jusqu'à `VfsPath` par
  `LinuxMachineApi`.
- **Substitution de commande non supportée.** L'Expander de
  command-kernel ne gère pas `$(...)`/`` `...` ``. `tryCommandKernel`
  refuse maintenant le routage dès que la ligne brute contient l'un des
  deux (repli intégral sur l'ancien chemin, qui les supporte).
- **Variables d'environnement non alimentées.** La session construite par
  le pont avait un `env` toujours vide. `LinuxCommandExecutor.getEnvSnapshot()`
  expose maintenant le même environnement complet (statique + calculé :
  `HOSTNAME`, `HOME`, `USER`...) que celui que `LinuxCommandExecutor`
  construit pour son propre interpréteur bash (`buildEnvVars()`), utilisé
  pour peupler la session à chaque appel.

**Hors périmètre de cette phase (volontairement, à traiter en phases
suivantes)** :

- Réseau (`ip`, `ping`, `iptables`…), IAM avancé (`useradd`, `passwd`,
  `chage`…), matériel (`lspci`…), audit, services systemd — restent sur
  `LinuxCommand`. `LinuxMachineApi.net`/`.proc`/`.users` existent déjà
  (réels, pas des stubs) mais aucune commande de ce périmètre n'est
  encore migrée.
- `chown` : groupe par gid numérique uniquement, pas par nom (pas de
  résolution de groupe par nom câblée dans la commande elle-même, bien
  que `MachineApi.groups` existe désormais).
- `umask` fixé à la valeur courante de `LinuxCommandExecutor` au moment
  de l'appel (lu dynamiquement, mais aucune commande `umask` n'est
  migrée pour le modifier depuis command-kernel).
- Pas de vérification du bit d'exécution sur les répertoires ancêtres
  lors de la traversée de chemin (le `VirtualFileSystem` sous-jacent ne
  l'implémente pas non plus — pas une régression introduite ici).

## command-kernel — socle initial

Architecture d'interpréteur de commandes indépendante du vendeur
(`src/command-kernel/`) : sessions & `PrivilegePolicy` portée par la
commande, `CommandIO`/pipes, façade `MachineApi`, parsing d'arguments
typé, `ICommand`/`CommandRegistry`, Lexer/Parser/AST/Executor complets
(pipes, `&&`/`||`, `if`/`for`/`while`, sous-shells isolés, redirections
`>`/`>>`/`<`), `Interpreter`, `Terminal`/`VirtualTerminal`, `Shell` (REPL,
historique, prompt).

# Audit — Transport et services réseau

**Périmètre** : `src/network/tcp/`, `src/network/core/{SocketTable,PacketQueue,WellKnownPorts,types}.ts`, `src/network/protocols/ssh/` (SSH/SCP/SFTP), `src/shell/{CrossVendorRemoteShell,sshLauncher}.ts`, `src/network/dhcp/`, DNS (`src/network/dns/`, `devices/linux/LinuxDnsService.ts`, `devices/router/dns/`, `devices/windows/*dns*`), `src/network/{ntp,snmp,syslog,netflow,radius,tacacs,ipsec,gre,vxlan}/`, `devices/router/nhrp/`, telnet/ping/traceroute.
**Méthode** : lecture profonde du code, suivi des chemins d'appel de bout en bout (fichier:ligne), exécution ciblée de tests (`ipv6-tcp-probe-no-shortcircuit.test.ts` — 5/5 OK).
**Date** : 2026-07-22.

---

## Synthèse

| Service / protocole | Verdict paquets | Sévérité max |
|---|---|---|
| **TCP** (`tcp/TcpStack.ts`) | ✅ **Réel** — handshake 3-way, séquences, retransmission RFC 6298, congestion RFC 5681, SACK/timestamps/window-scale RFC 7323/2018, TIME-WAIT/CLOSE-WAIT RFC 9293 | MINEUR |
| **UDP / IPv4 forwarding générique** (`EndHost.sendUdpDatagram`) | ✅ Réel — ARP queue-and-resolve propre (`PacketQueue`) | MINEUR |
| **DHCP** (`dhcp/DHCPClient.ts`, `DhcpServerChannel.ts`) | ✅ **Réel** — DORA en trames UDP 68→67 réelles, options RFC 2131/2132, XID, T1/T2, INIT-REBOOT | MINEUR |
| **DNS** (client `EndHost.queryDnsServer`) | ✅ **Réel** — UDP/53 réel, port éphémère, ID de transaction, timeout réel ; fallback TCP/53 réel | MINEUR |
| **SSH — admission/reachability** (`sshLauncher.ts`, `TcpStack.connectOutcome`) | ✅ Réel — vrai handshake SYN/SYN-ACK/ACK puis fermeture | — |
| **SSH — session applicative Linux↔Linux** (`network/protocols/ssh/session/SshSession.ts` + `SshServerHandler.ts`) | 🟡 **Hybride** — banner/auth/exec/sftp-wire voyagent en JSON sur de vrais segments TCP ; mode **interactif** court-circuité (device pushé directement, aucune trame par commande) | **MAJEUR** |
| **SSH — cible non-Linux (Cisco/Huawei/Windows) ou terminal legacy** (`CrossVendorRemoteShell.ts`, `tryEnterCrossVendorSsh`) | ❌ **Magique** — vérif mot de passe = appel direct `device.checkPassword()`, shell distant = objet local bindé à l'équipement cible ; le commentaire du code admet contourner « la machinerie TCP/SshSession » | **CRITIQUE** |
| **Telnet sortant** (`CiscoShellBase.runOutboundTelnet`) | ❌ **Magique** — BFS topologique + lecture directe de `_getVtyTransportInput()`, aucun paquet TCP | **MAJEUR** |
| **SCP / SFTP (commande shell `scp`/`sftp`)** | 🟡 **Hybride** — probe de connexion réel (TCP SYN) puis transfert de données **par copie VFS→VFS directe** ; aucune trame ne transporte le contenu du fichier | **MAJEUR** |
| **SFTP (canal SSH natif, `SshChannelManager`)** | ✅ Réel — frames SFTP binaires sur `conn.write`/`onData` (donc sur TCP réel) | MINEUR |
| **NTP** (`ntp/NtpAgent.ts`) | ✅ Réel — paquets UDP/123 réels | MINEUR |
| **SNMP** (`snmp/SnmpAgent.ts`) | ✅ Réel — UDP/161-162 réels | MINEUR |
| **Syslog** (`syslog/SyslogAgent.ts`) | ✅ Réel — UDP/514 réel | MINEUR |
| **NetFlow** (`netflow/NetFlowAgent.ts`) | ✅ Réel — export UDP réel | MINEUR |
| **RADIUS** (`radius/RadiusClientAgent.ts`/`RadiusServerAgent.ts`) | ✅ Réel — UDP/1812-1813 réels, EAP encapsulé | MINEUR |
| **TACACS+** (`tacacs/TacacsClientAgent.ts`) | ✅ Réel — vraie session TCP/49 via `TcpStack.connect`, corps chiffré (obfuscation type RFC 8907) | MINEUR |
| **IPsec** (`ipsec/IPSecEngine.ts` + `devices/Router.ts`) | ✅ Réel — IKE en UDP/500, ESP/AH (proto 50/51) réinjectés dans le pipeline de forwarding réel du routeur | MAJEUR (voir détail) |
| **GRE** (`gre/GreAgent.ts`) | ✅ Réel — encapsulation proto 47 réelle | MINEUR |
| **VXLAN** (`vxlan/VxlanAgent.ts`) | ✅ Réel — UDP/4789 réel | MINEUR |
| **NHRP** (`devices/router/nhrp/NhrpService.ts`) | ❌ **Façade totale** — aucun message (Resolution/Registration Request/Reply) n'est jamais construit ni envoyé ; classe = simple magasin de config pour `show`/`running-config` | **MAJEUR** |
| **Ping / Traceroute** | ✅ Réel — ICMP réel, TTL décrémenté hop par hop (`Router.ts:1539-1544`), ICMP time-exceeded réel | MINEUR |
| **Fragmentation IPv4 (RFC 791)** | ⚠️ Non implémentée — champ `fragmentOffset` toujours à 0, aucune fragmentation/réassemblage ; compensé par un vrai PMTUD côté TCP | MAJEUR |
| **Résolution MAC avant émission (hors UDP générique/DNS)** | ❌ Raccourci transversal — TCP, Syslog, SNMP, NTP, NetFlow, RADIUS émettent en `dstMAC: broadcast()` si l'ARP est froid, au lieu de mettre en file + résoudre comme le fait `sendUdpDatagram` | **MAJEUR** |

---

## Analyse détaillée du chemin des paquets

### 1. SSH — deux implémentations parallèles et incohérentes

Le dépôt contient **deux piles SSH concurrentes** répondant à la même commande `ssh` selon le point d'entrée emprunté. C'est le constat le plus important de cet audit vis-à-vis de l'exigence du client.

#### 1.a Pile « réelle » : terminal Linux courant (`src/terminal/sessions/LinuxTerminalSession.ts`)

C'est la pile effectivement branchée sur l'UI de production (`TerminalManager` → `createSessionForDevice`, utilisé par `TerminalModal.tsx`).

1. L'utilisateur tape `ssh user@host` → interception explicite avant même que le bash générique voie la ligne : `LinuxTerminalSession.ts:1570-1571` (`if (parts[0] === 'ssh') await this.enterSsh(...)`).
2. `enterSsh()` (`LinuxTerminalSession.ts:2653`) tente d'abord `tryEnterCrossVendorSsh()` (§1.b ci-dessous) ; si la cible est une `LinuxMachine`, elle continue vers `connectAndEnterSsh()` (`LinuxTerminalSession.ts:2792` et suivantes).
3. `connectAndEnterSsh()` construit un `TcpConnector` littéralement branché sur `dev.tcpConnect(host, port)` (`LinuxTerminalSession.ts:2822-2823`), c.-à-d. `EndHost.tcpConnect()` (`EndHost.ts:2108-2118`) → `TcpStack.connect()` (`TcpStack.ts:341-371`) : **vrai SYN**, ISN aléatoire, options MSS/window-scale/SACK/timestamp encodées (`TcpStack.ts:365-369`), acheminé par `shipSegment()` → `host.sendFrame()` → `Port`/`Cable` réels.
4. Un `SshSession` (`network/protocols/ssh/session/SshSession.ts:84-155`) pilote alors banner exchange (`exchangeBanner`, ligne 197-217, `conn.write(JSON.stringify({op:'hello',...}))`), vérification de clé d'hôte, puis authentification (`doAuthenticate` → `requestServerAuth`, ligne 349-377) — **chaque message part réellement en `conn.write()`**, donc en payload TCP réel qui traverse `TcpSocket.send()` → `TcpStack._sendData()` → segments → IPv4 → Ethernet → `Port`/`Cable`.
5. Côté serveur, `LinuxMachine.attachSshTcpListeners()` (`LinuxMachine.ts:677-697`) enregistre un **vrai** `TcpStack.listen(port, {onAccept...})` et remet le socket accepté à `SshServerHandler.register()` (`SshServerHandler.ts:70-116`), qui traite `hello`/`auth`/`open_channel`/`exec`/`shell_open`/`shell_input` en lisant/écrivant sur `conn` — donc via de vrais segments TCP également (`SshServerHandler.ts:202-470`).
6. **Mode non-interactif** (`ssh host cmd`) : `session.openExecChannel(meta.command)` (`LinuxTerminalSession.ts:2913`) envoie un message `{op:'exec', command}` sur `conn`, reçu et exécuté côté serveur (`SshServerHandler.ts:323-361`), réponse renvoyée en `conn.write()` — **entièrement acheminé par paquets**, bout en bout.
7. **Mode interactif** (le cas de très loin le plus utilisé) : une fois authentifié, `LinuxTerminalSession.ts:2967-2980` **abandonne délibérément la session SSH/TCP** et appelle `createSessionForDevice(anyRemoteDevice, ...)` — c'est-à-dire qu'il instancie un **nouvel objet `TerminalSession` lié directement à l'instance `Equipment` distante en mémoire**. À partir de là, chaque commande tapée par l'utilisateur est exécutée par appel de méthode local sur l'objet du routeur/PC distant ; **aucune trame, aucun segment TCP, aucun byte ne transite plus par `Cable`** pour le reste de la session. Seul le fallback `RemoteShellSubShell` (`LinuxTerminalSession.ts:2982`, utilisé quand `anyRemoteDevice` ne peut pas être résolu — essentiellement les tests avec un `SshServerHandler` synthétique) continue de router chaque ligne comme un `exec` réel sur le canal TCP.

**Conclusion 1.a** : l'admission (SYN) et l'authentification (JSON sur TCP) sont réelles ; **la charge utile de la session interactive — l'écrasante majorité du trafic SSH réel — ne l'est jamais**.

#### 1.b Pile « magique » : cibles non-Linux et anciens points d'entrée (`sshLauncher.ts` / `CrossVendorRemoteShell.ts`)

1. `tryEnterCrossVendorSsh()` (`LinuxTerminalSession.ts:2702-2777`) : dès que la cible n'est pas une `LinuxMachine` (routeur Cisco/Huawei, Windows), le code **contourne explicitement** la pile ci-dessus. Commentaire du code lui-même (`LinuxTerminalSession.ts:2693-2701`) : *« bypass the TCP/SshSession machinery (no TCP listener on routers / Windows in the simulator) »*. Cette affirmation est **obsolète/fausse** pour Windows et les routeurs (voir point 3 ci-dessous) — c'est un vestige d'une itération antérieure du code, jamais retiré.
2. Le mot de passe est vérifié par `sshHost.evaluate(request)` (`SshConnectionRequest`, ligne 2753) — un appel de méthode local sur l'objet équipement, sans le moindre octet transmis.
3. En cas de succès, `xvendor_push` pousse directement l'équipement cible sur la pile de terminal (même mécanisme que le point 1.a-7).
4. Le second point d'entrée, `src/shell/sshLauncher.ts` (utilisé par `WindowsCmdShell.ts`, `WindowsPowerShellShell.ts`, `LinuxBashShell.ts` sous `src/shell/adapters/` — une **pile de shell distincte** de `src/terminal/sessions/`), fait la même chose avec un vernis un peu plus réaliste : `wireProbeFor()` (`sshLauncher.ts:543-553`) appelle bien `tcpConnectOutcome()`, donc **un vrai SYN/SYN-ACK/ACK est échangé** (`TcpStack.connectOutcome()`, `TcpStack.ts:379-387`, qui ouvre puis referme immédiatement une connexion réelle) pour décider *Connection refused* / *timed out* / *ouvert*. Mais l'étape suivante, `finalisePendingAuth()` (`sshLauncher.ts:353-421`), vérifie le mot de passe par `verifyCredentials(auth.target, user, password)` → `device.checkPassword(user, password)` (`sshLauncher.ts:511-519`) — **appel de méthode direct**, aucune trame `SSH_MSG_USERAUTH_REQUEST` (ni son équivalent JSON) n'est émise. La session qui suit est un `CrossVendorRemoteShell` (`CrossVendorRemoteShell.ts:67-86`) construit avec `device: opts.device` — l'objet Equipment **distant, en mémoire, référencé directement** (`sshLauncher.ts:411-419`). Chaque commande tapée s'exécute ensuite localement sur cet objet distant, exactement comme au point 1.a-7.

**Point notable et contradiction interne au code** : `WindowsPC.ts:481-489` et `Router.ts:432-438` enregistrent bel et bien un **vrai** `SshServerHandler` sur un **vrai** `TcpStack.listen(22, ...)` (`RouterSshServerContext`/`WindowsSshServerContext`). L'infrastructure « pile réelle » du §1.a existe donc *aussi* côté Windows et routeur — mais le chemin `ssh` emprunté depuis un shell Linux ou Windows vers ces cibles **ne l'utilise jamais**, à cause du bypass explicite du §1.b. Deux implémentations concurrentes du serveur SSH cohabitent pour Router/WindowsPC ; une seule (`SshServerHandler` réel) est correctement testée par le trafic applicatif, l'autre (bypass) est ce que l'utilisateur expérimente réellement au clavier.

### 2. DHCP — un bail complet, réellement diffusé

1. `dhclient`/auto-config → `DHCPClient.requestLease()` (`dhcp/DHCPClient.ts:291`) construit le XID, passe en état `SELECTING` (RFC 2131 §4.4, Fig. 5) et itère sur `channelsFor(iface)` (`DHCPClient.ts:328,358`), qui place toujours en premier le canal « fil » retourné par `wireChannelFactory` (`DHCPClient.ts:96-99`), lui-même câblé dans `EndHost.ts:645` (`this.dhcpClient.setWireChannelFactory((iface) => this.getDhcpWireChannel(iface))`).
2. Le canal fil est un `WireDhcpChannel` (`dhcp/DhcpServerChannel.ts:63-203`) : `processDiscover()` construit un vrai `DHCPPacket.createDiscover(mac, xid)` (options 50/55/61 encodées, `DHCPPacket.ts`) et l'envoie via `this.sendFrame(iface, pkt)` → `EndHost.sendWireDhcpFrame()` (`EndHost.ts:690-706`), qui l'enveloppe dans un **vrai** `UDPPacket` (68→67), un **vrai** `IPv4Packet` (`255.255.255.255` broadcast, TTL 64) et une **vraie** trame Ethernet à `dstMAC` broadcast, livrée par `sendFrame()`.
3. Le serveur (routeur) reçoit la trame par la voie normale (frame → IP → UDP), et son `DHCPServer.processDiscover()` répond ; la réponse revient au client par le même chemin UDP/IP/Ethernet et atterrit dans `WireDhcpChannel.inbox` via le listener `udpListeners.set(68, ...)` (`EndHost.ts:678-686`) — **la livraison Cable étant synchrone**, `exchange()` (`DhcpServerChannel.ts:79-93`) peut lire la réponse dans sa boîte dès le retour de `sendFrame()`.
4. `processRequestWithNak()` répète l'opération pour DHCPREQUEST/DHCPACK/DHCPNAK, XID vérifié à chaque étape (`DHCPClient.ts:367-370, 452-456`), T1/T2 lus des options 58/59 ou calculés à 50 %/87,5 % (RFC 2131 §4.4.5, `DHCPClient.ts:499-502`), ARP probe avant liaison (§4.4.1, `DHCPClient.ts:459`), timers réels de renouvellement/rebinding/expiration (`setupLeaseTimers`, `DHCPClient.ts:878-987`).
5. **Filet de sécurité documenté, non prioritaire** : `EndHost.autoDiscoverDHCPServers()` (`EndHost.ts:1029-1059`) enregistre aussi un `DirectServerChannel` (référence d'objet directe vers le `DHCPServer`, sans trame) via duck-typing (`getDHCPServer`). Comme le canal fil est toujours essayé en premier (`channelsFor()`), ce chemin direct n'intervient que dans les topologies non câblées (tests, ou absence de câble) — comportement documenté en commentaire (`DhcpServerChannel.ts:6-9`) comme « fallback for uncabled unit tests ».

**Verdict DHCP : réel.** Seul bémol : pas de perte de paquet simulée dans l'échange DORA lui-même (le premier DISCOVER ne peut pas se perdre en transit — cf. §4 « manques »).

### 3. DNS — requêtes UDP/53 réellement encapsulées

1. `EndHost.queryDnsServer()` (`EndHost.ts:2339-2391`) encode un vrai message DNS (`buildLegacyQueryMessage`/`encodeDnsMessage`, `dns/wire/DnsMessageCodec.ts`), alloue un port éphémère via `SocketTable.allocateEphemeralPort()` (`EndHost.ts:2356`), s'abonne en écoute UDP (`udpBind`, ligne 2373) puis envoie réellement via `sendUdpDatagramTo()` → `sendUdpDatagram()` (`EndHost.ts:2145-2197`).
2. `sendUdpDatagram()` fait ce que `TcpStack`/agents UDP « legacy » ne font **pas** : consultation du cache ARP (`arpTable.get`, ligne 2184) et, si froid, **mise en file d'attente réelle + résolution ARP asynchrone** via `fwdQueueAndResolve()` (ligne 2194) au lieu d'un envoi en broadcast immédiat — le chemin ARP le plus conforme de tout le module transport.
3. Le message repart avec un ID de transaction (`nextDnsTransactionId()`), un timeout réel armé sur le scheduler (`EndHost.ts:2389`), et la promesse ne se résout que sur réception d'une réponse dont l'ID correspond (`decodeDnsReply(udp.payload, wire.id)`, ligne 2374) — exactement le modèle RFC 1035 (ID de transaction, retry applicatif à la charge de l'appelant).
4. Fallback TCP/53 (`queryDnsOverTcp`, `dns/transport/DnsTcpTransport.ts`) disponible pour AXFR/réponses tronquées — passe par le vrai `TcpStack`.

**Verdict DNS : réel.** C'est, avec DHCP, le sous-système transport le plus fidèle de l'audit.

### 4. SCP / SFTP (commande shell) — probe réel, transfert magique

1. `scp`/`sftp` shell → `LinuxCommandExecutor.runSshTransport()` (`LinuxCommandExecutor.ts:965-1017`) fabrique une commande `ssh ... hostname` de sonde et l'exécute via `runSshClient()` — c.-à-d. la pile §1.b, donc **un vrai SYN/SYN-ACK/ACK** (`wireProbeFor` → `tcpConnectOutcome`). Si la sonde échoue, l'erreur `Connection refused`/`timed out` est propagée fidèlement.
2. Si la sonde réussit, le transfert lui-même passe par `ScpSession.run()` (`network/protocols/ssh/scp/ScpSession.ts:36-68`), qui résout l'extrémité distante via `resolveRemote(host)` (ligne 74) → `LinuxCommandExecutor.resolveRemoteSftpFs()` → `findHostByAddress()` (recherche registre, aucune trame) → retourne **directement l'objet `ISftpFileSystem`** de l'équipement distant.
3. `ScpTransfer`/`ScpWireTransfer` (`ScpTransfer.ts:79-93`, `ScpWireTransfer.ts:99-117`) rejouent fidèlement la séquence de contrôle `C`/`D`/`E` + octet d'ack du protocole SCP réel (`ScpWireCodec.ts`) — **mais les données** transitent par `this.source.readFile(srcAbs)` puis `this.destination.writeFile(dstPath, data.value)` (`ScpWireTransfer.ts:101,107`) : deux appels directs sur des objets VFS en mémoire, **jamais un octet ne passe par `TcpSocket.send()`, ni par `Port`/`Cable`**. Le commentaire d'en-tête du fichier l'assume explicitement : *« recording the actual C/D/E control-line sequence […] instead of calling readFile/writeFile directly »* — en réalité l'appel direct existe toujours, seul le *tracé* du protocole a été ajouté pour la testabilité.
4. Le comportement est identique pour la commande interactive `sftp` (`LinuxCommandExecutor.ts:1019-1052`, `SftpInteractiveSession` construit directement avec `local`/`remote` = deux `ISftpFileSystem`).
5. **Contraste notable** : quand le SFTP passe par le vrai canal SSH (`SshChannelManager.openSftp()`, atteint depuis `SshSession.openSftpChannel()` §1.a), les paquets **sont** réels : `SshServerHandler.handleSftpWireFrame()` (`SshServerHandler.ts:183-200`) décode des trames SFTP binaires arrivées par `conn.onData` (donc via TCP réel) et répond par `conn.write(encodeSftpChannelFrame(...))`. Le module possède donc bel et bien tout l'outillage pour un SCP/SFTP 100 % filaire ; seule la commande shell `scp`/`sftp` autonome ne l'emprunte pas.

**Verdict SCP/SFTP (commande shell) : hybride** — admission réelle, transfert de données magique.

---

## Constats par service

### TCP — `src/network/tcp/TcpStack.ts` (1500 lignes)

- ✅ **Handshake 3-way réel** : SYN (`connect()`, `TcpStack.ts:341-371`) → SYN-ACK (`TcpStack.ts:549-588`) → ACK (`TcpStack.ts:799-800`), ISN aléatoire (`nextIsn()`), état `syn-sent`/`syn-received`/`established` conforme RFC 9293 §3.3-3.5.
- ✅ **Retransmission RFC 6298** : un seul timer RTO par connexion (`rearmRtoTimer`, ligne 1280-1285), backoff exponentiel capé (`RttEstimator.backoff()`), abandon après `TCP_MAX_RETRANSMITS=5` tentatives (`onRtoFired`, ligne 1288-1319).
- ✅ **RTT/RTO Jacobson-Karels réels** : `RttEstimator.sample()` (`RttEstimator.ts:64-75`) implémente SRTT/RTTVAR §2.2-2.3, Karn's algorithm respecté (`pruneUnackedQueue`, `TcpStack.ts:1240-1277`, bypass via RTTM RFC 7323 §4.3 quand les timestamps sont négociés).
- ✅ **Fenêtre glissante + zero-window persist** : `flushSendBacklog()` borné par `min(peerWindow, cwnd)` (`TcpStack.ts:637-661`), persist-probe RFC 9293 §3.8.6.1 (`maybeArmPersistTimer`/`onPersistFired`, lignes 663-701).
- ✅ **Congestion control RFC 5681** : slow-start/congestion-avoidance/fast-retransmit-fast-recovery (`TcpCongestionControl.ts`), déclenché sur 3 ACK dupliqués (`fastRetransmit`, ligne 1322-1338) et sur timeout (`cc.onRtoTimeout`, ligne 1298).
- ✅ **Options RFC 7323/2018** : window-scale (shift 7, toujours offert), timestamps (PAWS appliqué, `acceptInOrder`, ligne 912-930), SACK (blocs fusionnés, `sackBlocksFor`, ligne 1192-1206), MSS négocié au minimum des deux offres.
- ✅ **PMTUD RFC 1191/1981** : `onIcmpFragNeeded()` (`TcpStack.ts:415-443`) réduit le MSS et resegmente/retransmet le segment bloqué (`resegmentAndRetransmit`, ligne 460-475), DF toujours positionné (`buildIpv4Segment`, ligne 1379).
- ✅ **Cycle de fermeture complet RFC 9293** : FIN-WAIT-1/2, CLOSING, CLOSE-WAIT, LAST-ACK, **TIME-WAIT avec timer 2×MSL réel** (`enterTimeWait`, ligne 956-963), `_abort()` envoie un vrai RST (§3.10.4).
- ✅ **Keepalive RFC 9293 §3.8.4** : idle-probe optionnel, `keepAliveMaxProbes` avant timeout (`onKeepAliveFired`, ligne 1096-1111).
- ✅ **Checksum réel vérifié à réception** (`verifyTcpChecksum`, `handleSegment`, ligne 525-528) — segment corrompu silencieusement rejeté, conforme §3.1.
- ⚠️ [MINEUR] **MD5/TCP-AO (RFC 2385/5925)** absents — non critique pour un simulateur pédagogique, mais aucune protection anti-spoofing modélisée sur BGP/TCP.
- ⚠️ [MINEUR] Pas de perte de paquet simulée nativement au niveau IP/Ethernet — la retransmission RFC 6298 n'est donc exercée que si un ACL/pare-feu/panne de lien authentique bloque un segment ; aucune perte aléatoire de type « qualité de lien » n'est modélisée pour stresser Cwnd/RTO en usage normal.
- ❌ [MAJEUR, transversal] **`shipSegment()` (`TcpStack.ts:1348-1353`) envoie en `dstMAC: broadcast()` si le cache ARP est froid**, au lieu de mettre le segment en file et de résoudre l'ARP au préalable (contrairement à `EndHost.sendUdpDatagram`, voir plus bas). Le tout premier SYN d'une connexion TCP vers une adresse jamais contactée part donc en trame Ethernet broadcast — fonctionnellement absorbé par le domaine de diffusion simulé, mais faux au niveau L2 (pas de résolution ARP visible dans une capture, pas d'apprentissage MAC réaliste sur un switch).

### UDP générique / IPv4 (`core/types.ts`, `EndHost.ts`)

- ✅ `sendUdpDatagram()`/`sendUdpDatagram6()` (`EndHost.ts:2145-2244`) : ARP-aware (cache + `fwdQueueAndResolve` via `PacketQueue`, `core/PacketQueue.ts`), filtrage pare-feu sortant (`firewallFilter`), délivrance locale correcte pour loopback/adresse propre.
- ⚠️ [MINEUR] **Aucun calcul/vérification de checksum UDP** (`checksum: 0` partout, aucune fonction `computeUdpChecksum` dans `core/types.ts`) — RFC 768 le rend optionnel en IPv4, donc tolérable, mais l'asymétrie avec le soin apporté au checksum TCP est notable.
- ⚠️ [MAJEUR] **Fragmentation IPv4 (RFC 791) non implémentée** : le champ `fragmentOffset` existe dans `IPv4Packet` (`core/types.ts:680`) mais n'est jamais renseigné ni consommé — aucun routeur ne fragmente un paquet dépassant le MTU de sortie, aucun hôte ne réassemble. Compensé côté TCP par un vrai PMTUD (§ ci-dessus) mais laisse UDP/ICMP/GRE/IPsec sans stratégie de MTU dépassé autre que le DF+ICMP déjà crédité à TCP.

### SSH / SCP / SFTP — voir analyse détaillée §1 et §4. Résumé des sévérités :
- ❌ [CRITIQUE] Double implémentation SSH (§1.a réel vs §1.b magique) sélectionnée silencieusement selon le type de la cible et le point d'entrée shell, avec un commentaire de code obsolète justifiant le contournement pour des cibles (Windows, routeurs) qui possèdent pourtant un vrai serveur SSH câblé.
- ❌ [MAJEUR] Session **interactive** SSH Linux↔Linux elle-même court-circuitée après authentification (`createSessionForDevice`) — la charge utile de la quasi-totalité des sessions SSH réelles (frappe clavier, sortie de commande) ne traverse jamais `Cable`.
- 🟡 [MAJEUR] `scp`/`sftp` (commande shell) : sonde de connexion réelle, transfert de données magique (VFS→VFS direct).
- ✅ SFTP natif via canal SSH (`SshChannelManager`) et SFTP wire (`SftpWireSession`/`SftpChannelFraming`) sont, eux, réellement acheminés en TCP — code de qualité, sous-utilisé par les points d'entrée shell.
- 💡 Le module SSH est par ailleurs riche et soigné : `known_hosts`/vérification de clé d'hôte réelle (`SshKnownHostsFile`), `AuthChain` (mot de passe / clé publique), `Fail2banAgent`, `SshAuthThrottler`, `maxStartups`/`maxAuthTries`/`loginGraceTime` conformes `sshd_config`. Tout cet outillage tourne à vide pour les sessions interactives qui n'empruntent jamais le canal réel.

### Telnet — `CiscoShellBase.runOutboundTelnet` (`devices/shells/CiscoShellBase.ts:1715-1747`)

- ❌ [MAJEUR] Entièrement magique : `isPathReachable()`/`findReachableHost()` (`devices/linux/network/HostLookup.ts:23-93`) font un **BFS sur la topologie physique** (respecte câblage, alimentation, admin-up — donc plus fin qu'un simple lookup registre) mais ne construisent ni n'échangent **aucun paquet TCP**. `remoteAcceptsTelnet()` (`CiscoShellBase.ts:1749-1760`) lit directement `_getVtyTransportInput()` sur l'objet distant. Le listener réel `bindTelnetListener()` (`Router.ts:441-443`, `tcpv2.listen(23, {onAccept: () => {}})`) est un accept-handler **vide** — il existe uniquement pour que `nc -zv <ip> 23` / un scan de port se comporte correctement, sans jamais porter la session Telnet réelle.
- 💡 Point positif : `transitTcpAclVerdict()` (`HostLookup.ts:116-172`) synthétise un vrai paquet SYN et évalue les ACL de transit sur chaque routeur intermédiaire — un routeur qui filtrerait le SYN produit donc un timeout Telnet cohérent, même si le paquet lui-même n'est qu'une construction ponctuelle pour l'évaluation ACL (pas une trame livrée hop-by-hop).

### DHCP — voir §2. ✅ Réel. ⚠️ [MINEUR] pas de perte simulée dans l'échange DORA lui-même ; pas de relais DHCP (option 82/giaddr) visible dans `DHCPClient`/`WireDhcpChannel` pour les topologies routées sans agent relais explicite ailleurs dans le code (non vérifié exhaustivement, hors périmètre de lecture de ce document).

### DNS — voir §3. ✅ Réel, RFC 1035 respecté pour la structure des échanges (ID, QDCOUNT/ANCOUNT, UDP puis TCP en repli). 💡 Le module `dns/` est très complet (DNSSEC, EDNS, DoH/DoT/DoQ transports, zones, AXFR/IXFR) — hors du strict périmètre "est-ce que ça part sur le fil", il dépasse largement ce qu'un simulateur pédagogique nécessite, signe d'un investissement soigné.

### NTP — `ntp/NtpAgent.ts`
- ✅ Paquets UDP/123 réels (`NtpAgent.ts:422-428`, `host.sendFrame`).
- ❌ [MAJEUR, cf. transversal] `dstMAC: MACAddress.broadcast()` sans tentative de résolution ARP préalable (`NtpAgent.ts:422`).

### SNMP — `snmp/SnmpAgent.ts`
- ✅ UDP/161 (poll) et /162 (trap) réels (`SnmpAgent.ts:344-347`).
- ❌ [MAJEUR, cf. transversal] même raccourci `dstMAC: broadcast()` (`SnmpAgent.ts:344`).

### Syslog — `syslog/SyslogAgent.ts`
- ✅ UDP/514 réel, structure BSD (`SyslogAgent.ts:183-232`), gestion de facility/severity RFC 3164-like.
- ❌ [MAJEUR, cf. transversal] `dstMAC: broadcast()` (`SyslogAgent.ts:218`).

### NetFlow — `netflow/NetFlowAgent.ts`
- ✅ Export UDP réel (`NetFlowAgent.ts:238-241`).
- ❌ [MAJEUR, cf. transversal] même raccourci MAC (`NetFlowAgent.ts:238`).

### RADIUS — `radius/RadiusClientAgent.ts` / `RadiusServerAgent.ts`
- ✅ Le seul agent UDP hors DNS à **tenter** une résolution MAC avant de retomber sur broadcast : `dstMAC: this.host.resolveMac?.(server.ip) ?? MACAddress.broadcast()` (`RadiusClientAgent.ts:346,456,786`) — mieux que NTP/SNMP/Syslog/NetFlow mais toujours sans file d'attente + résolution ARP active comme `sendUdpDatagram`.
- ✅ EAP-TLS/PEAP/TTLS modélisés avec fragmentation (`eaptls/EapTlsFragmentation.ts`), CoA (RFC 5176) et accounting (RFC 2866) présents.
- 💡 Conformité RFC 2865 structurelle correcte : Access-Request/Accept/Reject/Challenge, Authenticator, attributs VSA.

### TACACS+ — `tacacs/TacacsClientAgent.ts` / `TacacsServerAgent.ts`
- ✅ **Vraie session TCP/49** : `stack.connect(server.ip, server.port, {...})` (`TacacsClientAgent.ts:168`), corps chiffré (obfuscation MD5-pad façon RFC 8907, `encryption.ts`) envoyé via `s.send(packet)` (ligne 188) → vrais segments TCP.
- 💡 Bien conçu : Authen/Author/Acct START/CONTINUE modélisés, timeout réel par requête (ligne 211-215).

### IPsec — `ipsec/IPSecEngine.ts` + `devices/Router.ts`
- ✅ IKE en UDP/500 réel (messages « offer »/« accept » routés via `handleIkeMessage`, `IPSecEngine.ts:1499`, appelé depuis le traitement UDP entrant du routeur).
- ✅ **Trafic protégé réinjecté dans le vrai pipeline de forwarding** : `processOutbound()` produit des paquets ESP/AH réels (proto 50/51, `IPSecEngine.ts:2174,2687`) remis à `this.processIPv4(route.iface, p)` (`Router.ts:1643,1660`) — donc re-routés, filtrés par ACL, NATés, et finalement émis via `sendFrame` exactement comme un paquet natif. C'est l'un des designs les plus rigoureux de l'audit : le tunnel n'est pas un raccourci, c'est un vrai paquet qui repasse par le vrai routeur.
- ⚠️ [MAJEUR] IKEv1/v2 modélisés en messages structurés (`IkeOfferMessage`) mais la négociation logique (phases 1/2, PFS, lifetime SA, DPD) n'a pas été auditée ligne à ligne dans ce document faute de temps — à couvrir dans un audit dédié IPsec si nécessaire (le présent document se limite à la question « paquets réels ou non », à laquelle la réponse est oui).

### GRE — `gre/GreAgent.ts`
- ✅ Encapsulation proto 47 réelle (`GreAgent.ts:149`), cohérent avec le forwarding IP normal.

### VXLAN — `vxlan/VxlanAgent.ts`
- ✅ UDP/4789 réel (`VxlanAgent.ts:231`).

### NHRP — `devices/router/nhrp/NhrpService.ts` (152 lignes)
- ❌ [MAJEUR] **Façade complète.** La classe ne contient que des `Map`/tableaux (`perInterface`, `mappings`, `nhsServers`, `cache`) alimentés uniquement par les commandes CLI (`configure`, `addMapping`, `addNhsServer`) et restitués par `formatCache()`/`asRunningConfigInterface()`. **Aucune méthode ne construit ni n'envoie de message NHRP** (Resolution Request/Reply, Registration Request/Reply, Purge) — recherchée exhaustivement (`sendFrame`, `EquipmentRegistry`, `resolve`, `lookup` absents du fichier). `show ip nhrp` reflète donc uniquement ce que l'opérateur a tapé en `ip nhrp map static`, jamais une résolution dynamique DMVPN réelle. À distinguer de "hybride" : il n'y a même pas de raccourci topologique comme pour Telnet, juste un magasin de configuration.

### Ping / Traceroute
- ✅ **Réel** : `EndHost.sendPing()` (`EndHost.ts:2515-2589`) construit un vrai `ICMPPacket`/`IPv4Packet` (TTL réel), résout la MAC au préalable (appelant utilise `resolveARP`), émet via `sendFrame`, attend la réponse par le bus d'événements avec timeout réel.
- ✅ **TTL décrémenté à chaque saut** (`Router.ts:1539-1545`, `forwardPacket()`) et **ICMP Time-Exceeded réellement généré** quand TTL atteint 0 — c'est ce qui rend `traceroute` authentique saut par saut, pas une simple liste précalculée.
- 💡 Bon détail RFC 1812 : le pipeline de forward (`forwardPacket`) est commenté comme implémentant "the full RFC 1812 forwarding pipeline" et le TTL est vérifié avant le lookup de route, comme sur un vrai routeur.

---

## Top 10 des actions recommandées

1. **[CRITIQUE] Unifier les deux implémentations SSH.** Faire de la pile `SshSession`/`SshServerHandler` (§1.a) le seul chemin pour **toute** cible qui expose déjà un `SshServerHandler` réel (c'est déjà le cas pour Router et WindowsPC, cf. `Router.ts:432-438`, `WindowsPC.ts:481-489`) — supprimer ou documenter comme dette explicite le bypass de `tryEnterCrossVendorSsh()`/`sshLauncher.ts` dont le commentaire justificatif (« no TCP listener on routers/Windows ») est aujourd'hui faux.
2. **[MAJEUR] Faire circuler la session SSH interactive sur le canal réel.** Remplacer `createSessionForDevice(anyRemoteDevice, ...)` (`LinuxTerminalSession.ts:2969`) par un flux qui envoie chaque ligne tapée en `shell_input` sur le `conn` déjà authentifié (le serveur le supporte déjà, `SshServerHandler.ts:387-407`) — le fallback `RemoteShellSubShell` prouve que c'est faisable et déjà écrit pour le cas synthétique ; il ne manque que de le rendre systématique.
3. **[MAJEUR] Faire transiter les octets SCP/SFTP par le canal SSH réel.** `ScpWireTransfer`/`ScpSession` disposent déjà du bon tracé protocolaire (C/D/E, acks) ; il suffit de brancher `source`/`destination` sur des `SftpWireSession` distantes via `conn.write`/`onData` au lieu de deux `ISftpFileSystem` locaux — l'infrastructure (`SftpChannelFraming`, `SftpWireCodec`) existe déjà et est utilisée par le canal SSH natif.
4. **[MAJEUR] Corriger le raccourci ARP transversal.** Remplacer `dstMAC: resolveMac() ?? MACAddress.broadcast()` par la même logique file-d'attente-et-résolution que `EndHost.sendUdpDatagram`/`PacketQueue`, dans `TcpStack.shipSegment()` (`TcpStack.ts:1348-1353`) et les agents NTP/SNMP/Syslog/NetFlow/RADIUS (`NtpAgent.ts:422`, `SnmpAgent.ts:344`, `SyslogAgent.ts:218`, `NetFlowAgent.ts:238`, `RadiusClientAgent.ts:346,456,786`).
5. **[MAJEUR] Retirer ou clairement badger Telnet comme non-filaire.** Soit implémenter un vrai flux TCP/23 (le listener existe déjà, `Router.ts:442`, il suffit de lui donner un `SshServerHandler`-like handler texte), soit documenter explicitement dans le code que `runOutboundTelnet` est une simulation topologique et non protocolaire, pour éviter toute confusion future avec le style SSH réel du même fichier.
6. **[MAJEUR] Implémenter NHRP a minima** (Resolution Request/Reply en paquets réels UDP/2049 côté NBMA) ou, si hors scope produit, le documenter explicitement comme "config store only, no protocol" en tête de fichier — au même titre que le fait honnêtement le commentaire de `ScpWireTransfer.ts`.
7. **[MAJEUR] Implémenter la fragmentation IPv4 (RFC 791)** au moins pour UDP (DHCP/DNS/SNMP à gros payload, options vendor longues) : aujourd'hui un paquet UDP dont la taille dépasse le MTU de sortie n'est ni fragmenté ni rejeté explicitement — vérifier ce qui se passe réellement en pratique (silencieusement transmis surdimensionné ?) et corriger.
8. **[MINEUR] Ajouter un calcul/vérification de checksum UDP** pour la symétrie avec le traitement rigoureux du checksum TCP, et pour permettre de tester la détection de corruption sur les protocoles UDP (DHCP/DNS/SNMP/Syslog).
9. **[MINEUR] Introduire une perte de paquet paramétrable au niveau `Cable`/`Port`** (taux configurable par lien) pour exercer réellement la retransmission RFC 6298 de TCP et les retries applicatifs DHCP/DNS en usage normal, pas seulement via ACL/panne de lien.
10. **[MINEUR] Nettoyer les commentaires de code obsolètes qui justifient des raccourcis** (`LinuxTerminalSession.ts:2693-2701` en particulier) : ce sont eux qui, en cas de relecture rapide, laissent croire à tort que l'architecture est plus filaire qu'elle ne l'est — un commentaire faux est pire qu'absence de commentaire pour un audit ou un futur contributeur.

---

## Ce qui est particulièrement bien fait (à souligner)

- **`TcpStack.ts`** est, dans son ensemble, une implémentation TCP sérieuse et rare pour un simulateur pédagogique : handshake, séquencement, retransmission RFC 6298 avec Karn/RTTM, congestion control RFC 5681 complet (slow-start/CA/fast-retransmit/fast-recovery), SACK RFC 2018, window-scale et timestamps RFC 7323 avec PAWS, PMTUD RFC 1191/1981, cycle de fermeture RFC 9293 intégral avec TIME-WAIT réel. Peu de simulateurs pédagogiques poussent aussi loin.
- **`EndHost.sendUdpDatagram`/`PacketQueue`** montrent que le bon modèle ARP (file d'attente + résolution asynchrone) est déjà écrit et utilisé quelque part dans le code — ce n'est pas un problème de compétence, juste d'incohérence de propagation à travers les autres émetteurs UDP.
- **DHCP et DNS** sont deux exemples de service applicatif intégralement filaire, avec la bonne rigueur RFC (XID, options, ID de transaction, timers réels) — un bon modèle à répliquer pour NHRP et pour la session SSH interactive.
- **IPsec** réinjecte honnêtement les paquets protégés dans le vrai pipeline de forwarding du routeur plutôt que de les court-circuiter — c'est le traitement le plus rigoureux de tout ce qui touche à l'encapsulation dans cet audit.
- Le module SSH (`network/protocols/ssh/`) est d'une richesse fonctionnelle notable (host-key verification, `AuthChain`, `Fail2banAgent`, `SshAuthThrottler`, SFTP wire réel) — le problème documenté ici n'est pas un manque de code, c'est un défaut de câblage entre ce code et les points d'entrée shell réellement utilisés par l'utilisateur.

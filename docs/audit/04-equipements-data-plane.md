# Audit — Équipements, couche physique et data plane

> Périmètre : `src/network/equipment/`, `src/network/hardware/`, `src/network/core/`
> (types, Logger, FilterChain), `src/network/devices/` (mécanique `handleFrame()`,
> DeviceFactory, host/), `src/store/` et l'intégration data plane ↔ animation de
> paquets dans `src/components/network/`.
> Méthode : lecture profonde du code, vérification croisée avec
> `src/__tests__/unit/network-v2/`, et **exécutions empiriques ciblées** (vitest) —
> notamment une preuve par l'exécution du comportement en boucle L2 (§3.7).
> Chaque constat est référencé `fichier:ligne`. Date : 2026-07-22.

---

## 1. Synthèse

Le socle physique/data plane est **globalement bien conçu et étonnamment fidèle
pour un simulateur navigateur** : le chemin trame réel existe (Port → Cable →
Port → `handleFrame()`), le pipeline du commutateur est riche (VLAN/trunk/hybrid/QinQ,
STP par VLAN, DAI, DHCP snooping, IGMP snooping, PVLAN, port-security avec aging),
le routeur implémente le pipeline RFC 1812 (vérification de checksum IPv4, TTL,
ICMP errors, ACL in/out, NAT, IPSec), et les hôtes disposent d'une vraie pile TCP
au-dessus des trames (`EndHost.ts:1702` → `TcpStack.handleIp`). L'animation de
paquets de l'UI est branchée sur les **vrais** événements de câble
(`cable.frame.dispatched`), pas sur une simulation cosmétique.

Mais l'audit confirme aussi **trois failles structurantes** :

1. **[CRITIQUE] Un second data plane « god-mode » court-circuite le câblage pour
   SSH/SCP/SFTP/nc** : `HostLookup.ts` fait un BFS de la topologie via
   `EquipmentRegistry` puis appelle **directement les méthodes de l'équipement
   distant** (`isServiceActive`, `sshdAcceptsLogin`, `executor.execute` —
   `LinuxSshClient.ts:795-920`). Le commentaire du code l'assume : *« the
   topology-bypass shortcut »* (`HostLookup.ts:115`). C'est la violation directe
   de l'exigence produit « toute communication inter-machines passe par des
   paquets ». Les captures tcpdump de ces sessions sont **synthétisées** a
   posteriori (`publishWireSegment`, `LinuxCommandExecutor.ts:1268-1297`), pas
   observées sur le fil.
2. **[CRITIQUE] La propagation des trames est 100 % synchrone** (appel de fonction
   récursif, `Cable.ts:325`) : une boucle L2 sans STP provoque un
   `RangeError: Maximum call stack size exceeded` — **reproduit empiriquement**
   avec deux `GenericSwitch` doublement câblés (§3.7). Aucune protection
   (budget de sauts, file, détection de récursion) n'existe.
3. **[MAJEUR] La convergence OSPF est partiellement « god-mode »** :
   `RouterOSPFIntegration.collectOSPFDomain()` (l. 586-633) traverse la topologie
   via `Equipment.getById()` et **installe directement les routes dans les
   routeurs pairs** (`peer.installRoutes(allOSPFRoutes)`, l. 582), même si les
   Hello/LSA existent par ailleurs sous forme de vrais paquets IP proto 89.

Points secondaires notables : pas de FCS ni de sérialisation (les trames sont des
objets partagés par référence), pas de fragmentation IPv4 (seul le cas DF=1 est
géré), duplex/collisions purement cosmétiques, `reload` ne restaure **pas** la
startup-config (elle n'est jamais ré-appliquée), sérialisation de topologie très
partielle, et 6 des 17 `DeviceType` sont des stubs déguisés.

| Axe | Verdict |
|---|---|
| Chemin de trame nominal (émission→câble→réception→décision) | ✅ solide et observé par événements |
| Pipeline switch (VLAN, STP data plane, DAI, snooping) | ✅ très riche, testé |
| Pipeline routeur (RFC 1812, checksum, TTL, ICMP, ACL, NAT) | ✅ fidèle |
| Communication par paquets **exclusivement** | ❌ CRITIQUE — SSH & co. hors-fil, OSPF assisté |
| Asynchronisme / robustesse aux boucles L2 | ❌ CRITIQUE — stack overflow prouvé |
| Réalisme matériel (ports, vitesse, duplex, MTU, power) | ⚠️ nommage et compteurs bons, physique cosmétique |
| Persistance startup vs running | ❌ MAJEUR — snapshot jamais ré-appliqué |
| Pont store ↔ Equipment ↔ UI | ✅ propre (read-models, stabilité référentielle) |
| Hiérarchie de classes / duplication | ⚠️ God objects (EndHost 3 885 l., Router 3 289 l.), constructeurs vendeurs dupliqués |

---

## 2. Cycle de vie d'une trame : analyse de bout en bout

### 2.1 Chemin nominal (fichier:ligne)

```
Équipement A                         Câble                     Équipement B
─────────────                        ─────                     ─────────────
Equipment.sendFrame()                                          Port.receiveFrame()
  Equipment.ts:232-245                                           Port.ts:709-743
    │ vérifie isPoweredOn                                          │ vérifie isUp/adminDown
    ▼                                                              │ port-security (l.721)
Port.sendFrame()                                                   │ compteurs framesIn/bytesIn
  Port.ts:675-707              Cable.transmit()                    ▼
    │ vérifie isUp/adminDown     Cable.ts:270-333            frameHandler(name, frame)
    │ vérifie cable≠null           │ isUp du câble             (posé par Equipment.addPort,
    │ compteurs framesOut/bytesOut │ perte simulée (rng)        Equipment.ts:216-227,
    │ publie port.frame.tx-requested│ publie cable.frame.       qui vérifie isPoweredOn)
    ▼                              │   dispatched (l.311)          ▼
cable.transmit(frame, this) ───────┘ targetPort.receiveFrame  Equipment.handleFrame()
                                     (l.325, SYNCHRONE)         (abstrait, Equipment.ts:252)
```

- L'émission passe toujours par `Port.sendFrame` → `Cable.transmit` →
  `Port.receiveFrame` du pair : **il n'existe pas de raccourci de livraison de
  trame** dans la couche hardware elle-même. Les compteurs RFC 2863
  (`Port.ts:150-155`, `ethernetFrameBytes` `types.ts:631-643` avec plancher
  64 octets et surcoût dot1q) sont tenus des deux côtés.
- Chaque étape publie des événements bus (`port.frame.tx-requested`,
  `cable.frame.dispatched`, `cable.frame.delivered`, `port.frame.received`,
  `port.frame.dropped` avec raison) : excellente observabilité, c'est ce qui
  alimente l'animation UI (§6.3).

### 2.2 Sérialisation et FCS — ❌ [MAJEUR] inexistants

- `EthernetFrame` (`types.ts:624-629`) = `{srcMAC, dstMAC, etherType, payload}`.
  **Pas de champ FCS**, pas de préambule, pas de sérialisation en octets : le
  « frame check sequence » du cahier des charges ne peut pas être validé puisque
  la trame n'est jamais encodée. La perte simulée du câble
  (`Cable.ts:290-298`) supprime la trame mais ne peut pas produire de trame
  *corrompue* (CRC error) — les compteurs `errorsIn` existent
  (`Port.ts:594`) mais rien dans le chemin nominal ne les incrémente.
- **Conséquence plus grave : aliasing par référence.** La trame livrée est le
  *même objet JavaScript* que celui émis. `Hub.handleFrame` (`Hub.ts:25-33`)
  réémet l'objet identique sur tous les ports ; `Switch.floodFrame` réémet
  `stripTag(frame)` qui retourne **le même objet** quand il n'y a pas de tag
  (`Switch.ts:1973-1992`). Toute mutation du `payload` par un récepteur serait
  visible chez l'émetteur et chez les autres récepteurs. Le routeur, lui, copie
  correctement le paquet avant mutation (`Router.ts:1558-1563` : spread + nouveau
  TTL + checksum recalculé) — mais c'est une discipline par convention, pas
  garantie par le type (pas de `Readonly<EthernetFrame>`, pas de deep-freeze).

### 2.3 Validation MAC destination — ✅ avec un trou IPv4 multicast côté hôtes

- **Routeur** (`Router.ts:1056-1068`) : accepte unicast pour soi, broadcast,
  multicast IPv6 `33:33`, multicast IPv4 `01:00:5e` (RFC 1112 §6.4 citée), et
  les MAC virtuelles FHRP (`fhrpOwnsVirtualMac`). Correct.
- **Switch** (`Switch.ts:1850-1852`) : le test de groupe utilise le **bit I/G**
  (LSB du premier octet), conformément à IEEE 802.3 §3.2.3 — c'est la bonne
  approche, qui couvre 01:00:5e, 33:33, 01:80:c2, etc.
- **EndHost** (`EndHost.ts:1396-1404`) : ❌ [MINEUR→MAJEUR selon usage] le filtre
  n'accepte que unicast-pour-soi, broadcast et multicast **IPv6** (`33:33`).
  Une trame multicast IPv4 (`01:00:5e:…`, ex. mDNS 224.0.0.251, SSDP, OSPF si un
  hôte devait l'écouter) est **silencieusement jetée par tout hôte**. Le routeur
  sait les recevoir, l'hôte non — asymétrie non documentée.
- Pas de mode promiscuous : un hôte sur hub ne « voit » jamais le trafic des
  autres, et le tcpdump du simulateur ne s'appuie de toute façon pas sur les
  trames reçues (§4, CaptureRouter).

### 2.4 Switch : apprentissage, aging, flooding — ✅ très bon

- **Apprentissage** clé `vlan:mac` avec détection de MAC move
  (`Switch.ts:1763-1796`), événements `switch.mac.learned/moved`. Les entrées
  statiques ne sont pas écrasées (l. 1768).
- **Aging** : réel, timer scheduler de 1 s (`startMACAgingProcess`,
  `Switch.ts:2279-2302`), défaut 300 s (`Switch.ts:212`), **fast aging sur
  topology-change STP** (802.1D §8.3.5, `stpFastAgingTime`, `Switch.ts:214`,
  `1555-1562`). Purge des MAC dynamiques sur link-down
  (`Switch.ts:668-670`) — exactement le comportement Catalyst. ✅
- **Flooding** (`floodFrame`, `Switch.ts:1960-2010`) : borné au VLAN d'ingress,
  respecte STP par VLAN, l'état des ports, PVLAN, port isolation, VLAN voix,
  pruning VTP, hybrid tagged/untagged, dot1q-tunnel. Unknown-unicast et
  broadcast/multicast floodent, multicast IPv4 contraint par IGMP snooping quand
  l'agent est actif (`resolveSnoopedMulticastEgressPorts`, `Switch.ts:1891-1903`,
  RFC 4541 citée). C'est du niveau d'un vrai bridge.
- La décision unicast connue ne renvoie jamais sur le port d'ingress
  (`Switch.ts:1873`). ✅

### 2.5 Routeur : pipeline L3 — ✅ fidèle, sauf fragmentation

- Sanity checks RFC 1812 §5.2.2 : **vérification effective du checksum IPv4**
  (`verifyIPv4Checksum`, appelée `Router.ts:1159`), version, IHL, totalLength
  (l. 1166-1188), avec compteur `ipInHdrErrors`. Le checksum est réellement
  recalculé à chaque décrément de TTL (`Router.ts:1558-1563`,
  `computeIPv4Checksum` `types.ts:714-745`, one's complement correct). ✅
- TTL : expire → ICMP Time Exceeded (l. 1539-1545) ; no route → ICMP
  Destination Unreachable code 0 (l. 1548-1555) ; ICMP redirect RFC 1812
  §5.2.7.2 (l. 1583-1591) ; ACL out avec ICMP admin-prohibited code 13
  (l. 1594-1605) ; NAT PREROUTING/POSTROUTING aux bons points du pipeline
  (l. 1191, 1608), ALG FTP inclus. ✅
- **MTU** : `totalLength > MTU sortie` + DF=1 → ICMP Frag-Needed code 4 avec MTU
  (l. 1569-1577) — PMTUD fonctionne. ❌ [MINEUR] **DF=0 : aucune fragmentation**,
  le paquet surdimensionné est forwardé tel quel (le `if` ne gère que DF=1,
  il n'y a pas de branche `else` de fragmentation). `Port.setMTU` borne
  68-9216 (`Port.ts:495-511`) mais l'émission côté `Port.sendFrame` ne vérifie
  jamais la taille de trame contre le MTU. 
- ARP : file d'attente des paquets pendant résolution (`queueAndResolve`,
  `Router.ts:1690`), réponse ARP y compris proxy-ARP conditionné à une route
  réelle (`Router.ts:1120-1143`), gratuitous ARP non répondu (l. 1117). ✅

### 2.6 Hub, duplex, collisions — ⚠️ L1 minimaliste

- `Hub.handleFrame` (`Hub.ts:25-33`) : répétition sur tous les autres ports, y
  compris ports down (c'est `Port.sendFrame` qui filtrera) — correct pour un
  répéteur. ✅
- ❌ [MINEUR] **Aucune modélisation de collision ni de CSMA/CD** : le seul
  usage du mot « collisions » dans le data plane est l'affichage figé `0
  collisions` (`CiscoShowCommands.ts:207`, `LinuxNetCommands.ts:239`).
  L'auto-négociation existe et est correcte (min des vitesses + câble, half si
  un côté half — `Port.negotiate`, `Port.ts:480-489` ; mismatch détecté et
  publié, `Cable.ts:165-174, 215-231`), mais le duplex négocié n'a **aucun effet
  sur la livraison** : il n'alimente que l'affichage (`CiscoShowCommands.ts:185`),
  le link-type STP (`CiscoSwitchShell.ts:3366`) et le délai EIGRP
  (`defaultInterfaceDelayUs`, `Port.ts:38-43`). Un duplex mismatch ne dégrade
  rien. Idem : vitesse, longueur de câble et délai de propagation
  (`Cable.getPropagationDelay`, `Cable.ts:117-119`) sont exposés en métadonnées
  mais jamais appliqués à la livraison.

### 2.7 Remontée L3 côté hôte — ✅

`EndHost.handleIPv4` (`EndHost.ts:1683-1717`) : firewall in (avec ICMP reject),
puis dispatch ICMP / **TCP → vraie pile** (`this.tcpv2.handleIp`,
`EndHost.ts:1702` ; la pile émet ses segments en vraies trames,
`TcpStack.ts:1351-1368`) / UDP / GRE. Forwarding hôte seulement si
`ipForwardEnabled` (l. 1712-1716), avec TTL/ICMP corrects (l. 1721-1727). Le
`ping` est authentiquement asynchrone-sur-le-fil : émission de trame + attente
d'événement bus `host.icmp.echo-reply` avec timeout scheduler
(`sendPing`, `EndHost.ts:2515-2611`). ✅

---

## 3. Asynchronisme : synchrone par conception, avec une bombe à retardement

### 3.1 Constat

- `Cable.transmit` livre **synchronement dans la même pile d'appels**
  (`Cable.ts:322-326`), et le commente : *« Phase 3: delivery stays synchronous…
  Phase 6 will migrate to scheduler-driven async delivery »*. Le délai de
  propagation est calculé mais non appliqué.
- Les **timers de protocole**, eux, passent bien par `src/events/Scheduler`
  (aging MAC `Switch.ts:2283`, port-security `Switch.ts:449-461`, STP
  `StpAgent.ts`, DHCP `TimerSet`, reload `CiscoShellBase.ts:84-94`). Le mélange
  « données synchrones / temps asynchrone » est cohérent en soi et rend les
  tests déterministes.
- Certains codes **exploitent** cette synchronicité comme un invariant :
  `WireDhcpChannel` (*« cable delivery being synchronous, the server's reply is
  in the inbox when `send` returns »*, `DhcpServerChannel.ts:6-8`),
  `EndHost.sendPingProbeSync` (`EndHost.ts:2828-2892`, s'abonne, envoie, se
  désabonne immédiatement), `Cable.connect` qui câble les deux extrémités avant
  de notifier pour que la réponse inverse fonctionne (`Cable.ts:133-139`).
  La future « Phase 6 » asynchrone **cassera silencieusement ces trois sites** —
  dette architecturale à tracer explicitement.

### 3.2 Risques et preuve empirique de la boucle L2

- **Boucle infinie → crash immédiat.** Test exécuté pendant l'audit (vitest,
  fichier temporaire hors dépôt) : deux `GenericSwitch` reliés par **deux**
  câbles + un hôte qui émet un broadcast →
  `RangeError: Maximum call stack size exceeded` (la pile explose dans
  `Logger.log`, `Logger.ts:87`, via `GenericSwitch.handleFrame`,
  `Switch.ts:1784`). Aucun garde-fou : ni budget de sauts par trame, ni
  identifiant de trame dédupliqué, ni profondeur de récursion max, ni file
  d'attente. Sur un vrai réseau, une tempête de broadcast sature ; ici, elle
  **tue l'onglet** (et en test, le process).
- `CiscoSwitch`/`HuaweiSwitch` sont protégés en pratique parce que leur
  `StpAgent` (vrais BPDU `ETHERTYPE_STP`, `StpAgent.ts:30+`, branché
  `CiscoSwitch.ts:80,194`) bloque un port dès la connexion — vérifié par
  `stp-protocol.test.ts:101-124` (exécuté : 29/29 verts avec
  `topology-roundtrip.test.ts`). Mais `GenericSwitch` n'instancie **aucun**
  StpAgent et démarre `forwarding` (`GenericSwitch.ts:23-25`), et un Hub
  bouclé sur lui-même ou deux hubs doublement câblés produisent le même crash.
  ❌ [CRITIQUE] : l'utilisateur peut construire cette topologie en trois
  glisser-déposer dans l'UI.
- **Ordre d'arrivée / starvation** : en synchrone profond-d'abord, une réponse
  peut être traitée *avant* que l'émetteur ait fini son propre `handleFrame`
  (réentrance). L'OSPF s'en protège au cas par cas (*« Reentrancy guard »*,
  `OSPFEngine.ts:1931`) — preuve que le problème a déjà mordu. Pas de politique
  générale.

---

## 4. Usages d'EquipmentRegistry : inventaire et verdict

Recensement exhaustif hors tests (`grep EquipmentRegistry|Equipment.getById|Equipment.getAllEquipment`,
17 fichiers de prod). Rappel du critère : traversée topologique pour
l'outillage/UI/tests = légitime ; lecture/écriture d'état d'un autre équipement
dans le chemin de données ou de contrôle = illégitime.

| # | Site | Usage | Verdict |
|---|---|---|---|
| 1 | `equipment/Equipment.ts:32-34, 75` | façade statique dépréciée + auto-registration au constructeur | ✅ légitime (infrastructure) |
| 2 | `store/networkStore.ts:276, 448` | deregister/clear à la suppression de device | ✅ légitime (cycle de vie UI) |
| 3 | `react/hooks/useDevices.ts`, `useHostObservables.ts`, `useEngineSignal.ts` | read-models UI pilotés par événements `device.registered/…` | ✅ légitime (projection UI, lecture seule) |
| 4 | `devices/inspection/EquipmentStateView.ts` | introspection debug/tests | ✅ légitime |
| 5 | `terminal/commands/database.ts:45-140` | résoudre le device **local** de la session terminal par id | ✅ légitime (glue terminal, pas de traversée) |
| 6 | `terminal/sessions/LinuxTerminalSession.ts` | idem (résolution du device de la session) | ✅ légitime |
| 7 | `devices/windows/server/ad/forest/Forest.ts:84` | simple commentaire comparatif | ✅ neutre |
| 8 | **`devices/linux/network/HostLookup.ts:26, 53, 121, 223`** | `findHostByAddress` (scan global IP→Equipment), `isPathReachable`/`findReachableHost` (BFS câbles), `transitTcpAclVerdict` (évalue les ACL des routeurs de transit sur un SYN **synthétique**, en lisant leur état via duck-typing `getInterfaceACL`/`evaluateACLByName`) | ❌ **ILLÉGITIME (data plane)** — c'est le moteur du contournement SSH/SCP/nc |
| 9 | **`devices/linux/network/LinuxSshClient.ts:795, 881`** + appels directs `machine.isServiceActive/sshdAcceptsLogin/executor.execute` (l. 812-1010) | tout le « TCP » du client SSH Linux est simulé par lecture directe de l'état distant ; idem `CiscoShellBase.ts:1473` (ssh depuis IOS) et `Nc.ts:205` | ❌ **ILLÉGITIME (data plane)** — malgré une vraie TcpStack disponible (`EndHost.ts:609`) |
| 10 | **`protocols/ssh/server/SshExecTarget.ts:9`** (doc) | le serveur d'exec SSH retrouve la `LinuxMachine` cible via le registre | ❌ illégitime (même famille que #8/#9) |
| 11 | **`devices/router/RouterOSPFIntegration.ts:613, 718, 749, 1103, 1139, 1185, 1532, 1588, 1619`** | `collectOSPFDomain()`/v3 : BFS via `Equipment.getById` puis `peer.installRoutes(...)` (l. 582), formation d'adjacences en manipulant directement les FSM des pairs | ❌ **ILLÉGITIME (control plane)** — convergence « assistée » ; les Hello/LSA sur le fil existent pourtant (`ospf.packet.outgoing` → `sendFrame` IP proto 89, `RouterOSPFIntegration.ts:198-216`) mais le SPF/l'installation de routes ne dépendent pas d'eux |
| 12 | **`devices/EndHost.ts:1069, 1093, 1115`** (`autoDiscoverDHCPServers`) | Stratégie 1 : traversée physique (câble→switch→routeur) pour **enregistrer l'objet `DHCPServer` distant en canal direct** (`registerServer`, `DHCPClient.ts:252`) ; résolution des `ip helper-address` par scan global (l. 1093) ; Stratégie 2 : scan global, **explicitement gaté aux hôtes non câblés** (l. 1104-1119, commentaire « god-mode shortcut this refactoring is removing ») | ⚠️ **GRIS** — le canal wire (vraies trames UDP 67/68) est essayé en premier (`DHCPClient.channelsFor`, l. 96-99), mais le canal direct reste enregistré même pour un hôte câblé et peut servir de repli hors-fil |
| 13 | **`devices/linux/nss/DnsNssSource.ts:133, 160`** (`legacyScanByName/Addr`) | repli NSS : si le DNS sur le fil ne répond pas, on résout un hostname en scannant les hostnames de **tous** les équipements | ❌ illégitime (résolution de noms hors-fil), acceptable seulement comme mode dégradé de tests — non gaté |
| 14 | **`devices/linux/commands/net/Traceroute.ts:240-253, 411-424`** | (a) enrichissement d'affichage des IPs d'un hop par scan registre ; (b) `anyRouterDeniesTracerouteUdp` : lit les ACL de **tous les routeurs du monde**, qu'ils soient sur le chemin ou non | (a) ⚠️ tolérable (présentation) ; (b) ❌ illégitime **et faux** (un ACL d'un routeur hors chemin change le résultat) |
| 15 | **`ipsec/IPSecEngine.ts:3814-3835`** (`findRouterByIP`, `findEquipmentByIP`) | localisation du pair IKE par scan global (+ accès `_getPortsInternal`) | ❌ illégitime (control plane IPSec) |
| 16 | **`devices/linux/network/CaptureRouter.ts:29, 46, 85`** | routage des « WireSegments » synthétiques vers les `captureLog` des devices par IP + reconstruction du port-mirroring par scan | ⚠️ GRIS — observabilité, mais construit un **canal de capture parallèle** au vrai fil : tcpdump peut montrer des paquets qui n'ont jamais traversé de câble (ceux du SSH god-mode) et rate la vision « transit » réelle |
| 17 | `devices/linux/network/HostLookup.isPathReachable` (rappel) | notons le repli : topologie **sans câbles** → « reachable » par défaut (l. 36-41) | ⚠️ compat tests, à gater explicitement |

**Bilan** : la couche hardware et les devices « purs » (Switch, Hub, Router
data plane, EndHost ICMP/UDP/TCP/DHCP-wire) sont propres. Les violations sont
concentrées dans **la couche applicative Linux (SSH/DNS/traceroute/capture)**,
**l'intégration OSPF**, et **IPSec** — c'est-à-dire précisément les endroits où
un vrai échange de paquets était le plus coûteux à écrire. La duplication du
BFS topologique (4 implémentations quasi identiques : `HostLookup.ts:53-97`,
`RouterOSPFIntegration.ts:586-633` et 693-740, `EndHost.ts:1062-1101`,
`CaptureRouter.ts` helpers) montre qu'il manque un service unique de traversée —
qui devrait de toute façon être réservé à l'outillage.

---

## 5. Constats par sous-système

### 5.1 Equipment / EquipmentRegistry

- ✅ Base classe compacte (253 l.) : identité, position, power, ports,
  `sendFrame`/`handleFrame` — le contrat data plane est minimal et clair
  (`Equipment.ts:216-252`). Le handler de port vérifie `isPoweredOn` à la
  réception (l. 220-224) et à l'émission (l. 233-236). ✅
- ✅ `EquipmentRegistry` injectable, événements de cycle de vie, reset de test
  (`EquipmentRegistry.ts:55-66`) — la façade statique est marquée `@deprecated`
  (`Equipment.ts:27`).
- ⚠️ [MINEUR] **Auto-enregistrement dans le constructeur**
  (`Equipment.ts:75`) : tout `new` d'un device — y compris dans un test ou un
  script — pollue le singleton global ; c'est la racine des scans « monde
  entier » du §4 (un device jamais ajouté au store est quand même trouvable par
  `findHostByAddress`).
- ⚠️ [MINEUR] Champs de plan de contrôle vendeur (`_enableSecret`,
  `_enablePassword`, `Equipment.ts:46-57`) dans la classe **racine** : un Hub a
  un enable secret. Mauvaise altitude (devrait vivre dans les devices à CLI).

### 5.2 Port / Cable / PortSecurity

- ✅ `Port` : IPv4 + secondaires, IPv6 (link-local EUI-64, SLAAC, DHCPv6 avec
  origines), origine d'adresse IPv4 (manual/dhcp/link-local) comme source de
  vérité multi-OS (`Port.ts:53-59`), compteurs, MTU borné, admin-down vs
  link-down distincts (`Port.ts:601-615`). Très complet.
- ✅ `PortSecurity` : verdicts explicites sans effets de bord
  (`PortSecurity.evaluate`, l. 172-220), sticky/statique/dynamique, aging
  absolute/inactivity, err-disable avec recovery timer côté Switch
  (`Switch.ts:407-437`). Conforme Catalyst.
- ✅ `Cable` : specs par type (vitesse max, longueur max, ns/m), validation de
  longueur, perte injectable avec RNG seedable (`Cable.ts:79-84`),
  auto-négociation au connect, détection duplex mismatch.
- ⚠️ [MINEUR] `Port.setMAC` casse le `readonly` par cast
  (`Port.ts:192`) ; le cast conditionnel absurde dans `Cable.negotiateLink`
  (`Cable.ts:207` : `cableMaxSpeed as typeof this.portA extends Port ? … : never`)
  est du bruit de type qui ne vérifie rien.
- ⚠️ [MINEUR] `Cable.setUp(false)` coupe la transmission mais ne notifie pas
  les ports (pas de link-down propagé, `Cable.ts:257-260`) — un câble « down »
  laisse les interfaces up/up, ce qu'aucun média réel ne fait.
- ❌ [MINEUR] Pas de vérification croisée type de port / type de câble
  (un câble `serial` accepte deux ports `ethernet` ; le crossover n'a aucune
  sémantique — pas de détection MDI/MDI-X, mais c'est cohérent avec l'époque
  auto-MDIX).

### 5.3 core/ (types, Logger, FilterChain)

- ✅ `types.ts` : `MACAddress`/`IPAddress`/`IPv6Address` riches (formats Cisco
  pointés, multicast mapping RFC 1112/2464), checksum IPv4 réellement calculé
  et vérifié (`types.ts:714-782`), `createIPv4Packet` avec DF par défaut et
  identification monotone. En-têtes fidèles (ihl, tos, flags, fragmentOffset).
- ✅ `Logger` : adaptateur pub/sub au-dessus du bus, ring buffer 10 000 entrées
  (`Logger.ts:54`), filtres par source/event/level.
- ✅ `FilterChain` : chaîne de responsabilité typée avec verdicts
  continue/accept/transform/drop/reject et événements — bon pattern, utilisé
  par IPSec.
- 💡 `CLAUDE.md` référence `core/NeighborResolver.ts` qui **n'existe pas**
  (le voisinage vit dans `devices/host/NeighborCache.ts`) — documentation à
  rafraîchir.
- ⚠️ [MINEUR] `EthernetFrame.payload: unknown` + tags dot1q ajoutés par
  intersection ad hoc (`TaggedEthernetFrame` défini dans `Switch.ts`) : le
  typage L2 réel (802.1Q) n'est pas dans `core/types.ts` où on l'attendrait.

### 5.4 Hub / Switch / vendeurs

- ✅ Hub : correct et honnête (40 l.).
- ✅ Switch (2 892 l.) : pipeline d'ingress ordonné de façon réaliste —
  SPAN d'abord (`mirrorIngress` avant tout drop, `Switch.ts:1590`), ACL de
  port, classification VLAN par mode (access/voice OUI/trunk QinQ/hybrid/
  dot1q-tunnel avec vlan-mapping sélectif), **drop STP par VLAN**
  (blocking/listening ne forwarde pas, learning apprend sans forwarder,
  `Switch.ts:1653-1657, 1840-1842`), DAI, DHCP snooping (rate-limit,
  verify-mac, drop réponses serveur sur port untrusted, bindings appris des
  **vrais** DHCPACK forwardés, `Switch.ts:1682-1761`), apprentissage MAC,
  interception SVI, VACL/MQC, décision forward/flood. C'est le morceau le plus
  abouti du simulateur.
- ✅ `CiscoSwitch`/`HuaweiSwitch` : StpAgent à vrais BPDU, DTP/VTP/CDP côté
  Cisco, LACP/IGMP-snooping selon vendeur, nommage de ports réaliste
  (Fa0/1-24 puis Gi0/1+ : `CiscoSwitch.ts:253-257` ; `GigabitEthernet0/0/N` :
  `HuaweiSwitch.ts:144`).
- ❌ [CRITIQUE, rappel §3.2] `GenericSwitch` : `getInitialSTPState() = 'forwarding'`
  sans agent STP → boucle = crash.
- ⚠️ [MINEUR] `advanceSTPTimer`/`setAllPortsSTPState` (`Switch.ts:1455-1470`) :
  API de manipulation directe de l'état STP conservée en parallèle de l'agent —
  deux sources de vérité possibles.

### 5.5 Router / CiscoRouter / HuaweiRouter

- ✅ Data plane : cf. §2.5. Sous-interfaces dot1q avec la différence
  Cisco/Huawei sur l'ARP broadcast (`Router.ts:1030-1051`) — détail vendeur
  rare et juste.
- ✅ `ping`/`traceroute` du routeur passent par de vraies trames avec attente
  événementielle (`Router.ts:2880-3070`), self-ping court-circuité proprement
  (rttMs 0.01, l. 2895).
- ❌ [MAJEUR] OSPF « assisté » (§4 #11) : le jour où l'on coupe un câble, c'est
  le handler de link-change qui rappelle `_ospfAutoConverge`
  (`Router.ts:493-500`) — la convergence est un recalcul global instantané
  déclenché par la CLI (`CiscoOspfCommands.ts:159` et ~20 autres sites), pas la
  conséquence des timers/LSA. Les tests « live » existants passent parce que
  l'assistance est là.
- ⚠️ [MAJEUR] **Duplication massive CiscoRouter/HuaweiRouter** : les
  constructeurs sont identiques à ~90 % (mêmes 20+ agents, même `hostBase`,
  même `defaultCoaSessionHandler` copié-collé — `CiscoRouter.ts:138-197` vs
  `HuaweiRouter.ts:80-140`). Un `RouterAgentBundle` factorisé éliminerait
  ~350 lignes dupliquées et le risque de divergence silencieuse.
- ✅ Le dispatch par `constructor.name` a été **résorbé** : la seule mécanique
  restante est `getOSType()` polymorphe + `primaryShellKindFor`
  (`shell/shellKind.ts:5-23`, qui documente l'ancien piège). `keepNames: true`
  reste dans `vite.config.ts:32` par prudence ; plus aucun site de prod ne
  dispatch sur le nom de classe (vérifié par grep). 💡 On peut planifier la
  suppression de `keepNames` après une passe de vérification.

### 5.6 EndHost / LinuxMachine / WindowsPC — taille et responsabilités

| Classe | Lignes | Rôle |
|---|---:|---|
| `EndHost.ts` | 3 885 | ARP/NDP, ICMP v4/v6, UDP, TCP glue, DHCP client (v4/v6), routes, firewall hooks, ping/traceroute UI |
| `Router.ts` | 3 289 | data plane + ping/trace + NVRAM + clock + intégrations |
| `LinuxMachine.ts` | 3 202 | ~118 membres, 178 méthodes ; importe ~40 sous-systèmes (DNS/Bind9, sshd, cron, tcpdump, vmstat/iostat/pidstat, sessions TTY, GRE…) |
| `WindowsPC.ts` | 3 139 | équivalent Windows |
| `Switch.ts` | 2 892 | cf. §5.4 |

- ⚠️ [MAJEUR] `LinuxMachine` **est un God object de façade** : la logique est
  bien déléguée à des services (`LinuxCommandExecutor`, `DnsService`,
  `CronEngine`, projections tcpdump/utmp/logind…), mais la classe reste le
  point de couplage de tout (héritage `EndHost` → `LinuxMachine` → `LinuxPC`/
  `LinuxServer` + ~40 imports). Le commentaire d'en-tête assume la « Phase 3 »
  (les sous-classes sont minces : `LinuxPC.ts` 37 l., `LinuxServer.ts` 239 l. —
  ✅ c'était le bon mouvement), mais la prochaine étape (composition par
  capacités, cf. `HostCapabilities.ts`) n'est pas faite.
- ✅ `devices/host/` est le bon embryon : `HostLifecycle` (machine à états
  off/running avec bus, `HostLifecycle.ts:28-67`), `identity/`, `hardware/`
  (PCI/USB/CPU factices pour `lshw` & co.), `NeighborCache`. L'héritage
  n'empêche pas que ces morceaux soient déjà composés, pas hérités. 
- ✅ Les surcharges `powerOn/powerOff` sont propres : le Switch perd sa DRAM
  (MAC table, VLANs, configs de ports réinitialisés — `Switch.ts:720-740`),
  arrête ses timers au powerOff (l. 701-718) ; l'hôte pilote son
  `HostLifecycle` (`EndHost.ts:801-815`).

### 5.7 DeviceFactory et devices stubbés (question 3)

`DeviceType` déclare 17 types (`types.ts:1419-1441`) ; implémentations réelles
(`DeviceFactory.ts:27-77`) :

| DeviceType | Classe réelle | `fullyImplemented` (deviceCatalog) | Écart |
|---|---|---|---|
| linux-pc, linux-server | LinuxPC/LinuxServer | true | ✅ |
| windows-pc, windows-server | WindowsPC/WindowsServer | true | ✅ |
| switch-cisco/-huawei/-generic, hub | vraies classes | true | ✅ |
| router-cisco/-huawei | vraies classes | true | ✅ |
| **mac-pc** | `LinuxPC` rebadgé | false | ❌ un « Mac » qui tourne sous bash Ubuntu (uname, apt…) |
| **firewall-cisco/-fortinet/-paloalto** | `LinuxPC` rebadgés | false | ❌ [MAJEUR] un « ASA/FortiGate/Palo Alto » expose un shell bash Linux et **aucune fonction pare-feu dédiée** (pas d'ASA CLI, pas de zones) ; seule la CLAUDE.md et le flag catalogue le disent |
| **access-point** | `Hub(4 ports)` | false | ❌ pas de Wi-Fi, pas de SSID — c'est un hub |
| **cloud** | `LinuxPC` | false | ❌ pas de WAN simulé |

Soit **6/17 types = façades**. Le flag `fullyImplemented` existe et
`isFullyImplemented()` est exposé (`DeviceFactory.ts:83-85`) — à vérifier que
l'UI l'affiche clairement (badge « bêta »), sinon c'est une promesse trompeuse
dans la palette. La duck-typing en aval doit rester robuste : `EndHost`
détecte un switch par `remoteType.includes('switch') || getSvis`
(`EndHost.ts:1079-1082`) précisément parce que les types ne sont pas fiables —
fragile.

### 5.8 Réalisme matériel (question 4)

- ✅ **Nommage** : `GigabitEthernet0/N` (CiscoRouter.ts:368-370), `GE0/0/N`
  (HuaweiRouter.ts:293-295), `FastEthernet0/1-24`+`GigabitEthernet0/N` sur
  Catalyst (CiscoSwitch.ts:253-257), `GigabitEthernet0/0/N` sur S-series,
  `eth0…` sur Linux (LinuxMachine.ts:1280, préfixe par profil). 
  ❌ [MINEUR] **WindowsPC nomme aussi ses cartes `eth0`** (`WindowsPC.ts:1425`) —
  un vrai Windows affiche « Ethernet », « Ethernet 2 » ; à vérifier si les
  cmdlets traduisent, sinon incohérence visible dans `ipconfig`.
- ⚠️ Routeurs : **4 ports fixes** (`Router.ts:484-490`), pas de châssis/modules
  (pas de `0/0/0` à 3 niveaux sur Cisco, pas de slots). Suffisant pour le
  périmètre actuel.
- ✅ Vitesses valides IEEE (10→100G, `types.ts:1447`), autoneg correcte, MTU
  68-9216. ⚠️ mais tout ceci est déclaratif (§2.6).
- ✅ Power on/off : événements bus, drop des trames si off
  (émission `Equipment.ts:233`, réception `Equipment.ts:220`), boot banner
  rejoué après vrai power-cycle (`_bootShown`, `Equipment.ts:145-196`),
  perte DRAM du switch réaliste.
- ❌ [MAJEUR] **Persistance startup vs running incomplète et trompeuse** :
  - `copy run start` capture un **texte** (`_captureStartupConfig`,
    `Router.ts:2469-2475`) — bien.
  - `reload` = `powerOff(); powerOn()` + reset du shell
    (`CiscoShellBase.ts:100-121`) : la running-config **objet** (OSPF, ACL,
    NAT, interfaces) survit intégralement au reload — l'inverse d'un vrai
    routeur (qui repart de la startup-config). Une config non sauvegardée
    devrait disparaître ; ici elle persiste.
  - `copy start run` ne ré-applique **rien** : `_restoreStartupConfig()`
    retourne juste `snapshot !== null` (`Router.ts:2472-2474`) et le shell
    imprime `[OK]` (`CiscoShellBase.ts:1224-1228`). Il existe pourtant un
    `_applyConfigText` utilisé pour `copy flash: running-config`
    (`CiscoShellBase.ts:1234-1240`) — le brancher sur le snapshot serait le
    correctif naturel.
- ⚠️ [MAJEUR] **Sérialisation de topologie partielle** : `topologySerializer.ts`
  (schéma v1, l. 30-105) ne capture que interfaces (IP/mask/up/desc/secondaires),
  gateway, routes statiques, ARP statique, 3 fichiers Linux (`/etc/hosts`,
  `resolv.conf`, `hostname` — l. 107), VLANs et switchports (mode/access/native).
  **Perdus au round-trip** : toute la config routeur (OSPF/BGP/ACL/NAT/etc.),
  la startup-config, les trunks allowed lists, port-security, le contenu du
  VFS Linux hors 3 fichiers, les users, les services. Le test
  `topology-roundtrip.test.ts` passe parce qu'il ne teste que le périmètre
  couvert.

### 5.9 Pont store ↔ Equipment ↔ UI (question 5, volet intégration)

- ✅ `networkStore.ts` (465 l.) est mince et bien pensé : instances `Equipment`
  dans une Map, connexions portant le vrai `Cable`, suppression de device qui
  déconnecte les câbles, publie `device.removed`, powerOff puis deregister
  (`networkStore.ts:246-291`) ; `clearAll` éteint proprement chaque device
  avant `registry.clear()` (l. 432-462).
- ✅ Anti-tempête de re-render documenté et correct : snapshots
  référentiellement stables (`stableDeviceUI` + WeakMap, l. 147-190) et tick
  `revision` pour le drag (l. 311-321) au lieu de recopier la Map par pixel.
- ⚠️ [MINEUR] `NetworkDeviceUI.instance: Equipment` (l. 97) expose l'objet
  vivant à tout composant React — le principe « read-model » de
  `useDevices.ts:6-8` (*« the UI doesn't hold direct references »*) n'est pas
  appliqué partout ; deux philosophies coexistent.
- ✅ **Animation de paquets honnête** : `useActivePackets` s'abonne à
  `cable.frame.dispatched` (`useActivePackets.ts:36-57`) — chaque point animé
  correspond à une vraie trame sur un vrai câble ; classification
  broadcast/ARP/ICMP/data par inspection de la trame réelle. Plafond de 64
  paquets simultanés et durée fixe 600 ms (l. 8-9) : le délai de propagation du
  câble est ignoré (cohérent, puisque la livraison est instantanée). 
  ⚠️ Conséquence du §4 : **les sessions SSH god-mode n'animent rien** (aucune
  trame émise) alors qu'un ping anime — incohérence visible par l'utilisateur
  attentif, et bon test d'acceptation pour la remédiation.
- ✅ `isConnectionActive` (l. 73-82) croise état des ports **et** power des
  deux extrémités.

---

## 6. Top 10 des actions recommandées

1. **[CRITIQUE] Casser la récursion synchrone des trames** : introduire une
   file de livraison par équipement (ou un budget de sauts par trame — un champ
   `hopBudget` décrémenté dans `Cable.transmit` suffirait en garde-fou
   immédiat), puis exécuter la « Phase 6 » annoncée (`Cable.ts:322-325`) via le
   `Scheduler`. Recenser et corriger d'abord les 3 sites qui dépendent de la
   synchronicité (`DhcpServerChannel.ts:6`, `EndHost.sendPingProbeSync:2828`,
   `Cable.connect:133`).
2. **[CRITIQUE] Rebrancher SSH/SCP/SFTP/nc sur la vraie pile** : la TcpStack
   existe et fonctionne (`EndHost.ts:609, 1702` ; `TcpStack.ts:1351`) ; faire du
   client SSH un consommateur de `tcpv2.connect()` et du serveur un listener
   réel, et réserver `HostLookup.findHostByAddress` à la résolution de noms
   d'outillage. Supprimer `transitTcpAclVerdict` (le SYN réel traversera les
   ACL réelles des routeurs réels). Critère d'acceptation : une session SSH
   anime des paquets sur le canvas et apparaît dans un tcpdump de transit.
3. **[MAJEUR] Protéger l'utilisateur des boucles L2** : soit donner un StpAgent
   au `GenericSwitch` (désactivable), soit détecter la tempête (compteur de
   trames par milliseconde) et couper le port avec un événement
   `broadcast-storm` — un vrai switch a du storm-control ; c'est aussi une
   opportunité pédagogique.
4. **[MAJEUR] Rendre OSPF honnête** : faire de l'échange Hello/LSA sur le fil
   la seule source des adjacences et du SPF ; réduire `_ospfAutoConverge` à un
   « kick » local (re-émettre les Hello), supprimer `collectOSPFDomain`/
   `installRoutes` inter-équipements (`RouterOSPFIntegration.ts:582-633`).
   Même traitement pour `IPSecEngine.findRouterByIP` (l. 3814).
5. **[MAJEUR] Restaurer la sémantique startup/running** : au `reload`,
   réinitialiser l'état objet du device puis rejouer le snapshot via le
   `_applyConfigText` existant (`CiscoShellBase.ts:1238`) ; faire de
   `copy startup-config running-config` un vrai merge. Ajouter un test
   « config non sauvegardée perdue au reload ».
6. **[MAJEUR] Étendre `topologySerializer`** aux running-configs vendeur
   (le texte de `getRunningConfig` existe déjà — l'export/réimport via
   `_applyConfigText` est le chemin le plus court) et au VFS Linux minimal.
7. **[MAJEUR] Ajouter FCS/immutabilité au contrat de trame** : a minima
   `Readonly<EthernetFrame>` dans les signatures + clonage au flood du hub,
   idéalement un champ `fcs` calculé à l'émission et vérifié à la réception
   (avec corruption possible par le câble au lieu de la seule perte).
8. **[MAJEUR] Factoriser les constructeurs CiscoRouter/HuaweiRouter**
   (bundle d'agents + `hostBase` commun, ~350 lignes dupliquées) et extraire un
   service unique de traversée topologique (BFS) taggé « outillage uniquement »,
   utilisé par debug/UI/tests, pour tuer les 4 implémentations divergentes.
9. **[MINEUR] Corriger le filtre L2 des hôtes** : accepter `01:00:5e:…`
   (multicast IPv4) dans `EndHost.handleFrame` (`EndHost.ts:1399-1401`) avec
   vérification d'abonnement IGMP, comme c'est déjà fait pour IPv6.
   Corriger aussi `anyRouterDeniesTracerouteUdp` (`Traceroute.ts:409-424`)
   qui lit les ACL de routeurs hors chemin.
10. **[MINEUR] Hygiène** : gater `DnsNssSource.legacyScan*` et le repli
    « pas de câble = reachable » (`HostLookup.ts:36-41`) derrière un mode
    explicite (`SIMULATOR_COMPAT`), nommer les NIC Windows « Ethernet N »,
    propager le link-down quand `Cable.setUp(false)`, mettre à jour CLAUDE.md
    (`NeighborResolver.ts` n'existe pas), et planifier la suppression de
    `keepNames` maintenant que le dispatch `constructor.name` a été éliminé
    (`shell/shellKind.ts:5-11`).

---

### Annexe — reproduction du crash de boucle L2 (§3.2)

Test exécuté hors dépôt (vitest, alias `@` → `src`) : deux `GenericSwitch`
(4 ports), deux câbles entre eux (`eth0↔eth0`, `eth1↔eth1`), un port hôte nu
câblé sur `eth2`, émission d'une trame broadcast → résultat :

```
ERROR: RangeError: Maximum call stack size exceeded
    at LoggerSingleton.log (src/network/core/Logger.ts:87:18)
    at GenericSwitch.handleFrame (src/network/devices/Switch.ts:1784)
```

Aucun fichier du dépôt n'a été modifié pour cette reproduction.

### Annexe — tests exécutés pendant l'audit

- `npx vitest run src/__tests__/unit/network-v2/stp-protocol.test.ts src/__tests__/unit/network-v2/topology-roundtrip.test.ts` → 29/29 ✅
  (confirme le blocage STP data-plane sur boucle avec `CiscoSwitch`, et le
  périmètre — limité — du round-trip de topologie).

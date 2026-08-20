# PRD — Limites de `tcpdump` actuellement implémenté

**Version** : 1.0
**Date** : 2026-07-06
**Projet** : Ubuntu Sandbox — simulateur réseau navigateur
**Auteur** : Claude (agent), à la demande de l'utilisateur
**Références normatives** :
- `tcpdump(8)`/`pcap-filter(7)` (comportement de référence de l'outil réel, libpcap 1.10.x)
- RFC 826 (ARP), RFC 792 (ICMP), RFC 9293 (TCP), RFC 768 (UDP), RFC 8200 (IPv6)
- IEEE 802.1Q (VLAN tagging)
- Format PCAP classique / PCAPNG (libpcap file format)

---

## 0. Contexte et portée du document

Ce PRD documente, sans les corriger, **toutes les limites vérifiées** de la
commande `tcpdump` réellement implémentée dans ce dépôt, par comparaison avec
le comportement de l'outil réel. Il couvre l'ensemble de la chaîne : parsing
de la ligne de commande, langage de filtre (BPF-like), décodage de trame,
formatage de sortie, et — point central de ce PRD — **le routage de la
commande selon la façon dont elle est invoquée** dans le shell simulé.

Toutes les observations ci-dessous sont issues d'une lecture complète de :
- `src/network/devices/linux/network/tcpdump/TcpdumpCli.ts` (222 lignes)
- `src/network/devices/linux/network/tcpdump/TcpdumpFilter.ts` (425 lignes)
- `src/network/devices/linux/network/tcpdump/TcpdumpFormat.ts` (181 lignes)
- `src/network/devices/linux/network/tcpdump/TcpdumpRunner.ts` (151 lignes)
- `src/network/devices/linux/network/tcpdump/CaptureFrame.ts` (367 lignes)
- `src/network/devices/linux/network/PacketCaptureLog.ts` (105 lignes)
- `src/network/devices/linux/network/WireCaptureBus.ts` (47 lignes)
- `src/network/devices/linux/network/CaptureRouter.ts` (115 lignes)
- `src/network/devices/linux/network/TcpdumpCaptureProjection.ts` (72 lignes)
- La portion `tcpdump` de `src/network/devices/linux/LinuxNetCommands.ts`
  (`parseTcpdumpArgs`/`cmdTcpdump`/`serializeCapture`/`deserializeCapture`)
- Le dispatch de commande dans `src/network/devices/LinuxMachine.ts`
  (`executeCommand`, `isTcpdumpCommand`, `runTcpdumpCommand`,
  `buildTcpdumpDeps`, `openTcpdumpCapture`)
- L'intégration terminal dans `src/terminal/sessions/LinuxTerminalSession.ts`
  (`tryStartTcpdump`)
- La suite de tests existante (`tcpdump.test.ts` — 989 lignes,
  `tcpdump2.test.ts` — 417 lignes, `linux-tcpdump-stream-ui.test.ts` — 78
  lignes) — pas d'une supposition sur ce qu'un tel simulateur "devrait" avoir.

### 0.1 Principe directeur

Comme pour les PRD précédents (`PRD-TCP.md`, `PRD-ip.md`, `PRD-netsh.md`) :
ce document sépare strictement le **constat** (§1, vérifié dans le code) de la
**proposition** (§2 à §8, un plan de remédiation prêt à être exécuté phase par
phase si l'implémentation est demandée). Toute correction future devra rester
**additive et testée** : le comportement observable des tests déjà verts ne
doit pas régresser.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Lignes |
|---|---|---|
| `tcpdump/TcpdumpCli.ts` | Parseur de la ligne de commande (`-i/-c/-s/-n/-t.../-v.../-e/-q/-A/-x/-X/-w/-r/-y/--linktype`, etc.) → `TcpdumpOptions` | 222 |
| `tcpdump/TcpdumpFilter.ts` | Compilateur du langage de filtre façon BPF (`host/net/port/portrange/proto/ether/tcp/udp/icmp/ip/ip6/arp/vlan`, `and/or/not`, parenthèses) → prédicat sur `CaptureFrame` | 425 |
| `tcpdump/TcpdumpFormat.ts` | Formatage une-ligne façon tcpdump réel (`Flags [S]`, `IP a.b.c.d.port > ...`), horodatage (`-t/-tt/-ttt/-tttt`), hexdump/ASCII | 181 |
| `tcpdump/TcpdumpRunner.ts` | Orchestrateur : parse → filtre → capture à fenêtre de temps fixe → formate ; lit/écrit un format de fichier maison | 151 |
| `tcpdump/CaptureFrame.ts` | Décodage d'une vraie trame Ethernet (ARP/IPv4/ICMP/TCP/UDP) en `CaptureFrame` riche, plus deux constructeurs synthétiques (`makeTcpFrame`, `makeLoopbackIcmpFrame`) | 367 |
| `PacketCaptureLog.ts` | Anneau de capture **TCP uniquement** (256 paquets), documenté comme tel dans son propre commentaire | 105 |
| `WireCaptureBus.ts` | Bus legacy publiant des `WireSegment` (TCP) depuis les commandes ssh/telnet/nc historiques | 47 |
| `CaptureRouter.ts` | Routeur legacy : retrouve les hôtes concernés **par simple correspondance d'adresse IP globale** (pas par topologie réelle de port/câble), plus un support de port-mirroring (SPAN) partiel | 115 |
| `TcpdumpCaptureProjection.ts` | Pont bus réel : `tcp.segment.sent/received` de `TcpStack` → `PacketCaptureLog` | 72 |
| `LinuxNetCommands.ts` (`cmdTcpdump` et alentours) | **Troisième implémentation**, indépendante, primitive : `-i/-c/-A/-X/-XX/-w/-r` + un seul `port N` nu, entièrement synchrone, lit uniquement le backlog déjà accumulé de `PacketCaptureLog` | ~130 |
| `LinuxMachine.ts` (`executeCommand`, `isTcpdumpCommand`, `openTcpdumpCapture`) | Routeur de commande + fournisseur du flux de trames réel par port (`port.frame.received/tx-requested`) + rejeu du backlog `PacketCaptureLog` | — |
| `LinuxTerminalSession.ts` (`tryStartTcpdump`) | Implémentation interactive réellement utilisée depuis l'UI terminal : réutilise `TcpdumpCli`/`TcpdumpFilter`/`TcpdumpFormat`, diffusion en direct + Ctrl+C | — |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

- **Le langage de filtre (`TcpdumpFilter.ts`) est un sous-ensemble large et
  réellement fonctionnel** de la grammaire BPF de tcpdump : `host`/`net`/
  `port`/`portrange`/`proto`/`ether host|src|dst`/`tcp`/`udp`/`icmp`/`icmp6`/
  `ip`/`ip6`/`arp`, qualificatifs `src`/`dst`, `and`/`or`/`not` (et `&&`/`||`/
  `!`), parenthèses imbriquées, messages d'erreur `tcpdump: error: ...`
  fidèles au style réel.
- **Le décodage IPv4/ARP/ICMP/TCP/UDP (`CaptureFrame.ts`) est détaillé et
  réaliste** : vrais champs d'en-tête (TTL, ID, protocole), jetons de flags
  TCP façon tcpdump (`Flags [S]`, `Flags [S.]`, `Flags [P.]`…), format
  `IP a.b.c.d.port > w.x.y.z.port: ...` fidèle à l'outil réel.
- **La capture interactive depuis le terminal (`LinuxTerminalSession.
  tryStartTcpdump`) est une bonne expérience utilisateur pour le cas
  courant** : diffusion en direct réellement indéfinie, Ctrl+C imprime le
  résumé final comme l'outil réel (`TD-01` dans `linux-tcpdump-stream-ui.
  test.ts` le confirme).
- **Les modes d'horodatage `-t/-tt/-ttt/-tttt` sont implémentés avec le bon
  format/la bonne précision** (epoch, delta HH:MM:SS.micros, datetime).
- **`openTcpdumpCapture` capture bien par port réel** (`port.frame.received`/
  `port.frame.tx-requested` filtrés par `deviceId`+nom de port), donc une
  interface non promiscuité ne voit en principe que son propre trafic — un
  vrai modèle de visibilité par interface, pas un "tout le monde voit tout".
- **Un support partiel de port-mirroring (SPAN)** existe côté legacy
  (`CaptureRouter.ts`), utile pour illustrer un scénario "commutateur avec
  session SPAN" même si limité au trafic TCP legacy.

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **Trois implémentations de `tcpdump` coexistent, et l'usage shell normal bascule silencieusement vers la plus faible.** `LinuxMachine.isTcpdumpCommand` n'accepte que `tcpdump` en tête de ligne **sans pipe** (`splitTopLevel(noSudo, '\|').length > 1` fait échouer la détection). Dès qu'on tape `tcpdump ... \| grep SYN`, `tcpdump -w cap.txt && echo ok`, ou qu'on lance `tcpdump ...` en arrière-plan, la commande retombe dans l'interpréteur bash générique puis dans `LinuxCommandExecutor`, qui appelle `cmdTcpdump` (`LinuxNetCommands.ts`) — une implémentation totalement différente et bien plus pauvre. | Comportement réel : `tcpdump` se comporte identiquement quel que soit son contexte d'invocation shell | **Critique** |
| 2 | **Cette implémentation "de repli" (`cmdTcpdump`) ne comprend qu'une poignée de drapeaux** (`-i`, `-c`, `-A`, `-X`/`-XX`, `-w`, `-r`) et un unique filtre `port N` nu — aucune grammaire BPF (`host`, `net`, `tcp`, `udp`, `icmp`, `and`/`or`/`not`…). Une expression de filtre BPF valide (`tcp and port 443`) y est simplement ignorée (aucun token n'est reconnu comme un filtre, donc rien n'est filtré). | `pcap-filter(7)` | **Critique** |
| 3 | **Cette même implémentation de repli est TCP uniquement.** Elle lit `PacketCaptureLog`, dont le commentaire de tête l'affirme explicitement : *"traffic of interest — TCP handshakes"*. Un `ping`, une requête DNS, un ARP, jamais capturés par ce chemin, quel que soit le filtre demandé. | Visibilité multi-protocole d'un vrai `tcpdump` | **Critique** |
| 4 | **Cette même implémentation de repli est entièrement synchrone et non "live".** `cmdTcpdump` lit `log.all()` (le backlog déjà accumulé) et retourne **instantanément** — aucune attente, aucun flux. `tcpdump -c 5 \| grep SYN` ne peut donc jamais capturer un paquet généré *pendant* l'exécution de la commande ; seul ce qui existait déjà avant l'appel peut apparaître. | `tcpdump` réel attend et affiche au fil de l'eau | **Critique** |
| 5 | **`-w`/`-r` n'utilisent pas le format PCAP/PCAPNG réel, et les deux implémentations internes ne s'accordent même pas entre elles.** `TcpdumpRunner.persistCapture` écrit un blob maison `"TCPDUMPSIM1\n" + JSON.stringify(frames)` ; `cmdTcpdump`/`serializeCapture` écrit du JSON brut sans en-tête magique. Un fichier écrit par l'un est illisible par le `-r` de l'autre (message `unknown file format`/`bad dump file`), et aucun des deux n'est ouvrable par un vrai Wireshark/tcpdump/scapy — ce qui annule l'intérêt même de `-w` (capturer ici, analyser ailleurs). | Format PCAP classique/PCAPNG (libpcap) | **Critique** |
| 6 | **IPv6 est à peine décodé.** Dans `CaptureFrame.decodeEthernetFrame`, la branche `ETHERTYPE_IPV6` détermine seulement `l3`/`l4` (tcp/udp/icmp6/other) mais **n'extrait jamais** ports source/destination, flags TCP, séquence/ack, ni la longueur de payload — un TCP/UDP sur IPv6 s'affiche `IP6 <adresse> > <adresse>: TCP, length N` sans aucun port. De plus `raw`/l'offset de trame restent vides pour IPv6, donc `-x`/`-X` n'affiche rien d'exploitable. | Parité de décodage IPv4/IPv6 d'un vrai `tcpdump` | Élevée |
| 7 | **Les expressions de filtre par tranche d'octets (`tcp[13]`, `ip[0]&0xf0`, `tcp[tcpflags] & tcp-syn != 0`) sont reconnues syntaxiquement mais toujours évaluées à vrai.** `TcpdumpFilter.parseByteSlice` consomme les tokens jusqu'à la limite suivante puis retourne inconditionnellement le prédicat `ALWAYS` — l'idiome classique "ne montrer que les SYN via décalage d'octet" capture silencieusement tout le trafic au lieu de filtrer. Les constantes nommées (`tcp-syn`, `tcp-ack`, `tcp-fin`…) ne sont même pas reconnues comme tokens. | `pcap-filter(7)` §"Byte offset expressions" | Élevée |
| 8 | **`vlan <id>` ne matche jamais rien** (`parseVlan` retourne le prédicat `() => false` sans condition, même si l'ID est syntaxiquement validé), et il n'existe aucun décodage/affichage de tag VLAN dans le formateur de sortie, filtre ou non. | IEEE 802.1Q, `pcap-filter(7)` | Élevée |
| 9 | **Une capture "riche" (via `openTcpdumpCapture`) peut compter certains segments TCP en double.** Cette méthode s'abonne à la fois aux événements réels de trame par port (`port.frame.received`/`tx-requested`, décodage complet via `decodeEthernetFrame`) **et** rejoue/s'abonne inconditionnellement à `executor.captureLog` (alimenté indépendamment par `TcpdumpCaptureProjection` depuis les mêmes événements `tcp.segment.sent/received` de `TcpStack`). Un même segment TCP réel peut donc atteindre le récepteur deux fois : une fois décodé réalistement, une fois reconstruit de façon synthétique (`makeTcpFrame`, MAC/TTL/checksum factices). | Un paquet réel n'est capturé qu'une fois par interface | Moyenne |
| 10 | **Aucune capture réellement indéfinie hors de l'UI terminal.** `TcpdumpRunner.runCapture` (seul chemin atteint pour `-r`/`-w`/`--help`, et pour tout appel direct type test/`executeCommand()`) code en dur une fenêtre de 200 ms sans `-c`, ou abandonne après 3000 ms si `-c` n'est pas atteint — impossible d'y obtenir un "tourne jusqu'à Ctrl+C". Seule la ré-implémentation propre à `LinuxTerminalSession` supporte un flux vraiment indéfini, et seulement pour le cas non-pipé/non-`-r`/non-`-w`. | `tcpdump` réel tourne jusqu'à interruption (SIGINT) sans `-c` | Moyenne |
| 11 | **La plupart des drapeaux CLI acceptés sont silencieusement inertes.** `-Q in\|out\|inout` (direction — jamais comparée à `frame.direction`), `-G`/`-W`/`-z` (rotation temporelle + post-traitement), `-j` (source d'horodatage), `-T` (forçage du type de protocole), `-E`/`-M` (clés ESP/TCP-MD5), et la plupart des drapeaux booléens à une lettre au-delà de `-e`/`-q`/`-A` (`-S`, `-l`, `-p`, `-N`, `-O`, `-U`, `-b`, `-I`, `-K`, `-H`, `-L`, `-u`) sont reconnus (donc n'échouent pas) mais n'ont strictement aucun effet. | `tcpdump(8)` | Moyenne |
| 12 | **Aucune granularité de verbosité.** `-v`/`-vv`/`-vvv` réels révèlent progressivement plus d'informations (TTL/ID/flags/vérification de checksum à `-v`, détail fragmentation/options IP en plus à `-vv`, détail couche liaison en plus à `-vvv`). Ici, `opt.verbose` est bien compté par le parseur CLI mais `TcpdumpFormat.ipLine` ne teste que `opt.verbose > 0` — un seul niveau binaire, aucune distinction `-v`/`-vv`/`-vvv`. | `tcpdump(8)` | Moyenne |
| 13 | **Aucun calcul/vérification de checksum n'est jamais affiché**, alors que la sortie `-v` réelle inclut `cksum 0x____ (correct)`/`(incorrect)` pour IP/TCP/UDP/ICMP — utile pour illustrer un scénario de paquet corrompu, que `Cable` peut déjà simuler mais que `tcpdump` ne peut pas révéler. | `tcpdump(8)` (option `-v`) | Moyenne |
| 14 | **Aucune option TCP n'est jamais affichée dans la ligne de flags**, alors que `TcpStack.ts` négocie désormais réellement MSS/window-scale/SACK/timestamps sur le fil (cf. `PRD-TCP.md`, phase P6). Un vrai `tcpdump` affiche `options [mss 1460,sackOK,TS val ... ecr 0,nop,wscale 7]` sur un SYN ; ici `CaptureFrame` n'a même pas de champ pour les options TCP, donc la capture perd cette information pourtant désormais réelle dans `TcpSegment.options`. | `tcpdump(8)` (affichage des options TCP) | Moyenne |
| 15 | **Aucun indicateur de fragmentation IP n'est jamais affiché.** L'en-tête verbeux de `TcpdumpFormat.ipLine` code en dur `flags [none]` quels que soient les bits DF/MF ou l'offset de fragment réels du paquet. | `tcpdump(8)` (affichage `flags [DF]`/`flags [+]`) | Faible |
| 16 | **Aucune analyse applicative (couche 7).** Pas de résumé DNS (`A? example.com.`) sur UDP/53, pas de ligne de requête HTTP résumée, etc. — un vrai `tcpdump` par défaut résume DNS/NTP/etc. pour les ports bien connus ; ici, tout paquet UDP affiche uniquement `UDP, length N` quel que soit le port ou le contenu. | `tcpdump(8)` (dissecteurs applicatifs intégrés) | Faible |
| 17 | **La troncature par `-s`/snaplen est appliquée au hexdump mais jamais reflétée dans le résumé une-ligne** (`length N` rapporte toujours la longueur d'origine complète, jamais un marqueur de troncature façon `[\|tcp]` qu'un vrai tcpdump affiche quand le snaplen a coupé dans l'en-tête). | `tcpdump(8)` | Faible |
| 18 | **`-D`/`--list-interfaces` n'affiche jamais d'état d'interface varié** (toujours `[Up, Running]` pour toute interface, jamais `[Down]` pour une interface arrêtée, pas de MAC/description comme le vrai `tcpdump -D`). | `tcpdump -D` réel | Faible |
| 19 | **`-r` combiné à `-c` n'est pas honoré par `TcpdumpRunner.readCaptureFile`** (`opt.count` y est totalement ignoré, tous les paquets correspondants du fichier sont imprimés) — alors que le chemin `cmdTcpdump` respecte bien `-c` en lecture de fichier ; les deux implémentations divergent donc aussi sur ce point précis. | `tcpdump -r file -c N` réel | Faible |
| 20 | **Les mots-clés de filtre `multicast`/`broadcast` matchent toujours tout** (prédicat `ALWAYS`) au lieu de comparer la MAC/l'IP de destination aux plages multicast/broadcast réelles. | `pcap-filter(7)` | Faible |

---

## 2. Objectifs

### 2.1 Objectifs de ce PRD (remédiation proposée, non encore engagée)

1. **Unification du routage de commande.** Quelle que soit la forme
   d'invocation (`tcpdump ...` seul, `tcpdump ... \| grep`, `tcpdump ...
   > fichier`, `tcpdump ...` en arrière-plan, dans un script), la même
   implémentation riche (`TcpdumpRunner`/`openTcpdumpCapture`) est utilisée.
   `cmdTcpdump`/`parseTcpdumpArgs`/`serializeCapture`/`deserializeCapture`
   de `LinuxNetCommands.ts` sont supprimés une fois qu'aucun chemin ne les
   appelle plus (nettoyage de code mort, comme `core/TcpConnection.ts` dans
   `PRD-TCP.md`).
2. **Format de capture unique et cohérent pour `-w`/`-r`.** Un seul format
   interne (JSON documenté, versionné) partagé par tous les chemins de
   code — pas nécessairement le binaire PCAP/PCAPNG réel (voir non-objectifs
   §2.2), mais au minimum auto-cohérent : un fichier écrit par ce simulateur
   est toujours relisible par ce même simulateur, sur n'importe quel appareil.
3. **Parité IPv4/IPv6 dans `CaptureFrame`.** Ports, flags TCP,
   séquence/ack, longueur de payload, et octets bruts pour le hexdump sont
   extraits pour IPv6 exactement comme pour IPv4.
4. **Filtres par tranche d'octets et VLAN réellement évalués.** `tcp[13] &
   2 != 0` (et les autres formes `<proto>[offset(:len)]`, avec masque et
   comparateur) sont réellement interprétés contre les octets bruts de la
   trame ; les constantes nommées (`tcp-syn`, `tcp-ack`, `tcp-fin`, `tcp-rst`,
   `tcp-psh`, `tcp-urg`) sont reconnues. `vlan <id>` matche réellement un tag
   802.1Q décodé (et un futur support de VLAN dans la couche Ethernet du
   simulateur, si nécessaire) plutôt que de toujours retourner faux.
5. **Déduplication de la capture live.** Un seul événement de capture par
   segment réellement observé sur l'interface, quelle que soit la source
   interne (frame de port ou pont `TcpStack`).
6. **Capture réellement indéfinie hors de l'UI terminal.** `TcpdumpRunner`
   attend indéfiniment (jusqu'à annulation explicite) quand ni `-c` ni un
   signal d'arrêt ne sont fournis, au lieu d'une fenêtre de temps fixe
   arbitraire — même mécanisme d'annulation que celui déjà utilisé par
   `LinuxTerminalSession` (checkpoint de régression complète).
7. **Niveaux de verbosité réels (`-v`/`-vv`/`-vvv`)**, avec vérification de
   checksum affichée à `-v` et affichage des options TCP négociées
   (MSS/window-scale/SACK/timestamps, désormais réelles depuis
   `PRD-TCP.md`) sur les segments qui en portent.
8. **Indicateurs de fragmentation IP réels** dans l'en-tête verbeux (`flags
   [DF]`/`flags [+]`/décalage réel) et **dissection DNS minimale** sur
   UDP/53 (une ligne de résumé requête/réponse, pas un décodeur complet) —
   checkpoint de régression complète, fin du PRD.

### 2.2 Non-objectifs (explicitement hors périmètre)

- **Fidélité binaire PCAP/PCAPNG octet-exacte** (ouvrable par un vrai
  Wireshark) — hors périmètre tant qu'aucun besoin concret d'interopérabilité
  avec un outil externe réel n'est exprimé ; le format interne unifié (§2.1
  point 2) suffit pour un usage interne cohérent.
- **Dissection applicative complète** (HTTP, TLS, DNS au-delà d'un résumé
  minimal) — seul un résumé DNS élémentaire est dans le périmètre (#16 de
  la gap analysis), pas un décodeur DNS complet (déjà couvert côté
  protocole par les PRD DNS existants, pas par `tcpdump`).
- **RFC 5961/anti-spoofing, sécurité de capture, ou mode promiscuité
  générique** — la visibilité par interface déjà en place (§1.2) suffit au
  périmètre pédagogique actuel.
- **`-Z` (drop de privilèges), `-E`/`-M` (déchiffrement ESP / clés
  TCP-MD5)** — aucun trafic chiffré réel à déchiffrer dans ce simulateur
  aujourd'hui ; conservés comme drapeaux acceptés-mais-inertes, non
  implémentés dans ce PRD.
- **Réécriture de `SocketTable`/`TcpSocketStateProjection`** — hors
  périmètre, non concernés par ce PRD.

---

## 3. Architecture cible

### 3.1 Principe directeur

`TcpdumpRunner.ts` (+ `TcpdumpCli`/`TcpdumpFilter`/`TcpdumpFormat`/
`CaptureFrame`) devient la **seule** implémentation de `tcpdump` dans le
dépôt, atteinte par les trois points d'entrée existants (invocation directe
non-pipée via `LinuxMachine`, invocation interactive via
`LinuxTerminalSession`, et — nouveauté de ce PRD — invocation composite/pipée
via `LinuxCommandExecutor`). `cmdTcpdump` et le reste de la portion `tcpdump`
de `LinuxNetCommands.ts` sont supprimés une fois ce routage unifié.

### 3.2 Modules proposés (arborescence)

```
src/network/devices/linux/network/tcpdump/
  TcpdumpCli.ts             (existant — inchangé dans sa forme, drapeaux inertes réellement câblés phase par phase)
  TcpdumpFilter.ts          (existant — parseByteSlice/parseVlan gagnent une vraie évaluation)
  TcpdumpFormat.ts          (existant — verbosité réelle -v/-vv/-vvv, checksum, options TCP, flags de fragmentation)
  TcpdumpRunner.ts          (existant — capture indéfinie annulable, format de fichier unifié, dédup live)
  CaptureFrame.ts           (existant — parité IPv4/IPv6, champ tcpOptions)
  CaptureFileFormat.ts      (nouveau — sérialisation/désérialisation unique, versionnée, partagée par tous les appelants)
  DnsSummary.ts             (nouveau, minimal — résumé une-ligne pour UDP/53, réutilisé par TcpdumpFormat)

src/network/devices/linux/LinuxNetCommands.ts
  (portion tcpdump entièrement supprimée : parseTcpdumpArgs/cmdTcpdump/tcpdumpHeader/tcpdumpFooter/packetMatchesPort/formatPacket/serializeCapture/deserializeCapture)

src/network/devices/LinuxMachine.ts
  (isTcpdumpCommand supprime sa condition d'exclusion sur les pipes ; le
   dispatch réutilise runTcpdumpCommand pour toute forme d'invocation)
```

### 3.3 Design patterns retenus

- **Un seul point d'entrée (Facade)** : `runTcpdump(tokens, deps)` reste le
  point d'entrée unique, désormais appelé par les trois contextes
  d'invocation via une injection de dépendances (`TcpdumpDeps`) déjà bien
  conçue — aucun nouveau pattern à introduire, seulement supprimer le chemin
  concurrent.
- **Codec séparé** pour le format de fichier (`CaptureFileFormat.ts`), sur
  le modèle déjà établi dans ce dépôt (`TcpOptionsCodec`, `RndcWireCodec`) :
  encode/décode pur, aucune I/O.
- **Déduplication par identité de segment** (clé `srcIp:srcPort:dstIp:
  dstPort:seq:flags`) dans `openTcpdumpCapture`, pas une réécriture complète
  de l'architecture de capture à deux sources (port réel + pont `TcpStack`)
  qui reste par ailleurs légitime pour couvrir le trafic legacy non
  migré vers `TcpStack`.

---

## 4. Modèle de données

### 4.1 `CaptureFrame` — champs ajoutés (IPv6 + options TCP)

```ts
interface CaptureFrame {
  // ... champs existants inchangés ...
  tcpOptions?: TcpOptionSummary[];   // nouveau — reflète TcpSegment.options
}

type TcpOptionSummary =
  | { kind: 'mss'; value: number }
  | { kind: 'window-scale'; shift: number }
  | { kind: 'sack-permitted' }
  | { kind: 'timestamp'; tsVal: number; tsEcr: number };
```
La branche IPv6 de `decodeIpv4Payload`-équivalent extrait désormais
`srcPort`/`dstPort`/`tcpFlags`/`tcpSeq`/`tcpAck`/`payloadLength` exactement
comme la branche IPv4, et les octets bruts (`raw`) sont réellement construits
pour IPv6 au lieu de rester vides.

### 4.2 Format de fichier de capture unifié

```ts
interface CaptureFileV1 {
  format: 'ubuntu-sandbox-capture-v1';
  frames: CaptureFrame[]; // sérialisées avec `at` en ISO string
}
```
Remplace à la fois `"TCPDUMPSIM1\n" + JSON` (`TcpdumpRunner`) et le JSON brut
sans en-tête (`LinuxNetCommands`) — un seul lecteur, une seule écriture,
utilisés par tous les appelants.

### 4.3 Filtre par tranche d'octets

```ts
interface ByteSliceFilter {
  proto: 'ip' | 'tcp' | 'udp' | 'icmp';
  offset: number;
  length: 1 | 2 | 4;
  mask?: number;
  comparator: '=' | '!=' | '<' | '>' | '<=' | '>=';
  value: number;
}
```
Évalué contre `frame.raw` (déjà présent) à l'offset réel de la couche
concernée (déjà calculé via `frame.rawLinkOffset` + longueur d'en-tête IP).

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — Unification du routage de commande** | `LinuxMachine.isTcpdumpCommand` accepte toute forme d'invocation (pipe, redirection, arrière-plan, composite) ; `LinuxCommandExecutor` délègue à `TcpdumpRunner` au lieu de `cmdTcpdump` ; suppression de la portion `tcpdump` de `LinuxNetCommands.ts` une fois plus rien ne l'appelle (checkpoint de régression ciblé sur les ~1400 lignes de tests `tcpdump*.test.ts`) | Existant |
| **P2 — Format de capture unifié** | `CaptureFileFormat.ts` ; `-w`/`-r` partagent le même encode/décode dans les trois anciens chemins d'entrée | P1 |
| **P3 — Parité IPv4/IPv6 dans `CaptureFrame`** | Extraction ports/flags/seq/ack/payload/octets bruts pour IPv6, identique à IPv4 | P1 |
| **P4 — Filtres par tranche d'octets + VLAN réels** | `parseByteSlice` évalue réellement contre `frame.raw` ; constantes nommées (`tcp-syn` etc.) ; `parseVlan` matche un vrai tag 802.1Q décodé | P1, P3 |
| **P5 — Déduplication de la capture live + capture indéfinie hors UI terminal** | `openTcpdumpCapture` déduplique par identité de segment ; `TcpdumpRunner.runCapture` attend indéfiniment (annulable) au lieu d'une fenêtre de temps fixe (checkpoint de régression complète) | P1 |
| **P6 — Verbosité réelle + options TCP + checksum** | `-v`/`-vv`/`-vvv` distincts dans `TcpdumpFormat` ; affichage `options [...]` depuis le nouveau champ `tcpOptions` ; `cksum 0x____ (correct/incorrect)` réel via les fonctions de checksum déjà existantes (`computeTcpChecksum` etc.) | P3 |
| **P7 — Fragmentation IP + résumé DNS minimal** | `flags [DF]`/`flags [+]` réels dans l'en-tête verbeux ; `DnsSummary.ts` pour un résumé une-ligne sur UDP/53 | P6 |
| **P8 — Nettoyage des drapeaux restants** | `-Q` (direction) réellement câblé ; troncature snaplen reflétée dans le résumé une-ligne (`[\|tcp]`) ; `-D` reflète l'état réel des interfaces ; `-r`+`-c` honoré ; `multicast`/`broadcast` réellement évalués contre MAC/IP (checkpoint de régression complète, fin du PRD) | Toutes les phases précédentes |

Chaque phase suit le cycle rouge → vert → refactor, régression localisée à
chaque phase, régression complète (`npx vitest run`) après P5 et après P8 —
même discipline que les PRD précédents de ce dépôt.

---

## 6. Stratégie de test

1. **Invocation composite** : `tcpdump -i eth0 -n port 80 \| grep SYN`,
   `tcpdump -w /tmp/cap.json`, `tcpdump -c 3 &` produisent exactement la même
   sortie ligne-à-ligne (hors bufferisation du pipe) qu'une invocation directe
   équivalente — c'est le test le plus représentatif de l'impact utilisateur
   de ce PRD (item #1/#2/#3/#4 de la gap analysis).
2. **Round-trip `-w`/`-r`** : une capture écrite par un appareil est relue
   sans erreur par `-r` sur ce même appareil et sur un autre.
3. **IPv6** : une connexion TCP établie sur IPv6 affiche les ports, les
   flags et la séquence exactement comme son équivalent IPv4.
4. **Filtre par tranche d'octets** : `tcp[13] & 2 != 0` ne capture que les
   segments portant réellement le bit SYN, vérifié sur un mélange
   SYN/ACK/data/FIN.
5. **VLAN** : un filtre `vlan 100` ne capture que le trafic tagué 100 (si le
   simulateur modélise déjà des VLAN au niveau trame — sinon, documenter
   explicitement la limite plutôt que de la contourner silencieusement).
6. **Déduplication** : une poignée de main TCP complète (SYN/SYN-ACK/ACK)
   apparaît exactement 3 fois dans la capture, pas 6.
7. **Capture indéfinie** : sans `-c`, la capture continue de recevoir des
   paquets bien après 200 ms (fenêtre actuelle) et jusqu'à annulation
   explicite.
8. **Verbosité** : `-v`, `-vv`, `-vvv` produisent des sorties visiblement
   différentes et de plus en plus détaillées sur le même paquet.
9. **Non-régression** : les suites existantes (`tcpdump.test.ts`,
   `tcpdump2.test.ts`, `linux-tcpdump-stream-ui.test.ts`, et toute suite qui
   exerce `ssh`/`telnet`/`nc`/`ping` en vérifiant leur trace `tcpdump`)
   restent vertes après chaque phase.

---

## 7. Risques et points d'attention

1. **`cmdTcpdump` est peut-être exercé par des tests qui ne s'attendent pas
   à voir la grammaire de filtre BPF complète ni la capture live.** Un audit
   des ~1400 lignes de tests `tcpdump*.test.ts` est nécessaire avant P1 pour
   identifier lesquels ciblent spécifiquement le chemin pipé/primitif — ces
   tests devront être migrés vers les attentes du chemin unifié, pas
   supprimés silencieusement.
2. **La déduplication (P5) doit choisir une clé stable** — deux segments
   légitimement identiques (retransmission exacte) ne doivent pas être
   fusionnés à tort ; inclure un horodatage à la milliseconde ou un compteur
   de tentative dans la clé si nécessaire.
3. **Capture indéfinie (P5/P6) et tests synchrones** — comme documenté dans
   `PRD-TCP.md` (risque similaire pour `connect()`), rendre une capture
   réellement indéfinie casse toute hypothèse implicite de "ça se termine
   forcément après 200 ms" dans les tests existants ; utiliser le même
   mécanisme d'horloge pilotable (`VirtualTimeScheduler`/annulation
   explicite) plutôt qu'un vrai `setTimeout`.
4. **Format PCAP réel explicitement refusé (§2.2)** — si un besoin
   d'interopérabilité Wireshark apparaît plus tard, ce sera un PRD dédié,
   pas une extension informelle de celui-ci.
5. **Le legacy `WireCaptureBus`/`CaptureRouter`** (recherche d'hôte par IP
   globale, sans topologie réelle) reste en place pour le trafic non
   encore migré vers `TcpStack` — ce PRD ne le supprime pas, il corrige
   seulement le doublonnage qu'il cause quand ses événements et ceux de
   `TcpStack` coexistent pour un même segment (P5).

---

## 8. Critères d'acceptation

1. `tcpdump` produit le même résultat quelle que soit sa forme d'invocation
   shell (direct, pipé, redirigé, en arrière-plan, en script).
2. Une capture écrite par `-w` est relisible par `-r` sur ce même simulateur,
   sur n'importe quel appareil.
3. Le trafic TCP/UDP sur IPv6 affiche ports, flags et détails au même niveau
   que sur IPv4.
4. Un filtre par tranche d'octets (`tcp[13] & 2 != 0`) et un filtre `vlan`
   filtrent réellement, au lieu de toujours tout montrer ou toujours rien.
5. Un même segment réel n'apparaît jamais plus d'une fois dans une capture.
6. Une capture sans `-c` continue tant qu'elle n'est pas explicitement
   arrêtée, y compris hors de l'UI terminal.
7. `-v`/`-vv`/`-vvv` produisent des niveaux de détail visiblement distincts,
   avec vérification de checksum et options TCP affichées.
8. Les tests existants (`tcpdump.test.ts`, `tcpdump2.test.ts`,
   `linux-tcpdump-stream-ui.test.ts`, et toute suite ssh/telnet/nc/ping qui
   vérifie une trace `tcpdump`) restent verts après chaque phase (régression
   complète après P5 et après P8).

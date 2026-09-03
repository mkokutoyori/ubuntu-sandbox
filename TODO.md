# TODO — manquements mesurés, non encore fermés

Un manquement n'entre ici que s'il a été **mesuré** : commande tapée,
état relu, écart constaté. Chaque entrée dit *ce qui est cassé*, *comment
on l'a vu*, et *pourquoi ce n'est pas fermé*. Une entrée fermée est
retirée d'ici et racontée dans son message de commit, jamais dans le
code (`CLAUDE.md` : le code ne porte pas de commentaire).

Format : `[famille] intitulé` puis constat / mesure / raison du report.

---

## Commutateur Huawei (VRP)


## Moteur L2 partagé (`Switch.ts`)

### [stp] `display stp brief` liste-t-il les ports sans câble ?
Un port administrativement actif mais sans lien apparaît dans le tableau
avec un rôle et un état (`DISA DISCARDING` depuis que le vocabulaire
MSTP est respecté), ce qui noie les deux lignes utiles.
**Mesure** : maquette à 12 ports, 10 lignes pour des ports sans câble.
**Ce qui a été cherché** : le jeu de références `ntc-templates` ne porte
AUCUNE capture STP pour Huawei VRP (vérifié dans
`tests/huawei_vrp/`, qui n'a pas de répertoire `display_stp*`), et
`support.huawei.com` comme `info.support.huawei.com` sont bloqués par le
proxy de sortie.
**Report** : trancher demande une transcription de vraie machine.
Affirmer que VRP les masque — ou qu'il les liste — sans capture serait
inventer, et l'état rendu est désormais correct dans les deux cas.

### [stp] les MSTI ne sont pas encore INONDEES par un pont de frontière
Une région est désormais identifiée par son condensé (nom / révision /
digest HMAC-MD5 de la table VLAN→instance), et un port qui entend une
autre région écarte ses BPDU de MSTI en ne gardant que le CIST — la
règle de l'IEEE 802.1Q §13.8. Ce qui reste : un vrai pont de frontière
représente la région voisine tout entière comme un seul segment du CIST
et propage l'information reçue vers ses propres MSTI ; ici les MSTI de
part et d'autre s'ignorent simplement.
**Mesure** : deux régions reliées convergent chacune de son côté ; le
CIST traverse, les MSTI non.
**Report** : la représentation d'une région comme segment du CIST demande
le rôle de « Master Port » et le compte de sauts interne (`remainingHops`),
que ce moteur ne porte pas — un chantier à part, et sans effet visible
tant qu'un laboratoire n'a pas deux régions ET un chemin redondant entre
elles.

---

## Commutateur Cisco

### [vrf] `address-family ipv4` sous `vrf definition` est refuse
La forme MULTIPROTOCOLE d'IOS exige `address-family ipv4` pour activer
une famille dans la VRF ; ici elle repond `% Invalid input detected`, et
la configuration rendue n'ecrit donc que `vrf definition <nom>` + `rd` +
`route-target`.
**Mesure** : `vrf definition X` puis `address-family ipv4` est refuse sur
le routeur comme sur le commutateur.
**Report** : ce simulateur n'a AUCUNE notion de famille d'adresses par
VRF — `_vrfs` ne porte pas la distinction et rien ne la lirait. Accepter
la commande rangerait un critere que personne n'evalue, ce que
`CLAUDE.md` interdit ; l'implanter veut dire porter la famille jusqu'au
plan de donnees, ce qui est un chantier de routage et non de CLI.

### [vrf] un Catalyst cree une VRF et ne peut pas la configurer
`vrf definition <nom>` est accepte, retenu et desormais rendu sur le
commutateur, mais `rd` et `route-target` y sont refuses — le sous-mode
`config-vrf` n'est cable que sur le routeur (`registerVrfSubmodeOn` est
une methode de `CiscoIOSShell`).
**Mesure** : la meme sequence est acceptee de bout en bout sur le
routeur et s'arrete au `rd` sur le commutateur.
**Report** : meme forme que les deux notes voisines — un sous-systeme du
routeur que le commutateur n'a pas. Le brancher demande de decider ce
qu'une VRF fait sur un commutateur de niveau 3 (ses SVI, sa table), ce
qui est une question de plan de donnees.

### [track] un Catalyst ne suit qu'une INTERFACE, pas une route ni un IP SLA
Le commutateur porte son propre `TrackObjectRegistry`, dont le type est
`'line-protocol' | 'ip-routing'` : les formes `track <n> ip route …`,
`track <n> ip sla …`, `track <n> list …` et `stub-object` y sont donc
refusees, alors qu'un 3560 les connait et que le ROUTEUR les honore
toutes par `TrackService`.
**Mesure** : la meme frappe est acceptee sur le routeur et refusee sur le
commutateur ; depuis le lot qui unifie la grammaire, le refus porte au
moins le bon message au lieu de « commande incomplete ».
**Report** : ce n'est pas un defaut d'analyse — la grammaire est
desormais commune — mais un MAGASIN absent. Faire lire `TrackService` au
commutateur touche ses consommateurs (FHRP, routes suivies) et non la
CLI, et c'est le meme chantier que celui de la note ci-dessous sur
`ip prefix-list` : un sous-systeme du routeur que le commutateur n'a pas.

### [policy] `ip prefix-list` et `route-map` sont refuses sur un Catalyst
Les deux familles sont declarees « router-only » (`CiscoPolicyCommands`
n'est branche que sur le routeur), donc un Catalyst repond
`% Invalid input detected` a `ip prefix-list PL permit 10.0.0.0/8` comme
a `route-map RM permit 10`.
**Mesure** : accepte et rendu sur le routeur, refuse sur le commutateur,
pour la meme frappe.
**Report** : un 3560 les connait, un 2960 non — la reponse depend du
PROFIL de chassis, et ce depot en porte trois (`c2900`, `c2960`,
`c3560`). Trancher demande de decider ce que ce simulateur modelise de
cette difference, ce qui est une autre question que celle de savoir si
la commande juge ses arguments. La brancher sans ce choix ferait
apprendre a un 2960 une commande que la vraie machine refuse.

### [snmp] le Catalyst RANGE sa configuration SNMP, mais rien n'ecoute sur 161
`snmp-server community|host|contact|location|chassis-id` sont desormais
retenus, servis par `show snmp`, `show snmp community`, `show snmp host`
et rendus dans la configuration — mais `CiscoSwitch` n'instancie aucun
`SnmpAgent`, la ou `CiscoRouter` en porte un et lui aiguille l'UDP 161.
Un vrai `snmpget` vers un Catalyst n'obtient donc rien.
**Mesure** : `show snmp` y rend `0 SNMP packets input` quoi qu'il arrive,
ce qui est VRAI (aucun paquet ne peut arriver) et non un compteur mort.
**Report** : `SnmpHost` demande `getSysDescr`, `getSysObjectId` et
`sendUdpDatagram` en plus de la surface que `makeSwitchNtpHost` fournit
deja ; le brancher est un travail de plan de donnees (aiguillage du 161
dans `deliverLocalUdp`, enregistrement dans `agents`), distinct de la
CLI que ce lot refermait.

---

## Postes Linux

### [dhcp] `dhclient -t N` est accepte, et aucun delai ne le lit
La duree passee a `-t` (et le `-w` qui la porte a 60) traverse
`Dhclient.ts` jusqu'a `DHCPClient.requestLease` et n'est lue par personne.
Elle ne l'a jamais ete comme un DELAI : son seul lecteur, jusqu'au
correctif de l'auto-attribution de lien-local, etait la condition qui
DESACTIVAIT l'APIPA — une valeur qui servait a autre chose que ce
qu'elle nomme. **Mesure** : `dhclient -t 1 eth0` sans serveur rend le
meme texte et le meme etat que `dhclient eth0`, immediatement.
**Pourquoi ce n'est pas ferme ici** : la livraison des trames est
SYNCHRONE dans ce simulateur — un DISCOVER est repondu dans le meme tour
ou jamais — donc un delai n'a rien a mesurer et l'implementer poserait
une valeur decorative, exactement ce que ce depot refuse. L'option reste
acceptee parce qu'un vrai `dhclient` l'accepte, et la refuser ferait
diverger la CLI. Elle redeviendra implementable le jour ou `Cable`
portera une latence.

### [sysctl] `/etc/sysctl.conf` n'est pas livre, et les projections de `/proc/sys` sont en lecture seule
Depuis le lot « `sysctl` lit `/proc/sys` », deux restes MESURES.

**(1) Le fichier de prechargement n'existe pas.** `sysctl -p` repond
`sysctl: cannot open "/etc/sysctl.conf": No such file or directory` sur
une machine neuve, alors qu'une vraie Ubuntu livre ce fichier (tout en
commentaires) et un `/etc/sysctl.d/` avec `99-sysctl.conf`. Le depot y
fait deja reference : `/etc/ufw/sysctl.conf` est seme et son en-tete dit
« these settings override /etc/sysctl.conf ». **Pourquoi ce n'est pas
ferme ici** : le contenu EXACT du fichier de Debian n'a pas pu etre
atteste depuis ce reseau (`sources.debian.org` et `git.launchpad.net`
sont bloques par le mandataire ; le `sysctl.conf` d'amont de procps-ng
est un AUTRE fichier, avec des reglages actifs que Debian ne livre pas).
L'ecrire de memoire produirait le genre de sortie plausible-et-fausse
que ce depot passe son temps a refermer. A fermer le jour ou une copie
du fichier Debian est atteignable.

**(2) Une projection de `/proc/sys` ne se laisse pas ecrire.** Les
pseudo-fichiers generes sont en lecture seule par decision du VFS
(`writeFile` les jette en silence), et ceux d'`arp_ignore`,
`arp_announce`, `arp_accept`, `arp_notify` et `proxy_arp` rendent une
CONSTANTE `0` que personne ne lit — verifie : `Port.isProxyArpEnabled`
n'a d'appelants que `Router` et les CLI Cisco/Huawei, un hote Linux ne
fait pas de proxy ARP ici. `sysctl -w` les refuse donc par la branche
EPERM de procps plutot que de les accepter sans effet. **Pourquoi ce
n'est pas ferme ici** : les rendre inscriptibles demande de donner un
COMPORTEMENT a chacune, sans quoi on rangerait une valeur que rien
n'evalue. C'est un chantier par knob, pas un correctif de commande.

---

## Postes Windows

### [ping] les mots de `ping.exe` pour le code 13 restent non attestés
Depuis le lot « le code ICMP decide de ce que ping ecrit », la moitie
Windows lit le code et distingue le RESEAU (code 0) de l'HOTE (code 1)
et la fragmentation (code 4). Il reste **un** code non rendu : le 13
(communication administrativement interdite), celui qu'un routeur emet
sous liste de controle. Il est rendu comme le code 1 — `Reply from
<ip>: Destination host unreachable.` — donc un refus par ACL et un hote
qui n'a pas repondu se ressemblent encore sur une machine Windows,
alors que Linux les separe (`Packet filtered` contre `Destination Host
Unreachable`).

**Ce qui bloque, et c'est une question de REFERENCE, pas de code.** La
recherche a etabli beaucoup, et pas cela. Sont ATTESTES : la forme
`Reply from <ip>: <message>` ; `Destination host unreachable.` ;
`Destination port unreachable.` et `Destination protocol unreachable.`
(transcriptions reelles retrouvees, meme si ce simulateur ne livre
jamais ces deux codes a un `ping`) ; `Packet needs to be fragmented but
DF set.` ; et la liste complete des `IP_STATUS` lue dans l'`ipexport.h`
du vrai SDK Windows — ou l'on decouvre que `IP_DEST_PROHIBITED` et
`IP_DEST_PROT_UNREACHABLE` sont **le meme nombre**, 11004. N'est PAS
atteste : ce que `ping.exe` imprime pour le code 13. Deux resumes de
recherche citant des fils Cisco disent « Destination net unreachable »,
sans transcription primaire ; `community.cisco.com`, `cisco.com` et
`sources.debian.org` sont bloques par le mandataire de sortie ; ReactOS
est une reimplementation dont la table ne contient meme pas ce cas et
qui ecrit « network » la ou Windows ecrit « net ». Ecrire la ligne de
memoire produirait le genre de sortie plausible-et-fausse que ce depot
passe son temps a refermer.

**Report.** A fermer le jour ou une capture reelle de `ping.exe` sous
ACL est disponible ; tout le reste est en place, il ne manque que le
libelle — une ligne dans `winUnreachText`.

---

## Gestion (SNMP, NTP, syslog)

### [ntp] `minpoll`, `maxpoll`, `burst` et `iburst` sont desormais REFUSES
La queue de `ntp server|peer` ne connait que les quatre formes qu'elle
declare (`key`, `prefer`, `source`, `version`) ; depuis le lot qui les
juge, un mot hors de cette liste est refuse au lieu d'etre avale en
silence. Un vrai IOS accepte pourtant `minpoll`/`maxpoll` (intervalles de
scrutation) et `burst`/`iburst`.
**Mesure** : `ntp server 10.0.0.1 iburst` rend `% Invalid input detected`
ici et est accepte sur une vraie machine.
**Pourquoi c'est ce refus qui a ete choisi** : `CLAUDE.md` tranche —
« soit le moteur applique le mot-cle, soit l'analyseur le refuse ». Les
accepter demanderait de RANGER une valeur que rien ne lit, ce qui est
l'inverse du defaut que ce lot refermait.
**Report** : `minpoll`/`maxpoll` sont applicables — `NtpAssociation`
porte deja `pollSec` et le minuteur de scrutation existe — mais c'est un
travail de temporisation, pas de CLI. `burst`/`iburst` demandent une
rafale de huit paquets a l'association, que ce moteur n'a pas.

### [snmp] `snmp-server host <ip> vrf <nom>` est lu comme la communaute
IOS ecrit `snmp-server host <hote> [vrf <nom>] [traps|informs] …`.
`configHost` ne connait pas `vrf` : le mot est pris pour la communaute et
le nom de la VRF devient un type de notification.
**Mesure** : `snmp-server host 10.0.0.1 vrf MGMT public` est accepte et
revient `snmp-server host 10.0.0.1 version 1 vrf MGMT public` — une
communaute nommee `vrf`.
**Report** : `SnmpHost` n'a pas de champ de VRF, et en ajouter un sans
que rien ne le lise serait le critere range-mais-jamais-evalue que
`CLAUDE.md` interdit. A faire avec le jour ou les traps suivent une VRF.

### [snmp] les types de notification d'un hote ne sont pas juges
Ce qui suit la communaute est repris tel quel : `snmp-server host
10.0.0.1 public zorglub-notif` est accepte et rendu.
**Mesure** : la ligne revient telle quelle dans `show running-config`,
donc elle est rejouee a l'import d'une topologie.
**Report** : la liste des types d'IOS est longue et depend de la
plateforme ; en refuser une partie ferait refuser des formes qu'une vraie
machine prend, ce qui est pire que l'inverse. Il faudrait la liste
attestee des types que CE simulateur sait emettre — `getEnabledTraps`
en connait trois.

### [snmp] SNMPv3 (USM) et les formes VRP qui restent inertes
Depuis le lot « une vue MIB filtre vraiment », `mib-view` est EVALUE :
la vue nommee par une communaute decide, OID par OID, de ce qu'elle
peut lire, selon la regle du sous-arbre le plus long (RFC 3415).

Restent les formes que VRP connait et que ce moteur ne sait toujours
pas honorer : `group v3`, `usm-user v3`, `packet max-size`,
`protocol source-interface`, `protocol version`, et les deux moities
`target-host trap-hostname` / `trap-paramsname`. Elles vont dans
`SnmpService.recordVrpLine`, sont rendues telles qu'ecrites, et rien ne
les lit.
**Mesure** : un `usm-user v3` declare ne permet aucune requete v3,
`SnmpAgent` n'ayant ni USM ni v3 du tout.
**Pourquoi ce n'est pas ferme** : les refuser casserait le rejeu d'une
configuration reelle et les ferait disparaitre a l'import d'une
topologie — le meme raisonnement que pour `ip ssh server algorithm`.
Les evaluer demande deux chantiers distincts : un modele USM/v3
(authentification et chiffrement des PDU, moteur d'horloge et de
compteur de boots), et une interface d'ecoute par laquelle l'agent
repondrait, qui n'existe pas — il repond sur le port qui a recu.
**Limite connue de la vue** : le `mask` de la RFC 3415, que VRP accepte
derriere le sous-arbre, n'est pas modelise ; une entree en porte un est
refusee plutot que rangee sans etre lue.

---

## Couche transport (BRD TCP/IP)

### [port] le port 0 se lie LITTERALEMENT au lieu d'en attribuer un
**Constat.** `PortNumber.isValid(0)` est VRAI — la RFC 6335 compte 0 dans
la plage — donc `udpBind(0)` et `listen(0)` reussissent et posent un
ecouteur sur le port 0. Sur une vraie machine, `bind()` avec le port 0 a
un sens PARTICULIER : « attribue-m'en un ephemere », et l'appelant relit
ensuite le port reellement obtenu par `getsockname()`.

**Mesure.** Faite en fermant le lot 14 : des cinq ports impossibles
essayes (99999, -1, 65536, 1.5, NaN) les cinq sont desormais refuses, et
le port 0 reste accepte tel quel — un ecouteur qu'aucune trame ordinaire
n'atteindra, puisque rien n'adresse le port 0.

**Raison du report.** Trois comportements sont defendables et le choix
n'est pas mecanique : refuser (mais on s'ecarte alors de la plage
normalisee que `PortNumber` encode), honorer le sens reel (il faut alors
rendre le port attribue a l'appelant, donc changer la signature des deux
points de liaison et de leurs appelants), ou laisser tel quel. Trancher
en passant, dans un lot qui portait sur les ports IMPOSSIBLES, aurait
melange deux questions.


### [udp6] les AGENTS du plan de controle restent en IPv4
**Constat.** Le socle UDP/IPv6 d'un routeur existe depuis le lot 9 —
`sendUdpDatagram6` emet, `deliverUdp6` remet a la table de ports, un port
ferme repond ICMPv6 — mais les agents que `receiveControlPlaneUdp` sert
(HSRP, NTP, GLBP, BFD, les cinq RADIUS, SNMP, VXLAN) prennent tous un
`IPAddress` et ne voient donc que l'IPv4.

**Mesure.** Les onze branches de `CiscoRouter.receiveControlPlaneUdp`
passent `ipPkt.sourceIP`, de type `IPAddress` ; aucune n'est atteignable
depuis le chemin v6, qui s'arrete a la table de ports.

**Raison du report.** C'est une campagne PAR AGENT — elargir chaque
`handleUdp` a une adresse des deux familles, et decider pour chacun ce
que la version v6 du protocole veut dire (HSRPv6 et GLBP ont leurs
propres adresses de groupe ; NTP, BFD, RADIUS et SNMP sont les memes
protocoles sur une autre couche 3) — et non la suite mecanique du socle.
Le socle, lui, a un appelant reel (la table de ports du plan de controle,
ou TFTP et le client DNS se lient), donc ce n'est pas un moteur sans
porte.

### [ssh] le nom NON RESOLU cote SSH d'IOS n'est pas atteste
**Constat.** `sshDialect.ts` porte les trois issues d'echec d'IOS sur
transcription reelle — absence de route, refus, delai. La quatrieme, le
nom qu'IOS ne sait pas traduire, ne l'est pas : `% Bad IP address or host
name` est ce qu'IOS rend pour une saisie qu'il ne sait pas lire, et c'est
ce que la table porte, mais aucune capture ne montre le client SSH dans
ce cas precis.

**Mesure.** Les trois autres viennent de transcriptions (une montrant
`ssh -l SSHadmin 192.168.1.1` suivi de `% Destination unreachable;
gateway or host down`, une autre `ssh -v 2 -l mariano 192.168.4.17` suivi
de `% Connection timed out; remote host not responding`) ; aucune
recherche n'a rendu l'equivalent pour un nom.

**Report.** Le cas est le moins frequent des quatre et la valeur portee
est plausible plutot qu'inventee — mais elle n'est pas mesuree, et c'est
ecrit ici pour que personne ne la prenne pour telle.

### [arp] un commutateur JETTE sur cache ARP froid, un routeur met en file
**Constat.** `SwitchSvi.sendUdpDatagram` appelle `resolveArp` et rend
`false` quand le cache est froid ; le datagramme est perdu.
`Router.sendUdpDatagram` passe par `sendIpv4FrameArpAware`, qui MET EN
FILE et emet des que la reponse arrive.

**Mesure.** Meme laboratoire, meme collecteur : le premier message
syslog d'un routeur part apres resolution, celui d'un commutateur est
compte comme envoye et n'existe pas. Le cas de `syslog-protocol` visait
d'ailleurs un collecteur INEXISTANT, ce qui masquait l'ecart.

**Report.** Donner une file d'attente ARP a la SVI est un changement du
plan de donnees du commutateur, distinct du lot syslog ; il demande son
propre temoin (une premiere trame differee, pas perdue).


### [icmp] le pendant VRP est accepte et inerte, et son `undo` n'existe pas
**Constat.** Cote Cisco, `no ip unreachables` est desormais honore par
`sendICMPError`. Cote Huawei, les commandes equivalentes
`icmp ttl-exceeded send` et `icmp host-unreachable send` sont enregistrees
dans `HuaweiVRPShell` et rangees par `_setGlobalToggle` dans un sac que
le plan de donnees ne relit JAMAIS.

**Mesure.** `_getGlobalToggle` n'a que deux lecteurs — `HuaweiDisplayCommands`
pour `telnet server` et `SocketInventory` pour les ports d'ecoute — et
aucun ne consulte les cles `icmp`. Pire : aucune forme `undo icmp ...`
n'est enregistree, donc l'operateur ne peut meme pas couper le message
qu'il croit pouvoir regler.

**Report.** Le modele de VRP n'est pas celui d'IOS et le correctif n'est
donc pas une recopie : la commande est GLOBALE (vue systeme) et non par
interface, et elle est decoupee PAR MESSAGE (`ttl-exceeded`,
`host-unreachable`, `port-unreachable`) la ou IOS coupe tout le type 3
d'un coup. Le predicat `Router.isIcmpUnreachablesEnabled` lit
`CiscoSecurityConfig` et rend `true` sur un Huawei ; lui donner un second
magasin sans repenser la granularite ferait deux reglages pour une meme
question. C'est un lot a part, avec sa propre mesure.

## Socle CLI

### [socle] une queue `REST` ne sait pas nommer ses valeurs par POSITION
`sequenceFamily` decrit la queue libre d'une commande par UNE place
`REST` portant ses formes. Elles sont donc annoncees a chaque rang, sans
savoir laquelle vient d'etre tapee, et une valeur qui SUIT une forme ne
peut pas etre nommee du tout. Deux familles en souffrent aujourd'hui :

    snmp-server host 10.0.0.1 version ?   attendu 1 / 2c / 3
    snmp-server host 10.0.0.1 version 3 ? attendu auth / noauth / priv / WORD
    ntp server 10.0.0.1 key ?             attendu <1-4294967295>
    ntp server 10.0.0.1 version ?         attendu <1-4>

**Mesure** : chacune rend les formes de la queue (`key`, `prefer`,
`source`, `version` cote NTP) et jamais la valeur attendue. Depuis les
lots SNMP et NTP, l'aide ne REFUSE plus a ces rangs et ne repropose plus
une forme deja tapee ; ce qui manque est de NOMMER.
**Report** : le mecanisme existe deja a cote — `loggingFamily` porte des
`continuations` (« les mots-cles qui SUIVENT l'argument »,
`logging host <ip> transport tcp`). Le donner a `sequenceFamily` est un
enrichissement du declarateur PARTAGE, donc un lot a lui seul ; declarer
a cote quelques chemins types ferait DEUX grammaires pour une commande,
le defaut que ce depot passe son temps a refermer.
### [aide] `aaa` est un noeud GLOUTON, donc son aide s'arrete a deux mots
`aaa authentication login ?` et `aaa authentication login default ?`
annoncent `<cr>` — la touche Entree — alors que la machine repond
`% Incomplete command.` aux deux. Et les METHODES (`local`, `none`,
`group`, `enable`, `line`…) ne sont annoncees nulle part, bien qu'elles
soient desormais declarees et APPLIQUEES (`AAA_METHODS`).
**Mesure** : `aaa ?` et `aaa authentication ?` rendent la bonne liste ;
tout ce qui suit rend `<cr>` et rien d'autre, sur les deux plateformes.
**Ce qui a ete tente et retire** : `requireArgs('aaa authentication
login', 1)` est INERTE — `aaa` est enregistre en glouton, donc aucun
noeud n'existe a cette profondeur pour porter la declaration, et une
declaration que personne ne lit est exactement ce que ce depot retire
ailleurs. Elle n'a donc pas ete laissee en place.
**Report** : la reparation est la MIGRATION de la famille `aaa` vers le
socle, ou chaque forme est un chemin declare avec ses places — c'est la
seule facon de porter une aide a cette profondeur, et c'est un lot a
part entiere : la grammaire d'`aaa` a quatre niveaux, une liste nommee
libre au milieu, et une suite de methodes de longueur variable dont
`group` consomme le mot suivant.

### [horloge] un Catalyst n'a pas d'horloge : `clock timezone` y est inerte
`clock timezone CET 1` et `clock summer-time CEST recurring` sont
ACCEPTES sur un commutateur Cisco, ne paraissent dans aucune
configuration, et `show clock` continue d'annoncer `UTC` — la ou le
routeur repond `CET` apres la meme saisie. La grammaire, elle, est
desormais jugee des deux cotes : une saisie fautive est refusee
identiquement, seule la POSE se perd.
**Mesure** : `getManagementService(sw)` rend `undefined` sur un
`CiscoSwitch`, et `applyClock` sort par `if (!mgmt) return ''` — donc en
silence. `show running-config` d'un Catalyst ne porte aucune ligne
`clock`.
**Report** : ce n'est pas la commande qui manque mais le MAGASIN. Donner
une horloge au commutateur veut dire soit lui attacher un
`RouterManagementService` (qui porte bien plus que l'horloge : NTP,
info-center, sFlow, SSH…), soit extraire la configuration d'horloge dans
un porteur a part que les deux plateformes tiennent — le second est le
bon geste et c'est un chantier de decoupage, pas de grammaire. En
attendant, un `no-op` SILENCIEUX reste le pire des trois etats possibles
et merite d'etre ferme.

### [uniformite] `track <mot>` refuse avec DEUX messages selon la plateforme
`track zorglub interface GigabitEthernet0/0 line-protocol` rend
`% Invalid track number` sur un routeur Cisco et `% Invalid track id.`
sur un Catalyst. Les deux refusent — c'est le bon verdict — mais la
meme commande, sur le meme IOS, ne dit pas la meme chose.
**Mesure** : les deux textes ci-dessus, releves au meme instant sur les
deux plateformes.
**Report** : aucun des deux libelles n'est atteste depuis ce reseau, et
choisir l'un des deux graverait une invention dans la moitie des
machines. Ce qui manque est une transcription de vraie machine ; unifier
sur un texte non atteste rendrait le desaccord invisible sans le rendre
juste.

### [ssh] les cles RSA ne survivent pas a l'import d'une topologie
Un routeur qui porte une paire RSA et `ip ssh version 2` revient d'un
aller-retour de topologie SANS cle, donc avec SSH muet et
`ip ssh version 2` refuse — alors que la ligne `ip ssh version 2`, elle,
est rejouee.
**Mesure** : `crypto key generate rsa modulus 1024` puis
`show running-config` ne rend aucune ligne `crypto` ; `NEVER_SERIALIZED`
(`ciscoConfigSerializer.ts`) exclut explicitement
`^crypto key (generate|zeroize)\b`, et `topologySerializer.ts` ne parle
de cles nulle part.
**Ce qui a ete verifie** : l'exclusion est JUSTE et deliberee — la
documentation Cisco de `crypto key generate rsa` dit « The command is not
saved in the router configuration ; however, the RSA keys generated by
this command are saved in the private configuration in NVRAM ». Le
defaut n'est donc pas la ligne absente, c'est la CONFIGURATION PRIVEE
qui n'existe pas ici.
**Report** : lui donner un support demande de capturer les cles dans
`topologySerializer` a cote du registre Windows et des services Linux,
qui ont chacun leur fonction de capture ; c'est le meme patron, mais un
troisieme magasin a decrire, et la question de ce qu'on ecrit dans un
fichier de topologie partageable quand il s'agit d'une cle privee — meme
simulee — merite d'etre tranchee plutot que decidee en passant.

### [cli] le curseur d'un mot-cle inconnu recule d'un mot sous une racine PARTAGEE
`ip ssh zorglub 5` et `ip scp zorglub` rendent le bon message —
`% Invalid input detected at '^' marker.` — avec le curseur sous `ssh`
ou `scp` au lieu du mot fautif. Une valeur refusee, elle, est pointee
juste (`ip ssh time-out zorglub` met le curseur sous `zorglub`), et
`privilege exec badkeyword 5 show` aussi.
**Mesure** : colonne 14 obtenue contre 18 attendue pour `ip ssh
zorglub 5`, sur les deux plateformes.
**Cause** : `tryMigratedCommand` n'autorise le socle a poser un curseur
que s'il a refuse PAR UN ARGUMENT, ou si le trie ne porte RIEN sous le
premier mot de la frappe. `privilege` remplit la seconde condition — son
premier mot est a lui seul — mais `ip` reste peuple de dizaines de
commandes du trie, donc le socle se tait et c'est le trie qui repond, a
son propre noeud `ip`.
**Deux elargissements mesures et ANNULES**, ecrits ici pour que le
prochain ne les retente pas : (1) laisser le socle parler des que le
trie ne prefixe pas la frappe (`trieConnait(cmd, 0)`) fait rendre un
curseur la ou une commande est CACHEE par l'autorisation — six cas de
`tuto-privileges-cisco-verifie` tombent, IOS repondant la un message nu ;
(2) y ajouter « sauf si le socle declare quand meme la frappe » compare
un nombre de MOTS-CLES a un index de JETONS TAPES, deux systemes de
coordonnees differents, et fait tomber `track 2 interface … line-protocol`
depuis le sous-mode `track`. Un troisieme elargissement, plus ancien,
avait coute 102 cas dans 25 fichiers.
**Report** : la bonne question est « le socle possede-t-il ENTIEREMENT
cette branche ? », et y repondre demande de comparer les chemins des
deux moteurs sur les memes positions — c'est-a-dire de savoir combien de
jetons chaque place a consommes. Le socle le sait a l'analyse et ne le
rend pas ; l'exposer est un changement du resultat d'analyse, pas de
cette garde.

### [autorisation] `privilege` ne connait que quatre modes sur les onze d'IOS
`privilege router level 5 network` et `privilege route-map level 5 match`
sont REFUSES au caret ; une vraie machine les accepte. `AuthScope` ne
porte que `exec`, `configure`, `interface` et `line`, ce que le module
declare en toutes lettres depuis toujours — ce n'est donc pas une
surprise, mais c'est un ecart mesure.
**Mesure** : sur routeur ET commutateur, les deux formes ci-dessus
rendent `% Invalid input detected at '^' marker.` avec le curseur sous
le nom du mode, la ou `privilege interface level 8 shutdown` passe.
**Pourquoi ce n'est pas ferme ici** : ce n'est pas la grammaire de la
commande qui manque — la place est une enumeration, y ajouter un mot
coute une ligne — mais le MOTEUR derriere. Un mode de plus veut dire un
espace de nommage de plus dans `CommandLevelTable`, une entree de plus
dans `scopeForMode` (qui traduit le mode de la CLI en espace), et une
regle de plus dans `filterConfigForLevel`, qui attribue une ligne
indentee au bloc qui la porte — sans ces trois, `privilege router level
5 network` serait range et ne gouvernerait rien, c'est-a-dire le defaut
que ce depot passe son temps a refermer. Accepter le mot sans le moteur
serait pire que le refus actuel.

### [cli] `probe-aide-tient-ses-promesses` met trois minutes et flanche sous charge
Mesure : le fichier passe SEUL (20 cas, 188 s de temps de test) et un de
ses cas depasse son delai de 5 s des qu'il tourne dans un lot de 196
fichiers. Ce n'est pas l'aide elle-meme — `cliHelp('ip address ')` coute
30 ms, mesure — mais le laboratoire : chaque cas construit un routeur
Cisco NEUF, et cette construction est ce qui coute. Vingt routeurs par
fichier, plus la pression memoire d'un lot parallele, suffisent a faire
franchir la borne a un cas qui n'a rien de particulier.
**Pourquoi ce n'est pas ferme ici** : la reparation est soit un routeur
PARTAGE entre les cas — donc la question de ce qu'un cas laisse a son
voisin, que ce fichier evite deliberement en repartant de zero — soit
une construction de `CiscoRouter` moins couteuse, qui est un sujet a
elle seule (le constructeur bâtit tous les arbres de commandes, tous les
agents de protocole et tout le socle). Le cout n'a pas bouge avec la
migration au socle : il etait deja de 191 s avant.

### [cli] les declarations d'arguments decrivent, elles ne tranchent pas
Depuis le lot « une plage annoncee est une plage appliquee », un jeton
NUMERIQUE hors d'un intervalle affiche par `?` est refuse. Le reste
d'une declaration ne decide toujours rien : le TYPE (`WORD`, `IP_ADDR`,
`INTERFACE`), les bornes non numeriques, et le nombre d'arguments.
**Mesure** : appliquer les declarations a la lettre fait tomber 215 cas
sur 4077 — `delete flash:jamais.cfg` refuse parce que le type `WORD` est
declare `/^[a-zA-Z0-9_-]+$/` et n'admet ni `:` ni `.` ; `disconnect all`
refuse parce que la place est declaree `<1-16>` alors qu'`all` est un
mot-cle legitime qu'aucune declaration ne mentionne. Restent aussi
acceptes `ip dhcp excluded-address zorglub` et `ip ssh time-out zorglub`,
la ou l'aide annonce `A.B.C.D` et `<1-120>`.
**Pourquoi ce n'est pas ferme** : ce ne sont pas les declarations qui
sont trop faibles mais leur EXACTITUDE qui n'a jamais ete verifiee — il
y en a 190, ecrites pour rendre une aide fidele, jamais pour arbitrer.
Les faire trancher demande de les auditer une par une contre ce que la
commande accepte vraiment, ce qui est un chantier a soi et non
l'extension d'un correctif. La plage numerique a ete prise d'abord parce
que c'est la seule partie d'une declaration qui soit sans ambiguite :
`<1-120>` ne peut pas vouloir dire autre chose. Depuis le lot « une
plage annoncee suit l'etat », une declaration PEUT lire la session
(`rangeIsAdvisory` + `SessionParamRanges`), mais une seule s'en sert —
le numero de groupe HSRP. Depuis le lot « `access-list ?` annonce les
quatre plages d'IOS », une place peut en annoncer PLUSIEURS et n'est
refusee que si la valeur est hors de TOUTES (`alternatives`), ce que les
deux mecanismes de declaration jugent desormais par la meme regle.


### [cli] cinq commandes de fichier repondent en EXEC UTILISATEUR
`dir`, `more`, `pwd`, `delete`, `verify`, `mkdir`, `rmdir` et `squeeze`
repondent aussi bien avant `enable` qu'apres, sur le routeur comme sur
le commutateur.
**Mesure** : sur une machine neuve, sans `enable`, les huit rendent leur
sortie normale au lieu de `% Invalid input detected`.
**Cause** : `registerFileSystemCommands` porte le commentaire inverse
(« Enregistre sur la trie privilegiee uniquement ») et etait appelee avec
la trie BRUTE et non par `scopedTrie`, le mecanisme prevu exactement pour
cela (`PRIVILEGED_EXEC_ONLY`). La declaration au socle a preserve la
portee mesuree plutot que de la changer dans un lot de migration.
**Ce que dit la reference Cisco** : `dir`, `more` et `pwd` sont bien des
commandes d'EXEC utilisateur, et la reference des fondamentaux decrit
aussi `delete` comme « EXEC, privileged EXEC, or diagnostic mode » et
`squeeze` comme « EXEC command » — donc cinq des huit sont conformes.
`verify` est documentee privilegiee ; `mkdir`/`rmdir` sont donnees en
mode chargeur d'amorce sur Catalyst et en EXEC privilegie sur routeur.
**Report** : restreindre la portee change ce que la machine accepte, ce
qu'un lot de migration ne doit pas faire ; et les trois cas restants
demandent chacun une reference propre a la plateforme, la reponse
n'etant pas la meme sur un 2900 et sur un 2960.

### [socle] deux familles sont migrées sur le commutateur VRP
Le pont existe des DEUX côtés : `VRP_SWITCH_MODES` décrit la hiérarchie
des treize vues du commutateur, et `HuaweiSwitchShell` consulte le socle
avant son trie, comme le routeur. Deux familles l'empruntent (`mtu`,
`clock timezone`) ; le reste du vocabulaire du commutateur — `vlan`,
`port-group`, `traffic-*`, `mst-region` — vit toujours sur `CommandTrie`.
**Report** : incrémental par construction, comme côté routeur.

### [socle] trois familles VRP sont migrées sur le routeur
Le pont est branché et exercé par la famille du client DHCP, celle des
paramètres physiques d'interface (`mtu`, `bandwidth`) et celle de
l'horloge (`clock timezone`). Le reste du vocabulaire VRP — plusieurs
centaines d'enregistrements — vit toujours sur `CommandTrie`.
**Report** : la migration est incrémentale par construction ; chaque
famille reprise ferme une part de cette entrée. Ce que la deuxième a
appris : une famille ne vaut d'être migrée que si le socle lui APPORTE
quelque chose — ici l'argument typé, qui a fermé cinq défauts d'un coup —
et il faut RETIRER l'enregistrement du trie en même temps, sans quoi on
laisse deux implémentations dont une morte.

### [cli] `line aux 0` ne persiste que deux reglages sur les huit
Mesure sur un routeur, en configuration : `line aux 0` puis
`exec-timeout 1 0` est ACCEPTE, et `show running-config` ne rend AUCUN
bloc `line aux 0`. Le reglage est perdu, donc non rejoue a l'import
d'une topologie, et rien ne le dit.
**Cause** : `_getAuxLineConfig()` ne porte que `noExec` et
`transportInput` ; le gestionnaire partage des vingt mots-cles de ligne
tombe sur `return ''` pour tous les autres des que la ligne selectionnee
est l'auxiliaire. Le meme reglage tape sous `line console 0` ou
`line vty 0 4` est, lui, retenu et rendu.
**Report** : ce n'est pas la PORTE `line` — qui vient d'etre corrigee et
qui designe desormais correctement l'auxiliaire — mais le MAGASIN de
cette ligne, qui n'a que deux champs. L'etendre veut dire lui donner les
memes champs que la console, donc toucher le rendu de configuration et
la vue `show line` ; c'est un lot a part.

### [cli] la borne de `line tty` est posee par symetrie, pas par mesure
`SORTES_DE_LIGNE` borne `tty` a `<0-15>`, la meme valeur que `vty`.
Console et auxiliaire tiennent de la documentation Cisco (`<0-0>`, un
chassis n'en a qu'une), les seize terminaux virtuels aussi. Pour `tty`,
la borne depend des cartes asynchrones presentes et ce simulateur n'en
modelise aucune : la valeur exacte n'y est donc pas observable.
**Report** : la borne d'avant — aucune — etait la seule certainement
fausse, puisqu'elle laissait poser `line tty 99999`. Celle-ci est
plausible et declaree comme telle plutot que presentee comme mesuree.

### [cli] `spanning-tree vlan <n> priority ?` n'annonce pas sa plage
La branche `vlan` de `spanning-tree` reste un noeud GLOUTON, donc l'aide
y rend la liste du parent (`backbonefast`, `bpdufilter`, …) au lieu de
`<0-61440>`. **La plage est bien APPLIQUEE** — `priority 61441` et
`priority 4097` sont refuses, le second dans les mots d'IOS — seule son
annonce manque.
**Pourquoi ce n'est pas un oubli** : la declarer demande un mot-cle
APRES une place (`vlan <liste> priority <valeur>`), et la valeur depend
du mot-cle — `priority` vaut 0-61440, `hello-time` 1-10, `max-age` 6-40.
Une declaration POSITIONNELLE annoncerait donc une plage fausse pour les
minuteries, ce qui serait pire que l'absence. C'est la migration au
socle qui porte cette forme.

### [cli] la priorite de PORT est ARRONDIE la ou IOS refuse
`spanning-tree port-priority 100` est accepte et l'agent arrondit a 96.
La documentation Cisco donne la plage « 0 a 240, par pas de 16 », et
pour la priorite de PONT — meme formulation — elle precise que toute
autre valeur est REJETEE (`% Bridge Priority must be in increments of
4096.`), ce que ce depot applique desormais.
**Report** : l'arrondi est un choix DEJA pris, ecrit dans le code et
epingle par `stp-prd-fidelity` (« port-priority lands in the high byte
of the port ID, rounded like IOS »), avec pour motif que deux refus pour
une meme saisie seraient un refus de trop. Le renverser sans que l'agent
qui l'a pris le dise ferait tomber son cas ; l'ecart est donc inscrit
ici plutot que tranche unilateralement.

## Routeur Cisco

### [ssh] `ssh` entre deux hotes ne traverse PAS le fil
**Constat.** `ssh alice@10.0.2.10 whoami` lance par `executeCommand`
rend `alice` sans qu'AUCUNE trame n'atteigne le serveur. Mesure : une
prise posee sur le port du serveur voit les deux trames d'un `ping`
(`in/ipv4/1`, `out/ipv4/1`) et ZERO pendant le SSH qui reussit.

**Ce qui tient lieu de reseau.** `LinuxSshClient` appelle
`transitTcpAclVerdict` (`devices/linux/network/HostLookup.ts`), qui
parcourt la topologie depuis le port source, suit les cables, et evalue
un SYN SYNTHETIQUE contre la liste de chaque routeur rencontre — par
`evaluateACLByName`. C'est une SECONDE implantation de « ce paquet
passerait-il ? », a cote de `evaluateForDataPlane` que suit le vrai plan
de donnees, et les deux peuvent diverger sans que rien ne l'empeche.

**Comment cela a ete trouve.** En discriminant
`acl-protocoles-applicatifs` : les cas de blocage SSH ne tombaient pas
avec `evaluateForDataPlane` neutralise, alors que HTTP, SMTP et FTP
tombaient. Neutraliser `evaluateACLByName` a la place les fait tomber
tous les deux — donc c'est bien cette fonction, et non le plan de
donnees, qui decide du sort de SSH.

**Consequence, et elle depasse l'ACL.** Le verdict rendu est JUSTE
aujourd'hui (sans liste ca marche, `deny ip any any` coupe,
`permit tcp … eq 22` retablit, `eq 23` ne sauve pas), mais il est
REJOUE et non SUBI : rien ne garantit qu'il suive le plan de donnees le
jour ou l'un des deux change. Et cela contredit la regle que ce depot
pose comme obligatoire — tout echange entre deux machines doit traverser
le reseau simule comme de vraies trames.

**Raison du report.** Faire passer ce client par une vraie session TCP
est le chantier d'unification des deux piles SSH que le depot documente
deja comme large ; `transitTcpAclVerdict` a par ailleurs d'autres
lecteurs (traceroute, sondes UDP) qui disparaitraient avec lui.

### [acl] GRE n'est pas eprouvable sur un routeur Cisco
La matrice « chaque protocole a son transport » couvre OSPF, EIGRP, RIP,
BGP, DHCP et IPsec, et laisse GRE dehors.
**Mesure** : le moteur d'encapsulation (`GreAgent`) est reel mais n'est
cable que pour la commande Linux `ip tunnel` ; la CLI Cisco
`tunnel source` / `tunnel destination` ne remplit aucune table lue par
le plan de donnees. Un cas GRE sur routeur Cisco mesurerait donc
l'absence du tunnel, pas la liste.
**Report** : c'est le manquement GRE deja connu (`docs/roadmap.md`
§14.5), pas un defaut d'ACL. La couture d'apres-liste posee ici
(`receiveControlPlaneIpv4`) accueille deja GRE, donc le jour ou le
tunnel Cisco transporte, la liste le verra sans autre changement.

### [acl/ipsec] l'autre moitie de « Crypto Access Check on Clear-Text Packets »
La moitie ENTRANTE est fermee : une liste `in` ne rejuge plus le paquet
dechiffre, ni les paquets que le routeur EMET. Reste la moitie
SORTANTE de la meme fonction d'IOS 12.3(8)T — le paquet en clair est
encore controle contre la liste SORTANTE AVANT chiffrement, la ou une
machine moderne y soumet le paquet CHIFFRE.
**Mesure** : `forwardPacket` evalue `getInterfaceACL(route.iface, 'out')`
puis chiffre ; les deux etapes sont dans cet ordre dans le corps de la
methode. Une liste sortante `deny esp any any` ne voit donc rien alors
qu'une vraie machine refuserait le tunnel.
**Report** : inverser les deux deplace le chiffrement dans le pipeline
au lieu d'ajouter une garde, et le chiffrement est suivi d'une
re-entree qui reroute le paquet — donc la liste sortante de l'interface
FINALEMENT choisie n'est pas forcement celle qu'on vient d'evaluer.
C'est une reorganisation de `forwardPacket`, pas un parametre.

### [acl/ipsec] les listes declarees SOUS la crypto map n'existent pas
`set ip access-group <n> in|out` est la maniere moderne de filtrer le
trafic en clair d'un tunnel, celle qu'IOS 12.3(8)T offre en echange du
double controle qu'il retire. La commande n'est pas reconnue.
**Mesure** : `set ip access-group 150 in` sous `crypto map CMAP 10
ipsec-isakmp` repond `% Invalid input detected`.
**Report** : demande un point de filtrage propre au tunnel, la ou le
plan de donnees ne connait aujourd'hui que les listes d'INTERFACE.

### [cli] un sous-mode atteint les commandes GLOBALES, et `show` marche sans `do`
Mesure sur un Catalyst en `config-if` : `hostname ZORGLUB`,
`dot1x system-auth-control` et `ip finger` sont ACCEPTES, et
`show dot1x` comme `show version` repondent en configuration sans `do`.
Un vrai IOS refuse les trois premiers (`% Invalid input`) et exige `do`
pour les deux dernieres.
**Ce qui le produit** : deux mecanismes distincts, et c'est pour cela
que ce n'est pas un correctif d'une ligne — le socle admet une commande
dont le mode est un ANCETRE du mode courant (`CommandTable.modeAdmits`
lit `session.configAncestors()`), et le shell a par ailleurs un repli
qui laisse une vue repondre en configuration.
**Pourquoi ce n'est pas ferme** : la regle des ancetres est ce qui rend
atteignables, depuis un sous-mode, les familles que le socle declare en
`config` — la fermer d'un coup demanderait de declarer explicitement
tous les modes de chaque famille migree, donc de rouvrir toutes les
migrations faites. Et le repli de `show` est probablement voulu : un
laboratoire tape `show running-config` sans quitter la configuration a
longueur de temps. A trancher AVANT que le trie ne disparaisse, pas
apres.

### [cli] un prefixe ambigu est-il tranche par le mot SUIVANT ?
Le socle resout un mot-cle ambigu par le mot SUIVANT
(`CommandParser.accepteEnsuite`) : `switchport port-security ma 4`
designe `maximum`, la seule branche qui accepte un nombre, et
`clear`/`clock` se departagent de la meme facon. La regle est ecrite et
testee (`clear-family-slice.test.ts`).
**Le doute, mesure et non tranche** : un vrai IOS repond
`% Ambiguous command:  "cl arp"` en ECHOANT la ligne entiere, ce qui
suggere qu'il decide au premier mot sans regarder la suite. Neutraliser
le regard en avant fait tomber exactement 3 cas sur 2590, tous de cette
suite-la — donc le choix est bien isole.
**Pourquoi ce n'est pas ferme** : il faut une transcription de vraie
machine pour trancher, et `cisco.com` est bloque par le mandataire de
sortie. Les deux comportements sont defendables ; ce qui ne le serait
pas, c'est que l'aide et l'execution ne suivent pas la meme regle.


### [acl] deux magasins modelisent « un groupe nomme d'adresses »
`ACLEngine.ObjectGroup` (membres INLINE : `host <ip>`,
`<reseau> <masque>`, `any`, compares en echec ferme par
`objectGroupMatches`) et `firewall/model/ObjectStore.ObjectGroup`
(membres NOMMES, imbrication, detection de recursion, resolution
FQDN/pays/etiquettes) decrivent le meme concept avec deux modeles de
membre — et portent le MEME nom de type dans deux modules, ce qui est en
soi un piege de lecture.
**Mesure** : `object-group network SERVEURS` sur un routeur et sur un
ASA remplissent deux magasins sans rapport.
**Pourquoi ce n'est pas ferme** : fondre le premier dans le second
demande de synthetiser un objet anonyme par membre inline et de
reconstruire les lignes d'IOS a l'affichage. En echange, l'imbrication
(`group-object`) deviendrait possible. C'est un chantier a soi, pas
l'extension du correctif qui a rendu le groupe evaluable.

### [acl] deux formes du sous-mode `object-group` restent refusees
La ligne `<reseau> <masque>` SANS mot-cle initial, qu'un vrai IOS
accepte a l'interieur du sous-mode, est refusee : la table du socle
comme le trie indexent par le premier mot, et une ligne qui commence par
une adresse n'en a pas. `network <reseau> <masque>` est exigee.
`group-object <nom>` est refusee plutot que rangee, faute de resolution
de l'imbrication : ranger un membre que la comparaison ne lit pas ferait
d'une ACE citant ce groupe une regle PLUS ETROITE que ce que
l'operateur a ecrit.
**Report** : la premiere demande une entree indexee autrement que par un
mot-cle ; la seconde demande l'entree precedente.

### [acl] le sous-mode `object-group` n'existe pas sur le commutateur
`CiscoSwitchShell` n'a pas de moteur d'ACL a alimenter — son
`getVaclEngine()` est un autre magasin — donc `object-group network` est
declare sur le seul routeur, contre l'uniformite visee entre
equipements Cisco.
**Report** : demande de choisir ce qu'un groupe veut dire pour une VACL
avant de le declarer.

## Pare-feu FortiGate

### [interface] `allowaccess` du PROFIL n'est applique a personne
**Constat.** `FORTIGATE_60F_PORTS` declare `allowaccess` sur `port1`
(`ping https ssh http fgfm`) et sur `wan1` (`ping`), et le constructeur
de `Firewall` ne lit que `ip`/`mask` de ces declarations. Le magasin du
plan de gestion reste donc VIDE a la sortie d'usine, alors que
`show system interface port1` rend bien la ligne `set allowaccess ...`
— deux reponses a la meme question sur la meme machine.

**Mesure.** Machine d'usine, aucune commande tapee :
`allowedAccessOn('port1')` rend `[]` pendant que la configuration rendue
annonce cinq services. Le defaut n'est pas visible aujourd'hui parce que
`ManagementPlane.allowsAccess` rend `true` quand l'interface n'est pas
declaree — l'absence est donc PERMISSIVE, et tout passe.

**Report.** Appliquer la declaration RESTREINT pour de bon : `wan1`
n'accepterait plus que `ping`, donc ssh et https sur `wan1` cesseraient
de repondre. C'est le comportement d'un vrai FortiGate, mais c'est un
changement du plan de GESTION et non de la relation interface/port que
le lot courant referme, et il demande de reprendre les laboratoires qui
joignent l'administration par une interface WAN.

### [ssh] un mot de passe VIDE ne traverse pas le terminal interactif
**Constat.** Le compte `admin` d'usine a un mot de passe vide et le
pare-feu l'accepte — `authenticateAdmin('admin', '')` rend `true`, et
`ManagementPlane.requiresPasswordChange` existe justement pour ce cas.
Mais `ssh admin@192.168.1.99` depuis un terminal, en validant une saisie
vide a l'invite, rend `Permission denied, please try again.`

**Mesure.** Meme laboratoire, deux cas : mot de passe vide → refus ;
`set password "Secret123"` puis ce mot de passe → la session s'ouvre sur
l'invite `FGT #`. Le serveur n'est donc pas en cause, son
`checkPassword` delegue directement a `authenticateAdmin`.

**Report.** Le refus vient du chemin CLIENT (la saisie vide n'est pas
soumise), qui est commun a toutes les plateformes et non propre au
pare-feu ; le trancher demande de mesurer d'abord ce que fait la meme
saisie vers un hote Linux dont le compte n'a pas de mot de passe, sans
quoi on corrigerait un symptome sur une seule cible.


### [vdom] `set vdom-mode split-vdom` est accepte et se comporte comme multi-vdom
**Constat.** `vdom-mode` accepte trois valeurs. `no-vdom` et `multi-vdom`
sont honorees ; `split-vdom` est range et se replie sur `multi-vdom` —
`applyGlobalSettings` calcule `multiVdom: object.effective('vdom-mode')[0]
!== 'no-vdom'`, donc la troisieme valeur n'a AUCUN mecanisme derriere
elle. C'est la famille « accepte et inerte » que ce module referme
partout ailleurs.

**Mesure.** Le mode split-task d'un vrai FortiGate cree exactement DEUX
VDOM, `root` (gestion) et `FG-traffic` (trafic), refuse d'en creer un
troisieme, place toutes les interfaces dans `root` au depart, et
interdit a `root` de traiter du trafic. Rien de tout cela n'existe ici :
`config vdom` en cree autant qu'on veut et `root` route comme les
autres.

**Pourquoi ce n'est pas ferme.** Les deux corrections possibles — lui
donner son mecanisme, ou le REFUSER en nommant la raison — dependent de
la meme question, et les sources se contredisent : une source secondaire
affirme que le mode split-task est retire depuis FortiOS 7.2.0 et
remplace par un type de VDOM nomme `Admin`, tandis que la documentation
Fortinet decrit encore deux modes de VDOM de 6.2 a 7.6. Le profil de ce
depot annonce 7.6.3. Se tromper de sens ferait soit inventer un
mecanisme que la vraie machine n'a plus, soit refuser une commande
qu'elle accepte — les deux sont pires que l'etat actuel, qui est au
moins honnete sur son perimetre. Trancher demande la page
`split-task-vdom-mode` de la 7.6 ou une vraie machine ; les pages
atteintes depuis ce reseau sont des sommaires de navigation.

**Ferme en phase 19, et sans rapport avec la question ci-dessus** :
`vdom-mode` est une commande CACHEE sur un vrai 7.4/7.6 — absente de
`show`, de `show full` et de la liste du `?`. Elle l'est desormais ici
aussi, tout en restant acceptee et honoree.

### [vip] `set type dns-translation` est refuse faute de relais DNS de transit
**Constat.** `config firewall vip` accepte trois types. `static-nat` et
`fqdn` sont commis pour de bon (phases 15a/15b) ; `dns-translation` est
REFUSE, en nommant ce qui manque, plutôt que laissé accepté et inerte.

**Mesure.** Un VIP `dns-translation` de FortiOS observe les réponses DNS
qui **traversent** le pare-feu : quand une réponse contient une adresse
de `mappedip`, elle est réécrite vers une adresse libre de la plage
`extip`, le mappage est retenu avec `dns-mapping-ttl`, et le DNAT
s'applique ensuite quand le client compose l'adresse externe. Vérifié
contre la documentation Fortinet, pas de mémoire.

**Pourquoi ce n'est pas fermé.** Il manque UNE brique nommable : un
relais applicatif (ALG) DNS sur le chemin de **transit**. Ce qui existe
déjà et servira : `decodeDnsMessage`/`encodeDnsMessage`, que
`ContentInspector` du pare-feu emploie déjà pour lire une question DNS ;
`FirewallDnsClient` pour le côté client. Ce qui manque est le point
d'accroche qui laisse RÉÉCRIRE un enregistrement A dans une réponse en
transit puis la réémettre, plus la table de mappages dynamiques et son
TTL. C'est un sujet à lui seul, pas une extension bornée du VIP, d'où le
refus explicite en attendant.

**Manque aussi, de la même famille** : `dns-mapping-ttl` (attribut du
type `dns-translation`, donc sans objet tant que le type est refusé).

**Corrigé le 2026-08-23** : cette entrée affirmait aussi que le type
`server-load-balance` « n'a aucune brique existante à réutiliser ».
C'était FAUX, et la phase 20 l'a fermé en s'appuyant sur trois briques
qui existaient — le point d'accroche unique du DNAT (qui inscrit déjà
son choix dans la session, donc la persistance était gratuite),
`FirewallPing` et `dialTcp`.

### [debug] `diagnose debug flow show iprope` est refuse
Les trois options de `show` sont desormais LUES (`function-name`, `console`,
`iprope`) au lieu d'etre confondues, mais `iprope` est refuse en nommant ce
qui manque : un vrai FortiGate ajoute a la trace les lignes de consultation
de la table `iprope` (le mecanisme noyau de choix de politique), et ce
simulateur n'en produit aucune.
**Mesure** : `diagnose debug flow show iprope enable` rend `Command fail`
avec la raison ; la trace de `diagnose debug enable` ne change pas.
**Report** : ecrire ces lignes demanderait d'inventer un journal de
consultation que le moteur de politiques ne tient pas. La politique retenue
EST deja nommee dans la trace (`Allowed by Policy-2`), donc l'option
n'apporterait qu'un texte fabrique.

### [durcissement] `config system replacemsg` ne porte que le groupe `admin`
Un vrai FortiGate en a une vingtaine (`auth`, `http`, `ftp`, `mail`,
`spam`, `alertmail`, `sslvpn`, `nac-quar`, `traffic-quota`...).
**Mesure** : `config system replacemsg auth ...` rend
`unknown configuration path`.
**Report** : les autres groupes decrivent des pages servies par des
fonctions que ce pare-feu n'a pas toutes, et une table acceptee dont le
texte n'est affiche nulle part serait le decor que ce depot passe son temps
a defaire. Le groupe `admin` est ecrit parce que ses deux messages sont
VRAIMENT affiches.

### [message] le code de retour est `-61` pour tout refus
Un vrai FortiGate distingue les codes : la transcription du refus au niveau
de la source de donnees (community.fortinet.com, « Conflict when adding
referenced interfaces that are part of SD-WAN to a zone ») porte
`Command fail. Return code -3` sous `entry not found in datasource` /
`value parse error before 'wan1'`, alors que ce module rend `-61` pour
tous ses refus.
**Mesure** : `FORTI_COMMAND_FAIL` est une constante unique
(`vendors/fortios/FortiMessages.ts:1`), lue par les vingt-huit messages du
module ; les deux LIGNES de texte au-dessus, elles, sont bien celles de la
vraie machine.
**Report** : apparier un code par famille de message demande une capture
par famille, et je n'en ai qu'une. Poser `-3` sur ce seul message ferait
cohabiter deux codes sans savoir si les vingt-sept autres sont justes ;
poser `-3` partout remplacerait une valeur uniforme fausse par une autre.
La correction est un releve de transcriptions, pas une decision de code.

### [rendu] `show <table singleton>` rend un bloc vide
`show system global` sur une machine d'usine rend `config system global`
suivi de `end`, sans une ligne entre les deux. La sauvegarde complete, elle,
omet correctement la table vide.
**Mesure** : `show system global` sur une machine neuve ; comparer avec
`execute backup config`, qui ne porte pas la table.
**Report** : deux rendus de la meme table decident differemment de ce
qu'est une table vide. Les unifier est juste, mais toucher au rendu de
`show` demande de verifier ce qu'un vrai FortiGate ecrit pour chaque
singleton — la mesure n'est pas faite.

### [ha] l'ARP GRATUIT du basculement n'est pas emis
L'adresse MAC virtuelle de grappe, que cette entree reclamait, EXISTE
desormais : `clusterVirtualMac` implante la formule de Fortinet
(`<prefixe>:<group-id % 256>:<vcluster + index>`, les quatre tranches de
group-id, les deux clusters virtuels), `applyClusterVirtualMacs` la pose
sur le port, et les deux membres la portent — `probe-pare-feu-filtre-au-
niveau-lien` epingle `00:09:0f:09:00:00` et l'egalite entre les deux
membres. **La prevision de report etait fausse, et c'est instructif** :
elle annoncait qu'il faudrait une SECONDE adresse sur `Port` et une
retouche de l'apprentissage MAC de tous les commutateurs du projet. Ni
l'un ni l'autre — une adresse virtuelle n'est pas une seconde adresse,
c'est l'adresse que l'interface PRESENTE, donc poser celle du port a
suffi et aucun commutateur n'a bouge.

Reste ouvert : **l'ARP gratuit**. Un vrai FortiGate, en devenant
primaire, emet une rafale d'ARP gratuits pour que les commutateurs
reapprennent l'adresse virtuelle sur SON port.
**Mesure** : `grep -rn "gratuitous\|garp"` sur `devices/firewall/` ne
rend rien ; apres bascule, le commutateur voisin garde l'adresse
virtuelle apprise sur le port de l'ancien primaire jusqu'a ce que le
nouveau emette quelque chose de lui-meme.
**Pourquoi ce n'est pas ferme ici** : le basculement fonctionne sans lui
dans ce simulateur, parce que le nouveau primaire emet des sa premiere
reponse et que la table du commutateur se corrige alors. L'ARP gratuit
change le DELAI, pas l'issue — et un delai n'est observable que sous une
horloge que les laboratoires de grappe n'avancent pas aujourd'hui.

### [linux] un poste Linux n'a pas de démon IKE
La commande `ipsec` lit désormais vraiment `/etc/ipsec.conf` et
`/etc/ipsec.secrets` — `statusall` rend les connexions du fichier, `up`
nomme le vrai pair et refuse une connexion inexistante dans les mots de
strongSwan —, mais aucune SA ne peut s'établir depuis un poste : seuls
`Router` et le pare-feu construisent un `IPSecEngine`.
**Mesure** : `ipsec up <conn>` refuse en nommant ce qui manque ; aucune
trame ne part.
**Report, et la premisse précédente était FAUSSE** : il ne reste pas à
« dégager le port étroit », il existe (`IpsecHost`) et un hôte qui n'est
pas un routeur le remplit déjà — `FirewallAgents.buildFirewallAgents`
construit un objet conforme et le passe au moteur. Ce qui manque
vraiment est ailleurs, et c'est plus gros : la réception des datagrammes
IKE sur 500/4500 côté hôte, et surtout un point d'accroche ESP sur le
trafic que la machine ÉMET elle-même — un routeur chiffre ce qu'il
ACHEMINE (`forwardPacket`), un poste chiffrerait ce qu'il produit, et ce
chemin-là n'a aucun crochet aujourd'hui.

### [ipsec] `diagnose debug application ike -1` ne trace rien
L'etape 10 du TP 17 fait lire le journal IKE pour reconnaitre un echec de
phase 1. `diagnose debug application ike` n'existe pas : le refus est
observable par `diagnose vpn ike gateway list` (`IKE SA: created 0/0`) et
par `get vpn ipsec tunnel summary`, mais pas par une trace ligne a ligne.
**Mesure** : un secret partage discordant donne `IKE SA: created 0/0` et
aucune ligne de trace.
**Report** : il faudrait un canal de trace par application dans le moteur
IKE partage, que ni Cisco ni Huawei n'ont ici non plus — c'est un sujet
commun aux trois constructeurs, pas une commande FortiOS.

### [identite] `diagnose firewall auth list` ne rend pas la ligne `flag(...)`
Une vraie machine ecrit `flag(10): auth` ou `flag(30): radius idle` — un
masque de bits decrivant l'etat de la session d'authentification. La vue
rend desormais `expire:` et `allow-idle:`, qui sont des MESURES, mais pas
le drapeau : ce depot n'a aucun masque de bits derriere cet etat, et
recopier `flag(10)` serait afficher un nombre que rien ne soutient.
**Mesure** : `diagnose firewall auth list` rend l'adresse, le nom, le
type, la duree, l'inactivite, l'expiration, les compteurs et les groupes.
**Report** : il faudrait d'abord modeliser les etats qu'un drapeau
distingue (`auth`, `idle`, `radius`, `src_idle`), ce qui est un sujet a
part.

### [transport] le pare-feu n'a pas de client NTP ni de sauvegarde de configuration
La couche de socket UDP existe desormais (`getUdpEndpoint()`), donc les
deux commandes qu'elle debloquait restent a ecrire : `execute backup
config tftp` / `execute restore config tftp` et un vrai client NTP —
`set ntpserver` est range et rendu, et aucun paquet ne part.
**Mesure** : `execute backup config tftp cfg 192.168.10.10` repond
`Unknown action` ; `diagnose sys ntp status` ne rend aucune association
mesuree.
**Report** : la sauvegarde suppose de decider CE que le fichier contient
(la sortie de `show` complet, chiffree ou non) ; le client NTP est un
sujet a part, et le moteur `src/network/ntp/` est ecrit contre `EndHost`
comme `TftpClientSession` l'etait — il lui faut le meme port etroit.

### [inspection] la charge processeur est DECLAREE, pas mesuree
`get system performance status` et `diagnose sys top` lisent maintenant
les MEMES faits (`diag/systemLoad.ts`), donc les deux vues ne peuvent
plus se contredire — mais ces faits sont constants : 100 % de repos et
zero octet de memoire utilise. L'etape 10 du TP 15 demande d'observer la
charge monter avec l'inspection profonde ; elle ne monte pas.
**Mesure** : ouvrir dix sessions HTTPS a travers un profil
`deep-inspection` ne change pas une ligne de `get system performance
status`.
**Report** : il n'existe aucun modele de cout processeur dans ce
simulateur ; en inventer un ferait afficher un chiffre que rien ne
soutient. Le meme raisonnement que `NO_WIRE_CLOCK` pour les limiteurs de
debit.

### [tls] l'inspection profonde relaie un aller-retour a la fois
`SslDeepInspection.terminate()` dechiffre l'ecriture du client, la
rechiffre vers le serveur, attend la reponse dans le meme tour et la
renvoie. Cela suffit a HTTP/1.1 en mode requete-reponse (c'est ainsi que
`HttpsClientSession` ecrit deja), mais une session qui recevrait du
serveur sans que le client ait ecrit, ou deux requetes en pipeline, ne
sont pas relayees.
**Mesure** : le TP 15 passe parce que `openssl s_client` et `curl`
ecrivent avant de lire.
**Report** : le relai bidirectionnel permanent demande une boucle
d'evenements que la livraison synchrone de trames ne fournit pas ici ;
c'est le meme plafond que le relai `portproxy` de Windows.

### [dns] `dns-service default` : la semantique exacte n'est pas verifiee
Trois valeurs existent — `local` (le pare-feu lui-meme), `default` (les
serveurs de `config system dns`) et `specify` (ceux nommes sous le
serveur DHCP). `local` et `specify` sont sans ambiguite ; `default` est
implemente comme « les serveurs systeme », mais la documentation
Fortinet accessible depuis ce reseau ne dit pas si un vrai FortiGate
distribue plutot sa PROPRE adresse quand le role de serveur DNS est
active sur l'interface.
**Mesure** : le laboratoire du TP 10 doit poser `dns-service local` pour
que le poste resolve la zone locale.
**Report** : trancher demande une vraie machine ; choisir au jugé
donnerait un comportement plausible et invérifiable.

### [politique] `get firewall policy` ne compte pas
Le tutoriel ecrit que cette commande affiche les octets et les paquets de
chaque politique. Elle rend la liste `== [ N ]` des cles, qui est la
forme reelle d'un `get` sur une table sans cle, et les compteurs se
lisent par `diagnose firewall iprope show`.
**Mesure** : `get firewall policy` rend deux lignes par politique ;
`diagnose firewall iprope show 100004 2` rend `hit count:` et il
progresse.
**Report** : je n'ai pas pu confronter la sortie reelle d'une machine
(documentation Fortinet inaccessible depuis ce reseau), et inventer une
sortie que le vrai produit ne rend pas serait pire que la difference.
`renderFirewallPolicy`, un TROISIEME rendu de cette table qui n'avait
aucun appelant, est supprime plutot que branche.

### [heure] la table des fuseaux FortiOS est incomplete
`set timezone` accepte desormais un nom IANA (verifie contre la VRAIE
base de fuseaux du moteur) et un indice historique <0-86>. La
correspondance indice -> nom n'est ecrite que pour les huit indices que
la documentation publique atteste ; un autre indice est accepte, rendu,
et resolu en UTC.
**Mesure** : `set timezone 37` est accepte et `execute time` rend l'heure
UTC.
**Report** : la liste complete ne se lit que sur une vraie machine
(`set timezone ?`), et l'inventer donnerait 79 correspondances fausses —
pire que l'aveu.

### [admin] le code de redirection du port d'administration n'est pas atteste
Depuis le lot « le plan d'administration ecoute », `admin-port` sert
vraiment et redirige vers HTTPS quand `admin-https-redirect` est actif.
Ce qui n'est pas atteste est le CODE de cette redirection sur une vraie
machine, ni l'en-tete `Server` qu'elle rend.
**Mesure** : la documentation Fortinet et les fils de la communaute
attestent la redirection et son activation par defaut, jamais son code ;
`docs.fortinet.com` ne rend pas de transcription HTTP depuis ce reseau.
**Ce qui est pose** : `301`, la semantique HTTP d'un changement de
schema permanent, et la sonde verifie `30x` plutot que d'epingler un
chiffre que rien ne soutient.
**Report** : trancher demande une capture de vraie machine. Le
mecanisme, lui, est complet.

## Serveurs DHCP

### [dhcp] une plage d'exclusion a l'envers est acceptee et n'exclut rien
`ip dhcp excluded-address 10.0.0.5 10.0.0.2` est accepte : les deux
bornes SONT des adresses, donc le magasin les retient. `isExcluded`
compare ensuite `ipNum >= startNum && ipNum <= endNum`, jamais vrai quand
la borne basse est la plus haute — l'exclusion ne protege donc rien,
en silence.
**Mesure** : la plage figure dans `show running-config` et dans
`getExcludedRanges()`, et une adresse de l'intervalle est distribuee.
**Report** : ce que fait une VRAIE machine n'est pas atteste depuis ce
reseau (`cisco.com` est EGRESS_BLOCKED) — elle peut refuser la ligne,
l'accepter et normaliser les bornes, ou l'accepter telle quelle comme
ici. Les trois sont plausibles et inventer un refus serait le decor que
ce depot passe son temps a defaire. Ce qui EST ferme depuis le lot
« une exclusion malformee ne rentre pas dans le magasin » : une borne
qui n'est pas une adresse est refusee aux quatre portes.


### [cli] `utilization mark high ?` annonce `<cr>` et `<0-100>`
Deux infidelites d'AIDE, pas de comportement, laissees par le lot des
seuils DHCP. **`<cr>`** : la place du pourcentage est declaree
FACULTATIVE parce que c'est la seule facon, dans le socle, qu'un
`no utilization mark high` — qui s'arrete au mot-cle, comme sur IOS —
atteigne la commande ; `CommandTable.declare` ne pose une commande sur
un noeud intermediaire que devant une place facultative. La forme
positive refuse toujours `utilization mark high` seul, donc l'aide
promet un `<cr>` que le gestionnaire refuse. **`<0-100>`** : une SEULE
declaration sert les deux seuils, dont les plages reelles different
(`<1-100>` pour le haut, `<0-100>` pour le bas), donc l'aide annonce
leur union et le gestionnaire refuse `high 0`.
**Mesure** : `utilization mark high ?` rend `<0-100>` puis `<cr>` ;
`utilization mark high` seul rend `% Incomplete command.` ;
`utilization mark high 0` rend le caret.
**Report** : fermer le premier demande que le socle sache poser une
commande sur un noeud pour sa seule forme NIEE (un `undoPath`, ou un
`undoRequiresArgument` reellement lu) ; fermer le second demande qu'une
plage puisse dependre du JETON precedent — `SessionParamRanges`, le
port pose par le lot `standby version 2`, lit la session et non la
ligne. Les deux touchent le socle CLI, pas la famille DHCP.

### [dhcp] Un pool sans adresse a distribuer ne franchit aucun seuil
`utilization mark high|low` est applique, mais `poolLeasableTotal` rend
zero quand le pool n'a pas de `network`, et l'evaluation SAUTE alors le
pool : un pool declare et jamais reseaute ne franchit donc rien, meme a
100 % d'un total nul.
**Mesure** : `evaluateUtilizationMarks` sort par `if (total === 0)
continue`.
**Report** : c'est le choix juste par defaut — un pourcentage d'un
denominateur nul n'a pas de valeur — mais une vraie machine refuse la
commande `network` manquante autrement, et savoir laquelle des deux
elle fait demanderait une capture qu'on n'a pas.

### [dhcp] Windows : le basculement et l'export restent absents
`Get-DhcpServerv4Binding`, `Get-/Set-DhcpServerv4DnsSetting` sont
désormais déclarées et réelles. Restent absents
`Add-DhcpServerv4Failover`, `Get-DhcpServerv4Failover` et
`Export-DhcpServer`/`Import-DhcpServer`.
**Mesure** : ces trois familles ne sont pas dans le module.
**Report** : le basculement demande un second serveur et un protocole de
synchronisation entre les deux — un sujet en soi, pas une applet de plus.
L'export/import est faisable (le VFS existe) mais suppose d'écrire le
XML qu'un vrai Windows produit, et de le relire.

### [ddns] GSS-TSIG (Kerberos) n'est pas modélisé
TSIG à clé partagée (RFC 8945) est écrit, signe et vérifie vraiment ; ce
qu'un Windows appelle « Secure only » sur une zone intégrée à l'annuaire
est GSS-TSIG, c'est-à-dire TSIG dont la clé vient d'une négociation
Kerberos (TKEY). Ici, `Set-DnsServerPrimaryZone -DynamicUpdate Secure`
exige une signature TSIG valide sous une clé déclarée par
`Add-DnsServerTsigKey` — même mécanisme de signature, source de clé
différente.
**Mesure** : aucun échange TKEY n'existe dans le dépôt, et
`Add-DnsServerTsigKey` n'a pas d'équivalent sur une vraie machine
Windows (c'est la forme BIND du même besoin).
**Report** : GSS-TSIG demande Kerberos — TGT, ticket de service pour
`DNS/<serveur>`, jeton GSS-API —, un sujet à lui seul. Le choix fait ici
est écrit plutôt que tu : la sécurisation est RÉELLE et vérifiable, sa
distribution de clé ne l'est pas.

## SSH

### [ssh] toutes les lignes du journal portent le PID de l'ECOUTEUR
Depuis que `pam_unix(sshd:session)` a un seul producteur — le
syslogger —, les quatre lignes d'une connexion partagent le meme
`sshd[<pid>]`, celui du processus qui ECOUTE. C'est deja plus juste
qu'avant, ou `Accepted` portait le PID de l'ecouteur et la ligne pam
celui de l'enfant : un vrai sshd ecrit les deux depuis le MEME
processus, l'enfant qui sert la connexion. Ce qui reste faux est
lequel : il devrait s'agir d'un PID par CONNEXION, pas de celui de
l'ecouteur.
**Mesure** : quatre clients, `sshd[22]` partout, alors que le tableau
des processus porte bien un `sshd: alice [priv]` par session.
**Report** : le syslogger est construit une fois par machine avec un
`sshdPid` fixe ; lui faire porter un PID par connexion demande de lui
passer l'enfant a l'emission, donc de faire voyager cette identite dans
les evenements du bus — un changement de la forme des evenements, pas
du format des messages.

## Couche lien

### [vlan] la vue trunk et la vue sous-interface ne portent pas le meme segment
`scenario-vlan-8021q-trunk.test.ts`, cas « la taille de trame differe
exactement de 4 octets entre la vue trunk (tagguee) et la vue
sous-interface (sans tag) d'un meme type de segment TCP », ECHOUE avec
`expected undefined to be defined` : l'une des deux vues ne trouve
aucune trame du type cherche, donc la comparaison des tailles n'a pas
lieu. Les 10 autres cas du fichier passent.
**Mesure** : l'echec est reproduit a l'identique sur `549f5f4a7`
(« Couche lien — les dix repertoires L2 emettent par la couche ») ET sur
son parent `6deee89eb` (« STP, CDP et LLDP emettent PAR la couche ») —
il est donc anterieur a ces deux commits ou introduit plus tot dans la
meme serie, et en tout cas ETRANGER au travail SSH/DHCP/NetFlow de cette
session.
**Report** : le defaut est dans l'aire que l'autre agent refond en ce
moment (l'emission par la couche liaison, phase 1 achevee, phase 2 en
cours). Y toucher en parallele produirait un conflit sur le meme code ;
l'entree est inscrite pour que le rouge soit NOMME et non pris pour du
bruit.

## Bus d'evenements

### [nhrp] `debug nhrp` n'a toujours pas d'emetteur, faute de transcription
`NhrpDomainEvent` est desormais dans l'union `DomainEvent`, donc un
abonnement compile — c'etait le blocage que
`cisco-debug-no-empty-promise.test.ts` nommait. Ce qui manque est la mise
en forme : `RouterDebugService` accepte la categorie `ip.nhrp` et
n'ecrit aucune ligne.
**Mesure** : `debug nhrp` est accepte et ne produit rien ; les quatre
sujets `nhrp.*` sont publies par `NhrpEngine`.
**Report** : les lignes de `debug nhrp packet`/`cache` d'un vrai IOS ne
sont attestees par aucune source joignable depuis ce reseau (les pages
Cisco sont bloquees, `ntc-templates` ne porte aucune capture NHRP, et la
recherche de code GitHub est hors perimetre de cette session). Ecrire un
format de memoire donnerait une sortie que la vraie machine ne rend pas.

### [vtp] un `join` part avec un condense de mot de passe VIDE
`VtpFrame.passwordHash` est desormais declare — il etait ecrit et LU
(c'est le controle MD5 du domaine) sans figurer dans le type. En le
declarant, un ecart apparait : `sendJoin()` pose `passwordHash: ''` alors
que le recepteur compare ce champ a `hashPassword(...)` pour TOUTE trame
recue, donc dans un domaine protege par mot de passe un `join` d'elagage
est rejete en `password-mismatch`.
**Mesure** : lecture des trois sites de construction ; seuls le sommaire
et le sous-ensemble calculent le condense.
**Report** : trancher demande de savoir si une vraie trame VTP Join porte
le condense. Le dissecteur `packet-vtp.c` et `vtp_generate_md5()` de
Yersinia decrivent le SOMMAIRE ; ni l'un ni l'autre ne dit ce que porte un
Join. Poser le condense « par symetrie » ou exempter le Join du controle
sont deux inventions opposees, aussi peu attestees l'une que l'autre.

## Outillage

### [e2e] la PREMIÈRE navigation d'une exécution à froid dépasse le délai
Mesuré : `npx playwright test <n'importe quel spec>` sur un serveur de
développement non démarré fait échouer le PREMIER test sur
`page.goto('/')` — 30 s dépassées —, et tous les suivants passent. Vérifié
par `--repeat-each=2` sur un seul cas : la première exécution tombe, la
seconde passe. Ce n'est donc pas le spec mais l'amorçage de Vite.
**Report** : le délai est global (`playwright.config.ts` : `timeout` du
test et `timeout` du serveur, 30 s chacun), donc le corriger touche un
fichier partagé et toute la suite ; le relever dans un seul spec
soignerait le symptôme à un endroit alors que tous y sont exposés. À
trancher avec l'autre agent, qui exécute la même suite.

### [typecheck] 229 erreurs de type au compteur
`npm run typecheck` en compte 229, contre 341 avant la passe de cette
session. Les erreurs des fichiers de PRODUCTION ont presque toutes été
fermées, et chacune disait quelque chose : quatre déclarations d'une même
entrée ARP, quatre sujets de bus publiés et indéclarables, un `Send-
MailMessage -Credential` qui ne s'authentifiait jamais, un bloc mort
recopié dans trois adaptateurs de shell, plusieurs contrats décrivant
moins que ce qui les traverse. Le reste est presque entièrement dans les
tests : arguments de `DeviceType` passés à l'envers, `MACAddress` là où un
nombre est attendu, signatures de constructeur périmées.
**Mesure** : `npm run typecheck 2>&1 | grep -c "error TS"`.
**Report** : dette réelle mais indépendante ; la règle en vigueur reste
« pas plus qu'avant ta modification », pas « zéro ». Ce qui est acquis,
c'est que lire ces erreurs plutôt que les faire taire trouve de vrais
défauts — la méthode vaut d'être reprise sur le reliquat.

## Journal des entrées fermées

- Sonde d'avant-offre DHCP en ICMP — fermee, et la premisse du report
  etait fausse une fois de plus : « un emetteur ICMP synchrone qui
  n'existe sur aucun des trois serveurs ». La livraison de trames est
  SYNCHRONE dans ce simulateur — le pare-feu le prouvait deja avec
  `FirewallPing.step()` — donc un abonnement pose juste avant l'envoi
  voit la reponse revenir pendant l'appel. Le cas qui distingue les deux
  sondes est atteignable : `iptables -A INPUT -p icmp -j DROP` sur un
  hote qui repond a l'ARP, et il est desormais eprouve par test.

- Vocabulaire d'états de `display stp brief` — ferme (l'entree ci-dessus
  ne porte plus que la question du LISTAGE). La table melangeait DEUX
  vocabulaires dans la meme vue : `DISCARDING` pour le lien redondant et
  `LISTENING` pour les ports sans cable. Atteste chez Huawei : RSTP et
  MSTP n'ont que trois etats — Discarding, Learning, Forwarding — les
  Listening et Blocking de 802.1D y ayant ete FONDUS dans Discarding.

- `spanning-tree mode mst` cote Cisco — passe au banc, et la premisse de
  l'entree etait FAUSSE : l'arbre ne repart pas d'une instance vide, il
  reste convergé (le voisin bloque toujours son second lien) et la
  priorite passe correctement de 32769 a 32768 en perdant l'extension de
  VLAN. Le vrai defaut etait ailleurs et n'avait pas ete vu :
  `show spanning-tree` ne suivait PAS le mode — il annoncait
  `VLAN0001 / protocol ieee` sur une machine en MST, pendant que
  `show spanning-tree mst` rendait `MST0` au meme instant. Ferme avec
  deux ecarts voisins mesures sur la capture `ntc-templates` : le bloc
  `Bridge ID`/`Hello Time`/`Aging Time` manquait entierement, et le
  tableau des ports etait a des largeurs inventees.

- `broadcast-suppression` decorative et `qos car` texte sur un
  commutateur VRP — les DEUX fermees, et la mesure a montre que le report
  reposait sur une premisse fausse : `CarPolicer` n'avait AUCUNE
  dependance a `Router`, il vivait seulement dans son dossier. Le
  « travail d'architecture » annonce etait un deplacement de fichier.
  `multicast-suppression` et `unicast-suppression` existent avec, la
  famille etant desormais construite par une boucle sur les trois genres
  de trafic plutot que mot a mot.

- Table de routage montree contre table reelle — fermee, et le defaut
  touchait TOUT hote et non le seul pare-feu. Mesure sur un PC Linux :
  apres `ip addr add 192.168.10.10/24 dev eth0`, `ip route` montre la
  route connectee et `observables.routes` est VIDE, `routeCount` a 0 —
  donc le panneau annonce « ROUTING TABLE (empty) » pour une machine qui
  a une route. `configureInterface`, le chemin le plus courant, poussait
  la route sans l'annoncer, comme six autres points de mutation sur
  dix-sept. Referme par la STRUCTURE plutot qu'au cas par cas : le champ
  devient un accesseur (toute reaffectation rafraichit) et les sept
  `push` passent par `addRouteEntry`, donc le dix-huitieme point de
  mutation ne pourra pas etre oublie.

- Panneau « Live state » d'un pare-feu — ferme. Mesure au navigateur :
  ARP, routes, TCP, compteurs, TOUTES les sections rendaient « (empty) »
  pour un FortiGate qui portait au meme instant une interface adressee,
  une entree ARP pour le voisin qu'il venait de pinguer et une vraie
  pile TCP ; le PC Linux a cote montrait les siennes. Le panneau
  n'etait pas casse — le pare-feu n'exposait aucun `observables`, que
  `resolveObservables` lit par canard.

- `execute backup config` / `restore config` / `factoryreset` — fermees.
  Les trois briques existaient sans porte : le client TFTP (`put` ET
  `get`), `renderWholeConfig`, et la boucle qui rejoue une configuration.
  Deux choses ne s'inventent pas et sont ecrites en test : une
  restauration REMET A ZERO avant de rejouer, sinon elle superpose ; et
  une remise a zero doit rejouer les DEFAUTS, les effets d'une
  configuration vivant sur l'equipement et pas dans l'arbre.

- `diagnose sniffer packet` au fil de l'eau — fermee. Dans un terminal il
  ecrit paquet par paquet et Ctrl+C l'arrete ; et il capture A PARTIR DE
  MAINTENANT au lieu de rejouer le tampon, ce qui est la difference qui
  rend la commande utilisable. Hors terminal il garde son texte d'un
  bloc, un script n'ayant personne pour provoquer le trafic pendant
  qu'il attend.

- `execute traceroute` du FortiGate — fermee, et le defaut etait plus
  profond que « la vue est fausse » : la commande n'avait JAMAIS trouve
  quoi que ce soit. `buildEchoRequest` calcule la somme de controle IPv4
  avec un TTL de 64 et le traceroute la reposait ensuite par
  `{ ...request, ttl }`, donc chaque sonde etait jetee comme corrompue
  par le premier equipement qui verifie l'en-tete. La meme machine au
  meme instant repondait au `ping`.
- `execute ssh` / `execute telnet` du FortiGate — fermees ; branchees sur
  la machinerie de client que le socle portait deja pour IOS et VRP.

- Console FortiGate : `exit` ne sortait pas, la console ne se reglait pas
  — fermee. `exit`/`quit` etaient REFUSES (« unknown command ») alors que
  la porte d'entree venait d'etre posee ; `config system console`
  n'existait pas, donc le pager `--More--` etait inevitable ; `execute
  reboot`/`shutdown` n'existaient pas. Mesure corrigee en chemin :
  l'historique (fleches) et l'edition de ligne (Ctrl-U/W) etaient crus
  absents et fonctionnaient — c'est le pager qui avalait les touches.

- Console FortiGate : login au demarrage et mot de passe force — fermee.
  La mesure a trouve plus large que l'entree : `authenticateAdmin`
  comparait `secrets.get(name) === password`, donc un compte sans entree
  de secret n'acceptait AUCUN mot de passe, pas meme le vide — le compte
  d'usine `admin` etait inauthentifiable par construction. Le forcage
  repose sur le mot de passe VIDE et non sur un drapeau de premier
  demarrage, donc `set password` le fait cesser et le vide le fait
  revenir. Verrouillage apres N essais laisse ouvert ci-dessus.

- Base OSPF du pare-feu — fermée, et la mesure d'origine était FAUSSE : la
  base n'était pas vide (elle portait les deux LSA de routeur), il y
  manquait le LSA de RÉSEAU du lien de transit, sans lequel le SPF ne
  traverse pas. Le DR ne réannonçait son type 2 que sur `ospf.dr-election`,
  jamais quand un voisin devient `Full` (RFC 2328 §12.4.2) : un pare-feu
  raccordé après l'élection ne le recevait donc jamais. Fermée avec deux
  défauts voisins : `default-information originate` était la seule des trois
  commandes de sa famille à ne pas converger (son propre `no` le faisait),
  donc le LSA externe naissait au hasard d'une commande ultérieure ; et le
  type de route OSPF était jeté à l'installation dans la RIB du pare-feu,
  qui rendait `O` là où FortiOS rend `O*E2`.
- Numérotation des catégories de journaux FortiOS — fermée. La table du
  simulateur était CONTIGUË (11 waf, 12 dns, 13 ssh, 14 ssl, 15
  file-filter) là où la vraie a des TROUS (12 waf, 15 dns, 16 ssh, 17
  ssl, 19 file-filter, 20 icap, 22 sctp-filter) : signature d'une
  invention plausible. Alignée sur deux sources concordantes, et le
  tutoriel corrigé avec elle.
- Continuation de ligne par accent grave en PowerShell — fermée.
- ScopeId d'un scope DHCP Windows = adresse réseau — fermée.
- Option 54 d'un serveur DHCP Windows = son adresse, pas la passerelle —
  fermée.
- `Add-DhcpServerInDC` retenait ses paramètres — fermée.
- Relais DHCP vers un serveur Windows (giaddr) — fermée ; le rôle passe
  par `DhcpServerExchange` au lieu d'en tenir une troisième copie.
- Un serveur DHCP ne propose plus sa propre adresse — fermée.
- Un serveur DHCP Windows enregistre le bail dans le DNS — fermée ;
  `applyDynamicARecord` n'avait AUCUN appelant.
- Le client DHCP déclare son nom (options 12 et 81) — fermée ;
  `EndHost` ne le transmettait jamais à son client DHCP.

- `mac-address learning disable` (VRP interface + VLAN) et
  `no mac address-table learning` (Cisco) — fermé, moteur réel sur le
  chemin de données, les deux actions `discard`/`forward`.
- `mac-address static` / `blackhole` / `aging-time` sur VRP — fermé.
- Famille `stp` du commutateur VRP — fermé.
- Vue `port-group` (temporaire et permanente) — fermée : les commandes
  atteignent vraiment chaque membre, les groupes permanents vivent sur
  l'équipement et se rendent, `display port-group` existe.
- `#` ne ramenait pas en vue de base au REJEU d'une configuration VRP —
  fermé dans `replayVendorConfig` ; un bloc d'interface vide faisait
  perdre tout ce qui le suivait.
- `interface range` sur les DEUX constructeurs — fermé : la diffusion
  aux membres n'est plus déclarée commande par commande, la liste
  séparée par des virgules est admise, une borne inexistante est refusée.
- `tsc --noEmit -p tsconfig.json` ne vérifiait RIEN (fichier de solution,
  `"files": []`) — `npm run typecheck` ajouté et le piège écrit dans
  `CLAUDE.md`.

- La passe d'ENUMERATION de l'adaptateur écrivait dans les vrais arbres —
  fermée. `registerCommonConfigCommands(trie)` ignorait son paramètre en
  quatre points (`this.configTrie`) et `registerConfigIfCommands` bâtissait
  son paquet dot1x/LACP sur les arbres réels ; `buildRoutingProtoConfig`
  recevait le vrai sous-arbre `router`. Chaque `specsFromTrieRegistrations`
  réenregistrait donc la famille entière : 237 écrasements silencieux, et
  `command-trie-hygiene` — le garde-fou dont c'est l'objet — était rouge
  depuis 633 commits (premier mauvais : 8fb3a105).
- `minPrivilegeFor` sur l'adaptateur — ajouté. Un constructeur partagé
  porte des commandes de DEUX portées ; un privilège unique de famille les
  mettait toutes au niveau 15, donc `show dot1x`, `show lacp` et
  `show pagp` étaient refusées avant `enable` alors qu'un Catalyst y répond.
- `SwitchTries` — le paquet des arbres du commutateur était réécrit à
  l'identique en sept endroits ; il porte désormais `user`, sans quoi les
  vues `show udld` / `show monitor` n'atteignaient jamais le socle.
- Les événements d'observabilité Kerberos et de réplication AD se lisaient
  sur le bus GLOBAL alors que le bus d'une machine est le sien depuis
  5ff22d9b — la sonde lisait le mauvais bus, la fonction était juste.

- Les ports ouverts d'un routeur n'ont pas de vue — ouvert, et la mesure
  a corrige DEUX affirmations de l'entree precedente. (1) La commande a
  ecrire n'est PAS `show ip sockets` : elle n'existe plus a partir
  d'IOS 12.4(x)T, donc sur tout le train 15.x, et cette image se declare
  `Version 15.7(3)M5` — l'ecrire apprendrait une commande que la vraie
  machine refuse. Son remplacante est
  `show control-plane host open-ports`, qui liste en plus les sockets
  TCP la ou `show ip sockets` ne montrait que l'UDP. (2) « Une SECONDE
  table de ports » etait trop simple : `SocketTable` (la vue observable
  d'un hote — etat TCP, TIME_WAIT, pid, banniere, ce que lisent `ss` et
  `netstat`) et `UdpPortTable` (le demultiplexeur port -> gestionnaire)
  repondent a deux questions differentes, et `ownerOf` lit deja les
  revendications de protocole a travers. Ce qui manque vraiment est la
  VUE : les ecouteurs TCP du routeur vivent dans `TcpStack.listeners`,
  ses liaisons UDP dans `ControlPlaneUdpEndpoint`, et aucune question
  unique ne les rassemble — `attachSocketSink`, le port par lequel
  `TcpStack` alimente une vue, n'est branche que par `EndHost`.
  La mesure des largeurs reste BLOQUEE, et la verification est allee
  jusqu'a la source cette fois : cisco.com et les blogs qui citent la
  sortie sont coupes par le proxy de sortie, et l'index des modeles
  `ntc-templates` (atteignable, lui) ne porte AUCUN gabarit pour
  `show ip sockets`, `show tcp brief` ni `show control-plane host
  open-ports` — il n'existe donc pas de capture texte a lire, et les
  blancs sont precisement l'information cherchee.

- `NhrpEngine` retombait sur la DIFFUSION, sans garde — FERME. Il passe
  par `sendIpv4Packet`, qui route et resout. Contrairement aux retombees
  de la phase 8, celle-ci etait ATTEIGNABLE : la sonde montre le tiers du
  segment recevant l'enregistrement DMVPN avant correctif.

- Trois emetteurs restent hors de l'offre, et deux d'entre eux ne sont
  PAS des defauts — mesure faite apres la phase 8 plutot qu'affirmee.
  `ipsla/probes/IcmpEchoProbe.ts` batit sa trame mais son appelant a deja
  RESOLU l'adresse de destination : c'est une descente a faire, pas une
  fuite. La branche multicast de `RIPEngine` emet sur une interface
  nommee avec l'adresse derivee par `linkDestinationFor`, ce qui est
  exactement le regime prevu ; la faire passer par `sendIpv4Packet` ne
  serait qu'une uniformisation. `TcpStack` porte son propre chemin IPv4
  (§5.3 du BRD le prevoit : TCP DEMENAGE dans la couche transport), et
  c'est le dernier acheminement IPv4 distinct du depot — mais sa retombee
  en diffusion est RETIREE et `resolveMac` supprime du depot avec elle,
  la mesure ayant etabli qu'elle n'etait atteignable par aucun hote.
  Faux positifs verifies au passage : `DhcpServerChannel.sendFrame` est
  un `(iface, pkt: DHCPPacket) => void` et non l'envoi de couche lien, et
  le `sendFrame` de `FhrpAgentBase` est un ARP gratuit, donc L2 par
  nature.

- `EndHost.sendUdpDatagram` est POSITIONNEL alors que l'offre prend une
  requete — FERME. Il accepte les deux ECRITURES sur une SEULE
  implantation (`emitUdpDatagram`), donc les 83 appels positionnels
  restent valides et un agent heberge par un hote appelle l'offre comme
  sur un routeur.

- IGMP ne peut pas descendre par l'offre de la couche internet — FERME.
  `IPv4HeaderOptions.headerBytes` exprime l'en-tete a options, `ihl` et
  `totalLength` en derivent, et les trois emetteurs partagent
  `igmpSendRequest`. Le DF etait FAUX au passage (`flags: 0` alors que le
  noyau Linux pose `IP_DF` sur les deux chemins d'`net/ipv4/igmp.c`) et
  est corrige.

- Un tunnel GRE et un tunnel VXLAN DIFFUSENT leur paquet exterieur —
  FERME. `GreAgent` et `VxlanAgent` batissent le paquet exterieur puis
  l'emettent avec `destinationMac: MACAddress.broadcast()`, alors que ce
  paquet est un unicast IPv4 ordinaire : une vraie machine le route et le
  resout par ARP, vers UNE adresse MAC. Diffuser signifie que toutes les
  stations du segment recoivent la charge encapsulee — un tunnel qui fuit
  son contenu a tout le LAN. `NhrpEngine` fait mieux sans etre juste : il
  lit un cache et retombe sur la diffusion quand il est froid, au lieu de
  mettre en file et de resoudre. Le correctif est l'offre de la couche
  internet que le BRD §3.3 decrit (`send({ dst, protocol, ... })`) et que
  `Router.sendIpv4FrameArpAware` sait deja realiser ; il n'est pas fait
  ici : `layers/internet/Ipv4Egress.ts` pose l'offre, `Router` et
  `EndHost` la realisent, et les deux tunnels routent desormais leur
  paquet exterieur. `probe-tunnel-ne-diffuse-pas.test.ts` observe la fuite
  la ou elle se voit — sur une machine tierce du meme segment.

- `show tcp brief` rend ses lignes — fermée pour cette moitié.
  `showTcpBrief()` ne prenait AUCUN argument : une constante, donc sans
  aucun moyen d'atteindre l'équipement. Elle lit désormais la pile TCP par
  un accesseur optionnel (un commutateur n'en a pas et garde son en-tête
  seul), et rend les écouteurs comme les sessions établies.
  **Aucune largeur n'est inventée** : l'en-tête est celui qui existait déjà,
  inchangé, et les colonnes s'y alignent. La forme `adresse.port` et le
  `*.*` d'un écouteur sont attestés par les exemples de la documentation
  Cisco, dont seuls les BLANCS sont perdus au passage par le HTML.
  `show sockets` reste OUVERT et n'est pas touché : son en-tête est INVENTÉ
  (`Proto Local Address Foreign Address State` au lieu de
  `Proto Remote Port Local Port In Out Stat TTY OutputIF`), donc y ajouter
  des lignes reviendrait à bâtir sur une invention. Ancien texte de
  l'entrée, conservé pour ce qui reste : `showTcpBrief()` et `showSockets()`
  (`cisco/CiscoCommonShow.ts`) rendent une CONSTANTE : une ligne
  d'en-tete, rien d'autre, sur une machine qui porte pour de bon des
  ecouteurs TCP sur 22 et 23 et de vraies sessions etablies que
  `TcpStack.listListeners()` et `listSockets()` savent enumerer. Une vue
  qui annonce « voici les connexions » et n'en montre aucune est pire
  qu'une commande absente. L'en-tete de `show sockets` est de surcroit
  INVENTE (`Proto Local Address Foreign Address State`), la vraie
  commande ecrivant `Proto Remote Port Local Port In Out Stat TTY
  OutputIF`. Meme blocage que ci-dessus : les largeurs ne sont pas
  mesurables depuis ce reseau, et les ecrire au juge est exactement ce
  que `ciscoTableLayouts.ts` existe pour empecher.

- `sntp server` avait DEUX corps — fermée. Le même mot enregistré sur
  l'arbre privilégié et sur celui de configuration, avec des corps qui
  avaient déjà divergé : celui de configuration retient la ligne par
  `_recordUnhandledConfigLine` quand la machine n'a pas d'agent NTP,
  l'autre la perd en silence. Sans conséquence observable aujourd'hui —
  routeur comme Catalyst portent un agent, donc la branche divergente est
  inatteignable — mais c'est exactement la duplication qui finit par
  répondre deux choses à une même commande. Un seul corps, posé sur les
  deux arbres.

- FortiGate — cinq manquements signalés par l'utilisateur, tous fermés :
  `set hostname` s'appliquait AVANT le `end` et `abort` reposait le nom
  d'usine ; la console gardait son curseur de configuration d'une session
  à l'autre ; plusieurs terminaux pouvaient s'ouvrir sur un port console
  qui est unique ; `show system interface` ne suivait pas l'ordre du
  châssis ; l'auto-complétion était sensible à la casse.
- Le VDOM `root` existe et `show vdom` le montre — fermée, et la premisse
  de l'entrée précédente était FAUSSE : la vraie commande de FortiOS est
  `config vdom`, pas `config system vdom`, et elle était déjà modélisée.
  Le défaut réel était ailleurs : `predefined` ne nourrissait que l'aide et
  la complétion, jamais l'arbre de configuration, si bien que `show vdom`
  rendait un bloc VIDE sur une machine dont `get system status` annonce
  `Current virtual domain: root`. `seedFactoryVdoms()` peuple la table
  depuis le registre de l'équipement, au démarrage ET au retour d'usine.
  Reste vrai et non corrigé : `show system vdom` résout `vdom` par
  abréviation vers `vdom-link`. C'est l'abréviation de FortiOS appliquée à
  notre vocabulaire — un vrai boîtier a plusieurs `system vdom-*` et
  répondrait « ambigu » ; inventer ces tables pour provoquer l'ambiguïté
  serait le défaut inverse.
- `diagnose hardware sysinfo memory` rend `/proc/meminfo` — fermée. Le
  modèle mémoire EXISTAIT (`SystemLoad.memory()`, qui nourrit déjà
  `get system performance status` et le conserve-mode) ; il lui manquait
  cette porte. Les valeurs sont donc mesurées, et une sonde les compare
  entre les deux vues plutôt que de leur faire confiance.
  `Active`/`Inactive` sont délibérément OMISES : rien ici ne distingue une
  page active d'une page inactive, et les rendre serait une illustration.
  C'est la convention que ce dépôt suit déjà (`show ip ssh` tait ses
  suites cryptographiques, `show ip http server status` son condensé).
- Une politique de pare-feu INCOMPLETE est refusee au `next` — fermée.
  L'ensemble exigé est `srcintf`, `dstintf`, une source (`srcaddr` OU
  `srcaddr6`), une destination (`dstaddr` OU `dstaddr6`) et `service` ;
  `schedule` n'en est PAS, il vaut `always` par défaut au schéma. Le refus
  nomme l'attribut manquant, sous un `NOTE:` — le message exact de Fortinet
  n'est pas attestable depuis ce réseau, et c'est la convention que ce dépôt
  suit déjà pour nginx/apache.
  Le contrôle a EXPOSÉ un défaut préexistant : `set dstintf` refusait une
  ZONE SD-WAN (`INTERFACE_TARGETS` ne connaissait que `system interface` et
  `system zone`), donc la politique était commitée avec un `dstintf` vide,
  c'est-à-dire incapable de correspondre à quoi que ce soit.
- `execute reboot|shutdown|factoryreset` agissent par les DEUX voies —
  fermée. La voie scriptée était incohérente avec elle-même :
  `factoryreset` réinitialisait sans rien annoncer, `reboot` et `shutdown`
  ne faisaient rien du tout. Elles annoncent désormais et agissent, la
  confirmation ne pouvant être posée que sur un canal interactif ;
  `annonceAlimentation()` est l'unique texte, lu par le plan d'interaction
  ET par la voie scriptée.
  Trouvé avec : `applyFactoryIdentity` reposait `name` sans `hostname`,
  donc un retour d'usine laissait l'invite sur le nom configuré —
  `Firewall.applyDeviceName()` pose l'identité en un seul endroit, lu par
  le commit de `system global` et par le retour d'usine.
- Famille `service` — les drapeaux se rendent des DEUX cotes, fermée.
  `service password-encryption` était stockée sur `Equipment` (magasin déjà
  partagé) mais rendue par le seul parcours du routeur, donc perdue au
  rechargement d'une topologie sur un Catalyst ; `service dhcp` n'était pas
  déclarée du tout sur le commutateur, donc absente de l'aide et sans effet.
- `sntp broadcast client` est ACCEPTE, RENDU, et n'est evalue par
  personne. `NtpAgent` n'a aucune notion de mode diffusion (mode 5) : pas
  une occurrence de `broadcast` dans tout le module, donc rien ne peut
  recevoir une annonce. Il est stocke plutot que refuse parce que le
  refuser ferait disparaitre a l'import d'une topologie une ligne qu'une
  vraie machine accepte — meme raisonnement que `ip ssh server algorithm`
  et `snmp-agent mib-view`. Fermer demande un emetteur d'annonces cote
  serveur et une reception cote client, c'est-a-dire un mode de plus dans
  le moteur, pas une porte.
- `sntp source-interface <nom>` est REFUSEE alors que la Basic System
  Management Command Reference la decrit. Le moteur, lui, sait le faire :
  `NtpAgent.setSourceInterface` existe et `ntp source` l'ecrit. Ce qui
  manque est l'ORTHOGRAPHE : le champ est unique et la configuration est
  rendue `ntp source <nom>`, donc l'accepter telle quelle rendrait a
  l'operateur une commande qu'il n'a pas tapee, et un import la rejouerait
  sous l'autre nom. Fermer demande un drapeau d'orthographe, comme
  `loggingSpelling` vient d'en poser un pour `logging`.
- `sntp unicast [client]` est acceptee et rangee nulle part. Elle a ete
  GARDEE plutot que retiree : les pages Cisco atteignables decrivent bien
  un client SNTP unicast, mais elles portent sur les commutateurs
  « small business » (SG300/SG550), dont la CLI n'est pas IOS, et la
  Basic System Management Command Reference — la reference d'IOS — n'est
  pas atteignable depuis ce reseau. Retirer une commande sur une premisse
  invérifiée serait pire que la garder ; ce qu'il faut est une capture
  d'IOS, pas un raisonnement.
- `show sntp` rend TOUTES les associations, y compris celles declarees
  par `ntp server`. Elles partagent le meme magasin, et l'association
  porte deja `configuredAs`, donc le filtre est a portee — mais ce que
  fait une vraie machine ne l'est pas : IOS n'embarque JAMAIS les deux
  piles a la fois (l'image porte l'une ou l'autre), donc aucune capture
  reelle ne peut trancher ce que `show sntp` montre d'une association
  NTP. Trancher au hasard serait inventer.
- L'INVITE aux niveaux de privilege 2 a 14 n'est attestee par aucune
  capture atteignable depuis ce reseau. Ce depot rend `#` —
  `buildDevicePrompt` mappe explicitement « mode utilisateur au niveau
  >= 2 » sur l'invite privilegiee — pendant qu'un commentaire du
  gestionnaire d'`enable` affirmait le contraire (« real IOS never shows
  '#' below 15 ») ; le commentaire est supprime, la decision du code est
  gardee, et la question reste ouverte. Les pages qui la trancheraient
  (cisco.com, study-ccna, networklessons, flylib, tacacs.com) sont
  toutes bloquees par le mandataire de sortie. Ce qu'il faut est une
  capture de `Router>enable 7`, pas un raisonnement.
- `enable <niveau>` depuis l'EXEC PRIVILEGIE traverse desormais la meme
  porte de secret que depuis l'EXEC utilisateur, parce qu'il n'y a plus
  qu'une declaration. Ce qu'un vrai IOS demande quand on DESCEND d'un
  niveau (15 vers 7) n'est pas atteste : il est possible qu'il ne
  demande rien, une descente n'etant pas une elevation. Le comportement
  uniforme a ete prefere a deux comportements selon l'endroit d'ou l'on
  tape, faute de reference.
- La LARGEUR des colonnes du tableau `Interface / Trusted / Allow option
  / Rate limit (pps)` de `show ip dhcp snooping` est CALCULEE et non
  mesuree. Les intitules sont attestes par la documentation Cisco, la
  mise en page ne l'est pas : aucune transcription de cette vue n'est
  atteignable depuis ce reseau — `ntc-templates` ne porte un gabarit que
  pour `show ip dhcp snooping binding`, dont les largeurs SONT donc
  fixees, et les pages de Cisco, 9tut et firewall.cx sont toutes
  bloquees par le mandataire. `TextTable` calcule donc la largeur sur le
  contenu, ce que son propre en-tete reserve aux tableaux « dont la
  reference ne fixe rien » ; l'en-tete, le filet et les donnees sortent
  d'une seule declaration, donc ils ne peuvent pas se contredire, mais
  la colonne n'a pas la largeur d'un vrai Catalyst. Fermer demande une
  capture.
- La colonne `Allow option` est DEDUITE de la confiance du port (un port
  de confiance accepte l'option 82, un autre non), ce qui reproduit la
  regle par defaut que la documentation enonce — `Option 82 on untrusted
  port is not allowed` — mais la commande qui la RENVERSE,
  `ip dhcp snooping information option allow-untrusted`, n'existe pas
  dans ce depot et n'a donc aucun magasin. Tant qu'elle n'existe pas, la
  colonne ne peut pas varier autrement. La ligne `Option 82 on untrusted
  port is not allowed` n'est deliberement PAS rendue : l'ecrire en dur
  annoncerait un reglage que rien ne porte.
- `show ip dhcp snooping statistics` reste declaree sur le trie du
  COMMUTATEUR seul, la ou le reste de la famille est passe au socle. Ses
  dix compteurs sont des champs de `Switch` (`dhcpSnoopingDropped*`) que
  `Router` n'a pas, donc la descendre demande soit de porter ces
  compteurs dans `DHCPSnoopingConfig` — le magasin partage —, soit un
  crochet de plus. Le premier est le bon, et c'est un lot a soi : ces
  compteurs sont incrementes par le plan de donnees du commutateur.
- `ip dhcp snooping` est desormais accepte sur les DEUX plateformes
  depuis une seule declaration, et le routeur n'a plus de magasin a lui
   — mais il n'a toujours aucun plan de donnees qui espionne. Ce que le
  chassis modelise (`c2900`) fait d'un `ip dhcp snooping` reel n'est pas
  attestable depuis ce reseau : une synthese de recherche affirme qu'un
  ISR G2 ne connait pas la commande, aucune capture ne le montre, et un
  ISR portant un module EtherSwitch la connait. Amputer le routeur sur
  une synthese serait deviner ; il rend donc la meme vue que le
  commutateur, avec un tableau vide et zero liaison, ce qui est au moins
  vrai.
- La tete GLOUTONNE de `spanning-tree` (configuration globale du
  commutateur) reste au trie. Deux chemins bornes en sont partis —
  `spanning-tree mode`, qui n'accepte que trois valeurs, et
  `spanning-tree mst configuration`, qui n'en prend aucune — mais le
  reste (`vlan <liste> {priority|hello-time|max-age|forward-time|root}`,
  `portfast [bpduguard|bpdufilter] default`, `loopguard default`,
  `pathcost method {long|short}`, `uplinkfast`, `backbonefast`,
  `priority <n>`) n'a pas UNE grammaire mais huit. Mesure : le declarer
  en une place libre fait refuser `spanning-tree vlan 10`, une frappe que
  la machine accepte, parce que la continuation `vlan` devient alors un
  noeud sans commande. Fermer demande de declarer les huit formes
  separement, chacune avec ses places — c'est un lot a soi, pas la queue
  de celui-ci.
- `show ip route summary` reste PROPRE a chaque plateforme : le routeur
  a `showIpRouteSummary` dans `CiscoOspfCommands`, le commutateur le sien
  dans `CiscoSwitchShell`, et les deux comptent differemment (le premier
  connait OSPF, EIGRP et BGP, le second seulement `connected` et
  `static`). Les fondre demande de decider ce qu'un Catalyst compte
  quand il ne fait tourner aucun protocole dynamique, ce qu'aucune
  capture atteignable ne montre ; les deux ont donc ete laisses tels
  quels alors que le reste de la famille est passe a un rendu unique.
- `show ip route vrf` et `show ip route ospf` restent servis par le
  crochet du ROUTEUR seul, et c'est voulu : un Catalyst de ce depot
  n'a ni VRF ni processus OSPF. La forme `ospf` y est neanmoins
  ACCEPTEE et rend une table filtree vide, par la table de codes
  partagee — ce qui est ce que fait une vraie machine sans route OSPF.
- `show ip eigrp neighbors <iface>` et `show ip eigrp topology <prefixe>`
  ne declarent AUCUNE place, si bien que `?` repond `% Invalid input` a
  un argument que les deux commandes EXECUTENT sans broncher :
  `show ip eigrp neighbors ?` n'offre que `detail` et `<cr>`, et
  `show ip eigrp neighbors GigabitEthernet0/0` rend pourtant sa vue.
  C'est le defaut INVERSE de celui que le lot « une suite declaree AVANT
  une place se tape aussi APRES » vient de fermer : la une suite
  manquait derriere une place, ici c'est la place qui manque. Fermer
  demande de MESURER ce que chacune accepte vraiment — un nom
  d'interface, un prefixe, les deux — plutot que de declarer une place
  au juge.

- `probe-aide-tient-ses-promesses.test.ts` EPUISE LE TAS et meurt sans
  rendre de verdict (`Mark-Compact … allocation failure`, puis
  « Worker exited unexpectedly » ; 1 a 2 cas sur 20 aboutissent). Ce
  n'est pas une regression du lot FHRP : le meme fichier, la meme
  commande, avec `--max-old-space-size=6144`, meurt IDENTIQUEMENT sur
  l'etat d'AVANT le lot, mesure par `git stash` — c'est donc un cout
  du garde-fou lui-meme et non de ce qu'il garde. La cause probable est
  son economie : il fabrique un `CiscoRouter` NEUF par chemin essaye, et
  il y en a 484 a la seule profondeur 3 du mode interface (mesure, contre
  483 avant le lot : la migration en ajoute UN, `standby version`), donc
  environ sept cents equipements par cas et quatre cas par fichier ;
  `EquipmentRegistry` les retient tous jusqu'au `beforeEach` suivant.
  Fermer demande de decider si le balayage peut REUTILISER une machine —
  ce que son en-tete refuse explicitement, une commande essayee pouvant
  modifier la configuration — ou s'il faut liberer l'equipement apres
  chaque essai, ce qui suppose une extinction propre qui n'existe pas
  encore. Les deux sont un lot a soi.
- Une adresse SECONDAIRE sur une SVI de Catalyst est REFUSEE
  (`% Secondary addresses are not supported on this platform.`) alors
  qu'un vrai IOS l'accepte. Mesure : `SwitchSvi` range UNE adresse et un
  masque par VLAN (`configure(vlan, ip, mask)`), et `isOwnAddress`, la
  resolution ARP et l'acheminement lisent cette adresse-la ; il n'y a
  donc nulle part ou poser la seconde. C'est un choix ASSUME et non un
  oubli : avant ce lot la commande etait acceptee et ECRASAIT la
  primaire — un refus est moins faux qu'une perte silencieuse. Fermer
  demande une liste d'adresses secondaires sur la SVI et les trois
  lecteurs du plan de donnees qui vont avec, ce qui est un lot a soi.
- L'IDENTIFIANT d'une spec derivee du trie est bati en JOIGNANT les
  elements du chemin, places d'argument comprises, si bien qu'une place
  s'y ecrit `[object Object]` : le routeur porte
  `config-if-ip-rip-receive-version-[object Object]-1`,
  `…-[object Object]-2`, `config-if-ip-rip-authentication-[object Object]-mode`
  et d'autres (`trieAdapter.ts`, `id: [modesIci[0], ...words].join('-')`).
  Un identifiant est cense NOMMER une commande ; celui-ci nomme sa place
  par le mot que JavaScript ecrit quand on convertit un objet en chaine,
  donc deux commandes qui ne different que par le TYPE de leur place
  portent le meme nom. La consequence est aujourd'hui bornee —
  `CommandTable.specById` est le seul lecteur et le controle de doublon
  porte sur le CHEMIN, pas sur l'identifiant — ce qui est exactement
  pourquoi ce n'est pas corrige a la va-vite : rendre l'identifiant exact
  demande de decider comment une place s'ecrit dedans (`<nom>`, son type,
  son rang) et de verifier qu'aucun identifiant ecrit a la main n'entre
  alors en collision avec un identifiant derive.
- `storm-control`, `srr-queue` et `switchport voice` restent servis par
  la boucle GENERIQUE de `CiscoSwitchShell`, qui les enregistre en
  glouton, retient le texte tape sans l'analyser et le rend tel quel dans
  la configuration — donc `storm-control zorglub` est accepte, rendu, et
  rejoue a l'import. Les trois voisines de la meme boucle
  (`channel-protocol`, `mdix`, `power`) en sont sorties parce que leur
  grammaire tient en deux ou trois mots-cles et qu'une source atteignable
  les atteste. Celles-ci ne sont pas fermees pour une raison precise :
  leur grammaire est nettement plus riche (seuils en pourcentage ou en
  paquets par seconde, actions `shutdown`/`trap`, files et poids de
  `srr-queue`), `docs.cisco.com` est bloque par le mandataire de sortie,
  et aucune source atteignable ne la donne en entier. Les declarer au
  juge REFUSERAIT des formes que la vraie machine accepte, ce qui serait
  un defaut plus couteux que la permissivite actuelle. A rouvrir quand la
  documentation est atteignable, ou contre une transcription reelle.
- Une `Loopback0` de Cisco n'est PAS un port de BOUCLAGE au sens de
  `Port` : seul `LinuxMachine.createLoopbackPort` passe
  `{ loopback: true }`, si bien que `Port.mtuMax()` rend 9216 pour elle
  et que `mtu 65536` y est refuse « Maximum is 9216 (jumbo frame) ».
  C'est exactement le defaut que le PRD de la boucle decrit et corrige
  pour `lo` — « poser 65536 echouait sur un plafond emprunte a un autre
  medium » — et qui reste ouvert du cote Cisco. Mesure en declarant la
  place de `mtu`, et NON corrige ici parce que le drapeau `loopback`
  entraine aussi `carrierless`, donc l'etat rapporte (`UNKNOWN` au lieu
  d'`UP`/`DOWN`) et le comportement des vues d'interface : le poser sur
  les boucles de Cisco est un lot a soi, avec sa propre mesure de ce
  qu'IOS affiche pour une `Loopback`.
- `password-policy min-length|expire|alert-before-expire` de VRP porte la
  MEME forme de defaut que `security passwords min-length` d'IOS que ce
  lot vient de fermer : `const n = parseInt(args[1], 10); if (!isNaN(n))
  policy.X = n;` dans `HuaweiVRPShell` (trois reglages, un seul patron),
  donc une valeur non numerique est acceptee en SILENCE et ne pose rien —
  l'operateur croit avoir arme une politique de mots de passe qui n'existe
  pas. Ce n'est PAS ferme ici pour deux raisons mesurees : les bornes de
  VRP ne sont pas attestees depuis ce reseau (la documentation Huawei
  n'est pas atteignable, et les inventer refuserait des valeurs que la
  vraie machine accepte), et les coquilles VRP n'ont pas encore de pont
  vers le socle, donc la place ne peut pas y etre declaree comme elle
  vient de l'etre cote Cisco. A rouvrir avec le pont VRP, ou contre une
  transcription reelle qui donne les bornes.
- `%LOGONSERVER%` vaut `\\<nom de machine>` meme quand la machine est
  MEMBRE d'un domaine, alors qu'un vrai Windows y met le nom NetBIOS du
  contrôleur qui a valide l'ouverture de session. Mesure faite en
  ecrivant la table d'environnement unique de `WindowsPC.wellKnownEnv` :
  `DomainMembership` ne porte que `dcAddress`, documente comme « Hostname
  or IP » — donc la valeur serait `\\192.168.1.10` la ou la vraie machine
  ecrit `\\DC01`. La reponse est JUSTE dans les deux autres cas (compte
  local, et controleur de domaine, ou le serveur d'ouverture de session
  EST la machine), et l'inventer pour le troisieme afficherait une
  adresse la ou on attend un nom. A rouvrir quand `DomainMembership`
  portera le nom du contrôleur (`discoverDcHostname` le calcule deja dans
  `DomainJoinClient` et le jette).
- `Install-ADDSForest` ne REDEMARRE pas la machine, alors que la
  documentation officielle du cmdlet ecrit, sous `-NoRebootOnCompletion`,
  qu'« omitting this parameter indicates the computer is rebooted upon
  completion of the command, regardless of success or failure ». Le
  parametre n'est donc ni declare ni evalue, plutot que declare et
  inerte. Non ferme parce que le redemarrage est le comportement par
  DEFAUT : le poser ferait redemarrer la machine dans la vingtaine de
  laboratoires du depot qui promeuvent un contrôleur puis continuent a
  taper des commandes dessus, et ce que `RebootRequired` doit alors
  rendre n'est atteste par aucune transcription atteignable depuis ce
  reseau. A rouvrir avec un modele de redemarrage et une capture reelle
  de la sortie du cmdlet.
- Les parametres `-SkipPreChecks`, `-CreateDnsDelegation`,
  `-DnsDelegationCredential`, `-NoDnsOnNetwork`, `-SkipAutoConfigureDns`
  et `-Confirm` d'`Install-ADDSForest` ne sont pas declares : chacun
  gouverne un mecanisme que ce simulateur n'a pas (verifications
  prealables de DCPromo, delegation DNS dans la zone parente, decouverte
  DNS sur le reseau, invite de confirmation). Les declarer les rangerait
  sans que rien ne les evalue, ce que la convention du depot interdit.
  `-SysvolPath` est declare et accepte mais SYSVOL est toujours pose sous
  `C:\Windows\SYSVOL`, `provisionSysvol` ne prenant pas de chemin.
- `Install-ADDSForest` REFUSE quand `-SafeModeAdministratorPassword`
  manque, alors que la vraie commande INVITE l'operateur a la saisir (son
  bloc de parametre dit `Required: False` avec `Default value:
  <mandatory>`, et l'exemple 1 de la documentation l'omet en precisant
  « causes the user to be prompted »). Ce n'est pas ferme ici parce que
  le chemin de saisie interactive de ce cmdlet n'existe pas et qu'une
  vingtaine de laboratoires passent deja le mot de passe.

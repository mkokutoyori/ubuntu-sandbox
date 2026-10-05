# UDP — état de conformité aux RFC (docs/rfc/udp)

Bilan mesuré, RFC par RFC puis exigence par exigence, de la couche UDP du simulateur :
`src/network/layers/transport/` (`UdpInput`, `UdpEgress`, `UdpChecksum`, `UdpPortTable`,
`EphemeralPorts`, `UdpLiteInput`, `UdpLiteEgress`), les prises de `EndHost`, la branche UDP de
`Router` et `UdpLiteEndpoint`. Une seule règle de somme et une seule règle de validation à l'arrivée
servent DHCP, DHCPv6, RIP, NTP, syslog, BFD, mDNS, LLMNR, la SVI d'un commutateur et toute application
qui passe par les prises de `EndHost` (`nc -u` compris). Chaque correctif porte une sonde discriminée avec
`git stash` : l'en-tête de la sonde donne combien de cas tombaient avant et nomme les témoins. Les
sondes sont des fichiers de `src/__tests__/unit/network-v2/` ; la dernière colonne des tableaux donne
leur nom sans l'extension `.test.ts`.

Textes lus : ceux de `docs/rfc/udp/` (RFC 768, 1122, 2761, 3828, 5405, 6935, 6936, 8085, 8086) et, dans
`docs/rfc/icmp/`, la RFC 8200 et la RFC 4443 (IPv6, ICMPv6). Linux : le noyau 5.15 d'Ubuntu 22.04, lu dans
le source (`raw.githubusercontent.com`). Windows : la documentation de Microsoft (`learn.microsoft.com`).

## Synthèse par RFC

| RFC | Objet | État | Sondes |
|---|---|---|---|
| 768 | UDP | Fait : le champ longueur est lu (un datagramme dont `length` est inférieur à 8 ou supérieur à ce qui est arrivé est jeté, une charge plus longue que `length` est rognée avant la somme), la somme calculée à zéro part en `0xFFFF`, une somme nulle reçue en IPv4 veut dire « non calculée », le port source 0 est valide (« si inutilisé, zéro ») | `probe-udp-datagram-rules`, `probe-somme-udp-rfc768-rfc8200`, `udp-checksum` |
| 1122 §4.1 | UDP dans les hôtes | Voir la section suivante | |
| 2761 | Terminologie du banc d'essai ATM | Sans objet : le texte ne contient pas le mot UDP, il n'a rien à faire dans ce dossier | |
| 3828 | UDP-Lite | Fait : protocole IP 136, couverture de somme 0 ou 8 et plus (1 à 7 ou au-delà de la longueur IP, jeté), somme sur pseudo-en-tête avec zéro transmis `0xFFFF`, ports à part, couverture minimale par prise, « port unreachable », compteurs `UdpLite`, `/proc/net/udplite`, capture. Les machines Linux l'activent ; Windows n'implante pas UDP-Lite et répond « protocol unreachable ». Non fait : dissection `tcpdump` (la ligne reste `ip-proto-136`), `netstat -U`, NAT d'un datagramme UDP-Lite, jumbogrammes IPv6 | `probe-udplite-rfc3828` |
| 5405 | Usage d'UDP en unicast | Remplacée par la RFC 8085 | |
| 6935, 6936 | Somme UDP nulle en IPv6 pour les tunnels | Le récepteur applique la règle par défaut de la RFC 8200 §8.1 : une somme nulle sur IPv6 est jetée. Aucun tunnel du simulateur ne roule sur UDP en IPv6 (VXLAN est IPv4 seulement et pose une somme nulle) : l'exception n'a pas d'utilisateur | `probe-somme-udp-ipv6-rfc8200`, `probe-somme-udp-rfc768-rfc8200` |
| 8085 | Recommandations d'usage d'UDP (BCP) | Écrite pour les applications. Ce qui vise la pile est tenu : taille et fragmentation (§3.2), ICMP (§3.3), somme (§3.4), port source (aléatoire dans la plage éphémère, partagée avec TCP). Le contrôle de congestion et les intervalles de retransmission (§3.1) relèvent de chaque protocole applicatif et ne sont pas audités ici | `probe-udp-datagram-rules`, `probe-udp-connect-over-ipv6`, `udp-transport-endhost` |
| 8086 | GUE, encapsulation générique dans UDP | Non construit : aucune encapsulation GUE n'existe (ni sur Linux ni sur les routeurs) ; il faudrait l'en-tête GUE, les variantes 0 et 1, et un plan de données de tunnel que seul GRE de Linux porte dans l'agent | |

## RFC 1122 §4.1.5 : exigence par exigence

| Exigence | Niveau | État | Preuve |
|---|---|---|---|
| UDP envoie « port unreachable » vers un port sans écouteur (§4.1.3.1) | SHOULD | Fait, IPv4 et IPv6, sur les postes, les routeurs et la SVI d'un commutateur ; jamais pour une diffusion ou un groupe (RFC 1122 §3.2.2) | `udp-transport-endhost`, `tcp-ip-phase4-udp-demux`, `ipv6-udp-transport`, `probe-routeur-udp-ipv6` |
| Les options IP reçues sont remises à l'application, l'application en pose à l'émission, UDP les passe à IP (§4.1.3.2) | MUST (3 lignes) | Fait : `UdpDelivery.ipOptions` à la réception, `UdpEmissionOptions.ipOptions` puis `UdpSendRequest.ipOptions` à l'émission | `probe-udp-datagram-rules` |
| Les erreurs ICMP sont remises à l'application (§4.1.3.3) | MUST | Fait pour les prises connectées en IPv4 et en IPv6 (`ECONNREFUSED`, `EHOSTUNREACH`, `EMSGSIZE`… selon `udp_err` et `icmpv6_err_convert`) ; pour une prise non connectée l'erreur est publiée sur le bus (`host.icmp.unreachable`, lu par `traceroute`, `tracepath`, `nmap`) mais aucune API `IP_RECVERR` ne la rend à l'application, comme Linux quand l'option n'est pas posée | `probe-udp-connect-over-ipv6`, `probe-icmpv6-errors-reach-the-transport`, `udp-reject-vs-drop-observability` |
| Somme : générer et vérifier (§4.1.3.4) | MUST | Fait, IPv4 et IPv6 ; une règle unique, `stampUdpChecksum` à l'émission et `acceptUdpDatagram` à l'arrivée, servent tous les émetteurs (DHCP, RIP, NTP, syslog, BFD, SVI, DHCPv6, mDNS) | `probe-udp-datagram-rules`, `probe-somme-udp-ipv6-rfc8200`, `udp-checksum` |
| Somme fausse jetée en silence | MUST | Fait ; le compteur `InCsumErrors` de `/proc/net/snmp` le compte | `tcp-ip-couche-transport-udp`, `probe-udplite-rfc3828` |
| Somme calculée par défaut | MUST | Fait : `buildUdpOverIpv4` pose la somme, la base posait zéro | `probe-udp-datagram-rules` |
| L'émetteur peut ne pas générer de somme | MAY | Fait pour qui compose un datagramme faux (`badChecksum`, `nmap --badsum`) ; pas d'option `SO_NO_CHECK` pour une application ordinaire | `probe-udp-datagram-rules` |
| Le récepteur peut exiger une somme | MAY | Non retenu : Linux n'a pas cette option pour UDP (seule UDP-Lite a une couverture minimale) | |
| L'adresse de destination précise est remise à l'application (§4.1.3.5) | MUST | Fait : `UdpDelivery.destinationIP` | `udp-transport-endhost`, `ipv6-udp-transport` |
| L'application fixe l'adresse source, ou la laisse au système | MUST | Fait : `UdpConnectOptions.source` (`nc -s`, des deux familles), adresse jokère à l'écoute ; une adresse d'une autre famille rend `EAFNOSUPPORT`, une adresse que la machine ne porte pas `EADDRNOTAVAIL` | `probe-udp-connect-over-ipv6`, `probe-udp-bind-un-seul-contrat` |
| L'application est informée de l'adresse locale choisie | SHOULD | Non retenu : l'adresse choisie ne remonte pas à l'application (`getsockname`) | |
| Un datagramme de source invalide est jeté (§4.1.3.6) | MUST | Fait : source nulle hors diffusion limitée, de diffusion (limitée ou dirigée), de groupe, martienne, de bouclage hors machine, ou notre propre adresse | `probe-udp-datagram-rules` |
| La source émise est une adresse de l'hôte | MUST | Fait | `probe-udp-connect-over-ipv6` |
| TTL, TOS et options IP fixés à l'émission, passés tels quels à IP (§4.1.4) | MUST | Fait : `UdpSendRequest.ttl`, `tos`, `ipOptions` ; `UdpConnectOptions.ttl` et `diffServ` (`nc -u -M`, `-T`) | `probe-udp-datagram-rules`, `probe-nc-socket-options` |
| Le TOS reçu est remis à l'application | MAY | Non retenu | |
| Interface complète d'IP (`GET_SRCADDR`, `GET_MAXSIZES`, `ADVISE_DELIVPROB`, `RECV_ICMP`) | MUST | Partiel : la source (`nc -s`) et les erreurs ICMP des prises connectées sont couvertes (voir plus haut) ; la taille maximale d'un datagramme n'a pas d'appel à elle, seul `EMSGSIZE` au-delà de 65 507 octets la fait connaître | `probe-udp-datagram-rules`, `probe-udp-connect-over-ipv6` |

## Émission et taille (RFC 768, RFC 791 §3.2, RFC 8085 §3.2)

- Un datagramme plus grand que la MTU est fragmenté par IP ; la base le perdait sans erreur parce que DF
  était posé d'office et que la pile se renvoyait à elle-même un « frag needed » (65 508 et 70 000
  octets recevaient la même réponse). `sendUdpDatagram` refuse au-delà de 65 507 octets (65 535 − 20 − 8,
  `EMSGSIZE` sur une prise connectée) et fragmente le reste.
- DF suit la machine, pas le protocole : un datagramme Linux qui tient dans la MTU du chemin porte DF
  (`ip_no_pmtu_disc` à 0, `__ip_make_skb`) et se fragmente sinon ; Windows ne le pose que si la prise
  le demande (`IP_DONTFRAGMENT`).
- La charge IPv6 tient sur 16 bits : 65 527 octets d'UDP au plus, sans jumbogramme.
- Le port source est tiré au hasard dans la plage éphémère de la machine (`ip_local_port_range`), la
  même pour TCP et UDP ; l'attribution est refusée quand elle est épuisée.

## Plateformes

- **Linux** : prises, `ss -lun`, `/proc/net/udp`, `/proc/net/udplite`, `/proc/net/snmp` (les lignes `Udp:`
  et `UdpLite:` lisent les compteurs réels), `nc -u`, UDP-Lite ; le TTL d'un datagramme sans `-M` est
  `net.ipv4.ip_default_ttl` (64 par défaut).
- **Windows** : `netstat` dit d'UDP ce qu'UDP est ; pas d'UDP-Lite ; DF seulement sur demande.
- **Routeurs et commutateurs** : la branche UDP du plan de contrôle (RIP, NTP, syslog, DHCP, BFD,
  SNMP…) passe par la même table de ports (`UdpPortTable`) et la même validation ; un port que le plan
  de contrôle possède déjà est refusé à la liaison au lieu d'être masqué.

## Limites assumées

- Les erreurs ICMP ne remontent pas à une prise UDP non connectée (voir plus haut).
- Pas d'option de somme par prise, pas de `getsockname` pour l'adresse choisie, pas de TOS reçu.
- UDP-Lite : voir la synthèse.
- GUE (RFC 8086) et les sommes nulles en IPv6 de tunnel (RFC 6935, 6936) : aucun tunnel n'en a besoin
  aujourd'hui.
- Le délai de livraison est nul (frames synchrones) : un aller-retour dure 0 ms en temps virtuel, aucun
  seuil de latence ne peut être franchi sans le délai de `tc netem delay` (qui n'agit que sur le calcul
  du RTT d'un ping, pas sur la livraison).

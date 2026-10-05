# TCP — état de conformité aux RFC (docs/rfc/tcp)

Bilan mesuré, RFC par RFC puis exigence par exigence, de la pile unique `src/network/tcp/`
(`TcpStack`). Elle sert tous les hôtes : `EndHost` (Linux, Windows, serveurs), `Router`
(Cisco, Huawei), `Firewall` (FortiGate, ASA) et la pile de gestion des commutateurs ; une
amélioration de la pile profite à SSH, HTTP, SMB, BGP, telnet, DNS sur TCP, RADIUS sur TCP…
Chaque correctif porte une sonde discriminée avec `git stash` : l'en-tête de la sonde donne
combien de cas tombaient avant et nomme les témoins et les non-régressions. Les sondes sont
des fichiers de `src/__tests__/unit/network-v2/` ; la dernière colonne des tableaux donne leur
nom sans l'extension `.test.ts`.

Textes lus : ceux de `docs/rfc/tcp/` (RFC 793, 813, 2018, 5681, 5961, 6298, 6528, 7323, 8311, 9293)
et ceux que ce bilan y ajoute, lus sur `rfc-editor.org` : RFC 2883 (D-SACK), 3168 (ECN), 5927 (ICMP et
TCP), 6093 (urgent), 6582 (NewReno) et 6675 (reprise SACK) dans `docs/rfc/tcp/`, RFC 5082 (GTSM) et
6040 (ECN et tunnels) dans `docs/rfc/ip/` ; les RFC 4443 et 8200 (ICMPv6, IPv6) sont dans `docs/rfc/icmp/`.
Linux : le noyau 5.15 d'Ubuntu 22.04, que `uname -r` annonce, lu dans le source
(`raw.githubusercontent.com`). Quand la RFC et le noyau divergent, la RFC gouverne et l'écart est écrit.

## Synthèse par RFC

| RFC | Objet | État | Sondes |
|---|---|---|---|
| 793 | TCP d'origine | Remplacée par la RFC 9293 ; seul son texte sur le pointeur urgent (§3.7) sert encore, avec la RFC 6093 | `tcp-urgent-data` |
| 813 | Fenêtre et acquittement (SWS, ACK retardé) | Fait, sous la forme normalisée par la RFC 9293 §3.8.6.2 et la RFC 5681 §4.2 : fenêtre annoncée = espace libre qui ne recule jamais, annonce de réouverture par pas d'au moins `min(MSS, fenêtre/2)`, émetteur qui retient un segment inférieur à `min(MSS, Max(SND.WND)/2)` et le force au bout de 500 ms, ACK retardé sous 500 ms et un ACK pour deux segments pleins | `probe-tcp-receive-window`, `tcp-delayed-ack` |
| 2018 | SACK | Option négociée ; récepteur : premier bloc = segment qui a déclenché l'ACK, blocs précédents du plus récent au plus ancien, quatre blocs au plus (trois avec Timestamps), blocs disjoints. Émetteur (§5) : plages acquittées retenues, purgées à mesure que SND.UNA avance, effacées au RTO, un segment acquitté sélectivement n'est pas renvoyé et les trous sous le plus haut segment acquitté le sont (RFC 6675), jamais d'envoi de donnée neuve sur un doublon sans information neuve | `probe-tcp-rfc9293-requirements`, `probe-tcp-sequence-acceptability`, `probe-tcp-congestion-control-rules`, `probe-tcp-loss-recovery`, `tcp-options` |
| 2883 | D-SACK | Non construit : le récepteur ne rapporte pas de segment dupliqué dans un premier bloc, l'émetteur n'en tire pas de détection de retransmission inutile | |
| 3168 | ECN (hors dépôt, lue en ligne) | Fait pour TCP (§6.1) : négociation sur le SYN, ECT(0) sur les données neuves, écho CE, réaction une fois par fenêtre, CWR, `net.ipv4.tcp_ecn` et `tcp_ecn_fallback` ; producteur de CE : `tc netem … ecn` ; tunnels : RFC 6040 pour GRE et IPsec. Limites ci-dessous | `probe-tcp-explicit-congestion-notification`, `probe-tc-netem-ecn-marks-instead-of-drops`, `probe-ecn-through-tunnels` |
| 5681 | Contrôle de congestion | Fait : fenêtre initiale exacte (2, 3 ou 4 SMSS selon la taille), un seul segment après un SYN perdu, ACK dupliqué complet (fenêtre inchangée, SYN et FIN levés, jamais la réponse de fenêtre nulle à une sonde de persistance), envoi limité des deux premiers doublons, retransmission rapide au troisième, redémarrage après inactivité, fenêtre qui suit le MSS réduit par la découverte de MTU de chemin | `tcp-congestion-control`, `probe-tcp-congestion-control-rules`, `probe-tcp-loss-recovery`, `tcp-pmtu` |
| 6582 | NewReno | Fait pour un pair sans SACK : un ACK partiel retransmet le premier segment non acquitté, dégonfle la fenêtre de ce qu'il acquitte et rend un segment, la reprise reste ouverte jusqu'à l'ACK du point de reprise, qui ramène la fenêtre à ssthresh ; après une expiration le point de reprise interdit une nouvelle retransmission rapide jusqu'à son acquittement | `probe-tcp-loss-recovery` |
| 6675 | Reprise sur pertes par SACK | Fait : `IsLost`, `SetPipe`, `NextSeg` (règles 1, 3 et 4), entrée en reprise au troisième doublon ou dès que la tête est déclarée perdue, ssthresh = cwnd = FlightSize / 2 sans gonflement, boucle (C) avant l'envoi des données neuves, sortie sur l'ACK du point de reprise, reprise après expiration (trous rapportés remplis, point de reprise préservé). Choix : la copie de secours de la règle 4 ne renvoie pas un segment déjà retransmis | `probe-tcp-loss-recovery` |
| 5961 | Attaques en aveugle | Fait : RST accepté seulement à `RCV.NXT`, ACK de défi sinon, SYN en état synchronisé, ACK hors de l'intervalle admissible écarté, ACK de défi limités à 10 par 5 s, segment ancien sans effet sur la fenêtre d'émission | `probe-rst-hors-fenetre-est-ignore`, `probe-tcp-rfc5961-challenge-acks`, `probe-rst-emis-porte-le-bon-numero` |
| 6298 | Temporisateur de retransmission | Fait : SRTT et RTTVAR de la première mesure puis des suivantes, plancher d'une seconde, doublement à chaque retransmission, minuterie redémarrée par un ACK qui acquitte du neuf, Karn (`RttEstimator`, RTTM de la RFC 7323 §4.3 le contourne), RTO ramené à 3 s après un SYN retransmis (§5.7) | `probe-tcp-rfc9293-requirements`, `probe-tcp-error-reports-and-retransmission-limits`, `tcp-retransmission` |
| 6528 | Numéro de séquence initial | Fait : horloge de 4 µs (M) + HMAC-SHA256 du quadruplet sous une clé de 128 bits tirée à la création de la pile (F) | `probe-tcp-initial-sequence-numbers` |
| 7323 | Extensions haute performance | Fait : échelle de fenêtre (valeur supérieure à 14 ramenée à 14), Timestamps sur tout segment non-RST, PAWS, RTTM. Non fait : l'abandon d'un segment sans option Timestamps quand les horodatages sont négociés (SHOULD ; Linux l'accepte, FreeBSD l'abandonne, aucune capture ne tranche) | `tcp-options`, `probe-tcp-option-robustness` |
| 8311 | Assouplissements de l'ECN | Pas une autorité ici : il ouvre des expériences (ECT sur SYN, ACK purs, retransmissions) que ni la RFC 3168 ni Linux ne font. La pile suit la RFC 3168 | `probe-tcp-explicit-congestion-notification` |
| 9293 | TCP | Voir la section suivante : 119 exigences de l'annexe B | tous |

## RFC 9293, annexe B : exigence par exigence

Les identifiants sont ceux de l'annexe B (le tableau 8). « Fait » veut dire que la pile
l'applique et qu'une sonde le mesure ; « Structurel » qu'un segment simulé ne peut pas le
violer (les options sont des objets typés, sans longueur ni alignement qui puissent être faux) ;
« Non retenu » qu'une exigence MAY est laissée de côté, comme Linux le fait.

### Drapeau PUSH

| Exigence | État | Preuve |
|---|---|---|
| MUST-61 le dernier segment d'une écriture porte PSH | Fait | `probe-tcp-rfc9293-requirements` |
| MUST-60 ne pas retenir indéfiniment sans API PUSH | Fait : Nagle retient jusqu'à l'ACK ou jusqu'à un segment plein, le temporisateur de sonde force l'envoi au bout de 500 ms | `tcp-nagle`, `probe-tcp-receive-window` |
| MAY-16, SHLD-27 agréger les écritures, ne pas répéter PSH | Fait : la coalescence de Nagle remplit chaque segment | `tcp-nagle` |
| SHLD-28 segment de taille maximale quand c'est possible | Fait | `tcp-nagle`, `probe-tcp-receive-window` |
| MAY-15 SEND avec PUSH, MAY-17 PUSH signalé à l'application | Non retenu : aucune de ces API (Linux n'en offre pas) | |

### Fenêtre

| Exigence | État | Preuve |
|---|---|---|
| MUST-1, REC-1 numéros de séquence entiers de 32 bits non signés qui bouclent | Fait | `probe-tcp-rfc9293-requirements` |
| SHLD-14 ne pas réduire la fenêtre par la droite | Fait : le bord droit annoncé ne recule jamais | `probe-tcp-receive-window` |
| MUST-34, SHLD-15, SHLD-16, SHLD-17 émetteur robuste à une fenêtre qui se réduit : plus de donnée neuve, anciennes retransmises, pas d'expiration pour des données au-delà du bord | Fait | `probe-tcp-receive-window` |
| MUST-35, MUST-36, SHLD-29, SHLD-30 sonde de fenêtre nulle : première sonde une RTO après le refus, attente doublée à chaque absence de réponse ; une seule minuterie, une sonde perdue n'est pas une perte de donnée, et les ACK de fenêtre nulle qui lui répondent ne sont pas des doublons | Fait | `probe-tcp-rfc9293-requirements`, `probe-tcp-loss-recovery`, `tcp-flow-control` |
| MUST-37 une fenêtre qui reste nulle ne fait pas expirer la connexion tant que le pair répond | Fait | `probe-tcp-rfc9293-requirements` |
| MUST-66 RST traité fenêtre nulle (et URG) | Fait | `probe-tcp-rfc9293-requirements` |
| MAY-8 fenêtre du récepteur fermée indéfiniment | Fait : un lecteur suspendu (`pause`) garde la fenêtre fermée | `probe-tcp-receive-window` |
| MAY-7 retransmettre au-delà de SND.UNA+SND.WND | Non retenu | |

### Données urgentes

| Exigence | État | Preuve |
|---|---|---|
| MUST-30 support du pointeur urgent, MUST-62 il désigne l'octet qui suit les données urgentes, MUST-31 longueur quelconque, MUST-32 l'application est prévenue de façon asynchrone, MUST-33 elle peut savoir s'il reste de l'urgent | Fait : `sendUrgent`, `onUrgent`, `urgentMode`, `rcvUp` ; le dernier octet urgent est livré hors bande (RFC 6093 §3.1) et reste dans le flux ordinaire (`SO_OOBINLINE`) | `tcp-urgent-data` |
| SHLD-13 les applications évitent l'urgent | Aucune application du dépôt ne l'emploie | |

### Options TCP

| Exigence | État | Preuve |
|---|---|---|
| MUST-4 jeu minimal (fin de liste, NOP, MSS), MUST-5 options lues sur tout segment, MUST-6 option inconnue ignorée | Fait : la liste s'arrête à la fin de liste ; une option inconnue ne dérange rien ; MSS ou échelle portés par un segment qui n'est pas un SYN sont ignorés | `probe-tcp-option-robustness` |
| MUST-7 longueur d'option illégale, MUST-64 alignement, MUST-68 longueur de chaque option | Structurel | `probe-tcp-option-robustness` |
| MUST-69 bourrage à zéro après la fin de liste | Fait à la réception (ce qui suit la fin de liste n'est pas lu) ; structurel à l'émission | `probe-tcp-option-robustness` |
| MUST-14 MSS émis et reçu, MUST-67 valeur fondée sur MMS_R : l'option annonce la MTU de l'interface moins les en-têtes (1360 sur 1400, 8960 sur 9000) | Fait | `probe-tcp-maximum-segment-size` |
| MUST-15 MSS d'émission par défaut 536 (IPv4) ou 1220 (IPv6) sans option reçue, MUST-16 taille effective = la plus petite de celle du pair et de celle de l'interface | Fait | `probe-tcp-maximum-segment-size` |
| SHLD-5, MAY-3 option MSS émise | Fait : le SYN et le SYN-ACK la portent toujours | `probe-tcp-maximum-segment-size` |
| SHLD-6 le MSS suit une MTU qui varie | Fait : une erreur « fragmentation needed » ou « packet too big » réduit le MSS et la fenêtre de congestion | `tcp-pmtu`, `probe-icmpv6-errors-reach-the-transport` |
| MUST-65 pas de MSS hors SYN | Fait | `probe-tcp-option-robustness` |

### Somme de contrôle et numéro de séquence initial

| Exigence | État | Preuve |
|---|---|---|
| MUST-2 l'émetteur calcule la somme, MUST-3 le récepteur la vérifie ; une somme à zéro n'est pas « non calculée » (la règle inverse de celle d'UDP) | Fait, IPv4 et IPv6 | `probe-somme-tcp-obligatoire-rfc9293`, `ipv6-l4-checksum` |
| MUST-8 horloge, SHLD-1 fonction pseudo-aléatoire, MUST-9 non calculable de l'extérieur | Fait : M à 250 pas par milliseconde, F = HMAC-SHA256 sous clé secrète | `probe-tcp-initial-sequence-numbers` |

### Ouverture et fermeture

| Exigence | État | Preuve |
|---|---|---|
| MUST-10 ouverture simultanée, MUST-11 SYN-RECEIVED se souvient de l'état précédent (retour à LISTEN après un RST d'ouverture passive) | Fait | `probe-tcp-rfc9293-requirements`, `probe-tcp-handshake-ack-validation` |
| MUST-41, MUST-42 plusieurs LISTEN, plusieurs connexions sur un même port d'écoute | Fait | `probe-tcp-rfc9293-requirements`, `tcp-stack` |
| MUST-43 adresse locale facultative à l'ouverture, MUST-44, MUST-45 adresse source demandée à IP, sinon celle de la connexion | Fait : `TcpConnectOptions.localIp` (`nc -s`, des deux familles) ; sans elle, la table de routage choisit l'interface et IPv6 suit la RFC 6724 | `probe-udp-connect-over-ipv6`, `probe-tcp-suit-la-table` |
| MUST-46 ouverture refusée vers une adresse de diffusion ou de groupe | Fait : refus immédiat, comme `tcp_v4_connect` et `tcp_v6_connect` | `probe-tcp-refuse-le-non-unicast`, `probe-tcp-ne-diffuse-pas` |
| MUST-57 SYN adressé à une diffusion ou à un groupe jeté en silence, MUST-63 SYN de source invalide ignoré | Fait : source nulle, de diffusion (limitée ou dirigée), de groupe, martienne ou notre propre adresse | `probe-tcp-open-and-listen-rules`, `probe-tcp-n-arpe-pas-le-non-specifie` |
| MUST-12 l'application est informée d'une fermeture ou d'un abandon | Fait : la fin du pair est annoncée, l'application décide quand fermer son sens ; un RST la prévient | `probe-tcp-half-close` |
| SHLD-2 un RST peut porter des données | Fait | `probe-tcp-rfc9293-requirements` |
| MUST-13 TIME-WAIT 2 MSL, redémarré par un FIN retransmis | Fait ; un second `close()` ne l'évapore plus | `probe-tcp-fin-wait-states`, `probe-tcp-half-close`, `scenario-time-wait-reuse` |
| MAY-2 un SYN neuf rouvre depuis TIME-WAIT | Fait : l'ISN neuf dépasse le `sendNext` de l'incarnation précédente | `probe-tcp-open-and-listen-rules` |
| MAY-1 fermeture « half-duplex » où `close()` interdit la lecture, SHLD-3 RST quand des données non lues sont perdues | Non retenu : la pile suit la variante full-duplex de §3.6.1, `close()` n'envoie que le FIN ; `allowHalfOpen` est faux par défaut comme dans `net.Socket` | `probe-tcp-half-close` |
| SHLD-4 Timestamps pour réduire TIME-WAIT (RFC 6191) | Non fait : le texte n'est pas dans le dépôt | |

### Retransmission, congestion, ACK

| Exigence | État | Preuve |
|---|---|---|
| MUST-19 recul exponentiel, démarrage lent, évitement de congestion | Fait ; la reprise rapide rattrape plusieurs pertes d'une fenêtre sans un RTO par trou | `tcp-retransmission`, `tcp-congestion-control`, `probe-tcp-congestion-control-rules`, `probe-tcp-loss-recovery` |
| MUST-18 algorithme de Karn | Fait : seul un segment jamais retransmis est échantillonné ; l'option Timestamps (RTTM) lève la restriction, RFC 7323 §4.3 | `tcp-options` |
| MAY-4 retransmettre avec la même identification IP | Non retenu : chaque transmission est un paquet neuf, comme Linux | |
| MUST-58 ACK agrégés, MUST-59 tous les segments en file traités avant l'ACK | Fait | `probe-tcp-rfc9293-requirements` |
| SHLD-18 ACK retardés, MUST-40 sous 500 ms, SHLD-19 un ACK tous les deux segments pleins | Fait ; l'horloge de la livraison synchrone est la fin de rafale | `tcp-delayed-ack`, `probe-tcp-rfc9293-requirements` |
| SHLD-31 segments hors séquence conservés, MAY-13 ACK immédiat sur un hors séquence | Fait : chevauchements rognés, plages sans recouvrement, FIN traité une fois tout ce qui le précède arrivé | `probe-tcp-sequence-acceptability`, `tcp-delayed-ack` |
| MUST-39 SWS côté récepteur, MUST-38 SWS côté émetteur | Fait | `probe-tcp-receive-window` |
| SHLD-7 Nagle, MUST-17 désactivable (`TCP_NODELAY`) | Fait | `tcp-nagle` |
| MUST-49 TTL réglable | Fait : par connexion et par écouteur, hérité par la prise acceptée, SYN-ACK compris ; le TTL par défaut est celui de la machine (64 Linux, 128 Windows) | `probe-tcp-open-and-listen-rules`, `probe-nc-socket-options` |

### Échecs de connexion et keep-alive

| Exigence | État | Preuve |
|---|---|---|
| MUST-20 avis négatif à IP à R1, fermeture à R2, MUST-21 R2 réglable par l'application, SHLD-9 l'application est prévenue entre R1 et R2, MUST-22 même mécanisme pour les SYN | Fait : `onErrorReport`, `setUserTimeout` (`Infinity` pour ne jamais renoncer), `adviseNegative` (nouvelle requête ARP du prochain saut) | `probe-tcp-error-reports-and-retransmission-limits` |
| SHLD-10 R1 d'au moins trois retransmissions, SHLD-11 R2 d'au moins 100 s | Fait : 100 s pour les données, depuis la première émission du segment le plus ancien | `probe-tcp-error-reports-and-retransmission-limits` |
| MUST-23 R2 d'au moins 3 minutes pour un SYN | Fait : 180 s. Linux fait 6 retransmissions (`tcp_syn_retries`, environ 127 s) ; la RFC gouverne | `probe-tcp-error-reports-and-retransmission-limits`, `ssh-refus-contre-silence` |
| MUST-24 à MUST-29, SHLD-12 keep-alive : demandé par l'application (`enableKeepAlive`), éteint par défaut, jamais avant la fin de l'inactivité, durée et intervalle fournis par l'application, tolérant aux ACK perdus, sonde sans donnée à SND.NXT − 1 | Fait ; l'API n'a pas de durée par défaut (MUST-28) : une connexion non armée n'émet rien, même après des heures | `probe-tcp-rfc9293-requirements`, `tcp-keepalive-abort` |
| MAY-5 émettre des keep-alive | Fait | `tcp-keepalive-abort` |
| MAY-6 octet de remplissage dans la sonde | Non retenu (Linux n'en met pas) | |

### Options IP, ICMP, interface avec l'application

| Exigence | État | Preuve |
|---|---|---|
| MUST-50 option IP inconnue ignorée | Fait | `probe-tcp-rfc9293-requirements` |
| MAY-10 Timestamp IP, MAY-11 Record Route | Non retenu : aucune option IP n'est ni émise ni mémorisée par TCP (un SYN qui en porte une ouvre la connexion) | `probe-tcp-rfc9293-requirements` |
| MUST-51 l'application fixe une route source, MUST-52 elle l'emporte sur celle d'un datagramme, MUST-53 la route de retour d'un SYN est mémorisée, SHLD-24 la dernière route l'emporte | Non construit : une prise TCP ne porte aucune option IP. Les briques IP existent (`buildSourceRouteOption`, `reverseSourceRoute`, le routeur sait suivre une route source) mais `EndHost` n'évalue pas `accept_source_route` : un hôte final ignore l'option au lieu de l'abandonner comme Ubuntu (défaut 0) | |
| MUST-54 une erreur ICMP est remise à la connexion qu'elle cite, SHLD-26 les codes 2 à 4 durs abandonnent, MUST-56 les erreurs douces (0, 1, 5, temps dépassé, paramètre erroné) n'abandonnent pas, SHLD-25 elles sont signalées | Fait en IPv4 et en IPv6 (RFC 4443 §2.4), sur les postes comme sur les routeurs ; une erreur dont la séquence citée n'est pas en vol est ignorée (RFC 5927 §4.1) ; le Packet Too Big réduit le MSS et la route le retient 600 s | `probe-tcp-error-reports-and-retransmission-limits`, `probe-icmpv6-errors-reach-the-transport`, `probe-router-tcp-receives-icmp-errors` |
| MUST-55 Source Quench jeté en silence | Rien à jeter : le simulateur n'a pas de Source Quench (type déprécié par la RFC 6633) | `probe-tcp-rfc9293-requirements` |
| MUST-47 mécanisme de rapport d'erreur, SHLD-20 l'application peut le désactiver | Fait : `onErrorReport` est facultatif | `probe-tcp-error-reports-and-retransmission-limits` |
| MUST-48 Diffserv réglable, SHLD-22 transmis tel quel, SHLD-21 modifiable en cours de connexion | Fait : `DiffServField`, `setDiffServ`, `nc -T` ; les bits ECN d'un champ de prise STREAM sont masqués, comme le noyau | `probe-tcp-open-and-listen-rules`, `probe-nc-socket-options`, `probe-tcp-explicit-congestion-notification` |
| SHLD-23 les applications ne changent pas Diffserv en cours de connexion | Aucune application du dépôt ne le fait | |
| MAY-9 Diffserv reçu remis à l'application | Non retenu : rien ne l'expose | |
| MAY-14 appel FLUSH | Non retenu : Linux n'en offre pas | |

### RFC 5961, ECN, contrôle de congestion de remplacement

| Exigence | État | Preuve |
|---|---|---|
| MAY-12 protection contre l'injection de données (RFC 5961) | Fait | `probe-tcp-rfc5961-challenge-acks`, `probe-rst-hors-fenetre-est-ignore` |
| SHLD-8 ECN | Fait (RFC 3168 §6.1) | `probe-tcp-explicit-congestion-notification` |
| MAY-18 autre algorithme de congestion | Non retenu : `TcpCongestionControl` est une stratégie interchangeable, mais il n'y en a qu'une (RFC 5681) ; ni CUBIC ni BBR | |

## Plateformes

- **Linux** (`LinuxPC`, `LinuxServer`) : TTL 64 ; ECN en mode 2 (accepte, ne demande pas),
  `net.ipv4.tcp_ecn` et `net.ipv4.tcp_ecn_fallback` lisibles et inscriptibles dans `/proc/sys/net/ipv4/`
  et par `sysctl` ; `nc -M`, `-m`, `-T`, `-N`, `-s` agissent sur la prise ; `tcpdump` sur `lo` décode le
  vrai paquet comme sur le fil, `tcpdump -v` imprime l'en-tête IPv6.
- **Windows** : TTL 128 ; n'envoie ni n'accepte ECN (configuration par défaut) ; aucune commande
  `netsh int tcp` ni `Set-NetTCPSetting` n'existe (ni leur sortie, qu'on ne peut pas sourcer d'ici).
- **Routeurs** : la pile de gestion (BGP, SSH, telnet) est la même ; elle ne négocie pas ECN ; elle reçoit
  les erreurs ICMP et ICMPv6 des connexions qu'elle ouvre (`probe-router-tcp-receives-icmp-errors`).
- **Pare-feu et commutateurs** : même pile, sans ECN ; elle ne reçoit pas encore les erreurs ICMP des
  connexions qu'elle ouvre (`probe-commutateur-a-une-pile-tcp` pour la pile du commutateur).

## Limites assumées

- **Reprise sur pertes.** Une perte en queue de fenêtre, avec trop peu de segments au-dessus pour la
  prouver, se rattrape par un RTO (un seul pour tous les trous restants). Ne sont pas construits : RACK et la
  sonde de queue (RFC 8985), la réduction proportionnelle (RFC 6937), D-SACK (RFC 2883), F-RTO (RFC 5682), la
  détection d'un récepteur qui renie ses blocs, le réarmement du RTO à chaque retransmission de reprise
  (RFC 6675 §6, facultatif). Après une expiration un pair sans SACK reçoit dans l'ordre tout ce qui était en
  vol, y compris ce qu'il avait déjà (retransmissions inutiles de la RFC 6582 §4).
- **Délai de livraison nul.** La livraison des trames est synchrone, le RTT vaut 0 ms en temps virtuel ;
  les temporisateurs (RTO, ACK retardé, sonde) tournent sur l'ordonnanceur virtuel.
- **ECN.** Ni AccECN ni les extensions de la RFC 8311 ; un seul ACK immédiat là où
  `tcp_enter_quickack_mode` en émet deux ; aucun contrôle de congestion qui exige ECN
  (`tcp_ca_needs_ecn`) ; pas de drapeau ECN par route ; VXLAN ne suit pas la RFC 6040 (son agent ne reçoit
  pas l'en-tête IP extérieur) ; le tunnel GRE des routeurs n'a pas de plan de données ; les mots de
  `netem` qui exigent un vrai délai (`reorder`, `rate`, `slot`, gigue, distributions, `loss state`,
  `gemodel`, `duplicate`, `corrupt`, `limit`) restent acceptés sans effet, comme avant.
- **Réglages du noyau.** Parmi les `net.ipv4.tcp_*`, `sysctl` ne connaît que `tcp_ecn` et
  `tcp_ecn_fallback` (évalués par la pile) et `tcp_tw_reuse`, que la `SocketTable` lit au `bind` et qui
  s'affiche `0` là où le noyau 5.15 annonce `2` (`ip-sysctl.rst`, lu). `tcp_syn_retries`, `tcp_retries1`
  et `tcp_retries2`, `tcp_keepalive_*`, `tcp_fin_timeout`, `tcp_sack`, `tcp_timestamps`,
  `tcp_window_scaling`, `tcp_congestion_control` et `ip_default_ttl` répondent `cannot stat
  /proc/sys/net/ipv4/…` (mesuré) ; les valeurs de la pile sont des constantes ou des réglages de prise.
- **Source route.** Voir MUST-51 à MUST-53 ci-dessus.
- **TCP_INFO.** `ss -i` n'imprime ni `ecn`, ni `ecnseen`, ni la fenêtre de congestion.
- **Anciens documents.** `docs/PRD-TCP.md` décrit l'état du 6 juillet ; ses lacunes (absence de RTO, de
  contrôle de flux, de congestion, d'options) sont fermées, ce bilan fait foi.

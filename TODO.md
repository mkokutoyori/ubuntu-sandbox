# TODO — manquements mesurés, non encore fermés

Un manquement n'entre ici que s'il a été **mesuré** : commande tapée,
état relu, écart constaté. Chaque entrée dit *ce qui est cassé*, *comment
on l'a vu*, et *pourquoi ce n'est pas fermé*. Une entrée fermée est
retirée d'ici et racontée dans son message de commit, jamais dans le
code (`CLAUDE.md` : le code ne porte pas de commentaire).

Format : `[famille] intitulé` puis constat / mesure / raison du report.

---

## Commutateur Huawei (VRP)

### [route] deux routes statiques vers le meme prefixe se confondent
Sur le COMMUTATEUR, `SwitchSvi` indexe ses routes statiques par
`network/mask` seul (`addStaticRoute` remplace l'entree existante), donc
`ip route-static 10.9.0.0 24 10.0.0.1` puis `... 10.0.0.2` laissent UNE
route, la seconde. Une vraie machine en garde deux — c'est ainsi qu'on
ecrit une route de secours ou un partage de charge.
**Mesure** : les deux commandes acceptees, `display current-configuration`
n'en rend qu'une, et `getStaticRoutes()` n'a qu'une entree.
**Consequence sur `undo`** : depuis que la suppression compare le saut
suivant, `undo ip route-static 10.9.0.0 24 10.0.0.1` repond desormais
`Route not found.` sur cette machine — la reponse EXACTE pour l'etat du
magasin, et qui rend le defaut visible au lieu de le masquer en retirant
la mauvaise route comme avant.
**Report** : la cle du magasin decide aussi de ce que lit le plan de
donnees (`SwitchSvi` resout le saut a la volee dans deux boucles), donc
la changer touche le routage du commutateur et pas la CLI. Le ROUTEUR,
lui, n'a pas ce defaut : `Router` garde les deux routes.

### [mac-limit] deux règles de PORTÉES différentes coexistent-elles ?
Une règle est maintenant identifiée par sa portée : `mac-limit maximum 5
vlan 10` puis `mac-limit maximum 8 vlan 10` remplacent bien, et deux VLAN
différents gardent leurs deux règles. Reste la seule question que la
mesure ne tranche pas : `mac-limit maximum 5` (sans qualificatif) et
`mac-limit maximum 5 vlan 10` coexistent ici, parce qu'un qualificatif
`vlan` désigne une autre portée — ce qui est un raisonnement, pas une
mesure.
**Mesure** : les pages `mac-limit (interface view)` de Huawei ne sont pas
joignables depuis ce réseau (proxy) ; deux règles de portées différentes
sur le même port sont plausibles et non attestées.
**Report** : trancher demande le manuel ou une vraie machine. Le
mécanisme, lui, est en place — la clé de réglage porte désormais ses
qualificatifs —, donc fermer cette entrée ne sera qu'un choix de clé.

### [mqc] `redirect` reste hors du comportement
Le comportement sait `permit`, `deny`, `car`, `remark dscp|8021p` et
`statistic enable` (compteurs par point d'application, rendus par
`display traffic policy statistics`). Reste `redirect`.
**Mesure** : `redirect interface GigabitEthernet0/0/2` sous
`traffic behavior` répond `Unrecognized command`.
**Report** : le chemin de données du commutateur décide de laisser passer
ou de jeter — `handleFrame` n'a aucun point où réémettre une trame sur
une autre interface depuis un filtre. Le brancher demande de séparer la
décision de filtrage de la décision de commutation, ce qui touche le
cœur de `handleFrame` et pas le MQC.

### [mqc] l'opérateur `and`/`or` d'un classificateur n'est pas modélisé
Plusieurs `if-match` dans un classificateur sont évalués en OU — le
premier qui touche décide. VRP laisse choisir avec
`traffic classifier NAME operator { and | or }`.
**Mesure** : le mot-clé `operator` est refusé.
**Report** : la valeur par DÉFAUT de VRP n'est pas attestée depuis ce
réseau (pages Huawei bloquées par le proxy), et se tromper de défaut
changerait le sens de tous les classificateurs à plusieurs règles. Le OU
actuel est celui que le code appliquait déjà ; l'écrire sans mesure
serait pire.

### [info-center] `display info-center` est refusée
Le magasin existe (`InfoCenterConfig`), la famille de configuration est
honorée et figure maintenant dans `display current-configuration` sur les
deux plateformes — mais la vue qui la relit n'existe sur aucune des deux :
`display info-center` répond `Unrecognized command`.
**Report** : mesuré, non fermé — il manque une capture attestée du tableau
que rend la vraie commande (état, canaux, destinations), et
`info.support.huawei.com` est EGRESS_BLOCKED depuis cette session. Rendre
un tableau inventé serait exactement le décor que ce dépôt passe son temps
à défaire.

---

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

---

## Postes Windows

### [ping] le CODE de l'ICMP inatteignable est jeté à l'affichage
**Constat.** `WinPing.formatWinPingReplyLine` rend TOUT « destination
unreachable » par `Reply from <ip>: Destination host unreachable.`, quel
que soit le code ICMP. Mesuré : un routeur qui refuse par ACL répond
type 3 **code 13** (communication administrativement interdite), le code
VOYAGE bien jusqu'au client — `EndHost` le range dans la chaîne d'erreur
(`Destination unreachable (from X) code 13`) et le `ping` Linux le lit
déjà pour écrire « Packet filtered » (`commands/net/Ping.ts`, ligne 249)
— mais la moitié Windows ne le regarde pas. Deux machines du même
laboratoire diagnostiquent donc le même refus autrement, et celle qui
perd l'information est celle qui envoie l'apprenant vérifier son câblage
au lieu de sa liste d'accès.

**Ce qui bloque, et c'est une question de RÉFÉRENCE, pas de code.** Les
chaînes exactes de `ping.exe` par code ne sont pas vérifiables : la
documentation Microsoft ne les publie pas, et la seule source à texte
préservé trouvée est ReactOS — une réimplémentation, qui ne traite que
NET/HOST/TTL et écrit « Destination network unreachable. » là où Windows
écrit, d'après tout ce qu'on lit ailleurs, « Destination net
unreachable. ». Écrire la table de mémoire produirait exactement le
genre de sortie plausible-et-fausse que ce dépôt passe son temps à
refermer.

**Report.** Hors du chemin du tutoriel ACL — le lecteur y constate un
`Reply from <routeur>` et 100 % de perte, ce que la plateforme rend
correctement. À fermer le jour où une capture réelle de `ping.exe` sous
ACL est disponible ; le reste est déjà en place, il ne manque que les
libellés.

---

## Gestion (SNMP, NTP, syslog)

### [snmp] la moitie du vocabulaire VRP est rangee et jamais evaluee
Depuis le lot « une communaute SNMP est une communaute », la CLI VRP
ecrit dans `SnmpService` et un mot que VRP ne connait pas est REFUSE.
Restent les formes que VRP connait et que ce moteur ne sait pas honorer :
`mib-view`, `group v3`, `usm-user v3`, `packet max-size`,
`protocol source-interface`, `protocol version`, et les deux moities
`target-host trap-hostname` / `trap-paramsname`. Elles vont dans
`SnmpService.recordVrpLine`, sont rendues telles qu'ecrites, et rien ne
les lit. Mesure : une communaute restreinte a une vue MIB vide lit quand
meme `sysName` ; un `usm-user v3` declare ne permet aucune requete v3,
`SnmpAgent` n'ayant ni USM ni v3 du tout.
**Pourquoi ce n'est pas ferme** : les refuser casserait le rejeu d'une
configuration reelle et les ferait disparaitre a l'import d'une
topologie — le meme raisonnement que pour
`ip ssh server algorithm`. Les evaluer demande trois chantiers
distincts : une notion de vue MIB filtrant chaque OID resolu, un modele
USM/v3 (authentification et chiffrement des PDU), et une interface
d'ecoute par laquelle l'agent repondrait, qui n'existe pas — il repond
sur le port qui a recu. Ce qui EST evalue depuis ce lot, et qui fixe la
frontiere : nom et droit de communaute, `acl` (source confrontee a la
liste, echec ferme), contact, localisation, versions, hote de trap,
`trap source`, `trap enable`, `local-engineid`.

---

## Socle CLI

### [cli] `standby ?` annonce `<0-255>` meme apres `standby version 2`
La borne du numero de groupe HSRP DEPEND de la version configuree sur
l'interface — 0-255 en v1, 0-4095 en v2 — et le gestionnaire l'applique
correctement et dynamiquement. La declaration d'aide, elle, est statique
et annonce toujours `<0-255>`.
**Mesure** : sur une interface passee en `standby version 2`, un groupe
300 est accepte (juste) et `standby ?` continue d'annoncer `<0-255>`
(faux). La declaration porte desormais `rangeIsAdvisory`, qui EXEMPTE ce
cas de la regle « une plage annoncee est appliquee » — sans quoi cette
regle refusait un groupe que la machine accepte, mesure a neuf cas de
test en echec.
**Report** : rendre l'aide juste demande qu'une declaration puisse LIRE
l'etat de l'interface, ce qu'aucune ne fait aujourd'hui — elles sont
attachees a l'arbre, pas a la session. C'est le meme chantier que
l'entree ci-dessous : des declarations qui decident au lieu de decrire.

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
`<1-120>` ne peut pas vouloir dire autre chose.


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

## Pare-feu FortiGate

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

### [durcissement] `set reuse-password disable` est refuse
Le reglage existe sur un vrai FortiGate et interdit de reprendre un ancien
mot de passe.
**Mesure** : la commande rend `Command fail` en nommant l'absence
d'historique.
**Report** : il faudrait garder les N derniers mots de passe de chaque
compte — donc un magasin de secrets historises, ce qu'aucun equipement de
ce depot ne fait aujourd'hui. `min-change-characters` est dans le meme cas
et pour la meme raison (il compare au mot de passe PRECEDENT).

### [durcissement] la banniere d'apres-connexion ne demande pas d'etre acceptee
Un vrai FortiOS affiche la banniere `post_admin-disclaimer-text` puis
demande de l'accepter, et refuse la session sans acceptation.
**Mesure** : la banniere s'affiche, la session s'ouvre sans rien demander.
**Report** : c'est un pas d'interaction de plus dans l'enchainement de
connexion (`buildLoginSteps`), donc un branchement de refus a ecrire ; le
tutoriel n'emprunte que la banniere d'avant-connexion.

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

### [journal] l'origine d'une modification est toujours `jsconsole`
L'evenement de configuration porte `user` — le compte reellement
authentifie, ce qui est ce que l'etape 7 du TP 22 enseigne — mais son champ
`ui` est constant. Un vrai FortiOS y ecrit d'ou la modification vient :
`GUI(10.5.63.254)`, `ssh(10.5.63.254)`, `jsconsole`, `fgfm`.
**Mesure** : modifier un objet depuis la console et depuis une session SSH
donne la meme ligne.
**Report** : le shell ne sait pas par quelle porte il est atteint —
`FortiShell` est construit une fois par equipement et les sessions
distantes le partagent. Le porter demande la meme notion de session que le
`terminal monitor` de Cisco a exigee, et vaut mieux fait une fois pour
toutes les vues que par une devinette ici.

### [journal] le seuil de remplissage du tampon memoire n'alerte pas
`full-first-warning-threshold`, `full-second-warning-threshold` et
`full-final-warning-threshold` sont acceptes, rendus, et lus par personne.
Sur une vraie machine, franchir chacun ecrit un evenement.
**Mesure** : `set max-size 400` puis produire du trafic — le tampon est
borne pour de bon (les plus anciennes lignes tombent), mais aucun
evenement n'annonce le franchissement.
**Report** : le tampon compte desormais ses octets ET reserve vraiment sa
RAM (phase 16 : `set max-size` deplace la memoire utilisee et peut a lui
seul declencher le mode conserve), donc la matiere est la.
Ce qui manque reste le message : la reference des journaux FortiOS ne
porte qu'UN identifiant de cette famille, `22023`
(`LOG_ID_MEM_LOG_FIRST_FULL`, « Memory log first full »), et rien en
`22024`-`22026` qui corresponde a un deuxieme ou a un dernier
avertissement — ces deux-la sont un mot de passe expire et deux
evenements SSH. Donc la correspondance entre les TROIS seuils et les
evenements emis n'est pas etablie : en ecrire trois inventerait deux
identifiants, et rattacher `22023` au premier seuil suppose que
« first full » veuille dire « 75 % » alors qu'il se lit plutot
« plein pour la premiere fois ». Ce qui est sur et implementable seul :
un evenement `0100022023` la premiere fois qu'un enregistrement est
JETE faute de place — `droppedCount` le sait deja.

### [pare-feu] les fragments recus ne sont pas REASSEMBLES
Le pare-feu fait desormais respecter le MTU de son interface de sortie :
DF pose et datagramme trop gros donne un ICMP Fragmentation Needed portant le
MTU du saut suivant, DF absent donne de vrais fragments RFC 791. Ce qui reste
ouvert est le sens INVERSE : un datagramme qui arrive deja fragmente n'est pas
recolle. Les fragments suivant le premier ne portent pas d'en-tete de couche 4,
donc leur cle de flux est batie sur des ports absents et la table de sessions
ne les rattache a rien.
**Mesure** : le premier fragment ouvre une session, les suivants en ouvrent
chacun une autre — `diagnose sys session list` en compte plusieurs pour un seul
datagramme.
**Report** : `IPv4Reassembler` existe dans le socle (`core/Ipv4Fragmentation.ts`)
et `Router.ts` s'en sert, donc c'est un branchement ; mais un pare-feu de
TRANSIT ne reassemble pas par defaut sur un vrai FortiGate (il ne le fait que
sous inspection UTM), donc le brancher demande d'abord de decider QUAND, et
cette condition n'est modelisee nulle part.

### [ha] les adresses MAC VIRTUELLES du cluster n'existent pas
FGCP donne a chaque interface du cluster une adresse MAC virtuelle, portee
par le membre primaire : c'est ce qui rend le basculement invisible aux
commutateurs et aux caches ARP du reseau. Ici, chaque membre garde la MAC
de son propre port ; le secondaire se tait (il ne repond plus a l'ARP et ne
fait passer aucun paquet), donc le cas nominal est juste, mais apres un
basculement le voisinage doit RE-resoudre l'adresse au lieu de continuer a
emettre vers la meme MAC.
**Mesure** : `ip neigh` sur le poste du LAN nomme la MAC du membre primaire
et non une MAC de grappe ; apres bascule, la valeur change.
**Report** : poser une MAC virtuelle demande que `Port` accepte une seconde
adresse decidee par le cluster et que l'emission comme la reception la
suivent — c'est un changement du materiel simule, pas du pare-feu, et il
touche l'apprentissage MAC de tous les commutateurs du projet. L'ARP
gratuit qui accompagne le basculement en depend egalement.

### [ha] `execute ha manage` n'ouvre pas la CLI du membre distant
La commande repond `Connecting to <nom> (<serie>)...` et rend la main : on
ne se retrouve pas sur l'autre machine. L'etape 6 du TP 21 s'en sert pour
verifier que la configuration a bien ete copiee, ce qui reste faisable
autrement (le test lit la configuration du secondaire directement).
**Mesure** : `execute ha manage 1 admin` puis `get system status` repond
encore pour le membre local.
**Report** : la matiere existe — `RemoteDeviceSubShell` fait exactement
cela pour SSH — mais la brancher ici demande que le battement de coeur
porte une voie de commande, ou que la grappe partage un registre
d'equipements, ce qui contournerait le fil.

### [ha] `execute ha synchronize start` ne tire rien depuis un secondaire
La synchronisation de ce moteur est POUSSEE par le primaire dans son
battement de coeur. La commande emet donc un battement immediat, ce qui
avance vraiment la synchronisation quand on la tape sur le primaire, et ne
fait rien de plus sur un secondaire — un vrai FortiGate y declenche une
traction de la configuration.
**Mesure** : modifier le primaire, taper la commande sur le secondaire :
rien ne change tant que le primaire n'a pas emis.
**Report** : demanderait un echange requete/reponse dans le protocole de
grappe, la ou il n'y a aujourd'hui qu'une annonce periodique.

### [sdwan] une interface membre reste referencable par une politique
Le tutoriel (§20, TP 20 etape 1) enonce la protection reelle : quand une
interface devient membre du SD-WAN, FortiOS REFUSE de l'ajouter tant qu'une
politique ou une route statique la nomme encore directement — il faut
d'abord faire citer la ZONE par ces politiques. Rien ne refuse ici : une
politique peut nommer `port1` et le membre 1 peut nommer `port1` au meme
instant, ce qui est precisement la situation que la protection existe pour
empecher.
**Mesure** : `set dstintf "port1"` sur une politique, puis `set interface
"port1"` sur un membre : les deux sont acceptes.
**Report** : la matiere est a moitie la — `ZoneTable.assignInterface` refuse
deja `interface-already-in-zone` — mais compter les references d'une
interface a travers les politiques, les routes et les tables NAT est un
mecanisme general (« qu'est-ce qui nomme cet objet ? ») qui depasse le
SD-WAN et servirait a toutes les suppressions d'objet.

### [sdwan] la zone ne suit pas un changement de MEMBRE
La route d'une zone SD-WAN suit desormais la SANTE : `update-static-route`
(actif par defaut, comme sur un vrai FortiGate) retire la route d'un membre
declare mort et la rend quand il revient ; la session portee par ce membre
est fermee, donc le flux suivant repart par le membre survivant. Ce qui reste
ouvert est l'autre moitie de l'ancienne entree : ajouter ou retirer un membre
de la zone APRES avoir ecrit la route ne redeveloppe rien.
**Mesure** : declarer la route par la zone, puis ajouter un membre 3 — la
table de routage n'en porte pas de route.
**Report** : le chainon existe maintenant (`Firewall.installSdwanRoute` est
rejoue a chaque transition de sante), il suffirait de le rejouer aussi au
commit d'un membre. Ce n'est pas fait parce que l'ordre de commit des tables
de `config system sdwan` n'est pas etabli : les membres et les routes
statiques sont deux tables distinctes, et rejouer trop tot developperait une
route sur une zone encore vide.

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

### [execute] `ping6` absente, faute d'emetteur ICMPv6 sur le pare-feu
`execute ping6 ::1` repond « unknown action ». Le refus tient a une
brique manquante et non a la commande : le pare-feu n'a aucun emetteur
ICMPv6 — `FirewallPing` construit un `IPv4Packet` et rien d'autre.
**Mesure** : la commande tapee sur une machine neuve, refusee.
**Report** : ecrire l'emetteur ICMPv6 est le sujet, et il sert aussi
`execute traceroute6` et la surveillance SD-WAN en v6.

### [admin] pas d'interface d'administration HTTP/HTTPS
`set allowaccess http https` est accepte, rendu, et gouverne bien le
filtrage TCP (`ManagementPlane.admitsTcp` refuse le port), mais RIEN
n'ecoute derriere : aucun serveur qui servirait la page de connexion que
le TP 1 fait ouvrir sur `http://192.168.100.99`.
**Mesure** : le TP 1 demande d'ouvrir l'adresse dans un navigateur ; la
seule brique HTTP du pare-feu est `AuthPortal` (portail captif), qui
n'est pas monte sur les ports d'administration.
**Report** : `Http1ServerSession` existe et le portail captif montre le
chemin ; il manque le serveur d'administration lui-meme et ses pages,
sujet en soi et non une commande de plus.

## Serveurs DHCP

### [dhcp] `utilization mark high|low` n'est pas configurable
`show ip dhcp pool` rend la ligne
`Utilization mark (high/low) : 100 / 0`. Les deux valeurs SONT celles
d'IOS par defaut, mais elles sont constantes : la vue lisait
`pool.highUtilizationMark`/`lowUtilizationMark`, deux proprietes qui
n'existent sur aucun `DHCPPoolConfig`, donc les replis `?? 100` / `?? 0`
etaient tout ce qui s'affichait. Elles sont desormais des constantes
nommees, ce qui dit la verite au lieu de simuler une lecture.
**Mesure** : `utilization mark high 80` sous `ip dhcp pool` est refuse, et
aucun magasin ne porte le reglage.
**Report** : la commande n'a d'interet qu'avec ce qu'elle declenche —
`%DHCPD-4-HIGH_UTIL` et la notification SNMP associee —, donc l'accepter
seule rangerait un seuil que rien ne franchit. C'est un lot avec son
emetteur, pas un attribut de plus.

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

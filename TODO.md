# TODO — manquements mesurés, non encore fermés

Un manquement n'entre ici que s'il a été **mesuré** : commande tapée,
état relu, écart constaté. Chaque entrée dit *ce qui est cassé*, *comment
on l'a vu*, et *pourquoi ce n'est pas fermé*. Une entrée fermée est
retirée d'ici et racontée dans son message de commit, jamais dans le
code (`CLAUDE.md` : le code ne porte pas de commentaire).

Format : `[famille] intitulé` puis constat / mesure / raison du report.

---

## Commutateur Huawei (VRP)

### [suppression] `multicast-suppression` / `unicast-suppression` absentes, `broadcast-suppression` décorative
Les deux premières sont refusées ; la troisième est acceptée et rangée en
TEXTE dans `ifCfg`, sans moteur de limitation derrière.
**Mesure** : `broadcast-suppression 30` → rendu dans `display this`, aucun
compteur, aucune trame écartée.
**Report** : compléter la famille ajouterait deux décors. Il faut d'abord
un vrai seau à jetons par port et par type de trafic (le `CarPolicer` du
routeur en est un, mais il vit sur `Router`, que `Switch` n'étend pas).

### [mac-limit] la portée VLAN d'une limite MAC n'est pas vérifiée
Le magasin de texte par interface ne s'empile plus : une ligne identique
n'est gardée qu'une fois, et `broadcast-suppression`, `jumboframe` et
`mac-limit maximum` (sans qualificatif `vlan`) remplacent leur valeur
précédente. Reste la question de PORTÉE que l'entrée précédente posait :
`mac-limit maximum 5` puis `mac-limit maximum 5 vlan 10` coexistent ici,
parce qu'un qualificatif `vlan` désigne une autre règle — ce qui est un
raisonnement, pas une mesure.
**Mesure** : les pages `mac-limit (interface view)` de Huawei ne sont pas
joignables depuis ce réseau (proxy) ; deux règles de portées différentes
sur le même port sont plausibles et non attestées.
**Report** : trancher demande le manuel ou une vraie machine. Deux règles
`mac-limit ... vlan 10` successives coexistent aussi aujourd'hui, ce qui
est faux quelle que soit la réponse — mais le corriger suppose une clé de
réglage qui porte ses qualificatifs, donc un magasin qui ne soit plus une
simple liste de lignes.

### [qos car] policé sur un routeur VRP, texte sur un commutateur VRP
`CarPolicer` est un vrai seau à jetons sur le chemin de données, mais il
vit sur `Router` ; `Switch` ne l'étend pas.
**Report** : demande de sortir `CarPolicer` du routeur vers une base
partagée, ou de le monter sur `Switch` — travail d'architecture.

### [vues système non mesurées]
Familles repérées comme présentes mais jamais passées au banc :
`dhcp enable`, `dhcp snooping enable`, `observe-port`, `traffic classifier`,
`user-interface vty`, `info-center enable`, `ip route-static` sur un
commutateur L3.
**Report** : pas encore mesurées — à passer au banc avant d'affirmer quoi
que ce soit.

---

## Moteur L2 partagé (`Switch.ts`)

### [stp] `display stp brief` liste les ports sans câble en `DISA LISTENING`
Un port administrativement actif mais sans lien apparaît dans le tableau
avec un rôle et un état, ce qui noie les deux lignes utiles.
**Mesure** : maquette à 25 ports, 23 lignes `DISA LISTENING`.
**Report** : il faut d'abord vérifier sur une vraie machine si VRP les
liste ou non — l'affirmer sans capture serait inventer.

### [stp] MSTI : la BPDU porte son instance en clair
L'arbre commun (CIST) est désormais nommé sur la trame (`cist`), donc
MSTP et PVST se rencontrent. Les MSTI, elles, portent toujours leur
numéro d'instance : deux régions dont les tables VLAN→instance diffèrent
échangeraient des BPDU sur des instances qui ne se correspondent pas.
**Report** : à l'intérieur d'une région les tables sont identiques par
définition, donc le cas ne se produit pas dans un laboratoire ; le fermer
demande de propager le condensé de région et de ne plus échanger que le
CIST entre régions.

---

## Commutateur Cisco

### [stp] `spanning-tree mode mst` déplace l'arbre commun
Passer de PVST (arbre commun = VLAN 1) à MST (CIST = instance 0) laisse
l'ancienne instance convergée derrière et repart d'une instance vide.
La règle 802.1D §8.6.9 ajoutée (réponse à une information inférieure) fait
converger le voisin, donc le symptôme est refermé côté VRP.
**Report** : le cas Cisco n'a pas été mesuré ; à passer au banc.

---

## Socle CLI

### [socle] le commutateur VRP n'a pas encore de pont vers le socle
Le pont existe pour le ROUTEUR VRP (`src/cli/vendors/vrp/`) ;
`HuaweiSwitchShell` ne connaît toujours ni `CommandTable` ni
`CommandSpec`.
**Mesure** : aucune occurrence de `VrpSocle` dans ce fichier.
**Report** : le commutateur a ses propres vues (`vlan`, `port-group`,
`mst-region`, `traffic-*`) qui ne sont pas dans `HUAWEI_VRP_MODES` — il
faut d'abord décrire cette hiérarchie, ce que le routeur n'exigeait pas.

### [socle] une seule famille VRP est migrée
Le pont est branché et exercé par la famille du client DHCP. Le reste du
vocabulaire VRP — plusieurs centaines d'enregistrements — vit toujours
sur `CommandTrie`.
**Report** : la migration est incrémentale par construction ; chaque
famille reprise ferme une part de cette entrée.

## Pare-feu FortiGate

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
**Report** : le tampon compte desormais ses octets, donc la matiere est la ;
ce qui manque est le message exact et son `logid`, que je n'ai pas pu
relever sur une sortie reelle depuis ce reseau.

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

### [sdwan] la route de la zone ne SUIT ni la sante ni un changement de membre
`update-static-route` (active par defaut sur un vrai FortiGate) retire de la
table la route d'un membre declare mort. Ici, la route statique nommant une
zone SD-WAN est developpee en une route par membre AU MOMENT ou elle est
ecrite : elle ne bouge plus ensuite, ni quand un membre tombe, ni quand on
ajoute ou retire un membre de la zone.
**Mesure** : couper le lien du membre 1 puis relire `get router info
routing-table all` — la route par `port1` y est toujours, alors que
`diagnose sys sdwan health-check` le declare `dead`.
**Report** : sans consequence sur le TP 20, dont la bascule passe par la
REGLE de service (branchee sur le pipeline, elle, et qui suit la mesure) ;
la fermer demande de reinstaller les routes a chaque tour de sonde, donc de
faire de la table de routage un consommateur de l'evenement de sante.

### [sdwan] une session DEJA ouverte ne change pas de membre
La regle de service choisit le membre a l'ouverture de la session. Une
session en cours garde son interface de sortie meme si son membre cesse de
respecter le contrat — seul un nouveau flux emprunte le nouveau membre.
**Mesure** : `ping` vers une adresse, degrader le lien, `ping` vers LA MEME
adresse : le trafic reste sur le premier membre ; vers une AUTRE adresse, il
part par le second.
**Report** : un vrai FortiGate reevalue les sessions affectees quand un SLA
change d'etat. Le faire ici demande que la table de sessions soit un
consommateur de l'evenement de sante — meme chainon manquant que l'entree
precedente, et meme raison de ne pas l'improviser.

### [ospf] les vues `get router info ospf database` et `... interface` n'existent pas
Le pare-feu ne repond qu'a `get router info ospf neighbor` ; les deux autres
vues que le tutoriel nomme dans le meme bloc de verification (§20.2) sont
refusees. La matiere existe pourtant en entier depuis que la base se
remplit vraiment : `getOspf().getLSDB()` porte les LSA de routeur, de reseau
et externes, et `getInterface(nom)` porte l'etat, le DR, le BDR, le cout et
les temporisateurs.
**Mesure** : `get router info ospf database brief` rend `Command fail.
Return code -61 / NOTE: unknown configuration path`, sur une machine dont la
base contient au meme instant trois LSA.
**Report** : ces deux vues appartiennent au TP 20 et non au TP 19, dont
l'etape 4 lit `get router info routing-table ospf`. Le format a rendre est
celui de zebra (`Link ID / ADV Router / Age / Seq# / CkSum`), qui n'est pas
celui d'IOS — la base est partagee, le rendu ne l'est pas.

### [ospf] un LSA de reseau PERIME n'est jamais retire
RFC 2328 §12.4.2 : quand le dernier voisin pleinement adjacent disparait, le
DR doit VIDER (`MaxAge`) le LSA de reseau qu'il a annonce. `OSPFEngine`
n'a aucun mecanisme de vidange — `originateNetworkLSA` rend `null` quand il
reste moins de deux routeurs attaches, et le LSA deja installe demeure
jusqu'a son vieillissement naturel (3600 s).
**Mesure** : couper le lien de transit laisse `2:<ip du DR>:<routeur>` dans
la base des deux cotes ; seul le LSA de ROUTEUR est reannonce, et c'est lui
qui fait disparaitre la route du calcul.
**Report** : la consequence visible est nulle aujourd'hui — le SPF traverse
un lien de transit par le LSA de routeur ET le LSA de reseau, donc la route
tombe quand meme. Ecrire la vidange demande un `MaxAge` premature et sa
propagation, qui n'existent nulle part dans ce moteur.

### [linux] la commande `ipsec` (strongSwan) est une FACADE
`ipsec up <conn>` rend `initiating IKE_SA <conn>[1] to 0.0.0.0` — la chaine
`0.0.0.0` est litterale, quelle que soit la configuration —, `ipsec status`
annonce toujours `0 up`, et `/etc/ipsec.conf` n'est lu par personne. Aucune
negociation n'a lieu : un poste Linux n'a pas de moteur IPsec du tout, seuls
`Router` et le pare-feu en construisent un. Le TP 18 monte donc son client
teletravailleur avec un SECOND FortiGate, qui en porte un — ce qu'un vrai
deploiement fait aussi (concentrateur a composition avec des FortiGate
distants), mais ce n'est pas le client du tutoriel.
**Mesure** : `ipsec up X` puis `ipsec status` sur un poste Linux ; rien ne
change et aucune trame ne part.
**Report** : il faut donner un moteur IPsec a `LinuxMachine` et un lecteur
d'`ipsec.conf` par-dessus. `IPSecEngine` est ecrit contre un hote de forme
ROUTEUR (`_getAccessListsInternal`, `getLocalIP`, `_getHostnameInternal`),
donc il faut d'abord degager ce port etroit — c'est le vrai travail, et il
sert aussi le TP 17 cote client.

### [ipsec] la RESTRICTION des selecteurs n'est pas implementee
RFC 7296 §2.9 laisse un repondeur RETRECIR les selecteurs proposes : si
l'initiateur demande 10.0.0.0/8 et que le repondeur ne couvre que
10.1.0.0/16, il repond avec le plus petit des deux et l'enfant s'etablit.
Le depot n'accepte que le cas MIROIR exact — deux selecteurs identiques a
l'envers — et refuse tout le reste par `TS_UNACCEPTABLE`.
**Mesure** : deux phases 2 dont l'une est un sur-ensemble de l'autre
donnent `selectors(total,up): 1/0` alors qu'une vraie machine monterait
l'enfant sur l'intersection.
**Report** : le retrecissement demande de calculer une intersection de
prefixes et de la RENVOYER dans l'acceptation, donc de porter les
selecteurs retenus jusqu'a l'initiateur ; le cas miroir est celui de tous
les laboratoires site-a-site et il est desormais juste.

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

### [admin] le verrouillage apres N essais ne compte pas la console
`admin-lockout-threshold` et `admin-lockout-duration` sont acceptes et le
compteur (`ManagementPlane.login`) fonctionne — mais il est indexe par
SOURCE, et une connexion de console n'a pas d'adresse d'origine. La
console appelle donc `authenticateAdmin` directement : trois mots de
passe faux d'affilee sur la console ne verrouillent rien.
**Mesure** : trois refus consecutifs dans le flux de console, puis le bon
mot de passe — il est accepte, alors qu'une vraie machine aurait bloque
la ligne pendant `admin-lockout-duration` (60 s par defaut).
**Report** : donner une cle a la console (`console`, ou le nom du compte)
n'est pas un detail — le vrai FortiOS verrouille le COMPTE et non la
source, donc aligner le simulateur veut dire changer l'index du compteur
pour tout le monde, SSH et telnet compris, et verifier que le compte
`admin` ne peut pas etre verrouille depuis l'exterieur au point qu'on ne
puisse plus entrer par la console. Sujet en soi.

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

### [dhcp] la sonde d'avant-offre est un ARP, la vraie est un ICMP
Les trois serveurs sondent désormais l'adresse avant de l'offrir, mais
par une requête ARP — alors qu'IOS, ISC et Windows envoient tous un ICMP
Echo. La différence est observable : une machine qui répond à l'ARP mais
laisse tomber l'ICMP (pare-feu local) est vue OCCUPÉE ici et LIBRE sur
une vraie machine.
**Mesure** : `addressAnswersOnLink` émet une requête ARP et relit la
table ; aucun paquet ICMP ne part.
**Report** : un aller-retour ICMP synchrone demande que le voisin soit
déjà résolu — donc un ARP d'abord de toute façon —, et un hôte qui
répond à l'ARP est présent, ce que la sonde cherche. Écrire l'ICMP par
dessus n'ajouterait que le cas du pare-feu local, au prix d'un émetteur
ICMP synchrone qui n'existe sur aucun des trois serveurs.

### [dhcp] `ping-check` : la valeur PAR DÉFAUT d'ISC n'est pas attestée
`ping-check` est lu, honoré, et vaut **faux** par défaut ici. Aucune
source lisible depuis ce réseau ne dit ce que vaut le défaut d'ISC : le
manuel de `dhcpd.conf` n'est pas joignable (proxy), et les deux réponses
trouvées se contredisent — un article de la base de connaissances d'ISC
laisse entendre que la 4.4 le fait par défaut, tandis que chaque guide
d'administration écrit `ping-check true;` explicitement, ce qui suggère
l'inverse.
**Mesure** : `dhcpd.conf` livré par Debian ne contient pas la directive.
**Report** : trancher demande le manuel ou une vraie machine ; le défaut
retenu est écrit dans `docs/PRD-Manquements.md` §M6 plutôt que tu.

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

### [dhcp] le client de ce simulateur ne sait pas faire SA propre mise à jour DNS
Le serveur applique désormais la règle de la RFC 4702 (PTR toujours, A
selon le drapeau S), mais le client pose toujours S=1 — « serveur, fais
le A pour moi » — parce qu'il n'a aucun moyen de l'enregistrer lui-même.
Un vrai client Windows pose S=0 et enregistre son A par une mise à jour
dynamique DNS.
**Mesure** : la branche S=0 du serveur n'est atteignable que par un
client étranger fabriqué par la sonde ; aucune machine de ce dépôt ne
l'emprunte.
**Report** : demande un client de mise à jour dynamique (RFC 2136) côté
hôte, que ce dépôt n'a nulle part — `PrimaryZoneAgent.applyUpdate`
existe côté serveur, mais rien ne l'atteint par le fil.

## Outillage

### [typecheck] 347 erreurs de type au compteur
`npm run typecheck` (ajouté) en compte 347, presque toutes dans les
tests : arguments de `DeviceType` passés à l'envers, `MACAddress` là où
un nombre est attendu, signatures de constructeur périmées.
**Mesure** : `npm run typecheck 2>&1 | grep -c "error TS"`.
**Report** : dette réelle mais indépendante ; la règle en vigueur est
« pas plus qu'avant ta modification », pas « zéro ».

## Journal des entrées fermées

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

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

### [mac-limit] deux lignes pour un seul réglage
`mac-limit maximum 5` puis `mac-limit maximum 5 vlan 10` se rendent tous
les deux, alors que VRP remplace le premier par le second.
**Mesure** : les deux lignes apparaissent dans `display this`.
**Report** : défaut général du magasin de texte par interface (`ifCfg`),
qui empile au lieu de remplacer — il touche toute la vue interface, pas
seulement `mac-limit`.

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

### [ospf] la base de donnees OSPF du pare-feu reste VIDE
Un FortiGate forme une adjacence complete avec un routeur Cisco — les Hello
traversent vraiment, l'etat atteint `Full` des deux cotes, et le ROUTEUR
apprend les reseaux du pare-feu. L'inverse n'a pas lieu : la base du
pare-feu ne contient AUCUN LSA, pas meme le sien, `runSPF()` rend une liste
vide et `get router info routing-table ospf` ne montre jamais de route
apprise. L'echange de bases (DD / LSR / LSU) n'a donc pas lieu de ce cote.
**Mesure** : deux routeurs Cisco s'echangent `O* 0.0.0.0/0` par
`default-information originate always` ; le meme laboratoire avec un
FortiGate a la place du second n'installe rien, et
`getOspf().getLSDB().routerLSAs` est vide.
**Report** : c'est la moitie « base de donnees » d'OSPF sur le pare-feu, pas
un reglage manquant — l'etape 4 du TP 19 (apprendre la route par defaut en
`O*E2`) en depend entierement.

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

### [transport] le pare-feu n'a AUCUNE couche de socket UDP
`Firewall` porte une pile TCP (`getTcpStack()`), s'en sert pour BGP, le
portail captif, la CLI et desormais l'inspection profonde — mais rien
cote UDP : le client DNS fabrique et observe des paquets IPv4 bruts, et
il n'existe ni `udpBind` ni `sendUdpDatagramTo`. Consequence directe :
`TftpClientSession` (reel, et deja utilise par Cisco) ne peut pas
tourner sur un FortiGate, donc `execute vpn certificate local export
tftp` refuse en nommant la brique au lieu de transferer.
**Mesure** : `grep -rn "udpBind" src/network/devices/firewall` ne rend
rien ; `execute vpn certificate local export tftp Fortinet_CA_SSL f.cer
192.168.10.10` repond « no UDP socket layer ».
**Report** : c'est une couche de transport a ecrire, pas une commande ;
elle debloquerait aussi un vrai client NTP et le transfert de
configuration.

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

### [dhcp] une machine Linux ne peut pas SERVIR le DHCP
`new DHCPServer` n'est instancié que par `Router`, `Switch`,
`WindowsDhcpServerRole` et le pare-feu. Un `LinuxServer` n'a ni `dhcpd`,
ni `/etc/dhcp/dhcpd.conf`, ni unité `isc-dhcp-server`.
**Mesure** : le cas « serveur générique (Linux) » de
`routeur-adresse-par-dhcp.test.ts` a dû être remplacé par un commutateur
de niveau 3.
**Report** : demande un vrai démon `dhcpd` (fichier de configuration lu,
unité systemd, journal) — la brique serveur existe, c'est l'enveloppe
Linux qui manque.

### [dhcp] le serveur n'écarte que SES PROPRES adresses, pas celles d'un squatteur
Un serveur ne propose plus une adresse qu'il porte lui-même
(`setServerOwnedAddresses`, alimenté par `Router` et par le rôle
Windows). Ce qui reste absent est le cas général : une adresse de la
plage occupée par une machine configurée en statique. Le vrai IOS la
teste par deux pings avant de l'offrir.
**Mesure** : un pool couvrant l'adresse du serveur ne la distribue plus ;
une adresse tenue par un tiers l'est encore.
**Report** : demande un aller-retour ICMP synchrone dans le chemin
d'offre. `isAddressInUse` existe dans `DhcpServerExchange` et n'est
consulté que si `ip dhcp ping packets` > 0, réglage qui n'a pas
d'équivalent Windows.

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

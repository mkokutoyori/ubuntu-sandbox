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

### [dhcp] pas de détection de conflit d'adresse côté serveur
Un pool qui couvre l'adresse du serveur lui-même la propose : les
laboratoires doivent poser `ip dhcp excluded-address`. Le vrai IOS teste
l'adresse par deux pings avant de l'offrir.
**Mesure** : sans `excluded-address`, le client reçoit `192.168.51.1`,
l'adresse du serveur.
**Report** : demande un aller-retour ICMP synchrone dans le chemin
d'offre ; `setAddressConflictChecker` existe côté CLIENT et n'a pas de
pendant côté serveur.

### [dhcp] Windows : le basculement et l'export restent absents
`Add-DhcpServerv4Failover`, `Get-DhcpServerv4Failover`,
`Export-DhcpServer`/`Import-DhcpServer`, `Get-DhcpServerv4Binding` et
`Set-DhcpServerv4DnsSetting` ne sont pas déclarés.
**Mesure** : le module compte 20 applets ; ces cinq familles n'y sont
pas.
**Report** : le basculement demande un second serveur et un protocole de
synchronisation entre les deux — un sujet en soi, pas une applet de plus.

## Outillage

### [typecheck] 347 erreurs de type au compteur
`npm run typecheck` (ajouté) en compte 347, presque toutes dans les
tests : arguments de `DeviceType` passés à l'envers, `MACAddress` là où
un nombre est attendu, signatures de constructeur périmées.
**Mesure** : `npm run typecheck 2>&1 | grep -c "error TS"`.
**Report** : dette réelle mais indépendante ; la règle en vigueur est
« pas plus qu'avant ta modification », pas « zéro ».

## Journal des entrées fermées

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

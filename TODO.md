# TODO — manquements mesurés, non encore fermés

Un manquement n'entre ici que s'il a été **mesuré** : commande tapée,
état relu, écart constaté. Chaque entrée dit *ce qui est cassé*, *comment
on l'a vu*, et *pourquoi ce n'est pas fermé*. Une entrée fermée est
retirée d'ici et racontée dans son message de commit, jamais dans le
code (`CLAUDE.md` : le code ne porte pas de commentaire).

Format : `[famille] intitulé` puis constat / mesure / raison du report.

---

## Commutateur Huawei (VRP)

### [acl] VRP n'a pas d'ACL IPv6, et `acl ipv6` est refusee
`acl ipv6 name <nom>` rangeait la liste dans le magasin **IPv4** avec le
type `extended`, sous une invite annoncant `acl-adv-<nom>` — donc une
ACL IPv6 qui n'en etait pas une. Elle ne pouvait meme pas recevoir de
regle : l'analyseur de `rule` valide en IPv4 et refuse
`2001:db8::/64`. La commande est desormais REFUSEE en nommant ce qui
manque (`AUDIT-ACL-IPV6.md`, V-10).
**Mesure** : `acl ipv6 name V6` puis `rule 5 permit tcp source any …`
— la liste apparaissait dans `_aclFind('V6')` (magasin v4) et
`getIpv6AccessLists()` restait vide.
**Ce qui manque, dans cet ordre** : une liaison de plan de donnees
(`HuaweiRouter` ne surcharge pas `getIpv6TrafficFilter`), puis
`traffic-filter ipv6 inbound`, puis une table de regles ACL6 et son
analyseur d'operandes IPv6, puis l'invite `acl6-basic-`/`acl6-adv-` et
`display acl ipv6`. La liaison d'abord : construire la table en premier
donnerait un magasin que personne ne lit, ce qui est le defaut que les
cinq audits ACL referment.
**Nuance assumee** (`CLAUDE.md` §6) : une commande qu'une vraie machine
accepte peut etre STOCKEE plutot que refusee pour qu'un import de
topologie ne la perde pas. Ici elle est refusee, parce qu'aucune regle
ne pouvait etre stockee de toute facon — il n'y a donc pas de
configuration a perdre, et l'accepter reconduirait le mensonge.

### [acl] le drapeau `ipv6` de `analyserAcl` est supprime
Il etait pose par la grammaire et lu par PERSONNE, ce qui est
exactement comment `acl ipv6` a pu creer une liste IPv4 sans que rien
ne le signale. Retire avec la refutation ci-dessus.


## Diagnostic reseau

### [traceroute] le MODE de sonde est analyse, documente, et jamais honore
MESURE, depuis un PC Linux vers l'adresse d'une interface distante du
pare-feu (deux sauts reels : le routeur puis le pare-feu) :

    traceroute -I  (ICMP)      1 192.168.1.1   2 192.168.20.2   JUSTE
    traceroute -T  (TCP)       1 192.168.20.2                   UN SEUL SAUT
    traceroute -U  (UDP)       * * *                            RIEN
    traceroute     (defaut)    * * *                            RIEN
    tracert (Windows)          1 192.168.1.1   2 192.168.20.2   JUSTE

Le mode par DEFAUT du `traceroute` de Linux ne rend rien, et c'est celui
que tout le monde tape.

LA CAUSE est structurelle et se lit dans la signature :
`LinuxNetKernel.traceroute(target, maxHops, probesPerHop, firstTtl,
timeoutMs)` — AUCUN parametre de methode. Le moteur ne peut donc pas
distinguer ICMP d'UDP ni de TCP. Les drapeaux `-I`, `-U`, `-T` sont
analyses (`parsed.method`), decrits dans l'aide (« Use TCP SYN for
probes »), et n'atteignent jamais la sonde. C'est le §6 : toute
l'apparence d'exister, sauf l'effet.

TROIS CONSEQUENCES, toutes mesurees :

1. `-T` rend UN saut vers une destination qui en compte deux : il saute
   le routeur. Un vrai traceroute TCP sonde par TTL croissant et voit
   chaque saut.

2. Le mode UDP est decide par un ORACLE EN MEMOIRE, pas par le fil :
   `tracerouteUdpDenied` appelle `transitUdpAclVerdict`, qui parcourt les
   equipements et rend un verdict sans qu'aucun datagramme parte. Les
   `sendUdpProbe` emis ensuite sont DECORATIFS — les sauts sont deja
   calcules. C'est le §4.

3. Quand la sonde ne rend rien, le code FABRIQUE des sauts : hop 1 =
   la passerelle par defaut avec un RTT invente de 1 ms, puis des
   `* * *`. Une sortie de diagnostic inventee est pire qu'une absence de
   reponse, parce qu'elle se lit comme une mesure.

MEME FAMILLE QUE `isPathReachable`, ferme par
`probe-acces-admin-meme-verdict-partout.test.ts` : le client Linux decide
hors du fil, par un parcours de la topologie en memoire. Ici l'oracle
s'appelle `transitUdpAclVerdict` et vit dans le meme fichier
(`HostLookup.ts`).

CE QU'IL FAUT : que `traceroute` emette de VRAIES sondes a TTL croissant,
du type demande, et lise les ICMP time-exceeded et port-unreachable qui
reviennent. `Router.decrementForForwarding` et `IcmpErrors` portent deja
la regle du TTL et la generation des erreurs ; il s'agit de les faire
travailler, pas d'en ecrire une seconde.

## Pare-feu FortiGate

### [fortios] un refus d'`allowaccess` route est BAVARD
Sous-produit du lot qui a ferme l'incoherence Windows/Linux. Sur le
segment propre de l'interface, un `ssh` vers une interface qui ne
l'autorise pas rend `Connection timed out` — un silence, la forme que
`fortios-acces-ssh-admin.test.ts` decrit comme juste (« il n'obtient
aucun refus, il n'obtient rien »). Le meme refus, atteint par ROUTAGE
depuis un autre segment, a longtemps rendu `No route to host`. Depuis
que le parcours d'accessibilite trouve les adresses de l'equipement
atteint, ce cas-la rend bien un silence ; reste a verifier qu'aucun
autre chemin ne produit encore un refus bavard.

### [windows] un poste Windows ne route pas quand sa passerelle est le pare-feu
MESURE :

    Linux,   defaut 192.168.1.99 (pare-feu)  -> ping 192.168.20.2  RECU
    Windows, defaut 192.168.1.99 (pare-feu)  -> ping 192.168.20.2  General failure

Meme maquette, meme passerelle, deux hotes, deux reponses. Avec un
ROUTEUR comme passerelle, les deux passent — `netsh interface ip set
address ... static <ip> <masque> <routeur>` installe bien la route. Le
cas fautif est donc etroit : la passerelle est le PARE-FEU.

### [fortios] `session-ttl default never` : le rendu d'une session sans echeance n'est pas atteste
`set default never` est accepte et EVALUE : la session recoit une echeance
infinie et la minuterie de vieillissement ne l'arme pas. Ce que
`diagnose sys session list` affiche alors dans `timeout=` et `expire=`
n'a pas pu etre lu : docs.fortinet.com, community.fortinet.com et
help.fortinet.com sont refuses par le proxy de cet environnement. Le
simulateur ecrit `never` dans les deux champs ; c'est un choix, pas une
transcription.

### [fortios] seul l'assistant de session `ftp` agit
`config system session-helper` porte la table d'usine de FortiOS (vingt
entrees, source : un `show full-configuration` FortiOS 5.04 publie dans
Azure/Azure-vpn-config-samples) et c'est elle qui dit ou l'assistant FTP
ecoute. Les dix-neuf autres noms (pptp, h323, ras, tns, tftp, rtsp, mms,
pmap, sip, dns-udp, rsh, dcerpc, mgcp, ...) sont acceptes et affiches
comme sur un vrai boitier, mais n'ouvrent aucune connexion attendue : un
flux TNS redirige, un canal TFTP de donnees ou une session SIP media
restent soumis a la politique comme n'importe quel flux. C'est le cote
sur (un assistant ELARGIT ce qui passe), mais une maquette qui compte sur
eux echouera.

## Pile TCP/IP

### [horloge] des piles de protocole lisent l'heure globale, pas celle de leur machine
**Mesure** : les lecteurs bruts `Date.now()` / `new Date()` ont ete remplaces
par `simulationNowMs()` / `simulationDate()` (une seule lecture : l'heure de
l'ordonnanceur et le temps passe sur le fil), mais une machine dont on a pose
l'horloge (`date -s`, `Set-Date`, `clock set`) n'est lue par sa propre pile
que pour Kerberos (KDC, client, verification d'AP-REQ), TCP (`TcpStack.nowMs`),
le systeme de fichiers, le journal, les processus, les services, les comptes,
l'audit et l'agent NTP (qui lit ET discipline l'horloge de sa machine). La verification de certificat de `curl`, d'`openssl s_client`, du
moteur `openssl` (delivrance, `verify`, `-checkend`, `s_server -Verify`), de
rsyslog (gtls/ossl), de `ldapsearch`, du DNS sur TLS et de NTS pour chronyd
suit maintenant l'horloge de sa machine, comme l'authentification IKE par
certificat de Cisco et l'inspection SSL du pare-feu. Le verificateur de certificats clients de nginx/Apache et leur journal d'acces aussi. Les caches DNS du poste Windows, de BIND et de `systemd-resolved` vieillissent sur
l'horloge de leur machine. Les fenetres de signature DNSSEC de BIND, de `systemd-resolved` et de Windows
Server, la validite des certificats utilisateur de sshd et `ssh-keygen` aussi.
Les sessions SSH suivent aussi l'horloge de leur machine : `who`, `last`, `lastlog`,
la pile PAM (`chage -E`, vieillissement des mots de passe), les comptes des
routeurs/switchs/pare-feu, les comptes Windows, le registre VTY, la comptabilite
d'exec et les timers systemd. Les evenements du bus de sshd (`timestamp`) suivent la machine aussi ; la duree
d'`SshShellSession` reste sur l'heure globale (un ecart, donc monotone, a juste titre). Le `START` de `ps` des processus de demarrage et les dates de
`last` / `who` (enregistrements utmp) gardent l'heure reelle apres `date -s` ;
sur un vrai noyau `ps` suit (btime recalcule), `last` non.
**Pourquoi ce n'est pas ferme** : chaque pile prend l'horloge de sa machine par
un port etroit (`TcpStack.nowMs` est celui que Kerberos a pris) ; TLS,
DNSSEC et PKI construisent leurs sessions loin de la machine (configuration
passee de proche en proche) et demandent le meme port.

### [ntp] seuils de panique des agents ntpd, glissement de chronyd par mise a jour, `clock datetime` Huawei
**Mesure** (lab NTP, horloges decalees apres synchronisation) : l'agent lit
desormais l'horloge de la machine et la discipline. Restent trois ecarts
connus, tous mesures sur le laboratoire :
1. Les agents Cisco et Huawei gardent le seuil de panique de ntpd (1000 s) et
   W32Time celui de `MaxPosPhaseCorrection` (54000 s) : une machine decalee
   de plusieurs annees reste non synchronisee, avec `loopfilter state is
   'PANIC'`. Que IOS et VRP appliquent le seuil de ntpd n'est pas atteste
   depuis ce reseau (`cisco.com` et `support.huawei.com` sont bloques).
2. chronyd corrige un decalage par glissement a `maxslewrate` (83333 ppm par
   defaut) CONTINUEMENT ; l'agent applique `debit x temps ecoule` a chaque
   mise a jour. Sur 1 h le total est le meme, la courbe est en marches. Et
   sur un saut d'horloge externe chronyd detecte le saut et REMET A ZERO ses
   sources (`LCL_NotifyExternalTimeStep`, changement `LCL_ChangeUnknownStep`),
   alors que l'agent re-exprime les mesures deja prises dans la nouvelle
   horloge : meme resultat a terme, delai de reconvergence different.
3. `clock datetime HH:MM:SS YYYY-MM-DD` est interprete comme de l'UTC
   (`vrpDatetimeToEpochMs`), alors que VRP lit l'heure dans le fuseau
   configure (le mot-cle `utc` existe pour l'UTC). Non corrige faute de
   documentation joignable ; une sonde existante (`probe-horloge-suit-son-equipement`)
   pose le comportement actuel en contrat.
**Pourquoi ce n'est pas ferme** : (1) et (3) demandent une source que ce
reseau ne joint pas ; (2) demande de passer le glissement du pas de mise a
jour a un taux continu sur l'ordonnanceur, et de decider quoi faire des
echantillons au saut externe.

### [windows] `quser` est inconnu ; libelles d'erreur de `tzutil` et `eventcreate` non attestes
**Mesure** : `quser` repond « not recognized » sur une machine Windows simulee. `tzutil /g|/l|/s` et
`eventcreate` existent maintenant, sur le fuseau de l'identite (celui de `Set-TimeZone`) et sur le journal
que lisent `Get-EventLog` et `wevtutil`.
**Pourquoi ce n'est pas ferme** : `quser` demande une table de sessions interactives avec heure d'ouverture
(`RdpSessionTable` n'en porte pas) et une mise en page en colonnes qu'aucune transcription ici ne donne.
Les phrases `TZUTIL: Invalid time zone X.` et `TZUTIL: Invalid number of arguments for /s.` viennent d'un
compte rendu secondaire, pas d'une transcription ; les refus d'`eventcreate` (`Invalid Argument/Option`,
`option is required`) suivent la famille des messages `ERROR:` de Windows sans transcription non plus ;
`Write-EventLog` dans un journal inconnu garde le libelle du fournisseur (`Cannot open log`), la vraie
machine dit que le nom de source n'existe pas. `tzutil /s` n'accepte pas le suffixe `_dstoff`, `tzutil /?`
et `eventcreate /?` ne sont pas ecrits (texte d'aide non source), `eventcreate /s` (journal distant) est
refuse, la table des fuseaux Windows ne porte que 17 entrees, et ni `tzutil /s` ni `eventcreate` ne
verifient l'elevation (`Set-TimeZone` non plus).

### [persistance] ce que la sauvegarde ne sait toujours pas ecrire, et une configuration modifiee ecrite en entier
**Mesure** : (1) un `CiscoRouter` modifie ecrit tout son `running-config` (environ 600 octets) au lieu des
lignes qui different du jumeau d'usine ; les MAC des ports sont ecrites pour chaque equipement (65 octets par
port). (2) Oracle : voyagent les comptes, roles, profils, privileges (systeme, objet, role, colonne), tablespaces,
parametres, tables (Data Pump) et vues, sequences, index, synonymes, triggers, procedures, fonctions, paquetages ;
ne voyagent pas les vues materialisees, liens de base, repertoires, types objet, taches DBMS_SCHEDULER,
commentaires, politiques d'audit, VPD/RLS, TDE, Data Vault, partitions de tables (Data Pump ne les porte pas),
ni les donnees d'une table temporaire. (3) Windows Server : seuls les roles installes, les zones DNS et les
etendues DHCP IPv4 voyagent, ainsi que l'annuaire de chaque controleur de domaine (racine de foret, domaine
enfant, controleur supplementaire : la promotion est rejouee en local, puis le delta de l'annuaire contre un
jumeau promu ou, pour un controleur supplementaire, contre l'annuaire vivant de son controleur principal ; objets,
mots de passe, GPO, schema, ACL, sites, fonctionnalites optionnelles, proprietaires FSMO de foret ; les approbations sont des
entrees des deux annuaires) ; voyagent aussi les postes joints (appartenance, comptes de service, etat client de la
strategie de groupe) et la politique locale de comptes et d'audit ; ne voyagent pas la session de logon de domaine
ni le cache de tickets Kerberos (transitoires) ; voyage l'etat de replication (identite d'invocation, vecteur de
hauts niveaux, options NTDS, journal et compteurs) ainsi que le niveau fonctionnel de domaine (attribut
msDS-Behavior-Version de la racine du domaine, replique) ; voyagent aussi IIS (sites, pools d'applications,
liaisons HTTPS) et les certificats d'une machine Windows (magasin personnel avec cle privee, ancres de confiance,
identites TLS RDP et LDAP, en PEM via les codecs de pki/pem.ts) ; l'autorite ADCS d'entreprise et ce qu'elle a emis (PEM, adoptee par
CertificateAuthority.fromKeyPair) ; la revocation n'est pas ecrite, le role n'en expose aucune ; NPS (clients RADIUS et secret partage, strategies
reseau et de demande de connexion, comptabilite SQL avec ses enregistrements) et les mots de passe des comptes
locaux ; WSUS, impression,
cluster, Exchange, DHCP v6 et le vieillissement DNS n'ont aucun etat sauvegarde.
**Pourquoi ce n'est pas ferme** : (1) le texte de configuration est rejoue par la CLI dans l'ordre ; un extrait par
difference de lignes casserait les dependances (`interface` puis ses sous-commandes, negations) : il faut un diff
par bloc de mode. (2) Chaque famille d'objets Oracle demande une section dans `OracleStateDelta.ts` (une entree,
un enumerateur sur le catalogue et sa restitution). (3) Chaque role Windows demande un `RolePersister`
(`src/store/windowsServerRoles.ts`).

### [persistance] PkiCaRegistry : un singleton de processus que ni la sauvegarde ni l'import ne touchent
**Mesure** : lecture du code, effet non mesure. `getOrCreateCA(cle)` (trustpoints Cisco, DNS sur TLS, EAP-TLS) range
les autorites par cle dans une table de module : une reouverture dans un meme processus reutilise l'autorite
precedente, un chargement de page neuf en fabrique une autre avec une autre cle, sans que les certificats deja
emis a des routeurs (enrolement) cessent d'exister dans leur configuration. Un routeur qui s'enrole de nouveau
aupres de « la meme » AC obtiendrait un certificat d'un emetteur different de celui de ses voisins.
**Pourquoi ce n'est pas ferme** : il faut d'abord mesurer ce que la configuration d'un routeur ecrit de son
enrolement, puis decider si l'autorite se sauvegarde avec le premier appareil qui l'a creee (comme l'ADCS) ou
dans une section de topologie propre ; le choix change le format du fichier.

### [oracle] fonctions de paquetage non evaluees en SQL, ALTER TRIGGER refuse, FORCE sans effet, synonymes hors DML
**Mesure** : `SELECT scott.pkg_lab.g FROM dual` rend NULL pour une fonction de paquetage dont le corps rend 7, et
`pkg.g()` est refuse par l'analyseur. `ALTER TRIGGER scott.t DISABLE` rend `Unsupported ALTER target: TRIGGER`.
`CREATE FORCE VIEW` est lu mais jamais evalue : une vue sur une table absente est toujours creee, sans l'ORA-00942
du `NOFORCE` par defaut. Les synonymes sont resolus par SELECT, INSERT, UPDATE, DELETE et MERGE ; ils ne le sont
pas encore pour les sequences (`scott.syn_seq.NEXTVAL`), les procedures et fonctions (`EXEC syn_proc`), `TRUNCATE`,
`LOCK TABLE`, `DESCRIBE`, `GRANT ... ON synonyme` ni `COMMENT ON`.
**Pourquoi ce n'est pas ferme** : chacun est un point d'entree distinct de l'executeur (resolution des sequences,
des unites stockees, des commandes SQL*Plus) a brancher sur `followSynonyms` ; l'appel d'une fonction de paquetage
depuis une expression SQL est un changement d'evaluation a part entiere.

### [oracle] le calendrier du Scheduler ne couvre que FREQ, INTERVAL et les BY* courants
**Mesure** : `repeat_interval` evalue FREQ, INTERVAL, BYMONTH, BYMONTHDAY, BYDAY (avec rang : `-1FRI`), BYHOUR,
BYMINUTE et BYSECOND dans le fuseau du serveur. `BYSETPOS`, `BYWEEKNO`, `BYYEARDAY`, `BYDATE`, `INCLUDE` /
`EXCLUDE`, `SCHEDULE_NAME` (calendriers enregistres) et les `*` composes sont refuses avec ORA-27419, faute de
pouvoir les evaluer.
**Pourquoi ce n'est pas ferme** : le texte exact de l'erreur de syntaxe d'un `repeat_interval` n'est pas
atteignable ici (ORA-27419 dit « impossible de determiner une date d'execution valide » et sert aux deux cas) ;
les cles restantes demandent chacune un evaluateur de plus dans `CalendarExpression`.

### [oracle] `CAST` vers INTERVAL / RAW / LOB et `TO_TIMESTAMP_TZ`
**Mesure** : `CAST(x AS DATE|TIMESTAMP|TIMESTAMP WITH TIME ZONE|NUMBER|VARCHAR2)` s'evalue maintenant ;
`CAST(x AS INTERVAL DAY TO SECOND)` et vers `RAW` / `CLOB` repondent ORA-00902, et `TO_TIMESTAMP_TZ`,
`TO_DSINTERVAL`, `AT TIME ZONE` sont inconnus.
**Pourquoi ce n'est pas ferme** : le moteur n'a pas de type intervalle (une chaine `n UNIT`) ni de TIMESTAMP
WITH TIME ZONE autrement que comme chaine `... +hh:mm`.

### [horloge] le temps de vol des trames s'ajoute a l'horloge de simulation
**Mesure** : `PathClock.horizon()` est le maximum des arrivees et ne redescend
jamais ; `schedulerWallClock` et `simulationNowMs` l'ajoutent a l'heure de
l'ordonnanceur. Pendant un `SimulationClock.advance(45 min)` sur un lot de cinq
equipements, l'horloge du Windows a avance de 45 min + 35 ms : le bavardage
STP/ARP fait croitre l'horizon de quelques dizaines de µs par trame.
**Pourquoi ce n'est pas ferme** : l'horizon est ce qui donne des RTT non nuls
sans file d'attente. Essai mesure : le faire decroitre de ce que l'ordonnanceur
avance entre deux lectures (temps de vol « absorbe ») fait que `advance(1 h)`
apres un echange vaut exactement 1 h, mais 9 sondes d'age de route
(`probe-route-ages-device-clock`) tombent : une route apprise a l'arrivee de la
trame, 25 s avant, affiche 00:00:24. Les echanges etant synchrones et finis
avant l'appel a `advance`, le temps de vol precede causalement l'attente : le
modele additif est le bon pour une trame DEJA livree, et l'absorption ne serait
juste que pour une trame encore en vol PENDANT l'avance, ce que la livraison
synchrone ne produit pas. L'ecart de 35 ms sur 45 min est donc cause, pas
defaut ; ne ferme que si la livraison devient asynchrone.

### [ip] l'option Timestamp : ce que les extremites non Linux ecrivent n'est pas atteste
L'option est maintenant reelle de bout en bout : `Ipv4Options` la construit
(`buildTimestampOption`, drapeaux 0/1/3), l'ecrit (`recordTimestamp`,
compteur de depassement, prespecifie) et la lit (`readTimestamp`) ;
`Router`, `SwitchSvi` et `Firewall` l'ecrivent a chaque saut sur LEUR horloge,
`buildEchoReply` la reflechit, `ping -R` / `ping -T` d'iputils (rendu de
`pr_options`) et `ping -r` / `-s` de Windows la construisent et relisent celle de
la reponse. Une machine Linux ecrit comme le noyau (l'emetteur a l'emission et
a la reception, la cible a l'arrivee puis dans la reponse : `ip_options_compile`
+ `ip_options_echo`, net/ipv4/ip_options.c v5.15).

**Ce qui reste, et pourquoi.**
1. Les extremites Windows, Cisco et Huawei gardent la regle de la RFC 1122
   §3.2.2.6 (la cible s'ecrit UNE fois, l'emetteur jamais). Ce qui est atteste
   pour Windows (MicrosoftDocs/windowsserverdocs, ping.md, lu sur
   raw.githubusercontent.com) : `-r` enregistre le chemin de la requete ET de la
   reponse, `-s` l'heure d'arrivee de l'une et de l'autre, de 1 a 9 et de 1 a 4
   sauts ; le texte ne dit pas si l'emetteur ou la cible s'ecrivent deux fois,
   et ne donne aucune sortie. Pour IOS et VRP rien n'est joignable. Une
   transcription de `ping -r` sous Windows ou d'un `ping` etendu IOS avec
   `Record` la trancherait.
2. Le `ping` etendu de Cisco collecte toujours `Loose, Strict, Record,
   Timestamp` sans les construire (entree suivante) : le rendu IOS n'est pas
   attestable.

### [ip] le `ping` etendu collecte `Record` / `Loose` / `Strict` sans les construire
`ExtendedPingParams.routeOptions` porte la reponse au prompt IOS
`Loose, Strict, Record, Timestamp, Verbose[none]:` et la SESSION la
rend ; aucune option n'est posee dans le paquet. Depuis ce lot le
mecanisme existe (`buildRecordRouteOption`, `buildSourceRouteOption`),
donc l'obstacle n'est plus le plan de donnees : c'est le RENDU. IOS
imprime la route collectee sous le resultat du ping, et ni la largeur
des colonnes ni le libelle exact ne sont attestables depuis ce reseau
(le §8 du CLAUDE.md : quand la source est injoignable, on le dit et on
n'implante pas). A rouvrir avec une capture de `ping` etendu reel.

### [ip] le pare-feu n'honore pas le routage par la source, et l'ouvrir le rendrait PLUS permissif
Le commutateur de niveau 3 est FERME (`probe-options-ipv4-commutateur-l3
.test.ts`) : `SwitchSvi` appelle desormais `layers/internet/Ipv4Options
.ts`, note la route, honore les source routes lache et stricte, et
`no ip source-route` y decide par le port etroit
`SviHost.acceptsSourceRouting`. Le pare-feu, lui, reste dehors, et le
laisser dehors est une DECISION plutot qu'un reste :

`Firewall` a son propre pipeline (`classifyIpv4` → `processPipeline` →
`forward`) et achemine aujourd'hui sur le champ destination, en ignorant
l'option. Lui faire honorer une source route le rendrait PLUS permissif
qu'aujourd'hui : un paquet vise sur l'adresse du pare-feu lui-meme
repartirait vers l'interieur au lieu d'etre livre localement. C'est
exactement le contournement que la RFC 1812 §5.3.13.4 decrit — « source
routing may be used to bypass administrative and security controls
within a network [...] Packet filtering can be defeated by source
routing ». La reponse juste est d'implanter le comportement AVEC le
bouton qui le refuse, et le bouton FortiOS correspondant n'est pas
attestable depuis ce reseau : on ne l'invente pas (§8).

L'insertion Record Route, elle, est FERMEE
(`probe-record-route-pare-feu.test.ts`) : elle n'ouvre aucun
contournement — elle ecrit une adresse dans une zone que l'emetteur a
lui-meme reservee — et la RFC 1812 §5.3.13.5 l'exige des routeurs. Le
pare-feu inscrit desormais l'adresse de l'interface par laquelle il EMET,
sur le chemin de TRANSIT seul, ce que la RFC dit (« in forwarded
packets ») : ni les erreurs ICMP qu'il emet, ni les paquets qu'il origine
ne passent par la.

Reste donc UNIQUEMENT le routage par la source, pour la raison ci-dessus.
Aucune sonde n'epingle cette limite comme un contrat : ce serait fermer
la porte au correctif du jour ou la documentation FortiOS sera
atteignable.

## Routeur Cisco (IOS)

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

### [vacl] `match ipv6 address` : refus CORRECT, entree gardee comme garde-fou
Cette entree ne demande RIEN. Elle est ecrite pour empecher qu'on
« corrige » un refus qui est juste.

Les deux plateformes modelisees ici sont un C2960 sous 15.0(2)SE11 et
un C3560 sous 12.2(55)SE12 (`CiscoPlatform.ts`). Le guide de cette
version le dit sans ambiguite :

  « You can configure VLAN maps to match Layer 3 addresses for IPv4
    traffic. »
    (Cisco, 3750-X/3560-X Software Configuration Guide, 12.2(55)SE,
     Configuring Network Security with ACLs)

La clause `match` y prend `ip address` et `mac address`, et rien
d'autre. Le support des cartes de VLAN pour IPv6 apparait sur d'AUTRES
modeles — 3560-CX / 2960-CX sous 15.2(7)E — et est explicitement ABSENT
des 2960-X et 2960-L. L'implanter ici ferait diverger le simulateur du
materiel qu'il declare etre.

**Consequence, correcte elle aussi** : une trame IPv6 traversant un VLAN
filtre n'est evaluee par aucune clause et passe. `vaclPermits` la classe
IP — donc aucune clause MAC ne la regarde, la reference de
`MacAccessList.ts` l'exigeant — puis la transmet, ce qu'une carte ne
sachant matcher que l'IPv4 fait aussi. Le seul changement qui rendrait
cela faux serait de la classer non-IP pour la soumettre aux clauses MAC.

### [vacl] `action` : `capture` et `log` refuses, et c'est VERSION-DEPENDANT
Entree gardee comme garde-fou. La reference de commandes du
3750-X/3560-X en 12.2(55)SE — l'une des deux versions modelisees — donne
a `action` exactement deux mots-cles, `drop` et `forward` : « Neither
`capture` nor `log` are among the accepted keywords ».

**Nuance a ne pas aplatir** : `action drop log` EXISTE sur des versions
Catalyst PLUS RECENTES (2960-XR sous 15.2(6)E le documente, pour la
journalisation des paquets rejetes). Le refus est donc lie a la VERSION
modelisee (`CiscoPlatform.ts` : C2960 en 15.0(2)SE11, C3560 en
12.2(55)SE12) et non a une absence universelle. Si un jour ce fichier
declare une version plus recente, `drop log` devra suivre — et
`capture`, lui, reste un mecanisme de 6500/7600 qui n'a pas de port de
capture ici.
### [vacl] `vlan filter ... interface` : ABSENT du Catalyst, garde-fou
Entree gardee comme garde-fou : elle ne demande rien. J'avais d'abord
ecrit que cette forme « n'etait pas modelisee », en la tirant d'une page
d'IR8340 sous IOS-XE 17. Les guides Catalyst ne connaissent qu'une
forme :

  « vlan filter mapname vlan-list list »
    (Cisco, Catalyst 2960-XR, Configuring VLAN Access Control Lists)

La forme par interface appartient aux routeurs 7600/6500, ou une carte
d'acces peut se poser sur une interface WAN. L'ajouter ici donnerait au
commutateur une commande que son materiel n'a pas.

## Postes Linux

### [sysctl] `/etc/sysctl.conf` n'est pas livre, et les projections de `/proc/sys` sont en lecture seule
Depuis le lot « `sysctl` lit `/proc/sys` », un reste MESURE (le fichier `/etc/sysctl.conf` est livre, copie de celui d'une Ubuntu 24.04 reelle).

**Une projection de `/proc/sys` ne se laisse pas ecrire.** Les
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

### [tcp] deux types pour un segment TCP : `TCPPacket` (core) et `TcpSegment` (pile)
La pile (`tcp/TcpStack`) emet des `TcpSegment` (`sequence`,
`acknowledgement`, `window`, `options`) ; `core/types.ts` declare encore
`TCPPacket` (`sequenceNumber`, `acknowledgementNumber`, `windowSize`),
qu'aucun emetteur reel ne produit. Le pare-feu lit desormais `TcpSegment`
(le renifleur affichait « syn undefined » en lisant l'autre). Restent sur
`TCPPacket` : `nat/rewrite.ts`, `devices/router/NATEngine.ts`,
`router/nat/FtpAlg.ts`, `router/ACLEngine.ts`, `router/Ipv6AclEngine.ts`,
`router/acl/ReflexiveSessions.ts`, `Router.ts`, `EndHost.ts`,
`WindowsPC.ts`, `linux/network/HostLookup.ts`. Ils ne lisent que les
ports et les drapeaux, communs aux deux formes — aucun defaut mesure
aujourd'hui, mais tout nouveau lecteur de numero de sequence ou de fenetre
y lirait `undefined`.
**Pourquoi ce n'est pas ferme ici** : dix fichiers du routeur et de NAT,
hors du sous-systeme corrige ; la migration consiste a supprimer
`TCPPacket` et a faire importer `TcpSegment` partout.

### [fortios] une entree refusee par `next` reste affichee
`config firewall policy` / `edit 62` sans `set service` : `next` repond
« Command fail. Return code -61 / entry not set for "service" », mais
`show firewall policy 62` affiche encore l'entree (sans effet sur le
trafic). Mesure en travaillant la batterie 02, test 94.

### [fortios] `diagnose log test` n'existe pas
La commande repond « unknown command » (batterie 02, test 98). Sur un vrai
FortiGate, elle genere un message de test par type de journal
(« generating a system event message with level - warning », puis virus,
URL, DLP, IPS, trafic, VPN, HA…) et les ecrit dans chaque destination de
journalisation. Seule la premiere ligne a pu etre confirmee (extrait de
recherche) : docs.fortinet.com, community.fortinet.com et les sites qui
citent la sortie complete sont bloques par le proxy de cet environnement.
Non implementee plutot que devinee.

### [fortios] pas de detection d'anomalie de fragments (teardrop)
Batterie 03, test 148 : `hping3 --frag --mtu 8 -1 203.0.113.10 -c 2` a
travers le pare-feu obtient une reponse (le serveur repond), alors qu'un
FortiGate rejette par defaut les fragments superposes/teardrop. Le
pare-feu simule a bien `drop-overlapped-fragment` (defaut disable, non
active par ce test) et `Ipv4Fragmentation.overlaps`, mais aucune detection
d'anomalie de fragments par defaut. Le test reste rouge.

### [apt] ce que l'etat de paquets par machine laisse encore ouvert
`/var/lib/dpkg/status` est desormais l'etat de CHAQUE machine (apt, apt-get,
dpkg -l, apt list, apt-cache le lisent), et `apt install` pose les unites du
paquet puis les demarre. Restent :
- l'unite `named` est livree par l'image de BASE (tous les postes), alors
  que bind9 n'est installe nulle part tant que `apt install bind9` n'a pas
  pose `/etc/bind/named.conf` : `systemctl start named` marche donc sans
  paquet. Une vingtaine de tests demarrent `named` sans `apt install` ;
  retirer l'unite de l'image demande de les faire installer d'abord ;
- deux versions de nginx : le catalogue dit `1.18.0-6ubuntu14.4` (jammy),
  `NGINX_VERSION` (http/nginx/NginxFiles.ts) dit `1.24.0`, que `nginx -v`
  affiche ; un seul des deux doit rester ;
- `apt install` ne demande pas root (un vrai apt refuse : « Could not open
  lock file /var/lib/dpkg/lock-frontend ») ; l'exiger touche tous les
  tests qui installent sans `sudo` ;
- aucune archive n'est modelisee : les lignes de telechargement (« Need to
  get », « Get: », « Fetched ») ne sont pas imprimees, et un paquet ne pose
  que ses unites, ses fichiers de configuration connus et ses comptes.

### [bind9] le jeu de configuration du paquet n'est pose qu'en partie
`apt install bind9` pose `named.conf`, `named.conf.options` et
`named.conf.local`. Le paquet Ubuntu livre aussi `named.conf.default-zones`
(inclus par `named.conf`, avec l'indice racine et les zones `localhost`,
`127/0/255.in-addr.arpa`) et leurs fichiers `db.local`, `db.127`, `db.0`,
`db.255`, `db.empty`, `zones.rfc1918`. `named.conf.options` ne porte que les
directives certaines (`directory`, `dnssec-validation auto`,
`listen-on-v6 { any; }`), sans les commentaires du paquet.
**Pourquoi ce n'est pas ferme** : la source (paquet Ubuntu jammy sur
launchpad.net, ou Debian sur salsa.debian.org) est refusee par le proxy de
cet environnement ; CLAUDE.md §8 interdit de reconstituer un texte non
consulte. A reprendre quand la source est joignable.
**Ecart voisin mesure** : une requete recursive d'un client du reseau local
(`dig @10.0.0.2 localhost` depuis 10.0.0.1) recoit `status: REFUSED` avec
le drapeau `ra` pose ; le `allow-recursion` par defaut de BIND vaut
`localnets; localhost;`, et un refus de recursion ne devrait pas annoncer
`ra`.

### [oracle] un outil client sur un poste provisionne une base locale
`tnsping` et `sqlplus user/pw@hote:port/service`, tapes sur un LinuxPC
(terminal comme `executeCommand`), passent par `getOracleDatabase(id)` du
POSTE : l'arborescence `/u01/app/oracle/...` y est creee et une instance
locale est construite, alors qu'un client Instant Client n'a ni l'une ni
l'autre. `handleTnsping` n'en a besoin que pour reconnaitre le SID local,
et `createSQLPlusSession` que lorsque l'identifiant ne designe pas une
base distante.
**Mesure** : `tnsping 10.0.0.2:1521/ORCL` sur un LinuxPC, puis `ls /u01`
sur ce PC : `app`.
**Pourquoi ce n'est pas ferme** : le correctif qui a relie `executeCommand`
au meme chemin que le terminal ne change pas ce chemin ; le rendre
paresseux touche `createSQLPlusSession`, `handleTnsping` et leurs lecteurs
du SID local.

### [sqlplus] une colonne NUMBER n'a pas la largeur `numwidth`, et FEEDBACK s'affiche des 1 ligne
`SELECT 1 FROM DUAL` rend `1` / `-` / `1` puis « 1 row selected. ». Un
vrai SQL*Plus cadre une colonne NUMBER a droite sur `NUMWIDTH` (10 par
defaut : `         1` sur `----------`), et n'ecrit la ligne de retour
qu'a partir de `SET FEEDBACK` lignes (6 par defaut).
**Mesure** : `echo "SELECT 1 FROM DUAL;" | sqlplus -S system/oracle@10.0.0.2:1521/ORCL`
depuis un LinuxPC.
**Pourquoi ce n'est pas ferme** : releve en passant ; le rendu des
colonnes est partage par tout le moteur SQL*Plus et merite sa propre
mesure.

### [fortigate] l'assistant de session FTP ne couvre que le mode passif sans DNAT
L'assistant `ftp` (lecture de `227`/`229` sur une session vers le port 21,
connexion de donnees admise sous la politique parente et rattachee a la
session de controle) est pose. Il ne couvre pas encore :
- le mode ACTIF (`PORT`/`EPRT`) : le serveur ouvre la connexion de donnees
  vers le client, qu'il faudrait attendre dans l'autre sens et, sous SNAT,
  reecrire l'adresse annoncee ;
- une session de controle traduite en DESTINATION (VIP) : l'adresse privee
  annoncee par `227` devrait etre reecrite et le port de donnees traduit ;
- la table `config system session-helper` en CLI : ses valeurs par defaut
  (numeros, protocoles, ports de chaque assistant) n'ont pas pu etre
  consultees depuis cet environnement ; l'assistant ftp est donc toujours
  actif, comme sur un boitier par defaut, mais ni affiche ni configurable.
**Mesure** : batterie 1, test 28 (PASV sous politique `service "FTP"`),
vert ; batterie 2, test 547 (`curl --no-pasv`) non couvert.

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

### [netadapter] `Set-NetAdapter -VlanID` est REFUSE faute d'etiquetage sur une carte physique
Depuis le lot « une carte reseau est son PORT », `Set-NetAdapter` existe
et `-MacAddress` pose vraiment l'adresse par `Port.setMAC`, c'est-a-dire
le mecanisme que `ip link set … address` emprunte deja. `-VlanID`, lui,
est **refuse en nommant la brique qui manque** plutot que range sans
etre lu.

**Ce qui manque, mesure.** L'etiquetage 802.1Q existe sur cette machine,
mais seulement pour une SOUS-INTERFACE : `EndHost.sendFrame` etiquette
quand le port emetteur est enregistre dans `vlanSubInterfaces`, ce que
`Add-NetLbfoTeamNic` fait pour une interface d'agregation. Ce que
`Set-NetAdapter -VlanID` demande est autre chose : que la carte PHYSIQUE
elle-meme etiquette tout ce qu'elle emet, sans sous-interface. L'ecrire
en enregistrant le port comme sa propre sous-interface fonctionnerait
par accident — `sendFrame` appellerait `Equipment.sendFrame` sur le meme
port — mais compterait la trame deux fois dans la prise de capture, et
serait exactement la fausse reutilisation que ce depot refuse.

**Report.** A fermer avec un vrai etiquetage de port (un `Port.vlanTag`
lu a l'emission et a la reception), qui servirait aussi le pendant
Linux `ip link set eth0 type vlan …` sur une carte sans sous-interface.

---

### [netadapter] `Get-NetAdapter -IncludeHidden` ne rend rien de plus
Le filtre est REEL — `NetAdapterEntry.hidden` est lu par
`selectNetAdapters` — et aucune carte n'est cachee aujourd'hui, donc il
ne change rien de visible. C'est la meme limite que le PRD de la
boucle avait deja ecrite : `Loopback Pseudo-Interface 1` n'est pas un
`Port` de `WindowsPC`, donc l'ajouter ici serait une quatrieme copie
ecrite en dur d'une interface qui n'existe pas, exactement le defaut que
ce PRD venait de refermer. Le moteur historique, supprime, en fabriquait
justement une.

**Report.** A fermer le jour ou `WindowsPC` cree une vraie interface de
bouclage comme `LinuxMachine.createLoopbackPort()` le fait ; elle sera
alors `hidden` et le filtre la rendra sans une ligne de plus.

### [bash] La sortie d'une commande ne porte pas son retour a la ligne final, et la lecture de l'entree standard est une liste blanche
Mesure avec l'invite `^T` de nano (`nano-exec-oracle.test.ts`), qui lance
la commande comme un enfant du shell (`LinuxMachine.runChildShellForEditor`)
et lit la sortie brute :
- `printf abc | cat`, `tr a-z A-Z` ou `cat` sur une entree sans retour a
  la ligne final rendent `abc\n` ; le vrai rend `abc`. Les commandes
  « orientees lignes » (`writesLines`) ou un tube terminent toujours leur
  sortie, et `sort -r` perd les lignes vides finales (« a\n\n » → « a\n »).
- `ls` d'un enfant tient en une seule rangee de colonnes ; le vrai (sortie
  sur un tube) rend un nom par ligne — corrige pour l'enfant seulement
  (`ctx().isPiped`), pas pour un `ls` redirige vers un fichier.
- `od` n'existe pas ; `$HOME` d'un `root` vaut `/home/user`.
- L'entree standard n'atteint que les commandes de `readsStandardInput`
  (`cat wc sort uniq head tail cut base64 dd less more rev nl xxd tac grep
  sed awk tr`) : `{ cmd; } < fichier` ne la transmet a personne, et `cmd < f`
  n'est pris en charge que pour une commande simple.
- Un enfant sans terminal prefixe `command not found` par `bash: line 1: `
  (`childShellRunning`) ; la ligne vaut toujours 1 et les autres erreurs du
  shell (syntaxe, redirection) n'ont pas le prefixe.
**Report** : le modele « la sortie d'une commande est un texte sans
terminateur » est partage par tout le simulateur ; le remplacer par un
flux d'octets avec un terminateur explicite est un lot en soi, et le
corpus `exec` evite ces cas (`EXEC_FILTERS`).

### [vim] Motifs : quelques manquements mesures apres le traducteur `VimRegex`
Mesure avec les labos `vim-pattern-oracle.test.ts` (7661 cas enregistres
sur un vrai vim 9.1) et `vim-pattern-commands-oracle.test.ts` (496) :
- **Retour arriere JavaScript** : `\V\>-\{-2,3}-\|\(b\%(\X\)\@=\|\f\+\_D\{-2,3}\|\L\?\)\{-1,}\(\A\{2,}\K\*\)\{-2,3}\[[:space:]o]\{2}`
  sur un tampon de huit lignes occupe `RegExp.exec` pendant 128 s ; l'automate
  de vim repond sans delai (aucune occurrence). Un motif a quantificateurs
  imbriques ambigus gele donc l'editeur. Le cas est retire du corpus
  (rnd22-202). Pas de borne de temps possible sur un `RegExp` synchrone : il
  faut un second moteur (simulation de Thompson avec priorites) pour les motifs
  sans reference arriere, ou une estimation de la hauteur d'etoile a la
  traduction qui refuse avec E363 comme vim le fait pour sa memoire.
- `\%V` en bloc compte des colonnes de caracteres ; `\@123<=` borne la remontee
  en caracteres ; `[[=e=]]` utilise la decomposition Unicode.

### [vim] Expressions `\=` : ce que `VimExpression` ne fait pas
Mesure avec `vim-substitute-oracle.test.ts` (3860 cas dont 1004 d'expressions) :
- **Ordre des dictionnaires** : l'ordre de `hashtab.c` est porte pour un
  dictionnaire construit sans suppression ; une cle supprimee puis reajoutee
  retrouve sa place d'insertion au lieu de celle de la case libre laissee.
- **Fonctions absentes** : tout nom hors de la table repond `E117: Unknown
  function` meme quand vim le connait (`v:shell_error`, `getenv`...). `reduce`, `mapnew`, `sha256`, `strftime`,
  `json_encode`, `json_decode`, `system` et `systemlist` existent.
- **Variables** : `:let` et `:unlet` existent pour les noms nus, `g:`, `b:`, `w:`,
  `t:`, les elements `l[i]` / `d.k`, les operateurs composes et la
  destructuration. Restent refusees les cibles `$ENV` (l'environnement du
  processus vim n'a pas de poignee d'ecriture), les
  tranches `l[a:b]`, `s:` / `l:` / `a:` hors fonction, `v:shell_error` et
  `:function`. Une lambda ne capture que les parametres des lambdas qui
  l'entourent.
- **`CTRL-R =` et le registre `"=`** ne passent pas par l'evaluateur : le
  moteur n'a ni l'un ni l'autre.
- **Options** : `VimOptionDefaults.ts` porte la valeur de depart des options
  que le moteur ne modelise pas, enregistree par
  `scripts/oracle/record_vim_option_defaults.py` sous `vim -u NONE -N` ; les
  options qui dependent de la machine (`columns`, `shell`, `runtimepath`,
  `viminfo`...) en sont exclues et repondent E113.

### [nano] le repeint incremental de nano 7.2 : des rangees que le tampon ne justifie pas
Mesure avec `nano-attributes-oracle.test.ts` (UNPORTED_CASES : atr3-21,
atr3-47, atr3-101, bar2-2, bar2-41), 5 cas sur 690 enregistres sur nano 7.2
dans tmux :
- **Ligne magique** : un caractere tape sur la derniere ligne (que `PageDown`
  atteint) cree une nouvelle ligne magique en dessous ; nano ne repeint que la
  rangee courante, la rangee de la nouvelle ligne magique reste vide, SANS le
  guide `-J` ni la barre `-q` que la machine y dessine. La machine repeint
  tout l'ecran a chaque touche (`NanoScreen` est sans etat) et ne peut donc pas
  dire quelle rangee nano a oublie de rafraichir.
- **`-S -l` sur une ligne de cinq tranches** : apres `M-\ PageDown C-d BSpace`
  le binaire laisse la rangee de la derniere tranche vide et le curseur colonne 0
  de la rangee suivante.
**Report** : reproduire ces cas demande de porter le suivi des rangees
sales de `edit_refresh` / `update_line` (nano 8.x `winio.c`) et de garder
l'ecran precedent dans le moteur ; le rendu actuel est le repeint complet que
nano ferait apres un `^L`.

### [nano] fichiers nanorc : commandes acceptees mais pas encore evaluees
`parse_rcfile` de nano 7.2 est porte pour `set` / `unset` (toutes les options de
`rcopts`), les emplacements (`/etc/nanorc`, `~/.nanorc`, `$XDG_CONFIG_HOME/nano/nanorc`,
`~/.config/nano/nanorc`, `-f`, `-I`), les textes d'erreur et la fusion avec la ligne
de commande (`nano-rc-oracle.test.ts`, `probe-nano-rc.test.ts`). La vraie machine
ACCEPTE les lignes suivantes ; le moteur les lit sans erreur et sans effet, ce qui
est l'etat intermediaire d'une campagne en cours et non un livrable :
- `bind`, `unbind` (raccourcis reconfigures) : lues sans effet (elles ferment bien une
  syntaxe ouverte, comme dans nano), les touches ne sont jamais reliees. Raccourcis :
  28d. Les douze `*color` d'interface (`nano-colors-oracle.test.ts`), la coloration
  syntaxique (`syntax`, `header`, `color`, `icolor`, `extendsyntax`, `include`, `comment`,
  `tabgives`, `-Y`, `M-Y` ; `nano-syntax-oracle.test.ts`, `probe-nano-syntax.test.ts`),
  `linter` et `formatter` (`^T ^Y`, `^T ^O`, `M-B`, `M-F` ; `probe-nano-lint.test.ts`)
  et `speller` (`-s`, `^T ^S` ; `probe-nano-spell.test.ts`) sont evaluees.
- `matchbrackets`, `whitespace` : valides et rangees dans `NanoSettings`, jamais lues
  parce que `M-]` (crochet correspondant) et `M-P` (blancs visibles) n'existent pas
  encore dans le moteur (28e) ; `magic` reste un mot-cle inconnu, comme dans le nano
  d'Ubuntu (sans libmagic) ; `multibuffer` (`-F`) et `rawsequences` (`-K`).
- `allow_insecure_backup` : n'a d'effet que si l'`unlink` de la sauvegarde existante
  echoue ; la procedure `make_backup_of` (unlink, creation exclusive, repli dans
  `$HOME` avec « Cannot make regular backup », « Trying again in your home directory »)
  n'est pas portee : le moteur ecrase la sauvegarde.

### [nano] linter : un message pour un fichier non ouvert, reponse « oui »
`do_linter` de nano 7.2 demande « This message is for unopened file F, open it in a new
buffer? » quand le linter parle d'un autre fichier existant. La reponse « non » et ^C sont
portees (`probe-nano-lint.test.ts`) ; « oui » ouvre un nouveau tampon, ce que le moteur ne sait
pas faire (tampons multiples, `-F`, `M-<` `M->`) : il agit alors comme « non ». Meme brique que
`^R` en mode vue (entree suivante).

### [machine Linux] `dash` absent
Mesure en ecrivant le linter du paquet nano pour `sh` (`linter dash -n`) : la machine simulee
n'a pas de commande `dash` (Ubuntu en livre une, c'est la cible de `/bin/sh`), de sorte que
`^T ^Y` sur un fichier `.sh` repond « Error invoking 'dash -n' ». `sh -n` et `bash -n`
analysent maintenant sans executer (les lettres d'invocation arrivent a `SHELLOPTS`), mais les
messages d'erreur d'analyse de dash (« t.sh: 3: Syntax error: Unterminated quoted string »)
different de ceux de l'analyseur de bash du simulateur, que `sh` reutilise. Sans une
grammaire d'erreurs propre a dash le linter par defaut des fichiers shell ne parle pas comme
sur Ubuntu.

### [nano] correcteur orthographique INTERNE (`^T ^S` sans `speller`)
Lu dans `do_int_speller` de nano 7.2 (text.c) : sans `speller`, nano lance `hunspell -l` (a defaut
`spell`) dont la sortie passe par `sort` puis `uniq`, lit la liste des mots inconnus et propose
chacun dans `fix_spello` (invite « Edit a replacement », « Replace with », remplacement de toutes
les occurrences, retour au mot suivant). Le moteur repond « Error invoking "spell" » (comme un
Ubuntu nu, le texte est le bon) parce que la machine simulee n'a ni `hunspell` ni `spell` ni
dictionnaire. Il manque deux briques : une commande `hunspell` / `spell` avec un dictionnaire (rien
dans le depot ne porte de liste de mots) et le dialogue `fix_spello`. Le correcteur ALTERNATIF
(`-s PROGRAMME`, `set speller`) est complet.

### [nano] entree litterale (`M-V`) : les saisies numeriques manquent
`M-V` annonce « [ Verbatim Input ] » et insere la touche suivante telle quelle (un caractere, un code de controle
`^A`, Entree `^M`) ; mesure sous tmux sur nano 7.2. Restent les saisies numeriques (trois chiffres octaux, `u` et des
chiffres hexadecimaux) : le binaire affiche « [ Unicode Input: 101 ] » en attendant la suite et la regle qui termine la saisie
n'est pas mesuree.

### [nano] tampons multiples : `-F`, plusieurs fichiers, `M-<` `M->`, `M-F`, `^R` en mode vue
Le moteur n'a qu'un tampon. Ce qui en depend, mesure sur nano 7.2 :
- `^R` sous `-v` ouvre un NOUVEAU tampon : invite « File to read into new buffer [from ./]: »
  (menu `^T Browse`, `M-N No Conversion`) au lieu de « Key is invalid in view mode » ; le moteur
  refuse la touche (`nano-colors-oracle.test.ts`, UNPORTED_CASES col1-67, col1-117, col1-138,
  col1-151, col1-153, col1-169, col2-6, col2-48, col2-58, col3-137, col3-170, col3-190 ; 7 cas
  de `nano-layout-oracle.test.ts`) ;
- `nano a b` : titre `[1/N]`, `M-<` / `M->` pour passer d'un tampon a l'autre, fermeture
  (« Close »), message `[ x -- N lines ]` ; `-F` (`multibuffer`) fait de `^R` une lecture dans
  un nouveau tampon, `M-F` aussi (menu Execute) ; `nano -` lit l'entree standard (« Reading data
  from keyboard ») ;
- le « oui » du linter pour un fichier non ouvert (entree suivante), et les clics de souris qui
  peuvent ouvrir un tampon (`nano-mouse-oracle.test.ts`) ;
- l'aide de l'invite « File to read into new buffer ».
Pas de liste de tampons ni de pile de tampons dans `NanoEngine` : `linesArr`, la marque, l'annulation,
les verrous et la position memorisee sont ceux d'un seul fichier. **Report** : sortir l'etat d'un
fichier dans un objet tampon (`openfile` de nano) que le moteur parcourt en cercle.

### [vim] coller depuis un autre programme (Ctrl+Maj+V, Maj+Inser, clic droit)
Mesure en corrigeant le meme defaut dans nano : `VimEditor` annule chaque touche (`preventDefault`)
et n'a ni gestionnaire `paste` ni moteur de collage, donc rien ne se colle dans vim depuis Notepad.
Dans un vrai terminal le collage arrive comme des frappes (vim 9.1 active le « bracketed paste » :
en mode Insertion le texte est insere tel quel, sans indentation automatique ; en mode Normal il
est insere comme par `p`). Il faut un `applyPaste` dans `VimEngine`, les memes gestes que
`NanoEditor` (`terminal/clipboard.ts`) et une mesure sous tmux du bracketed paste de vim 9.1.0016.

### [nc] ce que le portage de `netcat.c` (Ubuntu 1.226-1ubuntu2) laisse
Mesure avec `netcmds-oracle.test.ts` (corpus `nc-1.226.json`, binaire reel dans un espace de noms) :
- `-x` / `-X` / `-P` (mandataires SOCKS4, SOCKS5, CONNECT) : les controles de `main()` sont portes
  (« no proxy support for listen », « missing closing bracket in proxy »...) mais la connexion par
  mandataire est refusee (`socks.c` non porte). `-F` (passage de descripteur), `-S` (signature MD5 :
  le vrai demande un mot de passe sur le tty, le moteur repond l'erreur sans tty), `-Z` (DCCP : la
  prise echoue en silence, comme sur le noyau d'enregistrement), `-V` (refuse comme sur Linux).
- Deux `nc -l 9000` : `nc` pose SO_REUSEADDR et SO_REUSEPORT, donc le vrai accepte le second
  ecouteur (meme uid) ; `SocketTable.bind` repond EADDRINUSE.
- Les messages `-v` de l'ecoute (« Listening on 0.0.0.0 9000 ») dependent de la resolution inverse
  (`getnameinfo`) : sur la machine d'enregistrement le DNS injoignable donne « nc: getnameinfo:
  Temporary failure in name resolution » pour un joker, donc seul 127.0.0.1 (« localhost », via
  /etc/hosts) est dans le corpus.
- `ncat` est un alias de `nc` dans la declaration de la commande ; c'est l'outil de Nmap, pas
  `netcat-openbsd` (options, messages et `-e` differents).
- `-W` (arret apres N paquets) et `-t` (negociation telnet) : la boucle `readwrite` est portee
  (`converse` dans `Nc.ts` : `-N -q -w -C -i -d`, connexion persistante, ecoute en service unique),
  pas ces deux-la.
- Entree standard du TERMINAL : un `nc host port` tape seul lit le clavier dans un vrai terminal
  (il envoie ce qu'on tape jusqu'a Ctrl-D ou Ctrl-C) ; le terminal simule n'a pas d'entree
  interactive pour une commande, donc `nc` lit la salutation du serveur puis se comporte comme un
  Ctrl-C immediat (indicateur `terminal` de `converse`). Un `nc` en avant-plan alimente par un tube
  (`echo x | nc ...`) reste connecte jusqu'a la fermeture du pair, `-N`, `-q` ou `-w`, comme le vrai.
- Le test d'un `nc -u` vers un port qui ECOUTE mais ne repond jamais ne se termine pas sans `-w`,
  `-q` ou Ctrl-C : c'est la mesure (rc 124 sous `timeout`), pas un defaut.

### [ss] ce que le portage d'iproute2 6.1 laisse
Mesure avec `netcmds-oracle.test.ts` (corpus `ss-iproute2-6.1.json`, 10 labos, 520 des 531 sorties
identiques apres normalisation) :
- `ss -m` : `skmem` est exact au repos et pour les prises de `nc` ; la file d'emission (`w`, `o`) et
  le `tb` auto-regle apres un vrai transfert ne sont pas modelises au-dela des valeurs au repos.
- `net.ipv4.tcp_rmem` / `tcp_wmem` sont stockes, rendus par `sysctl` et lus par `ss -m` ; le
  reglage automatique de la fenetre de reception n'est pas modele.
- Identite de la machine simulee : `/etc/os-release` et `lsb_release` se declarent Ubuntu 22.04.4
  alors que les outils portes suivent les enregistrements d'Ubuntu 24.04 (iproute2 6.1.0, net-tools
  2.10, psmisc 23.7, netcat-openbsd 1.226, procps-ng 4.0.4). `PackageDatabase` et `SS_VERSION` /
  `NET_TOOLS_VERSION` disent deja 24.04 pour ces paquets ; l'identite du systeme, elle, reste a
  trancher (changer la version annoncee decale `uname -r`, apt et les captures existantes). Le
  controle de congestion par defaut est Reno ici, bbr sur la machine d'enregistrement (masque dans
  la comparaison).

### [fuser] ce que le portage de psmisc 23.7 laisse
Mesure avec `netcmds-oracle.test.ts` (corpus `fuser-psmisc-23.7.json`, 179 des 181 sorties identiques
et le labo `fuser-parsing`, 68 pas sur 68) :
- `fuser -k -SIGNAL` : les signaux que `LinuxProcessManager` sait delivrer sont les 12 de son union
  `Signal` ; les autres numeros (1 a 64) sont acceptes comme sur le vrai et recoivent l'action par
  defaut de leur classe (ignore : CHLD, URG, WINCH ; arret : TSTP, TTIN, TTOU ; sinon terminaison),
  pas le comportement propre a chacun (dump de memoire de QUIT/SEGV, par exemple).
- Les deux pas `fuser -vm / 2>&1 | head -3` (labos `fuser-files` et `fuser-files-none`) dependent de
  l'environnement : sur la machine d'enregistrement `/` liste les processus de l'espace de noms
  hote, ici ceux du simulateur. Ils sont declares non portes dans `UNPORTED_STEPS`.

### [UNIX] ce que la table des prises UNIX laisse
Mesure avec `netcmds-oracle.test.ts` (corpus `unix-sockets.json`, 8 labos : flux, ecoute seule, deux clients, datagramme,
datagramme seul, fermeture, machine vide, session `nc -U`) : `ss -x`, `netstat -x`, `/proc/net/unix`, `/proc/<pid>/fd`,
`fuser`, `nc -lU` / `-U` / `-luU` / `-uU` sortent identiques apres normalisation des inodes, sauf :
- `lsof -U`, `lsof <socket>`, `lsof -p` : `lsof` est un petit gabarit sans les colonnes ni les lignes du vrai (4.95) ;
  les sept pas lsof de chaque labo sont declares non portes dans `UNPORTED_STEPS`.
- `nc -l` AU PREMIER PLAN rend la main aussitot (TCP comme UNIX) au lieu de bloquer jusqu'a la fin de la connexion ;
  `timeout 1 nc -lU p; echo $?` rend donc 0 au lieu de 124. Le corriger ferait attendre tout test qui lance `nc -l`
  sans `&` puis se connecte depuis une autre machine.
- `ss -xaE` : refus explicite (« needs a stream of socket events ») ; le vrai n'affiche rien et rend la main.
- `ss -e` d'une prise UNIX dont le pair est parti : la fleche `<->` ne devient pas `<--` / `-->` (aucune mesure faite).
  Mesure faite pour un proprietaire non root : `ss -xlpe` n'affiche pas `uid:` pour une prise UNIX, ce que fait le simulateur.
- Les prises UNIX que posent rsyslog (`/dev/log`, imptcp) et auditd n'ont pas de porteur : elles figurent dans
  `/proc/net/unix` et `ss -x` sans `users:` ni descripteur, parce que leur donner un pid decalerait les numeros de
  descripteur que les tests rsyslog lisent deja.
- `nc -U` tape seul dans le terminal (plan de flux `planNcUnix`) ouvre une prise sans processus.
- `connect()` sur une file d'acceptation pleine (plus de `backlog + 1` connexions en attente) rend EAGAIN ici ; le vrai
  bloque jusqu'a ce que le serveur accepte.

### [umask] ce que le portage de `umask` laisse
Mesure avec `netcmds-oracle.test.ts` (corpus `umask-bash-5.2.json`, 5 labos, 232 pas, bash 5.2.21 sur Ubuntu 24.04) : le
builtin (`-S`, `-p`, octal jusqu'a 07777, mode symbolique, erreurs et codes de retour), sa portee (sous-shell, etage de
tube, `$( )`, `bash -c`, `sudo`), et son effet sur `touch`, `mkdir [-p] [-m]`, les redirections, `mkfifo`, `cp [-p]`,
`install`, `mktemp` et la prise de `nc -lU` sortent identiques apres normalisation, sauf les onze pas du labo
`umask-scopes` declares dans `UNPORTED_STEPS`, qui tiennent tous a la couche des builtins de bash et non a `umask` :
- `builtin umask`, `command -V umask`, `type -a umask`, `help umask`, `enable -n umask`, `which umask`, un `alias umask=…`
  et `/usr/bin/umask` : le simulateur n'a pas de table des builtins (nom, etat active / desactive, aide, resolution
  alias > fonction > builtin > fichier). Chaque commande y est dispatchee sur un `switch` de l'executeur.
- `` `umask 077` `` (mot de commande vide apres la substitution), `trap 'umask' EXIT` (le piege EXIT d'un shell non
  interactif n'est pas execute a la sortie de `bash -c`) et le prefixe `bash: ` des diagnostics d'un shell lance par `bash -c`.
Autres ecarts mesures, non fermes :
- L'umask initial d'un utilisateur non root ouvrant une session SSH ou de connexion n'a pas ete enregistre ; `su` et `sudo` lisent
  maintenant celui que calcule `pam_umask` (0002 pour un groupe prive du meme nom, sinon l'`UMASK` de `login.defs`).
- `exec N> fichier` ouvre le fichier mais la table des descripteurs du shell n'existe pas : `echo x >&N` ne l'atteint pas
  et `ls -l /proc/$$/fd` ne le montre pas.
- `cp` : `-l` et `-s` ne conservent pas les attributs d'un lien cree sur un lien (le seul cas enregistre est un fichier
  regulier). `-i` invite et lit la reponse, `-x` laisse les points de montage de cote, `-Z` est sans objet sans SELinux.

### [ps] ce que le portage de `ps` laisse
Mesure avec `netcmds-oracle.test.ts` (corpus `ps-procps-4.0.4.json`, 5 labos, 629 pas, procps-ng 4.0.4 sur Ubuntu 24.04, pty
de 80 colonnes, noyau d'enregistrement 6.18 Firecracker) : tous les pas sortent identiques apres normalisation sauf les 49
declares dans `UNPORTED_STEPS`, qui se rangent en huit familles (le compte entre parentheses est celui des pas) :
- Etages de tube non simultanes (9 pas, `ps -ef | cat` et variantes) : le vrai liste `cat` (et `grep` dans `ps aux | grep x`)
  car bash cree tous les etages avant d'executer le premier ; l'interpreteur execute les etages l'un apres l'autre et ne
  materialise un processus que pendant la commande qui tourne. Fermer cela demande que `visitPipeline` annonce les etages a
  la table des processus avant le premier (mots deja developpes, un processus par etage, meme groupe), puis que chaque etage
  adopte le sien ; le piege est le developpement d'un mot qui execute une substitution de commande deux fois.
- Environnement (7 pas, `ps e`, `ps ae`, `ps ce`, `ps ef`, `ps -r -e`, `ps -ef -aux`) : `e` affiche maintenant l'environnement exporte
  du processus (herite au `fork`, `VAR=x cmd` ajoute, lisible par le proprietaire et root, `/proc/<pid>/environ` en 0400),
  mais l'ordre des variables d'un vrai bash est celui de sa table de hachage et le texte enregistre est celui du shell du
  labo ; la longueur de `bash /tmp/<labo>.sh` decide aussi de la troncature a 80 colonnes. Le dispositif est mesure par la
  sonde `probe-ps-porte-de-procps.test.ts`, pas par le corpus. L'environnement de pid 1 n'a que `HOME`, `init`, `TERM`
  (le vrai ajoute `BOOT_IMAGE` et `NETWORK_SKIP_ENSLAVED`) et celui d'un service n'a que `LANG`, `PATH`, `INVOCATION_ID`
  (le vrai ajoute `JOURNAL_STREAM`, numero d'inode du socket de journald non modelise).
- Valeurs propres au noyau d'enregistrement (11 pas) : label de securite (`kernel` ici, `unconfined` sur un Ubuntu avec
  AppArmor), chemin de cgroup (`4:memory:/process_api/...`), score OOM, groupes supplementaires (`-` ici, `0` pour root sur un
  noyau habituel), temps CPU cumule des enfants moissonnes du shell du labo (`ps S`, `ps -S`), fautes de page mineures de ce
  shell (5139).
- Ligne de commande du shell du labo (`bash /tmp/<labo>.sh`) contre celle de la machine (`-bash`), qui decide du tri sur
  `args`/`cmd` (`--sort=args`, `--sort=cmd`, `ps O c`) et des colonnes `comm=,args=` sans entete (5 pas).
- Tri sur des grandeurs mesurees (`--sort=time|rss|pcpu|pmem|etime`, `ps O r`, `ps O v`, `ps O Pf`, 8 pas) : deux `sleep`
  du meme labo ont des RSS differents (1668, 1672, 1676) ; les empreintes du simulateur sont constantes par programme, donc
  l'ordre retombe sur le pid.
- Pagination et largeur (4 pas : `--rows 5`, `--lines 5`, `LINES=5`, `COLUMNS=5`) : le nombre d'entetes repetes depend du nombre
  de lignes, et la machine simulee en a 30 de plus que l'espace de noms du labo. Le mecanisme (un entete toutes les
  `screen_rows - 1` lignes, `--headers`) est couvert par la sonde.
- Selections que l'espace de noms rend vides (3 pas : `ps -u -1`, `ps -N -u root`, `ps 5`) : le groupe de processus 1 n'existe
  pas dans l'espace de noms (pid 1 y dirige un groupe du dehors), tous les processus du labo sont a root, et le pid 5 est un
  thread noyau de la machine simulee.
Limites du normaliseur de colonnes (`netCmdsNormalizePs.ts`), pas du simulateur (2 pas) : un entete vide (`-o user=,pid`) decale les
cellules, et un tableau sans entete (`--no-headers -f`, `-o comm=,args=`) ne dit pas quelle cellule est `C` ou `STIME`.
Autres ecarts mesures, non fermes :
- Chiffres memoire : seuls `bash`, `sleep`, `nc` et `ps` ont une empreinte mesuree (VSZ, RSS, TRS, PSS, USS, fautes mineures,
  octets lus) ; les autres programmes ont des proportions (texte = VSZ/12, PSS = RSS/2, USS = RSS/3).
- `pgrep`, `pkill`, `pidof`, `top`, `pstree` et `watch` restent sur `LinuxProcessCommands` (jouet) : ce sont d'autres
  binaires de procps-ng (`pgrep`/`pkill` partagent `pgrep.c`, `top` a son propre ecran) et ils n'ont pas ete rejoues.
- Pas de labo zombie ni de `setsid`/`setpriv` dans le corpus : les etats `Z`, `D`, `t` ne sont pas mesures sur le vrai.
- Le tableau des jobs (`jobs`, `%1`) est global a la machine et non a un shell : un `bash -c` imbrique ne voit pas son
  propre tableau.
- `/dev/pts/N`, `/proc/tty/drivers` et `/proc/sys/kernel/pid_max` n'existent pas comme fichiers : `ps` lit le plafond des
  pids (4194304, colonne de 7 chiffres) dans `PID_MAX` de `LinuxProcessManager`, et le numero de terminal dans
  `ttyDeviceNumber`.

### [lab NTP] ecarts residuels mesures en montant le lab du tutoriel NTP (etape 0)
Mesure en rejouant la section 0 du tutoriel (R-EDGE, SW-CORE, SW-HW, cinq Ubuntu, DC01, PC-WIN), l'exercice 0, puis un
export / reimport JSON. Fermes avec leurs sondes : `ping` / `tracert` du switch Huawei, `shutdown` de `Vlanif` rendu par
`display current-configuration`, port routé Cisco (`no switchport`), netplan multi-fichiers (`routes:`, `nameservers:`,
`match:`, erreurs de grammaire), `sudo NOM=valeur`, route par defaut de `New-NetIPAddress -DefaultGateway`, levee des
interfaces VLAN au rejeu d'un export, serveurs DNS du poste Windows dans le fichier. Restent ouverts :
- `CiscoSwitch` a 24 ports FastEthernet et deux GigabitEthernet0/1-2 la ou le modele du tutoriel (IOSvL2) porte Gi0/0 a
  Gi3/3 : difference de modele materiel, pas un defaut de commande. Le lab nomme ses ports d'apres le simulateur.
- Port routé Cisco : HSRP / VRRP / GLBP sur un port routé sont refuses avec la phrase des interfaces VLAN (`valid on SVI (Vlan)
  interfaces only`) alors qu'IOS les accepte ; `ip nat inside|outside` sur un port routé n'est pas porte ; tous les ports
  routés et toutes les interfaces VLAN parlent avec l'adresse MAC du pont (un vrai Catalyst en donne une par port) ; le refus
  de `switchport ...` sur un port routé est `% Invalid input detected at '^' marker.` faute d'avoir pu lire la phrase exacte
  d'IOS (le site de la communaute Cisco est injoignable d'ici ; un fil de discussion y parle de « not a switching port »).
- Un port routé n'existe que sur `CiscoSwitch` : `undo portswitch` de VRP n'est pas porte (un `HuaweiSwitch` partage le meme
  `Switch`, le plan SVI est donc pret).
- `ping` et `tracert` de VRP : le routeur rend l'IPv4 et l'IPv6 dans deux mises en page differentes (IPv4 : statistiques sur
  une ligne ; IPv6 : retrait de quatre espaces, statistiques sur quatre lignes), alors que la meme famille de commandes VRP
  n'en a qu'une : l'une des deux n'est pas celle de VRP. Non tranche faute de capture ou de page de documentation lisible d'ici
  (regle 8) ; le switch partage `shells/huawei/huaweiPing.ts` avec le routeur, donc suivra la correction. Le switch refuse
  `ping ipv6` (pas de pile IPv6 de gestion).
- netplan 0.104 : `set-name` n'est pas applique (la definition est ignoree, jamais renommee), `match.driver` ne
  correspond jamais, le simulateur n'imprime pas l'avertissement de depreciation de `gateway4` / `gateway6`, les routes
  portant `table:` ou un `type:` autre que `unicast` ne sont pas appliquees, et les types non-ethernet (bonds, bridges,
  vlans, wifis, tunnels) ne sont valides qu'en surface.
- Un `systemctl restart systemd-networkd` demarre maintenant un client DHCP sur toute interface netplan `dhcp4: true` (c'est
  ce que fait le vrai) : un lab qui ne veut aucun bail doit le dire par `dhcp4: false` dans son fichier.

### [nano] navigateur de fichiers (`^T` dans `^R`, `^O`, `M-F`)
La barre d'invite annonce `^T Browse` comme nano mais le navigateur n'existe pas : la touche est
ignoree. Vu en mesurant : `nano-tools-oracle.test.ts` (3 cas du corpus), `nano-colors-oracle.test.ts`
(col3-20, col3-28, col3-173). Lu dans `browser.c` de nano 7.2 (pas encore mesure sur le binaire) :
`browse` / `read_the_list` / `browser_refresh` (liste triee mise en colonnes, largeur du plus long
nom, taille ou « (dir) » affichee), `goto_dir`, recherche `findfile` / `search_filename`, `to_first_file`
/ `to_last_file`, pages, fleches, mots et blocs, aide propre au navigateur, `^X` pour en sortir, Entree
sur un dossier (qu'on entre) ou sur un fichier (qui revient dans l'invite). Brique a ecrire dans le
moteur d'invites ; elle sert les trois invites de fichier.

### [nano] annulation : « Undid insertion », `und3-175`, `un24-6`
Cas de `nano-undo-oracle.test.ts` (UNPORTED_CASES : und3-175, un24-6) et de `nano-insert-oracle.test.ts` :
- `und3-175` : avec `-k`, nano 7.2 annule une justification en laissant un tampon VIDE (le texte est
  perdu). Defaut du binaire, volontairement NON reproduit.
- `un24-6` : frappe au milieu d'une ligne deja trop longue avec `-b` : nano coupe a un autre
  blanc que le moteur ; pas encore analyse.
- « Undid insertion » : l'annulation de l'insertion d'un fichier (`^R`) porte le nom propre a ce
  genre d'action chez nano 7.2 ; le moteur dit « Undid action » (ASSESSMENT, ligne `^R`).
- L'insertion d'un FIFO par `^R` (nano lit jusqu'a la fin du flux).

### [nano] recherche : ce qu'une regex POSIX fait et que JavaScript ne fait pas
`-Q` et `M-R` passent par `CompiledEre` (`PosixEre`). Restent : la semantique POSIX des groupes de
capture sous un quantificateur (derniere iteration, groupe non participant vide : celle de
JavaScript est appliquee), `\c` sous `REG_ICASE` (defaut de la glibc), `[[:alpha:]]` et les classes
par categories Unicode, les decalages en octets de nano (UTF-16 ici : seul le point de depart de
la recherche arriere sur une fin de ligne multi-octet peut differer, `sea3-96` blanc d'une
correspondance vide sur un caractere large apres un remplacement), l'indicateur « Searching... »
des recherches longues, les touches tapees pendant la pause de 600 ms de « Key is invalid in view
mode » (le rejeu n'a pas de file d'attente).

### [nano] touches : touches modifiees, redimensionnement pendant l'aide, `rawsequences`
- `F1`-`F12` sont portees d'apres `global.c` de nano 7.2 (`NanoKeyAliases` : F1 aide, F2 quitter, F3 ecrire,
  F4 justifier, F5 lire, F6 chercher, F7/F8 pages, F9 couper, F10 coller, F11 position, F12 correcteur ;
  dans une invite seulement F1 F9 F10, dans l'aide F1 F2 F6 F7 F8) mais NON rejouees : tmux envoie pour
  ces touches des sequences que ncurses coupe (« Unbound key: 1 »), le corpus ne peut pas les enregistrer.
- Les touches modifiees dont tmux envoie des sequences que ncurses coupe ne sont pas rejouees non plus.
- Quand la fenetre change de taille pendant l'aide, nano redecoupe le texte de l'aide ; le moteur
  garde le decoupage de l'ouverture.
- `rawsequences` (`-K`) : lu, jamais evalue (touches Home/End des terminaux xterm / linux).

### [navigateur] Ctrl+W, Ctrl+T et Ctrl+N ne parviennent pas a la page
Chrome, Edge, Firefox et Safari gardent pour eux Ctrl+W (fermer l'onglet), Ctrl+T (en ouvrir un) et Ctrl+N
(fenetre), hors plein ecran : `preventDefault` n'y peut rien. Dans nano, `^W` (Chercher), `^T` (Executer) et
`^N` (ligne suivante) sont donc inatteignables au clavier dans un onglet ordinaire, alors que la barre les
annonce. Ce qui est fait : la barre est cliquable (`barShortcutAt`), `F6` chercher (`NanoKeyAliases`),
`navigator.keyboard.lock(['KeyW','KeyT','KeyN'])` demande a l'ouverture (ne vaut qu'en plein ecran, Chrome
et Edge seulement). Reste : `^T` n'a aucune alternative clavier dans nano lui-meme ; aucune mesure dans un
vrai navigateur (jsdom ne ferme pas d'onglet), a verifier a la main en plein ecran.

### [nano] caracteres non enregistres
Les corpus contiennent des accents precomposes (`é`, `café`) et du chinois (`中文`, largeur 2, avec
des tabulations) mais PAS : les emoji hors du plan de base, les caracteres combinants et de largeur
nulle (le recorder sait les compter, `cell_width`, aucun texte n'en contient), les octets UTF-8
invalides, ni les caracteres de controle hors tabulation. Le moteur n'est donc ni valide ni
refute sur ces textes : a enregistrer avant de pretendre que le rendu y est fidele.

---

### [terminal] Ctrl-C ne libere le terminal que pour les clients declares `foregroundClient`
**Mesure** (nat-lab : `curl http://170.20.0.2` vers un hote qui ne repond pas,
Ctrl-C, puis `ls`) : `curl` attend 127 s comme le noyau, puis la commande
suivante s'execute. Corrige pour `curl`, `dig`, `nslookup`, `host`, `nmap`,
`ldapsearch`, `snmpwalk`, `hping3`, `arping`, `radtest`, `tracepath`, `ntpq`
(`LinuxCommand.foregroundClient` : le client est un processus de la table, SIGINT
le tue, la commande rend la main, la file de la machine est liberee). Reste :
- `nc`, `openssl`, `ssh`, `telnet`, `ftp`, `scp`, `sftp` et les serveurs qui
  rendent la main en laissant un ecouteur (`nc -l`, `openssl s_server`) ne sont
  PAS declares : un ecouteur est attribue a son processus par NOM
  (`reapProcessSockets`), la mort du processus d'une commande voisine de meme
  nom fermerait l'ecouteur (mesure : le second client de `openssl s_server`
  trouvait le port ferme). Tant que l'attribution n'est pas faite par pid, ces
  commandes tiennent la file jusqu'a leur fin naturelle.
- Seul `curl` ferme ses sockets a l'interruption (`CurlHost.signal`). Les autres
  clients declares sont liberes par preemption (la commande est abandonnee, sa
  sortie jetee) : leur travail se poursuit en arriere-plan jusqu'a sa fin
  naturelle, sans rien ecrire.
- La file de commandes est UNE par machine (`SessionWorkQueue`) : une commande
  de premier plan dans un terminal tient les autres terminaux de la meme
  machine, ce qu'un vrai noyau ne fait pas.
- Windows : seul `curl.exe` est interruptible (`WindowsShellSession.foregroundAbort`,
  pas de table de processus Windows) ; les autres commandes bloquantes d'un
  terminal Windows n'ont pas ete mesurees.
- Un terminal SSH vers une machine Linux (`SshInteractiveShell`) ne passe pas par
  `LinuxTerminalSession` : l'interruption n'y est pas mesuree.
- `wget`, `telnet` et `nc` vers un hote qui laisse tomber les SYN rendent leur
  verdict AU CLIC (`Connection refused` / `Connection timed out` immediat, aller-
  retour TCP synchrone) la ou un vrai Linux attend ~127 s : ce n'est pas un blocage,
  mais la chronologie n'est pas celle du noyau.
**Pourquoi ce n'est pas ferme** : chaque client doit etre lu pour savoir ce qu'il
laisse derriere lui ; la preemption generale a ete restreinte aux clients dont la
fin ne laisse rien (voir la mesure sur `openssl s_server`).

## Gestion (SNMP, NTP, syslog)

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

### [track] `track <n>` tout court pose un objet « stub » sans mot-cle
IOS documente `track <object-number> stub-object` ; ici `track 1` seul
est accepte et cree l'objet, le repli de l'analyseur traitant « aucun
mot apres le numero » comme la forme stub.
**Mesure** : `track 1` rend la chaine vide sur un routeur et entre en
`config-track`.
**Report** : le mot-cle explicite est ATTESTE (un laboratoire du depot
tape `track 22 stub-object`), la forme NUE ne l'est pas — aucune
transcription atteignable depuis ce reseau ne dit si IOS la refuse comme
incomplete. Trancher sans capture serait inventer, et les deux
comportements sont aussi plausibles l'un que l'autre.

### [alias] `snapshot`/`restore` d'`AliasRepository` ne portent pas le REFUS des alias d'usine
`no alias exec` retire les alias d'usine (`p`, `s`, `w`) et le magasin
retient ce refus par un booleen que `snapshot()` ne rend pas et que
`restore()` ne repose pas — les deux ne transportent que la table des
alias de l'operateur.
**Mesure** : la coupure PARAIT bien dans `show running-config` (`no alias
exec`), donc elle survit a un import de topologie, qui rejoue cette
configuration ; ce qui ne la porte pas est le couple
`snapshot`/`restore`, que `CiscoIOSShell` emploie pour la bascule
`startup-config` (`reload`, `configure replace`).
**Report** : elargir le type de retour de `snapshot()` touche ses quatre
sites d'appel et la persistance de la configuration de demarrage, alors
que le seul chemin observable aujourd'hui — l'import — passe par le
rendu. Le fermer demande de decider ce qu'un `snapshot` doit porter en
general, ce qui est un autre sujet.

### [alias] un alias ne s'expanse pas dans les sous-modes qu'IOS ne nomme pas
`aliasModeForCliMode` fait correspondre les cinq modes d'`alias` aux
modes de la coquille : `exec`, `configure`, `interface` (y compris
`config-subif`), `line` et `router`. Les autres sous-modes — `config-vlan`,
`config-route-map`, `config-crypto-map`, les vingt et quelques autres —
n'ont donc aucun alias.
**Mesure** : `alias configure X ...` puis `X` sous `route-map` ne
s'expanse pas.
**Report** : c'est ce que fait IOS, dont la commande `alias` ne connait
que ces modes ; l'entree est ici pour que la table ne soit pas prise
pour un oubli si un mode manquait vraiment. Rien a corriger tant qu'une
transcription ne montre pas un sixieme mode.

### [socle] une queue `REST` ne sait pas nommer ses valeurs par POSITION (ferme)
`ntp server|peer` passe par un `OptionBag` (`sequenceFamily` accepte `options`) et `snmp-server host` par `snmpHostFamily`, dont les mots-cles sont des noeuds du chemin : `version ?`, `version 3 ?` et `key ?` nomment la valeur attendue. Reste ouvert, et note a part : `snmp-server host ... vrf <nom>` et les types de notification (voir ci-dessus).

### [oracle] le FORMAT d'un `TIMESTAMP WITH TIME ZONE` n'est pas source
Le lot T10 rend `SYSTIMESTAMP` et `CURRENT_TIMESTAMP` sous la forme
`2026-09-10 14:50:30.507 +02:00`. Un vrai Oracle rend cette valeur selon
`NLS_TIMESTAMP_TZ_FORMAT`, dont le defaut depend du territoire de la
session — typiquement `DD-MON-RR HH.MI.SSXFF AM TZR`.

**Mesure** : `docs.oracle.com` est bloque par le proxy de sortie de cet
environnement. Ce qui EST etabli, par deux rendus secondaires
concordants de la reference SQL : `CURRENT_TIMESTAMP` rend l'heure DANS
le fuseau de la session et `SYSTIMESTAMP` celle du serveur ; `ORA-01882`
est l'erreur d'une region inconnue. Le format d'affichage, lui, n'a pas
pu etre lu.

**Report** : la forme retenue PROLONGE celle que le depot employait deja
(`toISOString`) en lui ajoutant le decalage, plutot que d'inventer une
troisieme ecriture. Elle est coherente avec le rendu de `SYSDATE`, et
`coerceDateValue` sait la relire — le moteur lit ce qu'il ecrit. La
fermer demande soit l'acces a la reference, soit une transcription
SQL*Plus, et entrainera `NLS_TIMESTAMP_TZ_FORMAT`, que ce lot ne touche
pas.

### [horloge] 79 des 87 index de fuseau FortiOS ne sont pas implantes
`set timezone 55` est un index VALIDE sur un vrai FortiGate. Ici, seuls
huit index sont tabules (0, 1, 2, 3, 4, 12, 26, 27) ; les autres sont
desormais refuses par `unimplementedValues` — la porte que le depot
emploie deja pour SIP, l'acceleration materielle ou les signatures
FortiGuard — avec le message « exists on a real FortiGate », la ou ils
etaient auparavant acceptes et valaient UTC en silence. Un index HORS
plage garde l'autre refus, celui d'une vraie faute : deux causes, deux
messages.

**Mesure** : `resolveFortiTimezone` fabriquait
`{ index, name: 'UTC', label: '(GMT) time zone 55' }` pour tout index de
0 a 86 absent de la table. Le pare-feu affichait donc `set timezone 55`
dans sa configuration pendant que son horloge, ses journaux et ses
horaires de politique etaient a UTC — un fuseau annonce que rien ne
soutenait (I-T4).

**Pourquoi la table n'est pas remplie.** Il faut la correspondance
index -> fuseau, et aucune source atteignable ne la donne :
`docs.fortinet.com` et `registry.terraform.io` sont tous deux bloques
par le proxy de sortie, et `official_docs/forti-cli-ref-60.txt`
(l. 33538) donne la PLAGE (« from 00 to 86 ») en renvoyant a
`set timezone ?` pour la liste, qu'il ne reproduit pas.

Un resume de recherche a bien rendu une liste, et il ne faut PAS s'en
servir : elle est decalee d'un cran par rapport aux huit lignes deja
presentes ici (elle donne Midway/Samoa a l'index 01 la ou la table le
met a 0), et elle melange des versions dont certaines vont jusqu'a 89 —
FortiOS 7.4.2 ayant par ailleurs remplace l'entier par un nom IANA.
Ecrire 87 lignes depuis cette source injecterait 87 faits non verifies,
et l'ecart d'un cran dit qu'au moins une des deux numerotations est
fausse. Laquelle, cette entree ne le sait pas.

**Ce qui reste possible sans elle** : n'importe quel fuseau est
atteignable par son nom IANA (`set timezone Europe/Paris`), chemin qui
n'est pas borne par la table.

**Ce qu'il faudrait pour fermer** : la sortie de `set timezone ?` sur un
vrai FortiGate, ou l'acces a l'une des deux pages. La sonde
`probe-fuseaux-fortios` verifie deja que chaque ligne AJOUTEE porte le
decalage standard que son libelle annonce, de sorte qu'une ligne
mal recopiee tombera au lieu de s'installer.

### [horloge] la FORMULATION constructeur de `clock summer-time` n'est pas lue
Ce qui manque ne porte plus que sur les MOTS des deux references, pas
sur le comportement.

**Ce qui est etabli, et garde par une sonde.** La regle
`clock timezone CET 1` + `clock summer-time CEST recurring last Sun Mar
2:00 last Sun Oct 3:00` decrit `Europe/Paris`. tzdata, lui, est
joignable par `core/time/TimeZoneRegistry`. Les deux ont donc ete
compares directement :

    525 600 minutes comparees sur l'annee 2026 -> AUCUN ecart

Bascules comprises : au printemps l'heure locale saute de 01:59 a 03:00
et l'heure 02:00-02:59 n'existe pas ; a l'automne elle repasse de 02:59
CEST a 02:00 CET, qui se produit donc deux fois. Les deux cas vivent
dans `probe-horloge-suit-son-equipement.test.ts`, si bien qu'un
retournement futur de la convention tomberait au lieu de passer
inapercu. Etabli par ailleurs, par deux rendus concordants de la
reference IOS : `recurring` sans parametres prend les regles
americaines, et le decalage par defaut vaut 60 minutes.

**Ce qui reste ouvert.** `cisco.com` et `support.huawei.com` sont tous
deux bloques par le proxy de sortie de cet environnement, si bien que la
phrase exacte par laquelle chaque constructeur decrit ses bornes n'a pas
pu etre lue. La correspondance a tzdata rend un DESACCORD tres
improbable — il faudrait que Cisco s'ecarte du fuseau que sa propre
commande sert a decrire — mais elle ne remplace pas la lecture.

**Ce qu'il faudrait pour fermer.** L'acces a l'une des deux pages, ou
une transcription capturee sur un vrai equipement a l'heure meme de la
bascule. Les formes que la grammaire VRP accepte et que
`huaweiDaylightSaving` refuse aujourd'hui (les bornes datees d'un
`repeating`) dependent de la meme lecture.

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

### [cli] Un mot de trop apres une place declaree retombe sur le glouton du trie
**Constat.** `logging source-interface Gi0/0 extra` est ACCEPTE et rendu
`logging source-interface Gi0/0 extra` dans la configuration — donc rejoue
a l'import d'une topologie. La place est pourtant declaree au socle
(`INTERFACE`, non facultative, une seule), et le socle la refuse
correctement : c'est le glouton `logging` du TRIE qui sert la frappe
ensuite et joint le reste.

**Ce que ce n'est pas.** Ni la declaration ni le type ne sont en cause —
`logging source-interface zorglub` est bien refuse depuis le lot des
places d'interface. Ce qui manque est la regle « le socle a REFUSE cette
ligne, le trie ne la reprend pas », voisine de celle que
`tryMigratedCommand` porte deja pour `incomplete`/`invalid` et pour le
repli par heritage. La poser demande de distinguer « le socle ne connait
pas ce chemin » de « le socle le connait et refuse cet argument », ce que
`MatchResult.refusePar` sait deja dire pour les plages.

### [cli] `ip flow-export source` et `ip tftp source-interface`
**Constat.** `ip flow-export source zorglub` est accepte et rendu dans la
configuration : ce chemin est un noeud glouton du trie, sans place
declaree, donc la regle du lot des places d'interface ne l'atteint pas.
`ip tftp source-interface <iface>` — commande reelle d'IOS — n'existe pas
du tout et repond le caret.


### [fhrp] Un Catalyst RENDS trois vues FHRP qu'aucune de ses commandes ne peut peupler
**Constat.** `CiscoSwitchShell` porte `show standby`, `show vrrp` et
`show glbp`, qui lisent les VRAIS agents du commutateur, et il n'existe
AUCUNE commande de configuration derriere : `standby 1 ip …`, `vrrp 2 ip
…` et `glbp 3 ip …` sont refuses en vue d'interface sur un Catalyst.
Les trois vues repondent donc toujours vide, quel que soit le
laboratoire, et rien ne le dit.

**Comment cela a ete mesure.** En ecrivant le laboratoire de
`probe-vues-fhrp-filtrent-vraiment` : sa moitie commutateur ne peut pas
etre batie par la CLI et passe par `ensureGroup`/`setVip` sur les
agents — c'est-a-dire exactement ce que les trois familles de commandes
appelleraient si elles existaient.

**Pourquoi ce n'est pas ferme ici.** Ecrire les trois familles est un
lot a soi : un Catalyst L3 configure HSRP sur une SVI, avec sa version,
sa preemption, son suivi d'objets et son rendu dans la configuration —
c'est-a-dire le pendant complet de `CiscoHsrpCommands` et
`CiscoVrrpGlbpCommands`, qui sont ecrites pour un `Router`. Ces deux
fichiers portent la remarque « Router-only : kept out of the shared base
to avoid shadowing and respect the L2/L3 split », donc le partage
demande d'abord de trancher ce que le commutateur L3 a le droit de lire.

### [fhrp] Les filtres documentes que les vues `show` ne savent pas encore lire
**Constat.** Depuis que ces vues refusent ce qu'elles ne lisent pas, les
formes suivantes — toutes documentees par Cisco — repondent le caret au
lieu de filtrer. Avant, elles etaient acceptees et rendaient TOUT, ce
qui etait pire ; les refuser est le bon defaut, mais la matiere manque :

- `show glbp <groupe> <etat>` : le mot d'etat (`active`, `standby`,
  `listen`, `init`) est un filtre supplementaire de GLBP.
- `show bfd neighbors client <nom>` et `show bfd neighbors ipv4 <ip>` :
  le premier demande la liste des protocoles ENREGISTRES aupres d'une
  session, que `BfdSessionRuntime` ne porte pas.
- `show track interface`, `show track ip route`, `show track resolution`
  et `show track timers` : quatre vues distinctes, chacune avec son
  rendu.

### [bfd] Le bloc de detail omet trois lignes d'IOS, faute de mesure derriere
**Constat.** `show bfd neighbors details` rend desormais quatre lignes
par session, toutes LUES sur `BfdSessionRuntime`. Trois lignes du vrai
IOS manquent : `Holdown (hits): 900(0), Hello (hits): 300(0)` (le moteur
ne compte pas les depassements), `Registered protocols: OSPF` (aucun
client n'est enregistre aupres d'une session) et `Uptime: 00:00:03`
(`lastTransitionMs` existe, mais l'horloge du routeur n'est pas lue
ici). Les ecrire avec des zeros annoncerait une mesure qui n'a pas lieu.


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

### [ospf] ce que montre OSPF sur deux routeurs Cisco cables en Ethernet (R-AKWA / R-ISP, aire 0, un /28)
**Mesure** : la topologie d'un utilisateur importee par `importTopology`,
`router ospf 1` + `network … area 0` des deux cotes, horloge virtuelle quand
on veut laisser passer le temps. Le voisinage passe a FULL, R-AKWA est DR
(configure le premier, pas de preemption), R-ISP apprend les quatre LAN en
`O [110/2]`, `ping` et `traceroute` de bout en bout, l'echec d'aire / de hello
/ d'authentification se voit dans `%OSPF-4-ERRRCV` et tombe a 40 s
(`InactivityTimer`). Ce qui sonne faux :
- OSPFv3 : deux routeurs relies par un cable direct, sans horloge, s'elisent
  CHACUN DR (R1 voit `dr = 1.1.1.1`, R2 `dr = 2.2.2.2`, BDR `0.0.0.0`).
  L'accelerateur de WaitTimer de `v3AutoConverge` elit pendant que le voisin
  est encore en Init (exclu des candidats) et `processHello` de
  `OSPFv3Engine` ne relance pas l'election sur NbrChange (RFC 2328 §9.2, ce
  que fait `processHello` de `OSPFEngine`) ; la voie « commutateur + horloge »
  elit une fois les voisins connus et reste juste. Non ferme : relancer
  l'election exige de reevaluer les adjacences (AdjOK), que la voie
  rapide vers Full de v3 (`shouldFormAdjacency`) ne fait pas.
- L'authentification OSPF n'a que deux etats (`authType` 0 / 1 / 2) et
  l'AIRE n'est jamais lue : `area 0 authentication message-digest` est
  range par `setAreaAuthentication` et rendu, mais le moteur ne lit pas
  `OSPFArea.authentication` — une interface sans commande `ip ospf
  authentication` devrait heriter de celle de son aire (« the area default
  is null authentication », ios-ip-routing-ospf-command-reference-2024.pdf,
  `ip ospf authentication`). Dans le meme gestionnaire, `ip ospf
  authentication null` (qui doit ecraser l'aire) et `ip ospf authentication
  key-chain NOM` sont acceptes et ignores : le premier est lu comme
  `simple`, le second aussi, et `null` tape apres `message-digest` ne
  change rien. Le `null` explicite exige un etat « non configure » distinct
  de « null » pour l'heritage ET pour rendre la ligne tapee ; `key-chain`
  exige le sous-systeme de chaines de cles (algorithmes HMAC-SHA) que
  l'OSPF ne lit pas. Mesure par `show running-config` apres la serie de
  commandes ci-dessus.
- Le condense MD5 d'OSPF (`OspfCryptographicAuth`) couvre la serialisation
  canonique de l'objet paquet : le simulateur n'a pas de codec binaire
  OSPF, donc la disposition d'octets de la RFC 2328 Appendix D (en-tete de
  24 octets, champ d'authentification de 8, condense de 16 apres le
  paquet) n'est pas reproduite. Rien ne l'interopere avec un vrai routeur.
- `default-information originate [always] [metric] [metric-type] [route-map]`
  est evalue (metrique, type, existence de la route par defaut, retrait de
  la LSA, rendu en running-config, ligne ASBR), mais la ROUTE-MAP n'est que
  rangee et rendue : elle dispense la route par defaut d'exister et fait
  ignorer `always` (ce que dit la reference OSPF de Cisco), et ses clauses
  `match` ne sont evaluees nulle part — le simulateur n'a aucun evaluateur
  de route-map (BGP `neighbor … route-map` et `redistribute … route-map`
  sont dans le meme cas). La reference ne dit pas non plus CONTRE QUOI la
  clause est jugee. Meme famille, mesuree dans `originateRedistributedRoutes` :
  `redistribute static metric N` et `subnets` sont ranges et ignores (metrique
  20 en dur), `default-metric` ne sert qu'a `default-information`, et
  `redistribute eigrp|bgp|isis|ospf` est accepte sans rien ranger.
- Huawei `default-route-advertise [always] [cost n] [type 1|2]` evalue
  maintenant ses trois mots, mais ses valeurs par defaut (cout 1, type 2)
  sont celles que le code portait deja : `official_docs/` n'a aucune
  reference Huawei, donc rien ne les atteste.
- `show ip ospf database` : la section « Type-5 AS External Link States »
  porte les cinq colonnes que la reference decrit (Link ID, ADV Router, Age,
  Seq#, Checksum) et PAS la colonne Tag, qu'aucun exemple officiel ne montre.
  La reference montre aussi `database external` SANS `detail` comme un bloc
  detaille par LSA (`Metric Type`, `TOS: 0`, `Metric:`…) ; le simulateur
  imprime un tableau et ne filtre pas sur un `<ls-id>` tape. `show ip ospf`
  n'imprime ni les trois lignes `Supports …` ni le bloc `Redistributing
  External Routes from,` (le seul exemple officiel est
  `static, includes subnets in redistribution`).
- `show ip ospf interface brief` ecrit l'etat `DROTH` pour un routeur ni DR
  ni BDR. Aucune source atteignable ne l'atteste : ni les PDF de
  `official_docs/` (le seul exemple officiel montre `LOOP` et `P2P`), ni les
  captures de vrais IOS de `ntc-templates` et de `genieparser` (`LOOP`,
  `P2P`, `BDR`, `DR`, `DOWN`), et les pages de reference (cisco.com,
  community.cisco.com, netstuts.com) sont refusees par la politique reseau de
  la session. La largeur de la colonne `State` (5 caracteres) tient `DROTH`
  sans l'imposer. A verifier sur une capture avant d'y toucher. A l'inverse,
  la table de `show ip ospf neighbor` (priorite alignee a droite sous
  `Pri`, `State` a la colonne 22, `Dead Time` a 38, `Address` a 50,
  `Interface` a 66) est celle de la capture IOS
  `ntc-templates/tests/cisco_ios/show_ip_ospf_neighbor`, et les roles
  `FULL/DR`, `FULL/BDR`, `FULL/-` y figurent aussi.
- Le LIBELLE des lignes `%OSPF-5-ADJCHG` (`from Loading to Full,
  LoadingDone`, `from Full to Down, InactivityTimer` / `KillNbr`) n'est
  atteste par aucun document du depot : la reference OSPF de Cisco decrit
  `log-adjacency-changes [detail]` (quels evenements sont journalises, et
  c'est evalue) mais ne donne pas le texte du message. Rien ne dit non plus
  si IOS ecrit les etats en capitales ; a verifier avant d'y toucher.
**Pourquoi ce n'est pas ferme** : relever, pas corriger — l'exploration
etait demandee sans correctif. Chaque point a une sonde evidente
(`showIpOspfNeighbor` lit deja `iface.dr` / `n.neighborDR`).

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

### [dhcp] Windows : l'export et l'import restent absents
`Export-DhcpServer` et `Import-DhcpServer` ne sont pas dans le module.
**Mesure** : ces deux applets ne sont pas dans le module.
**Report** : elles supposent d'ecrire le XML qu'un vrai Windows produit,
et de le relire ; le VFS existe, le format n'est pas capture.

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

### [tests] cinq fichiers lisent le niveau `debug` du Logger comme instrument de mesure
Le niveau `debug` est éteint par défaut ; `another_rip`, `tuto_rip`,
`ping-through-switch`, `Logger.adapter` et
`probe-ip6tables-la-decouverte-de-voisins-traverse-les-chaines` l'allument
explicitement (`Logger.setDebugEnabled(true)`). Trois d'entre eux
(`rip:send`, `port:send`, `ndp:na-sent`/`ndp:rs-sent`) prouvent un
comportement du réseau par une ligne de journal et non par les trames
comptées sur le câble.
**Mesure** : `grep -rln "Logger\.\(getLogs\|getLogsBySource\|subscribe\)" src/__tests__`
puis `Logger.setDebugEnabled`.
**Report** : les remplacer par un compte de trames (règle 4) demande, pour
chacun, de choisir le bon câble et la bonne différence avec / sans la charge ;
c'est un changement de preuve, pas un changement de niveau de journal.

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
- `periodic <jours> hh:mm to <jours> hh:mm` — la forme dont le jour de
  FIN est nomme, attestee par la reference IOS
  (`periodic <days> hh:mm to [<days>] hh:mm`, donc `periodic Monday 23:00
  to Tuesday 01:00`, une fenetre qui traverse minuit) — est REFUSEE
  plutot que rangee inerte. `TimeRangePeriodic` ne porte pas de jour de
  fin et `isTimeRangeActive` compare un seul jour de semaine a une seule
  minute du jour, donc l'accepter rangerait un critere que rien
  n'evalue : la plage paraitrait posee et ne s'ouvrirait jamais la nuit
  qu'elle decrit. A rouvrir avec un jour de fin sur le modele ET la
  moitie du calcul qui va avec, les deux ensemble.
- Une ACE d'un Catalyst ne peut pas porter `time-range <nom>` : depuis ce
  lot le commutateur DECLARE ses plages horaires — `time-range`,
  `periodic`, `absolute`, `show time-range` et le rendu de configuration
  sont ceux du routeur, une seule declaration pour les deux — mais son
  analyse d'ACE ne lit pas le mot-cle (`grep timeRange
  CiscoSwitchShell.ts` ne rend rien), et son moteur de listes n'appelle
  pas `setTimeRangeResolver`. Une plage y est donc juste, relue, et sans
  consommateur. Le fermer touche l'analyse d'ACE du commutateur ET son
  plan de donnees, ce qui est un autre sujet que la grammaire de la
  plage.
- `absolute start <borne> end <borne>` n'exige pas que la fin suive le
  debut : `absolute start 8:00 20 March 2017 end 17:00 15 March 2017` est
  accepte et decrit une fenetre vide, qu'`isTimeRangeActive` referme
  correctement (aucune date ne satisfait les deux). Ce que fait une vraie
  machine — refuser a la saisie, ou accepter une plage qui ne s'ouvre
  jamais — n'est atteste par aucune capture atteignable depuis ce reseau,
  et les deux sont plausibles ; mesurer avant de trancher.
- Le jour du mois d'une borne `absolute` est borne a 1..31 sans regarder
  le MOIS : `absolute start 8:00 31 February 2017` est accepte.
  `Date.UTC` le reporte alors au 3 mars, donc la plage s'ouvre a une date
  que l'operateur n'a pas ecrite. Ce que refuse un vrai IOS ici n'est pas
  atteste ; le fermer demande soit une capture, soit la decision assumee
  de valider le calendrier.
- La borne HAUTE de `bandwidth <kbps>`, de `priority <kbps>` et de
  `shape {average|peak} <bps>` sous `policy-map class` n'est pas
  appliquee : depuis ce lot un jeton non numerique est refuse et un
  pourcentage est borne a 1..100, mais `bandwidth 999999999` reste
  accepte. La raison est ecrite plutot que devinee — ces bornes dependent
  de la PLATE-FORME (elles varient avec le debit de l'interface sur
  laquelle la politique est appliquee) et la documentation de Cisco n'est
  pas atteignable depuis ce reseau, tous les domaines qui la portent
  etant refuses par le mandataire de sortie. Poser un maximum de memoire
  refuserait sur ce simulateur une valeur qu'une vraie machine accepte.
  A rouvrir avec une capture ou une documentation atteignable.
- `queue-limit <n>` accepte le nombre et IGNORE son UNITE : IOS ecrit
  `queue-limit {<n> [packets] | <n> ms | <n> us | <n> bytes}` et le
  simulateur range la queue telle quelle sans distinguer les unites,
  donc `queue-limit 40 ms` et `queue-limit 40 packets` decrivent la meme
  profondeur pour lui. Rien n'evalue la profondeur d'une file dans ce
  simulateur (aucune mise en file n'a lieu sous une politique de service),
  donc juger l'unite rangerait un critere de plus que rien ne lit ; ce qui
  manque d'abord est le mecanisme, pas la grammaire.
- `class-default` est acceptee sous `policy-map` et rangee avec
  `kind: 'class-default'`, mais rien ne verifie qu'une classe NOMMEE
  designe une `class-map` qui existe : `class ZORGLUB` cree une classe
  vide sous la politique et la rend dans la configuration. Ce qu'un vrai
  IOS fait ici — refuser, ou creer la class-map implicitement — n'est pas
  atteste depuis ce reseau ; mesurer avant de trancher.
- `ip igmp snooping vlan <n>` n'exige pas que le VLAN EXISTE : depuis ce
  lot le numero est borne a 1..4094 (802.1Q), mais `ip igmp snooping vlan
  777` est accepte sur un commutateur qui n'a pas de VLAN 777 et cree
  l'etat de surveillance a vide. La convention d'IOS est que le VLAN
  nomme doit exister ; ce qu'un vrai Catalyst repond exactement dans ce
  cas (refus, ou creation implicite) n'est atteste par aucune capture
  atteignable depuis ce reseau. La meme question se pose pour
  `ip pim snooping vlan <n>`, corrige de la meme facon dans le meme lot.
- Les trois autres ecritures de « un numero de VLAN vaut 1..4094 » du
  commutateur Cisco ne lisent pas encore `parseVlanId` : elles vivent
  dans `CiscoSwitchShell` (la liste d'identifiants d'une commande de
  plage, la vue `show`, et la SVI) et rendent chacune un message
  DIFFERENT pour la meme faute — `% Invalid VLAN id` d'un cote, le caret
  generique de l'autre. Cote Huawei il y en a six de plus, avec leurs
  propres mots (`Error: Wrong parameter found.`). Les unifier est un lot
  a soi : ce n'est pas la borne qui differe mais le MESSAGE, et chacun
  doit rester celui de son constructeur.
- Les bornes de `ip flow-cache timeout active <minutes>` et
  `ip flow-cache timeout inactive <secondes>` ne sont pas appliquees :
  depuis ce lot un jeton non numerique est refuse et la valeur doit etre
  positive, mais `ip flow-cache timeout active 999999` reste accepte. Ces
  deux plages sont documentees par Cisco et sa documentation n'est pas
  atteignable depuis ce reseau (tous les domaines qui la portent sont
  refuses par le mandataire de sortie) ; poser un maximum de memoire
  ferait refuser une valeur qu'une vraie machine accepte.
- `ip flow-export version <n>` est accepte pour 1..9 et RANGE, mais
  l'exportateur emet toujours du NetFlow v5 : `NetFlowAgent` ecrit
  `NETFLOW_V5_VERSION` et le type de son en-tete est le litteral `5`. La
  version configuree est donc un critere que rien n'evalue — ce que la
  convention du depot interdit — et le fermer demande d'ecrire l'encodage
  v9 (gabarits, jeux de champs), qui est un sujet a soi et non une
  question de grammaire. La borne haute retenue ici (9) est le numero de
  version le plus eleve que NetFlow ait porte ; `ip flow-export version 1`
  et `5` sont acceptes de la meme facon et ne changent rien non plus.
- Les bornes des formes `storm-control <type> level {pps|bps} <debit>` ne
  sont pas appliquees : depuis ce lot le debit doit etre un nombre positif,
  mais `storm-control broadcast level pps 99999999999` reste accepte. La
  borne haute depend du DEBIT DU PORT (un seuil en paquets par seconde
  au-dela de ce que le lien peut porter n'a pas de sens) et ce que refuse
  un vrai Catalyst n'est pas atteste depuis ce reseau. La borne du
  POURCENTAGE, elle, est appliquee : c'est de l'arithmetique.
- `storm-control` est range dans `ifExtra`, un sac de LIGNES DE TEXTE par
  interface partage avec `switchport voice` et `srr-queue`. Depuis ce lot
  la ligne est ANALYSEE a la porte, donc seule une commande valide y
  entre, et la vue lit le meme analyseur au lieu de refaire un
  `parseFloat` — mais le magasin reste du texte, et `srr-queue` n'est
  toujours juge par personne (`srr-queue bandwidth share zorglub` est
  accepte et rendu). Fermer `srr-queue` demande sa grammaire, qui n'est
  pas attestee depuis ce reseau ; lui donner un vrai magasin est un autre
  lot, qui touche le rendu de la configuration d'interface.
- `default-information originate metric <n>` est desormais JUGE et n'est
  RANGE nulle part : `_getOSPFExtraConfig()` porte `defaultInfoMetricType`
  et pas de champ pour la metrique elle-meme, si bien que
  `default-information originate metric 50` est accepte, verifie, puis
  oublie — la route par defaut annoncee garde la metrique par defaut. Ce
  lot refuse desormais `metric zorglub` (une valeur impossible ne passe
  plus en silence) mais ne stocke pas la valeur juste, ce qui demande un
  champ sur le magasin ET que l'annonce le lise.
- `metric weights <tos> k1..k5` accepte n'importe quel TOS de 0 a 255,
  alors que la documentation de Cisco dit que la valeur doit TOUJOURS
  etre zero — cette documentation n'est pas atteignable depuis ce reseau
  pour l'attester, et le simulateur n'a de toute facon aucune notion de
  type de service dans sa metrique composite. Ce lot refuse un TOS non
  numerique, ce qui etait le defaut mesure ; restreindre a zero demande
  la capture.
- Les bornes hautes retenues pour `timers throttle spf` (600000 ms),
  `max-lsa` et `default-information originate metric` (16777214, la
  metrique OSPF maximale) sont des ordres de grandeur RAISONNES et non
  des valeurs attestees : la documentation de Cisco n'est pas atteignable
  depuis ce reseau. Elles ne refusent que des valeurs absurdes ; si une
  capture les contredit, ce sont elles qu'il faut corriger et non le
  mecanisme.
- `bgp bestpath <option>` est accepte, range dans le sac de texte du
  processus et rendu tel quel, alors que ses options forment un ensemble
  FERME sur IOS (`as-path`, `compare-routerid`, `med`, `cost-community`…)
  et qu'aucune n'est evaluee par ce moteur. Ce lot ne le referme pas : le
  sac est une decision ECRITE dans le gestionnaire — une option de
  durcissement que le simulateur ne modelise pas doit survivre au
  rechargement d'une topologie plutot que disparaitre —, et la liste
  exacte des options de `bestpath` n'est pas attestee depuis ce reseau.
  A rouvrir avec une capture, en distinguant « option connue mais non
  evaluee » (a ranger) de « mot invente » (a refuser).
- `parseRedistribute` (`inspection/config/RoutingConfigRepository.ts`)
  range tout mot qu'elle ne comprend pas dans un champ `tail` que SEUL le
  rendu relit. Ce lot ferme le cas mesure — l'identifiant de processus
  d'`ospf`/`eigrp`/`bgp`, qui doit etre un nombre — mais un mot inconnu
  place APRES les options (`redistribute static metric 5 zorglub`) tombe
  encore dans `tail` et revient dans la configuration. Le fermer demande
  de trancher, option par option, ce que la commande accepte vraiment, ce
  qui n'est pas atteste depuis ce reseau.
- Neuf parametres de `New-ADUser` ne sont pas declares, chacun parce
  qu'il gouverne un mecanisme que ce simulateur n'a pas : `-Server` et
  `-AuthType` (aucun chemin d'objet ne dialogue avec un contrôleur
  distant — meme raison que pour `New-ADOrganizationalUnit`), `-Type`
  (creer un `iNetOrgPerson` ou toute autre sous-classe de `user`
  demanderait que le schema porte ces classes), `-Certificates`
  (`userCertificate` suppose un certificat X.509 attache a un compte, que
  rien ne lit), `-AuthenticationPolicy` et `-AuthenticationPolicySilo`
  (les silos d'authentification n'existent pas), `-KerberosEncryptionType`
  (le KDC de ce simulateur ne negocie pas de type de chiffrement),
  `-CompoundIdentitySupported` (l'identite composee de Kerberos armore
  n'est pas modelisee) et `-PrincipalsAllowedToDelegateToAccount` (la
  delegation contrainte fondee sur les ressources a bien un magasin cote
  ORDINATEUR, `setComputerAllowedToDelegateTo`, mais aucun cote
  utilisateur). Les declarer les rangerait sans que rien ne les evalue.
- `New-ADUser` accepte encore un `-Name` seul et en deduit le
  sAMAccountName, alors que la documentation ecrit « You must specify the
  SamAccountName parameter to create a user ». Le repli est conserve
  parce qu'il est PERMISSIF et non producteur de mauvaise reponse — il
  cree le compte que l'operateur voulait — et que le refuser ferait
  tomber des laboratoires qui l'utilisent ; mais un compte dont le nom
  porte une espace y prend alors un sAMAccountName avec une espace, ce
  qu'une vraie machine n'accepte pas.
- Le commutateur Cisco porte TROIS resolveurs de nom d'interface :
  `resolvePortName` (correspondance exacte seule), sa propre
  `resolveInterfaceName` (exacte plus une table de prefixes ecrite a la
  main, une vingtaine d'entrees par type) et celle de `CiscoShellBase`
  (exacte plus une heuristique par squelette numerique). Ce lot en ferme
  UN des trois — la methode du commutateur devient un `override` explicite
  de celle de la base, donc les deux plateformes partagent desormais la
  meilleure des deux —, et laisse `resolvePortName`. La fondre changerait
  le COMPORTEMENT de ses appelants (`mrouter interface Gi0/1` serait
  accepte la ou seule la forme longue passe aujourd'hui), ce qui est une
  amelioration mais pas la question de ce lot.
- `snmp-server community <nom> RO <mot>` accepte n'importe quel mot comme
  liste de controle, y compris un nom de liste qui n'existe pas. Ce n'est
  PAS ferme ici et c'est deliberé : IOS ecrit `snmp-server` AVANT
  `access-list` dans sa propre configuration, donc refuser une reference
  en avant empecherait la machine de relire sa propre configuration de
  demarrage — la meme raison qui fait accepter `ip nat inside source
  list <n>` avant que la liste existe. Ce qui manque serait un controle
  a l'EMPLOI et non a la saisie.
- `ip domain lookup source-interface <interface>` accepte une interface
  qui n'existe pas (`zorglub`, `GigabitEthernet9/9`) et la rend dans la
  configuration. Une sonde de cette session a tente de l'exiger et le
  correctif a fait tomber `tuto-dns-cisco-conformite`, qui nomme une
  `Loopback0` non creee — donc un test de conformite du depot affirme le
  contraire de la premisse. Ce que fait un vrai IOS ici n'est atteste par
  aucune source atteignable depuis ce reseau (les domaines de Cisco sont
  refuses par le mandataire de sortie), et l'argument du rejeu ne tranche
  pas : ce simulateur rend cette ligne APRES les interfaces, donc un
  rechargement fonctionnerait dans les deux cas. La moitie du lot a ete
  ABANDONNEE plutot que forcee. A rouvrir avec une capture, en verifiant
  d'abord si le tutoriel dont ce test est tire montre la loopback creee
  avant.
- `set ip dscp`, `set ip tos`, `set traffic-index`, `set mpls-label` et
  `set vrf` ne figurent pas dans `ROUTE_MAP_SET_CLAUSES` et sont donc
  desormais REFUSEES sur une carte de routage. La table declare ce qui
  est atteste et ce que le depot exerce ; ces cinq formes existent sur un
  vrai IOS mais aucune source atteignable depuis ce reseau n'en donne la
  grammaire exacte (les domaines de Cisco sont refuses par le mandataire
  de sortie), et une place declaree au juge trop laxiste vaudrait le sac
  de chaines qu'on vient de retirer. A ajouter des qu'une capture ou une
  documentation les atteste, une entree par forme.
- `redistribution.test.ts` > « the RIP domain learns OSPF-side prefixes
  with the redistribute metric » echoue sur `0101d8f5`, c'est-a-dire
  AVANT tout travail de cette session — verifie par `git stash` sur un
  arbre propre. La route `192.168.3.0` redistribuee d'OSPF vers RIP
  n'arrive pas jusqu'a R1. Defaut de convergence a diagnostiquer, non
  imputable au lot route-map, qui ne touche ni RIP ni OSPF.
- `apply preference` et `car cir` de VRP n'ont pas de borne HAUTE
  appliquee : la premiere est une distance administrative, la seconde un
  debit en kbit/s, toutes deux bornees par la PLATEFORME, et la
  documentation de Huawei n'est pas atteignable depuis ce reseau. Seule
  la certitude « c'est un nombre » est appliquee (`vrpNombre`), ce qui
  ferme le `NaN` sans inventer un plafond. A rouvrir avec une capture.
- Le classificateur de trafic de ce simulateur accepte `if-match vlan`
  la ou VRP ecrit `if-match vlan-id`. Le lot des valeurs de politique VRP
  a juge la VALEUR (1-4094, via `parseVlanId`) sans toucher au MOT :
  changer l'orthographe acceptee sans capture remplacerait une invention
  par une autre. A trancher avec une transcription reelle.
- `if-match cost` de VRP est desormais range et rend le noeud ECHOUANT
  FERME, comme `acl`, `community`, `as-path`, `interface` et
  `ext-community` avant lui : `RoutePolicyRouteInput` ne porte aucun cout
  a comparer. L'evaluer demande de faire voyager la metrique de la route
  redistribuee jusqu'a la politique, ce qui est un autre sujet que la
  grammaire de la CLI.
- `match dscp` et `match precedence` sont REFUSES sur un `class-map` de
  qualite de service, et c'est juste en l'etat : `ClassMapMatch` ne
  connait que quatre genres (`access-group-name`, `access-group-num`,
  `protocol`, `any`) et RIEN n'evalue une classe QoS ici — le magasin
  n'est lu que par le rendu de la configuration. Les accepter rangerait
  un critere que personne ne lit, ce que la regle du depot interdit. Ce
  qui manque pour les ouvrir est un evaluateur de classe sur le plan de
  donnees, pas une ligne d'analyse ; `DSCP_KEYWORD_TO_VALUE` d'`ACLEngine`
  porte deja les noms, et `vrpDscp` de `vrpPolicyValues.ts` la lit deja.
- `match protocol <nom>` d'un `class-map` accepte n'importe quel mot. Le
  nom vient de NBAR, dont la liste depend de la plateforme et des modules
  charges, et aucune source atteignable depuis ce reseau ne l'atteste —
  une liste ecrite de memoire refuserait des protocoles reels. La valeur
  n'est de toute facon evaluee par personne (voir l'entree precedente).
- Le nom d'une option DHCP ecrite en `hex` n'est verifie que sur son
  alphabet (chiffres hexadecimaux et points) : la PARITE du nombre de
  chiffres, qu'un vrai IOS controle puisqu'un octet en prend deux, ne
  l'est pas. Trouve en ecrivant `dhcpOptionValueIsValid` ; non ferme
  faute d'une capture disant ce qu'IOS repond a un nombre impair.
- `import-route rip`, `import-route isis`, `import-route bgp`,
  `import-route ospf` et `import-route unr` sont ACCEPTES par la vue OSPF
  de VRP et JETES : seuls `static` et `direct`/`connected` alimentent
  `_getOSPFExtraConfig()`. Le lot des vues de routage a ferme le mot
  INVENTE (un protocole hors de la liste est desormais refuse au lieu
  d'etre avale) et n'a pas ouvert les cinq autres : les brancher demande
  une source de routes par protocole cote OSPF, ce qui est un sujet de
  moteur et non de grammaire. La consequence aujourd'hui est qu'une
  redistribution declaree pour l'un de ces cinq ne redistribue rien et
  ne parait pas non plus dans la configuration.
- `gateway-list` de VRP accepte plusieurs adresses et le magasin les
  garde toutes, mais VRP borne cette liste a HUIT entrees comme IOS le
  fait pour `default-router` — la borne est appliquee cote IOS
  (`parseAddressList`) et PAS cote VRP, faute d'une source atteignable
  disant si Huawei borne au meme nombre. Seule la validite de chaque
  adresse est controlee des deux cotes.
- `VRP_LEASE_MAX` borne `lease day` a 999 jours : c'est la borne d'IOS
  transposee (365) elargie a ce que VRP accepte d'apres les exemples
  atteignables, et non une valeur attestee. Les bornes de `hour` (23) et
  `minute` (59) sont, elles, celles du calendrier et donc certaines. A
  reprendre avec une capture.
- La vue `ip pool` de VRP porte la meme forme que la politique et les
  vues de routage : `gateway-list zorglub` et `dns-list zorglub` sont
  acceptes et RENDUS, `network zorglub mask 24` et `lease day zorglub`
  sont acceptes et jetes. Lot jumeau de `probe-vrp-vues-routage`, a
  ecrire avec les memes outils (`estAdresseIPv4`, `boundedInteger`) ;
  non fait ici pour ne pas melanger deux vues dans un meme lot.
- `-Server`, `-AuthType` et `-Instance` en ENTREE DE PIPELINE ne sont pas
  declares sur `New-ADOrganizationalUnit` (ni sur `Set-`/`Remove-`), alors
  que la documentation du cmdlet les porte. `-Server` et `-AuthType`
  gouvernent le choix et l'authentification du contrôleur interroge :
  toutes les commandes d'OBJET de ce simulateur passent par
  `requireStore()`, c'est-a-dire l'annuaire LOCAL de la machine, et aucun
  chemin ne dialogue avec un contrôleur distant pour lire ou ecrire un
  objet — seuls `Install-ADDSDomainController`, `New-ADDomain` et
  `New-ADTrust` evaluent un `-Server`, parce qu'eux composent vraiment.
  Les declarer les rangerait sans que rien ne les evalue, ce que la
  convention du depot interdit. `-Instance` est evalue comme GABARIT (un
  objet passe en parametre) mais pas comme entree de PIPELINE, le
  `Import-Csv | New-ADOrganizationalUnit` de la methode 3 de la
  documentation demandant que le cmdlet lise `ctx.pipeInput` par
  PROPRIETE, mecanisme que ce moteur n'a pas.
- `-Properties` est declare par `Get-ADUser`, `Get-ADComputer`,
  `Get-ADObject` et `Get-ADOrganizationalUnit` et EVALUE PAR AUCUN : ces
  vues rendent toutes leurs proprietes, quoi qu'on demande. Sur une vraie
  machine le cmdlet rend un JEU PAR DEFAUT et `-Properties` seul y ajoute
  le reste — c'est ce qui fait qu'un `Get-ADOrganizationalUnit` sans
  `-Properties Description` n'affiche PAS la description, question posee
  mille fois. Non ferme ici parce que c'est un lot a soi, sur quatre
  cmdlets a la fois : leur donner un jeu par defaut a chacun demande de
  MESURER lequel, et le faire pour la seule OU laisserait `-Properties`
  vivant d'un cote et inerte des trois autres, c'est-a-dire deux reponses
  a une meme question. Ce lot rend donc TOUT ce qui est pose, choix qui
  ne cache aucune donnee — l'inverse aurait rendu invisible la
  description que l'operateur vient d'ecrire.
- Un attribut pose par `-OtherAttributes` est relu sous le nom que
  l'arbre LDAP stocke, c'est-a-dire en MINUSCULES (`postofficebox`), la
  ou une vraie machine rend la casse canonique du schema
  (`postOfficeBox`). Sans consequence a l'usage — les noms d'attributs
  LDAP sont insensibles a la casse et l'acces aux proprietes de ce moteur
  PowerShell l'est aussi, donc `$ou.postOfficeBox` repond (mesure) —
  mais un `Format-List` affiche la clef stockee. Fermer cela demande que
  le `SchemaValidator` porte la casse canonique de chaque attribut, ce
  qu'il ne fait pas.

- `loopback-detect`, `port-security`, `storm-control`, `flow-control`,
  `port-mirroring` et `am` d'une interface de commutateur VRP passent par
  un SAC de texte partage : la ligne est gardee telle quelle et rendue,
  donc `loopback-detect zorglub` survit au rechargement d'une topologie.
  C'est la decision ECRITE de ce depot pour une commande reelle qu'il ne
  modelise pas — la meme que pour `ip ssh server algorithm` — et le lot
  des identifiants de VLAN l'a laissee telle quelle : leur donner un
  vocabulaire demande d'attester celui de VRP, hors de portee depuis ce
  reseau, et une liste ecrite de memoire refuserait des commandes reelles.
- `IPTABLES_MATCH_MODULES` declare vingt et un modules. Le moteur en EVALUE douze : `state`, `conntrack`, `multiport`, `limit`, `mac`,
  `iprange`, `recent`, `comment` et les quatre modules de protocole `tcp`, `udp`, `icmp`, `icmp6` (leurs options sont des CHAMPS
  de la regle : ports, drapeaux, options TCP, type ICMP). Les neuf autres -- `addrtype`, `mark`, `connmark`, `owner`, `pkttype`,
  `length`, `ttl`, `hashlimit`, `string` -- sont acceptes et listes (le vrai iptables les connait) mais ne correspondent a RIEN :
  une regle qu'on ne sait pas decider ne devient pas plus large que son texte. A reprendre module par module ; `mark`/`connmark`
  demandent des marques PAR PAQUET et l'evaluation des tables mangle aux crochets, `owner` l'uid du processus emetteur.
- `scenario-windows-log-export-remoting.test.ts` > « Export-Csv puis
  Import-Csv … en CSV » echoue sur `78370a4b3`, c'est-a-dire AVANT le lot
  des regles de pare-feu netsh — verifie par `git stash` sur un arbre
  propre. `(Import-Csv …).Count` rend `NaN`. A diagnostiquer ; non
  imputable a ce lot, qui ne touche ni PowerShell ni le journal
  d'evenements.
- `WinNetsh.ts` reference un type `NetshContext` qui n'existe pas (deux
  sites, `handleShowAddresses` et son voisin), donc deux erreurs de
  compilation. Elles sont ANTERIEURES au lot des regles de pare-feu —
  verifiees par `git stash` — et font passer la reference de 247 a 248.
  Le contexte reellement passe est `WinCommandContext` ; corriger la
  declaration demande de verifier ce que les deux fonctions lisent.
- Il reste 53 continuations DECLAREES (0 + 27 + 6 + 20, cliquet resserre
  a ces nombres) qui ne sont pas des chemins de commande a part entiere :
  `no spanning-tree {backbonefast|bpdufilter|…}`, `ip igmp snooping
  {immediate-leave|mrouter|querier|vlan}` et son `no`, `class-map
  {match-all|match-any|type|inspect}`, `ip flow-cache`/`ip flow-export`,
  `zone-pair security {source|destination}`, `ip community-list
  {expanded|standard}`, `track {interface|ip|routing}`, `radius server`.
  Les declarer est la bonne facon de les annoncer aujourd'hui — c'est la
  decision ecrite dans `ciscoContinuations.ts`, prise apres qu'une
  extraction depuis le TEXTE SOURCE eut fait disparaitre `level` de
  l'aide de `no privilege`. En faire de VRAIS noeuds leur donne en plus
  un gestionnaire, des arguments types et un refus propre, ce que le lot
  `show ip igmp snooping` + `clear port-security` vient de faire pour le
  mode privilegie du commutateur, tombe a ZERO. Suite : famille par
  famille, en baissant le cliquet a chaque fois.
- `no spanning-tree vlan <n>` coupe desormais CE VLAN et le rend, mais la
  garde `isVlanStpEnabled(key)` de `sendBpdu` lit la CLE d'instance : en
  PVST la cle EST le VLAN, donc la garde est exacte ; en MST la cle est
  un numero d'instance, si bien qu'un `no spanning-tree vlan 10` sous
  `spanning-tree mode mst` bornerait l'instance 10 et non le VLAN 10. Le
  cas n'est pas atteignable par les laboratoires actuels (aucun ne coupe
  un VLAN en MST) et le corriger demande de traduire VLAN vers instance
  a la coupure, ce qui est le sujet de la region MST et non celui de
  cette commande.
- `spanning-tree priority <n>` est accepte en configuration GLOBALE alors
  qu'un vrai Catalyst ne connait cette forme que sous `vlan <n>`. Le lot
  qui a fait tenir parole a l'aide du commutateur l'a LAISSEE : des
  laboratoires du depot s'en servent, et la retirer est un changement de
  comportement a mesurer pour lui-meme. Ce qui est corrige est seulement
  que `spanning-tree priority ?` annonce desormais un NOMBRE au lieu de
  reproposer les freres du parent.
- Le garde-fou « un mot que `?` propose est un mot qui existe » ne
  DESCEND pas dans le sous-arbre d'un mot qu'il refuse d'executer :
  `NE_PAS_EXECUTER` sert aux deux usages a la fois, si bien qu'`ip`,
  `debug`, `do`, `show` et vingt autres bloquent tout ce qui est sous
  eux. Mesure en separant les deux notions et en portant la profondeur a
  quatre : 2096 signalements, dont l'immense majorite sous `debug` et
  `do` (qui rejoue l'arbre privilegie). Les separer pour de bon demande
  une campagne de correction a la mesure de ce nombre ; le lot du
  commutateur a ferme ce que le balayage ACTUEL voit, ce qui etait deja
  139 cas que personne ne regardait.
- `?` propose sur un PORT PHYSIQUE de commutateur VRP les cinq commandes
  qui n'existent que dans la vue d'une `Eth-Trunk` (`mode`, `lacp`,
  `load-balance`, `max`, `least`). L'execution refuse correctement — le
  lot qui a fait tenir parole a l'aide de VRP a corrige la place du caret
  — mais l'AIDE continue de les annoncer : le trie d'interface est unique
  pour les deux genres de port, et le filtrage par contexte n'existe que
  cote Cisco (`commandVisibleToNow`, qui ne connait que le mode, le
  privilege et la vue). Lui donner la notion de « quel genre d'interface
  est selectionnee » est un autre lot.
- Le balayage « un mot que `?` propose est un mot qui existe » n'est pas
  encore un TEST pour VRP : le lot qui l'a fait tourner a la main sur les
  deux machines Huawei a corrige ce qu'il a trouve (2 mots-cles nus, 3
  carets) et n'a pas fige le balayage, faute d'un equivalent VRP du
  `NE_PAS_EXECUTER` de la version Cisco — la liste des commandes qu'on ne
  peut pas executer dans un balayage (`reboot`, `save`, `reset`…) doit
  etre etablie pour VRP avant qu'un tel test soit sur.
- `probe-aide-tient-ses-promesses.test.ts` — le plus lourd des garde-fous
  d'aide, celui qui execute TOUT ce que `?` propose sur le routeur — ne
  termine plus dans ce conteneur : le processus est tue par
  `ERR_WORKER_OUT_OF_MEMORY` apres environ 140 s, avec ou sans
  `--max-old-space-size=6144`, sur les deux reservoirs (`forks` comme
  `threads`). Mesure : le meme echec se produit avec toutes les
  modifications en cours REMISES, donc il est ANTERIEUR et ce n'est pas
  une regression d'un lot. Ses cinq freres plus legers
  (`probe-cli-aide-egale-execution`, `probe-aide-cr-tient-sa-promesse`,
  `probe-commutateur-aide-tient-parole`, `probe-aide-decrit-la-bonne-place`,
  `probe-aide-noeuds-intermediaires`) tournent et sont verts, donc la
  couverture n'est pas perdue — mais tant que celui-la ne tourne pas, la
  promesse « tout mot annonce s'execute » n'est plus VERIFIEE sur le
  routeur, seulement sur le commutateur. Le fermer demande de borner ce
  que le balayage retient en memoire (il construit un equipement par mot
  teste) plutot que d'agrandir le tas.
- Les onze autres mots-cles que le glouton `spanning-tree` absorbe
  (`portfast`, `mode`, `pathcost`, `vlan`, `extend`, `loopguard`,
  `priority`, `mst`, `bpdufilter`, `bpduguard`, `default`) reproposent
  encore les SOEURS de la famille apres eux quand ils n'ont pas de suite
  declaree, parce que l'aide reste sur le noeud glouton et y rejoue ses
  propres enfants. Le lot qui a ferme `backbonefast` et `uplinkfast` ne
  les a pas fermes : chacun demande de mesurer ce qu'il prend VRAIMENT
  avant de le declarer, et declarer de travers y mettrait un mensonge de
  plus. La bonne facon de les fermer est de les MIGRER — un mot-cle qui
  devient une vraie commande du socle porte sa place, son refus et son
  aide d'un seul tenant.
- `show running-config` d'un Catalyst rend `spanning-tree mode pvst`
  apres `no spanning-tree mode`, c'est-a-dire le mode par DEFAUT. Un
  vrai Catalyst ecrit-il cette ligne dans sa configuration d'usine ? La
  question n'est pas tranchee : `cisco.com` est refuse par le mandataire
  de sortie de ce reseau, et la trancher de memoire est exactement ce
  que ce depot refuse. Les deux reponses ont une consequence — si la
  ligne est tacite, la rendre fait qu'une topologie importee decrit un
  reglage que personne n'a pose ; si elle ne l'est pas, la taire perd
  l'information au rechargement. La sonde de la famille observe donc le
  COMPORTEMENT (le retour a PVST+) et pas le rendu. A rouvrir des qu'une
  capture reelle de configuration d'usine est atteignable.

### [ui] un port `Serial` de routeur est cree avec le type `ethernet`

**Mesure** : `interface Serial0/0/0` sur un routeur Cisco passe par
`Router._createVirtualInterface`, qui ecrit `new Port(name, 'ethernet')`
en dur. Le port existe, il est bien cablable — une interface serie est
un vrai port de facade, et le lot « une interface virtuelle n'a pas de
prise » a pris soin de ne PAS l'en exclure — mais le selecteur de
cablage le range sous « Ethernet » et propose un cable Ethernet pour un
lien WAN serie. `ConnectionType` porte pourtant `'serial'`, et le
selecteur sait deja grouper par type et n'offrir que les types presents
des deux cotes.

**Non corrige ici** : le type d'un port n'est pas qu'une etiquette
d'affichage. Il est lu par la negociation de `Cable`, par le groupement
du selecteur et par tout ce qui filtre sur `iface.type`, et aucun port
`'serial'` n'existe aujourd'hui dans le depot — donc poser le bon type
demande d'abord de mesurer ce qu'un lien serie doit negocier (debit,
duplex, horloge DCE/DTE, `clock rate`), ce qui est un lot a soi et non
un changement d'une ligne. Le faire a l'aveugle donnerait un port d'un
type que rien ne sait traiter.

### [nettcpip] pas de flux WARNING : une cmdlet ne peut pas AVERTIR et rendre un objet

**Mesure** : `Test-NetConnection zorglub.invalid` sur une vraie machine
Windows ecrit `WARNING: Name resolution of zorglub.invalid failed` PUIS
l'objet de resultat — deux flux distincts, l'avertissement et la sortie.
Ici le runtime n'en a qu'un : `PSRuntime` ecrit
`const emitted = this.outputLines.length > before; if (!emitted && result
!== null …)`, donc **la valeur de retour d'une cmdlet est JETEE des que la
cmdlet a emis une seule ligne**. Emettre l'avertissement puis l'objet par
`ctx.emit` fonctionne mais rend l'objet par le formateur brut
(`ComputerName=zorglub.invalid; RemoteAddress=; …`) au lieu de la vue en
liste, ce qui est pire que l'absence d'avertissement.

**Choix fait** : `Test-NetConnection` REND l'objet et n'avertit pas ;
`RemoteAddress` vide et `PingSucceeded : False` disent deja que la
resolution a echoue, et aucune interface n'est inventee. `Write-Warning`
(`OutputCmdlets.ts`) a la meme limite et la contourne en n'ayant rien a
rendre.

**A rouvrir** avec un vrai flux d'avertissement dans `PSRuntime`, distinct
de la sortie — ce qui profiterait a toute cmdlet, pas seulement a
celle-ci.

### [nettcpip] `InterfaceMetric` est la constante 25

**Mesure** : `Get-NetIPInterface` rend `InterfaceMetric : 25` pour chaque
interface, quelle que soit la vitesse du lien. Windows calcule une
metrique AUTOMATIQUE depuis le debit (une carte a 1 Gbit/s ne porte pas la
meme qu'une carte a 10 Mbit/s), et `Set-NetIPInterface -InterfaceMetric`
la surcharge. La colonne est retiree du rendu plutot que d'annoncer un
nombre que rien ne mesure, et `-InterfaceMetric`/`-AutomaticMetric` sont
REFUSES en nommant la brique qui manque.

**Non corrige ici** : la table de correspondance debit → metrique est
publiee par Microsoft mais `learn.microsoft.com` est refuse par le
mandataire de sortie de ce reseau, et l'ecrire de memoire serait
l'invention que ce depot refuse. A rouvrir quand la table est atteignable.

### [nettcpip] `Get-NetConnectionProfile.Name` est l'alias de la carte

**Mesure** : le profil rend `Name : Ethernet 0`, c'est-a-dire le nom de la
CONNEXION. Sur une vraie machine `Name` est le nom du RESEAU — « Network »,
ou le nom du domaine quand la carte est `DomainAuthenticated` — et c'est
ce que `-Name` filtre. Les deux se confondent ici parce qu'aucune notion
de nom de reseau n'existe.

**Non corrige ici** : le deduire du domaine joint est faisable
(`WindowsPC` porte un modele de domaine) mais ne couvre pas le cas non
joint, ou Windows numerote les reseaux qu'il a vus (« Network 2 ») — un
etat persistant qui n'existe pas ici. Inventer l'un des deux serait pire
que la confusion actuelle, qui est au moins stable.

### [nettcpip] `Test-Connection` : dix parametres declares et lus par personne

**Mesure** : `-Delay`, `-BufferSize`, `-TimeoutSeconds`, `-Source`,
`-IPv4`/`-IPv6`, `-ResolveDestination`, `-Repeat`, `-Traceroute`,
`-MtuSize` et `-TcpPort` sont declares par la documentation de PowerShell
et lus par personne ; `Status` rend `Success`/`Failure` alors que le champ
est un `IPStatus`, dont `Failure` n'est pas une valeur (`TimedOut`,
`DestinationHostUnreachable`…).

**Non corrige ici** : les quatre jeux de parametres (`DefaultPing`,
`RepeatPing`, `TraceRoute`, `MtuSizeDetect`, `TcpPort`) sont un lot a
soi.

### [dnsclient] `Get-DnsClient`, `Set-DnsClient` et `Register-DnsClient` n'existent pas

**Mesure** : `grep` sur le registre de cmdlets ne trouve aucune de ces
trois ; les occurrences du nom dans le depot sont toutes des
sous-chaines de `Get-DnsClientServerAddress` et `Get-DnsClientCache`.
`Get-DnsClient` rend les proprietes DNS par interface (`Suffix`,
`RegisterThisConnectionsAddress`, `UseSuffixWhenRegistering`), dont la
matiere existe deja en partie (`WindowsPC` porte un suffixe DNS et
`ipconfig /all` l'affiche).

**Non corrige ici** : `Register-DnsClient` suppose la mise a jour
dynamique DNS cote client, que `src/network/dns/update/` sait faire cote
serveur — c'est donc un branchement reel et non une invention, mais il
touche l'enregistrement A/PTR d'un hote et son interaction avec le role
serveur DNS de Windows, ce qui est un lot a soi.
### [powershell] `netsh wlan add profile` ne lit pas le XML du profil

**Mesure** : `netsh wlan add profile filename="C:\temp\quoi-que-ce-soit.xml"`
repond « Cannot find the file » pour tout nom de fichier autre que
`test-wifi.xml`, seul profil modelise, enregistre sous le nom `TestWiFi`.
Le vrai `netsh` lit le fichier, y trouve `<name>` et `<SSID>`, et
enregistre le profil sous CE nom.

**Pourquoi ce n'est pas ferme ici** : `WinCommandContext` — le contexte
que tous les `netsh` recoivent — ne porte AUCUN acces au systeme de
fichiers. Lire le XML demande d'y ajouter un port de lecture, ce qui
touche tous les sous-contextes de `netsh` ; c'est un lot a soi. En
attendant, le seul profil connu est declare comme tel plutot que
d'accepter n'importe quel nom en pretendant l'avoir lu.

### [powershell] la mise en page de `netsh winhttp` n'est pas verifiee sur transcription

**Mesure** : deux ecritures de `netsh winhttp show proxy` coexistaient —
celle de `WinNetsh` (deux espaces d'indentation, pas de ligne vide) et
celle de l'executeur PowerShell (quatre espaces, ligne vide apres
l'en-tete). La seconde est supprimee comme doublon ; la premiere reste
donc la seule. Laquelle correspond a la vraie sortie de Windows n'a pas
pu etre tranchee : la documentation de Microsoft ne publie que la
grammaire, et les pages qui portent une transcription
(`documentation.n-able.com`, `parsiya.net`, `learn.microsoft.com`) sont
toutes bloquees par le proxy de sortie. Aucune des deux n'a donc ete
choisie sur autorite — on a garde celle qui vit avec ses tests, et la
question reste ouverte.

### [powershell] pas de canal de controle de services / de processus a distance

**Mesure** : `Get-Service -ComputerName <autre machine>` et
`Get-Process -ComputerName <autre machine>` sont REFUSES, en nommant la
brique : il n'y a pas de canal SCM ni de canal de processus a distance
dans ce simulateur. Le parametre etait auparavant ACCEPTE et IGNORE, si
bien qu'une supervision interrogeant un second contrôleur de domaine
lisait en fait les services de la machine locale et concluait « tout va
bien » — le pire des trois cas de la regle 6.
`scenario-ad-health-monitoring` mesure desormais la consequence : les six
services du DC distant comptent comme inaccessibles.

**Ce qu'il faudrait** : un vrai dialogue (RPC/WinRM) entre les deux
machines, sur le fil, comme le reste du projet — pas un raccourci qui
appellerait la methode de l'objet distant.

### [powershell] `Test-Connection` sur un hote injoignable : ligne ou erreur ?

**Mesure** : le simulateur rend UNE LIGNE par tentative, portant
`Status : Failure`, et `-Quiet` rend `False`. Un vrai PowerShell 5.1
semble plutot lever `Test-Connection : Testing connection to computer 'x'
failed: Error due to lack of resources` et ne rien rendre. La bascule a
ete essayee : elle casse les ateliers AD qui lisent les lignes
(`scenario-ad-fsmo-roles`), et surtout **aucune transcription n'a pu etre
atteinte** pour trancher — la documentation de Microsoft ne publie pas la
sortie d'echec, et les pages qui la portent sont bloquees par le proxy de
sortie. Le contrat en place est donc conserve, et la question reste
ouverte.

### [powershell] quatre criteres REFUSES faute de la brique en dessous

**Mesure** : ce lot a ferme quatre parametres qui etaient ACCEPTES et
IGNORES — le pire des trois cas de la regle 6, l'apparence sans l'effet.
Chacun rend desormais un refus qui NOMME la brique absente :

- `Get-Process -Module` / `-FileVersionInfo` : un processus du simulateur
  ne porte pas de liste de modules charges, ni de bloc de version de
  fichier. Il faudrait que `ProcessInfo` porte l'image et ses
  dependances.
- `New-Item -ItemType SymbolicLink` / `HardLink` / `Junction` :
  `SimulatedFileSystem` n'a pas de notion de lien — un chemin y designe
  un seul noeud. Il faudrait un type de noeud « lien » et sa resolution
  dans chaque lecture.
- `Initialize-Disk` : un disque du simulateur est derive du systeme de
  fichiers et ne porte AUCUNE table de partition ; il n'y a rien a
  initialiser.
- `Format-Volume` : un volume EST le systeme de fichiers de la machine ;
  le formater reviendrait a l'effacer.

**Consequence tenue** : aucune de ces cmdlets ne declare
`supportsShouldProcess`. Annoncer « What if: Performing the operation … »
pour un geste que le moteur ne sait pas poser serait exactement la meme
apparence sans l'effet, dans l'autre sens — les deux tests qui
l'attendaient epinglaient une invention du moteur mort et sont corriges.

### [logging] `logging host` ne porte ni `vrf`, ni `xml`, ni `filtered`, ni `session-id`
La commande declaree — et evaluee — est `logging [host] <ip>
[discriminator <nom>] [transport {udp|tcp} [port <1-65535>]]`. La
documentation Cisco decrit en plus, sur les plateformes recentes,
`vrf <nom>`, `xml`, `filtered [stream <id>]`, `sequence-num-session`
et `session-id {hostname|ipv4|ipv6|string <texte>}`.
**Mesure** : `logging host 10.0.0.1 vrf V1` repond `% Invalid input
detected at '^' marker.`, comme les quatre autres.
**Ce qui a ete cherche** : `cisco.com` est BLOQUE par le mandataire de
sortie de ce reseau (`EGRESS_BLOCKED` sur
`/c/en/us/td/docs/ios-xml/ios/esm/command/esm-cr-book/esm-cr-a1.html`),
et le resume d'un moteur de recherche nomme ces mots-cles sans donner
leur grammaire exacte ni leur effet.
**Report** : declarer une place dont on ne connait ni la forme ni
l'effet, c'est la faire accepter puis ne rien en faire — exactement le
defaut que la migration referme partout ailleurs. Le refus actuel dit
la verite : la plateforme ne les porte pas. A rouvrir des que la
reference est atteignable.

### [cli] le garde-fou des `<cr>` n'entrait dans aucun sous-mode — TOUS FERMES
`probe-aide-cr-tient-sa-promesse` balayait trois modes : `show` en EXEC
privilegie, la configuration globale et celle d'interface. Aucun
sous-mode. Promene dans huit d'entre eux, le meme balayage a trouve 77
`<cr>` annonces pour des frappes que la machine refuse par
`% Incomplete command.` — le defaut exact que ce garde-fou existe pour
empecher, dans les endroits ou il ne regardait pas.
**Mesure** (routeur Cisco, profondeur 3, un materiel neuf par
validation) :
- `config-router-ospf` 20 — FERMES, et le mode est desormais balaye.
  Le balayage en avait compte VINGT-ET-UN, un de plus que la mesure
  d'origine : `area filter-list`, annonce au rang de l'identifiant
  d'aire.
- `config-line` 13 — FERMES, et le mode est desormais balaye. Le trie
  y etait deja vide : les treize venaient de places DECLAREES
  facultatives (`exec-timeout`, `login-timeout`, le protocole de
  `transport`) et de trois mots-cles qui ouvrent une famille sans etre
  une commande (`transport`, `accounting`, `authorization`).
- `config-router-eigrp` 6, `config-router-bgp` 5, `config-dhcp` 2 —
  FERMES. Le balayage en a compte VINGT dans ces modes plutot que
  treize : RIP en portait cinq que la mesure d'origine n'avait pas
  vus, et le pool DHCP deux de plus (`utilization mark high` et `low`).
  Les huit sous-modes sont desormais balayes, et le compte est zero.
- `config-view` 4, `config-route-map` 24 et `config-acl-ext` 3
  (`sequence`, `sequence deny`, `sequence permit`) — FERMES. Les quatre
  sous-modes correspondants sont desormais balayes : les deux vues, et
  les deux sortes de liste d'acces nommee. Le mot-cle `sequence` n'a pas
  ete corrige mais SUPPRIME — la documentation Cisco ne le donne pas
  pour ce sous-mode, ou le numero s'ecrit nu en tete de l'entree.
`config-class-map`, `config-policy-map`, `config-keychain` et
`config-vrf` en comptent zero : ils sont deja declares sur le socle.
**Cause** : un noeud du trie porte une action et aucun parametre
declare, donc son arite minimale vaut zero, donc `?` annonce qu'on peut
valider. Le socle, lui, la deduit des places declarees.
**Report** : poser 73 `requireArgs` sur un trie qu'on vide serait
ecrire une seconde fois ce que chaque gestionnaire sait deja, sur un
moteur qui doit disparaitre. Chaque famille migree en ferme son lot,
et le sous-mode entre alors dans le balayage — l'y faire entrer avant
epinglerait le defaut au lieu de le mesurer.

### [acl] l'invite d'une ACL ARP emprunte celle d'une liste IP ETENDUE
Les listes IP ont desormais leurs deux sous-modes des DEUX cotes
(`config-std-nacl`, `config-ext-nacl`). Le mode `config-acl` du
commutateur ne sert donc plus qu'a `arp access-list` — mais il rend
toujours `{host}(config-ext-nacl)#`, l'invite d'une liste IP etendue.
**Mesure** : `arp access-list AA` sur un Catalyst rend
`SW1(config-ext-nacl)#`.
**Ce qui a ete cherche** : cisco.com est BLOQUE par le mandataire de
sortie de ce reseau, et rien d'atteignable ne donne le texte que
Catalyst affiche pour ce sous-mode.
**Report** : remplacer une invite fausse par une invite INVENTEE ne
serait pas un progres — la premiere se voit, la seconde se croit. A
fermer des que la reference est atteignable.

### [tests] `wan-vpn-tests` 15.09 tombe par intermittence dans un grand balayage
`15.09 — Huawei BR3 routing should remain intact with VPN config` a
rendu `expected '…' to contain '0% packet loss'` une fois sur deux
passages du MEME jeu de 234 fichiers.
**Mesure** : seul, il passe des deux cotes ; dans le grand balayage il
est tombe au premier passage sur la branche, et pas au second, ni sur
le meme jeu joue sur la base. Un `ping` qui perd des paquets n'est pas
un depassement de delai — `pingOnSimulatedClock` lui prete deja une
horloge virtuelle, et `advanceUntilSettled` est borne en TOURS, pas en
secondes. La piste la plus probable est un etat partage entre fichiers
d'un meme worker : `beforeEach` y remet a zero les generateurs de noms
et de MAC, ce que `setupGlobalState` fait deja, et deux remises a zero
peuvent redonner a un equipement une adresse qu'un autre porte encore.
**Report** : un cas qui tombe une fois sur deux ne dit pas ce qu'il
mesure. Le stabiliser demande de trouver le fichier avec lequel il se
couple, ce qui est un lot en soi — et il ne bloque aucun autre travail
tant qu'il est nomme ici.


### [nat64] ce qui reste : le `status` de `config system nat64` et une commande de routeur
`Nat64Translator` (RFC 6146/7915) tourne sur le plan de donnees d'un `Router` (API `enableNat64`, pas de
commande : aucune documentation Cisco ou Huawei du NAT64 n'est dans `official_docs`) et sur le FortiGate
(politique `set nat64 enable` + `ippool enable` + pool `set nat64 enable`, prefixe, `secondary-prefix-status`
et `secondary-prefix` de `config system nat64`, documentes dans `official_docs/forti-cli-ref-767.txt` et
`forti-cli-ref-60.txt`). DNS64 est cable dans `named` (listes `clients`/`mapped` IPv4 et IPv6, client IPv6
venu du fil). Les fragments sont traduits dans les deux sens et refragmentes pour tenir dans le MTU IPv6 ;
les MTU des prochains sauts entrent dans le calcul des erreurs.
**Reste** : (1) le `status` de `config system nat64` (FortiOS 6.0, « default = disable ») n'est pas lu :
la reference 7.6.7 ne documente plus cette table, et la porter comme une porte fermerait par defaut un
NAT64 que les politiques 7.6 pilotent seules ; (2) un fragment qui precede son premier fragment est jete,
alors que la RFC 6146 autorise de le mettre en file ; (3) aucune commande Cisco/Huawei de NAT64, faute de
documentation constructeur.


### [auditd] ce que le demon et autrace ne font pas encore
`auditd.conf` est lu par un seul analyseur (`audit/daemon/AuditdConfig.ts`, port de `auditd-config.c`), le demon
applique rotation, actions d'espace, ENRICHED, `log_group` et signaux (`audit/daemon/AuditdLogWriter.ts`, port de
`auditd-event.c`), le dispatcher audisp lance `audisp-syslog` et `audisp-af_unix` (`audit/daemon/dispatch/`).
La commande `auditd` (`-f -l -n -s -c`, `audit/tools/AuditdCommandTool.ts`, port du `main` de `auditd.c`) demarre le
demon a la main, ecrit `/var/run/auditd.pid` et refuse de reprendre le noyau a un demon deja inscrit
(`Unable to set audit pid, exiting` + `DAEMON_ABORT`). `autrace` (`audit/tools/AutraceTool.ts`, port de `autrace.c`)
pose les regles `pid=N` et `ppid=N`, execute le programme comme enfant sous ce pid et nettoie.
Le binaire reel n'a pas pu etre lance (il exige l'ecriture de `/etc/audit`) : l'oracle est le source 3.1.2.
**Reste** : (1) `auditd -f` et `-n` gardent le terminal (flux du terminal, messages en direct) mais Ctrl-C rend l'invite
alors que le vrai auditd ignore SIGINT : il faut le tuer depuis une autre session ; le daemon, lui, continue ; (2) `autrace` et toute regle `exit` voient maintenant tous les appels systeme de `cat`, `ls <repertoire>`,
`stat`/`head`/`tail`/`wc`/`md5sum`/`sha256sum <fichier>`, `whoami`, `hostname` et `uname` (rejeu de la trace strace du binaire reel, `audit/trace/ProgramTraces.generated.ts`,
produit par `scripts/oracle/record_syscall_traces.py`) ; les autres commandes, `ls` sans operande ou avec option,
et `exit_group` gardent le seul execve/openat projete (exit_group : le noyau l'ecrit par audit_free sans success ni
exit, ce que ce conteneur ne permet pas de verifier) ; (3) le « Cannot daemonize » du parent lors d'un second demon n'est pas emis (son errno
est indetermine dans le source) ; (4) un plugin dont le programme est un script recoit les evenements, mais l'interprete de scripts est synchrone : le
script est relance une fois par evenement avec la ligne pour entree standard, sous le pid du processus plugin, de sorte
que ses variables ne survivent pas d'un evenement a l'autre et qu'un evenement produit par le plugin lui-meme n'est pas
re-remis a ce plugin (garde contre la recursion) ; `nc -U` ne sait que se connecter (client) : `nc -lU` et `nc -uU` restent refuses, et seul `audisp-af_unix` ecoute une socket UNIX en flux ; la file du dispatcher (`q_depth`, `overflow_action`, profondeur dans `/var/run/auditd.state`) est evaluee, mais la capacite du tube d'un plugin arrete (tampon d'envoi 212992 octets, 576 octets de surcout par message) vient de la disposition du noyau Linux et n'a pas ete verifiee par execution : seule l'existence d'une borne est sondee, pas sa valeur. `poweroff.target` et `halt.target` arretent les unites sans eteindre la machine : le simulateur n'a pas d'etat « eteint » distinct d'un redemarrage de services.

### [rsyslog] impstats, dyn_stats et percentile_stats : limites mesurees
`statsobj`, `impstats`, `dyn_stats`/`dyn_inc()` et `percentile_stats`/`percentile_observe()` sont portes de rsyslog 8.2112.0, puis `impstats`
et `statsobj` realignes sur 8.2608.0 (formats `prometheus` et `zabbix`, `log.file.overwrite`) (`engine/Statistics.ts`, `DynStats.ts`, `PercentileStats.ts`, `modules/Impstats.ts`). Ce qui reste :
la persistance de `dyn_stats` : l'ecriture est synchrone et sans fichier temporaire (l'hote n'a pas `rename`) ; les parametres `push.*` d'`impstats` n'existent que sous l'option de
compilation ENABLE_IMPSTATS_PUSH et ne sont pas portes ; `log.file.overwrite` remplace le contenu du fichier en une ecriture
(l'hote n'offre pas `rename`, donc l'inode ne change pas) ;
les statistiques par expediteur (`_sender_stat`) ne sont alimentees que par `imtcp` (le source alimente aussi `imptcp`, absent ici) ; `resource-usage` ne fournit que
utime (temps CPU du processus), maxrss (taille residente courante, pas le maximum) et openfiles - stime, minflt, majflt, inblock,
oublock, nvcsw et nivcsw valent 0 faute de comptabilite correspondante dans le simulateur (le chemin `getrusage` en echec du
source les met aussi a 0) ; `imudp(w<n>)` attribue toute reception au worker 0, la livraison etant synchrone ; imklog, immark,
omusrmsg n'ont pas d'objet de statistiques dans 8.2608.0. Ecarts assumes avec le source : un `percentile_stats` sans
`windowsize` d'au moins 2 est refuse au chargement (le source construit un tampon circulaire de taille 0 ou 1 dont le premier ajout
echoue sur un assert) ; le tri des percentiles compare les entiers 64 bits, la ou le source soustrait puis tronque a `int` (un ecart superieur a 2^31 entre
deux observations y ordonne mal) ; un percentile 0 vaut l'indice 0, la ou le source convertit -1.0 en entier non signe.

### [rsyslog] ratelimit() : limites du lecteur YAML, de policyWatch et de la creation des limiteurs
`ratelimit()` est porte de rsyslog 8.2608.0 (`engine/SharedRateLimit.ts`, `PerSourceRateLimit.ts`, `RateLimitPolicy.ts`, `YamlEvents.ts`) :
fichier de politique YAML, perSource, portee entree/sortie, drop/pace, rechargement par HUP et par policyWatch. Ce qui reste :
`YamlEvents.ts` lit le sous-ensemble de YAML que ces fichiers emploient (collections en bloc et en flux, scalaires entre quotes) ; ancres,
etiquettes, scalaires multi-lignes et scalaires en bloc (`|`, `>`) ne sont pas lus, et seuls les messages d'erreur libyaml des cas courants
sont reproduits ; policyWatch repose sur les evenements d'ecriture, de renommage vers le chemin et de `chmod` du VFS (`onWrite`, `onEntryChange`) ;
`chown`, `touch` sans ecriture et la creation d'un lien n'en emettent pas ; le suivi d'etat par source (`perSourceMaxStates`) repartit les cles sur 32 coquilles par le hachage du
source (`engine/HashTable.ts`), la reconstitution exacte d'une eviction depend donc de ce hachage ; les statistiques d'expediteur
(`global(senders.keepTrack)`) restent a porter.

### [rsyslog] `action.errorfile` et `action.externalstate.file` : le moteur n'a pas la phase de commit de la source
Les deux parametres sont evalues (`engine/ActionRuntime.ts`) : le fichier d'etat externe suspend l'action avant chaque message et la
relance quand il ne dit plus `SUSPENDED` ; le fichier d'erreurs recoit une ligne JSON par message perdu et le compteur `failed`
suit. Ce qui reste : le moteur execute `doAction()` message par message, la ou la source collecte les messages d'une transaction
et les valide ensemble ; le fichier d'erreurs est donc alimente a la fin du lot et non par la phase de commit, qui rejoue chaque
message d'un lot en echec isolement avant de l'ecrire (le module voit un essai de plus dans la source) ; le code de statut ecrit
vient de `ActionWorker.failureCode()` (omfile seulement : `-2127` fichier desactive, `-2125` sans commande de limite de taille,
`-2218` sinon) ; l'ordre « le fichier dit SUSPENDED, les essais sont epuises, le message est quand meme traite » reproduit la
source, qui appelle `beginTransaction()` apres `actionDoRetry_extFile()` quel que soit l'etat.

### [rsyslog] parametres `global()` et de file d'attente acceptes mais sans effet
Releve par comparaison du descripteur de `global()` (`engine/Settings.ts`) avec ce que le chargeur applique, puis du source 8.2608.0.
Acceptes et jamais lus : `abortOnFailedQueueStartup` (action.c : le demon s'arrete si une file d'action ne demarre pas),
`reportChildProcessExits` (glbl.c : `none`, `errors`, `all` pour les sorties des programmes lances),
`inputs.timeout.shutdown`, `shutdown.queue.doubleSize`, `compatibility.configFormat.legacy|syslogd|property`, `systemd.notifyReadyDelay`, `shutdown.enable.ctlc`,
`allMessagesToStderr`, `errorMessagesToStderr.maxNumber`, `stdlog.channelSpec`, `defaultOpensslEngine`, `internal.developerOnly.options`,
`libcapng.default` et `libcapng.enable` (options de compilation), et la famille `debug.*` (`onShutdown`, `logFile`, `gnutls`,
`abortOnProgramError`, `unloadModules`, `files`, `whitelist`), dont les effets n'existent qu'en mode debug, que le simulateur n'a pas.
Les reglages de file `queue.timeoutShutdown`, `timeoutActionCompletion`, `timeoutEnqueue`, `workerThreadShutdown`, `highWatermark`,
`lowWatermark`, `workerThreads`, `workerThreadMinimumMessages`, `checkpointInterval`, `syncQueueFiles`, `maxFileSize`, `maxDiskSpace`,
(et leurs `default.action.queue.*` / `default.ruleset.queue.*`) sont lus par le chargeur mais la file du
moteur (`engine/Queue.ts`) est synchrone et sans disque : seuls `size`, `discardMark`, `discardSeverity`, `dequeueBatchSize`,
`dequeueSlowdown`, la fenetre `dequeueTimeBegin/End` et, pour `fileName` + `saveOnShutdown`, la sauvegarde des messages en attente a l'arret (un seul document JSON `<WorkDirectory>/<fileName>.qi`, et non le flux d'objets de la source) decident. Une file « disk » ou « disk-assisted » se comporte donc comme
« linkedlist » en memoire.

### [journald] `journald.conf` n'est pas lu : tailles, rotation, retention, transfert sont figes
Mesure : `LinuxJournald` ne lit ni `/etc/systemd/journald.conf` ni ses `.d` (`MAX_USE` et `KEEP_FREE` sont des constantes de
`LinuxJournald.ts`, `JournaldSettings` ne porte que MaxLevelStore, LineMax et ForwardTo*), et `/usr/lib/systemd/journald.conf.d/syslog.conf`
(drop-in Ubuntu) n'est pas pris en compte. Les cles que le binaire 255.4 connait (relevees dans `systemd-journald`) : Storage,
Compress, Seal, SplitMode, RateLimitIntervalSec/Interval, RateLimitBurst, System/RuntimeMaxUse, System/RuntimeKeepFree,
System/RuntimeMaxFileSize, System/RuntimeMaxFiles, MaxFileSec, MaxRetentionSec, SyncIntervalSec, ForwardToSyslog/KMsg/Console/Wall,
TTYPath, MaxLevelStore/Syslog/KMsg/Console/Wall, LineMax, ReadKMsg, Audit. Mesure sur un vrai journal de ce conteneur
(`journalctl --header`, disque de 252 Go) : fichier de 8,0 Mo (8388608), arene 8388336, table de hachage des donnees 233016, soit
`SystemMaxFileSize` = 128 Mo (plafond) ; le modele actuel reproduit ce cas, et seulement ce cas : la taille du fichier croit par pas de
8 Mo, et la taille maximale (1/8 de `SystemMaxUse`, lui-meme 10 % du systeme de fichiers plafonne a 4 Go) change la table de
hachage et declenche la rotation puis le vacuum. Non ferme parce que ces comportements ne se mesurent qu'en lancant le vrai
`systemd-journald` sous une configuration non par defaut, ce qui exige d'ecrire sous `/etc/systemd` et de lancer un demon en root dans
le conteneur - l'action que ce depot refuse deja pour auditd - et que la source de systemd 255.4 n'est pas disponible ici.

### [mpls] la mise en forme de `traceroute -e` et des sauts MPLS Cisco n'est pas rendue
Le plan de donnees MPLS (RFC 3032/3443) renvoie bien l'objet « MPLS Label Stack »
de la RFC 4950 dans l'ICMP time-exceeded, et la sonde de `executeTraceroute` le
porte jusqu'a `TracerouteProbeResult.extensions`. Aucun rendu n'en est fait :
ni la disposition de `traceroute -e` (Linux), ni celle de `traceroute` IOS
(`[MPLS: Label 17 Exp 0]`) ne sont lisibles dans un texte de reference de ce
depot (la RFC 4950 n'illustre que la sortie generique de sa figure 1).
**Pourquoi ce n'est pas ferme** : CLAUDE.md §8 interdit de reconstituer de
memoire un format de sortie. A reprendre avec une capture reelle.
**Egalement non code** : l'octet-a-octet de la structure d'extension ICMP
(en-tete, checksum, champ de longueur) - la RFC 4884 qui la definit n'est pas
dans `docs/rfc/mpls`.

### [mpls] les vues `show mpls ...` : contenu du livre Cisco, mise en page des transcriptions
Le contenu et les arguments des vues suivent maintenant `official_docs/cisco/mp-cr-book.pdf`
(voir `[cli-mpls]`). La mise en page absolue (indentation 4/8/10 espaces de `ldp neighbor`,
largeur des cellules d'adresses, `Up time` au-dela d'un jour) reste celle des lignes d'exemple
d'IOS-XE citees par `genie.libs.parser` : le texte du PDF perd l'indentation.
**Pourquoi ce n'est pas ferme** : CLAUDE.md §8 - une capture integrale d'IOS est
necessaire pour trancher l'indentation ; le livre ne porte pas non plus la sortie de
`traceroute` avec l'objet « MPLS Label Stack » de la RFC 4950.

### [ldp] le reste de la RFC 5036
Mode Downstream on Demand : sert en controle independant et ordonne (requete,
abandon, No Route avec nouvel essai apres 60 s, requete en attente), mais
chaque LSR demande l'etiquette pour son propre compte des qu'il a un saut
suivant (« Request When Needed » reduit a « toujours »), donc un Label Abort
Request recu n'est pas propage vers l'aval, et la propagation d'une requete
avec Hop Count / Path Vector (§2.8.1) n'est pas construite. La detection de
boucle sur Label Mapping (§2.8.2) est servie en mode non sollicite et
sollicite, avec un vecteur de chemin toujours inclus quand elle est negociee
(le texte l'autorise) et sans remise a 1 du compteur aux frontieres ATM/Frame
Relay. Absents aussi : TCP MD5 (§2.9), sessions par interface (ATM/Frame
Relay) et Label Release sur retention conservatrice. La retention liberale,
la distribution non sollicitee et la decouverte etendue (Targeted Hello) sont
implementees.

### [vrf] le cache ARP est indexe par adresse IP
Deux VRF d'un meme PE qui portent la MEME adresse de voisin PE-CE sur deux
interfaces partagent une entree ARP : le second voisin reutilise la MAC du
premier. Les prefixes clients qui se chevauchent sont, eux, isoles (une table
par VRF). **Pourquoi ce n'est pas ferme** : `Router.arpTable` est une
`Map<string, ...>` lue par une centaine d'appelants ; l'indexer par
(interface, adresse) est un chantier a part.

### [l3vpn] le reste de la RFC 4364
Import local VRF vers VRF sur un meme PE, reflecteurs de routes (§4.3.3) et
inter-AS (§10), une etiquette VPN par prefixe seulement (pas par VRF ni par
CE), pas de vues `show bgp vpnv4 unicast`, pas de protocole PE-CE autre que
le statique et le connecte. **Pourquoi ce n'est pas ferme** : chantier de
fond sur le moteur BGP ; les RFC 4760 et 5492 (multiprotocole, capacites) ne
sont pas dans `docs/rfc/mpls/` : le codage MP_REACH/MP_UNREACH suit la seule
RFC 4364.

### [mpls-oam] le reste de la RFC 8029
Le traceroute LSP avec Downstream Detailed Mapping (§3.4, §4.4, §4.6) est
servi sur LDP et sur la pile L3VPN : `Router.getMplsOam().traceroute(fecs)`.
Restent absents : les types d'adresse IPv6 et non numerotes (un DDMAP qui en
porte un est refuse comme TLV obligatoire non pris en charge, jamais ignore),
l'ECMP (le sous-TLV Multipath est toujours de type 0 et l'information recue
n'est pas evaluee : un routeur ici n'a qu'un saut suivant), le drapeau V
(Validate FEC Stack) sur un routeur de transit (le egress valide toujours la
pile FEC), et tout routeur qui emette un FEC stack change (pas de LSP recousu
ni hierarchique hors du VPN) ; le cote origine de l'algorithme du §4.6 est
couvert sur des entrees fabriquees. Les FEC RSVP, pseudo-wire (128 et 129,
types 10 et 11 de la section 3.2.9 et 3.2.10), BGP etiquete et IPv6 sont
decodees comme `unsupported` et jamais validees, le Reply Mode 4 (pas de canal
de controle applicatif : aucune reponse n'est envoyee) n'est pas servi, ni le
Router Alert sur une reponse traversant un LSP, ni la commande `ping mpls` /
`traceroute mpls` : le format de sortie IOS n'est pas source (CLAUDE.md §8).

### [pseudowire] le reste des RFC 4447 / 4448
Seul le type 5 (Ethernet, mode brut) sur circuit d'acces par port est servi :
le type 4 (mode tagge, TLV 0x06) exige des circuits d'acces par VLAN. La FEC
generalisee 0x81 avec AGI/SAII/TAII est servie par le VPLS. Le numero de
sequence du mot de controle est emis a 0 (verification desactivee). Le mot de
controle se choisit par l'API (`controlWord`), sans commande IOS faute de
pseudowire-class (`xconnect <ip> <vcid> encapsulation mpls` est servi, sans
`pw-class`). Le type de sous-TLV d'interface 0x01 (MTU) vient du registre
IANA, absent de `docs/rfc/mpls/`. Les formats `show mpls l2transport vc` et
`show xconnect all` ne sont pas servis : seul leur texte de ligne est source
(genie), ni l'ordre ni les decalages. Une adresse IP sur le circuit d'acces est
ignoree (le trafic contourne la couche 3) au lieu d'etre refusee.

### [rsvp-te] RFC 3209, 4090, 4124, 5712 : la base RSVP manque
RSVP-TE (tunnels LSP, FRR, DS-TE, preemption douce) etend RSVP (RFC 2205), dont
le texte n'est pas dans `docs/rfc/mpls/` et reste injoignable depuis cet
environnement (rfc-editor.org et datatracker.ietf.org repondent 403 au proxy).
Le format de l'en-tete commun, des classes d'objet, de SESSION, RSVP_HOP,
TIME_VALUES, ERROR_SPEC, STYLE et des Tspec vient de la RFC 2205 : CLAUDE.md §8
interdit de le reconstruire de memoire. A reprendre quand cette RFC est fournie.

### [vpls] le reste de la RFC 4762
Pas de commande IOS (`l2 vfi`, `bridge-domain`, `xconnect vfi`) : l'API est
`Router.getVplsEngine()`. Le mode tagge (type 4) et l'apprentissage non
qualifie sont absents, comme la hierarchie H-VPLS (§10-§11), la double
attache et les ressources de decouverte (BGP / RADIUS). Le TLV de groupage
PW (0x096C) et les retraits generiques (longueur d'information 0) de la FEC
generalisee sont refuses a l'analyse plutot qu'ignores. Le type d'AGI 1
vient du registre IANA, absent de `docs/rfc/mpls/`.

### [vpls-bgp] le reste de la RFC 4761
Seul le cas iBGP en maillage complet avec un VE par instance et par PE est
servi : pas de route reflector, pas de multi-AS (§5, options a/b/c), pas de
double attache ni de selection de VE (D-bit, preference locale du §3.2.4), un
seul bloc d'etiquettes de 8 VE commencant au VE-ID 1, pas de numero de
sequence (un pair qui annonce S=1 laisse le pseudo-fil hors service) et pas d'etiquette de
decouverte `vpls` dans la CLI : l'API est `Router.getVplsEngine().defineBgp`
et le drapeau `vpls` du voisin BGP. Les valeurs du registre IANA (AFI 25,
SAFI 65, type de communaute 0x800A) viennent du corps de la RFC.

### [mpls-mib] RFC 3811, 3812, 3813 (MPLS-TC, MPLS-TE, MPLS-LSR)
Non implementees : le MIB LSR expose des lignes `ifTable` de couche MPLS
(ifType 166) que ni `Router` ni le moteur SNMP ne portent, et plusieurs tables
(`mplsInSegmentTable`, `mplsXCTable`) exigent de rendre le LFIB sous la forme
d'index entiers stables. A reprendre en ajoutant d'abord les interfaces MPLS
a l'`ifTable`, puis un module MIB lisant `Lfib` (jamais une copie).

### [mpls-multicast] RFC 5331, 5332 (etiquettes assignees en amont, encapsulation multicast)
Non implementees : une etiquette assignee en amont n'a de sens que dans un
contexte (RFC 5331 §3) fourni par un consommateur (mVPN, PIM sur MPLS, LSP
multipoint) que ce depot ne porte pas encore ; l'ethertype 0x8848 existe
(`ETHERTYPE_MPLS_MULTICAST`) mais aucun emetteur ne le choisit. A reprendre avec
le premier consommateur, pas avant : un contexte sans usage serait un critere
stocke et jamais evalue. Les RFC 3034, 3035, 3037 (FR, ATM, applicabilite LDP) et
5462 (renommage EXP en TC, deja suivi dans le vocabulaire) n'ajoutent aucun
comportement a simuler.

### [cli-mpls] le reste des vues MPLS du livre Cisco (mp-cr-book.pdf)
Servies : `show mpls ldp neighbor|discovery|bindings|parameters|capabilities|backoff`,
`show mpls label range`, `show mpls forwarding-table` (filtres, lignes VPN
`[V]`, detail) et `show mpls interfaces [detail]`. Absentes : les variantes
`vrf` / `all` (le LDP ici ne tourne pas par VRF), la plage `labels N - N`,
les lignes `Password:` (pas de TCP MD5) et le graceful-restart, `show mpls ldp
igp sync`, `show mpls ldp checkpoint`. Le texte du PDF perd l'indentation et la
ligne des « Targeted Hellos » de l'exemple : la forme suit le tableau des
champs du livre. `show mpls ldp capabilities` ne liste rien parce que ce LSR
n'annonce aucun TLV de capacite.

### [cli-mpls-config] les commandes de configuration MPLS du livre non evaluees
Servies et evaluees : `mpls ldp advertise-labels [for A [to B]]` (premiere regle dont
l'ACL de prefixe autorise, ACL de pairs sur le router-id LDP) et `mpls ldp neighbor A
labels accept ACL` (ACL standard evaluee sur l'adresse du prefixe ; une ACL inexistante
refuse, securite fermee) ; `mpls label range`, `mpls ldp loop-detection | maxhops |
path-vector maxlength | holdtime | backoff | explicit-null` et les minuteries
`discovery hello | targeted-hello`. Refusees faute de moteur : la forme `static`
de `mpls label range` (aucune liaison statique `mpls static binding ipv4`), les
formes `for` / `to` de `explicit-null`, `advertise-labels vrf | interface`,
`neighbor vrf ... labels accept`, `mpls request-labels for` et `mpls ldp
discovery transport-address`, `session protection`, `igp sync`, `graceful-restart`
et les mots de passe MD5. Un `mpls label range` qui chevauche la plage utilisee
est applique immediatement, comme le livre l'autorise pour les logiciels a MFI,
y compris quand elle ne chevauche pas (le livre exige alors un rechargement).
Le livre dit de `loop-detection` et `maxhops` qu'ils servent le mode Downstream on
Demand des commutateurs ATM : ici ils pilotent aussi le mode non sollicite.

### [cli-mpls-oam] le reste de `ping mpls` / `traceroute mpls` du livre
Servis : `pseudowire A VCID` (FEC 128 de la RFC 8029 §3.2.9, validee a la sortie) et la cible `ipv4 A/M` avec `repeat`, `size`, `timeout`, `ttl`, `exp`,
`reply mode | dscp | pad-tlv`, `dsmap` et `verbose` pour le ping ; `timeout`,
`ttl`, `exp` et `reply ...` pour le traceroute. Absents (refuses, jamais
acceptes sans effet) : `pseudowire ... segment` (pas de pseudo-fil multi-segments), la
FEC 129 et les FEC IPv6, `traffic-eng` et `tp`, `source`, `interval`, `sweep`, `pad`,
`force-explicit-null`, `output`, `revision`, `flags fec`, `hashkey`,
`destination` (plages 127/8) et `traceroute mpls multipath`. Une seule clause
`reply` par commande : le sac d'options ne propose un mot-cle qu'une fois,
alors qu'IOS accepte `reply mode ... reply dscp ...`. Le mode interactif
(`ping` puis `Protocol [ip]: mpls`) n'existe pas. Les temps aller-retour sont
ceux de `PathClock` : quelques microsecondes, donc `0/0/0 ms` en LAN.
Les lettres `L` et `B` du bloc Codes ne sont pas produites : `B` pour le code
9, `L` jamais (le livre ne dit pas a quel code elle correspond).

### [cli-mpls-l2vpn] le reste des commandes L2VPN du livre
Servies : `pseudowire-class` (encapsulation mpls, control-word), `xconnect A N
pw-class C` et `encapsulation mpls [pw-class C]`, `xconnect vfi V`, `l2 vfi V manual`
avec `vpn id` et `neighbor A encapsulation mpls`, `show mpls l2transport vc
[detail]`, `show xconnect all | peer | interface [detail]`, `show vfi [name V]`.
Refusees faute de moteur : `neighbor ... no-split-horizon` (l'horizon partage est
toujours actif), `encapsulation l2tpv3`, les pseudo-fils statiques `manual` et
`mpls label`, `preferred-path`, `sequencing`, `interworking`, la decouverte
automatique (`l2 vfi ... autodiscovery`), `bridge-domain` / `member`, `l2vpn xconnect
context`, `show mpls l2transport binding | summary | checkpoint`, `show l2vpn atom`.
L'attachement est un port routeur, pas un VLAN ni une instance de service : la
colonne « Local circuit » affiche toujours Ethernet. Les statistiques VC comptent
les trames Ethernet (octets sans FCS), pas des paquets MPLS. `Create time` et `last
status change time` sont des durees depuis l'evenement, mesurees quand un evenement de
signalisation ou une lecture observe le changement d'etat.

### [cli-mpls-l3vpn] le reste des vues L3VPN du livre
Servies : `show ip vrf [brief|detail|interfaces] [nom]`, `show vrf [brief|detail]`,
`show ip bgp vpnv4 {all|rd|vrf} [labels|summary]` avec l'en-tete « Route Distinguisher
... (default for vrf X) », le statut `*>i` et le numero de version de table. Pas
servies : `show ip vrf id`, `show vrf select|lock|ipv6`, le detail d'une entree reseau
(`show ip bgp vpnv4 ... A.B.C.D`), `neighbors`, `network`, `tags`, `regexp`, `inconsistent-as`.
Dans le resume, `TblVer`, `InQ` et `OutQ` valent toujours 0 (pas de file de sortie ni de
version par voisin exposee) ; `MsgRcvd`/`MsgSent` sont les compteurs reels de la session.

### [entropy-label] le reste de la RFC 6790
Seule la signalisation LDP (TLV 0x0206) est servie : l'attribut BGP (type 28) et le
drapeau RSVP-TE ne le sont pas (RSVP : voir [rsvp-te]). Aucun routeur ne repartit
la charge sur le label d'entropie parce que `Router` n'a pas de FIB multichemin
(voir « Known limits ») : l'EL est poussee, transportee et retiree, mais
ne choisit encore aucun chemin. Le pseudo-fil (RFC 6391, label de flux) et les
LSP multipoints ne sont pas traites.

### [diffserv-mpls] le reste de la RFC 3270
Les modeles pipe, short-pipe et uniform du plan de donnees sont servis (classe de trafic a la
pose, au swap et au depilage), mais `short-pipe` n'a pas d'effet distinct de `pipe` : la
difference porte sur la file choisie a l'egress, et aucune file n'est simulee. Les L-LSP
(PSC portee par l'etiquette), la signalisation du mapping EXP<->PHB (objet DIFFSERV RSVP, TLV LDP),
le mapping ATM/Frame Relay et la commande IOS (`mls qos map`, `set mpls experimental`) sont absents.

### [mpls-tp] le reste des RFC 6428 et 5960
BFD CC/CV/RDI est servi en mode coordonne sur une paire de LSP statiques, avec
l'identifiant MEP de LSP (§3.5.2) : le rythme est fixe des le depart (pas de
migration Poll/Final §3.7.1), le mode independant (MinRx = 0), les entrees
LDI et LKI/LKR (§3.7.2), l'authentification et les formes Section / PW du
MEP-ID ne sont pas construits. Les LSP statiques se definissent par l'API
`Router.getMplsTpEngine()` ; ni commande IOS (`mpls tp`) ni transport de
trafic client sur ces LSP (seul le G-ACh circule).

### [mpls-pm] le reste de la RFC 6374
Servis : le delai bidirectionnel (formats PTP tronque et NTP, negociation §4.3.5) et la perte directe
(compteurs 64 bits, paquets ou octets, G-ACh exclu) sur une paire de LSP statiques. Absents : la perte
inferee (§4.2.9) et les messages combines (types 0x000B, 0x000D, 0x000E), les TLV (remplissage,
adressage, boucle, intervalle de session §3.5), la reponse hors bande (refusee par le code 0x12), les
compteurs par classe de trafic (refuses par 0x13), le delai unidirectionnel (suppose des horloges
synchronisees) et le calcul sur 32 bits ; les voies PW et section ne sont pas servies non plus.

### [stty] reglages termios stockes que rien ne lit
`stty` tient l'etat termios complet d'un tty (iflag, oflag, cflag, lflag, c_cc, ligne, vitesses), le refuse et le
normalise comme un pty (CS8 et CREAD forces, PARENB et ADDRB refuses) et le montre par `stty`, `stty -a`, `stty -g`
a l'identique de coreutils 9.4 (890 scenarios rejoues contre un vrai pty). Deux reglages ont un lecteur : `intr` avec
`isig` (la touche d'interruption du terminal local et du `read`) et `echo` (`read` demande un mot de passe quand
l'echo est coupe). Les autres sont ACCEPTES par la vraie machine et stockes ici sans lecteur, faute du mecanisme :
- `icanon`, `min`, `time`, `eof`, `eol`, `eol2` : aucun programme du simulateur ne lit le tty en mode non canonique,
  et la fin de fichier du tty n'arrive a personne ;
- `opost`, `onlcr`, `ocrnl`, `onlret`, `olcuc`, `ofill`, `ofdel`, `nl1`..`ff1` : le terminal rend des lignes, pas un
  flux d'octets, donc `stty -onlcr` ne fait pas d'escalier ;
- `icrnl`, `inlcr`, `igncr`, `iuclc`, `istrip`, `ignpar`, `parmrk`, `inpck`, `ignbrk`, `brkint`, `iutf8`, `imaxbel` ;
- `ixon`, `ixoff`, `ixany`, `start`, `stop` : pas de controle de flux de la sortie ;
- `susp`, `quit`, `lnext`, `werase`, `rprnt`, `kill`, `erase`, `discard`, `iexten` : le terminal Linux n'a ni Ctrl+Z ni
  Ctrl+\, et ses touches d'edition de ligne ne suivent pas les caracteres du tty que readline lie (`stty erase ^H` ne
  change pas la touche) ;
- `echoe`, `echok`, `echonl`, `echoctl`, `echoke`, `echoprt`, `xcase`, `tostop`, `noflsh`, `flusho`, `extproc` ;
- la liaison serie (`cs5`..`cs8`, `parenb`, `parodd`, `cstopb`, `cmspar`, `crtscts`, `clocal`, `hupcl`, les vitesses,
  `line N`) : un pty n'a pas de ligne, le noyau garde les valeurs telles quelles.
Mesure par tmux, non reproduite : apres `stty -echo` a l'invite, readline n'ecrit plus ce qu'on tape (il lit ECHO au
demarrage) ; la transcription est `$ stty -echo`, `$`, `$`, `got=secret` pour `read x` + `secret` + `echo got=$x`.
Le terminal local continue d'afficher la ligne de commande, et pendant une commande longue il n'echoe pas les touches
tapees (`^X^C` sous `stty -isig`). Dans un terminal ouvert sur un hote distant (`ssh`), Ctrl+C part en requete `signal` SIGINT
sur le canal sans consulter le tty distant. `stty -F /dev/ptmx` n'ouvre pas de nouveau pty ; le noeud `/dev/pts/N` d'un terminal
local n'est pas materialise dans le VFS (seules les sessions SSH le sont), `stty -F` et `tty` le resolvent par le
tty vivant.

### [tcpdump-options] ce que -nn, -tttt, -vvv et -XX ne couvrent pas encore (mesure contre tcpdump 4.99.4)
Mesure par `scripts/oracle/record_tcpdump_options.py` sur deux labos (LAN ICMP/TCP/UDP/IPv6/NDP/fragments/HTTP/FTP/SMTP/SSH ;
BIND A/MX/AAAA/SOA/NS/ANY/NXDOMAIN/troncature/DNS sur TCP) : le texte complet est identique pour 11 jeux d'options. Non mesures
faute de trafic dans le labo, donc non garantis : le protocole telnet (`print-telnet.c`, les commandes IAC), les options IPv4
(`ping -R`, `-Q`) et les en-tetes d'extension IPv6, ESP/AH/GRE/OSPF/BGP/SNMP/DHCPv6, MPTCP, les messages MLD et le routage
(RA/RS/redirect ICMPv6 sont portes mais l'echantillon n'a que NS/NA). `-A` n'est pas porte (le texte ASCII est imprime
sans le decodage du `print-ascii.c`) et `-qq` ne supprime pas encore le protocole des fragments non initiaux
(`print-ip.c:494`). La sortie des DHCP/bootp a son propre oracle (`TcpdumpBootp`).

### [curl-writeout] ce que curl -w ne reproduit pas encore (mesure contre curl 8.5.0, voir curl-writeout-oracle.test.ts)

`%{certs}` reste vide alors que le vrai curl 8.5.0 l'emplit sans `--certinfo` (un bloc `Cle:Valeur` par certificat, extensions et `rsa(n)` compris, puis le PEM ; rien en cas d'echec de verification) : le PEM du simulateur est du JSON arme et le texte ne se comparerait pas a un vrai ; les durees viennent de l'horloge de simulation, donc de la milliseconde ; `%{speed_*}` en decoule ; `%{local_ip}`/`%{local_port}` d'un echec restent vides comme chez curl mais `%{remote_ip}` d'un echec de connexion refusee n'est pas mesure. `-o /dev/null` est accepte aussi sous Windows, ou le vrai curl.exe tente d'ouvrir `\dev\null`.

### [bash-fin-de-ligne] un ecart restant contre bash 5.2 sur la fin de ligne (banc : shell-fin-de-ligne-oracle, 261 lignes relevees)

Le shell ne rajoute plus de retour a la ligne aux octets d'une commande (`printf abc 2>/dev/null; echo END` rend `abcEND`), `fold` et `rev` (fichiers operandes compris) non plus. Reste mesure et non ferme : `xxd` n'est pas installe sur la machine de reference, donc sa sortie n'est pas comparee.

### [bash-ecarts-restants] ecarts mesures contre bash 5.2 apres les trois bancs (langage 880, scripts 176, diagnostics 104)

Les trois bancs passent en entier ; restent mesures et non fermes :
- `ScriptRunner.buildIOContext` reste un second constructeur de contexte d'E/S, reduit, utilise quand un appelant sans executeur lance un script ; l'executeur passe desormais le sien (`this.buildIOContext()`) a runScript / runScriptAsync. A supprimer quand plus aucun appelant n'est sans executeur.
- `extglob` est lu dans le texte du script (premier `shopt -s extglob` d'une ligne precedente) et non dans l'etat du shell a l'execution : un `shopt -s extglob` pose par un `source` ou une fonction n'est pas vu par le lexeur.

---

## Telnet (client netkit, serveur netkit, clients des équipements réseau)

Le client Linux est le port de netkit-telnet 0.17 (`src/network/protocols/telnet/client/`), rejoué contre le binaire réel
(`telnet-client-netkit-oracle.test.ts`) ; le telnetd Linux suit la machine d'options de `in.telnetd` (`NetkitTelnetdNegotiation`).

### [telnet] `z` ne suspend rien
`host.suspend` est absent : la commande `z` rend la main immédiatement, ce que fait le vrai client dans un groupe de processus
orphelin (relevé sous pty). Dans un shell à contrôle de tâches il s'arrêterait réellement. Brique manquante : un contrôle de tâches
dans le terminal.

### [telnet] `send synch` envoie le DM dans le flux
Le client réel envoie l'octet DM en données urgentes (`MSG_OOB`) et traite une marque urgente entrante (`netex` : abandon des données
en file). `TcpSocket` porte déjà `onUrgent` ; le port client ne l'utilise pas. Les octets du flux sont identiques, la marque urgente
manque.

### [telnet] routage par la source (`telnet @hop1@hop2:hote`)
Le nom est résolu comme un nom ordinaire et échoue en `could not resolve`. Brique manquante : les options IP LSRR/SSRR dans la pile.

### [telnet] `-n fichier` et `set tracefile` retiennent le nom sans rien écrire
La trace des options (`toggle options`) va toujours à l'écran. Brique manquante : l'écriture d'un fichier par le client depuis la
sortie standard du processus.

### [telnet] les lignes d'un tube sont consommées avec une pause entre chacune
`printf 'a\nb\n' | telnet h` envoie `a`, attend le calme du fil, puis `b`, comme si l'émetteur dormait. Un vrai tube remet tout d'un
bloc puis l'EOF ; le client ferme alors avant la réponse du serveur. Le comportement choisi sert les scripts ; il n'est pas celui du
binaire.

### [telnet-windows] `telnet.exe` : invite `Microsoft Telnet>`, `set`, `display`, `unset`
Le texte d'aide de `WindowsPC.cmdTelnet` vient d'une mémoire non vérifiée et la touche d'échappement `CTRL+]` n'ouvre aucune invite.
Pas d'autorité atteignable ici (le proxy refuse `learn.microsoft.com`, 403) et pas de binaire Windows : rien n'est porté plutôt que
deviné (`CLAUDE.md` §8).

### [telnet-ios] touches d'échappement du client IOS autres que `x`
`Ctrl-Maj-6 x` suspend et `resume`/`disconnect`/`show sessions`/Entrée reprennent, avec les libellés déjà rendus par le shell Cisco.
Les autres touches (`c`, `b`, `h`, `n`, `p`, `1-9`) et le texte exact de la confirmation de `disconnect` n'ont pas de source
atteignable (`cisco.com`, 403). Les octets d'option que le client IOS envoie à la connexion ne sont pas enregistrés : pas d'équipement.

### [telnet-vrp] client VRP
`Press CTRL+K to abort` est rendu ; la touche `CTRL+]` du client VRP et son texte de fin de session ne sont pas sourcés.

## Cisco: wording of the outbound transport refusals

Measured: `transport output` is enforced for `telnet` and `ssh` launched from a console, aux or vty session (the vty block is found by the session's line index). The refusal wordings `% Telnet connections not permitted from this terminal` and `% SSH connections not permitted from this terminal` are written from memory of IOS: the Cisco documentation was not reachable to confirm them. Scripted and non-interactive `telnet`/`ssh` (`executeCommand`) do not consult the setting. `exec banner` is the simulator's spelling; the IOS keyword is `exec-banner`, also unconfirmed. `speed`, `databits`, `stopbits`, `parity` and `flowcontrol` are stored and rendered on console and aux lines but drive no serial-line model: the simulator has no UART.

## Linux: known_hosts is written hashed, linux-hosts-hostname-hijack expects the plain name

Measured: `src/__tests__/unit/network-v2/linux-hosts-hostname-hijack.test.ts` ("première connexion légitime enregistre la clé du vrai serveur sous le nom d'hôte") fails on the base commit too: `cat ~/.ssh/known_hosts` returns a `|1|salt|hash ssh-ed25519 …` line, the test expects `serveur-legitime.domaine.local` in clear. Either the client hashes by default (Ubuntu's `HashKnownHosts yes`, which would make the test's premise false) or the test predates the hashing. Not decided: it needs the OpenSSH `ssh_config` default of the distribution the simulator claims to be.

## Cisco: `boot system` is not rendered in the running-config

Measured: `boot system flash:image.bin` is stored (`CiscoFileSystem.addBootSystem`) and read back by `show boot` (`BOOT variable = flash:image.bin`), but `show running-config` on a router and on a switch never writes the line, so an exported topology loses it on import. The two renderers (`showRunningConfig` for the router, `buildRunningConfig` for the switch) do not reach the shell's file system. Not closed: they need a narrow port to the boot list.

## Cisco: key-chain lifetimes are stored, never evaluated

Measured: `accept-lifetime` and `send-lifetime` are parsed (typed since the key-chain migration), stored on the key, rendered by `show key chain` and by the running-config, and read by nothing else: no routing protocol asks the key chain which key is valid NOW, so a key outside its lifetime still authenticates. Not closed: the brick is a clock-aware `validAt(instant)` on `KeyChainRepository` read by the protocols that take `key-chain` (EIGRP, RIP, OSPF auth), each of which also has to learn to pick among several valid keys.

## Cisco: the NVE / VXLAN CLI is unreachable on every platform

Measured: `CiscoShellBase.hasVxlanHardware()` returns `false` and nothing overrides it, so `interface nve`'s `source-interface`, `member vni`, `peer-ip` and the four `show nve|vxlan|mac address-table vxlan` views are never declared on any router or switch, whatever the chassis profile. `VxlanAgent` works (its protocol tests drive it through the API); only the CLI door is shut. Not closed: which chassis profiles carry VXLAN hardware (the real Catalyst 9000 and Nexus lines do, the ISR lines do not) is a platform fact whose documentation was not reachable. Forcing the flag is not enough either: with `hasVxlanHardware()` patched to true, `interface nve1` cannot be created (no such port), so `source-interface` answers `% No interface selected` and `show nve vni` stays empty. The migration of these nine registrations to the socle was tried and reverted for that reason: it could not be probed.

## Cisco: invalid inputs the fuzz scan still sees accepted

Re-measured after the loopback/tunnel number bound: still accepted are `hostname 1bad`, a 100-character hostname and `hostname a_b` (IOS limits the characters and the length; the exact wording was not reachable), a 300-character `description`, `ip helper-address 0.0.0.0` / `224.0.0.1`, `ip address 127.0.0.1 255.0.0.0` on a physical interface. Closed: `logging buffered` floor, `clear ip route 999.1.1.1`, loopback/tunnel overflow.

## Cisco: `show` verbs whose free tail is accepted without being judged

Measured by appending the word `zorglub` to 75 `show` verbs on a fresh router (the others answer `% Invalid input`): `show ip ospf neighbor`, `show ip eigrp neighbors`, `show cdp neighbors`, `show lldp neighbors`, `show snmp`, `show flash:`, `show boot`, `show environment`, `show memory`, `show ip cef`, `show ip mroute`, `show ip pim neighbor`, `show ip igmp groups`, `show class-map`, `show policy-map` answer without `% Invalid input`. Not all ignore the word: `show ip ospf neighbor` filters its lines by substring (a word that matches nothing leaves only the header), which is a judgement of sorts but not the IOS grammar (interface, neighbor id, `detail`); the others (`show boot`, `show memory`, `show ssh`…) print their normal output whatever follows. Several are right to take a tail (an interface, a name, `detail`, `statistics`): what is missing is the judgement of the tail, which needs each verb's own grammar (interface name, neighbor id, `detail`). Not closed: one lot per family, each with the IOS forms it must keep.

## PIM: rp-candidate / bsr-candidate group-list, interval and running-config

`ip pim rp-candidate <iface> group-list <acl>` is refused at the caret: the
agent advertises the whole 224.0.0.0/4 range and has no per-candidate group
range from an ACL, and the old handler accepted the keyword and ignored it.
`ip pim bsr-candidate` / `rp-candidate` store only the interface ADDRESS, so
neither is rendered in the running-config (the interface identity is lost).
`ip pim spt-threshold` is stored and rendered but the engine builds only
(*,G) state, so it is never evaluated. Seen while migrating the PIM family.

## IKEv2 global settings: three upper bounds not enforced (source unreachable)

`crypto ikev2 nat keepalive`, `cookie-challenge` and `window` refuse
non-numeric and zero values (cookie-challenge accepts zero), but their upper
bounds are not enforced and the help announces no range: the Cisco command
reference for the IKEv2 forms could not be reached. `crypto ikev2 dpd` shares
the 10-3600 / 2-60 ranges the IKEv2 profile `dpd` of the same file already
declared. Fetch the IKEv2 pages, then declare the three ranges on the places in
CiscoIPSecIKEv2Commands.ts.

## OSPF redistribute: route-map, tag, and sources the engine does not evaluate

`redistribute static|connected|rip` under `router ospf` now judges its options,
honours `metric` and `metric-type` in the LSAs the engine originates and is
rendered in the running-config. Still open: `route-map` and `tag` are not
declared (refused at the caret) because the engine neither evaluates a
route-map on redistribution nor carries the external route tag; and
`redistribute bgp|eigrp|ospf N` is stored and rendered but no route from those
sources enters OSPF. IS-IS as a source is not declared. 

## OSPF process settings stored and rendered, not evaluated

`distance`, `compatible rfc1583`, `ispf`, `prefix-suppression`, `discard-route
external`, `segment-routing mpls`, `timers lsa arrival`, `timers pacing flood`
and `timers pacing retransmission` under `router ospf` are typed, stored and
rendered in the running-config, and `show` nothing of them changes behaviour:
the engine reads none of them. `shutdown` is stored and rendered but does not
stop the process (adjacencies stay up). Each needs its brick in the OSPF engine
(administrative distance of installed routes, RFC 1583 external path selection,
incremental SPF, the discard route, process shutdown).


## Interface translation: what stays English on purpose

The interface has a global EN/FR switch (toolbar, `src/i18n/useLocale.ts`)
and every visible string of the designer is translated: toolbar, palette,
help, save/open/confirm/message dialogs, designer messages, properties panel
and its live-state statistics, settings, simulation clock, canvas, device
action buttons, interface selector, cable accessible names, terminal title
bar and taskbar. Still English, on purpose: what the simulated equipment
prints (the CLIs, the shells and the databases answer in the vendor's English,
as the real products do) and the platform names in the terminal title (Ubuntu
Linux, Cisco IOS...). Not covered by a test: the `title` of palette devices
whose English name is the vendor's (Cisco ASA, FortiGate, Palo Alto keep their
product name in French). The topology image draws the cables with the canvas's
own router (`computeCableRoutes`, zoom 1); it does not reproduce the canvas's
selection or pan/zoom, by design.

## Reds measured at base outside the network-v2 sweep (new_firewall)

`src/__tests__/unit/new_firewall/fortigate-battery-06-ipv6-ospf-bgp-ztna.test.ts`
(32 cases), `fortigate-battery-02-advanced-transit.test.ts` and
`fortigate-battery-03-security-pbr-ipsec-qos.test.ts` (together ~70 cases, seen
in a Windows ping sweep), `fortigate-battery-05-ha-vrf-dpi-radius.test.ts` (34 cases),
`fortigate-battery-09-tls-crypto-pki.test.ts` (44 cases),
`fortigate-battery-10-sdwan-vxlan-pqc.test.ts` (28 cases) and
`fortigate-battery-11-hybrid-cloud-evpn-k8s.test.ts` (28 cases)
fail on a tree with no change from the CLI hardening series (checked by
stashing `src`). Seen while running the tests that mention `router bgp` and
`ipv6 address`. Not diagnosed: nothing was done beyond establishing that the
failures predate the series.

## Huawei management configurators record unknown forms as raw lines

`RouterManagementService.configureNtp|configureSflow|configureClock|
configureTelnet|configureStelnet` end in `recordRaw(feature, line)` when the
form is not recognised, so `sflow zorglub`, `bfd zorglub`, `isis 1 zorglub`,
`clock datetime zorglub` and others (seen by fuzzing a HuaweiRouter with a
trailing `zorglub`) are accepted and stored verbatim. Only the
`<feature> enable|disable <extra>` forms were closed. The VRP grammar for the
rest was not reachable, so refusing them would be guessing (rule 8). Needs the
Huawei command reference for sflow, bfd, isis, traffic classifier/behavior/
policy, route-policy and `snmp-agent community`.

## FortiGate batteries 04–11 encode an aspirational simulator

`fortigate-battery-03` (13 cases) and `-04` to `-11` (about 300 cases) are red at the base commit 2351448f2. Measured on battery 09: its first step is `systemctl start nginx-tls13`, which answers `Failed to start nginx-tls13.service: Unit nginx-tls13.service not found.`; the same files start `nginx-pqc`, `api-gateway`, `otel-collector` and others no machine ships, then read `openssl s_client` output that only exists if the unit ran (`connect:errno=111` otherwise). The premise is false, not the engine: the units must either be created by the test through the real unit-file path, or the cases rewritten. Not closed because each battery needs its own lab audit.

## clear ip bgp soft / in / out and peer-group targets

`clear ip bgp <target> soft [in|out]` and `in`/`out` are accepted and do
nothing: the engine models no route refresh. `clear ip bgp peer-group`,
`vpnv4`, `ipv4 unicast` and `vrf` targets are refused as invalid input
although IOS accepts them (BgpNeighborCfg carries no peer-group name, the
engine no per-family reset). Hard reset by `*`, address, AS, external and
internal is real (BGPEngine.resetPeers).

## `sh -c` speaks bash, not dash

Measured: `sudo sh -c 'echo 3 > /proc/sys/net/ipv4/zorglub'` answers `sh: line 1: /proc/sys/net/ipv4/zorglub: No such file or directory`; Ubuntu's `sh` is dash and says `sh: 1: cannot create /proc/sys/net/ipv4/zorglub: Directory nonexistent`. `probe-procfs-does-not-grow` now runs `bash -c`. A dash diagnostic table is not written.

## Linux coreutils without an option table

GnuOptionGuard (src/network/devices/linux/GnuOptionGuard.ts) covers whoami,
groups, tty, nproc, free, env, printenv, uname, mkdir, rmdir, rm, cat, wc, tac,
tee, basename, dirname, ls, head, sort, uniq, cut, tr and date. Measured with `<cmd> --zorglub` and still silent or
treating the option as a file operand: du, find,
date, base64, md5sum/sha256sum/cksum, rev, nl, fold, fmt, column, paste, comm,
split, truncate, seq-less forms, which, passwd, sysctl, awk, lsof. Their option
sets were not written down here: each needs its own table and a run of the
tests that use it.

## PowerShell: a built-in cmdlet ignores an unknown named parameter

Measured: `Get-Process -Zorglub`, `Get-Service -Zorglub`, `Get-ChildItem -Zorglub`, `Get-Date -Zorglub`, `Get-NetIPAddress -Zorglub`, `Get-LocalUser -Zorglub` and `Get-Random -Zorglub` all run as if the parameter had not been typed; Windows PowerShell answers `A parameter cannot be found that matches parameter name 'Zorglub'.` (`NamedParameterNotFound`). Script functions with `param()` already refuse it (`PSParameterBinder.resolveName`).

Closed so far, by opt-in (`ICmdlet.closedParameterSet`): Get-Date, Get-Location, Get-Service. Every other cmdlet still ignores the name.

Why the rest is not closed: `ICmdlet.parameters` only feeds `-<Tab>` completion and is incomplete. Making `resolveParameterPrefixes` refuse a key absent from it broke 11 cases in `src/__tests__/unit/powershell` (Format-Table `-Width`, New-Item `-Target`, New-LocalUser `-NoPassword`, `-Force` on the Add-LocalGroupMember / Register-ScheduledTask family…), and a scan of the cmdlet classes finds ~40 more names read through `ctx.named[...]` and missing from their own list. The refusal can only be turned on once each cmdlet's list is audited against its handler, so the list becomes the single authority for both completion and binding.


## Linux pwd: -L/-P and unknown options

Measured: `pwd --zorglub` prints the directory (bash answers `bash: pwd: --: invalid option` and `pwd: usage: pwd [-LP]`), and `pwd -P` prints PWD unresolved. The builtin lives in `src/bash/runtime/Builtins.ts` with only the environment: resolving symbolic links for `-P` needs the VFS, which that layer does not hold, so the option can neither be refused cleanly nor honoured there yet.

## Linux find: predicates that evaluate to false

`FindExpression.ts` now parses the GNU grammar (-o, -a, !, parentheses, -prune, -quit, actions suppress the default -print) and evaluates -regex, -links, -uid, -gid, -inum, -used, -nouser, -nogroup, -readable/-writable/-executable, -samefile, -lname, -printf, -daystart. Still answered `false` (fail closed) because the brick behind them is missing: `-fstype` and `-context` (no mount/SELinux label lookup from the shell context), `-ls`, `-fprint`, `-fprint0`, `-fprintf`, `-fls` (no output-file channel, no `ls -dils` line), `-ok`/`-okdir` (no prompt channel). `-exec`/`-execdir` still only echo the command line with `{}` replaced and run nothing, `+` is read as `;`; the `-printf` date directives other than `%A@ %C@ %T@` go through `formatLocalTime` and are not checked against findutils.


## Linux split: --filter and -n l/N, K/N

Measured: `split --filter=CMD` is refused as an unrecognized option and `-n l/3`, `-n 2/3` as `invalid number of chunks`, where GNU accepts both. `--filter` needs the shell to run CMD with each piece on its stdin and `$FILE` set; `l/N` and `K/N` need line-aligned chunking and stdout output. `-a -d -x -e -t -C -u --additional-suffix --verbose` are evaluated.

## Linux sed: options accepted without effect

Measured: `-z`/`--null-data` (lines are still split on newline), `-l N`/`--line-length` (the `l` command keeps its own width), `--posix`, `--debug`, `--sandbox` (e/r/w stay enabled) and `--follow-symlinks` are read by `SedOptions.ts` and change nothing, because the engine has no NUL-separated record mode, no wrap parameter, no GNU-extension switch and no program annotation. A real sed honours all six. Unknown options, `--help`, `--version`, `-i[SUFFIX]` (backup), unreadable inputs and `-f` of a missing file are handled.

## Linux grep: options accepted without effect

Measured: `-T`/`--initial-tab`, `-z`/`--null-data`, `-a`/`--text`, `-I`, `-U`/`--binary`, `-u`, `--binary-files=TYPE`, `--devices=ACTION`, `--line-buffered` and `-R` (symlinks are not followed differently from `-r`) are read through `GREP_OPTIONS` and change nothing. The simulator has no binary-file detection (a NUL-bearing file is always printed as text), no NUL-separated record mode and no tab alignment of the prefix. Unknown options, `--help`, `-V`, `-Z`, `-b`, `--label`, `--exclude-dir`, `--exclude-from`, `--directories`, `--no-ignore-case` and the long spellings of every evaluated option are handled. The `--help` and `-V` texts are those of grep 3.7 from memory.

## Linux diff: output styles accepted without effect

Measured: `-y`/`--side-by-side` (and `-W`, `--left-column`, `--suppress-common-lines`), `-e`/`--ed`, `-f`, `-n`/`--rcs`, `-D`/`--ifdef`, `--line-format` and the group formats, `-p`/`--show-c-function`, `-F`, `-t`, `-T`, `--tabsize`, `-E`, `-I`, `-S`, `-x`'s sibling `-X`, `--from-file`/`--to-file`, `--color`, `--strip-trailing-cr`, `-a`, `-d`, `-l` are read through `DIFF_OPTIONS` and change nothing; a real diff prints a different layout for the first nine. `-u`/`-U N`, `-c`/`-C N`/`-NUM`, `-q`, `-s`, `-i`, `-w`, `-b`, `-Z`, `-B`, `-r`, `-N`, `-L`, `-x` and directory operands are evaluated. `diff -` (standard input) is not supported: the executor case receives no stdin. The hunk boundaries come from a plain LCS and can differ from GNU's heuristic on ambiguous input.

## Cisco: `bgp default local-preference ?` announces <cr>

Measured: `bgp default ?` now offers `ipv4-unicast` and `local-preference` and `bgp default local-preference ?` names the range, but still announces `<cr>` after the keyword while the command answers `% Incomplete command.` without a value. The value place is optional because `ipv4-unicast` takes none and `AdapterKeyword` has no per-choice argument (OptionSpec has `choices`, the adapter does not). Closing it needs `choices` on `AdapterKeyword`, or a separate `bgp default local-preference` registration.

## mv: options accepted without effect

`mv` evaluates -f, -n, -u, -v, -T and -t (and several sources). Still accepted and ignored: `-i` (no prompt on stdin), `-b`/`--backup`, `-S`, `-Z`, `--strip-trailing-slashes`. `stat` is a port of coreutils 8.32 stat.c and evaluates every option. Measured with the table of the GnuOptionGuard; the tables are coreutils 8.32 from memory.

## column and awk: options accepted without effect

`column` evaluates -t and -s only; -o, -c, -x, -J, -N, -n, -R, -H, -E, -l, -e, -d, -L and the tree options are accepted (table of util-linux 2.37 from memory; the dev container has no `column` to compare with) and ignored. `awk -W version` prints nothing where mawk prints its banner (version and compile-time limits); the banner of Ubuntu 22.04's mawk 1.3.4-20200120 was not available to copy.

## lsof: an unknown option is ignored

`lsof -q` and `lsof --zorglub` list files. The real lsof (4.95 in the dev container; Ubuntu 22.04 ships 4.93.2) has its own parser: it reports every bad character (`lsof: illegal option character: z`, then `illegal process group ID: lub` for the rest of `--zorglub`, which it reads as `-g lub`), prints a version banner whose text depends on the release, then a usage block, status 1. Faithful refusal needs that whole parser (`+`/`-` options with attached or separate arguments); a table in the style of the GNU guard would give a wrong second line. Not written.

## Huawei VRP: `Too many parameters` has no echoed line and caret

`display acl all zorglub` answers a bare `Error: Too many parameters found at '^' position.`: `normaliserErreurVrp` decorates Incomplete, Unrecognized and Wrong parameter with the typed line and a caret, not this family, because the position of the extra word is known only to the handler. The declared ceiling `allowArgs` + `tropDeParametres` does render it fully but only supports one fixed ceiling per node.

## Huawei VRP: config commands that take any trailing word

Measured with `<cmd> zorglub` in system-view: `local-user a password cipher b`, `arp static 1.1.1.1 0000-0000-0001`, `nat static global 1.1.1.1 inside 2.2.2.2`, `bfd` and `user privilege level 3` run as if the word were not typed. Each has optional tails on a real VRP (`privilege level`, `vid`/interface, `netmask`/`vrrp`...) whose full grammar was not reachable, so a ceiling would refuse valid forms.

## file and hostname: options accepted without effect

`file` evaluates -b, -i, --mime and --mime-type (ASCII text, empty, directory, symlink, special files, shell scripts only); -L, -z, -f, -F, -0, --extension, --apple and the rest are accepted and ignored. `hostname` refuses unknown options like net-tools but still ignores -F (read from a file), -b, -a and -y/--yp/--nis.

## ls: options accepted without effect

Evaluated and compared with GNU ls 9.4: the display, sort, indicator, column, width, tab, ignore/hide, quoting-literal/c/escape, human-size, inode, context-placeholder and long-column options (see probe-linux-ls-evalue-ses-options). Still accepted and ignored: `--time=birth` (no birth time is modelled; it sorts like mtime), `-D`/`--dired`, `--hyperlink`, `--block-size`, `-Z` shows `?` instead of a real SELinux context, `--quoting-style=shell*` and `locale` are approximated by literal and c, and `LS_COLORS` extension colours are not read. Directory-order listings (`-U`, `-f`) follow the simulator's insertion order, which a real file system does not promise.

## du: options accepted without full effect

`du` evaluates every option of GNU du 9.4 except: `-x` (the file-system boundary is read from `ctx.deviceOf` only when the host supplies it), `--files0-from=-` (no stdin), the threshold suffix forms beyond K/M/G, and the readdir order of entries (the simulator lists in insertion order; the probe compares sorted lines). `--time` uses the file times of the simulator.

## grep: what is still approximated

Evaluated and compared with GNU grep 3.11: the selection, output, context, binary-file, directory, null-data, initial-tab and colour options (see probe-linux-grep-evalue-ses-options). Still approximate: a file counts as binary only when it holds a NUL byte (grep also treats invalid UTF-8 in a UTF-8 locale as binary); `-D` (devices) and `-U`/`--line-buffered` are accepted and ignored; `-P` is JavaScript's RegExp with `\K` translated; `GREP_COLORS` is not read (the defaults are used); entries of `-r` follow the simulator's insertion order, not readdir.

## sed: what is still approximate

Evaluated and compared with GNU sed 4.9 (see probe-linux-sed-evalue-ses-options): syntax errors with their `-e expression #N, char C` position and exit status, `s///w`, `w`/`W`/`r`/`R` (truncation at start, `/dev/stdout`, `/dev/stderr`, files without trailing newline), `-z`, `-l N` and `l N` wrapping, `-s`, `-i`, `--sandbox`, `#n`, the append queue flushed by `n`/`N`, `0,/re/`, `addr,~N`, bracket expressions holding the delimiter, `\t \xHH \oNNN \dNNN \cX` in patterns and replacements, empty matches after a match. Still not evaluated: the `e` command and the `s///e` flag (a sed script cannot run a command: the executor is not reachable from `cmdSed`, so both are refused as unknown), `--debug` and `--posix` (accepted, no annotation, GNU extensions stay on), `L` (4.9 answers `INTERNAL ERROR: Bad cmd L`, 4.8 formats; the simulator says `unknown command`), `--follow-symlinks`. The `--version` banner is the 4.8 of Ubuntu 22.04, the dev container's real sed is 4.9. Matching uses JavaScript's leftmost-FIRST alternation, not POSIX leftmost-LONGEST: `s/\|o/x/` on `one` gives `xone` where sed gives `xne` (`CompiledEre.exec` has the longest rule, grep -o and awk use it; sed would need the `M` flag and group indices on it). With `-i`, `w /dev/stdout` goes to the edited file instead of the terminal. The relative order of "can't read FILE" and the output differs from a real pipe (stderr is unbuffered there).

## find: what is still approximate

Evaluated and compared with GNU find 4.9 (see probe-linux-find-evalue-ses-options): every test, action (`-exec/-execdir/-ok/-okdir` through the shell executor, `-ls`, `-fls`, `-fprint*`, `-printf` with widths and flags), `-H/-L/-P/-follow`, `-xtype`, `-fstype` (from /proc/mounts), `-files0-from`, `-O`, `,`, and the diagnostics with their exit status. Still not modelled: the debug traces of `-D exec|opt|rates|search|stat|time|tree` (the flags are accepted and print nothing; `-D help` and unknown flags answer like find); `-exec ... +` runs one command per start directory, never splitting at ARG_MAX; `-context` and `%Z` always fail as on a machine without SELinux; `-warn` prints only the "global option after the argument" warning (find has more positional warnings); `-ok` reads its answer from the command's stdin only; the `--version` banner is 4.8.0 (the dev container's real find is 4.9.0); entries of a directory come in the simulator's insertion order, not readdir order; `-newerBm` and friends are refused like a system without birth time.

## coreutils text tools: what is still approximate

head, tail, wc, cut, sort, uniq and tr are compared with GNU coreutils 9.4 (see probe-linux-coreutils-texte-evalue-ses-options). Still approximate: `sort --debug` is accepted and prints nothing extra; `sort -R` hashes with FNV and a per-run salt (no `--random-source`); the collation is the C locale; `wc -m`/`-L` count code points and a fixed width table, not wcwidth; `wc` takes column width 7 for any standard input, where real wc reads the size of a regular file redirected to it; `tr` classes are the ASCII ones; `--help` texts are those of 9.4 under an 8.32 banner; `od` does not exist (`od -c`, `od -An -tx1` fail with command not found); `tail -f` on several files in the dispatcher path (no terminal sink) prints the snapshot and exits instead of following; the error of an unreadable file comes before the output in the interleaved stream, where a pipe would show stderr first only by buffering accident.

## coreutils file tools: what is still approximate

cp, mv, ln, rm, rmdir, mkdir, chmod, cat, basename, dirname, seq, echo and printf are compared with GNU coreutils 9.4 (see probe-linux-coreutils-fichiers-evalue-ses-options). Still approximate: the behaviours that changed between releases follow the 9.4 of the recorded transcripts (the `cp -n` warning, `mv -n` answering "not replacing" with status 1), under an 8.32 banner; `cp --reflink=always` fails with "Operation not supported" because the virtual disk has no copy-on-write extents, and `--sparse` is accepted without changing anything because file content is stored as text, not as extents; `cp --copy-contents` and `-x` are accepted and have nothing to act on (no fifo or device copies, one filesystem); `--preserve=context,xattr,links` is validated but the virtual disk keeps neither security context, extended attributes nor link groups; `rm -rv` walks in the directory's own order, which is not the order of a real ext4 readdir; `rm -I` prompts only for the count, not for the recursive form; the prompts of `-i`/`-I` end the stderr stream with a newline the shell adds, where a real prompt has none.

## od: what is still approximate

od is compared with GNU coreutils 9.4 (see probe-linux-od-evalue-ses-options). Still approximate: `-w0` aborts in the real command and prints the dump with the minimum width here; in `--traditional` mode an offset operand ending in `.` (decimal) is refused as an extra operand, as the real command does, but the label form is only checked against one file; `-S` does not quote non-printing bytes inside a string; reading a directory reports "Is a directory" and prints the final address like the real command, but a read error on a file that opened is not distinguishable here.

### [smtp] le serveur SMTP ne journalise pas `connect from` / `disconnect from`
Postfix `smtpd` ecrit `connect from host[ip]` et `disconnect from host[ip] ehlo=1
...` via syslog (facility mail, etiquette `postfix/smtpd[pid]`) : verifie dans
`src/smtpd/smtpd.c:6487` et `:6536` du depot vdukhovni/postfix. Le simulateur
ecrivait a la place `smtp[...]: Accepted connection from ...` dans le syslog
(ligne inventee, retiree avec le journal d'nginx) et n'ecrit plus rien. Pour
fermer : emettre ces deux lignes sous la facility mail depuis le serveur SMTP,
avec les compteurs de commandes du `disconnect`.

### [ftp] ce que le serveur FTP journalise a l'acceptation d'une connexion n'est pas verifie
L'etiquette `ftpd` que le journal employait ne correspond a aucun demon ; vsftpd
et proftpd n'ont pas pu etre clones ici, donc leurs lignes de connexion (vsftpd :
`xferlog`/`vsftpd.log`, `CONNECT: Client "ip"` avec `log_ftp_protocol`) restent a
relever dans leurs sources avant d'en ecrire.

### [iptables] des correspondances que le vrai iptables accepte sont refusées ici, et les noms d'utilisateur ne sont pas résolus
Mesuré avec `iptables -A INPUT -m <module> … -j ACCEPT` (iptables 1.8.7) : `physdev` ne se retrouve pas dans `iptables -L` après la saisie (refusées ou sans ligne), alors que le vrai iptables les accepte. `hashlimit` est décidé et listé pour les débits en paquets ; les débits en octets (`100kb/s`) sont refusés en le disant, et `--hashlimit-rate-match` / `--hashlimit-rate-interval` sont acceptés sans être évalués (la règle ne correspond alors pas). Chacune demande son évaluation au noyau simulé avant d'être acceptée (règle 6), donc elles ne sont pas stockées sans effet.

### [ipset] ce qui n'est pas construit
`ipset` (7.15) couvre `hash:ip`, `hash:net`, `hash:ip,port` et `bitmap:ip` avec `create/add/del/test/list/save/restore/flush/destroy/rename/swap/version`, `timeout`, `netmask`, `comment`, `forceadd`, `maxelem`, `hashsize` et la cible/correspondance iptables `set` / `SET`. Manquent : les compteurs et `skbinfo` (refuses en le disant), les autres types (`bitmap:ip,mac`, `bitmap:port`, `hash:net,port`, `hash:ip,mark`, `list:set`…), `--return-nomatch` et `nomatch`, `--map-set`, le mode interactif et la résolution de noms d'hôte. « Size in memory » est une approximation (200 + 64 par élément) : le noyau l'obtient de ses allocations, sans formule exploitable depuis les sources. `-m physdev` reste refusé : pas de pont filtrant dans le simulateur.

### [rman] scripts stockes : les erreurs et la mise en page de `LIST SCRIPT NAMES` ne sont pas sourcees
`CREATE|REPLACE|PRINT|EXECUTE|DELETE SCRIPT` gardent maintenant le corps dans le
catalogue de la machine et `EXECUTE` le rejoue comme un bloc `RUN` (sonde
`probe-rman-scripts-stockes-et-commentaires`). Restent non sources, faute d'acces a la
documentation des messages RMAN depuis ce reseau (`docs.oracle.com` est bloque) :
(1) le code d'un script introuvable ou deja existant (`RMAN-03002` ici, avec un texte
simple) ; (2) la mise en page exacte de `LIST SCRIPT NAMES` ; (3) le refus que RMAN
oppose a un script stocke sans catalogue de recuperation connecte (le sandbox
l'accepte, comme le dit le tutoriel). Les commentaires `--` du tutoriel ne sont pas
reconnus : seul `#` l'est.

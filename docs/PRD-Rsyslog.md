# rsyslog : un vrai récepteur, pas une unité qui se déclare active

## La mesure de départ

En câblant un routeur Cisco à un serveur Linux :

| Ce que la machine affirmait | Ce qui était vrai |
|---|---|
| `which rsyslogd` → `/usr/sbin/rsyslogd` | le binaire existe |
| `systemctl status rsyslog` → `active (running)` | l'unité se déclare active |
| `/var/log/syslog` se remplit | les logs LOCAUX arrivent |
| `ls /etc/rsyslog.conf` | **No such file or directory** |
| `ls /etc/rsyslog.d/` | **No such file or directory** |
| `ss -ulnp \| grep 514` | **rien** |

Et pendant ce temps, `show logging` sur le routeur comptait ses messages
comme partis : `1 message lines logged` vers `192.168.100.50`. Le PRI
était calculé, le format RFC 3164 correct, le transport honoré — **de
vrais datagrammes partaient sur le fil et personne ne les recevait**.

C'est la même forme que le défaut déjà refermé pour nginx et apache — une
unité `active` sans rien derrière — mais ici elle vide de son sens la
partie centrale d'un cours sur syslog : **la centralisation**. Les
laboratoires « éditer `/etc/rsyslog.conf` », « un fichier par équipement »
et « chercher dans les logs reçus » n'avaient aucun support.

## Ce qui est livré

### Les fichiers de Debian, pas un minimum inventé

`/etc/rsyslog.conf` et `/etc/rsyslog.d/50-default.conf` sont ceux de
Debian 12 / Ubuntu 22.04. **Les modules de réception y sont commentés**,
comme sur une vraie machine : un rsyslog fraîchement installé n'écoute
PAS sur 514. Les décommenter et recharger **est** l'exercice ; livrer un
fichier où ils seraient déjà actifs supprimerait l'exercice en même temps
que la vérité.

### Un vrai analyseur

`RsyslogConfig.ts` lit les deux choses que le fichier décide :

- **ce que le démon écoute** — `module(load="imudp")` **et**
  `input(type="imudp" port="514")`. Les deux comptent : un `input` sans
  `module` ne fait rien sur un vrai rsyslog, et l'accepter ferait écouter
  une machine dont la configuration ne le demande pas. La forme historique
  (`$ModLoad imudp` / `$UDPServerRun 514`), encore partout dans les
  supports, est lue aussi ;
- **où va chaque message** — les règles `<sélecteur> <cible>`, fichier ou
  renvoi (`@host` UDP, `@@host` TCP), et `$IncludeConfig`.

Deux points où une lecture naïve se trompe, et les deux comptent :

- **`.info` veut dire « info ET PLUS GRAVE »**. Les sévérités vont à
  l'envers de l'intuition (0 = le plus grave), donc le test est
  `sévérité <= seuil`.
- **`.none` EXCLUT**, et c'est ce qui fait fonctionner la ligne
  `*.*;auth,authpriv.none` de Debian. Sans elle, `/var/log/syslog`
  doublerait `/var/log/auth.log` et un mot de passe refusé apparaîtrait
  dans deux fichiers.

Ce qui n'a pas d'effet est ignoré sans erreur (`$FileOwner`, `$Umask`,
gabarits) : les inventorier donnerait l'illusion qu'ils gouvernent
quelque chose.

### Une écoute réelle, et cohérente avec `ss`

`LinuxRsyslogService` implémente `ServiceSocketServer` : le port n'apparaît
dans `ss` que si la configuration le demande **et** que l'écoute a été
ouverte pour de bon. La liste des ports vient du **fichier**, pas d'une
constante — c'est ce qui fait qu'un `imudp` décommenté puis rechargé ouvre
vraiment 514, et qu'un `imudp` recommenté le referme.

**Défaut trouvé en câblant, et instructif** : lié à `0.0.0.0:514` via
`udpBindAddress`, le service apparaissait dans `ss` et **ne recevait
rien**. La livraison cherche d'abord un service lié à UNE adresse
(`192.168.100.50:514`) et ne retombe sur la table par PORT qu'ensuite ;
un démon qui écoute sur toutes les interfaces relève de la seconde.
C'était exactement le défaut « affiché mais injoignable » que
`ServiceSocketServer` existe pour empêcher, reproduit une couche plus bas.

### La cohérence entre l'état du service et l'état des fichiers

C'est le cœur de la demande, et elle tient dans les deux sens :

- **`/etc/rsyslog.conf` absent** → le démarrage échoue en le nommant
  (`CriticalFiles`, même contrat que sshd et nginx). Un fichier **vide**,
  lui, est légal : le démon démarre sans règle et n'écrit nulle part —
  panne différente et bien réelle, où les logs disparaissent sans que rien
  n'échoue.
- **Configuration fautive** → `systemctl restart` **REFUSE** et l'unité
  passe à `failed`, au lieu de laisser une unité `active` derrière un
  démon qui n'a rien lu. Mesuré :

```
$ rsyslogd -N1
rsyslogd: unknown priority name "pasunniveau" [line 1]
rsyslogd: run failed with error -2207 (see rsyslog.conf(5) for details)
$ systemctl restart rsyslog
rsyslogd: unknown priority name "pasunniveau" [line 1]
$ systemctl is-active rsyslog
failed
```

- **`systemctl stop`** ferme les sockets pour de bon : sans cela le port
  514 resterait ouvert et la machine continuerait de recevoir après
  l'arrêt.

### `rsyslogd -N1`

La validation qu'un opérateur lance **avant** `systemctl reload`, pour la
même raison qu'il lance `nginx -t` : un rechargement sur une configuration
fautive coupe le service, et ici le service est ce qui reçoit les journaux
de tout le parc — le moment où l'on perd la trace est précisément celui où
l'on en a besoin. Elle analyse dans une copie **locale** et ne déplace pas
ce que le démon croit de sa propre configuration.

`-N` prend un **niveau** (`-N1`) ; `-t` n'existe pas sur `rsyslogd` et le
proposer apprendrait une option que le binaire refuse. L'option est
**collée à son chiffre**, forme qu'un découpage naïf sur `-N` seul ne voit
pas — le même piège que `lsb_release -cs`.

### Ce que le récepteur fait d'un message

- **`%FROMHOST-IP%` est résolu**, parce que « un fichier par équipement »
  est le geste que le cours enseigne et qu'un gabarit littéral écrirait
  tous les équipements dans un fichier nommé `%FROMHOST-IP%`.
- **Le message garde l'heure et le nom que son émetteur y a mis.** Le
  gabarit par défaut de Debian est `RSYSLOG_TraditionalFileFormat`, soit
  `%TIMESTAMP% %HOSTNAME% %syslogtag%%msg%` ; or `%TIMESTAMP%` est un
  **alias de `%timereported%`** — l'heure portée par le message — et non
  de `%timegenerated%`, l'heure de réception, et `%HOSTNAME%` est de même
  celui du message et non `%FROMHOST-IP%`. Une première version réécrivait
  les deux avec ceux du collecteur : cela paraissait plus utile (corréler
  des horloges qui divergent) mais **effaçait l'identité de l'émetteur
  d'origine dès qu'un relais est en jeu**, ce que ce gabarit existe
  précisément pour conserver, et faisait mentir le §4.2 du tutoriel, qui
  distingue nommément les deux couples de champs. Vérifié sur la
  documentation de rsyslog plutôt que de mémoire.
- **Un message dont l'en-tête RFC 3164 n'est pas exploitable** n'en porte
  aucun des deux : le collecteur pose alors les siens, comme le fait
  l'analyseur de rsyslog quand il ne trouve pas d'horodatage. C'est la
  seule situation où ses propres valeurs apparaissent.
- `%HOSTNAME%` **dans un chemin de fichier** suit la même règle que dans
  la ligne : il nomme l'équipement décrit par le message. `%FROMHOST%`
  reste celui qui l'a transmis — sur un relais les deux diffèrent, et
  c'est exactement ce que le laboratoire « un fichier par équipement »
  cherche à distinguer.
- **Un message sans `<PRI>` n'est pas jeté** mais traité `user.notice`
  (RFC 3164 §4.3.3) : perdre un message mal formé serait le pire des
  comportements pour un collecteur d'audit.
- Un message va dans **chaque** fichier que les règles désignent — c'est
  le cas normal (`auth.log` *et* `syslog`).

### Une convention du dépôt, dite plutôt que contournée

Ce simulateur transporte des **PDU structurées** et non des octets.
L'émetteur interne pose donc un `SyslogPacket` et non une chaîne ; le
récepteur reconstruit la ligne RFC 3164 depuis ses champs plutôt que
d'exiger une sérialisation qui n'existe nulle part. Une charge déjà
textuelle reste acceptée telle quelle.

## Mesuré de bout en bout

```
routeur Cisco (logging host 192.168.100.50, facility local7)
   → datagramme UDP/514 réel sur le fil
   → rsyslog écoute (imudp décommenté, rechargé)
   → règle `*.*` de Debian
   → /var/log/syslog :
     Aug 11 05:40:09 R1-PROD %SYS-5-CONFIG_I Configured from console by console
```

## Reste ouvert, écrit plutôt que tu

- **TCP (`imtcp`) est analysé et n'ouvre rien** : `ServiceSocketServer`
  reçoit bien le `PortSpec` TCP, mais l'acceptation d'une connexion et le
  découpage RFC 6587 des messages qui se suivent sur un même flux ne sont
  pas faits. Le port n'est donc pas affiché non plus — la cohérence tient,
  la fonction manque.
- **TLS (6514)** n'est pas fait, ni côté récepteur ni côté Cisco, et
  `logging host … transport tls` reste **refusé délibérément**. Le
  raisonnement est écrit ici plutôt que laissé à deviner : accepter le
  mot-clé et continuer d'émettre en clair ferait afficher à la
  configuration un chiffrement qui n'a pas lieu — un apprenant vérifiant
  son durcissement lirait `transport tls` et croirait ses journaux
  protégés. Un refus est faux à propos de ce qu'un IOS 15 sait faire ;
  une acceptation serait fausse à propos de ce qui circule sur le fil.
  Le test de conformité pose donc le refus **comme contrat**, avec sa
  raison, pour qu'il ne soit pas « corrigé » par inadvertance.
- **Les renvois `@@host`** sont analysés et stockés ; rien ne réémet.
- **`logrotate` ne tourne pas tout seul** sur ces fichiers : le fichier
  `/etc/logrotate.d/rsyslog` de Debian est désormais livré (§4.5 du
  tutoriel porte donc sur un fichier qui existe, et l'exemple s'y lit),
  et la commande `logrotate` existe, mais aucune tâche périodique ne
  l'exécute.

## Les sept points du fichier de conformité, refermés

`tuto-syslog-conformite.test.ts` marquait sept points `it.skip` avec leur
raison — un fichier de conformité doit dire où s'arrête la conformité.
Six sont refermés, le septième (TLS) est devenu un contrat de refus. Ce
qu'ils ont appris, chacun mesuré avant d'être corrigé :

### Huawei : `level` et `source-ip` étaient rangés nulle part

`info-center loghost <ip> level <sev>` et `… source-ip <ip>` étaient
**refusés**, alors que `VrpLoghost` portait déjà `channel`, `facility`,
`port` et `transport`. Les deux champs manquants sont ajoutés à la
structure, à l'analyseur et au rendu. Le détail qui n'est pas cosmétique :
**redéclarer un collecteur MODIFIE l'entrée existante** au lieu d'en
empiler une seconde — un collecteur est identifié par son adresse — donc
l'analyseur lit d'abord ce qui est déjà posé (`dejaLa`) et ne remet à
`null` que ce que l'opérateur retape. Sans cette lecture, poser
`source-ip` après `level` aurait effacé le `level`, et la configuration
rendue — qui est **rejouée à l'import d'une topologie** — aurait perdu la
moitié de ce qui avait été tapé. Une sévérité inconnue est refusée plutôt
que rangée.

### Huawei : `display logbuffer level <sev>` filtrait par rien

La commande n'existait pas. Elle passe par `registerGreedy`, et le seuil
descend jusqu'à `LoggingConfig.renderHuawei`, qui filtre les messages sur
`SEVERITY_ORDER[m.severity] <= seuil`. **Deux vocabulaires cohabitent** —
IOS écrit `warnings`/`errors` au pluriel, VRP `warning`/`error` au
singulier — et c'est le NUMÉRO qui les réconcilie : `VRP_SEVERITIES`
indexe dans le même ordre que `SEVERITY_ORDER`, donc la comparaison est
exacte sans table de traduction. Le compteur `Current messages` compte les
messages **retenus**, pas ceux du tampon : une vue filtrée qui annoncerait
le total serait un compte que rien ne mesure.

### Linux : `/etc/logrotate.d/rsyslog`

Le fichier de Debian rejoint `RSYSLOG_SEEDED_FILES`, avec ses vraies
directives (`rotate 4`, `weekly`, `missingok`, `notifempty`,
`postrotate`). Le §4.5 du tutoriel s'appuyait sur un fichier absent.

### Linux : `chattr +i` rend le fichier VRAIMENT immuable

Le §8.2 du tutoriel protège une archive avec `chattr +i` et le vérifie
avec `lsattr` ; aucune des deux commandes n'existait, et le VFS n'avait
aucun attribut pour les porter. `INode.immutable` est ajouté, et — c'est
tout l'intérêt — **`writeFile` et `deleteFile` le respectent** : une
archive protégée résiste à `echo … >` et à `rm -f`, ce qui est exactement
la démonstration du tutoriel. Un `chattr` qui n'aurait fait qu'afficher un
drapeau aurait enseigné le contraire de ce que la commande garantit.
`lsattr` rend la lettre à sa **position dans l'ordre du noyau**
(`----i---------e----`) : la mettre ailleurs ferait lire un autre
attribut. Seul `i` a un mécanisme derrière lui ; les autres lettres
réelles sont acceptées sans être retenues, comme sur un système de
fichiers qui ne les supporte pas — une lettre **inexistante** est refusée.

### Linux : le nom d'hôte du message survivait à peine

Voir « Ce que le récepteur fait d'un message » plus haut : c'est la
correction qui a demandé une vérification externe, et celle-ci a montré
que **deux** choses étaient réécrites à tort, pas une.

### Une leçon méthodologique de ce lot

Deux cas déjà écrits dans `rsyslog-recepteur-reel.test.ts` **encodaient le
défaut comme contrat** (« le collecteur redate le message et préfixe la
source »). Ils passaient, donc rien ne signalait le problème : c'est la
vérification contre la documentation de rsyslog — et non l'exécution de la
suite — qui l'a trouvé. Un test vert ne prouve que la cohérence du code
avec lui-même.

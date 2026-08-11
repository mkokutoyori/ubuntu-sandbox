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
- **Le message est RÉÉCRIT au format de réception** : rsyslog remplace
  l'horodatage BSD de l'émetteur par le sien et préfixe l'adresse source.
  C'est ce qui permet de corréler deux équipements dont les horloges
  divergent — le cas normal avant que NTP prenne.
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
     Aug 11 05:40:09 192.168.100.1 %SYS-5-CONFIG_I Configured from console by console
```

## Reste ouvert, écrit plutôt que tu

- **TCP (`imtcp`) est analysé et n'ouvre rien** : `ServiceSocketServer`
  reçoit bien le `PortSpec` TCP, mais l'acceptation d'une connexion et le
  découpage RFC 6587 des messages qui se suivent sur un même flux ne sont
  pas faits. Le port n'est donc pas affiché non plus — la cohérence tient,
  la fonction manque.
- **TLS (6514)** n'est pas fait, ni côté récepteur ni côté Cisco
  (`logging host … transport tls` est refusé).
- **Les renvois `@@host`** sont analysés et stockés ; rien ne réémet.
- **`logrotate`** ne tourne pas sur ces fichiers.
- Côté **Huawei**, `info-center loghost … level`, `… source-ip` et
  `display logbuffer level <n>` sont refusés — chantier voisin, non
  traité ici.

# Analyse des transcripts de debug — régénération du 3 août 2026

## 0. Ce qui a été fait

Les 125 transcripts de `debug-output/` ont été régénérés en entier
(`npx vitest run src/__tests__/debug/`, 93 fichiers de suite). 73 ont
changé.

**Aucune régression.** Le diff substantiel — une fois retirés les
horodatages, la gigue des RTT, les compteurs d'octets du VFS et les
tables `ps` — ne contient aucune erreur nouvelle. Une seule amélioration
visible : **21 lignes `%SYS-5-NOTIFICATIONS: TCP listener bound to
0.0.0.0:22` en double ont disparu**, un doublon de journal qui n'a plus
lieu d'être.

## 1. Méthode, et pourquoi elle a dû être corrigée deux fois

Le premier réflexe — compter les messages d'erreur — donne des chiffres
qui ne veulent rien dire. Trois pièges ont fait mentir le premier
dépouillement, et chacun a été trouvé en vérifiant un cas au lieu de
faire confiance au compte.

**Piège 1 — les négatifs volontaires.** Les suites contiennent des
sections explicitement nommées « cas négatifs / mal formés », « invalid
input handling », « mal formées — command not found ». `lss -la`,
`dff -h`, `freee`, `usradd toto`, `chmodd`, `grepp`, `netstatt`,
`iptabless`, `unamee`, `lsblkk`, `frobnicate`, `shww version`,
`show versionnn`, `ping 10.1.1.999`, `vlan 99999`,
`router-id 999.999.999.999` : ce sont des **tests du chemin d'erreur**.
Le refus est le comportement correct. Ils représentaient à eux seuls un
bon tiers du premier décompte.

**Piège 2 — la comparaison inter-shells.** Les suites `coherence-*`
rejouent chaque commande dans cmd **et** dans PowerShell pour comparer.
`Get-Command`, `gcm`, `Get-Alias` apparaissaient comme absents ; en
lisant le transcript, le `is not recognized` venait du **côté cmd**, où
un cmdlet PowerShell n'a effectivement rien à faire. Le côté PowerShell
répond correctement. Faux positif intégral.

**Piège 3 — les cascades.** Une commande refusée fait échouer toutes
celles qui en dépendent, et le dépouillement les compte comme autant de
manques distincts. Vérification faite sur équipement :

| Signalé par le transcript | Vérifié directement |
|---|---|
| `show interfaces Loopback0` refusé (routeur Cisco) | **fonctionne** — c'est la création du Loopback qui avait échoué en amont |
| `display port-security` refusé (Huawei) | **fonctionne** : « Port-security is not enabled on any interface. » |
| `net 192.168.1.0 0.0.0.255 a 0` refusé | correct — on n'était jamais entré en mode `router` |
| `enable` refusé | **fonctionne** — mauvaise attribution de mon extracteur |
| `rou ospf 1` refusé | **correct** : `% Ambiguous command: "rou" (matches: router, route-map)`, exactement ce que fait le vrai IOS |
| `watch -n 1 -c 1 date` → `1: command not found` | **correct** : `-c` ne prend pas d'argument, la commande *est* `1 date` |

Tout ce qui suit a donc été **rejoué sur un équipement réel du
simulateur**, pas seulement relevé dans un transcript.

---

## 2. Le manque le plus grave : la machine ment sur ce qu'elle possède

Cinq commandes sont déclarées dans `KNOWN_LINUX_COMMANDS`
(`LinuxCommandExecutor.ts`) sans avoir ni dispatch ni fichier sur le
disque. Résultat, trois réponses qui se contredisent sur la même
machine :

```
$ which mtr
/usr/bin/mtr
$ mtr 127.0.0.1
mtr: command not found
$ ls -l /usr/bin/mtr
ls: cannot access '/usr/bin/mtr': No such file or directory
```

Les cinq : **`mtr`, `tracepath`, `fuser`, `newgrp`, `apt-cache`**.

C'est pire qu'une commande absente. Un opérateur qui fait `which` avant
de lancer conclut que la commande existe et cherche la panne ailleurs ;
c'est exactement le raisonnement qu'un simulateur pédagogique doit
soutenir, pas saboter. Deux issues honnêtes, et une seule à choisir par
commande : l'implémenter, ou la retirer de la liste des noms connus.

**Priorité haute, coût faible pour la moitié du problème** : retirer les
noms non implémentés de `KNOWN_LINUX_COMMANDS` rétablit la cohérence
immédiatement, même sans écrire les commandes.

---

## 3. Linux — commandes absentes, par section pédagogique

Chaque section du transcript porte le nom de ce qu'elle enseigne. Une
commande absente d'une section qui porte son nom est un trou dans la
leçon, pas un détail.

| Section | Absentes |
|---|---|
| arborescence & disque — **tree**/du/df | `tree` (`-L`, `-a`, `-d`) |
| traçage de chemin — traceroute/**mtr** | `mtr`, `tracepath` |
| **lsof / fuser** | `fuser` (`-v`), `pmap` |
| identité système — uname/os | `lsb_release -a` |
| identité courante | `logname`, `users` |
| appartenance & vérification croisée | `lid`, `members`, `newgrp` |
| noyau — sysctl/dmesg/**modules** | `lsmod`, `modinfo` |
| mémoire — free/vmstat/proc | `swapon --show`, `swapon -s` |
| CPU — lscpu/nproc/proc | `getconf _NPROCESSORS_ONLN` |
| limites & ressources | `getconf PAGE_SIZE`, `LONG_BIT`, `-a` |
| hôte & temps / formats de date | `cal`, `cal -3` |
| paquets — apt/dpkg | `apt-cache search` |
| matériel & firmware | `sensors` |
| utilitaires divers | `yes` |

Deux d'entre elles nomment leur propre section (`tree`, `fuser`, `mtr`)
— ce sont les plus visibles pour qui suit le cours.

**Un défaut d'option, distinct** : `timeout -s TERM 1 sleep 5` rend
`1: command not found`. L'option `-s SIGNAL` n'est pas consommée, si
bien que le délai `1` est pris pour la commande. `timeout 1 sleep 5`
fonctionne. C'est le même motif que `-Argument /silent` corrigé en
phase 4 côté PowerShell : une option non reconnue ne rate pas
bruyamment, elle décale silencieusement tous les arguments.

**Et un défaut de résolution** : `wget http://192.168.10.1` répond
`Resolving 192.168.10.1... failed: Temporary failure in name
resolution`. Une adresse IP littérale n'a pas à être résolue. Le vrai
`wget` écrit `Connecting to 192.168.10.1:80...`.

---

## 4. Cisco — vérifié sur un `CiscoSwitch` et un `CiscoRouter` neufs

### 4.1 Le système de fichiers IOS n'existe pas

`dir`, `dir flash:`, `more flash:config.text`, `more nvram:startup-config`,
`verify flash:`, `fsck flash:`, `delete flash:config.text`, `pwd` :
**tous refusés**. C'est un chapitre entier de la certification (gestion
des images, sauvegarde/restauration de configuration) qui n'a aucune
prise. `boot system flash:…`, `config-register 0x2102`, `show bootvar`
et `show module` tombent avec, et avec eux la séquence de récupération
de mot de passe — l'exercice le plus enseigné du lot.

### 4.2 Table MAC statique

`mac address-table static <mac> vlan <n> interface <if>` et
`mac address-table notification change` sont refusés. La suite
`cisco-l2-08-mac-forwarding` (346 étapes) en contient vingt
invocations : le cœur de son sujet.

### 4.3 Vues de sécurité et d'état

`show storm-control`, `show storm-control broadcast`,
`show interfaces status err-disabled`. La dernière est la vue qu'on
regarde après une violation de port-security — laquelle est, elle,
bien simulée.

### 4.4 EIGRP

- classique : `metric maximum-hops`, `clear ip eigrp neighbors`,
  `show ip eigrp traffic`, `show ip eigrp accounting`
- mode nommé : tout le sous-mode (`authentication mode md5`,
  `hello-interval`, `hold-time`, `summary-address`,
  `show eigrp protocols`, `show eigrp address-family ipv4 neighbors`)

Cohérent avec ce que `CLAUDE.md` documente déjà du moteur EIGRP
(pas de timers réels, pas de Query/Reply) : la CLI reflète l'absence.

### 4.5 Divers confirmés

`log-adjacency-changes detail` (OSPF), `ipv6 ospf hello-interval` /
`dead-interval` (OSPFv3), `no bgp default ipv4-unicast`, `clock set`,
`archive` / `show archive`, `ip address negotiated`,
`crypto isakmp key … hostname <nom>`.

**Une incohérence à part** : `neighbor IBGP peer-group` est **accepté**,
puis `neighbor IBGP remote-as 65000` est **refusé**. Le groupe de pairs
se crée et ne sert à rien — accepter la première moitié d'une
construction est plus trompeur que refuser les deux.

---

## 5. Huawei — vérifié sur un `HuaweiSwitch` neuf

- **`ip address` sur une interface LoopBack** : `Error: 'ip address' is
  only valid on Vlanif interfaces.` VRP autorise une adresse sur
  LoopBack ; c'est le procédé normal pour un identifiant de routeur.
  Tout ce qui suit dans la section (`display interface LoopBack0`,
  `display ip interface LoopBack0`, et le filtre `| include`) échoue en
  cascade derrière.
- `display ip interface <interface>` n'existe pas (seule la forme
  `brief` semble présente).
- `display dhcp snooping` et `display port` répondent « Incomplete
  command » : la forme courte que VRP accepte n'est pas reconnue.
- `display ospfv3` absent.
- DHCPv6 sur switch : `ipv6 enable`, `ipv6 address … /64`,
  `dhcpv6 server <pool>` refusés.

---

## 6. Oracle — un seul manque en bloque quarante

C'est le constat à plus fort levier de tout le lot.

`oracle-end-to-end-dba` (387 étapes) crée ses trois tables de travail
aux étapes 12, 13 et 14 :

```sql
CREATE TABLE customers (id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, …);
                                    *
ORA-00900: invalid SQL statement: Expected RPAREN
```

Les trois échouent sur `GENERATED ALWAYS AS IDENTITY`. Résultat : les
**40 `ORA-00942: table or view does not exist`** du reste du fichier
portent tous sur `customers`, `products` ou `orders`. Une seule
fonctionnalité d'analyseur — les colonnes d'identité, syntaxe standard
depuis Oracle 12c — débloquerait un dixième de la suite.

Le reste de la surface SQL moderne refusée, par famille :

| Famille | Exemples refusés |
|---|---|
| DML ensembliste | `MERGE INTO … WHEN MATCHED/NOT MATCHED`, `INSERT ALL`, `INSERT FIRST` |
| Analytique | `PIVOT (…)`, `UNPIVOT (…)` |
| Fonctions table | `SELECT * FROM TABLE(f(…))`, donc tout `DBMS_XPLAN.DISPLAY*` |
| Index | `INVISIBLE`/`VISIBLE`, `ONLINE`, `COMPRESS`, `LOCAL`, `GLOBAL PARTITION BY` |
| Contraintes & triggers | `ENABLE`/`DISABLE CONSTRAINT`, `ENABLE NOVALIDATE`, `ALTER TRIGGER … ENABLE`, `DISABLE ALL TRIGGERS`, triggers composés, `AFTER DDL ON SCHEMA` |
| Stockage | `PCTFREE/PCTUSED`, `ALLOCATE EXTENT`, `DEALLOCATE UNUSED`, `SET UNUSED COLUMN`, `DROP UNUSED COLUMNS` |
| Partitionnement | `ALTER TABLE … ADD PARTITION` |
| PL/SQL | `PIPELINED`, `DETERMINISTIC`, `AUTHID DEFINER`/`CURRENT_USER` |
| Divers | `CREATE CONTEXT`, `DROP TYPE … FORCE`, `CREATE PRIVATE TEMPORARY TABLE`, `CREATE OR REPLACE FORCE VIEW`, `ALTER SYSTEM DISCONNECT SESSION` |

`dba_scheduler_jobs` est également absent du dictionnaire.

---

## 7. Ordre de traitement suggéré

Classé par rapport entre ce que ça débloque et ce que ça coûte.

1. ✅ **La cohérence de `which`** (5 noms). Aucune nouvelle
   fonctionnalité à écrire pour supprimer la contradiction : soit
   implémenter, soit retirer de la liste. C'est le seul défaut du lot
   qui fait *mentir* la machine plutôt que la laisser incomplète.
2. ✅ **Colonnes `IDENTITY` Oracle.** Une fonctionnalité d'analyseur,
   quarante étapes débloquées dans une seule suite.
3. ✅ **Le système de fichiers IOS** (`dir`/`more`/`verify`/`delete` +
   `boot system`/`config-register`). Un chapitre entier de cours, et le
   socle de l'exercice de récupération de mot de passe.
4. ✅ **`mac address-table static`.** Le sujet déclaré d'une suite de
   346 étapes.
5. ✅ **`timeout -s`** et **`wget` sur IP littérale.** Deux corrections
   d'une ligne chacune, du même genre que celles de la phase 4.
6. ✅ **Les utilitaires Linux absents** (§3). Quatorze commandes, sans
   dépendance entre elles — un lot qui se découpe librement.
7. ✅ **LoopBack Huawei** et les `display` manquants.
8. ⚠️ **EIGRP mode nommé, `show storm-control`, BGP peer-group.** Le plus
   coûteux, et le moins bloquant. Fait, sauf les minuteries du mode
   nommé — voir ci-dessous.

### Le lot 8 : le groupe de pairs était pire que décrit

L'audit notait que `neighbor IBGP peer-group` était accepté puis
`neighbor IBGP remote-as` refusé. Mesuré sur un `CiscoRouter` neuf, il y
avait une **seconde conséquence invisible dans les transcripts** : le nom
du groupe était enregistré comme un voisin dans le moteur BGP, si bien
que `show ip bgp summary` affichait

    IBGP            4 0          0        0       0    0    0 never    Idle

un pair qui n'existe pas, avec un AS 0 qui n'existe pas non plus.

Un groupe de pairs est un MODÈLE : pas de session, pas d'établissement,
rien à faire dans cette table. `BgpPeerGroup` est donc tenu à part des
voisins pour qu'on ne puisse pas les confondre, et `applyBgpPeerGroup`
recopie les réglages sur les membres après CHAQUE modification du
gabarit — sur un vrai IOS l'ordre ne compte pas, régler `remote-as` sur
le groupe après que les membres l'ont rejoint doit les atteindre quand
même. Un réglage posé explicitement sur le voisin n'est jamais écrasé :
le gabarit fournit un défaut, il ne confisque pas.

Livré avec : `no bgp default ipv4-unicast`, `metric maximum-hops`,
`show ip eigrp traffic` (compteurs **réels**, ajoutés aux points
d'émission et de réception du moteur), `show ip eigrp accounting`,
`clear ip eigrp neighbors` (qui jette vraiment les adjacences),
`show eigrp protocols`, `show eigrp address-family ipv4 neighbors`,
`log-adjacency-changes detail`, et `show storm-control` — dont la
configuration était acceptée et rangée depuis toujours sans qu'aucune vue
ne la lise.

**Deux corrections à l'audit lui-même**, toutes deux dues à une cascade
de mode dans le relevé initial : `show archive` et `archive` fonctionnent
(ils étaient mesurés depuis l'invite exec après un `exit` de trop), et
`log-adjacency-changes` marchait déjà — seul le suffixe `detail`
manquait.

**Restent délibérément refusés** : les sous-commandes de minuterie du
mode nommé (`hello-interval`, `hold-time`, `authentication mode`). Le
moteur EIGRP est explicitement sans minuteries — « une passe de
convergence EST l'intervalle de hello » — donc les accepter donnerait une
valeur que rien ne lirait. Query/Reply/SIA restent à zéro dans
`show ip eigrp traffic` pour la même raison, et c'est un fait plutôt
qu'un trou : ce moteur n'a pas d'état Active et n'en émet jamais.

### Le lot 7 : le routeur savait déjà, le switch refusait

Mesuré sur un `HuaweiSwitch` ET un `HuaweiRouter` neufs avant d'écrire
une ligne, ce qui a changé le diagnostic : **le routeur faisait déjà tout
correctement** — `ip address` sur LoopBack0, `display ip interface
LoopBack0`, la ligne dans `display ip interface brief`. Le manque était
côté switch seulement, dont le handler `ip address` était câblé en dur
sur Vlanif.

La LoopBack est une vraie interface, pas un affichage : `Switch` porte
désormais un magasin de loopbacks, et `SwitchSvi.isOwnAddress()` unifie
« SVI ou LoopBack » en UN endroit, celui que le plan L3 consulte pour
décider « pour nous ». Sans ce dernier point, un ping vers la loopback
serait routé au lieu d'être répondu et l'interface ne serait qu'une ligne
de texte.

Trois défauts préexistants sont tombés en mesurant, pas en relisant :

- `SwitchSecurityService.configureDhcpSnooping` testait `snooping enable`
  AVANT `snooping enable vlan <n>` : la branche `vlan` était
  **inatteignable**, le drapeau global était posé et le VLAN jamais
  enregistré. Invisible jusqu'ici parce que rien ne lisait cet état.
- `dhcp snooping trusted interface <if>` en vue SYSTÈME était refusé,
  si bien que `SwitchSecurityService.dhcpSnoopingTrust` n'était
  atteignable par **aucun** chemin. Les deux orthographes écrivent
  maintenant dans le magasin qui APPLIQUE, pas seulement dans celui qui
  décrit — accepter la commande sans l'appliquer aurait été pire que la
  refuser.
- `display port` et `display dhcp snooping` répondaient « Incomplete
  command » alors que l'état existait des deux côtés.

**Restent refusés, et c'est la bonne réponse** : `display ospfv3`,
`ipv6 enable`, `ipv6 address` et `dhcpv6 server` sur un switch.
`HuaweiSwitchShell` ne contient aucune occurrence d'IPv6 et `Switch` n'a
pas de pile v6 — les accepter demanderait de la construire, ce qui est un
chantier distinct et non une extension bornée de ce lot.

### Un défaut de la priorité 3, trouvé après coup

La priorité 3 avait été livrée **sans test**, et c'est ce qui a laissé
passer ceci : `show boot` était inscrit deux fois dans l'arbre de
commandes — la nouvelle version branchée sur le magasin vivant, et une
vieille figée (`showBoot()` de `CiscoCommonShow`) qui rendait
« Configuration register is 0x2102 » en dur. `CommandTrie` laisse
silencieusement la dernière inscription écraser la précédente, et la
figée était déclarée plus loin dans le fichier : `show boot` répondait
donc toujours 0x2102, **y compris après `config-register 0x2142`**, pile
dans l'exercice de récupération de mot de passe que la priorité 3 visait,
pendant que `show bootvar` annonçait 0x2142. Deux commandes synonymes qui
se contredisaient.

Le garde-fou qui l'a attrapé est `command-trie-hygiene.test.ts`, un test
qui existait déjà et qui n'était simplement pas dans le lot de fichiers
que j'avais fait tourner. La vieille fonction a été **supprimée** plutôt
qu'ajoutée à la liste d'exceptions du test : elle ne pouvait rien dire de
vrai sur un registre devenu modifiable. La priorité 3 a maintenant sa
sonde (`probe-ios-01-systeme-de-fichiers.test.ts`, 9 cas), qui vérifie
aussi ce que rien ne vérifiait — que le magasin flash est bien par
équipement et persistant.

### Ce que le lot 6 a coûté, et ce qu'il a fallu mesurer

Les quatorze sont écrites comme des `LinuxCommand` (sonde
`probe-utils-01-quatorze-absentes.test.ts`, 41 cas). Trois d'entre elles
n'étaient PAS de simples habillages, et c'est là que le travail était :

- **`lsmod`/`modinfo`** n'avaient aucune donnée derrière : il n'existait
  pas de notion de module. Une liste en dur n'aurait décrit aucun état,
  alors `kernel/KernelModuleTable.ts` en est un vrai — la table est
  **dérivée du matériel** (le pilote listé est celui de la carte réseau
  de la machine, la version celle de son noyau), « Used by » est
  l'inverse calculé des dépendances déclarées plutôt qu'une donnée
  parallèle, et `/proc/modules` est la source dont `lsmod` n'est que le
  lecteur — les deux vues ne peuvent donc pas diverger.
- **`pmap`** totalise exactement le `vsize` que `ps` annonce pour le même
  PID, mais le *découpage* en régions n'a aucune source (pas de
  `/proc/<pid>/maps`, pas de chargeur ELF). C'est écrit dans le fichier :
  le total est mesuré, la répartition est une illustration cohérente.
- **`yes`** ne peut pas être infini ici — le tube du simulateur est
  séquentiel, chaque étage s'exécutant en entier avant le suivant. Le
  flux est donc borné, et la borne est écrite dans la commande plutôt que
  subie.

Quatre écarts n'ont été trouvés qu'en comparant à un vrai binaire
installé pour l'occasion (`tree`, `ncal`, `lm-sensors`), pas en relisant
une documentation : le corps de `cal` fait **toujours six semaines**
(deux lignes blanches après février), l'année de `cal 2026` est centrée
sur les grilles **séparateurs exclus** (28 espaces, pas 30),
`lsb_release -cs` est une option **groupée** que `args.includes('-c')`
ne voit pas, et le décompte de `tree` porte sur ce qui a été **listé**,
pas parcouru. Les quatre sont des erreurs que j'avais écrites et que la
mesure a corrigées.

---

## 8. Réserve d'honnêteté

Ce document distingue deux niveaux de preuve, et ne les mélange pas :

- **Vérifié sur équipement** : tout le §2, le §4 et le §5, plus le
  constat de cascade Oracle du §6. Rejoués sur un `LinuxPC`,
  `CiscoSwitch`, `CiscoRouter` ou `HuaweiSwitch` neuf.
- **Relevé dans les transcripts sans rejeu individuel** : la liste des
  familles SQL du §6 et les sections Linux du §3. Le motif d'échec est
  net et répété, mais chaque entrée n'a pas été isolée une à une ; une
  part de cascade y reste possible, comme celle qui a été démontrée sur
  les trois `CREATE TABLE`.

Aucun chiffre de ce document ne provient d'un comptage brut de messages
d'erreur : les trois pièges du §1 rendent ces comptes faux d'un facteur
qui n'est pas connu à l'avance.

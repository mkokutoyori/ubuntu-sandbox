# PRD — NTP de bout en bout, sur les quatre plateformes

## 0. Ce qui est demandé, et la méthode

Un tutoriel — « NTP : From Zero to Hero » — doit pouvoir **se suivre**
dans le simulateur : chaque commande tapée, chaque sortie lue. Chaque
lab devient un cas de test. Ce qui manque est **implémenté**, jamais
maquillé.

Trois règles, les mêmes que `PRD-CLI-Fidelite-VRP.md` §0 :

1. **Mesuré d'abord**, sur des machines neuves, jamais déduit du code.
2. **Une commande acceptée qui ne fait rien est pire qu'une commande
   refusée** — sauf quand le matériel réel ne fait rien non plus.
3. **La configuration rendue n'est pas un affichage** : c'est le texte
   que l'import d'une topologie rejoue, donc ce qui **refait** la
   machine.

## 1. Le point de départ, mesuré

**La bonne nouvelle : le moteur est réel.** `network/ntp/NtpAgent.ts`
émet de vrais paquets UDP/123, porte les quatre horodatages de
RFC 5905, calcule offset et délai par la formule du §2 du tutoriel,
applique l'algorithme d'intersection pour écarter les *falsetickers*,
sélectionne par `prefer` puis stratum puis dispersion, et authentifie.
Un client Cisco câblé à un `ntp master 3` répond
`Clock is synchronized, stratum 4, reference is 10.0.0.1` **sans qu'on
ait rien changé**.

**Tout ce qui manque est autour.** Le tableau ci-dessous est le relevé
de départ ; chaque ligne est reproductible.

| Plateforme | Constat |
|---|---|
| Cisco | `show ntp` est un greedy qui **avale toute sa queue** : `associations detail`, `authentication-keys`, `config`, et même `packets` — qui n'existe pas — rendent le même tableau |
| Cisco | `ntp authentication-key 1 md5 ClefNTP2024Secret` est rangé `clefntp2024secret` : **le mot de passe est mis en minuscules**. Idem `ntp source Loopback0` → `loopback0` |
| Cisco | `show ntp status` n'a que 4 lignes sur 8 — ni `root delay`, ni `root dispersion`, ni `loopfilter state`, ni `last update` |
| Cisco | `ntp disable` en vue d'interface est **refusée** ; `no ntp allow mode control` et `ntp update-calendar` acceptées et rangées nulle part |
| Cisco | `NtpAgent` porte **deux** rendus de configuration qui se contredisent, le second sans aucun lecteur |
| Huawei | `display ntp-service sessions` répond **`No NTP associations`** alors que la configuration liste quatre serveurs |
| Huawei | `ntp-service refclock-master 7` est **inerte** ; `display clock` **ignore `clock timezone`** |
| Huawei | La configuration rendue est **cassée** : `authentication-mode authentication-mode md5`, et **la clé a disparu** |
| Linux | `chrony` est déclaré installé et **rien n'existe** : ni `chronyc`, ni `chronyd`, ni `/etc/chrony/chrony.conf` |
| Linux | **`timedatectl` affirme `System clock synchronized: yes`** sur une machine sans aucun démon de temps ; `set-timezone` est accepté et ne change rien |
| Windows | `w32tm` est un talon : `/query /peers`, `/config`, `/resync`, `/stripchart` **impriment la chaîne littérale `w32tm /query /status`** |
| Windows | `Get-TimeZone`/`Set-TimeZone` n'existent ni en cmd ni en PowerShell |

---

## 2. N1 — Livré : Cisco

### 2.1 Ce qui est corrigé

**La casse d'une donnée.** Le handler mettait la commande entière en
minuscules pour comparer ses mots-clés — légitime — puis rangeait la
**valeur** issue de ce même tableau. Un mot de passe et un nom
d'interface sont des **données**. `ClefNTP2024Secret` devenait
`clefntp2024secret`, donc une **autre clé** : la configuration relue à
l'import fabriquait un échec d'authentification que rien n'expliquait.
Corrigé en lisant `args` (la saisie) là où `a` (la comparaison) était lu.

**Un chemin par sous-commande.** `show ntp status`,
`show ntp associations`, `show ntp associations detail` et
`show ntp authentication-keys` sont quatre nœuds réels de l'arbre. Le
greedy de repli est **supprimé** plutôt que remplacé : sans lui, l'arbre
refuse `show ntp packets` avec le curseur d'IOS, qu'un repli maison ne
saurait pas placer aussi bien.

**Le bloc de statut est complet**, et chaque valeur est **lue** : la
fréquence réelle dérive de l'écart mesuré (`getDriftPpm`, déduit de
l'offset et de l'intervalle de scrutation, pas inventé), la dispersion
racine de celle de l'association retenue, l'âge de la mise à jour de son
horodatage de réponse. Une référence **locale** (`ntp master`) rend
désormais `root dispersion is 0.00 msec` : annoncer 16000 ms — la valeur
« aucune mesure » — sur une machine déclarée synchronisée dans le même
bloc était contradictoire.

**`show ntp associations detail`** existe. Ses huit colonnes
`filtdelay`/`filtoffset` **répètent la mesure courante**, et c'est dit
plutôt que caché : ce moteur ne garde qu'une mesure par association.
Inventer huit valeurs différentes ferait croire à un historique qui
n'existe pas ; `filterror` croît avec le rang, comme sur IOS.

**Le durcissement du §9 agit.** `ntp disable` existe en vue d'interface
et **se rejoue** (ligne rendue dans le bloc `interface`), `no ntp allow
mode control` ferme le mode 6 — celui de `monlist`, CVE-2013-5211 — et
`ntp update-calendar` est rendu. Les trois étaient acceptés et rangés
nulle part : une machine durcie revenait ouverte au premier import.

**Le second rendu de configuration est supprimé** (`runningConfigLines`,
un écrivain, zéro lecteur, et il écrivait `ntp master` sans son stratum
là où le vrai rendu écrit `ntp master 5`).

### 2.2 Tests

`tuto-ntp-cisco.test.ts` (24 cas) suit le tutoriel **section par
section** (§3.1 à §3.8, §9) plutôt que le découpage du code : ce qu'il
vérifie est qu'un lecteur peut **taper ce qui est écrit et lire ce qui
est montré**. Son dernier cas est le plus fort — *rejouer ce que la
machine rend redonne le même état* — parce que c'est la propriété qui
compte pour un tutoriel.

Discrimination par `git stash` : **14 des 24 tombent** avant. Les 10 qui
passent des deux côtés portent sur le moteur, qui était déjà réel — ils
sont là comme garde-fou, et ce sont eux qui prouvent que la
synchronisation traverse vraiment le fil.

**Deux cas existants portaient une hypothèse fausse** et sont corrigés,
jamais le code : `ntp-protocol.test.ts` lisait le rendu de configuration
mort, et tapait `show ntp` tout court — qui ne rendait le tableau que
parce que le greedy avalait tout.

**Mesures.** 163 suites Cisco vertes (2 664 cas). Un échec préexistant
et sans rapport (`probe-cli-arguments-types.test.ts`, `login-timeout` en
mode `line`), vérifié identique sur `HEAD`. Typecheck : jeu d'erreurs
identique (241).

---

## 3. N2 — Livré : Huawei

### 3.1 Le défaut central : deux magasins

Il n'était pas d'affichage. Sur une machine où l'on venait de taper
quatre serveurs :

```
[R1]display ntp-service sessions
No NTP associations
[R1]display current-configuration | include ntp
ntp-service unicast-server 192.168.100.5 preference
ntp-service unicast-server 192.168.100.6
ntp-service unicast-peer 10.0.12.2
```

Le CLI écrivait dans `RouterManagementService` — pour `unicast-server`,
dans un simple **sac de chaînes brutes** (`recordRaw`) — tandis que les
vues lisaient le `NtpAgent`, celui qui porte le protocole. **Aucune
commande NTP tapée sur un Huawei n'atteignait le moteur** : ni
association, ni synchronisation, ni authentification, alors que le même
moteur synchronise un Cisco depuis toujours.

Quatre conséquences que ce sac explique à lui seul :

1. `ntp-service refclock-master 7` rangeait la chaîne `7` et laissait la
   machine `unsynchronized`, stratum 16 ;
2. `ntp-service authentication-keyid 1 authentication-mode md5 CLE` était
   lu **en positions fixes**, si bien que l'algorithme retenu était le
   mot `authentication-mode` et que **la clé était perdue** ; la
   configuration rendue écrivait le mot deux fois de suite ;
3. un second `unicast-server` sur la même adresse **ajoutait une ligne**
   au lieu de mettre à jour — un sac de chaînes ne connaît pas les
   adresses qu'il contient ;
4. tout ce que le sac ne reconnaissait pas y entrait quand même, donc
   une **faute de frappe ressortait dans la configuration** et était
   rejouée à l'import.

### 3.2 Le fuseau horaire, indépendamment

`clock timezone WAT add 01:00:00` était accepté et **sans effet** :
l'analyseur attendait `+01:00`, une forme que VRP n'émet jamais — le
signe y est le mot `add`/`minus` et le décalage porte des **secondes**.
Aucun fuseau configuré sur un Huawei n'était donc appliqué, et
`display clock` écrivait `Time Zone(UTC) : UTC` **en dur**, sans jamais
lire la configuration d'horloge. La même commande, côté Cisco, décalait
bien l'affichage : deux plateformes, deux réponses, pour la même
intention.

### 3.3 Ce qui est fait

`huawei/huaweiNtpCommands.ts` porte **une grammaire qui valide** (au
lieu de lire des positions), **l'écriture dans l'agent** — le seul
magasin, celui de Cisco — **un rendu de configuration qui décrit l'état**
(donc qui se relit), et **les deux vues**. `display ntp-service sessions
verbose` existe. `display clock` lit le fuseau.

Deux points de fidélité VRP, tenus séparés de la mesure : VRP annonce
`Nominal frequency: 100.0000 Hz` et `Clock precision: 2^17` là où IOS
annonce 250 Hz et `2**18` ; et il écrit `LOCAL(0)` là où IOS écrit
`LOCL`. L'agent étant partagé, la traduction vit dans la vue.

Le `reach` était écrit **`377` en dur** pour toute association : la vue
affirmait huit réponses sur huit d'un serveur muet. Il est lu.

### 3.4 Tests

`tuto-ntp-huawei.test.ts` (23 cas) suit le §4 du tutoriel. Son premier
bloc vérifie que la machine **se synchronise**, pas qu'elle affiche
quelque chose ; son dernier compare les **deux plateformes entre elles** —
quelle que soit la bonne réponse, un Cisco et un Huawei branchés au même
serveur ne peuvent pas être l'un synchronisé et l'autre non. C'est la
propriété qui se vérifie sans connaître VRP.

Discrimination par `git stash` : **19 des 23 tombent** avant.

**Mesures.** 150 suites connexes vertes (2 569 cas). Le même échec
préexistant et sans rapport (`probe-cli-arguments-types.test.ts`,
`login-timeout` en mode `line`), vérifié identique sur `HEAD`.
Typecheck : jeu d'erreurs identique (241). Lint : 343 avant, 343 après.
Aucun test existant modifié.

---

## 4. N3 — Livré : Linux (chrony)

### 4.1 Le point de départ, le plus grave des quatre

Le paquet `chrony` était déclaré installé par `apt-get` et `dpkg`, et
**rien n'existait** : ni `chronyc`, ni `chronyd`, ni son unité, ni
`/etc/chrony/chrony.conf`. Une machine annonçait un logiciel qu'elle
n'avait pas — la forme de défaut que ce dépôt a déjà fermée pour
`openssl`.

Pire, sur cette même machine sans **aucun** démon de temps :

```
$ timedatectl
System clock synchronized: yes
              NTP service: active
```

Deux affirmations que rien ne soutenait. La vue écrivait aussi le
décalage `(UTC, +0000)` **en dur** quel que soit le fuseau, et
`timedatectl set-timezone Africa/Douala` était accepté sans rien changer
— `list-timezones` ne rendait rien et `/etc/localtime` n'existait pas.

### 4.2 Ce qui est fait

**Pas de second moteur NTP.** chronyd pilote le `NtpAgent`, le même que
Cisco et Huawei : un simulateur avec deux moteurs finirait par donner
deux réponses à la même question — facture que ce dépôt a déjà payée
ailleurs (deux registres Windows, deux piles SSH). Ce que le démon
apporte est ce que chronyd apporte vraiment : la **lecture** de son
fichier de configuration.

Quatre modules : `time/TimezoneDatabase.ts` (une cinquantaine de zones
avec décalage et abréviation), `time/ChronyConfig.ts` (l'analyseur),
`time/LinuxChronyService.ts` (le démon), `time/ChronycViews.ts` (les
vues du §5.3). Plus `chronyc` et un `timedatectl` réécrit.

**Un chaînon manquait ailleurs, et c'est lui qui bloquait tout** :
`EndHost.deliverUDP` ne remettait pas l'UDP/123 à un agent NTP. L'hôte
émettait ses requêtes et **aucune réponse ne revenait jamais** — mesuré,
pas supposé : les sources restaient `offline` alors que le fichier était
correctement lu et les paquets correctement émis. Aucune machine Linux
ne pouvait donc se synchroniser, quel que soit le reste.

**L'unité répond à ses deux noms.** Debian la nomme `chrony`, RHEL
`chronyd`, et le tutoriel montre les deux (`systemctl enable --now
chronyd`) : un lecteur qui suit la colonne RHEL ne doit pas tomber sur
un `Unit could not be found` qui ne lui apprendrait rien sur NTP.
L'alias passe par `UNIT_ALIASES`, là où `bind9` → `named` vit déjà.

### 4.3 Trois décisions, et leur raison

**Un fichier de configuration MANQUANT empêche le démarrage** (`Cannot
open configuration file`), un fichier **VIDE** ne l'empêche pas : c'est
la distinction que `CriticalFiles.ts` tient déjà pour sshd, et elle est
vraie de chronyd aussi.

**Le quota de `makestep <seuil> <limite>` est réel** : après
`makestep 1.0 3`, un quatrieme `chronyc makestep` est refusé — sinon la
directive ne voudrait rien dire.

**`iburst` est la seule directive dont l'effet est observable ici** :
elle demande une rafale au démarrage, donc une convergence immédiate.
C'est exactement ce que le tutoriel annonce, et c'est mesurable.

### 4.4 Ce qui est porté sans agir, et pourquoi c'est écrit

`ChronyConfig` distingue **trois** familles, jamais deux : les
directives **lues et agissantes**, celles que chronyd connaît et que ce
simulateur **n'applique pas** (`refclock` — aucun matériel derrière —,
`hwtimestamp`, `leapsectz`…), et celles qu'**aucun** chronyd ne connaît,
qui sont **signalées** avec leur numéro de ligne. Confondre les deux
dernières ferait passer une faute de frappe pour une limitation.

`TimezoneDatabase` porte un décalage **fixe** par zone : la vraie tzdata
décrit les règles d'heure d'été sur plus d'un siècle, et inventer une
date de bascule serait pire que de ne pas en avoir — personne ne
pourrait la vérifier. Conséquence assumée et écrite dans le fichier :
`Europe/Paris` vaut ici UTC+1 toute l'année.

`chronyc sourcestats` rend `NP`/`NR` à 1 : ce moteur garde **une**
mesure par source. Inventer vingt-et-un échantillons ferait croire à un
historique qui n'existe pas.

### 4.5 Tests

`tuto-ntp-linux.test.ts` (27 cas) suit le §5 du tutoriel. Le premier
bloc vérifie que la machine **se synchronise** avec un vrai serveur au
bout d'un vrai câble ; le reste ne serait que du texte. Un cas vérifie
que `/etc/chrony/chrony.conf` **appartient à root**, donc que le
tutoriel a raison d'écrire `sudo`. Deux cas séparent ce que
`timedatectl` sait de deux choses différentes : le **service** peut être
actif et l'**horloge** non synchronisée — c'est précisément le cas qu'un
dépannage cherche.

Discrimination par `git stash` : **23 des 27 tombent** avant.

**Mesures.** 131 suites connexes vertes (2 874 cas). Typecheck : jeu
d'erreurs identique (213). Aucun test existant modifié.

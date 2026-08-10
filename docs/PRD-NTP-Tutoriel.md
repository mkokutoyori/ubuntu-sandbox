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

---

## 5. N4 — Livré : Windows (W32Time)

### 5.1 Le point de départ

`w32tm` était un talon **d'une seule branche** : toute sous-commande
autre que `/query /status` renvoyait la **chaîne littérale**
`w32tm /query /status`.

```
C:\> w32tm /query /peers
w32tm /query /status
C:\> w32tm /resync /force
w32tm /query /status
```

Et `/query /status` lui-même était un bloc fixe de quatre lignes :
`Stratum: 3` **écrit en dur** sur une machine qui n'interrogeait
personne, et `Source` valant le PDC du domaine quoi qu'ait configuré
l'opérateur — donc `w32tm /config /manualpeerlist` n'avait **aucun**
effet observable. `Get-TimeZone`/`Set-TimeZone` n'existaient ni en cmd
ni en PowerShell : le §6.3 du tutoriel ne pouvait pas se suivre.

### 5.2 Ce qui est fait

**Pas de troisième moteur.** W32Time pilote le `NtpAgent`, comme
chronyd. Ce qu'il apporte est ce que W32Time apporte vraiment : la liste
de pairs, les drapeaux de synchronisation, et la notion de « source
fiable » qui structure toute la hiérarchie AD du §6.1.

Les huit sous-commandes du tutoriel sont réelles : `/query
{status|peers|configuration|source}`, `/config`, `/resync`,
`/stripchart`, `/monitor`.

### 5.3 Quatre décisions, et leur raison

**Les drapeaux choisissent vraiment le mode.** `0x8` crée un client,
`0x1` un pair symétrique — les bits se cumulent (`0x9` =
SpecialInterval|Client), donc c'est le **bit de mode** qui décide, pas
la valeur entière. `0x2` (broadcast) est **refusé** plutôt que rangé
sans effet : ce simulateur n'a pas de mode broadcast NTP, et l'accepter
ferait croire à une écoute qui n'existe pas.

**`/syncfromflags:domhier` ignore la liste manuelle.** C'est la règle
que le §6.1 énonce — seul le PDC Emulator pointe vers l'extérieur — et
la faire agir est ce qui rend le lab **vérifiable** au lieu d'être une
phrase.

**`/config` sans `/update` enregistre sans appliquer.** C'est la raison
d'être du drapeau ; l'ignorer ferait croire qu'un `w32tm /config` a pris
effet.

**`/stripchart` mesure vraiment** : chaque échantillon est une
interrogation, l'écart imprimé est celui que l'agent vient de calculer,
et une cible muette rend l'erreur `0x800705B4` du vrai outil — le seul
résultat utile d'un test de connectivité. Il ne laisse **pas** de pair
derrière lui : il mesure, il ne configure pas.

### 5.4 Le fuseau, partagé avec Linux

`Get-TimeZone`/`Set-TimeZone` lisent et écrivent la `SystemIdentity` que
`EndHost` portait **déjà** — pas un second magasin — et le décalage se
résout par la **même** table que `timedatectl` (`TimezoneDatabase`).
Sans cela, une machine Windows et une machine Linux du même laboratoire
donneraient deux décalages différents pour `WAT`. Windows nommant ses
fuseaux autrement que tzdata (`W. Central Africa Standard Time` contre
`Africa/Douala`), la correspondance est **explicite** plutôt que devinée,
et un identifiant inconnu est refusé comme le vrai applet le refuse.

### 5.5 Tests

`tuto-ntp-windows.test.ts` (23 cas) suit le §6 du tutoriel. Un cas
vérifie que les quatre `/query` **ne se répètent pas** — c'est
exactement ce que le talon faisait. Le dernier branche un Windows et un
Cisco sur le même maître et vérifie qu'ils atteignent la **même
strate** : la propriété se contrôle sans connaître W32Time.

Discrimination par `git stash` : **22 des 23 tombent** avant.

**Mesures.** 124 suites connexes vertes (1 807 cas) plus les 61 suites
PowerShell (1 912 cas). Aucun test existant modifié.

> **Correction (lot N5).** La phrase « Typecheck : jeu d'erreurs
> identique (213) » qui figurait ici était **fausse**. Elle avait été
> mesurée avant l'écriture de `tuto-ntp-windows.test.ts`, et le
> comparatif `git stash -u` remisait précisément ce fichier non suivi —
> donc la mesure ne l'a jamais vu. Ce fichier construisait
> `new WindowsPC(\`W${n}\`)` alors que le premier paramètre est un
> `DeviceType`, ce qui ajoutait **12 erreurs de typage**. Elles ne
> changeaient rien à l'exécution (Vitest ne typecheck pas), mais
> l'affirmation était inexacte. Corrigé au lot N5, qui ramène le
> décompte **sous** la ligne de base. Leçon retenue et appliquée
> désormais : mesurer le typecheck **après** avoir écrit les tests, pas
> avant.

---

## 6. État du chantier

| Lot | Plateforme | État |
|---|---|---|
| N1 | Cisco IOS | **Livré** |
| N2 | Huawei VRP | **Livré** |
| N3 | Linux (chrony) | **Livré** |
| N4 | Windows (W32Time) | **Livré** |

Le tutoriel se suit de bout en bout : **97 cas** répartis en quatre
suites reproduisent ses labs, et **78** d'entre eux tombent sans les
correctifs.

### Ce qui reste ouvert, nommé plutôt que tu

- **L'authentification NTP ne signe pas** : la clé est portée, comparée
  et rendue, mais aucun condensé MD5 ne circule sur le paquet — le
  moteur compare des identifiants de clé. Un lab « les clés diffèrent,
  la synchronisation échoue » n'est donc pas reproductible aujourd'hui.
- **`ntp broadcast`/`multicast`, PTP, et les horloges matérielles**
  (`refclock`) : hors périmètre, faute de brique.


---

## 7. N5 — Livré : l'authentification signe

### 7.1 Le défaut, mesuré

`checkAuthentication` ne regardait que le **numéro** de clé. Trois
laboratoires, un client et un serveur `ntp master 2` sur un vrai câble :

| Configuration | Attendu (tuto §3.6) | Mesuré |
|---|---|---|
| Mêmes clés | synchronisé | synchronisé |
| **Clés différentes** | **REJET** | **synchronisé** |
| **Client sans aucune clé** | **REJET** | **synchronisé** |

Le troisième cas dit tout : le client n'a ni `ntp authenticate`, ni
`authentication-key`, ni `trusted-key`. Il lui suffit d'écrire
`ntp server 10.0.0.1 key 1` — de **nommer** un numéro — pour être
accepté. **Nommer une clé suffisait ; connaître son secret n'était pas
requis.** C'est exactement l'usurpation que le §9 du tutoriel décrit
comme la raison d'être de l'authentification.

Deux constats de plus : le **client ne vérifiait jamais la réponse**
(`acceptServerReply` n'appelait pas l'authentification du tout), et
`show ntp associations detail` ne montrait **rien** de l'état
d'authentification.

### 7.2 Ce qui est fait

`ntp/auth.ts` sérialise **un vrai en-tête NTP de 48 octets** — ordre
gros-boutien, virgule fixe 16.16 pour le délai et la dispersion, 32.32
pour les horodatages depuis 1900, exposant de précision **signé** — et
le signe `MD5(clé ‖ en-tête)`. Le `md5` du dépôt est réel, donc le
condensé l'est : il **dépend** de chaque champ signé, ce qu'un cas de
test vérifie sur les douze.

La signature est posée dans `sendNtp`, **point unique** traversé par les
trois émetteurs (requête, réponse serveur, réponse symétrique) : trois
endroits finiraient par diverger.

### 7.3 Ce qui a été vérifié contre le matériel réel, et ce que ça a changé

**C'est ici que la recherche a le plus servi**, et elle a corrigé
**quatre** choses, dont deux de mes propres décisions :

1. **La référence était fausse.** J'avais cité RFC 1305 annexe C.
   RFC 5905 §7.3 précise que « the MAC computation used here **differs**
   from those defined in [RFC1305] and [RFC4330] but is consistent with
   how existing implementations generate a MAC ». C'est donc RFC 5905
   qui est implémentée. Le texte exact de la RFC — « 128-bit MD5 hash
   computed over the key followed by the NTP packet header and extension
   fields (but not the Key Identifier or Message Digest fields) » —
   confirme la construction, y compris l'exclusion du numéro de clé et
   du condensé, qu'un cas vérifie.

2. **Le message que le tutoriel annonce n'a pas pu être confirmé.** Le
   tutoriel affirme qu'un `%NTP-4-AUTHENTICATION_FAILURE` apparaît. Les
   sources consultées décrivent au contraire un rejet **silencieux** —
   « a mismatched secret does not throw a loud error » — diagnostiqué
   par `show ntp associations detail` et `debug ntp validity`. J'avais
   écrit ce message ; **je l'ai retiré**. Émettre un syslog qu'un vrai
   routeur n'écrit pas apprendrait à chercher une ligne qui n'existe
   pas, ce qui est pire qu'une absence. Un cas de test le **pin** :
   le journal ne doit rien contenir.

3. **`show ntp associations detail` est la seule vue qui montre l'état
   d'authentification.** La documentation et les transcriptions
   concordent : « basic `show ntp associations` won't reveal
   authentication status — you must use the `detail` keyword ». La vue
   rend désormais `authenticated` / `unauthenticated`, et un cas vérifie
   que la vue **brève** ne le montre pas — sans quoi on enseignerait un
   diagnostic que le matériel ne permet pas.

4. **Un serveur ne se tait pas : il répond par un crypto-NAK.** « The
   server responds with authenticated packets if correct, or a
   crypto-NAK packet if not. » C'est un paquet dont l'identifiant de clé
   vaut **zéro** — réservé, la RFC autorisant 65 535 clés « à
   l'exclusion de zéro » — et qui ne porte aucun condensé. Il est
   implémenté, et il est **plus instructif** que le silence : le client
   apprend que son authentification a échoué au lieu d'un timeout
   indiscernable d'un serveur en panne.

**Un défaut introduit puis attrapé en chemin**, à signaler parce qu'il
illustre le risque : en ajoutant le crypto-NAK, le client s'est mis à
**se synchroniser sur le NAK lui-même** — à régler son horloge sur le
paquet qui dit « je te refuse ». Le cas « client sans aucune clé » l'a
attrapé immédiatement. Un crypto-NAK est un refus, jamais une mesure.

### 7.4 Trois refus distincts, et pourquoi

`checkAuthentication` rend quatre raisons plutôt qu'un booléen, parce
qu'elles envoient l'opérateur à quatre endroits différents : pas de clé
du tout, clé inconnue, clé connue mais **non déclarée fiable** (le
`trusted-key` manquant — « définir une clé n'est pas la faire
confiance »), et **condensé faux**, le seul qui dénonce une usurpation
plutôt qu'une faute de configuration.

Un cas pin aussi la cause la plus fréquente de « je croyais
authentifier » : des clés déclarées **sans** `ntp authenticate` ne font
rien, et le client se synchronise.

### 7.5 Tests

`tuto-ntp-authentification.test.ts` (20 cas). `git stash` : **6
tombent** avant. Les 14 autres sont nommés dans l'en-tête du fichier
plutôt que laissés à découvrir — sept portent sur le module `auth.ts`
(qui n'existait pas, donc ne discriminent rien) et sept sont des
**témoins** qui doivent passer des deux côtés.

**Mesures.** 168 suites connexes vertes (2 488 cas) — Cisco, Huawei,
FHRP, tutoriels, famille NTP complète. Typecheck : **228 avant, 216
après** — douze de moins, parce que ce lot corrige les douze erreurs que
le lot N4 avait introduites dans son propre fichier de test (voir la
correction au §5.5). Aucun test existant modifié.


---

## 8. N6 — Livré : `ntp access-group` filtre

### 8.1 Le défaut

Les quatre groupes étaient acceptés, rangés et rendus dans la
configuration — et **aucune ACL n'était consultée à la réception d'un
paquet NTP**. Le durcissement des §3.7 et §9 du tutoriel n'avait aucun
effet observable.

### 8.2 Ce que la vérification contre la documentation a apporté

**Quatre points, dont un qui corrige le tutoriel et un mon propre lot.**

1. **La table des permissions**, telle que la référence de commandes IOS
   la décrit :

   | Mot-clé | Requêtes de temps | Requêtes de contrôle | Se **synchroniser** dessus |
   |---|---|---|---|
   | `peer` | oui | oui | **oui** |
   | `serve` | oui | oui | non |
   | `serve-only` | oui | non | non |
   | `query-only` | non | oui | non |

2. **`nomodify` n'est pas un mot-clé IOS.** Le tutoriel écrit
   `ntp access-group nomodify 10` ; c'est la syntaxe de `ntpd`/`chrony`.
   Il est désormais **refusé** — et **mon propre lot N1 l'acceptait**,
   son test l'ayant recopié du tutoriel. Corrigé dans les deux.

3. **L'ordre va du moins au plus restrictif** — `peer`, `serve`,
   `serve-only`, `query-only` — et le premier groupe dont l'ACL accepte
   la source décide ; une source qu'aucun ne reconnaît est écartée.

   *Écart de sources, écrit plutôt que tu* : une page de la référence de
   commandes Cisco place `query-only` en **deuxième** position. Deux
   autres sources — dont la description de `ntp access-group match-all`
   — le placent en quatrième, seul ordre cohérent avec « du moins au
   plus restrictif », `query-only` interdisant précisément les requêtes
   de temps que `serve` autorise. C'est ce dernier qui est implémenté.

4. **Aucun groupe = accès complet ; un seul groupe = seulement ce qu'il
   accorde.** C'est le piège que le §3.7 tend sans le dire, et il est
   maintenant reproductible : un routeur en `serve-only` **continue de
   servir l'heure** et **cesse de se synchroniser**, puisque se
   synchroniser demande `peer`. Deux cas de test le montrent, et un
   troisième montre la correction — ajouter `peer`.

### 8.3 Ce qui est fait

`ntp/accessGroups.ts` porte la table, l'ordre et le verdict.
`NtpAgent.setAclMatchFn` est un port étroit — même motif que
`NATEngine.setACLMatchFn` — et `CiscoRouter` le branche sur
`Router.evaluateAclPermit`, **un seul point d'évaluation** partagé avec
NAT et les VTY : deux évaluateurs finiraient par répondre différemment
pour la même liste.

Le contrôle s'applique aux **trois** chemins : requête de client entrante
(`serve-time`), pair symétrique (`sync-from`), et réponse de serveur
que l'on veut utiliser (`sync-from`).

**Le refus est silencieux sur le fil** : un routeur qui répondrait « tu
n'as pas le droit » confirmerait son existence à qui le sonde, ce qui
est l'inverse d'un durcissement. L'événement `ntp.access.denied` est
publié, ce qui rend le refus observable sans rien émettre.

### 8.4 Tests

`tuto-ntp-access-group.test.ts` (18 cas). `git stash` : **5 tombent**
avant. Les 13 autres se partagent entre la table de permissions —
module neuf, donc sans pouvoir discriminer — et les témoins (aucun
groupe, ACL qui permet, `serve`/`peer`) qui doivent passer des deux
côtés.

**Mesures.** 175 suites connexes vertes (2 540 cas). Typecheck : 216,
inchangé. **Un test existant corrigé** — le mien, au lot N1, qui avait
recopié le `nomodify` du tutoriel.

### 8.5 Ce qui reste hors de portée, et pourquoi

`ntp access-group match-all` existe sur IOS et change la règle : au lieu
de s'arrêter au premier groupe qui reconnaît la source, il les parcourt
tous. Il n'est **pas** implémenté — la commande est refusée plutôt
qu'acceptée sans effet — parce que les sources consultées décrivent son
existence sans en donner la sémantique exacte de combinaison, et
qu'implémenter une règle devinée serait précisément ce que ce PRD
interdit.

Les requêtes de **contrôle** (mode 6) n'existent pas dans ce simulateur :
`query-only` est donc structurellement inerte sur le fil, et sa seule
conséquence observable est de **refuser** les requêtes de temps — ce que
le test vérifie. C'est un fait sur ce moteur, pas une approximation.


---

## 9. N7 — Livré : `ntp ?` décrit ce que `ntp` a

### 9.1 Le défaut, signalé depuis une vraie session

```
Router1(config)#ntp ?
  access-group        Specify access control for packets
  …
  md5                 MD5 authentication
  mode                Set trunking mode of the interface
  prefer              Preferred server
```

Trois de ces mots ne sont pas des sous-commandes de `ntp` : `md5` est un
argument d'`authentication-key`, `prefer` un argument de `server`, et
**`mode` porte la description de `switchport mode`** — une fuite d'une
commande vers une autre.

Et la même liste revenait à **toutes les profondeurs** :
`ntp access-group access-group access-group ?` la reproposait, et la
commande était **acceptée**.

### 9.2 La cause

`ntp` était un unique nœud **glouton**. Un tel nœud n'a pas de
sous-arbre — son aide ne peut donc rien descendre — et la liste proposée
était **extraite du code source du gestionnaire** par
`autoContinuations`, qui ramasse tout mot comparé dans un `if`. D'où
`md5` (comparé pour `authentication-key`), `prefer` (comparé pour
`server`) et `mode` (comparé pour `allow mode control`), ce dernier
recevant la description que le catalogue partagé associe au mot `mode`.

### 9.3 Ce qui est fait

Chaque sous-commande de `ntp` est un **vrai nœud**, déclaré depuis la
référence de commandes IOS. Les enfants déclarés sont exclus de
l'extraction, chacun porte sa propre aide, et ce qui n'est pas dans la
table est refusé.

Les corps des deux gestionnaires deviennent `appliquerNtp` /
`retirerNtp`, partagés par toutes les sous-commandes : un analyseur par
mot-clé finirait par diverger sur ce que `ntp server` et `ntp peer` ont
en commun.

Les arguments sont **décrits** : `ntp access-group ?` nomme les quatre
familles, `ntp master ?` donne `<1-15>`, `ntp authentication-key ?`
donne `<1-4294967295>`, `ntp server ?` attend `A.B.C.D`.

**Une sous-commande sans argument est déclarée non gloutonne**
(`authenticate`, `update-calendar`) : sinon `ntp authenticate ?`
proposerait un `WORD` recopiant la description de son parent — le défaut
exact que ce lot ferme, et que la sonde de l'autre agent a attrapé sur
mes propres nœuds pendant le développement.

### 9.4 Tests

`tuto-ntp-aide-arborescence.test.ts` (12 cas). Un cas vérifie qu'**aucune
description ne se répète** dans `ntp ?` — une description recopiée du
parent apparaîtrait deux fois. Deux cas gardent les formes légitimes et
les formes `no`, parce que restructurer un arbre ne doit rien casser.

**Mesures.** 141 suites connexes vertes (1 973 cas), dont les trois
sondes d'aide CLI de l'autre agent. Typecheck : 216, inchangé.

### 9.5 Ce qui reste, et à qui

`ntp access-group access-group access-group ?` propose encore un `WORD`
générique, alors que la **commande** est correctement refusée. L'aide et
l'exécution ne disent donc pas tout à fait la même chose après un
argument invalide. C'est un comportement du marcheur d'arguments
partagé, pas de `ntp` : signalé à l'agent qui tient ces sondes plutôt
que corrigé ici.


---

## 10. N8 — Livré : les compteurs de paquets

### 10.1 Un refus à corriger, et c'est le mien

Au lot N1, `show ntp packets` a été **refusée** au motif que « rien ne
les compte ». Le motif était vrai du moteur ; la conclusion était
fausse. **La commande existe sur IOS**, son format est documenté, et
elle accepte un filtre `mode {active|client|passive|server}`.

Refuser une vraie commande parce que sa matière manque revient à
**cacher** le manque plutôt qu'à le combler. Un apprenant qui tape
`show ntp packets` sur une vraie machine obtient une réponse ; sur le
simulateur il obtenait `% Invalid input detected`, ce qui lui apprenait
que la commande n'existe pas.

### 10.2 Les trois formats, vérifiés avant d'écrire

| Plateforme | Commande | Source |
|---|---|---|
| Cisco | `show ntp packets [mode …]` | Référence de commandes IOS — quatre lignes : `Ntp In packets`, `Ntp Out packets`, `Ntp bad version packets`, `Ntp protocol error packets` |
| Huawei | `display ntp-service statistics packet` | Documentation Huawei — quinze compteurs sous `NTP IPv4 Packet Statistical Information` |
| chrony | `chronyc serverstats` | Documentation chrony — distingue les paquets **NTP** des paquets de **commande** |

### 10.3 Un seul comptage, trois lectures

`NtpCounters` porte des noms **neutres** : Cisco dit « Ntp In packets »,
Huawei « Received », chrony « NTP packets received ». Trois vues sur un
seul comptage — un compteur par plateforme finirait par donner trois
nombres pour un seul fait.

Six compteurs sont observés **au point où l'événement a lieu** :
`received`/`sent` (avec leur ventilation par mode), `processed`,
`dropped`, `authFailures`, `accessDenied`, plus `badVersion` et
`protocolError`.

### 10.4 L'identité qui fait la différence

`reçus = traités + écartés`. Elle se vérifie **sans connaître aucune
plateforme**, et c'est elle qui distingue un comptage d'un affichage.
Un cas la contrôle sur quatre configurations : sans rien, avec
authentification, avec un `access-group` qui refuse, avec un qui permet.

Elle a d'ailleurs **attrapé un défaut pendant l'écriture** : les portes
d'accès se franchissent après l'aiguillage — une fois le mode connu —
donc un paquet était compté « traité » puis écarté, et l'identité
tombait à `2 = 1`. Le comptage est repris au point du rejet, comme il
l'était déjà pour le crypto-NAK.

Deux autres propriétés vérifiées plutôt que supposées : **la somme des
modes redonne le total** (ce qui distingue une ventilation d'une
invention), et **les compteurs du client et du serveur se répondent** —
ce que l'un a émis, l'autre l'a reçu.

### 10.5 Ce qui vaut zéro, et pourquoi c'est vrai

Neuf des quinze compteurs Huawei valent zéro **parce que le mécanisme
n'existe pas** : pas de limiteur de débit, pas de file de traitement,
pas de plafond d'associations dynamiques. Aucun paquet n'a jamais **pu**
être limité, retardé ou refusé pour ces motifs — zéro est la vraie
valeur. Les omettre donnerait un format qui n'est pas celui de la
machine ; inventer un nombre serait pire. Même raisonnement pour les
deux compteurs de **commande** de chrony : ce simulateur n'a pas de
socket de contrôle, `chronyc` parlant au démon dans le même processus.

`clear ntp statistics` et `reset ntp-service statistics packet`
remettent à zéro : un compteur qu'on ne peut pas effacer ne sert qu'à
moitié, un diagnostic commençant par effacer, provoquer, relire.

### 10.6 Tests

`tuto-ntp-compteurs.test.ts` (18 cas). `git stash` : **17 tombent**
avant. **Un test existant corrigé** — le mien, au lot N1, qui prenait
`show ntp packets` pour exemple d'une commande inexistante.

**Mesures.** 260 suites connexes vertes (4 770 cas). Typecheck : 216,
inchangé.


---

## 11. N9 — Livré : la discipline de l'horloge

### 11.1 Le défaut

`selectAndSync` posait `config.offsetMs = best.offsetMs` : **tout écart
était appliqué d'un coup**, quelle qu'en soit la taille. Le §2 du
tutoriel — glissement, saut, mode panique — n'avait aucune contrepartie
observable, et `chronyc makestep` corrigeait un écart déjà corrigé.

### 11.2 Où le tutoriel simplifie, et pourquoi ça compte

Le tutoriel écrit : « **Stepping (saut)** : si l'offset est grand
(> 128ms), NTP peut corriger d'un coup. »

La documentation de référence dit autre chose :

> « When an offset exceeds the 128 ms step threshold, it is **initially
> discarded** rather than applied immediately. However, if such large
> offsets persist beyond the stepout threshold, the system then performs
> a clock step. »

Un écart au-delà du seuil est donc d'abord tenu pour une **aberration**
— une pointe de congestion réseau — et **ignoré**. Seule sa
**persistance** au-delà du seuil de sortie le rend crédible.

**C'est exactement ce qui empêche une mesure isolée de dérégler une
machine.** Un simulateur qui sauterait tout de suite enseignerait le
contraire d'une protection — et c'est le genre d'erreur qu'un apprenant
emporterait en production.

Les valeurs, vérifiées :

| Seuil | Valeur |
|---|---|
| Saut (`STEPT`) | 128 ms |
| Sortie d'aberration | 300 s |
| Panique (`PANICT`) | 1000 s |
| Vitesse de glissement max | 500 ppm |

500 ppm est la limite du noyau Unix, « requiring approximately 33
minutes per second of correction » : corriger une seconde par
glissement demande une demi-heure. C'est **pourquoi** le saut existe, et
pourquoi une machine qui démarre à la mauvaise heure a le droit d'en
faire un.

### 11.3 Ce qui est fait

`ntp/discipline.ts` porte la machine à états et les quatre décisions —
`slew`, `step`, `spike`, `panic`. `selectAndSync` la traverse ; une
aberration ou une panique **ne synchronise pas**, donc la strate ne
descend pas et l'horloge garde ce qu'elle avait.

`show ntp status` lit l'état réel : `loopfilter state` valait `CTRL` dès
que la machine était synchronisée, donc il ne pouvait **jamais**
annoncer une aberration ni une panique — les deux états que cette ligne
existe pour montrer.

`makestep <seuil> <limite>` de chrony était analysé, stocké, rendu — et
n'atteignait jamais la discipline. C'est désormais un **réglage** : il
remplace les 128 ms et borne le nombre de sauts. Et `chronyc makestep`
**force** le saut au lieu de seulement compter.

### 11.4 Ce qui n'est pas modélisé, et pourquoi

La machine réelle a cinq états ; il y en a quatre ici. **`FREQ` est
absent** parce qu'il sert à l'entraînement de **fréquence**, et que ce
simulateur n'a pas d'horloge matérielle qui dérive — la dérive y est une
mesure, pas une propriété du quartz. Ajouter un état qu'aucune
transition ne pourrait quitter pour la bonne raison vaudrait moins que
de le dire.

### 11.5 Tests

`tuto-ntp-discipline.test.ts` (22 cas). `git stash` : **5 tombent**
avant — les cinq qui passent par une vraie machine. Les dix-sept autres
exercent le module neuf et sont nommés comme garde-fous dans l'en-tête.

**Une assertion à moi corrigée pendant l'écriture** : j'avais vérifié
que `chronyc makestep` laisse `derniereDecision === 'step'`. Faux — la
commande réinterroge après avoir sauté, et cette mesure-là ne trouve
plus rien à corriger. L'assertion testait l'ordre des appels plutôt que
l'effet ; elle porte maintenant sur l'écart rattrapé.

**Mesures.** 249 suites connexes vertes (4 636 cas). Typecheck : 216,
inchangé.

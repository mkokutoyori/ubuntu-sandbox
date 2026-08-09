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

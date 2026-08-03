# PRD — Les tâches planifiées, Linux et Windows

## 0. Comment ce document a été écrit

Rien ici n'est déduit d'une lecture du code seul. Chaque affirmation vient
d'une exécution : des sondes jetables ont fait tourner une soixantaine de
commandes sur un `LinuxPC` et un `WindowsPC` réels, et les sorties sont
citées telles quelles.

Cette méthode a déjà corrigé deux erreurs pendant la rédaction :

- j'ai d'abord conclu que les timers systemd étaient absents, parce que
  `systemctl list-timers` restait vide. C'était ma sonde qui n'écrivait pas
  le fichier `.timer` (`sudo sh -c "printf … > fichier"` ne redirigeait
  rien). Écrit par le VFS, le timer se charge, s'arme et s'affiche. **Les
  timers marchent** ; le défaut réel est ailleurs, et bien plus précis (§2.2).
- j'ai d'abord cru que le crontab utilisateur n'était pas stocké sur disque,
  parce que `/var/spool/cron/crontabs` était vide — je l'avais listé *avant*
  d'installer un crontab. Le fichier existe bien, `-rw------- root root`, au
  bon chemin.

Ce qui suit distingue donc trois choses, et ne les mélange pas : ce qui
marche, ce qui répond faux, ce qui n'existe pas.

---

## 1. Vue d'ensemble

Les deux plateformes ont un moteur d'exécution réel. Ce n'est pas de la
figuration : sous Linux, trois minutes simulées produisent les lignes
attendues dans le fichier cible, une trace `CRON[105]: (user) CMD (…)` dans
`/var/log/syslog`, et un courriel quand `MAILTO` est posé. Sous Windows,
`fireDueScheduledTasks()` relance réellement le programme, réarme la tâche
sur son intervalle, et exécute même un `powershell -File script.ps1` sans
terminal.

La différence de fond est **ce qui fait avancer le temps** :

| | Linux | Windows |
|---|---|---|
| Moteur | `CronEngine` + `TimerScheduler` | `fireDueScheduledTasks()` |
| Déclencheur | `hostTimers.setInterval(…, 60_000)` — autonome | `advanceTime(ms)` seulement |
| Conséquence | une tâche part toute seule | rien ne part sans appel explicite |

Aucun `setInterval` n'existe dans `WindowsPC.ts`, et `advanceTime` n'est
appelé nulle part hors des tests et d'un pont PowerShell. **Une tâche
planifiée Windows ne se déclenche donc jamais d'elle-même dans un lab.**
C'est l'asymétrie la plus structurante de ce document.

---

## 2. Linux — état mesuré

### 2.1 Ce qui est réel

- `crontab -l`, `-e`, `-r`, `-u <user>`, et l'installation par tube
  (`… | crontab -`). Le stockage est un vrai fichier :
  `/var/spool/cron/crontabs/<user>`, mode `600`, propriétaire `root`.
- `crontab -l -u nobody` sans privilège rend bien
  `crontab: must be privileged to use -u`.
- `/etc/crontab` est amorcé avec les quatre lignes `run-parts` d'Ubuntu, et
  `/etc/cron.d/<fichier>` est lu et **exécuté** (mesuré : deux ticks, deux
  exécutions).
- `CronEngine` : dédoublonnage à la minute, environnement complet
  (`SHELL`, `PATH`, `HOME`, `LOGNAME`, `USER`), trace syslog au format
  `CRON[pid]: (user) CMD (commande)`, et livraison de courriel selon
  `MAILTO` — y compris la convention `MAILTO=` vide qui coupe l'envoi.
- `at`, `atq`, `atrm` avec une file réelle et un identifiant de travail.
- `cron.service` piloté par `systemctl` (`status`, `restart`), visible dans
  `journalctl -u cron`.
- Les unités `.timer` se chargent depuis `/etc/systemd/system`, s'arment au
  `start`, apparaissent dans `systemctl list-timers` avec leur unité
  activée, et `systemctl status` les montre `active (waiting)`.

### 2.2 Défauts mesurés

**L1 — Le crontab utilisateur s'exécute deux fois par minute.**
Isolé et reproduit : un seul `cronTick` produit deux lignes `tick` dans le
fichier cible et deux entrées `CRON` dans syslog. `/etc/cron.d` ne présente
pas le défaut (un tick, une exécution), ce qui désigne la source du crontab
utilisateur comme énumérée deux fois. C'est le défaut le plus grave du lot :
une tâche de sauvegarde tourne en double.

**L2 — `OnCalendar` ne comprend que trois mots.**
`nextCalendarElapse` (`systemd/TimerScheduler.ts`) traite `minutely`,
`hourly`, `daily`, et rend `null` pour tout le reste. Or la forme normale
d'un timer systemd est justement une expression calendaire :
`OnCalendar=*-*-* *:*:00`, `Mon *-*-* 06:00:00`, `*-*-01 00:00:00`,
`weekly`, `monthly`, `03:00`. Toutes rendent `null` ⇒ `next = null` ⇒ la
colonne `NEXT` affiche `n/a` et **le timer ne part jamais**. Mesuré :

```
NEXT   LEFT   LAST   PASSED   UNIT         ACTIVATES
n/a    n/a    n/a    n/a      mien.timer   mien.service
```

Le timer est bien armé et bien affiché — il n'a simplement pas d'heure.

**L3 — Aucun `.timer` livré d'usine.**
`/usr/lib/systemd/system` contient 24 unités, dont zéro timer. Un Ubuntu
réel en expose six d'emblée (`logrotate`, `apt-daily`, `apt-daily-upgrade`,
`fstrim`, `man-db`, `systemd-tmpfiles-clean`). `systemctl list-timers` sur
une machine neuve annonce donc « 0 timers listed », ce qui donne
l'impression que la fonction n'existe pas.

**L4 — `crontab -` installe n'importe quoi.**
`echo "bidon" | crontab -` réussit sans un mot. `echo "99 * * * * /bin/true"`
aussi, et `crontab -l` le relit ensuite — alors que 99 n'est pas une minute
valable. Le vrai `crontab` refuse et **n'installe rien** :
`"bidon":0: bad minute` puis `errors in crontab file, can't install`.
Accepter en silence est pire que refuser : l'opérateur croit sa tâche posée.

**L5 — `@reboot` ne part pas au redémarrage du service.**
`fireReboot()` n'est appelé que depuis `CronEngine.start()`, et `cronTick`
n'appelle `start()` que si le moteur n'est pas déjà en marche. Un
`systemctl restart cron` ne fait jamais passer le moteur par `stop()`, donc
`@reboot` reste lettre morte. Mesuré : le fichier attendu n'existe pas.

**L6 — `systemctl enable --now X` lit `--now` comme un nom d'unité.**
`Failed to enable unit: Unit --now.service not found.` C'est la forme la
plus courante pour activer un timer.

**L7 — `crontab -e` ne fait rien** : sortie vide, aucun éditeur ouvert.
Le contenu doit passer par un tube, ce qui n'est pas la manipulation qu'on
enseigne.

**L8 — Le sujet du courriel cron est perdu.** `formatMail` compose un
`Subject: Cron <user@hôte> commande` en bonne et due forme, mais `mail`
affiche `"(no subject)"` : les en-têtes ne sont pas relus à la réception.

**L9 — Absents.** `batch`, `anacron`, `/etc/anacrontab`,
`systemd-analyze calendar`, `at -l` (alias d'`atq`), `/etc/at.allow`,
`/etc/at.deny`.

**L10 — Non mesuré, à vérifier avant de statuer.** `cron.allow`/`cron.deny`
n'existent pas d'usine et `CronPermissions.ts` fait 19 lignes. J'ai créé un
`cron.allow` contenant l'utilisateur courant et `crontab -l` a continué de
fonctionner — ce qui est le comportement correct, mais ne prouve rien : je
n'ai pas fait le cas négatif (un utilisateur absent de la liste). À mesurer
avant d'écrire quoi que ce soit à ce sujet.

> **Mesuré depuis, phase 4.** Le vrai `crontab` a pu être installé sur la
> machine de mesure. Cas négatif fait, dans les deux sens : un `cron.deny`
> nommant l'utilisateur le refuse, un `cron.allow` qui ne le nomme pas
> aussi, et `cron.allow` l'emporte quand les deux existent. **Root passe
> outre les deux** — vérifié avec un `cron.allow` sans `root` et un
> `cron.deny` avec `root`. `CronPermissions.ts` était donc juste ; seul le
> libellé du refus différait (le vrai n'a pas de point final).

*Note de relecture (phase 4).* L7, L8 et L9 sont livrés. L7 s'est révélé
plus grave que « ne fait rien » : dans le terminal, `crontab -e`
fonctionnait — et installait **sans valider**, ce qui contournait
entièrement le refus obtenu en phase 1.

---

## 3. Windows — état mesuré

### 3.1 Ce qui est réel

- `schtasks /query`, `/create`, `/run`, `/delete /f`, avec quatre tâches
  d'usine plausibles.
- Le calcul de la prochaine exécution pour `/sc daily`, `/sc hourly`,
  `/sc minute /mo N`, `/sc once` — vérifié contre la date simulée
  (`Get-Date` → 6/20/2026 ; `daily /st 02:00` → `06/20/2026 02:00:00`).
- `Get-ScheduledTask`, `Register-ScheduledTask`, `Unregister-ScheduledTask`,
  `New-ScheduledTaskAction`, `New-ScheduledTaskTrigger`.
- Le service `Schedule` existe et `fireDueScheduledTasks()` est bien gardé
  derrière son état `Running`.
- `Register-ScheduledTask` laisse une trace d'audit 4698.
- L'exécution, quand on la déclenche, est réelle : le programme est lancé,
  la tâche réarmée sur son intervalle, et un `powershell -File *.ps1` est
  interprété pour de bon.

### 3.2 Défauts mesurés

**W1 — Rien ne déclenche une tâche à l'heure dite.** Voir §1 : pas de
ticker. C'est le pendant du moteur cron autonome côté Linux, et il manque.

**W2 — `/change /disable` n'a aucun effet observable.** La commande répond
`SUCCESS`, puis `schtasks /query` et `Get-ScheduledTask` affichent tous deux
`Ready`. L'état demandé est accepté et perdu. Idem pour `/end`, qui répond
d'ailleurs le message de `/change` (« The scheduled task was
created/modified successfully ») au lieu du sien.

**W3 — `Get-ScheduledTask -TaskName` filtre en sous-chaîne.** Mesuré sur
la même machine, à la suite :

| Commande | Résultat |
|---|---|
| `-TaskName SimTestTask` | la seule tâche — correct |
| `-TaskName Absente` | rien — correct |
| `-TaskName T` (créée par `schtasks`) | **les cinq tâches** |

> **Correction.** Ce document a d'abord conclu à « deux magasins qui ne se
> voient qu'à moitié ». C'était faux, et la lecture du code au moment
> d'implémenter l'a montré : `WindowsScheduledTaskAdapter.store()` rend
> la carte `scheduledTasks` de l'appareil, exactement celle que `schtasks`
> écrit. Le magasin est bien unique.
>
> Le vrai défaut est plus simple : `listTasks` comparait avec `includes`.
> `-TaskName T` retenait donc toute tâche dont le nom **contient** un
> « t » — c'est-à-dire quatre des cinq. `SimTestTask` semblait filtrer
> correctement parce qu'aucun autre nom ne le contient. Un filtre en
> sous-chaîne, pas deux magasins.

**W4 — `/query /tn <inexistante>` rend un tableau vide** au lieu de
`ERROR: The system cannot find the file specified.` — message que
`/delete /tn <inexistante>` produit pourtant correctement.

**W5 — `/fo LIST`, `/v` et `/xml` sont ignorés** : toujours le même tableau
à trois colonnes. Le format verbeux est le principal usage de `schtasks`
en diagnostic.

**W6 — `/create` sans `/tr` réussit.** Le vrai refuse :
`ERROR: Required option /tr is missing.` Une tâche sans action est créée.

**W7 — Recréer une tâche existante écrase en silence.** Le vrai demande
confirmation, ou exige `/f`.

**W8 — `/sc weekly` et `/sc onstart` donnent `N/A`** en prochaine
exécution. Pour `weekly`, le vrai calcule une date.

**W9 — `New-ScheduledTaskTrigger -Daily -At 3am` rend un déclencheur faux**
sur les deux champs :

```
Once  At                 RepetitionIntervalMs  RepetitionDurationMs
True  3/1/2001 12:00 AM  0                     0
```

`-Daily` est enregistré comme `Once`, et `3am` n'est pas analysé.

**W10 — Cmdlets absentes** : `Get-ScheduledTaskInfo`,
`Start-ScheduledTask`, `Stop-ScheduledTask`, `Enable-ScheduledTask`,
`Disable-ScheduledTask`, `Set-ScheduledTask`, `Export-ScheduledTask`, et
toute la famille `*-ScheduledJob`.

**W11 — Aucun journal `Microsoft-Windows-TaskScheduler/Operational`.**
`Get-WinEvent` répond « No events were found ». C'est là que se lit
l'historique d'exécution d'une tâche sous Windows.

**W12 — Deux défauts d'enveloppe, hors périmètre mais rencontrés ici.**
`powershell -Command "(Get-ScheduledTask …).Actions"` n'est pas routé vers
PowerShell — `cmd` tente d'exécuter `(get-scheduledtask`. Et
`Get-ScheduledTask | Measure-Object` ignore le tube. Ils appartiennent à la
couche PowerShell, pas au planificateur ; notés pour ne pas les redécouvrir.

---

## 4. Objectifs

Par ordre de gravité mesurée, pas par facilité.

### Phase 1 — Ce qui répond faux — **livrée**

| # | Objectif | Critère de recette | État |
|---|---|---|---|
| P1.1 | Supprimer la double exécution du crontab utilisateur (L1) | un `cronTick` ⇒ une exécution, une ligne syslog | ✅ |
| P1.2 | Un ticker de tâches Windows (W1) | une tâche `/sc minute /mo 1` s'exécute sans appel à `advanceTime` | ✅ |
| P1.3 | `/change /disable` et `/end` changent l'état (W2) | `Status` passe à `Disabled` dans `schtasks` **et** dans `Get-ScheduledTask` ; `/end` rend son propre message | ✅ |
| P1.4 | `Get-ScheduledTask -TaskName` désigne un nom (W3) | un nom court ne ramasse plus toute la table ; `*` et `?` restent | ✅ |
| P1.5 | `crontab -` refuse une syntaxe invalide (L4) | `bidon` et `99 * * * *` rendent l'erreur du vrai et **n'installent rien** ; le crontab précédent survit | ✅ |

#### Comment chacun a été réglé

- **P1.1** — `LinuxCronManager` gardait une copie en mémoire pendant que
  `installCrontab` écrivait aussi `/var/spool/cron/crontabs`, et le moteur
  énumérait les deux. Le fichier fait désormais foi, seul, et `crontab -l`
  le lit lui aussi : un `vim` sur le spool se voit maintenant dans `-l`,
  là où il faisait tourner une ligne invisible.
- **P1.5** — la détection existait déjà en entier : `parseCrontab` relevait
  les lignes fautives depuis toujours, personne ne lisait ses `errors`.
  Il a fallu y ajouter le *nom* du champ (`CronSchedule.parseDetailed`)
  pour dire `bad minute` plutôt que « ligne invalide ».
- **P1.2** — `HostClock` n'avance que sur `advance()`. Un minuteur qui se
  serait contenté d'appeler `fireDueScheduledTasks` aurait relu
  éternellement la même heure : le tour fait donc avancer l'horloge de la
  machine d'une minute, et `simulatedDate()` reste la seule heure — celle
  qui déclenche et celle que `schtasks /query` affiche.
- **P1.3** — `/change` et `/end` partageaient un `return` en dur. Ils ont
  chacun leur traitement, `/disable` pose l'état, et `fireDueScheduledTasks`
  saute une tâche désactivée — tandis qu'un `/run` manuel reste possible,
  comme dans le vrai planificateur.
- **P1.4** — `includes` remplacé par une correspondance exacte insensible à
  la casse, `*` et `?` traduits en expression régulière.

**Réserve, la même que partout ailleurs dans ce document** : faute de
Windows et de `crontab` sur la machine de mesure, les libellés de
`/change`, `/end` et du refus de `crontab` suivent les formats documentés
(Microsoft, Vixie cron) sans avoir été relevés sur un binaire. Les
comportements, eux, sont vérifiés par sonde.

### Phase 2 — Ce qui ne part jamais — **livrée**

| # | Objectif | Critère de recette | État |
|---|---|---|---|
| P2.1 | `OnCalendar` calendaire réel (L2) | les formes calendaires donnent un `NEXT` daté et déclenchent | ✅ |
| P2.2 | Les six timers d'usine d'Ubuntu (L3) | `systemctl list-timers` en liste six sur une machine neuve | ✅ |
| P2.3 | `@reboot` au démarrage du service (L5) | `systemctl restart cron` exécute les lignes `@reboot` | ✅ |
| P2.4 | `systemctl enable --now` (L6) | active et démarre l'unité en une commande | ✅ |

#### Comment chacun a été réglé

- **P2.1** — un vrai analyseur de `systemd.time(7)`
  (`systemd/CalendarSpec.ts`) : raccourcis, jour de semaine seul, en
  liste ou en intervalle, listes et intervalles de dates et d'heures,
  pas `début/incrément`, heure seule, date seule. **Vérifié contre le
  vrai** : les vingt-neuf expressions du tableau de sondes ont été
  passées à `systemd-analyze calendar` avec la même base de temps et
  `--iterations=2`, et les deux sorties sont identiques — y compris les
  pièges (`weekly` vaut « lundi minuit » et non « dans sept jours »,
  `0/15` court jusqu'au bout du champ, une date fixe passée rend
  « never »).
- **P2.2** — les six unités sont **recopiées** des fichiers de
  `/lib/systemd/system` d'un vrai Ubuntu, pas inventées : d'où
  `*-*-* 6,18:00` pour apt, `Sun *-*-* 03:10:00` pour e2scrub, et un
  `systemd-tmpfiles-clean` qui n'a pas de calendrier mais un
  `OnBootSec=`/`OnUnitActiveSec=`. Elles servent donc aussi de banc
  d'essai à l'analyseur.
- **P2.3** — le cycle de vie du service pilote maintenant le moteur. Le
  point non évident : `restart()` démarre **puis** annonce le
  redémarrage, si bien qu'écouter `start` *et* `restart` faisait partir
  les lignes `@reboot` en double. Écouter `start` seul suffit.
- **P2.4** — les options se glissent avant le nom d'unité ; le nom est
  désormais le premier mot qui n'est pas une option, et `--now` enchaîne
  le `start`/`stop`.

#### Deux défauts trouvés en route, corrigés avec

- `systemctl list-timers` écrivait la colonne UNIT à largeur fixe :
  `systemd-tmpfiles-clean.timer` débordait sur ACTIVATES et les deux se
  lisaient collés. La largeur se cale sur le plus long nom présent.
- `systemctl list-timers <unité>` acceptait son argument puis l'ignorait
  et affichait toute la table.

#### Effet de bord mesuré

Les 14 échecs pré-existants de `systemd-socket-timer.test.ts` — signalés
comme tels lors de la phase 1 — **disparaissent** : ils tenaient tous à
l'absence d'échéance calendaire. Le quinzième cas, qui affirmait
« 1 timers listed », a été mis à jour avec sa raison : il datait d'une
machine sans aucun timer d'usine.

### Phase 3 — Ce qui manque aux vues — **livrée**

| # | Objectif | Critère de recette | État |
|---|---|---|---|
| P3.1 | `schtasks /query /fo LIST /v` (W5) | le format verbeux, avec ses champs réels | ✅ |
| P3.2 | `/query /tn <absente>` rend l'erreur (W4) | même message que `/delete` | ✅ |
| P3.3 | `/create` exige `/tr` ; refuse d'écraser sans `/f` (W6, W7) | messages du vrai | ✅ |
| P3.4 | `New-ScheduledTaskTrigger` honore `-Daily`/`-Weekly` et analyse `3am` (W9) | le déclencheur rendu correspond aux arguments | ✅ |
| P3.5 | `/sc weekly` calcule sa date (W8) | `Next Run Time` daté | ✅ |
| P3.6 | Le journal TaskScheduler/Operational (W11) | 106 (enregistrée), 200/201 (début/fin d'action), 102 (terminée) | ✅ |
| P3.7 | Les cmdlets manquantes (W10) | `Get-ScheduledTaskInfo`, `Start`/`Stop`/`Enable`/`Disable`/`Set` | ✅ |

#### Comment chacun a été réglé

- **P3.1** — `WinScheduledTask` porte désormais ce que la vue verbeuse
  imprime en plus des trois colonnes : `author`, `runAsUser`,
  `scheduleType`, `startTime`, `startDate`, `days`, `months`. Rien n'y
  est décoratif — chaque champ est ce que `/create` a reçu. Les champs
  que la machine ne sait pas produire (`Comment`, `Start In`,
  `Idle Time`, les quatre lignes `Repeat:`) gardent la valeur constante
  qu'un vrai Windows leur donne quand rien n'est configuré, relevée sur
  une trace réelle.
- **P3.2/P3.3** — trois refus qui n'existaient pas : un `/tn` inconnu
  répondait par une table vide, un `/create` sans `/tr` posait une tâche
  sans action, et un `/create` sur un nom déjà pris écrasait la tâche
  d'avant en silence.
- **P3.4** — `Once` était rendu vrai dès que `-Once` était absent : un
  `-Daily` explicite ressortait donc en déclencheur ponctuel. Et `-At`
  passait par `new Date('3am')`, qui rend une date invalide — le
  déclencheur portait une date de 2001. `parseTriggerAt` lit `3am`,
  `2:30pm`, `15:00` et un `[datetime]`, et bascule au lendemain si
  l'heure est passée, comme le vrai.
- **P3.5** — `weekly`, `monthly` et `onstart` étaient acceptés puis
  rangés sans date de départ : la tâche s'affichait `N/A` pour toujours.
  `weekly` tombe sur le jour nommé par `/d` (le jour de la création sans
  `/d`), `monthly` sur le quantième, `onstart` reste sans heure — c'est
  un événement, pas un calendrier.
- **P3.6** — le canal `Microsoft-Windows-TaskScheduler/Operational`
  n'existait pas. Les quatre identifiants du cycle de vie y sont émis :
  106 à l'enregistrement, 141 à la suppression, 200 au lancement de
  l'action, 201 à sa fin avec son code de retour, 102 à la fin de la
  tâche.
- **P3.7** — cinq cmdlets ajoutées par-dessus le magasin déjà partagé.
  `Set-ScheduledTask` et `Enable`/`Disable` passent par un
  `updateTask` unique, `Start` par le même chemin que `schtasks /run`,
  de sorte qu'une tâche désactivée démarre quand même à la main.

#### Un défaut trouvé en route, hors planificateur

La composition que Microsoft documente —
`$a = New-ScheduledTaskAction …; Register-ScheduledTask -Action $a` —
ne marchait pas, et le planificateur n'y était pour rien. Le raccourci
cmd de PowerShell (`PowerShellCmdShim`) découpe la ligne sur `;` et
traite lui-même les affectations, dans une table qui ne sait retenir que
du **texte** : l'objet y perdait sa nature, et la phrase suivante, elle,
partait au vrai moteur — qui n'avait jamais vu la variable. Le
`-Action` arrivait donc à `null`, silencieusement.

Deux corrections, du même côté : une affectation dont la droite est un
cmdlet part maintenant **entière** au vrai moteur, qui garde l'objet et
la relit sur les phrases suivantes ; et, dans l'autre sens, les
variables de texte que le raccourci détient sont réinjectées dans le
code confié au moteur — `$h = hostname; Write-Output $h` rendait une
ligne vide. Un nom que le moteur possède déjà n'est jamais écrasé par la
copie du raccourci.

Corrigé avec : une tâche posée par `Register-ScheduledTask` se relisait
par `schtasks /query /v` avec `Author`, `Run As User` et
`Schedule Type` à `N/A`. L'identité qui enregistre est celle de la
session — le cmdlet ne la connaît pas, la machine si — et le type
d'horaire se déduit du déclencheur reçu.

#### Ce qui n'a pas été fait, et pourquoi

- **L'analyseur d'arguments PowerShell coupe un mot nu sur `/`, `:`, `*`
  et `%`** (`PSLexer.isWordStopChar`). `-Execute C:\x.exe` et
  `-LogName Microsoft-Windows-X/Operational` demandent donc des
  guillemets ici, là où le vrai accepte les deux formes. C'est un défaut
  commun à tous les arguments — le canal
  `Microsoft-Windows-PowerShell/Operational`, antérieur à ce lot, a le
  même — et non du planificateur ; les sondes l'écrivent au cas
  concerné plutôt que de le contourner en silence.
- **Le nombre d'exécutions manquées** (`NumberOfMissedRuns`) est rendu à
  zéro : rien ne compte les tours où la machine était éteinte, et
  inventer un chiffre serait pire que d'en donner un honnête.

### Phase 4 — Le reste — **livrée**

| # | Objectif | Critère de recette | État |
|---|---|---|---|
| P4.1 | `crontab -e` (L7) | ouvre l'éditeur, valide au retour, refuse sans installer | ✅ |
| P4.2 | Le sujet du courriel cron (L8) | `mail` affiche le `Subject:` que cron a composé | ✅ |
| P4.3 | `cron.allow`/`cron.deny` (L10) | le cas négatif mesuré, puis appliqué | ✅ |
| P4.4 | `at -l`, `at.allow`, `at.deny` (L9) | alias d'`atq` ; les deux fichiers de permission | ✅ |
| P4.5 | `batch` (L9) | file `b`, départ au prochain tour | ✅ |
| P4.6 | `anacron` et `/etc/anacrontab` (L9) | périodes, horodatages, rattrapage | ✅ |
| P4.7 | `systemd-analyze calendar` (L9) | la porte manquante sur l'analyseur de la phase 2 | ✅ |
| P4.8 | L'analyseur PowerShell (réserve de la phase 3) | un mot nu garde `/` et `%` | ✅ |
| P4.9 | `NumberOfMissedRuns` (réserve de la phase 3) | compté pour de vrai | ✅ |

#### La vérité terrain a changé de nature

Les phases précédentes ont dû se passer du vrai `crontab`, absent de la
machine de mesure — le PRD le disait en toutes lettres. Cette fois les
paquets ont pu être installés (`apt-get install at anacron cron`), et
**tout ce qui est affirmé ici a été confronté au binaire réel**, y
compris le cas négatif de `cron.allow`/`cron.deny` que le PRD signalait
comme jamais mesuré (L10). Les relevés sont recopiés en tête de
`probe-planif-03-phase4.test.ts`.

Deux constats du relevé contredisent ce qu'on suppose spontanément, et
c'est précisément pour cela qu'ils valaient d'être mesurés :

- **root passe outre** `cron.allow`, `cron.deny` et `at.allow`. Un
  `cron.allow` qui ne contient pas `root`, et un `cron.deny` qui
  contient `root`, laissent l'un comme l'autre root travailler. Le
  raccourci `if (user === 'root') return true` de `CronPermissions.ts`,
  qui pouvait passer pour une facilité, est donc exact.
- **`at` met la tâche au spool même quand `atd` est arrêté.** Il ne sait
  pas prévenir le démon, le dit (`Can't open /run/atd.pid…`), et
  s'arrête là. Le simulateur, lui, *refusait* — la tâche disparaissait
  sans que rien ne l'annonce.

#### Comment chacun a été réglé

- **P4.1** — `crontab -e` existait déjà dans le terminal, et c'est ce
  qui rendait le défaut sérieux : il installait **sans valider**. Toute
  la peine prise en phase 1 pour que `crontab -` refuse une ligne
  fautive se contournait donc en ouvrant l'éditeur. `crontab -` et
  `crontab -e` partagent maintenant une seule fonction de refus
  (`validateCrontabContent`), parce que deux copies avaient déjà
  divergé une fois. Le refus reprend le dialogue du vrai — l'erreur
  ligne à ligne, puis `Do you want to retry the same edit? (y/n)`, et
  `crontab: edits left in <fichier>` sur un `n` — sur le modèle de la
  reprise de `visudo`, déjà là. Ajouté au passage : l'éditeur suit
  `$VISUAL`/`$EDITOR` au lieu d'ouvrir `nano` d'office, et
  `no crontab for <user> - using an empty one` annonce un crontab
  absent. Hors terminal (un tube, un script) il n'y a pas d'éditeur à
  ouvrir, et le vrai ne se tait pas pour autant : il dit que l'éditeur
  a échoué, en le nommant — c'est ce que rend désormais ce chemin, au
  lieu d'une sortie vide qui laissait croire que la commande avait
  marché.
- **P4.2** — le sujet était bien composé, et perdu à la lecture :
  **deux conventions de fin de ligne dans un même tuyau**. SMTP écrit en
  CRLF, c'est la convention du fil ; une boîte mbox posée sur le disque
  d'une machine Unix est en LF, et c'est ce que cron y dépose. Le
  lecteur ne découpait que sur CRLF, si bien que le message entier ne
  faisait qu'une seule ligne — aucune ligne vide, donc aucun en-tête,
  donc `(no subject)`. `splitHeadersAndBody` et `parseMailbox` acceptent
  les deux et rendent le corps dans la convention reçue. Corrigé avec :
  la ligne `From ` de l'enveloppe portait un `Date.toString()` de
  JavaScript au lieu du `ctime(3)` d'Unix.
- **P4.3** — `cronAllowed` était déjà juste ; ce qui manquait était la
  mesure et une virgule. Le refus du vrai s'écrit sans point final
  (`See crontab(1) for more information`), et le simulateur en mettait
  un. Le message vit maintenant dans `cronDenialMessage`, à côté de la
  règle qu'il énonce.
- **P4.4/P4.5** — `at -l` était pris pour une mise au spool sans
  commande (`at: no command to schedule`) au lieu de l'alias d'`atq`
  qu'il est ; `batch` n'existait pas ; les permissions `at` non plus. La
  date était au format `Mon Aug 03` là où `ctime` cadre le quantième à
  l'espace (`Mon Aug  3`) — un seul formateur, partagé avec l'enveloppe
  mbox, remplace les deux versions divergentes. Une heure illisible
  répond `Garbled time` et ne met rien au spool, au lieu d'être ramenée
  silencieusement à maintenant. `/etc/at.deny` est livré d'usine avec
  ses comptes de service, comme le fait le paquet `at` — contrairement
  à cron, dont aucun fichier de permission n'existe sur un Ubuntu neuf ;
  la différence est réelle et se voit à l'`ls`.
- **Et la porte qui manquait** : une tâche `at` n'était exécutée que si
  quelqu'un appelait `advanceTime()`. Le tour de minute autonome de la
  machine — celui qui fait tourner cron depuis la phase 1 — ne
  l'interrogeait pas. La tâche part maintenant pour de bon, **sous son
  propriétaire** et non sous l'utilisateur devant le clavier, et sa
  sortie part au courrier puisque personne n'est là pour la lire. Une
  seule vidange du spool sert les deux appelants : en ajouter une
  seconde aurait fait partir chaque tâche deux fois.
- **P4.6** — `anacron` est ce que cron ne sait pas faire : rattraper ce
  qui est tombé pendant que la machine était éteinte. Il raisonne en
  jours écoulés, retient le dernier passage dans
  `/var/spool/anacron/<identifiant>`, et `/etc/anacrontab` est recopié
  du fichier d'usine d'Ubuntu — c'est lui que les trois lignes
  `test -x /usr/sbin/anacron` du `/etc/crontab` déjà présent laissent la
  main.
- **P4.7** — l'analyseur calendaire existait depuis la phase 2 et avait
  été vérifié expression par expression contre le vrai. Ce qui manquait
  n'était pas le calcul mais la porte : aucune commande ne le donnait à
  l'opérateur. Le format de sortie est repris au caractère
  d'indentation près, avec ses trois pièges — « Original form »
  n'apparaît que si l'entrée diffère de la forme normalisée, une date
  fixe passée donne `never` sans ligne « From now » derrière, et une
  base postérieure dit `ago` et non `left`.
- **P4.8** — la réserve de la phase 3 **visait la mauvaise cause**.
  Mesure faite, `:` n'a jamais fait partie des caractères d'arrêt du
  lexeur : `C:\x.exe` passait déjà, et ce que la phase 3 avait pris pour
  un défaut d'analyse venait du raccourci cmd, corrigé au même moment.
  Ce qui casse réellement, c'est `/` et `%`, et le défaut est au
  parseur, pas au lexeur : les branches qui recollent un argument
  *commençant* par `/` ou `%` existaient, mais un mot qui en contient un
  plus loin ressortait coupé en deux, et l'appelant ne recevait que la
  moitié gauche. Pire encore, `/` n'ouvrait pas une valeur de paramètre :
  `-Argument /silent` rendait `Argument: True`, la valeur perdue sans un
  mot.
- **P4.9** — une occurrence dont l'heure passe pendant que le
  planificateur est arrêté est **manquée**, et c'est exactement ce que
  compte ce champ. Les occurrences sont comptées puis l'échéance
  réarmée en avant, plutôt que laissées dans le passé : sans cela la
  reprise du service les rejouerait toutes d'un coup, ce qu'un vrai
  Windows ne fait pas — la case « exécuter dès que possible après un
  démarrage manqué » est décochée par défaut, et une occurrence ratée
  est perdue, pas différée. Une tâche désactivée ne compte rien : elle
  n'a pas d'horaire en vigueur, il n'y a donc rien à manquer.

#### Un test corrigé, avec sa raison

`cron-editor-ui.test.ts` (CU-03) affirmait que sortir de l'éditeur sans
enregistrer imprime « no changes made to crontab » — un libellé qui
n'existe nulle part. Le vrai dit « No modification made ». La prémisse
était fausse, elle est corrigée en place avec le relevé.

#### Ce qui n'a pas été fait, et pourquoi

- **Le délai d'anacron** (deuxième colonne de `/etc/anacrontab`) est lu
  et rendu, mais ne diffère rien : le tour de la machine est à la
  minute, et un décalage de quelques minutes au démarrage n'aurait
  aucune conséquence observable.
- **`anacron` ne poste pas la sortie de ses tâches**, là où le vrai
  écrit `Job 'X' terminated (mailing output)` puis la met au courrier.
  La mention entre parenthèses serait une promesse non tenue ; la ligne
  s'arrête donc à `terminated`.
- **La forme normalisée de `systemd-analyze calendar` conserve les
  champs tels qu'écrits.** Reproduire la canonisation que systemd fait
  des intervalles et des pas demanderait de deviner sa forme de sortie,
  et une forme inventée serait pire qu'une forme conservée. Ce qui est
  normalisé — développer un raccourci, compléter une partie absente —
  l'est parce que le relevé le montre.
- **`at -c`** rend la commande seule, là où le vrai imprime le script
  complet avec son `cd` et son environnement recopiés à la mise au
  spool. Cet environnement n'est pas capturé.

---

## 5. Ce qui est délibérément hors périmètre

- **`*-ScheduledJob`** (le module `PSScheduledJob`) : c'est un
  planificateur distinct, adossé au moteur de `Job` de PowerShell, pas au
  Task Scheduler. Le simuler demanderait le modèle de `Job` complet.
- **Les déclencheurs événementiels** — `/sc onevent`, ouverture de session,
  verrouillage du poste, inactivité. Rien dans le simulateur ne produit ces
  événements ; un déclencheur sans source serait décoratif.
- **Les dossiers de tâches** (`\Microsoft\Windows\…`) au-delà de la chaîne
  d'affichage : `TaskPath` est déjà rendu, mais la création dans un
  sous-dossier n'est pas au programme.
- **`Register-ScheduledTask -Xml` et `Export-ScheduledTask`** produisent et
  consomment le XML de définition. Écrire un XML plausible sans qu'il soit
  relisable serait exactement le genre de demi-vérité que ce dépôt évite.
  À faire ensemble, ou pas du tout.
- **La conservation à travers une sauvegarde de topologie** : le
  sérialiseur ne capture ni les crontabs ni les tâches Windows. C'est un
  cas de la famille déjà documentée dans `topologySerializer.ts`, à traiter
  avec elle plutôt qu'ici.

---

## 6. Sondes prévues

Écrites, pour la phase 1 :

- `probe-cron-01-une-seule-fois.test.ts` — une exécution par minute et une
  seule ligne syslog, `/etc/cron.d` compté pour un, le spool comme seule
  vérité, les cinq champs nommés au refus, le crontab précédent qui
  survit, et ce qui reste valable (macros, pas, listes, `MAILTO`).
- `probe-schtasks-01-etat-et-horloge.test.ts` — `/disable` observable des
  deux côtés, `/enable`, le message propre de `/end`, le filtre exact et
  ses jokers, une tâche qui part sans `advanceTime`, une tâche désactivée
  qui ne part pas, et un planificateur arrêté qui ne déclenche rien.

Écrites, pour la phase 2 :

- `probe-timer-01-oncalendar.test.ts` — les six formes calendaires, `NEXT`
  daté, déclenchement effectif, les timers d'usine.

Écrites, pour la phase 3 :

- `probe-schtasks-02-vues-et-journal.test.ts` — `/query` d'une absente,
  `/create` sans `/tr`, l'écrasement, `/fo LIST`, `/fo CSV`, `/fo LIST /v`,
  `weekly`/`monthly`/`onstart` datés, les quatre identifiants du journal
  Operational, les cinq cmdlets, et la composition par variables.

Écrites, pour la phase 4 :

- `probe-planif-03-phase4.test.ts` — les dix scénarios de la phase, du
  dialogue de `crontab -e` jusqu'au comptage des exécutions manquées.
  Son en-tête recopie les relevés faits sur les vrais binaires, cas
  négatifs compris.

Une correction de sonde, notée ici parce qu'elle ressemble à un échec et
n'en est pas : `probe-cron-01` pilotait l'horloge à la main pendant que le
minuteur autonome de cron — un vrai `setInterval` de 60 s — tournait
toujours. Sous une suite assez lente pour franchir une minute réelle, ce
minuteur tombait en plus et la sonde comptait deux exécutions ; elle
mesurait la charge de la machine, pas cron. Le minuteur est désormais
coupé dans le banc, et l'horloge du test fait seule foi.

Chacune suit la règle de ce dépôt : les sorties attendues sont relevées sur
le vrai binaire quand il est disponible sur la machine de mesure, et le
document dit lesquelles ne l'ont pas été.

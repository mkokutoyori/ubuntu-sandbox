# PRD — Le tutoriel « Debugging et Logging sur Cisco », rejouable

Plateforme de référence : **Cisco ISR 2911, IOS 15.7(3)M** et
**Catalyst 2960**, comme `docs/PRD-CLI-Fidelite-IOS.md`.

Un tutoriel qu'on ne peut pas suivre jusqu'au bout est pire qu'absent :
le lecteur croit avoir mal tapé. `src/__tests__/unit/network-v2/
tuto-debugging-logging-cisco.test.ts` rejoue chaque manipulation, partie
par partie, et c'est lui qui tient la promesse.

## Méthode

Une sonde a d'abord tapé le tutoriel intégralement sur un vrai
`CiscoRouter` et un vrai `CiscoSwitch`, en enregistrant la réponse à
chaque ligne. Six anomalies sont sorties de ce relevé ; **deux étaient
des erreurs de la sonde**, et le dire vaut mieux que de les corriger
pour rien :

- **`logging trap`/`facility`/`monitor` absents de la configuration.**
  Faux : la sonde les avait réglés à leur valeur PAR DÉFAUT, et IOS ne
  rend que ce qui s'en écarte. Vérifié en les réglant ailleurs — les
  trois apparaissent alors.
- **Un câble débranché ne produirait aucun log.** Faux : la sonde
  construisait le câble avec la mauvaise API (`new Cable(a, b)` au lieu
  de `new Cable(id).connect(a, b)`), donc aucun lien n'était jamais
  établi. Avec la bonne, les `%LINK-3-UPDOWN` sont là.

Un troisième point relevé n'est pas un défaut non plus :
`show processes cpu | include Debug` ne rend rien, mais un vrai IOS n'a
pas de processus nommé « Debug » — l'absence de résultat EST la réponse.

## Les quatre manques réels, et ce qu'ils cachaient

### 1. `show logging last <n>` n'existait pas

`% Invalid input`. C'est pourtant la première commande qu'on tape sur un
tampon de 64 Ko : `show logging` nu recrache tout et ce qu'on cherche est
en bas. `LoggingConfig.render()` prend désormais un `{ last }` qui ne
tronque QUE la liste des messages — l'en-tête reste, comme sur IOS.

### 2. `no debug condition <n>` était refusé

On posait une condition qu'IOS annonce par son numéro (`Condition 1
set`), et aucune commande ne pouvait la retirer par ce numéro : seul
`no debug condition all` existait.

Le défaut derrière était plus large : **le numéro était l'indice du
tableau**, pas un identifiant. Retirer la première de trois conditions
renumérotait les autres, si bien que `show debug condition` désignait
sous le numéro 1 ce que l'opérateur avait vu sous le 2. Les conditions
portent maintenant un identifiant attribué à la création, et le plus
petit libre est réutilisé — comme les emplacements d'IOS.

### 3. `debug ip dhcp server packets` était refusé

Le mot-clé était enregistré au SINGULIER. Or la référence Cisco donne
`debug ip dhcp server {events | packets | linkage}` : le pluriel est la
forme réelle. Enregistrer le singulier inversait la règle d'abréviation
d'IOS — la forme complète refusée, l'abrégée acceptée. En enregistrant
`packets`, les deux fonctionnent, `packet` devenant une abréviation non
ambiguë comme n'importe quelle autre. `linkage`, le troisième mot-clé,
n'existait pas non plus.

### 4. EEM ne se déclenchait jamais — trois défauts empilés

C'est la partie 8 entière qui ne marchait pas, et il a fallu retirer
trois couches pour arriver au bout :

**(a) Le motif était comparé au seul corps du message.** L'événement
`device.syslog.entry` porte `tag`, `severityNum`, `mnemonic` et
`message` séparément, et `EemEngine` ne regardait que le dernier. Or un
déclencheur EEM s'écrit sur le mnémonique — `"SYS-5-CONFIG_I"`,
`"UPDOWN.*FastEthernet0/0.*down"` — et ces chaînes n'existent que dans
le préfixe. La façon normale d'écrire un déclencheur ne déclenchait donc
jamais rien.

Corrigé par une reconstruction PARTAGÉE (`syslogFullLine` dans
`network/syslog/types.ts`) plutôt qu'une troisième copie : l'agent
syslog avait déjà la sienne, et son propre commentaire raconte qu'il a
un jour porté deux formes selon le bus emprunté.

**(b) `action <id> syslog priority <niveau> msg "<texte>"` n'était pas
analysée.** Seule la forme sans `priority` l'était ; celle du tutoriel
tombait dans le `return ''` final et l'action n'était **pas
enregistrée**. L'applet se déclenchait donc avec zéro action. Le champ
`severity` existait déjà sur `EemAction` et personne ne le remplissait.

Trouvé en même temps : **toute forme d'action inconnue était avalée en
silence**. La ligne répondait comme si de rien n'était, l'applet restait
sans action, et rien ne le disait avant le jour où il aurait dû agir.
Elle est refusée désormais.

**(c) L'action `syslog` n'écrivait pas dans le journal.** Elle publiait
sur le bus sans jamais toucher le tampon : `show logging` ne montrait
rien. Or on écrit un log pour le relire — c'est tout l'intérêt de
l'action, et le tutoriel enchaîne justement l'applet et un
`show logging | include`. L'hôte EEM a maintenant un port `logSyslog`,
que `Router` remplit en écrivant dans son propre journal (lequel
republie sur le bus, donc on a les deux au lieu d'un). La forme est
celle d'IOS : `%HA_EM-<sev>-LOG: <applet>: <message>`.

**Les variables intégrées** sont substituées au moment d'agir
(`$_event_pub_time`, `$_event_type_string`, `$_syslog_msg`). Une
variable inconnue reste LITTÉRALE, et c'est le comportement du vrai EEM
plutôt qu'une limite : `$_cli_username` n'est défini que derrière un
`event cli`, donc il reste tel quel derrière un `event syslog` sur une
vraie machine aussi. Inventer une valeur ferait passer pour résolu ce
qui ne l'est pas.

## Ce que le tutoriel demande et qui marchait déjà

Relevé pour ne pas laisser croire que tout était cassé : les huit
niveaux de sévérité et leur filtrage réel (un tampon `warnings` garde le
`%LINK-3` et jette le `%LINEPROTO-5`), `service timestamps ... msec`,
`logging synchronous` sur console et vty, `terminal monitor`, les treize
commandes `debug` de la partie 5, le filtrage effectif du debug
conditionnel, `show logging | include|exclude|count|begin`,
`clear logging`, les vues OSPF des scénarios 2 et 3, le caractère
circulaire du tampon — et les débug écrivent de vraies lignes issues du
vrai trafic, ce que le test vérifie par un ping réel plutôt que de le
supposer.

## Discrimination

`tuto-debugging-logging-cisco.test.ts` compte 42 cas. Au `git stash`,
**11 échouent** avant les correctifs ; les 31 autres sont ce qui marchait
déjà et doit continuer.

## Hors périmètre

- **`show processes cpu | include Debug`** : voir plus haut, ce n'est pas
  un défaut.
- **Le serveur syslog externe reçoit-il vraiment ?** Le tutoriel
  configure `logging host` et vérifie la ligne dans `show logging` ; il
  ne fait pas transiter de message jusqu'à un collecteur. Le test s'en
  tient là.
- **`debug ip dhcp server linkage`** est accepté et n'écrit rien de
  plus : ce simulateur n'a pas de notion de liaison parent-enfant entre
  pools DHCP. Dit dans le code plutôt que laissé à découvrir.

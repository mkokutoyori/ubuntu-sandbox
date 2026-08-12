# PRD — Sécurité des équipements Cisco : trois portes qui ne fermaient pas

## 0. Contexte et portée

Un simulateur qui sert à enseigner la sécurité doit refuser ce qu'une
vraie machine refuse. S'il accorde le niveau 15 sans mot de passe, il
n'apprend pas seulement une fausse commande : il apprend que le verrou
posé au chapitre précédent ne sert à rien, et l'apprenant emporte cette
conclusion sur du matériel réel.

Ce document couvre les mécanismes d'autorisation d'IOS tels que ce dépôt
les implémente :

- `enable` / `enable <niveau>` et les coffres `enable secret` /
  `enable password [level N]` ;
- la porte de connexion des lignes (`login`, `login local`) ;
- les vues d'analyseur (`parser view`, `enable view`) ;
- la délégation par niveau (`privilege exec level N <commande>`) ;
- le stockage des secrets et l'ouverture des ports d'administration.

### 0.1 Le signalement

> « sur les équipements cisco on peut faire une élévation de privilège à
> l'aide d'un disable, enable, puis on saisit le mot de passe de
> enable secret/password, et on obtient le privilege level 15 »

Mesuré avant toute modification, le geste décrit **sur le terminal
graphique est correct** : `enable` ouvre l'invite `Password:`, le bon
secret élève au niveau 15, le mot de passe d'un COMPTE est refusé, un
`enable password` est ignoré tant qu'un `enable secret` existe. C'est
d'ailleurs la règle d'IOS : qui connaît le secret d'activation obtient le
niveau qu'il ouvre, quel que soit le niveau de son propre compte.

La mesure a en revanche trouvé la même commande **ouverte en grand par
tout autre chemin**, et deux autres portes du même genre. Les trois sont
décrites ci-dessous, chacune avec la mesure qui l'établit.

## 1. Les trois vulnérabilités

### 1.1 `enable` élevait au niveau 15 sans mot de passe hors du terminal

Sur un routeur fermé par `enable secret Cisco123` :

```
show privilege  → Current privilege level is 1
enable 15       → ""                                  ← accepté, en silence
show privilege  → Current privilege level is 15
show running-config → Building configuration...       ← toute la configuration
```

`enable` nu donnait le même résultat. La cause est structurelle : la
vérification du mot de passe vivait **uniquement dans le plan de
dialogue**, que seul un terminal interactif rend. Le gestionnaire de la
commande, lui, élevait sans rien vérifier, et son commentaire assumait la
chose :

> « Direct, non-interactive callers (device.executeCommand('enable') in
> tests) go straight here too, which is correct: nothing could have
> prompted them. »

« Rien n'aurait pu me demander » n'est pas une raison d'accorder. Les
chemins concernés ne sont pas théoriques : une commande portée par
`ssh hôte "enable"`, un script, la relecture d'une configuration à
l'import d'une topologie, et toute session dont l'hôte ne rend pas les
dialogues.

**Correctif.** `enableGateFor(niveau)` devient la seule lecture de la
porte — coffre s'il existe, sinon mot de passe, avec le repli du niveau
15 pour un palier qui n'a pas le sien — et elle est lue par le plan de
dialogue ET par le gestionnaire. Le plan, après avoir vérifié le mot de
passe, autorise CE palier une seule fois (`authorizeEnable` /
`consumeEnableAuthorization`). Un appelant qui n'a pas pu demander
n'obtient rien : `% Access denied`.

**Ce que le correctif ne casse pas, et c'est délibéré** : sans aucun
coffre configuré, la console élève toujours — c'est le comportement
d'IOS sur une machine sans mot de passe d'activation, et le cas témoin
du fichier de tests l'épingle.

**Le chemin non interactif garde une porte d'entrée légitime** :
`executeCommand('enable 7', { passwordInput: 'Tech7' })` joue le vrai
dialogue sans terminal (`HeadlessAnswers`, mécanisme préexistant). Le
mot de passe est vérifié, un mauvais mot de passe donne les trois refus
puis `% Bad secrets`. `executeCommandInVty` accepte désormais le même
argument, que le chemin vty n'avait pas.

### 1.2 Trois connexions ratées donnaient un shell

Sur une console fermée par `login local` :

```
mode initial        = interactive-text          ← l'invite est bien là
3 × (bob / faux)    → % Login invalid ×3, % Bad passwords
mode après          = normal                    ← une invite de commande
authenticatedUsername = null                    ← personne ne s'est authentifié
show version        → la machine répond
```

Le flux de connexion s'achève **normalement** après son troisième refus :
il écrit `% Bad passwords` puis demande la fermeture de la fenêtre. Un
flux ANNULÉ (Ctrl+C) rouvrait déjà la porte — c'est un correctif
antérieur — mais un flux qui va au bout en échouant la laissait tomber.
Si rien ne ferme la fenêtre, le mode redevient `normal`, c'est-à-dire un
shell que personne n'a ouvert.

**Correctif.** Une porte qui s'achève sans authentifier se rouvre.
`lastFlowWasAuthGate` porte l'information jusqu'à `onFlowComplete`, et
`CiscoTerminalSession` y relance l'invite quand la porte n'a pas été
franchie. `authGatePassed` est distinct d'`authenticatedUsername` :
un `login` par mot de passe de ligne n'identifie personne mais ouvre bel
et bien, et confondre les deux aurait fait boucler l'invite sur une
connexion réussie.

### 1.3 Une vue restreinte pouvait redémarrer la machine

Une vue déclarée `commands exec include show version` — donc autorisant
une seule commande :

```
show running-config → % Invalid input detected     ← correct
configure terminal  → % Invalid input detected     ← correct
reload              → ""                           ← ACCEPTÉ
show ip route       → Please answer yes or no.     ← la confirmation de reload attend
```

Le plan de dialogue était construit **avant** tout contrôle
d'autorisation, et le contrôle vit dans `executeOnTrie`. Toute commande à
confirmation échappait donc au filtre : `reload`, `write erase`,
`erase startup-config`, `copy`, `debug all`. Une vue en lecture seule —
le mécanisme même par lequel on donne un accès restreint à un tiers —
pouvait redémarrer l'équipement et effacer sa configuration de
démarrage.

**Correctif.** `interactionPlanFor` commence par la question que le reste
du shell pose déjà : `laSessionVoit(commande)`. Une commande que la
session ne voit pas n'a pas de dialogue ; elle repart par le chemin
ordinaire, qui la refuse comme les autres. Le filtre par NIVEAU était,
lui, déjà correct : `reload` au niveau 1 était bien refusé.

## 2. Ce que la mesure a trouvé JUSTE

Écrit ici parce qu'un audit qui ne liste que les défauts ne dit pas ce
qui est protégé, et parce que chacun de ces points est désormais gardé
par un test qui essaie de le casser :

| Attaque | Résultat |
|---|---|
| Mot de passe du COMPTE saisi à l'invite `enable` | refusé |
| `enable password` utilisé alors qu'un `enable secret` existe | refusé |
| Force brute à l'invite `enable` | 3 essais, `% Bad secrets`, retour au niveau 1 |
| Ctrl+C à l'invite de connexion | l'invite revient |
| Commandes privilégiées depuis le niveau 1 | `% Invalid input` (config, running-config, startup-config, copy, write erase, reload, debug) |
| Palier délégué : atteindre les commandes voisines | refusé — seul ce qui est nommé répond |
| Secrets lus dans la configuration | condensés (`enable secret 5 $1$…`), jamais en clair |
| Mot de passe de ligne sous `service password-encryption` | rendu en type 7 |
| Condensé collé à la main utilisé comme mot de passe | refusé |
| Compte supprimé | ne s'authentifie plus |
| `transport input none` | ni 22 ni 23 en écoute |
| `transport input ssh` | 22 seulement, et rien sans clé d'hôte |

## 3. Vérification

`src/__tests__/unit/network-v2/attaques-securite-cisco.test.ts` — 24 cas,
chacun une tentative de compromission qui doit échouer, plus six
**témoins** qui doivent réussir. Sans les témoins, un laboratoire mal
monté et une défense qui tient seraient indiscernables : c'est la
première chose que ce lot a apprise, deux sondes ayant conclu à un défaut
alors qu'elles avaient simplement omis `enable`.

Discrimination par restauration des trois fichiers de production :
**6 cas sur 24 tombent avant correctif**, et ce sont exactement les trois
vulnérabilités — quatre pour l'élévation sans mot de passe, un pour le
shell après trois échecs, un pour la vue contournée. Les dix-huit autres
passent des deux côtés : ce sont les défenses qui tenaient déjà et les
témoins.

## 4. Suites existantes corrigées, et pourquoi pas autrement

Vingt-six cas répartis sur quatre fichiers montaient d'un palier par
`enable <niveau>` **sans jamais présenter le mot de passe**, sur des
machines qui en avaient pourtant un. Ils encodaient donc la
vulnérabilité comme prémisse.

La première correction envisagée — retirer les `enable secret` de ces
laboratoires — a été **écartée après objection de l'utilisateur, et il
avait raison** : supprimer la configuration de sécurité d'un
laboratoire pour faire passer un test revient à mesurer une machine
moins fermée que celle qu'on prétend décrire, et le test cesse de
protéger ce pour quoi il existe. Les secrets sont restés en place ; les
laboratoires présentent maintenant le mot de passe par
`{ passwordInput }`. Le mécanisme existait déjà et n'a pas eu besoin
d'être inventé — la seule extension est que `executeCommandInVty` le
transmet, ce qu'il ne faisait pas.

## 5. Limites assumées

- **Aucun verrouillage de compte après N échecs d'`enable`.** IOS a
  `login block-for` pour les lignes réseau (déjà implémenté ailleurs dans
  ce dépôt) mais rien sur `enable` ; les trois essais par invocation sont
  la seule limite, et c'est celle du matériel.
- **`aaa authentication enable default` n'est pas consulté par la
  porte** : le coffre local décide seul. La commande est acceptée, rendue
  dans la configuration, et un serveur TACACS+ ne participe pas encore à
  cette décision-là.
- **La vue ne filtre que ce que la session VOIT.** Une commande incluse
  dans une vue s'exécute avec les droits du niveau atteint ; il n'y a pas
  de second contrôle par argument (`show run | include …` reste ce que la
  vue autorise ou non en bloc).
- **Ce lot ne couvre que Cisco.** Huawei VRP a les mêmes familles
  (`super password`, `authentication-mode`, `user privilege level`) et
  n'a pas été mesuré ici : c'est le prochain lot, et rien de ce document
  ne doit être supposé vrai pour VRP.

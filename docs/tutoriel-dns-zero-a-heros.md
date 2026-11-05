# DNS de Zéro à Héros : de `www.banquehorizon.com` à une infrastructure de noms que tu sais construire, lire, casser et réparer

> **À qui s'adresse ce tutoriel ?**
> À toute personne qui veut comprendre et faire fonctionner un service de noms (DNS) : étudiant, technicien, administrateur, auditeur. **Tu n'as besoin de rien savoir.** Pas même ce qu'est un terminal : la Partie 0 te l'apprend en dix minutes. Tout mot technique est expliqué la première fois qu'il apparaît, et un glossaire en fin de document les rassemble.

> **Comment ce tutoriel est construit**
> On avance par **très petits pas**. Chaque pas est une seule chose : une idée, ou une commande à taper. Après chaque commande, tu vois ce que tu dois obtenir, puis on la **relit ensemble ligne par ligne**. Tu n'as jamais à deviner.
>
> Tout se passe dans un **laboratoire** que tu fais tourner dans ton navigateur : douze machines virtuelles (des postes, des serveurs, des routeurs) qui forment une petite banque et un petit morceau d'Internet. Tu ne peux **rien casser** : si tu te perds, tu ré-importes le laboratoire et tu repars d'un état propre.
>
> **Les sorties que tu lis dans ce document sont réelles.** Chaque commande a été exécutée dans ce laboratoire et un test automatique (`src/__tests__/unit/network-v2/tuto-dns-zero-a-heros.test.ts`) la rejoue : si le document et le simulateur ne sont plus d'accord, le test échoue. Le comportement du serveur DNS a été comparé à un vrai BIND 9.18.

---

## Comment lire ce document

Le tutoriel est découpé en **onze parties**, précédées d'une **Partie 0** qui prépare le terrain.

| Partie | Ce que tu y fais | Durée indicative |
|---|---|---|
| **0** | Apprendre à te servir du simulateur et d'un terminal | 30 min |
| **I** | Comprendre ce qu'est le DNS, **sans rien installer**, avec quelques petites expériences | 45 min |
| **II** | Découvrir le laboratoire et vérifier qu'il fonctionne | 30 min |
| **III** | Poser des questions au DNS et lire les réponses (`dig`, `nslookup`) | 2 h |
| **IV** | Voir comment une question descend l'arbre des noms | 1 h |
| **V** | Connaître les types de fiches (A, CNAME, MX, TXT, SRV, PTR…) | 1 h 30 |
| **VI** | Lire, vérifier, modifier et créer des zones sur un vrai serveur | 3 h |
| **VII** | Comprendre le cache : pourquoi une modification n'arrive pas tout de suite | 2 h |
| **VIII** | Redondance, DNS privé, DHCP | 1 h 30 |
| **IX–X** | Observer le DNS sur le fil, et voir ce qu'il fait pour le web | 1 h 30 |
| **XI** | Diagnostiquer une panne avec méthode, et auditer | 2 h |

Tu n'as pas à tout faire d'une traite. **Arrête-toi quand tu es fatigué**, reprends plus tard : chaque TP commence par rappeler ce qu'il te faut.

**Trois règles.**

1. **Ne saute pas les étapes.** Le DNS s'apprend avec les doigts. Tu ne comprends vraiment le TTL qu'au moment où tu vois une réponse *vieillir* sous tes yeux.
2. **Un TP = un seul sujet.** Chaque TP porte sur une seule idée, découpée en étapes numérotées. Fais-les dans l'ordre.
3. **Lis la section « Ce que tu viens d'apprendre ».** C'est là que le « pourquoi » est écrit, une fois que tu as vu le « comment ».

### Les encadrés

| Marqueur | Signification |
|---|---|
| 💡 **Astuce** | Un raccourci ou une bonne habitude |
| ⚠️ **Attention** | Un piège classique |
| 🚨 **Danger** | Une commande qui peut te couper l'accès au service |
| 🧪 **TP** | Un exercice à faire sur le laboratoire, pas seulement à lire |
| 🧠 **Comprendre** | Le « pourquoi » derrière le « comment » |
| 🆘 **Si ça ne marche pas** | Ce que tu vérifies si ta sortie ne ressemble pas à celle du document |
| 🔍 **Point d'audit** | Ce qu'un auditeur vérifierait, et comment en garder la preuve |

### Le sens d'un bloc de commande

Chaque bloc de commandes commence par une ligne `# sur <équipement>` qui te dit **dans quel terminal tu tapes**. Cette ligne n'est **pas** à taper : c'est une indication.

```schema
# sur PC-CONSEILLER      ← poste Linux de l'agence (bash)
# sur PC-GUICHET1        ← poste Windows de l'agence (PowerShell)
# sur DNS-RES            ← résolveur Linux/BIND de l'agence (bash)
# sur DC1                ← contrôleur de domaine Windows (PowerShell)
# sur NS1-BANK           ← serveur Linux/BIND de la banque (bash)
# sur TLD-NS             ← serveur Windows de la zone « com » (PowerShell)
```

Ce qu'une commande affiche s'écrit **dans un autre bloc, juste en dessous**. Quand une valeur change d'une exécution à l'autre (un numéro `id:`, une date, une durée en ms), le texte le précise.

Deux différences connues avec un vrai poste, à ne pas prendre pour une erreur : un vrai `dig` 9.18 envoie un *cookie* et ajoute à la réponse une ligne `; COOKIE: … (good)` que le simulateur n'écrit pas ; et les dates affichées sont celles de l'horloge de la machine qui exécute le simulateur.

---

## Table des matières

### Partie 0 — Prendre en main le simulateur et le terminal
0.1 [Ouvrir le laboratoire](#01-ouvrir-le-laboratoire)
0.2 [Le terminal : une fenêtre où l'on donne des ordres](#02-le-terminal--une-fenêtre-où-lon-donne-des-ordres)
0.3 [Ton premier ordre](#03-ton-premier-ordre)
0.4 [Anatomie d'une commande](#04-anatomie-dune-commande)
0.5 [L'autre famille : Windows et PowerShell](#05-lautre-famille--windows-et-powershell)
0.6 [Quand quelque chose ne marche pas](#06-quand-quelque-chose-ne-marche-pas)
0.7 [Dix mots pour commencer](#07-dix-mots-pour-commencer)

### Partie I — Comprendre le DNS, en petits pas
I.1 [Les machines ne comprennent que des numéros](#i1-les-machines-ne-comprennent-que-des-numéros)
I.2 [Première solution : le carnet d'adresses de la machine](#i2-première-solution--le-carnet-dadresses-de-la-machine)
I.3 [Pourquoi un carnet ne suffit plus](#i3-pourquoi-un-carnet-ne-suffit-plus)
I.4 [L'idée du DNS : un annuaire découpé en morceaux](#i4-lidée-du-dns--un-annuaire-découpé-en-morceaux)
I.5 [Lire un nom de droite à gauche](#i5-lire-un-nom-de-droite-à-gauche)
I.6 [Qui détient quel morceau ? Zone et serveur faisant autorité](#i6-qui-détient-quel-morceau--zone-et-serveur-faisant-autorité)
I.7 [La délégation : « je ne tiens pas ce rayon, demande là-bas »](#i7-la-délégation--je-ne-tiens-pas-ce-rayon-demande-là-bas)
I.8 [Celui qui fait les démarches : le résolveur](#i8-celui-qui-fait-les-démarches--le-résolveur)
I.9 [Une résolution racontée du début à la fin](#i9-une-résolution-racontée-du-début-à-la-fin)
I.10 [Le cache et le TTL : ne pas redemander cent fois](#i10-le-cache-et-le-ttl--ne-pas-redemander-cent-fois)
I.11 [Les fiches de l'annuaire : les enregistrements](#i11-les-fiches-de-lannuaire--les-enregistrements)
I.12 [Vérifie-toi](#i12-vérifie-toi)

### Partie II — Le laboratoire Banque Horizon
II.1 [L'histoire du laboratoire](#ii1-lhistoire-du-laboratoire)
II.2 [Les douze équipements](#ii2-les-douze-équipements)
II.3 [🧪 TP 1 — Le laboratoire respire](#ii3--tp-1--le-laboratoire-respire)

### Partie III — Poser une question
III.1 [🧪 TP 2 — Lire une réponse de `dig`](#iii1--tp-2--lire-une-réponse-de-dig)
III.2 [🧪 TP 3 — Choisir ce que `dig` affiche](#iii2--tp-3--choisir-ce-que-dig-affiche)
III.3 [🧪 TP 4 — Les mêmes questions côté Windows](#iii3--tp-4--les-mêmes-questions-côté-windows)
III.4 [🧪 TP 5 — Qui est mon serveur DNS ?](#iii4--tp-5--qui-est-mon-serveur-dns-)
III.5 [🧪 TP 6 — Les suffixes de recherche](#iii5--tp-6--les-suffixes-de-recherche)

### Partie IV — Descendre l'arbre
IV.1 [🧪 TP 7 — `dig +trace` : refaire le travail du résolveur](#iv1--tp-7--dig-trace--refaire-le-travail-du-résolveur)
IV.2 [🧪 TP 8 — Interroger chaque niveau : renvois et glue](#iv2--tp-8--interroger-chaque-niveau--renvois-et-glue)
IV.3 [🧪 TP 9 — Le bit de récursion](#iv3--tp-9--le-bit-de-récursion)

### Partie V — Les enregistrements
V.1 [🧪 TP 10 — A, AAAA et CNAME](#v1--tp-10--a-aaaa-et-cname)
V.2 [🧪 TP 11 — MX, TXT (SPF, DMARC) et SRV](#v2--tp-11--mx-txt-spf-dmarc-et-srv)
V.3 [🧪 TP 12 — PTR : retrouver un nom depuis une adresse](#v3--tp-12--ptr--retrouver-un-nom-depuis-une-adresse)
V.4 [🧪 TP 13 — NXDOMAIN ou NODATA ?](#v4--tp-13--nxdomain-ou-nodata-)

### Partie VI — Les serveurs
VI.1 [🧪 TP 14 — Lire la configuration et la zone de NS1-BANK](#vi1--tp-14--lire-la-configuration-et-la-zone-de-ns1-bank)
VI.2 [🧪 TP 15 — Vérifier avant de recharger](#vi2--tp-15--vérifier-avant-de-recharger)
VI.3 [🧪 TP 16 — Le résolveur DNS-RES](#vi3--tp-16--le-résolveur-dns-res)
VI.4 [🧪 TP 17 — Les serveurs Windows](#vi4--tp-17--les-serveurs-windows)
VI.5 [🧪 TP 18 — Modifier une zone et la voir arriver chez le secondaire](#vi5--tp-18--modifier-une-zone-et-la-voir-arriver-chez-le-secondaire)
VI.6 [🧪 TP 19 — Le piège du numéro de série oublié](#vi6--tp-19--le-piège-du-numéro-de-série-oublié)
VI.7 [⭐ 🧪 TP 20 — Créer sa propre zone et la brancher dans l'arbre](#vi7---tp-20--créer-sa-propre-zone-et-la-brancher-dans-larbre)

### Partie VII — Le cache
VII.1 [🧪 TP 21 — Le TTL qui décroît](#vii1--tp-21--le-ttl-qui-décroît)
VII.2 [🧪 TP 22 — Le cache négatif](#vii2--tp-22--le-cache-négatif)
VII.3 [🧪 TP 23 — Le cache du poste Windows](#vii3--tp-23--le-cache-du-poste-windows)
VII.4 [🧪 TP 24 — Lire le cache de BIND](#vii4--tp-24--lire-le-cache-de-bind)
VII.5 [🧪 TP 25 — Vider le cache, en entier ou en partie](#vii5--tp-25--vider-le-cache-en-entier-ou-en-partie)
VII.6 [🧪 TP 26 — Le cache des échecs (SERVFAIL)](#vii6--tp-26--le-cache-des-échecs-servfail)

### Partie VIII — Redondance, DNS privé et DHCP
VIII.1 [🧪 TP 27 — NS1-BANK tombe](#viii1--tp-27--ns1-bank-tombe)
VIII.2 [🧪 TP 28 — DNS interne et redirecteur](#viii2--tp-28--dns-interne-et-redirecteur)
VIII.3 [🧪 TP 29 — DHCP et enregistrement dynamique](#viii3--tp-29--dhcp-et-enregistrement-dynamique)
VIII.4 [🧪 TP 30 — La NRPT du poste Windows](#viii4--tp-30--la-nrpt-du-poste-windows)

### Partie IX — Observer
IX.1 [🧪 TP 31 — Journaliser les requêtes](#ix1--tp-31--journaliser-les-requêtes)
IX.2 [🧪 TP 32 — Voir le DNS sur le fil : UDP, troncature, TCP](#ix2--tp-32--voir-le-dns-sur-le-fil--udp-troncature-tcp)

### Partie X — Le web vu du DNS
X.1 [🧪 TP 33 — Un nom, une adresse, plusieurs sites](#x1--tp-33--un-nom-une-adresse-plusieurs-sites)

### Partie XI — Quand ça ne marche pas, et comment le prouver
XI.1 [La méthode en six questions](#xi1-la-méthode-en-six-questions)
XI.2 [🧪 TP 34 — Cinq pannes à diagnostiquer](#xi2--tp-34--cinq-pannes-à-diagnostiquer)
XI.3 [Les messages d'erreur et ce qu'ils veulent dire](#xi3-les-messages-derreur-et-ce-quils-veulent-dire)
XI.4 [🧪 TP 35 — Auditer le service de noms](#xi4--tp-35--auditer-le-service-de-noms)
XI.5 [Et maintenant ?](#xi5-et-maintenant-)

### Annexes
A.1 [Aide-mémoire](#a1-aide-mémoire)
B.1 [Glossaire](#b1-glossaire)

---

# Partie 0 — Prendre en main le simulateur et le terminal

Cette partie ne parle **pas** encore de DNS. Elle t'apprend les gestes dont tu auras besoin pendant tout le reste : ouvrir le laboratoire, ouvrir un terminal, taper une commande, la lire. Si tu les maîtrises déjà, passe directement à la Partie I.

---

## 0.1 Ouvrir le laboratoire

Le **simulateur** est un logiciel qui tourne dans ton navigateur. On y pose des équipements (des postes, des serveurs, des routeurs), on les relie par des câbles, et chacun se comporte comme la vraie machine. Le **laboratoire** de ce tutoriel est un réseau déjà construit, que tu charges depuis un fichier.

**Étape 1 — Lancer le simulateur.** Il y a deux façons, choisis la tienne.

- *Tu as le code du projet sur ta machine.* Dans un terminal **de ton ordinateur** (pas celui du simulateur), place-toi dans le dossier du projet, tape `npm run dev`, puis ouvre <http://localhost:8080> dans ton navigateur.
- *Tu utilises la version en ligne.* Ouvre l'adresse du simulateur que ton formateur t'a donnée. Dans ce cas, télécharge d'abord le fichier du laboratoire, `labs/dns-agence-bancaire/topology.json`, depuis le dépôt du projet (`github.com/mkokutoyori/ubuntu-sandbox`).

**Étape 2 — Importer le laboratoire.** Dans la barre d'outils du simulateur, clique sur **Importer**, puis choisis le fichier `topology.json` du dossier `labs/dns-agence-bancaire/`.

**Étape 3 — Vérifier que tout est là.** Au bout de quelques secondes, le canevas (la grande zone centrale) affiche **douze équipements reliés par des câbles**. Tu dois reconnaître, entre autres, des noms comme `PC-CONSEILLER`, `DNS-RES`, `NS1-BANK`, `ROOT-NS`.

🆘 **Si ça ne marche pas.** Rien ne s'affiche après l'import : recharge la page et recommence l'import. Tu vois moins de douze équipements : l'import a été interrompu, recommence-le.

> 💡 **Astuce** — Le laboratoire peut être ré-importé à tout moment. Quand tu auras modifié des fichiers, arrêté des services ou changé des adresses au fil des TP, **ré-importer le fichier te rend un laboratoire neuf**. C'est ta ceinture de sécurité.

---

## 0.2 Le terminal : une fenêtre où l'on donne des ordres

Pour parler à un équipement, on ne clique pas sur des boutons : on lui écrit des **ordres**, qu'on appelle des **commandes**. La fenêtre où on les écrit s'appelle un **terminal**.

**Étape 1 — Ouvrir le terminal d'un équipement.** Sur le canevas, **double-clique** sur `PC-CONSEILLER`. Une fenêtre s'ouvre.

**Étape 2 — Reconnaître la ligne d'invite.** Dans cette fenêtre, la dernière ligne affichée est la **ligne d'invite** (en anglais, le *prompt*). C'est la machine qui te dit : « je t'écoute ». Elle contient en général ton nom, le nom de la machine et finit par le signe `$` sur Linux. Ton curseur clignote juste après.

**Étape 3 — Comment on s'en sert.**

- Tu **tapes** une commande, puis tu appuies sur **Entrée**. La machine l'exécute et **affiche son résultat** sous ta ligne, puis te redonne une ligne d'invite.
- Tu peux **copier/coller** les commandes de ce document dans le terminal.
- La touche **flèche haut** rappelle la commande précédente, très pratique pour corriger une faute de frappe.
- Si une commande tourne sans s'arrêter, **Ctrl + C** l'interrompt.

> 💡 **Astuce** — Garde plusieurs terminaux ouverts en même temps, un par équipement, et reconnais-les à leur titre. Tout au long du tutoriel, le texte `# sur PC-CONSEILLER` te dit lequel utiliser.

---

## 0.3 Ton premier ordre

Tu as maintenant un terminal ouvert sur `PC-CONSEILLER`. On va lui donner quatre ordres très simples. Il n'y a **aucun risque** : ils ne font que **lire** des informations.

**Étape 1 — Faire parler la machine.** La commande `echo` répète ce qu'on lui donne.

```
# sur PC-CONSEILLER
echo bonjour
```

Tu dois voir :

```
bonjour
```

La machine a simplement répété le mot. Si tu vois `bonjour`, ton terminal fonctionne et tu sais taper une commande.

**Étape 2 — Demander qui tu es.**

```
# sur PC-CONSEILLER
whoami
```

```
user
```

`whoami` signifie « *who am I* », qui suis-je ? La réponse est `user` : tu es connecté sous le compte `user`. Dans le laboratoire, tu es toujours déjà connecté, tu n'auras **aucun mot de passe** à saisir.

**Étape 3 — Demander comment s'appelle la machine.**

```
# sur PC-CONSEILLER
hostname
```

```
PC-CONSEILLER
```

`hostname` (« nom de l'hôte ») affiche le nom de la machine sur laquelle tu es. C'est un bon réflexe : **quand tu doutes du terminal dans lequel tu es, tape `hostname`**.

**Étape 4 — Demander où tu es.**

```
# sur PC-CONSEILLER
pwd
```

```
/home/user
```

`pwd` (« *print working directory* ») affiche le dossier dans lequel tu te trouves. `/home/user` est ton dossier personnel. Le signe `/` sépare les dossiers : on écrit un **chemin** `/home/user` pour dire « dans le dossier `home`, le dossier `user` ». Tout ce qui est un fichier ou un dossier a un chemin.

---

## 0.4 Anatomie d'une commande

Presque toutes les commandes se lisent comme une phrase de trois morceaux :

```schema
 wc   -l   /etc/hosts
 │    │    └── l'argument : ce sur quoi la commande travaille (ici un fichier)
 │    └─────── l'option : une précision sur la façon de faire (ici « compte les lignes »)
 └──────────── le programme : ce qu'on demande de faire
```

- Le **programme** est toujours le premier mot.
- Les **options** commencent par un tiret (`-l`, `-c`) ou deux (`--help`). Elles changent le comportement. Plusieurs options se mettent les unes après les autres.
- Les **arguments** disent sur quoi travailler : un fichier, un nom, une adresse.

Tout est séparé par des **espaces**. Une espace de trop ou de moins peut changer le sens de la commande, c'est pourquoi on copie-colle quand on peut.

**Étape 1 — Une commande avec une option et un argument.**

```
# sur PC-CONSEILLER
wc -l /etc/hosts
```

```
5 /etc/hosts
```

`wc` compte. Avec l'option `-l` (*lines*), il compte les **lignes** du fichier `/etc/hosts`. Il répond : 5 lignes. (On ouvrira ce fichier à la Partie I : il va nous servir.)

**Étape 2 — Une commande qui parle à une autre machine.**

```
# sur PC-CONSEILLER
ping -c 1 127.0.0.1
```

```
PING 127.0.0.1 (127.0.0.1) 56(84) bytes of data.
64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.010 ms

--- 127.0.0.1 ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 0.010/0.010/0.010/0.000 ms
```

`ping` est le « sonar » du réseau : il envoie un petit message à une machine et attend qu'elle réponde. L'option `-c 1` veut dire « *count* 1 » : envoie **un seul** message (sans cette option, `ping` tourne sans fin). L'argument `127.0.0.1` est l'adresse de la machine à joindre : c'est un cas particulier, l'adresse **de la machine elle-même**.

Comment lire le résultat ? **Une seule ligne compte pour l'instant** : l'avant-dernière.

- `1 packets transmitted, 1 received, 0% packet loss` : j'ai envoyé 1 message, 1 réponse est revenue, rien perdu. **Ça marche.**
- Si tu lis `0 received, 100% packet loss`, personne n'a répondu.

Le reste (`ttl`, `time`, `rtt`) donne des détails techniques dont on n'aura pas besoin avant la Partie II.

---

## 0.5 L'autre famille : Windows et PowerShell

Le laboratoire contient deux familles de machines : des **Linux** (comme `PC-CONSEILLER`) et des **Windows** (comme `PC-GUICHET1`). Elles ne se pilotent pas avec les mêmes commandes, et tu dois savoir manier les deux, parce qu'un administrateur DNS rencontre les deux.

Sous Windows, le terminal s'appelle **PowerShell**. Sa ligne d'invite commence par `PS` et finit par `>`.

**Étape 1 — Ouvrir PowerShell.** Double-clique sur `PC-GUICHET1`.

**Étape 2 — Reconnaître les différences d'écriture.**

- Les commandes PowerShell s'appellent des *cmdlets* et s'écrivent **Verbe-Nom** : `Get-Location` (« obtenir l'emplacement »), `Resolve-DnsName` (« résoudre un nom DNS »). Tu devines presque toujours ce qu'elles font.
- Les options s'écrivent `-Nom valeur` : `Resolve-DnsName banquehorizon.com -Type MX`.
- Les majuscules n'ont **pas** d'importance sous PowerShell. Sous Linux, **elles en ont** : `Hostname` n'est pas `hostname`.

**Étape 3 — Trois ordres pour essayer.**

```powershell
# sur PC-GUICHET1
hostname
```

```
PC-GUICHET1
```

Comme sous Linux : le nom de la machine. (Certaines commandes simples existent dans les deux mondes.)

```powershell
# sur PC-GUICHET1
Get-Location
```

```
Path         
----         
C:\Users\User
```

`Get-Location` est l'équivalent de `pwd`. Remarque le style Windows : les dossiers sont séparés par un `\` et le chemin commence par une **lettre de lecteur** (`C:`). PowerShell présente le résultat en **tableau**, avec un titre (`Path`) souligné.

```powershell
# sur PC-GUICHET1
Write-Output bonjour
```

```
bonjour
```

`Write-Output` est l'équivalent de `echo`.

> 💡 **Astuce** — Retiens cette règle simple : **la ligne `# sur X` te dit le terminal ; le nom du bloc te dit la famille.** Un bloc `powershell` se tape dans un équipement Windows, les autres dans un équipement Linux.

---

## 0.6 Quand quelque chose ne marche pas

Tu rencontreras des messages d'erreur, c'est normal : ils font partie de l'apprentissage et certains TP les provoquent exprès. Voici dans l'ordre les cinq vérifications à faire.

1. **Es-tu dans le bon terminal ?** Tape `hostname` et compare avec la ligne `# sur …` du TP.
2. **As-tu bien recopié la commande ?** Les espaces, les majuscules (sous Linux), les guillemets comptent. Copie-colle.
3. **Le message d'erreur dit-il quelque chose de précis ?** `command not found` : le mot n'est pas une commande (faute de frappe, ou mauvaise famille Linux/Windows). `Permission denied` : il manque des droits (voir `sudo`, plus loin).
4. **Le laboratoire est-il dans son état de départ ?** Si tu as fait des modifications dans un TP précédent et que tu as sauté sa dernière étape (le « remettre en état »), les sorties peuvent différer. Ré-importe le laboratoire.
5. **Si rien ne va, ré-importe le laboratoire** (§ 0.1) et reprends le TP depuis le début.

---

## 0.7 Dix mots pour commencer

Tu les as déjà croisés ou tu les croiseras tout de suite. Ne cherche pas à les apprendre par cœur : reviens ici quand tu en as besoin.

| Mot | Ce que ça veut dire, en mots simples |
|---|---|
| **Réseau** | Des machines reliées entre elles pour pouvoir s'envoyer des messages |
| **Hôte** | N'importe quelle machine du réseau : un poste, un serveur, un routeur |
| **Adresse IP** | Le **numéro** d'une machine sur le réseau, comme un numéro de téléphone (`203.0.113.20`) |
| **Client** | La machine qui **demande** quelque chose (ton poste) |
| **Serveur** | La machine qui **répond** et rend un service (un serveur web, un serveur DNS) |
| **Requête** | Le message de la question envoyée par un client |
| **Réponse** | Le message qui revient en retour |
| **Protocole** | La façon convenue de se parler (le vocabulaire et l'ordre des messages). DNS est un protocole |
| **Port** | Le « guichet » d'une machine : un serveur DNS écoute au port 53, un serveur web au port 80 |
| **Paquet** | Un petit morceau de message qui voyage sur le réseau |

---

# Partie I — Comprendre le DNS, en petits pas

Dans cette partie, on construit l'idée du DNS **une pièce à la fois**. Tu n'as pas besoin du laboratoire complet ; ton terminal sur `PC-CONSEILLER` suffit, pour trois petites expériences. À chaque section, une seule idée nouvelle.

---

## I.1 Les machines ne comprennent que des numéros

Quand tu tapes `www.banquehorizon.com` dans un navigateur, ta machine ne sait pas du tout ce qu'est « `www.banquehorizon.com` ». Pour envoyer un message à une autre machine sur un réseau, elle a besoin de son **adresse IP** : un numéro, formé de quatre nombres séparés par des points, comme `203.0.113.20`.

Un numéro de téléphone fonctionne pareil : pour appeler quelqu'un, il faut son numéro, le nom ne suffit pas.

Chaque machine du réseau a son numéro. Tu peux demander le tien.

**Étape 1 — Voir l'adresse de `PC-CONSEILLER`.**

```
# sur PC-CONSEILLER
hostname -I
```

```
10.20.10.52
```

(Tu lis `10.20.10.52` suivi d'une espace.) `hostname -I`, avec un `I` majuscule, affiche les adresses IP de la machine. Celle de `PC-CONSEILLER` est `10.20.10.52`.

Les humains retiennent mal les numéros et bien les noms. Or une machine ne sait manier que les numéros. Il faut donc un **traducteur** entre les deux : quelqu'un qui, à partir de `www.banquehorizon.com`, donne `203.0.113.20`. Ce traducteur s'appelle le **DNS**, pour *Domain Name System* (« système de noms de domaine »).

🧠 **À retenir.** Le DNS traduit un **nom** (pour les humains) en **adresse IP** (pour les machines), et dans l'autre sens aussi.

---

## I.2 Première solution : le carnet d'adresses de la machine

Avant d'inventer le DNS, comment faisait-on ? Chaque machine a un petit **carnet d'adresses** personnel : un simple fichier texte qui associe des noms à des numéros. Sous Linux il s'appelle `/etc/hosts`. Faisons l'expérience.

**Étape 1 — Lire le carnet tel qu'il est.**

```
# sur PC-CONSEILLER
cat /etc/hosts
```

```
127.0.0.1	localhost
127.0.1.1	PC-CONSEILLER

# The following lines are desirable for IPv6 capable hosts
::1	localhost ip6-localhost ip6-loopback
```

`cat` (« concaténer ») affiche le contenu d'un fichier. Chaque ligne utile associe un numéro à un ou plusieurs noms : `127.0.0.1` s'appelle `localhost` (c'est « moi-même »), et la machine a son propre nom sur la deuxième ligne. Les lignes qui commencent par `#` sont des commentaires, la machine les ignore. (Les 5 lignes comptées au § 0.4, ce sont celles-ci, avec la ligne vide.)

**Étape 2 — Essayer de joindre un nom que le carnet ne connaît pas.**

```
# sur PC-CONSEILLER
ping -c 1 -W 1 monsite.banque
```

```
ping: monsite.banque: Name or service not known
```

`monsite.banque` est un nom que j'invente. L'option `-W 1` veut dire « n'attends pas plus d'une seconde ». Le message dit : `Name or service not known`, « nom inconnu ». La machine n'a trouvé ce nom **nulle part** : elle ne peut donc pas envoyer le moindre message. C'est la première erreur DNS que tu rencontres, et tu la reverras souvent.

**Étape 3 — Ajouter une ligne au carnet.** On va dire à la machine que `monsite.banque` est l'adresse `203.0.113.20` (celle du serveur web de la banque).

```
# sur PC-CONSEILLER
echo '203.0.113.20 monsite.banque' | sudo tee -a /etc/hosts
```

```
203.0.113.20 monsite.banque
```

Cette commande en trois pièces mérite d'être lue lentement :

- `echo '203.0.113.20 monsite.banque'` fabrique la ligne de texte à ajouter.
- Le signe `|` (le *tube*, ou *pipe*) passe ce texte **à la commande suivante**.
- `sudo tee -a /etc/hosts` écrit ce texte **à la fin** (`-a`, *append*) du fichier `/etc/hosts`. `tee` recopie ce qu'il reçoit dans un fichier et à l'écran. `sudo` veut dire « exécute en tant qu'administrateur » : un fichier système comme `/etc/hosts` ne se modifie pas avec un compte ordinaire. Dans le laboratoire, `sudo` ne demande jamais de mot de passe.

La machine répète la ligne à l'écran : c'est la preuve qu'elle l'a écrite.

**Étape 4 — Vérifier que le carnet a changé.**

```
# sur PC-CONSEILLER
cat /etc/hosts
```

```
127.0.0.1	localhost
127.0.1.1	PC-CONSEILLER

# The following lines are desirable for IPv6 capable hosts
::1	localhost ip6-localhost ip6-loopback
203.0.113.20 monsite.banque
```

Ta ligne est tout en bas.

**Étape 5 — Réessayer le même `ping`.**

```
# sur PC-CONSEILLER
ping -c 1 -W 1 monsite.banque
```

```
PING monsite.banque (203.0.113.20) 56(84) bytes of data.
64 bytes from monsite.banque (203.0.113.20): icmp_seq=1 ttl=62 time=0.043 ms

--- monsite.banque ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 0.043/0.043/0.043/0.000 ms
```

Cette fois ça marche. Regarde la première ligne : `PING monsite.banque (203.0.113.20)`. La machine a **traduit** `monsite.banque` en `203.0.113.20` en lisant son carnet, puis a envoyé le message à ce numéro. Elle a répondu (`1 received`). Tu viens de faire, à la main, ce que fait le DNS.

**Étape 6 — Remettre le carnet en état.** On supprime la ligne qu'on vient d'ajouter.

```
# sur PC-CONSEILLER
sudo sed -i '/monsite.banque/d' /etc/hosts
```

(Cette commande n'affiche rien : en Linux, **pas de nouvelle = bonne nouvelle**.) `sed -i '/monsite.banque/d'` signifie : « dans le fichier, **d**élète toute ligne qui contient `monsite.banque` ». Vérifie que le nom est de nouveau inconnu :

```
# sur PC-CONSEILLER
ping -c 1 -W 1 monsite.banque
```

```
ping: monsite.banque: Name or service not known
```

Tu es revenu à l'état de départ.

🧠 **Ce que tu viens d'apprendre.** Une machine commence **toujours** par lire son carnet local (`/etc/hosts`) avant de demander quoi que ce soit à qui que ce soit. C'est un traducteur nom → numéro, mais un traducteur **privé**, que seul son propriétaire connaît.

---

## I.3 Pourquoi un carnet ne suffit plus

Au début d'Internet, quelques centaines de machines seulement étaient reliées. Un seul fichier, appelé `HOSTS.TXT`, tenu par une seule personne, listait toutes les machines du monde, et chacun en recopiait une version à jour. Cela marchait… tant qu'il y avait peu de machines.

Imagine maintenant des **milliards** de machines :

- le fichier serait **gigantesque** et chaque machine devrait l'avoir en entier ;
- il **changerait à chaque seconde** (une machine arrive, une change d'adresse) : personne ne pourrait suivre ;
- **une seule personne** ne peut pas tenir à jour le carnet du monde entier.

Il faut donc un autre système, où **personne ne connaît tout** et où chacun ne s'occupe que de sa partie.

> 💡 **Astuce** — Le carnet `/etc/hosts` existe toujours, et il est toujours consulté **en premier**. Les administrateurs s'en servent pour forcer un nom (un test, un blocage). Mais pour tout le reste, il y a le DNS.

---

## I.4 L'idée du DNS : un annuaire découpé en morceaux

Pense à un annuaire téléphonique **géant**. Il serait impossible à tenir dans un seul livre. Alors on le découpe : un livre par pays, dans chaque pays un livre par région, dans chaque région un livre par ville… Personne n'a le livre entier. Mais **si on connaît le moyen de trouver le bon livre**, on retrouve n'importe quel numéro.

Le DNS fonctionne exactement ainsi :

| Dans l'annuaire papier | Dans le DNS |
|---|---|
| Un livre par pays, par région, par ville | Un **morceau** d'annuaire (une *zone*) tenu par un **serveur** |
| L'index du pays qui dit « pour Paris, voir le livre de Paris » | Une **délégation** : « pour tout ce qui est sous ce nom, demande à ces serveurs-là » |
| Le fait de ne recopier un numéro qu'une fois par jour | Le **cache** |

Trois idées à retenir pour la suite :

1. **L'annuaire est hiérarchique** : les noms se rangent dans un arbre.
2. **Chaque serveur ne tient que sa part** et sait à qui renvoyer pour le reste.
3. **On garde en mémoire les réponses un moment** pour ne pas tout redemander.

Les sections suivantes détaillent chacune de ces trois idées.

---

## I.5 Lire un nom de droite à gauche

Un nom de machine comme `www.banquehorizon.com` est fait de **morceaux séparés par des points**. Ces morceaux s'appellent des **étiquettes** (*labels*). Il y en a trois ici : `www`, `banquehorizon` et `com`.

Le point important, qui surprend tout le monde : **un nom DNS se lit de droite à gauche**. Le morceau le plus à droite est le plus **général**, celui de gauche est le plus **précis**.

```schema
   www . banquehorizon . com .
    │          │          │   └── la racine (le point final, qu'on oublie d'écrire)
    │          │          └────── le domaine de premier niveau (TLD)
    │          └───────────────── le domaine de la banque
    └──────────────────────────── le nom de la machine dans ce domaine
```

Comme les adresses postales, mais à l'envers : « France, Paris, rue de la Paix » devient « rue de la Paix . Paris . France ».

Voyons les mots un à un.

- La **racine** (*root*) est le sommet de l'arbre. Elle se note par un simple point. Dans un nom complet, on l'écrit au bout : `www.banquehorizon.com.` (avec le point final). La plupart du temps on l'omet, mais le DNS, lui, le sous-entend toujours.
- Un **domaine de premier niveau** (*TLD*, *top-level domain*) est juste en dessous de la racine : `com`, `org`, `fr`…
- Un **domaine** est un nom et **tout ce qui est en dessous** : `banquehorizon.com` est le domaine de la banque.
- Un **sous-domaine** est un domaine contenu dans un autre : dans `agence.banquehorizon.com`, `agence` est un sous-domaine de `banquehorizon.com`.
- Un nom **complet**, avec toutes ses étiquettes jusqu'à la racine, s'appelle un **FQDN** (*fully qualified domain name*) : `www.banquehorizon.com.`

```schema
                       .                    ← la racine
                       │
                      com                   ← domaine de premier niveau (TLD)
                       │
                banquehorizon               ← le domaine de la banque
               ╱       │        ╲
            www       web       mail        ← les noms à l'intérieur
```

**Petit exercice.** Pour `ebanking.banquehorizon.com`, retrouve : (a) le TLD, (b) le domaine de la banque, (c) le nom de la machine. *Réponses* : (a) `com`, (b) `banquehorizon.com`, (c) `ebanking`.

---

## I.6 Qui détient quel morceau ? Zone et serveur faisant autorité

Un **serveur DNS** est un programme qui répond aux questions du type « quelle est l'adresse de tel nom ? ». Mais il ne connaît pas tous les noms du monde : il connaît **ceux dont il est responsable**.

L'ensemble des noms dont un serveur est officiellement responsable s'appelle une **zone**. Pense à un **rayon de bibliothèque** : le serveur en tient le registre officiel. Sur un serveur, la zone est décrite par un fichier texte, le **fichier de zone**, qui liste les noms et leurs adresses (on en lira un en Partie VI).

Un serveur qui détient la version **officielle** d'une zone est dit **faisant autorité** (*authoritative*) pour cette zone. C'est lui la source : quand il répond, ce n'est pas une rumeur, c'est le registre.

⚠️ **Attention** — On confond souvent *domaine* et *zone*.

| | Définition | Exemple |
|---|---|---|
| **Domaine** | Un **sous-arbre de l'arbre des noms** : un nom et tout ce qui est dessous | `banquehorizon.com` et tous ses sous-noms |
| **Zone** | Le **morceau administratif** qu'**un même serveur** décrit | la part de `banquehorizon.com` que ce serveur tient |

Dans ce tutoriel, domaine et zone coïncident presque toujours ; la nuance importe quand on **délègue** une partie d'un domaine à quelqu'un d'autre, ce qu'on va voir.

---

## I.7 La délégation : « je ne tiens pas ce rayon, demande là-bas »

Comment un serveur qui ne connaît qu'un morceau de l'arbre aide-t-il à trouver le reste ? Par la **délégation**.

Imagine un employé de la bibliothèque à qui tu demandes un livre de cuisine. Il ne l'a pas dans son rayon, mais il te dit : « La cuisine, c'est le rayon 4, tenu par Marie. » Il ne t'a pas donné le livre : il t'a **renvoyé** vers celui qui sait.

Dans le DNS, c'est exactement cela. Un serveur dit : « Pour tout ce qui est sous *tel nom*, adresse-toi à *tel serveur* ». Cette indication est une fiche d'un type particulier, appelée **NS** (pour *name server*, « serveur de noms »). La réponse « va demander ailleurs » s'appelle un **renvoi** (*referral*).

Dans le laboratoire, la chaîne est la suivante :

```schema
.                              zone tenue par ROOT-NS      (la racine)
└── com.                       zone tenue par TLD-NS       ← la racine y renvoie
    └── banquehorizon.com.     zones tenues par NS1-BANK et NS2-BANK   ← com y renvoie
```

- La **racine** ne sait *rien* de `www.banquehorizon.com`. Elle sait seulement qui s'occupe de `com`.
- `com` ne sait rien de `www` non plus : il sait qui s'occupe de `banquehorizon.com`.
- Seuls **NS1-BANK** et **NS2-BANK**, qui détiennent la zone de la banque, savent que `www` est un alias de `web` et que `web` vaut `203.0.113.20`.

🧠 **Pourquoi c'est génial.** C'est ce découpage qui permet au DNS de grandir sans qu'aucun serveur ne connaisse tout. Et les propriétaires de chaque morceau le gèrent **seuls**, sans demander la permission à personne d'autre.

⚠️ **Un détail qui reviendra.** Dans le renvoi « `banquehorizon.com`, demande à `ns1.banquehorizon.com` », on te donne un **nom** de serveur. Pour lui envoyer ta question, il te faut son **adresse**… mais pour l'avoir, il faudrait résoudre `banquehorizon.com`, c'est-à-dire justement ce qu'on cherche ! Pour sortir de ce cercle, celui qui renvoie **joint l'adresse** du serveur à sa réponse. Cette adresse offerte avec le renvoi s'appelle la **glue** (« colle »). Tu la verras au TP 8.

---

## I.8 Celui qui fait les démarches : le résolveur

Ton poste ne descend pas l'arbre tout seul : il serait obligé de connaître la racine, `com`, etc. Il délègue ce travail à un spécialiste. Voici les rôles, **un par un**.

**Le stub (le « petit client »).** C'est le petit morceau de logiciel de ton poste qui sait poser **une** question à **un** serveur de son choix et attendre **la** réponse. Il ne sait rien d'autre. C'est un peu l'accueil d'un bureau : il prend ta demande.

**Le résolveur récursif.** C'est un serveur qui **fait tout le travail à la place du stub** : il interroge la racine, puis `com`, puis la banque, jusqu'à obtenir la réponse, puis la renvoie au stub. On dit qu'il fait de la **récursion** (« je me débrouille et je reviens avec la réponse »). C'est aussi lui qui garde les réponses en **cache**. Dans le laboratoire, c'est `DNS-RES`. C'est l'employé qui court de bureau en bureau pour toi.

**Le serveur faisant autorité** (déjà vu en I.6). Il connaît **sa** zone et répond définitivement. Pour tout le reste, il se contente de **renvoyer** vers d'autres. Il ne fait **pas** de récursion.

```schema
  ton poste           résolveur récursif                 serveurs faisant autorité
 ┌───────┐ « www ? » ┌──────────────────┐   ┌──────────┐ ┌──────────┐ ┌─────────────┐
 │ stub  │──────────▶│ DNS-RES (cache)  │──▶│ racine   │ │ com      │ │ banque      │
 │       │◀──────────│                  │◀──│ « va voir│ │ « va voir│ │ « la voici »│
 └───────┘ réponse   └──────────────────┘   │  com »   │ │  la banque»│ └─────────────┘
                                            └──────────┘ └──────────┘
```

Tout le malentendu sur le DNS vient de la confusion entre ces trois rôles. Retiens-les ainsi :

| Rôle | Il fait… | Dans le laboratoire |
|---|---|---|
| **Stub** | Pose une question, attend la réponse | tes postes |
| **Résolveur récursif** | Fait tout le chemin et garde en cache | `DNS-RES` |
| **Serveur faisant autorité** | Détient une zone et répond officiellement | `ROOT-NS`, `TLD-NS`, `NS1-BANK`, `NS2-BANK` |

Il existe un quatrième rôle, le **redirecteur** (*forwarder*) : un résolveur qui, au lieu de descendre l'arbre lui-même, **passe la question** à un autre résolveur. `DC1` joue ce rôle : il redirige ce qu'il ne connaît pas vers `DNS-RES`.

> 🔍 **Point d'audit** — Un résolveur qui répond à **n'importe qui sur Internet** s'appelle un *résolveur ouvert* ; c'est un instrument d'attaque. La première vérification d'un auditeur : *la récursion est-elle limitée aux réseaux de l'entreprise ?* Tu le vérifieras aux TP 9 et 35.

---

## I.9 Une résolution racontée du début à la fin

Reprenons ton poste `PC-CONSEILLER` qui veut joindre `www.banquehorizon.com`. Au départ, **aucun cache n'est rempli**.

1. **Le stub** regarde d'abord dans le carnet local (`/etc/hosts`) : rien. Il envoie alors la question à son résolveur : « Quelle est l'adresse de `www.banquehorizon.com` ? »
2. **Le résolveur** n'a rien en cache. Il connaît seulement une petite liste de départ, les **indices racine** (*root hints*) : les adresses des serveurs de la racine. Il demande à la racine : « Quelle est l'adresse de `www.banquehorizon.com` ? »
3. **La racine** ne sait pas, mais elle sait qui tient `com`. Elle répond par un **renvoi** : « Demande à `a.nic.com`, voici son adresse. »
4. **Le résolveur** repose la même question à `a.nic.com` (le serveur de `com`).
5. **`com`** ne sait pas non plus, mais il sait qui tient `banquehorizon.com`. Il renvoie vers `ns1.banquehorizon.com` et `ns2.banquehorizon.com`, avec leurs adresses (la glue).
6. **Le résolveur** repose la question à `ns1.banquehorizon.com`. Celui-ci **fait autorité** : il répond « `www` est un alias de `web`, et `web` vaut `203.0.113.20` ».
7. **Le résolveur** garde la réponse en cache pour une durée limitée, et **renvoie la réponse au stub**. Ton poste peut maintenant envoyer son message à `203.0.113.20`.

La **deuxième fois** qu'on pose la question, les étapes 2 à 6 disparaissent : le résolveur répond depuis son cache, instantanément.

🧠 **Deux sortes de questions.** La question du stub au résolveur est dite **récursive** : « fais le travail pour moi ». Les questions du résolveur aux serveurs sont dites **itératives** : « dis-moi simplement ce que tu sais ». On verra des drapeaux (`rd`, `ra`) qui distinguent ces deux cas.

**Tu vas le voir de tes yeux** aux TP 7 et 8, où tu poseras toi-même chaque question.

Une dernière expérience, pour constater que le DNS travaille *déjà* pour toi.

```
# sur PC-CONSEILLER
ping -c 1 www.banquehorizon.com
```

```
PING www.banquehorizon.com (203.0.113.20) 56(84) bytes of data.
64 bytes from web.banquehorizon.com (203.0.113.20): icmp_seq=1 ttl=62 time=0.043 ms

--- www.banquehorizon.com ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 0.043/0.043/0.043/0.000 ms
```

Tu n'as ajouté aucune ligne à un carnet, et pourtant la machine a traduit `www.banquehorizon.com` en `203.0.113.20`. C'est le DNS qui a travaillé en coulisse. Regarde aussi la deuxième ligne : la machine répond sous le nom `web.banquehorizon.com`. C'est que `www` n'est pas une vraie machine, mais un **alias** (un surnom) de `web`. On y revient en Partie V.

Pour voir la même chose avec l'outil du système, sans `ping` :

```
# sur PC-CONSEILLER
getent hosts www.banquehorizon.com
```

```
203.0.113.20    web.banquehorizon.com www.banquehorizon.com
```

`getent hosts` pose à ta machine **la même question qu'une application** (navigateur, `ssh`, `curl`) et affiche le résultat : l'adresse, puis le nom officiel, puis le nom que tu avais tapé.

---

## I.10 Le cache et le TTL : ne pas redemander cent fois

Si le résolveur refaisait tout le chemin à chaque question, le DNS s'effondrerait. Alors il **garde la réponse en mémoire** : c'est le **cache**. Comme un post-it collé sur l'écran : « `www` = `203.0.113.20` ».

Mais cette réponse finit par ne plus être vraie (le site change d'adresse). Il faut donc une date de péremption. Chaque réponse porte une durée de vie, le **TTL** (*time to live*), en secondes : « garde-moi pendant 3 600 secondes (une heure), puis redemande ». Le propriétaire de la zone fixe ce TTL.

Deux conséquences que tu vérifieras en Partie VII :

- grâce au cache, le DNS répond vite et supporte une charge énorme ;
- **mais** quand tu changes une adresse, les résolveurs qui ont déjà la vieille réponse **la servent encore** jusqu'à l'expiration de son TTL. C'est la raison pour laquelle « j'ai modifié le DNS mais ça ne change rien » est la plainte la plus fréquente.

---

## I.11 Les fiches de l'annuaire : les enregistrements

Une zone est une liste de **fiches**. On les appelle des **enregistrements** (en anglais *resource records*, abrégé RR). Chaque fiche contient quatre informations :

| Champ | Exemple | Sens |
|---|---|---|
| **Nom** | `web.banquehorizon.com.` | À quel nom la fiche s'applique |
| **TTL** | `3600` | Combien de secondes on peut la garder en cache |
| **Type** | `A` | Quelle sorte d'information elle contient |
| **Donnée** | `203.0.113.20` | L'information elle-même |

(Il y a aussi une « classe », toujours `IN` comme *Internet*, que tu verras dans les sorties et que tu peux ignorer.)

Le **type** est ce qui compte : c'est lui qui dit *ce que la fiche raconte*. Voici les cinq types dont on aura besoin tout de suite ; les autres seront présentés quand on en aura besoin.

| Type | Il dit… | Exemple dans le laboratoire |
|---|---|---|
| **A** | « ce nom a **cette adresse IP** » (version 4) | `web.banquehorizon.com.` → `203.0.113.20` |
| **CNAME** | « ce nom est un **alias** d'un autre nom » | `www.banquehorizon.com.` → `web.banquehorizon.com.` |
| **NS** | « **ce serveur** s'occupe de cette zone » (la délégation) | `banquehorizon.com.` → `ns1.banquehorizon.com.` |
| **MX** | « le courrier de ce domaine va **à ce serveur** » | `banquehorizon.com.` → `10 mail.banquehorizon.com.` |
| **SOA** | « **l'acte de naissance** de la zone » (responsable, numéro de version, durées) | `banquehorizon.com.` → un bloc de chiffres |

Tu les rencontreras tous dans des TP, un par un. **Aucune panique** si tu ne retiens pas tout : on y reviendra à chaque fois.

---

## I.12 Vérifie-toi

Réponds de tête, puis compare avec les réponses plus bas. Si tu hésites, relis la section indiquée.

1. Quel est le rôle du DNS ? *(§ I.1)*
2. Dans quel ordre se lit le nom `www.banquehorizon.com` ? Quel est le TLD ? *(§ I.5)*
3. Qu'est-ce qu'un serveur « faisant autorité » ? *(§ I.6)*
4. Que fait un serveur qui ne connaît pas la réponse mais sait qui la connaît ? *(§ I.7)*
5. Quelle est la différence entre le stub et le résolveur ? *(§ I.8)*
6. Pourquoi la deuxième résolution d'un même nom est-elle plus rapide ? *(§ I.10)*
7. Pourquoi une modification de DNS n'est-elle pas visible partout immédiatement ? *(§ I.10)*

**Réponses.**
1. Traduire des noms en adresses IP (et l'inverse).
2. De droite à gauche : `com` (le TLD), puis `banquehorizon`, puis `www`.
3. Un serveur qui détient la version officielle d'une zone et en répond comme source de vérité.
4. Il renvoie : il donne l'adresse d'un autre serveur à interroger (un renvoi / une délégation).
5. Le stub pose la question ; le résolveur fait tout le chemin pour répondre, et garde les réponses en cache.
6. Parce que le résolveur a gardé la réponse en cache.
7. Parce que les caches continuent de servir l'ancienne réponse jusqu'à l'expiration de son TTL.

Si tu as répondu juste à cinq questions sur sept, tu peux continuer. Sinon, relis I.4 à I.10 : le reste du tutoriel s'appuie dessus.

---

# Partie II — Le laboratoire Banque Horizon

---

## II.1 L'histoire du laboratoire

Tu travailles pour **Banque Horizon**, une banque qui a une agence et un site web public. Le laboratoire simule trois mondes reliés entre eux :

1. **L'agence** (les trois postes, un contrôleur de domaine, un résolveur DNS, un routeur et un commutateur) : c'est ton « chez toi ». Tes postes y utilisent le DNS.
2. **L'hébergement de la banque** (les deux serveurs de noms de la banque et son serveur web) : c'est là que vit le nom `www.banquehorizon.com`.
3. **L'Internet simulé** (un serveur racine, un serveur du domaine `com`, un routeur de fournisseur d'accès) : c'est ce qui permet de **descendre l'arbre** comme sur le vrai Internet.

Pour commencer, **retiens seulement trois choses** :

- **`PC-CONSEILLER`** et **`PC-GUICHET1`** sont les postes depuis lesquels tu poses des questions (Linux et Windows).
- **`DNS-RES`** est le résolveur de l'agence : c'est lui qui descend l'arbre pour tes postes.
- **`NS1-BANK`** est le serveur qui détient le registre officiel du domaine `banquehorizon.com`. C'est celui que tu administreras en Partie VI.

Le reste du laboratoire sera présenté **au moment où on s'en sert**.

---

## II.2 Les douze équipements

Voici le plan complet, pour référence. Ne cherche pas à le mémoriser : reviens-y quand un TP cite un équipement.

```schema
   INTERNET SIMULÉ (R-ISP)

   198.51.100.0/24 « infra DNS »                       203.0.113.0/24 « hébergement banque »
   ┌─────────────┐  ┌─────────────┐                    ┌────────────┐ ┌────────────┐ ┌─────────────┐
   │ ROOT-NS     │  │ TLD-NS      │                    │ NS1-BANK   │ │ NS2-BANK   │ │ WEB-BANK    │
   │ Linux BIND9 │  │ Windows DNS │                    │ Linux BIND9│ │ Windows DNS│ │ Linux nginx │
   │ zone « . »  │  │ zone « com »│                    │ primaire   │ │ secondaire │ │ HTTP/HTTPS  │
   │ .1          │  │ .2          │                    │ .10        │ │ .11        │ │ .20         │
   └──────┬──────┘  └──────┬──────┘                    └─────┬──────┘ └─────┬──────┘ └──────┬──────┘
          └─── SW-INFRA ───┘                                 └──── SW-HEBERGEMENT ──────────┘
                 │ .254                                                    │ .254
                 └────────────────────────── R-ISP ────────────────────────┘
                                               │ Gi0/2  192.0.2.1/30
                                               │
                                               │ Gi0/0  192.0.2.2/30   (NAT overload)
                                            R-AGENCE ── trunk 802.1Q ── SW-AGENCE
                                                                           │
                         VLAN 20 « SERVEURS » 10.20.20.0/24                │      VLAN 10 « POSTES » 10.20.10.0/24
                         ┌──────────────┐   ┌───────────────┐              │      ┌─────────────┐ ┌─────────────┐ ┌───────────────┐
                         │ DC1          │   │ DNS-RES       │ ─────────────┴───── │ PC-GUICHET1 │ │ PC-GUICHET2 │ │ PC-CONSEILLER │
                         │ Windows      │   │ Linux BIND9   │                     │ Windows     │ │ Windows     │ │ Linux         │
                         │ DNS + DHCP   │   │ résolveur     │                     │ DHCP        │ │ DHCP        │ │ DHCP          │
                         │ .10          │   │ récursif .53  │                     │ .50         │ │ .51         │ │ .52           │
                         └──────────────┘   └───────────────┘                     └─────────────┘ └─────────────┘ └───────────────┘
```

| Équipement | Rôle | Système | Adresse |
|---|---|---|---|
| **ROOT-NS** | serveur racine (zone `.`) | Linux + BIND 9 | 198.51.100.1 |
| **TLD-NS** | serveur de la zone `com` (sans récursion) | Windows Server + DNS | 198.51.100.2 |
| **NS1-BANK** | primaire de `banquehorizon.com` et de la zone inverse | Linux + BIND 9 | 203.0.113.10 |
| **NS2-BANK** | secondaire (reçoit une copie depuis NS1-BANK) | Windows Server + DNS | 203.0.113.11 |
| **WEB-BANK** | le site de la banque (nginx) | Linux | 203.0.113.20 |
| **R-ISP** | routeur du fournisseur d'accès | Cisco IOS | 198.51.100.254, 203.0.113.254, 192.0.2.1 |
| **R-AGENCE** | routeur de l'agence : traduction d'adresses (NAT), relais DHCP | Cisco IOS | 192.0.2.2, 10.20.10.1, 10.20.20.1 |
| **SW-AGENCE** | commutateur de l'agence (VLAN 10 et 20) | Cisco IOS | — |
| **DC1** | DNS **interne** `horizon.local` + serveur DHCP | Windows Server | 10.20.20.10 |
| **DNS-RES** | résolveur récursif de l'agence | Linux + BIND 9 | 10.20.20.53 |
| **PC-GUICHET1 / 2** | postes de guichet | Windows | DHCP : 10.20.10.50 / .51 |
| **PC-CONSEILLER** | poste du conseiller | Linux | DHCP : 10.20.10.52 |

L'arbre DNS que ces serveurs servent :

```schema
.                                   ROOT-NS   a.root-servers.net = 198.51.100.1
└── com.                            TLD-NS    a.nic.com          = 198.51.100.2
    └── banquehorizon.com.          NS1-BANK (primaire)  +  NS2-BANK (secondaire)
          @ A, MX 10 mail / 20 mail2, TXT SPF, ns1, ns2, web, mail, mail2
          www, ebanking, agences, api   →   CNAME web   →   203.0.113.20
          _dmarc TXT, _imaps._tcp SRV

113.0.203.in-addr.arpa.             délégué par la racine à ns1.banquehorizon.com (PTR de .10 .11 .20 .25)

horizon.local.                      DC1 seulement (zone privée, jamais publiée dans l'arbre)
  dc1, dns-res, intranet (CNAME dc1), pc-guichet1, pc-guichet2 (inscrits par le DHCP)
```

Quatre choses à noter dès maintenant, parce qu'elles reviennent partout :

1. **Deux éditeurs, un seul protocole.** Les serveurs BIND (Linux) se configurent avec des fichiers texte ; les serveurs Windows avec PowerShell (`Get-DnsServerZone`…). Ils parlent exactement le même DNS sur le fil.
2. **Deux niveaux de DNS dans l'agence.** Les postes interrogent d'abord **DC1** (qui connaît `horizon.local`), puis **DNS-RES** s'il tombe. DC1 *redirige* vers DNS-RES tout ce qui n'est pas à lui.
3. **`horizon.local` est privée.** Elle n'existe que chez DC1 ; DNS-RES la lui renvoie. Les serveurs de l'« Internet » (racine, `com`, banque) ne l'ont jamais entendu citer.
4. **Le résolveur est protégé par une liste de contrôle d'accès.** DNS-RES ne répond qu'aux adresses `10.20.0.0/16` : depuis l'extérieur, ce serait un refus.

**Comptes.** Chaque terminal s'ouvre déjà connecté.

| Équipements | Utilisateur | Remarque |
|---|---|---|
| PC-GUICHET1, PC-GUICHET2 | `User` (Windows) | PowerShell |
| DC1, TLD-NS, NS2-BANK | `Administrator` (Windows Server) | les modules `DnsServer` et `DhcpServer` sont chargés |
| PC-CONSEILLER, ROOT-NS, NS1-BANK, DNS-RES, WEB-BANK | `user` (Linux) | `sudo` sans mot de passe |
| R-ISP, R-AGENCE, SW-AGENCE | console IOS | `enable` puis `configure terminal` |

---

## II.3 🧪 TP 1 — Le laboratoire respire

**🎯 Objectif.** Avant de toucher à quoi que ce soit, vérifier que le laboratoire fonctionne : les machines se joignent, le DHCP a distribué ses adresses, la résolution marche de bout en bout. **Si ce TP réussit, tout le reste est possible.**

**Ce qu'il te faut.** Le laboratoire importé (§ 0.1) et deux terminaux ouverts : `PC-CONSEILLER` et `PC-GUICHET1`.

### Partie A — Les machines se parlent-elles ?

**Étape 1 — Joindre le résolveur de l'agence.**

```
# sur PC-CONSEILLER
ping -c 1 -W 1 10.20.20.53
```

```
PING 10.20.20.53 (10.20.20.53) 56(84) bytes of data.
64 bytes from 10.20.20.53: icmp_seq=1 ttl=63 time=0.118 ms

--- 10.20.20.53 ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 0.118/0.118/0.118/0.000 ms
```

Rappel (§ 0.4) : on lit **la ligne `1 received`**. Elle te dit que `PC-CONSEILLER` atteint `DNS-RES`. Tu viens de franchir deux équipements (le commutateur et le routeur de l'agence), puisque le poste et le résolveur ne sont pas dans le même sous-réseau.

**Étape 2 — Joindre le site de la banque.**

```
# sur PC-CONSEILLER
ping -c 1 -W 1 203.0.113.20
```

Tu dois lire `1 received`. Cette fois le message traverse l'agence, le NAT de `R-AGENCE`, le routeur du fournisseur d'accès `R-ISP`, et arrive chez `WEB-BANK`.

**Étape 3 — Joindre la racine.**

```
# sur PC-CONSEILLER
ping -c 1 -W 1 198.51.100.1
```

Tu dois encore lire `1 received` : le serveur racine est joignable lui aussi.

🆘 **Si ça ne marche pas.** `100% packet loss` : le laboratoire est mal importé, ou un équipement est éteint. Ré-importe `topology.json` (§ 0.1). Attends dix secondes avant de relancer, le temps que les routeurs apprennent leurs routes.

### Partie B — Que t'a donné le DHCP ?

Le poste Windows n'a pas été configuré à la main : il a reçu ses réglages automatiquement. Le **DHCP** est le service qui, quand une machine arrive sur le réseau, lui **distribue** une adresse IP et ses réglages (passerelle, serveurs DNS…). Nous l'étudierons en Partie VIII ; pour l'instant, regarde ce qu'il a donné.

**Étape 4 — Afficher la configuration réseau du poste Windows.**

```powershell
# sur PC-GUICHET1
ipconfig /all
```

`ipconfig /all` affiche beaucoup de lignes (une « carte réseau » par bloc). **Ne les lis pas toutes.** Cherche le bloc qui s'appelle `Ethernet adapter Ethernet 0` et, dedans, **ces lignes seulement** :

```
   Connection-specific DNS Suffix  . : horizon.local
   DHCP Enabled. . . . . . . . . . . : Yes
   IPv4 Address. . . . . . . . . . . : 10.20.10.50(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 10.20.10.1
   DHCP Server . . . . . . . . . . . : 10.20.20.10
   DNS Servers . . . . . . . . . . . : 10.20.20.10
                                       10.20.20.53
```

Lecture, ligne par ligne :

| Ligne | Ce que ça veut dire |
|---|---|
| `IPv4 Address … 10.20.10.50` | L'adresse IP de ce poste |
| `Subnet Mask … 255.255.255.0` | Le « masque » : il indique que le sous-réseau est `10.20.10.x` |
| `Default Gateway … 10.20.10.1` | La **passerelle** : le routeur par lequel passe tout ce qui sort du sous-réseau |
| `DHCP Enabled … Yes` / `DHCP Server … 10.20.20.10` | Ces réglages **viennent du DHCP**, qui est `DC1` |
| `DNS Servers … 10.20.20.10, 10.20.20.53` | **Les deux serveurs DNS** que le poste interrogera, **dans cet ordre** : d'abord `DC1`, puis `DNS-RES` s'il ne répond pas |
| `Connection-specific DNS Suffix … horizon.local` | Un « suffixe » que le poste ajoutera aux noms courts (TP 6) |

### Partie C — Le DNS répond-il ?

**Étape 5 — Poser la première vraie question DNS.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName www.banquehorizon.com
```

```
Name     : www.banquehorizon.com
Type     : CNAME
TTL      : 3600
Section  : Answer
NameHost : web.banquehorizon.com

Name      : web.banquehorizon.com
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 203.0.113.20
```

`Resolve-DnsName` est l'outil Windows pour poser une question au DNS. Il renvoie **deux fiches** (voir § I.11) :

1. une fiche **CNAME** : `www.banquehorizon.com` est un alias de `web.banquehorizon.com` ;
2. une fiche **A** : `web.banquehorizon.com` a l'adresse `203.0.113.20`.

`TTL : 3600` veut dire « tu peux garder cette réponse en cache pendant 3 600 secondes ». `Section : Answer` : ces fiches sont la **réponse** à la question.

🆘 **Si ça ne marche pas.** `DNS name does not exist` ou `timed out` : DC1 ou DNS-RES ne répond pas. Attends dix secondes et relance ; si ça persiste, ré-importe le laboratoire.

**🧠 Ce que tu viens d'apprendre.**

- Le poste a reçu **deux serveurs DNS et un suffixe** dans la même distribution DHCP que son adresse. Le DNS d'un poste n'est presque jamais saisi à la main : il est **distribué**.
- L'ordre des serveurs compte : `10.20.20.10` (DC1) d'abord, `10.20.20.53` (DNS-RES) seulement si le premier ne répond pas.
- `www` n'est pas une machine : c'est un **alias** (CNAME) de `web`.
- Le laboratoire fonctionne : tu peux commencer à poser des questions.

---

# Partie III — Poser une question

Jusqu'ici, tu as **regardé** le DNS travailler en arrière-plan : `ping` et `getent hosts` ont traduit des noms sans que tu voies comment. Dans cette partie, tu vas **poser toi-même des questions au DNS** et lire ses réponses telles qu'elles sont, sans rien cacher.

**Pourquoi ne pas se contenter de `ping` ?** `ping` répond à la question « *cette machine est-elle joignable ?* ». Il ne dit pas ce que le DNS a répondu, ni qui l'a répondu, ni depuis combien de temps cette réponse est gardée. Pour dépanner un service de noms, il faut un outil qui montre **la réponse du DNS elle-même**.

Tu vas apprendre à manier trois outils :

| Outil | Sur quel poste | À quoi il sert |
|---|---|---|
| **`dig`** | Linux | L'outil de référence : il montre **toute** la réponse, sans la simplifier |
| **`nslookup`** | Windows (et Linux) | Plus ancien, plus court à lire, moins détaillé |
| **`Resolve-DnsName`** | PowerShell (Windows) | Le « `dig` de Windows » : il passe par le cache du poste |

Tu les utiliseras tous les trois jusqu'à la fin du tutoriel. Un quatrième outil, `rndc`, la télécommande des serveurs BIND, arrivera dans la Partie VI.

> 💡 **Astuce** — La sortie de `dig` paraît touffue la première fois. C'est normal. On ne la lit **jamais d'un bloc** : on la découpe en cinq morceaux et on lit un morceau à la fois. C'est exactement ce que fait le TP 2.

---

## III.1 🧪 TP 2 — Lire une réponse de `dig`

**🎯 Objectif.** Savoir lire, bloc par bloc, la réponse complète de `dig`. Tout le reste du tutoriel s'appuie sur cette lecture.

**Ce qu'il te faut.** Le laboratoire importé (§ 0.1) et un terminal ouvert sur `PC-CONSEILLER`. Durée : environ 25 minutes.

**Étape 1 — Poser la question.**

```
# sur PC-CONSEILLER
dig www.banquehorizon.com
```

`dig` est le nom de la commande. `www.banquehorizon.com` est son seul **argument** : le nom dont on veut connaître l'adresse (rappel : § 0.4, une commande est suivie de ses arguments).

Tu dois obtenir ceci :

```
; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> www.banquehorizon.com
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 44
;; flags: qr rd ra; QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 65494
;; QUESTION SECTION:
;www.banquehorizon.com.		IN	A

;; ANSWER SECTION:
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20

;; Query time: 0 msec
;; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)
;; WHEN: Wed Nov 04 11:05:30 UTC 2026
;; MSG SIZE  rcvd: 84
```

Trois valeurs seront **différentes chez toi**, et c'est normal : le numéro après `id:`, la date après `WHEN:` et parfois la durée après `Query time:`.

**N'essaie pas de tout comprendre maintenant.** Fais une seule chose : repère que la sortie est faite de **cinq paragraphes** séparés par des lignes vides ou par des titres.

**Étape 2 — Découper en cinq blocs.**

| N° | Bloc | Il commence par | Ce qu'il te dit |
|---|---|---|---|
| 1 | Le **bandeau** | `; <<>> DiG …` | Un rappel de ce que tu as tapé |
| 2 | L'**en-tête** | `;; Got answer:` | Comment l'échange s'est passé (succès ou erreur, combien de fiches reviennent) |
| 3 | La **question** | `;; QUESTION SECTION:` | Ce que `dig` a réellement demandé |
| 4 | La **réponse** | `;; ANSWER SECTION:` | Ce que le DNS a répondu : les fiches |
| 5 | Le **pied** | `;; Query time:` | **Qui** a répondu, en combien de temps, quelle taille |

Le bloc 1 (le bandeau) ne contient rien à apprendre : il répète la commande que tu viens de taper et ses options. On lit les quatre autres **dans l'ordre 3, 4, 2, 5** : d'abord ce qu'on a demandé, puis ce qu'on a reçu, puis si ça s'est bien passé, puis qui a répondu. Suis le guide.

**Étape 3 — Lire le bloc 3 : la question.**

Voici la partie concernée :

```
;; QUESTION SECTION:
;www.banquehorizon.com.		IN	A
```

Elle te redit ce que tu as demandé, en trois morceaux :

- `;www.banquehorizon.com.` : le nom. Le point final est celui de la **racine** de l'arbre (§ I.5) : `dig` écrit toujours le nom complet.
- `IN` : la *classe*. C'est toujours `IN` (« Internet »). Tu peux l'ignorer.
- `A` : le *type* de fiche demandé. `A` veut dire « donne-moi l'**adresse** IPv4 ». C'est le type par défaut quand tu n'en précises pas.

Le `;` au début de la ligne signifie « commentaire » pour `dig` : c'est une ligne qui explique, pas une donnée. Toutes les lignes qui commencent par `;` sont des commentaires.

**Étape 4 — Lire le bloc 4 : la réponse.**

C'est le cœur de la sortie :

```
;; ANSWER SECTION:
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
```

Ce sont **deux fiches**, une par ligne. Chaque fiche a cinq colonnes, séparées par des espaces ou des tabulations. Voici la première décomposée :

| Colonne | Valeur de la 1re fiche | Ce que ça veut dire |
|---|---|---|
| Nom | `www.banquehorizon.com.` | Le nom auquel la fiche s'applique |
| TTL | `3600` | Combien de **secondes** cette réponse peut être gardée en cache (§ I.10) : 3 600 s, soit une heure |
| Classe | `IN` | Toujours `IN` |
| Type | `CNAME` | Le genre de fiche : ici un **alias** |
| Donnée | `web.banquehorizon.com.` | Le contenu de la fiche |

Lis maintenant les deux lignes **comme deux phrases** :

1. « `www.banquehorizon.com` est un *alias* de `web.banquehorizon.com` » (type `CNAME`) ;
2. « `web.banquehorizon.com` a l'adresse `203.0.113.20` » (type `A`).

Tu avais demandé l'adresse de `www`. Le DNS t'a répondu en deux temps : il t'a d'abord dit que `www` n'est qu'un autre nom pour `web`, puis il t'a donné l'adresse de `web`. C'est l'adresse que `ping` utiliserait.

**Étape 5 — Lire le bloc 2 : l'en-tête.**

C'est le bloc le plus dense, donc on le prend ligne par ligne.

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 44
;; flags: qr rd ra; QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 1
```

*La ligne `status`.*

- `opcode: QUERY` : le message est une **question** ordinaire. Tu peux l'ignorer.
- `status: NOERROR` : **le code de retour**. `NOERROR` veut dire « aucune erreur, j'ai traité ta question ». C'est le mot à chercher en premier dans toute sortie de `dig`. Tu en rencontreras d'autres :

| Code | Sens | Quand tu le vois |
|---|---|---|
| `NOERROR` | Pas d'erreur | La question a été traitée (la réponse peut quand même être vide, voir le TP 13) |
| `NXDOMAIN` | Ce nom **n'existe pas** | Tu as demandé un nom inconnu (étape 7 du TP 3) |
| `SERVFAIL` | Le serveur **n'a pas réussi** à répondre | Un serveur en amont est en panne (TP 26) |
| `REFUSED` | Le serveur **refuse** de te répondre | Il n'a pas le droit de te servir (TP 9) |

- `id: 44` : le **numéro de la question**. Il sert à associer une réponse à sa question. Il change à chaque exécution, ne le retiens pas.

*La ligne `flags`.* Les **drapeaux** sont de petits interrupteurs, chacun désigné par deux lettres :

| Drapeau | Mot anglais | Sens |
|---|---|---|
| `qr` | *query response* | Ce message est une **réponse** (et non une question) |
| `rd` | *recursion desired* | Tu as **demandé** la récursion : « fais tout le chemin pour moi » |
| `ra` | *recursion available* | Le serveur **offre** la récursion |
| `aa` | *authoritative answer* | Celui qui répond **fait autorité** sur cette zone (absent ici) |

Ici : `qr rd ra`. Tu lis : « c'est une réponse, tu avais demandé la récursion, le serveur sait la faire ». **Il n'y a pas `aa`** : celui qui t'a répondu n'est donc pas le serveur qui détient la zone, il a appris la réponse ailleurs. Garde ce point : tu le retrouveras avec le drapeau `aa` à l'étape 6 du TP 3.

*Les compteurs* `QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 1`. Ils annoncent combien de fiches contient chaque section : 1 question, 2 fiches de réponse (le CNAME et le A), 0 fiche d'autorité, 1 fiche supplémentaire.

Cette « fiche supplémentaire » n'en est pas vraiment une : c'est le décompte d'un champ technique appelé **OPT** (une extension du protocole, EDNS), décrit par les deux lignes suivantes :

```
;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 65494
```

`udp: 65494` annonce la taille maximale des réponses que ce client sait recevoir. **Ignore ces deux lignes** pour l'instant, elles n'ont d'importance qu'au TP 32.

**Étape 6 — Lire le bloc 5 : le pied.**

```
;; Query time: 0 msec
;; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)
;; WHEN: Wed Nov 04 11:05:30 UTC 2026
;; MSG SIZE  rcvd: 84
```

| Ligne | Ce qu'elle dit |
|---|---|
| `Query time: 0 msec` | La durée de l'échange, en millisecondes. Le simulateur est instantané ; sur un vrai réseau, on lit quelques millisecondes |
| `SERVER: 127.0.0.53#53(127.0.0.53) (UDP)` | **À qui `dig` a parlé** : l'adresse `127.0.0.53`, le port `53` (le port du DNS), en `UDP` (un mode d'envoi léger, voir le TP 32) |
| `WHEN: …` | La date de la question (celle de ta machine) |
| `MSG SIZE rcvd: 84` | La taille de la réponse reçue, en octets |

**Remarque la ligne `SERVER`.** `dig` n'a **pas** parlé à `DNS-RES` (`10.20.20.53`) ni à `DC1` (`10.20.20.10`) : il a parlé à `127.0.0.53`, une adresse qui désigne **la machine elle-même**. Un petit programme installé sur `PC-CONSEILLER` écoute là et relaie les questions. Le TP 5 explique pourquoi.

**Étape 7 — Les trois réflexes.** Retiens l'ordre dans lequel un administrateur lit une sortie de `dig` :

1. **`status`** : y a-t-il une erreur ? (`NOERROR` : non.)
2. **`ANSWER SECTION`** : qu'est-ce que le DNS a répondu ? Y a-t-il des fiches ?
3. **`SERVER` et `flags`** : qui m'a répondu, et fait-il autorité (`aa`) ou répond-il depuis un cache ?

🆘 **Si ça ne marche pas.**

- `connection timed out; no servers could be reached` : aucun serveur DNS n'a répondu. Refais le TP 1 (le laboratoire est peut-être mal importé).
- Tu lis `status: NXDOMAIN` : tu as sans doute fait une faute de frappe dans le nom.
- Le `id`, la date et la durée sont différents de ceux du document : c'est normal.

**🧠 Ce que tu viens d'apprendre.**

- Une réponse `dig` n'est pas « une adresse » : c'est un **message** composé d'un en-tête (code de retour, drapeaux, compteurs) et de sections (question, réponse, …).
- Une fiche a toujours la forme **nom, TTL, classe, type, donnée**.
- Les deux lignes à regarder en premier sont `status:` (est-ce que ça a marché ?) et `SERVER:` (à qui ai-je parlé ?).
- Le drapeau `aa` dit si celui qui répond détient la zone (autorité) ou répond depuis un cache.

**Vérifie-toi.**

1. Quelle colonne d'une fiche donne la durée de cache ?
2. Que veut dire `status: NXDOMAIN` ?
3. Sur la sortie ci-dessus, le serveur qui a répondu fait-il autorité ? Comment le sais-tu ?

*Réponses.* (1) La colonne **TTL**, en secondes. (2) Le nom demandé n'existe pas. (3) Non : le drapeau `aa` est absent de la ligne `flags`.

---

## III.2 🧪 TP 3 — Choisir ce que `dig` affiche

**🎯 Objectif.** Ne voir que ce qui t'intéresse, choisir **à quel serveur** tu poses la question, et reconnaître la réponse d'une autorité.

**Ce qu'il te faut.** Le TP 2 terminé, un terminal sur `PC-CONSEILLER`. Durée : environ 35 minutes.

**Étape 1 — La version courte : `+short`.**

```
# sur PC-CONSEILLER
dig www.banquehorizon.com +short
```

`+short` est une **option** de `dig`. Les options de `dig` commencent par un `+` et se placent après le nom. Celle-ci dit : « ne me donne que les données, sans rien d'autre ».

```
web.banquehorizon.com.
203.0.113.20
```

Tu retrouves les deux données de la réponse du TP 2 : le nom canonique (la cible de l'alias), puis l'adresse. Plus de TTL, plus de type, plus d'en-tête : c'est pratique pour récupérer une valeur, mais tu perds les informations utiles au diagnostic.

**Étape 2 — Éteindre tout, rallumer ce qu'on veut : `+noall +answer`.**

Pense à un tableau de bord avec des interrupteurs. Chaque morceau de la sortie de `dig` est un interrupteur que tu peux allumer (`+nom`) ou éteindre (`+nonom`). Deux interrupteurs sont particulièrement utiles :

- `+noall` éteint **tous** les morceaux d'un coup ;
- `+answer` rallume **uniquement** la section de réponse.

```
# sur PC-CONSEILLER
dig www.banquehorizon.com +noall +answer
```

```
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
```

Voilà la section réponse seule, **avec** les TTL et les types. C'est la forme que l'on utilise le plus souvent.

Les interrupteurs que tu viendras allumer sont :

| Option | Ce qu'elle rallume |
|---|---|
| `+question` | La section question |
| `+answer` | La section réponse |
| `+authority` | La section autorité (les serveurs de la zone) |
| `+additional` | La section supplémentaire (adresses utiles) |
| `+comments` | L'en-tête (`status`, `flags`, compteurs) |
| `+stats` | Le pied (durée, serveur, date, taille) |
| `+cmd` | Le bandeau du début |

**Étape 3 — Ajouter le pied : `+stats`.**

```
# sur PC-CONSEILLER
dig www.banquehorizon.com +noall +answer +stats
```

```
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
;; Query time: 0 msec
;; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)
;; WHEN: Wed Nov 04 11:05:30 UTC 2026
;; MSG SIZE  rcvd: 84
```

Les deux premières lignes sont la réponse, les quatre suivantes sont le pied que tu connais (TP 2, étape 6). Remarque `SERVER: 127.0.0.53` : tu parles encore au petit programme local.

**Étape 4 — Choisir à qui on parle : `@serveur`.**

Par défaut, `dig` interroge le serveur que la machine a configuré (ici le programme local `127.0.0.53`). Tu peux imposer un autre serveur en écrivant son adresse **précédée d'un `@`**. Tu vas interroger directement `DNS-RES`, le résolveur de l'agence :

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.banquehorizon.com +noall +answer +stats
```

```
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
;; Query time: 0 msec
;; SERVER: 10.20.20.53#53(10.20.20.53) (UDP)
;; WHEN: Wed Nov 04 20:12:19 UTC 2026
;; MSG SIZE  rcvd: 152
```

Compare avec l'étape 3 : **la réponse est la même** (le même alias, la même adresse), mais la ligne `SERVER` a changé. Elle dit maintenant `10.20.20.53` : c'est bien `DNS-RES` qui t'a répondu, sans passer par le programme local. La taille du message change aussi (152 octets au lieu de 84), ce qui montre que ce n'est pas le même interlocuteur qui a rédigé la réponse.

La forme générale est donc :

```schema
dig @serveur  nom  [type]  [+options]
```

**Étape 5 — Choisir le type de fiche.**

Jusqu'ici tu as demandé des fiches de type `A` (les adresses). Le type se place **après le nom**. Pour savoir qui reçoit le courrier de la banque, tu demandes les fiches `MX` (*mail exchanger*, « serveur de messagerie »). Et tu interroges cette fois `NS1-BANK` (`203.0.113.10`), le serveur qui détient la zone `banquehorizon.com` :

```
# sur PC-CONSEILLER
dig @203.0.113.10 banquehorizon.com MX +noall +answer
```

```
banquehorizon.com.	3600	IN	MX	10 mail.banquehorizon.com.
banquehorizon.com.	3600	IN	MX	20 mail2.banquehorizon.com.
```

Chaque ligne se lit : « pour le courrier de `banquehorizon.com`, le serveur de messagerie est `mail.banquehorizon.com`, avec la **préférence** `10` » (et `mail2` avec la préférence `20`). **Le plus petit nombre est essayé en premier** : `mail` est le serveur principal, `mail2` est le secours (§ I.11, détaillé au TP 11).

> 💡 L'ordre des deux lignes peut être inversé chez toi : le serveur fait tourner les fiches d'un même ensemble pour répartir la charge. Ce n'est **pas** l'ordre qui compte, c'est le nombre de préférence.

**Étape 6 — Parler à une autorité : `+norecurse`.**

Dans le TP 2, le drapeau `rd` était présent : tu **demandais** la récursion. Quand tu interroges l'autorité de la zone, tu n'en as pas besoin. Tu peux l'éteindre avec `+norecurse` (le préfixe `no` éteint toujours une option). Tu vas aussi rallumer l'en-tête et les sections autorité et supplémentaire pour tout voir :

```
# sur PC-CONSEILLER
dig @203.0.113.10 banquehorizon.com MX +norecurse +noall +comments +answer +authority +additional
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 60
;; flags: qr aa; QUERY: 1, ANSWER: 2, AUTHORITY: 2, ADDITIONAL: 5

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; ANSWER SECTION:
banquehorizon.com.	3600	IN	MX	20 mail2.banquehorizon.com.
banquehorizon.com.	3600	IN	MX	10 mail.banquehorizon.com.

;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	NS	ns1.banquehorizon.com.
banquehorizon.com.	3600	IN	NS	ns2.banquehorizon.com.

;; ADDITIONAL SECTION:
mail2.banquehorizon.com. 3600	IN	A	203.0.113.26
mail.banquehorizon.com.	3600	IN	A	203.0.113.25
ns1.banquehorizon.com.	3600	IN	A	203.0.113.10
ns2.banquehorizon.com.	3600	IN	A	203.0.113.11
```

Lis cette sortie par trois différences avec le TP 2 :

1. **`flags: qr aa`.** `aa` est là : cette fois, celui qui répond **fait autorité**. Il n'y a ni `rd` (tu ne l'as pas demandé) ni `ra` (une autorité n'offre pas de récursion).
2. **`AUTHORITY SECTION`.** Une autorité écrit à côté de la réponse **la liste des serveurs de la zone** : `ns1` et `ns2`. C'est comme une carte de visite.
3. **`ADDITIONAL SECTION`.** Elle écrit aussi **les adresses dont tu auras besoin ensuite** : celles des serveurs de messagerie qu'elle vient de te citer (`mail`, `mail2`) et celles des serveurs de la zone (`ns1`, `ns2`). Elle t'évite de poser quatre questions de plus.

`AUTHORITY: 2, ADDITIONAL: 5` : deux fiches d'autorité, et cinq en supplément, dont l'enregistrement technique `OPT` (étape 5 du TP 2) et les quatre adresses.

**Étape 7 — Une réponse qui dit « non ».**

Que répond le DNS à un nom qui n'existe pas ? Tu vas le voir.

```
# sur PC-CONSEILLER
dig nexiste.banquehorizon.com +noall +comments
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 61
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 65494
```

Trois choses à lire :

- **`status: NXDOMAIN`** : « ce nom n'existe pas ». Ce n'est **pas une panne** : c'est une réponse parfaitement valable, que le DNS donne volontiers.
- **`ANSWER: 0`** : aucune fiche, puisqu'il n'y a rien à donner.
- **`AUTHORITY: 1`** : le serveur a joint une fiche d'autorité (la fiche `SOA`, que tu liras au TP 14) qui permet au résolveur de retenir « ce nom n'existe pas » pendant un certain temps, pour ne pas reposer la question (TP 22).

**À toi de jouer.** Affiche **uniquement** les noms des serveurs de la zone `banquehorizon.com` (leur type est `NS`), en version courte, sans préciser de serveur.

<details>
<summary>Voir la solution</summary>

```
# sur PC-CONSEILLER
dig banquehorizon.com NS +short
```

```
ns1.banquehorizon.com.
ns2.banquehorizon.com.
```

On a mis le type `NS` après le nom, et `+short` pour ne garder que les données.

</details>

🆘 **Si ça ne marche pas.**

- `dig: couldn't get address for '…'` ou `status: SERVFAIL` : vérifie l'adresse après le `@` (pas d'espace entre le `@` et l'adresse).
- `connection timed out` en interrogeant `203.0.113.10` : ce serveur ne répond pas, ou le routeur de l'agence n'a pas fini d'apprendre ses routes. Relance `ping -c 1 203.0.113.10` (§ II.3) : tant qu'il échoue, `dig` échouera aussi.

**🧠 Ce que tu viens d'apprendre.**

- Les options de `dig` s'écrivent `+option` pour allumer, `+nooption` pour éteindre. **`+noall` puis ce qu'on veut** est la méthode la plus propre.
- `@adresse` choisit **à qui on parle** ; le mot placé après le nom (`MX`, `NS`, `A`…) choisit **le type de fiche**.
- Une **autorité** (`aa`) répond avec les serveurs de la zone (`AUTHORITY`) et des adresses utiles (`ADDITIONAL`), sans offrir de récursion.
- `NXDOMAIN` est une réponse, pas une panne : elle dit « ce nom n'existe pas ».

**Vérifie-toi.**

1. Quelle option montre uniquement l'en-tête et la réponse ?
2. Comment demander à `DNS-RES` (`10.20.20.53`) l'adresse de `www.banquehorizon.com` ?
3. Qu'est-ce qui distingue, dans `flags`, la réponse d'une autorité de celle d'un résolveur ?

*Réponses.* (1) `+noall +comments +answer`. (2) `dig @10.20.20.53 www.banquehorizon.com`. (3) Une autorité porte le drapeau `aa` ; un résolveur porte `ra` mais pas `aa`.

---

## III.3 🧪 TP 4 — Les mêmes questions côté Windows

**🎯 Objectif.** Poser les mêmes questions depuis un poste Windows, avec les deux outils que Windows met à ta disposition, et reconnaître ce que chacun ajoute.

**Ce qu'il te faut.** Un terminal PowerShell sur `PC-GUICHET1` (rappel : § 0.5, la ligne d'invite commence par `PS`). Durée : environ 25 minutes.

Windows n'a pas `dig`. Il a `nslookup`, un outil très ancien qui existe aussi sous Linux, et `Resolve-DnsName`, l'outil moderne de PowerShell.

**Étape 1 — `nslookup` : la question la plus simple.**

```powershell
# sur PC-GUICHET1
nslookup www.banquehorizon.com
```

```
Server:  dc1.horizon.local
Address:  10.20.20.10

Non-authoritative answer:
Name:    web.banquehorizon.com
Address:  203.0.113.20
Aliases:  www.banquehorizon.com
```

Lis ces sept lignes en deux paragraphes :

- **`Server:` et `Address:`** : *à qui* `nslookup` a posé la question. C'est `DC1`, le premier serveur DNS que le DHCP a donné au poste (§ II.3, partie B).
- **`Non-authoritative answer:`** : « réponse **non faisant autorité** ». Elle veut dire que `DC1` n'est pas le serveur qui détient la zone `banquehorizon.com` : il l'a apprise ailleurs. Ce n'est pas un défaut.
- **`Name:` / `Address:` / `Aliases:`** : le résultat. `nslookup` te dit que le nom réel est `web.banquehorizon.com`, son adresse est `203.0.113.20`, et que `www.banquehorizon.com` en est un alias.

`nslookup` fait donc le même travail que `dig`, mais il **résume** : tu ne vois ni les TTL, ni les drapeaux.

**Étape 2 — Demander un type de fiche : `-type=`.**

Sous `nslookup`, une option s'écrit avec un tiret et non avec un plus.

```powershell
# sur PC-GUICHET1
nslookup -type=MX banquehorizon.com
```

```
Server:  dc1.horizon.local
Address:  10.20.20.10

Non-authoritative answer:
banquehorizon.com	MX preference = 10, mail exchanger = mail.banquehorizon.com
banquehorizon.com	MX preference = 20, mail exchanger = mail2.banquehorizon.com
```

Même lecture que le TP 3, étape 5 : deux serveurs de messagerie, `mail` avec la préférence 10, `mail2` avec la préférence 20. L'ordre d'affichage peut varier, seul le nombre de préférence compte.

**Étape 3 — Choisir le serveur : un deuxième argument.**

Pour interroger un serveur précis, on l'écrit **à la fin**, sans `@`.

```powershell
# sur PC-GUICHET1
nslookup www.banquehorizon.com 10.20.20.53
```

```
Server:  UnKnown
Address:  10.20.20.53

Non-authoritative answer:
Name:    web.banquehorizon.com
Address:  203.0.113.20
Aliases:  www.banquehorizon.com
```

La réponse est identique, mais la première ligne change : `Server:  UnKnown`. **Ce n'est pas une erreur.** Avant de poser ta question, `nslookup` essaie de retrouver le *nom* du serveur à partir de son adresse (c'est le « DNS inverse », que tu verras au TP 12). `DC1` a un nom déclaré dans l'annuaire (`dc1.horizon.local`), pas `DNS-RES` : `nslookup` écrit alors `UnKnown` (« inconnu »). L'adresse en dessous (`10.20.20.53`) prouve que c'est bien lui qui a répondu.

**Étape 4 — `Resolve-DnsName` : l'outil PowerShell.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName banquehorizon.com -Type MX
```

`Resolve-DnsName` est une *commande PowerShell* (une « cmdlet »). Son premier argument est le nom. Le mot `-Type` est un **paramètre** : un tiret, un nom, puis sa valeur (`MX`).

```
Name         : banquehorizon.com
Type         : MX
TTL          : 3600
Section      : Answer
NameExchange : mail.banquehorizon.com
Preference   : 10

Name         : banquehorizon.com
Type         : MX
TTL          : 3600
Section      : Answer
NameExchange : mail2.banquehorizon.com
Preference   : 20
```

Au lieu d'un texte, `Resolve-DnsName` rend **un petit tableau par fiche**, avec une ligne par champ : `Name` (le nom), `Type`, `TTL`, `Section`, puis les champs propres au type (`NameExchange` et `Preference` pour un MX). On y retrouve les mêmes informations que dans la réponse de `dig`, y compris le TTL.

**Comparaison des trois outils.**

| | `dig` (Linux) | `nslookup` (Windows) | `Resolve-DnsName` (Windows) |
|---|---|---|---|
| Montre l'en-tête et les drapeaux | oui | non | non |
| Montre le TTL | oui | non | oui |
| Choisir le serveur | `@serveur` | dernier argument | `-Server` |
| Choisir le type | `MX` après le nom | `-type=MX` | `-Type MX` |
| Interroge toujours un serveur | oui | oui | non : regarde d'abord le **cache du poste** (TP 23) |

🆘 **Si ça ne marche pas.**

- `nslookup` n'est pas reconnu : tu es dans un terminal Linux. Les commandes de ce TP se tapent sur `PC-GUICHET1`.
- `DNS request timed out` : le serveur interrogé ne répond pas. Refais le TP 1.

**🧠 Ce que tu viens d'apprendre.**

- `nslookup` **résume** : il sert pour un coup d'œil rapide. `dig` **détaille** : il sert pour comprendre.
- `Non-authoritative answer` veut dire « je ne suis pas le serveur qui détient la zone, je l'ai apprise d'un autre ».
- `Server: UnKnown` n'est pas une erreur : `nslookup` n'a simplement pas trouvé de nom pour l'adresse du serveur.
- `Resolve-DnsName` passe par le cache du poste, `nslookup` jamais.

---

## III.4 🧪 TP 5 — Qui est mon serveur DNS ?

**🎯 Objectif.** Savoir, sur chaque système, **à quel serveur DNS la machine pose ses questions**, et d'où elle le tient. C'est la première question de tout dépannage.

**Ce qu'il te faut.** Un terminal sur `PC-CONSEILLER` (Linux) et un autre sur `PC-GUICHET1` (Windows). Durée : environ 20 minutes.

Quand tu tapes un nom dans un navigateur, ta machine doit savoir **à qui** poser la question. Cette adresse est écrite quelque part. Il faut savoir la retrouver, car un serveur DNS mal configuré est l'une des causes de panne les plus fréquentes.

**Étape 1 — Sous Linux : le fichier `/etc/resolv.conf`.**

```
# sur PC-CONSEILLER
cat /etc/resolv.conf
```

`cat` affiche le contenu d'un fichier, ici le fichier de configuration du client DNS.

```
# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).
# Do not edit.

nameserver 127.0.0.53
search horizon.local
```

- Les deux premières lignes commencent par `#` : ce sont des **commentaires** (la machine les ignore). Elles signalent que le fichier est géré automatiquement, par `systemd-resolved`.
- `nameserver 127.0.0.53` : le serveur DNS de la machine. **Mais ce n'est pas un vrai serveur** : `127.0.0.53` est une adresse qui désigne la machine elle-même. Un petit programme y écoute ; on l'appelle le **stub** (§ I.8).
- `search horizon.local` : le *suffixe de recherche* (TP 6).

Pourquoi ce détour ? Parce que les vrais serveurs changent : le DHCP peut en donner de nouveaux à chaque connexion. Plutôt que de réécrire un fichier, le système laisse **le stub** les connaître et garde le fichier immuable. Le stub a un autre avantage : il garde en cache les réponses du poste (TP 21).

```schema
application  ──►  stub 127.0.0.53  ──►  DC1 10.20.20.10      (d'abord)
(dig, ping)       (sur le poste)        DNS-RES 10.20.20.53  (si DC1 ne répond pas)
```

**Étape 2 — Retrouver les vrais serveurs : `resolvectl status`.**

```
# sur PC-CONSEILLER
resolvectl status
```

`resolvectl` est la télécommande du stub. Sa sortie est longue, mais **trois lignes** seulement t'intéressent, dans le bloc `Link 2 (eth0)` :

```
Global
       LLMNR setting: yes
MulticastDNS setting: no
  DNSOverTLS setting: no
      DNSSEC setting: allow-downgrade
resolv.conf mode: stub

Link 2 (eth0)
       LLMNR setting: yes
MulticastDNS setting: no
  DNSOverTLS setting: no
      DNSSEC setting: allow-downgrade
  Current DNS Server: 10.20.20.10
         DNS Servers: 10.20.20.10 10.20.20.53
          DNS Domain: horizon.local
```

- `Current DNS Server: 10.20.20.10` : le serveur qui a répondu en dernier (`DC1`).
- `DNS Servers: 10.20.20.10 10.20.20.53` : la **liste** des serveurs, dans l'ordre où on les essaie. C'est le DHCP qui l'a fournie (§ II.3, partie B).
- `DNS Domain: horizon.local` : le suffixe de recherche.

**Étape 3 — Sous Windows : `Get-DnsClientServerAddress`.**

Il n'y a pas de stub sous Windows : le client DNS (le service `Dnscache`) lit directement les adresses de la carte réseau.

```powershell
# sur PC-GUICHET1
Get-DnsClientServerAddress -InterfaceAlias "Ethernet 0"
```

Le nom d'une commande PowerShell suit toujours la forme **Verbe-Nom** : `Get-` (obtenir) `DnsClientServerAddress` (les adresses des serveurs DNS du client). Le paramètre `-InterfaceAlias` choisit la carte réseau, ici `Ethernet 0`, celle qui est branchée au réseau.

```
InterfaceAlias InterfaceIndex AddressFamily ServerAddresses           
-------------- -------------- ------------- ---------------           
Ethernet 0                  2 IPv4          {10.20.20.10, 10.20.20.53}
Ethernet 0                  2 IPv6          {}                        
```

La ligne `IPv4` donne les deux serveurs, dans l'ordre : `DC1` d'abord, puis `DNS-RES`. La ligne `IPv6` est vide : aucun serveur DNS n'est configuré pour IPv6.

**Étape 4 — Le suffixe de la carte : `Get-DnsClient`.**

```powershell
# sur PC-GUICHET1
Get-DnsClient
```

```
InterfaceAlias InterfaceIndex ConnectionSpecificSuffix ConnectionSpecificSuffixSearchList RegisterThisConnectionsAddress UseSuffixWhenRegistering
-------------- -------------- ------------------------ ---------------------------------- ------------------------------ ------------------------
Ethernet 0                  2 horizon.local            {}                                 True                           False                   
Ethernet 1                  3                          {}                                 True                           False                   
Ethernet 2                  4                          {}                                 True                           False                   
Ethernet 3                  5                          {}                                 True                           False                   
```

Lis seulement la colonne `ConnectionSpecificSuffix`. La carte `Ethernet 0` porte `horizon.local` ; les trois autres cartes n'ont pas de suffixe, car elles ne sont reliées à rien.

> 🔍 **Point d'audit** — Que les serveurs DNS d'un poste viennent du DHCP est une bonne chose (un seul endroit à tenir à jour), **à condition que le serveur DHCP soit lui-même maîtrisé**. Un DHCP pirate qui distribue son propre « DNS » détourne toute la résolution du poste.

🆘 **Si ça ne marche pas.** Si `resolvectl status` affiche `DNS Servers` vide, le DHCP n'a pas répondu à `PC-CONSEILLER` : refais le TP 1.

**🧠 Ce que tu viens d'apprendre.**

- Sous Ubuntu, `/etc/resolv.conf` ne contient **pas** les vrais serveurs : il pointe vers le **stub** local `127.0.0.53`. Les vrais serveurs se lisent avec `resolvectl status`.
- Sous Windows, il n'y a pas de stub : `Get-DnsClientServerAddress` liste directement les serveurs de la carte.
- L'**ordre** des serveurs compte : le premier est essayé d'abord.
- La liste vient du DHCP, ce qui est pratique mais doit être protégé (point d'audit).

---

## III.5 🧪 TP 6 — Les suffixes de recherche

**🎯 Objectif.** Comprendre pourquoi taper `intranet` suffit, alors que le vrai nom est `intranet.horizon.local`.

**Ce qu'il te faut.** Un terminal sur `PC-GUICHET1` et un sur `PC-CONSEILLER`. Durée : environ 25 minutes.

Dans une entreprise, on ne tape pas `intranet.horizon.local` : on tape `intranet`, et ça marche. Il y a donc quelqu'un qui **complète le nom**. Qui ? Et pourquoi `dig` ne le fait-il pas ?

**Le principe.** Un nom **sans aucun point** est un nom *court*. Le poste lui **ajoute un suffixe** pris dans sa liste de recherche (celle que tu as vue au TP 5 : `horizon.local`), avant de poser la question. C'est **le poste qui complète, pas le serveur** : sur le fil, la question qui part est bien `intranet.horizon.local`.

**Étape 1 — Sous Windows.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName intranet
```

```
Name     : intranet.horizon.local
Type     : CNAME
TTL      : 3600
Section  : Answer
NameHost : dc1.horizon.local

Name      : dc1.horizon.local
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 10.20.20.10
```

Tu avais tapé `intranet` ; la fiche s'appelle `intranet.horizon.local`. Le poste a donc ajouté `horizon.local` tout seul. Tu vois aussi que `intranet` est un **alias** (`CNAME`) de `dc1.horizon.local`, dont l'adresse est `10.20.20.10`.

**Étape 2 — Sous Linux, comme une application.**

```
# sur PC-CONSEILLER
getent hosts intranet
```

`getent hosts` pose la question comme le ferait un programme (rappel : § I.9).

```
10.20.20.10     dc1.horizon.local intranet.horizon.local
```

Une ligne : l'adresse, puis le **nom canonique** (le vrai nom, `dc1.horizon.local`), puis l'alias que tu as suivi (`intranet.horizon.local`). L'application a complété le nom elle aussi.

**Étape 3 — Vérifier que c'est la même machine.**

```
# sur PC-CONSEILLER
getent hosts dc1.horizon.local
```

```
10.20.20.10     dc1.horizon.local
```

Même adresse, `10.20.20.10`. `intranet` n'est qu'un autre nom pour `DC1`.

**Étape 4 — `dig` avec le nom complet.**

```
# sur PC-CONSEILLER
dig intranet.horizon.local +short
```

```
dc1.horizon.local.
10.20.20.10
```

Avec le nom **complet**, `dig` répond sans surprise : le nom canonique, puis l'adresse.

**Étape 5 — `dig` avec le nom court : il ne complète pas.**

```
# sur PC-CONSEILLER
dig intranet +noall +comments +question
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 40
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 65494
;; QUESTION SECTION:
;intranet.			IN	A
```

`status: NXDOMAIN` : le nom n'existe pas. Regarde la section question : `dig` a demandé `intranet.` et non `intranet.horizon.local.`. Le point final désigne la racine, c'est-à-dire un nom **sans suffixe**. `dig` prend ce que tu écris à la lettre ; or aucun domaine nommé simplement `intranet` n'existe à la racine.

**Étape 6 — Demander à `dig` de compléter : `+search`.**

```
# sur PC-CONSEILLER
dig intranet +search +noall +comments +question +answer
```

L'option `+search` dit à `dig` : « lis la ligne `search` de `/etc/resolv.conf` (TP 5) et complète comme une application ».

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 53
;; flags: qr rd ra; QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 65494
;; QUESTION SECTION:
;intranet.horizon.local.		IN	A

;; ANSWER SECTION:
intranet.horizon.local.	3600	IN	CNAME	dc1.horizon.local.
dc1.horizon.local.	3600	IN	A	10.20.20.10
```

Cette fois, `NOERROR` : la question est devenue `intranet.horizon.local.` et la réponse est arrivée.

⚠️ **Attention** — Un suffixe automatique est pratique et **dangereux**. Si `intranet.horizon.local` n'existait pas, le poste pourrait essayer le suffixe suivant de sa liste, par exemple `intranet.com`. Un nom court mal tapé peut ainsi tomber sur le site d'un tiers. Réduis la liste des suffixes au strict nécessaire.

🆘 **Si ça ne marche pas.** À l'étape 6, `NXDOMAIN` malgré `+search` : le fichier `/etc/resolv.conf` n'a pas de ligne `search` (relis l'étape 1 du TP 5).

**🧠 Ce que tu viens d'apprendre.**

- Un nom **sans point** est complété par le **poste**, avec les suffixes de sa liste de recherche. Le serveur DNS ne voit que le nom complet.
- Les applications (`ping`, `getent`, `curl`) et `Resolve-DnsName` complètent. **`dig` ne complète pas** tant qu'on ne lui dit pas `+search`.
- C'est une différence classique entre « ce que voient les applications » et « ce que montre `dig` » : quand les deux se contredisent, pense d'abord au suffixe.

**Vérifie-toi.**

1. Quelle commande de la Partie III complète un nom court tout seul ? Laquelle ne le fait pas ?
2. Que contient la section question quand on tape `dig intranet` ?
3. Pourquoi une liste de suffixes trop longue est-elle dangereuse ?

*Réponses.* (1) `Resolve-DnsName`, `getent hosts` et `ping` complètent ; `dig` ne complète qu'avec `+search`. (2) `intranet.` : le nom tel quel, sous la racine. (3) Un nom court mal tapé peut aboutir chez un tiers, sur un domaine qui porte le nom complété par un des suffixes.

---

# Partie IV — Descendre l'arbre

Au § I.9, on t'a **raconté** comment un résolveur trouve une adresse en descendant l'arbre des noms : la racine, puis `com`, puis la banque. Dans cette partie, tu vas **le voir faire**, puis le faire toi-même, un pas à la fois.

Rappel du trajet, tel que tu vas l'observer :

```schema
 1. DNS-RES   10.20.20.53    « qui sont les serveurs racine ? »    →  a.root-servers.net
 2. ROOT-NS   198.51.100.1   « www.banquehorizon.com ? »           →  « pour com, demande à a.nic.com »
 3. TLD-NS    198.51.100.2   « www.banquehorizon.com ? »           →  « demande à ns1 ou ns2.banquehorizon.com »
 4. NS1-BANK  203.0.113.10   « www.banquehorizon.com ? »           →  la réponse : 203.0.113.20
```

Trois mots à avoir en tête (ils viennent de la Partie I) :

- un **renvoi** (en anglais *referral*) : un serveur qui ne connaît pas la réponse te dit **à qui demander ensuite** ;
- la **glue** : l'adresse du serveur vers lequel on te renvoie, donnée avec le renvoi pour t'éviter de la chercher ;
- une **autorité** : le serveur qui détient la zone et donne la réponse définitive.

---

## IV.1 🧪 TP 7 — `dig +trace` : refaire le travail du résolveur

**🎯 Objectif.** Voir, étape par étape, le chemin qui mène de la racine à la réponse.

**Ce qu'il te faut.** Le laboratoire importé et un terminal sur `PC-CONSEILLER`. Durée : environ 25 minutes.

**Étape 1 — Lancer la commande.**

```
# sur PC-CONSEILLER
dig +trace @10.20.20.53 www.banquehorizon.com
```

Deux nouveautés par rapport à la Partie III : l'option `+trace` (« montre-moi chaque étape de la descente »), et `@10.20.20.53` (c'est `DNS-RES` que tu prends pour point de départ, TP 3 étape 4). Cette fois, **c'est `dig` lui-même qui fait le travail du résolveur** : il interroge les serveurs l'un après l'autre.

```
; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> +trace @10.20.20.53 www.banquehorizon.com
; (1 server found)
;; global options: +cmd
.			86400	IN	NS	a.root-servers.net.
;; Received 48 bytes from 10.20.20.53#53(10.20.20.53) in 0 ms

com.			86400	IN	NS	a.nic.com.
a.nic.com.		86400	IN	A	198.51.100.2
;; Received 75 bytes from 198.51.100.1#53(198.51.100.1) in 0 ms

banquehorizon.com.	3600	IN	NS	ns1.banquehorizon.com.
banquehorizon.com.	3600	IN	NS	ns2.banquehorizon.com.
ns1.banquehorizon.com.	3600	IN	A	203.0.113.10
ns2.banquehorizon.com.	3600	IN	A	203.0.113.11
;; Received 107 bytes from 198.51.100.2#53(198.51.100.2) in 0 ms

www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
ns1.banquehorizon.com.	3600	IN	A	203.0.113.10
ns2.banquehorizon.com.	3600	IN	A	203.0.113.11
;; Received 141 bytes from 203.0.113.10#53(203.0.113.10) in 0 ms
```

**Étape 2 — Trouver la structure.** La sortie fait une vingtaine de lignes, mais elle est bien rangée : elle est faite de **quatre paragraphes** séparés par une ligne vide. Chaque paragraphe se termine par une ligne qui commence par `;; Received`. Cette ligne est la clé : elle te dit **quel serveur a fourni le paragraphe qui est au-dessus**. Lis toujours un paragraphe *avec* la ligne `Received` qui le suit.

**Étape 3 — Paragraphe 1 : où est la racine ?**

```
.			86400	IN	NS	a.root-servers.net.
;; Received 48 bytes from 10.20.20.53#53(10.20.20.53) in 0 ms
```

- `.` est la **racine** de l'arbre (le point tout seul, § I.5).
- `NS` est le type de fiche « serveur de noms » : cette ligne dit « les serveurs de la racine, c'est `a.root-servers.net` ».
- `86400` est le TTL : une journée.
- `Received … from 10.20.20.53` : cette liste vient de **`DNS-RES`**, que tu avais pris comme point de départ. Un résolveur connaît par cœur les serveurs de la racine (c'est son fichier d'*indices racine*). Rien n'est encore descendu dans l'arbre.

**Étape 4 — Paragraphe 2 : la racine renvoie vers `com`.**

```
com.			86400	IN	NS	a.nic.com.
a.nic.com.		86400	IN	A	198.51.100.2
;; Received 75 bytes from 198.51.100.1#53(198.51.100.1) in 0 ms
```

`dig` a maintenant interrogé le serveur racine : c'est l'adresse `198.51.100.1` de la dernière ligne, qui est `ROOT-NS`. La racine **ne connaît pas** `www.banquehorizon.com`, mais elle sait qui tient `com` : elle te renvoie vers `a.nic.com` (première ligne) et te donne son adresse, `198.51.100.2` (deuxième ligne, type `A`). C'est un **renvoi** avec sa **glue**.

**Étape 5 — Paragraphe 3 : `com` renvoie vers la banque.**

```
banquehorizon.com.	3600	IN	NS	ns1.banquehorizon.com.
banquehorizon.com.	3600	IN	NS	ns2.banquehorizon.com.
ns1.banquehorizon.com.	3600	IN	A	203.0.113.10
ns2.banquehorizon.com.	3600	IN	A	203.0.113.11
;; Received 107 bytes from 198.51.100.2#53(198.51.100.2) in 0 ms
```

`dig` demande maintenant à `198.51.100.2` (c'est `TLD-NS`, qui tient la zone `com`). Lui non plus ne connaît pas `www`, mais il sait qui tient `banquehorizon.com` : les deux serveurs `ns1` et `ns2` de la banque (deux lignes `NS`), avec leurs adresses (deux lignes `A`, la glue).

**Étape 6 — Paragraphe 4 : la réponse.**

```
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
ns1.banquehorizon.com.	3600	IN	A	203.0.113.10
ns2.banquehorizon.com.	3600	IN	A	203.0.113.11
;; Received 141 bytes from 203.0.113.10#53(203.0.113.10) in 0 ms
```

`dig` demande enfin à `203.0.113.10`, c'est-à-dire `NS1-BANK`. Cette fois, ce serveur **détient** la zone : il répond. Les deux premières lignes sont la réponse que tu connais depuis le TP 2 (`www` est un alias de `web`, qui vaut `203.0.113.20`). Les deux dernières sont des compléments.

**Étape 7 — Résumé.** Voici les quatre sauts, avec la ligne `Received` qui prouve chacun :

| Saut | Serveur interrogé | Ce qu'il répond | Ce que ça veut dire |
|---|---|---|---|
| 1 | `DNS-RES` (10.20.20.53) | `. NS a.root-servers.net.` | La liste des serveurs de la racine |
| 2 | `ROOT-NS` (198.51.100.1) | `com. NS a.nic.com.` + son adresse | Un **renvoi** vers le serveur de `com` |
| 3 | `TLD-NS` (198.51.100.2) | `banquehorizon.com. NS ns1, ns2` + adresses | Un **renvoi** vers les serveurs de la banque |
| 4 | `NS1-BANK` (203.0.113.10) | `www CNAME web`, `web A 203.0.113.20` | **La réponse**, donnée par l'autorité |

> 💡 **Astuce** — `+trace` **ignore tous les caches** : il refait toujours le chemin complet. C'est l'outil idéal pour savoir **où** une délégation est cassée : quand un serveur ne répond pas, le chemin s'arrête au saut fautif, et tu sais lequel.

🆘 **Si ça ne marche pas.** `;; communications error … timed out` à l'un des sauts : le serveur correspondant ne répond pas. Tente un `ping -c 1 -W 1` vers son adresse (§ II.3) pour savoir si c'est le réseau ou le serveur.

**🧠 Ce que tu viens d'apprendre.**

- Chaque saut descend d'un niveau dans l'arbre. Les trois premiers ne donnent **jamais la réponse** : ils donnent *l'adresse de la suite*.
- Seul le dernier serveur, qui est l'**autorité** de la zone, répond.
- C'est exactement ce que fait `DNS-RES` la première fois qu'on lui pose une question, sauf que lui **garde tout en cache** (TP 24).
- La ligne `Received … from X` te dit toujours **qui** a fourni un paragraphe.

**Vérifie-toi.**

1. Combien d'équipements différents ont répondu à `dig +trace` ?
2. Quel serveur a donné la réponse finale ? Comment le sais-tu ?

*Réponses.* (1) Quatre : `DNS-RES`, `ROOT-NS`, `TLD-NS`, `NS1-BANK`. (2) `NS1-BANK` (`203.0.113.10`), grâce à la ligne `Received` du dernier paragraphe ; c'est aussi le seul paragraphe qui contient la réponse (`www` et `web`).

---

## IV.2 🧪 TP 8 — Interroger chaque niveau : renvois et glue

**🎯 Objectif.** Poser **toi-même** la même question à `ROOT-NS`, à `TLD-NS`, puis à `NS1-BANK`, sans récursion, et voir un renvoi se transformer en réponse.

**Ce qu'il te faut.** Les TP 3 et 7. Deux terminaux : `ROOT-NS` (double-clic sur l'équipement, § 0.2) et `PC-CONSEILLER`. Durée : environ 30 minutes.

Au TP 7, `dig` jouait le rôle d'un résolveur. Ici c'est **toi** qui joues ce rôle : tu poses la question à un seul serveur, et tu lis ce qu'il te répond. Pour que le serveur ne cherche pas à t'aider en faisant le travail à ta place, tu ajoutes **`+norecurse`** (TP 3, étape 6).

**Étape 1 — Interroger la racine.** Ouvre un terminal sur `ROOT-NS`.

```
# sur ROOT-NS
dig @127.0.0.1 www.banquehorizon.com +norecurse +noall +comments +authority +additional
```

`127.0.0.1` est l'adresse **de la machine elle-même** (§ 0.4) : `ROOT-NS` s'interroge lui-même, il est le serveur racine.

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 74
;; flags: qr; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 2

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; AUTHORITY SECTION:
com.			86400	IN	NS	a.nic.com.

;; ADDITIONAL SECTION:
a.nic.com.		86400	IN	A	198.51.100.2
```

Cherche trois signes dans cette sortie :

- **`ANSWER: 0`** (ligne `flags`) : aucune réponse à ta question.
- **Une fiche `NS` dans `AUTHORITY SECTION`** : `com. NS a.nic.com.`. Le serveur dit « demande à `a.nic.com` ».
- **Pas de `aa`** : `flags: qr` seulement. `ROOT-NS` ne fait pas autorité pour `banquehorizon.com`.

Ces trois signes, ensemble, définissent un **renvoi**. La section `ADDITIONAL` donne la glue : l'adresse de `a.nic.com`, `198.51.100.2`.

**Étape 2 — Interroger le serveur de `com`.** Sur `PC-CONSEILLER`, interroge l'adresse que la racine vient de te donner.

```
# sur PC-CONSEILLER
dig @198.51.100.2 www.banquehorizon.com +norecurse +noall +comments +authority +additional
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 75
;; flags: qr; QUERY: 1, ANSWER: 0, AUTHORITY: 2, ADDITIONAL: 3

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 4096
;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	NS	ns1.banquehorizon.com.
banquehorizon.com.	3600	IN	NS	ns2.banquehorizon.com.

;; ADDITIONAL SECTION:
ns1.banquehorizon.com.	3600	IN	A	203.0.113.10
ns2.banquehorizon.com.	3600	IN	A	203.0.113.11
```

Même schéma : `ANSWER: 0`, des `NS` en `AUTHORITY`, pas de `aa`. Cette fois le renvoi mène aux deux serveurs de la banque, `ns1` et `ns2`, avec leurs adresses en `ADDITIONAL`.

`TLD-NS` est un serveur **Windows**. Un détail le trahit : la ligne `udp: 4096` (un serveur BIND écrit `udp: 1232`). Cela ne change en rien le raisonnement.

**Étape 3 — Interroger la banque.**

```
# sur PC-CONSEILLER
dig @203.0.113.10 www.banquehorizon.com +norecurse +noall +comments +answer +authority +additional
```

On a ajouté `+answer` pour afficher la section réponse.

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 76
;; flags: qr aa; QUERY: 1, ANSWER: 2, AUTHORITY: 2, ADDITIONAL: 3

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; ANSWER SECTION:
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20

;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	NS	ns1.banquehorizon.com.
banquehorizon.com.	3600	IN	NS	ns2.banquehorizon.com.

;; ADDITIONAL SECTION:
ns1.banquehorizon.com.	3600	IN	A	203.0.113.10
ns2.banquehorizon.com.	3600	IN	A	203.0.113.11
```

Cette fois, trois signes inverses :

- **`flags: qr aa`** : le drapeau `aa` est là, `NS1-BANK` **fait autorité**.
- **`ANSWER: 2`** : la réponse est donnée (le `CNAME` puis le `A`).
- La section `AUTHORITY` n'est plus un renvoi : elle recopie simplement les serveurs de la zone.

**Comparaison des trois réponses.**

| Interrogé | `flags` | `ANSWER` | `AUTHORITY` | Verdict |
|---|---|---|---|---|
| `ROOT-NS` | `qr` | 0 | `NS` de `com` | **Renvoi** |
| `TLD-NS` | `qr` | 0 | `NS` de `banquehorizon.com` | **Renvoi** |
| `NS1-BANK` | `qr aa` | 2 | `NS` de la zone | **Réponse** |

**Pourquoi la glue ?** Regarde les deux serveurs de la banque : `ns1.banquehorizon.com` et `ns2.banquehorizon.com`. Leurs noms **se trouvent dans la zone qu'ils servent**. Si `TLD-NS` te disait seulement « demande à `ns1.banquehorizon.com` », il te faudrait connaître l'adresse de `ns1.banquehorizon.com`… en le demandant à `ns1.banquehorizon.com`. Impossible. La **glue** (les fiches `A` jointes au renvoi) rompt ce cercle.

> 🔍 **Point d'audit** — Une délégation dont la glue est fausse (une adresse périmée après un changement de serveur) est l'une des pannes DNS les plus sournoises : tout marche tant que le cache du résolveur est chaud, tout s'effondre à l'expiration. Vérifie la glue **chez le parent** (ici `TLD-NS`), pas chez toi.

🆘 **Si ça ne marche pas.** `connection timed out` à l'étape 2 : `PC-CONSEILLER` n'atteint pas `198.51.100.2`. Refais le `ping` du TP 1.

**🧠 Ce que tu viens d'apprendre.**

- Un **renvoi** se reconnaît à trois signes : `ANSWER: 0`, des `NS` dans `AUTHORITY`, **pas de `aa`**.
- La réponse définitive porte `aa` et une section `ANSWER` remplie.
- La **glue** n'est pas un luxe : sans elle, le résolveur devrait résoudre `ns1.banquehorizon.com` dans la zone qu'il cherche justement à joindre.
- Le `ADDITIONAL: 2` de `ROOT-NS` compte la glue **et** l'enregistrement technique `OPT` que `dig` envoie avec sa question (TP 2, étape 5).

**Vérifie-toi.**

1. Quels sont les trois signes d'un renvoi ?
2. Pourquoi les serveurs de la banque ont-ils besoin d'une glue ?

*Réponses.* (1) `ANSWER: 0`, des `NS` en `AUTHORITY`, pas de `aa`. (2) Leurs noms sont dans la zone qu'ils servent : sans leurs adresses fournies avec le renvoi, on ne pourrait pas les joindre.

---

## IV.3 🧪 TP 9 — Le bit de récursion

**🎯 Objectif.** Voir la différence entre trois comportements : un serveur qui **fait la récursion** (`DNS-RES`), un serveur qui **ne la fait pas** (`TLD-NS`) et un serveur qui **refuse** de répondre (`NS1-BANK` hors de sa zone).

**Ce qu'il te faut.** Un terminal sur `DNS-RES` (double-clic sur l'équipement) et un sur `PC-CONSEILLER`. Durée : environ 30 minutes.

Rappel (TP 2, étape 5) : le drapeau **`rd`** dit « *je demande* la récursion » (de ta part), et **`ra`** dit « *je l'offre* » (de la part du serveur). La **récursion**, c'est faire tout le chemin du TP 7 à la place de celui qui demande. Seul un **résolveur** doit la faire.

**Étape 1 — Vider le cache de `DNS-RES`.** Pour que l'expérience soit propre, on part d'un résolveur qui n'a rien appris.

```
# sur DNS-RES
sudo rndc flush
```

`sudo` exécute une commande avec les droits d'administrateur. `rndc` est la télécommande de `named`, le logiciel DNS de ce serveur ; `flush` veut dire « vide ton cache ». La commande n'affiche rien : sur Linux, **le silence veut dire que ça a marché**.

**Étape 2 — Interdire la récursion à un résolveur vide.**

```
# sur DNS-RES
dig @127.0.0.1 www.banquehorizon.com +norecurse +noall +comments +authority +additional
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 77
;; flags: qr ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; AUTHORITY SECTION:
.			3600000	IN	NS	a.root-servers.net.
```

`DNS-RES` n'a rien en cache, et tu lui interdis de chercher (`+norecurse`). Il ne peut que te dire par où il **commencerait** : la section `AUTHORITY` donne le serveur racine (le TTL très long, `3600000`, vient de son fichier d'indices). Remarque `flags: qr ra` : `ra`, il **offre** la récursion, mais tu ne l'as pas demandée, donc il ne la fait pas.

**Étape 3 — Autoriser la récursion.**

```
# sur DNS-RES
dig @127.0.0.1 www.banquehorizon.com +noall +comments +answer
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 78
;; flags: qr rd ra; QUERY: 1, ANSWER: 2, AUTHORITY: 2, ADDITIONAL: 3

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; ANSWER SECTION:
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
```

Cette fois il a fait tout le chemin du TP 7 et il répond. Les drapeaux sont `qr rd ra` : tu as demandé (`rd`), il offre (`ra`). Remarque aussi les compteurs : `AUTHORITY: 2, ADDITIONAL: 3`. Un résolveur BIND recopie, à côté de la réponse, les serveurs de la zone et leur glue, même si ta commande n'a affiché que la section `ANSWER`.

**Étape 4 — Redemander sans récursion.**

```
# sur DNS-RES
dig @127.0.0.1 www.banquehorizon.com +norecurse +noall +comments +answer
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 79
;; flags: qr ra; QUERY: 1, ANSWER: 2, AUTHORITY: 2, ADDITIONAL: 3

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; ANSWER SECTION:
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
```

Même interdiction qu'à l'étape 2, mais **la réponse est complète**. `DNS-RES` n'a rien eu à demander : il avait **gardé** la réponse en cache à l'étape 3. Voilà le cache à l'œuvre (§ I.10).

**Étape 5 — Un serveur qui ne fait pas la récursion.** Sur `PC-CONSEILLER`, demande à `TLD-NS` (le serveur Windows de `com`) de faire le travail pour toi :

```
# sur PC-CONSEILLER
dig @198.51.100.2 www.banquehorizon.com
```

```
; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> @198.51.100.2 www.banquehorizon.com
; (1 server found)
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 80
;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 2, ADDITIONAL: 3
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 4096
;; QUESTION SECTION:
;www.banquehorizon.com.		IN	A

;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	NS	ns1.banquehorizon.com.
banquehorizon.com.	3600	IN	NS	ns2.banquehorizon.com.

;; ADDITIONAL SECTION:
ns1.banquehorizon.com.	3600	IN	A	203.0.113.10
ns2.banquehorizon.com.	3600	IN	A	203.0.113.11

;; Query time: 0 msec
;; SERVER: 198.51.100.2#53(198.51.100.2) (UDP)
;; WHEN: Wed Nov 04 11:05:30 UTC 2026
;; MSG SIZE  rcvd: 118
```

Trois lignes sont à lire :

- `flags: qr rd` : tu as demandé la récursion (`rd`), mais **il n'y a pas de `ra`** : `TLD-NS` ne l'offre pas.
- `;; WARNING: recursion requested but not available` : `dig` te le dit en clair.
- Il te renvoie quand même (`ANSWER: 0`, des `NS` en `AUTHORITY`) : comme à l'étape 2 du TP 8, c'est un renvoi.

**Étape 6 — Un serveur qui refuse.** `NS1-BANK` fait autorité pour `banquehorizon.com` seulement. Pose-lui une question hors de sa zone :

```
# sur PC-CONSEILLER
dig @203.0.113.10 google.com
```

```
; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> @203.0.113.10 google.com
; (1 server found)
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: REFUSED, id: 92
;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; QUESTION SECTION:
;google.com.			IN	A

;; Query time: 0 msec
;; SERVER: 203.0.113.10#53(203.0.113.10) (UDP)
;; WHEN: Wed Nov 04 11:05:45 UTC 2026
;; MSG SIZE  rcvd: 39
```

`status: REFUSED` : « ce n'est pas mon rayon, et je ne fais pas la récursion pour toi ». Il n'a même pas essayé de t'aider (`ANSWER: 0`, `AUTHORITY: 0`).

**Résumé des cas.**

| Situation | Signe dans la réponse |
|---|---|
| Le serveur **offre** la récursion | `ra` dans les drapeaux |
| Le serveur **n'offre pas** la récursion et tu l'as demandée | `WARNING: recursion requested but not available` |
| Le serveur est **autorité** de la zone | `aa` |
| Le serveur **refuse** (hors de sa zone, sans récursion) | `status: REFUSED` |
| Le serveur ne sait pas mais te met sur la voie | `ANSWER: 0` + `NS` en `AUTHORITY` (un **renvoi**) |

> 🔍 **Point d'audit** — Ce `REFUSED` est un **bon** signe : `NS1-BANK`, serveur faisant autorité de la banque, ne doit jamais faire la récursion pour le compte d'inconnus. S'il répondait `NOERROR` à `google.com`, ce serait un *résolveur ouvert*, exploitable pour des attaques par amplification. C'est le premier test du TP 35.

🆘 **Si ça ne marche pas.** À l'étape 4, `ANSWER: 0` : tu as sauté l'étape 3, ou `DNS-RES` a vu son cache vidé entre-temps. Refais les étapes 3 et 4 dans l'ordre.

**🧠 Ce que tu viens d'apprendre.**

- `rd` est une **demande** du client, `ra` est une **offre** du serveur. Un résolveur offre (`ra`), une autorité pure non.
- Sans récursion, un résolveur ne sait répondre que depuis son **cache** ; avec, il refait le chemin.
- Un serveur d'autorité qui répond `REFUSED` à une question hors de sa zone se comporte **correctement**.

**Vérifie-toi.**

1. Que signifie `rd` ? Qui l'envoie ?
2. Que signifie `ra` ? Qui l'envoie ?
3. `NS1-BANK` répond `REFUSED` à `google.com` : est-ce une panne ?

*Réponses.* (1) « Recursion desired » : c'est le client qui l'envoie, pour demander au serveur de faire tout le chemin. (2) « Recursion available » : c'est le serveur qui l'envoie, pour dire qu'il sait le faire. (3) Non, c'est le comportement attendu d'un serveur d'autorité.

---

# Partie V — Les enregistrements

Au TP 2, tu as appris qu'une fiche de l'annuaire a toujours la même forme : **nom, TTL, classe, type, donnée**. Dans cette partie, tu vas t'intéresser à la quatrième colonne, le **type**. C'est lui qui donne son sens à la donnée : une adresse, un autre nom, un serveur de messagerie, un texte…

Voici les types que tu vas manipuler. Tu en connais déjà certains.

| Type | Ce que contient la fiche | Question à laquelle elle répond | Vu au |
|---|---|---|---|
| **A** | Une adresse IPv4 | « Quelle est l'adresse de ce nom ? » | TP 2 |
| **AAAA** | Une adresse IPv6 | La même question, pour IPv6 | TP 10 |
| **CNAME** | Un autre nom | « Ce nom est-il un alias ? De quoi ? » | TP 2, TP 10 |
| **NS** | Un serveur de la zone | « Qui détient cette zone ? » | TP 3, TP 11 |
| **MX** | Un serveur de messagerie et sa préférence | « Où livrer le courrier de ce domaine ? » | TP 3, TP 11 |
| **TXT** | Un texte libre (règles anti-usurpation) | « Quelles règles ce domaine publie-t-il ? » | TP 11 |
| **SRV** | Un serveur **et un port** pour un service | « Où se trouve ce service ? » | TP 11 |
| **SOA** | La fiche d'identité de la zone | « Comment cette zone est-elle gérée ? » | TP 11 |
| **PTR** | Un nom, rattaché à une adresse | « Quel est le nom de cette adresse ? » | TP 12 |

Chaque TP de cette partie pose les mêmes questions avec les **deux familles d'outils** : `dig` sur Linux, `Resolve-DnsName` sur Windows. La réponse est la même, seule la présentation change.

---

## V.1 🧪 TP 10 — A, AAAA et CNAME

**🎯 Objectif.** Comprendre qu'**une machine peut avoir plusieurs noms**, qu'un alias se **suit**, et qu'une adresse IPv4 et une adresse IPv6 sont deux fiches différentes.

**Ce qu'il te faut.** Un terminal sur `PC-CONSEILLER` et un sur `PC-GUICHET1`. Durée : environ 25 minutes.

Dans le laboratoire, la machine du site de la banque s'appelle `web`. Mais les clients écrivent `www`, `ebanking`, `agences`, `api`… Ces quatre noms ne désignent pas quatre machines : ce sont des **alias** (des surnoms) de `web`.

```schema
web.banquehorizon.com       A      203.0.113.20          ← la seule fiche qui porte l'adresse
www.banquehorizon.com       CNAME  web.banquehorizon.com ← un alias de web
ebanking.banquehorizon.com  CNAME  web.banquehorizon.com
agences.banquehorizon.com   CNAME  web.banquehorizon.com
api.banquehorizon.com       CNAME  web.banquehorizon.com
```

L'intérêt : si le site change d'adresse, on corrige **une seule fiche** (`web`), et les quatre alias suivent.

**Étape 1 — La fiche A de `web`.**

```
# sur PC-CONSEILLER
dig web.banquehorizon.com +short
```

```
203.0.113.20
```

Une seule ligne : l'adresse IPv4 de `web`. C'est la fiche de type **A**.

**Étape 2 — Demander l'adresse d'un alias.**

```
# sur PC-CONSEILLER
dig ebanking.banquehorizon.com +short
```

```
web.banquehorizon.com.
203.0.113.20
```

Cette fois il y a **deux lignes**. Lis-les dans l'ordre : le serveur te dit d'abord vers quel nom l'alias mène (`web.banquehorizon.com.`), puis l'adresse de ce nom. Tu avais demandé une adresse, il a **suivi l'alias pour toi** et t'a donné les deux fiches dans la même réponse. Tu n'as pas à reposer la question.

**Étape 3 — Demander l'alias lui-même.**

```
# sur PC-CONSEILLER
dig www.banquehorizon.com CNAME +short
```

Cette fois tu précises le type : `CNAME`. Tu ne veux plus l'adresse, tu veux la fiche d'alias.

```
web.banquehorizon.com.
```

Une seule ligne : la cible de l'alias. `dig` n'a **pas** suivi : tu avais demandé la fiche `CNAME`, tu as reçu la fiche `CNAME`. Un `CNAME` va **d'un nom à un autre nom** ; il ne porte jamais d'adresse.

**Étape 4 — Le même alias, vu depuis Windows.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName agences.banquehorizon.com
```

```
Name     : agences.banquehorizon.com
Type     : CNAME
TTL      : 3600
Section  : Answer
NameHost : web.banquehorizon.com

Name      : web.banquehorizon.com
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 203.0.113.20
```

Deux petits tableaux, un par fiche. Le premier est le `CNAME` (`agences` mène à `web`) ; le second est le `A` (`web` vaut `203.0.113.20`). C'est la même chaîne qu'à l'étape 2, présentée autrement.

**Étape 5 — Seulement l'alias, côté Windows.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName api.banquehorizon.com -Type CNAME
```

```
Name     : api.banquehorizon.com
Type     : CNAME
TTL      : 3600
Section  : Answer
NameHost : web.banquehorizon.com
```

Avec `-Type CNAME`, `Resolve-DnsName` se limite à la fiche d'alias, comme `dig … CNAME` à l'étape 3.

**Étape 6 — La fiche AAAA : l'adresse IPv6.**

Il existe deux sortes d'adresses IP : IPv4 (`203.0.113.20`) et IPv6 (de la forme `2001:db8::1`, plus longue). Elles ont chacune leur type de fiche : **A** pour IPv4, **AAAA** (« quad-A ») pour IPv6. Demande l'adresse IPv6 de `web` :

```
# sur PC-CONSEILLER
dig web.banquehorizon.com AAAA
```

```
; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> web.banquehorizon.com AAAA
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 52
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 65494
;; QUESTION SECTION:
;web.banquehorizon.com.		IN	AAAA

;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	SOA	ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600

;; Query time: 0 msec
;; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)
;; WHEN: Wed Nov 04 11:06:00 UTC 2026
;; MSG SIZE  rcvd: 101
```

Regarde bien : `status: NOERROR`, mais `ANSWER: 0`. **Aucune erreur, et aucune réponse.** La machine `web` n'a pas d'adresse IPv6, donc il n'y a pas de fiche AAAA à donner. Le TP 13 explique en détail ce « rien ».

⚠️ **Attention** — Chaque alias coûte **une résolution de plus** au client. Une chaîne d'alias qui mènent à d'autres alias ralentit les pages ; les résolveurs limitent d'ailleurs la longueur de la chaîne.

🆘 **Si ça ne marche pas.** `status: NXDOMAIN` à l'étape 6 : tu as fait une faute dans `web.banquehorizon.com`. Un `NXDOMAIN` veut dire « ce nom n'existe pas » (TP 3, étape 7).

**🧠 Ce que tu viens d'apprendre.**

- Les quatre noms `www`, `ebanking`, `agences` et `api` sont des **alias** (CNAME) de `web`, qui porte l'unique adresse. Pour changer l'adresse du site, on modifie **une seule fiche**.
- Quand tu demandes l'adresse d'un alias, le serveur renvoie **l'alias et sa cible** dans la même réponse.
- Si tu demandes explicitement le type `CNAME`, tu n'obtiens que l'alias.
- **A** est l'adresse IPv4, **AAAA** l'adresse IPv6. Un nom peut avoir l'une, l'autre, les deux, ou aucune.

**Vérifie-toi.**

1. Quel type de fiche porte une adresse IPv4 ? IPv6 ?
2. Que contient la donnée d'un `CNAME` ?
3. `dig web.banquehorizon.com AAAA` répond `NOERROR` sans réponse. Est-ce une panne ?

*Réponses.* (1) `A` ; `AAAA`. (2) Un autre **nom**, jamais une adresse. (3) Non : `web` n'a simplement pas d'adresse IPv6.

---

## V.2 🧪 TP 11 — MX, TXT (SPF, DMARC) et SRV

**🎯 Objectif.** Lire les fiches que **d'autres services** consultent à ta place : la messagerie, la lutte contre l'usurpation d'identité, la découverte d'un service.

**Ce qu'il te faut.** Un terminal sur `PC-CONSEILLER` et un sur `PC-GUICHET1`. Durée : environ 40 minutes.

Toutes les commandes de ce TP utilisent `+short` (TP 3, étape 1), pour ne voir que la donnée.

**Étape 1 — MX : où livrer le courrier ?**

Quand quelqu'un envoie un message à `contact@banquehorizon.com`, son serveur de messagerie demande au DNS : « Quel est le serveur qui reçoit le courrier de `banquehorizon.com` ? ». La réponse est une fiche **MX**.

```
# sur PC-CONSEILLER
dig banquehorizon.com MX +short
```

```
10 mail.banquehorizon.com.
20 mail2.banquehorizon.com.
```

Chaque ligne a deux morceaux : un **nombre** (la *préférence*) et un **nom** de serveur. On essaie d'abord le **plus petit nombre** : `mail` (préférence 10) est le serveur principal ; `mail2` (préférence 20) est le secours si `mail` est injoignable. L'ordre d'affichage peut varier chez toi, seule la préférence compte.

**Étape 2 — TXT : le texte libre, et la règle SPF.**

Une fiche **TXT** contient du texte. On s'en sert pour publier des règles lisibles par des machines. La plus répandue est le **SPF** : « voici les serveurs qui ont le droit d'envoyer du courrier au nom de mon domaine ».

```
# sur PC-CONSEILLER
dig banquehorizon.com TXT +short
```

```
"v=spf1 mx -all"
```

Lis ce texte mot par mot :

| Morceau | Sens |
|---|---|
| `v=spf1` | « Ceci est une règle SPF, version 1 » |
| `mx` | « Les serveurs listés dans mes fiches MX ont le droit d'envoyer » |
| `-all` | « **Tous les autres sont refusés** » |

Un serveur qui reçoit un message prétendument envoyé par `banquehorizon.com` consulte cette fiche. Si l'expéditeur n'est pas un des MX, il peut rejeter le message.

**Étape 3 — TXT : la politique DMARC.**

Le **DMARC** dit quoi faire d'un message qui échoue aux contrôles. Il est publié sous un nom particulier, qui commence toujours par `_dmarc`.

```
# sur PC-CONSEILLER
dig _dmarc.banquehorizon.com TXT +short
```

```
"v=DMARC1; p=reject; rua=mailto:dmarc@banquehorizon.com"
```

| Morceau | Sens |
|---|---|
| `v=DMARC1` | « Politique DMARC, version 1 » |
| `p=reject` | « **Jette** les messages qui échouent aux contrôles » |
| `rua=mailto:dmarc@banquehorizon.com` | « Envoie-moi les rapports à cette adresse » |

Le nom commence par un tiret bas (`_dmarc`) : c'est la convention pour un nom qui désigne un **service** et non une machine.

**Étape 4 — SRV : où est ce service, et sur quel port ?**

Une fiche `A` donne l'adresse d'une machine, pas **le numéro de port** d'un service. Une fiche **SRV** donne les deux. Son nom a la forme `_service._protocole.domaine`.

```
# sur PC-CONSEILLER
dig _imaps._tcp.banquehorizon.com SRV +short
```

```
0 1 993 mail.banquehorizon.com.
```

Le nom `_imaps._tcp.banquehorizon.com` se lit : « le service **IMAPS** (lecture de courrier sécurisée), en **TCP**, pour le domaine `banquehorizon.com` ». Les quatre valeurs sont :

| Valeur | Nom | Sens |
|---|---|---|
| `0` | priorité | Plus petit = essayé d'abord |
| `1` | poids | Répartition de charge entre serveurs de même priorité |
| `993` | **port** | Le port TCP du service |
| `mail.banquehorizon.com.` | cible | La machine qui l'offre |

**Étape 5 — NS : les serveurs de la zone.**

```
# sur PC-CONSEILLER
dig banquehorizon.com NS +short
```

```
ns1.banquehorizon.com.
ns2.banquehorizon.com.
```

Deux serveurs de noms : `ns1` (le principal) et `ns2` (le secondaire). Tu les as déjà croisés dans la section `AUTHORITY` (TP 3, étape 6). L'ordre peut varier.

**Étape 6 — SOA : la fiche d'identité de la zone.**

```
# sur PC-CONSEILLER
dig banquehorizon.com SOA +short
```

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

Une seule ligne, mais **sept valeurs**, dans cet ordre :

| Rang | Valeur | Rôle |
|---|---|---|
| 1 | `ns1.banquehorizon.com.` | Le serveur **primaire** de la zone |
| 2 | `hostmaster.banquehorizon.com.` | L'adresse du responsable (`hostmaster@banquehorizon.com` : le premier point remplace le `@`) |
| 3 | `2026103101` | Le **numéro de série** : la version de la zone. Les secondaires ne recopient la zone que si ce nombre a **augmenté** |
| 4 | `7200` | *refresh* : tous les combien de secondes le secondaire demande le numéro de série |
| 5 | `900` | *retry* : combien attendre avant de réessayer si le primaire ne répond pas |
| 6 | `1209600` | *expire* : au-delà de 14 jours sans nouvelle du primaire, le secondaire **cesse de répondre** |
| 7 | `3600` | *minimum* : combien de temps garder en cache une réponse **négative** (TP 22) |

Tu relèveras ces valeurs en détail aux TP 14 et 18.

**Étape 7 — Les mêmes fiches, côté Windows.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName banquehorizon.com -Type TXT
```

```
Name    : banquehorizon.com
Type    : TXT
TTL     : 3600
Section : Answer
Strings : {v=spf1 mx -all}
```

```powershell
# sur PC-GUICHET1
Resolve-DnsName _imaps._tcp.banquehorizon.com -Type SRV
```

```
Name       : _imaps._tcp.banquehorizon.com
Type       : SRV
TTL        : 3600
Section    : Answer
NameTarget : mail.banquehorizon.com
Priority   : 0
Weight     : 1
Port       : 993
```

```powershell
# sur PC-GUICHET1
Resolve-DnsName banquehorizon.com -Type SOA
```

```
Name                   : banquehorizon.com
Type                   : SOA
TTL                    : 3600
Section                : Answer
PrimaryServer          : ns1.banquehorizon.com
NameAdministrator      : hostmaster.banquehorizon.com
SerialNumber           : 2026103101
TimeToZoneRefresh      : 7200
TimeToZoneFailureRetry : 900
TimeToExpiration       : 1209600
DefaultTTL             : 3600
```

`Resolve-DnsName` nomme chaque valeur : il t'évite de compter les colonnes. `Strings` contient le texte du `TXT`, `NameTarget`/`Priority`/`Weight`/`Port` sont les quatre valeurs du `SRV`, et `SerialNumber`, `TimeToZoneRefresh`, `TimeToZoneFailureRetry`, `TimeToExpiration`, `DefaultTTL` sont le numéro de série et les quatre durées du `SOA`.

> 🔍 **Point d'audit** — `p=reject` + `-all` est la configuration **stricte** : un contrôleur y voit une bonne hygiène contre l'hameçonnage. Une zone sans SPF ni DMARC laisse n'importe qui envoyer du courrier « de » ta banque. Garde la sortie de l'étape 2 et 3 comme preuve.

🆘 **Si ça ne marche pas.** Une réponse vide (`+short` n'affiche rien) : le nom est mal écrit. Vérifie le tiret bas de `_dmarc` et de `_imaps._tcp`.

**🧠 Ce que tu viens d'apprendre.**

| Fiche | Qui la lit | Ce que dit celle du laboratoire |
|---|---|---|
| **MX** | Les serveurs de messagerie qui t'envoient du courrier | `10 mail`, `20 mail2` : essayer d'abord `mail` |
| **TXT / SPF** | Le serveur qui **reçoit** un courrier « de » ton domaine | Seuls mes MX ont le droit d'envoyer, tous les autres sont refusés |
| **TXT / DMARC** | Idem | Jette ce qui échoue aux contrôles ; envoie-moi les rapports |
| **SRV** | Un client qui cherche un *service* | IMAP sur TLS : le port **993** de `mail` |
| **SOA** | Les serveurs secondaires et les outils | Les sept valeurs de l'étape 6 |

**Vérifie-toi.**

1. Dans un MX, quelle valeur décide quel serveur est essayé en premier ?
2. Que veut dire `-all` dans une règle SPF ?
3. Quelle valeur du SOA oblige un secondaire à recopier la zone ?

*Réponses.* (1) La préférence : le plus petit nombre d'abord. (2) Tous les expéditeurs non listés sont refusés. (3) Le numéro de série : quand il augmente, le secondaire recopie.

---

## V.3 🧪 TP 12 — PTR : retrouver un nom depuis une adresse

**🎯 Objectif.** Faire une **résolution inverse** (de l'adresse vers le nom) et comprendre pourquoi elle vit dans une zone à part.

**Ce qu'il te faut.** Un terminal sur `PC-CONSEILLER` et un sur `PC-GUICHET1`. Durée : environ 25 minutes.

Jusqu'ici, tu partais d'un **nom** pour trouver une **adresse**. Le chemin inverse existe : on part de l'adresse et on cherche son nom. Cela sert aux journaux (afficher un nom plutôt qu'un numéro), à certains serveurs de messagerie (qui vérifient que l'expéditeur a un nom cohérent) et à des outils comme `ping`.

Il y a un problème : l'annuaire est rangé **par nom**, pas par adresse. Pour pouvoir retrouver un nom à partir d'une adresse, on a créé un arbre particulier, sous le nom **`in-addr.arpa`**. On y écrit l'adresse **à l'envers** :

```schema
203.0.113.20    devient    20.113.0.203.in-addr.arpa
```

Pourquoi à l'envers ? Dans un nom, la partie la plus générale est à droite (`com`). Dans une adresse, c'est le contraire : la partie la plus générale (le réseau, `203`) est à gauche. En retournant l'adresse, on obtient un nom qui se lit comme les autres, de droite à gauche, du général au particulier : et on peut **déléguer** par réseau, exactement comme on délègue par domaine.

**Étape 1 — `dig -x`.**

```
# sur PC-CONSEILLER
dig -x 203.0.113.20 +short
```

L'option `-x` dit à `dig` : « voici une adresse, retrouve son nom » — il écrit le nom en `in-addr.arpa` à ta place.

```
web.banquehorizon.com.
```

Le nom de la machine : `web.banquehorizon.com.`

**Étape 2 — Voir la vraie question.**

```
# sur PC-CONSEILLER
dig -x 203.0.113.20 +noall +comments +answer
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 54
;; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 65494
;; ANSWER SECTION:
20.113.0.203.in-addr.arpa. 3600	IN	PTR	web.banquehorizon.com.
```

Regarde la dernière ligne : la fiche s'appelle `20.113.0.203.in-addr.arpa.` et son type est **`PTR`** (« *pointer* », un pointeur vers un nom). Voilà la fiche que `dig -x` est allé chercher.

**Étape 3 — `host`, la version courte.**

`host` est un autre outil Linux, plus bref que `dig` : `host nom` donne l'adresse, `host adresse` donne le nom.

```
# sur PC-CONSEILLER
host 203.0.113.20
```

```
20.113.0.203.in-addr.arpa domain name pointer web.banquehorizon.com.
```

Une phrase : « le nom `20.113.0.203.in-addr.arpa` pointe vers `web.banquehorizon.com` ».

**Étape 4 — Côté Windows.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName 203.0.113.20
```

```
Name     : 20.113.0.203.in-addr.arpa
Type     : PTR
TTL      : 3600
Section  : Answer
NameHost : web.banquehorizon.com
```

`Resolve-DnsName` a reconnu qu'on lui donnait une adresse : il a lui-même construit le nom en `in-addr.arpa` et demandé la fiche `PTR`.

**Étape 5 — Quand `ping` fait une résolution inverse sans te le dire.**

```
# sur PC-CONSEILLER
ping -c 1 www.banquehorizon.com
```

```
PING www.banquehorizon.com (203.0.113.20) 56(84) bytes of data.
64 bytes from web.banquehorizon.com (203.0.113.20): icmp_seq=1 ttl=62 time=0.043 ms

--- www.banquehorizon.com ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 0.043/0.043/0.043/0.000 ms
```

Compare les deux premières lignes. Tu as tapé `www.banquehorizon.com`, mais `ping` écrit à la ligne 2 `web.banquehorizon.com`. Pourquoi ? Parce que `ping` a d'abord traduit le nom en adresse (`203.0.113.20`), puis, pour afficher l'origine de la réponse, a fait une **résolution inverse** de cette adresse : le PTR donne `web`, pas `www`. Les journaux d'un serveur, `traceroute` ou `netstat` font de même. L'option `-n` de `ping` supprime cette seconde question et affiche seulement l'adresse.

> 🔍 **Point d'audit** — Un PTR absent ou incohérent avec le nom direct est un motif de rejet pour certains serveurs de messagerie. Vérifie que chaque adresse publique porte un PTR cohérent avec son nom.

🆘 **Si ça ne marche pas.** `NXDOMAIN` à l'étape 1 : l'adresse n'a pas de PTR, ou tu as tapé une adresse dont le réseau n'a pas de zone inverse dans le laboratoire.

**🧠 Ce que tu viens d'apprendre.**

- La résolution inverse cherche une fiche **PTR** dans l'arbre `in-addr.arpa`, où l'adresse est écrite **à l'envers**.
- `dig -x`, `host adresse` et `Resolve-DnsName adresse` construisent ce nom à ta place.
- La zone `113.0.203.in-addr.arpa` est une **zone à part** : *celui qui possède l'adresse* possède sa résolution inverse (dans la vraie vie, c'est le fournisseur d'accès qui délègue ; dans le laboratoire, elle est déléguée à `NS1-BANK`).
- **`ping` utilise le PTR** pour afficher un nom : il écrit le nom de l'adresse qui répond, pas celui que tu as tapé.

**Vérifie-toi.**

1. Quel nom DNS correspond à l'adresse `203.0.113.20` ?
2. Quel type de fiche trouve-t-on dans `in-addr.arpa` ?

*Réponses.* (1) `20.113.0.203.in-addr.arpa`. (2) Des fiches `PTR`.

---

## V.4 🧪 TP 13 — NXDOMAIN ou NODATA ?

**🎯 Objectif.** Distinguer les **deux** façons de répondre « rien », et comprendre pourquoi elles n'ont pas le même sens.

**Ce qu'il te faut.** Un terminal sur `PC-CONSEILLER` et un sur `PC-GUICHET1`. Durée : environ 25 minutes.

Quand on demande quelque chose qui n'existe pas, le DNS ne répond pas « non » de toujours la même façon. Il faut distinguer deux cas :

- le **nom** n'existe pas du tout (**NXDOMAIN**) ;
- le nom existe, mais **pas ce type de fiche** (**NODATA**).

Un exemple de chaque. Tu interroges directement `DNS-RES` (`@10.20.20.53`) et tu ne gardes que l'en-tête et la section `AUTHORITY` (TP 3).

**Étape 1 — Un nom qui n'existe pas.**

```
# sur PC-CONSEILLER
dig @10.20.20.53 nexiste.banquehorizon.com +noall +comments +authority
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 42
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	SOA	ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

- `status: NXDOMAIN` : le nom n'existe pas.
- `ANSWER: 0` : rien à donner.
- `AUTHORITY: 1` : le serveur joint la fiche **SOA** de la zone (TP 11, étape 6). Retiens-la : elle sert à plus tard.

**Étape 2 — Un nom qui existe, mais sans cette fiche.**

```
# sur PC-CONSEILLER
dig @10.20.20.53 web.banquehorizon.com AAAA +noall +comments +authority
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 43
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	SOA	ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

Compare avec l'étape 1 : `ANSWER: 0` et la même fiche SOA, mais cette fois **`status: NOERROR`**. Le serveur ne dit pas « ce nom n'existe pas » : il dit « ce nom existe, mais je n'ai pas de fiche AAAA pour lui ». C'est un **NODATA**.

**Étape 3 — Les mêmes cas côté Windows.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName nexiste.banquehorizon.com
```

```
Resolve-DnsName : nexiste.banquehorizon.com : DNS name does not exist
    + CategoryInfo          : ResourceUnavailable: (nexiste.banquehorizon.com:String) [Resolve-DnsName], Win32Exception
    + FullyQualifiedErrorId : DNS_ERROR_RCODE_NAME_ERROR,Microsoft.DnsClient.Commands.ResolveDnsName
```

```powershell
# sur PC-GUICHET1
Resolve-DnsName web.banquehorizon.com -Type AAAA
```

```
Resolve-DnsName : web.banquehorizon.com : DNS record does not exist
    + CategoryInfo          : ResourceUnavailable: (web.banquehorizon.com:String) [Resolve-DnsName], Win32Exception
    + FullyQualifiedErrorId : DNS_ERROR_RECORD_DOES_NOT_EXIST,Microsoft.DnsClient.Commands.ResolveDnsName
```

PowerShell affiche une erreur rouge dans les deux cas, mais les deux messages ne sont pas les mêmes : `DNS name does not exist` (le nom n'existe pas) pour NXDOMAIN, `DNS record does not exist` (le nom existe, la fiche non) pour NODATA. Cherche le mot après `FullyQualifiedErrorId` : `DNS_ERROR_RCODE_NAME_ERROR` ou `DNS_ERROR_RECORD_DOES_NOT_EXIST`.

**Étape 4 — Pourquoi la fiche SOA dans les deux cas ?**

Dans les deux cas, la section `AUTHORITY` porte le **SOA** de la zone. Ce n'est pas un hasard : c'est lui qui dit **pendant combien de temps** un résolveur peut mémoriser cette réponse négative (« ce nom n'existe pas », « cette fiche n'existe pas »). La durée est la plus petite des deux valeurs : le TTL de la fiche SOA (3600) ou son dernier champ, `minimum` (3600 aussi ici). C'est le **cache négatif**, que tu verras au TP 22.

**Récapitulatif.**

| | **NXDOMAIN** | **NODATA** |
|---|---|---|
| `status` | `NXDOMAIN` | `NOERROR` (**avec** `ANSWER: 0`) |
| Sens | Ce **nom** n'existe pour **aucun** type | Le nom existe, mais **pas ce type** |
| Exemple | `nexiste` | `web` a une adresse IPv4, pas d'IPv6 |
| Windows | `DNS name does not exist` | `DNS record does not exist` |

⚠️ **Attention** — Confondre les deux fait perdre des heures. « Pas d'IPv6 » n'est **pas** une erreur : c'est un `NOERROR` vide. Un programme qui traite le `NOERROR` vide comme un `NXDOMAIN` dira à tort que le site n'existe pas.

🆘 **Si ça ne marche pas.** À l'étape 1, `NOERROR` au lieu de `NXDOMAIN` : tu as sans doute tapé un nom qui existe (`web`, `www`, `mail`…). Choisis un nom au hasard, comme `nexiste`.

**🧠 Ce que tu viens d'apprendre.**

- `NXDOMAIN` = le nom n'existe pas ; `NOERROR` avec `ANSWER: 0` = le nom existe, mais pas cette fiche.
- Dans les deux cas, la fiche **SOA** est jointe pour fixer la durée du cache négatif.
- Sous Windows, les deux cas ont deux messages d'erreur différents.

**Vérifie-toi.**

1. `dig` répond `status: NOERROR` et `ANSWER: 0`. Le nom existe-t-il ?
2. Quel mot de l'erreur PowerShell distingue les deux cas ?

*Réponses.* (1) Oui : le nom existe, mais il n'a pas de fiche du type demandé (NODATA). (2) `name` (le nom n'existe pas) contre `record` (la fiche n'existe pas).

---

# Partie VI — Les serveurs

Jusqu'ici, tu as **posé des questions**. Dans cette partie tu passes de l'autre côté du guichet : tu vas **lire, vérifier, modifier et casser** les serveurs qui répondent. C'est ce que fait un administrateur DNS.

Le laboratoire contient trois familles de serveurs :

| Famille | Équipements | Ce qu'ils font |
|---|---|---|
| **BIND faisant autorité** | `NS1-BANK`, `ROOT-NS` | Détiennent des zones et répondent à leur sujet |
| **BIND résolveur** | `DNS-RES` | Fait le travail des résolveurs (§ I.8) pour l'agence |
| **DNS Windows** | `TLD-NS`, `DC1`, `NS2-BANK` | Détiennent des zones (ou servent de copie) sous Windows |

**Avant de commencer, trois règles de sécurité.**

1. **Tout ce que tu modifies sera remis en état à la fin du TP.** Le texte te dit quand. Ne passe pas au TP suivant avant d'avoir terminé la remise en état.
2. **Si tu t'embrouilles, ré-importe le laboratoire** (§ 0.1) : tu repars d'un état propre. C'est le droit à l'erreur du simulateur.
3. **Dans le simulateur, rien n'est réel.** Tu ne peux casser aucun vrai serveur. Profite-en : on apprend surtout en cassant.

**Ta boîte à outils Linux pour cette partie.** Tu en connais déjà une partie (§ 0.4, § I.2). Voici le tableau complet : tu peux y revenir.

| Commande | Ce qu'elle fait | Exemple |
|---|---|---|
| `ls` | Liste les fichiers d'un dossier | `ls /etc/bind` |
| `cat` | Affiche le contenu d'un fichier | `cat /etc/bind/named.conf` |
| `grep` | Garde les lignes qui contiennent un mot | `grep recursion /etc/bind/named.conf` |
| `sed -i` | Remplace du texte **dans** un fichier | `sudo sed -i 's/ancien/nouveau/' fichier` |
| `tee -a` | Ajoute du texte **à la fin** d'un fichier | `echo 'ligne' \| sudo tee -a fichier` |
| `sudo` | Exécute en administrateur | `sudo rndc status` |
| `named-checkconf` | Vérifie la **configuration** de BIND | `named-checkconf` |
| `named-checkzone` | Vérifie un **fichier de zone** | `named-checkzone zone fichier` |
| `rndc` | Commande le serveur BIND en marche | `sudo rndc reload` |

Et pour Windows : les commandes PowerShell `Get-DnsServer…` et `Add-DnsServer…`, présentées au fur et à mesure.

---

## VI.1 🧪 TP 14 — Lire la configuration et la zone de NS1-BANK

**🎯 Objectif.** Savoir lire, ligne à ligne, ce qui fait d'un serveur BIND un serveur *faisant autorité* pour `banquehorizon.com`.

**Ce qu'il te faut.** Un terminal sur `NS1-BANK` (double-clic sur l'équipement). Durée : environ 45 minutes. Dans ce TP, **tu ne modifies rien** : tu lis.

**Étape 1 — Où sont les fichiers ?**

```
# sur NS1-BANK
ls /etc/bind
```

`ls` liste le contenu d'un dossier. `/etc/bind` est le dossier où BIND range sa configuration.

```
db.203.0.113	      named.conf	named.conf.options
db.banquehorizon.com  named.conf.local
```

Cinq fichiers. Deux familles :

- les fichiers qui commencent par `named.conf` sont des fichiers de **configuration** (comment le serveur fonctionne) ;
- les fichiers qui commencent par `db.` sont des fichiers de **zone** (les fiches de l'annuaire). Par habitude, `db.banquehorizon.com` contient la zone `banquehorizon.com`, et `db.203.0.113` la zone inverse (TP 12).

**Étape 2 — La configuration principale.**

```
# sur NS1-BANK
cat /etc/bind/named.conf
```

```
options {
    directory "/var/cache/bind";
    recursion no;
    allow-query { any; };
};
zone "banquehorizon.com" {
    type primary;
    file "/etc/bind/db.banquehorizon.com";
    allow-transfer { 203.0.113.11; };
    notify yes;
};
zone "113.0.203.in-addr.arpa" {
    type primary;
    file "/etc/bind/db.203.0.113";
};
```

Ce fichier est fait de **blocs** : un mot, une accolade ouvrante, des lignes, une accolade fermante **suivie d'un point-virgule**. Il y en a trois. Chaque ligne se termine, elle aussi, par un point-virgule : **c'est l'oubli le plus fréquent**, tu le provoqueras volontairement au TP 15.

*Le bloc `options` (lignes 1 à 5)* règle le comportement général :

```
options {
    directory "/var/cache/bind";
    recursion no;
    allow-query { any; };
};
```

| Ligne | Sens |
|---|---|
| `directory "/var/cache/bind";` | Le dossier de travail de `named` : c'est là qu'il écrit ses fichiers temporaires |
| `recursion no;` | Ce serveur **ne résout pas pour les autres** (§ I.8). Il répond sur ses zones, point. C'est ce qui a produit le `REFUSED` du TP 9 |
| `allow-query { any; };` | Tout le monde a le droit de lui poser des questions. C'est normal pour un serveur public |

*Les blocs `zone` (lignes 6 à 15)* déclarent les deux zones que le serveur détient :

```
zone "banquehorizon.com" {
    type primary;
    file "/etc/bind/db.banquehorizon.com";
    allow-transfer { 203.0.113.11; };
    notify yes;
};
```

| Ligne | Sens |
|---|---|
| `zone "banquehorizon.com" {` | Le nom de la zone |
| `type primary;` | Cette machine détient la **copie de référence** (on disait avant *master*). L'autre, sur `NS2-BANK`, en est une copie |
| `file "…";` | Où se trouve le fichier de zone |
| `allow-transfer { 203.0.113.11; };` | **Seul `NS2-BANK`** (`203.0.113.11`) peut copier la zone en entier. Le TP 18 le prouve |
| `notify yes;` | Quand la zone change, **prévenir** le secondaire pour qu'il vienne la relire |

Le second bloc `zone` (`113.0.203.in-addr.arpa`) déclare la zone inverse du TP 12, avec le même format.

**Étape 3 — Deux fichiers présents, mais jamais lus.**

Tu as vu dans `ls` deux fichiers de configuration en plus : `named.conf.options` et `named.conf.local`. Regarde ce qu'ils contiennent :

```
# sur NS1-BANK
wc -c /etc/bind/named.conf.options /etc/bind/named.conf.local
```

`wc -c` compte les **octets** (les caractères) de chaque fichier.

```
94 /etc/bind/named.conf.options
 0 /etc/bind/named.conf.local
94 total
```

`named.conf.local` fait 0 octet : il est **vide**. `named.conf.options` fait 94 octets : il contient quelque chose.

```
# sur NS1-BANK
cat /etc/bind/named.conf.options
```

```
options {
	directory "/var/cache/bind";

	dnssec-validation auto;

	listen-on-v6 { any; };
};
```

Ce fichier contient d'autres réglages (`dnssec-validation`, `listen-on-v6`). **Mais `named.conf` ne contient aucune ligne `include`** pour le lire : BIND l'ignore. Dans ce laboratoire, tout ce qui compte est dans `named.conf`. Retiens le piège : **la présence d'un fichier dans `/etc/bind` ne prouve pas qu'il est utilisé.**

**Étape 4 — La zone directe.**

```
# sur NS1-BANK
cat /etc/bind/db.banquehorizon.com
```

```
$TTL 3600
$ORIGIN banquehorizon.com.
@ IN SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. ( 2026103101 7200 900 1209600 3600 )
@ IN NS ns1.banquehorizon.com.
@ IN NS ns2.banquehorizon.com.
@ IN A 203.0.113.20
@ IN MX 10 mail.banquehorizon.com.
@ IN MX 20 mail2.banquehorizon.com.
@ IN TXT "v=spf1 mx -all"
ns1 IN A 203.0.113.10
ns2 IN A 203.0.113.11
web IN A 203.0.113.20
www IN CNAME web
ebanking IN CNAME web
agences IN CNAME web
api IN CNAME web
mail IN A 203.0.113.25
mail2 IN A 203.0.113.26
_dmarc IN TXT "v=DMARC1; p=reject; rua=mailto:dmarc@banquehorizon.com"
_imaps._tcp IN SRV 0 1 993 mail
```

Un fichier de zone est une liste de fiches, une par ligne. Lis-le en quatre parties.

*Les deux lignes de réglages (lignes 1 et 2).*

```
$TTL 3600
$ORIGIN banquehorizon.com.
```

- `$TTL 3600` : la durée de vie (TTL, § I.10) donnée aux fiches qui n'en précisent pas.
- `$ORIGIN banquehorizon.com.` : le suffixe **ajouté aux noms qui n'ont pas de point final**. Le symbole `@` désigne l'origine elle-même.

*La fiche d'identité (ligne 3), le `SOA`.*

```
@ IN SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. ( 2026103101 7200 900 1209600 3600 )
```

Tu l'as décomposée au TP 11 : serveur primaire, responsable, numéro de série `2026103101`, puis les durées *refresh* (7 200 s), *retry* (900 s), *expire* (14 jours), *minimum* (3 600 s). Le numéro de série suit la convention `AAAAMMJJNN` : année, mois, jour, puis un numéro de révision dans la journée.

*Les fiches des serveurs et du domaine (lignes 4 à 9).*

```
@ IN NS ns1.banquehorizon.com.
@ IN NS ns2.banquehorizon.com.
@ IN A 203.0.113.20
@ IN MX 10 mail.banquehorizon.com.
@ IN MX 20 mail2.banquehorizon.com.
@ IN TXT "v=spf1 mx -all"
```

`@ IN NS …` (deux fiches) déclare les serveurs de la zone. `@ IN A` donne une adresse au domaine nu. `@ IN MX` déclare la messagerie, et `@ IN TXT` la règle SPF (TP 11).

*Les fiches des machines et des alias (lignes 10 à 20).*

```
ns1 IN A 203.0.113.10
ns2 IN A 203.0.113.11
web IN A 203.0.113.20
www IN CNAME web
ebanking IN CNAME web
agences IN CNAME web
api IN CNAME web
mail IN A 203.0.113.25
mail2 IN A 203.0.113.26
_dmarc IN TXT "v=DMARC1; p=reject; rua=mailto:dmarc@banquehorizon.com"
_imaps._tcp IN SRV 0 1 993 mail
```

Les noms sont écrits **sans point final** : `web` veut dire `web.banquehorizon.com.` (on ajoute l'origine). C'est la **règle des noms relatifs** :

- un nom **sans point final** est relatif : on lui ajoute l'origine. `www IN CNAME web` signifie « `www.banquehorizon.com.` est un alias de `web.banquehorizon.com.` » ;
- un nom **avec** point final est absolu : `mail.banquehorizon.com.` reste tel quel.

⚠️ **Attention** — Oublier le point final sur un nom complet est l'une des erreurs les plus classiques : `mail.banquehorizon.com` (sans point) devient `mail.banquehorizon.com.banquehorizon.com.`. Tu le provoqueras au TP 15.

La ligne `_imaps._tcp IN SRV 0 1 993 mail` est la fiche SRV du TP 11 : priorité 0, poids 1, port 993, serveur `mail`.

**Étape 5 — La zone inverse.**

```
# sur NS1-BANK
cat /etc/bind/db.203.0.113
```

```
$TTL 3600
$ORIGIN 113.0.203.in-addr.arpa.
@ IN SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. ( 2026103101 7200 900 1209600 3600 )
@ IN NS ns1.banquehorizon.com.
@ IN NS ns2.banquehorizon.com.
10 IN PTR ns1.banquehorizon.com.
11 IN PTR ns2.banquehorizon.com.
20 IN PTR web.banquehorizon.com.
25 IN PTR mail.banquehorizon.com.
```

Même format, mais l'origine est `113.0.203.in-addr.arpa.` et les fiches sont des `PTR` (TP 12). Un nom relatif comme `10` signifie `10.113.0.203.in-addr.arpa.`, c'est-à-dire l'adresse `203.0.113.10`. Chaque ligne donne le nom d'une adresse du réseau : `10` pour `ns1`, `11` pour `ns2`, `20` pour `web`, `25` pour `mail`.

**Étape 6 — Vérifier la configuration.**

Avant de faire confiance à un fichier, on le fait **relire par l'outil de BIND**, sans rien démarrer.

```
# sur NS1-BANK
named-checkconf; echo rc=$?
```

`named-checkconf` relit `named.conf`. Le `;` enchaîne deux commandes sur la même ligne : la seconde (`echo rc=$?`) affiche le **code de retour** de la première. `$?` désigne ce code. Sous Linux, `0` veut dire « tout va bien » et tout autre nombre veut dire « il y a eu un problème ».

```
rc=0
```

`rc=0` : la configuration est correcte. (La commande elle-même n'affiche rien quand tout va bien.)

**Étape 7 — Vérifier la zone.**

```
# sur NS1-BANK
named-checkzone banquehorizon.com /etc/bind/db.banquehorizon.com
```

`named-checkzone` prend deux arguments : le **nom de la zone** et son **fichier**.

```
zone banquehorizon.com/IN: loaded serial 2026103101
OK
```

`loaded serial 2026103101` : la zone est chargée et son numéro de série est lu. `OK` : aucune erreur. Ces deux outils sont ceux qu'il ne faut jamais oublier de lancer avant de recharger un serveur (TP 15).

**Étape 8 — Demander son état au serveur en marche.**

```
# sur NS1-BANK
sudo rndc status
```

`rndc` (*remote name daemon control*) est la **télécommande** de `named`, le programme qui fait tourner BIND. `status` affiche son état.

```
version: BIND 9.18.12-0ubuntu0.22.04.1-Ubuntu (Extended Support Version) <id:>
number of zones: 2 (0 automatic)
debug level: 0
xfers running: 0
xfers deferred: 0
soa queries in progress: 0
query logging is OFF
recursive clients: 0/900/1000
tcp clients: 0/150
server is up and running
```

Tu n'as pas besoin de tout lire. Retiens trois lignes : `version: BIND 9.18…` (la version), `number of zones: 2` (les deux zones sont chargées : la directe et l'inverse) et `server is up and running` (il fonctionne).

**Étape 9 — Sur quel port écoute-t-il ?**

```
# sur NS1-BANK
ss -ulnp | grep named
```

Cette ligne combine deux commandes avec le symbole `|` (le « tube », *pipe*) : la sortie de la première est donnée à la seconde. `ss` liste les connexions réseau ; `-ulnp` signifie *UDP*, *listening* (en écoute), *numérique* (pas de noms), *processus* (qui écoute). `grep named` ne garde que les lignes qui contiennent `named`.

```
UNCONN 0      0            0.0.0.0:53         0.0.0.0:*    users:(("named",pid=43,fd=3))          
UNCONN 0      0               [::]:53            [::]:*    users:(("named",pid=43,fd=4))          
```

`UNCONN` : en écoute (UDP n'a pas de connexion). `0.0.0.0:53` : sur **toutes** les adresses IPv4 de la machine, au port `53`, celui du DNS. `[::]:53` : la même chose pour l'IPv6 (les crochets entourent une adresse IPv6, qui contient elle-même des deux-points). `users:(("named",…))` : c'est le programme `named` qui écoute sur les deux.

> 🔍 **Point d'audit** — Garde une copie datée de `named.conf` et des fichiers de zone avec leur somme `sha256sum` : c'est la « configuration de référence » à laquelle un auditeur comparera. `allow-transfer` doit nommer des adresses, **jamais `any`** (TP 35).

🆘 **Si ça ne marche pas.** `Permission denied` à l'étape 8 : tu as oublié `sudo`. `cat: …: No such file or directory` : tu n'es pas sur `NS1-BANK` (vérifie le titre du terminal).

**🧠 Ce que tu viens d'apprendre.**

- Un serveur BIND, c'est une **configuration** (`named.conf`) qui déclare les zones, plus un **fichier de zone** par zone.
- Dans `named.conf`, les blocs se terminent par `};` et les lignes par `;`. L'oubli du point-virgule est l'erreur n°1.
- Dans un fichier de zone, un nom **sans point final est relatif** (on lui ajoute l'origine), un nom **avec** point final est absolu.
- `named-checkconf` et `named-checkzone` relisent les fichiers **sans rien démarrer** ; `rndc` pilote le serveur en marche.
- La présence d'un fichier ne prouve pas qu'il est lu : seul `include` ou la déclaration de zone le branche.

**Vérifie-toi.**

1. Quelle ligne de `named.conf` empêche `NS1-BANK` de résoudre pour les autres ?
2. Dans la zone, que signifie `www IN CNAME web` ?
3. Que signifie `rc=0` ?

*Réponses.* (1) `recursion no;`. (2) `www.banquehorizon.com.` est un alias de `web.banquehorizon.com.` (le nom sans point final est complété par l'origine). (3) La commande précédente s'est terminée sans erreur.

---
## VI.2 🧪 TP 15 — Vérifier avant de recharger

**🎯 Objectif.** Faire à la main huit erreurs de zone classiques et lire ce que dit `named-checkzone` ; puis constater ce qui arrive à un serveur en marche quand on recharge une zone cassée.

**Ce qu'il te faut.** Le TP 14 terminé, un terminal sur `NS1-BANK`, puis un sur `PC-CONSEILLER` pour la dernière partie. Durée : environ 1 heure.

**Pourquoi ce TP ?** Un fichier de zone est un fichier texte écrit à la main. Une faute de frappe dedans peut priver un domaine entier de DNS. L'habitude d'un administrateur : **vérifier avant de recharger**. Tu vas voir ce qui se passe quand on ne le fait pas.

### Partie A — Casser une copie de la zone, huit fois

On ne touche pas encore à la vraie zone : chaque erreur est faite sur une **copie** dans `/tmp`, un dossier où l'on peut écrire sans danger.

**Le principe des commandes de cette partie.** Chaque commande fait trois gestes sur une seule ligne :

```schema
sed 's/avant/après/' zone | sudo tee /tmp/z1 > /dev/null ; named-checkzone banquehorizon.com /tmp/z1
└─ 1. fabrique une version cassée │ 2. l'écrit dans /tmp/z1, sans rien afficher │ 3. la fait vérifier
```

1. `sed 's/avant/après/' fichier` lit le fichier et remplace `avant` par `après` **dans ce qu'il affiche**, sans toucher au fichier d'origine. Le `^` veut dire « au début de la ligne ».
2. `| sudo tee /tmp/z1 > /dev/null` envoie ce texte dans un nouveau fichier `/tmp/z1`. Le `> /dev/null` jette l'affichage de `tee` (`/dev/null` est la poubelle de Linux), pour qu'il ne te reste à lire que le verdict.
3. `named-checkzone … /tmp/z1` vérifie la copie.

Tu n'as pas à comprendre chaque symbole : **copie-colle les commandes**, et lis le verdict. Le message d'erreur donne toujours le **fichier**, la **ligne** et le **mot** fautif.

**Cas 1 — Un type de fiche inventé.** On écrit `AA` au lieu de `A`.

```
# sur NS1-BANK
sed 's/^web IN A/web IN AA/' /etc/bind/db.banquehorizon.com | sudo tee /tmp/z1 > /dev/null; named-checkzone banquehorizon.com /tmp/z1
```

```
/tmp/z1:12: unknown RR type 'AA'
zone banquehorizon.com/IN: loading from master file /tmp/z1 failed: unknown class/type
zone banquehorizon.com/IN: not loaded due to errors.
```

Lis de gauche à droite : `/tmp/z1:12` (le fichier et la **ligne 12**), `unknown RR type 'AA'` (« type de fiche inconnu : `AA` »). Trois lignes disent la même chose en plus long : la dernière, `not loaded due to errors`, signifie **zone refusée**.

**Cas 2 — Une adresse impossible.** Un octet à `999`.

```
# sur NS1-BANK
sed 's/^web IN A 203.0.113.20/web IN A 203.0.113.999/' /etc/bind/db.banquehorizon.com | sudo tee /tmp/z2 > /dev/null; named-checkzone banquehorizon.com /tmp/z2
```

```
dns_rdata_fromtext: /tmp/z2:12: near '203.0.113.999': bad dotted quad
zone banquehorizon.com/IN: loading from master file /tmp/z2 failed: bad dotted quad
zone banquehorizon.com/IN: not loaded due to errors.
```

`near '203.0.113.999'` désigne le mot fautif, `bad dotted quad` veut dire « adresse IPv4 mal formée ».

**Cas 3 — Du texte en trop.**

```
# sur NS1-BANK
sed 's/^mail IN A 203.0.113.25/mail IN A 203.0.113.25 oops/' /etc/bind/db.banquehorizon.com | sudo tee /tmp/z3 > /dev/null; named-checkzone banquehorizon.com /tmp/z3
```

```
dns_rdata_fromtext: /tmp/z3:17: near 'oops': extra input text
zone banquehorizon.com/IN: loading from master file /tmp/z3 failed: extra input text
zone banquehorizon.com/IN: not loaded due to errors.
```

`extra input text` : il y a un mot (`oops`) après la fin de la fiche. Retiens ce cas, tu vas le refaire dans la partie C.

**Cas 4 — Un alias qui cohabite avec une autre fiche.** On ajoute une fiche `A` au nom `www`, qui est déjà un alias.

```
# sur NS1-BANK
(cat /etc/bind/db.banquehorizon.com; echo 'www IN A 203.0.113.21') | sudo tee /tmp/z4 > /dev/null; named-checkzone banquehorizon.com /tmp/z4
```

```
dns_master_load: /tmp/z4:21: www.banquehorizon.com: CNAME and other data
zone banquehorizon.com/IN: loading from master file /tmp/z4 failed: CNAME and other data
zone banquehorizon.com/IN: not loaded due to errors.
```

`CNAME and other data` : un nom qui est un alias (`CNAME`) **ne peut porter aucune autre fiche**. La règle vient de la norme DNS : un alias dit « ce nom *est* un autre nom », il ne peut donc pas avoir sa propre adresse.

**Cas 5 — Plus de SOA.** `grep -v SOA` garde toutes les lignes **sauf** celles qui contiennent `SOA`.

```
# sur NS1-BANK
grep -v SOA /etc/bind/db.banquehorizon.com | sudo tee /tmp/z5 > /dev/null; named-checkzone banquehorizon.com /tmp/z5
```

```
zone banquehorizon.com/IN: has 0 SOA records
zone banquehorizon.com/IN: not loaded due to errors.
```

Pas de zone sans fiche d'identité : `has 0 SOA records`.

**Cas 6 — Plus de NS.**

```
# sur NS1-BANK
grep -v ' NS ' /etc/bind/db.banquehorizon.com | sudo tee /tmp/z6 > /dev/null; named-checkzone banquehorizon.com /tmp/z6
```

```
zone banquehorizon.com/IN: has no NS records
zone banquehorizon.com/IN: not loaded due to errors.
```

Pas de zone sans serveur de noms : `has no NS records`.

**Cas 7 — Un MX qui pointe sur une adresse.** Ici le résultat est différent.

```
# sur NS1-BANK
sed 's/^@ IN MX 10 mail.banquehorizon.com./@ IN MX 10 203.0.113.25/' /etc/bind/db.banquehorizon.com | sudo tee /tmp/z8 > /dev/null; named-checkzone banquehorizon.com /tmp/z8
```

```
/tmp/z8:7: warning: '203.0.113.25': MX is an address
zone banquehorizon.com/IN: banquehorizon.com/MX '203.0.113.25.banquehorizon.com' has no address records (A or AAAA)
zone banquehorizon.com/IN: loaded serial 2026103101
OK
```

Regarde la fin : `loaded serial 2026103101` puis `OK`. La zone **se charge**. Ce n'est pas une erreur, c'est un **avertissement** (`warning`) : un MX doit contenir un **nom**, jamais une adresse, donc ce MX est inutilisable. Mais l'outil ne l'interdit pas. Un avertissement ne bloque pas : **lis-les quand même**.

**Cas 8 — L'erreur que l'outil ne voit pas.** On écrit un nom complet **sans point final**.

```
# sur NS1-BANK
sed 's/^www IN CNAME web/www IN CNAME web.banquehorizon.com/' /etc/bind/db.banquehorizon.com | sudo tee /tmp/z9 > /dev/null; named-checkzone banquehorizon.com /tmp/z9
```

```
zone banquehorizon.com/IN: loaded serial 2026103101
OK
```

`OK`, et pourtant la fiche est fausse : sans point final, `web.banquehorizon.com` est un nom **relatif** (rappel : TP 14, étape 4), complété en `web.banquehorizon.com.banquehorizon.com.`, qui n'existe pas. L'outil ne le détecte pas, car la syntaxe est correcte : seul un `dig` sur le nom, après un rechargement, révèle le défaut.

### Partie B — Casser la configuration

On fait la même chose avec `named.conf`. On se place d'abord dans `/tmp` (avec `cd`) pour que les messages portent le nom court du fichier.

**Cas 9 — Une valeur qui n'est pas un booléen.** `recursion` attend `yes` ou `no`.

```
# sur NS1-BANK
cd /tmp; sed 's/recursion no;/recursion nope;/' /etc/bind/named.conf | sudo tee /tmp/bad.conf > /dev/null; named-checkconf bad.conf; echo rc=$?
```

```
bad.conf:3: boolean expected near 'nope'
rc=1
```

`bad.conf:3` : la ligne 3 du fichier. `boolean expected near 'nope'` : « une valeur oui/non était attendue ». `rc=1` : code de retour **différent de zéro**, donc un échec (rappel : TP 14, étape 6).

**Cas 10 — Un point-virgule oublié.**

```
# sur NS1-BANK
cd /tmp; sed 's/recursion no;/recursion no/' /etc/bind/named.conf | sudo tee /tmp/bad2.conf > /dev/null; named-checkconf bad2.conf; echo rc=$?
```

```
bad2.conf:4: missing ';' before 'allow-query'
rc=1
```

Le message désigne le mot **suivant** celui qui manque (`allow-query`) : BIND ne comprend qu'en arrivant au mot d'après qu'un `;` aurait dû terminer la ligne. Quand tu cherches un point-virgule oublié, **regarde la ligne d'avant**.

**Cas 11 — Tout vérifier d'un coup : `-z`.** On revient à la vraie configuration.

```
# sur NS1-BANK
named-checkconf -z; echo rc=$?
```

```
zone banquehorizon.com/IN: loaded serial 2026103101
zone 113.0.203.in-addr.arpa/IN: loaded serial 2026103101
rc=0
```

L'option `-z` demande à `named-checkconf` de **charger aussi les zones primaires** : en une seule commande, tu vérifies la configuration **et** les deux zones. `rc=0` : tout est bon. C'est la vérification complète.

### Partie C — Recharger une vraie zone cassée

Maintenant on casse volontairement la **vraie** zone, et on la recharge comme le ferait un administrateur pressé qui ne vérifie pas. On change l'adresse de `mail` **et** on laisse du texte en trop.

**Étape 1 — Casser.**

```
# sur NS1-BANK
sudo sed -i 's/^mail IN A 203.0.113.25/mail IN A 203.0.113.99 oops/' /etc/bind/db.banquehorizon.com
```

`sed -i` modifie **le fichier lui-même** (`-i`, *in place*). La commande n'affiche rien : le silence veut dire que ça a marché.

**Étape 2 — La vérification aurait protesté.**

```
# sur NS1-BANK
named-checkzone banquehorizon.com /etc/bind/db.banquehorizon.com
```

```
dns_rdata_fromtext: /etc/bind/db.banquehorizon.com:17: near 'oops': extra input text
zone banquehorizon.com/IN: loading from master file /etc/bind/db.banquehorizon.com failed: extra input text
zone banquehorizon.com/IN: not loaded due to errors.
```

Voilà l'erreur du cas 3, sur la vraie zone. Un administrateur prudent s'arrêterait ici. Ce n'est pas notre cas : on recharge.

**Étape 3 — Recharger quand même.**

```
# sur NS1-BANK
sudo rndc reload banquehorizon.com
```

```
zone reload queued
```

`zone reload queued`. **Aucune protestation.** C'est le piège : `queued` veut dire seulement « ta demande est enregistrée, je m'en occupe » — pas « c'est fait » et encore moins « c'est réussi ».

**Étape 4 — Chercher la vraie réponse dans le journal.**

```
# sur NS1-BANK
sudo grep named /var/log/syslog | tail -4
```

`/var/log/syslog` est le journal du système. `grep named` garde les lignes qui parlent de `named`, et `tail -4` ne garde que les **quatre dernières**.

```
Nov  4 20:16:01 NS1-BANK systemd: Started named.service.
Nov  4 20:27:02 NS1-BANK named[43]: dns_rdata_fromtext: /etc/bind/db.banquehorizon.com:17: near 'oops': extra input text
Nov  4 20:27:02 NS1-BANK named[43]: zone banquehorizon.com/IN: loading from master file /etc/bind/db.banquehorizon.com failed: extra input text
Nov  4 20:27:02 NS1-BANK named[43]: zone banquehorizon.com/IN: not loaded due to errors.
```

Voilà l'échec : `not loaded due to errors`. Il est dans le **journal**, pas dans la réponse de `rndc`. (Les dates à gauche sont celles de ta machine : elles seront différentes.)

**Étape 5 — Recharger encore.**

```
# sur NS1-BANK
sudo rndc reload banquehorizon.com
```

```
zone reload queued
```

Même réponse, toujours `queued`, toujours sans protester. Rien n'indique que la zone est cassée.

**Étape 6 — Regarder ce que le serveur répond.** Sur `PC-CONSEILLER` :

```
# sur PC-CONSEILLER
dig @203.0.113.10 mail.banquehorizon.com +noall +comments +answer
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 60
;; flags: qr aa rd; QUERY: 1, ANSWER: 1, AUTHORITY: 2, ADDITIONAL: 3
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; ANSWER SECTION:
mail.banquehorizon.com.	3600	IN	A	203.0.113.25
```

Regarde la dernière ligne : `mail` vaut **encore** `203.0.113.25`, l'ancienne adresse, et non `203.0.113.99`. Le serveur a **gardé l'ancienne copie de la zone**, celle qui fonctionnait, et ignore ton fichier cassé. Tout a l'air normal, alors que le fichier sur le disque est faux.

**Étape 7 — Réparer.** Sur `NS1-BANK` :

```
# sur NS1-BANK
sudo sed -i 's/203.0.113.99 oops/203.0.113.25/' /etc/bind/db.banquehorizon.com; named-checkzone banquehorizon.com /etc/bind/db.banquehorizon.com
```

```
zone banquehorizon.com/IN: loaded serial 2026103101
OK
```

On remet l'adresse d'origine et on **vérifie d'abord** : `OK`.

**Étape 8 — Recharger, deux fois.**

```
# sur NS1-BANK
sudo rndc reload banquehorizon.com
```

```
zone reload queued
```

```
# sur NS1-BANK
sudo rndc reload banquehorizon.com
```

```
zone reload up-to-date
```

Le premier rechargement est `queued` : le serveur relit le fichier (réparé). Le second dit `zone reload up-to-date` : « le fichier n'a pas changé depuis mon dernier chargement réussi ». Ce deuxième message te prouve que le premier a réussi.

> 🔍 **Point d'audit** — Mets `named-checkconf -z` dans la procédure de changement et garde sa sortie (`rc=0` et les numéros de série chargés) dans le ticket : c'est la preuve que la configuration livrée est celle qui a été vérifiée.

🆘 **Si ça ne marche pas.**

- À l'étape 6, la réponse est `203.0.113.99` : tu as fait l'étape 1 sans le `oops`. Ré-importe le laboratoire (§ 0.1) et recommence.
- Après l'étape 8, `named-checkzone` ne dit pas `OK` : un `sed` n'a pas fait ce qu'il fallait. Rouvre le fichier avec `cat /etc/bind/db.banquehorizon.com` et corrige la ligne de `mail` à la main.

**🧠 Ce que tu viens d'apprendre.**

- **Lis le message de gauche à droite** : `fichier:ligne: near 'mot'` (où), puis la raison (`unknown RR type`, `bad dotted quad`, `extra input text`, `CNAME and other data`).
- Les **vérifications logiques** (pas de SOA, pas de NS, `CNAME and other data`) échouent à la fin du chargement ; les **avertissements** (`MX is an address`) n'empêchent pas le chargement.
- **`rndc reload` ne dit pas si le chargement a réussi.** `zone reload queued` signifie seulement « la demande est enregistrée ». L'échec est dans le journal, et `named` continue de servir **l'ancienne** copie de la zone.
- Un serveur cassé qui répond avec des données anciennes est plus dangereux qu'un serveur en panne : **personne ne s'en aperçoit**. D'où la règle d'or : **`named-checkzone` d'abord, `rndc reload` ensuite, `dig` pour vérifier**.
- `zone reload up-to-date` veut dire « fichier inchangé depuis le dernier chargement réussi ». Il se compare au **fichier**, pas au numéro de série.

**Vérifie-toi.**

1. Que veut dire `zone reload queued` ?
2. Où trouve-t-on la raison d'un rechargement raté ?
3. Quelles sont les trois commandes de la règle d'or, dans l'ordre ?

*Réponses.* (1) La demande de rechargement est enregistrée ; cela ne dit rien du résultat. (2) Dans le journal (`/var/log/syslog`). (3) `named-checkzone`, puis `rndc reload`, puis `dig`.

---
## VI.3 🧪 TP 16 — Le résolveur DNS-RES

**🎯 Objectif.** Lire la configuration d'un serveur **récursif** (un résolveur, § I.8), comprendre en quoi elle diffère de celle d'un serveur faisant autorité, et **prouver** que sa liste de contrôle d'accès décide vraiment de qui il sert.

**Ce qu'il te faut.** Le TP 14 terminé. Un terminal sur `DNS-RES`, un sur `ROOT-NS` et un sur `PC-CONSEILLER`. Durée : environ 45 minutes. Les modifications de ce TP sont remises en état en fin de partie B.

### Partie A — Lire la configuration d'un résolveur

**Étape 1 — Le fichier principal.**

```
# sur DNS-RES
cat /etc/bind/named.conf
```

```
acl "agence" { 10.20.0.0/16; 127.0.0.0/8; };
options {
    directory "/var/cache/bind";
    recursion yes;
    allow-query { agence; };
    allow-recursion { agence; };
    dnssec-validation no;
    empty-zones-enable no;
};
zone "." { type hint; file "/etc/bind/db.root.hints"; };
zone "horizon.local" {
    type forward;
    forward only;
    forwarders { 10.20.20.10; };
};
```

Compare avec `NS1-BANK` (TP 14, étape 2) : le fichier est plus riche. Il contient quatre morceaux.

*L'ACL (ligne 1).*

```
acl "agence" { 10.20.0.0/16; 127.0.0.0/8; };
```

Une **ACL** (*access control list*) est une **liste d'adresses à laquelle on donne un nom**, pour la réutiliser. Celle-ci s'appelle `agence` et contient deux plages :

- `10.20.0.0/16` : toutes les adresses qui **commencent par `10.20`** (le `/16` veut dire « les 16 premiers bits, c'est-à-dire les deux premiers nombres, sont fixes »). C'est le réseau de l'agence ;
- `127.0.0.0/8` : toutes les adresses qui commencent par `127`, c'est-à-dire **la machine elle-même**.

*Les options (lignes 2 à 9).*

```
options {
    directory "/var/cache/bind";
    recursion yes;
    allow-query { agence; };
    allow-recursion { agence; };
    dnssec-validation no;
    empty-zones-enable no;
};
```

| Ligne | Sens |
|---|---|
| `recursion yes;` | Ce serveur **fait le travail** de résolution (§ I.8) — l'inverse de `NS1-BANK` |
| `allow-query { agence; };` | **Qui peut lui poser une question** : seulement la liste `agence` |
| `allow-recursion { agence; };` | **Pour qui il fait le travail** : seulement l'agence |
| `dnssec-validation no;`, `empty-zones-enable no;` | Réglages techniques du laboratoire, tu peux les ignorer |

*Les zones (lignes 10 à 15).* Il y en a deux, de natures différentes.

```
zone "." { type hint; file "/etc/bind/db.root.hints"; };
zone "horizon.local" {
    type forward;
    forward only;
    forwarders { 10.20.20.10; };
};
```

- `zone "." { type hint; … }` : la zone racine, de type **`hint`** (« conseil »). Elle ne contient pas la racine, elle dit **par où entrer dans l'arbre**. Sans ce bloc, le résolveur ne saurait pas où commencer.
- `zone "horizon.local" { type forward; forward only; forwarders { 10.20.20.10; }; }` : une **exception**. Pour le domaine `horizon.local` (le domaine privé de l'agence), ne pas descendre l'arbre depuis la racine, mais **transférer** la question à `DC1` (`10.20.20.10`), le seul à connaître cette zone. `forward only` veut dire « uniquement lui, et pas d'autre chemin ».

**Étape 2 — Le fichier d'amorçage.**

```
# sur DNS-RES
cat /etc/bind/db.root.hints
```

```
. 3600000 IN NS a.root-servers.net.
a.root-servers.net. 3600000 IN A 198.51.100.1
```

Deux lignes, c'est tout : le nom du serveur racine (`a.root-servers.net`) et son adresse (`198.51.100.1`). Le TTL très long (`3600000`) montre que cette liste est faite pour durer. C'est la première chose que ce résolveur sait, avant même d'avoir posé une question.

**Étape 3 — Retrouver les lignes qui comptent avec `grep`.**

```
# sur DNS-RES
grep -nE 'recursion|allow-|forwarders|listen-on' /etc/bind/named.conf
```

`grep` garde les lignes qui contiennent un mot. Ici, deux options : `-n` ajoute le **numéro de la ligne** devant chaque résultat, et `-E` permet d'écrire plusieurs mots possibles séparés par `|` (« ou »). C'est le moyen le plus rapide de retrouver toutes les lignes qui contrôlent qui est servi.

```
4:    recursion yes;
5:    allow-query { agence; };
6:    allow-recursion { agence; };
14:    forwarders { 10.20.20.10; };
```

Chaque ligne commence par son numéro dans le fichier (`4:`, `5:`…).

**Étape 4 — La zone racine du laboratoire.**

Pour comprendre d'où vient l'adresse `198.51.100.1`, regarde la zone racine, sur `ROOT-NS` :

```
# sur ROOT-NS
cat /etc/bind/db.root
```

```
$TTL 86400
. IN SOA a.root-servers.net. hostmaster.root-servers.net. ( 2026103101 1800 900 604800 86400 )
. IN NS a.root-servers.net.
a.root-servers.net. IN A 198.51.100.1
com. IN NS a.nic.com.
a.nic.com. IN A 198.51.100.2
113.0.203.in-addr.arpa. IN NS ns1.banquehorizon.com.
```

C'est un fichier de zone comme celui du TP 14, mais **minuscule** : la racine ne connaît que deux choses. Elle délègue `com.` à `a.nic.com` (lignes 5 et 6), et elle délègue la zone inverse `113.0.203.in-addr.arpa.` à `ns1.banquehorizon.com` (ligne 7). Tout le reste de l'Internet du laboratoire se trouve plus bas.

### Partie B — Prouver que l'ACL décide

On va **sortir volontairement les postes de l'agence de l'ACL**, voir ce qui se passe, puis tout remettre.

**Étape 5 — Changer l'ACL.**

```
# sur DNS-RES
sudo sed -i 's#10.20.0.0/16;#10.99.0.0/16;#' /etc/bind/named.conf; sudo rndc reconfig; grep -n acl /etc/bind/named.conf
```

Cette ligne fait trois choses :

1. `sed -i 's#10.20.0.0/16;#10.99.0.0/16;#' …` remplace `10.20.0.0/16` par `10.99.0.0/16` dans le fichier. (On utilise `#` à la place de `/` comme séparateur, parce que l'adresse contient déjà des `/`.)
2. `rndc reconfig` dit au serveur de **relire sa configuration**, sans le redémarrer et sans vider son cache.
3. `grep -n acl …` affiche la ligne modifiée pour que tu la contrôles.

```
1:acl "agence" { 10.99.0.0/16; 127.0.0.0/8; };
```

La liste `agence` désigne maintenant le réseau `10.99`, qui n'existe pas : les postes de l'agence (`10.20…`) n'y sont plus.

**Étape 6 — Interroger depuis l'agence.**

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.banquehorizon.com +noall +comments
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: REFUSED, id: 44
;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
```

`status: REFUSED` : le résolveur **refuse**. Regarde aussi les drapeaux : `qr rd`, **sans `ra`**. Il n'offre pas la récursion à *ce* client. C'est une réponse **explicite**, que le client peut afficher et journaliser.

**Étape 7 — Interroger depuis le résolveur lui-même.**

```
# sur DNS-RES
dig @127.0.0.1 www.banquehorizon.com +short
```

```
web.banquehorizon.com.
203.0.113.20
```

Lui-même est toujours servi : `127.0.0.0/8` est resté dans l'ACL.

**Étape 8 — Remettre l'ACL en état.**

```
# sur DNS-RES
sudo sed -i 's#10.99.0.0/16;#10.20.0.0/16;#' /etc/bind/named.conf; sudo rndc reconfig; grep -n acl /etc/bind/named.conf
```

```
1:acl "agence" { 10.20.0.0/16; 127.0.0.0/8; };
```

La ligne est revenue à `10.20.0.0/16`. Vérifie depuis l'agence :

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.banquehorizon.com +short
```

```
web.banquehorizon.com.
203.0.113.20
```

Les réponses reviennent : tout est en ordre.

**Étape 9 — Et depuis « Internet » ?**

Dans ce laboratoire, `ROOT-NS` est « sur Internet », hors du réseau privé de l'agence. Que se passe-t-il s'il interroge le résolveur ?

```
# sur ROOT-NS
dig @10.20.20.53 www.banquehorizon.com
```

```
;; communications error to 10.20.20.53#53: timed out
;; communications error to 10.20.20.53#53: timed out
;; communications error to 10.20.20.53#53: timed out

; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> @10.20.20.53 www.banquehorizon.com
; (1 server found)
;; global options: +cmd
;; no servers could be reached
```

Cette fois il n'y a **pas de réponse du tout** : `timed out`, trois fois, puis `no servers could be reached`. Les adresses privées (`10.20…`) ne sont pas routables sur Internet : la question n'arrive même pas jusqu'au résolveur. **L'ACL n'est donc pas la première barrière, c'est la seconde.**

**Deux manières d'échouer à distinguer.** Elles ne se corrigent pas au même endroit :

| Ce que tu vois | Signification | Où chercher |
|---|---|---|
| `status: REFUSED` | Le serveur **a reçu** la question et **a refusé** de répondre | La configuration du serveur : l'ACL (`allow-query`, `allow-recursion`) |
| `timed out` | La question **n'a pas reçu de réponse** | Le réseau : routage, pare-feu, serveur arrêté |

> 🔍 **Point d'audit** — `allow-recursion` est **le** contrôle qui empêche un résolveur d'être « ouvert » (utilisable par n'importe qui sur Internet pour des attaques par amplification). Teste-le comme ci-dessus — sortir ton propre poste de l'ACL et constater le `REFUSED` — et garde la trace du résultat.

🆘 **Si ça ne marche pas.** À l'étape 6, `NOERROR` au lieu de `REFUSED` : l'étape 5 ne s'est pas appliquée. Relis la ligne affichée par `grep -n acl` : elle doit montrer `10.99.0.0/16`. Si tu es bloqué, ré-importe le laboratoire (§ 0.1).

**🧠 Ce que tu viens d'apprendre.**

- Un **résolveur** a `recursion yes;`, une ACL qui limite ses clients, une zone `hint` qui lui dit par où commencer, et éventuellement des zones `forward` qui lui font demander à un autre serveur pour un domaine donné.
- Le bloc `forward` est la réponse à la question « comment un résolveur peut-il résoudre un nom **interne** ? » : il ne le fait pas lui-même, il **transfère** à `DC1` (TP 28).
- `rndc reconfig` applique un nouveau `named.conf` sans redémarrer ni vider le cache.
- Un client que l'ACL exclut reçoit `REFUSED` : une réponse **explicite**. Un silence (`timed out`) a une autre cause : le réseau.

**Vérifie-toi.**

1. Que contient l'ACL `agence` ?
2. Quel bloc dit au résolveur par où commencer ?
3. Quelle différence entre `REFUSED` et `timed out` ?

*Réponses.* (1) Le réseau de l'agence (`10.20.0.0/16`) et la machine elle-même (`127.0.0.0/8`). (2) `zone "." { type hint; … }`. (3) `REFUSED` : le serveur a répondu « non » ; `timed out` : aucune réponse n'est arrivée.

---
## VI.4 🧪 TP 17 — Les serveurs Windows

**🎯 Objectif.** Retrouver, avec les commandes PowerShell du module `DnsServer`, ce que tu viens de lire dans les fichiers BIND : des zones, des serveurs primaire et secondaire, des fiches.

**Ce qu'il te faut.** Trois terminaux PowerShell : `TLD-NS`, `DC1` et `NS2-BANK` (double-clic sur chaque équipement). Durée : environ 30 minutes. Dans ce TP, **tu ne modifies rien**.

Sous Linux, un serveur DNS se lit dans des fichiers texte. Sous Windows, il n'y a pas de fichiers à ouvrir à la main : on **interroge le serveur avec des commandes**. Le vocabulaire est un peu différent, mais le modèle est le même : des zones, un SOA, des NS, des A.

| BIND (Linux) | DNS Windows | Même idée |
|---|---|---|
| `type primary;` | `ZoneType : Primary` | Détient la copie de référence |
| `type secondary;` (côté `NS2-BANK`) | `ZoneType : Secondary` | Détient une copie recopiée |
| `cat db.banquehorizon.com` | `Get-DnsServerResourceRecord` | Lire les fiches d'une zone |
| `rndc status` | `Get-DnsServerZone` | Voir quelles zones le serveur détient |

**Étape 1 — Les zones d'un serveur : `Get-DnsServerZone`.** Commence par `TLD-NS`.

```powershell
# sur TLD-NS
Get-DnsServerZone
```

La commande suit la forme **Verbe-Nom** (§ III.4) : `Get-` (obtenir) `DnsServerZone` (les zones du serveur DNS).

```
ZoneName            : com
ZoneType            : Primary
DynamicUpdate       : NonsecureAndSecure
ReplicationScope    : None
IsDsIntegrated      : False
IsReverseLookupZone : False
IsAutoCreated       : False
IsPaused            : False
IsReadOnly          : False
IsSigned            : False
ZoneFile            : com.dns
MasterServers       : {}
SecureSecondaries   : TransferToZoneNameServer
SecondaryServers    : {}
Notify              : Notify
NotifyServers       : {}
RecordCount         : 7
```

Il y a dix-sept lignes ; les trois à retenir sont celles-ci :

| Ligne | Sens |
|---|---|
| `ZoneName : com` | Le nom de la zone : `TLD-NS` détient la zone `com` |
| `ZoneType : Primary` | Il détient la **copie de référence**. Équivalent de `type primary;` |
| `ZoneFile : com.dns` | Le fichier où Windows range la zone (tu n'as pas besoin de l'ouvrir) |
| `RecordCount : 7` | Le nombre de fiches de la zone |

Les autres lignes (`IsPaused`, `IsSigned`, `Notify`…) sont des réglages que tu n'as pas à connaître pour l'instant.

**Étape 2 — Les fiches d'une zone : `Get-DnsServerResourceRecord`.**

```powershell
# sur TLD-NS
Get-DnsServerResourceRecord -ZoneName com
```

`-ZoneName com` dit **quelle zone** lire. Le résultat est un tableau.

```
HostName          RecordType Type Timestamp TimeToLive RecordData                                       
--------          ---------- ---- --------- ---------- ----------                                       
@                 SOA           6                 3600 [7][900][600][86400][3600] ns1.com hostmaster.com
@                 NS            2                 3600 a.nic.com                                        
a.nic             A             1                 3600 198.51.100.2                                     
banquehorizon     NS            2                 3600 ns1.banquehorizon.com                            
banquehorizon     NS            2                 3600 ns2.banquehorizon.com                            
ns1.banquehorizon A             1                 3600 203.0.113.10                                     
ns2.banquehorizon A             1                 3600 203.0.113.11                                     
```

Une ligne par fiche. Lis les colonnes :

| Colonne | Sens |
|---|---|
| `HostName` | Le nom de la fiche, **relatif** à la zone (`@` désigne la zone elle-même, comme dans BIND) |
| `RecordType` | Le type : `SOA`, `NS`, `A`, `CNAME`… |
| `Type` | Le **numéro** de ce type (6 pour SOA, 2 pour NS, 1 pour A). Tu peux l'ignorer |
| `Timestamp` | Vide ici : cette fiche a été saisie à la main. Elle ne se remplit que pour les fiches inscrites automatiquement (voir l'étape 4) |
| `TimeToLive` | Le TTL en secondes |
| `RecordData` | La donnée |

Tu retrouves ce que tu as vu au TP 8 : cette zone ne contient que des **renvois**. Les deux lignes `banquehorizon NS …` sont la délégation vers la banque, et les deux lignes `ns1.banquehorizon`, `ns2.banquehorizon` en sont la **glue** (§ IV.2). Le SOA s'écrit ici `[7][900][600][86400][3600]` suivi du serveur et du responsable : `[numéro de série][refresh][retry][expire][minimum]`.

**Étape 3 — Le serveur du domaine de l'agence : `DC1`.**

```powershell
# sur DC1
Get-DnsServerZone
```

```
ZoneName            : horizon.local
ZoneType            : Primary
DynamicUpdate       : NonsecureAndSecure
```

On a gardé les trois premières lignes : `DC1` détient la zone **`horizon.local`**, domaine **privé** de l'agence, en `Primary`. `DynamicUpdate : NonsecureAndSecure` veut dire que les machines peuvent **s'inscrire elles-mêmes** dans cette zone. Regarde ce que ça donne :

```powershell
# sur DC1
Get-DnsServerResourceRecord -ZoneName horizon.local
```

```
HostName    RecordType Type          Timestamp TimeToLive RecordData                                                           
--------    ---------- ----          --------- ---------- ----------                                                           
@           SOA           6                          3600 [8][900][600][86400][3600] ns1.horizon.local hostmaster.horizon.local
dc1         A             1                          3600 10.20.20.10                                                          
dns-res     A             1                          3600 10.20.20.53                                                          
intranet    CNAME         5                          3600 dc1.horizon.local                                                    
pc-guichet1 A             1 11/4/2026 11:01 AM       1200 10.20.10.50                                                          
pc-guichet2 A             1 11/4/2026 11:01 AM       1200 10.20.10.51                                                          
```

Les trois premières fiches (`dc1`, `dns-res`, `intranet`) ont été saisies à la main. En revanche `pc-guichet1` et `pc-guichet2` ont un **`Timestamp`** rempli et un TTL court (`1200`, soit 20 minutes) : ces fiches ont été **inscrites toutes seules** par le serveur DHCP quand il a distribué leurs adresses (TP 29). La colonne `Timestamp` sert à distinguer, d'un coup d'œil, les fiches automatiques des fiches manuelles.

**Étape 4 — Le secondaire : `NS2-BANK`.**

```powershell
# sur NS2-BANK
Get-DnsServerZone
```

```
ZoneName            : banquehorizon.com
ZoneType            : Secondary
DynamicUpdate       : None
ReplicationScope    : None
IsDsIntegrated      : False
IsReverseLookupZone : False
IsAutoCreated       : False
IsPaused            : False
IsReadOnly          : True
IsSigned            : False
ZoneFile            : banquehorizon.com.dns
MasterServers       : {203.0.113.10}
SecureSecondaries   : TransferToZoneNameServer
SecondaryServers    : {}
Notify              : Notify
NotifyServers       : {}
RecordCount         : 18
```

Compare avec l'étape 1. Deux lignes changent, et elles comptent :

- `ZoneType : Secondary` : `NS2-BANK` ne détient pas la zone, il en a une **copie**.
- `MasterServers : {203.0.113.10}` : il recopie depuis `203.0.113.10`, c'est-à-dire `NS1-BANK`.
- `IsReadOnly : True` : cette copie est en **lecture seule**. On ne la modifie pas ici, on la modifie sur le primaire.

La sortie complète comporte un second bloc, identique, pour la zone inverse `113.0.203.in-addr.arpa` (avec `IsReverseLookupZone : True`).

**Étape 5 — Compter les fiches d'une zone.**

```powershell
# sur NS2-BANK
(Get-DnsServerZone -Name banquehorizon.com).RecordCount
```

Les parenthèses disent à PowerShell : « exécute d'abord la commande à l'intérieur, puis lis sa propriété `RecordCount` ». On n'obtient que ce nombre.

```
18
```

`18` : la copie contient 18 fiches. C'est le nombre de fiches qu'`NS2-BANK` a reçues lors du **transfert de zone** : il a recopié la zone de `NS1-BANK`. Retiens ce chiffre : au TP 18, tu verras comment il bouge quand on modifie la zone sur le primaire.

🆘 **Si ça ne marche pas.** `The term 'Get-DnsServerZone' is not recognized` : tu es sur un équipement qui n'est pas un serveur DNS Windows (un poste, par exemple). Vérifie le titre du terminal : `TLD-NS`, `DC1` ou `NS2-BANK`.

**🧠 Ce que tu viens d'apprendre.**

- Le vocabulaire change, pas le modèle : `Primary` / `Secondary` / `MasterServers`, un SOA, des NS, des A. `Get-DnsServerResourceRecord` écrit le SOA `[numéro de série][refresh][retry][expire][minimum]`.
- Un serveur secondaire a `ZoneType : Secondary`, un `MasterServers` qui nomme le primaire, et une copie en lecture seule.
- Dans une zone Windows, les clients DHCP peuvent s'enregistrer eux-mêmes (`DynamicUpdate : NonsecureAndSecure`) ; dans une zone BIND de type `primary` sans `allow-update`, ce n'est pas le cas. C'est une différence à connaître avant de mélanger les deux familles (TP 29).
- Les serveurs Windows de ce laboratoire annoncent `udp: 4096` dans l'enregistrement `OPT` (TP 8), BIND `1232` : même protocole, valeurs par défaut différentes.

**Vérifie-toi.**

1. Comment sait-on, sous Windows, qu'un serveur détient une copie et non la zone de référence ?
2. À quoi sert la colonne `Timestamp` de `Get-DnsServerResourceRecord` ?

*Réponses.* (1) `ZoneType : Secondary` et `MasterServers` qui nomme le primaire. (2) Elle n'est remplie que pour les fiches inscrites automatiquement (par le DHCP, par exemple).

---
## VI.5 🧪 TP 18 — Modifier une zone et la voir arriver chez le secondaire

**🎯 Objectif.** Faire un changement **complet** : modifier la zone sur le primaire, la recharger, et **prouver** qu'elle est arrivée sur le secondaire (qui est, ici, un serveur *Windows*).

**Ce qu'il te faut.** Les TP 14 et 15 terminés. Un terminal sur `NS1-BANK`, un sur `PC-CONSEILLER`, un sur `PC-GUICHET1` et un sur `NS2-BANK`. Durée : environ 1 heure. Tout est remis en état à la fin.

**Pourquoi deux serveurs ?** Si `NS1-BANK` tombe, le domaine `banquehorizon.com` ne doit pas disparaître. On a donc un deuxième serveur, `NS2-BANK`, qui détient une **copie** de la zone. Cette copie doit rester à jour sans que personne ne la recopie à la main. Voici comment le DNS s'y prend :

```schema
 1. L'administrateur modifie la zone sur NS1-BANK, et AUGMENTE le numéro de série
 2. NS1-BANK recharge la zone
 3. NS1-BANK envoie un « NOTIFY » à NS2-BANK : « ma zone a changé »
 4. NS2-BANK demande le SOA de NS1-BANK et compare les numéros de série
 5. Si celui de NS1-BANK est plus grand : NS2-BANK demande toute la zone (transfert « AXFR »)
 6. NS2-BANK répond désormais avec la nouvelle version
```

Le **numéro de série** est donc le déclencheur : s'il n'augmente pas, le secondaire ne bouge pas (c'est le piège du TP 19).

### Partie A — L'état de départ

**Étape 1 — Les deux serveurs sont-ils d'accord ?** Compare le SOA des deux serveurs (TP 11, étape 6).

```
# sur PC-CONSEILLER
dig @203.0.113.10 banquehorizon.com SOA +short
```

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

```
# sur PC-CONSEILLER
dig @203.0.113.11 banquehorizon.com SOA +short
```

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

Les deux serveurs annoncent le **même** numéro de série : `2026103101`. Le secondaire est à jour. Rappelle-toi aussi que `NS2-BANK` a **18 fiches** (TP 17, étape 5).

### Partie B — Faire le changement

On va ajouter une fiche `api2` à la zone. Sur `NS1-BANK`.

**Étape 2 — Augmenter le numéro de série.**

```
# sur NS1-BANK
sudo sed -i 's/2026103101/2026103102/' /etc/bind/db.banquehorizon.com
```

`sed -i 's/ancien/nouveau/'` remplace `2026103101` par `2026103102` dans le fichier. La commande n'affiche rien. **Ce geste est celui qu'on oublie le plus souvent.**

**Étape 3 — Ajouter la fiche.**

```
# sur NS1-BANK
echo 'api2 IN A 203.0.113.30' | sudo tee -a /etc/bind/db.banquehorizon.com
```

`echo` produit le texte, `tee -a` l'**ajoute à la fin** du fichier (§ I.2) et l'affiche.

```
api2 IN A 203.0.113.30
```

**Étape 4 — Vérifier avant de recharger.** Tu connais la règle d'or du TP 15.

```
# sur NS1-BANK
named-checkzone banquehorizon.com /etc/bind/db.banquehorizon.com
```

```
zone banquehorizon.com/IN: loaded serial 2026103102
OK
```

`loaded serial 2026103102` : le nouveau numéro est lu. `OK` : aucune erreur.

**Étape 5 — Recharger.**

```
# sur NS1-BANK
sudo rndc reload banquehorizon.com
```

```
zone reload queued
```

### Partie C — Prouver que le secondaire a suivi

**Étape 6 — Comparer les deux SOA.**

```
# sur PC-CONSEILLER
dig @203.0.113.10 banquehorizon.com SOA +short
```

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103102 7200 900 1209600 3600
```

```
# sur PC-CONSEILLER
dig @203.0.113.11 banquehorizon.com SOA +short
```

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103102 7200 900 1209600 3600
```

Les deux serveurs annoncent maintenant `2026103102`. `NS2-BANK` a reçu le `NOTIFY`, comparé, et recopié. **Comparer les SOA des deux serveurs est la preuve en une commande** de la cohérence primaire/secondaire : deux numéros différents = un secondaire en retard.

**Étape 7 — Interroger le secondaire (Windows) sur le nouveau nom.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName api2.banquehorizon.com -Server 203.0.113.11
```

Le paramètre `-Server` choisit **le serveur à interroger** (§ III.3), ici `NS2-BANK`.

```
Name      : api2.banquehorizon.com
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 203.0.113.30
```

`NS2-BANK` — un serveur **Windows** — répond pour `api2`, une fiche qui n'existait pas il y a une minute. Elle vient du transfert.

**Étape 8 — Compter les fiches.**

```powershell
# sur NS2-BANK
(Get-DnsServerZone -Name banquehorizon.com).RecordCount
```

```
19
```

`19` au lieu de `18` : la copie a une fiche de plus.

### Partie D — Le test de sécurité

**Étape 9 — Demander la zone entière à `NS1-BANK` lui-même.**

Un **transfert de zone** (`AXFR`) copie la zone en entier. Le secondaire en a besoin ; un inconnu ne doit pas pouvoir le faire, car il obtiendrait **la liste complète de tes machines**. Tu as vu au TP 14 que `allow-transfer { 203.0.113.11; };` ne permet le transfert qu'à `NS2-BANK`. Prouve-le en le demandant depuis la machine locale :

```
# sur NS1-BANK
dig @127.0.0.1 banquehorizon.com AXFR
```

```
; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> @127.0.0.1 banquehorizon.com AXFR
; (1 server found)
;; global options: +cmd
; Transfer failed.
```

`Transfer failed.` est la **bonne** réponse : `NS1-BANK` refuse, car la machine locale n'est pas dans `allow-transfer`.

### Partie E — Remise en état

**Étape 10 — Supprimer `api2` et passer à `…03`.**

```
# sur NS1-BANK
sudo sed -i '/^api2 /d; s/2026103102/2026103103/' /etc/bind/db.banquehorizon.com; sudo rndc reload banquehorizon.com
```

Cette ligne contient deux ordres à `sed`, séparés par `;` : `/^api2 /d` **supprime** la ligne qui commence par `api2`, et `s/2026103102/2026103103/` monte encore le numéro de série (un serveur secondaire ne suit qu'un numéro qui **augmente**, jamais un numéro qui redescend).

```
zone reload queued
```

Contrôle que le secondaire a suivi :

```
# sur PC-CONSEILLER
dig @203.0.113.11 banquehorizon.com SOA +short
```

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103103 7200 900 1209600 3600
```

```
# sur PC-CONSEILLER
dig @203.0.113.11 api2.banquehorizon.com +noall +comments
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 53
;; flags: qr aa rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 4096
```

Le numéro de série est `2026103103` et `api2` a disparu (`NXDOMAIN`). Remarque `flags: qr aa` : `NS2-BANK`, qui n'est pourtant qu'un secondaire, **fait autorité** : une copie fidèle d'une zone est une source officielle au même titre que l'original.

> 🔍 **Point d'audit** — Collecte, à chaque changement, les SOA des deux serveurs (étape 6) : c'est la preuve de la cohérence primaire/secondaire à la date du changement.

🆘 **Si ça ne marche pas.**

- Étape 6 : les deux numéros de série sont différents. Attends dix secondes et relance : le `NOTIFY` met un instant à produire son effet.
- Étape 7 : `DNS name does not exist` pour `api2` : tu as oublié l'étape 2 (le numéro de série n'a pas augmenté, voir le TP 19).
- Étape 9 : le transfert réussit (tu vois toute la zone) : `allow-transfer` a été modifié. Relis `named.conf` (TP 14).

**🧠 Ce que tu viens d'apprendre.**

- Le circuit complet d'un changement : **modifier → monter le numéro de série → vérifier → recharger → `NOTIFY` → le secondaire compare les séries → transfert (`AXFR`) → il répond**. Le `NOTIFY` évite d'attendre le *refresh* (7 200 s) du SOA.
- La preuve la plus courte : **comparer les SOA des deux serveurs**.
- `Transfer failed.` pour un `AXFR` non autorisé est le **bon** résultat. Un transfert de zone ouvert à tous livre à un attaquant la liste complète de tes machines.
- Un secondaire est une source **faisant autorité** (`aa`) comme le primaire.

**Vérifie-toi.**

1. Quel geste déclenche la mise à jour du secondaire ?
2. Comment prouver, en une commande, que le secondaire est à jour ?
3. Pourquoi un `AXFR` refusé est-il une bonne nouvelle ?

*Réponses.* (1) L'augmentation du numéro de série dans le SOA, suivie du rechargement de la zone. (2) Comparer le SOA des deux serveurs (`dig @serveur zone SOA +short`). (3) Parce que seul le secondaire autorisé doit pouvoir copier la zone entière.

---
## VI.6 🧪 TP 19 — Le piège du numéro de série oublié

**🎯 Objectif.** Vivre l'incident le plus fréquent des zones à plusieurs serveurs : *modifier la zone, recharger, et oublier de monter le numéro de série*.

**Ce qu'il te faut.** Le TP 18 terminé (la zone est revenue à l'état normal, avec le numéro de série `2026103103`). Un terminal sur `NS1-BANK` et un sur `PC-CONSEILLER`. Durée : environ 25 minutes.

Au TP 18, tu as fait **tout juste**, dans l'ordre. Ici, tu vas faire exactement la même chose en **omettant une seule étape** : celle que les administrateurs oublient le plus souvent. Tu vas voir l'incident naître, comprendre son symptôme, puis le réparer.

**Étape 1 — Ajouter une fiche et recharger, sans toucher au numéro de série.** Sur `NS1-BANK` :

```
# sur NS1-BANK
echo 'novelty IN A 203.0.113.77' | sudo tee -a /etc/bind/db.banquehorizon.com; sudo rndc reload banquehorizon.com
```

Deux commandes sur une ligne, séparées par `;` : on ajoute la fiche `novelty` à la fin du fichier, puis on recharge.

```
novelty IN A 203.0.113.77
zone reload queued
```

La fiche est ajoutée, le rechargement est enregistré. **On n'a pas touché au numéro de série.**

**Étape 2 — Interroger le primaire.** Sur `PC-CONSEILLER` :

```
# sur PC-CONSEILLER
dig @203.0.113.10 novelty.banquehorizon.com +short
```

```
203.0.113.77
```

`NS1-BANK` connaît `novelty` : il a rechargé son fichier.

**Étape 3 — Interroger le secondaire.**

```
# sur PC-CONSEILLER
dig @203.0.113.11 novelty.banquehorizon.com +noall +comments
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 57
;; flags: qr aa rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 4096
```

`status: NXDOMAIN` : **`NS2-BANK` ne connaît pas `novelty`**. Remarque `flags: qr aa` : il répond avec autorité, donc avec assurance, mais il répond **faux**. Les deux serveurs de la même zone disent maintenant des choses différentes.

**Étape 4 — Chercher pourquoi : comparer les numéros de série.**

```
# sur PC-CONSEILLER
dig @203.0.113.10 banquehorizon.com SOA +short; dig @203.0.113.11 banquehorizon.com SOA +short
```

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103103 7200 900 1209600 3600
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103103 7200 900 1209600 3600
```

Les deux numéros de série sont **identiques** (`2026103103`). Pour `NS2-BANK`, rien n'a changé : il compare les numéros de série, voit qu'ils sont égaux et **ne recopie rien** (rappel : étape 4 du circuit du TP 18). Voilà le coupable.

**Étape 5 — Recharger ne sert à rien.**

```
# sur NS1-BANK
sudo rndc reload banquehorizon.com
```

```
zone reload up-to-date
```

`up-to-date` : le primaire dit « mon fichier est déjà chargé ». Le problème n'est pas chez lui, il est dans le **numéro de série**.

**Étape 6 — Réparer : monter le numéro de série et recharger.**

```
# sur NS1-BANK
sudo sed -i 's/2026103103/2026103104/' /etc/bind/db.banquehorizon.com; sudo rndc reload banquehorizon.com
```

```
zone reload queued
```

Le numéro passe à `2026103104` : il est **plus grand** que celui du secondaire. Le `NOTIFY` part, le secondaire compare, voit que le primaire est en avance, et recopie. Vérifie :

```
# sur PC-CONSEILLER
dig @203.0.113.11 novelty.banquehorizon.com +short
```

```
203.0.113.77
```

Cette fois `NS2-BANK` connaît `novelty`.

**Étape 7 — Remise en état.**

```
# sur NS1-BANK
sudo sed -i '/^novelty /d; s/2026103104/2026103105/' /etc/bind/db.banquehorizon.com; sudo rndc reload banquehorizon.com
```

```
zone reload queued
```

On supprime la fiche `novelty` et on **monte encore** le numéro de série, pour que le secondaire retire la fiche lui aussi. Contrôle :

```
# sur PC-CONSEILLER
dig @203.0.113.11 novelty.banquehorizon.com +noall +comments
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 61
;; flags: qr aa rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 4096
```

`NXDOMAIN` : la fiche a disparu des deux côtés.

🆘 **Si ça ne marche pas.** À l'étape 3, `NS2-BANK` répond déjà `203.0.113.77` : il a eu le temps de recopier, ce qui ne devrait pas arriver sans série plus grande. Vérifie à l'étape 4 que les deux numéros de série sont bien égaux ; sinon, tu as monté le numéro sans t'en apercevoir.

**🧠 Ce que tu viens d'apprendre.**

- **Le primaire se recharge à partir du fichier ; le secondaire ne compare que le numéro de série.** Sans série plus grand, aucun transfert : pendant des heures, des jours même, les deux serveurs répondent **différemment** à la même question, et c'est l'ordre d'interrogation du résolveur qui décide de ce que voit l'utilisateur.
- C'est le symptôme le plus déroutant du DNS : « ça marche pour moi, pas pour lui ». La première question devant un tel symptôme est toujours : **les SOA sont-ils identiques ?**
- Une automatisation sûre monte la série **dans la même opération** que la modification. Le format `AAAAMMJJNN` aide : on lit la date du dernier changement dans le numéro.

⚠️ **Attention** — Monter le numéro de série *trop haut* (au-delà de 2³² − 1) ou le **faire redescendre** est pire que l'oublier : un secondaire ignore les séries plus petites que les siennes (RFC 1982, arithmétique de série). Ne reviens jamais en arrière sans une procédure explicite.

**Vérifie-toi.**

1. Tu as modifié une zone et rechargé le primaire, mais le secondaire répond encore l'ancienne version. Quelle est ta première vérification ?
2. Pourquoi ne faut-il jamais faire redescendre le numéro de série ?

*Réponses.* (1) Comparer le SOA (donc le numéro de série) du primaire et du secondaire. (2) Un secondaire ignore les numéros plus petits que le sien : il ne se remettrait plus à jour.

---
## VI.7 ⭐ 🧪 TP 20 — Créer sa propre zone et la brancher dans l'arbre

**🎯 Objectif.** Publier une **nouvelle zone** (`exemple.test`) sur `NS1-BANK`, constater qu'elle répond *chez elle* mais reste **invisible** du reste du monde, puis la rattacher à l'arbre par une **délégation**.

**Ce qu'il te faut.** Les TP 14 à 19 terminés. Un terminal sur `NS1-BANK`, un sur `ROOT-NS`, un sur `DNS-RES`, un sur `PC-CONSEILLER`. Durée : environ 1 heure. C'est le TP de synthèse de la Partie VI (⭐) : il réutilise tout ce que tu as appris. Tout est remis en état à la fin.

**Le principe.** Créer une zone, c'est faire **deux choses indépendantes** :

```schema
 1. HÉBERGER la zone      →  NS1-BANK détient les données de exemple.test (un fichier + une ligne dans named.conf)
 2. PUBLIER la zone       →  le PARENT (ici la racine) déclare « test. est délégué à NS1-BANK »
```

Tu vas faire la première, constater que ça ne suffit pas, puis faire la seconde. C'est la situation d'un domaine qu'on vient d'acheter : tant que le registre n'a pas enregistré tes serveurs de noms, personne ne le trouve.

### Partie A — Héberger la zone

**Étape 1 — Écrire le fichier de zone.**

```
# sur NS1-BANK
sudo tee /etc/bind/db.exemple.test <<'EOF'
$TTL 3600
@ IN SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. ( 1 7200 900 1209600 3600 )
@ IN NS ns1.banquehorizon.com.
www IN A 203.0.113.40
EOF
```

Cette commande écrit **plusieurs lignes d'un coup** dans un fichier. `<<'EOF'` signifie « tout ce qui suit, jusqu'à la ligne `EOF`, est le texte à envoyer ». `tee` l'écrit dans `/etc/bind/db.exemple.test` (et l'affiche).

```
$TTL 3600
@ IN SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. ( 1 7200 900 1209600 3600 )
@ IN NS ns1.banquehorizon.com.
www IN A 203.0.113.40
```

Lis le contenu : c'est une zone minimale, comme celle du TP 14. Elle contient son SOA (numéro de série `1`), un NS et une machine `www` qui vaut `203.0.113.40`. Remarque qu'**il n'y a pas de ligne `$ORIGIN`** : BIND prend alors, comme origine, le nom de la zone déclarée dans `named.conf`.

**Étape 2 — Déclarer la zone dans `named.conf`.**

```
# sur NS1-BANK
sudo tee -a /etc/bind/named.conf <<'EOF'
zone "exemple.test" { type primary; file "/etc/bind/db.exemple.test"; };
EOF
```

`tee -a` **ajoute** (`-a`, *append*) à la fin du fichier, sans effacer ce qui existe.

```
zone "exemple.test" { type primary; file "/etc/bind/db.exemple.test"; };
```

C'est le bloc `zone` du TP 14 (étape 2), écrit sur une seule ligne.

**Étape 3 — Vérifier. Toujours.**

```
# sur NS1-BANK
named-checkzone exemple.test /etc/bind/db.exemple.test
```

```
zone exemple.test/IN: loaded serial 1
OK
```

```
# sur NS1-BANK
named-checkconf; echo rc=$?
```

```
rc=0
```

La zone est lue (`loaded serial 1`) et la configuration est correcte (`rc=0`) : on peut appliquer.

**Étape 4 — Prendre en compte la nouvelle zone.**

```
# sur NS1-BANK
sudo rndc reconfig
```

`rndc reconfig` relit `named.conf` et charge les zones **nouvelles**, sans toucher aux autres et sans vider les caches. (Pour une zone qui **existe déjà**, c'est `rndc reload` — TP 15.) La commande n'affiche rien : le silence veut dire que ça a marché.

**Étape 5 — Interroger la nouvelle zone directement.**

```
# sur PC-CONSEILLER
dig @203.0.113.10 www.exemple.test +norecurse +noall +comments +answer
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 62
;; flags: qr aa; QUERY: 1, ANSWER: 1, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; ANSWER SECTION:
www.exemple.test.	3600	IN	A	203.0.113.40
```

`NS1-BANK` répond : `status: NOERROR`, la réponse est présente, et `flags: qr aa` — il **fait autorité**. Interrogée chez elle, la zone fonctionne.

### Partie B — Constater que personne ne la voit

**Étape 6 — Poser la même question par le chemin normal.** Au lieu d'interroger `NS1-BANK` directement, passe par le résolveur de l'agence.

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.exemple.test +noall +comments +answer +authority
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 63
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; AUTHORITY SECTION:
.			10800	IN	SOA	a.root-servers.net. hostmaster.root-servers.net. 2026103101 1800 900 604800 86400
```

`status: NXDOMAIN` : **le résolveur ne connaît pas ce nom.** Regarde la section `AUTHORITY` : c'est le SOA de la **racine** (`.`), qui dit « ce nom n'existe pas ». Le résolveur est parti de la racine (§ I.9), et la racine ne sait pas que `test.` existe. La zone est bien hébergée, mais **elle n'est branchée à rien**.

### Partie C — Publier : déléguer depuis le parent

Pour que la racine renvoie vers `NS1-BANK` quand on lui parle de `test.`, il faut lui déclarer la délégation, c'est-à-dire une fiche `NS`.

**Étape 7 — Déclarer la délégation sur la racine.**

```
# sur ROOT-NS
echo 'test. IN NS ns1.banquehorizon.com.' | sudo tee -a /etc/bind/db.root
```

```
test. IN NS ns1.banquehorizon.com.
```

On ajoute à la zone racine une fiche `NS` : « le domaine `test.` est tenu par `ns1.banquehorizon.com` ». Puis on recharge la racine :

```
# sur ROOT-NS
sudo rndc reload
```

```
server reload successful
```

**Étape 8 — Vider le cache du résolveur.**

```
# sur DNS-RES
sudo rndc flush
```

À l'étape 6, `DNS-RES` a **mémorisé** que `www.exemple.test` n'existe pas (c'est le *cache négatif*, TP 22). S'il le garde en mémoire, il répondra encore « n'existe pas » malgré la délégation. On le vide pour repartir de zéro (la commande n'affiche rien).

**Étape 9 — Reposer la question.**

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.exemple.test +noall +comments +answer +authority
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 64
;; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 1, ADDITIONAL: 2

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; ANSWER SECTION:
www.exemple.test.	3600	IN	A	203.0.113.40

;; AUTHORITY SECTION:
exemple.test.		3600	IN	NS	ns1.banquehorizon.com.
```

Cette fois : `NOERROR` et la réponse `203.0.113.40`. La section `AUTHORITY` donne le serveur de la zone, `ns1.banquehorizon.com`. Le résolveur a trouvé le chemin.

**Étape 10 — Voir le chemin avec `+trace`.**

```
# sur PC-CONSEILLER
dig +trace @10.20.20.53 www.exemple.test
```

```
; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> +trace @10.20.20.53 www.exemple.test
; (1 server found)
;; global options: +cmd
.			86400	IN	NS	a.root-servers.net.
;; Received 48 bytes from 10.20.20.53#53(10.20.20.53) in 0 ms

test.			86400	IN	NS	ns1.banquehorizon.com.
;; Received 69 bytes from 198.51.100.1#53(198.51.100.1) in 0 ms

www.exemple.test.	3600	IN	A	203.0.113.40
;; Received 85 bytes from 203.0.113.10#53(203.0.113.10) in 0 ms
```

Tu retrouves les paragraphes du TP 7 :

1. `DNS-RES` donne la racine ;
2. la racine **renvoie** vers `ns1.banquehorizon.com` pour `test.` : c'est la délégation que tu viens d'écrire ;
3. `203.0.113.10` (`NS1-BANK`) répond avec l'adresse.

**Pourquoi pas de glue ici ?** Le serveur de la nouvelle zone (`ns1.banquehorizon.com`) se trouve dans **une autre zone** (`banquehorizon.com`) : le résolveur peut retrouver son adresse par une question à part. Si le serveur avait été **dans** la zone déléguée (`ns1.exemple.test`), la glue aurait été obligatoire (TP 8).

### Partie D — Remise en état

Il faut défaire les trois choses, dans cet ordre :

```
# sur ROOT-NS
sudo sed -i '/^test\. IN NS/d' /etc/bind/db.root; sudo rndc reload
```

```
server reload successful
```

On supprime la délégation de la racine.

```
# sur NS1-BANK
sudo sed -i '/exemple.test/d' /etc/bind/named.conf; sudo rm /etc/bind/db.exemple.test; sudo rndc reconfig
```

On supprime de `named.conf` la ligne de la zone, on efface le fichier de zone (`rm`), et on recharge la configuration.

```
# sur DNS-RES
sudo rndc flush
```

On vide le cache du résolveur. Vérifie que la zone a disparu :

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.exemple.test +noall +comments
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 70
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
```

`NXDOMAIN` : le laboratoire est revenu à l'état d'avant le TP.

> 🔍 **Point d'audit** — Une zone qui répond « chez elle » mais n'est pas déléguée est une **zone fantôme** : elle passe tous les tests locaux et échoue pour les utilisateurs. Contrôle toujours avec un `dig +trace` depuis un poste qui n'a pas accès au serveur d'autorité.

🆘 **Si ça ne marche pas.**

- À l'étape 9, toujours `NXDOMAIN` : tu as oublié l'étape 8 (le résolveur se souvient de son « non ») ou la délégation n'est pas rechargée (étape 7, deuxième commande).
- `named-checkzone` affiche une erreur à l'étape 3 : une ligne du fichier a été mal recopiée. Reprends la commande de l'étape 1.
- À la remise en état, `sed` ne supprime rien : vérifie avec `cat /etc/bind/db.root`.

**🧠 Ce que tu viens d'apprendre.**

- Créer une zone, c'est **deux** choses : (1) *héberger* les données (`zone … { type primary; file … };` + un fichier) ; (2) *publier* la zone par une **délégation** (`NS`) dans la zone parente. Sans la deuxième, la zone existe mais personne ne sait l'atteindre.
- `rndc reconfig` charge les zones **nouvelles** ; `rndc reload` relit les zones existantes ; `rndc flush` vide le cache.
- Un nom qui n'existait pas peut être **mémorisé comme inexistant** par un résolveur : après un changement, il faut parfois vider son cache (Partie VII).

**Vérifie-toi.**

1. Quelles sont les deux choses nécessaires pour qu'une nouvelle zone soit atteignable par tous ?
2. Pourquoi a-t-il fallu vider le cache de `DNS-RES` à l'étape 8 ?

*Réponses.* (1) L'héberger (fichier + déclaration dans `named.conf`), et la déléguer depuis la zone parente. (2) Parce qu'il avait retenu que le nom n'existe pas (cache négatif) et continuerait de le dire.

---

# Partie VII — Le cache

Au § I.10, tu as appris l'idée : un résolveur ne redemande pas cent fois la même chose, il **garde la réponse en mémoire** pendant le temps que dit le TTL. Ce mécanisme rend le DNS rapide. Il rend aussi ses pannes **lentes à disparaître** : un enregistrement corrigé sur le serveur peut rester faux, chez les clients, pendant toute sa durée de vie.

Il n'y a pas **un** cache, il y en a plusieurs, empilés entre l'utilisateur et la zone d'autorité :

```schema
 application ─► cache du POSTE ─► cache du RÉSOLVEUR ─► (éventuel transmetteur, DC1, avec son cache) ─► serveur d'AUTORITÉ
   (ping, dig)     Windows : oui     BIND (DNS-RES) : oui                                                  la vérité
                   Linux : le stub
```

Quand « ça ne marche pas pour lui mais ça marche pour moi », il faut se demander **dans quel cache** la mauvaise réponse est restée. Six TP pour voir, lire et vider chacun de ces caches.

---

## VII.1 🧪 TP 21 — Le TTL qui décroît

**🎯 Objectif.** *Voir* le temps passer dans un cache : la même réponse, posée deux fois à cinq secondes d'intervalle, ne porte pas le même TTL.

**Ce qu'il te faut.** Un terminal sur `DNS-RES` et un sur `PC-CONSEILLER`. Durée : environ 15 minutes.

**Étape 1 — Vider le cache du résolveur.** Pour que l'expérience soit propre, on part d'un résolveur qui n'a rien en mémoire.

```
# sur DNS-RES
sudo rndc flush
```

`rndc flush` efface le cache de `DNS-RES`. La commande n'affiche rien : le silence veut dire que ça a marché (TP 9).

**Étape 2 — Poser la question à un résolveur vide.**

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.banquehorizon.com +noall +answer +stats
```

Tu interroges directement `DNS-RES` (`@10.20.20.53`, TP 3) et tu demandes la réponse plus le pied de page (`+stats`).

```
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
;; Query time: 0 msec
;; SERVER: 10.20.20.53#53(10.20.20.53) (UDP)
;; WHEN: Wed Nov 04 10:28:50 UTC 2026
;; MSG SIZE  rcvd: 152
```

`DNS-RES` n'avait rien en mémoire : il a dû **descendre l'arbre** (TP 7) pour répondre. La réponse porte le TTL d'origine, celui de la zone : `3600`.

**Étape 3 — Attendre cinq secondes.**

```
# sur PC-CONSEILLER
sleep 5
```

`sleep 5` ne fait qu'attendre cinq secondes, puis rend la main. Il n'affiche rien.

**Étape 4 — Reposer exactement la même question.**

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.banquehorizon.com +noall +answer
```

```
www.banquehorizon.com.	3595	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3595	IN	A	203.0.113.20
```

Compare les deux chiffres : `3600` devient `3595`. Cette fois, `DNS-RES` n'a **pas** redescendu l'arbre : il a répondu **depuis sa mémoire**, et le TTL qu'il annonce est ce qu'il **reste à vivre** à la fiche : 3 600 moins les 5 secondes écoulées.

> 💡 Le `Query time` est le même (`0 msec`) dans les deux cas : le laboratoire est un réseau sans latence mesurable. Sur un vrai réseau, la première question serait plus lente que la seconde, et c'est la façon la plus simple de mesurer l'efficacité d'un cache.

🆘 **Si ça ne marche pas.** Le deuxième TTL est encore `3600` : tu as relancé la commande avant la fin des 5 secondes, ou tu as sauté l'étape 3. Recommence à l'étape 1.

**🧠 Ce que tu viens d'apprendre.**

- Le TTL d'une réponse de cache n'est **pas** le TTL de la zone : c'est ce qu'il **reste** à vivre à la fiche dans la mémoire du résolveur. Il part de la valeur de la zone, descend d'une seconde par seconde, et à zéro la fiche disparaît : la prochaine question redescend l'arbre.
- Cela explique deux phrases que tu entendras souvent : « le changement est fait mais certains voient encore l'ancienne adresse » (leur résolveur n'a pas encore atteint zéro) et « on a baissé le TTL **avant** le changement » (pour que le délai d'attente soit court le jour J).

> 🔍 **Point d'audit** — Le TTL est un compromis à **documenter** : un TTL long (24 h) soulage le serveur et masque une panne de ses serveurs, un TTL court (60 s) accélère les changements et multiplie les requêtes. Note, pour chaque enregistrement critique, le TTL choisi et pourquoi.

**Vérifie-toi.**

1. Pourquoi le TTL de la deuxième réponse est-il plus petit ?
2. Pourquoi baisse-t-on le TTL *avant* un changement d'adresse ?

*Réponses.* (1) Parce qu'il indique le temps qui reste à la fiche dans le cache, et que cinq secondes se sont écoulées. (2) Pour que les anciens caches expirent vite après le changement.

---

## VII.2 🧪 TP 22 — Le cache négatif

**🎯 Objectif.** Constater qu'un résolveur retient aussi les **réponses négatives** — « ce nom n'existe pas », « ce type n'existe pas » — et pour combien de temps.

**Ce qu'il te faut.** Le TP 21 terminé. Un terminal sur `PC-CONSEILLER`. Durée : environ 15 minutes.

**Étape 1 — Un nom qui n'existe pas.**

```
# sur PC-CONSEILLER
dig @10.20.20.53 nexiste.banquehorizon.com +noall +comments +authority
```

Tu as déjà vu cette commande au TP 13.

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 42
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	SOA	ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

`NXDOMAIN`, et la section `AUTHORITY` porte le SOA de la zone avec le TTL `3600`. C'est lui qui fixe pour combien de temps le résolveur retient cette absence.

**Étape 2 — Un nom qui existe, mais pas ce type.**

```
# sur PC-CONSEILLER
dig @10.20.20.53 web.banquehorizon.com AAAA +noall +comments +authority
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 43
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	SOA	ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

Même fiche SOA, mais `NOERROR` : c'est le NODATA du TP 13. Le résolveur retient aussi celui-là.

**Étape 3 — Attendre, puis reposer la première question.**

```
# sur PC-CONSEILLER
sleep 5
```

```
# sur PC-CONSEILLER
dig @10.20.20.53 nexiste.banquehorizon.com +noall +comments +authority
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 44
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; AUTHORITY SECTION:
banquehorizon.com.	3595	IN	SOA	ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

Regarde la dernière ligne : le **même SOA**, mais avec un TTL de **3595**. Le résolveur n'est pas allé reposer la question à `NS1-BANK` : il a répondu depuis sa mémoire, et l'**absence** a vieilli comme une présence.

⚠️ **Attention — le piège classique.** Un administrateur crée l'enregistrement `nouveau.banquehorizon.com`, mais le teste *avant* de l'avoir publié (« ça ne marche pas »). Il le publie, puis le teste de nouveau : **toujours `NXDOMAIN`**, pendant toute la durée du cache négatif. Modifier la zone ne sert à rien : il faut **vider le cache** (TP 25) ou attendre.

🆘 **Si ça ne marche pas.** À l'étape 1, le TTL est déjà inférieur à `3600` : tu avais posé cette question plus tôt (TP 13), et la réponse vieillit depuis. C'est normal, et c'est la preuve même du cache négatif. Si le TTL est le même à l'étape 3 qu'à l'étape 1, tu as relancé la commande avant la fin des 5 secondes.

**🧠 Ce que tu viens d'apprendre.**

- C'est le **cache négatif** : pour ne pas redemander cent fois un nom qui n'existe pas (une faute de frappe répétée, un logiciel mal configuré), le résolveur retient l'*absence*.
- Sa durée est **le plus petit** du TTL du SOA et du champ `minimum` du SOA. C'est le dernier nombre du SOA (`3600`, TP 11) qu'on règle pour cela : trop long, et un nom **créé** après une erreur reste « inexistant » chez les clients pendant des heures.
- `NXDOMAIN` et `NODATA` (TP 13) sont tous deux retenus. Le TP 24 les montre dans le cache de BIND.

**Vérifie-toi.**

1. Qu'est-ce qui décide de la durée du cache négatif ?
2. Tu crées un enregistrement mais un poste le voit toujours « inexistant ». Quelle est la cause probable ?

*Réponses.* (1) Le champ `minimum` du SOA (au plus, le TTL de la fiche SOA). (2) Un cache a retenu l'absence avant la création : il faut le vider ou attendre.

---

## VII.3 🧪 TP 23 — Le cache du poste Windows

**🎯 Objectif.** Lire le cache du *client* Windows avec les deux interfaces (PowerShell et `ipconfig`), voir qu'il retient aussi les réponses négatives, et le vider.

**Ce qu'il te faut.** Un terminal PowerShell sur `PC-GUICHET1` et un sur `DC1`. Durée : environ 30 minutes.

Le poste Windows a **son propre cache** (le service « Client DNS »), distinct de celui du résolveur. Il y a donc au moins **deux** caches entre l'utilisateur et la zone d'autorité.

**Étape 1 — Partir d'un cache vide.**

```powershell
# sur PC-GUICHET1
Clear-DnsClientCache
```

La commande n'affiche rien.

**Étape 2 — Faire une résolution.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName www.banquehorizon.com | Out-Null
```

Le symbole `|` (« tube ») envoie le résultat de la première commande à la seconde. `Out-Null` le **jette** : on veut seulement que la résolution ait lieu, sans rien afficher.

**Étape 3 — Lire le cache : `Get-DnsClientCache`.**

```powershell
# sur PC-GUICHET1
Get-DnsClientCache | Where-Object Name -like "*banquehorizon*"
```

`Get-DnsClientCache` affiche tout le cache. `Where-Object Name -like "*banquehorizon*"` **filtre** : « garde seulement les entrées dont le nom contient `banquehorizon` » (`*` remplace n'importe quels caractères).

```
Entry      : www.banquehorizon.com
Name       : www.banquehorizon.com
Type       : CNAME
Status     : Success
Section    : Answer
TimeToLive : 3590
DataLength : 23
Data       : web.banquehorizon.com

Entry      : www.banquehorizon.com
Name       : web.banquehorizon.com
Type       : A
Status     : Success
Section    : Answer
TimeToLive : 3590
DataLength : 4
Data       : 203.0.113.20
```

Le cache contient **deux fiches** : le `CNAME` (`www` vers `web`) et l'adresse (`A`) de `web`. C'est la chaîne complète du TP 2. Le `TimeToLive` est `3590` : ce n'est pas `3600`, parce que la fiche avait déjà vieilli dans le cache du résolveur avant d'arriver.

**Étape 4 — La même chose avec l'ancienne interface : `ipconfig /displaydns`.**

```powershell
# sur PC-GUICHET1
ipconfig /displaydns
```

```
Windows IP Configuration

    www.banquehorizon.com
    ----------------------------------------
    Record Name . . . . . : www.banquehorizon.com
    Record Type . . . . . : 5
    Time To Live  . . . . : 3590
    Data Length . . . . . : 23
    Section . . . . . . . : Answer
    CNAME (Host) Data  . . . : web.banquehorizon.com

    www.banquehorizon.com
    ----------------------------------------
    Record Name . . . . . : web.banquehorizon.com
    Record Type . . . . . : 1
    Time To Live  . . . . : 3590
    Data Length . . . . . : 4
    Section . . . . . . . : Answer
    A (Host) Record  . . . : 203.0.113.20
```

C'est le **même** cache, présenté plus en longueur. `Record Type 5` est un `CNAME`, `Record Type 1` un `A` : ce sont les numéros officiels des types de fiche. `Get-DnsClientCache` et `ipconfig /displaydns` sont deux interfaces sur **un seul** cache.

**Étape 5 — Le cache négatif du poste.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName nexiste.banquehorizon.com
```

```
Resolve-DnsName : nexiste.banquehorizon.com : DNS name does not exist
    + CategoryInfo          : ResourceUnavailable: (nexiste.banquehorizon.com:String) [Resolve-DnsName], Win32Exception
    + FullyQualifiedErrorId : DNS_ERROR_RCODE_NAME_ERROR,Microsoft.DnsClient.Commands.ResolveDnsName
```

C'est l'erreur que tu connais (TP 13, `DNS name does not exist`). Maintenant regarde si le poste l'a retenue :

```powershell
# sur PC-GUICHET1
Get-DnsClientCache | Where-Object Name -like "nexiste*"
```

```
Entry      : nexiste.banquehorizon.com
Name       : nexiste.banquehorizon.com
Type       : 
Status     : NotExist
Section    : Authority
TimeToLive : 900
DataLength : 0
Data       : 
```

`Status : NotExist` : le poste a retenu que ce nom n'existe pas, avec un `TimeToLive` de **900** secondes. Cette durée est une valeur par défaut de Windows (réglée par la clé de registre `MaxNegativeCacheTtl`) ; elle **ne suit pas** le champ `minimum` du SOA comme le fait BIND.

**Étape 6 — Vider le cache du poste.**

```powershell
# sur PC-GUICHET1
ipconfig /flushdns
```

```
Windows IP Configuration

Successfully flushed the DNS Resolver Cache.
```

Vérifie que le cache est vide :

```powershell
# sur PC-GUICHET1
Get-DnsClientCache | Where-Object Name -like "*banquehorizon*"
```

```

```

Aucune ligne : le cache est vide. (`Clear-DnsClientCache`, l'étape 1, fait la même chose que `ipconfig /flushdns`.)

**Étape 7 — Le cache de `DC1`, serveur DNS Windows.**

`DC1` est lui aussi un serveur DNS **avec cache** : c'est lui qui transfère les questions publiques au résolveur (TP 28). Son cache se lit avec `Show-DnsServerCache` :

```powershell
# sur DC1
Show-DnsServerCache | Where-Object HostName -like "*banquehorizon.com"
```

```
HostName              RecordType TimeToLive RecordData           
--------              ---------- ---------- ----------           
www.banquehorizon.com CNAME            3590 web.banquehorizon.com
web.banquehorizon.com A                3590 203.0.113.20         
```

`DC1` a lui aussi gardé la chaîne `www` vers `web`. Il y a donc **trois caches** sur le trajet de `PC-GUICHET1` : celui du poste, celui de `DC1`, celui de `DNS-RES`.

🆘 **Si ça ne marche pas.** À l'étape 3, aucune ligne : tu as exécuté `Clear-DnsClientCache` après l'étape 2, ou tu n'as pas fait l'étape 2. Refais les étapes 1 à 3 dans l'ordre.

**🧠 Ce que tu viens d'apprendre.**

- Le poste Windows a **son propre cache**. `Get-DnsClientCache` et `ipconfig /displaydns` sont deux interfaces sur le **même** cache.
- Le cache négatif Windows dure **900 s**, quel que soit le SOA.
- Le vidage est **local** : `Clear-DnsClientCache` et `ipconfig /flushdns` ne touchent ni le résolveur ni `DC1`. Si la réponse est toujours fausse après avoir vidé le poste, le problème est **plus haut** (TP 25).

**Vérifie-toi.**

1. Combien de caches y a-t-il, au minimum, entre `PC-GUICHET1` et la zone d'autorité ?
2. Vider le cache du poste vide-t-il celui du résolveur ?

*Réponses.* (1) Au moins deux (le poste et le résolveur), trois avec `DC1`. (2) Non : chaque cache se vide séparément.

---

## VII.4 🧪 TP 24 — Lire le cache de BIND

**🎯 Objectif.** Ouvrir le cache du résolveur et reconnaître ce qu'il y a dedans : les réponses, les délégations apprises, les absences.

**Ce qu'il te faut.** Les TP 21 à 23 faits (le cache de `DNS-RES` contient ainsi des résultats à lire). Un terminal sur `DNS-RES`. Durée : environ 25 minutes.

**Étape 1 — Demander à BIND d'écrire son cache dans un fichier, et l'afficher.**

```
# sur DNS-RES
sudo rndc dumpdb -cache; sudo cat /var/cache/bind/named_dump.db
```

`rndc dumpdb -cache` ordonne à `named` de **recopier son cache dans un fichier** (`named_dump.db`, dans `/var/cache/bind`). `cat` affiche ensuite ce fichier. La sortie est longue ; **seule la première partie nous intéresse**, jusqu'à la ligne 32 :

```
;
; Start view _default
;
;
; Cache dump of view '_default' (cache _default)
;
; using a 0 second stale ttl
$DATE 20261104102900
; authanswer
.			86390	IN NS	a.root-servers.net.
; glue
com.			86390	NS	a.nic.com.
; authauthority
banquehorizon.com.	3590	NS	ns1.banquehorizon.com.
			3590	NS	ns2.banquehorizon.com.
; answer
nexiste.banquehorizon.com. 3595	\-ANY	;-$NXDOMAIN
; banquehorizon.com. SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
; glue
ns1.banquehorizon.com.	3590	A	203.0.113.10
; glue
ns2.banquehorizon.com.	3590	A	203.0.113.11
; answer
web.banquehorizon.com.	3595	\-AAAA	;-$NXRRSET
; banquehorizon.com. SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
; authanswer
			3590	A	203.0.113.20
; authanswer
www.banquehorizon.com.	3590	CNAME	web.banquehorizon.com.
; glue
a.nic.com.		86390	A	198.51.100.2
;
```

Le reste du fichier (adresses de serveurs, échecs) est vide pour l'instant.

**Étape 2 — Comprendre la structure.**

Les lignes qui commencent par `;` sont des commentaires. La ligne `; Start view _default` ouvre la « vue » principale, dans laquelle se trouve le cache. Ensuite, chaque groupe de fiches est **précédé d'une étiquette** qui dit comment BIND a appris l'information, donc quelle confiance lui accorder :

| Étiquette | Sens | Exemple dans ce cache |
|---|---|---|
| `; authanswer` | Réponse **faisant autorité**, reçue d'un serveur qui détient la zone | `www`, `web`, la racine |
| `; authauthority` | Les serveurs de noms d'une zone, appris d'un serveur qui détient cette zone | `banquehorizon.com NS` |
| `; glue` | Adresses et serveurs venus d'un **renvoi** (TP 8) : crédibles, mais jamais préférés à une réponse d'autorité | `com NS`, `ns1`, `ns2`, `a.nic.com` |
| `; answer` | Réponse non autoritaire : ici, des **absences** | `nexiste`, `AAAA` de `web` |

**Étape 3 — Lire les fiches positives.**

```
; authanswer
			3590	A	203.0.113.20
; authanswer
www.banquehorizon.com.	3590	CNAME	web.banquehorizon.com.
```

Voilà ce que tu as appris en demandant `www.banquehorizon.com` : le `CNAME` et l'adresse `A`, étiquetés `authanswer`. Les TTL (`3590`) sont ceux **restants**, un peu plus petits que `3600` (TP 21).

**Étape 4 — Lire les absences.**

```
; answer
nexiste.banquehorizon.com. 3595	\-ANY	;-$NXDOMAIN
; banquehorizon.com. SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

`nexiste.banquehorizon.com. 3595 \-ANY ;-$NXDOMAIN` signifie : « le nom n'existe pas ». Le `\-` introduit une entrée **négative**, `ANY` veut dire « pour tous les types », et `;-$NXDOMAIN` est le motif. La ligne suivante, en commentaire, recopie le SOA qui justifie la durée.

```
; answer
web.banquehorizon.com.	3595	\-AAAA	;-$NXRRSET
; banquehorizon.com. SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

`web.banquehorizon.com. 3595 \-AAAA ;-$NXRRSET` : le nom existe, mais pas ce **type** (`AAAA`). C'est le NODATA du TP 13.

**Ce qu'il faut retenir.** Le cache ne contient pas tout ce qui est vrai : il contient **ce qui a été demandé et retenu**. Le cache d'un résolveur est donc une preuve de ce que ses clients ont demandé.

> 🔍 **Point d'audit** — Le vidage du cache d'un résolveur (`rndc dumpdb`) est l'une des meilleures sources pour reconstituer, après un incident, **ce que ses clients ont résolu** (noms de domaines de commande et contrôle d'un logiciel malveillant, par exemple). Pense à le conserver avant de vider.

**🧠 Ce que tu viens d'apprendre.**

- `rndc dumpdb -cache` écrit le cache dans `named_dump.db`, qu'on lit avec `cat`.
- Chaque groupe de fiches est étiqueté (`authanswer`, `authauthority`, `glue`, `answer`) : l'étiquette dit comment BIND a appris la fiche.
- Les absences sont retenues aussi : `\-ANY ;-$NXDOMAIN` (le nom n'existe pas) et `\-AAAA ;-$NXRRSET` (pas ce type).

**Vérifie-toi.**

1. Que veut dire `; glue` devant une fiche ?
2. Comment le cache note-t-il un nom inexistant ?

*Réponses.* (1) Cette fiche vient d'un renvoi (une délégation), pas d'une réponse d'autorité. (2) Par une entrée négative `\-ANY ;-$NXDOMAIN`.

---

## VII.5 🧪 TP 25 — Vider le cache, en entier ou en partie

**🎯 Objectif.** Choisir le bon outil pour oublier : un nom, un domaine entier, tout.

**Ce qu'il te faut.** Le TP 24 fait, un terminal sur `DNS-RES`. Durée : environ 20 minutes.

Pour mesurer l'effet d'un vidage, on **compte** les lignes du cache qui contiennent un mot. `grep -c mot fichier` compte les lignes qui contiennent `mot`.

**Étape 1 — Compter avant.**

```
# sur DNS-RES
sudo rndc dumpdb -cache; sudo grep -c nexiste /var/cache/bind/named_dump.db
```

```
1
```

Le cache contient une ligne qui parle de `nexiste` (l'entrée négative du TP 24).

**Étape 2 — Oublier un seul nom : `flushname`.**

```
# sur DNS-RES
sudo rndc flushname nexiste.banquehorizon.com
```

La commande n'affiche rien. Compte de nouveau :

```
# sur DNS-RES
sudo rndc dumpdb -cache; sudo grep -c nexiste /var/cache/bind/named_dump.db
```

```
0
```

`0` : l'entrée `nexiste` a disparu. `flushname` ne retire que **ce nom** : les autres fiches du cache sont intactes.

**Étape 3 — Oublier un domaine entier : `flushtree`.**

D'abord, combien de lignes parlent de `banquehorizon` ?

```
# sur DNS-RES
sudo rndc dumpdb -cache; sudo grep -c banquehorizon /var/cache/bind/named_dump.db
```

```
7
```

Plusieurs lignes (sept ici) : les fiches de la zone, les serveurs de noms, leurs adresses. Maintenant on oublie **tout le domaine** :

```
# sur DNS-RES
sudo rndc flushtree banquehorizon.com
```

```
# sur DNS-RES
sudo rndc dumpdb -cache; sudo grep -c banquehorizon /var/cache/bind/named_dump.db
```

```
0
```

`0` : plus rien ne parle de `banquehorizon`. `flushtree` retire le nom **et tout ce qui est en dessous** : ici toute la zone, y compris les serveurs de noms et leur glue.

**Étape 4 — Tout oublier : `flush`.**

```
# sur DNS-RES
sudo rndc flush
```

Aucun message : le silence est un succès. Le cache est entièrement vide.

**Trois outils, trois usages.**

| Commande | Effet | Quand l'utiliser |
|---|---|---|
| `rndc flushname NOM` | Oublie ce nom (tous types) | Un seul nom est faux, ou « inexistant » à tort |
| `rndc flushtree DOMAINE` | Oublie le domaine **et ses sous-domaines** | Après un changement de serveurs de noms, ou un incident sur une zone |
| `rndc flush` | Oublie **tout** | En dernier recours : le résolveur redescend tout l'arbre pour chaque question, et sa charge monte |

🆘 **Si ça ne marche pas.** À l'étape 1, le compte vaut `0` : le cache ne contient pas `nexiste`. Refais le TP 22 (étape 1) puis relance.

**🧠 Ce que tu viens d'apprendre.**

- **Vider le cache d'un résolveur ne vide pas celui des clients.** Si le poste Windows a gardé la mauvaise réponse, il faut aussi `Clear-DnsClientCache` (TP 23) ; sur un poste Linux avec `systemd-resolved`, `sudo resolvectl flush-caches`.
- Choisis le **plus petit** vidage qui suffit : un nom avant un domaine, un domaine avant tout.
- L'ordre de remontée d'un problème de cache est toujours : **client → résolveur local → éventuel transmetteur → serveur d'autorité**.

**Vérifie-toi.**

1. Quelle commande oublie un nom mais pas le reste du cache ?
2. Pourquoi éviter `rndc flush` si un nom suffit ?

*Réponses.* (1) `rndc flushname NOM`. (2) Parce que le résolveur doit alors redescendre tout l'arbre pour chaque question, ce qui augmente sa charge.

---

## VII.6 🧪 TP 26 — Le cache des échecs (SERVFAIL)

**🎯 Objectif.** Provoquer un `SERVFAIL`, voir que BIND le retient (brièvement) pour ne pas retomber dans le même trou, et le lire dans le cache.

**Ce qu'il te faut.** Un terminal PowerShell sur `TLD-NS`, un terminal sur `DNS-RES` et un sur `PC-CONSEILLER`. Durée : environ 30 minutes. Tout est remis en état à la fin.

`SERVFAIL` veut dire « **j'ai essayé et je n'ai pas pu** » : un serveur d'autorité injoignable, une zone cassée… Ce n'est pas `NXDOMAIN` (« j'ai pu, et ça n'existe pas »). Pour en provoquer un, tu vas créer un domaine `broken.com` dont le serveur de noms **n'existe pas**.

**Étape 1 — Créer le domaine cassé.** Dans la zone `com`, que détient `TLD-NS`, on ajoute une délégation vers un serveur qui n'existe pas :

```powershell
# sur TLD-NS
Add-DnsServerZoneDelegation -Name com -ChildZoneName broken -NameServer ns.broken.com -IPAddress 203.0.113.99
```

`Add-DnsServerZoneDelegation` ajoute un renvoi (TP 8) dans la zone `com` : « pour `broken.com`, demande à `ns.broken.com`, qui est à l'adresse `203.0.113.99` ». Cette adresse **n'existe pas** dans le laboratoire. La commande n'affiche rien.

**Étape 2 — Régler le résolveur pour avoir le temps d'observer.**

Par défaut, BIND retient un échec très peu de temps. On le règle à 30 secondes pour avoir le temps de le voir.

```
# sur DNS-RES
sudo sed -i 's/empty-zones-enable no;/empty-zones-enable no; servfail-ttl 30;/' /etc/bind/named.conf
```

```
# sur DNS-RES
sudo systemctl restart named
```

Le premier ordre ajoute `servfail-ttl 30;` dans `named.conf`. Le second **redémarre** le service `named` pour qu'il le prenne en compte. Aucun des deux n'affiche quoi que ce soit.

**Étape 3 — Provoquer le `SERVFAIL`.**

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.broken.com +noall +comments
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 50
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
```

Le résolveur a suivi la délégation, a interrogé `203.0.113.99`, n'a obtenu **aucune réponse**, et a fini par répondre `status: SERVFAIL` à ton poste.

**Étape 4 — Voir l'échec dans le cache.**

```
# sur DNS-RES
sudo rndc dumpdb -cache; sudo grep -A4 'SERVFAIL cache' /var/cache/bind/named_dump.db | head -5
```

`grep -A4` affiche, en plus de la ligne trouvée, les **4 lignes suivantes**, et `head -5` garde seulement les cinq premières lignes du résultat.

```
; SERVFAIL cache
;
; www.broken.com/A [ttl 29995]
;
; Start view _bind
```

L'échec est dans une section **à part** du cache, `SERVFAIL cache`. La ligne `www.broken.com/A [ttl 29995]` dit : « la question `www.broken.com`, type `A`, a échoué ; je m'en souviens pendant encore environ 30 secondes » (la valeur est écrite en millisecondes dans cette version de BIND, elle décroît).

**Étape 5 — Reposer la question : le cache répond.**

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.broken.com +noall +comments +stats
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 59
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; Query time: 0 msec
;; SERVER: 10.20.20.53#53(10.20.20.53) (UDP)
;; WHEN: Wed Nov 04 10:29:02 UTC 2026
;; MSG SIZE  rcvd: 43
```

Même `SERVFAIL`, mais cette fois **instantanément** : le résolveur n'a pas retenté d'interroger le serveur fantôme, il a répondu depuis la mémoire de son échec. Sans cette mémoire, un client insistant ferait relancer une résolution vouée à l'échec à chaque tentative, avec un délai d'attente à chaque fois.

**Étape 6 — Remise en état.**

```
# sur DNS-RES
sudo sed -i 's/ servfail-ttl 30;//' /etc/bind/named.conf; sudo systemctl restart named
```

```powershell
# sur TLD-NS
Remove-DnsServerZoneDelegation -Name com -ChildZoneName broken -Force
```

On enlève le réglage, on redémarre `named`, puis on supprime la délégation (`-Force` évite la demande de confirmation). Contrôle :

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.broken.com +noall +comments
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 60
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
```

Cette fois `NXDOMAIN`, et non plus `SERVFAIL` : `named` a redémarré avec un cache vide, et `com` ne délègue plus rien. Le domaine n'existe plus.

> 🔍 **Point d'audit** — Un `SERVFAIL` durable sur un domaine que tu gères est un signal à superviser. Une sonde qui interroge périodiquement les noms critiques **à travers un résolveur** (pas directement les serveurs d'autorité) est la seule à voir ce que voient les utilisateurs.

🆘 **Si ça ne marche pas.** À l'étape 3, `NXDOMAIN` au lieu de `SERVFAIL` : la délégation de l'étape 1 n'est pas faite (ou `DNS-RES` avait déjà retenu un `NXDOMAIN` pour `www.broken.com` : lance `sudo rndc flush`, puis recommence l'étape 3).

**🧠 Ce que tu viens d'apprendre.**

- `SERVFAIL` veut dire « **j'ai essayé et je n'ai pas pu** ». Devant un `SERVFAIL`, vérifie d'abord la **chaîne de délégation** (`dig +trace`, TP 7) et la **joignabilité** des serveurs faisant autorité.
- BIND retient l'échec pendant `servfail-ttl` secondes (30 au plus) pour ne pas retomber dans le même trou.
- **Un redémarrage de `named` repart d'un cache vide** : c'est une raison de plus de préférer `rndc flush` (qui n'interrompt pas le service) ; c'est aussi pourquoi un redémarrage « répare » parfois des symptômes de cache.

**Vérifie-toi.**

1. Quelle est la différence entre `SERVFAIL` et `NXDOMAIN` ?
2. Pourquoi BIND retient-il un échec ?

*Réponses.* (1) `SERVFAIL` : le serveur n'a pas pu obtenir de réponse ; `NXDOMAIN` : il a obtenu la réponse « ce nom n'existe pas ». (2) Pour éviter de relancer, à chaque question d'un client insistant, une résolution qui échouera encore.

---

# Partie VIII — Redondance, DNS privé et DHCP

Un service de noms qui s'arrête arrête **tout** : les sites, la messagerie, l'authentification. Cette partie répond à trois questions :

1. Comment le laboratoire reste-t-il debout quand un serveur tombe ? (TP 27)
2. Comment garde-t-il ses noms *internes* hors de la vue publique, tout en les rendant disponibles aux postes ? (TP 28)
3. Comment les postes obtiennent-ils leur configuration DNS, et comment leur nom entre-t-il dans la zone ? (TP 29 et 30)

---

## VIII.1 🧪 TP 27 — NS1-BANK tombe

**🎯 Objectif.** Arrêter un des deux serveurs d'autorité de la banque et constater que les utilisateurs **ne s'en aperçoivent pas** ; puis lire ce que voit un administrateur qui interroge, lui, le serveur arrêté.

**Ce qu'il te faut.** Un terminal sur `DNS-RES`, un sur `NS1-BANK`, un sur `PC-GUICHET1` et un sur `PC-CONSEILLER`. Durée : environ 25 minutes. Le serveur est remis en marche à la fin.

**Rappel.** La délégation de `banquehorizon.com` (TP 8) désigne **deux** serveurs : `ns1` et `ns2`. L'idée est que si l'un tombe, l'autre répond.

**Étape 1 — Vider le cache du résolveur.** Si `DNS-RES` avait déjà la réponse en mémoire, il répondrait sans interroger personne et l'expérience ne prouverait rien. On le vide donc exprès.

```
# sur DNS-RES
sudo rndc flush
```

**Étape 2 — Arrêter `NS1-BANK`.**

```
# sur NS1-BANK
sudo systemctl stop named
```

`systemctl` est la commande qui pilote les **services** sous Linux (les programmes qui tournent en permanence). `stop named` arrête le service `named`, c'est-à-dire BIND. La commande n'affiche rien. À partir de maintenant, `NS1-BANK` ne répond plus à aucune question DNS.

**Étape 3 — Résoudre un nom depuis un poste.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName mail.banquehorizon.com
```

```
Name      : mail.banquehorizon.com
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 203.0.113.25
```

**Ça marche.** La réponse arrive, comme si de rien n'était. `DNS-RES` a essayé `ns1`, n'a pas eu de réponse, et a essayé `ns2` : **de façon transparente**, sans que l'utilisateur voie quoi que ce soit.

**Étape 4 — Interroger directement le serveur arrêté.**

```
# sur PC-CONSEILLER
dig @203.0.113.10 mail.banquehorizon.com +time=1 +tries=1
```

Deux options nouvelles : `+time=1` (n'attends qu'**une seconde** une réponse) et `+tries=1` (ne fais **qu'un seul essai**). Sans elles, `dig` insisterait plusieurs fois, plusieurs secondes.

```
;; communications error to 203.0.113.10#53: connection refused

; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> @203.0.113.10 mail.banquehorizon.com +time=1 +tries=1
; (1 server found)
;; global options: +cmd
;; no servers could be reached
```

`connection refused` : la machine `203.0.113.10` est bien joignable, mais **rien n'écoute sur le port 53** : le service est arrêté. Puis `no servers could be reached` : `dig` n'a trouvé personne pour lui répondre.

**Étape 5 — Interroger le deuxième serveur.**

```
# sur PC-CONSEILLER
dig @203.0.113.11 mail.banquehorizon.com +noall +comments +answer
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 42
;; flags: qr aa rd; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 4096
;; ANSWER SECTION:
mail.banquehorizon.com.	3600	IN	A	203.0.113.25
```

`NS2-BANK` répond normalement : `NOERROR`, et `flags: qr aa` — il fait autorité. Il le peut parce qu'il détient **sa copie de la zone** (TP 18).

**Étape 6 — Remettre `NS1-BANK` en marche.**

```
# sur NS1-BANK
sudo systemctl start named
```

🆘 **Si ça ne marche pas.** À l'étape 3, `timed out` : le résolveur n'arrive pas à joindre `ns2` non plus. Vérifie que `NS2-BANK` est bien allumé (`dig @203.0.113.11 …`, étape 5). À l'étape 6, relance `dig @203.0.113.10 …` : `NS1-BANK` doit de nouveau répondre.

**🧠 Ce que tu viens d'apprendre.**

- La redondance du DNS est **dans la zone**, pas dans le serveur : la délégation donne **deux** `NS` ; un résolveur qui n'obtient pas de réponse de l'un **essaie l'autre**. C'est pourquoi un domaine doit avoir **au moins deux** serveurs, idéalement sur des **réseaux et des sites différents** (ici, deux adresses du même réseau : acceptable pour un laboratoire, pas pour une banque).
- `connection refused` (le paquet arrive, rien n'écoute : le service est arrêté, ou un pare-feu *rejette*) ne se lit pas comme `timed out` (le paquet n'arrive pas, ou la réponse ne revient pas : panne réseau, pare-feu qui *ignore*). La première cause est locale à la machine, la deuxième est ailleurs.
- `NS2-BANK` a pu répondre parce qu'il avait **sa copie de la zone**. Un secondaire dont la zone a *expiré* (14 jours sans nouvelles du primaire, le champ `expire` du SOA) cesse de répondre plutôt que de servir une donnée trop vieille.

> 🔍 **Point d'audit** — Teste la bascule **régulièrement** : arrête un serveur d'autorité, vérifie qu'une résolution à travers le résolveur aboutit, remets-le. Un secondaire silencieusement en retard (TP 19) ne se découvre qu'ainsi.

**Vérifie-toi.**

1. Pourquoi l'utilisateur ne voit-il pas la panne de `NS1-BANK` ?
2. `connection refused` ou `timed out` : lequel indique qu'un service est arrêté sur une machine joignable ?

*Réponses.* (1) Parce que le résolveur interroge l'autre serveur de la zone (`ns2`). (2) `connection refused`.

---

## VIII.2 🧪 TP 28 — DNS interne et redirecteur

**🎯 Objectif.** Comprendre comment un **nom interne** (`dc1.horizon.local`) et un **nom public** (`www.banquehorizon.com`) se résolvent à partir du même poste, avec des serveurs qui ne connaissent chacun qu'un seul des deux mondes.

**Ce qu'il te faut.** Un terminal PowerShell sur `PC-GUICHET1` et un sur `DC1`, plus un terminal sur `PC-CONSEILLER`. Durée : environ 30 minutes.

**Le problème.** L'agence a deux mondes de noms :

- les noms **internes** (`dc1.horizon.local`, `intranet.horizon.local`), qui n'existent dans aucune zone publique et que **seul `DC1`** connaît ;
- les noms **publics** (`www.banquehorizon.com`), que `DNS-RES` sait résoudre en interrogeant Internet.

Le poste `PC-GUICHET1` doit pouvoir résoudre les deux. Comment ?

```schema
 nom interne  (dc1.horizon.local)       ─► DC1 le connaît
 nom public   (www.banquehorizon.com)   ─► DC1 ne le connaît pas : il le TRANSFÈRE à DNS-RES (redirecteur)
 
 DNS-RES, de son côté :
 nom public   (www.banquehorizon.com)   ─► il le résout lui-même (en descendant l'arbre)
 nom interne  (dc1.horizon.local)       ─► il ne le connaît pas : il le TRANSFÈRE à DC1 (zone « forward », TP 16)
```

**Étape 1 — Un nom interne, par le serveur du poste.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName dc1.horizon.local
```

```
Name      : dc1.horizon.local
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 10.20.20.10
```

Le poste interroge `DC1` (son premier serveur DNS, TP 5), qui détient la zone `horizon.local` : il répond directement.

**Étape 2 — Le même nom interne, à travers `DNS-RES`.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName dc1.horizon.local -Server 10.20.20.53
```

`-Server 10.20.20.53` impose `DNS-RES` comme serveur à interroger (TP 4).

```
Name      : dc1.horizon.local
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 10.20.20.10
```

La même réponse. Pourtant `DNS-RES` ne détient pas la zone `horizon.local` ! Il a **transféré** la question à `DC1` grâce au bloc `zone "horizon.local" { type forward; … }` que tu as lu au TP 16.

**Étape 3 — Un nom public, par `DC1`.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName www.banquehorizon.com -Server 10.20.20.10
```

```
Name     : www.banquehorizon.com
Type     : CNAME
TTL      : 3600
Section  : Answer
NameHost : web.banquehorizon.com

Name      : web.banquehorizon.com
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 203.0.113.20
```

`DC1` ne connaît pas `banquehorizon.com`, et pourtant il répond. Il a **transféré** la question à `DNS-RES`, et lui a rendu la réponse. Un seul serveur, deux mondes : voyons la configuration qui fait ça.

**Étape 4 — Le redirecteur de `DC1`.**

```powershell
# sur DC1
Get-DnsServerForwarder
```

```
IPAddress     UseRootHint Timeout EnableReordering
---------     ----------- ------- ----------------
{10.20.20.53} True              3 True            
```

Le **redirecteur** (en anglais *forwarder*) est le serveur vers lequel `DC1` envoie tout ce qu'il ne sait pas résoudre : ici `10.20.20.53`, c'est-à-dire `DNS-RES`. Les autres colonnes sont des réglages secondaires.

Sous Windows, tout est enregistré dans le **registre** (la base de configuration du système). Tu peux retrouver cette même valeur ainsi :

```powershell
# sur DC1
reg query HKLM\SYSTEM\CurrentControlSet\Services\DNS\Parameters
```

```
HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\DNS\Parameters
    EnableGlobalQueryBlockList    REG_DWORD    0x1
    GlobalQueryBlockList    REG_MULTI_SZ    isatap\0wpad
    Forwarders    REG_MULTI_SZ    10.20.20.53
```

La dernière ligne (`Forwarders … 10.20.20.53`) est la même information. C'est le principe du TP 17 : les commandes PowerShell et le registre sont deux interfaces sur **un même réglage**.

**Étape 5 — Et depuis l'extérieur ?** Un nom interne ne doit **pas** être visible de l'extérieur. Pose la question à `NS1-BANK` (le serveur public) :

```
# sur PC-CONSEILLER
dig @203.0.113.10 dc1.horizon.local +noall +comments
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: REFUSED, id: 46
;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
```

`status: REFUSED` : `NS1-BANK` ne connaît pas ce nom et, n'étant pas un résolveur, refuse de le chercher (TP 9). Le nom interne reste interne.

⚠️ **Attention** — Un redirecteur ne vérifie rien : il fait confiance à la réponse qu'il reçoit. Un redirecteur compromis ou mal configuré (une adresse de fournisseur d'accès inconnue, un résolveur public sans accord) fait passer **toutes** tes questions par un tiers.

🆘 **Si ça ne marche pas.** À l'étape 3, `timed out` : `DNS-RES` ne répond pas à `DC1`, ou l'ACL de `DNS-RES` n'a pas été remise à l'état d'origine (TP 16, étape 8).

**🧠 Ce que tu viens d'apprendre.**

- Un **DNS privé** (`horizon.local`) est une zone qu'**un seul serveur interne** détient, ici `DC1`. Les noms internes ne doivent **jamais** être publiés dans la zone publique : ils révéleraient l'architecture du réseau.
- Il y a deux façons de transférer une question : un bloc `forward` **par domaine** (BIND, TP 16) ou un **redirecteur global** (`Get-DnsServerForwarder`, Windows : « toute question que je ne sais pas résoudre, envoie-la à `10.20.20.53` »). Les deux se complètent ici, dans les deux sens.
- `DC1` et `DNS-RES` sont donc **interdépendants** : si l'un tombe, une moitié des résolutions s'arrête. C'est une vraie conception à surveiller.

**Vérifie-toi.**

1. Pourquoi `DNS-RES` peut-il répondre pour `dc1.horizon.local` alors qu'il ne détient pas la zone ?
2. Où est stocké le redirecteur de `DC1` ?

*Réponses.* (1) Il transfère la question à `DC1` grâce à son bloc `zone … type forward`. (2) Dans le registre Windows ; `Get-DnsServerForwarder` est l'une des deux interfaces.

---

## VIII.3 🧪 TP 29 — DHCP et enregistrement dynamique

**🎯 Objectif.** Voir comment un poste obtient ses serveurs DNS, et comment son nom apparaît **tout seul** dans la zone.

**Ce qu'il te faut.** Un terminal PowerShell sur `DC1` et un sur `PC-GUICHET2`. Durée : environ 25 minutes.

**Le DHCP, en deux phrases.** Quand un poste démarre, il ne connaît ni son adresse ni son serveur DNS. Il demande à un serveur **DHCP** (ici, `DC1`), qui lui prête une configuration complète pour une certaine durée : c'est un **bail** (en anglais *lease*).

**Étape 1 — Lire les baux accordés.**

```powershell
# sur DC1
Get-DhcpServerv4Lease -ScopeId 10.20.10.0
```

`-ScopeId 10.20.10.0` désigne l'**étendue** (*scope*), c'est-à-dire le réseau `10.20.10.0` dans lequel `DC1` distribue des adresses.

```
IPAddress       : 10.20.10.50
ClientId        : 02:00:00:00:00:6F
ScopeId         : 10.20.10.0
LeaseExpiryTime : 11/12/2026 10:26 AM
AddressState    : Active

IPAddress       : 10.20.10.51
ClientId        : 02:00:00:00:00:73
ScopeId         : 10.20.10.0
LeaseExpiryTime : 11/12/2026 10:26 AM
AddressState    : Active

IPAddress       : 10.20.10.52
ClientId        : 02:00:00:00:00:77
ScopeId         : 10.20.10.0
LeaseExpiryTime : 11/12/2026 10:26 AM
AddressState    : Active
```

Trois baux, un par poste. Pour chacun : l'`IPAddress` prêtée, le `ClientId` (l'adresse physique de la carte du poste, qui l'identifie), la date de fin du bail (`LeaseExpiryTime`, ici 8 jours plus tard) et son état `Active`.

**Étape 2 — Voir l'enregistrement que le DHCP a fait dans le DNS.**

```powershell
# sur DC1
Get-DnsServerResourceRecord -ZoneName horizon.local
```

```
HostName    RecordType Type          Timestamp TimeToLive RecordData                                                           
--------    ---------- ----          --------- ---------- ----------                                                           
@           SOA           6                          3600 [8][900][600][86400][3600] ns1.horizon.local hostmaster.horizon.local
dc1         A             1                          3600 10.20.20.10                                                          
dns-res     A             1                          3600 10.20.20.53                                                          
intranet    CNAME         5                          3600 dc1.horizon.local                                                    
pc-guichet1 A             1 11/4/2026 10:26 AM       1200 10.20.10.50                                                          
pc-guichet2 A             1 11/4/2026 10:26 AM       1200 10.20.10.51                                                          
```

Tu as vu cette commande au TP 17. Les deux dernières lignes sont les postes `pc-guichet1` et `pc-guichet2`. Ce n'est pas un administrateur qui les a écrits : le serveur DHCP les a **inscrits lui-même** dans la zone dès qu'il a distribué leurs adresses. Reconnais-les à leur `Timestamp` rempli et à leur TTL court (`1200`). C'est l'**enregistrement dynamique**.

**Étape 3 — Rendre l'adresse du poste.**

```powershell
# sur PC-GUICHET2
ipconfig /release
```

`ipconfig /release` dit au poste : « rends ton bail ».

```
Windows IP Configuration

No operation can be performed on Ethernet 1 while it has its media disconnected.
No operation can be performed on Ethernet 2 while it has its media disconnected.
No operation can be performed on Ethernet 3 while it has its media disconnected.

Ethernet adapter Ethernet 0:

   Connection-specific DNS Suffix  . :
   Default Gateway . . . . . . . . . :
```

Les trois premières lignes (`No operation can be performed…`) concernent les cartes non branchées : ignore-les. Pour `Ethernet 0`, tu vois que le suffixe DNS et la passerelle sont **vides** : le poste n'a plus de configuration.

**Étape 4 — La redemander.**

```powershell
# sur PC-GUICHET2
ipconfig /renew
```

`ipconfig /renew` dit : « donne-moi une configuration ».

```
Windows IP Configuration

Ethernet adapter Ethernet 0:
   Connection-specific DNS Suffix  . : horizon.local
   Link-local IPv6 Address. . . . . . : fe80::ff:fe00:73%2
   IPv4 Address. . . . . . . . . . . : 10.20.10.51
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 10.20.10.1
```

Le poste a retrouvé sa configuration, avec **la même adresse** : `10.20.10.51`. `DC1` se souvenait du bail et la lui a rendue. Remarque `Connection-specific DNS Suffix : horizon.local` : le suffixe est fourni par le DHCP (c'est ce qui permet de taper `intranet` seul, TP 6).

🆘 **Si ça ne marche pas.** `ipconfig /renew` rend `unable to contact your DHCP server` : `DC1` n'est pas joignable. Refais le TP 1 (partie A) pour contrôler le réseau.

**🧠 Ce que tu viens d'apprendre.**

- Un bail DHCP porte, en plus de l'adresse, le **masque**, la **passerelle**, les **serveurs DNS** (option 6) et le **suffixe de domaine** (option 15) : c'est ce qui fait que `intranet` seul se résout (TP 6) et que le poste interroge `DC1` sans rien configurer.
- L'**enregistrement dynamique** : le serveur DHCP (ou le client) crée la fiche `A` — et le `PTR` — du poste dans le DNS. Elles disparaissent à l'expiration : la zone se tient à jour sans intervention.
- Dans une zone *publique* (BIND de la banque), ce n'est **pas** le cas : pas de mise à jour dynamique sans `allow-update` explicite et signé, précisément parce qu'on ne veut pas que n'importe quel poste puisse modifier une zone.

> 🔍 **Point d'audit** — La mise à jour dynamique **non sécurisée** (`DynamicUpdate : NonsecureAndSecure`, comme ici) permet à n'importe quel poste du réseau de créer ou d'écraser un enregistrement. Sur un domaine Active Directory réel, on la règle à *Secure only*.

**Vérifie-toi.**

1. Quelles informations DNS un bail DHCP apporte-t-il à un poste ?
2. Comment reconnaît-on, dans une zone Windows, une fiche créée automatiquement ?

*Réponses.* (1) Les serveurs DNS (option 6) et le suffixe de domaine (option 15). (2) À son `Timestamp` rempli et à son TTL court.

---

## VIII.4 🧪 TP 30 — La NRPT du poste Windows

**🎯 Objectif.** Casser la résolution d'un poste en lui donnant un mauvais serveur DNS, la **réparer pour un seul domaine** par une règle de stratégie de noms (NRPT), puis tout remettre en état.

**Ce qu'il te faut.** Un terminal PowerShell sur `PC-GUICHET1`. Durée : environ 30 minutes. Tout est remis en état à la fin (étapes 8 à 10).

**La NRPT, en une phrase.** C'est une table de règles **par suffixe** : « pour tout nom qui se termine par ce domaine, demande à tel serveur ». Elle permet à un poste en VPN de résoudre les noms de l'entreprise par les serveurs de l'entreprise, et tout le reste par son propre réseau.

**Étape 1 — Casser : donner un serveur qui n'existe pas.**

```powershell
# sur PC-GUICHET1
Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 10.20.20.250
```

`Set-DnsClientServerAddress` **remplace** les serveurs DNS de la carte (que le DHCP avait donnés) par `10.20.20.250`, une adresse que personne n'utilise. La commande n'affiche rien.

**Étape 2 — Vider le cache.** Pour que le poste ne réponde pas depuis sa mémoire :

```powershell
# sur PC-GUICHET1
Clear-DnsClientCache
```

**Étape 3 — Constater la panne.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName dc1.horizon.local
```

```
Resolve-DnsName : dc1.horizon.local : This operation returned because the timeout period expired
    + CategoryInfo          : ResourceUnavailable: (dc1.horizon.local:String) [Resolve-DnsName], Win32Exception
    + FullyQualifiedErrorId : ERROR_TIMEOUT,Microsoft.DnsClient.Commands.ResolveDnsName
```

L'erreur est `ERROR_TIMEOUT` : « le délai est dépassé ». **Personne n'a répondu.** Ce n'est pas `DNS name does not exist` (TP 13) : ce message-là veut dire qu'un serveur a répondu « ce nom n'existe pas ». Ici, il n'y a pas de serveur.

**Étape 4 — Ajouter une règle NRPT pour un seul domaine.**

```powershell
# sur PC-GUICHET1
Add-DnsClientNrptRule -Namespace ".horizon.local" -NameServers 10.20.20.10
```

La règle dit : « pour tout nom en `.horizon.local`, **demande à `10.20.20.10`** » (`DC1`). La commande n'affiche rien.

**Étape 5 — Constater que la règle répare ce domaine.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName dc1.horizon.local
```

```
Name      : dc1.horizon.local
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 10.20.20.10
```

Le nom se résout de nouveau, alors que le serveur DNS configuré sur la carte est toujours le mauvais : la règle l'emporte pour ce suffixe.

**Étape 6 — Lire la règle.**

```powershell
# sur PC-GUICHET1
Get-DnsClientNrptRule
```

```
Name                             : {44137ADA-B847-8475-D19D-3DF0A0619021}
Version                          : 2
Namespace                        : {.horizon.local}
IPsecCARestriction               : 
DirectAccessDnsServers           : {}
DirectAccessEnabled              : False
DirectAccessProxyType            : 
DirectAccessProxyName            : 
DirectAccessQueryIPsecEncryption : 
DirectAccessQueryIPsecRequired   : False
NameServers                      : {10.20.20.10}
DnsSecEnabled                    : False
DnsSecQueryIPsecEncryption       : 
DnsSecQueryIPsecRequired         : False
DnsSecValidationRequired         : False
NameEncoding                     : Utf8WithMapping
DisplayName                      : 
Comment                          : 
```

Il y a dix-huit lignes ; trois suffisent : `Namespace : {.horizon.local}` (le suffixe), `NameServers : {10.20.20.10}` (le serveur à interroger) et `Name`, l'identifiant de la règle. Le reste concerne `DirectAccess` et `DNSSEC`, que tu n'as pas à connaître ici.

**Étape 7 — Constater que la règle ne répare rien d'autre.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName www.banquehorizon.com
```

```
Resolve-DnsName : www.banquehorizon.com : This operation returned because the timeout period expired
    + CategoryInfo          : ResourceUnavailable: (www.banquehorizon.com:String) [Resolve-DnsName], Win32Exception
    + FullyQualifiedErrorId : ERROR_TIMEOUT,Microsoft.DnsClient.Commands.ResolveDnsName
```

Le nom **public** reste en panne : la règle ne concerne que `.horizon.local`. Pour les autres noms, le poste utilise toujours le serveur cassé. C'est l'intérêt d'une règle **par suffixe** : elle ne répare, et ne casse, que ce qu'elle nomme.

**Étape 8 — Retirer la règle.**

```powershell
# sur PC-GUICHET1
Get-DnsClientNrptRule | Remove-DnsClientNrptRule -Force
```

Le tube `|` envoie les règles trouvées à `Remove-DnsClientNrptRule`, qui les supprime (`-Force` évite la demande de confirmation).

**Étape 9 — Rendre au poste les serveurs du DHCP.**

```powershell
# sur PC-GUICHET1
Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ResetServerAddresses
```

`-ResetServerAddresses` supprime ce qui avait été fixé à la main : le poste revient au mode « serveurs donnés par le DHCP ». Contrôle :

```powershell
# sur PC-GUICHET1
Get-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -AddressFamily IPv4
```

```
InterfaceAlias InterfaceIndex AddressFamily ServerAddresses           
-------------- -------------- ------------- ---------------           
Ethernet 0                  2 IPv4          {10.20.20.10, 10.20.20.53}
```

On retrouve `DC1` puis `DNS-RES`, comme au TP 5.

**Étape 10 — Vérifier que tout marche.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName www.banquehorizon.com | Select-Object -First 1
```

`Select-Object -First 1` ne garde que **la première** fiche du résultat.

```
Name     : www.banquehorizon.com
Type     : CNAME
TTL      : 3596
Section  : Answer
NameHost : web.banquehorizon.com
```

La résolution publique fonctionne de nouveau.

> 🔍 **Point d'audit** — Les règles NRPT sont stockées dans le registre (`HKLM\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters\DnsPolicyConfig`) : elles sont **posées par stratégie de groupe** dans un domaine, et un attaquant qui peut les écrire peut rediriger la résolution d'un suffixe vers son serveur. À superviser comme n'importe quelle clé de persistance.

🆘 **Si ça ne marche pas.** À l'étape 5, toujours `ERROR_TIMEOUT` : la règle de l'étape 4 n'est pas posée (vérifie avec `Get-DnsClientNrptRule`), ou `DC1` ne répond pas. Si tu es bloqué, ré-importe le laboratoire (§ 0.1) : le poste retrouve ses serveurs d'origine.

**🧠 Ce que tu viens d'apprendre.**

- La **NRPT** est une table de règles **par suffixe** : chaque règle associe un domaine à des serveurs. La règle la plus spécifique l'emporte.
- `Set-DnsClientServerAddress -ServerAddresses` fixe les serveurs **à la main** et **remplace** ce que DHCP donnait ; `-ResetServerAddresses` revient au mode « configuré par DHCP ». `ipconfig /renew` seul **ne suffit pas** : il ne touche pas une liste fixée à la main.
- Les deux messages d'erreur à bien distinguer : `ERROR_TIMEOUT` (personne n'a répondu : mauvais serveur, réseau) contre `DNS_ERROR_RCODE_NAME_ERROR` (un serveur a répondu : le nom n'existe pas).

**Vérifie-toi.**

1. Que veut dire `ERROR_TIMEOUT` ? Et `DNS name does not exist` ?
2. Une règle NRPT sur `.horizon.local` répare-t-elle la résolution de `www.banquehorizon.com` ?

*Réponses.* (1) `ERROR_TIMEOUT` : aucun serveur n'a répondu ; `DNS name does not exist` : un serveur a répondu que le nom n'existe pas. (2) Non : elle ne s'applique qu'aux noms qui se terminent par `.horizon.local`.

---

# Partie IX — Observer

Un service qu'on ne sait pas observer est un service qu'on ne sait pas dépanner, ni prouver. Deux outils :

- le **journal des requêtes** de `named` : *ce qui a été demandé, et par qui* (TP 31) ;
- la **capture de paquets** : *ce qui a réellement circulé sur le câble* (TP 32).

---

## IX.1 🧪 TP 31 — Journaliser les requêtes

**🎯 Objectif.** Faire écrire à `named` une ligne par question reçue, dans un fichier qu'on choisit, et savoir lire cette ligne.

**Ce qu'il te faut.** Un terminal sur `DNS-RES` et un sur `PC-CONSEILLER`. Durée : environ 30 minutes. La configuration est remise en état à la fin.

Par défaut, un résolveur ne garde pas la trace de ce qu'on lui demande. Pour savoir **quel poste a cherché quel site**, il faut le lui demander explicitement.

**Étape 1 — Faire une copie de sauvegarde de la configuration.**

```
# sur DNS-RES
sudo cp /etc/bind/named.conf /tmp/named.conf.orig
```

`cp` copie un fichier. Si tu fais une erreur, tu pourras remettre l'original. La commande n'affiche rien.

**Étape 2 — Ajouter le bloc de journalisation.**

```
# sur DNS-RES
sudo mkdir -p /var/log/named; sudo tee -a /etc/bind/named.conf <<'EOF'
logging {
    channel query_log { file "/var/log/named/query.log" versions 3 size 5m; severity info; print-time yes; };
    category queries { query_log; };
};
EOF
```

Deux commandes sur une ligne. `mkdir -p /var/log/named` crée le dossier où le journal sera écrit. La seconde ajoute à `named.conf` un bloc `logging` qui définit **deux** choses :

```
logging {
    channel query_log { file "/var/log/named/query.log" versions 3 size 5m; severity info; print-time yes; };
    category queries { query_log; };
};
```

- un **canal** (`channel query_log`) : *où* écrire. Ici dans le fichier `/var/log/named/query.log`, avec `versions 3 size 5m` (garde trois archives de 5 Mo au plus) et `print-time yes` (écris l'heure sur chaque ligne) ;
- une **catégorie** (`category queries`) : *quoi* écrire. Ici les `queries`, c'est-à-dire les questions reçues, envoyées vers le canal `query_log`.

**Étape 3 — Vérifier la configuration.** Tu connais la règle d'or (TP 15).

```
# sur DNS-RES
named-checkconf; echo rc=$?
```

```
rc=0
```

**Étape 4 — Appliquer et allumer la journalisation.**

```
# sur DNS-RES
sudo rndc reconfig; sudo rndc querylog on; sudo rndc status | grep query
```

Trois commandes enchaînées : `rndc reconfig` relit la configuration, `rndc querylog on` **allume** la journalisation, et `rndc status | grep query` affiche la ligne de l'état qui parle de `query`.

```
query logging is ON
```

`query logging is ON` : le journal est actif.

**Étape 5 — Poser une question.**

```
# sur PC-CONSEILLER
dig @10.20.20.53 ebanking.banquehorizon.com +short
```

```
web.banquehorizon.com.
203.0.113.20
```

Le poste a obtenu l'alias et l'adresse, comme au TP 10.

**Étape 6 — Lire le journal.**

```
# sur DNS-RES
sudo cat /var/log/named/query.log
```

```
04-Nov-2026 10:29:25.476 client @0x0 10.20.10.52#59210 (ebanking.banquehorizon.com): query: ebanking.banquehorizon.com IN A +E(0) (10.20.20.53)
```

**Une ligne** pour cette question. Lis-la de gauche à droite :

| Champ | Valeur | Sens |
|---|---|---|
| Date | `04-Nov-2026 10:29:25.476` | Choisie par `print-time yes`. Chez toi, ce sera la date de ta machine |
| `client @0x0` | | Identifiant interne du client dans `named` (une adresse mémoire dans un vrai BIND ; ici toujours `0x0`) |
| `10.20.10.52#59210` | | L'**adresse** de la machine qui pose la question, et son **port** d'envoi (un numéro qui change à chaque `dig`) |
| `(ebanking.banquehorizon.com)` | | Le nom demandé, tel que le client l'a écrit |
| `query: … IN A` | | Nom, classe et **type** demandé |
| `+E(0)` | | Les **drapeaux** (étape 7) |
| `(10.20.20.53)` | | L'adresse du serveur qui a reçu la question |

C'est la réponse à la question « **qui a demandé quoi ?** » : le poste `10.20.10.52` (`PC-CONSEILLER`) a demandé l'adresse de `ebanking.banquehorizon.com`.

**Étape 7 — Lire les drapeaux, par l'expérience.** Pose maintenant la même question de quatre façons différentes :

```
# sur PC-CONSEILLER
dig @10.20.20.53 ebanking.banquehorizon.com +norecurse +short; dig @10.20.20.53 ebanking.banquehorizon.com +tcp +short; dig @10.20.20.53 ebanking.banquehorizon.com +noedns +short; dig @10.20.20.53 ebanking.banquehorizon.com +dnssec +short
```

Quatre commandes à la suite, séparées par `;`. Les options : `+norecurse` (ne demande pas la récursion), `+tcp` (envoie la question en TCP plutôt qu'en UDP, voir le TP 32), `+noedns` (n'envoie pas l'extension EDNS), `+dnssec` (demande les signatures DNSSEC).

```
web.banquehorizon.com.
203.0.113.20
web.banquehorizon.com.
203.0.113.20
web.banquehorizon.com.
203.0.113.20
web.banquehorizon.com.
203.0.113.20
```

Quatre fois la même réponse. C'est le **journal** qui garde la différence :

```
# sur DNS-RES
sudo tail -4 /var/log/named/query.log
```

`tail -4` affiche les **quatre dernières** lignes.

```
04-Nov-2026 10:29:25.507 client @0x0 10.20.10.52#57693 (ebanking.banquehorizon.com): query: ebanking.banquehorizon.com IN A -E(0) (10.20.20.53)
04-Nov-2026 10:29:25.517 client @0x0 10.20.10.52#32768 (ebanking.banquehorizon.com): query: ebanking.banquehorizon.com IN A +E(0)T (10.20.20.53)
04-Nov-2026 10:29:25.532 client @0x0 10.20.10.52#35384 (ebanking.banquehorizon.com): query: ebanking.banquehorizon.com IN A + (10.20.20.53)
04-Nov-2026 10:29:25.536 client @0x0 10.20.10.52#45456 (ebanking.banquehorizon.com): query: ebanking.banquehorizon.com IN A +E(0)D (10.20.20.53)
```

Une ligne par variante, dans l'ordre. Regarde la fin de chaque ligne, juste avant l'adresse du serveur :

| Variante | Ce que le journal montre | Sens |
|---|---|---|
| `+norecurse` | `-E(0)` | Le `-` à la place du `+` : la récursion n'a **pas** été demandée |
| `+tcp` | `+E(0)T` | Le `T` : la question est venue en **TCP** |
| `+noedns` | `+` | Plus de `E(0)` : pas d'extension EDNS |
| `+dnssec` | `+E(0)D` | Le `D` : le client a demandé les signatures **DNSSEC** (bit DO) |

Le vrai BIND ajoute encore la lettre `K` quand le client a envoyé un *cookie* (le simulateur n'en envoie pas).

**Étape 8 — Remettre en état.**

```
# sur DNS-RES
sudo cp /tmp/named.conf.orig /etc/bind/named.conf; sudo rndc reconfig; sudo rndc querylog off; sudo rndc status | grep query
```

On restaure la sauvegarde, on recharge, on **éteint** la journalisation.

```
query logging is OFF
```

`query logging is OFF` : retour à l'état initial.

> 🔍 **Point d'audit** — Ce journal est une **donnée personnelle** : il dit quel poste a cherché quel site. Il se conserve selon une durée décidée (et écrite), avec un accès restreint. Et c'est la meilleure source pour retrouver, après coup, quels postes ont résolu le nom d'un domaine malveillant.

🆘 **Si ça ne marche pas.**

- À l'étape 6, le fichier n'existe pas ou est vide : la journalisation n'est pas allumée (retour à l'étape 4), ou `named-checkconf` a refusé le bloc (étape 3 : `rc` n'est pas 0).
- `named-checkconf` affiche une erreur : un point-virgule manque dans le bloc de l'étape 2. Reprends-le tel quel, accolades et points-virgules compris.

**🧠 Ce que tu viens d'apprendre.**

- Un bloc `logging` définit un **canal** (où écrire, avec rotation) et une **catégorie** (quoi écrire).
- `rndc querylog on|off` active et désactive la journalisation **sans redémarrer** : on l'allume pour un diagnostic, on l'éteint ensuite, car un résolveur chargé écrit des milliers de lignes par minute.
- Chaque ligne dit : quand, **qui** (adresse et port), **quoi** (nom et type), et les **drapeaux** de la question (`+`/`-` récursion, `E` EDNS, `T` TCP, `D` DNSSEC).

**Vérifie-toi.**

1. Quelle lettre du journal indique qu'une question est venue en TCP ?
2. Que veut dire un `-` au début des drapeaux ?
3. Pourquoi éteint-on la journalisation après un diagnostic ?

*Réponses.* (1) `T`. (2) La récursion n'a pas été demandée. (3) Un résolveur chargé écrit des milliers de lignes par minute, ce qui remplit le disque.

---

## IX.2 🧪 TP 32 — Voir le DNS sur le fil : UDP, troncature, TCP

**🎯 Objectif.** Capturer des paquets DNS, les relire, et voir ce qui se passe quand une réponse **ne tient pas** dans un datagramme UDP.

**Ce qu'il te faut.** Un terminal sur `NS1-BANK` et un sur `PC-CONSEILLER`. Durée : environ 50 minutes. Tout est remis en état à la fin.

**Deux façons d'envoyer un message DNS.** Jusqu'ici tu as vu des mots comme `UDP` sans les expliquer. Voici l'essentiel.

| | **UDP** | **TCP** |
|---|---|---|
| Principe | On envoie un petit paquet, sans formalités | On ouvre une **connexion** (poignée de main), on échange, on la ferme |
| Vitesse | Très rapide | Plus lent (la poignée de main coûte des échanges) |
| Taille | Limitée à **512 octets** pour le DNS d'origine | Aucune limite pratique |
| Usage par le DNS | Presque toutes les questions | Les réponses trop grosses, et les transferts de zone |

Une réponse DNS qui dépasse 512 octets ne tient pas dans un paquet UDP. Que fait le serveur ? Il envoie ce qui rentre, et lève un drapeau **`tc`** (*truncated*, « tronqué »). Le client voit ce drapeau et **recommence en TCP**. Tu vas le voir de tes yeux.

**Étape 1 — Fabriquer une grosse réponse.**

On publie 60 adresses sous un même nom (`many`), ce qui suffit à dépasser 512 octets.

```
# sur NS1-BANK
for i in $(seq 1 60); do echo "many IN A 198.51.100.$i" | sudo tee -a /etc/bind/db.banquehorizon.com > /dev/null; done; sudo sed -i 's/2026103101/2026103102/' /etc/bind/db.banquehorizon.com; sudo rndc reload banquehorizon.com
```

Cette ligne fait trois choses :

1. `for i in $(seq 1 60); do … done` répète **60 fois** ce qui est entre `do` et `done`, avec `i` qui vaut successivement 1, 2, …, 60 ;
2. à chaque tour, `echo … | sudo tee -a …` ajoute au fichier de zone une ligne `many IN A 198.51.100.<i>` (le `> /dev/null` jette l'affichage, pour ne pas inonder l'écran) ;
3. ensuite, comme au TP 18, on monte le numéro de série et on recharge.

```
zone reload queued
```

**Étape 2 — Voir la réponse tronquée.**

On pose la question **sans EDNS** (`+noedns`), c'est-à-dire comme le faisaient les clients d'avant 1999, limités à 512 octets. On ajoute `+ignore` : « si la réponse est tronquée, **ne recommence pas** en TCP, montre-moi la réponse tronquée ».

```
# sur PC-CONSEILLER
dig @203.0.113.10 many.banquehorizon.com +noedns +norecurse +ignore +noall +comments +stats
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 54
;; flags: qr aa tc; QUERY: 1, ANSWER: 29, AUTHORITY: 0, ADDITIONAL: 0

;; Query time: 0 msec
;; SERVER: 203.0.113.10#53(203.0.113.10) (UDP)
;; WHEN: Wed Nov 04 10:29:31 UTC 2026
;; MSG SIZE  rcvd: 504
```

Trois choses à lire :

- `flags: qr aa tc` : le drapeau **`tc`** est là. Le serveur dit « ma réponse est coupée ».
- `ANSWER: 29` : il n'a pu mettre que **29** adresses sur les 60.
- `(UDP)` et `MSG SIZE rcvd: 504` : la réponse est arrivée en UDP, elle fait 504 octets, tout juste sous la limite de 512.

**Étape 3 — Voir `dig` recommencer en TCP tout seul.**

Sans `+ignore`, `dig` fait ce que fait un vrai client.

```
# sur PC-CONSEILLER
dig @203.0.113.10 many.banquehorizon.com +noedns +norecurse +noall +comments +stats
```

```
;; Truncated, retrying in TCP mode.
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 56
;; flags: qr aa; QUERY: 1, ANSWER: 60, AUTHORITY: 2, ADDITIONAL: 2

;; Query time: 0 msec
;; SERVER: 203.0.113.10#53(203.0.113.10) (TCP)
;; WHEN: Wed Nov 04 10:29:31 UTC 2026
;; MSG SIZE  rcvd: 1068
```

`;; Truncated, retrying in TCP mode.` : `dig` a vu `tc` et a recommencé en TCP. Cette fois : `ANSWER: 60` (les 60 adresses), `(TCP)` et `MSG SIZE rcvd: 1068` : la réponse complète, qui n'aurait jamais tenu dans 512 octets.

**Étape 4 — Demander directement en TCP.**

```
# sur PC-CONSEILLER
dig @203.0.113.10 mail.banquehorizon.com +tcp +noall +comments +answer +stats
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 57
;; flags: qr aa rd; QUERY: 1, ANSWER: 1, AUTHORITY: 2, ADDITIONAL: 3
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; ANSWER SECTION:
mail.banquehorizon.com.	3600	IN	A	203.0.113.25

;; Query time: 0 msec
;; SERVER: 203.0.113.10#53(203.0.113.10) (TCP)
;; WHEN: Wed Nov 04 10:29:31 UTC 2026
;; MSG SIZE  rcvd: 135
```

`+tcp` force le TCP même pour une petite question : `(TCP)` à la fin. Il n'y a rien à tronquer ; on a seulement choisi le mode.

**Étape 5 — Éviter le TCP : EDNS et la taille de 1232.**

Depuis 1999, une extension appelée **EDNS** permet au client d'annoncer *la taille de réponse qu'il accepte en UDP*. Avec 1232 octets, notre grosse réponse tient en un seul paquet :

```
# sur PC-CONSEILLER
dig @203.0.113.10 many.banquehorizon.com +bufsize=1232 +norecurse +noall +comments
```

`+bufsize=1232` annonce « j'accepte jusqu'à 1232 octets en UDP ».

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 58
;; flags: qr aa; QUERY: 1, ANSWER: 60, AUTHORITY: 2, ADDITIONAL: 3

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
```

`ANSWER: 60`, **pas de `tc`**, et aucune bascule en TCP : tout est arrivé en un seul datagramme UDP. (La valeur 1232 est celle recommandée pour éviter que les paquets soient fragmentés par IP.)

**Étape 6 — Voir tout cela sur le câble.**

Jusqu'ici, tu as vu ce que `dig` dit. Voyons maintenant ce qui a **réellement circulé**. L'outil est `tcpdump`, qui écoute une carte réseau et enregistre les paquets.

```
# sur PC-CONSEILLER
sudo tcpdump -ni eth0 -w /tmp/dns.pcap port 53 & sleep 1; dig @203.0.113.10 many.banquehorizon.com +noedns +norecurse +noall +comments; sleep 1; sudo pkill tcpdump; sleep 1
```

Lis cette commande en quatre temps :

1. `sudo tcpdump -ni eth0 -w /tmp/dns.pcap port 53 &` lance la capture en arrière-plan (`&`) : elle écoute la carte `eth0`, ne garde que le **port 53** (celui du DNS) et écrit tout dans le fichier `/tmp/dns.pcap` ;
2. `sleep 1` laisse une seconde à la capture pour démarrer ;
3. `dig …` pose la question ;
4. `sleep 1; sudo pkill tcpdump; sleep 1` arrête la capture.

```
[1] 45
;; Truncated, retrying in TCP mode.
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 52
;; flags: qr aa; QUERY: 1, ANSWER: 60, AUTHORITY: 2, ADDITIONAL: 2
```

Tu retrouves la réponse de l'étape 3 (la bascule en TCP). Le `[1] 45` est le numéro de la tâche en arrière-plan. Maintenant, relis la capture :

```
# sur PC-CONSEILLER
sudo tcpdump -nr /tmp/dns.pcap
```

`-r` veut dire « lis ce fichier » ; `-n` empêche `tcpdump` de remplacer les adresses par des noms.

```
reading from file /tmp/dns.pcap, link-type EN10MB (Ethernet), snapshot length 262144
10:29:26.782723 IP 10.20.10.52.50810 > 203.0.113.10.53: 51 A? many.banquehorizon.com. (40)
10:29:26.788844 IP 203.0.113.10.53 > 10.20.10.52.50810: 51*-| 29/0/0 A 198.51.100.1, A 198.51.100.2, A 198.51.100.3, A 198.51.100.4, A 198.51.100.5, A 198.51.100.6, A 198.51.100.7, A 198.51.100.8, A 198.51.100.9, A 198.51.100.10, A 198.51.100.11, A 198.51.100.12, A 198.51.100.13, A 198.51.100.14, A 198.51.100.15, A 198.51.100.16, A 198.51.100.17, A 198.51.100.18, A 198.51.100.19, A 198.51.100.20, A 198.51.100.21, A 198.51.100.22, A 198.51.100.23, A 198.51.100.24, A 198.51.100.25, A 198.51.100.26, A 198.51.100.27, A 198.51.100.28, A 198.51.100.29 (504)
10:29:26.792844 IP 10.20.10.52.32769 > 203.0.113.10.53: Flags [S], seq 2634807467, win 65535, options [mss 1460,sackOK,TS val 13418 ecr 0,nop,wscale 7], length 0
10:29:26.795876 IP 203.0.113.10.53 > 10.20.10.52.32769: Flags [S.], seq 2871740974, ack 2634807468, win 65535, options [mss 1460,sackOK,TS val 13420 ecr 13418,nop,wscale 7], length 0
10:29:26.795876 IP 10.20.10.52.32769 > 203.0.113.10.53: Flags [.], ack 1, win 511, options [nop,nop,TS val 13421 ecr 13420], length 0
10:29:26.798891 IP 10.20.10.52.32769 > 203.0.113.10.53: Flags [P.], seq 1:43, ack 1, win 511, options [nop,nop,TS val 13424 ecr 13420], length 42 52 A? many.banquehorizon.com. (40)
10:29:26.801125 IP 203.0.113.10.53 > 10.20.10.52.32769: Flags [P.], seq 1:1071, ack 43, win 511, options [nop,nop,TS val 13426 ecr 13424], length 1070 52*- 60/2/2 A 198.51.100.2, A 198.51.100.3, A 198.51.100.4, A 198.51.100.5, A 198.51.100.6, A 198.51.100.7, A 198.51.100.8, A 198.51.100.9, A 198.51.100.10, A 198.51.100.11, A 198.51.100.12, A 198.51.100.13, A 198.51.100.14, A 198.51.100.15, A 198.51.100.16, A 198.51.100.17, A 198.51.100.18, A 198.51.100.19, A 198.51.100.20, A 198.51.100.21, A 198.51.100.22, A 198.51.100.23, A 198.51.100.24, A 198.51.100.25, A 198.51.100.26, A 198.51.100.27, A 198.51.100.28, A 198.51.100.29, A 198.51.100.30, A 198.51.100.31, A 198.51.100.32, A 198.51.100.33, A 198.51.100.34, A 198.51.100.35, A 198.51.100.36, A 198.51.100.37, A 198.51.100.38, A 198.51.100.39, A 198.51.100.40, A 198.51.100.41, A 198.51.100.42, A 198.51.100.43, A 198.51.100.44, A 198.51.100.45, A 198.51.100.46, A 198.51.100.47, A 198.51.100.48, A 198.51.100.49, A 198.51.100.50, A 198.51.100.51, A 198.51.100.52, A 198.51.100.53, A 198.51.100.54, A 198.51.100.55, A 198.51.100.56, A 198.51.100.57, A 198.51.100.58, A 198.51.100.59, A 198.51.100.60, A 198.51.100.1 (1068)
10:29:26.801125 IP 10.20.10.52.32769 > 203.0.113.10.53: Flags [F.], seq 43, ack 1071, win 511, options [nop,nop,TS val 13427 ecr 13426], length 0
10:29:26.801154 IP 203.0.113.10.53 > 10.20.10.52.32769: Flags [.], ack 44, win 511, options [nop,nop,TS val 13429 ecr 13427], length 0
10:29:26.801154 IP 203.0.113.10.53 > 10.20.10.52.32769: Flags [F.], seq 1071, ack 44, win 511, options [nop,nop,TS val 13429 ecr 13427], length 0
10:29:26.801154 IP 10.20.10.52.32769 > 203.0.113.10.53: Flags [.], ack 1072, win 511, options [nop,nop,TS val 13430 ecr 13429], length 0
```

(Les lignes 3 et 8 sont très longues : elles énumèrent toutes les adresses, 29 puis 60. Fais défiler le bloc vers la droite pour les lire.) La capture compte **onze paquets** (la ligne 1 n'est que l'en-tête du fichier), que tu peux lire par blocs :

| Lignes | Ce que c'est |
|---|---|
| 2 | La **question** en UDP : `A? many.banquehorizon.com.` |
| 3 | La **réponse tronquée** en UDP : `29/0/0`, avec le signe `\|` qui veut dire « tronquée » |
| 4, 5, 6 | La **poignée de main TCP** : `[S]` (SYN), `[S.]` (SYN-ACK), `[.]` (ACK) |
| 7 | La **question** de nouveau, en TCP |
| 8 | La **réponse complète** en TCP : `60/2/2`, les 60 adresses |
| 9 à 12 | La **fermeture** de la connexion (`[F.]`, FIN) |

**Étape 7 — Lire une ligne de `tcpdump`.** Les lignes 2 et 3 en détail :

| Morceau | Sens |
|---|---|
| `51` | L'identifiant de la question (la réponse porte le même) |
| `A?` | C'est une **question** de type A |
| `(40)` | La longueur du message DNS, en octets |
| `51*-\|` | Une **réponse** : `*` = faisant autorité (`aa`), `-` = récursion non disponible, `\|` = **tronquée** (`tc`) |
| `29/0/0` | Nombre de fiches en `ANSWER` / `AUTHORITY` / `ADDITIONAL` |

**Étape 8 — Pour comparaison : une question « normale ».** Avec EDNS (le comportement par défaut de `dig`) et le résolveur de l'agence, pour une petite réponse :

```
# sur PC-CONSEILLER
sudo tcpdump -ni eth0 -w /tmp/dns2.pcap port 53 & sleep 1; dig @10.20.20.53 mail2.banquehorizon.com +short; sleep 1; sudo pkill tcpdump; sleep 1
```

```
[1]+  Done                sudo tcpdump -ni eth0 -w /tmp/dns.pcap port 53
[2] 47
203.0.113.26
```

(La première ligne, `Done`, est la fin de la capture précédente.) Relis :

```
# sur PC-CONSEILLER
sudo tcpdump -nr /tmp/dns2.pcap
```

```
reading from file /tmp/dns2.pcap, link-type EN10MB (Ethernet), snapshot length 262144
10:29:29.844169 IP 10.20.10.52.59334 > 10.20.20.53.53: 53+ [1au] A? mail2.banquehorizon.com. (52)
10:29:29.851316 IP 10.20.20.53.53 > 10.20.10.52.59334: 53 1/2/3 A 203.0.113.26 (136)
```

**Deux paquets seulement** : une question (`53+ [1au] A? …`, où `+` = récursion demandée et `[1au]` = l'extension EDNS), une réponse (`53 1/2/3 A 203.0.113.26`). Pas de poignée de main : c'est UDP, léger. Voilà ce que fait le DNS au quotidien.

**Étape 9 — Remise en état.**

```
# sur NS1-BANK
sudo sed -i '/^many /d; s/2026103102/2026103103/' /etc/bind/db.banquehorizon.com; sudo rndc reload banquehorizon.com
```

```
zone reload queued
```

On supprime les 60 lignes `many` et on monte le numéro de série (TP 18).

🆘 **Si ça ne marche pas.**

- À l'étape 2, tu ne vois pas `tc` : l'étape 1 n'est pas terminée (le rechargement de la zone n'est pas passé). Vérifie avec `dig @203.0.113.10 many.banquehorizon.com +short` : tu dois voir une liste d'adresses.
- À l'étape 6, `tcpdump` affiche `command not found` : tu n'es pas sur `PC-CONSEILLER`.
- La capture est vide : ne retire pas les `sleep 1` autour de la commande `dig`.

**🧠 Ce que tu viens d'apprendre.**

1. Sans EDNS, une réponse UDP est limitée à **512 octets**. Le serveur met dans le datagramme ce qui tient (29 adresses), positionne le bit **TC** (*truncated*) et envoie.
2. Le client voit `tc` et **recommence en TCP** : poignée de main (SYN, SYN-ACK, ACK), la question, la réponse **complète** (`60/2/2`), fermeture (FIN).
3. Avec **EDNS**, le client annonce la taille qu'il accepte (`udp: 1232`) : 60 adresses tiennent, aucun TCP.

- **Le DNS utilise TCP, aussi.** Un pare-feu qui n'ouvre que `UDP/53` casse les grosses réponses (listes d'adresses, DNSSEC, certaines réponses `TXT`) : le symptôme est « ça marche pour les petits noms, pas pour les gros », très difficile à trouver sans capture.
- Un transfert de zone (TP 18) se fait **toujours** par TCP.
- `dig +ignore` ne sert qu'à *voir* la réponse tronquée ; en pratique on laisse `dig` recommencer.

> 🔍 **Point d'audit** — Garde des captures datées du trafic DNS à la frontière du réseau : elles prouvent, après coup, qu'un poste a bien interrogé un domaine donné, et à quelle heure.

**Vérifie-toi.**

1. Que signifie le drapeau `tc` ?
2. Que fait `dig` quand il le voit ?
3. Pourquoi un pare-feu qui bloque `TCP/53` est-il un problème ?

*Réponses.* (1) La réponse est tronquée : elle ne tient pas dans le paquet UDP. (2) Il recommence la question en TCP. (3) Les réponses trop grosses (et les transferts de zone) ne passeraient plus : certains noms marcheraient, d'autres non.

---

# Partie X — Le web vu du DNS

Tu as passé neuf parties à faire parler le DNS. Il est temps de te demander : **dans « ouvrir un site web », que fait réellement le DNS ?** La réponse est modeste : il donne l'**adresse**. Tout le reste (quelle page, quel certificat, quelle redirection) appartient à d'autres protocoles. Un TP pour le voir.

---

## X.1 🧪 TP 33 — Un nom, une adresse, plusieurs sites

**🎯 Objectif.** Comprendre la part du DNS dans « ouvrir un site » — et ce qu'il ne fait **pas** : il donne l'adresse, le reste appartient à HTTP et à TLS.

**Ce qu'il te faut.** Un terminal sur `PC-CONSEILLER`. Durée : environ 25 minutes.

**Le rappel de départ.** Au TP 10, tu as vu que `www`, `ebanking`, `agences` et `api` sont quatre alias d'une **même machine** (`web`, `203.0.113.20`). Quatre noms, une adresse. Comment le serveur de cette machine sait-il quelle page servir, selon le nom que tu as tapé ? Tu vas le découvrir avec `curl`, un outil qui télécharge des pages web en ligne de commande.

**Étape 1 — Ouvrir `www` en HTTP.**

```
# sur PC-CONSEILLER
curl -sI http://www.banquehorizon.com/
```

Les options de `curl` : `-s` (*silent*) supprime les messages de progression, et `-I` demande **seulement les en-têtes** de la réponse, pas la page elle-même.

```
HTTP/1.1 301 Moved Permanently
Server: nginx/1.24.0
Content-Type: text/html
Location: https://www.banquehorizon.com/
Content-Length: 169
```

La première ligne : `HTTP/1.1 301 Moved Permanently`. Le code `301` veut dire « cette page a **déménagé** ». La ligne `Location: https://www.banquehorizon.com/` dit où : c'est la **version sécurisée** (HTTPS) du même site. Le serveur n'a pas servi la page, il a **redirigé** vers HTTPS.

**Étape 2 — Ouvrir `ebanking` en HTTPS.**

```
# sur PC-CONSEILLER
curl -skI https://ebanking.banquehorizon.com/
```

Une option de plus : `-k` dit à `curl` d'**ignorer la vérification du certificat**. (Dans le laboratoire, le certificat n'est pas signé par une autorité reconnue : en vrai, on ne met jamais `-k` pour un site qu'on ne contrôle pas.)

```
HTTP/1.1 200 OK
Server: nginx/1.24.0
Content-Type: text/html
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Frame-Options: DENY
Cache-Control: no-store
Last-Modified: Wed, 04 Nov 2026 10:22:24 GMT
ETag: "6aeb0760-5e4"
Accept-Ranges: bytes
Content-Length: 1508
```

`200 OK` : la page est servie. Remarque deux choses. D'abord, le nom `ebanking` mène à la **même machine** que `www`, mais la réponse n'est pas la même (pas de redirection, une autre page de 1 508 octets). Ensuite, le serveur ajoute des en-têtes de **sécurité** (`Strict-Transport-Security`, `X-Frame-Options`, `Cache-Control: no-store`) propres à ce site.

Le DNS a donné la **même adresse** pour `www` et pour `ebanking`. C'est donc le serveur web qui a choisi quoi répondre. Mais comment, puisqu'il reçoit la même adresse ?

**Étape 3 — Viser la machine par son adresse seule.**

```
# sur PC-CONSEILLER
curl -s -o /dev/null -w "%{http_code}\n" http://203.0.113.20/
```

Trois nouveautés : `-o /dev/null` jette la page (on n'en veut pas), et `-w "%{http_code}\n"` affiche seulement le **code de réponse**.

```
404
```

`404` : « page introuvable ». En visant l'adresse `203.0.113.20` **sans nom**, le serveur ne sait pas quel site tu veux. Il en héberge plusieurs, et n'en a choisi aucun.

**Étape 4 — Annoncer le nom, sans passer par le DNS.**

```
# sur PC-CONSEILLER
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: www.banquehorizon.com" http://203.0.113.20/
```

`-H "Host: www.banquehorizon.com"` ajoute un **en-tête** à la requête : « je veux le site `www.banquehorizon.com` ». On vise toujours l'adresse, mais cette fois on dit le nom.

```
301
```

`301` : on retrouve la redirection de l'étape 1. Le serveur a choisi le site `www`, d'après l'en-tête **`Host:`**.

**Ce qui s'est passé.** Quand tu tapes `http://www.banquehorizon.com/` :

```schema
 1. Le DNS traduit le nom en adresse          →  203.0.113.20
 2. Le navigateur se connecte à cette adresse et envoie « Host: www.banquehorizon.com »
 3. Le serveur web lit ce nom et choisit le site à servir
```

Le DNS n'a servi qu'à l'étape 1. L'étape 3, c'est l'affaire du serveur web.

🆘 **Si ça ne marche pas.** `curl: (6) Could not resolve host` : le nom ne se résout pas, c'est un problème de DNS (reprends le TP 5). `curl: (7) Failed to connect` : le nom se résout, mais le serveur web ne répond pas (`ping -c 1 203.0.113.20` pour vérifier la connectivité).

**🧠 Ce que tu viens d'apprendre.**

- Le DNS dit *où* (l'adresse) ; c'est le serveur web qui décide *quoi* servir, d'après le nom que le client lui annonce — l'en-tête **`Host:`** en HTTP, l'extension **SNI** dans la poignée de main TLS (HTTPS).
- C'est pour cela que `curl http://203.0.113.20/` donne `404` : par l'adresse, il n'y a pas de nom, donc pas de site. **Tester un site en le visant par son adresse IP est un mauvais test.** L'option `-H "Host: …"` ou `curl --resolve nom:443:adresse` permettent de tester proprement.
- Changer l'adresse de `web` (une migration de serveur) change l'accès aux **quatre** sites en une seule modification : c'est l'intérêt du CNAME. Son prix : une résolution de plus à chaque fois (TP 10).
- Le **CNAME est interdit au sommet de la zone** : `banquehorizon.com.` lui-même porte un `A` (`203.0.113.20`), pas un alias, parce qu'un sommet de zone a toujours un SOA et des NS, et qu'un CNAME ne peut coexister avec aucun autre type (TP 15, cas 4).

> 🔍 **Point d'audit** — Plusieurs sites sur une seule adresse : un certificat qui ne couvre pas tous les noms est le défaut le plus fréquent. Vérifie, nom par nom, que le certificat présenté correspond (`curl -v` ou `openssl s_client -servername …`).

**Vérifie-toi.**

1. Quelle est la seule chose que le DNS apporte à l'ouverture d'un site ?
2. Pourquoi `http://203.0.113.20/` ne montre-t-il pas le site de la banque ?
3. Que signifie `301` ?

*Réponses.* (1) L'adresse IP correspondant au nom. (2) Sans nom, le serveur ne sait pas quel site servir parmi ceux qu'il héberge. (3) « Déplacé définitivement » : le serveur renvoie vers une autre adresse web, ici la version HTTPS.

---

# Partie XI — Quand ça ne marche pas, et comment le prouver

Tout ce que tu as fait jusqu'ici sert maintenant. **Dépanner un service de noms, c'est poser les bonnes questions dans le bon ordre, et lire les réponses sans les interpréter trop vite.** Cette partie te donne la méthode, puis te fait pratiquer : cinq pannes à diagnostiquer, et un audit.

---

## XI.1 La méthode en six questions

Devant « ça ne résout pas », **ne change rien** avant d'avoir répondu à ces six questions, dans cet ordre. Chaque réponse élimine une famille de causes.

| # | Question | Comment y répondre | Ce que tu cherches |
|---|---|---|---|
| 1 | **Qui interroge qui ?** | `resolvectl status`, `cat /etc/resolv.conf` (Linux) ; `Get-DnsClientServerAddress`, `ipconfig /all` (Windows) | Le serveur DNS que le poste utilise *vraiment* (TP 5), et le suffixe de recherche (TP 6) |
| 2 | **Le serveur répond-il ?** | `dig @serveur nom +time=1 +tries=1` | `connection refused` (service arrêté), `timed out` (réseau, pare-feu, mauvaise adresse), ou une réponse (TP 27, TP 30) |
| 3 | **Que dit le code de retour ?** | `status:` dans l'en-tête de `dig`, avec `+noall +comments` | `NXDOMAIN`, `NOERROR` vide (NODATA), `SERVFAIL`, `REFUSED` : quatre pannes différentes (TP 13, TP 26) |
| 4 | **Est-ce du cache ?** | TTL qui décroît (TP 21) ; `+norecurse` ; interroger directement le serveur d'autorité | Une réponse ancienne ou négative retenue (TP 22) : vider au bon niveau (TP 25) |
| 5 | **Les serveurs d'autorité sont-ils d'accord ?** | `dig @ns1 zone SOA +short` puis `@ns2` ; `dig +trace` | Un numéro de série différent (TP 19), une délégation fausse (TP 8, TP 20) |
| 6 | **Que voit-on réellement sur le fil ?** | `tcpdump -w` puis `-r` ; journal des requêtes | Le paquet part-il ? La réponse revient-elle ? En UDP seulement ? (TP 31, TP 32) |

Tu peux imprimer ce tableau et le garder sous les yeux : c'est le résumé de tout le tutoriel.

**Deux règles qui évitent les fausses pistes.**

- **Teste toujours avec l'outil qui ressemble à l'application.** `dig` ignore la liste de suffixes (sauf `+search`) et le cache du système : `getent hosts` (Linux) et `Resolve-DnsName` (Windows) font ce que font les programmes (TP 6).
- **Change une chose à la fois, et vérifie chaque changement par la commande qui a révélé le symptôme.** Si tu changes trois choses et que ça marche, tu ne sais pas laquelle a réparé.

---

## XI.2 🧪 TP 34 — Cinq pannes à diagnostiquer

**🎯 Objectif.** Appliquer la méthode : cinq symptômes, une commande décisive pour chacun, la cause, le remède.

**Ce qu'il te faut.** Les TP 5 à 30 terminés (la méthode s'appuie sur eux). Un terminal sur `DNS-RES`, un sur `PC-CONSEILLER` et un sur `DC1`. Durée : environ 1 heure 15.

Les deux premières pannes sont **guidées** : tu les provoques, tu les diagnostiques et tu les répares, pas à pas. Les trois dernières sont à **toi de jouer** : essaie de trouver la commande décisive avant de regarder la solution.

### Panne 1 — « Plus rien ne se résout dans l'agence »

**Étape 1 — Provoquer la panne.**

```
# sur DNS-RES
sudo systemctl stop named
```

`systemctl stop named` arrête le service DNS du résolveur (TP 27). La commande n'affiche rien.

**Étape 2 — Constater les symptômes.** Applique les questions 1 et 2 : à qui le poste parle-t-il ? Répond-il ?

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.banquehorizon.com +time=1 +tries=1
```

```
;; communications error to 10.20.20.53#53: connection refused

; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> @10.20.20.53 www.banquehorizon.com +time=1 +tries=1
; (1 server found)
;; global options: +cmd
;; no servers could be reached
```

`connection refused` : la machine `10.20.20.53` est joignable, mais **rien n'écoute** sur le port 53 (TP 27).

```
# sur PC-CONSEILLER
dig www.banquehorizon.com +short
```

Cette commande **n'affiche rien du tout** : ni erreur, ni réponse. Le poste passe par le stub (TP 5), qui s'appuie sur `DNS-RES`, et `+short` ne montre aucune erreur. **C'est la pire sortie à interpréter** : un blanc ne dit pas pourquoi. Repasse en `+noall +comments` pour voir le code de retour.

**Étape 3 — Diagnostiquer sur le serveur.** Trois commandes pour confirmer que `named` ne tourne plus.

```
# sur DNS-RES
sudo rndc status
```

```
rndc: connect failed: 127.0.0.1#953: connection refused
```

`rndc` ne peut pas se connecter à `named` : il n'est pas là.

```
# sur DNS-RES
ss -ulnp | grep named; echo rc=$?
```

```
rc=1
```

`ss` (TP 14, étape 9) ne trouve plus aucun processus `named` à l'écoute ; `grep` n'a rien trouvé, donc son code de retour est `1` (échec).

```
# sur DNS-RES
systemctl is-active named
```

```
inactive
```

`inactive` : le service est arrêté. C'est le diagnostic.

**Étape 4 — Réparer, puis vérifier.**

```
# sur DNS-RES
sudo systemctl start named
```

```
# sur PC-CONSEILLER
dig www.banquehorizon.com +short
```

```
web.banquehorizon.com.
203.0.113.20
```

Les réponses sont revenues.

*Leçon* : `rndc: connect failed … connection refused` et un `connection refused` sur le port 53 racontent la même histoire : `named` ne tourne pas.

### Panne 2 — « Le serveur DNS principal du poste est arrêté, et tout marche »

Une panne qui se passe sans que personne ne s'en plaigne est la plus dangereuse. Voyons-la.

**Étape 1 — Vider le cache du stub, puis arrêter `DC1`.**

```
# sur PC-CONSEILLER
sudo resolvectl flush-caches
```

`resolvectl flush-caches` vide le cache du stub du poste Linux (TP 25).

```powershell
# sur DC1
Stop-Service DNS
```

`Stop-Service DNS` arrête le service DNS de `DC1`, le **premier** serveur DNS donné au poste par le DHCP (TP 5). Aucune des deux commandes n'affiche quoi que ce soit.

**Étape 2 — Résoudre un nom public.**

```
# sur PC-CONSEILLER
dig ebanking.banquehorizon.com +short
```

```
web.banquehorizon.com.
203.0.113.20
```

Ça marche ! Comment est-ce possible alors que le premier serveur est arrêté ? Regarde quel serveur le poste utilise maintenant :

```
# sur PC-CONSEILLER
resolvectl status | grep 'Current DNS'
```

```
  Current DNS Server: 10.20.20.53
```

`Current DNS Server: 10.20.20.53` : le poste a **basculé** sur son deuxième serveur, `DNS-RES`. L'utilisateur n'a rien vu.

**Étape 3 — Remettre `DC1` en marche.**

```powershell
# sur DC1
Start-Service DNS
```

*Leçon* : une panne partielle peut être **invisible** pour l'utilisateur, ce qui est le but de deux serveurs. Mais elle doit être visible pour toi, par la **supervision**, pas par les plaintes. (Les noms de `horizon.local` n'auraient pas résolu : seul `DC1` les connaît, TP 28.)

### Panne 3 — « J'ai changé l'enregistrement, mais certains voient encore l'ancien »

**À toi de jouer.** Quelles sont les deux commandes qui disent si les serveurs d'autorité sont d'accord ?

<details>
<summary>Voir la solution</summary>

C'est la question 5 de la méthode : compare le SOA des deux serveurs d'autorité.

```
# sur PC-CONSEILLER
dig @203.0.113.10 banquehorizon.com SOA +short; dig @203.0.113.11 banquehorizon.com SOA +short
```

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

Ici les deux numéros de série sont identiques : le secondaire est à jour. **S'ils étaient différents**, le secondaire serait en retard (le numéro n'a pas été monté, TP 19) : remède, monter le numéro de série **et** recharger. **Si les numéros sont identiques et qu'une réponse reste ancienne**, c'est un **cache** (question 4, puis TP 25).

</details>

### Panne 4 — « SERVFAIL sur un domaine »

**À toi de jouer.** Quelle commande montre où la chaîne de résolution s'arrête ?

<details>
<summary>Voir la solution</summary>

`dig +trace @10.20.20.53 domaine` : la chaîne s'arrête à la délégation dont le serveur ne répond pas (TP 26, TP 8). Un `SERVFAIL` n'est **jamais** réparé en modifiant le résolveur : la cause est **en aval**, chez un serveur d'autorité ou dans la délégation.

</details>

### Panne 5 — « Un seul poste n'arrive plus à résoudre les noms internes »

**À toi de jouer.** Un seul poste est touché, les autres vont bien. Où cherches-tu ?

<details>
<summary>Voir la solution</summary>

La cause est **locale** au poste, pas dans le service. Commandes décisives (question 1) : `Get-DnsClientServerAddress` sur ce poste, et `Get-DnsClientNrptRule`. Un serveur DNS fixé à la main qui n'existe plus (le `10.20.20.250` du TP 30), une règle NRPT oubliée. Remède : `Set-DnsClientServerAddress -ResetServerAddresses` rend la main au DHCP.

</details>

**🧠 Ce que tu viens d'apprendre.**

| Symptôme | Cause la plus probable | Commande décisive |
|---|---|---|
| `connection refused` | Service arrêté | `systemctl is-active named`, `rndc status` |
| `timed out` | Réseau, pare-feu, mauvaise adresse du serveur | `ping`, `Get-DnsClientServerAddress` |
| `REFUSED` | ACL (`allow-query`, `allow-recursion`) ou serveur non récursif | Configuration du serveur (TP 16) |
| `SERVFAIL` | Serveur d'autorité en aval cassé, DNSSEC | `dig +trace` |
| `NXDOMAIN` | Nom absent — **ou** absence en cache | Interroger l'autorité avec `+norecurse` |
| `NOERROR` + 0 réponse | Type absent (NODATA) | `dig nom TYPE` |
| Réponse différente selon le serveur | Secondaire en retard | SOA des deux serveurs |

---

## XI.3 Les messages d'erreur et ce qu'ils veulent dire

Tous ces messages ont été produits dans ce laboratoire. Garde ce tableau à portée de main : quand tu en vois un, il te dit où commencer à chercher.

| Message | Où | Sens | Premier geste |
|---|---|---|---|
| `;; communications error to X#53: connection refused` | `dig` | Rien n'écoute sur le port 53 de X | Le service tourne-t-il ? |
| `;; communications error to X#53: timed out` puis `;; no servers could be reached` | `dig` | Aucune réponse de X | Joignabilité, pare-feu, adresse |
| `status: REFUSED` | `dig` | Le serveur refuse **ta** question | ACL, récursion |
| `status: SERVFAIL` | `dig` | Le serveur n'a pas pu la résoudre | `dig +trace` |
| `status: NXDOMAIN` | `dig` | Le nom n'existe pas (ou est retenu comme absent) | Cache négatif, faute de frappe |
| `ANSWER: 0` avec `NOERROR` | `dig` | Le nom existe, pas ce type | Autre type |
| `; Transfer failed.` | `dig AXFR` | Transfert refusé (`allow-transfer`) ou TCP bloqué | ACL de transfert, pare-feu TCP/53 |
| `WARNING: recursion requested but not available` | `dig` | Le serveur n'offre pas la récursion | Normal pour un serveur d'autorité |
| `zone reload queued` | `rndc` | Demande enregistrée — **pas** « chargé » | `named-checkzone`, journal |
| `zone reload up-to-date` | `rndc` | Le fichier n'a pas changé depuis le dernier chargement | A-t-on sauvegardé le fichier ? |
| `rndc: 'reload' failed: not found` / `no matching zone '…' in any view` | `rndc` | Nom de zone inconnu du serveur | Faute de frappe dans le nom |
| `… unknown RR type`, `bad dotted quad`, `extra input text`, `CNAME and other data`, `has no NS records`, `has 0 SOA records` | `named-checkzone` | Erreurs de zone (TP 15) | Fichier:ligne du message |
| `boolean expected near '…'`, `missing ';' before '…'`, `unknown option '…'`, `undefined ACL '…'` | `named-checkconf` | Erreurs de configuration | Fichier:ligne du message |
| `Host X not found: 3(NXDOMAIN)` | `host` | Idem `NXDOMAIN` | |
| `DNS name does not exist` (`DNS_ERROR_RCODE_NAME_ERROR`) | `Resolve-DnsName` | `NXDOMAIN` | |
| `DNS record does not exist` (`DNS_ERROR_RECORD_DOES_NOT_EXIST`) | `Resolve-DnsName` | NODATA | |
| `This operation returned because the timeout period expired` (`ERROR_TIMEOUT`) | `Resolve-DnsName` | Aucune réponse | Serveur DNS du poste |

---

## XI.4 🧪 TP 35 — Auditer le service de noms

**🎯 Objectif.** Dérouler la liste de contrôles d'un auditeur sur le laboratoire, **avec la preuve** de chaque point.

**Ce qu'il te faut.** Un terminal sur `PC-CONSEILLER` et un sur `NS1-BANK`. Durée : environ 40 minutes.

Un **audit** consiste à vérifier qu'un système est configuré comme il doit l'être, et à **garder la preuve** de cette vérification. Chaque contrôle ci-dessous a une commande, un résultat attendu, et une preuve à conserver (la sortie, datée).

**Contrôle 1 — Le serveur d'autorité n'est pas un résolveur ouvert.**

Une question hors de ses zones doit être refusée :

```
# sur PC-CONSEILLER
dig @203.0.113.10 www.exemple.test +noall +comments
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: REFUSED, id: 67
;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
```

Attendu : `status: REFUSED`. Si le serveur répondait, il serait utilisable par n'importe qui pour des attaques par amplification (TP 9).

**Contrôle 2 — Le transfert de zone est restreint.**

Un poste ordinaire ne doit pas pouvoir copier la zone :

```
# sur PC-CONSEILLER
dig @203.0.113.10 banquehorizon.com AXFR
```

```
; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> @203.0.113.10 banquehorizon.com AXFR
; (1 server found)
;; global options: +cmd
; Transfer failed.
```

Attendu : `Transfer failed.` Sinon, un attaquant obtiendrait la liste complète de tes machines (TP 18).

**Contrôle 3 — La version du serveur n'est pas annoncée à tout le monde.**

Par défaut, la requête `version.bind` (une question de classe spéciale, `CHAOS`) révèle la version du logiciel :

```
# sur PC-CONSEILLER
dig @203.0.113.10 version.bind CHAOS TXT +short
```

```
"9.18.12-0ubuntu0.22.04.1-Ubuntu"
```

Avec la version, un attaquant sait quelles failles connues exploiter. On la masque en ajoutant `version none;` dans le bloc `options` de `NS1-BANK` :

```
# sur NS1-BANK
sudo sed -i 's/recursion no;/recursion no; version none;/' /etc/bind/named.conf; sudo rndc reconfig; named-checkconf; echo rc=$?
```

```
rc=0
```

`rc=0` : la configuration est valide. Repose la question :

```
# sur PC-CONSEILLER
dig @203.0.113.10 version.bind CHAOS TXT +noall +comments +authority
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 68
;; flags: qr aa rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 0
;; WARNING: recursion requested but not available

;; AUTHORITY SECTION:
version.bind.		86400	CH	SOA	version.bind. hostmaster.version.bind. 0 28800 7200 604800 86400
```

Plus de réponse (`ANSWER: 0`), seulement un SOA de la pseudo-zone `version.bind`. La version n'est plus divulguée. On remet la configuration d'origine :

```
# sur NS1-BANK
sudo sed -i 's/ version none;//' /etc/bind/named.conf; sudo rndc reconfig; grep -c version /etc/bind/named.conf
```

```
0
```

`grep -c` compte les lignes qui contiennent `version` : `0`, la ligne a bien disparu.

**Contrôle 4 — Les deux serveurs d'autorité servent la même version de la zone.**

```
# sur PC-CONSEILLER
dig @203.0.113.10 banquehorizon.com SOA +short; dig @203.0.113.11 banquehorizon.com SOA +short
```

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

Attendu : le même numéro de série sur les deux lignes (TP 18, TP 19).

**Contrôle 5 — La configuration et les zones se chargent sans erreur.**

```
# sur NS1-BANK
named-checkconf -z; echo rc=$?
```

```
zone banquehorizon.com/IN: loaded serial 2026103101
zone 113.0.203.in-addr.arpa/IN: loaded serial 2026103101
rc=0
```

Attendu : `rc=0` et les numéros de série chargés (TP 15).

**Contrôle 6 — Le résolveur n'est offert qu'au réseau de l'agence.** Voir le TP 16 : l'ACL `agence` et le test de sortie de l'ACL (`REFUSED`).

**Contrôle 7 — La politique de journalisation est écrite et appliquée.** Voir le TP 31.

**Synthèse de l'audit.**

| Contrôle | Commande | Attendu | Preuve à conserver |
|---|---|---|---|
| Pas de récursion ouverte | `dig @autorité nom-hors-zone` | `REFUSED` | La sortie, datée |
| Transfert restreint | `dig @autorité zone AXFR` depuis un poste non autorisé | `Transfer failed.` | La sortie, datée |
| Version masquée | `dig version.bind CHAOS TXT` | Pas de `TXT` | La sortie, datée |
| Cohérence primaire/secondaire | SOA des deux serveurs | Même numéro de série | Les deux lignes |
| Configuration saine | `named-checkconf -z; echo rc=$?` | `rc=0` | Sortie + somme de `named.conf` |
| Résolveur restreint | Test hors ACL (TP 16) | `REFUSED` | La sortie, datée |
| Journalisation | `rndc status \| grep query`, fichier de log | Conforme à la politique | Extrait + durée de conservation |

Masquer la version n'est **pas** une protection : c'est une façon de ne pas faciliter le travail de qui cherche une faille connue. Aucun de ces contrôles ne remplace la mise à jour du logiciel.

🆘 **Si ça ne marche pas.** Au contrôle 3, `dig … version.bind` répond encore la version après `version none;` : `named` n'a pas relu sa configuration (vérifie que `rc=0`), ou la ligne n'a pas été ajoutée (`grep version /etc/bind/named.conf`).

**🧠 Ce que tu viens d'apprendre.**

- Un audit, ce sont des **contrôles reproductibles**, chacun avec une commande, un résultat attendu et une preuve datée.
- Les contrôles du service de noms portent sur : qui peut interroger, qui peut copier, ce qu'on révèle, si les serveurs sont d'accord, si la configuration est saine, ce qui est journalisé.

**Vérifie-toi.**

1. Quel résultat prouve qu'un serveur d'autorité n'est pas un résolveur ouvert ?
2. Pourquoi masquer la version n'est-il pas une vraie protection ?

*Réponses.* (1) `status: REFUSED` à une question hors de ses zones. (2) Parce qu'elle ne corrige aucune faille : elle ne fait que ne pas faciliter le travail de l'attaquant.

---

## XI.5 Et maintenant ?

Tu as parcouru l'essentiel du DNS tel qu'un administrateur le rencontre : poser une question et lire la réponse, descendre l'arbre, connaître les types de fiches, administrer des serveurs BIND et Windows, comprendre les caches, tolérer une panne, observer, diagnostiquer, auditer.

Le simulateur contient encore d'autres aspects du DNS que ce tutoriel n'aborde pas : la signature des zones (DNSSEC), l'authentification des transferts et des mises à jour (TSIG), les mises à jour dynamiques côté BIND, la résolution sur le réseau local (mDNS, LLMNR) et la découverte de services (DNS-SD). Ce tutoriel t'a donné les bases pour les explorer.

Quand tu seras à l'aise, refais un TP **sans lire** le texte, en t'appuyant seulement sur l'aide-mémoire de l'Annexe A.

---

# Annexes

## A.1 Aide-mémoire

### `dig`

| Besoin | Commande |
|---|---|
| Question simple | `dig nom` ; `dig nom TYPE` ; `dig -x ADRESSE` |
| Choisir le serveur | `dig @serveur nom` |
| Réponse seule | `dig nom +short` ; `+noall +answer` |
| Voir les codes | `+noall +comments` (+ `+authority`, `+additional`) |
| Sans récursion (interroger l'autorité) | `+norecurse` |
| Refaire le travail du résolveur | `+trace` |
| Utiliser la liste de suffixes du système | `+search` |
| Forcer TCP / réponse tronquée | `+tcp` / `+ignore` |
| Taille EDNS / pas d'EDNS | `+bufsize=1232` / `+noedns` |
| Délai et essais | `+time=1 +tries=1` |
| Transfert de zone | `dig @serveur zone AXFR` |
| Version du serveur | `dig @serveur version.bind CHAOS TXT` |

### Drapeaux d'une réponse

`qr` réponse · `aa` fait autorité · `tc` tronquée · `rd` récursion demandée · `ra` récursion disponible · `ad` authentifiée (DNSSEC) · `cd` vérification désactivée.

### `named`, `rndc` et vérificateurs (BIND)

| Besoin | Commande |
|---|---|
| Vérifier la configuration (+ charger les zones) | `named-checkconf [-z]` |
| Vérifier une zone | `named-checkzone zone fichier` |
| Recharger une zone / toutes / la configuration | `rndc reload zone` / `rndc reload` / `rndc reconfig` |
| État du serveur | `rndc status` |
| Vider le cache : tout / un nom / un domaine | `rndc flush` / `rndc flushname nom` / `rndc flushtree domaine` |
| Dumper le cache | `rndc dumpdb -cache` (fichier `named_dump.db`) |
| Journaliser les requêtes | `rndc querylog on\|off` |
| Redémarrer le service | `sudo systemctl restart named` (vide aussi le cache) |

### Windows

| Besoin | Commande |
|---|---|
| Interroger | `Resolve-DnsName nom [-Type MX] [-Server ip]` ; `nslookup` |
| Serveurs DNS du poste | `Get-DnsClientServerAddress` ; `Set-DnsClientServerAddress -ServerAddresses …` ; `-ResetServerAddresses` |
| Cache du poste | `Get-DnsClientCache` ; `ipconfig /displaydns` ; `Clear-DnsClientCache` ; `ipconfig /flushdns` |
| Règles par suffixe | `Get-DnsClientNrptRule` ; `Add-DnsClientNrptRule` ; `Remove-DnsClientNrptRule` |
| Serveur DNS Windows | `Get-DnsServerZone` ; `Get-DnsServerResourceRecord -ZoneName zone` ; `Get-DnsServerForwarder` ; `Show-DnsServerCache` ; `Add-DnsServerZoneDelegation` |
| Bail et renouvellement | `ipconfig /release` ; `ipconfig /renew` ; `Get-DhcpServerv4Lease` |

### Linux

| Besoin | Commande |
|---|---|
| Serveur DNS réellement utilisé | `resolvectl status` ; `cat /etc/resolv.conf` |
| Résoudre comme un programme | `getent hosts nom` ; `host nom` ; `host -t TYPE nom` |
| Vider le cache du stub | `sudo resolvectl flush-caches` |
| Capturer le DNS | `sudo tcpdump -ni eth0 -w fichier port 53` puis `tcpdump -nr fichier` |

### Les chiffres à retenir

| Valeur | Sens |
|---|---|
| 512 octets | Taille maximale d'une réponse UDP **sans** EDNS |
| 1232 octets | Taille EDNS recommandée par BIND (évite la fragmentation) |
| 900 s | Durée du cache négatif du client Windows |
| Champ `minimum` du SOA | Plafond de la durée des réponses négatives |
| `servfail-ttl` ≤ 30 s | Durée de conservation d'un `SERVFAIL` |
| Port 53 UDP **et** TCP | Les deux sont nécessaires |

---

## B.1 Glossaire

Les mots du DNS, par ordre alphabétique. Le numéro entre parenthèses renvoie à la section où le mot est expliqué.

| Mot | Définition courte |
|---|---|
| **A** | Type de fiche qui associe un nom à une adresse IPv4 (§ I.11, TP 10) |
| **AAAA** | Type de fiche qui associe un nom à une adresse IPv6 (TP 10) |
| **aa** | Drapeau « *authoritative answer* » : celui qui répond fait autorité sur la zone (TP 2) |
| **ACL** | Liste d'adresses nommée, utilisée pour décider qui a le droit de faire quoi (TP 16) |
| **Alias** | Un nom qui en désigne un autre, par une fiche CNAME (TP 10) |
| **AXFR** | Transfert complet d'une zone d'un serveur à un autre, par TCP (TP 18) |
| **Autorité (serveur faisant)** | Serveur qui détient la version officielle d'une zone et en répond comme source de vérité (§ I.6) |
| **Bail (DHCP)** | Configuration réseau prêtée à un poste pour une durée limitée (TP 29) |
| **Cache** | Mémoire où un résolveur ou un poste garde les réponses déjà obtenues (§ I.10, Partie VII) |
| **Cache négatif** | Cache de l'absence : « ce nom n'existe pas » est retenu, comme une réponse (TP 22) |
| **CNAME** | Type de fiche : le nom est un alias d'un autre nom (TP 10) |
| **Délégation** | Déclaration, dans une zone parente, que la gestion d'un sous-domaine est confiée à d'autres serveurs (§ I.7, TP 8) |
| **DHCP** | Service qui prête automatiquement une adresse et une configuration à un poste (TP 29) |
| **dig** | Outil Linux pour poser une question au DNS et lire la réponse entière (TP 2) |
| **DMARC** | Fiche TXT qui dit quoi faire d'un courrier qui échoue aux contrôles anti-usurpation (TP 11) |
| **DNSSEC** | Signature cryptographique des zones DNS (non abordé ici) |
| **EDNS** | Extension du protocole DNS qui permet notamment d'annoncer la taille de réponse acceptée (TP 2, TP 32) |
| **Flush (vider)** | Effacer tout ou partie d'un cache (TP 25) |
| **Glue** | Adresse d'un serveur jointe à un renvoi, pour éviter une résolution circulaire (TP 8) |
| **Hint (zone)** | Zone qui contient les adresses des serveurs racine, point de départ d'un résolveur (TP 16) |
| **IN** | Classe « Internet » des fiches ; toujours `IN` en pratique (TP 2) |
| **MX** | Type de fiche : serveur de messagerie d'un domaine, avec sa préférence (TP 11) |
| **NODATA** | Réponse `NOERROR` sans réponse : le nom existe, pas ce type de fiche (TP 13) |
| **NOTIFY** | Message d'un primaire à un secondaire : « ma zone a changé » (TP 18) |
| **NRPT** | Table de règles Windows qui associe un suffixe à des serveurs DNS (TP 30) |
| **NS** | Type de fiche : serveur qui détient une zone ou à qui elle est déléguée (§ I.11) |
| **NXDOMAIN** | Code de retour : ce nom n'existe pas (TP 13) |
| **Primaire / secondaire** | Le primaire détient la copie de référence d'une zone ; le secondaire en détient une copie recopiée (TP 18) |
| **PTR** | Type de fiche de la résolution inverse : une adresse pointe vers un nom (TP 12) |
| **ra / rd** | Drapeaux : `rd` = récursion demandée par le client, `ra` = récursion disponible chez le serveur (TP 2, TP 9) |
| **Récursion** | Fait de parcourir tout l'arbre pour répondre à la place du client (TP 9) |
| **Redirecteur (forwarder)** | Serveur vers lequel un autre serveur envoie ce qu'il ne sait pas résoudre (TP 28) |
| **Renvoi (referral)** | Réponse qui n'est pas la réponse mais l'adresse du prochain serveur à interroger (TP 8) |
| **REFUSED** | Code de retour : le serveur refuse de répondre à cette question (TP 9, TP 16) |
| **Résolveur** | Serveur qui fait tout le chemin pour répondre à un client, et garde les réponses en cache (§ I.8) |
| **Racine** | Sommet de l'arbre des noms, désigné par un point `.` (§ I.5) |
| **SERVFAIL** | Code de retour : le serveur n'a pas réussi à répondre (TP 26) |
| **SOA** | Type de fiche « identité » d'une zone : serveur primaire, numéro de série, durées (TP 11) |
| **SPF** | Fiche TXT qui liste les serveurs autorisés à envoyer du courrier pour un domaine (TP 11) |
| **SRV** | Type de fiche : serveur **et port** d'un service (TP 11) |
| **Stub** | Petit programme local qui relaie les questions du poste vers le résolveur (§ I.8, TP 5) |
| **Suffixe de recherche** | Domaine ajouté automatiquement à un nom court (TP 6) |
| **tc** | Drapeau « tronqué » : la réponse ne tient pas dans un paquet UDP (TP 32) |
| **TLD** | « *Top-level domain* » : le dernier mot d'un nom (`com`) (§ I.5) |
| **TTL** | Durée de vie, en secondes, d'une fiche en cache (§ I.10, TP 21) |
| **TXT** | Type de fiche : texte libre, utilisé pour SPF et DMARC (TP 11) |
| **UDP / TCP** | Les deux modes d'envoi : UDP rapide et limité en taille, TCP avec connexion et sans limite (TP 32) |
| **Zone** | Portion de l'arbre des noms gérée par un même ensemble de serveurs (§ I.6) |

---

*Fin du tutoriel. Si une commande de ce document ne produit pas ce qui est écrit, c'est un défaut du simulateur ou du document : le test `tuto-dns-zero-a-heros.test.ts` est là pour le dire.*

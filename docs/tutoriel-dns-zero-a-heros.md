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
10. [🧪 TP 2 — Lire une réponse de `dig`](#10--tp-2--lire-une-réponse-de-dig)
11. [🧪 TP 3 — Choisir ce que `dig` affiche](#11--tp-3--choisir-ce-que-dig-affiche)
12. [🧪 TP 4 — Les mêmes questions côté Windows](#12--tp-4--les-mêmes-questions-côté-windows)
13. [🧪 TP 5 — Qui est mon serveur DNS ?](#13--tp-5--qui-est-mon-serveur-dns-)
14. [🧪 TP 6 — Les suffixes de recherche](#14--tp-6--les-suffixes-de-recherche)

### Partie IV — Descendre l'arbre
15. [🧪 TP 7 — `dig +trace` : refaire le travail du résolveur](#15--tp-7--dig-trace--refaire-le-travail-du-résolveur)
16. [🧪 TP 8 — Interroger chaque niveau : renvois et glue](#16--tp-8--interroger-chaque-niveau--renvois-et-glue)
17. [🧪 TP 9 — Le bit de récursion](#17--tp-9--le-bit-de-récursion)

### Partie V — Les enregistrements
18. [🧪 TP 10 — A, AAAA et CNAME](#18--tp-10--a-aaaa-et-cname)
19. [🧪 TP 11 — MX, TXT (SPF, DMARC) et SRV](#19--tp-11--mx-txt-spf-dmarc-et-srv)
20. [🧪 TP 12 — PTR : retrouver un nom depuis une adresse](#20--tp-12--ptr--retrouver-un-nom-depuis-une-adresse)
21. [🧪 TP 13 — NXDOMAIN ou NODATA ?](#21--tp-13--nxdomain-ou-nodata-)

### Partie VI — Les serveurs
22. [🧪 TP 14 — Lire la configuration et la zone de NS1-BANK](#22--tp-14--lire-la-configuration-et-la-zone-de-ns1-bank)
23. [🧪 TP 15 — Vérifier avant de recharger](#23--tp-15--vérifier-avant-de-recharger)
24. [🧪 TP 16 — Le résolveur DNS-RES](#24--tp-16--le-résolveur-dns-res)
25. [🧪 TP 17 — Les serveurs Windows](#25--tp-17--les-serveurs-windows)
26. [🧪 TP 18 — Modifier une zone et la voir arriver chez le secondaire](#26--tp-18--modifier-une-zone-et-la-voir-arriver-chez-le-secondaire)
27. [🧪 TP 19 — Le piège du numéro de série oublié](#27--tp-19--le-piège-du-numéro-de-série-oublié)
28. [⭐ 🧪 TP 20 — Créer sa propre zone et la brancher dans l'arbre](#28---tp-20--créer-sa-propre-zone-et-la-brancher-dans-larbre)

### Partie VII — Le cache
29. [🧪 TP 21 — Le TTL qui décroît](#29--tp-21--le-ttl-qui-décroît)
30. [🧪 TP 22 — Le cache négatif](#30--tp-22--le-cache-négatif)
31. [🧪 TP 23 — Le cache du poste Windows](#31--tp-23--le-cache-du-poste-windows)
32. [🧪 TP 24 — Lire le cache de BIND](#32--tp-24--lire-le-cache-de-bind)
33. [🧪 TP 25 — Vider le cache, en entier ou en partie](#33--tp-25--vider-le-cache-en-entier-ou-en-partie)
34. [🧪 TP 26 — Le cache des échecs (SERVFAIL)](#34--tp-26--le-cache-des-échecs-servfail)

### Partie VIII — Redondance, DNS privé et DHCP
35. [🧪 TP 27 — NS1-BANK tombe](#35--tp-27--ns1-bank-tombe)
36. [🧪 TP 28 — DNS interne et redirecteur](#36--tp-28--dns-interne-et-redirecteur)
37. [🧪 TP 29 — DHCP et enregistrement dynamique](#37--tp-29--dhcp-et-enregistrement-dynamique)
38. [🧪 TP 30 — La NRPT du poste Windows](#38--tp-30--la-nrpt-du-poste-windows)

### Partie IX — Observer
39. [🧪 TP 31 — Journaliser les requêtes](#39--tp-31--journaliser-les-requêtes)
40. [🧪 TP 32 — Voir le DNS sur le fil : UDP, troncature, TCP](#40--tp-32--voir-le-dns-sur-le-fil--udp-troncature-tcp)

### Partie X — Le web vu du DNS
41. [🧪 TP 33 — Un nom, une adresse, plusieurs sites](#41--tp-33--un-nom-une-adresse-plusieurs-sites)

### Partie XI — Quand ça ne marche pas, et comment le prouver
42. [La méthode en six questions](#42-la-méthode-en-six-questions)
43. [🧪 TP 34 — Cinq pannes à diagnostiquer](#43--tp-34--cinq-pannes-à-diagnostiquer)
44. [Les messages d'erreur et ce qu'ils veulent dire](#44-les-messages-derreur-et-ce-quils-veulent-dire)
45. [🧪 TP 35 — Auditer le service de noms](#45--tp-35--auditer-le-service-de-noms)
46. [Aide-mémoire](#46-aide-mémoire)

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

Cinq outils, que tu utiliseras tout au long du tutoriel :

| Outil | Où | Pour quoi faire |
|---|---|---|
| **`dig`** | Linux | L'outil de référence : il montre **tout** le message DNS |
| **`nslookup`** | Windows (et Linux) | Plus lisible, moins détaillé ; interroge directement un serveur |
| **`Resolve-DnsName`** | PowerShell | Le `dig` de Windows : sort des objets, passe par le cache du poste |
| **`getent hosts`** / **`ping`** | Linux | Ce que **les applications** voient (ils passent par la même chaîne que `curl` ou `ssh`) |
| **`rndc`** | serveurs BIND | La télécommande de `named` (recharger, vider le cache, lire le cache) |

---

## 10. 🧪 TP 2 — Lire une réponse de `dig`

**🎯 Objectif.** Savoir lire, ligne par ligne, la réponse complète de `dig`. Tout le reste du tutoriel s'appuie sur cette lecture.

**🔧 Manipulation.**

```
# sur PC-CONSEILLER
dig www.banquehorizon.com
```

**✅ Résultat attendu.**

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
;; WHEN: Wed Nov 04 08:55:08 UTC 2026
;; MSG SIZE  rcvd: 84
```

(L'`id`, la date et la durée changent d'une exécution à l'autre.)

Lis la réponse du haut vers le bas :

| Ligne | Ce qu'elle dit |
|---|---|
| `status: NOERROR` | La question a été traitée sans erreur |
| `flags: qr rd ra` | C'est une **r**éponse (`qr`) ; tu **demandais** la récursion (`rd`) ; le serveur **l'offre** (`ra`). Pas de `aa` : celui qui répond **n'est pas** l'autorité de la zone, il l'a apprise ailleurs |
| `QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 1` | Le nombre d'enregistrements de chaque section. L'« 1 » de `ADDITIONAL` est l'enregistrement `OPT` d'EDNS, pas une vraie donnée |
| `EDNS … udp: 65494` | La taille de réponse que ce serveur sait envoyer en UDP |
| `QUESTION SECTION` | Ce que tu as demandé : le nom, la classe `IN`, le type `A` (par défaut) |
| `ANSWER SECTION` | Deux enregistrements : l'alias, puis l'adresse à laquelle il mène. Le **TTL** est `3600` secondes |
| `SERVER: 127.0.0.53#53 (UDP)` | **À qui** tu as parlé : pas à DNS-RES, mais au **stub local** (voir le TP 5) |
| `MSG SIZE rcvd: 84` | La taille de la réponse, en octets |

**🧠 Ce que tu viens d'apprendre.** Une réponse `dig` n'est pas « une adresse » : c'est un **message** avec un en-tête (drapeaux, code de retour, compteurs) et quatre sections. La ligne la plus importante est `SERVER:` — elle te dit qui a répondu. La seconde est `flags:` — elle te dit s'il s'agit d'une autorité (`aa`) ou d'un cache (`ra` sans `aa`).

---

## 11. 🧪 TP 3 — Choisir ce que `dig` affiche

**🎯 Objectif.** Ne voir que ce qui t'intéresse, et lire les sections qu'un résolveur masque.

**🔧 Manipulation.**

```
# sur PC-CONSEILLER
dig www.banquehorizon.com +short
dig www.banquehorizon.com +noall +answer
dig www.banquehorizon.com +noall +answer +stats
dig @203.0.113.10 banquehorizon.com MX +norecurse +noall +comments +answer +authority +additional
```

**✅ Résultat attendu.**

`+short` ne garde que les données :

```
web.banquehorizon.com.
203.0.113.20
```

`+noall +answer` : tout est éteint, puis on rallume la seule section de réponse (avec ses TTL) :

```
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
```

`+stats` rajoute le pied de page (durée, serveur, date, taille). Et la quatrième commande interroge **directement NS1-BANK**, sans le stub :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 49
;; flags: qr aa; QUERY: 1, ANSWER: 2, AUTHORITY: 2, ADDITIONAL: 5

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; ANSWER SECTION:
banquehorizon.com.	3600	IN	MX	10 mail.banquehorizon.com.
banquehorizon.com.	3600	IN	MX	20 mail2.banquehorizon.com.

;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	NS	ns1.banquehorizon.com.
banquehorizon.com.	3600	IN	NS	ns2.banquehorizon.com.

;; ADDITIONAL SECTION:
mail.banquehorizon.com.	3600	IN	A	203.0.113.25
mail2.banquehorizon.com. 3600	IN	A	203.0.113.26
ns1.banquehorizon.com.	3600	IN	A	203.0.113.10
ns2.banquehorizon.com.	3600	IN	A	203.0.113.11
```

(L'ordre de deux enregistrements d'un même ensemble peut changer d'une exécution à l'autre : c'est la **rotation** que les serveurs appliquent pour répartir la charge.)

**🧠 Ce que tu viens d'apprendre.**

- `+noall` éteint tout, puis on rallume : `+question`, `+answer`, `+authority`, `+additional`, `+comments` (en-tête et compteurs), `+stats`, `+cmd` (la bannière). `+short` est un raccourci qui ne garde que les données.
- `@203.0.113.10` choisit **le serveur à interroger** au lieu de celui du système. `+norecurse` retire le drapeau `rd` : « ne fais pas de récursion pour moi ».
- Un serveur **faisant autorité** (`aa`) écrit, à côté de la réponse, **les serveurs de la zone** (section `AUTHORITY`) et **les adresses dont tu auras besoin ensuite** (section `ADDITIONAL` : les serveurs de messagerie qu'il vient de te citer *et* les serveurs de la zone). C'est le comportement par défaut de BIND (`minimal-responses no`).

---

## 12. 🧪 TP 4 — Les mêmes questions côté Windows

**🎯 Objectif.** Poser les mêmes questions depuis un poste Windows et reconnaître ce que chaque outil ajoute.

**🔧 Manipulation.**

```powershell
# sur PC-GUICHET1
nslookup www.banquehorizon.com
nslookup -type=MX banquehorizon.com
nslookup www.banquehorizon.com 10.20.20.53
Resolve-DnsName banquehorizon.com -Type MX
```

**✅ Résultat attendu.**

```
Server:  dc1.horizon.local
Address:  10.20.20.10

Non-authoritative answer:
Name:    web.banquehorizon.com
Address:  203.0.113.20
Aliases:  www.banquehorizon.com
```

```
Server:  dc1.horizon.local
Address:  10.20.20.10

Non-authoritative answer:
banquehorizon.com	MX preference = 20, mail exchanger = mail2.banquehorizon.com
banquehorizon.com	MX preference = 10, mail exchanger = mail.banquehorizon.com
```

Interroger **DNS-RES** directement (3ᵉ commande) change la première ligne :

```
Server:  UnKnown
Address:  10.20.20.53

Non-authoritative answer:
Name:    web.banquehorizon.com
Address:  203.0.113.20
Aliases:  www.banquehorizon.com
```

et `Resolve-DnsName -Type MX` rend un objet par enregistrement :

```
Name         : banquehorizon.com
Type         : MX
TTL          : 3600
Section      : Answer
NameExchange : mail.banquehorizon.com
Preference   : 10
```

(Là aussi, l'ordre des deux MX peut varier.)

**🧠 Ce que tu viens d'apprendre.**

- `nslookup` **cherche d'abord le nom du serveur interrogé** (une requête PTR sur son adresse) pour écrire `Server:`. DC1 a un enregistrement inverse (`dc1.horizon.local`), DNS-RES n'en a pas : `UnKnown`. Ce n'est **pas** une erreur.
- `Non-authoritative answer` : la réponse ne vient pas de l'autorité de la zone, mais d'un cache ou d'un redirecteur. DC1 n'est pas autorité pour `banquehorizon.com`.
- `Aliases:` : `nslookup` présente le CNAME comme un alias du nom final.
- `Resolve-DnsName` passe par **le cache du poste** (TP 23) alors que `nslookup` interroge toujours un serveur.
- Les MX arrivent dans un ordre quelconque : c'est **la préférence** (le plus petit nombre d'abord) qui compte, pas la position.

---

## 13. 🧪 TP 5 — Qui est mon serveur DNS ?

**🎯 Objectif.** Savoir, sur chaque système, **quel serveur DNS la machine interroge**, et d'où elle le tient. C'est la première question de tout dépannage.

**🔧 Manipulation.**

```
# sur PC-CONSEILLER
cat /etc/resolv.conf
resolvectl status
```

```powershell
# sur PC-GUICHET1
Get-DnsClientServerAddress -InterfaceAlias "Ethernet 0"
Get-DnsClient
```

**✅ Résultat attendu.**

```
# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).
# Do not edit.

nameserver 127.0.0.53
search horizon.local
```

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

```
InterfaceAlias InterfaceIndex AddressFamily ServerAddresses           
-------------- -------------- ------------- ---------------           
Ethernet 0                  2 IPv4          {10.20.20.10, 10.20.20.53}
Ethernet 0                  2 IPv6          {}                        
```

`Get-DnsClient` montre en plus le suffixe propre à la carte (`ConnectionSpecificSuffix`: `horizon.local`).

**🧠 Ce que tu viens d'apprendre.**

- Sous Ubuntu, `/etc/resolv.conf` ne contient **pas** les vrais serveurs : il pointe le **stub** `127.0.0.53` de `systemd-resolved`. C'est lui qui connaît les vrais serveurs (ceux du bail DHCP, par carte réseau) : `resolvectl status` les liste. `Current DNS Server` est celui qui a répondu en dernier.
- Pourquoi un stub ? Parce que les serveurs peuvent changer à chaque bail DHCP, et que le stub **garde un cache** pour le poste (TP 21).
- Sous Windows, il n'y a pas de stub : le client DNS (`Dnscache`) lit directement les adresses de la carte, et on les voit avec `Get-DnsClientServerAddress`.
- `search horizon.local` / `DNS Domain: horizon.local` : le **suffixe de recherche** (TP 6).

> 🔍 **Point d'audit** — Que le serveur DNS d'un poste vienne du DHCP est une bonne chose (un seul endroit à tenir à jour) **à condition que le serveur DHCP soit lui-même maîtrisé** : un DHCP pirate qui donne son propre « DNS » détourne toute la résolution du poste.

---

## 14. 🧪 TP 6 — Les suffixes de recherche

**🎯 Objectif.** Comprendre pourquoi taper `intranet` suffit, alors que le vrai nom est `intranet.horizon.local`.

**🔧 Manipulation.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName intranet
```

```
# sur PC-CONSEILLER
getent hosts intranet
getent hosts dc1.horizon.local
dig intranet.horizon.local +short
dig intranet +noall +comments +question
dig intranet +search +noall +comments +question +answer
dig intranet +search +short
```

**✅ Résultat attendu.**

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

```
10.20.20.10     dc1.horizon.local intranet.horizon.local
10.20.20.10     dc1.horizon.local
dc1.horizon.local.
10.20.20.10
```

`getent hosts intranet` écrit le nom **canonique** d'abord (`dc1.horizon.local`, le bout du CNAME) puis l'alias qu'on a suivi (`intranet.horizon.local`) : c'est la forme d'un enregistrement `hosts`, nom officiel puis surnoms.

`dig`, lui, ne cherche **pas** dans la liste de suffixes tant qu'on ne le lui demande pas : le nom est cherché tel quel (`intranet.`, la racine) et n'existe pas.

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 40
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 65494
;; QUESTION SECTION:
;intranet.			IN	A
```

Avec `+search`, il lit la liste de `/etc/resolv.conf` (`search horizon.local`) et obtient, comme les applications, la bonne réponse. Remarque la question : c'est `intranet.horizon.local.` qui est partie sur le fil.

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

```
dc1.horizon.local.
10.20.20.10
```

**🧠 Ce que tu viens d'apprendre.** Le nom `intranet` n'a **aucun point** : le client le considère comme « court » et lui **ajoute le suffixe** reçu du DHCP (`horizon.local`) avant de poser la question. C'est le client qui complète, pas le serveur : sur le fil, la question est bien `intranet.horizon.local`. `dig`, lui, **n'ajoute pas** de suffixe par défaut (il faut `+search`) : c'est une différence classique entre ce que voient les applications (`getent`, `ping`, `curl`) et ce que montre `dig`.

⚠️ **Attention** — Un suffixe automatique est pratique et **dangereux** : si `intranet.horizon.local` n'existe pas, le client peut essayer `intranet.com`, ou le premier suffixe suivant. Un nom court mal tapé peut ainsi tomber sur le site d'un tiers. Réduis la liste des suffixes au strict nécessaire.

---

# Partie IV — Descendre l'arbre

---

## 15. 🧪 TP 7 — `dig +trace` : refaire le travail du résolveur

**🎯 Objectif.** Voir, étape par étape, le chemin que suit un résolveur : racine → `com` → banque.

**🔧 Manipulation.**

```
# sur PC-CONSEILLER
dig +trace @10.20.20.53 www.banquehorizon.com
```

**✅ Résultat attendu.**

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

**Lecture, hop par hop.**

| # | Interrogé | Il répond | Ce que ça dit |
|---|---|---|---|
| 1 | **DNS-RES** (10.20.20.53) | `. NS a.root-servers.net.` | Où est la racine ? Ce sont les **indices racine** du résolveur |
| 2 | **ROOT-NS** (198.51.100.1) | `com. NS a.nic.com.` + son adresse | La racine ne sait pas pour `www`, mais elle sait qui tient `com` : un **renvoi** (*referral*) |
| 3 | **TLD-NS** (198.51.100.2) | `banquehorizon.com. NS ns1, ns2` + adresses | `com` renvoie vers les deux serveurs de la banque, avec leur **glue** |
| 4 | **NS1-BANK** (203.0.113.10) | `www CNAME web`, `web A 203.0.113.20` | **La réponse**, de l'autorité |

**🧠 Ce que tu viens d'apprendre.** Chaque étape descend d'un niveau dans l'arbre. Les trois premières ne donnent **jamais la réponse** : elles donnent *l'adresse de la suite*. Seul le dernier serveur, qui est l'**autorité** de la zone, répond. C'est exactement ce que fait DNS-RES la première fois, sauf que lui garde tout en cache (TP 24).

💡 **Astuce** — `+trace` ignore le cache : il refait toujours le chemin complet. C'est l'outil idéal pour savoir **où** une délégation est cassée (le chemin s'arrête au saut fautif).

---

## 16. 🧪 TP 8 — Interroger chaque niveau : renvois et glue

**🎯 Objectif.** Poser *toi-même* la même question à ROOT-NS, à TLD-NS puis à NS1-BANK, sans récursion, et voir le renvoi se transformer en réponse.

**🔧 Manipulation.**

```
# sur ROOT-NS
dig @127.0.0.1 www.banquehorizon.com +norecurse +noall +comments +authority +additional
```

```
# sur PC-CONSEILLER
dig @198.51.100.2 www.banquehorizon.com +norecurse +noall +comments +authority +additional
dig @203.0.113.10 www.banquehorizon.com +norecurse +noall +comments +answer +authority +additional
```

**✅ Résultat attendu.**

ROOT-NS ne connaît que `com` :

```
;; flags: qr; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 2

;; AUTHORITY SECTION:
com.			86400	IN	NS	a.nic.com.

;; ADDITIONAL SECTION:
a.nic.com.		86400	IN	A	198.51.100.2
```

TLD-NS ne connaît que `banquehorizon.com` (c'est un serveur **Windows** : il annonce `udp: 4096` au lieu de `1232`, sans que cela change le raisonnement) :

```
;; flags: qr; QUERY: 1, ANSWER: 0, AUTHORITY: 2, ADDITIONAL: 3

;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	NS	ns1.banquehorizon.com.
banquehorizon.com.	3600	IN	NS	ns2.banquehorizon.com.

;; ADDITIONAL SECTION:
ns1.banquehorizon.com.	3600	IN	A	203.0.113.10
ns2.banquehorizon.com.	3600	IN	A	203.0.113.11
```

NS1-BANK, enfin, **répond** :

```
;; flags: qr aa; QUERY: 1, ANSWER: 2, AUTHORITY: 2, ADDITIONAL: 3

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

**🧠 Ce que tu viens d'apprendre.**

- Un renvoi se reconnaît à trois signes : `ANSWER: 0`, des `NS` dans la section `AUTHORITY`, **pas de `aa`**.
- La réponse définitive porte `aa` et une section `ANSWER` remplie.
- La **glue** (les `A` de la section `ADDITIONAL` d'un renvoi) n'est pas une décoration : sans elle, le résolveur devrait résoudre `ns1.banquehorizon.com`… dans la zone qu'il cherche justement à joindre. Le `ADDITIONAL: 2` de ROOT-NS compte la glue **et** l'enregistrement `OPT` d'EDNS que `dig` envoie avec sa question.

> 🔍 **Point d'audit** — Une délégation dont la glue est fausse (une adresse périmée après un changement de serveur) est l'une des pannes DNS les plus sournoises : tout marche tant que le cache du résolveur est chaud, tout s'effondre à l'expiration. Vérifie la glue **chez le parent** (ici TLD-NS), pas chez toi.

---

## 17. 🧪 TP 9 — Le bit de récursion

**🎯 Objectif.** Voir la différence entre un serveur qui *fait la récursion* (DNS-RES), un serveur qui *refuse de la faire* (TLD-NS) et un serveur qui *refuse de répondre* (NS1-BANK hors de sa zone).

**🔧 Manipulation.**

```
# sur DNS-RES
sudo rndc flush
dig @127.0.0.1 www.banquehorizon.com +norecurse +noall +comments +authority +additional
dig @127.0.0.1 www.banquehorizon.com +noall +comments +answer
dig @127.0.0.1 www.banquehorizon.com +norecurse +noall +comments +answer
```

```
# sur PC-CONSEILLER
dig @198.51.100.2 www.banquehorizon.com
dig @203.0.113.10 google.com
```

**✅ Résultat attendu.**

*Cache vidé, sans récursion* : DNS-RES ne sait rien du nom, il ne peut que renvoyer vers les serveurs racine de son fichier d'indices. Il **ne descend pas** l'arbre, puisqu'on le lui interdit :

```
;; flags: qr ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; AUTHORITY SECTION:
.			3600000	IN	NS	a.root-servers.net.
```

*Avec récursion*, il fait tout le chemin du TP 7 et répond. Remarque les compteurs : `AUTHORITY: 2, ADDITIONAL: 3` — un résolveur BIND recopie, à côté de la réponse, les `NS` de la zone et leur glue (comme le ferait un serveur d'autorité), même si la commande n'affiche que la section `ANSWER` :

```
;; flags: qr rd ra; QUERY: 1, ANSWER: 2, AUTHORITY: 2, ADDITIONAL: 3

;; ANSWER SECTION:
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
```

*Une seconde fois sans récursion*, il répond **depuis son cache** — la réponse est complète, sans qu'il ait eu à demander quoi que ce soit :

```
;; flags: qr ra; QUERY: 1, ANSWER: 2, AUTHORITY: 2, ADDITIONAL: 3

;; ANSWER SECTION:
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
```

TLD-NS, un serveur Windows **sans récursion**, ignore ta demande de récursion et le dit :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 80
;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 2, ADDITIONAL: 3
;; WARNING: recursion requested but not available
```

(suivi du même renvoi vers `ns1`/`ns2` qu'au TP 8.) Enfin NS1-BANK, qui ne fait pas autorité pour `google.com` et ne fait pas de récursion, **refuse** :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: REFUSED, id: 92
;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1
;; WARNING: recursion requested but not available
```

**🧠 Ce que tu viens d'apprendre.**

| Situation | Signe dans la réponse |
|---|---|
| Le serveur **offre** la récursion | `ra` dans les drapeaux |
| Le serveur **n'offre pas** la récursion et tu l'as demandée | `WARNING: recursion requested but not available` |
| Le serveur est **autorité** de la zone | `aa` |
| Le serveur **refuse** (politique, ou question hors de sa zone) | `status: REFUSED` |
| Le serveur ne sait pas mais te met sur la voie | `ANSWER: 0` + `NS` en `AUTHORITY` (un **renvoi**) |

> 🔍 **Point d'audit** — Ce `REFUSED` est un **bon** signe : NS1-BANK, le serveur faisant autorité de la banque, ne doit jamais faire la récursion pour le compte d'inconnus. Si ce serveur répondait `NOERROR` à `google.com`, ce serait un résolveur ouvert, exploitable pour des attaques par amplification. C'est le premier test du TP 35.

---

# Partie V — Les enregistrements

Chaque TP de cette partie pose la même question avec **les deux familles d'outils** (`dig` côté Linux, `Resolve-DnsName` côté Windows) : la réponse est la même, seule la présentation change.

---

## 18. 🧪 TP 10 — A, AAAA et CNAME

**🎯 Objectif.** Comprendre qu'**une adresse peut avoir plusieurs noms** et qu'un alias se **suit**.

**🔧 Manipulation.**

```
# sur PC-CONSEILLER
dig web.banquehorizon.com +short
dig ebanking.banquehorizon.com +short
dig www.banquehorizon.com CNAME +short
```

```powershell
# sur PC-GUICHET1
Resolve-DnsName agences.banquehorizon.com
Resolve-DnsName api.banquehorizon.com -Type CNAME
```

**✅ Résultat attendu.**

```
203.0.113.20
```
```
web.banquehorizon.com.
203.0.113.20
```
```
web.banquehorizon.com.
```

et côté Windows, la chaîne est complète : l'alias puis l'adresse.

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

**🧠 Ce que tu viens d'apprendre.**

- Les quatre noms `www`, `ebanking`, `agences` et `api` sont des **alias** (CNAME) de `web`, qui porte l'unique adresse `203.0.113.20`. Changer l'adresse du site = modifier **une seule ligne** (`web`).
- Quand tu demandes l'adresse d'un alias, le serveur renvoie **l'alias et la cible** dans la même réponse : tu n'as pas à refaire la question.
- `dig … CNAME +short` ne montre que l'alias lui-même, sans suivre.
- Un CNAME est un renvoi **de nom à nom** : il ne porte jamais d'adresse.

⚠️ **Attention** — Chaque alias coûte **une résolution de plus** au client. Une chaîne de CNAME de CNAME ralentit la page ; les résolveurs limitent d'ailleurs la longueur de la chaîne.

---

## 19. 🧪 TP 11 — MX, TXT (SPF, DMARC) et SRV

**🎯 Objectif.** Lire les enregistrements que **d'autres services** consultent à ta place : la messagerie, la lutte contre l'usurpation d'identité, la découverte de service.

**🔧 Manipulation.**

```
# sur PC-CONSEILLER
dig banquehorizon.com TXT +short
dig _dmarc.banquehorizon.com TXT +short
dig _imaps._tcp.banquehorizon.com SRV +short
dig banquehorizon.com NS +short
dig banquehorizon.com SOA +short
```

```powershell
# sur PC-GUICHET1
Resolve-DnsName banquehorizon.com -Type TXT
Resolve-DnsName _imaps._tcp.banquehorizon.com -Type SRV
Resolve-DnsName banquehorizon.com -Type SOA
```

**✅ Résultat attendu.**

```
"v=spf1 mx -all"
"v=DMARC1; p=reject; rua=mailto:dmarc@banquehorizon.com"
0 1 993 mail.banquehorizon.com.
ns1.banquehorizon.com.
ns2.banquehorizon.com.
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

(L'ordre des deux `NS` varie.) Côté Windows :

```
Name    : banquehorizon.com
Type    : TXT
TTL     : 3600
Section : Answer
Strings : {v=spf1 mx -all}
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

**🧠 Ce que tu viens d'apprendre.**

| Enregistrement | Qui le lit | Ce que dit celui du laboratoire |
|---|---|---|
| **MX** | Les serveurs de messagerie qui t'envoient un courrier | `10 mail`, `20 mail2` : essayer d'abord `mail`, et `mail2` s'il est injoignable |
| **TXT / SPF** | Le serveur qui **reçoit** un courrier « de » ton domaine | `v=spf1 mx -all` : « seuls mes MX ont le droit d'envoyer, **tout le reste est refusé** (`-all`) » |
| **TXT / DMARC**, au nom `_dmarc` | Idem | `p=reject` : « jette le courrier qui échoue aux contrôles » ; `rua=` : où m'envoyer les rapports |
| **SRV**, au nom `_service._protocole` | Un client qui cherche un *service* | `_imaps._tcp` : IMAP sur TLS = port **993** de `mail`, priorité 0, poids 1 |
| **SOA** | Les secondaires, les outils | Les **sept** champs : voir le tableau ci-dessous |

Les champs du **SOA**, que tu relèveras au TP 18 :

| Champ | Valeur | Rôle |
|---|---|---|
| serveur primaire / responsable | `ns1…`, `hostmaster…` (= `hostmaster@banquehorizon.com`) | Qui contacter |
| **serial** | `2026103101` | **Numéro de version de la zone** : les secondaires ne transfèrent que s'il a augmenté |
| refresh | 7200 s | Tous les combien le secondaire redemande le serial |
| retry | 900 s | Délai avant de réessayer si le primaire ne répond pas |
| expire | 1209600 s (14 jours) | Au-delà, le secondaire **cesse de répondre** s'il ne joint plus le primaire |
| minimum | 3600 s | Durée de conservation des réponses **négatives** (TP 22) |

> 🔍 **Point d'audit** — `p=reject` + `-all` est la configuration **stricte** : un contrôleur y voit une bonne hygiène anti-hameçonnage. Une zone sans SPF/DMARC laisse n'importe qui envoyer du courrier « de » ta banque.

---

## 20. 🧪 TP 12 — PTR : retrouver un nom depuis une adresse

**🎯 Objectif.** Faire une **résolution inverse** et comprendre pourquoi elle vit dans une zone à part.

**🔧 Manipulation.**

```
# sur PC-CONSEILLER
dig -x 203.0.113.20 +short
dig -x 203.0.113.20 +noall +comments +answer
host 203.0.113.20
ping -c 1 www.banquehorizon.com
```

```powershell
# sur PC-GUICHET1
Resolve-DnsName 203.0.113.20
```

**✅ Résultat attendu.**

```
web.banquehorizon.com.
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 46
;; flags: qr rd ra; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 65494
;; ANSWER SECTION:
20.113.0.203.in-addr.arpa. 3600	IN	PTR	web.banquehorizon.com.
```

`host` fait la même chose en une ligne, et construit lui-même le nom en `in-addr.arpa` :

```
20.113.0.203.in-addr.arpa domain name pointer web.banquehorizon.com.
```

```
PING www.banquehorizon.com (203.0.113.20) 56(84) bytes of data.
64 bytes from web.banquehorizon.com (203.0.113.20): icmp_seq=1 ttl=62 time=0.043 ms
```

```
Name     : 20.113.0.203.in-addr.arpa
Type     : PTR
TTL      : 3600
Section  : Answer
NameHost : web.banquehorizon.com
```

**🧠 Ce que tu viens d'apprendre.**

- `dig -x` écrit le nom `in-addr.arpa` à ta place : l'adresse est **lue à l'envers** (`20.113.0.203`) parce que, dans une adresse, la partie qui change le moins est à gauche, alors que dans un nom elle est à droite.
- La zone `113.0.203.in-addr.arpa` est une **zone à part**, déléguée par la racine du laboratoire à NS1-BANK : *celui qui possède l'adresse* possède sa résolution inverse (en vrai, c'est le fournisseur d'accès qui délègue).
- **`ping` utilise le PTR** : il écrit le nom de l'adresse qui répond (`web.banquehorizon.com`), **pas** le nom que tu as tapé (`www.banquehorizon.com`). Les journaux d'un serveur, `traceroute` et `netstat` en font autant. `ping -n` supprime cette seconde question.

> 🔍 **Point d'audit** — Un PTR absent ou incohérent avec le nom direct (la « résolution inverse confirmée ») est un motif de rejet pour certains serveurs de messagerie. Vérifie que chaque adresse publique porte un PTR cohérent avec son nom.

---

## 21. 🧪 TP 13 — NXDOMAIN ou NODATA ?

**🎯 Objectif.** Distinguer les **deux** façons de répondre « rien », et lire pourquoi elles n'ont pas le même sens.

**🔧 Manipulation.**

```
# sur PC-CONSEILLER
dig @10.20.20.53 nexiste.banquehorizon.com +noall +comments +authority
dig @10.20.20.53 web.banquehorizon.com AAAA +noall +comments +authority
```

```powershell
# sur PC-GUICHET1
Resolve-DnsName nexiste.banquehorizon.com
Resolve-DnsName web.banquehorizon.com -Type AAAA
```

**✅ Résultat attendu.**

*Le nom n'existe pas* :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 42
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	SOA	ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

*Le nom existe, mais pas dans cette famille* :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 43
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	SOA	ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

Et côté Windows, les deux messages ne sont pas les mêmes :

```
Resolve-DnsName : nexiste.banquehorizon.com : DNS name does not exist
    + CategoryInfo          : ResourceUnavailable: (nexiste.banquehorizon.com:String) [Resolve-DnsName], Win32Exception
    + FullyQualifiedErrorId : DNS_ERROR_RCODE_NAME_ERROR,Microsoft.DnsClient.Commands.ResolveDnsName
```
```
Resolve-DnsName : web.banquehorizon.com : DNS record does not exist
    + CategoryInfo          : ResourceUnavailable: (web.banquehorizon.com:String) [Resolve-DnsName], Win32Exception
    + FullyQualifiedErrorId : DNS_ERROR_RECORD_DOES_NOT_EXIST,Microsoft.DnsClient.Commands.ResolveDnsName
```

**🧠 Ce que tu viens d'apprendre.**

| | **NXDOMAIN** | **NODATA** |
|---|---|---|
| `status` | `NXDOMAIN` | `NOERROR` (**avec** `ANSWER: 0`) |
| Sens | Ce **nom** n'existe pour **aucun** type | Le nom existe, mais **pas ce type** |
| Exemple | `nexiste` | `web` a une adresse IPv4, pas d'IPv6 |
| Windows | `DNS name does not exist` (`DNS_ERROR_RCODE_NAME_ERROR`) | `DNS record does not exist` (`DNS_ERROR_RECORD_DOES_NOT_EXIST`) |

Dans les deux cas, la section `AUTHORITY` porte le **SOA** de la zone : ce n'est pas un hasard, c'est lui qui dit **pendant combien de temps** garder cette réponse négative en cache (le plus petit de son TTL et de son champ `minimum`, ici 3600 s). C'est le **cache négatif** du TP 22.

⚠️ **Attention** — Confondre les deux fait perdre des heures. « Pas d'IPv6 » n'est **pas** une erreur : c'est un `NOERROR` vide. Un programme qui traite le `NOERROR` vide comme un `NXDOMAIN` dira à tort que le site n'existe pas.

---

# Partie VI — Les serveurs

Jusqu'ici tu as *posé* des questions. Dans cette partie tu passes de l'autre côté : tu **lis, vérifies, modifies et casses** les serveurs qui répondent. Sept TP, sur les trois familles de serveurs du laboratoire : BIND faisant autorité (NS1-BANK, ROOT-NS), BIND résolveur (DNS-RES) et DNS Windows (TLD-NS, DC1, NS2-BANK).

---

## 22. 🧪 TP 14 — Lire la configuration et la zone de NS1-BANK

**🎯 Objectif.** Savoir lire, ligne à ligne, ce qui fait d'un serveur BIND un serveur *faisant autorité* pour `banquehorizon.com`.

**🔧 Manipulation.**

```
# sur NS1-BANK
ls /etc/bind
cat /etc/bind/named.conf
wc -c /etc/bind/named.conf.options /etc/bind/named.conf.local
cat /etc/bind/db.banquehorizon.com
cat /etc/bind/db.203.0.113
named-checkconf; echo rc=$?
named-checkzone banquehorizon.com /etc/bind/db.banquehorizon.com
sudo rndc status
ss -ulnp | grep named
```

**✅ Résultat attendu.**

Les fichiers du paquet `bind9` :

```
db.203.0.113	      named.conf	named.conf.options
db.banquehorizon.com  named.conf.local
```

Le fichier de configuration :

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

Les deux autres fichiers du paquet Debian (`named.conf.options`, `named.conf.local`) sont là, mais **`named.conf` ne les inclut pas** (aucune ligne `include`) : ils ne sont pas lus. Dans ce laboratoire tout tient dans `named.conf`.

```
94 /etc/bind/named.conf.options
 0 /etc/bind/named.conf.local
94 total
```

```
options {
	directory "/var/cache/bind";

	dnssec-validation auto;

	listen-on-v6 { any; };
};
```

La zone directe :

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

La zone inverse (celle du TP 12) :

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

Les deux vérificateurs, puis l'état du serveur et le port d'écoute :

```
rc=0
```

```
zone banquehorizon.com/IN: loaded serial 2026103101
OK
```

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

```
UNCONN 0      0            0.0.0.0:53         0.0.0.0:*    users:(("named",pid=43,fd=3))
```

**🧠 Ce que tu viens d'apprendre.**

*La configuration (`named.conf`)* est faite de blocs `mot { … };` — **le point-virgule final est obligatoire**, c'est l'erreur de frappe la plus fréquente.

| Ligne | Sens |
|---|---|
| `directory "/var/cache/bind";` | Le répertoire de travail de `named` (les fichiers de zone relatifs, le vidage du cache) |
| `recursion no;` | Ce serveur **ne résout pas pour les autres** : il répond sur ses zones, point (le `REFUSED` du TP 9) |
| `allow-query { any; };` | Tout le monde peut poser des questions sur ses zones — normal pour un serveur public |
| `type primary;` | Cette machine détient la **copie de référence** de la zone (anciennement `master`) |
| `file "…";` | Où est écrite la zone |
| `allow-transfer { 203.0.113.11; };` | **Seul NS2-BANK** peut copier la zone en entier (le TP 18 le prouve) |
| `notify yes;` | Quand la zone change, prévenir les serveurs secondaires pour qu'ils viennent la relire |

*Le fichier de zone* se lit de haut en bas :

- `$TTL 3600` : la durée de vie donnée aux enregistrements qui n'en précisent pas. `$ORIGIN banquehorizon.com.` : le suffixe **ajouté aux noms sans point final**. `@` désigne l'origine elle-même.
- L'enregistrement **SOA** (*Start Of Authority*) porte le numéro de série `2026103101` (convention `AAAAMMJJNN` : année, mois, jour, numéro de révision du jour) et quatre durées en secondes : `7200` = *refresh* (tous les combien de temps un secondaire demande si la zone a changé), `900` = *retry* (s'il n'a pas pu), `1209600` = *expire* (14 jours sans nouvelles : le secondaire arrête de répondre plutôt que de servir une zone périmée), `3600` = *minimum*, c'est-à-dire la durée de vie du **cache négatif** (le plafond du TTL des réponses `NXDOMAIN`, voir TP 13 et TP 22).
- **Un nom sans point final est relatif** : `www IN CNAME web` signifie `web.banquehorizon.com.`. Un nom avec le point final (`mail.banquehorizon.com.`) est absolu. Oublier le point final sur un nom complet est l'une des erreurs les plus classiques — le nom devient `mail.banquehorizon.com.banquehorizon.com.` (voir le TP 15).
- `_imaps._tcp IN SRV 0 1 993 mail` : priorité 0, poids 1, port 993, serveur `mail.banquehorizon.com.` (TP 11).

*Les deux vérificateurs* font ce que fait `named` à son démarrage, **sans rien démarrer** : `named-checkconf` lit la configuration (`rc=0` : rien à signaler), `named-checkzone` charge la zone et affiche son numéro de série suivi de `OK`. Ce sont les deux outils de ce chapitre qu'il ne faut jamais oublier de lancer.

*`rndc`* (*remote name daemon control*) est la télécommande de `named` : `status` affiche la version, le nombre de zones chargées (`2`, la directe et l'inverse) et les compteurs. *`ss`* montre que `named` écoute en UDP sur le port 53 de toutes les interfaces (`0.0.0.0:53`).

> 🔍 **Point d'audit** — Garde une copie datée de `named.conf` et des zones avec la somme `sha256sum` : c'est la « configuration de référence » à laquelle un auditeur comparera. `allow-transfer` doit nommer des adresses, jamais `any` (TP 35).

---

## 23. 🧪 TP 15 — Vérifier avant de recharger

**🎯 Objectif.** Faire à la main **sept** erreurs de zone classiques, lire ce que dit `named-checkzone`, puis constater ce qui arrive à un serveur en marche quand on recharge une zone cassée.

**🔧 Manipulation.** On ne touche pas encore à la vraie zone : chaque erreur est faite sur une **copie** dans `/tmp`.

```
# sur NS1-BANK
sed 's/^web IN A/web IN AA/' /etc/bind/db.banquehorizon.com | sudo tee /tmp/z1 > /dev/null; named-checkzone banquehorizon.com /tmp/z1
sed 's/^web IN A 203.0.113.20/web IN A 203.0.113.999/' /etc/bind/db.banquehorizon.com | sudo tee /tmp/z2 > /dev/null; named-checkzone banquehorizon.com /tmp/z2
sed 's/^mail IN A 203.0.113.25/mail IN A 203.0.113.25 oops/' /etc/bind/db.banquehorizon.com | sudo tee /tmp/z3 > /dev/null; named-checkzone banquehorizon.com /tmp/z3
(cat /etc/bind/db.banquehorizon.com; echo 'www IN A 203.0.113.21') | sudo tee /tmp/z4 > /dev/null; named-checkzone banquehorizon.com /tmp/z4
grep -v SOA /etc/bind/db.banquehorizon.com | sudo tee /tmp/z5 > /dev/null; named-checkzone banquehorizon.com /tmp/z5
grep -v ' NS ' /etc/bind/db.banquehorizon.com | sudo tee /tmp/z6 > /dev/null; named-checkzone banquehorizon.com /tmp/z6
sed 's/^@ IN MX 10 mail.banquehorizon.com./@ IN MX 10 203.0.113.25/' /etc/bind/db.banquehorizon.com | sudo tee /tmp/z8 > /dev/null; named-checkzone banquehorizon.com /tmp/z8
```

**✅ Résultat attendu.** Une erreur par zone, et un message qui donne le **fichier**, la **ligne** et le **mot** fautif.

*Un type d'enregistrement inventé (`AA` au lieu de `A`)* :

```
/tmp/z1:12: unknown RR type 'AA'
zone banquehorizon.com/IN: loading from master file /tmp/z1 failed: unknown class/type
zone banquehorizon.com/IN: not loaded due to errors.
```

*Une adresse IPv4 impossible (un octet à 999)* :

```
dns_rdata_fromtext: /tmp/z2:12: near '203.0.113.999': bad dotted quad
zone banquehorizon.com/IN: loading from master file /tmp/z2 failed: bad dotted quad
zone banquehorizon.com/IN: not loaded due to errors.
```

*Du texte en trop après l'adresse* :

```
dns_rdata_fromtext: /tmp/z3:17: near 'oops': extra input text
zone banquehorizon.com/IN: loading from master file /tmp/z3 failed: extra input text
zone banquehorizon.com/IN: not loaded due to errors.
```

*Un alias (`CNAME`) qui cohabite avec un autre type sur le même nom* — interdit par la RFC 1034 :

```
dns_master_load: /tmp/z4:21: www.banquehorizon.com: CNAME and other data
zone banquehorizon.com/IN: loading from master file /tmp/z4 failed: CNAME and other data
zone banquehorizon.com/IN: not loaded due to errors.
```

*Plus de SOA* — pas de zone sans SOA :

```
zone banquehorizon.com/IN: has 0 SOA records
zone banquehorizon.com/IN: not loaded due to errors.
```

*Plus de NS* — pas de zone sans serveur de noms :

```
zone banquehorizon.com/IN: has no NS records
zone banquehorizon.com/IN: not loaded due to errors.
```

*Un MX qui pointe sur une adresse* — pas une erreur mais un **avertissement**, la zone se charge quand même (et le MX est inutilisable) :

```
/tmp/z8:7: warning: '203.0.113.25': MX is an address
zone banquehorizon.com/IN: banquehorizon.com/MX '203.0.113.25.banquehorizon.com' has no address records (A or AAAA)
zone banquehorizon.com/IN: loaded serial 2026103101
OK
```

**🔧 Manipulation (suite).** Même chose pour la **configuration** (on se place dans `/tmp` pour que le message porte le nom court du fichier) :

```
# sur NS1-BANK
cd /tmp
sed 's/recursion no;/recursion nope;/' /etc/bind/named.conf | sudo tee /tmp/bad.conf > /dev/null; named-checkconf bad.conf; echo rc=$?
sed 's/recursion no;/recursion no/' /etc/bind/named.conf | sudo tee /tmp/bad2.conf > /dev/null; named-checkconf bad2.conf; echo rc=$?
named-checkconf -z; echo rc=$?
```

*Une valeur qui n'est pas un booléen* :

```
bad.conf:3: boolean expected near 'nope'
rc=1
```

*Un point-virgule oublié* — le message désigne le mot **suivant** (`allow-query`), à la ligne où le serveur s'est aperçu de l'oubli :

```
bad2.conf:4: missing ';' before 'allow-query'
rc=1
```

`-z` demande à `named-checkconf` de **charger aussi les zones primaires** — la vérification complète en une commande :

```
zone banquehorizon.com/IN: loaded serial 2026103101
zone 113.0.203.in-addr.arpa/IN: loaded serial 2026103101
rc=0
```

**🔧 Manipulation (la vraie zone).** Maintenant on casse volontairement la **vraie** zone — on change l'adresse de `mail` *et* on laisse du texte en trop — et on recharge, comme le ferait un administrateur pressé qui ne vérifie pas :

```
# sur NS1-BANK
sudo sed -i 's/^mail IN A 203.0.113.25/mail IN A 203.0.113.99 oops/' /etc/bind/db.banquehorizon.com
named-checkzone banquehorizon.com /etc/bind/db.banquehorizon.com
sudo rndc reload banquehorizon.com
sudo grep named /var/log/syslog | tail -4
sudo rndc reload banquehorizon.com
```

```
# sur PC-CONSEILLER
dig @203.0.113.10 mail.banquehorizon.com +short
```

```
dns_rdata_fromtext: /etc/bind/db.banquehorizon.com:17: near 'oops': extra input text
zone banquehorizon.com/IN: loading from master file /etc/bind/db.banquehorizon.com failed: extra input text
zone banquehorizon.com/IN: not loaded due to errors.
```

`rndc reload` répond **sans protester** — c'est le piège :

```
zone reload queued
```

La cause n'est pas dans la réponse de `rndc`, elle est dans le **journal** de `named` :

```
Nov  4 10:53:16 NS1-BANK systemd: Started named.service.
Nov  4 11:04:17 NS1-BANK named[43]: dns_rdata_fromtext: /etc/bind/db.banquehorizon.com:17: near 'oops': extra input text
Nov  4 11:04:17 NS1-BANK named[43]: zone banquehorizon.com/IN: loading from master file /etc/bind/db.banquehorizon.com failed: extra input text
Nov  4 11:04:17 NS1-BANK named[43]: zone banquehorizon.com/IN: not loaded due to errors.
```

Un deuxième rechargement du même fichier, toujours cassé, répond de la même façon :

```
zone reload queued
```

Et le serveur, lui, a **gardé l'ancienne zone** : l'adresse de `mail` est toujours celle d'avant.

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

On répare, on vérifie, on recharge :

```
# sur NS1-BANK
sudo sed -i 's/203.0.113.99 oops/203.0.113.25/' /etc/bind/db.banquehorizon.com
named-checkzone banquehorizon.com /etc/bind/db.banquehorizon.com
sudo rndc reload banquehorizon.com
sudo rndc reload banquehorizon.com
```

```
zone banquehorizon.com/IN: loaded serial 2026103101
OK
```

```
zone reload queued
```

```
zone reload up-to-date
```

**🧠 Ce que tu viens d'apprendre.**

- **Lis le message de gauche à droite** : `fichier:ligne: near 'mot'` (où) puis la raison (`unknown RR type`, `bad dotted quad`, `extra input text`, `CNAME and other data`). La ligne rapportée est celle du mot fautif ; quand un enregistrement s'étend sur plusieurs lignes entre parenthèses (le SOA), c'est la ligne du mot qui *précède* la faute.
- Les **vérifications logiques** sont faites après le chargement : `has 0 SOA records`, `has no NS records`, `CNAME and other data`. Les **avertissements** (`MX is an address`, nom hors zone ignoré) n'empêchent pas le chargement.
- **`rndc reload` ne dit pas si le chargement a réussi.** `zone reload queued` signifie seulement « la demande est enregistrée » ; l'échec est écrit dans le journal, et `named` continue de servir **l'ancienne** copie de la zone. Un serveur cassé qui continue de répondre avec des données anciennes est plus dangereux qu'un serveur en panne, parce que personne ne s'en aperçoit. D'où la règle : **`named-checkzone` d'abord, `rndc reload` ensuite, `dig` pour vérifier**.
- `zone reload up-to-date` veut dire « le fichier n'a pas changé depuis le dernier chargement réussi » : `named` compare le **fichier**, pas le numéro de série. Après un chargement raté, le fichier compte comme « à recharger » même si on l'a remis en l'état, d'où le `queued` avant le `up-to-date`.

⚠️ **Attention** — `named-checkzone` accepte `www IN CNAME web.banquehorizon.com` (sans point final) : ce n'est pas une erreur de syntaxe, c'est un **autre nom** (`web.banquehorizon.com.banquehorizon.com.`). Seul un `dig` sur le nom, après le rechargement, le révèle.

> 🔍 **Point d'audit** — Mets `named-checkconf -z` dans la procédure de changement et garde sa sortie (`rc=0` et les numéros de série chargés) dans le ticket : c'est la preuve que la configuration livrée est celle qui a été vérifiée.

---

## 24. 🧪 TP 16 — Le résolveur DNS-RES

**🎯 Objectif.** Lire la configuration d'un serveur **récursif**, comprendre en quoi elle diffère d'un serveur faisant autorité, et **prouver** que ses listes de contrôle d'accès décident bien.

**🔧 Manipulation.**

```
# sur DNS-RES
cat /etc/bind/named.conf
cat /etc/bind/db.root.hints
grep -nE 'recursion|allow-|forwarders|listen-on' /etc/bind/named.conf
```

```
# sur ROOT-NS
cat /etc/bind/db.root
```

**✅ Résultat attendu.**

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

Le fichier d'amorçage, `db.root.hints` (les « conseils racine ») : **une seule ligne utile**, l'adresse d'un serveur racine.

```
. 3600000 IN NS a.root-servers.net.
a.root-servers.net. 3600000 IN A 198.51.100.1
```

```
4:    recursion yes;
5:    allow-query { agence; };
6:    allow-recursion { agence; };
14:    forwarders { 10.20.20.10; };
```

La zone racine de ROOT-NS : elle ne délègue que deux choses, `com` et la zone inverse de la banque.

```
$TTL 86400
. IN SOA a.root-servers.net. hostmaster.root-servers.net. ( 2026103101 1800 900 604800 86400 )
. IN NS a.root-servers.net.
a.root-servers.net. IN A 198.51.100.1
com. IN NS a.nic.com.
a.nic.com. IN A 198.51.100.2
113.0.203.in-addr.arpa. IN NS ns1.banquehorizon.com.
```

**🔧 Manipulation (le contrôle d'accès).** On sort volontairement les postes de l'agence de l'ACL `agence` (on la fait porter sur `10.99.0.0/16` au lieu de `10.20.0.0/16`), on recharge la configuration, on interroge, puis on remet tout en état :

```
# sur DNS-RES
sudo sed -i 's#10.20.0.0/16;#10.99.0.0/16;#' /etc/bind/named.conf; sudo rndc reconfig; grep -n acl /etc/bind/named.conf
```

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.banquehorizon.com +noall +comments
```

```
# sur DNS-RES
dig @127.0.0.1 www.banquehorizon.com +short
sudo sed -i 's#10.99.0.0/16;#10.20.0.0/16;#' /etc/bind/named.conf; sudo rndc reconfig; grep -n acl /etc/bind/named.conf
```

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.banquehorizon.com +short
```

```
1:acl "agence" { 10.99.0.0/16; 127.0.0.0/8; };
```

Le poste de l'agence n'est plus dans l'ACL : le résolveur le **refuse** (et ne dit pas `ra` : il n'offre pas la récursion à *ce* client) :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: REFUSED, id: 44
;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
```

Lui-même, en revanche (`127.0.0.0/8` est resté dans l'ACL), continue d'être servi :

```
web.banquehorizon.com.
203.0.113.20
```

Remise en état :

```
1:acl "agence" { 10.20.0.0/16; 127.0.0.0/8; };
```

```
web.banquehorizon.com.
203.0.113.20
```

**🧠 Ce que tu viens d'apprendre.**

| Bloc | Rôle |
|---|---|
| `acl "agence" { 10.20.0.0/16; 127.0.0.0/8; };` | Une **liste d'adresses nommée**, réutilisable |
| `recursion yes;` | Ce serveur *fait le travail* de résolution |
| `allow-query { agence; };` + `allow-recursion { agence; };` | **Qui** peut lui poser des questions, et **pour qui** il fait le travail : seulement l'agence |
| `zone "." { type hint; … };` | Où commencer : les **conseils racine**. Sans ce bloc, le résolveur ne sait pas par où entrer dans l'arbre |
| `zone "horizon.local" { type forward; forward only; forwarders { 10.20.20.10; }; };` | Une **exception** : pour ce domaine, ne pas descendre l'arbre, **demander à DC1** (qui est le seul à connaître cette zone privée) |

- Le dernier bloc est la réponse à la question « comment un résolveur public peut-il résoudre un nom interne ? » : il ne le fait pas lui-même, il **transfère** (TP 28).
- Un client que l'ACL exclut reçoit `REFUSED` : une réponse **explicite**, que `dig` affiche (`status: REFUSED`) et que le client peut journaliser — pas un silence. Un silence (`timed out`) a une autre cause : un routage ou un pare-feu en amont. Les deux se distinguent d'un coup d'œil, et ne se corrigent pas au même endroit.
- `rndc reconfig` a suffi à appliquer le nouveau `named.conf` sans redémarrer le service et sans vider le cache.
- Depuis un poste *hors* du réseau privé, le résolveur n'est même pas joignable : ROOT-NS, qui est « sur Internet » dans ce laboratoire, reçoit `Destination Net Unreachable` (les adresses `10.20.0.0/16` ne sont pas routables). L'ACL est donc une **seconde** barrière, pas la première.

> 🔍 **Point d'audit** — `allow-recursion` est **le** contrôle qui empêche un résolveur d'être « ouvert » (utilisable par n'importe qui sur Internet pour des attaques par amplification). Teste-le comme ci-dessus — sortir ton propre poste de l'ACL et constater le `REFUSED` — et garde la trace du résultat.

---

## 25. 🧪 TP 17 — Les serveurs Windows

**🎯 Objectif.** Retrouver, avec les cmdlets du module `DnsServer`, ce que tu viens de lire dans les fichiers BIND.

**🔧 Manipulation.**

```powershell
# sur TLD-NS
Get-DnsServerZone
Get-DnsServerResourceRecord -ZoneName com
```

```powershell
# sur DC1
Get-DnsServerZone
Get-DnsServerResourceRecord -ZoneName horizon.local
```

```powershell
# sur NS2-BANK
Get-DnsServerZone
(Get-DnsServerZone -Name banquehorizon.com).RecordCount
```

**✅ Résultat attendu.** TLD-NS fait autorité pour `com` :

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
```

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

DC1 : sa zone, ses enregistrements — et ceux que **le serveur DHCP y a inscrits tout seul** (la colonne `Timestamp` n'est remplie que pour eux) :

```

ZoneName            : horizon.local
ZoneType            : Primary
DynamicUpdate       : NonsecureAndSecure
ReplicationScope    : None
IsDsIntegrated      : False
IsReverseLookupZone : False
IsAutoCreated       : False
IsPaused            : False
IsReadOnly          : False
IsSigned            : False
ZoneFile            : horizon.local.dns
MasterServers       : {}
SecureSecondaries   : TransferToZoneNameServer
SecondaryServers    : {}
Notify              : Notify
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

NS2-BANK ne détient pas la zone : il en a une **copie** (`ZoneType : Secondary`, `MasterServers : {203.0.113.10}`, `IsReadOnly : True`) :

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
```

```
18
```

**🧠 Ce que tu viens d'apprendre.**

- Le vocabulaire change, pas le modèle : `Primary` / `Secondary` / `MasterServers`, un SOA, des NS, des A. `Get-DnsServerResourceRecord` affiche le SOA sous la forme `[numéro de série][refresh][retry][expire][minimum] serveur responsable`.
- `RecordCount` de NS2-BANK (`18`) est le nombre d'enregistrements **après le transfert de zone** : c'est la copie qu'a reçue le secondaire. Le TP 18 le fait bouger.
- Dans une zone Windows « normale », les clients DHCP s'enregistrent eux-mêmes (`DynamicUpdate : NonsecureAndSecure`) ; dans une zone BIND de type `primary` sans `allow-update`, ce n'est pas le cas. C'est un point de différence à connaître avant de mélanger les deux familles (TP 29).
- Les serveurs Windows de ce laboratoire annoncent `udp: 4096` dans leur `OPT`, BIND `1232` : même protocole, valeurs par défaut différentes.

---

## 26. 🧪 TP 18 — Modifier une zone et la voir arriver chez le secondaire

**🎯 Objectif.** Faire un changement **complet** : modifier la zone sur le primaire, la recharger, et **prouver** qu'elle est arrivée sur le secondaire (qui est, ici, un serveur *Windows*).

**🔧 Manipulation.**

```
# sur NS1-BANK
sudo sed -i 's/2026103101/2026103102/' /etc/bind/db.banquehorizon.com
echo 'api2 IN A 203.0.113.30' | sudo tee -a /etc/bind/db.banquehorizon.com
sudo rndc reload banquehorizon.com
dig @127.0.0.1 banquehorizon.com AXFR
```

```
# sur PC-CONSEILLER
dig @203.0.113.10 banquehorizon.com SOA +short
dig @203.0.113.11 banquehorizon.com SOA +short
```

```powershell
# sur PC-GUICHET1
Resolve-DnsName api2.banquehorizon.com -Server 203.0.113.11
```

```powershell
# sur NS2-BANK
(Get-DnsServerZone -Name banquehorizon.com).RecordCount
```

**✅ Résultat attendu.** On a monté le numéro de série (`…01` → `…02`) **et** ajouté `api2`. Le rechargement :

```
zone reload queued
```

Les deux serveurs annoncent le **même** numéro de série :

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103102 7200 900 1209600 3600
```

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103102 7200 900 1209600 3600
```

NS2-BANK — un serveur **Windows** — répond pour le nouveau nom, et sa zone compte un enregistrement de plus (`18` → `19`) :

```

Name      : api2.banquehorizon.com
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 203.0.113.30
```

```
19
```

Enfin, le test de sécurité : la copie de la zone n'est accordée **qu'à NS2-BANK** (`allow-transfer`), pas à la machine locale :

```

; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> @127.0.0.1 banquehorizon.com AXFR
; (1 server found)
;; global options: +cmd
; Transfer failed.
```

On remet les choses en état (suppression de `api2`, et un numéro de série plus grand pour que le secondaire se remette à jour) :

```
# sur NS1-BANK
sudo sed -i '/^api2 /d; s/2026103102/2026103103/' /etc/bind/db.banquehorizon.com
sudo rndc reload banquehorizon.com
```

```
zone reload queued
```

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103103 7200 900 1209600 3600
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 53
;; flags: qr aa rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 4096
```

**🧠 Ce que tu viens d'apprendre.**

- Le circuit complet d'un changement : **modifier → monter le numéro de série → recharger → `NOTIFY` au secondaire → le secondaire compare les séries → transfert (`AXFR`) → il répond**. Le `NOTIFY` est ce qui évite d'attendre le `refresh` (7200 s) du SOA.
- Preuve en une commande : **comparer les SOA des deux serveurs**. Deux numéros de série différents = un secondaire en retard.
- `Transfer failed.` du `AXFR` local est la **bonne** réponse : `allow-transfer { 203.0.113.11; }` refuse toute autre source. Un transfert de zone ouvert à tous livre à un attaquant la liste complète de vos machines.

> 🔍 **Point d'audit** — Collecte, à chaque changement, les SOA des deux serveurs (la commande du TP) : c'est la preuve de la cohérence primaire/secondaire à la date du changement.

---

## 27. 🧪 TP 19 — Le piège du numéro de série oublié

**🎯 Objectif.** Vivre l'incident le plus fréquent des zones à plusieurs serveurs : *modifier la zone, recharger, et oublier de monter le numéro de série*.

**🔧 Manipulation.**

```
# sur NS1-BANK
echo 'novelty IN A 203.0.113.77' | sudo tee -a /etc/bind/db.banquehorizon.com
sudo rndc reload banquehorizon.com
```

```
# sur PC-CONSEILLER
dig @203.0.113.10 novelty.banquehorizon.com +short
dig @203.0.113.11 novelty.banquehorizon.com +noall +comments
dig @203.0.113.10 banquehorizon.com SOA +short; dig @203.0.113.11 banquehorizon.com SOA +short
```

**✅ Résultat attendu.** Le primaire charge le fichier modifié :

```
novelty IN A 203.0.113.77
zone reload queued
```

Il répond pour le nouveau nom — mais **le secondaire, non** :

```
203.0.113.77
```

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 57
;; flags: qr aa rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 4096
```

Les deux numéros de série sont **identiques**, donc le secondaire n'a aucune raison de se mettre à jour :

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103103 7200 900 1209600 3600
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103103 7200 900 1209600 3600
```

Recharger encore ne change rien (le fichier est déjà chargé) :

```
zone reload up-to-date
```

On monte le numéro de série (`…03` → `…04`) et on recharge :

```
# sur NS1-BANK
sudo sed -i 's/2026103103/2026103104/' /etc/bind/db.banquehorizon.com
sudo rndc reload banquehorizon.com
```

```
zone reload queued
```

```
203.0.113.77
```

Remise en état :

```
# sur NS1-BANK
sudo sed -i '/^novelty /d; s/2026103104/2026103105/' /etc/bind/db.banquehorizon.com
sudo rndc reload banquehorizon.com
```

**🧠 Ce que tu viens d'apprendre.**

- **Le primaire se recharge à partir du fichier ; le secondaire ne compare que le numéro de série.** Sans série plus grand, aucun transfert : pendant des heures, des jours même, les deux serveurs répondent **différemment** à la même question, et c'est l'ordre d'interrogation du résolveur qui décide de ce que voit l'utilisateur.
- C'est le symptôme le plus déroutant du DNS : « ça marche pour moi, pas pour lui ». La première question devant un tel symptôme est toujours : **les SOA sont-ils identiques ?**
- Une automatisation sûre (script ou outil de gestion) monte la série **dans la même opération** que la modification. Le format `AAAAMMJJNN` aide : on lit la date du dernier changement dans le numéro.

⚠️ **Attention** — Monter le numéro de série *trop haut* (au-delà de 2³² − 1) ou le **faire redescendre** est pire que l'oublier : un secondaire ignore les séries plus petites que les siennes (RFC 1982, arithmétique de série). Ne revenez jamais en arrière sans une procédure explicite.

---

## 28. ⭐ 🧪 TP 20 — Créer sa propre zone et la brancher dans l'arbre

**🎯 Objectif.** Publier une **nouvelle zone** (`exemple.test`) sur NS1-BANK, constater qu'elle répond *chez elle* mais reste **invisible** du reste du monde, puis la rattacher à l'arbre par une **délégation**.

**🔧 Manipulation.**

```
# sur NS1-BANK
sudo tee /etc/bind/db.exemple.test <<'EOF'
$TTL 3600
@ IN SOA ns1.banquehorizon.com. hostmaster.banquehorizon.com. ( 1 7200 900 1209600 3600 )
@ IN NS ns1.banquehorizon.com.
www IN A 203.0.113.40
EOF
sudo tee -a /etc/bind/named.conf <<'EOF'
zone "exemple.test" { type primary; file "/etc/bind/db.exemple.test"; };
EOF
named-checkzone exemple.test /etc/bind/db.exemple.test
named-checkconf; echo rc=$?
sudo rndc reconfig
```

```
# sur PC-CONSEILLER
dig @203.0.113.10 www.exemple.test +norecurse +noall +comments +answer
dig @10.20.20.53 www.exemple.test +noall +comments +answer +authority
```

**✅ Résultat attendu.** La zone passe les deux vérifications :

```
zone exemple.test/IN: loaded serial 1
OK
```

```
rc=0
```

Interrogé **directement**, NS1-BANK répond (`aa` : il fait autorité) :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 62
;; flags: qr aa; QUERY: 1, ANSWER: 1, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; ANSWER SECTION:
www.exemple.test.	3600	IN	A	203.0.113.40
```

Mais à travers le résolveur de l'agence, **personne ne la connaît** — la racine ne sait pas que `test.` existe :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 63
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; AUTHORITY SECTION:
.			10800	IN	SOA	a.root-servers.net. hostmaster.root-servers.net. 2026103101 1800 900 604800 86400
```

**🔧 Manipulation (la délégation).** On déclare, dans la zone racine, que `test.` est délégué à NS1-BANK :

```
# sur ROOT-NS
echo 'test. IN NS ns1.banquehorizon.com.' | sudo tee -a /etc/bind/db.root
sudo rndc reload
```

```
# sur DNS-RES
sudo rndc flush
```

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.exemple.test +noall +comments +answer +authority
dig +trace @10.20.20.53 www.exemple.test
```

```
server reload successful
```

Le résolveur trouve maintenant l'adresse :

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

Et `+trace` montre la chaîne : racine → délégation de `test.` → NS1-BANK :

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

On remet le laboratoire en état :

```
# sur ROOT-NS
sudo sed -i '/^test\. IN NS/d' /etc/bind/db.root; sudo rndc reload
# sur NS1-BANK
sudo sed -i '/exemple.test/d' /etc/bind/named.conf; sudo rm /etc/bind/db.exemple.test; sudo rndc reconfig
# sur DNS-RES
sudo rndc flush
```

**🧠 Ce que tu viens d'apprendre.**

- Créer une zone, c'est **deux** choses indépendantes : (1) *héberger* les données (`zone … { type primary; file … };` + le fichier) ; (2) *publier* la zone, c'est-à-dire la faire connaître au **parent** par une délégation (`NS` dans la zone parente, ici la racine). Sans la deuxième, la zone existe mais personne ne sait l'atteindre : c'est exactement le cas d'un domaine qu'on a acheté mais dont le registre n'a pas encore les serveurs de noms.
- `rndc reconfig` relit `named.conf` et charge les zones **nouvelles** sans toucher aux autres ni vider les caches ; `rndc reload` relit les zones. Pour une zone *ajoutée*, c'est `reconfig`.
- Ici le serveur de la nouvelle zone se trouve dans une autre zone (`ns1.banquehorizon.com`) : pas besoin de glue, le résolveur trouvera l'adresse par une question à part. Si le serveur avait été **dans** la zone déléguée (`ns1.exemple.test`), la glue aurait été obligatoire, sinon on tourne en rond (TP 8).

> 🔍 **Point d'audit** — Une zone qui répond « chez elle » mais n'est pas déléguée est une **zone fantôme** : elle passe tous les tests locaux et échoue pour les utilisateurs. Contrôle toujours avec un `dig +trace` depuis un poste qui n'a pas accès au serveur autoritaire.

---

# Partie VII — Le cache

Le cache est ce qui rend le DNS rapide, et ce qui rend ses pannes **lentes à disparaître** : un enregistrement corrigé sur le serveur peut rester faux, chez les clients, pendant toute sa durée de vie. Six TP pour voir, lire et vider chaque cache du laboratoire : celui du résolveur BIND, celui du poste Windows, celui du serveur Windows DC1.

---

## 29. 🧪 TP 21 — Le TTL qui décroît

**🎯 Objectif.** *Voir* le temps passer dans un cache : la même réponse, posée deux fois à cinq secondes d'intervalle, ne porte pas le même TTL.

**🔧 Manipulation.**

```
# sur DNS-RES
sudo rndc flush
```

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.banquehorizon.com +noall +answer +stats
sleep 5
dig @10.20.20.53 www.banquehorizon.com +noall +answer
```

**✅ Résultat attendu.** Résolveur vide : il doit **descendre l'arbre** pour répondre. La réponse porte le TTL d'origine, celui de la zone (`3600`) :

```
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
;; Query time: 0 msec
;; SERVER: 10.20.20.53#53(10.20.20.53) (UDP)
;; WHEN: Wed Nov 04 10:28:50 UTC 2026
;; MSG SIZE  rcvd: 152
```

Cinq secondes plus tard, la réponse vient **du cache**. Le TTL a diminué de cinq :

```
www.banquehorizon.com.	3595	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3595	IN	A	203.0.113.20
```

**🧠 Ce que tu viens d'apprendre.**

- Le TTL d'une réponse de cache n'est **pas** le TTL de la zone : c'est ce qu'il **reste** à vivre à l'enregistrement dans la mémoire du résolveur. Il part de la valeur de la zone, descend d'une seconde par seconde, et à zéro l'entrée disparaît : la prochaine question redescend l'arbre.
- Cela explique deux phrases que tu entendras souvent : « le changement est fait mais certains voient encore l'ancienne adresse » (leur résolveur n'a pas encore atteint zéro) et « on a baissé le TTL **avant** le changement » (pour que le délai d'attente soit court le jour J).
- Le `Query time` est le même (`0 msec`) dans les deux cas : le laboratoire est un réseau sans latence mesurable. Sur un vrai réseau, la première question serait plus lente que la seconde — c'est la mesure la plus simple de l'efficacité d'un cache.

> 🔍 **Point d'audit** — Le TTL est un compromis à **documenter** : un TTL long (24 h) soulage le serveur et masque une panne de ses serveurs, un TTL court (60 s) accélère les changements et multiplie les requêtes. Note, pour chaque enregistrement critique, le TTL choisi et pourquoi.

---

## 30. 🧪 TP 22 — Le cache négatif

**🎯 Objectif.** Constater qu'un résolveur retient aussi les **réponses négatives** — « ce nom n'existe pas », « ce type n'existe pas » — et pour combien de temps.

**🔧 Manipulation.**

```
# sur PC-CONSEILLER
dig @10.20.20.53 nexiste.banquehorizon.com +noall +comments +authority
dig @10.20.20.53 web.banquehorizon.com AAAA +noall +comments +authority
sleep 5
dig @10.20.20.53 nexiste.banquehorizon.com +noall +comments +authority
```

**✅ Résultat attendu.** La première question (cache vide pour ce nom) :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 42
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; AUTHORITY SECTION:
banquehorizon.com.	3600	IN	SOA	ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

La section `AUTHORITY` porte le SOA de la zone, avec le TTL `3600`. Cinq secondes plus tard, **le même SOA, avec un TTL de 3595** : l'absence est en cache, et elle vieillit comme une présence.

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 44
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; AUTHORITY SECTION:
banquehorizon.com.	3595	IN	SOA	ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

**🧠 Ce que tu viens d'apprendre.**

- C'est le **cache négatif** (RFC 2308) : pour ne pas redemander cent fois un nom qui n'existe pas (une faute de frappe répétée, un logiciel mal configuré), le résolveur retient l'*absence*.
- Sa durée est **le plus petit** du TTL du SOA et du champ `minimum` du SOA. C'est le dernier nombre du SOA (`3600`) qu'on règle pour cela : trop long, et un nom **créé** après une erreur reste « inexistant » chez les clients pendant des heures.
- `NXDOMAIN` et `NODATA` (TP 13) sont tous deux retenus. Le TP 24 les montre dans le cache de BIND (`\-ANY ;-$NXDOMAIN`, `\-AAAA ;-$NXRRSET`).

⚠️ **Attention** — Scénario classique : un administrateur crée l'enregistrement `nouveau.banquehorizon.com`, le teste *avant* de l'avoir publié (« ça ne marche pas »), le publie, et le teste de nouveau : toujours `NXDOMAIN`, pendant toute la durée du cache négatif. La solution n'est pas de modifier la zone mais de **vider le cache** (TP 25) ou d'attendre.

---

## 31. 🧪 TP 23 — Le cache du poste Windows

**🎯 Objectif.** Lire le cache du *client* Windows avec les deux interfaces (PowerShell et `ipconfig`), voir qu'il retient aussi les réponses négatives, et le vider.

**🔧 Manipulation.**

```powershell
# sur PC-GUICHET1
Clear-DnsClientCache
Resolve-DnsName www.banquehorizon.com | Out-Null
Get-DnsClientCache | Where-Object Name -like "*banquehorizon*"
ipconfig /displaydns
Resolve-DnsName nexiste.banquehorizon.com
Get-DnsClientCache | Where-Object Name -like "nexiste*"
ipconfig /flushdns
Get-DnsClientCache | Where-Object Name -like "*banquehorizon*"
```

**✅ Résultat attendu.** Le cache contient **les deux** enregistrements de la chaîne (le CNAME et l'adresse). Le TTL, déjà un peu entamé, vient du résolveur (`3600` moins le temps passé dans son cache) :

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

La même chose vue par `ipconfig /displaydns` (le numéro de type est celui de l'IANA : 5 = CNAME, 1 = A) :

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

Une réponse négative est retenue **aussi** :

```
Resolve-DnsName : nexiste.banquehorizon.com : DNS name does not exist
    + CategoryInfo          : ResourceUnavailable: (nexiste.banquehorizon.com:String) [Resolve-DnsName], Win32Exception
    + FullyQualifiedErrorId : DNS_ERROR_RCODE_NAME_ERROR,Microsoft.DnsClient.Commands.ResolveDnsName
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

Puis on vide le cache :

```
Windows IP Configuration

Successfully flushed the DNS Resolver Cache.
```

```

```

(Aucune ligne : le cache est vide.)

Enfin, DC1 est lui aussi un serveur DNS **avec cache** — c'est lui qui transfère les questions publiques au résolveur (TP 28). Son cache se lit avec `Show-DnsServerCache` :

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

**🧠 Ce que tu viens d'apprendre.**

- Le poste Windows a **son propre cache** (service *Client DNS*), en plus de celui du résolveur : il y a au moins **deux** caches entre un utilisateur et la zone d'autorité. `Get-DnsClientCache` et `ipconfig /displaydns` sont deux interfaces sur le **même** cache.
- Le cache négatif Windows dure **900 s** (`TimeToLive : 900`, `Status : NotExist`) quel que soit le SOA : c'est la valeur par défaut de la clé de registre `MaxNegativeCacheTtl`, et elle ne suit pas le champ `minimum` du SOA comme le fait BIND.
- Le vidage est local : `Clear-DnsClientCache` et `ipconfig /flushdns` ne touchent ni le résolveur ni DC1. Si la réponse est toujours fausse après un vidage du poste, le problème est **plus haut** (TP 25).

---

## 32. 🧪 TP 24 — Lire le cache de BIND

**🎯 Objectif.** Ouvrir le cache du résolveur et reconnaître ce qu'il y a dedans : les réponses, les délégations apprises, les absences.

**🔧 Manipulation.**

```
# sur DNS-RES
sudo rndc dumpdb -cache
sudo cat /var/cache/bind/named_dump.db
```

**✅ Résultat attendu.** (Le fichier se termine par la liste des vues et des bases d'adresses ; seule la première partie nous intéresse.)

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

**🧠 Ce que tu viens d'apprendre.** Chaque ensemble est précédé d'un **niveau de confiance** :

| Étiquette | Sens |
|---|---|
| `; authanswer` | Réponse **faisant autorité**, reçue d'un serveur qui détient la zone (`www`, `web`, la racine) |
| `; authauthority` | NS d'une zone, appris d'un serveur qui détient cette zone (`banquehorizon.com NS`) |
| `; glue` | Adresses/NS venus d'un **renvoi** (ceux de `com`, `ns1`, `ns2`) : crédibles, mais jamais préférés à une réponse d'autorité |
| `; answer` | Réponse non autoritaire — ici, des **absences** |

- `nexiste.banquehorizon.com. 3595 \-ANY ;-$NXDOMAIN` : le nom n'existe pas (`\-` introduit une entrée **négative**, `ANY` : pour tous les types). La ligne suivante, en commentaire, donne le SOA qui justifie la durée.
- `web.banquehorizon.com. 3595 \-AAAA ;-$NXRRSET` : le nom existe, mais pas ce type (le NODATA du TP 13).
- Les TTL sont ceux **restants** : `3590`, `86390`... (5 à 10 secondes de moins que ceux de la zone).
- Rien ne dit « le cache contient tout ce qui est vrai » : c'est ce qui a été **demandé et retenu**. Le cache d'un résolveur est une preuve de ce que ses clients ont demandé.

> 🔍 **Point d'audit** — Le vidage du cache d'un résolveur (`rndc dumpdb`) est l'une des meilleures sources pour reconstituer, après un incident, **ce que ses clients ont résolu** (noms de domaines de commande et contrôle d'un logiciel malveillant, par exemple). Pense à le conserver avant de vider.

---

## 33. 🧪 TP 25 — Vider le cache, en entier ou en partie

**🎯 Objectif.** Choisir le bon outil pour oublier : un nom, un domaine entier, tout.

**🔧 Manipulation.**

```
# sur DNS-RES
sudo rndc flushname nexiste.banquehorizon.com
sudo rndc dumpdb -cache; sudo grep -c nexiste /var/cache/bind/named_dump.db
sudo rndc flushtree banquehorizon.com
sudo rndc dumpdb -cache; sudo grep -c banquehorizon /var/cache/bind/named_dump.db
sudo rndc flush
```

**✅ Résultat attendu.** `flushname` ne retire que **l'entrée** du nom demandé (la ligne `nexiste` disparaît du fichier) :

```
0
```

`flushtree` retire le nom **et tout ce qui est en dessous** — ici toute la zone `banquehorizon.com`, y compris les NS et leur glue :

```
0
```

`rndc flush` vide tout (aucun message : le silence est un succès).

**🧠 Ce que tu viens d'apprendre.**

| Commande | Effet | Quand l'utiliser |
|---|---|---|
| `rndc flushname NOM` | Oublie ce nom (tous types) | Un seul nom est faux ou « inexistant » à tort |
| `rndc flushtree DOMAINE` | Oublie le domaine et ses sous-domaines | Après un changement de serveurs de noms, ou un incident sur une zone |
| `rndc flush` | Oublie tout | En dernier recours : le résolveur redescend tout l'arbre pour chaque question, et sa charge monte |

- **Vider le cache d'un résolveur ne vide pas celui des clients.** Si le poste Windows a gardé la mauvaise réponse, il faut aussi `Clear-DnsClientCache` (TP 23), et pour un poste Linux avec `systemd-resolved`, `sudo resolvectl flush-caches`.
- L'ordre de remontée d'un problème de cache est toujours : **client → résolveur local → éventuel transmetteur → serveur d'autorité**.

---

## 34. 🧪 TP 26 — Le cache des échecs (SERVFAIL)

**🎯 Objectif.** Provoquer un `SERVFAIL`, voir que BIND le retient (brièvement) pour ne pas retomber dans le même trou, et le lire dans le cache.

**🔧 Manipulation.** On crée un domaine `broken.com` dont le serveur de noms ne répond pas, en ajoutant une **délégation** dans la zone `com` (sur le serveur Windows qui la détient), puis on règle `servfail-ttl` à 30 secondes pour avoir le temps de l'observer :

```powershell
# sur TLD-NS
Add-DnsServerZoneDelegation -Name com -ChildZoneName broken -NameServer ns.broken.com -IPAddress 203.0.113.99
```

```
# sur DNS-RES
sudo sed -i 's/empty-zones-enable no;/empty-zones-enable no; servfail-ttl 30;/' /etc/bind/named.conf
sudo systemctl restart named
```

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.broken.com +noall +comments
```

```
# sur DNS-RES
sudo rndc dumpdb -cache; sudo grep -A4 'SERVFAIL cache' /var/cache/bind/named_dump.db | head -5
```

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.broken.com +noall +comments +stats
```

**✅ Résultat attendu.** Le résolveur suit la délégation, interroge `203.0.113.99` (qui n'existe pas), n'obtient rien, et répond `SERVFAIL` :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 50
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
```

L'échec est dans une section **à part** du cache : la durée est celle de `servfail-ttl` (**exprimée en millisecondes** dans cette version de BIND : `29995` ≈ 30 s, qui diminuent) :

```
; SERVFAIL cache
;
; www.broken.com/A [ttl 29995]
;
; Start view _bind
```

Une deuxième question, tout de suite après, est **servie par le cache** (aucun nouveau délai d'attente) :

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

On remet en état — configuration, délégation :

```
# sur DNS-RES
sudo sed -i 's/ servfail-ttl 30;//' /etc/bind/named.conf; sudo systemctl restart named
```

```powershell
# sur TLD-NS
Remove-DnsServerZoneDelegation -Name com -ChildZoneName broken -Force
```

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.broken.com +noall +comments
```

Le domaine n'existe plus : `NXDOMAIN` (et non plus `SERVFAIL`), puisque `named` a redémarré avec un cache vide et que `com` ne délègue plus rien.

```
;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 60
```

**🧠 Ce que tu viens d'apprendre.**

- `SERVFAIL` veut dire « **j'ai essayé et je n'ai pas pu** » : un serveur d'autorité injoignable, une signature DNSSEC invalide, une zone cassée. Ce n'est pas `NXDOMAIN` (« j'ai pu, et ça n'existe pas »). La première chose à vérifier devant un `SERVFAIL` est donc la **chaîne de délégation** (`dig +trace`) et la **joignabilité** des serveurs faisant autorité.
- BIND retient l'échec pendant `servfail-ttl` secondes (30 au plus) : sans cela, un client insistant ferait relancer une résolution vouée à l'échec à chaque tentative, avec un délai d'attente à chaque fois.
- **Un redémarrage de `named` repart d'un cache vide** : c'est une raison de plus de préférer `rndc flush` à un redémarrage (qui interrompt aussi le service) — mais c'est aussi pourquoi un redémarrage « répare » parfois des symptômes de cache.

> 🔍 **Point d'audit** — Un `SERVFAIL` durable sur un domaine que vous gérez est un signal à superviser. Une sonde qui interroge périodiquement vos noms critiques **à travers un résolveur** (pas directement vos serveurs d'autorité) est la seule à voir ce que voient les utilisateurs.

---

# Partie VIII — Redondance, DNS privé et DHCP

Un service de noms qui s'arrête arrête **tout** : les sites, la messagerie, l'authentification. Cette partie montre comment le laboratoire reste debout quand un serveur tombe, comment il garde ses noms *internes* hors de la vue publique, et comment les postes obtiennent leur configuration DNS.

---

## 35. 🧪 TP 27 — NS1-BANK tombe

**🎯 Objectif.** Arrêter un des deux serveurs d'autorité de la banque et constater que les utilisateurs **ne s'en aperçoivent pas** ; puis lire ce que voit un administrateur qui interroge, lui, le serveur arrêté.

**🔧 Manipulation.**

```
# sur DNS-RES
sudo rndc flush
```

```
# sur NS1-BANK
sudo systemctl stop named
```

```powershell
# sur PC-GUICHET1
Resolve-DnsName mail.banquehorizon.com
```

```
# sur PC-CONSEILLER
dig @203.0.113.10 mail.banquehorizon.com +time=1 +tries=1
dig @203.0.113.11 mail.banquehorizon.com +noall +comments +answer
```

```
# sur NS1-BANK
sudo systemctl start named
```

**✅ Résultat attendu.** Le résolveur (vidé exprès : il doit tout redemander) trouve `mail` **malgré** l'arrêt de NS1-BANK :

```

Name      : mail.banquehorizon.com
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 203.0.113.25
```

Interrogé directement, le serveur arrêté **refuse** la connexion (rien n'écoute sur le port 53) :

```
;; communications error to 203.0.113.10#53: connection refused

; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> @203.0.113.10 mail.banquehorizon.com +time=1 +tries=1
; (1 server found)
;; global options: +cmd
;; no servers could be reached
```

Alors que le deuxième serveur répond normalement :

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

**🧠 Ce que tu viens d'apprendre.**

- La redondance du DNS est **dans la zone**, pas dans le serveur : la délégation donne **deux** `NS` (`ns1`, `ns2`) ; un résolveur qui n'obtient pas de réponse de l'un **essaie l'autre**, de façon transparente. C'est pour cela qu'un domaine doit avoir **au moins deux** serveurs, idéalement sur des **réseaux et des sites différents** (ici, deux adresses du même `/24` : acceptable pour un laboratoire, pas pour une banque).
- `connection refused` (le paquet arrive, rien n'écoute — le service est arrêté, ou un pare-feu *rejette*) ne se lit pas comme `timed out` (le paquet n'arrive pas, ou la réponse ne revient pas — panne réseau, pare-feu qui *ignore*). La première cause est locale à la machine, la deuxième ailleurs.
- NS2-BANK a pu répondre parce qu'il avait **sa copie de la zone** (TP 18). Un secondaire dont la zone a *expiré* (14 jours sans nouvelles du primaire, le champ `expire` du SOA) cesse de répondre plutôt que de servir une donnée trop vieille.

> 🔍 **Point d'audit** — Teste la bascule **régulièrement** : arrête un serveur d'autorité, vérifie qu'une résolution à travers le résolveur aboutit, remets-le. Un secondaire silencieusement en retard (TP 19) ne se découvre qu'ainsi.

---

## 36. 🧪 TP 28 — DNS interne et redirecteur

**🎯 Objectif.** Comprendre comment un **nom interne** (`dc1.horizon.local`) et un **nom public** (`www.banquehorizon.com`) se résolvent à partir du même poste, avec un résolveur qui ne connaît que l'un des deux mondes.

**🔧 Manipulation.**

```powershell
# sur PC-GUICHET1
Resolve-DnsName dc1.horizon.local
Resolve-DnsName dc1.horizon.local -Server 10.20.20.53
Resolve-DnsName www.banquehorizon.com -Server 10.20.20.10
```

```powershell
# sur DC1
Get-DnsServerForwarder
reg query HKLM\SYSTEM\CurrentControlSet\Services\DNS\Parameters
```

```
# sur PC-CONSEILLER
dig @203.0.113.10 dc1.horizon.local +noall +comments
```

**✅ Résultat attendu.** Le nom interne se résout, par le serveur DNS du poste (DC1, donné par DHCP) :

```

Name      : dc1.horizon.local
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 10.20.20.10
```

…et aussi **à travers le résolveur DNS-RES**, qui **transfère** la question à DC1 (le bloc `type forward` du TP 16) :

```

Name      : dc1.horizon.local
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 10.20.20.10
```

À l'inverse, DC1 sait répondre pour un **nom public** : il ne le connaît pas, il le fait suivre à DNS-RES. Un seul serveur, deux mondes :

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

La configuration du redirecteur de DC1 :

```

IPAddress     UseRootHint Timeout EnableReordering
---------     ----------- ------- ----------------
{10.20.20.53} True              3 True
```

…qui est une valeur du registre, comme tout dans Windows :

```

HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\DNS\Parameters
    EnableGlobalQueryBlockList    REG_DWORD    0x1
    GlobalQueryBlockList    REG_MULTI_SZ    isatap\0wpad
    Forwarders    REG_MULTI_SZ    10.20.20.53
```

Enfin, **depuis l'extérieur**, le nom interne n'existe pas : NS1-BANK n'en sait rien et, n'étant pas récursif, **refuse** :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: REFUSED, id: 46
;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1
;; WARNING: recursion requested but not available

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
```

**🧠 Ce que tu viens d'apprendre.**

- Un **DNS privé** (`horizon.local`, qui n'existe dans aucune zone publique) est une zone qu'**un seul serveur interne** détient, ici DC1. Les noms internes ne doivent **jamais** être publiés dans la zone publique : ils révéleraient l'architecture du réseau.
- Il y a deux façons de joindre ce serveur depuis le résolveur d'agence : un bloc `forward` **par domaine** (BIND, le TP 16) ou un **redirecteur global** (`Get-DnsServerForwarder`, Windows : « toute question que je ne sais pas résoudre, envoie-la à `10.20.20.53` »). Les deux se complètent ici, dans les deux sens.
- Les deux serveurs de DNS de l'agence (DC1 et DNS-RES) sont donc **interdépendants** : si l'un tombe, une moitié des résolutions s'arrête. C'est une vraie conception à surveiller.

⚠️ **Attention** — Un redirecteur ne vérifie rien : il fait confiance à la réponse qu'il reçoit. Un redirecteur compromis ou mal configuré (une adresse de FAI inconnue, un résolveur public sans accord) fait passer **toutes** vos questions par un tiers.

---

## 37. 🧪 TP 29 — DHCP et enregistrement dynamique

**🎯 Objectif.** Voir comment un poste obtient ses serveurs DNS, et comment son nom apparaît **tout seul** dans la zone.

**🔧 Manipulation.**

```powershell
# sur DC1
Get-DhcpServerv4Lease -ScopeId 10.20.10.0
Get-DnsServerResourceRecord -ZoneName horizon.local
```

```powershell
# sur PC-GUICHET2
ipconfig /release
ipconfig /renew
ipconfig
```

**✅ Résultat attendu.** DC1 a distribué trois baux dans le réseau `10.20.10.0/24` :

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

…et le serveur DHCP a inscrit lui-même les postes dans `horizon.local` (les lignes avec un `Timestamp` — c'est un enregistrement **dynamique**, d'une durée de 1200 s) :

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

`ipconfig /release` rend l'adresse (la carte n'a plus de configuration) :

```
Windows IP Configuration

No operation can be performed on Ethernet 1 while it has its media disconnected.
No operation can be performed on Ethernet 2 while it has its media disconnected.
No operation can be performed on Ethernet 3 while it has its media disconnected.

Ethernet adapter Ethernet 0:

   Connection-specific DNS Suffix  . :
   Default Gateway . . . . . . . . . :
```

`ipconfig /renew` la redemande — et le serveur, qui se souvient du bail, rend **la même adresse**, avec le suffixe `horizon.local` fourni par DHCP :

```
Windows IP Configuration

Ethernet adapter Ethernet 0:
   Connection-specific DNS Suffix  . : horizon.local
   Link-local IPv6 Address. . . . . . : fe80::ff:fe00:73%2
   IPv4 Address. . . . . . . . . . . : 10.20.10.51
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 10.20.10.1
```

**🧠 Ce que tu viens d'apprendre.**

- Un bail DHCP porte, en plus de l'adresse, le **masque**, la **passerelle**, les **serveurs DNS** (option 6) et le **suffixe de domaine** (option 15) : c'est ce qui fait que `intranet` seul se résout (TP 6) et que le poste interroge DC1 sans rien configurer.
- L'**enregistrement dynamique** : le serveur DHCP (ou le client) crée l'enregistrement `A` — et le `PTR` — du poste dans DNS. Ils disparaissent à l'expiration (ou par *scavenging*) : la zone se tient à jour sans intervention.
- Dans une zone *publique* (BIND de la banque), ce n'est **pas** le cas : pas de mise à jour dynamique sans `allow-update` explicite et signé, précisément parce qu'on ne veut pas que n'importe quel poste puisse modifier une zone.

> 🔍 **Point d'audit** — La mise à jour dynamique **non sécurisée** (`DynamicUpdate : NonsecureAndSecure`, comme ici) permet à n'importe quel poste du réseau de créer ou d'écraser un enregistrement. Sur un domaine Active Directory réel, on la règle à *Secure only*.

---

## 38. 🧪 TP 30 — La NRPT du poste Windows

**🎯 Objectif.** Casser la résolution d'un poste en lui donnant un mauvais serveur DNS, la **réparer pour un seul domaine** par une règle de stratégie de noms (NRPT), puis tout remettre en état.

**🔧 Manipulation.**

```powershell
# sur PC-GUICHET1
Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 10.20.20.250
Clear-DnsClientCache
Resolve-DnsName dc1.horizon.local
Add-DnsClientNrptRule -Namespace ".horizon.local" -NameServers 10.20.20.10
Resolve-DnsName dc1.horizon.local
Get-DnsClientNrptRule
Resolve-DnsName www.banquehorizon.com
```

**✅ Résultat attendu.** Avec un serveur DNS qui n'existe pas (`10.20.20.250`), le poste n'obtient aucune réponse. L'erreur le dit — « le délai est dépassé », pas « le nom n'existe pas » :

```
Resolve-DnsName : dc1.horizon.local : This operation returned because the timeout period expired
    + CategoryInfo          : ResourceUnavailable: (dc1.horizon.local:String) [Resolve-DnsName], Win32Exception
    + FullyQualifiedErrorId : ERROR_TIMEOUT,Microsoft.DnsClient.Commands.ResolveDnsName
```

La règle NRPT dit : « pour tout nom en `.horizon.local`, **demande à 10.20.20.10** ». Le nom se résout de nouveau :

```

Name      : dc1.horizon.local
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 10.20.20.10
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

Mais la règle ne change rien aux **autres** noms : le poste est toujours privé de DNS public :

```
Resolve-DnsName : www.banquehorizon.com : This operation returned because the timeout period expired
    + CategoryInfo          : ResourceUnavailable: (www.banquehorizon.com:String) [Resolve-DnsName], Win32Exception
    + FullyQualifiedErrorId : ERROR_TIMEOUT,Microsoft.DnsClient.Commands.ResolveDnsName
```

On retire la règle et on rend au poste les serveurs que lui donne DHCP :

```powershell
# sur PC-GUICHET1
Get-DnsClientNrptRule | Remove-DnsClientNrptRule -Force
Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ResetServerAddresses
Get-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -AddressFamily IPv4
Resolve-DnsName www.banquehorizon.com | Select-Object -First 1
```

```

InterfaceAlias InterfaceIndex AddressFamily ServerAddresses
-------------- -------------- ------------- ---------------
Ethernet 0                  2 IPv4          {10.20.20.10, 10.20.20.53}
```

```

Name     : www.banquehorizon.com
Type     : CNAME
TTL      : 3596
Section  : Answer
NameHost : web.banquehorizon.com
```

**🧠 Ce que tu viens d'apprendre.**

- La **NRPT** (*Name Resolution Policy Table*) est une table de règles **par suffixe** : chaque règle associe un domaine à des serveurs. La règle la plus spécifique l'emporte. C'est ce qui permet à un poste en VPN de résoudre les noms de l'entreprise par les serveurs de l'entreprise et le reste par son propre réseau.
- `Set-DnsClientServerAddress -ServerAddresses` fixe les serveurs **à la main** et **remplace** ce que DHCP donnait ; `-ResetServerAddresses` revient au mode « configuré par DHCP » (les deux serveurs du bail, `10.20.20.10` et `10.20.20.53`). `ipconfig /renew` seul **ne suffit pas** : il ne touche pas une liste fixée à la main.
- Les deux messages d'erreur à bien distinguer : `ERROR_TIMEOUT` (personne n'a répondu : mauvais serveur, réseau) contre `DNS_ERROR_RCODE_NAME_ERROR` (un serveur a répondu : le nom n'existe pas).

> 🔍 **Point d'audit** — Les règles NRPT sont stockées dans le registre (`HKLM\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters\DnsPolicyConfig`) : elles sont **posées par stratégie de groupe** dans un domaine, et un attaquant qui peut les écrire peut rediriger la résolution d'un suffixe vers son serveur. À superviser comme n'importe quelle clé de persistance.

---

# Partie IX — Observer

Un service qu'on ne sait pas observer est un service qu'on ne sait pas dépanner, ni prouver. Deux outils : le **journal des requêtes** de `named` (ce qui a été demandé, par qui) et la **capture de paquets** (ce qui a réellement circulé).

---

## 39. 🧪 TP 31 — Journaliser les requêtes

**🎯 Objectif.** Faire écrire à `named` une ligne par question reçue, dans un fichier qu'on choisit, et savoir lire cette ligne.

**🔧 Manipulation.**

```
# sur DNS-RES
sudo cp /etc/bind/named.conf /tmp/named.conf.orig
sudo mkdir -p /var/log/named
sudo tee -a /etc/bind/named.conf <<'EOF'
logging {
    channel query_log { file "/var/log/named/query.log" versions 3 size 5m; severity info; print-time yes; };
    category queries { query_log; };
};
EOF
named-checkconf; echo rc=$?
sudo rndc reconfig; sudo rndc querylog on; sudo rndc status | grep query
```

```
# sur PC-CONSEILLER
dig @10.20.20.53 ebanking.banquehorizon.com +short
```

```
# sur DNS-RES
sudo cat /var/log/named/query.log
```

**✅ Résultat attendu.** La configuration est valide et la journalisation active :

```
rc=0
```

```
query logging is ON
```

Le poste a obtenu l'alias et l'adresse :

```
web.banquehorizon.com.
203.0.113.20
```

Et le journal contient **une ligne** pour cette question :

```
04-Nov-2026 10:29:25.476 client @0x0 10.20.10.52#59210 (ebanking.banquehorizon.com): query: ebanking.banquehorizon.com IN A +E(0) (10.20.20.53)
```

**🔧 Manipulation (suite).** Une même question, posée de quatre façons différentes : sans demander la récursion, par TCP, sans EDNS, avec le bit DO (DNSSEC) :

```
# sur PC-CONSEILLER
dig @10.20.20.53 ebanking.banquehorizon.com +norecurse +short
dig @10.20.20.53 ebanking.banquehorizon.com +tcp +short
dig @10.20.20.53 ebanking.banquehorizon.com +noedns +short
dig @10.20.20.53 ebanking.banquehorizon.com +dnssec +short
```

```
# sur DNS-RES
sudo tail -4 /var/log/named/query.log
```

```
04-Nov-2026 10:29:25.507 client @0x0 10.20.10.52#57693 (ebanking.banquehorizon.com): query: ebanking.banquehorizon.com IN A -E(0) (10.20.20.53)
04-Nov-2026 10:29:25.517 client @0x0 10.20.10.52#32768 (ebanking.banquehorizon.com): query: ebanking.banquehorizon.com IN A +E(0)T (10.20.20.53)
04-Nov-2026 10:29:25.532 client @0x0 10.20.10.52#35384 (ebanking.banquehorizon.com): query: ebanking.banquehorizon.com IN A + (10.20.20.53)
04-Nov-2026 10:29:25.536 client @0x0 10.20.10.52#45456 (ebanking.banquehorizon.com): query: ebanking.banquehorizon.com IN A +E(0)D (10.20.20.53)
```

On remet le résolveur en état :

```
# sur DNS-RES
sudo cp /tmp/named.conf.orig /etc/bind/named.conf; sudo rndc reconfig; sudo rndc querylog off; sudo rndc status | grep query
```

```
query logging is OFF
```

**🧠 Ce que tu viens d'apprendre.** Lis la ligne de gauche à droite :

| Champ | Exemple | Sens |
|---|---|---|
| Date | `04-Nov-2026 10:29:25.476` | Choisie par `print-time yes` |
| `client @0x0` | | Identifiant interne du client dans `named` (une adresse mémoire dans un vrai BIND ; ici toujours `0x0`) |
| `10.20.10.52#59210` | | Adresse **et port source** de la machine qui pose la question (un port éphémère : il change à chaque `dig`) |
| `(ebanking.banquehorizon.com)` | | Le nom demandé, tel que le client l'a écrit |
| `query: … IN A` | | Nom, classe, **type** demandé |
| `+E(0)` | | **Drapeaux** (ci-dessous) |
| `(10.20.20.53)` | | L'adresse du serveur qui a reçu la question |

Les **drapeaux** : `+` la récursion est demandée (`-` : elle ne l'est pas, `+norecurse`) ; `E(0)` la question porte une option EDNS, version 0 (absente avec `+noedns`) ; `T` la question est venue en **TCP** ; `D` le bit DO est positionné : le client veut les signatures DNSSEC. Le vrai BIND ajoute encore `K` quand le client a envoyé un *cookie* (le simulateur n'en envoie pas).

- **Où écrire** : sans bloc `logging`, un vrai BIND écrit les requêtes dans le journal système. Un bloc `logging` explicite, comme ci-dessus, est la pratique, parce qu'il permet de choisir le fichier, sa rotation (`versions 3 size 5m` : trois archives de 5 Mo au plus) et de n'envoyer **que** les requêtes là où on veut.
- `rndc querylog on|off` active et désactive la journalisation **sans redémarrer** : on l'allume pour un diagnostic, on l'éteint ensuite — un résolveur chargé écrit des milliers de lignes par minute.

> 🔍 **Point d'audit** — Ce journal est une **donnée personnelle** : il dit quel poste a cherché quel site. Il se conserve selon une durée décidée (et écrite), avec accès restreint. Et c'est la meilleure source pour retrouver, après coup, quels postes ont résolu le nom d'un domaine malveillant.

---

## 40. 🧪 TP 32 — Voir le DNS sur le fil : UDP, troncature, TCP

**🎯 Objectif.** Capturer des paquets DNS, les relire, et voir ce qui se passe quand une réponse **ne tient pas** dans un datagramme UDP.

**🔧 Manipulation.** On publie d'abord 60 adresses sous un même nom (`many`) — assez pour dépasser 512 octets — :

```
# sur NS1-BANK
for i in $(seq 1 60); do echo "many IN A 198.51.100.$i" | sudo tee -a /etc/bind/db.banquehorizon.com > /dev/null; done
sudo sed -i 's/2026103101/2026103102/' /etc/bind/db.banquehorizon.com
sudo rndc reload banquehorizon.com
```

Puis une question **sans EDNS** (`+noedns`, comme le faisaient les clients d'avant 1999), capturée dans un fichier, lue ensuite :

```
# sur PC-CONSEILLER
sudo tcpdump -ni eth0 -w /tmp/dns.pcap port 53 & sleep 1; dig @203.0.113.10 many.banquehorizon.com +noedns +norecurse +noall +comments; sleep 1; sudo pkill tcpdump; sleep 1
sudo tcpdump -nr /tmp/dns.pcap
```

**✅ Résultat attendu.** `dig` affiche une réponse complète — mais ce n'est pas ce que le serveur a répondu **en premier** :

```
[1] 45
;; Truncated, retrying in TCP mode.
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 52
;; flags: qr aa; QUERY: 1, ANSWER: 60, AUTHORITY: 2, ADDITIONAL: 2
```

La capture, ligne à ligne :

```
reading from file /tmp/dns.pcap, link-type EN10MB (Ethernet), snapshot length 262144
10:29:26.782723 IP 10.20.10.52.50810 > 203.0.113.10.53: 51 A? many.banquehorizon.com. (40)
10:29:26.788844 IP 203.0.113.10.53 > 10.20.10.52.50810: 51*-| 29/0/0 A 198.51.100.1, A 198.51.100.2, A 198.51.100.3, A 198.51.100.4, A 198.51.100.5, A 198.51.100.6, A 198.51.100.7, A 198.51. […]
10:29:26.792844 IP 10.20.10.52.32769 > 203.0.113.10.53: Flags [S], seq 2634807467, win 65535, options [mss 1460,sackOK,TS val 13418 ecr 0,nop,wscale 7], length 0
10:29:26.795876 IP 203.0.113.10.53 > 10.20.10.52.32769: Flags [S.], seq 2871740974, ack 2634807468, win 65535, options [mss 1460,sackOK,TS val 13420 ecr 13418,nop,wscale 7], length 0
10:29:26.795876 IP 10.20.10.52.32769 > 203.0.113.10.53: Flags [.], ack 1, win 511, options [nop,nop,TS val 13421 ecr 13420], length 0
10:29:26.798891 IP 10.20.10.52.32769 > 203.0.113.10.53: Flags [P.], seq 1:43, ack 1, win 511, options [nop,nop,TS val 13424 ecr 13420], length 42 52 A? many.banquehorizon.com. (40)
10:29:26.801125 IP 203.0.113.10.53 > 10.20.10.52.32769: Flags [P.], seq 1:1071, ack 43, win 511, options [nop,nop,TS val 13426 ecr 13424], length 1070 52*- 60/2/2 A 198.51.100.2, A 198.51.10 […]
10:29:26.801125 IP 10.20.10.52.32769 > 203.0.113.10.53: Flags [F.], seq 43, ack 1071, win 511, options [nop,nop,TS val 13427 ecr 13426], length 0
10:29:26.801154 IP 203.0.113.10.53 > 10.20.10.52.32769: Flags [.], ack 44, win 511, options [nop,nop,TS val 13429 ecr 13427], length 0
10:29:26.801154 IP 203.0.113.10.53 > 10.20.10.52.32769: Flags [F.], seq 1071, ack 44, win 511, options [nop,nop,TS val 13429 ecr 13427], length 0
10:29:26.801154 IP 10.20.10.52.32769 > 203.0.113.10.53: Flags [.], ack 1072, win 511, options [nop,nop,TS val 13430 ecr 13429], length 0
```

(Les lignes 3 et 8 sont coupées à l'affichage : elles énumèrent les adresses, 29 pour la première, 60 pour la seconde.)

**🔧 Manipulation (suite).** Les mêmes questions, en demandant à `dig` de s'arrêter à la réponse tronquée (`+ignore`), puis en le laissant se débrouiller, puis directement en TCP, puis en EDNS avec une taille de 1232 octets :

```
# sur PC-CONSEILLER
dig @203.0.113.10 many.banquehorizon.com +noedns +norecurse +ignore +noall +comments +stats
dig @203.0.113.10 many.banquehorizon.com +noedns +norecurse +noall +comments +stats
dig @203.0.113.10 mail.banquehorizon.com +tcp +noall +comments +answer +stats
dig @203.0.113.10 many.banquehorizon.com +bufsize=1232 +norecurse +noall +comments
```

La réponse **coupée** (`tc`, 29 enregistrements sur 60, 504 octets, par UDP) :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 54
;; flags: qr aa tc; QUERY: 1, ANSWER: 29, AUTHORITY: 0, ADDITIONAL: 0

;; Query time: 0 msec
;; SERVER: 203.0.113.10#53(203.0.113.10) (UDP)
;; WHEN: Wed Nov 04 10:29:31 UTC 2026
;; MSG SIZE  rcvd: 504
```

Le comportement normal de `dig` : il **recommence en TCP** et le dit en tête de sortie :

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

Une question TCP d'emblée :

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

Avec EDNS et une taille de 1232 octets, **tout tient** dans un seul datagramme UDP (pas de `tc`, pas de TCP) :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 58
;; flags: qr aa; QUERY: 1, ANSWER: 60, AUTHORITY: 2, ADDITIONAL: 3

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
```

Et une question « normale » vue de la même façon (le résolveur, avec EDNS, pour `mail2`) :

```
# sur PC-CONSEILLER
sudo tcpdump -ni eth0 -w /tmp/dns2.pcap port 53 & sleep 1; dig @10.20.20.53 mail2.banquehorizon.com +short; sleep 1; sudo pkill tcpdump; sleep 1
sudo tcpdump -nr /tmp/dns2.pcap
```

```
reading from file /tmp/dns2.pcap, link-type EN10MB (Ethernet), snapshot length 262144
10:29:29.844169 IP 10.20.10.52.59334 > 10.20.20.53.53: 53+ [1au] A? mail2.banquehorizon.com. (52)
10:29:29.851316 IP 10.20.20.53.53 > 10.20.10.52.59334: 53 1/2/3 A 203.0.113.26 (136)
```

On remet la zone en état :

```
# sur NS1-BANK
sudo sed -i '/^many /d; s/2026103102/2026103103/' /etc/bind/db.banquehorizon.com
sudo rndc reload banquehorizon.com
```

**🧠 Ce que tu viens d'apprendre.**

*Lire une ligne de `tcpdump`* :

| Morceau | Sens |
|---|---|
| `51` | Identifiant de la question (la réponse porte le même) |
| `+` | Récursion demandée (`rd`) |
| `[1au]` | Un enregistrement dans la section additionnelle, de type **EDNS** (l'`OPT`) |
| `A?` | C'est une **question** de type A, sur `many.banquehorizon.com.` |
| `(40)` | Longueur du message DNS, en octets |
| `51*-\|` | Une **réponse** : `*` faisant autorité (`aa`), `-` récursion **non** disponible, `\|` **tronquée** (`tc`) |
| `29/0/0` | Nombre d'enregistrements en `ANSWER` / `AUTHORITY` / `ADDITIONAL` |
| `1/2/3 A 203.0.113.26 (136)` | Idem pour une réponse complète, avec son premier enregistrement |

*Ce qui s'est passé* :

1. Sans EDNS, une réponse UDP est limitée à **512 octets** (RFC 1035 §4.2.1). Le serveur met dans le datagramme ce qui tient (29 adresses), positionne le bit **TC** (*truncated*) et envoie.
2. Le client voit `tc` et **recommence en TCP** : poignée de main (SYN, SYN-ACK, ACK), la question (précédée de sa longueur sur deux octets), la réponse **complète** (`60/2/2` : 1068 octets de message DNS, précédés de leurs deux octets de longueur), fermeture (FIN).
3. Avec **EDNS0**, le client annonce la taille qu'il accepte (`udp: 1232`, valeur recommandée pour éviter la fragmentation IP) : 60 adresses tiennent, aucun TCP.

- **Le DNS utilise TCP, aussi.** Un pare-feu qui n'ouvre que `UDP/53` casse les grosses réponses (listes d'adresses, DNSSEC, certaines réponses `TXT`) : le symptôme est « ça marche pour les petits noms, pas pour les gros », très difficile à trouver sans capture.
- Un transfert de zone (TP 18) se fait **toujours** par TCP.
- `dig +ignore` ne sert qu'à *voir* la réponse tronquée ; en pratique on laisse `dig` recommencer.

> 🔍 **Point d'audit** — Garde des captures datées du trafic DNS à la frontière du réseau : elles prouvent, après coup, qu'un poste a bien interrogé un domaine donné, et à quelle heure.

---

# Partie X — Le web vu du DNS

---

## 41. 🧪 TP 33 — Un nom, une adresse, plusieurs sites

**🎯 Objectif.** Comprendre la part du DNS dans « ouvrir un site » — et ce qu'il ne fait **pas** : il donne l'adresse, le reste appartient à HTTP et à TLS.

**🔧 Manipulation.**

```
# sur PC-CONSEILLER
curl -sI http://www.banquehorizon.com/
curl -skI https://ebanking.banquehorizon.com/
curl -s -o /dev/null -w "%{http_code}\n" http://203.0.113.20/
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: www.banquehorizon.com" http://203.0.113.20/
```

**✅ Résultat attendu.** `www` : le serveur répond par une **redirection** vers la version HTTPS :

```
HTTP/1.1 301 Moved Permanently
Server: nginx/1.24.0
Content-Type: text/html
Location: https://www.banquehorizon.com/
Content-Length: 169
```

`ebanking` (un autre nom, **la même machine**, `203.0.113.20`) répond, en HTTPS, avec une autre page et des en-têtes de sécurité :

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

Même adresse, mais **par l'adresse seule**, sans dire quel site on veut : le serveur ne sait pas quoi servir.

```
404
```

En ajoutant l'en-tête `Host:` on retrouve le site `www` (et sa redirection) :

```
301
```

**🧠 Ce que tu viens d'apprendre.**

- Dans la zone (TP 14), `www`, `ebanking`, `agences` et `api` sont tous des **CNAME** vers `web`, qui a **une** adresse : quatre noms, une machine. Le DNS dit *où* ; c'est le serveur web qui décide *quoi* servir, d'après le nom que le client lui annonce — l'en-tête **`Host:`** en HTTP, l'extension **SNI** dans la poignée de main TLS.
- C'est pour cela que `curl http://203.0.113.20/` donne `404` : par l'adresse, il n'y a pas de nom, donc pas de site. C'est aussi pourquoi **tester un site en le visant par son adresse IP est un mauvais test** (et pourquoi `curl --resolve nom:443:IP` ou `-H "Host: …"` existent).
- Changer l'adresse de `web` (une migration de serveur) change l'accès aux **quatre** sites en une seule modification : l'intérêt du CNAME. Son prix : une résolution de plus à chaque fois (TP 10).
- Le **CNAME est interdit au sommet de la zone** : `banquehorizon.com.` lui-même porte un `A` (`203.0.113.20`), pas un alias, parce qu'un sommet de zone a toujours un SOA et des NS, et qu'un CNAME ne peut coexister avec aucun autre type (TP 15).

> 🔍 **Point d'audit** — Plusieurs sites sur une seule adresse : un certificat qui ne couvre pas tous les noms est le défaut le plus fréquent. Vérifie, nom par nom, que le certificat présenté correspond (`curl -v` ou `openssl s_client -servername …`).

---

# Partie XI — Quand ça ne marche pas, et comment le prouver

Tout ce que tu as fait jusqu'ici sert maintenant : dépanner un service de noms, c'est poser les bonnes questions **dans le bon ordre** et lire les réponses sans les interpréter trop vite.

---

## 42. La méthode en six questions

Devant « ça ne résout pas », ne change rien avant d'avoir répondu à ces six questions, dans cet ordre :

| # | Question | Comment y répondre | Ce que tu cherches |
|---|---|---|---|
| 1 | **Qui interroge qui ?** | `resolvectl status`, `cat /etc/resolv.conf` (Linux) ; `Get-DnsClientServerAddress`, `ipconfig /all` (Windows) | Le serveur DNS que le poste utilise *vraiment* (TP 5), et le suffixe de recherche (TP 6) |
| 2 | **Le serveur répond-il ?** | `dig @serveur nom +time=1 +tries=1` | `connection refused` (service arrêté), `timed out` (réseau, pare-feu, mauvaise adresse), ou une réponse (TP 27, TP 30) |
| 3 | **Que dit le code de retour ?** | `status:` dans l'en-tête de `dig`, `+noall +comments` | `NXDOMAIN`, `NOERROR` vide (NODATA), `SERVFAIL`, `REFUSED` — quatre pannes différentes (TP 13, TP 26) |
| 4 | **Est-ce du cache ?** | TTL qui décroît (TP 21) ; `+norecurse` ; interroger directement le serveur d'autorité | Une réponse ancienne ou négative retenue (TP 22) : vider au bon niveau (TP 25) |
| 5 | **Les serveurs d'autorité sont-ils d'accord ?** | `dig @ns1 zone SOA +short` puis `@ns2` ; `dig +trace` | Un numéro de série différent (TP 19), une délégation fausse (TP 8, TP 20) |
| 6 | **Que voit-on réellement sur le fil ?** | `tcpdump -w` puis `-r` ; journal des requêtes | Le paquet part-il ? La réponse revient-elle ? En UDP seulement ? (TP 31, TP 32) |

Deux règles qui évitent les fausses pistes :

- **Teste toujours avec l'outil qui ressemble à l'application.** `dig` ignore la liste de suffixes (sauf `+search`) et le cache du système : `getent hosts` (Linux) et `Resolve-DnsName` (Windows) font ce que font les programmes (TP 6).
- **Change une chose à la fois, et vérifie chaque changement par la commande qui a révélé le symptôme.**

---

## 43. 🧪 TP 34 — Cinq pannes à diagnostiquer

**🎯 Objectif.** Appliquer la méthode : cinq symptômes, une commande décisive pour chacun, la cause, le remède. Les pannes 3 à 5 reprennent des TP précédents : refais-les **sans relire** le TP, en suivant le tableau du § 42, et ne regarde le TP qu'ensuite.

### Panne 1 — « Plus rien ne se résout dans l'agence »

**🔧 Manipulation (pour provoquer).**

```
# sur DNS-RES
sudo systemctl stop named
```

**Symptômes** (question 1 : le poste utilise le stub, qui s'appuie sur DNS-RES ; question 2 : on interroge le résolveur directement).

```
# sur PC-CONSEILLER
dig @10.20.20.53 www.banquehorizon.com +time=1 +tries=1
dig www.banquehorizon.com +short
```

```
;; communications error to 10.20.20.53#53: connection refused

; <<>> DiG 9.18.12-0ubuntu0.22.04.1-Ubuntu <<>> @10.20.20.53 www.banquehorizon.com +time=1 +tries=1
; (1 server found)
;; global options: +cmd
;; no servers could be reached
```

Interrogé par le stub, le poste n'affiche **rien du tout** : pas d'erreur, pas de réponse (le stub n'a aucun serveur qui réponde et ne dit rien de plus avec `+short`).

```

```

**Diagnostic.** `connection refused` : la machine est joignable, **rien n'écoute** sur le port 53. On le confirme sur le serveur :

```
# sur DNS-RES
sudo rndc status
ss -ulnp | grep named; echo rc=$?
systemctl is-active named
```

```
rndc: connect failed: 127.0.0.1#953: connection refused
```

`ss` ne trouve plus aucun processus `named` (`grep` ne trouve rien, code de retour 1) :

```
rc=1
```

```
inactive
```

**Remède.**

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

*Leçon* : `rndc: connect failed … connection refused` et un `connection refused` sur le port 53 racontent la même histoire : `named` ne tourne pas. Un `dig +short` qui n'affiche rien est **la pire sortie** à interpréter : repasse en `+noall +comments` pour voir le code de retour.

### Panne 2 — « Le serveur DNS principal du poste est arrêté, et tout marche »

**🔧 Manipulation.** On arrête le service DNS de DC1 (le premier serveur DNS donné au poste par DHCP), après avoir vidé le cache du stub :

```
# sur PC-CONSEILLER
sudo resolvectl flush-caches
```

```powershell
# sur DC1
Stop-Service DNS
```

```
# sur PC-CONSEILLER
dig ebanking.banquehorizon.com +short
resolvectl status | grep 'Current DNS'
```

```powershell
# sur DC1
Start-Service DNS
```

**Résultat.** Le nom public se résout toujours — le poste a **basculé** sur son second serveur DNS (DNS-RES) :

```
web.banquehorizon.com.
203.0.113.20
```

```
  Current DNS Server: 10.20.20.53
```

*Leçon* : une panne partielle peut être **invisible** pour l'utilisateur, ce qui est le but de deux serveurs — mais elle doit l'être pour toi aussi, par la **supervision**, pas par les plaintes. (Les noms de `horizon.local` n'auraient pas résolu : seul DC1 les connaît, voir TP 28.)

### Panne 3 — « J'ai changé l'enregistrement, mais certains voient encore l'ancien »

Commande décisive (question 5) :

```
# sur PC-CONSEILLER
dig @203.0.113.10 banquehorizon.com SOA +short
dig @203.0.113.11 banquehorizon.com SOA +short
```

Deux numéros de série **différents** : le secondaire est en retard (le numéro n'a pas été monté, TP 19). Remède : monter le numéro de série **et** recharger. Si les numéros sont identiques et qu'une réponse reste ancienne, c'est un **cache** (questions 4 puis TP 25).

### Panne 4 — « SERVFAIL sur un domaine »

Commande décisive : `dig +trace @10.20.20.53 domaine` — la chaîne s'arrête à la délégation dont le serveur ne répond pas (TP 26, TP 8). Un `SERVFAIL` n'est jamais réparé en modifiant le résolveur : la cause est **en aval**, chez un serveur d'autorité ou dans la délégation.

### Panne 5 — « Un seul poste n'arrive plus à résoudre les noms internes »

Commandes décisives (question 1) : `Get-DnsClientServerAddress` sur ce poste, `Get-DnsClientNrptRule`. Un serveur DNS fixé à la main qui n'existe plus (`10.20.20.250` du TP 30), une règle NRPT oubliée : la cause est **locale** au poste, pas dans le service. `Set-DnsClientServerAddress -ResetServerAddresses` rend la main à DHCP.

**🧠 Ce que tu viens d'apprendre.**

| Symptôme | Cause la plus probable | Commande décisive |
|---|---|---|
| `connection refused` | Service arrêté | `systemctl is-active named`, `rndc status` |
| `timed out` | Réseau, pare-feu, mauvaise adresse du serveur | `ping`, `Get-DnsClientServerAddress` |
| `REFUSED` | ACL (`allow-query`, `allow-recursion`) ou serveur non récursif | Config du serveur (TP 16) |
| `SERVFAIL` | Serveur d'autorité en aval cassé, DNSSEC | `dig +trace` |
| `NXDOMAIN` | Nom absent — **ou** absence en cache | Interroger l'autorité avec `+norecurse` |
| `NOERROR` + 0 réponse | Type absent (NODATA) | `dig nom TYPE` |
| Réponse différente selon le serveur | Secondaire en retard | SOA des deux serveurs |

---

## 44. Les messages d'erreur et ce qu'ils veulent dire

Tous ces messages ont été produits dans ce laboratoire.

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

## 45. 🧪 TP 35 — Auditer le service de noms

**🎯 Objectif.** Dérouler la liste de contrôles d'un auditeur sur le laboratoire, **avec la preuve** de chaque point.

**🔧 Manipulation et résultats.**

**1. Le serveur d'autorité n'est pas un résolveur ouvert.** Une question hors de ses zones est refusée :

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

**2. Le transfert de zone est restreint.** Un poste ordinaire ne peut pas copier la zone :

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

**3. La version du serveur n'est pas annoncée à tout le monde.** Par défaut, la requête CHAOS `version.bind` répond :

```
# sur PC-CONSEILLER
dig @203.0.113.10 version.bind CHAOS TXT +short
```

```
"9.18.12-0ubuntu0.22.04.1-Ubuntu"
```

On ajoute `version none;` dans le bloc `options` de NS1-BANK, on vérifie la configuration, on recharge :

```
# sur NS1-BANK
sudo sed -i 's/recursion no;/recursion no; version none;/' /etc/bind/named.conf; sudo rndc reconfig; named-checkconf; echo rc=$?
```

```
rc=0
```

```
# sur PC-CONSEILLER
dig @203.0.113.10 version.bind CHAOS TXT +noall +comments +authority
```

Plus de réponse (`ANSWER: 0`), seulement un SOA de la pseudo-zone `version.bind` :

```
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 68
;; flags: qr aa rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 0
;; WARNING: recursion requested but not available

;; AUTHORITY SECTION:
version.bind.		86400	CH	SOA	version.bind. hostmaster.version.bind. 0 28800 7200 604800 86400
```

On remet la configuration d'origine :

```
# sur NS1-BANK
sudo sed -i 's/ version none;//' /etc/bind/named.conf; sudo rndc reconfig
```

**4. Les deux serveurs d'autorité servent la même version de la zone.**

```
# sur PC-CONSEILLER
dig @203.0.113.10 banquehorizon.com SOA +short; dig @203.0.113.11 banquehorizon.com SOA +short
```

```
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
ns1.banquehorizon.com. hostmaster.banquehorizon.com. 2026103101 7200 900 1209600 3600
```

**5. La configuration et les zones se chargent sans erreur.**

```
# sur NS1-BANK
named-checkconf -z; echo rc=$?
```

```
zone banquehorizon.com/IN: loaded serial 2026103101
zone 113.0.203.in-addr.arpa/IN: loaded serial 2026103101
rc=0
```

**6. Le résolveur n'est offert qu'au réseau de l'agence.** Voir le TP 16 : l'ACL `agence`, le test de sortie de l'ACL (`REFUSED`).

**7. La politique de journalisation est écrite et appliquée.** Voir le TP 31.

**🧠 Ce que tu viens d'apprendre.**

| Contrôle | Commande | Attendu | Preuve à conserver |
|---|---|---|---|
| Pas de récursion ouverte | `dig @autorité nom-hors-zone` | `REFUSED` | La sortie, datée |
| Transfert restreint | `dig @autorité zone AXFR` depuis un poste non autorisé | `Transfer failed.` | La sortie, datée |
| Version masquée | `dig version.bind CHAOS TXT` | Pas de `TXT` | La sortie, datée |
| Cohérence primaire/secondaire | SOA des deux serveurs | Même numéro de série | Les deux lignes |
| Configuration saine | `named-checkconf -z; echo rc=$?` | `rc=0` | Sortie + somme de `named.conf` |
| Résolveur restreint | Test hors ACL (TP 16) | `REFUSED` | La sortie, datée |
| Journalisation | `rndc status | grep query`, fichier de log | Conforme à la politique | Extrait + durée de conservation |

Masquer la version n'est **pas** une protection : c'est une façon de ne pas faciliter le travail de qui cherche une faille connue. Aucun de ces contrôles ne remplace la mise à jour du logiciel.

---

## 46. Aide-mémoire

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

*Fin du tutoriel. Si une commande de ce document ne produit pas ce qui est écrit, c'est un défaut du simulateur ou du document : le test `tuto-dns-zero-a-heros.test.ts` est là pour le dire.*

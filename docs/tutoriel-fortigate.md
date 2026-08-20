# FortiGate de Zéro à Héros : Comprendre et Configurer un Pare-feu Nouvelle Génération

> **À qui s'adresse ce tutoriel ?**
> À toi si tu n'as jamais touché un FortiGate de ta vie. On part vraiment de zéro : je ne suppose pas que tu sais ce qu'est une politique de sécurité, ni un NAT, ni même précisément ce que fait un pare-feu. La seule chose que je te demande, c'est de savoir ce qu'est une adresse IP et de ne pas avoir peur d'un terminal. Le reste, on le construit ensemble. 🧱

> **Ce qui rend ce tutoriel différent**
> Il est **fait pour être exécuté, pas lu**. Dès la section 3 tu montes un laboratoire, et à partir de là **chaque concept est immédiatement suivi d'un TP** — un petit exercice concret où tu tapes les commandes, tu observes le résultat, et tu vois de tes yeux ce que la théorie racontait. Il y a **26 TP** dans ce document. Si tu les fais tous, tu auras configuré un pare-feu d'entreprise complet, du premier câble jusqu'au VPN et à la haute disponibilité.
>
> Chaque TP suit toujours la même structure :
> **🎯 Objectif** → **⏱️ Durée** → **📋 Prérequis** → **🔧 Manipulation** → **✅ Résultat attendu** → **🧠 Ce que tu viens d'apprendre**

---

## Comment utiliser ce document

Trois conseils avant de commencer, et ils comptent plus que tu ne crois.

**1. Ne saute pas les TP.** C'est tentant de lire d'une traite en se disant qu'on fera la pratique plus tard. Ça ne marche pas. Un pare-feu, ça s'apprend dans les doigts : tu ne comprendras vraiment l'ordre des politiques que le jour où *ta* règle ne matchera pas et que tu devras comprendre pourquoi.

**2. Casse des choses exprès.** Plusieurs TP te demandent volontairement de provoquer une panne, puis de la diagnostiquer. C'est le cœur du métier. Un administrateur qui n'a jamais vu un `Deny` dans les logs ne saura pas le lire le jour où ça compte.

**3. Garde une trace.** À chaque fin de partie, je te propose de sauvegarder ta configuration. Fais-le. Ça te permet de repartir d'un état sain si tu te perds, et ça t'apprend un réflexe que tu garderas toute ta carrière.

---

## Conventions typographiques

Pour que tu t'y retrouves, j'utilise toujours les mêmes marqueurs :

| Marqueur | Signification |
|---|---|
| 💡 **Astuce** | Un raccourci, une bonne pratique, un truc qui fait gagner du temps |
| ⚠️ **Attention** | Un piège classique. Lis-le, il t'évitera une soirée perdue |
| 🚨 **Danger** | Une commande qui peut te couper l'accès au pare-feu. À lire deux fois |
| 🧪 **TP** | Un exercice pratique à faire, pas à lire |
| 🧠 **Comprendre** | Une explication de fond, le « pourquoi » derrière le « comment » |
| 📖 **Le sais-tu ?** | Une anecdote ou un point d'histoire, tu peux sauter sans rien perdre |

Pour les blocs de commandes, je distingue toujours l'endroit où tu tapes :

```
FGT-01 #              ← invite du FortiGate en mode normal (CLI)
FGT-01 (policy) #     ← invite du FortiGate à l'intérieur d'une table de configuration
user@pc-lan:~$        ← invite d'un PC Linux du laboratoire
C:\Users\Lab>         ← invite d'un PC Windows du laboratoire
```

---

## Table des matières

### Partie I — Les fondations
1. [Avant de commencer : les bases indispensables](#1-avant-de-commencer--les-bases-indispensables)
2. [Qu'est-ce qu'un FortiGate exactement ?](#2-quest-ce-quun-fortigate-exactement-)
3. [Monter ton laboratoire](#3-monter-ton-laboratoire)

### Partie II — Premiers pas
4. [Premier démarrage et prise en main](#4-premier-démarrage-et-prise-en-main)
5. [La CLI FortiOS en profondeur](#5-la-cli-fortios-en-profondeur)
6. [Interfaces, zones et adressage](#6-interfaces-zones-et-adressage)
7. [Le routage sur FortiGate](#7-le-routage-sur-fortigate)

### Partie III — Le cœur du pare-feu
8. [Les objets : adresses, services, horaires](#8-les-objets--adresses-services-horaires)
9. [Les politiques de sécurité](#9-les-politiques-de-sécurité)
10. [Le NAT : SNAT, IP Pool et VIP](#10-le-nat--snat-ip-pool-et-vip)
11. [Le cheminement d'un paquet dans FortiOS](#11-le-cheminement-dun-paquet-dans-fortios)

### Partie IV — Les services réseau
12. [DHCP et DNS](#12-dhcp-et-dns)

### Partie V — La sécurité applicative
13. [Les modes d'inspection](#13-les-modes-dinspection)
14. [Les profils de sécurité](#14-les-profils-de-sécurité)
15. [L'inspection SSL/TLS](#15-linspection-ssltls)

### Partie VI — Les utilisateurs
16. [Authentification et gestion des utilisateurs](#16-authentification-et-gestion-des-utilisateurs)

### Partie VII — Les VPN
17. [VPN IPsec site-à-site](#17-vpn-ipsec-site-à-site)
18. [Accès distant : IPsec dial-up](#18-accès-distant--ipsec-dial-up)

### Partie VIII — Aller plus loin
19. [Le routage dynamique](#19-le-routage-dynamique)
20. [SD-WAN](#20-sd-wan)
21. [La haute disponibilité](#21-la-haute-disponibilité)

### Partie IX — L'exploitation au quotidien
22. [Journaux, FortiView et supervision](#22-journaux-fortiview-et-supervision)
23. [Diagnostic et dépannage](#23-diagnostic-et-dépannage)
24. [Sauvegarde, mise à jour et durcissement](#24-sauvegarde-mise-à-jour-et-durcissement)
25. [Les erreurs classiques](#25-les-erreurs-classiques)
26. [Aide-mémoire : toutes les commandes](#26-aide-mémoire--toutes-les-commandes)
27. [Conclusion et pour aller plus loin](#27-conclusion-et-pour-aller-plus-loin)

---

# Partie I — Les fondations

---

## 1. Avant de commencer : les bases indispensables

Cette section, c'est le socle. Si tu maîtrises déjà ces notions, survole-la — mais ne la saute pas complètement, parce que je vais y glisser du vocabulaire qu'on réutilisera constamment ensuite. Et surtout, je vais te faire comprendre **pourquoi** un pare-feu existe, ce qui n'est pas si évident qu'on le croit.

### 1.1 Rappel express : l'adresse IP

Une **adresse IP** est l'identifiant d'une machine sur un réseau. En IPv4, elle s'écrit avec quatre nombres de 0 à 255 séparés par des points : `192.168.1.10`.

Ce qu'il faut retenir pour la suite, c'est qu'une adresse IP n'est **pas** attachée à une machine, mais à une **interface réseau**. Une machine avec deux cartes réseau a deux adresses IP. Un pare-feu, qui a typiquement quatre, huit ou seize interfaces, a autant d'adresses. Cette distinction paraît anodine ; elle est en réalité fondamentale, parce que tout le travail d'un pare-feu consiste à décider ce qui a le droit de passer **d'une interface à une autre**.

### 1.2 Rappel express : le masque de sous-réseau

Le **masque de sous-réseau** découpe l'adresse IP en deux parties : la partie **réseau** (le quartier) et la partie **hôte** (le numéro de maison dans le quartier).

Avec `192.168.1.10 / 255.255.255.0` :
- `192.168.1` → le réseau : tous ceux qui commencent pareil sont des voisins directs
- `.10` → l'hôte : le numéro unique de cette machine dans le quartier

On note souvent le masque en **CIDR**, c'est-à-dire par le nombre de bits à 1 :

| CIDR | Masque décimal | Adresses utilisables | Usage typique |
|---|---|---|---|
| `/30` | 255.255.255.252 | 2 | Un lien point-à-point entre deux routeurs |
| `/29` | 255.255.255.248 | 6 | Un petit bloc public chez un opérateur |
| `/24` | 255.255.255.0 | 254 | Un LAN d'entreprise classique |
| `/16` | 255.255.0.0 | 65 534 | Un très grand réseau, rarement en un seul morceau |

> 💡 **Astuce** : sur FortiGate, tu peux écrire un masque des deux façons. `set ip 192.168.1.1 255.255.255.0` et `set ip 192.168.1.1/24` sont acceptés. La CLI te le réaffichera toujours en décimal pointé, quelle que soit la façon dont tu l'as saisi. Ne sois pas surpris.

### 1.3 Deux machines qui se parlent : le cas simple

Quand `192.168.1.10` veut parler à `192.168.1.20`, il compare les deux adresses à travers son masque, constate qu'elles sont dans le même quartier, et envoie directement. Aucun routeur n'intervient. C'est du **niveau 2** : la trame part vers l'adresse MAC de la destination, trouvée via ARP.

C'est important pour la suite : **un pare-feu ne voit pas ce trafic**. Deux machines du même sous-réseau, branchées sur le même switch, se parlent sans jamais passer par lui. Beaucoup de débutants configurent des règles pour bloquer du trafic interne, et s'étonnent que ça ne fonctionne pas. La raison est là.

### 1.4 Deux machines qui se parlent : le cas qui nous intéresse

Quand `192.168.1.10` veut parler à `8.8.8.8`, le calcul donne un quartier différent. La machine ne sait pas y aller elle-même : elle confie le paquet à sa **passerelle par défaut** (*default gateway*), c'est-à-dire à l'équipement dont c'est le métier de faire sortir le trafic.

**Cet équipement, dans notre laboratoire comme dans une vraie entreprise, ce sera le FortiGate.** Et c'est précisément là qu'il devient intéressant : puisque tout le trafic sortant passe par lui, il peut l'examiner, l'autoriser, le refuser, le journaliser, le réécrire, l'analyser à la recherche d'un virus. Il est au bon endroit.

### 1.5 Alors, c'est quoi un pare-feu ?

Un **pare-feu** (*firewall*) est un équipement placé à la frontière entre deux réseaux, qui décide de ce qui a le droit de traverser.

L'image du videur de boîte de nuit est éculée mais elle est juste, à condition de la pousser jusqu'au bout — parce que c'est la fin de l'analogie qui explique les générations de pare-feux :

| Génération | Ce que le videur regarde | Équivalent réseau |
|---|---|---|
| **Filtrage de paquets** | « Tu viens d'où, tu vas où ? » | IP source, IP destination, port |
| **Pare-feu à états** | « Je te reconnais, tu es déjà entré tout à l'heure » | Table de sessions (*stateful*) |
| **Nouvelle génération (NGFW)** | « Montre-moi ce que tu as dans ton sac » | Inspection du contenu applicatif |

Un FortiGate appartient à la troisième catégorie. Retiens bien ces trois niveaux, ils structurent tout le tutoriel : on configurera d'abord le filtrage (partie III), puis on ajoutera l'inspection de contenu (partie V).

### 1.6 🧠 Comprendre : ce que « à états » veut vraiment dire

C'est le concept le plus mal compris des débutants, et il conditionne la moitié de tes futures configurations. Alors on prend le temps.

Imagine que ton PC (`192.168.1.10`) consulte un site web (`93.184.216.34`). Que se passe-t-il, techniquement ?

1. Ton PC envoie un paquet **vers** le serveur : source `192.168.1.10:54321`, destination `93.184.216.34:443`
2. Le serveur répond : source `93.184.216.34:443`, destination `192.168.1.10:54321`

Le paquet aller sort de ton réseau. Le paquet retour **entre** dans ton réseau, depuis Internet. Or ta règle de sécurité, elle, dit sans doute : « interdire tout ce qui vient d'Internet ».

**Faut-il alors écrire une deuxième règle pour autoriser le retour ?**

Non. Et c'est exactement ce que « à états » signifie. Quand le FortiGate laisse passer le paquet aller, il **note dans une table** qu'une conversation est ouverte entre ces deux adresses et ces deux ports. Quand le paquet retour se présente, il le compare à cette table, le reconnaît comme la réponse à une conversation qu'il a lui-même autorisée, et le laisse passer sans même consulter tes règles.

> ⚠️ **Attention — c'est LA règle d'or du FortiGate**
> **Sur un FortiGate, une politique de sécurité n'autorise QUE le sens de l'ouverture de la connexion.** Le trafic retour est géré automatiquement par la table de sessions.
>
> Autrement dit : si tu veux que ton LAN accède à Internet, tu écris **une seule** politique `LAN → WAN`. Tu n'écris **jamais** la politique `WAN → LAN` correspondante. Si tu l'écris, non seulement elle est inutile, mais tu viens d'ouvrir un trou béant dans ton pare-feu.
>
> Le nombre de configurations d'entreprise que j'ai vues percées à cause de cette confusion est... élevé. 😐

On vérifiera cette table de sessions de nos propres yeux au **TP 12**. Pour l'instant, retiens juste la règle.

### 1.7 Le vocabulaire du métier

Voici les termes qui reviendront sans arrêt. Tu n'as pas besoin de les mémoriser maintenant — reviens à ce tableau quand tu bloques.

| Terme | Ce que ça veut dire, en français simple |
|---|---|
| **Interface** | Un port physique (ou logique) du pare-feu. `port1`, `port2`, `wan1`… |
| **Zone** | Un groupe d'interfaces qu'on traite comme une seule dans les règles |
| **Politique** (*policy*) | Une règle : « depuis ici, vers là, tel trafic, j'autorise ou je refuse » |
| **Objet** (*address object*) | Un nom donné à une adresse ou un réseau, pour l'utiliser dans les règles |
| **Service** | Un nom donné à un protocole + port. `HTTPS` = TCP/443 |
| **NAT** | La réécriture des adresses dans les paquets. Toute la section 10 |
| **Session** | Une conversation en cours, mémorisée par le pare-feu |
| **Profil de sécurité** (*UTM*) | L'inspection du contenu : antivirus, filtrage web, IPS… |
| **VDOM** | Un pare-feu virtuel à l'intérieur du pare-feu physique |
| **FortiOS** | Le système d'exploitation qui tourne sur le FortiGate |

### 1.8 📖 Le sais-tu ? Pourquoi « Forti » ?

Fortinet a été fondée en 2000 par les frères **Ken et Michael Xie**. Ken Xie avait auparavant créé NetScreen, l'un des premiers constructeurs à avoir mis du **matériel dédié** dans un pare-feu plutôt que de tout faire en logiciel.

Cette idée est restée l'ADN de Fortinet : les FortiGate physiques embarquent des puces maison appelées **ASIC** — les *FortiASIC*, dont les familles **NP** (*Network Processor*, pour accélérer le routage et le chiffrement) et **CP** (*Content Processor*, pour accélérer l'inspection de contenu).

Pourquoi je te raconte ça ? Parce que ça a une conséquence très concrète que tu rencontreras : sur un FortiGate physique, certaines sessions sont **déchargées** (*offloaded*) vers l'ASIC et ne remontent plus au processeur principal. Quand tu lanceras une capture de paquets pour diagnostiquer un problème, tu ne verras alors... rien du tout. Le trafic passe, mais il ne passe plus par là où tu regardes. On verra comment gérer ça en section 23.

Sur une VM — donc dans notre laboratoire — il n'y a pas d'ASIC, tout est logiciel, et ce piège n'existe pas. Tant mieux pour apprendre.

### 1.9 Ce qu'il faut avoir compris avant de continuer

Fais-toi un rapide auto-test. Si tu réponds à ces cinq questions, tu peux avancer sereinement :

1. Pourquoi deux PC du même sous-réseau ne sont-ils pas filtrés par le pare-feu ?
2. Qu'est-ce qu'une passerelle par défaut, et pourquoi le pare-feu est-il bien placé pour inspecter le trafic ?
3. Que signifie « pare-feu à états » ?
4. Si j'autorise `LAN → WAN`, dois-je aussi autoriser `WAN → LAN` pour que le web fonctionne ?
5. Quelle est la différence entre une interface et une zone ?

<details>
<summary>👉 Clique ici pour les réponses</summary>

1. Parce que leur trafic ne traverse jamais le pare-feu : elles sont dans le même quartier et se parlent directement via le switch, au niveau 2.
2. C'est l'équipement à qui une machine confie tout paquet destiné à un autre réseau. Comme **tout** le trafic inter-réseaux y passe, c'est le point d'observation idéal.
3. Que le pare-feu mémorise les conversations en cours dans une table de sessions, et reconnaît donc le trafic retour sans avoir besoin d'une règle pour lui.
4. **Non.** Surtout pas. Le retour est autorisé automatiquement par la table de sessions. Écrire la règle inverse serait un trou de sécurité.
5. Une interface est un port ; une zone est un groupe d'interfaces qu'on manipule comme un seul objet dans les règles, pour éviter d'écrire dix fois la même politique.

</details>

---

## 2. Qu'est-ce qu'un FortiGate exactement ?

Tu sais maintenant ce qu'est un pare-feu en général. Voyons ce qu'est **celui-là** en particulier, et surtout ce qui le distingue — parce que ces distinctions expliquent la façon dont on le configure.

### 2.1 FortiGate, FortiOS, Fortinet : qui est qui ?

Ces trois mots sont constamment confondus. Mettons-les au clair une bonne fois :

- **Fortinet** est l'entreprise. Elle vend des dizaines de produits dont le nom commence par *Forti*.
- **FortiGate** est le produit pare-feu. C'est une **boîte** (ou une machine virtuelle).
- **FortiOS** est le **système d'exploitation** qui tourne dedans. C'est lui que tu configures.

L'analogie qui marche : Fortinet est à Apple ce que FortiGate est à l'iPhone et FortiOS à iOS.

Ça a une conséquence pratique importante : **FortiOS est le même sur toute la gamme**. Le FortiGate à 400 € posé dans une agence et le châssis à 200 000 € d'un opérateur font tourner le *même* système, avec la *même* CLI et les *mêmes* commandes. Ce que tu apprends dans ce tutoriel sur une machine virtuelle s'applique tel quel sur n'importe quel modèle.

C'est une excellente nouvelle pour apprendre, et c'est assez rare dans l'industrie pour être signalé.

### 2.2 La gamme, en une image

Tu croiseras des noms de modèles ; voici comment les lire. Le principe est simple : **plus le nombre est grand, plus la machine est puissante**.

| Famille | Modèles typiques | Pour qui | Ordre de grandeur du débit |
|---|---|---|---|
| **Entrée de gamme** | FortiGate 40F, 50G, 60F, 70G, 90G | Télétravail, petite boutique, agence | 1 à 10 Gbit/s |
| **Milieu de gamme** | FortiGate 100F, 200G, 400F, 600F | PME, site principal d'une entreprise | 10 à 100 Gbit/s |
| **Haut de gamme** | FortiGate 1800F, 2600F, 3500F | Grande entreprise, datacenter | 100 Gbit/s et au-delà |
| **Châssis** | FortiGate 7000 series | Opérateur, très gros datacenter | Térabits |
| **Virtuel** | **FortiGate-VM** | Cloud, virtualisation… **et notre lab** | Ça dépend du CPU alloué |

La lettre finale indique la génération : `F` puis `G` sont les générations récentes. Un `60F` et un `60G` occupent la même place dans la gamme, le `G` étant simplement plus récent et plus rapide.

> 💡 **Astuce** : le modèle qu'on rencontre le plus souvent en formation et en petite entreprise est le **FortiGate 60F**. Si tu vois un tutoriel « pour 60F », il s'applique à tout le reste — voir §2.1.

### 2.3 Les versions de FortiOS : laquelle apprendre ?

C'est une vraie question, et beaucoup de tutoriels sur Internet ne se la posent pas — c'est pour ça qu'on y trouve encore des instructions pour des versions mortes depuis des années.

Au moment où j'écris ces lignes (2026), la situation est la suivante :

| Version | Statut | Commentaire |
|---|---|---|
| **8.0** | La plus récente | Sortie en 2026, support jusqu'en 2030 |
| **7.6** | Mature et largement déployée | Support jusqu'en janvier 2030 |
| **7.4** | Encore très répandue | Toujours supportée |
| **7.2** | En fin de vie | Support qui s'arrête en septembre 2026 |
| 7.0 et antérieures | **Mortes** | Plus aucun correctif de sécurité |

**Ce tutoriel cible FortiOS 7.6**, et voici pourquoi ce choix plutôt qu'un autre :

- C'est la version qu'on trouve le plus en production aujourd'hui, donc celle que tu rencontreras en entreprise ;
- Elle est supportée jusqu'en 2030, donc ce que tu apprends ne périmera pas dans six mois ;
- Elle contient déjà les grands changements récents (notamment sur les VPN, voir §2.6), donc tu n'apprends pas des choses à désapprendre.

Si tu es sur 7.4 ou 8.0, **99 % de ce document s'applique tel quel**. Je signale explicitement les rares endroits où la version compte, comme ceci :

> ⚠️ **Différence de version** : cette commande n'existe qu'à partir de 7.6.

> 🚨 **Danger — ne travaille jamais sur une version morte**
> Si tu hérites d'un FortiGate en 6.4 ou 7.0 dans une entreprise, ce n'est pas un détail administratif : ces versions ne reçoivent **plus aucun correctif de sécurité**. Or les FortiGate sont une cible de choix, et plusieurs vulnérabilités critiques les concernant ont été activement exploitées ces dernières années. Un pare-feu non corrigé n'est pas un pare-feu ; c'est une porte d'entrée avec un logo dessus. Planifier la mise à jour fait partie du travail — on verra comment en section 24.

### 2.4 NGFW, UTM : deux mots pour presque la même chose

Tu vas voir ces deux sigles partout dans la documentation Fortinet, souvent dans la même phrase. Voici la distinction :

- **UTM** (*Unified Threat Management*) est le terme historique. Il veut dire : « une seule boîte qui fait tout » — pare-feu, antivirus, filtrage web, antispam, VPN — au lieu de cinq boîtiers différents. C'est le marché sur lequel Fortinet s'est construit.
- **NGFW** (*Next-Generation Firewall*) est le terme moderne. Il insiste sur la capacité à reconnaître les **applications** et les **utilisateurs**, pas seulement les ports.

En pratique, sur un FortiGate, les deux mots désignent la même chose : les **profils de sécurité** de la partie V de ce tutoriel. Tu verras d'ailleurs le mot « UTM » directement dans la CLI et dans les journaux — Fortinet ne l'a jamais abandonné.

### 2.5 🧠 Comprendre : pourquoi le port ne suffit plus

Voici l'idée qui justifie à elle seule l'existence des NGFW. Prends le temps, elle vaut le détour.

Un pare-feu classique raisonne en **ports**. Le port 443, c'est HTTPS, donc du web, donc on l'autorise — sinon plus personne ne travaille.

Sauf que sur le port 443 passent aujourd'hui :

- le site de ta banque ;
- l'intranet de ton entreprise ;
- Facebook, YouTube, TikTok ;
- Dropbox, WeTransfer et n'importe quel service d'exfiltration de fichiers ;
- des tunnels VPN grand public qui contournent tous tes filtres ;
- et le canal de commande d'un logiciel malveillant déjà installé sur un poste.

**Tout ça sur le même port, avec la même apparence.** « Autoriser le 443 » ne veut donc plus rien dire en termes de sécurité. C'est comme autoriser « tout ce qui roule sur la route » : techniquement exact, opérationnellement vide.

Un NGFW regarde **ce qu'il y a dans le paquet** plutôt que le numéro de porte par lequel il entre. Il peut alors dire : « le port 443 est ouvert, mais l'application *BitTorrent* est refusée, la catégorie *Jeux d'argent* est bloquée, et l'utilisateur *stagiaire* n'a pas le droit d'uploader sur Dropbox ».

C'est exactement ce qu'on construira dans la partie V.

### 2.6 ⚠️ Le grand changement à connaître : la fin du SSL VPN tunnel

Il faut que je te prévienne tout de suite, parce que c'est le point sur lequel **la quasi-totalité des tutoriels que tu trouveras sur Internet est périmée**, et que tu vas perdre des heures si tu ne le sais pas.

Pendant quinze ans, la façon standard de connecter un télétravailleur à son entreprise avec un FortiGate a été le **SSL VPN en mode tunnel** : l'utilisateur lançait FortiClient, se connectait en HTTPS sur le pare-feu, et obtenait un accès au réseau interne. C'est ce que décrivent des milliers de pages de blog, de vidéos et de cours.

**Ce n'est plus vrai.**

| Version | Ce qui se passe |
|---|---|
| **7.6.0** | SSL VPN (mode web et tunnel) **retiré** des modèles à 2 Go de RAM ou moins, et des modèles G d'entrée de gamme (50G, 70G, 90G…) |
| **7.6.3 et au-delà** | SSL VPN **mode tunnel retiré de TOUS les modèles**, remplacé par IPsec |

La solution officielle de remplacement est le **VPN IPsec en mode dial-up**, qui peut être configuré pour écouter sur le **port TCP 443** — précisément pour traverser les réseaux d'hôtel et de café qui ne laissent sortir que le web, ce qui était le principal argument du SSL VPN.

> 🚨 **Si tu administres un parc en production**
> La migration doit être faite **AVANT** de monter en 7.6.3, pas après. Si tu mets à jour un pare-feu dont les télétravailleurs dépendent du SSL VPN tunnel, ils se retrouvent tous dehors, et toi avec s'il s'agit de ton accès distant. C'est un cas classique de panne auto-infligée un vendredi soir.

**Conséquence pour ce tutoriel** : la section 18 t'apprendra l'accès distant en **IPsec dial-up**, pas en SSL VPN. C'est plus long à configurer, c'est moins bien documenté sur le web, et c'est la seule chose qui a un avenir. On fera l'effort.

### 2.7 Le modèle de licences, expliqué sans langue de bois

Sujet ingrat mais indispensable, parce qu'il explique pourquoi certaines fonctions ne marcheront pas dans ton laboratoire.

Sur un FortiGate, il y a deux choses distinctes :

**1. Le matériel et FortiOS.** Tu les achètes une fois. Le pare-feu fonctionne pour toujours : routage, politiques, NAT, VPN, journaux. Tout ce qui est dans les parties I à IV et VI à IX de ce tutoriel fonctionne **sans aucun abonnement**.

**2. Les abonnements FortiGuard.** Ce sont les **bases de connaissances** mises à jour en permanence par Fortinet : signatures antivirus, signatures IPS, catégories de sites web, base d'applications. Sans abonnement actif, ces bases ne se mettent plus à jour — et une signature antivirus de l'an dernier ne sert pas à grand-chose.

| Ce que tu veux faire | Abonnement nécessaire ? |
|---|---|
| Filtrer par IP, port, interface | ❌ Non |
| Faire du NAT | ❌ Non |
| Monter un VPN IPsec | ❌ Non |
| Faire du routage OSPF/BGP, du SD-WAN, de la HA | ❌ Non |
| Antivirus, IPS | ✅ Oui |
| Filtrage web par catégorie | ✅ Oui |
| Contrôle applicatif | ✅ Oui |

> 💡 **Astuce pour le laboratoire** : les fonctions FortiGuard qu'on verra en partie V se configureront quand même — tu apprendras les commandes et la logique — mais elles ne bloqueront rien de réel sans abonnement, et le pare-feu affichera un avertissement de licence expirée. Je te le rappellerai au moment venu. Tout le reste du tutoriel fonctionne à 100 % dans un lab gratuit.

### 2.8 La Security Fabric, en deux minutes

Tu vas voir ce terme partout dans l'interface, alors autant savoir ce que c'est.

La **Security Fabric** est le nom que Fortinet donne à l'idée de faire **coopérer** ses produits : le FortiGate parle au FortiSwitch, qui parle au FortiAP (borne Wi-Fi), qui parle au FortiClient sur le poste, le tout supervisé par un FortiAnalyzer.

Concrètement, ça permet des choses comme : un poste est détecté compromis par le FortiClient → l'information remonte au FortiGate → qui demande au FortiSwitch de mettre le port en quarantaine. Trois équipements, une seule décision.

C'est une vraie force commerciale de Fortinet, et c'est hors du périmètre de ce tutoriel : on se concentre sur le FortiGate seul, qui est déjà largement de quoi occuper 5 000 lignes. 😄 Sache simplement que le bandeau « Security Fabric » de l'interface, c'est ça.

### 2.9 Les deux façons de configurer un FortiGate

Il y en a deux, et **il faut connaître les deux**. Ce n'est pas une préférence de style :

**L'interface web (GUI)**
- ✅ Visuelle, on découvre les fonctions en se promenant, parfaite pour apprendre
- ✅ Les assistants (VPN, SD-WAN) font en trois clics ce qui prend vingt lignes en CLI
- ❌ **Certaines options n'y sont tout simplement pas.** C'est le point crucial.

**La ligne de commande (CLI)**
- ✅ **Accès à 100 % des paramètres** — la GUI n'expose qu'un sous-ensemble
- ✅ Scriptable, copiable-collable, sauvegardable en texte
- ✅ C'est le langage de la documentation, des forums et du support Fortinet
- ❌ Il faut connaître le chemin des commandes

> ⚠️ **Attention** : ce déséquilibre est réel et il te surprendra. Il t'arrivera de chercher une case à cocher qui n'existe pas dans l'interface, alors que l'option existe bel et bien en CLI. C'est normal, c'est assumé par Fortinet, et c'est la raison principale pour laquelle **ce tutoriel privilégie la CLI**.
>
> Je donnerai systématiquement le chemin GUI quand il existe, parce que c'est utile pour se repérer. Mais la référence, ce sera toujours la commande.

### 2.10 Ce qu'on va construire ensemble

Pour te donner un cap, voici l'infrastructure qu'on aura montée à la fin de ce document :

```
                          Internet (simulé)
                                 │
                          ┌──────┴──────┐
                          │   FGT-01    │  ← ton pare-feu principal
                          │  FortiOS 7.6│
                          └──┬───┬───┬──┘
                   ┌─────────┘   │   └─────────┐
                   │             │             │
            ┌──────┴─────┐ ┌─────┴────┐ ┌──────┴─────┐
            │    LAN     │ │   DMZ    │ │   VPN IPsec│
            │ Utilisateurs│ │ Serveurs│ │  ↔ Site B  │
            └────────────┘ └──────────┘ └────────────┘
```

Avec, dessus :
- des politiques de sécurité propres et journalisées ;
- du NAT sortant et un serveur publié depuis Internet ;
- un serveur DHCP et une résolution DNS ;
- des profils de sécurité (antivirus, filtrage web, contrôle applicatif, IPS) ;
- de l'inspection SSL ;
- des utilisateurs authentifiés ;
- un tunnel IPsec vers un site distant et un accès télétravailleur ;
- du routage dynamique, du SD-WAN et un cluster haute disponibilité ;
- et surtout : la capacité à **diagnostiquer** tout ça quand ça ne marche pas.

On y va ? La section suivante monte le laboratoire. 🚀

---

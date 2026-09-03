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
15. [⭐ Routeur + ACL contre pare-feu : la démonstration](#15--routeur--acl-contre-pare-feu--la-démonstration)
16. [L'inspection SSL/TLS](#16-linspection-ssltls)

### Partie VI — Les utilisateurs
17. [Authentification et gestion des utilisateurs](#17-authentification-et-gestion-des-utilisateurs)

### Partie VII — Les VPN
18. [VPN IPsec site-à-site](#18-vpn-ipsec-site-à-site)
19. [Accès distant : IPsec dial-up](#19-accès-distant--ipsec-dial-up)

### Partie VIII — Aller plus loin
20. [Le routage dynamique](#20-le-routage-dynamique)
21. [SD-WAN](#21-sd-wan)
22. [La haute disponibilité](#22-la-haute-disponibilité)

### Partie IX — L'exploitation au quotidien
23. [Journaux, FortiView et supervision](#23-journaux-fortiview-et-supervision)
24. [Diagnostic et dépannage](#24-diagnostic-et-dépannage)
25. [Sauvegarde, mise à jour et durcissement](#25-sauvegarde-mise-à-jour-et-durcissement)
26. [Les erreurs classiques](#26-les-erreurs-classiques)
27. [Aide-mémoire : toutes les commandes](#27-aide-mémoire--toutes-les-commandes)
28. [Conclusion et pour aller plus loin](#28-conclusion-et-pour-aller-plus-loin)

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

> 🖥️ **Tous les TP de ce tutoriel se font en CLI**, sans exception : par SSH
> depuis un poste du laboratoire, ou par la console. La seule chose qui
> demande encore un navigateur est l'enregistrement de la licence sur
> FortiCare (§4.4), et c'est le site de Fortinet — pas le pare-feu. Même les
> manipulations qu'on décrit d'habitude « avec la souris » — se connecter au
> portail captif, provoquer une panne de cluster, vérifier l'accès
> d'administration — ont ici leur forme en ligne de commande, et c'est
> délibéré : c'est ce qui rend un TP rejouable, scriptable et vérifiable.

### 2.10 « Mais un routeur fait déjà tout ça, non ? »

C'est la question qu'on te posera le jour où tu proposeras d'acheter un pare-feu. Elle vient parfois d'un directeur financier, souvent d'un collègue, et elle est **légitime** — parce qu'en apparence, un routeur Cisco moderne sait déjà :

- router entre les réseaux ✅
- faire du NAT ✅
- filtrer avec des **ACL** (*Access Control Lists*) ✅
- journaliser ✅
- monter des VPN IPsec ✅

Cinq fonctions sur les cinq qu'on attend d'un pare-feu. Alors, où est la différence ?

**Elle est réelle, elle est profonde, et elle tient en quatre points.**

**① Une ACL classique n'a pas de mémoire**

Une ACL standard ou étendue examine **chaque paquet isolément**. Elle ne sait pas qu'un paquet est la réponse à une requête sortante, parce qu'elle ne se souvient de rien.

Conséquence directe : pour laisser tes utilisateurs naviguer, tu dois autoriser le trafic **entrant** correspondant. Et comme tu ne peux pas prédire quels ports sources ils utiliseront, tu finis par écrire quelque chose comme « autoriser tout le TCP entrant vers les ports hauts ». Ce qui, dit autrement, revient à **laisser une porte ouverte en permanence**.

Un pare-feu à états, lui, se souvient (§1.6) : une seule règle sortante, et le retour est reconnu.

**② Une ACL ne voit que des ports, jamais des applications**

C'est tout l'argument du §2.5. Une ACL qui autorise le port 443 autorise **tout** ce qui passe par le 443 : ta banque comme le tunnel de contournement d'un utilisateur, comme le canal de commande d'un logiciel malveillant. Elle n'a aucun moyen de les distinguer, parce qu'elle ne regarde pas à l'intérieur.

**③ Une ACL ne regarde jamais le contenu**

Un routeur ne saura **jamais** te dire qu'un fichier téléchargé contient un virus, qu'une page est un site d'hameçonnage, ou qu'une requête est une tentative d'injection SQL. Ce n'est pas une faiblesse de configuration : il n'a ni les signatures, ni le moteur d'analyse, ni la puissance de calcul pour le faire.

**④ Une ACL ne sait pas qui tu es**

Une règle de routeur parle d'adresses IP. Elle ne sait pas que `192.168.10.47` est le poste d'un stagiaire plutôt que celui du directeur financier — et si les deux permutent de bureau, la règle protège la mauvaise personne. Un pare-feu sait raisonner en **utilisateurs** et en **groupes** (section 16).

**Le tableau qui résume :**

| Capacité | Routeur + ACL | Pare-feu NGFW |
|---|---|---|
| Filtrer par IP et par port | ✅ | ✅ |
| **Suivre l'état d'une connexion** | ❌ | ✅ |
| Reconnaître l'application | ❌ | ✅ |
| Analyser le contenu (antivirus) | ❌ | ✅ |
| Filtrer par catégorie de site | ❌ | ✅ |
| Détecter une intrusion (IPS) | ❌ | ✅ |
| Raisonner en **utilisateurs** | ❌ | ✅ |
| Déchiffrer le TLS pour inspecter | ❌ | ✅ |
| Journaliser un trafic **compréhensible** | ⚠️ Sommaire | ✅ |

> ⚠️ **Attention — ne jette pas le routeur pour autant**
> La conclusion n'est PAS « le routeur ne sert à rien ». Les deux équipements **coexistent** dans toutes les architectures sérieuses, et chacun fait ce qu'il fait le mieux :
>
> - Le **routeur** achemine à très grande vitesse, gère les protocoles de routage vers l'opérateur, et absorbe la première vague de bruit avec des ACL grossières.
> - Le **pare-feu** applique la politique de sécurité, comprend les applications, inspecte le contenu et sait qui est l'utilisateur.
>
> Mettre une ACL sur le routeur de bordure **reste une bonne pratique** : elle élimine à moindre coût le trafic manifestement illégitime avant qu'il n'atteigne le pare-feu, qui a mieux à faire.

> 💡 **Une nuance honnête, parce qu'elle existe**
> Cisco propose des ACL **réflexives** (`reflect`/`evaluate`), le **CBAC** et surtout **Zone-Based Firewall** (ZBF), qui ajoutent une vraie gestion d'état à IOS. Ce n'est donc pas « Cisco ne sait pas faire de pare-feu » — Cisco vend d'ailleurs des pare-feux, les ASA et Firepower.
>
> Ce qui reste vrai malgré ces mécanismes : **l'inspection de contenu, la reconnaissance applicative et l'identité utilisateur ne sont pas dans un routeur**, et le prix de la fonction de pare-feu sur un routeur généraliste s'effondre en performance dès qu'on l'active sérieusement.
>
> On mesurera tout ça de nos propres mains à la **section 15**. Je ne te demande pas de me croire sur parole : on va essayer de protéger le réseau avec R1 seul, et regarder précisément ce qui casse.

### 2.11 Ce qu'on va construire ensemble

Pour te donner un cap, voici l'infrastructure qu'on aura montée à la fin de ce document :

```
                          Internet (simulé)
                                 │
                          ╔══════┴══════╗
                          ║   R1-EDGE   ║  ← routeur Cisco de bordure
                          ║  Cisco IOS  ║     (la passerelle par défaut)
                          ╚══════╤══════╝
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
- **la démonstration, chiffres en main, de ce que le routeur seul ne sait pas faire** ;
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

## 3. Monter ton laboratoire

C'est ici que le tutoriel devient concret. À la fin de cette section, tu auras un FortiGate qui tourne devant toi et sur lequel tu pourras taper des commandes. Tout le reste du document en dépend.

Je vais être franc avec toi dès le départ : **monter un lab FortiGate est plus pénible que monter un lab Cisco**. Il n'existe pas d'équivalent gratuit et libre de Packet Tracer. Mais c'est parfaitement faisable, et je vais te donner les vraies options avec leurs vrais défauts, pas la version marketing.

### 3.1 Les quatre façons d'avoir un FortiGate

| Option | Coût | Réalisme | Difficulté | Verdict |
|---|---|---|---|---|
| **A. FortiGate-VM + licence d'évaluation** | Gratuit | Excellent (vrai FortiOS) | Moyenne | ⭐ **Recommandé pour ce tutoriel** |
| **B. Boîtier physique d'occasion** | 50 à 200 € | Parfait | Faible | Idéal si tu peux investir |
| **C. Labs de la Fortinet Training Institute** | Gratuit | Excellent | Nulle | Excellent, mais temps limité |
| **D. Le pare-feu de ton employeur** | — | Parfait | — | 🚨 **Non.** Voir l'encadré |

> 🚨 **Danger — ne t'entraîne JAMAIS sur un équipement de production**
> Ça paraît évident écrit noir sur blanc, et pourtant. Une commande dans ce tutoriel te fera volontairement couper un accès pour observer ce qui se passe ; une autre te fera vider une table de sessions. Sur un pare-feu de production, ça veut dire une entreprise à l'arrêt et, très concrètement, ton emploi.
>
> Si ton employeur possède des FortiGate, demande un **boîtier de rechange** ou une VM de test. C'est une demande normale et bien vue : un administrateur qui veut s'entraîner ailleurs qu'en production est exactement le genre d'administrateur qu'on veut garder.

Je détaille l'option A, qui est celle du tutoriel.

### 3.2 Option A : la FortiGate-VM, et la vérité sur sa licence

C'est la voie gratuite. Fortinet fournit une image de machine virtuelle utilisable avec une **licence d'évaluation permanente** — elle n'expire jamais, ce qui est une excellente nouvelle.

Mais elle est bridée, et **il faut connaître ces limites avant de commencer**, sinon tu vas te heurter à un mur au milieu d'un TP sans comprendre pourquoi :

| Ressource | Limite de la licence d'évaluation |
|---|---|
| Processeurs | **1 vCPU** |
| Mémoire | **2 Gio** |
| Interfaces réseau | **3 maximum** |
| **Politiques de sécurité** | **3 maximum** ⚠️ |
| Routes | **3 maximum** ⚠️ |
| Chiffrement | Faible uniquement (*low encryption*) |
| VDOM | 2 maximum |
| Support Fortinet | Aucun |

> ⚠️ **Attention — la limite qui va te gêner**
> **Trois politiques de sécurité et trois routes.** C'est très peu. Dès la section 9, on écrira plus de trois règles.
>
> Ce n'est pas rédhibitoire, mais il faut le savoir et s'organiser. Je te donne la stratégie en §3.3.

> ⚠️ **La deuxième surprise : pas de HTTPS d'administration**
> La licence d'évaluation ne permet que le *chiffrement faible*, ce qui a une conséquence directe et déroutante : **l'accès HTTPS à l'interface d'administration ne fonctionne pas**. Tu devras administrer en **HTTP** (et en SSH pour la CLI).
>
> Dans un lab isolé, c'est sans danger. En production, ce serait une faute grave — mais en production tu as une vraie licence, et le problème ne se pose pas. Je te le signale simplement pour que tu ne passes pas deux heures à croire que ton installation est ratée parce que `https://192.168.1.99` ne répond pas.

### 3.3 🧠 Comprendre : comment vivre avec 3 politiques

Puisque la limite existe, autant en faire une leçon plutôt qu'un obstacle. Trois stratégies, dans l'ordre où je te conseille de les employer :

**Stratégie 1 — Nettoyer au fur et à mesure (celle du tutoriel)**
À la fin de chaque TP, je te dirai quelles politiques supprimer avant de passer au suivant. C'est un peu frustrant, mais ça a une vertu pédagogique réelle : **ça t'oblige à savoir exactement ce que fait chacune de tes règles**. Un administrateur qui accumule 200 politiques sans jamais en supprimer une est un administrateur dont le pare-feu est devenu incompréhensible. La contrainte t'apprend l'hygiène.

**Stratégie 2 — Utiliser des groupes**
Une seule politique peut référencer un **groupe d'adresses** contenant dix réseaux et un **groupe de services** contenant huit protocoles. Tu obtiens la couverture de dix règles en une seule. C'est d'ailleurs une bonne pratique en production, pas seulement une astuce de lab — on l'apprendra en section 8.

**Stratégie 3 — Acheter un boîtier d'occasion**
Un FortiGate 60E ou 60F d'occasion se trouve autour de 50 à 150 €. Sans abonnement FortiGuard actif, il ne fera ni antivirus ni filtrage web à jour, mais **toutes les autres limites disparaissent** : autant de politiques, de routes et d'interfaces que tu veux, HTTPS d'administration, chiffrement fort. Pour qui veut vraiment apprendre le métier, c'est le meilleur rapport qualité-prix du marché.

> 💡 **Astuce** : si tu vises la certification Fortinet (NSE 4 / FCP), le boîtier d'occasion est un investissement qui se rentabilise. La certification comporte des questions qu'on ne comprend vraiment qu'en ayant manipulé.

### 3.4 Choisir son hyperviseur

La FortiGate-VM existe pour à peu près tout. Voici comment choisir selon ce que tu as :

| Hyperviseur | Format d'image | Gratuit ? | Mon avis |
|---|---|---|---|
| **VMware Workstation / Fusion** | `.ovf` | Version Player gratuite | ⭐ Le plus simple pour débuter |
| **VirtualBox** | `.ovf` (à convertir) | Oui | Fonctionne, réseau un peu capricieux |
| **Proxmox VE** | `.qcow2` | Oui | ⭐ Excellent si tu as un serveur dédié |
| **KVM / libvirt** | `.qcow2` | Oui | Parfait sous Linux |
| **Hyper-V** | `.vhd` | Inclus dans Windows Pro | Correct |
| **EVE-NG / GNS3** | `.qcow2` | Version communautaire | ⭐⭐ **Le meilleur pour les gros labs** |

> 💡 **Astuce** : si tu comptes faire les sections avancées (17 à 21 : VPN site-à-site, SD-WAN, haute disponibilité), tu auras besoin de **plusieurs FortiGate en même temps**. **EVE-NG** ou **GNS3** sont alors nettement plus confortables, parce qu'ils gèrent le câblage entre machines virtuelles de façon graphique. Avec VMware, tu devras créer des réseaux virtuels à la main, ce qui est faisable mais fastidieux.
>
> Pour les sections 1 à 16, une simple VMware Workstation suffit largement. Commence par là.

### 3.5 Récupérer l'image

L'image ne se télécharge pas librement : il faut un compte.

1. **Crée un compte gratuit** sur le portail Fortinet (`support.fortinet.com`). Un compte « FortiCare » gratuit suffit, il ne demande pas de contrat d'achat.
2. Va dans **Support → VM Images**.
3. Choisis le produit **FortiGate**, la plateforme (VMware ESXi, KVM, Hyper-V…) et la version **7.6**.
4. Télécharge l'archive et décompresse-la.

> 💡 **Astuce** : pour VMware Workstation, prends l'image « VMware ESXi » — le format `.ovf` s'importe très bien dans Workstation malgré son nom.

> ⚠️ **Attention** : télécharge la version **7.6.x la plus récente** disponible. Les correctifs de sécurité comptent, même en lab, et tu prendras l'habitude de regarder le numéro de version — c'est un réflexe professionnel.

### 3.6 La topologie du laboratoire

Voici ce qu'on va monter. Garde ce schéma sous la main, on y reviendra à chaque section.

```
                    ┌─────────────────────┐
                    │   « Internet »      │
                    │  (ta box / le NAT   │
                    │   de l'hyperviseur) │
                    └──────────┬──────────┘
                               │ Gi0/0  (DHCP)
                    ╔══════════┴══════════╗
                    ║      R1-EDGE        ║   ← ⭐ routeur Cisco
                    ║   Cisco IOS         ║      routeur de bordure
                    ║   ACL + NAT         ║      ET passerelle par défaut
                    ╚══════════╤══════════╝
                               │ Gi0/1 — 192.168.100.1/24
                               │
                               │  « le lien de transit »
                               │
                          port1 (WAN)
                          192.168.100.99/24
                    ┌──────────┴──────────┐
                    │                     │
                    │      FGT-01         │
                    │   FortiOS 7.6.x     │
                    │                     │
                    └───┬─────────────┬───┘
                 port2 (LAN)      port3 (DMZ)
              192.168.10.1/24   192.168.20.1/24
                    │                 │
            ┌───────┴──────┐   ┌──────┴───────┐
            │   PC-LAN     │   │  SRV-DMZ     │
            │ Linux ou Win │   │ Linux + web  │
            │192.168.10.10 │   │192.168.20.10 │
            └──────────────┘   └──────────────┘
```

> 🧠 **Pourquoi un routeur Cisco DEVANT le pare-feu ?**
> Ce n'est pas de la décoration, et ce n'est pas non plus une lubie : **c'est la topologie réelle de la quasi-totalité des entreprises**. On ne branche presque jamais un pare-feu directement sur la fibre — il y a un routeur de bordure devant, souvent fourni par l'opérateur, souvent un Cisco.
>
> Mais surtout, ce routeur va nous servir de **contre-exemple pédagogique**. Il sait router. Il sait faire du NAT. Il sait filtrer avec des **ACL**. Bref, il ressemble beaucoup à un pare-feu.
>
> Alors pourquoi dépenser plusieurs milliers d'euros de plus pour un FortiGate derrière ? C'est **la** question que tout décideur pose, et c'est celle à laquelle tu dois savoir répondre. On ne va pas y répondre par un argumentaire commercial : on va **le démontrer en laboratoire**, à la section 15, en essayant de protéger le réseau avec R1 seul et en constatant précisément où ça casse.
>
> Retiens dès maintenant le principe : **R1 est ce que tu aurais SANS pare-feu.** C'est notre point de comparaison.

### 3.7 Le plan d'adressage

| Réseau | Sous-réseau | Rôle | Qui porte quoi |
|---|---|---|---|
| Internet | variable (DHCP) | Sortie réelle | `R1 Gi0/0` |
| **Transit** | 192.168.100.0/24 | Lien R1 ↔ pare-feu | `R1 Gi0/1` = .1 — `FGT port1` = .99 |
| LAN | 192.168.10.0/24 | Postes utilisateurs | `FGT port2` — 192.168.10.1 |
| DMZ | 192.168.20.0/24 | Serveurs publiés | `FGT port3` — 192.168.20.1 |

| Machine | Adresse | Passerelle | Rôle |
|---|---|---|---|
| **R1-EDGE** | Gi0/0 en DHCP, Gi0/1 = 192.168.100.1 | celle de ta box | ⭐ Routeur de bordure Cisco — **la passerelle par défaut du pare-feu** |
| FGT-01 | port1 = 192.168.100.99 | **192.168.100.1 (R1)** | Le pare-feu |
| PC-LAN | 192.168.10.10/24 | 192.168.10.1 | Poste de test côté interne |
| SRV-DMZ | 192.168.20.10/24 | 192.168.20.1 | Serveur web de test |

> 💡 **Astuce — pourquoi un réseau de « transit » ?**
> Le `192.168.100.0/24` entre R1 et le pare-feu ne contient aucun utilisateur : il ne sert qu'à faire dialoguer les deux équipements. On appelle ça un **réseau de transit**, et en production on lui donne souvent un `/30` (deux adresses utilisables, §1.2), parce qu'il n'y aura jamais que deux machines dessus.
>
> Je garde un `/24` ici uniquement pour que tu puisses y brancher facilement une troisième machine servant d'« attaquant externe » lors des TP de la section 15.

> 🧠 **Comprendre : pourquoi une DMZ ?**
> **DMZ** signifie *zone démilitarisée*. C'est un troisième réseau, ni tout à fait dedans ni tout à fait dehors, où l'on place les serveurs **accessibles depuis Internet** : site web, serveur de messagerie, VPN.
>
> Pourquoi ne pas les mettre simplement dans le LAN ? Parce qu'un serveur exposé à Internet est un serveur qui **finira par être compromis** — c'est une question de temps, pas de compétence. La DMZ répond à la question « et après ? » : quand l'attaquant prend le contrôle du serveur web, il se retrouve dans un réseau d'où il **ne peut pas atteindre** les postes de travail ni la comptabilité, parce que le pare-feu l'en empêche.
>
> La DMZ ne protège pas le serveur. Elle protège **tout le reste** du serveur. C'est une nuance essentielle, et on la matérialisera concrètement au TP 9.

### 3.8 Comment obtenir le routeur Cisco

Le FortiGate se télécharge (§3.5). Pour le Cisco, tu as **quatre voies**, et il n'est pas obligatoire de dépenser un centime.

| Voie | Coût | Réalisme | Commentaire |
|---|---|---|---|
| **A. EVE-NG / GNS3 + image IOSv ou CSR1000v** | Gratuit (l'image demande un compte Cisco) | ⭐ Parfait | La meilleure option si tu montes déjà ton lab là |
| **B. Routeur Cisco d'occasion** (1841, 2811, 2901…) | 20 à 80 € | Parfait | Un 2811 se trouve pour le prix d'un repas |
| **C. Cisco Packet Tracer** | Gratuit | ⚠️ Limité | Ne se connecte pas à de vraies VM — voir ci-dessous |
| **D. Un substitut Linux (VyOS, FRR, ou Debian)** | Gratuit | ⭐ Suffisant | ⭐ **Recommandé si tu n'as pas d'IOS** |

> ⚠️ **Attention à Packet Tracer** : il est excellent pour apprendre IOS, mais c'est un simulateur **fermé** — il ne peut pas parler à ta FortiGate-VM. Tu ne pourras donc pas faire les TP de bout en bout avec. Garde-le pour t'entraîner aux commandes IOS séparément.

> 💡 **Astuce — si tu n'as pas d'image Cisco, ne bloque pas ici**
> Tout ce qu'on demande à R1, c'est de **router**, de faire du **NAT** et de porter une **ACL**. N'importe quel routeur Linux le fait. Je donnerai systématiquement les commandes IOS **et** leur équivalent Linux, pour que personne ne reste sur le bord de la route.
>
> La démonstration de la section 15 — « pourquoi une ACL ne suffit pas » — fonctionne **à l'identique** avec un routeur Linux, parce que le problème n'est pas propre à Cisco : il est propre au **concept même d'ACL sans état**. C'est justement ce qui rend la leçon universelle.

**La configuration de base de R1** (on la posera au TP 1) :

```cisco
R1# configure terminal
R1(config)# hostname R1-EDGE

! L'interface vers Internet — DHCP depuis ta box
R1-EDGE(config)# interface GigabitEthernet0/0
R1-EDGE(config-if)# ip address dhcp
R1-EDGE(config-if)# ip nat outside
R1-EDGE(config-if)# no shutdown
R1-EDGE(config-if)# exit

! L'interface vers le pare-feu — le réseau de transit
R1-EDGE(config)# interface GigabitEthernet0/1
R1-EDGE(config-if)# ip address 192.168.100.1 255.255.255.0
R1-EDGE(config-if)# ip nat inside
R1-EDGE(config-if)# no shutdown
R1-EDGE(config-if)# exit

! Les routes vers les réseaux qui vivent DERRIÈRE le pare-feu
R1-EDGE(config)# ip route 192.168.10.0 255.255.255.0 192.168.100.99
R1-EDGE(config)# ip route 192.168.20.0 255.255.255.0 192.168.100.99

! Le NAT vers Internet
R1-EDGE(config)# access-list 10 permit 192.168.0.0 0.0.255.255
R1-EDGE(config)# ip nat inside source list 10 interface GigabitEthernet0/0 overload
R1-EDGE(config)# end
R1-EDGE# write memory
```

> 🧠 **Comprendre les deux routes statiques**
> R1 connaît directement `192.168.100.0/24` — il a une patte dessus. Mais `192.168.10.0/24` et `192.168.20.0/24` sont **derrière** le pare-feu : R1 n'a aucun moyen de les deviner.
>
> Sans ces deux routes, tout **sortirait** correctement (le LAN vers Internet passe par le pare-feu qui fait du NAT), mais rien ne pourrait **revenir** vers ces réseaux — et surtout, R1 ne pourrait jamais joindre le serveur de la DMZ que nous publierons au TP 8.
>
> C'est le rappel du §7.1 : **une route par réseau qui n'est pas directement connecté**, sinon le paquet meurt.

**L'équivalent sous Linux**, si tu utilises un substitut (Debian, par exemple) :

```bash
root@r1-edge:~# echo 1 > /proc/sys/net/ipv4/ip_forward
root@r1-edge:~# ip addr add 192.168.100.1/24 dev eth1
root@r1-edge:~# ip link set eth1 up
root@r1-edge:~# ip route add 192.168.10.0/24 via 192.168.100.99
root@r1-edge:~# ip route add 192.168.20.0/24 via 192.168.100.99
root@r1-edge:~# iptables -t nat -A POSTROUTING -s 192.168.0.0/16 -o eth0 -j MASQUERADE
```

### 3.9 Les besoins matériels de ta machine

Sois réaliste avant de commencer :

| Ce que tu veux faire | RAM totale | Disque | Processeur |
|---|---|---|---|
| Sections 1 à 17 (1 FortiGate + R1 + 2 PC) | **8 Gio** | 40 Gio | 4 cœurs |
| Sections 18 à 19 (2 FortiGate, VPN) | **12 Gio** | 60 Gio | 4 cœurs |
| Sections 20 à 22 (3 FortiGate, HA) | **16 Gio** | 80 Gio | 6 cœurs |

> 💡 **Astuce** : R1 est très peu gourmand. Un IOSv sous EVE-NG demande 512 Mio, un routeur Debian minimal 256 Mio. Ne le compte pas comme une charge sérieuse.

> 💡 **Astuce pour économiser la RAM** : les « PC » du laboratoire n'ont pas besoin d'être des postes complets. Une VM **Alpine Linux** (128 Mio de RAM) ou une **Debian sans interface graphique** (256 Mio) suffit amplement — tu n'as besoin que de `ping`, `curl` et `ip`. Réserve la mémoire pour les FortiGate, qui en ont réellement besoin.
>
> Un conteneur peut même faire l'affaire si ton hyperviseur le permet.

---

### 🧪 TP 1 — Installer et démarrer ton premier FortiGate

**🎯 Objectif**
Faire tourner une FortiGate-VM, se connecter à sa console, définir un mot de passe et vérifier la version. À la fin, tu auras un pare-feu vivant.

**⏱️ Durée** : 30 à 45 minutes (dont le téléchargement)

**📋 Prérequis**
- Un hyperviseur installé (VMware Workstation Player fait très bien l'affaire)
- L'image FortiGate-VM 7.6 téléchargée et décompressée (§3.5)
- Un routeur pour R1 : IOS, boîtier d'occasion ou substitut Linux (§3.8)
- 4 Gio de RAM disponibles

---

**🔧 Manipulation**

**Étape 0 — Monter R1, la passerelle**

On commence par le routeur, parce que c'est **lui** qui donnera l'accès Internet au pare-feu. Applique la configuration du §3.8, puis vérifie les trois points qui comptent :

```cisco
R1-EDGE# show ip interface brief
```
```
Interface              IP-Address       OK? Method Status      Protocol
GigabitEthernet0/0     192.168.1.42     YES DHCP   up          up
GigabitEthernet0/1     192.168.100.1    YES manual up          up
```

```cisco
R1-EDGE# ping 8.8.8.8
R1-EDGE# show ip route
```

> ⚠️ **Attention** : si `Gi0/0` reste en `administratively down`, il te manque un `no shutdown`. C'est l'oubli numéro un sur IOS — Cisco démarre ses interfaces éteintes, contrairement à FortiOS qui les démarre allumées. Une différence de culture entre les deux constructeurs qu'il vaut mieux connaître.

Avec un substitut Linux :

```bash
root@r1-edge:~# ip -brief addr show
root@r1-edge:~# ping -c 3 8.8.8.8
root@r1-edge:~# ip route show
```

**Étape 1 — Importer la machine virtuelle**

Dans VMware Workstation : `Fichier → Ouvrir` puis sélectionne le fichier `.ovf`. Accepte l'import.

Dans Proxmox, depuis un terminal du serveur :
```bash
qm create 100 --name FGT-01 --memory 2048 --cores 1 --net0 virtio,bridge=vmbr0
qm importdisk 100 fortios.qcow2 local-lvm
qm set 100 --scsi0 local-lvm:vm-100-disk-0
qm set 100 --boot order=scsi0
```

**Étape 2 — Régler les ressources**

Avant de démarrer, vérifie :
- **Mémoire** : 2048 Mio (inutile de donner plus, la licence d'évaluation plafonne à 2 Gio)
- **Processeurs** : 1 (même raison)
- **Cartes réseau** : au moins 3

> ⚠️ **Attention — le point qui rate le plus souvent**
> L'ordre des cartes réseau dans l'hyperviseur détermine l'ordre des `portX` dans FortiOS. La première carte devient `port1`, la deuxième `port2`, et ainsi de suite.
>
> Pour ce laboratoire :
> - **Carte 1 → NAT** (ce sera `port1`, notre accès « Internet »)
> - **Carte 2 → réseau privé « LAN »** (ce sera `port2`)
> - **Carte 3 → réseau privé « DMZ »** (ce sera `port3`)
>
> Ne mets **pas** les cartes 2 et 3 en mode « ponté » (*bridged*) : elles se retrouveraient sur ton vrai réseau domestique, et ton FortiGate pourrait se mettre à distribuer des adresses DHCP à toute ta maison. Tes colocataires n'apprécieraient pas. 😅

**Étape 3 — Démarrer et se connecter**

Démarre la VM et ouvre sa **console** (pas SSH : on n'a pas encore d'adresse IP). Le démarrage prend une à deux minutes. Tu obtiens :

```
FortiGate-VM64 login:
```

Connecte-toi avec :
- **Nom d'utilisateur** : `admin`
- **Mot de passe** : *(vide — appuie simplement sur Entrée)*

FortiOS t'oblige immédiatement à changer ce mot de passe vide :

```
You are forced to change your password, please input a new password.
New Password: ********
Confirm Password: ********
```

> 💡 **Astuce** : choisis un mot de passe que tu retiendras (`Lab@Forti2026` par exemple). Tu vas le taper des dizaines de fois dans ce tutoriel. Et note-le quelque part — perdre le mot de passe d'un FortiGate implique une réinitialisation d'usine par le port console, ce qui est long et pénible.

**Étape 4 — Vérifier que le système est vivant**

```
FortiGate-VM64 # get system status
```

Tu obtiens un pavé d'informations. Les lignes qui comptent :

```
Version: FortiGate-VM64 v7.6.3,build2660,250401 (GA.F)
Serial-Number: FGVMEVXXXXXXXXXX
License Status: Valid
VM Resources: 1 CPU, 1985 MB RAM
Log hard disk: Available
Hostname: FortiGate-VM64
Operation Mode: NAT
Current HA mode: standalone
System time: Thu Aug 20 09:12:44 2026
```

Décryptons ce qui est important :

| Ligne | Ce qu'elle t'apprend |
|---|---|
| `Version` | Ta version de FortiOS. Vérifie que c'est bien du 7.6 |
| `Serial-Number` | Commence par `FGVM` sur une VM. C'est l'identité du pare-feu |
| `VM Resources` | Confirme le bridage à 1 CPU / 2 Gio |
| `Operation Mode: NAT` | Le mode de fonctionnement. On y revient au §6.8 |
| `Current HA mode` | `standalone` = pas de cluster. Section 21 |

**Étape 5 — Donner une adresse au port1**

Pour l'instant, le pare-feu n'a aucune adresse. Donnons-lui-en une :

```
FGT-01 # config system interface
FGT-01 (interface) # edit port1
FGT-01 (port1) # set alias "WAN-vers-R1"
FGT-01 (port1) # set mode static
FGT-01 (port1) # set ip 192.168.100.99 255.255.255.0
FGT-01 (port1) # set allowaccess ping http https ssh
FGT-01 (port1) # next
FGT-01 (interface) # end
```

Ligne par ligne, parce que c'est ta toute première configuration :

| Commande | Traduction en français |
|---|---|
| `config system interface` | « J'entre dans la table des interfaces » |
| `edit port1` | « Je veux modifier l'interface port1 » |
| `set mode static` | « Je te donne une adresse fixe » |
| `set ip 192.168.100.99 255.255.255.0` | L'adresse côté R1, selon le plan du §3.7 |
| `set allowaccess ping http https ssh` | « Autorise qu'on t'administre par ces protocoles, sur cette interface » |
| `next` | « J'ai fini avec port1, je reste dans la table » |
| `end` | « J'ai fini avec la table, applique » |

Et la route par défaut vers R1, sans laquelle le pare-feu ne sort de nulle part :

```
FGT-01 # config router static
FGT-01 (static) # edit 1
FGT-01 (1) # set gateway 192.168.100.1
FGT-01 (1) # set device "port1"
FGT-01 (1) # set comment "Vers R1-EDGE"
FGT-01 (1) # next
FGT-01 (static) # end

FGT-01 # execute ping 192.168.100.1
FGT-01 # execute ping 8.8.8.8
```

> 🧠 **Comprendre les deux pings** : le premier prouve que le **lien de transit** fonctionne. Le second prouve que **R1 route et fait du NAT** pour toi. Si le premier passe et pas le second, le problème est chez R1, pas sur ton pare-feu — tu viens de diviser le champ de recherche en deux.

> 💡 **Astuce** : la fin de ce TP mentionnait `set mode dhcp`. On lui préfère désormais une adresse **fixe**, parce que R1 est notre passerelle et que l'adresse du pare-feu ne doit pas bouger — on la citera dans les routes statiques de R1 (§3.8) et dans les ACL de la section 15.

> 🚨 **Danger — `allowaccess` sur une interface WAN**
> Dans un laboratoire, autoriser l'administration sur `port1` est pratique. **En production, c'est une faute grave.** Cela expose l'interface d'administration de ton pare-feu à Internet entier, et les FortiGate exposés sont scannés en permanence.
>
> On corrigera ça proprement en section 24. Pour l'instant, tu es dans un réseau isolé, donc c'est acceptable — mais je veux que tu saches dès la première commande que c'en est une, plutôt que de le découvrir dans six mois.

**Étape 6 — Vérifier l'adressage**

```
FGT-01 # get system interface physical
```

ou, plus lisible :

```
FGT-01 # diagnose ip address list
```

Tu dois voir `port1` en `192.168.100.99`.

**Étape 7 — Vérifier l'accès d'administration, en CLI**

Depuis une machine du réseau de transit, sans navigateur :

```bash
user@pc-transit:~$ curl -sSi http://192.168.100.99/
```
```
HTTP/1.1 200 OK
Server: xxxxxxxx-xxxxx
```

Et l'accès SSH, celui dont tu te serviras pour tout le reste du tutoriel :

```bash
user@pc-transit:~$ ssh admin@192.168.100.99
```

Sur le pare-feu, la liste de ce que `port1` accepte réellement :

```
FGT-01 # show system interface port1
```
```
    set allowaccess ping https ssh http
```

**C'est `allowaccess` qui décide**, et rien d'autre. Une adresse correcte
avec un `allowaccess` vide ne répond à personne — c'est la panne n°1 du
premier jour.

---

**✅ Résultat attendu**

- R1 pingue Internet, et le pare-feu pingue R1 ✅
- `execute ping 8.8.8.8` depuis le pare-feu fonctionne ✅
- `curl -sSi http://192.168.100.99/` répond `200 OK`, et `ssh admin@192.168.100.99` ouvre une session ✅

> ⚠️ Rappel du §3.2 : avec la licence d'évaluation, utilise bien **`http://`** et non `https://`. C'est normal, ce n'est pas une erreur de ta part.

> 💡 **Tout le reste du tutoriel se fait en CLI**, par SSH ou par la console.
> Les chemins de l'interface web sont donnés quand ils existent, pour se
> repérer — mais aucune manipulation n'en dépend.

---

**🧠 Ce que tu viens d'apprendre**

Beaucoup plus que « installer une VM », en réalité :

1. **La structure de la CLI FortiOS.** Tu viens d'utiliser `config` → `edit` → `set` → `next` → `end`. **Cette séquence est la même pour absolument tout dans FortiOS** : les politiques, les routes, les VPN, les utilisateurs. Tu l'as apprise une fois, tu la connais partout. C'est le sujet de toute la section 5.
2. **`get system status` est ton premier réflexe.** Sur n'importe quel FortiGate inconnu, c'est la première commande à taper : version, modèle, mode, HA, heure.
3. **`allowaccess` contrôle l'administration par interface.** C'est un paramètre de sécurité de première importance, et il se règle interface par interface.
4. **La numérotation des ports vient de l'hyperviseur**, pas de FortiOS. Un piège classique quand une VM se comporte bizarrement.
5. **Ton pare-feu ne sort pas tout seul.** Il a fallu une route par défaut vers R1, et c'est R1 qui fait le NAT vers Internet. Deux équipements, deux rôles — et deux pings pour savoir lequel est en cause.

---

# Partie II — Premiers pas

---

## 4. Premier démarrage et prise en main

Ton FortiGate tourne. Avant d'écrire la moindre règle, on va faire ce que fait tout administrateur devant un équipement neuf : **le rendre présentable et identifiable**. Hostname, heure, comptes, licence. C'est du travail de plomberie, mais chacun de ces points a une conséquence réelle que je vais t'expliquer — notamment l'heure, dont tu ne soupçonnes probablement pas l'importance.

### 4.1 Le tour du propriétaire : l'interface web

Connecte-toi sur `http://<adresse-port1>`. Voici la carte des lieux.

**Le menu de gauche**, dans l'ordre où tu l'utiliseras :

| Menu | Ce qu'on y fait | Section du tutoriel |
|---|---|---|
| **Dashboard** | Vue d'ensemble, licences, ressources | Ici |
| **Network** | Interfaces, routage, DNS, DHCP | 6, 7, 12 |
| **Policy & Objects** | ⭐ Politiques, adresses, services, NAT | 8, 9, 10 |
| **Security Profiles** | Antivirus, filtrage web, IPS, contrôle applicatif | 13, 14, 15 |
| **VPN** | IPsec et accès distant | 17, 18 |
| **User & Authentication** | Utilisateurs, LDAP, RADIUS | 16 |
| **WiFi & Switch Controller** | Bornes et switchs Fortinet | Hors périmètre |
| **Log & Report** | Journaux, FortiView | 22 |
| **System** | Administrateurs, heure, mises à jour, HA | Ici, 21, 24 |

> 💡 **Astuce** : le menu que tu passeras 80 % de ton temps à utiliser est **Policy & Objects**. C'est le cœur du métier. Les autres sont des services autour.

**Le tableau de bord** t'affiche des widgets. Ceux qui comptent vraiment :

- **System Information** — modèle, version, temps de fonctionnement
- **Licenses** — l'état de tes abonnements FortiGuard (probablement en rouge, c'est normal)
- **Security Fabric** — l'état de la coopération entre équipements
- **CPU / Memory** — la charge. Un FortiGate en mémoire saturée bascule en *conserve mode*, ce qui change son comportement (§23)

### 4.2 🧠 Comprendre : pourquoi l'heure est un sujet de sécurité

C'est le paramètre que tout le monde néglige et qui coûte le plus cher. Alors on prend deux minutes.

Une heure fausse sur un pare-feu casse **quatre choses**, et pas des petites :

**1. Les journaux deviennent inexploitables.** Le jour où tu dois répondre à « que s'est-il passé le 14 mars à 3 h 12 ? », tu compares les logs du pare-feu, du serveur et du proxy. Si les horloges divergent de vingt minutes, tu ne peux **pas corréler** les événements. L'enquête s'arrête là. C'est le cas d'usage numéro un de la journalisation, et il tombe sur un décalage d'horloge.

**2. Les certificats cessent de fonctionner.** Un certificat TLS est valide **entre deux dates**. Si ton pare-feu croit qu'on est en 2019, tout certificat émis depuis est « pas encore valide » — et il refusera l'inspection SSL (section 15) et les tunnels VPN qui s'authentifient par certificat.

**3. Les règles horaires ne s'appliquent pas.** Une politique « accès Internet de 8 h à 18 h » sur une horloge décalée bloque les gens en pleine journée de travail. Bon courage pour le diagnostic.

**4. La corrélation avec les autres équipements échoue.** Même problème que le point 1, mais à l'échelle du SIEM.

**La bonne pratique, universelle et non négociable : synchroniser via NTP.** C'est deux commandes, et FortiOS le fait par défaut vers les serveurs Fortinet — encore faut-il que le pare-feu ait accès à Internet, ce qui n'est pas toujours le cas.

### 4.3 Les comptes d'administration

FortiOS a un compte `admin` par défaut, qui est un **super-administrateur**. Dans la vraie vie, on ne travaille pas comme ça :

- Chaque administrateur a **son propre compte nominatif**. Sinon, quand quelque chose casse, les journaux disent « admin » et tu ne sais pas qui.
- On attribue des **profils de droits** (*admin profiles*) : le support de niveau 1 a besoin de lire les journaux, pas de modifier les politiques.
- Le compte `admin` générique est réservé aux urgences.

Les profils prédéfinis :

| Profil | Droits |
|---|---|
| `super_admin` | Tout, y compris créer des administrateurs |
| `prof_admin` | Tout dans un VDOM, mais pas la configuration globale |
| **Personnalisé** | Ce que tu définis, catégorie par catégorie |

### 4.4 La licence d'évaluation

Sur une VM, le bandeau rouge du tableau de bord signale une licence non enregistrée. Pour obtenir la licence d'évaluation permanente :

L'enregistrement lui-même passe par FortiCare — c'est le seul point du
tutoriel qui demande un navigateur, parce que c'est le service de Fortinet
et non le pare-feu : sur `support.fortinet.com`, enregistre la VM avec son
numéro de série et choisis **Evaluation License**. Tu récupères un fichier
de licence, ou un jeton.

L'application, elle, se fait **en CLI** :

```
FGT-01 # execute vm-license <jeton-forticare>
```

ou, si tu as récupéré un fichier :

```
FGT-01 # execute restore vmlicense tftp FGVM.lic 192.168.10.50
```

Le pare-feu redémarre et applique la licence. Vérifie ensuite :

```
FGT-01 # get system status
```
```
License Status: Valid
```

> ⚠️ **Attention** : une seule licence d'évaluation par compte FortiCare. Si tu veux plusieurs FortiGate simultanés (sections 17 à 21), il te faudra **plusieurs comptes**, ou passer par des boîtiers physiques. C'est une contrainte réelle qu'il vaut mieux découvrir maintenant qu'au moment de monter le VPN site-à-site.

---

### 🧪 TP 2 — Rendre ton FortiGate identifiable et à l'heure

**🎯 Objectif**
Configurer hostname, fuseau horaire, NTP, un compte d'administration nominatif et un délai d'expiration de session. Autrement dit : transformer une VM anonyme en équipement administrable.

**⏱️ Durée** : 20 minutes

**📋 Prérequis** : TP 1 terminé, accès CLI (console ou SSH)

---

**🔧 Manipulation**

**Étape 1 — Nommer le pare-feu**

```
FortiGate-VM64 # config system global
FortiGate-VM64 (global) # set hostname FGT-01
FGT-01 (global) # end
```

> 💡 **Astuce** : remarque que l'invite change **immédiatement**, avant même le `end`. FortiOS applique certains paramètres à la volée. Ce n'est pas le cas partout — la plupart des tables n'appliquent qu'au `end`.

**Étape 2 — Régler le fuseau horaire**

D'abord, trouve ton fuseau. La liste est longue et numérotée :

```
FGT-01 # config system global
FGT-01 (global) # set timezone ?
```

Tu obtiens une liste de plusieurs centaines d'entrées. Pour Paris :

```
FGT-01 (global) # set timezone 04
FGT-01 (global) # end
```

> ⚠️ **Attention** : les numéros de fuseau changent selon les versions de FortiOS. **Ne recopie pas un numéro trouvé sur un blog** — utilise le `?` sur *ta* machine et lis la liste. Depuis 7.4, FortiOS accepte aussi les noms normalisés :
> ```
> FGT-01 (global) # set timezone "Europe/Paris"
> ```
> Préfère cette forme quand elle est disponible : elle est lisible et ne dépend pas d'une numérotation interne.

**Étape 3 — Activer NTP**

```
FGT-01 # config system ntp
FGT-01 (ntp) # set ntpsync enable
FGT-01 (ntp) # set type custom
FGT-01 (ntp) # config ntpserver
FGT-01 (ntpserver) # edit 1
FGT-01 (1) # set server "fr.pool.ntp.org"
FGT-01 (1) # next
FGT-01 (ntpserver) # end
FGT-01 (ntp) # set syncinterval 60
FGT-01 (ntp) # end
```

Décryptage :

| Commande | Traduction |
|---|---|
| `set ntpsync enable` | « Synchronise-toi » |
| `set type custom` | « J'indique moi-même les serveurs » (l'autre valeur, `fortiguard`, utilise ceux de Fortinet) |
| `config ntpserver` | Une table **imbriquée** dans la table NTP — on y reviendra en §5 |
| `set syncinterval 60` | Interroge le serveur toutes les 60 minutes |

**Étape 4 — Vérifier l'heure**

```
FGT-01 # get system status | grep "System time"
```

ou, plus complet :

```
FGT-01 # execute time
FGT-01 # execute date
```

Et pour vérifier que la synchronisation fonctionne vraiment :

```
FGT-01 # diagnose sys ntp status
```

> 💡 **Astuce** : `execute time` **affiche** l'heure, mais permet aussi de la **régler** manuellement (`execute time 14:30:00`). C'est utile quand ton lab n'a pas d'accès Internet et donc pas de NTP.

**Étape 5 — Créer un administrateur nominatif**

```
FGT-01 # config system admin
FGT-01 (admin) # edit "jdupont"
FGT-01 (jdupont) # set accprofile "super_admin"
FGT-01 (jdupont) # set password "MotDePasseSolide2026!"
FGT-01 (jdupont) # set comments "Administrateur reseau - J. Dupont"
FGT-01 (jdupont) # next
FGT-01 (admin) # end
```

**Étape 6 — Restreindre les adresses de connexion (bonne pratique)**

Un administrateur ne devrait pouvoir se connecter que depuis un poste d'administration :

```
FGT-01 # config system admin
FGT-01 (admin) # edit "jdupont"
FGT-01 (jdupont) # set trusthost1 192.168.10.0 255.255.255.0
FGT-01 (jdupont) # next
FGT-01 (admin) # end
```

> 🚨 **Danger — le piège du `trusthost`**
> Dès que tu définis **un seul** `trusthost` sur un compte, **toutes les autres adresses sont refusées** pour ce compte. C'est le comportement voulu, mais il se retourne contre toi très facilement.
>
> **Le scénario classique** : tu es connecté en SSH depuis `192.168.100.50`, tu poses `set trusthost1 192.168.10.0/24` sur ton propre compte, tu valides… et ta session suivante est refusée. Tu viens de t'enfermer dehors.
>
> **La règle** : configure le `trusthost` d'abord sur un compte **de test**, vérifie que tu peux te connecter avec, **et seulement ensuite** applique-le à ton compte principal. Garde toujours un accès console — sur une VM, la console de l'hyperviseur ne peut pas être filtrée par `trusthost`, c'est ta porte de secours.

**Étape 7 — Régler le délai d'expiration des sessions**

```
FGT-01 # config system global
FGT-01 (global) # set admintimeout 30
FGT-01 (global) # end
```

Trente minutes d'inactivité et la session d'administration se ferme. Par défaut c'est 5 minutes, ce qui est très court quand on apprend et qu'on lit un tutoriel entre deux commandes.

> ⚠️ **Attention** : en production, **ne monte pas ce délai inutilement**. Une session d'administration oubliée sur un poste non verrouillé est une porte ouverte. Trente minutes en lab, cinq à dix en production.

**Étape 8 — Vérifier l'ensemble**

```
FGT-01 # show system global
```

Tu ne verras que les paramètres **différents de la valeur par défaut**. C'est une caractéristique majeure de FortiOS, expliquée en détail au §5.6.

Pour tout voir, y compris les valeurs par défaut :

```
FGT-01 # show full-configuration system global
```

Prépare-toi : c'est très long. 😄

---

**✅ Résultat attendu**

- L'invite affiche `FGT-01 #`
- `get system status` montre l'heure correcte de ton fuseau
- `diagnose sys ntp status` indique une synchronisation
- Tu peux te connecter avec le compte `jdupont`
- `show system global` fait apparaître `hostname`, `timezone`, `admintimeout`

---

**🧠 Ce que tu viens d'apprendre**

1. **`config system global` est le fourre-tout des réglages généraux.** Hostname, fuseau, délais, langue de l'interface. Tu y reviendras souvent.
2. **Les tables peuvent être imbriquées** (`config ntpserver` à l'intérieur de `config system ntp`). Structure fréquente dans FortiOS.
3. **`show` n'affiche que ce qui diffère du défaut.** C'est ce qui rend une configuration FortiGate lisible : ce que tu vois est **exactement** ce que quelqu'un a décidé de changer.
4. **`trusthost` est puissant et dangereux.** Il sécurise vraiment, et il enferme dehors vraiment.
5. **L'heure n'est pas un détail cosmétique.** Journaux corrélables, certificats valides, règles horaires opérationnelles.

---

### 4.5 Les quatre familles de commandes FortiOS

Avant de plonger dans la CLI, voici la carte mentale. **Toutes** les commandes FortiOS appartiennent à l'une de ces quatre familles, et savoir laquelle t'indique déjà ce qu'elle fait :

| Famille | Rôle | Modifie la config ? | Exemple |
|---|---|---|---|
| `config` | **Modifier** la configuration | ✅ Oui | `config firewall policy` |
| `get` | **Lire** un état ou des valeurs | ❌ Non | `get system status` |
| `show` | **Afficher** la configuration en texte | ❌ Non | `show firewall policy` |
| `execute` | **Faire** une action immédiate | Selon l'action | `execute ping 8.8.8.8` |
| `diagnose` | **Diagnostiquer** en profondeur | ❌ Non (sauf exceptions) | `diagnose sniffer packet` |

> 💡 **Astuce — la distinction `get` / `show` déroute tous les débutants**
> Sur la même chose, elles ne répondent pas à la même question :
> - **`show`** dit : « quelle est la **configuration** ? » → la réponse est un texte que tu pourrais recoller pour reconstruire l'équipement.
> - **`get`** dit : « quel est l'**état actuel** ? » → la réponse inclut des choses que personne n'a configurées (adresse obtenue en DHCP, état du lien, compteurs).
>
> Sur une interface en DHCP, `show system interface port1` te dira `set mode dhcp` — c'est ce qui est configuré. `get system interface port1` te dira en plus **l'adresse réellement obtenue**. Les deux sont vraies, elles répondent à deux questions différentes.

C'est le sujet de la section suivante, et c'est la section la plus rentable de tout ce tutoriel. 🎯

---

## 5. La CLI FortiOS en profondeur

Si tu ne devais lire qu'une seule section de ce tutoriel, ce serait celle-ci.

La CLI FortiOS a une propriété remarquable : **elle est entièrement régulière**. Une fois que tu as compris sa grammaire — et elle tient en une page — tu peux configurer n'importe quoi, y compris des fonctions que tu n'as jamais vues, en devinant les commandes. Ce n'est pas une figure de style : je vais te montrer comment configurer une fonction sans connaître sa syntaxe.

### 5.1 La grammaire, en une image

Toute la configuration de FortiOS est un **arbre de tables**. Une table contient des **objets**, un objet contient des **attributs**.

```
config <chemin de la table>        ← j'entre dans une table
    edit <nom ou numéro de l'objet>    ← je crée ou modifie un objet
        set <attribut> <valeur>            ← je règle un attribut
        set <attribut> <valeur>
    next                               ← j'ai fini cet objet, j'en veux un autre
    edit <un autre objet>
        set ...
    next
end                                ← j'ai fini la table, applique tout
```

Voilà. C'est tout. **Absolument tout FortiOS se configure comme ça** : les interfaces, les politiques, les routes, les VPN, les utilisateurs, les profils antivirus, la haute disponibilité.

### 5.2 Les deux formes de tables

Il y a une nuance à connaître, sinon tu vas te demander pourquoi `edit` fonctionne parfois et pas toujours.

**Les tables à objets multiples** — celles qui contiennent une liste. Il faut un `edit` :

```
config firewall address        ← il peut y avoir 500 objets adresse
    edit "Reseau-LAN"
        set subnet 192.168.10.0 255.255.255.0
    next
end
```

**Les tables uniques** — celles dont il n'existe qu'un exemplaire. **Pas de `edit`** :

```
config system global           ← il n'y a qu'une configuration globale
    set hostname FGT-01
end
```

> 💡 **Astuce — comment savoir dans quel cas on est ?**
> Tape `config <quelque chose>` puis appuie sur `?`. Si FortiOS te propose `edit`, c'est une table à objets multiples. S'il te propose directement des `set`, c'est une table unique. Tu n'as rien à mémoriser, la CLI te le dit.

### 5.3 `next` contre `end` : la confusion la plus fréquente

Ces deux mots ne font pas la même chose, et les mélanger produit des erreurs incompréhensibles.

| Commande | Effet |
|---|---|
| `next` | Valide **l'objet courant** et reste dans la table, prêt pour un autre `edit` |
| `end` | Valide **la table entière** et sort |
| `abort` | Sort **en annulant** les modifications non validées |

Concrètement :

```
config firewall address
    edit "Serveur-Web"
        set subnet 192.168.20.10 255.255.255.255
    next                          ← "Serveur-Web" est enregistré
    edit "Serveur-Mail"
        set subnet 192.168.20.11 255.255.255.255
    next                          ← "Serveur-Mail" est enregistré
end                               ← on sort de la table
```

> 💡 **Astuce** : `end` fait implicitement le travail de `next` pour l'objet en cours. Ces deux blocs sont équivalents :
> ```
> edit "X"
>     set subnet ...
> next
> end
> ```
> ```
> edit "X"
>     set subnet ...
> end
> ```
> Beaucoup d'administrateurs écrivent quand même le `next`, par habitude et parce que ça rend les scripts plus faciles à modifier. Fais comme tu préfères, mais sois cohérent.

> ⚠️ **Attention** : `abort` est ton filet de sécurité. Si tu t'es trompé au milieu d'un bloc et que tu ne veux **rien** appliquer, `abort` annule tout le bloc. Retiens-le maintenant, tu en auras besoin un jour où tu seras en train de te couper l'accès.

### 5.4 Les verbes qui agissent sur les objets

À l'intérieur d'une table, au-delà de `edit` :

| Commande | Effet |
|---|---|
| `edit <nom>` | Crée l'objet s'il n'existe pas, l'ouvre s'il existe |
| `delete <nom>` | **Supprime** l'objet |
| `purge` | 🚨 Supprime **TOUS** les objets de la table |
| `rename <ancien> to <nouveau>` | Renomme |
| `clone <source> to <copie>` | Duplique — très pratique |
| `move <a> after|before <b>` | Change l'**ordre** — capital pour les politiques (§9) |
| `show` | Affiche la configuration de la table courante |
| `get` | Affiche les valeurs **effectives** de l'objet courant |

> 🚨 **Danger — `purge`**
> `purge` ne demande pas toujours confirmation selon le contexte, et il n'y a pas d'annulation. Un `purge` dans `config firewall policy` efface **toutes** tes politiques d'un coup. Un pare-feu sans politique bloque tout : ton entreprise s'arrête, et si tu administrais à distance, ton accès aussi.
>
> Ne tape jamais `purge` sur un équipement de production sans une sauvegarde fraîche et un accès console.

> 💡 **Astuce — `clone` est ton meilleur ami**
> Pour créer une politique proche d'une existante :
> ```
> config firewall policy
>     clone 3 to 10
>     edit 10
>         set name "Politique-derivee"
>         set dstaddr "Autre-Reseau"
>     next
> end
> ```
> Tu récupères tous les paramètres de la politique 3 et tu ne modifies que ce qui diffère. Bien plus sûr que de tout retaper — et surtout, tu n'oublies pas un paramètre.

### 5.5 L'aide contextuelle : `?`

C'est ce qui rend la CLI FortiOS apprenable sans documentation. **Le `?` fonctionne partout**, à n'importe quel niveau.

```
FGT-01 # config ?                        ← toutes les tables disponibles
FGT-01 # config firewall ?               ← toutes les tables firewall
FGT-01 (policy) # edit 1
FGT-01 (1) # set ?                       ← tous les attributs d'une politique
FGT-01 (1) # set action ?                ← toutes les valeurs possibles de "action"
```

> 💡 **Astuce** : la **tabulation** complète les commandes, comme dans un shell Unix. `con` + Tab donne `config`. Et les flèches haut/bas rappellent l'historique.

### 5.6 🧠 Comprendre : pourquoi `show` cache des choses

Voici une particularité de FortiOS qui déroute, puis qu'on finit par adorer.

**`show` n'affiche que ce qui diffère de la valeur par défaut.**

Prends une interface :

```
FGT-01 # show system interface port2
config system interface
    edit "port2"
        set vdom "root"
        set ip 192.168.10.1 255.255.255.0
        set allowaccess ping https ssh
        set alias "LAN"
        set role lan
    next
end
```

Cinq lignes. Or une interface FortiOS a **plus de cent attributs** : MTU, vitesse, duplex, détection d'équipement, mode d'adressage… Ils existent tous, ils ont simplement leur valeur par défaut, donc `show` les tait.

Pour tout voir :

```
FGT-01 # show full-configuration system interface port2
```

Là, tu obtiens les cent lignes.

**Pourquoi c'est une bonne idée ?** Parce que ça rend une configuration FortiGate **lisible d'un coup d'œil**. Quand tu récupères un pare-feu inconnu et que tu tapes `show`, tu vois **exactement ce que quelqu'un a délibérément changé** — et rien d'autre. Sur d'autres systèmes, il faut lire des milliers de lignes pour repérer les cinq qui comptent.

> 💡 **Astuce professionnelle** : quand tu demandes de l'aide sur un forum ou au support Fortinet, envoie la sortie de `show` (courte, lisible, pertinente) et pas celle de `show full-configuration` (illisible, et qui contient parfois des informations sensibles).

### 5.7 Filtrer, chercher, canaliser

La CLI FortiOS accepte un `|` (barre verticale) comme un shell Unix :

```
FGT-01 # show firewall policy | grep name
FGT-01 # get system status | grep Version
FGT-01 # show | grep -f "port2"          ← -f : affiche le contexte complet
```

Le `grep -f` est particulièrement utile : au lieu de te donner la ligne isolée, il te rend **le bloc de configuration entier** qui la contient.

Et pour chercher dans toute la configuration :

```
FGT-01 # show | grep -i "192.168.10"
```

### 5.8 Les filtres de table

Sur les grandes tables, tu peux filtrer avant d'afficher :

```
FGT-01 # config firewall policy
FGT-01 (policy) # show | grep "set name"

FGT-01 (policy) # get                    ← liste tous les objets de la table
```

Il existe aussi un mécanisme de filtre plus formel :

```
FGT-01 (policy) # config firewall policy
FGT-01 (policy) # edit 0                 ← "0" = "crée un nouvel objet, choisis l'ID toi-même"
```

> 💡 **Astuce — `edit 0`** : dans une table dont les objets sont numérotés (comme les politiques), `edit 0` demande à FortiOS d'**attribuer automatiquement** le prochain identifiant libre. Très pratique en script : tu n'as pas à savoir quels numéros sont déjà pris. Après le `next`, FortiOS t'annonce le numéro qu'il a choisi.

### 5.9 Deviner une commande qu'on ne connaît pas

Je t'avais promis la démonstration. La voici.

Imaginons que tu veuilles activer une fonction dont tu ignores tout : disons désactiver la réponse aux `ping` sur une interface. Tu ne connais pas la commande. Voici le raisonnement, qui marche à chaque fois :

**1. De quoi s'agit-il ?** D'une propriété d'une interface. Donc : `config system interface`.

```
FGT-01 # config system interface
FGT-01 (interface) # edit port1
```

**2. Quels attributs existent ?**

```
FGT-01 (port1) # set ?
```

Tu lis la liste et tu repères `allowaccess`. Sa description parle des protocoles d'administration autorisés.

**3. Quelles valeurs prend-il ?**

```
FGT-01 (port1) # set allowaccess ?
ping    PING access
https   HTTPS access
ssh     SSH access
snmp    SNMP access
http    HTTP access
...
```

**4. Tu conclus** : pour interdire le ping, on redéfinit `allowaccess` **sans** `ping` :

```
FGT-01 (port1) # set allowaccess https ssh
FGT-01 (port1) # next
FGT-01 (interface) # end
```

Tu viens de configurer une fonction sans documentation, en trois `?`. **C'est la compétence à acquérir dans cette section**, bien plus que la mémorisation d'une liste de commandes.

> ⚠️ **Attention — les attributs à valeurs multiples s'écrivent en entier**
> C'est un piège classique. `allowaccess` accepte plusieurs valeurs, et `set` **remplace** toujours la liste complète — il n'ajoute pas.
>
> Si l'interface a `ping https ssh` et que tu tapes `set allowaccess ssh`, tu n'as pas « gardé ping et https en ajoutant ssh » : tu n'as plus que `ssh`. Le ping et le HTTPS sont partis.
>
> **La règle : pour ces attributs, énumère toujours la liste complète que tu veux obtenir.** Cette règle vaut pour `allowaccess`, `srcaddr`, `dstaddr`, `service`, `member`, et tous les attributs de type liste. Elle a coupé l'accès de beaucoup de monde. 😅

### 5.10 Les commandes `execute` utiles dès maintenant

`execute` déclenche une action immédiate. Les indispensables :

```
FGT-01 # execute ping 8.8.8.8
FGT-01 # execute ping-options source 192.168.10.1     ← pinguer DEPUIS une IP précise
FGT-01 # execute traceroute 8.8.8.8
FGT-01 # execute telnet 192.168.20.10 80              ← tester si un port répond
FGT-01 # execute date
FGT-01 # execute reboot
FGT-01 # execute shutdown
FGT-01 # execute backup config tftp config.conf 192.168.10.50
FGT-01 # execute factoryreset                          ← 🚨 remise à zéro totale
```

> 💡 **Astuce — `execute ping-options source`**
> Celle-là vaut de l'or en diagnostic. Par défaut, un `ping` émis par le FortiGate part avec l'adresse de l'interface de sortie. Or tu veux souvent tester « est-ce que mon réseau LAN atteint ce serveur ? », donc pinguer **avec l'adresse LAN comme source** :
> ```
> FGT-01 # execute ping-options source 192.168.10.1
> FGT-01 # execute ping 192.168.20.10
> ```
> C'est la différence entre tester le pare-feu et tester le chemin réel. Et le réglage **persiste** pour les pings suivants — pense à le remettre à `auto` :
> ```
> FGT-01 # execute ping-options source auto
> ```

---

### 🧪 TP 3 — Maîtriser la CLI par la manipulation

**🎯 Objectif**
Pratiquer la grammaire CLI jusqu'à ce qu'elle devienne un réflexe : créer, cloner, renommer, supprimer, explorer avec `?`, et comprendre `show` contre `show full-configuration`.

**⏱️ Durée** : 25 minutes

**📋 Prérequis** : TP 2 terminé

---

**🔧 Manipulation**

**Étape 1 — Créer trois objets d'un coup**

On anticipe la section 8, mais peu importe : ce qui compte ici, c'est la mécanique.

```
FGT-01 # config firewall address
FGT-01 (address) # edit "TP3-Serveur-A"
FGT-01 (TP3-Serveur-A) # set subnet 10.99.1.10 255.255.255.255
FGT-01 (TP3-Serveur-A) # next
FGT-01 (address) # edit "TP3-Serveur-B"
FGT-01 (TP3-Serveur-B) # set subnet 10.99.1.11 255.255.255.255
FGT-01 (TP3-Serveur-B) # next
FGT-01 (address) # edit "TP3-Reseau"
FGT-01 (TP3-Reseau) # set subnet 10.99.1.0 255.255.255.0
FGT-01 (TP3-Reseau) # next
FGT-01 (address) # end
```

Observe l'invite : elle t'indique **toujours** où tu te trouves dans l'arbre. `(address)` = dans la table, `(TP3-Serveur-A)` = dans l'objet.

**Étape 2 — Lister ce que tu viens de créer**

```
FGT-01 # show firewall address | grep TP3
```

**Étape 3 — Explorer avec `?`**

```
FGT-01 # config firewall address
FGT-01 (address) # edit "TP3-Serveur-A"
FGT-01 (TP3-Serveur-A) # set ?
```

Lis la liste. Repère `type`, `comment`, `color`, `associated-interface`. Puis :

```
FGT-01 (TP3-Serveur-A) # set type ?
```

Tu découvres qu'un objet adresse peut être un sous-réseau, une plage, un nom de domaine, une géolocalisation… **Tu viens d'apprendre la section 8 tout seul.** 😄

```
FGT-01 (TP3-Serveur-A) # abort
```

**Étape 4 — Comparer `show` et `show full-configuration`**

```
FGT-01 # show firewall address TP3-Serveur-A
```
```
config firewall address
    edit "TP3-Serveur-A"
        set subnet 10.99.1.10 255.255.255.255
    next
end
```

Puis :

```
FGT-01 # show full-configuration firewall address TP3-Serveur-A
```

Compte les lignes. La différence, ce sont **toutes les valeurs par défaut**.

**Étape 5 — Cloner**

```
FGT-01 # config firewall address
FGT-01 (address) # clone "TP3-Serveur-A" to "TP3-Serveur-C"
FGT-01 (address) # edit "TP3-Serveur-C"
FGT-01 (TP3-Serveur-C) # set subnet 10.99.1.12 255.255.255.255
FGT-01 (TP3-Serveur-C) # set comment "Cree par clonage"
FGT-01 (TP3-Serveur-C) # next
FGT-01 (address) # end
```

**Étape 6 — Renommer**

```
FGT-01 # config firewall address
FGT-01 (address) # rename "TP3-Serveur-C" to "TP3-Serveur-Clone"
FGT-01 (address) # end
```

**Étape 7 — Provoquer une erreur exprès**

Essaie de supprimer un objet utilisé quelque part. D'abord, crée cette dépendance :

```
FGT-01 # config firewall addrgrp
FGT-01 (addrgrp) # edit "TP3-Groupe"
FGT-01 (TP3-Groupe) # set member "TP3-Serveur-A" "TP3-Serveur-B"
FGT-01 (TP3-Groupe) # next
FGT-01 (addrgrp) # end
```

Puis tente :

```
FGT-01 # config firewall address
FGT-01 (address) # delete "TP3-Serveur-A"
```

FortiOS refuse, avec un message du genre :

```
Entry is used by other entries. Cannot be deleted.
```

> 🧠 **Comprendre — c'est une protection, pas une contrariété**
> FortiOS tient un graphe de dépendances et **interdit** de supprimer un objet référencé ailleurs. Sur un pare-feu, c'est vital : imagine qu'un objet adresse utilisé dans une politique d'autorisation disparaisse silencieusement. Que devient la politique ? Elle pourrait se mettre à matcher tout, ou plus rien. Les deux sont catastrophiques.
>
> Pour trouver **qui** utilise un objet, dans la GUI : clique droit sur l'objet → **Show Matches** (ou la colonne *Ref.*, qui affiche le nombre de références). En CLI :
> ```
> FGT-01 # diagnose sys checkused firewall.address.name "TP3-Serveur-A"
> ```

**Étape 8 — Nettoyer, dans le bon ordre**

Les dépendances d'abord :

```
FGT-01 # config firewall addrgrp
FGT-01 (addrgrp) # delete "TP3-Groupe"
FGT-01 (addrgrp) # end

FGT-01 # config firewall address
FGT-01 (address) # delete "TP3-Serveur-A"
FGT-01 (address) # delete "TP3-Serveur-B"
FGT-01 (address) # delete "TP3-Reseau"
FGT-01 (address) # delete "TP3-Serveur-Clone"
FGT-01 (address) # end
```

Vérifie :

```
FGT-01 # show firewall address | grep TP3
```

Aucune sortie : c'est propre.

---

**✅ Résultat attendu**

- Tu crées, clones, renommes et supprimes sans hésiter
- Tu as vu FortiOS **refuser** une suppression, et tu sais pourquoi
- Tu comprends la différence entre `show` et `show full-configuration`
- Le `?` est devenu ton réflexe

---

**🧠 Ce que tu viens d'apprendre**

1. **`config` / `edit` / `set` / `next` / `end` est LA structure de FortiOS.** Tu ne l'oublieras plus.
2. **L'invite indique toujours ta position** dans l'arbre de configuration.
3. **Le `?` remplace la documentation** dans 80 % des cas.
4. **`clone` évite les oublis** quand on crée un objet proche d'un autre.
5. **Les dépendances sont protégées** : on supprime toujours du plus dépendant vers le moins dépendant.
6. **`set` sur un attribut de liste REMPLACE**, il n'ajoute pas. Écris toujours la liste complète.

---

### 5.11 Aide-mémoire de la section

```
config <table>                  Entrer dans une table
    edit <objet>                Créer ou modifier un objet
        set <attr> <valeur>     Régler un attribut
        unset <attr>            Revenir à la valeur par défaut
        get                     Voir les valeurs effectives de l'objet
        show                    Voir la configuration de l'objet
    next                        Valider l'objet, rester dans la table
    delete <objet>              Supprimer un objet
    clone <a> to <b>            Dupliquer
    rename <a> to <b>           Renommer
    move <a> after <b>          Réordonner
end                             Valider la table et sortir
abort                           Sortir en annulant
```

---

## 6. Interfaces, zones et adressage

Une interface, c'est là où le réseau entre et sort du pare-feu. Tout part de là : si une interface est mal configurée, aucune politique au monde ne fera passer le trafic. C'est aussi la première chose à vérifier quand quelque chose ne marche pas.

### 6.1 Ce qu'est une interface sur FortiOS

Sur FortiGate, le mot « interface » recouvre plus que les ports physiques. Il y a **six familles**, et il est utile de les connaître parce qu'elles apparaissent toutes dans la même liste :

| Type | À quoi ça sert | Exemple |
|---|---|---|
| **Physique** | Un vrai port RJ45 ou SFP | `port1`, `wan1`, `internal` |
| **VLAN** | Un sous-réseau étiqueté sur un port physique | `port2.10` |
| **Agrégat** (*LAG*) | Plusieurs ports physiques vus comme un seul | `agg1` |
| **Logicielle** (*software switch*) | Plusieurs ports fusionnés en un réseau unique | `lan` |
| **Tunnel** | L'extrémité d'un VPN | `VPN-Site-B` |
| **Boucle locale** (*loopback*) | Une interface virtuelle toujours active | `lo-mgmt` |

> 💡 **Astuce — l'interface de boucle locale mérite un mot**
> Une *loopback* est une interface qui n'est reliée à aucun câble et qui, pour cette raison même, **ne tombe jamais**. On l'utilise comme identité stable du pare-feu : identifiant de routeur en OSPF/BGP (section 19), adresse source des journaux, point de terminaison d'administration.
>
> L'idée est contre-intuitive au début : une interface qui ne mène nulle part est précisément celle sur laquelle on peut compter, puisqu'aucune panne de câble ne peut la faire tomber.

### 6.2 Les attributs essentiels d'une interface

```
config system interface
    edit "port2"
        set alias "LAN"                          ← un nom lisible
        set ip 192.168.10.1 255.255.255.0        ← l'adresse
        set allowaccess ping https ssh           ← administration autorisée
        set role lan                             ← le rôle
        set description "Reseau des utilisateurs"
        set status up                            ← activée
        set mtu-override enable
        set mtu 1500
    next
end
```

Passons en revue ceux qui comptent :

**`alias`** — un surnom affiché à côté du nom technique. `port2` ne dit rien ; `port2 (LAN)` dit tout. **Mets systématiquement un alias**, c'est trente secondes qui te feront gagner des heures six mois plus tard, ou qui les feront gagner à ton successeur.

**`role`** — indique la vocation de l'interface : `lan`, `wan`, `dmz` ou `undefined`. Ce n'est pas cosmétique : la GUI **adapte les options proposées** selon le rôle. Une interface en rôle `wan` te propose une passerelle et des réglages SD-WAN ; une interface en rôle `lan` te propose un serveur DHCP. Ça ne change rien au fonctionnement, mais ça change ce que tu vois.

**`allowaccess`** — les protocoles d'administration autorisés **sur cette interface**. Rappel du §5.9 : cette liste se réécrit en entier à chaque `set`.

**`status`** — `up` ou `down`. C'est l'équivalent du `shutdown` de Cisco, à l'envers.

### 6.3 🧠 Comprendre : les trois états d'une interface

Une interface peut être « éteinte » de trois façons différentes, et les confondre est une cause classique de diagnostic raté :

| État | Cause | Comment le voir |
|---|---|---|
| **Administrativement bas** | Quelqu'un a fait `set status down` | `show system interface` |
| **Physiquement bas** | Pas de câble, ou l'équipement d'en face est éteint | `get system interface physical` |
| **Sans adresse** | L'interface est active mais n'a pas d'IP | `diagnose ip address list` |

Les trois donnent le même symptôme apparent — « ça ne passe pas » — et appellent trois actions complètement différentes. Prends l'habitude de vérifier les trois :

```
FGT-01 # get system interface physical
```
```
== [onboard]
        ==[port1]
                mode: dhcp
                ip: 192.168.100.99 255.255.255.0
                status: up
                speed: 1000Mbps (Duplex: full)
        ==[port2]
                mode: static
                ip: 192.168.10.1 255.255.255.0
                status: up
                speed: 1000Mbps (Duplex: full)
        ==[port3]
                mode: static
                ip: 0.0.0.0 0.0.0.0
                status: down
                speed: n/a
```

Ici, `port3` est **down** et sans adresse. La commande te donne les trois informations d'un coup — c'est pour ça qu'elle est le bon réflexe.

### 6.4 Les zones : regrouper pour simplifier

Une **zone** est un groupe d'interfaces qu'on manipule comme une seule dans les politiques.

**Le problème qu'elle résout.** Imagine quatre réseaux internes (`port2`, `port3`, `port4`, `port5`) qui ont tous le droit de sortir vers Internet. Sans zone, tu écris **quatre politiques identiques** à l'interface source près. Puis, quand tu ajoutes une règle, tu dois la répliquer quatre fois — et le jour où tu en oublies une, tu as un trou ou un blocage incompréhensible.

Avec une zone :

```
config system zone
    edit "INTERNE"
        set interface "port2" "port3" "port4" "port5"
        set intrazone deny
    next
end
```

Tu écris **une seule** politique `INTERNE → WAN`. Ajouter un cinquième réseau, c'est ajouter une interface à la zone : les politiques suivent toutes seules.

> ⚠️ **Attention — `intrazone`, le paramètre à ne pas rater**
> Il décide de ce qui se passe **entre deux interfaces de la même zone** :
> - `set intrazone deny` (défaut) → le trafic entre `port2` et `port3` est **bloqué** sauf politique explicite
> - `set intrazone allow` → il passe **librement, sans aucune politique et sans journalisation**
>
> `allow` est tentant parce que « ce sont mes réseaux internes ». C'est un mauvais réflexe : tu perds toute visibilité et tout contrôle sur les mouvements latéraux — c'est-à-dire exactement le chemin qu'emprunte un rançongiciel une fois qu'un poste est infecté. Laisse `deny` et écris les règles.

> 🚨 **Danger** : une interface **ne peut appartenir qu'à une seule zone**, et surtout, **une interface placée dans une zone ne peut plus être utilisée directement dans une politique**. Toutes les politiques qui la référençaient doivent d'abord être modifiées. FortiOS refusera l'ajout tant que des références existent — c'est la protection du §5, TP 3 étape 7.

### 6.5 Les VLAN

Un **VLAN** permet de faire passer plusieurs réseaux logiques sur un seul câble physique, en étiquetant les trames (norme 802.1Q). C'est ainsi qu'un FortiGate à quatre ports peut servir vingt réseaux.

```
config system interface
    edit "VLAN-COMPTA"
        set vdom "root"
        set interface "port2"          ← le port physique porteur
        set vlanid 30                  ← l'étiquette 802.1Q
        set ip 192.168.30.1 255.255.255.0
        set allowaccess ping
        set role lan
        set alias "Comptabilite"
    next
end
```

> ⚠️ **Attention — il faut être deux**
> Un VLAN sur le FortiGate ne sert à rien si le switch d'en face n'est pas configuré en conséquence. Le port du switch relié au FortiGate doit être en mode **trunk** et laisser passer l'étiquette 30. Si le switch envoie des trames non étiquetées, le FortiGate ne les verra pas arriver sur `VLAN-COMPTA`.
>
> C'est LA cause numéro un des VLAN qui « ne marchent pas » : la configuration est correcte des deux côtés, mais personne n'a vérifié que les deux parlaient de la même étiquette.

> 💡 **Astuce** : le trafic **non étiqueté** arrivant sur `port2` continue d'être traité par `port2` lui-même. Le port physique et ses VLAN coexistent : `port2` gère le natif, `port2.30` gère l'étiquette 30.

### 6.6 Le software switch

Un *software switch* fusionne plusieurs interfaces en **un seul réseau de niveau 2**, comme si tu avais branché un switch. C'est ce que font par défaut les petits modèles avec leurs ports `internal`.

```
config system switch-interface
    edit "lan-interne"
        set vdom "root"
        set member "port3" "port4" "port5"
        set type switch
    next
end
```

Ensuite, tu adresses `lan-interne` et non les ports individuels.

> ⚠️ **Attention** : c'est fait **en logiciel**, donc par le processeur. Sur un gros débit, c'est coûteux. Un vrai switch externe reste préférable dès que le trafic devient sérieux ; le software switch est là pour les petits sites où l'on veut économiser un équipement.

### 6.7 Les modes d'adressage

| Mode | Commande | Usage |
|---|---|---|
| **Statique** | `set mode static` + `set ip ...` | Interfaces internes, DMZ. **Le cas normal** |
| **DHCP** | `set mode dhcp` | Interface WAN chez un opérateur grand public |
| **PPPoE** | `set mode pppoe` | Lignes ADSL/VDSL/fibre avec authentification |

Pour PPPoE :

```
config system interface
    edit "port1"
        set mode pppoe
        set username "identifiant@operateur.fr"
        set password "motdepasse"
        set pppoe-unnumbered-negotiate enable
    next
end
```

> 💡 **Astuce** : en mode DHCP ou PPPoE, `set defaultgw enable` demande au pare-feu d'installer **automatiquement** la route par défaut apprise. C'est en général ce que tu veux sur une interface WAN — mais on verra en section 7 pourquoi tu voudras parfois le désactiver.

### 6.8 🧠 Comprendre : mode NAT contre mode transparent

Un FortiGate fonctionne dans l'un de deux modes globaux, et cette information figure dans `get system status`.

**Mode NAT** (le défaut, et 95 % des déploiements) — le pare-feu est un **routeur**. Chaque interface a une adresse IP, il route entre les réseaux, il peut faire du NAT. C'est notre mode dans tout ce tutoriel.

**Mode transparent** — le pare-feu est un **pont**. Il n'a qu'une seule adresse d'administration, il ne route rien, il se contente d'inspecter le trafic qui le traverse sans modifier la topologie IP.

**Quand utilise-t-on le mode transparent ?** Quand on veut ajouter un pare-feu au milieu d'un réseau existant **sans rien changer** : pas de nouveau plan d'adressage, pas de passerelle à modifier sur les postes, pas de coupure. On l'insère « en coupure » sur un câble, et il devient invisible.

```
config system settings
    set opmode transparent
    set manageip 192.168.10.99 255.255.255.0
    set gateway 192.168.10.1
end
```

> 🚨 **Danger** : changer de mode **efface une grande partie de la configuration** (interfaces, routes, politiques). Ce n'est pas un interrupteur, c'est une reconstruction. Ne le fais pas « pour voir » sur un équipement configuré — et surtout pas à distance, puisque tu perdras l'accès.

---

### 🧪 TP 4 — Adresser le laboratoire

**🎯 Objectif**
Configurer les trois interfaces du laboratoire selon le plan du §3.7, créer un VLAN, vérifier les trois états d'une interface, et brancher les PC. À la fin, chaque machine doit pinguer sa passerelle.

**⏱️ Durée** : 30 minutes

**📋 Prérequis** : TP 2 terminé, deux VM « PC » prêtes (Linux minimal suffit)

---

**🔧 Manipulation**

**Étape 1 — Configurer l'interface LAN**

```
FGT-01 # config system interface
FGT-01 (interface) # edit port2
FGT-01 (port2) # set alias "LAN"
FGT-01 (port2) # set role lan
FGT-01 (port2) # set mode static
FGT-01 (port2) # set ip 192.168.10.1 255.255.255.0
FGT-01 (port2) # set allowaccess ping https ssh
FGT-01 (port2) # set description "Reseau des postes utilisateurs"
FGT-01 (port2) # set status up
FGT-01 (port2) # next
FGT-01 (interface) # end
```

**Étape 2 — Configurer l'interface DMZ**

```
FGT-01 # config system interface
FGT-01 (interface) # edit port3
FGT-01 (port3) # set alias "DMZ"
FGT-01 (port3) # set role dmz
FGT-01 (port3) # set mode static
FGT-01 (port3) # set ip 192.168.20.1 255.255.255.0
FGT-01 (port3) # set allowaccess ping
FGT-01 (port3) # set description "Serveurs publies"
FGT-01 (port3) # set status up
FGT-01 (port3) # next
FGT-01 (interface) # end
```

> 🧠 **Comprendre — pourquoi seulement `ping` sur la DMZ ?**
> Parce que la DMZ est le réseau **destiné à être compromis** un jour (§3.7). Si un attaquant prend le contrôle du serveur web, la dernière chose que tu veux, c'est qu'il trouve l'interface d'administration de ton pare-feu à un saut de là.
>
> On laisse `ping` uniquement pour pouvoir diagnostiquer. En production stricte, on retire même le ping : `set allowaccess` sans aucune valeur.

**Étape 3 — Vérifier**

```
FGT-01 # get system interface physical
```

Tu dois voir `port2` et `port3` en `status: up` avec leurs adresses.

```
FGT-01 # diagnose ip address list
```
```
IP=192.168.100.99->192.168.100.99/255.255.255.0 index=3 devname=port1
IP=192.168.10.1->192.168.10.1/255.255.255.0 index=4 devname=port2
IP=192.168.20.1->192.168.20.1/255.255.255.0 index=5 devname=port3
```

**Étape 4 — Configurer le PC du LAN**

Sur ta VM Linux branchée au réseau virtuel « LAN » :

```bash
user@pc-lan:~$ sudo ip addr add 192.168.10.10/24 dev eth0
user@pc-lan:~$ sudo ip link set eth0 up
user@pc-lan:~$ sudo ip route add default via 192.168.10.1
user@pc-lan:~$ ip addr show eth0
user@pc-lan:~$ ping -c 3 192.168.10.1
```

Sur Windows :

```cmd
C:\Users\Lab> netsh interface ipv4 set address name="Ethernet" static 192.168.10.10 255.255.255.0 192.168.10.1
C:\Users\Lab> ipconfig /all
C:\Users\Lab> ping 192.168.10.1
```

**Étape 5 — Configurer le serveur de la DMZ**

```bash
user@srv-dmz:~$ sudo ip addr add 192.168.20.10/24 dev eth0
user@srv-dmz:~$ sudo ip link set eth0 up
user@srv-dmz:~$ sudo ip route add default via 192.168.20.1
user@srv-dmz:~$ ping -c 3 192.168.20.1
```

Installe aussi un petit serveur web, on s'en servira dès la section 10 :

```bash
user@srv-dmz:~$ sudo apt install -y python3
user@srv-dmz:~$ echo "<h1>Serveur DMZ - lab FortiGate</h1>" > index.html
user@srv-dmz:~$ sudo python3 -m http.server 80
```

**Étape 6 — Le test qui va te surprendre**

Depuis le PC du LAN, essaie de joindre le serveur de la DMZ :

```bash
user@pc-lan:~$ ping -c 3 192.168.20.10
```

**Ça ne marche pas.** Aucune réponse.

> 🧠 **Comprendre — et c'est normal, c'est même le plus important du TP**
> Ton pare-feu route parfaitement : il connaît `192.168.10.0/24` sur `port2` et `192.168.20.0/24` sur `port3`, les deux interfaces sont actives, les deux machines le pinguent.
>
> Mais **aucune politique de sécurité n'autorise le trafic de `port2` vers `port3`**. Et le principe fondateur d'un FortiGate est celui-ci :
>
> ### 🔒 Tout ce qui n'est pas explicitement autorisé est refusé.
>
> Il existe, tout en bas de la liste des politiques, une règle invisible et non modifiable appelée **`Implicit Deny`**. Tout paquet qui arrive au bout de la liste sans avoir été autorisé tombe dessus et meurt.
>
> C'est exactement l'inverse d'un routeur, qui achemine par défaut tout ce qu'il sait router. Un routeur dit « je transporte, sauf interdiction ». Un pare-feu dit « je bloque, sauf autorisation ».
>
> Ce n'est pas une panne : **c'est ton pare-feu qui fait son travail**. On lèvera ce blocage en section 9, et à ce moment-là tu sauras exactement pourquoi ça marche.

**Étape 7 — Créer un VLAN (exercice)**

```
FGT-01 # config system interface
FGT-01 (interface) # edit "VLAN-COMPTA"
FGT-01 (VLAN-COMPTA) # set vdom "root"
FGT-01 (VLAN-COMPTA) # set interface "port2"
FGT-01 (VLAN-COMPTA) # set vlanid 30
FGT-01 (VLAN-COMPTA) # set ip 192.168.30.1 255.255.255.0
FGT-01 (VLAN-COMPTA) # set allowaccess ping
FGT-01 (VLAN-COMPTA) # set role lan
FGT-01 (VLAN-COMPTA) # set alias "Comptabilite"
FGT-01 (VLAN-COMPTA) # next
FGT-01 (interface) # end
```

Vérifie qu'il apparaît :

```
FGT-01 # show system interface | grep -A3 "VLAN-COMPTA"
```

> 💡 **Astuce** : ce VLAN ne portera aucun trafic dans notre lab, puisqu'il n'y a pas de switch configuré en face (§6.5). Il est là pour que tu voies la commande et la façon dont un VLAN apparaît dans la liste des interfaces. Tu peux le laisser ou le supprimer.

**Étape 8 — Observer les trois états**

Provoque une panne volontairement :

```
FGT-01 # config system interface
FGT-01 (interface) # edit port3
FGT-01 (port3) # set status down
FGT-01 (port3) # next
FGT-01 (interface) # end

FGT-01 # get system interface physical | grep -A4 port3
```

Le `status` passe à `down`. Depuis le serveur DMZ, le ping vers `192.168.20.1` échoue. Remets-la en service :

```
FGT-01 # config system interface
FGT-01 (interface) # edit port3
FGT-01 (port3) # set status up
FGT-01 (port3) # next
FGT-01 (interface) # end
```

---

**✅ Résultat attendu**

- `port2` = 192.168.10.1/24, `port3` = 192.168.20.1/24, toutes deux `up`
- PC-LAN pingue 192.168.10.1 ✅
- SRV-DMZ pingue 192.168.20.1 ✅
- PC-LAN → SRV-DMZ **échoue** ❌ ← **c'est le résultat attendu !**
- Le VLAN 30 apparaît dans la liste des interfaces

---

**🧠 Ce que tu viens d'apprendre**

1. **Une interface se configure toujours pareil** : `alias`, `role`, `mode`, `ip`, `allowaccess`, `status`.
2. **`allowaccess` se règle par interface**, et il est plus restrictif à mesure qu'on s'approche de l'extérieur ou d'une zone exposée.
3. **`get system interface physical` donne les trois états d'un coup.** C'est le premier réflexe de diagnostic.
4. **Le routage seul ne suffit pas.** Le pare-feu sait où envoyer le paquet et refuse quand même : il manque la politique.
5. **L'`Implicit Deny` est le fondement du pare-feu.** Tout ce qui n'est pas autorisé est refusé, et c'est ce qui distingue un pare-feu d'un routeur.

---

## 7. Le routage sur FortiGate

Avant de filtrer un paquet, le pare-feu doit savoir **où l'envoyer**. C'est le travail de la table de routage, et c'est une étape qu'on oublie souvent dans le diagnostic : on cherche une politique manquante alors que le problème est qu'il n'y a pas de route.

### 7.1 Ce qu'est une table de routage

C'est la liste des réseaux que le pare-feu sait joindre, et par où. Chaque ligne dit : « pour aller vers **ce réseau-là**, sors par **cette interface**, en confiant le paquet à **ce voisin** ».

```
FGT-01 # get router info routing-table all
```
```
Codes: K - kernel, C - connected, S - static, R - RIP, B - BGP
       O - OSPF, IA - OSPF inter area
       * - candidate default

S*    0.0.0.0/0 [10/0] via 192.168.100.1, port1
C     192.168.10.0/24 is directly connected, port2
C     192.168.20.0/24 is directly connected, port3
C     192.168.100.0/24 is directly connected, port1
```

Lecture ligne par ligne :

| Élément | Signification |
|---|---|
| `S*` | Route **statique**, et candidate par défaut |
| `C` | Route **connectée** — créée automatiquement par l'adressage d'une interface |
| `0.0.0.0/0` | « Tout le reste » — la route par défaut |
| `[10/0]` | `[distance/métrique]` |
| `via 192.168.100.1` | Le prochain saut |
| `port1` | L'interface de sortie |

> 💡 **Astuce** : les routes `C` apparaissent **toutes seules** dès qu'une interface a une adresse et qu'elle est active. Tu n'as jamais à les créer. Corollaire utile en diagnostic : **si une route connectée manque, c'est que l'interface est down ou sans adresse** — le problème est là, pas dans le routage.

### 7.2 La route par défaut

C'est la route la plus importante de toutes : celle qui dit « pour tout ce que je ne connais pas, va par là ». Sans elle, pas d'Internet.

```
config router static
    edit 1
        set dst 0.0.0.0 0.0.0.0
        set gateway 192.168.100.1
        set device "port1"
        set distance 10
        set comment "Route par defaut - operateur principal"
    next
end
```

> 💡 **Astuce** : `set dst 0.0.0.0 0.0.0.0` est souvent omis, parce que c'est la valeur par défaut d'une route statique. Ces deux blocs créent la même route :
> ```
> edit 1
>     set gateway 192.168.100.1
>     set device "port1"
> next
> ```
> Je te conseille quand même de l'écrire : une configuration explicite se relit mieux, et tu ne te demanderas pas six mois plus tard si l'omission était volontaire.

### 7.3 Les routes statiques

Pour un réseau qui n'est pas directement connecté et qu'on atteint par un routeur interne :

```
config router static
    edit 2
        set dst 172.16.50.0 255.255.255.0
        set gateway 192.168.10.254
        set device "port2"
        set comment "Reseau du site distant via le routeur interne"
    next
end
```

**Traduction** : « pour atteindre `172.16.50.0/24`, sors par `port2` et donne le paquet à `192.168.10.254` ».

> ⚠️ **Attention — la passerelle doit être joignable directement**
> Le prochain saut doit se trouver sur un réseau **directement connecté** au pare-feu. Écrire `set gateway 8.8.8.8` sur une interface en `192.168.10.1/24` ne fonctionne pas : le pare-feu n'a aucun moyen de joindre `8.8.8.8` autrement qu'en passant par… la route qu'il est en train de définir. FortiOS refusera généralement, ou la route restera inactive.

### 7.4 🧠 Comprendre : distance administrative et priorité

Ce sont **deux notions différentes** que tout le monde confond, et la confusion coûte cher en diagnostic. Prenons le temps de bien les séparer.

**La distance administrative (`distance`) — quelle route entre dans la table ?**

Quand plusieurs sources proposent une route vers le même réseau, FortiOS ne garde que celle dont la distance est **la plus faible**. Les autres n'entrent même pas dans la table de routage : elles restent en réserve.

| Source | Distance par défaut |
|---|---|
| Connecté | 0 |
| Statique | 10 |
| eBGP | 20 |
| OSPF | 110 |
| RIP | 120 |
| iBGP | 200 |

> 📖 **Le sais-tu ?** La distance statique par défaut de FortiOS est **10**, alors que chez Cisco c'est **1**. Une différence à connaître si tu viens du monde Cisco : une route statique FortiOS est moins « prioritaire » qu'une statique Cisco face à un protocole dynamique de distance intermédiaire.

**La priorité (`priority`) — quelle route est utilisée quand elles sont à égalité ?**

Si deux routes ont la **même** destination et la **même** distance, elles entrent **toutes les deux** dans la table, et FortiOS répartit le trafic entre elles (ECMP). La `priority` départage : **la plus faible gagne**.

**La différence concrète, avec deux opérateurs :**

```
config router static
    edit 1
        set gateway 192.168.100.1
        set device "port1"
        set distance 10
        set priority 5              ← chemin préféré
        set comment "Operateur principal"
    next
    edit 2
        set gateway 192.168.101.1
        set device "port4"
        set distance 10             ← MEME distance
        set priority 10             ← moins prioritaire
        set comment "Operateur de secours"
    next
end
```

Les deux routes sont dans la table. Le trafic emprunte l'opérateur principal. Si `port1` tombe, l'autre prend le relais **instantanément**, sans recalcul.

Compare avec l'autre approche :

```
    edit 2
        set distance 20             ← distance PLUS GRANDE
```

Ici, la route de secours n'est **pas** dans la table du tout. Elle y entre seulement quand la première disparaît. C'est ce qu'on appelle une **route flottante**.

| Approche | Les deux routes sont-elles dans la table ? | Comportement |
|---|---|---|
| Même distance, priorités différentes | ✅ Oui | Bascule immédiate, ECMP possible |
| Distances différentes | ❌ Non, une seule | La secondaire attend que la première tombe |

> ⚠️ **Attention — le piège de l'égalité parfaite**
> Si tu crées deux routes par défaut avec **la même distance ET la même priorité**, FortiOS fait de l'**ECMP** : il répartit les sessions entre les deux opérateurs.
>
> Ça semble idéal — deux fois plus de débit ! — mais ça casse des choses en pratique : les sessions d'un même utilisateur partent alternativement par deux adresses publiques différentes, et beaucoup de sites web (banques, services d'authentification) invalident la session quand l'adresse source change en cours de route. Tes utilisateurs seront déconnectés au hasard.
>
> Pour faire de la répartition proprement, **utilise le SD-WAN** (section 20), qui a été inventé exactement pour ça et sait maintenir une session sur un même lien.

### 7.5 Le routage par politique (Policy Route)

La table de routage décide en fonction de **la destination uniquement**. Parfois, ça ne suffit pas.

Exemple réel : « le trafic de la comptabilité doit sortir par l'opérateur A, celui du reste de l'entreprise par l'opérateur B ». La destination est la même (Internet) ; c'est la **source** qui doit décider. Une route statique ne sait pas faire ça.

Le **routage par politique** (*policy route*, aussi appelé PBR) le permet :

```
config router policy
    edit 1
        set input-device "port2"
        set srcaddr "Reseau-Compta"
        set dstaddr "all"
        set protocol 6
        set start-port 443
        set end-port 443
        set output-device "port4"
        set gateway 192.168.101.1
        set comment "La compta sort par l operateur B"
    next
end
```

> ⚠️ **Attention — les routes par politique passent AVANT tout le reste**
> C'est le point capital, et la source d'un diagnostic classique : **une route par politique est évaluée avant la table de routage**. Si une politique de routage correspond au paquet, la table de routage n'est **jamais consultée**.
>
> Le symptôme typique : « ma route statique est bien là, `get router info routing-table` la montre, et le trafic part quand même ailleurs ». Réflexe à avoir :
> ```
> FGT-01 # show router policy
> FGT-01 # diagnose firewall proute list
> ```
> C'est presque toujours une route par politique oubliée.

### 7.6 Le suivi de lien (Link Monitor)

Une route statique a un défaut grave : elle reste active tant que **l'interface** est up. Or l'interface peut être parfaitement up alors que l'opérateur est en panne trois routeurs plus loin. Résultat : ton pare-feu continue d'envoyer tout le trafic dans un trou noir.

Le **link monitor** corrige ça en testant réellement la connectivité :

```
config system link-monitor
    edit "surveillance-wan1"
        set srcintf "port1"
        set server "8.8.8.8" "1.1.1.1"
        set protocol ping
        set gateway-ip 192.168.100.1
        set interval 5
        set timeout 2
        set failtime 3
        set recoverytime 3
        set update-cascade-interface enable
        set update-static-route enable
        set status enable
    next
end
```

Décryptage :

| Paramètre | Rôle |
|---|---|
| `server` | Les cibles à tester. **Mets-en plusieurs** — si tu n'en surveilles qu'une et qu'elle tombe, tu bascules pour rien |
| `interval` | Un test toutes les 5 secondes |
| `failtime 3` | 3 échecs consécutifs → le lien est déclaré mort |
| `recoverytime 3` | 3 succès consécutifs → il est déclaré revenu |
| `update-static-route enable` | ⭐ **Retire les routes statiques** de cette interface quand le lien est mort |

C'est `update-static-route` qui fait tout le travail : la route par défaut de `port1` disparaît, la route de secours prend le relais.

Vérification :

```
FGT-01 # diagnose sys link-monitor status
```

> 💡 **Astuce** : `failtime 3` avec `interval 5` donne une détection en 15 secondes. Descendre trop bas (`failtime 1`) rend le système nerveux : la moindre perte de paquet fait basculer tout le trafic. Trois échecs sur cinq secondes est un bon compromis en production.

---

### 🧪 TP 5 — Router, casser, observer

**🎯 Objectif**
Créer une route par défaut, vérifier la table, ajouter une route de secours, puis **provoquer une panne** et observer la bascule. C'est le TP qui t'apprend le plus sur le routage, parce qu'on ne comprend une route de secours qu'en la voyant prendre le relais.

**⏱️ Durée** : 30 minutes

**📋 Prérequis** : TP 4 terminé

---

**🔧 Manipulation**

**Étape 1 — Observer l'état initial**

```
FGT-01 # get router info routing-table all
```

Tu vois tes routes connectées. Si `port1` est en DHCP, tu as peut-être déjà une route par défaut apprise automatiquement.

```
FGT-01 # get router info routing-table static
```

**Étape 2 — Regarder la base de routage complète**

Il existe une vue plus riche que la table : la **RIB**, qui contient aussi les routes candidates non retenues.

```
FGT-01 # get router info routing-table database
```
```
Codes: K - kernel, C - connected, S - static
       > - selected route, * - FIB route

S    *> 0.0.0.0/0 [10/0] via 192.168.100.1, port1
C    *> 192.168.10.0/24 is directly connected, port2
C    *> 192.168.20.0/24 is directly connected, port3
```

> 🧠 **Comprendre — RIB et FIB**
> La **RIB** (*Routing Information Base*) est **tout ce que le pare-feu sait** : toutes les routes apprises, retenues ou non.
> La **FIB** (*Forwarding Information Base*) est **ce qu'il utilise vraiment** pour acheminer les paquets.
>
> Le `>` marque les routes sélectionnées, le `*` celles qui sont dans la FIB. Une route présente dans la RIB sans `*` est connue mais inutilisée — typiquement une route flottante qui attend son heure.
>
> C'est une distinction précieuse en diagnostic : elle te dit si ta route est **absente** (problème de configuration) ou **présente mais non retenue** (problème de distance).

**Étape 3 — Créer explicitement la route par défaut**

Si `port1` est en statique, ou pour la maîtriser :

```
FGT-01 # config router static
FGT-01 (static) # edit 1
FGT-01 (1) # set dst 0.0.0.0 0.0.0.0
FGT-01 (1) # set gateway 192.168.100.1
FGT-01 (1) # set device "port1"
FGT-01 (1) # set distance 10
FGT-01 (1) # set priority 5
FGT-01 (1) # set comment "Defaut - operateur principal"
FGT-01 (1) # next
FGT-01 (static) # end
```

> ⚠️ **Attention** : adapte `192.168.100.1` à la passerelle réelle de ton réseau « WAN ». Si `port1` est en DHCP, retrouve-la avec :
> ```
> FGT-01 # get system interface port1 | grep gateway
> ```

**Étape 4 — Tester depuis le pare-feu**

```
FGT-01 # execute ping 8.8.8.8
```

Si ça répond, ta route par défaut fonctionne.

Si ça ne répond pas, teste par étapes — c'est la bonne méthode de diagnostic :

```
FGT-01 # execute ping 192.168.100.1      ← la passerelle répond-elle ?
FGT-01 # get router info routing-table all   ← la route est-elle là ?
FGT-01 # execute traceroute 8.8.8.8      ← où ça s'arrête ?
```

**Étape 5 — Ajouter une route flottante**

On simule un second opérateur. Même si tu n'as qu'une seule sortie, l'exercice fonctionne :

```
FGT-01 # config router static
FGT-01 (static) # edit 2
FGT-01 (2) # set dst 0.0.0.0 0.0.0.0
FGT-01 (2) # set gateway 192.168.10.254
FGT-01 (2) # set device "port2"
FGT-01 (2) # set distance 20
FGT-01 (2) # set comment "Defaut - secours (fictif)"
FGT-01 (2) # next
FGT-01 (static) # end
```

**Étape 6 — Vérifier qu'elle n'est PAS utilisée**

```
FGT-01 # get router info routing-table all
```

Tu ne vois **qu'une seule** route par défaut : celle de distance 10.

```
FGT-01 # get router info routing-table database
```

Là, tu vois **les deux**, mais seule celle de distance 10 porte le `*>`.

> 🧠 C'est exactement la démonstration du §7.4. La route de secours existe, elle est connue, elle n'est pas utilisée. Elle attend.

**Étape 7 — Provoquer la panne**

```
FGT-01 # config system interface
FGT-01 (interface) # edit port1
FGT-01 (port1) # set status down
FGT-01 (port1) # next
FGT-01 (interface) # end
```

> 🚨 **Danger** : si tu administres le pare-feu **par `port1`**, tu viens de te couper l'accès. Fais cette étape depuis la **console de l'hyperviseur**, ou depuis un poste du LAN branché sur `port2`. Je te préviens sérieusement : c'est la façon la plus courante de perdre la main sur un pare-feu.

**Étape 8 — Observer la bascule**

```
FGT-01 # get router info routing-table all
```

La route par défaut de `port1` a **disparu** (son interface est down), et celle de distance 20 a pris sa place.

```
FGT-01 # get router info routing-table database
```

Le `*>` s'est déplacé sur la route de secours.

**Tu viens d'observer une bascule automatique.** C'est le mécanisme qui, en production, maintient une entreprise connectée quand son opérateur principal tombe.

**Étape 9 — Rétablir**

```
FGT-01 # config system interface
FGT-01 (interface) # edit port1
FGT-01 (port1) # set status up
FGT-01 (port1) # next
FGT-01 (interface) # end

FGT-01 # get router info routing-table all
```

La route principale revient et reprend la main. Ce retour automatique s'appelle le *failback*.

**Étape 10 — Nettoyer**

```
FGT-01 # config router static
FGT-01 (static) # delete 2
FGT-01 (static) # end
```

---

**✅ Résultat attendu**

- `get router info routing-table all` montre les connectées et la route par défaut
- `execute ping 8.8.8.8` répond (si ton lab a Internet)
- La route de distance 20 est **dans la base** mais **pas dans la table**
- L'extinction de `port1` fait basculer la route par défaut
- La remise en service la fait revenir

---

**🧠 Ce que tu viens d'apprendre**

1. **Les routes connectées sont automatiques.** Leur absence signale une interface morte, pas un problème de routage.
2. **RIB et FIB sont deux choses différentes.** `routing-table database` montre ce que le pare-feu sait, `routing-table all` ce qu'il utilise.
3. **La distance décide qui entre dans la table ; la priorité départage les ex æquo.**
4. **Une route flottante est un vrai mécanisme de secours**, et tu l'as vue fonctionner.
5. **Une route disparaît quand son interface tombe** — d'où l'utilité du link monitor quand l'interface reste up mais que l'opérateur est mort.
6. **Le routage ne suffit pas à faire passer le trafic.** Ton PC-LAN ne joint toujours pas la DMZ, alors que les routes sont parfaites. Il manque les politiques : c'est la section 9.

---

# Partie III — Le cœur du pare-feu

---

## 8. Les objets : adresses, services, horaires

On arrive au cœur du métier. Mais avant d'écrire une politique, il faut fabriquer le vocabulaire avec lequel on va l'écrire. C'est le rôle des **objets**.

### 8.1 Pourquoi des objets plutôt que des adresses en dur

Sur beaucoup de pare-feux, on écrit directement `192.168.10.0/24` dans une règle. FortiOS ne le permet pas : il **exige** que tu nommes d'abord ce réseau, puis que tu utilises ce nom.

C'est agaçant les dix premières minutes, puis on comprend que c'est un des meilleurs choix de conception de FortiOS. Trois raisons :

**1. Ça se relit.** Compare :
```
srcaddr 192.168.10.0/24  →  dstaddr 172.16.44.0/24  →  port 3389
srcaddr "Postes-Support" →  dstaddr "Serveurs-RH"   →  service "RDP"
```
La deuxième ligne se comprend sans documentation. La première demande une enquête.

**2. Ça se modifie en un seul endroit.** Le jour où le réseau des postes change de plage, tu modifies **l'objet**, et les trente politiques qui l'utilisent suivent automatiquement. Avec des adresses en dur, tu en oublies une — et l'oubli est silencieux.

**3. Ça se contrôle.** Souviens-toi du TP 3 : FortiOS **refuse** de supprimer un objet utilisé. Impossible de casser une politique par accident.

### 8.2 Les types d'objets adresse

C'est là que FortiOS devient intéressant, parce qu'un « objet adresse » est bien plus qu'une adresse.

| Type | Ce qu'il représente | Cas d'usage |
|---|---|---|
| `ipmask` | Un réseau ou un hôte | Le plus courant |
| `iprange` | Une plage continue | `.10` à `.50` |
| `fqdn` | Un **nom de domaine** | ⭐ Voir §8.4 |
| `geography` | Un **pays entier** | ⭐ Voir §8.5 |
| `dynamic` | Un objet piloté par un connecteur externe | Cloud, SDN |
| `mac` | Une adresse MAC | Filtrage niveau 2 |
| `interface-subnet` | Le sous-réseau d'une interface | Suit automatiquement |

**Un hôte unique** — note le masque en `/32` :

```
config firewall address
    edit "SRV-WEB-DMZ"
        set subnet 192.168.20.10 255.255.255.255
        set comment "Serveur web de la DMZ"
        set color 3
    next
end
```

**Un réseau :**

```
config firewall address
    edit "Reseau-LAN"
        set subnet 192.168.10.0 255.255.255.0
    next
end
```

**Une plage :**

```
config firewall address
    edit "Plage-Imprimantes"
        set type iprange
        set start-ip 192.168.10.200
        set end-ip 192.168.10.220
    next
end
```

> 💡 **Astuce** : `set color` donne une couleur à l'objet dans l'interface web. Ça paraît futile ; sur un pare-feu qui compte 300 objets, coder par couleur (rouge = externe, vert = interne, orange = DMZ) fait gagner un temps réel à la lecture.

### 8.3 Les conventions de nommage

Personne ne t'y oblige, et c'est pourtant ce qui distingue une configuration tenable d'une configuration qu'on finit par ne plus oser toucher.

Un schéma qui marche : **`TYPE-ZONE-DESCRIPTION`**

```
NET-LAN-Utilisateurs
NET-DMZ-Serveurs
HOST-DMZ-Web01
HOST-LAN-Imprimante-Compta
RANGE-LAN-DHCP
GRP-Serveurs-Publies
FQDN-Microsoft-Update
GEO-France
```

Trois règles qui comptent plus que le schéma choisi :

- **Pas d'espaces** — ils obligent à des guillemets partout en CLI et cassent la moitié des scripts
- **Pas d'accents** — même raison, et certains contextes les rendent mal
- **Cohérence** — un schéma imparfait appliqué partout vaut mieux que trois schémas parfaits mélangés

> ⚠️ **Attention** : renommer un objet plus tard est possible (`rename`), et FortiOS met à jour toutes les références. Mais si tu as des scripts, des sauvegardes ou de la documentation qui citent l'ancien nom, ils deviennent faux en silence. Choisis bien du premier coup.

### 8.4 🧠 Les objets FQDN : puissants et traîtres

Un objet **FQDN** contient un nom de domaine plutôt qu'une adresse. Le pare-feu résout ce nom et met la règle à jour tout seul quand l'adresse change.

```
config firewall address
    edit "FQDN-Windows-Update"
        set type fqdn
        set fqdn "update.microsoft.com"
    next
end
```

C'est séduisant : « j'autorise `github.com` » est exactement ce qu'on veut exprimer. Mais il y a **trois pièges**, et ils sont sérieux.

**Piège 1 — Le pare-feu doit pouvoir résoudre le nom.** Si le DNS du FortiGate ne fonctionne pas, l'objet ne contient **aucune adresse**, et la politique qui l'utilise ne correspond à rien. Elle ne bloque pas : elle ne *matche* pas, donc le paquet continue vers les règles suivantes — et finit sur l'`Implicit Deny`. Symptôme : « ma règle a cessé de fonctionner sans que rien n'ait changé ». Vérifie toujours :

```
FGT-01 # diagnose firewall fqdn list
```

**Piège 2 — Les grands services ont des centaines d'adresses tournantes.** `google.com` résout vers une adresse différente selon le moment et le lieu. Le pare-feu ne connaît que celles qu'il a lui-même résolues. Un client peut très bien obtenir de son DNS une adresse que le pare-feu n'a jamais vue — et se faire bloquer.

**Piège 3 — C'est contournable.** Un objet FQDN se résume in fine à une liste d'adresses. Rien n'empêche quelqu'un de joindre la même adresse en tapant l'IP directement.

> ⚠️ **La règle à retenir**
> Les objets FQDN sont excellents pour **autoriser** un service précis à adresse changeante (mises à jour, service SaaS d'un partenaire).
> Ils sont **mauvais pour bloquer** : pour interdire des sites web, utilise le **filtrage web** (section 14), qui travaille sur le nom réellement demandé dans la requête et non sur une résolution DNS faite par le pare-feu.

### 8.5 Les objets géographiques

Ils représentent **toutes les plages d'adresses attribuées à un pays**.

```
config firewall address
    edit "GEO-Corée-du-Nord"
        set type geography
        set country "KP"
    next
end
```

Usage typique : tu publies un service qui ne concerne que la France, tu bloques tout le reste. Ça réduit énormément le bruit de fond des scans automatisés.

> ⚠️ **Attention — deux limites à connaître**
> La base géographique vient de **FortiGuard** : sans abonnement, elle ne se met plus à jour, et les attributions d'adresses changent régulièrement.
> Et surtout : **un attaquant sérieux utilise un relais dans le pays autorisé.** Le filtrage géographique réduit le bruit ; il n'arrête pas une attaque ciblée. Ne le prends pas pour une protection.

### 8.6 Les groupes

Un groupe rassemble plusieurs objets sous un seul nom. C'est la clé pour tenir dans la limite des trois politiques (§3.3) :

```
config firewall addrgrp
    edit "GRP-Serveurs-DMZ"
        set member "SRV-WEB-DMZ" "SRV-MAIL-DMZ" "SRV-FTP-DMZ"
        set comment "Tous les serveurs publies"
    next
end
```

> 💡 **Astuce** : un groupe peut contenir un autre groupe. Utile pour construire des hiérarchies (`GRP-Tous-Serveurs` contenant `GRP-Serveurs-DMZ` et `GRP-Serveurs-Internes`). Ne descends pas trop profond : au-delà de deux niveaux, plus personne ne sait ce qu'il y a dedans.

### 8.7 Les services

Un **service** décrit un protocole et des ports. FortiOS en fournit plus d'une centaine de prédéfinis.

```
FGT-01 # show firewall service custom | grep "edit"
```

Tu y trouves `HTTP`, `HTTPS`, `DNS`, `SSH`, `PING`, `RDP`, `SMTP`, `ALL`…

**Créer un service personnalisé :**

```
config firewall service custom
    edit "APP-Metier-8443"
        set tcp-portrange 8443
        set comment "Application metier interne"
    next
end
```

**Plusieurs ports :**

```
config firewall service custom
    edit "APP-Multi-Ports"
        set tcp-portrange 8080 8443 9000-9010
    next
end
```

**TCP et UDP ensemble :**

```
config firewall service custom
    edit "APP-Mixte"
        set tcp-portrange 5000
        set udp-portrange 5000-5010
    next
end
```

> 🧠 **Comprendre — la notation port source:port destination**
> FortiOS accepte une syntaxe étendue : `destination:source`.
> ```
> set tcp-portrange 443:1024-65535
> ```
> signifie « port destination 443, **avec** un port source entre 1024 et 65535 ». On s'en sert rarement, mais tu la croiseras dans certains services prédéfinis et il vaut mieux savoir la lire que la prendre pour une plage bizarre.

**Un groupe de services :**

```
config firewall service group
    edit "GRP-Web"
        set member "HTTP" "HTTPS" "DNS"
    next
end
```

> ⚠️ **Attention — le service `ALL`**
> Il existe un service prédéfini nommé `ALL` qui correspond à **tous les protocoles et tous les ports**. Il est pratique pour tester, et c'est un aimant à mauvaises habitudes.
>
> Une politique en `service ALL` autorise tout : le web, mais aussi SSH, RDP, SMB, et le canal de commande d'un logiciel malveillant. **Utilise-le pour diagnostiquer, jamais comme état final.** On y reviendra en section 25 — c'est l'erreur classique numéro un.

### 8.8 Les horaires

Un objet **schedule** limite une politique à une plage de temps.

**Récurrent** — tous les jours ouvrés, aux heures de bureau :

```
config firewall schedule recurring
    edit "Heures-Bureau"
        set day monday tuesday wednesday thursday friday
        set start 08:00
        set end 18:30
    next
end
```

**Ponctuel** — une fenêtre unique, par exemple pour un prestataire :

```
config firewall schedule onetime
    edit "Intervention-Prestataire"
        set start 09:00 2026/09/15
        set end 17:00 2026/09/15
    next
end
```

> 💡 **Astuce — le cas d'usage qui vaut de l'or**
> Un accès temporaire pour un prestataire externe, avec un `onetime`, **se ferme tout seul**. C'est infiniment plus fiable que « je penserai à le retirer vendredi » — parce que non, tu n'y penseras pas, et cette règle sera encore ouverte dans trois ans. J'ai vu des audits de sécurité entiers construits sur ce genre d'oubli.
>
> Et ça ne marche que si l'horloge est juste. Retour au §4.2. 😉

> ⚠️ **Attention** : le schedule prédéfini `always` est celui qu'utilisent la plupart des politiques. Il est obligatoire dans une politique — pas de schedule, pas de politique.

### 8.9 Les objets Internet Service

FortiOS embarque une base, mise à jour par FortiGuard, qui associe des **noms de services connus** à leurs plages d'adresses réelles : Microsoft Office 365, AWS, Google, Salesforce…

```
config firewall policy
    edit 10
        set name "Autoriser Office 365"
        set srcintf "port2"
        set dstintf "port1"
        set srcaddr "Reseau-LAN"
        set internet-service enable
        set internet-service-name "Microsoft-Office365"
        set action accept
        set schedule "always"
        set nat enable
    next
end
```

C'est la bonne réponse au piège du FQDN (§8.4) pour les grands services : Fortinet maintient la liste des plages, tu n'as rien à résoudre toi-même.

> ⚠️ **Attention** : quand `internet-service` est activé, il **remplace** le `dstaddr` — tu ne peux pas utiliser les deux dans la même politique. FortiOS te le dira, mais autant le savoir.

---

### 🧪 TP 6 — Construire le vocabulaire du laboratoire

**🎯 Objectif**
Créer tous les objets dont on aura besoin dans les sections suivantes : réseaux, hôtes, groupes, services personnalisés, horaires. Et voir concrètement pourquoi un groupe économise des politiques.

**⏱️ Durée** : 25 minutes

**📋 Prérequis** : TP 4 terminé

---

**🔧 Manipulation**

**Étape 1 — Les réseaux du laboratoire**

```
FGT-01 # config firewall address
FGT-01 (address) # edit "NET-LAN"
FGT-01 (NET-LAN) # set subnet 192.168.10.0 255.255.255.0
FGT-01 (NET-LAN) # set comment "Reseau des postes utilisateurs"
FGT-01 (NET-LAN) # set color 2
FGT-01 (NET-LAN) # next
FGT-01 (address) # edit "NET-DMZ"
FGT-01 (NET-DMZ) # set subnet 192.168.20.0 255.255.255.0
FGT-01 (NET-DMZ) # set comment "Reseau des serveurs publies"
FGT-01 (NET-DMZ) # set color 3
FGT-01 (NET-DMZ) # next
FGT-01 (address) # end
```

**Étape 2 — Les hôtes**

```
FGT-01 # config firewall address
FGT-01 (address) # edit "HOST-PC-LAN"
FGT-01 (HOST-PC-LAN) # set subnet 192.168.10.10 255.255.255.255
FGT-01 (HOST-PC-LAN) # set comment "Poste de test du LAN"
FGT-01 (HOST-PC-LAN) # next
FGT-01 (address) # edit "HOST-SRV-DMZ"
FGT-01 (HOST-SRV-DMZ) # set subnet 192.168.20.10 255.255.255.255
FGT-01 (HOST-SRV-DMZ) # set comment "Serveur web de la DMZ"
FGT-01 (HOST-SRV-DMZ) # next
FGT-01 (address) # end
```

**Étape 3 — Une plage**

```
FGT-01 # config firewall address
FGT-01 (address) # edit "RANGE-LAN-Imprimantes"
FGT-01 (RANGE-LAN-Imprimantes) # set type iprange
FGT-01 (RANGE-LAN-Imprimantes) # set start-ip 192.168.10.200
FGT-01 (RANGE-LAN-Imprimantes) # set end-ip 192.168.10.220
FGT-01 (RANGE-LAN-Imprimantes) # next
FGT-01 (address) # end
```

**Étape 4 — Un groupe**

```
FGT-01 # config firewall addrgrp
FGT-01 (addrgrp) # edit "GRP-Reseaux-Internes"
FGT-01 (GRP-Reseaux-Internes) # set member "NET-LAN" "NET-DMZ"
FGT-01 (GRP-Reseaux-Internes) # set comment "Tous les reseaux internes"
FGT-01 (GRP-Reseaux-Internes) # next
FGT-01 (addrgrp) # end
```

> 🧠 **Comprendre — ce que tu viens d'économiser**
> Sans ce groupe, autoriser le LAN **et** la DMZ vers Internet demanderait **deux politiques**. Avec lui, **une seule** suffit. Sur une licence limitée à trois politiques, tu viens d'en récupérer une — et en production, tu viens d'éviter la duplication qui finit toujours par diverger.

**Étape 5 — Un service personnalisé**

Notre serveur DMZ écoute en HTTP sur 80, mais imaginons une application sur 8080 :

```
FGT-01 # config firewall service custom
FGT-01 (custom) # edit "SVC-App-8080"
FGT-01 (SVC-App-8080) # set tcp-portrange 8080
FGT-01 (SVC-App-8080) # set comment "Application metier de test"
FGT-01 (SVC-App-8080) # set category "Web Access"
FGT-01 (SVC-App-8080) # next
FGT-01 (custom) # end
```

**Étape 6 — Un groupe de services**

```
FGT-01 # config firewall service group
FGT-01 (group) # edit "GRP-SVC-Web"
FGT-01 (GRP-SVC-Web) # set member "HTTP" "HTTPS" "DNS"
FGT-01 (GRP-SVC-Web) # set comment "Navigation web de base"
FGT-01 (GRP-SVC-Web) # next
FGT-01 (group) # end
```

**Étape 7 — Un horaire**

```
FGT-01 # config firewall schedule recurring
FGT-01 (recurring) # edit "Heures-Bureau"
FGT-01 (Heures-Bureau) # set day monday tuesday wednesday thursday friday
FGT-01 (Heures-Bureau) # set start 08:00
FGT-01 (Heures-Bureau) # set end 18:30
FGT-01 (Heures-Bureau) # next
FGT-01 (recurring) # end
```

**Étape 8 — Un objet FQDN, et le vérifier**

```
FGT-01 # config firewall address
FGT-01 (address) # edit "FQDN-Test"
FGT-01 (FQDN-Test) # set type fqdn
FGT-01 (FQDN-Test) # set fqdn "www.fortinet.com"
FGT-01 (FQDN-Test) # next
FGT-01 (address) # end
```

Maintenant, regarde ce que le pare-feu a **réellement** résolu :

```
FGT-01 # diagnose firewall fqdn list
```

Tu vois les adresses associées au nom. **S'il n'y en a aucune, ton DNS ne fonctionne pas** — c'est exactement le piège 1 du §8.4, et tu viens de voir comment le détecter.

Si la liste est vide, vérifie le DNS du pare-feu :

```
FGT-01 # show system dns
FGT-01 # execute ping www.fortinet.com
```

**Étape 9 — Vérifier l'ensemble**

```
FGT-01 # show firewall address | grep "edit"
FGT-01 # show firewall addrgrp
FGT-01 # show firewall service custom | grep "edit \"SVC"
FGT-01 # show firewall schedule recurring
```

---

**✅ Résultat attendu**

- `NET-LAN`, `NET-DMZ`, `HOST-PC-LAN`, `HOST-SRV-DMZ`, `RANGE-LAN-Imprimantes` existent
- `GRP-Reseaux-Internes` contient bien deux membres
- `SVC-App-8080` et `GRP-SVC-Web` existent
- `Heures-Bureau` couvre du lundi au vendredi
- `diagnose firewall fqdn list` montre des adresses résolues

---

**🧠 Ce que tu viens d'apprendre**

1. **FortiOS impose de nommer avant d'utiliser**, et c'est une force : lisibilité, modification centralisée, protection contre la suppression.
2. **Un objet adresse peut être bien plus qu'une adresse** : plage, nom de domaine, pays.
3. **Les groupes économisent des politiques** — vital avec la licence d'évaluation, et bonne pratique partout.
4. **Les objets FQDN dépendent du DNS du pare-feu**, et `diagnose firewall fqdn list` est la commande qui te le dit.
5. **Un horaire `onetime` ferme un accès temporaire tout seul**, ce qu'aucun rappel mental ne fait de façon fiable.

---

## 9. Les politiques de sécurité

Nous y voilà. C'est **la** section du tutoriel. Tout ce qu'on a fait jusqu'ici — interfaces, routes, objets — n'était que la préparation de ce moment : écrire les règles qui décident de ce qui passe.

Et on va enfin lever le blocage du TP 4.

### 9.1 Ce qu'est une politique

Une politique répond à six questions, toujours les mêmes :

| Question | Champ FortiOS |
|---|---|
| Le trafic **arrive** par où ? | `srcintf` (interface source) |
| Il **repart** par où ? | `dstintf` (interface destination) |
| Il **vient** de quelle adresse ? | `srcaddr` |
| Il **va** vers quelle adresse ? | `dstaddr` |
| C'est **quel** trafic ? | `service` |
| **Quand** ? | `schedule` |

Et une fois qu'on a répondu à ces six questions, on prend **une décision** : `accept` ou `deny`.

Voici la forme complète :

```
config firewall policy
    edit 1
        set name "LAN vers Internet"
        set srcintf "port2"
        set dstintf "port1"
        set srcaddr "NET-LAN"
        set dstaddr "all"
        set service "ALL"
        set schedule "always"
        set action accept
        set nat enable
        set logtraffic all
        set comments "Acces Internet des postes utilisateurs"
    next
end
```

> 💡 **Astuce** : donne **toujours** un `name` à tes politiques. Ce n'est pas obligatoire, mais une liste de règles numérotées sans nom devient illisible au-delà de dix. La GUI l'exige d'ailleurs depuis plusieurs versions.

### 9.2 🧠 Comprendre : l'ordre des politiques est TOUT

Si tu ne retiens qu'une chose de cette section, que ce soit celle-ci.

**FortiOS évalue les politiques de haut en bas, et s'arrête à la PREMIÈRE qui correspond.**

Pas la plus précise. Pas la plus restrictive. **La première rencontrée.** Toutes celles d'en dessous ne sont jamais évaluées.

Prenons un exemple qui fait mal :

```
Politique 1 : LAN → WAN, tout, ACCEPT
Politique 2 : LAN → WAN, service SSH, DENY
```

Question : le SSH est-il bloqué ?

**Non.** Le trafic SSH correspond à la politique 1 (qui autorise tout), la décision est prise, et la politique 2 n'est **jamais lue**. Elle est morte, sans que rien ne le signale.

Dans le bon ordre :

```
Politique 1 : LAN → WAN, service SSH, DENY
Politique 2 : LAN → WAN, tout, ACCEPT
```

Là, le SSH tombe sur la règle 1 et se fait bloquer. Le reste continue vers la 2.

> ### 🔒 La règle d'or de l'ordonnancement
> **Du plus spécifique au plus général.**
> Les exceptions en haut, les règles larges en bas, et l'`Implicit Deny` tout en bas qui ramasse le reste.

**Comment réordonner :**

```
config firewall policy
    move 5 before 2
    move 3 after 7
end
```

Et pour vérifier l'ordre réel :

```
FGT-01 # show firewall policy | grep -e "edit" -e "set name"
```

> ⚠️ **Attention — l'identifiant n'est PAS l'ordre**
> Piège classique : le numéro après `edit` est un **identifiant**, pas une position. La politique 10 peut très bien être évaluée avant la politique 3, si quelqu'un l'a déplacée.
>
> **Ne déduis jamais l'ordre des numéros.** Regarde la liste, dans la GUI (qui l'affiche dans l'ordre réel) ou avec la commande ci-dessus.

### 9.3 L'`Implicit Deny`

Tout en bas de la liste se trouve une règle que tu ne peux ni voir dans la configuration, ni modifier, ni supprimer :

```
Implicit Deny : tout → tout, tout, tout, DENY
```

C'est elle qui bloquait ton ping du TP 4. Tout paquet qui arrive au bout de la liste sans avoir trouvé de règle meurt ici.

> 💡 **Astuce — journaliser l'Implicit Deny**
> Par défaut, il ne journalise pas. C'est dommage : c'est **la** source d'information sur ce que ton pare-feu refuse.
> ```
> config system settings
>     set gui-implicit-policy enable
> end
> ```
> Puis, dans la GUI, la règle implicite devient visible et on peut activer sa journalisation. En CLI, on obtient le même effet en créant une **politique explicite de refus** en dernière position, avec `set logtraffic all` — c'est d'ailleurs la bonne pratique, parce qu'une règle explicite est visible, documentable et modifiable.
>
> ```
> config firewall policy
>     edit 999
>         set name "DENY-ALL-Explicite"
>         set srcintf "any"
>         set dstintf "any"
>         set srcaddr "all"
>         set dstaddr "all"
>         set service "ALL"
>         set schedule "always"
>         set action deny
>         set logtraffic all
>     next
> end
> ```

### 9.4 Les champs importants au-delà des six

**`nat`** — active la traduction d'adresse source. Indispensable pour sortir vers Internet. C'est le sujet de la section 10.

**`logtraffic`** — trois valeurs, et le choix compte :

| Valeur | Effet |
|---|---|
| `disable` | Aucun journal. À éviter |
| `utm` | Journalise uniquement les événements de sécurité (virus détecté, site bloqué…) |
| `all` | ⭐ Journalise **toutes** les sessions |

> ⚠️ **Attention** : `logtraffic all` génère beaucoup de journaux. Sur un petit boîtier sans disque, la mémoire se remplit vite et les entrées les plus anciennes disparaissent. En production, on envoie les journaux vers un FortiAnalyzer ou un syslog externe (section 22).
>
> Mais en apprentissage, **mets `all` partout**. Tu as besoin de voir ce qui se passe, et c'est ce qui rendra les diagnostics possibles.

**`logtraffic-start`** — journalise **au début** de la session en plus de la fin. Utile pour voir les sessions longues qui n'ont pas encore fini.

**`inspection-mode`** — `flow` ou `proxy` (section 13).

**`status`** — `enable` ou `disable`. Désactiver une politique plutôt que la supprimer est souvent plus sage : tu peux la réactiver en une commande si tu t'es trompé.

**`action`** — `accept` ou `deny`.

> 💡 **Astuce** : sur une politique en `deny`, un champ supplémentaire apparaît :
> ```
> set send-deny-packet enable
> ```
> Par défaut, un refus est **silencieux** : le paquet est jeté, l'émetteur n'apprend rien et attend jusqu'à expiration. Avec `send-deny-packet`, le pare-feu renvoie un TCP RST, et l'application côté client reçoit un refus **immédiat**.
>
> Lequel choisir ? Pour du trafic **interne**, active-le : tes utilisateurs auront une erreur nette au lieu d'un gel de trente secondes, et ton support te remerciera. Depuis **Internet**, laisse-le désactivé : un silence n'apprend rien à un scanner, alors qu'un RST confirme qu'un équipement est là.

### 9.5 Le champ `srcintf` : `any` et les zones

Tu peux mettre `any` comme interface :

```
set srcintf "any"
```

C'est pratique et c'est dangereux. `any` signifie littéralement *n'importe quelle interface*, y compris celles que tu ajouteras dans six mois, y compris `port1` qui donne sur Internet.

> ⚠️ **Attention** : n'utilise `any` que dans des politiques de **refus**, ou dans des cas où tu as vraiment réfléchi. Pour une politique d'autorisation, **nomme explicitement les interfaces**. C'est une des différences entre une configuration écrite par quelqu'un qui sait et une configuration écrite par quelqu'un qui a suivi un tutoriel trop vite. 😉

---

### 🧪 TP 7 — Ta première politique, et lever le blocage

**🎯 Objectif**
Écrire les politiques qui font fonctionner le laboratoire : LAN vers Internet, LAN vers DMZ. Puis **prouver** l'ordonnancement en créant une exception. Et enfin voir la table de sessions.

**⏱️ Durée** : 40 minutes

**📋 Prérequis** : TP 6 terminé (les objets doivent exister)

---

**🔧 Manipulation**

**Étape 1 — La politique d'accès à Internet**

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # set name "LAN-vers-Internet"
FGT-01 (1) # set srcintf "port2"
FGT-01 (1) # set dstintf "port1"
FGT-01 (1) # set srcaddr "NET-LAN"
FGT-01 (1) # set dstaddr "all"
FGT-01 (1) # set service "ALL"
FGT-01 (1) # set schedule "always"
FGT-01 (1) # set action accept
FGT-01 (1) # set nat enable
FGT-01 (1) # set logtraffic all
FGT-01 (1) # set comments "Acces Internet des postes"
FGT-01 (1) # next
FGT-01 (policy) # end
```

Depuis le PC du LAN :

```bash
user@pc-lan:~$ ping -c 3 8.8.8.8
user@pc-lan:~$ curl -I http://www.fortinet.com
```

Si ton lab a un accès Internet, ça fonctionne. **Tu viens d'écrire ta première politique de sécurité.** 🎉

> 🧠 **Comprendre** : remarque qu'il n'y a **aucune** politique `port1 → port2`. Le trafic retour passe grâce à la table de sessions (§1.6). Tu vérifies à l'instant que la règle d'or est vraie.

**Étape 2 — Lever le blocage LAN → DMZ**

Souviens-toi : au TP 4 étape 6, `ping 192.168.20.10` échouait.

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 2
FGT-01 (2) # set name "LAN-vers-DMZ"
FGT-01 (2) # set srcintf "port2"
FGT-01 (2) # set dstintf "port3"
FGT-01 (2) # set srcaddr "NET-LAN"
FGT-01 (2) # set dstaddr "NET-DMZ"
FGT-01 (2) # set service "PING" "HTTP"
FGT-01 (2) # set schedule "always"
FGT-01 (2) # set action accept
FGT-01 (2) # set logtraffic all
FGT-01 (2) # set comments "Le LAN consulte les serveurs de la DMZ"
FGT-01 (2) # next
FGT-01 (policy) # end
```

Retente depuis le PC du LAN :

```bash
user@pc-lan:~$ ping -c 3 192.168.20.10
user@pc-lan:~$ curl http://192.168.20.10
```

**Ça marche.** 🎉

> 🧠 **Comprendre — pourquoi pas de `nat` ici ?**
> Parce que la DMZ est un réseau **interne**, joignable directement. Le serveur `192.168.20.10` sait répondre à `192.168.10.10` : le pare-feu route entre les deux, point.
>
> Le NAT ne sert que quand la destination **ne sait pas** revenir vers la source — typiquement Internet, qui ne connaît pas tes adresses privées. C'est tout le sujet de la section 10.

**Étape 3 — Vérifier que le service est bien restrictif**

On a autorisé `PING` et `HTTP` seulement. Teste autre chose :

```bash
user@pc-lan:~$ curl https://192.168.20.10
user@pc-lan:~$ ssh user@192.168.20.10
```

Ces deux commandes **échouent** (ou restent bloquées). C'est le résultat attendu : le service n'est pas dans la liste, donc la politique ne s'applique pas, donc `Implicit Deny`.

**Tu viens de vérifier qu'un pare-feu filtre vraiment par service.**

**Étape 4 — La démonstration de l'ordonnancement**

C'est l'étape la plus instructive du TP. On va bloquer le ping tout en laissant HTTP, **et se tromper d'ordre exprès**.

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 3
FGT-01 (3) # set name "BLOQUER-Ping-vers-DMZ"
FGT-01 (3) # set srcintf "port2"
FGT-01 (3) # set dstintf "port3"
FGT-01 (3) # set srcaddr "NET-LAN"
FGT-01 (3) # set dstaddr "NET-DMZ"
FGT-01 (3) # set service "PING"
FGT-01 (3) # set schedule "always"
FGT-01 (3) # set action deny
FGT-01 (3) # set logtraffic all
FGT-01 (3) # next
FGT-01 (policy) # end
```

Depuis le PC du LAN :

```bash
user@pc-lan:~$ ping -c 3 192.168.20.10
```

**Le ping passe toujours !** Alors qu'on vient d'écrire une règle qui l'interdit.

> 🧠 **Comprendre — pourquoi ?**
> Parce que la politique 2 (`LAN-vers-DMZ`, qui autorise `PING` et `HTTP`) est **avant** la politique 3. Le paquet ICMP tombe sur la 2, elle correspond, la décision est prise : `accept`. La politique 3 n'est **jamais lue**.
>
> C'est exactement l'exemple du §9.2, et tu viens de le reproduire de tes mains.

**Étape 5 — Corriger l'ordre**

```
FGT-01 # config firewall policy
FGT-01 (policy) # move 3 before 2
FGT-01 (policy) # end
```

Vérifie l'ordre réel :

```
FGT-01 # show firewall policy | grep -e "edit " -e "set name"
```
```
    edit 1
        set name "LAN-vers-Internet"
    edit 3
        set name "BLOQUER-Ping-vers-DMZ"
    edit 2
        set name "LAN-vers-DMZ"
```

Note bien : **3 est maintenant avant 2**, alors que son numéro est plus grand. Preuve que l'identifiant n'est pas l'ordre (§9.2).

Retente :

```bash
user@pc-lan:~$ ping -c 3 192.168.20.10       ← bloqué maintenant ❌
user@pc-lan:~$ curl http://192.168.20.10     ← fonctionne toujours ✅
```

**Le ping est bloqué, le HTTP passe.** Tu viens de faire fonctionner une exception, et surtout tu as vu de tes yeux que **seul l'ordre a changé**, pas les règles.

**Étape 6 — Regarder la table de sessions**

C'est le moment de vérifier ce qu'on affirme depuis le §1.6.

Depuis le PC du LAN, lance quelque chose de durable :

```bash
user@pc-lan:~$ curl http://192.168.20.10 --max-time 30
```

Pendant ce temps, sur le pare-feu :

```
FGT-01 # diagnose sys session filter dst 192.168.20.10
FGT-01 # diagnose sys session list
```

Tu obtiens une entrée du genre :

```
session info: proto=6 proto_state=01 duration=3 expire=3597 timeout=3600
state=log may_dirty
statistic(bytes/packets/allow_err): org=284/4/1 reply=1580/4/1
hook=post dir=org act=noop
policy_id=2 pol_uuid_idx=xxx auth_info=0 chk_client_info=0 vd=0
serial=00001a2b tos=ff/ff app_list=0 app=0
```

Décryptage des lignes qui comptent :

| Champ | Signification |
|---|---|
| `proto=6` | TCP (1 = ICMP, 17 = UDP) |
| `duration` | Depuis combien de secondes la session existe |
| `expire` / `timeout` | Quand elle sera oubliée |
| `org=` / `reply=` | Octets/paquets **aller** et **retour** — la preuve que le retour est suivi |
| **`policy_id=2`** | ⭐ **Quelle politique a autorisé cette session** |

> 🧠 **`policy_id` est la commande de diagnostic la plus utile de tout FortiOS.**
> Quand un utilisateur te dit « ça ne marche pas » ou « ça ne devrait pas marcher », cette ligne te dit **exactement quelle règle a décidé**. Plus de supposition, plus de lecture de la liste à l'œil : le pare-feu te donne la réponse.
>
> Retiens ces deux commandes, tu les taperas toute ta carrière :
> ```
> diagnose sys session filter dst <adresse>
> diagnose sys session list
> ```

**Étape 7 — Vider la table de sessions**

Après un changement de politique, les sessions **déjà établies** continuent selon l'ancienne règle. C'est normal — elles sont dans la table, elles ne repassent pas par l'évaluation.

D'où un symptôme déroutant : « j'ai modifié la règle et ça n'a rien changé ». Il faut vider :

```
FGT-01 # diagnose sys session filter dst 192.168.20.10
FGT-01 # diagnose sys session clear
```

> 🚨 **Danger** : `diagnose sys session clear` **sans filtre préalable** vide **TOUTE** la table de sessions du pare-feu. Toutes les connexions de tous les utilisateurs sont coupées d'un coup. En production, c'est une interruption de service.
>
> **Prends le réflexe de toujours poser un filtre avant.** Et vérifie le filtre :
> ```
> FGT-01 # diagnose sys session filter
> ```

**Étape 8 — Lire les journaux**

```
FGT-01 # execute log filter category 0
FGT-01 # execute log filter field policyid 3
FGT-01 # execute log display
```

Tu vois les paquets refusés par la politique 3 : la preuve que ton blocage travaille.

**Étape 9 — Compter les correspondances**

Il existe un compteur par politique :

```
FGT-01 # diagnose firewall iprope show 100004 1
```

Plus simple et plus lisible :

```
FGT-01 # get firewall policy
```

Chaque politique affiche ses octets et paquets.

> 💡 **Astuce professionnelle** : une politique dont le compteur reste à **zéro** depuis des mois est probablement **inutile** — ou bien elle est masquée par une règle placée au-dessus. Dans les deux cas, il faut aller voir. C'est la base du ménage annuel dans un jeu de règles, et le premier réflexe d'un audit.

**Étape 10 — Nettoyer pour la suite**

Rappel du §3.3 : avec la licence d'évaluation, tu es limité à trois politiques. Supprime la règle de blocage, on n'en a plus besoin :

```
FGT-01 # config firewall policy
FGT-01 (policy) # delete 3
FGT-01 (policy) # end
```

Garde les politiques 1 et 2.

---

**✅ Résultat attendu**

- PC-LAN atteint Internet ✅
- PC-LAN atteint le serveur DMZ en HTTP ✅
- PC-LAN ne peut PAS faire de SSH vers la DMZ ❌ (service non autorisé)
- Tu as vu une règle **ignorée** parce qu'elle était mal placée
- Tu as vu `move` corriger le comportement **sans changer les règles**
- `diagnose sys session list` te montre `policy_id`

---

**🧠 Ce que tu viens d'apprendre**

1. **Une politique répond à six questions**, puis prend une décision.
2. **L'ordre est tout.** Première correspondance gagne, le reste n'est jamais lu.
3. **L'identifiant n'est pas la position.** Ne déduis jamais l'ordre des numéros.
4. **Le trafic retour ne demande aucune politique**, et tu l'as vérifié.
5. **`policy_id` dans la table de sessions te dit qui a décidé.** C'est le diagnostic le plus direct de FortiOS.
6. **Les sessions établies survivent aux changements de règles.** D'où `session clear` — avec un filtre.
7. **Un compteur à zéro est un signal**, pas un détail.

---

### 9.6 Bonnes pratiques pour un jeu de règles tenable

Quelques principes qui font la différence entre une configuration qu'on maintient et une configuration qu'on n'ose plus toucher :

**1. Nomme tout.** Politiques, objets, services. Un nom explicite vaut dix commentaires.

**2. Commente le POURQUOI, pas le QUOI.** `set comments "Autorise HTTP"` est inutile : on le voit dans la règle. `set comments "Ticket 4471 - acces ERP demande par la DAF le 12/03"` te sauve dans deux ans, quand quelqu'un demandera si on peut supprimer cette règle.

**3. Du spécifique au général**, toujours.

**4. Une règle = un besoin.** Résiste à la tentation d'élargir une règle existante pour couvrir un nouveau cas : tu perds la trace de qui a besoin de quoi, et tu ne pourras plus la supprimer sans risque.

**5. Journalise.** Une règle sans journal est une règle dont tu ne sauras jamais si elle sert.

**6. Date la revue.** Un jeu de règles se relit une fois par an. Sans quoi tu accumules des autorisations pour des projets terminés depuis longtemps — et c'est exactement là que les attaquants trouvent leur chemin.

---

## 10. Le NAT : SNAT, IP Pool et VIP

Le NAT est le sujet qui embrouille le plus les débutants, parce qu'on lui donne un seul nom alors qu'il désigne **deux opérations opposées**. On va commencer par les séparer proprement, et tout deviendra simple.

### 10.1 🧠 Comprendre : NAT source et NAT destination

**NAT signifie *Network Address Translation*** — la réécriture des adresses dans les paquets. Il y a deux façons de le faire, et elles répondent à deux besoins qui n'ont rien à voir.

**Le NAT source (SNAT) — pour SORTIR**

Ton PC en `192.168.10.10` veut joindre `8.8.8.8`. Problème : `192.168.10.10` est une adresse **privée** (RFC 1918). Elle n'existe pas sur Internet, aucun routeur du monde ne sait la joindre. Si le paquet partait tel quel, la réponse n'aurait aucun moyen de revenir.

Le pare-feu réécrit donc l'**adresse source** :

```
Départ du PC   : source 192.168.10.10:54321  →  destination 8.8.8.8:443
Après le SNAT  : source 203.0.113.5:61000    →  destination 8.8.8.8:443
                        ↑ l'adresse publique du pare-feu
```

Le serveur répond à `203.0.113.5:61000`, le pare-feu retrouve dans sa table à qui ça correspond, et remet l'adresse d'origine.

**Le NAT destination (DNAT) — pour ENTRER**

Un visiteur sur Internet veut joindre ton serveur web, qui est en `192.168.20.10` — adresse privée, injoignable de l'extérieur. Il se connecte donc à ton **adresse publique**, et le pare-feu réécrit l'**adresse destination** :

```
Arrivée sur le FGT : source 198.51.100.7  →  destination 203.0.113.5:443
Après le DNAT      : source 198.51.100.7  →  destination 192.168.20.10:443
                                                       ↑ le vrai serveur
```

**Le tableau qui résume tout :**

| | SNAT | DNAT |
|---|---|---|
| **Sens** | Interne → Externe | Externe → Interne |
| **Ce qui est réécrit** | L'adresse **source** | L'adresse **destination** |
| **À quoi ça sert** | Sortir sur Internet | Publier un serveur |
| **Objet FortiOS** | `set nat enable` + IP Pool | **VIP** (*Virtual IP*) |
| **Qui initie** | Ton utilisateur | Quelqu'un de l'extérieur |

> 💡 **Le moyen mnémotechnique** : SNAT réécrit la **S**ource, pour **S**ortir. DNAT réécrit la **D**estination, pour **D**escendre chez toi.

### 10.2 Le SNAT le plus simple

C'est celui que tu as déjà fait au TP 7 sans le savoir :

```
config firewall policy
    edit 1
        set name "LAN-vers-Internet"
        ...
        set nat enable          ← ⭐ c'est ça
    next
end
```

`set nat enable` sans autre précision veut dire : « réécris la source avec **l'adresse de l'interface de sortie** ». Dans le jargon, on appelle ça le mode *Use Outgoing Interface Address*.

C'est ce qu'on veut dans 90 % des cas, et ça n'exige aucune configuration supplémentaire.

> 🧠 **Comprendre — pourquoi un seul port ne suffirait pas**
> Si le pare-feu ne réécrivait que l'adresse, cent utilisateurs deviendraient tous `203.0.113.5` et il ne saurait plus à qui renvoyer les réponses.
>
> Il réécrit donc aussi le **port source**, en attribuant un numéro unique à chaque session. C'est pour ça qu'on parle souvent de **PAT** (*Port Address Translation*) ou de **NAT overload** : des milliers de machines derrière une seule adresse publique, distinguées par leur port.
>
> Conséquence pratique : une adresse publique offre environ 64 000 ports. Un pare-feu très chargé peut les épuiser — le symptôme est alors « certaines connexions échouent au hasard aux heures de pointe ». La commande qui le montre :
> ```
> FGT-01 # diagnose firewall ippool-all stats
> ```

### 10.3 Les IP Pools : choisir l'adresse de sortie

Parfois, tu ne veux **pas** que le trafic sorte avec l'adresse de l'interface. Par exemple : ton opérateur t'a donné un bloc `203.0.113.0/29`, et tu veux que les serveurs sortent avec `203.0.113.10` pendant que les postes sortent avec `203.0.113.5`.

C'est le rôle d'un **IP Pool**.

**Type `overload`** — le plus courant, plusieurs machines derrière une adresse :

```
config firewall ippool
    edit "POOL-Serveurs"
        set type overload
        set startip 203.0.113.10
        set endip 203.0.113.10
        set comments "Adresse de sortie des serveurs"
    next
end
```

Puis on l'utilise dans la politique :

```
config firewall policy
    edit 5
        ...
        set nat enable
        set ippool enable
        set poolname "POOL-Serveurs"
    next
end
```

**Les quatre types d'IP Pool**, parce qu'ils répondent à des besoins différents :

| Type | Comportement | Quand l'utiliser |
|---|---|---|
| `overload` | Plusieurs internes → une externe, distingués par port | Le cas normal |
| `one-to-one` | Une interne ↔ une externe, sans traduction de port | Quand un serveur doit toujours sortir avec la même adresse |
| `fixed-port-range` | Une plage de ports fixe par interne | Traçabilité (exigences légales) |
| `port-block-allocation` | Blocs de ports attribués par machine | Opérateurs, CGN |

> 💡 **Astuce — `one-to-one` a une propriété qu'on oublie**
> Un pool `one-to-one` crée aussi une correspondance **entrante** : l'adresse externe devient joignable et redirigée vers l'interne. C'est pratique, et c'est un trou si tu ne l'avais pas prévu — il faut quand même une politique entrante pour que ça passe, mais la traduction, elle, existe.

### 10.4 Les VIP : publier un serveur

Un **VIP** (*Virtual IP*) est l'objet qui réalise le DNAT. Il dit : « l'adresse publique X correspond en réalité au serveur interne Y ».

**Publication simple** — toute l'adresse est redirigée :

```
config firewall vip
    edit "VIP-Serveur-Web"
        set extip 192.168.100.200
        set extintf "port1"
        set mappedip "192.168.20.10"
        set comment "Publication du serveur web de la DMZ"
    next
end
```

**Publication d'un seul port** (redirection de port) — c'est le cas le plus fréquent :

```
config firewall vip
    edit "VIP-Web-443"
        set extip 192.168.100.200
        set extintf "port1"
        set mappedip "192.168.20.10"
        set portforward enable
        set protocol tcp
        set extport 443
        set mappedport 443
    next
end
```

> 💡 **Astuce — traduire aussi le port**
> `extport` et `mappedport` peuvent différer. Un grand classique : exposer le port 443 vers Internet alors que le serveur écoute en 8443 :
> ```
> set extport 443
> set mappedport 8443
> ```
> Le monde extérieur voit du HTTPS standard, le serveur reste sur son port applicatif.

### 10.5 ⚠️ Le piège du VIP : la destination, c'est le VIP

C'est **l'erreur numéro un** sur les VIP, et elle bloque tout le monde au moins une fois.

Un VIP tout seul **ne fait rien**. Il faut une politique qui l'utilise. Et dans cette politique, la destination n'est **pas** l'adresse interne du serveur : c'est **le VIP lui-même**.

❌ **Ce qui ne marche pas :**
```
config firewall policy
    edit 10
        set srcintf "port1"
        set dstintf "port3"
        set srcaddr "all"
        set dstaddr "HOST-SRV-DMZ"     ← ❌ FAUX
        ...
```

✅ **Ce qui marche :**
```
config firewall policy
    edit 10
        set name "Publication-Web"
        set srcintf "port1"
        set dstintf "port3"
        set srcaddr "all"
        set dstaddr "VIP-Web-443"      ← ✅ le VIP
        set service "HTTPS"
        set schedule "always"
        set action accept
        set logtraffic all
    next
end
```

> 🧠 **Comprendre — pourquoi ?**
> Parce que le DNAT a lieu **avant** l'évaluation des politiques (on verra l'ordre exact en section 11), mais les politiques sont écrites du point de vue de **ce que le paquet contenait en arrivant**. Le paquet qui arrive porte l'adresse publique. Le pare-feu attend donc que tu nommes cette adresse — c'est-à-dire le VIP.
>
> Une fois qu'on l'a compris, c'est logique. Avant de le comprendre, on tourne en rond.

> ⚠️ **Attention — et n'active PAS le NAT sur cette politique**
> Sur une politique de publication, `set nat enable` ferait du **SNAT** en plus du DNAT. Conséquence : le serveur verrait toutes les connexions arriver depuis l'adresse du pare-feu, et non depuis l'adresse réelle du visiteur.
>
> Tes journaux applicatifs deviendraient inutilisables, ton blocage d'adresses malveillantes aussi, et tes statistiques de fréquentation afficheraient un seul visiteur. Laisse `set nat disable`.

### 10.6 Le NAT central : un autre modèle

FortiOS propose **deux façons** de gérer le NAT, et il faut savoir que la seconde existe même si on ne l'utilise pas — parce que tomber dessus sans le savoir est déroutant.

**Le NAT par politique** (le défaut, celui de ce tutoriel) — chaque politique porte son propre `set nat enable`. Le NAT est décidé règle par règle.

**Le NAT central** — le NAT est sorti des politiques et centralisé dans une table dédiée :

```
config system settings
    set central-nat enable
end
```

À partir de là, **la case NAT disparaît des politiques**, et le SNAT se configure uniquement ici :

```
config firewall central-snat-map
    edit 1
        set srcintf "port2"
        set dstintf "port1"
        set orig-addr "NET-LAN"
        set dst-addr "all"
        set nat enable
        set nat-ippool "POOL-Serveurs"
    next
end
```

| | NAT par politique | NAT central |
|---|---|---|
| Où se décide le NAT | Dans chaque politique | Dans une table à part |
| Lisibilité | Tout est au même endroit | Il faut regarder deux tables |
| Souplesse | Suffisante presque toujours | Meilleure pour des règles NAT complexes |
| Qui l'utilise | La grande majorité | Environnements exigeants, migrations depuis d'autres marques |

> 🚨 **Danger** : activer `central-nat` **modifie les politiques existantes** et retire leur configuration NAT. Ce n'est pas un basculement anodin, et le retour arrière n'est pas propre non plus.
>
> **Le conseil qui compte : choisis un modèle et n'en change pas.** Mélanger les deux modèles mentaux est la meilleure façon de créer des bugs de NAT incompréhensibles. Ce tutoriel reste en NAT par politique, qui est le défaut et qui convient à l'immense majorité des cas.

---

### 🧪 TP 8 — Publier un serveur et observer le NAT

**🎯 Objectif**
Vérifier le SNAT existant, créer un VIP, publier le serveur de la DMZ, et **observer la traduction dans la table de sessions**. Puis tomber volontairement dans le piège du §10.5 pour ne plus jamais y retomber.

**⏱️ Durée** : 40 minutes

**📋 Prérequis** : TP 7 terminé, serveur web actif sur SRV-DMZ

---

**🔧 Manipulation**

**Étape 1 — Observer le SNAT déjà en place**

Depuis le PC du LAN, lance un trafic vers Internet :

```bash
user@pc-lan:~$ ping -c 20 8.8.8.8
```

Pendant ce temps, sur le pare-feu :

```
FGT-01 # diagnose sys session filter dst 8.8.8.8
FGT-01 # diagnose sys session list
```

Cherche la ligne `hook=post` :

```
hook=post dir=org act=snat 192.168.10.10:1→192.168.100.99:60417
```

**Lis-la bien** : `act=snat`, puis `192.168.10.10` (le PC) devient `192.168.100.99` (le pare-feu). **Tu vois la traduction se produire.** C'est ce que fait `set nat enable`, en clair.

**Étape 2 — Vérifier depuis le PC**

```bash
user@pc-lan:~$ curl -s https://ifconfig.me
```

Si ton lab a Internet, tu vois l'adresse publique de ta connexion, pas `192.168.10.10`. Le monde extérieur ne voit jamais ton adresse privée.

**Étape 3 — Créer le VIP**

On publie le serveur de la DMZ sur une adresse du réseau WAN. Choisis une adresse libre de ton réseau `192.168.100.0/24` :

```
FGT-01 # config firewall vip
FGT-01 (vip) # edit "VIP-Serveur-Web"
FGT-01 (VIP-Serveur-Web) # set extip 192.168.100.200
FGT-01 (VIP-Serveur-Web) # set extintf "port1"
FGT-01 (VIP-Serveur-Web) # set mappedip "192.168.20.10"
FGT-01 (VIP-Serveur-Web) # set portforward enable
FGT-01 (VIP-Serveur-Web) # set protocol tcp
FGT-01 (VIP-Serveur-Web) # set extport 80
FGT-01 (VIP-Serveur-Web) # set mappedport 80
FGT-01 (VIP-Serveur-Web) # set comment "Publication du serveur web DMZ"
FGT-01 (VIP-Serveur-Web) # next
FGT-01 (vip) # end
```

**Étape 4 — Tomber dans le piège (exprès)**

Écris la politique **fausse**, avec l'adresse interne en destination :

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 3
FGT-01 (3) # set name "Publication-Web-FAUSSE"
FGT-01 (3) # set srcintf "port1"
FGT-01 (3) # set dstintf "port3"
FGT-01 (3) # set srcaddr "all"
FGT-01 (3) # set dstaddr "HOST-SRV-DMZ"
FGT-01 (3) # set service "HTTP"
FGT-01 (3) # set schedule "always"
FGT-01 (3) # set action accept
FGT-01 (3) # set logtraffic all
FGT-01 (3) # next
FGT-01 (policy) # end
```

Depuis une machine du réseau WAN (ou ta machine hôte) :

```bash
curl http://192.168.100.200
```

**Ça ne marche pas.** Connexion refusée ou expirée.

> 🧠 **Comprendre** : le paquet arrive avec `192.168.100.200` en destination. La politique cherche `192.168.20.10`. Elles ne correspondent pas, donc la politique ne s'applique pas, donc `Implicit Deny`.

**Étape 5 — Corriger**

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 3
FGT-01 (3) # set name "Publication-Web"
FGT-01 (3) # set dstaddr "VIP-Serveur-Web"
FGT-01 (3) # set nat disable
FGT-01 (3) # next
FGT-01 (policy) # end
```

Retente :

```bash
curl http://192.168.100.200
```
```html
<h1>Serveur DMZ - lab FortiGate</h1>
```

**Ton serveur est publié.** 🎉

**Étape 6 — Observer le DNAT**

```
FGT-01 # diagnose sys session filter dst 192.168.100.200
FGT-01 # diagnose sys session list
```

Tu vois maintenant :

```
hook=pre dir=org act=dnat 192.168.100.50:52134→192.168.100.200:80(192.168.20.10:80)
```

`act=dnat`, et la destination `192.168.100.200:80` devient `192.168.20.10:80`. **La traduction inverse de l'étape 1.**

> 💡 **Astuce — retiens ces deux mots**
> `hook=pre` → **avant** le routage : c'est le **DNAT**
> `hook=post` → **après** le routage : c'est le **SNAT**
>
> Cette distinction n'est pas cosmétique : elle explique l'ordre de traitement de la section 11, et elle te dira du premier coup d'œil quel type de NAT s'applique à une session.

**Étape 7 — Vérifier que l'adresse source est préservée**

C'est le point du §10.5. Sur le serveur DMZ, regarde les journaux du serveur Python :

```
192.168.100.50 - - [20/Aug/2026 09:41:03] "GET / HTTP/1.1" 200 -
```

Tu vois l'adresse **réelle** du client, pas `192.168.20.1` (le pare-feu). C'est parce que tu as mis `set nat disable`.

Fais l'expérience inverse pour bien comprendre :

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 3
FGT-01 (3) # set nat enable
FGT-01 (3) # next
FGT-01 (policy) # end
```

Refais un `curl`, et regarde de nouveau les journaux du serveur :

```
192.168.20.1 - - [20/Aug/2026 09:42:15] "GET / HTTP/1.1" 200 -
```

**Toutes les connexions semblent venir du pare-feu.** Tes journaux applicatifs ne servent plus à rien. Remets `set nat disable`.

**Étape 8 — Restreindre la publication (bonne pratique)**

`set srcaddr "all"` expose le serveur au monde entier. Restreignons :

```
FGT-01 # config firewall address
FGT-01 (address) # edit "NET-Autorise-Externe"
FGT-01 (NET-Autorise-Externe) # set subnet 192.168.100.0 255.255.255.0
FGT-01 (NET-Autorise-Externe) # next
FGT-01 (address) # end

FGT-01 # config firewall policy
FGT-01 (policy) # edit 3
FGT-01 (3) # set srcaddr "NET-Autorise-Externe"
FGT-01 (3) # next
FGT-01 (policy) # end
```

> 💡 **Astuce** : en production, quand le service ne concerne qu'un pays, on ajoute un objet géographique (§8.5). Ça n'arrête pas une attaque ciblée, mais ça supprime l'essentiel du bruit de scan automatisé — et donc du bruit dans tes journaux.

**Étape 9 — Voir tous les VIP**

```
FGT-01 # show firewall vip
FGT-01 # diagnose firewall vip list
```

**Étape 10 — Nettoyer**

```
FGT-01 # config firewall policy
FGT-01 (policy) # delete 3
FGT-01 (policy) # end
```

Garde le VIP, on le réutilisera en section 14.

---

**✅ Résultat attendu**

- `act=snat` visible sur une session sortante
- `curl http://192.168.100.200` renvoie la page du serveur DMZ ✅
- `act=dnat` visible sur la session entrante
- Les journaux du serveur montrent l'adresse **réelle** du client avec `nat disable`
- Ils montrent l'adresse du **pare-feu** avec `nat enable` — et tu as vu la différence

---

**🧠 Ce que tu viens d'apprendre**

1. **SNAT et DNAT sont deux opérations opposées.** L'une pour sortir, l'autre pour entrer.
2. **`set nat enable` fait du SNAT avec l'adresse de l'interface de sortie.** C'est le cas courant.
3. **Un VIP fait du DNAT**, et il ne fait rien tout seul : il faut une politique.
4. **Dans cette politique, la destination est le VIP**, pas l'adresse interne. Tu es tombé dans le piège et tu en es sorti.
5. **`set nat enable` sur une publication écrase l'adresse du visiteur** et rend les journaux applicatifs inutiles.
6. **`hook=pre` = DNAT, `hook=post` = SNAT.** Deux mots qui te font gagner du temps à chaque diagnostic.

---

## 11. Le cheminement d'un paquet dans FortiOS

Cette section n'ajoute aucune fonctionnalité. Elle t'apprend **dans quel ordre** le pare-feu fait ce qu'il fait — et c'est ce qui transforme un administrateur qui devine en un administrateur qui sait.

Presque tous les problèmes qu'on croit inexplicables s'expliquent par l'ordre des étapes.

### 11.1 Pourquoi l'ordre compte

Trois questions qu'on entend tout le temps, et dont la réponse est uniquement dans l'ordre :

- « Ma politique cite l'adresse publique ou l'adresse privée du serveur ? »
- « Le routage se fait avant ou après le NAT ? »
- « Mon antivirus voit-il le trafic avant ou après le filtrage ? »

Sans la carte, on répond au hasard. Avec elle, on répond en une seconde.

### 11.2 Le parcours, étape par étape

Voici le cheminement d'un paquet qui **traverse** le pare-feu, dans l'ordre réel :

```
   ①  ARRIVÉE SUR L'INTERFACE
              │
   ②  VÉRIFICATION D'INTÉGRITÉ (en-têtes IP corrects ?)
              │
   ③  DoS POLICY  (protection contre les inondations)
              │
   ④  IP INTEGRITY / defense anti-spoofing (RPF)
              │
   ⑤  ══ DNAT / VIP ══         ← la destination est réécrite ICI
              │
   ⑥  SESSION EXISTANTE ?
              │
       ┌──────┴───────┐
      OUI            NON
       │              │
       │      ⑦  ROUTAGE (par où sortir ?)
       │              │
       │      ⑧  ══ POLITIQUES DE SÉCURITÉ ══
       │              │           accept / deny
       │      ⑨  AUTHENTIFICATION (si exigée)
       │              │
       │      ⑩  CRÉATION DE LA SESSION
       │              │
       └──────┬───────┘
              │
   ⑪  PROFILS DE SÉCURITÉ (antivirus, filtrage web, IPS…)
              │
   ⑫  ══ SNAT ══              ← la source est réécrite ICI
              │
   ⑬  MISE EN FORME DU TRAFIC (traffic shaping)
              │
   ⑭  SORTIE PAR L'INTERFACE
```

### 11.3 🧠 Les cinq conséquences à retenir

Le schéma est joli, mais ce sont ces cinq déductions qui te serviront vraiment.

**① Le DNAT est AVANT les politiques (étape 5 avant 8)**

Donc, quand la politique est évaluée, la destination a **déjà** été réécrite… mais le pare-feu garde la trace de l'adresse d'origine, et c'est celle-là qu'il compare. **C'est pour ça que la destination d'une politique de publication est le VIP** (§10.5). Tu as maintenant la vraie raison, pas seulement la règle.

**② Le routage est AVANT les politiques (étape 7 avant 8)**

Donc, si aucune route n'existe vers la destination, **le paquet meurt avant même d'être filtré**. C'est capital pour le diagnostic : quand un trafic ne passe pas, la question n'est pas seulement « ai-je la bonne politique ? » mais aussi « ai-je une route ? ».

Et ça explique un message que tu verras au TP 9 :
```
no route to destination
```
Aucune politique n'est en cause. Il manque une route.

**③ Le SNAT est APRÈS les politiques (étape 12 après 8)**

Donc, dans une politique, la **source** est toujours l'adresse **privée d'origine**. Tu n'écris jamais l'adresse publique en `srcaddr`. Le SNAT n'a pas encore eu lieu au moment où la règle est lue.

**④ Une session existante court-circuite tout (étape 6)**

Si la session est déjà connue, le paquet **saute** le routage et les politiques. C'est pourquoi :
- le trafic retour ne demande aucune politique (§1.6) ;
- modifier une règle ne change rien aux sessions en cours (§9, TP 7 étape 7).

Tu as maintenant l'explication mécanique de deux comportements que tu avais admis sur parole.

**⑤ Les profils de sécurité sont APRÈS la décision d'autorisation (étape 11 après 8)**

Donc l'antivirus et le filtrage web ne voient **que le trafic déjà autorisé**. Un profil de sécurité attaché à une politique qui refuse ne sert à rien : le paquet n'arrive jamais jusqu'à lui.

### 11.4 Le RPF, ou pourquoi un paquet parfaitement valide est jeté

L'étape 4 mérite qu'on s'y arrête, parce qu'elle provoque des diagnostics très frustrants.

**RPF** signifie *Reverse Path Forwarding*. À la réception d'un paquet, le pare-feu se pose cette question :

> « Si je devais répondre à cette adresse source, est-ce que je passerais par l'interface d'où le paquet arrive ? »

Si la réponse est non, le paquet est jeté — parce que c'est la signature d'une adresse source usurpée.

**L'exemple qui arrive vraiment :** ton pare-feu a une route vers `172.16.50.0/24` par `port2`. Un paquet venant de `172.16.50.10` arrive sur `port1`. Le pare-feu répondrait par `port2`, donc l'arrivée par `port1` est incohérente : il jette.

Le message dans le journal de diagnostic est celui-ci, et il est déroutant tant qu'on ne connaît pas le mécanisme :

```
reverse path check fail, drop
```

**Quand est-ce un faux positif ?** Dans les réseaux à **routage asymétrique**, où l'aller et le retour empruntent légitimement des chemins différents — cas fréquent avec plusieurs opérateurs.

Deux modes existent :

```
config system settings
    set strict-src-check enable       ← mode strict : la route doit être LA meilleure
end
```

Par défaut, FortiOS est en mode *loose* : il suffit qu'**une** route existe vers la source, peu importe l'interface. C'est le bon réglage dans presque tous les cas.

> ⚠️ **Attention** : n'active `strict-src-check` que si tu sais exactement pourquoi. En environnement multi-opérateur, il casse des flux parfaitement légitimes, et le diagnostic est pénible parce que tout le reste semble correct.

### 11.5 Flux d'entrée, flux de sortie, flux local

Trois chemins différents, qu'il ne faut pas confondre :

| Type de flux | Description | Politiques concernées |
|---|---|---|
| **Traversant** | Entre par une interface, sort par une autre | ⭐ Les politiques de sécurité |
| **Local-in** | **Destiné au pare-feu lui-même** (administration, VPN, ping) | `config firewall local-in-policy` |
| **Local-out** | **Émis par le pare-feu** (journaux, NTP, FortiGuard) | Aucune politique |

> 🧠 **Comprendre — le trafic local-in est une catégorie à part**
> Quand tu te connectes en SSH **sur** le pare-feu, ce trafic ne traverse rien : il s'arrête au pare-feu. Il n'est donc **pas** filtré par tes politiques de sécurité, mais par `allowaccess` (§6.2) et, si tu veux plus fin, par les **local-in policies**.
>
> C'est une source de confusion classique : « j'ai une règle qui interdit tout depuis Internet, et pourtant le pare-feu répond au ping depuis Internet ». Bien sûr : ce ping ne traverse pas, il est destiné au pare-feu. C'est `allowaccess` qui décide, pas tes politiques.

Une local-in policy, pour restreindre finement l'administration :

```
config firewall local-in-policy
    edit 1
        set intf "port1"
        set srcaddr "NET-Admin-Autorise"
        set dstaddr "all"
        set service "HTTPS" "SSH"
        set action accept
        set schedule "always"
    next
    edit 2
        set intf "port1"
        set srcaddr "all"
        set dstaddr "all"
        set service "HTTPS" "SSH"
        set action deny
        set schedule "always"
    next
end
```

> 🚨 **Danger** : les local-in policies peuvent te couper l'accès instantanément et **sans confirmation**. Teste toujours depuis une seconde session ouverte, et garde la console de l'hyperviseur sous la main.

---

### 🧪 TP 9 — Voir le pare-feu penser avec `debug flow`

**🎯 Objectif**
Utiliser `diagnose debug flow`, l'outil de diagnostic le plus puissant de FortiOS. Tu vas **lire les décisions du pare-feu en temps réel**, sur un trafic qui marche puis sur un trafic qui ne marche pas.

C'est le TP qui te rendra autonome en dépannage.

**⏱️ Durée** : 35 minutes

**📋 Prérequis** : TP 8 terminé

---

**🔧 Manipulation**

**Étape 1 — La séquence de base**

`debug flow` s'active toujours de la même façon, en cinq commandes. Apprends-les dans cet ordre :

```
FGT-01 # diagnose debug reset
FGT-01 # diagnose debug flow filter clear
FGT-01 # diagnose debug flow filter addr 192.168.20.10
FGT-01 # diagnose debug flow show function-name enable
FGT-01 # diagnose debug flow trace start 20
FGT-01 # diagnose debug enable
```

| Commande | Rôle |
|---|---|
| `debug reset` | Repart d'un état propre |
| `flow filter clear` | Efface un filtre précédent — **le plus oublié** |
| `flow filter addr` | Ne trace que le trafic concernant cette adresse |
| `show function-name enable` | Affiche la fonction interne, très utile |
| `show console disable` | **Tait** la trace sans arrêter le traçage — l'option existe pour les machines chargées, où la trace noie la console |
| `flow trace start 20` | Trace 20 paquets puis s'arrête tout seul |
| `debug enable` | ⭐ **Démarre réellement l'affichage** |

> 🚨 **Danger — TOUJOURS mettre un filtre**
> Sans `flow filter addr`, tu traces **tout le trafic du pare-feu**. Sur une machine chargée, ça sature la console, ça consomme du processeur, et tu ne peux plus rien lire. Sur un pare-feu de production, c'est une façon de provoquer un incident en voulant en diagnostiquer un.
>
> **Le filtre d'abord, l'activation ensuite. Toujours.**

**Étape 2 — Tracer un trafic qui fonctionne**

Depuis le PC du LAN :

```bash
user@pc-lan:~$ curl http://192.168.20.10
```

Sur la console du pare-feu, tu vois défiler quelque chose comme :

```
id=65308 trace_id=1 func=print_pkt_detail line=5892 msg="vd-root:0 received a packet(proto=6,
   192.168.10.10:47238->192.168.20.10:80) tun_id=0.0.0.0 from port2. flag [S], seq 2847..."
id=65308 trace_id=1 func=init_ip_session_common line=6073 msg="allocate a new session-0000a1b2"
id=65308 trace_id=1 func=vf_ip4_route_input_common line=2621 msg="find a route: flag=00000000
   gw-192.168.20.10 via port3"
id=65308 trace_id=1 func=fw_forward_handler line=881 msg="Allowed by Policy-2:"
```

**Lis les quatre lignes** — c'est exactement le §11.2 qui se déroule sous tes yeux :

| Ligne | Étape du schéma |
|---|---|
| `received a packet ... from port2` | ① Arrivée |
| `allocate a new session` | ⑩ Nouvelle session |
| `find a route: ... via port3` | ⑦ Routage |
| **`Allowed by Policy-2`** | ⑧ ⭐ **La décision, et par quelle règle** |

> 💡 **`Allowed by Policy-N` est la ligne qui répond à 80 % des questions.** Elle te dit non seulement que ça passe, mais **quelle règle** l'a décidé.

**Étape 3 — Tracer un trafic qui NE fonctionne PAS**

Rappelle-toi : le service SSH n'est pas autorisé vers la DMZ (TP 7 étape 3).

```
FGT-01 # diagnose debug flow filter clear
FGT-01 # diagnose debug flow filter addr 192.168.20.10
FGT-01 # diagnose debug flow trace start 10
FGT-01 # diagnose debug enable
```

Depuis le PC du LAN :

```bash
user@pc-lan:~$ ssh user@192.168.20.10
```

Sur le pare-feu :

```
id=65308 trace_id=3 func=print_pkt_detail line=5892 msg="vd-root:0 received a packet(proto=6,
   192.168.10.10:51022->192.168.20.10:22) from port2. flag [S], seq 918..."
id=65308 trace_id=3 func=init_ip_session_common line=6073 msg="allocate a new session-0000a1c9"
id=65308 trace_id=3 func=vf_ip4_route_input_common line=2621 msg="find a route: ... via port3"
id=65308 trace_id=3 func=fw_forward_handler line=784 msg="Denied by forward policy check
   (policy 0)"
```

**La ligne qui compte :**

```
Denied by forward policy check (policy 0)
```

> 🧠 **Comprendre — `policy 0`, c'est l'Implicit Deny**
> La politique numéro 0 n'existe pas dans ta configuration. **C'est le nom interne de la règle implicite de refus.**
>
> Donc `Denied by forward policy check (policy 0)` se traduit par : « aucune de tes politiques n'a correspondu, le paquet est tombé au bout de la liste ».
>
> **Ce message signifie qu'il te manque une règle**, pas qu'une règle te bloque. La nuance est capitale : si le message citait `policy 5`, il faudrait aller corriger la politique 5. Là, il faut en **écrire** une.

**Étape 4 — Arrêter le débogage (impératif)**

```
FGT-01 # diagnose debug disable
FGT-01 # diagnose debug flow trace stop
FGT-01 # diagnose debug reset
```

> 🚨 **Danger** : oublier d'arrêter le débogage laisse le pare-feu tracer en continu. Ça consomme du processeur, ça pollue les consoles, et sur un équipement chargé ça dégrade réellement les performances. **Prends le réflexe de terminer chaque session de diagnostic par ces trois commandes.**
>
> Astuce pour ne pas oublier : `diagnose debug flow trace start 20` s'arrête tout seul après 20 paquets. Mets toujours un nombre.

**Étape 5 — Tracer une absence de route**

Provoquons le cas du §11.3 ②. Essaie de joindre un réseau inexistant :

```
FGT-01 # diagnose debug flow filter clear
FGT-01 # diagnose debug flow filter addr 10.99.99.99
FGT-01 # diagnose debug flow trace start 5
FGT-01 # diagnose debug enable
FGT-01 # execute ping 10.99.99.99
```

Selon ta configuration, tu verras :

```
msg="no route to destination"
```

ou, si tu as une route par défaut, le paquet partira vers l'opérateur et se perdra plus loin.

> 💡 **Astuce** : dans un réseau sans route par défaut, `no route to destination` est un message qui fait gagner un temps fou. Il dit clairement : **le problème n'est pas dans les politiques**.

**Étape 6 — Filtrer plus finement**

Le filtre accepte plusieurs critères, qui se combinent :

```
FGT-01 # diagnose debug flow filter clear
FGT-01 # diagnose debug flow filter saddr 192.168.10.10     ← source uniquement
FGT-01 # diagnose debug flow filter daddr 192.168.20.10     ← destination uniquement
FGT-01 # diagnose debug flow filter proto 6                 ← TCP (1=ICMP, 17=UDP)
FGT-01 # diagnose debug flow filter port 80                 ← le port
FGT-01 # diagnose debug flow filter
```

La dernière commande, sans argument, **affiche le filtre courant**. Prends l'habitude de la taper avant d'activer : c'est ce qui t'évite de tracer tout le pare-feu par erreur.

**Étape 7 — La capture de paquets**

`debug flow` montre les **décisions**. Parfois tu veux voir les **paquets** eux-mêmes. C'est `sniffer` :

```
FGT-01 # diagnose sniffer packet any 'host 192.168.20.10' 4 10
```

Les quatre arguments, dans l'ordre :

| Argument | Signification |
|---|---|
| `any` | L'interface (`any` = toutes, ou `port2`, `port3`…) |
| `'host 192.168.20.10'` | Un filtre au format BPF, comme tcpdump |
| `4` | Le niveau de détail (voir ci-dessous) |
| `10` | Nombre de paquets, puis arrêt |

**Les niveaux de détail :**

| Niveau | Contenu |
|---|---|
| `1` | En-tête IP seulement |
| `2` | En-tête + données |
| `3` | En-tête + données + en-tête Ethernet |
| **`4`** | ⭐ En-tête + **nom de l'interface** |
| `5` | Niveau 4 + données |
| `6` | Tout |

> 💡 **Astuce professionnelle — le niveau 4 est celui qu'il faut retenir**
> Parce qu'il affiche **par quelle interface** chaque paquet passe. Sur un pare-feu, c'est exactement l'information qu'on cherche : voir un paquet arriver sur `port2` et **ne pas** ressortir sur `port3` te dit immédiatement qu'il a été jeté à l'intérieur.

Exemples de filtres BPF utiles :

```
FGT-01 # diagnose sniffer packet any 'icmp' 4 20
FGT-01 # diagnose sniffer packet port1 'tcp port 443' 4 20
FGT-01 # diagnose sniffer packet any 'host 192.168.10.10 and not port 22' 4 50
FGT-01 # diagnose sniffer packet any 'udp port 500 or udp port 4500' 4 30
```

> 💡 **Astuce — exporter vers Wireshark**
> Avec le niveau `3` ou `6`, la sortie contient les octets bruts. On peut la convertir en fichier `.pcap` avec le script `fgt2eth.pl` fourni par Fortinet, puis l'ouvrir dans Wireshark. Indispensable pour analyser un problème complexe.

**Étape 8 — Choisir le bon outil**

Récapitulons, parce que c'est le vrai enseignement du TP :

| Ta question | L'outil |
|---|---|
| « Le paquet arrive-t-il seulement ? » | `diagnose sniffer packet` |
| « Pourquoi est-il refusé ? » | `diagnose debug flow` |
| « Quelle règle l'a autorisé ? » | `diagnose sys session list` (`policy_id`) |
| « Quel est l'état de la connexion ? » | `diagnose sys session list` |
| « Le NAT s'applique-t-il ? » | `diagnose sys session list` (`hook=pre/post`) |

**Le raisonnement type d'un dépannage** :
1. `sniffer` sur l'interface d'entrée → le paquet arrive-t-il ? **Non** → problème en amont (câble, VLAN, routage du client)
2. Il arrive → `debug flow` → que décide le pare-feu ?
3. `Denied by policy 0` → il manque une règle
4. `Denied by policy N` → la règle N bloque, va la voir
5. `Allowed by policy N` → le pare-feu laisse passer, le problème est **ailleurs** (côté serveur)

---

**✅ Résultat attendu**

- Tu lis `Allowed by Policy-2` sur un trafic autorisé
- Tu lis `Denied by forward policy check (policy 0)` sur un trafic refusé
- Tu sais que `policy 0` = Implicit Deny = **règle manquante**
- Tu captures des paquets avec `sniffer` niveau 4
- Tu arrêtes proprement le débogage

---

**🧠 Ce que tu viens d'apprendre**

1. **L'ordre du traitement explique les règles** que tu appliquais sans les comprendre.
2. **DNAT avant les politiques, SNAT après.** D'où le VIP en destination et l'adresse privée en source.
3. **Le routage est avant les politiques** — pas de route, pas de filtrage, le paquet meurt avant.
4. **`debug flow` te montre la décision, `sniffer` te montre le paquet.** Deux outils, deux questions.
5. **`policy 0` veut dire « il manque une règle »**, pas « une règle bloque ».
6. **On met toujours un filtre, et on arrête toujours le débogage.**

---

# Partie IV — Les services réseau

---

## 12. DHCP et DNS

Un pare-feu ne fait pas que filtrer. Sur un site de petite ou moyenne taille, il rend aussi les deux services sans lesquels un réseau ne fonctionne pas : distribuer les adresses et résoudre les noms.

### 12.1 Le serveur DHCP

**DHCP** (*Dynamic Host Configuration Protocol*) attribue automatiquement aux machines leur adresse IP, leur masque, leur passerelle et leurs serveurs DNS. Sans lui, il faudrait configurer chaque poste à la main.

```
config system dhcp server
    edit 1
        set interface "port2"
        set default-gateway 192.168.10.1
        set netmask 255.255.255.0
        set lease-time 604800
        config ip-range
            edit 1
                set start-ip 192.168.10.100
                set end-ip 192.168.10.199
            next
        end
        set dns-service default
        set status enable
    next
end
```

Décryptage des paramètres qui comptent :

| Paramètre | Rôle |
|---|---|
| `interface` | Sur quelle interface le serveur écoute |
| `default-gateway` | La passerelle annoncée aux clients — **presque toujours l'adresse de l'interface** |
| `ip-range` | La plage distribuée |
| `lease-time` | Durée du bail, en **secondes** (604800 = 7 jours) |
| `dns-service` | `default` (ceux du pare-feu), `local` (le pare-feu lui-même) ou `specify` |

> 🧠 **Comprendre — pourquoi la plage ne couvre pas tout le sous-réseau**
> Note qu'on distribue `.100` à `.199`, pas `.1` à `.254`. Ce n'est pas de la timidité, c'est une méthode :
> - `.1` est la passerelle
> - `.2` à `.99` sont réservés aux **adresses fixes** : serveurs, imprimantes, bornes Wi-Fi, switchs
> - `.100` à `.199` sont distribués par DHCP
> - `.200` à `.254` restent libres pour un futur besoin
>
> Un plan d'adressage qui sépare le fixe du dynamique t'évite le jour où le DHCP attribue à un poste l'adresse que tu avais mise en dur sur une imprimante. Ce conflit-là est pénible à diagnostiquer parce qu'il est **intermittent** : il n'apparaît que quand les deux machines sont allumées en même temps.

### 12.2 Les réservations DHCP

Une **réservation** garantit qu'une machine reçoit toujours la même adresse, identifiée par sa MAC.

```
config system dhcp server
    edit 1
        config reserved-address
            edit 1
                set ip 192.168.10.50
                set mac 00:0c:29:aa:bb:cc
                set description "Imprimante comptabilite"
            next
        end
    next
end
```

> 💡 **Astuce — réservation plutôt qu'adresse fixe**
> C'est le meilleur des deux mondes : la machine est configurée en DHCP (donc rien à toucher sur elle), et tu contrôles son adresse **depuis le pare-feu**. Quand le plan d'adressage change, tu modifies une ligne au lieu de te déplacer devant chaque imprimante.

### 12.3 Options DHCP et exclusions

**Exclure des adresses** de la plage :

```
config system dhcp server
    edit 1
        config exclude-range
            edit 1
                set start-ip 192.168.10.150
                set end-ip 192.168.10.160
            next
        end
    next
end
```

**Ajouter des options personnalisées** — utile pour les téléphones IP, les bornes Wi-Fi, le démarrage réseau :

```
config system dhcp server
    edit 1
        config options
            edit 1
                set code 66
                set type string
                set value "192.168.10.5"
            next
        end
    next
end
```

L'option 66 est le serveur TFTP — les téléphones IP y cherchent leur configuration.

### 12.4 Observer et dépanner le DHCP

```
FGT-01 # execute dhcp lease-list
FGT-01 # execute dhcp lease-list port2
FGT-01 # execute dhcp lease-clear 192.168.10.101
FGT-01 # diagnose sys dhcp lease list
```

> 💡 **Astuce de diagnostic** : si un client n'obtient pas d'adresse, la vraie question est « ses trames arrivent-elles ? ». Le DHCP fonctionne en **diffusion** (broadcast), donc :
> ```
> FGT-01 # diagnose sniffer packet port2 'udp port 67 or udp port 68' 4 20
> ```
> Si tu ne vois **rien**, le problème est physique ou de VLAN — le pare-feu n'est même pas sollicité. Si tu vois le `DISCOVER` mais pas d'`OFFER`, le problème est dans la configuration du serveur (plage épuisée, mauvaise interface).

### 12.5 Le relais DHCP

Quand le serveur DHCP est ailleurs (un contrôleur de domaine, typiquement), le pare-feu doit **relayer** les demandes — parce qu'une diffusion ne traverse pas un routeur.

```
config system interface
    edit "port2"
        set dhcp-relay-service enable
        set dhcp-relay-ip "192.168.20.5"
        set dhcp-relay-type regular
    next
end
```

> ⚠️ **Attention** : le serveur distant doit avoir une **étendue** correspondant au sous-réseau du client. Il reconnaît ce sous-réseau grâce au champ `giaddr` que le relais insère. Un relais qui fonctionne côté pare-feu et un serveur sans étendue pour ce réseau donnent le même symptôme qu'un relais cassé.

### 12.6 Le DNS : trois rôles à ne pas confondre

Le mot « DNS » recouvre **trois choses différentes** sur un FortiGate, et les mélanger est une source de confusion permanente.

| Rôle | Qui interroge qui | Où ça se configure |
|---|---|---|
| **Client DNS** | Le pare-feu résout des noms pour **lui-même** | `config system dns` |
| **Serveur DNS** | Les postes du réseau interrogent **le pare-feu** | `config system dns-server` |
| **Filtrage DNS** | Le pare-feu **inspecte** les requêtes qui le traversent | Profil de sécurité (§14) |

**Le client DNS** — le pare-feu a besoin de résoudre des noms pour ses propres besoins : contacter FortiGuard, résoudre un objet FQDN (§8.4), joindre un serveur NTP.

```
config system dns
    set primary 9.9.9.9
    set secondary 1.1.1.1
    set protocol cleartext dot
    set ssl-certificate "Fortinet_Factory"
end
```

Vérification :

```
FGT-01 # execute ping www.fortinet.com
FGT-01 # diagnose test application dnsproxy 3
```

> 💡 **Astuce** : FortiOS sait faire du **DNS over TLS** (`dot`). Ça chiffre les requêtes DNS du pare-feu, qui autrement circulent en clair et révèlent tout ce qu'il consulte. Fortinet fournit des serveurs compatibles, et Quad9 (`9.9.9.9`) aussi.

**Le serveur DNS** — le pare-feu répond aux requêtes des postes :

```
config system dns-server
    edit "port2"
        set mode forward-only
    next
end
```

Trois modes :

| Mode | Comportement |
|---|---|
| `recursive` | Le pare-feu résout lui-même depuis la racine |
| `non-recursive` | Il ne répond que sur ses zones locales |
| `forward-only` | ⭐ Il transmet aux serveurs du §client. Le plus courant |

**Les zones locales** — pour résoudre des noms internes :

```
config system dns-database
    edit "zone-interne"
        set domain "lab.local"
        set type primary
        set view shadow
        config dns-entry
            edit 1
                set hostname "srv-web"
                set ip 192.168.20.10
            next
            edit 2
                set hostname "fgt"
                set ip 192.168.10.1
            next
        end
    next
end
```

Désormais, `srv-web.lab.local` résout vers `192.168.20.10` pour les postes internes.

### 12.7 🧠 Comprendre : le DNS *split horizon*

Voici un problème très courant et sa solution élégante.

Ton serveur web est en `192.168.20.10` (privé) et publié sur `203.0.113.5` (public). Un visiteur d'Internet tape `www.entreprise.fr` et obtient `203.0.113.5` : parfait.

Mais **un employé au bureau** tape la même adresse et obtient aussi `203.0.113.5`. Son paquet part vers le pare-feu, ressort vers Internet, revient… ou plus souvent échoue, parce que ce demi-tour (*hairpin NAT*) n'est pas toujours configuré.

**La solution** : que le DNS réponde **différemment** selon qui demande. C'est le *split horizon* — ou *split-brain DNS*.

```
config system dns-database
    edit "vue-interne"
        set domain "entreprise.fr"
        set type primary
        set view shadow          ← ⭐ répond uniquement aux clients INTERNES
        config dns-entry
            edit 1
                set hostname "www"
                set ip 192.168.20.10      ← l'adresse PRIVÉE
            next
        end
    next
end
```

Le paramètre `view` fait tout le travail :

| Valeur | Qui reçoit la réponse |
|---|---|
| `shadow` | Les clients **internes** uniquement |
| `public` | Les clients **externes** |

Résultat : l'employé obtient l'adresse privée et joint le serveur directement, le visiteur externe obtient l'adresse publique. Chacun emprunte le chemin le plus court, et le NAT en épingle devient inutile.

---

### 🧪 TP 10 — Rendre le réseau autonome

**🎯 Objectif**
Activer le DHCP sur le LAN, faire obtenir une adresse au PC, poser une réservation, configurer le pare-feu en serveur DNS avec une zone locale, et vérifier chaque étape en observant les paquets.

**⏱️ Durée** : 35 minutes

**📋 Prérequis** : TP 7 terminé

---

**🔧 Manipulation**

**Étape 1 — Créer le serveur DHCP**

```
FGT-01 # config system dhcp server
FGT-01 (server) # edit 1
FGT-01 (1) # set interface "port2"
FGT-01 (1) # set default-gateway 192.168.10.1
FGT-01 (1) # set netmask 255.255.255.0
FGT-01 (1) # set lease-time 86400
FGT-01 (1) # config ip-range
FGT-01 (ip-range) # edit 1
FGT-01 (1) # set start-ip 192.168.10.100
FGT-01 (1) # set end-ip 192.168.10.199
FGT-01 (1) # next
FGT-01 (ip-range) # end
FGT-01 (1) # set dns-service default
FGT-01 (1) # set status enable
FGT-01 (1) # next
FGT-01 (server) # end
```

**Étape 2 — Observer une attribution en direct**

C'est plus instructif que de regarder le résultat. Lance d'abord la capture :

```
FGT-01 # diagnose sniffer packet port2 'udp port 67 or udp port 68' 4 20
```

Puis, sur le PC du LAN, demande une adresse :

```bash
user@pc-lan:~$ sudo ip addr flush dev eth0
user@pc-lan:~$ sudo dhclient -v eth0
```

Sur Windows :

```cmd
C:\Users\Lab> ipconfig /release
C:\Users\Lab> ipconfig /renew
```

Sur la console du pare-feu, tu vois passer les quatre étapes du DHCP :

```
0.0.0.0.68 -> 255.255.255.255.67: udp 300     ← DISCOVER
192.168.10.1.67 -> 255.255.255.255.68: udp 300 ← OFFER
0.0.0.0.68 -> 255.255.255.255.67: udp 300     ← REQUEST
192.168.10.1.67 -> 255.255.255.255.68: udp 300 ← ACK
```

> 💡 **Le moyen mnémotechnique** : **DORA** — *Discover, Offer, Request, Acknowledge*. Le client crie « quelqu'un ? », le serveur propose, le client accepte, le serveur confirme.
>
> Savoir **où** la séquence s'interrompt est tout le diagnostic DHCP :
> - Pas de DISCOVER → problème physique ou VLAN
> - DISCOVER sans OFFER → serveur mal configuré ou plage épuisée
> - OFFER sans REQUEST → le client a reçu une autre offre (⚠️ serveur DHCP pirate !)

**Étape 3 — Vérifier le bail**

```
FGT-01 # execute dhcp lease-list port2
```
```
port2
    IP              MAC-Address        Hostname       VCI   Expiry
    192.168.10.100  00:0c:29:1a:2b:3c  pc-lan               Thu Aug 21 09:52:11 2026
```

Et côté client :

```bash
user@pc-lan:~$ ip addr show eth0
user@pc-lan:~$ ip route show
user@pc-lan:~$ cat /etc/resolv.conf
```

**Étape 4 — Poser une réservation**

Note la MAC de ton PC, puis :

```
FGT-01 # config system dhcp server
FGT-01 (server) # edit 1
FGT-01 (1) # config reserved-address
FGT-01 (reserved-address) # edit 1
FGT-01 (1) # set ip 192.168.10.50
FGT-01 (1) # set mac 00:0c:29:1a:2b:3c
FGT-01 (1) # set description "Poste de test du LAN"
FGT-01 (1) # next
FGT-01 (reserved-address) # end
FGT-01 (1) # next
FGT-01 (server) # end
```

Force le renouvellement :

```bash
user@pc-lan:~$ sudo dhclient -r eth0 && sudo dhclient -v eth0
user@pc-lan:~$ ip addr show eth0
```

Le PC obtient maintenant `192.168.10.50`, quelle que soit la plage.

> ⚠️ **Attention** : si le client garde son ancienne adresse, c'est que son bail est toujours valide. Force-le côté pare-feu :
> ```
> FGT-01 # execute dhcp lease-clear 192.168.10.100
> ```

**Étape 5 — Configurer le client DNS du pare-feu**

```
FGT-01 # config system dns
FGT-01 (dns) # set primary 9.9.9.9
FGT-01 (dns) # set secondary 1.1.1.1
FGT-01 (dns) # end

FGT-01 # execute ping www.fortinet.com
```

**Étape 6 — Faire du pare-feu un serveur DNS**

```
FGT-01 # config system dns-server
FGT-01 (dns-server) # edit "port2"
FGT-01 (port2) # set mode forward-only
FGT-01 (port2) # next
FGT-01 (dns-server) # end
```

Autorise le DNS sur l'interface :

```
FGT-01 # config system interface
FGT-01 (interface) # edit port2
FGT-01 (port2) # set allowaccess ping https ssh fgfm
FGT-01 (port2) # next
FGT-01 (interface) # end
```

> 💡 **Astuce** : le service DNS ne passe pas par `allowaccess` — il est activé par `config system dns-server`. C'est une exception à retenir : tous les services locaux ne se contrôlent pas au même endroit.

**Étape 7 — Créer une zone DNS locale**

```
FGT-01 # config system dns-database
FGT-01 (dns-database) # edit "lab-local"
FGT-01 (lab-local) # set domain "lab.local"
FGT-01 (lab-local) # set type primary
FGT-01 (lab-local) # set view shadow
FGT-01 (lab-local) # set authoritative disable
FGT-01 (lab-local) # config dns-entry
FGT-01 (dns-entry) # edit 1
FGT-01 (1) # set hostname "srv-web"
FGT-01 (1) # set ip 192.168.20.10
FGT-01 (1) # next
FGT-01 (dns-entry) # edit 2
FGT-01 (2) # set hostname "fgt"
FGT-01 (2) # set ip 192.168.10.1
FGT-01 (2) # next
FGT-01 (dns-entry) # end
FGT-01 (lab-local) # next
FGT-01 (dns-database) # end
```

**Étape 8 — Tester la résolution**

Depuis le PC du LAN, en interrogeant explicitement le pare-feu :

```bash
user@pc-lan:~$ dig @192.168.10.1 srv-web.lab.local
user@pc-lan:~$ nslookup srv-web.lab.local 192.168.10.1
```

Tu dois obtenir `192.168.20.10`.

Et le test qui prouve que tout se combine :

```bash
user@pc-lan:~$ curl http://srv-web.lab.local
```
```html
<h1>Serveur DMZ - lab FortiGate</h1>
```

**Le nom a été résolu par le pare-feu, la politique a laissé passer, le serveur a répondu.** Trois sections de tutoriel qui fonctionnent ensemble. 🎉

**Étape 9 — Vérifier la résolution externe**

```bash
user@pc-lan:~$ dig @192.168.10.1 www.fortinet.com
```

Le pare-feu transmet aux serveurs du §Étape 5 et rend la réponse.

**Étape 10 — Diagnostiquer le DNS**

```
FGT-01 # diagnose test application dnsproxy 3
```

Cette commande affiche les serveurs utilisés, leur temps de réponse et leur état. C'est **le** réflexe quand la résolution est lente ou erratique.

```
FGT-01 # diagnose sniffer packet any 'udp port 53' 4 20
```

---

**✅ Résultat attendu**

- Le PC obtient une adresse par DHCP, et tu as vu la séquence DORA
- La réservation force l'adresse `192.168.10.50`
- `execute dhcp lease-list` montre le bail
- `dig @192.168.10.1 srv-web.lab.local` renvoie `192.168.20.10`
- `curl http://srv-web.lab.local` affiche la page du serveur

---

**🧠 Ce que tu viens d'apprendre**

1. **Un plan d'adressage sépare le fixe du dynamique**, sinon on récolte des conflits intermittents.
2. **La réservation DHCP** contrôle l'adresse depuis le pare-feu, sans toucher à la machine.
3. **DORA se lit dans une capture**, et l'endroit où la séquence s'arrête donne le diagnostic.
4. **« DNS » désigne trois rôles distincts** sur un FortiGate : client, serveur, filtrage.
5. **Le split horizon** fait répondre différemment selon qui demande, et supprime le besoin de NAT en épingle.
6. **`diagnose test application dnsproxy 3`** est le réflexe du diagnostic DNS.

---

# Partie V — La sécurité applicative

---

## 13. Les modes d'inspection

On entre dans ce qui fait d'un FortiGate un pare-feu **nouvelle génération** : l'inspection du contenu. Mais avant de configurer un antivirus ou un filtrage web, il faut comprendre une décision qui conditionne tout le reste — le **mode d'inspection**.

C'est un réglage qu'on fait une fois et qui détermine ce qui sera possible ensuite. Le rater, c'est se retrouver avec des options grisées sans comprendre pourquoi.

### 13.1 Les deux modes

**Le mode *flow* (flux)**

Le pare-feu examine les paquets **au fil de l'eau**, sans les retenir. Il applique des motifs de reconnaissance sur le flux qui passe, comme un contrôleur qui regarde défiler les wagons d'un train sans l'arrêter.

- ✅ **Rapide** — latence quasi nulle, débit maximal
- ✅ Bénéficie de l'accélération matérielle sur les boîtiers physiques
- ❌ Ne peut pas voir un fichier **dans son ensemble**

**Le mode *proxy***

Le pare-feu **retient** le contenu, le reconstitue entièrement, l'examine, puis le retransmet. Le train est arrêté en gare, les wagons sont ouverts, puis le train repart.

- ✅ **Analyse complète** — le fichier entier est reconstruit avant d'être jugé
- ✅ Beaucoup plus de fonctions disponibles
- ❌ Plus lent, consomme plus de mémoire
- ❌ Ajoute de la latence

### 13.2 🧠 Comprendre : pourquoi ça change ce qu'on peut faire

Voici la raison profonde, et une fois qu'on l'a saisie, tout le reste découle.

Imagine qu'un utilisateur télécharge un fichier de 50 Mo contenant un virus, et que la signature du virus se trouve **à cheval sur deux paquets réseau** : la moitié à la fin du paquet 1 200, l'autre au début du paquet 1 201.

**En mode flow**, le pare-feu voit passer le paquet 1 200, puis le 1 201. Il a une mémoire tampon limitée. Reconnaître un motif coupé en deux est difficile, et reconnaître un motif dans une archive compressée est impossible — il faudrait décompresser, donc avoir le fichier entier.

**En mode proxy**, le pare-feu accumule les 50 Mo, reconstitue le fichier, le décompresse s'il le faut, et l'analyse comme un antivirus classique le ferait sur un disque.

**D'où le principe :**

> Le mode **flow** protège contre ce qui se reconnaît **au passage**.
> Le mode **proxy** protège contre ce qui ne se comprend qu'**en entier**.

**Et la contrepartie**, qui n'est pas seulement une question de vitesse : en mode proxy, l'utilisateur ne reçoit **rien** tant que le fichier n'est pas entièrement analysé. Sur un gros téléchargement, son navigateur semble figé. FortiOS propose deux réponses à ce problème :

| Réglage | Comportement |
|---|---|
| `client-comfort` | Envoie quelques octets régulièrement pour que le client ne coupe pas la connexion |
| `oversize-limit` | Au-delà d'une certaine taille, le fichier n'est **pas** analysé |

> ⚠️ **Attention — `oversize-limit` est un compromis de sécurité, pas un réglage de confort**
> Un fichier qui dépasse la limite passe **sans être analysé**. C'est un trou connu, et les attaquants le connaissent aussi : gonfler artificiellement un fichier malveillant pour dépasser la limite est une technique documentée.
>
> Tu peux choisir de bloquer les fichiers trop gros plutôt que de les laisser passer :
> ```
> config antivirus profile
>     edit "AV-Strict"
>         set av-block-log enable
>         config http
>             set options scan avmonitor
>         end
>     next
> end
> ```
> C'est plus sûr, et c'est plus pénible pour les utilisateurs. Comme souvent en sécurité, il faut choisir et assumer.

### 13.3 Le tableau de décision

| Fonction | Mode flow | Mode proxy |
|---|---|---|
| Antivirus (signatures) | ✅ | ✅ |
| Antivirus dans une archive | ⚠️ Limité | ✅ |
| Filtrage web par catégorie | ✅ | ✅ |
| Filtrage web par mot-clé dans la page | ❌ | ✅ |
| Contrôle applicatif | ✅ | ✅ |
| IPS | ✅ | ✅ |
| Filtrage DNS | ✅ | ✅ |
| **DLP** (fuite de données) | ❌ | ✅ |
| **Antispam** | ❌ | ✅ |
| **Inspection ICAP** | ❌ | ✅ |
| Remplacement de page (*block page*) riche | ⚠️ Basique | ✅ |
| Authentification web | ⚠️ Limitée | ✅ |

> 💡 **Astuce — la recommandation qui marche en pratique**
> **Commence en mode flow.** C'est le défaut de FortiOS depuis plusieurs versions, c'est plus rapide, et ça couvre les besoins de la grande majorité des organisations.
>
> **Passe en proxy uniquement sur les politiques qui en ont besoin.** Le mode se règle **par politique**, pas globalement : tu peux avoir la navigation générale en flow et le trafic de messagerie en proxy pour l'antispam.
>
> Mélanger les deux n'est pas un défaut de conception : c'est la bonne façon de faire.

### 13.4 Régler le mode

**Par politique** — la méthode moderne, celle à retenir :

```
config firewall policy
    edit 1
        set inspection-mode flow      ← ou proxy
    next
end
```

**Le réglage global** — il existe encore, et il détermine le défaut :

```
config system settings
    set inspection-mode flow
end
```

> ⚠️ **Attention** : un **profil de sécurité** est lui aussi de type flow ou proxy (`set feature-set`). Le profil et la politique doivent **correspondre**. Si tu attaches un profil proxy à une politique flow, FortiOS affiche un avertissement et les fonctions propres au proxy **ne s'appliquent pas** — silencieusement du point de vue de l'utilisateur.
>
> Symptôme classique : « j'ai activé le filtrage par mot-clé et ça ne bloque rien ». Vérifie la correspondance des modes avant de chercher ailleurs.

```
config webfilter profile
    edit "WF-Entreprise"
        set feature-set proxy         ← doit correspondre à la politique
    next
end
```

### 13.5 Où se voit la différence, concrètement

```
FGT-01 # diagnose sys session list
```

Sur une session inspectée en mode proxy, tu verras apparaître des indications de redirection vers le processus proxy (`proxy-id`, ou un état `may_dirty` accompagné d'un renvoi interne). En mode flow, la session ressemble à une session ordinaire.

Et pour mesurer le coût :

```
FGT-01 # get system performance status
FGT-01 # diagnose sys top 5 20
```

`diagnose sys top` liste les processus les plus consommateurs. En mode proxy sous charge, tu verras `wad` (le démon proxy) grimper. C'est normal, et c'est le prix de l'analyse complète.

---

### 🧪 TP 11 — Comparer les deux modes

**🎯 Objectif**
Régler le mode d'inspection sur une politique, observer la différence de comportement, et provoquer volontairement l'incompatibilité profil/politique pour reconnaître son symptôme.

**⏱️ Durée** : 20 minutes

**📋 Prérequis** : TP 7 terminé

> ⚠️ **Rappel du §2.7** : sans abonnement FortiGuard actif, les profils de sécurité se configurent et s'attachent, mais ne bloquent rien de réel. Ce TP porte sur le **mécanisme** et sur la façon de vérifier qu'il est en place — c'est ce qui te servira le jour où tu auras une vraie licence.

---

**🔧 Manipulation**

**Étape 1 — Voir le mode actuel**

```
FGT-01 # show firewall policy 1 | grep inspection
```

S'il n'y a aucune sortie, c'est que la politique est sur la valeur par défaut. Vérifie-la :

```
FGT-01 # show full-configuration firewall policy 1 | grep inspection-mode
```
```
    set inspection-mode flow
```

**Étape 2 — Créer un profil de filtrage web en mode flow**

```
FGT-01 # config webfilter profile
FGT-01 (profile) # edit "WF-Flow"
FGT-01 (WF-Flow) # set feature-set flow
FGT-01 (WF-Flow) # set comment "Profil de test - mode flow"
FGT-01 (WF-Flow) # next
FGT-01 (profile) # end
```

**Étape 3 — L'attacher à la politique**

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # set utm-status enable
FGT-01 (1) # set inspection-mode flow
FGT-01 (1) # set webfilter-profile "WF-Flow"
FGT-01 (1) # set ssl-ssh-profile "certificate-inspection"
FGT-01 (1) # next
FGT-01 (policy) # end
```

> 💡 **Astuce** : `set utm-status enable` est la case maîtresse. Sans elle, tes profils sont attachés mais **inactifs**. C'est un oubli fréquent — et le symptôme est le même que celui d'un profil mal configuré, ce qui envoie chercher au mauvais endroit.

**Étape 4 — Provoquer l'incompatibilité**

Crée maintenant un profil en mode **proxy** et attache-le à une politique en mode **flow** :

```
FGT-01 # config webfilter profile
FGT-01 (profile) # edit "WF-Proxy"
FGT-01 (WF-Proxy) # set feature-set proxy
FGT-01 (WF-Proxy) # next
FGT-01 (profile) # end

FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # set webfilter-profile "WF-Proxy"
FGT-01 (1) # next
FGT-01 (policy) # end
```

Selon la version, FortiOS refuse ou accepte avec un avertissement. Dans la GUI, une **icône d'alerte** apparaît sur le profil avec une infobulle expliquant que les fonctions proxy ne s'appliquent pas.

> 🧠 **Retiens ce symptôme.** « J'ai configuré la fonction, elle est bien attachée, et elle ne fait rien » a très souvent cette cause. La première vérification n'est pas la configuration de la fonction, c'est la **correspondance des modes**.

**Étape 5 — Passer la politique en proxy**

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # set inspection-mode proxy
FGT-01 (1) # next
FGT-01 (policy) # end
```

Maintenant, les deux correspondent. Vérifie :

```
FGT-01 # show firewall policy 1
```

**Étape 6 — Mesurer le coût**

```
FGT-01 # get system performance status
```

Puis génère du trafic depuis le PC du LAN :

```bash
user@pc-lan:~$ for i in $(seq 1 50); do curl -s -o /dev/null http://192.168.20.10; done
```

Et observe :

```
FGT-01 # diagnose sys top 5 20
```

Cherche le processus `wad`. En mode proxy, c'est lui qui traite le trafic.

Appuie sur `q` pour quitter.

**Étape 7 — Revenir en flow**

Pour la suite du tutoriel, on reste en mode flow, plus léger sur une VM à 1 vCPU :

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # set inspection-mode flow
FGT-01 (1) # set webfilter-profile "WF-Flow"
FGT-01 (1) # next
FGT-01 (policy) # end
```

**Étape 8 — Nettoyer**

```
FGT-01 # config webfilter profile
FGT-01 (profile) # delete "WF-Proxy"
FGT-01 (profile) # end
```

---

**✅ Résultat attendu**

- Tu sais lire le mode d'inspection d'une politique
- Un profil proxy sur une politique flow produit un avertissement
- `set utm-status enable` conditionne l'activation des profils
- `diagnose sys top` montre `wad` en mode proxy

---

**🧠 Ce que tu viens d'apprendre**

1. **Flow inspecte au passage, proxy reconstitue avant d'inspecter.** C'est la seule différence, et elle explique tout le reste.
2. **Le mode détermine les fonctions disponibles** — DLP et antispam n'existent qu'en proxy.
3. **Le mode se règle par politique**, et les mélanger est la bonne pratique.
4. **Profil et politique doivent être du même mode**, sinon la fonction ne s'applique pas silencieusement.
5. **`utm-status enable` est la case maîtresse** que tout le monde oublie une fois.
6. **`oversize-limit` est un trou de sécurité assumé**, pas un réglage de confort.

---

## 14. Les profils de sécurité

C'est ici que le pare-feu cesse de regarder des adresses et commence à regarder **ce qui circule**. Six profils, six angles d'attaque différents.

> ⚠️ **Rappel important** : les profils de cette section s'appuient sur les bases FortiGuard. **Sans abonnement, ils se configurent mais ne bloquent rien de réel.** Tu apprends ici la logique et les commandes — qui sont exactement les mêmes en production. Je signale au passage ce qui fonctionne quand même sans licence.

### 14.1 La vue d'ensemble

| Profil | Ce qu'il regarde | Sans licence FortiGuard ? |
|---|---|---|
| **Antivirus** | Le contenu des fichiers | ❌ Base de signatures figée |
| **Web Filter** | Les sites web visités | ⚠️ Catégories non, listes locales **oui** |
| **Application Control** | L'application utilisée | ❌ Base de signatures figée |
| **IPS** | Les motifs d'attaque | ❌ Base de signatures figée |
| **DNS Filter** | Les noms résolus | ⚠️ Catégories non, listes locales **oui** |
| **File Filter** | Le **type** de fichier | ✅ **Fonctionne** |

> 💡 **Astuce** : retiens que le **filtrage par liste locale** et le **filtrage par type de fichier** fonctionnent sans abonnement. Ce sont eux qui te permettront de faire des TP réellement bloquants dans ton laboratoire.

### 14.2 L'antivirus

```
config antivirus profile
    edit "AV-Standard"
        set feature-set flow
        set comment "Antivirus standard"
        config http
            set av-scan block
            set archive-block encrypted corrupted
        end
        config https
            set av-scan block
        end
        config ftp
            set av-scan block
        end
        config smtp
            set av-scan block
        end
    next
end
```

Les valeurs de `av-scan` :

| Valeur | Effet |
|---|---|
| `disable` | Aucune analyse |
| `monitor` | Analyse et **journalise**, mais laisse passer |
| `block` | ⭐ Analyse et **bloque** |

> 💡 **Astuce professionnelle — commence toujours en `monitor`**
> Quand tu déploies un antivirus sur un réseau existant, mets-le d'abord en `monitor` pendant une ou deux semaines. Tu vois **ce qui serait bloqué** sans rien casser. Puis tu examines les journaux, tu traites les faux positifs, et tu passes en `block` en connaissance de cause.
>
> Passer directement en `block` sur un réseau en production, c'est se garantir un lundi matin difficile.

**Les options avancées qui comptent :**

```
config antivirus profile
    edit "AV-Standard"
        set analytics-db enable            ← utilise la base FortiSandbox
        config http
            set av-scan block
            set outbreak-prevention block  ← protection zéro-jour par empreinte
            set content-disarm enable      ← ⭐ voir ci-dessous
        end
    next
end
```

> 🧠 **Comprendre — `content-disarm`, la fonction la plus sous-estimée**
> Le *Content Disarm and Reconstruction* (CDR) ne cherche **pas** de virus. Il fait autre chose : il prend un document Office ou un PDF, en **retire tout le contenu actif** (macros, JavaScript, objets embarqués) et reconstruit un document propre.
>
> Pourquoi c'est puissant ? Parce que ça fonctionne **même contre un code malveillant inconnu**. Un antivirus ne détecte que ce qu'il connaît. Le CDR ne cherche rien : il supprime la capacité même d'exécuter du code. Une macro zéro-jour dans un fichier Word est neutralisée sans jamais avoir été identifiée.
>
> Le prix : le document arrive **modifié**. Si tes utilisateurs échangent de vrais classeurs Excel avec des macros métier, ils vont te le faire savoir. À réserver aux flux entrants depuis l'extérieur, typiquement la messagerie.

### 14.3 Le filtrage web

C'est le profil le plus visible pour les utilisateurs, et celui qui génère le plus de demandes au support. 😄

```
config webfilter profile
    edit "WF-Entreprise"
        set feature-set flow
        set comment "Filtrage web standard"
        config ftgd-wf
            unset options
            config filters
                edit 1
                    set category 26          ← Malicious Websites
                    set action block
                next
                edit 2
                    set category 61          ← Phishing
                    set action block
                next
                edit 3
                    set category divers
                    set action warning
                next
            end
        end
        set log-all-url enable
    next
end
```

**Les quatre actions possibles :**

| Action | Effet |
|---|---|
| `allow` | Autorise, sans journal |
| `monitor` | Autorise et **journalise** |
| `warning` | Affiche un avertissement, l'utilisateur peut **continuer** |
| `block` | Bloque et affiche la page de refus |
| `authenticate` | Demande une authentification pour continuer |

> 💡 **Astuce — `warning` est très souvent le bon choix**
> Bloquer sèchement les réseaux sociaux crée un rapport de force avec les utilisateurs, et une file d'attente devant ton bureau. `warning` affiche « ce site n'entre pas dans le cadre professionnel, cliquez pour continuer », journalise le passage, et laisse la responsabilité à l'utilisateur.
>
> Dans la plupart des organisations, la consommation baisse fortement **sans aucun blocage** — parce que les gens savent que c'est tracé. C'est plus efficace et politiquement infiniment plus simple à défendre.

**Le filtrage par URL locale — et celui-ci marche sans licence :**

```
config webfilter urlfilter
    edit 1
        set name "Liste-Locale"
        config entries
            edit 1
                set url "exemple-interdit.com"
                set type simple
                set action block
            next
            edit 2
                set url "*.reseaux-sociaux.fr"
                set type wildcard
                set action block
            next
            edit 3
                set url ".*\\.(exe|bat|scr)$"
                set type regex
                set action block
            next
        end
    next
end
```

Puis on le rattache au profil :

```
config webfilter profile
    edit "WF-Entreprise"
        config web
            set urlfilter-table 1
        end
    next
end
```

Les trois types :

| Type | Syntaxe | Exemple |
|---|---|---|
| `simple` | Correspondance de sous-chaîne | `facebook.com` |
| `wildcard` | Avec `*` | `*.facebook.com` |
| `regex` | Expression régulière complète | `.*\.(exe\|bat)$` |

> ⚠️ **Attention — l'ordre compte aussi ici**
> La liste d'URL est évaluée de haut en bas, première correspondance gagnante — même logique que les politiques (§9.2). Une entrée `allow` sur `intranet.entreprise.fr` doit être **avant** l'entrée `block` sur `*.entreprise.fr`, sinon elle ne sert à rien.

### 14.4 Le contrôle applicatif

C'est le cœur du concept NGFW (§2.5). Il reconnaît **l'application** indépendamment du port.

```
config application list
    edit "APP-Entreprise"
        set comment "Controle applicatif standard"
        config entries
            edit 1
                set category 2            ← P2P
                set action block
            next
            edit 2
                set application 15832     ← une application précise
                set action block
            next
            edit 3
                set category 6            ← Video/Audio
                set action pass
                set log enable
            next
        end
        set other-application-action pass
        set other-application-log enable
        set unknown-application-action pass
    next
end
```

Trouver l'identifiant d'une application :

```
FGT-01 # diagnose application-control list | grep -i "bittorrent"
```

> 🧠 **Comprendre — pourquoi c'est plus fort qu'un filtrage de ports**
> BitTorrent n'a pas de port fixe. Il utilise des ports aléatoires, sait passer en HTTPS sur le 443, et se camoufle. Un filtrage de ports ne l'attrapera jamais.
>
> Le contrôle applicatif reconnaît **la signature du protocole lui-même** — la façon dont les paquets sont structurés, la séquence des échanges. Peu importe le port utilisé.
>
> C'est exactement la promesse du §2.5 : « le 443 est ouvert, mais BitTorrent est refusé ».

> ⚠️ **Attention** : `other-application-action` décide du sort des applications **reconnues mais non listées**, `unknown-application-action` de celles que le pare-feu **ne reconnaît pas du tout**. Mettre les deux en `block` donne une posture très stricte — et casse absolument tout ce que ta base d'applications ne connaît pas, y compris tes applications métier internes. À manier avec précaution.

### 14.5 L'IPS

L'**IPS** (*Intrusion Prevention System*) cherche des motifs d'**attaque** : tentatives d'exploitation de failles, scans, injections.

```
config ips sensor
    edit "IPS-Standard"
        set comment "Detection d intrusion"
        config entries
            edit 1
                set severity high critical
                set action block
                set log enable
                set status enable
            next
            edit 2
                set severity medium
                set action default
                set log enable
            next
        end
    next
end
```

> 💡 **Astuce — filtrer par sévérité plutôt que d'activer toutes les signatures**
> La base IPS contient des milliers de signatures. Les activer toutes coûte cher en processeur et génère beaucoup de bruit. Filtrer par `severity high critical` couvre l'essentiel du risque réel pour une fraction du coût.
>
> On peut aussi filtrer par système ciblé (`set os Linux Windows`) ou par application (`set application Apache`), pour ne charger que les signatures pertinentes pour ton parc. Un IPS ajusté vaut mieux qu'un IPS exhaustif que personne ne lit.

### 14.6 Le filtrage DNS

Il agit **avant** la connexion : la requête DNS est interceptée, et si le nom est interdit, l'adresse n'est jamais fournie.

```
config dnsfilter profile
    edit "DNS-Standard"
        config ftgd-dns
            config filters
                edit 1
                    set category 26
                    set action block
                next
            end
        end
        set block-botnet enable        ← ⭐ fonctionne bien et coûte peu
        set log-all-domain enable
    next
end
```

> 🧠 **Comprendre — pourquoi filtrer au niveau DNS est très efficace**
> Trois raisons qu'on n'apprécie qu'après coup :
>
> **1. C'est avant tout le reste.** Le poste n'obtient jamais l'adresse, donc aucune connexion n'est tentée. Rien à bloquer ensuite.
>
> **2. Ça marche même en HTTPS.** Le filtrage web classique doit inspecter le trafic chiffré pour connaître l'URL (section 15). La requête DNS, elle, est en clair — le filtrage DNS attrape ce que le filtrage web ne verrait qu'au prix d'un déchiffrement.
>
> **3. `block-botnet` est redoutablement rentable.** Un poste compromis contacte son serveur de commande par un nom de domaine. Bloquer ces noms **coupe le canal de commande** même si l'infection a déjà eu lieu. C'est la dernière ligne de défense, et elle fonctionne souvent quand tout le reste a échoué.

### 14.7 Le filtrage de fichiers — et lui fonctionne sans licence

```
config file-filter profile
    edit "FF-Standard"
        set feature-set flow
        set log enable
        config rules
            edit "Bloquer-Executables"
                set protocol http-get http-post ftp
                set action block
                set direction any
                set file-type "exe" "bat" "msi" "scr" "vbs" "js"
            next
            edit "Bloquer-Archives-Chiffrees"
                set protocol http-get
                set action block
                set file-type "7z" "rar"
            next
        end
    next
end
```

> 💡 **Astuce — c'est le type RÉEL, pas l'extension**
> FortiOS identifie le type de fichier par sa **signature interne** (les premiers octets, ce qu'on appelle le *magic number*), pas par son extension. Renommer `virus.exe` en `photo.jpg` ne trompe personne : le pare-feu voit que le contenu est un exécutable Windows.
>
> C'est ce qui rend ce filtre bien plus solide qu'une simple liste d'extensions, et c'est une des rares protections sérieuses disponibles sans abonnement.

---

### 🧪 TP 12 — Bloquer pour de vrai, sans licence

**🎯 Objectif**
Construire un filtrage qui **fonctionne réellement dans ton laboratoire** : liste d'URL locale et filtrage de fichiers par type. Puis vérifier le blocage dans les journaux.

**⏱️ Durée** : 35 minutes

**📋 Prérequis** : TP 11 terminé

---

**🔧 Manipulation**

**Étape 1 — Créer une liste d'URL locale**

```
FGT-01 # config webfilter urlfilter
FGT-01 (urlfilter) # edit 1
FGT-01 (1) # set name "Liste-Locale-Lab"
FGT-01 (1) # config entries
FGT-01 (entries) # edit 1
FGT-01 (1) # set url "example.com"
FGT-01 (1) # set type simple
FGT-01 (1) # set action block
FGT-01 (1) # next
FGT-01 (entries) # edit 2
FGT-01 (2) # set url "*.example.org"
FGT-01 (2) # set type wildcard
FGT-01 (2) # set action block
FGT-01 (2) # next
FGT-01 (entries) # end
FGT-01 (1) # next
FGT-01 (urlfilter) # end
```

**Étape 2 — Créer le profil de filtrage web et l'y rattacher**

```
FGT-01 # config webfilter profile
FGT-01 (profile) # edit "WF-Lab"
FGT-01 (WF-Lab) # set feature-set flow
FGT-01 (WF-Lab) # set comment "Filtrage du laboratoire"
FGT-01 (WF-Lab) # config web
FGT-01 (web) # set urlfilter-table 1
FGT-01 (web) # end
FGT-01 (WF-Lab) # set log-all-url enable
FGT-01 (WF-Lab) # next
FGT-01 (profile) # end
```

**Étape 3 — L'attacher à la politique Internet**

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # set utm-status enable
FGT-01 (1) # set inspection-mode flow
FGT-01 (1) # set webfilter-profile "WF-Lab"
FGT-01 (1) # set ssl-ssh-profile "certificate-inspection"
FGT-01 (1) # set logtraffic all
FGT-01 (1) # next
FGT-01 (policy) # end
```

**Étape 4 — Tester**

Depuis le PC du LAN :

```bash
user@pc-lan:~$ curl -v http://example.com
```

Tu obtiens une page de blocage FortiGuard, ou une connexion coupée.

> ⚠️ **Attention** : en HTTPS, le filtrage par URL ne voit que le **nom du serveur** (via le SNI), pas le chemin complet. Bloquer `example.com/page-precise` en HTTPS ne fonctionne **pas** sans inspection SSL profonde — c'est le sujet de la section 15. Teste en HTTP pour ce TP.

**Étape 5 — Voir le blocage dans les journaux**

```
FGT-01 # execute log filter category 3
FGT-01 # execute log filter field action "blocked"
FGT-01 # execute log display
```

Tu vois l'événement, avec l'URL, l'utilisateur, la politique et l'heure.

> 💡 **Astuce** : `category 0` est le **trafic**, et le filtrage web a **sa propre catégorie** (`3`) — il n'existe pas de catégorie « UTM » unique. Vérifie toujours la liste sur ta machine :
> ```
> FGT-01 # execute log filter category ?
> ```

**Étape 6 — Créer un filtrage de fichiers**

```
FGT-01 # config file-filter profile
FGT-01 (profile) # edit "FF-Lab"
FGT-01 (FF-Lab) # set feature-set flow
FGT-01 (FF-Lab) # set log enable
FGT-01 (FF-Lab) # config rules
FGT-01 (rules) # edit "Bloquer-Executables"
FGT-01 (Bloquer-Executables) # set protocol http-get http-post
FGT-01 (Bloquer-Executables) # set action block
FGT-01 (Bloquer-Executables) # set direction any
FGT-01 (Bloquer-Executables) # set file-type "exe" "bat" "msi"
FGT-01 (Bloquer-Executables) # next
FGT-01 (rules) # end
FGT-01 (FF-Lab) # next
FGT-01 (profile) # end
```

**Étape 7 — Le test qui prouve que c'est le TYPE, pas l'extension**

Sur le serveur DMZ, fabrique un faux exécutable **avec une extension d'image** :

```bash
user@srv-dmz:~$ printf 'MZ\x90\x00\x03\x00\x00\x00\x04\x00' > photo.jpg
user@srv-dmz:~$ head -c 2 photo.jpg
MZ
```

> 🧠 `MZ` est la signature de tout exécutable Windows. Le fichier s'appelle `photo.jpg` mais son contenu dit « je suis un `.exe` ».

Attache le profil à la politique LAN → DMZ :

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 2
FGT-01 (2) # set utm-status enable
FGT-01 (2) # set inspection-mode flow
FGT-01 (2) # set file-filter-profile "FF-Lab"
FGT-01 (2) # set ssl-ssh-profile "certificate-inspection"
FGT-01 (2) # set logtraffic all
FGT-01 (2) # next
FGT-01 (policy) # end
```

Puis, depuis le PC du LAN :

```bash
user@pc-lan:~$ curl -O http://192.168.20.10/photo.jpg
```

**Le téléchargement est bloqué**, malgré l'extension `.jpg`. Le pare-feu a lu les octets, pas le nom.

```
FGT-01 # execute log filter category 3
FGT-01 # execute log display
```

**Étape 8 — Créer un profil antivirus (pour la forme)**

```
FGT-01 # config antivirus profile
FGT-01 (profile) # edit "AV-Lab"
FGT-01 (AV-Lab) # set feature-set flow
FGT-01 (AV-Lab) # config http
FGT-01 (http) # set av-scan monitor
FGT-01 (http) # end
FGT-01 (AV-Lab) # next
FGT-01 (profile) # end
```

> 💡 **Astuce** : `monitor` plutôt que `block`, conformément au conseil du §14.2. Sans licence, la base est figée de toute façon — mais tu prends le bon réflexe.

**Étape 9 — Vérifier l'état des bases FortiGuard**

```
FGT-01 # diagnose autoupdate versions
FGT-01 # get system fortiguard-service status
```

Tu verras les dates des bases. Sans abonnement, elles sont anciennes — et tu sais maintenant **le vérifier**, ce qui est un réflexe d'audit utile en production.

**Étape 10 — Nettoyer**

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 2
FGT-01 (2) # unset file-filter-profile
FGT-01 (2) # next
FGT-01 (policy) # end
```

---

**✅ Résultat attendu**

- `curl http://example.com` est bloqué par la liste locale ✅
- Le blocage apparaît dans les journaux UTM ✅
- `photo.jpg` contenant un en-tête `MZ` est bloqué par le filtrage de fichiers ✅
- `diagnose autoupdate versions` montre l'état des bases

---

**🧠 Ce que tu viens d'apprendre**

1. **Six profils, six angles.** Fichier, site, application, attaque, nom résolu, type de fichier.
2. **Listes locales et filtrage de type fonctionnent sans abonnement** — de quoi travailler en lab.
3. **On déploie en `monitor` avant de passer en `block`.** Toujours.
4. **Le contrôle applicatif reconnaît le protocole, pas le port.** C'est la promesse du NGFW.
5. **Le filtrage DNS agit avant tout le reste**, et fonctionne même en HTTPS sans déchiffrement.
6. **Le filtrage de fichiers lit les octets**, pas l'extension. Tu l'as prouvé toi-même.
7. **En HTTPS, le filtrage d'URL ne voit que le nom du serveur** — ce qui amène directement la section suivante.

---

## 15. ⭐ Routeur + ACL contre pare-feu : la démonstration

On a promis au §2.10 de ne pas se contenter d'un argumentaire. Cette section tient la promesse.

On va **essayer sincèrement** de protéger le réseau avec R1 tout seul, comme si le FortiGate n'existait pas. On va y arriver partiellement. Puis on va buter, une par une, sur quatre limites — et à chaque fois, on montrera le pare-feu faire ce que le routeur ne sait pas faire.

C'est la section la plus importante du tutoriel pour ta **carrière**, parce que c'est celle qui te permettra de justifier un budget devant quelqu'un qui n'est pas technicien.

### 15.1 La règle du jeu

Pour cette section, on fait comme si R1 était notre seule défense.

```
   Internet ────► [R1-EDGE + ACL] ────► [FGT-01 (transparent)] ────► LAN / DMZ
                   ↑                     ↑
            notre "pare-feu"      on l'ignore pour l'instant
```

**Objectif de sécurité**, celui de n'importe quelle PME :
1. Les postes du LAN doivent pouvoir naviguer sur le web
2. Rien ne doit pouvoir entrer depuis Internet, sauf vers le serveur web de la DMZ
3. Les utilisateurs ne doivent pas faire de peer-to-peer
4. Aucun fichier exécutable ne doit être téléchargé
5. Le stagiaire n'a pas les mêmes droits que le directeur

Cinq exigences banales. Voyons combien R1 peut en satisfaire.

---

### 15.2 🧠 Limite n°1 : une ACL n'a pas de mémoire

C'est la limite fondamentale, celle dont découlent la moitié des autres.

**Le problème, posé simplement.** Un poste du LAN consulte un site web :

```
Aller  : 192.168.10.10:54321  →  93.184.216.34:443
Retour : 93.184.216.34:443    →  192.168.10.10:54321
```

Le paquet **retour** entre depuis Internet. Ton exigence n°2 dit « rien ne doit pouvoir entrer ». Si tu appliques littéralement cette règle sur R1, la navigation ne fonctionne plus.

Alors tu es obligé d'ouvrir. Mais **quoi** ouvrir ? Tu ne connais pas à l'avance le port source qu'utilisera le poste (`54321` ici, autre chose la prochaine fois). Tu n'as qu'une possibilité :

```cisco
! L'ACL "naïve" qu'on est obligé d'écrire
R1-EDGE(config)# ip access-list extended DEPUIS-INTERNET
R1-EDGE(config-ext-nacl)# permit tcp any 192.168.0.0 0.0.255.255 gt 1023
R1-EDGE(config-ext-nacl)# deny ip any any log
```

Traduction : « laisse entrer **tout le TCP** venant de n'importe où vers **n'importe quel port au-dessus de 1023** de mon réseau ».

> 🚨 **Mesure ce que tu viens d'écrire.**
> Tu as ouvert **64 512 ports** sur **tout ton réseau interne**, en permanence, à **la Terre entière**. Un serveur RDP mal configuré sur le port 3389, un service de développement sur le 8080, une base de données sur le 5432 : tout est accessible.
>
> Ce n'est pas une caricature. C'est **la seule chose qu'une ACL sans état permet d'écrire** si l'on veut que la navigation fonctionne.

### 15.3 La demi-solution de Cisco : le mot-clé `established`

IOS propose un palliatif :

```cisco
R1-EDGE(config)# ip access-list extended DEPUIS-INTERNET
R1-EDGE(config-ext-nacl)# permit tcp any 192.168.0.0 0.0.255.255 established
R1-EDGE(config-ext-nacl)# deny ip any any log
```

`established` ne laisse entrer que les paquets TCP dont le drapeau **ACK** ou **RST** est positionné — c'est-à-dire, en théorie, uniquement des paquets appartenant à une conversation déjà entamée.

C'est nettement mieux. Et c'est **quand même insuffisant**, pour trois raisons précises :

**① Ça ne vérifie rien.** `established` regarde **un bit dans l'en-tête**. Il ne consulte aucune table, il ne sait pas si une conversation existe vraiment. **N'importe qui peut fabriquer un paquet avec le bit ACK positionné.** C'est une technique de scan classique — l'*ACK scan* de `nmap` — qui traverse tranquillement ce type d'ACL.

**② Ça ne marche que pour TCP.** UDP n'a pas de drapeau ACK. Le DNS, le NTP, la voix sur IP, QUIC — tout ce qui est UDP reste sans protection possible autrement qu'en ouvrant les ports en grand.

**③ Ça ne protège pas ICMP.** Même problème.

> 🧠 **La différence, dite en une phrase**
> `established` demande : « **ce paquet ressemble-t-il** à une réponse ? »
> Un pare-feu à états demande : « **ce paquet EST-il** la réponse à une conversation que j'ai moi-même autorisée, entre ces deux adresses, sur ces deux ports, dans le bon état TCP ? »
>
> La première question se répond en lisant un bit. La seconde exige une **mémoire** — la table de sessions du §9, TP 7 étape 6.

### 15.4 Ce que Cisco propose au-delà

Soyons complets, parce que dire « Cisco ne sait pas faire » serait faux :

| Mécanisme | Ce qu'il apporte | Sa limite |
|---|---|---|
| **ACL réflexives** (`reflect`/`evaluate`) | Une vraie table d'état, créée dynamiquement | Pas de suivi applicatif, gestion pénible, pas de FTP actif |
| **CBAC** (`ip inspect`) | Inspection avec état, quelques protocoles applicatifs | Obsolète, remplacé par ZBF |
| **Zone-Based Firewall** (ZBF) | Un vrai pare-feu à états dans IOS | ⭐ Bon, mais voir ci-dessous |

Une ACL réflexive, pour l'exemple :

```cisco
R1-EDGE(config)# ip access-list extended VERS-INTERNET
R1-EDGE(config-ext-nacl)# permit tcp any any reflect TRAFIC-SORTANT
R1-EDGE(config-ext-nacl)# permit udp any any reflect TRAFIC-SORTANT
R1-EDGE(config-ext-nacl)# exit
R1-EDGE(config)# ip access-list extended DEPUIS-INTERNET
R1-EDGE(config-ext-nacl)# evaluate TRAFIC-SORTANT
R1-EDGE(config-ext-nacl)# deny ip any any log
```

**Là, on a une vraie gestion d'état.** Honneur à qui de droit.

> ⚠️ **Alors pourquoi acheter un pare-feu ?**
> Parce que la gestion d'état n'était que **la première** des cinq exigences du §15.1. Le ZBF de Cisco résout le point n°1 et le n°2. Il ne résout **ni le 3, ni le 4, ni le 5** — et c'est là que la discussion se termine.
>
> Il y a aussi un argument de terrain qu'aucune fiche technique ne dit : activer sérieusement l'inspection d'état sur un routeur généraliste **effondre son débit**, parce que le traitement quitte le chemin accéléré matériel pour retomber sur le processeur principal. Un routeur qui acheminait 1 Gbit/s sans effort tombe à quelques centaines de Mbit/s. Sur un pare-feu, ce traitement **est** le métier, et le matériel est conçu pour.

---

### 🧪 TP 13 — Prouver l'absence de mémoire

**🎯 Objectif**
Écrire une ACL sur R1, constater qu'elle casse la navigation, la « réparer » en ouvrant les ports hauts, puis **mesurer le trou** qu'on vient de créer. Enfin, faire la même chose côté FortiGate et comparer.

**⏱️ Durée** : 40 minutes

**📋 Prérequis** : TP 7 terminé, R1 opérationnel

---

**🔧 Manipulation**

**Étape 1 — Poser l'ACL « sécurisée » sur R1**

On applique l'exigence n°2 à la lettre : rien n'entre depuis Internet.

```cisco
R1-EDGE# configure terminal
R1-EDGE(config)# ip access-list extended DEPUIS-INTERNET
R1-EDGE(config-ext-nacl)# deny ip any any log
R1-EDGE(config-ext-nacl)# exit
R1-EDGE(config)# interface GigabitEthernet0/0
R1-EDGE(config-if)# ip access-group DEPUIS-INTERNET in
R1-EDGE(config-if)# end
```

Sous Linux :

```bash
root@r1-edge:~# iptables -A FORWARD -i eth0 -j LOG --log-prefix "ACL-DENY: "
root@r1-edge:~# iptables -A FORWARD -i eth0 -j DROP
```

**Étape 2 — Constater les dégâts**

Depuis le PC du LAN :

```bash
user@pc-lan:~$ curl -m 10 http://neverssl.com
curl: (28) Connection timed out
```

**La navigation est morte.** Pourtant tu n'as rien bloqué en sortie : c'est le **retour** qui ne passe plus.

Sur R1, regarde les compteurs :

```cisco
R1-EDGE# show ip access-lists DEPUIS-INTERNET
```
```
Extended IP access list DEPUIS-INTERNET
    10 deny ip any any log (247 matches)
```

247 paquets jetés — ce sont **les réponses aux requêtes de tes propres utilisateurs**.

> 🧠 **Tu viens de vivre le problème du §1.6 depuis l'autre côté.** Sur le FortiGate, tu n'as jamais eu à y penser : la table de sessions s'en occupait. Ici, il n'y a pas de table.

**Étape 3 — La « réparation » naïve**

```cisco
R1-EDGE(config)# ip access-list extended DEPUIS-INTERNET
R1-EDGE(config-ext-nacl)# no deny ip any any log
R1-EDGE(config-ext-nacl)# permit tcp any 192.168.0.0 0.0.255.255 gt 1023
R1-EDGE(config-ext-nacl)# permit udp any 192.168.0.0 0.0.255.255 gt 1023
R1-EDGE(config-ext-nacl)# deny ip any any log
R1-EDGE(config-ext-nacl)# end
```

Depuis le PC :

```bash
user@pc-lan:~$ curl -m 10 -I http://neverssl.com
HTTP/1.1 200 OK
```

**Ça remarche.** 🎉 … et c'est précisément le problème.

**Étape 4 — Mesurer le trou**

Depuis une machine du réseau de transit (qui joue « Internet »), lance un service quelconque sur le PC du LAN, puis essaie de l'atteindre.

Sur le PC du LAN, ouvre un service sur un port haut :

```bash
user@pc-lan:~$ python3 -m http.server 8080
```

Depuis la machine « externe » :

```bash
attaquant@ext:~$ curl http://<adresse-publique-de-R1>:8080
```

> ⚠️ Selon ton NAT, tu devras peut-être tester depuis le réseau de transit directement vers `192.168.10.10:8080`. L'important est de constater que **l'ACL ne s'y oppose pas** : le port 8080 est > 1023, donc `permit`.

**Un scan le montre encore mieux :**

```bash
attaquant@ext:~$ nmap -p 1024-10000 192.168.10.10
```

Tous les ports ouverts au-dessus de 1023 sont **visibles et joignables**. Ton ACL les autorise explicitement.

**Étape 5 — Essayer `established`**

```cisco
R1-EDGE(config)# ip access-list extended DEPUIS-INTERNET
R1-EDGE(config-ext-nacl)# no permit tcp any 192.168.0.0 0.0.255.255 gt 1023
R1-EDGE(config-ext-nacl)# no permit udp any 192.168.0.0 0.0.255.255 gt 1023
R1-EDGE(config-ext-nacl)# permit tcp any 192.168.0.0 0.0.255.255 established
R1-EDGE(config-ext-nacl)# deny ip any any log
R1-EDGE(config-ext-nacl)# end
```

La navigation web fonctionne toujours, et le port 8080 n'est plus joignable par une connexion normale. **C'est un vrai progrès.**

**Étape 6 — Contourner `established`**

Maintenant, la démonstration. Depuis la machine externe :

```bash
attaquant@ext:~$ sudo nmap -sA -p 1-1000 192.168.10.10
```

`-sA` est le **scan ACK** : `nmap` envoie des paquets dont le bit ACK est positionné, sans qu'aucune connexion n'existe.

Ces paquets **traversent l'ACL**, parce qu'`established` ne regarde que ce bit. `nmap` peut ainsi cartographier ce que ton ACL filtre et ce qu'elle laisse passer — c'est exactement ce pour quoi ce mode de scan a été conçu.

> 🧠 **Ce que tu viens de démontrer** : `established` juge sur l'**apparence** d'un paquet, pas sur la **réalité** d'une conversation. Un attaquant qui fabrique ses paquets n'est pas gêné.

**Étape 7 — La même chose côté FortiGate**

Retire tout de R1 :

```cisco
R1-EDGE(config)# interface GigabitEthernet0/0
R1-EDGE(config-if)# no ip access-group DEPUIS-INTERNET in
R1-EDGE(config-if)# end
```

Sur le FortiGate, tu n'as **rien à faire**. Aucune politique `port1 → port2` n'existe, donc rien n'entre. Et la navigation fonctionne, grâce à la seule politique `LAN → Internet` du TP 7.

Refais le scan ACK :

```bash
attaquant@ext:~$ sudo nmap -sA -p 1-1000 192.168.10.10
Nmap scan report for 192.168.10.10 [host down]
Note: Host seems down. If it is really up, but blocking our ping probes, try -Pn
```

**Première leçon, avant même le scan** : le FortiGate rend la machine
invisible. `nmap` commence toujours par une phase de *découverte* — un
écho ICMP, puis une connexion TCP vers 80 et 443 — et le pare-feu jette
les trois, faute de politique entrante. `nmap` en conclut que l'hôte
est éteint et **ne scanne rien du tout**. Fais ce que `nmap` te dit :

```bash
attaquant@ext:~$ sudo nmap -sA -Pn -p 1-1000 192.168.10.10
```

`-Pn` saute la découverte et scanne quand même. Cette fois, **rien ne
passe** — les ports ressortent `filtered` et non `unfiltered`. Vérifie
pourquoi :

```
FGT-01 # diagnose debug flow filter clear
FGT-01 # diagnose debug flow filter addr 192.168.10.10
FGT-01 # diagnose debug flow trace start 10
FGT-01 # diagnose debug enable
```

Tu verras des messages du type :

```
msg="no session matched, drop"
```
ou
```
msg="Denied by forward policy check (policy 0)"
```

**Le pare-feu ne demande pas si le paquet ressemble à une réponse. Il demande s'il correspond à une session qu'il connaît.** Il n'y en a pas, donc il jette.

N'oublie pas :

```
FGT-01 # diagnose debug disable
FGT-01 # diagnose debug reset
```

---

**✅ Résultat attendu**

| Test | R1 + ACL stricte | R1 + ports hauts | R1 + `established` | FortiGate |
|---|---|---|---|---|
| Navigation web | ❌ cassée | ✅ | ✅ | ✅ |
| Port 8080 exposé | ✅ protégé | ❌ **ouvert** | ✅ protégé | ✅ protégé |
| Scan ACK (`nmap -sA`) | ✅ bloqué | ❌ passe | ❌ **passe** | ✅ **bloqué** |
| Nombre de règles écrites | 1 | 3 | 2 | **0** de plus |

Lis la dernière ligne : sur le pare-feu, tu n'as écrit **aucune** règle supplémentaire. La protection est le **comportement par défaut**.

---

**🧠 Ce que tu viens d'apprendre**

1. **Une ACL sans état oblige à choisir** entre « la navigation marche » et « rien n'entre ». Les deux sont impossibles ensemble.
2. **La « réparation » par les ports hauts ouvre 64 512 portes.** Ce n'est pas une mauvaise configuration : c'est la seule possible.
3. **`established` juge sur un bit**, donc se contourne avec un paquet fabriqué.
4. **Le pare-feu à états ne juge pas l'apparence mais l'appartenance à une session réelle.**
5. **Et il le fait sans qu'on écrive quoi que ce soit** — c'est le défaut, pas une option.

---

### 15.5 🧠 Limite n°2 : le port n'est pas l'application

Passons à l'exigence n°3 : **interdire le peer-to-peer**.

**Avec R1**, tu vas chercher les ports de BitTorrent. La documentation dit 6881-6889. Tu écris :

```cisco
R1-EDGE(config)# ip access-list extended VERS-INTERNET
R1-EDGE(config-ext-nacl)# deny tcp any any range 6881 6889
R1-EDGE(config-ext-nacl)# permit ip any any
```

**Et ça ne sert à rien.** Voici pourquoi, et c'est instructif :

| Ce que fait BitTorrent | Ce que ton ACL peut y faire |
|---|---|
| Utilise des ports **aléatoires** configurables | Rien — tu ne peux pas tous les bloquer |
| Sait passer en **HTTPS sur le port 443** | Rien — tu ne vas pas bloquer le web |
| Utilise **UDP** et le protocole µTP | Rien |
| Chiffre son trafic (*protocol encryption*) | Rien |
| Fonctionne en **DHT**, sans serveur central | Rien |

Pour bloquer BitTorrent avec des ports, il faudrait **fermer tout Internet sauf une liste blanche**. Ce qui est une stratégie défendable dans un environnement industriel, et impraticable ailleurs.

**Avec le FortiGate**, le contrôle applicatif (§14.4) reconnaît **la signature du protocole**, quel que soit le port :

```
config application list
    edit "APP-Bloquer-P2P"
        config entries
            edit 1
                set category 2          ← catégorie P2P entière
                set action block
                set log enable
            next
        end
    next
end
```

Une catégorie, une règle. Et elle attrape BitTorrent sur le port 443 chiffré aussi bien que sur le 6881.

> 🧠 **La différence de nature**
> R1 demande : « **par quelle porte** ce paquet passe-t-il ? »
> Le FortiGate demande : « **qu'est-ce que** ce paquet transporte ? »
>
> La première question a une réponse que l'attaquant contrôle. La seconde, non.

### 15.6 🧠 Limite n°3 : le contenu est invisible

Exigence n°4 : **aucun exécutable téléchargé**.

**Avec R1** : impossible. Point final. Un routeur achemine des paquets, il ne reconstitue pas de fichiers, il n'a pas de signatures antivirus, et il n'a pas la puissance de calcul pour analyser un flux. Il n'existe aucune configuration IOS qui réponde à cette exigence.

Ce n'est pas une question de compétence de l'administrateur ni de version d'IOS : la fonction n'existe pas.

**Avec le FortiGate** : c'est le TP 12, étape 7. Tu l'as déjà fait, et tu as même bloqué un exécutable déguisé en `.jpg` — parce que le pare-feu lit les octets, pas l'extension.

| Menace | R1 | FortiGate |
|---|---|---|
| Virus dans un téléchargement | ❌ invisible | ✅ antivirus |
| Site d'hameçonnage | ❌ invisible | ✅ filtrage web |
| Exécutable déguisé | ❌ invisible | ✅ filtrage de fichiers |
| Tentative d'injection SQL | ❌ invisible | ✅ IPS |
| Poste contactant son serveur de commande | ❌ invisible | ✅ filtrage DNS botnet |

### 15.7 🧠 Limite n°4 : une adresse IP n'est pas une personne

Exigence n°5 : **le stagiaire n'a pas les droits du directeur**.

**Avec R1**, ta règle parle d'adresses :

```cisco
R1-EDGE(config)# permit ip host 192.168.10.47 any
```

Cette règle protège **une prise réseau**, pas une personne. Elle se trompe dès que :
- le stagiaire s'assoit au bureau du directeur ;
- le DHCP attribue une autre adresse ;
- quelqu'un configure son poste en adresse fixe ;
- l'utilisateur se connecte en Wi-Fi plutôt qu'en filaire.

**Avec le FortiGate**, la règle parle de personnes :

```
config firewall policy
    edit 20
        set groups "Direction"      ← un groupe d'utilisateurs
        ...
    next
end
```

L'utilisateur s'authentifie (section 17), et la politique le suit **où qu'il se branche**. C'est le sujet de la partie VI.

---

### 🧪 TP 14 — Le bilan, exigence par exigence

**🎯 Objectif**
Reprendre les cinq exigences du §15.1 et établir, mesure à l'appui, ce que chaque équipement sait faire. C'est le tableau que tu montreras à ta direction.

**⏱️ Durée** : 20 minutes

**📋 Prérequis** : TP 13 terminé

---

**🔧 Manipulation**

**Étape 1 — Exigence n°1 : la navigation fonctionne**

Depuis le PC du LAN :

```bash
user@pc-lan:~$ curl -s -o /dev/null -w "%{http_code}\n" http://neverssl.com
200
```

✅ R1 sait faire. ✅ Le FortiGate aussi.

**Étape 2 — Exigence n°2 : rien n'entre**

```bash
attaquant@ext:~$ sudo nmap -sA -Pn -p 1-1000 192.168.10.10
attaquant@ext:~$ sudo nmap -sS -Pn -p 1-1000 192.168.10.10
```

> 💡 `-Pn` parce que le FortiGate jette aussi les sondes de découverte :
> sans lui, `nmap` déclare l'hôte éteint et ne scanne rien.


⚠️ R1 : partiellement (échoue sur le scan ACK). ✅ Le FortiGate : oui.

**Étape 3 — Exigence n°3 : pas de peer-to-peer**

Simule un trafic sur un port non standard. Sur le serveur DMZ :

```bash
user@srv-dmz:~$ python3 -m http.server 6881
```

Depuis le PC du LAN :

```bash
user@pc-lan:~$ curl -m 5 http://192.168.20.10:6881
```

Puis change de port et recommence sur `9999`. **Une ACL par port ne suivra jamais.**

❌ R1 : non. ✅ Le FortiGate : oui, par signature applicative.

**Étape 4 — Exigence n°4 : pas d'exécutable**

Reprends le test du TP 12 étape 7, avec le faux `photo.jpg` :

```bash
user@pc-lan:~$ curl -O http://192.168.20.10/photo.jpg
```

❌ R1 : structurellement impossible. ✅ Le FortiGate : bloqué, tu l'as vu.

**Étape 5 — Exigence n°5 : par utilisateur**

```
FGT-01 # diagnose firewall auth list
```

❌ R1 : ne connaît que des adresses. ✅ Le FortiGate : section 17.

**Étape 6 — Le tableau de synthèse**

Remplis-le toi-même à partir de tes propres mesures :

| # | Exigence | R1 + ACL | R1 + ZBF | FortiGate |
|---|---|---|---|---|
| 1 | La navigation fonctionne | ✅ | ✅ | ✅ |
| 2 | Rien n'entre depuis Internet | ⚠️ contournable | ✅ | ✅ |
| 3 | Pas de peer-to-peer | ❌ | ❌ | ✅ |
| 4 | Pas d'exécutable téléchargé | ❌ | ❌ | ✅ |
| 5 | Droits par utilisateur | ❌ | ❌ | ✅ |
| | **Score** | **1,5 / 5** | **2 / 5** | **5 / 5** |

---

**✅ Résultat attendu**

Tu disposes d'un tableau **que tu as mesuré toi-même**, et non recopié d'une plaquette commerciale. C'est ce qui fait la différence quand quelqu'un te demande de justifier une dépense.

---

**🧠 Ce que tu viens d'apprendre**

1. **Un routeur avec des ACL couvre environ 30 % du besoin de sécurité d'une PME.** Ce n'est pas rien, et ce n'est pas assez.
2. **Les trois exigences qu'il ne couvre pas sont précisément les menaces d'aujourd'hui** : applications qui se camouflent, contenu malveillant, usurpation d'identité.
3. **Le ZBF de Cisco comble la première lacune**, pas les autres.
4. **Le pare-feu protège par défaut**, là où l'ACL protège par énumération — et une énumération est toujours incomplète.

---

### 15.8 Alors, où mettre la frontière ?

Terminons par ce qui se fait vraiment en entreprise, parce que la réponse n'est pas « jetez le routeur ».

**L'architecture recommandée**, celle de notre laboratoire :

```
Internet ──► [Routeur de bordure] ──► [Pare-feu] ──► Réseaux internes
                    │                      │
            ACL grossière           Politique de sécurité
            anti-bruit              complète + inspection
```

**Ce qu'on met sur le routeur :**
- Le routage vers l'opérateur (BGP, routes statiques)
- Une ACL **anti-bruit** : filtrage des adresses non routables (*bogons*), anti-usurpation (RFC 2827), blocage des protocoles manifestement illégitimes
- Éventuellement une limitation de débit contre les inondations volumétriques

**Ce qu'on met sur le pare-feu :**
- Toute la politique de sécurité
- Le NAT
- Les profils d'inspection
- L'identité des utilisateurs
- Les VPN

> 💡 **Astuce — pourquoi cette répartition et pas une autre**
> Une ACL sur le routeur coûte presque **zéro** en performance et élimine une part importante du bruit de fond d'Internet. Faire filtrer ce même bruit par le pare-feu lui coûterait des sessions et du processeur pour du trafic qui n'avait aucune chance d'être légitime.
>
> Autrement dit : **le routeur fait le tri grossier à coût nul, le pare-feu fait le travail fin sur ce qui reste.** Chacun à son étage.

**Une ACL anti-bruit type**, à poser sur R1 :

```cisco
R1-EDGE(config)# ip access-list extended ANTI-BRUIT
 ! Anti-usurpation : personne sur Internet ne doit prétendre être chez nous
R1-EDGE(config-ext-nacl)# deny ip 192.168.0.0 0.0.255.255 any log
R1-EDGE(config-ext-nacl)# deny ip 10.0.0.0 0.255.255.255 any log
R1-EDGE(config-ext-nacl)# deny ip 172.16.0.0 0.15.255.255 any log
 ! Adresses qui n'ont rien à faire sur Internet
R1-EDGE(config-ext-nacl)# deny ip 127.0.0.0 0.255.255.255 any log
R1-EDGE(config-ext-nacl)# deny ip 169.254.0.0 0.0.255.255 any log
R1-EDGE(config-ext-nacl)# deny ip 224.0.0.0 15.255.255.255 any log
 ! Le reste passe, le pare-feu prendra la suite
R1-EDGE(config-ext-nacl)# permit ip any any
R1-EDGE(config-ext-nacl)# exit
R1-EDGE(config)# interface GigabitEthernet0/0
R1-EDGE(config-if)# ip access-group ANTI-BRUIT in
```

> 🧠 **Comprendre l'anti-usurpation**
> La première règle mérite qu'on s'y arrête. Un paquet qui **arrive d'Internet** en prétendant venir de `192.168.10.10` est forcément un mensonge : cette adresse est chez toi, à l'intérieur. Personne sur Internet ne peut légitimement l'utiliser comme source.
>
> C'est le principe de la **RFC 2827** (*Network Ingress Filtering*), et c'est l'une des rares mesures que tout opérateur devrait appliquer. Elle coûte trois lignes et elle élimine une famille entière d'attaques par usurpation.
>
> Note que c'est exactement ce que fait le **RPF** du §11.4 sur le FortiGate — mais l'appliquer aussi sur le routeur évite au pare-feu de traiter ces paquets du tout.

### 15.9 Ce qu'il faut répondre quand on te pose la question

Pour finir, la version courte, celle qui tient en réunion :

> « Le routeur sait dire **d'où vient** un paquet et **où il va**. Le pare-feu sait dire **ce que c'est**, **qui l'envoie** et **s'il est dangereux**.
>
> Aujourd'hui, les menaces n'arrivent plus par des ports inhabituels : elles arrivent par le port 443, dans un fichier Word que quelqu'un a ouvert. Un routeur ne voit rien de tout ça — non pas parce qu'il est mal configuré, mais parce que ce n'est pas son métier.
>
> On garde le routeur : il achemine vite et il fait le tri grossier. On ajoute le pare-feu : il fait le travail que le routeur ne peut structurellement pas faire. »

---

## 16. L'inspection SSL/TLS

Plus de 90 % du trafic web est aujourd'hui chiffré. Cela veut dire une chose simple et brutale : **sans inspection SSL, la moitié des profils de la section 14 ne voient presque rien**.

C'est aussi le sujet le plus délicat du tutoriel, parce qu'il touche à la vie privée et qu'il casse des choses si on le déploie mal. On va donc être précis.

### 16.1 Le problème

Quand ton utilisateur consulte `https://exemple.com`, le pare-feu voit passer un flux chiffré. Il ne peut pas savoir :

- quelle **page** est consultée (il voit `exemple.com`, pas `/page-interdite`) ;
- quel **fichier** est téléchargé ;
- si ce fichier contient un **virus** ;
- si la requête est une **injection SQL**.

Le chiffrement protège l'utilisateur des regards indiscrets — y compris celui de son propre pare-feu.

### 16.2 Les deux niveaux d'inspection

**① L'inspection de certificat** (*certificate-inspection*)

Le pare-feu **ne déchiffre rien**. Il lit uniquement les parties **en clair** de la négociation TLS :
- le **SNI** (*Server Name Indication*), c'est-à-dire le nom du site demandé ;
- le **certificat** présenté par le serveur.

| ✅ Ce qu'elle permet | ❌ Ce qu'elle ne permet pas |
|---|---|
| Filtrage web par **domaine** | Filtrage par URL complète |
| Contrôle applicatif partiel | Antivirus |
| Blocage de certificats invalides | IPS sur le contenu |
| **Aucun impact sur la vie privée** | DLP |

**② L'inspection profonde** (*deep-inspection*)

Le pare-feu **déchiffre**, inspecte, puis **rechiffre**. Techniquement, il réalise une interception au milieu — un *man-in-the-middle* — mais **avec ton autorisation** et avec un certificat que tes postes ont appris à considérer comme fiable.

```
Poste ──TLS 1──► [FortiGate déchiffre / inspecte / rechiffre] ──TLS 2──► Serveur
```

| ✅ Ce qu'elle permet | ❌ Ce qu'elle coûte |
|---|---|
| **Tout** : antivirus, IPS, DLP, URL complète | Consommation processeur importante |
| Visibilité totale sur le trafic | Déploiement d'un certificat sur tous les postes |
| | Casse les applications à épinglage de certificat |
| | **Questions juridiques et éthiques réelles** |

### 16.3 🧠 Comprendre : comment ça marche vraiment

Le mécanisme mérite d'être compris, parce qu'il explique tous les problèmes qu'on rencontre ensuite.

**Sans inspection** : ton navigateur vérifie que le certificat de `exemple.com` est signé par une autorité de certification (AC) qu'il connaît. Si oui, cadenas vert.

**Avec inspection profonde** :
1. Ton navigateur demande `exemple.com`
2. Le FortiGate intercepte, et va **lui-même** chercher le vrai certificat auprès du serveur
3. Il vérifie ce certificat pour son propre compte
4. Il **fabrique à la volée** un certificat pour `exemple.com`, qu'il signe **avec sa propre AC**
5. Il présente ce faux certificat à ton navigateur

**D'où la condition indispensable** : ton navigateur doit **faire confiance à l'AC du FortiGate**. Sinon il affiche une grosse alerte de sécurité — ce qui est exactement son travail.

> ⚠️ **Attention — c'est la source n°1 des problèmes en déploiement**
> Si tu actives l'inspection profonde **sans avoir d'abord déployé le certificat de l'AC** sur les postes, **tous tes utilisateurs reçoivent une alerte de sécurité sur tous les sites**. Le standard téléphonique explose en dix minutes.
>
> **L'ordre est impératif :**
> 1. Déployer le certificat de l'AC sur les postes
> 2. Vérifier sur quelques machines pilotes
> 3. **Ensuite seulement** activer l'inspection

### 16.4 L'épinglage de certificat : ce qui va casser

Certaines applications **refusent** par principe tout certificat qui n'est pas celui qu'elles attendent, même signé par une AC de confiance. C'est le *certificate pinning*, et c'est une bonne pratique de sécurité — qui entre en collision frontale avec l'inspection.

**Ce qui casse en général :**

| Catégorie | Exemples |
|---|---|
| Banque et paiement | Applications bancaires, PayPal |
| Systèmes d'exploitation | Windows Update, Apple, mises à jour Android |
| Messageries | WhatsApp, Signal, Telegram |
| Outils de développement | `git`, `npm`, `pip`, Docker |
| Antivirus et sécurité | Leurs propres mises à jour |

**La solution est l'exemption**, et FortiOS fournit une liste maintenue par Fortinet :

```
config firewall ssl-ssh-profile
    edit "Inspection-Profonde"
        set ssl-exempt-webserver enable
        config ssl-exempt
            edit 1
                set type fortiguard-category
                set fortiguard-category 31       ← Finance et banque
            next
            edit 2
                set type address
                set address "FQDN-Windows-Update"
            next
        end
    next
end
```

> 💡 **Astuce professionnelle** : commence toujours par exempter les catégories **Finance**, **Santé** et **Administration publique**. C'est à la fois une nécessité technique et, dans beaucoup de pays, une **obligation légale** — inspecter les échanges bancaires ou médicaux de tes salariés t'expose personnellement.

### 16.5 ⚖️ Le volet juridique et éthique

Je ne peux pas traiter cette section sans en parler, parce que c'est un sujet où un administrateur peut se mettre en tort sans le savoir.

Déchiffrer le trafic de tes utilisateurs, c'est **lire leurs communications**. Dans la plupart des pays, y compris en France et dans l'Union européenne, cela implique :

- **Informer** les utilisateurs, formellement et par écrit (charte informatique, note de service, règlement intérieur) ;
- **Consulter** les instances représentatives du personnel quand elles existent ;
- **Justifier** la mesure par un objectif de sécurité légitime et proportionné ;
- **Exempter** ce qui relève de la vie privée et du secret : banque, santé, messageries personnelles, activité syndicale ;
- **Documenter** le traitement (au titre du RGPD en Europe).

> 🚨 **Danger** : activer l'inspection profonde sans ces précautions expose l'entreprise **et toi personnellement**. « J'ai fait ce qu'on m'a demandé » n'est pas une défense solide.
>
> Ce n'est pas une raison de ne pas le faire — c'est une raison de le faire **correctement**, avec une trace écrite de la décision. Demande la validation par écrit, et garde-la.

### 16.6 Les profils prédéfinis

FortiOS fournit deux profils prêts à l'emploi :

| Profil | Ce qu'il fait |
|---|---|
| `certificate-inspection` | Inspection de certificat uniquement. ⭐ Le défaut sûr |
| `deep-inspection` | Inspection profonde, avec les exemptions Fortinet de base |

C'est `certificate-inspection` que tu as attaché à tes politiques depuis le TP 11 — ce qui explique pourquoi le filtrage d'URL du TP 12 ne fonctionnait qu'en HTTP.

---

### 🧪 TP 15 — Activer l'inspection profonde proprement

**🎯 Objectif**
Exporter l'AC du FortiGate, l'installer sur le PC, activer l'inspection profonde, vérifier qu'elle fonctionne, et observer le certificat substitué. Puis constater ce qui casse.

**⏱️ Durée** : 40 minutes

**📋 Prérequis** : TP 12 terminé

---

**🔧 Manipulation**

**Étape 1 — Voir l'AC du pare-feu**

```
FGT-01 # config vpn certificate local
FGT-01 (local) # show | grep "edit"
FGT-01 (local) # end
```

Tu trouves `Fortinet_CA_SSL`, l'autorité utilisée par défaut pour signer les certificats substitués.

**Étape 2 — Exporter le certificat de l'AC**

En CLI :

```
FGT-01 # execute vpn certificate local export tftp Fortinet_CA_SSL fortinet_ca.cer 192.168.10.10
```

Ou, bien plus simple, **par l'interface web** : `System → Certificates`, sélectionne `Fortinet_CA_SSL`, puis `Download`.

> ⚠️ **Attention** : en production, **on n'utilise pas l'AC d'usine**. Chaque FortiGate sort avec la même, ce qui veut dire que n'importe qui possédant un FortiGate peut forger un certificat que tes postes accepteront. On génère sa propre AC, ou on utilise celle de son domaine Active Directory. C'est une différence majeure entre un lab et une production.

**Étape 3 — Installer l'AC sur le PC**

Sur Linux :

```bash
user@pc-lan:~$ sudo cp fortinet_ca.cer /usr/local/share/ca-certificates/fortinet_ca.crt
user@pc-lan:~$ sudo update-ca-certificates
```

Sur Windows :

```cmd
C:\Users\Lab> certutil -addstore -f "Root" fortinet_ca.cer
```

> 💡 **Astuce en production** : on ne fait évidemment pas ça poste par poste. On déploie par **GPO** dans un domaine Active Directory, ou par la solution de gestion de parc. Sans automatisation, l'inspection profonde n'est pas déployable au-delà de vingt machines.

**Étape 4 — Créer un profil d'inspection profonde**

```
FGT-01 # config firewall ssl-ssh-profile
FGT-01 (ssl-ssh-profile) # edit "Deep-Lab"
FGT-01 (Deep-Lab) # set comment "Inspection profonde du laboratoire"
FGT-01 (Deep-Lab) # config https
FGT-01 (https) # set ports 443
FGT-01 (https) # set status deep-inspection
FGT-01 (https) # end
FGT-01 (Deep-Lab) # set server-cert-mode re-sign
FGT-01 (Deep-Lab) # set caname "Fortinet_CA_SSL"
FGT-01 (Deep-Lab) # set untrusted-caname "Fortinet_CA_Untrusted"
FGT-01 (Deep-Lab) # next
FGT-01 (ssl-ssh-profile) # end
```

**Étape 5 — Ajouter les exemptions indispensables**

```
FGT-01 # config firewall ssl-ssh-profile
FGT-01 (ssl-ssh-profile) # edit "Deep-Lab"
FGT-01 (Deep-Lab) # config ssl-exempt
FGT-01 (ssl-exempt) # edit 1
FGT-01 (1) # set type fortiguard-category
FGT-01 (1) # set fortiguard-category 31
FGT-01 (1) # next
FGT-01 (ssl-exempt) # end
FGT-01 (Deep-Lab) # next
FGT-01 (ssl-ssh-profile) # end
```

**Étape 6 — L'attacher à la politique**

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # set ssl-ssh-profile "Deep-Lab"
FGT-01 (1) # next
FGT-01 (policy) # end
```

**Étape 7 — Observer le certificat substitué**

Depuis le PC du LAN :

```bash
user@pc-lan:~$ echo | openssl s_client -connect www.fortinet.com:443 2>/dev/null | openssl x509 -noout -issuer -subject
```
```
issuer=C = US, ST = California, L = Sunnyvale, O = Fortinet, OU = Certificate Authority, CN = FortiGate CA
subject=CN = www.fortinet.com
```

**Regarde bien l'émetteur.** Le sujet est bien `www.fortinet.com`, mais le certificat est signé par **ton FortiGate**, pas par l'autorité d'origine.

**Tu viens de voir l'interception se produire.** Et ton navigateur l'accepte, parce que tu lui as appris à faire confiance à cette AC à l'étape 3.

**Étape 8 — Vérifier que le filtrage HTTPS fonctionne maintenant**

Reprends la liste d'URL du TP 12, mais teste en **HTTPS** cette fois :

```bash
user@pc-lan:~$ curl -m 10 https://example.com
```

Avec `certificate-inspection`, le blocage par domaine fonctionnait déjà. Avec `deep-inspection`, tu peux maintenant bloquer par **chemin complet** :

```
FGT-01 # config webfilter urlfilter
FGT-01 (urlfilter) # edit 1
FGT-01 (1) # config entries
FGT-01 (entries) # edit 3
FGT-01 (3) # set url "example.com/chemin-interdit"
FGT-01 (3) # set type simple
FGT-01 (3) # set action block
FGT-01 (3) # next
FGT-01 (entries) # end
FGT-01 (1) # next
FGT-01 (urlfilter) # end
```

**Étape 9 — Constater ce qui casse**

Depuis le PC du LAN, essaie un outil à épinglage :

```bash
user@pc-lan:~$ git clone https://github.com/torvalds/linux.git --depth 1
```
```
fatal: unable to access '...': SSL certificate problem: unable to get local issuer certificate
```

**C'est le §16.4 en direct.** `git` refuse le certificat substitué.

Deux solutions, et l'une des deux est mauvaise :

```bash
# ✅ Bonne solution : faire confiance à l'AC (déjà fait à l'étape 3 pour le système,
#    mais git peut avoir son propre magasin)
user@pc-lan:~$ git config --global http.sslCAInfo /etc/ssl/certs/ca-certificates.crt

# ❌ Mauvaise solution, à ne JAMAIS faire en production
user@pc-lan:~$ git config --global http.sslVerify false
```

> 🚨 **Danger** : `sslVerify false` désactive **toute** vérification, y compris contre une vraie attaque. C'est ce que font beaucoup de développeurs quand l'inspection les gêne — et c'est ainsi qu'une mesure de sécurité en détruit une autre.
>
> Si tes développeurs commencent à désactiver la vérification TLS partout, **exempte-les** plutôt : l'inspection qui pousse les gens à se rendre vulnérables est une inspection contre-productive.

**Étape 10 — Mesurer le coût**

```
FGT-01 # get system performance status
FGT-01 # diagnose sys top 5 20
```

Génère du trafic HTTPS et observe la charge. Sur une VM à 1 vCPU, l'inspection profonde est très visible.

**Étape 11 — Revenir à l'inspection de certificat**

Pour la suite du tutoriel, on repasse au profil léger :

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # set ssl-ssh-profile "certificate-inspection"
FGT-01 (1) # next
FGT-01 (policy) # end
```

---

**✅ Résultat attendu**

- L'AC du FortiGate est installée sur le PC
- `openssl s_client` montre un certificat émis par **FortiGate CA**
- Le blocage par URL complète fonctionne en HTTPS
- `git clone` échoue, et tu sais pourquoi
- La charge processeur monte visiblement

---

**🧠 Ce que tu viens d'apprendre**

1. **Sans inspection SSL, l'antivirus et l'IPS ne voient presque rien** du trafic web moderne.
2. **Deux niveaux** : certificat (léger, sans déchiffrement) et profond (tout voir, tout casser).
3. **L'ordre de déploiement est impératif** : le certificat sur les postes AVANT l'activation.
4. **L'épinglage casse**, et la liste des victimes est prévisible.
5. **On n'utilise jamais l'AC d'usine en production.**
6. **Il y a un volet juridique**, et il n'est pas optionnel.
7. **Une inspection trop agressive pousse les gens à désactiver leur propre sécurité.**

---

# Partie VI — Les utilisateurs

---

## 17. Authentification et gestion des utilisateurs

C'est la réponse à la limite n°4 du §15.7 : faire des règles qui parlent de **personnes** plutôt que d'adresses IP.

### 17.1 Pourquoi c'est une rupture

Une politique classique dit : « `192.168.10.47` peut accéder au serveur RH ». Cette règle protège **une prise réseau**. Elle se trompe dès que quelqu'un change de bureau, dès que le DHCP redistribue, dès qu'un poste passe en Wi-Fi.

Une politique authentifiée dit : « les membres du groupe **RH** peuvent accéder au serveur RH ». La règle suit la personne, où qu'elle se branche et quel que soit son poste.

C'est aussi ce qui rend les **journaux exploitables** : « `192.168.10.47` a téléchargé 40 Go » n'accuse personne ; « `marie.durand` a téléchargé 40 Go » est une information.

### 17.2 Les sources d'identité

| Source | Où vivent les comptes | Usage typique |
|---|---|---|
| **Local** | Sur le FortiGate | Petits sites, comptes de service, VPN |
| **LDAP / Active Directory** | Sur un contrôleur de domaine | ⭐ Le cas d'entreprise standard |
| **RADIUS** | Sur un serveur RADIUS | Wi-Fi 802.1X, VPN, NAC |
| **FSSO** | AD, en **transparent** | ⭐ Voir §17.6 |
| **SAML** | Fournisseur d'identité externe | Entra ID, Okta, authentification moderne |
| **Certificat (PKI)** | Certificat client | Environnements à forte exigence |

### 17.3 Les utilisateurs locaux

```
config user local
    edit "marie.durand"
        set type password
        set passwd "MotDePasseSolide2026!"
        set status enable
    next
end

config user group
    edit "GRP-Direction"
        set member "marie.durand"
    next
end
```

> 💡 **Astuce** : les comptes locaux ne se gèrent pas au-delà d'une vingtaine d'utilisateurs. Ils restent utiles pour les **comptes de service**, les accès VPN d'un prestataire, et comme **solution de secours** quand l'annuaire est injoignable — ce dernier point est important : un pare-feu dont l'authentification dépend entièrement d'un AD en panne devient inadministrable au pire moment.

### 17.4 L'intégration LDAP / Active Directory

```
config user ldap
    edit "AD-Entreprise"
        set server "192.168.10.5"
        set cnid "sAMAccountName"
        set dn "dc=entreprise,dc=local"
        set type regular
        set username "cn=svc-fortigate,ou=Services,dc=entreprise,dc=local"
        set password "MotDePasseDuCompteDeService"
        set secure ldaps
        set port 636
        set ca-cert "CA-Entreprise"
    next
end
```

Décryptage des paramètres qui posent problème :

| Paramètre | Ce qu'il faut savoir |
|---|---|
| `cnid` | L'attribut d'identification. **`sAMAccountName` pour AD**, `uid` pour OpenLDAP |
| `dn` | La racine de recherche. Une erreur ici et rien ne remonte |
| `type regular` | Le pare-feu se connecte avec un compte de service pour **chercher** les utilisateurs |
| `secure ldaps` | ⭐ Chiffre la connexion. **Sans ça, les mots de passe circulent en clair** |

> 🚨 **Danger** : LDAP en clair (port 389) fait transiter les identifiants **en clair sur ton réseau**. N'importe qui avec un accès au segment peut les capturer. Utilise **toujours** `ldaps` (636) ou STARTTLS. Ce n'est pas une bonne pratique parmi d'autres : c'est la différence entre une authentification et une distribution de mots de passe.

**Tester la connexion** — la commande qui économise des heures :

```
FGT-01 # diagnose test authserver ldap AD-Entreprise marie.durand SonMotDePasse
```

Elle te dit immédiatement si le problème vient de l'annuaire, du compte de service, du `dn` ou du mot de passe.

**Importer un groupe de l'annuaire :**

```
config user group
    edit "GRP-Direction-AD"
        set member "AD-Entreprise"
        config match
            edit 1
                set server-name "AD-Entreprise"
                set group-name "CN=Direction,OU=Groupes,DC=entreprise,DC=local"
            next
        end
    next
end
```

### 17.5 RADIUS

```
config user radius
    edit "RADIUS-NPS"
        set server "192.168.10.6"
        set secret "SecretPartage2026"
        set auth-type auto
        set nas-ip 192.168.10.1
    next
end
```

```
FGT-01 # diagnose test authserver radius RADIUS-NPS pap marie.durand SonMotDePasse
```

> 💡 **Astuce** : RADIUS peut renvoyer des **attributs** en plus du verdict — notamment le groupe d'appartenance, via l'attribut `Fortinet-Group-Name`. C'est ainsi qu'on fait de l'attribution de droits dynamique sans dupliquer les groupes sur le pare-feu.

### 17.6 🧠 FSSO : l'authentification que l'utilisateur ne voit pas

C'est la fonction qui change le plus la vie des utilisateurs, et la moins comprise.

**Le problème** : demander à quelqu'un de s'authentifier une deuxième fois sur le pare-feu, alors qu'il vient d'ouvrir sa session Windows, est mal vécu — et à juste titre.

**La solution FSSO** (*Fortinet Single Sign-On*) : le pare-feu **apprend** qui est connecté sans jamais rien demander.

**Comment ?** Un agent installé sur les contrôleurs de domaine surveille les **journaux d'ouverture de session** Active Directory. Quand `marie.durand` ouvre sa session sur le poste `192.168.10.47`, l'agent le voit et prévient le FortiGate : « l'adresse `192.168.10.47` est maintenant `marie.durand`, membre des groupes X, Y, Z ».

Le pare-feu maintient alors une table adresse ↔ utilisateur, mise à jour en permanence.

**Résultat** : tes politiques parlent de groupes AD, et l'utilisateur ne voit **jamais** de demande d'authentification.

```
config user fsso
    edit "FSSO-Agent"
        set server "192.168.10.5"
        set password "SecretDeLAgent"
    next
end

config user group
    edit "GRP-FSSO-Direction"
        set group-type fsso-service
        set member "CN=Direction,OU=Groupes,DC=entreprise,DC=local"
    next
end
```

Vérifier ce que le pare-feu sait :

```
FGT-01 # diagnose debug authd fsso list
FGT-01 # diagnose firewall auth list
```

> ⚠️ **Attention — deux limites de FSSO à connaître**
> **① Il ne fonctionne que pour les machines du domaine.** Un téléphone, une tablette, un poste invité ne produisent aucun événement d'ouverture de session AD. Il faut prévoir un mécanisme complémentaire pour eux.
>
> **② Il fait confiance à l'adresse IP.** Si deux personnes utilisent successivement le même poste sans fermer proprement la session, ou si une adresse change de main rapidement, l'association peut être fausse pendant un moment. C'est un compromis assumé : la transparence contre une certitude absolue.

### 17.7 L'authentification par portail captif

Quand FSSO ne s'applique pas, le pare-feu peut **intercepter** la première requête web et présenter une page de connexion.

```
config firewall policy
    edit 5
        set name "Acces-authentifie"
        set srcintf "port2"
        set dstintf "port1"
        set srcaddr "NET-LAN"
        set dstaddr "all"
        set groups "GRP-Direction"     ← ⭐ la politique devient authentifiée
        set service "ALL"
        set schedule "always"
        set action accept
        set nat enable
    next
end
```

> 🧠 **Comprendre** : dès qu'une politique contient `set groups`, elle **exige** une authentification. Un utilisateur non authentifié ne correspond pas à la règle — le paquet continue vers les politiques suivantes, et finit sur l'`Implicit Deny` s'il n'en trouve pas d'autre.
>
> C'est cohérent avec tout ce qu'on a appris au §9.2, et ça produit un symptôme reconnaissable : « certains utilisateurs passent, d'autres non, sans logique apparente ». La logique est là — les premiers sont authentifiés.

Les réglages du portail :

```
config user setting
    set auth-timeout 480
    set auth-timeout-type idle-timeout
    set auth-secure-http enable
    set auth-on-demand implicitly
end
```

| Paramètre | Rôle |
|---|---|
| `auth-timeout 480` | 480 **minutes** avant de redemander |
| `auth-timeout-type` | `idle-timeout` (inactivité) ou `hard-timeout` (absolu) |
| `auth-secure-http` | ⭐ Force le portail en HTTPS. **Indispensable** |

---

### 🧪 TP 16 — Une politique qui parle de personnes

**🎯 Objectif**
Créer des utilisateurs locaux et des groupes, écrire une politique authentifiée, se connecter par le portail captif, et observer la table d'authentification. Puis constater dans les journaux la différence entre une adresse et un nom.

**⏱️ Durée** : 35 minutes

**📋 Prérequis** : TP 7 terminé

---

**🔧 Manipulation**

**Étape 1 — Créer deux utilisateurs**

```
FGT-01 # config user local
FGT-01 (local) # edit "marie.durand"
FGT-01 (marie.durand) # set type password
FGT-01 (marie.durand) # set passwd "Direction2026!"
FGT-01 (marie.durand) # set status enable
FGT-01 (marie.durand) # next
FGT-01 (local) # edit "paul.stagiaire"
FGT-01 (paul.stagiaire) # set type password
FGT-01 (paul.stagiaire) # set passwd "Stagiaire2026!"
FGT-01 (paul.stagiaire) # set status enable
FGT-01 (paul.stagiaire) # next
FGT-01 (local) # end
```

**Étape 2 — Créer deux groupes**

```
FGT-01 # config user group
FGT-01 (group) # edit "GRP-Direction"
FGT-01 (GRP-Direction) # set member "marie.durand"
FGT-01 (GRP-Direction) # next
FGT-01 (group) # edit "GRP-Stagiaires"
FGT-01 (GRP-Stagiaires) # set member "paul.stagiaire"
FGT-01 (GRP-Stagiaires) # next
FGT-01 (group) # end
```

**Étape 3 — Rendre la politique Internet authentifiée**

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # set groups "GRP-Direction" "GRP-Stagiaires"
FGT-01 (1) # next
FGT-01 (policy) # end
```

**Étape 4 — Régler le portail**

```
FGT-01 # config user setting
FGT-01 (setting) # set auth-timeout 480
FGT-01 (setting) # set auth-timeout-type idle-timeout
FGT-01 (setting) # set auth-secure-http enable
FGT-01 (setting) # end
```

**Étape 5 — Tester**

Depuis le PC du LAN, **en ligne de commande**. Première requête HTTP :

```bash
user@pc-lan:~$ curl -sSi http://192.168.20.10/
```
```
HTTP/1.1 303 See Other
Location: https://192.168.10.1:1003/
```

**Le pare-feu ne répond pas la page demandée : il redirige vers son portail
d'authentification.** C'est ce qu'un navigateur affiche comme « page de
connexion » ; en CLI, on le lit dans l'en-tête `Location`. Le port **1000**
est celui du portail en clair, **1003** celui en TLS — c'est
`auth-secure-http enable` de l'étape 4 qui fait pointer la redirection vers
le second.

Authentifie-toi en postant les identifiants au portail, toujours en CLI :

```bash
user@pc-lan:~$ curl -sS -d "username=marie.durand&password=Direction2026!" http://192.168.10.1:1000/
```
```
Authentication successful
```

Puis rejoue la requête — elle passe maintenant :

```bash
user@pc-lan:~$ curl -sSi http://192.168.20.10/
```
```
HTTP/1.1 200 OK
```

> 💡 Un navigateur fait exactement ces trois échanges : il suit la
> redirection, poste le formulaire, rejoue la requête. `curl` les montre un
> par un — c'est la raison de faire ce TP en CLI.

**Étape 6 — Voir la table d'authentification**

```
FGT-01 # diagnose firewall auth list
```
```
192.168.10.10, marie.durand
        type: fw, id: 0, duration: 142, idled: 12
        expire: 28658, allow-idle: 28800
        flag(10): auth
        packets: 214, bytes: 38121
        group_id: 3
        group_name: GRP-Direction
```

**Le pare-feu associe désormais une adresse IP à une PERSONNE.** C'est toute la différence avec le §15.7.

**Étape 7 — Différencier les droits**

Bloquons un service pour les stagiaires uniquement. Crée une règle plus spécifique **au-dessus** :

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 4
FGT-01 (4) # set name "Stagiaires-restreints"
FGT-01 (4) # set srcintf "port2"
FGT-01 (4) # set dstintf "port3"
FGT-01 (4) # set srcaddr "NET-LAN"
FGT-01 (4) # set dstaddr "NET-DMZ"
FGT-01 (4) # set groups "GRP-Stagiaires"
FGT-01 (4) # set service "PING"
FGT-01 (4) # set schedule "always"
FGT-01 (4) # set action deny
FGT-01 (4) # set logtraffic all
FGT-01 (4) # next
FGT-01 (policy) # move 4 before 2
FGT-01 (policy) # end
```

> 🧠 Souviens-toi du §9.2 : cette règle doit être **avant** la règle générale `LAN-vers-DMZ`, sinon elle ne sera jamais lue. Tu appliques ici, sans y penser, ce que le TP 7 t'a appris.

**Étape 8 — Vérifier la différence**

Déconnecte l'utilisateur courant :

```
FGT-01 # diagnose firewall auth clear
```

Puis, depuis le PC, authentifie-toi en **stagiaire** et teste :

```bash
user@pc-lan:~$ ping -c 3 192.168.20.10       ← doit être bloqué
```

Recommence en **Direction** :

```bash
user@pc-lan:~$ ping -c 3 192.168.20.10       ← doit passer
```

**La même machine, la même adresse IP, deux comportements différents selon qui est connecté.** C'est exactement ce qu'un routeur ne saura jamais faire.

**Étape 9 — Lire les journaux**

```
FGT-01 # execute log filter category 0
FGT-01 # execute log filter field user "paul.stagiaire"
FGT-01 # execute log display
```

Le champ `user` apparaît dans chaque entrée. Compare avec les journaux du TP 7, où il n'y avait qu'une adresse.

**Étape 10 — Nettoyer**

```
FGT-01 # config firewall policy
FGT-01 (policy) # delete 4
FGT-01 (policy) # end

FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # unset groups
FGT-01 (1) # next
FGT-01 (policy) # end
```

---

**✅ Résultat attendu**

- `diagnose firewall auth list` associe l'adresse à un nom
- La même machine se comporte différemment selon l'utilisateur connecté
- Les journaux portent le champ `user`

---

**🧠 Ce que tu viens d'apprendre**

1. **`set groups` transforme une politique en politique authentifiée**, et un non-authentifié n'y correspond simplement pas.
2. **La règle suit la personne**, pas la prise réseau.
3. **FSSO authentifie sans rien demander**, en lisant les ouvertures de session AD.
4. **LDAP doit être en LDAPS.** Sinon tu distribues des mots de passe.
5. **`diagnose test authserver`** te dit d'où vient un échec d'authentification.
6. **Les journaux nommés sont exploitables**, les journaux d'adresses ne le sont pas.

---

# Partie VII — Les VPN

---

## 18. VPN IPsec site-à-site

Relier deux sites distants par un tunnel chiffré à travers Internet. C'est l'usage historique du VPN, et il reste le plus courant.

### 18.1 Le principe

```
   Site A (Paris)                              Site B (Lyon)
   192.168.10.0/24                             192.168.50.0/24
        │                                            │
   ┌────┴─────┐                                ┌─────┴────┐
   │  FGT-01  │═══════ tunnel chiffré ═════════│  FGT-02  │
   └────┬─────┘        à travers Internet      └─────┬────┘
        │                                            │
    R1-EDGE ──────────── Internet ──────────────── R2-EDGE
```

Les postes de Paris joignent ceux de Lyon **comme s'ils étaient sur le même réseau**, alors que le trafic traverse Internet — chiffré, authentifié, et illisible pour quiconque l'intercepte.

### 18.2 🧠 Comprendre : les deux phases d'IPsec

IPsec négocie en **deux temps**, et savoir lequel échoue est 80 % du diagnostic.

**Phase 1 (IKE) — « qui es-tu ? »**

Les deux pare-feux s'authentifient mutuellement et établissent un canal sécurisé pour discuter. Ils se mettent d'accord sur :

| Paramètre | Rôle |
|---|---|
| Méthode d'authentification | Clé partagée (PSK) ou certificat |
| Chiffrement | AES-256, AES-128… |
| Hachage | SHA-256, SHA-512… |
| Groupe Diffie-Hellman | 14, 19, 20… — la robustesse de l'échange de clés |
| Durée de vie | 86400 s par défaut |

**Phase 2 (IPsec) — « que transporte-t-on ? »**

Une fois qu'ils se font confiance, ils négocient le tunnel de données lui-même :

| Paramètre | Rôle |
|---|---|
| Sélecteurs | **Quels réseaux** passent dans le tunnel |
| Chiffrement / hachage | Ceux du transport |
| PFS | Renégocie une clé neuve à chaque renouvellement |
| Durée de vie | 43200 s par défaut |

> 🧠 **La règle d'or du diagnostic IPsec**
> **Les deux côtés doivent être d'accord sur TOUT.** Un seul paramètre qui diffère et le tunnel ne monte pas.
>
> Et surtout : **savoir quelle phase échoue divise le problème en deux.**
> - La **phase 1** échoue → problème d'**authentification** ou de **joignabilité** : clé partagée différente, identifiants qui ne correspondent pas, UDP/500 filtré.
> - La **phase 2** échoue → problème de **sélecteurs** ou d'algorithmes de transport : les réseaux déclarés ne correspondent pas de part et d'autre.
>
> Ne cherche jamais au hasard : regarde d'abord **où** ça casse.

### 18.3 Les ports à laisser passer

| Port / protocole | Rôle |
|---|---|
| **UDP 500** | IKE — la négociation |
| **UDP 4500** | NAT-Traversal — quand un routeur NAT est sur le chemin |
| **Protocole IP 50** | ESP — les données chiffrées |

> ⚠️ **Attention** : dans notre laboratoire, R1 fait du NAT (§3.8). Le trafic IPsec devra donc utiliser **NAT-T** (UDP 4500), qui encapsule ESP dans de l'UDP — parce qu'ESP est un protocole IP à part entière, sans numéro de port, et qu'un NAT ne sait pas quoi en faire.
>
> C'est la cause n°1 des tunnels qui montent en laboratoire mais pas en production, ou l'inverse. FortiOS active NAT-T automatiquement quand il détecte un NAT, mais il faut que le routeur laisse passer UDP 4500.

### 18.4 La configuration, côté Paris

**Phase 1 :**

```
config vpn ipsec phase1-interface
    edit "VPN-vers-Lyon"
        set interface "port1"
        set ike-version 2
        set peertype any
        set net-device disable
        set proposal aes256-sha256
        set dhgrp 14
        set remote-gw 203.0.113.50
        set psksecret "UneCleTresLongueEtAleatoire2026!"
        set dpd on-idle
        set dpd-retryinterval 60
    next
end
```

**Phase 2 :**

```
config vpn ipsec phase2-interface
    edit "VPN-vers-Lyon-P2"
        set phase1name "VPN-vers-Lyon"
        set proposal aes256-sha256
        set pfs enable
        set dhgrp 14
        set src-subnet 192.168.10.0 255.255.255.0
        set dst-subnet 192.168.50.0 255.255.255.0
        set auto-negotiate enable
    next
end
```

**La route vers le site distant :**

```
config router static
    edit 10
        set dst 192.168.50.0 255.255.255.0
        set device "VPN-vers-Lyon"
        set comment "Reseau de Lyon via le tunnel"
    next
end
```

**Et les politiques — dans les DEUX sens :**

```
config firewall policy
    edit 20
        set name "Paris-vers-Lyon"
        set srcintf "port2"
        set dstintf "VPN-vers-Lyon"
        set srcaddr "NET-LAN"
        set dstaddr "NET-LYON"
        set action accept
        set schedule "always"
        set service "ALL"
        set logtraffic all
    next
    edit 21
        set name "Lyon-vers-Paris"
        set srcintf "VPN-vers-Lyon"
        set dstintf "port2"
        set srcaddr "NET-LYON"
        set dstaddr "NET-LAN"
        set action accept
        set schedule "always"
        set service "ALL"
        set logtraffic all
    next
end
```

> ⚠️ **Attention — ici, DEUX politiques sont nécessaires**
> Ça semble contredire la règle d'or du §1.6. Ce n'est pas le cas, et la nuance est importante.
>
> La table de sessions gère le **retour d'une connexion ouverte**. Mais dans un VPN site-à-site, **les deux sites initient des connexions** : Paris consulte un serveur de Lyon, et Lyon consulte un serveur de Paris. Ce sont deux **ouvertures** distinctes, pas un aller-retour.
>
> Si tu n'écris que `Paris → Lyon`, un utilisateur de Lyon ne pourra rien ouvrir vers Paris. **Une politique par sens d'ouverture**, toujours.

> 🚨 **Danger — n'active JAMAIS le NAT sur une politique VPN**
> `set nat enable` réécrirait les adresses source, et le site distant verrait tout le trafic arriver depuis l'adresse du pare-feu. Les sélecteurs de phase 2 ne correspondraient plus, et le tunnel rejetterait le trafic. Laisse `nat disable`.

### 18.5 Côté Lyon : le miroir exact

Tout est symétrique. `remote-gw` pointe vers Paris, et les sous-réseaux de phase 2 sont **inversés** :

```
config vpn ipsec phase2-interface
    edit "VPN-vers-Paris-P2"
        set src-subnet 192.168.50.0 255.255.255.0     ← inversé
        set dst-subnet 192.168.10.0 255.255.255.0     ← inversé
    next
end
```

> ⚠️ **C'est l'erreur n°1 des tunnels qui ne montent pas en phase 2.** Les sélecteurs doivent être **le miroir exact** l'un de l'autre. Si Paris déclare `src=10.0/24, dst=50.0/24`, Lyon doit déclarer `src=50.0/24, dst=10.0/24`. Une inversion oubliée, et la phase 1 monte parfaitement pendant que la phase 2 échoue — ce qui déroute, parce que « le tunnel est up » dans l'affichage.

### 18.6 Le diagnostic IPsec

Les commandes, dans l'ordre où on les utilise :

```
FGT-01 # get vpn ipsec tunnel summary
FGT-01 # diagnose vpn ike gateway list
FGT-01 # diagnose vpn tunnel list
```

Et le débogage détaillé, quand rien ne monte :

```
FGT-01 # diagnose vpn ike log filter clear
FGT-01 # diagnose vpn ike log filter dst-addr4 203.0.113.50
FGT-01 # diagnose debug application ike -1
FGT-01 # diagnose debug enable
```

Puis on force la négociation :

```
FGT-01 # diagnose vpn ike gateway clear name VPN-vers-Lyon
```

Et on arrête, **toujours** :

```
FGT-01 # diagnose debug disable
FGT-01 # diagnose debug reset
```

**Les messages qu'on rencontre le plus, et ce qu'ils veulent dire :**

| Message | Cause réelle |
|---|---|
| `no SA proposal chosen` | Les propositions de chiffrement ne correspondent pas |
| `probable pre-shared secret mismatch` | La clé partagée diffère |
| `peer SA proposal not match local policy` | Sélecteurs de phase 2 non miroir |
| `negotiation timeout` | Le pair ne répond pas — UDP/500 filtré, adresse fausse |
| `IPsec SA connect... failure` | Phase 1 réussie, phase 2 échouée |

---

### 🧪 TP 17 — Monter un tunnel entre deux sites

**🎯 Objectif**
Créer un second FortiGate, monter le tunnel, faire communiquer les deux LAN, puis **casser volontairement** un paramètre pour apprendre à lire un échec.

**⏱️ Durée** : 60 minutes

**📋 Prérequis** : un second FortiGate (§2.7 sur les licences), les deux joignables entre eux

> 💡 **Astuce** : si tu ne peux avoir qu'un seul FortiGate, lis ce TP sans l'exécuter — mais **fais absolument l'étape 8**, qui t'apprend à lire un journal IKE. C'est ce qu'on te demandera en entretien.

---

**🔧 Manipulation**

**Étape 1 — Préparer FGT-02**

Configure un second pare-feu selon le même schéma : `port1` vers le transit, `port2` en `192.168.50.1/24`.

```
FGT-02 # config system global
FGT-02 (global) # set hostname FGT-02
FGT-02 (global) # end

FGT-02 # config system interface
FGT-02 (interface) # edit port2
FGT-02 (port2) # set alias "LAN-Lyon"
FGT-02 (port2) # set ip 192.168.50.1 255.255.255.0
FGT-02 (port2) # set allowaccess ping https ssh
FGT-02 (port2) # next
FGT-02 (interface) # end
```

**Étape 2 — Vérifier la joignabilité AVANT de configurer le VPN**

```
FGT-01 # execute ping <adresse-port1-de-FGT-02>
```

> 🧠 **Ne saute pas cette étape.** Un tunnel ne peut pas monter si les deux extrémités ne se voient pas. Vérifier d'abord évite de chercher un problème IPsec là où il n'y a qu'un problème de routage.

**Étape 3 — Les objets adresse**

Sur FGT-01 :

```
FGT-01 # config firewall address
FGT-01 (address) # edit "NET-LYON"
FGT-01 (NET-LYON) # set subnet 192.168.50.0 255.255.255.0
FGT-01 (NET-LYON) # next
FGT-01 (address) # end
```

Sur FGT-02, l'équivalent pour `NET-PARIS` en `192.168.10.0/24`.

**Étape 4 — Phase 1 sur FGT-01**

```
FGT-01 # config vpn ipsec phase1-interface
FGT-01 (phase1-interface) # edit "VPN-Lyon"
FGT-01 (VPN-Lyon) # set interface "port1"
FGT-01 (VPN-Lyon) # set ike-version 2
FGT-01 (VPN-Lyon) # set peertype any
FGT-01 (VPN-Lyon) # set net-device disable
FGT-01 (VPN-Lyon) # set proposal aes256-sha256
FGT-01 (VPN-Lyon) # set dhgrp 14
FGT-01 (VPN-Lyon) # set remote-gw <adresse-port1-de-FGT-02>
FGT-01 (VPN-Lyon) # set psksecret "CleLabFortiGate2026!"
FGT-01 (VPN-Lyon) # set dpd on-idle
FGT-01 (VPN-Lyon) # next
FGT-01 (phase1-interface) # end
```

**Étape 5 — Phase 2 sur FGT-01**

```
FGT-01 # config vpn ipsec phase2-interface
FGT-01 (phase2-interface) # edit "VPN-Lyon-P2"
FGT-01 (VPN-Lyon-P2) # set phase1name "VPN-Lyon"
FGT-01 (VPN-Lyon-P2) # set proposal aes256-sha256
FGT-01 (VPN-Lyon-P2) # set pfs enable
FGT-01 (VPN-Lyon-P2) # set dhgrp 14
FGT-01 (VPN-Lyon-P2) # set src-subnet 192.168.10.0 255.255.255.0
FGT-01 (VPN-Lyon-P2) # set dst-subnet 192.168.50.0 255.255.255.0
FGT-01 (VPN-Lyon-P2) # set auto-negotiate enable
FGT-01 (VPN-Lyon-P2) # next
FGT-01 (phase2-interface) # end
```

**Étape 6 — Le miroir sur FGT-02**

Identique, sauf `remote-gw` (qui pointe vers FGT-01) et les sous-réseaux
**inversés**. La clé partagée doit être **rigoureusement identique** :

```
FGT-02 # config vpn ipsec phase1-interface
FGT-02 (phase1-interface) # edit "VPN-Paris"
FGT-02 (VPN-Paris) # set interface "port1"
FGT-02 (VPN-Paris) # set ike-version 2
FGT-02 (VPN-Paris) # set peertype any
FGT-02 (VPN-Paris) # set net-device disable
FGT-02 (VPN-Paris) # set proposal aes256-sha256
FGT-02 (VPN-Paris) # set dhgrp 14
FGT-02 (VPN-Paris) # set remote-gw <adresse-port1-de-FGT-01>
FGT-02 (VPN-Paris) # set psksecret "CleLabFortiGate2026!"
FGT-02 (VPN-Paris) # set dpd on-idle
FGT-02 (VPN-Paris) # next
FGT-02 (phase1-interface) # end

FGT-02 # config vpn ipsec phase2-interface
FGT-02 (phase2-interface) # edit "VPN-Paris-P2"
FGT-02 (VPN-Paris-P2) # set phase1name "VPN-Paris"
FGT-02 (VPN-Paris-P2) # set proposal aes256-sha256
FGT-02 (VPN-Paris-P2) # set pfs enable
FGT-02 (VPN-Paris-P2) # set dhgrp 14
FGT-02 (VPN-Paris-P2) # set src-subnet 192.168.50.0 255.255.255.0
FGT-02 (VPN-Paris-P2) # set dst-subnet 192.168.10.0 255.255.255.0
FGT-02 (VPN-Paris-P2) # set auto-negotiate enable
FGT-02 (VPN-Paris-P2) # next
FGT-02 (phase2-interface) # end
```

> ⚠️ **`src-subnet` est TON réseau, `dst-subnet` celui d'en face.** Les deux
> côtés décrivent donc les mêmes sous-réseaux dans l'ordre inverse. Les
> intervertir monte la phase 1 et laisse la phase 2 à zéro sélecteur — la
> panne du §21.6, et celle de l'étape 11 plus bas.

**Étape 7 — Route et politiques**

Sur FGT-01 :

```
FGT-01 # config router static
FGT-01 (static) # edit 10
FGT-01 (10) # set dst 192.168.50.0 255.255.255.0
FGT-01 (10) # set device "VPN-Lyon"
FGT-01 (10) # next
FGT-01 (static) # end

FGT-01 # config firewall policy
FGT-01 (policy) # edit 20
FGT-01 (20) # set name "Paris-vers-Lyon"
FGT-01 (20) # set srcintf "port2"
FGT-01 (20) # set dstintf "VPN-Lyon"
FGT-01 (20) # set srcaddr "NET-LAN"
FGT-01 (20) # set dstaddr "NET-LYON"
FGT-01 (20) # set action accept
FGT-01 (20) # set schedule "always"
FGT-01 (20) # set service "ALL"
FGT-01 (20) # set logtraffic all
FGT-01 (20) # next
FGT-01 (policy) # edit 21
FGT-01 (21) # set name "Lyon-vers-Paris"
FGT-01 (21) # set srcintf "VPN-Lyon"
FGT-01 (21) # set dstintf "port2"
FGT-01 (21) # set srcaddr "NET-LYON"
FGT-01 (21) # set dstaddr "NET-LAN"
FGT-01 (21) # set action accept
FGT-01 (21) # set schedule "always"
FGT-01 (21) # set service "ALL"
FGT-01 (21) # set logtraffic all
FGT-01 (21) # next
FGT-01 (policy) # end
```

Fais l'équivalent, en miroir, sur FGT-02.

**Étape 8 — Monter le tunnel et le lire**

```
FGT-01 # diagnose vpn ike gateway clear name VPN-Lyon
FGT-01 # get vpn ipsec tunnel summary
```
```
'VPN-Lyon' 203.0.113.50:0  selectors(total,up): 1/1  rx(pkt,err): 24/0  tx(pkt,err): 24/0
```

`selectors(total,up): 1/1` signifie que la phase 2 est établie. C'est **la ligne à regarder**.

```
FGT-01 # diagnose vpn tunnel list
```

Tu obtiens le détail : algorithmes retenus, compteurs, durée de vie restante.

**Étape 9 — Tester de bout en bout**

```bash
user@pc-lan:~$ ping -c 5 192.168.50.10
```

**Le trafic traverse Internet, chiffré.** 🎉

Vérifie-le :

```
FGT-01 # diagnose sniffer packet port1 'udp port 4500 or esp' 4 20
```

Tu vois passer des paquets **chiffrés** — impossible d'y lire les adresses internes ou le contenu.

**Étape 10 — Casser volontairement, et diagnostiquer**

Change la clé partagée sur **un seul** côté :

```
FGT-02 # config vpn ipsec phase1-interface
FGT-02 (phase1-interface) # edit "VPN-Paris"
FGT-02 (VPN-Paris) # set psksecret "MauvaiseCle"
FGT-02 (VPN-Paris) # next
FGT-02 (phase1-interface) # end
```

Sur FGT-01 :

```
FGT-01 # diagnose vpn ike log filter clear
FGT-01 # diagnose debug application ike -1
FGT-01 # diagnose debug enable
FGT-01 # diagnose vpn ike gateway clear name VPN-Lyon
```

Tu vois défiler les tentatives, avec un message parlant de secret partagé ou d'échec d'authentification.

**Tu viens d'apprendre à reconnaître un échec de phase 1.**

```
FGT-01 # diagnose debug disable
FGT-01 # diagnose debug reset
```

**Étape 11 — Casser la phase 2 (le plus instructif)**

Remets la bonne clé, puis change un **sélecteur** :

```
FGT-02 # config vpn ipsec phase2-interface
FGT-02 (phase2-interface) # edit "VPN-Paris-P2"
FGT-02 (VPN-Paris-P2) # set dst-subnet 192.168.99.0 255.255.255.0
FGT-02 (VPN-Paris-P2) # next
FGT-02 (phase2-interface) # end
```

```
FGT-01 # get vpn ipsec tunnel summary
```
```
'VPN-Lyon' 203.0.113.50:0  selectors(total,up): 1/0
```

**Regarde bien : `1/0`.** La phase 1 est montée — la passerelle est là, authentifiée — mais **aucun sélecteur n'est établi**.

> 🧠 **C'est le cas qui déroute tout le monde.** La GUI peut afficher le tunnel comme « up » parce que la phase 1 fonctionne, et pourtant rien ne passe. La ligne `selectors(total,up)` est la seule qui dise la vérité.
>
> Retiens : **`x/0` = phase 2 en échec = sélecteurs non miroir.**

Remets la bonne valeur.

---

**✅ Résultat attendu**

- `get vpn ipsec tunnel summary` affiche `selectors(total,up): 1/1`
- Un ping traverse le tunnel entre les deux LAN
- Une capture sur `port1` ne montre que du chiffré
- Tu reconnais un échec de phase 1 et un échec de phase 2

---

**🧠 Ce que tu viens d'apprendre**

1. **Deux phases, deux familles de pannes.** Savoir laquelle échoue divise le problème en deux.
2. **Les sélecteurs de phase 2 doivent être le miroir exact.**
3. **`selectors(total,up): x/0` est le symptôme du tunnel qui a l'air up et ne transporte rien.**
4. **Un VPN site-à-site demande une politique par sens d'ouverture** — ce n'est pas une contradiction avec le §1.6.
5. **Jamais de NAT sur une politique VPN.**
6. **On vérifie la joignabilité avant de soupçonner IPsec.**

---

## 19. Accès distant : IPsec dial-up

Connecter un télétravailleur au réseau de l'entreprise. C'est le besoin le plus demandé, et c'est **le sujet où la documentation d'Internet est la plus périmée** — pour la raison expliquée au §2.6.

### 19.1 Rappel : pourquoi pas le SSL VPN ?

| Version de FortiOS | État du SSL VPN tunnel |
|---|---|
| ≤ 7.4 | Fonctionne, c'était la méthode standard |
| 7.6.0 | **Retiré** des modèles à 2 Go de RAM et des G d'entrée de gamme |
| **7.6.3 et au-delà** | **Retiré de TOUS les modèles**, remplacé par IPsec |

La solution officielle est le **VPN IPsec en mode dial-up**, configurable pour écouter sur **TCP 443** — précisément pour traverser les réseaux d'hôtel et de café qui ne laissent sortir que le web, ce qui était l'argument principal du SSL VPN.

> 🚨 **Si tu administres un parc**
> La migration se fait **AVANT** la montée en 7.6.3. Mettre à jour un pare-feu dont les télétravailleurs dépendent du SSL VPN les met tous dehors — et toi avec, si c'était ton accès distant.

### 19.2 Ce que « dial-up » veut dire

Dans un VPN site-à-site (§18), les deux extrémités ont une adresse **connue et fixe**. Chacune sait où joindre l'autre.

Pour un télétravailleur, c'est impossible : il est chez lui, dans un train, à l'hôtel — son adresse change constamment. On configure donc un tunnel **dial-up** :

- le pare-feu **écoute** et n'initie jamais ;
- il accepte les connexions venant de **n'importe quelle adresse** (`set remote-gw 0.0.0.0`) ;
- il **attribue** une adresse au client depuis une réserve, exactement comme un DHCP.

### 19.3 La configuration

**Phase 1 en mode dial-up :**

```
config vpn ipsec phase1-interface
    edit "VPN-Teletravail"
        set type dynamic                       ← ⭐ dial-up
        set interface "port1"
        set ike-version 2
        set peertype dialup
        set net-device disable
        set mode-cfg enable                    ← ⭐ attribue une adresse au client
        set proposal aes256-sha256
        set dhgrp 14
        set authusrgrp "GRP-Teletravailleurs"  ← ⭐ authentification par utilisateur
        set psksecret "CleDuGroupeTeletravail2026!"
        set ipv4-start-ip 192.168.200.10
        set ipv4-end-ip 192.168.200.50
        set ipv4-netmask 255.255.255.0
        set ipv4-split-include "GRP-Reseaux-Internes"
        set ipv4-dns-server1 192.168.10.1
        set dpd on-idle
    next
end
```

Les paramètres décisifs :

| Paramètre | Rôle |
|---|---|
| `type dynamic` | Le pare-feu accepte des pairs à adresse inconnue |
| `mode-cfg enable` | Attribue adresse, masque et DNS au client |
| `ipv4-start-ip` / `end-ip` | La réserve d'adresses des clients VPN |
| `authusrgrp` | ⭐ Le groupe autorisé — **chaque utilisateur s'authentifie** |
| `ipv4-split-include` | ⭐ Le *split tunneling* — voir §19.5 |

**Phase 2 :**

```
config vpn ipsec phase2-interface
    edit "VPN-Teletravail-P2"
        set phase1name "VPN-Teletravail"
        set proposal aes256-sha256
        set pfs enable
        set dhgrp 14
    next
end
```

**La politique :**

```
config firewall policy
    edit 30
        set name "Teletravail-vers-LAN"
        set srcintf "VPN-Teletravail"
        set dstintf "port2"
        set srcaddr "NET-VPN-Clients"
        set dstaddr "NET-LAN"
        set groups "GRP-Teletravailleurs"
        set action accept
        set schedule "always"
        set service "ALL"
        set logtraffic all
    next
end
```

> 🧠 **Comprendre** : ici, **une seule** politique suffit — parce que c'est toujours le télétravailleur qui **ouvre** la connexion. Personne au bureau n'initie une session vers son poste. C'est la différence avec le site-à-site du §18.4.

### 19.4 Faire écouter le VPN sur le port 443

C'est ce qui remplace l'avantage du SSL VPN :

```
config system settings
    set ike-tcp-port 443
end
```

Puis, côté phase 1 :

```
config vpn ipsec phase1-interface
    edit "VPN-Teletravail"
        set transport tcp
    next
end
```

> ⚠️ **Attention** : si tu publies déjà un serveur web en 443 sur la même adresse (§10.4), il y a **conflit**. Utilise une adresse publique distincte, ou un port différent. C'est une contrainte à anticiper dans le plan d'adressage, pas au moment du déploiement.

### 19.5 🧠 Le split tunneling : la décision qui compte

C'est le choix le plus structurant du VPN distant, et il n'a pas de bonne réponse universelle.

**Sans split tunneling** (`ipv4-split-include` absent) — **tout** le trafic du client passe par le tunnel, y compris sa navigation personnelle sur Internet.

| ✅ Avantages | ❌ Inconvénients |
|---|---|
| Tout le trafic est **inspecté** par le pare-feu | Consomme la bande passante de l'entreprise |
| La politique de sécurité s'applique partout | Ajoute de la latence sur tout |
| Aucun contournement possible | La visioconférence en souffre beaucoup |

**Avec split tunneling** — seuls les réseaux de l'entreprise passent par le tunnel, le reste sort directement chez le client.

| ✅ Avantages | ❌ Inconvénients |
|---|---|
| Performance nettement meilleure | Le trafic Internet **n'est pas inspecté** |
| Économise la bande passante du site | Le poste est exposé, et il est **connecté au LAN** |
| Visio fluide | Un poste compromis devient un pont vers l'entreprise |

> 🧠 **Comment trancher, en pratique**
> La question n'est pas « lequel est le mieux » mais « **que protège le poste quand il n'est pas dans le tunnel ?** »
>
> - Si les postes ont un **EDR** ou un client de sécurité géré (FortiClient, ou équivalent) et sont maintenus à jour : **split tunneling**, la performance vaut le compromis.
> - Si les postes sont peu maîtrisés, ou s'il s'agit de matériel personnel : **tunnel complet**, parce que le pare-feu est alors la seule protection.
>
> Et la solution mixte, qui est celle des organisations matures : split tunneling **plus** une exigence de conformité du poste avant l'accès. Ce n'est plus un choix binaire.

### 19.6 Renforcer l'authentification

Une clé partagée de groupe plus un mot de passe utilisateur, c'est le minimum. En 2026, ce n'est plus suffisant pour un accès depuis Internet.

**Les certificats plutôt que la clé partagée :**

```
config vpn ipsec phase1-interface
    edit "VPN-Teletravail"
        set authmethod signature
        set certificate "Certificat-VPN"
        set peer "Groupe-PKI-Utilisateurs"
    next
end
```

**Le second facteur (MFA)** via FortiToken ou un serveur RADIUS :

```
config user local
    edit "marie.durand"
        set two-factor fortitoken
        set fortitoken "FTKMOB0000000000"
    next
end
```

> 🚨 **Danger — les VPN sont une cible de premier plan**
> Les accès VPN sans second facteur sont **systématiquement** attaqués par pulvérisation de mots de passe (*password spraying*) et exploitation d'identifiants volés. Plusieurs compromissions majeures de ces dernières années sont entrées exactement par là.
>
> **Un accès VPN sans MFA en 2026 est une porte d'entrée, pas une protection.** Si tu ne dois retenir qu'une recommandation de sécurité de tout ce tutoriel, c'est celle-là.

---

### 🧪 TP 18 — Un accès télétravailleur

**🎯 Objectif**
Monter un VPN dial-up, connecter un client, vérifier l'adresse attribuée, tester l'accès au LAN, puis observer la différence entre split tunneling et tunnel complet.

**⏱️ Durée** : 45 minutes

**📋 Prérequis** : TP 16 (utilisateurs) terminé, une machine « externe » pour jouer le télétravailleur

---

**🔧 Manipulation**

**Étape 1 — Le groupe et l'objet d'adresses**

```
FGT-01 # config user group
FGT-01 (group) # edit "GRP-Teletravailleurs"
FGT-01 (GRP-Teletravailleurs) # set member "marie.durand"
FGT-01 (GRP-Teletravailleurs) # next
FGT-01 (group) # end

FGT-01 # config firewall address
FGT-01 (address) # edit "NET-VPN-Clients"
FGT-01 (NET-VPN-Clients) # set subnet 192.168.200.0 255.255.255.0
FGT-01 (NET-VPN-Clients) # next
FGT-01 (address) # end
```

**Étape 2 — Phase 1 dial-up**

```
FGT-01 # config vpn ipsec phase1-interface
FGT-01 (phase1-interface) # edit "VPN-Teletravail"
FGT-01 (VPN-Teletravail) # set type dynamic
FGT-01 (VPN-Teletravail) # set interface "port1"
FGT-01 (VPN-Teletravail) # set ike-version 2
FGT-01 (VPN-Teletravail) # set peertype dialup
FGT-01 (VPN-Teletravail) # set net-device disable
FGT-01 (VPN-Teletravail) # set mode-cfg enable
FGT-01 (VPN-Teletravail) # set proposal aes256-sha256
FGT-01 (VPN-Teletravail) # set dhgrp 14
FGT-01 (VPN-Teletravail) # set authusrgrp "GRP-Teletravailleurs"
FGT-01 (VPN-Teletravail) # set psksecret "CleLabTeletravail2026!"
FGT-01 (VPN-Teletravail) # set ipv4-start-ip 192.168.200.10
FGT-01 (VPN-Teletravail) # set ipv4-end-ip 192.168.200.50
FGT-01 (VPN-Teletravail) # set ipv4-netmask 255.255.255.0
FGT-01 (VPN-Teletravail) # set ipv4-split-include "NET-LAN"
FGT-01 (VPN-Teletravail) # set ipv4-dns-server1 192.168.10.1
FGT-01 (VPN-Teletravail) # set dpd on-idle
FGT-01 (VPN-Teletravail) # next
FGT-01 (phase1-interface) # end
```

**Étape 3 — Phase 2**

```
FGT-01 # config vpn ipsec phase2-interface
FGT-01 (phase2-interface) # edit "VPN-Teletravail-P2"
FGT-01 (VPN-Teletravail-P2) # set phase1name "VPN-Teletravail"
FGT-01 (VPN-Teletravail-P2) # set proposal aes256-sha256
FGT-01 (VPN-Teletravail-P2) # set pfs enable
FGT-01 (VPN-Teletravail-P2) # set dhgrp 14
FGT-01 (VPN-Teletravail-P2) # next
FGT-01 (phase2-interface) # end
```

**Étape 4 — La politique**

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 30
FGT-01 (30) # set name "Teletravail-vers-LAN"
FGT-01 (30) # set srcintf "VPN-Teletravail"
FGT-01 (30) # set dstintf "port2"
FGT-01 (30) # set srcaddr "NET-VPN-Clients"
FGT-01 (30) # set dstaddr "NET-LAN"
FGT-01 (30) # set groups "GRP-Teletravailleurs"
FGT-01 (30) # set action accept
FGT-01 (30) # set schedule "always"
FGT-01 (30) # set service "ALL"
FGT-01 (30) # set logtraffic all
FGT-01 (30) # next
FGT-01 (policy) # end
```

**Étape 5 — Connecter un client**

Avec **FortiClient** (Windows, macOS, Linux) : créer une connexion IPsec, saisir l'adresse du pare-feu, la clé partagée et les identifiants de `marie.durand`.

Avec **strongSwan** sous Linux, dans `/etc/ipsec.conf` :

```
conn teletravail
    keyexchange=ikev2
    right=<adresse-publique-du-FortiGate>
    rightid=%any
    rightsubnet=192.168.10.0/24
    leftsourceip=%config
    leftauth=psk
    rightauth=psk
    leftauth2=eap
    auto=start
```

**Étape 6 — Vérifier côté pare-feu**

```
FGT-01 # diagnose vpn ike gateway list name VPN-Teletravail
FGT-01 # get vpn ipsec tunnel summary
FGT-01 # diagnose vpn tunnel list
```

Et la liste des utilisateurs connectés :

```
FGT-01 # diagnose vpn ike gateway list | grep -e "name" -e "assigned"
FGT-01 # execute vpn sslvpn list
```

**Étape 7 — Vérifier l'adresse attribuée**

Sur le client :

```bash
teletravailleur@portable:~$ ip addr show
```

Une nouvelle interface porte une adresse de la réserve `192.168.200.x`. **Le pare-feu vient de faire du DHCP à travers Internet.**

**Étape 8 — Tester l'accès**

```bash
teletravailleur@portable:~$ ping -c 3 192.168.10.10
teletravailleur@portable:~$ ping -c 3 192.168.10.1
```

**Étape 9 — Observer le split tunneling**

C'est l'observation la plus parlante du TP :

```bash
teletravailleur@portable:~$ ip route show
```

Tu vois une route vers `192.168.10.0/24` par l'interface du tunnel, et **la route par défaut inchangée**. Autrement dit : le trafic de l'entreprise passe par le tunnel, le reste sort directement.

```bash
teletravailleur@portable:~$ traceroute 192.168.10.10     ← par le tunnel
teletravailleur@portable:~$ traceroute 8.8.8.8           ← direct, hors tunnel
```

**Deux chemins différents, sur la même machine, au même instant.** C'est exactement le §19.5.

**Étape 10 — Passer en tunnel complet**

```
FGT-01 # config vpn ipsec phase1-interface
FGT-01 (phase1-interface) # edit "VPN-Teletravail"
FGT-01 (VPN-Teletravail) # unset ipv4-split-include
FGT-01 (VPN-Teletravail) # next
FGT-01 (phase1-interface) # end
```

Reconnecte le client, puis :

```bash
teletravailleur@portable:~$ ip route show
teletravailleur@portable:~$ traceroute 8.8.8.8
```

**La route par défaut passe maintenant par le tunnel.** Tout le trafic remonte à l'entreprise.

> ⚠️ **Attention** : en tunnel complet, il faut une politique **VPN → Internet** avec NAT pour que le client puisse encore naviguer. Sinon tu viens de couper Internet à ton télétravailleur — panne classique et très mal vécue.
> ```
> config firewall policy
>     edit 31
>         set name "Teletravail-vers-Internet"
>         set srcintf "VPN-Teletravail"
>         set dstintf "port1"
>         set srcaddr "NET-VPN-Clients"
>         set dstaddr "all"
>         set action accept
>         set schedule "always"
>         set service "ALL"
>         set nat enable
>     next
> end
> ```

---

**✅ Résultat attendu**

- Le client obtient une adresse de la réserve VPN
- Il joint le LAN de l'entreprise
- En split tunneling, deux chemins coexistent — tu l'as vu au `traceroute`
- En tunnel complet, tout remonte à l'entreprise

---

**🧠 Ce que tu viens d'apprendre**

1. **Dial-up = le pare-feu écoute et attribue**, parce que le client n'a pas d'adresse fixe.
2. **`mode-cfg` fait du DHCP à travers Internet.**
3. **Une seule politique suffit**, contrairement au site-à-site : un seul côté ouvre.
4. **Le split tunneling est un arbitrage entre performance et visibilité**, et il dépend de la protection du poste.
5. **En tunnel complet, il faut une politique vers Internet** — sinon on coupe Internet au télétravailleur.
6. **Un VPN sans second facteur est une porte d'entrée.**

---

# Partie VIII — Aller plus loin

---

## 20. Le routage dynamique

Au TP 5, tu as écrit des routes statiques à la main. Ça marche jusqu'à ce que le réseau grandisse — et là, comme l'explique le tutoriel OSPF de ce dépôt, ça devient ingérable.

Un FortiGate parle **OSPF**, **BGP**, **RIP** et **IS-IS**. Voyons les deux qui comptent.

### 20.1 Quand passer au dynamique

| Situation | Statique | Dynamique |
|---|---|---|
| 2 ou 3 réseaux, une seule sortie | ✅ Suffit | Inutile |
| 10 sites reliés en VPN | ❌ Cauchemar | ✅ OSPF |
| Plusieurs opérateurs, adresses publiques | ❌ Impossible | ✅ BGP |
| Un lien peut tomber, il faut basculer | ⚠️ Route flottante | ✅ Convergence automatique |

### 20.2 OSPF sur FortiGate

```
config router ospf
    set router-id 10.255.255.1
    config area
        edit 0.0.0.0
        next
    end
    config ospf-interface
        edit "vers-LAN"
            set interface "port2"
            set network-type point-to-point
            set authentication md5
            config md5-keys
                edit 1
                    set key "CleOspf2026"
                next
            end
        next
    end
    config network
        edit 1
            set prefix 192.168.10.0 255.255.255.0
            set area 0.0.0.0
        next
        edit 2
            set prefix 192.168.100.0 255.255.255.0
            set area 0.0.0.0
        next
    end
    set passive-interface "port3"
end
```

Les points qui comptent :

**`router-id`** — l'identité du routeur dans OSPF. **Fixe-le explicitement**, avec une adresse de boucle locale (§6.1). Si tu le laisses se choisir tout seul, il prendra l'adresse la plus haute d'une interface — et changera si cette interface tombe, ce qui fait s'effondrer toutes les adjacences au pire moment.

**`passive-interface`** — l'interface participe au routage (son réseau est annoncé) mais **n'envoie aucun message Hello**. C'est ce qu'on met sur toutes les interfaces où il n'y a pas d'autre routeur.

> 🚨 **Danger** : une interface OSPF non passive côté LAN **annonce l'existence de ton routeur** à quiconque est branché dessus. N'importe qui peut alors tenter de former une adjacence et injecter des routes. Rends passive **toute** interface sans voisin légitime, et **authentifie** les adjacences. Ce sont deux lignes, et elles ferment une attaque réelle.

**Vérification :**

```
FGT-01 # get router info ospf neighbor
FGT-01 # get router info ospf interface
FGT-01 # get router info ospf database brief
FGT-01 # get router info routing-table ospf
```

> 💡 **Astuce** : `get router info ospf neighbor` doit montrer l'état **FULL**. Tout autre état durable (`INIT`, `EXSTART`, `2-WAY` sur un lien point-à-point) signale un problème : incompatibilité de MTU, de temporisateurs, d'aire, ou d'authentification. C'est le même diagnostic que sur un routeur Cisco — OSPF est un standard, et c'est tout son intérêt.

### 20.3 BGP sur FortiGate

BGP sert à dialoguer avec les opérateurs, et à porter des routes entre sites en grand nombre.

```
config router bgp
    set as 65001
    set router-id 10.255.255.1
    set ebgp-multipath enable
    config neighbor
        edit "203.0.113.1"
            set remote-as 65100
            set description "Operateur principal"
            set soft-reconfiguration enable
            set connect-timer 10
        next
    end
    config network
        edit 1
            set prefix 192.0.2.0 255.255.255.0
        next
    end
end
```

**Vérification :**

```
FGT-01 # get router info bgp summary
FGT-01 # get router info bgp neighbors 203.0.113.1
FGT-01 # get router info bgp network
```

> ⚠️ **Attention — filtre TOUJOURS ce que tu annonces**
> Un BGP mal filtré peut **réannoncer** vers un opérateur les routes reçues d'un autre. Ton entreprise devient alors, sans le vouloir, un opérateur de transit — et se retrouve à absorber du trafic qui n'a rien à y faire, jusqu'à saturation.
>
> Ce n'est pas théorique : c'est ce qu'on appelle une fuite de routes (*route leak*), et il s'en produit régulièrement, y compris chez de gros acteurs.
>
> ```
> config router route-map
>     edit "SORTANT-STRICT"
>         config rule
>             edit 1
>                 set match-ip-address "NOS-PREFIXES-A-NOUS"
>                 set action permit
>             next
>             edit 2
>                 set action deny
>             next
>         end
>     next
> end
> ```

### 20.4 Le routage dynamique dans un VPN

C'est le vrai cas d'usage d'OSPF sur un pare-feu : au lieu d'écrire une route statique par site distant (§18.4), on laisse OSPF découvrir.

```
config vpn ipsec phase1-interface
    edit "VPN-Lyon"
        set net-device disable
        set add-route disable          ← on laisse OSPF gérer les routes
    next
end

config router ospf
    config ospf-interface
        edit "vers-Lyon"
            set interface "VPN-Lyon"
            set network-type point-to-point
            set cost 100
        next
    end
end
```

> 💡 **Astuce** : `set network-type point-to-point` sur une interface de tunnel. Un tunnel n'est pas un réseau à diffusion : il n'y a pas d'élection de routeur désigné à faire, et forcer ce type évite une attente inutile à chaque montée de tunnel.

---

### 🧪 TP 19 — OSPF entre le pare-feu et R1

**🎯 Objectif**
Faire dialoguer FGT-01 et R1 en OSPF, remplacer les routes statiques, puis provoquer une panne et observer la convergence.

**⏱️ Durée** : 35 minutes

**📋 Prérequis** : TP 5 terminé, R1 opérationnel

---

**🔧 Manipulation**

**Étape 1 — OSPF sur R1**

```cisco
R1-EDGE# configure terminal
R1-EDGE(config)# interface Loopback0
R1-EDGE(config-if)# ip address 10.255.255.254 255.255.255.255
R1-EDGE(config-if)# exit
R1-EDGE(config)# router ospf 1
R1-EDGE(config-router)# router-id 10.255.255.254
R1-EDGE(config-router)# network 192.168.100.0 0.0.0.255 area 0
R1-EDGE(config-router)# passive-interface GigabitEthernet0/0
R1-EDGE(config-router)# default-information originate always
R1-EDGE(config-router)# end
```

> 🧠 `default-information originate always` fait annoncer par R1 **la route par défaut** en OSPF. Le pare-feu n'aura donc plus besoin de sa route statique vers R1 : il l'apprendra.

**Étape 2 — OSPF sur le FortiGate**

```
FGT-01 # config system interface
FGT-01 (interface) # edit "lo-ospf"
FGT-01 (lo-ospf) # set vdom "root"
FGT-01 (lo-ospf) # set type loopback
FGT-01 (lo-ospf) # set ip 10.255.255.1 255.255.255.255
FGT-01 (lo-ospf) # next
FGT-01 (interface) # end

FGT-01 # config router ospf
FGT-01 (ospf) # set router-id 10.255.255.1
FGT-01 (ospf) # config area
FGT-01 (area) # edit 0.0.0.0
FGT-01 (0.0.0.0) # next
FGT-01 (area) # end
FGT-01 (ospf) # config network
FGT-01 (network) # edit 1
FGT-01 (1) # set prefix 192.168.100.0 255.255.255.0
FGT-01 (1) # set area 0.0.0.0
FGT-01 (1) # next
FGT-01 (network) # edit 2
FGT-01 (2) # set prefix 192.168.10.0 255.255.255.0
FGT-01 (2) # set area 0.0.0.0
FGT-01 (2) # next
FGT-01 (network) # edit 3
FGT-01 (3) # set prefix 192.168.20.0 255.255.255.0
FGT-01 (3) # set area 0.0.0.0
FGT-01 (3) # next
FGT-01 (network) # end
FGT-01 (ospf) # set passive-interface "port2" "port3"
FGT-01 (ospf) # end
```

**Étape 3 — Vérifier l'adjacence**

```
FGT-01 # get router info ospf neighbor
```
```
OSPF process 0, VRF 0:
Neighbor ID     Pri   State           Dead Time   Address         Interface
10.255.255.254    1   Full/DR          00:00:35   192.168.100.1   port1
```

**`Full`** : l'adjacence est complète. 🎉

Côté R1 :

```cisco
R1-EDGE# show ip ospf neighbor
R1-EDGE# show ip route ospf
```

R1 apprend `192.168.10.0/24` et `192.168.20.0/24` **sans qu'on lui ait écrit de route statique**. Tu peux d'ailleurs supprimer celles du §3.8 :

```cisco
R1-EDGE(config)# no ip route 192.168.10.0 255.255.255.0 192.168.100.99
R1-EDGE(config)# no ip route 192.168.20.0 255.255.255.0 192.168.100.99
```

**Étape 4 — Vérifier côté pare-feu**

```
FGT-01 # get router info routing-table ospf
```
```
O*E2  0.0.0.0/0 [110/10] via 192.168.100.1, port1, 00:02:14
```

La route par défaut est apprise **dynamiquement**. Tu peux retirer la statique du TP 5 :

```
FGT-01 # config router static
FGT-01 (static) # delete 1
FGT-01 (static) # end

FGT-01 # execute ping 8.8.8.8
```

Ça marche toujours — mais plus aucune route n'a été écrite à la main.

**Étape 5 — Observer une convergence**

```cisco
R1-EDGE(config)# interface GigabitEthernet0/1
R1-EDGE(config-if)# shutdown
```

Sur le pare-feu :

```
FGT-01 # get router info ospf neighbor
FGT-01 # get router info routing-table all
```

L'adjacence tombe, la route par défaut disparaît. Remets en service :

```cisco
R1-EDGE(config-if)# no shutdown
```

Et regarde l'adjacence se reformer, puis la route revenir. **Sans intervention humaine.** C'est tout l'intérêt du dynamique.

**Étape 6 — Authentifier (bonne pratique)**

```
FGT-01 # config router ospf
FGT-01 (ospf) # config ospf-interface
FGT-01 (ospf-interface) # edit "vers-R1"
FGT-01 (vers-R1) # set interface "port1"
FGT-01 (vers-R1) # set authentication md5
FGT-01 (vers-R1) # config md5-keys
FGT-01 (md5-keys) # edit 1
FGT-01 (1) # set key "CleOspfLab2026"
FGT-01 (1) # next
FGT-01 (md5-keys) # end
FGT-01 (vers-R1) # next
FGT-01 (ospf-interface) # end
FGT-01 (ospf) # end
```

```cisco
R1-EDGE(config)# interface GigabitEthernet0/1
R1-EDGE(config-if)# ip ospf authentication message-digest
R1-EDGE(config-if)# ip ospf message-digest-key 1 md5 CleOspfLab2026
```

> 🧠 **Observe l'ordre** : tant que **les deux** côtés ne sont pas configurés, l'adjacence **tombe**. C'est normal et c'est voulu. En production, ça implique de prévoir une courte coupure, ou d'utiliser une fenêtre de maintenance. Un administrateur qui active l'authentification d'un seul côté en pleine journée coupe le site.

---

**✅ Résultat attendu**

- `get router info ospf neighbor` affiche `Full`
- R1 apprend les réseaux internes sans route statique
- Le pare-feu apprend la route par défaut en `O*E2`
- Une coupure fait converger automatiquement

---

**🧠 Ce que tu viens d'apprendre**

1. **OSPF supprime les routes écrites à la main**, et se reconfigure tout seul.
2. **`router-id` doit être fixé explicitement**, sur une boucle locale.
3. **`passive-interface` sur toute interface sans voisin légitime** — sinon on annonce son routeur à qui veut l'entendre.
4. **L'authentification est indispensable**, et elle coupe l'adjacence tant que les deux côtés ne l'ont pas.
5. **`Full` est le seul état acceptable durablement.**

---

## 21. SD-WAN

Le SD-WAN est la réponse propre au problème qu'on a effleuré au §7.4 : **utiliser intelligemment plusieurs liens Internet**.

### 21.1 Le problème qu'il résout

Tu as deux opérateurs. Avec du routage classique, tu as le choix entre deux mauvaises options :

| Approche | Problème |
|---|---|
| Route flottante (distances différentes) | Le second lien ne sert **jamais**. Tu payes un abonnement pour rien |
| ECMP (distances égales) | Les sessions d'un même utilisateur partent alternativement par deux adresses publiques, et **les sites qui vérifient l'adresse te déconnectent** |

**Le SD-WAN résout les deux** : il utilise les deux liens, en gardant chaque session sur un seul, et il choisit le lien selon la **qualité mesurée** plutôt que selon une métrique statique.

### 21.2 Les trois briques

**① Les membres** — les interfaces qui participent :

```
config system sdwan
    set status enable
    config zone
        edit "SDWAN-INTERNET"
        next
    end
    config members
        edit 1
            set interface "port1"
            set zone "SDWAN-INTERNET"
            set gateway 192.168.100.1
            set priority 1
        next
        edit 2
            set interface "port4"
            set zone "SDWAN-INTERNET"
            set gateway 192.168.101.1
            set priority 2
        next
    end
end
```

**② Les moniteurs de performance** — ce qui **mesure** la qualité de chaque lien :

```
config system sdwan
    config health-check
        edit "Qualite-Internet"
            set server "8.8.8.8" "1.1.1.1"
            set protocol ping
            set interval 500
            set failtime 5
            set recoverytime 5
            set members 1 2
            config sla
                edit 1
                    set latency-threshold 150
                    set jitter-threshold 30
                    set packetloss-threshold 2
                next
            end
        next
    end
end
```

> 🧠 **C'est ici que le SD-WAN devient intéressant.** Il ne se contente pas de savoir si le lien est *up* : il mesure la **latence**, la **gigue** et la **perte de paquets**, en continu. Un lien peut être parfaitement actif et néanmoins inutilisable pour de la voix sur IP — 300 ms de latence, 5 % de perte. Le routage classique n'a aucun moyen de le voir.

**③ Les règles** — quel trafic emprunte quel lien :

```
config system sdwan
    config service
        edit 1
            set name "Voix-vers-lien-de-qualite"
            set mode sla
            set dst "all"
            set src "NET-LAN"
            set protocol 17
            set start-port 5060
            set end-port 5061
            config sla
                edit "Qualite-Internet"
                    set id 1
                next
            end
            set priority-members 1 2
        next
        edit 2
            set name "Web-en-repartition"
            set mode load-balance
            set dst "all"
            set src "NET-LAN"
            set load-balance-mode source-ip-based
        next
    end
end
```

### 21.3 Les modes de sélection

| Mode | Comportement |
|---|---|
| `auto` | Suit la priorité des membres |
| `manual` | Toujours le même membre |
| `priority` | Le membre le mieux classé selon un critère mesuré |
| **`sla`** | ⭐ Le premier membre qui **respecte le contrat de qualité** |
| `load-balance` | Répartit selon un algorithme |

Et les algorithmes de répartition :

| Algorithme | Effet |
|---|---|
| `source-ip-based` | ⭐ Une même source garde le même lien — **évite le problème du §7.4** |
| `weight-based` | Répartition proportionnelle |
| `usage-based` | Selon la bande passante consommée |
| `session` | Par session, en tourniquet |

> 💡 **Astuce** : `source-ip-based` est le choix par défaut raisonnable. Un utilisateur donné sort toujours par le même lien, donc toujours par la même adresse publique — et les sites qui lient une session à une adresse cessent de le déconnecter.

### 21.4 Vérifier

```
FGT-01 # diagnose sys sdwan member
FGT-01 # diagnose sys sdwan health-check
FGT-01 # diagnose sys sdwan service
FGT-01 # get router info routing-table all
```

`diagnose sys sdwan health-check` est **la** commande à connaître :

```
Health Check(Qualite-Internet):
Seq(1 port1): state(alive), packet-loss(0.000%) latency(12.456), jitter(1.234) sla_map=0x1
Seq(2 port4): state(alive), packet-loss(3.500%) latency(180.221), jitter(45.100) sla_map=0x0
```

**Lis `sla_map`** : `0x1` signifie que le contrat n°1 est respecté, `0x0` qu'il ne l'est pas. Ici, `port4` a 3,5 % de perte et 180 ms de latence — il est vivant mais il **ne respecte pas le contrat**, donc le trafic sensible ne l'empruntera pas.

> 🚨 **Danger — l'erreur qui casse tout un déploiement SD-WAN**
> Quand une interface devient membre du SD-WAN, elle **ne peut plus être utilisée directement** dans les politiques et les routes statiques. Il faut référencer la **zone SD-WAN**.
>
> Toutes tes politiques existantes qui citent `port1` doivent être modifiées **avant** d'activer le SD-WAN. FortiOS refusera l'ajout du membre tant que des références subsistent — même protection qu'au §5, TP 3 étape 7, et c'est heureux.
>
> **La bonne méthode** : créer la zone, modifier les politiques pour qu'elles citent la zone, **puis** ajouter les membres.

---

### 🧪 TP 20 — Un SD-WAN à deux liens

**🎯 Objectif**
Créer une zone SD-WAN, y placer deux liens, mesurer leur qualité, écrire une règle avec contrat de service, puis **dégrader volontairement un lien** et observer la bascule.

**⏱️ Durée** : 40 minutes

**📋 Prérequis** : TP 7 terminé, une seconde interface WAN (`port4`) — même sans vrai second opérateur

---

**🔧 Manipulation**

**Étape 1 — Libérer les politiques**

```
FGT-01 # show firewall policy | grep -B3 "port1"
```

Note les politiques qui citent `port1`. On va devoir les modifier.

**Étape 2 — Créer la zone et le premier membre**

```
FGT-01 # config system sdwan
FGT-01 (sdwan) # set status enable
FGT-01 (sdwan) # config zone
FGT-01 (zone) # edit "SDWAN-INTERNET"
FGT-01 (SDWAN-INTERNET) # next
FGT-01 (zone) # end
FGT-01 (sdwan) # end
```

Si FortiOS refuse à cause de références sur `port1`, modifie d'abord les politiques :

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # set dstintf "SDWAN-INTERNET"
FGT-01 (1) # next
FGT-01 (policy) # end
```

**Étape 3 — Ajouter les membres**

```
FGT-01 # config system sdwan
FGT-01 (sdwan) # config members
FGT-01 (members) # edit 1
FGT-01 (1) # set interface "port1"
FGT-01 (1) # set zone "SDWAN-INTERNET"
FGT-01 (1) # set gateway 192.168.100.1
FGT-01 (1) # set priority 1
FGT-01 (1) # next
FGT-01 (members) # edit 2
FGT-01 (2) # set interface "port4"
FGT-01 (2) # set zone "SDWAN-INTERNET"
FGT-01 (2) # set gateway 192.168.101.1
FGT-01 (2) # set priority 2
FGT-01 (2) # next
FGT-01 (members) # end
FGT-01 (sdwan) # end
```

**Étape 4 — Le moniteur de qualité**

```
FGT-01 # config system sdwan
FGT-01 (sdwan) # config health-check
FGT-01 (health-check) # edit "Qualite"
FGT-01 (Qualite) # set server "8.8.8.8" "1.1.1.1"
FGT-01 (Qualite) # set protocol ping
FGT-01 (Qualite) # set interval 500
FGT-01 (Qualite) # set failtime 5
FGT-01 (Qualite) # set recoverytime 5
FGT-01 (Qualite) # set members 1 2
FGT-01 (Qualite) # config sla
FGT-01 (sla) # edit 1
FGT-01 (1) # set latency-threshold 150
FGT-01 (1) # set jitter-threshold 30
FGT-01 (1) # set packetloss-threshold 2
FGT-01 (1) # next
FGT-01 (sla) # end
FGT-01 (Qualite) # next
FGT-01 (health-check) # end
FGT-01 (sdwan) # end
```

**Étape 5 — Observer les mesures**

```
FGT-01 # diagnose sys sdwan health-check
```

Tu vois la latence, la gigue et la perte **mesurées en temps réel** sur chaque lien. C'est ce qu'aucune route statique ne peut savoir.

**Étape 6 — La route par défaut du SD-WAN**

```
FGT-01 # config router static
FGT-01 (static) # edit 1
FGT-01 (1) # set dst 0.0.0.0 0.0.0.0
FGT-01 (1) # set device "SDWAN-INTERNET"
FGT-01 (1) # next
FGT-01 (static) # end

FGT-01 # get router info routing-table all
```

**Étape 7 — Une règle avec contrat de service**

```
FGT-01 # config system sdwan
FGT-01 (sdwan) # config service
FGT-01 (service) # edit 1
FGT-01 (1) # set name "Trafic-critique"
FGT-01 (1) # set mode sla
FGT-01 (1) # set dst "all"
FGT-01 (1) # set src "NET-LAN"
FGT-01 (1) # config sla
FGT-01 (sla) # edit "Qualite"
FGT-01 (Qualite) # set id 1
FGT-01 (Qualite) # next
FGT-01 (sla) # end
FGT-01 (1) # set priority-members 1 2
FGT-01 (1) # next
FGT-01 (service) # end
FGT-01 (sdwan) # end
```

**Étape 8 — Dégrader un lien volontairement**

C'est l'étape qui apprend le plus. Sur R1, dégrade artificiellement le lien vers `port1` :

```cisco
R1-EDGE(config)# interface GigabitEthernet0/1
R1-EDGE(config-if)# shutdown
```

Ou, sous Linux, ajoute de la latence et de la perte :

```bash
root@r1-edge:~# tc qdisc add dev eth1 root netem delay 300ms loss 10%
```

Puis observe :

```
FGT-01 # diagnose sys sdwan health-check
```

`sla_map` passe à `0x0` pour ce membre : il **ne respecte plus le contrat**.

```
FGT-01 # diagnose sys sdwan service
```

Le service bascule sur le membre 2.

**Le trafic vient de changer de chemin non pas parce qu'un lien est tombé, mais parce qu'il est devenu MAUVAIS.** C'est toute la différence avec le routage classique.

Rétablis :

```bash
root@r1-edge:~# tc qdisc del dev eth1 root netem
```

---

**✅ Résultat attendu**

- `diagnose sys sdwan health-check` affiche latence, gigue et perte par lien
- `sla_map` reflète le respect du contrat
- Une dégradation fait basculer le trafic **sans coupure de lien**

---

**🧠 Ce que tu viens d'apprendre**

1. **Le SD-WAN mesure la qualité**, là où le routage ne connaît que « up » ou « down ».
2. **`sla_map` est la ligne à lire** pour savoir si un lien respecte son contrat.
3. **`source-ip-based` évite le problème des sessions qui changent d'adresse publique.**
4. **Un membre du SD-WAN ne peut plus être cité directement** dans les politiques — modifie-les avant.
5. **Un lien peut être vivant et inutilisable.** C'est le cas que le SD-WAN existe pour traiter.

---

## 22. La haute disponibilité

Ton pare-feu est le point de passage obligé de tout le trafic. S'il tombe, **l'entreprise s'arrête**. La haute disponibilité (HA) consiste à en mettre deux, pour qu'une panne ne se voie pas.

### 22.1 Les deux modes

**Actif-passif (A-P)** — un pare-feu travaille, l'autre attend en miroir. Si le premier tombe, le second prend la main en quelques secondes.

- ✅ Simple, prévisible, facile à diagnostiquer
- ✅ **C'est ce qu'on déploie dans 90 % des cas**
- ❌ Le second équipement ne sert à rien tant que tout va bien

**Actif-actif (A-A)** — les deux traitent du trafic, la charge est répartie.

- ✅ Utilise les deux machines
- ❌ Plus complexe, la répartition ne concerne en pratique que le trafic inspecté
- ❌ Diagnostic plus difficile

> 💡 **Astuce** : si tu hésites, prends **actif-passif**. Le gain de performance de l'actif-actif est plus limité qu'on ne le croit — le trafic à état reste traité par le maître — et la complexité supplémentaire coûte cher le jour où quelque chose ne va pas.

### 22.2 Le protocole FGCP

Fortinet utilise son propre protocole, **FGCP** (*FortiGate Clustering Protocol*), qui gère :

- l'**élection** du maître ;
- la **synchronisation** de la configuration ;
- la **synchronisation des sessions**, pour qu'une bascule ne coupe pas les connexions en cours ;
- la **surveillance** des liens et des équipements.

### 22.3 La configuration

```
config system ha
    set group-name "CLUSTER-PARIS"
    set mode a-p
    set password "MotDePasseHA2026"
    set hbdev "port5" 50 "port6" 100
    set session-pickup enable
    set session-pickup-connectionless enable
    set ha-mgmt-status enable
    config ha-mgmt-interfaces
        edit 1
            set interface "port7"
            set gateway 192.168.99.254
        next
    end
    set override disable
    set priority 200
    set monitor "port1" "port2" "port3"
end
```

Les paramètres décisifs, un par un :

| Paramètre | Rôle |
|---|---|
| `group-name` | Doit être **identique** sur les deux |
| `password` | Idem — c'est ce qui authentifie le cluster |
| `hbdev` | ⭐ Les interfaces de **battement de cœur**, avec leur priorité |
| `session-pickup` | ⭐ Synchronise les sessions — sans lui, la bascule **coupe** toutes les connexions |
| `priority` | La plus **haute** devient maître |
| `override` | Voir l'avertissement ci-dessous |
| `monitor` | ⭐ Les interfaces surveillées : si l'une tombe, le cluster bascule |
| `ha-mgmt-interfaces` | Une interface d'administration **par équipement**, indépendante du cluster |

> 🚨 **Danger — `set override enable` est un piège**
> Avec `override disable` (le défaut), quand le maître tombé revient, **il reste esclave**. Le cluster ne bouge plus.
>
> Avec `override enable`, le maître d'origine **reprend la main** dès son retour — ce qui provoque une **seconde bascule**, donc une seconde micro-coupure, pour rien.
>
> **Laisse `override disable`.** Un équipement qui vient de redémarrer n'a aucune raison de reprendre la main immédiatement : s'il redémarre en boucle, `override enable` fait basculer le cluster à chaque cycle. On appelle ça un *flapping*, et c'est bien pire qu'une panne franche.

> ⚠️ **Attention — `monitor` est indispensable, et il est dangereux mal réglé**
> Sans lui, le pare-feu maître peut perdre son interface WAN et **rester maître** : le cluster est en parfaite santé, et plus personne n'a Internet.
>
> Mais ne surveille **que** les interfaces réellement critiques. Surveiller une interface de laboratoire débranchée fait basculer le cluster en permanence.

### 22.4 🧠 Comprendre : le split-brain

C'est le pire scénario d'un cluster, et il faut savoir ce que c'est.

Si **tous** les liens de battement de cœur tombent alors que les deux équipements fonctionnent, chacun croit que l'autre est mort. Chacun se déclare maître. **Deux équipements prennent la même adresse IP et la même adresse MAC virtuelle** sur le réseau.

Résultat : conflits d'adresses, table MAC du switch qui oscille, trafic erratique. **C'est pire qu'une panne**, parce que rien n'est franchement cassé et que le diagnostic est difficile.

**Comment l'éviter :**

- **Deux liens de battement de cœur minimum**, sur des interfaces physiques différentes (`set hbdev "port5" 50 "port6" 100`) ;
- Les relier en **direct**, sans passer par un switch, quand c'est possible ;
- Si un switch est nécessaire, éviter que les deux liens passent par le **même** switch.

> 💡 **Astuce** : c'est exactement la raison pour laquelle `hbdev` accepte plusieurs interfaces avec une priorité. Ce n'est pas une redondance décorative : c'est la protection contre le split-brain.

### 22.5 Vérifier et exploiter

```
FGT-01 # get system ha status
FGT-01 # diagnose sys ha status
FGT-01 # diagnose sys ha checksum cluster
FGT-01 # execute ha manage 1 admin
```

`diagnose sys ha checksum cluster` mérite une explication : il compare les **empreintes de configuration** des membres. Si elles diffèrent, la synchronisation a échoué — et un cluster désynchronisé bascule vers une configuration qui n'est pas celle que tu crois.

```
FGT-01 # diagnose sys ha checksum cluster
```
```
================== FGVMEV0000000001 ==================
is_manage_master()=1, is_root_master()=1
debugzone
global: a1b2c3d4 e5f6a7b8 ...
root: 1a2b3c4d 5e6f7a8b ...

================== FGVMEV0000000002 ==================
is_manage_master()=0, is_root_master()=0
debugzone
global: a1b2c3d4 e5f6a7b8 ...     ← doit être IDENTIQUE
root: 1a2b3c4d 5e6f7a8b ...       ← doit être IDENTIQUE
```

> 💡 **Astuce — `execute ha manage`** permet de se connecter au **membre esclave** depuis le maître, sans avoir à s'y brancher physiquement. Indispensable pour vérifier son état.

**Forcer une bascule pour tester :**

```
FGT-01 # diagnose sys ha reset-uptime
```

> ⚠️ **Attention** : c'est la bonne façon de tester une bascule, mais **teste-la en fenêtre de maintenance**. Un cluster HA se teste avant la panne — un basculement jamais éprouvé est un basculement dont personne ne sait s'il fonctionne.

---

### 🧪 TP 21 — Monter un cluster et le faire basculer

**🎯 Objectif**
Créer un cluster actif-passif, vérifier la synchronisation, provoquer une panne du maître, et **mesurer si les sessions survivent**.

**⏱️ Durée** : 45 minutes

**📋 Prérequis** : deux FortiGate identiques (même version, même modèle)

> ⚠️ **Attention** : les deux membres doivent avoir **la même version de FortiOS** et le **même modèle**. Un cluster entre versions différentes ne se forme pas, ou se forme mal.

---

**🔧 Manipulation**

**Étape 1 — Préparer les interfaces de battement de cœur**

Sur les deux équipements, réserve deux interfaces dédiées. Elles ne doivent
porter **aucune configuration IP** : FGCP s'en charge. Vérifie-le en CLI, et
retire l'adresse si l'une en porte une :

```
FGT-01 # show system interface port5
FGT-01 # show system interface port6
```

```
FGT-01 # config system interface
FGT-01 (interface) # edit "port5"
FGT-01 (port5) # unset ip
FGT-01 (port5) # set status up
FGT-01 (port5) # next
FGT-01 (interface) # edit "port6"
FGT-01 (port6) # unset ip
FGT-01 (port6) # set status up
FGT-01 (port6) # next
FGT-01 (interface) # end
```

Fais de même sur FGT-02.

**Étape 2 — Configurer le maître**

```
FGT-01 # config system ha
FGT-01 (ha) # set group-name "CLUSTER-LAB"
FGT-01 (ha) # set mode a-p
FGT-01 (ha) # set password "HALab2026!"
FGT-01 (ha) # set hbdev "port5" 50 "port6" 100
FGT-01 (ha) # set session-pickup enable
FGT-01 (ha) # set priority 200
FGT-01 (ha) # set override disable
FGT-01 (ha) # set monitor "port1" "port2"
FGT-01 (ha) # end
```

> ⚠️ La session se coupe brièvement : le pare-feu recalcule ses adresses MAC virtuelles. C'est normal.

**Étape 3 — Configurer le second**

Identique, à une seule différence — la priorité :

```
FGT-02 # config system ha
FGT-02 (ha) # set group-name "CLUSTER-LAB"
FGT-02 (ha) # set mode a-p
FGT-02 (ha) # set password "HALab2026!"
FGT-02 (ha) # set hbdev "port5" 50 "port6" 100
FGT-02 (ha) # set session-pickup enable
FGT-02 (ha) # set priority 100
FGT-02 (ha) # set override disable
FGT-02 (ha) # set monitor "port1" "port2"
FGT-02 (ha) # end
```

**Étape 4 — Vérifier la formation du cluster**

```
FGT-01 # get system ha status
```
```
HA Health Status: OK
Model: FortiGate-VM64
Mode: HA A-P
Group Name: CLUSTER-LAB
Group ID: 0
Debug: 0
Cluster Uptime: 0 days 0:3:12
...
Master: FGT-01, FGVMEV0000000001, cluster index = 0
Slave : FGT-02, FGVMEV0000000002, cluster index = 1
```

> ⚠️ **`Group Name` et `Group ID` sont deux lignes distinctes.** Le nom est
> celui que tu as tapé, l'identifiant reste à `0` tant que tu n'as pas posé
> `set group-id`. Deux clusters sur le même domaine de diffusion qui
> partagent le même `group-id` se mélangent — c'est l'identifiant, pas le
> nom, qui sépare les grappes sur le fil.

**`HA Health Status: OK`** et deux membres listés : le cluster est formé. 🎉

**Étape 5 — Vérifier la synchronisation**

```
FGT-01 # diagnose sys ha checksum cluster
```

Les empreintes doivent être **identiques** entre les deux membres.

> 🧠 Si elles diffèrent, force une resynchronisation :
> ```
> FGT-01 # execute ha synchronize start
> ```

**Étape 6 — Se connecter à l'esclave**

```
FGT-01 # execute ha manage 1 admin
```

Tu es maintenant sur FGT-02. Vérifie qu'il porte bien la configuration du maître :

```
FGT-02 # show firewall policy | grep "set name"
```

**La configuration a été copiée automatiquement.** Tu n'as rien fait pour ça.

```
FGT-02 # exit
```

**Étape 7 — Lancer un trafic continu**

Depuis le PC du LAN, quelque chose de mesurable :

```bash
user@pc-lan:~$ ping -i 0.2 192.168.20.10
```

Laisse tourner. C'est ce qui va nous dire combien de temps dure la bascule.

**Étape 8 — Provoquer la panne, en CLI**

C'est l'étape qui apprend le plus, et elle se fait **entièrement en ligne de
commande** — pas besoin de toucher à l'hyperviseur. Deux leviers, du plus
doux au plus radical :

```
FGT-01 # execute ha failover set
```

Le maître **cède la main volontairement**. C'est la manœuvre de maintenance.

```
FGT-01 # diagnose sys ha reset-uptime
```

Sa durée de fonctionnement HA retombe à zéro. Avec `override disable`, c'est
ce critère qui départage **avant** la priorité (§22.3), donc l'autre membre
gagne l'élection suivante.

> ⚠️ **Le cluster doit tourner depuis un moment pour que ça marche.** La
> durée de fonctionnement HA se compare par tranches de **cinq minutes** :
> sur une grappe montée il y a trente secondes, remettre à zéro ne creuse
> aucun écart et il ne se passe rien. Laisse tourner, puis recommence — la
> tranche est là pour qu'un simple redémarrage de service ne fasse pas
> osciller un cluster.

**Fais celle du milieu.** `diagnose sys ha reset-uptime` est la manœuvre que
Fortinet documente pour tester une bascule, et c'est celle du §22.5.

> 🧠 **Pourquoi PAS `set status down` sur une interface surveillée ?**
> Parce que le statut administratif d'une interface **fait partie de la
> configuration**, et que la configuration est synchronisée : shutter
> `port1` sur le maître le shutte aussi sur l'esclave. Les deux membres
> perdent la même interface, le critère ne départage plus rien, et il ne se
> passe **rien**. Une panne d'interface surveillée est un événement
> **physique** — câble débranché, commutateur mort — et c'est justement ce
> que `set monitor` existe pour attraper. C'est aussi pourquoi on ne peut
> pas la mettre en scène depuis la CLI : essaie, et tu verras les deux
> membres tomber ensemble.

> 🚨 Garde la **console** ouverte pendant toute cette étape.

Sur le PC, observe le `ping` :

```
64 bytes from 192.168.20.10: icmp_seq=142 time=0.4 ms
64 bytes from 192.168.20.10: icmp_seq=143 time=0.4 ms
... quelques paquets perdus ...
64 bytes from 192.168.20.10: icmp_seq=149 time=0.5 ms
```

**Compte les paquets perdus.** À 0,2 s d'intervalle, cinq paquets perdus font une seconde de coupure.

**Étape 9 — Vérifier que l'esclave a pris la main**

```
FGT-02 # get system ha status
```

FGT-02 est maintenant `Master`.

**Étape 10 — Mesurer l'apport de `session-pickup`**

C'est l'expérience la plus instructive. Refais le test avec une **session TCP longue** :

```bash
user@pc-lan:~$ ssh user@192.168.20.10
```

Reste connecté, puis provoque la bascule. **Avec `session-pickup enable`, la session SSH survit.** Sans lui, elle se coupe.

Pour le vérifier, désactive-le et recommence :

```
FGT-02 # config system ha
FGT-02 (ha) # set session-pickup disable
FGT-02 (ha) # end
```

> 🧠 **Comprendre** : sans `session-pickup`, l'esclave ne connaît pas les sessions en cours. Après la bascule, le trafic d'une connexion établie arrive sur un pare-feu qui n'en a jamais entendu parler — il tombe donc sur la règle du §11.3 ④ et se fait jeter. Le ping recommence à zéro sans problème (ICMP est sans état), mais SSH meurt.
>
> C'est pour ça que `session-pickup` est **le paramètre à ne jamais oublier**.

**Étape 11 — Observer le retour**

FGT-01 n'a rien perdu : il a seulement cédé la main. Observe qui est maître
maintenant :

```
FGT-02 # get system ha status
```

Avec `override disable`, **FGT-01 revient en esclave** et FGT-02 reste maître. C'est le comportement voulu (§22.3).

---

**✅ Résultat attendu**

- `get system ha status` liste deux membres, `Health Status: OK`
- Les empreintes de configuration sont identiques
- La configuration est copiée automatiquement sur l'esclave
- Une panne du maître coupe le trafic environ une seconde
- Avec `session-pickup`, une session SSH survit à la bascule

---

**🧠 Ce que tu viens d'apprendre**

1. **Actif-passif suffit presque toujours**, et se diagnostique bien plus facilement.
2. **`session-pickup` décide si les connexions survivent** à une bascule.
3. **`override disable` évite une seconde bascule inutile**, et protège d'un cluster qui oscille.
4. **`monitor` fait basculer sur une interface morte** — sans lui, un cluster « en bonne santé » peut n'avoir plus d'Internet.
5. **Deux liens de battement de cœur protègent du split-brain**, qui est pire qu'une panne.
6. **Un basculement jamais testé est un basculement inconnu.**

---

# Partie IX — L'exploitation au quotidien

---

## 23. Journaux, FortiView et supervision

Un pare-feu qui filtre sans journaliser est un pare-feu dont personne ne sait ce qu'il fait. Cette section transforme ton équipement en source d'information exploitable.

### 23.1 Les catégories de journaux

FortiOS sépare les journaux par nature, et cette séparation gouverne toutes les commandes de filtrage :

| Catégorie | Contenu | Numéro |
|---|---|---|
| **Traffic** | Chaque session autorisée ou refusée | `0` |
| **Event** | Administration, système, VPN, HA, routage | `1` |
| **Virus** | Antivirus | `2` |
| **Webfilter** | Filtrage web | `3` |
| **IPS** (attack) | Détection d'intrusion | `4` |
| **File-filter** | Filtrage de fichiers | `19` |

> ⚠️ **Attention — le piège de numérotation**
> Beaucoup de tutoriels écrivent que « la catégorie 1, c'est l'UTM ». **C'est faux.** La catégorie 1 est `event`. Les journaux UTM ne forment pas une catégorie unique : **chaque sous-type a son propre numéro** — antivirus, filtrage web, IPS, filtrage de fichiers…
>
> Ne devine pas ces numéros : ta machine te donne la liste exacte.
> ```
> FGT-01 # execute log filter category ?
> ```
> Elle rend les dix-sept catégories réelles. C'est la seule source fiable, et elle est à portée de main.

### 23.2 Où vont les journaux

| Destination | Capacité | Usage |
|---|---|---|
| **Mémoire** | Très faible, volatile | Lab, dépannage immédiat |
| **Disque local** | Limitée | Petits sites, si le modèle a un disque |
| **FortiAnalyzer** | ⭐ Grande, avec corrélation et rapports | Le standard en entreprise |
| **Syslog** | Selon le collecteur | ⭐ Intégration dans un SIEM |
| **FortiCloud** | Selon l'abonnement | Sites sans infrastructure |

```
config log memory setting
    set status enable
end

config log syslogd setting
    set status enable
    set server "192.168.10.60"
    set port 514
    set facility local7
    set format rfc5424
    set mode reliable
end
```

> 💡 **Astuce — `set mode reliable`** passe le syslog en **TCP** au lieu d'UDP. En UDP, un journal perdu l'est définitivement et personne ne le sait. Pour des journaux de sécurité — ceux dont on aura besoin justement le jour d'un incident — la fiabilité vaut le léger surcoût.

> 🚨 **Danger — un pare-feu qui ne journalise nulle part**
> Sur une VM ou un petit boîtier sans disque, les journaux vivent **en mémoire** et disparaissent au redémarrage. Si tu as un incident et que le pare-feu a redémarré entre-temps, tu n'as **rien**.
>
> En production, envoie toujours les journaux vers une destination externe. Ce n'est pas du confort : sans journaux externalisés, tu ne pourras répondre à aucune question après coup, et une analyse d'incident sans journaux ne mène nulle part.

### 23.3 Lire les journaux en CLI

La séquence est toujours la même : **filtrer**, puis **afficher**.

```
FGT-01 # execute log filter reset
FGT-01 # execute log filter category 0
FGT-01 # execute log filter field srcip 192.168.10.10
FGT-01 # execute log filter field action deny
FGT-01 # execute log filter start-line 1
FGT-01 # execute log filter view-lines 20
FGT-01 # execute log display
```

Les champs les plus utiles :

| Champ | Contenu |
|---|---|
| `srcip` / `dstip` | Adresses source et destination |
| `action` | `accept`, `deny`, `close`, `blocked` |
| `policyid` | ⭐ Quelle politique a décidé |
| `user` | L'utilisateur authentifié (§17) |
| `service` | Le service |
| `appid` / `app` | L'application reconnue |
| `level` | Sévérité |

> 💡 **Astuce** : `execute log filter reset` **avant chaque recherche**. Les filtres persistent d'une commande à l'autre, et une recherche qui ne rend rien est très souvent un filtre oublié qui restreint sans qu'on s'en souvienne.

### 23.4 FortiView

FortiView est la vue graphique des journaux, et c'est là qu'on répond aux questions qu'on se pose vraiment :

| Vue | Question à laquelle elle répond |
|---|---|
| **Sources** | Qui consomme le plus ? |
| **Destinations** | Vers où va le trafic ? |
| **Applications** | Quelles applications sont utilisées ? |
| **Web Sites** | Quels sites sont visités ? |
| **Threats** | Quelles menaces ont été bloquées ? |
| **Policies** | ⭐ Quelles règles servent, et lesquelles ne servent jamais ? |
| **Sessions** | Que se passe-t-il maintenant ? |

> 💡 **Astuce professionnelle** : la vue **Policies** est la plus sous-utilisée et la plus rentable. Elle montre les règles à compteur nul — celles qui ne servent à rien, ou qui sont masquées par une règle au-dessus (§9.2). C'est la base du ménage annuel dans un jeu de règles, et le premier réflexe d'un audit.

### 23.5 Les alertes

Le pare-feu peut prévenir plutôt que d'attendre qu'on le consulte :

```
config alertemail setting
    set username "fortigate@entreprise.fr"
    set mailto1 "admin@entreprise.fr"
    set filter-mode category
    set critical-interval 5
    set FDS-license-expiring-warning enable
    set FIPS-CC-error enable
    set HA-mode-change enable
    set configuration-changes-logs enable
end
```

Et le SNMP, pour la supervision :

```
config system snmp sysinfo
    set status enable
    set description "Pare-feu principal - Paris"
    set contact-info "admin@entreprise.fr"
    set location "Salle serveur - Batiment A"
end

config system snmp community
    edit 1
        set name "supervision"
        config hosts
            edit 1
                set ip 192.168.10.70 255.255.255.255
            next
        end
        set query-v1-status disable
        set query-v2c-status enable
        set trap-v2c-status enable
    next
end
```

> ⚠️ **Attention** : n'utilise **jamais** `public` comme nom de communauté, et n'expose jamais SNMP sur une interface externe. SNMPv2c circule **en clair** — quiconque écoute lit toute ta topologie. Préfère SNMPv3 quand ton outil de supervision le gère.

### 23.6 🧠 Ce qu'il faut surveiller vraiment

Voici les indicateurs qui comptent, et pourquoi :

| Indicateur | Commande | Pourquoi c'est important |
|---|---|---|
| Charge processeur | `get system performance status` | Une saturation dégrade tout le trafic |
| Mémoire | `get system performance status` | ⭐ Voir *conserve mode* ci-dessous |
| Nombre de sessions | `get system session status` | Une explosion signale un scan ou une infection |
| État des tunnels VPN | `get vpn ipsec tunnel summary` | Un site coupé sans alerte |
| État du cluster HA | `get system ha status` | Un cluster dégradé qui ne se voit pas |
| Bases FortiGuard | `diagnose autoupdate versions` | Des signatures périmées ne protègent pas |
| Espace disque de journaux | `diagnose sys logdisk usage` | Un disque plein arrête la journalisation |

> 🚨 **Le *conserve mode*, à connaître absolument**
> Quand la mémoire d'un FortiGate atteint un seuil critique, il entre en **conserve mode** : il **cesse d'inspecter** le trafic pour économiser des ressources. Selon le réglage `av-failopen`, il laisse alors passer le trafic **sans analyse**, ou le bloque.
>
> ```
> FGT-01 # diagnose hardware sysinfo conserve
> FGT-01 # get system performance status
> ```
>
> **Le piège** : en `av-failopen pass` (souvent le défaut), ton pare-feu continue de laisser passer le trafic — mais **sans antivirus, sans IPS, sans filtrage**. Tout a l'air normal. Tes utilisateurs ne se plaignent pas. Et tu n'es plus protégé.
>
> C'est exactement le genre de panne silencieuse qu'un tableau de bord doit détecter. Surveille la mémoire.

---

### 🧪 TP 22 — Rendre ton pare-feu bavard

**🎯 Objectif**
Configurer la journalisation, produire du trafic de plusieurs natures, retrouver chaque événement en CLI, et repérer une règle inutile.

**⏱️ Durée** : 30 minutes

**📋 Prérequis** : TP 12 terminé

---

**🔧 Manipulation**

**Étape 1 — Activer la journalisation mémoire**

```
FGT-01 # config log memory setting
FGT-01 (setting) # set status enable
FGT-01 (setting) # end

FGT-01 # config log memory global-setting
FGT-01 (global-setting) # set max-size 98304
FGT-01 (global-setting) # end
```

**`max-size` est en OCTETS**, pas en lignes : c'est la taille du tampon en
mémoire, et quand il est plein les lignes les plus anciennes tombent.

Active aussi la journalisation du refus implicite — **elle est désactivée
par défaut**, et sans elle l'étape 5 ne trouvera rien :

```
FGT-01 # config log setting
FGT-01 (setting) # set fwpolicy-implicit-log enable
FGT-01 (setting) # end
```

**Étape 2 — S'assurer que les politiques journalisent**

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # set logtraffic all
FGT-01 (1) # set logtraffic-start enable
FGT-01 (1) # next
FGT-01 (policy) # edit 2
FGT-01 (2) # set logtraffic all
FGT-01 (2) # next
FGT-01 (policy) # end
```

**Étape 3 — Produire du trafic varié**

Depuis le PC du LAN :

```bash
user@pc-lan:~$ ping -c 5 192.168.20.10
user@pc-lan:~$ curl -s -o /dev/null http://192.168.20.10
user@pc-lan:~$ curl -m 5 http://example.com          ← bloqué (TP 12)
user@pc-lan:~$ ssh user@192.168.20.10                ← refusé (service non autorisé)
```

**Étape 4 — Retrouver le trafic autorisé**

```
FGT-01 # execute log filter reset
FGT-01 # execute log filter category 0
FGT-01 # execute log filter field srcip 192.168.10.10
FGT-01 # execute log filter view-lines 20
FGT-01 # execute log display
```

**Étape 5 — Retrouver le trafic refusé**

```
FGT-01 # execute log filter reset
FGT-01 # execute log filter category 0
FGT-01 # execute log filter field action deny
FGT-01 # execute log display
```

Tu retrouves la tentative SSH. Regarde le champ `policyid` : il vaut `0` — l'`Implicit Deny` du §11, TP 9.

> 🧠 **Tu ne trouves rien ?** C'est que `fwpolicy-implicit-log` est resté
> désactivé (étape 1). Fortinet le laisse ainsi par défaut pour ne pas noyer
> le collecteur, et c'est la première chose à vérifier quand un refus
> « n'apparaît pas dans les journaux ».

**Étape 6 — Retrouver le blocage du filtrage web**

```
FGT-01 # execute log filter reset
FGT-01 # execute log filter category 3
FGT-01 # execute log display
```

Tu retrouves le blocage de `example.com` par la liste locale.

> 🧠 **Note la différence** : le refus de la politique est en catégorie `0` (trafic), le blocage du filtrage web en catégorie `3` (webfilter). Chercher dans la mauvaise catégorie est la cause n°1 des « je ne trouve rien dans les journaux ».

**Étape 7 — Les événements système**

```
FGT-01 # execute log filter reset
FGT-01 # execute log filter category 1
FGT-01 # execute log display
```

Tu retrouves tes propres connexions d'administration et tes changements de configuration. **Un pare-feu journalise qui l'a modifié** — et c'est pour ça que les comptes nominatifs du §4.3 comptent.

**Étape 8 — Trouver les règles inutiles**

`get firewall policy` liste les **clés** de la table, une politique par
bloc — c'est la forme de tout `get` sur une table sans clé, et il n'y a pas
de compteur dedans :

```
FGT-01 # get firewall policy
```
```
== [ 1 ]
policyid: 1
== [ 2 ]
policyid: 2
```

Les compteurs se lisent dans le moteur de politiques lui-même, une règle à
la fois :

```
FGT-01 # diagnose firewall iprope show 100004 1
FGT-01 # diagnose firewall iprope show 100004 2
```
```
policy index=1 ... hit count:14 ...
policy index=2 ... hit count:0 ...
```

Une politique dont le `hit count` reste à zéro depuis longtemps est
suspecte : soit elle ne sert à rien, soit elle est **masquée par une règle
au-dessus** (§11.3).

**Étape 9 — Surveiller les indicateurs**

```
FGT-01 # get system performance status
FGT-01 # get system session status
FGT-01 # diagnose hardware sysinfo conserve
FGT-01 # diagnose autoupdate versions
```

Note la mémoire utilisée. Sur une VM à 2 Gio avec des profils actifs, elle monte vite — et tu sais maintenant ce que ça implique (§23.6).

**Étape 10 — Configurer un syslog externe (facultatif)**

Si tu as une machine Linux disponible :

```bash
root@collecteur:~# apt install -y rsyslog
root@collecteur:~# echo '$ModLoad imudp
$UDPServerRun 514
:fromhost-ip, isequal, "192.168.10.1" /var/log/fortigate.log
& stop' > /etc/rsyslog.d/10-fortigate.conf
root@collecteur:~# systemctl restart rsyslog
```

```
FGT-01 # config log syslogd setting
FGT-01 (setting) # set status enable
FGT-01 (setting) # set server "192.168.10.60"
FGT-01 (setting) # set port 514
FGT-01 (setting) # set facility local7
FGT-01 (setting) # end
```

```bash
root@collecteur:~# tail -f /var/log/fortigate.log
```

Génère du trafic et regarde les journaux arriver **en direct**.

---

**✅ Résultat attendu**

- Le trafic autorisé apparaît en catégorie 0
- Le trafic refusé porte `policyid=0`
- Le blocage web apparaît en catégorie **3** (`utm-webfilter`)
- Tes modifications apparaissent en catégorie **1** (`event`)
- `diagnose firewall iprope show` révèle les compteurs

---

**🧠 Ce que tu viens d'apprendre**

1. **Il n'y a pas de catégorie « UTM » unique** — chaque sous-type a son numéro, et chercher dans la mauvaise fait conclure à tort qu'il n'y a rien.
2. **`execute log filter reset` avant chaque recherche** — les filtres persistent.
3. **`policyid=0` dans un journal, c'est l'Implicit Deny.**
4. **Les journaux en mémoire disparaissent au redémarrage.** En production, on externalise.
   *(La liste exacte des catégories se lit avec `execute log filter category ?` — jamais de mémoire.)*
5. **Un compteur à zéro est un signal** à investiguer.
6. **Le conserve mode arrête l'inspection sans rien casser de visible.** C'est une panne silencieuse.

---

## 24. Diagnostic et dépannage

Tu as croisé les outils au fil du tutoriel. Cette section les organise en **méthode** — parce que le dépannage n'est pas une collection de commandes, c'est une façon de réduire un problème.

### 24.1 🧠 La méthode : diviser en deux, toujours

Le réflexe qui distingue un dépanneur efficace, c'est de ne **jamais** chercher au hasard. À chaque étape, on pose une question dont la réponse **élimine la moitié des causes**.

```
« Ça ne marche pas »
        │
        ├─► Le paquet ARRIVE-t-il sur le pare-feu ?
        │   └─ NON → le problème est EN AMONT (câble, VLAN, routage du client, R1)
        │
        ├─► Le pare-feu a-t-il une ROUTE ?
        │   └─ NON → problème de routage (§7)
        │
        ├─► Une POLITIQUE l'autorise-t-elle ?
        │   └─ NON → il manque une règle (§9)
        │
        ├─► Le NAT s'applique-t-il correctement ?
        │   └─ NON → problème de VIP ou de SNAT (§10)
        │
        ├─► Le paquet RESSORT-il ?
        │   └─ NON → un profil de sécurité l'a jeté (§14)
        │
        └─► Il ressort → LE PROBLÈME N'EST PAS SUR LE PARE-FEU
```

> 💡 **La dernière branche est la plus importante.** Savoir dire « le pare-feu laisse passer, va voir ailleurs » avec **une preuve** te fait gagner un temps considérable — et te sort des discussions où chaque équipe accuse l'autre.

### 24.2 Les cinq outils, et la question de chacun

| Outil | La question à laquelle il répond |
|---|---|
| `diagnose sniffer packet` | « Le paquet arrive-t-il ? Ressort-il ? » |
| `diagnose debug flow` | « Que **décide** le pare-feu, et pourquoi ? » |
| `diagnose sys session list` | « Quelle règle a autorisé ? Quel NAT s'applique ? » |
| `execute log display` | « Que s'est-il passé **avant** que j'arrive ? » (précédé de `execute log filter reset`) |
| `get router info routing-table` | « Le pare-feu sait-il où envoyer ça ? » |

### 24.3 L'aide-mémoire du sniffer

```
FGT-01 # diagnose sniffer packet <interface> '<filtre BPF>' <niveau> <nombre> <horodatage>
```

```
FGT-01 # diagnose sniffer packet any 'host 192.168.10.10' 4 100
FGT-01 # diagnose sniffer packet port1 'tcp port 443' 4 50
FGT-01 # diagnose sniffer packet any 'icmp' 4 20
FGT-01 # diagnose sniffer packet any 'udp port 500 or udp port 4500' 4 30
FGT-01 # diagnose sniffer packet any 'host 10.0.0.5 and not port 22' 4 100 a
```

> 💡 **Astuce** : le dernier argument, `a`, ajoute un **horodatage absolu**. Indispensable quand tu compares une capture avec des journaux, ou avec la capture d'un autre équipement.

**Le raisonnement du sniffer sur deux interfaces** :

```
FGT-01 # diagnose sniffer packet any 'host 192.168.20.10' 4 50
```

Avec le niveau 4, chaque ligne indique l'interface. Tu cherches alors :
- le paquet arrive sur `port2` **et** ressort sur `port3` → le pare-feu fait son travail ;
- il arrive sur `port2` et **ne ressort pas** → il a été jeté à l'intérieur, passe à `debug flow` ;
- il n'arrive **pas du tout** → le problème est en amont, ne cherche pas sur le pare-feu.

### 24.4 L'aide-mémoire du debug flow

```
FGT-01 # diagnose debug reset
FGT-01 # diagnose debug flow filter clear
FGT-01 # diagnose debug flow filter addr 192.168.20.10
FGT-01 # diagnose debug flow filter proto 6
FGT-01 # diagnose debug flow filter port 443
FGT-01 # diagnose debug flow show function-name enable
FGT-01 # diagnose debug flow trace start 20
FGT-01 # diagnose debug enable

   ... reproduire le problème ...

FGT-01 # diagnose debug disable
FGT-01 # diagnose debug flow trace stop
FGT-01 # diagnose debug reset
```

**Les messages et leur traduction :**

| Message | Ce qu'il veut dire | Où chercher |
|---|---|---|
| `Allowed by Policy-N` | Autorisé par la règle N | Nulle part, ça marche |
| `Denied by forward policy check (policy 0)` | ⭐ **Aucune règle ne correspond** | Il en manque une |
| `Denied by forward policy check (policy N)` | La règle N refuse | Va voir la règle N |
| `no route to destination` | Pas de route | Section 7 |
| `reverse path check fail, drop` | RPF | §11.4 |
| `iprope_in_check() check failed` | Trafic **local-in** refusé | `allowaccess`, local-in policy |
| `no session matched, drop` | Paquet hors session | Normal sur un scan |
| `Denied by quota` | Quota atteint | Traffic shaping |

### 24.5 Les commandes de santé

```
FGT-01 # get system performance status
FGT-01 # get system performance top 5 20
FGT-01 # diagnose sys top 5 20
FGT-01 # get system session status
FGT-01 # diagnose sys session stat
FGT-01 # diagnose hardware sysinfo memory
FGT-01 # diagnose hardware sysinfo conserve
FGT-01 # diagnose sys logdisk usage
FGT-01 # get system status
```

> 💡 **Astuce — `diagnose sys top`** liste les processus par consommation. Les noms qu'on rencontre :
> - `wad` → le proxy (inspection en mode proxy, §13)
> - `ipsengine` → l'IPS
> - `scanunitd` → l'antivirus
> - `ipsmonitor` → la supervision de l'IPS
> - `sslvpnd` → le service VPN SSL (s'il existe encore, §2.6)
> - `httpsd` → l'interface web d'administration
>
> Un processus qui monopolise le processeur te dit **quelle fonction** est en cause, ce qui est bien plus précis que « le pare-feu est lent ».

### 24.6 Le paquet de diagnostic pour le support

Quand tu ouvres un ticket chez Fortinet, ils demandent toujours la même chose. Autant l'avoir prêt :

```
FGT-01 # execute tac report
```

Cette commande collecte automatiquement l'ensemble des informations utiles. C'est long, et c'est ce qu'il faut joindre.

> 💡 **Astuce** : joins **aussi** une description précise de ce que tu attendais, de ce que tu observes, et l'heure exacte d'une occurrence du problème. Un ticket qui dit « ça ne marche pas » avec un `tac report` prend une semaine ; un ticket qui dit « à 14 h 32, la session de `192.168.10.10` vers `203.0.113.7:443` est refusée avec `policy 0` alors que la politique 12 devrait correspondre » est traité dans la journée.

---

### 🧪 TP 23 — Dépanner trois pannes que tu ne connais pas

**🎯 Objectif**
Appliquer la méthode sur trois pannes **provoquées à l'aveugle**. L'exercice est de diagnostiquer **avant** de lire la cause.

**⏱️ Durée** : 40 minutes

**📋 Prérequis** : laboratoire fonctionnel

> 💡 **Comment faire cet exercice** : lis l'énoncé de la panne, applique le script pour la provoquer **sans lire la cause**, puis diagnostique. Ne déplie la solution qu'après.

---

**🔧 Panne n°1 — « Le LAN n'accède plus à la DMZ »**

Provoque :

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 2
FGT-01 (2) # set service "HTTPS"
FGT-01 (2) # next
FGT-01 (policy) # end
```

Depuis le PC :

```bash
user@pc-lan:~$ curl -m 5 http://192.168.20.10
```

**À toi.** Diagnostique avant de lire.

<details>
<summary>👉 La démarche et la cause</summary>

```
FGT-01 # diagnose sniffer packet any 'host 192.168.20.10' 4 10
```
Le paquet **arrive** sur `port2`. Il ne ressort pas sur `port3`.

```
FGT-01 # diagnose debug flow filter addr 192.168.20.10
FGT-01 # diagnose debug flow trace start 10
FGT-01 # diagnose debug enable
```
```
msg="Denied by forward policy check (policy 0)"
```

`policy 0` = **aucune règle ne correspond** (§11, TP 9). Or la politique 2 existe. Donc elle ne correspond **plus** : un de ses critères a changé.

```
FGT-01 # show firewall policy 2
```
Le service est `HTTPS`, or on demande du HTTP. **Cause : le service de la politique ne couvre plus le trafic.**

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 2
FGT-01 (2) # set service "PING" "HTTP"
FGT-01 (2) # next
FGT-01 (policy) # end
```
</details>

---

**🔧 Panne n°2 — « Plus d'accès Internet depuis le LAN »**

Provoque :

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # set nat disable
FGT-01 (1) # next
FGT-01 (policy) # end
```

```bash
user@pc-lan:~$ ping -c 3 8.8.8.8
```

<details>
<summary>👉 La démarche et la cause</summary>

```
FGT-01 # diagnose debug flow filter addr 8.8.8.8
FGT-01 # diagnose debug flow trace start 10
FGT-01 # diagnose debug enable
```
```
msg="Allowed by Policy-1:"
```

**Le pare-feu AUTORISE.** C'est la branche la plus utile de la méthode : le problème n'est pas dans le filtrage.

```
FGT-01 # diagnose sniffer packet port1 'host 8.8.8.8' 4 10
```
```
192.168.10.10 -> 8.8.8.8: icmp: echo request
```

**Le paquet sort avec son adresse PRIVÉE.** R1 le NATera peut-être, mais dans une vraie sortie Internet, `192.168.10.10` n'a aucun chemin de retour (§10.1).

```
FGT-01 # diagnose sys session filter dst 8.8.8.8
FGT-01 # diagnose sys session list
```
Aucune ligne `act=snat`. **Cause : le NAT est désactivé sur la politique.**

```
FGT-01 # config firewall policy
FGT-01 (policy) # edit 1
FGT-01 (1) # set nat enable
FGT-01 (1) # next
FGT-01 (policy) # end
```
</details>

---

**🔧 Panne n°3 — « Le serveur publié n'est plus joignable »**

Provoque :

```
FGT-01 # config firewall vip
FGT-01 (vip) # edit "VIP-Serveur-Web"
FGT-01 (VIP-Serveur-Web) # set mappedip "192.168.20.99"
FGT-01 (VIP-Serveur-Web) # next
FGT-01 (vip) # end
```

Assure-toi qu'une politique de publication existe (TP 8), puis :

```bash
curl -m 5 http://192.168.100.200
```

<details>
<summary>👉 La démarche et la cause</summary>

```
FGT-01 # diagnose debug flow filter addr 192.168.100.200
FGT-01 # diagnose debug flow trace start 10
FGT-01 # diagnose debug enable
```
```
msg="VIP-... DNAT 192.168.100.200:80 -> 192.168.20.99:80"
msg="Allowed by Policy-3:"
...
msg="Destination unreachable" ou pas de réponse
```

Le DNAT s'applique, la politique autorise — **mais la destination est `192.168.20.99`**, pas `192.168.20.10`.

```
FGT-01 # execute ping 192.168.20.99
```
Aucune réponse : cette machine n'existe pas.

```
FGT-01 # show firewall vip VIP-Serveur-Web
```
**Cause : le `mappedip` du VIP pointe vers une adresse inexistante.**

```
FGT-01 # config firewall vip
FGT-01 (vip) # edit "VIP-Serveur-Web"
FGT-01 (VIP-Serveur-Web) # set mappedip "192.168.20.10"
FGT-01 (VIP-Serveur-Web) # next
FGT-01 (vip) # end
```
</details>

---

**✅ Résultat attendu**

Tu as diagnostiqué trois pannes de natures différentes — **politique**, **NAT**, **objet mal configuré** — avec la même méthode et sans deviner.

---

**🧠 Ce que tu viens d'apprendre**

1. **La méthode ne change pas**, seule la branche où l'on s'arrête change.
2. **`sniffer` d'abord** : si le paquet n'arrive pas, inutile de chercher sur le pare-feu.
3. **`Allowed by Policy-N` est une information précieuse** — elle t'envoie chercher ailleurs, avec une preuve.
4. **La table de sessions confirme le NAT** (`act=snat`, `act=dnat`).
5. **Une panne peut venir d'un objet**, pas d'une règle. Vérifie ce que la règle **contient**, pas seulement qu'elle existe.

---

## 25. Sauvegarde, mise à jour et durcissement

Les trois tâches qu'on repousse toujours, et qui décident de ce qui se passe le jour où ça tourne mal.

### 25.1 La sauvegarde

```
FGT-01 # execute backup config tftp sauvegarde-2026-08-20.conf 192.168.10.50
FGT-01 # execute backup config ftp sauvegarde.conf 192.168.10.50 utilisateur motdepasse
FGT-01 # execute backup config usb sauvegarde.conf
```

Ou par l'interface web : `Dashboard` → menu utilisateur → `Configuration` → `Backup`.

**Sauvegarder en chiffré** — indispensable, et voici pourquoi :

```
FGT-01 # execute backup config tftp sauvegarde.conf 192.168.10.50 MotDePasseDeChiffrement
```

> 🚨 **Danger — une sauvegarde en clair est un fichier de secrets**
> Une configuration FortiGate contient : les clés partagées de tous tes VPN, les mots de passe des comptes de service LDAP et RADIUS, les communautés SNMP, les identifiants PPPoE, et parfois des certificats avec leur clé privée.
>
> **Un fichier de sauvegarde en clair qui traîne sur un partage réseau donne à qui le lit les clés de ton infrastructure entière.** Chiffre-les, et traite-les comme des secrets — pas comme des fichiers de configuration.

> ⚠️ **Attention** : une sauvegarde chiffrée **ne peut être restaurée que sur le même modèle**, et il faut évidemment le mot de passe. Perdre ce mot de passe rend la sauvegarde inutile. Range-le dans le coffre-fort à mots de passe de l'entreprise, pas dans un fichier à côté de la sauvegarde.

**Automatiser** — parce qu'une sauvegarde manuelle n'est jamais à jour :

```
config system automation-trigger
    edit "Sauvegarde-Quotidienne"
        set trigger-type scheduled
        set trigger-frequency daily
        set trigger-hour 2
        set trigger-minute 0
    next
end
```

> 💡 **Astuce** : la meilleure automatisation reste un script externe qui se connecte en SSH, exécute `show`, et archive le résultat dans un dépôt Git. Tu obtiens ainsi **l'historique complet** de ta configuration, avec la possibilité de voir exactement ce qui a changé entre deux dates — et par qui, en croisant avec les journaux de catégorie 2 (§23).
>
> Ce n'est pas une astuce de confort : le jour où quelque chose casse après une modification, `git diff` te donne la réponse en dix secondes.

### 25.2 La restauration

```
FGT-01 # execute restore config tftp sauvegarde.conf 192.168.10.50
```

> ⚠️ **Attention** : la restauration **redémarre** l'équipement et **écrase entièrement** la configuration. Ce n'est pas une fusion. Tout ce qui a été fait depuis la sauvegarde est perdu.

### 25.3 La mise à jour de FortiOS

**Avant** de mettre à jour, trois choses, dans cet ordre :

1. **Lire les notes de version.** Pas les survoler : les lire. C'est là que sont signalés les changements de comportement — comme le retrait du SSL VPN du §2.6, qui a mis des entreprises dehors.
2. **Vérifier le chemin de mise à jour.** On ne saute pas de 7.0 à 7.6 directement. Fortinet publie un outil de chemin de mise à jour, et le respecter n'est pas optionnel.
3. **Sauvegarder.** Chiffrée, et vérifiée.

```
FGT-01 # get system status | grep Version
FGT-01 # execute backup config tftp avant-maj.conf 192.168.10.50 MotDePasse
FGT-01 # execute restore image tftp FGT_VM64-v7.6.3.out 192.168.10.50
```

> 🚨 **Danger — ne mets jamais à jour un pare-feu distant sans plan de secours**
> Si la mise à jour se passe mal, tu perds l'accès et tu es à deux heures de route de l'équipement. Prévois **toujours** :
> - un accès console hors bande (KVM, console série sur un serveur de terminaux) ;
> - la version précédente disponible localement ;
> - quelqu'un sur place, joignable.
>
> Et fais-le en fenêtre de maintenance, pas un vendredi à 17 h. Ce conseil fait sourire jusqu'à ce qu'on l'ait ignoré une fois.

> 💡 **Astuce** : sur un cluster HA, FortiOS sait faire une mise à jour **en cascade** — il met à jour l'esclave, bascule, puis met à jour l'ancien maître. La coupure se limite à une bascule. C'est un des vrais bénéfices de la HA, souvent oublié dans le calcul de rentabilité.

### 25.4 Le durcissement : la liste qui compte

Voici ce qui distingue un pare-feu correctement déployé d'un pare-feu simplement fonctionnel.

**① Fermer l'administration sur l'extérieur**

C'est le point n°1, et on l'a laissé ouvert au TP 1 :

```
FGT-01 # config system interface
FGT-01 (interface) # edit port1
FGT-01 (port1) # set allowaccess ping
FGT-01 (port1) # next
FGT-01 (interface) # end
```

Encore mieux : rien du tout, et une local-in policy (§11.5) pour les rares cas où l'administration distante est nécessaire.

**② Changer les ports d'administration**

```
config system global
    set admin-sport 8443
    set admin-ssh-port 2222
end
```

> 🧠 Ce n'est **pas** une mesure de sécurité en soi — un scan trouve le nouveau port en quelques secondes. Mais ça élimine l'essentiel des tentatives automatisées, qui ne testent que les ports standard. Ça vaut le geste, à condition de ne pas croire que ça protège.

**③ Désactiver ce qui ne sert pas**

```
config system global
    set admin-telnet disable
    set gui-certificates disable
end
```

**④ Renforcer les mots de passe**

Le refus est immédiat, au moment du `set`, et nomme la règle non remplie. `apply-to` porte aussi sur les clés partagées IPsec, pas seulement sur les comptes.

```
config system password-policy
    set status enable
    set apply-to admin-password
    set minimum-length 12
    set min-lower-case-letter 1
    set min-upper-case-letter 1
    set min-non-alphanumeric 1
    set min-number 1
    set expire-status enable
    set expire-day 90
end
```

**⑤ Limiter les tentatives**

```
config system global
    set admin-lockout-threshold 3
    set admin-lockout-duration 300
end
```

**⑥ Le second facteur pour les administrateurs**

```
config system admin
    edit "jdupont"
        set two-factor fortitoken
    next
end
```

**⑦ Restreindre par adresse source**

```
config system admin
    edit "jdupont"
        set trusthost1 192.168.99.0 255.255.255.0
    next
end
```

> 🚨 Rappel du §4.4 : le `trusthost` t'enferme dehors si tu te trompes. Compte de test d'abord.

**⑧ Bannière et bandeau**

```
config system global
    set pre-login-banner enable
    set post-login-banner enable
end
```

> 💡 **Astuce** : la bannière n'est pas décorative. Dans beaucoup de juridictions, elle est ce qui rend un accès **explicitement non autorisé** — et donc poursuivable. Un système sans avertissement affaiblit les poursuites contre celui qui s'y introduit.

**⑨ Journaliser tout ce qui est administratif**

Déjà couvert au §23, mais c'est un point de durcissement : sans journaux d'administration, tu ne peux pas savoir qui a fait quoi.

**⑩ Maintenir à jour**

Le point qui résume tous les autres. Un pare-feu à jour avec une configuration moyenne vaut mieux qu'un pare-feu parfaitement configuré en version vulnérable.

---

### 🧪 TP 24 — Durcir et sauvegarder

**🎯 Objectif**
Appliquer la liste de durcissement, sauvegarder en chiffré, vérifier la restauration, et mettre en place un suivi de configuration en Git.

**⏱️ Durée** : 35 minutes

**📋 Prérequis** : laboratoire fonctionnel

> 🚨 **Attention** : ce TP touche à ton propre accès. **Garde la console de l'hyperviseur ouverte** pendant toute sa durée.

---

**🔧 Manipulation**

**Étape 1 — Sauvegarder AVANT de durcir**

```
FGT-01 # execute backup config tftp avant-durcissement.conf 192.168.10.50 MotDePasseSauvegarde2026
FGT-01 # execute backup config tftp en-clair.conf 192.168.10.50
```

La première est chiffrée, la seconde ne l'est pas — c'est le mot de passe en fin de ligne qui décide, et c'est ce que compare l'étape 2.

> ⚠️ **La restauration exige le même mot de passe.** `execute restore config tftp avant-durcissement.conf 192.168.10.50` **sans** le mot de passe est refusé, et avec un mauvais mot de passe aussi : l'étiquette d'authentification GCM détecte la différence. Un mot de passe perdu rend la sauvegarde définitivement inutilisable.

Sans serveur TFTP, utilise l'interface web pour télécharger le fichier.

> 💡 Un serveur TFTP en une commande sur ta machine Linux :
> ```bash
> user@pc-lan:~$ sudo apt install -y tftpd-hpa
> user@pc-lan:~$ sudo chmod 777 /srv/tftp
> ```

**Étape 2 — Vérifier que la sauvegarde est chiffrée**

```bash
user@pc-lan:~$ head -c 200 /srv/tftp/avant-durcissement.conf
```

Tu dois voir un en-tête `#FGTCONFIG-ENCRYPTED-AES256-GCM` suivi de contenu **illisible**. Compare avec une sauvegarde non chiffrée :

```bash
user@pc-lan:~$ grep -E 'psksecret|hostname|allowaccess' /srv/tftp/en-clair.conf
```

Tu y liras toute la configuration, et les secrets sous la forme `set psksecret ENC RnZ4…`.

> 🧠 **`ENC` n'est PAS un chiffrement — c'est un encodage réversible.** La clé est **statique**, la même sur tous les FortiGate, et publiée : c'est la CVE-2019-6693. Qui tient le fichier tient la clé partagée de tes VPN, sans mot de passe et sans effort. C'est exactement pourquoi une sauvegarde en clair est un fichier de secrets.
>
> Le chiffrement de la sauvegarde, lui, est réel : AES-256-GCM. Sa faiblesse connue est ailleurs — la clé est dérivée du mot de passe par **un seul tour de SHA-256**, donc un mot de passe court se casse vite. Choisis-le long.

**Fais l'expérience.** C'est ce qui convainc de toujours chiffrer.

**Étape 3 — Politique de mots de passe**

```
FGT-01 # config system password-policy
FGT-01 (password-policy) # set status enable
FGT-01 (password-policy) # set apply-to admin-password
FGT-01 (password-policy) # set minimum-length 12
FGT-01 (password-policy) # set min-lower-case-letter 1
FGT-01 (password-policy) # set min-upper-case-letter 1
FGT-01 (password-policy) # set min-non-alphanumeric 1
FGT-01 (password-policy) # set min-number 1
FGT-01 (password-policy) # end
```

Teste-la :

```
FGT-01 # config system admin
FGT-01 (admin) # edit "test-faible"
FGT-01 (test-faible) # set password "1234"
```

FortiOS **refuse**, et la refus **nomme la règle** qui n'est pas remplie (« at least 12 characters »). Essaie ensuite `set password "Court1!"`, puis `set password "minusculesansrien"` : chaque essai te dit ce qui manque — la longueur, la majuscule, le chiffre, le caractère non alphanumérique.

Un mot de passe conforme, lui, passe :

```
FGT-01 (test-faible) # set password "MotDePasse2026!"
```

Supprime le compte de test :

```
FGT-01 (test-faible) # abort
```

> 💡 **`apply-to` décide de la portée, et il ne concerne pas que les comptes.** Avec `set apply-to admin-password ipsec-preshared-key`, la même politique refuse aussi une clé partagée VPN trop faible — c'est le seul endroit du pare-feu où la qualité d'un `psksecret` est vérifiée.

> ⚠️ **`set reuse-password disable` est refusé ici** : il demande de comparer avec les anciens mots de passe, et ce simulateur n'en garde pas l'historique. Un réglage accepté sans être appliqué serait pire que son absence.

**Étape 4 — Verrouillage après échecs**

```
FGT-01 # config system global
FGT-01 (global) # set admin-lockout-threshold 3
FGT-01 (global) # set admin-lockout-duration 300
FGT-01 (global) # end
```

**Étape 5 — Changer les ports d'administration**

```
FGT-01 # config system global
FGT-01 (global) # set admin-sport 8443
FGT-01 (global) # set admin-ssh-port 2222
FGT-01 (global) # end
```

> ⚠️ **Ta session en cours n'est pas coupée**, mais la prochaine connexion devra utiliser les nouveaux ports :
> ```bash
> user@pc-lan:~$ ssh -p 2222 admin@192.168.10.1
> ```
> **Teste immédiatement depuis une seconde session** avant de fermer celle-ci.

**Étape 6 — Fermer l'administration sur le WAN**

```
FGT-01 # config system interface
FGT-01 (interface) # edit port1
FGT-01 (port1) # set allowaccess ping
FGT-01 (port1) # next
FGT-01 (interface) # end
```

Vérifie que tu es toujours joignable **depuis le LAN** :

```bash
user@pc-lan:~$ ssh -p 2222 admin@192.168.10.1
```

**Étape 7 — La bannière**

```
FGT-01 # config system global
FGT-01 (global) # set pre-login-banner enable
FGT-01 (global) # end

FGT-01 # config system replacemsg admin "pre_admin-disclaimer-text"
FGT-01 (pre_admin-discl~t) # set buffer "ACCES RESERVE AUX PERSONNES AUTORISEES."
FGT-01 (pre_admin-discl~t) # next
FGT-01 # end
```

> 🧠 **Note la forme de la commande** : le nom du message est sur la ligne `config`, pas sur un `edit`. `config system replacemsg <groupe> <message>` ouvre directement l'objet — c'est une des rares tables de FortiOS qui se comporte ainsi, et `show` te la rendra sous la même forme.

Déconnecte-toi et reconnecte-toi : la bannière s'affiche avant l'invite.

Le pendant existe pour l'après-connexion, et le message porte alors l'autre nom :

```
FGT-01 # config system global
FGT-01 (global) # set post-login-banner enable
FGT-01 (global) # end

FGT-01 # config system replacemsg admin "post_admin-disclaimer-text"
FGT-01 (post_admin-disc~t) # set buffer "Session journalisee."
FGT-01 (post_admin-disc~t) # next
FGT-01 # end
```

**Le drapeau et le texte sont deux réglages distincts** : le drapeau sans texte n'affiche rien, et le texte sans le drapeau non plus. C'est l'erreur la plus fréquente sur cette commande.

**Étape 8 — Le suivi en Git**

Sur ta machine :

```bash
user@pc-lan:~$ mkdir -p ~/config-fortigate && cd ~/config-fortigate
user@pc-lan:~$ git init
user@pc-lan:~$ cat > sauvegarde.sh <<'SCRIPT'
#!/bin/bash
FGT=192.168.10.1
PORT=2222
USER=admin
ssh -p $PORT $USER@$FGT "show" > fgt-01.conf
git add fgt-01.conf
git commit -m "Configuration du $(date +%Y-%m-%d\ %H:%M)" || echo "Aucun changement"
SCRIPT
user@pc-lan:~$ chmod +x sauvegarde.sh
user@pc-lan:~$ ./sauvegarde.sh
```

Fais une modification sur le pare-feu, relance le script, puis :

```bash
user@pc-lan:~$ git log --oneline
user@pc-lan:~$ git diff HEAD~1
```

**Tu vois exactement ce qui a changé.** C'est le §25.1 en pratique, et c'est ce qui te sauvera lors d'un incident après modification.

**Étape 9 — Vérifier l'état général**

```
FGT-01 # get system status
FGT-01 # diagnose autoupdate versions
FGT-01 # get system performance status
FGT-01 # show system global
```

**Étape 10 — Sauvegarder l'état durci**

```
FGT-01 # execute backup config tftp apres-durcissement.conf 192.168.10.50 MotDePasseSauvegarde2026
```

---

**✅ Résultat attendu**

- La sauvegarde chiffrée porte l'en-tête `#FGTCONFIG-ENCRYPTED-AES256-GCM` et rien de lisible ; la non chiffrée révèle toute la configuration et les secrets en `ENC …`
- La restauration refuse sans le mot de passe, et refuse avec le mauvais
- Un mot de passe faible est refusé, et le refus nomme la règle manquante
- L'administration écoute sur les nouveaux ports
- Le WAN n'accepte plus que le ping
- La bannière s'affiche avant l'invite, et celle d'après-connexion après
- `git diff` montre les changements de configuration

---

**🧠 Ce que tu viens d'apprendre**

1. **Une sauvegarde en clair est un fichier de secrets**, et tu l'as vérifié de tes yeux. `ENC` n'est pas un chiffrement : c'est un encodage à clé statique publiée (CVE-2019-6693).
2. **La restauration écrase tout** et redémarre. Ce n'est pas une fusion.
3. **On lit les notes de version avant de mettre à jour** — le §2.6 en est la preuve.
4. **Le durcissement se teste depuis une seconde session**, toujours.
5. **Git donne l'historique de configuration** qu'aucune sauvegarde périodique ne remplace.
6. **Un pare-feu à jour mal configuré vaut mieux qu'un pare-feu parfait en version vulnérable.**

---

## 26. Les erreurs classiques

Voici les pièges qui font perdre le plus de temps. Certains, tu les as déjà rencontrés dans les TP — c'était volontaire. Les autres t'attendent.

Chaque erreur suit le même format : **symptôme**, **cause**, **vérification**, **correction**.

---

### Erreur #1 — La règle est écrite, et elle ne s'applique pas

**Symptôme** : tu as créé une politique qui autorise le trafic, et il est quand même refusé.

**Cause n°1 — Une règle plus large est au-dessus.** Première correspondance gagne (§9.2), et l'identifiant n'est pas la position.

**Vérification :**
```
FGT-01 # show firewall policy | grep -e "edit " -e "set name"
FGT-01 # diagnose debug flow filter addr <destination>
FGT-01 # diagnose debug flow trace start 10
FGT-01 # diagnose debug enable
```

Si tu lis `Denied by forward policy check (policy 0)` → **aucune** règle ne correspond, il en manque une.
Si tu lis `Denied by forward policy check (policy N)` → la règle N refuse, va la voir.
Si tu lis `Allowed by Policy-N` alors que ça ne marche pas → **le problème n'est pas le pare-feu**.

**Cause n°2 — Un critère ne correspond pas.** L'interface, le service, l'horaire, ou un objet dont le contenu a changé.

**Correction :**
```
FGT-01 # config firewall policy
FGT-01 (policy) # move <ta-regle> before <la-regle-large>
FGT-01 (policy) # end
```

---

### Erreur #2 — Le changement de règle ne produit aucun effet

**Symptôme** : tu modifies une politique, et le comportement reste identique.

**Cause** : les sessions **déjà établies** ne repassent pas par l'évaluation (§11.3 ④).

**Vérification :**
```
FGT-01 # diagnose sys session filter dst <destination>
FGT-01 # diagnose sys session list
```

**Correction :**
```
FGT-01 # diagnose sys session filter dst <destination>
FGT-01 # diagnose sys session clear
```

> 🚨 **Toujours poser le filtre avant.** Un `session clear` sans filtre coupe **toutes** les connexions de tous les utilisateurs.

---

### Erreur #3 — Le VIP ne fonctionne pas

**Symptôme** : le serveur publié est injoignable depuis l'extérieur.

**Cause n°1 — La destination de la politique est l'adresse interne** au lieu du VIP (§10.5).

**Cause n°2 — `set nat enable` sur la politique de publication.** Le serveur voit alors toutes les connexions venir du pare-feu.

**Cause n°3 — Le `mappedip` pointe vers une adresse inexistante.**

**Vérification :**
```
FGT-01 # show firewall vip <nom>
FGT-01 # show firewall policy <id>
FGT-01 # execute ping <mappedip>
FGT-01 # diagnose debug flow filter addr <extip>
```

**Correction :**
```
FGT-01 # config firewall policy
FGT-01 (policy) # edit <id>
FGT-01 (id) # set dstaddr "<nom-du-VIP>"
FGT-01 (id) # set nat disable
FGT-01 (id) # next
FGT-01 (policy) # end
```

---

### Erreur #4 — `set` a effacé la moitié de la configuration

**Symptôme** : tu ajoutes une valeur à un attribut de liste, et les autres ont disparu. Parfois, tu perds ton accès.

**Cause** : `set` **remplace** la liste entière (§5.9). `set allowaccess ssh` sur une interface qui avait `ping https ssh` ne laisse que `ssh`.

**Vérification :**
```
FGT-01 # show system interface <nom>
```

**Correction** : énumère **toujours** la liste complète voulue.
```
FGT-01 # config system interface
FGT-01 (interface) # edit port2
FGT-01 (port2) # set allowaccess ping https ssh
FGT-01 (port2) # next
FGT-01 (interface) # end
```

Les attributs concernés : `allowaccess`, `srcaddr`, `dstaddr`, `service`, `member`, `srcintf`, `dstintf`, `groups`.

---

### Erreur #5 — Le tunnel IPsec « est up » et ne transporte rien

**Symptôme** : la GUI affiche le tunnel comme actif, aucun trafic ne passe.

**Cause** : la phase 1 est montée, la phase 2 non. Les sélecteurs ne sont pas le miroir exact (§18.5).

**Vérification :**
```
FGT-01 # get vpn ipsec tunnel summary
```
```
'VPN-Lyon' ... selectors(total,up): 1/0     ← le 0 est le symptôme
```

**Correction** : vérifie que `src-subnet` et `dst-subnet` sont **inversés** entre les deux sites.
```
FGT-01 # show vpn ipsec phase2-interface
```

---

### Erreur #6 — Le profil de sécurité ne bloque rien

**Symptôme** : tu as configuré un antivirus ou un filtrage web, il est attaché, et rien n'est bloqué.

**Cause n°1 — `utm-status` n'est pas activé** (§13, TP 11).
**Cause n°2 — Le mode du profil ne correspond pas à celui de la politique** (flow/proxy).
**Cause n°3 — En HTTPS, il faut l'inspection SSL** (§16).
**Cause n°4 — Sans abonnement FortiGuard, la base est figée** (§2.7).

**Vérification :**
```
FGT-01 # show firewall policy <id> | grep -e utm -e profile -e inspection
FGT-01 # diagnose autoupdate versions
```

**Correction :**
```
FGT-01 # config firewall policy
FGT-01 (policy) # edit <id>
FGT-01 (id) # set utm-status enable
FGT-01 (id) # set inspection-mode flow
FGT-01 (id) # set ssl-ssh-profile "certificate-inspection"
FGT-01 (id) # next
FGT-01 (policy) # end
```

---

### Erreur #7 — Je me suis enfermé dehors

**Symptôme** : plus d'accès à l'administration.

**Causes classiques** :
- `set trusthost` posé sur son propre compte depuis une adresse non listée (§4.4) ;
- `set allowaccess` réécrit sans le protocole qu'on utilisait (§5.9) ;
- `set status down` sur l'interface d'administration ;
- une local-in policy trop stricte (§11.5) ;
- un changement de port d'administration non testé (§25.4).

**Correction** : la **console** de l'hyperviseur ou le port console physique. Ils ne sont filtrés par aucun de ces mécanismes.

> 💡 **La prévention vaut mieux** : garde **toujours** une seconde session ouverte quand tu touches à l'accès, et teste depuis cette seconde session **avant** de fermer la première. C'est un réflexe qui s'acquiert après s'être enfermé dehors une fois — autant l'acquérir sans y passer.

---

### Erreur #8 — L'objet FQDN ne correspond plus à rien

**Symptôme** : une règle utilisant un nom de domaine a cessé de fonctionner, sans qu'on ait rien changé.

**Cause** : le DNS du pare-feu ne répond plus, donc l'objet est **vide** (§8.4).

**Vérification :**
```
FGT-01 # diagnose firewall fqdn list
FGT-01 # show system dns
FGT-01 # execute ping <un-nom-de-domaine>
```

**Correction** : réparer le DNS du pare-feu. Et pour du **blocage**, utiliser le filtrage web plutôt qu'un FQDN.

---

### Erreur #9 — Le pare-feu répond au ping depuis Internet malgré la règle qui l'interdit

**Symptôme** : une politique refuse tout depuis le WAN, et le pare-feu répond quand même.

**Cause** : ce trafic est **local-in** (§11.5). Il ne traverse rien, il est destiné au pare-feu. Il est gouverné par `allowaccess`, pas par tes politiques.

**Vérification :**
```
FGT-01 # show system interface port1 | grep allowaccess
```

**Correction :**
```
FGT-01 # config system interface
FGT-01 (interface) # edit port1
FGT-01 (port1) # set allowaccess
FGT-01 (port1) # next
FGT-01 (interface) # end
```

---

### Erreur #10 — `service ALL` partout

**Symptôme** : aucun. C'est ce qui la rend dangereuse.

**Cause** : on met `ALL` pour tester, ça marche, et on ne revient jamais le restreindre.

**Vérification :**
```
FGT-01 # show firewall policy | grep -B8 'set service "ALL"'
```

**Correction** : restreindre au strict nécessaire. Pour savoir **quels** services sont réellement utilisés, la vue FortiView Applications ou les journaux te le disent (§23) — tu restreins alors sur des faits et non sur des suppositions.

---

### Erreur #11 — Le SD-WAN refuse de se configurer

**Symptôme** : impossible d'ajouter une interface comme membre.

**Cause** : l'interface est encore référencée dans une politique ou une route statique (§21.4).

**Vérification :**
```
FGT-01 # diagnose sys checkused system.interface.name port1
```

**Correction** : modifier toutes les références pour qu'elles citent la **zone** SD-WAN, puis ajouter le membre.

---

### Erreur #12 — Le cluster HA ne se forme pas

**Symptôme** : les deux équipements restent indépendants.

**Causes** :
- versions de FortiOS différentes ;
- modèles différents ;
- `group-name` ou `password` différents ;
- interfaces de battement de cœur non reliées ;
- interfaces de battement de cœur portant une configuration IP.

**Vérification :**
```
FGT-01 # get system ha status
FGT-01 # diagnose sys ha status
FGT-01 # get system status | grep Version
```

---

### Erreur #13 — Les journaux ne montrent rien

**Symptôme** : tu cherches un événement, tu ne trouves rien.

**Causes** :
- mauvaise **catégorie** (§23.1) — un refus de politique est en `0`, un blocage web en `1` ;
- un **filtre persistant** d'une recherche précédente ;
- `logtraffic` désactivé sur la politique ;
- les journaux étaient en mémoire et le pare-feu a redémarré.

**Correction :**
```
FGT-01 # execute log filter reset
FGT-01 # execute log filter category 0
FGT-01 # execute log display
```

---

### Erreur #14 — Tout est lent, sans erreur

**Symptôme** : le réseau fonctionne mais tout traîne, et rien n'est signalé.

**Cause n°1 — Le conserve mode** (§23.6). L'inspection est arrêtée, ou le trafic est ralenti.
**Cause n°2 — L'inspection profonde sur un équipement sous-dimensionné.**
**Cause n°3 — Trop de journalisation** sur un petit boîtier.

**Vérification :**
```
FGT-01 # get system performance status
FGT-01 # diagnose hardware sysinfo conserve
FGT-01 # diagnose sys top 5 20
```

---

### Erreur #15 — On a mis à jour, et les télétravailleurs sont dehors

**Symptôme** : après une montée en 7.6.3, plus personne ne se connecte en VPN.

**Cause** : le SSL VPN en mode tunnel est **retiré** (§2.6, §19.1).

**Correction** : migrer vers IPsec dial-up — ce qui aurait dû être fait **avant** la mise à jour.

> 🧠 **La leçon générale** : lire les notes de version n'est pas une formalité. C'est là que sont annoncés les changements qui cassent, et ils sont annoncés à l'avance.

---

### 26.1 La liste de contrôle avant de dire « ça ne marche pas »

Avant d'appeler quelqu'un ou d'ouvrir un ticket, passe ces huit points :

- [ ] L'interface est-elle `up`, avec une adresse ? → `get system interface physical`
- [ ] Y a-t-il une route ? → `get router info routing-table all`
- [ ] Le paquet arrive-t-il ? → `diagnose sniffer packet`
- [ ] Que décide le pare-feu ? → `diagnose debug flow`
- [ ] Quelle politique correspond ? → `diagnose sys session list`
- [ ] Le NAT s'applique-t-il ? → `hook=pre` / `hook=post`
- [ ] Les sessions ont-elles été vidées après le changement ?
- [ ] Les journaux disent-ils quelque chose ? → `execute log display`

**Huit questions.** Si tu peux répondre aux huit, tu sais où est le problème — ou tu sais qu'il n'est pas sur le pare-feu, ce qui est une réponse tout aussi utile.

---

## 27. Aide-mémoire : toutes les commandes

À imprimer, à garder ouvert, à consulter sans honte. Personne ne retient tout ça.

### 27.1 La grammaire CLI

```
config <table>                   Entrer dans une table
    edit <objet>                 Créer ou modifier un objet
        set <attribut> <valeur>  Régler un attribut
        unset <attribut>         Revenir à la valeur par défaut
        get                      Valeurs effectives de l'objet
        show                     Configuration de l'objet
    next                         Valider l'objet, rester dans la table
    delete <objet>               Supprimer
    clone <a> to <b>             Dupliquer
    rename <a> to <b>            Renommer
    move <a> after|before <b>    Réordonner
    purge                        🚨 Tout supprimer
end                              Valider et sortir
abort                            Sortir en annulant
?                                Aide contextuelle, partout
```

### 27.2 Les cinq familles

| Verbe | Rôle |
|---|---|
| `config` | Modifier la configuration |
| `get` | Lire un **état** |
| `show` | Afficher la **configuration** |
| `execute` | Action immédiate |
| `diagnose` | Diagnostic approfondi |

### 27.3 Système

```
get system status                          Version, modèle, mode, HA
get system performance status              Processeur, mémoire, sessions
get system performance top 5 20            Processus les plus gourmands
diagnose sys top 5 20                      Idem, plus détaillé
get system session status                  Nombre de sessions
diagnose hardware sysinfo memory           Mémoire détaillée
diagnose hardware sysinfo conserve         🚨 Conserve mode
diagnose sys logdisk usage                 Espace de journaux
execute date                               Heure
execute time                               Voir/régler l'heure
diagnose sys ntp status                    Synchronisation NTP
execute reboot                             Redémarrer
execute shutdown                           Éteindre
execute factoryreset                       🚨 Remise à zéro
```

### 27.4 Interfaces et routage

```
get system interface physical              État des interfaces
diagnose ip address list                   Adresses IP
show system interface <nom>                Configuration d'une interface
get router info routing-table all          Table de routage (FIB)
get router info routing-table database     Base de routage (RIB)
get router info routing-table static       Routes statiques
diagnose firewall proute list              Routes par politique
diagnose sys link-monitor status           État du suivi de lien
get router info ospf neighbor              Voisins OSPF
get router info ospf database brief        Base OSPF
get router info bgp summary                Résumé BGP
get router info bgp neighbors <ip>         Détail d'un voisin BGP
```

### 27.5 Politiques et objets

```
show firewall policy                       Toutes les politiques
show firewall policy <id>                  Une politique
show firewall policy | grep -e "edit " -e "set name"    ⭐ L'ordre réel
get firewall policy                        Compteurs par politique
show firewall address                      Objets adresse
show firewall addrgrp                      Groupes d'adresses
show firewall service custom               Services personnalisés
show firewall vip                          VIP
diagnose firewall vip list                 VIP actifs
show firewall ippool                       IP Pools
diagnose firewall ippool-all stats         Utilisation des pools
diagnose firewall fqdn list                ⭐ Résolution des objets FQDN
diagnose sys checkused <table> <objet>     Qui référence cet objet
```

### 27.6 Sessions et NAT

```
diagnose sys session filter clear          Effacer le filtre
diagnose sys session filter dst <ip>       Filtrer par destination
diagnose sys session filter src <ip>       Filtrer par source
diagnose sys session filter proto 6        Filtrer par protocole
diagnose sys session filter                Voir le filtre courant
diagnose sys session list                  ⭐ Lister les sessions
diagnose sys session stat                  Statistiques
diagnose sys session clear                 🚨 Vider (POSE UN FILTRE AVANT)
```

**Lire une session :**

| Champ | Signification |
|---|---|
| `proto=6` | 1 = ICMP, 6 = TCP, 17 = UDP |
| `policy_id=N` | ⭐ La politique qui a autorisé |
| `hook=pre ... act=dnat` | NAT destination |
| `hook=post ... act=snat` | NAT source |
| `org=` / `reply=` | Octets aller / retour |

### 27.7 Diagnostic

```
diagnose debug reset                            Repartir propre
diagnose debug flow filter clear                Effacer le filtre
diagnose debug flow filter addr <ip>            Filtrer
diagnose debug flow filter saddr <ip>           Source uniquement
diagnose debug flow filter daddr <ip>           Destination uniquement
diagnose debug flow filter proto <n>            Protocole
diagnose debug flow filter port <n>             Port
diagnose debug flow show function-name enable   Afficher la fonction
diagnose debug flow trace start <n>             Tracer n paquets
diagnose debug enable                           ⭐ Démarrer
diagnose debug disable                          🚨 ARRÊTER
```

```
diagnose sniffer packet <if> '<bpf>' <niveau> <nb> [a]
```

| Niveau | Contenu |
|---|---|
| 1 | En-tête IP |
| 2 | + données |
| 3 | + en-tête Ethernet |
| **4** | ⭐ En-tête + **nom de l'interface** |
| 5 | Niveau 4 + données |
| 6 | Tout |

```
diagnose sniffer packet any 'host 10.0.0.5' 4 20
diagnose sniffer packet port1 'tcp port 443' 4 50
diagnose sniffer packet any 'icmp' 4 20
diagnose sniffer packet any 'udp port 500 or udp port 4500' 4 30
```

**Messages de `debug flow` :**

| Message | Signification |
|---|---|
| `Allowed by Policy-N` | Autorisé par N |
| `Denied by ... (policy 0)` | ⭐ **Aucune règle ne correspond** |
| `Denied by ... (policy N)` | La règle N refuse |
| `no route to destination` | Pas de route |
| `reverse path check fail` | RPF |
| `iprope_in_check() check failed` | Local-in refusé |

### 27.8 Journaux

```
execute log filter reset                   ⭐ TOUJOURS commencer par là
execute log filter category 0              Trafic
execute log filter category 1              Événements
execute log filter category 3              Filtrage web
execute log filter category ?              ⭐ La liste réelle de TA machine
execute log filter field srcip <ip>        Filtrer par source
execute log filter field action deny       Filtrer par action
execute log filter field policyid <n>      Filtrer par politique
execute log filter field user <nom>        Filtrer par utilisateur
execute log filter view-lines 20           Nombre de lignes
execute log display                        Afficher
```

### 27.9 VPN

```
get vpn ipsec tunnel summary               ⭐ selectors(total,up)
diagnose vpn ike gateway list              Passerelles IKE
diagnose vpn tunnel list                   Détail des tunnels
diagnose vpn ike gateway clear name <nom>  Forcer une renégociation
diagnose vpn ike log filter clear          Effacer le filtre IKE
diagnose debug application ike -1          Débogage IKE
```

### 27.10 Utilisateurs

```
diagnose firewall auth list                ⭐ Utilisateurs authentifiés
diagnose firewall auth clear               Déconnecter tout le monde
diagnose debug authd fsso list             Table FSSO
diagnose test authserver ldap <srv> <user> <pass>      Tester LDAP
diagnose test authserver radius <srv> pap <user> <pass>  Tester RADIUS
```

### 27.11 Sécurité et FortiGuard

```
diagnose autoupdate versions               ⭐ Version des bases
get system fortiguard-service status       État des services
execute update-now                         Forcer une mise à jour
diagnose test application dnsproxy 3       Diagnostic DNS
diagnose application-control list          Applications reconnues
```

### 27.12 HA et SD-WAN

```
get system ha status                       ⭐ État du cluster
diagnose sys ha status                     Détail
diagnose sys ha checksum cluster           ⭐ Synchronisation
execute ha manage <index> admin            Se connecter à l'autre membre
execute ha synchronize start               Forcer la synchronisation
diagnose sys ha reset-uptime               Forcer une bascule

diagnose sys sdwan member                  Membres
diagnose sys sdwan health-check            ⭐ Qualité mesurée (sla_map)
diagnose sys sdwan service                 Règles SD-WAN
```

### 27.13 DHCP et DNS

```
execute dhcp lease-list                    Baux DHCP
execute dhcp lease-list <interface>        Baux d'une interface
execute dhcp lease-clear <ip>              Libérer un bail
show system dns                            DNS du pare-feu
show system dns-database                   Zones locales
```

### 27.14 Sauvegarde

```
execute backup config tftp <fichier> <srv> [motdepasse]
execute restore config tftp <fichier> <srv>
execute restore image tftp <image> <srv>
execute tac report                         Paquet pour le support
```

### 27.15 Les dix commandes à connaître par cœur

Si tu ne devais en retenir que dix :

```
1.  get system status
2.  get system interface physical
3.  get router info routing-table all
4.  show firewall policy | grep -e "edit " -e "set name"
5.  diagnose sys session filter dst <ip> && diagnose sys session list
6.  diagnose debug flow filter addr <ip> && diagnose debug flow trace start 20 && diagnose debug enable
7.  diagnose debug disable && diagnose debug reset
8.  diagnose sniffer packet any 'host <ip>' 4 20
9.  execute log filter reset && execute log filter category 0 && execute log display
10. get system performance status
```

### 27.16 Correspondance Cisco → FortiGate

Pour qui vient du monde Cisco :

| Cisco IOS | FortiOS |
|---|---|
| `show running-config` | `show` |
| `show ip interface brief` | `get system interface physical` |
| `show ip route` | `get router info routing-table all` |
| `show access-lists` | `show firewall policy` |
| `configure terminal` | `config <table>` |
| `write memory` | *(implicite : `end` valide)* |
| `no shutdown` | `set status up` |
| `show version` | `get system status` |
| `ping` | `execute ping` |
| `traceroute` | `execute traceroute` |
| `debug ip packet` | `diagnose debug flow` |
| `show ip ospf neighbor` | `get router info ospf neighbor` |
| `copy running-config tftp` | `execute backup config tftp` |
| `reload` | `execute reboot` |

> 💡 **La différence la plus déroutante** : sur IOS, on écrit `write memory` pour rendre la configuration persistante. **Sur FortiOS, le `end` enregistre immédiatement et définitivement.** Il n'y a pas de configuration « en cours » distincte de la configuration démarrée.
>
> C'est plus simple, et c'est plus dangereux : il n'y a pas de filet du type « je redémarre sans sauvegarder et tout revient ». D'où l'importance de `abort` (§5.3) et des sauvegardes (§25.1).

---

## 28. Conclusion et pour aller plus loin

### 28.1 Ce que tu sais faire maintenant

Si tu as fait les 24 TP, tu n'as pas « lu un tutoriel ». Tu as monté une infrastructure complète et tu l'as cassée assez souvent pour savoir la réparer.

Regarde le chemin :

| Partie | Ce que tu as construit |
|---|---|
| **I** | Un laboratoire avec un routeur Cisco et un pare-feu |
| **II** | Interfaces, routage, et la grammaire CLI en réflexe |
| **III** | Politiques, NAT, publication d'un serveur, et l'ordre de traitement |
| **IV** | DHCP, DNS, une résolution locale qui marche |
| **V** | Profils de sécurité, inspection TLS, **et la preuve qu'un routeur ne suffit pas** |
| **VI** | Des règles qui parlent de personnes |
| **VII** | Un tunnel site-à-site et un accès télétravailleur |
| **VIII** | Routage dynamique, SD-WAN, cluster HA |
| **IX** | Journaux, méthode de dépannage, durcissement |

Et surtout, **tu sais diagnostiquer**. C'est ce qui distingue quelqu'un qui a suivi une formation de quelqu'un qui peut travailler.

### 28.2 Les dix idées à ne pas oublier

Si tout le reste s'efface avec le temps, garde ces dix-là :

**1. Une politique n'autorise que le sens de l'OUVERTURE.** Le retour est géré par la table de sessions. Écrire la règle inverse est un trou de sécurité, pas une précaution.

**2. Première correspondance gagne.** Du plus spécifique au plus général, et l'identifiant n'est pas la position.

**3. `policy 0` veut dire qu'il MANQUE une règle**, pas qu'une règle bloque.

**4. DNAT avant les politiques, SNAT après.** D'où le VIP en destination, l'adresse privée en source.

**5. `set` sur une liste REMPLACE.** Énumère toujours la liste complète.

**6. Le routage vient avant le filtrage.** Pas de route, pas de paquet à filtrer.

**7. Les sessions établies survivent aux changements de règles.** D'où `session clear`, avec un filtre.

**8. Sans inspection TLS, l'antivirus et l'IPS ne voient presque rien.** Et l'inspection TLS a un coût technique, humain et juridique.

**9. Un VPN sans second facteur est une porte d'entrée.**

**10. Toujours une seconde session ouverte quand tu touches à l'accès.**

### 28.3 La réponse à la question qui a motivé la section 15

Tu peux maintenant y répondre avec tes propres mesures :

> Un routeur avec des ACL sait dire **d'où vient** un paquet et **où il va**. Il couvre environ 30 % du besoin de sécurité d'une PME, et ce n'est pas rien — c'est même une bonne première ligne, à coût nul en performance.
>
> Ce qu'il ne sait pas faire, ce sont précisément les menaces d'aujourd'hui : une application qui se camoufle sur le port 443, un fichier malveillant dans un téléchargement, un utilisateur qui n'est pas celui que son adresse IP prétend.
>
> On garde donc le routeur, et on ajoute le pare-feu. Chacun à son étage.

Cette réponse, tu l'as **mesurée** au TP 13 et au TP 14. C'est la différence entre réciter un argumentaire et défendre une position.

### 28.4 Ce que ce tutoriel n'a pas couvert

Par honnêteté, voici ce qui reste :

| Sujet | Pourquoi c'est hors périmètre |
|---|---|
| **VDOM** | Découper un pare-feu en pare-feux virtuels — sujet entier, utile surtout en hébergement |
| **Security Fabric complète** | FortiSwitch, FortiAP, FortiAnalyzer, FortiManager |
| **ZTNA** | L'accès conditionnel par application, qui remplace progressivement le VPN |
| **SD-WAN avancé** | Overlay ADVPN, orchestration multi-sites |
| **Traffic shaping** | Garantir de la bande passante à la voix |
| **DLP** | Empêcher la fuite de données |
| **Automatisation** | API REST, Ansible, Terraform |
| **FortiManager** | Administrer des centaines de pare-feux |
| **IPv6** | Tout ce qu'on a fait a un équivalent v6 |

> 💡 **Le suivant à apprendre, selon où tu vas** :
> - Tu administres **un site** → traffic shaping, puis IPv6
> - Tu administres **plusieurs sites** → FortiManager et FortiAnalyzer
> - Tu vas vers la **sécurité** → ZTNA, DLP, et l'analyse de journaux
> - Tu vas vers l'**infrastructure** → VDOM, ADVPN, automatisation

### 28.5 Pour continuer

**Les sources qui valent la peine :**

| Source | Ce qu'on y trouve |
|---|---|
| **Fortinet Document Library** (`docs.fortinet.com`) | ⭐ La référence. Guides d'administration, référence CLI, notes de version |
| **Fortinet Community** | Les *Technical Tips*, souvent plus utiles que la doc officielle |
| **Fortinet Training Institute** | Formations gratuites et labs, jusqu'à la certification |
| **Notes de version** | ⭐ À lire avant chaque mise à jour. Sans exception |

**Les certifications** :

| Niveau | Nom | Contenu |
|---|---|---|
| Associate | **FCA** | Les bases de la cybersécurité |
| Professional | **FCP** (ex-NSE 4) | ⭐ L'administration FortiGate — ce tutoriel en couvre une bonne part |
| Solution Specialist | **FCSS** | Spécialisations : SD-WAN, sécurité réseau, opérations |
| Expert | **FCX** (ex-NSE 8) | Examen pratique, très exigeant |

> 💡 **Astuce** : si tu vises le FCP, refais les TP de ce tutoriel **sans regarder les commandes**. L'examen teste la compréhension du comportement — l'ordre des politiques, le cheminement d'un paquet, ce que fait le NAT — bien plus que la mémorisation de syntaxe.

### 28.6 Trois conseils pour la suite

**1. Garde ton laboratoire.** Ne le démonte pas. La prochaine fois que tu devras faire quelque chose en production, essaie-le d'abord là. C'est l'écart entre un administrateur serein et un administrateur qui croise les doigts.

**2. Documente ce que tu fais.** Le champ `comments` d'une politique, le `description` d'une interface, un dépôt Git de configurations (§25.1). Ton successeur te remerciera, et ton toi-même dans six mois aussi.

**3. Lis les journaux même quand tout va bien.** C'est comme ça qu'on apprend à quoi ressemble la normale — et donc à repérer ce qui ne l'est pas. Un administrateur qui ne consulte ses journaux qu'en cas de panne ne sait pas ce qu'il regarde.

### 28.7 Un dernier mot

Un pare-feu n'est pas un produit qu'on installe. C'est une **politique de sécurité** qu'on écrit, qu'on mesure et qu'on révise.

Les commandes de ce document changeront — FortiOS 9 arrivera, des fonctions disparaîtront comme le SSL VPN, d'autres apparaîtront. Ce qui ne changera pas, c'est la façon de raisonner : diviser un problème en deux, mesurer plutôt que supposer, et savoir dire « ce n'est pas là » avec une preuve.

C'est ce que tu as vraiment appris ici. 🛡️

---

> **Ce tutoriel fait partie du projet Ubuntu Sandbox.**
> Il est écrit dans le même esprit que `docs/tutoriel-ospf.md` : partir de zéro, expliquer le *pourquoi* avant le *comment*, et ne jamais affirmer sans montrer.
>
> Une erreur, une imprécision, une commande qui a changé de version ? Ouvre une issue ou une pull request. Un tutoriel qui ne se corrige pas devient faux avec le temps — c'est exactement ce qu'on lui reproche quand on le trouve périmé sur Internet.

---

*Bon courage, et surtout : casse des choses dans ton laboratoire. C'est là que ça s'apprend.* 🚀

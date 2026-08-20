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
You are forced to change your password. Please input a new password.
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

Tu dois voir `port1` en `192.168.100.99`. C'est par là que tu accèderas à l'interface web.

---

**✅ Résultat attendu**

- R1 pingue Internet, et le pare-feu pingue R1 ✅
- `execute ping 8.8.8.8` depuis le pare-feu fonctionne ✅
- Depuis un navigateur d'une machine du réseau de transit, `http://192.168.100.99` affiche la page de connexion FortiGate. Connecte-toi avec `admin` et ton nouveau mot de passe.

> ⚠️ Rappel du §3.2 : avec la licence d'évaluation, utilise bien **`http://`** et non `https://`. C'est normal, ce n'est pas une erreur de ta part.

Tu devrais voir le tableau de bord, avec probablement un bandeau rouge signalant que la licence n'est pas enregistrée. C'est attendu — on s'en occupe au TP 2.

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

1. Va dans **Dashboard → Status**, widget **Licenses** (ou le bandeau d'avertissement)
2. Clique sur l'invitation à enregistrer la VM
3. Choisis **Evaluation License**
4. Saisis les identifiants de ton compte FortiCare gratuit
5. La licence est générée et appliquée automatiquement

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
FGT-01 # execute log filter category 1
FGT-01 # execute log filter field action "blocked"
FGT-01 # execute log display
```

Tu vois l'événement, avec l'URL, l'utilisateur, la politique et l'heure.

> 💡 **Astuce** : `category 1` correspond aux journaux **UTM**, `category 0` aux journaux de **trafic**. Cette distinction revient tout le temps :
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
FGT-01 # execute log filter category 1
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
```

Cette fois, **rien ne passe**. Vérifie pourquoi :

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
attaquant@ext:~$ sudo nmap -sA -p 1-1000 192.168.10.10
attaquant@ext:~$ sudo nmap -sS -p 1-1000 192.168.10.10
```

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

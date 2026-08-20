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
                               │
                          port1 (WAN)
                        DHCP ou 192.168.100.99/24
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

### 3.7 Le plan d'adressage

| Réseau | Sous-réseau | Rôle | Interface FortiGate |
|---|---|---|---|
| WAN | 192.168.100.0/24 | Simule Internet | `port1` — 192.168.100.99 |
| LAN | 192.168.10.0/24 | Postes utilisateurs | `port2` — 192.168.10.1 |
| DMZ | 192.168.20.0/24 | Serveurs publiés | `port3` — 192.168.20.1 |

| Machine | Adresse | Passerelle | Rôle |
|---|---|---|---|
| FGT-01 | voir ci-dessus | 192.168.100.1 | Le pare-feu |
| PC-LAN | 192.168.10.10/24 | 192.168.10.1 | Poste de test côté interne |
| SRV-DMZ | 192.168.20.10/24 | 192.168.20.1 | Serveur web de test |

> 🧠 **Comprendre : pourquoi une DMZ ?**
> **DMZ** signifie *zone démilitarisée*. C'est un troisième réseau, ni tout à fait dedans ni tout à fait dehors, où l'on place les serveurs **accessibles depuis Internet** : site web, serveur de messagerie, VPN.
>
> Pourquoi ne pas les mettre simplement dans le LAN ? Parce qu'un serveur exposé à Internet est un serveur qui **finira par être compromis** — c'est une question de temps, pas de compétence. La DMZ répond à la question « et après ? » : quand l'attaquant prend le contrôle du serveur web, il se retrouve dans un réseau d'où il **ne peut pas atteindre** les postes de travail ni la comptabilité, parce que le pare-feu l'en empêche.
>
> La DMZ ne protège pas le serveur. Elle protège **tout le reste** du serveur. C'est une nuance essentielle, et on la matérialisera concrètement au TP 9.

### 3.8 Les besoins matériels de ta machine

Sois réaliste avant de commencer :

| Ce que tu veux faire | RAM totale | Disque | Processeur |
|---|---|---|---|
| Sections 1 à 16 (1 FortiGate + 2 PC) | **8 Gio** | 40 Gio | 4 cœurs |
| Sections 17 à 18 (2 FortiGate, VPN) | **12 Gio** | 60 Gio | 4 cœurs |
| Sections 19 à 21 (3 FortiGate, HA) | **16 Gio** | 80 Gio | 6 cœurs |

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
- 4 Gio de RAM disponibles

---

**🔧 Manipulation**

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
FGT-01 (port1) # set mode dhcp
FGT-01 (port1) # set allowaccess ping http https ssh
FGT-01 (port1) # next
FGT-01 (interface) # end
```

Ligne par ligne, parce que c'est ta toute première configuration :

| Commande | Traduction en français |
|---|---|
| `config system interface` | « J'entre dans la table des interfaces » |
| `edit port1` | « Je veux modifier l'interface port1 » |
| `set mode dhcp` | « Prends ton adresse automatiquement » |
| `set allowaccess ping http https ssh` | « Autorise qu'on t'administre par ces protocoles, sur cette interface » |
| `next` | « J'ai fini avec port1, je reste dans la table » |
| `end` | « J'ai fini avec la table, applique » |

> 🚨 **Danger — `allowaccess` sur une interface WAN**
> Dans un laboratoire, autoriser l'administration sur `port1` est pratique. **En production, c'est une faute grave.** Cela expose l'interface d'administration de ton pare-feu à Internet entier, et les FortiGate exposés sont scannés en permanence.
>
> On corrigera ça proprement en section 24. Pour l'instant, tu es dans un réseau isolé, donc c'est acceptable — mais je veux que tu saches dès la première commande que c'en est une, plutôt que de le découvrir dans six mois.

**Étape 6 — Retrouver l'adresse obtenue**

```
FGT-01 # get system interface physical
```

ou, plus lisible :

```
FGT-01 # diagnose ip address list
```

Note l'adresse de `port1` : c'est par là que tu accèderas à l'interface web.

---

**✅ Résultat attendu**

Depuis un navigateur sur ta machine hôte, `http://<adresse-du-port1>` doit afficher la page de connexion FortiGate. Connecte-toi avec `admin` et ton nouveau mot de passe.

> ⚠️ Rappel du §3.2 : avec la licence d'évaluation, utilise bien **`http://`** et non `https://`. C'est normal, ce n'est pas une erreur de ta part.

Tu devrais voir le tableau de bord, avec probablement un bandeau rouge signalant que la licence n'est pas enregistrée. C'est attendu — on s'en occupe au TP 2.

---

**🧠 Ce que tu viens d'apprendre**

Beaucoup plus que « installer une VM », en réalité :

1. **La structure de la CLI FortiOS.** Tu viens d'utiliser `config` → `edit` → `set` → `next` → `end`. **Cette séquence est la même pour absolument tout dans FortiOS** : les politiques, les routes, les VPN, les utilisateurs. Tu l'as apprise une fois, tu la connais partout. C'est le sujet de toute la section 5.
2. **`get system status` est ton premier réflexe.** Sur n'importe quel FortiGate inconnu, c'est la première commande à taper : version, modèle, mode, HA, heure.
3. **`allowaccess` contrôle l'administration par interface.** C'est un paramètre de sécurité de première importance, et il se règle interface par interface.
4. **La numérotation des ports vient de l'hyperviseur**, pas de FortiOS. Un piège classique quand une VM se comporte bizarrement.

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

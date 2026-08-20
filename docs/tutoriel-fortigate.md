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

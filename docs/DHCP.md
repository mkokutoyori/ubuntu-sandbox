# Tutoriel DHCP - Simulateur Réseau

Bienvenue dans ce tutoriel interactif sur le protocole DHCP. Vous allez apprendre comment les ordinateurs obtiennent automatiquement leur adresse IP sur un réseau.

## Sommaire

1. [Introduction](#introduction)
2. [Scénario 1 : Votre premier réseau DHCP](#scénario-1--votre-premier-réseau-dhcp)
3. [Scénario 2 : Observer le processus DORA](#scénario-2--observer-le-processus-dora)
4. [Scénario 3 : Renouveler et libérer une adresse](#scénario-3--renouveler-et-libérer-une-adresse)
5. [Scénario 4 : Réserver une adresse IP](#scénario-4--réserver-une-adresse-ip)
6. [Scénario 5 : Dépannage DHCP](#scénario-5--dépannage-dhcp)
7. [Quiz de compréhension](#quiz-de-compréhension)

---

## Introduction

### Qu'est-ce que DHCP ?

Imaginez que vous arrivez dans un hôtel. Au lieu de choisir vous-même votre numéro de chambre, la réception vous en attribue un automatiquement. C'est exactement ce que fait DHCP pour les adresses IP !

**DHCP** (Dynamic Host Configuration Protocol) permet à un ordinateur d'obtenir automatiquement :
- Une adresse IP (son identité sur le réseau)
- Un masque de sous-réseau (la taille du réseau)
- Une passerelle par défaut (la sortie vers Internet)
- Des serveurs DNS (pour traduire les noms comme google.com en adresses IP)

### Pourquoi est-ce important ?

Sans DHCP, vous devriez configurer manuellement chaque appareil. Imaginez faire cela pour 100 ordinateurs dans une entreprise, ou pour tous les smartphones qui se connectent à un WiFi public !

---

## Scénario 1 : Votre premier réseau DHCP

### Objectif
Créer un réseau simple où un PC obtient automatiquement son adresse IP.

### Étape 1 : Construire le réseau

Dans le simulateur, créez le réseau suivant :

```
┌─────────────┐         ┌──────────┐         ┌─────────────┐
│   Routeur   │─────────│  Switch  │─────────│  PC Linux   │
│ 192.168.1.1 │  eth0   │          │  fa0/1  │   (DHCP)    │
└─────────────┘         └──────────┘         └─────────────┘
      │
   Serveur DHCP
   Pool: 192.168.1.100-200
```

1. Ajoutez un **Routeur** et nommez-le "Passerelle"
2. Ajoutez un **Switch** et nommez-le "Switch-LAN"
3. Ajoutez un **PC Linux** et nommez-le "Poste-1"
4. Connectez le routeur au switch (eth0 → fa0/1)
5. Connectez le PC au switch (eth0 → fa0/2)

### Étape 2 : Configurer le serveur DHCP sur le routeur

Ouvrez le terminal du routeur et entrez ces commandes :

```
Passerelle> enable
Passerelle# configure terminal
Passerelle(config)# interface eth0
Passerelle(config-if)# ip address 192.168.1.1 255.255.255.0
Passerelle(config-if)# exit
Passerelle(config)# ip dhcp pool MON-RESEAU
Passerelle(dhcp-config)# network 192.168.1.0 255.255.255.0
Passerelle(dhcp-config)# default-router 192.168.1.1
Passerelle(dhcp-config)# dns-server 8.8.8.8
Passerelle(dhcp-config)# end
```

**Que venons-nous de faire ?**
- Nous avons donné l'adresse 192.168.1.1 au routeur
- Nous avons créé un "pool" d'adresses disponibles (192.168.1.1 à 192.168.1.254)
- Nous avons défini la passerelle et le serveur DNS

### Étape 3 : Demander une adresse IP sur le PC

Ouvrez le terminal du PC Linux et tapez :

```bash
dhclient eth0
```

**Résultat attendu :**
```
Internet Systems Consortium DHCP Client 4.4.1
Listening on LPF/eth0/aa:bb:cc:dd:ee:ff
Sending on   LPF/eth0/aa:bb:cc:dd:ee:ff
DHCPDISCOVER on eth0 to 255.255.255.255 port 67 interval 3
DHCPOFFER of 192.168.1.100 from 192.168.1.1
DHCPREQUEST for 192.168.1.100 on eth0 to 255.255.255.255 port 67
DHCPACK of 192.168.1.100 from 192.168.1.1
bound to 192.168.1.100 -- renewal in 43200 seconds.
```

### Étape 4 : Vérifier la configuration

Sur le PC, tapez :
```bash
ip addr show eth0
```

Vous devriez voir l'adresse IP 192.168.1.100 attribuée automatiquement !

---

## Scénario 2 : Observer le processus DORA

### Objectif
Comprendre les 4 étapes du protocole DHCP en observant les messages échangés.

### Le processus DORA expliqué

DHCP utilise 4 messages, formant l'acronyme **DORA** :

```
     PC (Client)                              Routeur (Serveur)
          │                                         │
          │  ① DISCOVER ────────────────────────────>
          │     "Y a-t-il un serveur DHCP ici ?"    │
          │                                         │
          │  ② OFFER <──────────────────────────────
          │     "Oui ! Je te propose 192.168.1.100" │
          │                                         │
          │  ③ REQUEST ────────────────────────────>
          │     "D'accord, je prends cette adresse" │
          │                                         │
          │  ④ ACK <────────────────────────────────
          │     "Confirmé ! C'est la tienne."       │
          │                                         │
```

### Exercice pratique

1. **Ajoutez un second PC** à votre réseau (PC Windows cette fois)
2. **Ouvrez son terminal** et tapez :
   ```cmd
   ipconfig /renew
   ```
3. **Observez les messages** dans le journal du simulateur

**Questions à vous poser :**
- Quelle adresse IP a reçu le second PC ?
- Pourquoi est-elle différente de celle du premier PC ?

---

## Scénario 3 : Renouveler et libérer une adresse

### Objectif
Apprendre à gérer le "bail" DHCP (la durée de validité de l'adresse).

### Qu'est-ce qu'un bail DHCP ?

Une adresse IP n'est pas donnée pour toujours. Elle est "louée" pour une durée déterminée (le bail). Par défaut, notre serveur donne des baux de 24 heures.

### Libérer une adresse (Release)

Quand vous quittez un réseau, vous pouvez libérer votre adresse pour qu'elle soit disponible pour d'autres.

**Sur Linux :**
```bash
dhclient -r eth0
```

**Sur Windows :**
```cmd
ipconfig /release
```

**Résultat :**
```
Releasing DHCP lease for interface eth0
DHCPRELEASE on eth0 to 192.168.1.1 port 67
```

### Renouveler une adresse (Renew)

Pour prolonger votre bail avant qu'il n'expire :

**Sur Linux :**
```bash
dhclient eth0
```

**Sur Windows :**
```cmd
ipconfig /renew
```

### Exercice pratique

1. Sur le PC Linux, libérez l'adresse : `dhclient -r eth0`
2. Vérifiez que l'interface n'a plus d'IP : `ip addr show eth0`
3. Redemandez une adresse : `dhclient eth0`
4. Avez-vous obtenu la même adresse ou une différente ?

---

## Scénario 4 : Réserver une adresse IP

### Objectif
Attribuer toujours la même adresse IP à un appareil spécifique.

### Pourquoi réserver une adresse ?

Certains appareils ont besoin d'une adresse IP fixe :
- Imprimantes réseau (pour les retrouver facilement)
- Serveurs (pour que les autres machines sachent où les contacter)
- Caméras de surveillance

### Configuration de la réservation

Sur le routeur, nous allons réserver l'adresse 192.168.1.50 pour notre PC Linux.

D'abord, trouvez l'adresse MAC du PC. Sur le PC Linux :
```bash
ip link show eth0
```

Notez l'adresse MAC (exemple : `aa:bb:cc:11:22:33`)

Sur le routeur :
```
Passerelle# configure terminal
Passerelle(config)# ip dhcp pool RESERVATION-PC1
Passerelle(dhcp-config)# host 192.168.1.50 255.255.255.0
Passerelle(dhcp-config)# hardware-address aa:bb:cc:11:22:33
Passerelle(dhcp-config)# end
```

### Exercice pratique

1. Configurez une réservation pour votre PC
2. Libérez puis renouvelez l'adresse sur le PC
3. Vérifiez que le PC a bien reçu l'adresse réservée (192.168.1.50)

---

## Scénario 5 : Dépannage DHCP

### Objectif
Identifier et résoudre les problèmes DHCP courants.

### Problème 1 : Pas de réponse du serveur

**Symptôme sur Linux :**
```
DHCPDISCOVER on eth0 to 255.255.255.255 port 67 interval 3
DHCPDISCOVER on eth0 to 255.255.255.255 port 67 interval 6
No DHCPOFFERS received.
```

**Symptôme sur Windows :**
```
An error occurred while renewing interface Ethernet :
unable to connect to your DHCP server. Request has timed out.
```

**Causes possibles :**
- ❌ Le serveur DHCP n'est pas activé
- ❌ Le câble réseau est débranché
- ❌ Le PC et le serveur ne sont pas sur le même réseau

**Comment vérifier :**
1. Vérifiez les connexions dans le simulateur
2. Sur le routeur, tapez `show ip dhcp pool` pour voir si le DHCP est configuré

### Problème 2 : Adresse APIPA (169.254.x.x)

Si un PC Windows ne trouve pas de serveur DHCP, il s'attribue une adresse automatique commençant par 169.254.

**Sur Windows :**
```cmd
ipconfig
```
```
Ethernet adapter Ethernet:
   Autoconfiguration IPv4 Address. . : 169.254.45.123
```

**Solution :** Vérifiez que le serveur DHCP fonctionne et est accessible.

### Problème 3 : Pool d'adresses épuisé

Si tous les adresses du pool sont utilisées, les nouveaux appareils ne peuvent plus en obtenir.

**Sur le routeur, vérifiez les baux actifs :**
```
Passerelle# show ip dhcp binding
```

**Solutions :**
- Augmenter la plage d'adresses du pool
- Réduire la durée des baux
- Libérer les baux des appareils déconnectés

### Exercice de dépannage

1. Débranchez le câble entre le switch et le routeur (dans le simulateur)
2. Essayez d'obtenir une adresse IP sur le PC
3. Observez le message d'erreur
4. Rebranchez le câble et réessayez

---

## Quiz de compréhension

Testez vos connaissances sur DHCP !

### Question 1
Que signifie l'acronyme DORA ?
<details>
<summary>Voir la réponse</summary>
<b>D</b>iscover, <b>O</b>ffer, <b>R</b>equest, <b>A</b>cknowledge - les 4 messages du protocole DHCP.
</details>

### Question 2
Pourquoi un PC envoie-t-il un DISCOVER en broadcast (à tout le monde) ?
<details>
<summary>Voir la réponse</summary>
Parce qu'au départ, le PC ne connaît pas l'adresse du serveur DHCP. Il doit donc envoyer sa demande à tous les appareils du réseau.
</details>

### Question 3
Quelle est la différence entre `ipconfig /release` et `ipconfig /renew` ?
<details>
<summary>Voir la réponse</summary>
<code>/release</code> libère (rend) l'adresse IP au serveur DHCP.
<code>/renew</code> demande une nouvelle adresse IP ou prolonge le bail actuel.
</details>

### Question 4
Un technicien veut que l'imprimante ait toujours l'adresse 192.168.1.10. Quelle fonctionnalité DHCP doit-il utiliser ?
<details>
<summary>Voir la réponse</summary>
Une <b>réservation DHCP</b> basée sur l'adresse MAC de l'imprimante.
</details>

### Question 5
Un utilisateur obtient une adresse 169.254.x.x. Quel est probablement le problème ?
<details>
<summary>Voir la réponse</summary>
Le PC n'a pas pu contacter de serveur DHCP. Il s'est attribué une adresse APIPA (Automatic Private IP Addressing). Il faut vérifier la connectivité réseau et le serveur DHCP.
</details>

---

## Pour aller plus loin

### Concepts avancés à explorer

- **Relais DHCP** : Comment obtenir une adresse IP quand le serveur DHCP est sur un autre réseau ?
- **Haute disponibilité** : Configurer plusieurs serveurs DHCP pour éviter les pannes
- **Options DHCP** : Distribuer d'autres paramètres (serveur de temps, serveur TFTP, etc.)

### Commandes utiles à retenir

| Action | Linux | Windows |
|--------|-------|---------|
| Obtenir une IP | `dhclient eth0` | `ipconfig /renew` |
| Libérer l'IP | `dhclient -r eth0` | `ipconfig /release` |
| Voir la config | `ip addr show` | `ipconfig /all` |

---

Félicitations ! Vous comprenez maintenant le fonctionnement du protocole DHCP. N'hésitez pas à expérimenter avec le simulateur pour approfondir vos connaissances.

# ASSESSMENT-CERTIFICATIONS-CISCO.md — ce simulateur prepare-t-il au CCNA, au CCNP Enterprise et au CCNP Security ?

> Question posee : **en l'etat actuel, la plateforme aide-t-elle a passer le CCNA, le CCNP Security et
> le CCNP (Enterprise), dans leurs versions les plus recentes ?**
>
> Methode : trois labos REELLEMENT EXECUTES dans le simulateur (pas une lecture de code), puis
> inventaire des sous-systemes presents et absents, puis recoupement avec les blueprints d'examen.
> Chaque verdict indique ce qui a ete mesure et ce qui est deduit.

---

## 0. Reserve sur les sources — a lire avant d'utiliser les pourcentages

Le PDF officiel de Cisco (`learningcontent.cisco.com/documents/marketing/exam-topics/200-301-CCNA-v1.1.pdf`)
est **bloque par le proxy de sortie** de l'environnement depuis lequel cette analyse a ete produite, de
meme qu'un des agregateurs consultes. Les ponderations par domaine viennent donc de **sources
secondaires concordantes**, pas du blueprint officiel.

Conformement a la regle « choisir l'autorite AVANT de la citer » : la source qui fait foi est le
document Cisco, et il n'a pas pu etre atteint. **Les pourcentages ci-dessous sont a reverifier chez
Cisco avant d'en tirer un plan de revision.** Ce qui n'est PAS sujet a caution, en revanche, c'est
l'inventaire de ce que la plateforme sait faire : il a ete mesure ici.

Calendrier retenu des sources secondaires : le CCNA **200-301 v1.1** expire le **2 fevrier 2027**, la
**v2.0** prend le relais le **3 fevrier 2027** en gardant le meme numero d'examen. Une revision menee
en 2026 vise donc la v1.1.

---

## 1. Ce qui a ete EXECUTE, pas lu

Trois laboratoires montes et joues dans le simulateur, dont les sorties sont reproduites telles quelles.

### 1.1 Routage statique inter-reseaux, de bout en bout

Deux `CiscoRouter`, un `LinuxPC` de chaque cote, adressage, `ip route` croisees, routes par defaut sur
les postes :

    PING 10.2.2.10 (10.2.2.10) 56(84) bytes of data.
    64 bytes from 10.2.2.10: icmp_seq=1 ttl=62 time=14.969 ms
    3 packets transmitted, 3 received, 0% packet loss

Le `ttl=62` est le point important : **deux sauts ont reellement decremente le TTL**. Le paquet a
traverse les deux routeurs, il n'a pas ete fabrique a l'arrivee.

### 1.2 OSPF

    Neighbor ID     Pri   State           Dead Time   Address         Interface
    10.0.0.2        1     FULL/  -        00:00:39    10.0.0.2        GigabitEthernet0/1

Adjacence `FULL`, format de `show ip ospf neighbor` fidele.

### 1.3 Commutation : VLAN, trunk 802.1Q, spanning-tree

    Port        Mode             Encapsulation  Status        Native vlan
    Fa0/24      on               802.1q         trunking      1

    VLAN0001
      Spanning tree enabled protocol ieee
      Root ID    Priority    32769
                 This bridge is the root

VLAN nommes, trunk encapsule, election de racine STP.

### 1.4 Inventaire mesure

- **62 moteurs de protocoles** (`src/network/*/`) : OSPF, BGP, EIGRP, RIP, STP, VTP, DTP, LACP, UDLD,
  CDP, LLDP, HSRP/VRRP/GLBP, BFD, DHCP/DHCPv6, NAT, IPSec, GRE, VXLAN, NHRP, IGMP/PIM, SNMP, Syslog,
  NetFlow, NTP, RADIUS, TACACS+, Kerberos, IP SLA/NQA, QoS, 802.1X, DNS/DNSSEC, TLS, TCP, QUIC.
- **93 fichiers de commandes Cisco** (`src/network/devices/shells/cisco/`).
- **Crypto authentique** (`src/crypto/`) : AES-128-GCM, X25519, RSA PKCS#1 v1.5, ECDSA/ECDH P-256,
  HKDF-SHA256, verifies contre vecteurs publies.
- **Equipements** : `router-cisco`, `router-huawei`, `switch-cisco`, `switch-huawei`, `switch-generic`,
  `linux-pc`, `linux-server`, `windows-pc`, `windows-server`, `firewall-cisco`, `firewall-fortinet`,
  `firewall-paloalto`.

### 1.5 Absences verifiees par recherche, pas supposees

- **Sans-fil : rien.** Aucun repertoire ni fichier pour WLC, AP, CAPWAP, 802.11, WPA/WPA2/WPA3.
- **Automatisation : rien.** Aucun sous-systeme NETCONF, RESTCONF, YANG, Ansible ou Terraform ; les
  seules occurrences de ces mots dans l'arbre sont des fichiers de TEST sans rapport.
- **SD-Access / SD-WAN / LISP / Catalyst Center : rien.**
- **Produits Cisco Security : rien.** Ni ISE, ni FMC/Firepower/FTD, ni Umbrella, ni Secure Endpoint,
  ni ESA/WSA, ni Splunk.

---

## 2. CCNA 200-301 v1.1 — **~70-75 % exercable**

| Domaine | Poids | Etat dans la plateforme |
|---|---|---|
| Network Fundamentals | 20 % | **Couvert** — adressage, sous-reseaux, cables, TCP/UDP, tout descend par `layers/` |
| Network Access | 20 % | **Partiel** — VLAN, trunk 802.1Q, STP, EtherChannel/LACP, CDP/LLDP couverts ; **sans-fil totalement absent** |
| IP Connectivity | 25 % | **Couvert** — statique, OSPFv2 mono-aire, FHRP ; *voir la reserve 5.1 sur le saut suivant recursif* |
| IP Services | 10 % | **Couvert** — NAT, NTP, DHCP, SNMP, Syslog, QoS |
| Security Fundamentals | 15 % | **Largement couvert** — ACL, port-security, 802.1X, AAA, VPN IPSec |
| Automation & Programmability | 10 % | **Absent** |

**Verdict.** C'est un bon complement pour le CCNA, et sur le routage/commutation/services IP il est
plus fidele que bien des simulateurs pedagogiques — notamment parce que les postes Linux et Windows
sont de vraies machines simulees et non des icones.

Les deux trous sont **entiers**, ce qui est pire que partiels :
- le **sans-fil**, part substantielle du domaine Network Access, sur lequel les retours d'examen
  recents signalent une insistance forte (configuration WLC, modes d'AP, securite WPA) ;
- l'**automatisation** (10 %), qui demande REST/JSON, verbes HTTP, CRUD, Ansible/Terraform.

Ces deux sujets ne se travaillent pas du tout ici. Il faut une autre ressource.

---

## 3. CCNP Enterprise ENCOR 350-401 v1.2 — **~40 % exercable**

| Zone du blueprint | Etat |
|---|---|
| Architecture (SD-WAN, SD-Access, Catalyst Center) | **Absent** |
| Virtualisation (VRF, tunnels, LISP, VXLAN) | **Partiel** — VRF present, moteur VXLAN present, **GRE Cisco/Huawei sans plan de donnees**, LISP absent |
| Infrastructure (OSPF multi-aire, eBGP, multicast) | **Couvert** |
| Network Assurance (NetFlow, SNMP, IP SLA, SPAN) | **Couvert** |
| Securite (ACL, CoPP, 802.1X, MACsec, Zero Trust, SASE) | **Partiel** — MACsec, TrustSec, Zero Trust et SASE absents |
| Automatisation (~15 % en v1.2) | **Absent** |

**Verdict : non, pas en l'etat.** Le centre de gravite de la v1.2 est precisement ce qui manque —
Catalyst Center (ex-DNA Center) et ses flux assistes par IA, SD-Access, SD-WAN, Zero Trust, SASE,
MACsec, et une automatisation renforcee. Ce que la plateforme couvre bien (routage, VRF, multicast,
telemetrie) est le socle commun, pas ce qui distingue l'ENCOR du CCNA.

---

## 4. CCNP Security SCOR 350-701 v1.1 — **~20-25 % exercable**

| Domaine | Poids | Etat |
|---|---|---|
| Security Concepts | 25 % | **Partiel** — les labos IPSec/PKI/TLS donnent du sens aux concepts |
| Network Security | 20 % | **Partiel** — politiques de pare-feu (FortiGate, un ASA-like), ACL, IPS ; **pas de FTD/FMC** |
| Cloud Security | 15 % | **Absent** |
| Content Security | 10 % | **Absent** — ni ESA, ni WSA, ni Umbrella |
| Endpoint Protection & Detection | 15 % | **Absent** |
| Secure Network Access, Visibility, Enforcement | 15 % | **Partiel** — 802.1X, RADIUS, TACACS+, CoA presents ; **pas d'ISE** |

**Verdict : non.** Quarante pour cent de l'examen (cloud, contenu, endpoint) est hors perimetre, et la
moitie produit du reste (ISE, FMC, Umbrella, Secure Endpoint, Splunk) n'existe pas. Ce qui sert
reellement ici : IPSec IKEv1/IKEv2, PKI/TLS, 802.1X/RADIUS/TACACS+, politiques de pare-feu.

La v1.1 ajoute par ailleurs les vulnerabilites AI/LLM et la cryptographie post-quantique, deux sujets
absents de la plateforme.

---

## 5. Ce qui peut activement INDUIRE EN ERREUR

Plus important que les absences : ces limites sont mesurees et documentees dans `CLAUDE.md`, et un
apprenant qui les ignore **apprend faux**.

1. **Pas de FIB ni de resolution recursive du saut suivant.** Une route statique dont le next-hop
   n'est pas sur un reseau connecte est ACCEPTEE puis ne transmet rien. C'est un motif de labo CCNA
   courant, et l'echec est silencieux.
2. **OSPF converge avant que la commande ne rende.** `autoConverge` pompe tout le domaine
   synchroniquement : ExStart, Exchange et Loading ne sont jamais observables, alors que l'examen les
   interroge.
3. **EIGRP n'a ni etat Active, ni Query/Reply, ni RTP, ni minuteurs.** Les compteurs SIA sont
   durablement a zero. Le depannage EIGRP n'est pas apprenable ici.
4. **GRE Cisco/Huawei n'a pas de plan de donnees.** `tunnel source`/`destination` alimentent
   l'affichage et l'appariement OSPF ; rien n'est encapsule. (Le GRE de `ip tunnel` sous Linux, lui,
   est reel.)
5. **`firewall-paloalto` est un `LinuxPC`** — aucune CLI PAN-OS. La palette l'annonce par un badge
   « Limited simulation ».
6. **`GenericSwitch` ne fait tourner aucun agent de protocole** — ni DTP, ni VTP, ni STP, ni LACP.
7. **Le pare-feu Windows part en `DefaultInboundAction = Allow`** la ou un vrai Windows part en
   `Block` — le modele de profils est reel, mais le jeu de plusieurs centaines de regles integrees
   qui rend `Block` vivable n'est pas modelise.

---

## 6. Recommandation

**Pour le CCNA** : oui, comme complement. Le routage, la commutation et les services IP se travaillent
bien et honnetement. Prevoir une autre ressource pour le sans-fil et l'automatisation, et garder la
section 5 sous les yeux.

**Pour les deux CCNP** : non. Ce sont des examens ecrits centres PRODUIT (Catalyst Center, ISE, FMC,
Umbrella). Un simulateur de protocoles, si fidele soit-il, ne remplace pas cette connaissance produit,
et l'ecart ne se comble pas par des correctifs incrementaux : il demanderait des sous-systemes entiers.

**Si l'objectif est de rendre la plateforme reellement suffisante pour le CCNA**, l'ordre le plus
rentable est :

1. **Le sans-fil** — WLC, AP et leurs modes, WPA2/WPA3, configuration WLAN. C'est le plus gros
   manque, et il pese sur un domaine a 20 %.
2. **L'automatisation** — RESTCONF/JSON sur les equipements existants, verbes HTTP et CRUD. Le
   sous-systeme HTTP et la pile TLS existent deja : il s'agit d'exposer les equipements, pas de partir
   de zero.

Dans cet ordre, et pas l'inverse : le sans-fil est absent de bout en bout, tandis que l'automatisation
peut s'appuyer sur ce qui est deja la.

---

## 7. Sources

Blueprints (secondaires — voir la reserve en section 0) :

- CCNA 200-301 v1.1 — https://computingforgeeks.com/ccna-exam-topics/
- CCNA topics 2026 — https://www.examcert.app/blog/ccna-exam-topics-2026/
- Nouveautes ENCOR v1.2 — https://ipcisco.com/what-is-new-in-ccnp-encor/
- Syllabus ENCOR v1.2 — https://www.pynetlabs.com/ccnp-encor-syllabus/
- SCOR 350-701 — https://www.cbtnuggets.com/it-training/cisco/scor-350-701
- Syllabus 350-701 — https://www.nwexam.com/cisco/cisco-350-701-certification-exam-syllabus

Source qui ferait foi et qui n'a pas pu etre atteinte :

- https://learningcontent.cisco.com/documents/marketing/exam-topics/200-301-CCNA-v1.1.pdf (bloquee par
  le proxy de sortie)

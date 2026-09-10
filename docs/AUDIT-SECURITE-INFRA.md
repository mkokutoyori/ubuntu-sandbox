# Audit sécurité — durcir l'infrastructure, et voir ce qui tient

**Date :** 2026-09-10 · **Méthode :** monter une infrastructure
d'entreprise, la durcir comme le ferait un ingénieur sécurité, puis
**attaquer chaque contrôle**. Relevés dans
`src/__tests__/debug/infra/` et `src/__tests__/debug/rman/`.

> **Le principe de cet audit.** Poser une commande ne prouve rien : le
> `CLAUDE.md` §6 nomme précisément le défaut où un critère est analysé,
> rangé, rendu par `show` — et jamais évalué. Un durcissement qui
> s'affiche sans s'appliquer est pire qu'un durcissement absent, parce
> qu'il produit une **fausse assurance**. Chaque ligne ci-dessous a donc
> deux colonnes : *accepté* et *appliqué*.

---

## 1. Ce que la phase « poser » ne dit pas

Vingt contrôles ont été posés sur un commutateur d'accès et un routeur
de cœur — VLAN, port-security, BPDU guard, storm-control, DHCP snooping,
ARP inspection, VLAN natif déplacé, AAA, SSH seul, `login block-for`,
ACL anti-usurpation, uRPF, services dangereux coupés, SNMPv3 authPriv,
syslog, NTP authentifié, bannière.

**Les vingt sont acceptés sans une erreur.** C'est exactement le résultat
qui ne doit convaincre personne, et le point de départ de l'audit.

---

## 2. Ce qui APPLIQUE réellement — mesuré

| Contrôle | Attaque | Résultat |
|---|---|---|
| `switchport port-security maximum 1` + `violation shutdown` | 2ᵉ MAC derrière un hub | **applique** — voir §2.1 |
| `ip access-group` avec `deny icmp` | ping à travers | `100% packet loss, +2 errors` ✅ |
| `transport input ssh` sur les VTY | `telnet 10.10.10.1` | `Connection refused` ✅ |
| `login block-for 120 attempts 3 within 60` | `show login` | rend les trois seuils, la fenêtre et le compteur ✅ |
| `ip dhcp snooping` + `vlan 1` | `show ip dhcp snooping` | `enabled`, **et `operational on VLAN 1`** ✅ |
| Politique FortiGate `accept` / `deny` | ping inter-zone | `0%` puis `100% packet loss` ✅ |

### 2.1 `port-security` — le relevé complet

```
[T] PC-A joint le routeur, avant durcissement    0% packet loss
[1] PC-A, 1re MAC apprise                        0% packet loss
[2] PC-B, 2e MAC sur le même port              100% packet loss
[3] Port Status : Secure-shutdown
    Security Violation Count : 1
    Sticky MAC Addresses : 1
    Last Source Address:Vlan : 0200.0000.001d:1
[4] show interfaces status                       Fa0/1  disabled
[5] PC-A APRÈS la violation                    100% packet loss
```

**[5] est le point le plus instructif, et ce n'est pas un défaut.**
`violation shutdown` err-disable le port **entier** : la machine
légitime perd le lien elle aussi. C'est ce que fait un vrai Catalyst, et
c'est la raison pour laquelle ce mode se déploie avec précaution. Un
simulateur qui n'aurait puni que l'intrus aurait enseigné le contraire.

> **Conclusion de cette section, et elle est à porter au crédit du
> projet :** la pile de sécurité réseau ne fait pas semblant. Les
> contrôles L2 et L3 testés tiennent sous l'attaque, avec les états, les
> compteurs et les effets de bord du matériel réel.

---

## 3. Le trou qui était unique — REFERMÉ depuis

> **Mise à jour.** Ce qui suit décrivait l'état au moment de l'audit. Le
> lot R7 l'a refermé : `resolveOneAddress` compose désormais un vrai SYN
> par `tcpConnectOutcome`, et `RmanSession` résout sa cible par la même
> porte. Le relevé après correctif :
>
>     RMAN @10.10.20.20, pare-feu OUVERT   connected to target database: ORCL
>     RMAN @10.10.20.20, pare-feu FERMÉ    RMAN-04006 / ORA-12170
>     sessions du pare-feu                 4 avant, 5 après
>
> **[D] est la preuve que la connexion traverse** — le pare-feu compte
> une session de plus. Reste ouvert : une sauvegarde vers un point de
> montage distant écrit encore dans le VFS local (lot R8).

### 3.1 L'état constaté à l'audit

Un seul contrôle s'est révélé sans effet, et il n'est pas dans le
réseau : **la connexion RMAN ne traverse rien**.

| | mesure |
|---|---|
| ping DB→BACKUP, aucune politique | `100% packet loss` |
| ping, politique **ACCEPT** | `0% packet loss` |
| ping, politique **DENY** | `100% packet loss` |
| `CONNECT TARGET …@10.10.20.20`, pare-feu **ouvert** | `connected to target database: ORCL` |
| la même, pare-feu **FERMÉ** | `connected to target database: ORCL` |
| sessions vues par le pare-feu | `4` avant, `4` après |

Les trois pings sont le **témoin** : ce pare-feu bloque réellement. Que
les deux connexions RMAN rendent la même réponse ne s'explique donc pas
par un pare-feu inerte, mais par une connexion qui n'existe pas — *un
pare-feu ne bloque pas ce qui ne traverse rien*.

**Gravité, du point de vue d'un ingénieur sécurité.** Ce n'est pas un
manque de fonctionnalité, c'est un **résultat faux**. Un opérateur qui
segmente son datacenter, coupe le flux base→sauvegarde et voit RMAN
continuer d'aboutir en conclura que sa règle est inefficace. Il tirera
de son laboratoire l'inverse de ce que la réalité lui enseignerait.
C'est inscrit au `TODO.md` et c'est le lot **R7** de
`docs/ASSESSMENT-RMAN.md`.

---

## 4. Deux réserves de méthode, que je porte à mon débit

Cet audit a produit **deux faux positifs** avant correction, tous deux
de mon fait, et les nommer vaut mieux que de les taire :

1. **`login block-for` déclaré « non appliqué ».** Faux : mon banc
   tronquait `show login` à trois lignes. La sortie complète rend bien
   « Router enabled to watch for login Attacks » et les trois seuils.
   C'est la lecture de l'implémentation qui a tranché — pas une
   deuxième mesure.
2. **DHCP snooping déclaré « non testé, offres non filtrées ».** Faux
   aussi : mon serveur voyou n'avait pas de démon DHCP du tout, donc
   l'absence d'offre ne prouvait rien sur le snooping.

`ip http server` reste **non mesurable** par ce laboratoire : `curl`
vers le routeur rend le vide avant comme après `no ip http server`. Ce
n'est pas un défaut établi, c'est un contrôle dont l'effet n'est pas
observable — donc une zone où un défaut pourrait vivre sans être vu.

---

## 5. Ce qui n'a pas été attaqué, et devrait l'être

Par honnêteté sur la couverture : ces contrôles ont été posés et
acceptés, mais **aucune attaque ne les a éprouvés**. Ne pas les compter
comme validés.

- **BPDU guard** — envoyer une BPDU sur un port `portfast`
- **ARP inspection** — ARP gratuit avec une liaison fausse
- **storm-control** — inondation de diffusion
- **uRPF** — paquet à source usurpée
- **SNMPv3 authPriv** — interroger en v2c malgré la déclaration v3
- **NTP authentifié** — serveur non authentifié
- **VLAN natif / pruning** — saut de VLAN (double étiquetage)
- **AAA** — échec d'authentification et repli
- **iptables, sudo, permissions `oracle`** — toute la pile hôte

C'est le programme d'un second passage, et chacun est un candidat
sérieux au défaut du §6.

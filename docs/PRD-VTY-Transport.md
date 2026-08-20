# PRD — Suppression du court-circuit VTY (SSH/Telnet interactif vers les routeurs sur le fil)

**Version** : 1.0
**Date** : 2026-07-02
**Projet** : Ubuntu Sandbox — Accès VTY réaliste
**Auteur** : Claude Code
**Références normatives** : RFC 9293 (TCP), RFC 4253 (SSH Transport Layer), RFC 854 (Telnet), Cisco IOS « line vty » / « transport input » / « access-class », Huawei VRP « user-interface vty » / « protocol inbound »

---

## 0. Contexte et portée du document

Ce PRD couvre la **suppression du court-circuit VTY** : aujourd'hui, une session SSH ou
Telnet interactive ouverte depuis le terminal d'un hôte (Linux, Windows) vers la ligne
VTY d'un routeur Cisco/Huawei **ne traverse pas le réseau simulé**. Le lanceur résout la
cible via le registre global d'équipements et ouvre le shell distant par appel de méthode
direct. Le verdict de connexion ne dépend donc ni du câblage, ni du routage, ni de la
configuration VTY du routeur (`transport input`, `access-class`, lignes disponibles).

L'objectif est le même que celui déjà atteint pour le probe TCP IPv4/IPv6 (cf.
`PRD-IPv6-Transport.md`, phase 4) : **toute décision de bout en bout doit être lue depuis
le fil**, jamais depuis l'état interne du pair via le registre.

Aucune ligne de code de production n'est écrite dans le cadre de ce document ; il sert de
base à la planification et à la revue avant le premier commit TDD.

---

## 1. Analyse de l'existant

### 1.1 Inventaire des chemins SSH/Telnet vers un routeur

| Fichier | Rôle actuel | État |
|---|---|---|
| `src/shell/sshLauncher.ts` — `tryInterpretSshLaunch` | Lancement SSH interactif depuis les terminaux (adapters bash / cmd / PowerShell) | **Court-circuit total** : `findEquipmentByIp` (registre) + `getIsPoweredOn()` + `isSshActive()`, puis `CrossVendorRemoteShell` direct |
| `src/network/devices/linux/network/LinuxSshClient.ts` | Commande `ssh` du bash Linux (mode exec) | Semi-réaliste : `isPathReachable` (marche topologique), ACL de transit, ACL VTY, `CrossVendorSshHost.evaluate` — mais pont synchrone, pas de TCP sur le fil |
| `src/network/devices/Router.ts` — `mountSshDaemon` | Démon SSH réel sur `TcpStack` port 22 (`SshServerHandler` + `RouterSshServerContext`) | **Complet, sur le fil — mais inutilisé en production** (seul `router-tcp-ssh-server.test.ts` s'y connecte) |
| `src/network/devices/EndHost.ts` — `tcpConnectOutcome` | Verdict de connexion lu du fil : `open` / `refused` / `timeout` | Complet (IPv4 + IPv6) ; exige une entrée ARP préexistante (`resolveMac` ne déclenche pas de résolution) |
| `src/network/devices/router/vty/VtyLineConfig.ts` + `VtyLineConfigStore` | Modèle de configuration des lignes VTY (`transport input`, `access-class`, `login`, `exec-timeout`, …) + `incomingVerdict()` | Complet côté modèle ; consulté par le client telnet Linux et le pont exec, **pas par le lanceur interactif** |
| `src/network/devices/shells/vty/CliShellSession.ts` | État par session VTY (mode, privilège, historique, terminal length) | Complet — mais allocation illimitée, aucun pool fini vty 0–4 |
| `src/network/devices/linux/LinuxCommandExecutor.ts` — `runTelnetClient` | Client telnet Linux | Émulation côté client : `tcpProbe` + `incomingVerdict()` + trames de capture synthétiques (`emitTelnetWire`) — le routeur n'a **aucun listener TCP/23** |
| `src/network/devices/Router.ts` — `_setVtyTransportInput` | `transport input none/telnet` bascule `sshServerEnabled` | Simple drapeau : le listener TCP/22 **reste lié** — le fil et la config divergent |

### 1.2 Ce qui existe déjà et est réutilisable (aucune réécriture)

- Le **démon SSH sur TCP/22** des routeurs est réel et branché sur la pile `TcpStack`
  (RFC 9293) : ARP → SYN → SYN-ACK → ACK → framing SSH traversent le câblage simulé.
- `EndHost.tcpConnectOutcome` fournit exactement le verdict dont le lanceur a besoin,
  entièrement lu du fil, de manière synchrone (livraison de trames synchrone par câble).
- `VtyLineConfigStore` porte déjà toute la configuration (`transport input`,
  `access-class`, `login`, mot de passe de ligne) et expose `incomingVerdict()`.
- `CliShellSession` fournit l'état par session ; il ne manque que la notion de pool fini.
- Le mécanisme d'authentification (`finalisePendingAuth` → `CredentialStore` / AAA) est
  fonctionnel et n'a pas besoin de changer.

### 1.3 Ce qui manque ou court-circuite (gap analysis)

| # | Manque | Conséquence observable | Sévérité |
|---|---|---|---|
| 1 | Le lanceur SSH interactif ne consulte jamais le réseau | `ssh admin@10.0.0.6` depuis un terminal **réussit sans câble**, interface `shutdown`, ou routeur injoignable | Bloquant |
| 2 | Un ARP froid fait échouer `tcpConnectOutcome` (`resolveMac` ne résout pas) | Une sonde sur le fil sans ping préalable rapporte un faux `timeout` | Bloquant (prérequis du #1) |
| 3 | `transport input none`/`telnet` ne ferme pas le listener TCP/22 | Le fil accepte le handshake alors que la config l'interdit — un scan de port ment | Élevée |
| 4 | Le lanceur interactif ignore `access-class` / `acl inbound` | Une ACL VTY qui refuse la source n'a aucun effet sur la session interactive | Élevée |
| 5 | Aucun pool fini de lignes vty 0–4 | Sessions simultanées illimitées ; pas d'épuisement, `show users` incomplet | Moyenne |
| 6 | Aucun listener TCP/23 (telnet émulé côté client) | Le verdict telnet est reconstruit côté client, trames de capture synthétiques | Moyenne |

**Conclusion de la phase d'analyse** : le serveur (démon TCP/22 du routeur) et la sonde
client (`tcpConnectOutcome`) existent déjà et sont sur le fil. Le court-circuit est
concentré dans le **lanceur interactif** (`sshLauncher.ts`) qui ne les utilise pas. Le
corriger consiste à (a) injecter une sonde fil dans le lanceur, (b) faire dire la vérité
au listener TCP/22 (refléter `transport input`), (c) faire respecter la politique VTY à
l'admission, (d) rendre le pool de lignes fini, (e) mettre telnet sur le même chemin.

---

## 2. Objectifs

### 2.1 Objectifs (ce PRD)

1. **Verdict lu du fil** : le lancement SSH interactif effectue une vraie connexion TCP
   (source = l'équipement du terminal, destination = port 22 de la cible) à travers le
   réseau simulé. `open` → défi de mot de passe ; `refused` → « Connection refused » ;
   `timeout` → « Connection timed out ». Plus aucune décision fondée sur le registre.
2. **ARP intégré à la sonde** : `tcpConnectOutcome` résout le voisin ARP comme un vrai
   noyau avant d'émettre le SYN — plus besoin de ping préalable.
3. **Le listener TCP/22 reflète la config VTY** : `transport input none`/`telnet` (Cisco)
   et `undo stelnet server enable` (Huawei) ferment le listener ; `ssh`/`all` le lient.
   Le refus est alors observable **sur le fil** (RST), pas via un drapeau.
4. **Politique VTY unifiée à l'admission** : `access-class`/`acl inbound`, mode `login`,
   « Password required, but none set » — un seul service de domaine consulté par le démon
   SSH, le chemin telnet et le pont exec.
5. **Pool de lignes VTY fini** : vty 0–4 par défaut, allocation par session, refus à
   l'épuisement, cohérence `show users` / `show line`, libération sur `exit`.
6. **Telnet sur le fil** : listener TCP/23 gouverné par `transport input`, client telnet
   effectuant une vraie connexion — suppression de l'émulation côté client.

### 2.2 Non-objectifs (hors périmètre)

- Fidélité cryptographique SSH (négociation kex/cipher octet par octet) — le framing
  existant de `SshServerHandler` suffit.
- Lignes console (`line con 0`) et auxiliaires (`line aux 0`) — accès physique, pas VTY.
- Méthodes AAA au-delà de l'existant (`authenticateViaAaa` est réutilisé tel quel).
- Les commutateurs Cisco/Huawei : ils n'ont pas de `TcpStack` aujourd'hui ; leur mise sur
  le fil est une extension naturelle **après** ce PRD, via la même couture.
- SCP/SFTP : chemins existants inchangés.
- Le mode exec de `LinuxSshClient` (pont synchrone) : déjà gaté par la topologie ; sa
  migration complète vers le fil suivra la même couture dans un second temps.

---

## 3. Architecture cible

### 3.1 Principe directeur

**Le lanceur ne décide plus, il demande au réseau.** On n'ajoute pas un « simulateur de
réseau » dans le lanceur : on lui injecte une capacité de sonde (`wireProbe`) que chaque
adapter de shell construit depuis son équipement source. Le lanceur reste ignorant de la
topologie ; l'équipement reste ignorant du lanceur (inversion de dépendance).

### 3.2 Diagramme de flux

```
Terminal (bash / cmd / PowerShell sur LinuxPC / WindowsPC)
        |  « ssh admin@10.0.0.6 »
+-------v----------------------------------------------------------+
|  Adapter (LinuxBashShell / WindowsCmdShell / WindowsPowerShell)  |
|  construit SshLaunchOptions { wireProbe: device.tcpConnectOutcome }|
+-------v----------------------------------------------------------+
|  sshLauncher.tryInterpretSshLaunch                                |
|  1. résolution nom → IP (inchangée)                               |
|  2. wireProbe(ip, 22)  ── SYN réel sur le fil ──────────────┐     |
|  3. open → pendingInput(password) ; refused/timeout → erreur|     |
+-------------------------------------------------------------|-----+
                                                              |
   câbles / switches / routeurs / ACL / pare-feux (plan L2/L3)|
                                                              |
+-------------------------------------------------------------v-----+
|  Routeur cible — TcpStack:22 (mountSshDaemon)                     |
|  listener lié ssi transport input ∈ {ssh, all}                    |
|  admission : VtyIncomingPolicy (access-class, login, pool vty)    |
+-------------------------------------------------------------------+
```

### 3.3 Couture `wireProbe` (cœur de la suppression du court-circuit)

```
type TcpWireOutcome = 'open' | 'refused' | 'timeout';

interface SshLaunchOptions {
  // … champs existants …
  wireProbe?: (host: string, port: number) => TcpWireOutcome;
}
```

- Fournie : le verdict du fil est **souverain** — les tests `getIsPoweredOn` /
  `isSshActive` deviennent inutiles sur ce chemin (un routeur éteint ne répond pas au SYN).
- Absente (appelants historiques, tests existants) : comportement inchangé — la migration
  est incrémentale, aucun big-bang.

### 3.4 Modules touchés

```
src/shell/sshLauncher.ts                    # option wireProbe, verdicts OpenSSH
src/shell/adapters/LinuxBashShell.ts        # injection de la sonde depuis this.device
src/shell/adapters/WindowsCmdShell.ts       # idem
src/shell/adapters/WindowsPowerShellShell.ts# idem
src/network/devices/EndHost.ts              # tcpConnectOutcome : résolution ARP intégrée
src/network/devices/Router.ts               # bind/unbind TCP/22 selon transport input ;
                                            #   listener TCP/23 (phase telnet) ;
                                            #   VtyIncomingPolicy ; pool de lignes
src/network/devices/router/vty/…            # VtyLinePool (nouveau), politique d'admission
src/network/devices/linux/LinuxCommandExecutor.ts # telnet : vrai connect (phase 5)
```

### 3.5 Design patterns retenus

| Pattern | Usage | Justification |
|---|---|---|
| **Dependency Injection** | `wireProbe` injectée dans `SshLaunchOptions` | Le lanceur dépend d'une abstraction, pas de `EndHost` ; testable ; migration douce |
| **Strategy** | La sonde v4 aujourd'hui, v6 demain (`ssh -6`) derrière la même signature | Une seule logique de verdict dans le lanceur |
| **Single Source of Truth** | L'état du listener TCP/22-23 EST la config `transport input` | Supprime la divergence drapeau/fil (gap #3) |
| **Domain Service** | `VtyIncomingPolicy` : un seul verdict d'admission partagé SSH/telnet/exec | Supprime la triplication du verdict (launcher / LinuxSshClient / telnet) |
| **Object Pool** | `VtyLinePool` : lignes vty 0–4 finies, allocation/libération par session | Sémantique IOS réelle (épuisement, `show users`, `clear line`) |

---

## 4. Sémantique cible (comportements observables)

| Situation | Verdict attendu (identique au réel) |
|---|---|
| Câble présent, routeur configuré, `transport input ssh/all` | Défi de mot de passe, session VTY ouverte |
| Aucun chemin câblé vers la cible | `ssh: connect to host X port 22: Connection timed out` |
| Interface du routeur `shutdown` | idem timeout |
| Routeur éteint | idem timeout (aucune réponse au SYN) |
| `transport input none` ou `telnet` | `ssh: connect to host X port 22: Connection refused` (RST du fil) |
| `access-class <ACL> in` refusant la source | Connexion fermée à l'admission (comportement IOS) |
| `login` sans `password` sur la ligne | `Password required, but none set` puis fermeture |
| 5 sessions vty occupées (0–4) | Refus de la 6e connexion |
| `exit` dans la session | Libération de la ligne, réutilisable immédiatement |

---

## 5. Plan de mise en œuvre (TDD, par phases)

Chaque phase suit la méthode du projet : test d'abord (topologie réelle — `LinuxPC`,
`CiscoRouter`, `HuaweiRouter`, `GenericSwitch`, vrais câbles, aucun mock du transport),
puis implémentation jusqu'au vert, puis régression complète avant commit. Aucun stub,
aucun commentaire dans le code de production, aucune duplication.

| Phase | Contenu | Sortie testable |
|---|---|---|
| **1** | Couture `wireProbe` dans le lanceur + injection par les 3 adapters + ARP intégré à `tcpConnectOutcome` | `ssh` interactif : pending si joignable, timeout si câble absent/interface down — sans ping préalable ; appelants sans sonde inchangés |
| **2** | Le listener TCP/22 reflète `transport input` (bind/unbind) — Cisco et Huawei | `transport input none/telnet` → « Connection refused » lu du fil ; retour à `ssh`/`all` → à nouveau joignable |
| **3** | `VtyIncomingPolicy` : `access-class`/`acl inbound` + mode `login` + « Password required, but none set », consommé par le démon SSH et le pont exec | Une ACL VTY refuse la session interactive ; les trois chemins donnent le même verdict |
| **4** | `VtyLinePool` : lignes 0–4 finies, allocation par session, épuisement, libération sur exit, `show users`/`show line` cohérents | 6e session refusée ; `clear line vty N` libère ; `show users` liste les sessions par ligne |
| **5** | Telnet sur le fil : listener TCP/23 gouverné par `transport input`, client telnet en vrai connect, suppression de l'émulation client | `telnet` vers un routeur suit le même chemin que SSH ; capture tcpdump réelle |
| **6** | Nettoyage : retirer les vérifications registre (`getIsPoweredOn`/`isSshActive`) devenues mortes sur le chemin sondé ; audit anti-duplication ; régression complète | Suites SSH/telnet existantes vertes ; plus aucune lecture d'état pair sur le chemin interactif |

La phase 1 est le pivot : **le verdict de connexion interactif devient un fait du réseau**.
Les phases suivantes font converger la configuration VTY et le fil.

---

## 6. Stratégie de test

- **TDD strict** : chaque phase commence par une suite rouge sur topologie réelle
  (hôte–switch–routeur, puis multi-segments à travers un routeur intermédiaire).
- **Anti-court-circuit** : le test central vérifie que le verdict change quand on coupe
  le câble ou qu'on `shutdown` l'interface — impossible à satisfaire avec l'ancienne
  résolution registre.
- **Sans échauffement** : les scénarios ne font aucun `ping` préalable — la résolution
  ARP fait partie du chemin testé (gap #2).
- **Parité vendeur** : chaque comportement testé sur Cisco l'est aussi sur Huawei
  (`transport input` ↔ `protocol inbound`, `access-class` ↔ `acl inbound`).
- **Non-régression** : les suites existantes (`cross-equipment-ssh-suite`,
  `linux-lan-ssh-suite`, `ssh-nested-matrix`, `telnet-tcp-gate`,
  `router-tcp-ssh-server`, `cross-vendor-ssh-interactive`) servent de golden master ;
  l'option `wireProbe` étant opt-in, elles restent vertes pendant toute la migration.
- **Cas limites** : routeur éteint en cours de session, deux équipements partageant une
  IP (seul le câble départage), sonde vers sa propre adresse, port ≠ 22 (`-p`).

---

## 7. Risques et points d'attention

1. **Régression des suites SSH massives** (2 300+ lignes pour `linux-lan-ssh-suite`) :
   mitigation — la sonde est opt-in (`wireProbe?`), les chemins historiques ne changent
   pas tant que l'adapter n'injecte pas ; migration adapter par adapter, suite verte
   entre chaque commit.
2. **ARP dans `tcpConnectOutcome`** : intégrer la résolution pourrait changer le verdict
   de tests qui comptaient sur un faux timeout à froid. Mitigation : phase 1 dédiée,
   régression ciblée sur `ipv6-tcp-probe-no-shortcircuit` et `telnet-tcp-gate` qui
   utilisent déjà la sonde après échauffement (comportement inchangé à chaud).
3. **Fermeture du listener TCP/22** : `SshServerHandler` garde des sessions ouvertes ;
   fermer le listener ne doit pas tuer les sessions établies (sémantique IOS : `transport
   input none` bloque les **nouvelles** connexions). Mitigation : test dédié en phase 2.
4. **Double vérité transitoire** : entre les phases 1 et 6, le lanceur sondé coexiste
   avec les vérifications registre. Mitigation : la phase 6 supprime explicitement le
   chemin mort ; un audit grep clôt le PRD.
5. **Performances** : la sonde ajoute un handshake TCP par lancement ssh — négligeable
   (le handshake est synchrone et local au moteur).

---

## 8. Suite prévue

Une fois le chemin VTY sur le fil : migration du mode exec de `LinuxSshClient` vers le
même transport (suppression du pont synchrone `runSshCommandSync`), `TcpStack` sur les
commutateurs manageables (SSH vers un switch via le même démon), et `ssh -6` interactif
(la couture `wireProbe` acceptant déjà une sonde IPv6).

# PRD — Port Forwarding (toutes les couches du simulateur)

**Version** : 1.0
**Date** : 2026-08-03
**Projet** : Ubuntu Sandbox — simulateur réseau navigateur
**Auteur** : Claude (agent), à la demande de l'utilisateur
**Références normatives** :
- RFC 2663 (terminologie NAT — inside/outside local/global), RFC 5382 (exigences
  NAT pour TCP — hairpin), RFC 5508 (traduction ICMP embarquée)
- Comportement Cisco IOS réel (`ip nat inside source static tcp|udp`, ordre
  d'évaluation NAT/ACL) et Huawei VRP réel (`nat server protocol tcp|udp`)
- `iptables(8)`/`iptables-extensions(8)` (cibles `DNAT`/`SNAT`/`MASQUERADE`/
  `REDIRECT`, table `nat`, chaînes `PREROUTING`/`POSTROUTING`), RFC 793/RFC 768
  (checksums TCP/UDP couvrant le pseudo-header, donc sensibles à toute
  réécriture d'adresse post-NAT)
- Microsoft Docs — `netsh interface portproxy`
- RFC 4254 §7 (SSH Connection Protocol — canaux `direct-tcpip`/
  `forwarded-tcpip`, fondement protocolaire de `-L`/`-R`/`-D`)

---

## 0. Contexte et portée du document

« Port forwarding » n'est pas une fonctionnalité unique dans ce simulateur —
c'est une **capacité conceptuelle** (rediriger transparemment une connexion
adressée à `<endpoint externe>` vers `<endpoint interne>`) qui existe **quatre
fois**, sous quatre formes indépendantes, à quatre couches différentes du
projet, chacune avec son propre moteur, sa propre CLI, ses propres tests et
son propre niveau de maturité :

| Couche | Mécanisme réel | Équipement concerné |
|---|---|---|
| **A. Routeur** | NAT statique orienté port (`ip nat inside source static tcp\|udp`, `nat server protocol tcp\|udp`) | `CiscoRouter`, `HuaweiRouter`, et — fait nouveau documenté ici — `HuaweiSwitch` (commutateur L3) |
| **B. Hôte Linux** | `iptables -t nat -A PREROUTING -j DNAT --to-destination` | `LinuxPC`, `LinuxServer`, et par héritage `firewall-cisco`/`firewall-fortinet`/`firewall-paloalto` |
| **C. Hôte Windows** | `netsh interface portproxy add v4tov4` | `WindowsPC`, `WindowsServer` |
| **D. SSH** | `ssh -L`/`-R`/`-D` (tunnel applicatif, pas de translation réseau) | Tout client SSH (Linux/Windows/Cisco/Huawei) |

Ce document remplit trois rôles à la fois :

1. **Il consolide** l'analyse de l'existant pour les quatre couches en un seul
   endroit, alors qu'elle était jusqu'ici éclatée entre quatre documents
   distincts (`docs/PRD-NAT-Port-Forwarding.md`, `docs/PRD-Iptables-UFW.md`,
   `docs/PRD-netsh.md`, `docs/BRD-SSH-SFTP.md`/`docs/SSH-IMPLEMENTATION-ANALYSIS.md`)
   qui ne se citent pas mutuellement et emploient chacun le terme « port
   forwarding » sans savoir qu'il désigne autre chose ailleurs dans le même
   dépôt.
2. **Il corrige** ces quatre documents là où la relecture intégrale du code
   effectuée pour ce PRD (voir §1) a trouvé des divergences avec leurs
   propres affirmations — notamment deux régressions silencieuses non
   documentées ailleurs (§1.A item 1, §1.B item 1) qui font que la
   fonctionnalité, telle que câblée aujourd'hui, **ne délivre pas réellement
   le trafic** dans le cas le plus courant (redirection de port
   gateway→serveur interne), alors que la CLI, les compteurs et les tables
   d'affichage donnent l'illusion du contraire.
3. **Il planifie** la remédiation des quatre couches dans un seul programme
   séquencé par sévérité et par risque, plutôt que quatre chantiers isolés
   qui se chevaucheraient sur les mêmes fichiers (`Router.ts`, `EndHost.ts`)
   sans coordination.

**Méthode** : chaque affirmation de ce document a été vérifiée par lecture
directe du fichier et du numéro de ligne cité au moment de la rédaction
(2026-08-03, après fusion de `origin/mandeng` jusqu'au commit `36b19e5b`) —
pas seulement reprise des PRDs préexistants. Là où un PRD préexistant est
encore exact, ce document le dit et ne duplique pas son détail ; là où il
s'est révélé stale ou incomplet, ce document l'indique explicitement avec la
divergence trouvée.

**Hors périmètre, explicitement** (repris/étendu §2.9) : syntaxe native
ASA/FortiOS/PAN-OS pour `firewall-cisco/fortinet/paloalto` (déjà tracké comme
chantier séparé, non borné — voir `CLAUDE.md` sur `DeviceFactory.ts`) ; NAT64
et ALG SIP (`GAP.md` §4.10, hors ALG FTP déjà réel) ; parité byte-exact
IPv6/NAT66 au-delà de ce qui existe déjà (`ip6tables-nat66-prerouting.test.ts`,
propriété de `docs/PRD-Iptables-UFW.md`) ; X11/agent forwarding SSH,
`UDP ASSOCIATE`/`BIND` du SOCKS5 dynamique (déjà noté mineur dans `GAP.md`
§7.3) ; routage IP natif inter-cartes façon RRAS/ICS côté Windows (une
capacité distincte de `portproxy`, qui est un relais applicatif et n'en a pas
besoin — voir §1.C).

---

## 1. Analyse de l'existant

### 1.A Routeurs Cisco/Huawei (+ commutateur L3 Huawei) — NAT statique orienté port

**Document préexistant** : `docs/PRD-NAT-Port-Forwarding.md` (v1.0,
2026-07-08) documente déjà en détail ce sous-système, confirmé toujours
d'actualité sur l'essentiel par cette relecture (`NATEngine.ts` est passé de
899 à 1084 lignes depuis, sans changement structurel sur les points qu'il
couvre). Ce document ne le republie pas — il en reprend les items encore
ouverts dans son plan (§3) et ajoute **un défaut critique que ni ce PRD ni
l'audit `docs/audit/02-protocoles-L3-routage.md` (2026-07-22) ne
mentionnent**.

**Ce qui est réel et solide** (confirmé) : `NATEngine.ts` implémente NAT
statique 1:1, NAT statique réseau/offset, **NAT statique orienté port**
(`NatStaticEntry.protocol/localPort/globalPort`), PAT/overload dynamique,
pool dynamique, hairpin (RFC 5382 §5), réécriture ICMP embarquée (RFC 5508
§3), pinhole ALG FTP, timeouts par protocole, machine à états TCP, compteurs
hit/miss. Les CLI Cisco (`ip nat inside source static tcp|udp`,
`CiscoNATCommands.ts:95-127`) et Huawei (`nat server protocol tcp|udp`,
`HuaweiNATCommands.ts:82-104`) sont toutes deux réellement branchées sur ce
moteur, y compris la variante `interface <if> <port>` côté Cisco.

**Défaut critique nouvellement identifié — la voie retour d'une redirection
de port n'est jamais traduite.** `NATEngine.translateOutbound()` exclut
explicitement toute entrée statique porteuse d'un `protocol` :

```ts
// NATEngine.ts:523-524
for (const entry of this.staticEntries) {
  if (entry.protocol) continue;
```

Tracé complet du chemin d'un paquet retour (serveur interne → client
externe) à travers `Router.processIPv4()`/`forwardPacket()` :
`translateInbound()` ne matche rien (la destination est le client externe,
pas une adresse globale NATée) → la route résout vers l'interface outside →
`isHairpin` est correctement `false` → `translateOutbound()` est appelé →
la boucle des entrées statiques **saute** l'entrée de port-forwarding
concernée à cause du `continue` ci-dessus. Deux issues, toutes deux
incorrectes :
- **Si une règle PAT/overload coexiste sur la même interface outside**
  (le cas dans tous les labs de test existants — `scenario-cisco-port-forwarding.test.ts:84`,
  `scenario-cisco-nat-static-multi-port-forward.test.ts:71-91`), le paquet
  retour tombe dans la boucle des règles dynamiques et se fait re-PATer vers
  un **port éphémère aléatoire** au lieu du port public attendu par le
  client — la réponse arrive d'un port source que le client ne reconnaît
  pas.
- **Si aucune règle PAT n'existe**, `translateOutbound()` renvoie `null` et
  — `forwardPacket()` ne conditionnant pas la suite au succès du NAT — le
  paquet part avec l'**adresse privée RFC 1918 non traduite** de l'hôte
  interne, une fuite d'adressage sur le WAN.

Dans les deux cas, **la connexion ne peut jamais se terminer côté client
externe** : la redirection de port, telle que câblée aujourd'hui, ne fait
que la moitié DNAT du travail. Ceci est corroboré indépendamment par le
commentaire d'en-tête de `ftp-alg-nat.test.ts:1-12`, qui admet qu'un
`TcpStack.connect()` réel routé à travers un `Router` NATé reste bloqué en
`'syn-sent'`, sans aucun code FTP/ALG impliqué — un gap préexistant, pas
introduit par ce constat, mais dont ce document identifie ici la cause
précise pour le cas port-forwarding. Aucun test existant ne peut détecter ce
défaut : les assertions de connectivité des labs (`nc -zv <ip-publique>
<port>`) résolvent l'adresse publique directement vers le routeur lui-même
via `findHostByAddress()`, sans jamais emprunter le vrai chemin paquet.

**Items déjà documentés par `PRD-NAT-Port-Forwarding.md`, toujours ouverts**
(confirmés par cette relecture, cf. `Router.ts:1515-1529` pour l'entrant et
`Router.ts:1975-1997` pour le sortant) :
1. Ordre d'évaluation NAT/ACL inversé par rapport à l'IOS réel dans les deux
   sens (Majeure — confirmé toujours présent, y compris re-confirmé par
   l'audit `02-protocoles-L3-routage.md` du 2026-07-22, postérieur au PRD).
2. Couverture de test bout-en-bout insuffisante (Moyenne).
3. Asymétrie de couverture Huawei en topologie réelle (Moyenne).
4. `ip nat outside source static` décorative (Mineure).
5. `clear ip nat translation`/`reset nat session` filtrés purgent tout au
   lieu de filtrer sélectivement (Mineure — confirmé, `CiscoNATCommands.ts:539-589`,
   `HuaweiNATCommands.ts:247-259`).
6. `ip nat inside source route-map` décorative (Mineure).
7. `nat dns-map`/`nat static enable` (Huawei) décoratives (Mineure).
8. Aucune session dédiée par connexion redirigée (Mineure).

**Nouvel équipement à couvrir — le commutateur L3 Huawei a un NAT
entièrement décoratif.** `HuaweiSwitch.ts:29-30` instancie sa propre
`NATEngine` (`private readonly natEngine = new NATEngine();
_getNATEngine()`), et `HuaweiSwitchShell.ts` expose `nat server`/`nat
static`/`display nat ...` dessus (`_getNATEngine()` référencé à la ligne
3105-3106). Mais **rien dans `Switch.ts` n'appelle jamais
`translateInbound()`/`translateOutbound()`** — confirmé par grep exhaustif :
le seul usage de `_getNATEngine()` côté commutateur est dans les commandes
`display`. Configurer `nat server`/`nat static` sur un commutateur L3 Huawei
aujourd'hui s'affiche, se stocke, mais **ne traduit jamais un seul paquet** —
un gap plus sévère que celui du routeur (qui fait au moins correctement la
moitié DNAT). Ni `PRD-NAT-Port-Forwarding.md` ni l'audit L3 ne mentionnent ce
cas puisqu'ils sont scopés au routeur ; c'est une découverte propre à ce
document.

Côté Cisco, aucun commutateur L3 n'a de `NATEngine` — cohérent, non
revendiqué nulle part, pas un gap.

### 1.B Hôtes Linux (`LinuxPC`/`LinuxServer`) et pare-feux stub — `iptables -j DNAT`

**Document préexistant** : `docs/PRD-Iptables-UFW.md` (v1.0, 2026-07-07)
couvre le moteur `iptables`/`ip6tables`/`ufw` dans son ensemble ; sa seule
mention directe de la fidélité DNAT (§ Phase 2, cité intégralement) est plus
étroite et moins sévère que ce que cette relecture a trouvé :

> « Limite découverte pendant les tests, partagée avec IPv4 : un DNAT vers
> une seconde adresse possédée par le même hôte ne produit pas une
> connexion TCP cohérente de bout en bout, faute de un-NAT/conntrack sur le
> chemin de retour... Non corrigé ici (hors périmètre de ce PRD,
> nécessiterait un moteur de conntrack de retour pour les deux familles). »

Cette limite (mêmes-hôte, pas de un-NAT sur la réponse) est réelle et reste
d'actualité, mais elle **suppose implicitement que la connexion arrive
jusque-là** — ce qui n'est pas le cas, pour une raison plus fondamentale que
ce passage ne mentionne pas (voir bugs A/B ci-dessous).

**Ce qui est réel et solide** (confirmé) : `LinuxIptablesManager.ts`
(1424 lignes) modélise fidèlement les 4 tables/chaînes natives de netfilter
(`filter`{`INPUT`,`FORWARD`,`OUTPUT`}, `nat`{`PREROUTING`,`INPUT`,`OUTPUT`,
`POSTROUTING`}, `mangle`, `raw`), parse `-j DNAT --to-destination`, `-j SNAT
--to-source`, `-j MASQUERADE`, `-j REDIRECT --to-port`. Le branchement dans
le plan de données est réel : `EndHost.ts:1745-1759` (PREROUTING, avant le
choix local/forward) et `EndHost.ts:1822-1899`/`forwardIPv4` (chaîne
FORWARD puis POSTROUTING pour MASQUERADE/SNAT). `ip_forward` (`sysctl
net.ipv4.ip_forward=1`) est un vrai gate testé de bout en bout pour l'ICMP
(`linux-gateway-forwarding.test.ts` — ping/traceroute réels à travers un
`LinuxServer` passerelle), et n'est pas limité à `Router.ts` : tout
`LinuxPC`/`LinuxServer` en hérite via `EndHost.ts:341-342`.

**Bug A (nouveau, non documenté ailleurs) — le port n'est jamais réécrit,
seule l'IP l'est.** `--to-destination`/`--to-source` sont parsés et stockés
sous forme `"ip:port"` intacte, mais uniquement la partie IP est jamais
consommée :

```ts
// EndHost.ts:1751 (PREROUTING)
const newDst = new IPAddress(preNat.address.split(':')[0]);   // le port est jeté
```
```ts
// EndHost.ts:1864-1868 (POSTROUTING/forward, SNAT et DNAT)
} else if (natResult.action === 'SNAT' && natResult.address) {
  try { srcIP = new IPAddress(natResult.address.split(':')[0]); } catch {}
} else if (natResult.action === 'DNAT' && natResult.address) {
  try { dstIP = new IPAddress(natResult.address.split(':')[0]); } catch {}
}
```
Aucun consommateur de `.split(':')[1]` n'existe nulle part dans
`src/network` (grep exhaustif). Concrètement : `iptables -t nat -A
PREROUTING -p tcp --dport 8080 -j DNAT --to-destination 192.168.1.10:80`
réécrit bien la destination vers `192.168.1.10`, mais le paquet arrive
toujours adressé au **port 8080**, pas 80 — le cas d'usage le plus commun
d'un port-forward Linux (« exposer le port interne 80 sous le port externe
8080 ») échoue silencieusement à remapper le port.

**Bug B (nouveau, non documenté ailleurs, plus sévère) — le checksum L4
n'est jamais recalculé après réécriture, cassant silencieusement toute
connexion DNATée.** Seul `headerChecksum` (IPv4) est recalculé aux deux
points de réécriture ci-dessus ; le `checksum` TCP/UDP de la charge utile
n'est jamais touché. Or ce checksum couvre l'adresse IP via le
pseudo-header (RFC 793/RFC 768) :

```ts
// tcp/types.ts:168-175
export function computeTcpChecksum(seg: TcpSegment, srcIp: string, dstIp: string): number {
  ...
  pushPseudoHeader(words, srcIp, dstIp, IP_PROTO_TCP_NUMBER, tcpLen);
```

et la vérification côté récepteur se fait contre les adresses **réelles
post-réécriture** du paquet reçu :

```ts
// TcpStack.ts:584-605
private handleSegment(senderIp, dstIp, seg) {
  if (!verifyTcpChecksum(seg, senderIp, dstIp)) {
    this.dropped(senderIp, seg.sourcePort, 'bad-checksum');
    return true;   // silencieusement rejeté, RFC 9293 §3.1
  }
```

Chaque segment réel porte un checksum authentique calculé contre
l'adresse **pré-NAT** au moment de sa création (`TcpStack.ts:1220,1271`). Un
checksum réel ne validera pas par coïncidence contre une adresse différente
de celle utilisée pour le calculer. **Conséquence : le tout premier SYN de
toute connexion TCP DNATée — et tout datagramme UDP porteur d'un checksum
réel non nul — est silencieusement rejeté comme `bad-checksum` avant même
d'atteindre l'application.** Le même mécanisme s'applique côté UDP
(`verifyUdpChecksum`, `EndHost.ts:2570`, `Router.ts:1797`). Autrement dit :
**le port-forwarding via `iptables -j DNAT` sur un hôte Linux ne fonctionne
aujourd'hui pour aucun trafic TCP/UDP réel**, un défaut plus fondamental que
la limite same-host déjà documentée par `PRD-Iptables-UFW.md` (celle-ci
suppose une connexion qui arrive à son terme ; ici, elle n'y arrive jamais).
Aucun test existant ne le détecte : `linux-iptables.test.ts` (1261 lignes)
teste `evaluateNat()` au niveau moteur avec des `PacketInfo` synthétiques ou
au niveau texte CLI, jamais un vrai `IPv4Packet` porteur d'un payload
TCP/UDP à travers `forwardIPv4`/`handleIPv4` sur des hôtes réellement câblés.

**Défauts secondaires confirmés** :
- `-j REDIRECT --to-port` est parsé/affiché/persisté (`iptables-save`) mais
  n'a **aucun consommateur** dans le plan de données (grep confirmé : seuls
  `'MASQUERADE'`/`'SNAT'`/`'DNAT'` sont testés dans `EndHost.ts`) — mort.
- Les chaînes `INPUT`/`OUTPUT` de la table `nat` existent structurellement
  (créables, listables) mais `evaluateNat()` n'est jamais appelé avec ces
  deux hooks nulle part dans le code — pur décor CLI pour ces deux chaînes
  précises (`PREROUTING`/`POSTROUTING` sont, elles, réellement consultées).

**Équipement** : `firewall-cisco`/`firewall-fortinet`/`firewall-paloalto`
sont toujours des `LinuxPC` littéraux (`DeviceFactory.ts:63-68`, item #46 du
suivi CLAUDE.md, inchangé). Un « pare-feu » peut donc aujourd'hui être
configuré comme boîtier DNAT via de simples commandes Linux, mais hérite des
bugs A/B ci-dessus, et n'a aucune syntaxe native ASA/FortiOS/PAN-OS (`object
network`, `config firewall vip`, règles de zone) — confirmé, aucune classe
de ce type n'existe.

### 1.C Windows (`WindowsPC`/`WindowsServer`) — `netsh interface portproxy`

**Documents préexistants** : `docs/PRD-netsh.md` (2026-07-06) et
`docs/PRD-Windows-Server.md` qualifient tous deux ce sous-système de
« solide »/« OK », et `GAP.md` §9.5 le cite en exemple positif d'architecture
réactive — **les trois caractérisations reposent uniquement sur la
visibilité `netstat`/`ss`, sans distinguer cela d'un relais de trafic réel.
Ce PRD corrige cette caractérisation.**

**Ce qui est réel** : CRUD complet (`PortProxyRule.ts`, `PortProxyTable.ts`),
branché aux deux CLI (`netsh interface portproxy` dans `WinNetsh.ts:495-587`,
et via le même `cmdNetsh()` depuis le shim natif PowerShell), rendu texte
fidèle au format réel, événements bus (`windows.portproxy.added/removed`)
consommés par le journal d'événements Windows (IDs réels 5159/5160).
`PortProxySocketProjection.ts` fait apparaître le port d'écoute dans
`netstat -an`/`ss -tln` en liant une entrée dans `SocketTable`.

**Ce qui n'existe pas du tout : aucun relais de données.**
`PortProxySocketProjection.onAdded()` ne fait que `SocketTable.bind()` — une
pure comptabilité, sans I/O attaché. Une recherche exhaustive de
`connectAddress`/`connectPort` (les champs qu'il faudrait consulter pour
rediriger une connexion) ne trouve de références que dans les cinq fichiers
de définition de la règle elle-même — rien dans le chemin de traitement de
paquets de `WindowsPC.ts`, dans `SocketTable.ts`, ou dans une quelconque
logique d'acceptation de connexion TCP. `handlePortproxyAddSet` se contente
d'ajouter la règle à la table et de retourner (comme le vrai `netsh` sans
sortie). **Configurer un `portproxy` aujourd'hui rend le port visible dans
`netstat`, mais aucune donnée n'est jamais réellement acheminée entre
`listenaddress:listenport` et `connectaddress:connectport`.**

**Pas de routage IP inter-cartes non plus** : `ipForwardEnabled`
(`EndHost.ts:341-342`) n'est mis à `true` que par `LinuxMachine.ts` (le
handler `sysctl net.ipv4.ip_forward`) — grep exhaustif : exactement ces
trois occurrences dans tout le dépôt, aucune côté Windows. `WindowsPC`
hérite de `EndHost` sans jamais redéfinir ce champ ni sa méthode
`forwardIPv4`. Un `WindowsPC`/`WindowsServer` multi-cartes se comporte donc
comme un hôte Linux à `ip_forward=0` en permanence. Ceci n'est pas un défaut
en soi pour `portproxy` spécifiquement — le vrai `netsh interface portproxy`
de Windows est un **relais applicatif** (façon `socat`) qui n'a justement
pas besoin de routage IP pour fonctionner — mais cela signifie que la bonne
architecture de correctif est un relais niveau socket (accepter une
connexion, en ouvrir une seconde vers la cible réelle, faire circuler les
octets), pas un branchement sur un hypothétique routage IP Windows.

Le pare-feu Windows (`netsh advfirewall`/`New-NetFirewallRule`) est, lui,
un moteur réel et branché sur le chemin `in`/`out` (`WindowsPC.firewallFilter()`,
lignes 4907-4950) — mais son `dirMatch` ne connaît que `'Inbound'`/`'Outbound'` ;
un hypothétique trafic `'forward'` (relayé) obtiendrait toujours `accept`,
ce qui est cohérent avec l'absence totale de relais aujourd'hui mais devra
être révisé si la Phase 7 (§3) introduit un vrai relais applicatif.

**Test existant** : `windows-port-forwarding.test.ts` (120 lignes) couvre
CRUD + visibilité `netstat` uniquement — aucune assertion sur un octet
réellement relayé.

### 1.D SSH — redirection de port (`-L`/`-R`/`-D`)

**Documents préexistants, contradictoires entre eux** :
- `docs/BRD-SSH-SFTP.md` (v1.1, 2026-05-05), §3.3 : « SSH port forwarding
  (-L/-R/-D) | Hors scope v1, à réévaluer ».
- `docs/SSH-IMPLEMENTATION-ANALYSIS.md` (2026-05-08, trois jours plus tard)
  affirme **simultanément**, dans le même document, que la fonctionnalité
  est livrée (§1.11/§1.12/§1.16, rayée comme résolue dans son plan de
  remédiation §5 ligne 377) **et** qu'elle est totalement absente (§3.1
  ligne 309 : « Aucun support de -L/-R/-D... » ; §3.5 ligne 335 :
  `| ssh -L/-R/-D | absent |`).
- `docs/tutoriel-ssh.md` (ligne 36, orienté utilisateur) affirme encore
  aujourd'hui que « le port forwarding (-L, -R, -D) » n'est « pas modélisé ».
- `GAP.md` §7.3 qualifie les forwarders de « pedagogical stub » qui « ouvrent
  un canal d'exécution lançant `nc <host> <port>` côté distant » — rated
  Mineure, « RAS fonctionnellement ».

**Aucune de ces quatre caractérisations n'est exacte.** La réalité,
confirmée par lecture directe du code : deux implémentations indépendantes
et non interopérantes existent, ni l'une ni l'autre ne relaie réellement des
octets applicatifs de bout en bout — mais toutes deux ont un effet réel
partiel (listeners réels, poignée de main SOCKS5 réelle, politique serveur
réelle selon le chemin).

**Chemin 1 — terminal interactif** (`LinuxTerminalSession.ts` +
`SshLocalForwarder`/`SshRemoteForwarder`/`SshDynamicForwarder`) : `-L`/`-R`/
`-D`, `-o LocalForward=`/`RemoteForward=`/`DynamicForward=` sont parsés
(`sshArgs.ts:113-290`) et ouvrent de vrais listeners TCP sur le `TcpStack`
simulé. Le `-D` fait une **vraie** poignée de main SOCKS5 (salutation,
parsing CONNECT IPv4/domaine/IPv6). Mais le pontage d'octets, sur les trois
forwarders, passe par un canal `exec` **jamais invoqué** — le commentaire du
code lui-même l'admet sans ambiguïté :

```ts
// SshLocalForwarder.ts:89-96 (identique dans SshRemoteForwarder.ts:82-86, SshDynamicForwarder.ts:131-135)
// Known gap: `ISshExecChannel` only exposes the one-shot `execute()`
// result protocol, not a continuous stream — this bridge was never
// wired to actually pump bytes (matches `execute()` never being called
// here either, so the remote `nc` is never even invoked yet).
```

Ceci contredit directement `GAP.md` §7.3, qui décrit ce chemin comme
« ouvrant un canal lançant `nc` côté distant » comme si cela se produisait
réellement — le commentaire du code dit l'inverse : `execute()` n'est jamais
appelé du tout sur ce chemin.

**Chemin 2 — `executeCommand`** (`LinuxSshClient.ts` +
`SshPortForward.ts`/`SshForwardingTable.ts`, utilisé par
`LinuxPC`/`LinuxServer` et réutilisé par les shells Cisco/Huawei pour `ssh`
sortant) : politique serveur réelle et riche (`AllowTcpForwarding`
y compris blocs `Match`, `GatewayPorts`, `PermitOpen`, `no-port-forwarding`
par clé `authorized_keys`), visibilité réelle dans `SocketTable`
(`ss`/`netstat`). Mais son propre commentaire de module est sans ambiguïté :

```ts
// SshPortForward.ts:11-14
// The simulator does not carry real bytes through the tunnel; it
// reproduces the *observable* surface a tutorial cares about...
```

L'apparence de fonctionnement de bout en bout dans certains tests vient d'un
**raccourci spécifique** : `runSshClient`/`nc` (`LinuxSshClient.ts:762-771`,
`Nc.ts:168-195`), lorsqu'on les pointe vers `127.0.0.1:<port redirigé>`,
consultent eux-mêmes la table de forwarding et re-composent directement vers
la vraie destination — **seules ces deux commandes bénéficient de ce
raccourci**, aucune autre (`curl`, sockets brutes, un navigateur via `-D`)
n'en profiterait.

**Aucun type de canal `direct-tcpip`/`forwarded-tcpip` (RFC 4254 §7) n'existe
nulle part** : `ChannelType` est une union fermée `'shell' | 'exec' |
'sftp'` (`ISshChannel.ts:10`). Le forwarding n'est donc pas construit *à
travers* l'abstraction de canal SSH — il est accolé à côté d'elle.

**Aucun support `LocalForward`/`RemoteForward`/`DynamicForward` dans
`~/.ssh/config`** (`SshConfig.ts`'s `SshHostEntry` : `host`, `hostName`,
`user`, `port`, `identityFile`, `strictHostKeyChecking`,
`hashKnownHosts` — rien d'autre), cohérent avec le scope annoncé par le BRD.

**Ce clivage n'est pas un accident** : `docs/audit/03-transport-services.md`
documente une « double pile SSH » plus large pour le cas interactif en
général et recommande de l'unifier — un chantier déjà suivi séparément dans
ce projet (voir la tâche de suivi correspondante). Le forwarding en a hérité
la duplication, chaque pile avec son propre schéma de config serveur
(`SshSshdConfig` vs `SshdServerConfig`) et sans connaissance l'une de
l'autre.

**Tests existants** : `ssh-lan-localforward.test.ts`,
`ssh-lan-remoteforward.test.ts`, `ssh-lan-dynamicforward.test.ts` (parsers +
cycle de vie des listeners + octets bruts SOCKS5 pour `-D`),
`ssh-permit-open.test.ts`, `ssh-match-block-effective.test.ts`,
`linux-lan-ssh-suite.test.ts` (§33), `cross-equipment-ssh-suite.test.ts`
(§14), `cross-vendor-ssh-domain.test.ts` — riches sur le parsing/la
politique/la visibilité socket, **aucun n'affirme qu'un payload applicatif
réel traverse une connexion tunnelée**.

---

## 2. Objectifs

Chaque objectif précise la ou les couches concernées et, pour les
équipements, quels types sont affectés. Les items 2.10-2.13 délimitent
explicitement le hors-périmètre pour éviter toute ambiguïté entre un gap non
traité et un oubli.

1. **[Routeur, Critique] Corriger la voie retour d'une redirection de port —
   livré (§3 Phase 1).** `NATEngine.translateOutbound()` doit traduire la
   voie retour des entrées statiques orientées port exactement comme elle
   traduit déjà les entrées 1:1/réseau — sans quoi la fonctionnalité ne
   délivre jamais réellement une connexion (§1.A). Le premier test bout-en-
   bout réel a aussi mis au jour un second défaut (checksum L4 jamais
   recalculé après réécriture d'adresse), corrigé dans la même phase.
2. **[Routeur, Majeur] Corriger l'ordre d'évaluation NAT/ACL — livré (§3
   Phase 2).** Reprend tel quel l'objectif 1 de
   `PRD-NAT-Port-Forwarding.md`.
3. **[Routeur, Moyen] Couverture bout-en-bout réelle Cisco et Huawei — livré
   (§3 Phase 3).** Reprend les objectifs 2/3 de `PRD-NAT-Port-Forwarding.md` ;
   TCP+Cisco/Huawei déjà couverts par la Phase 1, UDP ajouté en Phase 3.
4. **[Routeur, Mineur] Commandes de maintenance sélectives — livré (§3
   Phase 3).** (`clear`/`reset` filtrés) — reprend l'objectif 4 de
   `PRD-NAT-Port-Forwarding.md`.
5. **[Routeur, Mineur] `ip nat outside source static` réellement appliquée
   — livré (§3 Phase 3).** Reprend l'objectif 5 de
   `PRD-NAT-Port-Forwarding.md`.
6. **[Commutateur L3 Huawei, Majeur — nouveau] Brancher le `NATEngine` du
   commutateur sur son plan de données — livré (§3 Phase 4).**
7. **[Hôte Linux, Critique — nouveau] Corriger le DNAT/SNAT Linux : réécrire
   le port ET recalculer les checksums L3+L4 — livré (§3 Phase 5).**
   Cf. §3 Phase 5 pour la limite restante (pas d'un-NAT/conntrack sur la
   voie retour, séparée et hors périmètre).
8. **[Hôte Linux, Mineur] `-j REDIRECT` et chaînes `INPUT`/`OUTPUT` de la
   table `nat` — livré (§3 Phase 6).** Décision retenue : câbler le
   comportement réel (validation par chaîne + REDIRECT en PREROUTING +
   DNAT/REDIRECT en OUTPUT pour UDP local), plutôt que documenter comme
   non câblé. Cf. §3 Phase 6 pour ce qui reste honnêtement non câblé (TCP
   en chaîne OUTPUT, SNAT en chaîne INPUT).
9. **[Hôte Windows, Moyen] Construire un vrai relais applicatif pour
   `netsh interface portproxy` — livré (§3 Phase 7).** Corrige la
   caractérisation « solide » des PRDs existants (§1.C, à réconcilier en
   Phase 9). Cf. §3 Phase 7 pour le second bogue indépendant surfacé
   (`TcpStack.flushPendingSends` ignorait `closeAfterFlush` sans donnée en
   attente), également corrigé.
10. **[SSH, Grand chantier] Donner un vrai canal de transport à UNE des deux
    piles de forwarding — livré (§3 Phase 8).** Chemin retenu :
    `executeCommand`/`LinuxSshClient.ts`, seul réellement exercé par tous
    les vendors aujourd'hui — `-L`/`-R` relaient désormais réellement les
    octets vers `destHost:destPort` réel, via `TcpStack` déjà réel. `-D`
    reste non câblé (pas d'analyse SOCKS5 dans cette pile). Cf. §3 Phase 8
    pour le second correctif indépendant qu'écrire le test a révélé
    nécessaire (absence totale de livraison TCP loopback).
11. **[Documentation, Mineur] Réconcilier les quatre documents contradictoires
    identifiés en §1 — livré (§3 Phase 9).** `GAP.md` §4.10 (ALG FTP maintenant réel, note
    obsolète), `GAP.md` §7.3 (description du canal `nc` ne correspond pas au
    code actuel), `docs/PRD-netsh.md`/`docs/PRD-Windows-Server.md`
    (caractérisation « solide » de `portproxy` à corriger une fois
    l'objectif 9 traité, ou à nuancer immédiatement sinon),
    `docs/BRD-SSH-SFTP.md`/`docs/SSH-IMPLEMENTATION-ANALYSIS.md`/
    `docs/tutoriel-ssh.md` (statut du forwarding SSH), `docs/roadmap.md`
    (généré 2026-03-25, entièrement stale sur NAT/PAT — à ne plus utiliser
    comme source de gap sans vérification).
12. **[Hors périmètre] Syntaxe native ASA/FortiOS/PAN-OS.** Non traité ici —
    chantier séparé, non borné, déjà noté dans `CLAUDE.md`.
13. **[Hors périmètre] NAT64, ALG SIP, parité IPv6/NAT66 byte-exact,
    X11/agent forwarding SSH, `UDP ASSOCIATE`/`BIND` SOCKS5, routage IP
    natif inter-cartes Windows.** Chacun déjà noté ou hors scope ailleurs
    (§0).

---

## 3. Plan de remédiation détaillé

L'ordre suit la sévérité du défaut (silencieux et non détecté par les tests
existants en premier) puis le rayon d'impact (code partagé par tout le
trafic routé/switché/reçu avant le code spécifique au NAT).

### Phase 1 — Routeur : voie retour d'une redirection de port (objectif 1)

- **Fichiers touchés** : `NATEngine.ts` (`translateOutbound()`, retirer
  l'exclusion `if (entry.protocol) continue;` et lui faire consulter les
  entrées orientées port symétriquement à `translateInbound()` — traduire
  la source, pas la destination, en miroir de `rewriteDestIP`).
- **Tests** : nouveau test bout-en-bout — topologie avec un hôte interne
  exécutant un vrai service à l'écoute sur le port interne, redirection
  Cisco (`ip nat inside source static tcp`) **avec une règle overload
  coexistante** (le cas réel des labs existants), connexion initiée depuis
  un hôte extérieur, assertion sur la réponse effectivement reçue par le
  client — pas seulement un compteur de hits. Variante sans règle overload
  coexistante (vérifier qu'il n'y a plus de fuite d'adresse privée).
  Variante Huawei (`nat server`) miroir. Ceci ferme en grande partie
  l'objectif 3 (couverture bout-en-bout) au passage.
- **Livré** (`NATEngine.ts`, `nat-port-forward-reply-leg.test.ts`). Le
  premier vrai test bout-en-bout de ce PRD (`TcpStack.connect()`/`.listen()`
  à travers un `CiscoRouter`/`HuaweiRouter` réel, plutôt que le raccourci
  `nc`/`findHostByAddress`) a immédiatement révélé un **second défaut**,
  non documenté nulle part avant ce PRD : `rewriteSrcIP()`/`rewriteDestIP()`
  ne recalculaient que `headerChecksum` (IPv4) après avoir changé une
  adresse — jamais le checksum TCP/UDP de la charge utile, qui couvre
  pourtant les adresses IP via le pseudo-header. Un routeur NATé rejetait
  donc silencieusement en `bad-checksum` jusqu'au tout premier SYN d'une
  connexion redirigée, indépendamment du défaut de voie retour ci-dessus —
  les deux corrections étaient nécessaires pour qu'un test de livraison
  réelle passe. Nouvelle fonction partagée `recomputeL4Checksum()`, appelée
  par `rewriteSrcIP()`/`rewriteDestIP()` chaque fois qu'une adresse ou un
  port est réécrit. Vérifié par git-stash (les 5 tests échouent
  authentiquement sans les deux correctifs) et par régression complète des
  suites NAT/ACL/routage de base (767 tests, §4).

### Phase 2 — Routeur : ordre d'évaluation NAT/ACL (objectif 2)

- **Livré** (`Router.ts`, `nat-acl-evaluation-order.test.ts`). Reprend telle
  quelle la conception détaillée de `PRD-NAT-Port-Forwarding.md` §3 Phase 1 :
  dans `processIPv4()`, l'ACL entrante (`deniedByInboundACL`) est désormais
  évaluée avant `translateInbound()` (DNAT) — elle voit donc l'adresse
  publique telle que le client l'a réellement ciblée, pas déjà réécrite vers
  l'adresse privée. Dans `forwardPacket()`, `translateOutbound()` (SNAT/PAT)
  s'exécute désormais avant la vérification de l'ACL sortante — elle voit
  donc l'adresse publique post-traduction telle qu'elle sort réellement sur
  le fil, pas l'adresse privée pré-traduction. Auparavant les deux ACL
  voyaient le mauvais côté de la traduction : une ACL écrite contre
  l'adresse publique (le cas d'usage réel pour du port-forwarding) ne
  matchait jamais rien en entrée ni en sortie.
- **Tests** : nouveau fichier `nat-acl-evaluation-order.test.ts`, 6 cas —
  permit/deny/no-ACL en entrée (contre l'adresse publique pré-DNAT) et en
  sortie (contre l'adresse publique post-SNAT). Vérifié par git-stash : les
  4 cas permit/deny échouent authentiquement sans le correctif (les 2 cas
  « no ACL » ne dépendent pas de l'ordre et restent verts dans les deux
  cas, ce qui est le comportement attendu). Un premier jet du test sortant
  utilisait une regex `/0% packet loss/` qui matchait aussi bien "0%" que
  "100%" packet loss (sous-chaîne commune) et ne discriminait donc rien —
  corrigé en ancrant sur `/, 0% packet loss/`/`/, 100% packet loss/`
  (le format exact de la ligne de statistiques ping). Régression complète
  des suites NAT/ACL/routage de base (§4) : 797 tests sur 42 fichiers
  NAT/ACL + 196 tests sur les suites routage/OSPF de base, tous verts.

### Phase 3 — Routeur : couverture Huawei + maintenance sélective + `outside static` (objectifs 3-5)

- **Livré.** Reprend les Phases 2b/3/4 de `PRD-NAT-Port-Forwarding.md` §3.
- **Couverture UDP + Huawei (objectif 3)** : `nat-port-forward-reply-leg.test.ts`
  (Phase 1) couvrait déjà Cisco et Huawei en TCP avec un vrai `TcpStack` bout
  en bout — seul le volet UDP manquait. `buildCiscoLab`/`buildHuaweiLab` ont
  gagné un paramètre `protocol` (`'tcp' | 'udp'`, défaut `'tcp'`, aucune
  régression sur les 5 tests existants) et un nouveau describe UDP (4 tests)
  fait transiter un vrai datagramme aller-retour (`udpBind`/`sendUdpDatagram`)
  à travers `ip nat inside source static udp`/`nat server protocol udp`, avec
  et sans PAT/`nat outbound` coexistant.
- **Maintenance sélective (objectif 4)** : `clear ip nat translation
  inside|outside|vrf|pool <critère>` (Cisco) et `reset nat session inside
  <ip>` (Huawei) validaient déjà leur argument puis appelaient
  inconditionnellement `clearTranslations()` (purge totale) — confirmé par
  lecture de `CiscoNATCommands.ts`/`HuaweiNATCommands.ts` et par les tests
  existants (`nat-pat-other.test.ts` 205-208/231-234/338-341), qui
  n'asserted que `output.trim() === ''`, jamais la survie des sessions non
  ciblées. Nouvelle méthode `NATEngine.clearTranslationsFiltered(filter)`
  (`insideIP`/`outsideIP`/`poolName`/`ifaces`) filtre réellement les
  sessions dynamiques avant suppression ; `ifaces` (utilisé pour `vrf
  <name>`) matche `NatSession.inIface` faute de champ `vrf` propre à la
  session. Nouveau fichier `nat-selective-clear.test.ts` (6 tests, 2
  vendors) : deux hôtes derrière le même routeur créent chacun une session
  dynamique distincte (overload, pool, ou destination différente selon le
  test), la purge filtrée ne retire que la session ciblée. Vérifié par
  git-stash : les 4 cas filtrés échouent authentiquement sans le correctif,
  les 2 cas `*`/`all` (non filtrés, pas de régression) restent verts dans
  les deux cas.
- **`ip nat outside source static` (objectif 5, Cisco uniquement)** :
  `NatOutsideStatic`/`addOutsideStatic()`/`getOutsideStaticEntries()`
  existaient déjà (stockage + rendu `show running-config`) mais
  `translateInbound()`/`translateOutbound()` ne les consultaient jamais.
  `translateInbound()` résout maintenant la traduction *avant* le lookup
  FIB — l'alias local (`outsideLocal`) n'est par construction jamais une
  adresse routable, donc la traduction doit précéder la décision de
  routage plutôt que la suivre : un paquet entrant sur l'interface outside
  dont la source correspond à `outsideGlobal` (l'hôte réel) est réécrit
  vers `outsideLocal` ; un paquet entrant sur l'interface inside dont la
  destination correspond à `outsideLocal` est réécrit vers `outsideGlobal`.
  Les deux traductions se composent avec les chemins existants (session
  PAT inverse, entrées statiques classiques) au lieu de leur faire
  concurrence par un retour anticipé, pour rester correct si les deux
  s'appliquent au même paquet. Nouveau fichier `nat-outside-static.test.ts`
  (3 tests) : un hôte interne adressant l'alias atteint réellement l'hôte
  externe (vérifié via `udpBind`/`sendUdpDatagram`, pas seulement un ping),
  un datagramme émis par l'hôte externe se présente au réseau interne sous
  son alias, et sans la commande l'alias reste injoignable (non-régression,
  confirmé par git-stash — les 2 premiers cas échouent authentiquement).
- Régression complète des suites NAT/ACL/routage de base (§4) : 810 tests
  sur 44 fichiers NAT/ACL (incluant les 3 nouveaux fichiers de cette phase)
  + 93 tests routage/UDP/fragmentation de base, tous verts.

### Phase 4 — Commutateur L3 Huawei : brancher le NAT sur le plan de données (objectif 6)

- **Livré.** Le point d'entrée IPv4 du commutateur n'est pas dans
  `Switch.ts` mais dans `SwitchSvi.ts` (`intercept()`/`forwardIpPacket()`,
  l'équivalent de `Router.processIPv4()`/`forwardPacket()`) ; `Router` et
  `Switch` n'ont aucune base L3 commune (tous deux étendent `Equipment`, qui
  n'offre ni routage ni NAT), donc le branchement est dupliqué plutôt que
  factorisé — cohérent avec le reste du fichier (RIB/FIB, ARP, ICMP sont
  déjà des implémentations séparées entre les deux classes).
  `SviHost` (l'interface que `SwitchSvi` consomme) gagne trois méthodes
  optionnelles — `natTranslateInbound`/`natTranslateOutbound`/
  `natIsOutsideInterface` — implémentées dans l'adaptateur `Switch.ts` par
  délégation à `_getNATEngine()` (duck-typing déjà standard pour cet accès
  dans tout le dépôt, absent sur `GenericSwitch`/`CiscoSwitch` donc no-op
  pour eux). `intercept()` appelle `natTranslateInbound()` juste après le
  test `forUs` et avant la décision livraison-locale/transit (même ordre
  que `Router.processIPv4()`) ; `forwardIpPacket()` appelle
  `natTranslateOutbound()` juste après le décrément TTL et le recalcul du
  checksum, avant `egressOnVlan()` (même ordre que `forwardPacket()`),
  avec la même détection de hairpin (RFC 5382 §5) que le routeur. Les deux
  interfaces sont désignées par leur nom `Vlanif<n>` (pas le port physique
  d'ingress) — c'est la configuration réaliste pour du NAT sur commutateur
  L3 Huawei (`interface Vlanif10` / `interface Vlanif20`), et cela évite
  toute ambiguïté entre plusieurs ports physiques pouvant porter le même
  VLAN.
  **Bug indépendant découvert en écrivant le test e2e** : `HuaweiSwitch.ts`
  instancie son propre `NATEngine` depuis toujours, mais ne lui a *jamais*
  fourni `setACLMatchFn()`/`setInterfaceIPFn()` (contrairement à
  `Router.ts`, qui les câble dans son constructeur) — `nat outbound <acl>`
  aurait donc échoué silencieusement même une fois le plan de données
  branché : `getIfaceIPFn` valant `undefined`, `globalIP` restait
  toujours `null` dans la branche `overload` de `translateOutbound()`, qui
  `continue`ait sans jamais traduire. Corrigé dans le constructeur de
  `HuaweiSwitch.ts` : `setInterfaceIPFn` résout `Vlanif<n>` via
  `getSvi(n)?.ip`, `setACLMatchFn` délègue à `getVaclEngine().evaluateACLByName()`
  (le même moteur ACL déjà utilisé par le VACL/traffic-filter du
  commutateur, confirmé alimenté par `rule <n> permit ...` sous `acl <n>`
  via `HuaweiSwitchShell.parseVrpAclRule()`).
- **Tests** : nouveau fichier `huawei-l3-switch-nat.test.ts` (4 cas) —
  topologie à deux VLANs/SVIs sur un seul commutateur (VLAN10 inside/VLAN20
  outside), `nat server protocol tcp` (poignée de main TCP réelle +
  aller-retour de données, miroir du test Phase 1) et `nat outbound`
  (PAT dynamique, vérifie que le pair distant observe bien l'adresse
  Vlanif20 traduite via `TcpSocket.remoteIp`, pas l'adresse privée
  d'origine). Vérifié par git-stash sur les trois fichiers source
  modifiés : les 3 cas dépendant de l'ordre échouent authentiquement
  (poignée de main bloquée en `syn-sent`, adresse source non traduite),
  le cas « pas de nat server configuré » reste vert dans les deux cas.
  Régression complète : 646 tests sur 26 fichiers switch/SVI/inter-VLAN/
  DHCP-relay/FHRP/NAT, tous verts.

### Phase 5 — Hôte Linux : réécriture de port + recalcul des checksums (objectif 7)

- **Livré** (`EndHost.ts`, `linux-dnat-port-forward.test.ts`). Bug A (port
  jamais réécrit) et Bug B (checksum L4 jamais recalculé) corrigés
  ensemble : nouveaux helpers module-scope `parseNatAddress()` (parse
  `ip:port`/`ip` tel qu'accepté par `--to-destination`/`--to-source`) et
  `rewriteNatAddress()` (réécrit IP+port puis recalcule `headerChecksum`
  **et** le checksum TCP/UDP via `computeTcpChecksum`/`computeUdpChecksum`,
  déjà réels), un petit helper partagé entre les deux points d'appel
  (PREROUTING et POSTROUTING/forward) plutôt qu'une duplication — conforme
  à la conception envisagée, sans aller chercher à l'unifier avec les
  helpers homonymes de `router/NATEngine.ts` (portée plus large, non
  demandée).
- **Ce qui marche réellement, vérifié empiriquement, pas supposé** : un
  `SYN`/datagramme UDP réel traverse désormais une redirection `iptables
  -j DNAT` et est correctement démultiplexé par le serveur interne sur le
  bon port (`localPort`), avec la bonne adresse source observée
  (`remoteIp`) — avant ce correctif, le tout premier segment réel était
  rejeté en silence comme `bad-checksum`. Pour UDP (sans état de connexion
  à faire correspondre), l'aller-retour complet fonctionne : le serveur
  interne peut répondre directement à l'adresse réelle du client externe
  et celui-ci la reçoit.
- **Ce qui ne marche délibérément pas, et pourquoi ce n'est pas un
  oubli** : pour TCP, la poignée de main complète ne se termine PAS
  (`clientSocket.state` reste `syn-sent`) — vérifié empiriquement, pas
  supposé. Le SYN-ACK du serveur interne part avec sa propre adresse
  réelle (`192.168.10.10:80`), pas l'adresse publique que le client a
  composée (`203.0.113.1:8080`) : ce moteur n'a aucun un-NAT/conntrack sur
  la voie retour — la limite déjà documentée par `PRD-Iptables-UFW.md`
  (« hors périmètre de ce PRD, nécessiterait un moteur de conntrack de
  retour ») et confirmée ici s'appliquer plus largement que son unique cas
  testé (« une seconde adresse possédée par le même hôte ») : `TcpStack`
  démultiplexe par correspondance exacte de
  `(localIp,localPort,remoteIp,remotePort)`, donc un segment venant d'une
  adresse différente de celle composée n'est jamais reconnu, quel que soit
  l'hôte visé. Conséquence RFC-correcte observée : le client, ne
  reconnaissant pas ce segment, envoie un RST (RFC 9293 §3.10.7.1), qui
  referme la socket `syn-received` du serveur — d'où les tests qui
  capturent l'état du serveur *au moment de l'acceptation* plutôt
  qu'après le retour de `connect()`. Implémenter un vrai un-NAT/conntrack
  pour ce moteur serait un chantier séparé, plus large que « port +
  checksum », et n'est pas tenté ici.
- **Tests** : nouveau fichier `linux-dnat-port-forward.test.ts` (4 cas) —
  vraie topologie (client externe, passerelle `LinuxServer` avec
  `sysctl net.ipv4.ip_forward=1` + `iptables -t nat -A PREROUTING ... -j
  DNAT --to-destination <ip>:<port-différent>`, serveur interne
  réellement à l'écoute), TCP (SYN livré et démultiplexé, cf. limite
  ci-dessus) et UDP (aller-retour complet). Cas supplémentaire : port
  externe différent du port interne (le cas que Bug A cassait
  spécifiquement). Vérifié par git-stash : les 4 cas échouent
  authentiquement sans le correctif. Régression complète : 222 tests sur
  14 fichiers iptables/ip6tables/UDP/fragmentation + 65 tests TCP de base,
  tous verts.

### Phase 6 — Hôte Linux : `-j REDIRECT` et chaînes `nat` INPUT/OUTPUT (objectif 8) — livrée

**Décision retenue** : câbler le comportement réel plutôt que documenter
`REDIRECT` comme non câblé. Le périmètre exact a été établi empiriquement,
contre un vrai binaire `iptables` (v1.8.10, disponible dans le bac à sable
de développement) plutôt que supposé de mémoire :

| Cible | Chaînes réellement acceptées (vérifié) |
|---|---|
| DNAT | PREROUTING, OUTPUT |
| REDIRECT | PREROUTING, OUTPUT |
| SNAT | POSTROUTING, INPUT |
| MASQUERADE | POSTROUTING uniquement |

`-A INPUT -j DNAT` échoue réellement sur un vrai Linux avec
`RULE_APPEND failed (Invalid argument): rule in chain INPUT` (exit 4) — ce
n'est pas un détail théorique, c'est ce que le noyau répond. Trois volets
livrés dans `LinuxIptablesManager.ts`/`EndHost.ts`/`LinuxMachine.ts` :

1. **Validation CLI par chaîne** (`natTargetChainError()`, table
   `NAT_TARGET_HOOKS`) : `cmdAppend`/`cmdInsert`/`cmdReplace` rejettent
   désormais un DNAT/REDIRECT/SNAT/MASQUERADE placé dans une chaîne native
   de la table `nat` que son masque de hook réel ne couvre pas, avec le
   message et le code de sortie exacts observés ci-dessus (`RULE_INSERT`/
   `RULE_REPLACE` pour `-I`/`-R`). Une chaîne utilisateur n'est pas
   remontée jusqu'à la ou les chaînes natives qui peuvent y sauter — hors
   périmètre, comme le reste de l'analyse d'atteignabilité des chaînes
   dans ce fichier.
2. **REDIRECT en PREROUTING** — `EndHost.handleIPv4` consomme désormais
   `preNat.action === 'REDIRECT'` (auparavant parsé par le CLI puis jamais
   lu par le plan de données) : la destination est réécrite vers l'adresse
   locale du port d'entrée (il n'y a pas de `--to-destination` à lire pour
   REDIRECT, seulement un `--to-ports` optionnel), en réutilisant
   `rewriteNatAddress()`/`parseNatAddress()` de la Phase 5.
3. **DNAT/REDIRECT en OUTPUT** pour le trafic UDP généré localement — un
   nouveau point d'extension `EndHost.evaluateNatOutput()` (implémenté dans
   `LinuxMachine.ts` via `executor.iptables.evaluateNat(pkt, 'OUTPUT')`,
   `evaluateNat()` élargi pour accepter ce hook) est consulté au tout début
   de `sendUdpDatagram()`, avant la livraison locale/multicast/broadcast —
   à l'image de l'ordre réel de Linux (décision de routage précoce, puis
   hook LOCAL_OUT, puis re-décision si la destination a changé). REDIRECT
   correspond au cas réel « pas de `--to-destination` » : le datagramme est
   mappé vers l'adresse de boucle locale, jamais vers une interface de
   sortie (il n'y a pas d'« interface entrante » pour un paquet que cet
   hôte origine lui-même).

**Constat empirique notable, documenté honnêtement dans le test** :
REDIRECT-en-PREROUTING retombe dans la même asymétrie de voie retour que
le DNAT inter-hôtes de la Phase 5, même quand l'adresse de destination ne
change pas. Dès que le PORT de destination change, le SYN-ACK renvoyé porte
ce nouveau port source — qui ne correspond plus à ce que le client a
composé — et le démultiplexage à 4-uplets exact de `TcpStack` ne reconnaît
toujours pas la réponse. Ce n'est donc pas une particularité du cas
« redirection vers un autre hôte » : c'est la même cause profonde (absence
de table de sessions retour/un-NAT pour ce moteur iptables), qui touche
aussi bien une redirection vers un port local différent. Le test TCP de
cette phase s'arrête donc, comme celui de la Phase 5, à « le SYN atteint le
port redirigé », pas à l'établissement complet.

**Délibérément non câblé, et documenté comme tel plutôt que silencieusement
absent** :
- **TCP en chaîne OUTPUT** : contrairement à UDP (`sendUdpDatagram`, un
  point d'entrée unique déjà équipé du hook `firewallFilter('out')`),
  `TcpStack.transmit()`/`shipSegment()` n'a AUCUN point d'extension chaîne
  `OUTPUT` — ni pour la table `filter`, ni a fortiori pour `nat` — un
  segment TCP sortant issu d'un socket local ne traverse aujourd'hui aucune
  évaluation firewall/NAT locale. Corriger cela reviendrait à greffer un
  nouveau point d'extension sur le chemin d'émission le plus chaud du
  moteur TCP tout entier — un chantier séparé, plus large, non entrepris
  ici.
- **SNAT en chaîne INPUT** : réel sur Linux (vérifié ci-dessus) mais sans
  aucun point d'ancrage architectural dans ce simulateur — il n'existe nulle
  part de notion « ce que verrait un processus local de l'adresse source
  d'un pair » à réécrire. La validation CLI accepte donc la règle (comme un
  vrai Linux), mais aucune donnée ne la consomme.
- Chaîne utilisateur atteinte depuis plusieurs chaînes natives à la fois
  (l'une valide pour la cible, l'autre non) : non tracée, cf. §1 ci-dessus.

**Tests** : `linux-nat-redirect-output.test.ts` (14 cas — 9 validations
CLI par chaîne incluant les cas de non-régression sur les usages déjà
existants de DNAT/SNAT/MASQUERADE/REDIRECT dans tout `src/__tests__`
[tous déjà placés dans une chaîne valide, confirmé par grep avant
d'écrire ce correctif], 2 REDIRECT-en-PREROUTING, 3 nat-OUTPUT UDP).
Discriminé par git-stash : les 8 cas dépendant de l'ordre échouent
authentiquement avant correctif, les 6 cas de non-régression passent dans
les deux cas.

### Phase 7 — Windows : relais applicatif réel pour `portproxy` (objectif 9) — livrée

**Fichier touché, comme prévu** : `PortProxySocketProjection.ts` — `onAdded()`
appelle désormais, en plus du `SocketTable.bind()` préexistant (visibilité
`netstat`, inchangée), un vrai `TcpStack.listen()` sur `listenaddress:listenport`
dont le `onAccept` compose une vraie `TcpStack.connect()` vers
`connectaddress:connectport` puis relaie les octets dans les deux sens
(`relay()`) — un pont applicatif (façon `socat`), exactement ce que
`iphlpsvc` fait réellement, sans aucun routage IP impliqué. `onRemoved()`
appelle symétriquement `TcpStack.closeListener()`. `WindowsPC.ts` passe
désormais `this.getTcpStack()` au constructeur de la projection (seul point
d'appel, partagé avec `WindowsServer` qui hérite de `WindowsPC`).

Contrairement aux réécritures NAT des Phases 5-6, ceci ne modifie AUCUNE
adresse : ce sont deux connexions TCP ordinaires et indépendantes de part et
d'autre du relais, donc — contrairement à un redirect NAT — pas d'asymétrie
de voie retour : les deux legs atteignent réellement `established` et
transportent des données dans les deux sens.

**Second bogue indépendant surfacé en écrivant le test** (même schéma que
plusieurs phases précédentes de ce document) : `TcpStack.flushPendingSends()`
retournait immédiatement si `pendingSendQueue.length === 0`, AVANT même de
lire `closeAfterFlush` — un `.close()` appelé pendant `onAccept()`/juste
après `connect()` (donc encore `syn-received`/`syn-sent`) sans qu'aucune
donnée n'ait jamais été mise en attente restait silencieusement sans effet
pour toujours : la socket ne se fermait jamais. C'est exactement le chemin
d'erreur du relais (fermer immédiatement le côté accepté si la connexion
vers la vraie cible est refusée, avant tout envoi) — sans le correctif, une
règle `portproxy` pointant vers un port sans service réel aurait laissé la
connexion du client bloquée indéfiniment en `established` plutôt que
refusée. Corrigé en sortant la vérification de `closeAfterFlush` de la
garde `pendingSendQueue.length === 0` (`TcpStack.ts`). Aucun test existant
ne référence `closeAfterFlush` ni ne ferme une socket pendant `onAccept`
sans envoi préalable (confirmé par grep) — correctif sans risque de
régression connu.

**Tests** : `windows-portproxy-relay.test.ts` (5 cas — relais réel
client→serveur, réponse serveur→client, fermeture propagée, refus propre
quand la cible n'a pas de service réel à l'écoute, non-régression
`netstat`) et un cas ajouté à `tcp-handshake-close-lifecycle.test.ts`
(`closeAfterFlush` avec file vide) pour isoler le second bogue
indépendamment du relais. Discriminé par git-stash séparément pour les deux
correctifs : 3 des 5 cas du relais échouent authentiquement sans le relais
réel (état `closed` au lieu de `established`, aucune donnée reçue, pas de
propagation de fermeture), 2 passent dans les deux cas (refus sans service
réel, `netstat`) ; le cas `closeAfterFlush` échoue authentiquement seul
avec seulement `TcpStack.ts` remisé (reste `established` pour toujours).

### Phase 8 — SSH : canal de transport réel pour une pile de forwarding (objectif 10) — livrée

**Pré-requis vérifié avant de démarrer** : le chantier séparé « unifier SSH
cross-vendor sur le vrai pipeline TCP/SshServerHandler » (suivi ailleurs
dans ce projet) est resté à l'état *pending*, aucun commit ne l'a touché —
démarrer cette phase ne duplique ni ne recoupe un travail en cours.

**Choix de la pile** : le chemin `executeCommand`/`LinuxSshClient.ts` (§1.D,
« Chemin 2 »), seul réellement exercé par tous les vendors aujourd'hui —
pas `LinuxTerminalSession.ts`/`SshLocalForwarder`/`SshRemoteForwarder`/
`SshDynamicForwarder` (« Chemin 1 »), le chemin interactif, entrelacé avec
le chantier d'unification ci-dessus et donc délibérément non touché ici.

**Fichiers touchés, comme prévu** : `SshForwardingTable.ts` gagne un
`TcpStack` optionnel côté écoute (passé par `LinuxCommandExecutor.ts` via
la référence `localDevice` déjà câblée) et un paramètre `dialStack` sur
`open()` — la voie sortante du TUNNEL, PAS la machine qui possède
l'écouteur : `-L`/`-D` dialent depuis le SERVEUR SSH, `-R` dialent depuis
le CLIENT SSH, exactement la sémantique réelle d'OpenSSH. `LinuxSshClient.ts`
câble les deux sens dans `setupPortForwards()` : `machine.getTcpStack()`
(le serveur, déjà typé) pour `-L`/`-D`, un cast étroit de
`opts.sourceDevice` (le client) pour `-R`. `-D` reste non câblé — cette
pile n'a aucune analyse SOCKS5 pour déterminer une destination (le
« Chemin 1 » en a une, mais aucun relais non plus ; combler les deux à la
fois aurait démesurément élargi le périmètre) — décision explicite, pas un
oubli. Contrairement aux Phases 5-6, ceci ne réécrit aucune adresse :
deux connexions TCP réelles et indépendantes de part et d'autre du relais,
donc pas d'asymétrie de voie retour façon NAT — les deux legs atteignent
réellement `established`.

**Second bogue indépendant surfacé en écrivant le test, plus large que les
précédents** : `TcpStack` n'avait AUCUNE voie de livraison loopback —
`resolveEgress()` échouait purement et simplement pour `127.0.0.1`/`::1`
(confirmé empiriquement avant correctif, pour n'importe quel consommateur
de `TcpStack`, pas seulement SSH). Or `-L`/`-R` se lient à `127.0.0.1` par
défaut (comme le vrai OpenSSH) — sans correctif, le relais ci-dessus
n'aurait eu aucun écouteur atteignable pour le cas courant, sans adresse
de liaison explicite. Corrigé dans `resolveEgress`/`resolveEgress6`/
`shipSegment` (`TcpStack.ts`) : une destination loopback est désormais
livrée directement en interne, sans jamais construire de trame Ethernet —
calquant exactement le raccourci déjà établi et accepté de
`EndHost.sendUdpDatagram` pour UDP. Le correctif est strictement additif
(un nouveau cas de retour anticipé) : le chemin non-loopback existant n'est
pas touché, et `resolveEgress`/`resolveEgress6` échouaient déjà purement et
simplement pour ces adresses avant le correctif, donc rien ne pouvait déjà
dépendre de leur ancien comportement. Confirmé par une suite `tcp-*.test.ts`
complète (10 fichiers, 64 tests) verte avant et après.

**Tests** : `ssh-forwarding-real-relay.test.ts` (3 cas — relais réel `-L`
avec vérification explicite que la connexion sortante provient bien du
SERVEUR, relais réel `-R` avec vérification qu'elle provient bien du
CLIENT, non-régression quand la cible réelle n'a pas de service à
l'écoute). Discriminé par git-stash à deux niveaux : les 2 cas
dépendant de l'ordre échouent authentiquement avec les quatre fichiers
remisés ensemble, et échouent identiquement avec SEULEMENT `TcpStack.ts`
remisé (isolant le correctif loopback du câblage du relais) ; le 3ᵉ cas
passe dans tous les cas.

### Phase 9 — Documentation (objectif 11) — livrée

- `docs/PRD-netsh.md`/`docs/PRD-Windows-Server.md` : caractérisation
  « solide » de `portproxy` nuancée avec le relais applicatif réel livré
  en Phase 7.
- `docs/BRD-SSH-SFTP.md` §3.3 : la ligne d'exclusion unique
  `-L/-R/-D — hors scope v1` éclatée en deux lignes exactes (`-D` seul et
  la pile interactive restent hors scope ; ajout d'une note que `-L`/`-R`
  via `executeCommand`/`LinuxSshClient.ts` ne le sont plus depuis la
  Phase 8).
- `docs/SSH-IMPLEMENTATION-ANALYSIS.md` : §1.11/§1.12/§1.16 complétés d'un
  « écart connu » (le bridge exec `nc` de ce chemin — Chemin 1,
  `LinuxTerminalSession` — n'a jamais pompé d'octets, `execute()` n'y est
  même jamais appelé) ; §3.1 et §3.5 (qui affirmaient encore `-L/-R/-D`,
  `ssh-add`/`ssh-agent` et `-t` « absents ») corrigés en style
  barré-renvoi comme le fait déjà §3.3 pour rester cohérents avec
  §1.11-§1.16.
- `docs/tutoriel-ssh.md` ligne 36 : « port forwarding non modélisé » →
  état réel (parser/listener réels, relais de données réel seulement via
  `ssh user@host <commande>`).
- `docs/roadmap.md` : bandeau de péremption ajouté en tête (document
  généré 2026-03-25, largement obsolète tous sujets confondus) + note
  ciblée en §14.1 (NAT/PAT déjà livré, voir `CLAUDE.md`/ce PRD plutôt que
  le tableau).
- `GAP.md` §4.10 (ALG FTP réel depuis `PRD-FTP-SFTP.md`, hors périmètre
  Port-Forwarding — seuls SIP/NAT64 restent non implémentés ; la ligne
  CLI `show ip nat statistics` elle-même n'a volontairement pas été
  touchée, cette phase étant documentation seule), §7.3 (description du
  bridge `nc` corrigée : plus grave que documenté, `execute()` jamais
  appelé donc rien n'est jamais bridgé sur ce chemin), §9.5 (note ajoutée
  sur `PortProxySocketProjection`, classe distincte de
  `PortProxyTable`/`WindowsServicePortProjection`, qui porte désormais un
  vrai relais depuis la Phase 7).

---

## 4. Exigences de non-régression

Chaque phase est additive et testée ; le comportement observable des suites
déjà vertes ne doit pas régresser.

- **Routeur (Phases 1-4)** : `nat-pat.test.ts`, `nat-pat-other.test.ts`,
  tous les `scenario-cisco-nat-*.test.ts`, `scenario-cisco-port-forwarding.test.ts`,
  `ftp-alg-nat.test.ts`, `nat-icmp-pat.test.ts`,
  `scenario-nat-pat-uniqueness.test.ts`, `scenario-double-nat-traceability.test.ts`,
  suites ACL (`ssh-cisco-acl-*.test.ts`, `scenario-multilayer-acl-coherence.test.ts`).
  La Phase 2 touche un chemin partagé par tout trafic routé (NATé ou non) —
  exiger en plus la régression complète des suites `router-*`/
  `inter-vlan-routing.test.ts`/`debug/router/*`.
- **Commutateur L3 Huawei (Phase 4)** : suites de commutation Huawei
  existantes (`huawei-stp.test.ts`, `scenario-vrp-stp-lacp.test.ts`, etc.) —
  brancher le NAT sur le plan de données ne doit rien changer pour le
  trafic non concerné par une règle NAT.
- **Hôte Linux (Phases 5-6)** : `linux-iptables.test.ts`,
  `ip6tables-nat66-prerouting.test.ts`, `iptables-dispatch-unification.test.ts`,
  `linux-gateway-forwarding.test.ts`, `iptables-mark-notrack.test.ts`,
  `iptables-reject-with.test.ts`, `linux-iptables-nftables-persistence.test.ts`.
  La Phase 5 touche `EndHost.ts`'s chemin de réception de paquet partagé par
  **tout** trafic IP sur **tout** hôte Linux/Windows (via héritage) — exiger
  en plus la régression complète des suites ARP/DHCP/ICMP/TCP/UDP/IPsec de
  base, pas seulement les suites NAT.
- **Windows (Phase 7)** : `windows-port-forwarding.test.ts`,
  `windows-ps-cmd-shared-state.test.ts`, `ps-network-command.test.ts`.
- **SSH (Phase 8)** : `ssh-lan-localforward.test.ts`,
  `ssh-lan-remoteforward.test.ts`, `ssh-lan-dynamicforward.test.ts`,
  `ssh-permit-open.test.ts`, `ssh-match-block-effective.test.ts`,
  `linux-lan-ssh-suite.test.ts`, `cross-equipment-ssh-suite.test.ts`,
  `cross-vendor-ssh-domain.test.ts`.

---

## 5. Risques

- **Risque principal (Phases 2 et 5)** : ces deux phases touchent chacune un
  chemin de code emprunté par **tout** paquet routé/reçu, pas seulement le
  trafic concerné par une règle de port-forwarding — une erreur pourrait
  silencieusement casser le forwarding IP de base ou la réception de
  paquets sur tout hôte Linux/Windows. Mitigation : régression complète des
  suites de routage/réception de base avant/après chaque phase, en plus des
  suites NAT/iptables listées en §4.
- **Risque secondaire (Phase 8)** : dépend d'une décision architecturale
  (quelle pile SSH recevoir le vrai canal) qui recoupe un chantier
  d'unification SSH déjà suivi séparément — risque de travail dupliqué ou
  en conflit si les deux avancent sans coordination. Recommandation :
  vérifier explicitement l'état de ce chantier avant de démarrer la Phase 8.
- **Risque tertiaire (Phase 7)** : introduit la première capacité de relais
  de données réel pour les équipements Windows dans ce simulateur — une
  fonctionnalité réellement nouvelle, pas seulement une correction de bug ;
  sa suite de tests doit être bâtie entièrement de zéro (aucune couverture
  de relais n'existe aujourd'hui).
- **Risque de séquençage** : ce document est le plus grand chantier
  transversal de ce dépôt à ce jour (quatre sous-systèmes, potentiellement
  quatre équipes de fichiers distinctes). Recommandation forte : livrer et
  committer chaque phase indépendamment (comme pratiqué pour les PRDs
  précédents de ce dépôt), jamais en un seul commit géant — chaque phase a
  son propre rayon d'impact et sa propre suite de non-régression, et un
  échec de revue sur une phase ne doit pas bloquer les autres.
- **Risque de péremption du document lui-même** : comme documenté pour les
  PRDs précédents de ce dépôt (ex. `PRD-VTP.md` v1.0→v2.0), ce document
  deviendra lui-même stale si des commits ferment ses items sans mise à
  jour — revérifier l'état du code avant toute nouvelle itération plutôt
  que de supposer sa validité continue, en particulier pour les quatre
  documents préexistants qu'il corrige (§1), qui pourraient eux-mêmes être
  amendés indépendamment entre-temps.

# PRD — `nmap` (Network Mapper)

## 0. Contexte et portée du document

Ce document spécifie l'enrichissement de la commande `nmap` du simulateur, de
son état actuel (un scanner de ports minimal câblé pour deux scénarios) vers un
scanner de ports et de services fidèle au comportement observable de Nmap 7.94.

Le périmètre couvre le plan de contrôle client : découverte d'hôtes, scan de
ports TCP et UDP, détection de service/version, estimation d'OS, et les formats
de sortie normal et greppable. Le plan de données réseau (handshake TCP, ICMP,
sockets) est réutilisé tel quel — ce PRD n'ajoute aucune primitive réseau.

## 1. Analyse de l'existant

### 1.1 Inventaire

- `src/network/devices/linux/commands/net/Nmap.ts` — commande actuelle :
  parse `-sV`, `-A`, `-p liste`, une seule cible ; sonde chaque port avec
  `ctx.net.tcpProbe(ip, port)` (booléen) et n'affiche que les ports ouverts.
- `src/network/devices/linux/commands/net/ServiceBannerGrab.ts` — `grabBanner`
  et `grabListenerProcess` lisent la `SocketTable` distante (contrat
  « bannière enregistrée à l'écoute »), partagés avec `nc`, `curl`.
- `src/network/devices/linux/network/HostLookup.ts` — `findHostByAddress`
  (IP/hostname → `Equipment`, avec états `poweredOff`/`interfaceDown`).
- `src/network/core/SocketTable.ts` — `getBannerForPort(proto, port)` et
  `getListenerProcess(proto, port)` pour TCP **et** UDP.

### 1.2 Ce qui existe déjà et est réutilisable

- `LinuxNetKernel.tcpConnectOutcome(target, port) → 'open' | 'refused' |
  'timeout'` : verdict lu sur le fil (RST vs drop silencieux). C'est la
  primitive qui rend `closed` et `filtered` **observables**, là où `tcpProbe`
  ne distingue que ouvert / non-ouvert.
- `LinuxNetKernel.sendUdpProbe(target, port, srcPort)` et la `SocketTable`
  distante (`getListenerProcess('udp', port)`) pour l'état UDP.
- `findHostByAddress` comme oracle de vivacité (hôte présent, sous tension,
  interface up) pour la découverte d'hôtes et `-Pn`.
- `detectServiceFromBanner` (déjà exportée, consommée par `curl`) pour
  l'inférence service/version à partir de la bannière applicative.

### 1.3 Gap analysis (face au comportement de Nmap 7.94)

| # | Manque | Impact |
|---|--------|--------|
| G1 | États limités à « ouvert / masqué » | `closed` et `filtered` invisibles ; pas de « Not shown » |
| G2 | Pas de découverte d'hôtes (`-sn`), pas de `-Pn` | impossible de cartographier un sous-réseau |
| G3 | `-p` sans plages ni `-p-` ; pas de `-F`/`--top-ports` | sélection de ports rigide |
| G4 | Un seul type de scan ; pas d'UDP (`-sU`) | pas de scan de services UDP (DNS, SNMP, …) |
| G5 | Pas d'estimation d'OS (`-O`), `-A` ≡ `-sV` | `-A` incomplet |
| G6 | Pas de `--open`, `--reason` | sortie non filtrable, sans justification |
| G7 | Pas de cibles multiples ni CIDR | une seule IP par appel |
| G8 | Pas de sortie fichier (`-oN`, `-oG`) | non scriptable |
| G9 | Résolution/`-n`, latence, résumé multi-hôtes absents | rendu peu fidèle |

## 2. Objectifs

### 2.1 Objectifs du protocole (ce PRD)

- **O1 — États de port réels.** TCP : `open` (SYN/ACK), `closed` (RST),
  `filtered` (aucune réponse). UDP : `open`, `closed` (ICMP port unreachable
  modélisé par absence d'écouteur + refus), `open|filtered`.
- **O2 — Spécification de ports complète.** Listes `22,80`, plages `1-1024`,
  `-p-` (1-65535), `-F` (100 ports courants), `--top-ports N`, défaut = top 1000
  (liste curatée). Tri, dédup, bornage.
- **O3 — Types de scan.** `-sT` (connect, défaut du simulateur), `-sS` (SYN,
  même verdict via le fil), `-sU` (UDP), `-sn` (découverte seule),
  `-Pn` (saute la découverte).
- **O4 — Détection service/version** `-sV`, `-A` (implique `-sV` + `-O`),
  `-O` (estimation d'OS à partir du type d'équipement / de la bannière).
- **O5 — Cibles multiples.** IP, hostname, plusieurs cibles, notation CIDR
  `/24…/30` (énumération pour la découverte d'hôtes).
- **O6 — Rendu fidèle.** Format normal (en-tête, `Nmap scan report for`,
  colonnes `PORT/STATE/SERVICE[/VERSION]`, `Not shown`, latence, résumé),
  format greppable `-oG`, `--open`, `--reason`, `-n`.
- **O7 — Sorties fichier.** `-oN <fichier>`, `-oG <fichier>` écrits dans le VFS.

### 2.2 Non-objectifs

- Fingerprinting OS par pile TCP/IP réelle (on estime par métadonnées d'équipement).
- Scripts NSE (`-sC`, `--script`).
- Scans furtifs distincts au niveau paquet (FIN/Xmas/Null) — `-sS` est un alias
  de comportement de `-sT` puisque le simulateur ne distingue pas SYN de connect
  au niveau du verdict.
- IPv6 avancé (les cibles IPv6 littérales restent supportées via `tcpConnectOutcome`).
- Timing réel : `-T0…-T5` est accepté et sans effet sur le résultat.

## 3. Architecture cible

### 3.1 Principe directeur

Séparer la **décision** (quels ports, quel type de scan, quel rendu — logique
pure et testable sans `Equipment`) de l'**exécution** (sondes réseau réelles,
lecture de la `SocketTable`, écriture VFS — câblée dans la commande). Le moteur
reçoit ses sondes par injection : il est piloté en test par de fausses sondes.

### 3.2 Modules proposés (arborescence)

```
src/network/devices/linux/commands/net/
  Nmap.ts                     # LinuxCommand : câblage ctx → sondes → moteur → rendu → VFS
  nmap/
    PortSpec.ts               # parsePortSpec(spec) → number[]
    ServiceRegistry.ts        # port→service, TOP_PORTS, topPorts(n), fastPorts()
    NmapOptions.ts            # parseNmapArgs(argv) → NmapOptions
    BannerAnalyzer.ts         # detectServiceFromBanner (déplacée ; re-exportée par Nmap.ts)
    ScanEngine.ts             # scan(options, probes) → NmapReport (pur)
    NmapFormatter.ts          # renderNormal(report), renderGreppable(report)
```

### 3.3 Contrats

```ts
type PortState = 'open' | 'closed' | 'filtered' | 'open|filtered';

interface HostProbes {
  hostState(target: string): {
    ip: string; hostname?: string; up: boolean;
    poweredOff?: boolean; interfaceDown?: boolean; osHint?: string;
  } | null;
  tcpOutcome(ip: string, port: number): 'open' | 'refused' | 'timeout';
  udpState(ip: string, port: number): 'open' | 'closed' | 'open|filtered';
  banner(ip: string, port: number): { service: string; version?: string } | null;
}

interface NmapReport {
  startedAt: string; targetsScanned: number; hostsUp: number;
  hosts: HostReport[];
}
```

### 3.4 Design patterns

- **Injection de dépendances** — le moteur ne connaît que `HostProbes`.
- **Séparation parse/décision/rendu** — trois modules purs, un module de câblage.
- **Réutilisation du contrat de bannière** — `BannerAnalyzer` +
  `ServiceBannerGrab`, comme `nc`/`curl`.

## 4. Modèle de données

- **Port** `{ port, protocol: 'tcp'|'udp', state: PortState, service: string,
  version?: string, reason: string }` — `reason` ∈ `syn-ack`, `reset`,
  `no-response`, `udp-response`, `port-unreach`.
- **HostReport** `{ ip, hostname?, up, latencyMs, ports: Port[],
  notShown: { count, state }, osGuess?: string, downReason?: string }`.
- **Liste de ports** — curatée : top 1000 (services courants), sous-ensemble
  `-F` = 100, `--top-ports N` = préfixe de la liste ordonnée par fréquence.

## 5. Plan de mise en œuvre (TDD, par phases)

- **N1 — PortSpec + ServiceRegistry.** `parsePortSpec` (listes, plages, `-p-`,
  tri/dédup/bornage) ; `topPorts(n)`, `fastPorts()`, `serviceName(port, proto)`.
- **N2 — NmapOptions.** `parseNmapArgs` : cibles, ports, type de scan, découverte,
  version/OS, `--open`/`--reason`/`-n`, `-oN`/`-oG`, `-T`. Défauts fidèles.
- **N3 — ScanEngine.** `scan(options, probes)` : mapping outcome→state, UDP,
  découverte `-sn`/`-Pn`, `-sV`, `-O`, `--open`, comptage `Not shown`.
- **N4 — NmapFormatter.** `renderNormal`, `renderGreppable`.
- **N5 — Câblage Nmap.ts + intégration.** Sondes réelles depuis `ctx`, écriture
  VFS, re-export `detectServiceFromBanner`. Test d'intégration sur un vrai lab.

## 6. Stratégie de test

- **Unitaires purs** (sans `Equipment`) : `PortSpec`, `ServiceRegistry`,
  `NmapOptions`, `ScanEngine` (fausses sondes), `NmapFormatter`.
- **Intégration** : lab `LinuxPC` attaquant ↔ `LinuxServer` avec écouteurs
  (sshd, http, TNS) ; assertions sur états, versions, `--open`, `-oN`/`-oG`.
- **Non-régression** : `scenario-7-ssh-on-443` et
  `scenario-oracle-net-01-listener-scan` doivent rester verts (contrats
  `\d+/tcp\s+open`, non-divulgation de version en mode no-banner).

## 7. Risques et points d'attention

- **R1 — Coût du scan de plage.** `-p-` = 65535 sondes synchrones. Mitigation :
  borner l'énumération effective et documenter que le rendu reste fidèle.
- **R2 — UDP sans réponse réelle.** L'état UDP est dérivé de la présence d'un
  écouteur dans la `SocketTable` distante (simplification assumée), faute de
  sonde UDP produisant un ICMP port-unreachable dans le simulateur.
- **R3 — CIDR volumineux.** Limiter l'énumération de découverte aux préfixes
  `/22` et plus longs pour éviter des balayages géants.
- **R4 — Compatibilité `curl`.** `detectServiceFromBanner` doit rester exportée
  depuis `./Nmap` après déplacement dans `BannerAnalyzer`.

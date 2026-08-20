# Refactoring « Frame-Only »

Deux invariants d'architecture :

1. **Trames uniquement.** Le seul moyen pour une machine d'obtenir une
   information sur une autre machine du réseau est l'échange de trames/paquets
   sur les câbles.
2. **Bus interne.** Le bus d'événements est interne à une machine ; aucune
   machine ne peut s'abonner aux événements d'une autre. Les observateurs
   hors-monde (Logger, UI, tests) observent via un tap d'observabilité, pas en
   étant des machines.

Audit initial cartographié avec [graphify](https://github.com/Graphify-Labs/graphify)
(`graphify affected "EquipmentRegistry"`, `graphify explain "getDefaultEventBus"`).

## Fait

### Bus interne par machine (invariant 2) — `ed7e27ba`

`Equipment` possède un `ForwardingEventBus` : `subscribe*` reste local à la
machine ; chaque `publish` est relayé **une seule fois, en sens unique**, vers
le bus observateur global (Logger/UI/tests). Une machine ne peut plus voir les
événements d'une autre, par construction. Les ports publient sur le bus de leur
machine (`getBus()`), plus sur le singleton global.

Corollaires : `WindowsNpsRole` écoute le bus de son hôte (plus le global) ; le
`Router` injecte son bus dans l'`IPSecEngine`.

### Conversions registre → trames (invariant 1) — `cb6a2161`

| Avant (god-mode) | Après (frame-only) |
|---|---|
| NSS `dns` scannait `EquipmentRegistry` pour un hostname | Hôte câblé : résolution UDP/53 ou échec. Scan réservé aux fixtures jamais câblées (même gate que la découverte DHCP) |
| Reap des jobs `ssh &` via l'événement `device.power-off` d'une autre machine | Sonde TCP réelle sur le fil (`tcpConnectOutcome`) |
| Snooping DHCP abonné aux `dhcp.pool.*` du serveur (autre machine) | Bindings appris des trames DHCP ACK/RELEASE que le switch relaie |

## Déjà conforme (vérifié)

Le substrat L2/L3 était déjà câblé : `Port`→`Cable`→trame, `handleFrame()` par
équipement. Transports réels confirmés : ARP/ICMP (`sendPingProbeSync` n'écoute
que ses propres events), TCP (`tcpv2`), DNS (UDP/53), WinRM/HTTP (`dialWinRm`/
`dialHttpClient`), RADIUS (`host.sendFrame`), DHCP (DISCOVER broadcast). Le
pare-feu (`dynamicFirewallRules` partagé) et les managers service/process
restent des états locaux à la machine.

## Reste (lectures registre encore god-mode)

Non converties dans ce lot (chacune = « lire l'objet distant » à remplacer par
un échange de trames) :

- `HostLookup.findHostByAddress/findReachableHost/isPathReachable` — clients
  ssh/scp/telnet ; cible = connect TCP réel plutôt qu'interroger l'objet distant.
- `Ping.ts` (scan MTU global), `Traceroute.ts` (scan ACL des routeurs de transit,
  IPs sœurs d'un hop).
- `IPSecEngine` (résolution du pair par `getAllEquipment`) → IKE sur UDP/500.
- `hostResolution.ts`, `LinuxTerminalSession` (scan nom→machine au lancement SSH).
- `CaptureRouter` (tcpdump) : observabilité — à déplacer côté observateur si tap.

Les tests RAC (`scenario-oracle-07/08`) et capture (`scenario-07`) échouaient
**déjà** sur `origin` avant ce refactor (subsystems aspirationnels / dépendants
du god-mode) — non régressés ici.

## Règle de conception

Le code qui s'exécute « dans » une machine n'accède qu'à (a) l'état de cette
machine, (b) son bus interne, (c) ses ports. Toute connaissance d'une autre
machine transite par une trame sur un câble. `EquipmentRegistry` et le bus
global n'existent que pour le monde extérieur (UI, factory, tests).

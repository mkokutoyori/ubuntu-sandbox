# Refactoring Journal — Network Protocol Conformance & Architecture

> Journal de bord des défaillances et limites corrigées. Chaque entrée
> correspond à un lot livré (un commit poussé). Les audits initiaux ont
> couvert : protocoles de redondance FHRP (HSRP/VRRP/GLBP), routage
> dynamique (OSPF/BGP/EIGRP/RIP), couche 2 (STP/LACP/CDP/LLDP/VTP/DTP/
> UDLD/IGMP-snooping), et pile cœur (ARP/DHCP/TCP/ICMP/IPv4).

---

## Lot 1 — EIGRP : métrique composite réelle, faisabilité DUAL, variance

**Date :** 2026-06-10

### Défaillances constatées (audit)

1. **Métrique codée en dur à `1`** (`EIGRPEngine.computeRoutes`) : toutes
   les routes EIGRP s'installaient avec la métrique 1, sans rapport avec
   la formule composite de référence (RFC 7868 §5.6.2). `show ip route`
   affichait `[90/1]` au lieu des valeurs réelles (3072, 30720, …).
2. **K-values absents** : pas de coefficients K1–K5, donc pas de
   vérification de compatibilité entre voisins — sur un vrai équipement,
   un désaccord de K bloque l'adjacence (RFC 7868 §5.4).
3. **`variance` et `maximum-paths` inopérants** : les champs existaient
   dans la config mais n'étaient jamais consommés ; la commande CLI
   `variance` n'alimentait que le dépôt de config, jamais le moteur.
4. **Pas de condition de faisabilité DUAL** : la sélection de chemin
   dédupliquait par préfixe (premier vu = installé) au lieu de comparer
   FD/RD.
5. **Routes vers ses propres réseaux connectés** : le moteur installait
   une route EIGRP pour un préfixe déjà connecté localement — un vrai
   IOS n'installe jamais cela (connected AD 0 gagne toujours).
6. **`bandwidth`/`delay` sans effet** : les commandes d'interface
   écrivaient dans le Port mais aucun consommateur n'existait
   (`getDelayUs()` n'était lu nulle part).
7. **`show interfaces` mensonger** : BW/DLY/duplex/MTU/ARP timeout
   étaient déduits du *nom* de l'interface (codés en dur), pas de l'état
   réel du port.

### Corrections livrées

- **`src/network/eigrp/metric.ts`** (nouveau, pur) : métrique composite
  classique 256×(K1·10⁷/BW + K3·delay/10) avec termes K2/K5 complets,
  saturation à l'infini protocolaire, `kValuesMatch()` pour la porte
  d'adjacence. Vérifié contre les valeurs IOS de référence : 2816
  (connecté GigE), 3072 (1 saut GigE), 30720 (chemin FastEthernet).
- **`EIGRPEngine`** : sélection de successeur DUAL par préfixe (tri par
  FD), alternates admis seulement si RD < FD(successeur) **et**
  FD ≤ variance × FD(successeur), plafonné par `maximum-paths` ;
  filtrage des préfixes connectés localement ; porte K-values dans
  `computeNeighbors`. Constante `EIGRP_EXTERNAL_AD = 170` exportée
  (consommée quand la redistribution sera implémentée — lot ultérieur).
- **`Port`** : `getDelayUs()` retourne désormais le défaut IOS dépendant
  de la vitesse négociée (GigE 10 µs, FastE 100 µs, Ether 1000 µs) si
  aucun `delay` explicite ; nouveau `getEffectiveBandwidthKbps()`
  (override `bandwidth` ou vitesse négociée).
- **Seams topologiques** (`ConnectedNetwork`, `RoutingPeer`) : attributs
  optionnels bande passante/délai, peuplés par `RouterDynamicRouting`
  depuis l'état réel des ports — les moteurs restent découplés du
  matériel (DIP préservée).
- **CLI Cisco** : `variance` valide (1–128) et converge le moteur ;
  nouvelle commande `metric weights tos k1 k2 k3 k4 k5` ;
  `maximum-paths` alimente le moteur EIGRP.
- **`show interface`** : BW/DLY/duplex/vitesse/MTU/ARP timeout lus du
  port réel (les commandes `bandwidth`, `delay`, `mtu`, `arp timeout`,
  `duplex` ont enfin un effet observable).

### Tests

- Nouveau `eigrp-metric.test.ts` (valeurs IOS de référence, division par
  zéro, saturation, termes K2/K5, défauts DLY par vitesse).
- `eigrp-engine.test.ts` étendu : métrique réelle 3072, blocage
  K-mismatch, filtrage des préfixes connectés, successeur seul à
  variance 1, partage à coût inégal admis par variance, exclusion des
  chemins infaisables (RD ≥ FD), plafond `maximum-paths`.

### Limites restantes (suivi)

- Redistribution (`redistribute …`) toujours non implémentée dans les
  4 moteurs — config morte ; AD 170 prête côté EIGRP.
- Pas de timers hello/hold EIGRP (5 s/15 s) — l'adjacence est
  recalculée par convergence événementielle, pas par keepalive.
- DUAL multi-sauts non simulé (le moteur n'apprend que les préfixes
  originés par les voisins directs).

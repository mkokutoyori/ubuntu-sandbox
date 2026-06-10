# Journal de bord — Refactoring & conformité (focus PCs)

Ce journal documente les défaillances et limites corrigées lors de la campagne de
refactoring sur la plateforme de simulation. Chaque entrée correspond à un commit
poussé séparément. Objectif : des améliorations **structurelles** (design patterns,
déduplication, conformité aux RFC et au comportement des vrais équipements), pas
des patchs cosmétiques.

Périmètre prioritaire : les PCs (`EndHost`, `LinuxPC`/`LinuxMachine`, `WindowsPC`,
`LinuxServer`) et leurs sous-systèmes OS.

---

## Entrée n°1 — 2026-06-10 — Génération d'erreurs ICMP par les PCs (RFC 792 / 1122 / 1812)

### Défaillances constatées

1. **TTL expiré jeté en silence** — `EndHost.forwardIPv4()` (PC en mode passerelle,
   `net.ipv4.ip_forward=1`) jetait silencieusement les paquets dont le TTL expirait
   (`if (newTTL <= 0) return`). Conséquence concrète : un PC Linux faisant office de
   passerelle NAT était **invisible dans un traceroute**, contrairement à un vrai
   hôte Linux qui émet ICMP Time Exceeded (Type 11, Code 0) — RFC 792.
2. **Absence de route jetée en silence** — même chemin de code : aucun
   ICMP Destination Unreachable (Type 3, Code 0 — net unreachable) n'était émis,
   alors que le Router du simulateur le faisait déjà. Comportement asymétrique
   entre Router et PC pour la même fonction de forwarding.
3. **`sendICMPReject` défaillant à froid** — le reject du firewall (iptables
   `-j REJECT`) n'envoyait l'erreur ICMP que si le MAC de la source était déjà
   dans le cache ARP (`if (!targetMAC) return`), et la renvoyait aveuglément sur
   le port d'entrée au lieu de la router (violation RFC 1812 §4.3.2.7).
4. **Duplication Router/EndHost** — `Router.sendICMPError()` reconstruisait le
   paquet d'erreur à la main ; `EndHost.sendICMPReject()` aussi, différemment.
   Aucun des deux n'appliquait les garde-fous **RFC 1122 §3.2.2** (ne jamais
   émettre d'erreur ICMP en réponse à : une autre erreur ICMP, un fragment non
   initial, un paquet broadcast/multicast, une source non unicast) — risque de
   tempêtes d'erreurs ICMP dans les topologies bouclées.
5. **Taille d'erreur irréaliste** — les erreurs ICMP étaient émises avec un payload
   de 8 octets ; le format réel est 8 (en-tête ICMP) + 20 (en-tête IP original)
   + 8 (premiers octets du datagramme) = 36 octets, soit un total de 56 octets,
   la taille que rapporte un vrai `traceroute`.

### Correction (structurelle)

- **Nouveau module partagé** `src/network/core/IcmpErrors.ts` : constantes de codes
  ICMP nommées (fin des magic numbers `code: 13`), garde-fous `mayGenerateICMPError()`
  (RFC 1122 §3.2.2), constructeur `buildICMPError()` (taille conforme, MTU next-hop
  RFC 1191 §4 uniquement pour Frag-Needed).
- **`EndHost.sendICMPError()`** (nouvelle méthode `protected`) : route l'erreur via
  la table de routage (RFC 1812 §4.3.2.7), source l'erreur depuis l'IP de l'interface
  d'entrée, applique la chaîne OUTPUT du firewall, et résout l'ARP de façon asynchrone
  (file `fwdQueueAndResolve`) au lieu d'échouer à froid.
- `forwardIPv4()` émet désormais Time Exceeded (TTL) et Net Unreachable (pas de route).
- `sendICMPReject()` réduit à une délégation d'une ligne.
- `Router.sendICMPError()` refactorisé sur le module partagé + garde-fous RFC 1122
  (suppression de ~20 lignes dupliquées).

### Fichiers

- `src/network/core/IcmpErrors.ts` (nouveau)
- `src/network/devices/EndHost.ts`
- `src/network/devices/Router.ts`
- `src/__tests__/unit/network-v2/icmp-errors-endhost.test.ts` (nouveau, 14 tests)

### Validation

- 14 nouveaux tests (unitaires sur les garde-fous + intégration : PC passerelle
  visible dans traceroute, Time Exceeded sur `ping -t 1`, Net Unreachable sans route,
  forwarding nominal intact).
- Non-régression : 241 tests des suites traceroute/NAT/IPv4/ping/IPsec/ACL/SNMP/router.

# Analyse des écarts — Implémentation IPsec vs RFC 4301

**Date :** 2026-03-14
**Portée :** Simulateur d'architecture réseau — module IPsec
**Référence normative :** RFC 4301 (Security Architecture for the Internet Protocol)
**RFCs complémentaires :** RFC 4303 (ESP), RFC 4302 (AH), RFC 7296 (IKEv2), RFC 2409 (IKEv1)

---

## Table des matières

1. [Résumé exécutif](#1-résumé-exécutif)
2. [Architecture actuelle](#2-architecture-actuelle)
3. [Analyse des écarts par rapport à la RFC 4301](#3-analyse-des-écarts-par-rapport-à-la-rfc-4301)
4. [Problèmes d'implémentation détectés](#4-problèmes-dimplémentation-détectés)
5. [Analyse par équipement — Commandes manquantes](#5-analyse-par-équipement--commandes-manquantes)
6. [Recommandations d'amélioration](#6-recommandations-damélioration)
7. [Matrice de priorisation](#7-matrice-de-priorisation)

---

## 1. Résumé exécutif

L'implémentation IPsec du simulateur couvre les fondamentaux du protocole (IKEv1/IKEv2 avec PSK, ESP/AH encapsulation, SA negotiation, anti-replay, NAT-T, DPD). Cependant, l'analyse révèle **des lacunes significatives par rapport à la RFC 4301** et **un déséquilibre important entre les équipements** : les routeurs Cisco disposent d'un ensemble complet de commandes IPsec. Les routeurs Huawei, PC Linux (`ip xfrm` + strongSwan) et PC Windows (`netsh ipsec`) ont désormais été implémentés. Les fonctionnalités avancées (ESN, SA Bundles, DPD basé messages, IKE rekeying, Aggressive Mode) ont été ajoutées au moteur IPSec.

### Statistiques clés

| Composant | État | Couverture estimée |
|-----------|------|-------------------|
| IPSecEngine (core) | Fonctionnel | ~60% de la RFC 4301 |
| Cisco Router CLI | Bien couvert | ~75% des commandes réelles |
| Huawei Router CLI | **Absent** | 0% |
| Cisco Switch CLI | **Absent** | 0% |
| Huawei Switch CLI | **Absent** | 0% |
| Linux PC (strongSwan/ip xfrm) | **Absent** | 0% |
| Windows PC (netsh ipsec) | **Absent** (contexte listé mais vide) | 0% |

---

## 2. Architecture actuelle

### Fichiers source analysés

| Fichier | Rôle |
|---------|------|
| `src/network/ipsec/IPSecTypes.ts` | Interfaces/types pour ISAKMP, IKEv2, ESP, AH, SA, DPD |
| `src/network/ipsec/IPSecEngine.ts` (~1630 lignes) | Moteur principal : négociation IKE, encapsulation, SA DB, show commands |
| `src/network/devices/shells/cisco/CiscoIPSecIKEv1Commands.ts` | Commandes CLI IKEv1/ISAKMP pour routeur Cisco |
| `src/network/devices/shells/cisco/CiscoIPSecIKEv2Commands.ts` | Commandes CLI IKEv2 pour routeur Cisco |
| `src/network/devices/shells/cisco/CiscoIPSecShowCommands.ts` | Commandes `show crypto` pour routeur Cisco |
| `src/network/devices/Router.ts` | Intégration IPsec dans le pipeline de forwarding du routeur |
| `src/network/core/types.ts` | Définitions ESPPacket, AHPacket, protocoles IP 50/51 |

### Ce qui est implémenté

**IKEv1 (ISAKMP) :**
- Politiques ISAKMP avec priorité, encryption, hash, auth, DH group, lifetime
- Pre-shared keys (par IP et wildcard 0.0.0.0)
- Négociation Main Mode (comparaison de politiques triées par priorité)
- Vérification PSK bilatérale
- Création d'IKE SA sur les deux pairs (initiator/responder)
- États MM_NO_STATE → QM_IDLE

**IKEv2 :**
- Proposals (encryption[], integrity[], dhGroup[])
- Policies avec référence aux proposals
- Keyrings avec peers et PSK
- Profiles avec match identity, auth local/remote
- Négociation IKE_SA + CHILD_SA combinée

**IPsec Data Plane :**
- Transform sets (ESP/AH, tunnel/transport)
- Crypto maps (statiques et dynamiques)
- IPsec profiles pour GRE over IPsec
- Tunnel protection sur interfaces
- Encapsulation ESP/AH avec SPI, sequence number
- Décapsulation avec lookup SPI → SA
- Anti-replay window (RFC 4303, bitmap 32 bits)
- SA lifetime (time-based et volume-based en KB)
- PFS (Perfect Forward Secrecy)
- NAT-T detection et keepalive
- DPD via link-down events

**Show/Debug commands (Cisco) :**
- `show crypto isakmp sa [detail]`
- `show crypto isakmp policy`
- `show crypto ipsec sa [detail]`
- `show crypto ipsec transform-set`
- `show crypto ipsec profile`
- `show crypto map`
- `show crypto dynamic-map`
- `show crypto ikev2 sa [detail]`
- `show crypto session`
- `show crypto engine brief`
- `show crypto engine configuration`
- `debug crypto isakmp/ipsec/ikev2`
- `clear crypto isakmp/ipsec/ikev2 sa`

---

## 3. Analyse des écarts par rapport à la RFC 4301

### 3.1 SPD (Security Policy Database) — **NON IMPLÉMENTÉ**

La RFC 4301 Section 4.4.1 définit la **Security Policy Database (SPD)** comme composant central de l'architecture IPsec. Chaque paquet IP doit être évalué contre la SPD qui retourne l'une des trois actions : **PROTECT**, **BYPASS**, **DISCARD**.

**État actuel :** Le simulateur utilise des crypto maps et ACLs comme substitut partiel à la SPD, mais ne modélise pas la SPD en tant qu'entité distincte avec ses trois actions. Il n'y a pas de politique explicite BYPASS ou DISCARD — les paquets non matchés par une crypto map passent simplement en clair.

**Impact :**
- Impossible de configurer une politique « rejeter tout trafic non chiffré » (DISCARD)
- Impossible de définir des exemptions SPD (BYPASS) pour ICMP, OSPF, etc.
- Pas de notion de SPD-S (SPD applied to traffic after SA processing), SPD-I (incoming), SPD-O (outgoing) comme défini Section 4.4.1.2

### 3.2 SAD (Security Association Database) — Implémenté

La RFC 4301 Section 4.4.2 définit les champs obligatoires d'une SA dans le SAD.
Tous les champs sont désormais modélisés dans `IPSec_SA` (voir `IPSecTypes.ts`).

| Champ RFC 4301 | Implémenté | Notes |
|---|---|---|
| SPI | Oui | `spiIn`, `spiOut` — génération aléatoire via `randomSPI()` (plage [256, 0xFFFFFFFF] per RFC 4303 §2.1) |
| Sequence Number Counter | Oui | `outboundSeqNum` (32 bits) + `outboundSeqNumHigh` (ESN 64 bits) |
| Sequence Counter Overflow | Oui | `seqOverflowFlag` — quand `true` (défaut RFC), empêche la transmission au-delà de 2^32−1 (ou 2^64−1 ESN) et déclenche un rekey. Log d'audit via `Logger.info`. Vérification dans `encapsulate()` et `processOutbound()`. |
| Anti-Replay Window | Oui | `replayBitmap` (Uint32Array), taille configurable jusqu'à 1024 bits. Supporte ESN 64 bits via `checkAntiReplayESN()`. |
| AH Authentication Algorithm/Key | Oui | `cryptoKeys.ahAuthAlgorithm` + `ahAuthKey` (clé hex simulée de longueur correcte : HMAC-SHA-1 160 bits, HMAC-SHA-256 256 bits, etc.) |
| ESP Encryption Algorithm/Key | Oui | `cryptoKeys.espEncAlgorithm` + `espEncKey` (clé hex simulée : AES-128/192/256, 3DES, DES, AES-GCM). Pas de chiffrement réel (simulateur), mais structure complète. |
| ESP Authentication Algorithm/Key | Oui | `cryptoKeys.espAuthAlgorithm` + `espAuthKey` (HMAC-SHA-1/256/384/512, HMAC-MD5). Dérivation via `deriveCryptoKeys()`. |
| Lifetime | Oui | Time-based (`lifetime` secondes) + volume-based (`lifetimeKB` kilo-octets). Vérification dans `isSAExpired()`. |
| IPsec Protocol Mode | Oui | `mode: 'Tunnel' \| 'Transport'` |
| Stateful Fragment Checking | Oui | `statefulFragCheck` — activé par défaut en mode Tunnel (RFC 4301 §7). Détection des fragments (MF flag / offset) dans `encapsulate()`. Réassemblage non simulé mais structure présente. |
| Bypass DF bit | Oui | `dfBitPolicy: 'copy' \| 'set' \| 'clear'` — contrôle le bit DF dans l'en-tête tunnel externe (RFC 4301 §8.1). Défaut: `'copy'`. Appliqué via `computeOuterFlags()`. Vérification Path MTU vs taille paquet avec ICMP "too big" simulé. |
| DSCP values | Oui | `dscpEcnConfig.dscpMode: 'copy' \| 'set' \| 'map'` — modes complets per RFC 4301 §5.1.2. Mode `'copy'` (défaut) recopie le DSCP inner→outer. Mode `'set'` utilise une valeur fixe. Mode `'map'` applique une table de mapping DSCP inner→outer. |
| Bypass DSCP / ECN | Oui | `dscpEcnConfig.ecnEnabled` — support RFC 6040 : copie ECN bits inner→outer à l'encapsulation, propagation des marques CE (Congestion Experienced) outer→inner à la décapsulation via `propagateEcnOnDecap()`. |
| Path MTU | Oui | `pathMTU` (découvert dynamiquement), `ipMTU` (= pathMTU − overhead ESP/AH), `pathMTULastUpdated` (timestamp pour aging RFC 1191 §6.3). Méthodes `updatePathMTU()` et `agePathMTU()`. Vérification pré-encapsulation dans `encapsulate()`. |
| Tunnel Header IP src/dst | Oui | `localIP`, `peerIP` |
| SA Selectors (traffic selectors) | Oui | `trafficSelectors: SATrafficSelector` — selectors natifs dans la SA (src/dst address+wildcard, protocol, src/dst port), extraits de l'ACL lors de la négociation via `buildTrafficSelectorsFromACL()`. Affichés dans `show crypto ipsec sa detail`. |

### 3.3 Gestion des fragments IP — **IMPLÉMENTÉ** ✅

La RFC 4301 Section 7 requiert une gestion spécifique des fragments. **Implémenté** :
- **Réassemblage avant application IPsec (tunnel mode)** — Oui : buffer de réassemblage pré-IPsec dans `IPSecEngine.bufferFragment()`. Les fragments sont regroupés par clé `(srcIP|dstIP|identification|protocol)`, avec timeout de 30s et limite de 256 groupes simultanés. Le paquet réassemblé est passé à `encapsulate()` une fois tous les fragments reçus.
- **Fragmentation après encapsulation ESP** — Oui : `fragmentIPv4Packet()` fragmente le paquet externe si `totalLength > pathMTU` et que DF n'est pas positionné. `processOutbound()` retourne un tableau `IPv4Packet[]` contenant tous les fragments. L'offset est calculé en unités de 8 octets conformément à la RFC 791 §2.3.
- **Stateful fragment checking** — Oui : flag `statefulFragCheck` dans la SA, détection correcte du bit MF (bit 2, `flags & 0b100`) et du fragment offset dans `encapsulate()`. Activé par défaut en mode Tunnel.
- **Bug MF corrigé** : le test du bit MF utilisait `flags & 0x1` (bit réservé) au lieu de `flags & 0b100` (bit 2 = More Fragments). Corrigé conformément au format des flags IPv4 : bit 0=reserved, bit 1=DF, bit 2=MF.

### 3.4 ICMP Processing — **IMPLÉMENTÉ** ✅

La RFC 4301 Section 6 exige un traitement spécial des messages ICMP en relation avec IPsec. **Implémenté** :
- **PMTU Discovery (RFC 1191)** — Oui : le routeur traite les ICMP Type 3 Code 4 (Fragmentation Needed) dans `handleLocalDelivery()`. Lorsqu'un tel message référence un paquet ESP/AH sortant, le SPI est extrait du paquet original et `ipsecEngine.updatePathMTU()` est appelé pour mettre à jour le Path MTU de la SA.
- **Génération ICMP Fragmentation Needed** — Oui : lorsque `encapsulate()` détecte que le paquet encapsulé dépasse le Path MTU avec DF positionné, `lastEncapICMP` est renseigné avec le MTU interne (`ipMTU`) et le paquet original. Le Router génère alors un ICMP Type 3 Code 4 vers la source, incluant le Next-Hop MTU (RFC 1191 §4).
- **`sendICMPError()` enrichi** — Le champ `mtu` est renseigné dans les messages ICMP Type 3 Code 4, et le champ `originalPacket` transporte une référence au paquet déclencheur pour permettre l'identification de la SA côté récepteur.
- **ICMPPacket étendu** — Ajout des champs optionnels `mtu` (Next-Hop MTU) et `originalPacket` (paquet déclencheur) à l'interface `ICMPPacket` dans `types.ts`.
- **Path MTU aging** — `agePathMTU()` (RFC 1191 §6.3) réinitialise le PMTU au défaut (1500) après expiration du timer, permettant au mécanisme de PMTU Discovery de re-tester un chemin plus large.

### 3.5 Multicast IPsec — **IMPLÉMENTÉ** ✅

La RFC 4301 Section 4.1 mentionne que les SA multicast sont unidirectionnelles. **Implémenté** :
- **MulticastIPSecSA type** — Nouveau type dans `IPSecTypes.ts` modélisant les SA multicast avec : groupe multicast, émetteur unique, SPI, keying material partagé, liste de récepteurs, compteurs de paquets/octets.
- **Unidirectionnalité (RFC 4301 §4.1)** — Oui : seul l'émetteur autorisé (`senderAddress`) peut encapsuler. Les récepteurs ne peuvent que décapsuler.
- **Lookup par (SPI, adresse groupe)** — Oui : `findMulticastSAForInbound(spi, groupAddress)` utilise la clé composée `SPI|groupAddress` conformément à la RFC 4301 §4.1.
- **Anti-replay désactivé par défaut** — Oui : `antiReplayEnabled: false` par défaut pour le multicast, conformément à la recommandation RFC 4301 §4.1 (les paquets multicast peuvent arriver dans le désordre via des chemins différents).
- **Gestion des récepteurs** — `addMulticastReceiver()` / `removeMulticastReceiver()` : installation/suppression automatique de la SA sur l'engine du récepteur avec keying material partagé.
- **Data plane multicast** — `processMulticastOutbound()` (encapsulation ESP/AH par l'émetteur) et `processMulticastInboundESP()` / `processMulticastInboundAH()` (décapsulation par les récepteurs).
- **Détection d'adresse multicast** — `isMulticast()` / `isMulticastAddress()` vérifie la plage 224.0.0.0/4 (RFC 5771).
- **Show command** — `showCryptoIPSecMulticastSA()` affiche toutes les SA multicast avec groupe, émetteur, SPI, rôle, récepteurs, compteurs, lifetime.

### 3.6 Extended Sequence Numbers (ESN) — **IMPLÉMENTÉ** ✅

La RFC 4303 Section 2.2.1 définit les Extended Sequence Numbers (64 bits). **Implémenté** :
- Champ `esnEnabled` dans `IPSec_SA` avec compteur 64 bits (`outboundSeqNumHigh` + `outboundSeqNum`)
- Anti-replay ESN avec reconstruction du numéro de séquence 64 bits (`checkAntiReplayESN`)
- Débordement des 32 bits bas incrémente les 32 bits hauts au lieu de déclencher un rekey
- Commande Cisco : `crypto ipsec security-association esn` / `no ... esn`

### 3.7 SA Bundle (combined AH+ESP) — **IMPLÉMENTÉ** ✅

La RFC 4301 Section 4.5 permet l'utilisation combinée d'AH et ESP sur un même flux (SA bundle). **Implémenté** :
- `encapsulate()` applique ESP d'abord (chiffrement), puis AH (intégrité de l'en-tête externe)
- Décapsulation automatique via le traitement récursif `processIPv4` dans Router.ts

### 3.8 IKE SA Rekeying — **IMPLÉMENTÉ** ✅

La RFC 7296 Section 2.8 définit les procédures de rekeying IKE SA. **Implémenté** :
- `recheckIKESALifetimes()` vérifie l'expiration des IKE SA
- `rekeyIKESA()` crée une nouvelle IKE SA avec SPI/timestamp frais, renouvelle côté peer aussi

### 3.9 Certificate-based Authentication (RSA/ECDSA) — **NON IMPLÉMENTÉ**

Seule l'authentification PSK est fonctionnelle. `rsa-sig` est accepté comme valeur de config mais :
- Aucune PKI (CA, certificats, CRL/OCSP)
- Aucune validation de certificat
- Aucun échange de signatures réel
- La négociation échoue silencieusement avec RSA-sig

### 3.10 EAP Authentication (IKEv2) — **NON IMPLÉMENTÉ**

La RFC 7296 Section 2.16 définit l'authentification EAP pour IKEv2. Non supporté.

---

## 4. Problèmes d'implémentation détectés

### 4.1 Anti-replay window limitée à 32 bits

**Fichier :** `src/network/ipsec/IPSecEngine.ts:620`
```typescript
const windowSize = Math.min(sa.replayWindowSize, 32); // bitmap limited to 32 bits
```

**Problème :** La fenêtre anti-replay est limitée à 32 bits alors que la commande Cisco `crypto ipsec security-association replay window-size` accepte des valeurs jusqu'à 1024. La RFC 4303 recommande un minimum de 64 bits.

**Correction suggérée :** Utiliser un `BigInt` ou un tableau de bits pour supporter des fenêtres jusqu'à 1024.

### 4.2 SPI counter global non sécurisé

**Fichier :** `src/network/ipsec/IPSecEngine.ts:30-34`
```typescript
let spiCounter = 0x1000;
function nextSPI(): number {
  spiCounter = (spiCounter + 1) & 0xffffffff;
  return spiCounter;
}
```

**Problème :** Le compteur SPI est :
1. **Global et partagé** entre toutes les instances d'IPSecEngine (variable module-level) — deux routeurs génèrent des SPIs séquentiels, ce qui n'est pas réaliste.
2. **Séquentiel et prévisible** — la RFC 4303 Section 2.1 recommande des SPIs aléatoires pour des raisons de sécurité.
3. **Commence à 0x1000** — les SPIs 0-255 sont réservés (IANA), mais 0x1000 est arbitraire et toujours le même au redémarrage.

**Correction suggérée :** Utiliser `Math.random()` ou `crypto.getRandomValues()` pour chaque engine indépendamment, en excluant la plage 0-255.

### 4.3 Négociation synchrone et directe (non réaliste)

**Fichier :** `src/network/ipsec/IPSecEngine.ts:660-688`

**Problème :** La négociation IKE est effectuée de manière **synchrone et directe** (engine-to-engine) en accédant directement aux structures internes du pair. Cela signifie :
- Pas de messages IKE réels échangés via le réseau
- Pas de temporisation, pas de retransmission
- La négociation ne peut pas échouer pour des raisons réseau (routage, firewall blocking port 500/4500)
- Impossible de simuler des attaques man-in-the-middle ou des timeouts

### 4.4 Gestion du lifetime responder vs initiator

**Fichier :** `src/network/ipsec/IPSecEngine.ts:829`

**Problème :** Le lifetime de la SA responder est toujours celui de l'initiator. En réalité (RFC 2409 / RFC 7296), les deux pairs négocient et le plus court des deux est retenu. Si le responder a un lifetime différent configuré, il est ignoré.

### 4.5 DPD basé sur messages — **IMPLÉMENTÉ** ✅

**Implémenté** : `runDPDCheck()` simule R-U-THERE/R-U-THERE-ACK en vérifiant la joignabilité du peer et l'existence de l'IKE SA correspondante. Supporte les modes `periodic` et `on-demand`, avec compteur de timeouts consécutifs et suppression des SAs après épuisement des retries. Commande Cisco : `crypto isakmp keepalive N R [periodic|on-demand]`.

### 4.6 Pas de gestion des erreurs de chiffrement/déchiffrement

Le simulateur ne simule aucun échec cryptographique (clé invalide, intégrité compromise, padding error). Les paquets ESP/AH sont toujours « déchiffrés » avec succès car aucun chiffrement réel n'est effectué.

### 4.7 NAT-T detection simpliste

**Fichier :** `src/network/ipsec/IPSecEngine.ts:750-751`

```typescript
const natT = (this.natKeepaliveInterval > 0 || peerEngine.natKeepaliveInterval > 0)
  && apparentSrcIP !== localIP;
```

**Problème :** La détection NAT-T est basée sur le keepalive interval ET la comparaison d'IP, pas sur les NAT-D payloads (RFC 3947). En réalité, IKE détecte le NAT via des hash des adresses/ports dans les payloads NAT_DETECTION_*.

---

## 5. Analyse par équipement — Commandes manquantes

### 5.1 Routeur Cisco IOS — Commandes manquantes

L'implémentation Cisco est la plus complète mais il manque :

#### Configuration

| Commande manquante | Description | Priorité |
|---|---|---|
| `crypto isakmp identity` | Définir l'identité IKE (address/hostname/dn) | Moyenne |
| `crypto isakmp aggressive-mode` | Activer Aggressive Mode IKEv1 | Moyenne |
| `crypto isakmp invalid-spi-recovery` | Récupération sur SPI invalide | Basse |
| ~~`crypto ipsec fragmentation`~~ | ~~Contrôle de la fragmentation pre/post-encaps~~ | ✅ Fait — `fragmentIPv4Packet()`, `bufferFragment()` |
| ~~`crypto ipsec df-bit`~~ | ~~Gestion du bit DF (copy/set/clear)~~ | ✅ Fait — `dfBitPolicy`, `computeOuterFlags()` |
| `crypto ikev2 dpd` | DPD spécifique à IKEv2 (séparé de IKEv1) | Haute |
| `crypto ikev2 redirect` | IKEv2 redirect gateway | Basse |
| `crypto ikev2 reconnect` | IKEv2 session resumption | Basse |
| `crypto ikev2 cookie-challenge` | Protection anti-DoS IKEv2 | Moyenne |
| `crypto ikev2 http-url cert` | Certificat via HTTP URL lookup | Basse |
| `crypto pki trustpoint` | Configuration PKI/CA | Haute |
| `crypto pki certificate` | Gestion des certificats | Haute |
| `crypto key generate rsa` | Génération de clés RSA | Haute |
| `crypto isakmp client configuration` | Mode-config (push/pull) | Moyenne |
| `crypto ipsec client ezvpn` | EzVPN client | Basse |
| `crypto gdoi` | Group Domain of Interpretation (GET VPN) | Basse |
| `crypto ipsec security-association idle-time` | SA idle timeout | Moyenne |

#### Show/Debug

| Commande manquante | Description | Priorité |
|---|---|---|
| `show crypto isakmp key` | Afficher les clés PSK configurées | Haute |
| `show crypto ikev2 proposal` | Afficher les proposals IKEv2 | Haute |
| `show crypto ikev2 policy` | Afficher les policies IKEv2 | Haute |
| `show crypto ikev2 profile` | Afficher les profiles IKEv2 | Haute |
| `show crypto ikev2 stats` | Statistiques IKEv2 (compteurs de messages) | Moyenne |
| `show crypto session detail` | Détails crypto session (vs l'actuel simplifié) | Moyenne |
| `show crypto ipsec sa peer X.X.X.X` | Filtrage SA par peer | Moyenne |
| `show crypto ipsec sa map NAME` | Filtrage SA par crypto map | Basse |
| `show crypto pki certificates` | Afficher les certificats | Haute (si PKI) |
| `show crypto key mypubkey rsa` | Afficher la clé publique | Haute (si PKI) |
| `debug crypto isakmp detail` | Debug détaillé ISAKMP | Basse |
| `debug crypto ipsec error` | Debug erreurs uniquement | Basse |

#### Clear/No commands

| Commande manquante | Description | Priorité |
|---|---|---|
| `clear crypto session remote X.X.X.X` | L'actuel existe mais parsing limité | Moyenne |
| `clear crypto isakmp sa peer X.X.X.X` | Clear par peer spécifique | Moyenne |

### 5.2 Routeur Huawei (VRP) — **IMPLÉMENTÉ** ✅

Les commandes IPsec Huawei VRP ont été implémentées dans `HuaweiIPSecCommands.ts` et intégrées dans `HuaweiVRPShell.ts`. Couverture complète des sub-views (ike-proposal, ike-peer, ipsec-proposal, ipsec-policy) avec navigation quit/return. Commandes display et interface également implémentées. Détail ci-dessous :

#### Configuration IPsec (Huawei VRP — system-view)

| Commande requise | Description | Priorité |
|---|---|---|
| `ike proposal N` | Créer un IKE proposal | Critique |
| ` encryption-algorithm` | Algo de chiffrement (des-cbc, 3des-cbc, aes-128/192/256) | Critique |
| ` authentication-algorithm` | Algo d'authentification (md5, sha1, sha2-256/384/512) | Critique |
| ` authentication-method` | Méthode (pre-share, rsa-signature, digital-envelope) | Critique |
| ` dh` | Groupe DH (group1, group2, group5, group14, group19, group20) | Critique |
| ` sa duration` | Lifetime IKE SA | Haute |
| `ike peer NAME` | Définir un peer IKE | Critique |
| ` pre-shared-key` | Clé PSK | Critique |
| ` ike-proposal` | Référencer un proposal | Critique |
| ` remote-address` | Adresse IP du pair | Critique |
| ` exchange-mode` | Mode (main/aggressive) | Haute |
| ` local-address` | Adresse locale | Moyenne |
| ` version` | Version IKE (1/2) | Haute |
| ` nat traversal` | Activer NAT-T | Moyenne |
| ` dpd type` | DPD (periodic/on-demand) | Moyenne |
| `ipsec proposal NAME` | Créer un proposal IPsec | Critique |
| ` transform` | Mode (ah, esp, ah-esp) | Critique |
| ` encapsulation-mode` | Mode (tunnel/transport) | Critique |
| ` esp authentication-algorithm` | Algo auth ESP | Critique |
| ` esp encryption-algorithm` | Algo chiffrement ESP | Critique |
| ` ah authentication-algorithm` | Algo auth AH | Haute |
| `ipsec policy NAME SEQ isakmp` | Créer une policy IPsec (auto) | Critique |
| ` security acl` | ACL de sélection du trafic | Critique |
| ` ike-peer` | Référencer un peer IKE | Critique |
| ` proposal` | Référencer un proposal IPsec | Critique |
| ` pfs` | Perfect Forward Secrecy | Haute |
| ` sa duration traffic-based` | Lifetime basé sur le volume | Moyenne |
| ` sa duration time-based` | Lifetime basé sur le temps | Moyenne |
| `ipsec policy NAME SEQ manual` | Policy manuelle (sans IKE) | Moyenne |
| `interface GEx/x/x` → `ipsec policy NAME` | Appliquer policy à une interface | Critique |

#### Commandes d'affichage (Huawei VRP)

| Commande requise | Description | Priorité |
|---|---|---|
| `display ike proposal` | Afficher les proposals IKE | Critique |
| `display ike peer` | Afficher les peers IKE | Critique |
| `display ike sa [verbose]` | Afficher les SA IKE | Critique |
| `display ipsec proposal` | Afficher les proposals IPsec | Critique |
| `display ipsec policy [brief]` | Afficher les policies IPsec | Critique |
| `display ipsec sa [brief]` | Afficher les SA IPsec | Critique |
| `display ipsec statistics` | Statistiques IPsec | Haute |
| `display ipsec interface` | Interfaces avec IPsec | Moyenne |
| `reset ike sa` | Effacer les SA IKE | Haute |
| `reset ipsec sa` | Effacer les SA IPsec | Haute |
| `debugging ike` | Debug IKE | Moyenne |
| `debugging ipsec` | Debug IPsec | Moyenne |

### 5.3 Switch Cisco (IOS) — Commandes IPsec manquantes

Les switches Cisco Layer 3 (ex: Catalyst 3750, 9300) supportent IPsec pour :

| Commande requise | Description | Priorité |
|---|---|---|
| `crypto isakmp policy` | Même syntaxe que routeur | Moyenne |
| `crypto isakmp key` | PSK | Moyenne |
| `crypto ipsec transform-set` | Transform sets | Moyenne |
| `crypto map` | Crypto maps | Moyenne |
| `show crypto ipsec sa` | Afficher les SA | Moyenne |
| `show crypto isakmp sa` | Afficher les SA IKE | Moyenne |

**Note :** Sur les vrais switches Cisco, IPsec n'est généralement disponible que sur les modèles L3 avec licence IPsec spéciale. Le simulateur pourrait ne supporter IPsec que sur les switches déclarés comme « L3 ».

### 5.4 Switch Huawei — Commandes IPsec manquantes

Les switches Huawei (ex: S5700 série) ne supportent généralement **pas** IPsec nativement. Certains modèles haut de gamme (S12700) le supportent. Pour le simulateur, la priorité est **basse**.

| Commande | Priorité |
|---|---|
| Même set que Huawei Router si L3 | Basse |

### 5.5 PC Linux — **IMPLÉMENTÉ** ✅

Les commandes IPsec Linux ont été implémentées : `ip xfrm state/policy` (add/update/list/delete/deleteall/flush/count) dans `LinuxIpCommand.ts` et `ipsec` (strongSwan: start/stop/restart/reload/status/statusall/up/down/version) dans `LinuxCommandExecutor.ts`. Stockage XFRM via `IpXfrmContext` sur `LinuxPC`. Détail des commandes couvertes :

#### ip xfrm (Netkey/XFRM — kernel IPsec)

| Commande requise | Description | Priorité |
|---|---|---|
| `ip xfrm state add` | Ajouter une SA manuellement | Haute |
| `ip xfrm state list` | Lister les SA | Haute |
| `ip xfrm state deleteall` | Supprimer toutes les SA | Haute |
| `ip xfrm state get` | Obtenir une SA spécifique | Moyenne |
| `ip xfrm policy add` | Ajouter une politique SPD | Haute |
| `ip xfrm policy list` | Lister les politiques SPD | Haute |
| `ip xfrm policy deleteall` | Supprimer toutes les politiques | Haute |
| `ip xfrm monitor` | Monitorer les événements IPsec | Basse |

#### strongSwan / ipsec (User-space IKE daemon)

| Commande requise | Description | Priorité |
|---|---|---|
| `ipsec start` / `ipsec stop` | Démarrer/arrêter le daemon IKE | Haute |
| `ipsec status [--all]` | Statut des tunnels | Haute |
| `ipsec up <conn>` | Monter un tunnel | Haute |
| `ipsec down <conn>` | Démonter un tunnel | Haute |
| `ipsec statusall` | Statut détaillé | Moyenne |
| `ipsec reload` | Recharger la configuration | Moyenne |
| `ipsec listcerts` | Lister les certificats | Basse |
| `ipsec listcacerts` | Lister les CA | Basse |

#### Fichiers de configuration

| Fichier | Description | Priorité |
|---|---|---|
| `/etc/ipsec.conf` | Configuration des connexions strongSwan | Haute |
| `/etc/ipsec.secrets` | Clés PSK et références aux clés privées | Haute |
| `/etc/strongswan.conf` | Configuration du daemon strongSwan | Moyenne |
| `/etc/swanctl/swanctl.conf` | Configuration swanctl (format moderne) | Basse |

### 5.6 PC Windows — **IMPLÉMENTÉ** ✅

Les commandes `netsh ipsec` ont été **implémentées** dans `WinNetsh.ts` : static (add/delete/show/set pour policy, filterlist, filter, filteraction, rule) et dynamic (show all/mmsas/qmsas/stats/ikestats). Détail des commandes couvertes :

#### netsh ipsec static

| Commande requise | Description | Priorité |
|---|---|---|
| `netsh ipsec static add policy` | Créer une politique IPsec | Haute |
| `netsh ipsec static add filterlist` | Créer une liste de filtres | Haute |
| `netsh ipsec static add filter` | Ajouter un filtre IP | Haute |
| `netsh ipsec static add filteraction` | Créer une action (permit/block/negotiate) | Haute |
| `netsh ipsec static add rule` | Associer filterlist + filteraction | Haute |
| `netsh ipsec static show policy [all]` | Afficher les politiques | Haute |
| `netsh ipsec static show filterlist [all]` | Afficher les listes de filtres | Haute |
| `netsh ipsec static show filteraction [all]` | Afficher les actions | Haute |
| `netsh ipsec static show rule [all]` | Afficher les règles | Haute |
| `netsh ipsec static set policy assign=y` | Assigner (activer) une politique | Haute |
| `netsh ipsec static delete policy` | Supprimer une politique | Moyenne |

#### netsh ipsec dynamic

| Commande requise | Description | Priorité |
|---|---|---|
| `netsh ipsec dynamic show all` | Afficher l'état dynamique | Haute |
| `netsh ipsec dynamic show mmsas` | Afficher les Main Mode SAs | Haute |
| `netsh ipsec dynamic show qmsas` | Afficher les Quick Mode SAs | Haute |
| `netsh ipsec dynamic show stats` | Statistiques IPsec | Moyenne |
| `netsh ipsec dynamic show mmfilter` | Filtres Main Mode | Moyenne |
| `netsh ipsec dynamic show qmfilter` | Filtres Quick Mode | Moyenne |

#### PowerShell (alternative moderne)

| Commande | Description | Priorité |
|---|---|---|
| `Get-NetIPsecRule` | Obtenir les règles IPsec | Moyenne |
| `New-NetIPsecRule` | Créer une règle IPsec | Moyenne |
| `Get-NetIPsecMainModeSA` | Obtenir les SA Main Mode | Moyenne |
| `Get-NetIPsecQuickModeSA` | Obtenir les SA Quick Mode | Moyenne |
| `Get-NetIPsecPhase1AuthSet` | Obtenir les méthodes d'auth Phase 1 | Basse |
| `Get-NetIPsecPhase2AuthSet` | Obtenir les méthodes d'auth Phase 2 | Basse |

---

## 6. Recommandations d'amélioration

### 6.1 Améliorations du moteur IPsec (IPSecEngine)

#### P1 — Critiques

1. **Implémenter la SPD (Security Policy Database)** conforme à la RFC 4301 Section 4.4.1 :
   - Créer un type `SecurityPolicy` avec actions PROTECT/BYPASS/DISCARD
   - Évaluer tout trafic entrant et sortant contre la SPD
   - Permettre la configuration de politiques BYPASS (ex: OSPF, IKE)

2. **Corriger la fenêtre anti-replay** pour supporter au moins 64 bits (utiliser un tableau `Uint32Array` ou `BigInt`)

3. **Rendre le SPI non-séquentiel** : utiliser `Math.random()` scoped à chaque engine, exclure 0-255

4. **Gérer le dépassement de séquence** : quand `outboundSeqNum` atteint 2^32, déclencher un rekeying automatique (RFC 4303 Section 3.3.3)

#### P2 — Importantes

5. **Négociation du lifetime** : prendre le minimum des deux pairs (RFC 2409 Section 5.5 / RFC 7296 Section 2.8)

6. **Implémenter le DPD basé sur messages** : timer + envoi de paquets R-U-THERE simulés (pas seulement link-down)

7. **Ajouter le support du rekeying IKE SA** : pas seulement les Child SA

8. **Implémenter les SA Bundles** : permettre AH+ESP combinés sur le même flux (section 4.5 de RFC 4301)

9. **Ajouter Aggressive Mode** pour IKEv1 (en plus de Main Mode)

#### P3 — Souhaitables

10. **Simuler les échanges IKE via le réseau** : envoyer de vrais paquets UDP 500/4500 plutôt qu'un appel direct engine-to-engine

11. **Ajouter le support PKI/certificats** : au minimum simuler la structure (trustpoints, CA, certificate request)

12. ~~**Implémenter Path MTU handling**~~ : ✅ Fait — gestion du DF bit (`dfBitPolicy`), Path MTU dynamique (`updatePathMTU()`, `agePathMTU()`), DSCP/ECN (`dscpEcnConfig`), vérification pré-encapsulation

### 6.2 Améliorations par équipement

| Équipement | Action requise | Effort estimé |
|---|---|---|
| **Huawei Router** | Créer `HuaweiIPSecCommands.ts` avec toutes les commandes listées en 5.2 | Fort |
| **Linux PC** | Ajouter `ip xfrm` + `ipsec` (strongSwan) dans LinuxCommandExecutor | Fort |
| **Windows PC** | Implémenter le contexte `netsh ipsec` (static/dynamic) dans WinNetsh.ts | Moyen |
| **Cisco Switch** | Ajouter le support IPsec conditionnel (L3 uniquement) dans GenericSwitch | Moyen |
| **Huawei Switch** | Basse priorité — reporter sauf si requis | Faible |

---

## 7. Matrice de priorisation

### Phase 1 — Fondations (Priorité Critique)

| # | Tâche | Fichiers impactés |
|---|---|---|
| 1 | Implémenter la SPD (PROTECT/BYPASS/DISCARD) | `IPSecTypes.ts`, `IPSecEngine.ts`, `Router.ts` |
| 2 | Fixer anti-replay > 32 bits | `IPSecEngine.ts` |
| 3 | Randomiser les SPIs | `IPSecEngine.ts` |
| 4 | Gestion overflow séquence → rekeying | `IPSecEngine.ts` |
| 5 | Commandes IPsec Huawei Router (config de base) | Nouveau: `HuaweiIPSecCommands.ts` |

### Phase 2 — Parité équipements (Priorité Haute)

| # | Tâche | Fichiers impactés |
|---|---|---|
| 6 | Commandes `display ike/ipsec` Huawei Router | `HuaweiDisplayCommands.ts`, nouveau fichier |
| 7 | Commandes `ip xfrm` pour Linux PC | `LinuxCommandExecutor.ts`, nouveau fichier |
| 8 | Commandes `netsh ipsec static/dynamic` Windows | `WinNetsh.ts` |
| 9 | Commandes `show crypto ikev2 proposal/policy/profile` Cisco | `CiscoIPSecShowCommands.ts` |
| 10 | Commandes `show crypto isakmp key` Cisco | `CiscoIPSecShowCommands.ts` |

### Phase 3 — Réalisme avancé (Priorité Moyenne)

| # | Tâche | Fichiers impactés |
|---|---|---|
| 11 | Négociation lifetime min(initiator, responder) | `IPSecEngine.ts` |
| 12 | DPD basé sur messages IKE (pas link-down seul) | `IPSecEngine.ts` |
| 13 | IKE SA rekeying | `IPSecEngine.ts` |
| 14 | Aggressive Mode IKEv1 | `IPSecEngine.ts`, `CiscoIPSecIKEv1Commands.ts` |
| 15 | Commandes strongSwan Linux (`ipsec up/down/status`) | `LinuxCommandExecutor.ts` |
| 16 | Switch Cisco L3 — support IPsec conditionnel | `GenericSwitch.ts` |

### Phase 4 — Fonctionnalités avancées (Priorité Basse)

| # | Tâche | Fichiers impactés |
|---|---|---|
| 17 | Échanges IKE via paquets réseau simulés | `IPSecEngine.ts`, `Router.ts` |
| 18 | PKI / Certificats (structure de base) | Nouveaux fichiers PKI |
| 19 | SA Bundles (AH+ESP combinés) | `IPSecEngine.ts` |
| 20 | ESN (Extended Sequence Numbers 64 bits) | `IPSecTypes.ts`, `IPSecEngine.ts` |
| ~~21~~ | ~~Path MTU / DF bit / Fragmentation~~ | ✅ Fait — `IPSecTypes.ts`, `IPSecEngine.ts` |
| ~~22~~ | ~~DSCP / ECN handling~~ | ✅ Fait — `IPSecTypes.ts`, `IPSecEngine.ts` |
| 23 | PowerShell IPsec commands Windows | Nouveau fichier |

---

*Document généré par l'analyse automatique du code source du simulateur réseau.*
*Dernière mise à jour : 2026-03-16*

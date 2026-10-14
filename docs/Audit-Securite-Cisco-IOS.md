# Audit de la securite : Cisco IOS Security Command Reference

Source : les quatre tomes de `official_docs/cisco/ios-security/` (A a C, D a L, M a R, S a Z).
Index extrait par `scripts/cisco/extract_security_commands.py` dans `official_docs/cisco/ios-security/commands-index.json` (nom, syntaxe et mode de chaque commande documentee).

## Methode

Pour chaque commande documentee dont le mode est mesurable (EXEC utilisateur, EXEC privilegie, configuration globale, d'interface ou de ligne), un `CiscoRouter` recoit `<mots deja acquis> ?` mot apres mot : le mot suivant du nom documente doit etre propose par l'aide. La sonde `probe-cisco-security-reference-coverage.test.ts` rejoue la mesure et interdit toute regression.

Une commande « reconnue » veut dire que son NOM est connu de la CLI, pas que son effet est evalue : c'est un plafond, pas un diagnostic de fidelite.

## Resultat

| | Commandes |
| --- | --- |
| Documentees (index) | 1989 |
| Dans un mode non mesure (sous-modes crypto, webvpn, class-map, pki, ...) | 961 |
| Dans un mode mesure | 1028 |
| Reconnues mot pour mot | 128 |
| Reconnues en partie (un prefixe seulement) | 644 |
| Inconnues | 256 |

## Familles les plus touchees (modes mesures)

| Famille | Documentees | Reconnues | En partie | Inconnues |
| --- | --- | --- | --- | --- |
| `show crypto` | 71 | 16 | 55 | 0 |
| `aaa` | 63 | 9 | 54 | 0 |
| `crypto pki` | 42 | 4 | 19 | 19 |
| `radius-server` | 40 | 3 | 37 | 0 |
| `dot1x` | 24 | 0 | 0 | 24 |
| `show ip` | 23 | 2 | 21 | 0 |
| `ip ssh` | 21 | 11 | 10 | 0 |
| `show ipv6` | 21 | 1 | 20 | 0 |
| `crypto ipsec` | 20 | 4 | 13 | 3 |
| `authentication` | 19 | 0 | 0 | 19 |
| `ip inspect` | 18 | 0 | 18 | 0 |
| `ip ips` | 16 | 0 | 16 | 0 |
| `crypto isakmp` | 15 | 7 | 8 | 0 |
| `cts` | 15 | 0 | 0 | 15 |
| `ipv6 nd` | 15 | 0 | 15 | 0 |
| `ppp` | 15 | 0 | 0 | 15 |
| `ip security` | 14 | 0 | 14 | 0 |
| `clear ip` | 13 | 1 | 12 | 0 |
| `ipv6 inspect` | 13 | 0 | 13 | 0 |
| `kerberos` | 13 | 0 | 0 | 13 |
| `mls` | 13 | 0 | 0 | 13 |
| `crypto ikev2` | 12 | 7 | 5 | 0 |
| `ip tcp` | 12 | 0 | 12 | 0 |
| `show aaa` | 12 | 2 | 10 | 0 |
| `clear crypto` | 11 | 2 | 8 | 1 |
| `parameter-map` | 11 | 2 | 9 | 0 |
| `crypto ca` | 10 | 0 | 10 | 0 |
| `eou` | 10 | 0 | 0 | 10 |

## Lecture

- Les familles dont le moteur existe deja dans le depot (AAA, RADIUS, TACACS+, SSH, IPsec/IKE, PKI, zone-based firewall, inspection `ip inspect`) sont reconnues en partie : le socle est la, il manque les options. Ce sont les premieres a fermer, parce qu'un moteur sait deja les evaluer.
- Les familles sans moteur (`dot1x`/`authentication` de session, `cts`, `ppp`, `kerberos`, `webvpn`, `xsm`, `eou`, `diameter`, `device-sensor`) sont inconnues en bloc : chacune demande son sous-systeme avant sa CLI, selon la regle 6 (aucun critere stocke sans etre evalue).
- Les sous-modes non mesures (961 commandes) demandent d'abord une mesure par sous-mode.

## Ordre de fermeture retenu

1. `aaa` : invites et messages de connexion, `max-sessions`, comptabilite (`update`, `nested`, `gigawords`), `authorization console`.
2. `radius-server` et `tacacs-server` : `deadtime`, `dead-criteria`, `load-balance`, `directed-request`, `domain-stripping`, `vsa send`, `transaction max-tries`.
3. `ip ssh` : `port`, `maxstartups`, `rekey`, `stricthostkeycheck`, `dscp`.
4. `username` : `secret`, `algorithm-type`.
5. `show`/`clear` des moteurs deja presents.

Chaque lot ajoute ses commandes sur le socle, evalue ce qu'elle porte, et releve le plancher de la sonde.

# Full-project regression report

Branch `mandeng`. Full vitest sweep of every test file; no failing test was fixed.

## Totals

- Test files run: 3564 (1779 in the first sweep `run.log`, 1785 in 36 resumable chunks of 50)
- Chunked part: 1785 files, 26044 tests, 25925 passed, 26 failed (18 files)
- First part: failing files listed below from the vitest console log

## Failing files

| File | Failed | Tests in file |
|---|---|---|
| `src/__tests__/audit/storm-control-audit-preuves.test.ts` | 1 | 6 |
| `src/__tests__/audit/vacl-mac-clause.test.ts` | 1 | 6 |
| `src/__tests__/debug/infra/durcissement-infra-entreprise.debug.test.ts` | 1 | 1 |
| `src/__tests__/unit/cli/migration-guard.test.ts` | 1 | 21 |
| `src/__tests__/unit/cli/show-remote-admin-slice.test.ts` | 1 | 30 |
| `src/__tests__/unit/database/oracle-user-activity.test.ts` | 1 | 10 |
| `src/__tests__/unit/network-v2/chage-fail2ban-expiry-cascade.test.ts` | 1 | 8 |
| `src/__tests__/unit/network-v2/chage-fail2ban-warning-period.test.ts` | 1 | 5 |
| `src/__tests__/unit/network-v2/cross-equipment-ssh-suite.test.ts` | 3 | 233 |
| `src/__tests__/unit/network-v2/dhcp-conflit-avant-offre.test.ts` | 6 | 16 |
| `src/__tests__/unit/network-v2/dhcp-rfc4388-leasequery.test.ts` | 4 | 30 |
| `src/__tests__/unit/network-v2/dhcp-rfc6926-bulk-leasequery.test.ts` | 6 | 19 |
| `src/__tests__/unit/network-v2/dhcpv6-rfc8415-fil-relais-temporisation.test.ts` | 1 | 17 |
| `src/__tests__/unit/network-v2/dhcpv6-rfc8415-unicast-refresh-reconfigure.test.ts` | 1 | 37 |
| `src/__tests__/unit/network-v2/faults/fault-sigkill-residues.test.ts` | 1 | 13 |
| `src/__tests__/unit/network-v2/faults/fault-ssh-session-cross-vendor.test.ts` | 1 | 21 |
| `src/__tests__/unit/network-v2/firewall/architecture-guards.test.ts` | 1 | 37 |
| `src/__tests__/unit/network-v2/firewall/probe-ssh-depuis-une-cli-vers-le-pare-feu.test.ts` | 2 | 10 |
| `src/__tests__/unit/network-v2/ike-real-diffie-hellman.test.ts` | 2 | 40 |
| `src/__tests__/unit/network-v2/journalization.test.ts` | 19 | 200 |
| `src/__tests__/unit/network-v2/layers/no-component-falls-back-to-a-shared-bus.test.ts` | 1 | 5 |
| `src/__tests__/unit/network-v2/linux-background-jobs.test.ts` | 1 | 7 |
| `src/__tests__/unit/network-v2/linux-dhcpd-serveur.test.ts` | 10 | 22 |
| `src/__tests__/unit/network-v2/linux-dhcpd6-isc.test.ts` | 9 | 15 |
| `src/__tests__/unit/network-v2/linux-hosts-hostname-hijack.test.ts` | 1 | 12 |
| `src/__tests__/unit/network-v2/nss-resolution-unified.test.ts` | 1 | 7 |
| `src/__tests__/unit/network-v2/probe-active-directory-approbations-et-machines-jointes.test.ts` | 18 | 18 |
| `src/__tests__/unit/network-v2/probe-active-directory-domaines-enfants-et-controleurs-supplementaires.test.ts` | 12 | 14 |
| `src/__tests__/unit/network-v2/probe-active-directory-etat-de-replication.test.ts` | 12 | 14 |
| `src/__tests__/unit/network-v2/probe-active-directory-ne-garde-que-ce-qui-a-change.test.ts` | 1 | 10 |
| `src/__tests__/unit/network-v2/probe-active-directory-niveau-fonctionnel-de-domaine-replique.test.ts` | 4 | 6 |
| `src/__tests__/unit/network-v2/probe-adcs-l-autorite-et-ses-certificats-survivent-a-la-sauvegarde.test.ts` | 9 | 9 |
| `src/__tests__/unit/network-v2/probe-aide-cr-tient-sa-promesse.test.ts` | 2 | 35 |
| `src/__tests__/unit/network-v2/probe-aide-du-mot-cle-absorbe.test.ts` | 1 | 28 |
| `src/__tests__/unit/network-v2/probe-aide-vrp-tient-ses-promesses.test.ts` | 2 | 15 |
| `src/__tests__/unit/network-v2/probe-base-de-paquets.test.ts` | 2 | 12 |
| `src/__tests__/unit/network-v2/probe-cable-interface-virtuelle.test.ts` | 1 | 18 |
| `src/__tests__/unit/network-v2/probe-cle-d-hote-au-format-du-fil.test.ts` | 1 | 7 |
| `src/__tests__/unit/network-v2/probe-cle-privee-d-hote-est-privee.test.ts` | 1 | 5 |
| `src/__tests__/unit/network-v2/probe-couche-internet-un-seul-ttl.test.ts` | 2 | 14 |
| `src/__tests__/unit/network-v2/probe-horloge-de-trajet.test.ts` | 1 | 10 |
| `src/__tests__/unit/network-v2/probe-iis-sites-pools-et-liaisons-https-survivent-a-la-sauvegarde.test.ts` | 14 | 14 |
| `src/__tests__/unit/network-v2/probe-journal-sshd-fidele.test.ts` | 13 | 13 |
| `src/__tests__/unit/network-v2/probe-la-persistance-ne-garde-que-ce-qui-a-change.test.ts` | 2 | 30 |
| `src/__tests__/unit/network-v2/probe-mac-apres-ouverture-topologie.test.ts` | 2 | 8 |
| `src/__tests__/unit/network-v2/probe-nps-clients-strategies-et-comptabilite-survivent-a-la-sauvegarde.test.ts` | 1 | 11 |
| `src/__tests__/unit/network-v2/probe-ssh-keyscan-les-bannieres-avant-les-cles.test.ts` | 2 | 7 |
| `src/__tests__/unit/network-v2/probe-strict-host-key-checking-ask-et-yes-sont-deux-choses.test.ts` | 1 | 9 |
| `src/__tests__/unit/network-v2/run-parts.test.ts` | 4 | 150 |
| `src/__tests__/unit/network-v2/scenario-ephemeral-port-coherence.test.ts` | 1 | 7 |
| `src/__tests__/unit/network-v2/script-process-coherence.test.ts` | 1 | 13 |
| `src/__tests__/unit/network-v2/sniffers-observateur-ordre-dora.test.ts` | 2 | 4 |
| `src/__tests__/unit/network-v2/ss-nomme-le-processus-udp.test.ts` | 4 | 8 |
| `src/__tests__/unit/network-v2/ssh-publickey-fallback-on-bad-modes.test.ts` | 1 | 5 |
| `src/__tests__/unit/network-v2/tcpdump-bootp-dhcp.test.ts` | 4 | 17 |
| `src/__tests__/unit/network-v2/tcpdump-observateur-ordre-dora.test.ts` | 3 | 4 |
| `src/__tests__/unit/network-v2/tls-legacy-resumption-probe.test.ts` | 1 | 15 |
| `src/__tests__/unit/network-v2/topology-roundtrip-agregations.test.ts` | 4 | 10 |
| `src/__tests__/unit/network-v2/topology-roundtrip-physical.test.ts` | 3 | 21 |
| `src/__tests__/unit/network-v2/topology-roundtrip-services-sticky.test.ts` | 1 | 8 |
| `src/__tests__/unit/network-v2/topology-roundtrip-windows-registry-services.test.ts` | 1 | 13 |
| `src/__tests__/unit/network-v2/topology-roundtrip.test.ts` | 1 | 8 |
| `src/__tests__/unit/network-v2/tuto-ssh-zero-a-heros.test.ts` | 1 | 45 |
| `src/__tests__/unit/network-v2/vim-system-config-filetype.test.ts` | 1 | 6 |
| `src/__tests__/unit/new_firewall/fortigate-battery-02-advanced-transit.test.ts` | 1 | 50 |
| `src/__tests__/unit/new_firewall/fortigate-battery-03-security-pbr-ipsec-qos.test.ts` | 13 | 50 |
| `src/__tests__/unit/new_firewall/fortigate-battery-04-monitoring-telemetry-syslog.test.ts` | 27 | 50 |
| `src/__tests__/unit/new_firewall/fortigate-battery-05-ha-vrf-dpi-radius.test.ts` | 34 | 50 |
| `src/__tests__/unit/new_firewall/fortigate-battery-06-ipv6-ospf-bgp-ztna.test.ts` | 32 | 50 |
| `src/__tests__/unit/new_firewall/fortigate-battery-07-windows-active-directory.test.ts` | 14 | 50 |
| `src/__tests__/unit/new_firewall/fortigate-battery-08-cyber-defense-tls-pvlan.test.ts` | 26 | 50 |
| `src/__tests__/unit/new_firewall/fortigate-battery-09-tls-crypto-pki.test.ts` | 44 | 50 |
| `src/__tests__/unit/new_firewall/fortigate-battery-10-sdwan-vxlan-pqc.test.ts` | 29 | 50 |
| `src/__tests__/unit/new_firewall/fortigate-battery-11-hybrid-cloud-evpn-k8s.test.ts` | 28 | 50 |

Failures are recorded as found; files such as `fortigate-battery-*`, `architecture-guards` and `linux-hosts-hostname-hijack` fail on the base commits too.
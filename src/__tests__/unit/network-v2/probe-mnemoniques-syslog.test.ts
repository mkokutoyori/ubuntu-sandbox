/**
 * Sonde — le mnémonique d'un message de syslog n'est pas sa sévérité.
 *
 * Mesure de départ : `formatEntry` rendait
 * `(mnemonic ?? severity).toUpperCase()`, et 92 des 105 appels à
 * `append()` n'en passaient aucun. L'équipement imprimait donc
 * `%TCP-4-WARNINGS`, `%CDP-6-INFORMATIONAL`, `%RIP-5-NOTIFICATIONS` :
 * la sévérité répétée en toutes lettres à la place de la seule
 * information que la troisième composante porte, laquelle des lignes
 * de cette famille vient d'être émise.
 *
 * Ce que ces cas vérifient, dans l'ordre : qu'aucune ligne ne porte
 * plus un nom de sévérité en mnémonique ; que les familles qu'IOS
 * journalise portent le leur ; que celles qu'il ne journalise pas
 * n'écrivent rien ; et que la sortie de `debug`, qui n'est pas du
 * syslog, reste sans `%FACILITÉ-N-MNÉMONIQUE`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress } from '@/network/core/types';
import {
  LoggingConfig, DEBUG_VERBATIM, mnemonicFromEvent,
} from '@/network/devices/inspection/config/LoggingConfig';

const NOMS_DE_SEVERITE = [
  'EMERGENCIES', 'ALERTS', 'CRITICAL', 'ERRORS', 'WARNINGS',
  'NOTIFICATIONS', 'INFORMATIONAL', 'DEBUGGING',
];

function mnemoniques(journal: string): string[] {
  const out: string[] = [];
  for (const m of journal.matchAll(/%[A-Z0-9_]+-\d-([A-Z0-9_]+):/g)) out.push(m[1]);
  return out;
}

async function routeurJournalisant(bus: EventBus, nom: string): Promise<CiscoRouter> {
  const r = new CiscoRouter(nom);
  r.setEventBus(bus);
  await Promise.resolve(r.executeCommand('enable'));
  await Promise.resolve(r.executeCommand('configure terminal'));
  await Promise.resolve(r.executeCommand('logging buffered 16000 debugging'));
  await Promise.resolve(r.executeCommand('end'));
  return r;
}

describe('Sonde — le mnémonique n\'est plus fabriqué depuis la sévérité', () => {
  let bus: EventBus;
  beforeEach(() => { bus = new EventBus(); });

  it('une violation de port-security porte PSECURE_VIOLATION, pas CRITICAL', async () => {
    const r = await routeurJournalisant(bus, 'R1');
    bus.publish({
      topic: 'port.security.violation',
      payload: {
        deviceId: r.id, portName: 'GigabitEthernet0/0',
        mac: new MACAddress('00:11:22:33:44:55'), mode: 'shutdown', action: 'shutdown',
      },
    });
    const out = await Promise.resolve(r.executeCommand('show logging'));
    expect(out).toContain('%PORT_SECURITY-2-PSECURE_VIOLATION:');
    expect(out).not.toContain('%PORT_SECURITY-2-CRITICAL');
  });

  it('la mise en err-disable porte ERR_DISABLE et sa levée ERR_RECOVER', async () => {
    const r = await routeurJournalisant(bus, 'R2');
    bus.publish({
      topic: 'port.security.errdisable.set',
      payload: {
        deviceId: r.id, portName: 'GigabitEthernet0/0',
        mac: new MACAddress('00:11:22:33:44:55'),
      },
    });
    bus.publish({
      topic: 'port.security.errdisable.cleared',
      payload: { deviceId: r.id, portName: 'GigabitEthernet0/0' },
    });
    const out = await Promise.resolve(r.executeCommand('show logging'));
    expect(out).toContain('-ERR_DISABLE:');
    expect(out).toContain('-ERR_RECOVER:');
  });

  it('HSRP, VRRP et GLBP portent tous les trois STATECHANGE', async () => {
    const r = await routeurJournalisant(bus, 'R3');
    bus.publish({
      topic: 'hsrp.state.changed',
      payload: { deviceId: r.id, iface: 'GigabitEthernet0/0', group: 1, oldState: 'Standby', newState: 'Active' },
    });
    bus.publish({
      topic: 'vrrp.state.changed',
      payload: { deviceId: r.id, iface: 'GigabitEthernet0/1', vrid: 7, oldState: 'Backup', newState: 'Master' },
    });
    bus.publish({
      topic: 'glbp.avg.changed',
      payload: { deviceId: r.id, iface: 'GigabitEthernet0/2', group: 3, oldState: 'Standby', newState: 'Active' },
    });
    const out = await Promise.resolve(r.executeCommand('show logging'));
    expect(out).toContain('%HSRP-5-STATECHANGE:');
    expect(out).toContain('%VRRP-5-STATECHANGE:');
    expect(out).toContain('%GLBP-5-STATECHANGE:');
  });

  it('EtherChannel distingue BUNDLE de UNBUNDLE', async () => {
    const r = await routeurJournalisant(bus, 'R4');
    bus.publish({
      topic: 'lacp.port.bundled',
      payload: { deviceId: r.id, port: 'GigabitEthernet0/0', groupId: 1 },
    });
    bus.publish({
      topic: 'lacp.port.unbundled',
      payload: { deviceId: r.id, port: 'GigabitEthernet0/0', groupId: 1, cause: 'link down' },
    });
    const out = await Promise.resolve(r.executeCommand('show logging'));
    expect(out).toContain('-BUNDLE:');
    expect(out).toContain('-UNBUNDLE:');
  });

  it('NTP distingue la synchronisation de sa perte', async () => {
    const r = await routeurJournalisant(bus, 'R5');
    bus.publish({
      topic: 'ntp.synced',
      payload: { deviceId: r.id, serverIp: '10.0.0.9', newStratum: 3, offsetMs: 4 },
    });
    bus.publish({
      topic: 'ntp.unsynced',
      payload: { deviceId: r.id, reason: 'no reachable server' },
    });
    const out = await Promise.resolve(r.executeCommand('show logging'));
    expect(out).toContain('%NTP-5-PEERSYNC:');
    expect(out).toContain('%NTP-4-PEERUNSYNC:');
  });

  it('aucune ligne du journal ne porte un NOM DE SÉVÉRITÉ en mnémonique', async () => {
    const r = await routeurJournalisant(bus, 'R6');
    const evenements: Array<{ topic: string; payload: Record<string, unknown> }> = [
      { topic: 'hsrp.state.changed', payload: { iface: 'Gi0/0', group: 1, oldState: 'Speak', newState: 'Active' } },
      { topic: 'hsrp.active.changed', payload: { iface: 'Gi0/0', group: 1, activeIp: '10.0.0.1', activePriority: 110 } },
      { topic: 'vrrp.master.changed', payload: { iface: 'Gi0/1', vrid: 2, masterIp: '10.0.1.1' } },
      { topic: 'bfd.session.changed', payload: { neighborIp: '10.0.0.2', iface: 'Gi0/0', oldState: 'Init', newState: 'Up' } },
      { topic: 'snmp.auth.rejected', payload: { fromIp: '10.0.0.9', community: 'public', reason: 'bad community' } },
      { topic: 'stp.root.changed', payload: { oldRootMac: '00:00:00:00:00:01', newRootMac: '00:00:00:00:00:02', rootPort: 'Gi0/0' } },
      { topic: 'stp.topology.change', payload: { origin: 'Gi0/0', port: 'Gi0/0' } },
      { topic: 'pim.neighbor.added', payload: { iface: 'Gi0/0', neighborIp: '10.0.0.2' } },
      { topic: 'pim.dr.changed', payload: { iface: 'Gi0/0', newDrIp: '10.0.0.2' } },
      { topic: 'udld.err-disable', payload: { port: 'Gi0/0' } },
      { topic: 'eigrp.neighbor.state-changed', payload: { neighbor: '10.0.0.2', iface: 'Gi0/0', newState: 'up', asn: 100 } },
      { topic: 'ipsec.ike.sa-installed', payload: { peerIp: '10.0.0.2', spiInitiator: 0x1234 } },
      { topic: 'ipsec.dpd.peer-down', payload: { peerIp: '10.0.0.2' } },
      { topic: 'dhcp.address-conflict', payload: { ip: '10.0.0.50' } },
      { topic: 'arp.rate-limit-exceeded', payload: { ingressPort: 'Gi0/0', observedPps: 90 } },
      { topic: 'router.aaa.account.login.failure', payload: { account: { name: 'bob' }, from: '10.0.0.9', reason: 'bad password' } },
      { topic: 'radius.auth.rejected', payload: { username: 'bob', fromIp: '10.0.0.9', reason: 'reject' } },
    ];
    for (const e of evenements) {
      bus.publish({ topic: e.topic, payload: { deviceId: r.id, ...e.payload } } as never);
    }
    const out = await Promise.resolve(r.executeCommand('show logging'));
    const vus = mnemoniques(out);
    expect(vus.length).toBeGreaterThan(10);
    for (const m of vus) expect(NOMS_DE_SEVERITE).not.toContain(m);
  });

  it('un segment vers un port fermé n\'écrit RIEN — un vrai IOS répond un RST en silence', async () => {
    const cli = new CiscoRouter('CLI');
    const srv = await routeurJournalisant(bus, 'SRV');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cli.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cli.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(srv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    cli.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    srv.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    cli.getTcpStack().connect('10.0.0.2', 9999);
    const out = await Promise.resolve(srv.executeCommand('show logging'));
    expect(out).not.toContain('Segment dropped');
    expect(out).not.toContain('%TCP-4');
  });

  it('la découverte d\'un voisin CDP ou LLDP n\'écrit rien non plus', async () => {
    const r = await routeurJournalisant(bus, 'R7');
    bus.publish({
      topic: 'cdp.neighbor.discovered',
      payload: { deviceId: r.id, localPort: 'Gi0/0', neighborName: 'SW1' },
    } as never);
    bus.publish({
      topic: 'lldp.neighbor.discovered',
      payload: { deviceId: r.id, localPort: 'Gi0/0', neighborName: 'SW1' },
    } as never);
    bus.publish({
      topic: 'cdp.config.changed',
      payload: { deviceId: r.id, enabled: true },
    } as never);
    const out = await Promise.resolve(r.executeCommand('show logging'));
    expect(out).not.toContain('%CDP-6-');
    expect(out).not.toContain('%LLDP-6-');
    expect(out).not.toContain('CDP enabled');
  });

  it('une ligne de `debug` reste verbatim — la sortie de debug n\'est pas du syslog', () => {
    const l = new LoggingConfig();
    l.apply(['buffered', '8000', 'debugging'], false);
    const rendu = l.recordDebugLine('ICMP: echo reply sent, src 10.0.0.2, dst 10.0.0.1');
    expect(rendu).toContain('ICMP: echo reply sent');
    expect(rendu).not.toMatch(/%[A-Z]+-\d-/);
  });

  it('DEBUG_VERBATIM est la chaîne vide, et un mnémonique vide rend la ligne nue', () => {
    expect(DEBUG_VERBATIM).toBe('');
    const l = new LoggingConfig();
    l.apply(['buffered', '8000', 'debugging'], false);
    l.append('debugging', 'ospf', 'OSPF: paquet', true, DEBUG_VERBATIM);
    l.append('warnings', 'link', 'lien perdu', true, 'UPDOWN');
    const out = l.render();
    expect(out).toContain('OSPF: paquet');
    expect(out).not.toContain('%OSPF-7-');
    expect(out).toContain('%LINK-4-UPDOWN:');
  });

  it('mnemonicFromEvent traduit ce qu\'IOS journalise et rend null pour le reste', () => {
    expect(mnemonicFromEvent('stp:root-guard')).toBe('ROOTGUARD_BLOCK');
    expect(mnemonicFromEvent('ipsec:anti-replay')).toBe('PKT_REPLAY_ERR');
    expect(mnemonicFromEvent('switch:mac-move')).toBe('MACFLAP_NOTIF');
    expect(mnemonicFromEvent('eigrp:k-mismatch')).toBe('NBRCHANGE');
    // Un compteur de paquet malformé ne produit aucune ligne de syslog.
    expect(mnemonicFromEvent('ipv4:checksum-fail')).toBeNull();
    expect(mnemonicFromEvent('equipment:send-error')).toBeNull();
    // Et un événement absent de la table ne s'invente pas.
    expect(mnemonicFromEvent('quelque:chose-qui-nexiste-pas')).toBeNull();
  });

  it('`show logging count` regroupe par mnémonique, ce qui n\'a de sens que s\'il est réel', async () => {
    const r = await routeurJournalisant(bus, 'R8');
    await Promise.resolve(r.executeCommand('configure terminal'));
    await Promise.resolve(r.executeCommand('logging count'));
    await Promise.resolve(r.executeCommand('end'));
    bus.publish({
      topic: 'hsrp.state.changed',
      payload: { deviceId: r.id, iface: 'Gi0/0', group: 1, oldState: 'Speak', newState: 'Active' },
    });
    bus.publish({
      topic: 'vrrp.state.changed',
      payload: { deviceId: r.id, iface: 'Gi0/1', vrid: 2, oldState: 'Backup', newState: 'Master' },
    });
    const out = await Promise.resolve(r.executeCommand('show logging count'));
    expect(out).toContain('STATECHANGE');
    expect(out).not.toContain('NOTIFICATIONS');
  });

  it('un discriminateur sur `mnemonics` filtre une famille, pas un niveau', () => {
    const l = new LoggingConfig();
    l.apply(['discriminator', 'MD1', 'mnemonics', 'drops', 'UPDOWN'], false);
    l.apply(['buffered', 'discriminator', 'MD1', '8000', 'debugging'], false);
    l.append('errors', 'link', 'Interface Gi0/0, changed state to down', true, 'UPDOWN');
    l.append('errors', 'link', 'Interface Gi0/1, changed state to administratively down', true, 'CHANGED');
    const out = l.render();
    expect(out).not.toContain('changed state to down');
    expect(out).toContain('administratively down');
  });
});

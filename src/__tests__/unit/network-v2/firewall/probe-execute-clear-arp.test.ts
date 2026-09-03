/**
 * `execute clear system arp table` vide la table ARP, pour de bon.
 *
 * Mesure de depart : la commande n'existait pas (`unknown action
 * "clear"`), alors que `ArpService.clear()` etait ECRITE et n'avait
 * AUCUN appelant de production -- un moteur sans porte, le meme patron
 * que `PingOptions.reset()` du lot precedent. La table est pourtant
 * visible (`diagnose ip arp list` la rend) et vivante (un `execute ping`
 * l'alimente), donc la purge etait mesurable : il ne manquait que la
 * commande.
 *
 * `official_docs/forti-cli-ref-60.txt` donne `execute clear system arp
 * table` -- « Clear system ARP table. » -- et c'est le SEUL membre de la
 * famille `execute clear` dans toute la reference. La porte est donc
 * ouverte sur ce chemin exact et refuse le reste, plutot que d'accepter
 * une arborescence que la vraie machine n'a pas.
 *
 * Le laboratoire ADRESSE le poste avant de pinguer, et c'est la premiere
 * version de la sonde qui l'a impose : sans adresse, le ping
 * n'apprenait rien, le cache restait vide, et « vider une table vide »
 * aurait passe sans rien prouver.
 *
 * Discrimine par `git stash` sur les deux fichiers cables : 4 cas
 * tombent. Le seul qui passe des deux cotes est le TEMOIN, dont c'est
 * l'objet : un ping alimente la table, ce qui a toujours ete vrai et
 * sans quoi la purge serait indiscernable d'un laboratoire vide.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function laboratoire() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const poste = new LinuxPC('linux-pc', 'PC', 200, 0);
  poste.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, poste.getPorts()[0]);

  for (const c of ['config system interface', 'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next', 'end']) {
    sh.execute(c);
  }
  for (const c of ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0']) {
    await poste.executeCommand(c);
  }
  sh.execute('execute ping 192.168.1.10');
  return { fw, sh };
}

describe('FortiGate : execute clear system arp table', () => {
  it('TEMOIN : un ping alimente la table ARP', async () => {
    const { fw, sh } = await laboratoire();
    expect(fw.getArpService().getCache().size).toBeGreaterThan(0);
    expect(sh.execute('diagnose ip arp list')).toContain('192.168.1.10');
  });

  it('la commande VIDE la table', async () => {
    const { fw, sh } = await laboratoire();
    expect(sh.execute('execute clear system arp table')).toBe('');
    expect(fw.getArpService().getCache().size).toBe(0);
  });

  it('la vue qui rendait la table ne rend plus rien', async () => {
    const { sh } = await laboratoire();
    sh.execute('execute clear system arp table');
    expect(sh.execute('diagnose ip arp list')).not.toContain('192.168.1.10');
  });

  it('un chemin que la reference ne porte pas est REFUSE', async () => {
    const { sh } = await laboratoire();
    expect(sh.execute('execute clear system zorglub')).toContain('unknown action');
    expect(sh.execute('execute clear system routing table')).toContain('unknown action');
    expect(sh.execute('execute clear')).toContain('what to clear');
  });

  it('l aide nomme la seule suite que la commande admet', async () => {
    const { sh } = await laboratoire();
    const mots = sh.help('execute clear ')
      .map(l => l.trim().split(/\s{2,}/)[0]).filter(w => w !== '<cr>');
    expect(mots).toEqual(['system']);
    expect(sh.completions('execute clear sy')).toEqual(['execute clear system']);
  });
});

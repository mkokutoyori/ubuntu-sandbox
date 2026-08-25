/**
 * TP 21 — monter un cluster FGCP et le faire basculer, rejoue pas a pas.
 *
 * Ecrit A L'AVEUGLE contre le tutoriel. Dix des dix-neuf cas tombent ;
 * les neuf qui passent le doivent au moteur FGCP deja en place — le
 * battement de coeur traverse un vrai fil, l'election existe, la
 * configuration se propage, `session-pickup` porte les sessions.
 *
 * Ce que la mesure a trouve derriere ces neuf-la :
 *
 *   1. **`override` ne servait a RIEN.** FGCP ordonne ses criteres
 *      differemment selon ce reglage : sans lui, la duree de
 *      fonctionnement passe AVANT la priorite ; avec lui, la priorite
 *      passe avant. Le depart etait cable sur l'ordre « override
 *      active », donc `override disable` — le defaut, et ce que ce TP
 *      enseigne a l'etape 11 — se comportait comme son contraire.
 *   2. **La duree de fonctionnement HA ne retombait pas a zero** quand
 *      une interface surveillee tombait. C'est ce qui empeche, sur une
 *      vraie machine, qu'un membre repare reprenne la main sur son
 *      anciennete.
 *   3. **Deux membres d'une meme grappe ne pouvaient JAMAIS concorder** :
 *      le certificat d'usine est propre a chaque unite et entrait dans
 *      l'empreinte de configuration. Le cas existant ne pouvait pas
 *      l'attraper, car il comparait deux VUES — qui listent la meme paire
 *      d'empreintes — et non les deux empreintes entre elles.
 *   4. **`Group:` rendait l'IDENTIFIANT et taisait le NOM.** Un vrai
 *      FortiOS rend deux lignes, `Group Name:` et `Group ID:`.
 *   5. **La ligne `Slave :` ne nommait personne** et la ligne `Master:`
 *      portait le nom de la machine QUI REGARDE : un membre ne
 *      transportait pas son nom d'hote dans son battement de coeur.
 *   6. **`set hbdev "port5" 50 "port6" 100` ressortait sans guillemets**,
 *      et la configuration rendue est rejouee a l'import.
 *   7. Trois commandes du TP n'existaient pas : `diagnose sys ha checksum
 *      cluster`, `execute ha synchronize start`, `diagnose sys ha
 *      reset-uptime`.
 *   8. **Le SECONDAIRE faisait passer le trafic**, exactement comme le
 *      primaire, et repondait a l'ARP pour la meme adresse. « a-p »
 *      nommait donc un role qui ne decidait rien : la grappe etait deux
 *      pare-feux independants portant la meme adresse, et l'etape 8 ne
 *      prouvait rien. Mesure : deux `ping` depuis le LAN, et les DEUX
 *      membres emettent deux trames vers la zone demilitarisee.
 *
 * L'etape 11 avance explicitement la duree de fonctionnement du membre
 * qui survit : la granularite de ce critere est de cinq minutes sur une
 * vraie machine, et sans cet ecart les deux membres sont a egalite, donc
 * l'ordre des criteres ne departagerait rien — le cas ne prouverait pas
 * ce qu'il pretend.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function taper(d: Cmd, cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of cmds) out.push(await d.executeCommand(c));
  return out;
}

function propre(sorties: string[]): void {
  for (const s of sorties) {
    expect(s).not.toMatch(/Unknown action|command parse error|Invalid|entry not found/i);
  }
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function interfaces(fgt: FortiGate): Promise<void> {
  await taper(fgt, [
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 192.168.20.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config firewall policy',
    'edit 1', 'set name "LAN-vers-DMZ"',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
    'set action accept', 'next', 'end',
  ]);
}

async function laboratoire() {
  const maitre = new FortiGate('firewall-fortinet', 'FGT-01', 0, -60);
  const esclave = new FortiGate('firewall-fortinet', 'FGT-02', 0, 60);
  const lan = new LinuxPC('linux-pc', 'PC-LAN', -200, 0);
  const dmz = new LinuxPC('linux-pc', 'SRV-DMZ', 200, 0);
  const comLan = new GenericSwitch('switch-generic', 'SW-LAN', 8, -100, 0);
  const comDmz = new GenericSwitch('switch-generic', 'SW-DMZ', 8, 100, 0);

  const coeur5 = new Cable('hb1');
  const coeur6 = new Cable('hb2');
  coeur5.connect(maitre.getPort('port5')!, esclave.getPort('port5')!);
  coeur6.connect(maitre.getPort('port6')!, esclave.getPort('port6')!);

  const lanMaitre = new Cable('lan-m');
  const dmzMaitre = new Cable('dmz-m');
  lanMaitre.connect(maitre.getPort('port1')!, comLan.getPort('eth0')!);
  dmzMaitre.connect(maitre.getPort('port2')!, comDmz.getPort('eth0')!);
  new Cable('lan-e').connect(esclave.getPort('port1')!, comLan.getPort('eth1')!);
  new Cable('dmz-e').connect(esclave.getPort('port2')!, comDmz.getPort('eth1')!);
  new Cable('pc').connect(lan.getPort('eth0')!, comLan.getPort('eth2')!);
  new Cable('srv').connect(dmz.getPort('eth0')!, comDmz.getPort('eth2')!);

  await interfaces(maitre);
  await interfaces(esclave);
  await taper(lan, [
    'ip link set eth0 up', 'ip addr add 192.168.10.10/24 dev eth0',
    'ip route add default via 192.168.10.1',
  ]);
  await taper(dmz, [
    'ip link set eth0 up', 'ip addr add 192.168.20.10/24 dev eth0',
    'ip route add default via 192.168.20.1',
  ]);

  return { maitre, esclave, lan, dmz, comLan, comDmz, coeur5, coeur6, lanMaitre, dmzMaitre };
}

async function grappe(fgt: FortiGate, priorite: number, ...extra: string[]) {
  return taper(fgt, [
    'config system ha',
    'set group-name "CLUSTER-LAB"',
    'set mode a-p',
    'set password "HALab2026!"',
    'set hbdev "port5" 50 "port6" 100',
    'set session-pickup enable',
    `set priority ${priorite}`,
    'set override disable',
    'set monitor "port1" "port2"',
    ...extra,
    'end',
  ]);
}

function battre(maitre: FortiGate, esclave: FortiGate, tours = 4): void {
  for (let tour = 0; tour < tours; tour++) {
    maitre.getHa().tick();
    esclave.getHa().tick();
  }
}

describe('TP 21 — Monter un cluster et le faire basculer', () => {
  it('etape 2 : `hbdev` prend DEUX interfaces avec leur priorite', async () => {
    const { maitre } = await laboratoire();
    propre(await grappe(maitre, 200));

    const conf = await maitre.executeCommand('show system ha');
    expect(conf).toContain('set hbdev "port5" 50 "port6" 100');
    expect(conf).toContain('set monitor "port1" "port2"');
    expect(conf).toContain('set session-pickup enable');
    expect(conf).toContain('set override disable');
  });

  it('etape 2 : une interface de battement INCONNUE est refusee', async () => {
    const { maitre } = await laboratoire();
    const sorties = await taper(maitre, [
      'config system ha', 'set hbdev "port99" 50', 'end',
    ]);
    expect(sorties.join('\n')).toMatch(/Command fail|does not exist|entry not found/i);
  });

  it('etape 4 : `get system ha status` rend le format de FortiOS', async () => {
    const { maitre, esclave } = await laboratoire();
    await grappe(maitre, 200);
    await grappe(esclave, 100);
    battre(maitre, esclave);

    const vue = await maitre.executeCommand('get system ha status');
    expect(vue).toContain('HA Health Status: OK');
    expect(vue).toContain('Mode: HA A-P');
    expect(vue).toContain('Group Name: CLUSTER-LAB');
    expect(vue).toContain('Group ID: 0');
    expect(vue).toMatch(/^Master: FGT-01, FGVMEV\d+, cluster index = 0$/m);
    expect(vue).toMatch(/^Slave : FGT-02, FGVMEV\d+, cluster index = 1$/m);
  });

  it('etape 5 : `diagnose sys ha checksum cluster` rend les DEUX membres',
    async () => {
      const { maitre, esclave } = await laboratoire();
      await grappe(maitre, 200);
      await grappe(esclave, 100);
      battre(maitre, esclave);

      const vue = await maitre.executeCommand('diagnose sys ha checksum cluster');
      expect(vue).not.toMatch(/Unknown action|unknown path/i);
      expect(vue).toMatch(/is_manage_master\(\)=1/);
      expect(vue).toMatch(/is_manage_master\(\)=0/);
      const blocs = vue.split('==================').filter(b => b.includes('root:'));
      expect(blocs).toHaveLength(2);
      const empreintes = blocs.map(b => /^root: (\S+)/m.exec(b)?.[1]);
      expect(empreintes[0]).toBeDefined();
      expect(empreintes[0]).toBe(empreintes[1]);
    });

  it('etape 5 : `execute ha synchronize start` resynchronise', async () => {
    const { maitre, esclave } = await laboratoire();
    await grappe(maitre, 200);
    await grappe(esclave, 100);
    battre(maitre, esclave);

    const sortie = await maitre.executeCommand('execute ha synchronize start');
    expect(sortie).not.toMatch(/Unknown action|unknown path|Invalid/i);
  });

  it('etape 6 : la politique du maitre est copiee sur l\'esclave', async () => {
    const { maitre, esclave } = await laboratoire();
    await grappe(maitre, 200);
    await grappe(esclave, 100);
    battre(maitre, esclave);

    await taper(maitre, [
      'config firewall address',
      'edit "SRV-SYNC"', 'set subnet 10.9.9.9 255.255.255.255', 'next', 'end',
    ]);
    battre(maitre, esclave);

    expect(await esclave.executeCommand('show firewall address'))
      .toContain('edit "SRV-SYNC"');
  });

  it('etape 6 : `execute ha manage 1` ouvre la vue de l\'esclave', async () => {
    const { maitre, esclave } = await laboratoire();
    await grappe(maitre, 200);
    await grappe(esclave, 100);
    battre(maitre, esclave);

    const sortie = await maitre.executeCommand('execute ha manage 1 admin');
    expect(sortie).not.toMatch(/Unknown action|unknown path/i);
    expect(sortie).not.toMatch(/no such member|invalid/i);
  });

  it('etape 7 : le trafic du LAN traverse le MAITRE', async () => {
    const { maitre, esclave, lan, dmzMaitre } = await laboratoire();
    await grappe(maitre, 200);
    await grappe(esclave, 100);
    battre(maitre, esclave);

    const avant = dmzMaitre.getStats().framesTransmitted;
    const sortie = await lan.executeCommand('ping -c 2 192.168.20.10');
    expect(sortie).toMatch(/, 0% packet loss/);
    expect(dmzMaitre.getStats().framesTransmitted).toBeGreaterThan(avant);
  });

  it('etape 7 : le SECONDAIRE ne fait passer AUCUN paquet', async () => {
    const { maitre, esclave, lan } = await laboratoire();
    await grappe(maitre, 200);
    await grappe(esclave, 100);
    battre(maitre, esclave);
    expect(esclave.getHa().role()).toBe('slave');

    const avantM = maitre.getPort('port2')!.getCounters().framesOut;
    const avantE = esclave.getPort('port2')!.getCounters().framesOut;
    expect(await lan.executeCommand('ping -c 2 192.168.20.10'))
      .toMatch(/, 0% packet loss/);

    expect(maitre.getPort('port2')!.getCounters().framesOut).toBeGreaterThan(avantM);
    expect(esclave.getPort('port2')!.getCounters().framesOut).toBe(avantE);
  });

  it('etape 7 : le SECONDAIRE ne repond pas non plus a l\'ARP', async () => {
    const { maitre, esclave, lan } = await laboratoire();
    await grappe(maitre, 200);
    await grappe(esclave, 100);
    battre(maitre, esclave);

    await lan.executeCommand('ping -c 1 192.168.10.1');
    const table = await lan.executeCommand('ip neigh');
    const passerelle = table.split('\n').filter(l => l.includes('192.168.10.1'));
    // Une seule entree : le secondaire s'est tu. Ce qu'elle porte est
    // l'adresse VIRTUELLE de la grappe et non l'adresse physique du
    // maitre — `00:09:0f:09:<groupe>:<index>`, la formule de Fortinet —
    // et c'est precisement ce qui rend le basculement invisible au
    // client : le cache ARP reste valable quand l'autre unite prend la
    // main. Ce cas attendait l'adresse physique, donc il decrivait un
    // cluster qui n'existe pas.
    expect(passerelle).toHaveLength(1);
    expect(passerelle[0]).toContain('00:09:0f:09:00:00');
    expect(passerelle[0]).not.toContain(
      maitre.getPort('port1')!.getMAC().toString().toLowerCase());
  });

  it('etape 8 : la panne du maitre fait PASSER l\'esclave primaire', async () => {
    const { maitre, esclave, coeur5, coeur6, lanMaitre, dmzMaitre } = await laboratoire();
    await grappe(maitre, 200);
    await grappe(esclave, 100);
    battre(maitre, esclave);
    expect(maitre.getHa().role()).toBe('master');
    expect(esclave.getHa().role()).toBe('slave');

    coeur5.disconnect(); coeur6.disconnect();
    lanMaitre.disconnect(); dmzMaitre.disconnect();
    for (let tour = 0; tour < 10; tour++) esclave.getHa().tick();

    expect(esclave.getHa().role()).toBe('master');
  });

  it('etape 8 : le trafic REPREND par l\'esclave devenu primaire', async () => {
    const { maitre, esclave, lan, coeur5, coeur6, lanMaitre, dmzMaitre } =
      await laboratoire();
    await grappe(maitre, 200);
    await grappe(esclave, 100);
    battre(maitre, esclave);
    await lan.executeCommand('ping -c 1 192.168.20.10');

    coeur5.disconnect(); coeur6.disconnect();
    lanMaitre.disconnect(); dmzMaitre.disconnect();
    for (let tour = 0; tour < 10; tour++) esclave.getHa().tick();

    expect(await lan.executeCommand('ping -c 2 192.168.20.10'))
      .toMatch(/, 0% packet loss/);
  });

  it('etape 10 : `session-pickup` porte la session sur le secondaire', async () => {
    const { maitre, esclave, lan } = await laboratoire();
    await grappe(maitre, 200);
    await grappe(esclave, 100);
    battre(maitre, esclave);

    await lan.executeCommand('ping -c 1 192.168.20.10');
    battre(maitre, esclave);

    expect(esclave.getSessionTable().view().all().length).toBeGreaterThan(0);
  });

  it('etape 10 : sans `session-pickup`, la session NE traverse PAS', async () => {
    const { maitre, esclave, lan } = await laboratoire();
    await grappe(maitre, 200, 'set session-pickup disable');
    await grappe(esclave, 100, 'set session-pickup disable');
    battre(maitre, esclave);

    await lan.executeCommand('ping -c 1 192.168.20.10');
    battre(maitre, esclave);

    expect(esclave.getSessionTable().view().all().length).toBe(0);
  });

  it('etape 11 : avec `override disable`, le revenant RESTE secondaire',
    async () => {
      const { maitre, esclave, comLan, comDmz, coeur5, coeur6, lanMaitre, dmzMaitre } =
        await laboratoire();
      await grappe(maitre, 200);
      await grappe(esclave, 100);
      battre(maitre, esclave);

      esclave.getHa().advanceUptime(30 * 60 * 1000);
      coeur5.disconnect(); coeur6.disconnect();
      lanMaitre.disconnect(); dmzMaitre.disconnect();
      maitre.getHa().tick();
      for (let tour = 0; tour < 10; tour++) esclave.getHa().tick();
      expect(esclave.getHa().role()).toBe('master');

      coeur5.connect(maitre.getPort('port5')!, esclave.getPort('port5')!);
      coeur6.connect(maitre.getPort('port6')!, esclave.getPort('port6')!);
      lanMaitre.connect(maitre.getPort('port1')!, comLan.getPort('eth0')!);
      dmzMaitre.connect(maitre.getPort('port2')!, comDmz.getPort('eth0')!);
      battre(maitre, esclave, 8);

      expect(esclave.getHa().role()).toBe('master');
      expect(maitre.getHa().role()).toBe('slave');
    });

  it('etape 11 : avec `override enable`, la PRIORITE reprend la main',
    async () => {
      const { maitre, esclave, comLan, comDmz, coeur5, coeur6, lanMaitre, dmzMaitre } =
        await laboratoire();
      await grappe(maitre, 200, 'set override enable');
      await grappe(esclave, 100, 'set override enable');
      battre(maitre, esclave);

      esclave.getHa().advanceUptime(30 * 60 * 1000);
      coeur5.disconnect(); coeur6.disconnect();
      lanMaitre.disconnect(); dmzMaitre.disconnect();
      maitre.getHa().tick();
      for (let tour = 0; tour < 10; tour++) esclave.getHa().tick();
      expect(esclave.getHa().role()).toBe('master');

      coeur5.connect(maitre.getPort('port5')!, esclave.getPort('port5')!);
      coeur6.connect(maitre.getPort('port6')!, esclave.getPort('port6')!);
      lanMaitre.connect(maitre.getPort('port1')!, comLan.getPort('eth0')!);
      dmzMaitre.connect(maitre.getPort('port2')!, comDmz.getPort('eth0')!);
      battre(maitre, esclave, 8);

      expect(maitre.getHa().role()).toBe('master');
      expect(esclave.getHa().role()).toBe('slave');
    });

  it('etape 5 : le certificat d\'USINE ne desynchronise pas la grappe',
    async () => {
      const { maitre, esclave } = await laboratoire();
      await grappe(maitre, 200);
      await grappe(esclave, 100);
      battre(maitre, esclave);

      const usineMaitre = await maitre.executeCommand('show vpn certificate local');
      const usineEsclave = await esclave.executeCommand('show vpn certificate local');
      expect(usineMaitre).not.toBe(usineEsclave);

      expect(await maitre.executeCommand('get system ha status'))
        .toMatch(/in-sync/);
      expect(await maitre.executeCommand('get system ha status'))
        .not.toMatch(/out-of-sync/);
    });

  it('etape 5 : une modification NON propagee desynchronise vraiment',
    async () => {
      const { maitre, esclave, coeur5, coeur6 } = await laboratoire();
      await grappe(maitre, 200);
      await grappe(esclave, 100);
      battre(maitre, esclave);

      coeur5.disconnect(); coeur6.disconnect();
      await taper(maitre, [
        'config firewall address',
        'edit "DESYNC"', 'set subnet 10.0.0.9 255.255.255.255', 'next', 'end',
      ]);
      coeur5.connect(maitre.getPort('port5')!, esclave.getPort('port5')!);
      coeur6.connect(maitre.getPort('port6')!, esclave.getPort('port6')!);

      const vue = await maitre.executeCommand('diagnose sys ha checksum cluster');
      const blocs = vue.split('==================').filter(b => b.includes('root:'));
      const empreintes = blocs.map(b => /^root: (\S+)/m.exec(b)?.[1]);
      expect(empreintes[0]).not.toBe(empreintes[1]);
    });

  it('`diagnose sys ha reset-uptime` remet la duree de fonctionnement a zero',
    async () => {
      const { maitre, esclave } = await laboratoire();
      await grappe(maitre, 200);
      await grappe(esclave, 100);
      battre(maitre, esclave);

      const sortie = await maitre.executeCommand('diagnose sys ha reset-uptime');
      expect(sortie).not.toMatch(/Unknown action|unknown path/i);
    });
});

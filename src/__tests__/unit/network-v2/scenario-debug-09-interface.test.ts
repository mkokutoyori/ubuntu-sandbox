/**
 * Scénario 9 (debug Cisco) — `debug interface` : diagnostiquer les problèmes
 * de lien physique et de signalisation.
 *
 * Transcription littérale : le lien WAN GigabitEthernet0/1 vers le FAI
 * monte et descend toutes les 5 minutes, avec des `input errors` et des
 * `CRC errors` croissants. Activation de `debug interface`, observation du
 * cycle down/up (`went down`, `%LINK-3-UPDOWN`, `keepalive timer expired`,
 * `came back up`, `%LINEPROTO-5-UPDOWN`), analyse des compteurs d'erreurs
 * de `show interfaces`, calcul du taux CRC, diagnostic du duplex mismatch,
 * puis `clear counters` et validation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 9 (debug) — debug interface', () => {
  const LONG = 30_000;
  let rtr: CiscoRouter;
  let fai: LinuxPC;
  let lienWan: Cable;
  let lignes: string[];
  let wan: string;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    rtr = new CiscoRouter('RTR-MANDENG-01');
    fai = new LinuxPC('linux-pc', 'equipement-fai', 0, 0);
    rtr.powerOn();
    fai.powerOn();

    // Gi0/1 = lien WAN vers le FAI (deuxième port du routeur).
    wan = rtr.getPortNames()[1];
    lienWan = new Cable('lien-wan');
    lienWan.connect(rtr.getPort(wan)!, fai.getPort('eth0')!);

    await rtr.executeCommand('enable');
    await rtr.executeCommand('configure terminal');
    await rtr.executeCommand(`interface ${wan}`);
    await rtr.executeCommand('description LIEN-WAN-FAI');
    await rtr.executeCommand('ip address 203.0.113.1 255.255.255.252');
    await rtr.executeCommand('no shutdown');
    await rtr.executeCommand('end');

    fai.configureInterface('eth0', new IPAddress('203.0.113.2'), new SubnetMask('255.255.255.252'));

    lignes = [];
    rtr.getDebugService().subscribe((l: string) => lignes.push(l));
  });

  const run = (cmd: string): Promise<string> => rtr.executeCommand(cmd);

  /** Reproduit un cycle de flap du lien WAN. */
  function flapDuLien(): void {
    lienWan.disconnect();
    lienWan.connect(rtr.getPort(wan)!, fai.getPort('eth0')!);
  }

  describe('activation de debug interface', () => {
    it('gap confirmé : `debug interface <interface>` n\'est pas accepté', async () => {
      const out = await run(`debug interface ${wan}`);
      expect(out).not.toContain('Invalid input');
    });

    it('gap confirmé : `debug interface <interface>` devrait s\'annoncer actif', async () => {
      expect(await run(`debug interface ${wan}`))
        .toMatch(new RegExp(`Interface ${wan} debugging is on`));
    });

    it('gap confirmé : le debug interface devrait apparaître dans `show debugging`', async () => {
      await run(`debug interface ${wan}`);
      expect(await run('show debugging')).toMatch(/Interface .* debugging is on/);
    });
  });

  describe('cycle down/up du lien', () => {
    it('gap confirmé : la chute du lien devrait produire une ligne `went down`', async () => {
      await run(`debug interface ${wan}`);
      lienWan.disconnect();

      expect(lignes.some((l) => new RegExp(`${wan} went down`).test(l))).toBe(true);
    }, LONG);

    it('gap confirmé : le retour du lien devrait produire une ligne `came back up`', async () => {
      await run(`debug interface ${wan}`);
      flapDuLien();

      expect(lignes.some((l) => new RegExp(`${wan} came back up`).test(l))).toBe(true);
    }, LONG);

    it('gap confirmé : un keepalive expiré devrait être tracé', async () => {
      await run('configure terminal');
      await run(`interface ${wan}`);
      await run('keepalive 5');
      await run('end');

      await run(`debug interface ${wan}`);
      lienWan.disconnect();

      expect(lignes.some((l) => /keepalive timer expired/i.test(l))).toBe(true);
    }, LONG);
  });

  describe('messages syslog standard (visibles même sans debug)', () => {
    it('l\'interface change bien d\'état dans `show ip interface brief`', async () => {
      expect(await run('show ip interface brief')).toMatch(new RegExp(`${wan}\\s+203\\.0\\.113\\.1\\s+YES\\s+\\w+\\s+up\\s+up`));

      lienWan.disconnect();
      expect(await run('show ip interface brief')).toMatch(new RegExp(`${wan}\\s+203\\.0\\.113\\.1\\s+YES\\s+\\w+\\s+down`));
    }, LONG);

    it('gap confirmé : la transition de lien devrait journaliser %LINK-3-UPDOWN', async () => {
      flapDuLien();

      const logs = await run('show logging');
      expect(logs).toContain('%LINK-3-UPDOWN');
      expect(logs).toMatch(new RegExp(`Interface ${wan}, changed state to down`));
    }, LONG);

    it('gap confirmé : la remontée du protocole de ligne devrait journaliser %LINEPROTO-5-UPDOWN', async () => {
      flapDuLien();

      const logs = await run('show logging');
      expect(logs).toContain('%LINEPROTO-5-UPDOWN');
      expect(logs).toMatch(new RegExp(`Line protocol on Interface ${wan}, changed state to up`));
    }, LONG);
  });

  describe('compteurs d\'erreurs de show interfaces', () => {
    it('`show interfaces` expose la description, l\'adresse et la bande passante', async () => {
      const out = await run(`show interfaces ${wan}`);
      expect(out).toMatch(new RegExp(`${wan} is up, line protocol is up`));
      expect(out).toMatch(/Internet address is 203\.0\.113\.1/);
      expect(out).toMatch(/MTU 1500 bytes, BW 1000000 Kbit/);
    });

    it('gap confirmé : `show interfaces` devrait rappeler la description configurée', async () => {
      expect(await run(`show interfaces ${wan}`)).toContain('LIEN-WAN-FAI');
    });

    it('`show interfaces` expose les compteurs input errors / CRC / frame', async () => {
      const out = await run(`show interfaces ${wan}`);
      expect(out).toMatch(/input errors/);
      expect(out).toMatch(/CRC/);
      expect(out).toMatch(/frame/);
      expect(out).toMatch(/overrun/);
      expect(out).toMatch(/ignored/);
    });

    it('`show interfaces` expose le compteur `interface resets` (link flaps)', async () => {
      expect(await run(`show interfaces ${wan}`)).toMatch(/interface resets/);
    });

    it('gap confirmé : un câble corrompant les trames devrait incrémenter le compteur CRC', async () => {
      lienWan.setCorruptionRate(1);
      await fai.executeCommand('ping -c 3 -W 1 203.0.113.1');

      const out = await run(`show interfaces ${wan}`);
      const crc = /(\d+)\s+CRC/.exec(out) ?? /,\s*(\d+)\s+CRC/.exec(out);
      expect(crc).not.toBeNull();
      expect(Number(crc![1])).toBeGreaterThan(0);
    }, LONG);

    it('gap confirmé : `show interfaces <if> | include error|CRC` filtre les lignes d\'erreur', async () => {
      const out = await run(`show interfaces ${wan} | include error|CRC`);
      expect(out).toMatch(/CRC/);
      expect(out).not.toMatch(/Encapsulation ARPA/);
    });

    it('gap confirmé : `show interfaces counters errors` n\'est pas accepté', async () => {
      expect(await run('show interfaces counters errors')).not.toContain('Invalid input');
    });
  });

  describe('diagnostic du duplex mismatch', () => {
    it('`show interfaces` expose la vitesse et le duplex négociés', async () => {
      const out = await run(`show interfaces ${wan}`);
      expect(out).toMatch(/Full-duplex, 1000Mbps/);
    });

    it('`duplex full` et `speed 1000` sont acceptés sur le lien WAN', async () => {
      await run('configure terminal');
      await run(`interface ${wan}`);
      const duplex = await run('duplex full');
      const vitesse = await run('speed 1000');
      await run('end');

      expect(duplex).not.toContain('Invalid input');
      expect(vitesse).not.toContain('Invalid input');
    });

    it('gap confirmé : le duplex forcé devrait apparaître dans la configuration courante', async () => {
      await run('configure terminal');
      await run(`interface ${wan}`);
      await run('duplex full');
      await run('speed 1000');
      await run('end');

      const conf = await run('show running-config');
      expect(conf).toMatch(/duplex full/);
      expect(conf).toMatch(/speed 1000/);
    });
  });

  describe('remise à zéro des compteurs et validation', () => {
    it('`clear counters <interface>` est accepté', async () => {
      expect(await run(`clear counters ${wan}`)).not.toContain('Invalid input');
    });

    it('gap confirmé : après `clear counters`, les compteurs de paquets repartent de zéro', async () => {
      await fai.executeCommand('ping -c 3 -W 1 203.0.113.1');
      expect(await run(`show interfaces ${wan}`)).not.toMatch(/\b0 packets input\b/);

      await run(`clear counters ${wan}`);

      const out = await run(`show interfaces ${wan}`);
      expect(out).toMatch(/\b0 packets input\b/);
      expect(out).toMatch(/\b0 packets output\b/);
    }, LONG);

    it('après correction, le lien ne présente plus d\'erreur', async () => {
      await run(`clear counters ${wan}`);
      await fai.executeCommand('ping -c 3 -W 1 203.0.113.1');

      const out = await run(`show interfaces ${wan}`);
      expect(out).toMatch(/0 input errors, 0 CRC, 0 frame/);
    }, LONG);

    it('`undebug all` clôt l\'investigation interface', async () => {
      expect(await run('undebug all')).toContain('All possible debugging has been turned off');
    });
  });
});

/**
 * Scénario 7 (debug Cisco) — `debug crypto isakmp` et `debug crypto ipsec` :
 * diagnostiquer les tunnels VPN.
 *
 * Transcription littérale : le tunnel IPsec entre RTR-MANDENG-01 (siège) et
 * RTR-KRIBI-01 (agence de Kribi) ne monte pas, `show crypto isakmp sa`
 * affiche MM_NO_STATE. Activation progressive des debugs (isakmp puis
 * ipsec), identification du mismatch de politique Phase 1
 * (`atts are NOT acceptable`, `no offers accepted!`), vérification de la
 * PSK, trace Phase 2 (`IPSEC(sa_request)`, `sa_spi`, `sa_proto= 50`),
 * puis correction de la politique ISAKMP et validation (QM_IDLE ACTIVE,
 * `#pkts encaps`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 7 (debug) — debug crypto isakmp / debug crypto ipsec', () => {
  const LONG = 30_000;
  let siege: CiscoRouter;
  let kribi: CiscoRouter;
  let pcSiege: LinuxPC;
  let pcKribi: LinuxPC;
  let lignes: string[];
  let wanSiege: string;
  let lanSiege: string;
  let wanKribi: string;
  let lanKribi: string;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    siege = new CiscoRouter('RTR-MANDENG-01');
    kribi = new CiscoRouter('RTR-KRIBI-01');
    pcSiege = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
    pcKribi = new LinuxPC('linux-pc', 'pc-kribi-1', 0, 0);
    siege.powerOn();
    kribi.powerOn();
    pcSiege.powerOn();
    pcKribi.powerOn();

    [wanSiege, lanSiege] = siege.getPortNames();
    [wanKribi, lanKribi] = kribi.getPortNames();

    new Cable('wan').connect(siege.getPort(wanSiege)!, kribi.getPort(wanKribi)!);
    new Cable('lan-siege').connect(siege.getPort(lanSiege)!, pcSiege.getPort('eth0')!);
    new Cable('lan-kribi').connect(kribi.getPort(lanKribi)!, pcKribi.getPort('eth0')!);

    pcSiege.configureInterface('eth0', new IPAddress('192.168.10.101'), new SubnetMask('255.255.255.0'));
    pcKribi.configureInterface('eth0', new IPAddress('192.168.30.101'), new SubnetMask('255.255.255.0'));
    await pcSiege.executeCommand('sudo ip route add default via 192.168.10.254');
    await pcKribi.executeCommand('sudo ip route add default via 192.168.30.254');

    // Le siège : AES-256 / SHA256 / groupe 14 (politique « stricte »).
    await configurerVpn(siege, wanSiege, lanSiege, '203.0.113.1', '192.168.10.254',
      '203.0.113.100', '192.168.10.0', '192.168.30.0', 'aes 256', 'sha256', '14');
    // Kribi : AES-128 / SHA1 / groupe 2 → incompatible sur 3 paramètres.
    await configurerVpn(kribi, wanKribi, lanKribi, '203.0.113.100', '192.168.30.254',
      '203.0.113.1', '192.168.30.0', '192.168.10.0', 'aes 128', 'sha', '2');

    lignes = [];
    siege.getDebugService().subscribe((l: string) => lignes.push(l));
  });

  async function configurerVpn(
    r: CiscoRouter, wan: string, lan: string, wanIp: string, lanIp: string,
    peer: string, reseauLocal: string, reseauDistant: string,
    chiffrement: string, hachage: string, groupe: string,
  ): Promise<void> {
    const commandes = [
      'enable', 'configure terminal',
      `interface ${wan}`, `ip address ${wanIp} 255.255.255.0`, 'no shutdown', 'exit',
      `interface ${lan}`, `ip address ${lanIp} 255.255.255.0`, 'no shutdown', 'exit',
      'crypto isakmp policy 10',
      `encryption ${chiffrement}`, `hash ${hachage}`, 'authentication pre-share',
      `group ${groupe}`, 'lifetime 86400', 'exit',
      `crypto isakmp key Mandeng2025 address ${peer}`,
      'crypto ipsec transform-set TS-MANDENG esp-aes 256 esp-sha256-hmac', 'exit',
      'ip access-list extended VPN-TRAFFIC',
      `permit ip ${reseauLocal} 0.0.0.255 ${reseauDistant} 0.0.0.255`, 'exit',
      'crypto map CMAP-VPN 10 ipsec-isakmp',
      `set peer ${peer}`, 'set transform-set TS-MANDENG', 'match address VPN-TRAFFIC', 'exit',
      `interface ${wan}`, 'crypto map CMAP-VPN', 'exit',
      `ip route ${reseauDistant} 255.255.255.0 ${peer}`, 'end',
    ];
    for (const c of commandes) await r.executeCommand(c);
  }

  const run = (cmd: string): Promise<string> => siege.executeCommand(cmd);

  /** Aligne la politique de Kribi sur celle du siège (résolution du scénario). */
  async function corrigerPolitiqueKribi(): Promise<void> {
    for (const c of ['configure terminal', 'crypto isakmp policy 20',
      'encryption aes 256', 'hash sha256', 'authentication pre-share',
      'group 14', 'exit', 'end']) {
      await kribi.executeCommand(c);
    }
  }

  /** Génère du trafic « intéressant » censé déclencher la montée du tunnel. */
  const traficInteressant = (): Promise<string> =>
    pcSiege.executeCommand('ping -c 2 -W 1 192.168.30.101');

  describe('activation progressive des debugs VPN', () => {
    it('`debug crypto isakmp` s\'active', async () => {
      expect(await run('debug crypto isakmp')).toContain('Crypto ISAKMP debugging is on');
    });

    it('`debug crypto ipsec` s\'active', async () => {
      expect(await run('debug crypto ipsec')).toContain('Crypto IPSEC debugging is on');
    });

    it('`debug crypto isakmp detail` est accepté', async () => {
      expect(await run('debug crypto isakmp detail')).not.toContain('Invalid input');
    });

    it('les debugs crypto devraient apparaître dans `show debugging`', async () => {
      await run('debug crypto isakmp');
      await run('debug crypto ipsec');
      expect(await run('show debugging')).toMatch(/Crypto (ISAKMP|IPSEC) debugging is on/);
    });
  });

  describe('état initial — aucune SA établie (MM_NO_STATE)', () => {
    it('`show crypto isakmp sa` expose l\'en-tête IOS et l\'absence de SA', async () => {
      const out = await run('show crypto isakmp sa');
      expect(out).toMatch(/dst\s+src\s+state\s+conn-id\s+status/);
      expect(out).toMatch(/no IKEv1 SAs|MM_NO_STATE/);
    });

    it('`show crypto ipsec sa` ne montre aucune SA IPsec', async () => {
      expect(await run('show crypto ipsec sa')).toMatch(/No IPSec SAs/i);
    });
  });

  describe('politique ISAKMP configurée et comparable', () => {
    it('`show crypto isakmp policy` expose chiffrement, hash, auth, groupe DH et lifetime', async () => {
      const out = await run('show crypto isakmp policy');
      expect(out).toMatch(/priority 10/);
      expect(out).toMatch(/encryption algorithm:\s+AES/i);
      expect(out).toMatch(/hash algorithm:\s+Secure Hash Standard 2/i);
      expect(out).toMatch(/authentication method:\s+Pre-Shared Key/i);
      expect(out).toMatch(/Diffie-Hellman group:\s+#14/);
      expect(out).toMatch(/lifetime:\s+86400 seconds/);
    });

    it('la PSK configurée est vérifiable dans la configuration courante', async () => {
      const out = await run('show running-config | include crypto isakmp key');
      expect(out).toContain('Mandeng2025');
      expect(out).toContain('203.0.113.100');
    });
  });

  describe('mismatch de politique Phase 1', () => {
    it('`debug crypto isakmp` devrait tracer la vérification des transformes', async () => {
      await run('debug crypto isakmp');
      await traficInteressant();

      expect(lignes.some((l) => /Checking ISAKMP transform 1 against priority 10 policy/i.test(l))).toBe(true);
    }, LONG);

    it('le mismatch devrait produire `atts are NOT acceptable`', async () => {
      await run('debug crypto isakmp');
      await traficInteressant();

      expect(lignes.some((l) => /atts are NOT acceptable/i.test(l))).toBe(true);
    }, LONG);

    it('le mismatch devrait produire `no offers accepted!` et `phase 1 SA policy not acceptable!`', async () => {
      await run('debug crypto isakmp');
      await traficInteressant();

      expect(lignes.some((l) => /no offers accepted!/i.test(l))).toBe(true);
      expect(lignes.some((l) => /phase 1 SA policy not acceptable!/i.test(l))).toBe(true);
    }, LONG);

    it('le debug détaille les attributs proposés par le voisin', async () => {
      await run('debug crypto isakmp');
      // Le siège n'inspecte la proposition du voisin que lorsqu'il est
      // répondeur : c'est Kribi qui initie, avec sa politique AES-128 / groupe 2.
      await pcKribi.executeCommand('ping -c 2 -W 1 192.168.10.101');

      expect(lignes.some((l) => /encryption AES-CBC/i.test(l))).toBe(true);
      expect(lignes.some((l) => /keylength of 128/i.test(l))).toBe(true);
      expect(lignes.some((l) => /auth pre-share/i.test(l))).toBe(true);
      expect(lignes.some((l) => /default group 2/i.test(l))).toBe(true);
    }, LONG);
  });

  describe('progression des états IKE', () => {
    it('la Phase 1 devrait progresser MM_NO_STATE → MM_SA_SETUP → MM_KEY_EXCH → QM_IDLE', async () => {
      await run('debug crypto isakmp');
      await corrigerPolitiqueKribi();
      await run('clear crypto isakmp sa');
      await traficInteressant();

      const trace = lignes.join('\n');
      expect(trace).toMatch(/MM_SA_SETUP/);
      expect(trace).toMatch(/MM_KEY_EXCH/);
      expect(trace).toMatch(/QM_IDLE/);
    }, LONG);

    it('le debug devrait tracer les payloads KE et NONCE puis `SKEYID state generated`', async () => {
      await run('debug crypto isakmp');
      await corrigerPolitiqueKribi();
      await run('clear crypto isakmp sa');
      await traficInteressant();

      expect(lignes.some((l) => /processing KE payload/i.test(l))).toBe(true);
      expect(lignes.some((l) => /processing NONCE payload/i.test(l))).toBe(true);
      expect(lignes.some((l) => /SKEYID state generated/i.test(l))).toBe(true);
    }, LONG);
  });

  describe('Phase 2 — debug crypto ipsec', () => {
    it('`debug crypto ipsec` devrait tracer `IPSEC(sa_request)` avec les proxies local/distant', async () => {
      await run('debug crypto ipsec');
      await corrigerPolitiqueKribi();
      await traficInteressant();

      expect(lignes.some((l) => /IPSEC\(sa_request\)/i.test(l))).toBe(true);
      expect(lignes.some((l) => /local_proxy=\s*192\.168\.10\.0/.test(l))).toBe(true);
      expect(lignes.some((l) => /remote_proxy=\s*192\.168\.30\.0/.test(l))).toBe(true);
    }, LONG);

    it('la création de SA devrait exposer sa_spi, sa_proto= 50 (ESP) et sa_trans', async () => {
      await run('debug crypto ipsec');
      await corrigerPolitiqueKribi();
      await traficInteressant();

      expect(lignes.some((l) => /IPSEC\(create_sa\): sa created/i.test(l))).toBe(true);
      expect(lignes.some((l) => /sa_spi=\s*0x[0-9a-f]+/i.test(l))).toBe(true);
      expect(lignes.some((l) => /sa_proto=\s*50/.test(l))).toBe(true);
      expect(lignes.some((l) => /sa_trans=\s*esp-aes 256 esp-sha256-hmac/i.test(l))).toBe(true);
    }, LONG);
  });

  describe('résolution du mismatch et validation', () => {
    it('une seconde politique ISAKMP compatible est acceptée', async () => {
      await run('configure terminal');
      await run('crypto isakmp policy 20');
      await run('encryption aes 128');
      await run('hash sha');
      await run('authentication pre-share');
      const out = await run('group 2');
      await run('exit');
      await run('end');

      expect(out).not.toContain('Invalid input');
      expect(await run('show crypto isakmp policy')).toMatch(/priority 20/);
    });

    it('`clear crypto isakmp sa` et `clear crypto sa` forcent la renégociation', async () => {
      expect(await run('clear crypto isakmp sa')).not.toContain('Invalid input');
      expect(await run('clear crypto sa')).not.toContain('Invalid input');
    });

    it('après correction, `show crypto isakmp sa` devrait afficher QM_IDLE ACTIVE', async () => {
      await corrigerPolitiqueKribi();
      await run('clear crypto isakmp sa');
      await traficInteressant();

      const out = await run('show crypto isakmp sa');
      expect(out).toContain('203.0.113.100');
      expect(out).toMatch(/QM_IDLE/);
      expect(out).toMatch(/ACTIVE/);
    }, LONG);

    it('après correction, `show crypto ipsec sa` devrait compter les paquets chiffrés', async () => {
      await corrigerPolitiqueKribi();
      await run('clear crypto isakmp sa');
      await traficInteressant();

      const out = await run('show crypto ipsec sa');
      expect(out).toMatch(/#pkts encaps:\s*[1-9]/);
      expect(out).toMatch(/#pkts encrypt:\s*[1-9]/);
    }, LONG);

    it('la montée du tunnel devrait journaliser %CRYPTO-5-SESSION_STATUS', async () => {
      await corrigerPolitiqueKribi();
      await run('clear crypto isakmp sa');
      await traficInteressant();

      const logs = await run('show logging');
      expect(logs).toContain('%CRYPTO-5-SESSION_STATUS');
      expect(logs).toMatch(/Crypto tunnel is UP/i);
    }, LONG);

    it('`undebug all` clôt l\'investigation', async () => {
      await run('debug crypto isakmp');
      await run('debug crypto ipsec');
      expect(await run('undebug all')).toContain('All possible debugging has been turned off');
    });
  });
});

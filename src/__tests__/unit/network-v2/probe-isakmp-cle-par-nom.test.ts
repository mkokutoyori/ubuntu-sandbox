/**
 * Sonde — `crypto isakmp key KEY hostname NOM` (audit 13 §4.4).
 *
 * La commande était refusée. Tout ce qu'il lui fallait existait déjà :
 * un pair configuré `crypto isakmp identity hostname` annonce son nom
 * dans l'offre IKE, et le répondeur cherche la clé par cette identité
 * AVANT l'adresse source. Il ne manquait que la commande qui pose une
 * clé sous un nom.
 *
 * **Écrire la commande ne suffisait pas, et c'est l'essentiel de ce
 * qu'a appris la mesure.** Le tunnel refusait de monter alors que les
 * deux routeurs étaient correctement configurés, et deux défauts
 * distincts se cachaient derrière :
 *
 *  1. **La casse.** La table `ip host` de l'équipement range les noms en
 *     minuscules (elle a raison : RFC 4343). Une clé posée sous `rB` ne
 *     se retrouvait donc pas depuis un `ip host rB 10.0.12.2` rangé en
 *     `rb`.
 *  2. **Un point d'appel oublié.** La clé est cherchée à TROIS endroits
 *     — quand l'initiateur émet, quand le répondeur reçoit, et quand
 *     l'initiateur VÉRIFIE la réponse. Ce dernier ne connaissait que
 *     l'adresse, si bien que l'initiateur rejetait sa propre session
 *     pour « PSK mismatch » après avoir pourtant trouvé la clé à
 *     l'émission.
 *
 * Le premier banc d'essai écrit ici ne DISCRIMINAIT rien : clés
 * concordantes et discordantes échouaient pareil. C'est la référence par
 * adresse, montée dans le MÊME banc, qui a montré que le lab était bon
 * et la fonctionnalité cassée — d'où sa présence permanente ci-dessous.
 *
 * Défaut voisin corrigé au passage : `no crypto isakmp key … hostname
 * NOM` retirait l'entrée joker `0.0.0.0` au lieu de la bonne, parce que
 * son analyseur ne cherchait que le mot `address`. La clé nommée
 * survivait à son propre `no`, et une clé joker configurée disparaissait
 * à sa place.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Cable } from '@/network/hardware/Cable';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function configurer(
  r: CiscoRouter, dehors: string, dedans: string, pair: string,
  lanSrc: string, lanDst: string, cleCmd: string, nomPair: string, ipPair: string,
): Promise<string> {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('interface GigabitEthernet0/1');
  await r.executeCommand(`ip address ${dehors} 255.255.255.252`);
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand(`ip address ${dedans} 255.255.255.0`);
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  await r.executeCommand(`ip host ${nomPair} ${ipPair}`);
  await r.executeCommand('crypto isakmp identity hostname');
  await r.executeCommand('crypto isakmp policy 10');
  await r.executeCommand('encryption aes 256');
  await r.executeCommand('hash sha256');
  await r.executeCommand('authentication pre-share');
  await r.executeCommand('group 14');
  await r.executeCommand('exit');
  const retour = await r.executeCommand(cleCmd);
  await r.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
  await r.executeCommand('mode tunnel');
  await r.executeCommand('exit');
  await r.executeCommand('ip access-list extended VPN_ACL');
  await r.executeCommand(`permit ip ${lanSrc} 0.0.0.255 ${lanDst} 0.0.0.255`);
  await r.executeCommand('exit');
  await r.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await r.executeCommand(`set peer ${pair}`);
  await r.executeCommand('set transform-set TSET');
  await r.executeCommand('match address VPN_ACL');
  await r.executeCommand('exit');
  await r.executeCommand('interface GigabitEthernet0/1');
  await r.executeCommand('crypto map CMAP');
  await r.executeCommand('exit');
  await r.executeCommand(`ip route ${lanDst} 255.255.255.0 ${pair}`);
  await r.executeCommand('end');
  return retour;
}

async function lab(cleA: string, cleB: string) {
  const a = new CiscoRouter('rA');
  const b = new CiscoRouter('rB');
  const pa = new LinuxPC('linux-pc', 'PCA'); pa.powerOn();
  const pb = new LinuxPC('linux-pc', 'PCB'); pb.powerOn();
  new Cable('ab').connect(a.getPort('GigabitEthernet0/1')!, b.getPort('GigabitEthernet0/1')!);
  new Cable('pa').connect(pa.getPort('eth0')!, a.getPort('GigabitEthernet0/0')!);
  new Cable('pb').connect(pb.getPort('eth0')!, b.getPort('GigabitEthernet0/0')!);
  const retA = await configurer(a, '10.0.12.1', '192.168.1.1', '10.0.12.2',
    '192.168.1.0', '192.168.2.0', cleA, 'rB', '10.0.12.2');
  await configurer(b, '10.0.12.2', '192.168.2.1', '10.0.12.1',
    '192.168.2.0', '192.168.1.0', cleB, 'rA', '10.0.12.1');
  await pa.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pa.executeCommand('sudo ip route add default via 192.168.1.1');
  await pb.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pb.executeCommand('sudo ip route add default via 192.168.2.1');
  return { a, b, pa, retA };
}

describe('clé ISAKMP par nom d\'hôte — le tunnel monte pour de vrai', () => {
  it('référence : la forme par adresse monte dans ce banc', async () => {
    // Sans cette référence, un banc mal monté et une fonctionnalité
    // cassée sont indiscernables — c'est l'erreur qu'a évitée la mesure.
    const t = await lab('crypto isakmp key SECRET123 address 10.0.12.2',
                        'crypto isakmp key SECRET123 address 10.0.12.1');
    expect(await t.pa.executeCommand('ping -c 2 -W 2 192.168.2.10')).toContain(', 0% packet loss');
    expect(await t.a.executeCommand('show crypto isakmp sa')).toContain('QM_IDLE');
  }, 40000);

  it('des clés concordantes posées PAR NOM montent le tunnel', async () => {
    const t = await lab('crypto isakmp key SECRET123 hostname rB',
                        'crypto isakmp key SECRET123 hostname rA');
    expect(t.retA).toBe('');
    // Du trafic réel traverse le tunnel : c'est ce qui distingue une
    // clé qui authentifie d'une clé qui est seulement mémorisée.
    expect(await t.pa.executeCommand('ping -c 2 -W 2 192.168.2.10')).toContain(', 0% packet loss');
    expect(await t.a.executeCommand('show crypto isakmp sa')).toContain('QM_IDLE');
  }, 40000);

  it('des clés discordantes par nom échouent à l\'authentification', async () => {
    const t = await lab('crypto isakmp key BONNE hostname rB',
                        'crypto isakmp key AUTRE hostname rA');
    expect(await t.pa.executeCommand('ping -c 2 -W 2 192.168.2.10')).toContain(', 100% packet loss');
    expect(await t.a.executeCommand('show crypto isakmp sa')).toContain('MM_NO_STATE');
  }, 40000);

  it('la casse du nom n\'a pas d\'importance (RFC 4343)', async () => {
    const t = await lab('crypto isakmp key SECRET123 hostname RB',
                        'crypto isakmp key SECRET123 hostname Ra');
    expect(await t.pa.executeCommand('ping -c 2 -W 2 192.168.2.10')).toContain(', 0% packet loss');
  }, 40000);
});

describe('clé ISAKMP par nom d\'hôte — configuration', () => {
  async function routeur(): Promise<CiscoRouter> {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    return r;
  }

  it('la commande revient dans la running-config sous SA forme', async () => {
    const r = await routeur();
    await r.executeCommand('crypto isakmp key SECRET hostname peer.lab.local');
    await r.executeCommand('crypto isakmp key AUTRE address 10.9.9.9');
    await r.executeCommand('end');
    const rc = (await r.executeCommand('show running-config')).split('\n').map((x) => x.trim());
    // Rendre une clé nommée en `address peer.lab.local` donnerait une
    // ligne invalide, rejetée à la relecture d'une topologie.
    expect(rc).toContain('crypto isakmp key SECRET hostname peer.lab.local');
    expect(rc).toContain('crypto isakmp key AUTRE address 10.9.9.9');
  });

  it('`show crypto isakmp key` liste les deux formes', async () => {
    const r = await routeur();
    await r.executeCommand('crypto isakmp key SECRET hostname peer.lab.local');
    await r.executeCommand('crypto isakmp key AUTRE address 10.9.9.9');
    await r.executeCommand('end');
    const out = await r.executeCommand('show crypto isakmp key');
    expect(out).toContain('peer.lab.local');
    expect(out).toContain('10.9.9.9');
  });

  it('une adresse derrière `hostname` est refusée', async () => {
    const r = await routeur();
    // Sans ce refus, une faute de frappe serait rangée comme une
    // identité que personne n'annoncera jamais.
    expect(await r.executeCommand('crypto isakmp key K hostname 10.0.0.1'))
      .toContain('Invalid input');
  });

  it('les formes tronquées sont refusées', async () => {
    const r = await routeur();
    expect(await r.executeCommand('crypto isakmp key K hostname')).toBe('% Incomplete command.');
    expect(await r.executeCommand('crypto isakmp key K')).toContain('Incomplete command');
  });

  it('`no ... hostname NOM` retire la BONNE clé', async () => {
    const r = await routeur();
    await r.executeCommand('crypto isakmp key JOKER address 0.0.0.0');
    await r.executeCommand('crypto isakmp key SECRET hostname peer.lab.local');
    expect(await r.executeCommand('no crypto isakmp key SECRET hostname peer.lab.local')).toBe('');
    await r.executeCommand('end');
    const out = await r.executeCommand('show crypto isakmp key');
    // Le défaut d'origine : c'est le joker qui partait, et la clé
    // nommée survivait à son propre `no`.
    expect(out).not.toContain('peer.lab.local');
    expect(out).toContain('0.0.0.0');
  });
});

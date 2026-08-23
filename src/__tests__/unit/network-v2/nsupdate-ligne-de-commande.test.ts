/**
 * `nsupdate` — la porte que le moteur RFC 2136 attendait.
 *
 * Le moteur et TSIG existaient et seul le client DHCP Windows s'en
 * servait ; aucun operateur ne pouvait composer une mise a jour. Le
 * script est celui du vrai binaire de BIND (`server`, `zone`, `prereq`,
 * `update add|delete`, `send`), lu sur l'entree standard ou dans un
 * fichier, et `-y` porte la cle TSIG.
 *
 * Le laboratoire fait traverser le fil a chaque message : le poste et le
 * serveur sont deux machines cablees a un commutateur, et la
 * verification passe par une VRAIE requete plutot que par la zone en
 * memoire, sans quoi elle ne prouverait pas que le serveur a repondu.
 *
 * Discrimine en retirant l'enregistrement de la commande
 * (`commands/index.ts`) : 9 des 11 cas tombent. Les 2 qui passent des
 * deux cotes sont nommes ici — le TEMOIN, dont c'est l'objet, et le cas
 * du binaire supprime, qui passe avant correctif pour la mauvaise
 * raison (la commande n'existait pas non plus).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Zone } from '@/network/dns/zone/Zone';
import { makeARecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { PrimaryZoneAgent } from '@/network/dns/transfer/PrimaryZoneAgent';
import { TsigAlgorithm } from '@/network/dns/tsig/Tsig';
import type { UpdateSecurityPolicy } from '@/network/dns/update/UpdateResponder';

const ORIGIN = 'example.com';
const SERVEUR = '10.0.0.1';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

function labo(updatePolicy: UpdateSecurityPolicy = 'none') {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const hote = new LinuxServer('linux-server', 'ns1', 0, 0);
  const poste = new LinuxPC('linux-pc', 'poste', 0, 0);
  const masque = new SubnetMask('255.255.255.0');
  [hote, poste].forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));
  hote.getPorts()[0].configureIP(new IPAddress(SERVEUR), masque);
  poste.getPorts()[0].configureIP(new IPAddress('10.0.0.100'), masque);

  const zone = new Zone(ORIGIN, makeSoaRecord(ORIGIN, 3600, {
    mname: `ns1.${ORIGIN}`, rname: `hostmaster.${ORIGIN}`,
    serial: 2026070100, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeARecord(`www.${ORIGIN}`, 3600, '192.0.2.10'));
  const serveur = new PrimaryZoneAgent(hote, zone, { updatePolicy });
  serveur.start();
  return { poste, serveur };
}

const script = (lignes: readonly string[]) => `${lignes.join('\n')}\n`;

const AJOUT = script([
  `server ${SERVEUR}`,
  `zone ${ORIGIN}`,
  `update add poste.${ORIGIN} 300 A 10.0.0.100`,
  'send',
]);

async function taper(poste: LinuxPC, ligne: string): Promise<string> {
  return poste.executeCommand(ligne);
}

const resoudre = (poste: LinuxPC, nom: string) =>
  taper(poste, `dig +short @${SERVEUR} ${nom} A`);

describe('nsupdate compose une mise a jour et la fait partir', () => {
  it('TEMOIN — le nom n existe pas avant', async () => {
    const { poste } = labo();
    expect(await resoudre(poste, `poste.${ORIGIN}`)).not.toContain('10.0.0.100');
  });

  it('un script lu sur l entree standard ajoute le nom', async () => {
    const { poste } = labo();
    const sortie = await taper(poste, `printf '${AJOUT}' | nsupdate`);
    expect(sortie.trim()).toBe('');
    expect(await resoudre(poste, `poste.${ORIGIN}`)).toContain('10.0.0.100');
  });

  it('le meme script lu dans un FICHIER fait la meme chose', async () => {
    const { poste } = labo();
    await taper(poste, `printf '${AJOUT}' > /tmp/maj.txt`);
    await taper(poste, 'nsupdate /tmp/maj.txt');
    expect(await resoudre(poste, `poste.${ORIGIN}`)).toContain('10.0.0.100');
  });

  it('`update delete` retire la famille', async () => {
    const { poste } = labo();
    expect(await resoudre(poste, `www.${ORIGIN}`)).toContain('192.0.2.10');

    await taper(poste, `printf '${script([
      `server ${SERVEUR}`, `zone ${ORIGIN}`, `update delete www.${ORIGIN} A`, 'send',
    ])}' | nsupdate`);

    expect(await resoudre(poste, `www.${ORIGIN}`)).not.toContain('192.0.2.10');
  });

  it('un prerequis non satisfait fait ECHOUER, en nommant le code', async () => {
    const { poste } = labo();
    const sortie = await taper(poste, `printf '${script([
      `server ${SERVEUR}`, `zone ${ORIGIN}`,
      `prereq nxdomain www.${ORIGIN}`,
      `update add www.${ORIGIN} 300 A 10.0.0.77`, 'send',
    ])}' | nsupdate`);

    expect(sortie).toContain('YXDOMAIN');
    expect(await resoudre(poste, `www.${ORIGIN}`)).toContain('192.0.2.10');
  });

  it('un fichier absent est nomme, pas ignore', async () => {
    const { poste } = labo();
    expect(await taper(poste, 'nsupdate /tmp/rien.txt')).toContain("can't open");
  });

  it('sans `server`, la commande refuse au lieu de deviner', async () => {
    const { poste } = labo();
    const sortie = await taper(poste, `printf '${script([
      `zone ${ORIGIN}`, `update add poste.${ORIGIN} 300 A 10.0.0.100`, 'send',
    ])}' | nsupdate`);
    expect(sortie).toContain('no server given');
  });
});

describe('nsupdate signe quand on lui donne une cle', () => {
  it('une zone securisee REFUSE le script non signe', async () => {
    const { poste } = labo('secure');
    const sortie = await taper(poste, `printf '${AJOUT}' | nsupdate`);
    expect(sortie).toContain('NOTAUTH');
    expect(await resoudre(poste, `poste.${ORIGIN}`)).not.toContain('10.0.0.100');
  });

  it('avec -y et la bonne cle, elle accepte', async () => {
    const { poste, serveur } = labo('secure');
    serveur.getTsigKeyring().add({
      name: 'cle-labo', algorithm: TsigAlgorithm.HMAC_SHA256, secret: 'secret-partage',
    });

    const sortie = await taper(
      poste, `printf '${AJOUT}' | nsupdate -y hmac-sha256:cle-labo:secret-partage`);

    expect(sortie.trim()).toBe('');
    expect(await resoudre(poste, `poste.${ORIGIN}`)).toContain('10.0.0.100');
  });

  it('avec -y et le MAUVAIS secret, elle est refusee', async () => {
    const { poste, serveur } = labo('secure');
    serveur.getTsigKeyring().add({
      name: 'cle-labo', algorithm: TsigAlgorithm.HMAC_SHA256, secret: 'secret-partage',
    });

    const sortie = await taper(
      poste, `printf '${AJOUT}' | nsupdate -y hmac-sha256:cle-labo:pas-le-bon`);

    expect(sortie).toContain('NOTAUTH');
    expect(await resoudre(poste, `poste.${ORIGIN}`)).not.toContain('10.0.0.100');
  });

  it('supprimer le binaire fait echouer la commande, comme sur une vraie machine', async () => {
    const { poste } = labo();
    await taper(poste, 'sudo rm /usr/bin/nsupdate');
    expect(await taper(poste, `printf '${AJOUT}' | nsupdate`))
      .toContain('No such file or directory');
  });
});

/**
 * Une regle de pare-feu Windows a une direction, une action et un
 * protocole — ou elle n'est pas creee.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 *
 *   netsh advfirewall firewall add rule name=<nom> dir=in|out
 *         action=allow|block|bypass
 *         [protocol=0-255|icmpv4|icmpv6|tcp|udp|any]
 *         [localport=0-65535|any] [remoteport=0-65535|any]
 *         [profile=public|private|domain|any] [enable=yes|no]
 *
 *   netsh interface portproxy add v4tov4
 *         listenport=<port> connectport=<port>
 *         connectaddress=<adresse> [listenaddress=<adresse>]
 *
 * Mesure de depart sur un poste Windows :
 *
 *   … dir=zorglub action=allow          -> ACCEPTE, repond « Ok. », et
 *                                          `show rule` annonce
 *                                          « Direction: in »
 *   … dir=in action=zorglub             -> ACCEPTE, repond « Ok. »
 *   … dir=in action=allow protocol=zorglub  -> ACCEPTE, « Ok. »
 *   … dir=in action=allow localport=zorglub -> ACCEPTE, « Ok. »
 *   portproxy … connectaddress=zorglub  -> ACCEPTE, MUET
 *
 * « Ok. » est la reponse que netsh donne quand la regle EST creee : la
 * machine confirme donc une regle dont la direction n'existe pas. Et
 * comme pour `-m zorglub` cote iptables, le danger n'est pas
 * l'affichage — une regle dont l'action n'est ni `allow` ni `block` ne
 * peut ni autoriser ni bloquer, donc elle ne protege rien tout en
 * paraissant dans la liste des regles comme si elle protegeait.
 *
 * PIRE ENCORE, ET C'EST LA MESURE QUI L'A DIT : la direction inventee
 * n'est meme pas RANGEE telle quelle, elle est SILENCIEUSEMENT REMPLACEE
 * par le defaut — `show rule` annonce « Direction: in » apres un
 * `dir=zorglub`. L'operateur lit donc une regle entrante qu'il n'a pas
 * ecrite, sans qu'aucun message ne l'avertisse ; c'est la meme forme que
 * `snmp-server user u g zorglub` revenant `v1`, fermee plus tot dans
 * cette session.
 *
 * La direction et l'action sont les deux seuls champs OBLIGATOIRES de
 * cette commande avec le nom : ce sont eux qui font une regle.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS, mesure plutot que
 * suppose : que `name=zorglub` soit refuse. Un nom de regle est libre,
 * c'est meme la cle par laquelle on la supprime ensuite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Dev = { executeCommand(c: string): Promise<string> };

const poste = (n: string) => new WindowsPC(n) as unknown as Dev;
const run = (d: Dev, c: string) => d.executeCommand(c).then(String);

const AJOUT = 'netsh advfirewall firewall add rule name=R';
const cle = (s: string) => s.replace(/\W/g, '');

describe('une direction de regle est `in` ou `out`', () => {
  it.each(['zorglub', 'inbound', 'both'])('`dir=%s` est refuse', async (v) => {
    const d = poste(`D${cle(v)}`);
    expect(await run(d, `${AJOUT} dir=${v} action=allow`)).not.toContain('Ok.');
  });

  it('et la direction inventee n est pas REMPLACEE par `in`', async () => {
    const d = poste('DR');
    await run(d, `${AJOUT} dir=zorglub action=allow`);
    expect(await run(d, 'netsh advfirewall firewall show rule name=R'))
      .not.toContain('Direction:');
  });

  it.each(['in', 'out'])('`dir=%s` reste accepte', async (v) => {
    const d = poste(`DO${v}`);
    expect(await run(d, `${AJOUT} dir=${v} action=allow`)).toContain('Ok.');
  });
});

describe('une action de regle est `allow`, `block` ou `bypass`', () => {
  it.each(['zorglub', 'deny', 'permit'])('`action=%s` est refuse', async (v) => {
    const d = poste(`A${cle(v)}`);
    expect(await run(d, `${AJOUT} dir=in action=${v}`)).not.toContain('Ok.');
  });

  it.each(['allow', 'block'])('`action=%s` reste accepte', async (v) => {
    const d = poste(`AO${v}`);
    expect(await run(d, `${AJOUT} dir=in action=${v}`)).toContain('Ok.');
  });
});

describe('un protocole et un port de regle sont ceux du protocole', () => {
  it.each(['zorglub', '256'])('`protocol=%s` est refuse', async (v) => {
    const d = poste(`P${cle(v)}`);
    expect(await run(d, `${AJOUT} dir=in action=allow protocol=${v}`)).not.toContain('Ok.');
  });

  it.each(['TCP', 'UDP', 'any', 'icmpv4', '47'])(
    '`protocol=%s` reste accepte', async (v) => {
      const d = poste(`PO${cle(v)}`);
      expect(await run(d, `${AJOUT} dir=in action=allow protocol=${v}`)).toContain('Ok.');
    });

  it.each(['zorglub', '99999'])('`localport=%s` est refuse', async (v) => {
    const d = poste(`L${cle(v)}`);
    expect(await run(d, `${AJOUT} dir=in action=allow protocol=TCP localport=${v}`))
      .not.toContain('Ok.');
  });

  it.each(['80', 'any', '80,443', '1000-2000'])(
    '`localport=%s` reste accepte', async (v) => {
      const d = poste(`LO${cle(v)}`);
      expect(await run(d, `${AJOUT} dir=in action=allow protocol=TCP localport=${v}`))
        .toContain('Ok.');
    });
});

describe('une adresse de redirection de port est une adresse', () => {
  const PP = 'netsh interface portproxy add v4tov4';

  it.each(['zorglub', '999.1.1.1'])('`connectaddress=%s` est refuse', async (v) => {
    const d = poste(`C${cle(v)}`);
    expect(await run(d, `${PP} listenport=80 connectport=80 connectaddress=${v}`))
      .toMatch(/error|invalid|incorrect|syntax/i);
  });

  it('et rien n en reste dans la table', async () => {
    const d = poste('CR');
    await run(d, `${PP} listenport=80 connectport=80 connectaddress=zorglub`);
    expect(await run(d, 'netsh interface portproxy show all')).not.toContain('zorglub');
  });

  it('`connectaddress=10.0.0.1` reste accepte et RELU', async () => {
    const d = poste('CO');
    await run(d, `${PP} listenport=80 connectport=8080 connectaddress=10.0.0.1`);
    expect(await run(d, 'netsh interface portproxy show all')).toContain('10.0.0.1');
  });
});

describe('non-regression — ce que la famille faisait deja', () => {
  it('`name=zorglub` reste accepte : un nom de regle est libre', async () => {
    const d = poste('XA');
    expect(await run(d, 'netsh advfirewall firewall add rule name=zorglub '
      + 'dir=in action=allow')).toContain('Ok.');
  });

  it('une regle bien formee est creee et RELUE', async () => {
    const d = poste('XB');
    expect(await run(d, `${AJOUT} dir=in action=allow protocol=TCP localport=80`))
      .toContain('Ok.');
    expect(await run(d, 'netsh advfirewall firewall show rule name=R')).toContain('R');
  });

  it('et `netsh interface ipv4 set address` reste juge', async () => {
    const d = poste('XC');
    expect(await run(d, 'netsh interface ipv4 set address name="Ethernet0" '
      + 'static zorglub 255.255.255.0 10.0.0.1')).toContain('Usage:');
  });
});

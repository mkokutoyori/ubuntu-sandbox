/**
 * `logging host <ip> transport tcp` — une VRAIE connexion (RFC 6587).
 *
 * Le transport était stocké, rendu dans la configuration, relu à
 * l'import, et le datagramme partait en UDP quand même : la limite était
 * écrite dans `PRD-Logging-Cisco.md` §3 plutôt que corrigée. Ce qui
 * manquait n'était pas le format mais la connexion.
 *
 * `logging delimiter tcp` en dépend directement : sans délimiteur, les
 * messages se suivent sur une seule connexion et le collecteur ne sait
 * pas où l'un finit et l'autre commence — c'est tout le sens de ce
 * mot-clé, et il ne pouvait pas en avoir tant que rien ne partait en TCP.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const PORT_COLLECTEUR = 1470;

/**
 * Un routeur et un vrai collecteur à l'écoute, câblés ensemble. Ce qui
 * est rendu est la liste de ce que le collecteur a REÇU — pas ce que le
 * routeur croit avoir envoyé.
 */
async function lab(config: string[]): Promise<{ r: CiscoRouter; recu: string[] }> {
  const r = new CiscoRouter('R1');
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  new Cable('lan').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('ip address 10.0.0.1 255.255.255.0');
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  await r.executeCommand('end');

  await pc.executeCommand('sudo ip addr add 10.0.0.50/24 dev eth0');
  const recu: string[] = [];
  pc.getTcpStack().listen(PORT_COLLECTEUR, {
    onAccept: (socket) => { socket.onData((d) => { recu.push(String(d)); }); },
  });

  await r.executeCommand('configure terminal');
  for (const c of config) await r.executeCommand(c);
  await r.executeCommand('end');
  return { r, recu };
}

/**
 * Un vrai événement, et un qui se répète : arrêter une interface déjà
 * arrêtée ne change rien et ne produit donc aucun message. Le
 * `no shutdown` remet l'interface dans l'état où un second appel pourra
 * de nouveau la changer.
 */
async function provoquerUnMessage(r: CiscoRouter): Promise<void> {
  await r.executeCommand('configure terminal');
  await r.executeCommand('interface GigabitEthernet0/1');
  await r.executeCommand('shutdown');
  await r.executeCommand('no shutdown');
  await r.executeCommand('end');
}

describe('un collecteur en TCP reçoit vraiment', () => {
  it('le message arrive sur la connexion TCP, au port configuré', async () => {
    const { r, recu } = await lab([
      `logging host 10.0.0.50 transport tcp port ${PORT_COLLECTEUR}`,
      'logging trap debugging',
    ]);
    await provoquerUnMessage(r);
    expect(recu.length).toBeGreaterThan(0);
    expect(recu.join('')).toContain('%LINK-5-CHANGED');
  });

  it('la ligne est au format RFC 3164, priorité comprise', async () => {
    const { r, recu } = await lab([
      'logging facility local6',
      `logging host 10.0.0.50 transport tcp port ${PORT_COLLECTEUR}`,
      'logging trap debugging',
    ]);
    await provoquerUnMessage(r);
    // local6 = 22, notifications = 5 → 22 * 8 + 5 = 181.
    expect(recu.join('')).toMatch(/^<181>/);
  });

  it('la connexion est UNE seule, gardée ouverte pour les messages suivants', async () => {
    const { r, recu } = await lab([
      `logging host 10.0.0.50 transport tcp port ${PORT_COLLECTEUR}`,
      'logging trap debugging',
    ]);
    await provoquerUnMessage(r);
    const apresPremier = recu.length;
    await provoquerUnMessage(r);
    expect(recu.length).toBeGreaterThan(apresPremier);
    const connexions = r.getTcpStack().listSockets()
      .filter(s => s.remotePort === PORT_COLLECTEUR);
    expect(connexions).toHaveLength(1);
  });

  it('rien n\'est perdu pendant l\'ouverture de la connexion', async () => {
    const { r, recu } = await lab([
      `logging host 10.0.0.50 transport tcp port ${PORT_COLLECTEUR}`,
      'logging trap debugging',
    ]);
    // Le tout premier message est celui qui déclenche la connexion : sans
    // file d'attente, c'est précisément celui-là qui manquerait.
    expect(recu.join('')).toContain('%SYS-5-CONFIG_I');
  });
});

describe('le fil porte le même %TAG-SEV-MNEMONIQUE que show logging', () => {
  it('la ligne reçue nomme le message comme la console le nomme', async () => {
    const { r, recu } = await lab([
      `logging host 10.0.0.50 transport tcp port ${PORT_COLLECTEUR}`,
      'logging trap debugging',
    ]);
    await provoquerUnMessage(r);
    const surLeFil = recu.join('');
    const dansLeTampon = await r.executeCommand('show logging');
    // Ce chemin passait le tag NU (`SYS`), tandis que l'autre chemin du
    // même agent en construisait un complet : deux messages de la même
    // machine arrivaient au collecteur sous deux formes selon le bus
    // interne qui les avait portés.
    for (const attendu of ['%SYS-5-CONFIG_I', '%LINK-5-CHANGED']) {
      expect(surLeFil, attendu).toContain(attendu);
      expect(dansLeTampon, attendu).toContain(attendu);
    }
  });

  it('le mnémonique voyage avec l\'événement, il n\'est pas deviné', async () => {
    const { r, recu } = await lab([
      `logging host 10.0.0.50 transport tcp port ${PORT_COLLECTEUR}`,
      'logging trap debugging',
    ]);
    await provoquerUnMessage(r);
    // `CHANGED` (arrêt administratif) et `UPDOWN` (perte de porteuse)
    // sont deux mnémoniques distincts pour la même facilité : les
    // confondre ferait perdre au collecteur la seule chose qui les
    // sépare.
    expect(recu.join('')).toContain('%LINK-5-CHANGED');
    expect(recu.join('')).not.toContain('%LINK-5-NOTIFICATIONS');
  });
});

describe('logging delimiter tcp sépare les messages', () => {
  it('sans le mot-clé, les messages se suivent sans séparateur', async () => {
    const { r, recu } = await lab([
      `logging host 10.0.0.50 transport tcp port ${PORT_COLLECTEUR}`,
      'logging trap debugging',
    ]);
    await provoquerUnMessage(r);
    expect(recu.join('')).not.toContain('\n');
  });

  it('avec le mot-clé, chaque message finit par un saut de ligne', async () => {
    const { r, recu } = await lab([
      'logging delimiter tcp',
      `logging host 10.0.0.50 transport tcp port ${PORT_COLLECTEUR}`,
      'logging trap debugging',
    ]);
    await provoquerUnMessage(r);
    const lignes = recu.join('').split('\n').filter(l => l.length > 0);
    expect(lignes.length).toBeGreaterThan(1);
    for (const l of lignes) expect(l).toMatch(/^<\d+>/);
  });
});

describe('le transport udp n\'a pas changé', () => {
  it('un collecteur en udp n\'ouvre aucune connexion TCP', async () => {
    const { r } = await lab([
      'logging host 10.0.0.50',
      'logging trap debugging',
    ]);
    await provoquerUnMessage(r);
    expect(r.getTcpStack().listSockets()
      .filter(s => s.remoteIp === '10.0.0.50')).toHaveLength(0);
  });

  it('changer de transport ferme la connexion précédente', async () => {
    const { r } = await lab([
      `logging host 10.0.0.50 transport tcp port ${PORT_COLLECTEUR}`,
      'logging trap debugging',
    ]);
    await provoquerUnMessage(r);
    expect(r.getTcpStack().listSockets()
      .filter(s => s.remotePort === PORT_COLLECTEUR && s.state === 'established'))
      .toHaveLength(1);
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging host 10.0.0.50 transport udp port 514');
    await r.executeCommand('end');
    expect(r.getTcpStack().listSockets()
      .filter(s => s.remotePort === PORT_COLLECTEUR && s.state === 'established'))
      .toHaveLength(0);
  });
});

describe('un collecteur injoignable ne fait pas tourner la machine en rond', () => {
  it('configurer un collecteur TCP qu\'on ne peut pas joindre se termine', async () => {
    // La commande se mordait la queue : ouvrir la connexion échoue,
    // l'échec produit un message (« Segment dropped … »), et ce message
    // tente d'ouvrir la connexion. Le bus étant asynchrone, ce n'est pas
    // une récursion qu'un verrou de réentrance arrêterait — c'était un
    // aller-retour sans fin, qui bloquait la suite entière.
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging host 10.99.99.99 transport tcp port 1470');
    await r.executeCommand('logging trap debugging');
    expect(await r.executeCommand('end')).not.toMatch(/Invalid input/);
    // La preuve est que ces lignes-ci s'exécutent : avant correctif, le
    // `end` ci-dessus ne rendait jamais la main.
    expect(await r.executeCommand('show logging')).toContain('Logging to 10.99.99.99');
  });

  it('des messages en rafale vers un collecteur injoignable se terminent aussi', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('logging host 10.99.99.99 transport tcp port 1470');
    await r.executeCommand('logging trap debugging');
    await r.executeCommand('end');
    for (let i = 0; i < 5; i++) {
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/1');
      await r.executeCommand('shutdown');
      await r.executeCommand('no shutdown');
      await r.executeCommand('end');
    }
    expect(await r.executeCommand('show logging')).toContain('%LINK-5-CHANGED');
  });

  it('reconfigurer le collecteur redonne sa chance à la connexion', async () => {
    const { r, recu } = await lab([
      'logging host 10.0.0.99 transport tcp port 1470',
      'logging trap debugging',
    ]);
    await provoquerUnMessage(r);
    expect(recu).toHaveLength(0);
    // La bonne adresse, cette fois : toucher à la configuration du
    // collecteur, c'est demander qu'on réessaie.
    await r.executeCommand('configure terminal');
    await r.executeCommand('no logging host 10.0.0.99');
    await r.executeCommand(`logging host 10.0.0.50 transport tcp port ${PORT_COLLECTEUR}`);
    await r.executeCommand('end');
    await provoquerUnMessage(r);
    expect(recu.join('')).toContain('%LINK-5-CHANGED');
  });
});

describe('la configuration reproduit ce qui a été tapé', () => {
  it('transport, port et délimiteur survivent au rendu', async () => {
    const { r } = await lab([
      'logging delimiter tcp',
      `logging host 10.0.0.50 transport tcp port ${PORT_COLLECTEUR}`,
    ]);
    const rc = await r.executeCommand('show running-config');
    expect(rc).toContain(`logging host 10.0.0.50 transport tcp port ${PORT_COLLECTEUR}`);
    expect(rc).toContain('logging delimiter tcp');
  });

  it('show logging annonce le transport réellement utilisé', async () => {
    const { r } = await lab([
      `logging host 10.0.0.50 transport tcp port ${PORT_COLLECTEUR}`,
    ]);
    expect(await r.executeCommand('show logging'))
      .toContain(`(tcp port ${PORT_COLLECTEUR}, audit disabled,`);
  });
});

/**
 * IP SLA — fidélité de la surface CLI à IOS 15.7.
 *
 * Le moteur mesurait juste ; la CLI, elle, trahissait la simulation. Ce
 * fichier verrouille les écarts relevés par une relecture externe et
 * vérifiés un par un contre le code (docs/PRD-IP-SLA.md §8ter) :
 * un sous-mode qui n'était pas restreint puis pas spécialisé par type,
 * une entrée sans type qui survivait, un fourre-tout qui répondait à
 * `show ip sla monitor <n'importe quoi>`, l'absence de plages
 * numériques, et un `ip sla enable` qui n'existe sur aucun routeur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function config(): Promise<CiscoRouter> {
  const router = new CiscoRouter('R1');
  await router.executeCommand('enable');
  await router.executeCommand('configure terminal');
  return router;
}

const INVALID = /% Invalid input detected at '\^' marker\./;

describe('Sous-mode ip sla : restreint, puis spécialisé par type', () => {
  it('avant tout type, l\'aide n\'offre QUE des types d\'opération', async () => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    const help = await router.executeCommand('?');

    for (const type of ['icmp-echo', 'udp-jitter', 'tcp-connect', 'http', 'dns', 'path-echo']) {
      expect(help).toContain(type);
    }
    for (const parameter of ['frequency', 'timeout', 'threshold', 'tag', 'owner', 'verify-data']) {
      expect(help).not.toContain(parameter);
    }
  });

  it('un paramètre tapé avant le type est refusé', async () => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    expect(await router.executeCommand('frequency 60')).toMatch(INVALID);
    expect(await router.executeCommand('tag WAN')).toMatch(INVALID);
  });

  it('le prompt descend dans le sous-mode du type choisi', async () => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    expect(router.getPrompt()).toContain('(config-ip-sla)');
    await router.executeCommand('icmp-echo 8.8.8.8');
    expect(router.getPrompt()).toContain('(config-ip-sla-echo)');
  });

  it.each([
    ['icmp-echo 8.8.8.8', '(config-ip-sla-echo)'],
    ['udp-jitter 8.8.8.8 5000', '(config-ip-sla-jitter)'],
    ['udp-echo 8.8.8.8 5000', '(config-ip-sla-udp)'],
    ['tcp-connect 8.8.8.8 80', '(config-ip-sla-tcp)'],
    ['http get http://8.8.8.8/', '(config-ip-sla-http)'],
    ['dns cisco.com name-server 8.8.8.8', '(config-ip-sla-dns)'],
    ['path-echo 8.8.8.8', '(config-ip-sla-pathEcho)'],
    ['icmp-jitter 8.8.8.8', '(config-ip-sla-icmpjitter)'],
  ])('%s ouvre le prompt %s', async (command, prompt) => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    await router.executeCommand(command);
    expect(router.getPrompt()).toContain(prompt);
  });

  it('un type déjà choisi est figé : les autres types disparaissent', async () => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    await router.executeCommand('icmp-echo 8.8.8.8');

    const help = await router.executeCommand('?');
    expect(help).not.toContain('udp-jitter');
    expect(help).not.toContain('tcp-connect');
    expect(await router.executeCommand('udp-jitter 1.1.1.1 5000')).toMatch(INVALID);
    expect(router.getIpSlaEngine().getOperation(1)!.config.type).toBe('icmp-echo');
  });

  it('chaque sous-mode n\'offre que les paramètres de son type', async () => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    await router.executeCommand('tcp-connect 8.8.8.8 80');
    const tcpHelp = await router.executeCommand('?');
    // tcp-connect n'a ni charge utile à dimensionner ni données à vérifier.
    expect(tcpHelp).not.toContain('request-data-size');
    expect(tcpHelp).not.toContain('verify-data');
    expect(tcpHelp).toContain('frequency');

    await router.executeCommand('exit');
    await router.executeCommand('ip sla 2');
    await router.executeCommand('icmp-echo 8.8.8.8');
    const echoHelp = await router.executeCommand('?');
    expect(echoHelp).toContain('request-data-size');
    expect(echoHelp).toContain('verify-data');
  });

  it('une destination manquante donne % Incomplete command.', async () => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    expect(await router.executeCommand('icmp-echo')).toBe('% Incomplete command.');
    expect(router.getPrompt()).toContain('(config-ip-sla)');
  });
});

describe('Une entrée sans type d\'opération n\'existe pas', () => {
  it('elle est abandonnée à la sortie du sous-mode', async () => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    await router.executeCommand('exit');

    expect(router.getIpSlaEngine().getOperation(1)).toBeUndefined();
    expect(await router.executeCommand('do show ip sla summary')).not.toContain('not configured');
  });

  it('elle ne pollue ni la running-config ni le résumé', async () => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    await router.executeCommand('exit');
    await router.executeCommand('ip sla 2');
    await router.executeCommand('icmp-echo 8.8.8.8');
    await router.executeCommand('end');

    const running = await router.executeCommand('show running-config');
    expect(running).toContain('ip sla 2');
    expect(running).not.toContain('ip sla 1');

    const summary = await router.executeCommand('show ip sla summary');
    expect(summary).toContain('2');
    expect(summary).not.toContain('not configured');
  });

  it('les colonnes du résumé restent alignées sous leurs en-têtes', async () => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    await router.executeCommand('icmp-echo 8.8.8.8');
    await router.executeCommand('end');

    const lines = (await router.executeCommand('show ip sla summary')).split('\n');
    const header = lines.find((line) => line.startsWith('ID'))!;
    const row = lines.find((line) => /^[*^~]1\s/.test(line))!;
    expect(row.indexOf('icmp-echo')).toBe(header.indexOf('Type'));
    expect(row.length).toBeLessThanOrEqual(header.length + 10);
  });
});

describe('Plages numériques : IOS refuse, il n\'absorbe pas', () => {
  it.each([
    ['frequency abc'],
    ['frequency 0'],
    ['frequency 604801'],
    ['timeout 604800001'],
    ['tos 256'],
    ['request-data-size 16385'],
  ])('%s est refusé', async (command) => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    await router.executeCommand('icmp-echo 8.8.8.8');
    expect(await router.executeCommand(command)).toMatch(INVALID);
  });

  it.each([
    ['frequency 604800', 'frequencySeconds', 604800],
    ['frequency 1', 'frequencySeconds', 1],
    ['tos 255', 'tos', 255],
    ['request-data-size 16384', 'requestDataSize', 16384],
  ])('%s est accepté aux bornes', async (command, field, expected) => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    await router.executeCommand('icmp-echo 8.8.8.8');
    expect(await router.executeCommand(command)).toBe('');
    const config_ = router.getIpSlaEngine().getOperation(1)!.config as unknown as
      Record<string, number>;
    expect(config_[field]).toBe(expected);
  });
});

describe('La branche héritée ip sla monitor est refusée, pas absorbée', () => {
  it.each([
    'show ip sla monitor',
    'show ip sla monitor statistics',
    'show ip sla monitor configuration',
    'show ip sla monitor responder',
  ])('%s est refusé', async (command) => {
    const router = new CiscoRouter('R1');
    await router.executeCommand('enable');
    expect(await router.executeCommand(command)).toMatch(INVALID);
  });

  it('show ip sla nu répond toujours le bloc application', async () => {
    const router = new CiscoRouter('R1');
    await router.executeCommand('enable');
    expect(await router.executeCommand('show ip sla'))
      .toContain('IP Service Level Agreements');
  });

  it('un mot inconnu derrière show ip sla est refusé', async () => {
    const router = new CiscoRouter('R1');
    await router.executeCommand('enable');
    expect(await router.executeCommand('show ip sla nimportequoi')).toMatch(INVALID);
  });
});

describe('Commandes qui manquaient', () => {
  it('clear ip sla statistics remet les compteurs à zéro', async () => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    await router.executeCommand('icmp-echo 8.8.8.8');
    await router.executeCommand('end');

    const runtime = router.getIpSlaEngine().getOperation(1)!;
    runtime.counters.successes = 7;
    runtime.aggregate.numRtts = 7;

    expect(await router.executeCommand('clear ip sla statistics')).toBe('');
    expect(router.getIpSlaEngine().getOperation(1)!.counters.successes).toBe(0);
    expect(router.getIpSlaEngine().getOperation(1)!.aggregate.numRtts).toBe(0);
  });

  it('clear ip sla statistics <n> ne touche que l\'opération visée', async () => {
    const router = await config();
    for (const id of [1, 2]) {
      await router.executeCommand(`ip sla ${id}`);
      await router.executeCommand('icmp-echo 8.8.8.8');
      await router.executeCommand('exit');
    }
    await router.executeCommand('end');
    const engine = router.getIpSlaEngine();
    engine.getOperation(1)!.counters.successes = 5;
    engine.getOperation(2)!.counters.successes = 9;

    await router.executeCommand('clear ip sla statistics 1');
    expect(engine.getOperation(1)!.counters.successes).toBe(0);
    expect(engine.getOperation(2)!.counters.successes).toBe(9);
  });

  it('clear ip sla statistics sur une entrée inexistante est refusé', async () => {
    const router = new CiscoRouter('R1');
    await router.executeCommand('enable');
    expect(await router.executeCommand('clear ip sla statistics 42'))
      .toContain('does not exist');
  });

  it('debug ip sla trace est une vraie catégorie, pas le fourre-tout debug ip', async () => {
    const router = new CiscoRouter('R1');
    await router.executeCommand('enable');
    const out = await router.executeCommand('debug ip sla trace');
    expect(out).not.toContain('IP packet debugging');
    expect(router.getDebugService().isEnabled('ip.sla.trace')).toBe(true);
    await router.executeCommand('no debug ip sla trace');
    expect(router.getDebugService().isEnabled('ip.sla.trace')).toBe(false);
  });

  it('debug track suit les objets', async () => {
    const router = new CiscoRouter('R1');
    await router.executeCommand('enable');
    await router.executeCommand('debug track');
    expect(router.getDebugService().isEnabled('track')).toBe(true);
  });

  it('show ip sla group schedule rend les groupes planifiés', async () => {
    const router = await config();
    for (const id of [1, 2]) {
      await router.executeCommand(`ip sla ${id}`);
      await router.executeCommand('icmp-echo 8.8.8.8');
      await router.executeCommand('exit');
    }
    await router.executeCommand('ip sla group schedule GRP1 1,2 life forever');
    await router.executeCommand('end');

    const out = await router.executeCommand('show ip sla group schedule');
    expect(out).toContain('Group Entry Number: GRP1');
    expect(out).toContain('Probes to be scheduled: 1,2');
    expect(out).toContain('Total number of probes: 2');
  });
});

describe('ip sla enable : la forme réelle est reaction-alerts', () => {
  it('la forme nue est incomplète, pas invalide', async () => {
    const router = await config();
    // `reaction-alerts` est le seul complément : taper le préfixe donne
    // « % Incomplete command. », ce que fait aussi un vrai IOS. Ce n'est
    // donc pas `% Invalid input` qu'il faut attendre ici.
    expect(await router.executeCommand('ip sla enable')).toBe('% Incomplete command.');
  });

  it('reaction-alerts est acceptée', async () => {
    const router = await config();
    expect(await router.executeCommand('ip sla enable reaction-alerts')).toBe('');
    expect(await router.executeCommand('no ip sla enable reaction-alerts')).toBe('');
  });
});

describe('L\'aide est triée alphabétiquement, comme sur IOS', () => {
  it('les types d\'opération sortent dans l\'ordre alphabétique', async () => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    const keywords = (await router.executeCommand('?'))
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(keywords).toEqual([...keywords].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('les paramètres d\'un sous-mode aussi', async () => {
    const router = await config();
    await router.executeCommand('ip sla 1');
    await router.executeCommand('icmp-echo 8.8.8.8');
    const keywords = (await router.executeCommand('?'))
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((word) => word && !word.startsWith('<'));
    expect(keywords).toEqual([...keywords].sort((a, b) => a.localeCompare(b, 'en')));
  });
});

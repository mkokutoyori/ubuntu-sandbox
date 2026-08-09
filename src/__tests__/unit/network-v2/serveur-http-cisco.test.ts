/**
 * `ip http server` et `test aaa group` — les deux points laissés ouverts
 * par `docs/PRD-Acces-Privileges-Cisco.md`, refermés ensemble parce que
 * l'authentification AAA du serveur web est le même mécanisme que celui
 * que `test aaa` éprouve (`docs/PRD-Serveur-HTTP-Cisco.md`).
 *
 * Ce que la mesure a trouvé, et qui n'est pas ce que le PRD annonçait :
 *
 * — `ip http server`/`secure-server` étaient deux booléens de
 *   `CiscoConfigState`, table dont le rendu `runningConfigLines()` n'a
 *   AUCUN appelant de production. Les deux commandes étaient donc
 *   acceptées et absentes de la configuration DANS LES DEUX SENS, ce qui
 *   dépasse l'affichage : la configuration rendue est rejouée à l'import
 *   d'une topologie. Les cinq commandes qui accompagnent le drapeau
 *   (`port`, `authentication`, `max-connections`, `access-class`,
 *   `timeout-policy`) étaient refusées, et rien n'écoutait.
 *
 * — `test aaa group` n'était pas absente : le protocole TACACS+ est réel,
 *   `AaaAuthenticator.testGroupAuthentication()` était ÉCRITE pour cette
 *   commande, et la commande existait — dans `CiscoTerminalSession`
 *   seulement, donc dans le terminal graphique et nulle part ailleurs.
 *   La même machine y répondait par un onglet et l'ignorait par le shell.
 *
 * Discriminé par remise en état des dix-sept fichiers produit : **15 cas
 * sur 19 tombent** avant correctif. Les 4 qui passent des deux côtés sont
 * nommés ici plutôt que laissés à découvrir, parce que deux d'entre eux
 * ne prouvent rien du mécanisme : « un serveur arrêté ne laisse aucune
 * ligne » passait parce qu'AUCUNE ligne n'était rendue dans un sens ni
 * dans l'autre, et « `no ip http server` ferme vraiment le port » parce
 * que rien n'avait jamais écouté. Les deux autres sont les cas de
 * non-régression, dont c'est précisément l'objet.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

async function config(r: CiscoRouter, cmds: string[]): Promise<string> {
  const sorties: string[] = [];
  for (const c of ['enable', 'configure terminal', ...cmds, 'end']) {
    sorties.push(String(await r.executeCommand(c)));
  }
  return sorties.join('\n');
}

/** Un routeur câblé à un PC, serveur web actif, deux comptes locaux. */
async function lab(): Promise<{ r: CiscoRouter; pc: LinuxPC }> {
  const r = new CiscoRouter('R1');
  const pc = new LinuxPC('PC1');
  new Cable('c1').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  await config(r, [
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'enable secret Cisco123',
    'username admin privilege 15 secret Admin123',
    'username lecteur privilege 5 secret Lect123',
    'ip http server',
    'ip http authentication local',
  ]);
  await pc.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  await pc.executeCommand('ip link set eth0 up');
  return { r, pc };
}

const code = (pc: LinuxPC, url: string, creds = 'admin:Admin123'): Promise<string> =>
  pc.executeCommand(`curl -sS -o /dev/null -w "%{http_code}" -u ${creds} ${url}`)
    .then((o) => String(o).trim());

describe('§2 : la configuration du serveur existe et se relit', () => {
  it('les six faits sont acceptés et rendus tels qu\'ils ont été tapés', async () => {
    const { r } = await lab();
    await config(r, [
      'ip http port 8080',
      'ip http max-connections 8',
      'ip http timeout-policy idle 90 life 120 requests 4',
      'ip http secure-server',
    ]);
    const cfg = String(await r.executeCommand('show running-config'));
    for (const ligne of [
      'ip http server', 'ip http authentication local', 'ip http port 8080',
      'ip http max-connections 8',
      'ip http timeout-policy idle 90 life 120 requests 4',
      'ip http secure-server',
    ]) expect(cfg, ligne).toContain(ligne);
  });

  /**
   * Le défaut est ARRÊTÉ, donc c'est la forme positive qui doit paraître.
   * Une configuration qui ne reproduit pas ce qu'on a tapé est rejouée
   * fausse à l'import d'une topologie.
   */
  it('un serveur arrêté ne laisse aucune ligne', async () => {
    const { r } = await lab();
    await config(r, ['no ip http server']);
    expect(String(await r.executeCommand('show running-config')))
      .not.toContain('ip http server');
  });

  it('une valeur hors bornes est refusée plutôt que rognée', async () => {
    const { r } = await lab();
    expect(await config(r, ['ip http max-connections 99'])).toContain('% Invalid input');
    expect(await config(r, ['ip http authentication bidon'])).toContain('% Invalid input');
    expect(await config(r, ['ip http port 0'])).toContain('% Invalid input');
    // Les bornes réelles restent acceptées.
    expect(await config(r, ['ip http max-connections 16'])).not.toContain('% Invalid input');
  });

  it('`show ip http server status` LIT le service', async () => {
    const { r } = await lab();
    await config(r, ['ip http port 8080', 'ip http max-connections 8']);
    const out = String(await r.executeCommand('show ip http server status'));
    expect(out).toContain('HTTP server status: Enabled');
    expect(out).toContain('HTTP server port: 8080');
    expect(out).toContain('HTTP server authentication method: local');
    expect(out).toContain('Maximum number of concurrent server connections allowed: 8');
    expect(out).toContain('HTTP secure server status: Disabled');
  });
});

describe('§3 : le serveur SERT, et sert l\'EXEC', () => {
  /**
   * Le cœur du sujet : un port ouvert que rien ne lit serait le défaut
   * qu'on referme sous une autre forme. `/level/<n>/exec/<commande>` est
   * l'URL du vrai IOS, et elle rend la sortie de la VRAIE commande.
   */
  it('une commande passée par l\'URL rend le texte de cette commande', async () => {
    const { r, pc } = await lab();
    const page = String(await pc.executeCommand(
      'curl -sS -u admin:Admin123 http://10.0.0.1/level/15/exec/show/version'));
    expect(page).toContain('Cisco IOS Software');
    // Le MÊME texte que par la console : une machine qui répondrait deux
    // `show version` selon la porte serait pire qu'une sans serveur web.
    const console_ = String(await r.executeCommand('show version'));
    expect(page).toContain(console_.split('\n')[0].trim());
  });

  it('sans identifiants, un 401 qui nomme le niveau manquant', async () => {
    const { pc } = await lab();
    const brut = String(await pc.executeCommand(
      'curl -sS -i http://10.0.0.1/level/15/exec/show/version'));
    expect(brut).toContain('401 Unauthorized');
    expect(brut).toContain('WWW-Authenticate: Basic realm="level_15_access"');
  });

  it('un mot de passe faux est refusé', async () => {
    const { pc } = await lab();
    expect(await code(pc, 'http://10.0.0.1/level/15/exec/show/clock', 'admin:faux')).toBe('401');
  });

  /**
   * Le contrôle dont l'absence a fait la faille de 2001 : le niveau du
   * compte plafonne ce que l'URL peut demander.
   */
  it('un compte de niveau 5 n\'obtient pas le niveau 15', async () => {
    const { pc } = await lab();
    expect(await code(pc, 'http://10.0.0.1/level/15/exec/show/clock', 'lecteur:Lect123'))
      .toBe('401');
    expect(await code(pc, 'http://10.0.0.1/level/5/exec/show/clock', 'lecteur:Lect123'))
      .toBe('200');
  });

  it('`ip http authentication enable` prend le secret d\'activation', async () => {
    const { r, pc } = await lab();
    await config(r, ['ip http authentication enable']);
    // Le nom d'utilisateur est ignoré : le mot de passe EST le secret.
    expect(await code(pc, 'http://10.0.0.1/level/15/exec/show/clock', 'nimporte:Cisco123'))
      .toBe('200');
    expect(await code(pc, 'http://10.0.0.1/level/15/exec/show/clock', 'nimporte:Admin123'))
      .toBe('401');
  });

  it('`no ip http server` ferme vraiment le port', async () => {
    const { r, pc } = await lab();
    await config(r, ['no ip http server']);
    expect(r.getTcpStack().listListeners().map((l) => l.localPort)).not.toContain(80);
    expect(String(await pc.executeCommand('curl -sS http://10.0.0.1/level/15/exec/show/clock')))
      .toContain('Connection refused');
  });

  it('`ip http port` DÉPLACE le service, il ne le double pas', async () => {
    const { r, pc } = await lab();
    await config(r, ['ip http port 8080']);
    const ports = r.getTcpStack().listListeners().map((l) => l.localPort);
    expect(ports).toContain(8080);
    expect(ports).not.toContain(80);
    expect(await code(pc, 'http://10.0.0.1:8080/level/15/exec/show/clock')).toBe('200');
  });

  it('`ip http access-class` filtre par adresse source', async () => {
    const { r, pc } = await lab();
    await config(r, ['access-list 55 deny 10.0.0.2', 'access-list 55 permit any',
      'ip http access-class 55']);
    expect(await code(pc, 'http://10.0.0.1/level/15/exec/show/clock')).toBe('403');
    await config(r, ['no ip http access-class 55']);
    expect(await code(pc, 'http://10.0.0.1/level/15/exec/show/clock')).toBe('200');
  });

  it('`ip http secure-server` sert la MÊME interface, chiffrée', async () => {
    const { r, pc } = await lab();
    await config(r, ['ip http secure-server']);
    const page = String(await pc.executeCommand(
      'curl -sS -k -u admin:Admin123 https://10.0.0.1/level/15/exec/show/clock'));
    expect(page).toContain('<H1>R1</H1>');
    // Le point de confiance est nommé, comme sur une machine réelle.
    expect(String(await r.executeCommand('show ip http server status')))
      .toMatch(/HTTP secure server trustpoint: TP-self-signed-\d+/);
  });
});

describe('§5 : `test aaa group` répond depuis le shell', () => {
  it('la commande existe, et distingue « refusé » de « personne n\'a répondu »', async () => {
    const r = new CiscoRouter('R1');
    await config(r, ['aaa new-model', 'aaa group server tacacs+ TACGRP']);
    const out = String(await r.executeCommand('test aaa group TACGRP bob secret new-code'));
    expect(out).toContain('Attempting authentication test to server-group TACGRP using TACACS+');
    // Aucun serveur n'est membre du groupe : ce n'est pas un refus.
    expect(out).toContain('No authoritative response from any server.');
    expect(out).not.toContain('NOT successfully authenticated');
  });

  it('`legacy` et `new-code` sont acceptés tous les deux', async () => {
    const r = new CiscoRouter('R1');
    await config(r, ['aaa new-model', 'aaa group server tacacs+ TACGRP']);
    for (const mode of ['legacy', 'new-code']) {
      expect(String(await r.executeCommand(`test aaa group TACGRP bob secret ${mode}`)), mode)
        .toContain('Attempting authentication test');
    }
  });

  it('une syntaxe incomplète est refusée', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(String(await r.executeCommand('test aaa group TACGRP bob')))
      .toContain('% Incomplete command');
    expect(String(await r.executeCommand('test aaa group TACGRP bob secret bidon')))
      .toContain('% Invalid input');
  });
});

describe('non-régression : rien ne change sans serveur web', () => {
  it('un routeur neuf n\'écoute ni sur 80 ni sur 443', async () => {
    const r = new CiscoRouter('R1');
    const ports = r.getTcpStack().listListeners().map((l) => l.localPort);
    expect(ports).not.toContain(80);
    expect(ports).not.toContain(443);
  });

  it('sa configuration ne porte aucune ligne `ip http`', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(String(await r.executeCommand('show running-config'))).not.toContain('ip http');
  });
});

describe('§2bis : un Catalyst garde aussi sa configuration', () => {
  /**
   * `ip http server` est une commande de commutateur autant que de
   * routeur — c'est même celle que tout guide de durcissement fait
   * désactiver en premier. Elle y était acceptée puis PERDUE, rangée
   * dans la même table sans rendu.
   *
   * Limite assumée, écrite ici plutôt que découverte : ce commutateur n'a
   * aucune pile TCP, donc aucun port ne s'ouvre. Ce qui est réparé est la
   * fidélité de la configuration, pas le service.
   */
  it('la configuration d\'un commutateur porte les lignes `ip http`', async () => {
    const { CiscoSwitch } = await import('@/network/devices/CiscoSwitch');
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 26);
    for (const c of ['enable', 'configure terminal', 'ip http server',
      'ip http port 8080', 'ip http authentication local', 'end']) {
      await sw.executeCommand(c);
    }
    const cfg = String(await sw.executeCommand('show running-config'));
    expect(cfg).toContain('ip http server');
    expect(cfg).toContain('ip http port 8080');
    expect(cfg).toContain('ip http authentication local');
  });
});

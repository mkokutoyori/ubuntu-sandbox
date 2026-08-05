/**
 * docs/PRD-Sockets-Une-Seule-Verite.md §P0 (inventaire) et §P1
 * (`TcpStack.listen()` annonce, `closeListener()` retire).
 *
 * Il y a deux tables de ports sur chaque machine : celle qui décide
 * d'accepter une connexion (`TcpStack.listeners`) et celle que lisent
 * `ss`, `netstat`, `lsof`, `/proc/net/tcp` et `nmap` (`SocketTable`).
 * Rien ne les obligeait à s'accorder, dans aucun des deux sens.
 *
 * `PRD-Nginx` §P0 avait retiré le décor — un port affiché que rien
 * n'ouvrait. Ce fichier tient l'erreur symétrique : un port réellement
 * ouvert qui n'apparaissait nulle part.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

interface Host {
  getTcpStack(): {
    listListeners(): Array<{ localIp: string; localPort: number }>;
    listen(port: number, opts: Record<string, unknown>, ip?: string): unknown;
    closeListener(port: number, ip?: string): void;
  };
  getSocketTable(): {
    getListening(): Array<{ protocol: string; localPort: number; localAddress: string; processName?: string }>;
  };
  powerOn(): void;
  executeCommand(cmd: string): Promise<string>;
}

/** Les ports que la pile sert réellement mais que `ss` ne montre pas. */
function joignableInvisible(host: Host): number[] {
  const affiches = new Set(
    host.getSocketTable().getListening()
      .filter((e) => e.protocol === 'tcp')
      .map((e) => e.localPort),
  );
  const servis = new Set(host.getTcpStack().listListeners().map((l) => l.localPort));
  return [...servis].filter((p) => !affiches.has(p)).sort((a, b) => a - b);
}

/** Les ports affichés que rien n'ouvre — le décor. */
function afficheInjoignable(host: Host): number[] {
  const servis = new Set(host.getTcpStack().listListeners().map((l) => l.localPort));
  return host.getSocketTable().getListening()
    .filter((e) => e.protocol === 'tcp' && !servis.has(e.localPort))
    .map((e) => e.localPort)
    .sort((a, b) => a - b);
}

/**
 * Le décor qui subsiste — et il ne subsiste rien
 * (docs/PRD-Manquements.md §M2).
 *
 * Cette table a compté deux entrées : le 139 de Windows, à qui §P2a a
 * donné le SMB qu'il annonçait, et le 1521 d'Oracle, dont §M1 a montré
 * qu'il ne lui manquait pas un serveur TNS mais un appel à l'amorçage.
 * On la garde VIDE plutôt que de la supprimer, parce que c'est ainsi
 * qu'elle se défend : une entrée ajoutée ici doit s'écrire, se
 * justifier, et se relire.
 *
 * Une table vide qu'un test consulte est un garde-fou ; une table pleine
 * d'exceptions est une liste de pardons.
 */
const DECOR_CONNU: Record<number, string> = {};

describe('§P1 — une écoute réelle se voit dans ss', () => {
  it('un port ouvert directement sur la pile apparaît dans ss, avec son processus', async () => {
    const srv = new LinuxServer('linux-server', 'SRV');
    srv.powerOn();

    srv.getTcpStack().listen(7777, {
      onAccept: () => undefined,
      identity: { pid: 4242, processName: 'monservice' },
    });

    const out = await srv.executeCommand('ss -ltnp');
    expect(out).toContain(':7777');
    expect(out).toContain('monservice');
  });

  it('refermer l\'écoute retire la ligne', async () => {
    const srv = new LinuxServer('linux-server', 'SRV');
    srv.powerOn();

    srv.getTcpStack().listen(7777, { onAccept: () => undefined });
    expect(await srv.executeCommand('ss -ltn')).toContain(':7777');

    srv.getTcpStack().closeListener(7777);
    expect(await srv.executeCommand('ss -ltn')).not.toContain(':7777');
  });

  it('une écoute sans identité s\'affiche quand même, colonne processus vide', async () => {
    const pc = new LinuxPC('linux-pc', 'PC');
    pc.powerOn();

    pc.getTcpStack().listen(7778, { onAccept: () => undefined });

    // Sans pid, `netstat` laisse la colonne PID/Program vide — c'est ce
    // que montre un vrai netstat lancé sans les droits. Le port, lui,
    // est bien là : c'est la question qu'on pose.
    expect(await pc.executeCommand('netstat -tlnp')).toContain(':7778');
  });
});

describe('§P0/§P1 — le croisement des deux tables, machine par machine', () => {
  const machines: Array<[string, () => Host]> = [
    ['linux-server', () => new LinuxServer('linux-server', 'SRV') as unknown as Host],
    ['linux-pc', () => new LinuxPC('linux-pc', 'PC') as unknown as Host],
    ['windows-pc', () => new WindowsPC('windows-pc', 'WPC') as unknown as Host],
    // §M2/B1 : c'est la machine qui ouvre le PLUS d'écoutes — WinRM,
    // LDAP, Kerberos, réplication AD, DFSR, WSUS, LPD — et elle était
    // la seule absente du croisement.
    ['windows-server', () => new WindowsServer('windows-server', 'WSRV') as unknown as Host],
  ];

  for (const [nom, fabrique] of machines) {
    it(`${nom} : aucun port joignable n'est invisible`, () => {
      const host = fabrique();
      host.powerOn();
      expect(joignableInvisible(host)).toEqual([]);
    });

    it(`${nom} : le décor restant est celui qui est écrit, et rien d'autre`, () => {
      const host = fabrique();
      host.powerOn();
      for (const port of afficheInjoignable(host)) {
        expect(DECOR_CONNU[port], `port ${port} affiché sans écoute et sans justification`)
          .toBeDefined();
      }
    });
  }

  it('nginx démarré ne crée aucune divergence non plus', async () => {
    const srv = new LinuxServer('linux-server', 'WEB') as unknown as Host;
    srv.powerOn();
    await srv.executeCommand('systemctl start nginx');

    expect(joignableInvisible(srv)).toEqual([]);
    expect(await srv.executeCommand('ss -ltn')).toContain(':80');
  });

  // §M2/B2 — nginx était le seul service démarré que le croisement
  // vérifiait. Les autres se sont révélés sains à la mesure ; rien ne
  // les y retenait.
  for (const unite of ['dnsmasq', 'vsftpd', 'postfix', 'named']) {
    it(`${unite} démarré ne crée aucune divergence`, async () => {
      const srv = new LinuxServer('linux-server', `SRV-${unite}`) as unknown as Host;
      srv.powerOn();
      await srv.executeCommand(`systemctl start ${unite}`);

      expect(joignableInvisible(srv)).toEqual([]);
      for (const port of afficheInjoignable(srv)) {
        expect(DECOR_CONNU[port], `port ${port} affiché sans écoute`).toBeDefined();
      }
    });
  }
});

/**
 * docs/PRD-Sockets-Une-Seule-Verite.md §P3 — le garde-fou.
 *
 * Sans lui, §P1 et §P2 se déferont au premier ajout : c'est exactement
 * ainsi que ce défaut est né et s'est reproduit cinq fois. Ce bloc ne
 * décrit aucune machine en particulier — il énonce la règle, pour que
 * la prochaine écoute ajoutée n'ait pas à y penser.
 */
describe('§P3 — la règle, pas la liste', () => {
  it('une écoute ouverte APRÈS le démarrage s\'annonce aussi', async () => {
    const srv = new LinuxServer('linux-server', 'TARD') as unknown as Host;
    srv.powerOn();

    srv.getTcpStack().listen(6001, { onAccept: () => undefined });

    expect(joignableInvisible(srv)).toEqual([]);
    expect(await srv.executeCommand('ss -ltn')).toContain(':6001');
  });

  it('une écoute sur une adresse précise s\'annonce comme les autres', async () => {
    const srv = new LinuxServer('linux-server', 'ADDR') as unknown as Host;
    srv.powerOn();

    srv.getTcpStack().listen(6002, { onAccept: () => undefined }, '127.0.0.1');

    expect(joignableInvisible(srv)).toEqual([]);
    expect(await srv.executeCommand('ss -ltn')).toContain(':6002');
  });

  it('ouvrir puis refermer ne laisse aucune trace d\'un côté ni de l\'autre', () => {
    const srv = new LinuxServer('linux-server', 'CYCLE') as unknown as Host;
    srv.powerOn();
    const avant = afficheInjoignable(srv);

    srv.getTcpStack().listen(6003, { onAccept: () => undefined });
    srv.getTcpStack().closeListener(6003);

    // Ni port fantôme affiché, ni écoute orpheline : le cycle complet
    // rend la machine à l'état où il l'a trouvée.
    expect(joignableInvisible(srv)).toEqual([]);
    expect(afficheInjoignable(srv)).toEqual(avant);
  });

  it('aucune machine ne garde d\'entrée décorative — la table est vide', () => {
    expect(Object.keys(DECOR_CONNU)).toEqual([]);
  });
});

describe('§P2 — les entrées décoratives, une par une', () => {
  it('le 139 de Windows répond vraiment, au lieu d\'être seulement affiché', () => {
    const pc = new WindowsPC('windows-pc', 'WPC');
    pc.powerOn();

    const servis = pc.getTcpStack().listListeners().map((l) => l.localPort);
    expect(servis).toContain(139);
    expect(servis).toContain(445);
  });

  it('le 139 et le 445 sont le même service, et s\'éteignent ensemble', () => {
    const pc = new WindowsPC('windows-pc', 'WPC');
    pc.powerOn();

    const lignes = pc.getSocketTable().getListening()
      .filter((e) => e.localPort === 139 || e.localPort === 445);
    expect(lignes).toHaveLength(2);
    for (const l of lignes) expect(l.processName).toBe('System');
  });

  it('le 53/tcp et le 853 de dnsmasq n\'ont plus de bind manuel à côté', async () => {
    const srv = new LinuxServer('linux-server', 'DNS') as unknown as Host;
    srv.powerOn();
    await srv.executeCommand('systemctl start dnsmasq');

    // Les deux ports viennent maintenant de leur écoute, pas d'une
    // seconde inscription : aucune divergence dans un sens ni l'autre.
    expect(joignableInvisible(srv)).toEqual([]);
  });
});

describe('§P2b — sshd sur les deux familles, sans doublon', () => {
  it('les lignes v4 et v6 du 22 viennent de l\'écoute, bannière comprise', () => {
    const srv = new LinuxServer('linux-server', 'SSHD');
    srv.powerOn();

    const lignes = srv.getSocketTable().getListening()
      .filter((e) => e.protocol === 'tcp' && e.localPort === 22);
    expect(lignes).toHaveLength(2);
    for (const l of lignes) {
      expect(l.processName).toBe('sshd');
      expect(l.pid).toBe(985);
      // La bannière est ce que lisent `nc`/`nmap` : elle voyage avec
      // l'écoute depuis §P2b, au lieu d'être réinscrite à côté.
      expect(l.banner).toContain('SSH-2.0');
    }
    expect(lignes.map((l) => l.localAddress).sort()).toEqual(['0.0.0.0', '::']);
  });

  it('le 22 est réellement servi sur les DEUX adresses, pas seulement affiché', () => {
    const srv = new LinuxServer('linux-server', 'SSHD');
    srv.powerOn();

    // Le point de §P2b : `:::22` figurait dans `ss` sans écoute propre.
    const servies = srv.getTcpStack().listListeners()
      .filter((l) => l.localPort === 22)
      .map((l) => l.localIp)
      .sort();
    expect(servies).toEqual(['0.0.0.0', '::']);
  });

  it('aucun port joignable n\'est invisible une fois sshd démarré', () => {
    const srv = new LinuxServer('linux-server', 'SSHD') as unknown as Host;
    srv.powerOn();
    expect(joignableInvisible(srv)).toEqual([]);
  });
});

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
 * Le décor qui subsiste, écrit plutôt que toléré en silence. Chacun est
 * justifié à son point de liaison ; §P2 les reprendra un par un.
 */
const DECOR_CONNU: Record<number, string> = {
  139: 'NetBIOS Session Service — aucune écoute nulle part',
  1521: 'listener TNS Oracle — un vrai serveur TNS est un chantier à part',
};

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
});

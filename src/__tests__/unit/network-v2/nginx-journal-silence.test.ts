/**
 * Un serveur web qui sert des requêtes n'écrit RIEN dans le journal système.
 *
 * Mesuré avant le correctif : `PortActivityLogProjection` journalisait, pour
 * TOUT service qui acceptait une connexion, `Accepted connection from
 * <ip>:<port> on …` puis `Connection from … closed (fin)`, sous une
 * étiquette inventée (`httpd`, `smtp`, `ftpd`, `tcp-8080`), avec un PID
 * différent à chaque ligne. Cinquante requêtes à nginx ajoutaient cent
 * lignes à `journalctl` et à `/var/log/syslog` ; ni nginx ni Apache n'ont
 * jamais écrit cela : leurs requêtes vont dans `access.log`, leurs
 * erreurs dans `error.log`, et le journal ne porte que les lignes de
 * systemd (« Started nginx.service »). Le coût n'était pas que cosmétique :
 * chaque ligne retient ~7 Kio dans la structure binaire du journal, ce qui
 * faisait grossir la mémoire de ~15 Kio par requête, sans fin.
 *
 * Même chose pour `Server listening on 0.0.0.0 port 80.` : sshd le dit
 * vraiment, nginx non. La ligne de sshd, elle, reste (témoin).
 *
 * Discrimination par `git stash -u` de src/network : voir le commit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Http1ClientSession } from '@/network/http/http1/Http1ClientSession';
import { createRequest } from '@/network/http/semantics/types';
import { demarrer, labo, type Labo } from './_nginxProxyLab';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const SITE = 'server {\n  listen 80 default_server;\n  root /var/www/html;\n  index index.nginx-debian.html;\n}\n';

function request(lab: Labo, count: number): void {
  for (let i = 0; i < count; i++) {
    const req = createRequest('GET', '/');
    req.headers.set('Host', '10.0.0.1');
    const client = new Http1ClientSession(lab.back.getTcpStack(), '10.0.0.1', 80);
    client.send(req);
    client.close();
  }
}

const lines = async (lab: Labo, command: string): Promise<number> =>
  Number((await lab.front.executeCommand(command)).trim());

describe('le journal et nginx', () => {
  it('cinquante requêtes n\'ajoutent aucune ligne au journal', async () => {
    const lab = labo();
    await demarrer(lab, SITE);
    const before = await lines(lab, 'journalctl --no-pager -q | wc -l');
    request(lab, 50);
    expect(await lines(lab, 'journalctl --no-pager -q | wc -l')).toBe(before);
  });

  it('ni dans /var/log/syslog', async () => {
    const lab = labo();
    await demarrer(lab, SITE);
    const before = await lines(lab, 'wc -l < /var/log/syslog');
    request(lab, 20);
    expect(await lines(lab, 'wc -l < /var/log/syslog')).toBe(before);
  });

  it('aucune étiquette inventée (httpd, tcp-80) ne figure au journal', async () => {
    const lab = labo();
    await demarrer(lab, SITE);
    request(lab, 5);
    const journal = await lab.front.executeCommand('journalctl --no-pager -q');
    expect(journal).not.toContain('httpd[');
    expect(journal).not.toContain('tcp-80');
    expect(journal).not.toContain('Accepted connection');
    expect(journal).not.toContain('Server listening on 0.0.0.0 port 80');
  });

  it('WITNESS : la requête, elle, est bien servie et va dans access.log', async () => {
    const lab = labo();
    await demarrer(lab, SITE);
    request(lab, 3);
    const access = await lab.front.executeCommand('cat /var/log/nginx/access.log');
    expect(access.trim().split('\n').length).toBe(3);
  });

  it('WITNESS : le démarrage du service est journalisé, le journal fonctionne', async () => {
    const lab = labo();
    await demarrer(lab, SITE);
    const journal = await lab.front.executeCommand('journalctl --no-pager -q -u nginx');
    expect(journal).toContain('nginx');
  });
});

describe('sshd garde sa voix', () => {
  it('« Server listening on » d\'sshd reste dans auth.log', async () => {
    const lab = labo();
    await lab.front.executeCommand('systemctl restart ssh');
    expect(await lab.front.executeCommand('cat /var/log/auth.log')).toContain('Server listening on');
  });
});

/**
 * Scénario 7 — Panne du service DNS : impact sur toutes les résolutions
 * de noms.
 *
 * Transcription littérale : le service DNS de DC01 est arrêté. L'accès
 * par IP directe continue de fonctionner, les entrées de `/etc/hosts`
 * aussi, mais toute résolution par nom échoue. Le script fichier
 * `/tmp/validation-dns.sh` valide les résolutions critiques et
 * `/tmp/impact-dns.sh` distingue « panne DNS » de « panne réseau ».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

describe('Scénario 7 — arrêt du service DNS', () => {
  const LONG = 30_000;
  let sw: CiscoSwitch;
  let pc: LinuxPC;
  let dns: LinuxServer;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    sw = new CiscoSwitch('switch-cisco', 'SW-MANDENG-01', 8);
    sw.powerOn();
    pc = new LinuxPC('linux-pc', 'pc-linux-1', 0, 0);
    dns = new LinuxServer('linux-server', 'dc01', 0, 0);
    pc.powerOn();
    dns.powerOn();
    new Cable('lien-pc').connect(sw.getPort('FastEthernet0/1')!, pc.getPort('eth0')!);
    new Cable('lien-dns').connect(sw.getPort('FastEthernet0/2')!, dns.getPort('eth0')!);
    pc.configureInterface('eth0', new IPAddress('192.168.10.101'), new SubnetMask('255.255.255.0'));
    dns.configureInterface('eth0', new IPAddress('192.168.10.10'), new SubnetMask('255.255.255.0'));

    // Zone mandeng.lan servie par DC01.
    dns.dnsService.addRecord({ name: 'dc01.mandeng.lan', type: 'A', value: '192.168.10.10', ttl: 3600 });
    dns.dnsService.addRecord({ name: 'mandeng.lan', type: 'A', value: '192.168.10.10', ttl: 3600 });
    dns.dnsService.addRecord({ name: 'srv-web.mandeng.lan', type: 'A', value: '192.168.10.50', ttl: 3600 });
    dns.dnsService.start();
    await pc.executeCommand("sudo sh -c 'echo \"nameserver 192.168.10.10\" > /etc/resolv.conf'");

    await installScripts();
  });

  const run = (cmd: string): Promise<string> => pc.executeCommand(cmd);

  async function installScripts(): Promise<void> {
    // Validation des résolutions critiques (nom → IP attendue).
    await run(`cat << 'VALID' > /tmp/validation-dns.sh
#!/bin/bash
set -uo pipefail
SERVEUR="\${1:-192.168.10.10}"
ENTREES="dc01.mandeng.lan|192.168.10.10
mandeng.lan|192.168.10.10"

OK=0
KO=0

echo "=== VALIDATION DNS ==="
echo "$ENTREES" | while IFS='|' read -r NOM ATTENDU; do
  RESOLU=$(dig +short "$NOM" @"$SERVEUR" 2>/dev/null | head -1)
  if [ "$RESOLU" = "$ATTENDU" ]; then
    echo "OK $NOM -> $RESOLU"
  else
    echo "KO $NOM -> '\${RESOLU:-vide}' (attendu $ATTENDU)"
  fi
done
VALID
chmod +x /tmp/validation-dns.sh`);

    // Distinction panne DNS vs panne réseau : l'IP répond-elle encore ?
    await run(`cat << 'IMPACT' > /tmp/impact-dns.sh
#!/bin/bash
set -uo pipefail
SERVEUR="\${1:-192.168.10.10}"
NOM="\${2:-dc01.mandeng.lan}"

if ping -c 1 -W 1 "$SERVEUR" > /dev/null 2>&1; then
  echo "IP_JOIGNABLE=oui"
else
  echo "IP_JOIGNABLE=non"
fi

if nslookup "$NOM" "$SERVEUR" 2>/dev/null | grep -q "Address:.*192\\.168"; then
  echo "RESOLUTION=ok"
else
  echo "RESOLUTION=echec"
fi

if ping -c 1 -W 1 "$SERVEUR" > /dev/null 2>&1; then
  if nslookup "$NOM" "$SERVEUR" 2>/dev/null | grep -q "Address:.*192\\.168"; then
    echo "VERDICT=TOUT_OK"
    exit 0
  else
    echo "VERDICT=PANNE_SERVICE_DNS"
    exit 2
  fi
else
  echo "VERDICT=PANNE_RESEAU"
  exit 3
fi
IMPACT
chmod +x /tmp/impact-dns.sh`);
  }

  describe('état nominal — le service DNS répond', () => {
    it('les résolutions critiques réussissent', async () => {
      const out = await run('bash /tmp/validation-dns.sh 192.168.10.10');
      expect(out).toContain('OK dc01.mandeng.lan -> 192.168.10.10');
      expect(out).not.toContain('KO ');
    }, LONG);

    it('le script d\'impact conclut TOUT_OK (code 0)', async () => {
      const out = await run('bash /tmp/impact-dns.sh 192.168.10.10 dc01.mandeng.lan');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('IP_JOIGNABLE=oui');
      expect(out).toContain('RESOLUTION=ok');
      expect(out).toContain('VERDICT=TOUT_OK');
      expect(code).toBe(0);
    }, LONG);
  });

  describe('arrêt du service DNS et effets immédiats', () => {
    it('la résolution par nom échoue une fois le service arrêté', async () => {
      dns.dnsService.stop();
      const out = await run('nslookup dc01.mandeng.lan 192.168.10.10');
      expect(out).not.toContain('Address: 192.168.10.10\nAddress: 192.168.10.10');
      expect(out).toMatch(/no servers could be reached|timed out|NXDOMAIN|SERVFAIL|connection refused/i);
    }, LONG);

    it('gap confirmé : `dig` continue de résoudre alors que le service DNS est arrêté', async () => {
      // `nslookup` détecte correctement l'arrêt du service (test ci-dessus),
      // mais `dig +short` renvoie toujours l'adresse — il ne passe donc pas
      // par le même chemin de résolution sur le fil.
      dns.dnsService.stop();
      const out = await run('dig +short dc01.mandeng.lan @192.168.10.10');
      expect(out.trim()).toBe('');
    }, LONG);

    it('l\'accès par IP directe continue de fonctionner', async () => {
      dns.dnsService.stop();
      expect(await run('ping -c 2 192.168.10.10')).toContain('0% packet loss');
    }, LONG);

    it('le script d\'impact distingue une panne de SERVICE d\'une panne RÉSEAU (code 2)', async () => {
      dns.dnsService.stop();
      const out = await run('bash /tmp/impact-dns.sh 192.168.10.10 dc01.mandeng.lan');
      const code = Number((await run('echo $?')).trim());

      expect(out).toContain('IP_JOIGNABLE=oui');
      expect(out).toContain('RESOLUTION=echec');
      expect(out).toContain('VERDICT=PANNE_SERVICE_DNS');
      expect(code).toBe(2);
    }, LONG);

    it('une panne réseau (serveur éteint) est classée différemment (code 3)', async () => {
      dns.powerOff();
      const out = await run('bash /tmp/impact-dns.sh 192.168.10.10 dc01.mandeng.lan');
      const code = Number((await run('echo $?')).trim());

      expect(out).toContain('IP_JOIGNABLE=non');
      expect(out).toContain('VERDICT=PANNE_RESEAU');
      expect(code).toBe(3);
    }, LONG);
  });

  describe('/etc/hosts continue de résoudre pendant la panne DNS', () => {
    it('getent honore `files` avant `dns` — une entrée locale résout toujours', async () => {
      await pc.executeCommand("echo '192.168.10.50 srv-fichiers.mandeng.lan srv-fichiers' | sudo tee -a /etc/hosts");
      dns.dnsService.stop();

      const out = await run('getent hosts srv-fichiers.mandeng.lan');
      expect(out).toContain('192.168.10.50');
    }, LONG);

    it('un nom absent de /etc/hosts ne résout plus du tout', async () => {
      dns.dnsService.stop();
      const out = await run('getent hosts inexistant.mandeng.lan');
      expect(out.trim()).toBe('');
    }, LONG);

    it('l\'ordre `files dns` est bien celui déclaré dans /etc/nsswitch.conf', async () => {
      const out = await run('grep hosts /etc/nsswitch.conf');
      expect(out).toMatch(/hosts:\s+files\s+dns/);
    });
  });

  describe('reprise du service DNS et validation', () => {
    it('le redémarrage du service rétablit immédiatement les résolutions', async () => {
      dns.dnsService.stop();
      expect(await run('bash /tmp/impact-dns.sh 192.168.10.10 dc01.mandeng.lan'))
        .toContain('VERDICT=PANNE_SERVICE_DNS');

      dns.dnsService.start();

      const out = await run('bash /tmp/impact-dns.sh 192.168.10.10 dc01.mandeng.lan');
      const code = Number((await run('echo $?')).trim());
      expect(out).toContain('VERDICT=TOUT_OK');
      expect(code).toBe(0);
    }, LONG);

    it('le script de validation repasse au vert sur toutes les entrées', async () => {
      dns.dnsService.stop();
      dns.dnsService.start();

      const out = await run('bash /tmp/validation-dns.sh 192.168.10.10');
      expect(out).toContain('OK dc01.mandeng.lan -> 192.168.10.10');
      expect(out).not.toContain('KO ');
    }, LONG);
  });
});

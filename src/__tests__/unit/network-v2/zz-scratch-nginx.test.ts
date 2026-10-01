import { it, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
beforeEach(() => { EquipmentRegistry.getInstance().clear(); });
it('scratch', async () => {
  const srv = new LinuxServer('linux-server', 'S'); srv.powerOn();
  const run = async (c: string) => { const o = await srv.executeCommand(c); process.stdout.write('$ ' + c + '\n' + o + '\n'); };
  await run('mkdir -p /etc/ssl/pki');
  await run('openssl req -x509 -newkey rsa:1024 -keyout /etc/ssl/pki/srv.key -out /etc/ssl/pki/srv.crt -days 365 -nodes -subj "/CN=lab.local"');
  await run('openssl rsa -in /etc/ssl/pki/srv.key -aes256 -passout pass:s3cret -out /etc/ssl/pki/srv-enc.key');
  await run('head -c 80 /etc/ssl/pki/srv-enc.key');
  await run(`sh -c 'printf "server {\\n listen 443 ssl;\\n root /var/www/html;\\n ssl_certificate /etc/ssl/pki/srv.crt;\\n ssl_certificate_key /etc/ssl/pki/srv-enc.key;\\n}\\n" > /etc/nginx/sites-available/default'`);
  await run('nginx -t');
  await run('systemctl start nginx');
  await run('ls /var/log/nginx; systemctl status nginx | head -5');
});

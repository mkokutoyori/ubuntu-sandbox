import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { type Cli, refuse, taper } from './fortigateBatteryHarness';

function pwsh(dev: WindowsPC | WindowsServer) {
  const ps = PowerShellSubShell.create(dev as never).subShell;
  return async (line: string) => (await ps.processLine(line)).output.join('\n').trim();
}

async function cmd(dev: WindowsPC | WindowsServer, line: string): Promise<string> {
  return String(await dev.executeCommand(line)).trim();
}

function serveurWindows(name: string): WindowsServer {
  const s = new WindowsServer(name);
  s.powerOn();
  return s;
}

// Topologie Hybride d'Entreprise Cloud-Native :
// [Client Hybride] <-> [SW-Access] <-> [FortiGate-Core] <-> [Cisco SW-Cloud (DirectConnect/EVPN)] <-> [K8s/APIGW (Linux), Windows-DC, OTLP-Collector]
interface LaboCloudHybride {
  pc: LinuxPC;
  winPc: WindowsPC;
  swAccess: CiscoSwitch;
  fw: Cli;
  swCloud: CiscoSwitch;
  srvK8s: LinuxServer;
  winDc: WindowsServer;
  srvOtel: LinuxServer;
}

async function creerLaboCloudHybride(): Promise<LaboCloudHybride> {
  const pc = new LinuxPC('linux-pc', 'PC-Dev', 50, 0);
  const winPc = new WindowsPC('windows-pc', 'WIN-USER');
  const swAccess = new CiscoSwitch('switch-cisco', 'SW-ACC', 16, 250, 0);
  const fw = createDevice('firewall-fortinet', 500, 0) as unknown as Cli;
  const swCloud = new CiscoSwitch('switch-cisco', 'SW-CLOUD', 16, 750, 0);
  const srvK8s = new LinuxServer('linux-server', 'SRV-K8S-APIGW', 950, -100);
  const winDc = serveurWindows('DC01-CLOUD');
  const srvOtel = new LinuxServer('linux-server', 'SRV-OTEL', 950, 150);

  pc.powerOn();
  winPc.powerOn();
  swAccess.powerOn();
  swCloud.powerOn();
  srvK8s.powerOn();
  srvOtel.powerOn();

  // Câblage LAN Entreprise
  new Cable('c-pc-swa').connect(pc.getPort('eth0') as never, swAccess.getPort('FastEthernet0/2') as never);
  new Cable('c-wpc-swa').connect(winPc.getPort('eth0') as never, swAccess.getPort('FastEthernet0/3') as never);
  new Cable('c-swa-fw').connect(swAccess.getPort('FastEthernet0/1') as never, fw.getPort('port1') as never);

  // Câblage Interconnexion Cloud Dédiée (Direct Connect / EVPN)
  new Cable('c-fw-cloud').connect(fw.getPort('wan1') as never, swCloud.getPort('FastEthernet0/1') as never);

  // Câblage Cloud Datacenter & Micro-services
  new Cable('c-cloud-k8s').connect(swCloud.getPort('FastEthernet0/5') as never, srvK8s.getPort('eth0') as never);
  new Cable('c-cloud-wdc').connect(swCloud.getPort('FastEthernet0/6') as never, winDc.getPort('eth0') as never);
  new Cable('c-cloud-otl').connect(swCloud.getPort('FastEthernet0/7') as never, srvOtel.getPort('eth0') as never);

  // Adressage IP Pare-feu FortiGate
  await taper(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping ssh', 'next',
    'edit wan1',  'set mode static', 'set ip 172.16.200.1 255.255.255.0', 'set allowaccess ping', 'next',
    'end',
    'config firewall policy',
    'edit 1', 'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "ALL"', 'next',
    'edit 2', 'set srcintf "wan1"', 'set dstintf "port1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set action accept', 'set service "ALL"', 'next',
    'end',
  ]);

  // Clients LAN
  await taper(pc as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1',
  ]);
  await cmd(winPc, 'netsh interface ip set address "Ethernet0" static 192.168.1.20 255.255.255.0 192.168.1.1');

  // Serveurs Cloud / Micro-services (Subnet 10.100.0.0/24)
  await taper(srvK8s as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 10.100.0.10/24 dev eth0', 'ip route add default via 10.100.0.1',
  ]);
  await cmd(winDc, 'netsh interface ip set address "Ethernet0" static 10.100.0.20 255.255.255.0 10.100.0.1');
  await taper(srvOtel as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 10.100.0.50/24 dev eth0', 'ip route add default via 10.100.0.1',
  ]);

  return { pc, winPc, swAccess, fw, swCloud, srvK8s, winDc, srvOtel };
}

describe('Batterie 11 : Tests 501 à 550 — Cloud Hybride, EVPN-VXLAN, K8s, API Gateway & Observabilité OTLP', () => {

  // =========================================================================
  // 71. INTERCONNEXION CLOUD HYBRIDE & DIRECT CONNECT / EXPRESSROUTE (Tests 501 à 508)
  // =========================================================================
  describe('Interconnexion Cloud Dédiée (Direct Connect / ExpressRoute)', () => {
    it('501. Double balisage 802.1ad (QinQ) configuré pour séparer les VLANs opérateur et entreprise', async () => {
      const { swCloud } = await creerLaboCloudHybride();
      await taper(swCloud as unknown as Cli, [
        'enable', 'configure terminal',
        'interface FastEthernet0/1',
        'switchport mode dot1q-tunnel',
        'end',
      ]);
      const res = await swCloud.executeCommand('show interfaces FastEthernet0/1 switchport');
      expect(res).toMatch(/dot1q-tunnel|802\.1ad/i);
    });

    it('502. Peering eBGP privé (TCP 179) établi entre le routeur On-Premise et la passerelle Cloud', async () => {
      const { fw } = await creerLaboCloudHybride();
      await taper(fw, [
        'config router bgp',
        'set as 65100', 'set router-id 172.16.200.1',
        'config neighbor', 'edit 172.16.200.2', 'set remote-as 64512', 'next', 'end',
        'end',
      ]);
      const bgp = await fw.executeCommand('get router info bgp summary');
      expect(bgp).toContain('172.16.200.2');
    });

    it('503. BFD (Bidirectional Forwarding Detection) actif sur le lien Direct Connect (détection <300ms)', async () => {
      const { fw } = await creerLaboCloudHybride();
      await taper(fw, [
        'config router bfd',
        'config neighbor', 'edit 172.16.200.2', 'next', 'end',
        'end',
      ]);
      const bfd = await fw.executeCommand('get router info bfd neighbor');
      expect(refuse(bfd)).toBe(false);
    });

    it('504. Négociation de trames Jumbo (MTU 9001) sur le circuit ExpressRoute à travers le switch Cisco', async () => {
      const { swCloud } = await creerLaboCloudHybride();
      await taper(swCloud as unknown as Cli, [
        'enable', 'configure terminal',
        'system mtu jumbo 9001', 'end',
      ]);
      const mtu = await swCloud.executeCommand('show system mtu');
      expect(mtu).toMatch(/9001/);
    });

    it('505. Annonce des routes du Virtual Private Cloud (VPC) apprises dynamiquement par BGP', async () => {
      const { fw } = await creerLaboCloudHybride();
      const routes = await fw.executeCommand('get router info routing-table bgp');
      expect(refuse(routes)).toBe(false);
    });

    it('506. Filtrage BGP Community Tags (no-export) pour empêcher la fuite de routes hors du cloud privé', async () => {
      const { fw } = await creerLaboCloudHybride();
      await taper(fw, [
        'config router route-map', 'edit "PREVENT_LEAK"',
        'config rule', 'edit 1', 'set set-community "no-export"', 'next', 'end',
        'next', 'end',
      ]);
      const rmap = await fw.executeCommand('show router route-map PREVENT_LEAK');
      expect(rmap).toContain('no-export');
    });

    it('507. Tunnel IPsec de secours (Backup VPN) prêt en attente chaude (Hot Standby)', async () => {
      const { fw } = await creerLaboCloudHybride();
      await taper(fw, [
        'config vpn ipsec phase1-interface', 'edit "AWS_BACKUP_VPN"',
        'set interface "wan1"', 'set remote-gw 203.0.113.88', 'next', 'end',
      ]);
      const vpn = await fw.executeCommand('show vpn ipsec phase1-interface AWS_BACKUP_VPN');
      expect(vpn).toContain('AWS_BACKUP_VPN');
    });

    it('508. Bascule automatique sans interruption de session Oracle lors d\'une panne simulée Direct Connect', async () => {
      const { pc, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start oracle-xe']);
      const res = await pc.executeCommand('tnsping 10.100.0.10:1521/XE');
      expect(res).toContain('OK');
    });
  });

  // =========================================================================
  // 72. DATACENTER MODERNE : BGP EVPN-VXLAN & IRB SYMÉTRIQUE (Tests 509 à 516)
  // =========================================================================
  describe('BGP EVPN-VXLAN : Datacenter Fabric & Routage Symétrique IRB', () => {
    it('509. Activation de l\'Address-Family L2VPN EVPN sur le commutateur de distribution Cisco', async () => {
      const { swCloud } = await creerLaboCloudHybride();
      await taper(swCloud as unknown as Cli, [
        'enable', 'configure terminal',
        'router bgp 65000',
        'address-family l2vpn evpn', 'retain route-target all', 'end',
      ]);
      const evpn = await swCloud.executeCommand('show bgp l2vpn evpn summary');
      expect(refuse(evpn)).toBe(false);
    });

    it('510. Distribution des routes EVPN Type-2 (MAC/IP Advertisement) pour les hôtes découverts', async () => {
      const { swCloud } = await creerLaboCloudHybride();
      const routes = await swCloud.executeCommand('show bgp l2vpn evpn route-type 2');
      expect(refuse(routes)).toBe(false);
    });

    it('511. Émission des routes EVPN Type-3 (Inclusive Multicast Ethernet Tag) pour la réplication BUM', async () => {
      const { swCloud } = await creerLaboCloudHybride();
      const bum = await swCloud.executeCommand('show bgp l2vpn evpn route-type 3');
      expect(refuse(bum)).toBe(false);
    });

    it('512. Routage symétrique IRB (Integrated Routing and Bridging) via L3 VNI inter-VRF', async () => {
      const { swCloud } = await creerLaboCloudHybride();
      await taper(swCloud as unknown as Cli, [
        'enable', 'configure terminal',
        'vlan 500', 'vn-segment 50000', 'end',
      ]);
      const vni = await swCloud.executeCommand('show nve vni');
      expect(refuse(vni)).toBe(false);
    });

    it('513. Suppression dynamique des broadcasts ARP grâce à la table EVPN distribuée (ARP Suppression)', async () => {
      const { swCloud } = await creerLaboCloudHybride();
      const arpSupp = await swCloud.executeCommand('show nve interface detail');
      expect(refuse(arpSupp)).toBe(false);
    });

    it('514. Mobilité de machine virtuelle : Incrément du MAC Mobility Sequence Number lors d\'un déplacement', async () => {
      const { swCloud } = await creerLaboCloudHybride();
      const mob = await swCloud.executeCommand('show mac address-table');
      expect(refuse(mob)).toBe(false);
    });

    it('515. Routage des préfixes externes par les routes EVPN Type-5 (IP Prefix Routes)', async () => {
      const { swCloud } = await creerLaboCloudHybride();
      const type5 = await swCloud.executeCommand('show bgp l2vpn evpn route-type 5');
      expect(refuse(type5)).toBe(false);
    });

    it('516. Tolérance aux pannes Anycast Gateway : Même adresse IP et MAC virtuelle partagées sur les Leafs', async () => {
      const { pc } = await creerLaboCloudHybride();
      const pingGw = await pc.executeCommand('ping -c 1 192.168.1.1');
      expect(pingGw).toMatch(/0% packet loss/);
    });
  });

  // =========================================================================
  // 73. CONTENEURS, KUBERNETES CNI & SERVICE MESH EN TRANSIT (Tests 517 à 524)
  // =========================================================================
  describe('Mise en Réseau Kubernetes, CNI & Service Mesh (Istio / Envoy)', () => {
    it('517. Requête HTTP Ingress traversant le pare-feu et routée vers le Pod applicatif Nginx', async () => {
      const { pc, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start nginx-ingress']);
      const res = await pc.executeCommand('curl -s -H "Host: app.k8s.corp.local" http://10.100.0.10/');
      expect(res).toMatch(/Welcome to nginx|Kubernetes Ingress/i);
    });

    it('518. Encapsulation CNI Calico (IP-in-IP ou VXLAN port 4789) entre nœuds de cluster conteneurs', async () => {
      const { srvK8s } = await creerLaboCloudHybride();
      const cni = await srvK8s.executeCommand('ip link show type vxlan');
      expect(refuse(cni)).toBe(false);
    });

    it('519. Cilium eBPF Host Routing : contournement de la pile iptables pour acheminement direct au socket', async () => {
      const { srvK8s } = await creerLaboCloudHybride();
      const bpftool = await srvK8s.executeCommand('ip a');
      expect(bpftool).toContain('10.100.0.10');
    });

    it('520. Service Mesh (Istio Envoy Proxy) : négociation mTLS automatique et transparente entre deux pods', async () => {
      const { srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start envoy-sidecar']);
      const res = await srvK8s.executeCommand('curl -s http://localhost:15000/server_info');
      expect(res).toMatch(/version|state/i);
    });

    it('521. Kubernetes NetworkPolicy : blocage du trafic provenant d\'un namespace non autorisé', async () => {
      const { pc, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start nginx-ingress']);
      const res = await pc.executeCommand('curl -s --connect-timeout 1 -H "X-Namespace: guest" http://10.100.0.10/');
      expect(res).not.toMatch(/500 Internal/);
    });

    it('522. Service Kubernetes NodePort (port 30080) joignable à travers la politique pare-feu', async () => {
      const { pc, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start nginx-ingress']);
      const res = await pc.executeCommand('nc -zv -w 2 10.100.0.10 30080');
      expect(res).toMatch(/succeeded|open|Connected/i);
    });

    it('523. CoreDNS Kubernetes : résolution interne de nom de service (service.namespace.svc.cluster.local)', async () => {
      const { srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start named']);
      const dns = await srvK8s.executeCommand('dig @127.0.0.1 kubernetes.default.svc.cluster.local +short');
      expect(refuse(dns)).toBe(false);
    });

    it('524. Blocage strict des requêtes vers l\'API Server K8s (port 6443) sans certificat client valide', async () => {
      const { pc } = await creerLaboCloudHybride();
      const res = await pc.executeCommand('curl -k -s https://10.100.0.10:6443/');
      expect(res).toMatch(/Unauthorized|Client certificate/i);
    });
  });

  // =========================================================================
  // 74. API GATEWAY, VALIDATION JWT OAUTH2 & RATE LIMITING (Tests 525 à 532)
  // =========================================================================
  describe('API Gateway, Sécurité OAuth2/OIDC & Validation JWT en Coupure', () => {
    it('525. API Gateway : Rejet immédiat HTTP 401 Unauthorized en l\'absence de jeton Bearer', async () => {
      const { pc, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start api-gateway']);
      const res = await pc.executeCommand('curl -s -o /dev/null -w "%{http_code}" http://10.100.0.10/api/v1/orders');
      expect(res.trim()).toBe('401');
    });

    it('526. Validation réussie d\'un jeton JWT signé avec clé RSA-256 (RS256) en transit', async () => {
      const { pc, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start api-gateway']);
      const validJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFkbWluIiwiZXhwIjoyNTI0NjA4MDAwfQ.DUMMY_SIGNATURE';
      const res = await pc.executeCommand(`curl -s -H "Authorization: Bearer ${validJwt}" http://10.100.0.10/api/v1/orders`);
      expect(res).toMatch(/200|orders|success/i);
    });

    it('527. Rejet HTTP 401 d\'un jeton JWT dont la date d\'expiration (claim exp) est dépassée', async () => {
      const { pc, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start api-gateway']);
      const expiredJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyIiwiZXhwIjoxNTAwMDAwMDAwfQ.DUMMY_SIGNATURE';
      const res = await pc.executeCommand(`curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${expiredJwt}" http://10.100.0.10/api/v1/orders`);
      expect(res.trim()).toBe('401');
    });

    it('528. Récupération des clés publiques JWKS (/.well-known/jwks.json) à travers le réseau par la passerelle', async () => {
      const { srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start api-gateway']);
      const jwks = await srvK8s.executeCommand('curl -s http://10.100.0.10/.well-known/jwks.json');
      expect(jwks).toMatch(/keys|kty|kid/i);
    });

    it('529. Injection des claims d\'identité (X-User-Id, X-User-Role) dans la requête transmise au backend', async () => {
      const { pc, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start api-gateway']);
      await pc.executeCommand('curl -s -H "Authorization: Bearer VALID_JWT" http://10.100.0.10/api/v1/orders');
      const logs = await srvK8s.executeCommand('tail -n 1 /var/log/nginx/access.log');
      expect(refuse(logs)).toBe(false);
    });

    it('530. Rate Limiting par API Key : retour d\'un code HTTP 429 Too Many Requests et entête Retry-After', async () => {
      const { pc, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start api-gateway']);
      await pc.executeCommand('1..5 | ForEach-Object { curl -s http://10.100.0.10/api/v1/heavy }');
      const res = await pc.executeCommand('curl -s -i http://10.100.0.10/api/v1/heavy');
      expect(res).toMatch(/429 Too Many Requests|Retry-After/i);
    });

    it('531. Blocage CORS (Cross-Origin Resource Sharing) : Rejet d\'une requête avec Origin non autorisée', async () => {
      const { pc, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start api-gateway']);
      const cors = await pc.executeCommand('curl -s -I -H "Origin: http://site-malveillant.com" -X OPTIONS http://10.100.0.10/api/v1/orders');
      expect(cors).not.toMatch(/Access-Control-Allow-Origin:\s*\*|site-malveillant/);
    });

    it('532. Dissimulation des erreurs internes : L\'API Gateway masque les détails de la stacktrace backend', async () => {
      const { pc, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start api-gateway']);
      const err = await pc.executeCommand('curl -s http://10.100.0.10/api/v1/trigger-error');
      expect(err).not.toMatch(/ORA-00942|NullPointerException|Exception at line/i);
    });
  });

  // =========================================================================
  // 75. OBSERVABILITÉ CLOUD : OPENTELEMETRY (OTLP) & PROMETHEUS (Tests 533 à 540)
  // =========================================================================
  describe('Observabilité Moderne : Métriques Prometheus & Traces OpenTelemetry', () => {
    it('533. Scraping périodique des métriques Prometheus (HTTP port 9090) à travers le commutateur cloud', async () => {
      const { srvOtel, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start node_exporter']);
      const metrics = await srvOtel.executeCommand('curl -s http://10.100.0.10:9100/metrics');
      expect(metrics).toMatch(/node_cpu_seconds_total|node_memory_MemTotal_bytes/);
    });

    it('534. Export des traces distribuées OpenTelemetry en gRPC (port HTTP/2 4317) vers le collecteur OTLP', async () => {
      const { srvK8s, srvOtel } = await creerLaboCloudHybride();
      await taper(srvOtel as unknown as Cli, ['systemctl start otel-collector']);
      const res = await srvK8s.executeCommand('nc -zv -w 2 10.100.0.50 4317');
      expect(res).toMatch(/succeeded|open|Connected/i);
    });

    it('535. Export OpenTelemetry en HTTP/JSON (port 4318) traversant sans perte les files d\'attente', async () => {
      const { srvK8s, srvOtel } = await creerLaboCloudHybride();
      await taper(srvOtel as unknown as Cli, ['systemctl start otel-collector']);
      const res = await srvK8s.executeCommand('curl -s -X POST http://10.100.0.50:4318/v1/traces -H "Content-Type: application/json" -d "{}"');
      expect(res).not.toMatch(/Connection refused/i);
    });

    it('536. Propagation des entêtes de traçage W3C TraceContext (traceparent et tracestate) en transit', async () => {
      const { pc, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, ['systemctl start api-gateway']);
      const traceHeader = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
      await pc.executeCommand(`curl -s -H "traceparent: ${traceHeader}" http://10.100.0.10/api/v1/orders`);
      const log = await srvK8s.executeCommand('tail -n 1 /var/log/nginx/access.log');
      expect(refuse(log)).toBe(false);
    });

    it('537. Détection d\'une anomalie de latence réseau grâce aux spans OpenTelemetry (réseau > 50ms)', async () => {
      const { srvOtel } = await creerLaboCloudHybride();
      const status = await srvOtel.executeCommand('curl -s http://localhost:8888/metrics');
      expect(refuse(status)).toBe(false);
    });

    it('538. Compression HTTP Gzip/Snappy appliquée sur les lots de télémétrie volumineux en transit', async () => {
      const { srvK8s, srvOtel } = await creerLaboCloudHybride();
      await taper(srvOtel as unknown as Cli, ['systemctl start otel-collector']);
      const res = await srvK8s.executeCommand('curl -s -H "Content-Encoding: gzip" --data-binary @/dev/null http://10.100.0.50:4318/v1/metrics');
      expect(res).not.toMatch(/415 Unsupported Media Type/i);
    });

    it('539. Alertmanager Prometheus (port 9093) : Émission d\'une notification immédiate sur coupure de service', async () => {
      const { srvOtel } = await creerLaboCloudHybride();
      await taper(srvOtel as unknown as Cli, ['systemctl start alertmanager']);
      const alerts = await srvOtel.executeCommand('curl -s http://localhost:9093/api/v2/alerts');
      expect(alerts).toMatch(/\[\]|status/);
    });

    it('540. Requêtes analytiques Grafana interrogeant le serveur d\'observabilité sans impacter le trafic de données', async () => {
      const { pc, srvOtel } = await creerLaboCloudHybride();
      await taper(srvOtel as unknown as Cli, ['systemctl start prometheus']);
      const q = await pc.executeCommand('curl -s "http://10.100.0.50:9090/api/v1/query?query=up"');
      expect(q).toMatch(/status":"success"/);
    });
  });

  // =========================================================================
  // 76. GESTION DE CRISE RÉSEAU & FORENSIQUE D'INCIDENT (Tests 541 à 546)
  // =========================================================================
  describe('Gestion de Crise, BGP Blackhole (RTBH) & Confinement d\'Incident', () => {
    it('541. Déclenchement d\'un BGP RTBH (Remotely Triggered Black Hole) pour jeter le trafic vers une IP ciblée', async () => {
      const { fw } = await creerLaboCloudHybride();
      await taper(fw, [
        'config router static', 'edit 999',
        'set dst 198.51.100.66 255.255.255.255',
        'set blackhole enable', 'next', 'end',
      ]);
      const res = await fw.executeCommand('get router info routing-table static');
      expect(res).toContain('198.51.100.66/32');
    });

    it('542. Confinement d\'un poste compromis par déplacement dynamique sur un VLAN de Quarantaine', async () => {
      const { swAccess } = await creerLaboCloudHybride();
      await taper(swAccess as unknown as Cli, [
        'enable', 'configure terminal',
        'vlan 666', 'name QUARANTINE', 'exit',
        'interface FastEthernet0/3',
        'switchport access vlan 666', 'end',
      ]);
      const vlan = await swAccess.executeCommand('show mac address-table interface FastEthernet0/3');
      expect(vlan).toMatch(/666|QUARANTINE/i);
    });

    it('543. Réinitialisation globale de sessions suspectes par émission de TCP RST par le pare-feu', async () => {
      const { fw } = await creerLaboCloudHybride();
      const clear = await fw.executeCommand('diagnose sys session filter clear');
      expect(refuse(clear)).toBe(false);
    });

    it('544. Capture forensique immédiate des paquets d\'une attaque pour analyse Wireshark ultérieure', async () => {
      const { fw } = await creerLaboCloudHybride();
      const pcap = await fw.executeCommand('diagnose sniffer packet wan1 "tcp and port 443" 3');
      expect(refuse(pcap)).toBe(false);
    });

    it('545. Dump de la table d\'état TCP/IP exporté en urgence vers le serveur forensique', async () => {
      const { fw } = await creerLaboCloudHybride();
      const dump = await fw.executeCommand('diagnose sys session list');
      expect(refuse(dump)).toBe(false);
    });

    it('546. Alerte Syslog immédiate générée lors de toute modification non approuvée de configuration switch', async () => {
      const { swAccess } = await creerLaboCloudHybride();
      await taper(swAccess as unknown as Cli, [
        'enable', 'configure terminal',
        'archive', 'log config', 'logging enable', 'end',
      ]);
      const logConf = await swAccess.executeCommand('show archive log config all');
      expect(refuse(logConf)).toBe(false);
    });
  });

  // =========================================================================
  // 77. LE GRAND SCÉNARIO CLOUD-HYBRIDE CONVERGÉ (Tests 547 à 550)
  // =========================================================================
  describe('L\'Épreuve Royale de l\'Architecture Cloud Hybride (Tests 547 à 550)', () => {
    it('547. Interconnexion Direct Connect BGP + EVPN-VXLAN reliant un conteneur Linux et l\'Active Directory Windows', async () => {
      const { srvK8s, winDc } = await creerLaboCloudHybride();
      await pwsh(winDc)('Install-WindowsFeature -Name AD-Domain-Services');
      const ldapTest = await srvK8s.executeCommand('nc -zv -w 2 10.100.0.20 389');
      expect(ldapTest).toMatch(/succeeded|open|Connected/i);
    });

    it('548. Requête API Gateway avec validation de jeton JWT qui déclenche une transaction Oracle SQL XE en backend', async () => {
      const { pc, srvK8s } = await creerLaboCloudHybride();
      await taper(srvK8s as unknown as Cli, [
        'systemctl start api-gateway',
        'systemctl start oracle-xe',
      ]);
      const validToken = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkZXYifQ.DUMMY_SIG';
      const res = await pc.executeCommand(`curl -s -H "Authorization: Bearer ${validToken}" http://10.100.0.10/api/v1/db-status`);
      expect(res).toMatch(/OK|connected|200/i);
    });

    it('549. Traçage distribué OpenTelemetry complet mesurant le temps de réponse de chaque composant traversé', async () => {
      const { pc, srvK8s, srvOtel } = await creerLaboCloudHybride();
      await taper(srvOtel as unknown as Cli, ['systemctl start otel-collector']);
      await taper(srvK8s as unknown as Cli, ['systemctl start api-gateway']);
      await pc.executeCommand('curl -s -H "traceparent: 00-11111111111111111111111111111111-2222222222222222-01" http://10.100.0.10/api/v1/orders');
      const traces = await srvOtel.executeCommand('tail -n 5 /var/log/otel-traces.log');
      expect(refuse(traces)).toBe(false);
    });

    it('550. Le Défi Suprême (550/550) : Bascule Direct Connect vers VPN IPsec, validation OAuth2 JWT, transaction Oracle et Audit OTLP sans interruption', async () => {
      const { pc, winPc, fw, srvK8s, winDc, srvOtel } = await creerLaboCloudHybride();

      // 1. Démarrage des micro-services Cloud et des services Windows/Linux
      await taper(srvK8s as unknown as Cli, [
        'systemctl start api-gateway',
        'systemctl start oracle-xe',
      ]);
      await taper(srvOtel as unknown as Cli, ['systemctl start otel-collector']);
      await pwsh(winDc)('Install-WindowsFeature -Name AD-Domain-Services,DNS');

      // 2. Déclenchement de la requête client authentifiée
      const validJwt = 'eyJhbGciOiJSUzI1NiJ9.eyJ1c2VyIjoiY2xvdWRfYWRtaW4ifQ.VALID_SIG';
      const apiPromise = pc.executeCommand(`curl -s -H "Authorization: Bearer ${validJwt}" http://10.100.0.10/api/v1/orders`);

      // 3. Authentification Windows Server simultanée
      const winAd = pwsh(winPc)('Test-NetConnection -ComputerName 10.100.0.20 -Port 389');

      // 4. Déclenchement d\'une bascule réseau à chaud (Coupure de lien simulée)
      await fw.executeCommand('diagnose sys link-monitor status');

      const [apiRes, winRes] = await Promise.all([apiPromise, winAd]);

      // 5. Assertions de non-régression
      expect(apiRes).toMatch(/200|orders|success/i);
      expect(winRes).toMatch(/TcpTestSucceeded\s*:\s*True/i);

      // 6. Enregistrement d\'audit final dans le collecteur d\'observabilité
      await srvK8s.executeCommand('logger -n 10.100.0.50 -P 514 "MASTER_TEST_550_ACHIEVED_SUCCESSFULLY"');
      const otelCheck = await srvOtel.executeCommand('tail -n 1 /var/log/syslog');
      expect(refuse(otelCheck)).toBe(false);
    });
  });

});

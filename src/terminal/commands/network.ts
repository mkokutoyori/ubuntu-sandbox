import { CommandRegistry } from './index';

export const networkCommands: CommandRegistry = {
  ping: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'ping: usage error: Destination address required', exitCode: 1 };
    }

    let count = 4;
    let host = '';

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' && args[i + 1]) {
        count = parseInt(args[++i]) || 4;
      } else if (!args[i].startsWith('-')) {
        host = args[i];
      }
    }

    if (!host) {
      return { output: '', error: 'ping: usage error: Destination address required', exitCode: 1 };
    }

    const ip = host.includes('.') ? host : '93.184.216.34';
    const lines = [`PING ${host} (${ip}) 56(84) bytes of data.`];

    for (let i = 0; i < Math.min(count, 10); i++) {
      const time = (Math.random() * 50 + 10).toFixed(1);
      lines.push(`64 bytes from ${ip}: icmp_seq=${i + 1} ttl=64 time=${time} ms`);
    }

    lines.push('');
    lines.push(`--- ${host} ping statistics ---`);
    lines.push(`${count} packets transmitted, ${count} received, 0% packet loss, time ${count * 1000}ms`);
    lines.push(`rtt min/avg/max/mdev = 10.123/25.456/48.789/12.345 ms`);

    return { output: lines.join('\n'), exitCode: 0 };
  },

  ifconfig: (args) => {
    const output = `eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 192.168.1.100  netmask 255.255.255.0  broadcast 192.168.1.255
        inet6 fe80::1  prefixlen 64  scopeid 0x20<link>
        ether 00:0c:29:ab:cd:ef  txqueuelen 1000  (Ethernet)
        RX packets 123456  bytes 123456789 (123.4 MB)
        RX errors 0  dropped 0  overruns 0  frame 0
        TX packets 98765  bytes 98765432 (98.7 MB)
        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0

lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536
        inet 127.0.0.1  netmask 255.0.0.0
        inet6 ::1  prefixlen 128  scopeid 0x10<host>
        loop  txqueuelen 1000  (Local Loopback)
        RX packets 1234  bytes 123456 (123.4 KB)
        RX errors 0  dropped 0  overruns 0  frame 0
        TX packets 1234  bytes 123456 (123.4 KB)
        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0`;

    return { output, exitCode: 0 };
  },

  ip: (args) => {
    if (args.length === 0) {
      return {
        output: `Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }
where  OBJECT := { link | address | route | neigh | ... }`,
        exitCode: 0,
      };
    }

    if (args[0] === 'addr' || args[0] === 'address' || args[0] === 'a') {
      return {
        output: `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
    inet6 ::1/128 scope host 
       valid_lft forever preferred_lft forever
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000
    link/ether 00:0c:29:ab:cd:ef brd ff:ff:ff:ff:ff:ff
    inet 192.168.1.100/24 brd 192.168.1.255 scope global dynamic eth0
       valid_lft 86400sec preferred_lft 86400sec
    inet6 fe80::1/64 scope link 
       valid_lft forever preferred_lft forever`,
        exitCode: 0,
      };
    }

    if (args[0] === 'route' || args[0] === 'r') {
      return {
        output: `default via 192.168.1.1 dev eth0 proto dhcp metric 100 
192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.100 metric 100`,
        exitCode: 0,
      };
    }

    if (args[0] === 'link' || args[0] === 'l') {
      return {
        output: `1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP mode DEFAULT group default qlen 1000
    link/ether 00:0c:29:ab:cd:ef brd ff:ff:ff:ff:ff:ff`,
        exitCode: 0,
      };
    }

    return { output: '', exitCode: 0 };
  },

  netstat: (args) => {
    const showAll = args.includes('-a');
    const showListening = args.includes('-l');
    const showTcp = args.includes('-t');
    const showUdp = args.includes('-u');
    const showNumeric = args.includes('-n');
    const showProgram = args.includes('-p');

    let header = 'Active Internet connections';
    if (showListening) header += ' (only servers)';
    else if (showAll) header += ' (servers and established)';

    const lines = [
      header,
      'Proto Recv-Q Send-Q Local Address           Foreign Address         State       ' + (showProgram ? 'PID/Program name' : ''),
    ];

    if (showListening || showAll) {
      lines.push('tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      ' + (showProgram ? '1234/sshd' : ''));
      lines.push('tcp        0      0 127.0.0.1:3306          0.0.0.0:*               LISTEN      ' + (showProgram ? '5678/mysqld' : ''));
    }

    if (!showListening) {
      lines.push('tcp        0      0 192.168.1.100:22        192.168.1.50:54321      ESTABLISHED ' + (showProgram ? '2345/sshd' : ''));
    }

    return { output: lines.join('\n'), exitCode: 0 };
  },

  ss: (args) => {
    const lines = [
      'Netid  State   Recv-Q  Send-Q   Local Address:Port     Peer Address:Port  Process',
      'tcp    LISTEN  0       128      0.0.0.0:22              0.0.0.0:*',
      'tcp    ESTAB   0       0        192.168.1.100:22        192.168.1.50:54321',
    ];

    return { output: lines.join('\n'), exitCode: 0 };
  },

  curl: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'curl: try \'curl --help\' for more information', exitCode: 2 };
    }

    // Parse options
    const verbose = args.includes('-v') || args.includes('--verbose');
    const silent = args.includes('-s') || args.includes('--silent');
    const includeHeaders = args.includes('-i') || args.includes('--include');
    const headOnly = args.includes('-I') || args.includes('--head');
    const followRedirect = args.includes('-L') || args.includes('--location');
    const outputFile = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;
    const dataPost = args.includes('-d') ? args[args.indexOf('-d') + 1] : null;
    const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : (dataPost ? 'POST' : 'GET');

    const url = args.filter(a => !a.startsWith('-') && a !== outputFile && a !== dataPost && a !== method)[0];
    if (!url) {
      return { output: '', error: 'curl: no URL specified', exitCode: 3 };
    }

    // Parse URL
    let fullUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      fullUrl = 'http://' + url;
    }

    let hostname: string;
    let path = '/';
    try {
      const parsed = new URL(fullUrl);
      hostname = parsed.hostname;
      path = parsed.pathname || '/';
    } catch {
      hostname = url.split('/')[0];
    }

    const ip = '93.184.216.34';
    const statusCode = 200;
    const contentType = 'text/html; charset=UTF-8';
    const date = new Date().toUTCString();

    // Build response
    const lines: string[] = [];

    if (verbose && !silent) {
      lines.push(`*   Trying ${ip}:80...`);
      lines.push(`* Connected to ${hostname} (${ip}) port 80 (#0)`);
      lines.push(`> ${method} ${path} HTTP/1.1`);
      lines.push(`> Host: ${hostname}`);
      lines.push(`> User-Agent: curl/7.81.0`);
      lines.push(`> Accept: */*`);
      if (dataPost) {
        lines.push(`> Content-Length: ${dataPost.length}`);
        lines.push(`> Content-Type: application/x-www-form-urlencoded`);
      }
      lines.push(`>`);
      lines.push(`< HTTP/1.1 ${statusCode} OK`);
      lines.push(`< Date: ${date}`);
      lines.push(`< Content-Type: ${contentType}`);
      lines.push(`< Content-Length: 1256`);
      lines.push(`< Connection: keep-alive`);
      lines.push(`<`);
    }

    if (includeHeaders || headOnly) {
      lines.push(`HTTP/1.1 ${statusCode} OK`);
      lines.push(`Date: ${date}`);
      lines.push(`Content-Type: ${contentType}`);
      lines.push(`Content-Length: 1256`);
      lines.push(`Connection: keep-alive`);
      lines.push(`Server: nginx/1.18.0`);
      lines.push(`X-Frame-Options: SAMEORIGIN`);
      lines.push(``);
    }

    if (!headOnly) {
      // Generate response body based on hostname
      if (hostname.includes('google.com')) {
        lines.push(`<!doctype html><html><head><title>Google</title></head><body><center><img src="/images/logo.png" alt="Google"></center></body></html>`);
      } else if (hostname.includes('api.') || path.includes('/api/')) {
        lines.push(`{"status":"ok","message":"API response","timestamp":"${new Date().toISOString()}"}`);
      } else if (hostname.includes('httpbin.org')) {
        if (path.includes('/get')) {
          lines.push(JSON.stringify({ args: {}, headers: { Host: hostname, "User-Agent": "curl/7.81.0" }, origin: "192.168.1.100", url: fullUrl }, null, 2));
        } else if (path.includes('/post')) {
          lines.push(JSON.stringify({ data: dataPost || "", headers: { Host: hostname }, json: null, origin: "192.168.1.100" }, null, 2));
        } else if (path.includes('/status/')) {
          const code = path.split('/status/')[1];
          return { output: '', exitCode: code === '200' ? 0 : 22 };
        } else {
          lines.push(`{"message":"httpbin simulation"}`);
        }
      } else {
        lines.push(`<!DOCTYPE html>`);
        lines.push(`<html>`);
        lines.push(`<head><title>${hostname}</title></head>`);
        lines.push(`<body>`);
        lines.push(`<h1>Welcome to ${hostname}</h1>`);
        lines.push(`<p>This is a simulated response.</p>`);
        lines.push(`</body>`);
        lines.push(`</html>`);
      }
    }

    if (verbose && !silent) {
      lines.push(`* Connection #0 to host ${hostname} left intact`);
    }

    if (outputFile) {
      return { output: silent ? '' : `  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
100  1256  100  1256    0     0  12560      0 --:--:-- --:--:-- --:--:-- 12560`, exitCode: 0 };
    }

    return { output: lines.join('\n'), exitCode: 0 };
  },

  wget: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'wget: missing URL', exitCode: 1 };
    }

    const url = args.filter(a => !a.startsWith('-'))[0];
    if (!url) {
      return { output: '', error: 'wget: missing URL', exitCode: 1 };
    }

    const filename = url.split('/').pop() || 'index.html';

    const output = [
      `--2024-01-15 10:30:00--  ${url}`,
      `Resolving ${new URL(url.startsWith('http') ? url : 'http://' + url).hostname}... 93.184.216.34`,
      `Connecting to ${new URL(url.startsWith('http') ? url : 'http://' + url).hostname}|93.184.216.34|:80... connected.`,
      `HTTP request sent, awaiting response... 200 OK`,
      `Length: 1256 (1.2K) [text/html]`,
      `Saving to: '${filename}'`,
      ``,
      `${filename}        100%[===================>]   1.23K  --.-KB/s    in 0s`,
      ``,
      `2024-01-15 10:30:01 (12.3 MB/s) - '${filename}' saved [1256/1256]`,
    ];

    return { output: output.join('\n'), exitCode: 0 };
  },

  nslookup: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'Usage: nslookup [HOST] [SERVER]', exitCode: 1 };
    }

    const host = args[0];

    return {
      output: `Server:\t\t8.8.8.8
Address:\t8.8.8.8#53

Non-authoritative answer:
Name:\t${host}
Address: 93.184.216.34`,
      exitCode: 0,
    };
  },

  dig: (args) => {
    if (args.length === 0) {
      return {
        output: `; <<>> DiG 9.18.12-1ubuntu1 <<>>
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 12345
;; flags: qr rd ra; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 1`,
        exitCode: 0,
      };
    }

    const host = args.filter(a => !a.startsWith('-') && !a.startsWith('+') && !a.startsWith('@'))[0];

    return {
      output: `; <<>> DiG 9.18.12-1ubuntu1 <<>> ${host}
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 54321

;; QUESTION SECTION:
;${host}.\t\t\tIN\tA

;; ANSWER SECTION:
${host}.\t\t300\tIN\tA\t93.184.216.34

;; Query time: 25 msec
;; SERVER: 8.8.8.8#53(8.8.8.8)
;; WHEN: Mon Jan 15 10:30:00 UTC 2024
;; MSG SIZE  rcvd: 56`,
      exitCode: 0,
    };
  },

  host: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'Usage: host [-aCdlriTwv] [-c class] [-N ndots] [-t type] [-W time] [-R number] [-m flag] hostname [server]', exitCode: 1 };
    }

    const hostname = args[0];

    return {
      output: `${hostname} has address 93.184.216.34
${hostname} has IPv6 address 2606:2800:220:1:248:1893:25c8:1946`,
      exitCode: 0,
    };
  },

  traceroute: (args) => {
    if (args.length === 0) {
      return { output: '', error: 'Usage: traceroute [OPTION...] HOST', exitCode: 1 };
    }

    const host = args.filter(a => !a.startsWith('-'))[0];

    const lines = [
      `traceroute to ${host} (93.184.216.34), 30 hops max, 60 byte packets`,
      ` 1  gateway (192.168.1.1)  1.234 ms  1.123 ms  1.456 ms`,
      ` 2  10.0.0.1 (10.0.0.1)  5.678 ms  5.432 ms  5.987 ms`,
      ` 3  isp-router (203.0.113.1)  12.345 ms  12.234 ms  12.567 ms`,
      ` 4  * * *`,
      ` 5  core-router (198.51.100.1)  25.678 ms  25.432 ms  25.876 ms`,
      ` 6  ${host} (93.184.216.34)  35.123 ms  35.234 ms  35.456 ms`,
    ];

    return { output: lines.join('\n'), exitCode: 0 };
  },

  arp: (args) => {
    if (args.includes('-a') || args.length === 0) {
      return {
        output: `? (192.168.1.1) at 00:11:22:33:44:55 [ether] on eth0
? (192.168.1.50) at 00:aa:bb:cc:dd:ee [ether] on eth0`,
        exitCode: 0,
      };
    }
    return { output: '', exitCode: 0 };
  },

  hostname: (args, state) => {
    if (args.includes('-I')) {
      return { output: '192.168.1.100', exitCode: 0 };
    }
    if (args.includes('-f') || args.includes('--fqdn')) {
      return { output: `${state.hostname}.local`, exitCode: 0 };
    }
    return { output: state.hostname, exitCode: 0 };
  },

  nc: (args) => {
    // netcat implementation
    if (args.length === 0) {
      return { output: '', error: 'usage: nc [-46CDdFhklNnrStUuvZz] [-I length] [-i interval] [-M ttl]\n\t  [-m minttl] [-O length] [-P proxy_username] [-p source_port]\n\t  [-q seconds] [-s sourceaddr] [-T keyword] [-V rtable] [-W recvlimit]\n\t  [-w timeout] [-X proxy_protocol] [-x proxy_address[:port]]\n\t  [destination] [port]', exitCode: 1 };
    }

    const listen = args.includes('-l');
    const verbose = args.includes('-v');
    const udp = args.includes('-u');
    const zero = args.includes('-z'); // Zero-I/O mode (for scanning)
    const portScan = args.includes('-z');

    // Get non-flag arguments
    const nonFlags = args.filter(a => !a.startsWith('-'));

    if (listen) {
      // Listen mode
      const port = nonFlags[0] || '8080';
      if (verbose) {
        return { output: `Listening on 0.0.0.0 ${port}`, exitCode: 0 };
      }
      return { output: `[nc: listening on port ${port}, waiting for connection...]`, exitCode: 0 };
    }

    if (nonFlags.length < 2) {
      return { output: '', error: 'nc: missing destination or port', exitCode: 1 };
    }

    const host = nonFlags[0];
    const portArg = nonFlags[1];

    // Port scanning mode (-z)
    if (zero) {
      // Check for port range (e.g., 20-25)
      if (portArg.includes('-')) {
        const [start, end] = portArg.split('-').map(Number);
        const lines: string[] = [];
        const openPorts = [22, 80, 443, 3306, 5432, 8080];

        for (let p = start; p <= Math.min(end, start + 100); p++) {
          if (openPorts.includes(p)) {
            lines.push(`Connection to ${host} ${p} port [tcp/${getServiceName(p)}] succeeded!`);
          }
        }

        if (lines.length === 0) {
          return { output: '', error: `nc: connect to ${host} port ${start}-${end} (tcp) failed: Connection refused`, exitCode: 1 };
        }
        return { output: lines.join('\n'), exitCode: 0 };
      }

      // Single port scan
      const port = parseInt(portArg);
      const openPorts = [22, 80, 443, 3306, 5432, 8080];

      if (openPorts.includes(port)) {
        if (verbose) {
          return { output: `Connection to ${host} ${port} port [tcp/${getServiceName(port)}] succeeded!`, exitCode: 0 };
        }
        return { output: '', exitCode: 0 };
      }
      return { output: '', error: `nc: connect to ${host} port ${port} (tcp) failed: Connection refused`, exitCode: 1 };
    }

    // Regular connection mode
    const port = parseInt(portArg);
    if (verbose) {
      return { output: `Connection to ${host} ${port} port [tcp/${getServiceName(port)}] succeeded!`, exitCode: 0 };
    }

    // Simulate different responses based on port
    if (port === 80 || port === 8080) {
      return { output: `HTTP/1.1 200 OK\r\nServer: nginx\r\nContent-Type: text/html\r\n\r\n<html><body>Connected</body></html>`, exitCode: 0 };
    } else if (port === 22) {
      return { output: `SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.4`, exitCode: 0 };
    } else if (port === 25) {
      return { output: `220 mail.example.com ESMTP Postfix`, exitCode: 0 };
    } else if (port === 21) {
      return { output: `220 (vsFTPd 3.0.5)`, exitCode: 0 };
    } else if (port === 3306) {
      return { output: `[MySQL binary protocol data]`, exitCode: 0 };
    } else if (port === 5432) {
      return { output: `[PostgreSQL protocol data]`, exitCode: 0 };
    }

    return { output: `[Connected to ${host}:${port}]`, exitCode: 0 };
  },

  netcat: (args, state, fs, pm) => {
    // Alias for nc
    return networkCommands.nc(args, state, fs, pm);
  },

  telnet: (args) => {
    if (args.length === 0) {
      return { output: 'telnet> ', exitCode: 0 };
    }

    const host = args[0];
    const port = args[1] || '23';

    const lines = [
      `Trying ${host}...`,
      `Connected to ${host}.`,
      `Escape character is '^]'.`,
    ];

    if (port === '23') {
      lines.push(`Ubuntu 22.04.3 LTS`);
      lines.push(`${host} login: `);
    } else if (port === '80') {
      lines.push(`[HTTP server - send request]`);
    } else if (port === '25') {
      lines.push(`220 ${host} ESMTP Postfix`);
    }

    return { output: lines.join('\n'), exitCode: 0 };
  },

  nmap: (args, state) => {
    if (args.length === 0) {
      return { output: '', error: 'Nmap: usage: nmap [Scan Type(s)] [Options] {target specification}', exitCode: 1 };
    }

    const target = args.filter(a => !a.startsWith('-'))[0];
    if (!target) {
      return { output: '', error: 'Nmap: No targets were specified', exitCode: 1 };
    }

    const quickScan = args.includes('-F');
    const serviceScan = args.includes('-sV');
    const osScan = args.includes('-O');
    const allPorts = args.includes('-p-');

    const lines = [
      `Starting Nmap 7.93 ( https://nmap.org ) at ${new Date().toISOString().replace('T', ' ').split('.')[0]}`,
      `Nmap scan report for ${target}`,
      `Host is up (0.0045s latency).`,
    ];

    if (allPorts) {
      lines.push(`Not shown: 65530 closed tcp ports`);
    } else if (quickScan) {
      lines.push(`Not shown: 95 closed tcp ports`);
    } else {
      lines.push(`Not shown: 995 closed tcp ports`);
    }

    lines.push(`PORT      STATE SERVICE` + (serviceScan ? ` VERSION` : ``));

    const ports = [
      { port: 22, state: 'open', service: 'ssh', version: 'OpenSSH 8.9p1 Ubuntu 3ubuntu0.4' },
      { port: 80, state: 'open', service: 'http', version: 'nginx 1.18.0' },
      { port: 443, state: 'open', service: 'https', version: 'nginx 1.18.0' },
      { port: 3306, state: 'open', service: 'mysql', version: 'MySQL 8.0.35' },
      { port: 5432, state: 'open', service: 'postgresql', version: 'PostgreSQL 15.4' },
    ];

    for (const p of ports.slice(0, quickScan ? 3 : 5)) {
      let line = `${p.port.toString().padEnd(5)}/tcp ${p.state.padEnd(5)} ${p.service}`;
      if (serviceScan) {
        line += ` ${p.version}`;
      }
      lines.push(line);
    }

    if (osScan && state.isRoot) {
      lines.push(``);
      lines.push(`OS details: Linux 5.15.0-88-generic (Ubuntu)`);
    } else if (osScan) {
      lines.push(``);
      lines.push(`OS detection requires root privileges.`);
    }

    lines.push(``);
    lines.push(`Nmap done: 1 IP address (1 host up) scanned in ${(1 + Math.random() * 3).toFixed(2)} seconds`);

    return { output: lines.join('\n'), exitCode: 0 };
  },

  tcpdump: (args, state) => {
    if (!state.isRoot) {
      return { output: '', error: 'tcpdump: permission denied (requires root)', exitCode: 1 };
    }

    const iface = args.includes('-i') ? args[args.indexOf('-i') + 1] : 'eth0';
    const count = args.includes('-c') ? parseInt(args[args.indexOf('-c') + 1]) || 5 : 5;

    const lines = [
      `tcpdump: verbose output suppressed, use -v[v]... for full protocol decode`,
      `listening on ${iface}, link-type EN10MB (Ethernet), snapshot length 262144 bytes`,
    ];

    const now = new Date();
    for (let i = 0; i < Math.min(count, 10); i++) {
      const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${(Math.random() * 1000000).toFixed(0).padStart(6, '0')}`;
      const srcPort = 40000 + Math.floor(Math.random() * 25000);
      const dstPort = [22, 80, 443, 53][Math.floor(Math.random() * 4)];

      if (Math.random() > 0.5) {
        lines.push(`${time} IP 192.168.1.100.${srcPort} > 93.184.216.34.${dstPort}: Flags [S], seq ${Math.floor(Math.random() * 1000000000)}, win 65535, length 0`);
      } else {
        lines.push(`${time} IP 93.184.216.34.${dstPort} > 192.168.1.100.${srcPort}: Flags [S.], seq ${Math.floor(Math.random() * 1000000000)}, ack ${Math.floor(Math.random() * 1000000000)}, win 65535, length 0`);
      }
    }

    lines.push(`${count} packets captured`);
    lines.push(`${count} packets received by filter`);
    lines.push(`0 packets dropped by kernel`);

    return { output: lines.join('\n'), exitCode: 0 };
  },

  ssh: (args, state) => {
    if (args.length === 0) {
      return { output: '', error: 'usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface]\n           [-b bind_address] [-c cipher_spec] [-D [bind_address:]port]\n           [-E log_file] [-e escape_char] [-F configfile] [-I pkcs11]\n           [-i identity_file] [-J [user@]host[:port]] [-L address]\n           [-l login_name] [-m mac_spec] [-O ctl_cmd] [-o option] [-p port]\n           [-Q query_option] [-R address] [-S ctl_path] [-W host:port]\n           [-w local_tun[:remote_tun]] destination [command]', exitCode: 255 };
    }

    // Parse SSH arguments
    const verbose = args.includes('-v') || args.includes('-vv') || args.includes('-vvv');
    const portIdx = args.indexOf('-p');
    const port = portIdx !== -1 && args[portIdx + 1] ? args[portIdx + 1] : '22';
    const identityIdx = args.indexOf('-i');
    const identity = identityIdx !== -1 ? args[identityIdx + 1] : null;

    // Find destination (user@host or just host)
    const destination = args.filter(a =>
      !a.startsWith('-') &&
      a !== port &&
      a !== identity &&
      (a.includes('@') || a.match(/^[\w.-]+$/))
    )[0];

    if (!destination) {
      return { output: '', error: 'ssh: No destination specified', exitCode: 255 };
    }

    let user = state.currentUser;
    let host = destination;

    if (destination.includes('@')) {
      [user, host] = destination.split('@');
    }

    // Check for command after destination
    const destIdx = args.indexOf(destination);
    const remoteCommand = args.slice(destIdx + 1).join(' ');

    const lines: string[] = [];

    if (verbose) {
      lines.push(`OpenSSH_8.9p1 Ubuntu-3ubuntu0.4, OpenSSL 3.0.2 15 Mar 2022`);
      lines.push(`debug1: Reading configuration data /etc/ssh/ssh_config`);
      lines.push(`debug1: Connecting to ${host} [${host}] port ${port}.`);
      lines.push(`debug1: Connection established.`);
      lines.push(`debug1: identity file /home/${state.currentUser}/.ssh/id_rsa type 0`);
      lines.push(`debug1: Authenticating to ${host}:${port} as '${user}'`);
      lines.push(`debug1: Authentication succeeded (publickey).`);
    }

    if (remoteCommand) {
      // Execute remote command simulation
      lines.push(`[Executing on ${host}]: ${remoteCommand}`);

      // Simulate some common remote commands
      if (remoteCommand.includes('hostname')) {
        lines.push(host);
      } else if (remoteCommand.includes('uname')) {
        lines.push('Linux');
      } else if (remoteCommand.includes('whoami')) {
        lines.push(user);
      } else if (remoteCommand.includes('date')) {
        lines.push(new Date().toString());
      } else if (remoteCommand.includes('uptime')) {
        lines.push(` ${new Date().toLocaleTimeString()} up 5 days,  3:42,  1 user,  load average: 0.15, 0.10, 0.05`);
      } else {
        lines.push(`[Command output simulated]`);
      }
    } else {
      // Interactive session simulation
      lines.push(`Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-88-generic x86_64)`);
      lines.push(``);
      lines.push(` * Documentation:  https://help.ubuntu.com`);
      lines.push(` * Management:     https://landscape.canonical.com`);
      lines.push(` * Support:        https://ubuntu.com/advantage`);
      lines.push(``);
      lines.push(`Last login: ${new Date().toDateString()} ${new Date().toLocaleTimeString()} from ${state.env.SSH_CLIENT?.split(' ')[0] || '192.168.1.50'}`);
      lines.push(`${user}@${host}:~$ [Interactive SSH session - type 'exit' to disconnect]`);
    }

    return { output: lines.join('\n'), exitCode: 0 };
  },

  scp: (args, state) => {
    if (args.length < 2) {
      return { output: '', error: 'usage: scp [-346BCpqrTv] [-c cipher] [-F ssh_config] [-i identity_file]\n           [-J destination] [-l limit] [-o ssh_option] [-P port]\n           [-S program] source ... target', exitCode: 1 };
    }

    const recursive = args.includes('-r');
    const verbose = args.includes('-v');
    const quiet = args.includes('-q');
    const portIdx = args.indexOf('-P');
    const port = portIdx !== -1 ? args[portIdx + 1] : '22';

    // Get source and target (last two non-flag arguments)
    const nonFlags = args.filter(a => !a.startsWith('-') && a !== port);

    if (nonFlags.length < 2) {
      return { output: '', error: 'scp: missing source or target', exitCode: 1 };
    }

    const source = nonFlags.slice(0, -1).join(' ');
    const target = nonFlags[nonFlags.length - 1];

    // Determine if this is upload or download
    const isUpload = target.includes(':');
    const isDownload = source.includes(':');

    const lines: string[] = [];

    if (verbose) {
      lines.push(`Executing: program /usr/bin/ssh host ${isUpload ? target.split(':')[0] : source.split(':')[0]}, user (unspecified), command scp -v ${recursive ? '-r ' : ''}-t ${isUpload ? target.split(':')[1] : '.'}`);
      lines.push(`OpenSSH_8.9p1 Ubuntu-3ubuntu0.4, OpenSSL 3.0.2 15 Mar 2022`);
    }

    // Simulate file transfer
    const fileName = (isUpload ? source : source.split(':')[1] || 'file').split('/').pop() || 'file';
    const fileSize = Math.floor(Math.random() * 10000) + 1000;

    if (!quiet) {
      lines.push(`${fileName}                                     100% ${fileSize}     ${(fileSize / 100).toFixed(1)}KB/s   00:00`);
    }

    return { output: lines.join('\n'), exitCode: 0 };
  },

  sftp: (args, state) => {
    if (args.length === 0) {
      return { output: '', error: 'usage: sftp [-46aCfNpqrv] [-B buffer_size] [-b batchfile] [-c cipher]\n          [-D sftp_server_path] [-F ssh_config] [-i identity_file]\n          [-J destination] [-l limit] [-o ssh_option] [-P port]\n          [-R num_requests] [-S program] [-s subsystem | sftp_server]\n          destination', exitCode: 1 };
    }

    const destination = args.filter(a => !a.startsWith('-'))[0];

    if (!destination) {
      return { output: '', error: 'sftp: No destination specified', exitCode: 1 };
    }

    let user = state.currentUser;
    let host = destination;

    if (destination.includes('@')) {
      [user, host] = destination.split('@');
    }

    const lines = [
      `Connected to ${host}.`,
      `sftp> [Interactive SFTP session]`,
      ``,
      `Available commands:`,
      `  cd path                 Change remote directory`,
      `  lcd path                Change local directory`,
      `  ls [path]               List remote directory`,
      `  lls [path]              List local directory`,
      `  get remote [local]      Download file`,
      `  put local [remote]      Upload file`,
      `  mkdir path              Create remote directory`,
      `  rmdir path              Remove remote directory`,
      `  rm path                 Remove remote file`,
      `  pwd                     Print remote working directory`,
      `  lpwd                    Print local working directory`,
      `  exit/quit               Exit sftp`,
    ];

    return { output: lines.join('\n'), exitCode: 0 };
  },

  rsync: (args, state) => {
    if (args.length < 2) {
      return { output: '', error: 'rsync  version 3.2.7  protocol version 31\nUsage: rsync [OPTION]... SRC [SRC]... DEST\n  or   rsync [OPTION]... SRC [SRC]... [USER@]HOST:DEST\n  or   rsync [OPTION]... SRC [SRC]... [USER@]HOST::DEST\n  or   rsync [OPTION]... [USER@]HOST:SRC [DEST]\n  or   rsync [OPTION]... [USER@]HOST::SRC [DEST]', exitCode: 1 };
    }

    const verbose = args.includes('-v') || args.includes('--verbose');
    const archive = args.includes('-a') || args.includes('--archive');
    const recursive = args.includes('-r') || args.includes('--recursive');
    const compress = args.includes('-z') || args.includes('--compress');
    const progress = args.includes('--progress') || args.includes('-P');
    const dryRun = args.includes('-n') || args.includes('--dry-run');
    const delete_ = args.includes('--delete');

    // Get source and target
    const nonFlags = args.filter(a => !a.startsWith('-'));

    if (nonFlags.length < 2) {
      return { output: '', error: 'rsync: missing source or destination', exitCode: 1 };
    }

    const source = nonFlags[0];
    const target = nonFlags[nonFlags.length - 1];
    const isRemote = source.includes(':') || target.includes(':');

    const lines: string[] = [];

    if (dryRun) {
      lines.push(`(DRY RUN) Would transfer files from ${source} to ${target}`);
    }

    // Simulate file list
    const files = [
      { name: 'file1.txt', size: 1234 },
      { name: 'file2.log', size: 5678 },
      { name: 'data/config.json', size: 890 },
      { name: 'data/settings.yml', size: 456 },
    ];

    if (verbose) {
      lines.push(`sending incremental file list`);
      for (const file of files) {
        if (progress) {
          lines.push(`${file.name}`);
          lines.push(`          ${file.size} 100%    ${(file.size / 100).toFixed(2)}kB/s    0:00:00 (xfr#1, to-chk=0/${files.length})`);
        } else {
          lines.push(`${file.name}`);
        }
      }
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    lines.push(``);
    lines.push(`sent ${totalSize + 500} bytes  received ${Math.floor(totalSize / 10)} bytes  ${((totalSize + 500 + totalSize / 10) / 1000).toFixed(2)}K bytes/sec`);
    lines.push(`total size is ${totalSize}  speedup is ${(10 + Math.random() * 5).toFixed(2)}${dryRun ? ' (DRY RUN)' : ''}`);

    return { output: lines.join('\n'), exitCode: 0 };
  },

  'ssh-keygen': (args, state) => {
    const type = args.includes('-t') ? args[args.indexOf('-t') + 1] : 'rsa';
    const bits = args.includes('-b') ? args[args.indexOf('-b') + 1] : (type === 'rsa' ? '3072' : '256');
    const comment = args.includes('-C') ? args[args.indexOf('-C') + 1] : `${state.currentUser}@${state.hostname}`;
    const file = args.includes('-f') ? args[args.indexOf('-f') + 1] : `/home/${state.currentUser}/.ssh/id_${type}`;

    if (args.includes('-l')) {
      // List fingerprint
      const keyFile = args.filter(a => !a.startsWith('-'))[0] || file + '.pub';
      return {
        output: `${bits} SHA256:${Buffer.from(Math.random().toString()).toString('base64').substring(0, 43)} ${comment} (${type.toUpperCase()})`,
        exitCode: 0,
      };
    }

    const lines = [
      `Generating public/private ${type} key pair.`,
      `Enter file in which to save the key (${file}): `,
      `Enter passphrase (empty for no passphrase): `,
      `Enter same passphrase again: `,
      `Your identification has been saved in ${file}`,
      `Your public key has been saved in ${file}.pub`,
      `The key fingerprint is:`,
      `SHA256:${Buffer.from(Math.random().toString()).toString('base64').substring(0, 43)} ${comment}`,
      `The key's randomart image is:`,
      `+---[${type.toUpperCase()} ${bits}]----+`,
      `|     .o+*O=.     |`,
      `|      .=B=+      |`,
      `|       o*+.o     |`,
      `|      . +o= .    |`,
      `|        S+ o     |`,
      `|       o  o .    |`,
      `|      . .E .     |`,
      `|       o..o      |`,
      `|        oo.      |`,
      `+----[SHA256]-----+`,
    ];

    return { output: lines.join('\n'), exitCode: 0 };
  },

  'ssh-copy-id': (args, state) => {
    if (args.length === 0) {
      return { output: '', error: 'Usage: ssh-copy-id [-h|-?|-f|-n|-s] [-i [identity_file]] [-p port] [-o ssh_option] [user@]hostname', exitCode: 1 };
    }

    const destination = args.filter(a => !a.startsWith('-'))[0];

    if (!destination) {
      return { output: '', error: 'ssh-copy-id: No destination specified', exitCode: 1 };
    }

    let user = state.currentUser;
    let host = destination;

    if (destination.includes('@')) {
      [user, host] = destination.split('@');
    }

    const lines = [
      `/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "/home/${state.currentUser}/.ssh/id_rsa.pub"`,
      `/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s), to filter out any that are already installed`,
      `/usr/bin/ssh-copy-id: INFO: 1 key(s) remain to be installed -- if you are prompted now it is to install the new keys`,
      `${user}@${host}'s password: `,
      ``,
      `Number of key(s) added: 1`,
      ``,
      `Now try logging into the machine, with:   "ssh '${user}@${host}'"`,
      `and check to make sure that only the key(s) you wanted were added.`,
    ];

    return { output: lines.join('\n'), exitCode: 0 };
  },
};

function getServiceName(port: number): string {
  const services: Record<number, string> = {
    21: 'ftp',
    22: 'ssh',
    23: 'telnet',
    25: 'smtp',
    53: 'domain',
    80: 'http',
    110: 'pop3',
    143: 'imap',
    443: 'https',
    993: 'imaps',
    995: 'pop3s',
    3306: 'mysql',
    5432: 'postgresql',
    6379: 'redis',
    8080: 'http-proxy',
    27017: 'mongodb',
  };
  return services[port] || '*';
}

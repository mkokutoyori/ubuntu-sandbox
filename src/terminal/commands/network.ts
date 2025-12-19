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

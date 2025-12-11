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

    const url = args.filter(a => !a.startsWith('-'))[0];
    if (!url) {
      return { output: '', error: 'curl: no URL specified', exitCode: 3 };
    }

    // Simulate response
    if (url.includes('google.com')) {
      return {
        output: `<!doctype html><html><head><title>Google</title></head><body><center><img src="/images/logo.png" alt="Google"></center></body></html>`,
        exitCode: 0,
      };
    }

    return {
      output: `<!DOCTYPE html>
<html>
<head><title>Example Domain</title></head>
<body>
<h1>Example Domain</h1>
<p>This domain is for use in illustrative examples in documents.</p>
</body>
</html>`,
      exitCode: 0,
    };
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
};

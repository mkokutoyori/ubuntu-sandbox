# DHCP Protocol Tutorial

This tutorial guides you through understanding the DHCP (Dynamic Host Configuration Protocol) using our Network Simulator.

## Table of Contents

1. [Introduction to DHCP](#introduction-to-dhcp)
2. [The DORA Process](#the-dora-process)
3. [DHCP Packet Structure](#dhcp-packet-structure)
4. [Setting Up a DHCP Server](#setting-up-a-dhcp-server)
5. [Configuring DHCP Clients](#configuring-dhcp-clients)
6. [Advanced Features](#advanced-features)
7. [Troubleshooting](#troubleshooting)

---

## Introduction to DHCP

DHCP (Dynamic Host Configuration Protocol) is a network management protocol that automatically assigns IP addresses and other network configuration parameters to devices on a network.

### Why DHCP?

Without DHCP, network administrators would need to manually configure:
- IP address
- Subnet mask
- Default gateway
- DNS servers

For each device on the network. DHCP automates this process.

### Key Components

| Component | Description |
|-----------|-------------|
| **DHCP Server** | Assigns IP addresses from a pool |
| **DHCP Client** | Requests network configuration |
| **IP Pool** | Range of available IP addresses |
| **Lease** | Temporary assignment of an IP address |

---

## The DORA Process

DHCP uses a four-step process called **DORA**:

```
┌────────────┐                              ┌────────────┐
│   Client   │                              │   Server   │
└─────┬──────┘                              └─────┬──────┘
      │                                           │
      │  1. DISCOVER (broadcast)                  │
      │ ──────────────────────────────────────────>
      │     "I need an IP address!"               │
      │                                           │
      │  2. OFFER (unicast/broadcast)             │
      │ <──────────────────────────────────────────
      │     "Here's 192.168.1.100"                │
      │                                           │
      │  3. REQUEST (broadcast)                   │
      │ ──────────────────────────────────────────>
      │     "I'll take 192.168.1.100"             │
      │                                           │
      │  4. ACK (unicast/broadcast)               │
      │ <──────────────────────────────────────────
      │     "Confirmed! It's yours."              │
      │                                           │
```

### Step-by-Step Explanation

1. **DISCOVER**: The client broadcasts a request to find DHCP servers
2. **OFFER**: Server(s) respond with available IP addresses and configurations
3. **REQUEST**: Client requests the offered IP address (broadcast to inform other servers)
4. **ACK**: Server confirms the lease and provides final configuration

---

## DHCP Packet Structure

Our implementation follows RFC 2131. Here's the packet structure:

```typescript
// Creating a DHCP DISCOVER packet
import { DHCPPacket } from '@/domain/network/entities/DHCPPacket';
import { MACAddress } from '@/domain/network/value-objects/MACAddress';

const clientMAC = new MACAddress('AA:BB:CC:DD:EE:FF');
const discover = DHCPPacket.createDiscover(clientMAC, 'my-hostname');
```

### Key Packet Fields

| Field | Description |
|-------|-------------|
| `op` | Operation code (1=request, 2=reply) |
| `htype` | Hardware type (1=Ethernet) |
| `hlen` | Hardware address length (6 for MAC) |
| `xid` | Transaction ID |
| `ciaddr` | Client IP (if already assigned) |
| `yiaddr` | "Your" IP (server's assigned IP) |
| `siaddr` | Server IP address |
| `chaddr` | Client hardware address (MAC) |

### DHCP Options

DHCP options provide additional configuration:

| Option Code | Name | Description |
|-------------|------|-------------|
| 1 | Subnet Mask | Network mask (e.g., 255.255.255.0) |
| 3 | Router | Default gateway |
| 6 | DNS Servers | List of DNS server IPs |
| 51 | Lease Time | Duration of the lease (seconds) |
| 53 | Message Type | DISCOVER, OFFER, REQUEST, etc. |

---

## Setting Up a DHCP Server

### Using the Router as DHCP Server

```typescript
import { Router } from '@/domain/devices/Router';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';

// Create and configure router
const router = new Router({
  id: 'router1',
  name: 'Gateway Router',
  hostname: 'GW-ROUTER'
});

// Configure interface
router.configureIP(
  'eth0',
  new IPAddress('192.168.1.1'),
  new IPAddress('255.255.255.0')
);

// Enable DHCP server
router.enableDHCPServer('eth0', {
  poolStart: new IPAddress('192.168.1.100'),
  poolEnd: new IPAddress('192.168.1.200'),
  subnetMask: new IPAddress('255.255.255.0'),
  defaultGateway: new IPAddress('192.168.1.1'),
  dnsServers: [
    new IPAddress('8.8.8.8'),
    new IPAddress('8.8.4.4')
  ],
  leaseTime: 86400 // 24 hours
});
```

### Cisco IOS Commands

```
Router> enable
Router# configure terminal
Router(config)# ip dhcp pool LAN
Router(dhcp-config)# network 192.168.1.0 255.255.255.0
Router(dhcp-config)# default-router 192.168.1.1
Router(dhcp-config)# dns-server 8.8.8.8
Router(dhcp-config)# lease 1
Router(dhcp-config)# exit
Router(config)# ip dhcp excluded-address 192.168.1.1 192.168.1.10
```

### Adding IP Reservations

Reserve specific IPs for devices by MAC address:

```typescript
router.addDHCPReservation(
  'eth0',
  new MACAddress('00:11:22:33:44:55'),
  new IPAddress('192.168.1.50')
);
```

---

## Configuring DHCP Clients

### Linux (dhclient)

```typescript
import { LinuxPC } from '@/domain/devices/LinuxPC';

const linux = new LinuxPC({
  id: 'pc1',
  name: 'Ubuntu Desktop',
  hostname: 'ubuntu-pc'
});

// Request DHCP lease
const output = await linux.executeCommand('dhclient eth0');
```

**Example Output:**
```
Internet Systems Consortium DHCP Client 4.4.1
Copyright 2004-2018 Internet Systems Consortium.
All rights reserved.
For info, please visit https://www.isc.org/software/dhcp/

Listening on LPF/eth0/aa:bb:cc:dd:ee:ff
Sending on   LPF/eth0/aa:bb:cc:dd:ee:ff
DHCPDISCOVER on eth0 to 255.255.255.255 port 67 interval 3
DHCPOFFER of 192.168.1.100 from 192.168.1.1
DHCPREQUEST for 192.168.1.100 on eth0 to 255.255.255.255 port 67
DHCPACK of 192.168.1.100 from 192.168.1.1
bound to 192.168.1.100 -- renewal in 43200 seconds.
```

**Release DHCP lease:**
```bash
sudo dhclient -r eth0
```

### Windows (ipconfig)

```typescript
import { WindowsPC } from '@/domain/devices/WindowsPC';

const windows = new WindowsPC({
  id: 'pc2',
  name: 'Windows Desktop',
  hostname: 'DESKTOP-WIN10'
});

// Request DHCP lease
const output = await windows.executeCommand('ipconfig /renew');
```

**Example Output:**
```
Windows IP Configuration

Ethernet adapter Ethernet:

   Connection-specific DNS Suffix  . :
   IPv4 Address. . . . . . . . . . . : 192.168.1.100
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 192.168.1.1
```

**Release DHCP lease:**
```cmd
ipconfig /release
```

---

## Advanced Features

### DHCP State Machine

The DHCP client follows a state machine:

```
         ┌─────────┐
         │  INIT   │
         └────┬────┘
              │ send DISCOVER
              ▼
         ┌─────────┐
         │SELECTING│ ──── receive OFFER ────┐
         └────┬────┘                        │
              │ select offer                │
              ▼                             │
         ┌──────────┐                       │
         │REQUESTING│ <─────────────────────┘
         └────┬─────┘
              │ receive ACK
              ▼
         ┌─────────┐
         │  BOUND  │ ──── lease expires ────> INIT
         └────┬────┘
              │ T1 timer (50% lease)
              ▼
         ┌──────────┐
         │ RENEWING │ ──── receive ACK ────> BOUND
         └────┬─────┘
              │ T2 timer (87.5% lease)
              ▼
         ┌───────────┐
         │ REBINDING │ ──── receive ACK ───> BOUND
         └───────────┘
```

### Accessing Client State

```typescript
// Get current DHCP client state
const state = linux.getDHCPClientState();
// Returns: 'INIT' | 'SELECTING' | 'REQUESTING' | 'BOUND' | 'RENEWING' | 'REBINDING'

// Get lease information
const lease = linux.getDHCPLeaseInfo();
console.log(lease);
// {
//   ipAddress: IPAddress('192.168.1.100'),
//   subnetMask: IPAddress('255.255.255.0'),
//   gateway: IPAddress('192.168.1.1'),
//   dnsServers: [IPAddress('8.8.8.8')],
//   serverIP: IPAddress('192.168.1.1'),
//   leaseTime: 86400
// }
```

### Server Statistics

```typescript
const stats = router.getDHCPStatistics('eth0');
console.log(stats);
// {
//   totalLeases: 5,
//   availableAddresses: 95,
//   discovers: 10,
//   offers: 10,
//   requests: 8,
//   acks: 5,
//   naks: 2,
//   releases: 3
// }
```

---

## Troubleshooting

### Common Issues

#### 1. No DHCP Server Response

**Symptom:** Client shows timeout message

**Linux:**
```
No DHCPOFFERS received.
No working leases in persistent database - sleeping.
```

**Windows:**
```
An error occurred while renewing interface Ethernet : unable to connect to your DHCP server. Request has timed out.
```

**Solutions:**
- Verify DHCP server is enabled on the router
- Check network connectivity (cable, switch ports)
- Verify the client is on the correct VLAN/subnet

#### 2. IP Address Already in Use

**Symptom:** DHCP NAK received

```typescript
// Server responds with NAK when IP is unavailable
const nak = DHCPPacket.createNak(requestPacket, serverIP);
```

**Solutions:**
- Clear DHCP leases on the server
- Use `ipconfig /release` then `/renew` on Windows
- Use `dhclient -r` then `dhclient` on Linux

#### 3. Pool Exhaustion

**Symptom:** No available IP addresses

```typescript
const stats = router.getDHCPStatistics('eth0');
if (stats.availableAddresses === 0) {
  console.log('DHCP pool exhausted!');
}
```

**Solutions:**
- Expand the IP pool range
- Reduce lease times
- Review and remove stale leases

### Debug Commands

**View current leases on router:**
```
Router# show ip dhcp binding
```

**View DHCP configuration:**
```
Router# show ip dhcp pool
```

**View interface DHCP status (Windows):**
```cmd
ipconfig /all
```

**View DHCP lease file (Linux):**
```bash
cat /var/lib/dhcp/dhclient.leases
```

---

## Complete Example

Here's a complete network setup with DHCP:

```typescript
import { NetworkSimulator } from '@/domain/network/NetworkSimulator';
import { Router } from '@/domain/devices/Router';
import { Switch } from '@/domain/devices/Switch';
import { LinuxPC } from '@/domain/devices/LinuxPC';
import { WindowsPC } from '@/domain/devices/WindowsPC';
import { IPAddress } from '@/domain/network/value-objects/IPAddress';

// Create simulator
const simulator = new NetworkSimulator();

// Create devices
const router = new Router({ id: 'r1', name: 'Gateway', hostname: 'GATEWAY' });
const switch1 = new Switch({ id: 'sw1', name: 'LAN Switch' });
const linux = new LinuxPC({ id: 'pc1', name: 'Ubuntu', hostname: 'ubuntu' });
const windows = new WindowsPC({ id: 'pc2', name: 'Windows', hostname: 'WIN-PC' });

// Add to simulator
simulator.addDevice(router);
simulator.addDevice(switch1);
simulator.addDevice(linux);
simulator.addDevice(windows);

// Connect devices
simulator.connect(router, 'eth0', switch1, 'fa0/1');
simulator.connect(linux, 'eth0', switch1, 'fa0/2');
simulator.connect(windows, 'eth0', switch1, 'fa0/3');

// Configure router
router.configureIP('eth0', new IPAddress('192.168.1.1'), new IPAddress('255.255.255.0'));

// Enable DHCP server
router.enableDHCPServer('eth0', {
  poolStart: new IPAddress('192.168.1.100'),
  poolEnd: new IPAddress('192.168.1.200'),
  subnetMask: new IPAddress('255.255.255.0'),
  defaultGateway: new IPAddress('192.168.1.1'),
  dnsServers: [new IPAddress('8.8.8.8')],
  leaseTime: 3600
});

// Set up DHCP packet handling
const handleDHCP = (packet) => {
  router.handleDHCPPacket(packet);
};

linux.setDHCPCallback(handleDHCP);
windows.setDHCPCallback(handleDHCP);

// Clients request IP addresses
await linux.executeCommand('dhclient eth0');
await windows.executeCommand('ipconfig /renew');

// Verify configuration
console.log(linux.getDHCPLeaseInfo()?.ipAddress.toString());
// Output: 192.168.1.100

console.log(windows.getDHCPLeaseInfo()?.ipAddress.toString());
// Output: 192.168.1.101
```

---

## Summary

DHCP simplifies network administration by automating IP address assignment. Key takeaways:

1. **DORA Process**: Discover → Offer → Request → Acknowledge
2. **Server Configuration**: Define pool, gateway, DNS, and lease time
3. **Client Commands**: `dhclient` (Linux) or `ipconfig /renew` (Windows)
4. **State Machine**: Clients transition through INIT → SELECTING → REQUESTING → BOUND
5. **Troubleshooting**: Check connectivity, server status, and pool availability

For more details, refer to RFC 2131 (DHCP) and RFC 2132 (DHCP Options).

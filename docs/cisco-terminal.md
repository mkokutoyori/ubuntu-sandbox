# Cisco IOS Terminal

The NetSim Cisco terminal provides a realistic simulation of Cisco IOS command line interface for routers and switches.

## Features

### Device Types
- **Router**: Cisco IOS router with routing protocols (OSPF, RIP, EIGRP, BGP)
- **Switch**: Cisco IOS switch with VLAN and spanning-tree support

### Operating Modes
1. **User EXEC Mode** (`>`) - Limited commands, read-only
2. **Privileged EXEC Mode** (`#`) - Full access to show/debug commands
3. **Global Configuration Mode** (`(config)#`) - Device-wide settings
4. **Interface Configuration** (`(config-if)#`) - Interface settings
5. **Line Configuration** (`(config-line)#`) - Console/VTY settings
6. **Router Configuration** (`(config-router)#`) - Routing protocol settings
7. **VLAN Configuration** (`(config-vlan)#`) - VLAN settings

### Tab Completion
Press Tab to autocomplete commands:
- Supports hierarchical subcommand completion
- Works across all configuration modes
- Common prefix matching for multiple options

## Command Reference

### User EXEC Mode (`>`)
```
enable          Enter privileged mode
exit, logout    Exit terminal
ping <ip>       Ping an IP address
show ...        Display information
traceroute      Trace route to destination
```

### Privileged EXEC Mode (`#`)
```
configure terminal    Enter global config mode
copy running-config startup-config    Save configuration
copy startup-config running-config    Load saved config
disable              Return to user mode
reload               Restart device
show running-config  View current configuration
show startup-config  View saved configuration
show version         System version info
write memory         Save configuration
```

### Global Configuration Mode (`(config)#`)
```
hostname <name>           Set device hostname
enable secret <password>  Set privileged password
interface <type> <num>    Enter interface config
line console 0            Configure console port
line vty 0 4              Configure virtual terminals
router <protocol>         Configure routing protocol
ip route <dest> <mask> <next-hop>    Static route
banner motd <delimiter>   Set message of the day
service password-encryption    Encrypt passwords
no <command>              Negate or remove setting
end                       Return to privileged mode
exit                      Return to previous mode
```

### Interface Configuration (`(config-if)#`)
```
ip address <ip> <mask>    Set IP address
no shutdown               Enable interface
shutdown                  Disable interface
description <text>        Set description
duplex [auto|half|full]   Set duplex mode
speed [10|100|1000|auto]  Set speed
switchport mode [access|trunk]    Set switch mode
switchport access vlan <id>       Assign access VLAN
switchport trunk allowed vlan <ids>    Trunk VLANs
spanning-tree portfast    Enable portfast
```

### Show Commands
```
show running-config       Current configuration
show startup-config       Saved configuration
show version              IOS version and uptime
show interfaces           All interfaces
show ip interface brief   Interface summary
show ip route             Routing table
show vlan [brief]         VLAN information
show mac address-table    MAC address table
show arp                  ARP table
show spanning-tree        STP information
show cdp neighbors        CDP neighbor devices
show protocols            Protocol status
show clock                Current time
show history              Command history
show privilege            Current privilege level
show flash:               Flash memory contents
```

### Routing Configuration

#### OSPF
```
router ospf 1
  network 192.168.1.0 0.0.0.255 area 0
  passive-interface GigabitEthernet0/0
  router-id 1.1.1.1
```

#### RIP
```
router rip
  version 2
  network 192.168.1.0
  no auto-summary
```

#### EIGRP
```
router eigrp 100
  network 192.168.1.0
  no auto-summary
```

### VLAN Configuration
```
vlan 10
  name Sales
  state active

interface GigabitEthernet0/1
  switchport mode access
  switchport access vlan 10

interface GigabitEthernet0/24
  switchport mode trunk
  switchport trunk allowed vlan 10,20,30
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Tab | Command completion |
| ? | Context-sensitive help |
| Up Arrow | Previous command |
| Down Arrow | Next command |
| Ctrl+C | Cancel current command |
| Ctrl+Z | Exit to privileged mode |
| Ctrl+A | Move to beginning of line |
| Ctrl+E | Move to end of line |
| Ctrl+U | Delete from cursor to start |
| Ctrl+W | Delete previous word |

## Pagination (--More--)

Long output is paginated:
- **Space**: Next page
- **Enter**: Next line
- **Q**: Quit viewing

## Boot Sequence

The terminal simulates a realistic Cisco boot sequence including:
- Bootstrap loader messages
- Flash loading
- IOS version information
- Hardware initialization

## Recent Improvements

### Enhanced Tab Completion
- Hierarchical subcommand support
- Context-aware completions per mode
- Multi-level command path tracking

Example:
- Type `sh` + Tab → `show`
- Type `show run` + Tab → `show running-config`
- Type `interface Gi` + Tab → `interface GigabitEthernet`

## Extending the Terminal

### Adding Commands

Commands are defined in `src/terminal/cisco/commands/`:

1. **show.ts** - Show commands
2. **config.ts** - Configuration commands
3. **index.ts** - Command dispatcher

### Adding Tab Completion

Update `CISCO_COMMANDS` in `CiscoTerminal.tsx`:

```typescript
const CISCO_COMMANDS = {
  'mode-name': {
    '_root': ['command1', 'command2'],
    'command1': ['subcommand1', 'subcommand2'],
  },
};
```

### Command Result Interface

```typescript
interface CiscoCommandResult {
  output?: string;
  error?: string;
  exitCode: number;
  newMode?: CiscoMode;
  newInterface?: string;
  clearScreen?: boolean;
}
```

## Common Configuration Tasks

### Basic Router Setup
```
enable
configure terminal
hostname MyRouter
enable secret MyPassword
line console 0
  password console123
  login
line vty 0 4
  password vty123
  login
  transport input ssh
interface GigabitEthernet0/0
  ip address 192.168.1.1 255.255.255.0
  no shutdown
end
write memory
```

### Basic Switch Setup
```
enable
configure terminal
hostname MySwitch
vlan 10
  name Sales
vlan 20
  name IT
interface range GigabitEthernet0/1-12
  switchport mode access
  switchport access vlan 10
interface range GigabitEthernet0/13-24
  switchport mode access
  switchport access vlan 20
interface GigabitEthernet0/24
  switchport mode trunk
  switchport trunk allowed vlan 10,20
end
write memory
```

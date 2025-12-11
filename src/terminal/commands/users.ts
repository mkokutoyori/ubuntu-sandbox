import { CommandRegistry } from './index';

export const userCommands: CommandRegistry = {
  su: (args, state, fs) => {
    let targetUser = 'root';
    let loginShell = false;

    for (const arg of args) {
      if (arg === '-' || arg === '-l' || arg === '--login') {
        loginShell = true;
      } else if (!arg.startsWith('-')) {
        targetUser = arg;
      }
    }

    const user = fs.getUser(targetUser);
    if (!user) {
      return { output: '', error: `su: user ${targetUser} does not exist`, exitCode: 1 };
    }

    // In real su, password would be required
    // For simulation, we just switch
    return {
      output: '',
      exitCode: 0,
      newUser: targetUser,
      newPath: loginShell ? user.home : state.currentPath,
    };
  },

  useradd: (args, state, fs) => {
    if (state.currentUser !== 'root') {
      return { output: '', error: 'useradd: Permission denied', exitCode: 1 };
    }

    if (args.length === 0) {
      return { output: '', error: 'Usage: useradd [options] LOGIN', exitCode: 1 };
    }

    let createHome = false;
    let shell = '/bin/bash';
    let username = '';

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-m' || arg === '--create-home') {
        createHome = true;
      } else if ((arg === '-s' || arg === '--shell') && args[i + 1]) {
        shell = args[++i];
      } else if (!arg.startsWith('-')) {
        username = arg;
      }
    }

    if (!username) {
      return { output: '', error: 'useradd: no username provided', exitCode: 1 };
    }

    if (fs.getUser(username)) {
      return { output: '', error: `useradd: user '${username}' already exists`, exitCode: 1 };
    }

    fs.addUser(username, username);
    const user = fs.getUser(username);
    if (user) {
      user.shell = shell;
    }

    return { output: '', exitCode: 0 };
  },

  userdel: (args, state, fs) => {
    if (state.currentUser !== 'root') {
      return { output: '', error: 'userdel: Permission denied', exitCode: 1 };
    }

    let removeHome = false;
    let username = '';

    for (const arg of args) {
      if (arg === '-r' || arg === '--remove') {
        removeHome = true;
      } else if (!arg.startsWith('-')) {
        username = arg;
      }
    }

    if (!username) {
      return { output: '', error: 'Usage: userdel [options] LOGIN', exitCode: 1 };
    }

    if (!fs.getUser(username)) {
      return { output: '', error: `userdel: user '${username}' does not exist`, exitCode: 1 };
    }

    if (username === 'root') {
      return { output: '', error: 'userdel: cannot remove root user', exitCode: 1 };
    }

    if (removeHome) {
      fs.deleteNode(`/home/${username}`, true);
    }

    fs.deleteUser(username);

    return { output: '', exitCode: 0 };
  },

  passwd: (args, state, fs) => {
    let username = state.currentUser;

    if (args.length > 0 && !args[0].startsWith('-')) {
      username = args[0];
    }

    if (username !== state.currentUser && state.currentUser !== 'root') {
      return { output: '', error: 'passwd: Permission denied', exitCode: 1 };
    }

    const user = fs.getUser(username);
    if (!user) {
      return { output: '', error: `passwd: user '${username}' does not exist`, exitCode: 1 };
    }

    // Simulate password change
    return {
      output: `passwd: password updated successfully`,
      exitCode: 0,
    };
  },

  usermod: (args, state, fs) => {
    if (state.currentUser !== 'root') {
      return { output: '', error: 'usermod: Permission denied', exitCode: 1 };
    }

    let username = '';
    let groups: string[] = [];
    let appendGroups = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-a' || arg === '--append') {
        appendGroups = true;
      } else if ((arg === '-G' || arg === '--groups') && args[i + 1]) {
        groups = args[++i].split(',');
      } else if (!arg.startsWith('-')) {
        username = arg;
      }
    }

    if (!username) {
      return { output: '', error: 'Usage: usermod [options] LOGIN', exitCode: 1 };
    }

    const user = fs.getUser(username);
    if (!user) {
      return { output: '', error: `usermod: user '${username}' does not exist`, exitCode: 1 };
    }

    if (groups.length > 0) {
      for (const group of groups) {
        if (!fs.groups.has(group)) {
          return { output: '', error: `usermod: group '${group}' does not exist`, exitCode: 1 };
        }
        fs.addUserToGroup(username, group);
      }
    }

    return { output: '', exitCode: 0 };
  },

  groupadd: (args, state, fs) => {
    if (state.currentUser !== 'root') {
      return { output: '', error: 'groupadd: Permission denied', exitCode: 1 };
    }

    const groupName = args.filter(a => !a.startsWith('-'))[0];
    if (!groupName) {
      return { output: '', error: 'Usage: groupadd [options] GROUP', exitCode: 1 };
    }

    if (fs.groups.has(groupName)) {
      return { output: '', error: `groupadd: group '${groupName}' already exists`, exitCode: 1 };
    }

    const maxGid = Math.max(...Array.from(fs.groups.values()).map(g => g.gid));
    fs.groups.set(groupName, {
      name: groupName,
      gid: maxGid + 1,
      members: [],
    });

    // Update /etc/group
    const etcGroup = fs.getNode('/etc/group');
    if (etcGroup) {
      const lines: string[] = [];
      fs.groups.forEach(group => {
        lines.push(`${group.name}:x:${group.gid}:${group.members.join(',')}`);
      });
      etcGroup.content = lines.join('\n') + '\n';
    }

    return { output: '', exitCode: 0 };
  },

  groupdel: (args, state, fs) => {
    if (state.currentUser !== 'root') {
      return { output: '', error: 'groupdel: Permission denied', exitCode: 1 };
    }

    const groupName = args.filter(a => !a.startsWith('-'))[0];
    if (!groupName) {
      return { output: '', error: 'Usage: groupdel GROUP', exitCode: 1 };
    }

    if (!fs.groups.has(groupName)) {
      return { output: '', error: `groupdel: group '${groupName}' does not exist`, exitCode: 1 };
    }

    if (['root', 'sudo', 'adm'].includes(groupName)) {
      return { output: '', error: `groupdel: cannot remove system group '${groupName}'`, exitCode: 1 };
    }

    fs.groups.delete(groupName);

    return { output: '', exitCode: 0 };
  },

  groups: (args, state, fs) => {
    const username = args[0] || state.currentUser;
    const user = fs.getUser(username);

    if (!user) {
      return { output: '', error: `groups: '${username}': no such user`, exitCode: 1 };
    }

    return { output: `${username} : ${user.groups.join(' ')}`, exitCode: 0 };
  },

  w: (args, state) => {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const uptime = '5 days, 3:42';

    const header = ` ${time} up ${uptime},  1 user,  load average: 0.15, 0.10, 0.05`;
    const columns = 'USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT';
    const users = `${state.currentUser.padEnd(8)} pts/0    192.168.1.100    10:30    0.00s  0.05s  0.01s w`;

    return {
      output: [header, columns, users].join('\n'),
      exitCode: 0,
    };
  },

  who: (args, state) => {
    const now = new Date();
    const loginTime = now.toLocaleDateString('en-US', { month: 'short', day: '2-digit' }) + ' ' +
                     now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    
    return {
      output: `${state.currentUser}   pts/0        ${loginTime} (192.168.1.100)`,
      exitCode: 0,
    };
  },

  last: (args, state) => {
    const now = new Date();
    const loginTime = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit' }) + ' ' +
                     now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    const lines = [
      `${state.currentUser.padEnd(8)} pts/0        192.168.1.100    ${loginTime}   still logged in`,
      `${state.currentUser.padEnd(8)} pts/0        192.168.1.100    ${loginTime} - ${loginTime}  (00:30)`,
      `reboot   system boot  5.15.0-generic   ${loginTime}   still running`,
      '',
      'wtmp begins Mon Jan 15 00:00:00 2024',
    ];

    return { output: lines.join('\n'), exitCode: 0 };
  },

  finger: (args, state, fs) => {
    const username = args[0] || state.currentUser;
    const user = fs.getUser(username);

    if (!user) {
      return { output: '', error: `finger: ${username}: no such user.`, exitCode: 1 };
    }

    const lines = [
      `Login: ${user.username.padEnd(20)} Name: ${user.username}`,
      `Directory: ${user.home.padEnd(18)} Shell: ${user.shell}`,
      `On since Mon Jan 15 10:30 (UTC) on pts/0 from 192.168.1.100`,
      `No mail.`,
      `No Plan.`,
    ];

    return { output: lines.join('\n'), exitCode: 0 };
  },
};

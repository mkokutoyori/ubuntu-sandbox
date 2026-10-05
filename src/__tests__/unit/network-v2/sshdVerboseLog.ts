interface ShellDevice { executeCommand(command: string): Promise<string> }

export async function logSshdVerbosely(device: ShellDevice): Promise<void> {
  await device.executeCommand("sudo sed -i '/^#\\?LogLevel/d' /etc/ssh/sshd_config");
  await device.executeCommand('echo "LogLevel VERBOSE" | sudo tee -a /etc/ssh/sshd_config');
  await device.executeCommand('sudo systemctl restart ssh');
}

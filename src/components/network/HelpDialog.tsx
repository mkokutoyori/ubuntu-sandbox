import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface HelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Ubuntu Sandbox — Quick Reference</DialogTitle>
          <DialogDescription>
            Browser-based network simulator with Cisco IOS, Huawei VRP, Linux bash, Windows
            PowerShell and Oracle SQL*Plus terminals.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <section>
            <h3 className="font-semibold text-foreground mb-1">Building a topology</h3>
            <ul className="list-disc list-inside text-muted-foreground space-y-1">
              <li>Drag devices from the left panel onto the canvas.</li>
              <li>Click a device port and drag to another to cable them.</li>
              <li>Double-click a device to open its terminal.</li>
            </ul>
          </section>

          <section>
            <h3 className="font-semibold text-foreground mb-1">Toolbar actions</h3>
            <ul className="list-disc list-inside text-muted-foreground space-y-1">
              <li><strong>Save</strong> — persist the current topology to your browser (localStorage).</li>
              <li><strong>Open</strong> — load a previously saved topology from your browser.</li>
              <li><strong>Export</strong> — download the topology as a JSON file.</li>
              <li><strong>Import</strong> — load a topology from a local JSON file.</li>
              <li><strong>Reset</strong> — power-cycle every device on the canvas.</li>
              <li><strong>Logs</strong> — open the network event log panel.</li>
            </ul>
          </section>

          <section>
            <h3 className="font-semibold text-foreground mb-1">Supported protocols</h3>
            <p className="text-muted-foreground">
              OSPF, BGP, EIGRP, RIP, STP/RSTP, DHCP, IPSec, ACL, NAT, HSRP/VRRP/GLBP, IGMP, PIM,
              VXLAN, CDP/LLDP, LACP, BFD, SSH/SCP/SFTP, RADIUS, TACACS+ and more.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-foreground mb-1">Issues / feedback</h3>
            <p className="text-muted-foreground">
              File issues at <code className="text-xs">github.com/anthropics/claude-code/issues</code>
              or use the <code className="text-xs">/help</code> command in Claude Code.
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

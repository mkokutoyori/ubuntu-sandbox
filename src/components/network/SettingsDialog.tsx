import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SimulationClockControls } from './SimulationClockControls';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="settings-dialog">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Options of the simulation.</DialogDescription>
        </DialogHeader>
        <section>
          <h3 className="font-semibold text-foreground mb-2">Simulation time</h3>
          <p className="text-sm text-muted-foreground mb-3">
            Pause the clock of the whole infrastructure, run it faster than real time, or jump forward
            to see timers, schedulers, certificates and sessions expire.
          </p>
          <SimulationClockControls />
        </section>
      </DialogContent>
    </Dialog>
  );
}

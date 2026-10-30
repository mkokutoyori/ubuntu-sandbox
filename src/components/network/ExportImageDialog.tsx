import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  LOCALES, LOCALE_NAMES, getLocale, isLocale, setLocale, translate, type Locale, type MessageKey,
} from '@/i18n';
import {
  buildTopologyImageModel, renderTopologySvg, svgToBlob, svgToPngBlob,
} from '@/export/topologyImage';
import { downloadBlob } from '@/lib/download';
import { sanitizeFilename } from '@/lib/sanitizeFilename';
import type { Connection, NetworkDeviceUI } from '@/store/networkStore';

type ImageFormat = 'png' | 'svg';

const LEGEND_PREFERENCE_KEY = 'ubuntu-sandbox.export-image.legend';

function readLegendPreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(LEGEND_PREFERENCE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeLegendPreference(include: boolean): void {
  try {
    globalThis.localStorage?.setItem(LEGEND_PREFERENCE_KEY, include ? 'on' : 'off');
  } catch {
    return;
  }
}

interface ExportImageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  devices: readonly NetworkDeviceUI[];
  connections: readonly Connection[];
  onError: (title: string, description: string) => void;
}

export function ExportImageDialog({
  open, onOpenChange, projectName, devices, connections, onError,
}: ExportImageDialogProps) {
  const [includeLegend, setIncludeLegend] = useState(true);
  const [format, setFormat] = useState<ImageFormat>('png');
  const [locale, setLocaleState] = useState<Locale>('en');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIncludeLegend(readLegendPreference());
    setLocaleState(getLocale());
  }, [open]);

  const t = (key: MessageKey) => translate(locale, key);

  const image = useMemo(() => {
    if (!open) return null;
    const model = buildTopologyImageModel(projectName, devices, connections);
    return renderTopologySvg(model, { locale, legend: includeLegend });
  }, [open, projectName, devices, connections, locale, includeLegend]);

  const previewUrl = useMemo(
    () => (image ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(image.svg)}` : null),
    [image],
  );

  const empty = devices.length === 0;

  const changeLegend = (include: boolean) => {
    setIncludeLegend(include);
    writeLegendPreference(include);
  };

  const changeLocale = (value: string) => {
    if (!isLocale(value)) return;
    setLocaleState(value);
    setLocale(value);
  };

  const runExport = async () => {
    if (!image) return;
    setBusy(true);
    try {
      const base = sanitizeFilename(projectName, 'topology');
      const blob = format === 'png' ? await svgToPngBlob(image) : svgToBlob(image);
      downloadBlob(blob, `${base}.${format}`);
      onOpenChange(false);
    } catch (error) {
      onError(t('export.image.failed'), error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('export.image.title')}</DialogTitle>
          <DialogDescription>{t('export.image.description')}</DialogDescription>
        </DialogHeader>

        {empty ? (
          <p className="text-sm text-muted-foreground">{t('export.image.empty')}</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <Checkbox
                id="export-image-legend"
                checked={includeLegend}
                onCheckedChange={(value) => changeLegend(value === true)}
              />
              <div className="space-y-1">
                <Label htmlFor="export-image-legend">{t('export.image.legend')}</Label>
                <p className="text-xs text-muted-foreground">{t('export.image.legendHint')}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('export.image.format')}</Label>
                <RadioGroup value={format} onValueChange={(value) => setFormat(value as ImageFormat)}>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="png" id="export-image-png" />
                    <Label htmlFor="export-image-png">{t('export.image.formatPng')}</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="svg" id="export-image-svg" />
                    <Label htmlFor="export-image-svg">{t('export.image.formatSvg')}</Label>
                  </div>
                </RadioGroup>
              </div>
              <div className="space-y-2">
                <Label>{t('export.image.language')}</Label>
                <Select value={locale} onValueChange={changeLocale}>
                  <SelectTrigger aria-label={t('export.image.language')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCALES.map((code) => (
                      <SelectItem key={code} value={code}>{LOCALE_NAMES[code]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t('export.image.preview')}</Label>
              <div className="max-h-72 overflow-auto rounded-md border bg-white">
                {previewUrl && <img src={previewUrl} alt={t('export.image.preview')} className="w-full" />}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('export.image.cancel')}</Button>
          <Button onClick={runExport} disabled={empty || busy}>{t('export.image.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

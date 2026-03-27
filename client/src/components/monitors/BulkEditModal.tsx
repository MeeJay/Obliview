import { useState } from 'react';
import { X, Save } from 'lucide-react';
import type { Monitor } from '@obliview/shared';
import type { SettingsKey } from '@obliview/shared';
import { monitorsApi } from '@/api/monitors.api';
import { settingsApi } from '@/api/settings.api';
import { useGroupStore } from '@/store/groupStore';
import { useMonitorStore } from '@/store/monitorStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { GroupPicker } from '@/components/common/GroupPicker';
import { Checkbox } from '@/components/ui/Checkbox';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';

interface FieldState<T> {
  enabled: boolean;
  value: T;
}

interface BulkFormState {
  name: FieldState<string>;
  description: FieldState<string>;
  groupId: FieldState<number | null>;
  intervalSeconds: FieldState<string>;
  timeoutMs: FieldState<string>;
  retryIntervalSeconds: FieldState<string>;
  maxRetries: FieldState<string>;
  upsideDown: FieldState<boolean>;
}

function makeDefaultState(): BulkFormState {
  return {
    name:                 { enabled: false, value: '' },
    description:          { enabled: false, value: '' },
    groupId:              { enabled: false, value: null },
    intervalSeconds:      { enabled: false, value: '' },
    timeoutMs:            { enabled: false, value: '' },
    retryIntervalSeconds: { enabled: false, value: '' },
    maxRetries:           { enabled: false, value: '' },
    upsideDown:           { enabled: false, value: false },
  };
}

interface BulkEditModalProps {
  monitorIds: number[];
  isAgentSelection?: boolean;
  onClose: () => void;
}

/** Toggle row — checkbox label + field side by side */
function FieldRow({
  label,
  enabled,
  onToggle,
  children,
}: {
  label: string;
  enabled: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <Checkbox
          checked={enabled}
          onCheckedChange={onToggle}
        />
        <span className={cn('text-sm font-medium', enabled ? 'text-text-primary' : 'text-text-secondary')}>
          {label}
        </span>
      </label>
      <div className={cn('transition-opacity', !enabled && 'opacity-40 pointer-events-none')}>
        {children}
      </div>
    </div>
  );
}

export function BulkEditModal({ monitorIds, isAgentSelection, onClose }: BulkEditModalProps) {
  const { t } = useTranslation();
  const { tree } = useGroupStore();
  const agentGroupTree = tree.filter((node) => node.kind === 'agent');
  const monitorGroupTree = tree.filter((node) => node.kind === 'monitor');
  const groupTree = isAgentSelection ? agentGroupTree : monitorGroupTree;
  const { updateMonitor: updateStoreMonitor } = useMonitorStore();
  const [form, setForm] = useState<BulkFormState>(makeDefaultState);
  const [saving, setSaving] = useState(false);

  const setEnabled = <K extends keyof BulkFormState>(key: K, enabled: boolean) => {
    setForm((prev) => ({ ...prev, [key]: { ...prev[key], enabled } }));
  };

  const setValue = <K extends keyof BulkFormState>(key: K, value: BulkFormState[K]['value']) => {
    setForm((prev) => ({ ...prev, [key]: { ...prev[key], value } }));
  };

  const anyEnabled = Object.values(form).some((f) => f.enabled);

  const handleSubmit = async () => {
    // Direct monitor fields (table monitors)
    const directChanges: Partial<Monitor> = {};
    // Timing fields go via settings table (monitor-level override, highest priority)
    const timingOverrides: Array<{ key: SettingsKey; value: number }> = [];

    if (form.name.enabled && form.name.value.trim())
      directChanges.name = form.name.value.trim();
    if (form.description.enabled)
      directChanges.description = form.description.value.trim() || null;
    if (form.groupId.enabled)
      directChanges.groupId = form.groupId.value;
    if (form.upsideDown.enabled)
      directChanges.upsideDown = form.upsideDown.value;

    if (form.intervalSeconds.enabled && form.intervalSeconds.value)
      timingOverrides.push({ key: 'check_interval', value: parseInt(form.intervalSeconds.value, 10) });
    if (form.timeoutMs.enabled && form.timeoutMs.value)
      timingOverrides.push({ key: 'timeout', value: parseInt(form.timeoutMs.value, 10) });
    if (form.retryIntervalSeconds.enabled && form.retryIntervalSeconds.value)
      timingOverrides.push({ key: 'retry_interval', value: parseInt(form.retryIntervalSeconds.value, 10) });
    if (form.maxRetries.enabled && form.maxRetries.value)
      timingOverrides.push({ key: 'max_retries', value: parseInt(form.maxRetries.value, 10) });

    if (Object.keys(directChanges).length === 0 && timingOverrides.length === 0) {
      toast.error(t('bulkEdit.noFields'));
      return;
    }

    setSaving(true);
    try {
      const promises: Promise<unknown>[] = [];

      // Always call bulkUpdate (even with empty changes) to restart workers so
      // they pick up the new settings-table overrides
      promises.push(
        monitorsApi.bulkUpdate({ monitorIds, changes: directChanges })
          .then((updated) => updated.forEach((m) => updateStoreMonitor(m.id, m))),
      );

      // Write timing overrides into settings table at monitor scope
      if (timingOverrides.length > 0) {
        for (const monitorId of monitorIds) {
          promises.push(settingsApi.setBulk('monitor', String(monitorId), timingOverrides));
        }
      }

      await Promise.all(promises);
      toast.success(t('bulkEdit.success', { count: monitorIds.length }));
      onClose();
    } catch {
      toast.error(t('bulkEdit.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Panel */}
      <div className="w-full max-w-md rounded-xl border border-border bg-bg-secondary shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Bulk Edit</h2>
            <p className="text-xs text-text-secondary mt-0.5">
              {monitorIds.length} {isAgentSelection ? 'agent' : 'monitor'}{monitorIds.length > 1 ? 's' : ''} selected — check a field to override it
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">

          {/* ── General ── */}
          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
              General
            </h3>

            <FieldRow label="Name" enabled={form.name.enabled} onToggle={() => setEnabled('name', !form.name.enabled)}>
              <Input
                value={form.name.value}
                onChange={(e) => setValue('name', e.target.value)}
                placeholder="Keep current value"
                disabled={!form.name.enabled}
              />
            </FieldRow>

            <FieldRow label="Description" enabled={form.description.enabled} onToggle={() => setEnabled('description', !form.description.enabled)}>
              <Input
                value={form.description.value}
                onChange={(e) => setValue('description', e.target.value)}
                placeholder="Keep current value"
                disabled={!form.description.enabled}
              />
            </FieldRow>

            <FieldRow label="Group" enabled={form.groupId.enabled} onToggle={() => setEnabled('groupId', !form.groupId.enabled)}>
              <GroupPicker
                value={form.groupId.value}
                onChange={(id) => setValue('groupId', id)}
                tree={groupTree}
                placeholder="No group"
              />
            </FieldRow>
          </section>

          {/* ── Timing (monitor only) ── */}
          {!isAgentSelection && (
            <section className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                Timing
              </h3>

              <div className="grid grid-cols-2 gap-4">
                <FieldRow
                  label="Check Interval (s)"
                  enabled={form.intervalSeconds.enabled}
                  onToggle={() => setEnabled('intervalSeconds', !form.intervalSeconds.enabled)}
                >
                  <Input
                    type="number"
                    min={1}
                    max={86400}
                    value={form.intervalSeconds.value}
                    onChange={(e) => setValue('intervalSeconds', e.target.value)}
                    placeholder="Keep"
                    disabled={!form.intervalSeconds.enabled}
                  />
                </FieldRow>

                <FieldRow
                  label="Timeout (ms)"
                  enabled={form.timeoutMs.enabled}
                  onToggle={() => setEnabled('timeoutMs', !form.timeoutMs.enabled)}
                >
                  <Input
                    type="number"
                    min={1000}
                    max={60000}
                    value={form.timeoutMs.value}
                    onChange={(e) => setValue('timeoutMs', e.target.value)}
                    placeholder="Keep"
                    disabled={!form.timeoutMs.enabled}
                  />
                </FieldRow>

                <FieldRow
                  label="Retry Interval (s)"
                  enabled={form.retryIntervalSeconds.enabled}
                  onToggle={() => setEnabled('retryIntervalSeconds', !form.retryIntervalSeconds.enabled)}
                >
                  <Input
                    type="number"
                    min={1}
                    max={3600}
                    value={form.retryIntervalSeconds.value}
                    onChange={(e) => setValue('retryIntervalSeconds', e.target.value)}
                    placeholder="Keep"
                    disabled={!form.retryIntervalSeconds.enabled}
                  />
                </FieldRow>

                <FieldRow
                  label="Max Retries"
                  enabled={form.maxRetries.enabled}
                  onToggle={() => setEnabled('maxRetries', !form.maxRetries.enabled)}
                >
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    value={form.maxRetries.value}
                    onChange={(e) => setValue('maxRetries', e.target.value)}
                    placeholder="Keep"
                    disabled={!form.maxRetries.enabled}
                  />
                </FieldRow>
              </div>
            </section>
          )}

          {/* ── Behaviour (monitor only) ── */}
          {!isAgentSelection && (
            <section className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                Behaviour
              </h3>

              <FieldRow
                label="Upside Down Mode"
                enabled={form.upsideDown.enabled}
                onToggle={() => setEnabled('upsideDown', !form.upsideDown.enabled)}
              >
                <label className={cn('flex items-center gap-2 cursor-pointer', !form.upsideDown.enabled && 'pointer-events-none')}>
                  <Checkbox
                    checked={form.upsideDown.value}
                    onCheckedChange={(v) => setValue('upsideDown', v)}
                    disabled={!form.upsideDown.enabled}
                  />
                  <span className="text-sm text-text-secondary">Invert UP/DOWN logic</span>
                </label>
              </FieldRow>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border px-5 py-4 shrink-0">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            loading={saving}
            disabled={!anyEnabled}
          >
            <Save size={15} className="mr-1.5" />
            Apply to {monitorIds.length} {isAgentSelection ? 'agent' : 'monitor'}{monitorIds.length > 1 ? 's' : ''}
          </Button>
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { getSchedules, createSchedule, updateSchedule, deleteScheduleApi, triggerSchedule } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import type { Schedule } from '../api/types';

function cronToHuman(expr: string): string {
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  if (dom === '*' && mon === '*' && dow === '*') {
    if (hour === '*' && min === '*') return 'Every minute';
    if (hour === '*') return `Every hour at :${min.padStart(2, '0')}`;
    return `Daily at ${hour}:${min.padStart(2, '0')}`;
  }
  if (mon === '*' && dow !== '*') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayName = days[parseInt(dow)] ?? dow;
    return `${dayName} at ${hour}:${min.padStart(2, '0')}`;
  }
  return expr;
}

const typeBadgeColors: Record<string, string> = {
  agent: 'bg-purple-900/50 text-purple-300',
  command: 'bg-green-900/50 text-green-300',
  http: 'bg-blue-900/50 text-blue-300',
};

export function SchedulesPage() {
  const { data: schedules, loading, error, refresh } = usePolling(getSchedules, 10_000);
  const [showCreate, setShowCreate] = useState(false);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Create form state
  const [formName, setFormName] = useState('');
  const [formSchedule, setFormSchedule] = useState('');
  const [formType, setFormType] = useState<'agent' | 'command' | 'http'>('agent');
  const [formJob, setFormJob] = useState('');
  const [formCommand, setFormCommand] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    if (!formName.trim() || !formSchedule.trim()) return;
    setCreating(true);
    setFormError(null);
    try {
      const config: Record<string, unknown> = {};
      if (formType === 'agent') config.job = formJob;
      if (formType === 'command') config.command = formCommand;
      if (formType === 'http') config.url = formUrl;

      await createSchedule({
        name: formName.trim(),
        schedule: formSchedule.trim(),
        type: formType,
        config,
      });
      setShowCreate(false);
      setFormName(''); setFormSchedule(''); setFormJob(''); setFormCommand(''); setFormUrl('');
      refresh();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleTrigger(id: string) {
    setTriggering(id);
    try {
      await triggerSchedule(id);
      refresh();
    } catch { /* visible on refresh */ }
    finally { setTriggering(null); }
  }

  async function handleToggle(schedule: Schedule) {
    setToggling(schedule.id);
    try {
      await updateSchedule(schedule.id, { enabled: !schedule.enabled });
      refresh();
    } catch { /* visible on refresh */ }
    finally { setToggling(null); }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this schedule? This cannot be undone.')) return;
    setDeleting(id);
    try {
      await deleteScheduleApi(id);
      refresh();
    } catch { /* visible on refresh */ }
    finally { setDeleting(null); }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h2 className="text-sm font-medium text-white">Schedules</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          New Schedule
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 text-sm bg-red-900/50 text-red-300">{error}</div>
      )}

      <div className="flex-1 overflow-y-auto p-4">
        {loading && !schedules ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-gray-500">Loading...</p>
          </div>
        ) : schedules && schedules.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <p className="text-gray-500">No schedules configured</p>
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
            >
              Create your first schedule
            </button>
          </div>
        ) : (
          <div className="max-w-5xl mx-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-xs text-gray-500 uppercase tracking-wider">
                  <th className="pb-3 pr-4">Name</th>
                  <th className="pb-3 pr-4 w-44">Schedule</th>
                  <th className="pb-3 pr-4 w-24">Type</th>
                  <th className="pb-3 pr-4 w-20">Enabled</th>
                  <th className="pb-3 pr-4 w-40">Last Run</th>
                  <th className="pb-3 w-32 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {schedules?.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-800/50 transition-colors">
                    <td className="py-3 pr-4">
                      <div className="text-sm text-white font-medium">{s.name}</div>
                    </td>
                    <td className="py-3 pr-4">
                      <div className="text-sm text-gray-300">{cronToHuman(s.schedule)}</div>
                      <div className="text-xs text-gray-600 font-mono">{s.schedule}</div>
                    </td>
                    <td className="py-3 pr-4">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${typeBadgeColors[s.type] ?? 'bg-gray-700 text-gray-300'}`}>
                        {s.type}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      <button
                        onClick={() => handleToggle(s)}
                        disabled={toggling === s.id}
                        className={`relative w-9 h-5 rounded-full transition-colors ${
                          s.enabled ? 'bg-blue-600' : 'bg-gray-600'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                            s.enabled ? 'translate-x-4' : ''
                          }`}
                        />
                      </button>
                    </td>
                    <td className="py-3 pr-4">
                      {s.last_run_at ? (
                        <div>
                          <div className="text-xs text-gray-400">
                            {new Date(s.last_run_at).toLocaleString()}
                          </div>
                          <div className={`text-xs ${s.last_status === 'failed' ? 'text-red-400' : 'text-green-400'}`}>
                            {s.last_status}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-600">Never</span>
                      )}
                    </td>
                    <td className="py-3 text-right space-x-2">
                      <button
                        onClick={() => handleTrigger(s.id)}
                        disabled={triggering === s.id}
                        className="px-2 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
                      >
                        {triggering === s.id ? '...' : 'Run Now'}
                      </button>
                      <button
                        onClick={() => handleDelete(s.id)}
                        disabled={deleting === s.id}
                        className="px-2 py-1 rounded text-xs font-medium bg-red-900/50 hover:bg-red-800/50 text-red-300 transition-colors"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowCreate(false)} />
          <div className="relative bg-gray-800 rounded-xl shadow-2xl border border-gray-700 w-full max-w-lg mx-4">
            <div className="px-6 py-4 border-b border-gray-700 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">New Schedule</h3>
              <button onClick={() => setShowCreate(false)} className="text-gray-400 hover:text-white">&times;</button>
            </div>
            <div className="px-6 py-4 space-y-4">
              {formError && <div className="px-3 py-2 rounded bg-red-900/50 text-red-300 text-sm">{formError}</div>}

              <div>
                <label className="block text-sm text-gray-400 mb-1">Name</label>
                <input type="text" value={formName} onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Daily summary"
                  className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Cron Expression</label>
                <input type="text" value={formSchedule} onChange={(e) => setFormSchedule(e.target.value)}
                  placeholder="0 9 * * * (every day at 9am)"
                  className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                {formSchedule && (
                  <p className="text-xs text-gray-500 mt-1">{cronToHuman(formSchedule)}</p>
                )}
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Type</label>
                <select value={formType} onChange={(e) => setFormType(e.target.value as typeof formType)}
                  className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="agent">Agent (AI task)</option>
                  <option value="command">Command (shell)</option>
                  <option value="http">HTTP request</option>
                </select>
              </div>

              {formType === 'agent' && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Job Description</label>
                  <textarea value={formJob} onChange={(e) => setFormJob(e.target.value)}
                    placeholder="Summarize today's activity and notable events"
                    rows={3}
                    className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y" />
                </div>
              )}

              {formType === 'command' && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Command</label>
                  <input type="text" value={formCommand} onChange={(e) => setFormCommand(e.target.value)}
                    placeholder="kubectl get pods -n bakerst"
                    className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              )}

              {formType === 'http' && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">URL</label>
                  <input type="text" value={formUrl} onChange={(e) => setFormUrl(e.target.value)}
                    placeholder="https://api.example.com/check"
                    className="w-full rounded bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-gray-100 font-mono placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-700 flex justify-end gap-3">
              <button onClick={() => setShowCreate(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">Cancel</button>
              <button onClick={handleCreate}
                disabled={creating || !formName.trim() || !formSchedule.trim()}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  creating || !formName.trim() || !formSchedule.trim()
                    ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700 text-white'
                }`}>
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

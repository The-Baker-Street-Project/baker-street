import type { JobStatus } from '../../api/types';
import { StatusBadge } from './StatusBadge';

interface JobTableProps {
  jobs: JobStatus[];
  selectedId?: string;
  onSelect: (job: JobStatus) => void;
}

function duration(job: JobStatus): string {
  const ms = job.durationMs;
  if (ms == null) {
    if (job.status === 'running' || job.status === 'received') return '...';
    return '-';
  }
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function JobTable({ jobs, selectedId, onSelect }: JobTableProps) {
  if (jobs.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-600">No jobs found</p>
      </div>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-800 text-gray-500 text-left">
          <th className="px-4 py-3 font-medium">ID</th>
          <th className="px-4 py-3 font-medium">Type</th>
          <th className="px-4 py-3 font-medium">Status</th>
          <th className="px-4 py-3 font-medium">Duration</th>
          <th className="px-4 py-3 font-medium">Created</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr
            key={job.jobId}
            onClick={() => onSelect(job)}
            className={`border-b border-gray-800/50 cursor-pointer transition-colors ${
              job.jobId === selectedId ? 'bg-gray-800/50' : 'hover:bg-gray-800/30'
            }`}
          >
            <td className="px-4 py-3 font-mono text-xs text-gray-400">{job.jobId.slice(0, 8)}</td>
            <td className="px-4 py-3 text-gray-300">{job.type}</td>
            <td className="px-4 py-3"><StatusBadge status={job.status} /></td>
            <td className="px-4 py-3 text-gray-400">{duration(job)}</td>
            <td className="px-4 py-3 text-gray-400">{new Date(job.receivedAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

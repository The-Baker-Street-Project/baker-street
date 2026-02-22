import type { JobStatus } from '../../api/types';
import { StatusBadge } from './StatusBadge';

interface JobDetailProps {
  job: JobStatus;
  onClose: () => void;
}

export function JobDetail({ job, onClose }: JobDetailProps) {
  return (
    <div className="border-l border-gray-800 w-96 overflow-y-auto bg-gray-900/50 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-white">Job Detail</h3>
        <button onClick={onClose} className="text-gray-500 hover:text-white text-sm">Close</button>
      </div>

      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-gray-500">ID</dt>
          <dd className="text-gray-200 font-mono text-xs break-all">{job.jobId}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Type</dt>
          <dd className="text-gray-200">{job.type || '-'}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Status</dt>
          <dd><StatusBadge status={job.status} /></dd>
        </div>
        <div>
          <dt className="text-gray-500">Created</dt>
          <dd className="text-gray-200">{job.receivedAt ? new Date(job.receivedAt).toLocaleString() : '-'}</dd>
        </div>
        {job.completedAt && (
          <div>
            <dt className="text-gray-500">Completed</dt>
            <dd className="text-gray-200">{new Date(job.completedAt).toLocaleString()}</dd>
          </div>
        )}
        {job.durationMs != null && (
          <div>
            <dt className="text-gray-500">Duration</dt>
            <dd className="text-gray-200">{job.durationMs < 1000 ? `${job.durationMs}ms` : `${(job.durationMs / 1000).toFixed(1)}s`}</dd>
          </div>
        )}
        {job.result && (
          <div>
            <dt className="text-gray-500">Result</dt>
            <dd className="text-gray-200 bg-gray-800 rounded-lg p-3 text-xs whitespace-pre-wrap break-words max-h-96 overflow-y-auto">{job.result}</dd>
          </div>
        )}
        {job.error && (
          <div>
            <dt className="text-gray-500">Error</dt>
            <dd className="text-red-400 bg-gray-800 rounded-lg p-3 text-xs whitespace-pre-wrap break-words">{job.error}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

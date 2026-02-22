import { useState } from 'react';
import { usePolling } from '../hooks/usePolling';
import { getJobs } from '../api/client';
import { JobTable } from '../components/jobs/JobTable';
import { JobDetail } from '../components/jobs/JobDetail';
import type { JobStatus } from '../api/types';

export function JobsPage() {
  const { data: jobs, loading, refresh } = usePolling(getJobs, 5000);
  const [selected, setSelected] = useState<JobStatus | null>(null);

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-medium text-white">Jobs</h2>
          <button
            onClick={refresh}
            className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          >
            Refresh
          </button>
        </div>
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <p className="text-gray-500">Loading...</p>
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <JobTable
              jobs={jobs ?? []}
              selectedId={selected?.jobId}
              onSelect={setSelected}
            />
          </div>
        )}
      </div>

      {selected && (
        <JobDetail job={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

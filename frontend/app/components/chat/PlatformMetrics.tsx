import { useEffect, useState } from 'react';

interface Metrics {
  totalUsers: number;
  websitesCreated: number;
}

export function PlatformMetrics() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  useEffect(() => {
    fetch('/api/metrics')
      .then((res) => res.json())
      .then((data) => setMetrics(data))
      .catch(() => {});
  }, []);

  if (!metrics || (metrics.totalUsers === 0 && metrics.websitesCreated === 0)) {
    return null;
  }

  return (
    <div className="flex items-center justify-center gap-8 mb-6">
      <div className="text-center">
        <div className="text-2xl font-bold text-bolt-elements-textPrimary">
          {metrics.totalUsers.toLocaleString()}
        </div>
        <div className="text-xs text-bolt-elements-textTertiary">Users</div>
      </div>
      <div className="w-px h-8 bg-bolt-elements-borderColor" />
      <div className="text-center">
        <div className="text-2xl font-bold text-bolt-elements-textPrimary">
          {metrics.websitesCreated.toLocaleString()}
        </div>
        <div className="text-xs text-bolt-elements-textTertiary">Websites Created</div>
      </div>
    </div>
  );
}

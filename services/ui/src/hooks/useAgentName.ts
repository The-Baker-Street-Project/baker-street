import { useState, useEffect } from 'react';
import { getPing } from '../api/client';

export function useAgentName(fallback = 'Baker Street'): string {
  const [name, setName] = useState(fallback);
  useEffect(() => {
    getPing().then(d => setName(d.name ?? fallback)).catch(() => {});
  }, []);
  return name;
}

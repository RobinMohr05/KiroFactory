import { useEffect, useRef, useState } from 'react';
import { apiFetch, formatErrorTime } from '../utils/api';
import type { WslDiagnosticLine } from '../types';

const MAX_LINES_RENDERED = 2000;

const SOURCE_LABELS: Record<WslDiagnosticLine['source'], string> = {
  'docker-events': 'docker events',
  dmesg: 'dmesg',
  'container-log': 'container log',
};

/**
 * "WSL/Docker Logs" sub-tab of the Errors panel — live view of the backend's
 * always-on WSL/Docker diagnostics collector (see
 * backend/src/wsl-diagnostics-collector.ts). Fetches the current ring buffer
 * on mount, then subscribes to the WebSocket for new lines as they arrive.
 *
 * This exists specifically to close an observability gap hit repeatedly
 * during real local-session-failure investigations: by the time a session
 * failure was reported, the evidence needed to diagnose it (which
 * signal/process killed a container, a kernel-level crash trace) was already
 * gone — Docker containers here self-delete their logs on exit (--rm), and
 * docker events/dmesg don't persist history retroactively. This tab shows
 * the always-on capture so that evidence is available after the fact instead
 * of needing to react fast enough to catch it live.
 */
export function WslDiagnosticsPanel() {
  const [lines, setLines] = useState<WslDiagnosticLine[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/errors/wsl-diagnostics');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: WslDiagnosticLine[] = await res.json();
        if (!cancelled) setLines(data);
      } catch (e: any) {
        if (!cancelled) setLoadError(e.message || 'Failed to load WSL/Docker diagnostics');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const line: WslDiagnosticLine | undefined = detail?.line;
      if (!line) return;
      setLines(prev => {
        const next = [...prev, line];
        return next.length > MAX_LINES_RENDERED ? next.slice(next.length - MAX_LINES_RENDERED) : next;
      });
    };
    window.addEventListener('ws-wsl-diagnostic-line', handler);
    return () => window.removeEventListener('ws-wsl-diagnostic-line', handler);
  }, []);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    // Only keep auto-scrolling if the user is already near the bottom —
    // scrolling up to read history should not get yanked back down by the
    // next incoming line.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(nearBottom);
  };

  return (
    <div className="wsl-diagnostics-panel">
      <div className="wsl-diagnostics-toolbar">
        <span className="wsl-diagnostics-hint">
          Live capture of docker events, dmesg, and per-container logs from the local kirofactory-docker WSL distro.
        </span>
      </div>
      {loadError && (
        <div className="wsl-diagnostics-error">Failed to load: {loadError}</div>
      )}
      <div className="wsl-diagnostics-list" ref={listRef} onScroll={handleScroll}>
        {lines.length === 0 && !loadError ? (
          <div className="errors-empty">
            No WSL/Docker diagnostics captured yet. This tab only has data when local (WSL/Docker) worker
            mode is configured on this machine — see ARCHITECTURE.md §12.
          </div>
        ) : (
          lines.map(line => (
            <div key={line.id} className={`wsl-diagnostic-line wsl-diagnostic-line-${line.source}`}>
              <span className="wsl-diagnostic-time">{formatErrorTime(line.timestamp)}</span>
              <span className={`wsl-diagnostic-source wsl-diagnostic-source-${line.source}`}>{SOURCE_LABELS[line.source]}</span>
              {line.containerName && <span className="wsl-diagnostic-container">{line.containerName}</span>}
              <span className="wsl-diagnostic-text">{line.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Card, Button, Space, Tag, Spin, Empty, Alert, message } from 'antd';
import { apiFetch, formatErrorTime } from '../utils/api';
import type { Session, TurnRecord, OutputEntry } from '../types';

/**
 * A single pooled-session card in the AutoScaler detail view (task #1969).
 *
 * Renders the session name + status badge, plus three independent lazy actions:
 *   - "Load runs" (relabels to "Refresh" after the first load) fetches the
 *     session's turns from GET /api/sessions/:id/turns and renders them inline.
 *   - "Copy logs" / "Download logs" each lazily fetch GET /api/sessions/:id/output
 *     and copy the assembled log text to the clipboard / save it as a .log file.
 *
 * Nothing is fetched on mount — runs and logs load only on their own button click.
 * All state is local to this component, so cards are independent of one another.
 */

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

/** Assemble the raw log text from the session's output entries. */
function outputToText(output: OutputEntry[]): string {
  return output.map(entry => entry.text).join('\n');
}

/** Sanitize a session name for safe use in a filename. */
function sanitizeForFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'session';
}

export function AutoScalerSessionCard({ session }: { session: Session }) {
  const isRunning = session.status === 'running';

  // Runs (turns) state — per-card, lazily loaded on "Load runs".
  const [runs, setRuns] = useState<TurnRecord[] | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);

  // Logs (output) state — per-card, lazily fetched on Copy/Download.
  const [logsBusy, setLogsBusy] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsNotice, setLogsNotice] = useState<string | null>(null);

  const loadRuns = async () => {
    setRunsLoading(true);
    setRunsError(null);
    try {
      const res = await apiFetch(`/api/sessions/${session.id}/turns`);
      if (!res.ok) {
        setRunsError('Failed to load runs');
        return;
      }
      const data: TurnRecord[] = await res.json();
      setRuns(Array.isArray(data) ? data : []);
    } catch {
      setRunsError('Failed to load runs');
    } finally {
      setRunsLoading(false);
    }
  };

  /** Fetch the session output buffer as raw text, or null on failure. */
  const fetchLogText = async (): Promise<string | null> => {
    const res = await apiFetch(`/api/sessions/${session.id}/output`);
    if (!res.ok) throw new Error('fetch failed');
    const data: OutputEntry[] = await res.json();
    return outputToText(Array.isArray(data) ? data : []);
  };

  const handleCopyLogs = async () => {
    setLogsBusy(true);
    setLogsError(null);
    setLogsNotice(null);
    try {
      const text = await fetchLogText();
      if (!text) {
        setLogsNotice('No logs available');
        return;
      }
      await navigator.clipboard.writeText(text);
      message.success('Logs copied to clipboard');
    } catch {
      setLogsError('Failed to load logs');
    } finally {
      setLogsBusy(false);
    }
  };

  const handleDownloadLogs = async () => {
    setLogsBusy(true);
    setLogsError(null);
    setLogsNotice(null);
    try {
      const text = await fetchLogText();
      if (!text) {
        setLogsNotice('No logs available');
        return; // download is a no-op when there's nothing to save
      }
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${session.id}-${sanitizeForFilename(session.name)}.log`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setLogsError('Failed to load logs');
    } finally {
      setLogsBusy(false);
    }
  };

  return (
    <Card
      size="small"
      className="autoscaler-session-card"
      data-session-id={session.id}
      title={
        <Space>
          <span className="autoscaler-session-name">{session.name}</span>
          <Tag color={isRunning ? 'green' : 'default'}>{isRunning ? 'running' : 'stopped'}</Tag>
        </Space>
      }
    >
      <Space wrap>
        <Button size="small" loading={runsLoading} onClick={loadRuns}>
          {runs !== null ? 'Refresh' : 'Load runs'}
        </Button>
        <Button size="small" loading={logsBusy} onClick={handleCopyLogs}>
          Copy logs
        </Button>
        <Button size="small" loading={logsBusy} onClick={handleDownloadLogs}>
          Download logs
        </Button>
      </Space>

      {logsNotice && (
        <Alert style={{ marginTop: 8 }} type="info" showIcon message={logsNotice} />
      )}
      {logsError && (
        <Alert style={{ marginTop: 8 }} type="error" showIcon message={logsError} />
      )}

      <div className="autoscaler-session-card-runs" style={{ marginTop: 8 }}>
        {runsLoading && <Spin size="small" />}
        {!runsLoading && runsError && (
          <Alert type="error" showIcon message={runsError} />
        )}
        {!runsLoading && !runsError && runs !== null && runs.length === 0 && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No runs yet" />
        )}
        {!runsLoading && !runsError && runs !== null && runs.length > 0 && (
          <ul className="autoscaler-session-card-run-list">
            {runs.map(run => (
              <li key={run.number} className="autoscaler-session-card-run-row">
                <span className="autoscaler-run-number">#{run.number}</span>
                <span className="autoscaler-run-verdict">{run.verdict ?? '—'}</span>
                <span className="autoscaler-run-started">{formatErrorTime(run.startedAt)}</span>
                <span className="autoscaler-run-duration">{formatDurationMs(run.durationMs)}</span>
                {run.taskTitle && <span className="autoscaler-run-task">{run.taskTitle}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

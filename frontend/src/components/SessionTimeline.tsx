import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '../utils/api';
import type { TurnRecord, TimelineTurn, ToolCallEntry, TurnEndSummary } from '../types';

interface SessionTimelineProps {
  sessionId: number;
  sessionStatus: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function verdictClass(verdict: string | null): string {
  if (!verdict) return '';
  return `verdict-${verdict}`;
}

/** Hook that ticks every second while there's an active turn, returning current elapsed ms. */
function useElapsedTime(activeTurn: TimelineTurn | undefined): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!activeTurn?.startedAt) {
      setElapsed(0);
      return;
    }
    const start = new Date(activeTurn.startedAt).getTime();
    const update = () => setElapsed(Date.now() - start);
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [activeTurn?.startedAt, activeTurn?.isActive]);

  return elapsed;
}

export function SessionTimeline({ sessionId, sessionStatus: _sessionStatus }: SessionTimelineProps) {
  const [turns, setTurns] = useState<TimelineTurn[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // Track active turn for elapsed time display
  const activeTurn = turns.find(t => t.isActive);
  const elapsed = useElapsedTime(activeTurn);

  // Fetch persisted turns on mount / sessionId change
  useEffect(() => {
    setTurns([]);
    setLoading(true);
    setExpandedToolCalls(new Set());

    const abortController = new AbortController();

    (async () => {
      try {
        const res = await apiFetch(`/api/sessions/${sessionId}/turns`, { signal: abortController.signal });
        if (abortController.signal.aborted) return;
        if (!res.ok) {
          setLoading(false);
          return;
        }
        const data: TurnRecord[] = await res.json();
        const mapped: TimelineTurn[] = data.map(t => ({
          ...t,
          toolCalls: [],
          isActive: false,
        }));
        // Merge fetched historical turns with any live turns that arrived
        // while the fetch was in-flight (avoiding duplicates by turn number).
        setTurns(prev => {
          const fetchedNumbers = new Set(mapped.map(t => t.number));
          const liveTurns = prev.filter(t => !fetchedNumbers.has(t.number));
          return [...mapped, ...liveTurns];
        });
      } catch (err: unknown) {
        if ((err as Error)?.name === 'AbortError') return;
        // ignore other fetch errors
      }
      if (!abortController.signal.aborted) {
        setLoading(false);
      }
    })();

    return () => { abortController.abort(); };
  }, [sessionId]);

  // Handle turn-start events
  const handleTurnStart = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.sessionId !== sessionId) return;

    const newTurn: TimelineTurn = {
      number: detail.turnNumber,
      startedAt: detail.startedAt,
      endedAt: null,
      credits: 0,
      costEur: 0,
      verdict: null,
      taskId: detail.taskId ?? null,
      taskTitle: detail.taskTitle ?? null,
      toolCallCount: 0,
      hasChanges: false,
      prUrl: null,
      branchName: null,
      durationMs: 0,
      toolCalls: [],
      isActive: true,
    };

    setTurns(prev => {
      if (prev.some(t => t.number === newTurn.number)) return prev;
      return [...prev, newTurn];
    });
  }, [sessionId]);

  // Handle turn-end events
  const handleTurnEnd = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.sessionId !== sessionId) return;

    const summary: TurnEndSummary = detail.summary;

    setTurns(prev => prev.map(turn => {
      if (turn.number !== detail.turnNumber) return turn;
      return {
        ...turn,
        endedAt: new Date().toISOString(),
        credits: summary.credits,
        costEur: summary.costEur,
        verdict: summary.verdict ?? null,
        durationMs: summary.durationMs,
        toolCallCount: summary.toolCallCount,
        hasChanges: summary.hasChanges,
        prUrl: summary.prUrl ?? null,
        branchName: summary.branchName ?? null,
        isActive: false,
      };
    }));
  }, [sessionId]);

  // Handle tool-call events
  const handleToolCall = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.sessionId !== sessionId) return;

    const newToolCall: ToolCallEntry = {
      id: detail.toolCallId,
      label: detail.label,
      icon: detail.icon,
      status: detail.status,
    };

    setTurns(prev => prev.map(turn => {
      if (turn.number !== detail.turnNumber) return turn;
      if (turn.toolCalls.some(tc => tc.id === newToolCall.id)) return turn; // deduplicate
      return {
        ...turn,
        toolCalls: [...turn.toolCalls, newToolCall],
      };
    }));
  }, [sessionId]);

  // Handle tool-call-update events
  const handleToolCallUpdate = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.sessionId !== sessionId) return;

    setTurns(prev => prev.map(turn => {
      if (turn.number !== detail.turnNumber) return turn;
      return {
        ...turn,
        toolCalls: turn.toolCalls.map(tc => {
          if (tc.id !== detail.toolCallId) return tc;
          return {
            ...tc,
            status: detail.status,
            output: detail.output,
            durationMs: detail.durationMs,
          };
        }),
      };
    }));
  }, [sessionId]);

  // Register WS event listeners
  useEffect(() => {
    window.addEventListener('ws-session-turn-start', handleTurnStart);
    window.addEventListener('ws-session-turn-end', handleTurnEnd);
    window.addEventListener('ws-session-tool-call', handleToolCall);
    window.addEventListener('ws-session-tool-call-update', handleToolCallUpdate);

    return () => {
      window.removeEventListener('ws-session-turn-start', handleTurnStart);
      window.removeEventListener('ws-session-turn-end', handleTurnEnd);
      window.removeEventListener('ws-session-tool-call', handleToolCall);
      window.removeEventListener('ws-session-tool-call-update', handleToolCallUpdate);
    };
  }, [handleTurnStart, handleTurnEnd, handleToolCall, handleToolCallUpdate]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [turns, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    setAutoScroll(atBottom);
  };

  const toggleToolCallOutput = (toolCallId: string) => {
    setExpandedToolCalls(prev => {
      const next = new Set(prev);
      if (next.has(toolCallId)) {
        next.delete(toolCallId);
      } else {
        next.add(toolCallId);
      }
      return next;
    });
  };

  if (loading && turns.length === 0) {
    return <div className="timeline-container"><div className="timeline-loading">Loading timeline...</div></div>;
  }

  if (turns.length === 0) {
    return (
      <div className="timeline-container">
        <div className="timeline-empty">
          <p>No turns recorded yet. Start the session to see agent activity.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="timeline-wrapper">
      <div className="timeline-container" ref={containerRef} onScroll={handleScroll}>
        {turns.map(turn => (
          <div key={turn.number} className="turn-section">
            <div className={`turn-header${turn.isActive ? ' turn-active' : ''}`}>
              <div className="turn-header-left">
                <span className="turn-number">Turn {turn.number}</span>
                {turn.taskTitle && <span className="turn-task-title">{turn.taskTitle}</span>}
              </div>
              <div className="turn-header-right">
                {turn.isActive ? (
                  <span className="turn-elapsed">
                    <span className="turn-running-dot"></span>
                    Running... {turn === activeTurn && elapsed > 0 ? formatDuration(elapsed) : ''}
                  </span>
                ) : (
                  <>
                    <span className="turn-duration">{formatDuration(turn.durationMs)}</span>
                    <span className="turn-credits">
                      {turn.credits.toFixed(2)} credits
                      <span className="turn-cost">€{turn.costEur.toFixed(2)}</span>
                    </span>
                    {turn.verdict && (
                      <span className={`turn-verdict-badge ${verdictClass(turn.verdict)}`}>
                        {turn.verdict}
                      </span>
                    )}
                    {turn.prUrl && (
                      <a
                        href={turn.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="turn-pr-link"
                        aria-label="PR"
                      >
                        PR
                      </a>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="turn-body">
              {turn.toolCalls.length === 0 && !turn.isActive && (
                <div className="turn-no-details">
                  {turn.toolCallCount} tool call{turn.toolCallCount !== 1 ? 's' : ''} executed
                </div>
              )}
              {turn.toolCalls.map(tc => (
                <div
                  key={tc.id}
                  className={`tool-call-card${tc.status === 'failed' ? ' tool-call-failed' : ''}${tc.status === 'running' ? ' tool-call-running' : ''}`}
                >
                  <div
                    className="tool-call-header"
                    onClick={() => tc.output && toggleToolCallOutput(tc.id)}
                    onKeyDown={(e) => { if (tc.output && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleToolCallOutput(tc.id); } }}
                    role={tc.output ? 'button' : undefined}
                    tabIndex={tc.output ? 0 : undefined}
                    aria-expanded={tc.output ? expandedToolCalls.has(tc.id) : undefined}
                  >
                    <span className="tool-call-icon">{tc.icon}</span>
                    <span className="tool-call-label">{tc.label}</span>
                    <span className={`tool-call-status tool-call-status-${tc.status}`}>
                      {tc.status === 'running' && <span className="tool-call-spinner"></span>}
                      {tc.status === 'completed' && '✓'}
                      {tc.status === 'failed' && '✗'}
                    </span>
                    {tc.durationMs != null && (
                      <span className="tool-call-duration">{formatDuration(tc.durationMs)}</span>
                    )}
                    {tc.output && (
                      <span className="tool-call-expand-icon">
                        {expandedToolCalls.has(tc.id) ? '▾' : '▸'}
                      </span>
                    )}
                  </div>
                  {tc.output && (
                    <div className={`tool-call-output${expandedToolCalls.has(tc.id) ? ' expanded' : ''}`}>
                      <pre>{tc.output}</pre>
                    </div>
                  )}
                </div>
              ))}
              {turn.isActive && (
                <div className="turn-thinking">
                  <span className="thinking-dot"></span>
                  <span className="thinking-dot"></span>
                  <span className="thinking-dot"></span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {!autoScroll && (
        <button
          className="scroll-to-bottom-btn"
          aria-label="Scroll to bottom"
          title="Scroll to bottom"
          onClick={() => {
            setAutoScroll(true);
            if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
          }}
        >
          ↓ New activity
        </button>
      )}
    </div>
  );
}

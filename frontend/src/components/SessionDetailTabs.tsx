import { useState, useRef, useEffect } from 'react';
import { SessionTimeline } from './SessionTimeline';
import type { OutputEntry } from '../types';

interface SessionDetailTabsProps {
  sessionId: number;
  sessionStatus: string;
  output: OutputEntry[];
}

type DetailTab = 'timeline' | 'rawlog';

/** Render one output entry exactly as displayed, for both the DOM and clipboard text. */
function formatOutputLine(entry: OutputEntry): string {
  const ts = entry.timestamp ? `[${new Date(entry.timestamp).toLocaleTimeString()}] ` : '';
  return `${ts}${entry.text}`;
}

export function SessionDetailTabs({ sessionId, sessionStatus, output }: SessionDetailTabsProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>('timeline');
  const rawLogRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  // Auto-scroll the raw log when new output arrives and autoScroll is enabled
  useEffect(() => {
    if (autoScroll && rawLogRef.current && activeTab === 'rawlog') {
      rawLogRef.current.scrollTop = rawLogRef.current.scrollHeight;
    }
  }, [output, autoScroll, activeTab]);

  const handleRawLogScroll = () => {
    if (!rawLogRef.current) return;
    const el = rawLogRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    setAutoScroll(atBottom);
  };

  /** All currently-visible log lines as plain text, in display order. */
  const getLogText = () => output.map(formatOutputLine).join('\n');

  const handleCopyAll = async () => {
    try {
      await navigator.clipboard.writeText(getLogText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable/denied — fall back to a manual select-all
      // the user can Ctrl+C themselves, same as the keyboard shortcut below.
      if (rawLogRef.current) {
        const range = document.createRange();
        range.selectNodeContents(rawLogRef.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  };

  /**
   * Ctrl/Cmd+A inside the log: select only the log's own text instead of the
   * whole page (the browser default for Ctrl+A is document-wide selection,
   * which is rarely what someone hovering a scrollable log panel wants).
   * Ctrl/Cmd+C falls through to the browser's native copy of whatever is
   * currently selected — no extra handling needed there since `user-select:
   * text` is already set on this element and native copy already works on
   * a real selection; this handler only needs to own Ctrl+A's target.
   */
  const handleRawLogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (!rawLogRef.current) return;
      const range = document.createRange();
      range.selectNodeContents(rawLogRef.current);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };

  return (
    <div className="session-detail-tabs-wrapper">
      <div className="session-detail-tabs" role="tablist" aria-label="Session detail views">
        <button
          role="tab"
          aria-selected={activeTab === 'timeline'}
          className={`session-detail-tab${activeTab === 'timeline' ? ' active' : ''}`}
          onClick={() => setActiveTab('timeline')}
        >
          Timeline
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'rawlog'}
          className={`session-detail-tab${activeTab === 'rawlog' ? ' active' : ''}`}
          onClick={() => setActiveTab('rawlog')}
        >
          Raw Log
        </button>
        {activeTab === 'rawlog' && (
          <button
            type="button"
            className="btn btn-secondary btn-sm session-log-copy-btn"
            onClick={handleCopyAll}
            disabled={output.length === 0}
            title="Copy all visible log lines to the clipboard"
          >
            {copied ? 'Copied ✓' : 'Copy log'}
          </button>
        )}
      </div>

      <div className="session-detail-tab-content">
        {activeTab === 'timeline' && (
          <SessionTimeline sessionId={sessionId} sessionStatus={sessionStatus} />
        )}
        {activeTab === 'rawlog' && (
          <div
            className="session-output"
            role="log"
            aria-live="polite"
            aria-label="Agent output"
            tabIndex={0}
            ref={rawLogRef}
            onScroll={handleRawLogScroll}
            onKeyDown={handleRawLogKeyDown}
          >
            <pre className="output-pre">
              {output.map((entry, i) => (
                <span key={i} className={`output-line output-${entry.stream}`}>
                  {formatOutputLine(entry)}{'\n'}
                </span>
              ))}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

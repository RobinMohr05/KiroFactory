import { useState, useRef, useEffect } from 'react';
import { SessionTimeline } from './SessionTimeline';
import type { OutputEntry } from '../types';

interface SessionDetailTabsProps {
  sessionId: number;
  sessionStatus: string;
  output: OutputEntry[];
  autoScroll: boolean;
  onScroll: () => void;
}

type DetailTab = 'timeline' | 'rawlog';

export function SessionDetailTabs({ sessionId, sessionStatus, output, autoScroll, onScroll }: SessionDetailTabsProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>('timeline');
  const rawLogRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the raw log when new output arrives and autoScroll is enabled
  useEffect(() => {
    if (autoScroll && rawLogRef.current && activeTab === 'rawlog') {
      rawLogRef.current.scrollTop = rawLogRef.current.scrollHeight;
    }
  }, [output, autoScroll, activeTab]);

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
            onScroll={onScroll}
          >
            <pre className="output-pre">
              {output.map((entry, i) => (
                <span key={i} className={`output-line output-${entry.stream}`}>
                  {entry.timestamp ? `[${new Date(entry.timestamp).toLocaleTimeString()}] ` : ''}{entry.text}{'\n'}
                </span>
              ))}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

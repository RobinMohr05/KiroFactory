import { useEffect, useState, useMemo, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';

interface DailyBreakdown {
  date: string;
  credits: number;
  costEur: number;
}

interface SessionBreakdown {
  sessionId: number;
  sessionName: string;
  agent: string;
  tabId: number | null;
  credits: number;
  costEur: number;
  turns: number;
  firstTurn: string;
  lastTurn: string;
}

interface UsageData {
  totalCredits: number;
  totalCostEur: number;
  dailyBreakdown: DailyBreakdown[];
  sessionBreakdown: SessionBreakdown[];
}

type SortKey = 'sessionName' | 'agent' | 'credits' | 'costEur' | 'turns' | 'firstTurn';
type SortDir = 'asc' | 'desc';

export function UsagePanel() {
  const { tabs, setActiveView, setActiveSessionId } = useApp();
  const [usageData, setUsageData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('credits');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Current month date range
  const { from, to, monthLabel } = useMemo(() => {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString();
    const monthLabel = now.toLocaleString('default', { month: 'long', year: 'numeric' });
    return { from, to, monthLabel };
  }, []);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from, to });
      if (selectedTabId !== null) params.set('tabId', String(selectedTabId));
      const res = await apiFetch(`/api/usage?${params.toString()}`);
      if (!res.ok) {
        setError('Failed to load usage data');
        return;
      }
      const data: UsageData = await res.json();
      setUsageData(data);
    } catch {
      setError('Failed to load usage data');
    } finally {
      setLoading(false);
    }
  }, [from, to, selectedTabId]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  // Listen for session-updated events to refetch usage when credits change
  useEffect(() => {
    const handler = () => { fetchUsage(); };
    const interval = setInterval(handler, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, [fetchUsage]);

  const sortedSessions = useMemo(() => {
    if (!usageData) return [];
    const sorted = [...usageData.sessionBreakdown];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'sessionName':
          cmp = a.sessionName.localeCompare(b.sessionName);
          break;
        case 'agent':
          cmp = a.agent.localeCompare(b.agent);
          break;
        case 'credits':
          cmp = a.credits - b.credits;
          break;
        case 'costEur':
          cmp = a.costEur - b.costEur;
          break;
        case 'turns':
          cmp = a.turns - b.turns;
          break;
        case 'firstTurn':
          cmp = a.firstTurn.localeCompare(b.firstTurn);
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [usageData, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const handleSessionClick = (sessionId: number) => {
    setActiveSessionId(sessionId);
    setActiveView('sessions');
  };

  const maxCreditsPerDay = useMemo(() => {
    if (!usageData || usageData.dailyBreakdown.length === 0) return 1;
    return Math.max(...usageData.dailyBreakdown.map(d => d.credits));
  }, [usageData]);

  // Generate all days of the month for the chart
  const daysInMonth = useMemo(() => {
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return Array.from({ length: lastDay }, (_, i) => i + 1);
  }, []);

  const dailyCreditsMap = useMemo(() => {
    if (!usageData) return new Map<number, DailyBreakdown>();
    const map = new Map<number, DailyBreakdown>();
    for (const d of usageData.dailyBreakdown) {
      const day = new Date(d.date).getDate();
      map.set(day, d);
    }
    return map;
  }, [usageData]);

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  if (loading && !usageData) {
    return (
      <section id="panel-usage" role="tabpanel" aria-labelledby="tab-usage">
        <div className="usage-layout">
          <div className="usage-loading">Loading usage data…</div>
        </div>
      </section>
    );
  }

  if (error && !usageData) {
    return (
      <section id="panel-usage" role="tabpanel" aria-labelledby="tab-usage">
        <div className="usage-layout">
          <div className="usage-error">{error}</div>
        </div>
      </section>
    );
  }

  return (
    <section id="panel-usage" role="tabpanel" aria-labelledby="tab-usage">
      <div className="usage-layout">
        {/* Summary Header */}
        <div className="usage-header">
          <div className="usage-summary">
            <h2 className="usage-heading">{monthLabel}</h2>
            <div className="usage-totals">
              <span className="usage-total-credits">{(usageData?.totalCredits ?? 0).toFixed(2)} credits</span>
              <span className="usage-total-cost">EUR {(usageData?.totalCostEur ?? 0).toFixed(2)}</span>
            </div>
          </div>
          <div className="usage-filters">
            <select
              className="usage-tab-filter"
              value={selectedTabId ?? ''}
              onChange={e => setSelectedTabId(e.target.value ? Number(e.target.value) : null)}
              aria-label="Filter by tab"
            >
              <option value="">All Tabs</option>
              {tabs.map(tab => (
                <option key={tab.id} value={tab.id}>{tab.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Daily Bar Chart */}
        <div className="usage-chart-section">
          <h3 className="usage-section-title">Daily Breakdown</h3>
          {(!usageData || usageData.dailyBreakdown.length === 0) ? (
            <div className="usage-empty-chart">No usage data for this period.</div>
          ) : (
            <div className="usage-chart" role="img" aria-label="Daily credit consumption chart">
              <div className="usage-chart-bars">
                {daysInMonth.map(day => {
                  const data = dailyCreditsMap.get(day);
                  const credits = data?.credits ?? 0;
                  const heightPercent = maxCreditsPerDay > 0 ? (credits / maxCreditsPerDay) * 100 : 0;
                  return (
                    <div key={day} className="usage-chart-bar-wrapper" title={`Day ${day}: ${credits.toFixed(2)} credits (EUR ${(credits * 0.04).toFixed(2)})`}>
                      <div
                        className="usage-chart-bar"
                        style={{ height: `${heightPercent}%` }}
                        aria-label={`Day ${day}: ${credits.toFixed(2)} credits`}
                      />
                      <span className="usage-chart-label">{day}</span>
                    </div>
                  );
                })}
              </div>
              <div className="usage-chart-y-axis">
                <span>{maxCreditsPerDay.toFixed(1)}</span>
                <span>{(maxCreditsPerDay / 2).toFixed(1)}</span>
                <span>0</span>
              </div>
            </div>
          )}
        </div>

        {/* Session Breakdown Table */}
        <div className="usage-table-section">
          <h3 className="usage-section-title">Session Breakdown</h3>
          {sortedSessions.length === 0 ? (
            <div className="usage-empty-table">No sessions consumed credits this period.</div>
          ) : (
            <div className="usage-table-wrapper">
              <table className="usage-table">
                <thead>
                  <tr>
                    <th onClick={() => handleSort('sessionName')} className="usage-th-sortable">
                      Session{sortIndicator('sessionName')}
                    </th>
                    <th onClick={() => handleSort('agent')} className="usage-th-sortable">
                      Agent{sortIndicator('agent')}
                    </th>
                    <th onClick={() => handleSort('credits')} className="usage-th-sortable">
                      Credits{sortIndicator('credits')}
                    </th>
                    <th onClick={() => handleSort('costEur')} className="usage-th-sortable">
                      EUR Cost{sortIndicator('costEur')}
                    </th>
                    <th onClick={() => handleSort('turns')} className="usage-th-sortable">
                      Turns{sortIndicator('turns')}
                    </th>
                    <th onClick={() => handleSort('firstTurn')} className="usage-th-sortable">
                      Date Range{sortIndicator('firstTurn')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSessions.map(session => (
                    <tr
                      key={session.sessionId}
                      className="usage-session-row"
                      onClick={() => handleSessionClick(session.sessionId)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handleSessionClick(session.sessionId); }}
                    >
                      <td>{session.sessionName}</td>
                      <td>{session.agent}</td>
                      <td>{session.credits.toFixed(2)}</td>
                      <td>EUR {session.costEur.toFixed(2)}</td>
                      <td>{session.turns}</td>
                      <td className="usage-date-range">
                        {formatDateShort(session.firstTurn)} → {formatDateShort(session.lastTurn)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function formatDateShort(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

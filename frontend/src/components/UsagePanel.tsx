import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
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
  agent?: string;
  tabId?: number | null;
  tabName?: string | null;
  credits: number;
  costEur: number;
  turns: number;
  firstTurn?: string;
  lastTurn?: string;
}

/** A single calendar month's aggregated usage, as returned by /api/usage/monthly. */
interface MonthUsage {
  year: number;
  month: number; // 1-12
  monthLabel: string; // e.g. "August 2026"
  from: string;
  to: string;
  totalCredits: number;
  totalCostEur: number;
  totalTurns: number;
  dailyBreakdown: DailyBreakdown[];
  sessionBreakdown: SessionBreakdown[];
}

type SortKey = 'sessionName' | 'agent' | 'tabName' | 'credits' | 'costEur' | 'turns' | 'firstTurn';
type SortDir = 'asc' | 'desc';

const POLL_INTERVAL_MS = 300000; // 5 minutes

export function UsagePanel() {
  const { tabs, setActiveSessionId } = useApp();
  const navigate = useNavigate();
  const [months, setMonths] = useState<MonthUsage[]>([]);
  const [selectedMonthIndex, setSelectedMonthIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('credits');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const fetchMonthly = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/api/usage/monthly');
      if (!res.ok) {
        setError('Failed to load usage data');
        return;
      }
      const data: { months: MonthUsage[] } = await res.json();
      const list = Array.isArray(data.months) ? data.months : [];
      setMonths(list);
      // On the first successful load (no selection yet) default to the newest
      // month (last element). On subsequent polls preserve the current
      // selection, clamped in case the number of months changed.
      setSelectedMonthIndex(prev => {
        if (list.length === 0) return null;
        if (prev === null) return list.length - 1;
        return Math.min(prev, list.length - 1);
      });
    } catch {
      setError('Failed to load usage data');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch once on mount, then poll every 5 minutes. Navigation and tab
  // filtering read from the cached payload and never trigger a network call.
  useEffect(() => {
    fetchMonthly();
    const interval = setInterval(() => { fetchMonthly(); }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchMonthly]);

  const selectedMonth = useMemo(() => {
    if (selectedMonthIndex === null) return null;
    return months[selectedMonthIndex] ?? null;
  }, [months, selectedMonthIndex]);

  // Apply the tab filter locally against the cached month. When a specific tab
  // is selected, re-sum totals and daily breakdown from the filtered sessions.
  const filteredMonth = useMemo(() => {
    if (!selectedMonth) return null;
    if (selectedTabId === null) return selectedMonth;

    const sessionBreakdown = selectedMonth.sessionBreakdown.filter(
      s => s.tabId === selectedTabId
    );

    // The payload's dailyBreakdown is an all-tabs aggregate with no per-tab
    // dimension, so when filtering by tab we rebuild the daily bars from the
    // filtered sessions themselves — attributing each session's credits to the
    // day of its first turn (YYYY-MM-DD).
    const dailyMap = new Map<string, DailyBreakdown>();
    let totalCredits = 0;
    let totalCostEur = 0;
    for (const s of sessionBreakdown) {
      totalCredits += s.credits;
      totalCostEur += s.costEur;
      const day = s.firstTurn ? s.firstTurn.slice(0, 10) : null;
      if (day) {
        const existing = dailyMap.get(day);
        if (existing) {
          existing.credits += s.credits;
          existing.costEur += s.costEur;
        } else {
          dailyMap.set(day, { date: day, credits: s.credits, costEur: s.costEur });
        }
      }
    }

    const dailyBreakdown = Array.from(dailyMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    return {
      ...selectedMonth,
      totalCredits,
      totalCostEur,
      dailyBreakdown,
      sessionBreakdown,
    };
  }, [selectedMonth, selectedTabId]);

  const sortedSessions = useMemo(() => {
    if (!filteredMonth || !filteredMonth.sessionBreakdown) return [];
    const sorted = [...filteredMonth.sessionBreakdown];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'sessionName':
          cmp = (a.sessionName ?? '').localeCompare(b.sessionName ?? '');
          break;
        case 'agent':
          cmp = (a.agent ?? '').localeCompare(b.agent ?? '');
          break;
        case 'tabName':
          cmp = (a.tabName ?? '').localeCompare(b.tabName ?? '');
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
          cmp = (a.firstTurn ?? '').localeCompare(b.firstTurn ?? '');
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [filteredMonth, sortKey, sortDir]);

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
    navigate(`/sessions/${sessionId}`);
  };

  const goToPrevMonth = () => {
    setSelectedMonthIndex(i => (i === null ? null : Math.max(0, i - 1)));
  };

  const goToNextMonth = () => {
    setSelectedMonthIndex(i =>
      i === null ? null : Math.min(months.length - 1, i + 1)
    );
  };

  const maxCreditsPerDay = useMemo(() => {
    if (!filteredMonth || !filteredMonth.dailyBreakdown || filteredMonth.dailyBreakdown.length === 0) return 1;
    return Math.max(...filteredMonth.dailyBreakdown.map(d => d.credits), 1);
  }, [filteredMonth]);

  // Generate all days of the selected month for the chart.
  const daysInMonth = useMemo(() => {
    if (!selectedMonth) return [];
    // month is 1-12; day 0 of the next month is the last day of this month.
    const lastDay = new Date(selectedMonth.year, selectedMonth.month, 0).getDate();
    return Array.from({ length: lastDay }, (_, i) => i + 1);
  }, [selectedMonth]);

  const dailyCreditsMap = useMemo(() => {
    if (!filteredMonth || !filteredMonth.dailyBreakdown) return new Map<number, DailyBreakdown>();
    const map = new Map<number, DailyBreakdown>();
    for (const d of filteredMonth.dailyBreakdown) {
      // Parse day directly from YYYY-MM-DD string to avoid timezone issues
      // (new Date("2026-08-01").getDate() returns 31 in negative UTC offsets)
      const day = parseInt(d.date.split('-')[2], 10);
      map.set(day, d);
    }
    return map;
  }, [filteredMonth]);

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  if (loading && months.length === 0) {
    return (
      <section id="panel-usage" role="tabpanel" aria-labelledby="tab-usage">
        <div className="usage-layout">
          <div className="usage-loading">Loading usage data…</div>
        </div>
      </section>
    );
  }

  if (error && months.length === 0) {
    return (
      <section id="panel-usage" role="tabpanel" aria-labelledby="tab-usage">
        <div className="usage-layout">
          <div className="usage-error">{error}</div>
        </div>
      </section>
    );
  }

  const isOldest = selectedMonthIndex === null || selectedMonthIndex <= 0;
  const isNewest = selectedMonthIndex === null || selectedMonthIndex >= months.length - 1;
  const monthLabel = selectedMonth?.monthLabel ?? '';

  return (
    <section id="panel-usage" role="tabpanel" aria-labelledby="tab-usage">
      <div className="usage-layout">
        {/* Summary Header */}
        <div className="usage-header">
          <div className="usage-summary">
            <div className="usage-month-nav">
              <button
                type="button"
                className="usage-month-arrow"
                onClick={goToPrevMonth}
                disabled={isOldest}
                aria-label="Previous month"
              >
                ‹
              </button>
              <h2 className="usage-heading">{monthLabel}</h2>
              <button
                type="button"
                className="usage-month-arrow"
                onClick={goToNextMonth}
                disabled={isNewest}
                aria-label="Next month"
              >
                ›
              </button>
            </div>
            <div className="usage-totals">
              <span className="usage-total-credits">{(filteredMonth?.totalCredits ?? 0).toFixed(2)} credits</span>
              <span className="usage-total-cost">EUR {(filteredMonth?.totalCostEur ?? 0).toFixed(2)}</span>
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
          {(!filteredMonth || !filteredMonth.dailyBreakdown || filteredMonth.dailyBreakdown.length === 0) ? (
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
                    <th onClick={() => handleSort('sessionName')} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort('sessionName'); } }} tabIndex={0} className="usage-th-sortable">
                      Session{sortIndicator('sessionName')}
                    </th>
                    <th onClick={() => handleSort('agent')} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort('agent'); } }} tabIndex={0} className="usage-th-sortable">
                      Agent{sortIndicator('agent')}
                    </th>
                    <th onClick={() => handleSort('tabName')} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort('tabName'); } }} tabIndex={0} className="usage-th-sortable">
                      Tab{sortIndicator('tabName')}
                    </th>
                    <th onClick={() => handleSort('credits')} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort('credits'); } }} tabIndex={0} className="usage-th-sortable">
                      Credits{sortIndicator('credits')}
                    </th>
                    <th onClick={() => handleSort('costEur')} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort('costEur'); } }} tabIndex={0} className="usage-th-sortable">
                      EUR Cost{sortIndicator('costEur')}
                    </th>
                    <th onClick={() => handleSort('turns')} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort('turns'); } }} tabIndex={0} className="usage-th-sortable">
                      Turns{sortIndicator('turns')}
                    </th>
                    <th onClick={() => handleSort('firstTurn')} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort('firstTurn'); } }} tabIndex={0} className="usage-th-sortable">
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
                      <td>{session.agent ?? '—'}</td>
                      <td>{session.tabName ?? '—'}</td>
                      <td>{session.credits.toFixed(2)}</td>
                      <td>EUR {session.costEur.toFixed(2)}</td>
                      <td>{session.turns}</td>
                      <td className="usage-date-range">
                        {session.firstTurn && session.lastTurn
                          ? `${formatDateShort(session.firstTurn)} → ${formatDateShort(session.lastTurn)}`
                          : '—'}
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

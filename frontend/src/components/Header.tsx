import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { useTheme } from '../hooks/useTheme';
import { SettingsModal } from './SettingsModal';
import { apiFetch } from '../utils/api';

export function Header() {
  const { connected, logout, setActiveView } = useApp();
  const { toggleTheme } = useTheme();
  const [showSettings, setShowSettings] = useState(false);
  const [monthlyCredits, setMonthlyCredits] = useState<number>(0);

  const fetchMonthlyCredits = useCallback(async () => {
    try {
      const res = await apiFetch('/api/usage/current-month');
      if (res.ok) {
        const data = await res.json();
        setMonthlyCredits(data.totalCostEur ?? 0);
      }
    } catch {
      // Silently fail — badge just shows 0
    }
  }, []);

  useEffect(() => {
    fetchMonthlyCredits();
    // Refresh every 30 seconds to keep badge up-to-date
    const interval = setInterval(fetchMonthlyCredits, 30000);
    return () => clearInterval(interval);
  }, [fetchMonthlyCredits]);

  // Also refresh when sessions update (credits consumed)
  useEffect(() => {
    const handler = () => { fetchMonthlyCredits(); };
    window.addEventListener('ws-session-output', handler);
    return () => window.removeEventListener('ws-session-output', handler);
  }, [fetchMonthlyCredits]);

  const handleUsageClick = () => {
    setActiveView('usage');
  };

  return (
    <>
      <header className="header">
        <span className="logo">Vibe<span className="logo-accent">code</span> Heaven</span>
        <div className="header-actions">
          <div className="connection-status" id="connectionStatus" title={connected ? 'Connected' : 'Disconnected'}>
            <span className={`status-dot${connected ? ' connected' : ''}`} id="statusDot"></span>
            <span className="status-text" id="statusText">{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
          <button
            className="usage-badge"
            onClick={handleUsageClick}
            title="View usage dashboard"
            aria-label={`Monthly cost: EUR ${monthlyCredits.toFixed(2)}. Click to view usage dashboard.`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className="usage-badge-text">EUR {monthlyCredits.toFixed(2)}</span>
          </button>
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle dark mode" aria-label="Toggle dark mode">
            <svg className="theme-icon-light" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            <svg className="theme-icon-dark" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button className="btn-header-icon" onClick={() => setShowSettings(true)} title="Profile & Settings" aria-label="Profile & Settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33h.08a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.08a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <button className="btn-header-icon" onClick={logout} title="Sign out" aria-label="Sign out">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><polyline points="16,17 21,12 16,7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><line x1="21" y1="12" x2="9" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
        </div>
      </header>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  );
}

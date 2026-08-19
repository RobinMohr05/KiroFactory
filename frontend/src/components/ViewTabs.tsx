import { useApp } from '../context/AppContext';

export function ViewTabs() {
  const { errors, activeView, setActiveView } = useApp();

  const unreadErrorCount = errors.filter(e => !e.taskCreated).length;

  return (
    <nav className="tabs" role="tablist" aria-label="Views">
      <button
        className={`tab${activeView === 'boards' ? ' active' : ''}`}
        role="tab"
        id="tab-boards"
        aria-selected={activeView === 'boards'}
        aria-controls="panel-boards"
        onClick={() => setActiveView('boards')}
      >
        Tasks
      </button>
      <button
        className={`tab${activeView === 'sessions' ? ' active' : ''}`}
        role="tab"
        id="tab-sessions"
        aria-selected={activeView === 'sessions'}
        aria-controls="panel-sessions"
        onClick={() => setActiveView('sessions')}
      >
        Sessions
      </button>
      <button
        className={`tab${activeView === 'agents' ? ' active' : ''}`}
        role="tab"
        id="tab-agents"
        aria-selected={activeView === 'agents'}
        aria-controls="panel-agents"
        onClick={() => setActiveView('agents')}
      >
        Agents
      </button>
      <button
        className={`tab${activeView === 'errors' ? ' active' : ''}`}
        role="tab"
        id="tab-errors"
        aria-selected={activeView === 'errors'}
        aria-controls="panel-errors"
        onClick={() => setActiveView('errors')}
      >
        Errors{' '}
        {unreadErrorCount > 0 && (
          <span className="error-badge">{unreadErrorCount > 99 ? '99+' : unreadErrorCount}</span>
        )}
      </button>
    </nav>
  );
}

import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';

type ViewOption = { value: string; label: string };

// Maps each view to the route it navigates to.
const VIEW_OPTIONS: ViewOption[] = [
  { value: '/tasks', label: 'Tasks' },
  { value: '/sessions', label: 'Sessions' },
  { value: '/agents', label: 'Agents' },
  { value: '/errors', label: 'Logs' },
  { value: '/usage', label: 'Usage' },
];

// Maps the AppContext activeView key to its route path, so the active tab
// reflects which view is currently selected.
const VIEW_TO_PATH: Record<string, string> = {
  boards: '/tasks',
  sessions: '/sessions',
  agents: '/agents',
  errors: '/errors',
  usage: '/usage',
};

export function ViewTabs() {
  const { errors, activeView } = useApp();
  const navigate = useNavigate();

  const unreadErrorCount = errors.filter(e => !e.taskCreated).length;
  const badgeCount = unreadErrorCount > 99 ? '99+' : String(unreadErrorCount);

  const currentPath = VIEW_TO_PATH[activeView] ?? '/tasks';

  return (
    <nav className="tabs" aria-label="Views" role="tablist">
      {VIEW_OPTIONS.map(({ value, label }) => {
        const isActive = value === currentPath;
        const showBadge = value === '/errors' && unreadErrorCount > 0;
        return (
          <button
            key={value}
            type="button"
            className={`tab${isActive ? ' active' : ''}`}
            role="tab"
            aria-selected={isActive}
            onClick={() => navigate(value)}
          >
            {label}
            {showBadge && <span className="error-badge">{badgeCount}</span>}
          </button>
        );
      })}
    </nav>
  );
}

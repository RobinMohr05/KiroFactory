import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';

type ViewOption = { value: string; label: string };

// Maps each view to the route it navigates to. `value` is the route path so the
// <select> can drive navigation directly on change, and the current selection
// mirrors the active route.
const VIEW_OPTIONS: ViewOption[] = [
  { value: '/tasks', label: 'Tasks' },
  { value: '/sessions', label: 'Sessions' },
  { value: '/agents', label: 'Agents' },
  { value: '/errors', label: 'Logs' },
  { value: '/usage', label: 'Usage' },
];

// The panels (TasksPanel, SessionsPanel, …) label themselves via
// aria-labelledby pointing at these ids, so keep them on the options that
// replaced the old tab buttons to preserve each panel's accessible name.
const VIEW_OPTION_IDS: Record<string, string> = {
  '/tasks': 'tab-boards',
  '/sessions': 'tab-sessions',
  '/agents': 'tab-agents',
  '/errors': 'tab-errors',
  '/usage': 'tab-usage',
};

// Maps the AppContext activeView key to its route path, so the dropdown's
// current value reflects which view is active.
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
    <nav className="tabs" aria-label="Views">
      <select
        className="tab-select"
        aria-label="Select view"
        value={currentPath}
        onChange={(e) => navigate(e.target.value)}
      >
        {VIEW_OPTIONS.map(({ value, label }) => (
          <option key={value} id={VIEW_OPTION_IDS[value]} value={value}>
            {value === '/errors' && unreadErrorCount > 0 ? `${label} (${badgeCount})` : label}
          </option>
        ))}
      </select>
      {unreadErrorCount > 0 && (
        <span className="error-badge">{badgeCount}</span>
      )}
    </nav>
  );
}

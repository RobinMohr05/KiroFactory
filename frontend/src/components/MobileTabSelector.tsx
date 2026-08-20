import { useApp } from '../context/AppContext';

export function MobileTabSelector() {
  const { tabs, currentTabId, setCurrentTabId, fetchTabTasks } = useApp();

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = Number(e.target.value);
    setCurrentTabId(id);
    fetchTabTasks(id);
  };

  if (tabs.length === 0) return null;

  return (
    <div className="mobile-tab-selector">
      <select
        value={currentTabId ?? ''}
        onChange={handleChange}
        aria-label="Select project"
      >
        {tabs.map(tab => (
          <option key={tab.id} value={tab.id}>{tab.name}</option>
        ))}
      </select>
    </div>
  );
}

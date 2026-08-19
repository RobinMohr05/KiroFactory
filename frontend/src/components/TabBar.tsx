import { useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../utils/api';
import { TabModal } from './TabModal';
import type { Tab } from '../types';

export function TabBar() {
  const { tabs, currentTabId, setCurrentTabId, setTabs, fetchTabs, fetchTabTasks } = useApp();
  const [showTabModal, setShowTabModal] = useState(false);
  const [editingTab, setEditingTab] = useState<Tab | null>(null);
  const dragIdRef = useRef<number | null>(null);

  const handleTabClick = (tab: Tab) => {
    setCurrentTabId(tab.id);
    fetchTabTasks(tab.id);
  };

  const handleDelete = async (id: number) => {
    try {
      const res = await apiFetch(`/api/tabs/${id}`, { method: 'DELETE' });
      if (!res.ok) return;
      setTabs(prev => prev.filter(b => b.id !== id));
      if (currentTabId === id) {
        const remaining = tabs.filter(b => b.id !== id);
        if (remaining.length > 0) {
          setCurrentTabId(remaining[0].id);
          fetchTabTasks(remaining[0].id);
        } else {
          setCurrentTabId(null);
        }
      }
    } catch (e) {
      console.error('Failed to delete tab:', e);
    }
  };

  const handleEditTab = (tab: Tab) => {
    setEditingTab(tab);
  };

  const handleTabSaved = (saved: Tab) => {
    if (editingTab) {
      // Editing existing
      setTabs(prev => prev.map(b => b.id === saved.id ? saved : b));
    } else {
      // Creating new
      setTabs(prev => [...prev, saved]);
      setCurrentTabId(saved.id);
    }
  };

  const handleDragStart = (e: React.DragEvent, tab: Tab) => {
    dragIdRef.current = tab.id;
    e.dataTransfer.setData('application/x-tab-id', String(tab.id));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDrop = async (e: React.DragEvent, targetTab: Tab) => {
    e.preventDefault();
    const draggedId = dragIdRef.current;
    if (!draggedId || draggedId === targetTab.id) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const insertBefore = e.clientX < rect.left + rect.width / 2;

    const newTabs = [...tabs];
    const draggedIdx = newTabs.findIndex(b => b.id === draggedId);
    if (draggedIdx === -1) return;
    const [dragged] = newTabs.splice(draggedIdx, 1);
    let targetIdx = newTabs.findIndex(b => b.id === targetTab.id);
    if (!insertBefore) targetIdx++;
    newTabs.splice(targetIdx, 0, dragged);
    setTabs(newTabs);

    try {
      await apiFetch('/api/tabs/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabIds: newTabs.map(b => b.id) }),
      });
    } catch {
      await fetchTabs();
    }
  };

  return (
    <>
      <nav className="tab-bar" id="tabBar" role="navigation" aria-label="Project tabs">
        <ul className="board-list" id="boardList" role="tablist">
          {tabs.map(tab => (
            <li
              key={tab.id}
              className={`board-list-item${currentTabId === tab.id ? ' active' : ''}`}
              data-board-id={tab.id}
              draggable
              role="tab"
              title={tab.repositoryUrl || undefined}
              aria-selected={currentTabId === tab.id}
              onClick={() => handleTabClick(tab)}
              onDragStart={(e) => handleDragStart(e, tab)}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
              onDrop={(e) => handleDrop(e, tab)}
            >
              <span className="board-item-name">{tab.name}</span>
              <span className="board-item-actions">
                <button
                  className="board-item-action board-item-edit"
                  title="Edit tab"
                  aria-label={`Edit tab ${tab.name}`}
                  onClick={(e) => { e.stopPropagation(); handleEditTab(tab); }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2-7 7H1.5V8.5l7-7z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
                <button
                  className="board-item-action board-item-delete"
                  title="Delete tab"
                  aria-label={`Delete tab ${tab.name}`}
                  onClick={(e) => { e.stopPropagation(); handleDelete(tab.id); }}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
                </button>
              </span>
            </li>
          ))}
        </ul>
        <button
          className="board-list-add-btn"
          id="newBoardBtn"
          title="Create new tab"
          aria-label="Create new tab"
          onClick={() => setShowTabModal(true)}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
          <span>New Tab</span>
        </button>
      </nav>

      {(showTabModal || editingTab) && (
        <TabModal
          tab={editingTab}
          onClose={() => { setShowTabModal(false); setEditingTab(null); }}
          onSave={handleTabSaved}
        />
      )}
    </>
  );
}

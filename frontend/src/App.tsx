import { useState } from 'react';
import { AppProvider } from './context/AppContext';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { ViewTabs } from './components/ViewTabs';
import { TasksPanel } from './components/TasksPanel';
import { SessionsPanel } from './components/SessionsPanel';
import { AgentsPanel } from './components/AgentsPanel';
import { ErrorsPanel } from './components/ErrorsPanel';
import './style.css';

type ViewTab = 'boards' | 'sessions' | 'agents' | 'errors';

function AppInner() {
  const [activeView, setActiveView] = useState<ViewTab>('boards');

  return (
    <>
      <Header />
      <TabBar />
      <ViewTabs activeView={activeView} setActiveView={setActiveView} />
      {activeView === 'boards' && <TasksPanel />}
      {activeView === 'sessions' && <SessionsPanel />}
      {activeView === 'agents' && <AgentsPanel />}
      {activeView === 'errors' && <ErrorsPanel />}
    </>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  );
}

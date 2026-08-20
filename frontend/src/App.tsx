import { AppProvider, useApp } from './context/AppContext';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { ViewTabs } from './components/ViewTabs';
import { TasksPanel } from './components/TasksPanel';
import { SessionsPanel } from './components/SessionsPanel';
import { AgentsPanel } from './components/AgentsPanel';
import { ErrorsPanel } from './components/ErrorsPanel';
import './style.css';

function AppInner() {
  const { activeView } = useApp();

  return (
    <>
      <Header />
      <TabBar />
      <ViewTabs />
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

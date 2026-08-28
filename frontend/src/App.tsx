import { AppProvider, useApp } from './context/AppContext';
import { Header } from './components/Header';
import { TabBar } from './components/TabBar';
import { ViewTabs } from './components/ViewTabs';
import { MobileTabSelector } from './components/MobileTabSelector';
import { TasksPanel } from './components/TasksPanel';
import { SessionsPanel } from './components/SessionsPanel';
import { AgentsPanel } from './components/AgentsPanel';
import { ErrorsPanel } from './components/ErrorsPanel';
import { UsagePanel } from './components/UsagePanel';
import { EasySessionsView } from './components/EasySessionsView';
import './style.css';

function AppInner() {
  const { user, activeView } = useApp();

  // Easy mode: only the Header (login/out, settings, theme toggle, usage
  // badge) is shared with Advanced mode. Everything below it — tabs,
  // ViewTabs, and all panels — is replaced by the simplified sessions-only
  // view. Defaults to 'easy' while `user` is still loading (matches the
  // backend default for new accounts) so there's no Advanced-UI flash
  // before the profile fetch resolves.
  const isEasyMode = (user?.uiViewMode ?? 'easy') === 'easy';

  if (isEasyMode) {
    return (
      <>
        <Header />
        <EasySessionsView />
      </>
    );
  }

  return (
    <>
      <Header />
      <TabBar />
      <MobileTabSelector />
      <ViewTabs />
      {activeView === 'boards' && <TasksPanel />}
      {activeView === 'sessions' && <SessionsPanel />}
      {activeView === 'agents' && <AgentsPanel />}
      {activeView === 'errors' && <ErrorsPanel />}
      {activeView === 'usage' && <UsagePanel />}
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

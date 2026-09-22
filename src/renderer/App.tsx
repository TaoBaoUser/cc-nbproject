import { useState } from 'react';
import { useProfiles } from './hooks/useProfiles';
import { useProxyStatus } from './hooks/useProxyStatus';
import { useClaudeStatus } from './hooks/useClaudeStatus';
import { useLogs } from './hooks/useLogs';
import { useUsage } from './hooks/useUsage';
import Sidebar from './components/Sidebar';
import ProvidersView from './views/ProvidersView';
import LogsView from './views/LogsView';
import UsageView from './views/UsageView';
import ProfileModal from './modals/ProfileModal';
import SetupModal from './modals/SetupModal';
import type { Profile } from './types';

type ViewName = 'providers' | 'logs' | 'usage';
type ModalState = { kind: 'profile'; profile: Profile | null } | { kind: 'setup' } | null;

export default function App() {
  const [view, setView] = useState<ViewName>('providers');
  const [modal, setModal] = useState<ModalState>(null);

  const profilesApi = useProfiles();
  const proxy = useProxyStatus();
  const claude = useClaudeStatus();
  const logs = useLogs();
  const usage = useUsage();

  // 切到用量页时刷新（与原版 switchView 一致）
  const switchView = (name: ViewName) => {
    setView(name);
    if (name === 'usage') usage.refresh();
  };

  const openProfileModal = (profile: Profile | null) => setModal({ kind: 'profile', profile });
  const openSetup = () => setModal({ kind: 'setup' });
  const closeModal = () => setModal(null);

  return (
    <div className="app">
      <Sidebar
        status={proxy.status}
        claude={claude.status}
        claudeBusy={claude.busy}
        claudeError={claude.error}
        view={view}
        onSwitchView={switchView}
        onSetup={openSetup}
        onTakeover={() => {
          void claude.takeover();
        }}
        onDisconnect={() => {
          void claude.disconnect();
        }}
      />

      <main className="main">
        <section className={view === 'providers' ? 'view is-active' : 'view'} id="view-providers">
          <ProvidersView api={profilesApi} onEdit={openProfileModal} />
        </section>

        <section className={view === 'logs' ? 'view is-active' : 'view'} id="view-logs">
          <LogsView entries={logs.entries} onClear={logs.clear} />
        </section>

        <section className={view === 'usage' ? 'view is-active' : 'view'} id="view-usage">
          <UsageView usage={usage} />
        </section>
      </main>

      <div
        className="modal-root"
        id="modal-root"
        hidden={modal === null}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeModal();
        }}
      >
        {modal?.kind === 'profile' && (
          <ProfileModal profile={modal.profile} api={profilesApi} onClose={closeModal} />
        )}
        {modal?.kind === 'setup' && (
          <SetupModal onClose={closeModal} onTakeover={claude.takeover} />
        )}
      </div>
    </div>
  );
}

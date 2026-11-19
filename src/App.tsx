import React, { useEffect, useState } from 'react';
import { CheckCircle2, RotateCcw, X } from 'lucide-react';
import { AuthProvider, useAuth } from './context/AuthContext.tsx';
import { DropdownProvider } from './context/DropdownContext.tsx';
import { ThemeProvider } from './context/ThemeContext.tsx';
import { GoogleDriveSyncStatusResponse } from './types/index.ts';
import { apiFetch, formatDateTime } from './utils/api.ts';
import { getGoogleAccessToken, initFirebaseCloudAuth } from './utils/googleDriveAuth.ts';
import {
  checkAndAutoHydrateFromCloudFirestore,
  syncCrmToCloudFirestore,
} from './lib/firestoreSync.ts';
import { auth } from './lib/firebase.ts';
import LoginPage from './components/LoginPage.tsx';
import LiveWebPage, { PortalEntryMode } from './components/LiveWebPage.tsx';
import Layout, { NavSection } from './components/Layout.tsx';
import AdminDashboard, { DashboardDrilldownTarget } from './components/dashboards/AdminDashboard.tsx';
import ModeratorDashboard from './components/dashboards/ModeratorDashboard.tsx';
import EmployeeDashboard from './components/dashboards/EmployeeDashboard.tsx';
import TicketsView, { TicketQueuePreset } from './components/tickets/TicketsView.tsx';
import TicketFormModal from './components/tickets/TicketFormModal.tsx';
import TicketDetailDrawer from './components/tickets/TicketDetailDrawer.tsx';
import DirectChatView from './components/chat/DirectChatView.tsx';
import DropdownManagerView from './components/settings/DropdownManagerView.tsx';
import ModeratorsView from './components/moderators/ModeratorsView.tsx';
import UsersDirectoryView from './components/users/UsersDirectoryView.tsx';
import AssetsView from './components/assets/AssetsView.tsx';
import BudgetExpensesView from './components/budget/BudgetExpensesView.tsx';
import ReportsView from './components/reports/ReportsView.tsx';
import BroadcastNotificationsView from './components/broadcasts/BroadcastNotificationsView.tsx';
import WebsiteTrafficView from './components/analytics/WebsiteTrafficView.tsx';
import IntegrationsView from './components/integrations/IntegrationsView.tsx';
import AuditSessionsView from './components/audit/AuditSessionsView.tsx';

function WorkspaceApp() {
  const { user, loading, refreshNotifications, refreshUser, subscribeRealtime } = useAuth();
  const [activeSection, setActiveSection] = useState<NavSection>('dashboard');
  const [newTicketOpen, setNewTicketOpen] = useState(false);
  const [selectedTicketId, setSelectedTicketId] = useState<number | null>(null);
  const [chatPeerUserId, setChatPeerUserId] = useState<number | null>(null);
  const [chatTaskId, setChatTaskId] = useState<number | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [createdBanner, setCreatedBanner] = useState('');
  const [ticketPreset, setTicketPreset] = useState<{ key: number; queueFilter?: TicketQueuePreset } | null>(null);
  const [modStatusPreset, setModStatusPreset] = useState<{ key: number; status: 'All' | 'Active' | 'Inactive' } | null>(null);
  const [reportPreset, setReportPreset] = useState<{ key: number; reportType: string } | null>(null);
  const [driveRecoveryPrompt, setDriveRecoveryPrompt] = useState<GoogleDriveSyncStatusResponse['remoteRecoveryAvailable']>(null);
  const [restoringDriveDb, setRestoringDriveDb] = useState(false);

  const [showLivePage, setShowLivePage] = useState<boolean>(() => {
    const pathname = window.location.pathname.replace(/\/+$/, '');
    if (pathname === '/live') return true;
    const params = new URLSearchParams(window.location.search);
    const hasDirectLoginParam =
      params.has('panel') || params.has('invite') || params.has('mod_access');
    return !hasDirectLoginParam;
  });
  const [portalMode, setPortalMode] = useState<PortalEntryMode>('staff_email');

  useEffect(() => {
    setActiveSection('dashboard');
    setSelectedTicketId(null);
    setNewTicketOpen(false);
    setChatPeerUserId(null);
    setChatTaskId(null);
    if (user && window.location.pathname.replace(/\/+$/, '') !== '/live') {
      setShowLivePage(false);
    }
  }, [user?.id]);

  // Lifetime Cloud Web Database (Firebase Firestore): Auto-recover on fresh container boot
  useEffect(() => {
    const unsub = initFirebaseCloudAuth(async () => {
      try {
        const res = await checkAndAutoHydrateFromCloudFirestore();
        if (res.restored) {
          setDriveRecoveryPrompt(null);
          setRefreshTrigger((n) => n + 1);
          refreshNotifications();
          refreshUser();
          setCreatedBanner(
            `CRM automatically restored from Lifetime Cloud Database (${res.restoredCount} records recovered).`
          );
        }
      } catch {
        // Error surfaced cleanly via cloudDbStatus in IntegrationsView
      }
    });
    return () => unsub();
  }, [refreshNotifications, refreshUser]);

  // Continuous real-time sync to Cloud Firestore & Google Drive recovery monitoring for Super Admin
  useEffect(() => {
    if (!user || user.role !== 'super_admin') {
      setDriveRecoveryPrompt(null);
      return;
    }

    if (auth.currentUser) {
      syncCrmToCloudFirestore().catch(() => {});
    }

    apiFetch<GoogleDriveSyncStatusResponse>('/api/integrations/google-drive/status')
      .then((res) => {
        if (res?.remoteRecoveryAvailable) {
          setDriveRecoveryPrompt(res.remoteRecoveryAvailable);
        }
      })
      .catch(() => {});

    let cloudSyncTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubWs = subscribeRealtime((evt) => {
      if (evt.event === 'cloud_db:mutated') {
        if (auth.currentUser) {
          if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
          cloudSyncTimer = setTimeout(() => {
            syncCrmToCloudFirestore().catch(() => {});
          }, 500);
        }
      } else if (evt.event === 'drive_sync:updated' && evt.data) {
        const status = evt.data as GoogleDriveSyncStatusResponse;
        setDriveRecoveryPrompt(status.remoteRecoveryAvailable || null);
      } else if (evt.event === 'system:restored') {
        setDriveRecoveryPrompt(null);
        setRefreshTrigger((n) => n + 1);
        refreshNotifications();
        refreshUser();
        const src = evt.data?.source === 'cloud_firestore' ? 'Lifetime Cloud Database' : 'Google Drive';
        setCreatedBanner(`CRM database restored from ${src} and real-time autosync resumed.`);
      }
    });

    return () => {
      if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
      unsubWs();
    };
  }, [user?.id, user?.role, subscribeRealtime, refreshNotifications, refreshUser]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-sm text-slate-500">
        Initializing SD Global IT Service Desk...
      </div>
    );
  }

  const handleOpenPortal = (mode: PortalEntryMode) => {
    setPortalMode(mode);
    setShowLivePage(false);
    if (window.location.pathname.replace(/\/+$/, '') === '/live') {
      window.history.replaceState({}, '', '/');
    }
  };

  const handleEnterWorkspace = () => {
    setShowLivePage(false);
    if (window.location.pathname.replace(/\/+$/, '') === '/live') {
      window.history.replaceState({}, '', '/');
    }
  };

  if (showLivePage && (!user || window.location.pathname.replace(/\/+$/, '') === '/live')) {
    return (
      <LiveWebPage
        isAuthenticated={Boolean(user)}
        onEnterWorkspace={handleEnterWorkspace}
        onOpenPortal={handleOpenPortal}
      />
    );
  }

  if (!user) {
    return (
      <LoginPage
        initialAuthTab={portalMode === 'employee_otp' ? 'employee_otp' : 'staff_email'}
        initialModeratorPortal={portalMode === 'moderator_common'}
        onBackToLive={() => setShowLivePage(true)}
      />
    );
  }

  const bumpRefresh = () => {
    setRefreshTrigger((n) => n + 1);
    refreshNotifications();
  };

  const handleOpenNewTicket = () => {
    if (user.role === 'moderator' || user.role === 'management') return;
    setNewTicketOpen(true);
  };

  const handleOpenDirectChat = (ticketId?: number, peerUserId?: number) => {
    if (user.role === 'management' && user.permissions?.can_view_chats === false) return;
    setChatTaskId(ticketId ?? null);
    setChatPeerUserId(peerUserId ?? null);
    setSelectedTicketId(null);
    setActiveSection('chat');
  };

  const handleTicketCreated = (ticketNumber: string) => {
    setCreatedBanner(`Ticket ${ticketNumber} submitted successfully and routed to IT Support.`);
    bumpRefresh();
    refreshUser();
  };

  const handleNavigateDrilldown = (target: DashboardDrilldownTarget) => {
    const key = Date.now();
    if (target.section === 'tickets') {
      setTicketPreset({ key, queueFilter: target.queueFilter });
      setActiveSection('tickets');
    } else if (target.section === 'moderators') {
      setModStatusPreset({ key, status: target.moderatorStatus });
      setActiveSection('moderators');
    } else if (target.section === 'reports') {
      setReportPreset({ key, reportType: target.reportType });
      setActiveSection('reports');
    } else if (target.section === 'employees') {
      setActiveSection('employees');
    } else if (target.section === 'broadcasts') {
      setActiveSection('broadcasts');
    } else if (target.section === 'traffic') {
      setActiveSection('traffic');
    }
  };

  const renderMainContent = () => {
    if (activeSection === 'dashboard') {
      if (user.role === 'employee') {
        return (
          <EmployeeDashboard
            onSelectTicket={setSelectedTicketId}
            onOpenNewTicket={handleOpenNewTicket}
            refreshTrigger={refreshTrigger}
          />
        );
      }
      if (user.role === 'moderator') {
        return (
          <ModeratorDashboard
            onSelectTicket={setSelectedTicketId}
            onOpenDirectChat={(tid) => handleOpenDirectChat(tid)}
            refreshTrigger={refreshTrigger}
          />
        );
      }
      return (
        <AdminDashboard
          onSelectTicket={setSelectedTicketId}
          onOpenDirectChat={user.role === 'super_admin' ? handleOpenDirectChat : undefined}
          onOpenIntegrations={user.role === 'super_admin' ? () => setActiveSection('integrations') : undefined}
          onNavigateDrilldown={handleNavigateDrilldown}
          refreshTrigger={refreshTrigger}
          readOnlyExecutive={user.role === 'management'}
        />
      );
    }

    const backToDash = () => setActiveSection('dashboard');

    switch (activeSection) {
      case 'tickets':
        return (
          <TicketsView
            onSelectTicket={setSelectedTicketId}
            onOpenNewTicket={handleOpenNewTicket}
            refreshTrigger={refreshTrigger}
            initialPreset={ticketPreset}
            onBackToDashboard={backToDash}
          />
        );
      case 'chat':
        return user.role !== 'management' || user.permissions?.can_view_chats !== false ? (
          <DirectChatView
            initialPeerUserId={chatPeerUserId}
            initialTaskId={chatTaskId}
            onOpenTask={(id) => setSelectedTicketId(id)}
          />
        ) : null;
      case 'moderators':
        return user.role === 'super_admin' || user.role === 'management' ? (
          <ModeratorsView initialStatusFilter={modStatusPreset} onBackToDashboard={backToDash} />
        ) : null;
      case 'employees':
        return user.role === 'super_admin' || user.role === 'management' ? (
          <UsersDirectoryView onSelectTicket={setSelectedTicketId} onBackToDashboard={backToDash} />
        ) : null;
      case 'assets':
        return user.role === 'super_admin' || user.role === 'management' ? (
          <AssetsView onSelectTicket={setSelectedTicketId} />
        ) : null;
      case 'budgets':
        return user.role === 'super_admin' || (user.role === 'management' && user.permissions?.can_view_budgets !== false) ? (
          <BudgetExpensesView />
        ) : null;
      case 'reports':
        return user.role === 'super_admin' || (user.role === 'management' && user.permissions?.can_view_reports !== false) ? (
          <ReportsView initialReportType={reportPreset} onBackToDashboard={backToDash} />
        ) : null;
      case 'broadcasts':
        return user.role === 'super_admin' ? (
          <BroadcastNotificationsView onBackToDashboard={backToDash} />
        ) : null;
      case 'traffic':
        return user.role === 'super_admin' ? <WebsiteTrafficView onBackToDashboard={backToDash} /> : null;
      case 'dropdowns':
        return user.role === 'super_admin' ? <DropdownManagerView /> : null;
      case 'integrations':
        return user.role === 'super_admin' ? <IntegrationsView /> : null;
      case 'audit':
        return user.role === 'super_admin' ? (
          <AuditSessionsView onOpenIntegrations={() => setActiveSection('integrations')} />
        ) : null;
      default:
        return null;
    }
  };

  return (
    <Layout
      activeSection={activeSection}
      onSelectSection={(sec) => {
        if (sec !== 'chat') {
          setChatPeerUserId(null);
          setChatTaskId(null);
        }
        setTicketPreset(null);
        setModStatusPreset(null);
        setReportPreset(null);
        setActiveSection(sec);
      }}
      onOpenNewTicket={handleOpenNewTicket}
      onSelectNotificationTicket={(id) => setSelectedTicketId(id)}
    >
      {createdBanner && (
        <div className="mb-5 px-4 py-3 rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 text-xs flex items-center justify-between">
          <span className="inline-flex items-center gap-2 font-medium">
            <CheckCircle2 className="w-4 h-4" />
            {createdBanner}
          </span>
          <button type="button" onClick={() => setCreatedBanner('')} className="cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {renderMainContent()}

      {user.role !== 'moderator' && user.role !== 'management' && (
        <TicketFormModal
          open={newTicketOpen}
          onClose={() => setNewTicketOpen(false)}
          onCreated={handleTicketCreated}
        />
      )}

      <TicketDetailDrawer
        ticketId={selectedTicketId}
        onClose={() => setSelectedTicketId(null)}
        onUpdated={bumpRefresh}
        onOpenDirectChat={
          user.role !== 'management' || user.permissions?.can_view_chats !== false ? handleOpenDirectChat : undefined
        }
      />

      {driveRecoveryPrompt && activeSection !== 'integrations' && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <RotateCcw className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  Existing Database Found in Google Drive
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">
                  The server restarted with a fresh local database, and your saved backup{' '}
                  <span className="font-mono font-semibold">{driveRecoveryPrompt.fileName}</span> is ready in Google Drive. Restore it now to recover your saved data and resume 1-second autosync?
                </p>
                {driveRecoveryPrompt.modifiedTime && (
                  <div className="mt-2 text-[11px] font-mono text-slate-500">
                    Last Synced: {formatDateTime(driveRecoveryPrompt.modifiedTime)}
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={restoringDriveDb}
                onClick={() => setDriveRecoveryPrompt(null)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Later
              </button>
              <button
                type="button"
                disabled={restoringDriveDb}
                onClick={async () => {
                  setRestoringDriveDb(true);
                  try {
                    const token = getGoogleAccessToken();
                    await apiFetch('/api/integrations/google-drive/restore-from-drive', {
                      method: 'POST',
                      headers: token ? { 'X-Google-Access-Token': token } : undefined,
                    });
                    setDriveRecoveryPrompt(null);
                    bumpRefresh();
                    refreshUser();
                  } catch {
                    setDriveRecoveryPrompt(null);
                    setActiveSection('integrations');
                  } finally {
                    setRestoringDriveDb(false);
                  }
                }}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60 cursor-pointer"
              >
                {restoringDriveDb ? 'Restoring...' : 'Restore Database Now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <DropdownProvider>
          <WorkspaceApp />
        </DropdownProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

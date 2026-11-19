import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  Cloud,
  Copy,
  Database,
  ExternalLink,
  FolderSync,
  HardDrive,
  Link2,
  LogOut,
  Mail,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.tsx';
import { GoogleDriveSyncedFile, GoogleDriveSyncStatusResponse } from '../../types/index.ts';
import { apiFetch, formatDateTime } from '../../utils/api.ts';
import {
  getGoogleAccessToken,
  getGoogleTokenRemainingMinutes,
  googleLogout,
  googleSignIn,
  initGoogleAuth,
} from '../../utils/googleDriveAuth.ts';
import {
  checkAndAutoHydrateFromCloudFirestore,
  getCloudDbStatus,
  hydrateServerFromCloudFirestore,
  subscribeCloudDbStatus,
  syncCrmToCloudFirestore,
  type CloudDbStatus,
} from '../../lib/firestoreSync.ts';
import { formatBytesCompact } from '../common/MediaPreviewModal.tsx';

export default function IntegrationsView() {
  const { notificationPrefs, updateNotificationPrefs, subscribeRealtime } = useAuth();
  const [tab, setTab] = useState<'drive' | 'notifications' | 'outlook' | 'whatsapp' | 'sla'>('drive');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // Google Drive Continuous Sync state
  const [driveStatus, setDriveStatus] = useState<GoogleDriveSyncStatusResponse | null>(null);
  const [driveUrlDraft, setDriveUrlDraft] = useState(
    'https://drive.google.com/drive/folders/18ub4PwnI3r9io--dCEULoQPW-vPW_ihT?usp=drive_link'
  );
  const [driveIntervalDraft, setDriveIntervalDraft] = useState(1000);
  const [driveEnabledDraft, setDriveEnabledDraft] = useState(true);
  const [needsGoogleAuth, setNeedsGoogleAuth] = useState(false);
  const [googleSigningIn, setGoogleSigningIn] = useState(false);
  const [verifyingFolder, setVerifyingFolder] = useState(false);
  const [copiedFolderLink, setCopiedFolderLink] = useState(false);
  const [savingDrive, setSavingDrive] = useState(false);
  const [syncingDriveNow, setSyncingDriveNow] = useState(false);

  // Explicit Confirmation Modals for Google Drive mutations/deletes (MANDATORY)
  const [confirmSaveModal, setConfirmSaveModal] = useState<{
    driveFolderUrl: string;
    syncIntervalMs: number;
    syncEnabled: boolean;
  } | null>(null);
  const [confirmManualSyncModal, setConfirmManualSyncModal] = useState(false);
  const [confirmRestoreModal, setConfirmRestoreModal] = useState(false);
  const [restoringFromDrive, setRestoringFromDrive] = useState(false);
  const [confirmDeleteFileModal, setConfirmDeleteFileModal] = useState<GoogleDriveSyncedFile | null>(null);
  const [deletingDriveFile, setDeletingDriveFile] = useState(false);

  // Lifetime Cloud Web Database (Firebase Firestore) state
  const [cloudDbStatus, setCloudDbStatus] = useState<CloudDbStatus>(() => getCloudDbStatus());
  const [confirmCloudRestoreModal, setConfirmCloudRestoreModal] = useState(false);
  const [syncingCloudNow, setSyncingCloudNow] = useState(false);
  const [restoringCloudDb, setRestoringCloudDb] = useState(false);

  // Outlook state
  const [outlookStatus, setOutlookStatus] = useState<any>(null);
  const [oClientId, setOClientId] = useState('');
  const [oClientSecret, setOClientSecret] = useState('');
  const [oTenantId, setOTenantId] = useState('common');
  const [oAutoCreate, setOAutoCreate] = useState(true);
  const [oAutoAssign, setOAutoAssign] = useState(true);
  const [oAutoResolve, setOAutoResolve] = useState(true);
  const [tickets, setTickets] = useState<any[]>([]);

  // WhatsApp state
  const [waStatus, setWaStatus] = useState<any>(null);
  const [wabaId, setWabaId] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [waToken, setWaToken] = useState('');
  const [waVerifyToken, setWaVerifyToken] = useState('');
  const [waEnabled, setWaEnabled] = useState(false);
  const [tplCreated, setTplCreated] = useState('ticket_created_confirmation');
  const [tplAssigned, setTplAssigned] = useState('ticket_moderator_assigned');
  const [tplProgress, setTplProgress] = useState('ticket_status_update');
  const [tplResolved, setTplResolved] = useState('ticket_resolution_notice');

  // SLA state
  const [slaConfigs, setSlaConfigs] = useState<any[]>([]);

  const applyDriveStatus = useCallback((res: GoogleDriveSyncStatusResponse) => {
    setDriveStatus(res);
    if (res?.config) {
      setDriveUrlDraft(res.config.drive_folder_url);
      setDriveIntervalDraft(res.config.sync_interval_ms || 1000);
      setDriveEnabledDraft(Boolean(res.config.sync_enabled));
    }
    setNeedsGoogleAuth(!res?.tokenActive);
  }, []);

  const loadAll = useCallback(async () => {
    const [dRes, oRes, wRes, sRes, tRes] = await Promise.all([
      apiFetch<GoogleDriveSyncStatusResponse>('/api/integrations/google-drive/status'),
      apiFetch<any>('/api/integrations/outlook/status'),
      apiFetch<any>('/api/integrations/whatsapp/status'),
      apiFetch<{ configs: any[] }>('/api/sla-configs'),
      apiFetch<{ tickets: any[] }>('/api/tickets'),
    ]);
    applyDriveStatus(dRes);
    setOutlookStatus(oRes);
    setOTenantId(oRes.tenantId || 'common');
    setOAutoCreate(Boolean(oRes.autoNotifyOnCreate));
    setOAutoAssign(Boolean(oRes.autoNotifyOnAssign));
    setOAutoResolve(Boolean(oRes.autoNotifyOnResolve));

    setWaStatus(wRes);
    setWabaId(wRes.wabaId || '');
    setPhoneNumberId(wRes.phoneNumberId || '');
    setWaVerifyToken('');
    setWaEnabled(Boolean(wRes.enabled));
    if (wRes.templates) {
      setTplCreated(wRes.templates.ticket_created || 'ticket_created_confirmation');
      setTplAssigned(wRes.templates.moderator_assigned || 'ticket_moderator_assigned');
      setTplProgress(wRes.templates.ticket_progress || 'ticket_status_update');
      setTplResolved(wRes.templates.ticket_resolved || 'ticket_resolution_notice');
    }

    setSlaConfigs(sRes.configs);
    setTickets(tRes.tickets);
  }, [applyDriveStatus]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    return subscribeCloudDbStatus((st) => setCloudDbStatus(st));
  }, []);

  useEffect(() => {
    const unsubscribeAuth = initGoogleAuth(
      async (_gUser, token) => {
        setNeedsGoogleAuth(false);
        try {
          const res = await apiFetch<{ status: GoogleDriveSyncStatusResponse }>(
            '/api/integrations/google-drive/session',
            {
              method: 'POST',
              headers: { 'X-Google-Access-Token': token },
              body: JSON.stringify({ confirmSync: false }),
            }
          );
          if (res?.status) applyDriveStatus(res.status);
        } catch {
          // ignore silent sync error if token hasn't been confirmed yet
        }
      },
      () => {
        setNeedsGoogleAuth(true);
      }
    );
    return () => unsubscribeAuth();
  }, [applyDriveStatus]);

  useEffect(() => {
    return subscribeRealtime((evt) => {
      if (evt.event === 'drive_sync:updated' && evt.data) {
        setDriveStatus(evt.data as GoogleDriveSyncStatusResponse);
        setNeedsGoogleAuth(!evt.data?.tokenActive);
      }
    });
  }, [subscribeRealtime]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.data?.type === 'OUTLOOK_OAUTH_SUCCESS') {
        setMsg(`Connected Microsoft Outlook account: ${ev.data.email || 'Authorized'}`);
        setErr('');
        loadAll();
      } else if (ev.data?.type === 'OUTLOOK_OAUTH_ERROR') {
        setErr(ev.data.error || 'Outlook OAuth failed');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadAll]);

  const handleGoogleSignIn = async () => {
    setErr('');
    setMsg('');
    setGoogleSigningIn(true);
    try {
      const { user, accessToken } = await googleSignIn();

      // 1. Activate Lifetime Cloud Web Database (Firebase Firestore) immediately
      let cloudRestored = false;
      try {
        const cloudCheck = await checkAndAutoHydrateFromCloudFirestore();
        if (cloudCheck.restored) {
          cloudRestored = true;
          loadAll();
        } else {
          await syncCrmToCloudFirestore({ force: true });
        }
      } catch {
        // Cloud DB status captures any error cleanly
      }

      // 2. Authorize Google Drive Folder Sync in parallel
      const res = await apiFetch<{ status: GoogleDriveSyncStatusResponse }>(
        '/api/integrations/google-drive/session',
        {
          method: 'POST',
          headers: { 'X-Google-Access-Token': accessToken },
          body: JSON.stringify({ confirmSync: false }),
        }
      );
      if (res?.status) applyDriveStatus(res.status);
      setNeedsGoogleAuth(false);
      if (cloudRestored) {
        setMsg(
          `Signed in as ${user.email || 'Authorized User'}. Lifetime Cloud Database restored your saved CRM records and Google Drive folder access is authorized.`
        );
      } else if (res?.status?.remoteRecoveryAvailable) {
        setMsg(
          `Signed in to Google as ${user.email || 'Authorized User'}. Existing database (${res.status.remoteRecoveryAvailable.fileName}) found in Google Drive!`
        );
        setConfirmRestoreModal(true);
      } else {
        setMsg(
          `Signed in as ${user.email || 'Authorized User'}. Lifetime Cloud Web Database is now active (no 60-min expiry). Confirm below to also enable Google Drive folder snapshots.`
        );
        if (res?.status && !res.status.config.sync_confirmed) {
          setConfirmSaveModal({
            driveFolderUrl: res.status.config.drive_folder_url || driveUrlDraft.trim(),
            syncIntervalMs: res.status.config.sync_interval_ms || 1000,
            syncEnabled: true,
          });
        }
      }
    } catch (e: any) {
      setErr(e?.message || 'Google Sign-In failed. Ensure popups are allowed for this window.');
    } finally {
      setGoogleSigningIn(false);
    }
  };

  const handleSyncCloudDbNow = async () => {
    setErr('');
    setMsg('');
    setSyncingCloudNow(true);
    try {
      const res = await syncCrmToCloudFirestore({ force: true });
      setMsg(
        `Lifetime Cloud Database synchronized (${res.written} record(s) written, ${res.deleted} removed).`
      );
    } catch (e: any) {
      setErr(e?.message || 'Failed to sync Lifetime Cloud Database.');
    } finally {
      setSyncingCloudNow(false);
    }
  };

  const handleConfirmRestoreFromCloudDb = async () => {
    setRestoringCloudDb(true);
    setErr('');
    setMsg('');
    try {
      const res = await hydrateServerFromCloudFirestore('manual');
      setConfirmCloudRestoreModal(false);
      setMsg(
        `Restored ${res.restoredCount} records from your Lifetime Cloud Web Database (Firebase Firestore).`
      );
      loadAll();
    } catch (e: any) {
      setConfirmCloudRestoreModal(false);
      setErr(e?.message || 'Failed to restore from Lifetime Cloud Database.');
    } finally {
      setRestoringCloudDb(false);
    }
  };

  const handleVerifyDriveFolder = async () => {
    setErr('');
    setMsg('');
    setVerifyingFolder(true);
    try {
      const token = getGoogleAccessToken();
      const res = await apiFetch<{
        folder: { id: string; name: string; webViewLink: string; canAddChildren: boolean };
        status: GoogleDriveSyncStatusResponse;
      }>('/api/integrations/google-drive/verify-folder', {
        method: 'POST',
        headers: token ? { 'X-Google-Access-Token': token } : undefined,
        body: JSON.stringify({ driveFolderUrl: driveUrlDraft.trim() }),
      });
      if (res?.status) applyDriveStatus(res.status);
      setMsg(
        `Verified Google Drive folder "${res.folder.name}" (${res.folder.id}) — ${
          res.folder.canAddChildren ? 'Read/Write access confirmed.' : 'Read-only access (grant Editor access to sync writes).'
        }`
      );
    } catch (e: any) {
      setErr(e?.message || 'Unable to verify Google Drive folder access.');
    } finally {
      setVerifyingFolder(false);
    }
  };

  const handleCopyFolderUrl = async () => {
    const urlToCopy =
      driveStatus?.config.drive_folder_url ||
      driveStatus?.driveFolderHref ||
      driveUrlDraft.trim();
    try {
      await navigator.clipboard.writeText(urlToCopy);
      setCopiedFolderLink(true);
      setTimeout(() => setCopiedFolderLink(false), 2000);
    } catch {
      setErr('Unable to copy URL to clipboard.');
    }
  };

  const handleGoogleDisconnect = async () => {
    setErr('');
    setMsg('');
    try {
      await googleLogout();
      const res = await apiFetch<{ status: GoogleDriveSyncStatusResponse }>(
        '/api/integrations/google-drive/disconnect',
        { method: 'POST' }
      );
      if (res?.status) applyDriveStatus(res.status);
      setMsg('Google Drive session disconnected.');
    } catch (e: any) {
      setErr(e?.message || 'Failed to disconnect Google Drive.');
    }
  };

  const handleConfirmSaveDriveConfig = async () => {
    if (!confirmSaveModal) return;
    setSavingDrive(true);
    setErr('');
    setMsg('');
    try {
      const token = getGoogleAccessToken();
      const res = await apiFetch<{ status: GoogleDriveSyncStatusResponse }>(
        '/api/integrations/google-drive/config',
        {
          method: 'PUT',
          headers: token ? { 'X-Google-Access-Token': token } : undefined,
          body: JSON.stringify({
            driveFolderUrl: confirmSaveModal.driveFolderUrl,
            syncIntervalMs: confirmSaveModal.syncIntervalMs,
            syncEnabled: confirmSaveModal.syncEnabled,
            syncConfirmed: true,
          }),
        }
      );
      setConfirmSaveModal(null);
      if (res?.status) applyDriveStatus(res.status);
      setMsg(
        confirmSaveModal.syncEnabled
          ? `Google Drive continuous sync active (${confirmSaveModal.syncIntervalMs}ms interval) to folder ${res?.status?.config?.drive_folder_id}.`
          : 'Google Drive sync settings saved (currently paused).'
      );
    } catch (e: any) {
      setConfirmSaveModal(null);
      setErr(e?.message || 'Failed to save Google Drive sync configuration.');
    } finally {
      setSavingDrive(false);
    }
  };

  const handleConfirmManualDriveSync = async () => {
    setConfirmManualSyncModal(false);
    setSyncingDriveNow(true);
    setErr('');
    setMsg('');
    try {
      const token = getGoogleAccessToken();
      const res = await apiFetch<{ filesUpdated: number; status: GoogleDriveSyncStatusResponse }>(
        '/api/integrations/google-drive/sync-now',
        {
          method: 'POST',
          headers: token ? { 'X-Google-Access-Token': token } : undefined,
        }
      );
      if (res?.status) applyDriveStatus(res.status);
      setMsg(`Full Google Drive sync completed cleanly (${res.filesUpdated} dataset file(s) updated in place).`);
    } catch (e: any) {
      setErr(e?.message || 'Manual Google Drive sync failed.');
    } finally {
      setSyncingDriveNow(false);
    }
  };

  const handleConfirmRestoreFromDrive = async () => {
    setRestoringFromDrive(true);
    setErr('');
    setMsg('');
    try {
      const token = getGoogleAccessToken();
      const res = await apiFetch<{
        ok: boolean;
        restoredFileName: string;
        preRestoreFilename: string;
        status: GoogleDriveSyncStatusResponse;
      }>('/api/integrations/google-drive/restore-from-drive', {
        method: 'POST',
        headers: token ? { 'X-Google-Access-Token': token } : undefined,
      });
      setConfirmRestoreModal(false);
      if (res?.status) applyDriveStatus(res.status);
      setMsg(
        `Restored live database from Google Drive (${res.restoredFileName}) and resumed 1-second continuous autosync.`
      );
      loadAll();
    } catch (e: any) {
      setConfirmRestoreModal(false);
      setErr(e?.message || 'Failed to restore database from Google Drive.');
    } finally {
      setRestoringFromDrive(false);
    }
  };

  const handleConfirmDeleteDriveFile = async () => {
    if (!confirmDeleteFileModal) return;
    setDeletingDriveFile(true);
    setErr('');
    setMsg('');
    try {
      const token = getGoogleAccessToken();
      const res = await apiFetch<{ status: GoogleDriveSyncStatusResponse }>(
        `/api/integrations/google-drive/files/${encodeURIComponent(confirmDeleteFileModal.drive_file_id)}`,
        {
          method: 'DELETE',
          headers: token ? { 'X-Google-Access-Token': token } : undefined,
        }
      );
      if (res?.status) applyDriveStatus(res.status);
      setMsg(`Deleted "${confirmDeleteFileModal.file_name}" from Google Drive.`);
      setConfirmDeleteFileModal(null);
    } catch (e: any) {
      setConfirmDeleteFileModal(null);
      setErr(e?.message || 'Failed to delete file from Google Drive.');
    } finally {
      setDeletingDriveFile(false);
    }
  };

  const handleSaveOutlookConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    try {
      await apiFetch('/api/integrations/outlook/config', {
        method: 'POST',
        body: JSON.stringify({
          clientId: oClientId || undefined,
          clientSecret: oClientSecret || undefined,
          tenantId: oTenantId,
          autoNotifyOnCreate: oAutoCreate,
          autoNotifyOnAssign: oAutoAssign,
          autoNotifyOnResolve: oAutoResolve,
        }),
      });
      setOClientSecret('');
      setMsg('Outlook OAuth settings saved securely on server.');
      await loadAll();
    } catch (e: any) {
      setErr(e?.message || 'Failed to save Outlook settings.');
    }
  };

  const handleConnectOutlook = async () => {
    setErr('');
    try {
      const { url } = await apiFetch<{ url: string }>('/api/integrations/outlook/auth-url');
      const popup = window.open(url, 'outlook_oauth', 'width=600,height=720');
      if (!popup) {
        setErr('Popup was blocked by browser. Allow popups for this site to authorize Microsoft Outlook.');
      }
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const handleDisconnectOutlook = async () => {
    setErr('');
    try {
      await apiFetch('/api/integrations/outlook/config', {
        method: 'POST',
        body: JSON.stringify({ disconnect: true }),
      });
      setMsg('Outlook account disconnected.');
      await loadAll();
    } catch (e: any) {
      setErr(e?.message || 'Failed to disconnect Outlook.');
    }
  };

  const handleSyncOutlookInbox = async () => {
    setErr('');
    try {
      const res = await apiFetch<{ synced: number }>('/api/integrations/outlook/sync-inbox', { method: 'POST' });
      setMsg(`Synced ${res.synced} new inbound email(s) from Microsoft Graph.`);
      await loadAll();
    } catch (e: any) {
      setErr(e?.message || 'Failed to sync Outlook inbox.');
    }
  };

  const handleLinkEmailToTicket = async (emailId: number, ticketId: string) => {
    if (!ticketId) return;
    setErr('');
    try {
      await apiFetch('/api/integrations/outlook/link-ticket', {
        method: 'POST',
        body: JSON.stringify({ email_id: emailId, ticket_id: Number(ticketId) }),
      });
      setMsg('Email linked to ticket.');
      await loadAll();
    } catch (e: any) {
      setErr(e?.message || 'Failed to link email to ticket.');
    }
  };

  const handleSaveWhatsAppConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    try {
      await apiFetch('/api/integrations/whatsapp/config', {
        method: 'POST',
        body: JSON.stringify({
          wabaId,
          phoneNumberId,
          accessToken: waToken || undefined,
          webhookVerifyToken: waVerifyToken || undefined,
          enabled: waEnabled,
          templates: {
            ticket_created: tplCreated,
            moderator_assigned: tplAssigned,
            ticket_progress: tplProgress,
            ticket_resolved: tplResolved,
          },
        }),
      });
      setWaToken('');
      setMsg('Meta WhatsApp Cloud API settings saved securely.');
      await loadAll();
    } catch (e: any) {
      setErr(e?.message || 'Failed to save WhatsApp settings.');
    }
  };

  const handleSaveSla = async (cfg: any) => {
    setErr('');
    try {
      await apiFetch(`/api/sla-configs/${cfg.id}`, {
        method: 'PUT',
        body: JSON.stringify(cfg),
      });
      setMsg(`Updated ${cfg.priority} SLA policy.`);
      await loadAll();
    } catch (e: any) {
      setErr(e?.message || 'Failed to update SLA policy.');
    }
  };

  const runtimeOrigin = window.location.origin;

  return (
    <div className="space-y-6">
      {/* Sub-Navigation */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setTab('drive')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md cursor-pointer ${
            tab === 'drive' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
          }`}
        >
          <HardDrive className="w-3.5 h-3.5 text-blue-600" />
          Cloud DB &amp; Google Drive Sync
        </button>
        <button
          type="button"
          onClick={() => setTab('notifications')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md cursor-pointer ${
            tab === 'notifications' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
          }`}
        >
          <Bell className="w-3.5 h-3.5" />
          Super Admin Notifications
        </button>
        <button
          type="button"
          onClick={() => setTab('outlook')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md cursor-pointer ${
            tab === 'outlook' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
          }`}
        >
          <Mail className="w-3.5 h-3.5" />
          Microsoft Outlook (Graph API)
        </button>
        <button
          type="button"
          onClick={() => setTab('whatsapp')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md cursor-pointer ${
            tab === 'whatsapp' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          Meta WhatsApp Cloud API
        </button>
        <button
          type="button"
          onClick={() => setTab('sla')}
          className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md cursor-pointer ${
            tab === 'sla' ? 'bg-white dark:bg-slate-900 shadow-sm' : 'text-slate-500'
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          SLA & Escalation Rules
        </button>
      </div>

      {err && (
        <div className="p-3 text-xs rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300">
          {err}
        </div>
      )}
      {msg && (
        <div className="p-3 text-xs rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">
          {msg}
        </div>
      )}

      {/* TAB: CLOUD DB & GOOGLE DRIVE CONTINUOUS SYNC */}
      {tab === 'drive' && (
        <div className="space-y-6">
          {/* Lifetime Always-On Cloud Web Database Card */}
          <div className="bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-900/70 rounded-xl p-6 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1 max-w-2xl">
                <div className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  <Database className="w-4 h-4" />
                  <span>Lifetime Always-On Cloud Web Database (No 60-Minute Expiry)</span>
                </div>
                <h2 className="text-base font-display font-bold text-slate-900 dark:text-white">
                  Persistent Cloud Firestore Database
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  All CRM records—tickets, Warehouses, Branches &amp; Operational Hubs, users, assets, budgets, expenses, chats, and settings—save continuously to your permanent Cloud Firestore database in real time and automatically recover whenever the server restarts. Unlike Google Drive OAuth tokens (~60 min), this Cloud Web Database session persists indefinitely.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {cloudDbStatus.connected ? (
                  <>
                    <button
                      type="button"
                      disabled={restoringCloudDb || !cloudDbStatus.cloudSnapshotDetected}
                      onClick={() => setConfirmCloudRestoreModal(true)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/60 disabled:opacity-50 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Restore from Cloud DB
                    </button>
                    <button
                      type="button"
                      disabled={syncingCloudNow || cloudDbStatus.syncing}
                      onClick={handleSyncCloudDbNow}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-60 cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${syncingCloudNow || cloudDbStatus.syncing ? 'animate-spin' : ''}`} />
                      {syncingCloudNow || cloudDbStatus.syncing ? 'Syncing Cloud DB...' : 'Sync Now to Cloud DB'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={googleSigningIn}
                    onClick={handleGoogleSignIn}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-60 cursor-pointer"
                  >
                    <Cloud className="w-3.5 h-3.5" />
                    {googleSigningIn ? 'Authorizing...' : 'Authorize Google & Activate Cloud DB'}
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50">
                <div className="text-[11px] text-slate-500">Lifetime Cloud DB State</div>
                <div className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
                  {cloudDbStatus.connected ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      <span className="text-emerald-700 dark:text-emerald-400">Active All Time</span>
                    </>
                  ) : (
                    <>
                      <Clock className="w-4 h-4 text-amber-500" />
                      <span className="text-amber-700 dark:text-amber-400">Sign In Once to Activate</span>
                    </>
                  )}
                </div>
                <div className="text-[11px] font-mono text-slate-500 mt-0.5 truncate">
                  {cloudDbStatus.email || 'No 60-min expiry once signed in'}
                </div>
              </div>

              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50">
                <div className="text-[11px] text-slate-500">Last Cloud Sync</div>
                <div className="mt-1 text-sm font-mono font-semibold text-slate-900 dark:text-white">
                  {formatDateTime(cloudDbStatus.lastSyncedAt || cloudDbStatus.cloudUpdatedAt)}
                </div>
                <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                  {cloudDbStatus.syncing ? 'Writing real-time updates…' : 'Real-time push active'}
                </div>
              </div>

              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50">
                <div className="text-[11px] text-slate-500">Cloud Stored Records</div>
                <div className="mt-1 text-xl font-mono font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">
                  {cloudDbStatus.totalRecords || cloudDbStatus.cloudTotalRecords || 0}
                </div>
                <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                  Across all CRM tables
                </div>
              </div>

              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50">
                <div className="text-[11px] text-slate-500">Auto-Recovery Protection</div>
                <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-white">
                  {cloudDbStatus.cloudSnapshotDetected ? 'Ready on Boot' : 'Awaiting Initial Sync'}
                </div>
                <div className="text-[11px] font-mono text-slate-500 mt-0.5 truncate">
                  {cloudDbStatus.projectId || 'Cloud Firestore'}
                </div>
              </div>
            </div>

            {cloudDbStatus.lastError && (
              <div className="p-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300">
                <strong>Cloud DB Notice:</strong> {cloudDbStatus.lastError}
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1 max-w-2xl">
                <div className="inline-flex items-center gap-2 text-xs font-semibold text-blue-700 dark:text-blue-400">
                  <FolderSync className="w-4 h-4" />
                  <span>Google Drive Folder Backup &amp; 1-Second Mirror</span>
                </div>
                <h2 className="text-base font-display font-bold text-slate-900 dark:text-white">
                  Google Drive Database Sync Engine
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  In addition to your permanent Cloud Web Database above, every change can also mirror in-place to your authorized Google Drive folder every 1 second when a Drive OAuth session is active.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                {!driveStatus?.tokenActive || needsGoogleAuth ? (
                  <button
                    type="button"
                    disabled={googleSigningIn}
                    onClick={handleGoogleSignIn}
                    className="gsi-material-button"
                  >
                    <div className="gsi-material-button-state" />
                    <div className="gsi-material-button-content-wrapper">
                      <div className="gsi-material-button-icon">
                        <svg
                          version="1.1"
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 48 48"
                          xmlnsXlink="http://www.w3.org/1999/xlink"
                          style={{ display: 'block' }}
                        >
                          <path
                            fill="#EA4335"
                            d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                          />
                          <path
                            fill="#4285F4"
                            d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                          />
                          <path
                            fill="#FBBC05"
                            d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                          />
                          <path
                            fill="#34A853"
                            d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                          />
                          <path fill="none" d="M0 0h48v48H0z" />
                        </svg>
                      </div>
                      <span className="gsi-material-button-contents">
                        {googleSigningIn ? 'Signing in...' : 'Sign in with Google'}
                      </span>
                    </div>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={restoringFromDrive}
                      onClick={() => setConfirmRestoreModal(true)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-950/60 disabled:opacity-60 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Restore from Drive
                    </button>
                    <button
                      type="button"
                      disabled={syncingDriveNow}
                      onClick={() => setConfirmManualSyncModal(true)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-60 cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${syncingDriveNow ? 'animate-spin' : ''}`} />
                      {syncingDriveNow ? 'Syncing Full Snapshot...' : 'Sync All Data Now'}
                    </button>
                    <button
                      type="button"
                      onClick={handleGoogleDisconnect}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      Disconnect Google
                    </button>
                  </>
                )}
              </div>
            </div>

            {driveStatus?.remoteRecoveryAvailable && (
              <div className="p-4 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1 max-w-2xl">
                  <div className="flex items-center gap-2 text-xs font-bold text-amber-900 dark:text-amber-200">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>Saved Database Detected in Google Drive (Auto-Overwrite Blocked)</span>
                  </div>
                  <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                    This server restarted with a fresh local database, and your existing saved database{' '}
                    <span className="font-mono font-semibold">{driveStatus.remoteRecoveryAvailable.fileName}</span> (
                    {formatBytesCompact(driveStatus.remoteRecoveryAvailable.sizeBytes)}) is stored safely in Google Drive.
                    Restore it now to recover all tickets, users, locations, assets, and chats and resume 1-second autosync.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmRestoreModal(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-amber-600 hover:bg-amber-700 text-white cursor-pointer shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Restore Database from Drive
                </button>
              </div>
            )}

            {/* Live Telemetry Strip */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50">
                <div className="text-[11px] text-slate-500">Sync Engine State</div>
                <div className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
                  {driveStatus?.tokenActive && driveStatus.config.sync_enabled && driveStatus.config.sync_confirmed ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      <span className="text-emerald-700 dark:text-emerald-400">
                        Active ({driveStatus.config.sync_interval_ms}ms)
                      </span>
                    </>
                  ) : driveStatus?.tokenActive && !driveStatus.config.sync_confirmed ? (
                    <>
                      <AlertTriangle className="w-4 h-4 text-amber-600" />
                      <span className="text-amber-700 dark:text-amber-400">Awaiting Confirmation</span>
                    </>
                  ) : (
                    <>
                      <Cloud className="w-4 h-4 text-slate-400" />
                      <span className="text-slate-600 dark:text-slate-300">
                        {driveStatus?.config.sync_enabled ? 'Awaiting Google Sign-In' : 'Paused'}
                      </span>
                    </>
                  )}
                </div>
                <div className="text-[11px] font-mono text-slate-500 mt-0.5 truncate">
                  {driveStatus?.connectedAccount?.email ||
                    driveStatus?.config.connected_google_email ||
                    'Not authenticated'}
                  {driveStatus?.tokenActive && getGoogleTokenRemainingMinutes() !== null
                    ? ` · ~${getGoogleTokenRemainingMinutes()}m session`
                    : ''}
                </div>
              </div>

              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50">
                <div className="text-[11px] text-slate-500">Last Synced Timestamp</div>
                <div className="mt-1 text-sm font-mono font-semibold text-slate-900 dark:text-white">
                  {formatDateTime(driveStatus?.config.last_synced_at)}
                </div>
                <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                  Runs: {driveStatus?.config.total_sync_runs ?? 0}
                </div>
              </div>

              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50">
                <div className="text-[11px] text-slate-500">Synchronized Records</div>
                <div className="mt-1 text-xl font-mono font-bold text-blue-700 dark:text-blue-400 tabular-nums">
                  {driveStatus?.config.total_records_synced ?? 0}
                </div>
                <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                  Across {driveStatus?.files.length ?? 0} Drive file(s)
                </div>
              </div>

              <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50">
                <div className="text-[11px] text-slate-500">Pending DB Changes</div>
                <div className="mt-1 text-xl font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                  {driveStatus?.pendingChanges ?? 0}
                </div>
                <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                  Seq #{driveStatus?.config.last_synced_seq ?? 0} / #{driveStatus?.latestSeq ?? 0}
                </div>
              </div>
            </div>

            {/* Direct Linked Google Drive Database Location & Access Bar */}
            <div className="p-4 rounded-xl border border-blue-200 dark:border-blue-900/60 bg-blue-50/50 dark:bg-blue-950/20 flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-900 dark:text-white">
                  <Link2 className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                  <span>Linked Google Drive Database Location</span>
                  {driveStatus?.folderAccess ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-[11px] font-medium">
                      <CheckCircle2 className="w-3 h-3" />
                      {driveStatus.folderAccess.name} ·{' '}
                      {driveStatus.folderAccess.canAddChildren ? 'Read/Write Verified' : 'Read-Only'}
                    </span>
                  ) : driveStatus?.tokenActive ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 text-[11px] font-medium">
                      Click Verify Access to test folder permissions
                    </span>
                  ) : (
                    <span className="text-[11px] font-normal text-slate-500">
                      Sign in with Google to verify write access & begin 1s sync
                    </span>
                  )}
                </div>
                <a
                  href={
                    driveStatus?.driveFolderHref ||
                    driveStatus?.config.drive_folder_url ||
                    'https://drive.google.com/drive/folders/18ub4PwnI3r9io--dCEULoQPW-vPW_ihT?usp=drive_link'
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-xs font-mono text-blue-700 dark:text-blue-400 hover:underline truncate"
                >
                  {driveStatus?.config.drive_folder_url ||
                    'https://drive.google.com/drive/folders/18ub4PwnI3r9io--dCEULoQPW-vPW_ihT?usp=drive_link'}
                </a>
                <div className="text-[11px] font-mono text-slate-500">
                  Target Folder ID:{' '}
                  <span className="font-semibold text-slate-700 dark:text-slate-300">
                    {driveStatus?.config.drive_folder_id || '18ub4PwnI3r9io--dCEULoQPW-vPW_ihT'}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <a
                  href={
                    driveStatus?.driveFolderHref ||
                    driveStatus?.config.drive_folder_url ||
                    'https://drive.google.com/drive/folders/18ub4PwnI3r9io--dCEULoQPW-vPW_ihT?usp=drive_link'
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-white dark:bg-slate-900 border border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open Drive Folder
                </a>
                <button
                  type="button"
                  onClick={handleCopyFolderUrl}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" />
                  {copiedFolderLink ? 'Copied!' : 'Copy Link'}
                </button>
                {driveStatus?.tokenActive && !needsGoogleAuth && (
                  <button
                    type="button"
                    disabled={verifyingFolder}
                    onClick={handleVerifyDriveFolder}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-emerald-300 dark:border-emerald-800 bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 disabled:opacity-60 cursor-pointer"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    {verifyingFolder ? 'Verifying...' : 'Verify Access'}
                  </button>
                )}
              </div>
            </div>

            {driveStatus?.config.last_error && (
              <div className="p-3 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-300">
                <strong>Sync Notice:</strong> {driveStatus.config.last_error}
              </div>
            )}

            <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-xs text-slate-600 dark:text-slate-300 space-y-1">
              <div className="font-semibold text-slate-900 dark:text-white">
                Lifetime Cloud Web Database + Google Drive Folder Backup
              </div>
              <p className="leading-relaxed">
                Google Drive OAuth access tokens expire after ~60 minutes per browser authorization, whereas your <strong>Lifetime Cloud Web Database (Cloud Firestore)</strong> stays authenticated indefinitely and auto-restores all CRM data on every restart so you never lose work or see a fresh empty portal. Re-authorize Google Drive above anytime you want fresh <span className="font-mono font-semibold">sdglobal-crm-live.db</span> snapshots written to your Drive folder.
              </p>
            </div>

            {/* Target Folder Configuration Form */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setConfirmSaveModal({
                  driveFolderUrl: driveUrlDraft.trim(),
                  syncIntervalMs: Number(driveIntervalDraft) || 1000,
                  syncEnabled: driveEnabledDraft,
                });
              }}
              className="space-y-4 pt-2 border-t border-slate-200 dark:border-slate-800"
            >
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-end">
                <div className="lg:col-span-7">
                  <label className="block text-xs font-medium mb-1">
                    Target Google Drive Folder URL or Folder ID *
                  </label>
                  <input
                    required
                    value={driveUrlDraft}
                    onChange={(e) => setDriveUrlDraft(e.target.value)}
                    placeholder="https://drive.google.com/drive/folders/..."
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div className="lg:col-span-2">
                  <label className="block text-xs font-medium mb-1">Sync Interval (ms)</label>
                  <input
                    type="number"
                    min={1000}
                    max={60000}
                    step={500}
                    value={driveIntervalDraft}
                    onChange={(e) => setDriveIntervalDraft(Number(e.target.value) || 1000)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div className="lg:col-span-3 flex items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-2 text-xs font-medium cursor-pointer">
                    <input
                      type="checkbox"
                      checked={driveEnabledDraft}
                      onChange={(e) => setDriveEnabledDraft(e.target.checked)}
                    />
                    <span>Continuous Auto-Sync</span>
                  </label>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-[11px] font-mono text-slate-500">
                  Resolved Folder ID: <span className="font-semibold text-slate-800 dark:text-slate-200">{driveStatus?.config.drive_folder_id}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={loadAll}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Refresh Status
                  </button>
                  <button
                    type="submit"
                    disabled={savingDrive}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-blue-700 text-white hover:opacity-90 disabled:opacity-50 cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {savingDrive ? 'Saving...' : 'Save & Enable Drive Sync'}
                  </button>
                </div>
              </div>
            </form>
          </div>

          {/* Synchronized Drive Files Table */}
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
            <div className="xl:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-display font-bold flex items-center gap-2">
                    <Database className="w-4 h-4 text-blue-600" />
                    <span>Synchronized Google Drive Files ({driveStatus?.files.length ?? 0})</span>
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Updated in-place via SHA-256 deduplication—zero duplicate files created.
                  </p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                      <th className="py-2.5 px-4">File Name</th>
                      <th className="py-2.5 px-4 text-right">Records</th>
                      <th className="py-2.5 px-4 text-right">Size</th>
                      <th className="py-2.5 px-4">Last Synced</th>
                      <th className="py-2.5 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {!driveStatus || driveStatus.files.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-slate-500">
                          No files synced to this Drive folder yet. Sign in with Google and confirm sync to upload initial snapshots.
                        </td>
                      </tr>
                    ) : (
                      driveStatus.files.map((f) => {
                        const isPrimaryDb = f.entity_key === 'sqlite_database';
                        const fileHref = `https://drive.google.com/file/d/${encodeURIComponent(f.drive_file_id)}/view`;
                        return (
                          <tr
                            key={f.id}
                            className={isPrimaryDb ? 'bg-blue-50/40 dark:bg-blue-950/20' : undefined}
                          >
                            <td className="py-2.5 px-4">
                              <div className="flex items-center gap-2">
                                <span className="font-mono font-semibold text-slate-900 dark:text-white">
                                  {f.file_name}
                                </span>
                                {isPrimaryDb && (
                                  <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-blue-100 dark:bg-blue-950/70 text-blue-700 dark:text-blue-300">
                                    Live SQLite DB
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] font-mono text-slate-400">
                                ID: {f.drive_file_id.slice(0, 14)}… · SHA256: {f.content_sha256?.slice(0, 10)}
                              </div>
                            </td>
                            <td className="py-2.5 px-4 text-right font-mono tabular-nums">{f.record_count}</td>
                            <td className="py-2.5 px-4 text-right font-mono tabular-nums">
                              {formatBytesCompact(f.byte_size)}
                            </td>
                            <td className="py-2.5 px-4 font-mono text-slate-500 whitespace-nowrap">
                              {formatDateTime(f.last_synced_at)}
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <div className="inline-flex items-center justify-end gap-1.5">
                                <a
                                  href={fileHref}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-blue-200 dark:border-blue-900/60 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/30"
                                  title="Open file directly in Google Drive"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                  Open
                                </a>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteFileModal(f)}
                                  className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer"
                                  title="Delete file from Google Drive"
                                >
                                  <Trash2 className="w-3 h-3" />
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Real-Time SQLite Mutation Changelog */}
            <div className="xl:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
                <h3 className="text-sm font-display font-bold flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-600" />
                  <span>Database Change Stream (Triggers)</span>
                </h3>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Captures INSERT, UPDATE, and DELETE operations for 1-second sync.
                </p>
              </div>
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                      <th className="py-2 px-3">Seq</th>
                      <th className="py-2 px-3">Table</th>
                      <th className="py-2 px-3">Op</th>
                      <th className="py-2 px-3">Row</th>
                      <th className="py-2 px-3">Timestamp</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {!driveStatus || driveStatus.recentChangelog.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-slate-500">
                          No database mutations recorded yet.
                        </td>
                      </tr>
                    ) : (
                      driveStatus.recentChangelog.map((ev) => (
                        <tr key={ev.seq}>
                          <td className="py-2 px-3 font-mono text-slate-400">#{ev.seq}</td>
                          <td className="py-2 px-3 font-mono font-medium">{ev.table_name}</td>
                          <td
                            className={`py-2 px-3 font-mono font-semibold ${
                              ev.operation === 'DELETE'
                                ? 'text-red-600 dark:text-red-400'
                                : ev.operation === 'INSERT'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-blue-600 dark:text-blue-400'
                            }`}
                          >
                            {ev.operation}
                          </td>
                          <td className="py-2 px-3 font-mono text-slate-500">{ev.record_id || '—'}</td>
                          <td className="py-2 px-3 font-mono text-slate-500 whitespace-nowrap">
                            {formatDateTime(ev.changed_at)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 0: SUPER ADMIN NOTIFICATIONS */}
      {tab === 'notifications' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
          <div>
            <h2 className="text-base font-display font-bold">Super Admin Notification Controls</h2>
            <p className="text-xs text-slate-500 mt-1">
              Control workflow notifications and live popup alerts for moderator activity, task reviews, and direct chat messages.
            </p>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="p-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-white">
                  Enable Super Admin Notifications (Master ON / OFF)
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  When OFF, workflow notification generation for moderator updates, notes, holds, reviews, and chat messages is paused cleanly without cluttering your inbox.
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  setErr('');
                  try {
                    const res = await updateNotificationPrefs({ enabled: !notificationPrefs.enabled });
                    setMsg(`Super Admin notifications turned ${res.enabled ? 'ON' : 'OFF'}.`);
                  } catch (e: any) {
                    setErr(e?.message || 'Failed to update notification preferences.');
                  }
                }}
                className={`px-4 py-2 text-xs font-semibold rounded-lg cursor-pointer shrink-0 ${
                  notificationPrefs.enabled
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                {notificationPrefs.enabled ? 'ON' : 'OFF'}
              </button>
            </div>

            <div className="p-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-slate-900 dark:text-white">
                  Live On-Screen Popup Alerts (ON / OFF)
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Display live toast popups in the bottom-right corner whenever a new alert arrives (requires Master Notifications ON).
                </p>
              </div>
              <button
                type="button"
                disabled={!notificationPrefs.enabled}
                onClick={async () => {
                  setErr('');
                  try {
                    const res = await updateNotificationPrefs({ popups_enabled: !notificationPrefs.popups_enabled });
                    setMsg(`Live popup alerts turned ${res.popups_enabled ? 'ON' : 'OFF'}.`);
                  } catch (e: any) {
                    setErr(e?.message || 'Failed to update live popup preferences.');
                  }
                }}
                className={`px-4 py-2 text-xs font-semibold rounded-lg cursor-pointer shrink-0 disabled:opacity-40 ${
                  notificationPrefs.popups_enabled && notificationPrefs.enabled
                    ? 'bg-blue-700 text-white hover:bg-blue-800'
                    : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                {notificationPrefs.popups_enabled ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-xs space-y-1.5">
            <div className="font-semibold text-slate-800 dark:text-slate-200">Monitored Super Admin Triggers</div>
            <div className="grid sm:grid-cols-2 gap-1.5 text-slate-600 dark:text-slate-400">
              <span>• Moderator accepts an assigned task</span>
              <span>• Moderator updates task status or adds notes</span>
              <span>• Task placed On Hold (with reason)</span>
              <span>• Moderator requests Pending Information</span>
              <span>• Task submitted as Ready for Review</span>
              <span>• Moderator sends a Direct Chat message</span>
              <span>• Task marked Completed after approval</span>
              <span>• Deduplicated in-app Notification Center</span>
            </div>
          </div>
        </div>
      )}

      {/* TAB 1: MICROSOFT OUTLOOK */}
      {tab === 'outlook' && outlookStatus && (
        <div className="space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-display font-bold">Microsoft Outlook OAuth 2.0 & Graph API</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Status:{' '}
                  <strong className={outlookStatus.connected ? 'text-emerald-600' : 'text-amber-600'}>
                    {outlookStatus.connected
                      ? `Connected as ${outlookStatus.connectedEmail}`
                      : 'Not Connected (Requires Azure App Registration & OAuth Sign-In)'}
                  </strong>
                </p>
              </div>
              <div className="flex items-center gap-2">
                {outlookStatus.connected ? (
                  <>
                    <button
                      type="button"
                      onClick={handleSyncOutlookInbox}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Sync Inbox
                    </button>
                    <button
                      type="button"
                      onClick={handleDisconnectOutlook}
                      className="px-3.5 py-2 text-xs font-semibold rounded-lg border border-red-300 text-red-600 cursor-pointer"
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleConnectOutlook}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 text-white hover:bg-blue-800 cursor-pointer"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Connect Microsoft Outlook
                  </button>
                )}
              </div>
            </div>

            <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-xs space-y-1">
              <div className="font-semibold">Azure Entra ID Redirect URI (Add to App Registration):</div>
              <code className="font-mono text-blue-700 dark:text-blue-400 block break-all">
                {runtimeOrigin}/auth/outlook/callback
              </code>
              <div className="text-slate-500 pt-1">
                Required Microsoft Graph Delegated Permissions: <code className="font-mono">User.Read, Mail.Read, Mail.Send, offline_access</code>
              </div>
            </div>

            <form onSubmit={handleSaveOutlookConfig} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Azure Client ID</label>
                  <input
                    value={oClientId}
                    onChange={(e) => setOClientId(e.target.value)}
                    placeholder={outlookStatus.clientIdSet ? `${outlookStatus.clientIdMasked || '••••'} (Configured)` : 'Application (client) ID'}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Azure Client Secret</label>
                  <input
                    type="password"
                    value={oClientSecret}
                    onChange={(e) => setOClientSecret(e.target.value)}
                    placeholder={outlookStatus.hasClientSecret ? `${outlookStatus.clientSecretMasked || '••••'} (Enter to rotate)` : 'Enter client secret'}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Tenant ID</label>
                  <input
                    value={oTenantId}
                    onChange={(e) => setOTenantId(e.target.value)}
                    placeholder="common or directory-tenant-id"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-6 text-xs">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={oAutoCreate} onChange={(e) => setOAutoCreate(e.target.checked)} />
                  <span>Auto-email confirmation on ticket creation</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={oAutoAssign} onChange={(e) => setOAutoAssign(e.target.checked)} />
                  <span>Auto-email employee on moderator assignment</span>
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={oAutoResolve} onChange={(e) => setOAutoResolve(e.target.checked)} />
                  <span>Auto-email employee on ticket resolution</span>
                </label>
              </div>

              <button
                type="submit"
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-blue-700 text-white cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                Save Outlook Configuration
              </button>
            </form>
          </div>

          {/* Email History & Ticket Association */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800">
              <h3 className="text-sm font-display font-semibold">Outlook Email Log & Ticket Linking</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 text-slate-500">
                    <th className="py-2.5 px-4">Direction</th>
                    <th className="py-2.5 px-4">From / To</th>
                    <th className="py-2.5 px-4">Subject</th>
                    <th className="py-2.5 px-4">Status</th>
                    <th className="py-2.5 px-4">Linked Ticket</th>
                    <th className="py-2.5 px-4">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(outlookStatus.history || []).length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500">
                        No Outlook emails dispatched or synced yet.
                      </td>
                    </tr>
                  ) : (
                    outlookStatus.history.map((em: any) => (
                      <tr key={em.id}>
                        <td className="py-2.5 px-4 font-semibold">{em.direction}</td>
                        <td className="py-2.5 px-4">
                          {em.sender_email} → {em.recipient_email}
                        </td>
                        <td className="py-2.5 px-4">{em.subject}</td>
                        <td className="py-2.5 px-4 font-mono">{em.status}</td>
                        <td className="py-2.5 px-4">
                          <select
                            value={em.ticket_id || ''}
                            onChange={(e) => handleLinkEmailToTicket(em.id, e.target.value)}
                            className="px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          >
                            <option value="">Unlinked</option>
                            {tickets.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.ticket_number}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-500">{formatDateTime(em.created_at)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: WHATSAPP CLOUD API */}
      {tab === 'whatsapp' && waStatus && (
        <div className="space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
            <div>
              <h2 className="text-base font-display font-bold">Official Meta WhatsApp Business Cloud API</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Status:{' '}
                <strong className={waStatus.configured && waStatus.enabled ? 'text-emerald-600' : 'text-amber-600'}>
                  {waStatus.configured && waStatus.enabled
                    ? 'Active & Configured'
                    : 'Not Configured (Enter Meta Business Cloud API Credentials)'}
                </strong>
              </p>
            </div>

            <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 text-xs space-y-1">
              <div className="font-semibold">Meta Webhook Callback URL (Configure in Meta Developer App):</div>
              <code className="font-mono text-blue-700 dark:text-blue-400 block break-all">
                {runtimeOrigin}/api/webhooks/whatsapp
              </code>
              <div className="text-slate-500 pt-1">
                Verify Token Status:{' '}
                <code className="font-mono">
                  {waStatus.hasVerifyToken ? `${waStatus.webhookVerifyTokenMasked || '••••'} (Encrypted on server)` : 'Not Configured'}
                </code>
              </div>
            </div>

            <form onSubmit={handleSaveWhatsAppConfig} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Meta Business Account ID (WABA ID)</label>
                  <input
                    value={wabaId}
                    onChange={(e) => setWabaId(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">WhatsApp Phone Number ID</label>
                  <input
                    value={phoneNumberId}
                    onChange={(e) => setPhoneNumberId(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Permanent System Access Token</label>
                  <input
                    type="password"
                    value={waToken}
                    onChange={(e) => setWaToken(e.target.value)}
                    placeholder={waStatus.hasAccessToken ? `${waStatus.accessTokenMasked || '••••'} (Enter to rotate)` : 'EAAG...'}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Webhook Verification Token</label>
                  <input
                    type="password"
                    value={waVerifyToken}
                    onChange={(e) => setWaVerifyToken(e.target.value)}
                    placeholder={waStatus.hasVerifyToken ? `${waStatus.webhookVerifyTokenMasked || '••••'} (Enter to rotate)` : 'Verify token'}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Template: Ticket Created</label>
                  <input
                    value={tplCreated}
                    onChange={(e) => setTplCreated(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Template: Moderator Assigned</label>
                  <input
                    value={tplAssigned}
                    onChange={(e) => setTplAssigned(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Template: Progress Update</label>
                  <input
                    value={tplProgress}
                    onChange={(e) => setTplProgress(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Template: Issue Resolved</label>
                  <input
                    value={tplResolved}
                    onChange={(e) => setTplResolved(e.target.value)}
                    className="w-full px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                <input type="checkbox" checked={waEnabled} onChange={(e) => setWaEnabled(e.target.checked)} />
                <span>Enable automatic WhatsApp notifications for ticket lifecycle events</span>
              </label>

              <div>
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save WhatsApp Cloud API Settings
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TAB 3: SLA & ESCALATION */}
      {tab === 'sla' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-blue-600" />
            <h2 className="text-base font-display font-bold">Configurable SLA Targets & Escalation Rules</h2>
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {slaConfigs.map((cfg, idx) => (
              <div key={cfg.id} className="p-5 grid grid-cols-1 sm:grid-cols-6 gap-3 items-end text-xs">
                <div>
                  <span className="text-slate-500 block mb-1">Priority Level</span>
                  <span className="font-display font-bold text-sm">{cfg.priority}</span>
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">1st Response (mins)</label>
                  <input
                    type="number"
                    value={cfg.first_response_minutes}
                    onChange={(e) => {
                      const next = [...slaConfigs];
                      next[idx] = { ...cfg, first_response_minutes: Number(e.target.value) };
                      setSlaConfigs(next);
                    }}
                    className="w-full px-3 py-1.5 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">Resolution (hours)</label>
                  <input
                    type="number"
                    value={cfg.resolution_hours}
                    onChange={(e) => {
                      const next = [...slaConfigs];
                      next[idx] = { ...cfg, resolution_hours: Number(e.target.value) };
                      setSlaConfigs(next);
                    }}
                    className="w-full px-3 py-1.5 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">Working Hours</label>
                  <div className="flex gap-1">
                    <input
                      value={cfg.working_hours_start}
                      onChange={(e) => {
                        const next = [...slaConfigs];
                        next[idx] = { ...cfg, working_hours_start: e.target.value };
                        setSlaConfigs(next);
                      }}
                      className="w-full px-2 py-1.5 font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                    <input
                      value={cfg.working_hours_end}
                      onChange={(e) => {
                        const next = [...slaConfigs];
                        next[idx] = { ...cfg, working_hours_end: e.target.value };
                        setSlaConfigs(next);
                      }}
                      className="w-full px-2 py-1.5 font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-slate-500 mb-1">Escalate To Email</label>
                  <input
                    value={cfg.escalate_to_email || ''}
                    onChange={(e) => {
                      const next = [...slaConfigs];
                      next[idx] = { ...cfg, escalate_to_email: e.target.value };
                      setSlaConfigs(next);
                    }}
                    className="w-full px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => handleSaveSla(cfg)}
                    className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-blue-700 text-white hover:bg-blue-800 cursor-pointer"
                  >
                    Update SLA
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confirmation Modal 1: Enable / Update Continuous Google Drive Sync */}
      {confirmSaveModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  Confirm Google Drive Sync Writes?
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">
                  {confirmSaveModal.syncEnabled
                    ? `This will continuously create and update 8 synchronized CRM dataset & database files inside Google Drive folder:`
                    : `This will save the target Google Drive folder location and pause automatic uploads:`}
                </p>
                <div className="mt-2 p-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] font-mono break-all text-slate-800 dark:text-slate-200">
                  {confirmSaveModal.driveFolderUrl}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmSaveModal(null)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmSaveDriveConfig}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer"
              >
                Confirm & Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal 2: Force Full Overwrite / Sync to Google Drive */}
      {confirmManualSyncModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <FolderSync className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  Overwrite & Sync All CRM Data to Google Drive?
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">
                  This will update the contents of all synchronized CRM snapshot files (full snapshot, locations, tickets, assets, budgets, communications, changelog, and live SQLite database) in folder{' '}
                  <span className="font-mono font-semibold">{driveStatus?.config.drive_folder_id}</span>.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmManualSyncModal(false)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmManualDriveSync}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-700 hover:bg-blue-800 text-white cursor-pointer"
              >
                Confirm Sync Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal 3: Delete File from Google Drive */}
      {confirmDeleteFileModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <ShieldAlert className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  Delete "{confirmDeleteFileModal.file_name}" from Google Drive?
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">
                  Are you sure you want to permanently remove <span className="font-mono font-semibold">{confirmDeleteFileModal.file_name}</span> (Drive ID: <span className="font-mono">{confirmDeleteFileModal.drive_file_id}</span>) from Google Drive? This action cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteFileModal(null)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletingDriveFile}
                onClick={handleConfirmDeleteDriveFile}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-60 cursor-pointer"
              >
                {deletingDriveFile ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal 4: Restore Live Database from Google Drive */}
      {confirmRestoreModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <RotateCcw className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  Restore Saved Database from Google Drive?
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">
                  This will download <span className="font-mono font-semibold">sdglobal-crm-live.db</span> from your Google Drive folder, verify SQLite integrity, replace the current local database (after taking a local safety snapshot), and resume 1-second continuous autosync.
                </p>
                {driveStatus?.remoteRecoveryAvailable && (
                  <div className="mt-2 p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] font-mono space-y-0.5">
                    <div>File: {driveStatus.remoteRecoveryAvailable.fileName}</div>
                    <div>Size: {formatBytesCompact(driveStatus.remoteRecoveryAvailable.sizeBytes)}</div>
                    <div>
                      Last Modified:{' '}
                      {driveStatus.remoteRecoveryAvailable.modifiedTime
                        ? formatDateTime(driveStatus.remoteRecoveryAvailable.modifiedTime)
                        : 'Latest on Drive'}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={restoringFromDrive}
                onClick={() => setConfirmRestoreModal(false)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
                <button
                  type="button"
                  disabled={restoringFromDrive}
                  onClick={handleConfirmRestoreFromDrive}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60 cursor-pointer"
                >
                  {restoringFromDrive ? 'Restoring Database...' : 'Restore & Resume 1s Sync'}
                </button>
              </div>
            </div>
          </div>
        )}

      {/* Confirmation Modal 5: Restore from Lifetime Cloud Database */}
      {confirmCloudRestoreModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
              <Database className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  Restore CRM Data from Lifetime Cloud Database?
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">
                  This will restore all {cloudDbStatus.cloudTotalRecords || cloudDbStatus.totalRecords} saved records from your persistent Cloud Firestore database into the live workspace after taking a local safety backup.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={restoringCloudDb}
                onClick={() => setConfirmCloudRestoreModal(false)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={restoringCloudDb}
                onClick={handleConfirmRestoreFromCloudDb}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60 cursor-pointer"
              >
                {restoringCloudDb ? 'Restoring...' : 'Confirm Restore'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

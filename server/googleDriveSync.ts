import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  db,
  restoreDatabaseFromFile,
  syncDepartmentDropdownOptions,
  syncLocationTypeDropdownOptions,
} from './db.ts';
import { writeAuditLog, type AuthUser } from './auth.ts';
import { broadcastAll, sendToSuperAdmins } from './realtime.ts';
import { checkAndNotifyCloudDbMutation } from './cloudDbService.ts';

export const DEFAULT_DRIVE_FOLDER_URL =
  'https://drive.google.com/drive/folders/18ub4PwnI3r9io--dCEULoQPW-vPW_ihT?usp=drive_link';
export const DEFAULT_DRIVE_FOLDER_ID = '18ub4PwnI3r9io--dCEULoQPW-vPW_ihT';

interface InMemoryDriveSession {
  accessToken: string;
  email?: string;
  displayName?: string;
  setAt: string;
}

interface VerifiedFolderAccess {
  id: string;
  name: string;
  webViewLink: string;
  canAddChildren: boolean;
  verifiedAt: string;
}

export interface RemoteRecoveryInfo {
  fileId: string;
  fileName: string;
  kind: 'sqlite' | 'json';
  sizeBytes: number;
  modifiedTime: string | null;
  webViewLink?: string;
}

// Keep Google OAuth access token strictly in server process memory (never stored on disk or browser storage)
let activeDriveSession: InMemoryDriveSession | null = null;
let verifiedFolderAccess: VerifiedFolderAccess | null = null;
let remoteRecoveryAvailable: RemoteRecoveryInfo | null = null;
let syncLoopTimer: ReturnType<typeof setInterval> | null = null;
let syncInFlight = false;
let lastDbSnapshotSeq = -1;
let lastCycleStartedAt = 0;
let consecutiveErrors = 0;
let nextRetryAt = 0;
let lastSuccessfulSyncAt: string | null = null;

const TRANSIENT_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);

async function fetchWithRetry(url: string, init: RequestInit = {}, maxRetries = 2): Promise<Response> {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= maxRetries) {
    try {
      const res = await fetch(url, init);
      if (res.ok || !TRANSIENT_HTTP_STATUS.has(res.status) || attempt === maxRetries) {
        return res;
      }
      const retryAfterSec = Number(res.headers.get('retry-after') || 0);
      const delayMs = retryAfterSec > 0
        ? Math.min(3000, retryAfterSec * 1000)
        : Math.min(2000, 300 * Math.pow(2, attempt) + Math.floor(Math.random() * 120));
      await new Promise((r) => setTimeout(r, delayMs));
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) throw err;
      const delayMs = Math.min(2000, 300 * Math.pow(2, attempt) + Math.floor(Math.random() * 120));
      await new Promise((r) => setTimeout(r, delayMs));
    }
    attempt += 1;
  }
  throw lastErr instanceof Error ? lastErr : new Error('Network request failed');
}

export function parseDriveFolderId(urlOrId: string): string | null {
  const raw = (urlOrId || '').trim();
  if (!raw) return null;

  const folderMatch = raw.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderMatch) return folderMatch[1];

  const idParamMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idParamMatch) return idParamMatch[1];

  if (/^[a-zA-Z0-9_-]{10,}$/.test(raw) && !raw.includes('http')) {
    return raw;
  }
  return null;
}

export function getDriveConfigRow(): {
  id: number;
  drive_folder_url: string;
  drive_folder_id: string;
  sync_interval_ms: number;
  sync_enabled: number;
  sync_confirmed: number;
  last_synced_seq: number;
  last_synced_at: string | null;
  last_status: string;
  last_error: string | null;
  total_sync_runs: number;
  total_records_synced: number;
  connected_google_email: string | null;
  updated_at: string;
} {
  let row = db.prepare('SELECT * FROM google_drive_sync_config WHERE id = 1').get() as any;
  if (!row) {
    db.prepare(
      `INSERT OR IGNORE INTO google_drive_sync_config (
        id, drive_folder_url, drive_folder_id, sync_interval_ms, sync_enabled, sync_confirmed, last_status
      ) VALUES (1, ?, ?, 1000, 1, 0, 'awaiting_auth')`
    ).run(DEFAULT_DRIVE_FOLDER_URL, DEFAULT_DRIVE_FOLDER_ID);
    row = db.prepare('SELECT * FROM google_drive_sync_config WHERE id = 1').get() as any;
  }
  return row;
}

export async function validateGoogleAccessToken(accessToken: string): Promise<{ email?: string; displayName?: string }> {
  const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      res.status === 401
        ? 'Google OAuth access token expired or invalid. Please sign in with Google again.'
        : `Google Drive API verification failed (${res.status}): ${errText.slice(0, 180)}`
    );
  }
  const data = (await res.json()) as { user?: { emailAddress?: string; displayName?: string } };
  return {
    email: data.user?.emailAddress,
    displayName: data.user?.displayName,
  };
}

export async function verifyFolderAccess(accessToken: string, folderId: string): Promise<VerifiedFolderAccess> {
  const res = await fetchWithRetry(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed,webViewLink,capabilities(canAddChildren,canEdit)&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    if (res.status === 401) {
      throw Object.assign(
        new Error('Google OAuth token expired (401). Please sign in with Google again.'),
        { statusCode: 401 }
      );
    }
    throw new Error(`Unable to access target Google Drive folder (${res.status}): ${txt.slice(0, 200)}`);
  }
  const info = (await res.json()) as {
    id: string;
    name: string;
    mimeType: string;
    trashed?: boolean;
    webViewLink?: string;
    capabilities?: { canAddChildren?: boolean; canEdit?: boolean };
  };
  if (info.trashed) {
    throw new Error('Target Google Drive folder is in Trash.');
  }
  if (info.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('Target Google Drive link does not point to a folder.');
  }
  const verified: VerifiedFolderAccess = {
    id: info.id,
    name: info.name,
    webViewLink: info.webViewLink || `https://drive.google.com/drive/folders/${encodeURIComponent(info.id)}`,
    canAddChildren: info.capabilities?.canAddChildren !== false,
    verifiedAt: new Date().toISOString(),
  };
  return verified;
}

function safeTableCount(tableName: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) as c FROM ${tableName}`).get() as { c: number } | undefined;
    return Number(row?.c || 0);
  } catch {
    return 0;
  }
}

export function isLocalDatabaseFresh(): boolean {
  return (
    safeTableCount('tickets') === 0 &&
    safeTableCount('employees') === 0 &&
    safeTableCount('moderators') === 0 &&
    safeTableCount('direct_messages') === 0 &&
    safeTableCount('expenses') === 0 &&
    safeTableCount('saved_reports') === 0
  );
}

export async function inspectRemoteDriveBackup(
  accessToken: string,
  folderId: string
): Promise<RemoteRecoveryInfo | null> {
  const q =
    `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false ` +
    `and (name = 'sdglobal-crm-live.db' or name = 'sdglobal-crm-full-snapshot.json')`;
  const url =
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}` +
    '&fields=files(id,name,size,modifiedTime,webViewLink)&pageSize=20&supportsAllDrives=true&includeItemsFromAllDrives=true';
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw Object.assign(new Error('Google Drive OAuth token expired (401). Please sign in again.'), { statusCode: 401 });
    }
    return null;
  }
  const data = (await res.json()) as {
    files?: Array<{ id: string; name: string; size?: string; modifiedTime?: string; webViewLink?: string }>;
  };
  const files = data.files || [];
  const sqliteFile = files.find((f) => f.name === 'sdglobal-crm-live.db' && Number(f.size || 0) > 0);
  if (sqliteFile) {
    return {
      fileId: sqliteFile.id,
      fileName: sqliteFile.name,
      kind: 'sqlite',
      sizeBytes: Number(sqliteFile.size || 0),
      modifiedTime: sqliteFile.modifiedTime || null,
      webViewLink: sqliteFile.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(sqliteFile.id)}/view`,
    };
  }
  const jsonFile = files.find((f) => f.name === 'sdglobal-crm-full-snapshot.json' && Number(f.size || 0) > 0);
  if (jsonFile) {
    return {
      fileId: jsonFile.id,
      fileName: jsonFile.name,
      kind: 'json',
      sizeBytes: Number(jsonFile.size || 0),
      modifiedTime: jsonFile.modifiedTime || null,
      webViewLink: jsonFile.webViewLink || `https://drive.google.com/file/d/${encodeURIComponent(jsonFile.id)}/view`,
    };
  }
  return null;
}

export async function verifyTargetDriveFolder(params: {
  driveFolderUrl?: string;
  actorUser: AuthUser;
}) {
  if (!activeDriveSession?.accessToken) {
    throw new Error('Sign in with Google first to verify Google Drive folder access.');
  }
  const cfg = getDriveConfigRow();
  const folderId = params.driveFolderUrl ? parseDriveFolderId(params.driveFolderUrl) : cfg.drive_folder_id;
  if (!folderId) {
    throw new Error('Please enter a valid Google Drive folder link or folder ID.');
  }
  const verified = await verifyFolderAccess(activeDriveSession.accessToken, folderId);
  if (folderId === cfg.drive_folder_id) {
    verifiedFolderAccess = verified;
    const remote = await inspectRemoteDriveBackup(activeDriveSession.accessToken, folderId).catch(() => null);
    remoteRecoveryAvailable = remote && isLocalDatabaseFresh() ? remote : null;
  }
  db.prepare(
    `UPDATE google_drive_sync_config
     SET last_error = NULL,
         updated_at = datetime('now')
     WHERE id = 1`
  ).run();
  emitStatusUpdate();
  return verified;
}

export async function registerGoogleDriveSession(params: {
  accessToken: string;
  actorUser: AuthUser;
  confirmSync?: boolean;
}): Promise<{
  email?: string;
  displayName?: string;
  folderAccess?: VerifiedFolderAccess | null;
  remoteRecoveryAvailable?: RemoteRecoveryInfo | null;
}> {
  const profile = await validateGoogleAccessToken(params.accessToken);
  activeDriveSession = {
    accessToken: params.accessToken,
    email: profile.email || params.actorUser.email,
    displayName: profile.displayName,
    setAt: new Date().toISOString(),
  };
  consecutiveErrors = 0;
  nextRetryAt = 0;

  const cfg = getDriveConfigRow();
  let folderCheckError: string | null = null;
  try {
    verifiedFolderAccess = await verifyFolderAccess(params.accessToken, cfg.drive_folder_id);
    const remoteBackup = await inspectRemoteDriveBackup(params.accessToken, cfg.drive_folder_id).catch(() => null);
    remoteRecoveryAvailable = remoteBackup && isLocalDatabaseFresh() ? remoteBackup : null;
  } catch (err: any) {
    verifiedFolderAccess = null;
    remoteRecoveryAvailable = null;
    folderCheckError = err?.message || 'Unable to access target Google Drive folder.';
  }

  if (params.confirmSync) {
    db.prepare(
      `UPDATE google_drive_sync_config
       SET connected_google_email = ?,
           sync_confirmed = 1,
           last_status = CASE WHEN sync_enabled = 1 THEN 'connected' ELSE 'paused' END,
           last_error = ?,
           updated_by = ?,
           updated_at = datetime('now')
       WHERE id = 1`
    ).run(activeDriveSession.email || null, folderCheckError, params.actorUser.id);
  } else {
    db.prepare(
      `UPDATE google_drive_sync_config
       SET connected_google_email = ?,
           last_status = CASE
             WHEN sync_confirmed = 1 AND sync_enabled = 1 THEN 'connected'
             WHEN sync_confirmed = 0 THEN 'awaiting_confirmation'
             ELSE 'paused'
           END,
           last_error = ?,
           updated_by = ?,
           updated_at = datetime('now')
       WHERE id = 1`
    ).run(activeDriveSession.email || null, folderCheckError, params.actorUser.id);
  }

  writeAuditLog({
    userId: params.actorUser.id,
    userEmail: params.actorUser.email,
    roleName: params.actorUser.role,
    action: 'GOOGLE_DRIVE_AUTHORIZED',
    entityType: 'integration',
    entityId: 'google_drive',
    details: {
      google_email: activeDriveSession.email || null,
      sync_confirmed: Boolean(params.confirmSync),
      folder_verified: Boolean(verifiedFolderAccess),
      remote_recovery_detected: Boolean(remoteRecoveryAvailable),
    },
  });

  emitStatusUpdate();
  return { ...profile, folderAccess: verifiedFolderAccess, remoteRecoveryAvailable };
}

export function clearGoogleDriveSession(actorUser?: AuthUser | null) {
  activeDriveSession = null;
  verifiedFolderAccess = null;
  remoteRecoveryAvailable = null;
  consecutiveErrors = 0;
  nextRetryAt = 0;
  db.prepare(
    `UPDATE google_drive_sync_config
     SET last_status = 'awaiting_auth',
         updated_at = datetime('now')
     WHERE id = 1`
  ).run();
  if (actorUser) {
    writeAuditLog({
      userId: actorUser.id,
      userEmail: actorUser.email,
      roleName: actorUser.role,
      action: 'GOOGLE_DRIVE_DISCONNECTED',
      entityType: 'integration',
      entityId: 'google_drive',
    });
  }
  emitStatusUpdate();
}

export async function restoreDatabaseFromGoogleDrive(actorUser: AuthUser): Promise<{
  ok: true;
  restoredFileName: string;
  preRestoreFilename: string;
}> {
  if (!activeDriveSession?.accessToken) {
    throw new Error('Sign in with Google first to restore the database from Google Drive.');
  }

  const accessToken = activeDriveSession.accessToken;
  const connectedEmail = activeDriveSession.email || null;
  const cfg = getDriveConfigRow();
  const remoteBackup =
    remoteRecoveryAvailable || (await inspectRemoteDriveBackup(accessToken, cfg.drive_folder_id));

  if (!remoteBackup || remoteBackup.kind !== 'sqlite') {
    throw new Error(
      'No valid SQLite database file (sdglobal-crm-live.db) was found in the linked Google Drive folder.'
    );
  }

  const downloadUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
    remoteBackup.fileId
  )}?alt=media&supportsAllDrives=true`;
  const dlRes = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!dlRes.ok) {
    if (dlRes.status === 401) {
      activeDriveSession = null;
      verifiedFolderAccess = null;
      emitStatusUpdate();
      throw new Error('Google Drive OAuth token expired (401). Please sign in with Google again.');
    }
    const errTxt = await dlRes.text().catch(() => '');
    throw new Error(`Failed to download database from Google Drive (${dlRes.status}): ${errTxt.slice(0, 180)}`);
  }

  const fileBytes = Buffer.from(await dlRes.arrayBuffer());
  if (fileBytes.byteLength < 1024) {
    throw new Error('Downloaded Google Drive database file appears empty or incomplete.');
  }

  const tmpRestorePath = path.join(os.tmpdir(), `sdglobal-drive-restore-${process.pid}-${Date.now()}.db`);
  try {
    fs.writeFileSync(tmpRestorePath, fileBytes);
    const { preRestoreFilename } = await restoreDatabaseFromFile(tmpRestorePath);

    syncDepartmentDropdownOptions();
    syncLocationTypeDropdownOptions();

    const latestSeqAfter = (
      db.prepare('SELECT COALESCE(MAX(seq), 0) as m FROM drive_sync_changelog').get() as { m: number }
    ).m;
    lastDbSnapshotSeq = latestSeqAfter;
    remoteRecoveryAvailable = null;

    const validActorRow = db.prepare('SELECT id FROM users WHERE id = ?').get(actorUser.id) as { id: number } | undefined;
    const safeUpdatedBy = validActorRow?.id ?? null;

    db.prepare(
      `INSERT INTO google_drive_sync_config (
        id, drive_folder_url, drive_folder_id, sync_interval_ms, sync_enabled, sync_confirmed,
        last_synced_seq, last_synced_at, last_status, last_error, connected_google_email, updated_by, updated_at
      ) VALUES (1, ?, ?, ?, 1, 1, ?, datetime('now'), 'synced', NULL, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        drive_folder_url = excluded.drive_folder_url,
        drive_folder_id = excluded.drive_folder_id,
        sync_interval_ms = excluded.sync_interval_ms,
        sync_enabled = 1,
        sync_confirmed = 1,
        last_synced_seq = excluded.last_synced_seq,
        last_status = 'synced',
        last_error = NULL,
        connected_google_email = COALESCE(excluded.connected_google_email, google_drive_sync_config.connected_google_email),
        updated_by = excluded.updated_by,
        updated_at = datetime('now')`
    ).run(
      cfg.drive_folder_url,
      cfg.drive_folder_id,
      Math.max(1000, cfg.sync_interval_ms || 1000),
      latestSeqAfter,
      connectedEmail,
      safeUpdatedBy
    );

    writeAuditLog({
      userId: safeUpdatedBy,
      userEmail: actorUser.email,
      roleName: actorUser.role,
      action: 'RESTORE_FROM_GOOGLE_DRIVE',
      entityType: 'database',
      entityId: remoteBackup.fileId,
      details: {
        file_name: remoteBackup.fileName,
        size_bytes: remoteBackup.sizeBytes,
        pre_restore_filename: preRestoreFilename,
      },
    });

    emitStatusUpdate();
    broadcastAll('system:restored', {
      source: 'google_drive',
      filename: remoteBackup.fileName,
      restored_at: new Date().toISOString(),
    });

    return {
      ok: true,
      restoredFileName: remoteBackup.fileName,
      preRestoreFilename,
    };
  } finally {
    try {
      if (fs.existsSync(tmpRestorePath)) fs.unlinkSync(tmpRestorePath);
    } catch {
      // ignore temp cleanup failure
    }
  }
}

export async function updateGoogleDriveConfig(params: {
  driveFolderUrl?: string;
  syncIntervalMs?: number;
  syncEnabled?: boolean;
  syncConfirmed?: boolean;
  actorUser: AuthUser;
}) {
  const current = getDriveConfigRow();
  let nextUrl = current.drive_folder_url;
  let nextFolderId = current.drive_folder_id;

  if (params.driveFolderUrl !== undefined) {
    const parsedId = parseDriveFolderId(params.driveFolderUrl);
    if (!parsedId) {
      throw new Error('Please enter a valid Google Drive folder link or folder ID.');
    }
    nextUrl = params.driveFolderUrl.trim();
    nextFolderId = parsedId;
  }

  const nextEnabled = params.syncEnabled !== undefined ? (params.syncEnabled ? 1 : 0) : current.sync_enabled;
  const nextConfirmed = params.syncConfirmed !== undefined ? (params.syncConfirmed ? 1 : 0) : current.sync_confirmed;
  const nextInterval =
    params.syncIntervalMs !== undefined
      ? Math.max(1000, Math.min(60_000, Math.round(Number(params.syncIntervalMs) || 1000)))
      : Math.max(1000, current.sync_interval_ms || 1000);

  if (activeDriveSession?.accessToken) {
    verifiedFolderAccess = await verifyFolderAccess(activeDriveSession.accessToken, nextFolderId);
  } else if (nextFolderId !== current.drive_folder_id) {
    verifiedFolderAccess = null;
  }

  const folderChanged = nextFolderId !== current.drive_folder_id;
  if (folderChanged) {
    lastDbSnapshotSeq = -1;
  }
  const nextStatus = !activeDriveSession?.accessToken
    ? 'awaiting_auth'
    : !nextConfirmed
    ? 'awaiting_confirmation'
    : nextEnabled
    ? 'connected'
    : 'paused';

  db.prepare(
    `UPDATE google_drive_sync_config
     SET drive_folder_url = ?,
         drive_folder_id = ?,
         sync_interval_ms = ?,
         sync_enabled = ?,
         sync_confirmed = ?,
         last_synced_seq = CASE WHEN ? = 1 THEN 0 ELSE last_synced_seq END,
         last_status = ?,
         last_error = NULL,
         updated_by = ?,
         updated_at = datetime('now')
     WHERE id = 1`
  ).run(
    nextUrl,
    nextFolderId,
    nextInterval,
    nextEnabled,
    nextConfirmed,
    folderChanged ? 1 : 0,
    nextStatus,
    params.actorUser.id
  );

  writeAuditLog({
    userId: params.actorUser.id,
    userEmail: params.actorUser.email,
    roleName: params.actorUser.role,
    action: 'UPDATE_GOOGLE_DRIVE_SYNC_CONFIG',
    entityType: 'integration',
    entityId: 'google_drive',
    details: {
      drive_folder_id: nextFolderId,
      sync_interval_ms: nextInterval,
      sync_enabled: Boolean(nextEnabled),
      sync_confirmed: Boolean(nextConfirmed),
    },
  });

  emitStatusUpdate();

  if (nextEnabled && nextConfirmed && activeDriveSession?.accessToken) {
    await runGoogleDriveSyncCycle({ force: folderChanged || nextConfirmed === 1, actorUser: params.actorUser });
  }

  return getGoogleDriveStatus();
}

export function getGoogleDriveStatus() {
  const cfg = getDriveConfigRow();
  const latestSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) as m FROM drive_sync_changelog').get() as { m: number }).m;
  const pendingChanges = Math.max(0, latestSeq - (cfg.last_synced_seq || 0));
  const files = db
    .prepare('SELECT * FROM google_drive_file_map WHERE folder_id = ? ORDER BY entity_key ASC')
    .all(cfg.drive_folder_id);
  const recentChangelog = db
    .prepare('SELECT * FROM drive_sync_changelog ORDER BY seq DESC LIMIT 25')
    .all();

  const driveFolderHref =
    verifiedFolderAccess?.id === cfg.drive_folder_id
      ? verifiedFolderAccess.webViewLink
      : `https://drive.google.com/drive/folders/${encodeURIComponent(cfg.drive_folder_id)}`;

  return {
    config: {
      ...cfg,
      sync_enabled: Boolean(cfg.sync_enabled),
      sync_confirmed: Boolean(cfg.sync_confirmed),
    },
    driveFolderHref,
    folderAccess: verifiedFolderAccess?.id === cfg.drive_folder_id ? verifiedFolderAccess : null,
    remoteRecoveryAvailable: remoteRecoveryAvailable && isLocalDatabaseFresh() ? remoteRecoveryAvailable : null,
    tokenActive: Boolean(activeDriveSession?.accessToken),
    connectedAccount: activeDriveSession
      ? {
          email: activeDriveSession.email,
          displayName: activeDriveSession.displayName,
          setAt: activeDriveSession.setAt,
        }
      : null,
    pendingChanges,
    latestSeq,
    syncInFlight,
    consecutiveErrors,
    nextRetryAt: nextRetryAt > Date.now() ? new Date(nextRetryAt).toISOString() : null,
    lastSuccessfulSyncAt: lastSuccessfulSyncAt || cfg.last_synced_at,
    files,
    recentChangelog,
  };
}

function emitStatusUpdate() {
  try {
    sendToSuperAdmins('drive_sync:updated', getGoogleDriveStatus());
  } catch {
    // ignore socket emission errors
  }
}

interface SyncPayloadSpec {
  entityKey: string;
  fileName: string;
  mimeType: string;
  recordCount: number;
  content: Buffer;
}

function querySafe(sql: string): any[] {
  try {
    return db.prepare(sql).all() as any[];
  } catch {
    return [];
  }
}

function buildDomainDatasets(syncAtIso: string, latestSeq: number): {
  datasets: SyncPayloadSpec[];
  totalRecords: number;
} {
  const locations = querySafe('SELECT * FROM locations ORDER BY id ASC');
  const departments = querySafe('SELECT * FROM departments ORDER BY id ASC');
  const users = querySafe(
    `SELECT u.id, u.role_id, r.name as role_name, u.email, u.full_name, u.status,
            u.must_reset_password, u.mobile, u.last_login_at, u.last_login_ip, u.created_at
     FROM users u
     LEFT JOIN roles r ON u.role_id = r.id
     ORDER BY u.id ASC`
  );
  const employees = querySafe('SELECT * FROM employees ORDER BY id ASC');
  const moderators = querySafe('SELECT * FROM moderators ORDER BY id ASC');

  const tickets = querySafe('SELECT * FROM tickets ORDER BY id ASC');
  const ticketAssignments = querySafe('SELECT * FROM ticket_assignments ORDER BY id ASC');
  const ticketActivities = querySafe('SELECT * FROM ticket_activities ORDER BY id ASC');
  const ticketComments = querySafe('SELECT * FROM ticket_comments ORDER BY id ASC');
  const ticketTimeLogs = querySafe('SELECT * FROM ticket_time_logs ORDER BY id ASC');

  const itAssets = querySafe('SELECT * FROM it_assets ORDER BY id ASC');
  const assetHistory = querySafe('SELECT * FROM asset_history ORDER BY id ASC');
  const assetMaintenance = querySafe('SELECT * FROM asset_maintenance ORDER BY id ASC');

  const itBudgets = querySafe('SELECT * FROM it_budgets ORDER BY id ASC');
  const expenses = querySafe('SELECT * FROM expenses ORDER BY id ASC');
  const expenseApprovals = querySafe('SELECT * FROM expense_approvals ORDER BY id ASC');
  const vendors = querySafe('SELECT * FROM vendors ORDER BY id ASC');

  const slaConfigurations = querySafe('SELECT * FROM sla_configurations ORDER BY id ASC');
  const dropdownOptions = querySafe('SELECT * FROM dropdown_options ORDER BY group_key ASC, sort_order ASC, id ASC');
  const broadcastNotifications = querySafe('SELECT * FROM broadcast_notifications ORDER BY id ASC');
  const directMessages = querySafe('SELECT * FROM direct_messages ORDER BY id ASC');
  const savedReports = querySafe('SELECT * FROM saved_reports ORDER BY id ASC');
  const retentionPolicies = querySafe('SELECT * FROM retention_policies ORDER BY entity_key ASC');
  const adminPermissions = querySafe('SELECT * FROM admin_permissions ORDER BY id ASC');
  const crmBackups = querySafe('SELECT * FROM crm_backups ORDER BY id ASC');
  const recentChangelog = querySafe('SELECT * FROM drive_sync_changelog ORDER BY seq DESC LIMIT 500');

  const makeJsonSpec = (entityKey: string, fileName: string, data: any, recordCount: number): SyncPayloadSpec => {
    const buf = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    return {
      entityKey,
      fileName,
      mimeType: 'application/json',
      recordCount,
      content: buf,
    };
  };

  const fullSnapshotData = {
    schema_version: '1.0',
    application: 'SD Global IT CRM',
    synced_at: syncAtIso,
    changelog_seq: latestSeq,
    counts: {
      locations: locations.length,
      departments: departments.length,
      users: users.length,
      employees: employees.length,
      moderators: moderators.length,
      tickets: tickets.length,
      it_assets: itAssets.length,
      it_budgets: itBudgets.length,
      expenses: expenses.length,
      vendors: vendors.length,
      direct_messages: directMessages.length,
      broadcast_notifications: broadcastNotifications.length,
      saved_reports: savedReports.length,
      dropdown_options: dropdownOptions.length,
    },
    data: {
      locations,
      departments,
      users,
      employees,
      moderators,
      tickets,
      ticket_assignments: ticketAssignments,
      ticket_activities: ticketActivities,
      ticket_comments: ticketComments,
      ticket_time_logs: ticketTimeLogs,
      it_assets: itAssets,
      asset_history: assetHistory,
      asset_maintenance: assetMaintenance,
      it_budgets: itBudgets,
      expenses,
      expense_approvals: expenseApprovals,
      vendors,
      sla_configurations: slaConfigurations,
      dropdown_options: dropdownOptions,
      broadcast_notifications: broadcastNotifications,
      direct_messages: directMessages,
      saved_reports: savedReports,
      retention_policies: retentionPolicies,
      admin_permissions: adminPermissions,
      crm_backups: crmBackups,
    },
  };

  const totalRecords =
    locations.length +
    departments.length +
    users.length +
    employees.length +
    moderators.length +
    tickets.length +
    ticketAssignments.length +
    ticketActivities.length +
    ticketComments.length +
    ticketTimeLogs.length +
    itAssets.length +
    assetHistory.length +
    assetMaintenance.length +
    itBudgets.length +
    expenses.length +
    expenseApprovals.length +
    vendors.length +
    slaConfigurations.length +
    dropdownOptions.length +
    broadcastNotifications.length +
    directMessages.length +
    savedReports.length +
    retentionPolicies.length +
    adminPermissions.length +
    crmBackups.length;

  const datasets: SyncPayloadSpec[] = [
    makeJsonSpec('full_snapshot', 'sdglobal-crm-full-snapshot.json', fullSnapshotData, totalRecords),
    makeJsonSpec(
      'locations_directory',
      'sdglobal-crm-locations-directory.json',
      { locations, departments, users, employees, moderators },
      locations.length + departments.length + users.length + employees.length + moderators.length
    ),
    makeJsonSpec(
      'tickets_workflows',
      'sdglobal-crm-tickets-workflows.json',
      {
        tickets,
        ticket_assignments: ticketAssignments,
        ticket_activities: ticketActivities,
        ticket_comments: ticketComments,
        ticket_time_logs: ticketTimeLogs,
      },
      tickets.length + ticketAssignments.length + ticketActivities.length + ticketComments.length + ticketTimeLogs.length
    ),
    makeJsonSpec(
      'assets_maintenance',
      'sdglobal-crm-assets-maintenance.json',
      { it_assets: itAssets, asset_history: assetHistory, asset_maintenance: assetMaintenance },
      itAssets.length + assetHistory.length + assetMaintenance.length
    ),
    makeJsonSpec(
      'budgets_expenses',
      'sdglobal-crm-budgets-expenses.json',
      { it_budgets: itBudgets, expenses, expense_approvals: expenseApprovals, vendors },
      itBudgets.length + expenses.length + expenseApprovals.length + vendors.length
    ),
    makeJsonSpec(
      'settings_communications',
      'sdglobal-crm-settings-communications.json',
      {
        sla_configurations: slaConfigurations,
        dropdown_options: dropdownOptions,
        broadcast_notifications: broadcastNotifications,
        direct_messages: directMessages,
        saved_reports: savedReports,
        retention_policies: retentionPolicies,
        admin_permissions: adminPermissions,
        crm_backups: crmBackups,
      },
      slaConfigurations.length +
        dropdownOptions.length +
        broadcastNotifications.length +
        directMessages.length +
        savedReports.length +
        retentionPolicies.length +
        adminPermissions.length +
        crmBackups.length
    ),
    makeJsonSpec(
      'sync_changelog',
      'sdglobal-crm-sync-changelog.json',
      { changelog_seq: latestSeq, events: recentChangelog },
      recentChangelog.length
    ),
  ];

  return { datasets, totalRecords };
}

async function listFolderFilesByName(accessToken: string, folderId: string): Promise<Map<string, string>> {
  const q = `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`;
  const url =
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}` +
    '&fields=files(id,name)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true';
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw Object.assign(new Error('Google Drive OAuth token expired (401). Please sign in again.'), { statusCode: 401 });
    }
    const txt = await res.text().catch(() => '');
    throw new Error(`Failed to list Google Drive folder files (${res.status}): ${txt.slice(0, 180)}`);
  }
  const data = (await res.json()) as { files?: Array<{ id: string; name: string }> };
  const map = new Map<string, string>();
  for (const f of data.files || []) {
    if (f.name && f.id && !map.has(f.name)) {
      map.set(f.name, f.id);
    }
  }
  return map;
}

async function uploadOrUpdateDriveFile(params: {
  accessToken: string;
  folderId: string;
  existingFileId?: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
}): Promise<string> {
  const boundary = `sdglobal_drive_sync_${crypto.randomBytes(8).toString('hex')}`;
  const metadata = params.existingFileId
    ? { name: params.fileName }
    : { name: params.fileName, parents: [params.folderId] };

  const headerPart = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${params.mimeType}\r\n\r\n`,
    'utf8'
  );
  const footerPart = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  const multipartBody = Buffer.concat([headerPart, params.content, footerPart]);

  const endpoint = params.existingFileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(params.existingFileId)}?uploadType=multipart&supportsAllDrives=true`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true';

  const res = await fetchWithRetry(endpoint, {
    method: params.existingFileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  if (!res.ok) {
    // If cached fileId was deleted externally in Drive (404), create a fresh one cleanly
    if (params.existingFileId && res.status === 404) {
      return uploadOrUpdateDriveFile({ ...params, existingFileId: undefined });
    }
    if (res.status === 401) {
      throw Object.assign(new Error('Google Drive OAuth token expired (401). Please sign in again.'), { statusCode: 401 });
    }
    const errText = await res.text().catch(() => '');
    throw new Error(`Drive upload failed for ${params.fileName} (${res.status}): ${errText.slice(0, 180)}`);
  }

  const parsed = (await res.json()) as { id: string };
  return parsed.id;
}

export async function runGoogleDriveSyncCycle(options?: {
  force?: boolean;
  actorUser?: AuthUser | null;
}): Promise<{ synced: boolean; filesUpdated: number; skippedReason?: string }> {
  if (syncInFlight) {
    return { synced: false, filesUpdated: 0, skippedReason: 'sync_in_flight' };
  }

  const cfg = getDriveConfigRow();
  if (!activeDriveSession?.accessToken) {
    return { synced: false, filesUpdated: 0, skippedReason: 'awaiting_auth' };
  }
  if (!options?.force && (!cfg.sync_enabled || !cfg.sync_confirmed)) {
    return { synced: false, filesUpdated: 0, skippedReason: !cfg.sync_confirmed ? 'awaiting_confirmation' : 'paused' };
  }

  if (!options?.force) {
    if (remoteRecoveryAvailable && isLocalDatabaseFresh()) {
      return { synced: false, filesUpdated: 0, skippedReason: 'recovery_pending' };
    }
    if (nextRetryAt > Date.now()) {
      return { synced: false, filesUpdated: 0, skippedReason: 'backoff_wait' };
    }
    const intervalMs = Math.max(1000, cfg.sync_interval_ms || 1000);
    if (Date.now() - lastCycleStartedAt < intervalMs - 100) {
      return { synced: false, filesUpdated: 0, skippedReason: 'interval_wait' };
    }
  } else {
    remoteRecoveryAvailable = null;
    nextRetryAt = 0;
  }

  const latestSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) as m FROM drive_sync_changelog').get() as { m: number }).m;
  const sqliteMapped = db
    .prepare("SELECT drive_file_id FROM google_drive_file_map WHERE folder_id = ? AND entity_key = 'sqlite_database'")
    .get(cfg.drive_folder_id) as { drive_file_id: string } | undefined;

  if (!options?.force && latestSeq <= (cfg.last_synced_seq || 0) && sqliteMapped) {
    return { synced: false, filesUpdated: 0, skippedReason: 'up_to_date' };
  }

  syncInFlight = true;
  lastCycleStartedAt = Date.now();
  const nowIso = new Date().toISOString();

  try {
    const accessToken = activeDriveSession.accessToken;
    const folderId = cfg.drive_folder_id;

    if (!verifiedFolderAccess || verifiedFolderAccess.id !== folderId) {
      verifiedFolderAccess = await verifyFolderAccess(accessToken, folderId);
    }

    // Discover existing files once per folder (or when forcing) to prevent duplicates
    const mappedRows = db
      .prepare('SELECT * FROM google_drive_file_map WHERE folder_id = ?')
      .all(folderId) as Array<{
      id: number;
      entity_key: string;
      drive_file_id: string;
      file_name: string;
      content_sha256: string | null;
    }>;
    const mappedByKey = new Map(mappedRows.map((r) => [r.entity_key, r]));

    let remoteFilesByName: Map<string, string> | null = null;
    if (mappedRows.length === 0 || options?.force) {
      remoteFilesByName = await listFolderFilesByName(accessToken, folderId);
    }

    const { datasets, totalRecords } = buildDomainDatasets(nowIso, latestSeq);

    // Sync the live SQLite binary database snapshot on every 1-second change cycle or force
    const shouldSyncSqliteSnapshot =
      Boolean(options?.force) || !sqliteMapped || latestSeq > lastDbSnapshotSeq;

    if (shouldSyncSqliteSnapshot) {
      const tmpSnapPath = path.join(os.tmpdir(), `sdglobal-drive-snap-${process.pid}-${Date.now()}.db`);
      try {
        try {
          db.pragma('wal_checkpoint(PASSIVE)');
        } catch {
          // ignore
        }
        await db.backup(tmpSnapPath);
        const snapBuf = fs.readFileSync(tmpSnapPath);
        datasets.push({
          entityKey: 'sqlite_database',
          fileName: 'sdglobal-crm-live.db',
          mimeType: 'application/x-sqlite3',
          recordCount: totalRecords,
          content: snapBuf,
        });
        lastDbSnapshotSeq = latestSeq;
      } finally {
        try {
          if (fs.existsSync(tmpSnapPath)) fs.unlinkSync(tmpSnapPath);
        } catch {
          // ignore
        }
      }
    }

    // Compute SHA-256 and filter to only modified files so every 1-second cycle finishes fast
    const pendingUploads: Array<{ ds: SyncPayloadSpec; sha256: string; targetFileId?: string }> = [];
    for (const ds of datasets) {
      const sha256 = crypto.createHash('sha256').update(ds.content).digest('hex');
      const existingMap = mappedByKey.get(ds.entityKey);

      if (!options?.force && existingMap && existingMap.content_sha256 === sha256) {
        continue;
      }

      if (!existingMap && !remoteFilesByName) {
        remoteFilesByName = await listFolderFilesByName(accessToken, folderId);
      }

      const targetFileId = existingMap?.drive_file_id || remoteFilesByName?.get(ds.fileName);
      pendingUploads.push({ ds, sha256, targetFileId });
    }

    const uploadResults = await Promise.all(
      pendingUploads.map(async ({ ds, sha256, targetFileId }) => {
        const driveFileId = await uploadOrUpdateDriveFile({
          accessToken,
          folderId,
          existingFileId: targetFileId,
          fileName: ds.fileName,
          mimeType: ds.mimeType,
          content: ds.content,
        });
        return { ds, sha256, driveFileId };
      })
    );

    const upsertMap = db.prepare(
      `INSERT INTO google_drive_file_map (
        entity_key, folder_id, drive_file_id, file_name, mime_type, content_sha256, record_count, byte_size, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(folder_id, entity_key) DO UPDATE SET
        drive_file_id = excluded.drive_file_id,
        file_name = excluded.file_name,
        mime_type = excluded.mime_type,
        content_sha256 = excluded.content_sha256,
        record_count = excluded.record_count,
        byte_size = excluded.byte_size,
        last_synced_at = excluded.last_synced_at`
    );

    const applyMapUpdates = db.transaction(() => {
      for (const item of uploadResults) {
        upsertMap.run(
          item.ds.entityKey,
          folderId,
          item.driveFileId,
          item.ds.fileName,
          item.ds.mimeType,
          item.sha256,
          item.ds.recordCount,
          item.ds.content.byteLength,
          nowIso
        );
      }
    });
    applyMapUpdates();

    const filesUpdated = uploadResults.length;

    db.prepare(
      `UPDATE google_drive_sync_config
       SET last_synced_seq = ?,
           last_synced_at = ?,
           last_status = 'synced',
           last_error = NULL,
           total_sync_runs = total_sync_runs + 1,
           total_records_synced = ?,
           updated_at = datetime('now')
       WHERE id = 1`
    ).run(latestSeq, nowIso, totalRecords);

    // Prevent unbounded changelog growth while retaining recent history
    db.prepare('DELETE FROM drive_sync_changelog WHERE seq <= ?').run(Math.max(0, latestSeq - 5000));

    if (options?.actorUser) {
      writeAuditLog({
        userId: options.actorUser.id,
        userEmail: options.actorUser.email,
        roleName: options.actorUser.role,
        action: 'GOOGLE_DRIVE_SYNC_COMPLETED',
        entityType: 'integration',
        entityId: folderId,
        details: { files_updated: filesUpdated, total_records: totalRecords, seq: latestSeq },
      });
    }

    consecutiveErrors = 0;
    nextRetryAt = 0;
    lastSuccessfulSyncAt = nowIso;

    emitStatusUpdate();
    return { synced: true, filesUpdated };
  } catch (err: any) {
    const isAuthErr = err?.statusCode === 401 || String(err?.message || '').includes('401');
    if (isAuthErr) {
      activeDriveSession = null;
      verifiedFolderAccess = null;
      consecutiveErrors = 0;
      nextRetryAt = 0;
    } else {
      consecutiveErrors += 1;
      const backoffMs = Math.min(60_000, 1000 * Math.pow(2, Math.min(consecutiveErrors, 6)));
      nextRetryAt = Date.now() + backoffMs;
    }
    db.prepare(
      `UPDATE google_drive_sync_config
       SET last_status = ?,
           last_error = ?,
           updated_at = datetime('now')
       WHERE id = 1`
    ).run(isAuthErr ? 'awaiting_auth' : 'error', String(err?.message || 'Google Drive sync error').slice(0, 400));

    emitStatusUpdate();
    if (options?.force) {
      throw err;
    }
    return { synced: false, filesUpdated: 0, skippedReason: isAuthErr ? 'awaiting_auth' : 'error' };
  } finally {
    syncInFlight = false;
  }
}

export async function deleteSyncedDriveFile(driveFileId: string, actorUser: AuthUser) {
  if (!activeDriveSession?.accessToken) {
    throw new Error('Sign in with Google first to manage or delete files in Google Drive.');
  }

  const row = db.prepare('SELECT * FROM google_drive_file_map WHERE drive_file_id = ?').get(driveFileId) as any;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}?supportsAllDrives=true`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${activeDriveSession.accessToken}` },
    }
  );

  if (!res.ok && res.status !== 404) {
    if (res.status === 401) {
      activeDriveSession = null;
      emitStatusUpdate();
      throw new Error('Google Drive OAuth token expired. Please sign in with Google again.');
    }
    const errText = await res.text().catch(() => '');
    throw new Error(`Failed to delete file from Google Drive (${res.status}): ${errText.slice(0, 180)}`);
  }

  db.prepare('DELETE FROM google_drive_file_map WHERE drive_file_id = ?').run(driveFileId);

  writeAuditLog({
    userId: actorUser.id,
    userEmail: actorUser.email,
    roleName: actorUser.role,
    action: 'DELETE_GOOGLE_DRIVE_FILE',
    entityType: 'integration',
    entityId: driveFileId,
    details: { file_name: row?.file_name || driveFileId, folder_id: row?.folder_id || null },
  });

  emitStatusUpdate();
  return { ok: true };
}

export function startGoogleDriveSyncLoop() {
  if (syncLoopTimer) return;
  syncLoopTimer = setInterval(() => {
    try {
      checkAndNotifyCloudDbMutation();
    } catch {
      // ignore mutation check errors
    }
    runGoogleDriveSyncCycle().catch(() => {
      // Errors are captured and surfaced cleanly in status
    });
  }, 1000);
}

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from './db.ts';
import { writeAuditLog, type AuthUser } from './auth.ts';
import { sendToSuperAdmins } from './realtime.ts';

export const DEFAULT_DRIVE_FOLDER_URL =
  'https://drive.google.com/drive/folders/18ub4PwnI3r9io--dCEULoQPW-vPW_ihT?usp=drive_link';
export const DEFAULT_DRIVE_FOLDER_ID = '18ub4PwnI3r9io--dCEULoQPW-vPW_ihT';

interface InMemoryDriveSession {
  accessToken: string;
  email?: string;
  displayName?: string;
  setAt: string;
}

// Keep Google OAuth access token strictly in server process memory (never stored on disk or browser storage)
let activeDriveSession: InMemoryDriveSession | null = null;
let syncLoopTimer: ReturnType<typeof setInterval> | null = null;
let syncInFlight = false;
let lastDbSnapshotSeq = -1;
let lastDbSnapshotAt = 0;

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

export async function verifyFolderAccess(accessToken: string, folderId: string): Promise<{ id: string; name: string }> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed&supportsAllDrives=true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new Error('Google OAuth token expired (401). Please sign in with Google again.');
    }
    throw new Error(`Unable to access target Google Drive folder (${res.status}): ${txt.slice(0, 200)}`);
  }
  const info = (await res.json()) as { id: string; name: string; mimeType: string; trashed?: boolean };
  if (info.trashed) {
    throw new Error('Target Google Drive folder is in Trash.');
  }
  if (info.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('Target Google Drive link does not point to a folder.');
  }
  return { id: info.id, name: info.name };
}

export async function registerGoogleDriveSession(params: {
  accessToken: string;
  actorUser: AuthUser;
  confirmSync?: boolean;
}): Promise<{ email?: string; displayName?: string }> {
  const profile = await validateGoogleAccessToken(params.accessToken);
  activeDriveSession = {
    accessToken: params.accessToken,
    email: profile.email || params.actorUser.email,
    displayName: profile.displayName,
    setAt: new Date().toISOString(),
  };

  if (params.confirmSync) {
    db.prepare(
      `UPDATE google_drive_sync_config
       SET connected_google_email = ?,
           sync_confirmed = 1,
           last_status = CASE WHEN sync_enabled = 1 THEN 'connected' ELSE 'paused' END,
           last_error = NULL,
           updated_by = ?,
           updated_at = datetime('now')
       WHERE id = 1`
    ).run(activeDriveSession.email || null, params.actorUser.id);
  } else {
    db.prepare(
      `UPDATE google_drive_sync_config
       SET connected_google_email = ?,
           last_status = CASE
             WHEN sync_confirmed = 1 AND sync_enabled = 1 THEN 'connected'
             WHEN sync_confirmed = 0 THEN 'awaiting_confirmation'
             ELSE 'paused'
           END,
           last_error = NULL,
           updated_by = ?,
           updated_at = datetime('now')
       WHERE id = 1`
    ).run(activeDriveSession.email || null, params.actorUser.id);
  }

  writeAuditLog({
    userId: params.actorUser.id,
    userEmail: params.actorUser.email,
    roleName: params.actorUser.role,
    action: 'GOOGLE_DRIVE_AUTHORIZED',
    entityType: 'integration',
    entityId: 'google_drive',
    details: { google_email: activeDriveSession.email || null, sync_confirmed: Boolean(params.confirmSync) },
  });

  emitStatusUpdate();
  return profile;
}

export function clearGoogleDriveSession(actorUser?: AuthUser | null) {
  activeDriveSession = null;
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

  if (activeDriveSession?.accessToken && nextFolderId !== current.drive_folder_id) {
    await verifyFolderAccess(activeDriveSession.accessToken, nextFolderId);
  }

  const folderChanged = nextFolderId !== current.drive_folder_id;
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

  return {
    config: {
      ...cfg,
      sync_enabled: Boolean(cfg.sync_enabled),
      sync_confirmed: Boolean(cfg.sync_confirmed),
    },
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
  const res = await fetch(url, {
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

  const res = await fetch(endpoint, {
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

  const latestSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) as m FROM drive_sync_changelog').get() as { m: number }).m;
  if (!options?.force && latestSeq <= (cfg.last_synced_seq || 0)) {
    return { synced: false, filesUpdated: 0, skippedReason: 'up_to_date' };
  }

  syncInFlight = true;
  const nowIso = new Date().toISOString();

  try {
    const accessToken = activeDriveSession.accessToken;
    const folderId = cfg.drive_folder_id;

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

    // Include a live SQLite binary snapshot when forcing or at most once every 15 seconds if DB changed
    const shouldSyncSqliteSnapshot =
      Boolean(options?.force) ||
      (latestSeq > lastDbSnapshotSeq && Date.now() - lastDbSnapshotAt >= 15_000);

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
        lastDbSnapshotAt = Date.now();
      } finally {
        try {
          if (fs.existsSync(tmpSnapPath)) fs.unlinkSync(tmpSnapPath);
        } catch {
          // ignore
        }
      }
    }

    let filesUpdated = 0;
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

      const driveFileId = await uploadOrUpdateDriveFile({
        accessToken,
        folderId,
        existingFileId: targetFileId,
        fileName: ds.fileName,
        mimeType: ds.mimeType,
        content: ds.content,
      });

      upsertMap.run(
        ds.entityKey,
        folderId,
        driveFileId,
        ds.fileName,
        ds.mimeType,
        sha256,
        ds.recordCount,
        ds.content.byteLength,
        nowIso
      );
      filesUpdated += 1;
    }

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

    emitStatusUpdate();
    return { synced: true, filesUpdated };
  } catch (err: any) {
    const isAuthErr = err?.statusCode === 401 || String(err?.message || '').includes('401');
    if (isAuthErr) {
      activeDriveSession = null;
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
    runGoogleDriveSyncCycle().catch(() => {
      // Errors are captured and surfaced cleanly in status
    });
  }, 1000);
}

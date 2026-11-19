import fs from 'fs';
import path from 'path';
import {
  BACKUP_ROOT,
  db,
  initializeDatabase,
  syncDepartmentDropdownOptions,
  syncLocationTypeDropdownOptions,
} from './db.ts';
import { writeAuditLog, type AuthUser } from './auth.ts';
import { broadcastAll, sendToSuperAdmins } from './realtime.ts';
import { getDriveConfigRow, isLocalDatabaseFresh, markLocalDatabaseCloudSynced } from './googleDriveSync.ts';
import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };

export const CLOUD_PRIMARY_TABLES = [
  'locations',
  'departments',
  'users',
  'employees',
  'moderators',
  'tickets',
  'it_assets',
  'it_budgets',
  'expenses',
  'vendors',
  'direct_messages',
  'broadcast_notifications',
  'dropdown_options',
  'sla_configurations',
  'saved_reports',
] as const;

export const CLOUD_AUX_TABLES = [
  'roles',
  'ticket_assignments',
  'ticket_activities',
  'ticket_comments',
  'ticket_time_logs',
  'asset_history',
  'asset_maintenance',
  'expense_approvals',
  'admin_permissions',
  'user_mfa',
  'retention_policies',
  'integration_settings',
  'google_drive_sync_config',
  'notifications',
  'broadcast_notification_deliveries',
  'email_communications',
  'whatsapp_communications',
  'audit_logs',
] as const;

let lastNotifiedCloudSeq = -1;

function queryTableRows(tableName: string, limit?: number): any[] {
  try {
    if (tableName === 'audit_logs' && limit) {
      return db.prepare(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?`).all(limit) as any[];
    }
    return db.prepare(`SELECT * FROM ${tableName}`).all() as any[];
  } catch {
    return [];
  }
}

export function getLatestChangelogSeq(): number {
  try {
    const row = db.prepare('SELECT COALESCE(MAX(seq), 0) as m FROM drive_sync_changelog').get() as { m: number } | undefined;
    return Number(row?.m || 0);
  } catch {
    return 0;
  }
}

export function checkAndNotifyCloudDbMutation() {
  const latestSeq = getLatestChangelogSeq();
  if (lastNotifiedCloudSeq === -1) {
    lastNotifiedCloudSeq = latestSeq;
    return;
  }
  if (latestSeq > lastNotifiedCloudSeq) {
    lastNotifiedCloudSeq = latestSeq;
    sendToSuperAdmins('cloud_db:mutated', {
      seq: latestSeq,
      timestamp: new Date().toISOString(),
    });
  }
}

export function exportDatabaseSnapshotForCloud() {
  const latestSeq = getLatestChangelogSeq();
  const driveCfg = getDriveConfigRow();
  const isFreshLocal = isLocalDatabaseFresh();

  const tables: Record<string, any[]> = {};
  const recordCounts: Record<string, number> = {};
  let totalRecords = 0;

  for (const t of CLOUD_PRIMARY_TABLES) {
    const rows = queryTableRows(t);
    tables[t] = rows;
    recordCounts[t] = rows.length;
    totalRecords += rows.length;
  }

  for (const t of CLOUD_AUX_TABLES) {
    const rows = t === 'audit_logs' ? queryTableRows(t, 400) : queryTableRows(t);
    tables[t] = rows;
    recordCounts[t] = rows.length;
    totalRecords += rows.length;
  }

  return {
    latestSeq,
    isFreshLocal,
    totalRecords,
    recordCounts,
    driveFolderUrl: driveCfg.drive_folder_url,
    driveFolderId: driveCfg.drive_folder_id,
    tables,
    exportedAt: new Date().toISOString(),
  };
}

export async function verifyFirebaseIdTokenViaIdentityToolkit(idToken: string): Promise<{
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName?: string;
}> {
  const apiKey = firebaseConfig?.apiKey;
  if (!apiKey) {
    throw new Error('Firebase API key is not configured.');
  }
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );
  if (!res.ok) {
    throw new Error('Invalid or expired Firebase authentication token.');
  }
  const data = (await res.json()) as {
    users?: Array<{
      localId?: string;
      email?: string;
      emailVerified?: boolean;
      displayName?: string;
    }>;
  };
  const fbUser = data.users?.[0];
  if (!fbUser?.localId || !fbUser?.email || !fbUser.emailVerified) {
    throw new Error('Verified Google account is required to restore the cloud database.');
  }
  return {
    uid: fbUser.localId,
    email: fbUser.email,
    emailVerified: Boolean(fbUser.emailVerified),
    displayName: fbUser.displayName,
  };
}

export interface HydrateCloudPayload {
  tables: Record<string, any[]>;
  meta?: {
    lastSeq?: number;
    totalRecords?: number;
  };
}

function getTableColumnNames(tableName: string): string[] {
  try {
    const cols = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name: string }>;
    return cols.map((c) => c.name);
  } catch {
    return [];
  }
}

export async function hydrateDatabaseFromCloudSnapshot(
  payload: HydrateCloudPayload,
  actor: { userId?: number | null; userEmail: string; roleName: string; source: 'super_admin' | 'firebase_boot' }
): Promise<{ ok: true; restoredCount: number; preRestoreFilename: string }> {
  const incomingTables = payload?.tables;
  if (!incomingTables || typeof incomingTables !== 'object') {
    throw new Error('Invalid Cloud Firestore snapshot payload.');
  }

  const hasLocations = Array.isArray(incomingTables.locations) && incomingTables.locations.length > 0;
  const hasUsers = Array.isArray(incomingTables.users) && incomingTables.users.length > 0;
  if (!hasLocations && !hasUsers) {
    throw new Error('Cloud Firestore snapshot has no core location or user records to restore.');
  }

  // Capture local safety backup before replacing runtime SQLite state
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const preRestoreFilename = `sdglobal-crm-pre_cloud_restore-${stamp}.db`;
  const preRestorePath = path.join(BACKUP_ROOT, preRestoreFilename);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // ignore
  }
  await db.backup(preRestorePath);

  const orderedRestoreTables = [
    'roles',
    'departments',
    'locations',
    'users',
    'employees',
    'moderators',
    'sla_configurations',
    'vendors',
    'it_assets',
    'tickets',
    'ticket_assignments',
    'ticket_activities',
    'ticket_comments',
    'ticket_time_logs',
    'asset_history',
    'asset_maintenance',
    'it_budgets',
    'expenses',
    'expense_approvals',
    'notifications',
    'email_communications',
    'whatsapp_communications',
    'direct_messages',
    'dropdown_options',
    'broadcast_notifications',
    'broadcast_notification_deliveries',
    'admin_permissions',
    'user_mfa',
    'saved_reports',
    'retention_policies',
    'integration_settings',
    'google_drive_sync_config',
    'audit_logs',
  ];

  // Temporarily turn off foreign keys & immutability triggers so historical audit/ticket/chat rows restore losslessly
  const triggerRows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all() as Array<{ name: string }>;

  let restoredCount = 0;

  db.pragma('foreign_keys = OFF');
  try {
    const runRestore = db.transaction(() => {
      for (const trg of triggerRows) {
        db.exec(`DROP TRIGGER IF EXISTS "${trg.name}"`);
      }

      for (const tableName of orderedRestoreTables) {
        const rows = incomingTables[tableName];
        if (!Array.isArray(rows) || rows.length === 0) {
          continue;
        }
        const validCols = new Set(getTableColumnNames(tableName));
        if (validCols.size === 0) continue;

        db.exec(`DELETE FROM "${tableName}"`);

        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;
          const cols = Object.keys(row).filter((k) => validCols.has(k));
          if (cols.length === 0) continue;

          const colSql = cols.map((c) => `"${c}"`).join(', ');
          const placeholders = cols.map(() => '?').join(', ');
          const values = cols.map((c) => {
            const v = row[c];
            if (v === undefined) return null;
            if (typeof v === 'boolean') return v ? 1 : 0;
            if (v !== null && typeof v === 'object') return JSON.stringify(v);
            return v;
          });
          db.prepare(`INSERT OR REPLACE INTO "${tableName}" (${colSql}) VALUES (${placeholders})`).run(...values);
          restoredCount += 1;
        }
      }

      // Reset drive_sync_changelog cleanly so server doesn't re-upload unchanged rows as brand-new changes
      db.exec('DELETE FROM drive_sync_changelog');
    });

    runRestore();
  } finally {
    db.pragma('foreign_keys = ON');
    initializeDatabase();
    syncDepartmentDropdownOptions();
    syncLocationTypeDropdownOptions();
  }

  lastNotifiedCloudSeq = getLatestChangelogSeq();
  markLocalDatabaseCloudSynced('firestore_restore', lastNotifiedCloudSeq);

  const validActorRow =
    actor.userId != null
      ? (db.prepare('SELECT id FROM users WHERE id = ?').get(actor.userId) as { id: number } | undefined)
      : undefined;

  writeAuditLog({
    userId: validActorRow?.id ?? null,
    userEmail: actor.userEmail,
    roleName: actor.roleName,
    action: 'HYDRATE_FROM_CLOUD_FIRESTORE',
    entityType: 'database',
    entityId: 'cloud_firestore',
    details: {
      restored_records: restoredCount,
      source: actor.source,
      pre_restore_filename: preRestoreFilename,
    },
  });

  broadcastAll('system:restored', {
    source: 'cloud_firestore',
    restored_records: restoredCount,
    restored_at: new Date().toISOString(),
  });

  return { ok: true, restoredCount, preRestoreFilename };
}

export function getCloudBootstrapState() {
  return {
    isFreshLocal: isLocalDatabaseFresh(),
    latestSeq: getLatestChangelogSeq(),
    driveFolderUrl: getDriveConfigRow().drive_folder_url,
    driveFolderId: getDriveConfigRow().drive_folder_id,
    projectId: firebaseConfig.projectId,
    firestoreDatabaseId: firebaseConfig.firestoreDatabaseId || '(default)',
  };
}

import {
  collection,
  doc,
  getDocFromServer,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type Query,
  type DocumentData,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { auth, db, handleFirestoreError, OperationType, testConnection } from './firebase.ts';
import { apiFetch } from '../utils/api.ts';

export interface CloudDbStatus {
  connected: boolean;
  email: string | null;
  uid: string | null;
  syncing: boolean;
  restoring: boolean;
  lastSyncedAt: string | null;
  lastSeq: number;
  totalRecords: number;
  lastError: string | null;
  cloudSnapshotDetected: boolean;
  cloudTotalRecords: number;
  cloudUpdatedAt: string | null;
  projectId: string | null;
  databaseId: string | null;
}

interface CloudExportResponse {
  latestSeq: number;
  isFreshLocal: boolean;
  totalRecords: number;
  recordCounts: Record<string, number>;
  driveFolderUrl: string;
  driveFolderId: string;
  tables: Record<string, any[]>;
  exportedAt: string;
}

interface CloudBootstrapStatusResponse {
  isFreshLocal: boolean;
  latestSeq: number;
  driveFolderUrl: string;
  driveFolderId: string;
  projectId: string;
  firestoreDatabaseId: string;
}

const BOOTSTRAPPED_ADMIN_EMAIL = 'a88593347@gmail.com';

const COLLECTIONS_TO_HYDRATE = [
  'locations',
  'departments',
  'crm_users',
  'employees',
  'moderators',
  'tickets',
  'assets',
  'budgets',
  'expenses',
  'vendors',
  'direct_messages',
  'broadcast_notifications',
  'dropdown_options',
  'sla_configurations',
  'saved_reports',
  'crm_records',
] as const;

let currentStatus: CloudDbStatus = {
  connected: false,
  email: null,
  uid: null,
  syncing: false,
  restoring: false,
  lastSyncedAt: null,
  lastSeq: 0,
  totalRecords: 0,
  lastError: null,
  cloudSnapshotDetected: false,
  cloudTotalRecords: 0,
  cloudUpdatedAt: null,
  projectId: null,
  databaseId: null,
};

const statusListeners = new Set<(status: CloudDbStatus) => void>();

function updateStatus(patch: Partial<CloudDbStatus>) {
  currentStatus = { ...currentStatus, ...patch };
  statusListeners.forEach((cb) => {
    try {
      cb(currentStatus);
    } catch {
      // ignore listener errors
    }
  });
}

export function getCloudDbStatus(): CloudDbStatus {
  return currentStatus;
}

export function subscribeCloudDbStatus(cb: (status: CloudDbStatus) => void): () => void {
  statusListeners.add(cb);
  cb(currentStatus);
  return () => {
    statusListeners.delete(cb);
  };
}

// Cache of docPath -> { hash, createdAt, ownerUid } so 1-second incremental syncs only write modified rows
const remoteDocCache = new Map<string, { hash: string; createdAt: unknown; ownerUid: string }>();
let remoteCachePrimedForUid: string | null = null;
let syncInFlightPromise: Promise<{ synced: boolean; written: number; deleted: number }> | null = null;
let hydrateInFlightPromise: Promise<{ restored: boolean; restoredCount: number }> | null = null;

export function resetCloudSyncCache() {
  remoteDocCache.clear();
  remoteCachePrimedForUid = null;
}

const TRANSIENT_FIRESTORE_CODES = new Set([
  'unavailable',
  'deadline-exceeded',
  'resource-exhausted',
  'aborted',
]);

async function withFirestoreRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= maxRetries) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const code = String(err?.code || '').toLowerCase();
      const msg = String(err?.message || '').toLowerCase();
      const isTransient =
        TRANSIENT_FIRESTORE_CODES.has(code) ||
        msg.includes('network') ||
        msg.includes('failed to fetch') ||
        msg.includes('client is offline');
      if (!isTransient || attempt === maxRetries) {
        throw err;
      }
      const delayMs = 350 * Math.pow(2, attempt) + Math.floor(Math.random() * 150);
      await new Promise((r) => setTimeout(r, delayMs));
    }
    attempt += 1;
  }
  throw lastErr;
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (auth.currentUser) {
      syncCrmToCloudFirestore().catch(() => {});
    }
  });
}

function clampStr(v: unknown, maxLen: number, fallback = ''): string {
  if (v === null || v === undefined) return fallback;
  const s = String(v);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function numVal(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeId(v: unknown, fallback = '0'): string {
  const cleaned = String(v ?? fallback).replace(/[^a-zA-Z0-9_\-]/g, '_');
  if (!cleaned) return fallback;
  return cleaned.slice(0, 120);
}

function parseJsonSafe<T = any>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'object') return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

function sanitizeForFirestore(value: unknown, depth = 0): any {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'number') {
    return typeof value === 'number' && !Number.isFinite(value) ? 0 : value;
  }
  if (typeof value === 'string') {
    return value.length > 12000 ? value.slice(0, 12000) : value;
  }
  if (depth >= 5) {
    return clampStr(JSON.stringify(value), 2000, '');
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeForFirestore(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
      if (val === undefined) continue;
      out[k] = sanitizeForFirestore(val, depth + 1);
    }
    return out;
  }
  return String(value);
}

function normalizePriority(p: unknown): 'Critical' | 'High' | 'Medium' | 'Low' {
  const s = String(p || '');
  if (s === 'Critical' || s === 'High' || s === 'Medium' || s === 'Low') return s;
  return 'Medium';
}

function normalizeUserStatus(s: unknown): 'Active' | 'Inactive' {
  return String(s || '') === 'Inactive' ? 'Inactive' : 'Active';
}

function normalizeApprovalStatus(s: unknown): 'Pending' | 'Approved' | 'Rejected' {
  const v = String(s || '');
  if (v === 'Approved' || v === 'Rejected' || v === 'Pending') return v;
  return 'Pending';
}

function stableHash(obj: Record<string, any>): string {
  const copy = { ...obj };
  delete copy.createdAt;
  delete copy.updatedAt;
  delete copy.ownerUid;
  return JSON.stringify(copy);
}

function buildCollectionReadQuery(colName: string, firebaseUser: User): Query<DocumentData> {
  const colRef = collection(db, colName);
  if ((firebaseUser.email || '').toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL) {
    return colRef;
  }
  return query(colRef, where('ownerUid', '==', firebaseUser.uid));
}

function formatFirestoreTimestampIso(ts: any): string | null {
  if (!ts) return null;
  if (typeof ts?.toDate === 'function') {
    return ts.toDate().toISOString();
  }
  if (typeof ts?.seconds === 'number') {
    return new Date(ts.seconds * 1000).toISOString();
  }
  if (typeof ts === 'string') return ts;
  return null;
}

export async function ensureAdminRegistryDoc(firebaseUser: User): Promise<void> {
  const uid = sanitizeId(firebaseUser.uid);
  const adminRef = doc(db, 'admins', uid);
  const path = `admins/${uid}`;
  try {
    const existingSnap = await withFirestoreRetry(() => getDocFromServer(adminRef));
    const nextEmail = clampStr(firebaseUser.email, 200, '');
    const nextDisplayName = clampStr(firebaseUser.displayName || firebaseUser.email || 'Super Admin', 200);
    if (!existingSnap.exists()) {
      await setDoc(adminRef, {
        uid,
        email: nextEmail,
        displayName: nextDisplayName,
        role: 'admin',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const data = existingSnap.data();
      if (data.email !== nextEmail || data.displayName !== nextDisplayName) {
        await setDoc(adminRef, {
          uid: data.uid,
          email: nextEmail,
          displayName: nextDisplayName,
          role: 'admin',
          createdAt: data.createdAt,
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function inspectCloudMetaDoc(): Promise<{
  exists: boolean;
  lastSeq: number;
  totalRecords: number;
  updatedAtIso: string | null;
}> {
  const metaRef = doc(db, 'crm_meta', 'primary');
  try {
    const snap = await withFirestoreRetry(() => getDocFromServer(metaRef));
    if (!snap.exists()) {
      return { exists: false, lastSeq: 0, totalRecords: 0, updatedAtIso: null };
    }
    const data = snap.data();
    return {
      exists: true,
      lastSeq: numVal(data.lastSeq, 0),
      totalRecords: numVal(data.totalRecords, 0),
      updatedAtIso: formatFirestoreTimestampIso(data.updatedAt),
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, 'crm_meta/primary');
  }
}

interface MappedCloudDoc {
  col: string;
  id: string;
  data: Record<string, any>;
}

function buildMappedDocuments(snapshot: CloudExportResponse, uid: string): MappedCloudDoc[] {
  const docs: MappedCloudDoc[] = [];
  const t = snapshot.tables || {};

  // 1. locations
  for (const row of t.locations || []) {
    const id = `loc_${sanitizeId(row.id)}`;
    docs.push({
      col: 'locations',
      id,
      data: {
        idNum: numVal(row.id),
        code: clampStr(row.code, 64),
        name: clampStr(row.name, 200),
        type: clampStr(row.type || 'Warehouse', 100),
        city: clampStr(row.city, 120),
        state: clampStr(row.state, 120),
        address: clampStr(row.address, 500),
        managerName: clampStr(row.manager_name, 200),
        recordCreatedAt: clampStr(row.created_at, 64),
        ownerUid: uid,
      },
    });
  }

  // 2. departments
  for (const row of t.departments || []) {
    const id = `dept_${sanitizeId(row.id)}`;
    docs.push({
      col: 'departments',
      id,
      data: {
        idNum: numVal(row.id),
        name: clampStr(row.name, 200),
        code: clampStr(row.code, 64),
        costCenter: clampStr(row.cost_center, 120),
        ownerUid: uid,
      },
    });
  }

  // 3. crm_users
  for (const row of t.users || []) {
    const id = `user_${sanitizeId(row.id)}`;
    docs.push({
      col: 'crm_users',
      id,
      data: {
        idNum: numVal(row.id),
        roleId: numVal(row.role_id, 1),
        email: clampStr(row.email, 200),
        passwordHash: clampStr(row.password_hash, 256),
        fullName: clampStr(row.full_name, 200),
        status: normalizeUserStatus(row.status),
        mustResetPassword: numVal(row.must_reset_password, 0),
        mobile: clampStr(row.mobile, 40),
        lastLoginAt: clampStr(row.last_login_at, 64),
        lastLoginIp: clampStr(row.last_login_ip, 100),
        recordCreatedAt: clampStr(row.created_at, 64),
        ownerUid: uid,
      },
    });
  }

  // 4. employees
  for (const row of t.employees || []) {
    const id = `emp_${sanitizeId(row.id)}`;
    docs.push({
      col: 'employees',
      id,
      data: {
        idNum: numVal(row.id),
        userId: numVal(row.user_id, 0),
        employeeCode: clampStr(row.employee_code, 64),
        fullName: clampStr(row.full_name, 200),
        departmentId: numVal(row.department_id, 0),
        designation: clampStr(row.designation, 200),
        mobile: clampStr(row.mobile, 40),
        email: clampStr(row.email, 200),
        locationId: numVal(row.location_id, 0),
        reportingManager: clampStr(row.reporting_manager, 200),
        loginCount: numVal(row.login_count, 0),
        lastLoginAt: clampStr(row.last_login_at, 64),
        lastLoginIp: clampStr(row.last_login_ip, 100),
        recordCreatedAt: clampStr(row.created_at, 64),
        ownerUid: uid,
      },
    });
  }

  // 5. moderators
  for (const row of t.moderators || []) {
    const id = `mod_${sanitizeId(row.id)}`;
    const parsedLocIds = parseJsonSafe<unknown[]>(row.assigned_location_ids, []);
    const assignedLocationIds = Array.isArray(parsedLocIds)
      ? parsedLocIds.map((x) => Number(x)).filter((n) => Number.isFinite(n)).slice(0, 100)
      : [];
    docs.push({
      col: 'moderators',
      id,
      data: {
        idNum: numVal(row.id),
        userId: numVal(row.user_id, 0),
        employeeCode: clampStr(row.employee_code, 64),
        fullName: clampStr(row.full_name, 200),
        email: clampStr(row.email, 200),
        phone: clampStr(row.phone, 40),
        specialization: clampStr(row.specialization, 200),
        assignedLocationIds,
        dateOfJoining: clampStr(row.date_of_joining, 64),
        status: normalizeUserStatus(row.status),
        performanceRating: numVal(row.performance_rating, 4.5),
        maxCapacity: numVal(row.max_capacity, 10),
        recordCreatedAt: clampStr(row.created_at, 64),
        ownerUid: uid,
      },
    });
  }

  // 6. tickets
  for (const row of t.tickets || []) {
    const id = `ticket_${sanitizeId(row.id)}`;
    docs.push({
      col: 'tickets',
      id,
      data: {
        idNum: numVal(row.id),
        ticketNumber: clampStr(row.ticket_number, 64),
        status: clampStr(row.status || 'New', 64),
        priority: normalizePriority(row.priority),
        locationId: numVal(row.location_id, 0),
        departmentId: numVal(row.department_id, 0),
        category: clampStr(row.category, 120),
        deviceName: clampStr(row.device_name, 200),
        description: clampStr(row.description, 5000),
        payload: sanitizeForFirestore(row),
        ownerUid: uid,
      },
    });
  }

  // 7. assets
  for (const row of t.it_assets || []) {
    const id = `asset_${sanitizeId(row.id)}`;
    docs.push({
      col: 'assets',
      id,
      data: {
        idNum: numVal(row.id),
        assetTag: clampStr(row.asset_tag, 120),
        serialNumber: clampStr(row.serial_number, 120),
        category: clampStr(row.category, 120),
        brand: clampStr(row.brand, 120),
        model: clampStr(row.model, 120),
        conditionStatus: clampStr(row.condition_status || 'Operational', 64),
        payload: sanitizeForFirestore(row),
        ownerUid: uid,
      },
    });
  }

  // 8. budgets
  for (const row of t.it_budgets || []) {
    const id = `budget_${sanitizeId(row.id)}`;
    docs.push({
      col: 'budgets',
      id,
      data: {
        idNum: numVal(row.id),
        fiscalYear: numVal(row.fiscal_year, 2026),
        month: numVal(row.month, 0),
        locationId: numVal(row.location_id, 0),
        category: clampStr(row.category || 'General IT', 120),
        allocatedAmount: numVal(row.allocated_amount, 0),
        notes: clampStr(row.notes, 1000),
        createdByUserId: numVal(row.created_by_user_id, 0),
        recordCreatedAt: clampStr(row.created_at, 64),
        ownerUid: uid,
      },
    });
  }

  // 9. expenses
  for (const row of t.expenses || []) {
    const id = `expense_${sanitizeId(row.id)}`;
    docs.push({
      col: 'expenses',
      id,
      data: {
        idNum: numVal(row.id),
        category: clampStr(row.category, 120),
        vendorName: clampStr(row.vendor_name, 200),
        amount: numVal(row.amount, 0),
        invoiceNumber: clampStr(row.invoice_number, 120),
        approvalStatus: normalizeApprovalStatus(row.approval_status),
        payload: sanitizeForFirestore(row),
        ownerUid: uid,
      },
    });
  }

  // 10. vendors
  for (const row of t.vendors || []) {
    const id = `vendor_${sanitizeId(row.id)}`;
    docs.push({
      col: 'vendors',
      id,
      data: {
        idNum: numVal(row.id),
        name: clampStr(row.name, 200),
        category: clampStr(row.category, 120),
        contactPerson: clampStr(row.contact_person, 200),
        phone: clampStr(row.phone, 40),
        email: clampStr(row.email, 200),
        taxId: clampStr(row.tax_id, 100),
        address: clampStr(row.address, 500),
        recordCreatedAt: clampStr(row.created_at, 64),
        ownerUid: uid,
      },
    });
  }

  // 11. direct_messages
  for (const row of t.direct_messages || []) {
    const id = `dm_${sanitizeId(row.id)}`;
    docs.push({
      col: 'direct_messages',
      id,
      data: {
        idNum: numVal(row.id),
        senderUserId: numVal(row.sender_user_id, 0),
        recipientUserId: numVal(row.recipient_user_id, 0),
        ticketId: numVal(row.ticket_id, 0),
        message: clampStr(row.message, 5000),
        isRead: numVal(row.is_read, 0),
        readAt: clampStr(row.read_at, 64),
        conversationScope: clampStr(row.conversation_scope || 'direct', 64),
        isFlaggedPrivate: numVal(row.is_flagged_private, 0),
        isArchived: numVal(row.is_archived, 0),
        archivedAt: clampStr(row.archived_at, 64),
        archivedByUserId: numVal(row.archived_by_user_id, 0),
        recordCreatedAt: clampStr(row.created_at, 64),
        ownerUid: uid,
      },
    });
  }

  // 12. broadcast_notifications
  for (const row of t.broadcast_notifications || []) {
    const id = `bc_${sanitizeId(row.id)}`;
    docs.push({
      col: 'broadcast_notifications',
      id,
      data: {
        idNum: numVal(row.id),
        title: clampStr(row.title, 300),
        message: clampStr(row.message, 5000),
        category: clampStr(row.category || 'Announcement', 64),
        displayMode: clampStr(row.display_mode || 'tab_only', 64),
        targetAudience: clampStr(row.target_audience || 'everyone', 64),
        payload: sanitizeForFirestore(row),
        ownerUid: uid,
      },
    });
  }

  // 13. dropdown_options (Warehouses, Branches & Operational Hubs, departments, etc.)
  for (const row of t.dropdown_options || []) {
    const id = `dd_${sanitizeId(row.id)}`;
    docs.push({
      col: 'dropdown_options',
      id,
      data: {
        idNum: numVal(row.id),
        groupKey: clampStr(row.group_key, 100),
        label: clampStr(row.label, 200),
        value: clampStr(row.value, 200),
        sortOrder: numVal(row.sort_order, 0),
        isActive: numVal(row.is_active, 1),
        isSystem: numVal(row.is_system, 0),
        meta: sanitizeForFirestore({
          parsed: parseJsonSafe(row.meta_json, {}),
          _row: row,
        }),
        ownerUid: uid,
      },
    });
  }

  // 14. sla_configurations
  for (const row of t.sla_configurations || []) {
    const id = `sla_${sanitizeId(row.id)}`;
    const parsedHolidays = parseJsonSafe<unknown[]>(row.holidays_json, []);
    const holidays = Array.isArray(parsedHolidays)
      ? parsedHolidays.map((h) => clampStr(h, 32)).filter(Boolean).slice(0, 100)
      : [];
    docs.push({
      col: 'sla_configurations',
      id,
      data: {
        idNum: numVal(row.id),
        priority: normalizePriority(row.priority),
        firstResponseMinutes: numVal(row.first_response_minutes, 60),
        resolutionHours: numVal(row.resolution_hours, 24),
        workingHoursStart: clampStr(row.working_hours_start || '08:00', 16),
        workingHoursEnd: clampStr(row.working_hours_end || '20:00', 16),
        holidays,
        autoEscalate: numVal(row.auto_escalate, 1),
        escalateToEmail: clampStr(row.escalate_to_email, 200),
        ownerUid: uid,
      },
    });
  }

  // 15. saved_reports
  for (const row of t.saved_reports || []) {
    const id = `rep_${sanitizeId(row.id)}`;
    const parsedRows = parseJsonSafe<any[]>(row.rows_json, []);
    const compactPayload = sanitizeForFirestore({
      ...row,
      rows_json: undefined,
      rows: Array.isArray(parsedRows) ? parsedRows.slice(0, 120) : [],
    });
    docs.push({
      col: 'saved_reports',
      id,
      data: {
        idNum: numVal(row.id),
        reportType: clampStr(row.report_type, 120),
        title: clampStr(row.title, 300),
        rowCount: numVal(row.row_count, 0),
        createdByName: clampStr(row.created_by_name, 200),
        createdByRole: clampStr(row.created_by_role, 64),
        payload: compactPayload,
        ownerUid: uid,
      },
    });
  }

  // 16. auxiliary tables -> crm_records
  const auxTableNames = [
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
  ];

  for (const tableName of auxTableNames) {
    const rows = t[tableName] || [];
    rows.forEach((row, idx) => {
      const rawKey =
        row.id ?? row.setting_key ?? row.entity_key ?? row.user_id ?? `${idx}`;
      const sourceKey = sanitizeId(rawKey, String(idx));
      const docId = sanitizeId(`${tableName}__${sourceKey}`);
      docs.push({
        col: 'crm_records',
        id: docId,
        data: {
          tableName,
          sourceKey,
          dataMap: sanitizeForFirestore(row),
          ownerUid: uid,
        },
      });
    });
  }

  return docs;
}

async function primeRemoteCache(firebaseUser: User): Promise<void> {
  if (remoteCachePrimedForUid === firebaseUser.uid) return;
  remoteDocCache.clear();

  for (const colName of [...COLLECTIONS_TO_HYDRATE, 'crm_meta']) {
    try {
      const snap = await withFirestoreRetry(() => getDocs(buildCollectionReadQuery(colName, firebaseUser)));
      snap.forEach((d) => {
        const data = d.data();
        const path = `${colName}/${d.id}`;
        remoteDocCache.set(path, {
          hash: stableHash(data),
          createdAt: data.createdAt,
          ownerUid: String(data.ownerUid || firebaseUser.uid),
        });
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, colName);
    }
  }
  remoteCachePrimedForUid = firebaseUser.uid;
}

export async function syncCrmToCloudFirestore(options?: {
  force?: boolean;
}): Promise<{ synced: boolean; written: number; deleted: number }> {
  const firebaseUser = auth.currentUser;
  if (!firebaseUser) {
    return { synced: false, written: 0, deleted: 0 };
  }
  if (syncInFlightPromise) {
    return syncInFlightPromise;
  }

  syncInFlightPromise = (async () => {
    updateStatus({ syncing: true, lastError: null });
    try {
      await testConnection();
      await ensureAdminRegistryDoc(firebaseUser);

      const bootstrap = await apiFetch<CloudBootstrapStatusResponse>('/api/cloud-db/bootstrap-status');
      updateStatus({
        projectId: bootstrap.projectId,
        databaseId: bootstrap.firestoreDatabaseId,
      });

      // Safety guard: never overwrite an existing Cloud Firestore database with fresh container seed data!
      if (bootstrap.isFreshLocal) {
        const meta = await inspectCloudMetaDoc();
        if (meta.exists && meta.totalRecords > 0) {
          updateStatus({
            cloudSnapshotDetected: true,
            cloudTotalRecords: meta.totalRecords,
            cloudUpdatedAt: meta.updatedAtIso,
          });
          await hydrateServerFromCloudFirestore('auto');
          return { synced: false, written: 0, deleted: 0 };
        }
      }

      if (options?.force) {
        resetCloudSyncCache();
      }
      await primeRemoteCache(firebaseUser);

      const snapshot = await apiFetch<CloudExportResponse>('/api/cloud-db/export');
      const mappedDocs = buildMappedDocuments(snapshot, firebaseUser.uid);

      const activePaths = new Set<string>();
      const ops: Array<
        | { type: 'set'; path: string; col: string; id: string; data: Record<string, any> }
        | { type: 'delete'; path: string; col: string; id: string }
      > = [];

      for (const item of mappedDocs) {
        const path = `${item.col}/${item.id}`;
        activePaths.add(path);
        const nextHash = stableHash(item.data);
        const cached = remoteDocCache.get(path);

        if (!cached) {
          ops.push({
            type: 'set',
            path,
            col: item.col,
            id: item.id,
            data: {
              ...item.data,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
          });
        } else if (options?.force || cached.hash !== nextHash) {
          ops.push({
            type: 'set',
            path,
            col: item.col,
            id: item.id,
            data: {
              ...item.data,
              ownerUid: cached.ownerUid,
              createdAt: cached.createdAt ?? serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
          });
        }
      }

      // Propagate deletions to Cloud Firestore (except rolling audit_logs window)
      for (const cachedPath of remoteDocCache.keys()) {
        if (cachedPath.startsWith('crm_meta/')) continue;
        if (cachedPath.startsWith('crm_records/audit_logs__')) continue;
        if (!activePaths.has(cachedPath)) {
          const slashIdx = cachedPath.indexOf('/');
          if (slashIdx > 0) {
            ops.push({
              type: 'delete',
              path: cachedPath,
              col: cachedPath.slice(0, slashIdx),
              id: cachedPath.slice(slashIdx + 1),
            });
          }
        }
      }

      // Always write/update crm_meta/primary checkpoint when there are ops or meta doesn't exist yet
      const metaPath = 'crm_meta/primary';
      const cachedMeta = remoteDocCache.get(metaPath);
      const metaPayload = {
        metaKey: 'primary',
        lastSeq: numVal(snapshot.latestSeq, 0),
        totalRecords: numVal(snapshot.totalRecords, 0),
        driveFolderUrl: clampStr(snapshot.driveFolderUrl, 500),
        driveFolderId: sanitizeId(snapshot.driveFolderId, '18ub4PwnI3r9io--dCEULoQPW-vPW_ihT'),
        recordCounts: sanitizeForFirestore(snapshot.recordCounts || {}),
        ownerUid: cachedMeta?.ownerUid || firebaseUser.uid,
      };
      const metaHash = stableHash(metaPayload);
      if (ops.length > 0 || !cachedMeta || cachedMeta.hash !== metaHash || options?.force) {
        ops.push({
          type: 'set',
          path: metaPath,
          col: 'crm_meta',
          id: 'primary',
          data: {
            ...metaPayload,
            createdAt: cachedMeta?.createdAt ?? serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
      }

      let written = 0;
      let deleted = 0;
      const CHUNK_SIZE = 350;
      const newlyCreatedPaths: string[] = [];

      for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
        const chunk = ops.slice(i, i + CHUNK_SIZE);
        const batch = writeBatch(db);
        for (const op of chunk) {
          const ref = doc(db, op.col, op.id);
          if (op.type === 'set') {
            if (!remoteDocCache.has(op.path)) {
              newlyCreatedPaths.push(op.path);
            }
            batch.set(ref, op.data);
            written += 1;
          } else {
            batch.delete(ref);
            deleted += 1;
          }
        }
        try {
          await withFirestoreRetry(() => batch.commit());
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, chunk[0]?.path || 'batch');
        }

        for (const op of chunk) {
          if (op.type === 'set') {
            const prev = remoteDocCache.get(op.path);
            if (prev?.createdAt) {
              remoteDocCache.set(op.path, {
                hash: stableHash(op.data),
                createdAt: prev.createdAt,
                ownerUid: String(op.data.ownerUid || firebaseUser.uid),
              });
            }
          } else {
            remoteDocCache.delete(op.path);
          }
        }
      }

      // Fetch exact server-assigned createdAt Timestamp for newly created docs so subsequent updates never mismatch
      if (newlyCreatedPaths.length > 25) {
        remoteCachePrimedForUid = null;
        await primeRemoteCache(firebaseUser);
      } else if (newlyCreatedPaths.length > 0) {
        await Promise.all(
          newlyCreatedPaths.map(async (p) => {
            const slashIdx = p.indexOf('/');
            if (slashIdx <= 0) return;
            const col = p.slice(0, slashIdx);
            const id = p.slice(slashIdx + 1);
            try {
              const snap = await getDocFromServer(doc(db, col, id));
              if (snap.exists()) {
                const d = snap.data();
                remoteDocCache.set(p, {
                  hash: stableHash(d),
                  createdAt: d.createdAt,
                  ownerUid: String(d.ownerUid || firebaseUser.uid),
                });
              }
            } catch {
              remoteCachePrimedForUid = null;
            }
          })
        );
      }

      const nowIso = new Date().toISOString();
      apiFetch('/api/cloud-db/mark-synced', {
        method: 'POST',
        body: JSON.stringify({ lastSeq: snapshot.latestSeq }),
      }).catch(() => {});

      updateStatus({
        connected: true,
        email: firebaseUser.email || null,
        uid: firebaseUser.uid,
        lastSyncedAt: nowIso,
        lastSeq: snapshot.latestSeq,
        totalRecords: snapshot.totalRecords,
        cloudSnapshotDetected: true,
        cloudTotalRecords: snapshot.totalRecords,
        cloudUpdatedAt: nowIso,
        lastError: null,
      });

      return { synced: true, written, deleted };
    } catch (err: any) {
      const msg = err?.message || 'Cloud Firestore sync failed';
      updateStatus({ lastError: msg });
      throw err;
    } finally {
      updateStatus({ syncing: false });
      syncInFlightPromise = null;
    }
  })();

  return syncInFlightPromise;
}

export async function readAllCloudFirestoreTables(firebaseUser: User): Promise<{
  tables: Record<string, any[]>;
  meta: { lastSeq: number; totalRecords: number };
}> {
  const tables: Record<string, any[]> = {
    locations: [],
    departments: [],
    users: [],
    employees: [],
    moderators: [],
    tickets: [],
    it_assets: [],
    it_budgets: [],
    expenses: [],
    vendors: [],
    direct_messages: [],
    broadcast_notifications: [],
    dropdown_options: [],
    sla_configurations: [],
    saved_reports: [],
  };

  const meta = await inspectCloudMetaDoc();

  const readCol = async (colName: string) => {
    try {
      const snap = await withFirestoreRetry(() => getDocs(buildCollectionReadQuery(colName, firebaseUser)));
      return snap.docs.map((d) => d.data());
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, colName);
    }
  };

  const results = await Promise.all(COLLECTIONS_TO_HYDRATE.map((col) => readCol(col)));
  const byCol = new Map<string, any[]>();
  COLLECTIONS_TO_HYDRATE.forEach((col, i) => byCol.set(col, results[i]));

  tables.locations = (byCol.get('locations') || []).map((d) => ({
    id: d.idNum,
    code: d.code,
    name: d.name,
    type: d.type,
    city: d.city,
    state: d.state,
    address: d.address,
    manager_name: d.managerName || null,
    created_at: d.recordCreatedAt || undefined,
  }));

  tables.departments = (byCol.get('departments') || []).map((d) => ({
    id: d.idNum,
    name: d.name,
    code: d.code,
    cost_center: d.costCenter || null,
  }));

  tables.users = (byCol.get('crm_users') || []).map((d) => ({
    id: d.idNum,
    role_id: d.roleId,
    email: d.email,
    password_hash: d.passwordHash,
    full_name: d.fullName,
    status: d.status,
    must_reset_password: d.mustResetPassword,
    mobile: d.mobile || null,
    last_login_at: d.lastLoginAt || null,
    last_login_ip: d.lastLoginIp || null,
    created_at: d.recordCreatedAt || undefined,
  }));

  tables.employees = (byCol.get('employees') || []).map((d) => ({
    id: d.idNum,
    user_id: d.userId > 0 ? d.userId : null,
    employee_code: d.employeeCode,
    full_name: d.fullName,
    department_id: d.departmentId > 0 ? d.departmentId : null,
    designation: d.designation,
    mobile: d.mobile,
    email: d.email,
    location_id: d.locationId > 0 ? d.locationId : null,
    reporting_manager: d.reportingManager || null,
    login_count: d.loginCount ?? 0,
    last_login_at: d.lastLoginAt || null,
    last_login_ip: d.lastLoginIp || null,
    created_at: d.recordCreatedAt || undefined,
  }));

  tables.moderators = (byCol.get('moderators') || []).map((d) => ({
    id: d.idNum,
    user_id: d.userId,
    employee_code: d.employeeCode,
    full_name: d.fullName,
    email: d.email,
    phone: d.phone,
    specialization: d.specialization,
    assigned_location_ids: JSON.stringify(Array.isArray(d.assignedLocationIds) ? d.assignedLocationIds : []),
    date_of_joining: d.dateOfJoining,
    status: d.status,
    performance_rating: d.performanceRating,
    max_capacity: d.maxCapacity,
    created_at: d.recordCreatedAt || undefined,
  }));

  tables.tickets = (byCol.get('tickets') || []).map((d) => d.payload || {});
  tables.it_assets = (byCol.get('assets') || []).map((d) => d.payload || {});
  tables.it_budgets = (byCol.get('budgets') || []).map((d) => ({
    id: d.idNum,
    fiscal_year: d.fiscalYear,
    month: d.month,
    location_id: d.locationId > 0 ? d.locationId : null,
    category: d.category,
    allocated_amount: d.allocatedAmount,
    notes: d.notes || null,
    created_by_user_id: d.createdByUserId > 0 ? d.createdByUserId : null,
    created_at: d.recordCreatedAt || undefined,
  }));

  tables.expenses = (byCol.get('expenses') || []).map((d) => d.payload || {});
  tables.vendors = (byCol.get('vendors') || []).map((d) => ({
    id: d.idNum,
    name: d.name,
    category: d.category,
    contact_person: d.contactPerson || null,
    phone: d.phone || null,
    email: d.email || null,
    tax_id: d.taxId || null,
    address: d.address || null,
    created_at: d.recordCreatedAt || undefined,
  }));

  tables.direct_messages = (byCol.get('direct_messages') || []).map((d) => ({
    id: d.idNum,
    sender_user_id: d.senderUserId,
    recipient_user_id: d.recipientUserId,
    ticket_id: d.ticketId > 0 ? d.ticketId : null,
    message: d.message,
    is_read: d.isRead,
    read_at: d.readAt || null,
    conversation_scope: d.conversationScope || 'direct',
    is_flagged_private: d.isFlaggedPrivate ?? 0,
    is_archived: d.isArchived ?? 0,
    archived_at: d.archivedAt || null,
    archived_by_user_id: d.archivedByUserId > 0 ? d.archivedByUserId : null,
    created_at: d.recordCreatedAt || undefined,
  }));

  tables.broadcast_notifications = (byCol.get('broadcast_notifications') || []).map((d) => d.payload || {});
  tables.dropdown_options = (byCol.get('dropdown_options') || []).map((d) => {
    if (d.meta?._row) return d.meta._row;
    return {
      id: d.idNum,
      group_key: d.groupKey,
      label: d.label,
      value: d.value,
      sort_order: d.sortOrder,
      is_active: d.isActive,
      is_system: d.isSystem,
      meta_json: JSON.stringify(d.meta?.parsed || {}),
    };
  });

  tables.sla_configurations = (byCol.get('sla_configurations') || []).map((d) => ({
    id: d.idNum,
    priority: d.priority,
    first_response_minutes: d.firstResponseMinutes,
    resolution_hours: d.resolutionHours,
    working_hours_start: d.workingHoursStart,
    working_hours_end: d.workingHoursEnd,
    holidays_json: JSON.stringify(Array.isArray(d.holidays) ? d.holidays : []),
    auto_escalate: d.autoEscalate,
    escalate_to_email: d.escalateToEmail || null,
  }));

  tables.saved_reports = (byCol.get('saved_reports') || []).map((d) => {
    const p = d.payload || {};
    return {
      ...p,
      id: p.id ?? d.idNum,
      report_type: p.report_type ?? d.reportType,
      title: p.title ?? d.title,
      row_count: p.row_count ?? d.rowCount,
      created_by_name: p.created_by_name ?? d.createdByName,
      created_by_role: p.created_by_role ?? d.createdByRole,
      rows_json: p.rows_json ?? JSON.stringify(Array.isArray(p.rows) ? p.rows : []),
    };
  });

  for (const rec of byCol.get('crm_records') || []) {
    const tName = rec.tableName;
    if (!tName || !rec.dataMap) continue;
    if (!tables[tName]) tables[tName] = [];
    tables[tName].push(rec.dataMap);
  }

  return {
    tables,
    meta: { lastSeq: meta.lastSeq, totalRecords: meta.totalRecords },
  };
}

export async function hydrateServerFromCloudFirestore(
  mode: 'auto' | 'manual'
): Promise<{ restored: boolean; restoredCount: number }> {
  const firebaseUser = auth.currentUser;
  if (!firebaseUser) {
    return { restored: false, restoredCount: 0 };
  }
  if (hydrateInFlightPromise) {
    return hydrateInFlightPromise;
  }

  hydrateInFlightPromise = (async () => {
    updateStatus({ restoring: true, lastError: null });
    try {
      const meta = await inspectCloudMetaDoc();
      if (!meta.exists || meta.totalRecords === 0) {
        return { restored: false, restoredCount: 0 };
      }

      const snapshot = await readAllCloudFirestoreTables(firebaseUser);
      if (mode === 'auto') {
        const idToken = await firebaseUser.getIdToken();
        const res = await apiFetch<{ ok: boolean; skipped?: boolean; restoredCount?: number }>(
          '/api/cloud-db/auto-hydrate',
          {
            method: 'POST',
            headers: { 'X-Firebase-Id-Token': idToken },
            body: JSON.stringify(snapshot),
          }
        );
        if (res.skipped) {
          return { restored: false, restoredCount: 0 };
        }
        resetCloudSyncCache();
        return { restored: true, restoredCount: res.restoredCount || 0 };
      } else {
        const res = await apiFetch<{ ok: boolean; restoredCount: number }>('/api/cloud-db/hydrate', {
          method: 'POST',
          body: JSON.stringify(snapshot),
        });
        resetCloudSyncCache();
        return { restored: true, restoredCount: res.restoredCount || 0 };
      }
    } catch (err: any) {
      updateStatus({ lastError: err?.message || 'Failed to restore from Cloud Firestore' });
      throw err;
    } finally {
      updateStatus({ restoring: false });
      hydrateInFlightPromise = null;
    }
  })();

  return hydrateInFlightPromise;
}

export async function checkAndAutoHydrateFromCloudFirestore(): Promise<{
  restored: boolean;
  restoredCount: number;
  cloudDetected: boolean;
}> {
  const firebaseUser = auth.currentUser;
  if (!firebaseUser) {
    updateStatus({ connected: false, email: null, uid: null });
    return { restored: false, restoredCount: 0, cloudDetected: false };
  }

  updateStatus({
    connected: true,
    email: firebaseUser.email || null,
    uid: firebaseUser.uid,
  });

  await testConnection();
  await ensureAdminRegistryDoc(firebaseUser);

  const [bootstrap, meta] = await Promise.all([
    apiFetch<CloudBootstrapStatusResponse>('/api/cloud-db/bootstrap-status'),
    inspectCloudMetaDoc(),
  ]);

  updateStatus({
    projectId: bootstrap.projectId,
    databaseId: bootstrap.firestoreDatabaseId,
    cloudSnapshotDetected: meta.exists && meta.totalRecords > 0,
    cloudTotalRecords: meta.totalRecords,
    cloudUpdatedAt: meta.updatedAtIso,
  });

  if (bootstrap.isFreshLocal && meta.exists && meta.totalRecords > 0) {
    const res = await hydrateServerFromCloudFirestore('auto');
    return { ...res, cloudDetected: true };
  }

  return { restored: false, restoredCount: 0, cloudDetected: meta.exists && meta.totalRecords > 0 };
}

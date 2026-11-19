/**
 * Phase 0: Payload-First Security Rule Verification Spec
 * Verifies the "Dirty Dozen" adversarial payloads against the Eight Pillars invariants.
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  collection: string;
  docId: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  auth: { uid: string; email: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_PAYLOADS: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated Ticket Read',
    collection: 'tickets',
    docId: 'row_1',
    operation: 'get',
    auth: null,
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unverified Email Admin Spoof',
    collection: 'crm_users',
    docId: 'row_1',
    operation: 'get',
    auth: { uid: 'spoof_1', email: 'a88593347@gmail.com', email_verified: false },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Self-Admin Privilege Escalation',
    collection: 'admins',
    docId: 'attacker_uid',
    operation: 'create',
    auth: { uid: 'attacker_uid', email: 'attacker@example.com', email_verified: true },
    payload: {
      uid: 'attacker_uid',
      email: 'attacker@example.com',
      displayName: 'Attacker',
      role: 'admin',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Shadow Field Injection on Location Create',
    collection: 'locations',
    docId: 'row_99',
    operation: 'create',
    auth: { uid: 'admin_uid', email: 'a88593347@gmail.com', email_verified: true },
    payload: {
      idNum: 99,
      code: 'WH-99',
      name: 'Test Hub',
      type: 'Hub',
      city: 'Delhi',
      state: 'DL',
      address: 'Road 1',
      managerName: 'Mgr',
      recordCreatedAt: '2026-11-19',
      ownerUid: 'admin_uid',
      isSystemOverride: true,
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'OwnerUid Spoofing on Ticket Create',
    collection: 'tickets',
    docId: 'row_5',
    operation: 'create',
    auth: { uid: 'user_a', email: 'user_a@example.com', email_verified: true },
    payload: {
      idNum: 5,
      ticketNumber: 'INC-2026-0005',
      status: 'New',
      priority: 'High',
      locationId: 1,
      departmentId: 1,
      category: 'Hardware',
      deviceName: 'Scanner',
      description: 'Test',
      payload: {},
      ownerUid: 'victim_uid',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Client Timestamp Forgery',
    collection: 'departments',
    docId: 'row_2',
    operation: 'create',
    auth: { uid: 'admin_uid', email: 'a88593347@gmail.com', email_verified: true },
    payload: {
      idNum: 2,
      name: 'Ops',
      code: 'OPS',
      costCenter: 'CC-1',
      ownerUid: 'admin_uid',
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Immutable createdAt Tampering on Update',
    collection: 'locations',
    docId: 'row_1',
    operation: 'update',
    auth: { uid: 'admin_uid', email: 'a88593347@gmail.com', email_verified: true },
    payload: {
      createdAt: '2025-01-01T00:00:00Z',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'ID Poisoning with Invalid Characters',
    collection: 'locations',
    docId: 'bad$id_poisoning_!',
    operation: 'create',
    auth: { uid: 'admin_uid', email: 'a88593347@gmail.com', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Oversized Ticket Description (>5000 chars)',
    collection: 'tickets',
    docId: 'row_7',
    operation: 'create',
    auth: { uid: 'admin_uid', email: 'a88593347@gmail.com', email_verified: true },
    payload: {
      description: 'x'.repeat(5001),
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'PII Blanket Read by Non-Admin',
    collection: 'employees',
    docId: 'row_1',
    operation: 'get',
    auth: { uid: 'regular_user', email: 'regular@example.com', email_verified: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Non-Admin Update of Terminal Ticket',
    collection: 'tickets',
    docId: 'row_10',
    operation: 'update',
    auth: { uid: 'regular_user', email: 'regular@example.com', email_verified: true },
    payload: {
      status: 'In Progress',
    },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Unbounded Array Injection on Moderator',
    collection: 'moderators',
    docId: 'row_1',
    operation: 'create',
    auth: { uid: 'admin_uid', email: 'a88593347@gmail.com', email_verified: true },
    payload: {
      assignedLocationIds: Array.from({ length: 101 }, (_, i) => i + 1),
    },
    expectedResult: 'PERMISSION_DENIED',
  },
];

export function isValidIdPredicate(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id);
}

export function verifyDirtyDozenInvariants(): boolean {
  const idCase = DIRTY_DOZEN_PAYLOADS.find((c) => c.id === 8)!;
  if (isValidIdPredicate(idCase.docId)) {
    throw new Error('ID poisoning case unexpectedly passed isValidIdPredicate');
  }
  return DIRTY_DOZEN_PAYLOADS.length === 12;
}

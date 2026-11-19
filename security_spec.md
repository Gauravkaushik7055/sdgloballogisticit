# Phase 0: Security Specification & Payload-First TDD

## 1. Data Invariants
1. **Verified Identity**: Every read or write requires `request.auth != null && request.auth.token.email_verified == true`.
2. **Admin & PII Isolation**: `crm_users`, `employees`, `moderators`, `crm_meta`, `crm_records`, `budgets`, `expenses`, `vendors`, `admins` contain PII or system governance data and are strictly restricted to verified admins (`a88593347@gmail.com` or an existing `/admins/{uid}` document).
3. **Self-Role Escalation Prevention**: A non-admin user cannot write to `/admins/{uid}` to promote themselves to admin.
4. **Immutable Ownership & Creation Time**: `ownerUid` must equal `request.auth.uid` on create and cannot change on update; `createdAt` must equal `request.time` on create and remain unchanged on update; `updatedAt` must equal `request.time` on both create and update.
5. **Path ID & String Length Hardening**: All document IDs match `^[a-zA-Z0-9_\-]+$` (`<= 128` chars), and every string/list property enforces strict type and upper size bounds.
6. **Strict Keys (Anti-Shadow-Fields)**: Every document enforces `keys().hasAll(...) && keys().hasOnly(...)` on create, and `affectedKeys().hasOnly(...)` on update.
7. **Zero `get()`/`exists()` in List Rules**: `allow list` rules evaluate only `request.auth.token` and `resource.data` (no O(n) DB reads).
8. **Terminal State Protection**: Completed/Closed tickets require `isAdmin()` to modify once terminal.

## 2. The "Dirty Dozen" Adversarial Payloads (All Must Fail with `PERMISSION_DENIED`)
1. **Unauthenticated Ticket Read**: `auth = null` attempting `get /tickets/row_1`.
2. **Unverified Email Admin Spoof**: `auth.token = { email: 'a88593347@gmail.com', email_verified: false }` attempting `get /crm_users/row_1`.
3. **Self-Admin Privilege Escalation**: Non-admin authenticated user creating `/admins/attacker_uid` with `{ role: 'admin' }`.
4. **Shadow Field Injection on Location Create**: Including extra key `{ ..., isSystemOverride: true }` failing `keys().hasOnly(...)`.
5. **OwnerUid Spoofing on Ticket Create**: Setting `ownerUid: 'victim_uid'` different from `request.auth.uid`.
6. **Client Timestamp Forgery**: Setting `createdAt` or `updatedAt` to a past timestamp instead of `request.time`.
7. **Immutable `createdAt` Tampering on Update**: Modifying `createdAt` during an `update` operation.
8. **ID Poisoning / Path Traversal**: Document ID `'bad$id/with/slash'` or >128 chars failing `isValidId()`.
9. **Oversized Description Denial-of-Wallet**: Ticket `description` > 5000 characters.
10. **PII Blanket Read by Non-Admin**: Non-admin user listing or getting `/employees/row_1` or `/crm_users/row_1`.
11. **Non-Admin Update of Terminal Ticket**: Non-admin attempting to update a ticket whose `existing().status == 'Closed'`.
12. **Unbounded Array Injection on Moderator**: Setting `assignedLocationIds` to > 100 items or non-list type.

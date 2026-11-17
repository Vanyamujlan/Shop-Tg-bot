# Security Specification (`security_spec.md`)

## Phase 0: Payload-First Security TDD

### 1. Data Invariants
1. **Default-Deny Catch-All**: Unmatched paths in `/databases/{database}/documents/{document=**}` are strictly denied (`allow read, write: if false;`).
2. **Verified Authentication & Admin Isolation**: All write operations from client SDKs require `isSignedIn() && isVerified()`, while administrative collections (`/admins`, `/settings`, `/transactions`, `/payments`) and catalog management (`/products`) are strictly restricted to verified administrators (`isAdmin()`).
3. **PII Isolation (`/users/{userId}`)**: User profile documents contain personal Telegram metadata and purchase totals; `get` is restricted to `isOwner(userId) || isAdmin()`, and `list` is restricted to `isAdmin()`. Users cannot self-assign `isBlocked: false` once blocked or inflate `totalOrders` / `totalSpentStars`.
4. **Price & Payment Integrity (`/orders/{orderId}`, `/payments/{paymentId}`)**: Orders can only be read by their owner (`resource.data.userId == request.auth.uid`) or an admin (`isAdmin()`). Clients cannot forge `paid` or `completed` statuses or create payment records directly; payment records in `/payments/{paymentId}` are created exclusively by the server/admin after `successful_payment` verification.
5. **Path Variable & Payload Size Hardening**: Every document ID (`userId`, `productId`, `orderId`, `paymentId`, `transactionId`, `adminId`, `settingKey`) must match `^[a-zA-Z0-9_\-]+$` and be `<= 128` characters. All string fields enforce strict `.size()` upper bounds matching `firebase-blueprint.json`.
6. **Terminal State Locking**: Once an order reaches a terminal state (`completed`, `cancelled`, `refunded`, `failed`), non-admin updates are permanently locked.

### 2. The "Dirty Dozen" Payloads

1. **Unauthenticated Product Creation**: `auth = null`, `create /products/stars_100` -> `PERMISSION_DENIED`.
2. **Unverified Email Admin Spoof**: `auth = { uid: 'u1', token: { email: 'vanyamujlan@gmail.com', email_verified: false } }`, `create /products/stars_100` -> `PERMISSION_DENIED`.
3. **Shadow Field Injection on User Profile**: `create /users/u1` with extra ghost field `{ isSuperAdmin: true }` -> `PERMISSION_DENIED` via `hasOnly()`.
4. **PII Blanket Read on Another User**: `auth = { uid: 'u2' }`, `get /users/u1` -> `PERMISSION_DENIED`.
5. **Identity Spoofing on Order Creation**: `auth = { uid: 'u1' }`, `create /orders/ord_1` with `{ userId: 'u2' }` -> `PERMISSION_DENIED`.
6. **Client-Side Order Status Forgery (`paid`)**: `auth = { uid: 'u1' }`, `create /orders/ord_1` with `{ paymentStatus: 'paid' }` -> `PERMISSION_DENIED`.
7. **Terminal State Mutation**: `auth = { uid: 'u1' }`, `update /orders/ord_completed` where `existing().fulfillmentStatus == 'completed'` -> `PERMISSION_DENIED`.
8. **Direct Payment Record Forgery by Non-Admin**: `auth = { uid: 'u1' }`, `create /payments/pay_1` -> `PERMISSION_DENIED`.
9. **Resource Poisoning (Oversized String)**: `auth = admin`, `create /products/p1` with `description` length 5000 (`> 1000`) -> `PERMISSION_DENIED`.
10. **Path Variable ID Poisoning**: `auth = admin`, `create /products/invalid$id!` -> `PERMISSION_DENIED` via `isValidId()`.
11. **Immutable Field Modification (`createdAt` / `userId`)**: `auth = { uid: 'u1' }`, `update /orders/ord_1` changing `createdAt` -> `PERMISSION_DENIED`.
12. **Unauthorized Order List Scraping**: `auth = { uid: 'u1' }`, `list /orders` without filtering `resource.data.userId == request.auth.uid` -> `PERMISSION_DENIED`.

### 3. Conflict & Red Team Audit Report
- **Identity Spoofing**: Blocked by `data.userId == request.auth.uid` and `isOwner(userId)`.
- **State Shortcutting**: Blocked by requiring `paymentStatus == 'pending'` and `fulfillmentStatus == 'pending'` on user order creation, and terminal state lock on completed/refunded/cancelled orders.
- **Resource Poisoning**: Blocked by `isValidId()` and strict `.size()` bounds on every string property.
- **Value Poisoning**: Blocked by wrapping every `allow update` block with `isValid[Entity](incoming())`.

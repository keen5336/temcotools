# v1 account login migration

This release changes authentication. Shipping the source does not migrate or
restart production. Apply the procedure below only in an approved rollout window.
No email address or personal phone is required.

## Staff experience

The default sign-in uses the existing username and a new password/passphrase of
12–256 characters. Spaces and password-manager paste work. No character mixture
or periodic password rotation is required. A small bundled common-password list
and obvious account/company-based passwords are rejected; this is not a complete
breached-password lookup service. Passwords use salted scrypt (N=32768, r=8, p=3).

An assigned Zebra or laptop stays signed in for up to 30 days, including across
shifts. There is no inactivity or shift logout. The cookie is HttpOnly, SameSite
Lax, and Secure in production; the database enforces expiry and revocation. A
password check within 10 minutes is required for account administration, API relay
definition changes, and Driver Paperwork template/program publishing.

The old PIN entry opens only “Let's update your login.” It never authorizes tools,
relays, or administration. Even existing pre-upgrade cookies become setup hints,
with no operational user identity. An independent, privately delivered,
one-use code is necessary to choose the new password. A valid code can also be
used directly at `/account/update` without a working PIN. Codes expire after 30
minutes. Old PIN knowledge alone cannot claim an account or issue codes.

Completion preserves the user's ID, role, favorites and operational history. It
atomically records password enrollment, replaces the PIN hash with a disabled
marker, advances the account version, consumes outstanding codes and revokes all
previous sessions. This account never returns to PIN login. Admins may disable
legacy entry globally after migration; turning that switch back on cannot restore
an upgraded account's PIN. New accounts receive codes, never initial PINs.

## Rollout preparation and first administrator

1. Back up and verify the database using the existing operations procedure. Record
   the release commit. Stage the application and API broker images together; the
   broker now reports each connection's creating authentication session. Confirm
   the canonical `NEXT_PUBLIC_APP_URL` and a strong existing `SESSION_SECRET`.
   Keep `TRUST_PROXY=true` only behind the trusted deployment reverse proxy;
   rate limiting uses its rightmost appended client address. Do not expose the
   app directly while trusting client-provided forwarding headers.
2. Arrange a verified administrator and private delivery channel before rollout.
   Everyone's existing cookie will lose tool access until their account is
   enrolled. Enroll relay workstation users early and plan to reconnect their
   API relays/re-enable the label relay. No live external session is migrated.
3. In the approved window, apply migration
   `20261117030000_account_login_migration` with the migration runner and start
   the matching app and broker release. No password or setup code is seeded.
4. On the operator host with that release and protected database environment,
   run the offline administrator enrollment command. The target must match both
   host (including port) and database. Default invocation is read-only:

   ```sh
   npm run account-enrollment -- --username EXISTING_ADMIN --purpose enroll \
     --expect-host DB_HOST:5432 --expect-database DB_NAME
   ```

   Verify the target and the person independently. Create a private owned 0700
   directory with a canonical absolute path (no symlink components). Then run:

   ```sh
   npm run account-enrollment -- --username EXISTING_ADMIN --purpose enroll \
     --expect-host DB_HOST:5432 --expect-database DB_NAME --apply \
     --reason 'Verified first administrator during approved migration' \
     --delivery-file /PRIVATE/CANONICAL/DIRECTORY/admin-setup.json
   ```

   This is an offline operator action restricted to an existing active admin. It
   writes the code into a new exclusive 0600 file, fsyncs it before database
   commit, and never prints the code, password, database URL or session token.
   Deliver it privately to the verified administrator, who completes setup at
   `/account/update`. If `NEXT_PUBLIC_APP_URL` is set, the file includes a private
   link carrying the code in a fragment, not a server query string. The page
   removes the fragment after reading it. Remove private delivery files after use.
   Do not paste codes into tickets, shared chat, screenshots or logs.
5. If the command fails or the response is uncertain, preserve the delivery file
   and inspect current state before another action. A failed commit may leave an
   unusable file. Do not automatically reissue a reset. Try the delivered code or
   a newly chosen password as appropriate; an unused expired/lost code requires
   an explicit replacement. The operator entry point accepts `--purpose reset`
   for independently verified recovery of an existing active admin, including the
   last usable admin. Reset immediately disables the current password/sessions.
6. For a genuinely new empty installation only, create an unenrolled first admin
   with `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_DISPLAY_NAME`:

   ```sh
   npm run bootstrap -- --expect-host DB_HOST:5432 --expect-database DB_NAME
   npm run bootstrap -- --expect-host DB_HOST:5432 --expect-database DB_NAME --apply
   ```

   It creates no PIN or password and refuses to create another admin if an active
   admin already exists. Existing usernames are never promoted or reactivated by
   this script. Continue with the offline enrollment command above. The former
   `BOOTSTRAP_ADMIN_PIN` environment variable is no longer used.

## Staff migration and recovery

An enrolled administrator opens User Management, confirms their password if
necessary, and privately issues a setup code after checking the person's identity
in person or through an established trusted channel. A name and old PIN are not
proof of identity. Issue codes when the person is ready; they last 30 minutes.
The manager shows migration state and live password-session counts, allows roles
and active status to be changed, and can sign out all devices. Sensitive changes
are audited without credentials. Keep two enrolled active administrators.

Password recovery is a separate explicit action with a reason. It immediately
disables the current password and revokes all sessions, then delivers a one-use
recovery code. The person chooses a new password; old PIN login never returns.
An admin cannot reset/deactivate/demote the last usable admin through the UI;
use the independently authorized offline operator recovery if needed.

Account security lets each person change their password, view device names and
expiry, and sign out one or all other devices. Password changes invalidate all
other sessions and issue this device a fresh session. Role, username, active-state
changes and administrator sign-out invalidate the account's sessions and codes.
All authenticated routes resolve current database identity instead of trusting a
cached role in a cookie. API relay dispatch rechecks the creating durable session,
including queued requests. Already dispatched external requests may have an
uncertain result and are never replayed automatically. Label relay authorization
is revalidated against the app on each WebSocket command/heartbeat.

Authentication has persistent account and source rate limits: 12 attempts per
account and 120 per source in a 15-minute window for login, code redemption and
password confirmation separately. Errors for failed login are generic. Code
hashes alone are stored, and replacement invalidates older unused codes. Request
bodies are bounded and account mutations require the exact app Origin.

A lost response must not trigger an automatic account write retry. Reload state
first; after enrollment/password change, try the new password. Code issuing uses
operation IDs, but re-reading a completed issue does not reveal its secret again.

## Validation and rollback boundaries

Run `npm run test:auth` for policy/hash tests. PostgreSQL integration runs only with
`AUTH_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55476/auth_qa`, and HTTP
qualification additionally uses `AUTH_TEST_APP_URL=http://127.0.0.1:33021` against
a local instance configured for that same synthetic database. Never use a real
staff database as a fixture. Existing managed-relay integration uses its own
similarly guarded test database.

Before rollout, validate schema migration on a restored copy, offline first-admin
setup and recovery, staff migration, old-cookie denial, cross-shift persistence,
revocation, and relay reconnection. Local synthetic tests do not establish physical
Zebra/browser acceptance. Passkeys and authenticator-app MFA are not in this
release; they need a device compatibility pilot before being offered to staff.

After this authentication release is applied, use forward fixes. Reverting to the
old cookie/PIN-auth application would restore its vulnerable authorization model,
including pre-migration cookies. Do not roll back to that image. Keep the database
migration and enrollment records; do not restore PIN hashes or clear enrollment
flags to resolve a login issue.

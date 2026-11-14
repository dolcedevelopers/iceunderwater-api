# Delivery handover and event RSVP (0.2.21)

This release is implemented locally. Deploy the API and migrations with the corresponding mobile app. `npm run start:prod` applies migrations; the server starts its deadline worker after startup. No Firebase, remote push service or wallet is used.

## Delivery lifecycle

`assigned -> en-route -> arrived -> delivered`

Only the allocated driver can start or report arrival. Starting combines acceptance and departure. Arrival records a UTC server timestamp and a deadline 20 minutes later. Only the purchasing WordPress account can confirm receipt, supplying `recipientName` and `confirmed: true`. A driver or supplier cannot set an arbitrary delivered status through PATCH. Receipt proof is a name, account and timestamp, not a signature image.

When the collection window expires, the worker records `not_delivered`. It runs roughly every 15 seconds while the server runs, and catches up on startup. A receipt request at/after the deadline also persists expiry instead of completing the order. The driver can record an overdue uncollected delivery explicitly.

`not_delivered -> redelivery_requested -> assigned`

The buyer must provide a reason and a future date/time. The supplier selects an available driver for the next attempt. Earlier events remain in history. No automatic charge is created for redelivery. `assigned -> declined -> assigned` supports driver declines and supplier reassignment.

Assignments lock the paid transaction and the selected driver. Existing allocations are rejected. Driver availability/deletion changes also lock the driver and check active work. The same supplier must own the driver and the paid order. Collection orders do not appear in the delivery-order picker.

## API

- `GET /delivery-orders`: supplier/admin's paid, unassigned delivery orders.
- `GET /deliveries`: scoped delivery DTOs, contacts, receipt and attempt metadata.
- `POST /deliveries`: `{orderId, driverId}`; identity comes from the paid transaction.
- `POST /deliveries/:id/actions`: `{action, ...fields}`. Actions: start, decline, arrive, not-collected, receive, redeliver, reassign. Reasons max 512 characters; recipient name max 160; redelivery date is ISO UTC.
- `GET /deliveries/:id/history`: owner-authorized status/time/reason history.
- Existing driver GPS endpoints remain owner-scoped. Customer/company-buyer map positions are rounded to three decimal places and restricted to active deliveries. Tracking requires foreground location sharing and a signed-in driver. Existing 10-minute idle logout remains.
- `GET /invoices/:id/pdf`: authenticated JSON `{filename,mimeType,base64}`. Checks existing transaction permissions before querying item lines. Supplier sales show only owned lines. PDF is a receipt/invoice based on recorded totals; it does not invent a tax breakdown or certify delivery. The app supports Android save-folder selection and native file sharing/email attachments.

## In-app notifications

Delivery changes and their inbox entries are stored in the same transaction. Assignment/decline/redelivery/receipt notify the relevant operator; start/arrival/expiry notify the buyer. Company users receive supplier notifications and updates for their own purchases. Notification reads remain recipient-scoped and idempotent.

The app checks its inbox about every 15 seconds while active, shows a banner and plays the bundled arrival bell with vibration for a fresh arrival. It uses the server clock and remembers seen IDs. Completing receipt marks obsolete buyer delivery notices read. Phone volume, silent mode and the platform affect sound. There are **no closed-app/background OS push banners**. This is the user's agreed scope after declining Firebase setup.

## Warrior Kings RSVP

- `GET/PUT/DELETE /events/warrior-kings/rsvp`: read, confirm/update, cancel the authenticated attendee's response.
- Confirmation requires a valid province/city pair from the shared SA location catalog. Identity/email are bound to the session. Drivers cannot RSVP.
- A unique `(event_key,wp_user_id)` index enforces one response per account. Updating/reconfirming uses the same record; cancellations are excluded from statistics.
- `GET /admin/events/warrior-kings/rsvps`: confirmed count plus city counts and percentages. Denominator is all confirmed responses, including every city. Percentages are rounded to one decimal; rounding can produce 99.9% or 100.1% in total.
- `GET .../attendees?page=1&search=...`: admin-only 50-row pages, optional email/city/province search.
- `GET .../export`: admin-only CSV of all confirmed responses. Cells are quoted and protected against spreadsheet formula injection.
- RSVP does not purchase/reserve a ticket, join an event team or alter event registration/profile status.

## Rollout checks

Apply migrations 016 and 017, rebuild the native app for the audio and sharing modules, and exercise the flow with real supplier/driver/customer accounts. Test GPS, audio/vibration, dialler, Android file save and attachment sharing on the intended Huawei device. The isolated PDF preview uses dummy records and an illustrated map; it does not prove production delivery, physical-device sound or live GPS. Retain WordPress invoice-email testing separately from the new PDF export route.

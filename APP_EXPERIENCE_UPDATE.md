# Mobile experience and delivery scheduling

Android version 0.2.10 (12).

- Home uses the supplied clean car/motorcycle photograph with a readable Warrior Kings registration heading and an icon button linking to Event registration.
- Account uses a photo-led member card and compact expandable actions. Personal details, password changes, receipts, website orders and tracking remain available. Stored avatar metadata is read through authenticated GET /me/profile. Photo uploads immediately show the returned hosted image, with an error and retry path on failure.
- Ordinary signup has no group-photo input. Groups are accessed from Event; Account only lists teams if the account already has memberships. This change does not claim or verify paid event attendance.
- Request history and Bag share coloured request cards with an SVG countdown driven by the server deadline, changing from purple to amber to rose. Timers never authorize acceptance or payment.
- A required delivery date and time is chosen before a customer or company submits a request. Date/time selections persist with the account's bag. The app converts South African wall time to ISO UTC; the API validates a real future timestamp. All displays and supplier notifications label the schedule in SAST.
- Migration 012 adds nullable delivery_at for historical requests. New requests require deliveryAt; resends preserve it unless the owner edits it. An unscheduled or overdue legacy request requires a new schedule on resend. Accepted requests cannot be changed. Acceptance expires at the earlier of 15 minutes or requested delivery time.
- Supplier request lists show the delivery schedule before acceptance and in past requests. Existing supplier selection, account privacy, accept-before-pay and checkout ownership rules are preserved.

Validation: backend tests and TypeScript build; Android Metro/Hermes export; mobile buyer storage, date/time conversion, catalogue and access-rule checks. A physical Huawei P40 installation is still needed to verify native camera/notch layout, image selection and date/time dialogs on the device.

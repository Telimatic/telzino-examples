# Appointment Confirmation

`telzino_outbound_call_trigger.gs` is a Google Apps Script that turns a Google Sheet into an automated appointment-confirmation dialer for a Telzino outbound agent.

- **Trigger side:** when a row on the Bookings tab has the required fields filled in, the script asks Telzino to place a confirmation call, honoring a configurable calling window.
- **Result side:** Telzino posts the call result back to the script's web app, which writes the call status, disposition, notes, recording URL and transcript into the row.
- **Optional booking form:** `createBookingForm` builds a Google Form whose submissions become new rows and trigger calls.

Setup is in the guide on the Telzino docs site: [Appointment Confirmation](https://docs.telzino.com/examples/appointment-confirmation).

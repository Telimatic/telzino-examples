# Google Sheet CRM

`telzino_google_sheet_crm.gs` is a Google Apps Script web app that gives a Telzino voice agent live read and write access to a Google Sheet used as a lightweight CRM.

| Action | What it does |
| :- | :- |
| `lookup` | Finds a customer by caller ID, customer ID, job number or name |
| `reschedule` | Moves a job to a new date and arrival window |
| `create_ticket` | Opens a support ticket on the customer's job |
| `log_call` | Writes the after-call summary to the Call Log tab |
| `ping` | Connection test |

Setup, the four webhook definitions and a sample agent prompt are in the guide on the Telzino docs site: [Receptionist Agent Using Google Sheets as Simple CRM](https://docs.telzino.com/examples/google-sheets-crm-receptionist).

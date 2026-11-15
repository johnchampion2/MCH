# MCH-BDTMS

Blood Donation and Transfusion Management System for Magbenteh Community Hospital. The project keeps the frontend at the root and the Google Apps Script backend in `backend/Code.gs`.

## Project layout

- `index.html` — splash screen, login/registration, and dashboard shell
- `config.js` — Apps Script Web App URL
- `assets/css/` and `assets/js/` — frontend styles and behavior
- `assets/images/` — supplied hospital logo and five rotating background images
- `backend/Code.gs` — Sheets initialization, authentication, and application API

## Connect Google Sheets and Apps Script

1. Create a Google Sheet for the system and open **Extensions → Apps Script** from that sheet.
2. Replace the editor contents with `backend/Code.gs`, then save.
3. Select and run `setupSheets` once in the Apps Script editor. Review and approve the requested Google Sheets permissions. The same initialization also runs automatically when the API is first opened.
4. If you want account-approval emails, run `authorizeMailNotifications` in the Apps Script editor using the same Google account that will own the web app deployment. Approve the mail permission when prompted; approval emails are sent by this account. Low-stock alerts are in-app only and do not send email.
5. Choose **Deploy → New deployment → Web app**. Set **Execute as** to your account, and select the access option that allows the intended users to reach the frontend. Deploy, authorize, and copy the Web App URL ending in `/exec`. After backend changes, update the deployment to a new version.
6. Paste that URL into `apiUrl` in `config.js`.
7. For development, open the project using VS Code Live Server or another local web server. Do not open `index.html` directly as a `file://` URL.
8. For public access and app installation, publish the frontend over HTTPS with the `manifest.webmanifest` and `service-worker.js` at the site root. Share that HTTPS link. The sign-in page shows **Install MCH-BDTMS** until installation succeeds, then hides it. Android and supported desktop browsers offer the install prompt; on iPhone/iPad, open the link in Safari, tap **Share**, then **Add to Home Screen**. The app uses the same Apps Script backend and needs an internet connection for sign-in and records. The sign-in page and application show whether the internet or system is unavailable and check backend availability again after the connection returns.
9. Register the first account while the `USERS` sheet has no rows. It becomes the initial Administrator. Further registrations remain pending until an Administrator approves them; the user is sent a branded approval email. Sign in with the username, password, and assigned role. Existing accounts receive a username based on the part of their email before `@`; check the `USERS` sheet if needed. If mail authorization was missed or expires, run `authorizeMailNotifications` again, update the deployment, then use **Resend approval email** in the Admin control panel.

The backend creates the `USERS`, `DONORS`, `PATIENTS`, `DEPARTMENTS`, `SETTINGS`, and `SESSIONS` sheets, including missing headers, without clearing existing data. Usernames are unique and may contain 3–30 letters, numbers, dots, underscores, or hyphens.

## Records, reports, and profile

- Donor and patient records can be edited in place. The amount saved with an existing donation is retained; the current Administrator-set amount is applied only to new donations.
- Patient issues use standard red-cell ABO/Rh compatibility. The exact patient group is used when enough units are available; otherwise the system selects one compatible donor group with enough units, favoring the same Rh type and preserving O-negative stock where possible. One issue cannot be split across multiple donor groups. The patient group and actual issued group are stored separately and shown in patient lists, exports, and reports; older records without an issued group are treated as exact-group issues. The patient form previews stock, while saves, edits, and restores recheck and allocate under a lock. Insufficient quantities show the compatible stock by group, and donor edits or deletions that would leave issued units unsupported are rejected.
- The Home dashboard shows donated, issued, available, and remaining-stock percentages for each blood group, plus lifetime units issued by department and the highest receiving department. Reports show blood-group units by department and period; departments are not modeled as separate stock rooms.
- The **Low stock** navigation item displays a badge for blood groups at or below 30% of donated stock remaining. Its table lists every blood group with units donated, issued, and available, plus the percentage remaining and low-stock status. The Home dashboard also shows the available units and remaining percentage for each group. Low-stock notices stay in the application and are not emailed.
- Donor and patient forms open immediately with a loading state while required backend values load. Destructive actions use an in-app confirmation dialog; saves, edits, and restores show a success dialog. In the Recycle Bin, only Administrators can restore records, permanently delete individual records, or empty the entire bin; permanent deletion cannot be undone.
- Administrators can add multiple departments in one operation using **＋ Add another department**; duplicate names are rejected before saving.
- Patient department percentages use the matching blood-unit total across departments as the denominator, so selecting one department does not make its share appear as 100%.
- Reports support single month, quarter, and year selections alongside daily, cross-year monthly/quarterly, half-yearly, annual, and custom ranges. Filter for one or all departments. Patient and statistical reports include blood-group totals by department, department rankings, and multi-paragraph written analysis; printed reports include the preparer, generation date/time, a hospital-branded heading, a faded logo watermark, and charts.
- A successful login is remembered on the same browser/device for up to 30 days or until the user logs out. Each device has its own session; another device still requires its own login.
- Profile photos are resized for the circular avatar before saving. To remove a photo, choose **Remove photo** and save the profile.
- Existing spreadsheets receive missing columns such as record update timestamps when `setupSheets` runs; existing record data is not cleared.

## Notes before real hospital use

This is a functional starter application, not a certified clinical record or blood-bank system. Use dummy data while evaluating it. Before entering real patient or donor information, have the hospital's IT/security and clinical governance teams review Google account access, spreadsheet sharing, deployment access, retention and backup, audit requirements, consent, and applicable privacy rules. Restrict spreadsheet editors to trusted staff; anyone with spreadsheet edit access can read or alter stored records. Do not publish the spreadsheet itself.

The application does not replace clinical compatibility testing, crossmatching, transfusion authorization, or blood-bank inventory controls. Compatibility previews are informational and must not be used as clinical approval. Verify all recorded units and workflows with qualified staff before operational use.

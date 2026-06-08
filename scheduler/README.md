# scheduler/ — Apps Script source for devinstein.me/schedule

`backend.gs` is the source of the Google Apps Script web app that powers
the booking page at `schedule.html`. The deployed instance lives at
script.google.com; this folder is just the version-controlled source.

Full design contract: **brain/reference/schedule_spec.md**.

---

## One-time setup

1. **Create the project.** Go to https://script.google.com/, "New project."
   Paste the contents of `backend.gs`. Rename the project (e.g. "devinstein.me scheduler").

2. **Set the script timezone.** File → Project Settings → set timezone to
   `America/Denver`. (This is also enforced in code, but matters for the editor.)

3. **Enable Advanced Calendar Service.** Editor sidebar → Services (➕) →
   add "Google Calendar API." This is what gives us auto-generated Meet links.

4. **Add Turnstile secret to Script Properties.**
   Project Settings → Script Properties → Add:
   - `TURNSTILE_SECRET` = your Cloudflare Turnstile secret key
     (get one at https://dash.cloudflare.com/?to=/:account/turnstile,
     register `devinstein.me` and `localhost` for dev)

5. **Deploy as Web App.**
   Deploy → New deployment → Type: Web app
   - Description: "v1"
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click Deploy. Authorize when prompted (Calendar + Gmail scopes).
   - Copy the `/exec` URL.

6. **Wire the frontend.** Open `../schedule.html`, replace
   `SCHEDULER_ENDPOINT` with the `/exec` URL. Replace the
   `data-sitekey="..."` placeholder on `.cf-turnstile` with your
   Turnstile **site** key (not the secret).

7. **Sanity check.** In the script editor, run `smokeTest()` once. Console
   should print today's slots and how many are currently free. Resolves
   any auth-prompt issues before the first real booking.

---

## Re-deployment after edits

Deploy → Manage deployments → pencil icon on the existing deployment →
Version: New version → Deploy. The `/exec` URL stays the same.

---

## Files

- `backend.gs` — the Apps Script source. Single file, ~270 lines.
- `README.md` — this file.

The script has *no secrets* — Turnstile secret lives in Script Properties.
Source can stay public on GitHub Pages without exposing anything sensitive.

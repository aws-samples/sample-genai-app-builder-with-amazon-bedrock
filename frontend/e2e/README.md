# End-to-end harnesses

Manual harnesses that drive a **deployed** environment with real browsers and
real Cognito accounts. They are deliberately outside `pnpm test` (which is
`vitest` and must stay hermetic) because they need an environment, two accounts,
and a couple of minutes.

## `live-coediting.mjs`

Proves the invite → join → co-edit loop, and records the proof while it runs.

What it asserts:

1. The owner can build a project, **Go live**, and mint an invite link.
2. The guest redeeming that link lands in the owner's **exact** sandbox session
   (`__SANDBOX_SESSION_ID__` matches) — not a copy.
3. The guest's keystrokes reach the owner's editor (`ownerSawGuestEdit`).
4. The owner's keystrokes reach the guest's editor (`guestSawOwnerEdit`).

Exit code 0 means all four held. It also records what it saw without asserting
on it: presence-avatar counts and `filesAppearedAfterJoin` — files that showed
up in the owner's container only after the guest joined, which is how the
project-scoping defect in `docs/multiplayer/TEST_REPORT.md` was found.

### Running it

Playwright is not a repo dependency. Install it wherever convenient, then:

```bash
BV_BASE_URL=https://<distribution>.cloudfront.net \
BV_OWNER_EMAIL=... BV_OWNER_PASSWORD=... \
BV_GUEST_EMAIL=... BV_GUEST_PASSWORD=... \
BV_OUT_DIR=/tmp/bv-coedit-proof \
node frontend/e2e/live-coediting.mjs
```

Set `BV_HEADED=1` to watch it. Never commit credentials — pass them in the
environment.

### Output

In `BV_OUT_DIR`:

- `owner.webm`, `guest.webm` — one recording per browser, sharing a timeline, so
  they can be stacked side by side:
  ```bash
  ffmpeg -i owner.webm -i guest.webm -filter_complex hstack side-by-side.mp4
  ```
- `shots/01..10-*.png` — a frame per step.
- `owner-console.log`, `guest-console.log` — browser errors only. Worth reading
  even on a pass; a green run still logged the Yjs range errors.
- `proof.json` — the machine-readable result.

### Gotchas this harness already works around

- **Clipboard reads are stale in headless Chromium**, so the invite token is
  read off the `POST /session/{id}/invite` response instead of the clipboard.
- **Screenshots time out while a live preview iframe is visible** (the page
  never goes "stable"), so failures to capture are logged, not fatal.
- **File-tree rows are leaf elements inside a button** — click the
  `closest('button')` ancestor, not the row.
- **A cold sandbox takes 30–70s** and an agent build longer; the timeouts are
  sized for that, not for a warm environment.

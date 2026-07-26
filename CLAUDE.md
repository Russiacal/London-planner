# London Family Planner

Single-page web app that generates day-by-day activity ideas for a 17-month-old's London trip (July 27 – August 2, 2026). The user picks a trip day + a neighborhood and Claude returns a list of activities, restaurants, libraries, events, etc. — using the `web_search_20250305` tool to find day-of-week-specific things like story times and farmers markets.

Trip-specific context baked into the system prompt: home base is Notting Hill (near Westbourne Grove, Royal Oak tube), heatwave 85–90°F all week (most London venues have no A/C — the prompt tells the model to prioritize shade / water / cool indoor spots and flag A/C for indoor recs), and all times are London local (BST, UTC+1). No fixed nap window — child naps in the stroller on the go.

## Stack

- **Backend:** Node.js (ESM) + Express 5, Anthropic SDK with `web_search` tool, in-memory job store.
- **Frontend:** single `index.html` with inlined CSS + vanilla JS. No build step, no framework.
- **Hosting:** Railway. Auto-deploys on push to `main` of `github.com/Russiacal/London-planner` (HTTPS remote, not SSH — matches NYC-planner). Production URL: <https://london-planner-production.up.railway.app/>.

## Run locally

```
npm install
npm start       # node server.js, port 3000 (or $PORT)
```

`ANTHROPIC_API_KEY` is required. Locally it's loaded from `../.env` (one directory above the project root — not the project root itself). On Railway it's set as an environment variable in the Railway dashboard.

## Architecture — the `/plan` flow

Generation can take 30–90 seconds (web search + reasoning), which is longer than mobile Safari will hold a single `fetch()` open. So the request is split:

1. **`POST /plan`** validates input, generates a UUID, stores `{ status: "pending" }` in an in-memory `Map`, kicks off `client.messages.create(...)` *without awaiting it*, and returns `{ jobId }` in under a second.
2. The async `.then` writes `{ status: "done", text, completedAt }` (or `{ status: "error", error, completedAt }`) into the same map when Anthropic finishes.
3. **`GET /plan/:jobId`** returns whatever's currently in the map for that ID. The client polls this every 2 seconds.
4. Completed jobs are pruned 10 minutes after `completedAt`.

Trade-offs of this design:
- In-memory state is lost on Railway restart. A user mid-poll would get a 404. Acceptable for a single-user toy.
- No persistence ⇒ no need for a DB.
- Each request is fast, so no iOS/proxy timeout matters.

## Gotchas that took multiple sessions to figure out (do not relearn these)

### iOS Safari hates long-running fetches
- `fetch()` in iOS WebKit (Safari **and** Chrome on iOS — they all use WebKit) aborts with `TypeError: Load failed` after roughly 60 seconds, **even if bytes are flowing**. Keepalive bytes don't help past that limit. The only reliable fix for long Anthropic calls is short polling (the current `/plan` design). Don't switch back to a single long-lived request.
- iOS WebKit also treats `Content-Type: text/event-stream` specially — responses with that type don't deliver bytes through `fetch().body.getReader()` at all (they're reserved for `EventSource`). On desktop Chrome SSE-over-fetch works; on iPhone it returns a `done: true` reader with no data. If we ever stream again, use `application/x-ndjson` not `text/event-stream`.

### Static file serving
- **Never** `app.use(express.static(__dirname))`. That exposes `server.js`, `package.json`, `package-lock.json` etc. as fetchable URLs. Serve `index.html` via an explicit `app.get("/")` and that's it.
- The `/` route sets `Cache-Control: no-cache` because iOS Safari caches HTML aggressively and otherwise keeps serving a stale `index.html` for hours after a deploy.

### Dates
- The trip dates are a **hardcoded lookup table** (`TRIP_DAYS` in `server.js`, mirrored in `index.html`). Do **not** compute them with `new Date()` + `setDate()` — that path has timezone bugs that produced the wrong day-of-week, which then poisoned the system prompt. The hardcoded table is intentionally duplicated client and server.
- The user message to Claude shouts the date and day-of-week in uppercase and tells the model not to recalculate. That phrasing is load-bearing because the model otherwise drifts.

### CSS / activity-type styling
- `typeClass()` strips non-ASCII letters via `[^a-zA-Z]`, so `Café` would become `Caf` and miss the CSS rule `.chip-Café`. The fix was to use **`Cafe`** (no accent) everywhere — system prompt, CSS rules, emoji map. Keep it ASCII-only.

### Markdown in model output
- The model sometimes wraps the field labels with bold (`**ACTIVITY:**`). The regex in `parseActivities()` allows `\*{0,2}` around each label for that reason. If you add new fields, do the same.

## Deploy

`git push origin main` → Railway picks it up, redeploy takes 1–3 minutes. To verify a deploy is live, hit the URL directly with curl — much faster than trying it in a browser:

```
curl -i -X POST https://london-planner-production.up.railway.app/plan \
  -H "Content-Type: application/json" \
  -d '{"day":"1","neighborhood":"Notting Hill (home base)"}'
```

The response should be JSON `{ "jobId": "..." }` in well under a second. Then `GET /plan/<jobId>` returns `{ status: "pending" }` until the work finishes, then `{ status: "done", text }`.

## What's deliberately NOT here

- No tests. No CI. No linter. No TypeScript. No build step. This is a personal one-off; do not add tooling unless asked.
- No persistence layer. No auth. No CORS — same-origin only.
- No streaming UX. The user accepted "spinner for 30s" in exchange for the iPhone working.

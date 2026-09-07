# Web2PDF

Convert any public web page into a clean, properly paginated A4 PDF.

The page is loaded in real Chromium, JavaScript runs, lazy content is scrolled
into existence, ads and popups are removed, and the result is laid out as an A4
document you can edit before downloading.

---

## What it actually does

1. Validates the URL and resolves it, refusing internal network destinations.
2. Opens it in Chromium via Playwright and waits for the page to *stabilise* —
   not merely `DOMContentLoaded`.
3. Scrolls progressively so lazy images and deferred content load.
4. Scores every element for noise and for content, and removes ads, cookie
   banners, modals, chat widgets and sticky promos — while protecting the
   article.
5. Serializes the cleaned page into a self-contained snapshot (CSS pruned,
   images inlined, canvases frozen).
6. Measures the document against A4 geometry and plans page breaks so images,
   figures, table rows and headings are not split.
7. Renders a real A4 PDF and shows it beside an editable preview.
8. Lets you remove, hide, restore and undo, then regenerate and download.

No accounts, no database, no document history. A session lives in memory and
expires.

---

## Architecture

The load-bearing decision: **capture once, re-render many.**

After the page is captured it is serialized into a self-contained HTML snapshot.
Every later PDF render works from that snapshot in a fresh, short-lived browser
context. The origin site is never contacted again.

This matters for three reasons:

- **Serverless works at all.** Holding a live Playwright page across requests is
  impossible on Vercel/Lambda: the instance that handles *regenerate* is a
  different frozen instance from the one that captured.
- **No zombie browsers.** Nothing holds a Chromium process during the minutes a
  person spends thinking.
- **Recoverable.** A browser crash costs a re-render, not the session.

```
src/
├── core/                      ← pure, browser-free, unit-testable
│   ├── url-validator/         syntax, host policy, DNS resolve + pin
│   ├── ad-detector/           weighted noise scorer + ad-network domains
│   ├── dom-analyzer/          content scorer, content spine, classifier
│   ├── pagination-engine/     A4 geometry + the break planner
│   ├── session-manager/       action log, undo/redo, in-memory store
│   └── convert-service.ts     orchestration, concurrency, deadlines
│
├── browser/                   ← everything that needs Chromium
│   ├── browser-service/       lifecycle, context isolation, DNS pinning
│   ├── page-loader/           navigation, stabilisation, lazy scrolling
│   ├── snapshot/              fact extraction, id assignment, serialization
│   ├── print-layout-engine/   the controlled print stylesheet
│   └── pdf-generator/         measure → plan → apply → page.pdf()
│
├── app/                       Next.js App Router pages and API routes
└── components/                editor, previews, settings
```

Every hard algorithm lives in `core/` as a pure function over plain data.
`browser/` only converts DOM into plain data and applies plain data back to the
DOM. So ad scoring, break planning, the action log and the SSRF rules all
unit-test from JSON fixtures **without launching a browser**.

### Two ideas worth knowing

**Pagination is measured, not delegated.** With `@page { margin: 0 }` and a
single flat flow, page boundary *k* sits at exactly `k × contentHeight`. The
planner measures every block, finds those straddling a boundary, and injects
spacer divs to push them forward. It uses spacers rather than `break-before`
because `break-before` hands control to Chromium's fragmenter, whose extra
breaks the model cannot see. CSS `break-inside: avoid` remains as a safety net
beneath the measurement pass.

Termination is guaranteed by three rules: pushes only ever move blocks
*forward*; each block is pushed at most once per run; and there are iteration
and wall-clock caps. On exhaustion it accepts the current layout — safe, because
a push only ever adds whitespace, so nothing can be clipped by giving up.

**Cleaning is a two-dimensional decision.** Noise and content signals correlate
exactly where the call is hard (a sponsored block, a cookie banner full of legal
prose). Collapsing them into one number by subtraction throws away the
information needed to tell "both low" (uncertain) from "both high" (contested).

|                | content low | content high              |
| -------------- | ----------- | ------------------------- |
| **noise high** | remove      | contested → keep and flag |
| **noise low**  | keep        | keep (protected)          |

A "content spine" — the deepest common ancestor of all substantial prose, plus
its ancestors — is hard-protected, so a blank PDF is structurally near
impossible. Keyword weight is capped strictly below the removal threshold, so a
keyword can **never** remove anything on its own.

---

## Local setup

Requires **Node.js 20.9+** (developed on 24).

```bash
npm install
npx playwright install chromium
cp .env.example .env.local     # optional; every value has a safe default
npm run dev                    # http://localhost:3000
```

`npm install` runs postinstall scripts for `esbuild` (needed by Vitest). If your
npm blocks them, approve with `npm approve-scripts esbuild`.

---

## Commands

| Command             | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `npm run dev`       | Development server                                    |
| `npm run build`     | Production build                                      |
| `npm run start`     | Serve the production build                            |
| `npm run typecheck` | `tsc --noEmit`, strict mode                           |
| `npm run lint`      | ESLint                                                |
| `npm test`          | Unit tests (Vitest) — no browser needed               |
| `npm run test:e2e`  | Integration + end-to-end tests (real Chromium)        |

Run one suite at a time:

```bash
npx playwright test --project=pipeline   # pipeline against fixture pages
npx playwright test --project=e2e        # the real UI in a browser
```

The `e2e` project starts the production server itself, so run `npm run build`
first.

### Test coverage

- **118 unit tests** — SSRF/IP rules, ad and popup scoring, content spine,
  pagination planning and termination, action-log undo/redo, sanitization.
- **11 integration tests** — real Chromium against the fixture corpus (article
  with ads/popups/sticky/table/code, pagination hazards, lazy content):
  cleaning, lazy loading, PDF validity, A4 geometry, manual edits.
- **3 end-to-end tests** — the actual UI: convert, select, remove, undo,
  regenerate, download; plus error handling and URL rejection.

---

## Environment variables

See `.env.example` for the annotated list. All have safe defaults.

| Variable                 | Default   | Purpose                                  |
| ------------------------ | --------- | ---------------------------------------- |
| `BROWSER_MODE`           | `auto`    | `local`, `serverless`, or auto-detect    |
| `MAX_PROCESSING_TIME_MS` | `120000`  | Whole-conversion budget                  |
| `BROWSER_TIMEOUT_MS`     | `45000`   | Navigation timeout                       |
| `PDF_TIMEOUT_MS`         | `60000`   | PDF render timeout                       |
| `MAX_PAGE_HEIGHT_PX`     | `80000`   | Guards infinite scroll                   |
| `MAX_SCROLL_ITERATIONS`  | `40`      | Lazy-load scroll cap                     |
| `MAX_PAGE_SIZE_BYTES`    | `12582912`| Snapshot size cap                        |
| `MAX_CONCURRENT_JOBS`    | `2`       | Simultaneous browser jobs                |
| `SESSION_TTL_MS`         | `1800000` | Session lifetime (30 min)                |

`ALLOW_PRIVATE_TARGETS` exists for the test suite only. It disables the
private-address SSRF policy so tests can reach a loopback fixture server.
**Never set it in production.**

---

## Deployment

### Vercel (primary)

```bash
npm i -g vercel
vercel deploy --prod
```

`vercel.json` sets `maxDuration: 300` on the browser routes. `next.config.ts`
declares `serverExternalPackages` and `outputFileTracingIncludes` so the
Chromium payload is traced into the function bundle.

Verified against current Vercel documentation (September 2026):

- **Max duration is 300 s by default on every plan** with fluid compute, up to
  800 s on Pro. Older guides citing 10 s/60 s are out of date.
- **Bundle limit is 250 MB**, but **Large Functions** (beta) allow up to 5 GB.
  `@sparticuz/chromium` is ~130 MB uncompressed, so it fits either way; new
  projects are eligible for large functions by default. For existing projects
  set `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`.
- **Response bodies are capped at 4.5 MB**, which is why `/pdf` streams its
  response rather than buffering — streaming is not subject to the cap.

Set on the project:

```
BROWSER_MODE=serverless
```

If the bundle exceeds your plan's limit, switch to `@sparticuz/chromium-min`
and host `chromium-pack.tar` yourself, then set `CHROMIUM_REMOTE_PACK_URL`.

**Honest limitations of the Vercel path:**

1. **Sessions are per-instance.** The store is an in-memory `Map`. A request
   routed to a different instance will not find the session, and the user must
   convert again. Fixing this properly means moving snapshots to shared storage
   (Redis/S3), which the "no database" constraint excludes at this stage.
2. **Every regeneration pays a cold Chromium launch** (~1–3 s) unless the
   instance is warm, so the edit loop is slower than on a long-lived server.
3. **This path was not executed from the development machine.** The
   `@sparticuz/chromium` binary is Linux-only, so a Windows host cannot run it.
   The serverless code is written against the current documented APIs and is
   verified by configuration and type-checking, not by a local run. The
   `local` path is fully exercised by the test suites.

### Docker (recommended for heavy use)

```bash
docker build -t web2pdf .
docker run -p 3000:3000 --memory=2g web2pdf
```

Keeps a warm browser between requests, so regeneration is fast and sessions
behave predictably. Suits Fly.io, Railway, Cloud Run, or any VM. Give it at
least 2 GB for `MAX_CONCURRENT_JOBS=2`.

---

## Security

- **SSRF.** Blocks loopback, RFC1918, link-local (including the
  `169.254.169.254` cloud metadata endpoint), CGNAT, multicast, reserved space,
  IPv4-mapped IPv6, obfuscated numeric hosts (`http://2130706433`), internal
  TLDs and embedded credentials. Only `http`/`https` are allowed.
- **DNS rebinding.** The hostname is resolved once and every returned address
  validated; the address Chromium *actually connected to* is then checked
  against that set, closing the gap between validation and fetch.
- **Redirects** are re-validated on every navigation.
- **Untrusted content.** The preview iframe is sandboxed **without**
  `allow-scripts`, so source-page JavaScript can never run. HTML is sanitized
  server-side, and a `script-src 'none'` CSP is a third layer.
- **Errors.** Users see one of a fixed set of plain messages. Stack traces,
  paths and library errors stay in the server logs.

---

## Known limitations

- Closed shadow roots and cross-origin iframe content cannot be captured.
- Sites behind paywalls, logins or aggressive bot protection will fail; the
  error says so rather than producing a broken document.
- Infinite-scroll pages are captured up to `MAX_PAGE_HEIGHT_PX`.
- Video becomes a poster image; interactive content is frozen at its visible
  state (as §22 of the spec requires).
- Sessions are in-memory and per-instance — see the Vercel notes above.
- A block genuinely taller than one page and not scalable (a very tall
  infographic) will span pages; the planner prefers scaling but refuses to
  shrink below 70%, where text stops being readable.

---

## Next improvements

1. **Shared session storage** (Redis or object storage) to make the Vercel path
   robust across instances.
2. **Streaming progress** via SSE, replacing the current time-based stage
   estimates with real server events.
3. **Landscape and per-element page breaks** — the geometry module already
   supports the parameters.
4. **Visual regression tests** on rendered PDF pages, to catch layout drift
   automatically.
5. **Deliberate slicing for oversized images**, cutting at a low-variance pixel
   row instead of scaling them down.

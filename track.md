# Web2PDF — Implementation Tracking

**Status: complete.** 132 tests passing (118 unit · 11 integration · 3 e2e),
typecheck clean, lint clean, production build succeeds, verified end-to-end
against both local fixtures and live public websites.

---

## Phase 1 — Project scaffold `[x]`
- [x] Next.js 16.3.4, React 19.2.8, Playwright 1.63.0, Tailwind 4.3.3, pdfjs-dist 6.3.289
- [x] Chromium 153.0.8010.12 installed
- [x] TS strict + `noUncheckedIndexedAccess`; ESLint flat config; Vitest
- [x] `next.config.ts` — `serverExternalPackages`, `outputFileTracingIncludes`
- [x] `lib/config.ts` (env parsing + clamping), `lib/logger.ts` (structured JSON),
      `lib/errors.ts` (error taxonomy; internals never reach the client)

## Phase 2 — URL validation & SSRF `[x]`
- [x] `core/url-validator/ip-rules.ts` — IPv4/IPv6 classification, pure, table-driven
- [x] `core/url-validator/index.ts` — syntax, host policy, DNS resolve + pin
- [x] 40 unit tests
- **Bug found & fixed:** JS bitwise `&` returns a *signed* int, so `172.16/12`,
  `169.254/16` and `224/4` compared as negative against unsigned bases and were
  NOT blocked. Added `>>> 0`. This had left the cloud metadata endpoint
  reachable — the single most serious defect found in the build.

## Phase 3 — Browser service `[x]`
- [x] Local + Serverless implementations behind one interface
- [x] Context-per-job isolation; always closed in `finally` (no zombies)
- [x] Serverless mode fails fast on non-Linux with an actionable message
- **Bug found & fixed:** DNS pinning used the `--host-resolver-rules` *launch*
  flag, which is browser-wide. A warm reused browser kept the first request's
  `MAP host→ip` rule, so a later request for a different host failed with
  `ERR_NAME_NOT_RESOLVED` — or worse, could resolve to the earlier host's pinned
  IP. Replaced with a per-context check of the address Chromium actually
  connected to (`response.serverAddr()`).
- **Bug found & fixed:** that check compared IPv6 addresses as raw strings, but
  Node reports compressed form (`2606:4700:10::6814:179a`) and Chromium may
  report expanded. Identical addresses mismatched and every IPv6 connection was
  torn down. Addresses are now normalized before comparison.

## Phase 4 — Page loader & lazy content `[x]`
- [x] Navigate, network settle, progressive scroll, image/font waits
- [x] Redirect re-validation per navigation; blocked resource types; dialog dismissal
- [x] Verified: JS executes, delayed content captured, scroll appends content

## Phase 5 — Cleaning: ad/popup/noise detection `[x]`
- [x] Weighted noise scorer + ad-network domains + content-embed allowlist
- [x] Content scorer, content spine, 2-D classifier with up/down propagation
- [x] Verified: keyword stuffing alone stays below threshold (§9 by construction)
- [x] Verified: YouTube/CodePen embeds are never treated as ads (§10)

## Phase 6 — Snapshot capture `[x]`
- [x] Id assignment + NodeFacts extraction; CSS pruning; image inlining;
      canvas/video freezing; srcset collapsing
- [x] Verified: scripts stripped, ids present in served markup

## Phase 7 — Print layout engine `[x]`
- [x] Controlled print stylesheet; standalone print document builder
- **Bug found & fixed:** a blanket `height: auto !important` on block containers
  collapsed every CSS-sized element (fillers 640px→44px, images→0px), cutting
  document height from 6859px to 1165px and silently dropping content from the
  PDF. Now only `max-height`/`overflow` are reset.

## Phase 8 — Pagination engine `[x]`
- [x] True A4 geometry, margin presets, header/footer bands
- [x] Measurement-based fixpoint planner with three termination guards
- [x] Verified: no atomic block straddles a boundary; headings not orphaned;
      terminates on adversarial input; respects the wall-clock budget

## Phase 9 — PDF generator `[x]`
- [x] measure → plan → apply fixpoint, then `page.pdf()` with `preferCSSPageSize`
- [x] Header/footer templates (page numbers, source URL, date)
- **Bug found & fixed:** page count was estimated from document height and drifted
  badly (reported 35 for a 27-page document). Now read from the PDF itself.
  First attempt read a `/Count` entry, but Chromium emits a multi-level page tree
  with several `/Count` values (8, 8, 8, 3, 27) — the regex matched the first.
  Counting leaf `/Type /Page` objects is unambiguous.

## Phase 10 — API routes `[x]`
- [x] `POST /api/convert`, `GET /api/session/:id`, `POST …/action`,
      `POST …/regenerate`, `GET …/pdf` (streamed), `GET …/preview` (sandboxed)
- [x] Orchestration in `core/convert-service.ts`, not in route handlers

## Phase 11 — UI `[x]`
- [x] URL screen with staged progress; split editor (clean page + real PDF)
- [x] Element selection with contextual Remove/Hide/Restore/Cancel
- [x] Toolbar: undo, redo, restore all, regenerate, zoom, A4 page indicator,
      settings, download; mobile tabs; keyboard shortcuts
- [x] pdf.js preview of the actual generated PDF
- **Bug found & fixed:** the preview `revision` was the action-log cursor, which
  *repeats* across different document states (remove then undo returns it to a
  prior value). The iframe URL therefore did not change and the stale document
  stayed on screen. Revision is now a hash of the derived element states.
- **Bug found & fixed:** the preview hid removed elements with `display: none`
  while the PDF detached them — precisely the "fake overlay that merely covers
  content" §12 forbids, and it made the two views disagree. The preview now
  strips the nodes.

## Phase 12 — Tests & fixtures `[x]`
- [x] Fixture corpus + HTTP server: article (ads/popups/sticky/table/code/figure),
      pagination hazards, lazy/dynamic content
- [x] 118 unit · 11 integration · 3 end-to-end, all passing

## Phase 13 — Docs & deployment `[x]`
- [x] `README.md`, `.env.example`, `vercel.json`, `Dockerfile`, `.dockerignore`
- [x] Vercel constraints verified against current official docs

---

## Live verification (not just fixtures)

| Target | Result |
| --- | --- |
| `https://example.com/` | 1 page, exact A4 (595×842 pt), links preserved |
| `https://en.wikipedia.org/wiki/PDF` | **27 pages**, 5248 elements, **8 ads removed**, 0.73 MB, clickable links, embedded fonts |
| Three sequential different-host conversions | all succeed (the DNS-pinning regression) |

## Not done, deliberately
- Shared session storage (excluded by the "no database" constraint) — the
  per-instance limitation is documented in the README.
- The serverless Chromium path could not be *executed* here: the
  `@sparticuz/chromium` binary is Linux-only and this is a Windows host. It is
  written against current documented APIs and verified by configuration and
  type-checking, not by a local run. Stated plainly in the README.

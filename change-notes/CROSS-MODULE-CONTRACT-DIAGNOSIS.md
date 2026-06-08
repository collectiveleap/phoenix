# Phoenix: cross-module URL contract — web-ui fetch URLs must match resource mounts

## Headline

The generated app **boots and both halves work in isolation, but the UI can't reach the backend** because
the web-ui module fetches a URL no resource module serves. The opus-generated Web Experience page
`fetch`es **`/operations`**, but the store resource is mounted at **`/bramble-store`** — so every UI call
404s. The append-only store works perfectly when called at its real path (verified, persists across
restart); the UI just calls the wrong URL.

Phoenix already has machinery meant to prevent exactly this — the **interface registry** (`542ab61`,
*cross-IU contract consistency*) and `ada916f` (*web UI module now calls sibling API endpoints*) — but it
produced a mismatch here: the web-ui invented `/operations` (from the spec's "operation log" language)
instead of the resource's actual registered mount + route.

## Evidence

Wiring (`src/server.ts`):
```js
mount('/bramble-store', bramble_store);   // resource mounts under /bramble-store
mount('', web_experience);                // web-ui at root
```
Store routes (`src/generated/bramble-store/bramble-store.ts`): `router.get('/')` + `router.post('/')`
⇒ real endpoints **`GET /bramble-store`** (list ops) and **`POST /bramble-store`** (append op).

Web-ui page (`src/generated/web-experience/web-experience.ts`): `fetch('/operations')`.

Runtime proof (server booted on :3009):
- `GET /operations` → **404** (what the page calls)
- `GET /bramble-store` → `[]`; `POST /bramble-store` → `{"seq":1,…}`; `GET /bramble-store` → `[op]`;
  **after restart** → `[op]` (the store + SQLite persistence are fully functional)
- ⇒ the *only* defect is the URL the page uses: page → `/operations`, store → `/bramble-store`.

Note the deeper divergence: the spec names the resource conceptually ("operations" log), but Phoenix
mounts the module by its **module name** (`/bramble-store`). The web-ui followed the spec's noun; the
mount followed the module name. The two naming conventions diverged with nothing reconciling them.

## Outcomes & evidence of success (Phoenix POV)

### C1. The web-ui module fetches resource modules' actual registered endpoints — never invented URLs.
**Outcome:** every `fetch()` URL the web-ui module emits resolves to a real route on a sibling module, at
that sibling's registered mount path.
**Evidence:** in the generated app, no UI fetch 404s; the page can list and append against the store. A
static check finds every web-ui fetch URL among the registered routes.

### C2. The interface registry is authoritative and injected into web-ui generation.
**Outcome:** the web-ui generation prompt includes each sibling resource's **base mount path + routes**
(e.g. "operations: `GET /bramble-store` list, `POST /bramble-store` append"), and the generated fetch
URLs match exactly.
**Evidence:** the web-ui module's fetch URLs are byte-identical to the registry's paths; changing a
resource's mount path changes the web-ui's fetch URL in lockstep on regeneration.

### C3. A cross-module URL mismatch is caught at the gate, not shipped.
**Outcome:** if a web-ui module fetches a path no sibling serves, the acceptance gate (or a contract
check) **fails** with a clear message, instead of shipping a silently-broken UI.
**Evidence:** the Bramble case (`fetch('/operations')` with no `/operations` route) reports a failure like
*"web-experience fetches /operations — no module serves it"*, not `✔ verified`. (Compounds with
`STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md`: "verified" must mean the app actually works end-to-end.)

### C4. (Headline) The generated app's UI actually talks to its backend.
**Outcome:** the running app round-trips an operation from the page through the resource module and
persists it — no manual URL fix.
**Evidence:** in the booted app, typing in the outliner appends an op (visible in `GET /bramble-store`),
and a reload replays the log — all via the page's own fetches, unmodified.

## Fix locus (for the implementer)

- **Inject real mount+route paths into web-ui generation (C2):** the registry knows each resource's mount
  path and routes; the web-ui prompt must carry them so the model fetches the registered URL, not a noun
  from the spec. (`542ab61`/`ada916f` are the right place; they under-specified the *path*.)
- **Reconcile resource naming vs mount path:** either mount a resource at a spec-derived, predictable path,
  or make the web-ui consume the registry's mount path verbatim — but the two must not diverge.
- **Contract check at acceptance (C3):** statically verify every web-ui fetch URL against the route table;
  fail the run on any unmatched URL.

## Provenance

The final gap in standing up "Bramble": after the large web-ui module finally generated (opus, real
512-line SPA) and the app booted with a working, persistent SQLite store, the UI still 404'd because it
fetched `/operations` while the store mounted at `/bramble-store`. Both halves verified working in
isolation. See `OPUS-WEBUI-GENERATION-DIAGNOSIS.md` (how the module got generated) and
`STUB-FALLBACK-ACCEPTANCE-DIAGNOSIS.md` (why "verified" must require a working end-to-end app).

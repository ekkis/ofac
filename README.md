# OFAC

Local OFAC search and append-only recording primitives. This is **not a compliance programme**. The caller owns reviews, dispositions, reporting, and the five programme components: management commitment, risk assessment, internal controls, testing, and training. A programme does not eliminate strict liability; its quality can affect penalty mitigation.

## Compliance records and data protection

Every audit record stores the complete search inputs as supplied and as normalised. These values can include individual names and IDs: the audit is a compliance record that must prove what was searched and support later re-screening. The module retains only recognised search fields (`search_type`, `name`, `firstName`, `lastName`, `id`, `id_type`, `country`, `purpose`, `lists`, `threshold`), not the caller's wider customer record. Unknown fields are ignored for matching and never copied into the audit. Recognised fields must have the documented scalar/array types; nested customer objects are not accepted as search inputs.

The caller must locate the audit file **outside the repository**, limit access to compliance reviewers, and enable encryption at rest where the deployment platform supports it. Access control, encryption and backups are the caller's deployment responsibilities. The module guarantees an append-only, exportable record and fails the search if that record cannot be written. Retention is not shortened for privacy reasons; the 10-year baseline below applies.

Do not write credentials or private customer data into source files, test fixtures or incidental logs. New fixtures use invented names and IDs only; existing legacy fixtures and assertions remain unchanged. The module emits no query logs. Store reviewer identities and rationale only in the protected compliance record; opaque reviewer IDs are recommended.

## Install and configure

```sh
npm install ofac
```

CommonJS `require('ofac')` and default ESM import are supported. Node.js 12 or newer is required. The exported module is a singleton: configure it before concurrent searches, and do not change configuration while calls are pending.

```js
const ofac = require('ofac');
await ofac.init({
  path: '/var/lib/my-app/ofac-cache',
  auditPath: '/var/lib/my-app/private/ofac-audit.jsonl',
  lists: 'consolidated',
  refreshInterval: 24 * 60 * 60 * 1000,
  threshold: 1
});
const hits = await ofac.screenOnboarding({ name: 'Fictional Orchid Works' });
// Pass potential matches to the caller's review workflow.
```

Create and protect the audit directory beforehand. `auditPath` must be absolute; there is no unaudited mode. A missing path, append error, short write, or sync error rejects the search, including searches returning no hits. Audit persistence uses append, mode 0600 for new files, and fsync before returning results. Existing file permissions remain the operator's responsibility. This is an ordinary exportable JSONL file, not a tamper-proof ledger. Use a single writer process for disposition decisions; cross-process state transition locking is not provided.

### `config(options)`, `init(options)`, `refresh()`, `listInfo()`

`config` merges options. `init` loads every selected list and resolves to an XML filename, preserving the old return type. New snapshots become active only after all selected lists parse successfully. `refresh()` forces a download/reload and restores the previous `force` setting afterward. Download, HTTP, parse, and required-list errors propagate; they never silently fall back to SDN-only or stale data.

| Option | Default | Meaning |
| --- | --- | --- |
| `lists` | `['sdn', 'non-sdn']` | String or array; `consolidated` expands to both. |
| `path` | `/tmp` | Download cache directory; choose durable storage for deployed use. |
| `auditPath` | none; required for search | Absolute append-only JSONL filename outside the repository; directory must exist. |
| `refreshInterval` | `86400000` | Cache age in milliseconds. Check on each search; `0` refreshes every time. `false` explicitly opts into download-once. |
| `force` | `false` | Force fetching when initialising/searching. Prefer `refresh()` for one forced update. |
| `threshold` | `1` | Inclusive name similarity cutoff, from 0 to 1. Exact normalised names always score 1. |
| `fetch` | existing `node-fetch` dependency | Injectable HTTP implementation; response body is a Node stream. |
| `sources` | official URLs | Per-list `{url}` overrides or `{file}` for caller-managed legacy XML snapshots. |
| `xml` | `sdn.xml` | Legacy ZIP helper's extraction member. |

`sdn` downloads `https://sanctionslistservice.ofac.treas.gov/api/download/sdn.xml`; `non-sdn` downloads `https://sanctionslistservice.ofac.treas.gov/api/download/consolidated.xml`. OFAC's own “Consolidated” download is **non-SDN only**, so this module's `consolidated` selection deliberately combines both downloads. The non-SDN file includes SSI, FSE and other lists OFAC includes in that publication; `programList` preserves programme tags. Selection is per published file, not per individual programme. See [OFAC's list service](https://ofac.treasury.gov/sanctions-list-service) and [non-SDN consolidated list](https://ofac.treasury.gov/consolidated-sanctions-list-non-sdn-lists).

Freshness is elapsed time since the cache file's modification time, not a guarantee that OFAC has issued no newer publication. There is no background timer or scheduler. After the interval expires the next search refreshes before matching. `refreshInterval: false` is the explicit legacy download-once option. For `{file}` sources, refresh re-reads the file; the caller must replace it with a current snapshot. Unsupported/advanced XML schemas reject rather than produce empty matches.

`listInfo()` returns copies of `{list, version, publicationDate, loadedAt, file}` for the loaded snapshot. Version is `sha256:` plus the hash of the actual XML bytes, **not** an OFAC revision number. `publicationDate` is OFAC's `Publish_Date` verbatim (or null if absent); `loadedAt` is a UTC load timestamp. Audit timestamps are UTC ISO 8601. Hashes distinguish changed files even if publication dates are identical. `dbinfo()` retains the legacy `Publish Date` and `Record Count` keys and now resolves at EOF rather than timing out.

## Search API and matching

### `search(cust, [filename])`

The existing signature and array of full XML-derived records remain. Optional fields:

```js
{
  search_type: 'entity',
  name: 'Fictional Orchid Works', // or firstName / lastName
  id: 'FICTION-123', id_type: 'Test Document', country: 'Exampleland',
  lists: ['sdn', 'non-sdn'], threshold: 0.95,
  purpose: 'onboarding' // screening (default), onboarding, or transaction
}
```

`individual` selects only Individual entries. `entity` selects **every non-Individual type**, including corporations/organisations (Entity), vessels, aircraft and future non-Individual types. Omitted `search_type` unifies all types, as required by the integration brief; previously it selected individuals. Other values select that exact OFAC type case-insensitively (`vessel`, `aircraft`, etc.). Unknown values produce no hits. `screenOnboarding` always selects `entity`. Pass `search_type: 'individual'` explicitly where individual-only scope matters.

Matching preserves the individual ID-first sequence: case-insensitive exact `idNumber`, additionally constrained by country and ID type **only when both query and record provide them**. Country is not required in the existing code, despite the old README saying otherwise. An ID hit scores 1 and returns immediately; otherwise names and then all aliases are considered. A mismatching ID does not veto a matching name. Country is not a name filter.

Names are lowercased and each JavaScript `\W` character is replaced by one space on both query and record. Whitespace is neither collapsed nor trimmed; underscores remain. This preserves the existing query sanitisation but also applies it to record names and entity aliases. It is ASCII-oriented: there is no transliteration or Unicode-aware name segmentation. `name` compares the joined first/last name; entity `lastName` compares the legal name or alias. Individual primary names compare supplied components that exist on the record. Legacy individual aliases require both components, filling missing alias components from the primary name. The legacy primary-name comparison can admit a hit when a queried component is absent on the record; this behaviour is preserved, and an empty `matchedFields` flags the case. The caller must review such hits.

For each compared name component, score is `1 - LevenshteinDistance / max(lengths)`. The candidate score is the lowest component score; the highest qualifying candidate is returned. Default `1` means exact-after-normalisation only. Lowering the threshold admits more variation; raising it rejects more near-misses. There are no phonetic or token-reordering heuristics. Threshold affects names only; IDs remain exact. Alias matching includes weak as well as strong aliases.

Each hit exposes `matchScore`, `matchedFields` (XML field paths), `list`, `listVersion`, `listDate`, `auditId`, `purpose`, and `disposition`. Raw XML-derived fields contain the matched name, aliases, IDs, addresses, programmes, and any other supplied fields so reviewers need no second search. To preserve existing whole-record equality assertions, new metadata is **non-enumerable**, directly readable, and included by `JSON.stringify` via `toJSON`. Spreading a hit or `Object.keys` only includes legacy fields; use direct access or JSON serialization for metadata. The result array also has a non-enumerable `auditId`, even when empty.

The optional `filename` searches that caller-owned snapshot only, records its SHA-256/date with list `external`, and bypasses managed list selection/refresh. This legacy escape hatch is not the managed consolidated onboarding workflow.

## Audit format and dispositions

A search appends one record before returning, including errors after query processing. Audit write failure rejects the call. Example (abbreviated hash):

```json
{
  "schemaVersion": 1,
  "id": "opaque-search-id",
  "kind": "search",
  "timestamp": "2026-10-31T12:00:00.000Z",
  "query": {
    "given": {"name": "Fictional-Orchid Works", "search_type": "entity"},
    "normalised": {"name": "fictional orchid works", "search_type": "entity"}
  },
  "purpose": "onboarding",
  "matching": {"threshold": 1},
  "requestedLists": ["sdn", "non-sdn"],
  "lists": [{"list": "sdn", "version": "sha256:...", "publicationDate": "10/30/2026", "loadedAt": "2026-10-31T12:00:00.000Z", "file": "/var/lib/my-app/ofac-cache/sdn.xml"}],
  "results": [{"uid": "fiction-1", "list": "sdn", "matchScore": 1, "matchedFields": ["lastName"], "disposition": {"state": "pending", "reviewer": null, "rationale": null}}],
  "disposition": {"state": "pending", "reviewer": null, "rationale": null}
}
```

Actual successful managed searches record every searched list in `lists`. A failure before loading has no completed list metadata and includes `error: {code: 'SCREEN_FAILED'}`; it must never be treated as a completed negative screen. The original and normalised recognised query fields are stored verbatim, including names and IDs when supplied. Results retain public list UIDs and matched field paths rather than duplicating full target records. `matching.threshold` records the effective cutoff, including a configured default. Failed input validation may leave empty query projections; error records must never be used as successful screening evidence.

`states` exposes `pending`, `cleared`, `escalated`, `refused`, `blocked`. Every new screen/hit starts pending. The caller can append a disposition using:

```js
ofac.setDisposition(hits.auditId, {
  state: 'refused', reviewer: 'reviewer-17', rationale: 'Confirmed match under review policy'
});
const exported = ofac.readAudit(); // alternatively read the JSONL file directly
```

Allowed transitions are pending → cleared/escalated/refused/blocked, then escalated → cleared/escalated/refused/blocked. Cleared/refused/blocked are final. Both reviewer and rationale are required. Refused requires onboarding; blocked requires transaction. Decisions apply to the whole screen; per-hit adjudication is a caller workflow. Disposition events reference `auditId`; original search records remain pending and unchanged. Read events in append order to obtain the latest decision. Calling `search` again produces a new pending decision, never reuses a prior clearance automatically.

### Retention

Records have **no expiry, deletion, rotation, auto-purge or size cap**. The compliance retention baseline is 10 years under 31 CFR 501.601, extended from five years effective March 12, 2025; blocked-property records may need retention beyond the initial screen date. The caller owns protected storage, backups and the appropriate retention start/end. See [OFAC's final recordkeeping rule](https://ofac.treasury.gov/media/934131/download?inline=). This module makes no claim that logging alone satisfies all recordkeeping duties.

## List updates and re-screening

```js
// Select the latest successful onboarding record per merchant in the caller's registry.
const saved = ofac.readAudit().filter(record =>
  record.kind === 'search' && !record.error && record.purpose === 'onboarding');
const reports = await ofac.rescreen(saved); // forces refresh first by default
for (const report of reports) {
  // report.results: all current hits; report.newMatches: only new (list, uid) pairs
  // All are pending, with report.auditId linking their new audit record.
}
```

On a list update, replace caller-managed XML files if used, call `refresh()`, then `rescreen(savedQueries, {refresh: false})`. Or use default `rescreen` to fetch first. Persist the current results as the next baseline and send newly appearing matches to review. Queries with no prior results treat every hit as new. Existing UID changes do not count as newly appearing hits. No background merchant registry or scheduler is included. The API accepts stored audit records directly, replays their original recognised inputs, and preserves the recorded list scope and effective threshold even if current defaults changed. Reports link the original record through `previousAuditId`. External-file audit records re-read the recorded source file. The alternative `{query, results}` input remains supported for callers with their own registry. Failed search records and historical redacted audit records reject explicitly; missing historical query values cannot be reconstructed.

## Onboarding and transaction workflows

`screenOnboarding(query)` forces `search_type: 'entity'` and `purpose: 'onboarding'`. A confirmed onboarding match means refuse the merchant. `screenTransaction(query)` sets `purpose: 'transaction'` and preserves the requested type (all types by default). A confirmed transaction match subject to blocking means block and report within 10 business days. These actions remain distinct; search hits are pending leads, and no search automatically refuses a merchant, moves funds, blocks property, or files a report. Non-SDN restrictions differ by programme; the caller determines applicable legal authority.

`blockingReportData(transactionHit)` immediately returns `{auditId, list, listVersion, listDate, target, matchedFields, matchScore, callerRequired}`. `target` contains the complete list record, including names, aliases, IDs, addresses/locations, programmes and remarks when supplied by OFAC. Missing fields remain missing; the module never invents report data. It rejects onboarding/general screening hits.

The caller must add holder name/address and contact name/phone/email; transaction type, parties, locations, references and dates; target interest/location or relevant OFAC direction; blocking date; property description/location and actual or estimated USD value; action taken; specific blocking authority; and supporting documents. These are described in [31 CFR 501.603](https://www.ecfr.gov/current/title-31/section-501.603). Do not pass wider report/customer objects to `search`; its audit retains only the recognised search inputs. Store the additional report data in the caller's protected compliance system. The caller owns the 10-business-day deadline and filing through [OFAC's Reporting System](https://ofac.treasury.gov/ofac-reporting-system); this helper is a data projection, not a completed report or deadline calculator.

## Legacy helpers and tests

`fn(url)` returns the cache path. `fetch(url)` downloads atomically, rejecting HTTP/stream errors; its freshness follows the configured interval. `zipExtract(archive, member, destination)` remains available for legacy ZIP callers. Normal initialisation now downloads the two legacy-schema XML files directly and caches parsed snapshots in memory rather than scanning line by line for each query.

```sh
npm test
```

The original Mocha assertions are unchanged. A test-only preload explicitly selects the offline SDN fixture, download-once mode, and an isolated audit path. New tests use invented entities/individuals in temporary files and simulated downloads; they cover the additive API without live network access. No new dependencies. MIT licence.

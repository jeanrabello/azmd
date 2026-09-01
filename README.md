# azmd

A menu bar app (macOS) / system tray app (Windows) that monitors Azure Logic Apps runs, delivers native failure notifications, and opens the run in the portal with one click.

## Running

```bash
nvm use          # Node 24 (see .nvmrc)
npm install
npm run dev
```

The app starts **in demo mode**, with mocked data. It lives in the menu bar / system tray, not in the Dock or taskbar.

| Command | What it does |
|---|---|
| `npm run dev` | Development with HMR in the renderer |
| `npm run build` | Typecheck + bundle main, preload and renderer |
| `npm test` | Test suite (vitest) |
| `npm run typecheck` | Type-checking only |
| `npm run pack:mac` | Builds .dmg/.zip into `release/` (ad-hoc signed — see Distribution) |
| `npm run pack:win` | Builds an NSIS x64 installer into `release/` |
| `npm run pack:all` | Builds installers for both macOS and Windows |

## Demo mode vs. Azure mode

The toggle lives in **⚙︎ → Data source**, and it's what lets you run and test the whole app without any credential at all.

- **Demo** (default) — `DemoAdapter` produces deterministic failed runs with the same shape Azure returns. A `DEMO` badge stays visible in the header at all times, so fake data is never mistaken for real data.
- **Azure** — queries the real ARM API. Authentication is configured in **Settings → Authentication**, with three modes: **My account** (device code sign-in in the browser — no App Registration, no Azure CLI, uses the Azure CLI's public client ID), **Service Principal** (tenant ID + client ID + client secret, encrypted at rest via `safeStorage`), or **Azure CLI** (reuses the machine's `az` session). Without a working credential the app shows an actionable error, not a blank screen.

The switch is total: demo mode never instantiates the Azure SDK, and nothing outside `AppController.#buildAdapters` knows two modes exist. Poller, dedupe, notifications, IPC and UI are identical in both cases — which is what guarantees that what you test in demo is the same code that runs in production.

## Navigation

The home screen lists **Logic Apps**, not runs — with dozens of workflows, a flat list of failures doesn't tell you where the problem is. Each row shows health (green/red), how many workflows are failing, the total count of failed runs, and when the last failure happened. Failing apps sort first, ignored ones last.

```
Logic Apps  →  app's workflows  →  failed runs  →  run detail
```

**Grouping.** Azure has no single "Logic App" concept that fits both flavors: in Standard the group is the App Service, and workflows live inside it; in Consumption each workflow is an independent resource with no parent, so those are grouped by **resource group**, which is how the portal organizes them and how environments are usually separated (prod, dev, finance).

**Choosing what to watch.** The eye icon on each row toggles monitoring, for a whole Logic App or a single workflow. Anything not watched doesn't notify, doesn't count toward totals, and **isn't queried** — the poller filters before the call goes out, so ignoring something actually saves ARM quota.

If enough apps get muted, a banner at the top of the list reports how many and offers **Unmute all** — without it, muting everything produced a screen identical to "found nothing," and re-enabling one by one wasn't practical.

Selection is *opt-out*: everything is monitored by default, and what's persisted is the list of what's been ignored. That's deliberate — a new Logic App appearing in Azure should be monitored without requiring action. The opposite would make the app silently stop warning about things that didn't exist when the selection was made, which is the worst way for a monitor to fail. Ignored items stay visible in the list (marked "Not monitored") so they can be re-enabled.

## Interaction

**Run listing** — clicking a row opens the detail screen. Opening in the portal became an explicit button (external-link icon, shown on hover), next to dismiss. That's a deliberate change: the error message in the list is truncated to one line, and sending the user to the browser just to read the reason was too roundabout.

**Details** — full error message (untruncated), error code, timestamps, duration, run name and correlation ID. When Azure returns a payload the normalization doesn't cover, a "View raw Azure response" link shows the raw JSON.

The screen also lists the **workflow's last 5 runs, successes and failures alike**. Successes are included on purpose: three failures in a row tells a different story than one failure between successes, and the main list doesn't show that. This data comes from what the poller already collected — opening the details doesn't trigger a new call to Azure.

## Architecture

```
src/
├─ shared/types.ts        # contracts between the three processes — source of truth
├─ main/
│  ├─ index.ts            # bootstrap, IPC, lifecycle
│  ├─ app-controller.ts   # owns app state; the demo/azure toggle lives here
│  ├─ poller.ts           # cursors, dedupe, per-workflow backoff
│  ├─ notifier.ts         # native notifications + aggregation
│  ├─ tray.ts             # template icon + anchored popover
│  ├─ portal-url.ts       # deep links (see Known caveats)
│  ├─ settings-store.ts   # preferences, sanitized at the boundary
│  ├─ safe-open.ts        # single choke point for opening external URLs (allowlist)
│  ├─ auth/               # credential chain, token cache, encrypted secret storage
│  └─ azure/
│     ├─ adapter.ts       # LogicAppAdapter interface
│     ├─ consumption.ts   # @azure/arm-logic
│     ├─ standard.ts      # @azure/arm-appservice
│     ├─ discovery.ts     # Resource Graph
│     ├─ discovered.ts    # real adapters + Resource Graph inventory
│     └─ demo.ts          # mocks
├─ preload/index.ts       # contextBridge, minimal contract
└─ renderer/              # React; knows nothing about Azure
```

The renderer never sees a credential, an SDK, or an unvalidated URL. It receives a ready-made `AppState` and returns intents (`openRunInPortal(runId)`), never actions.

## Security

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a restrictive CSP in the renderer. `shell.openExternal` only accepts URLs validated against an allowlist of portal hosts. Authentication secrets (Service Principal client secret, MSAL token cache) are encrypted at rest via Electron's `safeStorage`, which is backed by the OS keychain (Keychain on macOS, DPAPI on Windows).

## Validated against a real tenant

Tested on 2026-08-26 against a tenant with **33 Standard Logic Apps and 298 workflows**. Full discovery in ~18s; 76 failed runs found, all with a populated error message.

Three things only surfaced with real data and changed the code:

**1. Standard runs don't exist in ARM.** The `@azure/arm-appservice` SDK exposes `workflowRuns.list`, but `.../sites/{site}/workflows/{wf}/runs` returns 404. Run history sits behind the `hostruntime` proxy, which forwards to the App Service's own runtime:

```
.../sites/{site}/hostruntime/runtime/webhooks/workflow/api/management/workflows/{wf}/runs
```

`azure/standard.ts` was rewritten to talk HTTP directly to that endpoint. Before this, the adapter would have returned no runs at all.

**2. The workflow's `name` comes prefixed with the site.** ARM's listing returns `"la-trux/wf-PostPayment"`, while `id` uses the plain name (`.../workflows/wf-PostPayment`). Building a URL from `name` breaks; the runtime, on the other hand, already returns the clean name.

**3. The Standard deep link uses a different portal extension.** It's not the `#@tenant/resource{id}/runs` pattern originally assumed — it's the `WorkflowMenuBlade` from the `Microsoft_Azure_EMA` extension, with the resource ID URL-encoded as a single segment:

```
#view/Microsoft_Azure_EMA/WorkflowMenuBlade/~/runHistory
  /resourceId/{URL-encoded resourceId}
  /location/{display name, e.g. "Central US"}
  /isReadOnly~/false/kind/{Stateful|Stateless}/defaultBlade/designer/isCodeful~/false
```

Two details only a real URL revealed: `location` uses the **display name** ("Central US"), not the slug ARM returns ("centralus") — hence `azure/regions.ts`, generated from `az account list-locations`, because the mapping isn't derivable (an algorithmic attempt only got 50 of 109 regions right). And `kind` (Stateful/Stateless) comes from the runtime, not from ARM.

The portal doesn't expose a per-run blade for Standard, so the link opens the **workflow's run history** — the run you're looking for is at the top. The button reads "Open history in portal," not "Open run."

On error messages: in the tested tenant, 69 of 76 failed runs carry the generic `ActionFailed — "An action failed. No dependent actions succeeded."` We confirmed that fetching the run's actions (`/runs/{id}/actions`) returns the same generic message, so the extra call wouldn't help. The raw payload is available via "View raw Azure response."

## Known caveats

**The specific-run deep link hasn't been validated against the portal.** Confirming it requires opening a real failed run in the portal, copying the URL, and comparing it against the derived template — that session wasn't available during testing. What exists today:

- The **run list** URL uses the stable, documented format — that part is reliable.
- The **specific-run** URL follows a format derived from the resource ID, and is isolated in two functions at the top of `portal-url.ts`, flagged with a `VALIDATE` comment. If the format turns out to be wrong, the fix is contained to those lines.
- There's a fallback: any failure while building the URL falls back to the workflow's run list, never a 404.

**Error-message extraction is the part most likely to need adjustment.** The SDK types `WorkflowRun.error` as `any`, and the shape varies in practice (flat, nested under `error.error`, with the reason only in `details[]`, or a bare string). `azure/run-error.ts` tries the known shapes in order and always keeps the raw payload — so even if normalization gets it wrong, "View raw Azure response" shows what actually came back. If a new shape shows up, that's where it gets added, and there are tests covering each case.

**The Consumption path is still unvalidated against real data.** The tested tenant only has Standard Logic Apps, so `consumption.ts` and the resource-group grouping have never been exercised against real data — they're covered only by types and tests so far.

## Distribution

```bash
npm run pack:mac        # produces release/azmd-0.1.0-arm64.dmg
cp -R release/mac-arm64/azmd.app /Applications/

npm run pack:win        # produces an NSIS installer in release/
```

Every push to `main` triggers the GitHub Actions workflow in `.github/workflows/release.yml`: it verifies the code (typecheck + tests), builds installers for macOS and Windows in a matrix, and publishes them as a GitHub Release. Grab the latest installers from **Releases** rather than building locally.

Neither build is signed with a paid certificate:

- **macOS** — the app is ad-hoc signed. Gatekeeper will complain on first launch; clear it with `xattr -cr /Applications/azmd.app`, or right-click → Open.
- **Windows** — SmartScreen will warn on first run since there's no code-signing certificate. Click **More info → Run anyway**.

**About the "Electron" name in Login Items (macOS).** Without a Developer ID certificate, electron-builder leaves the Electron binary's inherited signature in place — whose *identifier* is literally `Electron`. macOS reads that identifier when registering the login item, so the app used to show up under the wrong name even with a correct `CFBundleName`. `scripts/adhoc-sign.cjs` (run via `afterSign`) re-signs ad-hoc with the appId, so the registration comes out as `azmd`.

If you previously enabled "open at login" while running in dev mode, a stray **Electron** entry pointing at `node_modules/electron/dist/Electron.app` may remain. Remove it under System Settings → General → Login Items — macOS won't let one app delete another's entry.

**About PATH and the Azure CLI (macOS).** An app launched from the GUI doesn't inherit the shell's environment: macOS hands it only `/usr/bin:/bin:/usr/sbin:/sbin`. Since `az` lives in `/opt/homebrew/bin`, Azure CLI mode used to fail with "Azure CLI could not be found" — even after `az login`, and even though it worked fine when launched from a terminal. `auth/shell-path.ts` fixes the PATH at boot: it first tries known directories (cheap), and only falls back to a login shell if still not found. Tested with the real minimal PATH: it finds `/opt/homebrew/bin/az` without needing the shell fallback.

# chromium-tabs

Chrome's tab strip logic, ported from the Chromium C++ source to TypeScript, with React bindings.

This is not "a tabs component". It's the actual behavioral model Chrome uses (`TabStripModel`, `chrome/browser/ui/tabs/`), so you get the details users expect from a real browser for free:

- **Pinned tabs** locked to the left, with all of Chrome's index-clamping rules
- **Tab groups** with colors, titles, collapse, and contiguity enforcement
- **Opener tracking**: close a tab opened from another and activation jumps back the way Chrome's does (opened-children first, then siblings, then the opener)
- **Smart insertion**: link-style opens insert next to their opener; typed-style opens append and behave like Chrome's "quick look-up" tabs
- **Multi-select** with anchor/extend semantics (ctrl-click, shift-click)
- **Drag to reorder**, with group membership adjusting at boundaries the way Chrome's `MoveTabRelative` does
- **Stateful tabs without the memory bill**: background tabs keep their live component state like Chrome keeps background pages alive, and a port of Chrome's Memory Saver discards the least-recently-used tabs past a budget, reloading them on activation

The core is headless and framework-agnostic. The React layer is optional.

## Install

```sh
npm install chromium-tabs
```

## React quick start

```tsx
import { Tabs, useTabStripModel } from 'chromium-tabs'
import 'chromium-tabs/styles.css'

interface Page {
  title: string
  url: string
}

function App() {
  const model = useTabStripModel<Page>((m) => {
    m.appendTab({ title: 'Home', url: '/' })
    m.appendTab({ title: 'Docs', url: '/docs' }, false)
  })

  return (
    <Tabs
      model={model}
      renderTab={(tab) => tab.data.title}
      onNewTab={() => model.addTab({ title: 'New tab', url: '/new' }, { cause: 'typed', flags: 1 })}
    >
      {(tab) => <PageView page={tab.data} />}
    </Tabs>
  )
}
```

`<Tabs>` is the strip plus the keep-alive content host wired together. Tab content stays mounted while in the background, so component state (filters, scroll, drafts) survives switching by construction. Need a custom layout (strip in a sidebar, panels elsewhere)? Compose `<TabStrip>` and `<TabPanels>` directly, but keep content inside `<TabPanels>` unless you specifically want state-losing remounts on every switch.

Interactions out of the box: click activates, ctrl/cmd-click multi-selects, shift-click extends, middle-click closes, drag reorders, arrow keys switch tabs, ctrl/cmd+arrows move the active tab (hopping group boundaries like Chrome).

## Stateful tab content (and keeping memory bounded)

`<TabPanels>` is the content host. Every tab's content stays mounted while hidden, so scroll positions, form drafts, and in-flight work all survive switching tabs, the same way Chrome keeps background pages alive:

```tsx
import { TabPanels, TabStrip, TabLifecycleManager, useTabVisibility, useTabStripModel } from 'chromium-tabs'
import { useEffect } from 'react'

function App() {
  const model = useTabStripModel<Page>(/* ... */)

  // Chrome's Memory Saver, ported: past 8 loaded tabs, the least recently
  // used tab's content is dropped. The tab stays in the strip and remounts
  // fresh when activated, exactly like Chrome's discard + reload-on-focus.
  useEffect(() => new TabLifecycleManager(model, { maxLoadedTabs: 8 }).start(), [model])

  return (
    <>
      <TabStrip model={model} renderTab={(tab) => tab.data.title} />
      <TabPanels model={model}>{(tab) => <PageView page={tab.data} />}</TabPanels>
    </>
  )
}

function PageView({ page }: { page: Page }) {
  // 'hidden' while the tab is in the background: pause polling, video, etc.
  const visibility = useTabVisibility()
  // ...
}
```

The discard policy is Chrome's, ported from `resource_coordinator` / `performance_manager`:

- the active tab and opted-out tabs (`tab.autoDiscardable = false`) are never discarded
- your app can veto per tab (`canDiscardTab`), the equivalent of Chrome protecting tabs that play audio or hold form input
- pinned and recently-active tabs (10 min, configurable) are protected: discarded only under `'urgent'` pressure, never proactively
- otherwise: least recently used goes first
- `onBeforeDiscard` lets you snapshot restorable state (scroll offset, draft text) into `tab.data` before the content unmounts

One policy with no Chrome equivalent, for apps whose tab content shares global state per content type (a singleton store per route/scene): `exclusiveContentKey: (tab) => string | null` keeps at most one loaded tab per distinct key. When two loaded tabs would share a key, the background one is discarded immediately and re-derives its state from its own `data` on the next activation, so shared state can never bleed between duplicates. Return `null` to exempt content that isolates correctly.

## Syncing with an external source of truth

If your app's canonical tab state lives elsewhere (a router, a store, another window), mirror it into the model with `reconcile` — minimal mutations, tab identity (and therefore mounted content and discard state) preserved:

```ts
model.reconcile(
  tabs.map((t) => ({ id: t.id, data: t, pinned: t.pinned })),
  { activeId: activeTabId, dataEquals: (a, b) => a.url === b.url },
)
```

Tabs absent from the list are removed (bypassing `canCloseTab` — the external state already decided), missing tabs are inserted at their position, data/pinned/order/activation converge. A second identical call fires no observer events, so it is safe to run on every store change. Reconcile-driven activations carry selection reason `'none'`, letting observers distinguish them from user gestures when writing model changes back to the store.

## Session persistence (restore after refresh or restart)

Opt-in port of Chrome's session restore (`components/sessions` + `chrome/browser/sessions`), shipped as a separate headless entry. Mutations stream into a command log; on the next load the log replays into the strip you had:

```ts
import { TabStripModel } from 'chromium-tabs/core'
import { SessionService, WebStorageBackend } from 'chromium-tabs/session'

const session = new SessionService<{ url: string }>({
  storage: new WebStorageBackend({ key: 'my-app' }),
})
const model = new TabStripModel<{ url: string }>()

const { restored } = await session.restoreInto(model)
if (!restored) model.appendTab({ url: 'https://example.com' }) // first run
// From here every insert/close/move/pin/group/activate is recorded.
```

Tab `data` is persisted automatically, so if your url lives there it round-trips with zero extra wiring. `data` must be JSON-serializable (or pass `serializeTabData`/`deserializeTabData`).

It works the way Chrome's does:

- **Command log, not snapshots.** Each mutation appends a `SessionCommand` (same command ids as `session_service_commands.cc`); buffered writes flush after 2.5s (`kSaveDelay`) and the log is rewritten from live state every 250 commands (`kWritesPerReset`). Replay is fault-tolerant: a torn or corrupt tail keeps everything before it.
- **Current/last rotation.** Constructing a `SessionService` promotes the previous run's log to the "last session" slot; `restoreInto`/`getLastSession` read it. A run that dies before its first save doesn't clobber the restorable session.
- **Restore order.** Tabs are recreated in visual order with pinned state, groups are re-formed with their title/color/collapse (ids relabeled, as Chrome does — you get a `groupIdMap`), then the selected tab activates. Pass `deferLoading: true` to restore background tabs discarded (Chrome's TabLoader behavior, pairs with `TabLifecycleManager`).
- **Teardown safety.** With a synchronous backend the service flushes on `pagehide`, so state written milliseconds before a refresh survives it.

Storage is pluggable via the `CommandStorageBackend` interface: `WebStorageBackend` (localStorage/sessionStorage), `InMemoryStorageBackend` (tests/SSR), or — for Electron/Node process restarts — `FileStorageBackend` from `chromium-tabs/session/node` (append-only JSONL, never bundled for the browser).

Per-tab navigation history is available too, driven by your app exactly like `SessionTabHelper` drives Chrome's service: `session.navigateTab(id, { url })`, `setSelectedNavigationIndex` for back/forward, forward-history pruning on branch, capped at 6 entries either side of current on rewrite (`gMaxPersistNavigationCount`). Multiple strips persist as multiple windows: `session.attach(model, { windowId: 'left' })`.

### Multiple browser tabs of the same app

Two browser tabs booting the same wiring are two JS realms over one storage key — the web's version of two Chrome processes sharing a profile directory, which Chrome forbids outright (`ProcessSingleton` is "named according to the user data directory, so we can be sure that no more than one copy of the application can be running at once"). This library ports that rule: a storage key is a profile, and exactly one realm owns it, coordinated through Web Locks (auto-released when the realm dies, like the OS reclaiming Chrome's `SingletonLock`).

The first realm to boot becomes the **owner**: it rotates, restores, and records. Realms that boot while the profile is owned become **secondaries**: they restore nothing (`restored: false`, `ownership: 'secondary'`), record nothing, and never touch the owner's log. There is no mid-life takeover — like Chrome, the claim happens at startup; once the owner is gone, the next realm to boot (including a refresh of a secondary) claims the profile and continues where it left off. Without Web Locks (SSR, Node, older browsers) a service is simply the sole owner, which is the single-realm behavior.

If you want every browser tab to persist its own strip, give each realm its own profile — the same move as running Chrome with separate `--user-data-dir`s:

```ts
let profile = sessionStorage.getItem('tabs-profile') // survives refresh, per browser tab
if (!profile) {
  profile = `my-app/${crypto.randomUUID()}`
  sessionStorage.setItem('tabs-profile', profile)
}
const session = new SessionService({ storage: new WebStorageBackend({ key: profile }) })
```

"Duplicate tab" copies sessionStorage, so the duplicate wakes up holding the same profile — the singleton resolves that too: the duplicate becomes a secondary of that profile instead of corrupting it. (Garbage-collecting profiles abandoned by closed tabs is the app's call; the library can't know a browser tab is gone for good.)

## Headless usage

```ts
import { TabStripModel, AddTabFlags } from 'chromium-tabs/core'

const model = new TabStripModel<string>()

// A tab opened from a link inserts next to its opener and inherits its group.
model.appendTab('docs.example.com')
const child = model.addTab('linked page', { cause: 'link', flags: AddTabFlags.ACTIVE })

// Closing it returns to the opener, exactly like Chrome.
model.closeTabAt(model.indexOfTab(child))

// Pinning moves the tab to the pinned block and unpins clamp moves around it.
model.setTabPinned(1, true)

// Groups stay contiguous; Chrome's exit rules apply when tabs leave.
const group = model.addToNewGroup([1, 2])
model.setGroupCollapsed(group, true)

model.addObserver({
  onTabStripModelChanged(change, selection) {
    // 'inserted' | 'removed' | 'moved' | 'replaced' | 'selectionOnly'
  },
})
```

## What's ported and from where

The port tracks Chromium `main` (see `PORTING_NOTES.md` for the algorithm-by-algorithm mapping with C++ line references):

| This package | Chromium |
|---|---|
| `TabStripModel` | `chrome/browser/ui/tabs/tab_strip_model.{h,cc}` |
| `ListSelectionModel` | `ui/base/models/list_selection_model.{h,cc}` |
| observer events | `chrome/browser/ui/tabs/tab_strip_model_observer.h` |
| `AddTabFlags` | `chrome/browser/ui/tabs/tab_enums.h` |
| `TabLifecycleManager` (discarding) | `chrome/browser/resource_coordinator/tab_lifecycle_unit.cc`, `chrome/browser/performance_manager/policies/discard_eligibility_policy.h` |
| `<TabPanels>` keep-alive + `useTabVisibility` | behavioral equivalent of Chrome keeping background pages alive + visibility signals |
| `SessionService` (session persistence) | `chrome/browser/sessions/session_service_base.{h,cc}`, `session_service.{h,cc}` |
| `SessionCommand` log + replay | `components/sessions/core/session_service_commands.cc` |
| `CommandStorageManager` + backends | `components/sessions/core/command_storage_manager.cc`, `command_storage_backend.cc` |
| `restoreSessionWindow` | `chrome/browser/sessions/session_restore.cc` |

Not ported: split tabs, async unload handlers (closes are synchronous; veto with `canCloseTab`).

## Development

```sh
bun install
bun run test        # vitest, 172 tests
bun run typecheck
bun run build       # tsup -> dist/
```

## License

BSD-3-Clause, matching the Chromium code this derives from.

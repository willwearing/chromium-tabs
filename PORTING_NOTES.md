# Porting Notes: Chromium TabStripModel → TypeScript

Source of truth: Chromium `main` @ 3dbd2135, sparse-checked-out in `chromium-reference/`.

## What was ported

| TypeScript | Chromium source |
|---|---|
| `src/core/list-selection-model.ts` | `ui/base/models/list_selection_model.{h,cc}` |
| `src/core/tab-strip-model.ts` | `chrome/browser/ui/tabs/tab_strip_model.{h,cc}` |
| `src/core/types.ts` (AddTabFlags, CloseFlags) | `chrome/browser/ui/tabs/tab_enums.h` |
| `src/core/observer.ts` | `chrome/browser/ui/tabs/tab_strip_model_observer.h` |
| `src/core/tab-lifecycle-manager.ts` | `chrome/browser/resource_coordinator/tab_manager.cc`, `chrome/browser/resource_coordinator/tab_lifecycle_unit.cc`, `chrome/browser/performance_manager/policies/discard_eligibility_policy.h`, `cannot_discard_reason.h` |
| `src/react/tab-panels.tsx` | behavioral equivalent of background WebContents + visibility signals (no direct C++ counterpart; see below) |

## Key algorithms cloned (with C++ line refs into chromium-reference/)

- **Pinned-boundary clamping**: `ConstrainInsertionIndex` / `ConstrainMoveIndex` (tab_strip_model.cc:3408-3417). Pinned tabs always occupy `[0, indexOfFirstNonPinnedTab)`.
- **Insertion position for link-opened tabs**: `DetermineInsertionIndex` (cc:5329-5368). Foreground link → `active+1`; background link → after last tab (transitively) opened by the active tab, stopping at a group discontinuity; otherwise append.
- **Which tab activates after close**: `DetermineNewSelectedIndex` (cc:5377-5481). Preference order: (1) next tab opened by the closing block, (2) next tab opened by the block's opener, (3) the opener itself, (4) right/left neighbor within the same group, (5) next non-collapsed tab, (6) after-block, else before-block. Index adjusted by `GetTabIndexAfterClosing` (cc:5241).
- **Opener inheritance**: `AddTab` (cc:1715-1828). LINK transitions inherit opener + group of active tab; TYPED at end-of-strip inherits opener with `resetOpenerOnActiveTabChange`. `OnActiveTabChanged` (cc:5255) forgets all openers on user-gesture switches outside the opener tree. `TabNavigating` (cc:1378) forgets openers unless tab is a new-tab at end of strip.
- **FixOpeners on move/close** (cc:5171): re-points children of a moving tab at its own opener; never self-opener.
- **Group contiguity on move**: `GetGroupToAssign` (cc:5195-5233). Moving into the middle of a group adopts that group; leaving a multi-tab group strands → clears group.
- **Insert clamping into groups**: `AddTab` (cc:1759-1777). Index clamped into the group's range; ungrouped insert between two tabs of the same group adopts the group; pinned tabs never grouped.
- **AddToNewGroup** (cc:4344): first valid destination at/after `indices[0]` that isn't pinned or mid-foreign-group; deselects non-active tabs added to the group.
- **AddToExistingGroup** (cc:4415): tabs left of group move to its start, right of group to its end (or all to end with `addToEnd`).
- **MoveTabRelative group hopping** (cc:3976): at a group boundary, membership toggles before position moves; collapsed neighbor groups are jumped wholesale.
- **SelectRelativeTab** (cc:3951): wraps modulo count, skips collapsed groups.
- **Selection model arithmetic**: `IncrementFrom` / `DecrementFrom` / `Move` (list_selection_model.cc:112-253) including the move-higher → move-lower remap.
- **MoveSelectedTabsTo two-chunk pinned/unpinned processing** (cc:1089-1115).
- **SetTabPinned** (cc:5052): pin → move to `indexOfFirstNonPinnedTab()`, unpin → move to boundary-1.

## Lifecycle: stateful tabs with bounded memory (Memory Saver port)

Chrome keeps background tabs' pages alive (state survives switching) and
reclaims memory by discarding the least important tabs, which then reload on
focus. The mapping:

| Chrome mechanism | This library |
|---|---|
| Background tab's renderer stays alive, hidden | `<TabPanels>` keeps every non-discarded tab's React tree mounted, hidden via CSS, keyed by tab id (reorder never remounts) |
| Page visibility (WasShown/WasHidden), freezing | `useTabVisibility()` returns 'visible' \| 'hidden' so content pauses its own work |
| `TabLifecycleUnit::Discard` / `FinishDiscard` (tab_lifecycle_unit.cc:346,250): swap in a rendererless shell, keep title/history | `model.discardTabAt(i)`: flag the tab, `TabPanels` unmounts its tree; `tab.data` (the "navigation history") survives |
| Reload on focus (`SetFocused` → `MaybeLoad`, tab_lifecycle_unit.cc:135-182) | activating a discarded tab clears the flag; panel remounts fresh |
| `last_focused_time_` = `Time::Max()` while focused (tab_lifecycle_unit.cc:142) | `tab.lastActiveAt` = `Infinity` while active, timestamp on blur |
| `CanDiscardResult` eligible/protected/disallowed + `CannotDiscardReason` | `TabLifecycleManager.canDiscard(tab)` same tri-state; active/opted-out/app-veto = disallowed, pinned/recently-active = protected |
| Importance sort `PageNodeSortProxy::operator<` (discard_eligibility_policy.h:95): disallowed > focused > visible > protected > recent | `getDiscardCandidates()`: eligible LRU first, then protected LRU, disallowed never |
| `kNonVisiblePagesUrgentProtectionTime` = 10 min (discard_eligibility_policy.h:38) | `recentlyActiveProtectionMs` default 600000 |
| Urgent vs proactive discards (urgent may take protected tabs) | `discardLeastImportant('urgent' \| 'proactive')` same semantics |
| `auto_discardable_` (extensions opt-out) | `tab.autoDiscardable` / `setTabAutoDiscardable` |
| `WebContents::AboutToBeDiscarded` | `onBeforeDiscard` snapshot hook |
| OS memory-pressure trigger | not exposed to JS reliably → deterministic `maxLoadedTabs` budget (default 10), enforced on a microtask after model changes (Chrome also defers via posted tasks) |
| Renderer-detected protections: audio, form input, user edits, capture, PiP | not detectable generically from outside the content → folded into the `canDiscardTab` app veto |

## Session persistence (`components/sessions` port, `src/session/`)

Modeled on Chrome's session restore stack at the same pinned commit. Commands
are JSON objects instead of binary pickles; ids, semantics, constants, and
algorithms match.

| Chromium | This package |
|---|---|
| `components/sessions/core/session_service_commands.cc` (command ids 0–34, builders, `RestoreSessionFromCommands`) | `session-service-commands.ts` — same numeric ids; browser-only ids (bounds, UA override, extension app id, session storage, splits) left reserved |
| `components/sessions/core/command_storage_manager.cc` (`kSaveDelay` 2500ms, `pending_reset_`, `ScheduleCommand`/`AppendRebuildCommand`/`EraseCommand`/`SwapCommand`) | `command-storage-manager.ts`, sequenced-task-runner semantics via a promise queue with a synchronous fast path |
| `components/sessions/core/command_storage_backend.{h,cc}` (current vs last session, rotation, torn-write tolerance) | `command-storage-backend.ts` interface + `WebStorageBackend` / `InMemoryStorageBackend` / `FileStorageBackend` (`session/node.ts`, JSONL) |
| `components/sessions/core/session_types.h` (`SessionTab`/`SessionWindow`/`SerializedNavigationEntry`) | `session-types.ts`, trimmed to headless-relevant fields |
| `chrome/browser/sessions/session_service_base.cc` (`kWritesPerReset` 250 at cc:78, `ScheduleCommand` reset guard cc:788, `BuildCommandsForTab` cc:592, `rebuild_on_next_save_`) | `session-service.ts` |
| `chrome/browser/sessions/session_service.cc` (`SetSelectedTabInWindow` dedupe, `CommitPendingCloses`) | `session-service.ts` (`maybeEmitSelectedTab_`, `markWindowClosed`) |
| `SessionTabHelper` → `SessionService` navigation plumbing | app-driven `navigateTab` / `updateTabNavigation` / `setSelectedNavigationIndex` / `pruneTabNavigations` |
| `chrome/browser/sessions/session_restore.cc` (`RestoreTabsToBrowser`, group id relabeling, TabLoader deferred loads) | `session-restore.ts` (`restoreSessionWindow`, `deferLoading` discards background tabs) |
| `chrome/browser/process_singleton.h` (one process per profile, h:45; NotifyResult h:85; claim retries, process_singleton_posix.cc:137-140) | `process-singleton.ts` — `WebLocksProcessSingleton`: a storage area is a profile, claimed once at boot via an exclusive Web Lock with bounded retries; losers become secondaries instead of exiting |
| `SetSavingEnabled` / `is_saving_enabled_` (session_service_base.cc:877, guards at cc:790/cc:397) | `setSavingEnabled_` / `savingEnabled_` — a secondary keeps saving disabled forever; the owner's grant calls SetSavingEnabled(true) → ScheduleResetCommands, snapshotting models attached while the claim was pending |

Key algorithm clones: `FindClosestNavigationWithIndex` (cc:339),
`ProcessTabNavigationPathPrunedCommand` (cc:489), `CreateTabsAndWindows`
replay with stop-on-malformed-command (cc:521), `AddTabsToWindows` selected-
navigation remap (cc:404), `SortTabsBasedOnVisualOrderAndClear` (cc:372),
`UpdateSelectedTabIndex` visual-index→position remap (cc:265),
`ReplacePendingCommand` (cc:1344).

Intended deviations from Chrome:

- **Exact visual indices.** On inserts/moves/removals the service re-emits
  `SetTabIndexInWindow` for the affected index range, so replay order is
  exact without depending on periodic rewrites. Chrome tolerates stale
  indices. In-buffer command swaps (a broadened `ReplacePendingCommand`)
  keep the cost flat.
- **Data-only tabs restore.** Chrome drops tabs with no navigations; we keep
  them when a `data` payload exists, since data-only persistence is this
  library's zero-config mode.
- **Tab ids are preserved by default** on restore (they're strings chosen by
  the app and used as React keys). Chrome regenerates ids; pass
  `preserveTabIds: false` for that behavior. Group ids are always relabeled,
  matching Chrome.
- **No crash-bubble flow.** Chrome gates restoring a crashed session behind
  user acknowledgment (`ExitTypeService`); here the last session is always
  restorable, and a run that dies before its first save leaves the previous
  log in place.
- **`lastActiveAt` is persisted but not re-injected** on restore (the model
  owns that field); it is exposed on `SessionTab.lastActiveTime` for
  app-level use.
- **Secondaries stand down instead of exiting.** Chrome's losing process
  gets PROCESS_NOTIFIED and terminates; a losing browser tab cannot
  terminate, so it runs as a SessionService with saving permanently
  disabled (restores nothing, records nothing). Like Chrome, ownership is
  claimed at startup only — no mid-life takeover; a refresh of the realm
  re-attempts the claim. Apps wanting per-browser-tab persistence use one
  storage key per realm (the `--user-data-dir` move), documented in the
  README.

## Deliberately not ported

- **Split tabs** (Chrome 2024+ side-by-side view): large surface, niche. Excluded everywhere it appears.
- **WebContents / Profile / delegate plumbing**: tabs carry a generic `data: T` payload instead.
- **Unload handlers, policy close-blocking, modal UI, read-later, audio mute, metrics, context-menu command table**: browser concerns, not tab-strip logic. `IsTabClosable` survives as an optional `canClose` callback.
- **Detached collections** (cross-window group drags): single-strip library.
- **TabRestoreService** (recently-closed entries, reopen-closed-tab): natural
  follow-up on top of the same command infrastructure; not in this pass.
- **Session crypto (OSCrypt)**, SNSS binary format, and the
  `Apps`/`AppSessionService` variants.

## Behavioral deviations

None intended in the core strip (the session layer's intended deviations are
listed in its section above). Where Chrome CHECKs (crashes), we throw
`RangeError`/`Error`.

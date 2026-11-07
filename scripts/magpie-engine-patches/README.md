# magpie-engine-patches

The vendored engine is upstream magpie at the revision pinned in
`scripts/build-magpie-engine.mjs`, plus the patch files in this directory,
applied by the builder right after checkout — every build is exactly
upstream + these patches, and the builder refuses to ship a binary whose
`vcs.modified` stamp disagrees with the patch set.

## 0001-agent-sync-skip-an-empty-catalog.patch

**The problem it fixes.** magpie rewrites every wired agent's model list
whenever the catalog may have changed (`agent.SyncCatalog`). A magpie
instance whose catalog is empty — a fresh install with no providers, a
start-up window before the vendor lists load, a failed fetch — synced that
empty list into the agent's files: on 2026-11-07, a second, provider-less
magpie on a user's machine rewired ZCode's provider to its own gateway with
**zero models**, and ZCode's picker went empty until the user toggled the
agent by hand. `zcode.Sync` even has a rule that a magpie rule removed from
`provider_config.json` is *not* put back (by design: the user disconnected),
so the daily sync of the healthy instance could not repair the damage.

**The rule.** A catalog with no models is a start-up or a fetch that failed,
not a decision. The user empties a list through Disconnect — an explicit
agent-field write — never through a sync. So:

- `agent.SyncCatalog` skips any agent whose catalog is empty this round; the
  next round (the catalog changed again) writes. Covers every syncable agent.
- `zcode.Sync` and `zcodeRules` carry the same fence one layer down, for any
  caller that reaches them directly. Disconnect (`Field.Set`, `keep=false`)
  is untouched — its semantics are exactly the user's decision.

**The test.** `internal/agent/empty_catalog_sync_test.go`: a wired ZCode with
one model keeps both files byte-for-byte while the catalog is empty (direct
`Sync` and the full `SyncCatalog` round), and writes again the moment the
catalog has models.

The same diff is the text to propose upstream at
`github.com/yetone/magpie`; this directory is where the fix lives until (and
after) that lands, so the built engine carries the guard regardless.

# 明日方舟·稀疏克隆世界书

Phase B standalone SillyTavern extension. It adds a per-save sparse Copy
Worldbook (official Chat Lore) and a sidecar dynamic character profile layer
without mutating the 2,049-entry base book.

- `lore_mode` defaults to `baseline`. Switching legacy chats never auto-creates
  empty books. A clone book is created only when the player explicitly enables
  it on a save or new chat.
- When `lore_mode === 'clone'` (or degraded), runtime `flushWorldbook` to the
  base book is a strict no-op. A missing clone book degrades to read-only
  baseline with a warning.
- Each overridden character compiles to **one** native entry via a local
  compiler (no LLM on the hot path). Mutual exclusion is by exact primary key
  / character ID, never substring name matching. A second overlaid form injects
  only a section-level diff capped at 800 characters. Clone entries set
  `vectorized: false` so they can coexist with Amily2 vector + rerank.
- The outbound prompt hook suppresses the taken-over base entry text. Chapter
  entries such as `九（剧情·时间啊，向前！·44）` are never taken over.
- Dynamic layers and rollback snapshots live in a sidecar store, not in the
  `ark_story_v2` hot path. Chat variables only keep `{ lore_mode, book, sidecar_rev }`.
- The OpenAI-compatible client is used only for explicit panel actions
  (chat summarization into the 14-section schema, and timeline/form merge).
  Form switching is always a local compile.
- Story auto-toggle writes the sparse copy book at most once per segment,
  with a hard cap of 8 exact-PK entries, copy-priority + base fallback, and a
  non-destructive banner when the base form is newer.

Management UI: enable/disable clone mode, inspect the bound Chat Lore book and
overridden characters, summarize, switch form, merge timelines, one-click
rollback, and API settings.

Thin hooks live in `maintenance/runtime-src/core/phase_b_bridge.js` and the
story adapter. Rebuild the runtime with `node tools/pack_runtime.cjs` and the
browser bundle with `node tools/pack_copy_worldbook.cjs`.

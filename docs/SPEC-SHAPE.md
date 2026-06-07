# Spec shape → module structure

A spec's **heading structure** determines its generated **module** structure. Phoenix maps
your spec onto Implementation Units (modules) by its headings — so the shape you write is the
shape you get. `phoenix plan` surfaces this mapping, and warns about shapes that will generate
poorly, *before* any code is generated.

## The rule

- **One module per top-level `##` section.** Each `##` under the document title becomes one
  module (one generated file).
- **Descriptive intros are excluded.** Prose before the first heading, or directly under the
  `#` title, is treated as context and does not become a module.
- **Normative intros become a spurious module.** If that intro carries requirements
  (`must`/`shall`), Phoenix has to put them somewhere — they leak into their own module.
- **Context-only `##` sections generate an empty/stub module.** A section with no requirement
  content produces nothing useful.

Corollaries you can shape specs by:

- **A single-page app is one `## section`.** Don't split one cohesive UI across
  `## Loading` / `## Editing` / `## Styling` — those become separate, non-composing modules.
  Put them under one section (e.g. `## Web Experience`).
- **Keep intros descriptive.** Move any `must`/`shall` out of the intro into a `##` section.

## What `phoenix plan` tells you

For each planned module, `plan` shows its name, the source heading(s) that fed it, an output
path, a source-node count and a rough token estimate — plus a `Heading → Module` map so
fragmentation is visible up front.

It also emits **spec-shape warnings**, each with a concrete fix:

| Warning | Means | Fix |
|---------|-------|-----|
| `fragmented-ui` | A cohesive UI is split across multiple `##` sections that won't compose. | Merge those sections under one `## Web Experience`. |
| `normative-intro` | An intro/preamble carries requirements and becomes its own module. | Make the intro descriptive, or move its requirements into a `##` section. |
| `empty-section` | A `##` section has no requirement content. | Add `must`/`shall` content, or remove the section if it's context-only. |

A well-shaped spec prints `✓ Spec shape looks good`.

## Boundary

This is feedback only. Phoenix advises; it never merges or rewrites your spec sections — the
spec stays the source of truth and you make the edit.

---

See `change-notes/SPEC-SHAPE-FEEDBACK-OUTCOMES.md` for the outcomes this capability delivers
(F1–F5) and the incidents that motivated it.

# Phoenix: spec-shape feedback — outcomes & evidence

## Context

A spec's **structure** (its headings, sections, and intros) silently determines the generated **module
structure** — but the author gets no feedback about this until they inspect Phoenix internals
(`ius.json`) or discover a fragmented / non-composing app *after* generation. This is a distinct concern
from the environment contract and the run harness: it is a **new capability** — Phoenix advising the
author, at authoring / plan time, that their spec's *shape* will not generate well.

**Provenance (concrete incidents this session):**
1. **Fragmentation:** a single-page web app was described across four `##` subsections
   (Loading / The outline / Editing / Styling). Phoenix planned **four separate modules** (separate Hono
   routers) that would not compose into one page. Discovered only by reading `ius.json`; fixed by merging
   to one `## Web Experience` section.
2. **Spurious modules from intros:** H1 intro paragraphs carrying normative ("must") content were planned
   as their own modules. Fixed by rewriting intros to description-only.

Both should have been surfaced by Phoenix at plan time, not learned by trial and error.

The implicit rule the author must currently reverse-engineer: **one module per top-level `##` section;
descriptive intros don't become modules; normative content in an intro does.**

---

## Outcomes & evidence of success (Phoenix POV)

### F1. The author sees how their spec maps to modules before generating.
**Outcome:** `plan` (or a `lint`/preview) shows, for each planned module, which spec heading(s) produced
it — so fragmentation is visible up front, with no need to read `ius.json`.
**Evidence of success:**
- A spec whose UI is split across four `##` subsections shows **four modules**, each with its source
  heading, *before* generation.
- The author can predict the module count and names from the spec headings alone.
*(Extends O5 from the harness doc, from the author-feedback angle.)*

### F2. Phoenix warns when a spec shape will likely generate poorly.
**Outcome:** Phoenix flags spec-shape anti-patterns at plan time — notably (a) a cohesive UI/app described
across multiple `##` sections that will fragment into separate, non-composing modules, and (b) an
intro/overview that carries requirements and will become a spurious module.
**Evidence of success:**
- A single-page UI split across N `##` sections produces a warning, e.g. *"these N sections will each
  become a separate module; a cohesive UI is usually one module."*
- An H1/intro containing normative (`must`/`shall`) content produces a warning that the intro will become
  its own module.
- A `##` section with **no requirement-class content** (all context) is flagged as "will generate an empty
  / stub module."

### F3. The heading→module rule is explicit and documented.
**Outcome:** the mapping rule (one module per top-level section; descriptive intros excluded; normative
intros included) is documented and referenced by `plan`, so authors shape specs intentionally rather than
by trial.
**Evidence of success:**
- The docs state the rule plainly, with the "single-page app = one section" and "keep intros descriptive"
  guidance.
- A first-time author predicts the generated module structure correctly from the spec, with no inspection
  of internals.

### F4. The feedback is actionable.
**Outcome:** each spec-shape warning names the concrete fix.
**Evidence of success:**
- The fragmentation warning includes a remediation, e.g. *"merge sections 'Loading', 'The outline',
  'Editing', 'Styling' under one `## Web Experience` to generate a single page module."*
- The intro warning suggests *"make this intro descriptive, or move its requirements into a `##` section."*

### F5. (Headline) A well-shaped spec needs no trial-and-error restructuring.
**Outcome:** guided by Phoenix's plan-time feedback, an author gets the intended module structure on the
first plan — no inspecting `ius.json`, no restructure-and-replan loops.
**Evidence of success:**
- The two restructurings this session (four subsections → one section; stripping normative intros) would
  each have been pre-empted by an F2 warning at the first `plan`.
- For a given spec, `plan` either produces the author's intended modules or tells them exactly why it
  won't and how to fix it — in one pass.

---

## Boundary / non-goals

- This is **feedback**, not silent auto-restructuring: Phoenix advises; the author edits the spec (which
  preserves "the spec is the source of truth" and "regenerate from scratch"). Phoenix should not merge or
  rewrite spec sections on the author's behalf.
- Distinct from generation reliability (`PROVIDER-STREAMING-DIAGNOSIS.md`) and the environment contract
  (`ENVIRONMENT-CONTRACT-OUTCOMES.md`): those are about *executing* a run; this is about helping the
  author write a spec that will *plan* into the structure they intend.

## Provenance

Surfaced while authoring a Bramble spec for the `web-api/node-typescript` architecture; originally listed
as "E7" in the environment-contract draft and correctly reclassified (it is neither toolchain nor
environment — it is spec-authoring feedback). See `ENVIRONMENT-CONTRACT-OUTCOMES.md` (where it was removed)
and `OBSERVABILITY-HARNESS-OUTCOMES.md` O5 (the plan preview these build on).

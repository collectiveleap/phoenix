# Sanderson's Manifesto: What Phoenix Is For

*A starting draft based on what's been articulated through this design conversation. Owned by the user; refine freely.*

---

## What Phoenix is for, from my POV

Phoenix is the substrate for incremental evolution of any current implementation — code, socio-technical workflow, or hybrid — while preserving the durable intent and the empirical assertion of correct behavior.

It is not "regenerative version control for AI-generated code." That framing is too small. The real claim is:

> **In a world where AI can synthesize implementations cheaply, the durable artifacts are intent (specifications) and correctness (evaluations). Both belong to the individual or group at the edge. Implementations are ephemeral and can run on whatever substrate currently best serves them.**

Phoenix operationalizes that claim.

## Throughlines — small, reversible, non-destructive evolution

I've been practicing this pattern for years across different domains. The core move:

1. Identify what's durable about a system — the *what* it accomplishes, not the *how* it does it.
2. Catalog what's ephemeral — the current set of tools, processes, scripts, services, ad-hoc workflows that *happen to be* the way it works today.
3. Evolve the ephemeral incrementally — small, reversible, non-destructive increments toward a different implementation, while the durable layer holds steady.
4. Never big-bang the working system. The throughline (the durable intent) is what gets preserved across implementation generations.

**Example: how I currently manage finding and responding to job opportunities.**

The current implementation is a heterogeneous blend:
- Manual website scans (LinkedIn, company career pages)
- Tana database for tracking opportunities, contacts, follow-ups
- `.md` files on disk for notes and drafts
- Claude for drafting outreach, summarizing roles
- Browser bookmarks, copy-paste workflows, intuition

This works. It works because of *what it does* — surface relevant opportunities, capture them, respond well — not because of any particular tool choice.

The throughlines move is to evolve this incrementally toward something better. Maybe LinkedIn MCP for direct querying. Maybe auto-scanning of saved company pages. Maybe DXOS Composer for unified context. Maybe ensemble agents that triage incoming opportunities. None of these get adopted as a big-bang replacement; each one takes over a piece of the current workflow when it's ready, and the workflow keeps producing the same outcomes (good responses to good opportunities) throughout.

Phoenix is the technical substrate for this pattern when the implementation includes generated code. The durable layer (`spec/` + `evals/`) describes what the system must do; the ephemeral layer (everything else) is regenerable, replaceable, evolvable.

## The strangler pattern is socio-technical, not just code

When the Phoenix Architecture essays describe "regenerative software" and the strangler pattern, the natural reading is "wrap a legacy code system." That reading is too narrow.

Legacy ≠ legacy code. The pattern applies to:
- Manual workflows (Steve's job-search routine)
- Ad-hoc tooling (collections of scripts, notebooks, spreadsheets)
- AI-mediated processes (current generation of "I ask Claude every time")
- Hybrids of all of the above
- And, yes, also code.

The strangler-pattern toolkit Phoenix becomes (per the long-arc roadmap) is for any current implementation. Shadow mode captures the current implementation's outcomes regardless of whether they come from HTTP responses, file changes, manually-tagged outcomes, or AI-mediated capture. Each accepted eval characterizes a behavior the current implementation produces. Coverage of evals against the current implementation's behavior surface is the cutover ratchet — for code OR socio-technical OR hybrid.

This is what makes Phoenix usable for actual lived workflow modernization, not just for greenfield code regeneration.

## Production behavior is the oracle

I learned this at Food on the Table in 2010-2012. We monitored production continuously. We knew the % of users who visited the login page and the % who completed login. We had a baseline pattern of "good." When the actual ratio went out of bounds, we knew something was broken before any user reported it. We rolled forward — fixed and deployed — rather than reverting to the old code.

This same axiom appears across multiple traditions:
- **Lean Startup** (Eric Ries): validated learning. Production data trumps opinion.
- **Charity Majors / Honeycomb**: "Test in prod or live a lie." Production observability tells you what's actually happening.
- **Chad Fowler's Phoenix Architecture**: "Production Is a Compiler Input." Production telemetry should drift, invalidate stale modules, and drive regeneration.

The shared claim: production behavior is the source of truth; everything else is hypothesis.

For Phoenix specifically, this means the eval suite isn't authored exhaustively up-front. It grows from what production observation reveals. Each accepted eval crystallizes a piece of validated learning into a durable artifact. The new implementation has to satisfy the durable record of what production has actually shown to be correct.

## Collective Leap rationale — agency at the edge

As AI assistance becomes the substrate of cognition, *who owns the durable artifacts* determines whether power flows to individuals and groups at the edge, or accrues to centralized platforms (big tech, late-stage capitalism, AI providers whose interests may drift from mine).

Phoenix's strict durable/ephemeral boundary is the architectural answer:

- **The user owns `spec/` and `evals/`.** Plain text. Version-controllable. Portable.
- **Everything else can be supplied by anyone** — and swapped when alignment shifts.

If an AI provider's incentives drift, my evals constrain what "correct" means. They don't get to redefine my system.

If a platform enshittifies, my spec and evals are mine. I take them elsewhere; I regenerate.

If I want to switch from Anthropic to a local model, from one cloud to another, from one architecture to another — the durable layer is unchanged.

This is the architectural condition for using AI-substrate cognition without surrendering ownership of intent. Phoenix is the substrate of preserved agency in an AI-mediated world. That's a stronger claim than "regenerative VCS," and it's the one I'm betting on.

## What I'm betting on

That the technical substrate Phoenix provides + the disciplined practice of incremental change (throughlines) + the empirical commitment to production-truth (Food on the Table, Chad, Charity) = a way to use AI-substrate cognition without surrendering the underlying intent or the assertion of "good."

A few specific propositions I'd defend:

- **Big-bang authoring of evals is a category error.** Coverage grows from incidents, observation, and spec changes. The first evaluation is enough to bootstrap; the rest accrete.
- **The eval suite IS the codebase.** Implementations are throwaway. The durable record of what behavior matters is the asset.
- **Strangler-style replacement scales beyond code.** The hardest legacy systems aren't monoliths; they're heterogeneous socio-technical workflows held together by individual practice. Phoenix's pattern works for those.
- **Substrate ownership is non-negotiable.** Plain text, on disk, portable. Anything else is a rental, not an asset.
- **Production is where intent meets reality.** Static evals catch what was specified. Production observation catches what wasn't. Both feed the durable record.

These commitments shape every iteration of Phoenix's design. Iter 12 — bringing the Evaluation primitive into existence — is the first concrete step.

## Pointers

- Technical charter: `docs/SUCCESS-CRITERIA.md` (deletion test, durable/ephemeral boundary, trajectory rule)
- The PRD: `PRD.md` (Phoenix's existing scope)
- Phoenix Architecture essays: [aicoding.leaflet.pub](https://aicoding.leaflet.pub) — Chad Fowler

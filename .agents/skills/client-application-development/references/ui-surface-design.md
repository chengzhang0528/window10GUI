# UI Surface Design

Use this reference only when the client owns a dense settings, management, form, search, or record-list surface. It is a **generic review supplement**, not a product design system and not a mandate to add a shell, sidebar, table, card, modal, or workflow.

## Scope And Precedence

Before using these checks, identify the actual UI owner and load the project's own sources. Resolve rules in this order:

1. The current user request, ProductContract or equivalent product source, source, types, tests, and accessibility requirements decide product facts and behavior.
2. The project's existing design system, shared component owner, page-family guidance, and navigation contract decide the base structure.
3. This reference adds only generic checks for dense UI surfaces. It does not require another project's settings split, role cards, table layout, navigation, copy, or theme names in this client.
4. The parent skill owns method, delivery scope, and evidence routing; it does not override the product or component owner.

A generic recommendation never outranks an owned product rule. If sources conflict, trace the decision to one owner and fix or clarify that owner. Do not satisfy both documents by adding another container, component variant, or exception.

Treat each check as one of three strengths: an **invariant** protects product responsibility, state truth, accessibility, or a shared owner; a **default** is the smallest proven structure and may yield to an owned product decision with evidence; a **heuristic** is taste-level guidance and cannot justify adding UI or workflow. Keep only invariants and evidence-backed defaults in durable project guidance.

## Decision Contract

Record these answers before implementation or review:

| Question | Required answer |
|---|---|
| Primary job | The one decision or mutation the surface enables |
| Identity | The visible title and its navigation owner |
| Primary action | Zero or one action and its location, as defined by the product owner |
| Query | Search/filter controls and the collection they affect |
| Data tools | Refresh, columns, selection, or export controls |
| Surface owner | Shared list, form, drawer, modal, or workbench primitive |
| Boundary budget | One main boundary by default; each extra boundary needs independent work |
| User language | Business-facing facts without implementation terms |

If one answer is unknown, resolve the source of truth before adding copy, containers, or placeholder status.

## Surface Checks

- Render one page title when the product surface has a page identity. Put the primary business action where the product's existing header or page-family owner places it.
- Keep supporting copy as plain text unless it represents a real info, warning, error, permission, or decision state.
- Separate query controls, business actions, and data tools even when they share a toolbar row. The query may grow first; data tools may collapse to named icon buttons when the product supports that pattern.
- Use the existing shared list owner for ordinary records. Keep one row per record with stable identity, state, and action positions; do not introduce a competing list abstraction to satisfy this reference.
- Keep one main boundary by default. A nested surface is justified only by independent scrolling, editing, or a separate decision; product-specific workbenches may define another legitimate structure.
- Do not add `min-height`, blank bands, or decorative headers to make sparse data look substantial. Counts are plain metadata; badges and pills express persisted state, exceptions, or decision-relevant facts.
- Icons, borders, and background fills must explain identity, state, or action. Remove decoration that only increases visual weight.
- Describe what the user can inspect or do next. Do not expose API, DTO, provider, host, database, or internal permission terms unless the product explicitly serves that audience.
- Removal, disablement, archive, and other destructive actions require the product-appropriate danger semantics, pending protection, failure recovery, and confirmation when material.
- Loading preserves geometry; empty preserves query context and a valid next action; errors stay attached to the owning surface with retry when meaningful.

## Evidence Contract

Every retained rule needs evidence:

| Rule | Evidence |
|---|---|
| Title/action ownership, control grouping, count/status semantics | Focused source or contract test |
| User-facing copy and forbidden implementation terms | String/source contract test |
| Boundary count, sparse density, spacing, and hierarchy | Browser screenshot or computed-style check |
| Responsive wrapping and no overflow | Desktop and named narrow-width browser smoke |
| Destructive mutation, pending, failure, and focus return | Focused interaction test |

Review at a supported desktop width and a named narrow width such as `390 x 844` when the product supports it. Do not report a surface as finished when a required gate is only described and has no matching source, test, or browser evidence. Do not create a new permanent artifact just to manufacture evidence; route unresolved facts to the product or component owner.

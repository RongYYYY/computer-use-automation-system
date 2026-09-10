# 1. Architecture

The system is a small TypeScript process with five deliberate boundaries: discovery, artifact validation, deterministic replay, surface control, and human handoff. The concrete target is a local “Northstar” member-servicing application built to resemble the awkward end of enterprise software: server-rendered pages inside a named iframe, table-based layout, no test IDs, and injected dialogs, delays, authorization failures, and session expiry. The data is entirely synthetic.

Discovery is an `observe → decide → act` loop. The Playwright surface returns a screenshot plus bounded, accessibility-like metadata for visible controls across frames. An OpenAI Responses API provider receives that state and returns exactly one action through a strict JSON schema. The model never emits executable JavaScript or selectors. The loop validates the candidate ID, input/output name, policy, and risk before acting. A successful run is compiled into a Zod-validated capability; the raw model transcript is neither the artifact nor a replay dependency. The included evidence is a genuine `gpt-6-astra` run with API storage disabled.

Replay interprets the capability directly. It validates inputs, checks known outcomes, resolves a locator, acts, checks postconditions, and finally verifies the success checkpoint and output contract. There is no model client on this path. `SurfaceAdapter` owns observation, targeting, actions, and screenshots; the engines depend only on that interface. This costs some abstraction code, but it keeps Playwright mechanics and iframe races out of capability semantics and leaves a credible desktop seam.

The implementation is single-process and synchronous on purpose. A production service would place the same run state machine behind a durable queue, but distributed infrastructure would not improve the central decisions being evaluated here.

# 2. Artifact schema

`CapabilityArtifact` is strict, versioned, serializable JSON. Its top-level contract identifies the vendor/app family and supported variants, declares typed and sensitivity-marked inputs and outputs, embeds the policy envelope, and carries steps, success conditions, and known runtime outcomes. Schema refinement rejects duplicate names/step IDs and dangling input/output references.

Each step contains a stable ID, plain-language intent, one typed action, preconditions, postconditions, a timeout, a bounded retry policy, and a risk class. Values are either literals or references to invocation inputs. Targets are descriptive, optionally frame-scoped, and contain an ordered locator bundle: role/name, label, semantic CSS, text, and schema support for coordinates. Runtime-only candidate IDs are deliberately discarded. Replay accepts a strategy only when it resolves uniquely, then logs which fallback succeeded.

Extraction deserves stricter treatment because the observed value is often sensitive and always changes between invocations. The recorder rejects value-dependent extraction targets and rewrites the description from the declared output contract. In the saved example, the model selected a savings cell, but the artifact retains only its value-independent semantic field selector—not the observed balance, role name, or text. This constraint was added after the first real run exposed exactly that failure mode.

Known outcomes live beside the flow because they are part of the capability’s caller-facing behavior. Each has a code, classification, detection condition, and, only for recoverable cases, a bounded recovery. A reviewer can therefore understand not only the happy path but also the capability’s operational envelope.

# 3. Determinism & error handling

Determinism means the model does not choose replay actions; it does not mean blindly replaying clicks. Before every action, the engine validates the policy, checks preconditions, and checks for known blocking outcomes. Frame patterns narrow the search, strategies are attempted in declared order, ambiguous matches are rejected, and bounded timeouts replace unbounded sleeps. Observation retries only transient iframe navigation races and verifies that frame URLs did not change while a snapshot was assembled.

The result union separates three cases. `success` contains typed declared outputs. `business_outcome` reports a legitimate domain result, such as `member_not_found`, without treating it as a crash. `failure` includes a code, message, current step where available, expected/observed context, and evidence paths. Recoverable outcomes are not returned: the engine performs their declared recovery within its limit, records the attempt, and continues. The demo proves all three paths plus a scheduled-notice recovery. Permission denial and session expiry are hard failures; the former evidence includes a screenshot.

Every run emits sequence-numbered JSONL. Events include actions, locator resolutions, recovery, ownership transitions, and terminal results, while failure/intervention paths add screenshots. This is intentionally simpler than a Playwright trace, but it is enough to reconstruct the state machine and locate a failed target without retaining full page content.

# 4. Heterogeneity & multi-tenant

The surface seam expresses capabilities in control concepts rather than Playwright objects. A desktop adapter could observe an OS accessibility tree plus screenshot, map recorded roles/labels to native controls, and use coordinates only as a guarded fallback. A terminal or image-only adapter could implement the same operations with OCR/accessibility metadata. The artifact’s `surface` field is currently constrained to `browser`; evolving it to a discriminated surface union would be the next schema version, preserving v1 compatibility rather than quietly changing semantics.

For multi-tenant reuse, I would store a reviewed base capability against `app.family` and vendor version, then layer small tenant/variant overrides for entry origin, frame patterns, branding text, or individual locator strategies. Inputs remain invocation data and never become overrides. Before promotion, canary replays would record strategy success, checkpoint success, latency, and error distribution by app version. Drift would be detected when fallback use or checkpoint failures increase; a recorder could propose a new version, but a human would review the diff before broad rollout. This favors sharing by vendor lineage with explicit specialization over either one global brittle script or a copy per institution.

# 5. Escalation & handoff

Discovery detects a dead-end when the observable state fingerprint repeats three times, and it also has max-step and wall-clock limits. Either discovery or replay can request intervention explicitly; policy automatically requests it for risky/irreversible actions. The request includes run/step or goal context, reason, URL, risk, and a screenshot.

`ControlLease` makes ownership explicit and rejects illegal transitions: `automation → pausing → human → resuming → automation`, with `human → aborted` as the terminal alternative. `SameSessionHandoff` never creates a replacement browser context. It pauses the engine, installs trusted DOM-event capture in the existing page and frames, exposes that live headed browser to the operator, records the response and safe action metadata, then resumes that same session. The manual demo uses a terminal as the minimal operator console; the evidence run uses a mock operator through the identical lease and live-page seam. `completed` means the human performed the blocked step, while `resume_automation` means they only cleared a blocker and the engine should still execute it.

The seam is real but local: the lease is in memory and the headed window is the “console.” Production would persist leases with expiry/fencing tokens, stream the session through an authenticated co-browsing service, and bind every operator action to an identity.

# 6. Safety

Every navigation and action is checked against configured origins, route patterns, action types, and risk policy. Safe/reversible viewing can proceed; risky and irreversible actions require a handoff under the demo policy. A capability cannot widen its authority during replay, and the model can only choose observed candidates and declared inputs/outputs.

Secrets belong only in ignored `.env.local`; `.env.example` is blank. OpenAI requests use `store: false`. Structured logs redact generic API keys, bearer tokens, SSNs, declared sensitive inputs, and sensitive outputs registered at extraction time. Artifacts never contain invocation values, and sensitive extraction locators must be independent of the observed value. The CLI also redacts printed results.

Screenshots are an unavoidable residual risk because pixels can contain regulated data. This submission uses synthetic data. A production design needs encrypted evidence, strict RBAC, tenant-scoped keys, short retention, access audit, provider data-processing controls, screenshot/OCR minimization, and a policy decision about whether particular screens may leave the institution boundary. Pattern redaction is defense in depth, not a substitute for data classification.

# 7. Cuts

I deliberately did not build a distributed scheduler, persistent capability catalog, approval UI, real operator co-browsing console, native-desktop adapter, or tenant override service. The CLI relocates the demo origin for local portability; production route canonicalization and signed artifact promotion would be explicit services. There is no open-ended LLM repair during replay because that weakens the safety and cost properties of the production path.

Next I would add artifact lifecycle states (`draft → evaluated → approved → deprecated`), signed immutable versions, repeated canary replay with flakiness metrics, tenant/version overrides, encrypted evidence retention, and an authenticated durable handoff service. Only after those controls would I consider a single-step, policy-checked model fallback, recorded as a proposed artifact revision rather than silently changing execution.

# Contributing

## What belongs here

This repository holds the shared implementation every capability consumes. Before adding anything,
answer one question: **would at least two unrelated capabilities need this, in the same shape?**

If the answer is no, it belongs in a capability repository.

Things that have deliberately been kept out, as examples of the boundary:

- AST supported file extensions, Git repository semantics, Data Cruncher source types, Vision image
  rules — capability file policy, composed on top of the generic root boundary.
- Azure subscription allow-lists, ARM identifiers, deployment scope validation — capability safety
  policy, composed on top of the generic mutation gate.
- Which executables may run and with which argv — capability process policy, composed on top of the
  generic bounded-process primitive.
- Cross-capability workflow routing — that belongs to agent composition repositories.

## Working on the repository

```bash
npm install
npm run typecheck
npm run test:coverage
npm run build
npm run package:smoke
```

Everything is validated by `npm run` scripts that CI calls directly, so a green local run means a
green CI run.

## Standards

- **TypeScript is strict**, including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
  Do not weaken the compiler options to make a change compile.
- **Coverage floor:** 80% lines, functions, and statements; 70% branches.
- **Comments explain decisions, not mechanics.** If a reader can see _what_ the code does, the
  comment should say _why_ it does that and what the alternative would have cost.
- **Public API changes need a testkit conformance check.** If a new invariant matters to
  capabilities, add it to the relevant suite in `packages/testkit` rather than only to
  `tests/`, so every capability inherits it.

## Adding a runtime module

1. Put it under `packages/runtime/src/<area>/`, with an `index.ts` barrel.
2. Add a deliberate subpath export in `packages/runtime/package.json`.
3. Re-export it from `packages/runtime/src/index.ts`.
4. Cover it in `tests/`, and add a conformance check if capabilities depend on the behaviour.
5. `npm run package:smoke` will fail if the export does not actually ship.

## Adding a Bicep module

Modules must stay account-neutral: no tenant ids, subscription ids, resource-group names,
credentials, or personal domains. `tests/infra.test.ts` enforces this. The only hard-coded GUIDs
permitted are Azure built-in role definition ids, and each must be added to the allowlist in that
test with a comment naming the role.

Do not add a capability-specific environment variable to `modules/container-app.bicep`. Pass it
through `additionalEnv` or `secretRefs` from the capability's own composition.

## Publishing

Nothing in this repository is published in v0, and every package is `private: true`. The metadata
check fails if that changes accidentally.

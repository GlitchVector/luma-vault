# contracts

Golden fixtures that **are** the wire format between the Rust backend and the
web frontend. Not a schema package, not a codegen step — just JSON, checked from
both sides.

- **Rust half** — `apps/desktop/src/contract_tests.rs` deserializes each fixture
  into its serde struct, re-serializes, and asserts the result is *byte-identical*
  to the original. A renamed field, an added field, or a casing change fails.
- **TypeScript half** — `packages/core/src/contracts.test.ts` runs
  `schema.parse(fixture)` and asserts `toEqual(fixture)`. Because zod strips
  unknown keys, the deep-equal also catches a fixture field the schema would
  silently ignore — not just missing or mistyped ones.

## The ritual

A new structured value crossing the boundary needs **three** things, in the same
PR:

1. a zod schema in `packages/core/src/schemas.ts`,
2. a fixture here,
3. a case added to the test table on **both** sides.

Fixtures deliberately carry awkward rows — a video alongside an image, an
unclassified item with `null` everywhere, a scan carrying a non-fatal error —
because the null-ness and the error channel are part of the contract too.

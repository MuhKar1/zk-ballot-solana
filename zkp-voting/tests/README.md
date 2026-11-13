# Anchor tests

The TypeScript tests are split by whether they need a validator.

## `zkp-voting.ts`

This is the validator-backed Anchor suite. It submits real transactions for
election and position initialization, voter-root freezing, stored account
state, and invalid transition rejection.

Successful `cast_vote` tests additionally require the deployed Sunspot
verifier and the Light Protocol ZK Compression environment.

## `adversarial.ts`

This is a fast, provider-independent suite for PDA and account-seed invariants.
It does not call the Solana program and cannot prove instruction rejection.

## `compressed-ballot.ts`

This Light-backed integration test verifies a ballot with the pinned Sunspot
program, submits the Light V2 CPI, checks the indexed compressed ballot, and
rejects an unfrozen election, a corrupted proof, and a replayed nullifier. It
generates a fresh circuit fixture and proof for each run.

## `sunspot.ts`

This suite submits a generated Groth16 proof to the Sunspot verifier and checks
that a modified public witness is rejected. It requires the generated local
Sunspot artifacts and a validator with the verifier preloaded at its pinned
address; run it separately with `npm run test:sunspot`.

## `instructions.ts`

A table-driven on-chain matrix for every instruction. It covers the success and
rejection paths of `initialize_election`, `initialize_position`,
`freeze_voter_root`, `cast_vote`, and `post_tally`. It is deliberately
Light-free: every `cast_vote`/`post_tally` case fails before the Sunspot
verifier or the Light CPI, so no proof or compressed-account artifacts are
needed. It still requires a validator preloaded with both verifier programs.

## `tally.ts`

The Layer-2 end-to-end test. It casts a real compressed ballot, asserts the
on-chain transcript was re-derived (Layer 1), then posts a tally and asserts it
is accepted only when accompanied by a `tally_circuit` proof that decrypts the
ballot the chain folded. Requires the tally proof from `prepare:tally-proof`.


## Commands

```bash
npm run test:pda          # PDA model tests; no validator
npm run test:integration  # Anchor smoke/integration tests; local validator
npm run test:compressed   # Full Light V2 compressed ballot flow
npm run test:instructions # Instruction success/rejection matrix
npm run test:tally        # Layer-2 trustless tally flow (casts + posts)
npm run test:light        # Integration, compressed ballot, instructions, and PDA suites
npm run test:ts           # Alias for all TypeScript suites; requires Light
npm run test:sunspot      # Sunspot verifier proof acceptance/rejection
npm test                  # Full Anchor workflow
```

## Sunspot proving artifacts

Proof-producing tests require `.ccs` and `.pk` files matching the verifier
programs loaded at the pinned IDs. These generated artifacts live under
`circuits/target/` and are not included in the repository. Restore the original
matching files from backup before running `test:compressed` or `test:tally`.
`nargo execute` generates the witness `.gz` as part of proof preparation.

Do not run `sunspot setup` to replace missing proving keys for the configured
verifiers. It performs a new trusted setup and produces a key that will not
match the already deployed verifier. Creating new verifier keys is a separate
deployment operation that requires updating the verifier IDs and program
configuration; it does not make old proofs or election state transferable.

Build the application program, then start a fresh Light test environment with
the matching verifier and application program binaries loaded at their
configured addresses. Keep it running while executing the validator-backed
tests in another terminal.

```bash
light test-validator \
	--sbf-program BmktzTCrmYeqxmDVfGwkKtVRnckNXk1PY5nb8TxCswKV ../circuits/target/voting_circuit.so \
	--sbf-program AuSPaahFzAViTokdyhc6fYNe1gELiHRksbExo2YNptav ../circuits/target/tally_circuit.so \
	--sbf-program HyCme4fJ3PDgCR25aXrFmiumBuGVB8c7bggz4PkM8LW5 target/deploy/zkp_voting.so
npm run test:light
npm run test:tally
```
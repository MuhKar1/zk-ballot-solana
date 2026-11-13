# ZKP Voting System

A Solana devnet demonstration of a voting protocol using ElGamal-encrypted ballots,
Light Protocol V2 compressed accounts, and Groth16 proofs verified by Sunspot
programs. The voting circuit checks a ballot against a frozen voter-list root and
prevents reuse of the same nullifier; the tally circuit checks published totals
against the transcript recorded by the program.

This is not production-ready; no independent security audit is documented in
this repository. The administrator chooses the voter list and can decrypt
individual ballots with the tally secret key. The
default vote prover sends its witness, including the voter secret, to the app
server. The tally circuit supports at most eight ballots per position, and
verifier-matched proving artifacts are not included in the repository. See
[Security model & threat analysis](#security-model--threat-analysis),
[Known limitations](#known-limitations), and the [frontend guide](#frontend-app).

---

## Table of contents

1. [Overview](#overview)
2. [Trust model at a glance](#trust-model-at-a-glance)
3. [Architecture](#architecture)
4. [Repository layout](#repository-layout)
5. [The protocol in detail](#the-protocol-in-detail)
6. [Layer 1 — the Solana program](#layer-1--the-solana-program)
7. [Layer 2 — the circuits](#layer-2--the-circuits)
8. [Tally correctness](#tally-correctness)
9. [Design decisions](#design-decisions)
10. [Security model & threat analysis](#security-model--threat-analysis)
11. [Prerequisites](#prerequisites)
12. [Build & test runbook](#build--test-runbook)
13. [Developer workflow](#developer-workflow)
14. [Configuration reference](#configuration-reference)
15. [Frontend (`app/`)](#frontend-app)
16. [Frontend setup & user guide](#frontend-setup--user-guide)
17. [Known limitations](#known-limitations)
18. [Troubleshooting](#troubleshooting)
19. [Disclaimer](#disclaimer)

---

## Overview

The system is split into two layers that reinforce each other:

- **Layer 1 (on-chain)** — an Anchor Solana program (`zkp_voting`) that manages
  elections, freezes the submitted voter-list Merkle root, accepts ballots via
  Light Protocol V2 ZK-compression, and records a transcript of accepted ballots.
- **Layer 2 (off-chain circuits)** — Noir circuits compiled to Groth16 and
  verified on-chain through **Sunspot** verifier programs:
  - `voting_circuit` — proves a ballot is valid (eligibility, one-vote,
    right key, one-hot choice, committed ciphertext).
  - `tally_circuit` — proves the published `totals` are the decryption of the
    exact set of ballots the chain folded into its transcript.

The ballot ciphertext is submitted encrypted. However, the default `NodeProver`
posts the vote witness (including `s`) to `/api/prove` on the app server; do not
assume the voter secret remains on the device. The tally secret key (`sk`) is
kept off-chain by the tally authority, but anyone who obtains it can decrypt the
ballots. The on-chain tally proof checks the totals against the stored transcript,
subject to the verifier, circuit, and trusted-setup assumptions described below.

> **Deployment status:** the program and verifier IDs in this repository target
> Solana devnet. The repository contains source code and test instructions, not
> the generated Sunspot proving artifacts. A successful devnet vote has been
> exercised, but a checkout cannot generate proofs for the deployed tally verifier
> unless the matching tally proving artifacts are supplied. This is a demo, not a
> production election system.

## Trust model at a glance

| Component | Who trusts what | Mitigation |
|---|---|---|
| Voter eligibility | The frozen Merkle root (published by the admin before voting) | `voting_circuit` proves membership without revealing the leaf |
| One vote per voter | The nullifier is unique per `(secret, election, position)` | On-chain replay is impossible: the nullifier is part of the compressed-account seed |
| Ballot integrity | The ciphertext a voter publishes matches their proven choice | `voting_circuit` re-encrypts the choice and binds its commitment |
| Ballot privacy | Ciphertexts are ElGamal; anyone holding `sk` can decrypt them | `sk` is not on-chain; the default vote prover sends the voter witness to the app server |
| Tally correctness | The admin posts `totals` | Layer-1 transcript + `tally_circuit` re-derive the tally on-chain |
| Verifier programs | Groth16 verifying keys are correct | Pinned program IDs; keys are compiled into the verifier `.so` |

### Trusted vs enforced

| Property | Trusted (admin / operator) | Enforced (cryptography / chain) |
|---|---|---|
| Voter eligibility | Pre-freeze enrollment: the admin publishes the Merkle root | Post-freeze: every ballot needs a Merkle membership proof |
| Ballot contents | — | The ciphertext must match the proven commitment |
| One vote per voter | — | The nullifier is the compressed-account seed (no replay) |
| Tally | `sk` is held by one tallier (who can decrypt individual ballots) | `totals` must decrypt the on-chain transcript via `tally_circuit` |
| Verifier programs | Deployment of the `.so` (upgrade authority) | Program IDs are pinned; keys are baked into the `.so` |
| Proving keys | Must match the verifier deployed for the circuit | A newly generated setup will not match a pinned verifier |

---

## Architecture

```
                 Voter (browser — Next.js `app/`)
      id+password → secret s → leaf, nullifier, ElGamal ballot
      browser prepares witness; default NodeProver sends it to app server
                              │  proof + ciphertext (xs + parity) + nullifier
                              │  (relayer signs + pays; voter pubkey stays off-chain)
                              ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                    Solana program: zkp_voting  (Layer 1)                    │
│                                                                            │
│  initialize_election   create election (pk, window)                        │
│  initialize_position   create position + transcript PDA                    │
│  freeze_voter_root     publish Merkle root + leaf count (before voting)    │
│  cast_vote             verify voting proof → fold transcript → Light CPI   │
│  post_tally            verify tally proof → store totals                   │
└───────────────┬───────────────────────────────────┬────────────────────────┘
                │ CPI (Light V2)                    │ invoke (Sunspot)
                ▼                                   ▼
   Light Protocol V2                      Sunspot Groth16 verifiers
   (one compressed BallotAccount        voting verifier  BmktzTCrmYeqxmDVfGwkKtVRnckNXk1PY5nb8TxCswKV
    per ballot, indexed off-chain)      tally  verifier  AuSPaahFzAViTokdyhc6fYNe1gELiHRksbExo2YNptav

        Off-chain (Noir workspace, circuits/)
        voting_lib  →  voting_circuit, ballot_encoder, tally_circuit
```

Two proofs are generated off-chain and verified on-chain:

1. **Vote proof** — per ballot; with the default NodeProver, the app server
   generates it after receiving the witness from the browser.
2. **Tally proof** — once per position, generated by the tally authority (who
   holds `sk`) from the ballots the chain already recorded.

---

## Repository layout

```
ZKP-Voting-System/
├── circuits/                        # Noir workspace (Layer 2)
│   ├── Nargo.toml                   # workspace members
│   ├── voting_lib/                  # shared primitives (hash, EC, transcript)
│   │   └── src/lib.nr
│   ├── voting_circuit/              # the per-vote proof (5 rules)
│   │   ├── Nargo.toml
│   │   ├── Prover.toml              # empty input template (kept)
│   │   └── src/main.nr              # + 25 nargo tests
│   ├── ballot_encoder/              # computes a ciphertext from (pk, choice, r)
│   │   ├── Nargo.toml
│   │   ├── Prover.toml              # empty input template (kept)
│   │   └── src/main.nr
│   ├── tally_circuit/               # the tally-correctness proof (Layer 2)
│   │   ├── Nargo.toml
│   │   └── src/main.nr              # + 10 nargo tests
│   ├── target/                      # gitignored build artifacts; verifier-matched keys must be supplied
│   └── vendor/poseidon/             # vendored Noir Poseidon (circomlib-compatible)
│
├── zkp-voting/                      # Anchor project (Layer 1 + tests)
    ├── Anchor.toml
    ├── Cargo.toml / Cargo.lock
    ├── package.json                 # npm scripts
    ├── programs/zkp-voting/
    │   └── src/{lib.rs, ballot.rs}
    ├── client/                      # off-chain JS helpers
    │   ├── tree.mjs                 # Merkle tree + Poseidon (poseidon-lite)
    │   ├── make_inputs.mjs          # build voting fixture + Prover.toml
    │   ├── make_tally_inputs.mjs    # build tally witness (Tonelli-Shanks + fold)
    │   ├── adversarial.mjs          # PDA/crypto property tests (no validator)
    │   └── check.mjs                # TS ↔ Noir Poseidon/Merkle vector parity
    ├── migrations/deploy.ts
    └── tests/
        ├── zkp-voting.ts            # validator-backed smoke/integration
        ├── compressed-ballot.ts     # full Light V2 cast_vote flow + replay
        ├── instructions.ts          # 20-case on-chain instruction matrix
        ├── tally.ts                 # post_tally end-to-end (circuit-verified)
        ├── sunspot.ts               # raw Groth16 verifier accept/reject
        ├── adversarial.ts           # PDA seed-boundary tests (no validator)
        └── README.md                # test-suite docs + runbook
│
├── app/                              # Next.js frontend (App Router)
    ├── public/idl/zkp_voting.json    # Anchor IDL (keep in sync with zkp-voting/)
    ├── public/proving/               # staged circuit artifacts for the WASM prover
    ├── src/app/
    │   ├── admin/page.tsx            # admin console (create → positions → voters → tally)
    │   ├── vote/page.tsx             # voter booth (manifest → identify → choose → cast)
    │   ├── results/page.tsx          # transcript + tally viewer
    │   └── api/                      # /api/prove (dev prover) + /api/cast-vote (relayer)
    ├── src/lib/
    │   ├── crypto/                   # TS mirror of voting_lib + tree.mjs
    │   ├── solana/                   # connection, program, PDAs, admin, castVote, relayer, events
    │   ├── light/                    # Light V2 helpers
    │   ├── proving/                  # Prover interface (NodeProver + WasmProver)
    │   └── manifest.ts               # election manifest schema + parser
    ├── src/components/               # wallet providers, topbar, stepper
    └── prisms/prover/                # gnark → WASM prover source (Go)
│
└── scripts/                          # verifier deployment/immutability checks
```

---

## Prerequisites

| Tool | Version / notes |
|---|---|
| Noir (`nargo`) | `1.0.0-beta.22` (required by Sunspot v1) |
| Sunspot | v1 CLI (`compile`, `setup`, `prove`, `deploy`, `verify`) |
| Solana / Anchor | Anchor CLI + SBF toolchain (`cargo build-sbf`) |
| Light Protocol | `@lightprotocol/zk-compression-cli` (`light test-validator`) |
| Node | ≥ 20 (tests use node 22) |
| Rust | stable (for `cargo test --lib`) |
| gnark verifier crate | path set via `GNARK_VERIFIER_BIN` for `sunspot deploy` |

All circuits pin `compiler_version = "1.0.0"` in their `Nargo.toml`, which
resolves to the required `1.0.0-beta.22` toolchain.

## The protocol in detail

### Cryptographic building blocks

- **Field / curve.** Everything lives in the BN254 scalar field
  `p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
  The embedded curve used for ElGamal is **Grumpkin** over that field:
  `y² = x³ − 17`, with generator `G = (1, 17631683881184975370165255887551781615748388533673675138860)`.
- **Hash.** Poseidon (`Bn254X5`, big-endian), chosen because it is SNARK-friendly
  **and** matches the Solana `alt_bn128`/`solana_poseidon` syscall. The same
  hash is used in three places that must agree byte-for-byte:
  Noir (vendored `poseidon`), the Rust program (`solana_poseidon::hashv`), and
  the TS helpers (`poseidon-lite`). `client/check.mjs` and the
  `poseidon_matches_circomlib_vector` nargo test guard this parity.
- **ElGamal (exponential variant).** A bit `b` is encrypted under public key
  `PK = sk·G` with randomness `r` as `(C1, C2) = (r·G, r·PK + b·G)`.
  Decryption computes `C2 − sk·C1 = b·G`, which is `G` for `1` and the point at
  infinity for `0`. Each candidate slot gets its own ciphertext.

### Domain separation tags

The same value in different roles must hash differently, so every role is
seeded with a distinct tag (kept in sync between `voting_lib` and the Rust code):

| Tag | Value | Used for |
|---|---|---|
| `TAG_LEAF` | 1 | `H(1, s)` — registration leaf |
| `TAG_NULL` | 2 | `H(2, s, election, position)` — one-time nullifier |
| `TAG_RAND` | 3 | `H(3, r_seed, slot)` — per-slot randomness |
| `TAG_BALLOT` | 4 | fold seed for the ballot commitment |
| `TAG_TRANSCRIPT` | 5 | fold seed for the running tally transcript |

### The five rules a vote must satisfy (`voting_circuit`)

1. **Eligibility** — `H(TAG_LEAF, s)` is a leaf of the frozen Merkle tree
   (`merkle_root(leaf, path) == frozen_root`). The 24-level path stays private.
2. **One vote per race** — the published nullifier is
   `H(TAG_NULL, s, election_id, position_id)`. Its uniqueness is enforced
   on-chain by using it in the compressed-account address seed.
3. **Right key** — the encryption key hashes to the on-chain `pk_hash`.
4. **Valid choice** — exactly one candidate selected, below `max_candidates`.
5. **Committed ballot** — the circuit itself encrypts the choice and proves the
   resulting ciphertext hashes to the published `ballot_commitment`.

### Ballot encoding

A ballot is `K_MAX = 4` slots × (C1.x, C1.y-parity, C2.x, C2.y-parity) = 16
fields. Only the compressed form is stored on-chain: 8 x-coordinates plus one
packed parity byte (`xs[8]` + `parity_bits: u8`). `ballot_commitment` folds
Poseidon over all 16 fields seeded with `TAG_BALLOT`.

### The tally transcript (the hardening)

When `cast_vote` accepts a ballot it folds
`transcript' = H(transcript, H(nullifier, commitment))`, starting from
`TAG_TRANSCRIPT`, and increments `ballot_count`. This produces a single running
hash that **binds the exact ordered set of accepted ballots**. `post_tally` is
then only allowed to store `totals` when a `tally_circuit` proof shows those
totals decrypt that transcript (see
[Tally correctness](#tally-correctness)).

## Layer 1 — the Solana program

Program ID: **`HyCme4fJ3PDgCR25aXrFmiumBuGVB8c7bggz4PkM8LW5`**, deployed to
Solana devnet and also loadable at the same address in the local test validator (Anchor, in
`programs/zkp-voting/src/{lib.rs, ballot.rs}`).

### Accounts

| Account | Seeds | Purpose |
|---|---|---|
| `ElectionConfig` | `["election", authority, election_id(le u64)]` | public key, voting window, frozen Merkle root + leaf count |
| `PositionConfig` | `["position", election, position_id(le u64)]` | race `max_candidates` |
| `BallotTranscript` | `["transcript", position]` | running Poseidon transcript + `ballot_count` |
| `TallyResult` | `["tally", position]` | published `totals[4]` + bound transcript |
| `BallotAccount` | Light V2 compressed, seed `["nullifier", position, nullifier]` | one compressed account per accepted ballot |
| `BallotCast` | event | `election`, `position`, `nullifier`, `xs`, `parity_bits` |

### Instructions

| Instruction | Signer | Behaviour |
|---|---|---|
| `initialize_election(election_id, pk_x, pk_y, vote_start_ts, vote_end_ts)` | authority | store key + window; require `start < end` and canonical key |
| `initialize_position(position_id, max_candidates)` | authority | require `1 ≤ max_candidates ≤ 4`; also init the transcript PDA |
| `freeze_voter_root(root, leaf_count)` | authority | require `now < vote_start`; publish root + `1 ≤ leaf_count ≤ 2²⁴` |
| `cast_vote(proof, nullifier, xs, parity_bits, validity_proof, address_tree_info, output_tree_index)` | payer | verify vote proof → fold transcript → Light V2 CPI → emit event |
| `post_tally(totals, proof)` | authority | require window ended + `Σtotals ≤ ballot_count` → verify tally proof → store totals |

`post_tally` was hardened from its original "trust the admin's numbers" form:
it no longer accepts a free-form transcript hash, and it cannot store `totals`
unless a `tally_circuit` proof decrypts the on-chain transcript.

### Public-witness ABIs (order matters)

The Sunspot/gnark verifier expects `proof ‖ witness`, where `witness` is a
12-byte header (two `u32` public-input counts) followed by 32-byte big-endian
field values.

- **voting_circuit** (7 inputs):
  `root, nullifier, election_id, position_id, max_candidates, pk_hash, commitment`
- **tally_circuit** (8 inputs):
  `transcript, ballot_count, max_candidates, pk_hash, totals[0..3]`

These layouts are defined in `ballot.rs` (`public_witness`,
`tally_public_witness`) and must mirror the `pub` parameter order in each
circuit's `main`.

### Error codes

`Unauthorized`, `AlreadyFrozen`, `NotFrozen`, `VotingClosed`,
`VotingStillOpen`, `BadWindow`, `InvalidLeafCount`, `FreezeWindowClosed`,
`PositionMismatch`, `CandidateOutOfBounds`, `NonCanonicalField`, `BadParity`,
`BadProofLength`, `InvalidVerifier`, `InvalidAddressTree`,
`NotEnoughAccountKeys`, `InvalidTally`, `BadTallyProofLength`, `PoseidonFailed`.

### Canonicality rules

Every field element stored or hashed on-chain is checked to be a **canonical**
BN254 field element (`< p`), and every parity slot must be `0` or `1`, so no
modulus-aliased or malformed value can sneak into a commitment.

---

## Layer 2 — the circuits

Noir workspace (`circuits/`), compiled to Groth16 and verified by pinned Sunspot
programs. `voting_lib` is the single source of truth so every circuit uses
byte-for-byte identical primitives.

- **`voting_circuit`** — the five rules above. Public witness = 7 fields.
  25 `nargo` tests (`vote_*` must pass, `fail_*` must fail).
- **`ballot_encoder`** — helper that turns `(pk, choice, r_seed)` into the
  compressed `xs` + parity used to feed the on-chain `cast_vote` and the tests.
- **`tally_circuit`** — decrypts each ballot in the transcript and sums the bits
  (10 `nargo` tests). See the next section.
- **`voting_lib`** — `leaf_of`, `nullifier_of`, `merkle_root`, `encrypt_slot`,
  `compress_point`, `ballot_commitment_of`, `validate_choices`,
  `ballot_fields_from_xs`, `decompress`, `decrypt_bit`, `transcript_*`.

### Verifier programs

`sunspot deploy <vk>` compiles the Groth16 verifying key into a Solana program
binary and keypair; it does not submit a transaction. Deploy the generated
`<name>.so` with `solana program deploy --program-id <name>-keypair.json` on the
intended cluster, then pin the printed program ID in the Anchor program and app.
Two verifiers are deployed and pinned:

| Circuit | Verifier program ID |
|---|---|
| `voting_circuit.vk` | `BmktzTCrmYeqxmDVfGwkKtVRnckNXk1PY5nb8TxCswKV` (devnet) |
| `tally_circuit.vk` | `AuSPaahFzAViTokdyhc6fYNe1gELiHRksbExo2YNptav` (devnet) |

Both must be available at these addresses on the selected cluster. The local
test-validator runbook loads the local verifier binaries at these pinned
addresses; the deployed program checks them with an `executable` + pinned-address
account constraint (`InvalidVerifier` otherwise).

These are the verifier IDs configured for devnet. Confirm that the programs are
available at those addresses on the cluster before running tests or the app.
Other clusters require verifier programs built for that cluster and matching IDs
in `lib.rs`, the app, and test fixtures. The repository's
`scripts/verify-verifier-ids.sh` checks configured deployment bytes and reports
authority status; `scripts/check-verifier-immutability.sh` checks whether the
verifier programs are immutable. Revoking an upgrade authority is irreversible.

## Tally correctness

The original `post_tally` trusted the admin: it accepted any `totals[4]` plus a
self-reported `transcript_hash`. Two changes make the tally verifiable:

1. **Layer 1 — the transcript.** `cast_vote` folds every accepted ballot into a
   `BallotTranscript` PDA, so the chain itself records *which ballots* (and how
   many) were counted.
2. **Layer 2 — the tally circuit.** `tally_circuit` takes the transcript as a
   public input and, for each ballot, **re-derives the commitment, decompresses
   each ciphertext point, decrypts it with `sk`, and asserts the vote is
   one-hot**, then sums the bits and asserts the sum equals the public `totals`.

The transcript is not admin-supplied: `cast_vote` folds the commitment it computed
from the submitted ciphertext (`xs` + parity), so the tally proof can only succeed
against the ordered commitments the program recorded.

`post_tally` stores `totals` only when the proof verifies against the **on-chain**
transcript and the configured verifier accepts it. This does not establish that
the admin enrolled every eligible voter or that the tally key stayed secret.

The circuit and program have a **fixed capacity of eight ballots per position**
(`N_BALLOTS` / `TALLY_CAPACITY`). Ballots beyond the on-chain `ballot_count` are
padding slots, excluded from the transcript fold and sum. The program rejects
additional ballots; elections with more than eight ballots per position are not
supported by this configuration. Decrypting needs `sk`, which is held off-chain
by the tally authority.

### Why not homomorphic on-chain aggregation?

ElGamal is additively homomorphic, so in principle the chain could sum
ciphertexts and decrypt `Σbits·G` once. That would scale better — but it needs
**Grumpkin** point arithmetic on-chain, and Solana's `alt_bn128` precompiles are
BN254-**G1**, not Grumpkin. So the per-ballot `tally_circuit` (whose verification
cost is independent of constraint count) is the pragmatic verifiable design today.

---

## Design decisions

| Decision | Why |
|---|---|
| ElGamal over Grumpkin | Additive homomorphism + fits the BN254 scalar field used by Noir's embedded curve |
| Exponential ElGamal (`b·G` in the exponent) | Decryption = a point compare (`C2 − sk·C1` is `G` or `∞`); no discrete-log per ballot |
| `sk` stays off-chain | The key is not written on-chain, but the tally authority can decrypt ballots and a leaked key compromises ballot secrecy |
| Per-slot randomness from `TAG_RAND` | Domain-separated randomness for each ciphertext slot |
| Poseidon everywhere | SNARK-friendly **and** available as a Solana syscall, so Noir ↔ Rust ↔ TS can agree exactly |
| Domain tags | Separate hashing contexts for leaf/nullifier/randomness/commitment/transcript roles |
| Frozen root **before** voting starts | Prevents an admin from adding voters mid-election (`FreezeWindowClosed`) |
| Compressed ballots (Light V2) | Ballots use compressed accounts; the nullifier seed prevents reusing the same nullifier |
| Layer-1 transcript | Turns "the chain accepted some ballots" into a single hash the tally proof can bind to |
| Separate tally verifier program | Each Groth16 verifying key is compiled into its own program, so two circuits = two pinned IDs |
| `N_BALLOTS = 8` fixed capacity | Verification cost is independent of constraints, so a modest fixed capacity keeps setup/proving practical |
| Sunspot `setup` | Unsafe for production; it generates a key that will not match a pinned verifier |
| Relayer signs + pays `cast_vote` | The voter's public key never appears on-chain — only the encrypted ballot + nullifier. The relayer key is server-only, never `NEXT_PUBLIC_*` |
| Election manifest (JSON) | One shareable artifact (root, `pk`, aspirants, leaves); the voter re-checks `root` against the on-chain frozen root, so an untrusted manifest can't smuggle in voters |
| One `Prover` interface, two backends | `NodeProver` → `/api/prove` (default; witness is sent to the server). `WasmProver` is selectable but vote proving is not end-to-end because browser witness generation is unfinished |
| Server-side tally proving | The current admin flow sends the tally witness, including `sk`, to `/api/prove`; this is a development/demo tradeoff, not a privacy-preserving deployment |
| Password-derived `s` (demo) | `s = Poseidon(SHA256(id), SHA256(password))`; the admin supplies the password so can re-derive any secret — acceptable for the demo, not production (use self-enrollment/passkeys) |
| Chain clock, not wall clock | The app uses chain block time for election-window checks |
| Scan program history for events | `events.ts` scans program transactions and filters `BallotCast` events by position |

---

## Security model & threat analysis

### What the configured circuits check

- A ballot's secret-derived leaf has a valid path to the configured frozen root.
- The same secret-derived nullifier cannot be used twice in a position.
- The published ciphertext is the encryption of the proven one-hot choice.
- The published tally matches the decryption of the ballots in the transcript.

### What is *enforced on-chain*

- Voting window, frozen root, canonical fields, pinned verifier programs.
- `Σtotals ≤ ballot_count` and inactive candidates must be `0`.

### Limits of those checks

- These checks rely on the configured circuit and verifier matching the reviewed
  source and the expected trusted setup. This repository does not document an
  independent security audit.
- The admin selects and freezes the voter list, can withhold/censor the manifest,
  and controls the tally secret key. The protocol does not prove that the list is
  complete or protect ballot secrecy from the tally authority.
- Program/verifier upgrade authorities and the app server remain part of the
  trust model; a pinned program ID alone does not establish immutability.

### Residual trust & known gaps

- **Trusted setup:** Sunspot's `setup` procedure is unsafe for production use.
  The exact setup provenance of a deployment must be established separately.
- **Light Protocol prover/validators** are trusted for compression correctness.
- **Ballot secrecy vs. a corrupt tally authority** — the authority can decrypt
  individual ballots (`sk`); the transcript/tally design guarantees *correctness*,
  not *authority-blindness*. Mixnets/resharing would be needed for stronger
  privacy from the tallier.
- **Receipt-freeness/coercion-resistance** are not implemented.
- **`N_BALLOTS` capacity** is fixed at eight ballots per position in this build.
- **Default prover privacy:** `/api/prove` receives the vote witness, including
  the secret derived from the voter's credentials.

### The security test suites

| Suite | What it attacks |
|---|---|
| `nargo test` (`voting_circuit`) | each of the 5 rules individually (wrong root/nullifier/key/choice/commitment) |
| `nargo test` (`tally_circuit`) | wrong totals/transcript/sk, two-selection, over-capacity |
| `client/adversarial.mjs` | Merkle path, nullifier/leaf domains, canonicality, order-sensitivity |
| `client/check.mjs` | TS ↔ Noir Poseidon/Merkle vector parity |
| `tests/instructions.ts` | full on-chain success/rejection matrix for all 5 instructions |
| `tests/compressed-ballot.ts` | real Light V2 cast, corrupted-proof rejection, nullifier replay rejection, transcript advance |
| `tests/tally.ts` | end-to-end `post_tally` (cast + circuit-verified totals) |
| `tests/sunspot.ts` | raw Groth16 verifier accepts valid proof, rejects mutated witness |
| `tests/adversarial.ts` | PDA seed-boundary invariants |

---

## Build & test runbook

The commands below assume the tool versions in [TOOLCHAIN.md](./TOOLCHAIN.md).
Generated files under `circuits/target/` are ignored by Git. Proof generation
requires proving artifacts for the configured verifier keys. In particular,
`tally_circuit.ccs` and `tally_circuit.pk` must be the matching pair for the
deployed tally verifier; obtain them from the original setup backup. They are
not included in this repository.

### 0. Install dependencies (once)

```bash
cd zkp-voting && npm install   # or yarn; Anchor + test dependencies
cd client   && npm install     # poseidon-lite etc. for the input generators
```

### 1. Run circuit and Rust unit tests

```bash
cd circuits
nargo test --workspace
nargo compile --package voting_circuit
nargo compile --package tally_circuit
cd ../zkp-voting
cargo test --lib
```

### 2. Generate proofs and run validator-backed tests

The `prepare:*` scripts run `nargo execute` and `sunspot prove`. They require
the `.ccs` and `.pk` files that match the verifier programs configured in the
Anchor program. The witness `.gz` is generated during execution. If the matching
proving key is missing, restore it from its original backup; running
`sunspot setup` creates a different key and will not produce proofs accepted by
the already deployed verifier.

```bash
cd zkp-voting
npm install
npm run prepare:test-proof
npm run prepare:tally-proof
```

For validator-backed suites, start `light test-validator` with the application
program and verifier binaries loaded at the configured IDs, then run the
commands in [Developer workflow](#developer-workflow). The validator and
verifier binaries are generated/deployment artifacts and are not supplied by
this repository.

Do not run `sunspot setup` or deploy a newly generated verifier as a way to
recover missing proving files. Replacing a verifier requires a deliberately
coordinated verifier/program update and does not change results or proofs for
an existing election.

### 3. Build the Anchor program and sync the IDL

```bash
cd zkp-voting
anchor build            # regenerates target/idl + target/types + deploy .so
cp target/idl/zkp_voting.json ../app/src/idl/zkp_voting.json
cp target/idl/zkp_voting.json ../app/public/idl/zkp_voting.json
cp target/types/zkp_voting.ts ../app/src/idl/zkp_voting.ts
```

### 4. Start the Light validator with both verifiers + the app

```bash
light test-validator \
  --sbf-program BmktzTCrmYeqxmDVfGwkKtVRnckNXk1PY5nb8TxCswKV ../circuits/target/voting_circuit.so \
  --sbf-program AuSPaahFzAViTokdyhc6fYNe1gELiHRksbExo2YNptav ../circuits/target/tally_circuit.so \
  --sbf-program HyCme4fJ3PDgCR25aXrFmiumBuGVB8c7bggz4PkM8LW5 target/deploy/zkp_voting.so
```

Keep it running, then in another terminal:

```bash
npm run test:light       # integration + compressed + instructions + pda
npm run test:tally       # post_tally end-to-end (re-prepares + proves + runs)
```

---

## Developer workflow

```bash
# unit / circuit tests (no validator needed)
cargo test --lib
nargo test --workspace
cd client && npm test        # check.mjs + adversarial.mjs (Poseidon/Merkle parity)

# on-chain suites (require the Light validator above)
npm run test:integration    # zkp-voting.ts
npm run test:compressed     # regenerate voting proof + compressed-ballot.ts
npm run test:instructions   # 20-case instruction matrix
npm run test:pda            # adversarial.ts (no validator)
npm run test:sunspot        # raw verifier accept/reject
npm run test:tally          # prepare proofs + tally.ts end-to-end
npm run test:light          # integration + compressed + instructions + pda
npm test                    # anchor test (zkp-voting.ts + adversarial.ts)

# regenerate proof artifacts
npm run prepare:test-proof   # voting fixture + Groth16 vote proof
npm run prepare:tally-proof  # tally witness + Groth16 tally proof
```

Environment variables used by the suites:

| Var | Default | Purpose |
|---|---|---|
| `ANCHOR_PROVIDER_URL` | `http://127.0.0.1:8899` | local test-validator RPC |
| `ANCHOR_WALLET` | `~/.config/solana/id.json` | payer |
| `LIGHT_INDEXER_URL` | `http://127.0.0.1:8784` | local test-validator indexer |
| `LIGHT_PROVER_URL` | `http://127.0.0.1:3001` | local test-validator prover |
| `ZKP_TEST_ELECTION_ID` | `Date.now()` | override the fixture election id |

---

## Configuration reference

| Constant | Value | Where |
|---|---|---|
| Program ID | `HyCme4fJ3PDgCR25aXrFmiumBuGVB8c7bggz4PkM8LW5` | `lib.rs` / `Anchor.toml` |
| Voting verifier | `BmktzTCrmYeqxmDVfGwkKtVRnckNXk1PY5nb8TxCswKV` (devnet) | `lib.rs` |
| Tally verifier | `AuSPaahFzAViTokdyhc6fYNe1gELiHRksbExo2YNptav` | `lib.rs` |
| `K_MAX` | 4 | `lib.rs`, `voting_lib` |
| `DEPTH` | 24 (⇒ `2²⁴` voters) | `voting_lib` |
| `XS_LEN` / `BALLOT_LEN` | 8 / 16 | `ballot.rs`, `voting_lib` |
| `N_BALLOTS` | 8 | `tally_circuit` |
| `TALLY_CAPACITY` | 8 | `lib.rs` |
| `MAX_PROOF_LEN` / `MAX_TALLY_PROOF_LEN` | 512 / 512 | `lib.rs` |
| Domain tags | 1…5 | `ballot.rs`, `voting_lib` |
| Address tree (test) | `amt2kaJA14v3urZbZvnc5v2np8jqvc4Z8zDep5wbtzx` | `compressed-ballot.ts` |

---

## Frontend (`app/`)

A Next.js 14 (App Router) TypeScript demonstration app for creating elections,
casting votes, and viewing on-chain transcript/tally state.
Three routes:

- **`/admin`** — create an election or reopen one created by the connected authority, then inspect status and post the tally.
- **`/vote`** — load the election manifest, identify, choose, review, cast.
- **`/results`** — upload or paste the election manifest to inspect the live transcript and on-chain verified tally.

### Why the frontend is built this way

| Decision | Why |
|---|---|
| **Relayer signs + pays `cast_vote`** | The voter's public key never appears on-chain — only the encrypted ballot + nullifier. The relayer wallet (`RELAYER_SECRET_KEY`) is server-only, never `NEXT_PUBLIC_*` |
| **Election manifest (JSON)** | One shareable artifact (root, `pk`, aspirants, leaves). The voter re-checks `root` against the on-chain frozen root, so an untrusted manifest can't smuggle in voters |
| **One `Prover` interface, two backends** | The default `NodeProver` sends the witness to `/api/prove`. A WASM backend exists, but browser witness generation is unfinished and vote proving is not end-to-end there. |
| **Server-side tally proving (demo)** | The current route sends the tally witness, including `sk`, to the app server; a browser prover could avoid that disclosure, but is not implemented |
| **Password-derived `s` (demo)** | `s = Poseidon(SHA256(id), SHA256(password))`. The admin supplies the password, so the admin can re-derive any secret — acceptable for the demo, not production (use self-enrollment/passkeys) |
| **Chain clock, not wall clock** | The Light validator's `Clock` drifts ahead; the app reads `getBlockTime` for window checks |
| **Scan program history for events** | `getSignaturesForAddress` omits LUT-loaded accounts on some RPCs; the program itself is always a static account key, so `events.ts` scans it and filters by position |

### Proving backends

- **`NodeProver` (default)** — `POST /api/prove` runs `nargo execute` + `sunspot prove`
  on the app server. The server receives the witness, which includes the voter's
  secret. It needs `nargo`, `sunspot`, `SUNSPOT_CIRCUITS_DIR`, and matching
  proving artifacts on the server.
- **`WasmProver`** — a gnark prover compiled to WASM and run in a Web Worker is
  present, but generating the Noir witness in the browser is unfinished. The
  vote flow is therefore not currently end-to-end with this backend.

### The relayer

`/api/cast-vote` takes only the **public** ballot payload (Groth16 proof, nullifier,
`xs`, parity) and the election/position/transcript addresses, then signs and pays a
versioned transaction with the relayer wallet. The full Light V2 recipe (address
tree, validity proof, LUT, `1_400_000` compute budget) lives in
`lib/solana/castVote.ts`, ported from `zkp-voting/tests/compressed-ballot.ts`.

### Admin flow (`/admin`)

1. **Connect** — Phantom or a pasted base58 secret key (the key becomes the election authority).
2. **Election** — reopen an election from the connected authority's list, or create one
   with a name, start delay, and duration. Creating generates a fresh tally key
   (`generateTallyKey`) and calls `initialize_election`; back up the displayed key.
3. **Positions** — one or more races, each with 1–4 aspirants; calls `initialize_position`.
4. **Voters** — one `name,id,password` per line; derives each leaf, builds the Merkle
   tree, then `freeze_voter_root` (must happen before voting starts).
5. **Status & tally** — reopen an election to load its on-chain positions and current
   results. To auto-tally after reopening, enter the backed-up secret key; the app checks
   it against the election's public key. Auto tally gathers `BallotCast` events in cast
   order (`fetchBallotCasts`), decrypts with `sk`, builds the `tally_circuit` witness
   (`buildTallyWitness`), proves, and `post_tally`s.

### Voter flow (`/vote`)

1. **Load & connect** — upload or paste the manifest; the app re-checks `root`
   against the on-chain frozen root and confirms the list is locked.
2. **Identify** — id + password → `deriveSecret` → leaf → Merkle path (all in-browser).
3. **Choose** — one aspirant per position.
4. **Review** — the browser prepares the witness and requests a Groth16 proof
   from the configured prover. With the default `NodeProver`, the witness is sent
   to the app server; the public ballot payload is then submitted to the relayer.
5. **Done** — success banner with the transaction signature and nullifier.

### Results flow (`/results`)

Upload or paste the manifest → the app reads `BallotTranscript` (ballot count) and
`TallyResult` (published totals) per position and renders them side by side. The
manifest supplies position titles and candidate labels; when an admin reopens an
election from chain without its manifest, the admin page can only show generic
position/candidate labels. It does not prevent tallying.
## Frontend setup & user guide

### Prerequisites

- Node ≥ 20 (use 22), npm.
- For the default server prover: `nargo` (`1.0.0-beta.22`) + `sunspot` on the
  server `PATH`, `SUNSPOT_CIRCUITS_DIR`, and the circuit JSON plus `.ccs` and
  `.pk` proving artifacts. The `.pk` must match the configured verifier.
  `nargo execute` generates the witness `.gz`.
- A running validator with the app + both verifiers preloaded (see the runbook).

### Devnet app setup

```bash
# Configure the app for the deployed devnet programs and Light services.
cd app
cp .env.local.example .env.local
# edit .env.local:
#   set a restricted Helius API key in the three NEXT_PUBLIC_* URLs
#   SUNSPOT_CIRCUITS_DIR=/absolute/path/to/zk-ballot-solana/circuits
#   RELAYER_SECRET_KEY=[ ...64 ed25519 numbers for a dedicated relayer... ]

# Fund the dedicated relayer address on devnet; do not use the program upgrade authority.
solana airdrop 2 <relayer-pubkey> --url https://api.devnet.solana.com

# Install, verify crypto parity, run.
npm install
npm run check          # crypto parity checks
npm run dev            # http://localhost:3000
```

### Devnet deployment

The voting program was upgraded on devnet, and a successful vote was confirmed
in project testing. The verifier IDs are pinned in source for that deployment.
On-chain deployment and upgrade-authority status can change; verify them on the
cluster before relying on them. The project's documented Sunspot setup is
unsafe for production use, and no independent audit is documented here.

Casting a vote also requires a ZK-Compression-capable devnet RPC/indexer/prover
and a separately funded relayer wallet. The sample config uses Helius; replace
`YOUR_HELIUS_API_KEY` with a restricted key. Because these URLs use
`NEXT_PUBLIC_*`, that key is visible to app users. Keep `RELAYER_SECRET_KEY`
server-only and do not reuse the program upgrade-authority wallet. Do not commit
`.env.local`, provider credentials, or wallet secret keys.

```bash
# Point the app at devnet + the Light devnet services, and your deployed IDs:
#   NEXT_PUBLIC_RPC_URL, NEXT_PUBLIC_LIGHT_INDEXER_URL, NEXT_PUBLIC_LIGHT_PROVER_URL
#   NEXT_PUBLIC_PROGRAM_ID, NEXT_PUBLIC_VOTING_VERIFIER_ID, NEXT_PUBLIC_TALLY_VERIFIER_ID
#   RELAYER_SECRET_KEY (a dedicated, funded devnet relayer)

cd app
npm run build
npm run start          # or deploy to Vercel with the same env vars
```

The devnet program and verifier IDs are pinned in `lib.rs`, the app
configuration, and the generated IDL. Replacing a verifier requires a
coordinated verifier/program update. The default prover needs `nargo` and
`sunspot` on the app server. The WASM vote flow is not yet a complete
on-device alternative.

If a Light Protocol upgrade makes the deployed voting program's Light SDK
incompatible, update the pinned `light-sdk` and Anchor versions to match the
cluster's Light System Program release in
`zkp-voting/programs/zkp-voting/Cargo.toml` and `zkp-voting/Anchor.toml`, rebuild,
sync the generated IDL files, then upgrade the same devnet program ID with its
upgrade-authority wallet:

```bash
cd zkp-voting
anchor build --arch sbf
cp target/idl/zkp_voting.json ../app/src/idl/zkp_voting.json
cp target/idl/zkp_voting.json ../app/public/idl/zkp_voting.json
cp target/types/zkp_voting.ts ../app/src/idl/zkp_voting.ts
solana program deploy target/deploy/zkp_voting.so \
  --program-id HyCme4fJ3PDgCR25aXrFmiumBuGVB8c7bggz4PkM8LW5 \
  --url devnet --keypair ~/.config/solana/id.json
```

For batched V2 address trees, the tree and queue can be the same account; pass
the same remaining-account index for both fields in `PackedAddressTreeInfo`.

### User guide

**Admin.** Open `/admin`, connect the authority wallet, and create an election or
open an existing one from the election list. Back up the displayed tally secret
key securely; it is not recoverable from the chain. For a reopened election,
restore the backed-up key in the status screen. Auto tally also requires the
matching tally proving artifacts and a configured prover. Share the downloaded
manifest with voters. Position and candidate labels are not stored on-chain, so
reopened elections without their manifest show generic labels.

**Voter.** Open `/vote`, connect any wallet (it is not used as the transaction
signer; the relayer pays), load the manifest, enter the id and password supplied
by the admin, choose one candidate per position, review, and cast. With the
default prover, the witness including the derived voter secret is sent to the
app server. Ballots are encrypted on-chain, but the tally authority can decrypt
individual ballots if it has the tally secret key.

**Observer.** Open `/results`, upload the election's `.json` manifest or paste its
contents, and read the frozen-root fingerprint, per-position ballot count, and
(once posted) the verified tally.

---

## Known limitations

- **Trusted setup:** the documented Sunspot `setup` procedure is unsafe for
  production. Setup provenance for a deployed verifier is not independently
  attested by this repository.
- **Ballot cap at 8 per position** (`TALLY_CAPACITY` in `lib.rs`, mirroring the
  tally circuit's `N_BALLOTS = 8`); the program rejects a ninth ballot per
  position with `TallyCapacityReached`.
- **No receipt-freeness / coercion resistance / verifiable decryption shares** — `sk`
  is held by a single tallier.
- **Password-derived voter secret** — the demo derives `s` from an admin-supplied
  id + password, so the admin (or anyone who learns the password) can re-derive a
  voter's secret. Production needs self-enrollment (share only the leaf) or a passkey.
- **Default proving path** — the `NodeProver` sends the witness to `/api/prove`
  (server-side `nargo` + `sunspot`). The WASM vote flow is incomplete because
  browser witness generation is not wired end-to-end.
- **Proving artifacts are not checked in.** Proof generation for a deployed
  verifier requires the matching `.ccs` and `.pk`; a newly generated setup will
  not match the verifier already pinned in this program.
- **Verifier deployment and upgrade authority** must be checked on the target
  cluster; the source's pinned ID alone does not establish current deployment or
  immutability.
- **Light Protocol V2** specifics (address tree id, CPI account layout) are pinned
  to the test environment used here.

---

## Troubleshooting

- **`TransactionExpiredTimeoutError` on success sends** — the surfpool validator
  does not confirm the same way `provider.sendAndConfirm` polls. Use the explicit
  `sendRawTransaction` + `confirmTransaction({blockhash, lastValidBlockHeight})`
  pattern (as in `tests/compressed-ballot.ts`).
- **`FreezeWindowClosed` / flaky time-sensitive tests** — the Light validator's
  `Clock.unix_timestamp` drifts ahead of wall clock. Read the on-chain clock
  (`SysvarC1ock…`, `unix_timestamp` at byte offset 32) for tight windows, or
  restart the validator before running.
- **`exceeded CUs meter` on `post_tally`** — the tally verifier consumes ~186k
  CUs; the transaction must set `ComputeBudgetProgram.setComputeUnitLimit(1_400_000)`.
- **`Account "transcript" not provided`** — `initialize_position` and `cast_vote`
  require the `BallotTranscript` PDA; derive it with seeds `["transcript", position]`.
- **`InvalidVerifier`** — the verifier `.so` isn't preloaded at the pinned address,
  or the pinned ID drifted after deploying the `.so` generated by `sunspot deploy`.
- **Missing `tally_circuit.ccs` or `.pk`** — restore the original matching
  artifacts from backup. Do not run `sunspot setup` to replace them; the new
  proving key will not match the configured verifier. `nargo execute` generates
  the witness `.gz`.
- **Verifier id changed after redeploy** — update the matching `SUNSPOT_*_VERIFIER_ID`
  in `lib.rs`, re-`anchor build`, and reload the `.so`.

---

## Disclaimer

This is a reference implementation for demonstration and testing. The documented
setup procedure uses an unsafe trusted setup, and no independent audit is
documented in this repository. Do not use it for real elections without a
reviewed production setup, independent security audit, and a threat model that
covers the residual-trust items above.

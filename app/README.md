# ZKP Voting — frontend (`app/`)

A Next.js (App Router) UI for the ZKP voting system. It talks to both layers:

- **Layer 1** — the Anchor program `zkp_voting` + Light Protocol V2 compressed accounts
  (`lib/solana`, `lib/light`).
- **Layer 2** — the Noir circuits + Sunspot Groth16 proofs (`lib/crypto`, `lib/proving`).

## Layout

```
app/
├── public/idl/zkp_voting.json   # copied from zkp-voting/target/idl (drift guard: keep in sync)
├── src/
│   ├── app/
│   │   ├── admin/               # create/resume elections; manage positions, voters, and tallies
│   │   ├── vote/                # voter wizard (load manifest → identify → choose → cast)
│   │   ├── results/             # upload/paste manifest; read-only transcript + tally view
│   │   └── api/prove/route.ts   # DEV proving service (nargo + sunspot)
│   ├── lib/
│   │   ├── crypto/              # TS mirror of voting_lib + tree.mjs (Poseidon, Grumpkin, Merkle, ballot)
│   │   ├── solana/              # connection, program, PDAs, admin actions, castVote (Light CPI)
│   │   ├── light/               # Light V2 helpers
│   │   ├── proving/             # Prover interface (NodeProver now, WasmProver later)
│   │   ├── manifest.ts          # the election manifest shared between admin and voter
│   │   └── config.ts            # program id, verifier ids, RPC/light URLs
│   └── components/              # providers (wallet), topbar, stepper
└── scripts/crypto-check.ts      # parity test vs. the Noir fixtures (run with `npm run check`)
```

## Run

```bash
cd app
cp .env.local.example .env.local   # set SUNSPOT_CIRCUITS_DIR to the repo's circuits/ dir
npm install
npm run check                      # crypto parity (must pass 11/11)
npm run dev                        # http://localhost:3000
```

The voter's **proof generation** uses the `/api/prove` route, which shells out to
`nargo execute` + `sunspot prove` on the machine running the app. This requires
`nargo` (1.0.0-beta.22) and `sunspot` on `PATH`, and `SUNSPOT_CIRCUITS_DIR` set to
the absolute path of `../circuits`. This is the **dev-only** path — it sends the
witness, including the voter secret, to the app server. Tally proof inputs are
also sent to that server. Do not treat this prover as a private production
deployment.

## Network configuration

The app's default program and verifier IDs target **Solana devnet**. The sample
`.env.local.example` also uses devnet endpoints; replace `YOUR_HELIUS_API_KEY`
with a restricted key for a ZK-Compression-capable RPC/indexer/prover. The key
is in `NEXT_PUBLIC_*` URLs and therefore visible to users.

Vote submission additionally requires a dedicated, funded devnet
`RELAYER_SECRET_KEY`. Keep it server-only and do not use the program
upgrade-authority wallet. Without the Light service URLs and relayer configured,
the app can read devnet but cannot complete a vote.

Sunspot's documented `setup` procedure is unsafe for production. The verifier
IDs are configured for devnet; verify their on-chain deployment and upgrade
authority before relying on them.
For local validator testing, use the local-validator instructions in the root
README and override the RPC/Light URLs explicitly.

## Proving strategy

The Groth16 proving key + circuit must match the **already deployed** Sunspot
verifiers (pinned IDs). Two backends, one interface (`lib/proving/types.ts`):

1. **NodeProver (default)** — delegates to `/api/prove`. The server receives the
   witness, including the voter secret. This is a development/demo path.
2. **WasmProver** — a gnark prover compiled to WASM (`app/prisms/prover/`) and a
   worker bridge are present. Browser-side Noir witness generation is not
   complete, so vote proving is not end-to-end with this backend. Do not assume
   setting `NEXT_PUBLIC_PROVER=wasm` makes the current vote flow private or usable.

The admin's **Auto tally** button gathers the `BallotCast` events in cast order
(`lib/solana/events.ts`), decrypts with the secret key and builds the `tally_circuit`
witness (`lib/tally.ts`), then submits the witness—including `sk`—to `/api/prove`
and posts the proof. Tally proving requires the `.ccs` and `.pk` matching the
configured tally verifier; these generated artifacts are not included in the
repository. Restore the original pair from backup. Do not run `sunspot setup` to
replace them.

## Known limitations

- **Password-derived secret:** the admin supplies `(name, id, password)`, so the
  admin can re-derive any voter's secret. Acceptable for the demo; production needs
  voter self-enrollment (share only the leaf) or a passkey.
- **8-ballot cap:** the tally circuit has a fixed `N_BALLOTS = 8`; the program
  rejects the 9th ballot (`TallyCapacityReached`).
- **Proving artifacts:** generated proving files are not tracked. Vote/tally proof
  generation needs `.ccs` and `.pk` files matching the configured verifier; a new
  `sunspot setup` will not produce a matching proving key.
- **Local toolchain:** the vote proof requires `nargo` + `sunspot` on the server
  and matching circuit artifacts. The WASM vote flow is not yet complete.
- **Resumed election labels:** the chain stores position IDs and candidate counts,
  not human-readable names. Reopening an election without its manifest displays
  generic labels; this does not change tally computation.

# Toolchain

Exact pinned versions for reproducing this project. Use these versions.

| Tool | Version / commit |
|---|---|
| Noir (`nargo`) | `1.0.0-beta.22` (noirc `c57152f91260ecdb9faad4efc20abb14b6d2ece7`) |
| Sunspot | commit `43891c5` (v1 CLI, `go/sunspot`) |
| gnark verifier crate | commit `43891c5` (`sunspot/gnark-solana/crates/verifier-bin`) |
| Anchor CLI | `0.31.1` |
| Anchor Rust crate | `0.31.2` |
| Solana CLI | `3.1.5` (Agave) |
| SBF architecture | `v0` (target used for the current devnet build) |
| Rust | `1.89.0` |
| Node | `22.23.1` |
| Light Protocol CLI | `@lightprotocol/zk-compression-cli 0.28.4` |
| Light System Program v2.3.0 SDK | `light-sdk 0.23.0` |
| Vendored Noir Poseidon | `v0.4.0` @ `e105cdd5c79c222860d53c5dfdb8fa8012b291c0` |

## Notes

- Noir `1.0.0-beta.22` is required by Sunspot v1. The circuits pin
  `compiler_version = "1.0.0"` in their `Nargo.toml`, which resolves to this toolchain.
- Install Noir with `noirup --version 1.0.0-beta.22`.
- `sunspot setup` performs an **unsafe** trusted setup. The documented setup
  procedure is for development/testing, not production. The repository does not
  independently attest to the setup provenance of deployed verifier programs;
  production requires a reviewed trusted setup (e.g. an MPC ceremony).
- `sunspot deploy` builds the Groth16 verifier `.so` and keypair via
  `cargo build-sbf`; it does not deploy to a cluster. It needs
  `GNARK_VERIFIER_BIN` pointing at the `gnark-solana/crates/verifier-bin` crate.
- The source pins verifier program IDs, but that does not establish their current
  on-chain deployment or upgrade-authority status. Check the target cluster
  before relying on either.
- Generated proving artifacts are not included in the repository.
  `sunspot prove` needs the circuit `.json`, witness `.gz`, `.ccs`, and a `.pk`
  matching the deployed verifier. `nargo execute` generates the witness `.gz`;
  do not run `sunspot setup` to replace a missing key for an already pinned
  verifier.

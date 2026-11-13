// Current devnet configuration. Values can be overridden via NEXT_PUBLIC_*
// env vars (see .env.local.example) and must match the deployed programs.

export const PROGRAM_ID =
  process.env.NEXT_PUBLIC_PROGRAM_ID ?? "HyCme4fJ3PDgCR25aXrFmiumBuGVB8c7bggz4PkM8LW5";

export const VOTING_VERIFIER_ID =
  process.env.NEXT_PUBLIC_VOTING_VERIFIER_ID ?? "BmktzTCrmYeqxmDVfGwkKtVRnckNXk1PY5nb8TxCswKV";

export const TALLY_VERIFIER_ID =
  process.env.NEXT_PUBLIC_TALLY_VERIFIER_ID ?? "AuSPaahFzAViTokdyhc6fYNe1gELiHRksbExo2YNptav";

export const ADDRESS_TREE_V2 =
  process.env.NEXT_PUBLIC_ADDRESS_TREE_V2 ?? "amt2kaJA14v3urZbZvnc5v2np8jqvc4Z8zDep5wbtzx";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
export const LIGHT_INDEXER_URL =
  process.env.NEXT_PUBLIC_LIGHT_INDEXER_URL ?? "https://devnet.helius-rpc.com";
export const LIGHT_PROVER_URL =
  process.env.NEXT_PUBLIC_LIGHT_PROVER_URL ?? "https://devnet.helius-rpc.com";

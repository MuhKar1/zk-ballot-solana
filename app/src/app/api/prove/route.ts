// Dev proving service. Generates a Groth16 proof by running the local Noir +
// Sunspot toolchain (nargo execute + sunspot prove) on the pinned circuit
// artifacts. Requires `nargo` and `sunspot` on PATH and SUNSPOT_CIRCUITS_DIR set.
//
// IMPORTANT: this sends the witness to the server. Production should replace it
// with the on-device WASM prover (gnark compiled to wasm) so the voter secret
// never leaves the browser.

import { NextResponse } from "next/server";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toToml(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (typeof value === "string") return `"${value}"`;
  if (Array.isArray(value)) return `[${value.map(toToml).join(", ")}]`;
  return `"${String(value)}"`;
}

export async function POST(req: Request) {
  let body: { circuit?: string; inputs?: Record<string, unknown> };
  try {
    body = (await req.json()) as { circuit?: string; inputs?: Record<string, unknown> };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const circuit = body.circuit;
  if (circuit !== "voting" && circuit !== "tally") {
    return NextResponse.json({ error: "circuit must be 'voting' or 'tally'" }, { status: 400 });
  }

  const circuitsDir = process.env.SUNSPOT_CIRCUITS_DIR;
  if (!circuitsDir) {
    return NextResponse.json({ error: "SUNSPOT_CIRCUITS_DIR is not set" }, { status: 500 });
  }

  const pkg = circuit === "voting" ? "voting_circuit" : "tally_circuit";
  const target = join(circuitsDir, "target");
  const tomlPath = join(circuitsDir, pkg, "Prover.toml");

  const sunspotCheck = spawnSync("sunspot", ["--help"], { stdio: "ignore" });
  const sunspotError = sunspotCheck.error as NodeJS.ErrnoException | undefined;
  if (sunspotError?.code === "ENOENT") {
    return NextResponse.json(
      { error: "Sunspot v1 is not installed or not on the server PATH. Install the pinned toolchain and restart the app." },
      { status: 500 }
    );
  }
  if (sunspotError) {
    return NextResponse.json({ error: `Couldn't start Sunspot: ${sunspotError.message}` }, { status: 500 });
  }

  const requiredArtifacts = [`${pkg}.json`, `${pkg}.ccs`, `${pkg}.pk`];
  const missingArtifacts = requiredArtifacts.filter((file) => !existsSync(join(target, file)));
  if (missingArtifacts.length > 0) {
    return NextResponse.json(
      {
        error: `Missing ${pkg} proving artifacts: ${missingArtifacts.join(", ")}. Use artifacts matching the deployed verifier; do not run sunspot setup to generate a replacement key.`,
      },
      { status: 500 }
    );
  }

  let original: string | null = null;
  try {
    original = readFileSync(tomlPath, "utf8");
  } catch {
    original = null;
  }

  try {
    const lines = Object.entries(body.inputs ?? {}).map(([key, value]) => `${key} = ${toToml(value)}`);
    writeFileSync(tomlPath, lines.join("\n") + "\n");

    execFileSync("nargo", ["execute", "--package", pkg], { cwd: circuitsDir, stdio: "pipe" });
    execFileSync(
      "sunspot",
      ["prove", join(target, `${pkg}.json`), join(target, `${pkg}.gz`), join(target, `${pkg}.ccs`), join(target, `${pkg}.pk`)],
      { stdio: "pipe" }
    );

    const proof = readFileSync(join(target, `${pkg}.proof`));
    return NextResponse.json({ proof: proof.toString("base64") });
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    const detail = typeof e?.stderr === "string" ? e.stderr : e?.message ?? String(err);
    return NextResponse.json({ error: detail }, { status: 500 });
  } finally {
    if (original !== null) writeFileSync(tomlPath, original);
  }
}

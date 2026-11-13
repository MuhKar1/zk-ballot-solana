"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSolanaWallet } from "./providers";

export function Topbar() {
  const router = useRouter();
  const pathname = usePathname();
  const { wallet, balance, disconnect } = useSolanaWallet();
  const routeHistory = useRef<string[]>([]);
  const previousPath = useRef<string | null>(null);
  const expectedPath = useRef<string | null>(null);

  useEffect(() => {
    if (previousPath.current === null) {
      previousPath.current = pathname;
      routeHistory.current = [pathname];
      return;
    }

    if (pathname === previousPath.current) return;

    previousPath.current = pathname;
    if (expectedPath.current === pathname) {
      expectedPath.current = null;
      return;
    }
    routeHistory.current.push(pathname);
  }, [pathname]);

  function goBack() {
    const previousRoute =
      routeHistory.current.length > 1
        ? routeHistory.current[routeHistory.current.length - 2]
        : "/";

    if (pathname === "/") return;

    routeHistory.current.pop();
    expectedPath.current = previousRoute;
    router.push(previousRoute);
  }

  return (
    <header className="topbar">
      <Link href="/" className="brand">
        ZKP<span className="accent">·</span>Voting
      </Link>
      <div className="row">
        <button
          className="btn btn-ghost"
          onClick={goBack}
          disabled={pathname === "/"}
          aria-label="Go back to the previous page"
        >
          ← Back
        </button>
        {wallet ? (
          <>
            <span className="badge ok" title={wallet.publicKey.toBase58()}>
              {wallet.publicKey.toBase58().slice(0, 4)}…
              {wallet.publicKey.toBase58().slice(-4)}
            </span>
            {balance !== null && <span className="badge">{balance.toFixed(3)} SOL</span>}
            <button className="btn btn-ghost" onClick={disconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <span className="badge">not connected</span>
        )}
      </div>
    </header>
  );
}

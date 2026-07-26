// SPDX-License-Identifier: MIT
//
// Shared adoption of a thirdweb sign-in as the app's maker signer. Both views (Harbor journey
// and LP Desk) mount one of these, so signing in works from either header. Enclave signs,
// the practice fork transports; empty accounts get seeded exactly like the injected path.
import { useEffect, useRef } from "react";
import { useActiveAccount } from "thirdweb/react";
import {
    provider, session, seedConnectedWallet, connectExternalSigner, disconnectToDemo, readWallet,
} from "./doca";
import { ThirdwebSigner } from "./thirdweb-signer";

export type MakerEvent =
    | { kind: "seeding" }
    | { kind: "seeded" }
    | { kind: "signed-in"; address: string }
    | { kind: "signed-out" }
    | { kind: "error"; message: string };

export function useThirdwebMaker(onEvent?: (e: MakerEvent) => void): void {
    const twAccount = useActiveAccount();
    const installedRef = useRef<string | null>(null);

    useEffect(() => {
        if (twAccount && session.maker !== twAccount.address) {
            (async () => {
                try {
                    connectExternalSigner(new ThirdwebSigner(twAccount, provider), twAccount.address);
                    installedRef.current = twAccount.address;
                    const w = await readWallet();
                    if (w.weth === 0n && w.usdc === 0n) {
                        onEvent?.({ kind: "seeding" });
                        await seedConnectedWallet();
                        onEvent?.({ kind: "seeded" });
                    }
                    onEvent?.({ kind: "signed-in", address: twAccount.address });
                } catch (e) {
                    const err = e as { shortMessage?: string; message?: string };
                    onEvent?.({ kind: "error", message: String(err?.shortMessage ?? err?.message ?? e).slice(0, 90) });
                }
            })();
        } else if (!twAccount && installedRef.current && session.maker === installedRef.current) {
            installedRef.current = null;
            disconnectToDemo();
            onEvent?.({ kind: "signed-out" });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [twAccount]);
}

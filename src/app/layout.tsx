import type { Metadata } from "next";
import { NavBar } from "@/ui/components/NavBar";
import { WalletProvider } from "@/ui/wallet/WalletProvider";
import "./globals.css";

export const metadata: Metadata = {
    title: "Agent Spending Control",
    description: "Delegate an event budget to an AI agent — limits enforced by code and PolicyVault, every decision on record.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
    return (
        <html lang="en">
            <body>
                <WalletProvider>
                    <NavBar />
                    <main className="container">{children}</main>
                </WalletProvider>
            </body>
        </html>
    );
}

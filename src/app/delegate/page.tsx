import type { Metadata } from "next";
import { DelegateView } from "@/ui/delegate/DelegateView";

export const metadata: Metadata = { title: "Delegate · Agent Spending Control" };

export default function DelegatePage() {
    return <DelegateView />;
}

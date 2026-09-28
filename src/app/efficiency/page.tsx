import type { Metadata } from "next";
import { EfficiencyView } from "@/ui/efficiency/EfficiencyView";

export const metadata: Metadata = { title: "Efficiency · Agent Spending Control" };

export default function EfficiencyPage() {
    return <EfficiencyView />;
}

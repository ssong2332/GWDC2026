import type { Metadata } from "next";
import { DashboardView } from "@/ui/dashboard/DashboardView";

export const metadata: Metadata = { title: "Dashboard · Agent Spending Control" };

export default function DashboardPage() {
    return <DashboardView />;
}

import type { Metadata } from "next";
import { Suspense } from "react";
import { Loading } from "@/ui/components/AsyncView";
import { AuditView } from "@/ui/audit/AuditView";

export const metadata: Metadata = { title: "Audit · Agent Spending Control" };

// useSearchParams (the shareable ?tx=) needs a Suspense boundary in the App Router.
export default function AuditPage() {
    return (
        <Suspense fallback={<Loading label="Loading…" />}>
            <AuditView />
        </Suspense>
    );
}

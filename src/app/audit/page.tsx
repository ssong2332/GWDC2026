import { Suspense } from "react";
import { Loading } from "@/ui/components/AsyncView";
import { AuditView } from "@/ui/audit/AuditView";

// useSearchParams (the shareable ?tx=) needs a Suspense boundary in the App Router.
// Tab title comes from the view in the selected language (F-17 ⑩); the fallback's "Loading…" follows the language too.
export default function AuditPage() {
    return (
        <Suspense fallback={<Loading />}>
            <AuditView />
        </Suspense>
    );
}

import { handleEfficiency } from "../_lib/handlers";
import { withContainer } from "../_lib/route";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    return withContainer((c) => handleEfficiency(c));
}

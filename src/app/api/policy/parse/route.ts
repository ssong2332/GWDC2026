import { handleParsePolicy } from "../../_lib/handlers";
import { withContainer } from "../../_lib/route";

export async function POST(req: Request): Promise<Response> {
    return withContainer((c) => handleParsePolicy(c, req));
}

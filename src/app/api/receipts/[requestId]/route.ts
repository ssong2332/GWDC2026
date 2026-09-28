import { handleReceipt } from "../../_lib/handlers";
import { withContainer } from "../../_lib/route";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ requestId: string }> }): Promise<Response> {
    const { requestId } = await ctx.params;
    return withContainer((c) => handleReceipt(c, requestId));
}

import { handleAudit } from "../../_lib/handlers";
import { withContainer } from "../../_lib/route";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ txHash: string }> }): Promise<Response> {
    const { txHash } = await ctx.params;
    return withContainer((c) => handleAudit(c, txHash));
}

import { getContainer, type AppContainer } from "@/server/container";
import { errorResponse } from "./http";

/** Resolves the server container per request; a container failure (env, deployment file) is mapped like any error. */
export async function withContainer(fn: (c: AppContainer) => Promise<Response>): Promise<Response> {
    let c: AppContainer;
    try {
        c = getContainer();
    } catch (err) {
        return errorResponse(err);
    }
    return fn(c);
}

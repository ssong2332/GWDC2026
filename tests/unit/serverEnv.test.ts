import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/core/errors";

// `server-only` throws outside the react-server condition (ADR-0005); the Next bundler resolves it to an
// empty module, so the test does the same.
vi.mock("server-only", () => ({}));

const { loadServerEnv } = await import("@/server/env");

describe("loadServerEnv (src/server/env.ts — D-16 enforced at startup)", () => {
    it("parses the server variables when no private key is present", () => {
        expect(loadServerEnv({ CHAIN: "localhost", KILN_MODE: "fake" })).toMatchObject({ chain: "localhost", kiln: { mode: "fake" } });
    });

    it.each(["AGENT_PRIVATE_KEY", "OWNER_PRIVATE_KEY"])("refuses to start when %s is in the server environment", (name) => {
        const secret = `0x${"33".repeat(32)}`;
        let caught: unknown;
        try {
            loadServerEnv({ [name]: secret });
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(AppError);
        expect((caught as AppError).code).toBe("PRIVATE_KEY_IN_SERVER_ENV");
        expect((caught as AppError).message).toContain(".env.cli");
        expect((caught as AppError).message).not.toContain(secret);
    });

    it("an empty key line (KEY=) is not a key", () => {
        expect(loadServerEnv({ AGENT_PRIVATE_KEY: "", OWNER_PRIVATE_KEY: "" }).chain).toBe("localhost");
    });
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    test: {
        environment: "node",
        include: ["tests/integration/**/*.test.ts"],
        // Layer ③ shares one Hardhat node (port 8546) whose clock and agent nonce the tests read,
        // so files run one after another.
        globalSetup: ["tests/integration/setup/hardhat-node.ts"],
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});

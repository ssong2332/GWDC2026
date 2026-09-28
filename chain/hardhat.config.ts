import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";

const config: HardhatUserConfig = {
    solidity: "0.8.24",
    paths: {
        artifacts: "./build/artifacts",
        cache: "./build/cache",
    },
};

export default config;

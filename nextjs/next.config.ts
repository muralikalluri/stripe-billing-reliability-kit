import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["pg", "pg-boss"],
};

export default config;

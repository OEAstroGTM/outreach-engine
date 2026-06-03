import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Allow Vercel's file tracer to include client context files from the parent repo
  outputFileTracingRoot: path.join(__dirname, ".."),
};

export default nextConfig;

#!/usr/bin/env node
// Local stdio entry point. The hosted endpoint is http.js.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

await buildServer().connect(new StdioServerTransport());

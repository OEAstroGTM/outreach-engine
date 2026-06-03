import { readFileSync, existsSync } from "fs";
import path from "path";

// Clients folder lives one level above the web app in the repo
const CLIENTS_DIR = path.join(process.cwd(), "..", "clients");

const CONTEXT_FILES = [
  "overview.md",
  "positioning.md",
  "icp.md",
  "voice.md",
  "intelligence/objections.md",
  "intelligence/winning-themes.md",
];

export function loadClientContext(clientSlug: string): string {
  const clientDir = path.join(CLIENTS_DIR, clientSlug);
  if (!existsSync(clientDir)) return "";

  const sections: string[] = [];
  for (const file of CONTEXT_FILES) {
    const filepath = path.join(clientDir, file);
    if (existsSync(filepath)) {
      const content = readFileSync(filepath, "utf8").trim();
      if (content) sections.push(`### ${file}\n${content}`);
    }
  }

  if (sections.length === 0) return "";
  return `## Client Context: Intellectible\n\n${sections.join("\n\n")}`;
}

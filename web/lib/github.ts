const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const GITHUB_ORG = process.env.GITHUB_ORG!;
const BASE = "https://api.github.com";

const headers = () => ({
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
});

export function repoName(clientName: string) {
  return `client-${clientName.toLowerCase().replace(/\s+/g, "-")}`;
}

export async function createClientRepo(clientName: string): Promise<{ url: string } | { error: string }> {
  const name = repoName(clientName);
  const r = await fetch(`${BASE}/orgs/${GITHUB_ORG}/repos`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name, private: true, description: `Client data for ${clientName}`, auto_init: true }),
  });
  if (!r.ok) {
    // Try user repos if org fails
    const r2 = await fetch(`${BASE}/user/repos`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name, private: true, description: `Client data for ${clientName}`, auto_init: true }),
    });
    if (!r2.ok) return { error: await r2.text() };
    const data = await r2.json();
    return { url: data.html_url };
  }
  const data = await r.json();
  return { url: data.html_url };
}

export async function listClients(): Promise<string[]> {
  const r = await fetch(`${BASE}/user/repos?per_page=100&type=owner`, { headers: headers() });
  const repos = await r.json();
  return repos
    .filter((repo: { name: string }) => repo.name.startsWith("client-"))
    .map((repo: { name: string }) => repo.name.replace("client-", ""));
}

export async function readClientFile(clientName: string, path: string): Promise<string | null> {
  const repo = repoName(clientName);
  const r = await fetch(`${BASE}/repos/${GITHUB_ORG}/${repo}/contents/${path}`, { headers: headers() });
  if (!r.ok) return null;
  const data = await r.json();
  return Buffer.from(data.content, "base64").toString("utf-8");
}

export async function writeClientFile(clientName: string, path: string, content: string, message: string): Promise<{ ok: boolean }> {
  const repo = repoName(clientName);
  // Get current SHA if file exists
  let sha: string | undefined;
  const existing = await fetch(`${BASE}/repos/${GITHUB_ORG}/${repo}/contents/${path}`, { headers: headers() });
  if (existing.ok) {
    const data = await existing.json();
    sha = data.sha;
  }
  const r = await fetch(`${BASE}/repos/${GITHUB_ORG}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });
  return { ok: r.ok };
}

export async function listClientFiles(clientName: string, path = ""): Promise<string[]> {
  const repo = repoName(clientName);
  const r = await fetch(`${BASE}/repos/${GITHUB_ORG}/${repo}/contents/${path}`, { headers: headers() });
  if (!r.ok) return [];
  const data = await r.json();
  return data.map((f: { path: string }) => f.path);
}

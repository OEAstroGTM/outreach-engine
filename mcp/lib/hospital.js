import { ok, err } from './core.js';

const HOSPITAL_BASE = 'https://mailbox-hospital.vercel.app';
const USER = process.env.HOSPITAL_USER;
const PASS = process.env.HOSPITAL_PASSWORD;

function auth() {
  if (!USER || !PASS) throw new Error('HOSPITAL_USER/HOSPITAL_PASSWORD required');
  return `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
}

async function fetch_hospital(path, params = {}) {
  const url = new URL(`${HOSPITAL_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.append(k, v));
  const res = await fetch(url, {
    headers: { Authorization: auth(), 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`Hospital ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

export async function hospitalStatus(runId) {
  return fetch_hospital('/api/hospital/status', { run_id: runId });
}

export async function hospitalReport(runId) {
  return fetch_hospital('/api/hospital/report', { run_id: runId });
}

export async function hospitalEvents(runId, limit = 100) {
  return fetch_hospital('/api/hospital/events', { run_id: runId, limit });
}

export async function hospitalRuns(limit = 50, offset = 0) {
  return fetch_hospital('/api/runs', { limit, offset });
}

export async function retiredRecords(days = 30, client) {
  return fetch_hospital('/api/hospital/retired', { days, client });
}

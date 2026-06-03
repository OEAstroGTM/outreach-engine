"use client";

import { useState, useRef, useEffect } from "react";

type Message = { role: "user" | "assistant"; text: string };
type Activity = { type: "tool_call" | "tool_result"; name: string; data: unknown };
type Campaign = {
  id: number; name: string; status: string;
  emails_sent: number; total_leads: number; total_leads_contacted: number;
  unique_replies: number; interested: number; bounced: number; completion_percentage: number;
};
type Lead = { name: string; email: string; company: string; status: string; campaign: string; reply_date: string };
type Card = { type: "campaigns"; campaigns: Campaign[] } | { type: "leads"; client: unknown; leads: Lead[] };

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [activityOpen, setActivityOpen] = useState(true);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const activityEnd = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, cards]);
  useEffect(() => { activityEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [activity]);

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;
    const userMsg: Message = { role: "user", text: input };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setCards([]);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setLoading(true);

    const apiMessages = newMessages.map((m) => ({ role: m.role, content: m.text }));
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: apiMessages }),
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let assistantText = "";
    setMessages((prev) => [...prev, { role: "assistant", text: "" }]);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = JSON.parse(line.slice(6));
        if (data.type === "text") {
          assistantText += data.text;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: "assistant", text: assistantText };
            return updated;
          });
        } else if (data.type === "tool_call") {
          setActivity((prev) => [...prev, { type: "tool_call", name: data.name, data: data.input }]);
        } else if (data.type === "tool_result") {
          setActivity((prev) => [...prev, { type: "tool_result", name: data.name, data: data.result }]);
        } else if (data.type === "campaigns_card") {
          setCards((prev) => [...prev, { type: "campaigns", campaigns: data.campaigns }]);
        } else if (data.type === "leads_card") {
          setCards((prev) => [...prev, { type: "leads", client: data.client, leads: data.leads }]);
        }
      }
    }
    setLoading(false);
  }

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg)", overflow: "hidden" }}>
      {/* Main chat column */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, borderRight: "1px solid var(--border)" }}>

        {/* Header */}
        <header style={{
          display: "flex", alignItems: "center", gap: 12, padding: "14px 20px",
          borderBottom: "1px solid var(--border)", background: "var(--surface)",
          flexShrink: 0,
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://outreachengine.co/assets/logo-full-ghBZLqO4.webp"
            alt="Outreach Engine"
            style={{ height: 28, objectFit: "contain" }}
          />
          <div style={{
            width: 1, height: 20,
            background: "var(--border)",
            marginLeft: 4,
          }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>Brain</span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#22c55e", display: "inline-block", boxShadow: "0 0 6px #22c55e88" }} />
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Live</span>
          </div>
        </header>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          {messages.length === 0 && (
            <div style={{ textAlign: "center", marginTop: 60 }}>
              <div style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 56, height: 56, borderRadius: 16, marginBottom: 16,
                background: "linear-gradient(135deg, #3c83f6, #5e76ed)",
              }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a10 10 0 1 0 10 10"/><path d="m15 9-3 3-3-3"/><path d="M12 12v-2"/><circle cx="19" cy="5" r="3" fill="white" stroke="none"/>
                </svg>
              </div>
              <p style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8 }}>
                What&apos;s on the agenda?
              </p>
              <p style={{ fontSize: 14, color: "var(--text-secondary)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>
                List campaigns, check replies, pull leads, research a company, or analyze performance across all clients.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 20 }}>
                {["Show me today's interested leads", "List active campaigns", "Research a company website"].map((s) => (
                  <button key={s} onClick={() => { setInput(s); textareaRef.current?.focus(); }}
                    style={{
                      padding: "8px 14px", borderRadius: 20, fontSize: 12, fontWeight: 500,
                      background: "var(--surface-2)", color: "var(--text-secondary)",
                      border: "1px solid var(--border)", cursor: "pointer",
                    }}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
              {m.role === "assistant" && (
                <div style={{
                  width: 28, height: 28, borderRadius: 8, flexShrink: 0, marginRight: 10, marginTop: 2,
                  background: "linear-gradient(135deg, #3c83f6, #5e76ed)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>
                  </svg>
                </div>
              )}
              <div style={{
                maxWidth: "72%",
                padding: "12px 16px",
                borderRadius: m.role === "user" ? "18px 18px 4px 18px" : "4px 18px 18px 18px",
                fontSize: 14,
                lineHeight: 1.65,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                ...(m.role === "user"
                  ? { background: "linear-gradient(135deg, #3c83f6, #5e76ed)", color: "#fff" }
                  : { background: "var(--surface)", color: "var(--text-primary)", border: "1px solid var(--border)", boxShadow: "var(--card-shadow)" }
                ),
              }}>
                {m.text || <ThinkingDots />}
              </div>
            </div>
          ))}

          {/* Cards */}
          {cards.map((card, i) => (
            <div key={i} style={{ paddingLeft: 38 }}>
              {card.type === "campaigns" && (
                <>
                  <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                    Campaigns
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {card.campaigns.map((c) => <CampaignCard key={c.id} campaign={c} />)}
                  </div>
                </>
              )}
              {card.type === "leads" && (
                <>
                  <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                    Leads — {String(card.client)}
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {card.leads.map((l, j) => <LeadCard key={j} lead={l} />)}
                  </div>
                </>
              )}
            </div>
          ))}

          <div ref={messagesEnd} />
        </div>

        {/* Input */}
        <div style={{
          padding: "12px 16px", borderTop: "1px solid var(--border)",
          background: "var(--surface)", flexShrink: 0,
        }}>
          <div style={{
            display: "flex", gap: 10, alignItems: "flex-end",
            background: "var(--input-bg)", border: "1px solid var(--border-2)",
            borderRadius: 16, padding: "10px 14px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
            transition: "border-color 0.15s",
          }}>
            <textarea
              ref={textareaRef}
              rows={1}
              style={{
                flex: 1, background: "transparent", border: "none", outline: "none",
                resize: "none", fontSize: 14, color: "var(--text-primary)",
                lineHeight: 1.6, fontFamily: "inherit",
                maxHeight: 160, overflowY: "auto",
              }}
              placeholder="Ask the brain anything…"
              value={input}
              onChange={(e) => { setInput(e.target.value); autoResize(); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
              disabled={loading}
            />
            <button
              onClick={sendMessage}
              disabled={loading || !input.trim()}
              style={{
                width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                background: loading || !input.trim() ? "var(--surface-2)" : "linear-gradient(135deg, #3c83f6, #5e76ed)",
                border: "none", cursor: loading || !input.trim() ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all 0.15s",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={loading || !input.trim() ? "var(--text-muted)" : "white"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </button>
          </div>
          <p style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center", marginTop: 8 }}>
            Shift+Enter for new line · Enter to send
          </p>
        </div>
      </div>

      {/* Activity log */}
      <div style={{
        width: activityOpen ? 300 : 44, flexShrink: 0,
        display: "flex", flexDirection: "column",
        background: "var(--activity-bg)",
        borderLeft: "1px solid var(--border)",
        transition: "width 0.2s ease",
        overflow: "hidden",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "14px 14px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}>
          {activityOpen && (
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", whiteSpace: "nowrap", flex: 1, letterSpacing: "0.04em", textTransform: "uppercase" }}>
              Activity
            </span>
          )}
          <button
            onClick={() => setActivityOpen(!activityOpen)}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "var(--text-muted)", marginLeft: activityOpen ? 0 : "auto" }}
            title={activityOpen ? "Collapse" : "Expand"}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {activityOpen ? <path d="M13 17l5-5-5-5M6 17l5-5-5-5"/> : <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/>}
            </svg>
          </button>
        </div>

        {activityOpen && (
          <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {activity.length === 0 && (
              <div style={{ textAlign: "center", marginTop: 20, color: "var(--text-muted)", fontSize: 12 }}>
                Tool calls appear here
              </div>
            )}
            {activity.map((a, i) => (
              <div key={i} style={{
                borderRadius: 10, padding: "10px 12px",
                background: "var(--surface)", border: "1px solid var(--border)",
                boxShadow: "var(--card-shadow)",
              }}>
                <div style={{
                  display: "flex", alignItems: "center", gap: 6, marginBottom: 6,
                  fontSize: 11, fontWeight: 700,
                  color: a.type === "tool_call" ? "#f59e0b" : "#22c55e",
                }}>
                  <span style={{
                    width: 5, height: 5, borderRadius: "50%",
                    background: a.type === "tool_call" ? "#f59e0b" : "#22c55e",
                    flexShrink: 0,
                  }} />
                  <span style={{ fontFamily: "monospace", letterSpacing: "0.02em" }}>{a.name}</span>
                </div>
                <pre style={{
                  fontSize: 10, color: "var(--text-secondary)",
                  overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
                  margin: 0, fontFamily: "monospace", lineHeight: 1.5,
                }}>
                  {JSON.stringify(a.data, null, 2).slice(0, 220)}
                </pre>
              </div>
            ))}
            <div ref={activityEnd} />
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingDots() {
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center", padding: "2px 0" }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{
          width: 6, height: 6, borderRadius: "50%",
          background: "var(--text-muted)",
          display: "inline-block",
          animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
        }} />
      ))}
      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </span>
  );
}

function CampaignCard({ campaign: c }: { campaign: Campaign }) {
  const isActive = c.status === "active";
  const replyRate = c.total_leads_contacted > 0
    ? ((c.unique_replies / c.total_leads_contacted) * 100).toFixed(1)
    : "0.0";

  return (
    <div style={{
      background: "var(--card)", borderRadius: 14,
      border: "1px solid var(--border)", boxShadow: "var(--card-shadow)",
      overflow: "hidden",
    }}>
      {/* Accent bar */}
      <div style={{
        height: 3,
        background: isActive ? "linear-gradient(90deg, #3c83f6, #5e76ed)" : "var(--border-2)",
      }} />
      <div style={{ padding: "14px 16px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", lineHeight: 1.35 }}>{c.name}</span>
          <span style={{
            flexShrink: 0, fontSize: 11, padding: "2px 8px", borderRadius: 20, fontWeight: 600,
            background: isActive ? "rgba(34,197,94,0.12)" : "var(--surface-2)",
            color: isActive ? "#16a34a" : "var(--text-muted)",
          }}>
            {c.status}
          </span>
        </div>

        {/* Progress bar */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, fontSize: 11, color: "var(--text-muted)" }}>
            <span>{c.total_leads_contacted.toLocaleString()} / {c.total_leads.toLocaleString()} leads contacted</span>
            <span style={{ fontWeight: 600 }}>{c.completion_percentage.toFixed(0)}%</span>
          </div>
          <div style={{ height: 5, background: "var(--surface-2)", borderRadius: 99, overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 99,
              width: `${Math.min(c.completion_percentage, 100)}%`,
              background: isActive ? "linear-gradient(90deg, #3c83f6, #5e76ed)" : "var(--border-2)",
              transition: "width 0.4s ease",
            }} />
          </div>
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
          <StatBox label="Total Emails" value={c.emails_sent.toLocaleString()} />
          <StatBox label="Replies" value={c.unique_replies.toString()} />
          <StatBox label="Reply %" value={`${replyRate}%`} highlight={parseFloat(replyRate) > 1} />
          <StatBox label="Interested" value={c.interested.toString()} highlight={c.interested > 0} />
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{
      background: "var(--surface-2)", borderRadius: 10, padding: "8px 10px", textAlign: "center",
    }}>
      <div style={{
        fontSize: 15, fontWeight: 700, marginBottom: 2,
        color: highlight ? "#3c83f6" : "var(--text-primary)",
      }}>{value}</div>
      <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 500 }}>{label}</div>
    </div>
  );
}

function LeadCard({ lead: l }: { lead: Lead }) {
  const statusStyles: Record<string, { bg: string; color: string }> = {
    "Interested":       { bg: "rgba(34,197,94,0.1)",  color: "#16a34a" },
    "Not Interested":   { bg: "rgba(239,68,68,0.1)",  color: "#dc2626" },
    "Meeting Request":  { bg: "rgba(60,131,246,0.1)", color: "#3c83f6" },
    "Follow Up":        { bg: "rgba(245,158,11,0.1)", color: "#d97706" },
    "Auto Reply":       { bg: "var(--surface-2)",     color: "var(--text-muted)" },
  };
  const style = statusStyles[l.status] ?? { bg: "var(--surface-2)", color: "var(--text-muted)" };
  const initials = (l.name || l.email).split(" ").map((w: string) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div style={{
      background: "var(--card)", borderRadius: 12,
      border: "1px solid var(--border)", boxShadow: "var(--card-shadow)",
      padding: "10px 14px", display: "flex", alignItems: "center", gap: 12,
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 10, flexShrink: 0,
        background: "linear-gradient(135deg, #3c83f6, #5e76ed)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12, fontWeight: 700, color: "white",
      }}>
        {initials}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {l.name || l.email}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {l.company}{l.company && l.campaign ? " · " : ""}{l.campaign}
        </div>
      </div>
      <span style={{
        flexShrink: 0, fontSize: 11, padding: "3px 10px", borderRadius: 20,
        fontWeight: 600, background: style.bg, color: style.color,
      }}>
        {l.status}
      </span>
    </div>
  );
}

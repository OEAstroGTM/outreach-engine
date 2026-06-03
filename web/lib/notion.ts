// CLIENT_MAP — used by the digest route to map client names → workspace IDs.
// Sourced from clients.json (duplicated here to avoid filesystem reads at module level).

export interface ClientConfig {
  masterinboxWsId: number | null;
  ebWsId:          number | null;
  sequencer:       string;
}

export const CLIENT_MAP: Record<string, ClientConfig> = {
  "AskTuring":              { masterinboxWsId: 620,  ebWsId: 31,   sequencer: "eb_send"     },
  "Braintracks":            { masterinboxWsId: 1073, ebWsId: 11,   sequencer: "eb_send"     },
  "Bravura Technologies":   { masterinboxWsId: 664,  ebWsId: 33,   sequencer: "eb_send"     },
  "Chalktalk":              { masterinboxWsId: 355,  ebWsId: 26,   sequencer: "eb_send"     },
  "Coffee & Contracts":     { masterinboxWsId: 58,   ebWsId: 4,    sequencer: "eb_personal" },
  "Dream It Reel":          { masterinboxWsId: 1077, ebWsId: 24,   sequencer: "eb_send"     },
  "Hubengage":              { masterinboxWsId: 1076, ebWsId: 20,   sequencer: "eb_send"     },
  "Intellectible":          { masterinboxWsId: 1058, ebWsId: 28,   sequencer: "eb_send"     },
  "Lend Home Improvements": { masterinboxWsId: 1074, ebWsId: 7,    sequencer: "eb_personal" },
  "Nuvo Bath":              { masterinboxWsId: 825,  ebWsId: 6,    sequencer: "eb_personal" },
  "OR Trax":                { masterinboxWsId: 1057, ebWsId: 23,   sequencer: "eb_send"     },
  "Outreach Engine":        { masterinboxWsId: 1013, ebWsId: 5,    sequencer: "eb_send"     },
  "ParGo":                  { masterinboxWsId: 552,  ebWsId: 32,   sequencer: "eb_send"     },
  "Savanti Travel":         { masterinboxWsId: 121,  ebWsId: 7,    sequencer: "eb_send"     },
  "Simplexity":             { masterinboxWsId: 1061, ebWsId: null, sequencer: "instantly"   },
  "Supply Wisdom":          { masterinboxWsId: 1059, ebWsId: null, sequencer: "instantly"   },
  "True Dial":              { masterinboxWsId: 56,   ebWsId: 3,    sequencer: "eb_send"     },
  "Westlink":               { masterinboxWsId: 1049, ebWsId: 8,    sequencer: "eb_send"     },
  "Carengen":               { masterinboxWsId: 190,  ebWsId: 35,   sequencer: "eb_send"     },
  "Clinintell":             { masterinboxWsId: 61,   ebWsId: 48,   sequencer: "eb_send"     },
};

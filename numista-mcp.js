import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

const NUMISTA_API_KEY = process.env.NUMISTA_API_KEY;

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------
const BASE_URL = "https://api.numista.com";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_COUNT = 100;                 // tetto massimo per `count` (risultati/pagina)
const DEFAULT_COUNT = 50;
const MIN_PAGE = 1;
const MAX_ITEMS_IN_RESPONSE = 100;     // tetto di troncamento delle liste in risposta
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 30;

// ---------------------------------------------------------------------------
// Logging strutturato
// IMPORTANTE: il server usa il transport stdio, quindi `stdout` è riservato al
// protocollo MCP. I log vanno SOLO su `stderr` (o su file), mai su stdout.
// ---------------------------------------------------------------------------
const LOG_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_THRESHOLD = LOG_ORDER[LOG_LEVEL] ?? LOG_ORDER.info;

function log(level, event, extra = {}) {
  if (LOG_ORDER[level] < LOG_THRESHOLD) return;
  const entry = { ts: new Date().toISOString(), level, event, ...extra };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

// Maschera i segreti prima di loggare gli argomenti (es. access token OAuth).
function sanitizeArgs(args) {
  const out = { ...args };
  if (out.access_token) out.access_token = "****";
  return out;
}

// ---------------------------------------------------------------------------
// Limiti di input (validazione + clamp)
// ---------------------------------------------------------------------------
function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(min, Math.trunc(n)), max);
}

// ---------------------------------------------------------------------------
// Rate limiting verso l'API upstream (token bucket)
// ---------------------------------------------------------------------------
class TokenBucket {
  constructor(capacity, refillPerMinute) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerMs = refillPerMinute / 60000;
    this.last = Date.now();
  }
  tryAcquire() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true };
    }
    return { allowed: false, retryAfterMs: Math.ceil((1 - this.tokens) / this.refillPerMs) };
  }
}
const rateLimiter = new TokenBucket(RATE_LIMIT_PER_MIN, RATE_LIMIT_PER_MIN);

class RateLimitError extends Error {
  constructor(retryAfterMs) {
    super(`Rate limit raggiunto verso Numista, riprova tra ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Livello HTTP: rate limit + timeout + logging della richiesta
// ---------------------------------------------------------------------------
async function apiGet(url, { headers, tool }) {
  const acq = rateLimiter.tryAcquire();
  if (!acq.allowed) {
    log("warn", "rate_limited", { tool, retryAfterMs: acq.retryAfterMs });
    throw new RateLimitError(acq.retryAfterMs);
  }
  const started = Date.now();
  log("debug", "api.request", { tool, url });
  const response = await axios.get(url, { headers, timeout: REQUEST_TIMEOUT_MS });
  log("info", "api.response", { tool, url, status: response.status, latency_ms: Date.now() - started });
  return response;
}

// ---------------------------------------------------------------------------
// Formattazione risposta: troncamento liste + paginazione esplicita
// ---------------------------------------------------------------------------
const LIST_KEYS = ["data", "results", "items", "types", "issues", "coins", "issuers", "collections", "banknotes", "exonumia"];

function extractList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    for (const key of LIST_KEYS) {
      if (Array.isArray(raw[key])) return raw[key];
    }
  }
  return null;
}

// Se la risposta è una lista -> envelope { total, truncated, hasMore, items }
// (+ page/count/nextPage per i tool paginati). Se è un singolo oggetto -> lo
// restituisce invariato, preservando la forma originale dell'API.
function toContent(data, { page, count } = {}) {
  const items = extractList(data);
  if (items === null) {
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }

  const total =
    (data && typeof data.total === "number") ? data.total :
    (data && typeof data.count === "number") ? data.count :
    items.length;

  const truncated = items.length > MAX_ITEMS_IN_RESPONSE;
  const shown = truncated ? items.slice(0, MAX_ITEMS_IN_RESPONSE) : items;

  let hasMore;
  if (page !== undefined && count !== undefined) {
    hasMore = (typeof total === "number" && page * count < total) || items.length === count;
  } else {
    hasMore = truncated;
  }

  const out = { total, truncated, hasMore, items: shown };
  if (page !== undefined) { out.page = page; out.nextPage = hasMore ? page + 1 : null; }
  if (count !== undefined) out.count = count;
  return { content: [{ type: "text", text: JSON.stringify(out) }] };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "numista-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Definizione dei tool esposti all'IA
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_numista_coins",
        description: "Cerca monete sul catalogo Numista tramite parola chiave o codice N# (API v1 legacy)",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Termine di ricerca (es. '2 euro Italia 2025')" }
          },
          required: ["query"]
        }
      },
      {
        name: "search_numista_types",
        description: "Cerca tipi nel catalogo Numista v3 con filtri avanzati",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Parola chiave di ricerca" },
            issuer: { type: "string", description: "Codice emittente (es. italia, germania)" },
            year: { type: "string", description: "Anno o range (es. 2020, 2010-2020)" },
            lang: { type: "string", description: "Lingua: en, es, fr", default: "en" },
            page: { type: "integer", description: "Pagina risultati", default: 1 },
            count: { type: "integer", description: "Risultati per pagina max 100", default: 50 }
          },
          required: []
        }
      },
      {
        name: "get_type_details",
        description: "Ottieni dettagli completi di un tipo catalogo per ID",
        inputSchema: {
          type: "object",
          properties: {
            type_id: { type: "integer", description: "ID tipo Numista" },
            lang: { type: "string", description: "Lingua: en, es, fr", default: "en" }
          },
          required: ["type_id"]
        }
      },
      {
        name: "get_type_issues",
        description: "Ottieni le emissioni di un tipo catalogo",
        inputSchema: {
          type: "object",
          properties: {
            type_id: { type: "integer", description: "ID tipo Numista" },
            lang: { type: "string", description: "Lingua: en, es, fr", default: "en" }
          },
          required: ["type_id"]
        }
      },
      {
        name: "get_issue_prices",
        description: "Ottieni prezzi stimati per un'emissione",
        inputSchema: {
          type: "object",
          properties: {
            type_id: { type: "integer", description: "ID tipo" },
            issue_id: { type: "integer", description: "ID emissione" },
            currency: { type: "string", description: "Codice valuta ISO 4217, default EUR" },
            lang: { type: "string", description: "Lingua: en, es, fr", default: "en" }
          },
          required: ["type_id", "issue_id"]
        }
      },
      {
        name: "list_issuers",
        description: "Elenca gli emittenti del catalogo",
        inputSchema: {
          type: "object",
          properties: {
            lang: { type: "string", description: "Lingua: en, es, fr", default: "en" }
          },
          required: []
        }
      },
      {
        name: "get_commemorative_euro_coin",
        description: "Recupera le monete euro commemorative filtrando per taglio, anno e nazionalità",
        inputSchema: {
          type: "object",
          properties: {
            denomination: { type: "string", description: "Taglio euro commemorativo (es. '2', '5', '10')" },
            year: { type: "string", description: "Anno di emissione (es. 2023) o range" },
            nationality: { type: "string", description: "Codice emittente (es. italia, germania, france)" },
            lang: { type: "string", description: "Lingua: en, es, fr", default: "en" },
            page: { type: "integer", description: "Pagina risultati", default: 1 },
            count: { type: "integer", description: "Risultati per pagina", default: 50 }
          },
          required: []
        }
      },
      {
        name: "get_user_collections",
        description: "Ottieni elenco collezioni di un utente Numista (richiede OAuth)",
        inputSchema: {
          type: "object",
          properties: {
            user_id: { type: "integer", description: "ID utente Numista" },
            access_token: { type: "string", description: "OAuth access token con scope view_collection" }
          },
          required: ["user_id", "access_token"]
        }
      },
      {
        name: "get_collected_items",
        description: "Ottieni gli oggetti posseduti da un utente (richiede OAuth)",
        inputSchema: {
          type: "object",
          properties: {
            user_id: { type: "integer", description: "ID utente Numista" },
            access_token: { type: "string", description: "OAuth access token con scope view_collection" },
            collection_id: { type: "integer", description: "ID collezione opzionale" },
            category: { type: "string", description: "Categoria: coin, banknote, exonumia", enum: ["coin","banknote","exonumia"] }
          },
          required: ["user_id", "access_token"]
        }
      }
    ]
  };
});

// ---------------------------------------------------------------------------
// Dispatch dei tool (logica di chiamata)
// ---------------------------------------------------------------------------
async function dispatch(name, args) {
  const headers = { "Numista-API-Key": NUMISTA_API_KEY };

  if (name === "search_numista_coins") {
    const query = args.query;
    const response = await apiGet(`${BASE_URL}/api/v1/coins?q=${encodeURIComponent(query)}`, { headers, tool: name });
    return toContent(response.data);
  }

  if (name === "search_numista_types") {
    const page = clampInt(args.page, { min: MIN_PAGE, max: 1000000, fallback: 1 });
    const count = clampInt(args.count, { min: 1, max: MAX_COUNT, fallback: DEFAULT_COUNT });
    const params = new URLSearchParams();
    if (args.query) params.append("q", args.query);
    if (args.issuer) params.append("issuer", args.issuer);
    if (args.year) params.append("year", args.year);
    params.append("lang", args.lang || "en");
    params.append("page", page);
    params.append("count", count);
    const response = await apiGet(`${BASE_URL}/v3/types?${params.toString()}`, { headers, tool: name });
    return toContent(response.data, { page, count });
  }

  if (name === "get_type_details") {
    const { type_id } = args;
    const lang = args.lang || "en";
    const response = await apiGet(`${BASE_URL}/v3/types/${type_id}?lang=${lang}`, { headers, tool: name });
    return toContent(response.data);
  }

  if (name === "get_type_issues") {
    const { type_id } = args;
    const lang = args.lang || "en";
    const response = await apiGet(`${BASE_URL}/v3/types/${type_id}/issues?lang=${lang}`, { headers, tool: name });
    return toContent(response.data);
  }

  if (name === "get_issue_prices") {
    const { type_id, issue_id } = args;
    const currency = args.currency || "EUR";
    const lang = args.lang || "en";
    const params = new URLSearchParams({ currency, lang });
    const response = await apiGet(`${BASE_URL}/v3/types/${type_id}/issues/${issue_id}/prices?${params.toString()}`, { headers, tool: name });
    return toContent(response.data);
  }

  if (name === "list_issuers") {
    const lang = args.lang || "en";
    const response = await apiGet(`${BASE_URL}/v3/issuers?lang=${lang}`, { headers, tool: name });
    return toContent(response.data);
  }

  if (name === "get_commemorative_euro_coin") {
    const page = clampInt(args.page, { min: MIN_PAGE, max: 1000000, fallback: 1 });
    const count = clampInt(args.count, { min: 1, max: MAX_COUNT, fallback: DEFAULT_COUNT });
    const params = new URLSearchParams();
    const denomination = args.denomination || "2";
    params.append("q", `${denomination} euro commemorative`);
    if (args.nationality) params.append("issuer", args.nationality);
    if (args.year) params.append("year", args.year);
    params.append("lang", args.lang || "en");
    params.append("page", page);
    params.append("count", count);
    const response = await apiGet(`${BASE_URL}/v3/types?${params.toString()}`, { headers, tool: name });
    return toContent(response.data, { page, count });
  }

  if (name === "get_user_collections") {
    const { user_id, access_token } = args;
    const authHeaders = { ...headers, Authorization: `Bearer ${access_token}` };
    const response = await apiGet(`${BASE_URL}/v3/users/${user_id}/collections`, { headers: authHeaders, tool: name });
    return toContent(response.data);
  }

  if (name === "get_collected_items") {
    const { user_id, access_token, collection_id, category } = args;
    const authHeaders = { ...headers, Authorization: `Bearer ${access_token}` };
    const params = new URLSearchParams();
    if (collection_id) params.append("collection", collection_id);
    if (category) params.append("category", category);
    const url = `${BASE_URL}/v3/users/${user_id}/collected_items${params.toString() ? "?" + params.toString() : ""}`;
    const response = await apiGet(url, { headers: authHeaders, tool: name });
    return toContent(response.data);
  }

  throw new Error(`Tool non trovato: ${name}`);
}

// ---------------------------------------------------------------------------
// Handler delle chiamate tool: logging strutturato + errori unificati
// ---------------------------------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};
  const started = Date.now();
  log("info", "tool.call.start", { tool: name, args: sanitizeArgs(args) });

  try {
    const result = await dispatch(name, args);
    log("info", "tool.call.end", { tool: name, duration_ms: Date.now() - started, status: "ok" });
    return result;
  } catch (err) {
    const httpStatus = err.response?.status;
    log("error", "tool.call.error", {
      tool: name,
      duration_ms: Date.now() - started,
      status: "error",
      message: err.message,
      httpStatus
    });
    const detail = err.response?.data ? ` ${JSON.stringify(err.response.data)}` : "";
    const text = err instanceof RateLimitError ? `Rate limit: ${err.message}` : `Errore: ${err.message}${detail}`;
    return { content: [{ type: "text", text }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
async function main() {
  if (!NUMISTA_API_KEY) {
    log("warn", "startup.no_api_key", { hint: "Imposta la variabile d'ambiente NUMISTA_API_KEY" });
  }
  log("info", "server.start", { name: "numista-mcp", version: "1.0.0", log_level: LOG_LEVEL });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "server.ready", { transport: "stdio" });
}

main();

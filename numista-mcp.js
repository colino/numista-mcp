import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

const NUMISTA_API_KEY = process.env.NUMISTA_API_KEY;

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

// Gestione dell'esecuzione dei tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};
  const headers = { "Numista-API-Key": NUMISTA_API_KEY };

  try {
    if (name === "search_numista_coins") {
      const query = args.query;
      const response = await axios.get(`https://api.numista.com/api/v1/coins?q=${encodeURIComponent(query)}`, { headers });
      return { content: [{ type: "text", text: JSON.stringify(response.data) }] };
    }

    if (name === "search_numista_types") {
      const params = new URLSearchParams();
      if (args.query) params.append("q", args.query);
      if (args.issuer) params.append("issuer", args.issuer);
      if (args.year) params.append("year", args.year);
      if (args.lang) params.append("lang", args.lang);
      else params.append("lang", "en");
      if (args.page) params.append("page", args.page);
      if (args.count) params.append("count", args.count);
      const response = await axios.get(`https://api.numista.com/v3/types?${params.toString()}`, { headers });
      return { content: [{ type: "text", text: JSON.stringify(response.data) }] };
    }

    if (name === "get_type_details") {
      const { type_id, lang = "en" } = args;
      const response = await axios.get(`https://api.numista.com/v3/types/${type_id}?lang=${lang}`, { headers });
      return { content: [{ type: "text", text: JSON.stringify(response.data) }] };
    }

    if (name === "get_type_issues") {
      const { type_id, lang = "en" } = args;
      const response = await axios.get(`https://api.numista.com/v3/types/${type_id}/issues?lang=${lang}`, { headers });
      return { content: [{ type: "text", text: JSON.stringify(response.data) }] };
    }

    if (name === "get_issue_prices") {
      const { type_id, issue_id, currency = "EUR", lang = "en" } = args;
      const params = new URLSearchParams({ currency, lang });
      const response = await axios.get(`https://api.numista.com/v3/types/${type_id}/issues/${issue_id}/prices?${params.toString()}`, { headers });
      return { content: [{ type: "text", text: JSON.stringify(response.data) }] };
    }

    if (name === "list_issuers") {
      const lang = args.lang || "en";
      const response = await axios.get(`https://api.numista.com/v3/issuers?lang=${lang}`, { headers });
      return { content: [{ type: "text", text: JSON.stringify(response.data) }] };
    }

    if (name === "get_commemorative_euro_coin") {
      const params = new URLSearchParams();
      const denomination = args.denomination || "2";
      params.append("q", `${denomination} euro commemorative`);
      if (args.nationality) params.append("issuer", args.nationality);
      if (args.year) params.append("year", args.year);
      if (args.lang) params.append("lang", args.lang);
      else params.append("lang", "en");
      if (args.page) params.append("page", args.page);
      if (args.count) params.append("count", args.count);
      const response = await axios.get(`https://api.numista.com/v3/types?${params.toString()}`, { headers });
      return { content: [{ type: "text", text: JSON.stringify(response.data) }] };
    }

    if (name === "get_user_collections") {
      const { user_id, access_token } = args;
      const authHeaders = { ...headers, Authorization: `Bearer ${access_token}` };
      const response = await axios.get(`https://api.numista.com/v3/users/${user_id}/collections`, { headers: authHeaders });
      return { content: [{ type: "text", text: JSON.stringify(response.data) }] };
    }

    if (name === "get_collected_items") {
      const { user_id, access_token, collection_id, category } = args;
      const params = new URLSearchParams();
      if (collection_id) params.append("collection", collection_id);
      if (category) params.append("category", category);
      const url = `https://api.numista.com/v3/users/${user_id}/collected_items${params.toString() ? "?" + params.toString() : ""}`;
      const authHeaders = { ...headers, Authorization: `Bearer ${access_token}` };
      const response = await axios.get(url, { headers: authHeaders });
      return { content: [{ type: "text", text: JSON.stringify(response.data) }] };
    }

    throw new Error("Tool non trovato");
  } catch (err) {
    const msg = err.response?.data || err.message;
    return { content: [{ type: "text", text: `Errore: ${JSON.stringify(msg)}` }] };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
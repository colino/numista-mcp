# Numista MCP Server

Server Model Context Protocol che espone tool per interrogare il catalogo Numista tramite la sua API v3 (con fallback v1 legacy).

## Cosa fa

Il server comunica via stdio con un client MCP e offre tool per catalogo, prezzi, emittenti e collezioni personali.

Tool disponibili:
- `search_numista_coins`: cerca monete via API v1 legacy `https://api.numista.com/api/v1/coins?q=...`
- `search_numista_types`: ricerca tipi catalogo v3 con filtri avanzati
- `get_type_details`: dettagli completi di un tipo per ID
- `get_type_issues`: emissioni di un tipo
- `get_issue_prices`: prezzi stimati per emissione
- `list_issuers`: elenco emittenti
- `get_commemorative_euro_coin`: monete euro commemorative con filtro taglio, anno e nazionalità
- `get_user_collections`: collezioni utente (OAuth)
- `get_collected_items`: oggetti posseduti utente (OAuth)

La chiave API è letta da variabile d’ambiente `NUMISTA_API_KEY`. Gli endpoint utente richiedono anche OAuth Bearer token.

## Prerequisiti

- Node.js 18+
- Chiave API Numista valida

## Installazione

```bash
# nella cartella del progetto
cd C:\myProjects\numista-mcp

# installa dipendenze
npm install
```

Crea un file `.env` o imposta la variabile d’ambiente:

```bash
# Windows PowerShell
$env:NUMISTA_API_KEY = "la_tua_chiave"

# oppure .env con dotenv
echo NUMISTA_API_KEY=la_tua_chiave > .env
npm i dotenv
```

Se usi dotenv, aggiungi in cima a `numista-mcp.js`:
```js
import 'dotenv/config';
```

## Avvio

```bash
node numista-mcp.js
```

Il server resta in ascolto su stdio.

## Uso con un client MCP

Esempio di configurazione per un client che usa stdio:

```json
{
  "mcpServers": {
    "numista": {
      "command": "node",
      "args": ["C:\\myProjects\\numista-mcp\\numista-mcp.js"],
      "env": {
        "NUMISTA_API_KEY": "la_tua_chiave"
      }
    }
  }
}
```

Una volta connesso, il client può chiamare i tool, esempi:

**search_numista_coins**
```json
{ "query": "2 euro Italia 2025" }
```

**search_numista_types**
```json
{ "query": "2 euro", "issuer": "italia", "year": "2023", "lang": "en", "page": 1, "count": 50 }
```

**get_type_details**
```json
{ "type_id": 12345, "lang": "en" }
```

**get_type_issues**
```json
{ "type_id": 12345 }
```

**get_issue_prices**
```json
{ "type_id": 12345, "issue_id": 67890, "currency": "EUR" }
```

**list_issuers**
```json
{}
```

**get_commemorative_euro_coin**
```json
{ "denomination": "2", "year": "2023", "nationality": "italia", "lang": "en" }
```

**get_user_collections**
```json
{ "user_id": 123, "access_token": "Bearer_token_con_scope_view_collection" }
```

**get_collected_items**
```json
{ "user_id": 123, "access_token": "Bearer_token", "collection_id": 1001, "category": "coin" }
```

## Miglioramenti possibili

- Gestione errori e timeout su axios, validazione input
- Controllo presenza `NUMISTA_API_KEY` all’avvio
- Logging strutturato e limiti/paginazione
- Schemi output con Zod e documentazione dei risultati
- Cache in memoria per ridurre chiamate
- Supporto completo OAuth token refresh

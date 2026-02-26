/**
 * Deno Flux Starter - Backend Server
 *
 * This is a Deno HTTP/WebSocket server that provides real-time transcription
 * by proxying audio streams between the client and Deepgram's Flux API.
 *
 * Key Features:
 * - WebSocket endpoint: /api/flux
 * - Bidirectional audio/transcription streaming
 * - JWT session auth for API protection
 * - Native TypeScript support
 * - No external web framework needed
 */

import { load } from "dotenv";
import TOML from "npm:@iarna/toml@2.2.5";
import * as jose from "jose";

// Load environment variables
await load({ export: true });

// ============================================================================
// CONFIGURATION - Customize these values for your needs
// ============================================================================

/**
 * Deepgram Flux WebSocket URL (v2 endpoint)
 */
const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v2/listen";

/**
 * Server configuration - These can be overridden via environment variables
 */
interface ServerConfig {
  port: number;
  host: string;
}

const config: ServerConfig = {
  port: parseInt(Deno.env.get("PORT") || "8081"),
  host: Deno.env.get("HOST") || "0.0.0.0",
};

// ============================================================================
// SESSION AUTH - JWT tokens for API protection
// ============================================================================

const SESSION_SECRET = Deno.env.get("SESSION_SECRET") || crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
const SESSION_SECRET_KEY = new TextEncoder().encode(SESSION_SECRET);

const JWT_EXPIRY = "1h";

let indexHtmlTemplate: string | null = null;
try {
  indexHtmlTemplate = await Deno.readTextFile(
    new URL("./frontend/dist/index.html", import.meta.url).pathname
  );
} catch {
  // No built frontend (dev mode)
}

/**
 * Creates a signed JWT session token
 */
async function createSessionToken(): Promise<string> {
  return await new jose.SignJWT({ iat: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(JWT_EXPIRY)
    .sign(SESSION_SECRET_KEY);
}

/**
 * Verifies a JWT session token
 */
async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jose.jwtVerify(token, SESSION_SECRET_KEY);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// API KEY LOADING - Load Deepgram API key from environment
// ============================================================================

/**
 * Loads the Deepgram API key from environment variables
 */
function loadApiKey(): string {
  const apiKey = Deno.env.get("DEEPGRAM_API_KEY");

  if (!apiKey) {
    console.error("\n❌ ERROR: Deepgram API key not found!\n");
    console.error("Please set your API key using one of these methods:\n");
    console.error("1. Create a .env file (recommended):");
    console.error("   DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("2. Environment variable:");
    console.error("   export DEEPGRAM_API_KEY=your_api_key_here\n");
    console.error("Get your API key at: https://console.deepgram.com\n");
    Deno.exit(1);
  }

  return apiKey;
}

const apiKey = loadApiKey();

// ============================================================================
// CORS CONFIGURATION
// ============================================================================

/**
 * Get CORS headers for API responses
 */
function getCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ============================================================================
// TYPES - TypeScript interfaces for WebSocket communication
// ============================================================================

interface ErrorMessage {
  type: "Error";
  description: string;
  code: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Build Deepgram Flux WebSocket URL with query parameters
 * Model is hardcoded to flux-general-en
 */
function buildDeepgramUrl(queryParams: URLSearchParams): string {
  const model = "flux-general-en";
  const encoding = queryParams.get("encoding") || "linear16";
  const sampleRate = queryParams.get("sample_rate") || "16000";

  const deepgramUrl = new URL(DEEPGRAM_WS_URL);
  deepgramUrl.searchParams.set("model", model);
  deepgramUrl.searchParams.set("encoding", encoding);
  deepgramUrl.searchParams.set("sample_rate", sampleRate);

  // Optional Flux-specific parameters
  const eotThreshold = queryParams.get("eot_threshold");
  if (eotThreshold) deepgramUrl.searchParams.set("eot_threshold", eotThreshold);

  const eagerEotThreshold = queryParams.get("eager_eot_threshold");
  if (eagerEotThreshold) deepgramUrl.searchParams.set("eager_eot_threshold", eagerEotThreshold);

  const eotTimeoutMs = queryParams.get("eot_timeout_ms");
  if (eotTimeoutMs) deepgramUrl.searchParams.set("eot_timeout_ms", eotTimeoutMs);

  // Multi-value keyterm support
  const keyterms = queryParams.getAll("keyterm");
  for (const term of keyterms) {
    deepgramUrl.searchParams.append("keyterm", term);
  }

  return deepgramUrl.toString();
}

/**
 * Send error message to client WebSocket
 */
function sendError(socket: WebSocket, error: Error, code: string = "UNKNOWN_ERROR") {
  if (socket.readyState === WebSocket.OPEN) {
    const errorMsg: ErrorMessage = {
      type: "Error",
      description: error.message,
      code: code,
    };
    socket.send(JSON.stringify(errorMsg));
  }
}

// ============================================================================
// WEBSOCKET HANDLERS
// ============================================================================

/**
 * Handle Flux WebSocket connection
 * Establishes bidirectional proxy between client and Deepgram Flux API
 */
async function handleFlux(
  clientSocket: WebSocket,
  queryParams: URLSearchParams
) {
  console.log("Client connected to /api/flux");

  let deepgramWs: WebSocket | null = null;

  try {
    // Build Deepgram Flux WebSocket URL with parameters
    const deepgramUrl = buildDeepgramUrl(queryParams);
    console.log("Connecting to Deepgram Flux:", deepgramUrl);

    // Connect to Deepgram with authorization
    deepgramWs = new WebSocket(deepgramUrl, {
      headers: {
        Authorization: `Token ${apiKey}`,
      },
    });

    // Wait for Deepgram connection to open
    await new Promise((resolve, reject) => {
      if (!deepgramWs) return reject(new Error("deepgramWs is null"));

      deepgramWs.onopen = () => {
        console.log("✓ Connected to Deepgram Flux API");
        resolve(null);
      };

      deepgramWs.onerror = (err) => {
        console.error("Deepgram Flux connection error:", err);
        reject(new Error("Failed to connect to Deepgram Flux"));
      };
    });

    // Forward messages from client to Deepgram (audio data)
    clientSocket.onmessage = (event) => {
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.send(event.data);
      }
    };

    // Forward messages from Deepgram to client (transcription results)
    deepgramWs.onmessage = (event) => {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(event.data);
      }
    };

    // Handle client disconnect
    clientSocket.onclose = () => {
      console.log("Client disconnected");
      if (deepgramWs) {
        deepgramWs.close();
      }
    };

    // Handle client errors
    clientSocket.onerror = (err) => {
      console.error("Client WebSocket error:", err);
      if (deepgramWs) {
        deepgramWs.close();
      }
    };

    // Handle Deepgram disconnect
    deepgramWs.onclose = (event) => {
      console.log(`Deepgram Flux connection closed: ${event.code} ${event.reason}`);
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.close();
      }
    };

    // Handle Deepgram errors
    deepgramWs.onerror = (err) => {
      console.error("Deepgram Flux WebSocket error:", err);
      sendError(clientSocket, new Error("Deepgram Flux connection error"), "DEEPGRAM_ERROR");
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.close();
      }
    };

  } catch (err) {
    console.error("Error setting up Flux connection:", err);
    sendError(clientSocket, err as Error, "CONNECTION_FAILED");
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(3000, "Setup failed");
    }
    if (deepgramWs) {
      deepgramWs.close();
    }
  }
}

// ============================================================================
// SESSION ROUTE HANDLERS
// ============================================================================

/**
 * Serve index.html (production only)
 */
function handleServeIndex(): Response {
  if (!indexHtmlTemplate) {
    return new Response("Frontend not built. Run make build first.", { status: 404 });
  }
  return new Response(indexHtmlTemplate, {
    headers: { "Content-Type": "text/html", ...getCorsHeaders() },
  });
}

/**
 * GET /api/session
 * Issues a signed JWT session token.
 */
async function handleGetSession(): Promise<Response> {
  const token = await createSessionToken();
  return Response.json({ token }, { headers: getCorsHeaders() });
}

// ============================================================================
// API ROUTE HANDLERS
// ============================================================================

/**
 * GET /api/metadata
 * Returns metadata about this starter application
 */
async function handleMetadata(): Promise<Response> {
  try {
    const tomlContent = await Deno.readTextFile("./deepgram.toml");
    const config = TOML.parse(tomlContent);

    if (!config.meta) {
      return Response.json(
        {
          error: "INTERNAL_SERVER_ERROR",
          message: "Missing [meta] section in deepgram.toml",
        },
        { status: 500, headers: getCorsHeaders() }
      );
    }

    return Response.json(config.meta, { headers: getCorsHeaders() });
  } catch (error) {
    console.error("Error reading metadata:", error);
    return Response.json(
      {
        error: "INTERNAL_SERVER_ERROR",
        message: "Failed to read metadata from deepgram.toml",
      },
      { status: 500, headers: getCorsHeaders() }
    );
  }
}

// ============================================================================
// HEALTH CHECK HANDLER
// ============================================================================

/**
 * GET /health
 * Simple health check endpoint.
 * @returns JSON response with { status: "ok" }
 */
function handleHealth(): Response {
  return Response.json({ status: "ok" }, { headers: getCorsHeaders() });
}

// ============================================================================
// CORS PREFLIGHT HANDLER
// ============================================================================

/**
 * Handle CORS preflight OPTIONS requests
 */
function handlePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}

// ============================================================================
// MAIN REQUEST HANDLER
// ============================================================================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handlePreflight();
  }

  // Session routes (unprotected)
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return handleServeIndex();
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    return await handleGetSession();
  }

  // WebSocket endpoint: /api/flux (auth via subprotocol)
  if (url.pathname === "/api/flux") {
    const upgrade = req.headers.get("upgrade") || "";

    if (upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426, headers: getCorsHeaders() });
    }

    // Validate JWT from subprotocol
    const protocols = req.headers.get("sec-websocket-protocol") || "";
    const protocolList = protocols.split(",").map((p) => p.trim());
    const tokenProto = protocolList.find((p) => p.startsWith("access_token."));

    if (!tokenProto) {
      return new Response("Unauthorized", { status: 401, headers: getCorsHeaders() });
    }

    const jwtToken = tokenProto.slice("access_token.".length);
    if (!(await verifySessionToken(jwtToken))) {
      return new Response("Unauthorized", { status: 401, headers: getCorsHeaders() });
    }

    // Upgrade with accepted subprotocol
    const { socket, response } = Deno.upgradeWebSocket(req, {
      protocol: tokenProto,
    });

    // Handle the WebSocket connection
    handleFlux(socket, url.searchParams);

    return response;
  }

  // Health check (unprotected)
  if (req.method === "GET" && url.pathname === "/health") {
    return handleHealth();
  }

  // Metadata (unprotected)
  if (req.method === "GET" && url.pathname === "/api/metadata") {
    return handleMetadata();
  }

  // 404 for all other routes
  return Response.json(
    { error: "Not Found", message: "Endpoint not found" },
    { status: 404, headers: getCorsHeaders() }
  );
}

// ============================================================================
// SERVER START
// ============================================================================

console.log("\n" + "=".repeat(70));
console.log(`🚀 Backend API Server running at http://localhost:${config.port}`);
console.log("");
console.log(`📡 GET  /api/session`);
console.log(`📡 WS   /api/flux (auth required)`);
console.log(`📡 GET  /api/metadata`);
console.log(`📡 GET  /health`);
console.log("=".repeat(70) + "\n");

Deno.serve({ port: config.port, hostname: config.host }, handleRequest);

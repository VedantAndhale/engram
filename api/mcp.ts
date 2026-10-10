import { handle } from "../mcp/handler.js";

// Vercel function: the MCP endpoint and its OAuth routes (vercel.json sends those here).
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;

/**
 * Where the live gates point: the first argument, else FORGE_URL, else Forge on this machine.
 * They also need FORGE_API_TOKEN, or the token in ~/.config/forge-aios/api-token (see client.ts).
 */
export const BASE = (process.argv[2] ?? process.env.FORGE_URL ?? 'http://127.0.0.1:3200').replace(/\/+$/, '');
export const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`;

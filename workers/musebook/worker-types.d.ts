// Minimal D1 type declarations for local typechecking (not shipped to the worker).
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
interface D1Result {
  results?: unknown[];
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

// Minimal Durable Object / Workers WebSocket declarations for local checks.
interface DurableObject { fetch(request: Request): Promise<Response>; alarm?(): Promise<void>; }
interface DurableObjectState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    getAlarm(): Promise<number | null>;
    setAlarm(time: number): Promise<void>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
}
interface WebSocket { accept(): void; }
declare const WebSocketPair: { new(): { 0: WebSocket; 1: WebSocket } };
interface ResponseInit { webSocket?: WebSocket; }

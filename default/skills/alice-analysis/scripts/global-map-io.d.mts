// Types for global-map-io.mjs (plain ESM run by Workspace shells).
export function workspaceRoot(): Promise<string>
export function isInside(root: string, target: string): boolean
export function safeDir(root: string, rel: string, options?: { exclusiveLast?: boolean }): Promise<string>
export function readLimited(res: Response, maxBytes: number): Promise<string>
export function gateway(): {
  workspaceId: string
  toolName(exportKey: string, group: string, verb: string): Promise<string>
  invoke(exportKey: string, tool: string, args: unknown): Promise<{ content: Array<{ text: string }>; _meta?: Record<string, string>; isError?: boolean }>
}

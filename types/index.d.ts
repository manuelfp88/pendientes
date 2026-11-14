export type Chat = { id: string; title: string; needsAction: boolean }

declare module 'claude-code' {
  interface PluginState {
    pendientes: { chats: Shaped<Chat[]>; isBroken: boolean; userTurn: boolean }
  }
}

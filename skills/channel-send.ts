/**
 * Persistent per-channel send registry.
 *
 * Problem: the PM's `send` callback is gated on `ctrl.signal.aborted`, so
 * when a new user message arrives and aborts the PM loop, any background
 * agent tasks lose their ability to post to Discord.
 *
 * Solution: container-runner.ts registers a direct Discord API sender here
 * (not abort-gated) at startup. bot.ts background tasks call `channelSend`
 * which always goes through, regardless of the PM loop state.
 *
 * No circular imports: container-runner.ts → this file ← bot.ts
 */

type Sender = (text: string) => Promise<void>;
type TypingTrigger = () => Promise<void>;

const registry = new Map<string, Sender>();
const typingRegistry = new Map<string, TypingTrigger>();

/** Called by container-runner.ts once per channel at startup. */
export function registerChannelSend(channelId: string, send: Sender): void {
  registry.set(channelId, send);
}

/**
 * Send text to a Discord channel bypassing any AbortSignal.
 * Falls back silently if the channel has no registered sender.
 */
export function channelSend(channelId: string, text: string): Promise<void> {
  return registry.get(channelId)?.(text) ?? Promise.resolve();
}

/** Called by container-runner.ts to register the Discord typing trigger for a channel. */
export function registerChannelTyping(channelId: string, trigger: TypingTrigger): void {
  typingRegistry.set(channelId, trigger);
}

/**
 * Fire a Discord "is typing..." indicator for a channel.
 * The indicator lasts ~10 seconds; call every ≤8 seconds to keep it showing.
 * Falls back silently if no trigger is registered.
 */
export function triggerTyping(channelId: string): Promise<void> {
  return typingRegistry.get(channelId)?.() ?? Promise.resolve();
}

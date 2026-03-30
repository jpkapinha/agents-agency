/**
 * In-process container runner — replaces NanoClaw's Docker-based container-runner.ts.
 *
 * Instead of spawning a Docker container per group, we call our agents.ts PM loop
 * directly in-process. NanoClaw's group management, SQLite state, message queuing,
 * scheduling, and IPC all run as designed — only execution is redirected here.
 */
import { ChildProcess } from 'child_process';
import { handleMessage, resolveDecision } from './skills/bot.js';
import { registerChannelSend } from './skills/channel-send.js';
import { RegisteredGroup } from './types.js';

// ---------------------------------------------------------------------------
// Types (mirrors the original container-runner.ts exports)
// ---------------------------------------------------------------------------

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

// ---------------------------------------------------------------------------
// Execution state — one AbortController per chatJid for interrupt/pivot
// ---------------------------------------------------------------------------

const activeControllers = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Main entry point called by NanoClaw's runAgent()
// ---------------------------------------------------------------------------

export async function runContainerAgent(
  _group: RegisteredGroup,
  input: ContainerInput,
  _onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const { chatJid, prompt } = input;

  // Interrupt any in-progress PM loop for this channel (pivot support).
  // Background agent tasks are NOT aborted — they run to completion regardless.
  const prev = activeControllers.get(chatJid);
  if (prev) prev.abort();

  const ctrl = new AbortController();
  activeControllers.set(chatJid, ctrl);

  // PM loop send — gated on abort so the PM stops talking after being interrupted.
  const send = async (text: string): Promise<void> => {
    if (ctrl.signal.aborted) return;
    await onOutput?.({ status: 'success', result: text });
  };

  // Persistent channel send — NOT gated on abort.
  // Background agent tasks use this via channelSend() in bot.ts so they can
  // post progress/completion updates even after the PM loop has been aborted.
  registerChannelSend(chatJid, (text: string) => sendTextToDiscord(chatJid, text));

  // upload a file attachment via Discord REST API directly
  const sendFile = async (filePath: string, description: string): Promise<void> => {
    await uploadFileToDiscord(chatJid, filePath, description);
  };

  try {
    // If this incoming message is a reply to a pending decision request, resolve it
    if (resolveDecision(chatJid, prompt)) {
      activeControllers.delete(chatJid);
      return { status: 'success', result: null };
    }

    await handleMessage(prompt, chatJid, ctrl.signal, send, sendFile);
    return { status: 'success', result: null };
  } catch (err: unknown) {
    if (ctrl.signal.aborted) return { status: 'success', result: null };
    const errMsg = err instanceof Error ? err.message : String(err);
    await onOutput?.({ status: 'error', result: null, error: errMsg });
    return { status: 'error', result: null, error: errMsg };
  } finally {
    activeControllers.delete(chatJid);
  }
}

// ---------------------------------------------------------------------------
// Discord REST API helpers — used for persistent sends and file uploads
// ---------------------------------------------------------------------------

/** Send a text message directly to a Discord channel via REST API. */
async function sendTextToDiscord(channelId: string, text: string): Promise<void> {
  const token = process.env['DISCORD_BOT_TOKEN'];
  if (!token || !channelId) return;
  const chunks = text.match(/[\s\S]{1,1900}/g) ?? [text];
  for (const chunk of chunks) {
    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: chunk }),
    }).catch((err) => console.error('[container-runner] sendText error:', err));
  }
}

async function uploadFileToDiscord(
  channelId: string,
  filePath: string,
  description: string,
): Promise<void> {
  const token = process.env['DISCORD_BOT_TOKEN'];
  if (!token || !channelId) return;

  const { readFileSync, existsSync } = await import('fs');
  const { basename } = await import('path');

  if (!existsSync(filePath)) {
    console.error(`[container-runner] File not found: ${filePath}`);
    return;
  }

  const fileBuffer = readFileSync(filePath);
  const fileName = basename(filePath);
  const formData = new FormData();
  formData.append('content', description ?? '');
  formData.append('files[0]', new Blob([fileBuffer]), fileName);

  await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}` },
    body: formData,
  }).catch((err) => console.error('[container-runner] File upload error:', err));
}

// ---------------------------------------------------------------------------
// No-ops: NanoClaw writes context snapshots for agent containers.
// Our in-process agents read context directly from /workspace, so these are
// not needed. Exported to satisfy NanoClaw's import contract.
// ---------------------------------------------------------------------------

export function writeTasksSnapshot(
  _folder: string,
  _isMain: boolean,
  _tasks: unknown[],
): void {}

export function writeGroupsSnapshot(
  _folder: string,
  _isMain: boolean,
  _groups: AvailableGroup[],
  _registered: Set<string>,
): void {}

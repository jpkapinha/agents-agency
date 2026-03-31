/**
 * Project state management — persisted to /workspace/.agency/state.json.
 * Synchronous reads/writes to avoid race conditions (Node.js is single-threaded).
 * Uses write-to-tmp-then-rename for safe saves.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { resolve } from 'path';

const STATE_DIR = '/workspace/.agency';
const STATE_FILE = resolve(STATE_DIR, 'state.json');
const STATE_TMP = resolve(STATE_DIR, 'state.json.tmp');

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  title: string;
  status: 'pending' | 'in-progress' | 'done' | 'blocked';
  assignee: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  id: string;
  question: string;
  context: string;
  options?: string[];
  askedAt: string;
  resolvedAt?: string;
  answer?: string;
}

export interface Blocker {
  id: string;
  taskId: string;
  description: string;
  raisedAt: string;
  resolvedAt?: string;
}

export interface Repo {
  name: string;
  url: string;
  localPath: string;
  branch: string;
  addedAt: string;
}

export interface ProjectMemory {
  techStack: string[];       // e.g. ["Solidity 0.8.24", "Next.js 14", "wagmi v2"]
  keyDecisions: string[];    // e.g. ["Using UUPS proxy pattern for upgradability"]
  milestones: string[];      // e.g. ["PRD approved 2024-01-15", "Contracts deployed to Sepolia"]
  outOfScope: string[];      // things explicitly excluded
  lastUpdated: string;
}

export interface ProjectState {
  projectName: string;
  summary?: string;
  lastUpdated: string;
  tasks: Task[];
  decisions: Decision[];
  blockers: Blocker[];
  repos: Repo[];
  memory?: ProjectMemory;
  activeModelProfile?: string; // e.g. "testing" | "production" — persists across restarts
}

// ---------------------------------------------------------------------------
// ID generation (no external deps)
// ---------------------------------------------------------------------------

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

function defaultState(): ProjectState {
  return {
    projectName: process.env['PROJECT_NAME'] ?? 'unnamed',
    lastUpdated: now(),
    tasks: [],
    decisions: [],
    blockers: [],
    repos: [],
    memory: {
      techStack: [],
      keyDecisions: [],
      milestones: [],
      outOfScope: [],
      lastUpdated: new Date().toISOString(),
    },
  };
}

export function loadState(): ProjectState {
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as ProjectState;
  } catch {
    return defaultState();
  }
}

export function saveState(state: ProjectState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  state.lastUpdated = now();
  writeFileSync(STATE_TMP, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(STATE_TMP, STATE_FILE);
}

// ---------------------------------------------------------------------------
// Task helpers
// ---------------------------------------------------------------------------

export function addTask(title: string, assignee: string): Task {
  const state = loadState();
  const task: Task = {
    id: makeId('task'),
    title,
    status: 'pending',
    assignee,
    createdAt: now(),
    updatedAt: now(),
  };
  state.tasks.push(task);
  saveState(state);
  return task;
}

export function updateTask(id: string, updates: Partial<Omit<Task, 'id' | 'createdAt'>>): void {
  const state = loadState();
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  Object.assign(task, updates, { updatedAt: now() });
  saveState(state);
}

// ---------------------------------------------------------------------------
// Decision helpers
// ---------------------------------------------------------------------------

export function addDecision(question: string, context: string, options?: string[]): Decision {
  const state = loadState();
  const decision: Decision = {
    id: makeId('dec'),
    question,
    context,
    options,
    askedAt: now(),
  };
  state.decisions.push(decision);
  saveState(state);
  return decision;
}

export function resolveDecision(id: string, answer: string): void {
  const state = loadState();
  const decision = state.decisions.find(d => d.id === id);
  if (!decision) return;
  decision.answer = answer;
  decision.resolvedAt = now();
  saveState(state);
}

// ---------------------------------------------------------------------------
// Repo helpers
// ---------------------------------------------------------------------------

export function addRepo(url: string, name: string, branch = 'main'): Repo {
  const state = loadState();
  const existing = state.repos.find(r => r.name === name);
  if (existing) return existing;
  const repo: Repo = {
    name,
    url,
    localPath: `/workspace/${name}`,
    branch,
    addedAt: now(),
  };
  state.repos.push(repo);
  saveState(state);
  return repo;
}

export function getRepos(): Repo[] {
  return loadState().repos;
}

// ---------------------------------------------------------------------------
// Blocker helpers
// ---------------------------------------------------------------------------

export function addBlocker(taskId: string, description: string): Blocker {
  const state = loadState();
  const blocker: Blocker = {
    id: makeId('blk'),
    taskId,
    description,
    raisedAt: now(),
  };
  state.blockers.push(blocker);
  saveState(state);
  return blocker;
}

// ---------------------------------------------------------------------------
// Formatted summary for PM context
// ---------------------------------------------------------------------------

export function formatStateForPM(): string {
  const state = loadState();
  const lines: string[] = [`**Project:** ${state.projectName}`];

  const pending = state.tasks.filter(t => t.status === 'pending');
  const inProgress = state.tasks.filter(t => t.status === 'in-progress');
  const done = state.tasks.filter(t => t.status === 'done');
  const blocked = state.tasks.filter(t => t.status === 'blocked');
  const openDecisions = state.decisions.filter(d => !d.resolvedAt);
  const openBlockers = state.blockers.filter(b => !b.resolvedAt);

  if (done.length) lines.push(`\n**Done (${done.length}):** ${done.map(t => t.title).join(', ')}`);
  if (inProgress.length) lines.push(`\n**In progress:** ${inProgress.map(t => `${t.title} (${t.assignee})`).join(', ')}`);
  if (pending.length) lines.push(`\n**Pending:** ${pending.map(t => t.title).join(', ')}`);
  if (blocked.length) lines.push(`\n**Blocked:** ${blocked.map(t => t.title).join(', ')}`);
  if (openDecisions.length) lines.push(`\n**Open decisions:** ${openDecisions.map(d => d.question.slice(0, 80)).join('; ')}`);
  if (openBlockers.length) lines.push(`\n**Open blockers:** ${openBlockers.map(b => b.description.slice(0, 80)).join('; ')}`);

  if (state.repos.length) {
    lines.push(`\n**Repos:** ${state.repos.map(r => `${r.name} → ${r.localPath} (${r.url})`).join(', ')}`);
  }

  const mem = state.memory;
  if (mem) {
    if (mem.techStack.length) lines.push(`\n**Tech stack:** ${mem.techStack.join(', ')}`);
    if (mem.keyDecisions.length) lines.push(`\n**Key decisions:** ${mem.keyDecisions.map(d => `• ${d}`).join('\n')}`);
    if (mem.milestones.length) lines.push(`\n**Milestones:** ${mem.milestones.slice(-5).join(', ')}`);
    if (mem.outOfScope.length) lines.push(`\n**Out of scope:** ${mem.outOfScope.join(', ')}`);
  }

  if (state.tasks.length === 0 && openDecisions.length === 0 && state.repos.length === 0) {
    lines.push('\n(No tasks yet)');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Project memory helpers
// ---------------------------------------------------------------------------

export function getMemory(): ProjectMemory {
  const state = loadState();
  return state.memory ?? {
    techStack: [], keyDecisions: [], milestones: [], outOfScope: [],
    lastUpdated: new Date().toISOString(),
  };
}

export function updateMemory(updates: Partial<Omit<ProjectMemory, 'lastUpdated'>>): void {
  const state = loadState();
  const memory = state.memory ?? { techStack: [], keyDecisions: [], milestones: [], outOfScope: [], lastUpdated: '' };
  if (updates.techStack) memory.techStack = [...new Set([...memory.techStack, ...updates.techStack])];
  if (updates.keyDecisions) memory.keyDecisions = [...new Set([...memory.keyDecisions, ...updates.keyDecisions])];
  if (updates.milestones) memory.milestones = [...memory.milestones, ...updates.milestones];
  if (updates.outOfScope) memory.outOfScope = [...new Set([...memory.outOfScope, ...updates.outOfScope])];
  memory.lastUpdated = new Date().toISOString();
  state.memory = memory;
  saveState(state);
}

// ---------------------------------------------------------------------------
// Model profile helpers
// ---------------------------------------------------------------------------

export function getActiveProfile(): string | undefined {
  return loadState().activeModelProfile;
}

export function setActiveProfile(name: string): void {
  const state = loadState();
  state.activeModelProfile = name;
  saveState(state);
}

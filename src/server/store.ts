import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {EventRecord, Source} from '../shared/types';

export const MAX_EVENTS = 500;

interface EventFile {
  /** Highest event id ever assigned; monotonic across restarts. */
  lastId: number;
  events: EventRecord[];
}

export class Store {
  private readonly sourcesPath: string;
  private readonly eventsPath: string;
  private sources: Source[] = [];
  private events: EventRecord[] = [];
  private lastId = 0;

  constructor(dataDir: string) {
    mkdirSync(dataDir, {recursive: true});
    this.sourcesPath = join(dataDir, 'sources.json');
    this.eventsPath = join(dataDir, 'events.json');
    this.load();
  }

  private load() {
    if (existsSync(this.sourcesPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.sourcesPath, 'utf8')) as {sources?: Source[]};
        this.sources = Array.isArray(parsed.sources) ? parsed.sources : [];
      } catch {
        this.sources = [];
      }
    }
    if (existsSync(this.eventsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.eventsPath, 'utf8')) as Partial<EventFile>;
        this.events = Array.isArray(parsed.events) ? parsed.events : [];
        this.lastId = typeof parsed.lastId === 'number' ? parsed.lastId : (this.events.at(-1)?.id ?? 0);
      } catch {
        this.events = [];
      }
    }
    // Recover the invariant even if the file was hand-edited.
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }

  private atomicWrite(path: string, data: string) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }

  getSources(): Source[] {
    return this.sources;
  }

  getSource(name: string): Source | undefined {
    return this.sources.find((s) => s.name === name);
  }

  saveSource(source: Source) {
    const idx = this.sources.findIndex((s) => s.name === source.name);
    if (idx >= 0) this.sources[idx] = source;
    else this.sources.push(source);
    this.persistSources();
  }

  deleteSource(name: string): boolean {
    const before = this.sources.length;
    this.sources = this.sources.filter((s) => s.name !== name);
    if (this.sources.length !== before) {
      this.persistSources();
      return true;
    }
    return false;
  }

  private persistSources() {
    this.atomicWrite(this.sourcesPath, JSON.stringify({sources: this.sources}, null, 2));
  }

  /** Newest first in memory; file keeps them in id order. */
  listEvents(afterId?: number, limit?: number): EventRecord[] {
    const rows = afterId === undefined
      ? this.events
      : this.events.filter((e) => e.id > afterId);
    const sliced = limit ? rows.slice(-limit) : rows;
    return [...sliced].reverse();
  }

  getEvent(id: number): EventRecord | undefined {
    return this.events.find((e) => e.id === id);
  }

  addEvent(event: EventRecord) {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events = this.events.slice(-MAX_EVENTS);
    this.persistEvents();
  }

  updateEvent(event: EventRecord) {
    const idx = this.events.findIndex((e) => e.id === event.id);
    if (idx >= 0) {
      this.events[idx] = event;
      this.persistEvents();
    }
  }

  nextId(): number {
    this.lastId += 1;
    return this.lastId;
  }

  private persistEvents() {
    const file: EventFile = {lastId: this.lastId, events: this.events};
    // File lands via rename so a crash never leaves a half-written record.
    const tmp = `${this.eventsPath}.tmp`;
    mkdirSync(dirname(this.eventsPath), {recursive: true});
    writeFileSync(tmp, JSON.stringify(file));
    renameSync(tmp, this.eventsPath);
  }
}

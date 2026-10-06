import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EventRecord, RedactionRule, SourceDef } from '../shared/types.js';

const MAX_EVENTS = 500;

interface DbShape {
  version: 1;
  sources: SourceDef[];
  rules: RedactionRule[];
  events: EventRecord[]; // 按 id 升序保存
  nextEventId: number;
}

const EMPTY: DbShape = { version: 1, sources: [], rules: [], events: [], nextEventId: 1 };

export class Store {
  private db: DbShape;
  private saveChain: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {
    this.db = structuredClone(EMPTY);
  }

  async load(): Promise<void> {
    try {
      const text = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(text) as Partial<DbShape>;
      this.db = {
        version: 1,
        sources: Array.isArray(parsed.sources) ? parsed.sources : [],
        rules: Array.isArray(parsed.rules) ? parsed.rules : [],
        events: Array.isArray(parsed.events) ? parsed.events.slice(-MAX_EVENTS) : [],
        nextEventId: typeof parsed.nextEventId === 'number' ? parsed.nextEventId : 1,
      };
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        this.db = structuredClone(EMPTY);
        return;
      }
      throw new Error(`无法读取存储文件 ${this.file}: ${e?.message ?? e}`);
    }
  }

  /** 串行化的原子写（temp + rename），并发保存不会互相截断。 */
  private persist(): void {
    const snapshot = JSON.stringify(this.db);
    this.saveChain = this.saveChain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, this.file);
    }).catch(err => {
      // 落盘失败不能把原值通过错误信息抛给上层日志，这里只保留错误类别
      console.error('[store] 持久化失败:', err?.code ?? 'unknown error');
    });
  }

  async flushed(): Promise<void> { await this.saveChain; }

  getSources(): SourceDef[] { return this.db.sources.map(s => structuredClone(s)); }
  getSource(name: string): SourceDef | undefined {
    const found = this.db.sources.find(s => s.name === name);
    return found ? structuredClone(found) : undefined;
  }

  upsertSource(input: SourceDef): void {
    const i = this.db.sources.findIndex(s => s.name === input.name);
    if (i === -1) this.db.sources.push(input);
    else this.db.sources[i] = input;
    this.persist();
  }

  deleteSource(name: string): void {
    this.db.sources = this.db.sources.filter(s => s.name !== name);
    this.persist();
  }

  getRules(): RedactionRule[] { return this.db.rules.map(r => structuredClone(r)); }
  setRules(rules: RedactionRule[]): void {
    this.db.rules = structuredClone(rules);
    this.persist();
  }

  getEventsDesc(): EventRecord[] {
    return this.db.events.map(e => structuredClone(e)).reverse();
  }

  /** 断线补拉：返回 id 大于 afterId 的事件（升序），天然去重且不乱序。 */
  getEventsAfter(afterId: number): EventRecord[] {
    return this.db.events.filter(e => e.id > afterId).map(e => structuredClone(e));
  }

  getEvent(id: number): EventRecord | undefined {
    const e = this.db.events.find(x => x.id === id);
    return e ? structuredClone(e) : undefined;
  }

  nextId(): number { return this.db.nextEventId++; }

  addEvent(event: EventRecord): void {
    this.db.events.push(event);
    while (this.db.events.length > MAX_EVENTS) this.db.events.shift();
    this.persist();
  }

  updateEvent(event: EventRecord): void {
    const i = this.db.events.findIndex(e => e.id === event.id);
    if (i !== -1) {
      this.db.events[i] = event;
      this.persist();
    }
  }
}

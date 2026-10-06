import {mkdtemp} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

const mkdtempP = promisify(mkdtemp);

describe('management api contract', () => {
  it('serves state, sources and an empty event list from a fresh store', async () => {
    const dataDir = await mkdtempP(join(tmpdir(), 'webhook-lab-smoke-'));
    const {app} = createApp({dataDir});
    const state = await request(app).get('/api/state');
    expect(state.status).toBe(200);
    expect(state.body.sources).toEqual([]);
    expect(state.body.maxEvents).toBe(500);

    const events = await request(app).get('/api/events');
    expect(events.status).toBe(200);
    expect(events.body.events).toEqual([]);
  });
});

import express, {type Express, type Request, type Response} from 'express';
import {existsSync} from 'node:fs';
import {join as pathJoin} from 'node:path';
import type {
  EventRecord,
  PathCheckResponse,
  PreviewRequest,
  PreviewResponse,
  RedactionRule,
  ReplayResponseItem,
  Source,
  SourceView,
} from '../shared/types';
import {Hub} from './hub';
import {parseBody, redactCapture, validatePath} from './redact';
import {replayOne} from './replay';
import {verifySignature} from './signature';
import {MAX_EVENTS, Store} from './store';
import {validateSourceInput, validateSourceName} from './validation';

const MAX_BODY_BYTES = 1024 * 1024;

/** Strip secrets before a source leaves the server (API responses + pushes). */
function toView(source: Source): SourceView {
  return {
    ...source,
    signature: source.signature
      ? {
          ...source.signature,
          keys: source.signature.keys.map((k) => ({id: k.id, ...(k.label ? {label: k.label} : {})})),
        }
      : null,
  };
}

function readRawBody(req: Request, limit: number): Promise<{raw: Buffer; tooLarge: boolean}> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return; // keep draining so the socket can respond
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({raw: Buffer.concat(chunks), tooLarge}));
    req.on('error', reject);
  });
}

/** Headers as a single-level lowercase-or-original map, duplicates joined. */
function flattenHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export interface AppContext {
  app: Express;
  store: Store;
  hub: Hub;
}

export function createApp(options: {dataDir: string; staticDir?: string}): AppContext {
  const store = new Store(options.dataDir);
  const hub = new Hub();
  const app = express();
  // Management API parses JSON; ingestion routes must NOT, because the
  // signature is verified against the untouched request bytes.
  app.use('/api', express.json({limit: '256kb'}));

  // ---- Management API -------------------------------------------------

  app.get('/api/state', (_req, res) => {
    res.json({sources: store.getSources().map(toView), maxEvents: MAX_EVENTS});
  });

  app.get('/api/sources', (_req, res) => {
    res.json({sources: store.getSources().map(toView)});
  });

  app.put('/api/sources/:name', (req, res) => {
    const name = req.params.name;
    if (!validateSourceName(name)) {
      res.status(400).json({errors: [{field: 'name', message: 'invalid source name in URL'}]});
      return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || body.name !== name) {
      res.status(400).json({errors: [{field: 'name', message: 'body name must match the URL'}]});
      return;
    }
    const existing = store.getSource(name);
    const errors = validateSourceInput(body, existing);
    if (errors.length) {
      res.status(400).json({errors});
      return;
    }
    const submitted = body as Source;
    // Secrets are write-only: an empty secret on an existing key keeps the old one.
    const keys = submitted.signature?.keys.map((k) => {
      const old = existing?.signature?.keys.find((ok) => ok.id === k.id);
      return {
        id: k.id,
        label: k.label || undefined,
        secret: k.secret === '' && old ? old.secret : k.secret,
      };
    });
    const source: Source = {
      name,
      targetUrl: submitted.targetUrl,
      signature: submitted.signature
        ? {
            header: submitted.signature.header,
            timestampHeader: submitted.signature.timestampHeader || undefined,
            toleranceSeconds: submitted.signature.toleranceSeconds,
            algorithm: submitted.signature.algorithm,
            encoding: submitted.signature.encoding,
            signedContent: submitted.signature.signedContent,
            keys: keys!,
          }
        : null,
      rules: submitted.rules.map((r: RedactionRule) => ({
        id: r.id,
        scope: r.scope,
        target: r.target,
        action: r.action,
        replacement: r.replacement,
        keepLast: r.keepLast,
      })),
      createdAt: existing?.createdAt ?? Date.now(),
    };
    store.saveSource(source);
    hub.publish({type: 'sources', sources: store.getSources().map(toView)});
    res.json({source: toView(source)});
  });

  app.delete('/api/sources/:name', (req, res) => {
    const removed = store.deleteSource(req.params.name);
    if (!removed) {
      res.status(404).json({error: 'source not found'});
      return;
    }
    hub.publish({type: 'sources', sources: store.getSources().map(toView)});
    res.status(204).end();
  });

  app.get('/api/events', (req, res) => {
    const afterId = typeof req.query.afterId === 'string' ? Number(req.query.afterId) : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    if ((afterId !== undefined && !Number.isInteger(afterId)) || (limit !== undefined && (!Number.isInteger(limit) || limit <= 0))) {
      res.status(400).json({error: 'afterId and limit must be positive integers'});
      return;
    }
    res.json({events: store.listEvents(afterId, limit)});
  });

  app.get('/api/events/:id', (req, res) => {
    const event = store.getEvent(Number(req.params.id));
    if (!event) {
      res.status(404).json({error: 'event not found'});
      return;
    }
    res.json({event});
  });

  app.post('/api/replay', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => Number.isInteger(id)) : [];
    if (ids.length === 0) {
      res.status(400).json({error: 'ids must be a non-empty integer array'});
      return;
    }
    // Each replay is independent; one failure never aborts the batch.
    const results = await Promise.all(
      ids.map(async (id: number): Promise<ReplayResponseItem | null> => {
        const event = store.getEvent(id);
        if (!event) return null;
        const source = store.getSource(event.source);
        if (!source) return null;
        const outcome = await replayOne(event, source, () => store.nextId());
        const updated: EventRecord = {...event, replays: [...event.replays, outcome.replay]};
        store.updateEvent(updated);
        hub.publish({type: 'replay', source: source.name, eventId: event.id, replay: outcome.replay});
        return outcome;
      }),
    );
    res.json({results: results.filter((r): r is ReplayResponseItem => r !== null)});
  });

  app.post('/api/preview', (req, res) => {
    const input = req.body as Partial<PreviewRequest> | null | undefined;
    if (!input || typeof input !== 'object' || typeof input.body !== 'string' || !Array.isArray(input.rules)) {
      res.status(400).json({error: 'body (string) and rules (array) are required'});
      return;
    }
    for (const rule of input.rules as RedactionRule[]) {
      if (rule.scope === 'body') {
        const check = validatePath(rule.target);
        if (!check.valid) {
          res.status(400).json({error: check.message, pathErrorAt: check.offset});
          return;
        }
      }
    }
    const raw = Buffer.from(input.body, 'utf8');
    const rawHeaders = input.headers && typeof input.headers === 'object' ? (input.headers as Record<string, string>) : {};
    if (input.contentType && !('content-type' in rawHeaders)) rawHeaders['content-type'] = input.contentType;
    // "Before" is the sample exactly as pasted (raw text, raw headers);
    // "after" shows what capture/replay would keep.
    const parsed = parseBody(raw, rawHeaders['content-type']);
    const after = redactCapture(rawHeaders, raw, rawHeaders['content-type'], input.rules as RedactionRule[]);
    const payload: PreviewResponse = {
      headers: after.headers,
      bodyKind: after.kind,
      beforeTree: parsed.kind === 'json' || parsed.kind === 'form' ? parsed.tree : null,
      afterTree: after.tree,
      beforeText: input.body,
      afterText: after.text,
    };
    res.json(payload);
  });

  app.post('/api/check-path', (req, res) => {
    const target = typeof req.body?.path === 'string' ? req.body.path : '';
    const check = validatePath(target);
    const payload: PathCheckResponse = check.valid
      ? {valid: true}
      : {valid: false, errorAt: check.offset, message: check.message};
    res.json(payload);
  });

  // ---- Live stream ----------------------------------------------------

  app.get('/api/stream', (req, res) => {
    res.set({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();
    const lastEventId = Number(req.header('last-event-id'));
    const since = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0;
    // Backfill everything missed while this tab was asleep / disconnected.
    const missed = store.listEvents(since).reverse();
    for (const event of missed) {
      res.write(`id: ${event.id}\nevent: event\ndata: ${JSON.stringify({type: 'event', event})}\n\n`);
    }
    hub.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    res.on('close', () => clearInterval(heartbeat));
  });

  // ---- Ingestion ------------------------------------------------------
  // Registered before any body-parsing middleware: the signature is computed
  // over the exact bytes the sender signed.
  const hookHandler = async (req: Request, res: Response) => {
    const sourceName = String(req.params.name);
    const source = store.getSource(sourceName);
    if (!source) {
      // Still drain the request body so the client gets a clean response.
      req.resume();
      res.status(404).json({error: 'unknown source'});
      return;
    }
    const {raw, tooLarge} = await readRawBody(req, MAX_BODY_BYTES);
    if (tooLarge) {
      // 413 leaves no record of any kind.
      res.status(413).json({error: 'payload too large'});
      return;
    }

    const fullUrl = req.url ?? '/';
    const queryIndex = fullUrl.indexOf('?');
    const pathUnderHook = req.path.replace(/^\/hook\/[^/]*/, '') || '/';
    const query = queryIndex >= 0 ? fullUrl.slice(queryIndex + 1) : '';

    const headers = flattenHeaders(req);
    const verification = verifySignature(source.signature, headers, raw);
    const redacted = redactCapture(headers, raw, headers['content-type'], source.rules);
    const event: EventRecord = {
      id: store.nextId(),
      source: source.name,
      method: req.method,
      path: pathUnderHook,
      query,
      headers: redacted.headers,
      bodyKind: redacted.kind,
      bodyTree: redacted.tree,
      bodyText: redacted.text,
      bodyBytes: raw.length,
      receivedAt: Date.now(),
      verification,
      replays: [],
    };
    store.addEvent(event);
    hub.publish({type: 'event', event});
    res.status(202).json({id: event.id});
  };
  app.all('/hook/:name', hookHandler);
  app.all('/hook/:name/*splat', hookHandler);

  // ---- Static UI (production) ----------------------------------------

  if (options.staticDir && existsSync(options.staticDir)) {
    app.use(express.static(options.staticDir));
    // SPA fallback for any non-API, non-hook GET.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/hook/')) {
        next();
        return;
      }
      res.sendFile(pathJoin(options.staticDir!, 'index.html'));
    });
  }

  return {app, store, hub};
}

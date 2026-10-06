import type {Response} from 'express';
import type {EventRecord, ReplayRecord, SourceView} from '../shared/types';

export type StreamEvent =
  | {type: 'event'; event: EventRecord}
  | {type: 'replay'; source: string; eventId: number; replay: ReplayRecord}
  | {type: 'sources'; sources: SourceView[]};

/** Fan-out hub for Server-Sent Events. Frames carry a name + JSON data. */
export class Hub {
  private readonly clients = new Set<Response>();

  add(res: Response) {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  publish(frame: StreamEvent) {
    const data = `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
    for (const client of this.clients) {
      client.write(data);
    }
  }

  get size() {
    return this.clients.size;
  }
}

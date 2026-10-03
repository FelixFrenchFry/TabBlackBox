import { parseArchiveSession, type ArchiveSession } from './archive';
import type { Repository } from './database';
import { archiveFooter, archiveHeader, formatArchiveSession, EXPORT_FORMATS, type ExportFormat } from './export-formats';

export const ARCHIVE_FILE_LIMIT = 1_000_000_000;
export const ARCHIVE_VALUE_LIMIT = 6_000_000;
const ARCHIVE_SESSION_LIMIT = 25_000;

// retain only one JSON value while the rest of the file remains in the stream
class ArchiveReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  // strip a leading byte order mark like Blob.text() does
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private position = 0;
  private done = false;
  private bytes = 0;
  constructor(file: Blob, private readonly signal?: AbortSignal, private readonly progress?: (bytes: number) => void)
  {
    this.reader = file.stream().getReader();
  }

  private async fill(): Promise<boolean>
  {
    this.signal?.throwIfAborted();
    while (this.position === this.buffer.length && !this.done) {
      const result = await this.reader.read();
      this.signal?.throwIfAborted();
      this.done = result.done;
      this.buffer = this.decoder.decode(result.value, { stream: !result.done });
      this.position = 0;
      this.bytes += result.value?.byteLength ?? 0;
      this.progress?.(this.bytes);
    }
    return this.position < this.buffer.length;
  }

  async peek(): Promise<string | undefined>
  {
    while (await this.fill()) {
      while (this.position < this.buffer.length) {
        const character = this.buffer[this.position];
        if (character !== ' ' && character !== '\r' && character !== '\n' && character !== '\t') return character;
        this.position++;
      }
    }
    return undefined;
  }

  async take(character: string): Promise<void>
  {
    if (await this.peek() !== character) throw new Error('Invalid session archive JSON.');
    this.position++;
  }

  async value(): Promise<unknown>
  {
    await this.peek();
    const parts: string[] = [];
    let length = 0;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let finished = false;
    while (!finished && await this.fill()) {
      const start = this.position;
      while (this.position < this.buffer.length) {
        const character = this.buffer[this.position];
        if (!quoted && depth === 0 && (character === ',' || character === ']' || character === '}' || character === ':' || character === ' ' || character === '\r' || character === '\n' || character === '\t')) { finished = true; break; }
        this.position++;
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') { quoted = false; if (depth === 0) { finished = true; break; } }
        } else if (character === '"') quoted = true;
        else if (character === '{' || character === '[') {
          if (++depth > 32) throw new Error('Session archive nesting is too deep.');
        } else if (character === '}' || character === ']') {
          if (--depth === 0) { finished = true; break; }
        }
      }
      length += this.position - start;
      if (length > ARCHIVE_VALUE_LIMIT) throw new Error('A session or archive field exceeds the 6 million character import limit.');
      parts.push(this.buffer.slice(start, this.position));
    }
    return JSON.parse(parts.join('')) as unknown;
  }

  async close(): Promise<void>
  {
    try { await this.reader.cancel(); } finally { this.reader.releaseLock(); }
  }
}

export async function* readArchiveFile(file: Blob, signal?: AbortSignal, progress?: (bytes: number) => void): AsyncGenerator<ArchiveSession>
{
  if (file.size > ARCHIVE_FILE_LIMIT) throw new Error('Session archives must be 1 GB or smaller.');
  const reader = new ArchiveReader(file, signal, progress);
  try {
    await reader.take('{');
    const keys = new Set<string>();
    let format: unknown;
    let version: unknown;
    let count = 0;
    while (true) {
      const key = await reader.value();
      if (typeof key !== 'string' || keys.has(key) || keys.size >= 256) throw new Error('Invalid or repeated session archive field.');
      keys.add(key);
      await reader.take(':');
      if (key === 'sessions') {
        await reader.take('[');
        if (await reader.peek() !== ']') while (true) {
          if (++count > ARCHIVE_SESSION_LIMIT) throw new Error('Session archives can contain at most 25,000 sessions.');
          yield parseArchiveSession(await reader.value());
          if (await reader.peek() === ']') break;
          await reader.take(',');
        }
        await reader.take(']');
      } else {
        const value = await reader.value();
        if (key === 'format') format = value;
        if (key === 'version') version = value;
      }
      if (await reader.peek() === '}') break;
      await reader.take(',');
    }
    await reader.take('}');
    if (await reader.peek() !== undefined) throw new Error('Unexpected data after the session archive.');
    if (format !== 'tabblackbox' || version !== 1 || !count) throw new Error('Choose a TabBlackBox session archive with at least one session.');
  } finally { await reader.close(); }
}

export async function exportArchiveFile(repository: Repository, format: ExportFormat, id?: string, signal?: AbortSignal, progress?: (count: number) => void): Promise<Blob>
{
  const header = archiveHeader(format);
  const footer = archiveFooter(format);
  const parts: BlobPart[] = [header];
  let count = 0;
  let bytes = new Blob([header, footer]).size;
  // materialize each session as a blob before advancing the consistent database cursor
  await repository.exportSaved(session => {
    const text = formatArchiveSession(session, format, count);
    const part = new Blob([text]);
    bytes += part.size;
    // native exports must stay within the limits enforced when restoring them
    if (format === 'json') {
      if (text.length - (count ? 1 : 0) > ARCHIVE_VALUE_LIMIT) throw new Error('A session exceeds the 6 million character import limit.');
      if (count >= ARCHIVE_SESSION_LIMIT) throw new Error('Session archives can contain at most 25,000 sessions. Export fewer sessions.');
      if (bytes > ARCHIVE_FILE_LIMIT) throw new Error('Session archives must be 1 GB or smaller. Export fewer sessions.');
    }
    parts.push(part);
    progress?.(++count);
  }, id, signal);
  parts.push(footer);
  signal?.throwIfAborted();
  return new Blob(parts, { type: EXPORT_FORMATS.find(item => item.format === format)?.type });
}

import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CONFIG, SCHEMA_VERSION, type ProbeEvent, type Sample } from "./model.ts";

const LOG_PATTERN = /^ram-probe-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.ndjson$/;

export interface LatestLoadResult {
  event: ProbeEvent | null;
  note: string | null;
}

interface QueueRecord {
  event: ProbeEvent;
  resolve: (written: boolean) => void;
  settled: boolean;
}

export interface LogWriterOptions {
  directory?: string;
  now?: () => Date;
}

export function isProbeLogFilename(filename: string): boolean {
  return LOG_PATTERN.test(filename);
}

export function shouldDeleteLogFile(filename: string, modifiedMs: number, nowMs: number): boolean {
  return isProbeLogFilename(filename) && modifiedMs < nowMs - CONFIG.retentionDays * 86_400_000;
}

export function mergeSampleHistory(
  persisted: readonly Sample[],
  live: readonly Sample[],
  cutoffMs: number,
): { persisted: Sample[]; live: Sample[]; history: Sample[] } {
  const persistedByTimestamp = new Map<number, Sample>();
  for (const sample of persisted) {
    const timestampMs = Date.parse(sample.timestampUtc);
    if (timestampMs < cutoffMs) continue;
    const existing = persistedByTimestamp.get(timestampMs);
    if (!existing || sample.processes.length > existing.processes.length) persistedByTimestamp.set(timestampMs, sample);
  }
  const retainedLive = live
    .filter((sample) => Date.parse(sample.timestampUtc) >= cutoffMs)
    .sort((left, right) => Date.parse(left.timestampUtc) - Date.parse(right.timestampUtc));
  const byTimestamp = new Map(persistedByTimestamp);
  for (const sample of retainedLive) byTimestamp.set(Date.parse(sample.timestampUtc), sample);
  const byTime = (left: Sample, right: Sample): number => Date.parse(left.timestampUtc) - Date.parse(right.timestampUtc);
  return {
    persisted: [...persistedByTimestamp.values()].sort(byTime),
    live: retainedLive,
    history: [...byTimestamp.values()].sort(byTime),
  };
}

export class LogWriter {
  readonly directory: string;
  private readonly now: () => Date;
  private readonly queue: QueueRecord[] = [];
  private pumpPromise: Promise<void> | null = null;
  private currentDate = "";
  private currentIndex = 0;
  private currentPath = "";
  private currentBytes = 0;
  private cleanupTimer: Timer | null = null;

  constructor(options: LogWriterOptions = {}) {
    this.directory = options.directory ?? join(process.cwd(), "logs");
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.cleanup();
    this.cleanupTimer = setInterval(() => void this.cleanup(), 3_600_000);
    this.cleanupTimer.unref();
  }

  async loadLatest(): Promise<LatestLoadResult> {
    try {
      const text = await Bun.file(join(this.directory, "latest.json")).text();
      const value = JSON.parse(text) as ProbeEvent;
      if (value.schemaVersion !== SCHEMA_VERSION) return { event: null, note: "latest.json schema version mismatch" };
      const timestampMs = Date.parse(value.timestampUtc);
      if (!Number.isFinite(timestampMs)) return { event: null, note: "latest.json timestamp is invalid" };
      if (timestampMs < this.now().getTime() - CONFIG.retentionDays * 86_400_000) {
        return { event: null, note: "latest.json is outside retention" };
      }
      if (value.kind !== "checkpoint" && value.kind !== "warning") {
        return { event: null, note: "latest.json is not a full checkpoint or warning" };
      }
      return { event: value, note: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { event: null, note: "latest.json does not exist" };
      return { event: null, note: `latest.json unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async loadRecentSamples(windowMs: number = CONFIG.historyWindowMs): Promise<Sample[]> {
    const cutoffMs = this.now().getTime() - windowMs;
    const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
    const files = (await readdir(this.directory))
      .flatMap((filename) => {
        const match = LOG_PATTERN.exec(filename);
        return match?.[1] !== undefined && match[1] >= cutoffDay
          ? [{ filename, date: match[1], index: Number(match[2] ?? 0) }]
          : [];
      })
      .sort((left, right) => right.date.localeCompare(left.date) || right.index - left.index);
    const samples = new Map<string, Sample>();
    for (const file of files) {
      const input = createReadStream(join(this.directory, file.filename), { encoding: "utf8" });
      const reader = createInterface({ input, crlfDelay: Infinity });
      let crossedCutoff = false;
      try {
        for await (const line of reader) {
          if (!line) continue;
          try {
            const event = JSON.parse(line) as ProbeEvent;
            if (event.schemaVersion !== SCHEMA_VERSION || event.kind !== "sample") continue;
            const timestampMs = Date.parse(event.timestampUtc);
            if (timestampMs >= cutoffMs) samples.set(`${event.sessionId}:${event.timestampUtc}`, event.sample);
            else if (Number.isFinite(timestampMs)) crossedCutoff = true;
          } catch {
            // Ignore one malformed historical line; live logging remains authoritative.
          }
        }
      } finally {
        reader.close();
        input.destroy();
      }
      if (crossedCutoff) break;
    }
    return [...samples.values()]
      .sort((left, right) => Date.parse(left.timestampUtc) - Date.parse(right.timestampUtc))
      .slice(-Math.ceil(windowMs / CONFIG.sampleIntervalMs));
  }

  append(event: ProbeEvent): Promise<boolean> {
    if (this.queue.length >= 1_000) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const activePump = this.pumpPromise;
      this.queue.push({ event, resolve, settled: false });
      if (activePump) void activePump.then(() => this.pump());
      else void this.pump();
    });
  }

  async flush(): Promise<void> {
    await this.pump();
    if (this.queue.length) throw new Error("Log queue could not be flushed");
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    await this.flush();
  }

  async cleanup(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const nowMs = this.now().getTime();
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !isProbeLogFilename(entry.name)) continue;
      const path = join(this.directory, entry.name);
      const info = await stat(path);
      if (shouldDeleteLogFile(entry.name, info.mtimeMs, nowMs)) await unlink(path);
    }
  }

  private pump(): Promise<void> {
    if (this.pumpPromise) return this.pumpPromise;
    this.pumpPromise = this.drain().finally(() => {
      this.pumpPromise = null;
    });
    return this.pumpPromise;
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const record = this.queue[0]!;
      try {
        await this.write(record.event);
        this.queue.shift();
        if (!record.settled) record.resolve(true);
      } catch {
        if (!record.settled) {
          record.settled = true;
          record.resolve(false);
        }
        break;
      }
    }
  }

  private async write(event: ProbeEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line);
    await this.selectFile(event.timestampUtc.slice(0, 10), bytes);
    if (event.kind === "checkpoint" || event.kind === "warning") await this.replaceLatest(event);
    await appendFile(this.currentPath, line, "utf8");
    this.currentBytes += bytes;
  }

  private async selectFile(date: string, incomingBytes: number): Promise<void> {
    if (date === this.currentDate && this.currentPath && this.currentBytes + incomingBytes <= CONFIG.maxLogFileBytes) return;
    const entries = await readdir(this.directory);
    const indexes = entries
      .map((name) => LOG_PATTERN.exec(name))
      .filter((match): match is RegExpExecArray => match?.[1] === date)
      .map((match) => Number(match[2] ?? 0))
      .sort((left, right) => left - right);
    let index = indexes.at(-1) ?? 0;
    let path = this.pathFor(date, index);
    let size = await stat(path).then((info) => info.size).catch(() => 0);
    if (size + incomingBytes > CONFIG.maxLogFileBytes) {
      index++;
      path = this.pathFor(date, index);
      size = 0;
    }
    this.currentDate = date;
    this.currentIndex = index;
    this.currentPath = path;
    this.currentBytes = size;
  }

  private pathFor(date: string, index: number): string {
    return join(this.directory, `ram-probe-${date}${index ? `-${index}` : ""}.ndjson`);
  }

  private async replaceLatest(event: ProbeEvent): Promise<void> {
    const destination = join(this.directory, "latest.json");
    const temporary = join(this.directory, `.latest-${process.pid}-${crypto.randomUUID()}.tmp`);
    await Bun.write(temporary, JSON.stringify(event));
    try {
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

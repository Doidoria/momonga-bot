import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { DownloadJob } from './ytdlp';

const CHUNK = 64 * 1024;
const POLL_MS = 200;
const BUFFERING_LOG_MS = 1_000;

/**
 * 다운로드 중인 파일을 뒤따라 읽는 스트림.
 * 끝까지 읽었는데 아직 받는 중이면 기다렸다가 이어서 읽고, 다운로드가 끝난 뒤 끝까지 읽으면 종료.
 */
export class TailReadStream extends Readable {
  private handle: FileHandle | null = null;
  private position = 0;
  private reading = false;
  private bufferingSince: number | null = null;
  private bufferingLogged = false;

  constructor(
    private readonly job: DownloadJob,
    private readonly label: string,
  ) {
    super({ highWaterMark: CHUNK });
  }

  override _read(): void {
    if (this.reading) return;
    this.reading = true;
    void this.readNext();
  }

  private async readNext(): Promise<void> {
    try {
      this.handle ??= await open(this.job.filePath, 'r');
      while (!this.destroyed) {
        // 읽기 전에 상태를 기록해야, 읽은 직후 다운로드가 끝난 경우를 놓치지 않음
        const finishedBeforeRead = this.job.status === 'done';
        const buffer = Buffer.allocUnsafe(CHUNK);
        const { bytesRead } = await this.handle.read(buffer, 0, CHUNK, this.position);
        if (this.destroyed) return;

        if (bytesRead > 0) {
          this.position += bytesRead;
          if (this.bufferingSince !== null) {
            const waited = Date.now() - this.bufferingSince;
            if (waited >= BUFFERING_LOG_MS) {
              console.log(`[player] ${this.label} 버퍼링 끝 (${(waited / 1000).toFixed(1)}초)`);
            }
            this.bufferingSince = null;
            this.bufferingLogged = false;
          }
          this.reading = false;
          this.push(buffer.subarray(0, bytesRead));
          return;
        }

        if (finishedBeforeRead) {
          this.reading = false;
          this.push(null);
          return;
        }
        if (this.job.status === 'failed' || this.job.status === 'cancelled') {
          this.destroy(this.job.error ?? new Error('download stopped'));
          return;
        }

        // 재생이 다운로드를 따라잡음 → 대기 (짧은 대기는 로그 생략)
        if (this.bufferingSince === null) {
          this.bufferingSince = Date.now();
        } else if (Date.now() - this.bufferingSince >= BUFFERING_LOG_MS && !this.bufferingLogged) {
          this.bufferingLogged = true;
          console.log(`[player] ${this.label} 다운로드가 재생을 못 따라옴, 버퍼링 중`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
      }
    } catch (error) {
      this.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    const handle = this.handle;
    this.handle = null;
    if (!handle) {
      callback(error);
      return;
    }
    handle.close().then(
      () => callback(error),
      () => callback(error),
    );
  }
}

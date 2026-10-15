import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
interface Upload {
  id: string;
  path: string;
  mime: string;
  createdAt: number;
  attached: boolean;
}
export class UploadStore {
  private dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, 'uploads');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.cleanup();
  }
  save(bytes: Buffer, contentType: string): { id: string; url: string } {
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? 'image/jpeg'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
          ? 'image/webp'
          : null;
    if (!mime || mime !== contentType || bytes.length < 12 || bytes.length > MAX_IMAGE_BYTES)
      throw new Error('仅支持 10 MB 以内的 PNG、JPEG 和 WebP 图片');
    const id = randomUUID();
    const path = join(
      this.dir,
      id + { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[mime],
    );
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
    writeFileSync(
      join(this.dir, id + '.json'),
      JSON.stringify({ id, path, mime, createdAt: Date.now(), attached: false }),
      { mode: 0o600, flag: 'wx' },
    );
    return { id, url: `/api/v1/uploads/${id}` };
  }
  get(id: string): Upload | undefined {
    if (!/^[a-f0-9-]{36}$/.test(id)) return undefined;
    try {
      return JSON.parse(readFileSync(join(this.dir, id + '.json'), 'utf8'));
    } catch {
      return undefined;
    }
  }
  attach(ids: string[]): string[] {
    const entries = ids.map((id) => {
      const entry = this.get(id);
      if (!entry) throw new Error('图片不存在，请重新上传');
      return entry;
    });
    for (const entry of entries)
      writeFileSync(
        join(this.dir, entry.id + '.json'),
        JSON.stringify({ ...entry, attached: true }),
        { mode: 0o600 },
      );
    return entries.map((entry) => entry.path);
  }
  urlForPath(path: string): string | undefined {
    const entry = this.all().find((entry) => entry.path === path);
    return entry ? `/api/v1/uploads/${entry.id}` : undefined;
  }
  private all(): Upload[] {
    return readdirSync(this.dir)
      .filter((x) => x.endsWith('.json'))
      .flatMap((x) => this.get(x.slice(0, -5)) ?? []);
  }
  private cleanup() {
    for (const item of this.all())
      if (!item.attached && Date.now() - item.createdAt > 86400_000) {
        try {
          unlinkSync(item.path);
          unlinkSync(join(this.dir, item.id + '.json'));
        } catch {
          /* Retry next startup. */
        }
      }
  }
}

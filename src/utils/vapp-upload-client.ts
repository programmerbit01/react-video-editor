// Presigned direct-to-R2 upload for the editor's vApp media panel.
// Ported from vapp_higgs/lib/upload-client.js (same presign + multipart logic) —
// browser uploads the file bytes STRAIGHT to R2 (user bandwidth, no server hop),
// then registers a library record so it persists. Presign/register JSON calls go
// through the higgs proxy (`${vappHost}/api/vapp/presign?action=…`).

type ProgressCb = (pct: number) => void;

interface VappCtx {
  vappHost: string;
  token: string;
  baseUrl: string;
}

const MULTIPART_THRESHOLD = 20 * 1024 * 1024; // 20 MB
const MULTIPART_CONCURRENCY = 4;
const PART_STALL_MS = 60_000;
const PART_ACK_MS = 90_000;

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-msvideo': 'avi',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac',
};

function safeUploadFilename(file: File, contentType = ''): string {
  const raw = String(file?.name || '').trim();
  const dot = raw.lastIndexOf('.');
  let stem = dot > 0 ? raw.slice(0, dot) : raw;
  let ext = dot > 0 ? raw.slice(dot + 1) : '';
  stem = stem.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 48) || 'upload';
  ext = ext.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase().slice(0, 8);
  if (!ext) {
    const ct = String(contentType || file?.type || '').split(';')[0].trim().toLowerCase();
    ext = MIME_EXT[ct] || (ct.split('/')[1] || '').replace(/[^a-z0-9]+/g, '').slice(0, 8);
  }
  return ext ? `${stem}.${ext}` : stem;
}

function mediaTypeOf(contentType: string): 'image' | 'video' | 'audio' {
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  return 'image';
}

// Direct vApp-server endpoints (no higgs proxy).
const PRESIGN_PATH: Record<string, string> = {
  'upload': '/vapp/media/presign-upload',
  'multipart-start': '/vapp/media/presign-multipart-start',
  'multipart-complete': '/vapp/media/presign-multipart-complete',
  'register': '/vapp/media/register-upload',
};

function presignUrl(ctx: VappCtx, action: string): string {
  return `${ctx.baseUrl}${PRESIGN_PATH[action] || ''}`;
}

async function presignPost(ctx: VappCtx, action: string, body: any): Promise<any> {
  const res = await fetch(presignUrl(ctx, action), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ctx.token ? { Authorization: `Bearer ${ctx.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`presign ${action} ${res.status}${txt ? ` - ${txt.slice(0, 160)}` : ''}`);
  }
  return res.json();
}

// PUT a blob to a presigned R2 url with stall/ack timeouts + progress.
function xhrPut(
  url: string,
  blob: Blob,
  opts: { contentType: string; onProgress?: (loaded: number, total: number) => void }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let sentFully = false;
    let lastProgressAt = Date.now();
    let ackWaitAt = 0;

    const stallTimer = setInterval(() => {
      const now = Date.now();
      if (!sentFully && now - lastProgressAt > PART_STALL_MS) {
        clearInterval(stallTimer);
        xhr.abort();
        reject(new Error('stalled'));
      } else if (sentFully && ackWaitAt && now - ackWaitAt > PART_ACK_MS) {
        clearInterval(stallTimer);
        xhr.abort();
        reject(new Error('ack timeout'));
      }
    }, 1000);

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      lastProgressAt = Date.now();
      opts.onProgress?.(e.loaded, blob.size);
      if (!sentFully && e.loaded >= blob.size) {
        sentFully = true;
        ackWaitAt = Date.now();
      }
    });
    xhr.addEventListener('load', () => {
      clearInterval(stallTimer);
      if (xhr.status >= 200 && xhr.status < 300) {
        opts.onProgress?.(blob.size, blob.size);
        resolve(xhr.status);
      } else {
        reject(new Error(`status ${xhr.status}`));
      }
    });
    xhr.addEventListener('error', () => { clearInterval(stallTimer); reject(new Error('network error')); });
    xhr.addEventListener('timeout', () => { clearInterval(stallTimer); reject(new Error('timeout')); });
    xhr.addEventListener('abort', () => clearInterval(stallTimer));

    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', opts.contentType || blob.type || 'application/octet-stream');
    xhr.send(blob);
  });
}

async function uploadMultipart(ctx: VappCtx, file: File, contentType: string, onProgress?: ProgressCb): Promise<string> {
  const session = await presignPost(ctx, 'multipart-start', {
    filename: safeUploadFilename(file, contentType),
    content_type: contentType,
    file_size: file.size,
    persist: true,
  });
  const parts: any[] = Array.isArray(session?.parts) ? session.parts : [];
  if (!session?.uploadId || !session?.key || !parts.length) throw new Error('multipart session invalid');

  const loadedByPart = new Map<number, number>();
  const emit = () => {
    if (!onProgress) return;
    const loaded = Array.from(loadedByPart.values()).reduce((s, v) => s + v, 0);
    onProgress(file.size ? Math.min(99, Math.round((loaded / file.size) * 100)) : 0);
  };

  const uploadPart = async (part: any) => {
    const start = Number(part?.start || 0);
    const end = Number(part?.end || 0);
    const partNumber = Number(part?.partNumber || 0);
    const partBlob = file.slice(start, end);
    let lastErr: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 1500));
        await xhrPut(part.url, partBlob, {
          contentType,
          onProgress: (loaded) => { loadedByPart.set(partNumber, loaded); emit(); },
        });
        loadedByPart.set(partNumber, partBlob.size);
        emit();
        return;
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error(`multipart part ${partNumber} failed`);
  };

  let cursor = 0;
  const workers = Array.from({ length: Math.min(MULTIPART_CONCURRENCY, parts.length) }, async () => {
    while (cursor < parts.length) {
      const part = parts[cursor];
      cursor += 1;
      await uploadPart(part);
    }
  });
  await Promise.all(workers);

  const complete = await presignPost(ctx, 'multipart-complete', {
    key: session.key,
    uploadId: session.uploadId,
    totalParts: session.totalParts || parts.length,
  });
  const publicUrl = complete?.public_url || session?.public_url;
  if (!publicUrl) throw new Error('multipart complete missing public_url');
  onProgress?.(100);
  return publicUrl;
}

async function uploadSingle(ctx: VappCtx, file: File, contentType: string, onProgress?: ProgressCb): Promise<string> {
  const { upload_url, public_url } = await presignPost(ctx, 'upload', {
    filename: safeUploadFilename(file, contentType),
    content_type: contentType,
    persist: true,
  });
  if (!upload_url) throw new Error('no upload_url');
  let lastErr: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 2000));
      await xhrPut(upload_url, file, {
        contentType,
        onProgress: (loaded, total) => onProgress?.(total ? Math.min(99, Math.round((loaded / total) * 100)) : 0),
      });
      onProgress?.(100);
      return public_url;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('direct upload failed');
}

export interface VappUploadResult {
  url: string;   // direct R2 public url
  type: 'image' | 'video' | 'audio';
  name: string;
}

// Upload a file directly to R2 (presigned) then register it as a library asset.
export async function uploadVappMediaFile(
  file: File,
  ctx: VappCtx,
  onProgress?: ProgressCb
): Promise<VappUploadResult> {
  const contentType = file.type || 'application/octet-stream';
  const publicUrl = file.size > MULTIPART_THRESHOLD
    ? await uploadMultipart(ctx, file, contentType, onProgress)
    : await uploadSingle(ctx, file, contentType, onProgress);

  const mediaType = mediaTypeOf(contentType);
  // Register so it persists + lists in the media library (reuses server helper).
  const reg = await presignPost(ctx, 'register', {
    url: publicUrl,
    content_type: contentType,
    media_type: mediaType,
    filename: file.name || '',
    size: file.size,
  }).catch(() => null);

  return {
    url: publicUrl,
    type: mediaType,
    name: (reg && reg.name) || file.name || publicUrl.split('/').pop()?.split('?')[0] || 'media',
  };
}

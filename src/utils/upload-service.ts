import axios from "axios";

function withEditorBase(path: string): string {
  if (typeof window === "undefined") return path;
  if (window.location.pathname.startsWith("/editor")) return `/editor${path}`;
  return path;
}

function withPublicAssetBase(path: string): string {
  if (typeof window === "undefined") return path;
  if (path.startsWith("/uploads/") && window.location.pathname.startsWith("/editor")) {
    return `/editor${path}`;
  }
  return path;
}

function getVappParams(): { vappHost: string; token: string; baseUrl: string } | null {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search);
  const token = p.get("token") || "";
  if (!token) return null;
  const baseUrl = p.get("baseUrl") || "https://api.muapi.ai";
  const vappHost = p.get("vappHost") || `${window.location.protocol}//${window.location.hostname}`;
  return { vappHost, token, baseUrl };
}

export type UploadProgressCallback = (
  uploadId: string,
  progress: number
) => void;

export type UploadStatusCallback = (
  uploadId: string,
  status: "uploaded" | "failed",
  error?: string
) => void;

export interface UploadCallbacks {
  onProgress: UploadProgressCallback;
  onStatus: UploadStatusCallback;
}

export async function processFileUpload(
  uploadId: string,
  file: File,
  callbacks: UploadCallbacks
): Promise<any> {
  const vapp = getVappParams();
  if (vapp) {
    return processVappFileUpload(uploadId, file, callbacks, vapp);
  }

  try {
    callbacks.onProgress(uploadId, 20);

    const formData = new FormData();
    formData.append("file", file);

    const res = await axios.post(withEditorBase("/api/uploads/local"), formData, {
      headers: { "Content-Type": "multipart/form-data" },
      onUploadProgress: (e) => {
        const pct = Math.round((e.loaded * 80) / (e.total || 1));
        callbacks.onProgress(uploadId, 20 + pct);
      },
    });

    const { url, fileName } = res.data;
    const resolvedUrl = withPublicAssetBase(url);
    callbacks.onProgress(uploadId, 100);

    const uploadData = {
      fileName: fileName || file.name,
      filePath: resolvedUrl,
      fileSize: file.size,
      contentType: file.type,
      metadata: { uploadedUrl: resolvedUrl },
      folder: null,
      type: file.type.split("/")[0],
      method: "direct",
      origin: "user",
      status: "uploaded",
      isPreview: false
    };

    callbacks.onStatus(uploadId, "uploaded");
    return uploadData;
  } catch (error) {
    callbacks.onStatus(uploadId, "failed", (error as Error).message);
    throw error;
  }
}

async function processVappFileUpload(
  uploadId: string,
  file: File,
  callbacks: UploadCallbacks,
  vapp: { vappHost: string; token: string; baseUrl: string }
): Promise<any> {
  try {
    callbacks.onProgress(uploadId, 10);

    const formData = new FormData();
    formData.append("file", file);

    const uploadUrl = `${vapp.vappHost}/api/vapp/upload?token=${encodeURIComponent(vapp.token)}&baseUrl=${encodeURIComponent(vapp.baseUrl)}`;

    const res = await axios.post(uploadUrl, formData, {
      headers: { "Content-Type": "multipart/form-data" },
      onUploadProgress: (e) => {
        const pct = Math.round((e.loaded * 80) / (e.total || 1));
        callbacks.onProgress(uploadId, 10 + pct);
      },
    });

    const { url: rawUrl, type: mediaType, name } = res.data;
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(rawUrl)}`;
    const mimeType = mediaType === "video" ? "video/mp4"
      : mediaType === "audio" ? "audio/mp3"
      : "image/jpeg";

    callbacks.onProgress(uploadId, 100);

    const uploadData = {
      id: `vapp-${rawUrl.split("/").pop()?.split("?")[0] || Math.random().toString(36).slice(2)}`,
      url: proxyUrl,
      filePath: proxyUrl,
      fileName: name || file.name,
      fileSize: file.size,
      type: mimeType,
      contentType: mimeType,
      metadata: { uploadedUrl: proxyUrl, directUrl: rawUrl, vappItem: true },
      status: "uploaded",
      createdAt: new Date().toISOString(),
    };

    callbacks.onStatus(uploadId, "uploaded");
    return uploadData;
  } catch (error) {
    callbacks.onStatus(uploadId, "failed", (error as Error).message);
    throw error;
  }
}

export async function processUrlUpload(
  uploadId: string,
  url: string,
  callbacks: UploadCallbacks
): Promise<any[]> {
  try {
    // Start with 10% progress
    callbacks.onProgress(uploadId, 10);

    // Upload URL
    const { data: { uploads = [] } = {} } = await axios.post(
      withEditorBase("/api/uploads/url"),
      {
        userId: "PJ1nkaufw0hZPyhN7bWCP",
        urls: [url]
      },
      {
        headers: { "Content-Type": "application/json" }
      }
    );

    // Update to 50% progress
    callbacks.onProgress(uploadId, 50);

    // Construct upload data from uploads array
    const uploadDataArray = uploads.map((uploadInfo: any) => ({
      fileName: uploadInfo.fileName,
      filePath: uploadInfo.filePath,
      fileSize: 0,
      contentType: uploadInfo.contentType,
      metadata: { originalUrl: uploadInfo.originalUrl },
      folder: uploadInfo.folder || null,
      type: uploadInfo.contentType.split("/")[0],
      method: "url",
      origin: "user",
      status: "uploaded",
      isPreview: false
    }));

    // Complete
    callbacks.onProgress(uploadId, 100);
    callbacks.onStatus(uploadId, "uploaded");
    return uploadDataArray;
  } catch (error) {
    callbacks.onStatus(uploadId, "failed", (error as Error).message);
    throw error;
  }
}

export async function processUpload(
  uploadId: string,
  upload: { file?: File; url?: string },
  callbacks: UploadCallbacks
): Promise<any> {
  if (upload.file) {
    return await processFileUpload(uploadId, upload.file, callbacks);
  }
  if (upload.url) {
    return await processUrlUpload(uploadId, upload.url, callbacks);
  }
  callbacks.onStatus(uploadId, "failed", "No file or URL provided");
  throw new Error("No file or URL provided");
}

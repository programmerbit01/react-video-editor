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

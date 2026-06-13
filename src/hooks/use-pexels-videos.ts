import { useState, useCallback } from "react";
import { IVideo } from "@designcombo/types";

export interface PexelsVideoFilters {
  aspectRatio?: "16:9" | "9:16" | "1:1";
  size?: "small" | "medium" | "large";
}

interface PexelsVideo extends Partial<IVideo> {
  metadata?: {
    pexels_id: number;
    user: {
      id: number;
      name: string;
      url: string;
    };
    video_files: Array<{
      id: number;
      quality: string;
      file_type: string;
      width: number;
      height: number;
      fps: number;
      link: string;
    }>;
    video_pictures: Array<{
      id: number;
      picture: string;
      nr: number;
    }>;
  };
}

interface PexelsVideoResponse {
  videos: PexelsVideo[];
  total_results: number;
  page: number;
  per_page: number;
  next_page?: string;
  prev_page?: string;
}

interface UsePexelsVideosReturn {
  videos: PexelsVideo[];
  loading: boolean;
  error: string | null;
  totalResults: number;
  currentPage: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  searchVideos: (query: string, page?: number, filters?: PexelsVideoFilters) => Promise<void>;
  loadPopularVideos: (page?: number, filters?: PexelsVideoFilters) => Promise<void>;
  searchVideosAppend: (query: string, page?: number, filters?: PexelsVideoFilters) => Promise<void>;
  loadPopularVideosAppend: (page?: number, filters?: PexelsVideoFilters) => Promise<void>;
  clearVideos: () => void;
  refreshPopularVideos: (page?: number, filters?: PexelsVideoFilters) => Promise<void>;
}

interface PopularVideosCacheEntry {
  data: PexelsVideoResponse | null;
  timestamp: number;
}

const popularVideosCache = new Map<string, PopularVideosCacheEntry>();

// Cache duration: 5 minutes
const CACHE_DURATION = 5 * 60 * 1000;

const withEditorBase = (path: string) => {
  if (typeof window === "undefined") return path;
  if (window.location.pathname.startsWith("/editor")) return `/editor${path}`;
  return path;
};

const clearPopularVideosCache = () => {
  popularVideosCache.clear();
};

const buildVideoUrl = (
  query: string,
  page: number,
  perPage: number,
  filters?: PexelsVideoFilters
) => {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
  });
  const trimmedQuery = query.trim();
  if (trimmedQuery) params.set("query", trimmedQuery);
  if (filters?.size) params.set("size", filters.size);
  if (filters?.aspectRatio === "16:9") params.set("orientation", "landscape");
  if (filters?.aspectRatio === "9:16") params.set("orientation", "portrait");
  if (filters?.aspectRatio === "1:1") params.set("orientation", "square");
  return withEditorBase(`/api/pexels-videos?${params.toString()}`);
};

const getPopularCacheKey = (page: number, filters?: PexelsVideoFilters) =>
  JSON.stringify({ page, filters: filters || {} });

/**
 * Hook for fetching and managing Pexels videos with caching support.
 *
 * Features:
 * - Caches popular videos for 5 minutes to avoid unnecessary API calls
 * - Supports search functionality with real-time results
 * - Provides pagination for browsing large result sets
 * - Includes error handling and loading states
 *
 * Cache Behavior:
 * - Popular videos are cached for 5 minutes
 * - Cache is automatically cleared when calling clearVideos()
 * - Manual cache refresh available via refreshPopularVideos()
 * - Cache is page-specific (different pages have separate cache entries)
 */
export function usePexelsVideos(): UsePexelsVideosReturn {
  const [videos, setVideos] = useState<PexelsVideo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalResults, setTotalResults] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [hasPrevPage, setHasPrevPage] = useState(false);

  const fetchVideos = useCallback(async (url: string) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: PexelsVideoResponse = await response.json();

      setVideos(data.videos);
      setTotalResults(data.total_results);
      setCurrentPage(data.page);
      setHasNextPage(!!data.next_page);
      setHasPrevPage(!!data.prev_page);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch videos");
      setVideos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const searchVideos = useCallback(
    async (query: string, page = 1, filters?: PexelsVideoFilters) => {
      const url = buildVideoUrl(query, page, 15, filters);
      await fetchVideos(url);
    },
    [fetchVideos]
  );

  const searchVideosAppend = useCallback(async (query: string, page = 1, filters?: PexelsVideoFilters) => {
    setLoading(true);
    setError(null);

    try {
      const url = buildVideoUrl(query, page, 15, filters);
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: PexelsVideoResponse = await response.json();

      setVideos((prevVideos) => [...prevVideos, ...data.videos]);
      setTotalResults(data.total_results);
      setCurrentPage(data.page);
      setHasNextPage(!!data.next_page);
      setHasPrevPage(!!data.prev_page);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch videos");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPopularVideos = useCallback(async (page = 1, filters?: PexelsVideoFilters) => {
    const now = Date.now();
    const cacheKey = getPopularCacheKey(page, filters);
    const cached = popularVideosCache.get(cacheKey);
    const isCacheValid = cached && now - cached.timestamp < CACHE_DURATION;

    if (isCacheValid && cached?.data) {
      const data = cached.data;
      setVideos(data.videos);
      setTotalResults(data.total_results);
      setCurrentPage(data.page);
      setHasNextPage(!!data.next_page);
      setHasPrevPage(!!data.prev_page);
      setError(null);
      return;
    }

    const url = buildVideoUrl("", page, 15, filters);
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: PexelsVideoResponse = await response.json();

      popularVideosCache.set(cacheKey, {
        data,
        timestamp: now,
      });

      setVideos(data.videos);
      setTotalResults(data.total_results);
      setCurrentPage(data.page);
      setHasNextPage(!!data.next_page);
      setHasPrevPage(!!data.prev_page);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch videos");
      setVideos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPopularVideosAppend = useCallback(async (page = 1, filters?: PexelsVideoFilters) => {
    setLoading(true);
    setError(null);

    try {
      const url = buildVideoUrl("", page, 15, filters);
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: PexelsVideoResponse = await response.json();

      setVideos((prevVideos) => [...prevVideos, ...data.videos]);
      setTotalResults(data.total_results);
      setCurrentPage(data.page);
      setHasNextPage(!!data.next_page);
      setHasPrevPage(!!data.prev_page);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch videos");
    } finally {
      setLoading(false);
    }
  }, []);

  const clearVideos = useCallback(() => {
    setVideos([]);
    setError(null);
    setTotalResults(0);
    setCurrentPage(1);
    setHasNextPage(false);
    setHasPrevPage(false);
    // Also clear the cache when clearing videos
    clearPopularVideosCache();
  }, []);

  const refreshPopularVideos = useCallback(
    async (page = 1, filters?: PexelsVideoFilters) => {
      clearPopularVideosCache();
      await loadPopularVideos(page, filters);
    },
    [loadPopularVideos]
  );

  return {
    videos,
    loading,
    error,
    totalResults,
    currentPage,
    hasNextPage,
    hasPrevPage,
    searchVideos,
    loadPopularVideos,
    searchVideosAppend,
    loadPopularVideosAppend,
    clearVideos,
    refreshPopularVideos
  };
}

/**
 * 유튜브 썸네일 주소 결정.
 * yt-dlp가 주는 maxresdefault.webp 등은 실제로 없는(404) 경우가 많아 디스코드에서 "이미지를 불러올 수 없음"이 됨.
 * 고화질(1280x720)이 실제로 있으면 그걸, 없으면 항상 존재하는 hqdefault(480x360)를 사용
 */
const cache = new Map<string, string>();
const CACHE_LIMIT = 500;
const CHECK_TIMEOUT_MS = 3_000;

export function fallbackThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export async function resolveThumbnail(videoId: string): Promise<string> {
  const cached = cache.get(videoId);
  if (cached) return cached;

  const maxres = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  let url = fallbackThumbnail(videoId);
  try {
    const res = await fetch(maxres, { method: 'HEAD', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (res.ok) url = maxres;
  } catch {
    // 네트워크 오류·타임아웃이면 기본 썸네일
  }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(videoId, url);
  return url;
}

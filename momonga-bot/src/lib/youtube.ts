const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{2,64}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);

export type ParsedInput =
  | { kind: 'video'; videoId: string; url: string }
  | { kind: 'playlist'; listId: string; url: string }
  | { kind: 'search'; query: string }
  | { kind: 'invalid'; reason: string };

export function isVideoId(value: string): boolean {
  return VIDEO_ID.test(value);
}

export function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * 사용자 입력 → 영상 링크 / 재생목록 링크 / 검색어.
 * 링크는 ID만 뽑아 표준 주소로 바꿈 (yt-dlp에 사용자 입력 URL을 그대로 넘기지 않음).
 * 영상+재생목록이 같이 있는 링크(watch?v=..&list=..)는 그 영상 1곡으로 처리
 */
export function parseInput(input: string): ParsedInput {
  const text = input.trim().replace(/\s+/g, ' ');
  if (!text) return { kind: 'invalid', reason: '링크나 검색어를 입력해 주세요.' };

  const looksLikeUrl = /^https?:\/\//i.test(text) || /^(www\.|m\.|music\.)?youtu(\.be|be\.com)\//i.test(text);
  if (!looksLikeUrl) {
    if (text.length > 100) return { kind: 'invalid', reason: '검색어는 100자 이내로 입력해 주세요.' };
    return { kind: 'search', query: text };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { kind: 'invalid', reason: '올바른 링크가 아니에요.' };
  }

  const host = url.hostname.toLowerCase();
  let videoId: string | null = null;

  if (host === 'youtu.be') {
    videoId = url.pathname.split('/')[1] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    const [, first, second] = url.pathname.split('/');
    if (first === 'watch') {
      videoId = url.searchParams.get('v');
    } else if (first === 'shorts' || first === 'live' || first === 'embed') {
      videoId = second ?? null;
    } else if (first === 'playlist') {
      const listId = url.searchParams.get('list');
      if (listId && LIST_ID.test(listId)) {
        return { kind: 'playlist', listId, url: `https://www.youtube.com/playlist?list=${listId}` };
      }
    }
  } else {
    return { kind: 'invalid', reason: '유튜브 링크만 재생할 수 있어요.' };
  }

  if (!videoId || !VIDEO_ID.test(videoId)) return { kind: 'invalid', reason: '올바른 유튜브 링크가 아니에요.' };
  return { kind: 'video', videoId, url: videoUrl(videoId) };
}
